import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { client, enrolledContributor, jpeg, png, readyScene, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic scenes and recollections only. The recorded target is the
// object the owner chose when adopting or keeping a recollection; nothing
// here interprets the contributor's words.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const GRANT = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];

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

async function workspace(dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-targets-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function twoObjectScene(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo');
  form.append('metadata', JSON.stringify({ photos: [GRANT] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: OBJECTS })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && ['queued', 'processing'].includes((await owner.json(scene)).status); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 200);
  return { draft, job, scene };
}

const recollection = (session, scene, text) => session.post(`${scene}/contributions`, { requestId: randomUUID(), text, permissions: { place: true, model: false, share: false }, periodClaim: '' });
const reviewBody = (baseVersion, baseRevision, decision, transform) => ({ requestId: randomUUID(), baseVersion, baseRevision, decision, reason: 'Synthetic note.', conflict: 'unknown', transform });
const manifestPath = (dataDir, place) => path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json');
const ownerView = (owner, place) => owner.json(`${place.scene}/collaboration`);
const targets = (view) => ({
  reviews: Object.fromEntries(view.contributions.map((item) => [item.text, item.review?.targetId])),
  variants: view.variants.map((item) => [item.label, item.targetId]),
});

// One alternative kept for object-1 and one adoption for object-2, plus a held recollection.
async function reviewed(app, owner) {
  const place = await twoObjectScene(owner);
  const { session } = await enrolledContributor(owner, app.base, place.draft.id);
  for (const text of ['Kept as alternative.', 'Adopted for object 2.', 'Held without geometry.']) assert.equal((await recollection(session, place.scene, text)).status, 200);
  const contributions = (await ownerView(owner, place)).contributions;
  const byText = (text) => contributions.find((item) => item.text === text);
  const alternative = reviewBody(1, 1, 'alternative', { targetId: 'object-1', offset: [0, 0.2, 0], yaw: 0 });
  assert.equal((await owner.post(`${place.scene}/contributions/${byText('Kept as alternative.').id}/review`, alternative)).status, 200);
  const adopt = reviewBody(1, 1, 'adopt', { targetId: 'object-2', offset: [0, 0.2, 0], yaw: 0 });
  assert.equal((await owner.post(`${place.scene}/contributions/${byText('Adopted for object 2.').id}/review`, adopt)).status, 200);
  assert.equal((await owner.post(`${place.scene}/contributions/${byText('Held without geometry.').id}/review`, reviewBody(2, 1, 'hold', null))).status, 200);
  return { place, session, alternative, adopt, ids: Object.fromEntries(contributions.map((item) => [item.text, item.id])) };
}

describe('recorded review targets', () => {
  it('records the chosen object on new adoptions and alternatives only, owner-only, across replay and restart', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const { place, session, adopt, ids } = await reviewed(app, owner);
      const disk = JSON.parse(await readFile(manifestPath(dataDir, place), 'utf8'));
      const stored = (text) => disk.collaboration.contributions.find((item) => item.id === ids[text]).review;
      assert.equal(stored('Kept as alternative.').targetId, 'object-1');
      assert.equal(stored('Adopted for object 2.').targetId, 'object-2');
      assert.equal(Object.hasOwn(stored('Held without geometry.'), 'targetId'), false, 'no target without geometry');
      const candidates = disk.collaboration.variants.filter((item) => item.kind === 'candidate');
      assert.deepEqual(candidates.map((item) => item.targetId).sort(), ['object-1', 'object-2']);
      assert.equal(Object.hasOwn(disk.collaboration.variants.find((item) => item.kind === 'baseline'), 'targetId'), false, 'a baseline has none');

      const expected = {
        reviews: { 'Kept as alternative.': 'object-1', 'Adopted for object 2.': 'object-2', 'Held without geometry.': null },
        variants: [['Saved reconstruction', null], ["Synthetic contributor's recollection", 'object-1'], ["Synthetic contributor's recollection", 'object-2']],
      };
      assert.deepEqual(targets(await ownerView(owner, place)), expected);
      const replay = await owner.post(`${place.scene}/contributions/${ids['Adopted for object 2.']}/review`, adopt);
      assert.equal((await replay.json()).contribution.review.targetId, 'object-2', 'an exact replay projects the same target');
      // Contributors see their fixed outcome shape only.
      for (const item of (await session.json(`${place.scene}/collaboration`)).contributions) {
        if (item.review) assert.deepEqual(Object.keys(item.review).sort(), ['decision', 'reviewedAt', 'variantId', 'version']);
      }
      await app.close();
      ({ app, owner } = await workspace(dataDir));
      assert.deepEqual(targets(await ownerView(owner, place)), expected, 'kept across a restart');
    } finally {
      await app.close();
    }
  });

  it('recovers a pre-field adoption only from its unique exact receipt and never repairs inconsistent records', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const { place, ids } = await reviewed(app, owner);
      const file = manifestPath(dataDir, place);
      const original = JSON.parse(await readFile(file, 'utf8'));
      const adoptedId = ids['Adopted for object 2.'];
      const alternativeId = ids['Kept as alternative.'];
      const review = (manifest, id) => manifest.collaboration.contributions.find((item) => item.id === id).review;
      const candidate = (manifest, id) => manifest.collaboration.variants.find((item) => item.id === review(manifest, id).variantId);
      const receipt = (manifest) => manifest.edits.find((item) => item.kind === 'contribution' && item.contributionId === adoptedId);
      const legacy = () => {
        const manifest = structuredClone(original);
        for (const id of [adoptedId, alternativeId]) {
          delete review(manifest, id).targetId;
          delete candidate(manifest, id).targetId;
        }
        return manifest;
      };
      const check = async (label, mutate, adopted, kept) => {
        const manifest = legacy();
        mutate(manifest);
        await writeFile(file, JSON.stringify(manifest));
        const bytes = await readFile(file);
        const view = await ownerView(owner, place);
        const get = (id) => view.contributions.find((item) => item.id === id).review.targetId;
        assert.deepEqual([get(adoptedId), get(alternativeId)], [adopted, kept], label);
        const variant = (id) => view.variants.find((item) => item.id === review(manifest, id).variantId)?.targetId ?? null;
        assert.deepEqual([variant(adoptedId), variant(alternativeId)], [adopted, kept], `${label}: variants`);
        assert.deepEqual(await readFile(file), bytes, `${label}: nothing rewritten`);
      };
      // New-format records too: the adoption must agree with its receipt, and
      // a candidate needs exactly one linked review.
      const current = async (label, mutate, adopted, kept) => {
        const manifest = structuredClone(original);
        mutate(manifest);
        await writeFile(file, JSON.stringify(manifest));
        const view = await ownerView(owner, place);
        const get = (id) => view.contributions.find((item) => item.id === id).review.targetId;
        assert.deepEqual([get(adoptedId), get(alternativeId)], [adopted, kept], label);
      };
      await check('pre-field records', () => {}, 'object-2', null);
      await check('receipt without a target', (m) => { delete receipt(m).targetId; }, null, null);
      await check('two matching receipts', (m) => { m.edits.push({ ...receipt(m) }); }, null, null);
      await check('receipt for another version', (m) => { receipt(m).version = 9; }, null, null);
      await check('variant version mismatch', (m) => { candidate(m, adoptedId).edit.version = 9; }, null, null);
      await check('present invalid review field', (m) => { review(m, adoptedId).targetId = 'object-9'; }, null, null);
      await check('candidate disagrees', (m) => { candidate(m, adoptedId).targetId = 'object-1'; }, null, null);
      await check('alternative with a version', (m) => { review(m, alternativeId).version = 2; }, 'object-2', null);
      // Agreeing but impossible adoption versions: before version 2, negative or beyond the saved one.
      for (const version of [0, -1, 1, 99]) {
        await check(`adoption version ${version}`, (m) => {
          review(m, adoptedId).version = version;
          candidate(m, adoptedId).edit.version = version;
          receipt(m).version = version;
        }, null, null);
        await current(`new-format adoption version ${version}`, (m) => {
          review(m, adoptedId).version = version;
          candidate(m, adoptedId).edit.version = version;
          receipt(m).version = version;
        }, null, 'object-1');
      }
      await current('stored fields agree', () => {}, 'object-2', 'object-1');
      await current('receipt disagrees', (m) => { receipt(m).targetId = 'object-1'; }, null, 'object-1');
      await current('two reviews claim one candidate', (m) => { review(m, adoptedId).variantId = review(m, alternativeId).variantId; }, null, null);
      await current('orphan candidate', (m) => { review(m, alternativeId).variantId = randomUUID(); }, 'object-2', null);
      const orphan = await ownerView(owner, place);
      assert.equal(orphan.variants.find((item) => item.id === candidate(original, alternativeId).id).targetId, null, 'an orphan candidate is always null');
      await writeFile(file, JSON.stringify(original));
    } finally {
      await app.close();
    }
  });

  it('records no target on a single-object scene and keeps withdrawal redaction', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await readyScene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const submitted = await (await recollection(session, place.scene, 'Single object recollection.')).json();
      assert.equal((await owner.post(`${place.scene}/contributions/${submitted.id}/review`, reviewBody(1, 1, 'adopt', { offset: [0, 0, -0.5], yaw: 0 }))).status, 200);
      const disk = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json'), 'utf8'));
      assert.equal(Object.hasOwn(disk.collaboration.contributions[0].review, 'targetId'), false);
      assert.ok(disk.collaboration.variants.every((item) => !Object.hasOwn(item, 'targetId')));
      const view = await ownerView(owner, place);
      assert.equal(view.contributions[0].review.targetId, null);
      assert.ok(view.variants.every((item) => item.targetId === null));

      const two = await reviewed(app, owner);
      const withdrawn = await two.session.post(`${two.place.scene}/contributions/${two.ids['Adopted for object 2.']}/withdraw`, { requestId: randomUUID() });
      assert.equal(withdrawn.status, 200);
      const after = (await ownerView(owner, two.place)).contributions.find((item) => item.id === two.ids['Adopted for object 2.']);
      assert.deepEqual([after.text, after.review.reason, after.review.targetId], [null, null, 'object-2'], 'words stay withdrawn; the owner keeps the object');
    } finally {
      await app.close();
    }
  });
});
