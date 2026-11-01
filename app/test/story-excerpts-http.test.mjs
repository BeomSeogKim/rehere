import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { client, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic recordings only: a deterministic decoder double returns PCM
// whose sample values identify each millisecond region, so an excerpt can be
// checked against the exact bytes it must contain.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const RANGE_MESSAGE = 'The selected part of the recording no longer matches its record.';

// Three seconds of 16 kHz mono 16-bit PCM: every sample in second k holds
// the value 1000*(k+1) plus its index inside that second, so before, inside
// and after a 1000..2000 excerpt are distinguishable.
function threeSeconds() {
  const pcm = Buffer.alloc(3 * 32_000);
  for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(1000 * (Math.floor(index / 16_000) + 1) + (index % 16_000) % 997, index * 2);
  return pcm;
}
const PCM = threeSeconds();
function decoder(pcm = PCM, extra = {}) {
  const calls = [];
  const decode = async (call) => {
    calls.push(call);
    if (decode.hold) await decode.hold;
    return { pcm, sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: Math.floor(pcm.length / 32), ...extra };
  };
  decode.calls = calls;
  return decode;
}

async function workspace(audioDecoder = decoder(), dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-story-excerpts-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, audioDecoder });
  return { app, dataDir, decoder: audioDecoder, owner: client(app.base, app.cookie) };
}

const grant = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
async function sceneWithVoice(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant], voice: grant }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return { draft, job, scene, stories: `${scene}/stories`, voiceId: draft.voice.sourceId, photoId: draft.photos[0].sourceId };
}
const versionView = (version) => ({ kind: 'version', version, variantId: null, eraRevision: null });
const storyBody = (place, change = {}) => ({
  requestId: randomUUID(), voiceSourceId: place.voiceId, view: versionView(1), title: 'Synthetic excerpt',
  cues: [{ startMs: 0, endMs: 900, text: 'Synthetic caption at the start of the excerpt.' }], captionConfirmed: true, ...change,
});
const manifestPath = (dataDir, place) => path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json');
const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;
async function share(owner, place, storyIds) {
  const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
  const preview = await (await owner.post(`${place.scene}/shares/previews`, {
    requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, storyIds,
  })).json();
  const token = visitToken();
  assert.equal((await owner.post(`${place.scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true })).status, 201);
  return { preview, token };
}
const visit = (base, token, route = '/api/visit', init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
const stagingFiles = (dataDir, place) => readdir(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'story-staging')).catch(() => []);
const storyFiles = (dataDir, place) => readdir(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'stories')).catch(() => []);
const policyOf = (place, sourceId) => `/api/drafts/${place.draft.id}/sources/${sourceId}/policy`;

describe('recording excerpts in stories', () => {
  it('keeps a whole-recording request, digest, context and projection exactly as before', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const body = storyBody(place);
      const created = await owner.post(place.stories, body);
      assert.equal(created.status, 201);
      const story = await created.json();
      assert.equal('sourceRange' in story, false);
      assert.equal(story.durationMs, 3000);
      assert.equal(story.audio.size, 44 + PCM.length);
      const stored = JSON.parse(await readFile(manifestPath(dataDir, place), 'utf8')).stories.items[0];
      const { requestId, captionConfirmed, ...values } = body;
      assert.equal(stored.requestDigest, sha256(JSON.stringify({ voiceSourceId: values.voiceSourceId, view: values.view, title: values.title, cues: values.cues })), 'the old digest');
      assert.equal('sourceRange' in stored.context.voice, false, 'no default is injected');
      assert.deepEqual(await (await owner.post(place.stories, body)).json(), story, 'an exact replay is unchanged');
    } finally {
      await app.close();
    }
  });

  it('keeps exactly the selected PCM, with relative captions, and leaves the original untouched', async () => {
    const { app, owner, dataDir, decoder: decode } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const original = await readFile(path.join(dataDir, 'drafts', place.draft.id, place.draft.voice.name));
      const body = storyBody(place, { sourceRange: { startMs: 1000, endMs: 2000 } });
      const created = await owner.post(place.stories, body);
      assert.equal(created.status, 201);
      const story = await created.json();
      assert.deepEqual([story.durationMs, story.audio.size, story.sourceRange], [1000, 32_044, { startMs: 1000, endMs: 2000 }]);
      const wav = Buffer.from(await (await owner.request(`${place.stories}/${story.id}/audio.wav`)).arrayBuffer());
      assert.equal(wav.length, 32_044);
      assert.ok(wav.subarray(44).equals(PCM.subarray(32_000, 64_000)), 'exactly the selected samples');
      assert.equal(wav.readInt16LE(44), 2000, 'starts inside, not before');
      assert.equal(wav.readInt16LE(wav.length - 2), 2000 + (15_999 % 997), 'ends inside, not after');
      assert.deepEqual(await readFile(path.join(dataDir, 'drafts', place.draft.id, place.draft.voice.name)), original, 'the original is unchanged');
      const stored = JSON.parse(await readFile(manifestPath(dataDir, place), 'utf8')).stories.items[0];
      assert.deepEqual(stored.context.voice.sourceRange, { startMs: 1000, endMs: 2000 });
      assert.equal(stored.context.voice.sourceSampleCount, 48_000, 'the whole decoded original, kept privately');
      assert.equal(JSON.stringify(story).includes('sourceSampleCount'), false, 'never projected');
      assert.equal(stored.context.voice.sha256, sha256(original), 'bound to the exact original');
      assert.deepEqual([story.target.id, story.view.kind, story.view.version], ['selected-foreground', 'version', 1]);
      // One decode for the request and its exact replay; a changed range is a conflict.
      assert.deepEqual(await (await owner.post(place.stories, body)).json(), story);
      assert.equal(decode.calls.length, 1);
      for (const sourceRange of [{ startMs: 1000, endMs: 2001 }, undefined]) {
        const changed = { ...body };
        if (sourceRange) changed.sourceRange = sourceRange;
        else delete changed.sourceRange;
        assert.equal((await owner.post(place.stories, changed)).status, 409);
      }
      const full = await owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 0, endMs: 3000 } }));
      assert.equal(full.status, 201, 'a fresh request may choose the full extent');
      assert.equal((await full.json()).durationMs, 3000);
      assert.equal((await storyFiles(dataDir, place)).length, 2);
    } finally {
      await app.close();
    }
  });

  it('refuses malformed ranges, ranges beyond the decoded track and captions beyond the excerpt, without leaving files', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      for (const sourceRange of [null, {}, { startMs: 0 }, { startMs: 0, endMs: 1000, extra: 1 }, { startMs: 0.5, endMs: 1000 }, { startMs: -1, endMs: 1000 },
        { startMs: 1000, endMs: 1000 }, { startMs: 2000, endMs: 1000 }, { startMs: 0, endMs: 300_001 }, { startMs: '0', endMs: 1000 }, { startMs: 0, endMs: Infinity }]) {
        assert.equal((await owner.post(place.stories, storyBody(place, { sourceRange }))).status, 400, JSON.stringify(sourceRange));
      }
      assert.equal((await owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 2500, endMs: 3001 } }))).status, 400, 'beyond the decoded extent');
      assert.equal((await owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 1000, endMs: 1500 } }))).status, 400, 'a caption beyond the excerpt');
      assert.deepEqual([await storyFiles(dataDir, place), await stagingFiles(dataDir, place)], [[], []]);
      assert.equal(JSON.parse(await readFile(manifestPath(dataDir, place), 'utf8')).stories, undefined, 'nothing was published');
    } finally {
      await app.close();
    }
  });

  it('refuses an excerpt when the decoder returns anything but valid full 16 kHz mono 16-bit PCM', async () => {
    for (const [label, decode] of [
      ['other rate', decoder(PCM, { sampleRate: 8000 })], ['stereo', decoder(PCM, { channels: 2 })], ['8-bit', decoder(PCM, { bitsPerSample: 8 })],
      ['not a buffer', decoder(new Uint8Array(PCM))], ['empty', decoder(Buffer.alloc(0))], ['odd', decoder(Buffer.alloc(3201))], ['too long', decoder(Buffer.alloc(9_600_002))],
    ]) {
      const { app, owner, dataDir } = await workspace(decode);
      try {
        const place = await sceneWithVoice(owner);
        const response = await owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 0, endMs: 100 }, cues: [{ startMs: 0, endMs: 50, text: 'x' }] }));
        assert.equal(response.status, 400, label);
        assert.deepEqual([await storyFiles(dataDir, place), await stagingFiles(dataDir, place)], [[], []], label);
      } finally {
        await app.close();
      }
    }
  });

  it('treats a saved excerpt that no longer matches its record as unavailable everywhere, never as whole', async () => {
    const { app, owner, dataDir, decoder: decode } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const story = await (await owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 1000, endMs: 2000 } }))).json();
      const { token, preview } = await share(owner, place, [story.id]);
      assert.deepEqual(preview.publicView.stories[0].sourceRange, { startMs: 1000, endMs: 2000 });
      const file = manifestPath(dataDir, place);
      const original = JSON.parse(await readFile(file, 'utf8'));
      const decodes = decode.calls.length;
      for (const [label, mutate] of [
        ['malformed range', (item) => { item.context.voice.sourceRange = { startMs: 1000 }; }],
        ['null range', (item) => { item.context.voice.sourceRange = null; }],
        ['duration mismatch', (item) => { item.durationMs = 3000; }],
        ['size mismatch', (item) => { item.audio.size = 44 + 3 * 32_000; }],
        ['same-length range shifted beyond the original', (item) => { item.context.voice.sourceRange = { startMs: 5000, endMs: 6000 }; }],
        ['missing sample count', (item) => { delete item.context.voice.sourceSampleCount; }],
        ['missing range with a retained sample count', (item) => { delete item.context.voice.sourceRange; }],
        ['zero sample count', (item) => { item.context.voice.sourceSampleCount = 0; }],
        ['fractional sample count', (item) => { item.context.voice.sourceSampleCount = 48_000.5; }],
        ['string sample count', (item) => { item.context.voice.sourceSampleCount = '48000'; }],
        ['sample count over five minutes', (item) => { item.context.voice.sourceSampleCount = 4_800_001; }],
        ['sample count shorter than the range', (item) => { item.context.voice.sourceSampleCount = 31_999; }],
      ]) {
        const manifest = structuredClone(original);
        mutate(manifest.stories.items[0]);
        await writeFile(file, JSON.stringify(manifest));
        const listed = (await owner.json(place.stories)).stories[0];
        assert.deepEqual([listed.available, listed.blockedReason, listed.title, 'sourceRange' in listed], [false, RANGE_MESSAGE, '', false], label);
        assert.equal((await owner.request(`${place.stories}/${story.id}/audio.wav`)).status, 409, label);
        assert.equal((await visit(app.base, token)).status, 404, `${label}: the shared view is suspended`);
        const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
        const preview = await owner.post(`${place.scene}/shares/previews`, {
          requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, storyIds: [story.id],
        });
        assert.equal(preview.status, 409, `${label}: no new preview`);
      }
      assert.equal(decode.calls.length, decodes, 'nothing is decoded on reads');
      await writeFile(file, JSON.stringify(original));
      assert.equal((await visit(app.base, token)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('shares the exact excerpt bytes and bounds, keeps them after a restart, and stops on a voice restriction', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const whole = await (await owner.post(place.stories, storyBody(place))).json();
      const { token: legacyToken } = await share(owner, place, [whole.id]);
      const legacyPacket = await (await visit(app.base, legacyToken)).text();
      const excerpt = await (await owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 1000, endMs: 2000 }, title: 'Synthetic second' }))).json();
      const { token } = await share(owner, place, [excerpt.id]);
      const visited = await (await visit(app.base, token)).json();
      const shared = visited.stories[0];
      assert.deepEqual([shared.sourceRange, shared.durationMs, shared.audio.size], [{ startMs: 1000, endMs: 2000 }, 1000, 32_044]);
      assert.ok(!JSON.stringify(visited).includes(place.voiceId), 'no original ID for visitors');
      const route = `/api/visit/stories/${shared.id}/audio.wav`;
      const audio = Buffer.from(await (await visit(app.base, token, route)).arrayBuffer());
      assert.ok(audio.subarray(44).equals(PCM.subarray(32_000, 64_000)));
      assert.equal((await visit(app.base, token, route, { method: 'HEAD' })).status, 200);
      const ranged = await visit(app.base, token, route, { headers: { range: 'bytes=0-3' } });
      assert.equal(ranged.status, 206);
      assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('latin1'), 'RIFF');
      const originalRead = await visit(app.base, token, `/api/drafts/${place.draft.id}/assets/${place.draft.voice.name}`);
      assert.ok([401, 403, 404].includes(originalRead.status), 'a visit token never opens the original');

      await app.close();
      ({ app, owner } = await workspace(decoder(), dataDir));
      assert.deepEqual(await (await visit(app.base, token)).json(), visited, 'kept across a restart');
      assert.equal(await (await visit(app.base, legacyToken)).text(), legacyPacket, 'an issued whole-story packet is byte-identical');

      // Stopping the recording stops the excerpt; a photo-only visit stays usable.
      const { token: photoOnly } = await share(owner, place, []);
      const { revision } = await owner.json(policyOf(place, place.voiceId));
      assert.equal((await owner.post(policyOf(place, place.voiceId), { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true })).status, 200);
      assert.equal((await visit(app.base, token)).status, 404);
      assert.equal((await visit(app.base, token, route)).status, 404);
      assert.equal((await visit(app.base, photoOnly)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('publishes nothing when the recording is restricted during an excerpt decode', async () => {
    const decode = decoder();
    let release;
    decode.hold = new Promise((resolve) => {
      release = resolve;
    });
    const { app, owner, dataDir } = await workspace(decode);
    try {
      const place = await sceneWithVoice(owner);
      const pending = owner.post(place.stories, storyBody(place, { sourceRange: { startMs: 1000, endMs: 2000 } }));
      for (let attempt = 0; attempt < 200 && decode.calls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      const { revision } = await owner.json(policyOf(place, place.voiceId));
      assert.equal((await owner.post(policyOf(place, place.voiceId), { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: false })).status, 200);
      release();
      assert.equal((await pending).status, 409);
      assert.deepEqual([await storyFiles(dataDir, place), await stagingFiles(dataDir, place)], [[], []]);
    } finally {
      release();
      await app.close();
    }
  });
});
