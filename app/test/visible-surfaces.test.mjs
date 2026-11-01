import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { createObjectSceneObjects, objectSurfaceMeshes } from '../public/photo-scene.js';
import {
  DEFAULT_LIMITS, checkVisibleArrangement, orient2d, orient3d, placer, prepareVisibleGeometry, visibleSurfaceProblem,
} from '../public/visible-surfaces.js';

// Synthetic depth grids. Each vertex gets a region (-1 void, 0 background,
// 1 object-1, 2 object-2) and a depth; the real mesh builder keeps only
// triangles whose corners share a region within the depth span.
function surface({ width = 21, height = 21, region, depth }) {
  const regions = [];
  const depths = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      regions.push(region(column, row));
      depths.push(depth(column, row));
    }
  }
  const objects = [
    { id: 'object-1', label: 'Chair', box_xyxy: [0, 0, 10, 10] },
    { id: 'object-2', label: 'Counter', box_xyxy: [10, 10, 20, 20] },
  ];
  return {
    schema_version: 2,
    source: { source_id: 'synthetic', sha256: 'a'.repeat(64), image_size: [1000, 1000] },
    width, height, depth: depths, regions, objects,
    assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  };
}

const inside = (value, low, high) => value >= low && value <= high;

// object-1: a frontal sheet at depth 2 (columns 2-8); object-2: a frontal
// sheet at depth 3 (columns 12-18). Rows 5-15 for both.
const frontal = surface({
  region: (c, r) => (inside(r, 5, 15) && inside(c, 2, 8) ? 1 : inside(r, 5, 15) && inside(c, 12, 18) ? 2 : 0),
  depth: (c, r) => (inside(r, 5, 15) && inside(c, 2, 8) ? 2 : inside(r, 5, 15) && inside(c, 12, 18) ? 3 : 6),
});

const meshes = (s) => objectSurfaceMeshes(s).objects;
const prepare = (s) => prepareVisibleGeometry(THREE, MeshBVH, s);
const still = { offset: [0, 0, 0], yaw: 0 };
const arrange = (second, first = still) => ({ objects: [{ id: 'object-1', ...first }, { id: 'object-2', ...second }] });
// Positions as the renderer stores them: prepared parts hold the Float32
// local vertices, which differ from the builder's doubles by up to 1e-8.
const world = (part, index) => [0, 1, 2].map((axis) => part.local[index * 3 + axis] + part.pivot[axis]);
const columnX = (part, pick) => part.pivot[0] + (pick === 'max' ? part.bounds[3] : part.bounds[0]);

// object-2 turned a quarter so its sheet becomes the plane x = constant,
// crossing object-1's plane (z = -2). `dz` keeps object-2's own grid columns
// away from that plane, so only object-1's seams are under test.
function quarterTurnAt(x, dz = 0.0123) {
  const [, second] = meshes(frontal);
  return { offset: [x - second.pivot[0], 0, -2 + dz - second.pivot[2]], yaw: Math.PI / 2 };
}

describe('visible surface geometry', () => {
  const prepared = prepare(frontal);
  const [first, second] = prepared.parts;

  it('checks the renderer\'s own Float32 vertices, triangles and pivots', () => {
    const { objects } = createObjectSceneObjects(THREE, frontal);
    for (const [index, object] of objects.entries()) {
      const part = prepared.parts[index];
      assert.equal(part.id, object.id);
      assert.deepEqual(part.pivot, object.pivot);
      assert.ok(part.local instanceof Float32Array);
      assert.deepEqual(part.local, object.mesh.geometry.attributes.position.array);
      assert.deepEqual([...part.index], [...object.mesh.geometry.index.array]);
    }
  });

  it('places vertices exactly where the renderer\'s matrixWorld puts them', () => {
    const { scene, objects, applyArrangement } = createObjectSceneObjects(THREE, frontal);
    const arrangement = arrange({ offset: [-0.4, 0.25, 0.8], yaw: 2.1 }, { offset: [0.3, -0.2, 0.1], yaw: -0.7 });
    applyArrangement(arrangement);
    scene.updateMatrixWorld(true);
    for (const [index, object] of objects.entries()) {
      const part = prepared.parts[index];
      const positions = object.mesh.geometry.attributes.position.array;
      for (let i = 0; i < positions.length; i += 3) {
        const local = [positions[i], positions[i + 1], positions[i + 2]];
        const expected = new THREE.Vector3(...local).applyMatrix4(object.mesh.matrixWorld).toArray();
        assert.deepEqual(placer(THREE, part.pivot, arrangement.objects[index])(local), expected);
      }
    }
    // A zero pivot places by the transform alone, as a bare Object3D does.
    const bare = new THREE.Object3D();
    bare.position.set(0.5, -1, 1.5);
    bare.rotation.set(0, -2.9, 0);
    new THREE.Scene().add(bare);
    bare.parent.updateMatrixWorld(true);
    const expected = new THREE.Vector3(0.25, 0.75, -0.5).applyMatrix4(bare.matrixWorld).toArray();
    assert.deepEqual(placer(THREE, [0, 0, 0], { offset: [0.5, -1, 1.5], yaw: -2.9 })([0.25, 0.75, -0.5]), expected);
  });

  it('is clear for the photographed arrangement and for separated surfaces', () => {
    assert.deepEqual(checkVisibleArrangement(prepared, arrange(still)), { status: 'clear', reason: 'separated', scope: 'named-visible-surfaces' });
    // Parallel sheets 0.1 apart in depth, overlapping in the picture.
    const parallel = { offset: [first.pivot[0] - second.pivot[0], 0, 0.9], yaw: 0 };
    assert.equal(checkVisibleArrangement(prepared, arrange(parallel)).status, 'clear');
  });

  it('finds a sheet crossing through the other surface', () => {
    const result = checkVisibleArrangement(prepared, arrange(quarterTurnAt(first.pivot[0] + 0.0371)));
    assert.deepEqual(result, { status: 'intersects', reason: 'overlap', scope: 'named-visible-surfaces' });
    assert.equal(visibleSurfaceProblem(result), 'These photographed surfaces overlap. Nothing was changed. Move the object apart before applying.');
  });

  it('never calls a crossing exactly along internal grid edges and vertices clear', () => {
    // Column 5 is an interior column of object-1: every touching triangle of
    // object-1 meets the sheet only in an internal edge or vertex, so no
    // single pair straddles. The surface still passes through.
    const columns = [...new Set(placeAll(prepared.parts[0], still).map((point) => point[0]))].sort((a, b) => a - b);
    assert.equal(columns.length, 7);
    const x = columns[3];
    const seam = checkVisibleArrangement(prepared, arrange(quarterTurnAt(x)));
    assert.deepEqual(seam, { status: 'unresolved', reason: 'ambiguous-contact', scope: 'named-visible-surfaces' });
    assert.equal(visibleSurfaceProblem(seam), 'Rehere could not finish checking these photographed surfaces. Nothing was changed. Try a different arrangement.');
    // Just off the seam the crossing is proved.
    assert.equal(checkVisibleArrangement(prepared, arrange(quarterTurnAt(x + 1e-5))).status, 'intersects');
  });

  it('allows contact along the rendered outline only', () => {
    const right = columnX(first, 'max');
    assert.equal(checkVisibleArrangement(prepared, arrange(quarterTurnAt(right))).status, 'clear');
    assert.equal(checkVisibleArrangement(prepared, arrange(quarterTurnAt(right + 1e-3))).status, 'clear');
    assert.equal(checkVisibleArrangement(prepared, arrange(quarterTurnAt(right - 1e-3))).status, 'intersects');
    // Placed just inside the rim, the turned sheet passes through object-1's
    // edge triangles: never clear, however thin the penetration.
    for (const intrusion of [1e-15, 1e-14, 1e-13]) {
      assert.notEqual(checkVisibleArrangement(prepared, arrange(quarterTurnAt(right - intrusion))).status, 'clear', `intrusion ${intrusion}`);
    }
  });

  it('separates coplanar overlap from coplanar edge contact', () => {
    // object-2 moved into object-1's plane, edge to edge with it.
    const abut = columnX(first, 'max') - (columnX(second, 'min'));
    const at = (shift) => ({ offset: [abut + shift, 0, 1], yaw: 0 });
    assert.equal(checkVisibleArrangement(prepared, arrange(at(0))).status, 'clear');
    assert.equal(checkVisibleArrangement(prepared, arrange(at(0.01))).status, 'clear');
    assert.equal(checkVisibleArrangement(prepared, arrange(at(-0.01))).status, 'intersects');
  });

  it('holds a coplanar intrusion too thin to prove, and never calls it contact', () => {
    // object-1 moved right into object-2's plane, using the prepared bounds.
    const [a, b] = prepared.parts;
    const gap = (b.pivot[0] + b.bounds[0]) - (a.pivot[0] + a.bounds[3]);
    const moved = (intrusion) => arrange(still, { offset: [gap + intrusion, 0, -1], yaw: 0 });
    assert.equal(checkVisibleArrangement(prepared, moved(0)).status, 'clear');
    for (const intrusion of [1e-13, 1e-12, 2e-12, 1e-11, 1e-10, 1e-9]) {
      assert.deepEqual(checkVisibleArrangement(prepared, moved(intrusion)), { status: 'unresolved', reason: 'ambiguous-contact', scope: 'named-visible-surfaces' }, `intrusion ${intrusion}`);
    }
    for (const intrusion of [1e-8, 1e-3]) assert.equal(checkVisibleArrangement(prepared, moved(intrusion)).status, 'intersects', `intrusion ${intrusion}`);
    for (const gapSize of [1e-11, 1e-3]) assert.equal(checkVisibleArrangement(prepared, moved(-gapSize)).status, 'clear', `gap ${gapSize}`);
  });

  it('passes slanted surfaces whose bounding boxes overlap but whose meshes do not', () => {
    const right = columnX(first, 'max');
    const slanted = { offset: [right + 0.3 - second.pivot[0], 0, -2 - second.pivot[2]], yaw: Math.PI / 4 };
    const corners = (part, transform) => [part.bounds.slice(0, 3), part.bounds.slice(3)].map(placer(THREE, part.pivot, transform));
    const placed = [...corners(prepared.parts[1], slanted), ...placeAll(prepared.parts[1], slanted)];
    assert.ok(Math.min(...placed.map((point) => point[0])) < right, 'boxes overlap in x');
    assert.equal(checkVisibleArrangement(prepared, arrange(slanted)).status, 'clear');
  });

  it('holds invalid arrangements and exhausted work', () => {
    const invalid = [
      undefined, {}, { objects: [] }, arrange(still).objects,
      { objects: [{ id: 'object-1', ...still }] },
      { objects: [{ id: 'object-1', ...still }, { id: 'object-3', ...still }] },
      arrange({ offset: [0, 0, Number.NaN], yaw: 0 }),
      arrange({ offset: [0, 0, 2.5], yaw: 0 }),
      arrange({ offset: [0, 0, 0], yaw: 4 }),
    ];
    for (const arrangement of invalid) {
      assert.deepEqual(checkVisibleArrangement(prepared, arrangement), { status: 'unresolved', reason: 'invalid', scope: 'named-visible-surfaces' });
    }
    assert.equal(checkVisibleArrangement(null, arrange(still)).reason, 'invalid');
    const crossing = arrange(quarterTurnAt(first.pivot[0] + 0.0371));
    assert.equal(checkVisibleArrangement(prepared, crossing, { maxNodes: 3 }).reason, 'work-limit');
    assert.equal(checkVisibleArrangement(prepared, crossing, { maxPairs: 2 }).reason, 'work-limit');
    assert.equal(checkVisibleArrangement(prepared, crossing, DEFAULT_LIMITS).status, 'intersects');
    assert.equal(visibleSurfaceProblem({ status: 'clear' }), null);
    for (const value of [undefined, null, {}, { status: 'unresolved' }, { status: 'other' }]) {
      assert.equal(visibleSurfaceProblem(value), 'Rehere could not finish checking these photographed surfaces. Nothing was changed. Try a different arrangement.');
    }
  });

  it('refuses a one-object surface', () => {
    const legacy = { ...frontal, schema_version: undefined, objects: undefined, regions: undefined, foreground: frontal.regions.map((value) => (value === 1 ? 1 : 0)) };
    delete legacy.schema_version;
    delete legacy.objects;
    delete legacy.regions;
    assert.throws(() => prepare(legacy), /two-object/);
  });

  it('refuses finite depths whose Float32 vertices overflow', () => {
    const huge = structuredClone(frontal);
    huge.depth = huge.depth.map((value, index) => (huge.regions[index] === 1 ? 1e40 : value));
    assert.ok(Number.isFinite(huge.depth.find((value) => value === 1e40)));
    assert.throws(() => prepare(huge), /outside the supported range/);
  });
});

function placeAll(part, transform) {
  const points = [];
  const place = placer(THREE, part.pivot, transform);
  for (let i = 0; i < part.local.length; i += 3) points.push(place([part.local[i], part.local[i + 1], part.local[i + 2]]));
  return points;
}

describe('flat 16 by 12 coplanar diagnostic', () => {
  // Both objects and the background at one depth: the photographed
  // arrangement is coplanar and separated. object-1 is moved right by its
  // prepared bounds so its outline meets object-2's, then a little further.
  const flat = surface({
    width: 16, height: 12,
    region: (c, r) => (inside(r, 2, 9) && inside(c, 1, 6) ? 1 : inside(r, 2, 9) && inside(c, 9, 14) ? 2 : 0),
    depth: () => 3,
  });
  const prepared = prepare(flat);
  const [a, b] = prepared.parts;
  const gap = (b.pivot[0] + b.bounds[0]) - (a.pivot[0] + a.bounds[3]);
  const moved = (intrusion) => arrange(still, { offset: [gap + intrusion, 0, 0], yaw: 0 });

  it('keeps exact outline contact and separation clear', () => {
    for (const shift of [0, -1e-10, -1e-3]) assert.equal(checkVisibleArrangement(prepared, moved(shift)).status, 'clear', `shift ${shift}`);
    // Exact contact needs exact sign decisions; without budget for them it holds.
    assert.deepEqual(checkVisibleArrangement(prepared, moved(0), { maxExact: 0 }), { status: 'unresolved', reason: 'work-limit', scope: 'named-visible-surfaces' });
  });

  it('holds every positive intrusion too thin to prove and proves thicker ones', () => {
    for (const intrusion of [1e-13, 1e-12, 2e-12, 1e-11, 1e-10, 1e-9]) {
      assert.deepEqual(checkVisibleArrangement(prepared, moved(intrusion)), { status: 'unresolved', reason: 'ambiguous-contact', scope: 'named-visible-surfaces' }, `intrusion ${intrusion}`);
    }
    for (const intrusion of [1e-8, 1e-3]) assert.equal(checkVisibleArrangement(prepared, moved(intrusion)).status, 'intersects', `intrusion ${intrusion}`);
  });
});

// Exact seam constructions. Depths are binary fractions and both objects keep
// yaw 0, so Three's placement is exact: object-2 is a frontal sheet moved to
// z = -2 exactly, and the named object-1 vertices lie exactly at z = -2.
const sheet = { offset: [-1.2, 0, 1], yaw: 0 };
const exactSurface = (region1, depth1) => surface({
  region: (c, r) => (region1(c, r) ? 1 : inside(c, 10, 18) && inside(r, 2, 18) ? 2 : 0),
  depth: (c, r) => (region1(c, r) ? depth1(c, r) : inside(c, 10, 18) && inside(r, 2, 18) ? 3 : 6),
});
const sheetAt = (dz) => arrange({ ...sheet, offset: [sheet.offset[0], 0, 1 + dz] });
function zOf(prepared, transform, index) {
  return placeAll(prepared.parts[index], transform).map((point) => point[2]);
}

describe('surfaces meeting exactly along internal seams', () => {
  const quadCell = (c, r) => inside(c, 5, 6) && inside(r, 5, 6);
  // One quad whose diagonal corners (5,6) and (6,5) lie at depth 2, with
  // (5,5) in front and (6,6) behind: it crosses z = -2 exactly along its
  // internal diagonal and nowhere else.
  const diagonal = prepare(exactSurface(quadCell, (c, r) => 2 + 0.0625 * ((c - 5) + (r - 5) - 1)));
  // A sheet sloping across columns 2-8, crossing z = -2 exactly along its
  // interior column 5 (internal vertical edges and vertices).
  const ridge = prepare(exactSurface((c, r) => inside(c, 2, 8) && inside(r, 5, 15), (c) => 2 + 0.0625 * (c - 5)));

  it('places the seams exactly in the sheet plane', () => {
    assert.deepEqual([...diagonal.parts[0].index], [0, 1, 2, 2, 1, 3]);
    const quad = zOf(diagonal, still, 0);
    assert.deepEqual([quad[1], quad[2]], [-2, -2]);
    assert.ok(quad[0] > -2 && quad[3] < -2);
    assert.ok(zOf(diagonal, sheet, 1).every((z) => z === -2));
    assert.equal(zOf(ridge, still, 0).filter((z) => z === -2).length, 11);
  });

  it('never calls a crossing exactly along an internal diagonal or column clear', () => {
    for (const prepared of [diagonal, ridge]) {
      assert.deepEqual(checkVisibleArrangement(prepared, sheetAt(0)), { status: 'unresolved', reason: 'ambiguous-contact', scope: 'named-visible-surfaces' });
      for (const dz of [1e-12, -1e-12]) assert.equal(checkVisibleArrangement(prepared, sheetAt(dz)).status, 'intersects', `dz ${dz}`);
      assert.equal(checkVisibleArrangement(prepared, sheetAt(0.3)).status, 'clear');
    }
  });

  it('allows a sheet that touches exactly along an outline edge', () => {
    // Column 5 at depth 2 and column 6 behind it: the quad meets z = -2 only
    // along its outline edge (5,5)-(5,6).
    const edge = prepare(exactSurface(quadCell, (c) => 2 + 0.0625 * (c - 5)));
    const quad = zOf(edge, still, 0);
    assert.deepEqual([quad[0], quad[1]], [-2, -2]);
    assert.equal(checkVisibleArrangement(edge, sheetAt(0)).status, 'clear');
    assert.equal(checkVisibleArrangement(edge, sheetAt(1e-12)).status, 'clear');
    assert.equal(checkVisibleArrangement(edge, sheetAt(-1e-12)).status, 'intersects');
  });
});

describe('sheets turned onto a quad seam by a computed yaw', () => {
  // Kept from the first version of these checks. The yaw comes from atan2, so
  // after rounding the sheet is not exactly through the named edge: exact signs
  // show its triangles cut the quad's interior. Whatever the classification,
  // it must never be clear.
  const quad = surface({
    region: (c, r) => (inside(c, 5, 6) && inside(r, 5, 6) ? 1 : inside(c, 10, 18) && inside(r, 2, 18) ? 2 : 0),
    depth: (c, r) => (inside(c, 5, 6) && inside(r, 5, 6) ? 2 + 0.05 * r : inside(c, 10, 18) && inside(r, 2, 18) ? 3 : 6),
  });
  const prepared = prepare(quad);
  const [first, second] = prepared.parts;
  const sheetThrough = (p, q, normalShift = 0, slide = 0.0137) => {
    const yaw = Math.atan2(-(q[2] - p[2]), q[0] - p[0]);
    const along = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const normal = [Math.sin(yaw), 0, Math.cos(yaw)];
    const centre = [0, 1, 2].map((axis) => (p[axis] + q[axis]) / 2 + slide * along[axis] + normalShift * normal[axis]);
    return { offset: centre.map((value, axis) => value - second.pivot[axis]), yaw };
  };
  // Vertex order: (5,5), (5,6), (6,5), (6,6). The diagonal joins vertices 1
  // and 2; vertices 0 and 1 form an outline edge.
  const diagonal = [world(first, 1), world(first, 2)];
  const outline = [world(first, 0), world(first, 1)];

  it('never reports either sheet as clear', () => {
    assert.deepEqual([...first.index], [0, 1, 2, 2, 1, 3]);
    for (const ends of [diagonal, outline]) assert.notEqual(checkVisibleArrangement(prepared, arrange(sheetThrough(...ends))).status, 'clear');
  });

  it('proves the crossing off the diagonal and clears it far away', () => {
    for (const shift of [1e-4, -1e-4]) assert.equal(checkVisibleArrangement(prepared, arrange(sheetThrough(...diagonal, shift))).status, 'intersects');
    assert.equal(checkVisibleArrangement(prepared, arrange(sheetThrough(...diagonal, 0.5))).status, 'clear');
  });
});

describe('holes and depth-rejected triangles', () => {
  // object-1 spans columns 2-10 with a gap at column 6: void cells in one
  // surface, a depth jump beyond the triangle span in the other.
  const band = (c, r) => inside(c, 2, 10) && inside(r, 5, 15);
  const counter = (c, r) => inside(c, 13, 19) && inside(r, 5, 15);
  const holed = surface({
    region: (c, r) => (band(c, r) ? (c === 6 ? -1 : 1) : counter(c, r) ? 2 : 0),
    depth: (c, r) => (band(c, r) ? 2 : counter(c, r) ? 3 : 6),
  });
  const stepped = surface({
    region: (c, r) => (band(c, r) ? 1 : counter(c, r) ? 2 : 0),
    depth: (c, r) => (band(c, r) ? (c <= 5 ? 2 : 2.4) : counter(c, r) ? 3 : 6),
  });

  for (const [name, s] of [['void cells', holed], ['a depth jump', stepped]]) {
    it(`lets a sheet pass through ${name} and touch its rim`, () => {
      const prepared = prepare(s);
      const [first, second] = prepared.parts;
      const turned = (x) => ({ offset: [x - second.pivot[0], 0, -2 + 0.0123 - second.pivot[2]], yaw: Math.PI / 2 });
      // The rim is the last column of the left piece, which lies at depth 2
      // left of x = -0.4. Nothing of object-1 lies just beyond it.
      const points = placeAll(first, still);
      const rim = Math.max(...points.filter((point) => point[2] > -2.2 && point[0] < -0.4).map((point) => point[0]));
      assert.ok(points.every((point) => point[0] <= rim || point[0] > rim + 0.015));
      assert.equal(checkVisibleArrangement(prepared, arrange(turned(rim + 0.01))).status, 'clear');
      assert.equal(checkVisibleArrangement(prepared, arrange(turned(rim))).status, 'clear');
      assert.equal(checkVisibleArrangement(prepared, arrange(turned(rim - 0.02))).status, 'intersects');
    });
  }
});

describe('exact orientation predicates', () => {
  it('decides a determinant whose filter arithmetic underflows', () => {
    // The exact determinant is 5u/64 > 0; plain floating-point evaluation
    // of the filter gives the wrong sign here.
    const u = Number.MIN_VALUE;
    assert.equal(orient3d([1, 1.125, -10 * u], [-1.625, -0.125, -u], [-0.125, 1.125, 0], [-1.375, 0.5, 4 * u]), 1);
  });

  it('keeps the sign of small-integer points scaled to subnormal and huge magnitudes', () => {
    // Scaling by a power of two keeps every coordinate exact and the true sign
    // unchanged; on small integers the filter itself is exact, so the
    // unscaled sign is the reference.
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed % 33) - 16;
    };
    const scales = [2 ** -1074, 2 ** -1060, 2 ** -600, 2 ** 600, 2 ** 1000];
    let zeros = 0;
    for (let round = 0; round < 400; round += 1) {
      const points = [0, 1, 2, 3].map(() => [next(), next(), next()]);
      // Every fourth set is made exactly coplanar: d = a + b - c.
      if (round % 4 === 0) points[3] = [0, 1, 2].map((k) => points[0][k] + points[1][k] - points[2][k]);
      const reference = orient3d(...points);
      if (reference === 0) zeros += 1;
      for (const scale of scales) {
        const scaled = points.map((point) => point.map((value) => value * scale));
        // Subnormal scaling must keep every integer exact to stay comparable.
        if (scaled.flat().some((value, index) => value / scale !== points.flat()[index])) continue;
        assert.equal(orient3d(...scaled), reference, `orient3d round ${round} scale ${scale}`);
        for (const axis of [0, 1, 2]) assert.equal(orient2d(...scaled.slice(0, 3), axis), orient2d(...points.slice(0, 3), axis), `orient2d round ${round} axis ${axis} scale ${scale}`);
      }
    }
    assert.ok(zeros >= 100, 'exactly coplanar sets are covered');
  });

  it('keeps the sign when one axis is scaled to subnormal or huge magnitudes', () => {
    // Scaling one axis by a positive factor scales the determinant without
    // changing its sign. With x and y normal and z subnormal, the products in
    // the floating-point filter underflow, as in the case above.
    let seed = 777;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed % 33) - 16;
    };
    let zeros = 0;
    for (let round = 0; round < 2000; round += 1) {
      const points = [0, 1, 2, 3].map(() => [next() / 8, next() / 8, next()]);
      if (round % 4 === 0) points[3] = [0, 1, 2].map((k) => points[0][k] + points[1][k] - points[2][k]);
      const reference = orient3d(...points);
      if (reference === 0) zeros += 1;
      for (const scale of [Number.MIN_VALUE, 2 ** -1060, 2 ** -1000, 2 ** 1000]) {
        const scaled = points.map(([x, y, z]) => [x, y, z * scale]);
        assert.equal(orient3d(...scaled), reference, `orient3d round ${round} scale ${scale}`);
        for (const axis of [0, 1]) assert.equal(orient2d(...scaled.slice(0, 3), axis), orient2d(...points.slice(0, 3), axis), `orient2d round ${round} axis ${axis}`);
      }
    }
    assert.ok(zeros >= 400, 'exactly coplanar sets are covered');
  });

  it('decides huge and mixed-magnitude coordinates exactly', () => {
    const big = 2 ** 1000;
    // Differences overflow to infinity in floating point; the exact sign stands.
    assert.equal(orient3d([big, 0, 0], [0, big, 0], [0, 0, big], [-big, -big, -big]), orient3d([1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, -1, -1]));
    assert.equal(orient3d([big, -big, 0], [-big, big, 0], [0, 0, big], [0, 0, -big]), 0);
    // Exactly one unit off a plane through coordinates near 2^60.
    const far = 2 ** 60;
    assert.equal(orient3d([far, 0, 0], [0, far, 0], [0, 0, 0], [1, 1, 1]), orient3d([1, 0, 0], [0, 1, 0], [0, 0, 0], [1, 1, 1]));
    assert.equal(orient3d([far, 0, 0], [0, far, 0], [0, 0, 0], [far, far, 0]), 0);
  });
});
