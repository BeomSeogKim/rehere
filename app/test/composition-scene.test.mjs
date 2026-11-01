import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  COMPOSITION_REPRESENTATION, canonicalPose, compositionFacingGuide, copyArrangement, faceObjectPose,
  poseProblem, quaternionFromEuler, eulerFromQuaternion, rotatePoseYaw,
} from '../public/composition-scene.js';
import { createObjectSceneObjects, objectSurfaceMeshes, validateSurface } from '../public/photo-scene.js';
import { checkVisibleArrangement, orient3d, placer, prepareVisibleGeometry } from '../public/visible-surfaces.js';
import { checkRelationship } from '../public/scene-relations.js';
import { createArrangementSession } from '../public/arrangement.js';
import { arrangementOf, objectPivots, withTarget } from '../arrangements.mjs';

function parent(sourceId, fov = 55, imageSize = [900, 700]) {
  const width = 9, height = 9;
  const foreground = Array.from({ length: 81 }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 1 : 0;
  });
  return {
    width, height, foreground,
    depth: foreground.map((selected, i) => selected ? 3 + 0.008 * (i % width) * Math.floor(i / width) : 5),
    assumptions: { horizontal_fov_degrees: fov, max_triangle_depth_span: 0.35 },
    source: { source_id: sourceId, sha256: sourceId.repeat(64), image_size: imageSize },
  };
}
const pose = (position = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = 1) => ({ position, quaternion, scale });
function composition(context = true) {
  return {
    schema_version: 3, representation: COMPOSITION_REPRESENTATION,
    components: [parent('a'), parent('b', 65, [700, 900])].map((surface, index) => ({
      id: `object-${index + 1}`, label: index ? 'Window B' : 'Counter A', selectedObjectId: 'selected-foreground', texture: `texture-${index + 1}.jpg`, surface,
    })),
    context: context ? { kind: 'photographed-background', componentId: 'object-1', bounds: null, pose: pose([1, 0, -2], quaternionFromEuler([0.1, 0.3, -0.2]), 0.7) } : null,
  };
}
const arrangement = (a = pose([-2, 0, 0]), b = pose([2, 0, 0])) => ({ version: 1, frame: 'owner-composition', objects: [{ id: 'object-1', ...a }, { id: 'object-2', ...b }], relationship: null });
const dispose = (built) => [built.background, ...built.objects.map((item) => item.mesh)].filter(Boolean).forEach((mesh) => { mesh.geometry.dispose(); mesh.material.dispose(); });

describe('composition geometry and exact poses', () => {
  it('keeps each source nonplanar local mesh, FOV, image shape and texture slot', () => {
    const surface = composition(), parts = objectSurfaceMeshes(surface);
    for (const [index, component] of surface.components.entries()) {
      const original = objectSurfaceMeshes(component.surface).objects[0], actual = parts.objects[index];
      assert.deepEqual(actual.positions, original.positions);
      assert.deepEqual(actual.uvs, original.uvs);
      assert.deepEqual(actual.indices, original.indices);
      assert.deepEqual(actual.sourcePivot, original.pivot);
      assert.deepEqual(actual.pivot, [0, 0, 0]);
      assert.equal(actual.texture, component.texture);
      assert.deepEqual(actual.sourceImageSize, component.surface.source.image_size);
      assert.equal(actual.sourceVerticalFovDegrees, objectSurfaceMeshes(component.surface).verticalFovDegrees);
      const point = (i) => actual.positions.slice(i * 3, i * 3 + 3);
      assert.notEqual(orient3d(point(0), point(1), point(2), point(actual.positions.length / 3 - 1)), 0);
    }
    assert.notEqual(parts.objects[0].sourceVerticalFovDegrees, parts.objects[1].sourceVerticalFovDegrees);
  });

  it('bounds only fixed first-photo background and never moves it with an object', () => {
    const source = composition(), before = objectSurfaceMeshes(source);
    const cropped = structuredClone(source);
    cropped.context.bounds = [0, 0, 450, 700];
    const after = objectSurfaceMeshes(cropped);
    assert.deepEqual(after.objects, before.objects);
    assert.ok(after.background.indices.length < before.background.indices.length);
    assert.equal(after.background.texture, 'texture-1.jpg');
    const built = createObjectSceneObjects(THREE, source, { 'texture-1.jpg': new THREE.Texture(), 'texture-2.jpg': new THREE.Texture() });
    const fixed = built.background.matrixWorld.clone();
    built.applyArrangement(arrangement(pose([3, 2, 1], quaternionFromEuler([0.3, 1, 0.2]), 2)));
    assert.deepEqual(built.background.matrixWorld, fixed);
    assert.deepEqual(built.objects[1].mesh.position.toArray(), [2, 0, 0]);
    assert.notEqual(built.objects[0].mesh.material.map, built.objects[1].mesh.material.map);
    dispose(built);
    assert.equal(objectSurfaceMeshes(composition(false)).background, null);
  });

  it('refuses nested components, malformed poses, duplicate labels and empty context bounds', () => {
    const surface = composition();
    validateSurface(surface);
    for (const change of [
      (s) => { s.components[1].surface = composition(false); },
      (s) => { s.components[1].label = s.components[0].label.toUpperCase(); },
      (s) => { s.context.pose.scale = 0; },
      (s) => { s.components[0].selectedObjectId = 'missing'; },
    ]) {
      const invalid = structuredClone(surface); change(invalid); assert.throws(() => validateSurface(invalid));
    }
    surface.context.bounds = [1, 1, 2, 2];
    assert.throws(() => objectSurfaceMeshes(surface), /no usable/);
  });

  it('selects one exact named region from a two-object parent without importing its other object', () => {
    const surface = composition(false), original = surface.components[1].surface;
    const { foreground, ...fields } = original;
    const parentTwo = {
      ...fields, schema_version: 2,
      regions: foreground.map((n, i) => n ? 2 : i % 9 <= 1 && Math.floor(i / 9) <= 1 ? 1 : 0),
      objects: [{ id: 'object-1', label: 'Other source object', box_xyxy: [0, 0, 100, 100] }, { id: 'object-2', label: 'Selected source object', box_xyxy: [100, 100, 650, 850] }],
    };
    surface.components[1].surface = parentTwo;
    surface.components[1].selectedObjectId = 'object-2';
    const result = objectSurfaceMeshes(surface);
    assert.equal(result.objects.length, 2);
    assert.deepEqual(result.objects[1].positions, objectSurfaceMeshes(parentTwo).objects[1].positions);
    assert.equal(result.objects[1].label, 'Window B');
  });

  it('uses renderer-identical Float32 vertices and quaternion/scale world placement', () => {
    const surface = composition(), prepared = prepareVisibleGeometry(THREE, MeshBVH, surface);
    const built = createObjectSceneObjects(THREE, surface, {});
    const edit = arrangement(pose([1, -2, 0.4], quaternionFromEuler([0.2, 1.1, -0.7]), 0.05), pose([-3, 2, 1], quaternionFromEuler([-0.8, 0.7, 0.3]), 5));
    built.applyArrangement(edit);
    built.objects.forEach((object, index) => {
      const part = prepared.parts[index], local = object.mesh.geometry.attributes.position.array;
      assert.deepEqual(part.local, local);
      for (let i = 0; i < local.length; i += 3) {
        const value = [...local.slice(i, i + 3)];
        assert.deepEqual(placer(THREE, part.pivot, edit.objects[index])(value), new THREE.Vector3(...value).applyMatrix4(object.mesh.matrixWorld).toArray());
      }
    });
    dispose(built);
  });

  it('retains conservative BVH overlap checks at both scale limits and rotated poses', () => {
    const surface = composition(false);
    surface.components[1].surface = structuredClone(surface.components[0].surface);
    surface.components[1].surface.source.source_id = 'b';
    const prepared = prepareVisibleGeometry(THREE, MeshBVH, surface);
    for (const scale of [0.05, 0.2, 1, 5]) {
      const rotation = quaternionFromEuler([0.3, 0.7, -0.2]);
      const p = pose([0.1, 0.2, 0.3], rotation, scale);
      assert.notEqual(checkVisibleArrangement(prepared, arrangement(p, p)).status, 'clear');
      assert.equal(checkVisibleArrangement(prepared, arrangement(p, pose([9, 9, 9], rotation, scale))).status, 'clear');
    }
    assert.equal(checkVisibleArrangement(prepared, arrangement(), { maxNodes: 0 }).status, 'unresolved');
  });
});

describe('composition orientation and arrangement state', () => {
  it('canonicalizes only orientation sign and rejects invalid quaternions', () => {
    const input = pose([0.123456789, -2, 3], [0, 0, 0, -1], 0.333333333);
    assert.deepEqual(canonicalPose(input), pose(input.position, [0, 0, 0, 1], input.scale));
    assert.deepEqual(canonicalPose(pose([0, 0, 0], [-1, 0, 0, 0])).quaternion, [1, 0, 0, 0]);
    for (const q of [[0, 0, 0, 0], [0, 0, 0, 2], [0, NaN, 0, 1]]) assert.ok(poseProblem(pose([0, 0, 0], q)));
    assert.throws(() => canonicalPose(pose([0, 0, 0], [0, 0, 0, 1.000001])));
    const q = quaternionFromEuler([0.2, 0.8, -0.1]);
    const roundtrip = quaternionFromEuler(eulerFromQuaternion(q));
    roundtrip.forEach((n, i) => assert.ok(Math.abs(n - q[i]) < 1e-12));
  });

  it('aims the actual calibrated photographed side and preserves relative scale', () => {
    const initial = pose([1, 2, 3], quaternionFromEuler([0.4, 1.2, -0.3]), 1.7), target = [-1, 3, 4];
    const facing = faceObjectPose(initial, target);
    assert.equal(facing.scale, initial.scale);
    assert.deepEqual(facing.position, initial.position);
    assert.equal(compositionFacingGuide(facing, target).aligned, true);
    assert.equal(compositionFacingGuide(rotatePoseYaw(facing, Math.PI / 2), target).aligned, false);
    assert.equal(faceObjectPose(initial, initial.position), null);
    assert.equal(faceObjectPose(initial, [1, 4, 3]), null);
    const edit = arrangement(facing, pose(target));
    edit.relationship = { kind: 'faces', subjectId: 'object-1', targetId: 'object-2', frame: 'owner-composition', frontBasis: 'owner-confirmed-photographed-side' };
    const pivots = objectPivots({ representation: COMPOSITION_REPRESENTATION, objects: edit.objects });
    assert.equal(checkRelationship(edit, pivots).ok, true);
    edit.objects[1].position = [4, 2, 1];
    assert.equal(checkRelationship(edit, pivots).reason, 'facing');
  });

  it('checks left/right in the chosen composition frame rather than a source camera', () => {
    const edit = arrangement(pose([1, 0, 2]), pose([2, 0, 1]));
    edit.relationship = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'owner-composition' };
    const pivots = [{ id: 'object-1', pivot: [0, 0, 0] }, { id: 'object-2', pivot: [0, 0, 0] }];
    assert.equal(checkRelationship(edit, pivots).ok, true);
    edit.objects[1].position[0] = 0;
    assert.equal(checkRelationship(edit, pivots).reason, 'order');
    assert.equal(checkRelationship(edit, pivots, { ...edit.relationship, frame: 'original-photo' }).reason, 'invalid');
  });

  it('retains frame, both full poses and explicit initial settings through sessions', () => {
    const initial = arrangement(pose([-1, 0.2, 1], quaternionFromEuler([0.1, 0.8, 0]), 0.8));
    const saved = { ...copyArrangement(initial), version: 3 };
    saved.objects[0].scale = 1.4;
    let request = 0;
    const session = createArrangementSession(saved, () => `request-${++request}`, initial);
    session.resetObject('object-1');
    assert.deepEqual(session.preview.objects[0], initial.objects[0]);
    const first = session.saveRequest('object-1');
    assert.deepEqual(first.pose, canonicalPose(initial.objects[0]));
    session.markUncertain(); assert.deepEqual(session.saveRequest('object-1'), first);
    const later = pose([0.2, 0.4, 0.6], quaternionFromEuler([0.2, 0.6, 1]), 0.2);
    session.setPreview('object-2', later);
    const next = withTarget(arrangementOf(saved), 'object-1', first.pose);
    session.confirm({ version: 4, ...next });
    assert.deepEqual(session.preview.objects[1], { id: 'object-2', ...later });
    assert.equal(session.preview.frame, 'owner-composition');
    assert.equal(session.saved.version, 4);
    assert.equal(Object.hasOwn(arrangementOf(saved), 'version'), false);
    assert.deepEqual(saved.objects[0].scale, 1.4);
  });
});
