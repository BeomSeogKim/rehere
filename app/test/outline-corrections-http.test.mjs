import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pythonOutlineRunner } from '../reconstructions.mjs';
import { visitorSurface } from '../shares.mjs';
import { sha256 } from '../sources.mjs';
import { client, enrolledContributor, startOwnerServer } from './auth-helper.mjs';

const python = process.env.PHOTO_PYTHON;
const fixture = python && spawnSync(python, ['-c', `
from PIL import Image
import base64, io, json
out = {}
for name, size, fmt in [('photo', (64,48), 'PNG'), ('texture', (64,48), 'JPEG'), ('depth', (32,24), 'PNG')]:
 b = io.BytesIO(); Image.new('RGB', size, (100,140,160)).save(b, fmt)
 out[name] = base64.b64encode(b.getvalue()).decode()
print(json.dumps(out))
`], { encoding: 'utf8' });
const images = fixture?.status === 0 ? Object.fromEntries(Object.entries(JSON.parse(fixture.stdout)).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')])) : null;
const temps = [];
after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const granted = { provider: 'Synthetic archive', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const selections = [{ label: 'Counter', box: [4, 6, 24, 42] }, { label: 'Sacks', box: [36, 6, 62, 42] }];

async function workspace({ voids = [], ...options } = {}, existingDir = null) {
  const dataDir = existingDir ?? await mkdtemp(path.join(os.tmpdir(), 'rehere-outline-'));
  if (!existingDir) temps.push(dataDir);
  let modelCalls = 0;
  const reconstructionRunner = async ({ imagePath, outputDir, sourceId, objects }) => {
    modelCalls++;
    const regions = Array.from({ length: 32 * 24 }, (_, i) => {
      const x = i % 32, y = Math.floor(i / 32);
      return y >= 4 && y <= 19 ? x >= 3 && x <= 10 ? 1 : x >= 21 && x <= 28 ? 2 : 0 : 0;
    });
    for (const i of voids) regions[i] = -1;
    const selected = objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box }));
    const surface = {
      schema_version: 2, source: { source_id: sourceId, sha256: sha256(await readFile(imagePath)), format: 'PNG', image_size: [64, 48], texture: { file: 'texture.jpg', sha256: sha256(images.texture), derivation: 'RGB re-encode without metadata' }, selected_objects: selected },
      objects: selected, width: 32, height: 24, depth: regions.map((_, i) => 3 + (i % 32) / 1000), regions,
      assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
    };
    const files = { 'texture.jpg': images.texture, 'depth-preview.png': images.depth, 'mask-overlay.jpg': images.texture, 'mask.png': images.photo,
      'surface.json': JSON.stringify(surface), 'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: surface.source.sha256, texture_sha256: sha256(images.texture), overlap: { pixels: voids.length, ratio: voids.length ? 0.001 : 0 } }) };
    await mkdir(outputDir);
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(outputDir, name), bytes);
    return { exitCode: 0 };
  };
  const app = await startOwnerServer({ dataDir, reconstructionRunner, outlineRunner: pythonOutlineRunner({ python }), ...options });
  return { app, owner: client(app.base, app.cookie), dataDir, modelCalls: () => modelCalls };
}

async function parentScene(ctx) {
  const { owner, dataDir } = ctx;
  const body = new FormData();
  body.append('photos', new Blob([images.photo]), 'photo.png');
  body.append('metadata', JSON.stringify({ photos: [granted] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body })).json();
  const jobs = `/api/drafts/${draft.id}/reconstructions`;
  const initial = await owner.post(jobs, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects: selections });
  assert.equal(initial.status, 202);
  const job = await initial.json();
  const scene = `${jobs}/${job.id}`;
  let manifest;
  for (let attempt = 0; attempt < 200; attempt++) {
    manifest = await owner.json(scene);
    if (manifest.status !== 'queued' && manifest.status !== 'processing') break;
    await delay(5);
  }
  assert.equal(manifest.status, 'ready', manifest.error);
  const dir = path.join(dataDir, 'reconstructions', draft.id, job.id);
  const surface = JSON.parse(await readFile(path.join(dir, 'assets/surface.json'), 'utf8'));
  const request = { requestId: randomUUID(), sourceSurfaceSha256: manifest.derivedAssets.find((a) => a.name === 'surface.json').sha256, targetId: 'object-1', regions: [...surface.regions], confirmed: true };
  for (let y = 5; y <= 18; y++) for (const x of [11, 12]) request.regions[y * 32 + x] = 1;
  return { draft, jobs, scene, dir, manifest, surface, request, endpoint: `${scene}/outline-corrections` };
}

async function tree(dir) {
  const files = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[path.relative(dir, path.join(entry.parentPath, entry.name))] = sha256(await readFile(path.join(entry.parentPath, entry.name)));
  }
  return files;
}

async function restrict(ctx, parent, permissions) {
  const route = `/api/drafts/${parent.draft.id}/sources/${parent.draft.photos[0].sourceId}/policy`;
  const { revision } = await ctx.owner.json(route);
  const result = await ctx.owner.post(route, { requestId: randomUUID(), baseRevision: revision, permissions, stopUse: false });
  assert.equal(result.status, 200);
  return result.json();
}

async function share(owner, scene) {
  const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
  const response = await owner.post(`${scene}/shares/previews`, { requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const preview = await response.json();
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const issued = await owner.post(`${scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true });
  assert.equal(issued.status, 201);
  return { token, view, preview };
}

function heldProducer() {
  const reached = deferred(), resume = deferred();
  let signal;
  return {
    reached, resume, get signal() { return signal; },
    runner: async (call) => {
      signal = call.signal;
      const result = await pythonOutlineRunner({ python })(call);
      reached.resolve();
      // Deliberately ignores abort until released, to exercise late completion.
      await resume.promise;
      return result;
    },
  };
}

describe('deterministic outline corrections', { skip: !images && 'Set PHOTO_PYTHON to an existing Pillow interpreter.' }, () => {
  it('creates an unconfirmed child from an unconfirmed parent, preserving originals, parent, depth, texture and other object', async () => {
    const ctx = await workspace();
    try {
      const p = await parentScene(ctx);
      const before = await tree(p.dir);
      await restrict(ctx, p, { place: true, model: false, share: true });
      const originals = await tree(path.join(ctx.dataDir, 'drafts', p.draft.id));
      const result = await ctx.owner.post(p.endpoint, p.request);
      assert.equal(result.status, 201, JSON.stringify(await result.clone().json()));
      const child = await result.json();
      assert.equal(child.status, 'ready');
      assert.equal(child.objectsConfirmed, false);
      assert.equal(child.modelBlocked, true);
      assert.equal(child.usageBlocked, false);
      assert.deepEqual(child.outline, { kind: 'owner-corrected' });
      assert.equal('outlineCorrection' in child, false);
      assert.deepEqual(child.edit, { version: 1, objects: ['object-1', 'object-2'].map((id) => ({ id, offset: [0, 0, 0], yaw: 0 })), relationship: null });
      assert.deepEqual(child.objects[1], p.manifest.objects[1]);
      assert.ok(child.objects[0].box[2] > p.manifest.objects[0].box[2]);
      assert.equal(child.sourceId, p.manifest.sourceId);
      assert.equal(child.sourceSha256, p.manifest.sourceSha256);
      const dir = path.join(ctx.dataDir, 'reconstructions', p.draft.id, child.id);
      const raw = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
      assert.equal(raw.outlineCorrection.parentJobId, p.manifest.id);
      assert.equal(raw.outlineCorrection.targetId, 'object-1');
      assert.deepEqual(raw.edits, []);
      for (const key of ['collaboration', 'stories', 'shares', 'proposals']) assert.equal(key in raw, false);
      const surface = JSON.parse(await readFile(path.join(dir, 'assets/surface.json'), 'utf8'));
      assert.deepEqual(surface.regions, p.request.regions);
      assert.deepEqual(surface.depth, p.surface.depth);
      assert.deepEqual(surface.assumptions, p.surface.assumptions);
      assert.deepEqual(surface.source.image_size, p.surface.source.image_size);
      for (let i = 0; i < surface.regions.length; i++) if (p.surface.regions[i] === 2) assert.equal(surface.regions[i], 2);
      for (const entry of child.derivedAssets) {
        const bytes = await readFile(path.join(dir, 'assets', entry.name));
        assert.equal(entry.sha256, sha256(bytes)); assert.equal(entry.size, bytes.length);
      }
      for (const name of ['texture.jpg', 'depth-preview.png']) assert.equal(sha256(await readFile(path.join(dir, 'assets', name))), before[`assets/${name}`]);
      assert.deepEqual(await tree(p.dir), before);
      assert.deepEqual(await tree(path.join(ctx.dataDir, 'drafts', p.draft.id)), originals);
      assert.equal(ctx.modelCalls(), 1);
      const replay = await ctx.owner.post(p.endpoint, p.request);
      assert.equal(replay.status, 200); assert.equal((await replay.json()).id, child.id);
      for (const change of [{ targetId: 'object-2' }, { sourceSurfaceSha256: 'a'.repeat(64) }, { regions: p.surface.regions }]) assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, ...change })).status, 409);
      assert.equal((await ctx.owner.post(`${p.jobs}/${child.id}/outline-corrections`, p.request)).status, 409);
      assert.equal((await ctx.owner.post(p.jobs, { requestId: p.request.requestId, sourceId: child.sourceId, objects: child.objects.map(({ label, box }) => ({ label, box })) })).status, 409);
      await ctx.app.close();
      const restarted = await workspace({}, ctx.dataDir);
      try {
        const replayed = await restarted.owner.post(p.endpoint, p.request);
        assert.equal(replayed.status, 200); assert.equal((await replayed.json()).id, child.id);
        assert.equal(restarted.modelCalls(), 0);
      } finally { await restarted.app.close(); }
    } finally { if (ctx.app.server.listening) await ctx.app.close(); }
  });

  it('checks owner identity before body/IDs and enforces the dedicated cap without changing other routes', async () => {
    const ctx = await workspace();
    try {
      const p = await parentScene(ctx);
      const { session } = await enrolledContributor(ctx.owner, ctx.app.base, p.draft.id);
      const invalid = '/api/drafts/bad/reconstructions/bad/outline-corrections';
      for (const endpoint of [p.endpoint, invalid]) {
        assert.equal((await client(ctx.app.base).post(endpoint, '{broken')).status, 401);
        assert.equal((await session.post(endpoint, '{broken')).status, 403);
      }
      assert.equal((await ctx.owner.post(p.endpoint, p.request, { origin: 'http://attacker.example' })).status, 403);
      assert.equal((await ctx.owner.request(p.endpoint)).status, 405);
      for (const change of [{ confirmed: false }, { targetId: 'other' }, { regions: [0] }, { regions: [false, ...p.request.regions.slice(1)] }, { extra: 1 }]) assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, ...change })).status, 400);
      const padded = JSON.stringify(p.request) + ' '.repeat(20_000);
      assert.equal((await ctx.owner.post(p.endpoint, padded)).status, 201);
      assert.equal((await ctx.owner.post(`${p.scene}/edit`, ' '.repeat(20_000))).status, 413);
      assert.equal((await ctx.owner.post(p.endpoint, JSON.stringify(p.request) + ' '.repeat(2 * 1024 * 1024))).status, 413);
    } finally { await ctx.app.close(); }
  });

  it('rejects no-op, other-object mutation, new void, wrong hashes and empty masks without a child', async () => {
    const ctx = await workspace();
    try {
      const p = await parentScene(ctx);
      for (const [change, code] of [
        [{ regions: p.surface.regions }, 400],
        [{ regions: p.request.regions.map((r) => r === 2 ? 0 : r) }, 400],
        [{ regions: p.request.regions.map((r, i) => i === 0 ? -1 : r) }, 400],
        [{ sourceSurfaceSha256: 'a'.repeat(64) }, 409],
        [{ regions: p.surface.regions.map((r) => r === 1 ? 0 : r) }, 409],
      ]) assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, ...change })).status, code);
      assert.equal((await ctx.owner.json(p.jobs)).length, 1);
      await restrict(ctx, p, { place: false, model: false, share: false });
      assert.equal((await ctx.owner.post(p.endpoint, p.request)).status, 403);
    } finally { await ctx.app.close(); }
  });

  it('revalidates changed originals and parent assets before dispatch and publication', async () => {
    for (const late of [false, true]) {
      for (const original of [false, true]) {
        const held = heldProducer();
        let producerCalls = 0;
        const ctx = await workspace({ outlineRunner: (call) => { producerCalls++; return held.runner(call); } });
        try {
          const p = await parentScene(ctx);
          const target = original ? path.join(ctx.dataDir, 'drafts', p.draft.id, p.draft.photos[0].name) : path.join(p.dir, 'assets/texture.jpg');
          let pending;
          if (late) { pending = ctx.owner.post(p.endpoint, p.request); await held.reached.promise; }
          const bytes = await readFile(target);
          await writeFile(target, Buffer.concat([bytes, Buffer.from('changed')]));
          if (!late) pending = ctx.owner.post(p.endpoint, p.request);
          held.resume.resolve();
          const response = await pending;
          assert.equal(response.status, 409);
          assert.equal(producerCalls, late ? 1 : 0);
          assert.equal((await ctx.owner.json(p.jobs)).length, 1);
        } finally { held.resume.resolve(); await ctx.app.close(); }
      }
    }
  });

  it('keeps remaining void or assigns it only to the target, and refuses strict overlap failures', async () => {
    const ctx = await workspace({ voids: [32 + 16, 32 + 17] });
    try {
      const p = await parentScene(ctx);
      const bad = { ...p.request, regions: [...p.request.regions] }; bad.regions[32 + 16] = 0;
      assert.equal((await ctx.owner.post(p.endpoint, bad)).status, 400);
      const held = await ctx.owner.post(p.endpoint, p.request);
      assert.equal(held.status, 409, 'retaining both expanded void cells exceeds the frozen 1% limit');
      const repaired = { ...p.request, regions: [...p.request.regions] }; repaired.regions[32 + 16] = 1;
      const result = await ctx.owner.post(p.endpoint, repaired);
      assert.equal(result.status, 201, JSON.stringify(await result.clone().json()));
      const child = await result.json();
      const surface = await ctx.owner.json(`${p.jobs}/${child.id}/assets/surface.json`);
      assert.equal(surface.regions[32 + 17], -1); assert.equal(surface.regions[32 + 16], 1);
    } finally { await ctx.app.close(); }
  });

  it('shares only bounded correction provenance and leaves existing legacy snapshot bytes unchanged', async () => {
    const ctx = await workspace();
    try {
      const p = await parentScene(ctx);
      await ctx.owner.post(`${p.scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] });
      const legacy = await share(ctx.owner, p.scene);
      const visit = (token, url = '/api/visit') => fetch(`${ctx.app.base}${url}`, { headers: { authorization: `Bearer ${token}` } });
      const legacyBytes = await (await visit(legacy.token)).text();
      const legacySurface = await (await visit(legacy.token, `/api/visit/assets/${legacy.view.id}/surface.json`)).text();
      assert.equal('outline' in JSON.parse(legacyBytes), false);
      const child = await (await ctx.owner.post(p.endpoint, p.request)).json();
      const scene = `${p.jobs}/${child.id}`;
      assert.equal((await ctx.owner.post(`${scene}/shares/previews`, {})).status, 400);
      await ctx.owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] });
      const snapshot = await share(ctx.owner, scene);
      const packet = await (await visit(snapshot.token)).json();
      assert.deepEqual(packet.outline, { kind: 'owner-corrected' });
      assert.equal(packet.views[0].evidence.geometry, 'model estimate');
      const sanitized = await (await visit(snapshot.token, `/api/visit/assets/${snapshot.view.id}/surface.json`)).json();
      assert.deepEqual(sanitized.outline, { kind: 'owner-corrected' });
      for (const value of [packet, sanitized]) {
        const text = JSON.stringify(value);
        for (const secret of [p.manifest.id, p.manifest.sourceId, p.request.sourceSurfaceSha256, 'outlineCorrection', 'requestDigest']) assert.equal(text.includes(secret), false, secret);
      }
      assert.equal(await (await visit(legacy.token)).text(), legacyBytes);
      assert.equal(await (await visit(legacy.token, `/api/visit/assets/${legacy.view.id}/surface.json`)).text(), legacySurface);
      assert.deepEqual(visitorSurface({ ...p.surface, outline: { kind: 'owner-corrected', parentJobId: p.manifest.id } }).outline, { kind: 'owner-corrected' });
    } finally { await ctx.app.close(); }
  });

  it('joins exact concurrent retries and rejects changed in-flight requests', async () => {
    const held = heldProducer();
    const ctx = await workspace({ outlineRunner: held.runner });
    try {
      const p = await parentScene(ctx);
      const first = ctx.owner.post(p.endpoint, p.request);
      await held.reached.promise;
      assert.equal((await ctx.owner.json(p.jobs)).length, 1, 'staging is not a half-ready scene');
      const replay = ctx.owner.post(p.endpoint, p.request);
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, targetId: 'object-2' })).status, 409);
      held.resume.resolve();
      const [a, b] = await Promise.all([first, replay]);
      assert.equal(a.status, 201); assert.equal(b.status, 200);
      assert.equal((await a.json()).id, (await b.json()).id);
      assert.equal((await ctx.owner.json(p.jobs)).length, 2);
    } finally { held.resume.resolve(); await ctx.app.close(); }
  });

  it('honors place revocation against late success, while a model-only reduction leaves deterministic work running', async () => {
    for (const place of [true, false]) {
      const held = heldProducer();
      const ctx = await workspace({ outlineRunner: held.runner });
      try {
        const p = await parentScene(ctx);
        const pending = ctx.owner.post(p.endpoint, p.request);
        await held.reached.promise;
        const policy = await restrict(ctx, p, { place, model: false, share: place });
        assert.equal(policy.impacts.processing, 1);
        assert.equal(held.signal.aborted, !place);
        assert.equal(policy.cancellation.requested, !place);
        held.resume.resolve();
        const result = await pending;
        assert.equal(result.status, place ? 201 : 503);
        assert.equal((await ctx.owner.json(p.jobs)).length, place ? 2 : 1);
        assert.deepEqual(await readdir(path.join(ctx.dataDir, 'reconstruction-staging')), []);
      } finally { held.resume.resolve(); await ctx.app.close(); }
    }
  });

  it('aborts on close or timeout, discards late outputs and permits retry after restart', async () => {
    for (const timeout of [false, true]) {
      const held = heldProducer();
      const ctx = await workspace({ outlineRunner: held.runner, ...(timeout && { outlineTimeoutMs: 100 }) });
      try {
        const p = await parentScene(ctx);
        const pending = ctx.owner.post(p.endpoint, p.request);
        await held.reached.promise;
        let closing;
        if (timeout) await delay(130);
        else closing = ctx.app.close();
        assert.equal(held.signal.aborted, true);
        held.resume.resolve();
        assert.equal((await pending).status, 503);
        if (closing) await closing;
        else await ctx.app.close();
        assert.deepEqual(await readdir(path.join(ctx.dataDir, 'reconstructions', p.draft.id)), [p.manifest.id]);
        assert.deepEqual(await readdir(path.join(ctx.dataDir, 'reconstruction-staging')), []);
        // A crash before publication can also leave uncommitted staging behind.
        const orphan = path.join(ctx.dataDir, 'reconstruction-staging', randomUUID());
        await mkdir(orphan); await writeFile(path.join(orphan, 'request.json'), '{}');
        const reopened = await workspace({}, ctx.dataDir);
        try {
          assert.equal((await reopened.owner.post(p.endpoint, p.request)).status, 201);
          assert.equal(await lstat(orphan).then(() => true, () => false), false);
        } finally { await reopened.app.close(); }
      } finally { held.resume.resolve(); if (ctx.app.server.listening) await ctx.app.close(); }
    }
  });

  it('keeps place deletion pending until its aborted correction producer has settled', async () => {
    const held = heldProducer();
    const ctx = await workspace({ outlineRunner: held.runner });
    try {
      const p = await parentScene(ctx);
      const pending = ctx.owner.post(p.endpoint, p.request);
      await held.reached.promise;
      const review = await ctx.owner.json(`/api/drafts/${p.draft.id}/deletion`);
      assert.equal(review.inventory.processing, 1);
      const body = { requestId: randomUUID(), impactSha256: review.impactSha256, confirmDeletion: true };
      const route = `/api/drafts/${p.draft.id}/delete`;
      assert.equal((await ctx.owner.post(route, body)).status, 202);
      assert.equal(held.signal.aborted, true);
      assert.equal((await ctx.owner.post(route, body)).status, 202);
      assert.deepEqual(await ctx.owner.json(p.jobs), []);
      held.resume.resolve();
      assert.equal((await pending).status, 503);
      assert.equal((await ctx.owner.post(route, body)).status, 200);
      assert.equal(await lstat(path.join(ctx.dataDir, 'reconstructions', p.draft.id)).then(() => true, () => false), false);
      assert.deepEqual(await readdir(path.join(ctx.dataDir, 'reconstruction-staging')), []);
    } finally { held.resume.resolve(); await ctx.app.close(); }
  });

  it('publishes nothing for setup, producer, incomplete-output and atomic storage failures', async () => {
    for (const failure of ['setup', 'producer', 'incomplete', 'storage', 'depth']) {
      const producer = pythonOutlineRunner({ python });
      const ctx = await workspace({ outlineRunner: async (call) => {
        if (failure === 'setup') return { spawnError: 'ENOENT', stderr: 'private path secret' };
        if (failure === 'producer') return { exitCode: 5, stderr: 'private path secret' };
        const result = await producer(call);
        if (failure === 'incomplete') await rm(path.join(call.outputDir, 'mask.png'));
        if (failure === 'depth') {
          const file = path.join(call.outputDir, 'surface.json');
          const surface = JSON.parse(await readFile(file, 'utf8'));
          surface.depth[0] += 0.001;
          await writeFile(file, JSON.stringify(surface));
        }
        return result;
      } });
      const original = fs.promises.rename;
      try {
        const p = await parentScene(ctx);
        const before = await tree(p.dir);
        if (failure === 'storage') {
          fs.promises.rename = async (from, to) => {
            if (String(from).endsWith(`${path.sep}child`)) throw Object.assign(new Error('private path secret'), { code: 'ENOSPC' });
            return original(from, to);
          };
          syncBuiltinESMExports();
        }
        const response = await ctx.owner.post(p.endpoint, p.request);
        assert.equal(response.status, ['incomplete', 'depth'].includes(failure) ? 409 : 503);
        assert.doesNotMatch((await response.json()).error, /secret|private|Traceback|ENOSPC/);
        assert.equal((await ctx.owner.json(p.jobs)).length, 1);
        assert.deepEqual(await tree(p.dir), before);
        assert.deepEqual(await readdir(path.join(ctx.dataDir, 'reconstruction-staging')), []);
      } finally { fs.promises.rename = original; syncBuiltinESMExports(); await ctx.app.close(); }
    }
  });

  it('rejects abort before the final rename but keeps an atomic commit when shutdown starts after rename', async () => {
    for (const committed of [false, true]) {
      const ctx = await workspace();
      const original = fs.promises.rename;
      let closing;
      try {
        const p = await parentScene(ctx);
        fs.promises.rename = async (from, to) => {
          const isBoundary = committed ? String(from).endsWith(`${path.sep}child`) : String(to).includes(`${path.sep}child${path.sep}manifest.json`);
          const result = await original(from, to);
          if (isBoundary) closing = ctx.app.close();
          return result;
        };
        syncBuiltinESMExports();
        const result = await ctx.owner.post(p.endpoint, p.request);
        assert.equal(result.status, committed ? 201 : 503);
        if (closing) await closing;
        const ids = await readdir(path.join(ctx.dataDir, 'reconstructions', p.draft.id));
        assert.equal(ids.length, committed ? 2 : 1);
        if (committed) {
          const reopened = await workspace({}, ctx.dataDir);
          try { assert.equal((await reopened.owner.post(p.endpoint, p.request)).status, 200); }
          finally { await reopened.app.close(); }
        }
      } finally { fs.promises.rename = original; syncBuiltinESMExports(); if (ctx.app.server.listening) await ctx.app.close(); }
    }
  });
});
