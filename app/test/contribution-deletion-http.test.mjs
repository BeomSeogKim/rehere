import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pcmWav } from '../audio-derivative.mjs';
import { detectMedia } from '../drafts.mjs';
import { client, enrolledContributor, jpeg, png, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Synthetic, disposable data only. Injected stand-ins replace the photo
// worker, the recording preparer, the hosted model and the story decoder.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(96, 5)]);
const OWNER_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const WAV = pcmWav(Buffer.alloc(3200));
const REVIEW = jpeg(64, 48, 9);
// The contributor's own photo, distinct from the owner's scene photo.
const CONTRIBUTED_PHOTO = png(40, 30, 8);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const recordingPreparer = async ({ bytes }) => {
  const { type, extension } = detectMedia('voice', bytes);
  return {
    original: { sha256: sha256(bytes), size: bytes.length, type, extension },
    playback: { sha256: sha256(WAV), size: WAV.length, type: 'audio/wav', durationMs: 100, sampleRate: 16_000, channels: 1, bitsPerSample: 16, parentSha256: sha256(bytes) },
    wav: WAV,
  };
};
function controls() {
  const model = { gate: null, started: null };
  const story = { gate: null, started: null };
  return {
    model, story,
    proposalModel: async (call) => {
      model.signals = [...(model.signals ?? []), call.signal];
      model.started?.resolve();
      if (model.gate) await model.gate.promise;
      return {
        model: 'synthetic-model', responseId: `resp_${randomUUID()}`, usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 }, ok: true,
        plan: { action: 'translate', targetId: 'selected-foreground', sourceId: call.sourceId, baseVersion: call.baseVersion, delta: [0.25, 0, 0], yawDelta: null, anchor: null, question: null, reason: 'Synthetic plan.' },
      };
    },
    audioDecoder: async () => {
      story.started?.resolve();
      if (story.gate) await story.gate.promise;
      return { pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 };
    },
  };
}

async function workspace(dataDir, hooks = controls()) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-deletion-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({
    dataDir, reconstructionRunner: sceneRunner, contributionPhotoDecoder: async () => REVIEW, recordingPreparer,
    proposalModel: hooks.proposalModel, prepareModelImage: async () => jpeg(20, 15, 3), audioDecoder: hooks.audioDecoder,
  });
  return { app, dataDir, hooks, owner: client(app.base, app.cookie) };
}

const fullGrant = () => ({
  provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});
// A shareable ready scene from a memory with one photo and the owner's own recording.
async function place(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([OWNER_WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [fullGrant()], voice: fullGrant() }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const base = (id) => `${scene}/contributions/${id}`;
  return {
    draft, job, scene, voiceId: draft.voice.sourceId,
    deletion: (id) => `${base(id)}/deletion`, remove: (id) => `${base(id)}/delete`, captions: (id) => `${base(id)}/captions`,
    review: (id) => `${base(id)}/review`, withdraw: (id) => `${base(id)}/withdraw`, photo: (id) => `${base(id)}/photo`, recording: (id) => `${base(id)}/recording.wav`,
  };
}

const grants = { place: true, model: true, share: true };
const facts = () => ({ origin: { kind: 'own', reference: 'Reference secret 7Q' }, dates: { capturedOn: '1999-05-01', fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: 'Period secret 7Q' }, permissions: grants });
async function submit(session, scene, { text = 'Writing secret 7Q: the counter stood back.', periodClaim = 'Claim secret 7Q', photo = true, voice = true, captionText = 'Caption secret 7Q.' } = {}) {
  const body = {
    requestId: randomUUID(), text, permissions: text ? grants : null, periodClaim: text ? periodClaim : '',
    photo: photo ? facts() : null, voice: voice ? { ...facts(), captionText, captionConfirmed: captionText !== '' } : null,
  };
  const form = new FormData();
  form.append('payload', JSON.stringify(body));
  if (photo) form.append('photo', new Blob([CONTRIBUTED_PHOTO]), 'p');
  if (voice) form.append('voice', new Blob([WEBM]), 'v');
  const response = await session.request(`${scene.scene}/contributions/bundle`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  return { body, form: () => {
    const again = new FormData();
    again.append('payload', JSON.stringify(body));
    if (photo) again.append('photo', new Blob([CONTRIBUTED_PHOTO]), 'p');
    if (voice) again.append('voice', new Blob([WEBM]), 'v');
    return again;
  }, contribution: await response.json() };
}

const jobDirOf = (dataDir, scene) => path.join(dataDir, 'reconstructions', scene.draft.id, scene.job.id);
const manifestFile = (dataDir, scene) => path.join(jobDirOf(dataDir, scene), 'manifest.json');
const manifestOf = async (dataDir, scene) => JSON.parse(await readFile(manifestFile(dataDir, scene), 'utf8'));
const contributionsDir = (dataDir, scene) => path.join(jobDirOf(dataDir, scene), 'contributions');
const versionView = (version) => ({ id: randomUUID(), kind: 'version', version, variantId: null });
const previewBody = (views, extra = {}) => ({
  requestId: randomUUID(), title: 'Owner title', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, ...extra,
});
const visit = (base, token, route = '/api/visit', init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
async function issue(owner, scene, preview) {
  const body = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token: `rhv_${randomBytes(32).toString('base64url')}`, consent: true };
  const response = await owner.post(`${scene.scene}/shares`, body);
  assert.equal(response.status, 201);
  return { token: body.token, body };
}
const confirm = (impactSha256, requestId = randomUUID()) => ({ requestId, impactSha256, confirmDeletion: true });
const INVENTORY_KEYS = ['captionVersions', 'photo', 'playback', 'sharedViewsAffected', 'usedInPlace', 'voice', 'writing'];

describe('deletion preview and confirmation', () => {
  it('lets only the provider preview and confirm, and refuses a confirmation made before the impact changed', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id, 'Name secret 7Q');
      const { contribution } = await submit(session, scene);
      const { session: peer } = await enrolledContributor(owner, app.base, scene.draft.id, 'Peer');
      assert.equal((await owner.request(scene.deletion(contribution.id))).status, 403);
      assert.equal((await peer.request(scene.deletion(contribution.id))).status, 404);
      assert.equal((await client(app.base).request(scene.deletion(contribution.id))).status, 401);
      assert.equal((await owner.post(scene.remove(contribution.id), confirm('0'.repeat(64)))).status, 403);
      assert.equal((await peer.post(scene.remove(contribution.id), confirm('0'.repeat(64)))).status, 404);

      const preview = await (await session.request(scene.deletion(contribution.id))).json();
      assert.equal(preview.state, 'present');
      assert.deepEqual(Object.keys(preview.impact).sort(), INVENTORY_KEYS);
      assert.deepEqual(preview.impact, { writing: 1, photo: 1, voice: 1, playback: 1, captionVersions: 1, usedInPlace: false, sharedViewsAffected: false });
      assert.match(preview.impactSha256, /^[0-9a-f]{64}$/);

      const before = await readFile(manifestFile(dataDir, scene), 'utf8');
      assert.equal((await session.post(scene.remove(contribution.id), { ...confirm(preview.impactSha256), confirmDeletion: false })).status, 400);
      assert.equal((await session.post(scene.remove(contribution.id), confirm(null))).status, 409, 'cleanup-only requests need an existing deletion');
      // A newly issued share that quotes it changes the impact.
      const v1 = versionView(1);
      const shared = await (await owner.post(`${scene.scene}/shares/previews`, previewBody([v1], { contributionIds: [contribution.id] }))).json();
      await issue(owner, scene, shared);
      const changed = await readFile(manifestFile(dataDir, scene), 'utf8');
      assert.notEqual(changed, before);
      assert.equal((await session.post(scene.remove(contribution.id), confirm(preview.impactSha256))).status, 409);
      assert.equal(await readFile(manifestFile(dataDir, scene), 'utf8'), changed, 'a stale confirmation changes nothing');
      // So does a caption correction.
      const fresh = await (await session.request(scene.deletion(contribution.id))).json();
      assert.equal(fresh.impact.sharedViewsAffected, true);
      await session.post(scene.captions(contribution.id), { requestId: randomUUID(), baseCaptionSha256: contribution.voice.captions.sha256, captionText: 'Corrected secret 7Q.', captionConfirmed: true });
      assert.equal((await session.post(scene.remove(contribution.id), confirm(fresh.impactSha256))).status, 409);
      const current = await (await session.request(scene.deletion(contribution.id))).json();
      const deleted = await session.post(scene.remove(contribution.id), confirm(current.impactSha256));
      assert.equal(deleted.status, 200);
      assert.equal((await deleted.json()).contribution.status, 'deleted');
    } finally {
      await app.close();
    }
  });
});

describe('deleting a used and shared contribution', () => {
  it('stops access, clears every tracked linked copy, removes its files and keeps everything unrelated', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id, 'Name secret 7Q');
      const submitted = await submit(session, scene);
      const { contribution } = submitted;
      const corrected = await (await session.post(scene.captions(contribution.id), {
        requestId: randomUUID(), baseCaptionSha256: contribution.voice.captions.sha256, captionText: 'Corrected secret 7Q.', captionConfirmed: true,
      })).json();
      const captionRequest = { requestId: randomUUID(), baseCaptionSha256: corrected.contribution.voice.captions.sha256, captionText: 'Third secret 7Q.', captionConfirmed: true };
      assert.equal((await session.post(scene.captions(contribution.id), captionRequest)).status, 200);
      const unrelated = await enrolledContributor(owner, app.base, scene.draft.id, 'Unrelated writer');
      const other = (await submit(unrelated.session, scene, { photo: false, voice: false, text: 'Unrelated words.', periodClaim: 'Unrelated claim.' })).contribution;

      const reviewRequest = {
        requestId: randomUUID(), baseVersion: 1, baseRevision: 3, decision: 'adopt', reason: 'Review secret 7Q quoting the counter.', conflict: 'unknown',
        transform: { offset: [0, 0, -0.5], yaw: 0 }, photoReviewed: true, voiceReviewed: true,
      };
      const adopted = await owner.post(scene.review(contribution.id), reviewRequest);
      assert.equal(adopted.status, 200);
      const variantId = (await adopted.json()).variant.id;
      const eraRequest = {
        requestId: randomUUID(), baseRevision: 0, kind: 'exact', label: 'Era label secret 7Q', start: '1999-05-01', end: '1999-05-01',
        statement: 'Era statement secret 7Q.', relation: null, relativeToVariantId: null, confirmed: true,
      };
      assert.equal((await owner.post(`${scene.scene}/variants/${variantId}/era`, eraRequest)).status, 200);
      const proposed = await owner.post(`${scene.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'Proposal secret 7Q.', consent: true });
      assert.equal(proposed.status, 202);
      const proposalId = (await proposed.json()).id;
      for (let attempt = 0; attempt < 300 && (await owner.json(`${scene.scene}/proposals/${proposalId}`)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      const variantView = { kind: 'variant', version: null, variantId, eraRevision: 1 };
      const story = await owner.post(`${scene.scene}/stories`, {
        requestId: randomUUID(), voiceSourceId: scene.voiceId, view: variantView, title: 'Owner story title', cues: [{ startMs: 0, endMs: 900, text: 'Owner story cue.' }], captionConfirmed: true,
      });
      assert.equal(story.status, 201);
      const storyId = (await story.json()).id;

      const v1 = versionView(1);
      const vv = { id: randomUUID(), kind: 'variant', version: null, variantId };
      const current = (await session.json(`${scene.scene}/collaboration`)).contributions[0];
      const sharedPreview = await (await owner.post(`${scene.scene}/shares/previews`, previewBody([vv], {
        contributionIds: [contribution.id], evidencePhotoIds: [contribution.id], storyIds: [storyId],
        recordings: [{ contributionId: contribution.id, viewIds: [vv.id], targetId: 'place', captionSha256: current.voice.captions.sha256 }],
      }))).json();
      assert.ok(sharedPreview.id, JSON.stringify(sharedPreview));
      const affected = await issue(owner, scene, sharedPreview);
      const pendingPreview = await (await owner.post(`${scene.scene}/shares/previews`, previewBody([vv], { contributionIds: [contribution.id] }))).json();
      const plain = await issue(owner, scene, await (await owner.post(`${scene.scene}/shares/previews`, previewBody([v1]))).json());

      const before = await manifestOf(dataDir, scene);
      const stored = before.collaboration.contributions.find((item) => item.id === contribution.id);
      const secrets = [
        'secret 7Q', stored.textSha256, stored.photo.source.sha256, stored.photo.review.sha256, stored.voice.source.sha256,
        ...stored.voice.captionHistory.map((entry) => entry.sha256), stored.voice.captions.sha256,
      ];
      const unchanged = {
        other: before.collaboration.contributions.find((item) => item.id === other.id),
        plain: before.shares.snapshots.find((snapshot) => snapshot.tokenVerifier === sha256(plain.token)),
      };
      const impact = await (await session.request(scene.deletion(contribution.id))).json();
      assert.deepEqual(impact.impact, { writing: 1, photo: 1, voice: 1, playback: 1, captionVersions: 3, usedInPlace: true, sharedViewsAffected: true });
      const deleteBody = confirm(impact.impactSha256);
      const response = await session.post(scene.remove(contribution.id), deleteBody);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(Object.keys(result), ['contribution']);
      assert.deepEqual(result.contribution, {
        id: contribution.id, kind: 'human_recollection', status: 'deleted', deletedAt: result.contribution.deletedAt,
        deletion: { state: 'complete', completedAt: result.contribution.deletion.completedAt, inventory: impact.impact },
      });

      const raw = await readFile(manifestFile(dataDir, scene), 'utf8');
      for (const secret of secrets) assert.ok(!raw.includes(secret), `on disk: ${secret.slice(0, 12)} near ${raw.slice(Math.max(0, raw.indexOf(secret) - 300), raw.indexOf(secret) + 40)}`);
      assert.ok(!raw.includes('Name secret 7Q'), 'no provider name on disk');
      const after = JSON.parse(raw);
      const tombstone = after.collaboration.contributions.find((item) => item.id === contribution.id);
      assert.deepEqual([tombstone.status, tombstone.photo, tombstone.voice, tombstone.text, tombstone.review.reason, tombstone.reviews], ['deleted', null, null, '', undefined, []]);
      assert.deepEqual(after.collaboration.contributions.find((item) => item.id === other.id), unchanged.other, 'an unrelated contribution is unchanged');
      assert.deepEqual(after.shares.snapshots.find((snapshot) => snapshot.id === unchanged.plain.id), unchanged.plain, 'an unaffected snapshot is unchanged');
      const variant = after.collaboration.variants.find((item) => item.id === variantId);
      assert.deepEqual([variant.label, variant.eraAssertions[0].statement, variant.eraAssertions[0].label, variant.eraAssertions[0].start], ['Contribution removed', '', '', '1999-05-01']);
      const proposal = after.proposals.find((item) => item.id === proposalId);
      assert.deepEqual([proposal.statement.text, proposal.statement.sha256, proposal.result, proposal.question], [null, null, null, null]);
      const savedStory = after.stories.items.find((item) => item.id === storyId);
      assert.deepEqual([savedStory.title, savedStory.cues[0].text, savedStory.context.label, savedStory.context.era.statement], ['Owner story title', 'Owner story cue.', 'Contribution removed', '']);
      const remaining = await readdir(contributionsDir(dataDir, scene));
      assert.ok(!remaining.includes(contribution.id), 'its folder is gone');
      assert.ok(remaining.includes(other.id), 'an unrelated contribution’s folder is kept');
      assert.deepEqual((await readdir(jobDirOf(dataDir, scene))).filter((name) => name.endsWith('.tmp')), []);

      // Access has stopped everywhere.
      for (const route of [scene.photo(contribution.id), scene.recording(contribution.id)]) {
        for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-3' } }]) {
          assert.equal((await owner.request(route, init)).status, 404);
          assert.equal((await session.request(route, init)).status, 404);
        }
      }
      assert.equal((await owner.json(scene.scene)).usageBlocked, true, 'the dependent current version stays blocked');
      assert.equal((await visit(app.base, affected.token)).status, 404);
      assert.equal((await visit(app.base, plain.token)).status, 200, 'an independent snapshot stays available');
      const listed = await owner.json(`${scene.scene}/shares`);
      const removed = listed.find((item) => item.status === 'revoked');
      assert.deepEqual([removed.title, removed.views, removed.removedFor], ['Removed contribution', [], 'contribution-deleted']);
      assert.equal(listed.filter((item) => item.removedFor).length, 1, 'only the affected snapshot is marked');
      const ownerView = await owner.json(`${scene.scene}/collaboration`);
      assert.deepEqual(ownerView.contributions.find((item) => item.id === contribution.id), result.contribution);
      assert.ok(!JSON.stringify(ownerView).includes('secret 7Q') && !JSON.stringify(listed).includes('secret 7Q'));

      // Old requests, each within its own actor, action and target, never recreate anything.
      assert.deepEqual(await (await session.post(scene.remove(contribution.id), { ...deleteBody, impactSha256: '1'.repeat(64) })).json(), result);
      assert.equal((await owner.post(scene.remove(contribution.id), deleteBody)).status, 403);
      const resubmit = await session.request(`${scene.scene}/contributions/bundle`, { method: 'POST', body: submitted.form() });
      assert.equal(resubmit.status, 200);
      assert.deepEqual(await resubmit.json(), result.contribution);
      const replayedCaption = await (await session.post(scene.captions(contribution.id), captionRequest)).json();
      assert.deepEqual(replayedCaption, { contribution: result.contribution, appliedCaptionVersion: 3 });
      const replayedReview = await owner.post(scene.review(contribution.id), reviewRequest);
      assert.equal(replayedReview.status, 200);
      assert.ok(!JSON.stringify(await replayedReview.json()).includes('secret 7Q'));
      assert.equal((await owner.post(`${scene.scene}/variants/${variantId}/era`, eraRequest)).status, 200);
      const { photoReviewed, voiceReviewed, ...plainReview } = reviewRequest;
      assert.equal((await owner.post(scene.review(contribution.id), { ...plainReview, requestId: randomUUID() })).status, 409, 'a new decision is refused');
      assert.equal((await owner.request(`${scene.scene}/shares/previews/${pendingPreview.id}`)).status, 409);
      assert.equal((await owner.post(`${scene.scene}/shares`, { ...affected.body })).status, 409, 'an old issue is never reissued');
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, { ...previewBody([vv]), requestId: pendingPreview.id === null ? randomUUID() : (await manifestOf(dataDir, scene)).shares.previews.find((item) => item.id === pendingPreview.id).requestId })).status, 409, 'an old preview is never rebuilt');
      const final = await manifestOf(dataDir, scene);
      assert.equal(final.collaboration.contributions.length, after.collaboration.contributions.length, 'nothing was recreated');
      assert.ok(!JSON.stringify(final).includes('secret 7Q'));
    } finally {
      await app.close();
    }
  });
});

describe('late writers', () => {
  it('refuses a model result and a story save that were still running when access stopped', async () => {
    const hooks = controls();
    const { app, owner, dataDir } = await workspace(undefined, hooks);
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene, { photo: false });
      assert.equal((await owner.post(scene.review(contribution.id), {
        requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { offset: [0, 0, -0.5], yaw: 0 }, voiceReviewed: true,
      })).status, 200);
      hooks.model.gate = deferred();
      hooks.model.started = deferred();
      const proposed = await (await owner.post(`${scene.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'Late proposal secret 7Q.', consent: true })).json();
      await hooks.model.started.promise;
      hooks.story.gate = deferred();
      hooks.story.started = deferred();
      const storySave = owner.post(`${scene.scene}/stories`, {
        requestId: randomUUID(), voiceSourceId: scene.voiceId, view: { kind: 'version', version: 2, variantId: null, eraRevision: null },
        title: 'Late story', cues: [{ startMs: 0, endMs: 900, text: 'Late cue.' }], captionConfirmed: true,
      });
      await hooks.story.started.promise;

      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      assert.equal((await session.post(scene.remove(contribution.id), confirm(impactSha256))).status, 200);
      hooks.model.gate.resolve();
      hooks.story.gate.resolve();
      assert.equal((await storySave).status, 409, 'the story save is refused');
      for (let attempt = 0; attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      const stored = await manifestOf(dataDir, scene);
      const proposal = stored.proposals.find((item) => item.id === proposed.id);
      assert.deepEqual([proposal.status, proposal.result, proposal.statement.text], ['failed', null, null]);
      assert.equal((stored.stories?.items ?? []).length, 0);
      assert.ok(!JSON.stringify(stored).includes('secret 7Q'));
    } finally {
      await app.close();
    }
  });
});

describe('review findings', () => {
  it('stops a running model call whose stored proposal already became stale, and keeps going when stopping throws', async () => {
    const hooks = controls();
    const { app, owner, dataDir } = await workspace(undefined, hooks);
    const realAbort = AbortController.prototype.abort;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene, { photo: false });
      assert.equal((await owner.post(scene.review(contribution.id), {
        requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { offset: [0, 0, -0.5], yaw: 0 }, voiceReviewed: true,
      })).status, 200);
      hooks.model.gate = deferred();
      hooks.model.started = deferred();
      const proposed = await (await owner.post(`${scene.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'Stale proposal secret 7Q.', consent: true })).json();
      await hooks.model.started.promise;
      // A new version makes the running proposal stale while its call continues.
      assert.equal((await owner.post(`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 2, offset: [0.1, 0, -0.5], yaw: 0 })).status, 200);
      assert.equal((await manifestOf(dataDir, scene)).proposals.find((item) => item.id === proposed.id).status, 'stale');
      const signal = hooks.model.signals.at(-1);
      let attempted = false;
      AbortController.prototype.abort = function abort(...args) {
        if (this.signal === signal) {
          attempted = true;
          realAbort.apply(this, args);
          throw new Error('synthetic abort failure');
        }
        return realAbort.apply(this, args);
      };
      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      const response = await session.post(scene.remove(contribution.id), confirm(impactSha256));
      AbortController.prototype.abort = realAbort;
      assert.equal(response.status, 200, 'a failed stop never undoes or blocks the deletion');
      assert.equal((await response.json()).contribution.deletion.state, 'complete');
      assert.ok(attempted && signal.aborted, 'the stale proposal’s live call was stopped');
      hooks.model.gate.resolve();
      for (let attempt = 0; attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      const stored = (await manifestOf(dataDir, scene)).proposals.find((item) => item.id === proposed.id);
      assert.deepEqual([stored.result, stored.statement.text], [null, null]);
    } finally {
      AbortController.prototype.abort = realAbort;
      hooks.model.gate?.resolve();
      await app.close();
    }
  });

  it('keeps an expired removed preview as a barrier, so its request can never build a new preview', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene, { photo: false, voice: false });
      const v1 = versionView(1);
      const body = previewBody([v1], { contributionIds: [contribution.id] });
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, body)).status, 201);
      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      assert.equal((await session.post(scene.remove(contribution.id), confirm(impactSha256))).status, 200);
      // The removed preview expires, and a later preview prunes expired ones.
      const manifest = await manifestOf(dataDir, scene);
      manifest.shares.previews = manifest.shares.previews.map((item) => ({ ...item, expiresAt: '2000-01-01T00:00:00.000Z' }));
      await writeFile(manifestFile(dataDir, scene), JSON.stringify(manifest, null, 2));
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, previewBody([v1]))).status, 201);
      assert.ok((await manifestOf(dataDir, scene)).shares.previews.some((item) => item.requestId === body.requestId && item.removedFor), 'the barrier is kept');
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, { ...body, contributionIds: [] })).status, 409, 'the old request never builds a new preview');
    } finally {
      await app.close();
    }
  });

  it('skips recovery of a job reached through a symlinked folder or with a symlinked contributions folder, and recovers the others', async () => {
    const { app, owner, dataDir } = await workspace();
    let restarted = null;
    try {
      const linked = await place(owner);
      const parentLinked = await place(owner);
      const safe = await place(owner);
      await app.close();
      // 1. A symlinked draft folder: its story staging and orphan folders are never touched.
      const draftDir = path.join(dataDir, 'reconstructions', linked.draft.id);
      const outsideDraft = path.join(dataDir, 'outside-draft');
      await rename(draftDir, outsideDraft);
      await symlink(outsideDraft, draftDir);
      const outsideJob = path.join(outsideDraft, linked.job.id);
      await mkdir(path.join(outsideJob, 'story-staging'), { recursive: true });
      await writeFile(path.join(outsideJob, 'story-staging', 'sentinel'), 'keep');
      const orphan = path.join(outsideJob, 'contributions', randomUUID());
      await mkdir(orphan, { recursive: true });
      // 2. A symlinked contributions folder inside a real job: its orphans are never swept.
      const outsideContributions = path.join(dataDir, 'outside-contributions');
      const outsideOrphan = path.join(outsideContributions, randomUUID());
      const outsideStaging = path.join(outsideContributions, `.staging-${randomUUID()}-${randomUUID()}`);
      await mkdir(outsideOrphan, { recursive: true });
      await mkdir(outsideStaging, { recursive: true });
      await symlink(outsideContributions, contributionsDir(dataDir, parentLinked));
      // 3. A safe job keeps being recovered.
      const safeOrphan = path.join(contributionsDir(dataDir, safe), randomUUID());
      await mkdir(safeOrphan, { recursive: true });

      ({ app: restarted } = await workspace(dataDir));
      const reopened = client(restarted.base, restarted.cookie);
      assert.equal((await reopened.request(safe.scene)).status, 200);
      assert.equal(await readFile(path.join(outsideJob, 'story-staging', 'sentinel'), 'utf8'), 'keep');
      await readdir(orphan);
      await readdir(outsideOrphan);
      await readdir(outsideStaging);
      await assert.rejects(readdir(safeOrphan), 'the safe job was still recovered');
    } finally {
      if (restarted) await restarted.close();
    }
  });
});

describe('failure, pending cleanup and restart', () => {
  it('keeps nothing changed when the access-stop write fails', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene);
      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      const before = await readFile(manifestFile(dataDir, scene), 'utf8');
      await chmod(jobDirOf(dataDir, scene), 0o500);
      let failed;
      try {
        failed = await session.post(scene.remove(contribution.id), confirm(impactSha256));
      } finally {
        await chmod(jobDirOf(dataDir, scene), 0o700);
      }
      assert.equal(failed.status, 500);
      assert.equal(await readFile(manifestFile(dataDir, scene), 'utf8'), before);
      assert.equal((await (await session.request(scene.deletion(contribution.id))).json()).state, 'present');
      assert.equal((await session.request(scene.recording(contribution.id))).status, 200, 'no access stop was claimed');
    } finally {
      await app.close();
    }
  });

  it('stays pending with an unknown file or symlink, survives restart untouched, and completes after an explicit cleanup retry or restart', async () => {
    const { app, owner, dataDir } = await workspace();
    let second = null;
    let third = null;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene);
      const ownOwner = await submit(owner, scene, { photo: false });
      const folder = path.join(contributionsDir(dataDir, scene), contribution.id);
      const outside = path.join(dataDir, 'outside-sentinel.txt');
      await writeFile(outside, 'sentinel');
      await writeFile(path.join(folder, 'unknown.txt'), 'added by hand');
      await symlink(outside, path.join(folder, 'link'));
      const leftover = path.join(jobDirOf(dataDir, scene), `manifest.json.${randomUUID()}.tmp`);
      await writeFile(leftover, JSON.stringify({ text: 'Crash copy secret 7Q' }));

      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      const response = await (await session.post(scene.remove(contribution.id), confirm(impactSha256))).json();
      assert.deepEqual([response.contribution.status, response.contribution.deletion.state, response.contribution.deletion.completedAt], ['deleted', 'access-stopped', null]);
      assert.deepEqual((await readdir(folder)).sort(), ['link', 'unknown.txt'], 'known media are removed, unknown entries stay');
      await assert.rejects(readFile(leftover), 'the crash copy is removed even while media cleanup is pending');
      assert.equal(await readFile(outside, 'utf8'), 'sentinel');
      assert.equal((await session.request(scene.recording(contribution.id))).status, 404, 'access stopped while cleanup is pending');

      await app.close();
      ({ app: second } = await workspace(dataDir));
      const reopened = client(second.base, second.cookie);
      const pending = (await reopened.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === contribution.id);
      assert.equal(pending.deletion.state, 'access-stopped', 'restart neither completes nor sweeps it');
      assert.deepEqual((await readdir(folder)).sort(), ['link', 'unknown.txt']);
      assert.equal(await readFile(outside, 'utf8'), 'sentinel');

      // The owner removes the hand-added entries; an explicit cleanup retry completes it.
      await rm(path.join(folder, 'unknown.txt'));
      await rm(path.join(folder, 'link'));
      const signedIn = await enrolledContributor(reopened, second.base, scene.draft.id, 'Late visitor');
      assert.equal((await signedIn.session.post(scene.remove(contribution.id), confirm(null))).status, 404, 'another provider still gets nothing');
      const ownerContribution = ownOwner.contribution;
      const ownImpact = await (await reopened.request(scene.deletion(ownerContribution.id))).json();
      assert.equal((await reopened.post(scene.remove(ownerContribution.id), confirm(ownImpact.impactSha256))).status, 200, 'an owner deletes their own contribution');
      await second.close();
      second = null;
      ({ app: third } = await workspace(dataDir));
      const last = client(third.base, third.cookie);
      const done = (await last.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === contribution.id);
      assert.equal(done.deletion.state, 'complete', 'restart resumes and verifies the cleanup');
      assert.deepEqual((await readdir(jobDirOf(dataDir, scene))).filter((name) => name.endsWith('.tmp')), []);
      await assert.rejects(readFile(leftover));
      assert.equal(await readFile(outside, 'utf8'), 'sentinel');
    } finally {
      if (third) await third.close();
      if (second) await second.close();
    }
  });

  it('never follows a symlinked folder on the way to the files, leaving outside content untouched and the deletion pending', async () => {
    const { app, owner, dataDir } = await workspace();
    let restarted = null;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene);
      // The contributions folder is moved outside and replaced by a symlink to it.
      const outside = path.join(dataDir, 'outside-contributions');
      await rename(contributionsDir(dataDir, scene), outside);
      await symlink(outside, contributionsDir(dataDir, scene));
      const outsideFiles = async () => (await readdir(path.join(outside, contribution.id))).sort();
      const before = await outsideFiles();
      assert.ok(before.length >= 4);

      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      const result = await (await session.post(scene.remove(contribution.id), confirm(impactSha256))).json();
      assert.equal(result.contribution.deletion.state, 'access-stopped');
      assert.deepEqual(await outsideFiles(), before, 'nothing outside was removed');
      assert.equal((await session.post(scene.remove(contribution.id), confirm(null))).status, 200);
      assert.deepEqual(await outsideFiles(), before);

      await app.close();
      ({ app: restarted } = await workspace(dataDir));
      const view = (await client(restarted.base, restarted.cookie).json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === contribution.id);
      assert.equal(view.deletion.state, 'access-stopped', 'still pending after restart');
      assert.deepEqual(await outsideFiles(), before);
    } finally {
      if (restarted) await restarted.close();
      else await app.close();
    }
  });

  it('reports access stopped, not complete, when the completion write fails, and completes on retry', async () => {
    const { app, owner, dataDir } = await workspace();
    const original = fs.promises.rename;
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene);
      const other = (await submit((await enrolledContributor(owner, app.base, scene.draft.id, 'Other')).session, scene, { text: 'Other words.', periodClaim: '', photo: false, voice: false })).contribution;
      const leftover = path.join(jobDirOf(dataDir, scene), `manifest.json.${randomUUID()}.tmp`);
      await writeFile(leftover, JSON.stringify({ text: 'Crash copy secret 7Q' }));
      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      // The access-stop write succeeds; the next manifest write (completion) fails.
      let manifestWrites = 0;
      fs.promises.rename = async (from, to) => {
        if (String(to).endsWith(`${path.sep}manifest.json`) && ++manifestWrites === 2) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
        return original(from, to);
      };
      syncBuiltinESMExports();
      const response = await session.post(scene.remove(contribution.id), confirm(impactSha256));
      fs.promises.rename = original;
      syncBuiltinESMExports();
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual([result.contribution.deletion.state, result.contribution.deletion.completedAt], ['access-stopped', null]);
      await assert.rejects(readdir(path.join(contributionsDir(dataDir, scene), contribution.id)), 'the files are already gone');
      await assert.rejects(readFile(leftover), 'the crash copy is already gone');
      assert.deepEqual((await readdir(jobDirOf(dataDir, scene))).filter((name) => name.endsWith('.tmp')), [], 'the failed write left no temporary copy');
      assert.equal((await session.request(scene.recording(contribution.id))).status, 404);
      assert.ok(!(await readFile(manifestFile(dataDir, scene), 'utf8')).includes('secret 7Q'));
      const retried = await (await session.post(scene.remove(contribution.id), confirm(null))).json();
      assert.equal(retried.contribution.deletion.state, 'complete');
      const view = await owner.json(`${scene.scene}/collaboration`);
      assert.equal(view.contributions.find((item) => item.id === other.id).text, 'Other words.', 'an unrelated contribution is intact');
    } finally {
      fs.promises.rename = original;
      syncBuiltinESMExports();
      await app.close();
    }
  });

  it('never follows a symlinked draft folder on the way to the files', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene);
      const draftDir = path.join(dataDir, 'reconstructions', scene.draft.id);
      const outside = path.join(dataDir, 'outside-draft');
      await rename(draftDir, outside);
      await symlink(outside, draftDir);
      const outsideFolder = path.join(outside, scene.job.id, 'contributions', contribution.id);
      const before = (await readdir(outsideFolder)).sort();
      assert.ok(before.length >= 4);
      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      const result = await (await session.post(scene.remove(contribution.id), confirm(impactSha256))).json();
      assert.equal(result.contribution.deletion.state, 'access-stopped');
      assert.deepEqual((await readdir(outsideFolder)).sort(), before, 'nothing was removed through the symlink');
    } finally {
      await app.close();
    }
  });

  it('resumes cleanup only for an existing deletion when asked explicitly', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      const { contribution } = await submit(session, scene);
      const folder = path.join(contributionsDir(dataDir, scene), contribution.id);
      await writeFile(path.join(folder, 'unknown.txt'), 'x');
      const { impactSha256 } = await (await session.request(scene.deletion(contribution.id))).json();
      assert.equal((await (await session.post(scene.remove(contribution.id), confirm(impactSha256))).json()).contribution.deletion.state, 'access-stopped');
      const preview = await (await session.request(scene.deletion(contribution.id))).json();
      assert.deepEqual([preview.state, preview.impactSha256], ['access-stopped', null]);
      await rm(path.join(folder, 'unknown.txt'));
      const retried = await (await session.post(scene.remove(contribution.id), confirm(null))).json();
      assert.equal(retried.contribution.deletion.state, 'complete');
      await assert.rejects(readdir(folder));
    } finally {
      await app.close();
    }
  });
});
