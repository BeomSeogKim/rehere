import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createArrangementSession, objectState, withObject } from '../public/arrangement.js';

const RULE = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const saved = {
  version: 3,
  objects: [
    { id: 'object-1', offset: [0, 0, 0], yaw: 0 },
    { id: 'object-2', offset: [0.5, 0, 0], yaw: 0.2 },
  ],
  relationship: RULE,
};
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('arrangement helpers', () => {
  it('replaces one object only and keeps the rule', () => {
    const next = withObject(saved, 'object-1', { offset: [0.3, 0, 0], yaw: 1 });
    assert.deepEqual(objectState(next, 'object-1'), { id: 'object-1', offset: [0.3, 0, 0], yaw: 1 });
    assert.deepEqual(objectState(next, 'object-2'), saved.objects[1]);
    assert.deepEqual(next.relationship, RULE);
    assert.deepEqual(saved.objects[0].offset, [0, 0, 0], 'the input is not changed');
  });
});

describe('arrangement session', () => {
  it('previews one object, saves only that target, and reuses the request after an unclear outcome', () => {
    const session = createArrangementSession(saved, ids());
    session.setPreview('object-1', { offset: [0.3, 0, 0], yaw: 0 });
    assert.deepEqual(session.changedIds(), ['object-1']);
    const first = session.saveRequest('object-1');
    assert.deepEqual(first, { requestId: 'id-1', baseVersion: 3, targetId: 'object-1', offset: [0.3, 0, 0], yaw: 0 });
    session.markUncertain();
    assert.deepEqual(session.saveRequest('object-1'), first);
    session.setPreview('object-1', { offset: [0.4, 0, 0], yaw: 0 });
    assert.equal(session.saveRequest('object-1').requestId, 'id-2');
  });

  it('adopts the server’s whole arrangement and keeps a change made while the save ran', () => {
    const session = createArrangementSession(saved, ids());
    session.setPreview('object-1', { offset: [0.3, 0, 0], yaw: 0 });
    session.saveRequest('object-1');
    session.setPreview('object-1', { offset: [0.6, 0, 0], yaw: 0 });
    const server = { version: 4, objects: [{ id: 'object-1', offset: [0.3, 0, 0], yaw: 0 }, saved.objects[1]], relationship: RULE };
    session.confirm(server);
    assert.equal(session.saved.version, 4);
    assert.deepEqual(objectState(session.saved, 'object-1').offset, [0.3, 0, 0]);
    assert.deepEqual(objectState(session.preview, 'object-1').offset, [0.6, 0, 0], 'the newer preview stays');
    assert.equal(session.uncertain, false);
  });

  it('settles uncertainty only on a confirmed save or a reload, and reload replaces every preview', () => {
    const session = createArrangementSession(saved, ids());
    session.setPreview('object-2', { offset: [1, 0, 0], yaw: 0 });
    session.markUncertain();
    session.revert();
    assert.equal(session.uncertain, true);
    session.replaceSaved({ ...saved, version: 5, relationship: null });
    assert.equal(session.uncertain, false);
    assert.equal(session.isDirty(), false);
    assert.equal(session.saved.relationship, null);
  });

  it('resets one object to the photo position as a preview only', () => {
    const session = createArrangementSession(saved, ids());
    session.resetObject('object-2');
    assert.deepEqual(objectState(session.preview, 'object-2'), { id: 'object-2', offset: [0, 0, 0], yaw: 0 });
    assert.deepEqual(objectState(session.saved, 'object-2'), saved.objects[1]);
  });
});
