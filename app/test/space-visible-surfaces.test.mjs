import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The photographed-surface gate as mounted in a confirmed two-object scene:
// the real shared helper, Three.js and three-mesh-bvh check what the manual
// editor, a memory proposal, a return to a version, a rule change and a
// recollection decision would save, before anything is sent.
installViewerShim();

// space.js loads the helper as './visible-surfaces.js'. Only that import is
// wrapped, to count calls, time them and inject faults; the wrapped functions
// are the real ones. The wrapper waits for globalThis.surfaceHold once, on its
// first evaluation, which the first test uses to hold preparation.
const HELPER = new URL('../public/visible-surfaces.js', import.meta.url).href;
const wrapper = `
import * as real from '${HELPER}';
await globalThis.surfaceHold;
const calls = () => globalThis.surfaceCalls;
export const visibleSurfaceProblem = real.visibleSurfaceProblem;
export function prepareVisibleGeometry(...args) {
  calls().prepare += 1;
  if (globalThis.surfaceFail === 'prepare') throw new Error('prepare fault');
  const start = performance.now();
  const prepared = real.prepareVisibleGeometry(...args);
  calls().prepareMs.push(performance.now() - start);
  return prepared;
}
export function checkVisibleArrangement(prepared, arrangement, ...rest) {
  if (globalThis.surfaceFail === 'check') throw new Error('check fault');
  const start = performance.now();
  const result = real.checkVisibleArrangement(prepared, arrangement, ...rest);
  calls().checks.push({ objects: arrangement.objects, status: result.status, ms: performance.now() - start });
  return result;
}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './visible-surfaces.js' && context.parentURL?.endsWith('/public/space.js')) {
      return { url: `data:text/javascript,${encodeURIComponent(wrapper)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const DRAFT = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROPOSAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
// Preparation loads modules and builds the acceleration structure in the
// background; this waits for it, bounded.
const prepared = async () => {
  for (let i = 0; i < 200 && globalThis.surfaceCalls.prepareMs.length === 0 && !globalThis.surfaceFail; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
};

const zero = (id) => ({ id, offset: [0, 0, 0], yaw: 0 });
const arrangement = (overrides = {}) => ({ version: 1, objects: [zero('object-1'), zero('object-2')], relationship: null, ...overrides });
// Both photographed surfaces lie on one plane 3 units away, A on grid
// columns 2-6 and B on 13-17 (one column is about 0.164 units). A moved right
// by 1.4 lies over B on that plane: a positive-area overlap. Moved by 0.7 its
// right edge stays left of B. Moved by 1.4 and 0.5 toward the camera, it is in
// front of B, not in it.
const OVERLAP = { id: 'object-1', offset: [1.4, 0, 0], yaw: 0 };
const NEAR = { id: 'object-1', offset: [0.7, 0, 0], yaw: 0 };
const IN_FRONT = { id: 'object-1', offset: [1.4, 0, 0.5], yaw: 0 };
const job = (overrides = {}) => ({
  id: JOB,
  draftId: DRAFT,
  sourceId: PHOTO,
  status: 'ready',
  createdAt: '2026-11-01T00:00:00.000Z',
  error: null,
  usageBlocked: false,
  blockedReason: null,
  objectsConfirmed: true,
  objects: [
    { id: 'object-1', label: 'Counter', box: [0, 435, 226, 790], pivot: [-0.5, 0, -3] },
    { id: 'object-2', label: 'Flour stack', box: [490, 450, 982, 781], pivot: [0.5, 0, -3] },
  ],
  edit: arrangement(),
  ...overrides,
});
const GRID = 20;
const regions = Array.from({ length: GRID * GRID }, (_, i) => {
  const x = i % GRID;
  const y = Math.floor(i / GRID);
  return y >= 6 && y <= 13 ? (x >= 2 && x <= 6 ? 1 : x >= 13 && x <= 17 ? 2 : 0) : 0;
});
const surface = {
  schema_version: 2,
  width: GRID,
  height: GRID,
  depth: Array(GRID * GRID).fill(3),
  regions,
  objects: [
    { id: 'object-1', label: 'Counter', box_xyxy: [0, 435, 226, 790] },
    { id: 'object-2', label: 'Flour stack', box_xyxy: [490, 450, 982, 781] },
  ],
  assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  source: { image_size: [1000, 800] },
};

function proposal(transform) {
  return {
    id: PROPOSAL,
    requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    baseVersion: 1,
    targetId: 'object-1',
    statement: { id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', kind: 'human_memory', text: 'The counter stood further right.', sha256: 'a'.repeat(64), modelConsent: true },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    status: 'ready',
    result: { action: 'translate', targetId: 'object-1', sourceId: PHOTO, baseVersion: 1, delta: [transform.offset[0], 0, 0], yawDelta: null, anchor: null, question: null, reason: 'It stood further right.', transform },
    question: null,
    error: null,
    model: 'muse-spark-1.3',
    usage: null,
    responseId: null,
    appliedVersion: null,
  };
}
const recollection = { id: CID, principalId: 'p', provider: { displayName: 'Mina' }, kind: 'human_recollection', text: 'The counter was further right.', textSha256: 'a'.repeat(64), permissions: { place: true, model: false, share: false }, periodClaim: null, createdAt: '2026-11-01T00:00:00.000Z', revision: 1, status: 'submitted', review: null, withdrawnAt: null };

let requests;
let routes;
let mountSpace;
let SURFACE_PENDING;
let SURFACE_FAILED;
let SURFACE_SCOPE;
let problemText;
let mounted;
let release;

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    const handler = routes[`${options.method ?? 'GET'} ${url}`];
    return handler ? handler(body) : Promise.resolve(json(200, []));
  };
  globalThis.surfaceHold = new Promise((resolve) => (release = resolve));
  ({ mountSpace, SURFACE_PENDING, SURFACE_FAILED, SURFACE_SCOPE } = await import('../public/space.js'));
  ({ visibleSurfaceProblem: problemText } = await import('../public/visible-surfaces.js'));
});

after(() => {
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.surfaceHold;
  delete globalThis.surfaceCalls;
  delete globalThis.surfaceFail;
});

beforeEach(() => {
  requests = [];
  mounted = [];
  globalThis.viewerLog = [];
  globalThis.surfaceCalls = { prepare: 0, prepareMs: [], checks: [] };
  delete globalThis.surfaceFail;
  routes = {
    [`GET ${BASE}`]: () => Promise.resolve(json(200, [job()])),
    [`GET ${JOB_URL}`]: () => Promise.resolve(json(200, job())),
    [`GET ${JOB_URL}/assets/surface.json`]: () => Promise.resolve(json(200, surface)),
    [`GET ${JOB_URL}/collaboration`]: () => Promise.resolve(json(200, { contributions: [], variants: [], blocked: false })),
    [`GET ${JOB_URL}/stories`]: () => Promise.resolve(json(200, { stories: [] })),
    [`GET ${JOB_URL}/history`]: () => Promise.resolve(json(200, [{ version: 1, kind: 'initial', targetId: null, blocked: false, ...arrangement() }])),
  };
});

afterEach(() => {
  for (const space of mounted.splice(0)) space.dispose();
});

async function open({ wait = true } = {}) {
  const container = new FakeElement('section');
  const draft = { id: DRAFT, photos: [{ name: 'photo-1.jpg', sourceId: PHOTO }], sources: [] };
  const granted = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true } };
  const space = mountSpace(container, { draft, sourceFor: () => granted });
  mounted.push(space);
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const field = (label) => find((node) => node.tag === 'input' && node.attributes['aria-label'] === label)[0];
  const posts = (suffix) => requests.filter((r) => r.method === 'POST' && r.url === `${JOB_URL}${suffix}`);
  const type = (label, value) => {
    const node = field(label);
    node.value = value;
    node.dispatch('input');
  };
  button('Open scene').dispatch('click');
  await settle();
  if (wait) await prepared();
  return { space, container, find, button, field, posts, type, text: () => container.textContent };
}

const intersects = () => problemText({ status: 'intersects', reason: 'overlap', scope: 'named-visible-surfaces' });
const unresolved = () => problemText({ status: 'unresolved', reason: 'error', scope: 'named-visible-surfaces' });

describe('photographed-surface gate in the two-object editor', () => {
  // Must run first: the wrapper holds on its first evaluation only.
  it('holds a save while the check is prepared, and drops a preparation that finishes after the scene closed', async () => {
    const first = await open({ wait: false });
    first.button('A: Counter').dispatch('click');
    first.type('Left / right', '0.3');
    first.button('Apply and save').dispatch('click');
    await settle();
    assert.equal(first.posts('/edit').length, 0, 'nothing is sent while the check is not ready');
    assert.ok(first.text().includes(`${SURFACE_PENDING} The saved arrangement is still version 1; your preview is kept.`));
    assert.equal(first.field('Left / right').value, '0.3', 'the preview stays');
    first.space.dispose();
    release();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(globalThis.surfaceCalls.prepare, 0, 'a closed scene prepares nothing');

    routes[`POST ${JOB_URL}/edit`] = () => Promise.resolve(json(200, arrangement({ version: 2, objects: [{ id: 'object-1', offset: [0.3, 0, 0], yaw: 0 }, zero('object-2')] })));
    const second = await open();
    assert.equal(globalThis.surfaceCalls.prepare, 1);
    second.button('A: Counter').dispatch('click');
    second.type('Left / right', '0.3');
    second.button('Apply and save').dispatch('click');
    await settle();
    assert.equal(second.posts('/edit').length, 1);
    assert.equal(globalThis.surfaceCalls.checks.at(-1).status, 'clear');
  });

  it('checks the manual preview once at save, never per slider input, and keeps an overlapping preview unsaved', async (t) => {
    const ui = await open();
    assert.ok(ui.text().includes(SURFACE_SCOPE));
    ui.button('A: Counter').dispatch('click');
    for (let step = 0; step <= 14; step += 1) ui.type('Left / right slider', String(step / 10));
    assert.equal(globalThis.surfaceCalls.prepare, 1, 'prepared once for the loaded surface');
    assert.equal(globalThis.surfaceCalls.checks.length, 0, 'slider input checks nothing');
    ui.button('Apply and save').dispatch('click');
    ui.button('Apply and save').dispatch('click');
    await settle();
    assert.equal(ui.posts('/edit').length, 0);
    assert.deepEqual(globalThis.surfaceCalls.checks.map((c) => c.status), ['intersects'], 'the same arrangement is checked once');
    assert.ok(ui.text().includes(`${intersects()} The saved arrangement is still version 1; your preview is kept.`));
    assert.equal(ui.field('Left / right').value, '1.4');
    assert.match(ui.text(), /Preview only: A: Counter moved\. Not saved yet; the saved arrangement is version 1\./);
    assert.doesNotMatch(ui.text(), /collision-free/i);

    routes[`POST ${JOB_URL}/edit`] = () => Promise.resolve(json(200, arrangement({ version: 2, objects: [IN_FRONT, zero('object-2')] })));
    ui.type('Away / toward', '0.5');
    ui.button('Apply and save').dispatch('click');
    await settle();
    assert.deepEqual(globalThis.surfaceCalls.checks.map((c) => c.status), ['intersects', 'clear']);
    const [sent] = ui.posts('/edit');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseVersion: 1, targetId: 'object-1', offset: IN_FRONT.offset, yaw: 0 }, 'the checked arrangement is the one sent');
    assert.deepEqual(globalThis.surfaceCalls.checks.at(-1).objects, [IN_FRONT, zero('object-2')]);
    t.diagnostic(`prepare ${globalThis.surfaceCalls.prepareMs.map((ms) => ms.toFixed(2)).join(', ')} ms; checks ${globalThis.surfaceCalls.checks.map((c) => c.ms.toFixed(2)).join(', ')} ms`);
  });

  it('holds a rule change when the saved arrangement overlaps', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: arrangement({ objects: [OVERLAP, zero('object-2')] }) })));
    const ui = await open();
    // Moved right, A's centre is right of B's, so only this rule holds.
    const order = ui.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'object-2|object-1'))[0];
    order.value = 'object-2|object-1';
    order.dispatch('change');
    const confirm = ui.find((node) => node.tag === 'label' && /I want to change the rule/.test(node.textContent))[0].children.find((node) => node.tag === 'input');
    confirm.checked = true;
    confirm.dispatch('change');
    ui.button('Save this rule').dispatch('click');
    await settle();
    assert.equal(ui.posts('/relationship').length, 0);
    assert.ok(ui.text().includes(`${intersects()} The rule and the saved arrangement (version 1) are unchanged.`));
  });

  it('holds an overlapping memory proposal with its preview kept, and applies a clear one', async () => {
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [proposal({ offset: OVERLAP.offset, yaw: 0 })]));
    const ui = await open();
    ui.button('Preview on the scene').dispatch('click');
    ui.button('Apply and save this proposal').dispatch('click');
    await settle();
    assert.equal(ui.posts(`/proposals/${PROPOSAL}/apply`).length, 0);
    assert.ok(ui.text().includes(`${intersects()} The saved arrangement is still version 1; the proposal is kept.`));
    assert.ok(ui.button('Stop preview'), 'the proposal is still previewed');
    assert.deepEqual(globalThis.surfaceCalls.checks.at(-1).objects, [OVERLAP, zero('object-2')], 'the proposal replaces only its own object');
  });

  it('applies a memory proposal whose surfaces stay apart', async () => {
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [proposal({ offset: NEAR.offset, yaw: 0 })]));
    routes[`POST ${JOB_URL}/proposals/${PROPOSAL}/apply`] = () => Promise.resolve(json(200, { edit: arrangement({ version: 2, objects: [NEAR, zero('object-2')] }), proposal: { ...proposal({ offset: NEAR.offset, yaw: 0 }), status: 'applied', appliedVersion: 2 } }));
    const ui = await open();
    ui.button('Preview on the scene').dispatch('click');
    ui.button('Apply and save this proposal').dispatch('click');
    await settle();
    assert.equal(ui.posts(`/proposals/${PROPOSAL}/apply`).length, 1);
    assert.equal(globalThis.surfaceCalls.checks.at(-1).status, 'clear');
  });

  it('holds a return to a saved version whose surfaces overlap', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: arrangement({ version: 2 }) })));
    routes[`GET ${JOB_URL}/history`] = () =>
      Promise.resolve(json(200, [
        { version: 1, kind: 'initial', targetId: null, blocked: false, ...arrangement({ objects: [OVERLAP, zero('object-2')] }) },
        { version: 2, kind: 'manual', targetId: 'object-1', blocked: false, ...arrangement({ version: 2 }) },
      ]));
    const ui = await open();
    ui.button('Return to version 1').dispatch('click');
    await settle();
    assert.equal(ui.posts('/undo').length, 0);
    assert.ok(ui.text().includes(`${intersects()} The saved arrangement is still version 2; version 1 stays in the history.`));
    assert.ok(ui.button('Return to version 1'), 'the version is still offered');
  });

  for (const decision of ['adopt', 'alternative']) {
    it(`holds an overlapping recollection candidate for ${decision}, keeping the candidate and the form`, async () => {
      routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [recollection], variants: [], blocked: false }));
      const ui = await open();
      ui.button('Review').dispatch('click');
      const select = ui.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'alternative'))[0];
      select.value = decision;
      select.dispatch('change');
      ui.button('A: Counter').dispatch('click');
      ui.type('Candidate Left / right', '1.4');
      ui.button('Preview candidate on the scene').dispatch('click');
      ui.button('Save decision').dispatch('click');
      await settle();
      assert.equal(ui.posts(`/contributions/${CID}/review`).length, 0);
      assert.ok(ui.text().includes(`${intersects()} The saved scene is still version 1; your candidate and decision are kept.`));
      assert.equal(ui.field('Candidate Left / right').value, '1.4');
      assert.equal(select.value, decision);

      routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(200, { contribution: { ...recollection, status: decision === 'adopt' ? 'adopted' : 'alternative' }, ...(decision === 'adopt' ? { edit: arrangement({ version: 2, objects: [IN_FRONT, zero('object-2')] }) } : {}) }));
      ui.type('Candidate Away / toward', '0.5');
      ui.button('Preview candidate on the scene').dispatch('click');
      ui.button('Save decision').dispatch('click');
      await settle();
      const [sent] = ui.posts(`/contributions/${CID}/review`);
      assert.deepEqual(sent.body.transform, { targetId: 'object-1', offset: IN_FRONT.offset, yaw: 0 });
      assert.deepEqual(globalThis.surfaceCalls.checks.map((c) => c.status), ['intersects', 'clear']);
    });
  }

  it('holds every save when preparation fails, and an unfinished check holds as unresolved', async () => {
    globalThis.surfaceFail = 'prepare';
    const failed = await open();
    failed.button('A: Counter').dispatch('click');
    failed.type('Left / right', '0.3');
    failed.button('Apply and save').dispatch('click');
    await settle();
    assert.equal(failed.posts('/edit').length, 0);
    assert.ok(failed.text().includes(`${SURFACE_FAILED} The saved arrangement is still version 1; your preview is kept.`));
    failed.space.dispose();

    delete globalThis.surfaceFail;
    const ui = await open();
    globalThis.surfaceFail = 'check';
    ui.button('A: Counter').dispatch('click');
    ui.type('Left / right', '0.3');
    ui.button('Apply and save').dispatch('click');
    await settle();
    assert.equal(ui.posts('/edit').length, 0);
    assert.ok(ui.text().includes(`${unresolved()} The saved arrangement is still version 1; your preview is kept.`));
  });
});
