import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BudgetLedger } from '../meta-model.mjs';
import { createMetaTranscriber } from '../meta-transcribe.mjs';
import { parseStoryRequest } from '../stories.mjs';
import { client, enrolledContributor, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic container bytes; the injected decoder stands in for ffmpeg, and a
// fake fetch stands in for the provider. Nothing here reaches the network.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const SYNTHETIC_TURNS = [
  { turnId: 't1', startMs: 0, endMs: 1200, transcript: 'Synthetic fixture speech, part one.' },
  { turnId: 't2', startMs: 1400, endMs: 2000, transcript: 'Synthetic fixture speech, part two.' },
];
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pcmOf = (durationMs) => ({ pcm: Buffer.alloc(durationMs * 32), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs });
function fakeDecoder({ durationMs = 2000, gate = null } = {}) {
  const decoder = async (call) => {
    decoder.calls.push(call);
    if (gate) await gate(call);
    return pcmOf(durationMs);
  };
  decoder.calls = [];
  return decoder;
}

const answer = (body = { sessionId: 'fixture-session', transcript: '', audioDurationMs: 2000, turns: SYNTHETIC_TURNS }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' } });

// The production client with a fake provider. `respond` may wait or throw.
async function fixtureProvider(respond = async () => answer()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-draft-ledger-'));
  tempDirs.push(dir);
  const ledger = new BudgetLedger({ file: path.join(dir, 'budget.json') });
  const fetches = [];
  const transcriber = createMetaTranscriber({
    apiKey: 'fixture-key', ledger,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return respond(init);
    },
  });
  return { transcriber, fetches, ledger };
}

const grant = (permissions = {}) => ({
  provider: 'Synthetic provider', origin: { kind: 'public', reference: '' },
  permissions: { place: true, model: true, share: true, ...permissions },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

async function workspace({ audioDecoder = fakeDecoder(), provider = null, dataDir } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-draft-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, audioDecoder, captionTranscriber: provider?.transcriber ?? null });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function sceneWithVoice(owner, voicePermissions = {}) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant()], voice: grant(voicePermissions) }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return { draft, job, scene, stories: `${scene}/stories`, drafts: `${scene}/stories/caption-drafts`, voiceId: draft.voice.sourceId };
}

const versionView = (version) => ({ kind: 'version', version, variantId: null, eraRevision: null });
const draftBody = (place, change = {}) => ({ requestId: randomUUID(), voiceSourceId: place.voiceId, view: versionView(1), ...change });
const storyBody = (place, cues, change = {}) => ({
  requestId: randomUUID(), voiceSourceId: place.voiceId, view: versionView(1), title: 'Synthetic fixture story', cues, captionConfirmed: true, ...change,
});
const policyOf = (place) => `/api/drafts/${place.draft.id}/sources/${place.voiceId}/policy`;
async function restrict(owner, place, permissions) {
  const { revision } = await owner.json(policyOf(place));
  const response = await owner.post(policyOf(place), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse: false });
  assert.equal(response.status, 200);
  return response.json();
}
const manifestFile = (dataDir, place) => path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json');
const readManifest = async (dataDir, place) => JSON.parse(await readFile(manifestFile(dataDir, place), 'utf8'));
const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;

async function share(owner, place, storyIds) {
  const views = [{ id: randomUUID(), kind: 'version', version: 1, variantId: null }];
  const preview = await owner.post(`${place.scene}/shares/previews`, {
    requestId: randomUUID(), title: 'Synthetic place', views, startViewId: views[0].id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, storyIds,
  });
  assert.equal(preview.status, 201);
  const body = await preview.json();
  const token = visitToken();
  const issued = await owner.post(`${place.scene}/shares`, { requestId: randomUUID(), previewId: body.id, previewDigest: body.digest, token, consent: true });
  assert.equal(issued.status, 201);
  return { preview: body, token };
}
const visit = (base, token) => globalThis.fetch(`${base}/api/visit`, { headers: { authorization: `Bearer ${token}` } });

describe('caption draft route', () => {
  it('is owner-only and answers clearly when drafting is not set up', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await sceneWithVoice(owner);
      const { session: contributor } = await enrolledContributor(owner, app.base, place.draft.id);
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftBody(place)) };
      assert.equal((await client(app.base).request(place.drafts, init)).status, 401);
      assert.equal((await contributor.request(place.drafts, init)).status, 403);
      assert.equal((await owner.request(place.drafts)).status, 405);
      const response = await owner.post(place.drafts, draftBody(place));
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /not set up/);
    } finally {
      await app.close();
    }
  });
});

describe('drafting captions with a fixture provider', () => {
  it('returns unconfirmed cues bound to the recording and view, keeping only binding and call metadata', async () => {
    const provider = await fixtureProvider();
    const { app, owner, dataDir } = await workspace({ provider });
    try {
      const place = await sceneWithVoice(owner);
      const body = draftBody(place);
      const response = await owner.post(place.drafts, body);
      assert.equal(response.status, 201);
      const { draft } = await response.json();
      assert.equal(draft.confirmed, false);
      assert.equal(draft.model, 'muse-voice-transcribe-1.0');
      assert.equal(draft.modelLabel, 'Muse Voice Transcribe');
      assert.equal(draft.voiceSourceId, place.voiceId);
      assert.deepEqual(draft.view, versionView(1));
      assert.equal(draft.durationMs, 2000);
      assert.deepEqual(draft.cues, SYNTHETIC_TURNS.map(({ startMs, endMs, transcript }) => ({ startMs, endMs, text: transcript })));
      assert.equal(provider.fetches.length, 1);

      const [record] = (await readManifest(dataDir, place)).captionDrafts;
      assert.equal(record.status, 'drafted');
      assert.equal(record.cueCount, 2);
      assert.equal(record.call.providerRequestId, 'fixture-request');
      assert.equal(record.call.providerSessionId, 'fixture-session');
      assert.notEqual(record.id, record.requestId);
      assert.equal(JSON.stringify(record).includes('Synthetic fixture speech'), false, 'draft text is not kept');

      // A repeat never sends again, and a completed draft's text is not replayed.
      const replay = await owner.post(place.drafts, body);
      assert.equal(replay.status, 409);
      assert.match((await replay.json()).error, /not kept/);
      assert.equal((await owner.post(place.drafts, { ...body, view: versionView(2) })).status, 409);
      assert.equal(provider.fetches.length, 1);
    } finally {
      await app.close();
    }
  });

  it('sends one request for concurrent duplicates of the same request ID', async () => {
    const release = deferred();
    const provider = await fixtureProvider(async () => {
      await release.promise;
      return answer();
    });
    const { app, owner } = await workspace({ provider });
    try {
      const place = await sceneWithVoice(owner);
      const body = draftBody(place);
      const first = owner.post(place.drafts, body);
      for (let attempt = 0; attempt < 200 && provider.fetches.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      const duplicate = await owner.post(place.drafts, body);
      assert.equal(duplicate.status, 409);
      assert.match((await duplicate.json()).error, /still being made/);
      assert.equal((await owner.post(place.drafts, draftBody(place))).status, 409, 'another draft waits for the slot');
      release.resolve();
      assert.equal((await first).status, 201);
      assert.equal(provider.fetches.length, 1);
    } finally {
      release.resolve();
      await app.close();
    }
  });

  it('requires model use of the recording and sends nothing without it', async () => {
    const provider = await fixtureProvider();
    const decoder = fakeDecoder();
    const { app, owner } = await workspace({ provider, audioDecoder: decoder });
    try {
      const place = await sceneWithVoice(owner, { model: false });
      const response = await owner.post(place.drafts, draftBody(place));
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /model processing/);
      assert.equal(decoder.calls.length, 0);
      assert.equal(provider.fetches.length, 0);
    } finally {
      await app.close();
    }
  });

  it('never sends a recording whose model use is revoked during decoding', async () => {
    const started = deferred();
    const gate = deferred();
    const provider = await fixtureProvider();
    const { app, owner, dataDir } = await workspace({ provider, audioDecoder: fakeDecoder({ gate: async () => { started.resolve(); await gate.promise; } }) });
    try {
      const place = await sceneWithVoice(owner);
      const pending = owner.post(place.drafts, draftBody(place));
      await started.promise;
      const restricted = await restrict(owner, place, { place: true, model: false, share: true });
      assert.equal(restricted.cancellation.status, 'requested');
      gate.resolve();
      assert.equal((await pending).status, 409);
      assert.equal(provider.fetches.length, 0);
      const [record] = (await readManifest(dataDir, place)).captionDrafts;
      assert.equal(record.status, 'failed');
      assert.equal(record.call?.dispatched ?? false, false);
    } finally {
      gate.resolve();
      await app.close();
    }
  });

  it('returns no usable draft when model use is revoked while a provider ignores the abort', async () => {
    const sent = deferred();
    const release = deferred();
    const provider = await fixtureProvider(async () => {
      sent.resolve();
      await release.promise;
      return answer();
    });
    const { app, owner, dataDir } = await workspace({ provider });
    try {
      const place = await sceneWithVoice(owner);
      const pending = owner.post(place.drafts, draftBody(place));
      await sent.promise;
      await restrict(owner, place, { place: true, model: false, share: true });
      release.resolve();
      const response = await pending;
      assert.equal(response.status, 409);
      assert.equal((await response.json()).draft, undefined);
      assert.equal(provider.fetches.length, 1);
      const [record] = (await readManifest(dataDir, place)).captionDrafts;
      assert.notEqual(record.status, 'drafted');
      assert.equal(record.call.dispatched, true);
      assert.deepEqual((await provider.ledger.read()).entries.map((entry) => entry.state), ['reserved'], 'a sent request is not refunded');
    } finally {
      release.resolve();
      await app.close();
    }
  });

  it('rejects recordings over 60 seconds without sending them', async () => {
    const provider = await fixtureProvider();
    const { app, owner } = await workspace({ provider, audioDecoder: fakeDecoder({ durationMs: 60_001 }) });
    try {
      const place = await sceneWithVoice(owner);
      const response = await owner.post(place.drafts, draftBody(place));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /60 seconds/);
      assert.equal(provider.fetches.length, 0);
    } finally {
      await app.close();
    }
  });

  it('reports silence, unusable turns and provider failures without a draft', async () => {
    const replies = [
      () => answer({ transcript: '', audioDurationMs: 2000, turns: [] }),
      () => answer({ turns: [{ turnId: 't1', startMs: 0, endMs: 1500, transcript: 'a' }, { turnId: 't2', startMs: 1000, endMs: 1800, transcript: 'b' }] }),
      () => answer({ turns: [{ turnId: 't1', startMs: 0, endMs: 9000, transcript: 'past the end' }] }),
      () => new Response('{}', { status: 500 }),
    ];
    const provider = await fixtureProvider(async () => replies.shift()());
    const { app, owner, dataDir } = await workspace({ provider });
    try {
      const place = await sceneWithVoice(owner);
      const statuses = [];
      for (let index = 0; index < 4; index++) statuses.push((await owner.post(place.drafts, draftBody(place))).status);
      assert.deepEqual(statuses, [422, 502, 502, 502]);
      assert.deepEqual((await readManifest(dataDir, place)).captionDrafts.map((item) => [item.status, item.reason]),
        [['failed', 'empty'], ['failed', 'invalid'], ['failed', 'invalid'], ['failed', 'provider']]);
    } finally {
      await app.close();
    }
  });
});

describe('saving a story from a reviewed draft', () => {
  it('keeps AI draft attribution through reload and sharing, and pins it for visitors', async () => {
    const provider = await fixtureProvider();
    const { app, owner, dataDir } = await workspace({ provider });
    let reopened = null;
    try {
      const place = await sceneWithVoice(owner);
      const { draft } = await (await owner.post(place.drafts, draftBody(place))).json();
      // The owner corrects the draft before confirming it.
      const reviewed = [{ ...draft.cues[0], text: 'Synthetic fixture speech, corrected by the owner.' }, draft.cues[1]];
      const saved = await owner.post(place.stories, storyBody(place, reviewed, { captionDraftId: draft.id }));
      assert.equal(saved.status, 201);
      const story = await saved.json();
      assert.deepEqual(story.captionDraft, { model: 'muse-voice-transcribe-1.0', label: 'Muse Voice Transcribe' });
      assert.equal(story.captionAuthor.displayName, 'Synthetic owner');
      assert.deepEqual(story.cues, reviewed);

      const manual = await (await owner.post(place.stories, storyBody(place, [{ startMs: 0, endMs: 900, text: 'Written by hand.' }]))).json();
      assert.equal(Object.hasOwn(manual, 'captionDraft'), false, 'a manual story is unchanged');

      const shared = await share(owner, place, [story.id, manual.id]);
      const visitorStories = (await (await visit(app.base, shared.token)).json()).stories;
      assert.deepEqual(visitorStories.find((item) => item.title === story.title && item.captionDraft)?.captionDraft, story.captionDraft);
      assert.equal(visitorStories.filter((item) => Object.hasOwn(item, 'captionDraft')).length, 1);
      const manualOnly = await share(owner, place, [manual.id]);

      await app.close();
      reopened = await workspace({ provider, dataDir });
      const listed = (await reopened.owner.json(place.stories)).stories;
      assert.deepEqual(listed.find((item) => item.id === story.id).captionDraft, story.captionDraft);
      assert.equal((await visit(reopened.app.base, shared.token)).status, 200);

      // Changing the provenance of the pinned story suspends only the snapshot that includes it.
      const manifest = await readManifest(dataDir, place);
      const tampered = { ...manifest, stories: { ...manifest.stories, items: manifest.stories.items.map((item) => (item.id === story.id ? { ...item, captionDraft: { ...item.captionDraft, label: 'Someone else' } } : item)) } };
      await writeFile(manifestFile(dataDir, place), JSON.stringify(tampered));
      assert.equal((await visit(reopened.app.base, shared.token)).status, 404);
      assert.equal((await visit(reopened.app.base, manualOnly.token)).status, 200);
    } finally {
      await (reopened ?? { app }).app.close();
    }
  });

  it('accepts only a successful draft of the same whole recording and view', async () => {
    const replies = [() => answer(), () => answer({ turns: [] })];
    const provider = await fixtureProvider(async () => replies.shift()());
    const { app, owner, dataDir } = await workspace({ provider });
    try {
      const place = await sceneWithVoice(owner);
      const { draft } = await (await owner.post(place.drafts, draftBody(place))).json();
      assert.equal((await owner.post(place.drafts, draftBody(place))).status, 422);
      const failedId = (await readManifest(dataDir, place)).captionDrafts[1].id;
      const cues = draft.cues;
      for (const [captionDraftId, status] of [[randomUUID(), 409], [failedId, 409], [null, 400], ['', 400]]) {
        assert.equal((await owner.post(place.stories, storyBody(place, cues, { captionDraftId }))).status, status, String(captionDraftId));
      }
      assert.equal((await owner.post(place.stories, storyBody(place, [{ startMs: 0, endMs: 500, text: 'part' }], { captionDraftId: draft.id, sourceRange: { startMs: 0, endMs: 1000 } }))).status, 400);

      // A draft bound to another view revision does not apply.
      const manifest = await readManifest(dataDir, place);
      const moved = { ...manifest, captionDrafts: manifest.captionDrafts.map((item) => (item.id === draft.id ? { ...item, voiceSha256: '0'.repeat(64) } : item)) };
      await writeFile(manifestFile(dataDir, place), JSON.stringify(moved));
      assert.equal((await owner.post(place.stories, storyBody(place, cues, { captionDraftId: draft.id }))).status, 409);
      await writeFile(manifestFile(dataDir, place), JSON.stringify(manifest));

      // A story request ID replays its story; reusing it with another draft is a conflict.
      const body = storyBody(place, cues, { captionDraftId: draft.id });
      const first = await (await owner.post(place.stories, body)).json();
      const again = await owner.post(place.stories, body);
      assert.equal(again.status, 201);
      assert.equal((await again.json()).id, first.id);
      assert.equal((await owner.post(place.stories, { ...body, captionDraftId: failedId })).status, 409);
      assert.equal((await owner.json(place.stories)).stories.length, 1);
    } finally {
      await app.close();
    }
  });

  it('parses a request without a draft exactly as before', () => {
    const body = storyBody({ voiceId: randomUUID() }, [{ startMs: 0, endMs: 900, text: 'Written by hand.' }]);
    const parsed = parseStoryRequest(body);
    assert.deepEqual(Object.keys(parsed), ['requestId', 'voiceSourceId', 'view', 'title', 'cues']);
    assert.equal(parseStoryRequest({ ...body, captionDraftId: body.requestId }).captionDraftId, body.requestId);
  });
});
