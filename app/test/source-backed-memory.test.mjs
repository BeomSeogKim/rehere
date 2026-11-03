import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { expectedInitialPose, validateObjectGlb } from '../full-objects.mjs';
import { encodeMaskPng } from '../public/object-outline-editor.js';
import { parseSourceMetadata } from '../sources.mjs';
import { syntheticGlb } from './full-object-fixtures.js';
import { enrolledContributor, jpeg, ownerFetch, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const post = (url, body) => ownerFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = async (response, status) => { const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
const grant = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };

async function poll(url, done) {
  for (let i = 0; i < 200; i++) {
    const value = await read(await ownerFetch(url), 200);
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic operation did not finish.');
}

// Media/outline and planner seams are synthetic; storage, byte binding,
// source policies, scene geometry, HTTP and atomic replay remain real.
async function fixture(t, hooks = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-journey-'));
  const outline = { bounds: [4, 3, 20, 25], coveredGridIndices: [5] };
  const validator = async ({ maskPath, width, height, gridWidth, gridHeight }) => ({ width, height, maskSha256: sha(await readFile(maskPath)), ...outline, selectedPixels: 352, gridWidth, gridHeight });
  const runFullObject = async ({ imagePath, maskPath, parentSurfacePath, outputDir }) => {
    const bytes = syntheticGlb(), geometry = validateObjectGlb(bytes), surfaceBytes = await readFile(parentSurfacePath);
    const receipt = { representation: 'source-photo-full-object-v1', asset: 'object.glb', sha256: sha(bytes), bytes: bytes.length,
      initial: expectedInitialPose(JSON.parse(surfaceBytes), outline, geometry.bounds),
      model: { id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' },
      input: { sourceSha256: sha(await readFile(imagePath)), outlineSha256: sha(await readFile(maskPath)), parentSurfaceSha256: sha(surfaceBytes) } };
    await writeFile(path.join(outputDir, 'object.glb'), bytes);
    await writeFile(path.join(outputDir, 'object.json'), JSON.stringify(receipt));
    return { exitCode: 0 };
  };
  const steps = [], calls = [];
  const proposalModel = async (call) => {
    calls.push(call.text);
    for (const phase of ['count', 'generation']) {
      await hooks.beforeAdmit?.(phase);
      const admitted = await call.admit(() => { hooks.admitted?.push(phase); return null; });
      if (!admitted) return { ok: false, reason: 'restricted' };
    }
    await hooks.beforeResult?.();
    return ({ ok: true, model: 'synthetic', usage: null, plan: {
    action: 'rotate', targetId: 'selected-foreground', sourceId: call.sourceId, ...call.alternative,
    delta: null, yawDelta: Math.PI / 2, anchor: null, question: null, reason: 'Synthetic relative turn.', ...steps.shift(),
  } }); };
  const app = await startOwnerServer({ dataDir, audioDecoder: async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 }), reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject, proposalModel, prepareModelImage: async () => jpeg(40, 30) });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const words = hooks.words ?? '  Synthetic written source, not historical testimony.\n'.repeat(60);
  const form = new FormData(); form.append('text', words); form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png'); form.append('voice', new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)])], { type: 'audio/webm' }), 'voice.webm'); form.append('metadata', JSON.stringify({ photos: [grant], voice: grant, text: { ...grant, attributedCreator: 'Synthetic author' } }));
  const draft = await read(await ownerFetch(`${app.base}/api/drafts`, { method: 'POST', body: form }), 201);
  const source = draft.sources.find((item) => item.id === draft.photos[0].sourceId);
  const job = await read(await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: source.id, box: [4, 3, 20, 24] }), 202);
  const url = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`;
  const ready = await poll(url, (value) => value.status === 'ready');
  if (hooks.grid) return { app, url, steps, calls, words: draft.text, manifestPath: path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json'), dataDir, draft };
  const data = new Uint8Array(1200); for (let y = 3; y < 25; y++) for (let x = 4; x < 20; x++) data[y * 40 + x] = 1;
  const mask = Buffer.from(await encodeMaskPng(data, 40, 30)), outlineId = randomUUID();
  const headers = { 'content-type': 'image/png', 'x-source-id': source.id, 'x-source-sha256': source.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': ready.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '1' };
  await read(await ownerFetch(`${url}/full-object/outlines/${outlineId}`, { method: 'PUT', headers, body: mask }), 201);
  const build = await read(await post(`${url}/full-object/builds`, { requestId: randomUUID(), sourceId: source.id, sourceSha256: source.sha256, outlineId, outlineSha256: sha(mask) }), 202);
  await poll(`${url}/full-object/builds/${build.id}`, (value) => value.status === 'ready');
  await read(await post(`${url}/full-object/builds/${build.id}/confirm`, { requestId: randomUUID(), baseVersion: 1 }), 200);
  const manifestPath = path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json');
  return { app, url, steps, calls, words: draft.text, manifestPath, dataDir, draft, mask, build };
}


async function propose(f, parent, extra = {}) {
  const statementSource = { sourceId: f.draft.textSourceId, sourceSha256: sha(f.words) };
  const body = { requestId: randomUUID(), baseEraRevision: parent.eraRevision, targetId: 'selected-foreground', timeMode: 'unknown', statementSource, consent: true, ...extra };
  const route = `${f.url}/variants/${parent.id}/proposals`;
  const queued = await read(await post(route, body), 202);
  const proposal = await poll(`${route}/${queued.id}`, (value) => !['queued', 'processing'].includes(value.status));
  return { body, route, proposal };
}
async function restrictText(f, permissions) {
  const route = `${f.app.base}/api/drafts/${f.draft.id}/sources/${f.draft.textSourceId}/policy`;
  const policy = await read(await ownerFetch(route), 200);
  return read(await post(route, { requestId: randomUUID(), baseRevision: policy.revision, permissions, stopUse: false }), 200);
}

it('uses verified whole-source words for an immutable child; new apply needs model while committed replay does not', async (t) => {
  const f = await fixture(t), initial = await read(await ownerFetch(f.url), 200);
  const baseline = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const context = await read(await ownerFetch(`${f.url}/variants/${baseline.id}/revision-context`), 200);
  assert.deepEqual(context.writtenSource, { available: true, reason: null, sourceId: f.draft.textSourceId, sourceSha256: sha(f.words), text: f.words,
    attribution: { creator: 'Synthetic author', originKind: 'public', reference: '' }, modelAllowed: true });
  assert.ok(f.words.length > 2000);
  const first = await propose(f, baseline), second = await propose(f, baseline);
  assert.equal(first.proposal.status, 'ready');assert.equal(second.proposal.status, 'ready');
  assert.deepEqual(f.calls, [f.words, f.words]);
  assert.deepEqual(first.proposal.statement.source, first.body.statementSource);
  assert.equal(first.proposal.statement.sha256, sha(f.words));
  assert.deepEqual(first.proposal.candidate.fullObject, baseline.edit.fullObject);
  await read(await post(first.route, first.body), 200);
  await read(await post(first.route, { ...first.body, statementSource: { ...first.body.statementSource, sourceSha256: '0'.repeat(64) } }), 409);
  await read(await post(first.route, { ...first.body, requestId: randomUUID(), text: 'Unbound client words.' }), 400);
  const apply = { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true };
  const saved = await read(await post(`${first.route}/${first.proposal.id}/apply`, apply), 201);
  assert.deepEqual(saved.variant.edit.fullObject, baseline.edit.fullObject);
  const manifest = JSON.parse(await readFile(f.manifestPath));
  const parentRecord = manifest.collaboration.variants.find((v) => v.id === baseline.id), child = manifest.collaboration.variants.find((v) => v.id === saved.variant.id);
  assert.equal(Object.hasOwn(parentRecord, 'sourceDependencies'), false);
  assert.deepEqual(child.sourceDependencies, [{ kind: 'written-source', ...first.body.statementSource }]);
  await restrictText(f, { place: true, model: false, share: true });
  await read(await post(`${second.route}/${second.proposal.id}/apply`, { ...apply, requestId: randomUUID() }), 403);
  const replay = await read(await post(`${first.route}/${first.proposal.id}/apply`, apply), 200);
  assert.equal(replay.variant.id, saved.variant.id);
  assert.deepEqual((await read(await ownerFetch(f.url), 200)).edit, initial.edit);
  assert.equal((await read(await ownerFetch(`${f.url}/variants/${baseline.id}/revision-context`), 200)).writtenSource.modelAllowed, false);
});

async function savedSourceChild(f) {
  const parent = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const planned = await propose(f, parent);
  assert.equal(planned.proposal.status, 'ready');
  const apply = { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true };
  const { variant: child } = await read(await post(`${planned.route}/${planned.proposal.id}/apply`, apply), 201);
  return { parent, child, planned, apply };
}

it('keeps attribution and geometry source closure through stories, previews, issue replay and visitor GET/HEAD/range even with words omitted', async (t) => {
  const f = await fixture(t), { parent, child, planned, apply } = await savedSourceChild(f);
  const attribution = { creator: 'Synthetic author', originKind: 'public', reference: '' };
  const collaboration = await read(await ownerFetch(`${f.url}/collaboration`), 200);
  assert.deepEqual(collaboration.variants.find((v) => v.id === child.id).shareMemoryWords,
    { proposalId: planned.proposal.id, statementSha256: sha(f.words), text: f.words, attribution });
  const story = await read(await post(`${f.url}/stories`, { requestId: randomUUID(), voiceSourceId: f.draft.voice.sourceId,
    view: { kind: 'variant', version: null, variantId: child.id, eraRevision: 0 }, title: 'Synthetic narration',
    cues: [{ startMs: 0, endMs: 900, text: 'Synthetic silence, not a participant voice.' }], captionConfirmed: true }), 201);
  const views = [parent, child].map((v) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: v.id }));
  const shareBody = { requestId: randomUUID(), title: 'Synthetic source continuity', views, startViewId: views[0].id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, storyIds: [story.id] };
  const closures = [];
  for (const includeWords of [true, false]) {
    const request = { ...shareBody, requestId: randomUUID(), ...(includeWords && { memoryWords: { viewId: views[1].id, proposalId: planned.proposal.id, statementSha256: sha(f.words), permission: true } }) };
    const preview = await read(await post(`${f.url}/shares/previews`, request), 201);
    if (includeWords) assert.deepEqual(preview.publicView.views[1].memoryWords, { text: f.words, attribution });
    else assert.equal(Object.hasOwn(preview.publicView.views[1], 'memoryWords'), false);
    const packet = JSON.stringify(preview.publicView);
    for (const value of [f.draft.textSourceId, f.draft.id, f.dataDir, 'sourceDependencies']) assert.equal(packet.includes(value), false);
    const token = `rhv_${randomBytes(32).toString('base64url')}`;
    const issue = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true };
    await read(await post(`${f.url}/shares`, issue), 201);
    const visit = (route = '/api/visit', init = {}) => fetch(`${f.app.base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
    const visited = await read(await visit(), 200);
    const routes = [`/api/visit/assets/${views[1].id}/object.glb`, `/api/visit/assets/${views[1].id}/outline.png`, `/api/visit/stories/${visited.stories[0].id}/audio.wav`];
    for (const route of routes) for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-7' } }]) assert.equal((await visit(route, init)).status, init.headers ? 206 : 200);
    closures.push({ preview, issue, visit, routes });
  }
  const manifest = JSON.parse(await readFile(f.manifestPath));
  assert.deepEqual(manifest.stories.items[0].context.sourceDependencies, [{ kind: 'written-source', ...planned.body.statementSource }]);
  for (const snapshot of manifest.shares.snapshots) assert.deepEqual(snapshot.frozen.views[1].sourceDependencies, manifest.stories.items[0].context.sourceDependencies);
  await restrictText(f, { place: true, model: false, share: false });
  const privateView = await read(await ownerFetch(`${f.url}/collaboration`), 200);
  assert.equal(privateView.variants.find((v) => v.id === child.id).blocked, false);
  assert.equal(privateView.variants.find((v) => v.id === child.id).shareMemoryWords, null);
  assert.equal((await ownerFetch(`${f.url}/stories/${story.id}/audio.wav`)).status, 200);
  for (const c of closures) {
    assert.equal((await c.visit()).status, 404);
    await read(await post(`${f.url}/shares`, c.issue), 403);
    await read(await ownerFetch(`${f.url}/shares/previews/${c.preview.id}`), 403);
    for (const route of c.routes) for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-7' } }]) assert.equal((await c.visit(route, init)).status, 404);
  }
  await read(await post(`${f.url}/shares/previews`, { ...shareBody, requestId: randomUUID() }), 403);
  await read(await post(`${planned.route}/${planned.proposal.id}/apply`, apply), 200);
  await restrictText(f, { place: false, model: false, share: false });
  const blocked = await read(await ownerFetch(`${f.url}/collaboration`), 200);
  assert.equal(blocked.variants.find((v) => v.id === child.id).blocked, true);
  assert.equal(blocked.variants.find((v) => v.id === parent.id).blocked, false);
  assert.equal((await ownerFetch(`${f.url}/stories/${story.id}/audio.wav`)).status, 409);
  await read(await post(`${planned.route}/${planned.proposal.id}/apply`, apply), 409);
  const context = await read(await ownerFetch(`${f.url}/variants/${parent.id}/revision-context`), 200);
  assert.deepEqual(context.writtenSource, { available: false, reason: 'source', sourceId: f.draft.textSourceId, sourceSha256: null, text: null,
    attribution: { creator: null, originKind: 'unknown', reference: '' }, modelAllowed: false });
});

it('accepts optional creator only on owner text metadata while preserving legacy shapes and limits', () => {
  const counts = { photoCount: 1, hasText: true, hasVoice: true };
  const parse = (text, photo = grant, voice = grant) => parseSourceMetadata(JSON.stringify({ photos: [photo], text, voice }), counts);
  assert.deepEqual(parse(grant).text, grant);
  assert.equal(parse({ ...grant, attributedCreator: '  Synthetic author  ' }).text.attributedCreator, 'Synthetic author');
  assert.equal(Object.hasOwn(parse({ ...grant, attributedCreator: '  ' }).text, 'attributedCreator'), false);
  assert.equal(parse({ ...grant, attributedCreator: 'x'.repeat(121) }), null);
  assert.equal(parse(grant, { ...grant, attributedCreator: 'Photo label' }), null);
  assert.equal(parse(grant, grant, { ...grant, attributedCreator: 'Voice label' }), null);
});

it('inherits source lineage through manual and legacy-text children and rejects malformed or missing derived lineage', async (t) => {
  const f = await fixture(t), { parent, child } = await savedSourceChild(f);
  const manual = await read(await post(`${f.url}/variants/${child.id}/revisions`, { requestId: randomUUID(), baseEraRevision: 0,
    transform: { offset: [0, 0, 0], yaw: 0 }, timeMode: 'unknown', confirmed: true }), 201);
  const legacy = await propose(f, child, { statementSource: undefined, text: 'Synthetic free instruction.' });
  assert.equal(legacy.proposal.status, 'ready');
  const savedLegacy = await read(await post(`${legacy.route}/${legacy.proposal.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 201);
  const stored = JSON.parse(await readFile(f.manifestPath)), refs = stored.collaboration.variants.find((v) => v.id === child.id).sourceDependencies;
  assert.deepEqual(stored.collaboration.variants.find((v) => v.id === manual.id).sourceDependencies, refs);
  assert.deepEqual(stored.collaboration.variants.find((v) => v.id === savedLegacy.variant.id).sourceDependencies, refs);
  const views = [{ id: randomUUID(), kind: 'variant', version: null, variantId: child.id }];
  const share = { title: 'Synthetic corrupted lineage', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true };
  for (const corrupt of [undefined, null, [...refs, ...refs], [{ ...refs[0], sourceId: randomUUID() }], [{ ...refs[0], kind: 'other' }], [{ ...refs[0], sourceSha256: '0'.repeat(64) }]]) {
    const bad = structuredClone(stored), record = bad.collaboration.variants.find((v) => v.id === child.id);
    if (corrupt === undefined) delete record.sourceDependencies; else record.sourceDependencies = corrupt;
    await writeFile(f.manifestPath, JSON.stringify(bad));
    const projected = await read(await ownerFetch(`${f.url}/collaboration`), 200);
    assert.equal(projected.variants.find((v) => v.id === child.id).blocked, true);
    assert.equal(projected.variants.find((v) => v.id === parent.id).blocked, false);
    assert.equal(projected.variants.find((v) => v.id === savedLegacy.variant.id).blocked, true);
    await read(await post(`${f.url}/shares/previews`, { ...share, requestId: randomUUID() }), 404);
  }
});

it('does not admit generation after the source model grant changes between count and generation', async (t) => {
  let reached, release;
  const pending = new Promise((resolve) => { reached = resolve; }), unblock = new Promise((resolve) => { release = resolve; });
  const hooks = { admitted: [], beforeAdmit: async (phase) => { if (phase === 'generation') { reached(); await unblock; } } };
  const f = await fixture(t, hooks), parent = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const body = { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', statementSource: { sourceId: f.draft.textSourceId, sourceSha256: sha(f.words) }, consent: true };
  const route = `${f.url}/variants/${parent.id}/proposals`, queued = await read(await post(route, body), 202);
  await pending;
  await restrictText(f, { place: true, model: false, share: true });
  release();
  const held = await poll(`${route}/${queued.id}`, (p) => !['queued', 'processing'].includes(p.status));
  assert.notEqual(held.status, 'ready');assert.equal(held.candidate, null);assert.deepEqual(hooks.admitted, ['count']);
});

it('discards a late result after source model withdrawal without creating a child', async (t) => {
  let reached, release;
  const pending = new Promise((resolve) => { reached = resolve; }), unblock = new Promise((resolve) => { release = resolve; });
  const hooks = { beforeResult: async () => { reached(); await unblock; } };
  const f = await fixture(t, hooks), parent = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const route = `${f.url}/variants/${parent.id}/proposals`;
  const queued = await read(await post(route, { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', statementSource: { sourceId: f.draft.textSourceId, sourceSha256: sha(f.words) }, consent: true }), 202);
  await pending;await restrictText(f, { place: true, model: false, share: true });release();
  const result = await poll(`${route}/${queued.id}`, (p) => !['queued', 'processing'].includes(p.status));
  assert.notEqual(result.status, 'ready');assert.equal(result.candidate, null);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).collaboration.variants.length, 1);
});

it('accepts the exact 10k retained source without raising the legacy 2k limit, and refuses corrupt source bytes/size/sha', async (t) => {
  const f = await fixture(t, { words: 'Synthetic '.repeat(1000) });
  assert.equal(f.words.length, 10000);
  const { parent, child } = await savedSourceChild(f);
  const route = `${f.url}/variants/${parent.id}/proposals`;
  await read(await post(route, { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', text: 'x'.repeat(2001), consent: true }), 400);
  const draftPath = path.join(f.dataDir, 'drafts', f.draft.id, 'draft.json'), original = JSON.parse(await readFile(draftPath));
  for (const mutate of [d => { d.text = 'Changed retained bytes.'; }, d => { d.sources.find(s => s.id === d.textSourceId).size += 1; }, d => { d.sources.find(s => s.id === d.textSourceId).sha256 = '0'.repeat(64); }]) {
    const bad = structuredClone(original);mutate(bad);await writeFile(draftPath, JSON.stringify(bad));
    const context = await read(await ownerFetch(`${f.url}/variants/${parent.id}/revision-context`), 200);
    assert.equal(context.writtenSource.available, false);assert.equal(context.writtenSource.reason, 'checksum');
    assert.equal(context.writtenSource.text, null);assert.deepEqual(context.writtenSource.attribution, { creator: null, originKind: 'unknown', reference: '' });
    const collab = await read(await ownerFetch(`${f.url}/collaboration`), 200);
    assert.equal(collab.variants.find(v => v.id === child.id).blocked, true);
    await read(await post(route, { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', statementSource: { sourceId: original.textSourceId, sourceSha256: sha(f.words) }, consent: true }), 409);
  }
});

it('keeps a source-backed result stale when its parent era changes before apply', async (t) => {
  const f = await fixture(t), parent = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const planned = await propose(f, parent);
  assert.equal(planned.proposal.status, 'ready');
  await read(await post(`${f.url}/variants/${parent.id}/era`, { requestId: randomUUID(), baseRevision: 0, kind: 'unknown', label: '', start: null, end: null, statement: '', relation: null, relativeToVariantId: null, confirmed: false }), 200);
  const stale = await read(await ownerFetch(`${planned.route}/${planned.proposal.id}`), 200);
  assert.equal(stale.status, 'stale');assert.equal(stale.candidate, null);
  await read(await post(`${planned.route}/${planned.proposal.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 409);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).collaboration.variants.length, 1);
});

it('retains text-only creator metadata through resumable owner intake without changing source text bytes', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-written-intake-'));
  const app = await startOwnerServer({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const text = '  Synthetic source\nwith exact JSON line breaks.  ';
  const metadata = { text: { ...grant, provider: 'Synthetic supplier', attributedCreator: 'Synthetic author' } };
  const request = { requestId: randomUUID(), text, parts: [], metadata };
  const intake = await read(await post(`${app.base}/api/intakes`, request), 201);
  assert.deepEqual((await read(await ownerFetch(`${app.base}/api/intakes/${intake.id}`), 200)).metadata, metadata);
  const receipt = await read(await post(`${app.base}/api/intakes/${intake.id}/commit`, { requestId: randomUUID(), baseRevision: 1 }), 201);
  const draft = await read(await ownerFetch(`${app.base}/api/drafts/${receipt.draftId}`), 200);
  assert.equal(draft.text, text);
  const source = draft.sources.find(s => s.id === draft.textSourceId);
  assert.equal(source.sha256, sha(text));assert.equal(source.attributedCreator, 'Synthetic author');assert.equal(source.provider, 'Synthetic supplier');
});

it('refuses both reconfirm-parent paths when the relative target loses written-source place use, without dispatch or writes', async (t) => {
  const f = await fixture(t), { parent, child: target } = await savedSourceChild(f);
  await read(await post(`${f.url}/variants/${parent.id}/era`, { requestId: randomUUID(), baseRevision: 0,
    kind: 'relative', label: 'Synthetic relation', start: null, end: null, statement: 'Synthetic time statement.',
    relation: 'same-time', relativeToVariantId: target.id, confirmed: true }), 200);
  await restrictText(f, { place: false, model: false, share: false });
  const projected = await read(await ownerFetch(`${f.url}/collaboration`), 200);
  assert.equal(projected.variants.find(v => v.id === target.id).blocked, true);
  const before = await readFile(f.manifestPath), calls = f.calls.length;
  const manual = await post(`${f.url}/variants/${parent.id}/revisions`, { requestId: randomUUID(), baseEraRevision: 1,
    transform: { offset: [0, 0, 0], yaw: -Math.PI / 2 }, timeMode: 'reconfirm-parent', confirmed: true });
  const proposalRoute = `${f.url}/variants/${parent.id}/proposals`;
  const proposal = await post(proposalRoute, { requestId: randomUUID(), baseEraRevision: 1, targetId: 'selected-foreground',
    timeMode: 'reconfirm-parent', text: 'Synthetic legacy instruction', consent: true });
  if (proposal.status === 202) {
    const queued = await proposal.json();
    await poll(`${proposalRoute}/${queued.id}`, p => !['queued', 'processing'].includes(p.status));
  }
  const after = await readFile(f.manifestPath);
  console.log(JSON.stringify({ observation: 'relative-era-written-source-refusal', manual: manual.status, proposal: proposal.status,
    additionalSyntheticPlannerCalls: f.calls.length - calls, manifestBytesUnchanged: before.equals(after) }));
  assert.deepEqual([manual.status, proposal.status], [409, 409]);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(after, before, 'main, baseline, old assertions, variants and receipts stay unchanged');
});

it('gates source-dependent grid issue replay after share withdrawal even when words are unchecked', async (t) => {
  const f = await fixture(t, { grid: true });
  const { session } = await enrolledContributor({ post: (route, body) => post(`${f.app.base}${route}`, body) }, f.app.base, f.draft.id);
  const contribution = await read(await session.post(`${new URL(f.url).pathname}/contributions`, { requestId: randomUUID(),
    text: 'Synthetic contribution', permissions: { place: true, model: true, share: true }, periodClaim: '' }), 200);
  const reviewed = await read(await post(`${f.url}/contributions/${contribution.id}/review`, { requestId: randomUUID(), baseVersion: 1,
    baseRevision: contribution.revision, decision: 'alternative', reason: 'Synthetic review', conflict: 'unknown', transform: { offset: [0.1, 0, 0], yaw: 0 } }), 200);
  const parent = reviewed.variant, planned = await propose(f, parent);
  assert.equal(planned.proposal.status, 'ready');
  const { variant: child } = await read(await post(`${planned.route}/${planned.proposal.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 201);
  assert.equal(Boolean(child.edit.fullObject), false);
  const view = { id: randomUUID(), kind: 'variant', version: null, variantId: child.id };
  const preview = await read(await post(`${f.url}/shares/previews`, { requestId: randomUUID(), title: 'Synthetic grid source', views: [view],
    startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true }), 201);
  assert.equal(Object.hasOwn(preview.publicView.views[0], 'memoryWords'), false);
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const issue = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true };
  const receipt = await read(await post(`${f.url}/shares`, issue), 201);
  const visit = () => fetch(`${f.app.base}/api/visit`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await visit()).status, 200);
  const before = JSON.parse(await readFile(f.manifestPath)).shares.snapshots.find(s => s.id === receipt.id);
  await restrictText(f, { place: true, model: true, share: false });
  const visitorStatus = (await visit()).status;
  const owner = await read(await ownerFetch(`${f.url}/collaboration`), 200);
  assert.equal(owner.variants.find(v => v.id === child.id).blocked, false);
  assert.equal((await ownerFetch(`${f.url}/variants/${child.id}/revision-context`)).status, 200);
  const replay = await post(`${f.url}/shares`, issue);
  console.log(JSON.stringify({ observation: 'grid-source-issue-replay', visitorStatus, replayStatus: replay.status, privateChildUsable: true, wordsUnchecked: true }));
  assert.equal(visitorStatus, 404);assert.equal(replay.status, 403);
  const after = JSON.parse(await readFile(f.manifestPath)).shares.snapshots.find(s => s.id === receipt.id);
  assert.equal(sha(JSON.stringify(after)), sha(JSON.stringify(before)), 'denial preserves receipt and token identity');
});

it('replays identical source references regardless of member order and still refuses changed identity', async (t) => {
  const f = await fixture(t), parent = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const planned = await propose(f, parent);
  const { sourceId, sourceSha256 } = planned.body.statementSource;
  const replay = await post(planned.route, { ...planned.body, statementSource: { sourceSha256, sourceId } });
  console.log(JSON.stringify({ observation: 'source-member-order-replay', firstStatus: 202, replayStatus: replay.status, syntheticPlannerCalls: f.calls.length }));
  assert.equal(replay.status, 200);assert.equal((await replay.json()).id, planned.proposal.id);assert.equal(f.calls.length, 1);
  await read(await post(planned.route, { ...planned.body, statementSource: { sourceId: randomUUID(), sourceSha256 } }), 409);
  await read(await post(planned.route, { ...planned.body, statementSource: { sourceId, sourceSha256: '0'.repeat(64) } }), 409);
  assert.equal(f.calls.length, 1);
});
