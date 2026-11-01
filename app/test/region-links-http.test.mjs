import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { client, enrolledContributor, jpeg, png, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic photos, grids and judgments only. A link is the owner's explicit
// judgment; nothing here recognizes, aligns or matches anything.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const NOT_READY = 'Link photo regions after both objects are confirmed.';
const UNAVAILABLE = 'Photo region links are unavailable right now. Nothing was changed.';
const CHECKSUM = 'The saved photo no longer matches its recorded checksum, so it cannot be used.';
const SOURCE_BLOCKED = 'The owner stopped using this photo or turned off its place use, so no version of this scene can be used.';

// A JPEG whose EXIF orientation is 6 (rotate 90 degrees for display) and whose
// stored pixels are 48 wide and 32 high. The server reports stored pixels.
function rotatedJpeg() {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  const plain = jpeg(48, 32, 5);
  return Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]);
}

const PHOTOS = [SYNTHETIC_PHOTO, png(40, 30, 11), png(40, 30, 13), rotatedJpeg()];
const GRANT = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const PLACE_ONLY = { ...GRANT, permissions: { place: true, model: false, share: false } };
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];

// The two-object worker's outputs for a 16 x 12 grid, from the actual input.
const GRID = { width: 16, height: 12 };
function regionsGrid() {
  const regions = [];
  for (let y = 0; y < GRID.height; y++) {
    for (let x = 0; x < GRID.width; x++) {
      const inRows = y >= 2 && y <= 9;
      regions.push(inRows && x >= 1 && x <= 5 ? 1 : inRows && x >= 10 && x <= 14 ? 2 : 0);
    }
  }
  regions[GRID.width + 8] = -1;
  return regions;
}
async function runner(call) {
  if (!call.objects) return sceneRunner(call);
  const { imagePath, outputDir, sourceId, objects } = call;
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const selected = objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box }));
  const surface = {
    schema_version: 2,
    source: { source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30], texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' }, selected_objects: selected },
    objects: selected, ...GRID, depth: Array(GRID.width * GRID.height).fill(3), regions: regionsGrid(),
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
  const summary = { source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture), overlap: { pixels: 1, ratio: 0.001 } };
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(16, 12), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify(surface), 'summary.json': JSON.stringify(summary),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

async function workspace(options = {}, dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-region-links-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function settle(owner, scene) {
  for (let attempt = 0; attempt < 200 && ['queued', 'processing'].includes((await owner.json(scene)).status); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
}

// One memory with four photos and a recording; a two-object scene from the
// first photo. Photo 2 is granted place use only.
async function place(owner, { confirm = true } = {}) {
  const form = new FormData();
  PHOTOS.forEach((bytes, index) => form.append('photos', new Blob([bytes]), `photo-${index + 1}`));
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [GRANT, PLACE_ONLY, GRANT, GRANT], voice: GRANT }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: OBJECTS })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  await settle(owner, scene);
  assert.equal((await owner.json(scene)).status, 'ready');
  if (confirm) assert.equal((await owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 200);
  const [base, placeOnly, other, rotated] = draft.photos.map((photo) => photo.sourceId);
  return {
    draft, job, scene, base, placeOnly, other, rotated, voice: draft.voice.sourceId,
    links: (objectId = 'object-1') => `${scene}/objects/${objectId}/region-links`,
    reference: (sourceId) => `${scene}/region-reference/${sourceId}`,
    file: (index) => path.join('drafts', draft.id, draft.photos[index].name),
    sidecar: path.join('reconstructions', draft.id, job.id, 'region-links.json'),
  };
}

const change = (baseRevision, sourceId, box, extra = {}) => ({ requestId: randomUUID(), baseRevision, action: box ? 'set' : 'remove', sourceId, box, confirmed: true, ...extra });
async function ok(response, label = '') {
  assert.equal(response.status, 200, label);
  return response.json();
}
async function refused(response, status, error, label = '') {
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  const body = await response.json();
  if (error) assert.deepEqual(body, { error }, label);
  else assert.deepEqual(Object.keys(body), ['error'], label);
}

async function hashes(dataDir, ...dirs) {
  const result = {};
  for (const dir of dirs) {
    for (const entry of await readdir(path.join(dataDir, dir), { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name !== 'region-links.json') result[path.join(entry.parentPath, entry.name)] = sha256(await readFile(path.join(entry.parentPath, entry.name)));
    }
  }
  return result;
}
const policyOf = (draftId, sourceId) => `/api/drafts/${draftId}/sources/${sourceId}/policy`;
async function restrict(owner, draftId, sourceId, permissions, stopUse = false) {
  const { revision } = await owner.json(policyOf(draftId, sourceId));
  return ok(await owner.post(policyOf(draftId, sourceId), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse }));
}

describe('owner photo-region links', () => {
  it('keep explicit regions in three photos of one memory across a restart, without changing anything else', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      const before = await hashes(dataDir, path.join('drafts', p.draft.id), path.join('reconstructions', p.draft.id));
      const manifestBefore = await owner.json(p.scene);
      assert.deepEqual(await ok(await owner.request(p.links())), {
        draftId: p.draft.id, jobId: p.job.id, objectId: 'object-1', label: 'Display counter',
        scenePhoto: { sourceId: p.base, box: [2, 4, 14, 26] }, revision: 0, updatedAt: null, links: [],
      });
      // Place use alone admits a photo: no model grant is needed for a link.
      assert.deepEqual(await ok(await owner.request(p.reference(p.placeOnly))), { width: 40, height: 30 });
      const head = await owner.request(p.reference(p.placeOnly), { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      // Stored pixel order: an orientation-6 JPEG keeps its stored 48 x 32.
      assert.deepEqual(await ok(await owner.request(p.reference(p.rotated))), { width: 48, height: 32 });

      let view = await ok(await owner.post(p.links(), change(0, p.placeOnly, [1, 2, 20, 25])));
      assert.deepEqual([view.revision, view.changed, view.replayed, view.appliedRevision], [1, true, false, 1]);
      view = await ok(await owner.post(p.links(), change(1, p.rotated, [30, 1, 48, 20])));
      assert.deepEqual(view.links.map(({ sourceId, box, imageSize, available, reason }) => ({ sourceId, box, imageSize, available, reason })), [
        { sourceId: p.placeOnly, box: [1, 2, 20, 25], imageSize: [40, 30], available: true, reason: null },
        { sourceId: p.rotated, box: [30, 1, 48, 20], imageSize: [48, 32], available: true, reason: null },
      ]);
      const second = await ok(await owner.post(p.links('object-2'), change(0, p.other, [20, 3, 39, 28])));
      assert.equal(second.label, 'Flour stack');
      assert.deepEqual(second.scenePhoto, { sourceId: p.base, box: [24, 4, 38, 26] });
      // Correcting one pair replaces only that region; the other object is kept.
      view = await ok(await owner.post(p.links(), change(2, p.placeOnly, [2, 3, 21, 26])));
      assert.equal(view.revision, 3);
      assert.deepEqual(view.links.map((link) => link.box), [[2, 3, 21, 26], [30, 1, 48, 20]]);
      assert.equal((await ok(await owner.request(p.links('object-2')))).revision, 1);
      assert.equal((await stat(path.join(dataDir, p.sidecar))).mode & 0o777, 0o600);

      const reopened = await ok(await owner.request(p.links()));
      await app.close();
      ({ app, owner } = await workspace({}, dataDir));
      assert.deepEqual(await ok(await owner.request(p.links())), reopened, 'kept across a restart');
      view = await ok(await owner.post(p.links(), change(3, p.rotated, null)));
      assert.deepEqual([view.revision, view.links.map((link) => link.sourceId)], [4, [p.placeOnly]]);

      assert.deepEqual(await hashes(dataDir, path.join('drafts', p.draft.id), path.join('reconstructions', p.draft.id)), before, 'originals, draft, policies and manifest unchanged');
      const manifestAfter = await owner.json(p.scene);
      assert.deepEqual([manifestAfter.edit, manifestAfter.updatedAt], [manifestBefore.edit, manifestBefore.updatedAt]);
    } finally {
      await app.close();
    }
  });

  it('keeps builds and the image-size route model-gated while links need place use only', async () => {
    const { app, owner } = await workspace();
    try {
      const p = await place(owner);
      await refused(await owner.request(`/api/drafts/${p.draft.id}/sources/${p.placeOnly}/image-size`), 403);
      await refused(await owner.post(`/api/drafts/${p.draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: p.placeOnly, objects: OBJECTS }), 403);
      await ok(await owner.post(p.links(), change(0, p.placeOnly, [0, 0, 40, 30])));
    } finally {
      await app.close();
    }
  });

  it('refuses unready scenes, wrong photos, objects, boxes, bodies, methods and principals without writing', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const unconfirmed = await place(owner, { confirm: false });
      await refused(await owner.request(unconfirmed.links()), 409, NOT_READY);
      await refused(await owner.post(unconfirmed.links(), change(0, unconfirmed.other, [0, 0, 4, 4])), 409, NOT_READY);
      await refused(await owner.request(unconfirmed.reference(unconfirmed.other)), 409, NOT_READY);
      const single = await (async () => {
        const form = new FormData();
        form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo');
        form.append('photos', new Blob([PHOTOS[1]]), 'photo');
        form.append('metadata', JSON.stringify({ photos: [GRANT, GRANT] }));
        const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
        const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
        await settle(owner, `/api/drafts/${draft.id}/reconstructions/${job.id}`);
        assert.equal((await owner.json(`/api/drafts/${draft.id}/reconstructions/${job.id}`)).status, 'ready');
        return `/api/drafts/${draft.id}/reconstructions/${job.id}/objects/object-1/region-links`;
      })();
      await refused(await owner.request(single), 409, NOT_READY);

      const p = await place(owner);
      const elsewhere = await place(owner);
      await refused(await owner.request(`${p.scene}/objects/object-3/region-links`), 404);
      await refused(await owner.request(`/api/drafts/not-an-id/reconstructions/${p.job.id}/objects/object-1/region-links`), 404);
      await refused(await owner.request(`/api/drafts/${p.draft.id}/reconstructions/${randomUUID()}/objects/object-1/region-links`), 404);
      await refused(await owner.request(`${p.scene}/region-reference/not-an-id`), 404);
      const different = 'Link a region in a different photo of this memory.';
      for (const sourceId of [p.base, p.voice, elsewhere.other, randomUUID()]) {
        await refused(await owner.request(p.reference(sourceId)), 400, different, sourceId);
        await refused(await owner.post(p.links(), change(0, sourceId, [0, 0, 4, 4])), 400, different, sourceId);
      }
      const unreadable = 'The photo region link could not be read.';
      for (const box of [[0, 0, 41, 30], [0, 0, 40, 31], [5, 5, 5, 9], [-1, 0, 4, 4], [0, 0, 'x', 4], [0, 0, 4], [0, 0, Infinity, 4]]) {
        assert.equal((await owner.post(p.links(), change(0, p.other, box))).status, 400, JSON.stringify(box));
      }
      const bodies = [
        [change(0, p.other, [0, 0, 4, 4], { confirmed: false }), 'Confirm that the regions show the same object before saving.'],
        [(({ confirmed, ...rest }) => rest)(change(0, p.other, [0, 0, 4, 4])), unreadable],
        [change(0, p.other, [0, 0, 4, 4], { extra: 1 }), unreadable],
        [{ ...change(0, p.other, null), action: 'set' }, unreadable],
        [{ ...change(0, p.other, [0, 0, 4, 4]), action: 'remove' }, unreadable],
        [change(-1, p.other, [0, 0, 4, 4]), unreadable],
        [change(0, 'not-an-id', [0, 0, 4, 4]), unreadable],
        [{ ...change(0, p.other, [0, 0, 4, 4]), action: 'move' }, unreadable],
      ];
      for (const [body, error] of bodies) await refused(await owner.post(p.links(), body), 400, error, JSON.stringify(body).slice(0, 80));
      await refused(await owner.post(p.links(), change(0, p.other, null)), 404, 'This photo region link could not be found.');
      await refused(await owner.request(p.links(), { method: 'PUT' }), 405);
      await refused(await owner.post(p.reference(p.other), {}), 405);
      await refused(await owner.post(p.links(), change(0, p.other, [0, 0, 4, 4]), { origin: 'http://attacker.example' }), 403);
      const { session: contributor } = await enrolledContributor(owner, app.base, p.draft.id);
      for (const session of [contributor, client(app.base)]) {
        const status = session === contributor ? 403 : 401;
        await refused(await session.request(p.links()), status);
        await refused(await session.post(p.links(), change(0, p.other, [0, 0, 4, 4])), status);
        await refused(await session.request(p.reference(p.other)), status);
      }
      for (const scene of [unconfirmed, p]) await assert.rejects(stat(path.join(dataDir, scene.sidecar)), { code: 'ENOENT' }, 'nothing was written');
    } finally {
      await app.close();
    }
  });

  it('hides links after a place reduction or stop but keeps their records and counts', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.links(), change(0, p.placeOnly, [0, 0, 10, 10])));
      await ok(await owner.post(p.links(), change(1, p.other, [1, 1, 10, 10])));
      await ok(await owner.post(p.links('object-2'), change(0, p.other, [2, 2, 12, 12])));
      // Model- and share-only reductions leave this private place use alone.
      const reduced = await restrict(owner, p.draft.id, p.other, { place: true, model: false, share: false });
      assert.equal(reduced.impacts.linkedRegions, 2);
      assert.ok((await ok(await owner.request(p.links()))).links.every((link) => link.available));
      assert.equal((await owner.json(policyOf(p.draft.id, p.base))).impacts.linkedRegions, 3, 'every link of a scene counts for its base photo');

      const stored = await readFile(path.join(dataDir, p.sidecar));
      const off = await restrict(owner, p.draft.id, p.placeOnly, { place: false, model: false, share: false });
      assert.equal(off.impacts.linkedRegions, 1, 'a hidden link is still counted');
      assert.deepEqual(await readFile(path.join(dataDir, p.sidecar)), stored, 'a restriction never rewrites links');
      const view = await ok(await owner.request(p.links()));
      const hidden = view.links.find((link) => link.sourceId === p.placeOnly);
      assert.deepEqual(hidden, { sourceId: p.placeOnly, box: null, imageSize: null, linkedAt: hidden.linkedAt, available: false, reason: 'source' });
      await refused(await owner.request(p.reference(p.placeOnly)), 403);
      await refused(await owner.post(p.links(), change(2, p.placeOnly, [0, 0, 5, 5])), 403);
      assert.deepEqual((await ok(await owner.post(p.links(), change(2, p.placeOnly, null)))).links.map((link) => link.sourceId), [p.other], 'an unavailable link can be removed');

      await restrict(owner, p.draft.id, p.base, { place: false, model: false, share: false }, true);
      await refused(await owner.request(p.links()), 409, SOURCE_BLOCKED);
      await refused(await owner.post(p.links(), change(3, p.other, null)), 409, SOURCE_BLOCKED);
      await refused(await owner.request(p.reference(p.other)), 409, SOURCE_BLOCKED);
      assert.equal((await owner.json(policyOf(p.draft.id, p.base))).impacts.linkedRegions, 2);
    } finally {
      await app.close();
    }
  });

  it('refuses every route while the scene depends on a withdrawn contribution', async () => {
    const { app, owner } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.links(), change(0, p.other, [0, 0, 10, 10])));
      const { session } = await enrolledContributor(owner, app.base, p.draft.id);
      await ok(await session.post(`${p.scene}/contributions`, { requestId: randomUUID(), text: 'The flour sat higher.', permissions: { place: true, model: false, share: false }, periodClaim: '' }));
      const [item] = (await owner.json(`${p.scene}/collaboration`)).contributions;
      await ok(await owner.post(`${p.scene}/contributions/${item.id}/review`, {
        requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { targetId: 'object-2', offset: [0, 0.2, 0], yaw: 0 },
      }));
      await ok(await owner.request(p.links()), 'usable while the contribution stands');
      await ok(await session.post(`${p.scene}/contributions/${item.id}/withdraw`, { requestId: randomUUID() }));
      const blocked = 'This scene depends on a contribution that was withdrawn. Restore an earlier saved version that does not depend on it.';
      await refused(await owner.request(p.links()), 409, blocked);
      await refused(await owner.post(p.links(), change(1, p.other, null)), 409, blocked);
      await refused(await owner.request(p.reference(p.rotated)), 409, blocked);
    } finally {
      await app.close();
    }
  });

  it('projects changed, grown or missing originals as unavailable and refuses them on admission', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.links(), change(0, p.placeOnly, [0, 0, 10, 10])));
      await ok(await owner.post(p.links(), change(1, p.other, [0, 0, 10, 10])));
      await ok(await owner.post(p.links(), change(2, p.rotated, [0, 0, 10, 10])));
      const changed = Buffer.from(PHOTOS[2]);
      changed[changed.length - 1] ^= 0xff;
      await writeFile(path.join(dataDir, p.file(2)), changed);
      await writeFile(path.join(dataDir, p.file(3)), Buffer.concat([PHOTOS[3], Buffer.alloc(8)]));
      await rm(path.join(dataDir, p.file(1)));
      const reasons = Object.fromEntries((await ok(await owner.request(p.links()))).links.map((link) => [link.sourceId, [link.available, link.reason, link.box, link.imageSize]]));
      assert.deepEqual(reasons, {
        [p.placeOnly]: [false, 'unreadable', null, null], [p.other]: [false, 'checksum', null, null], [p.rotated]: [false, 'checksum', null, null],
      });
      for (const sourceId of [p.placeOnly, p.other, p.rotated]) {
        await refused(await owner.request(p.reference(sourceId)), 409, CHECKSUM, sourceId);
        await refused(await owner.post(p.links(), change(3, sourceId, [0, 0, 4, 4])), 409, CHECKSUM, sourceId);
      }
      await ok(await owner.post(p.links(), change(3, p.other, null)));
      // A changed base original holds every route.
      const base = Buffer.from(PHOTOS[0]);
      base[base.length - 1] ^= 0xff;
      await writeFile(path.join(dataDir, p.file(0)), base);
      await refused(await owner.request(p.links()), 409, CHECKSUM);
      await refused(await owner.post(p.links(), change(4, p.rotated, null)), 409, CHECKSUM);
      await refused(await owner.request(p.reference(p.rotated)), 409, CHECKSUM);
    } finally {
      await app.close();
    }
  });

  it('replays exactly, receipts no-ops, keeps the cap and lets one of two concurrent changes win', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      const first = change(0, p.other, [0, 0, 10, 10]);
      await ok(await owner.post(p.links(), first));
      await ok(await owner.post(p.links(), change(1, p.other, [5, 5, 20, 20])));
      // A historical replay reports the current box and its own applied revision.
      const replay = await ok(await owner.post(p.links(), first));
      assert.deepEqual([replay.replayed, replay.changed, replay.appliedRevision, replay.revision, replay.links[0].box], [true, false, 1, 2, [5, 5, 20, 20]]);
      await refused(await owner.post(p.links(), { ...first, box: [0, 0, 11, 10] }), 409, 'This request was already used with different values.');
      await refused(await owner.post(p.links(), change(1, p.other, [0, 0, 4, 4])), 409, 'These photo links changed elsewhere. Reload them before saving.');
      const noop = change(2, p.other, [5, 5, 20, 20]);
      const same = await ok(await owner.post(p.links(), noop));
      assert.deepEqual([same.changed, same.revision, same.appliedRevision], [false, 2, 2]);
      await refused(await owner.post(p.links(), { ...noop, box: [5, 5, 21, 20] }), 409, 'This request was already used with different values.');

      const results = await Promise.all([owner.post(p.links(), change(2, p.placeOnly, [0, 0, 4, 4])), owner.post(p.links(), change(2, p.rotated, [0, 0, 4, 4]))]);
      assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
      assert.equal((await ok(await owner.request(p.links()))).links.length, 2);

      const file = path.join(dataDir, p.sidecar);
      const state = JSON.parse(await readFile(file, 'utf8'));
      const entry = state.objects['object-1'];
      const filler = Array.from({ length: 200 - entry.receipts.length }, () => ({ requestId: randomUUID(), digest: sha256(randomUUID()), revision: entry.revision }));
      await writeFile(file, JSON.stringify({ ...state, objects: { ...state.objects, 'object-1': { ...entry, receipts: [...entry.receipts, ...filler] } } }));
      await refused(await owner.post(p.links(), change(entry.revision, p.other, null)), 409, 'These photo links cannot be changed again.');
      assert.equal((await ok(await owner.post(p.links(), first))).replayed, true, 'an exact replay is found before the cap');
      await ok(await owner.post(p.links('object-2'), change(0, p.other, [0, 0, 4, 4])));
    } finally {
      await app.close();
    }
  });

  it('treats an unreadable links file as unavailable, not empty, without blocking anything else', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.links(), change(0, p.other, [0, 0, 10, 10])));
      const file = path.join(dataDir, p.sidecar);
      const valid = JSON.parse(await readFile(file, 'utf8'));
      const duplicate = structuredClone(valid);
      duplicate.objects['object-1'].links.push({ ...duplicate.objects['object-1'].links[0] });
      const outside = structuredClone(valid);
      outside.objects['object-1'].links[0].box = [0, 0, 41, 10];
      const large = JSON.stringify(valid) + ' '.repeat(256 * 1024);
      for (const content of ['{broken', JSON.stringify(duplicate), JSON.stringify(outside), JSON.stringify({ ...valid, objects: { 'object-3': valid.objects['object-1'] } }), large]) {
        await writeFile(file, content);
        await refused(await owner.request(p.links()), 503, UNAVAILABLE);
        await refused(await owner.post(p.links(), change(1, p.other, null)), 503, UNAVAILABLE);
        assert.equal(await readFile(file, 'utf8'), content, 'nothing was changed');
        assert.deepEqual(await ok(await owner.request(p.reference(p.other))), { width: 40, height: 30 });
        assert.equal((await owner.request(p.scene)).status, 200);
        assert.equal((await owner.request(`${p.scene}/assets/texture.jpg`)).status, 200);
        const { impacts } = await owner.json(policyOf(p.draft.id, p.other));
        assert.equal(impacts.linkedRegions, null, 'unknown, never a false zero');
        assert.equal(impacts.scenes, 0);
      }
      const restricted = await restrict(owner, p.draft.id, p.other, { place: true, model: false, share: true });
      assert.equal(restricted.impacts.linkedRegions, null, 'a restriction still succeeds');
    } finally {
      await app.close();
    }
  });

  it('reports the count as unknown when retained links belong to an unreadable scene manifest', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.links(), change(0, p.other, [0, 0, 10, 10])));
      const sidecar = await readFile(path.join(dataDir, p.sidecar));
      const manifestFile = path.join(dataDir, 'reconstructions', p.draft.id, p.job.id, 'manifest.json');
      for (const damage of [() => writeFile(manifestFile, '{broken'), () => rm(manifestFile)]) {
        await damage();
        for (const sourceId of [p.other, p.base, p.rotated]) {
          assert.equal((await owner.json(policyOf(p.draft.id, sourceId))).impacts.linkedRegions, null, 'unknown, never a false zero');
        }
        const restricted = await restrict(owner, p.draft.id, p.other, { place: true, model: false, share: false });
        assert.equal(restricted.impacts.linkedRegions, null, 'the restriction still succeeds');
        assert.deepEqual(await readFile(path.join(dataDir, p.sidecar)), sidecar, 'retained links are not changed');
      }
      // A scene without stored links adds nothing unknown.
      const plain = await place(owner);
      assert.equal((await owner.json(policyOf(plain.draft.id, plain.other))).impacts.linkedRegions, 0);
    } finally {
      await app.close();
    }
  });

  it('never reaches shares, visitors or the model', async () => {
    const calls = [];
    const proposalModel = async (call) => {
      calls.push(call);
      return { ok: false, reason: 'provider', model: null, responseId: null, usage: null };
    };
    const { app, owner } = await workspace({ proposalModel, prepareModelImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    try {
      const p = await place(owner);
      const shares = `${p.scene}/shares`;
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const previewBody = () => ({ requestId: randomUUID(), title: 'Synthetic visit', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true });
      const before = await (await owner.post(`${shares}/previews`, previewBody())).json();
      const token = `rhv_${randomBytes(32).toString('base64url')}`;
      assert.equal((await owner.post(shares, { requestId: randomUUID(), previewId: before.id, previewDigest: before.digest, token, consent: true })).status, 201);
      const visit = () => globalThis.fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${token}` } });
      const visited = await (await visit()).text();

      const box = [3.25, 4.5, 17.75, 21.125];
      await ok(await owner.post(p.links(), change(0, p.rotated, box)));
      await ok(await owner.post(p.links('object-2'), change(0, p.placeOnly, [1.5, 2.5, 9.5, 11.5])));
      const afterPreview = await (await owner.post(`${shares}/previews`, previewBody())).json();
      assert.deepEqual(afterPreview.publicView, before.publicView);
      assert.equal(afterPreview.digest, before.digest);
      assert.equal(await (await visit()).text(), visited);

      const proposal = await (await owner.post(`${p.scene}/proposals`, { requestId: randomUUID(), baseVersion: 1, text: 'Turn it toward the window.', consent: true, targetId: 'object-1' })).json();
      await settle(owner, `${p.scene}/proposals/${proposal.id}`);
      assert.equal(calls.length, 1);
      const sent = JSON.stringify(calls[0], (key, value) => (Buffer.isBuffer(value) || value instanceof Uint8Array ? `bytes:${value.length}` : value));
      for (const marker of [p.rotated, p.placeOnly, '17.75', '21.125', '9.5']) assert.ok(!sent.includes(marker), marker);
    } finally {
      await app.close();
    }
  });
});
