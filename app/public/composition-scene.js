export const COMPOSITION_REPRESENTATION = 'two-photo-composition-v1';
export const COMPOSITION_OBJECT_IDS = Object.freeze(['object-1', 'object-2']);
export const isComposition = (value) => value?.representation === COMPOSITION_REPRESENTATION || value?.frame === 'owner-composition';

const vector = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);
export function poseProblem(pose) {
  if (!vector(pose?.position, 3) || pose.position.some((n) => Math.abs(n) > 10)) return 'Each position must be between -10 and 10 in the owner composition frame.';
  if (!vector(pose?.quaternion, 4) || Math.abs(Math.hypot(...pose.quaternion) - 1) > 1e-8) return 'The orientation must be a unit quaternion.';
  if (!Number.isFinite(pose?.scale) || pose.scale < 0.05 || pose.scale > 5) return 'Relative scale must be between 0.05 and 5.';
  return null;
}

// Deliberately copies only pose fields, including when given an object with an id.
export const copyPose = ({ position, quaternion, scale }) => ({ position: [...position], quaternion: [...quaternion], scale });
export function canonicalPose(pose) {
  const problem = poseProblem(pose);
  if (problem) throw new Error(problem);
  const result = copyPose(pose);
  const q = result.quaternion;
  const sign = q[3] || q.find((n) => n !== 0) || 1;
  result.quaternion = q.map((n) => (n === 0 ? 0 : sign < 0 ? -n : n));
  return result;
}

export function copyArrangement(edit) {
  return {
    ...(Object.hasOwn(edit, 'version') && { version: edit.version }),
    ...(edit.frame === 'owner-composition' && { frame: edit.frame }),
    objects: edit.objects.map((item) => edit.frame === 'owner-composition'
      ? { id: item.id, ...copyPose(item) } : { id: item.id, offset: [...item.offset], yaw: item.yaw }),
    relationship: edit.relationship ? { ...edit.relationship } : null,
  };
}

const generatedQuaternion = (q) => {
  const length = Math.hypot(...q);
  return canonicalPose({ position: [0, 0, 0], quaternion: q.map((n) => n / length), scale: 1 }).quaternion;
};
export function quaternionFromEuler([x, y, z]) {
  if (![x, y, z].every(Number.isFinite)) throw new Error('The angles must be finite.');
  const [a, b, c] = [x, y, z].map((n) => Math.cos(n / 2));
  const [d, e, f] = [x, y, z].map((n) => Math.sin(n / 2));
  return generatedQuaternion([d * b * c + a * e * f, a * e * c - d * b * f, a * b * f + d * e * c, a * b * c - d * e * f]);
}
export function eulerFromQuaternion([x, y, z, w]) {
  const m13 = 2 * (x * z + w * y);
  const middle = Math.asin(Math.max(-1, Math.min(1, m13)));
  return Math.abs(m13) < 0.9999999
    ? [Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)), middle, Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z))]
    : [Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z)), middle, 0];
}
export function rotatePoseYaw(pose, delta) {
  if (!Number.isFinite(delta) || poseProblem(pose)) throw new Error('The rotation could not be read.');
  const [x, y, z, w] = pose.quaternion;
  const s = Math.sin(delta / 2), c = Math.cos(delta / 2);
  return { ...copyPose(pose), quaternion: generatedQuaternion([c * x + s * z, c * y + s * w, c * z - s * x, c * w - s * y]) };
}

export function rotateVector([x, y, z], [qx, qy, qz, qw]) {
  return [
    (1 - 2 * (qy * qy + qz * qz)) * x + 2 * (qx * qy - qz * qw) * y + 2 * (qx * qz + qy * qw) * z,
    2 * (qx * qy + qz * qw) * x + (1 - 2 * (qx * qx + qz * qz)) * y + 2 * (qy * qz - qx * qw) * z,
    2 * (qx * qz - qy * qw) * x + 2 * (qy * qz + qx * qw) * y + (1 - 2 * (qx * qx + qy * qy)) * z,
  ];
}
export function compositionFacingGuide(pose, target) {
  if (poseProblem(pose) || !vector(target, 3)) return { direction: null, level: null, readable: false, aligned: false };
  const direction = rotateVector([0, 0, 1], pose.quaternion);
  const delta = target.map((n, i) => n - pose.position[i]);
  const distance = Math.hypot(...delta);
  const readable = distance >= 0.05;
  return { direction, level: [...target], readable, aligned: readable && delta.reduce((sum, n, i) => sum + n * direction[i], 0) / distance > 0.999 };
}
export function faceObjectPose(pose, target) {
  if (poseProblem(pose) || !vector(target, 3)) return null;
  const [dx, dy, dz] = target.map((n, i) => n - pose.position[i]);
  if (Math.hypot(dx, dy, dz) < 0.05 || Math.hypot(dx, dz) < 1e-8) return null;
  const yaw = Math.atan2(dx, dz), pitch = -Math.atan2(dy, Math.hypot(dx, dz));
  // YXZ gives a world-up aim: yaw followed by pitch about the turned local X.
  const a = Math.sin(pitch / 2), b = Math.cos(pitch / 2), c = Math.sin(yaw / 2), d = Math.cos(yaw / 2);
  return { ...copyPose(pose), quaternion: generatedQuaternion([a * d, b * c, -a * c, b * d]) };
}

export function validateCompositionSurface(surface, parentValidate) {
  if (surface?.schema_version !== 3 || surface.representation !== COMPOSITION_REPRESENTATION || !Array.isArray(surface.components) || surface.components.length !== 2) throw new Error('The composition surface is invalid.');
  let cells = 0;
  for (const [index, component] of surface.components.entries()) {
    if (component?.id !== COMPOSITION_OBJECT_IDS[index] || component.texture !== `texture-${index + 1}.jpg`
      || typeof component.label !== 'string' || !component.label.trim() || component.label !== component.label.trim() || component.label.length > 80
      || component.surface?.schema_version === 3) throw new Error('The composition component is invalid.');
    parentValidate(component.surface);
    const selected = component.surface.schema_version === 2 ? component.surface.objects.some((item) => item.id === component.selectedObjectId) : component.selectedObjectId === 'selected-foreground';
    if (!selected) throw new Error('The selected source object is invalid.');
    cells += component.surface.width * component.surface.height;
  }
  if (cells > 524_288 || surface.components[0].label.toLowerCase() === surface.components[1].label.toLowerCase()) throw new Error('The composition objects are invalid.');
  const context = surface.context;
  if (context !== null) {
    if (context?.kind !== 'photographed-background' || context.componentId !== 'object-1' || poseProblem(context.pose)) throw new Error('The composition context is invalid.');
    const bounds = context.bounds, [width, height] = surface.components[0].surface.source.image_size;
    if (bounds !== null && (!vector(bounds, 4) || bounds[0] < 0 || bounds[1] < 0 || bounds[2] > width || bounds[3] > height || bounds[2] <= bounds[0] || bounds[3] <= bounds[1])) throw new Error('The context bounds are invalid.');
  }
}

export function compositionSurfaceMeshes(surface, parentMeshes) {
  const sources = surface.components.map((component) => parentMeshes(component.surface));
  const objects = surface.components.map((component, index) => {
    const part = sources[index].objects.find((item) => item.id === component.selectedObjectId);
    if (!part) throw new Error('The selected surface is unavailable.');
    return { ...part, id: component.id, label: component.label, pivot: [0, 0, 0], sourcePivot: [...part.pivot], texture: component.texture,
      sourceVerticalFovDegrees: sources[index].verticalFovDegrees, sourceImageSize: [...component.surface.source.image_size] };
  });
  let background = null;
  if (surface.context) {
    const part = sources[0].background, bounds = surface.context.bounds;
    const [width, height] = surface.components[0].surface.source.image_size;
    const indices = [];
    for (let i = 0; i < part.indices.length; i += 3) {
      const corners = part.indices.slice(i, i + 3);
      if (!bounds || corners.every((index) => {
        const x = part.uvs[index * 2] * width, y = (1 - part.uvs[index * 2 + 1]) * height;
        return x >= bounds[0] && y >= bounds[1] && x <= bounds[2] && y <= bounds[3];
      })) indices.push(...corners);
    }
    if (!indices.length) throw new Error('The selected context has no usable observed surface.');
    background = { ...part, positions: part.positions.map((n, i) => n - objects[0].sourcePivot[i % 3]), indices,
      texture: 'texture-1.jpg', pose: copyPose(surface.context.pose) };
  }
  return { background, objects };
}

export function applyPoseToObject(object, pose) {
  object.position.set(...pose.position);
  object.quaternion.set(...pose.quaternion);
  object.scale.setScalar(pose.scale);
  object.updateMatrix();
}

export function createCompositionSceneObjects(THREE, surface, textures, parts) {
  const scene = new THREE.Scene(), allocated = [];
  const mesh = (part, name, userData = {}) => {
    const geometry = new THREE.BufferGeometry();
    allocated.push(() => geometry.dispose());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(part.uvs, 2));
    geometry.setIndex(part.indices);
    const material = new THREE.MeshBasicMaterial({ map: textures?.[part.texture] ?? null });
    allocated.push(() => material.dispose());
    const result = new THREE.Mesh(geometry, material);
    result.name = name; result.userData = userData;
    return result;
  };
  try {
    const background = parts.background ? mesh(parts.background, 'observed-background') : null;
    if (background) { applyPoseToObject(background, parts.background.pose); scene.add(background); }
    const objects = parts.objects.map((part) => ({ ...part, mesh: mesh(part, part.id, { objectId: part.id, label: part.label }) }));
    scene.add(...objects.map((part) => part.mesh));
    scene.updateMatrixWorld(true);
    const applyArrangement = (arrangement) => {
      if (arrangement?.frame !== 'owner-composition' || !Array.isArray(arrangement.objects) || arrangement.objects.length !== 2 || new Set(arrangement.objects.map((part) => part.id)).size !== 2) throw new Error('The composition arrangement is invalid.');
      const poses = objects.map((part) => arrangement.objects.find((item) => item.id === part.id));
      if (poses.some((pose) => poseProblem(pose))) throw new Error('The composition pose is invalid.');
      objects.forEach((part, index) => applyPoseToObject(part.mesh, poses[index]));
      scene.updateMatrixWorld(true);
    };
    return { scene, background, objects, applyArrangement };
  } catch (error) {
    for (const release of allocated.reverse()) release();
    throw error;
  }
}
