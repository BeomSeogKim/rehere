import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { syntheticGlb } from './full-object-fixtures.js';
import { expectedInitialPose, validateMaskReceipt, validateObjectGlb, validateObjectReceipt } from '../full-objects.mjs';

const digest = (b) => createHash('sha256').update(b).digest('hex');

const mask = { width: 40, height: 30, maskSha256: 'a'.repeat(64), bounds: [4, 3, 20, 25], selectedPixels: 100, gridWidth: 4, gridHeight: 3, coveredGridIndices: [0, 1, 4] };
const surface = { width: 4, height: 3, depth: [2, 3, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4], foreground: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0], source: { image_size: [40, 30] }, assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 } };

it('checks embedded triangles and derives pose from the mask-covered depth median', () => {
  const bytes = syntheticGlb(), asset = validateObjectGlb(bytes);
  assert.deepEqual(asset.bounds, [[0, 0, 0], [1, 1, 1]]);
  assert.equal(asset.sha256, digest(bytes));
  validateMaskReceipt(mask, mask);
  const pose = expectedInitialPose(surface, mask, asset.bounds);
  const t = Math.tan(55 * Math.PI / 360);
  assert.ok(Math.abs(pose.position[2] + 3) < 1e-12);
  assert.ok(Math.abs(pose.position[0] - ((12 / 40) - 0.5) * 2 * t * 3) < 1e-12);
  assert.ok(Math.abs(pose.scale - (22 / 30) * 2 * t * 3 * 30 / 40) < 1e-12);
  const input = { sourceSha256: 'b'.repeat(64), outlineSha256: mask.maskSha256, parentSurfaceSha256: 'c'.repeat(64) };
  const receipt = { representation: 'source-photo-full-object-v1', asset: 'object.glb', sha256: asset.sha256, bytes: bytes.length, initial: pose, model: { id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' }, input };
  assert.equal(validateObjectReceipt(receipt, bytes, input, surface, mask).sha256, digest(bytes));
  assert.throws(() => validateObjectReceipt({ ...receipt, initial: { ...pose, scale: pose.scale * 1.2 } }, bytes, input, surface, mask));
  assert.throws(() => validateObjectReceipt({ ...receipt, initial: { ...pose, quaternion: [0, 0, 0, 1] } }, bytes, input, surface, mask));
});

it('rejects malformed assets and forged mask grid membership receipts', () => {
  const producerMaterial = (doc) => {
    doc.meshes[0].primitives[0].material = 0;
    doc.materials = [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }];
  };
  assert.doesNotThrow(() => validateObjectGlb(syntheticGlb(producerMaterial)));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { doc.meshes[0].primitives[0].material = 999; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { producerMaterial(doc); doc.meshes[0].primitives[0].material = 1; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { producerMaterial(doc); doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { doc.buffers[0].uri = 'https://example.invalid/object'; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { doc.accessors[0].count = 100; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { doc.accessors[0].max = [0, 0, 1]; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc, bytes) => bytes.writeFloatLE(NaN, 0))));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => { doc.extensionsUsed = ['KHR_draco_mesh_compression']; })));
  assert.throws(() => validateObjectGlb(syntheticGlb((doc) => {
    doc.accessors.push({ bufferView: 1, componentType: 5121, count: 3, type: 'SCALAR' });
    doc.meshes[0].primitives[0].indices = 2;
  })));
  assert.throws(() => validateMaskReceipt({ ...mask, coveredGridIndices: [4, 1] }, mask));
  assert.throws(() => validateMaskReceipt({ ...mask, coveredGridIndices: [12] }, mask));
  assert.throws(() => expectedInitialPose(surface, { ...mask, coveredGridIndices: [] }, [[0, 0, 0], [1, 1, 1]]));
});
