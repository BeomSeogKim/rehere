import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pcmWav } from '../audio-derivative.mjs';
import { BLOCKED_MESSAGE, BUNDLE_BUSY, UNAVAILABLE_MESSAGE } from '../collaboration.mjs';
import { PHOTO_BUSY } from '../contribution-photos.mjs';
import { RequestError, detectMedia } from '../drafts.mjs';
import { MediaVerificationError } from '../media-verification.mjs';
import { client, enrolledContributor, jpeg, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Synthetic bytes only. The injected preparer stands in for the strict local
// decode (contribution-recordings.mjs) with its exact result shape; the
// stored-recording and privacy rules are unchanged.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(96, 5)]);
const WEBM_2 = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(96, 6)]);
const WAV = pcmWav(Buffer.alloc(3200));
const REVIEW = jpeg(64, 48, 9);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakePreparer(steps = []) {
  const calls = [];
  const prepare = async (call) => {
    calls.push(call);
    const step = steps.shift();
    if (step) await step(call);
    const { type, extension } = detectMedia('voice', call.bytes);
    return {
      original: { sha256: sha256(call.bytes), size: call.bytes.length, type, extension },
      playback: { sha256: sha256(WAV), size: WAV.length, type: 'audio/wav', durationMs: 100, sampleRate: 16_000, channels: 1, bitsPerSample: 16, parentSha256: sha256(call.bytes) },
      wav: WAV,
    };
  };
  prepare.calls = calls;
  return prepare;
}
const photoDecoder = async () => REVIEW;

async function workspace({ preparer = fakePreparer(), dataDir } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-recordings-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, contributionPhotoDecoder: photoDecoder, recordingPreparer: preparer });
  return { app, dataDir, preparer, owner: client(app.base, app.cookie) };
}

const publicGrant = () => ({
  provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

async function place(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('metadata', JSON.stringify({ photos: [publicGrant()] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    draft, job, scene,
    bundle: `${scene}/contributions/bundle`,
    recording: (id) => `${scene}/contributions/${id}/recording.wav`,
    review: (id) => `${scene}/contributions/${id}/review`,
    withdraw: (id) => `${scene}/contributions/${id}/withdraw`,
  };
}

const grants = (change = {}) => ({ place: true, model: false, share: true, ...change });
const facts = (permissions = {}) => ({
  origin: { kind: 'own', reference: 'Kitchen, recorded at home' },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: 'late nineties' },
  permissions: grants(permissions),
});
const voiceFacts = (change = {}) => ({ ...facts(change.permissions), captionText: '', captionConfirmed: false, ...change, ...(change.permissions && { permissions: grants(change.permissions) }) });
const payload = (change = {}) => ({ requestId: randomUUID(), text: '', permissions: null, periodClaim: '', photo: null, voice: voiceFacts(), ...change });

function bundleForm(body, files = { voice: WEBM }, extra = []) {
  const form = new FormData();
  form.append('payload', typeof body === 'string' ? body : JSON.stringify(body));
  for (const [name, bytes] of Object.entries(files)) form.append(name, new Blob([bytes], { type: 'image/heic' }), 'name.bin');
  for (const [name, value] of extra) form.append(name, value);
  return form;
}
const send = (session, scene, body, files, extra) => session.request(scene.bundle, { method: 'POST', body: bundleForm(body, files, extra) });
const reviewBody = (change = {}) => ({
  requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: 'Matches the doorway.', conflict: 'unknown',
  transform: { offset: [0, 0, -0.5], yaw: 0 }, ...change,
});
const jobDirOf = (dataDir, scene) => path.join(dataDir, 'reconstructions', scene.draft.id, scene.job.id);
const manifestOf = async (dataDir, scene) => JSON.parse(await readFile(path.join(jobDirOf(dataDir, scene), 'manifest.json'), 'utf8'));
const storedOf = async (dataDir, scene, id) => (await manifestOf(dataDir, scene)).collaboration.contributions.find((item) => item.id === id);
const bundleDir = (dataDir, scene, id) => path.join(jobDirOf(dataDir, scene), 'contributions', id);
const contributionNames = async (dataDir, scene) => (await readdir(path.join(jobDirOf(dataDir, scene), 'contributions')).catch(() => [])).sort();

async function contributed(app, owner, scene, change = {}, files = { voice: WEBM }, name = 'Synthetic speaker') {
  const { session, principal } = await enrolledContributor(owner, app.base, scene.draft.id, name);
  const body = payload(change);
  const response = await send(session, scene, body, files);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return { session, principal, body, contribution: await response.json() };
}

const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;
const versionView = (version) => ({ id: randomUUID(), kind: 'version', version, variantId: null });
const previewBody = (views, change = {}) => ({
  requestId: randomUUID(), title: 'Synthetic place', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] },
  contributionIds: [], synthetic: true, ...change,
});
async function issue(owner, scene, preview) {
  const token = visitToken();
  const response = await owner.post(`${scene.scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true });
  assert.equal(response.status, 201);
  return token;
}
const visit = (base, token, route = '/api/visit', init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

describe('submitting a recording', () => {
  it('accepts a voice-only bundle without writing or captions, stores exact files privately and replays exactly', async () => {
    const { app, owner, dataDir, preparer } = await workspace();
    try {
      const scene = await place(owner);
      const draftFile = path.join(dataDir, 'drafts', scene.draft.id, 'draft.json');
      const draftBefore = await readFile(draftFile);
      const { session, principal, body, contribution } = await contributed(app, owner, scene);
      assert.deepEqual([contribution.text, contribution.textSha256, contribution.permissions, contribution.photo], ['', null, null, null]);
      assert.equal(contribution.requestId, body.requestId);
      assert.deepEqual(contribution.voice, {
        available: true, type: 'audio/webm', durationMs: 100, audio: { type: 'audio/wav', size: WAV.length },
        origin: body.voice.origin, dates: body.voice.dates, permissions: body.voice.permissions,
        receivedAt: contribution.voice.receivedAt, captions: null, captionHistory: [], url: scene.recording(contribution.id),
      });
      assert.equal(preparer.calls.length, 1);
      assert.deepEqual(preparer.calls[0].bytes, WEBM);

      const stored = await storedOf(dataDir, scene, contribution.id);
      const { source, playback, captions } = stored.voice;
      assert.equal(stored.permissions, null);
      assert.deepEqual({ kind: source.kind, role: source.role, parentSourceId: source.parentSourceId, name: source.name, sha256: source.sha256, size: source.size, type: source.type },
        { kind: 'voice', role: 'original', parentSourceId: null, name: 'voice-original.webm', sha256: sha256(WEBM), size: WEBM.length, type: 'audio/webm' });
      assert.deepEqual(source.provider, { principalId: principal.id, displayName: 'Synthetic speaker' });
      assert.deepEqual(playback, {
        id: playback.id, kind: 'voice', role: 'derived', parentSourceId: source.id, name: 'playback.wav', sha256: sha256(WAV), size: WAV.length,
        type: 'audio/wav', durationMs: 100, sampleRate: 16_000, channels: 1, bitsPerSample: 16,
      });
      assert.equal(captions, null);
      const text = JSON.stringify(contribution);
      for (const secret of [source.id, playback.id, source.sha256, playback.sha256, 'voice-original', 'playback.wav']) assert.ok(!text.includes(secret), secret);
      const dir = bundleDir(dataDir, scene, contribution.id);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      for (const [name, bytes] of [['voice-original.webm', WEBM], ['playback.wav', WAV]]) {
        assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600);
        assert.deepEqual(await readFile(path.join(dir, name)), bytes);
      }
      assert.deepEqual(await readFile(draftFile), draftBefore, 'nothing enters the owner draft or its sources');

      assert.deepEqual(await (await send(session, scene, body)).json(), contribution);
      assert.equal(preparer.calls.length, 1, 'an exact replay never prepares again');
      assert.equal((await send(session, scene, body, { voice: WEBM_2 })).status, 409);
      assert.equal((await send(session, scene, { ...body, voice: voiceFacts({ captionText: 'Changed.', captionConfirmed: true }) })).status, 409);

      for (const reader of [owner, session]) {
        const response = await reader.request(scene.recording(contribution.id));
        assert.equal(response.status, 200);
        assert.deepEqual([response.headers.get('content-type'), response.headers.get('cache-control')], ['audio/wav', 'no-store']);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
      }
      assert.equal((await owner.request(scene.recording(contribution.id), { method: 'HEAD' })).status, 200);
      const ranged = await owner.request(scene.recording(contribution.id), { headers: { range: 'bytes=0-3' } });
      assert.equal(ranged.status, 206);
      assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), WAV.subarray(0, 4));
      const { session: peer } = await enrolledContributor(owner, app.base, scene.draft.id, 'Synthetic peer');
      assert.equal((await peer.request(scene.recording(contribution.id))).status, 404);
      assert.equal((await client(app.base).request(scene.recording(contribution.id))).status, 401);
    } finally {
      await app.close();
    }
  });

  it('keeps the provider’s confirmed caption as one whole-recording cue bound to both files', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const captionText = 'A kettle hums, then I describe the counter.\nNo other voices.';
      const { contribution, principal } = await contributed(app, owner, scene, { text: 'Also in writing.', permissions: grants(), voice: voiceFacts({ captionText, captionConfirmed: true }) });
      const stored = (await storedOf(dataDir, scene, contribution.id)).voice;
      const cues = [{ startMs: 0, endMs: 100, text: captionText }];
      assert.deepEqual(contribution.voice.captions, { cues, sha256: stored.captions.sha256, authorLabel: 'Synthetic speaker', version: 1, createdAt: stored.captions.createdAt });
      assert.equal(stored.captions.sha256, sha256(JSON.stringify([stored.source.sha256, stored.playback.sha256, principal.id, cues])));
      assert.deepEqual([stored.captions.version, stored.captions.confirmed, stored.captions.author.principalId], [1, true, principal.id]);
      assert.equal(contribution.text, 'Also in writing.');
    } finally {
      await app.close();
    }
  });

  it('refuses malformed bundles before preparing and keeps the earlier routes unchanged', async () => {
    const { app, owner, preparer } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const refused = async (response, status, label) => {
        assert.equal(response.status, status, label);
        assert.deepEqual(Object.keys(await response.json()), ['error'], label);
      };
      for (const [label, change, files] of [
        ['blank writing with grants', { permissions: grants() }],
        ['writing without grants', { text: 'Words.', permissions: null }],
        ['photo alone', { voice: null, photo: facts() }, { photo: SYNTHETIC_PHOTO }],
        ['nothing', { voice: null }, {}],
        ['voice facts without a file', {}, {}],
        ['a file without facts', { voice: null, text: 'Words.', permissions: grants() }],
        ['unconfirmed caption', { voice: voiceFacts({ captionText: 'Words.', captionConfirmed: false }) }],
        ['confirmed blank caption', { voice: voiceFacts({ captionText: '  ', captionConfirmed: true }) }],
        ['caption control character', { voice: voiceFacts({ captionText: 'bell\u0007', captionConfirmed: true }) }],
        ['caption too long', { voice: voiceFacts({ captionText: 'x'.repeat(20_001), captionConfirmed: true }) }],
        ['client provider label', { voice: { ...voiceFacts(), provider: 'Someone else' } }],
        ['extra key', { extra: true }],
      ]) await refused(await send(session, scene, payload(change), files), 400, label);
      await refused(await send(session, scene, payload(), { voice: WEBM }, [['voice', new Blob([WEBM])]]), 400, 'repeated voice');
      await refused(await send(session, scene, payload(), { voice: WEBM }, [['note', 'x']]), 400, 'unknown entry');
      await refused(await send(session, scene, payload(), { voice: Buffer.alloc(0) }), 400, 'empty voice');
      await refused(await send(session, scene, payload(), { voice: Buffer.from('not audio') }), 415, 'not audio');
      await refused(await send(client(app.base), scene, payload()), 401, 'anonymous');
      assert.equal(preparer.calls.length, 0);

      // Writing alone through the bundle route, and the earlier routes as before.
      assert.equal((await send(session, scene, payload({ text: 'Only words.', permissions: grants(), voice: null }), {})).status, 200);
      assert.equal((await session.post(`${scene.scene}/contributions`, { requestId: randomUUID(), text: 'JSON words.', permissions: grants(), periodClaim: '' })).status, 200);
      const photoForm = new FormData();
      photoForm.append('payload', JSON.stringify({ requestId: randomUUID(), text: 'With a photo.', permissions: grants(), periodClaim: '', photo: facts() }));
      photoForm.append('photo', new Blob([SYNTHETIC_PHOTO]), 'photo');
      assert.equal((await session.request(`${scene.scene}/contributions/photo`, { method: 'POST', body: photoForm })).status, 200);
      assert.equal(preparer.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('stores nothing when preparation refuses, answers busy and replays before busy, joins identical retries and stops on close', async () => {
    const gate = deferred();
    const started = deferred();
    const preparer = fakePreparer([
      async () => {
        throw new MediaVerificationError('content', 'voice');
      },
      async () => {
        started.resolve();
        await gate.promise;
      },
    ]);
    const { app, owner, dataDir } = await workspace({ preparer });
    let restarted = null;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const refused = await send(session, scene, payload());
      assert.equal(refused.status, 400);
      assert.deepEqual(await contributionNames(dataDir, scene), []);

      const body = payload();
      const first = send(session, scene, body);
      await started.promise;
      const joined = send(session, scene, body);
      assert.equal((await send(session, scene, { ...body, periodClaim: 'changed' })).status, 409);
      const busy = await send(session, scene, payload());
      assert.deepEqual([busy.status, await busy.json()], [503, { error: BUNDLE_BUSY }]);
      const photoForm = new FormData();
      photoForm.append('payload', JSON.stringify({ requestId: randomUUID(), text: 'With a photo.', permissions: grants(), periodClaim: '', photo: facts() }));
      photoForm.append('photo', new Blob([SYNTHETIC_PHOTO]), 'photo');
      const photoBusy = await session.request(`${scene.scene}/contributions/photo`, { method: 'POST', body: photoForm });
      assert.deepEqual([photoBusy.status, (await photoBusy.json()).error], [409, PHOTO_BUSY], 'the photo route keeps its busy answer');
      gate.resolve();
      const [a, b] = await Promise.all([first, joined]);
      assert.deepEqual([a.status, b.status], [200, 200]);
      const published = await a.json();
      assert.deepEqual(await b.json(), published);
      assert.equal(preparer.calls.length, 2);

      // A crash before the manifest write leaves an unreferenced folder; restart keeps only referenced ones.
      const parent = path.join(jobDirOf(dataDir, scene), 'contributions');
      await mkdir(path.join(parent, randomUUID()));
      await mkdir(path.join(parent, `.staging-${randomUUID()}-${randomUUID()}`));
      await app.close();
      ({ app: restarted } = await workspace({ dataDir }));
      const restartedOwner = client(restarted.base, restarted.cookie);
      // Recovery runs with the first scene request after a start.
      assert.equal((await restartedOwner.request(scene.recording(published.id))).status, 200, 'a voice-only folder survives recovery');
      assert.deepEqual(await contributionNames(dataDir, scene), [published.id]);
    } finally {
      gate.resolve();
      if (restarted) await restarted.close();
      else await app.close();
    }
  });
});

describe('the production recording preparer', () => {
  it('decodes a real silent WebM through the bundle route and refuses a truncated one (skips without ffmpeg)', async (t) => {
    const run = promisify(execFile);
    const ffmpeg = process.env.REHERE_FFMPEG || 'ffmpeg';
    if (!(await run(ffmpeg, ['-hide_banner', '-version']).then(() => true, () => false))) return t.skip('ffmpeg unavailable');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-recordings-real-'));
    tempDirs.push(dataDir);
    const file = path.join(dataDir, 'silent.webm');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'libopus', '-b:a', '16k', file]);
    const silent = await readFile(file);
    // No recordingPreparer: the server builds the production default.
    const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, contributionPhotoDecoder: photoDecoder });
    const owner = client(app.base, app.cookie);
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const accepted = await send(session, scene, payload(), { voice: silent });
      assert.equal(accepted.status, 200);
      const contribution = await accepted.json();
      assert.ok(contribution.voice.durationMs >= 900 && contribution.voice.durationMs <= 1200, `silence decodes: ${contribution.voice.durationMs}`);
      const stored = await storedOf(dataDir, scene, contribution.id);
      assert.deepEqual(await readFile(path.join(bundleDir(dataDir, scene, contribution.id), 'voice-original.webm')), silent, 'the original is unchanged');
      const wav = Buffer.from(await (await owner.request(scene.recording(contribution.id))).arrayBuffer());
      assert.deepEqual([wav.length, sha256(wav), wav.toString('latin1', 0, 4)], [stored.voice.playback.size, stored.voice.playback.sha256, 'RIFF']);
      assert.equal(contribution.voice.audio.size, wav.length);
      const truncated = await send(session, scene, payload(), { voice: silent.subarray(0, Math.floor(silent.length / 3)) });
      assert.equal(truncated.status, 400);
    } finally {
      await app.close();
    }
  });
});

describe('grants, review and integrity of a recording bundle', () => {
  it('requires every present material’s grants and an explicit acknowledgment per material', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const placeless = await contributed(app, owner, scene, { voice: voiceFacts({ permissions: { place: false } }) });
      assert.equal((await owner.post(scene.review(placeless.contribution.id), reviewBody({ voiceReviewed: true }))).status, 403);

      const mixed = await contributed(app, owner, scene, {
        text: 'The counter stood back.', permissions: grants({ model: true }), photo: facts({ model: true }), voice: voiceFacts({ permissions: { model: false, share: false } }),
      }, { photo: SYNTHETIC_PHOTO, voice: WEBM }, 'Mixed speaker');
      const target = scene.review(mixed.contribution.id);
      for (const body of [reviewBody({ photoReviewed: true }), reviewBody({ voiceReviewed: true }), reviewBody({ photoReviewed: true, voiceReviewed: false })]) {
        assert.equal((await owner.post(target, body)).status, 400);
      }
      assert.equal((await owner.post(target, reviewBody({ decision: 'hold', transform: null, voiceReviewed: true }))).status, 400, 'no acknowledgment outside geometry');
      const textOnly = await contributed(app, owner, scene, { text: 'Words only.', permissions: grants(), voice: null }, {}, 'Writer');
      assert.equal((await owner.post(scene.review(textOnly.contribution.id), reviewBody({ voiceReviewed: true }))).status, 400, 'no recording to acknowledge');

      assert.equal((await owner.post(target, reviewBody({ photoReviewed: true, voiceReviewed: true }))).status, 200);
      const stored = await storedOf(dataDir, scene, mixed.contribution.id);
      assert.deepEqual([stored.review.photoReviewed, stored.review.voiceReviewed], [true, true]);
      const job = await owner.json(scene.scene);
      assert.deepEqual([job.usageBlocked, job.modelBlocked], [false, true], 'the recording was not shared for model use');
      // The recording is not shown to visitors here, yet its share grant still applies.
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, previewBody([versionView(2)]))).status, 403);
    } finally {
      await app.close();
    }
  });

  it('blocks dependents on a missing or changed recording file with the generic message, and redacts on withdrawal', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution, session } = await contributed(app, owner, scene, { voice: voiceFacts({ captionText: 'My own description.', captionConfirmed: true }) });
      assert.equal((await owner.post(scene.review(contribution.id), reviewBody({ voiceReviewed: true }))).status, 200);
      const dir = bundleDir(dataDir, scene, contribution.id);
      const texture = `${scene.scene}/assets/texture.jpg`;
      const blocked = async (label, message) => {
        const asset = await owner.request(texture);
        assert.equal(asset.status, 409, label);
        assert.equal((await asset.json()).error, message, label);
      };
      const tampered = Buffer.from(WAV);
      tampered[tampered.length - 1] ^= 0xff;
      await writeFile(path.join(dir, 'playback.wav'), tampered);
      await blocked('changed listening copy', UNAVAILABLE_MESSAGE);
      assert.equal((await owner.request(scene.recording(contribution.id))).status, 409);
      const own = (await session.json(`${scene.scene}/collaboration`)).contributions[0];
      assert.deepEqual([own.status, own.voice.available, own.voice.url], ['adopted', false, null]);
      await writeFile(path.join(dir, 'playback.wav'), WAV);
      assert.equal((await owner.request(texture)).status, 200);
      await rename(path.join(dir, 'voice-original.webm'), path.join(dir, 'moved'));
      await blocked('missing original', UNAVAILABLE_MESSAGE);
      await rename(path.join(dir, 'moved'), path.join(dir, 'voice-original.webm'));
      assert.equal((await owner.request(texture)).status, 200);

      assert.equal((await session.post(scene.withdraw(contribution.id), { requestId: randomUUID() })).status, 200);
      await blocked('withdrawn', BLOCKED_MESSAGE);
      assert.equal((await owner.request(scene.recording(contribution.id))).status, 404);
      const withdrawn = (await owner.json(`${scene.scene}/collaboration`)).contributions[0];
      assert.deepEqual(withdrawn.voice, { ...contribution.voice, available: false, url: null, origin: { kind: 'own', reference: '' }, dates: null, captions: null });
      assert.deepEqual(await readFile(path.join(dir, 'voice-original.webm')), WEBM, 'the original stays private and unchanged');
    } finally {
      await app.close();
    }
  });
});

describe('recordings linked to shared views', () => {
  it('shares only explicitly linked, captioned recordings with their exact captions, and suspends on change or withdrawal', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const captionText = 'I describe the counter by the window.';
      const { contribution, session } = await contributed(app, owner, scene, { voice: voiceFacts({ captionText, captionConfirmed: true }) });
      const uncaptioned = await contributed(app, owner, scene, {}, { voice: WEBM_2 }, 'Quiet speaker');
      const v1 = versionView(1);
      const previews = `${scene.scene}/shares/previews`;
      const link = (change = {}) => ({ contributionId: contribution.id, viewIds: [v1.id], targetId: 'place', captionSha256: contribution.voice.captions.sha256, ...change });
      for (const [label, recordings, status] of [
        ['view not selected', [link({ viewIds: [randomUUID()] })], 400],
        ['no views', [link({ viewIds: [] })], 400],
        ['object of another scene shape', [link({ targetId: 'object-1' })], 400],
        ['unknown target', [link({ targetId: 'ceiling' })], 400],
        ['duplicate', [link(), link()], 400],
        ['stale caption pin', [link({ captionSha256: '0'.repeat(64) })], 409],
        ['no captions', [link({ contributionId: uncaptioned.contribution.id, captionSha256: '1'.repeat(64) })], 409],
      ]) assert.equal((await owner.post(previews, previewBody([v1], { recordings }))).status, status, label);

      const created = await owner.post(previews, previewBody([v1], { recordings: [link({ targetId: 'selected-foreground' })] }));
      assert.equal(created.status, 201);
      const preview = await created.json();
      const [item] = preview.publicView.contributorRecordings;
      assert.deepEqual(item, {
        id: item.id, viewIds: [v1.id], target: { id: 'selected-foreground', label: 'About the selected foreground object' }, title: 'Contributor recording',
        label: 'Contributor recording; human-written listening captions; not verified history.', providerLabel: 'Synthetic speaker', captionAuthorLabel: 'Synthetic speaker',
        cues: [{ startMs: 0, endMs: 100, text: captionText }], durationMs: 100, audio: { type: 'audio/wav', size: WAV.length }, captionVersion: 1,
      });
      const stored = await storedOf(dataDir, scene, contribution.id);
      const shown = JSON.stringify(preview.publicView);
      for (const secret of [contribution.id, stored.voice.source.id, stored.voice.source.sha256, stored.voice.playback.sha256, stored.voice.captions.sha256, 'Kitchen', stored.principalId]) {
        assert.ok(!shown.includes(secret), secret);
      }
      assert.deepEqual(preview.publicView.views[0].evidence.support, [], 'narration is not a geometry dependency');
      const audio = await owner.request(`${previews}/${preview.id}/recordings/${item.id}/audio.wav`);
      assert.equal(audio.status, 200);
      assert.deepEqual(Buffer.from(await audio.arrayBuffer()), WAV);
      assert.equal((await owner.request(`${previews}/${preview.id}/recordings/${randomUUID()}/audio.wav`)).status, 404);

      const token = await issue(owner, scene, preview);
      const plain = await issue(owner, scene, await (await owner.post(previews, previewBody([v1]))).json());
      const manifest = await (await visit(app.base, token)).json();
      assert.deepEqual(manifest.contributorRecordings, preview.publicView.contributorRecordings);
      assert.equal((await (await visit(app.base, plain)).json()).contributorRecordings, undefined);
      const route = `/api/visit/recordings/${item.id}/audio.wav`;
      const played = await visit(app.base, token, route);
      assert.equal(played.status, 200);
      assert.deepEqual(Buffer.from(await played.arrayBuffer()), WAV);
      assert.equal((await visit(app.base, token, route, { method: 'HEAD' })).status, 200);
      assert.equal((await visit(app.base, token, route, { headers: { range: 'bytes=0-1' } })).status, 206);
      assert.equal((await visit(app.base, plain, route)).status, 404, 'another snapshot cannot play it');

      const file = path.join(bundleDir(dataDir, scene, contribution.id), 'playback.wav');
      const tampered = Buffer.from(WAV);
      tampered[60] ^= 0xff;
      await writeFile(file, tampered);
      assert.equal((await visit(app.base, token)).status, 404);
      assert.equal((await visit(app.base, plain)).status, 200, 'an independent snapshot stays available');
      await writeFile(file, WAV);
      assert.equal((await visit(app.base, token)).status, 200);

      assert.equal((await session.post(scene.withdraw(contribution.id), { requestId: randomUUID() })).status, 200);
      assert.equal((await visit(app.base, token)).status, 404);
      assert.equal((await visit(app.base, token, route, { method: 'HEAD' })).status, 404);
      assert.equal((await visit(app.base, plain)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('never trusts a stored caption hash: changed cues with an unchanged hash are refused at preview, issue, visit and audio', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution } = await contributed(app, owner, scene, { voice: voiceFacts({ captionText: 'The words I chose.', captionConfirmed: true }) });
      const v1 = versionView(1);
      const previews = `${scene.scene}/shares/previews`;
      const body = () => previewBody([v1], { recordings: [{ contributionId: contribution.id, viewIds: [v1.id], targetId: 'place', captionSha256: contribution.voice.captions.sha256 }] });
      const pending = await (await owner.post(previews, body())).json();
      const issued = await (await owner.post(previews, body())).json();
      const token = await issue(owner, scene, issued);
      const publicId = issued.publicView.contributorRecordings[0].id;
      const visitAudio = `/api/visit/recordings/${publicId}/audio.wav`;
      assert.equal((await visit(app.base, token, visitAudio)).status, 200);

      const file = path.join(jobDirOf(dataDir, scene), 'manifest.json');
      const original = await readFile(file, 'utf8');
      const manifest = JSON.parse(original);
      const record = manifest.collaboration.contributions.find((item) => item.id === contribution.id);
      record.voice.captions.cues[0].text = 'Words the provider never wrote.';
      await writeFile(file, JSON.stringify(manifest, null, 2));

      assert.equal((await owner.request(`${previews}/${pending.id}`)).status, 409, 'existing preview');
      assert.equal((await owner.request(`${previews}/${pending.id}/recordings/${pending.publicView.contributorRecordings[0].id}/audio.wav`)).status, 409, 'preview audio');
      const refusedIssue = await owner.post(`${scene.scene}/shares`, { requestId: randomUUID(), previewId: pending.id, previewDigest: pending.digest, token: visitToken(), consent: true });
      assert.equal(refusedIssue.status, 409, 'issue');
      assert.equal((await visit(app.base, token)).status, 404, 'visit');
      assert.equal((await visit(app.base, token, visitAudio)).status, 404, 'visit audio');
      assert.equal((await visit(app.base, token, visitAudio, { method: 'HEAD' })).status, 404, 'visit audio HEAD');
      assert.equal((await owner.post(previews, body())).status, 409, 'new preview');

      await writeFile(file, original);
      assert.equal((await visit(app.base, token, visitAudio)).status, 200, 'the untouched record works again');
      assert.equal((await owner.post(previews, body())).status, 201);
    } finally {
      await app.close();
    }
  });

  it('requires the recording’s share grant even for an unadopted narration', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution } = await contributed(app, owner, scene, { voice: voiceFacts({ captionText: 'Mine.', captionConfirmed: true, permissions: { share: false } }) });
      const v1 = versionView(1);
      const response = await owner.post(`${scene.scene}/shares/previews`, previewBody([v1], {
        recordings: [{ contributionId: contribution.id, viewIds: [v1.id], targetId: 'place', captionSha256: contribution.voice.captions.sha256 }],
      }));
      assert.equal(response.status, 403);
    } finally {
      await app.close();
    }
  });
});
