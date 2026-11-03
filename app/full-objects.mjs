import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestError } from './drafts.mjs';
import { verifiedAsset } from './composition-assets.mjs';
import { safeJobDirectory } from './contribution-deletion-files.mjs';
import { assertSceneUsable, currentDependencies } from './collaboration.mjs';
import { validateSurface } from './public/photo-scene.js';

const MAX_GLB = 128 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const MODEL = Object.freeze({ id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' });
const fail = () => { throw new Error('The generated object could not be verified.'); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const same = (actual, expected) => Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPATIAL = fileURLToPath(new URL('./spatial/', import.meta.url));

function noUris(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === 'uri' || key === 'extensions') fail();
    noUris(item);
  }
}

// Only one plain, embedded, triangle mesh is admitted. The renderer never
// sees unverified offsets, nonfinite coordinates, indices or external assets.
export function validateObjectGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > MAX_GLB || bytes.toString('ascii', 0, 4) !== 'glTF'
      || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail();
  let offset = 12;
  const chunks = [];
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail();
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) fail();
    chunks.push({ type, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  if (chunks.length !== 2 || chunks[0].type !== 0x4e4f534a || chunks[1].type !== 0x004e4942) fail();
  let doc;
  try { doc = JSON.parse(chunks[0].bytes.toString('utf8')); } catch { fail(); }
  const emptyOrAbsent = (key) => doc?.[key] === undefined || (Array.isArray(doc[key]) && doc[key].length === 0);
  if (!object(doc) || doc.asset?.version !== '2.0' || !['extensionsUsed', 'extensionsRequired', 'images', 'textures', 'skins', 'animations'].every(emptyOrAbsent)
      || !Array.isArray(doc.buffers) || doc.buffers.length !== 1 || !Array.isArray(doc.meshes) || doc.meshes.length !== 1
      || !Array.isArray(doc.bufferViews) || !Array.isArray(doc.accessors) || !Array.isArray(doc.nodes) || !doc.nodes.every(object)) fail();
  noUris(doc);
  const bin = chunks[1].bytes;
  if (!Number.isInteger(doc.buffers[0]?.byteLength) || doc.buffers[0].byteLength < 1 || doc.buffers[0].byteLength > bin.length
      || bin.length - doc.buffers[0].byteLength > 3) fail();
  const meshes = doc.nodes.filter((node) => node?.mesh !== undefined);
  if (meshes.length !== 1 || meshes[0].mesh !== 0 || doc.nodes.some((node) => node?.skin !== undefined || node?.weights !== undefined
      || node?.matrix !== undefined || node?.translation !== undefined || node?.rotation !== undefined || node?.scale !== undefined)) fail();
  if (!Array.isArray(doc.scenes) || doc.scenes.length !== 1 || (doc.scene !== undefined && doc.scene !== 0)
      || !Array.isArray(doc.scenes[0]?.nodes)) fail();
  const visited = new Set();
  const visit = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= doc.nodes.length || visited.has(index)) fail();
    visited.add(index);
    const children = doc.nodes[index]?.children ?? [];
    if (!Array.isArray(children)) fail();
    for (const child of children) visit(child);
  };
  for (const index of doc.scenes[0].nodes) visit(index);
  if (visited.size !== doc.nodes.length) fail();
  const primitives = doc.meshes[0]?.primitives;
  if (!Array.isArray(primitives) || primitives.length !== 1) fail();
  const primitive = primitives[0];
  if (!object(primitive) || (primitive.mode !== undefined && primitive.mode !== 4) || primitive.targets !== undefined
      || !object(primitive.attributes) || !Number.isInteger(primitive.attributes.POSITION) || !Number.isInteger(primitive.attributes.COLOR_0)
      || Object.keys(primitive.attributes).some((key) => !['POSITION', 'COLOR_0'].includes(key)) || doc.meshes[0].weights !== undefined) fail();
  // Accept the producer's plain material, or the glTF default when absent.
  if (primitive.material === undefined) {
    if (!emptyOrAbsent('materials')) fail();
  } else {
    const material = doc.materials?.[0], pbr = material?.pbrMetallicRoughness;
    if (primitive.material !== 0 || !Array.isArray(doc.materials) || doc.materials.length !== 1
        || !object(material) || Object.keys(material).length !== 1 || !object(pbr)
        || Object.keys(pbr).length !== 2 || pbr.metallicFactor !== 0 || pbr.roughnessFactor !== 1) fail();
  }
  const types = { SCALAR: 1, VEC3: 3, VEC4: 4 };
  const sizes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  function accessor(index, acceptedTypes, components) {
    const a = doc.accessors[index];
    if (!object(a) || a.sparse !== undefined || !acceptedTypes.includes(a.type) || !components.includes(a.componentType)
        || !Number.isSafeInteger(a.count) || a.count < 1 || !Number.isInteger(a.bufferView)) fail();
    const view = doc.bufferViews[a.bufferView], componentSize = sizes[a.componentType], tuple = types[a.type] * componentSize;
    if (!object(view) || view.buffer !== 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0
        || !Number.isSafeInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0
        || !Number.isSafeInteger(a.byteOffset ?? 0) || (a.byteOffset ?? 0) < 0) fail();
    const base = view.byteOffset ?? 0, within = a.byteOffset ?? 0, stride = view.byteStride ?? tuple;
    if (!Number.isSafeInteger(stride) || stride < tuple || stride % componentSize || (base + within) % componentSize
        || base + view.byteLength > doc.buffers[0].byteLength || within + (a.count - 1) * stride + tuple > view.byteLength) fail();
    const read = (row, column) => {
      const at = base + within + row * stride + column * componentSize;
      if (a.componentType === 5126) return bin.readFloatLE(at);
      if (a.componentType === 5125) return bin.readUInt32LE(at);
      if (a.componentType === 5123) return bin.readUInt16LE(at);
      return bin.readUInt8(at);
    };
    return { a, read };
  }
  const positions = accessor(primitive.attributes.POSITION, ['VEC3'], [5126]);
  const colors = accessor(primitive.attributes.COLOR_0, ['VEC3', 'VEC4'], [5121, 5123, 5126]);
  if (positions.a.normalized || colors.a.count !== positions.a.count
      || (colors.a.componentType !== 5126 && colors.a.normalized !== true) || (colors.a.componentType === 5126 && colors.a.normalized)) fail();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.a.count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const n = positions.read(i, axis);
      if (!Number.isFinite(n)) fail();
      min[axis] = Math.min(min[axis], n); max[axis] = Math.max(max[axis], n);
    }
    for (let axis = 0; axis < types[colors.a.type]; axis++) {
      const n = colors.read(i, axis);
      if (!Number.isFinite(n) || (colors.a.componentType === 5126 && (n < 0 || n > 1))) fail();
    }
  }
  if (!vector(positions.a.min, 3) || !vector(positions.a.max, 3)
      || min.some((value, axis) => value !== positions.a.min[axis] || max[axis] !== positions.a.max[axis])) fail();
  let indexAt;
  let indexCount;
  if (primitive.indices === undefined) {
    if (positions.a.count < 3 || positions.a.count % 3) fail();
    indexCount = positions.a.count; indexAt = (i) => i;
  } else {
    if (!Number.isInteger(primitive.indices)) fail();
    const indices = accessor(primitive.indices, ['SCALAR'], [5121, 5123, 5125]);
    if (indices.a.normalized || indices.a.count < 3 || indices.a.count % 3) fail();
    for (let i = 0; i < indices.a.count; i++) if (indices.read(i, 0) >= positions.a.count) fail();
    indexCount = indices.a.count; indexAt = (i) => indices.read(i, 0);
  }
  if (!(max[2] > min[2])) fail();
  let usable = false;
  for (let i = 0; i < indexCount && !usable; i += 3) {
    const [a, b, c] = [indexAt(i), indexAt(i + 1), indexAt(i + 2)];
    const u = [0, 1, 2].map((axis) => positions.read(b, axis) - positions.read(a, axis));
    const v = [0, 1, 2].map((axis) => positions.read(c, axis) - positions.read(a, axis));
    usable = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]].some((value) => value !== 0);
  }
  if (!usable) fail();
  return { sha256: sha256(bytes), bytes: bytes.length, bounds: [min, max] };
}

export function validateMaskReceipt(receipt, { width, height, maskSha256, gridWidth, gridHeight }) {
  const keys = ['width', 'height', 'maskSha256', 'bounds', 'selectedPixels', 'gridWidth', 'gridHeight', 'coveredGridIndices'];
  if (!object(receipt) || Object.keys(receipt).length !== keys.length || !keys.every((key) => Object.hasOwn(receipt, key))
      || !SHA.test(maskSha256) || receipt.maskSha256 !== maskSha256 || receipt.width !== width || receipt.height !== height
      || receipt.gridWidth !== gridWidth || receipt.gridHeight !== gridHeight
      || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 32_000_000
      || !Number.isInteger(gridWidth) || !Number.isInteger(gridHeight) || gridWidth < 2 || gridHeight < 2 || gridWidth * gridHeight > 262_144
      || !Array.isArray(receipt.bounds) || receipt.bounds.length !== 4 || !receipt.bounds.every(Number.isInteger)
      || !Number.isInteger(receipt.selectedPixels) || receipt.selectedPixels < 1 || receipt.selectedPixels >= width * height
      || !Array.isArray(receipt.coveredGridIndices) || receipt.coveredGridIndices.length > gridWidth * gridHeight) fail();
  const [x1, y1, x2, y2] = receipt.bounds;
  if (x1 < 0 || y1 < 0 || x2 > width || y2 > height || x1 >= x2 || y1 >= y2 || receipt.selectedPixels > (x2 - x1) * (y2 - y1)) fail();
  let previous = -1;
  for (const index of receipt.coveredGridIndices) {
    if (!Number.isInteger(index) || index <= previous || index >= gridWidth * gridHeight) fail();
    previous = index;
  }
  return receipt;
}

export function expectedInitialPose(surface, outline, bounds) {
  validateSurface(surface);
  if (surface.schema_version !== undefined || !Array.isArray(outline.coveredGridIndices) || !outline.coveredGridIndices.length) fail();
  const [width, height] = surface.source.image_size;
  const indices = outline.coveredGridIndices;
  const depths = indices.map((index) => surface.depth[index]).sort((a, b) => a - b);
  if (depths.some((n) => !Number.isFinite(n) || n <= 0)) fail();
  const middle = Math.floor(depths.length / 2), d = depths.length % 2 ? depths[middle] : (depths[middle - 1] + depths[middle]) / 2;
  const [x1, y1, x2, y2] = outline.bounds, tangent = Math.tan(surface.assumptions.horizontal_fov_degrees * Math.PI / 360);
  const min = bounds[0], max = bounds[1], height3d = max[2] - min[2];
  if (!vector(min, 3) || !vector(max, 3) || !(height3d > 0)) fail();
  const position = [((x1 + x2) / (2 * width) - 0.5) * 2 * tangent * d, (0.5 - (y1 + y2) / (2 * height)) * 2 * tangent * d * height / width, -d];
  const scale = ((y2 - y1) / height) * 2 * tangent * d * height / width / height3d;
  const modelPivot = min.map((n, index) => (n + max[index]) / 2);
  if (!vector(position, 3) || position.some((n) => Math.abs(n) > 10) || !Number.isFinite(scale) || scale < 0.05 || scale > 5 || !vector(modelPivot, 3)) {
    throw new Error('The estimated placement is outside the supported range.');
  }
  return { position, quaternion: [-0.5, -0.5, -0.5, 0.5], scale, modelPivot };
}

export function validateObjectReceipt(receipt, bytes, input, surface, outline) {
  const keys = ['representation', 'asset', 'sha256', 'bytes', 'initial', 'model', 'input'];
  if (!object(receipt) || Object.keys(receipt).length !== keys.length || !keys.every((key) => Object.hasOwn(receipt, key))
      || receipt.representation !== 'source-photo-full-object-v1' || receipt.asset !== 'object.glb'
      || !object(receipt.model) || Object.keys(receipt.model).length !== 3 || Object.entries(MODEL).some(([key, value]) => receipt.model[key] !== value)
      || !object(receipt.input) || Object.keys(receipt.input).length !== 3 || Object.entries(input).some(([key, value]) => receipt.input[key] !== value)) fail();
  const asset = validateObjectGlb(bytes);
  if (receipt.sha256 !== asset.sha256 || receipt.bytes !== asset.bytes) fail();
  const expected = expectedInitialPose(surface, outline, asset.bounds), pose = receipt.initial;
  if (!object(pose) || Object.keys(pose).length !== 4 || !vector(pose.position, 3) || !vector(pose.quaternion, 4) || !vector(pose.modelPivot, 3)
      || !Number.isFinite(pose.scale) || pose.scale < 0.05 || pose.scale > 5 || pose.position.some((n) => Math.abs(n) > 10)
      || !pose.position.every((n, i) => same(n, expected.position[i]))
      || !pose.quaternion.every((n, i) => n === expected.quaternion[i]) || !same(pose.scale, expected.scale)
      || !pose.modelPivot.every((n, i) => same(n, expected.modelPivot[i]))) fail();
  return { representation: receipt.representation, asset: receipt.asset, sha256: asset.sha256, bytes: asset.bytes, initial: expected, model: { ...MODEL } };
}

const UNAVAILABLE = 'This full object is unavailable or its source has changed.';
const changed = () => new RequestError(409, 'This request was already used with different values.');
const requireId = (value) => { if (typeof value !== 'string' || !UUID.test(value)) throw new RequestError(404, 'Not found.'); };
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const boundedFile = async (file, limit) => {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new RequestError(409, UNAVAILABLE);
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new RequestError(409, UNAVAILABLE);
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
};
const jsonRead = async (file) => {
  try { return JSON.parse((await boundedFile(file, 4 * 1024 * 1024)).toString('utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const cleanupKnownDirectory = async (directory, allowed) => {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const names = await readdir(directory);
    for (const name of names) {
      if (!allowed.has(name) || !(await lstat(path.join(directory, name))).isFile()) return false;
    }
    for (const name of names) await unlink(path.join(directory, name));
    await rmdir(directory);
    return true;
  } catch (error) { return error.code === 'ENOENT'; }
};
const writeAtomic = async (file, value) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(tmp, file); }
  catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
};

export function pythonMaskValidator({ python = process.env.PHOTO_PYTHON || path.join(SPATIAL, '.venv/bin/python'), timeoutMs = 30_000 } = {}) {
  const script = path.join(SPATIAL, 'full_object.py');
  const validator = async ({ maskPath, width, height, gridWidth, gridHeight }) => {
    try { if (!(await lstat(script)).isFile()) throw new Error('missing'); }
    catch { throw new RequestError(503, 'Outline validation is unavailable.'); }
    return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
    const args = [script, '--validate-outline', maskPath, '--width', String(width), '--height', String(height), '--grid-width', String(gridWidth), '--grid-height', String(gridHeight)];
    const child = spawn(python, args, { cwd: SPATIAL, env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = [], length = 0, failure = null;
    const timer = setTimeout(() => { failure = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) { failure = 'oversized'; child.kill('SIGKILL'); }
      else output.push(chunk);
    });
    child.on('error', (error) => { failure = error.code ?? 'unavailable'; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(new RequestError(503, 'Outline validation is unavailable.'));
      if (code === 3) return reject(new RequestError(503, 'Outline validation is unavailable.'));
      if (code !== 0) return reject(new RequestError(400, 'The outline could not be verified.'));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { reject(new RequestError(503, 'Outline validation is unavailable.')); }
    });
    });
  };
  validator.codeHash = async () => {
    try { return sha256(await readFile(script)); } catch { throw new RequestError(503, 'Outline validation is unavailable.'); }
  };
  return validator;
}


export class FullObjectStore {
  constructor({ reconstructions, validateMask = pythonMaskValidator(), runFullObject = null, timeoutMs = 600_000 }) {
    this.reconstructions = reconstructions;
    this.validateMask = validateMask;
    this.runner = runFullObject;
    this.timeoutMs = timeoutMs;
    this.active = null;
  }

  folder(draftId, jobId) { return path.join(this.reconstructions.jobDir(draftId, jobId), 'full-object'); }
  outlineFolder(draftId, jobId, id) { return path.join(this.folder(draftId, jobId), 'outlines', id); }
  buildFolder(draftId, jobId, id) { return path.join(this.folder(draftId, jobId), 'builds', id); }

  async parent(draftId, jobId, sourceId, sourceSha256, parentSurfaceSha256, baseVersion, purpose = 'place', requireCurrent = true) {
    const r = this.reconstructions;
    const manifest = await r.readManifest(draftId, jobId);
    if (!manifest || manifest.status !== 'ready' || manifest.objects || manifest.representation !== undefined
        || manifest.sourceId !== sourceId || manifest.sourceSha256 !== sourceSha256
        || (requireCurrent && manifest.edit?.version !== baseVersion)) throw new RequestError(409, UNAVAILABLE);
    assertSceneUsable(manifest, purpose);
    const original = await r.verifiedOriginal(draftId, sourceId, purpose);
    if (original.source.sha256 !== sourceSha256) throw new RequestError(409, UNAVAILABLE);
    const assets = path.join(r.jobDir(draftId, jobId), 'assets');
    if (!(await safeJobDirectory(assets, r.rootDir))) throw new RequestError(409, UNAVAILABLE);
    const entry = manifest.derivedAssets?.find((item) => item.name === 'surface.json');
    const data = await verifiedAsset(path.join(assets, 'surface.json'), entry, { type: 'application/json; charset=utf-8', maxBytes: 32 * 1024 * 1024 });
    if (sha256(data) !== parentSurfaceSha256) throw new RequestError(409, UNAVAILABLE);
    let surface;
    try { surface = JSON.parse(data.toString('utf8')); validateSurface(surface); } catch { throw new RequestError(409, UNAVAILABLE); }
    if (surface.schema_version !== undefined || surface.source?.source_id !== sourceId || surface.source?.sha256 !== sourceSha256
        || surface.source?.image_size?.[0] !== original.size.width || surface.source?.image_size?.[1] !== original.size.height) throw new RequestError(409, UNAVAILABLE);
    return { manifest, original, surface, surfacePath: path.join(assets, 'surface.json') };
  }

  async withCommit(task) {
    const r = this.reconstructions;
    return r.serialize(() => r.placeDeletions ? r.placeDeletions.commit(task) : task());
  }

  async putOutline(draftId, jobId, id, request, bytes) {
    [draftId, jobId, id, request.sourceId].forEach(requireId);
    if (!SHA.test(request.sourceSha256) || !SHA.test(request.maskSha256) || !SHA.test(request.parentSurfaceSha256)
        || !Number.isInteger(request.width) || !Number.isInteger(request.height) || !Number.isInteger(request.baseVersion) || request.baseVersion < 1
        || request.confirmed !== true || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32 * 1024 * 1024 || sha256(bytes) !== request.maskSha256
        || JSON.stringify(request.crop) !== JSON.stringify([0, 0, request.width, request.height])) throw new RequestError(400, 'The outline could not be read.');
    await this.reconstructions.recover();
    const folder = this.outlineFolder(draftId, jobId, id);
    if (await lstat(folder).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      if (!(await safeJobDirectory(folder, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
    }
    const existing = await jsonRead(path.join(folder, 'outline.json'));
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw changed();
      await this.parent(draftId, jobId, request.sourceId, request.sourceSha256, request.parentSurfaceSha256, request.baseVersion, 'place', false);
      if (sha256(await boundedFile(path.join(folder, 'mask.png'), 32 * 1024 * 1024)) !== request.maskSha256) throw new RequestError(409, UNAVAILABLE);
      return { status: 200, outline: existing.dto };
    }
    const parent = await this.parent(draftId, jobId, request.sourceId, request.sourceSha256, request.parentSurfaceSha256, request.baseVersion);
    if (parent.original.size.width !== request.width || parent.original.size.height !== request.height || request.width * request.height > 32_000_000) throw new RequestError(400, 'The outline dimensions do not match the photo.');
    const base = this.folder(draftId, jobId);
    await this.withCommit(async () => {
      await this.parent(draftId, jobId, request.sourceId, request.sourceSha256, request.parentSurfaceSha256, request.baseVersion);
      await mkdir(base, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      if (!(await safeJobDirectory(base, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
    });
    const staging = path.join(base, `outline-${id}-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const maskPath = path.join(staging, 'mask.png');
      await writeFile(maskPath, bytes, { mode: 0o600, flag: 'wx' });
      const expected = { width: request.width, height: request.height, maskSha256: request.maskSha256, gridWidth: parent.surface.width, gridHeight: parent.surface.height };
      let receipt;
      let validatorCodeSha256 = null;
      try {
        validatorCodeSha256 = this.validateMask.codeHash ? await this.validateMask.codeHash() : null;
        receipt = validateMaskReceipt(await this.validateMask({ maskPath, ...expected }), expected);
        if (this.validateMask.codeHash && validatorCodeSha256 !== await this.validateMask.codeHash()) throw new Error('validator changed');
      }
      catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(400, 'The outline could not be verified.'); }
      const dto = { outlineId: id, sourceId: request.sourceId, sourceSha256: request.sourceSha256, maskSha256: request.maskSha256, width: request.width, height: request.height, bounds: receipt.bounds, confirmed: true, parentSurfaceSha256: request.parentSurfaceSha256, baseVersion: request.baseVersion };
      await writeFile(path.join(staging, 'outline.json'), JSON.stringify({ request, dto, validation: receipt, validatorCodeSha256, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      return await this.withCommit(async () => {
        await this.parent(draftId, jobId, request.sourceId, request.sourceSha256, request.parentSurfaceSha256, request.baseVersion);
        const saved = await jsonRead(path.join(folder, 'outline.json'));
        if (saved) {
          if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw changed();
          if (sha256(await boundedFile(path.join(folder, 'mask.png'), 32 * 1024 * 1024)) !== request.maskSha256) throw new RequestError(409, UNAVAILABLE);
          return { status: 200, outline: saved.dto };
        }
        await mkdir(path.dirname(folder), { recursive: true, mode: 0o700 });
        if (!(await safeJobDirectory(path.dirname(folder), this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
        const existingIds = await readdir(path.dirname(folder));
        if (existingIds.length >= 32) throw new RequestError(409, 'This scene already has the maximum number of confirmed outlines.');
        await rename(staging, folder);
        return { status: 201, outline: dto };
      });
    } finally { await cleanupKnownDirectory(staging, new Set(['mask.png', 'outline.json'])); }
  }

  async outline(draftId, jobId, id) {
    [draftId, jobId, id].forEach(requireId);
    const folder = this.outlineFolder(draftId, jobId, id);
    if (!(await safeJobDirectory(folder, this.reconstructions.rootDir).catch(() => false))) throw new RequestError(404, 'This outline could not be found.');
    const record = await jsonRead(path.join(folder, 'outline.json'));
    if (!record) throw new RequestError(404, 'This outline could not be found.');
    const parent = await this.parent(draftId, jobId, record.request.sourceId, record.request.sourceSha256, record.request.parentSurfaceSha256, record.request.baseVersion, 'place', false);
    const mask = await boundedFile(path.join(folder, 'mask.png'), 32 * 1024 * 1024);
    if (sha256(mask) !== record.request.maskSha256) throw new RequestError(409, UNAVAILABLE);
    try {
      validateMaskReceipt(record.validation, { width: parent.original.size.width, height: parent.original.size.height, maskSha256: record.request.maskSha256, gridWidth: parent.surface.width, gridHeight: parent.surface.height });
      const expected = { outlineId: id, sourceId: record.request.sourceId, sourceSha256: record.request.sourceSha256, maskSha256: record.request.maskSha256,
        width: record.request.width, height: record.request.height, bounds: record.validation.bounds, confirmed: true,
        parentSurfaceSha256: record.request.parentSurfaceSha256, baseVersion: record.request.baseVersion };
      if (JSON.stringify(record.dto) !== JSON.stringify(expected)) throw new Error('mismatch');
    } catch { throw new RequestError(409, UNAVAILABLE); }
    return { record, mask, maskPath: path.join(folder, 'mask.png') };
  }

  async getOutline(draftId, jobId, id) {
    await this.reconstructions.recover();
    return this.withCommit(async () => {
      const { mask } = await this.outline(draftId, jobId, id);
      return { body: mask, type: 'image/png' };
    });
  }

  async recheckOutline(parent, outline, maskPath) {
    const expected = { width: parent.original.size.width, height: parent.original.size.height, maskSha256: outline.request.maskSha256,
      gridWidth: parent.surface.width, gridHeight: parent.surface.height };
    let checked;
    try {
      const before = this.validateMask.codeHash ? await this.validateMask.codeHash() : null;
      if (before !== outline.validatorCodeSha256) throw new Error('validator changed');
      checked = validateMaskReceipt(await this.validateMask({ maskPath, ...expected }), expected);
      if (this.validateMask.codeHash && before !== await this.validateMask.codeHash()) throw new Error('validator changed');
    }
    catch (error) { if (error instanceof RequestError && error.status === 503) throw error; throw new RequestError(409, UNAVAILABLE); }
    if (JSON.stringify(checked) !== JSON.stringify(outline.validation) || sha256(await boundedFile(maskPath, 32 * 1024 * 1024)) !== expected.maskSha256) throw new RequestError(409, UNAVAILABLE);
  }

  async listOutlines(draftId, jobId) {
    [draftId, jobId].forEach(requireId);
    await this.reconstructions.recover();
    return this.withCommit(async () => {
    const manifest = await this.reconstructions.readManifest(draftId, jobId);
    if (!manifest) throw new RequestError(404, 'This scene could not be found.');
    const surface = manifest.derivedAssets?.find((asset) => asset.name === 'surface.json');
    if (!surface?.sha256) throw new RequestError(409, UNAVAILABLE);
    await this.parent(draftId, jobId, manifest.sourceId, manifest.sourceSha256, surface.sha256, manifest.edit?.version);
    const folder = path.join(this.folder(draftId, jobId), 'outlines');
    let ids;
    try { ids = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return { outlines: [] }; throw error; }
    if (ids.length > 32 || !(await safeJobDirectory(folder, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
    const records = [];
    for (const id of ids) {
      requireId(id);
      const { record } = await this.outline(draftId, jobId, id);
      if (typeof record.createdAt !== 'string' || record.dto?.outlineId !== id) throw new RequestError(409, UNAVAILABLE);
      records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.dto.outlineId.localeCompare(b.dto.outlineId));
    return { outlines: records.map((record) => record.dto) };
    });
  }

  buildDto(record) {
    return { id: record.id, status: record.status, sourceId: record.sourceId, sourceSha256: record.sourceSha256,
      outlineId: record.outlineId, outlineSha256: record.outlineSha256, object: record.status === 'ready' ? record.object : null, error: record.error };
  }

  async buildRecord(draftId, jobId, id) {
    [draftId, jobId, id].forEach(requireId);
    const folder = this.buildFolder(draftId, jobId, id);
    if (!(await safeJobDirectory(folder, this.reconstructions.rootDir).catch(() => false))) throw new RequestError(404, 'This object build could not be found.');
    const record = await jsonRead(path.join(folder, 'build.json'));
    if (!record || record.id !== id || !['queued', 'processing', 'ready', 'failed', 'interrupted'].includes(record.status)) throw new RequestError(409, UNAVAILABLE);
    return record;
  }

  async verifiedBuild(draftId, jobId, record) {
    const { record: outline, maskPath } = await this.outline(draftId, jobId, record.outlineId);
    if (outline.request.maskSha256 !== record.outlineSha256 || outline.request.sourceId !== record.sourceId
        || outline.request.sourceSha256 !== record.sourceSha256 || outline.request.parentSurfaceSha256 !== record.parentSurfaceSha256) throw new RequestError(409, UNAVAILABLE);
    if (record.status === 'ready') {
      const file = path.join(this.buildFolder(draftId, jobId, record.id), 'object.glb');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size !== record.object?.bytes || stat.size > MAX_GLB) throw new RequestError(409, UNAVAILABLE);
      const bytes = await boundedFile(file, MAX_GLB);
      if (sha256(bytes) !== record.object.sha256) throw new RequestError(409, UNAVAILABLE);
      const parent = await this.parent(draftId, jobId, record.sourceId, record.sourceSha256, record.parentSurfaceSha256, record.baseVersion, 'place', false);
      const input = { sourceSha256: record.sourceSha256, outlineSha256: record.outlineSha256, parentSurfaceSha256: record.parentSurfaceSha256 };
      await this.recheckOutline(parent, outline, maskPath);
      try { validateObjectReceipt({ ...record.object, input }, bytes, input, parent.surface, outline.validation); }
      catch { throw new RequestError(409, UNAVAILABLE); }
    }
    return record;
  }

  async readBuildLocked(draftId, jobId, id) {
    if (await this.reconstructions.placeDeleted(draftId)) throw new RequestError(404, 'This scene could not be found.');
    const record = await this.buildRecord(draftId, jobId, id);
    const activeHere = () => this.active?.id === id && this.active?.jobId === jobId && this.active?.draftId === draftId;
    if (['queued', 'processing'].includes(record.status) && !activeHere()) {
      record.status = 'interrupted'; record.error = 'The app stopped before this object was built.';
      await writeAtomic(path.join(this.buildFolder(draftId, jobId, id), 'build.json'), record);
    }
    await this.verifiedBuild(draftId, jobId, record);
    return record;
  }

  async getBuild(draftId, jobId, id) {
    await this.reconstructions.recover();
    return this.withCommit(async () => this.buildDto(await this.readBuildLocked(draftId, jobId, id)));
  }

  async listBuilds(draftId, jobId) {
    [draftId, jobId].forEach(requireId);
    await this.reconstructions.recover();
    return this.withCommit(async () => {
    const manifest = await this.reconstructions.readManifest(draftId, jobId);
    if (!manifest) throw new RequestError(404, 'This scene could not be found.');
    const surface = manifest.derivedAssets?.find((asset) => asset.name === 'surface.json');
    if (!surface?.sha256) throw new RequestError(409, UNAVAILABLE);
    await this.parent(draftId, jobId, manifest.sourceId, manifest.sourceSha256, surface.sha256, manifest.edit?.version);
    const folder = path.join(this.folder(draftId, jobId), 'builds');
    let ids;
    try { ids = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return { builds: [] }; throw error; }
    if (ids.length > 16 || !(await safeJobDirectory(folder, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
    const records = [];
    for (const id of ids) {
      requireId(id);
      const record = await this.readBuildLocked(draftId, jobId, id), dto = this.buildDto(record);
      if (typeof record.createdAt !== 'string') throw new RequestError(409, UNAVAILABLE);
      records.push({ dto, createdAt: record.createdAt });
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.dto.id.localeCompare(b.dto.id));
    return { builds: records.map(({ dto }) => dto) };
    });
  }

  async createBuild(draftId, jobId, body) {
    if (!exact(body, ['requestId', 'sourceId', 'sourceSha256', 'outlineId', 'outlineSha256'])) throw new RequestError(400, 'The object request could not be read.');
    const { requestId, sourceId, sourceSha256, outlineId, outlineSha256 } = body;
    [draftId, jobId, requestId, sourceId, outlineId].forEach(requireId);
    if (!SHA.test(sourceSha256) || !SHA.test(outlineSha256)) throw new RequestError(400, 'The object request could not be read.');
    await this.reconstructions.recover();
    const result = await this.withCommit(async () => {
      const folder = this.buildFolder(draftId, jobId, requestId);
      if (await lstat(folder).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
        if (!(await safeJobDirectory(folder, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
      }
      const existing = await jsonRead(path.join(folder, 'build.json'));
      if (existing) {
        if (existing.sourceId !== sourceId || existing.sourceSha256 !== sourceSha256 || existing.outlineId !== outlineId || existing.outlineSha256 !== outlineSha256) throw changed();
        return { status: 200, existing };
      }
      const { record: outline, maskPath } = await this.outline(draftId, jobId, outlineId);
      if (outline.request.sourceId !== sourceId || outline.request.sourceSha256 !== sourceSha256 || outline.request.maskSha256 !== outlineSha256) throw new RequestError(409, UNAVAILABLE);
      const base = this.folder(draftId, jobId), builds = path.join(base, 'builds');
      let info;
      try { info = await lstat(builds); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let ids = [];
      if (info) {
        if (!(await safeJobDirectory(builds, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
        ids = await readdir(builds);
      }
      if (ids.length >= 16) throw new RequestError(409, 'This scene already has the maximum number of object builds.');
      const parent = await this.parent(draftId, jobId, sourceId, sourceSha256, outline.request.parentSurfaceSha256, outline.request.baseVersion, 'model');
      await this.recheckOutline(parent, outline, maskPath);
      if (!outline.validation.coveredGridIndices.length) throw new RequestError(409, 'The outline does not contain usable depth support.');
      if (this.active || this.reconstructions.active || this.reconstructions.runners.size || this.reconstructions.closed) {
        throw new RequestError(409, 'Another scene or object build is running or the app is closing.');
      }
      if (typeof this.runner !== 'function') throw new RequestError(503, 'A supervised full-object runner is not configured.');
      await mkdir(builds, { recursive: true, mode: 0o700 });
      if (!(await safeJobDirectory(builds, this.reconstructions.rootDir))) throw new RequestError(409, UNAVAILABLE);
      await mkdir(folder, { mode: 0o700 });
      const record = { id: requestId, sourceId, sourceSha256, outlineId, outlineSha256, parentSurfaceSha256: outline.request.parentSurfaceSha256,
        baseVersion: outline.request.baseVersion, status: 'queued', object: null, error: null, createdAt: new Date().toISOString() };
      try { await writeFile(path.join(folder, 'build.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' }); }
      catch (error) { await cleanupKnownDirectory(folder, new Set(['build.json'])); throw error; }
      const operation = { id: requestId, draftId, jobId, sourceId, controller: new AbortController(), done: null };
      this.active = operation;
      operation.done = this.runBuild(operation, record, parent, outline, maskPath);
      return { status: 202, record };
    });
    if (result.existing) return { status: 200, build: await this.getBuild(draftId, jobId, requestId) };
    return { status: result.status, build: this.buildDto(result.record) };
  }

  async runBuild(operation, queued, parent, outline, maskPath) {
    const { draftId, jobId, id, controller } = operation;
    const folder = this.buildFolder(draftId, jobId, id), stateFile = path.join(folder, 'build.json'), outputDir = path.join(folder, 'output');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let pending = null;
    try {
      const current = await this.withCommit(async () => {
        if (controller.signal.aborted) throw new Error('aborted');
        await this.parent(draftId, jobId, queued.sourceId, queued.sourceSha256, queued.parentSurfaceSha256, queued.baseVersion, 'model');
        const state = await this.buildRecord(draftId, jobId, id);
        state.status = 'processing'; await writeAtomic(stateFile, state);
        return state;
      });
      await mkdir(outputDir, { mode: 0o700 });
      const launch = await this.withCommit(async () => {
        if (controller.signal.aborted || this.reconstructions.closed) throw new Error('aborted');
        const fresh = await this.parent(draftId, jobId, queued.sourceId, queued.sourceSha256, queued.parentSurfaceSha256, queued.baseVersion, 'model');
        await this.outline(draftId, jobId, queued.outlineId);
        if (controller.signal.aborted) throw new Error('aborted');
        return { running: Promise.resolve(this.runner({ imagePath: fresh.original.imagePath, maskPath, parentSurfacePath: fresh.surfacePath, outputDir, signal: controller.signal })) };
      });
      pending = launch.running;
      const aborted = new Promise((resolve) => {
        if (controller.signal.aborted) resolve(null);
        else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      const result = await Promise.race([pending.catch(() => null), aborted]);
      if (controller.signal.aborted || result?.exitCode !== 0) throw new Error('worker_failed');
      const names = (await readdir(outputDir)).sort();
      if (JSON.stringify(names) !== JSON.stringify(['object.glb', 'object.json'])) throw new Error('invalid_output');
      const glbFile = path.join(outputDir, 'object.glb'), jsonFile = path.join(outputDir, 'object.json');
      const [glbStat, jsonStat] = await Promise.all([lstat(glbFile), lstat(jsonFile)]);
      if (!glbStat.isFile() || glbStat.size < 1 || glbStat.size > MAX_GLB || !jsonStat.isFile() || jsonStat.size > 64 * 1024) throw new Error('invalid_output');
      const bytes = await boundedFile(glbFile, MAX_GLB), receipt = JSON.parse((await boundedFile(jsonFile, 64 * 1024)).toString('utf8'));
      const inputs = { sourceSha256: queued.sourceSha256, outlineSha256: queued.outlineSha256, parentSurfaceSha256: queued.parentSurfaceSha256 };
      const objectDto = validateObjectReceipt(receipt, bytes, inputs, parent.surface, outline.validation);
      await this.withCommit(async () => {
        if (controller.signal.aborted) throw new Error('aborted');
        const fresh = await this.parent(draftId, jobId, queued.sourceId, queued.sourceSha256, queued.parentSurfaceSha256, queued.baseVersion, 'model');
        const freshOutline = await this.outline(draftId, jobId, queued.outlineId);
        await this.recheckOutline(fresh, freshOutline.record, freshOutline.maskPath);
        validateObjectReceipt(receipt, bytes, inputs, fresh.surface, freshOutline.record.validation);
        if (sha256(await boundedFile(glbFile, MAX_GLB)) !== objectDto.sha256) throw new Error('invalid_output');
        await rename(glbFile, path.join(folder, 'object.glb'));
        try {
          if (controller.signal.aborted) throw new Error('aborted');
          await writeAtomic(stateFile, { ...current, status: 'ready', object: objectDto, error: null });
        } catch (error) { await rm(path.join(folder, 'object.glb'), { force: true }); throw error; }
      });
    } catch {
      await this.withCommit(async () => {
        if (await this.reconstructions.placeDeleted(draftId)) return;
        const record = await this.buildRecord(draftId, jobId, id);
        if (record.status === 'ready') return;
        record.status = controller.signal.aborted && !timedOut ? 'interrupted' : 'failed';
        record.error = timedOut ? 'The object build timed out.' : 'The object could not be built or its source is no longer available.';
        await writeAtomic(stateFile, record);
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
      // Keep an uncooperative runner tracked until it can no longer write.
      if (pending) await pending.catch(() => {});
      await cleanupKnownDirectory(outputDir, new Set(['object.glb', 'object.json']));
      if (this.active === operation) this.active = null;
    }
  }

  async getAsset(draftId, jobId, id) {
    await this.reconstructions.recover();
    return this.withCommit(async () => {
      const record = await this.buildRecord(draftId, jobId, id);
      if (record.status !== 'ready') throw new RequestError(409, UNAVAILABLE);
      await this.verifiedBuild(draftId, jobId, record);
      const bytes = await boundedFile(path.join(this.buildFolder(draftId, jobId, id), 'object.glb'), MAX_GLB);
      if (bytes.length !== record.object.bytes || sha256(bytes) !== record.object.sha256) throw new RequestError(409, UNAVAILABLE);
      return { body: bytes, type: 'model/gltf-binary' };
    });
  }

  async validateBinding(draftId, jobId, binding) {
    if (!object(binding) || !UUID.test(binding.buildId ?? '')) throw new RequestError(409, UNAVAILABLE);
    const record = await this.buildRecord(draftId, jobId, binding.buildId);
    if (record.status !== 'ready') throw new RequestError(409, UNAVAILABLE);
    await this.verifiedBuild(draftId, jobId, record);
    const expected = { buildId: record.id, sha256: record.object.sha256, asset: 'object.glb', sourceId: record.sourceId,
      sourceSha256: record.sourceSha256, outlineId: record.outlineId, outlineSha256: record.outlineSha256, initial: record.object.initial };
    if (JSON.stringify(binding) !== JSON.stringify(expected)) throw new RequestError(409, UNAVAILABLE);
    return expected;
  }

  async confirm(draftId, jobId, id, body) {
    [draftId, jobId, id].forEach(requireId);
    if (!exact(body, ['requestId', 'baseVersion']) || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
        || !Number.isInteger(body.baseVersion) || body.baseVersion < 1) throw new RequestError(400, 'The confirmation could not be read.');
    await this.reconstructions.recover();
    return this.withCommit(async () => {
      const r = this.reconstructions, manifest = await r.readManifest(draftId, jobId);
      if (!manifest) throw new RequestError(404, 'This scene could not be found.');
      const previous = manifest.edits.find((entry) => entry.requestId === body.requestId);
      if (previous) {
        if (previous.kind !== 'full-object' || previous.baseVersion !== body.baseVersion || previous.fullObject?.buildId !== id) throw changed();
        await this.validateBinding(draftId, jobId, previous.fullObject);
        return { version: previous.version, offset: previous.offset, yaw: previous.yaw, fullObject: { buildId: id, sha256: previous.fullObject.sha256 } };
      }
      const build = await this.buildRecord(draftId, jobId, id);
      if (build.status !== 'ready' || body.baseVersion !== manifest.edit.version || build.baseVersion !== body.baseVersion) throw new RequestError(409, UNAVAILABLE);
      await this.verifiedBuild(draftId, jobId, build);
      await this.parent(draftId, jobId, build.sourceId, build.sourceSha256, build.parentSurfaceSha256, build.baseVersion);
      const fullObject = { buildId: id, sha256: build.object.sha256, asset: 'object.glb', sourceId: build.sourceId, sourceSha256: build.sourceSha256,
        outlineId: build.outlineId, outlineSha256: build.outlineSha256, initial: build.object.initial };
      const edit = { version: manifest.edit.version + 1, offset: [0, 0, 0], yaw: 0, fullObject };
      await r.saveVersion(manifest, edit, { requestId: body.requestId, kind: 'full-object', baseVersion: body.baseVersion, ...edit, dependencies: currentDependencies(manifest) });
      return { version: edit.version, offset: edit.offset, yaw: edit.yaw, fullObject: { buildId: id, sha256: fullObject.sha256 } };
    });
  }
}
