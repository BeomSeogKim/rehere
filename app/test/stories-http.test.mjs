import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DraftStore } from '../drafts.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';
import { StoryStore } from '../stories.mjs';
import { client, enrolledContributor, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Synthetic container bytes; the injected decoder stands in for ffmpeg here.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const TONE_CAPTION = 'Synthetic test tone; no speech.';
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A decoder double: one second of silence unless a step says otherwise.
function fakeDecoder(steps = []) {
  const calls = [];
  const decoder = async (call) => {
    calls.push(call);
    const step = steps.shift();
    if (step) {
      const outcome = await step(call);
      if (outcome) return outcome;
    }
    return { pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 };
  };
  decoder.calls = calls;
  return decoder;
}
const decodeError = (code) => Object.assign(new Error('decode'), { code });

const grant = (permissions = {}) => ({
  provider: 'Synthetic provider', origin: { kind: 'public', reference: '' },
  permissions: { place: true, model: true, share: true, ...permissions },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

async function workspace({ audioDecoder = fakeDecoder(), dataDir } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-story-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, audioDecoder });
  return { app, dataDir, decoder: audioDecoder, owner: client(app.base, app.cookie) };
}

// A ready scene from a memory holding one photo and one recording.
async function sceneWithVoice(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant()], voice: grant() }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return { draft, job, scene, stories: `${scene}/stories`, voiceId: draft.voice.sourceId, photoId: draft.photos[0].sourceId };
}

const versionView = (version) => ({ kind: 'version', version, variantId: null, eraRevision: null });
const storyBody = (place, change = {}) => ({
  requestId: randomUUID(), voiceSourceId: place.voiceId, view: versionView(1), title: 'Synthetic tone at the counter',
  cues: [{ startMs: 0, endMs: 900, text: TONE_CAPTION }], captionConfirmed: true, ...change,
});
const policyOf = (place, sourceId) => `/api/drafts/${place.draft.id}/sources/${sourceId}/policy`;
async function restrict(owner, place, sourceId, permissions, stopUse = false) {
  const { revision } = await owner.json(policyOf(place, sourceId));
  const response = await owner.post(policyOf(place, sourceId), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse });
  assert.equal(response.status, 200);
  return response.json();
}

const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;
async function share(owner, place, views, storyIds) {
  const preview = await owner.post(`${place.scene}/shares/previews`, {
    requestId: randomUUID(), title: 'Synthetic place', views, startViewId: views[0].id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, storyIds,
  });
  if (preview.status !== 201) return { status: preview.status, error: await preview.json() };
  const body = await preview.json();
  const token = visitToken();
  const issued = await owner.post(`${place.scene}/shares`, { requestId: randomUUID(), previewId: body.id, previewDigest: body.digest, token, consent: true });
  assert.equal(issued.status, 201);
  return { status: 201, preview: body, token };
}
const visit = (base, token, route = '/api/visit', init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

async function stagingFiles(dataDir, place) {
  return readdir(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'story-staging')).catch(() => []);
}

describe('story routes', () => {
  it('are owner-only and check identity before IDs or bodies', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const { session: contributor } = await enrolledContributor(owner, app.base, place.draft.id);
      const id = randomUUID();
      for (const [method, route] of [['GET', place.stories], ['POST', place.stories], ['GET', `${place.stories}/${id}`], ['GET', `${place.stories}/${id}/audio.wav`],
        ['HEAD', `${place.stories}/${id}/audio.wav`], ['POST', `${place.stories}/${id}/withdraw`], ['GET', `/api/drafts/x/reconstructions/y/stories`]]) {
        const init = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method };
        assert.equal((await client(app.base).request(route, init)).status, 401, `${method} ${route}`);
        assert.equal((await contributor.request(route, init)).status, 403, `${method} ${route}`);
      }
      assert.equal((await owner.request(`${place.stories}/not-an-id`)).status, 404);
      assert.equal((await owner.request(`${place.stories}/${id}`)).status, 404);
      assert.equal((await owner.post(place.stories, storyBody(place), { origin: 'http://attacker.example' })).status, 403);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed requests and missing caption confirmation without decoding', async () => {
    const { app, owner, decoder } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const cue = (startMs, endMs, text = TONE_CAPTION) => ({ startMs, endMs, text });
      for (const change of [
        { extra: true }, { view: { kind: 'version', version: 1, variantId: null } }, { view: { ...versionView(1), eraRevision: 0 } },
        { view: { kind: 'variant', version: null, variantId: randomUUID(), eraRevision: null } }, { title: ' ' }, { title: 't'.repeat(121) },
        { cues: [] }, { cues: [cue(0, 0)] }, { cues: [cue(0, 500), cue(400, 900)] }, { cues: [cue(500, 900), cue(0, 400)] },
        { cues: [cue(0, 500, ' ')] }, { cues: [cue(0, 500, 'bell\u0007')] }, { cues: [cue(0.5, 500)] }, { cues: Array.from({ length: 201 }, (_, i) => cue(i * 2, i * 2 + 1)) },
        { voiceSourceId: 'nope' }, { captionConfirmed: false },
      ]) {
        const response = await owner.post(place.stories, storyBody(place, change));
        assert.equal(response.status, 400, JSON.stringify(change).slice(0, 60));
      }
      assert.equal((await owner.post(place.stories, storyBody(place, { voiceSourceId: place.photoId }))).status, 404);
      assert.equal((await owner.post(place.stories, storyBody(place, { voiceSourceId: randomUUID() }))).status, 404);
      assert.equal((await owner.post(place.stories, storyBody(place, { view: versionView(9) }))).status, 404);
      assert.equal(decoder.calls.length, 0);
      // Captions up to the limit fit the story request cap even as non-ASCII text.
      const wide = Array.from({ length: 10 }, (_, i) => cue(i * 90, i * 90 + 80, '\uAC00'.repeat(2000)));
      const big = storyBody(place, { cues: wide });
      assert.ok(Buffer.byteLength(JSON.stringify(big)) > 16 * 1024);
      const accepted = await owner.post(place.stories, big);
      assert.equal(accepted.status, 201);
      assert.equal((await owner.post(place.stories, 'x'.repeat(256 * 1024 + 1))).status, 413);
    } finally {
      await app.close();
    }
  });
});

describe('creating a story', () => {
  it('decodes the whole recording once, publishes a WAV copy beside the scene and replays the same story', async () => {
    const { app, owner, dataDir, decoder } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const voiceFile = path.join(dataDir, 'drafts', place.draft.id, place.draft.voice.name);
      const before = sha256(await readFile(voiceFile));
      const body = storyBody(place);
      const created = await owner.post(place.stories, body);
      assert.equal(created.status, 201);
      const story = await created.json();
      assert.deepEqual(Object.keys(story).sort(), ['audio', 'available', 'blockedReason', 'captionAuthor', 'createdAt', 'cues', 'durationMs', 'error', 'id', 'status', 'target', 'title', 'view', 'voice', 'withdrawnAt']);
      assert.equal(story.status, 'ready');
      assert.equal(story.available, true);
      assert.deepEqual(story.target, { id: 'selected-foreground', label: 'Selected foreground object' });
      assert.deepEqual(story.view, { kind: 'version', version: 1, variantId: null, eraRevision: null, label: 'Saved version 1', era: null });
      assert.deepEqual(story.voice, { sourceId: place.voiceId, provider: 'Synthetic provider' });
      assert.equal(story.captionAuthor.displayName, 'Synthetic owner');
      assert.deepEqual(story.audio, { type: 'audio/wav', size: 44 + 32_000 });
      assert.equal(story.durationMs, 1000);

      assert.equal(decoder.calls.length, 1);
      assert.deepEqual(decoder.calls[0].bytes, WEBM);
      assert.equal(decoder.calls[0].type, 'audio/webm');

      const audio = await owner.request(`${place.stories}/${story.id}/audio.wav`);
      assert.equal(audio.status, 200);
      assert.equal(audio.headers.get('content-type'), 'audio/wav');
      assert.equal(audio.headers.get('cache-control'), 'no-store');
      const wav = Buffer.from(await audio.arrayBuffer());
      assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
      assert.equal(wav.length, 44 + 32_000);
      assert.ok((await readdir(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'stories'))).includes(`${story.id}.wav`));
      const ranged = await owner.request(`${place.stories}/${story.id}/audio.wav`, { headers: { range: 'bytes=0-3' } });
      assert.equal(ranged.status, 206);
      assert.equal(await ranged.text(), 'RIFF');
      assert.equal((await owner.request(`${place.stories}/${story.id}/audio.wav`, { method: 'HEAD' })).status, 200);

      const replay = await owner.post(place.stories, body);
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), story);
      assert.equal(decoder.calls.length, 1, 'a replay never decodes again');
      assert.equal((await owner.post(place.stories, { ...body, title: 'Changed' })).status, 409);
      assert.deepEqual((await owner.json(place.stories)).stories.map((item) => item.id), [story.id]);
      assert.equal('stories' in (await owner.json(place.scene)), false, 'the scene manifest never carries story records');
      assert.equal(sha256(await readFile(voiceFile)), before);
      assert.deepEqual(await stagingFiles(dataDir, place), []);
    } finally {
      await app.close();
    }
  });

  it('records nothing when decoding fails or a caption runs past the end', async () => {
    const decoder = fakeDecoder([
      async () => {
        throw decodeError('unavailable');
      },
      async () => {
        throw decodeError('too-long');
      },
      async () => {
        throw new Error('raw ffmpeg detail /secret/path');
      },
    ]);
    const { app, owner, dataDir } = await workspace({ audioDecoder: decoder });
    try {
      const place = await sceneWithVoice(owner);
      const unavailable = await owner.post(place.stories, storyBody(place));
      assert.equal(unavailable.status, 503);
      assert.match((await unavailable.json()).error, /decoder is not set up/);
      assert.equal((await owner.post(place.stories, storyBody(place))).status, 400);
      const unknown = await owner.post(place.stories, storyBody(place));
      assert.equal(unknown.status, 400);
      assert.ok(!(await unknown.text()).includes('secret'));
      const late = await owner.post(place.stories, storyBody(place, { cues: [{ startMs: 0, endMs: 1500, text: TONE_CAPTION }] }));
      assert.equal(late.status, 400);
      assert.match((await late.json()).error, /after the recording ends/);
      assert.deepEqual((await owner.json(place.stories)).stories, []);
      assert.deepEqual(await stagingFiles(dataDir, place), []);
    } finally {
      await app.close();
    }
  });

  it('allows one decode at a time and answers a pending replay as busy until it settles', async () => {
    const gate = deferred();
    const started = deferred();
    const { app, owner } = await workspace({ audioDecoder: fakeDecoder([async () => {
      started.resolve();
      await gate.promise;
    }]) });
    try {
      const place = await sceneWithVoice(owner);
      const body = storyBody(place);
      const first = owner.post(place.stories, body);
      await started.promise;
      assert.equal((await owner.post(place.stories, storyBody(place))).status, 409);
      assert.equal((await owner.post(place.stories, body)).status, 409, 'same request while pending');
      gate.resolve();
      assert.equal((await first).status, 201);
      assert.equal((await owner.post(place.stories, body)).status, 201);
      assert.equal((await owner.json(place.stories)).stories.length, 1);
    } finally {
      gate.resolve();
      await app.close();
    }
  });
});

describe('story context and restrictions', () => {
  it('requires the reviewed era revision and never publishes after the era changes during decoding', async () => {
    const gate = deferred();
    const started = deferred();
    const { app, owner } = await workspace({ audioDecoder: fakeDecoder([async () => {
      started.resolve();
      await gate.promise;
    }]) });
    try {
      const place = await sceneWithVoice(owner);
      // The first contribution seeds the immutable baseline arrangement.
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      await session.post(`${place.scene}/contributions`, { requestId: randomUUID(), text: 'It stood back.', permissions: { place: true, model: false, share: true }, periodClaim: '' });
      const [baseline] = (await owner.json(`${place.scene}/collaboration`)).variants;
      const view = { kind: 'variant', version: null, variantId: baseline.id, eraRevision: baseline.eraRevision };
      assert.equal((await owner.post(place.stories, storyBody(place, { view: { ...view, eraRevision: view.eraRevision + 1 } }))).status, 409);

      const pending = owner.post(place.stories, storyBody(place, { view }));
      await started.promise;
      const era = await owner.post(`${place.scene}/variants/${baseline.id}/era`, {
        requestId: randomUUID(), baseRevision: baseline.eraRevision, kind: 'relative', label: 'before the renovation', start: null, end: null,
        statement: 'The owner remembers this before the renovation.', relation: null, relativeToVariantId: null, confirmed: true,
      });
      assert.equal(era.status, 200);
      gate.resolve();
      assert.equal((await pending).status, 409);
      assert.deepEqual((await owner.json(place.stories)).stories, []);
    } finally {
      gate.resolve();
      await app.close();
    }
  });

  it('aborts a decode when the recording loses its place use, but not on a share-only reduction', async () => {
    const gate = deferred();
    const started = deferred();
    let signal;
    const { app, owner } = await workspace({ audioDecoder: fakeDecoder([
      async (call) => {
        signal = call.signal;
        started.resolve();
        await gate.promise;
      },
    ]) });
    try {
      const place = await sceneWithVoice(owner);
      const shareOnly = owner.post(place.stories, storyBody(place));
      await started.promise;
      // The decode in progress counts for both the recording and the photo, once each.
      assert.equal((await owner.json(policyOf(place, place.voiceId))).impacts.processing, 1);
      assert.equal((await owner.json(policyOf(place, place.photoId))).impacts.processing, 1);
      const reduced = await restrict(owner, place, place.voiceId, { place: true, model: true, share: false });
      assert.equal(reduced.cancellation.status, 'not-running');
      assert.equal(signal.aborted, false);
      gate.resolve();
      assert.equal((await shareOnly).status, 201);
      const impacts = (await owner.json(policyOf(place, place.voiceId))).impacts;
      assert.deepEqual(impacts, { scenes: 0, stories: 1, snapshots: 0, processing: 0, linkedRegions: 0 });
    } finally {
      gate.resolve();
      await app.close();
    }
  });

  it('records a stop even while decoding, aborts it and publishes nothing', async () => {
    const started = deferred();
    let signal;
    const { app, owner } = await workspace({ audioDecoder: fakeDecoder([
      async (call) => {
        signal = call.signal;
        started.resolve();
        await new Promise((resolve) => call.signal.addEventListener('abort', resolve, { once: true }));
        throw decodeError('aborted');
      },
    ]) });
    try {
      const place = await sceneWithVoice(owner);
      const pending = owner.post(place.stories, storyBody(place));
      await started.promise;
      const stopped = await restrict(owner, place, place.voiceId, { place: false, model: false, share: false }, true);
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.cancellation.status, 'requested');
      assert.equal(signal.aborted, true);
      assert.equal((await pending).status, 409);
      assert.deepEqual((await owner.json(place.stories)).stories, []);
      assert.equal((await owner.json(place.scene)).usageBlocked, false, 'stopping a recording does not block the scene');
    } finally {
      await app.close();
    }
  });

  it('keeps a story on a retained version after later private edits and shares it only with that version', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const story = await (await owner.post(place.stories, storyBody(place))).json();
      assert.equal((await owner.post(`${place.scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0.5, 0, 0], yaw: 0 })).status, 200);
      // The existing history route lists the retained versions an owner can choose from.
      assert.deepEqual((await owner.json(`${place.scene}/history`)).map((entry) => entry.version), [1, 2]);
      const kept = await owner.json(`${place.stories}/${story.id}`);
      assert.equal(kept.available, true);
      assert.deepEqual(kept.view, story.view);

      const wrong = await share(owner, place, [{ id: randomUUID(), kind: 'version', version: 2, variantId: null }], [story.id]);
      assert.equal(wrong.status, 409, 'a story is never rebound to another version');
      const viewId = randomUUID();
      const shared = await share(owner, place, [{ id: viewId, kind: 'version', version: 1, variantId: null }], [story.id]);
      assert.equal(shared.status, 201);
      const manifest = await (await visit(app.base, shared.token)).json();
      assert.deepEqual(manifest.views[0].edit, { offset: [0, 0, 0], yaw: 0 });
      assert.equal(manifest.stories.length, 1);
      const [publicStory] = manifest.stories;
      assert.deepEqual(Object.keys(publicStory).sort(), ['audio', 'captionAuthorLabel', 'cues', 'durationMs', 'id', 'providerLabel', 'target', 'title', 'viewId']);
      assert.deepEqual(publicStory.target, { id: 'selected-foreground', label: 'Selected foreground object' });
      assert.equal(publicStory.viewId, viewId);
      assert.notEqual(publicStory.id, story.id);
      const serialized = JSON.stringify(manifest);
      for (const hidden of [story.id, place.voiceId, place.photoId, place.draft.voice.name, 'sha256']) assert.ok(!serialized.includes(hidden), hidden);

      const audio = await visit(app.base, shared.token, `/api/visit/stories/${publicStory.id}/audio.wav`);
      assert.equal(audio.status, 200);
      assert.equal(Buffer.from(await audio.arrayBuffer()).length, publicStory.audio.size);
      assert.equal((await visit(app.base, shared.token, `/api/visit/stories/${publicStory.id}/audio.wav`, { headers: { range: 'bytes=0-3' } })).status, 206);
      assert.equal((await globalThis.fetch(`${app.base}/api/visit/stories/${publicStory.id}/audio.wav`, { headers: { cookie: app.cookie } })).status, 404);
      assert.equal((await owner.request(`${place.scene}/shares/previews/${shared.preview.id}/stories/${publicStory.id}/audio.wav`)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('suspends only snapshots that include a story whose recording stops sharing or that was withdrawn', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const story = await (await owner.post(place.stories, storyBody(place))).json();
      const view = () => [{ id: randomUUID(), kind: 'version', version: 1, variantId: null }];
      const plain = await share(owner, place, view(), []);
      const withStory = await share(owner, place, view(), [story.id]);
      const [publicStory] = (await (await visit(app.base, withStory.token)).json()).stories;

      await restrict(owner, place, place.voiceId, { place: true, model: true, share: false });
      assert.equal((await visit(app.base, withStory.token)).status, 404);
      assert.equal((await visit(app.base, withStory.token, `/api/visit/stories/${publicStory.id}/audio.wav`, { method: 'HEAD' })).status, 404);
      assert.equal((await visit(app.base, plain.token)).status, 200, 'a snapshot without the story is unaffected');
      assert.equal((await owner.json(`${place.stories}/${story.id}`)).available, true, 'private use is still allowed');

      const withdrawBody = { requestId: randomUUID() };
      const withdrawn = await owner.post(`${place.stories}/${story.id}/withdraw`, withdrawBody);
      assert.equal(withdrawn.status, 200);
      const dto = await withdrawn.json();
      assert.equal(dto.status, 'withdrawn');
      assert.equal(dto.available, false);
      assert.equal(dto.title, '');
      assert.deepEqual(dto.cues, []);
      assert.equal(dto.audio, null);
      assert.ok(!JSON.stringify(dto).includes(TONE_CAPTION));
      assert.equal((await owner.post(`${place.stories}/${story.id}/withdraw`, withdrawBody)).status, 200);
      assert.equal((await owner.request(`${place.stories}/${story.id}/audio.wav`)).status, 409);
    } finally {
      await app.close();
    }
  });

  it('publishes nothing and leaves no staging when the server closes during a decode', async () => {
    const started = deferred();
    const { app, owner, dataDir } = await workspace({ audioDecoder: fakeDecoder([
      async (call) => {
        started.resolve();
        await new Promise((resolve) => call.signal.addEventListener('abort', resolve, { once: true }));
        throw decodeError('aborted');
      },
    ]) });
    const place = await sceneWithVoice(owner);
    const pending = owner.post(place.stories, storyBody(place));
    await started.promise;
    await app.close();
    assert.ok((await pending.catch(() => ({ status: 0 }))).status !== 201);
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.stories, undefined);
    assert.deepEqual(await stagingFiles(dataDir, place), []);
  });

  it('suspends a snapshot whose pinned playback copy was altered, without touching an unrelated one', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const story = await (await owner.post(place.stories, storyBody(place))).json();
      const view = () => [{ id: randomUUID(), kind: 'version', version: 1, variantId: null }];
      const plain = await share(owner, place, view(), []);
      const withStory = await share(owner, place, view(), [story.id]);
      const [publicStory] = (await (await visit(app.base, withStory.token)).json()).stories;
      const audioRoute = `/api/visit/stories/${publicStory.id}/audio.wav`;
      assert.equal((await visit(app.base, withStory.token, audioRoute)).status, 200);

      // Same size, different bytes: only the checksum can tell.
      const file = path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'stories', `${story.id}.wav`);
      const bytes = await readFile(file);
      bytes[bytes.length - 1] ^= 0xff;
      await fs.promises.writeFile(file, bytes);

      assert.equal((await visit(app.base, withStory.token)).status, 404, 'manifest');
      assert.equal((await visit(app.base, withStory.token, audioRoute, { method: 'HEAD' })).status, 404, 'HEAD');
      assert.equal((await visit(app.base, withStory.token, audioRoute)).status, 404, 'audio');
      assert.equal((await visit(app.base, withStory.token, audioRoute, { headers: { range: 'bytes=0-3' } })).status, 404, 'range');
      const listed = await owner.json(`${place.scene}/shares`);
      assert.deepEqual(listed.map((item) => item.status), ['suspended', 'active']);
      assert.equal((await visit(app.base, plain.token)).status, 200, 'unrelated snapshot');
      assert.equal((await owner.request(`${place.stories}/${story.id}/audio.wav`)).status, 409, 'owner playback');
    } finally {
      await app.close();
    }
  });

  it('refuses to preview a story whose playback copy was altered before the preview', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const story = await (await owner.post(place.stories, storyBody(place))).json();
      const file = path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'stories', `${story.id}.wav`);
      const bytes = await readFile(file);
      bytes[44] ^= 0xff;
      await fs.promises.writeFile(file, bytes);
      const before = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json'), 'utf8')).shares;
      const refused = await share(owner, place, [{ id: randomUUID(), kind: 'version', version: 1, variantId: null }], [story.id]);
      assert.equal(refused.status, 409);
      const after = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json'), 'utf8')).shares;
      assert.deepEqual(after, before, 'no preview candidate was stored');
    } finally {
      await app.close();
    }
  });

  it('hides a story whose recording was stopped and keeps ready stories across a restart', async () => {
    const first = await workspace();
    const place = await sceneWithVoice(first.owner);
    const story = await (await first.owner.post(place.stories, storyBody(place))).json();
    await first.app.close();
    const second = await workspace({ dataDir: first.dataDir });
    try {
      assert.deepEqual(await second.owner.json(`${place.stories}/${story.id}`), story);
      await restrict(second.owner, place, place.voiceId, { place: false, model: false, share: false }, true);
      const hidden = await second.owner.json(`${place.stories}/${story.id}`);
      assert.equal(hidden.status, 'ready');
      assert.equal(hidden.available, false);
      assert.match(hidden.blockedReason, /recording/);
      assert.equal(hidden.title, '');
      assert.deepEqual(hidden.cues, []);
      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-3' } }]) {
        assert.equal((await second.owner.request(`${place.stories}/${story.id}/audio.wav`, init)).status, 409);
      }
    } finally {
      await second.app.close();
    }
  });
});

describe('story commit boundaries', () => {
  // A saved scene with a recording, then the stores used directly on the same
  // data folder so a test can hold a file operation at an exact point.
  async function stores(decoder) {
    const { app, owner, dataDir } = await workspace();
    const place = await sceneWithVoice(owner);
    const { principal } = await owner.json('/api/session');
    await app.close();
    const reconstructions = new ReconstructionStore({ dataDir, drafts: new DraftStore(dataDir), runner: sceneRunner });
    return { place, principal, dataDir, reconstructions, stories: new StoryStore({ reconstructions, audioDecoder: decoder }) };
  }

  // Holds the first matching call of one fs.promises function until released.
  function hold(name, matches) {
    const original = fs.promises[name];
    const reached = deferred();
    const release = deferred();
    fs.promises[name] = async (...args) => {
      if (matches(...args)) {
        reached.resolve();
        await release.promise;
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    return {
      reached: reached.promise,
      release: release.resolve,
      restore() {
        release.resolve();
        fs.promises[name] = original;
        syncBuiltinESMExports();
      },
    };
  }
  const status = (code) => (error) => error?.status === code;

  it('never starts the decoder after a stop saved while the original was read, even when the abort fails', async () => {
    const decoder = fakeDecoder();
    const ctx = await stores(decoder);
    const voiceFile = path.join(ctx.dataDir, 'drafts', ctx.place.draft.id, ctx.place.draft.voice.name);
    const held = hold('readFile', (file) => String(file) === voiceFile);
    try {
      const creating = ctx.stories.create(ctx.place.draft.id, ctx.place.job.id, ctx.principal, storyBody(ctx.place));
      await held.reached;
      ctx.reconstructions.activeStory.controller.abort = () => {
        throw new Error('abort failed');
      };
      const saved = await ctx.reconstructions.restrictSource(ctx.place.draft.id, ctx.place.voiceId, ctx.principal, {
        requestId: randomUUID(), baseRevision: 0, permissions: { place: false, model: false, share: false }, stopUse: true,
      });
      assert.equal(saved.stopped, true);
      assert.equal(saved.cancellation.status, 'unconfirmed');
      held.release();
      await assert.rejects(creating, status(403));
      assert.equal(decoder.calls.length, 0);
      const manifest = await ctx.reconstructions.readManifest(ctx.place.draft.id, ctx.place.job.id);
      assert.equal(manifest.stories, undefined);
    } finally {
      held.restore();
      await ctx.reconstructions.close();
    }
  });

  it('removes the playback copy and records nothing when the store closes during the publishing rename', async () => {
    const ctx = await stores(fakeDecoder());
    const storiesDir = path.join(ctx.dataDir, 'reconstructions', ctx.place.draft.id, ctx.place.job.id, 'stories');
    const held = hold('rename', (from, to) => String(to).startsWith(storiesDir + path.sep));
    try {
      const creating = ctx.stories.create(ctx.place.draft.id, ctx.place.job.id, ctx.principal, storyBody(ctx.place));
      await held.reached;
      const closing = ctx.reconstructions.close();
      held.release();
      await assert.rejects(creating, status(409));
      await closing;
      const manifest = await ctx.reconstructions.readManifest(ctx.place.draft.id, ctx.place.job.id);
      assert.equal(manifest.stories, undefined);
      assert.deepEqual(await readdir(storiesDir).catch(() => []), []);
      assert.deepEqual(await stagingFiles(ctx.dataDir, ctx.place), []);
    } finally {
      held.restore();
    }
  });
});
