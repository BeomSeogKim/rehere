import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FRONT_MARGIN, PROJECTION_EPSILON, checkRelationship, objectCentre, projectedX } from '../public/scene-relations.js';

const rule = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const arrangement = () => ({ version: 1, objects: ['object-1', 'object-2'].map((id) => ({ id, offset: [0, 0, 0], yaw: 0 })), relationship: { ...rule } });

describe('relationship in the original photo frame', () => {
  it('uses perspective projection when world-X order would give the wrong answer', () => {
    const pivots = [{ id: 'object-1', pivot: [1, 0, -2] }, { id: 'object-2', pivot: [2, 0, -8] }];
    const before = arrangement();
    const result = checkRelationship(before, pivots);
    assert.deepEqual(result, { ok: false, reason: 'order', positions: { 'object-1': 0.5, 'object-2': 0.25 } });
    before.objects[0].offset = [-1, 0, 0];
    assert.equal(checkRelationship(before, pivots).ok, true);
    assert.deepEqual(pivots[0].pivot, [1, 0, -2]);
  });

  it('holds equality and the epsilon boundary instead of claiming a strict left order', () => {
    const state = arrangement();
    const pivots = [{ id: 'object-1', pivot: [0, 0, -1] }, { id: 'object-2', pivot: [0, 0, -1] }];
    assert.equal(checkRelationship(state, pivots).reason, 'order');
    pivots[1].pivot[0] = PROJECTION_EPSILON;
    assert.equal(checkRelationship(state, pivots).reason, 'order');
    pivots[1].pivot[0] = 2 * PROJECTION_EPSILON;
    assert.equal(checkRelationship(state, pivots).ok, true);
  });

  it('requires a usable original camera projection only when preserving a rule', () => {
    assert.equal(projectedX([0.1, 0, -FRONT_MARGIN]), 2);
    assert.equal(projectedX([0.1, 0, -FRONT_MARGIN + 0.000001]), null);
    assert.equal(projectedX([0, 0, 1]), null);
    const state = arrangement();
    const pivots = [{ id: 'object-1', pivot: [0, 0, 0] }, { id: 'object-2', pivot: [1, 0, -2] }];
    assert.equal(checkRelationship(state, pivots).reason, 'front');
    state.relationship = null;
    assert.deepEqual(checkRelationship(state, pivots), { ok: true, reason: null, positions: { 'object-1': null, 'object-2': 0.5 } });
  });

  it('does not change the centre when an object turns about its own pivot', () => {
    const state = arrangement();
    const pivots = [{ id: 'object-1', pivot: [-1, 1, -3] }, { id: 'object-2', pivot: [1, 1, -3] }];
    const before = checkRelationship(state, pivots);
    state.objects[0].yaw = Math.PI;
    assert.deepEqual(checkRelationship(state, pivots), before);
    state.objects[0].offset = [3, 0, 0];
    assert.equal(checkRelationship(state, pivots).reason, 'order');
    assert.deepEqual(objectCentre(pivots[0].pivot, state.objects[0]), [2, 1, -3]);
  });

  it('does not treat missing, duplicate or unknown object references as a valid rule', () => {
    const state = arrangement();
    const pivots = [{ id: 'object-1', pivot: [-1, 0, -3] }, { id: 'object-2', pivot: [1, 0, -3] }];
    assert.equal(checkRelationship(state, pivots.slice(0, 1)).reason, 'invalid');
    assert.equal(checkRelationship(state, [pivots[0], pivots[0]]).reason, 'invalid');
    for (const change of [{ leftId: 'missing' }, { rightId: 'object-1' }, { frame: 'world-x' }, { extra: true }]) {
      assert.equal(checkRelationship(state, pivots, { ...rule, ...change }).reason, 'invalid');
    }
    assert.equal(projectedX([Infinity, 0, -1]), null);
    assert.equal(objectCentre([0, 0, -1], { offset: [0, NaN, 0] }), null);
  });
});
