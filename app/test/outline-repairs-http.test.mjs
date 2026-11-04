import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pythonOutlineRunner } from '../reconstructions.mjs';
import { exportStaticVisit } from '../export-static-visit.mjs';
import { sha256 } from '../sources.mjs';
import { client, startOwnerServer } from './auth-helper.mjs';

const python = process.env.PHOTO_PYTHON;
const generated = python && spawnSync(python, ['-c', `
from PIL import Image, ImageDraw
import base64, io, json
out = {}
for name, size, fmt in [('photo',(64,48),'PNG'),('texture',(64,48),'JPEG'),('depth',(32,24),'PNG'),('mask',(64,48),'PNG')]:
 image = Image.new('RGB' if name in ('photo','texture') else 'L',size,(100,140,160) if name in ('photo','texture') else 0)
 if name == 'mask': ImageDraw.Draw(image).rectangle((6,8,27,39),fill=255)
 b=io.BytesIO(); image.save(b,fmt); out[name]=base64.b64encode(b.getvalue()).decode()
print(json.dumps(out))
`], { encoding: 'utf8' });
const images = generated?.status === 0 ? Object.fromEntries(Object.entries(JSON.parse(generated.stdout)).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')])) : null;
const temps = [];
after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));
const granted = { provider: 'Synthetic archive', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };

async function workspace(options = {}, existingDir = null) {
  const dataDir = existingDir ?? await mkdtemp(path.join(os.tmpdir(), 'rehere-outline-repair-'));
  if (!existingDir) temps.push(dataDir);
  let modelCalls = 0;
  const reconstructionRunner = async ({ imagePath, outputDir, sourceId, box }) => {
    modelCalls++;
    const foreground = Array.from({ length: 768 }, (_, i) => Number(i % 32 >= 3 && i % 32 <= 10 && Math.floor(i / 32) >= 4 && Math.floor(i / 32) <= 19));
    const surface = { source: { source_id: sourceId, sha256: sha256(await readFile(imagePath)), image_size: [64, 48],
      texture: { file: 'texture.jpg', sha256: sha256(images.texture) }, selected_object: { id: 'foreground', box_xyxy: box } },
      width: 32, height: 24, depth: Array(768).fill(3), foreground,
      assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: .35 } };
    await mkdir(outputDir);
    const files = { 'texture.jpg': images.texture, 'depth-preview.png': images.depth, 'mask.png': images.mask, 'mask-overlay.jpg': images.texture,
      'surface.json': JSON.stringify(surface), 'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: surface.source.sha256, texture_sha256: sha256(images.texture), models: { depth: { id: 'synthetic-depth' } } }) };
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(outputDir, name), bytes);
    return { exitCode: 0 };
  };
  const app = await startOwnerServer({ dataDir, reconstructionRunner, outlineRunner: pythonOutlineRunner({ python }), ...options });
  return { app, owner: client(app.base, app.cookie), dataDir, modelCalls: () => modelCalls };
}
async function parentScene(ctx) {
  const body = new FormData(); body.append('photos', new Blob([images.photo]), 'photo.png'); body.append('metadata', JSON.stringify({ photos: [granted] }));
  const draft = await (await ctx.owner.request('/api/drafts', { method: 'POST', body })).json();
  const source = draft.sources.find((item) => item.id === draft.photos[0].sourceId);
  const jobs = `/api/drafts/${draft.id}/reconstructions`;
  const accepted = await ctx.owner.post(jobs, { requestId: randomUUID(), sourceId: source.id, box: [6, 8, 22, 40] });
  assert.equal(accepted.status, 202);
  const job = await accepted.json(), scene = `${jobs}/${job.id}`;
  let manifest;
  for (let i = 0; i < 200; i++) { manifest = await ctx.owner.json(scene); if (manifest.status === 'ready') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(manifest.status, 'ready', manifest.error);
  const surfaceSha256 = manifest.derivedAssets.find((asset) => asset.name === 'surface.json').sha256;
  const outlineId = randomUUID(), maskSha256 = sha256(images.mask);
  const saved = await ctx.owner.request(`${scene}/full-object/outlines/${outlineId}`, { method: 'PUT', body: images.mask,
    headers: { 'content-type': 'image/png', 'x-source-id': source.id, 'x-source-sha256': source.sha256, 'x-mask-sha256': maskSha256,
      'x-image-width': '64', 'x-image-height': '48', 'x-crop-xyxy': '0,0,64,48', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': surfaceSha256, 'x-base-version': '1' } });
  assert.equal(saved.status, 201, JSON.stringify(await saved.clone().json()));
  return { draft, source, jobs, scene, manifest, dir: path.join(ctx.dataDir, 'reconstructions', draft.id, job.id),
    endpoint: `${scene}/outline-repairs`, request: { requestId: randomUUID(), outlineId, sourceSha256: source.sha256,
      outlineSha256: maskSha256, parentSurfaceSha256: surfaceSha256, baseVersion: 1, confirmed: true } };
}
async function tree(dir) {
  const files = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath, entry.name); files[path.relative(dir, file)] = sha256(await readFile(file));
  }
  return files;
}
async function restrict(ctx, p, permissions) {
  const route = `/api/drafts/${p.draft.id}/sources/${p.source.id}/policy`, current = await ctx.owner.json(route);
  assert.equal((await ctx.owner.post(route, { requestId: randomUUID(), baseRevision: current.revision, permissions, stopUse: false })).status, 200);
}

describe('audited legacy outline repairs', { skip: !images && 'Set PHOTO_PYTHON to an existing Pillow interpreter.' }, () => {
  it('creates one immutable-source child at the initial pose, reopens/replays after restart and exports corrected provenance', async () => {
    const ctx = await workspace();
    try {
      const p = await parentScene(ctx), parentBefore = await tree(p.dir);
      await restrict(ctx, p, { place: true, model: false, share: true });
      const originalBefore = await tree(path.join(ctx.dataDir, 'drafts', p.draft.id));
      const created = await ctx.owner.post(p.endpoint, p.request);
      assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
      const child = await created.json(), scene = `${p.jobs}/${child.id}`;
      assert.deepEqual(child.edit, { version: 1, offset: [0, 0, 0], yaw: 0 });
      assert.deepEqual(child.outline, { kind: 'owner-corrected' });
      assert.equal(child.sourceSha256, p.source.sha256); assert.equal(child.sourceId, p.source.id);
      assert.equal(child.modelBlocked, true); assert.equal('outlineRepair' in child, false);
      const dir = path.join(ctx.dataDir, 'reconstructions', p.draft.id, child.id), raw = JSON.parse(await readFile(path.join(dir, 'manifest.json')));
      assert.equal(raw.outlineRepair.parentJobId, p.manifest.id); assert.equal(raw.outlineRepair.outlineSha256, p.request.outlineSha256);
      assert.deepEqual(raw.edits, []);
      for (const name of ['stories', 'shares', 'proposals', 'collaboration']) assert.equal(name in raw, false);
      const beforeSurface = JSON.parse(await readFile(path.join(p.dir, 'assets/surface.json'))), surface = JSON.parse(await readFile(path.join(dir, 'assets/surface.json')));
      assert.equal('schema_version' in surface, false); assert.deepEqual(surface.depth, beforeSurface.depth);
      assert.deepEqual(surface.assumptions, beforeSurface.assumptions); assert.notDeepEqual(surface.foreground, beforeSurface.foreground);
      assert.deepEqual(await readFile(path.join(dir, 'assets/mask.png')), images.mask);
      for (const name of ['texture.jpg', 'depth-preview.png']) assert.equal(sha256(await readFile(path.join(dir, 'assets', name))), parentBefore[`assets/${name}`]);
      assert.deepEqual(await tree(p.dir), parentBefore); assert.deepEqual(await tree(path.join(ctx.dataDir, 'drafts', p.draft.id)), originalBefore);
      assert.equal(ctx.modelCalls(), 1, 'only the injected parent fixture producer ran');
      const replay = await ctx.owner.post(p.endpoint, p.request); assert.equal(replay.status, 200); assert.equal((await replay.json()).id, child.id);
      assert.equal((await ctx.owner.json(scene)).id, child.id);
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const previewResponse = await ctx.owner.post(`${scene}/shares/previews`, { requestId: randomUUID(), title: 'Synthetic corrected place', views: [view], startViewId: view.id,
        camera: { position: [0, 0, 0], target: [0, 0, -3] }, contributionIds: [], synthetic: true });
      assert.equal(previewResponse.status, 201); const preview = await previewResponse.json(), token = `rhv_${randomBytes(32).toString('base64url')}`;
      assert.equal((await ctx.owner.post(`${scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true })).status, 201);
      const exported = path.join(ctx.dataDir, 'export');
      await exportStaticVisit({ origin: ctx.app.base, token, outDir: exported, confirmPublicMaterial: true });
      const publicManifest = JSON.parse(await readFile(path.join(exported, 'data/manifest.json')));
      assert.deepEqual(publicManifest.outline, { kind: 'owner-corrected' });
      const publicSurface = JSON.parse(await readFile(path.join(exported, 'data/assets', view.id, 'surface.json')));
      assert.deepEqual(publicSurface.foreground, surface.foreground); assert.deepEqual(publicSurface.depth, surface.depth);
      assert.equal(JSON.stringify(publicManifest).includes(p.request.outlineId), false);
      await restrict(ctx, p, { place: true, model: false, share: false });
      assert.equal((await fetch(`${ctx.app.base}/api/visit`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
      await assert.rejects(exportStaticVisit({ origin: ctx.app.base, token, outDir: path.join(ctx.dataDir, 'blocked-export'), confirmPublicMaterial: true }));
      await ctx.app.close(); const restarted = await workspace({}, ctx.dataDir);
      try { const replayed = await restarted.owner.post(p.endpoint, p.request); assert.equal(replayed.status, 200); assert.equal((await replayed.json()).id, child.id); assert.equal(restarted.modelCalls(), 0); }
      finally { await restarted.app.close(); }
    } finally { if (ctx.app.server.listening) await ctx.app.close(); }
  });

  it('refuses stale, unaudited, corrupt and mismatched inputs and does not reuse request IDs for different operations', async () => {
    const ctx = await workspace();
    try {
      const p = await parentScene(ctx), before = await tree(p.dir);
      for (const changed of [{ outlineId: randomUUID() }, { sourceSha256: 'a'.repeat(64) }, { outlineSha256: 'b'.repeat(64) },
        { parentSurfaceSha256: 'c'.repeat(64) }, { baseVersion: 2 }]) {
        const response = await ctx.owner.post(p.endpoint, { ...p.request, ...changed }); assert.ok([404, 409].includes(response.status), JSON.stringify(changed));
      }
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, confirmed: false })).status, 400);
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, extra: true })).status, 400);
      assert.deepEqual(await tree(p.dir), before);
      const maskPath = path.join(p.dir, 'full-object/outlines', p.request.outlineId, 'mask.png');
      await writeFile(maskPath, Buffer.from('corrupt'));
      assert.equal((await ctx.owner.post(p.endpoint, p.request)).status, 409); await writeFile(maskPath, images.mask);
      const created = await ctx.owner.post(p.endpoint, p.request); assert.equal(created.status, 201); const child = await created.json();
      const reordered = Object.fromEntries(Object.entries(p.request).reverse());
      assert.equal((await ctx.owner.post(p.endpoint, reordered)).status, 200, 'JSON field order does not change request identity');
      const childMask = path.join(ctx.dataDir, 'reconstructions', p.draft.id, child.id, 'assets/mask.png');
      await writeFile(childMask, Buffer.from('corrupt'));
      assert.equal((await ctx.owner.post(p.endpoint, p.request)).status, 409); await writeFile(childMask, images.mask);
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, baseVersion: 2 })).status, 409);
      assert.equal((await ctx.owner.post(p.jobs, { requestId: p.request.requestId, sourceId: p.source.id, box: child.box })).status, 409);
      assert.equal((await ctx.owner.post(`${p.scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [.1, 0, 0], yaw: 0 })).status, 200);
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, requestId: randomUUID() })).status, 409);
      const replay = await ctx.owner.post(p.endpoint, p.request); assert.equal(replay.status, 200); assert.equal((await replay.json()).id, child.id);
      await restrict(ctx, p, { place: false, model: false, share: false });
      assert.ok([403, 409].includes((await ctx.owner.post(p.endpoint, p.request)).status));
      assert.ok([403, 409].includes((await ctx.owner.post(p.endpoint, { ...p.request, requestId: randomUUID() })).status));
    } finally { await ctx.app.close(); }
  });

  it('publishes nothing after producer failure or a late success following place revocation', async () => {
    let fail = true, release, reached;
    const ready = new Promise((resolve) => { reached = resolve; }), gate = new Promise((resolve) => { release = resolve; });
    const actual = pythonOutlineRunner({ python });
    const ctx = await workspace({ outlineRunner: async (call) => { if (fail) return { exitCode: 4 }; const result = await actual(call); reached(); await gate; return result; } });
    try {
      const p = await parentScene(ctx), before = await tree(p.dir);
      assert.equal((await ctx.owner.post(p.endpoint, p.request)).status, 409);
      assert.equal((await readdir(path.dirname(p.dir))).length, 1);
      fail = false; const pending = ctx.owner.post(p.endpoint, p.request); await ready;
      await restrict(ctx, p, { place: false, model: false, share: false }); release();
      assert.notEqual((await pending).status, 201); assert.equal((await readdir(path.dirname(p.dir))).length, 1);
      assert.deepEqual(await tree(p.dir), before);
    } finally { release?.(); await ctx.app.close(); }
  });

  it('joins identical concurrent requests and rejects changed requests while producing only one child', async () => {
    let release, reached;
    const ready = new Promise((resolve) => { reached = resolve; }), gate = new Promise((resolve) => { release = resolve; });
    const actual = pythonOutlineRunner({ python });
    const ctx = await workspace({ outlineRunner: async (call) => { const result = await actual(call); reached(); await gate; return result; } });
    try {
      const p = await parentScene(ctx), first = ctx.owner.post(p.endpoint, p.request); await ready;
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, baseVersion: 2 })).status, 409);
      assert.equal((await ctx.owner.post(p.endpoint, { ...p.request, requestId: randomUUID() })).status, 409);
      const second = ctx.owner.post(p.endpoint, p.request); release();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
      const children = await Promise.all(responses.map((r) => r.json())); assert.equal(children[0].id, children[1].id);
      assert.equal((await readdir(path.dirname(p.dir))).length, 2);
    } finally { release?.(); await ctx.app.close(); }
  });

  it('checks owner authority and confirmed audit and refuses a parent changed during production', async () => {
    let release, reached;
    const ready = new Promise((resolve) => { reached = resolve; }), gate = new Promise((resolve) => { release = resolve; });
    const actual = pythonOutlineRunner({ python });
    const ctx = await workspace({ outlineRunner: async (call) => { const result = await actual(call); reached(); await gate; return result; } });
    try {
      const p = await parentScene(ctx);
      assert.equal((await fetch(`${ctx.app.base}${p.endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await ctx.owner.request(p.endpoint)).status, 405);
      const auditPath = path.join(p.dir, 'full-object/outlines', p.request.outlineId, 'outline.json'), auditBytes = await readFile(auditPath);
      const audit = JSON.parse(auditBytes); audit.request.confirmed = false; await writeFile(auditPath, JSON.stringify(audit));
      assert.equal((await ctx.owner.post(p.endpoint, p.request)).status, 409); await writeFile(auditPath, auditBytes);
      const pending = ctx.owner.post(p.endpoint, p.request); await ready;
      const file = path.join(p.dir, 'assets/texture.jpg'), saved = await readFile(file); await writeFile(file, Buffer.from('changed'));
      release(); assert.equal((await pending).status, 409); await writeFile(file, saved);
      assert.equal((await readdir(path.dirname(p.dir))).length, 1);
    } finally { release?.(); await ctx.app.close(); }
  });
});
