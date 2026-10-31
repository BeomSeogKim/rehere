import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PHOTO_BUSY, PHOTO_PREPARE_FAILED, PHOTO_UNREADABLE, pythonPhotoDecoder } from '../contribution-photos.mjs';
import { EventEmitter } from 'node:events';
import { BLOCKED_MESSAGE, UNAVAILABLE_MESSAGE } from '../collaboration.mjs';
import { DraftStore, RequestError } from '../drafts.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';
import { StoryStore } from '../stories.mjs';
import { client, enrolledContributor, jpeg, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Synthetic bytes only. The injected decoder stands in for the Python worker
// and returns a fixed inspection JPEG; the stored-photo rules are unchanged.
const REVIEW = jpeg(64, 48, 9);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Steps run in order, one per call; without a step the decoder returns REVIEW.
function fakePhotoDecoder(steps = []) {
  const calls = [];
  const decoder = async (call) => {
    calls.push(call);
    const step = steps.shift();
    return step ? step(call) : REVIEW;
  };
  decoder.calls = calls;
  return decoder;
}

const audioDecoder = async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });

async function workspace({ decoder = fakePhotoDecoder(), dataDir, ...options } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-contribution-photo-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, audioDecoder, contributionPhotoDecoder: decoder, ...options });
  return { app, dataDir, decoder, owner: client(app.base, app.cookie) };
}

const grant = () => ({
  provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

// A shareable ready scene from a memory holding one photo and one recording.
async function place(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant()], voice: grant() }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    draft, job, scene, voiceId: draft.voice.sourceId,
    photoRoute: `${scene}/contributions/photo`,
    photo: (id) => `${scene}/contributions/${id}/photo`,
    review: (id) => `${scene}/contributions/${id}/review`,
    withdraw: (id) => `${scene}/contributions/${id}/withdraw`,
  };
}

const facts = (permissions = {}) => ({
  origin: { kind: 'own', reference: 'Family album, page 3' },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: '2020-01-02T03:04:05Z', estimatedPeriod: 'late nineties' },
  permissions: { place: true, model: false, share: true, ...permissions },
});
const payload = (change = {}) => ({
  requestId: randomUUID(), text: 'The counter stood further back.\nThe door was on the left.',
  permissions: { place: true, model: false, share: true }, periodClaim: 'late nineties', photo: facts(), ...change,
});

function photoForm(body, bytes = SYNTHETIC_PHOTO, extra = []) {
  const form = new FormData();
  form.append('payload', typeof body === 'string' ? body : JSON.stringify(body));
  form.append('photo', new Blob([bytes], { type: 'image/heic' }), 'IMG_0001.HEIC');
  for (const [name, value] of extra) form.append(name, value);
  return form;
}
const submit = (session, scene, body, bytes, extra) => session.request(scene.photoRoute, { method: 'POST', body: photoForm(body, bytes, extra) });

const reviewBody = (change = {}) => ({
  requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: 'Matches the doorway.', conflict: 'unknown',
  transform: { offset: [0, 0, -0.5], yaw: 0 }, photoReviewed: true, ...change,
});

const jobDirOf = (dataDir, scene) => path.join(dataDir, 'reconstructions', scene.draft.id, scene.job.id);
const manifestOf = async (dataDir, scene) => JSON.parse(await readFile(path.join(jobDirOf(dataDir, scene), 'manifest.json'), 'utf8'));
const storedOf = async (dataDir, scene, id) => (await manifestOf(dataDir, scene)).collaboration.contributions.find((item) => item.id === id);
const bundleDir = (dataDir, scene, id) => path.join(jobDirOf(dataDir, scene), 'contributions', id);
const contributionNames = async (dataDir, scene) => (await readdir(path.join(jobDirOf(dataDir, scene), 'contributions')).catch(() => [])).sort();

async function contributorWithPhoto(app, owner, scene, change = {}) {
  const { session, principal } = await enrolledContributor(owner, app.base, scene.draft.id);
  const body = payload(change);
  const response = await submit(session, scene, body);
  assert.equal(response.status, 200);
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

describe('submitting writing with a photo', () => {
  it('stores the original and inspection copy privately, projects no private identifiers and replays exactly', async () => {
    const { app, owner, dataDir, decoder } = await workspace();
    try {
      const scene = await place(owner);
      const draftFile = path.join(dataDir, 'drafts', scene.draft.id, 'draft.json');
      const draftBefore = await readFile(draftFile);
      const { session, principal } = await enrolledContributor(owner, app.base, scene.draft.id, 'Synthetic Alex');
      const body = payload();
      const response = await submit(session, scene, body);
      assert.equal(response.status, 200);
      const projected = await response.json();
      assert.equal(projected.text, body.text, 'line breaks survive the multipart payload');
      assert.equal(projected.requestId, body.requestId);
      assert.deepEqual(projected.provider, { displayName: 'Synthetic Alex' });
      assert.deepEqual(projected.photo, {
        available: true, type: 'image/png', width: 40, height: 30, review: { width: 64, height: 48 },
        origin: body.photo.origin, dates: body.photo.dates, permissions: body.photo.permissions, receivedAt: projected.photo.receivedAt,
        url: `${scene.scene}/contributions/${projected.id}/photo`,
      });
      assert.equal(decoder.calls.length, 1);
      assert.deepEqual(decoder.calls[0].bytes, SYNTHETIC_PHOTO);

      const stored = await storedOf(dataDir, scene, projected.id);
      const { source, review } = stored.photo;
      assert.deepEqual(Object.keys(source).sort(), ['dates', 'height', 'id', 'kind', 'name', 'origin', 'parentSourceId', 'permissions', 'provider', 'receivedAt', 'role', 'sha256', 'size', 'type', 'width']);
      assert.deepEqual({ kind: source.kind, role: source.role, parentSourceId: source.parentSourceId, name: source.name, sha256: source.sha256, size: source.size },
        { kind: 'photo', role: 'original', parentSourceId: null, name: 'original.png', sha256: sha256(SYNTHETIC_PHOTO), size: SYNTHETIC_PHOTO.length });
      assert.deepEqual(source.provider, { principalId: principal.id, displayName: 'Synthetic Alex' });
      assert.deepEqual(review, { id: review.id, kind: 'photo', role: 'derived', parentSourceId: source.id, name: 'review.jpg', sha256: sha256(REVIEW), size: REVIEW.length, type: 'image/jpeg', width: 64, height: 48 });
      // Private identifiers, checksums and names never leave the server.
      const text = JSON.stringify(projected);
      for (const secret of [source.id, review.id, source.sha256, review.sha256, 'original.png', 'review.jpg', 'IMG_0001']) assert.ok(!text.includes(secret), secret);

      const dir = bundleDir(dataDir, scene, projected.id);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      for (const [name, bytes] of [['original.png', SYNTHETIC_PHOTO], ['review.jpg', REVIEW]]) {
        assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600);
        assert.deepEqual(await readFile(path.join(dir, name)), bytes);
      }
      assert.deepEqual(await readFile(draftFile), draftBefore, 'the owner draft and its sources are unchanged');

      assert.deepEqual(await (await submit(session, scene, body)).json(), projected);
      assert.equal(decoder.calls.length, 1, 'an exact replay never prepares again');
      assert.equal((await submit(session, scene, { ...body, text: 'Changed.' })).status, 409);
      assert.equal((await submit(session, scene, body, jpeg(8, 8, 1))).status, 409);
      assert.equal((await session.post(`${scene.scene}/contributions`, { requestId: body.requestId, text: body.text, permissions: body.permissions, periodClaim: body.periodClaim })).status, 409);

      const ownerView = await owner.json(`${scene.scene}/collaboration`);
      const ownerCopy = ownerView.contributions.find((item) => item.id === projected.id);
      assert.equal(ownerCopy.requestId, undefined, 'only the providing principal sees the request ID');
      assert.deepEqual(ownerCopy.photo, projected.photo);

      // The existing text-only request is unchanged.
      const plain = await session.post(`${scene.scene}/contributions`, { requestId: randomUUID(), text: 'Only words.', permissions: body.permissions, periodClaim: '' });
      assert.equal(plain.status, 200);
      assert.equal((await plain.json()).photo, null);
      assert.equal((await manifestOf(dataDir, scene)).collaboration.contributions.length, 2);
    } finally {
      await app.close();
    }
  });

  it('refuses malformed forms, foreign scope and unsupported files before preparing', async () => {
    const { app, owner, decoder } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const other = await place(owner);
      const { session: outsider } = await enrolledContributor(owner, app.base, other.draft.id);
      const body = payload();
      const raw = (form) => session.request(scene.photoRoute, { method: 'POST', body: form });
      const status = async (response) => {
        const value = response.status;
        assert.deepEqual(Object.keys(await response.json()), ['error']);
        return value;
      };
      const extra = photoForm(body, SYNTHETIC_PHOTO, [['note', 'x']]);
      const repeated = photoForm(body, SYNTHETIC_PHOTO, [['photo', new Blob([SYNTHETIC_PHOTO])]]);
      const missing = new FormData();
      missing.append('payload', JSON.stringify(body));
      const fileAsPayload = new FormData();
      fileAsPayload.append('payload', new Blob([JSON.stringify(body)]), 'payload.json');
      fileAsPayload.append('photo', new Blob([SYNTHETIC_PHOTO]), 'photo');
      for (const form of [extra, repeated, missing, fileAsPayload]) assert.equal(await status(await raw(form)), 400);
      for (const change of [
        { photo: { ...facts(), provider: 'Someone else' } }, { photo: { ...facts(), dates: { ...facts().dates, capturedOn: '2020-02-30' } } },
        { photo: { ...facts(), origin: { kind: 'stolen', reference: '' } } }, { photo: { ...facts(), permissions: { place: true, model: false } } },
        { text: ' ' }, { extra: true }, { requestId: ['not', 'a', 'string'] },
      ]) {
        assert.equal(await status(await submit(session, scene, payload(change))), 400, JSON.stringify(change).slice(0, 80));
      }
      assert.equal(await status(await submit(session, scene, 'not json')), 400);
      assert.equal(await status(await submit(session, scene, { ...body, text: 'x'.repeat(130 * 1024) })), 400);
      assert.equal(await status(await submit(session, scene, body, HEIC)), 415);
      assert.equal(await status(await submit(session, scene, body, Buffer.from('GIF89a'))), 415);
      assert.equal(await status(await submit(session, scene, body, Buffer.alloc(0))), 400);
      assert.equal(await status(await session.post(scene.photoRoute, body)), 415);
      assert.equal(await status(await submit(client(app.base), scene, body)), 401);
      assert.equal(await status(await submit(outsider, scene, body)), 403);
      assert.equal(await status(await session.request(scene.photoRoute, { method: 'POST', body: photoForm(body), headers: { origin: 'http://attacker.example' } })), 403);
      assert.equal(decoder.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('maps decoder exits to fixed messages and passes no secrets or stderr through', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-photo-decoder-'));
    tempDirs.push(dir);
    const fake = async (name, script) => {
      const file = path.join(dir, name);
      await writeFile(file, `#!/bin/sh\ncat >/dev/null\n${script}\n`, { mode: 0o700 });
      return pythonPhotoDecoder({ python: file, timeoutMs: 2000 });
    };
    const previous = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = 'synthetic-secret-value';
    try {
      const run = (decode) => decode({ bytes: SYNTHETIC_PHOTO, signal: new AbortController().signal });
      const refused = async (decode, status, message) => {
        const error = await run(decode).then(() => null, (caught) => caught);
        assert.ok(error instanceof RequestError, 'a fixed request error');
        assert.equal(error.status, status);
        if (message) assert.equal(error.message, message);
        assert.ok(!error.message.includes('stderr-detail'));
      };
      assert.deepEqual(await run(await fake('ok.sh', `[ -n "$MODEL_API_KEY" ] && exit 9\nprintf '\\377\\330\\377\\331'`)), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      await refused(await fake('input.sh', 'echo stderr-detail >&2\nexit 2'), 400, PHOTO_UNREADABLE);
      assert.match(PHOTO_UNREADABLE, /JPEG or an 8-bit PNG/);
      await refused(await fake('missing.sh', 'exit 3'), 503);
      await refused(await fake('cap.sh', 'exit 4'), 400);
      await refused(await fake('other.sh', 'echo stderr-detail >&2\nexit 1'), 503, PHOTO_PREPARE_FAILED);
      await refused(await fake('large.sh', 'head -c 3000000 /dev/zero'), 503, PHOTO_PREPARE_FAILED);
      await refused(await fake('slow.sh', 'sleep 5'), 503, PHOTO_PREPARE_FAILED);
    } finally {
      if (previous === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = previous;
    }
  });
});

// A child-process double whose kill can throw or fail and which closes only when told.
function fakeChild(kill) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.kills = 0;
  child.kill = () => {
    child.kills += 1;
    return kill();
  };
  return child;
}

describe('decoder process termination', () => {
  const settledWithin = (promise, ms = 500) => Promise.race([
    promise.then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);

  it('settles once on output overflow or the time limit even when kill throws or fails and no close follows', async () => {
    const cases = [
      ['stdout overflow, kill throws', () => { throw new Error('kill failed'); }, (child) => child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1))],
      ['stderr overflow, kill returns false', () => false, (child) => child.stderr.emit('data', Buffer.alloc(4 * 1024 + 1))],
      ['time limit, kill returns false', () => false, () => {}],
    ];
    for (const [label, kill, act] of cases) {
      const child = fakeChild(kill);
      const decode = pythonPhotoDecoder({ python: 'unused', timeoutMs: 50, spawnProcess: () => child });
      const pending = decode({ bytes: SYNTHETIC_PHOTO, signal: new AbortController().signal });
      act(child);
      const outcome = await settledWithin(pending);
      assert.ok(outcome instanceof RequestError, label);
      assert.deepEqual([outcome.status, outcome.message], [503, PHOTO_PREPARE_FAILED], label);
      assert.equal(child.kills, 1, label);
      // Late output and a late successful exit change nothing.
      child.stdout.emit('data', REVIEW);
      child.emit('close', 0);
      assert.equal(await settledWithin(pending), outcome, label);
    }
  });

  it('settles on abort without a close, and ignores output after it', async () => {
    const child = fakeChild(() => false);
    const controller = new AbortController();
    const pending = pythonPhotoDecoder({ python: 'unused', spawnProcess: () => child })({ bytes: SYNTHETIC_PHOTO, signal: controller.signal });
    controller.abort();
    const outcome = await settledWithin(pending);
    assert.ok(outcome instanceof RequestError);
    assert.equal(outcome.status, 503);
    child.stdout.emit('data', REVIEW);
    child.emit('close', 0);
    assert.equal(await settledWithin(pending), outcome);
    const success = fakeChild(() => true);
    const ok = pythonPhotoDecoder({ python: 'unused', spawnProcess: () => success })({ bytes: SYNTHETIC_PHOTO, signal: new AbortController().signal });
    success.stdout.emit('data', REVIEW);
    success.emit('close', 0);
    assert.deepEqual(await ok, REVIEW);
    assert.equal(success.kills, 0);
  });
});

describe('the inspection photo route', () => {
  it('serves the stripped copy to the owner and its provider only, and stops after withdrawal', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await contributorWithPhoto(app, owner, scene);
      const { session: peer } = await enrolledContributor(owner, app.base, scene.draft.id, 'Synthetic peer');
      const other = await place(owner);
      const { session: outsider } = await enrolledContributor(owner, app.base, other.draft.id);
      const route = scene.photo(contribution.id);
      for (const reader of [owner, session]) {
        const response = await reader.request(route);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/jpeg');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), REVIEW);
      }
      assert.equal((await owner.request(route, { method: 'HEAD' })).status, 200);
      const ranged = await owner.request(route, { headers: { range: 'bytes=0-3' } });
      assert.equal(ranged.status, 206);
      assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), REVIEW.subarray(0, 4));
      assert.equal((await peer.request(route)).status, 404, 'another contributor cannot learn it exists');
      assert.equal((await outsider.request(route)).status, 403);
      assert.equal((await client(app.base).request(route)).status, 401);
      assert.equal((await owner.request(`${scene.scene}/contributions/not-an-id/photo`)).status, 404);
      assert.equal((await owner.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
      const plain = await (await session.post(`${scene.scene}/contributions`, { requestId: randomUUID(), text: 'Words.', permissions: { place: true, model: false, share: false }, periodClaim: '' })).json();
      assert.equal((await owner.request(scene.photo(plain.id))).status, 404);

      assert.equal((await session.post(scene.withdraw(contribution.id), { requestId: randomUUID() })).status, 200);
      for (const reader of [owner, session]) assert.equal((await reader.request(route)).status, 404);
      assert.equal((await owner.request(route, { method: 'HEAD' })).status, 404);
      const withdrawn = (await session.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === contribution.id);
      assert.deepEqual(withdrawn.photo, {
        ...contribution.photo, available: false, url: null, origin: { kind: 'own', reference: '' }, dates: null,
      });
      assert.equal(withdrawn.text, null);
    } finally {
      await app.close();
    }
  });
});

describe('grants and review of a photo bundle', () => {
  it('needs both grants for every use and an explicit photo review for geometry', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const placeless = await contributorWithPhoto(app, owner, scene, { photo: facts({ place: false }) });
      assert.equal((await owner.post(scene.review(placeless.contribution.id), reviewBody())).status, 403);

      const { contribution, session } = await contributorWithPhoto(app, owner, scene, {
        permissions: { place: true, model: true, share: true }, photo: facts({ model: false, share: false }),
      });
      const target = scene.review(contribution.id);
      const { photoReviewed, ...withoutAck } = reviewBody();
      for (const body of [withoutAck, reviewBody({ photoReviewed: false }), reviewBody({ photoReviewed: 'yes' })]) {
        assert.equal((await owner.post(target, body)).status, 400);
      }
      assert.equal((await owner.post(target, reviewBody({ decision: 'hold', transform: null }))).status, 400, 'no acknowledgment outside geometry');
      const plain = await (await session.post(`${scene.scene}/contributions`, { requestId: randomUUID(), text: 'Words.', permissions: { place: true, model: true, share: true }, periodClaim: '' })).json();
      assert.equal((await owner.post(scene.review(plain.id), reviewBody())).status, 400, 'no acknowledgment for writing alone');

      const adopted = await owner.post(target, reviewBody());
      assert.equal(adopted.status, 200);
      const stored = await storedOf(dataDir, scene, contribution.id);
      assert.equal(stored.review.photoReviewed, true);
      const history = await owner.json(`${scene.scene}/history`);
      assert.deepEqual(history.map(({ version, dependencies }) => ({ version, dependencies })), [
        { version: 1, dependencies: [] }, { version: 2, dependencies: [contribution.id] },
      ]);
      const job = await owner.json(scene.scene);
      assert.equal(job.usageBlocked, false);
      assert.equal(job.modelBlocked, true, 'the photo was not shared for model processing');

      // The photo is not displayed, yet its share grant is still required.
      const denied = await owner.post(`${scene.scene}/shares/previews`, previewBody([versionView(2)]));
      assert.equal(denied.status, 403);
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, previewBody([versionView(1)]))).status, 201);
    } finally {
      await app.close();
    }
  });

  it('keeps a story on a photo-backed version from being shared without the photo share grant', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution } = await contributorWithPhoto(app, owner, scene, { photo: facts({ share: false }) });
      assert.equal((await owner.post(scene.review(contribution.id), reviewBody())).status, 200);
      const created = await owner.post(`${scene.scene}/stories`, {
        requestId: randomUUID(), voiceSourceId: scene.voiceId, view: { kind: 'version', version: 2, variantId: null, eraRevision: null },
        title: 'Synthetic tone', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic test tone; no speech.' }], captionConfirmed: true,
      });
      assert.equal(created.status, 201);
      const story = await created.json();
      const reconstructions = new ReconstructionStore({ dataDir, drafts: new DraftStore(dataDir), runner: sceneRunner });
      const stories = new StoryStore({ reconstructions, audioDecoder });
      const view = [{ id: randomUUID(), kind: 'version', version: 2, variantId: null, eraRevision: null }];
      assert.equal(await stories.forShare(await reconstructions.readManifest(scene.draft.id, scene.job.id), story.id, view), null);
      const manifest = await reconstructions.readManifest(scene.draft.id, scene.job.id);
      const granted = { ...manifest, collaboration: { ...manifest.collaboration, contributions: manifest.collaboration.contributions.map((item) => (item.id === contribution.id
        ? { ...item, photo: { ...item.photo, source: { ...item.photo.source, permissions: { place: true, model: false, share: true } } } } : item)) } };
      // A changed record is no longer covered by the attestation, so it is refused too.
      assert.equal(await stories.forShare(granted, story.id, view), null);
    } finally {
      await app.close();
    }
  });
});

describe('stored photo integrity', () => {
  it('blocks dependent uses when files are missing, tampered or unreadable, without claiming withdrawal', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution, session } = await contributorWithPhoto(app, owner, scene);
      assert.equal((await owner.post(scene.review(contribution.id), reviewBody())).status, 200);
      const dir = bundleDir(dataDir, scene, contribution.id);
      const reviewFile = path.join(dir, 'review.jpg');
      const originalFile = path.join(dir, 'original.png');
      const texture = `${scene.scene}/assets/texture.jpg`;
      assert.equal((await owner.request(texture)).status, 200);

      const blocked = async (label) => {
        const job = await owner.json(scene.scene);
        assert.equal(job.usageBlocked, true, label);
        assert.equal(job.blockedReason, 'contribution', label);
        const asset = await owner.request(texture);
        assert.equal(asset.status, 409, label);
        assert.equal((await asset.json()).error, UNAVAILABLE_MESSAGE, label);
        assert.equal((await owner.request(scene.photo(contribution.id))).status, 409, label);
        const own = (await session.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === contribution.id);
        assert.deepEqual([own.status, own.withdrawnAt, own.photo.available, own.photo.url], ['adopted', null, false, null], label);
        const history = await owner.json(`${scene.scene}/history`);
        assert.deepEqual(history.map((entry) => entry.blocked), [false, true], label);
        const edit = await owner.post(`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 2, offset: [0, 0, 0], yaw: 0 });
        assert.equal(edit.status, 409, label);
        assert.equal((await edit.json()).error, UNAVAILABLE_MESSAGE, label);
      };
      const usable = async (label) => {
        assert.equal((await owner.json(scene.scene)).usageBlocked, false, label);
        assert.equal((await owner.request(texture)).status, 200, label);
        assert.equal((await owner.request(scene.photo(contribution.id))).status, 200, label);
      };

      const tampered = Buffer.from(REVIEW);
      tampered[tampered.length - 3] ^= 0xff;
      await writeFile(reviewFile, tampered);
      await blocked('same-size tampered inspection copy');
      await writeFile(reviewFile, REVIEW);
      await usable('repaired inspection copy');

      await rename(originalFile, `${originalFile}.moved`);
      await blocked('missing original');
      await rename(`${originalFile}.moved`, originalFile);
      await usable('restored original');

      await chmod(originalFile, 0o000);
      try {
        await blocked('unreadable original');
      } finally {
        await chmod(originalFile, 0o600);
      }
      await usable('readable again');

      // An independent earlier version can still be restored while blocked.
      await writeFile(reviewFile, tampered);
      const undo = await owner.post(`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 2, targetVersion: 1 });
      assert.equal(undo.status, 200);
      assert.equal((await owner.json(scene.scene)).usageBlocked, false);
      const back = await owner.post(`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 3, targetVersion: 2 });
      assert.equal(back.status, 409);
      assert.match((await back.json()).error, /not available right now/);
    } finally {
      await app.close();
    }
  });
});

// A scripted stand-in for the hosted model: one translation plan per call.
function fakeModel() {
  return async (call) => ({
    model: 'synthetic-model', responseId: `resp_${randomUUID()}`, usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 }, ok: true,
    plan: {
      action: 'translate', targetId: 'selected-foreground', sourceId: call.sourceId, baseVersion: call.baseVersion,
      delta: [0.25, 0, 0], yawDelta: null, anchor: null, question: null, reason: 'Synthetic plan.',
    },
  });
}

describe('receipt replays', () => {
  it('return saved geometry only while that version can still be used, for every receipt kind', async () => {
    const { app, owner, dataDir } = await workspace({ proposalModel: fakeModel(), prepareModelImage: async () => jpeg(20, 15, 3) });
    try {
      const scene = await place(owner);
      const { contribution, session } = await contributorWithPhoto(app, owner, scene, {
        permissions: { place: true, model: true, share: true }, photo: facts({ model: true }),
      });
      const reviewRequest = reviewBody();
      const adopted = await owner.post(scene.review(contribution.id), reviewRequest);
      assert.equal(adopted.status, 200);
      assert.equal((await adopted.json()).edit.version, 2);

      const proposed = await owner.post(`${scene.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'A little to the right.', consent: true });
      assert.equal(proposed.status, 202);
      const { id: proposalId } = await proposed.json();
      for (let attempt = 0; attempt < 300 && (await owner.json(`${scene.scene}/proposals/${proposalId}`)).status !== 'ready'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const requests = {
        apply: [`${scene.scene}/proposals/${proposalId}/apply`, { requestId: randomUUID(), baseVersion: 2, frontConfirmed: false }],
        edit: [`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 3, offset: [0.1, 0, 0], yaw: 0 }],
        undo: [`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 4, targetVersion: 2 }],
        // Restores version 1, which depends on nothing: never blocked by the bundle.
        independent: [`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 5, targetVersion: 1 }],
        // Leaves the current version depending on the bundle again.
        current: [`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 6, targetVersion: 2 }],
      };
      const saved = {};
      for (const [kind, [route, body]] of Object.entries(requests)) {
        const response = await owner.post(route, body);
        assert.equal(response.status, 200, kind);
        const value = await response.json();
        saved[kind] = kind === 'apply' ? value.edit : value;
      }
      assert.deepEqual(Object.values(saved).map((edit) => edit.version), [3, 4, 5, 6, 7]);

      const originalFile = path.join(bundleDir(dataDir, scene, contribution.id), 'original.png');
      const editsBefore = (await manifestOf(dataDir, scene)).edits;
      const replay = async (kind) => owner.post(...requests[kind]);
      const usable = async (label) => {
        for (const kind of Object.keys(requests)) {
          const response = await replay(kind);
          assert.equal(response.status, 200, `${label}: ${kind}`);
          const value = await response.json();
          assert.deepEqual(kind === 'apply' ? value.edit : value, saved[kind], `${label}: ${kind}`);
        }
        assert.equal((await (await owner.post(scene.review(contribution.id), reviewRequest)).json()).edit.version, 2, label);
      };
      const refused = async (label, message) => {
        for (const kind of ['apply', 'edit', 'undo', 'current']) {
          const response = await replay(kind);
          assert.equal(response.status, 409, `${label}: ${kind}`);
          assert.deepEqual(await response.json(), { error: message }, `${label}: ${kind}`);
        }
        const review = await owner.post(scene.review(contribution.id), reviewRequest);
        assert.equal(review.status, 200, label);
        const value = await review.json();
        assert.equal(value.edit, null, `${label}: no adopted geometry`);
        assert.equal(value.contribution.id, contribution.id, label);
        const independent = await replay('independent');
        assert.equal(independent.status, 200, `${label}: an unaffected receipt still replays while the current version is blocked`);
        assert.deepEqual(await independent.json(), saved.independent, label);
        assert.deepEqual((await manifestOf(dataDir, scene)).edits, editsBefore, `${label}: history is never rewritten`);
      };

      await usable('available');
      const reviewFile = path.join(bundleDir(dataDir, scene, contribution.id), 'review.jpg');
      const tampered = Buffer.from(REVIEW);
      tampered[tampered.length - 3] ^= 0xff;
      await writeFile(reviewFile, tampered);
      await refused('tampered photo', UNAVAILABLE_MESSAGE);
      await writeFile(reviewFile, REVIEW);
      await usable('repaired photo');

      assert.equal((await session.post(scene.withdraw(contribution.id), { requestId: randomUUID() })).status, 200);
      await refused('withdrawn bundle', BLOCKED_MESSAGE);
      assert.deepEqual(await readFile(originalFile), SYNTHETIC_PHOTO, 'the original is never rewritten');
    } finally {
      await app.close();
    }
  });
});

describe('contributor photos in shared views', () => {
  it('shows only selected dependency photos, serves pinned stripped bytes and suspends on tamper or withdrawal', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution, session } = await contributorWithPhoto(app, owner, scene);
      assert.equal((await owner.post(scene.review(contribution.id), reviewBody())).status, 200);
      const v1 = versionView(1);
      const v2 = versionView(2);
      const previews = `${scene.scene}/shares/previews`;
      assert.equal((await owner.post(previews, previewBody([v1], { evidencePhotoIds: [contribution.id] }))).status, 400);
      assert.equal((await owner.post(previews, previewBody([v1], { contributionIds: [contribution.id], evidencePhotoIds: [contribution.id] }))).status, 400, 'a quote alone is not enough');
      assert.equal((await owner.post(previews, previewBody([v2], { evidencePhotoIds: [contribution.id, contribution.id] }))).status, 400);

      const created = await owner.post(previews, previewBody([v2, v1], { evidencePhotoIds: [contribution.id] }));
      assert.equal(created.status, 201);
      const preview = await created.json();
      assert.deepEqual(preview.publicView.contributorPhotos, [{
        id: 'e1', providerLabel: 'Synthetic contributor', label: 'Photo supplied by a contributor. Not automatically matched; not verified history.',
        viewIds: [v2.id], asset: { viewId: 'evidence', name: '1.jpg' }, width: 64, height: 48,
      }]);
      const stored = await storedOf(dataDir, scene, contribution.id);
      const shown = JSON.stringify(preview.publicView);
      for (const secret of [contribution.id, stored.photo.source.id, stored.photo.review.sha256, 'Family album', '2020-01-02', stored.principalId]) assert.ok(!shown.includes(secret), secret);
      const previewAsset = await owner.request(`${previews}/${preview.id}/assets/evidence/1.jpg`);
      assert.equal(previewAsset.status, 200);
      assert.deepEqual(Buffer.from(await previewAsset.arrayBuffer()), REVIEW);
      assert.equal((await owner.request(`${previews}/${preview.id}/assets/evidence/2.jpg`)).status, 404);
      assert.equal((await owner.request(`${previews}/${preview.id}/assets/evidence/original.png`)).status, 404);

      const token = await issue(owner, scene, preview);
      const plain = await issue(owner, scene, await (await owner.post(previews, previewBody([v1]))).json());
      const manifest = await (await visit(app.base, token)).json();
      assert.deepEqual(manifest.contributorPhotos, preview.publicView.contributorPhotos);
      assert.equal((await (await visit(app.base, plain)).json()).contributorPhotos, undefined);
      const asset = await visit(app.base, token, '/api/visit/assets/evidence/1.jpg');
      assert.equal(asset.status, 200);
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), REVIEW);
      assert.equal((await visit(app.base, token, '/api/visit/assets/evidence/1.jpg', { method: 'HEAD' })).status, 200);
      assert.equal((await visit(app.base, token, '/api/visit/assets/evidence/1.jpg', { headers: { range: 'bytes=0-1' } })).status, 206);

      const reviewFile = path.join(bundleDir(dataDir, scene, contribution.id), 'review.jpg');
      const tampered = Buffer.from(REVIEW);
      tampered[5] ^= 0xff;
      await writeFile(reviewFile, tampered);
      assert.equal((await visit(app.base, token)).status, 404);
      assert.equal((await visit(app.base, token, '/api/visit/assets/evidence/1.jpg')).status, 404);
      assert.equal((await visit(app.base, plain)).status, 200, 'an independent snapshot stays available');
      const listed = (await owner.json(`${scene.scene}/shares`)).find((item) => item.status === 'suspended');
      assert.ok(!/withdrawn/.test(listed.reason));
      await writeFile(reviewFile, REVIEW);
      assert.equal((await visit(app.base, token)).status, 200);

      assert.equal((await session.post(scene.withdraw(contribution.id), { requestId: randomUUID() })).status, 200);
      assert.equal((await visit(app.base, token)).status, 404);
      assert.equal((await visit(app.base, token, '/api/visit/assets/evidence/1.jpg', { method: 'HEAD' })).status, 404);
      assert.equal((await visit(app.base, plain)).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('preparation, retries and publication', () => {
  it('joins an identical in-flight retry, refuses changed or other work while busy, and replays before busy', async () => {
    const gate = deferred();
    const second = deferred();
    const decoder = fakePhotoDecoder([async () => {
      await gate.promise;
      return REVIEW;
    }, async () => {
      await second.promise;
      return REVIEW;
    }]);
    const { app, owner, dataDir } = await workspace({ decoder });
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const body = payload();
      const first = submit(session, scene, body);
      while (decoder.calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const joined = submit(session, scene, body);
      const changed = await submit(session, scene, { ...body, text: 'Changed while running.' });
      assert.equal(changed.status, 409);
      const busy = await submit(session, scene, payload());
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), { error: PHOTO_BUSY });
      // Another principal never joins this caller's work, even with the same request ID.
      assert.equal((await submit(owner, scene, body)).status, 409);
      gate.resolve();
      const [a, b] = await Promise.all([first, joined]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      const published = await a.json();
      assert.deepEqual(await b.json(), published);
      assert.equal(decoder.calls.length, 1);

      const later = submit(session, scene, payload());
      while (decoder.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      const replay = await submit(session, scene, body);
      assert.equal(replay.status, 200, 'a published exact replay answers before the busy check');
      assert.deepEqual(await replay.json(), published);
      second.resolve();
      assert.equal((await later).status, 200);
      assert.equal((await manifestOf(dataDir, scene)).collaboration.contributions.length, 2);
      assert.equal((await contributionNames(dataDir, scene)).length, 2);
    } finally {
      gate.resolve();
      second.resolve();
      await app.close();
    }
  });

  it('publishes nothing when preparation or the manifest write fails, and recovery sweeps unreferenced folders', async () => {
    const decoder = fakePhotoDecoder([
      async () => {
        throw new RequestError(400, PHOTO_UNREADABLE);
      },
      async () => Buffer.from('not a jpeg'),
    ]);
    const { app, owner, dataDir } = await workspace({ decoder });
    let restarted = null;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const unreadable = await submit(session, scene, payload());
      assert.equal(unreadable.status, 400);
      assert.equal((await unreadable.json()).error, PHOTO_UNREADABLE);
      assert.equal((await submit(session, scene, payload())).status, 503);
      assert.deepEqual(await contributionNames(dataDir, scene), []);

      const kept = await contributorWithPhoto(app, owner, scene);
      const jobDir = jobDirOf(dataDir, scene);
      await chmod(jobDir, 0o500);
      let failed;
      try {
        failed = await submit(session, scene, payload());
      } finally {
        await chmod(jobDir, 0o700);
      }
      assert.equal(failed.status, 500);
      assert.deepEqual(await contributionNames(dataDir, scene), [kept.contribution.id], 'the renamed folder of an unpublished bundle is removed');

      // A crash after the rename but before the manifest write leaves these.
      const parent = path.join(jobDir, 'contributions');
      await mkdir(path.join(parent, `.staging-${randomUUID()}-${randomUUID()}`));
      await mkdir(path.join(parent, randomUUID()));
      await app.close();
      ({ app: restarted } = await workspace({ dataDir }));
      const restartedOwner = client(restarted.base, restarted.cookie);
      assert.equal((await restartedOwner.json(`${scene.scene}/collaboration`)).contributions.length, 1);
      assert.deepEqual(await contributionNames(dataDir, scene), [kept.contribution.id]);
      assert.equal((await restartedOwner.request(scene.photo(kept.contribution.id))).status, 200);
    } finally {
      if (restarted) await restarted.close();
      else await app.close();
    }
  });

  it('refuses at the commit boundary when the server closes during the folder rename', async () => {
    const { app, owner, dataDir } = await workspace();
    let restarted = null;
    // Holds the real rename of the staged folder until released.
    const original = fs.promises.rename;
    const reached = deferred();
    const release = deferred();
    fs.promises.rename = async (from, to) => {
      if (String(from).includes(`${path.sep}.staging-`)) {
        reached.resolve();
        await release.promise;
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const pending = submit(session, scene, payload()).then((response) => response.status, () => 'closed');
      await reached.promise;
      const closing = app.close();
      release.resolve();
      await closing;
      assert.ok([503, 'closed'].includes(await pending));
      ({ app: restarted } = await workspace({ dataDir }));
      const manifest = await manifestOf(dataDir, scene);
      assert.equal(manifest.collaboration, undefined, 'no contribution or receipt was published');
      assert.deepEqual(await contributionNames(dataDir, scene), [], 'the renamed folder was removed');
    } finally {
      release.resolve();
      fs.promises.rename = original;
      syncBuiltinESMExports();
      if (restarted) await restarted.close();
    }
  });

  it('aborts preparation on server close and publishes nothing', async () => {
    const started = deferred();
    const decoder = fakePhotoDecoder([({ signal }) => new Promise((resolve, reject) => {
      started.resolve();
      signal.addEventListener('abort', () => reject(new RequestError(503, 'The app is shutting down. Try again later.')));
    })]);
    const { app, owner, dataDir } = await workspace({ decoder });
    let restarted = null;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const pending = submit(session, scene, payload()).then((response) => response.status, () => 'closed');
      await started.promise;
      await app.close();
      assert.ok([503, 'closed'].includes(await pending));
      assert.equal(decoder.calls[0].signal.aborted, true);
      ({ app: restarted } = await workspace({ dataDir }));
      assert.equal((await manifestOf(dataDir, scene)).collaboration, undefined);
      assert.deepEqual(await contributionNames(dataDir, scene), []);
    } finally {
      if (restarted) await restarted.close();
    }
  });
});
