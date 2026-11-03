import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { ownerFetch, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';
import { expectedInitialPose, validateObjectGlb } from '../full-objects.mjs';
import { syntheticGlb } from './full-object-fixtures.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const post = (url, value) => ownerFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const metadata = { photos: [{ provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } }] };

it('does not publish or confirm an object with an invalid material reference', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-material-'));
  const validator = async ({ maskPath, width, height, gridWidth, gridHeight }) => ({
    width, height, maskSha256: sha(await readFile(maskPath)), bounds: [4, 3, 20, 25], selectedPixels: 100, gridWidth, gridHeight, coveredGridIndices: [0, 1, 4],
  });
  const runFullObject = async ({ imagePath, maskPath, parentSurfacePath, outputDir }) => {
    const bytes = syntheticGlb((doc) => { doc.meshes[0].primitives[0].material = 999; });
    const surfaceBytes = await readFile(parentSurfacePath);
    const receipt = { representation: 'source-photo-full-object-v1', asset: 'object.glb', sha256: sha(bytes), bytes: bytes.length,
      initial: expectedInitialPose(JSON.parse(surfaceBytes), { bounds: [4, 3, 20, 25], coveredGridIndices: [0, 1, 4] }, [[0, 0, 0], [1, 1, 1]]),
      model: { id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' },
      input: { sourceSha256: sha(await readFile(imagePath)), outlineSha256: sha(await readFile(maskPath)), parentSurfaceSha256: sha(surfaceBytes) } };
    await writeFile(path.join(outputDir, 'object.glb'), bytes);
    await writeFile(path.join(outputDir, 'object.json'), JSON.stringify(receipt));
    return { exitCode: 0 };
  };
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject });
  try {
    const form = new FormData(); form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png'); form.append('metadata', JSON.stringify(metadata));
    const draft = await (await ownerFetch(`${app.base}/api/drafts`, { method: 'POST', body: form })).json();
    const sourceId = draft.photos[0].sourceId, source = draft.sources.find((item) => item.id === sourceId);
    const parent = await (await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId, box: [4, 3, 20, 24] })).json();
    const scene = `${app.base}/api/drafts/${draft.id}/reconstructions/${parent.id}`;
    let job;
    for (let i = 0; i < 200; i++) { job = await (await ownerFetch(scene)).json(); if (job.status === 'ready') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(job.status, 'ready');
    const outlineId = randomUUID(), mask = Buffer.from('synthetic-validator-only-mask');
    const headers = { 'content-type': 'image/png', 'x-source-id': sourceId, 'x-source-sha256': source.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': job.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '1' };
    assert.equal((await ownerFetch(`${scene}/full-object/outlines/${outlineId}`, { method: 'PUT', headers, body: mask })).status, 201);
    const builds = `${scene}/full-object/builds`;
    const accepted = await post(builds, { requestId: randomUUID(), sourceId, sourceSha256: source.sha256, outlineId, outlineSha256: sha(mask) });
    assert.equal(accepted.status, 202); const build = await accepted.json();
    let result;
    for (let i = 0; i < 200; i++) { result = await (await ownerFetch(`${builds}/${build.id}`)).json(); if (!['queued', 'processing'].includes(result.status)) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(result.status, 'failed');
    assert.notEqual((await ownerFetch(`${builds}/${build.id}/assets/object.glb`)).status, 200);
    assert.equal((await post(`${builds}/${build.id}/confirm`, { requestId: randomUUID(), baseVersion: 1 })).status, 409);
    assert.equal((await (await ownerFetch(scene)).json()).edit.version, 1);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it('binds outline and generated object to their source, replays requests and rejects revoked use', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-outline-'));
  let calls = 0;
  const validator = async ({ maskPath, width, height, gridWidth, gridHeight }) => {
    calls++;
    return { width, height, maskSha256: sha(await readFile(maskPath)), bounds: [4, 3, 20, 25], selectedPixels: 100, gridWidth, gridHeight, coveredGridIndices: [0, 1, 4] };
  };
  let buildCalls = 0;
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  let secondStarted;
  const secondStartedPromise = new Promise((resolve) => { secondStarted = resolve; });
  let releaseLegacy;
  const legacyGate = new Promise((resolve) => { releaseLegacy = resolve; });
  let legacyStarted;
  const legacyStartedPromise = new Promise((resolve) => { legacyStarted = resolve; });
  let holdLegacy = false;
  let legacyCalls = 0;
  const reconstructionRunner = async (options) => {
    legacyCalls++;
    if (holdLegacy) { legacyStarted(); await legacyGate; }
    return sceneRunner(options);
  };
  const runFullObject = async ({ imagePath, maskPath, parentSurfacePath, outputDir }) => {
    buildCalls++;
    if (buildCalls === 2) { secondStarted(); await secondGate; }
    const bytes = syntheticGlb(), geometry = validateObjectGlb(bytes), surfaceBytes = await readFile(parentSurfacePath), surface = JSON.parse(surfaceBytes);
    const maskBytes = await readFile(maskPath), image = await readFile(imagePath), outline = { bounds: [4, 3, 20, 25], coveredGridIndices: [0, 1, 4] };
    const result = { representation: 'source-photo-full-object-v1', asset: 'object.glb', sha256: geometry.sha256, bytes: bytes.length,
      initial: expectedInitialPose(surface, outline, geometry.bounds), model: { id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' },
      input: { sourceSha256: sha(image), outlineSha256: sha(maskBytes), parentSurfaceSha256: sha(surfaceBytes) } };
    await writeFile(path.join(outputDir, 'object.glb'), bytes);
    await writeFile(path.join(outputDir, 'object.json'), JSON.stringify(result));
    return { exitCode: 0 };
  };
  let app = await startOwnerServer({ dataDir, reconstructionRunner, fullObjectMaskValidator: validator });
  try {
    const form = new FormData(); form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png'); form.append('metadata', JSON.stringify(metadata));
    const draft = await (await ownerFetch(`${app.base}/api/drafts`, { method: 'POST', body: form })).json();
    const sourceId = draft.photos[0].sourceId, source = draft.sources.find((item) => item.id === sourceId);
    const initial = await (await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId, box: [4, 3, 20, 24] })).json();
    let scene = `${app.base}/api/drafts/${draft.id}/reconstructions/${initial.id}`;
    let job;
    for (let i = 0; i < 200; i++) { job = await (await ownerFetch(scene)).json(); if (job.status !== 'queued' && job.status !== 'processing') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(job.status, 'ready');
    const textureFile = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'assets', 'texture.jpg');
    const texture = await readFile(textureFile);
    assert.equal((await ownerFetch(`${scene}/assets/texture.jpg`)).status, 200);
    await writeFile(textureFile, Buffer.from('changed'));
    assert.notEqual((await ownerFetch(`${scene}/assets/texture.jpg`)).status, 200);
    await writeFile(textureFile, texture);
    const surfaceFile = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'assets', 'surface.json');
    const savedSurface = await readFile(surfaceFile); await writeFile(surfaceFile, Buffer.from('changed'));
    assert.notEqual((await ownerFetch(`${scene}/assets/texture.jpg`)).status, 200);
    await writeFile(surfaceFile, savedSurface);
    const originalFile = path.join(dataDir, 'drafts', draft.id, source.name);
    const savedOriginal = await readFile(originalFile); await writeFile(originalFile, Buffer.from('changed'));
    assert.notEqual((await ownerFetch(`${scene}/assets/texture.jpg`)).status, 200);
    await writeFile(originalFile, savedOriginal);
    const surfaceSha = job.derivedAssets.find((asset) => asset.name === 'surface.json').sha256;
    let collection = `${scene}/full-object/outlines`;
    assert.deepEqual(await (await ownerFetch(collection)).json(), { outlines: [] });
    const mask = Buffer.from('synthetic-validator-only-mask');
    const requestId = randomUUID(); let route = `${scene}/full-object/outlines/${requestId}`;
    const headers = { 'content-type': 'image/png', 'x-source-id': sourceId, 'x-source-sha256': source.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': surfaceSha, 'x-base-version': '1' };
    const put = (changes = {}, bytes = mask) => ownerFetch(route, { method: 'PUT', headers: { ...headers, ...changes }, body: bytes });
    assert.equal((await put({ origin: 'https://other.example' })).status, 403);
    assert.equal((await fetch(route, { method: 'PUT', headers, body: mask })).status, 401);
    assert.equal(calls, 0);
    const manifestFile = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'manifest.json');
    const originalManifest = await readFile(manifestFile);
    for (const change of [{ objects: [{}, {}] }, { representation: 'two-photo-composition' }]) {
      await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), ...change }));
      assert.equal((await put()).status, 409, 'a multi-object or composition parent is not admitted');
    }
    await writeFile(manifestFile, originalManifest);
    const first = await put(); assert.equal(first.status, 201); const outline = await first.json();
    assert.deepEqual(outline.bounds, [4, 3, 20, 25]); assert.equal(outline.maskSha256, sha(mask)); assert.equal(outline.baseVersion, 1);
    const second = await put(); assert.equal(second.status, 200); assert.deepEqual(await second.json(), outline); assert.equal(calls, 1);
    assert.deepEqual(await (await ownerFetch(collection)).json(), { outlines: [outline] });
    assert.equal((await put({ 'x-base-version': '2' })).status, 409);
    assert.deepEqual(Buffer.from(await (await ownerFetch(`${route}/mask.png`)).arrayBuffer()), mask);
    assert.equal((await put({ 'x-mask-sha256': 'f'.repeat(64) })).status, 400);
    const storedMask = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'full-object', 'outlines', requestId, 'mask.png');
    await writeFile(storedMask, Buffer.from('changed'));
    assert.notEqual((await ownerFetch(`${route}/mask.png`)).status, 200);
    assert.notEqual((await ownerFetch(collection)).status, 200);
    await writeFile(storedMask, mask);
    let builds = `${scene}/full-object/builds`;
    assert.deepEqual(await (await ownerFetch(builds)).json(), { builds: [] });
    const request = { requestId: randomUUID(), sourceId, sourceSha256: source.sha256, outlineId: requestId, outlineSha256: sha(mask) };
    assert.equal((await post(builds, request)).status, 503, 'the default cannot dispatch an unsupervised model');
    assert.deepEqual(await (await ownerFetch(builds)).json(), { builds: [] });
    await app.close();
    app = await startOwnerServer({ dataDir, reconstructionRunner, fullObjectMaskValidator: validator, runFullObject });
    scene = `${app.base}/api/drafts/${draft.id}/reconstructions/${initial.id}`;
    collection = `${scene}/full-object/outlines`; builds = `${scene}/full-object/builds`; route = `${collection}/${requestId}`;
    holdLegacy = true;
    const legacyRequest = { requestId: randomUUID(), sourceId, box: [4, 3, 20, 24] };
    const legacyAccepted = await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, legacyRequest);
    assert.equal(legacyAccepted.status, 202);
    const legacy = await legacyAccepted.json();
    await legacyStartedPromise;
    assert.equal((await post(builds, request)).status, 409, 'an object build cannot start while a legacy runner is active');
    assert.equal(buildCalls, 0);
    assert.equal((await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, legacyRequest)).status, 202);
    assert.equal(legacyCalls, 2, 'legacy replay does not dispatch another runner');
    releaseLegacy();
    for (let i = 0; i < 200; i++) {
      const current = await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${legacy.id}`)).json();
      if (!['queued', 'processing'].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const created = await post(builds, request); assert.equal(created.status, 202); const accepted = await created.json();
    let completed;
    for (let i = 0; i < 200; i++) { completed = await (await ownerFetch(`${builds}/${accepted.id}`)).json(); if (!['queued', 'processing'].includes(completed.status)) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(completed.status, 'ready'); assert.equal(buildCalls, 1);
    assert.equal(completed.object.sha256, sha(syntheticGlb()));
    assert.deepEqual((await (await ownerFetch(builds)).json()).builds, [completed]);
    assert.equal((await post(builds, request)).status, 200); assert.equal(buildCalls, 1);
    assert.deepEqual(Buffer.from(await (await ownerFetch(`${builds}/${accepted.id}/assets/object.glb`)).arrayBuffer()), syntheticGlb());
    const lateRequest = { ...request, requestId: randomUUID() };
    const late = await (await post(builds, lateRequest)).json();
    await secondStartedPromise;
    assert.equal((await post(builds, lateRequest)).status, 200);
    assert.equal(buildCalls, 2, 'object replay does not dispatch another runner');
    assert.equal((await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId, box: [4, 3, 20, 24] })).status, 409,
      'a legacy reconstruction cannot start while an object runner is active');
    const initialPolicy = await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/sources/${sourceId}/policy`)).json();
    const noModel = await post(`${app.base}/api/drafts/${draft.id}/sources/${sourceId}/policy`, { requestId: randomUUID(), baseRevision: initialPolicy.revision, permissions: { place: true, model: false, share: true }, stopUse: false });
    assert.equal(noModel.status, 200);
    releaseSecond();
    let stopped;
    for (let i = 0; i < 200; i++) { stopped = await (await ownerFetch(`${builds}/${late.id}`)).json(); if (!['queued', 'processing'].includes(stopped.status)) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.notEqual(stopped.status, 'ready');
    assert.notEqual((await ownerFetch(`${builds}/${late.id}/assets/object.glb`)).status, 200);
    // Turning off model use does not remove a previously completed, place-permitted object.
    assert.equal((await ownerFetch(`${builds}/${accepted.id}/assets/object.glb`)).status, 200);
    assert.equal((await ownerFetch(`${scene}/assets/texture.jpg`)).status, 200);
    const earlierDeletionReview = await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/deletion`)).json();
    for (let i = 0; i < 31; i++) {
      const response = await ownerFetch(`${collection}/${randomUUID()}`, { method: 'PUT', headers, body: mask });
      assert.equal(response.status, 201);
    }
    assert.equal((await (await ownerFetch(collection)).json()).outlines.length, 32);
    assert.equal((await post(`${app.base}/api/drafts/${draft.id}/delete`, { requestId: randomUUID(), impactSha256: earlierDeletionReview.impactSha256, confirmDeletion: true })).status, 409,
      'a newly confirmed outline makes the earlier deletion review stale');
    assert.equal((await ownerFetch(`${collection}/${randomUUID()}`, { method: 'PUT', headers, body: mask })).status, 409);
    assert.equal((await put()).status, 200, 'exact replay stays available at capacity');
    const viewId = randomUUID(), previewRequest = { requestId: randomUUID(), title: 'Synthetic place', views: [{ id: viewId, kind: 'version', version: 1, variantId: null }],
      startViewId: viewId, camera: { position: [0, 0.5, 1], target: [0, 0, -3] }, contributionIds: [], synthetic: true };
    const previewResponse = await post(`${scene}/shares/previews`, previewRequest); assert.equal(previewResponse.status, 201); const legacyPreview = await previewResponse.json();
    const confirmation = { requestId: randomUUID(), baseVersion: 1 };
    const confirmedResponse = await post(`${builds}/${accepted.id}/confirm`, confirmation); assert.equal(confirmedResponse.status, 200);
    const confirmed = await confirmedResponse.json(); assert.equal(confirmed.version, 2); assert.equal(confirmed.fullObject.sha256, completed.object.sha256);
    assert.deepEqual(await (await post(`${builds}/${accepted.id}/confirm`, confirmation)).json(), confirmed);
    const reload = await (await ownerFetch(scene)).json(); assert.equal(reload.edit.fullObject.sha256, completed.object.sha256);
    const edited = await post(`${scene}/edit`, { requestId: randomUUID(), baseVersion: 2, offset: [0.2, 0, 0], yaw: 0.3 });
    assert.equal(edited.status, 200); assert.equal((await edited.json()).fullObject.sha256, completed.object.sha256);
    assert.equal((await ownerFetch(`${collection}/${randomUUID()}`, { method: 'PUT', headers, body: mask })).status, 409, 'new outline cannot use a stale base');
    const history = await (await ownerFetch(`${scene}/history`)).json();
    assert.equal(history.find((item) => item.version === 2).fullObject.sha256, completed.object.sha256);
    assert.equal(history.find((item) => item.version === 3).fullObject.sha256, completed.object.sha256);
    assert.equal((await post(`${scene}/undo`, { requestId: randomUUID(), baseVersion: 3, targetVersion: 1 })).status, 409);
    assert.equal((await post(`${scene}/proposals`, { requestId: randomUUID(), baseVersion: 3, text: 'Synthetic words', consent: true })).status, 409);
    const newView = { id: randomUUID(), kind: 'version', version: 3, variantId: null };
    assert.equal((await post(`${scene}/shares/previews`, { ...previewRequest, requestId: randomUUID(), views: [newView], startViewId: newView.id })).status, 409);
    const token = `rhv_${randomBytes(32).toString('base64url')}`;
    assert.equal((await post(`${scene}/shares`, { requestId: randomUUID(), previewId: legacyPreview.id, previewDigest: legacyPreview.digest, token, consent: true })).status, 201);
    assert.equal((await fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const storedObject = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'full-object', 'builds', accepted.id, 'object.glb');
    const savedBytes = await readFile(storedObject); await writeFile(storedObject, Buffer.from('not an object'));
    assert.notEqual((await ownerFetch(`${builds}/${accepted.id}/assets/object.glb`)).status, 200);
    assert.notEqual((await ownerFetch(scene)).status, 200);
    assert.notEqual((await post(`${scene}/edit`, { requestId: randomUUID(), baseVersion: 3, offset: [0.3, 0, 0], yaw: 0.3 })).status, 200);
    await writeFile(storedObject, savedBytes);
    // A pinned legacy snapshot continues to resolve independently of the current object.
    assert.equal((await fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    // Simulate a process stopping after accepting work but before recording a terminal state.
    const lateStateFile = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'full-object', 'builds', late.id, 'build.json');
    const lateState = JSON.parse(await readFile(lateStateFile, 'utf8')); lateState.status = 'processing'; lateState.error = null;
    await writeFile(lateStateFile, JSON.stringify(lateState));
    await app.close();
    app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject });
    scene = `${app.base}/api/drafts/${draft.id}/reconstructions/${initial.id}`;
    collection = `${scene}/full-object/outlines`; builds = `${scene}/full-object/builds`; route = `${collection}/${requestId}`;
    assert.equal((await (await ownerFetch(`${builds}/${late.id}`)).json()).status, 'interrupted');
    assert.equal(buildCalls, 2, 'recovery does not redispatch the interrupted worker');
    assert.equal((await (await ownerFetch(scene)).json()).edit.fullObject.sha256, completed.object.sha256);
    const policy = await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/sources/${sourceId}/policy`)).json();
    const restricted = await post(`${app.base}/api/drafts/${draft.id}/sources/${sourceId}/policy`, { requestId: randomUUID(), baseRevision: policy.revision, permissions: { place: false, model: false, share: false }, stopUse: false });
    assert.equal(restricted.status, 200);
    assert.notEqual((await ownerFetch(collection)).status, 200);
    assert.notEqual((await ownerFetch(`${route}/mask.png`)).status, 200);
    const otherForm = new FormData(); otherForm.append('photos', new Blob([SYNTHETIC_PHOTO]), 'other.png'); otherForm.append('metadata', JSON.stringify(metadata));
    const other = await (await ownerFetch(`${app.base}/api/drafts`, { method: 'POST', body: otherForm })).json();
    const otherSource = other.sources.find((item) => item.id === other.photos[0].sourceId);
    const otherFile = path.join(dataDir, 'drafts', other.id, otherSource.name), otherBytes = await readFile(otherFile);
    const impact = await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/deletion`)).json();
    const unknownFile = path.join(dataDir, 'reconstructions', draft.id, initial.id, 'full-object', 'builds', accepted.id, 'unknown.bin');
    await writeFile(unknownFile, Buffer.from('unowned synthetic file'));
    const deletionRequest = { requestId: randomUUID(), impactSha256: impact.impactSha256, confirmDeletion: true };
    const pendingDeletion = await post(`${app.base}/api/drafts/${draft.id}/delete`, deletionRequest);
    assert.equal(pendingDeletion.status, 202); assert.notEqual((await pendingDeletion.json()).state, 'complete');
    assert.equal((await readFile(unknownFile)).toString(), 'unowned synthetic file');
    await unlink(unknownFile);
    const deletion = await post(`${app.base}/api/drafts/${draft.id}/delete`, deletionRequest);
    assert.equal(deletion.status, 200); assert.equal((await deletion.json()).state, 'complete');
    await assert.rejects(readFile(path.join(dataDir, 'reconstructions', draft.id, initial.id, 'full-object', 'outlines', requestId, 'mask.png')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(otherFile), otherBytes, 'a different place keeps its original');
    await app.close();
    app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject });
    assert.equal((await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/deletion`)).json()).state, 'complete');
    assert.deepEqual(await readFile(otherFile), otherBytes);
  } finally { releaseLegacy(); releaseSecond(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it('stops late publication on close and deletion, then preserves unrelated originals across restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-delete-'));
  let release, started, observedSignal;
  let gate, entered;
  const resetGate = () => {
    gate = new Promise((resolve) => { release = resolve; });
    entered = new Promise((resolve) => { started = resolve; });
  };
  resetGate();
  const validator = async ({ maskPath, width, height, gridWidth, gridHeight }) => ({ width, height, maskSha256: sha(await readFile(maskPath)), bounds: [4, 3, 20, 25], selectedPixels: 100, gridWidth, gridHeight, coveredGridIndices: [0, 1, 4] });
  const runner = async ({ imagePath, maskPath, parentSurfacePath, outputDir, signal }) => {
    observedSignal = signal; started(); await gate;
    const bytes = syntheticGlb(), geometry = validateObjectGlb(bytes), surfaceBytes = await readFile(parentSurfacePath);
    const maskBytes = await readFile(maskPath), image = await readFile(imagePath);
    const receipt = { representation: 'source-photo-full-object-v1', asset: 'object.glb', sha256: geometry.sha256, bytes: bytes.length,
      initial: expectedInitialPose(JSON.parse(surfaceBytes), { bounds: [4, 3, 20, 25], coveredGridIndices: [0, 1, 4] }, geometry.bounds),
      model: { id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' },
      input: { sourceSha256: sha(image), outlineSha256: sha(maskBytes), parentSurfaceSha256: sha(surfaceBytes) } };
    await writeFile(path.join(outputDir, 'object.glb'), bytes);
    await writeFile(path.join(outputDir, 'object.json'), JSON.stringify(receipt));
    return { exitCode: 0 };
  };
  let app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject: runner });
  try {
    const save = async () => {
      const form = new FormData(); form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png'); form.append('metadata', JSON.stringify(metadata));
      return (await ownerFetch(`${app.base}/api/drafts`, { method: 'POST', body: form })).json();
    };
    const draft = await save(), other = await save(), sourceId = draft.photos[0].sourceId, source = draft.sources.find((item) => item.id === sourceId);
    const otherSource = other.sources.find((item) => item.id === other.photos[0].sourceId), otherFile = path.join(dataDir, 'drafts', other.id, otherSource.name);
    const original = await readFile(otherFile);
    const job = await (await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId, box: [4, 3, 20, 24] })).json();
    let scene = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`;
    let ready;
    for (let i = 0; i < 200; i++) { ready = await (await ownerFetch(scene)).json(); if (ready.status === 'ready') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(ready.status, 'ready');
    const mask = Buffer.from('synthetic-validator-only-mask'), outlineId = randomUUID();
    const headers = { 'content-type': 'image/png', 'x-source-id': sourceId, 'x-source-sha256': source.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': ready.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '1' };
    assert.equal((await ownerFetch(`${scene}/full-object/outlines/${outlineId}`, { method: 'PUT', headers, body: mask })).status, 201);
    let build = await (await post(`${scene}/full-object/builds`, { requestId: randomUUID(), sourceId, sourceSha256: source.sha256, outlineId, outlineSha256: sha(mask) })).json();
    await entered;
    const closing = app.close();
    for (let i = 0; i < 200 && !observedSignal.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(observedSignal.aborted, true);
    release(); await closing;
    app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject: runner });
    scene = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`;
    assert.equal((await (await ownerFetch(`${scene}/full-object/builds/${build.id}`)).json()).status, 'interrupted');
    assert.notEqual((await ownerFetch(`${scene}/full-object/builds/${build.id}/assets/object.glb`)).status, 200);
    resetGate();
    build = await (await post(`${scene}/full-object/builds`, { requestId: randomUUID(), sourceId, sourceSha256: source.sha256, outlineId, outlineSha256: sha(mask) })).json();
    await entered;
    const impact = await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/deletion`)).json();
    const request = { requestId: randomUUID(), impactSha256: impact.impactSha256, confirmDeletion: true };
    const first = await post(`${app.base}/api/drafts/${draft.id}/delete`, request); assert.equal(first.status, 202);
    assert.notEqual((await first.json()).state, 'complete');
    assert.equal(observedSignal.aborted, true);
    assert.notEqual((await ownerFetch(`${scene}/full-object/builds/${build.id}/assets/object.glb`)).status, 200);
    release();
    let deletion;
    for (let i = 0; i < 200; i++) {
      deletion = await (await post(`${app.base}/api/drafts/${draft.id}/delete`, request)).json();
      if (deletion.state === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(deletion.state, 'complete');
    await assert.rejects(readFile(path.join(dataDir, 'reconstructions', draft.id, job.id, 'full-object', 'builds', build.id, 'object.glb')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(otherFile), original);
    await app.close();
    app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, fullObjectMaskValidator: validator, runFullObject: runner });
    assert.equal((await (await ownerFetch(`${app.base}/api/drafts/${draft.id}/deletion`)).json()).state, 'complete');
    assert.deepEqual(await readFile(otherFile), original);
  } finally { release(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
