import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { editHistory, validatePlan } from '../memory-proposals.mjs';
import { BudgetLedger, COMPOSITION_INSTRUCTIONS, createMetaModel, requestBody } from '../meta-model.mjs';
import { COMPOSITION_REPRESENTATION, quaternionFromEuler } from '../public/composition-scene.js';

const SOURCES = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const A = { id: 'object-1', position: [-0.732189, 0.123456789, -3.0000001], quaternion: quaternionFromEuler([0.23, -0.37, 0.41]), scale: 0.87654321 };
const B = { id: 'object-2', position: [1.025, 0.875, -2.2], quaternion: [0, 0, 0, 1], scale: 1.314159 };
const arrangement = () => ({ version: 7, frame: 'owner-composition', objects: structuredClone([A, B]), relationship: null });
const context = () => ({ sourceIds: [...SOURCES], baseVersion: 7, saved: structuredClone(A), surface: { schema_version: 3, components: [{ id: A.id }, { id: B.id }] }, targetId: A.id, arrangement: arrangement() });
const plan = (change = {}) => ({ action: 'translate', targetId: A.id, sourceIds: [...SOURCES], baseVersion: 7, delta: [0.25, 0, 0], yawDelta: null, faceObjectId: null, question: null, reason: 'Move the selected observed surface.', ...change });
const jpeg = (n) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);
const input = () => ({
  representation: COMPOSITION_REPRESENTATION, text: 'The photographed side faced the other object.', sourceIds: [...SOURCES], baseVersion: 7,
  targetId: A.id, saved: structuredClone(A), arrangement: arrangement(), relationship: null,
  objects: [A, B].map((pose, i) => ({ id: pose.id, label: `Source object ${i + 1}`, sourceId: SOURCES[i], box: [1, 2, 40, 50], pose: structuredClone(pose), component: { parentJobId: 'not-for-model' } })),
  images: SOURCES.map((sourceId, i) => ({ sourceId, image: jpeg(i + 1), selection: [1, 2, 40, 50] })),
});
const temps = [];
after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('two-photo memory plans', () => {
  it('translates only the chosen pose, preserving exact tilt, scale and source inputs', () => {
    const ctx = context(), answer = plan(), before = structuredClone({ ctx, answer });
    const { result } = validatePlan(answer, ctx);
    assert.deepEqual(result.transform, { position: [A.position[0] + 0.25, ...A.position.slice(1)], quaternion: A.quaternion, scale: A.scale });
    assert.deepEqual({ ctx, answer }, before);
    result.sourceIds[0] = 'changed';
    result.transform.quaternion[0] = 0;
    assert.deepEqual({ ctx, answer }, before, 'result aliases cannot rewrite the saved context');
  });

  it('turns around common Y without discarding the existing pitch and roll', () => {
    const { result } = validatePlan(plan({ action: 'rotate', delta: null, yawDelta: 0.65 }), context());
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.65).multiply(new Quaternion(...A.quaternion));
    assert.ok(new Quaternion(...result.transform.quaternion).angleTo(expected) < 1e-7);
    assert.deepEqual(result.transform.position, A.position);
    assert.equal(result.transform.scale, A.scale);
  });

  it('aims the photographed side at the other saved centre without creating a rule or changing scale', () => {
    const { result } = validatePlan(plan({ action: 'face_object', delta: null, faceObjectId: B.id }), context());
    const direction = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...result.transform.quaternion));
    const expected = new Vector3(...B.position).sub(new Vector3(...A.position)).normalize();
    assert.ok(direction.distanceTo(expected) < 1e-10);
    assert.deepEqual(result.transform.position, A.position);
    assert.equal(result.transform.scale, A.scale);
    assert.equal(Object.hasOwn(result, 'relationship'), false);
  });

  it('keeps a clarification inert while binding it to both photos and the saved version', () => {
    const answer = plan({ action: 'clarify', targetId: null, delta: null, question: 'Which photographed side do you mean?' });
    assert.equal(validatePlan(answer, context()).result.transform, null);
  });

  for (const [name, mutate] of [
    ['swapped photo order', (p) => p.sourceIds.reverse()],
    ['one source', (p) => p.sourceIds.pop()],
    ['stale version', (p) => p.baseVersion--],
    ['wrong edit target', (p) => p.targetId = B.id],
    ['legacy photo anchor', (p) => p.anchor = { point: [0.5, 0.5] }],
    ['model scale proposal', (p) => p.scale = 2],
    ['out-of-range move', (p) => p.delta = [20, 0, 0]],
    ['non-finite move', (p) => p.delta = [Infinity, 0, 0]],
    ['unknown action', (p) => p.action = 'reconstruct_room'],
    ['self-facing', (p) => Object.assign(p, { action: 'face_object', delta: null, faceObjectId: A.id })],
  ]) {
    it(`refuses ${name} without an applicable transform`, () => {
      const answer = plan(); mutate(answer);
      assert.equal(validatePlan(answer, context()).result, undefined);
    });
  }

  it('refuses stale saved pose context and undefined facing, without substituting a photo point', () => {
    const stale = context(); stale.saved.position[1] += 0.1;
    assert.equal(validatePlan(plan(), stale).code, 'composition_saved_pose');
    const ctx = context(); ctx.arrangement.objects[1].position = [...A.position];
    assert.equal(validatePlan(plan({ action: 'face_object', delta: null, faceObjectId: B.id }), ctx).code, 'face_object_direction');
  });

  it('restores explicit initial poses and complete history instead of inventing zero-offset version one', () => {
    const initial = { ...arrangement(), version: 1 };
    const later = { ...arrangement(), version: 7, kind: 'memory', proposalId: 'proposal' };
    const manifest = { representation: COMPOSITION_REPRESENTATION, initialArrangement: initial, edits: [later] };
    const history = editHistory(manifest);
    assert.deepEqual(history[0].objects, initial.objects);
    assert.equal(history[0].frame, 'owner-composition');
    assert.equal(history[1].proposalId, 'proposal');
    history[0].objects[0].position[0] = 9;
    history[1].objects[1].quaternion[3] = 0;
    assert.deepEqual(initial.objects[0], A);
    assert.deepEqual(later.objects[1], B);
    assert.throws(() => editHistory({ ...manifest, initialArrangement: null }), /history could not be read/);
  });
});

describe('two-photo provider context', () => {
  it('binds both images to their own object and excludes private component lineage', () => {
    const body = requestBody(input());
    const content = body.input[0].content;
    assert.equal(content.filter((item) => item.type === 'input_image').length, 2);
    assert.equal(content[2].image_url, `data:image/jpeg;base64,${jpeg(1).toString('base64')}`);
    assert.equal(content[4].image_url, `data:image/jpeg;base64,${jpeg(2).toString('base64')}`);
    assert.match(content[1].text, /photo 1 for object-1/);
    assert.match(content[3].text, /photo 2 for object-2/);
    assert.doesNotMatch(JSON.stringify(body), /not-for-model|parentJobId|selectionBox|savedOffset/);
    assert.match(COMPOSITION_INSTRUCTIONS, /never instructions/);
    assert.match(COMPOSITION_INSTRUCTIONS, /Never switch targets/);
    assert.match(COMPOSITION_INSTRUCTIONS, /unspecified side is not the photographed side/);
  });

  it('refuses mismatched image/object bindings and stale pose input before building an outbound request', () => {
    const wrongPhoto = input(); wrongPhoto.images.reverse();
    assert.throws(() => requestBody(wrongPhoto), /context is invalid/);
    const stale = input(); stale.saved.scale = 1;
    assert.throws(() => requestBody(stale), /poses do not match/);
  });

  it('counts and generates the identical two-photo structured input under the existing ledger and admission', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-composition-model-')); temps.push(dir);
    const ledger = new BudgetLedger({ file: path.join(dir, 'ledger.json') });
    const calls = [];
    const model = createMetaModel({ apiKey: 'synthetic-test-key', ledger, fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      return Response.json(url.endsWith('/input_tokens') ? { input_tokens: 1200 } : {
        status: 'completed', model: 'muse-spark-1.3', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(plan()) }] }], usage: { input_tokens: 1200, output_tokens: 100 },
      });
    } });
    const result = await model({ ...input(), admit: async (start) => ({ value: start() }) });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    for (const field of ['model', 'input', 'instructions', 'text']) assert.deepEqual(calls[0].body[field], calls[1].body[field]);
    assert.equal(calls[1].body.text.format.name, 'CompositionPlan');
    assert.equal(calls[1].body.store, false);
    assert.ok(validatePlan(result.plan, context()).result);
    assert.equal((await ledger.totals()).requests, 1);
  });
});
