import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { sourceDependenciesOf } from '../memory-links.mjs';
import { exportStaticVisit } from '../export-static-visit.mjs';
import { client, enrolledContributor, jpeg, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const grant = { provider: 'Synthetic voice, not a witness', origin: { kind: 'public', reference: 'Synthetic test recording' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const read = async (response, status = 200) => { const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; };
const wait = async (owner, route) => {
  for (let i = 0; i < 300; i++) {
    const value = await read(await owner.request(route));
    if (!['queued', 'processing'].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic operation did not finish.');
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const storeManifest = async (f, manifest) => { const temporary = `${f.file}.test`; await writeFile(temporary, JSON.stringify(manifest)); await rename(temporary, f.file); };

// Synthetic media/model seams only; HTTP, retained bytes, permissions,
// lineage, storage, visitor authorization and exact retries are exercised.
async function fixture(t, hooks = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-alternative-sources-'));
  const calls = [], admitted = [];
  const proposalModel = async (call) => {
    calls.push(call);
    await hooks.beforeAdmit?.(call);
    for (const phase of ['count', 'generation']) {
      if (!(await call.admit(() => { admitted.push(phase); return true; }))) return { ok: false, reason: 'restricted' };
    }
    return { ok: true, model: 'synthetic-planner', mode: 'simulated', responseId: 'synthetic-response', usage: null, plan: {
      action: 'rotate', targetId: 'selected-foreground', sourceId: call.sourceId, ...call.alternative,
      delta: null, yawDelta: hooks.unchanged ? 0 : 0.1, anchor: null, question: null, reason: 'Synthetic bounded turn.',
    } };
  };
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, proposalModel, prepareModelImage: async () => jpeg(40, 30),
    audioDecoder: async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 }),
    captionTranscriber: async ({ admit }) => {
      await admit(() => null);
      return { ok: true, cues: [{ startMs: 0, endMs: 1000, text: 'Synthetic drafted words to correct.' }], call: {
        model: 'muse-voice-transcribe-1.0', modelLabel: 'Muse Voice Transcribe', responseOrigin: 'simulated', dispatched: false,
        httpStatus: null, providerRequestId: null, providerSessionId: null, latencyMs: 0, admittedDurationMs: 1000, estimatedUsd: 0,
      } };
    } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = client(app.base, app.cookie), form = new FormData();
  form.append('text', 'Synthetic original place writing.');
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([webm], { type: 'audio/webm' }), 'voice.webm');
  form.append('metadata', JSON.stringify({ photos: [grant], voice: grant, text: grant }));
  const draft = await read(await owner.request('/api/drafts', { method: 'POST', body: form }), 201);
  const job = await read(await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] }), 202);
  const route = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  assert.equal((await wait(owner, route)).status, 'ready');
  const file = path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json');
  return { app, owner, draft, route, file, calls, admitted, dataDir, manifest: async () => JSON.parse(await readFile(file, 'utf8')) };
}

async function contribute(f, label, text) {
  const { session } = await enrolledContributor(f.owner, f.app.base, f.draft.id, label);
  const contribution = await read(await session.post(`${f.route}/contributions`, { requestId: randomUUID(), text, permissions: { place: true, model: true, share: true }, periodClaim: '' }));
  return { contribution, session, ref: { kind: 'contribution-text', contributionId: contribution.id, sourceSha256: sha(text) } };
}
const context = async (f, parent) => read(await f.owner.request(`${f.route}/variants/${parent.id}/revision-context`));
async function propose(f, parent, statementSource, extra = {}) {
  const route = `${f.route}/variants/${parent.id}/proposals`;
  const body = { requestId: randomUUID(), baseEraRevision: parent.eraRevision, targetId: 'selected-foreground', timeMode: 'unknown', statementSource, sourceReviewed: true, consent: true, ...extra };
  const queued = await read(await f.owner.post(route, body), 202);
  return { route, body, proposal: await wait(f.owner, `${route}/${queued.id}`) };
}
async function apply(f, planned) {
  const body = { requestId: randomUUID(), baseEraRevision: planned.body.baseEraRevision, frontConfirmed: false, confirmed: true };
  const route = `${planned.route}/${planned.proposal.id}/apply`;
  return { ...(await read(await f.owner.post(route, body), 201)), body, route };
}
async function share(f, variants, contributionIds = [], storyIds = []) {
  const views = variants.map((variant) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: variant.id }));
  const body = { requestId: randomUUID(), title: 'Synthetic source-chain test', views, startViewId: views[0].id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds, storyIds, synthetic: true };
  const preview = await read(await f.owner.post(`${f.route}/shares/previews`, body), 201);
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const issue = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true };
  await read(await f.owner.post(`${f.route}/shares`, issue), 201);
  return { preview, issue, token, visit: (suffix = '', init = {}) => fetch(`${f.app.base}/api/visit${suffix}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }) };
}
async function policy(f, permissions) {
  const route = `/api/drafts/${f.draft.id}/sources/${f.draft.voice.sourceId}/policy`;
  const current = await read(await f.owner.request(route));
  return read(await f.owner.post(route, { requestId: randomUUID(), baseRevision: current.revision, permissions, stopUse: false }));
}
async function story(f, parent) {
  const view = { kind: 'variant', version: null, variantId: parent.id, eraRevision: parent.eraRevision };
  const { draft } = await read(await f.owner.post(`${f.route}/stories/caption-drafts`, { requestId: randomUUID(), voiceSourceId: f.draft.voice.sourceId, view }), 201);
  assert.equal(draft.confirmed, false);
  assert.equal(draft.call.responseOrigin, 'simulated');
  const cues = [{ startMs: 0, endMs: 1000, text: 'Synthetic owner-corrected spoken memory.' }];
  const saved = await read(await f.owner.post(`${f.route}/stories`, { requestId: randomUUID(), voiceSourceId: f.draft.voice.sourceId, view,
    title: 'Synthetic voice story, not testimony', cues, captionConfirmed: true, captionDraftId: draft.id }), 201);
  const choice = (await context(f, parent)).statementSources.find((item) => item.statementSource.storyId === saved.id);
  assert.ok(choice);
  return { saved, choice, cues };
}

it('saves three contributor-bound children with immutable lineage and inherited withdrawal', async (t) => {
  const f = await fixture(t);
  const people = [];
  for (let i = 1; i <= 3; i++) people.push(await contribute(f, `Synthetic contributor ${i}`, `Synthetic memory ${i}: turn the object slightly.`));
  const initial = await f.manifest(), baseline = initial.collaboration.variants[0];
  assert.equal(baseline.kind, 'baseline');
  assert.deepEqual(baseline.contributionIds, []);
  const children = [];
  let parent = baseline;
  for (const person of people) {
    const choice = (await context(f, parent)).statementSources.find((item) => item.statementSource.contributionId === person.contribution.id);
    assert.deepEqual(choice.statementSource, person.ref);
    const planned = await propose(f, parent, choice.statementSource);
    assert.equal(planned.proposal.status, 'ready');
    assert.equal(planned.proposal.statement.ownerReviewed, true);
    assert.equal(planned.proposal.statement.attribution.providerLabel, person.contribution.provider.displayName);
    assert.equal(planned.proposal.mode, 'simulated');
    const replay = await read(await f.owner.post(planned.route, { ...planned.body, statementSource: { sourceSha256: person.ref.sourceSha256, contributionId: person.ref.contributionId, kind: person.ref.kind } }));
    assert.equal(replay.id, planned.proposal.id);
    const saved = await apply(f, planned);
    assert.equal((await read(await f.owner.post(saved.route, saved.body))).variant.id, saved.variant.id);
    assert.equal(saved.variant.revision.parentVariantId, parent.id);
    assert.equal(saved.variant.revision.proposalId, planned.proposal.id);
    children.push(saved.variant);
    parent = saved.variant;
  }
  const manifest = await f.manifest();
  assert.deepEqual(manifest.edit, initial.edit);
  assert.deepEqual(manifest.edits, initial.edits);
  assert.deepEqual(manifest.collaboration.variants[0], baseline);
  assert.deepEqual(manifest.collaboration.variants.at(-1).sourceDependencies, people.map((item) => item.ref));
  assert.deepEqual(parent.contributionIds, people.map((item) => item.contribution.id));
  assert.deepEqual(f.calls.map((item) => item.text), people.map((item) => item.contribution.text));
  const shared = await share(f, [baseline, ...children], people.map((item) => item.contribution.id));
  const packet = await read(await shared.visit());
  assert.equal(packet.synthetic, true);
  assert.equal(packet.views.at(-1).evidence.arrangement, 'memory');
  assert.equal(packet.views.at(-1).evidence.support.length, 3);
  for (const secret of [f.draft.id, ...people.map((item) => item.contribution.id), 'sourceDependencies', 'statementSource']) assert.equal(JSON.stringify(packet).includes(secret), false);
  const exported = await exportStaticVisit({ origin: f.app.base, token: shared.token, outDir: path.join(f.dataDir, 'static-before-withdrawal'), confirmPublicMaterial: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(exported.outDir, 'data/manifest.json'))), packet);
  const first = people[0];
  await read(await first.session.post(`${f.route}/contributions/${first.contribution.id}/withdraw`, { requestId: randomUUID() }));
  const projected = await read(await f.owner.request(`${f.route}/collaboration`));
  assert.equal(projected.variants.find((item) => item.id === baseline.id).blocked, false);
  for (const child of children) assert.equal(projected.variants.find((item) => item.id === child.id).blocked, true);
  assert.equal((await shared.visit()).status, 404);
  assert.equal((await f.owner.post(`${f.route}/shares`, shared.issue)).status, 409);
  await assert.rejects(exportStaticVisit({ origin: f.app.base, token: shared.token, outDir: path.join(f.dataDir, 'static-after-withdrawal'), confirmPublicMaterial: true }));
  assert.deepEqual(JSON.parse(await readFile(path.join(exported.outDir, 'data/manifest.json'))), packet, 'already exported copies remain frozen');
  assert.equal((await context(f, baseline)).statementSources.some((item) => item.statementSource.contributionId === first.contribution.id), false);
});

it('binds owner-reviewed captions, original voice and simulated receipt through child, grandchild and visitor', async (t) => {
  const f = await fixture(t), person = await contribute(f, 'Synthetic writer', 'Synthetic written recollection.');
  const baseline = (await f.manifest()).collaboration.variants[0];
  const first = await apply(f, await propose(f, baseline, person.ref));
  const spoken = await story(f, first.variant);
  const planned = await propose(f, first.variant, spoken.choice.statementSource);
  assert.equal(planned.proposal.status, 'ready');
  assert.equal(planned.proposal.statement.text, spoken.cues[0].text);
  assert.deepEqual(planned.proposal.statement.attribution.captionDraft, { model: 'muse-voice-transcribe-1.0', label: 'Muse Voice Transcribe', responseOrigin: 'simulated' });
  assert.equal(planned.proposal.statement.attribution.providerLabel, grant.provider);
  assert.equal(planned.proposal.statement.attribution.captionAuthorLabel, 'Synthetic owner');
  const child = await apply(f, planned), grandchild = await apply(f, await propose(f, child.variant, person.ref));
  assert.deepEqual(grandchild.variant.contributionIds, [person.contribution.id]);
  assert.equal(sourceDependenciesOf((await f.manifest()).collaboration.variants.at(-1)).length, 2);
  const shared = await share(f, [first.variant, child.variant, grandchild.variant], [], [spoken.saved.id]);
  const packet = await read(await shared.visit());
  assert.equal(packet.stories[0].providerLabel, grant.provider);
  assert.equal(packet.stories[0].captionDraft.responseOrigin, 'simulated');
  assert.equal(packet.views.at(-1).evidence.support.at(-1).kind, 'reviewed_story');
  assert.equal(packet.views.at(-1).evidence.support.at(-1).providerLabel, grant.provider);
  assert.deepEqual(packet.views.at(-1).evidence.recollections, []);
  const noAudio = await share(f, [child.variant]);
  assert.deepEqual(noAudio.preview.publicView.stories, []);
  assert.equal(JSON.stringify(noAudio.preview.publicView).includes(spoken.cues[0].text), false);
  await policy(f, { place: true, model: false, share: false });
  assert.equal((await context(f, first.variant)).statementSources.find((item) => item.statementSource.storyId === spoken.saved.id).modelAllowed, false);
  assert.equal((await shared.visit()).status, 404);
  assert.equal((await noAudio.visit()).status, 404);
  assert.equal((await f.owner.post(planned.route, { ...planned.body, requestId: randomUUID() })).status, 403);
  await read(await f.owner.post(`${f.route}/stories/${spoken.saved.id}/withdraw`, { requestId: randomUUID() }));
  const projected = await read(await f.owner.request(`${f.route}/collaboration`));
  assert.equal(projected.variants.find((item) => item.id === first.variant.id).blocked, false);
  for (const variant of [child.variant, grandchild.variant]) assert.equal(projected.variants.find((item) => item.id === variant.id).blocked, true);
  assert.equal((await shared.visit()).status, 404);
});

it('refuses unreviewed, stale, forged and unchanged sources without saving a child', async (t) => {
  const f = await fixture(t, { unchanged: true }), person = await contribute(f, 'Synthetic writer', 'Synthetic words.');
  const parent = (await f.manifest()).collaboration.variants[0], route = `${f.route}/variants/${parent.id}/proposals`;
  const body = { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', statementSource: person.ref, consent: true, sourceReviewed: true };
  for (const sourceReviewed of [false, null, 'true', undefined]) await read(await f.owner.post(route, { ...body, sourceReviewed }), 400);
  await read(await f.owner.post(route, { ...body, consent: false }), 403);
  await read(await f.owner.post(route, { ...body, statementSource: { ...person.ref, sourceSha256: '0'.repeat(64) } }), 409);
  await read(await f.owner.post(route, { ...body, text: 'Unbound client replacement' }), 400);
  assert.equal(f.calls.length, 0);
  const planned = await propose(f, parent, person.ref);
  assert.equal(planned.proposal.status, 'failed');
  await read(await f.owner.post(`${planned.route}/${planned.proposal.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 409);
  assert.equal((await f.manifest()).collaboration.variants.length, 1);
  const spoken = await story(f, parent), original = await f.manifest();
  const changed = structuredClone(original); changed.stories.items[0].cues[0].endMs = 999;
  await storeManifest(f, changed);
  await read(await f.owner.post(route, { ...body, requestId: randomUUID(), statementSource: spoken.choice.statementSource }), 409);
  await storeManifest(f, original);
  const playback = path.join(f.dataDir, 'reconstructions', f.draft.id, path.basename(path.dirname(f.file)), 'stories', `${spoken.saved.id}.wav`);
  const playbackBytes = await readFile(playback);
  await rm(playback);
  await read(await f.owner.post(route, { ...body, requestId: randomUUID(), statementSource: spoken.choice.statementSource }), 409);
  await writeFile(playback, playbackBytes);
  const originalVoice = path.join(f.dataDir, 'drafts', f.draft.id, f.draft.voice.name);
  await writeFile(originalVoice, Buffer.alloc(webm.length, 4));
  await read(await f.owner.post(route, { ...body, requestId: randomUUID(), statementSource: spoken.choice.statementSource }), 409);
  assert.equal(f.calls.length, 1);
});

it('stops voice-derived dispatch and apply when original voice model permission is removed', async (t) => {
  const reached = deferred(), release = deferred();
  const f = await fixture(t, { beforeAdmit: async () => { reached.resolve(); await release.promise; } });
  await contribute(f, 'Synthetic seed writer', 'Synthetic baseline seed.');
  const parent = (await f.manifest()).collaboration.variants[0], spoken = await story(f, parent);
  const pending = propose(f, parent, spoken.choice.statementSource);
  await reached.promise;
  await policy(f, { place: true, model: false, share: true });
  release.resolve();
  assert.notEqual((await pending).proposal.status, 'ready');
  assert.deepEqual(f.admitted, []);
  const other = await fixture(t);
  await contribute(other, 'Synthetic seed writer', 'Synthetic baseline seed.');
  const otherParent = (await other.manifest()).collaboration.variants[0], otherStory = await story(other, otherParent);
  const planned = await propose(other, otherParent, otherStory.choice.statementSource);
  await policy(other, { place: true, model: false, share: true });
  await read(await other.owner.post(`${planned.route}/${planned.proposal.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 403);
  assert.equal((await other.manifest()).collaboration.variants.length, 1);
});

it('checks contributor model grant again at dispatch and before apply; deletion blocks all descendants', async (t) => {
  const reached = deferred(), release = deferred();
  const f = await fixture(t, { beforeAdmit: async () => { reached.resolve(); await release.promise; } });
  const person = await contribute(f, 'Synthetic writer', 'Synthetic source to restrict.');
  const parent = (await f.manifest()).collaboration.variants[0];
  const pending = propose(f, parent, person.ref);
  await reached.promise;
  const manifest = await f.manifest(); manifest.collaboration.contributions[0].permissions.model = false;
  await storeManifest(f, manifest);
  release.resolve();
  assert.notEqual((await pending).proposal.status, 'ready');
  assert.deepEqual(f.admitted, []);
  manifest.collaboration.contributions[0].permissions.model = true;
  await storeManifest(f, manifest);
  const planned = await propose(f, parent, person.ref);
  const restricted = await f.manifest(); restricted.collaboration.contributions[0].permissions.model = false;
  await storeManifest(f, restricted);
  await read(await f.owner.post(`${planned.route}/${planned.proposal.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 403);
  restricted.collaboration.contributions[0].permissions.model = true; await storeManifest(f, restricted);
  const child = await apply(f, planned), grandchild = await apply(f, await propose(f, child.variant, person.ref));
  const shared = await share(f, [child.variant, grandchild.variant]);
  const impact = await read(await person.session.request(`${f.route}/contributions/${person.contribution.id}/deletion`));
  await read(await person.session.post(`${f.route}/contributions/${person.contribution.id}/delete`, { requestId: randomUUID(), impactSha256: impact.impactSha256, confirmDeletion: true }));
  assert.equal((await shared.visit()).status, 404);
  const projected = await read(await f.owner.request(`${f.route}/collaboration`));
  for (const variant of [child.variant, grandchild.variant]) assert.equal(projected.variants.find((item) => item.id === variant.id).blocked, true);
  const persisted = await f.manifest();
  assert.equal(persisted.proposals.filter((item) => item.statement.text !== null).length, 0);
  assert.equal(JSON.stringify(persisted.proposals).includes('Synthetic writer'), false);
});

it('keeps attribution redacted when a manual parent dependency is withdrawn but the selected source remains', async (t) => {
  const f = await fixture(t);
  const a = await contribute(f, 'Synthetic parent provider', 'Synthetic manually interpreted parent memory.');
  const b = await contribute(f, 'Synthetic selected provider', 'Synthetic retained source words.');
  const reviewed = await read(await f.owner.post(`${f.route}/contributions/${a.contribution.id}/review`, {
    requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'alternative', reason: 'Synthetic manual placement.', conflict: 'unknown', transform: { offset: [0.1, 0, 0], yaw: 0 },
  }));
  const parent = reviewed.variant;
  assert.deepEqual(parent.contributionIds, [a.contribution.id]);
  assert.equal(Object.hasOwn((await f.manifest()).collaboration.variants.find((item) => item.id === parent.id), 'sourceDependencies'), false);
  const planned = await propose(f, parent, b.ref);
  assert.equal(planned.proposal.statement.attribution.providerLabel, b.contribution.provider.displayName);
  await read(await a.session.post(`${f.route}/contributions/${a.contribution.id}/withdraw`, { requestId: randomUUID() }));
  const projected = await read(await f.owner.request(`${planned.route}/${planned.proposal.id}`));
  assert.equal(projected.redacted, true);
  assert.equal(projected.statement.text, null);
  assert.equal(projected.statement.attribution, null);
  assert.equal(projected.status, 'stale');
  assert.equal(projected.result, null);
  assert.equal(projected.question, null);
  assert.equal(projected.candidate, null);
  assert.deepEqual(projected.statement.source, b.ref, 'the owner-only audit source binding is retained');
  assert.equal(projected.statement.sha256, b.ref.sourceSha256);
  assert.equal(projected.model, 'synthetic-planner');
  assert.equal(projected.responseId, 'synthetic-response');
  assert.equal(projected.mode, 'simulated');
  assert.equal((await context(f, (await f.manifest()).collaboration.variants[0])).statementSources.some((item) => item.statementSource.contributionId === b.contribution.id), true);
});
