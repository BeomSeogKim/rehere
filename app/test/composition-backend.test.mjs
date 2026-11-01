import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { geometrySources } from '../geometry-sources.mjs';
import { objectSurfaceMeshes } from '../public/photo-scene.js';
import { faceObjectPose, quaternionFromEuler } from '../public/composition-scene.js';
import { visitorSurface } from '../shares.mjs';
import { requestBody } from '../meta-model.mjs';
import { sha256 } from '../sources.mjs';
import { client, jpeg, png, startOwnerServer } from './auth-helper.mjs';

const directories = [];
after(() => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));
const ids = ['object-1', 'object-2'];
const grant = { provider: 'Synthetic archive', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const pose = (x, scale = 1) => ({ position: [x, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]), scale });
const confirm = () => ({ requestId: randomUUID(), objectIds: ids, surfaceIdentityConfirmed: true, layoutConfirmed: true, scaleBasis: 'owner-assumed-relative' });
async function jsonResponse(response, status) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

// Signature-only media and deterministic nonplanar grids: storage/physics tests,
// without model inference or real photo-pair recognition.
async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-composition-'));
  directories.push(dataDir);
  let builds = 0;
  const runner = async ({ imagePath, outputDir, sourceId, box }) => {
    builds++;
    const original = await readFile(imagePath), fill = original.at(-1);
    const texture = jpeg(40, 30, fill);
    const surface = {
      source: { source_id: sourceId, sha256: sha256(original), image_size: [40, 30], texture: { file: 'texture.jpg', sha256: sha256(texture) }, selected_object: { box_xyxy: box } },
      width: 8, height: 6, depth: Array.from({ length: 48 }, (_, i) => 3 + Math.sin(i * 0.3) * 0.04),
      foreground: Array.from({ length: 48 }, (_, i) => i % 8 < 3 ? 1 : 0),
      assumptions: { horizontal_fov_degrees: fill === 7 ? 55 : 70, near: 2, far: 5, max_triangle_depth_span: 0.35 },
    };
    const files = { 'surface.json': JSON.stringify(surface), 'texture.jpg': texture, 'depth-preview.png': png(8, 6), 'mask.png': png(40, 30), 'mask-overlay.jpg': texture,
      'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: surface.source.sha256, texture_sha256: sha256(texture) }) };
    await mkdir(outputDir);
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(outputDir, name), bytes);
    return { exitCode: 0 };
  };
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner, ...options });
  const owner = client(app.base, app.cookie), form = new FormData();
  for (const fill of [7, 8]) form.append('photos', new Blob([png(40, 30, fill)]), 'photo.png');
  form.append('voice', new Blob([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant, grant], voice: grant }));
  const draft = await jsonResponse(await owner.request('/api/drafts', { method: 'POST', body: form }), 201);
  const route = `/api/drafts/${draft.id}/reconstructions`, parents = [];
  for (const photo of draft.photos) {
    let parent = await jsonResponse(await owner.post(route, { requestId: randomUUID(), sourceId: photo.sourceId, box: [1, 1, 18, 28] }), 202);
    for (let i = 0; i < 200 && ['queued', 'processing'].includes(parent.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      parent = await owner.json(`${route}/${parent.id}`);
    }
    assert.equal(parent.status, 'ready', parent.error);
    parents.push(parent);
  }
  const request = { kind: 'two-photo-composition', requestId: randomUUID(), objects: parents.map((parent, index) => ({ label: `Component ${index + 1}`,
    component: { jobId: parent.id, objectId: 'selected-foreground', surfaceSha256: parent.derivedAssets.find((item) => item.name === 'surface.json').sha256 }, pose: pose(index ? 3 : -3, index ? 0.7 : 1.1) })),
    context: { keep: true, bounds: [0, 0, 40, 30] }, confirmed: true, scaleBasis: 'owner-assumed-relative' };
  return { app, owner, dataDir, draft, route, parents, request, builds: () => builds };
}
async function composed(f) {
  const scene = await jsonResponse(await f.owner.post(f.route, f.request), 201);
  const route = `${f.route}/${scene.id}`;
  await jsonResponse(await f.owner.post(`${route}/objects/confirm`, confirm()), 200);
  return { scene, route };
}
async function restrict(f, index, permissions) {
  const route = `/api/drafts/${f.draft.id}/sources/${f.draft.photos[index].sourceId}/policy`;
  const current = await f.owner.json(route);
  return jsonResponse(await f.owner.post(route, { requestId: randomUUID(), baseRevision: current.revision, permissions, stopUse: false }), 200);
}
async function shared(f, route, version = 1, extra = {}) {
  const view = { id: randomUUID(), kind: 'version', version, variantId: null };
  const body = { requestId: randomUUID(), title: 'Synthetic composition', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, ...extra };
  const preview = await jsonResponse(await f.owner.post(`${route}/shares/previews`, body), 201);
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const issue = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true };
  await jsonResponse(await f.owner.post(`${route}/shares`, issue), 201);
  return { preview, view, token, issue, body, headers: { authorization: `Bearer ${token}` } };
}

it('composes raw verified geometry from distinct photos, preserves initial poses and exact replay without inference', async () => {
  const f = await fixture();
  try {
    await restrict(f, 1, { place: true, model: false, share: true });
    const scene = await jsonResponse(await f.owner.post(f.route, f.request), 201);
    assert.equal(f.builds(), 2);
    assert.equal(scene.sourceId, undefined);
    assert.equal(scene.objectsConfirmed, false);
    assert.equal(scene.modelBlocked, true);
    assert.deepEqual(scene.edit, scene.initialArrangement);
    assert.deepEqual(geometrySources(scene).map((item) => item.sourceId), f.draft.photos.map((photo) => photo.sourceId));
    assert.deepEqual(scene.derivedAssets.map((item) => item.name), ['surface.json', 'texture-1.jpg', 'texture-2.jpg']);
    const route = `${f.route}/${scene.id}`;
    const surface = await f.owner.json(`${route}/assets/surface.json`), meshes = objectSurfaceMeshes(surface);
    for (const [index, part] of meshes.objects.entries()) {
      const parent = await f.owner.json(`${f.route}/${f.parents[index].id}/assets/surface.json`);
      assert.deepEqual(part.positions, objectSurfaceMeshes(parent).objects[0].positions);
      assert.deepEqual(part.pivot, [0, 0, 0]);
    }
    assert.notEqual(surface.components[0].surface.assumptions.horizontal_fov_degrees, surface.components[1].surface.assumptions.horizontal_fov_degrees);
    assert.notEqual(scene.derivedAssets[1].sha256, scene.derivedAssets[2].sha256);
    assert.equal((await jsonResponse(await f.owner.post(f.route, f.request), 200)).id, scene.id);
    await jsonResponse(await f.owner.post(f.route, { ...f.request, context: { keep: false, bounds: null } }), 409);
    await jsonResponse(await f.owner.post(`${route}/objects/confirm`, { requestId: randomUUID(), objectIds: ids }), 400);
    await jsonResponse(await f.owner.post(`${route}/objects/confirm`, confirm()), 200);
    const next = pose(-3.5, 0.9), editRequest = { requestId: randomUUID(), baseVersion: 1, targetId: ids[0], pose: next };
    const edit = await jsonResponse(await f.owner.post(`${route}/edit`, editRequest), 200);
    assert.deepEqual(edit.objects[0], { id: ids[0], ...next });
    assert.deepEqual(edit.objects[1], scene.edit.objects[1]);
    const history = await f.owner.json(`${route}/history`);
    assert.deepEqual(history[0].objects, scene.initialArrangement.objects);
    const undo = await jsonResponse(await f.owner.post(`${route}/undo`, { requestId: randomUUID(), baseVersion: 2, targetVersion: 1, ruleChangeConfirmed: false }), 200);
    assert.deepEqual(undo.objects, scene.initialArrangement.objects);
    assert.deepEqual((await f.owner.json(`${route}/assets/surface.json`)).context, surface.context);
  } finally { await f.app.close(); }
});

it('freezes both-source visitor assets and historical poses without private IDs, then blocks all uses of either restricted source', async () => {
  const f = await fixture();
  try {
    const { scene, route } = await composed(f), share = await shared(f, route);
    const packet = share.preview.publicView;
    assert.equal(packet.representation, scene.representation);
    assert.equal(packet.scaleBasis, 'owner-assumed-relative');
    assert.deepEqual(packet.objects.map((item) => item.sourceIndex), [1, 2]);
    assert.equal(packet.views[0].evidence.photo, undefined);
    assert.equal(packet.views[0].evidence.photos.length, 2);
    assert.deepEqual(packet.views[0].edit.objects, scene.initialArrangement.objects);
    const publicSurface = await jsonResponse(await f.owner.request(`/api/visit/assets/${share.view.id}/surface.json`, { headers: share.headers }), 200);
    const publicText = JSON.stringify([packet, publicSurface]);
    for (const forbidden of [...f.draft.sources.map((item) => item.id), ...f.parents.map((item) => item.id), ...f.parents.map((item) => item.sourceSha256)]) assert.equal(publicText.includes(forbidden), false);
    for (const name of ['texture-1.jpg', 'texture-2.jpg']) assert.equal((await f.owner.request(`/api/visit/assets/${share.view.id}/${name}`, { headers: share.headers })).status, 200);
    const editRequest = { requestId: randomUUID(), baseVersion: 1, targetId: ids[0], pose: pose(-3.8, 1.2) };
    await jsonResponse(await f.owner.post(`${route}/edit`, editRequest), 200);
    assert.deepEqual((await jsonResponse(await f.owner.request('/api/visit', { headers: share.headers }), 200)).views[0].edit.objects, scene.initialArrangement.objects);
    await restrict(f, 1, { place: false, model: false, share: false });
    for (const endpoint of [`${route}/assets/surface.json`, `${route}/assets/texture-1.jpg`, `${route}/history`]) assert.ok((await f.owner.request(endpoint)).status >= 400);
    for (const [endpoint, body] of [[`${route}/edit`, editRequest], [f.route, f.request], [`${route}/shares/previews`, share.body], [`${route}/shares`, share.issue]]) assert.ok((await f.owner.post(endpoint, body)).status >= 400);
    assert.equal((await f.owner.request('/api/visit', { headers: share.headers })).status, 404);
    assert.equal((await f.owner.request(`/api/visit/assets/${share.view.id}/texture-1.jpg`, { headers: share.headers })).status, 404);
    const policy = await f.owner.json(`/api/drafts/${f.draft.id}/sources/${f.draft.photos[1].sourceId}/policy`);
    assert.equal(policy.impacts.scenes, 2);
    assert.equal(policy.impacts.snapshots, 1);
  } finally { await f.app.close(); }
});

it('refuses stale parent hashes, duplicate photos, nonunit poses and overlapping actual meshes without publishing a child', async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      (body) => { body.objects[1].component = { ...body.objects[0].component }; },
      (body) => { body.objects[1].component.surfaceSha256 = '0'.repeat(64); },
      (body) => { body.objects[0].pose.quaternion = [0, 0, 0, 0]; },
      (body) => { body.objects[1].pose = structuredClone(body.objects[0].pose); },
    ]) {
      const body = structuredClone(f.request); body.requestId = randomUUID(); mutate(body);
      assert.ok((await f.owner.post(f.route, body)).status >= 400);
    }
    assert.equal((await f.owner.json(f.route)).length, 2);
    assert.deepEqual(await readdir(path.join(f.dataDir, 'reconstruction-staging')), []);
  } finally { await f.app.close(); }
});

it('rejects out-of-photo or empty observed context as input errors without an uncertain save', async () => {
  const f = await fixture();
  try {
    for (const bounds of [[0, 0, 41, 30], [0, 0, 5, 5]]) {
      const body = { ...f.request, requestId: randomUUID(), context: { keep: true, bounds } };
      for (let replay = 0; replay < 2; replay++) {
        const error = await jsonResponse(await f.owner.post(f.route, body), 400);
        assert.doesNotMatch(error.error, /retry|could not be saved/i);
      }
      assert.equal((await f.owner.json(f.route)).length, 2);
      assert.deepEqual(await readdir(path.join(f.dataDir, 'reconstruction-staging')), []);
    }
    await jsonResponse(await f.owner.post(f.route, f.request), 201);
  } finally { await f.app.close(); }
});

it('keeps scale and whole arrangements through contribution alternatives, adoption, eras and stories', async () => {
  const audioDecoder = async () => ({ pcm: Buffer.alloc(32_000), durationMs: 1000, sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
  const f = await fixture({ audioDecoder });
  try {
    const { scene, route } = await composed(f);
    const contribution = await jsonResponse(await f.owner.post(`${route}/contributions`, { requestId: randomUUID(), text: 'Synthetic recollection', periodClaim: '', permissions: { place: true, model: false, share: true } }), 200);
    const review = (decision, x) => ({ requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision, reason: 'Synthetic owner choice', conflict: 'unknown',
      transform: { targetId: ids[0], pose: { position: [x, 0.2, -3.1], quaternion: quaternionFromEuler([0.2, 0.3, 0.1]) } } });
    const alternative = await jsonResponse(await f.owner.post(`${route}/contributions/${contribution.id}/review`, review('alternative', -3.7)), 200);
    assert.equal(alternative.variant.edit.frame, 'owner-composition');
    assert.equal(alternative.variant.edit.objects[0].scale, scene.edit.objects[0].scale);
    assert.deepEqual(alternative.variant.edit.objects[1], scene.edit.objects[1]);
    const era = { requestId: randomUUID(), baseRevision: 0, kind: 'relative', label: 'Owner assumed period', start: null, end: null, statement: 'Synthetic time assertion', relation: null, relativeToVariantId: null, confirmed: true };
    const dated = await jsonResponse(await f.owner.post(`${route}/variants/${alternative.variant.id}/era`, era), 200);
    assert.equal(dated.eraRevision, 1);
    const nextContribution = await jsonResponse(await f.owner.post(`${route}/contributions`, { requestId: randomUUID(), text: 'Second synthetic recollection', periodClaim: '', permissions: { place: true, model: false, share: true } }), 200);
    const adoptRequest = review('adopt', -3.9);
    const adopted = await jsonResponse(await f.owner.post(`${route}/contributions/${nextContribution.id}/review`, adoptRequest), 200);
    assert.equal(adopted.edit.objects[0].scale, scene.edit.objects[0].scale);
    assert.deepEqual(adopted.edit.objects[1], scene.edit.objects[1]);
    const storyBody = { requestId: randomUUID(), voiceSourceId: f.draft.voice.sourceId, view: { kind: 'version', version: 1, variantId: null, eraRevision: null }, targetId: ids[1], title: 'Synthetic story', cues: [{ startMs: 0, endMs: 500, text: 'Synthetic caption' }], captionConfirmed: true };
    const story = await jsonResponse(await f.owner.post(`${route}/stories`, storyBody), 201);
    const stored = JSON.parse(await readFile(path.join(f.dataDir, 'reconstructions', f.draft.id, scene.id, 'manifest.json'), 'utf8'));
    assert.deepEqual(stored.stories.items[0].context.photos, geometrySources(scene));
    assert.deepEqual(stored.stories.items[0].context.edit.objects, scene.edit.objects);
    const share = await shared(f, route, 1, { storyIds: [story.id] });
    assert.equal((await f.owner.request(`${route}/stories/${story.id}/audio.wav`)).status, 200);
    await restrict(f, 0, { place: false, model: false, share: false });
    assert.equal((await f.owner.json(`${route}/stories/${story.id}`)).available, false);
    assert.ok((await f.owner.post(`${route}/contributions/${nextContribution.id}/review`, adoptRequest)).status >= 400);
    assert.ok((await f.owner.request(`${route}/stories/${story.id}/audio.wav`)).status >= 400);
    assert.equal((await f.owner.request('/api/visit', { headers: share.headers })).status, 404);
  } finally { await f.app.close(); }
});

it('prepares exactly two permitted model contexts and preserves quaternion tilt and scale on proposal apply', async () => {
  const calls = [];
  const proposalModel = async (call) => {
    calls.push(call);
    const outbound = requestBody(call);
    assert.equal(JSON.stringify(outbound).match(/data:image\/jpeg;base64,/g)?.length, 2);
    return { ok: true, plan: { action: 'translate', targetId: call.targetId, sourceIds: call.sourceIds, baseVersion: call.baseVersion, delta: [-0.3, 0.1, 0], yawDelta: null, faceObjectId: null, question: null, reason: 'Synthetic plan' } };
  };
  const prepared = [];
  const f = await fixture({ proposalModel, prepareModelImage: async (call) => { prepared.push(call.imagePath); return jpeg(40, 30); } });
  try {
    const { scene, route } = await composed(f);
    const requested = { requestId: randomUUID(), baseVersion: 1, targetId: ids[0], text: 'Move the first component', consent: true };
    let proposal = await jsonResponse(await f.owner.post(`${route}/proposals`, requested), 202);
    for (let i = 0; i < 200 && ['queued', 'processing'].includes(proposal.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      proposal = await f.owner.json(`${route}/proposals/${proposal.id}`);
    }
    assert.equal(proposal.status, 'ready', proposal.error);
    assert.equal(prepared.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sourceId, undefined);
    assert.deepEqual(calls[0].images.map((item) => item.sourceId), geometrySources(scene).map((item) => item.sourceId));
    assert.deepEqual(calls[0].arrangement, scene.edit);
    const edit = await jsonResponse(await f.owner.post(`${route}/proposals/${proposal.id}/apply`, { requestId: randomUUID(), baseVersion: 1, frontConfirmed: false }), 200);
    assert.equal(edit.edit.objects[0].scale, scene.edit.objects[0].scale);
    assert.deepEqual(edit.edit.objects[0].quaternion, scene.edit.objects[0].quaternion);
    assert.deepEqual(edit.edit.objects[1], scene.edit.objects[1]);
    await restrict(f, 1, { place: true, model: false, share: true });
    assert.equal((await f.owner.post(`${route}/proposals`, { ...requested, requestId: randomUUID(), baseVersion: 2 })).status, 403);
    assert.equal(calls.length, 1);
    assert.equal((await f.owner.request(`${route}/assets/texture-1.jpg`)).status, 200);
    await shared(f, route, 2);
  } finally { await f.app.close(); }
});

it('checks full quaternion facing rules and refuses manual and alternative writers that break the retained rule', async () => {
  const f = await fixture();
  try {
    const { scene, route } = await composed(f);
    const facing = faceObjectPose(scene.edit.objects[0], scene.edit.objects[1].position);
    await jsonResponse(await f.owner.post(`${route}/edit`, { requestId: randomUUID(), baseVersion: 1, targetId: ids[0], pose: facing }), 200);
    const rule = { kind: 'faces', subjectId: ids[0], targetId: ids[1], frame: 'owner-composition', frontBasis: 'owner-confirmed-photographed-side' };
    await jsonResponse(await f.owner.post(`${route}/relationship`, { requestId: randomUUID(), baseVersion: 2, relationship: rule, confirmed: true }), 200);
    await jsonResponse(await f.owner.post(`${route}/edit`, { requestId: randomUUID(), baseVersion: 3, targetId: ids[0], pose: pose(-3, 1.1) }), 409);
    const c = await jsonResponse(await f.owner.post(`${route}/contributions`, { requestId: randomUUID(), text: 'Synthetic conflicting orientation', periodClaim: '', permissions: { place: true, model: false, share: true } }), 200);
    await jsonResponse(await f.owner.post(`${route}/contributions/${c.id}/review`, { requestId: randomUUID(), baseVersion: 3, baseRevision: 1, decision: 'alternative', reason: '', conflict: 'unknown', transform: { targetId: ids[0], pose: { position: facing.position, quaternion: [0, 0, 0, 1] } } }), 409);
    assert.equal((await f.owner.json(route)).edit.version, 3);
  } finally { await f.app.close(); }
});

it('blocks model dispatch when the second source is restricted during image preparation', async () => {
  let release, reached;
  const held = new Promise((resolve) => { release = resolve; }), entered = new Promise((resolve) => { reached = resolve; });
  let prepared = 0, called = 0;
  const f = await fixture({ prepareModelImage: async () => { prepared++; if (prepared === 2) { reached(); await held; } return jpeg(40, 30); }, proposalModel: async () => { called++; return { ok: false }; } });
  try {
    const { route } = await composed(f);
    const proposal = await jsonResponse(await f.owner.post(`${route}/proposals`, { requestId: randomUUID(), baseVersion: 1, targetId: ids[0], text: 'Synthetic request', consent: true }), 202);
    await entered;
    const saved = await restrict(f, 1, { place: true, model: false, share: true });
    assert.equal(saved.cancellation.requested, true);
    release();
    let current;
    for (let i = 0; i < 200; i++) {
      current = await f.owner.json(`${route}/proposals/${proposal.id}`);
      if (!['queued', 'processing'].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(called, 0);
    assert.notEqual(current.status, 'ready');
  } finally { release(); await f.app.close(); }
});

it('rechecks both sources at atomic publication and leaves no partial child after a storage fault or late restriction', async () => {
  const f = await fixture();
  const originalWrite = fs.promises.writeFile;
  try {
    fs.promises.writeFile = async (file, ...args) => {
      if (String(file).includes('/child/manifest.json.')) throw Object.assign(new Error('Synthetic storage fault'), { code: 'ENOSPC' });
      return originalWrite(file, ...args);
    };
    syncBuiltinESMExports();
    await jsonResponse(await f.owner.post(f.route, f.request), 503);
    assert.equal((await f.owner.json(f.route)).length, 2);
    fs.promises.writeFile = originalWrite; syncBuiltinESMExports();
    let release, reached;
    const held = new Promise((resolve) => { release = resolve; }), entered = new Promise((resolve) => { reached = resolve; });
    fs.promises.writeFile = async (file, ...args) => {
      if (String(file).endsWith('/child/assets/texture-2.jpg')) { reached(); await held; }
      return originalWrite(file, ...args);
    };
    syncBuiltinESMExports();
    const saving = f.owner.post(f.route, f.request);
    await entered;
    await restrict(f, 1, { place: false, model: false, share: false });
    release();
    assert.ok((await saving).status >= 400);
    assert.equal((await f.owner.json(f.route)).length, 2);
    assert.deepEqual(await readdir(path.join(f.dataDir, 'reconstruction-staging')), []);
  } finally { fs.promises.writeFile = originalWrite; syncBuiltinESMExports(); await f.app.close(); }
});

it('retains exact poses and frozen visits across restart, and fails closed on a changed second texture or original', async () => {
  const f = await fixture();
  let app = f.app;
  try {
    const { scene, route } = await composed(f), share = await shared(f, route);
    await app.close();
    app = await startOwnerServer({ dataDir: f.dataDir });
    const owner = client(app.base, app.cookie);
    assert.deepEqual((await owner.json(route)).initialArrangement, scene.initialArrangement);
    assert.equal((await owner.request('/api/visit', { headers: share.headers })).status, 200);
    const second = path.join(f.dataDir, 'reconstructions', f.draft.id, scene.id, 'assets/texture-2.jpg');
    const bytes = await readFile(second);
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 4] ^= 1;
    await writeFile(second, corrupt);
    assert.equal((await owner.request('/api/visit', { headers: share.headers })).status, 404);
    await writeFile(second, bytes);
    const original = path.join(f.dataDir, 'drafts', f.draft.id, f.draft.photos[1].name);
    const image = await readFile(original); image[image.length - 1] ^= 1; await writeFile(original, image);
    assert.equal((await owner.request('/api/visit', { headers: share.headers })).status, 404);
    assert.ok((await owner.post(route + '/edit', { requestId: randomUUID(), baseVersion: 1, targetId: ids[0], pose: pose(-4) })).status >= 400);
  } finally { await app.close(); }
});

it('sanitizes unselected embedded parent labels and boxes while keeping renderable depth and the selected source box', () => {
  const parent = { schema_version: 2, width: 2, height: 2, depth: [3, 3, 3, 3], regions: [0, 1, 2, 0],
    source: { image_size: [40, 30], source_id: randomUUID(), sha256: 'a'.repeat(64), selected_objects: ['private'] },
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
    objects: [{ id: ids[0], label: 'Private selected old label', box_xyxy: [1, 1, 10, 10] }, { id: ids[1], label: 'Private unselected old label', box_xyxy: [20, 15, 35, 25] }] };
  const composition = { schema_version: 3, representation: 'two-photo-composition-v1', context: null, components: ids.map((id, index) => ({ id, label: `Public ${index}`, selectedObjectId: ids[0], texture: `texture-${index + 1}.jpg`, surface: parent })) };
  const result = visitorSurface(composition), text = JSON.stringify(result);
  assert.equal(text.includes('Private'), false);
  assert.equal(text.includes('selected_objects'), false);
  assert.equal(text.includes(parent.source.source_id), false);
  assert.deepEqual(result.components[0].surface.objects[0].box_xyxy, [1, 1, 10, 10]);
  assert.deepEqual(result.components[0].surface.objects[1].box_xyxy, [0, 0, 40, 30]);
  assert.deepEqual(result.components[0].surface.depth, parent.depth);
});

it('aborts a precommit shutdown without a child, and resolves a complete child after shutdown during the final rename', async () => {
  for (const boundary of ['before-commit', 'rename-started']) {
    const f = await fixture();
    const originalWrite = fs.promises.writeFile, originalRename = fs.promises.rename;
    let release, reached, stopped = false;
    const held = new Promise((resolve) => { release = resolve; }), entered = new Promise((resolve) => { reached = resolve; });
    try {
      if (boundary === 'before-commit') fs.promises.writeFile = async (file, ...args) => {
        if (String(file).endsWith('/child/assets/texture-2.jpg')) { reached(); await held; }
        return originalWrite(file, ...args);
      };
      else fs.promises.rename = async (from, ...args) => {
        if (String(from).endsWith('/child')) { reached(); await held; }
        return originalRename(from, ...args);
      };
      syncBuiltinESMExports();
      const saving = f.owner.post(f.route, f.request);
      await entered;
      const closing = f.app.close();
      release();
      const response = await saving;
      assert.equal(response.status, boundary === 'before-commit' ? 503 : 201, boundary);
      await closing; stopped = true;
      fs.promises.writeFile = originalWrite; fs.promises.rename = originalRename; syncBuiltinESMExports();
      const restarted = await startOwnerServer({ dataDir: f.dataDir });
      try {
        const owner = client(restarted.base, restarted.cookie);
        const jobs = await owner.json(f.route);
        assert.equal(jobs.length, boundary === 'before-commit' ? 2 : 3);
        if (boundary === 'rename-started') assert.equal((await jsonResponse(await owner.post(f.route, f.request), 200)).id, jobs.find((job) => job.representation).id);
      } finally { await restarted.close(); }
    } finally {
      release(); fs.promises.writeFile = originalWrite; fs.promises.rename = originalRename; syncBuiltinESMExports();
      if (!stopped) await f.app.close();
    }
  }
});

it('holds intersecting composition edits, alternatives, adoptions and model plans at the actual visible-mesh gate', async () => {
  let targetPosition;
  const proposalModel = async (call) => ({ ok: true, plan: { action: 'translate', targetId: ids[1], sourceIds: call.sourceIds, baseVersion: call.baseVersion,
    delta: targetPosition.map((value, index) => value - call.saved.position[index]), yawDelta: null, faceObjectId: null, question: null, reason: 'Synthetic overlap' } });
  const f = await fixture({ proposalModel, prepareModelImage: async () => jpeg(40, 30) });
  try {
    const { scene, route } = await composed(f);
    targetPosition = scene.edit.objects[0].position;
    const before = await readFile(path.join(f.dataDir, 'reconstructions', f.draft.id, scene.id, 'manifest.json'));
    const poseBody = { ...f.request.objects[1].pose, position: [...targetPosition] };
    const manual = await jsonResponse(await f.owner.post(`${route}/edit`, { requestId: randomUUID(), baseVersion: 1, targetId: ids[1], pose: poseBody }), 409);
    assert.match(manual.error, /surface|overlap|intersect/i);
    assert.deepEqual(await readFile(path.join(f.dataDir, 'reconstructions', f.draft.id, scene.id, 'manifest.json')), before);
    const c = await jsonResponse(await f.owner.post(`${route}/contributions`, { requestId: randomUUID(), text: 'Synthetic intersecting placement', periodClaim: '', permissions: { place: true, model: true, share: true } }), 200);
    for (const decision of ['alternative', 'adopt']) {
      const result = await jsonResponse(await f.owner.post(`${route}/contributions/${c.id}/review`, { requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision, reason: '', conflict: 'unknown', transform: { targetId: ids[1], pose: { position: targetPosition, quaternion: poseBody.quaternion } } }), 409);
      assert.match(result.error, /surface|overlap|intersect/i);
    }
    let proposal = await jsonResponse(await f.owner.post(`${route}/proposals`, { requestId: randomUUID(), baseVersion: 1, targetId: ids[1], text: 'Synthetic intersecting move', consent: true }), 202);
    for (let i = 0; i < 200 && ['queued', 'processing'].includes(proposal.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5)); proposal = await f.owner.json(`${route}/proposals/${proposal.id}`);
    }
    assert.equal(proposal.status, 'failed');
    assert.match(proposal.error, /surface|overlap|intersect/i);
    assert.equal((await f.owner.json(route)).edit.version, 1);
  } finally { await f.app.close(); }
});

it('reviews and deletes a place containing a composition and both originals, retaining the deletion barrier after restart', async () => {
  const f = await fixture();
  let app = f.app;
  try {
    const { route } = await composed(f), share = await shared(f, route);
    const form = new FormData();
    form.append('photos', new Blob([png(40, 30, 9)]), 'other.png');
    form.append('metadata', JSON.stringify({ photos: [grant] }));
    const other = await jsonResponse(await f.owner.request('/api/drafts', { method: 'POST', body: form }), 201);
    const otherOriginal = path.join(f.dataDir, 'drafts', other.id, other.photos[0].name);
    const before = sha256(await readFile(otherOriginal));
    const deletion = `/api/drafts/${f.draft.id}/deletion`;
    const reviewed = await jsonResponse(await f.owner.request(deletion), 200);
    assert.equal(reviewed.inventory.photos, 2);
    assert.equal(reviewed.inventory.scenes, 3);
    assert.equal(reviewed.inventory.visitorSnapshots, 1);
    const request = { requestId: randomUUID(), impactSha256: reviewed.impactSha256, confirmDeletion: true };
    const deleted = await jsonResponse(await f.owner.post(`/api/drafts/${f.draft.id}/delete`, request), 200);
    assert.equal(deleted.state, 'complete');
    for (const dir of ['drafts', 'reconstructions']) await assert.rejects(lstat(path.join(f.dataDir, dir, f.draft.id)), { code: 'ENOENT' });
    assert.equal(sha256(await readFile(otherOriginal)), before);
    assert.equal((await f.owner.request(route)).status, 404);
    assert.equal((await f.owner.request('/api/visit', { headers: share.headers })).status, 404);
    await app.close();
    app = await startOwnerServer({ dataDir: f.dataDir });
    const owner = client(app.base, app.cookie);
    assert.equal((await owner.json(deletion)).state, 'complete');
    assert.equal((await owner.post(`/api/drafts/${f.draft.id}/delete`, request)).status, 200);
    assert.equal((await owner.request(route)).status, 404);
    assert.ok((await owner.post(f.route, f.request)).status >= 400);
    assert.equal((await owner.request('/api/visit', { headers: share.headers })).status, 404);
    assert.equal(sha256(await readFile(otherOriginal)), before);
  } finally { await app.close(); }
});

it('refuses a deletion review with a malformed composition source closure without inventing a primary source', async () => {
  const f = await fixture();
  try {
    const { scene } = await composed(f);
    const file = path.join(f.dataDir, 'reconstructions', f.draft.id, scene.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    for (const mutate of [
      (value) => { value.sourceBindings.pop(); },
      (value) => { value.sourceBindings[1].sourceId = value.sourceBindings[0].sourceId; },
      (value) => { value.sourceId = value.sourceBindings[0].sourceId; },
    ]) {
      const corrupt = structuredClone(manifest); mutate(corrupt); await writeFile(file, JSON.stringify(corrupt));
      assert.equal((await f.owner.request(`/api/drafts/${f.draft.id}/deletion`)).status, 503);
    }
    await writeFile(file, JSON.stringify(manifest));
    assert.equal((await f.owner.request(`/api/drafts/${f.draft.id}/deletion`)).status, 200);
  } finally { await f.app.close(); }
});

it('refuses an exact relationship replay whose saved version inherited a later-withdrawn contribution', async () => {
  const f = await fixture();
  try {
    const { route } = await composed(f);
    const contribution = await jsonResponse(await f.owner.post(`${route}/contributions`, { requestId: randomUUID(), text: 'Synthetic supported arrangement', periodClaim: '', permissions: { place: true, model: false, share: true } }), 200);
    const { position, quaternion } = pose(-3.6);
    await jsonResponse(await f.owner.post(`${route}/contributions/${contribution.id}/review`, { requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { targetId: ids[0], pose: { position, quaternion } } }), 200);
    const relationship = { requestId: randomUUID(), baseVersion: 2, relationship: { kind: 'left_of', leftId: ids[0], rightId: ids[1], frame: 'owner-composition' }, confirmed: true };
    await jsonResponse(await f.owner.post(`${route}/relationship`, relationship), 200);
    await jsonResponse(await f.owner.post(`${route}/contributions/${contribution.id}/withdraw`, { requestId: randomUUID() }), 200);
    const replayed = await jsonResponse(await f.owner.post(`${route}/relationship`, relationship), 409);
    assert.match(replayed.error, /withdrawn/i);
    assert.equal((await f.owner.json(route)).edit.version, 3);
  } finally { await f.app.close(); }
});
