import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { anchorYaw } from '../memory-proposals.mjs';
import { checkRelationship } from '../public/scene-relations.js';
import { client, enrolledContributor, jpeg, png, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

// A synthetic 16 x 12 depth grid: object-1 on the left, object-2 on the right,
// background elsewhere, one void cell between them. No personal media.
const GRID = { width: 16, height: 12 };
function regionsGrid() {
  const regions = [];
  for (let y = 0; y < GRID.height; y++) {
    for (let x = 0; x < GRID.width; x++) {
      const inRows = y >= 2 && y <= 9;
      regions.push(inRows && x >= 1 && x <= 5 ? 1 : inRows && x >= 10 && x <= 14 ? 2 : 0);
    }
  }
  regions[GRID.width * 1 + 8] = -1;
  return regions;
}

// Grid regions from rectangles [region, x1, x2, y1, y2] (inclusive), background elsewhere.
function gridOf(width, height, rects, voids = []) {
  const regions = Array(width * height).fill(0);
  for (const [region, x1, x2, y1, y2] of rects) {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) regions[y * width + x] = region;
  }
  for (const [x, y] of voids) regions[y * width + x] = -1;
  return regions;
}

// Optional override for the next build's surface and summary, to break one frozen limit.
let nextOutput = null;

// Writes the worker's outputs for a two-object request from the actual input file.
async function twoObjectRunner(call) {
  twoObjectRunner.calls.push(call);
  const { imagePath, outputDir, sourceId, objects } = call;
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const selected = objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box }));
  const surface = {
    schema_version: 2,
    source: {
      source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30],
      texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' },
      selected_objects: selected,
    },
    objects: selected,
    ...GRID,
    depth: Array(GRID.width * GRID.height).fill(3),
    regions: regionsGrid(),
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
  const summary = { source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture), overlap: { pixels: 1, ratio: 0.001 } };
  if (nextOutput) {
    nextOutput(surface, summary);
    nextOutput = null;
  }
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(16, 12), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify(surface),
    'summary.json': JSON.stringify(summary),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}
twoObjectRunner.calls = [];

const grant = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const OBJECTS = [{ label: '  Display counter ', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];

async function workspace(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-two-'));
  tempDirs.push(dataDir);
  const app = await startOwnerServer({ dataDir, reconstructionRunner: twoObjectRunner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function twoObjectScene(owner, { confirm = true, expect = 'ready' } = {}) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant], voice: grant }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const response = await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: OBJECTS });
  assert.equal(response.status, 202);
  const job = await response.json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  let manifest;
  for (let attempt = 0; attempt < 200; attempt++) {
    manifest = await owner.json(scene);
    if (manifest.status !== 'queued' && manifest.status !== 'processing') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manifest.status, expect, manifest.error);
  if (expect !== 'ready') return { draft, job, scene, manifest };
  if (confirm) assert.equal((await owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 200);
  return { draft, job, scene, manifest: await owner.json(scene) };
}

const LEFT_OF = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const editBody = (baseVersion, targetId, offset, yaw = 0) => ({ requestId: randomUUID(), baseVersion, targetId, offset, yaw });

it('refuses a legacy relationship replay after an inherited contribution is withdrawn', async () => {
  const { app, owner } = await workspace();
  try {
    const { scene } = await twoObjectScene(owner);
    const submitted = await owner.post(`${scene}/contributions`, { requestId: randomUUID(), text: 'Synthetic remembered location', permissions: { place: true, model: false, share: true }, periodClaim: '' });
    assert.equal(submitted.status, 200);
    const contribution = await submitted.json();
    const adopted = await owner.post(`${scene}/contributions/${contribution.id}/review`, {
      requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { targetId: 'object-1', offset: [-0.1, 0, 0], yaw: 0 },
    });
    assert.equal(adopted.status, 200, JSON.stringify(await adopted.clone().json()));
    const relationship = { requestId: randomUUID(), baseVersion: 2, relationship: LEFT_OF, confirmed: true };
    assert.equal((await owner.post(`${scene}/relationship`, relationship)).status, 200);
    assert.equal((await owner.post(`${scene}/contributions/${contribution.id}/withdraw`, { requestId: randomUUID() })).status, 200);
    const replayed = await owner.post(`${scene}/relationship`, relationship);
    assert.equal(replayed.status, 409);
    assert.match((await replayed.json()).error, /withdrawn/i);
    assert.equal((await owner.json(scene)).edit.version, 3);
  } finally { await app.close(); }
});

describe('two-object builds', () => {
  it('admits two named boxes, sends them to the worker and stores renderer pivots once', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await twoObjectScene(owner, { confirm: false });
      const call = twoObjectRunner.calls.at(-1);
      assert.deepEqual(call.objects, [
        { id: 'object-1', label: 'Display counter', box: [2, 4, 14, 26] },
        { id: 'object-2', label: 'Flour stack', box: [24, 4, 38, 26] },
      ]);
      const { manifest } = place;
      assert.equal(manifest.objectsConfirmed, false);
      assert.deepEqual(manifest.objects.map(({ id, label, box }) => ({ id, label, box })), call.objects);
      for (const { pivot } of manifest.objects) assert.ok(pivot.length === 3 && pivot.every(Number.isFinite));
      assert.ok(manifest.objects[0].pivot[0] < 0 && manifest.objects[1].pivot[0] > 0);
      assert.deepEqual(manifest.edit, {
        version: 1, objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }], relationship: null,
      });
      assert.equal('box' in manifest, false);
    } finally {
      await app.close();
    }
  });

  it('publishes nothing when the delivered grid breaks a frozen coverage or overlap limit', async () => {
    const { app, owner } = await workspace();
    try {
      const bigGrid = (rects, voids, overlap) => (surface, summary) => {
        Object.assign(surface, { width: 32, height: 24, depth: Array(32 * 24).fill(3), regions: gridOf(32, 24, rects, voids) });
        summary.overlap = overlap;
      };
      const cases = {
        'one object over 50%': bigGrid([[1, 1, 21, 1, 20], [2, 24, 29, 3, 8]], [], { pixels: 0, ratio: 0 }),
        'both over 60% together': bigGrid([[1, 2, 13, 2, 21], [2, 17, 28, 2, 21]], [], { pixels: 0, ratio: 0 }),
        'overlap over 1%': (surface, summary) => {
          summary.overlap = { pixels: 9, ratio: 0.02 };
        },
        'void cells without an overlap': (surface, summary) => {
          summary.overlap = { pixels: 0, ratio: 0 };
        },
        'an overlap without void cells': (surface) => {
          surface.regions = surface.regions.map((value) => (value === -1 ? 0 : value));
        },
        'a missing overlap record': (surface, summary) => {
          delete summary.overlap;
        },
      };
      for (const [name, change] of Object.entries(cases)) {
        nextOutput = change;
        const { manifest } = await twoObjectScene(owner, { expect: 'failed' });
        assert.match(manifest.error, /incomplete or inconsistent/, name);
        assert.ok(manifest.objects.every((item) => item.pivot === null), name);
      }
      // The same large grid within every limit is published.
      nextOutput = bigGrid([[1, 2, 10, 2, 21], [2, 18, 27, 2, 21]], [], { pixels: 0, ratio: 0 });
      await twoObjectScene(owner, { confirm: false });
    } finally {
      nextOutput = null;
      await app.close();
    }
  });

  it('refuses duplicate, blank, long or extra objects and keeps the one-object body', async () => {
    const { app, owner } = await workspace();
    try {
      const form = new FormData();
      form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
      form.append('metadata', JSON.stringify({ photos: [grant] }));
      const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
      const build = (objects) => owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects });
      for (const objects of [
        [OBJECTS[0], { ...OBJECTS[1], label: 'display COUNTER' }], [OBJECTS[0], { ...OBJECTS[1], label: '  ' }], [OBJECTS[0], { ...OBJECTS[1], label: 'x'.repeat(81) }],
        [OBJECTS[0]], [...OBJECTS, OBJECTS[1]], [OBJECTS[0], { ...OBJECTS[1], extra: 1 }], [OBJECTS[0], { ...OBJECTS[1], box: [5, 5, 4, 9] }],
      ]) {
        assert.equal((await build(objects)).status, 400, JSON.stringify(objects).slice(0, 60));
      }
      assert.equal((await build([OBJECTS[0], { ...OBJECTS[1], box: [24, 4, 41, 26] }])).status, 400, 'box outside the photo');
      assert.equal((await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: OBJECTS, box: [1, 1, 5, 5] })).status, 400);
    } finally {
      await app.close();
    }
  });
});

describe('two-object editing', () => {
  it('requires confirmation of both objects before any change or sharing', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await twoObjectScene(owner, { confirm: false });
      const blocked = [
        [`${place.scene}/edit`, editBody(1, 'object-1', [0.2, 0, 0])],
        [`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true }],
        [`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 1, targetVersion: 1, ruleChangeConfirmed: false }],
      ];
      for (const [route, body] of blocked) {
        const response = await owner.post(route, body);
        assert.equal(response.status, 409, route);
        assert.match((await response.json()).error, /Confirm that both outlined objects/, route);
      }
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const preview = await owner.post(`${place.scene}/shares/previews`, {
        requestId: randomUUID(), title: 'Synthetic shop', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
      });
      assert.equal(preview.status, 409);
      assert.equal((await owner.json(place.scene)).edit.version, 1);

      for (const objectIds of [['object-1'], ['object-1', 'object-1'], ['object-1', 'object-3']]) {
        assert.equal((await owner.post(`${place.scene}/objects/confirm`, { requestId: randomUUID(), objectIds })).status, 400);
      }
      const body = { requestId: randomUUID(), objectIds: ['object-2', 'object-1'] };
      const confirmed = await owner.post(`${place.scene}/objects/confirm`, body);
      assert.equal(confirmed.status, 200);
      assert.equal((await confirmed.json()).objectsConfirmed, true);
      assert.equal((await owner.post(`${place.scene}/objects/confirm`, body)).status, 200);
      const scene = await owner.json(place.scene);
      assert.equal(scene.objectsConfirmed, true);
      assert.equal(scene.edit.version, 1, 'confirmation is not a version');
    } finally {
      await app.close();
    }
  });

  it('moves only the chosen object, keeps a saved rule and refuses an edit that breaks it', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await twoObjectScene(owner);
      const pivots = place.manifest.objects.map(({ id, pivot }) => ({ id, pivot }));
      assert.equal((await owner.post(`${place.scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0, 0, 0], yaw: 0 })).status, 400, 'one-object body');
      const body = editBody(1, 'object-2', [0, 0.1, 0], 0.5);
      const moved = await owner.post(`${place.scene}/edit`, body);
      assert.equal(moved.status, 200);
      const edit = await moved.json();
      assert.deepEqual(edit, {
        version: 2, objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0.1, 0], yaw: 0.5 }], relationship: null,
      });
      assert.deepEqual(await (await owner.post(`${place.scene}/edit`, body)).json(), edit, 'exact replay');
      assert.equal((await owner.post(`${place.scene}/edit`, { ...body, targetId: 'object-1' })).status, 409, 'changed replay');

      const rule = (relationship, baseVersion, confirmed = true) => owner.post(`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion, relationship, confirmed });
      assert.equal((await rule(LEFT_OF, 2, false)).status, 400);
      assert.equal((await rule({ ...LEFT_OF, leftId: 'object-2', rightId: 'object-1' }, 2)).status, 409, 'a rule that does not hold now');
      const saved = await rule(LEFT_OF, 2);
      assert.equal(saved.status, 200);
      assert.deepEqual((await saved.json()).relationship, LEFT_OF);
      assert.equal((await rule(LEFT_OF, 3)).status, 409, 'already saved');

      // Moving the left object past the right one from the original camera is refused.
      const [left, right] = pivots;
      const dx = Math.min(2, right.pivot[0] - left.pivot[0] + 0.3);
      const breaking = editBody(3, 'object-1', [dx, 0, 0]);
      assert.equal(checkRelationship({ objects: [{ id: 'object-1', offset: breaking.offset, yaw: 0 }, { id: 'object-2', offset: [0, 0.1, 0], yaw: 0.5 }], relationship: LEFT_OF }, pivots).reason, 'order');
      const refused = await owner.post(`${place.scene}/edit`, breaking);
      assert.equal(refused.status, 409);
      assert.match((await refused.json()).error, /relationship/);
      assert.equal((await owner.json(place.scene)).edit.version, 3, 'the last saved version is intact');
      // A turn never moves a centre, so it always keeps the rule.
      assert.equal((await owner.post(`${place.scene}/edit`, editBody(3, 'object-1', [0, 0, 0], Math.PI))).status, 200);

      const history = await owner.json(`${place.scene}/history`);
      assert.deepEqual(history.map((entry) => [entry.version, entry.kind, entry.targetId ?? null, entry.relationship?.kind ?? null]), [
        [1, 'initial', null, null], [2, 'manual', 'object-2', null], [3, 'relationship', null, 'left_of'], [4, 'manual', 'object-1', 'left_of'],
      ]);

      // Undo restores a whole arrangement and its rule; a different rule needs confirmation.
      assert.equal((await owner.post(`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 4, targetVersion: 2 })).status, 400, 'one-object undo body');
      assert.equal((await owner.post(`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 4, targetVersion: 2, ruleChangeConfirmed: false })).status, 409);
      const undone = await owner.post(`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 4, targetVersion: 2, ruleChangeConfirmed: true });
      assert.equal(undone.status, 200);
      assert.deepEqual(await undone.json(), { version: 5, objects: edit.objects, relationship: null });
      assert.equal((await owner.post(`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 5, targetVersion: 4, ruleChangeConfirmed: true })).status, 200);
      assert.deepEqual((await owner.json(place.scene)).edit.relationship, LEFT_OF);
    } finally {
      await app.close();
    }
  });

  it('refuses two-object routes on a one-object scene', async () => {
    const { app, owner } = await workspace({ reconstructionRunner: (await import('./auth-helper.mjs')).sceneRunner });
    try {
      const { readyScene } = await import('./auth-helper.mjs');
      const scene = await readyScene(owner);
      assert.equal((await owner.post(`${scene.scene}/edit`, editBody(1, 'object-1', [0, 0, 0]))).status, 400);
      assert.equal((await owner.post(`${scene.scene}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: null, confirmed: true })).status, 409);
      assert.equal((await owner.post(`${scene.scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 409);
      assert.equal((await owner.post(`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 1, targetVersion: 1, ruleChangeConfirmed: true })).status, 400);
    } finally {
      await app.close();
    }
  });
});

describe('two-object proposals', () => {
  const planFor = (call, targetId, delta) => ({
    ok: true, model: 'muse-spark-1.3', responseId: 'r', usage: null,
    plan: { action: 'translate', targetId, sourceId: call.sourceId, baseVersion: call.baseVersion, delta, yawDelta: null, anchor: null, question: null, reason: 'Synthetic plan.' },
  });

  it('plans for the selected object only and refuses a plan that breaks the rule', async () => {
    const calls = [];
    const steps = [];
    const proposalModel = async (call) => {
      calls.push(call);
      return steps.shift()(call);
    };
    const { app, owner } = await workspace({ proposalModel, prepareModelImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    try {
      const place = await twoObjectScene(owner);
      await owner.post(`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true });
      const propose = (targetId, change = {}) => owner.post(`${place.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'Lift it a little.', consent: true, targetId, ...change });
      assert.equal((await owner.post(`${place.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'x', consent: true })).status, 400, 'target required');
      assert.equal((await propose('object-3')).status, 400);
      const settle = async (id) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const item = await owner.json(`${place.scene}/proposals/${id}`);
          if (!['queued', 'processing'].includes(item.status)) return item;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('proposal did not settle');
      };

      steps.push((call) => planFor(call, 'object-2', [0, 0.2, 0]));
      const ready = await settle((await (await propose('object-2')).json()).id);
      assert.equal(ready.status, 'ready');
      assert.equal(ready.targetId, 'object-2');
      const [call] = calls;
      assert.equal(call.targetId, 'object-2');
      assert.deepEqual(call.saved, { offset: [0, 0, 0], yaw: 0 });
      assert.deepEqual(call.selection, [24 / 40, 4 / 30, 38 / 40, 26 / 30]);
      assert.deepEqual(call.objects.map(({ id, label }) => [id, label]), [['object-1', 'Display counter'], ['object-2', 'Flour stack']]);
      assert.deepEqual(call.relationship, LEFT_OF);

      // A plan naming the other object is refused, never re-targeted.
      steps.push((c) => planFor(c, 'object-1', [0, 0.2, 0]));
      assert.equal((await settle((await (await propose('object-2')).json()).id)).status, 'failed');
      // A plan moving the right object past the left one breaks the rule.
      steps.push((c) => planFor(c, 'object-2', [-2, 0, 0]));
      const broken = await settle((await (await propose('object-2')).json()).id);
      assert.equal(broken.status, 'failed');
      assert.match(broken.error, /relationship/);

      const applied = await owner.post(`${place.scene}/proposals/${ready.id}/apply`, { requestId: randomUUID(), baseVersion: 2, frontConfirmed: false });
      assert.equal(applied.status, 200);
      const { edit } = await applied.json();
      assert.deepEqual(edit.objects, [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0.2, 0], yaw: 0 }]);
      assert.deepEqual(edit.relationship, LEFT_OF);
      assert.equal((await owner.json(`${place.scene}/history`)).at(-1).targetId, 'object-2');
    } finally {
      await app.close();
    }
  });
});

describe('two-object metadata after a stop', () => {
  it('shows fixed object markers, never the owner\'s object names, once the photo is stopped', async () => {
    const decoder = async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
    const { app, owner, dataDir } = await workspace({ audioDecoder: decoder });
    try {
      const place = await twoObjectScene(owner);
      const story = await (await owner.post(`${place.scene}/stories`, {
        requestId: randomUUID(), voiceSourceId: place.draft.voice.sourceId, view: { kind: 'version', version: 1, variantId: null, eraRevision: null },
        title: 'Synthetic tone', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic test tone; no speech.' }], captionConfirmed: true, targetId: 'object-2',
      })).json();
      const photo = `/api/drafts/${place.draft.id}/sources/${place.draft.photos[0].sourceId}/policy`;
      const { revision } = await owner.json(photo);
      assert.equal((await owner.post(photo, { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true })).status, 200);

      const scene = await owner.json(place.scene);
      assert.deepEqual(scene.objects.map(({ id, label }) => [id, label]), [['object-1', 'Object 1'], ['object-2', 'Object 2']]);
      const storyDto = await owner.json(`${place.scene}/stories/${story.id}`);
      assert.deepEqual(storyDto.target, { id: 'object-2', label: 'Object 2' });
      const exposed = JSON.stringify([
        scene, await owner.json(`/api/drafts/${place.draft.id}/reconstructions`), await owner.json(`${place.scene}/history`),
        await owner.json(`${place.scene}/stories`), storyDto,
      ]);
      for (const name of ['Display counter', 'Flour stack']) assert.ok(!exposed.includes(name), name);
      const stored = await readFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json'), 'utf8');
      assert.ok(stored.includes('Display counter') && stored.includes('Flour stack'), 'the stored labels are kept');
    } finally {
      await app.close();
    }
  });
});

describe('two-object facing plans', () => {
  it('turns only the selected object toward a background point and refuses either object or the void', async () => {
    const calls = [];
    const anchors = [];
    const proposalModel = async (call) => {
      calls.push(call);
      return {
        ok: true, model: 'muse-spark-1.3', responseId: 'r', usage: null,
        plan: { action: 'face_anchor', targetId: call.targetId, sourceId: call.sourceId, baseVersion: call.baseVersion, delta: null, yawDelta: null, anchor: anchors.shift(), question: null, reason: 'Synthetic plan.' },
      };
    };
    const { app, owner, dataDir } = await workspace({ proposalModel, prepareModelImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    try {
      const place = await twoObjectScene(owner);
      // A saved, non-zero transform for the target shows the plan starts from it.
      assert.equal((await owner.post(`${place.scene}/edit`, editBody(1, 'object-2', [0, 0.1, 0]))).status, 200);
      assert.equal((await owner.post(`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion: 2, relationship: LEFT_OF, confirmed: true })).status, 200);
      const settle = async (id) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const item = await owner.json(`${place.scene}/proposals/${id}`);
          if (!['queued', 'processing'].includes(item.status)) return item;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('proposal did not settle');
      };
      const propose = async (point) => {
        anchors.push({ label: 'doorway', point });
        const response = await owner.post(`${place.scene}/proposals`, { requestId: randomUUID(), baseVersion: 3, text: 'It faced the door.', consent: true, targetId: 'object-2' });
        return settle((await response.json()).id);
      };
      // Grid cells: (3, 5) is object-1, (12, 5) is object-2, (8, 1) is void, (8, 0) is background.
      for (const point of [[3 / 15, 5 / 11], [12 / 15, 5 / 11], [8 / 15, 1 / 11]]) {
        const refused = await propose(point);
        assert.equal(refused.status, 'failed', JSON.stringify(point));
        assert.match(refused.error, /facing point/);
      }
      const background = [8 / 15, 0];
      const ready = await propose(background);
      assert.equal(ready.status, 'ready');
      const call = calls.at(-1);
      assert.equal(call.targetId, 'object-2');
      assert.deepEqual(call.saved, { offset: [0, 0.1, 0], yaw: 0 });
      const surface = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'assets', 'surface.json'), 'utf8'));
      const yaw = anchorYaw(surface, background, [0, 0.1, 0], 'object-2');
      assert.ok(Number.isFinite(yaw));
      assert.deepEqual(ready.result.transform, { offset: [0, 0.1, 0], yaw });

      assert.equal((await owner.post(`${place.scene}/proposals/${ready.id}/apply`, { requestId: randomUUID(), baseVersion: 3, frontConfirmed: false })).status, 409);
      const applied = await owner.post(`${place.scene}/proposals/${ready.id}/apply`, { requestId: randomUUID(), baseVersion: 3, frontConfirmed: true });
      assert.equal(applied.status, 200);
      const { edit } = await applied.json();
      assert.deepEqual(edit, {
        version: 4, objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0.1, 0], yaw }], relationship: LEFT_OF,
      });
    } finally {
      await app.close();
    }
  });
});

describe('two-object contributions, sharing and stories', () => {
  it('adopts a contributor arrangement for one named object and freezes the whole arrangement in the baseline', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await twoObjectScene(owner);
      await owner.post(`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true });
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      await session.post(`${place.scene}/contributions`, { requestId: randomUUID(), text: 'The flour sat higher.', permissions: { place: true, model: false, share: true }, periodClaim: '' });
      const state = await owner.json(`${place.scene}/collaboration`);
      const [baseline] = state.variants;
      assert.equal(baseline.parentVersion, 2);
      assert.deepEqual(baseline.edit, { version: 2, objects: place.manifest.edit.objects, relationship: LEFT_OF });

      const [item] = state.contributions;
      const review = (transform, decision = 'adopt') => owner.post(`${place.scene}/contributions/${item.id}/review`, {
        requestId: randomUUID(), baseVersion: 2, baseRevision: 1, decision, reason: '', conflict: 'unknown', transform,
      });
      assert.equal((await review({ offset: [0, 0.2, 0], yaw: 0 })).status, 400, 'one-object transform');
      assert.equal((await review({ targetId: 'object-2', offset: [-2, 0, 0], yaw: 0 })).status, 409, 'breaks the rule');
      const adopted = await review({ targetId: 'object-2', offset: [0, 0.2, 0], yaw: 0 });
      assert.equal(adopted.status, 200);
      const { edit, variant } = await adopted.json();
      assert.deepEqual(edit.objects[0], { id: 'object-1', offset: [0, 0, 0], yaw: 0 });
      assert.deepEqual(edit.objects[1], { id: 'object-2', offset: [0, 0.2, 0], yaw: 0 });
      assert.deepEqual(edit.relationship, LEFT_OF);
      assert.deepEqual(variant.edit, { version: 3, objects: edit.objects, relationship: LEFT_OF });
      assert.equal((await owner.json(`${place.scene}/history`)).at(-1).targetId, 'object-2');
    } finally {
      await app.close();
    }
  });

  it('shares both objects and the rule with an allowlisted region surface', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await twoObjectScene(owner);
      await owner.post(`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true });
      const view = { id: randomUUID(), kind: 'version', version: 2, variantId: null };
      const preview = await (await owner.post(`${place.scene}/shares/previews`, {
        requestId: randomUUID(), title: 'Synthetic shop', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
      })).json();
      const token = `rhv_${randomBytes(32).toString('base64url')}`;
      assert.equal((await owner.post(`${place.scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true })).status, 201);
      const visit = (route) => globalThis.fetch(`${app.base}${route}`, { headers: { authorization: `Bearer ${token}` } });
      const manifest = await (await visit('/api/visit')).json();
      assert.deepEqual(manifest.objects, [{ id: 'object-1', label: 'Display counter', box: [2, 4, 14, 26] }, { id: 'object-2', label: 'Flour stack', box: [24, 4, 38, 26] }]);
      assert.deepEqual(manifest.views[0].edit, { objects: place.manifest.edit.objects, relationship: LEFT_OF });
      const surface = await (await visit(`/api/visit/assets/${view.id}/surface.json`)).json();
      assert.deepEqual(Object.keys(surface).sort(), ['assumptions', 'depth', 'height', 'objects', 'regions', 'schema_version', 'source', 'width']);
      assert.deepEqual(surface.source, { image_size: [40, 30] });
      assert.ok(!JSON.stringify(surface).includes(place.draft.photos[0].sourceId));
      assert.ok(!JSON.stringify(surface).includes('sha256'));
    } finally {
      await app.close();
    }
  });

  it('binds a story to the named object and refuses one without a target', async () => {
    const decoder = async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
    const { app, owner } = await workspace({ audioDecoder: decoder });
    try {
      const place = await twoObjectScene(owner);
      const body = {
        requestId: randomUUID(), voiceSourceId: place.draft.voice.sourceId, view: { kind: 'version', version: 1, variantId: null, eraRevision: null },
        title: 'Synthetic tone by the flour', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic test tone; no speech.' }], captionConfirmed: true,
      };
      assert.equal((await owner.post(`${place.scene}/stories`, body)).status, 400);
      assert.equal((await owner.post(`${place.scene}/stories`, { ...body, targetId: 'object-3' })).status, 400);
      const created = await owner.post(`${place.scene}/stories`, { ...body, targetId: 'object-2' });
      assert.equal(created.status, 201);
      assert.deepEqual((await created.json()).target, { id: 'object-2', label: 'Flour stack' });
    } finally {
      await app.close();
    }
  });
});
