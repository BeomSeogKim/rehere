import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RequestError } from '../drafts.mjs';
import { MAX_OUTPUT_TOKENS, createStoredModel, requestBody, requestDigest } from '../meta-model.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';
import { client, enrolledContributor, jpeg, png, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const INTERSECTS = 'These photographed surfaces overlap. Nothing was changed. Move the object apart before applying.';
const UNRESOLVED = 'Rehere could not finish checking these photographed surfaces. Nothing was changed. Try a different arrangement.';
const UNVERIFIED = 'The photographed surfaces of this scene could not be verified. Nothing was changed.';

// A synthetic 16 x 12 grid at one depth: two equal object sheets, object-1 on
// the left and object-2 on the right, with background between. The sheets are
// coplanar, so moving one onto the other is a positive-area overlap of the
// actual photographed surfaces. No personal media.
const GRID = { width: 16, height: 12 };
function regionsGrid() {
  const regions = [];
  for (let y = 0; y < GRID.height; y++) {
    for (let x = 0; x < GRID.width; x++) {
      const inRows = y >= 2 && y <= 9;
      regions.push(inRows && x >= 1 && x <= 5 ? 1 : inRows && x >= 10 && x <= 14 ? 2 : 0);
    }
  }
  return regions;
}

async function twoObjectRunner({ imagePath, outputDir, sourceId, objects }) {
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
  const summary = { source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture), overlap: { pixels: 0, ratio: 0 } };
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(16, 12), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify(surface), 'summary.json': JSON.stringify(summary),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

const grant = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];
const LEFT_OF = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const JPEG_IMAGE = async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function workspace(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-visible-'));
  tempDirs.push(dataDir);
  const app = await startOwnerServer({ dataDir, reconstructionRunner: twoObjectRunner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function twoObjectScene(owner, dataDir) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant], voice: grant }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: OBJECTS })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  let manifest;
  for (let attempt = 0; attempt < 200; attempt++) {
    manifest = await owner.json(scene);
    if (manifest.status !== 'queued' && manifest.status !== 'processing') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manifest.status, 'ready', manifest.error);
  assert.equal((await owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 200);
  manifest = await owner.json(scene);
  const [left, right] = manifest.objects.map(({ pivot }) => pivot);
  // object-1 moved by `onto` lies exactly on object-2: the sheets are equal in
  // shape and the renderer places each about its own pivot.
  const onto = right.map((value, index) => value - left[index]);
  assert.ok(onto[0] > 0.5 && onto[0] < 2, 'within the frozen offset range');
  const jobDir = path.join(dataDir, 'reconstructions', draft.id, job.id);
  return {
    draft, job, scene, manifest, onto,
    sourcePolicy: `/api/drafts/${draft.id}/sources/${draft.photos[0].sourceId}/policy`,
    manifestFile: path.join(jobDir, 'manifest.json'),
    surfaceFile: path.join(jobDir, 'assets', 'surface.json'),
  };
}

const editBody = (baseVersion, targetId, offset, yaw = 0) => ({ requestId: randomUUID(), baseVersion, targetId, offset, yaw });
const scaled = (vector, factor) => vector.map((value) => value * factor);

async function refused(response, status, message) {
  assert.equal(response.status, status);
  const { error } = await response.json();
  if (message instanceof RegExp) assert.match(error, message);
  else assert.equal(error, message);
  return error;
}

describe('visible named-surface gate on every geometry writer', () => {
  it('holds manual edits and relationship saves that overlap, after the existing stale and rights checks', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await twoObjectScene(owner, dataDir);
      const before = await readFile(place.manifestFile);

      // The existing checks keep their order: a stale base is reported first.
      await refused(await owner.post(`${place.scene}/edit`, editBody(2, 'object-1', place.onto)), 409, /changed elsewhere/);
      for (const offset of [place.onto, scaled(place.onto, 0.8)]) {
        await refused(await owner.post(`${place.scene}/edit`, editBody(1, 'object-1', offset)), 409, INTERSECTS);
      }
      // A turned object-2 crossing object-1 through triangle interiors.
      const crossing = place.onto.map((value, index) => -value + [0.07, 0, 0.03][index]);
      await refused(await owner.post(`${place.scene}/edit`, editBody(1, 'object-2', crossing, 0.4)), 409, INTERSECTS);
      // Turned about its own pivot, its crossing runs along mesh edges: still never saved.
      await refused(await owner.post(`${place.scene}/edit`, editBody(1, 'object-2', scaled(place.onto, -1), 0.4)), 409, /^(These photographed surfaces overlap|Rehere could not finish checking)/);
      assert.deepEqual(await readFile(place.manifestFile), before, 'no write on refusal');

      const clear = editBody(1, 'object-1', [0, 0.2, 0]);
      const saved = await owner.post(`${place.scene}/edit`, clear);
      assert.equal(saved.status, 200);
      const edit = await saved.json();
      assert.equal(edit.version, 2);
      assert.deepEqual(await (await owner.post(`${place.scene}/edit`, clear)).json(), edit, 'exact replay, no new version');
      assert.equal((await owner.post(`${place.scene}/relationship`, { requestId: randomUUID(), baseVersion: 2, relationship: LEFT_OF, confirmed: true })).status, 200);
      assert.equal((await owner.json(place.scene)).edit.version, 3);

      // Rights are checked before geometry: a stopped photo gives its own refusal.
      const { revision } = await owner.json(place.sourcePolicy);
      assert.equal((await owner.post(place.sourcePolicy, { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true })).status, 200);
      const blocked = await owner.post(`${place.scene}/edit`, editBody(3, 'object-1', place.onto));
      assert.ok(blocked.status === 403 || blocked.status === 409);
      assert.notEqual((await blocked.json()).error, INTERSECTS);
    } finally {
      await app.close();
    }
  });

  it('keeps pre-gate overlapping history readable and replayable but never restores it', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await twoObjectScene(owner, dataDir);
      const legacy = editBody(1, 'object-1', [0, 0.2, 0]);
      assert.equal((await owner.post(`${place.scene}/edit`, legacy)).status, 200);
      // A version saved before this gate existed: its stored arrangement overlaps.
      const stored = JSON.parse(await readFile(place.manifestFile, 'utf8'));
      const receipt = stored.edits.at(-1);
      receipt.request.offset = [...place.onto];
      receipt.objects[0].offset = [...place.onto];
      stored.edit.objects[0].offset = [...place.onto];
      await writeFile(place.manifestFile, JSON.stringify(stored, null, 2));
      legacy.offset = [...place.onto];
      const history = await owner.json(`${place.scene}/history`);
      const legacyEntry = JSON.stringify(history.find((item) => item.version === 2));

      // Its exact replay still answers with the saved version, never another one.
      const replay = await owner.post(`${place.scene}/edit`, legacy);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).version, 2);

      // A new version that still overlaps is held; one that separates them is saved.
      const before = await readFile(place.manifestFile);
      await refused(await owner.post(`${place.scene}/edit`, editBody(2, 'object-2', [0, 0.05, 0])), 409, INTERSECTS);
      assert.deepEqual(await readFile(place.manifestFile), before);
      assert.equal((await owner.post(`${place.scene}/edit`, editBody(2, 'object-1', [0, 0, 0]))).status, 200);

      // Restoring the overlapping version is a new candidate and is checked.
      const restoring = await readFile(place.manifestFile);
      await refused(await owner.post(`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 3, targetVersion: 2, ruleChangeConfirmed: false }), 409, INTERSECTS);
      assert.deepEqual(await readFile(place.manifestFile), restoring);
      assert.equal((await owner.post(`${place.scene}/undo`, { requestId: randomUUID(), baseVersion: 3, targetVersion: 1, ruleChangeConfirmed: false })).status, 200);

      const after = await owner.json(`${place.scene}/history`);
      assert.deepEqual(after.map((item) => item.version), [1, 2, 3, 4]);
      assert.equal(JSON.stringify(after.find((item) => item.version === 2)), legacyEntry, 'the old receipt is unchanged');
    } finally {
      await app.close();
    }
  });

  it('never offers an overlapping model plan and never applies a stored ready overlap', async () => {
    const steps = [];
    const proposalModel = async (call) => steps.shift()(call);
    const { app, owner, dataDir } = await workspace({ proposalModel, prepareModelImage: JPEG_IMAGE });
    const planFor = (call, targetId, delta) => ({
      ok: true, model: 'synthetic', responseId: 'r', usage: null,
      plan: { action: 'translate', targetId, sourceId: call.sourceId, baseVersion: call.baseVersion, delta, yawDelta: null, anchor: null, question: null, reason: 'Synthetic plan.' },
    });
    try {
      const place = await twoObjectScene(owner, dataDir);
      const settle = async (id) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const item = await owner.json(`${place.scene}/proposals/${id}`);
          if (!['queued', 'processing'].includes(item.status)) return item;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('proposal did not settle');
      };
      const propose = async () => settle((await (await owner.post(`${place.scene}/proposals`, {
        requestId: randomUUID(), baseVersion: 1, text: 'It stood further right.', consent: true, targetId: 'object-1',
      })).json()).id);

      steps.push((call) => planFor(call, 'object-1', place.onto));
      const overlapping = await propose();
      assert.equal(overlapping.status, 'failed');
      assert.equal(overlapping.error, INTERSECTS);
      assert.ok(!overlapping.result);

      steps.push((call) => planFor(call, 'object-1', [0, 0.2, 0]));
      const ready = await propose();
      assert.equal(ready.status, 'ready');
      // A ready proposal stored before this gate existed whose candidate overlaps.
      const stored = JSON.parse(await readFile(place.manifestFile, 'utf8'));
      stored.proposals.find((item) => item.id === ready.id).result.transform.offset = [...place.onto];
      await writeFile(place.manifestFile, JSON.stringify(stored, null, 2));
      const before = await readFile(place.manifestFile);
      await refused(await owner.post(`${place.scene}/proposals/${ready.id}/apply`, { requestId: randomUUID(), baseVersion: 1, frontConfirmed: false }), 409, INTERSECTS);
      assert.deepEqual(await readFile(place.manifestFile), before, 'the proposal and the saved version are kept');
      assert.equal((await owner.json(`${place.scene}/proposals/${ready.id}`)).status, 'ready');
      assert.equal(steps.length, 0);
    } finally {
      await app.close();
    }
  });

  it('keeps a replayed answer’s recorded identity on the proposal through approval and the saved version', async () => {
    // The stored model is built for the exact request the store sends, so the
    // real replay path, not a stand-in outcome, produces the answer.
    const proposalModel = async (call) => {
      const plan = JSON.stringify({ action: 'translate', targetId: 'object-1', sourceId: call.sourceId, baseVersion: call.baseVersion, delta: [0, 0.2, 0], yawDelta: null, anchor: null, question: null, reason: 'Recorded plan.' });
      const response = { id: 'resp_rec_1', model: 'muse-spark-1.3', status: 'completed', usage: { input_tokens: 900, output_tokens: 100 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: plan }] }] };
      const requestSha256 = requestDigest({ ...requestBody(call), store: false, reasoning: { effort: 'low' }, max_output_tokens: MAX_OUTPUT_TOKENS });
      return createStoredModel({ entries: [{ kind: 'recorded', requestSha256, recordedAt: '2026-11-04T03:00:00.000Z', latencyMs: 2345, response }] })(call);
    };
    const { app, owner, dataDir } = await workspace({ proposalModel, prepareModelImage: JPEG_IMAGE });
    try {
      const place = await twoObjectScene(owner, dataDir);
      let { id } = await (await owner.post(`${place.scene}/proposals`, { requestId: randomUUID(), baseVersion: 1, text: 'It stood a little higher.', consent: true, targetId: 'object-1' })).json();
      let ready;
      for (let attempt = 0; attempt < 200 && !['ready', 'failed', 'clarify'].includes(ready?.status); attempt++) {
        ready = await owner.json(`${place.scene}/proposals/${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(ready.status, 'ready');
      const evidence = { model: 'muse-spark-1.3', responseId: 'resp_rec_1', mode: 'recorded', latencyMs: 2345, recordedAt: '2026-11-04T03:00:00.000Z' };
      for (const [key, value] of Object.entries(evidence)) assert.equal(ready[key], value, key);
      const applied = await owner.post(`${place.scene}/proposals/${id}/apply`, { requestId: randomUUID(), baseVersion: 1, frontConfirmed: false });
      assert.equal(applied.status, 200);
      const after = await owner.json(`${place.scene}/proposals/${id}`);
      assert.equal(after.status, 'applied');
      for (const [key, value] of Object.entries(evidence)) assert.equal(after[key], value, key);
      const stored = JSON.parse(await readFile(place.manifestFile, 'utf8'));
      assert.equal(stored.edits.at(-1).proposalId, id);
    } finally {
      await app.close();
    }
  });

  it('refuses an overlapping contribution both as an adoption and as an immutable alternative', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await twoObjectScene(owner, dataDir);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      await session.post(`${place.scene}/contributions`, { requestId: randomUUID(), text: 'The counter stood by the flour.', permissions: { place: true, model: false, share: true }, periodClaim: '' });
      const [item] = (await owner.json(`${place.scene}/collaboration`)).contributions;
      const review = (decision, offset) => owner.post(`${place.scene}/contributions/${item.id}/review`, {
        requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision, reason: '', conflict: 'unknown', transform: { targetId: 'object-1', offset, yaw: 0 },
      });
      const before = await readFile(place.manifestFile);
      for (const decision of ['adopt', 'alternative']) await refused(await review(decision, place.onto), 409, INTERSECTS);
      assert.deepEqual(await readFile(place.manifestFile), before, 'no variant, review or version is stored');

      const alternative = await review('alternative', [0, 0.2, 0]);
      assert.equal(alternative.status, 200);
      const { variant, edit } = await alternative.json();
      assert.equal(edit, null);
      assert.equal(variant.edit.version, null);
      assert.equal((await owner.json(place.scene)).edit.version, 1);
    } finally {
      await app.close();
    }
  });

  it('holds every writer when the saved surface or its pivots no longer match, without exposing paths', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await twoObjectScene(owner, dataDir);
      // The first check prepares and keeps the surface; later checks still read and hash it.
      assert.equal((await owner.post(`${place.scene}/edit`, editBody(1, 'object-1', [0, 0.1, 0]))).status, 200);
      const original = await readFile(place.surfaceFile);
      const manifestBytes = await readFile(place.manifestFile);
      const sameSize = Buffer.from(original);
      sameSize[sameSize.indexOf('"depth"') + 10] ^= 1;
      const tampers = [
        ['appended', () => writeFile(place.surfaceFile, Buffer.concat([original, Buffer.from(' ')]))],
        ['same size', () => writeFile(place.surfaceFile, sameSize)],
        ['missing', () => unlink(place.surfaceFile)],
        // The same bytes reached through a linked assets folder are not the job's own.
        ['linked folder', async () => {
          const assets = path.dirname(place.surfaceFile);
          await rename(assets, `${assets}-moved`);
          await symlink(`${assets}-moved`, assets);
        }],
        ['pivot', async () => {
          const stored = JSON.parse(manifestBytes.toString('utf8'));
          stored.objects[0].pivot[0] += 1e-6;
          await writeFile(place.manifestFile, JSON.stringify(stored, null, 2));
        }],
      ];
      for (const [name, tamper] of tampers) {
        await tamper();
        const current = await readFile(place.manifestFile);
        // A stale base still comes first.
        await refused(await owner.post(`${place.scene}/edit`, editBody(9, 'object-1', [0, 0.3, 0])), 409, /changed elsewhere/);
        const error = await refused(await owner.post(`${place.scene}/edit`, editBody(2, 'object-1', [0, 0.3, 0])), 409, UNVERIFIED);
        assert.ok(!error.includes(dataDir) && !error.includes('surface.json'), name);
        assert.deepEqual(await readFile(place.manifestFile), current, name);
        if (name === 'linked folder') {
          const assets = path.dirname(place.surfaceFile);
          await unlink(assets);
          await rename(`${assets}-moved`, assets);
        }
        await writeFile(place.surfaceFile, original);
        await writeFile(place.manifestFile, manifestBytes);
      }
      assert.equal((await owner.post(`${place.scene}/edit`, editBody(2, 'object-1', [0, 0.3, 0]))).status, 200, 'restored bytes pass again');
    } finally {
      await app.close();
    }
  });
});

describe('visible-surface work budget and shutdown', () => {
  it('holds as unresolved when the bounded work is exhausted, for every limit', async () => {
    for (const visibleSurfaceLimits of [{ maxNodes: 0, maxPairs: 1_000_000 }, { maxNodes: 4_000_000, maxPairs: 0 }]) {
      const { app, owner, dataDir } = await workspace({ visibleSurfaceLimits });
      try {
        const place = await twoObjectScene(owner, dataDir);
        const before = await readFile(place.manifestFile);
        // An arrangement whose candidates must be examined is held, not judged.
        await refused(await owner.post(`${place.scene}/edit`, editBody(1, 'object-1', scaled(place.onto, 0.8))), 409, UNRESOLVED);
        assert.deepEqual(await readFile(place.manifestFile), before);
      } finally {
        await app.close();
      }
    }
  });

  // close() sets `closed` and aborts outside the mutex. A shutdown that begins
  // while the proposal's candidate is being checked must leave it interrupted,
  // whatever the check then finds. The real check is replaced by a barrier
  // that starts the real close() from inside the paused check.
  for (const outcome of ['clear', 'held']) {
    it(`records a proposal as interrupted when shutdown begins during its ${outcome} surface check`, async () => {
      const original = ReconstructionStore.prototype.assertVisibleArrangement;
      let closing = null;
      const proposalModel = async (call) => ({
        ok: true, model: 'synthetic', responseId: 'r', usage: null,
        plan: { action: 'translate', targetId: 'object-1', sourceId: call.sourceId, baseVersion: call.baseVersion, delta: [0, 0.2, 0], yawDelta: null, anchor: null, question: null, reason: 'Synthetic plan.' },
      });
      const { app, owner, dataDir } = await workspace({ proposalModel, prepareModelImage: JPEG_IMAGE });
      try {
        const place = await twoObjectScene(owner, dataDir);
        let entered;
        const checked = new Promise((resolve) => { entered = resolve; });
        ReconstructionStore.prototype.assertVisibleArrangement = async function paused() {
          closing = this.close();
          entered();
          if (outcome === 'held') throw new RequestError(409, INTERSECTS);
        };
        const proposal = await (await owner.post(`${place.scene}/proposals`, {
          requestId: randomUUID(), baseVersion: 1, text: 'It stood a little higher.', consent: true, targetId: 'object-1',
        })).json();
        // A proposal that settles without reaching the check fails here instead of hanging.
        const settled = async () => {
          for (;;) {
            const item = await owner.json(`${place.scene}/proposals/${proposal.id}`);
            if (!['queued', 'processing'].includes(item.status)) return item;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        };
        await Promise.race([checked, settled().then((item) => assert.fail(`settled as ${item.status} before its surface check`))]);
        await closing;
        const stored = JSON.parse(await readFile(place.manifestFile, 'utf8')).proposals.find((item) => item.id === proposal.id);
        assert.equal(stored.status, 'interrupted');
        assert.ok(!stored.result);
        assert.equal(JSON.parse(await readFile(place.manifestFile, 'utf8')).edit.version, 1);
      } finally {
        ReconstructionStore.prototype.assertVisibleArrangement = original;
        await app.close();
      }
    });
  }
});

describe('private surface-check modules', () => {
  it('serves the shared gate and the pinned library to the owner app only', async () => {
    const { app, owner } = await workspace();
    try {
      const gate = await owner.request('/visible-surfaces.js');
      assert.equal(gate.status, 200);
      assert.equal(await gate.text(), await readFile(new URL('../public/visible-surfaces.js', import.meta.url), 'utf8'));
      const library = await owner.request('/vendor/three-mesh-bvh.js');
      assert.equal(library.status, 200);
      assert.match(library.headers.get('content-type'), /^text\/javascript/);
      const text = await library.text();
      const bundled = await readFile(new URL('../node_modules/three-mesh-bvh/build/index.module.js', import.meta.url), 'utf8');
      assert.equal(bundled.split("from 'three';").length, 2, 'the bundle imports three exactly once');
      assert.equal(text, bundled.replace("from 'three';", "from '/vendor/three.module.js';"));
      const license = await owner.request('/vendor/THREE-MESH-BVH-LICENSE');
      assert.equal(license.status, 200);
      assert.equal(await license.text(), await readFile(new URL('../node_modules/three-mesh-bvh/LICENSE', import.meta.url), 'utf8'));
      for (const target of ['/visible-surfaces.js', '/vendor/three-mesh-bvh.js']) {
        assert.equal((await owner.request(target, { method: 'POST' })).status, 405, target);
      }
    } finally {
      await app.close();
    }
  });
});
