import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import {
  MEDIA_MESSAGES, MediaVerificationError, POLICY_SHA256, attested, createMediaVerifier, ffmpegVoiceVerifier, pythonPhotoVerifier,
} from '../media-verification.mjs';
import { client, png, startOwnerServer } from './auth-helper.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
const APP = fileURLToPath(new URL('..', import.meta.url));
// Signature-only synthetic bytes: these never count as decoder evidence.
const SIGNATURE_PNG = png(40, 30, 7);
const SIGNATURE_PNG_2 = png(40, 30, 9);
const SIGNATURE_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const tempDir = async (prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A real, decodable 8-bit RGB PNG built here, with correct chunk checksums.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function realPng(width, height, seed = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0, ...Array.from({ length: width * 3 }, (_, i) => (i * 7 + y * 13 + seed) & 255)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// A scripted verifier for the HTTP flows: the real slot and attestation logic,
// with decoders whose outcome each test chooses. Never production validation.
function scripted({ photo = [], voice = [] } = {}) {
  const calls = [];
  const step = (kind, steps) => async (call) => {
    calls.push({ kind, sha256: sha256(call.bytes), signal: call.signal });
    const next = steps.shift();
    if (next) return next(call);
    return kind === 'photo' ? { width: 40, height: 30 } : { durationMs: 1000 };
  };
  const verifier = createMediaVerifier({ photo: step('photo', photo), voice: step('voice', voice) });
  verifier.calls = calls;
  return verifier;
}
const refuse = (code, kind = 'photo') => async () => {
  throw new MediaVerificationError(code, kind);
};
const hold = (gate, started, value = { width: 40, height: 30 }) => async ({ signal }) => {
  started?.resolve();
  await Promise.race([gate.promise, new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new MediaVerificationError('aborted', 'photo'))))]);
  return value;
};

async function workspace({ verifier = scripted(), dataDir } = {}) {
  dataDir ??= await tempDir('rehere-owner-media-');
  const app = await startOwnerServer({ dataDir, mediaVerifier: verifier });
  return { app, dataDir, verifier, owner: client(app.base, app.cookie) };
}

const grant = (provider) => ({
  provider, origin: { kind: 'own', reference: 'synthetic' }, permissions: { place: true, model: false, share: false },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});
const part = (bytes, kind = 'photo') => ({
  partId: randomUUID(), kind, size: bytes.length, sha256: sha256(bytes),
  hints: { name: kind === 'photo' ? 'photo.png' : 'take', type: kind === 'photo' ? 'image/png' : 'audio/webm', lastModified: null },
});
const createBody = (parts) => ({
  requestId: randomUUID(), text: 'Line one.\nLine two.\n', parts,
  metadata: {
    photos: parts.filter((item) => item.kind === 'photo').map((_, index) => grant(`Photo ${index + 1}`)), text: grant('Text'),
    ...(parts.some((item) => item.kind === 'voice') && { voice: grant('Voice') }),
  },
});
const upload = (owner, id, partId, bytes) => owner.request(`/api/intakes/${id}/parts/${partId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
const intakeFile = (dataDir, id) => path.join(dataDir, 'intakes', id, 'intake.json');
const stored = async (dataDir, id) => JSON.parse(await readFile(intakeFile(dataDir, id), 'utf8'));
const draftIds = async (dataDir) => (await readdir(path.join(dataDir, 'drafts')).catch(() => [])).sort();
const incoming = async (dataDir) => readdir(path.join(dataDir, 'incoming')).catch(() => []);
async function openIntake(owner, parts) {
  const body = createBody(parts);
  const response = await owner.post('/api/intakes', body);
  assert.equal(response.status, 201);
  return { id: (await response.json()).id, body };
}
const commit = (owner, id, revision = 1, requestId = randomUUID()) => owner.post(`/api/intakes/${id}/commit`, { requestId, baseRevision: revision });
// Removes the private verification from stored parts, as for intakes from before content validation.
async function makeLegacy(dataDir, id, change = (part) => { delete part.verification; }) {
  const record = await stored(dataDir, id);
  for (const item of record.parts) change(item);
  await writeFile(intakeFile(dataDir, id), JSON.stringify(record, null, 2));
}
function directForm(photos, voice = null) {
  const form = new FormData();
  for (const bytes of photos) form.append('photos', new Blob([bytes]), 'photo');
  if (voice) form.append('voice', new Blob([voice]), 'voice');
  form.append('text', 'Words.');
  form.append('metadata', JSON.stringify({ photos: photos.map((_, index) => grant(`Photo ${index + 1}`)), text: grant('Text'), ...(voice && { voice: grant('Voice') }) }));
  return form;
}

// Holds the first real rename whose target matches until released.
function holdRename(matches) {
  const original = fs.promises.rename;
  const reached = deferred();
  const release = deferred();
  fs.promises.rename = async (from, to) => {
    if (matches(String(from), String(to))) {
      reached.resolve();
      await release.promise;
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  return {
    reached: reached.promise,
    release: release.resolve,
    restore() {
      release.resolve();
      fs.promises.rename = original;
      syncBuiltinESMExports();
    },
  };
}

describe('production default', () => {
  it('uses the real verifier when none is injected: signature-only files are never accepted', async () => {
    const dataDir = await tempDir('rehere-owner-media-default-');
    // No mediaVerifier: createAppServer builds the production default.
    const app = await startOwnerServer({ dataDir, mediaVerifier: undefined });
    const owner = client(app.base, app.cookie);
    try {
      const direct = await owner.request('/api/drafts', { method: 'POST', body: directForm([SIGNATURE_PNG]) });
      assert.ok([400, 503].includes(direct.status), `refused or unavailable, got ${direct.status}`);
      assert.ok(Object.values(MEDIA_MESSAGES).flatMap((value) => (typeof value === 'string' ? [value] : Object.values(value))).includes((await direct.json()).error));
      assert.deepEqual(await draftIds(dataDir), []);
      const photo = part(SIGNATURE_PNG);
      const { id } = await openIntake(owner, [photo]);
      const received = await upload(owner, id, photo.partId, SIGNATURE_PNG);
      assert.ok([400, 503].includes(received.status));
      assert.notEqual((await stored(dataDir, id)).parts[0].status, 'received');
    } finally {
      await app.close();
    }
  });
});

describe('photo verifier process', () => {
  function fakeChild({ kill = () => true } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end(bytes) { child.input = bytes; } });
    child.kills = 0;
    child.kill = () => {
      child.kills += 1;
      return kill();
    };
    return child;
  }
  const settledWithin = (promise, ms = 500) => Promise.race([promise.then((value) => value, (error) => error), new Promise((resolve) => setTimeout(() => resolve('pending'), ms))]);

  it('spawns the fixed script with one format argument and a non-secret environment, and maps exits to fixed outcomes', async () => {
    const saved = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = 'synthetic-secret';
    try {
      const outcomes = [[0, '{"width":40,"height":30}', { width: 40, height: 30 }], [2, '', 'content'], [4, '', 'pixels'], [3, '', 'unavailable'],
        [1, '', 'unavailable'], [0, 'not json', 'unavailable'], [0, '{"width":0,"height":3}', 'unavailable'], [0, '{"width":40,"height":30,"x":1}', 'unavailable']];
      for (const [exit, out, expected] of outcomes) {
        let seen;
        const child = fakeChild();
        const verify = pythonPhotoVerifier({ python: '/fixed/python', spawnProcess: (command, args, options) => {
          seen = { command, args, options };
          return child;
        } });
        const pending = verify({ bytes: SIGNATURE_PNG, type: 'image/png', signal: new AbortController().signal });
        child.stderr.emit('data', Buffer.from('private Pillow detail'));
        if (out) child.stdout.emit('data', Buffer.from(out));
        child.emit('close', exit);
        const outcome = await pending.catch((error) => error);
        if (typeof expected === 'string') {
          assert.ok(outcome instanceof MediaVerificationError, `exit ${exit}`);
          assert.equal(outcome.code, expected);
          assert.ok(!outcome.message.includes('private'));
        } else {
          assert.deepEqual(outcome, expected);
        }
        assert.equal(seen.command, '/fixed/python');
        assert.deepEqual(seen.args.slice(1), ['--expect', 'png']);
        assert.equal(path.basename(seen.args[0]), 'verify_owner_photo.py');
        assert.equal(seen.options.shell, false);
        assert.equal(seen.options.env.MODEL_API_KEY, undefined);
        assert.deepEqual(child.input, SIGNATURE_PNG);
      }
    } finally {
      if (saved === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = saved;
    }
  });

  it('settles once on overflow, the time limit or abort even when kill throws or fails and no close follows', async () => {
    const cases = [
      ['stdout overflow, kill throws', { kill: () => { throw new Error('kill failed'); } }, (child) => child.stdout.emit('data', Buffer.alloc(5000)), 'unavailable'],
      ['time limit, kill returns false', { kill: () => false }, () => {}, 'timeout'],
      ['abort, kill returns false', { kill: () => false }, (child, controller) => controller.abort(), 'aborted'],
    ];
    for (const [label, options, act, expected] of cases) {
      const child = fakeChild(options);
      const controller = new AbortController();
      const pending = pythonPhotoVerifier({ python: 'unused', timeoutMs: 50, spawnProcess: () => child })({ bytes: SIGNATURE_PNG, type: 'image/png', signal: controller.signal });
      act(child, controller);
      const outcome = await settledWithin(pending);
      assert.ok(outcome instanceof MediaVerificationError, label);
      assert.equal(outcome.code, expected, label);
      assert.equal(child.kills, 1, label);
      child.stdout.emit('data', Buffer.from('{"width":1,"height":1}'));
      child.emit('close', 0);
      assert.equal(await settledWithin(pending), outcome, `${label}: a late success cannot change the outcome`);
    }
  });
});

describe('real decoders', () => {
  const python = [process.env.PHOTO_PYTHON, path.join(APP, '../experiments/spatial-state/.venv/bin/python')].find(Boolean);
  const photoReady = access(python ?? '/nonexistent').then(() => access(path.join(APP, 'spatial/verify_owner_photo.py'))).then(() => true, () => false);
  const ffmpeg = process.env.REHERE_FFMPEG || 'ffmpeg';
  const ffmpegReady = run(ffmpeg, ['-hide_banner', '-version']).then(() => true, () => false);

  it('verifies a generated PNG and refuses truncated and signature-only photos (skips without the prepared runtime)', async (t) => {
    if (!(await photoReady)) return t.skip('prepared PHOTO_PYTHON or verify_owner_photo.py unavailable');
    const verify = pythonPhotoVerifier({ python });
    const signal = new AbortController().signal;
    const good = realPng(24, 16);
    assert.deepEqual(await verify({ bytes: good, type: 'image/png', signal }), { width: 24, height: 16 });
    for (const bad of [good.subarray(0, good.length - 20), SIGNATURE_PNG]) {
      const error = await verify({ bytes: bad, type: 'image/png', signal }).catch((caught) => caught);
      assert.equal(error.code, 'content');
    }
    const mismatch = await verify({ bytes: good, type: 'image/jpeg', signal }).catch((caught) => caught);
    assert.equal(mismatch.code, 'content');
  });

  it('accepts real silent audio and refuses corrupt, signature-only and over-five-minute recordings (skips without ffmpeg)', async (t) => {
    if (!(await ffmpegReady)) return t.skip('ffmpeg unavailable');
    const dir = await tempDir('rehere-owner-media-audio-');
    const make = async (name, seconds) => {
      const file = path.join(dir, name);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(seconds), '-c:a', 'libopus', '-b:a', '16k', file]);
      return readFile(file);
    };
    const verify = ffmpegVoiceVerifier();
    const signal = new AbortController().signal;
    const silent = await make('silent.webm', 1);
    const { durationMs } = await verify({ bytes: silent, type: 'audio/webm', signal });
    assert.ok(durationMs >= 900 && durationMs <= 1200, `silence decodes to samples: ${durationMs}`);
    const corrupt = Buffer.from(silent);
    for (let index = Math.floor(corrupt.length / 2); index < corrupt.length - 8; index += 7) corrupt[index] ^= 0x5a;
    for (const [label, bytes] of [['corrupt', corrupt], ['truncated', silent.subarray(0, Math.floor(silent.length / 3))], ['signature only', SIGNATURE_WEBM]]) {
      const error = await verify({ bytes, type: 'audio/webm', signal }).catch((caught) => caught);
      assert.equal(error.code, 'content', label);
    }
    const long = await make('long.webm', 301);
    assert.equal((await verify({ bytes: long, type: 'audio/webm', signal }).catch((caught) => caught)).code, 'duration');
  });
});

describe('verification markers', () => {
  const photoPart = { partId: randomUUID(), kind: 'photo', size: 1000, sha256: 'a'.repeat(64), status: 'received', detectedType: 'image/png' };
  const voicePart = { partId: randomUUID(), kind: 'voice', size: 1000, sha256: 'b'.repeat(64), status: 'received', detectedType: 'audio/ogg' };
  const marker = (part, result) => ({ policySha256: POLICY_SHA256, kind: part.kind, type: part.detectedType, size: part.size, sha256: part.sha256, ...result });

  it('accept only records within the current policy and the exact part identity', () => {
    assert.ok(attested({ ...photoPart, verification: marker(photoPart, { width: 8000, height: 4000 }) }));
    assert.ok(attested({ ...voicePart, verification: marker(voicePart, { durationMs: 0 }) }), 'a floored sub-millisecond decode');
    assert.ok(attested({ ...voicePart, verification: marker(voicePart, { durationMs: 300_000 }) }));
    const bogus = [
      ['over 32 MP', photoPart, { width: 8001, height: 4000 }],
      ['zero width', photoPart, { width: 0, height: 4 }],
      ['fractional height', photoPart, { width: 4, height: 1.5 }],
      ['photo without height', photoPart, { width: 4 }],
      ['photo with a duration', photoPart, { width: 4, height: 4, durationMs: 1 }],
      ['over five minutes', voicePart, { durationMs: 300_001 }],
      ['negative duration', voicePart, { durationMs: -1 }],
      ['voice with dimensions', voicePart, { width: 4, height: 4 }],
    ];
    for (const [label, part, result] of bogus) assert.equal(attested({ ...part, verification: marker(part, result) }), false, label);
    const valid = marker(photoPart, { width: 4, height: 4 });
    const forged = [
      ['stale policy', { ...valid, policySha256: '0'.repeat(64) }],
      ['type outside policy', { ...valid, type: 'image/gif' }, { detectedType: 'image/gif' }],
      ['kind outside policy', { ...valid, kind: 'video' }, { kind: 'video' }],
      ['size over the byte cap', { ...valid, size: 20 * 1024 * 1024 + 1 }, { size: 20 * 1024 * 1024 + 1 }],
      ['empty size', { ...valid, size: 0 }, { size: 0 }],
      ['malformed checksum', { ...valid, sha256: 'A'.repeat(64) }, { sha256: 'A'.repeat(64) }],
      ['other bytes', { ...valid, sha256: 'c'.repeat(64) }],
      ['other type', { ...valid, type: 'image/jpeg' }],
      ['not received', valid, { status: 'missing' }],
      ['array', [valid]],
      ['missing', null],
    ];
    for (const [label, verification, change = {}] of forged) assert.equal(attested({ ...photoPart, ...change, verification }), false, label);
  });

  it('never stores a result outside the policy, even from a decoder that returns one', async () => {
    const verifier = createMediaVerifier({ photo: async () => ({ width: 9000, height: 9000 }), voice: async () => ({ durationMs: 300_001 }) });
    for (const kind of ['photo', 'voice']) {
      const error = await verifier.exclusive((signal) => verifier.verify({ kind, type: kind === 'photo' ? 'image/png' : 'audio/ogg', bytes: Buffer.alloc(4), signal })).catch((caught) => caught);
      assert.deepEqual([error.code, error.status], ['unavailable', 503], kind);
    }
  });

  it('re-certifies a forged same-policy record before commit', async () => {
    const { app, owner, dataDir, verifier } = await workspace();
    try {
      const photo = part(SIGNATURE_PNG);
      const { id } = await openIntake(owner, [photo]);
      assert.equal((await upload(owner, id, photo.partId, SIGNATURE_PNG)).status, 200);
      await makeLegacy(dataDir, id, (item) => Object.assign(item.verification, { width: 9000, height: 9000 }));
      const calls = verifier.calls.length;
      assert.equal((await commit(owner, id)).status, 201);
      assert.equal(verifier.calls.length, calls + 1, 'the forged record did not count');
    } finally {
      await app.close();
    }
  });
});

describe('intake verification', () => {
  it('stores a private, policy-bound verification that public projections never show', async () => {
    const { app, owner, dataDir, verifier } = await workspace();
    try {
      const photo = part(SIGNATURE_PNG);
      const voice = part(SIGNATURE_WEBM, 'voice');
      const { id } = await openIntake(owner, [photo, voice]);
      assert.equal((await upload(owner, id, photo.partId, SIGNATURE_PNG)).status, 200);
      assert.equal((await upload(owner, id, voice.partId, SIGNATURE_WEBM)).status, 200);
      assert.deepEqual(verifier.calls.map((call) => [call.kind, call.sha256]), [['photo', photo.sha256], ['voice', voice.sha256]]);
      const record = await stored(dataDir, id);
      assert.deepEqual(record.parts[0].verification, { policySha256: POLICY_SHA256, kind: 'photo', type: 'image/png', size: photo.size, sha256: photo.sha256, width: 40, height: 30 });
      assert.deepEqual(record.parts[1].verification, { policySha256: POLICY_SHA256, kind: 'voice', type: 'audio/webm', size: voice.size, sha256: voice.sha256, durationMs: 1000 });
      const keys = ['detectedType', 'error', 'hints', 'kind', 'partId', 'sha256', 'size', 'status'];
      for (const view of [await owner.json(`/api/intakes/${id}`), (await owner.json('/api/intakes')).find((item) => item.id === id)]) {
        for (const item of view.parts) assert.deepEqual(Object.keys(item).sort(), keys);
        assert.ok(!JSON.stringify(view).includes(POLICY_SHA256));
      }
    } finally {
      await app.close();
    }
  });

  it('refuses permanent content outcomes with fixed codes and keeps transient outcomes unchanged', async () => {
    const verifier = scripted({ photo: [refuse('content'), refuse('pixels'), refuse('unavailable'), refuse('timeout')], voice: [refuse('duration', 'voice')] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const parts = [part(SIGNATURE_PNG), part(SIGNATURE_PNG_2), part(realPng(4, 4)), part(realPng(5, 5)), part(SIGNATURE_WEBM, 'voice')];
      const bytes = [SIGNATURE_PNG, SIGNATURE_PNG_2, realPng(4, 4), realPng(5, 5), SIGNATURE_WEBM];
      const { id } = await openIntake(owner, parts);
      const expected = [[400, MEDIA_MESSAGES.content.photo], [400, MEDIA_MESSAGES.pixels], [503, MEDIA_MESSAGES.unavailable], [503, MEDIA_MESSAGES.timeout], [400, MEDIA_MESSAGES.duration]];
      for (const [index, item] of parts.entries()) {
        const response = await upload(owner, id, item.partId, bytes[index]);
        assert.deepEqual([response.status, (await response.json()).error], expected[index], `part ${index}`);
      }
      const record = await stored(dataDir, id);
      assert.deepEqual(record.parts.map((item) => [item.status, item.error]), [['failed', 'content'], ['failed', 'pixels'], ['missing', null], ['missing', null], ['failed', 'duration']]);
      assert.deepEqual(await readdir(path.join(dataDir, 'intakes', id, 'parts')), []);
      // A preflight refusal never reaches the decoder.
      const before = verifier.calls.length;
      assert.equal((await upload(owner, id, parts[2].partId, Buffer.alloc(parts[2].size))).status, 400);
      assert.equal(verifier.calls.length, before);
      assert.equal((await upload(owner, id, parts[3].partId, bytes[3])).status, 200, 'a transient outcome can be retried');
    } finally {
      await app.close();
    }
  });

  it('answers exact replays of accepted parts and commits before the busy slot, and refuses other work as busy', async () => {
    const gate = deferred();
    const started = deferred();
    const verifier = scripted({ photo: [async () => ({ width: 40, height: 30 }), hold(gate, started)] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const done = part(SIGNATURE_PNG);
      const { id: committedId } = await openIntake(owner, [done]);
      assert.equal((await upload(owner, committedId, done.partId, SIGNATURE_PNG)).status, 200);
      const commitRequest = randomUUID();
      assert.equal((await commit(owner, committedId, 1, commitRequest)).status, 201);

      const accepted = part(realPng(6, 6));
      const waiting = part(SIGNATURE_PNG_2);
      const other = part(realPng(7, 7));
      const { id } = await openIntake(owner, [accepted, waiting, other]);
      // The first photo went to the committed intake; the next call holds the slot.
      const holding = upload(owner, id, waiting.partId, SIGNATURE_PNG_2);
      await started.promise;
      const busy = await upload(owner, id, other.partId, realPng(7, 7));
      assert.deepEqual([busy.status, (await busy.json()).error], [503, MEDIA_MESSAGES.busy]);
      assert.equal((await stored(dataDir, id)).parts[2].status, 'missing', 'busy leaves the part unchanged');
      assert.equal((await commit(owner, committedId, 1, commitRequest)).status, 200, 'a committed replay answers while busy');
      gate.resolve();
      assert.equal((await holding).status, 200);
      assert.equal((await upload(owner, id, accepted.partId, realPng(6, 6))).status, 200);
      const calls = verifier.calls.length;
      const second = deferred();
      verifier.calls.length = calls;
      const held = upload(owner, id, other.partId, realPng(7, 7));
      while (verifier.calls.length === calls) await new Promise((resolve) => setTimeout(resolve, 5));
      const replay = await upload(owner, id, accepted.partId, realPng(6, 6));
      assert.equal(replay.status, 200, 'an exact replay of an accepted part answers while busy');
      assert.equal(verifier.calls.length, calls + 1, 'the replay did not decode again');
      second.resolve();
      assert.equal((await held).status, 200);
    } finally {
      gate.resolve();
      await app.close();
    }
  });
});

describe('stored part integrity', () => {
  it('serves only bytes that still match the verification, and never recovers a part its decode refused', async () => {
    const verifier = scripted({ photo: [async () => ({ width: 40, height: 30 }), refuse('content')] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const good = part(SIGNATURE_PNG);
      const bad = part(SIGNATURE_PNG_2);
      const { id } = await openIntake(owner, [good, bad]);
      assert.equal((await upload(owner, id, good.partId, SIGNATURE_PNG)).status, 200);
      const file = path.join(dataDir, 'intakes', id, 'parts', `${good.partId}.bin`);
      const route = `/api/intakes/${id}/parts/${good.partId}`;
      const corrupt = Buffer.from(SIGNATURE_PNG);
      corrupt[corrupt.length - 1] ^= 0xff;
      await writeFile(file, corrupt);
      const refused = await owner.request(route);
      assert.equal(refused.status, 409, 'same-size corruption is never served');
      await writeFile(file, SIGNATURE_PNG);
      const served = await owner.request(route);
      assert.equal(served.status, 200);
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), SIGNATURE_PNG);

      assert.equal((await upload(owner, id, bad.partId, SIGNATURE_PNG_2)).status, 400);
      // As if removing the refused bytes had failed: they are never recovered.
      await writeFile(path.join(dataDir, 'intakes', id, 'parts', `${bad.partId}.bin`), SIGNATURE_PNG_2);
      const view = await owner.json(`/api/intakes/${id}`);
      assert.deepEqual(view.parts.map((item) => [item.status, item.error]), [['received', null], ['failed', 'content']]);
      assert.deepEqual(await readdir(path.join(dataDir, 'intakes', id, 'parts')), [`${good.partId}.bin`]);
    } finally {
      await app.close();
    }
  });
});

describe('certifying intakes received before content validation', () => {
  it('decodes old, stale or tampered parts before commit or asset reads, keeps progress and commits exact bytes', async () => {
    // Two uploads, the asset read's certification, then a transient refusal during commit.
    const ok = async () => ({ width: 40, height: 30 });
    const verifier = scripted({ photo: [ok, ok, ok, refuse('unavailable')] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const first = part(SIGNATURE_PNG);
      const second = part(SIGNATURE_PNG_2);
      const { id } = await openIntake(owner, [first, second]);
      for (const [item, bytes] of [[first, SIGNATURE_PNG], [second, SIGNATURE_PNG_2]]) assert.equal((await upload(owner, id, item.partId, bytes)).status, 200);
      await makeLegacy(dataDir, id, (item) => {
        if (item.partId === first.partId) delete item.verification;
        else item.verification.policySha256 = '0'.repeat(64);
      });
      assert.ok((await stored(dataDir, id)).parts.every((item) => !attested(item)));
      // A list read never decodes; the parts still truthfully report received.
      const calls = verifier.calls.length;
      assert.deepEqual((await owner.json(`/api/intakes/${id}`)).parts.map((item) => item.status), ['received', 'received']);
      assert.equal(verifier.calls.length, calls);

      // The asset read certifies the old part before serving it.
      const asset = await owner.request(`/api/intakes/${id}/parts/${first.partId}`);
      assert.equal(asset.status, 200);
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), SIGNATURE_PNG);
      assert.equal(verifier.calls.length, calls + 1);
      assert.ok(attested((await stored(dataDir, id)).parts[0]), 'certification was kept');

      // Commit certifies the remaining stale part; a transient refusal keeps earlier progress.
      const transient = await commit(owner, id);
      assert.deepEqual([transient.status, (await transient.json()).error], [503, MEDIA_MESSAGES.unavailable]);
      assert.deepEqual(await draftIds(dataDir), []);
      assert.ok(attested((await stored(dataDir, id)).parts[0]));
      const committed = await commit(owner, id);
      assert.equal(committed.status, 201);
      assert.deepEqual(verifier.calls.slice(calls).map((call) => call.sha256), [first.sha256, second.sha256, second.sha256], 'only uncertified parts were decoded');
      const { receipt } = await committed.json();
      const draft = JSON.parse(await readFile(path.join(dataDir, 'drafts', (await draftIds(dataDir))[0], 'draft.json'), 'utf8'));
      assert.equal(draft.text, 'Line one.\nLine two.\n');
      for (const [index, bytes] of [SIGNATURE_PNG, SIGNATURE_PNG_2].entries()) {
        assert.deepEqual(await readFile(path.join(dataDir, 'drafts', draft.id, draft.photos[index].name)), bytes);
      }
      assert.equal(receipt.intakeId, id);
    } finally {
      await app.close();
    }
  });

  it('marks only a still-matching old part failed on a permanent refusal, and refuses corrupt or changed parts without publishing', async () => {
    const gate = deferred();
    const started = deferred();
    const verifier = scripted({ photo: [async () => ({ width: 1, height: 1 }), async () => ({ width: 1, height: 1 }), async () => ({ width: 1, height: 1 }), refuse('content'), hold(gate, started)] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const good = part(SIGNATURE_PNG);
      const bad = part(SIGNATURE_PNG_2);
      const removed = part(realPng(3, 3));
      const { id, body } = await openIntake(owner, [good, bad, removed]);
      for (const [item, bytes] of [[good, SIGNATURE_PNG], [bad, SIGNATURE_PNG_2], [removed, realPng(3, 3)]]) assert.equal((await upload(owner, id, item.partId, bytes)).status, 200);
      await makeLegacy(dataDir, id, (item) => {
        if (item.partId !== good.partId) delete item.verification;
      });
      const refused = await commit(owner, id);
      assert.deepEqual([refused.status, (await refused.json()).error], [400, MEDIA_MESSAGES.content.photo]);
      const record = await stored(dataDir, id);
      assert.deepEqual(record.parts.map((item) => [item.status, item.error]), [['received', null], ['failed', 'content'], ['received', null]]);
      assert.ok(attested(record.parts[0]), 'a good part keeps its verification');
      assert.deepEqual((await readdir(path.join(dataDir, 'intakes', id, 'parts'))).sort(), [`${good.partId}.bin`, `${removed.partId}.bin`].sort());
      assert.deepEqual(await draftIds(dataDir), []);

      // The refused file is planned out; the other old part stays uncertified.
      const replan = (revision, parts) => owner.post(`/api/intakes/${id}/plan`, {
        requestId: randomUUID(), baseRevision: revision, text: body.text, parts, metadata: { photos: parts.map((_, index) => grant(`Photo ${index + 1}`)), text: grant('Text') },
      });
      assert.equal((await replan(1, [good, removed])).status, 200);

      // A same-size corrupt old file is refused before any decode.
      const calls = verifier.calls.length;
      const corrupt = Buffer.from(realPng(3, 3));
      corrupt[corrupt.length - 5] ^= 0xff;
      await writeFile(path.join(dataDir, 'intakes', id, 'parts', `${removed.partId}.bin`), corrupt);
      assert.equal((await commit(owner, id, 2)).status, 409);
      assert.equal(verifier.calls.length, calls);
      await writeFile(path.join(dataDir, 'intakes', id, 'parts', `${removed.partId}.bin`), realPng(3, 3));

      // A plan change while an old part is being certified is never adopted.
      const pending = commit(owner, id, 2);
      await started.promise;
      assert.equal((await replan(2, [good])).status, 200);
      gate.resolve();
      assert.equal((await pending).status, 409);
      assert.deepEqual(await draftIds(dataDir), []);
      assert.equal((await stored(dataDir, id)).parts.length, 1);
      assert.equal((await commit(owner, id, 3)).status, 201);
    } finally {
      gate.resolve();
      await app.close();
    }
  });
});

describe('a refusal that arrives after the part changed', () => {
  it('never marks a removed and re-added part ID failed for the old file', async () => {
    const gate = deferred();
    const started = deferred();
    const verifier = scripted({ photo: [async () => ({ width: 40, height: 30 }), async () => {
      started.resolve();
      await gate.promise;
      throw new MediaVerificationError('content', 'photo');
    }] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const old = part(SIGNATURE_PNG);
      const { id, body } = await openIntake(owner, [old]);
      assert.equal((await upload(owner, id, old.partId, SIGNATURE_PNG)).status, 200);
      await makeLegacy(dataDir, id);
      const pending = commit(owner, id);
      await started.promise;
      const replan = (revision, parts) => owner.post(`/api/intakes/${id}/plan`, {
        requestId: randomUUID(), baseRevision: revision, text: body.text, parts, metadata: { photos: parts.map((_, index) => grant(`Photo ${index + 1}`)), text: grant('Text') },
      });
      assert.equal((await replan(1, [])).status, 200);
      const readded = { ...old, size: SIGNATURE_PNG_2.length, sha256: sha256(SIGNATURE_PNG_2) };
      assert.equal((await replan(2, [readded])).status, 200);
      gate.resolve();
      assert.equal((await pending).status, 400);
      const record = await stored(dataDir, id);
      assert.deepEqual(record.parts.map((item) => [item.partId, item.sha256, item.status, item.error]), [[old.partId, readded.sha256, 'missing', null]]);
      assert.equal((await upload(owner, id, old.partId, SIGNATURE_PNG_2)).status, 200, 'the new file can still be received');
    } finally {
      gate.resolve();
      await app.close();
    }
  });
});

describe('shutdown boundaries', () => {
  it('never marks a part received when the server closes during its rename, and leaves no file', async () => {
    const { app, owner, dataDir } = await workspace();
    let restarted = null;
    const photo = part(SIGNATURE_PNG);
    const { id } = await openIntake(owner, [photo]);
    const barrier = holdRename((from, to) => to.endsWith(`${photo.partId}.bin`));
    try {
      const pending = upload(owner, id, photo.partId, SIGNATURE_PNG).then((response) => response.status, () => 'closed');
      await barrier.reached;
      const closing = app.close();
      barrier.release();
      await closing;
      assert.ok([503, 'closed'].includes(await pending));
      barrier.restore();
      ({ app: restarted } = await workspace({ dataDir }));
      const record = await stored(dataDir, id);
      assert.equal(record.parts[0].status, 'missing');
      assert.equal(record.parts[0].verification, undefined);
      assert.deepEqual(await readdir(path.join(dataDir, 'intakes', id, 'parts')), []);
    } finally {
      barrier.restore();
      if (restarted) await restarted.close();
    }
  });

  it('aborts a decode on close without publishing, and a draft rename already started on close stays a recoverable commit', async () => {
    const gate = deferred();
    const started = deferred();
    const { app, owner, dataDir } = await workspace({ verifier: scripted({ photo: [hold(gate, started)] }) });
    let second = null;
    let third = null;
    try {
      const photo = part(SIGNATURE_PNG);
      const { id } = await openIntake(owner, [photo]);
      const pending = upload(owner, id, photo.partId, SIGNATURE_PNG).then((response) => response.status, () => 'closed');
      await started.promise;
      await app.close();
      assert.ok([503, 'closed'].includes(await pending));
      ({ app: second } = await workspace({ dataDir }));
      const restartedOwner = client(second.base, second.cookie);
      assert.equal((await stored(dataDir, id)).parts[0].status, 'missing');

      assert.equal((await upload(restartedOwner, id, photo.partId, SIGNATURE_PNG)).status, 200);
      const { draftId } = await stored(dataDir, id);
      const barrier = holdRename((from, to) => to.endsWith(path.join('drafts', draftId)));
      try {
        const requestId = randomUUID();
        const committing = commit(restartedOwner, id, 1, requestId).then((response) => response.status, () => 'closed');
        await barrier.reached;
        const closing = second.close();
        barrier.release();
        await closing;
        await committing;
        barrier.restore();
        ({ app: third } = await workspace({ dataDir }));
        const thirdOwner = client(third.base, third.cookie);
        // The rename had started, so the commit won and is recovered from its receipt.
        const view = await thirdOwner.json(`/api/intakes/${id}`);
        assert.deepEqual([view.status, view.draftId], ['committed', draftId]);
        assert.equal((await commit(thirdOwner, id, 1, requestId)).status, 200);
      } finally {
        barrier.restore();
      }
    } finally {
      gate.resolve();
      if (third) await third.close();
    }
  });
});

describe('direct saves', () => {
  it('stores nothing when any file is refused or the slot is busy, and text alone never needs the slot', async () => {
    const gate = deferred();
    const started = deferred();
    const verifier = scripted({ photo: [async () => ({ width: 1, height: 1 }), refuse('content'), hold(gate, started)] });
    const { app, owner, dataDir } = await workspace({ verifier });
    try {
      const refused = await owner.request('/api/drafts', { method: 'POST', body: directForm([SIGNATURE_PNG, SIGNATURE_PNG_2]) });
      assert.deepEqual([refused.status, (await refused.json()).error], [400, MEDIA_MESSAGES.content.photo]);
      assert.deepEqual(await draftIds(dataDir), []);
      assert.deepEqual(await incoming(dataDir), []);
      const preflight = await owner.request('/api/drafts', { method: 'POST', body: directForm([Buffer.from('not an image')]) });
      assert.equal(preflight.status, 400);
      assert.equal(verifier.calls.length, 2, 'a signature refusal never reaches the decoder');

      const holding = owner.request('/api/drafts', { method: 'POST', body: directForm([SIGNATURE_PNG]) });
      await started.promise;
      const busy = await owner.request('/api/drafts', { method: 'POST', body: directForm([SIGNATURE_PNG_2]) });
      assert.deepEqual([busy.status, (await busy.json()).error], [503, MEDIA_MESSAGES.busy]);
      const textOnly = new FormData();
      textOnly.append('text', 'Only words.');
      assert.equal((await owner.request('/api/drafts', { method: 'POST', body: textOnly })).status, 201);
      gate.resolve();
      const saved = await holding;
      assert.equal(saved.status, 201);
      const draft = JSON.parse(await readFile(path.join(dataDir, 'drafts', (await saved.json()).id, 'draft.json'), 'utf8'));
      assert.deepEqual(await readFile(path.join(dataDir, 'drafts', draft.id, draft.photos[0].name)), SIGNATURE_PNG, 'the original is stored unchanged');
      assert.equal((await draftIds(dataDir)).length, 2);
    } finally {
      gate.resolve();
      await app.close();
    }
  });
});
