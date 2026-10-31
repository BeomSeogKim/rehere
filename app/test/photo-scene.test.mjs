import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
  boxFromPoints,
  boxProblem,
  buildBlockedReason,
  createEditSession,
  createSceneObjects,
  editProblem,
  jobStatusText,
  surfaceMeshes,
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
