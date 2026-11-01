// Checks whether the two named objects' photographed surfaces overlap in an
// arrangement. The meshes are exactly the renderer's: the same Float32 local
// vertices, surviving triangles and pivots from objectSurfaceMeshes, placed by
// the same yaw about Y and offset. Three.js and MeshBVH are passed in, so the
// browser (local vendor modules) and Node (pinned packages) run the same code.
//
// Only these two observed surfaces are compared: not the background, unseen
// backs, hidden volumes or the path between arrangements. A clear result says
// nothing about a whole room.
import { editProblem, objectSurfaceMeshes } from './photo-scene.js';

const SCOPE = 'named-visible-surfaces';

// Deterministic work caps; exceeding any holds the arrangement. Node visits
// count BVH bounds tests in both passes; pairs count candidate triangles in
// the first pass and triangle-pair tests in the second; exact counts sign
// decisions the floating-point filter could not settle (BigInt arithmetic).
export const DEFAULT_LIMITS = Object.freeze({ maxNodes: 4_000_000, maxPairs: 1_000_000, maxExact: 50_000 });

// Signs (which side of a plane or line a point lies on, including exactly on
// it) are always decided exactly; see orient3d. HOLD, relative to the scene's
// coordinate scale, is only the thickness an approximate overlap must exceed to
// count as proof, far above rounding. Thinner overlaps hold as unresolved.
const HOLD = 1e-9;
// Slivers and nearly parallel planes make normals and crossing lines
// ill-conditioned: rounding grows by about 1/ratio. Such pairs get no
// approximate proof; slivers hold when they come near the other triangle.
const MIN_SHAPE = 1e-4;

const NONE = 0;
const WITNESS = 1;
const AMBIGUOUS = 2;

const PROBLEMS = {
  intersects: 'These photographed surfaces overlap. Nothing was changed. Move the object apart before applying.',
  unresolved: 'Rehere could not finish checking these photographed surfaces. Nothing was changed. Try a different arrangement.',
};

export function visibleSurfaceProblem(result) {
  if (result?.status === 'clear') return null;
  return result?.status === 'intersects' ? PROBLEMS.intersects : PROBLEMS.unresolved;
}

// Places local vertices with the renderer's own arithmetic: the mesh's
// position (pivot + offset) and rotation (0, yaw, 0) composed by Three.js, its
// world matrix taken under the scene's identity matrix, and Vector3.applyMatrix4.
// The exact predicates then judge the same doubles the scene uses.
export function placer(THREE, pivot, { offset, yaw }) {
  const object = new THREE.Object3D();
  object.position.set(pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]);
  object.rotation.set(0, yaw, 0);
  object.updateMatrix();
  const matrix = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4(), object.matrix);
  const point = new THREE.Vector3();
  return ([x, y, z]) => point.set(x, y, z).applyMatrix4(matrix).toArray();
}

// Edges used by exactly one triangle form the rendered mesh boundary: the
// outline and the rims of holes left by rejected triangles. A vertex on such an
// edge is a boundary vertex. Every other edge or vertex is an internal seam.
function boundaryOf(indices, vertexCount) {
  const uses = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    for (const [a, b] of [[indices[i], indices[i + 1]], [indices[i + 1], indices[i + 2]], [indices[i + 2], indices[i]]]) {
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const edges = new Set();
  const vertices = new Uint8Array(vertexCount);
  for (const [key, count] of uses) {
    if (count !== 1) continue;
    edges.add(key);
    vertices[Math.floor(key / vertexCount)] = 1;
    vertices[key % vertexCount] = 1;
  }
  return { edges, vertices };
}

export function prepareVisibleGeometry(THREE, MeshBVH, surface) {
  if (surface?.schema_version !== 2) throw new Error('Only a two-object scene has named surfaces to compare.');
  const { objects } = objectSurfaceMeshes(surface);
  const parts = objects.map(({ id, pivot, positions, indices }) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const local = geometry.attributes.position.array;
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < local.length; i += 1) {
      bounds[i % 3] = Math.min(bounds[i % 3], local[i]);
      bounds[3 + (i % 3)] = Math.max(bounds[3 + (i % 3)], local[i]);
    }
    if (!bounds.every(Number.isFinite) || !pivot.every(Number.isFinite)) throw new Error('The scene surface is outside the supported range.');
    const index = geometry.index.array;
    return {
      id, pivot: [...pivot], local, index, bounds,
      boundary: boundaryOf(index, local.length / 3),
      bvh: new MeshBVH(geometry, { indirect: true }),
    };
  });
  return { THREE, parts };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// Exact arithmetic for sign decisions. Every double is m * 2^e with integer m,
// so the coordinates of a few points scaled to their smallest exponent are
// exact BigInts, and determinants over them have exact signs.
const bits = new DataView(new ArrayBuffer(8));
function dyadic(x) {
  bits.setFloat64(0, x);
  const high = bits.getUint32(0);
  const exponent = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(bits.getUint32(4));
  if (exponent !== 0) mantissa |= 1n << 52n;
  return { m: high >>> 31 ? -mantissa : mantissa, e: (exponent || 1) - 1075 };
}
function exactPoints(points) {
  const parts = points.map((point) => point.map(dyadic));
  // Zero is 0n at any scale, so its exponent must not widen the others.
  const low = Math.min(0, ...parts.flat().filter(({ m }) => m !== 0n).map(({ e }) => e));
  return parts.map((point) => point.map(({ m, e }) => (m === 0n ? 0n : m << BigInt(e - low))));
}
const signOf = (value) => (value > 0n ? 1 : value < 0n ? -1 : 0);
// Exact decisions left in the current check. The check is synchronous, so one
// counter suffices; a result computed after it runs out is discarded.
let exactLeft = Infinity;

// Shewchuk's error bounds assume no underflow or overflow. Every nonzero
// coordinate difference must therefore lie in [2^-250, 2^250]: products of up
// to three of them and their sums then stay normal and finite with wide
// margin. Anything outside (including a non-finite difference) skips the
// filter and is decided exactly.
const SAFE_LOW = 2 ** -250;
const SAFE_HIGH = 2 ** 250;
const filterable = (values) => values.every((value) => value === 0 || (Math.abs(value) >= SAFE_LOW && Math.abs(value) <= SAFE_HIGH));

// Orientation of d against the plane through a, b, c. The floating-point value
// decides only when it exceeds Shewchuk's error bound for this expression
// (orient3d errboundA = (7 + 56 eps) eps, eps = 2^-53; see
// https://www.cs.cmu.edu/~quake/robust.html); otherwise the exact
// determinant does. The sign is therefore always the true sign for these
// coordinates.
export function orient3d(a, b, c, d) {
  const [adx, ady, adz] = sub(a, d);
  const [bdx, bdy, bdz] = sub(b, d);
  const [cdx, cdy, cdz] = sub(c, d);
  if (filterable([adx, ady, adz, bdx, bdy, bdz, cdx, cdy, cdz])) {
    const det = adx * (bdy * cdz - bdz * cdy) + bdx * (cdy * adz - cdz * ady) + cdx * (ady * bdz - adz * bdy);
    const permanent = (Math.abs(bdy * cdz) + Math.abs(bdz * cdy)) * Math.abs(adx)
      + (Math.abs(cdy * adz) + Math.abs(cdz * ady)) * Math.abs(bdx)
      + (Math.abs(ady * bdz) + Math.abs(adz * bdy)) * Math.abs(cdx);
    const bound = 7.771561172376103e-16 * permanent;
    if (det > bound) return 1;
    if (-det > bound) return -1;
  }
  exactLeft -= 1;
  const [A, B, C, D] = exactPoints([a, b, c, d]);
  const [x1, y1, z1] = [A[0] - D[0], A[1] - D[1], A[2] - D[2]];
  const [x2, y2, z2] = [B[0] - D[0], B[1] - D[1], B[2] - D[2]];
  const [x3, y3, z3] = [C[0] - D[0], C[1] - D[1], C[2] - D[2]];
  return signOf(x1 * (y2 * z3 - z2 * y3) + x2 * (y3 * z1 - z3 * y1) + x3 * (y1 * z2 - z1 * y2));
}

// Orientation of c against the line a-b in the plane that drops `axis`, with
// the same filter (orient2d ccwerrboundA = (3 + 16 eps) eps) and guard, and
// exact fallback.
export function orient2d(a, b, c, axis) {
  const [u, v] = [[1, 2], [0, 2], [0, 1]][axis];
  const differences = [a[u] - c[u], b[v] - c[v], a[v] - c[v], b[u] - c[u]];
  if (filterable(differences)) {
    const left = differences[0] * differences[1];
    const right = differences[2] * differences[3];
    const det = left - right;
    const bound = 3.3306690738754716e-16 * (Math.abs(left) + Math.abs(right));
    if (det > bound) return 1;
    if (-det > bound) return -1;
  }
  exactLeft -= 1;
  const [A, B, C] = exactPoints([a, b, c]);
  return signOf((A[u] - C[u]) * (B[v] - C[v]) - (A[v] - C[v]) * (B[u] - C[u]));
}

// An axis whose drop keeps triangle t non-degenerate, with t's orientation in
// that plane. Coplanar points keep their exact relations after the drop.
function projection(t) {
  const n = cross(sub(t[1], t[0]), sub(t[2], t[0])).map(Math.abs);
  for (const axis of [0, 1, 2].sort((i, j) => n[j] - n[i])) {
    const turn = orient2d(t[0], t[1], t[2], axis);
    if (turn !== 0) return { axis, turn };
  }
  return null;
}

// Whether the closed segment a-b meets closed triangle t, all in t's plane.
function segmentMeetsTriangle2(a, b, t) {
  const frame = projection(t);
  if (!frame) return true;
  const { axis, turn } = frame;
  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    if (turn * orient2d(t[i], t[j], a, axis) < 0 && turn * orient2d(t[i], t[j], b, axis) < 0) return false;
  }
  const sides = t.map((corner) => orient2d(a, b, corner, axis));
  return !(sides.every((side) => side > 0) || sides.every((side) => side < 0));
}

// Whether closed coplanar triangles p and q share interior points: true unless
// one of the six edge lines has the other triangle entirely on its outer side.
function interiorsMeet2(p, q) {
  for (const [t, u] of [[p, q], [q, p]]) {
    const frame = projection(t);
    if (!frame) return true;
    const { axis, turn } = frame;
    for (let i = 0; i < 3; i += 1) {
      const j = (i + 1) % 3;
      if (u.every((corner) => turn * orient2d(t[i], t[j], corner, axis) <= 0)) return false;
    }
  }
  return true;
}

// Whether closed triangles that are not coplanar meet. Their intersection, if
// any, has an end on an edge of one of them, so it suffices to test each edge
// of one against the other. `sides[i]` is the exact side of corner i of t
// against u's plane.
function edgesMeet(t, sides, u) {
  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    if (sides[i] * sides[j] > 0) continue;
    if (sides[i] === 0 && sides[j] === 0) {
      if (segmentMeetsTriangle2(t[i], t[j], u)) return true;
      continue;
    }
    // The segment reaches u's plane at one point; the line through it meets
    // closed u exactly when the three edge volumes have no opposite signs.
    const volumes = [0, 1, 2].map((k) => orient3d(t[i], t[j], u[k], u[(k + 1) % 3]));
    if (!(volumes.includes(1) && volumes.includes(-1))) return true;
  }
  return false;
}

// Unit normal, or null for a sliver: height within HOLD or a thin shape.
function unitNormal(t, hold) {
  const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
  const length = norm(n);
  const longest = Math.max(norm(sub(t[1], t[0])), norm(sub(t[2], t[1])), norm(sub(t[0], t[2])));
  if (!(length > hold * longest && length > MIN_SHAPE * longest * longest)) return null;
  return [n[0] / length, n[1] / length, n[2] / length];
}

function boxesTouch(p, q, margin) {
  for (let axis = 0; axis < 3; axis += 1) {
    const pMin = Math.min(p[0][axis], p[1][axis], p[2][axis]);
    const pMax = Math.max(p[0][axis], p[1][axis], p[2][axis]);
    if (pMin > Math.max(q[0][axis], q[1][axis], q[2][axis]) + margin || pMax < Math.min(q[0][axis], q[1][axis], q[2][axis]) - margin) return false;
  }
  return true;
}

// 2D coordinates in the plane through `origin` with unit normal `n`.
function planeFrame(origin, n, axisHint) {
  const u = sub(axisHint, origin);
  const length = norm(u);
  const e1 = [u[0] / length, u[1] / length, u[2] / length];
  const e2 = cross(n, e1);
  return (point) => {
    const d = sub(point, origin);
    return [dot(d, e1), dot(d, e2)];
  };
}

// Approximate overlap thickness of two coplanar 2D triangles: the smallest
// overlap along their six edge normals.
function overlapDepth2(p, q) {
  let depth = Infinity;
  for (const t of [p, q]) {
    for (let i = 0; i < 3; i += 1) {
      const a = t[i];
      const b = t[(i + 1) % 3];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const axis = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
      const along = (points) => points.map((point) => point[0] * axis[0] + point[1] * axis[1]);
      const sp = along(p);
      const sq = along(q);
      depth = Math.min(depth, Math.min(Math.max(...sp), Math.max(...sq)) - Math.max(Math.min(...sp), Math.min(...sq)));
    }
  }
  return depth;
}

// Approximate span of a straddling triangle's crossing with a plane, measured
// along the planes' common line `direction`.
function chord(t, distances, sides, direction) {
  const values = [];
  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    if (sides[i] === 0) values.push(dot(t[i], direction));
    if (sides[i] * sides[j] < 0) {
      const k = distances[i] / (distances[i] - distances[j]);
      values.push(dot([t[i][0] + k * (t[j][0] - t[i][0]), t[i][1] + k * (t[j][1] - t[i][1]), t[i][2] + k * (t[j][2] - t[i][2])], direction));
    }
  }
  return [Math.min(...values), Math.max(...values)];
}

// Classifies one triangle pair in world space. Clear outcomes (NONE) rest only
// on exact signs: the triangles are disjoint, or they meet only in a vertex or
// edge that lies exactly in the other's plane and is on its own mesh's
// rendered boundary, or they are coplanar with disjoint interiors (a real
// coplanar overlap shows in another pair as shared interior). WITNESS needs an
// approximate overlap thicker than HOLD, far beyond rounding: a crossing
// through both interiors or coplanar overlap. Anything else that meets is
// AMBIGUOUS: thin overlap, or contact at an internal seam whose neighbours may
// cross the other surface (a sheet through a quad's diagonal) or only touch.
// `isBoundary(k, corners)` says whether those corners of triangle k form a
// vertex or edge on that mesh's boundary.
function classify(p, q, isBoundary, hold) {
  const np = unitNormal(p, hold);
  const nq = unitNormal(q, hold);
  if (!np || !nq) return boxesTouch(p, q, hold) ? AMBIGUOUS : NONE;
  const sp = p.map((corner) => orient3d(q[0], q[1], q[2], corner));
  const sq = q.map((corner) => orient3d(p[0], p[1], p[2], corner));
  const oneSide = (s) => s[0] !== 0 && s[0] === s[1] && s[1] === s[2];
  if (oneSide(sp) || oneSide(sq)) return NONE;
  if (sp.every((s) => s === 0) || sq.every((s) => s === 0)) {
    const to2 = planeFrame(p[0], np, p[1]);
    if (overlapDepth2(p.map(to2), q.map(to2)) > hold) return WITNESS;
    return interiorsMeet2(p, q) ? AMBIGUOUS : NONE;
  }
  const straddles = (s) => s.includes(1) && s.includes(-1);
  const bothStraddle = straddles(sp) && straddles(sq);
  if (bothStraddle) {
    const line = cross(np, nq);
    const length = norm(line);
    if (length >= MIN_SHAPE) {
      const direction = [line[0] / length, line[1] / length, line[2] / length];
      const [p0, p1] = chord(p, p.map((v) => dot(nq, sub(v, q[0]))), sp, direction);
      const [q0, q1] = chord(q, q.map((v) => dot(np, sub(v, p[0]))), sq, direction);
      if (Math.min(p1, q1) - Math.max(p0, q0) > hold) return WITNESS;
    }
  }
  if (!edgesMeet(p, sp, q) && !edgesMeet(q, sq, p)) return NONE;
  if (bothStraddle) return AMBIGUOUS;
  // A triangle that does not straddle meets the other only in its corners
  // lying exactly in that plane.
  const onBoundary = (s, k) => !straddles(s) && isBoundary(k, [0, 1, 2].filter((i) => s[i] === 0));
  return onBoundary(sp, 0) || onBoundary(sq, 1) ? NONE : AMBIGUOUS;
}

function validArrangement(prepared, arrangement) {
  const transforms = arrangement?.objects;
  if (!Array.isArray(transforms) || transforms.length !== prepared.parts.length) return null;
  const byId = new Map(transforms.map((item) => [item?.id, item]));
  const ordered = prepared.parts.map((part) => byId.get(part.id));
  return ordered.every((item) => item && editProblem(item) === null) ? ordered : null;
}

function placedBox(part, place) {
  const [x0, y0, z0, x1, y1, z1] = part.bounds;
  const corners = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push(place([x, y, z]));
  return corners;
}

// World points into a part's local frame for BVH queries only:
// local = R_y(-yaw) * (world - position). Its rounding is far inside the
// query margin.
function toLocal(part, { offset, yaw }, [x, y, z]) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = x - part.pivot[0] - offset[0];
  const dz = z - part.pivot[2] - offset[2];
  return [c * dx - s * dz, y - part.pivot[1] - offset[1], s * dx + c * dz];
}

function aabb(points, margin) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      box[axis] = Math.min(box[axis], point[axis] - margin);
      box[3 + axis] = Math.max(box[3 + axis], point[axis] + margin);
    }
  }
  return box;
}

const meets = (box, { min, max }) => !(box[0] > max.x || box[3] < min.x || box[1] > max.y || box[4] < min.y || box[2] > max.z || box[5] < min.z);

function worldTriangle(part, place, triangle) {
  return [0, 1, 2].map((corner) => {
    const v = part.index[triangle * 3 + corner] * 3;
    return place([part.local[v], part.local[v + 1], part.local[v + 2]]);
  });
}

export function checkVisibleArrangement(prepared, arrangement, limits = DEFAULT_LIMITS) {
  const result = (status, reason) => ({ status, reason, scope: SCOPE });
  const transforms = prepared?.parts?.length === 2 ? validArrangement(prepared, arrangement) : null;
  if (!transforms) return result('unresolved', 'invalid');
  const { maxNodes, maxPairs, maxExact } = { ...DEFAULT_LIMITS, ...limits };
  const [a, b] = prepared.parts;
  const [ta, tb] = transforms;
  const placeA = placer(prepared.THREE, a.pivot, ta);
  const placeB = placer(prepared.THREE, b.pivot, tb);
  const cornersA = placedBox(a, placeA);
  const cornersB = placedBox(b, placeB);
  const scale = Math.max(1, ...[...cornersA, ...cornersB].flat().map(Math.abs));
  const hold = HOLD * scale;
  // Query boxes are widened far past rounding, so no pair that could touch is
  // missed by the Float32 BVH bounds.
  const margin = 2 * hold;
  let nodes = 0;
  let pairs = 0;
  let exhausted = false;
  const spend = (kind) => {
    if (kind === 'node') nodes += 1;
    else pairs += 1;
    if (nodes > maxNodes || pairs > maxPairs) exhausted = true;
    return exhausted;
  };

  // Pass 1: triangles of A near B's placed bounds, in A's local frame.
  const nearB = aabb(cornersB.map((point) => toLocal(a, ta, point)), margin);
  const candidates = [];
  a.bvh.shapecast({
    intersectsBounds: (box) => !spend('node') && meets(nearB, box),
    intersectsTriangle: (_triangle, index) => {
      if (spend('pair')) return true;
      candidates.push(index);
      return false;
    },
  });
  if (exhausted) return result('unresolved', 'work-limit');

  // Pass 2: for each candidate, B's triangles near it, then the exact test.
  const isBoundary = (part) => (indices) => {
    if (indices.length === 1) return part.boundary.vertices[indices[0]] === 1;
    const count = part.local.length / 3;
    return part.boundary.edges.has(Math.min(...indices) * count + Math.max(...indices));
  };
  let ambiguous = false;
  exactLeft = maxExact;
  for (const triangleA of candidates) {
    const p = worldTriangle(a, placeA, triangleA);
    const near = aabb(p.map((point) => toLocal(b, tb, point)), margin);
    const vertsA = [0, 1, 2].map((corner) => a.index[triangleA * 3 + corner]);
    let witness = false;
    b.bvh.shapecast({
      intersectsBounds: (box) => !spend('node') && meets(near, box),
      intersectsTriangle: (_triangle, triangleB) => {
        if (spend('pair')) return true;
        const q = worldTriangle(b, placeB, triangleB);
        const vertsB = [0, 1, 2].map((corner) => b.index[triangleB * 3 + corner]);
        const boundary = (k, corners) => (k === 0 ? isBoundary(a)(corners.map((i) => vertsA[i])) : isBoundary(b)(corners.map((i) => vertsB[i])));
        const verdict = classify(p, q, boundary, hold);
        if (exactLeft < 0) exhausted = true;
        if (exhausted) return true;
        if (verdict === WITNESS) witness = true;
        else if (verdict === AMBIGUOUS) ambiguous = true;
        return witness;
      },
    });
    if (exhausted) return result('unresolved', 'work-limit');
    if (witness) return result('intersects', 'overlap');
  }
  return ambiguous ? result('unresolved', 'ambiguous-contact') : result('clear', 'separated');
}
