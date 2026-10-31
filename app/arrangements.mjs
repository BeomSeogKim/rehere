import { RequestError } from './drafts.mjs';
import { PROPOSAL_MESSAGES } from './memory-proposals.mjs';
import { checkRelationship } from './public/scene-relations.js';

// Two-object scenes. IDs follow the request order. Labels are the owner's
// names for the boxes, kept apart only by their text, not identities found by a model.
export const OBJECT_IDS = Object.freeze(['object-1', 'object-2']);
export const isTwoObject = (manifest) => Array.isArray(manifest?.objects);
// Shown instead of an owner's object name when its photo may not be used.
export const objectMarker = (id) => `Object ${OBJECT_IDS.indexOf(id) + 1}`;

// Both transforms and the one optional rule, copied from an edit or receipt.
export const arrangementOf = (edit) => ({
  objects: edit.objects.map(({ id, offset, yaw }) => ({ id, offset: [...offset], yaw })),
  relationship: edit.relationship ? { ...edit.relationship } : null,
});
export const objectPivots = (manifest) => manifest.objects.map(({ id, pivot }) => ({ id, pivot: [...pivot] }));
export const withTarget = (arrangement, targetId, { offset, yaw }) => ({
  ...arrangement,
  objects: arrangement.objects.map((item) => (item.id === targetId ? { id: item.id, offset: [...offset], yaw } : item)),
});

const RELATION_MESSAGES = {
  invalid: 'The relationship refers to objects this scene does not have.',
  front: 'An object would no longer be in front of the original camera, so the relationship could not be kept. Nothing was changed.',
  order: PROPOSAL_MESSAGES.relationship,
};

// Throws unless the arrangement keeps its own rule from the original camera.
export function assertRelationship(manifest, arrangement) {
  const check = checkRelationship(arrangement, objectPivots(manifest));
  if (!check.ok) throw new RequestError(409, RELATION_MESSAGES[check.reason]);
}

// A two-object scene is used only after the owner confirmed both objects.
export function assertObjectsConfirmed(manifest) {
  if (isTwoObject(manifest) && !manifest.objectsConfirmed) {
    throw new RequestError(409, 'Confirm that both outlined objects are the ones you named before changing or sharing this scene.');
  }
}
