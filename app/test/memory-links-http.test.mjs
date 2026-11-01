import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { client, enrolledContributor, jpeg, png, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic places and words only. A link is the owner's own judgment that
// the saved written memory is about an object; nothing here interprets it.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const WORDS = '  The counter faced the window,\r\nand the scale sat on its left.  \r\n';
const UNAVAILABLE = 'Written memory links are unavailable right now. Nothing was changed.';
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
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-memory-links-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}
async function settle(owner, route) {
  for (let attempt = 0; attempt < 200 && ['queued', 'processing'].includes((await owner.json(route)).status); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
}

// A confirmed two-object scene from a memory with a photo and place-only
// written words (exactly as typed, spaces and CRLF included).
async function place(owner, { confirm = true, text = WORDS } = {}) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo');
  if (text !== null) form.append('text', text);
  form.append('metadata', JSON.stringify({ photos: [GRANT], ...(text !== null && { text: PLACE_ONLY }) }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: OBJECTS })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  await settle(owner, scene);
  assert.equal((await owner.json(scene)).status, 'ready');
  if (confirm) assert.equal((await owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 200);
  return {
    draft, job, scene, textId: draft.textSourceId, photoId: draft.photos[0].sourceId,
    link: (objectId = 'object-1') => `${scene}/objects/${objectId}/memory-link`,
    sidecar: path.join('reconstructions', draft.id, job.id, 'memory-links.json'),
  };
}
const change = (baseRevision, sourceId, action = 'set', extra = {}) => ({ requestId: randomUUID(), baseRevision, action, sourceId, confirmed: true, ...extra });
async function ok(response, label = '') {
  assert.equal(response.status, 200, label);
  return response.json();
}
async function refused(response, status, label = '') {
  assert.equal(response.status, status, label);
  assert.deepEqual(Object.keys(await response.json()), ['error'], label);
}
async function hashes(dataDir, ...dirs) {
  const result = {};
  for (const dir of dirs) {
    for (const entry of await readdir(path.join(dataDir, dir), { withFileTypes: true, recursive: true }).catch(() => [])) {
      if (entry.isFile() && entry.name !== 'memory-links.json') result[path.join(entry.parentPath, entry.name)] = sha256(await readFile(path.join(entry.parentPath, entry.name)));
    }
  }
  return result;
}
const exists = (file) => lstat(file).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));
const policyOf = (draftId, sourceId) => `/api/drafts/${draftId}/sources/${sourceId}/policy`;
async function restrict(owner, draftId, sourceId, permissions, stopUse = false) {
  const { revision } = await owner.json(policyOf(draftId, sourceId));
  return ok(await owner.post(policyOf(draftId, sourceId), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse }));
}

describe('written memory links', () => {
  it('links the exact saved words to each object independently and keeps them across a restart, changing nothing else', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      const before = await hashes(dataDir, path.join('drafts', p.draft.id), path.join('reconstructions', p.draft.id));
      const fresh = await ok(await owner.request(p.link()));
      assert.deepEqual(fresh, {
        draftId: p.draft.id, jobId: p.job.id, objectId: 'object-1', label: 'Display counter', revision: 0, updatedAt: null,
        source: { sourceId: p.textId, available: true, reason: null, text: WORDS }, link: null,
      });
      const linked = await ok(await owner.post(p.link(), change(0, p.textId)));
      assert.deepEqual([linked.revision, linked.changed, linked.replayed, linked.appliedRevision], [1, true, false, 1]);
      assert.deepEqual(linked.link, { sourceId: p.textId, linkedAt: linked.link.linkedAt, available: true, reason: null });
      assert.equal(linked.source.text, WORDS, 'exact UTF-8 with CRLF and outer spaces');
      assert.equal((await ok(await owner.request(p.link('object-2')))).link, null, 'the other object is independent');
      await ok(await owner.post(p.link('object-2'), change(0, p.textId)));
      assert.equal((await stat0(dataDir, p.sidecar)) & 0o777, 0o600);
      const stored = JSON.parse(await readFile(path.join(dataDir, p.sidecar), 'utf8'));
      assert.ok(!JSON.stringify(stored).includes('counter faced'), 'the words are not copied into the link');

      const reopened = await ok(await owner.request(p.link()));
      await app.close();
      ({ app, owner } = await workspace({}, dataDir));
      assert.deepEqual(await ok(await owner.request(p.link())), reopened, 'kept across a restart');
      const removed = await ok(await owner.post(p.link(), change(1, p.textId, 'remove')));
      assert.deepEqual([removed.revision, removed.link], [2, null]);
      assert.equal((await ok(await owner.request(p.link('object-2')))).link.available, true);
      assert.equal((await ok(await owner.post(p.link(), change(2, p.textId)))).revision, 3, 'linked again');
      assert.deepEqual(await hashes(dataDir, path.join('drafts', p.draft.id), path.join('reconstructions', p.draft.id)), before, 'draft, originals, policies, manifest and region links unchanged');
    } finally {
      await app.close();
    }
  });

  it('refuses unready scenes, missing or wrong sources, bodies, methods and principals without writing', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const unconfirmed = await place(owner, { confirm: false });
      await refused(await owner.request(unconfirmed.link()), 409);
      await refused(await owner.post(unconfirmed.link(), change(0, unconfirmed.textId)), 409);
      const noText = await place(owner, { text: null });
      assert.equal((await ok(await owner.request(noText.link()))).source, null, 'no written memory to show');
      await refused(await owner.post(noText.link(), change(0, randomUUID())), 400);
      const p = await place(owner);
      const other = await place(owner);
      for (const sourceId of [p.photoId, other.textId, randomUUID()]) await refused(await owner.post(p.link(), change(0, sourceId)), 400, sourceId);
      for (const body of [change(0, p.textId, 'set', { confirmed: false }), (({ confirmed, ...rest }) => rest)(change(0, p.textId)), change(0, p.textId, 'move'),
        change(-1, p.textId), change(0, 'not-an-id'), change(0, p.textId, 'set', { text: 'x' })]) {
        await refused(await owner.post(p.link(), body), 400, JSON.stringify(body).slice(0, 60));
      }
      await refused(await owner.post(p.link(), change(0, p.textId, 'remove')), 404);
      await refused(await owner.request(`${p.scene}/objects/object-3/memory-link`), 404);
      await refused(await owner.request(`/api/drafts/not-an-id/reconstructions/${p.job.id}/objects/object-1/memory-link`), 404);
      await refused(await owner.request(p.link(), { method: 'PUT' }), 405);
      await refused(await owner.post(p.link(), change(0, p.textId), { origin: 'http://attacker.example' }), 403);
      const { session: contributor } = await enrolledContributor(owner, app.base, p.draft.id);
      for (const [session, status] of [[contributor, 403], [client(app.base), 401]]) {
        await refused(await session.request(p.link()), status);
        await refused(await session.post(p.link(), change(0, p.textId)), status);
      }
      for (const scene of [unconfirmed, noText, p, other]) assert.equal(await exists(path.join(dataDir, scene.sidecar)), false, 'nothing was written');
    } finally {
      await app.close();
    }
  });

  it('withholds the words after a place reduction, stop or changed bytes, keeps the record and still allows removal', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.link(), change(0, p.textId)));
      await ok(await owner.post(p.link('object-2'), change(0, p.textId)));
      const counts = await owner.json(policyOf(p.draft.id, p.textId));
      assert.equal(counts.impacts.linkedMemories, 2);
      assert.equal((await owner.json(policyOf(p.draft.id, p.photoId))).impacts.linkedMemories, 2, 'counted for the base photo too');
      const stored = await readFile(path.join(dataDir, p.sidecar));
      await restrict(owner, p.draft.id, p.textId, { place: false, model: false, share: false });
      assert.deepEqual(await readFile(path.join(dataDir, p.sidecar)), stored, 'a restriction never rewrites links');
      const hidden = await ok(await owner.request(p.link()));
      assert.deepEqual(hidden.source, { sourceId: p.textId, available: false, reason: 'source', text: null });
      assert.deepEqual([hidden.link.available, hidden.link.reason], [false, 'source']);
      assert.ok(!JSON.stringify(hidden).includes('counter faced'));
      await refused(await owner.post(p.link(), change(1, p.textId)), 403);
      assert.equal((await ok(await owner.post(p.link(), change(1, p.textId, 'remove')))).link, null, 'an unavailable link can be removed');

      // Changed saved bytes: the stored words no longer match their record.
      const q = await place(owner);
      await ok(await owner.post(q.link(), change(0, q.textId)));
      const draftFile = path.join(dataDir, 'drafts', q.draft.id, 'draft.json');
      const draft = JSON.parse(await readFile(draftFile, 'utf8'));
      await writeFile(draftFile, JSON.stringify({ ...draft, text: draft.text.replace('window', 'door  ') }));
      const changed = await ok(await owner.request(q.link()));
      assert.deepEqual([changed.source.reason, changed.source.text, changed.link.reason], ['checksum', null, 'checksum']);
      await refused(await owner.post(q.link('object-2'), change(0, q.textId)), 409);
      // Words and their record changed together validate as a new candidate,
      // but are never shown for the link that bound the old checksum.
      const bytes = Buffer.from(draft.text.replace('window', 'door'), 'utf8');
      const sources = draft.sources.map((item) => (item.id === q.textId ? { ...item, size: bytes.length, sha256: sha256(bytes) } : item));
      await writeFile(draftFile, JSON.stringify({ ...draft, text: bytes.toString('utf8'), sources }));
      const rebound = await ok(await owner.request(q.link()));
      assert.deepEqual(rebound.source, { sourceId: q.textId, available: false, reason: 'checksum', text: null });
      assert.deepEqual([rebound.link.available, rebound.link.reason], [false, 'checksum']);
      assert.ok(!JSON.stringify(rebound).includes('faced the door'));
      assert.equal((await ok(await owner.request(q.link('object-2')))).source.text, bytes.toString('utf8'), 'an unlinked object may review the current words');
      // A removal must name the linked source; a mismatch changes nothing.
      const sidecar = await readFile(path.join(dataDir, q.sidecar));
      await refused(await owner.post(q.link(), change(1, randomUUID(), 'remove')), 409);
      assert.deepEqual(await readFile(path.join(dataDir, q.sidecar)), sidecar);
      // A stopped base photo holds every route.
      await restrict(owner, q.draft.id, q.photoId, { place: false, model: false, share: false }, true);
      await refused(await owner.request(q.link()), 409);
      await refused(await owner.post(q.link(), change(1, q.textId, 'remove')), 409);
    } finally {
      await app.close();
    }
  });

  it('replays exactly, receipts no-ops, keeps the cap and lets one of two concurrent changes win', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      const first = change(0, p.textId);
      await ok(await owner.post(p.link(), first));
      await ok(await owner.post(p.link(), change(1, p.textId, 'remove')));
      const replay = await ok(await owner.post(p.link(), first));
      assert.deepEqual([replay.replayed, replay.changed, replay.appliedRevision, replay.revision, replay.link], [true, false, 1, 2, null], 'never reapplied');
      await refused(await owner.post(p.link(), { ...first, action: 'remove' }), 409);
      await refused(await owner.post(p.link(), change(1, p.textId)), 409);
      await ok(await owner.post(p.link(), change(2, p.textId)));
      const noop = change(3, p.textId);
      const same = await ok(await owner.post(p.link(), noop));
      assert.deepEqual([same.changed, same.revision, same.appliedRevision], [false, 3, 3]);
      await refused(await owner.post(p.link(), { ...noop, action: 'remove' }), 409, 'a no-op ID is spent');
      const results = await Promise.all([owner.post(p.link(), change(3, p.textId, 'remove')), owner.post(p.link(), change(3, p.textId, 'remove'))]);
      assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);

      const file = path.join(dataDir, p.sidecar);
      const state = JSON.parse(await readFile(file, 'utf8'));
      const entry = state.objects['object-1'];
      const filler = Array.from({ length: 200 - entry.receipts.length }, () => ({ requestId: randomUUID(), digest: sha256(randomUUID()), revision: entry.revision }));
      await writeFile(file, JSON.stringify({ ...state, objects: { ...state.objects, 'object-1': { ...entry, receipts: [...entry.receipts, ...filler] } } }));
      await refused(await owner.post(p.link(), change(entry.revision, p.textId)), 409);
      assert.equal((await ok(await owner.post(p.link(), first))).replayed, true, 'an exact replay is found before the cap');
      await ok(await owner.post(p.link('object-2'), change(0, p.textId)));
    } finally {
      await app.close();
    }
  });

  it('treats a corrupt, oversized or linked sidecar as unavailable, not empty, without blocking anything else', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.link(), change(0, p.textId)));
      const file = path.join(dataDir, p.sidecar);
      const valid = JSON.parse(await readFile(file, 'utf8'));
      const bad = (mutate) => {
        const copy = structuredClone(valid);
        mutate(copy);
        return JSON.stringify(copy);
      };
      const outside = path.join(dataDir, 'outside-links.json');
      await writeFile(outside, JSON.stringify(valid));
      const cases = ['{broken', bad((s) => { s.objects['object-3'] = s.objects['object-1']; }), bad((s) => { s.objects['object-1'].link.linkedAt = 'yesterday'; }),
        bad((s) => { s.objects['object-1'].extra = 1; }), JSON.stringify(valid) + ' '.repeat(256 * 1024), 'symlink'];
      for (const content of cases) {
        await rm(file, { force: true });
        if (content === 'symlink') await symlink(outside, file);
        else await writeFile(file, content);
        assert.deepEqual(await (await owner.request(p.link())).json(), { error: UNAVAILABLE }, content.slice(0, 30));
        await refused(await owner.post(p.link(), change(1, p.textId, 'remove')), 503);
        assert.equal((await owner.request(p.scene)).status, 200);
        assert.equal((await owner.request(`${p.scene}/objects/object-1/region-links`)).status, 200, 'region links unaffected');
        assert.equal((await owner.json(policyOf(p.draft.id, p.textId))).impacts.linkedMemories, null, 'unknown, never a false zero');
        assert.equal((await restrict(owner, p.draft.id, p.textId, { place: true, model: false, share: false })).saved, true, 'restriction still works');
      }
      assert.equal(await readFile(outside, 'utf8'), JSON.stringify(valid), 'the link target was not touched');
    } finally {
      await app.close();
    }
  });

  it('reports the link count as unknown when the scene record cannot establish its base photo', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.link(), change(0, p.textId)));
      const manifestFile = path.join(dataDir, 'reconstructions', p.draft.id, p.job.id, 'manifest.json');
      const original = JSON.parse(await readFile(manifestFile, 'utf8'));
      const sidecar = await readFile(path.join(dataDir, p.sidecar));
      for (const [label, manifest] of [['empty', {}], ['other job', { ...original, id: randomUUID() }], ['other draft', { ...original, draftId: randomUUID() }],
        ['bad base', { ...original, sourceId: 'not-a-photo' }], ['no base', (({ sourceId, ...rest }) => rest)(original)]]) {
        await writeFile(manifestFile, JSON.stringify(manifest));
        for (const sourceId of [p.photoId, p.textId]) {
          assert.equal((await owner.json(policyOf(p.draft.id, sourceId))).impacts.linkedMemories, null, `${label}: never a false zero`);
        }
        const restricted = await restrict(owner, p.draft.id, p.textId, { place: true, model: false, share: false });
        assert.equal(restricted.saved, true, `${label}: restriction still works`);
        assert.deepEqual(await readFile(path.join(dataDir, p.sidecar)), sidecar, `${label}: links unchanged`);
      }
      await writeFile(manifestFile, JSON.stringify(original));
      assert.equal((await owner.json(policyOf(p.draft.id, p.photoId))).impacts.linkedMemories, 1, 'counted again once the record is intact');
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
      await ok(await owner.post(p.link(), change(0, p.textId)));
      const after = await (await owner.post(`${shares}/previews`, previewBody())).json();
      assert.deepEqual(after.publicView, before.publicView);
      assert.equal(await (await visit()).text(), visited);
      assert.ok(!visited.includes('counter faced'));
      const proposal = await (await owner.post(`${p.scene}/proposals`, { requestId: randomUUID(), baseVersion: 1, text: 'Turn it toward the light.', consent: true, targetId: 'object-1' })).json();
      await settle(owner, `${p.scene}/proposals/${proposal.id}`);
      assert.equal(calls.length, 1);
      assert.ok(!JSON.stringify(calls[0], (key, value) => (Buffer.isBuffer(value) ? `bytes:${value.length}` : value)).includes('counter faced'));
    } finally {
      await app.close();
    }
  });

  it('counts and hashes links in a deletion review, removes the sidecar and its temps, and keeps legacy records exact', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      await ok(await owner.post(p.link(), change(0, p.textId)));
      await ok(await owner.post(p.link('object-2'), change(0, p.textId)));
      const review = await owner.json(`/api/drafts/${p.draft.id}/deletion`);
      assert.equal(review.inventory.linkedMemories, 2);
      // A changed link makes that review stale.
      await ok(await owner.post(p.link(), change(1, p.textId, 'remove')));
      assert.equal((await owner.post(`/api/drafts/${p.draft.id}/delete`, { requestId: randomUUID(), impactSha256: review.impactSha256, confirmDeletion: true })).status, 409);
      const jobDir = path.join(dataDir, 'reconstructions', p.draft.id, p.job.id);
      await writeFile(path.join(jobDir, `memory-links.json.${randomUUID()}.tmp`), '{"text":"Synthetic copy."}');
      const current = await owner.json(`/api/drafts/${p.draft.id}/deletion`);
      assert.equal(current.inventory.linkedMemories, 1);
      const deleted = await owner.post(`/api/drafts/${p.draft.id}/delete`, { requestId: randomUUID(), impactSha256: current.impactSha256, confirmDeletion: true });
      assert.equal(deleted.status, 200);
      const record = await deleted.json();
      assert.equal(record.inventory.linkedMemories, 1);
      assert.equal(await exists(jobDir), false, 'the sidecar and its temporary copy are gone');
      await refused(await owner.request(p.link()), 404);
      await refused(await owner.post(p.link(), change(0, p.textId)), 404);
      const stored = JSON.parse(await readFile(path.join(dataDir, 'place-deletions', `${p.draft.id}.json`), 'utf8'));
      assert.equal(stored.schemaVersion, 2);

      // A schema 1 record keeps its exact 13-key inventory; mixed shapes fail closed.
      const legacyId = randomUUID();
      const { linkedMemories, ...oldInventory } = stored.inventory;
      const legacy = { ...stored, schemaVersion: 1, draftId: legacyId, inventory: oldInventory };
      const legacyFile = path.join(dataDir, 'place-deletions', `${legacyId}.json`);
      await writeFile(legacyFile, JSON.stringify(legacy));
      const bytes = await readFile(legacyFile);
      const legacyState = await (await owner.request(`/api/drafts/${legacyId}/deletion`)).json();
      assert.equal(legacyState.state, 'complete');
      assert.equal('linkedMemories' in legacyState.inventory, false, 'never synthesized');
      assert.deepEqual(await readFile(legacyFile), bytes, 'byte-identical');
      for (const mixed of [{ ...legacy, inventory: stored.inventory }, { ...stored, draftId: legacyId, inventory: oldInventory }]) {
        await writeFile(legacyFile, JSON.stringify(mixed));
        assert.equal((await owner.request(`/api/drafts/${legacyId}/deletion`)).status, 503, `schema ${mixed.schemaVersion}`);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps a deletion pending on a linked memory sidecar and never follows it', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const p = await place(owner);
      const outside = path.join(dataDir, 'outside.json');
      await writeFile(outside, '{"schemaVersion":1,"objects":{}}');
      await symlink(outside, path.join(dataDir, p.sidecar));
      assert.equal((await owner.request(`/api/drafts/${p.draft.id}/deletion`)).status, 503, 'review refuses a linked sidecar');
      assert.equal(await readFile(outside, 'utf8'), '{"schemaVersion":1,"objects":{}}');
    } finally {
      await app.close();
    }
  });
});

const stat0 = async (dataDir, relative) => (await lstat(path.join(dataDir, relative))).mode;
