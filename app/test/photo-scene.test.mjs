import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
  boxFromPoints,
  boxProblem,
  buildBlockedReason,
  createEditSession,
  createObjectSceneObjects,
  createSceneObjects,
  editProblem,
  facingGuide,
  jobStatusText,
  objectSurfaceMeshes,
  surfaceMeshes,
  surfacePoint,
  validateSurface,
} from '../public/photo-scene.js';

const SOURCE_ID = '3f2b6c1e-8d4a-4b7e-9c2f-1a2b3c4d5e6f';

// A 6x5 grid: background at depth 4 with a 2x2-cell foreground block at depth 3.9.
function syntheticSurface(overrides = {}) {
  const width = 6;
  const height = 5;
  const depth = [];
  const foreground = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const selected = x >= 2 && x <= 4 && y >= 1 && y <= 3;
      foreground.push(selected ? 1 : 0);
      depth.push(selected ? 3.9 : 4);
    }
  }
  return {
    source: { source_id: SOURCE_ID, sha256: 'b'.repeat(64), image_size: [600, 500] },
    width,
    height,
    depth,
    foreground,
    assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
    ...overrides,
  };
}

function record(permissions, kind = 'photo') {
  return { kind, permissions };
}

describe('build permission', () => {
  it('allows building only with both place and model grants', () => {
    assert.equal(buildBlockedReason(record({ place: true, model: true, share: false })), null);
  });

  it('does not let one grant stand in for the other', () => {
    assert.match(buildBlockedReason(record({ place: true, model: false, share: true })), /model processing/);
    assert.doesNotMatch(buildBlockedReason(record({ place: true, model: false, share: true })), /reconstruct this place/);
    assert.match(buildBlockedReason(record({ place: false, model: true, share: true })), /reconstruct this place/);
    assert.doesNotMatch(buildBlockedReason(record({ place: false, model: true, share: true })), /when this memory was saved/, 'a later narrowing is not described as the original choice');
  });

  it('names a truthful next step without suggesting a copy of the restricted photo', () => {
    const reason = buildBlockedReason(record({ place: false, model: false }));
    assert.match(reason, /^Building a scene needs “Use to reconstruct this place” and “Use for model processing”, which are not allowed for this photo\. /);
    assert.match(reason, /The uses of a saved photo cannot be broadened\. To build a scene, choose another photo whose uses already allow both, or add new material with both uses allowed before you save it\.$/);
    assert.doesNotMatch(reason, /upload|copy|again/i);
    assert.doesNotMatch(buildBlockedReason(null), /broadened/, 'the legacy text is unchanged');
    assert.equal(buildBlockedReason(record({ place: true, model: true }, 'text')), 'Only photos can be used to build a scene.');
  });

  it('explains legacy photos without granting anything', () => {
    assert.match(buildBlockedReason(null), /no uses were granted/);
  });

  it('refuses non-photo sources', () => {
    assert.match(buildBlockedReason(record({ place: true, model: true }, 'text')), /Only photos/);
  });
});

describe('box selection', () => {
  it('orders and rounds a drag in any direction', () => {
    assert.deepEqual(boxFromPoints([300.6, 40.2], [10.4, 200.5], 600, 500), [10, 40, 301, 201]);
  });

  it('clamps a drag that leaves the photo', () => {
    assert.deepEqual(boxFromPoints([-20, -5], [700, 900], 600, 500), [0, 0, 600, 500]);
  });

  it('rejects empty, out-of-bounds and non-integer boxes', () => {
    assert.equal(boxProblem([10, 10, 20, 30], 600, 500), null);
    assert.match(boxProblem([10, 10, 10, 30], 600, 500), /width and height/);
    assert.match(boxProblem([10, 10, 601, 30], 600, 500), /inside the photo/);
    assert.match(boxProblem([10.5, 10, 20, 30], 600, 500), /whole pixel/);
    assert.match(boxProblem([10, NaN, 20, 30], 600, 500), /whole pixel/);
    assert.match(boxProblem(null, 600, 500), /whole pixel/);
  });
});

describe('edit limits', () => {
  it('accepts the contract range and rejects values beyond it', () => {
    assert.equal(editProblem({ offset: [2, -2, 0], yaw: Math.PI }), null);
    assert.match(editProblem({ offset: [2.01, 0, 0], yaw: 0 }), /between -2 and 2/);
    assert.match(editProblem({ offset: [0, 0, 0], yaw: -Math.PI - 0.01 }), /180/);
    assert.match(editProblem({ offset: [0, NaN, 0], yaw: 0 }), /number/);
  });
});

describe('surface meshes', () => {
  it('splits the grid at the mask edge so no triangle crosses it', () => {
    const surface = syntheticSurface();
    const { background, foreground } = surfaceMeshes(surface);
    assert.equal(foreground.indices.length / 3, 8);
    assert.ok(background.indices.length > 0);
    const foregroundDepths = new Set();
    for (let i = 2; i < foreground.positions.length; i += 3) foregroundDepths.add(foreground.positions[i]);
    assert.equal(foregroundDepths.size, 1, 'only foreground vertices are in the foreground mesh');
  });

  it('centres the foreground on its own pivot so it turns in place', () => {
    const { foreground } = surfaceMeshes(syntheticSurface());
    const xs = foreground.positions.filter((_, i) => i % 3 === 0);
    assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs)) < 1e-9);
    assert.ok(Math.abs(foreground.pivot[2] + 3.9) < 1e-9);
  });

  it('leaves depth jumps empty instead of stretching across them', () => {
    const surface = syntheticSurface();
    surface.depth = surface.depth.map((value, index) => (surface.foreground[index] ? value : index % 6 < 1 ? 2 : 4));
    const near = surfaceMeshes(surface).background.indices.length;
    const flat = surfaceMeshes(syntheticSurface()).background.indices.length;
    assert.ok(near < flat);
  });

  it('rejects malformed surfaces', () => {
    assert.throws(() => surfaceMeshes(syntheticSurface({ width: 1 })), /dimensions/);
    assert.throws(() => surfaceMeshes({ ...syntheticSurface(), depth: syntheticSurface().depth.map(() => -1) }), /depth/);
    assert.throws(() => surfaceMeshes({ ...syntheticSurface(), foreground: syntheticSurface().foreground.map(() => 2) }), /mask/);
    assert.throws(() => surfaceMeshes({ ...syntheticSurface(), foreground: syntheticSurface().foreground.map(() => 0) }), /selected object/);
  });
});

describe('three.js scene', () => {
  it('builds two source-linked meshes and moves only the foreground', () => {
    const { scene, background, foreground, applyEdit } = createSceneObjects(THREE, syntheticSurface());
    assert.equal(scene.children.length, 2);
    assert.equal(foreground.userData.sourceId, SOURCE_ID);
    assert.equal(background.userData.sourceId, SOURCE_ID);
    const pivot = foreground.position.clone();
    const backgroundBefore = background.geometry.attributes.position.array.slice();

    applyEdit({ offset: [0.5, -0.25, 1], yaw: Math.PI / 2 });

    assert.deepEqual(foreground.position.toArray(), [pivot.x + 0.5, pivot.y - 0.25, pivot.z + 1]);
    assert.equal(foreground.rotation.y, Math.PI / 2);
    assert.deepEqual(background.position.toArray(), [0, 0, 0]);
    assert.deepEqual(background.geometry.attributes.position.array, backgroundBefore);

    applyEdit({ offset: [0, 0, 0], yaw: 0 });
    assert.ok(foreground.position.distanceTo(pivot) < 1e-12);
  });
});

describe('edit session', () => {
  const saved = { version: 1, offset: [0, 0, 0], yaw: 0 };
  const ids = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it('is clean until previewed and returns to saved on revert', () => {
    const session = createEditSession(saved, ids());
    assert.equal(session.isDirty(), false);
    session.setPreview({ offset: [1, 0, 0], yaw: 0 });
    assert.equal(session.isDirty(), true);
    session.revert();
    assert.deepEqual(session.preview, saved);
  });

  it('reuses the request ID when retrying the same unsaved change', () => {
    const session = createEditSession(saved, ids());
    session.setPreview({ offset: [1, 0, 0], yaw: 0.5 });
    const first = session.saveRequest();
    assert.deepEqual(session.saveRequest(), first);
    assert.deepEqual(first, { requestId: 'id-1', baseVersion: 1, offset: [1, 0, 0], yaw: 0.5 });
    session.setPreview({ offset: [1.5, 0, 0], yaw: 0.5 });
    assert.equal(session.saveRequest().requestId, 'id-2');
  });

  it('marks the change saved only after confirmation, then uses a new ID', () => {
    const session = createEditSession(saved, ids());
    session.setPreview({ offset: [1, 0, 0], yaw: 0 });
    session.saveRequest();
    assert.equal(session.saved.version, 1);
    session.confirm({ version: 2, offset: [1, 0, 0], yaw: 0 });
    assert.equal(session.isDirty(), false);
    assert.equal(session.saved.version, 2);
    session.setPreview({ offset: [0, 1, 0], yaw: 0 });
    assert.deepEqual(session.saveRequest(), { requestId: 'id-2', baseVersion: 2, offset: [0, 1, 0], yaw: 0 });
  });

  it('keeps a preview changed during the save as unsaved', () => {
    const session = createEditSession(saved, ids());
    session.setPreview({ offset: [1, 0, 0], yaw: 0 });
    session.saveRequest();
    session.setPreview({ offset: [2, 0, 0], yaw: 0 });
    session.confirm({ version: 2, offset: [1, 0, 0], yaw: 0 });
    assert.equal(session.isDirty(), true);
    assert.deepEqual(session.preview.offset, [2, 0, 0]);
  });

  it('resets the object as a preview and replaces state with a reloaded saved version', () => {
    const session = createEditSession({ version: 3, offset: [1, 1, 1], yaw: 1 }, ids());
    session.resetObject();
    assert.deepEqual(session.preview, { version: 3, offset: [0, 0, 0], yaw: 0 });
    assert.equal(session.saved.version, 3);
    session.replaceSaved({ version: 5, offset: [0.2, 0, 0], yaw: 0 });
    assert.equal(session.isDirty(), false);
    assert.equal(session.saveRequest().baseVersion, 5);
  });
});

describe('job status', () => {
  it('shows the server failure reason and never presents failures as ready', () => {
    assert.match(jobStatusText({ status: 'failed', error: 'The photo environment is not installed.' }), /^Failed\. The photo environment/);
    assert.match(jobStatusText({ status: 'interrupted' }), /Interrupted/);
    assert.equal(jobStatusText({ status: 'ready' }), 'Ready.');
  });
});

describe('visible surfaces only', () => {
  it('draws front faces that face the original camera, leaving reverse sides empty', () => {
    const { background, foreground } = createSceneObjects(THREE, syntheticSurface());
    for (const mesh of [background, foreground]) {
      assert.equal(mesh.material.side, THREE.FrontSide);
      const position = mesh.geometry.attributes.position;
      const index = mesh.geometry.index.array;
      const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(position, index[k]));
      const normal = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
      // The camera sits at the origin looking down -z, so front faces point toward +z.
      assert.ok(normal.z > 0.9);
    }
  });
});

describe('unconfirmed edit save', () => {
  it('stays uncertain through preview changes, revert and reset until confirmed or reloaded', () => {
    let n = 0;
    const session = createEditSession({ version: 1, offset: [0, 0, 0], yaw: 0 }, () => `id-${++n}`);
    session.setPreview({ offset: [1, 0, 0], yaw: 0 });
    const sent = session.saveRequest();
    session.markUncertain();
    session.resetObject();
    session.revert();
    session.setPreview({ offset: [0, 2, 0], yaw: 0 });
    assert.equal(session.uncertain, true);
    session.setPreview({ offset: [1, 0, 0], yaw: 0 });
    assert.equal(session.saveRequest().requestId, sent.requestId);
    session.replaceSaved({ version: 2, offset: [1, 0, 0], yaw: 0 });
    assert.equal(session.uncertain, false);
    session.markUncertain();
    session.confirm({ version: 3, offset: [1, 0, 0], yaw: 0 });
    assert.equal(session.uncertain, false);
  });
});

describe('facing guide', () => {
  it('places a photo point where the surface mesh puts that grid vertex', () => {
    const surface = syntheticSurface();
    const { background } = surfaceMeshes(surface);
    const point = surfacePoint(surface, [0, 0.5]);
    const found = [];
    for (let i = 0; i < background.positions.length; i += 3) {
      if (Math.abs(background.positions[i] - point[0]) < 1e-12 && Math.abs(background.positions[i + 1] - point[1]) < 1e-12) found.push(background.positions[i + 2]);
    }
    assert.deepEqual(found, [point[2]]);
  });

  it('says whether the photographed side points at the target', () => {
    const centre = [0, 0, -3];
    const target = [1, 0.5, -2];
    const yaw = Math.atan2(target[0] - centre[0], target[2] - centre[2]);
    assert.deepEqual(facingGuide(centre, yaw, target), { direction: [Math.sin(yaw), 0, Math.cos(yaw)], level: [1, 0, -2], readable: true, aligned: true });
    assert.equal(facingGuide(centre, yaw + 0.5, target).aligned, false);
  });

  it('compares the turn with the level point of a higher target, the line that is drawn', () => {
    const guide = facingGuide([0, 0, -3], Math.PI / 2, [1, 1, -3]);
    assert.deepEqual(guide.level, [1, 0, -3]);
    assert.equal(guide.aligned, true);
    // The level line from the centre is exactly the arrow's direction.
    const levelDirection = guide.level.map((value, axis) => value - [0, 0, -3][axis]);
    assert.ok(Math.abs(levelDirection[0] - guide.direction[0]) < 1e-12 && levelDirection[1] === 0 && Math.abs(levelDirection[2] - guide.direction[2]) < 1e-12);
  });

  it('reports a target too close to the centre as not readable', () => {
    const guide = facingGuide([0, 0, -3], 0, [0.01, 1, -3.01]);
    assert.equal(guide.readable, false);
    assert.equal(guide.aligned, false);
  });
});

// A 10x6 grid: background at depth 4, object-1 (columns 1-3) at depth 3.5 and
// object-2 (columns 6-8) at depth 3, both on rows 1-4.
function twoObjectSurface({ voidCells = [] } = {}) {
  const width = 10;
  const height = 6;
  const depth = [];
  const regions = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inRows = y >= 1 && y <= 4;
      const region = inRows && x >= 1 && x <= 3 ? 1 : inRows && x >= 6 && x <= 8 ? 2 : 0;
      regions.push(voidCells.includes(y * width + x) ? -1 : region);
      depth.push(region === 1 ? 3.5 : region === 2 ? 3 : 4);
    }
  }
  const objects = [
    { id: 'object-1', label: 'Display counter', box_xyxy: [0, 435, 226, 790] },
    { id: 'object-2', label: 'Flour stack', box_xyxy: [490, 450, 982, 781] },
  ];
  return {
    schema_version: 2,
    source: { source_id: SOURCE_ID, sha256: 'b'.repeat(64), image_size: [1007, 801], selected_objects: structuredClone(objects) },
    width, height, depth, regions, objects,
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
}

const publicSubset = (surface) => ({
  schema_version: 2, width: surface.width, height: surface.height, depth: surface.depth, regions: surface.regions,
  objects: surface.objects.map(({ id, label, box_xyxy }) => ({ id, label, box_xyxy })),
  source: { image_size: surface.source.image_size }, assumptions: surface.assumptions,
});

describe('two-object surfaces', () => {
  it('validates the version 2 schema strictly', () => {
    validateSurface(twoObjectSurface());
    const broken = [
      (surface) => { surface.schema_version = 3; },
      (surface) => { surface.foreground = surface.regions.map(() => 0); },
      (surface) => { surface.objects[1].id = 'object-3'; },
      (surface) => { surface.objects.reverse(); },
      (surface) => { surface.objects.pop(); },
      (surface) => { surface.objects[1].label = 'DISPLAY COUNTER'; },
      (surface) => { surface.objects[0].label = ' padded'; },
      (surface) => { surface.objects[0].label = 'x'.repeat(81); },
      (surface) => { surface.objects[0].box_xyxy = [0, 0, 2000, 10]; },
      (surface) => { surface.objects[0].box_xyxy = [10, 0, 10, 10]; },
      (surface) => { surface.regions[0] = 3; },
      (surface) => { surface.regions[0] = 0.5; },
      (surface) => { surface.regions.pop(); },
      (surface) => { surface.source.selected_objects[0].box_xyxy = [1, 435, 226, 790]; },
      (surface) => { surface.source.selected_objects[1].label = 'Other'; },
    ];
    for (const change of broken) {
      const surface = twoObjectSurface();
      change(surface);
      assert.throws(() => validateSurface(surface), undefined, change.toString());
    }
  });

  it('builds the background and each object from its own region', () => {
    const { background, objects } = objectSurfaceMeshes(twoObjectSurface());
    assert.deepEqual(objects.map(({ id, label }) => [id, label]), [['object-1', 'Display counter'], ['object-2', 'Flour stack']]);
    assert.ok(background.indices.length > 0);
    for (const [object, z] of [[objects[0], -3.5], [objects[1], -3]]) {
      const depths = new Set();
      for (let i = 2; i < object.positions.length; i += 3) depths.add(object.positions[i] + object.pivot[2]);
      assert.deepEqual([...depths], [z]);
      assert.equal(object.indices.length / 3, 2 * 2 * 3);
    }
  });

  it('centres each object exactly on the bounding-box midpoint of its surviving vertices', () => {
    const surface = twoObjectSurface();
    const { objects } = objectSurfaceMeshes(surface);
    const tangent = Math.tan((55 * Math.PI) / 360);
    const vertex = (x, y, d) => [((x / 9) - 0.5) * 2 * tangent * d, ((0.5 - (y / 5)) * 2 * tangent * d * 801) / 1007, -d];
    const expected = (x1, x2, d) => {
      const [a, b] = [vertex(x1, 1, d), vertex(x2, 4, d)];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -d];
    };
    assert.deepEqual(objects[0].pivot, expected(1, 3, 3.5));
    assert.deepEqual(objects[1].pivot, expected(6, 8, 3));
    for (const object of objects) {
      for (let axis = 0; axis < 3; axis += 1) {
        const values = object.positions.filter((_, index) => index % 3 === axis);
        assert.ok(Math.abs(Math.min(...values) + Math.max(...values)) < 1e-12);
      }
    }
  });

  it('draws void overlap cells in no mesh and never counts them as background', () => {
    const plain = objectSurfaceMeshes(twoObjectSurface());
    const voided = objectSurfaceMeshes(twoObjectSurface({ voidCells: [12, 22] }));
    assert.ok(voided.objects[0].indices.length < plain.objects[0].indices.length);
    assert.equal(voided.background.indices.length, plain.background.indices.length);
    assert.equal(voided.objects[1].indices.length, plain.objects[1].indices.length);
    const allVoid = twoObjectSurface();
    allVoid.regions = allVoid.regions.map((value) => (value === 2 ? -1 : value));
    assert.throws(() => objectSurfaceMeshes(allVoid), /Flour stack/);
  });

  it('gives identical meshes and pivots from the public subset without private source records', () => {
    const surface = twoObjectSurface();
    const subset = publicSubset(surface);
    validateSurface(subset);
    assert.deepEqual(objectSurfaceMeshes(subset), objectSurfaceMeshes(surface));
    assert.equal(JSON.stringify(subset).includes(SOURCE_ID), false);
  });

  it('keeps legacy surfaces on their old path and refuses to flatten two objects', () => {
    assert.throws(() => surfaceMeshes(twoObjectSurface()), /two objects/);
    const legacy = syntheticSurface();
    const old = surfaceMeshes(legacy);
    const unified = objectSurfaceMeshes(legacy);
    assert.equal(unified.objects.length, 1);
    assert.deepEqual(unified.objects[0], { id: 'selected-foreground', label: 'Selected foreground object', ...old.foreground });
    assert.deepEqual(unified.background, old.background);
  });

  it('moves only the transformed object and keeps the other and the background unchanged', () => {
    const { scene, background, objects, applyArrangement } = createObjectSceneObjects(THREE, twoObjectSurface());
    assert.equal(scene.children.length, 3);
    const [counter, flour] = objects;
    assert.deepEqual(counter.mesh.userData, { objectId: 'object-1', label: 'Display counter' });
    assert.deepEqual(background.userData, {});
    const backgroundBefore = background.geometry.attributes.position.array.slice();
    const flourBefore = flour.mesh.position.toArray();
    applyArrangement({ objects: [{ id: 'object-1', offset: [0.5, 0, -0.25], yaw: 0.3 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }], relationship: null });
    assert.deepEqual(counter.mesh.position.toArray(), [counter.pivot[0] + 0.5, counter.pivot[1], counter.pivot[2] - 0.25]);
    assert.equal(counter.mesh.rotation.y, 0.3);
    assert.deepEqual(flour.mesh.position.toArray(), flourBefore);
    assert.equal(flour.mesh.rotation.y, 0);
    assert.deepEqual(background.geometry.attributes.position.array, backgroundBefore);
    for (const edit of [{ objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }] }, { objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-3', offset: [0, 0, 0], yaw: 0 }] },
      { objects: [{ id: 'object-1', offset: [3, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }] }, {}]) {
      assert.throws(() => applyArrangement(edit), /transform/);
    }
    assert.equal(counter.mesh.rotation.y, 0.3);
  });
});
