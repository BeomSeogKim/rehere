// Pure helpers for building and editing a partial scene from one photo. Three.js
// is passed in rather than imported, so the same code runs in the browser
// (local vendor module) and in Node tests (the pinned package).

export const OFFSET_LIMIT = 2;
export const MAX_GRID_CELLS = 262_144;
export const ACTIVE_STATUSES = new Set(['queued', 'processing']);

// Building needs both grants; neither implies the other, and a source without
// recorded details (a memory saved before them) is never treated as granted.
export function buildBlockedReason(record) {
  if (!record) return 'This photo was saved before source details existed, so no uses were granted and it cannot be used to build a scene.';
  if (record.kind !== 'photo') return 'Only photos can be used to build a scene.';
  const missing = [];
  if (record.permissions?.place !== true) missing.push('“Use to reconstruct this place”');
  if (record.permissions?.model !== true) missing.push('“Use for model processing”');
  if (missing.length === 0) return null;
  return `Building a scene needs ${missing.join(' and ')}, which ${missing.length === 1 ? 'is' : 'are'} not allowed for this photo.`;
}

// Turns two corner points in image pixels into an ordered whole-pixel box
// clamped to the image.
export function boxFromPoints([ax, ay], [bx, by], width, height) {
  const clampX = (value) => Math.min(width, Math.max(0, Math.round(value)));
  const clampY = (value) => Math.min(height, Math.max(0, Math.round(value)));
  const [x1, x2] = [clampX(ax), clampX(bx)].sort((a, b) => a - b);
  const [y1, y2] = [clampY(ay), clampY(by)].sort((a, b) => a - b);
  return [x1, y1, x2, y2];
}

export function boxProblem(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isInteger)) return 'Enter whole pixel numbers for all four box edges.';
  const [x1, y1, x2, y2] = box;
  if (x1 < 0 || y1 < 0 || x2 > width || y2 > height) return `The box must stay inside the photo (0–${width} by 0–${height} pixels).`;
  if (x2 <= x1 || y2 <= y1) return 'The box needs a width and height. Drag across the object, or make the right and bottom edges larger than the left and top.';
  return null;
}

export function editProblem({ offset, yaw }) {
  if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isFinite)) return 'Each position value must be a number.';
  if (offset.some((value) => Math.abs(value) > OFFSET_LIMIT)) return `Each position value must be between -${OFFSET_LIMIT} and ${OFFSET_LIMIT}.`;
  if (!Number.isFinite(yaw) || Math.abs(yaw) > Math.PI) return 'The turn must be between -180 and 180 degrees.';
  return null;
}

export function sameEdit(a, b) {
  return a.yaw === b.yaw && a.offset.every((value, index) => value === b.offset[index]);
}

export const OBJECT_IDS = Object.freeze(['object-1', 'object-2']);
export const LEGACY_OBJECT = Object.freeze({ id: 'selected-foreground', label: 'Selected foreground object' });
// Region values of a two-object surface: void (an ambiguous overlap that is
// never drawn), background, then objects[0] and objects[1].
export const VOID_REGION = -1;
const REGION_VALUES = new Set([VOID_REGION, 0, 1, 2]);

function validateCommon({ width, height, depth, assumptions, source }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > MAX_GRID_CELLS) {
    throw new Error('The scene surface has invalid dimensions.');
  }
  if (!Array.isArray(depth) || depth.length !== width * height || !depth.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('The scene depth is invalid.');
  }
  const fov = assumptions?.horizontal_fov_degrees;
  const span = assumptions?.max_triangle_depth_span;
  if (!(fov > 0 && fov < 180) || !(span > 0)) throw new Error('The scene camera assumptions are invalid.');
  const size = source?.image_size;
  if (!Array.isArray(size) || size.length !== 2 || !size.every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('The scene image size is invalid.');
  }
}

function validObject(object, id, [imageWidth, imageHeight]) {
  const box = object?.box_xyxy;
  return object?.id === id && typeof object.label === 'string' && object.label.trim() !== '' && object.label === object.label.trim() && object.label.length <= 80
    && Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
    && box[0] >= 0 && box[1] >= 0 && box[2] <= imageWidth && box[3] <= imageHeight && box[2] > box[0] && box[3] > box[1];
}

// Accepts a legacy one-object surface (binary foreground) or a two-object
// surface (schema_version 2 with objects and regions). The public subset of a
// two-object surface may omit source.selected_objects; when present it must
// match objects exactly.
export function validateSurface(surface) {
  validateCommon(surface ?? {});
  if (surface.schema_version === undefined) {
    const { foreground, depth } = surface;
    if (!Array.isArray(foreground) || foreground.length !== depth.length || !foreground.every((value) => value === 0 || value === 1)) {
      throw new Error('The scene mask is invalid.');
    }
    return;
  }
  if (surface.schema_version !== 2 || Object.hasOwn(surface, 'foreground')) throw new Error('The scene surface version is not supported.');
  const { objects, regions, depth, source } = surface;
  if (!Array.isArray(objects) || objects.length !== OBJECT_IDS.length || !objects.every((object, index) => validObject(object, OBJECT_IDS[index], source.image_size))) {
    throw new Error('The scene objects are invalid.');
  }
  if (objects[0].label.toLowerCase() === objects[1].label.toLowerCase()) throw new Error('The scene objects need distinct labels.');
  if (!Array.isArray(regions) || regions.length !== depth.length || !regions.every((value) => REGION_VALUES.has(value))) {
    throw new Error('The scene regions are invalid.');
  }
  if (source.selected_objects !== undefined) {
    const same = Array.isArray(source.selected_objects) && source.selected_objects.length === objects.length
      && source.selected_objects.every((item, index) => item?.id === objects[index].id && item.label === objects[index].label
        && Array.isArray(item.box_xyxy) && item.box_xyxy.length === 4 && item.box_xyxy.every((value, axis) => value === objects[index].box_xyxy[axis]));
    if (!same) throw new Error('The scene objects do not match the selected objects.');
  }
}

// Builds one region's triangles. Each grid cell yields (a, c, b) and (b, c, d);
// a triangle is kept only when all corners share the region and its depth span
// is within the limit, so unseen or ambiguous surfaces stay empty.
function regionMesh(surface, regionOf, region, tangent) {
  const { width, height, depth, assumptions } = surface;
  const [imageWidth, imageHeight] = surface.source.image_size;
  const span = assumptions.max_triangle_depth_span;
  const positions = [];
  const uvs = [];
  const indices = [];
  const mapping = new Map();
  const vertex = (index) => {
    let mapped = mapping.get(index);
    if (mapped !== undefined) return mapped;
    const u = (index % width) / (width - 1);
    const v = Math.floor(index / width) / (height - 1);
    const d = depth[index];
    mapped = positions.length / 3;
    positions.push((u - 0.5) * 2 * tangent * d, ((0.5 - v) * 2 * tangent * d * imageHeight) / imageWidth, -d);
    uvs.push(u, 1 - v);
    mapping.set(index, mapped);
    return mapped;
  };
  const triangle = (a, b, c) => {
    if (regionOf(a) !== region || regionOf(b) !== region || regionOf(c) !== region) return;
    const values = [depth[a], depth[b], depth[c]];
    if (Math.max(...values) - Math.min(...values) > span) return;
    indices.push(vertex(a), vertex(b), vertex(c));
  };
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = y * width + x;
      triangle(a, a + width, a + 1);
      triangle(a + 1, a + width, a + width + 1);
    }
  }
  return { positions, uvs, indices };
}

// Moves an object's geometry to its own centre so it turns in place. The pivot
// is the exact midpoint of the bounding box of the vertices of its surviving
// triangles, the same value the server stores and the relationship check uses.
function centreOnPivot(part) {
  const pivot = [0, 1, 2].map((axis) => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = axis; i < part.positions.length; i += 3) {
      min = Math.min(min, part.positions[i]);
      max = Math.max(max, part.positions[i]);
    }
    return (min + max) / 2;
  });
  for (let i = 0; i < part.positions.length; i += 1) part.positions[i] -= pivot[i % 3];
  return { ...part, pivot };
}

const tangentOf = (surface) => Math.tan((surface.assumptions.horizontal_fov_degrees * Math.PI) / 360);
const verticalFov = (surface, tangent) => {
  const [imageWidth, imageHeight] = surface.source.image_size;
  return (2 * Math.atan((tangent * imageHeight) / imageWidth) * 180) / Math.PI;
};

// Legacy one-object surfaces only; a two-object surface is refused so no caller
// silently flattens it into one foreground.
export function surfaceMeshes(surface) {
  validateSurface(surface);
  if (surface.schema_version === 2) throw new Error('This scene has two objects; use objectSurfaceMeshes.');
  const tangent = tangentOf(surface);
  const regionOf = (index) => surface.foreground[index];
  const background = regionMesh(surface, regionOf, 0, tangent);
  const object = regionMesh(surface, regionOf, 1, tangent);
  if (background.indices.length === 0) throw new Error('The background has no usable surface.');
  if (object.indices.length === 0) throw new Error('The selected object has no usable surface.');
  return { background, foreground: centreOnPivot(object), verticalFovDegrees: verticalFov(surface, tangent) };
}

// One path for both versions: the background plus each object with its ID,
// label and pivot. A legacy surface yields its single selected foreground.
export function objectSurfaceMeshes(surface) {
  validateSurface(surface);
  const tangent = tangentOf(surface);
  const twoObjects = surface.schema_version === 2;
  const regionOf = twoObjects ? (index) => surface.regions[index] : (index) => surface.foreground[index];
  const described = twoObjects ? surface.objects.map(({ id, label }) => ({ id, label })) : [{ ...LEGACY_OBJECT }];
  const background = regionMesh(surface, regionOf, 0, tangent);
  if (background.indices.length === 0) throw new Error('The background has no usable surface.');
  const objects = described.map(({ id, label }, index) => {
    const part = regionMesh(surface, regionOf, index + 1, tangent);
    if (part.indices.length === 0) throw new Error(`The object "${label}" has no usable surface.`);
    return { id, label, ...centreOnPivot(part) };
  });
  return { background, objects, verticalFovDegrees: verticalFov(surface, tangent) };
}

// Places a normalized stored-pixel point (u, v) on the depth grid exactly as
// surfaceMeshes places vertices.
export function surfacePoint(surface, [u, v]) {
  const { width, height, depth, assumptions } = surface;
  const [imageWidth, imageHeight] = surface.source.image_size;
  const tangent = Math.tan((assumptions.horizontal_fov_degrees * Math.PI) / 360);
  const column = Math.round(u * (width - 1));
  const row = Math.round(v * (height - 1));
  const d = depth[row * width + column];
  const gridU = column / (width - 1);
  const gridV = row / (height - 1);
  return [(gridU - 0.5) * 2 * tangent * d, ((0.5 - gridV) * 2 * tangent * d * imageHeight) / imageWidth, -d];
}

export const MIN_GUIDE_DISTANCE = 0.05;

// Relates the object's photographed side (local +z turned by yaw) to a target
// point. Yaw turns only about the vertical axis, so the comparison uses the
// target's level point: the spot directly above or below it at the centre's
// height. `readable` is false when that point is too close to the centre for a
// direction to be shown; `aligned` says whether the arrow points at it.
export function facingGuide(centre, yaw, target) {
  const direction = [Math.sin(yaw), 0, Math.cos(yaw)];
  const level = [target[0], centre[1], target[2]];
  const dx = level[0] - centre[0];
  const dz = level[2] - centre[2];
  const distance = Math.hypot(dx, dz);
  const readable = distance >= MIN_GUIDE_DISTANCE;
  const aligned = readable && (dx * direction[0] + dz * direction[2]) / distance > 0.999;
  return { direction, level, readable, aligned };
}

// Creates two independent meshes: the observed background and the movable
// foreground. Only front faces are drawn: the photo shows one side of each
// surface, so the reverse stays empty instead of repeating the image.
export function createSceneObjects(THREE, surface, texture = null) {
  const parts = surfaceMeshes(surface);
  const scene = new THREE.Scene();
  const mesh = ({ positions, uvs, indices }, name) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const result = new THREE.Mesh(geometry, material);
    result.name = name;
    result.userData = { sourceId: surface.source.source_id, sourceSha256: surface.source.sha256 };
    return result;
  };
  const background = mesh(parts.background, 'observed-background');
  const foreground = mesh(parts.foreground, 'selected-foreground');
  const pivot = new THREE.Vector3(...parts.foreground.pivot);
  foreground.position.copy(pivot);
  scene.add(background, foreground);
  const applyEdit = ({ offset, yaw }) => {
    foreground.position.set(pivot.x + offset[0], pivot.y + offset[1], pivot.z + offset[2]);
    foreground.rotation.set(0, yaw, 0);
    scene.updateMatrixWorld(true);
  };
  return { scene, background, foreground, applyEdit, pivot: parts.foreground.pivot, verticalFovDegrees: parts.verticalFovDegrees };
}

// Builds the background and one independently movable mesh per object for the
// renderer. Meshes carry only their object ID and label. applyArrangement takes
// a whole arrangement and needs exactly one transform for every object.
export function createObjectSceneObjects(THREE, surface, texture = null) {
  const parts = objectSurfaceMeshes(surface);
  const scene = new THREE.Scene();
  const mesh = ({ positions, uvs, indices }, name, userData) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const result = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
    result.name = name;
    result.userData = userData;
    return result;
  };
  const background = mesh(parts.background, 'observed-background', {});
  const objects = parts.objects.map((part) => {
    const object = mesh(part, part.id, { objectId: part.id, label: part.label });
    object.position.set(...part.pivot);
    return { id: part.id, label: part.label, mesh: object, pivot: [...part.pivot] };
  });
  scene.add(background, ...objects.map((object) => object.mesh));
  scene.updateMatrixWorld(true);
  const applyArrangement = (edit) => {
    const transforms = edit?.objects;
    if (!Array.isArray(transforms) || transforms.length !== objects.length) throw new Error('The arrangement must give one transform for each object.');
    const byId = new Map(transforms.map((item) => [item?.id, item]));
    for (const object of objects) {
      const transform = byId.get(object.id);
      if (!transform || editProblem(transform)) throw new Error(`The arrangement has no valid transform for "${object.label}".`);
    }
    for (const object of objects) {
      const { offset, yaw } = byId.get(object.id);
      object.mesh.position.set(object.pivot[0] + offset[0], object.pivot[1] + offset[1], object.pivot[2] + offset[2]);
      object.mesh.rotation.set(0, yaw, 0);
    }
    scene.updateMatrixWorld(true);
  };
  return { scene, background, objects, applyArrangement, verticalFovDegrees: parts.verticalFovDegrees };
}

export function jobStatusText(job) {
  switch (job.status) {
    case 'queued':
      return 'Accepted. Waiting to start.';
    case 'processing':
      return 'Building. The local model is working; this can take a few minutes.';
    case 'ready':
      return 'Ready.';
    case 'failed':
      return `Failed. ${job.error || 'The build did not finish.'}`;
    case 'interrupted':
      return 'Interrupted before it finished. Nothing was kept from it; you can build again.';
    default:
      return 'Status unknown.';
  }
}

const copyEdit = (edit) => ({ version: edit.version, offset: [...edit.offset], yaw: edit.yaw });

// Tracks the saved transform, the local preview and the save in flight. A retry
// of the same unsaved change reuses its request ID, so a save whose response
// was lost cannot create a second version. A lost response also leaves the
// session uncertain: the server may already hold a newer version, and only a
// confirmed save or a reload of the saved state settles that. Changing the
// preview, reverting or resetting does not.
export function createEditSession(saved, newRequestId) {
  let current = copyEdit(saved);
  let preview = copyEdit(saved);
  let attempt = null;
  let uncertain = false;
  return {
    get uncertain() {
      return uncertain;
    },
    markUncertain() {
      uncertain = true;
    },
    get saved() {
      return copyEdit(current);
    },
    get preview() {
      return copyEdit(preview);
    },
    isDirty() {
      return !sameEdit(preview, current);
    },
    setPreview({ offset, yaw }) {
      preview = { version: current.version, offset: [...offset], yaw };
    },
    revert() {
      preview = copyEdit(current);
    },
    resetObject() {
      preview = { version: current.version, offset: [0, 0, 0], yaw: 0 };
    },
    saveRequest() {
      if (!attempt || !sameEdit(attempt, preview) || attempt.baseVersion !== current.version) {
        attempt = { offset: [...preview.offset], yaw: preview.yaw, baseVersion: current.version, requestId: newRequestId() };
      }
      return { requestId: attempt.requestId, baseVersion: attempt.baseVersion, offset: [...attempt.offset], yaw: attempt.yaw };
    },
    // Records a transform the server confirmed as saved. A preview changed
    // since the request was sent stays as an unsaved preview.
    confirm(edit) {
      const sent = attempt;
      current = copyEdit(edit);
      attempt = null;
      uncertain = false;
      if (!sent || sameEdit(preview, sent)) preview = copyEdit(current);
      else preview.version = current.version;
    },
    replaceSaved(edit) {
      current = copyEdit(edit);
      attempt = null;
      uncertain = false;
      preview = copyEdit(current);
    },
  };
}
