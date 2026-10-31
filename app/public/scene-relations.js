export const FRONT_MARGIN = 0.05;
export const PROJECTION_EPSILON = 0.000001;

const vector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

export function objectCentre(pivot, transform) {
  if (!vector(pivot) || !vector(transform?.offset)) return null;
  return pivot.map((value, axis) => value + transform.offset[axis]);
}

// Compare positions from the original camera, not world X or the current orbit.
export function projectedX(centre) {
  if (!vector(centre) || centre[2] > -FRONT_MARGIN) return null;
  const position = centre[0] / -centre[2];
  return Number.isFinite(position) ? position : null;
}

export function checkRelationship(arrangement, pivots, rule = arrangement?.relationship) {
  const positions = {};
  const objects = arrangement?.objects;
  if (!Array.isArray(objects) || !Array.isArray(pivots) || objects.length !== 2 || pivots.length !== 2
    || new Set(objects.map((item) => item.id)).size !== 2 || new Set(pivots.map((item) => item.id)).size !== 2) {
    return { ok: false, reason: 'invalid', positions };
  }
  for (const item of objects) {
    const pivot = pivots.find((entry) => entry.id === item.id);
    if (!pivot || !vector(pivot.pivot) || !vector(item.offset)) return { ok: false, reason: 'invalid', positions };
    positions[item.id] = projectedX(objectCentre(pivot.pivot, item));
  }
  if (rule === null) return { ok: true, reason: null, positions };
  if (!rule || Object.keys(rule).length !== 4 || rule.kind !== 'left_of' || rule.frame !== 'original-photo'
    || rule.leftId === rule.rightId || !Object.hasOwn(positions, rule.leftId) || !Object.hasOwn(positions, rule.rightId)) {
    return { ok: false, reason: 'invalid', positions };
  }
  if (positions[rule.leftId] === null || positions[rule.rightId] === null) return { ok: false, reason: 'front', positions };
  const ok = positions[rule.leftId] + PROJECTION_EPSILON < positions[rule.rightId];
  return { ok, reason: ok ? null : 'order', positions };
}
