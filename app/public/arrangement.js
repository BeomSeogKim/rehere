// The owner's edit session for a two-object arrangement: the saved whole
// arrangement, the local preview of one object at a time, and the state of a
// save in flight. It holds no spatial math; relation checks belong to the
// shared scene-relations module and the server.

const copyObject = ({ id, offset, yaw }) => ({ id, offset: [...offset], yaw });
const copyRule = (rule) => (rule ? { kind: rule.kind, leftId: rule.leftId, rightId: rule.rightId, frame: rule.frame } : null);
export const copyArrangement = (edit) => ({ version: edit.version, objects: edit.objects.map(copyObject), relationship: copyRule(edit.relationship) });

const sameObject = (a, b) => a.id === b.id && a.yaw === b.yaw && a.offset.every((value, index) => value === b.offset[index]);

export function objectState(arrangement, id) {
  return arrangement.objects.find((object) => object.id === id) ?? null;
}

// The arrangement with one object's transform replaced: what a preview of
// that object shows, everything else as saved.
export function withObject(arrangement, id, { offset, yaw }) {
  return { ...copyArrangement(arrangement), objects: arrangement.objects.map((object) => (object.id === id ? { id, offset: [...offset], yaw } : copyObject(object))) };
}

// A retry of the same unsaved change reuses its request ID; a lost response
// leaves the session uncertain until a confirmed save or a reload settles it.
export function createArrangementSession(saved, newRequestId) {
  let current = copyArrangement(saved);
  let preview = copyArrangement(saved);
  let attempt = null;
  let uncertain = false;

  const changedIds = () => preview.objects.filter((object) => !sameObject(object, objectState(current, object.id))).map((object) => object.id);

  return {
    get saved() {
      return copyArrangement(current);
    },
    get preview() {
      return copyArrangement(preview);
    },
    get uncertain() {
      return uncertain;
    },
    // Ids of objects whose preview differs from the saved arrangement.
    changedIds,
    isDirty: () => changedIds().length > 0,
    setPreview(id, transform) {
      preview = withObject(preview, id, transform);
    },
    revert() {
      preview = copyArrangement(current);
    },
    resetObject(id) {
      preview = withObject(preview, id, { offset: [0, 0, 0], yaw: 0 });
    },
    markUncertain() {
      uncertain = true;
    },
    saveRequest(targetId) {
      const target = objectState(preview, targetId);
      if (!attempt || attempt.targetId !== targetId || !sameObject(attempt.object, target) || attempt.baseVersion !== current.version) {
        attempt = { targetId, object: copyObject(target), baseVersion: current.version, requestId: newRequestId() };
      }
      return { requestId: attempt.requestId, baseVersion: attempt.baseVersion, targetId, offset: [...attempt.object.offset], yaw: attempt.object.yaw };
    },
    // Adopts a whole arrangement the server confirmed. Other objects' unsaved
    // previews, and a target changed since the request was sent, stay.
    confirm(edit) {
      const sent = attempt;
      const kept = preview.objects.filter((object) => {
        const before = objectState(current, object.id);
        const changed = !sameObject(object, before);
        if (!changed) return false;
        return !(sent && object.id === sent.targetId && sameObject(object, sent.object));
      });
      current = copyArrangement(edit);
      attempt = null;
      uncertain = false;
      preview = copyArrangement(current);
      for (const object of kept) preview = withObject(preview, object.id, object);
    },
    replaceSaved(edit) {
      current = copyArrangement(edit);
      attempt = null;
      uncertain = false;
      preview = copyArrangement(current);
    },
  };
}

// Text for people: each object is named "A: label" / "B: label" in build
// order, so nothing depends on colour or on reading the 3D view.
export function objectNames(objects) {
  const list = Array.isArray(objects) ? objects : [];
  return (id) => {
    const index = list.findIndex((object) => object.id === id);
    return index < 0 ? 'an object' : `${index === 0 ? 'A' : 'B'}: ${list[index].label}`;
  };
}

export const ruleText = (rule, nameOf) => (rule ? `${nameOf(rule.leftId)} stays left of ${nameOf(rule.rightId)} from the original photo` : 'No rule');

const placeText = ({ offset, yaw }) =>
  `left/right ${offset[0].toFixed(2)}, down/up ${offset[1].toFixed(2)}, away/toward ${offset[2].toFixed(2)}, turn ${Math.round((yaw * 180) / Math.PI)}°`;

// The whole arrangement in words: both objects and the rule.
export function describeArrangement(arrangement, nameOf) {
  const objects = (arrangement?.objects ?? []).map((object) => `${nameOf(object.id)} ${placeText(object)}`);
  return `${objects.join('; ')}; rule: ${ruleText(arrangement?.relationship ?? null, nameOf)}`;
}
