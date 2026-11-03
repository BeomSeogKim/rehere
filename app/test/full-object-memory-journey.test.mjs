import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { Box3, Group, Quaternion, Vector3 } from 'three';
import { expectedInitialPose, fullObjectMotion, validateObjectGlb } from '../full-objects.mjs';
import { encodeMaskPng } from '../public/object-outline-editor.js';
import { syntheticGlb } from './full-object-fixtures.js';
import { jpeg, ownerFetch, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

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
async function fixture(t) {
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
  const steps = [];
  const proposalModel = async (call) => ({ ok: true, model: 'synthetic', usage: null, plan: {
    action: 'rotate', targetId: 'selected-foreground', sourceId: call.sourceId, ...call.alternative,
    delta: null, yawDelta: Math.PI / 2, anchor: null, question: null, reason: 'Synthetic relative turn.', ...steps.shift(),
  } });
  const app = await startOwnerServer({ dataDir, audioDecoder: async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 }), reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject, proposalModel, prepareModelImage: async () => jpeg(40, 30) });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const form = new FormData(); form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png'); form.append('voice', new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)])], { type: 'audio/webm' }), 'voice.webm'); form.append('metadata', JSON.stringify({ photos: [grant], voice: grant }));
  const draft = await read(await ownerFetch(`${app.base}/api/drafts`, { method: 'POST', body: form }), 201);
  const source = draft.sources.find((item) => item.id === draft.photos[0].sourceId);
  const job = await read(await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: source.id, box: [4, 3, 20, 24] }), 202);
  const url = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`;
  const ready = await poll(url, (value) => value.status === 'ready');
  const data = new Uint8Array(1200); for (let y = 3; y < 25; y++) for (let x = 4; x < 20; x++) data[y * 40 + x] = 1;
  const mask = Buffer.from(await encodeMaskPng(data, 40, 30)), outlineId = randomUUID();
  const headers = { 'content-type': 'image/png', 'x-source-id': source.id, 'x-source-sha256': source.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': ready.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '1' };
  await read(await ownerFetch(`${url}/full-object/outlines/${outlineId}`, { method: 'PUT', headers, body: mask }), 201);
  const build = await read(await post(`${url}/full-object/builds`, { requestId: randomUUID(), sourceId: source.id, sourceSha256: source.sha256, outlineId, outlineSha256: sha(mask) }), 202);
  await poll(`${url}/full-object/builds/${build.id}`, (value) => value.status === 'ready');
  await read(await post(`${url}/full-object/builds/${build.id}/confirm`, { requestId: randomUUID(), baseVersion: 1 }), 200);
  const manifestPath = path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json');
  return { app, url, steps, manifestPath, dataDir, draft, mask, build };
}

it('keeps one bound object through baseline, memory review, immutable child and exact replay; holds unsafe moves', async (t) => {
  const f = await fixture(t), main = await read(await ownerFetch(f.url), 200);
  const body = { requestId: randomUUID(), baseVersion: 2 };
  const baseline = await read(await post(`${f.url}/variants/baseline`, body), 201);
  assert.deepEqual(baseline.edit.fullObject, main.edit.fullObject);
  assert.deepEqual(await read(await post(`${f.url}/variants/baseline`, body), 200), baseline);
  assert.equal((await read(await post(`${f.url}/variants/baseline`, { ...body, requestId: randomUUID() }), 200)).id, baseline.id);
  await read(await post(`${f.url}/variants/baseline`, { ...body, baseVersion: 1 }), 409);
  const context = await read(await ownerFetch(`${f.url}/variants/${baseline.id}/revision-context`), 200);
  assert.equal(context.capabilities.front, 'unknown');
  assert.equal(context.edit.fullObject.buildId, main.edit.fullObject.buildId);
  const manual = { requestId: randomUUID(), baseEraRevision: 0, transform: { offset: [0, 0.1, 0], yaw: 0 }, timeMode: 'unknown', confirmed: true };
  assert.equal((await read(await post(`${f.url}/variants/${baseline.id}/revisions`, manual), 400)).motion.status, 'held');
  assert.equal((await read(await post(`${f.url}/variants/${baseline.id}/revisions`, { ...manual, requestId: randomUUID(), transform: { offset: [1.5, 0, 0], yaw: 0 } }), 409)).motion.status, 'held');
  const proposalUrl = `${f.url}/variants/${baseline.id}/proposals`;
  const request = { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', text: 'I remember it turned a quarter turn.', consent: true };
  const proposed = await read(await post(proposalUrl, request), 202);
  const proposal = await poll(`${proposalUrl}/${proposed.id}`, (value) => !['queued', 'processing'].includes(value.status));
  assert.equal(proposal.status, 'ready'); assert.equal(proposal.motion.status, 'checked');
  assert.deepEqual(proposal.candidate.fullObject, baseline.edit.fullObject); assert.equal('motion' in proposal.candidate, false);
  const apply = { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true };
  const saved = await read(await post(`${proposalUrl}/${proposed.id}/apply`, apply), 201);
  assert.equal(saved.variant.parentVersion, 2); assert.equal(saved.variant.edit.version, null);
  assert.equal(saved.variant.era.kind, 'unknown'); assert.deepEqual(saved.variant.edit.fullObject, baseline.edit.fullObject);
  assert.equal(saved.variant.edit.yaw, Math.PI / 2);
  assert.equal((await read(await post(`${proposalUrl}/${proposed.id}/apply`, apply), 200)).variant.id, saved.variant.id);
  await read(await post(`${proposalUrl}/${proposed.id}/apply`, { ...apply, requestId: randomUUID() }), 409);
  const collaboration = await read(await ownerFetch(`${f.url}/collaboration`), 200);
  assert.equal(collaboration.variants.find((item) => item.id === baseline.id).shareMemoryWords, null);
  assert.deepEqual(collaboration.variants.find((item) => item.id === saved.variant.id).shareMemoryWords, { proposalId: proposed.id, statementSha256: sha(request.text), text: request.text });
  assert.deepEqual((await read(await ownerFetch(f.url), 200)).edit, main.edit);
  const manifest = JSON.parse(await readFile(f.manifestPath));
  assert.equal(manifest.collaboration.contributions.length, 0);
  assert.equal(manifest.collaboration.variants.length, 2);
  for (const change of [{ action: 'translate', delta: [0, 0.2, 0], yawDelta: null }, { action: 'face_anchor', yawDelta: null, anchor: { label: 'Window', point: [0.9, 0.5] } }]) {
    f.steps.push(change);
    const queued = await read(await post(proposalUrl, { ...request, requestId: randomUUID() }), 202);
    const held = await poll(`${proposalUrl}/${queued.id}`, (value) => !['queued', 'processing'].includes(value.status));
    assert.equal(held.status, 'clarify'); assert.equal(held.candidate, null); assert.equal(held.motion.status, 'held');
  }
});

it('uses the renderer pivot, scalar, XYZW and yaw order for conservative bounds; touching remains held', () => {
  const bounds = [[-1, -2, -0.5], [2, 1, 3]], initial = { position: [0.3, -0.2, -3], modelPivot: [0.5, -0.5, 1.25], quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.7).toArray(), scale: 0.7 };
  for (const yaw of [-Math.PI, -0.7, 0, 0.4, Math.PI / 2]) {
    const pose = { offset: [0.2, 0, -0.1], yaw }, foreground = new Group(), base = new Group(), centered = new Group();
    foreground.position.fromArray(initial.position).add(new Vector3(...pose.offset)); foreground.rotation.y = yaw;
    base.quaternion.fromArray(initial.quaternion); base.scale.setScalar(initial.scale); centered.position.fromArray(initial.modelPivot).multiplyScalar(-1);
    foreground.add(base); base.add(centered); foreground.updateMatrixWorld(true);
    const box = new Box3(new Vector3(...bounds[0]), new Vector3(...bounds[1])).applyMatrix4(centered.matrixWorld);
    const x = (box.min.x + box.max.x) / 2, y = (box.min.y + box.max.y) / 2, z = (box.min.z + box.max.z) / 2;
    const background = { positions: [x, y, z, x, y + 0.01, z, x, y, z + 0.01], indices: [0, 1, 2] };
    assert.equal(fullObjectMotion(bounds, initial, pose, background).status, 'held');
    background.positions = background.positions.map((n, i) => i % 3 === 0 ? box.max.x + 0.1 : n);
    assert.equal(fullObjectMotion(bounds, initial, pose, background).status, 'checked');
  }
  assert.equal(fullObjectMotion([[-1, -1, -1], [1, 1, 1]], { position: [0, 0, 0], modelPivot: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 },
    { offset: [0, 0, 0], yaw: 0 }, { positions: [1, 0, 0, 1, 0.1, 0, 1, 0, 0.1], indices: [0, 1, 2] }).status, 'held');
});


it('delivers a fixed paired full-object visit with authorized exact bytes, owner words, era and a view-bound synthetic recording', async (t) => {
  const f = await fixture(t);
  const parent = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const proposalUrl = `${f.url}/variants/${parent.id}/proposals`;
  const queued = await read(await post(proposalUrl, { requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', text: 'Synthetic memory: a quarter turn.', consent: true }), 202);
  const proposal = await poll(`${proposalUrl}/${queued.id}`, (value) => value.status === 'ready');
  const { variant: child } = await read(await post(`${proposalUrl}/${queued.id}/apply`, { requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true }), 201);
  const era = { requestId: randomUUID(), baseRevision: 0, kind: 'exact', label: '', start: '1982-01-01', end: '1982-01-01', statement: 'Synthetic owner time assertion.', relation: null, relativeToVariantId: null, confirmed: true };
  const dated = await read(await post(`${f.url}/variants/${child.id}/era`, era), 200);
  assert.equal(dated.eraRevision, 1);
  const story = await read(await post(`${f.url}/stories`, { requestId: randomUUID(), voiceSourceId: f.draft.voice.sourceId,
    view: { kind: 'variant', version: null, variantId: child.id, eraRevision: 1 }, title: 'Synthetic silence',
    cues: [{ startMs: 0, endMs: 900, text: 'Synthetic silence; no speech.' }], captionConfirmed: true }), 201);
  const views = [parent, child].map((item) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: item.id }));
  const request = { requestId: randomUUID(), title: 'Synthetic paired scene', views, startViewId: views[0].id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, storyIds: [story.id],
    memoryWords: { viewId: views[1].id, proposalId: queued.id, statementSha256: proposal.statement.sha256, permission: true } };
  await read(await post(`${f.url}/shares/previews`, { ...request, requestId: randomUUID(), views: [{ ...views[0], kind: 'version', version: 1, variantId: null }, views[1]] }), 400);
  const preview = await read(await post(`${f.url}/shares/previews`, request), 201);
  const publicChild = preview.publicView.views[1];
  assert.deepEqual(publicChild.edit, { offset: [0, 0, 0], yaw: Math.PI / 2 });
  assert.equal(publicChild.fullObject.asset.size, syntheticGlb().length);
  assert.equal(publicChild.fullObject.mask.size, f.mask.length);
  assert.equal(preview.publicView.views[0].era.kind, 'unknown');
  assert.equal(publicChild.era.kind, 'exact');
  assert.equal(preview.publicView.stories[0].viewId, views[1].id);
  const packet = JSON.stringify(preview.publicView);
  for (const privateValue of [f.draft.id, f.build.id, f.dataDir, child.edit.fullObject.outlineId, child.edit.fullObject.sourceId]) assert.equal(packet.includes(privateValue), false);
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const issue = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true };
  const receipt = await read(await post(`${f.url}/shares`, issue), 201);
  const visit = (route = '/api/visit', init = {}) => fetch(`${f.app.base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const visited = await read(await visit(), 200);
  assert.deepEqual(visited.views, preview.publicView.views);
  for (const [name, expected, type] of [['object.glb', syntheticGlb(), 'model/gltf-binary'], ['outline.png', f.mask, 'image/png']]) {
    const route = `/api/visit/assets/${views[1].id}/${name}`;
    const asset = await visit(route); assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), expected);
    const head = await visit(route, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), expected.length);
    const range = await visit(route, { headers: { range: 'bytes=0-7' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), expected.subarray(0, 8));
    assert.equal((await fetch(`${f.app.base}${route}`)).status, 404);
  }
  const surface = await read(await visit(`/api/visit/assets/${views[0].id}/surface.json`), 200);
  assert.deepEqual(surface.source, { image_size: [40, 30] });
  const audioRoute = `/api/visit/stories/${visited.stories[0].id}/audio.wav`;
  assert.equal((await visit(audioRoute)).status, 200);
  await read(await post(`${f.url}/edit`, { requestId: randomUUID(), baseVersion: 2, offset: [0, 0, 0.2], yaw: 0 }), 200);
  assert.deepEqual((await read(await visit(), 200)).views, visited.views);
  const glbPath = path.join(f.dataDir, 'reconstructions', f.draft.id, path.basename(f.url), 'full-object', 'builds', f.build.id, 'object.glb');
  await writeFile(glbPath, Buffer.alloc(syntheticGlb().length));
  for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-7' } }]) assert.equal((await visit(`/api/visit/assets/${views[1].id}/object.glb`, init)).status, 404);
  assert.equal((await visit(audioRoute)).status, 404);
  await writeFile(glbPath, syntheticGlb());
  assert.equal((await visit()).status, 200);
  await read(await post(`${f.url}/shares/${receipt.id}/revoke`, { requestId: randomUUID() }), 200);
  assert.equal((await visit()).status, 404);
  assert.equal((await visit(audioRoute, { headers: { range: 'bytes=0-7' } })).status, 404);
  assert.equal((await visit(`/api/visit/assets/${views[1].id}/outline.png`, { method: 'HEAD' })).status, 404);
});

it('rejects differing immutable bindings even for identical GLB bytes, and applies current source restrictions to historical visits', async (t) => {
  const f = await fixture(t);
  const first = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const scene = await read(await ownerFetch(f.url), 200), binding = first.edit.fullObject, outlineId = randomUUID();
  const headers = { 'content-type': 'image/png', 'x-source-id': binding.sourceId, 'x-source-sha256': binding.sourceSha256, 'x-mask-sha256': sha(f.mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': scene.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '2' };
  await read(await ownerFetch(`${f.url}/full-object/outlines/${outlineId}`, { method: 'PUT', headers, body: f.mask }), 201);
  const next = await read(await post(`${f.url}/full-object/builds`, { requestId: randomUUID(), sourceId: binding.sourceId, sourceSha256: binding.sourceSha256, outlineId, outlineSha256: sha(f.mask) }), 202);
  await poll(`${f.url}/full-object/builds/${next.id}`, (value) => value.status === 'ready');
  await read(await post(`${f.url}/full-object/builds/${next.id}/confirm`, { requestId: randomUUID(), baseVersion: 2 }), 200);
  const second = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 3 }), 201);
  assert.equal(first.edit.fullObject.sha256, second.edit.fullObject.sha256);
  assert.notEqual(first.edit.fullObject.buildId, second.edit.fullObject.buildId);
  const views = [first, second].map((variant) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: variant.id }));
  const request = { requestId: randomUUID(), title: 'Synthetic history', views, startViewId: views[0].id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true };
  await read(await post(`${f.url}/shares/previews`, request), 400);
  const preview = await read(await post(`${f.url}/shares/previews`, { ...request, requestId: randomUUID(), views: [views[0]] }), 201);
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  await read(await post(`${f.url}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true }), 201);
  const visit = (name, init = {}) => fetch(`${f.app.base}/api/visit${name ? `/assets/${views[0].id}/${name}` : ''}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const policyUrl = `${f.app.base}/api/drafts/${f.draft.id}/sources/${binding.sourceId}/policy`;
  const restrict = async (share) => {
    const policy = await read(await ownerFetch(policyUrl), 200);
    await read(await post(policyUrl, { requestId: randomUUID(), baseRevision: policy.revision, permissions: { place: true, model: false, share }, stopUse: false }), 200);
  };
  await restrict(true);
  assert.equal((await visit()).status, 200, 'model-off alone does not revoke deterministic sharing');
  assert.equal((await visit('object.glb')).status, 200);
  await restrict(false);
  assert.equal((await visit()).status, 404);
  for (const name of ['object.glb', 'outline.png']) for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-7' } }]) {
    assert.equal((await visit(name, init)).status, 404);
  }
});

it('refuses an exact full-object issue replay after source stop without replacing its receipt or token', async (t) => {
  const f = await fixture(t);
  const baseline = await read(await post(`${f.url}/variants/baseline`, { requestId: randomUUID(), baseVersion: 2 }), 201);
  const view = { id: randomUUID(), kind: 'variant', version: null, variantId: baseline.id };
  const preview = await read(await post(`${f.url}/shares/previews`, { requestId: randomUUID(), title: 'Synthetic replay', views: [view], startViewId: view.id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true }), 201);
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const issue = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true };
  const receipt = await read(await post(`${f.url}/shares`, issue), 201);
  assert.deepEqual(await read(await post(`${f.url}/shares`, issue), 201), receipt);
  const before = JSON.parse(await readFile(f.manifestPath)).shares.snapshots;
  const policyUrl = `${f.app.base}/api/drafts/${f.draft.id}/sources/${baseline.edit.fullObject.sourceId}/policy`;
  const policy = await read(await ownerFetch(policyUrl), 200);
  await read(await post(policyUrl, { requestId: randomUUID(), baseRevision: policy.revision, permissions: { place: true, model: true, share: true }, stopUse: true }), 200);
  await read(await post(`${f.url}/shares`, issue), 403);
  for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-7' } }]) {
    assert.equal((await fetch(`${f.app.base}/api/visit`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })).status, 404);
  }
  assert.equal(before.length, 1);
  assert.equal(before[0].id, receipt.id);
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath)).shares.snapshots, before);
});
