import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The memory, recollection and story panels inside a confirmed two-object
// scene: every body names the object it is about, and nothing is chosen for
// the person.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROPOSAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VOICE = '99999999-9999-4999-8999-999999999999';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const RULE = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const zero = (id) => ({ id, offset: [0, 0, 0], yaw: 0 });
const arrangement = (overrides = {}) => ({ version: 1, objects: [zero('object-1'), zero('object-2')], relationship: null, ...overrides });
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
// A 20 x 20 grid the real two-object builder accepts: region 0 is the
// background, 1 is object A (columns 2-6) and 2 is object B (columns 13-17),
// both on rows 6-13.
const GRID = 20;
const regions = Array.from({ length: GRID * GRID }, (_, i) => {
  const x = i % GRID;
  const y = Math.floor(i / GRID);
  return y >= 6 && y <= 13 ? (x >= 2 && x <= 6 ? 1 : x >= 13 && x <= 17 ? 2 : 0) : 0;
});
const surfaceObjects = [
  { id: 'object-1', label: 'Counter', box_xyxy: [0, 435, 226, 790] },
  { id: 'object-2', label: 'Flour stack', box_xyxy: [490, 450, 982, 781] },
];
const surface = {
  schema_version: 2,
  width: GRID,
  height: GRID,
  depth: Array(GRID * GRID).fill(3),
  regions,
  objects: surfaceObjects,
  assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  source: { image_size: [1000, 800] },
};

function faceAnchor(point) {
  return {
    id: PROPOSAL,
    requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    baseVersion: 1,
    targetId: 'object-2',
    statement: { id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', kind: 'human_memory', text: 'The flour faced the window.', sha256: 'a'.repeat(64), modelConsent: true },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    status: 'ready',
    result: { action: 'face_anchor', targetId: 'object-2', sourceId: PHOTO, baseVersion: 1, delta: null, yawDelta: null, anchor: { label: 'window', point }, question: null, reason: 'It faced the window.', transform: { offset: [0, 0, 0], yaw: 1 } },
    question: null,
    error: null,
    model: 'muse-spark-1.3',
    usage: null,
    responseId: null,
    appliedVersion: null,
  };
}

// A plan for object A that moves it right by 0.5.
function rotateA() {
  const base = faceAnchor([0.5, 0.1]);
  return { ...base, targetId: 'object-1', result: { ...base.result, action: 'translate', targetId: 'object-1', anchor: null, delta: [0.5, 0, 0], transform: { offset: [0.7, 0, 0], yaw: 0 } } };
}

let requests;
let routes;
let mountSpace;
let mounted;

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    const handler = routes[`${options.method ?? 'GET'} ${url}`];
    return handler ? handler(body) : Promise.resolve(json(200, []));
  };
  ({ mountSpace } = await import('../public/space.js'));
});

after(() => {
  delete globalThis.document;
  delete globalThis.fetch;
});

beforeEach(() => {
  requests = [];
  mounted = [];
  globalThis.viewerLog = [];
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

async function open() {
  const container = new FakeElement('section');
  const voice = { id: VOICE, kind: 'voice', provider: 'Jun', origin: { kind: 'self', reference: '' }, permissions: { place: true, model: false, share: true } };
  const draft = { id: DRAFT, photos: [{ name: 'photo-1.jpg', sourceId: PHOTO }], sources: [voice] };
  const granted = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true } };
  const space = mountSpace(container, { draft, sourceFor: () => granted });
  mounted.push(space);
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const posts = (suffix) => requests.filter((r) => r.method === 'POST' && r.url === `${JOB_URL}${suffix}`);
  button('Open scene').dispatch('click');
  await settle();
  return { container, find, button, posts, text: () => container.textContent };
}

describe('memory proposals on a two-object scene', () => {
  it('plans only for a chosen object and sends its targetId', async () => {
    const ui = await open();
    const memory = ui.find((node) => node.tag === 'section' && /Plan a change/.test(node.textContent))[0];
    const text = memory.findAll((node) => node.tag === 'textarea')[0];
    text.value = 'The flour stood by the window.';
    text.dispatch('input');
    const consent = memory.findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0];
    consent.checked = true;
    consent.dispatch('change');
    assert.equal(ui.button('Plan a change').disabled, true, 'no object chosen yet');
    assert.match(ui.text(), /Choose the object this memory is about before planning/);
    ui.button('B: Flour stack').dispatch('click');
    assert.equal(ui.button('Plan a change').disabled, false);
    routes[`POST ${JOB_URL}/proposals`] = () => Promise.resolve(json(202, { ...faceAnchor([0.1, 0.1]), status: 'queued', result: null }));
    ui.button('Plan a change').dispatch('click');
    await settle();
    const [sent] = ui.posts('/proposals');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseVersion: 1, text: 'The flour stood by the window.', consent: true, targetId: 'object-2' });
  });

  it('refuses to face a point on an object, and labels the plan with its own object', async () => {
    // Grid column 4, row 10: region 1, object A.
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [faceAnchor([4 / 19, 10 / 19])]));
    const ui = await open();
    ui.button('A: Counter').dispatch('click');
    assert.match(ui.text(), /Planned for B: Flour stack\./, 'the plan keeps its own object whatever is chosen');
    assert.match(ui.text(), /on one of the objects or on an area left unknown/);
    ui.button('Preview on the scene').dispatch('click');
    assert.equal(ui.button('Apply and save this proposal').disabled, true);
    assert.equal(ui.find((node) => node.tag === 'label' && /I checked the scene/.test(node.textContent)).length, 0, 'no direction to confirm');
  });

  it('keeps a plan bound to its own object when another object is chosen while it is planned', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const saved = arrangement({ objects: [{ id: 'object-1', offset: [0.2, 0, 0], yaw: 0 }, zero('object-2')] });
      routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: saved })));
      const queued = { ...rotateA(), status: 'queued', result: null };
      routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [queued]));
      routes[`GET ${JOB_URL}/proposals/${PROPOSAL}`] = () => Promise.resolve(json(200, queued));
      const ui = await open();
      ui.button('B: Flour stack').dispatch('click');
      assert.match(ui.text(), /Planned for A: Counter\./);
      routes[`GET ${JOB_URL}/proposals/${PROPOSAL}`] = () => Promise.resolve(json(200, rotateA()));
      mock.timers.tick(2000);
      await settle();
      assert.match(ui.text(), /Planned for A: Counter\./);
      assert.match(ui.text(), /Saved now \(version 1\): left\/right 0\.20/, 'compared with A, not the chosen B');
      // Give the viewport a size so the canvas badges have real positions.
      Object.assign(ui.find((node) => node.className === 'space-viewport')[0], { clientWidth: 400, clientHeight: 300 });
      ui.button('Original viewpoint').dispatch('click');
      const badge = (name) => ui.find((node) => node.className === 'object-badge' && node.textContent === name)[0]?.style.left;
      const [beforeA, beforeB] = [badge('A: Counter'), badge('B: Flour stack')];
      assert.match(`${beforeA} ${beforeB}`, /^[\d.]+px [\d.]+px$/, 'both badges are placed');
      ui.button('Preview on the scene').dispatch('click');
      assert.notEqual(badge('A: Counter'), beforeA, 'the preview moves A');
      assert.equal(badge('B: Flour stack'), beforeB, 'B is not moved');
      assert.match(ui.text(), /Shown now, a preview from the memory or recollection panel, not saved: From the original photo, A: Counter is left of B: Flour stack\./, 'the strip names the memory preview as what is drawn');
      assert.equal(ui.button('B: Flour stack').attributes['aria-pressed'], 'true');
    } finally {
      mock.timers.reset();
    }
  });

  it('lets a background point be checked and confirmed as usual', async () => {
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [faceAnchor([0.5, 0.1])]));
    const ui = await open();
    assert.doesNotMatch(ui.text(), /on one of the objects or on an area left unknown/);
    ui.button('Preview on the scene').dispatch('click');
    assert.doesNotMatch(ui.text(), /on one of the objects or on an area left unknown/);
  });

  it('shows the exact rule change before returning to a version with another rule, and sends it confirmed', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: arrangement({ version: 2, relationship: RULE }) })));
    routes[`GET ${JOB_URL}/history`] = () =>
      Promise.resolve(json(200, [
        { version: 1, kind: 'initial', targetId: null, blocked: false, ...arrangement() },
        { version: 2, kind: 'relationship', targetId: null, blocked: false, ...arrangement({ version: 2, relationship: RULE }) },
      ]));
    const ui = await open();
    assert.match(ui.text(), /A: Counter left\/right 0\.00.*; B: Flour stack left\/right 0\.00.*; rule: No rule/);
    ui.button('Return to version 1').dispatch('click');
    assert.equal(ui.posts('/undo').length, 0, 'nothing is sent before the rule change is confirmed');
    assert.match(ui.text(), /This also changes the rule from “A: Counter stays left of B: Flour stack from the original photo” to “No rule”\./);
    routes[`POST ${JOB_URL}/undo`] = () => Promise.resolve(json(200, arrangement({ version: 3 })));
    ui.button('Return to version 1 and change the rule').dispatch('click');
    await settle();
    const [sent] = ui.posts('/undo');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseVersion: 2, targetVersion: 1, ruleChangeConfirmed: true });
  });
});

describe('recollections on a two-object scene', () => {
  it('needs a chosen object and sends the candidate with its targetId', async () => {
    const entry = { id: CID, principalId: 'p', provider: { displayName: 'Mina' }, kind: 'human_recollection', text: 'The flour was further left.', textSha256: 'a'.repeat(64), permissions: { place: true, model: false, share: false }, periodClaim: null, createdAt: '2026-11-01T00:00:00.000Z', revision: 1, status: 'submitted', review: null, withdrawnAt: null };
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [entry], variants: [], blocked: false }));
    const ui = await open();
    ui.button('Review').dispatch('click');
    const decision = ui.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'alternative'))[0];
    decision.value = 'alternative';
    decision.dispatch('change');
    assert.match(ui.text(), /Choose the object this recollection is about first/);
    assert.equal(ui.button('Preview candidate on the scene').disabled, true);
    ui.button('B: Flour stack').dispatch('click');
    assert.match(ui.text(), /The candidate moves B: Flour stack; the other object stays as saved\./);
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Candidate Left / right')[0];
    x.value = '-0.4';
    x.dispatch('input');
    ui.button('Preview candidate on the scene').dispatch('click');
    assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'false');
    ui.button('A: Counter').dispatch('click');
    assert.equal(ui.button('B: Flour stack').attributes['aria-pressed'], 'true', 'the object cannot change while a candidate is shown');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(200, { contribution: { ...entry, status: 'alternative' } }));
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = ui.posts(`/contributions/${CID}/review`);
    assert.deepEqual(sent.body.transform, { targetId: 'object-2', offset: [-0.4, 0, 0], yaw: 0 });
  });
});

describe('recollection candidates per object', () => {
  const entry = { id: CID, principalId: 'p', provider: { displayName: 'Mina' }, kind: 'human_recollection', text: 'The flour was further left.', textSha256: 'a'.repeat(64), permissions: { place: true, model: false, share: false }, periodClaim: null, createdAt: '2026-11-01T00:00:00.000Z', revision: 1, status: 'submitted', review: null, withdrawnAt: null };
  const savedB = { id: 'object-2', offset: [0.6, 0.2, 0], yaw: 0.4 };
  async function review() {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: arrangement({ objects: [zero('object-1'), savedB] }) })));
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [entry], variants: [], blocked: false }));
    const ui = await open();
    ui.button('Review').dispatch('click');
    const decision = ui.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'alternative'))[0];
    decision.value = 'alternative';
    decision.dispatch('change');
    const field = (name) => ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === `Candidate ${name}`)[0];
    const values = () => ['Left / right', 'Down / up', 'Away / toward', 'Turn (degrees)'].map((name) => field(name).value);
    return { ui, field, values };
  }

  it('starts from the chosen object’s own saved position when the review opened before any choice', async () => {
    const { ui, field, values } = await review();
    assert.deepEqual(values(), ['', '', '', ''], 'no position before an object is chosen');
    assert.equal(field('Left / right').disabled, true);
    ui.button('B: Flour stack').dispatch('click');
    assert.deepEqual(values(), ['0.6', '0.2', '0', '23']);
    ui.button('Preview candidate on the scene').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(200, { contribution: { ...entry, status: 'alternative' } }));
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = ui.posts(`/contributions/${CID}/review`);
    assert.equal(sent.body.transform.targetId, 'object-2');
    assert.deepEqual(sent.body.transform.offset, [0.6, 0.2, 0]);
    assert.ok(Math.abs(sent.body.transform.yaw - (23 * Math.PI) / 180) < 1e-9);
  });

  it('keeps each object’s typed values apart when switching, and sends the chosen object’s own', async () => {
    const { ui, field, values } = await review();
    ui.button('A: Counter').dispatch('click');
    field('Left / right').value = '-0.4';
    field('Left / right').dispatch('input');
    ui.button('B: Flour stack').dispatch('click');
    assert.deepEqual(values(), ['0.6', '0.2', '0', '23'], 'B starts from its own saved state, not A’s values');
    field('Down / up').value = '0.5';
    field('Down / up').dispatch('input');
    ui.button('A: Counter').dispatch('click');
    assert.deepEqual(values(), ['-0.4', '0', '0', '0'], 'A’s typed values are kept, not reset');
    ui.button('Preview candidate on the scene').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(200, { contribution: { ...entry, status: 'alternative' } }));
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = ui.posts(`/contributions/${CID}/review`);
    assert.deepEqual(sent.body.transform, { targetId: 'object-1', offset: [-0.4, 0, 0], yaw: 0 });
  });
});

describe('the relation strip describes what is drawn', () => {
  const SAVED_ORDER = 'From the original photo, A: Counter is left of B: Flour stack.';
  const CROSSED = 'From the original photo, B: Flour stack is left of A: Counter.';
  const strip = (ui) => ui.find((node) => node.className === 'relation-strip')[0].textContent;

  it('names a recollection candidate as what is shown, and the saved order once it stops', async () => {
    const entry = { id: CID, principalId: 'p', provider: { displayName: 'Mina' }, kind: 'human_recollection', text: 'The flour was on the left.', textSha256: 'a'.repeat(64), permissions: { place: true, model: false, share: false }, periodClaim: null, createdAt: '2026-11-01T00:00:00.000Z', revision: 1, status: 'submitted', review: null, withdrawnAt: null };
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [entry], variants: [], blocked: false }));
    const ui = await open();
    ui.button('Review').dispatch('click');
    const decision = ui.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'alternative'))[0];
    decision.value = 'alternative';
    decision.dispatch('change');
    ui.button('B: Flour stack').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Candidate Left / right')[0];
    x.value = '-1.5';
    x.dispatch('input');
    ui.button('Preview candidate on the scene').dispatch('click');
    assert.ok(strip(ui).includes(`Saved: ${SAVED_ORDER}`));
    assert.ok(strip(ui).includes(`Shown now, a preview from the memory or recollection panel, not saved: ${CROSSED}`));
    assert.doesNotMatch(strip(ui), /same as saved/);
    decision.value = 'hold';
    decision.dispatch('change');
    assert.ok(strip(ui).includes(`Shown now, the saved arrangement: ${SAVED_ORDER}`));
  });

  it('follows Show saved and Show your preview for an unsaved change that crosses the order', async () => {
    const ui = await open();
    ui.button('A: Counter').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '1.5';
    x.dispatch('input');
    assert.ok(strip(ui).includes(`Shown now, your unsaved change: ${CROSSED}`));
    ui.button('Show saved arrangement').dispatch('click');
    assert.ok(strip(ui).includes(`Shown now, the saved arrangement: ${SAVED_ORDER}`));
    assert.ok(strip(ui).includes(`Your unsaved change (not shown): ${CROSSED}`));
    ui.button('Show your preview').dispatch('click');
    assert.ok(strip(ui).includes(`Shown now, your unsaved change: ${CROSSED}`));
    assert.doesNotMatch(strip(ui), /not shown/);
  });
});

describe('stories on a two-object scene', () => {
  it('asks which object the story is about, with nothing chosen, and sends its targetId', async () => {
    const ui = await open();
    const story = ui.find((node) => node.tag === 'section' && /Recorded stories/.test(node.textContent))[0];
    const selects = story.findAll((node) => node.tag === 'select');
    const target = selects.find((node) => node.children.some((option) => option.value === 'object-1'));
    assert.equal(target.value, '', 'no object is chosen for the person');
    const view = selects.find((node) => node.children.some((option) => option.textContent === 'Choose a saved view'));
    view.value = view.children[1].value;
    story.findAll((node) => node.tag === 'input' && node.type === 'text')[0].value = 'By the window';
    const [start, end] = story.findAll((node) => node.tag === 'input' && node.inputMode === 'decimal');
    start.value = '0:00';
    end.value = '0:02';
    story.findAll((node) => node.tag === 'textarea')[0].value = 'Hello.';
    const confirm = story.findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0];
    confirm.checked = true;
    ui.button('Save story').dispatch('click');
    assert.match(ui.text(), /Choose the object this story is about\./);
    assert.equal(ui.posts('/stories').length, 0);
    target.value = 'object-2';
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, { id: 's1' }));
    ui.button('Save story').dispatch('click');
    await settle();
    const [sent] = ui.posts('/stories');
    assert.equal(sent.body.targetId, 'object-2');
  });
});

describe('a blocked two-object scene', () => {
  it('names both objects in each restorable version and says when a restore changes the rule', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ usageBlocked: true, edit: arrangement({ version: 3 }) })));
    routes[`GET ${JOB_URL}/history`] = () =>
      Promise.resolve(json(200, [
        { version: 1, kind: 'initial', targetId: null, blocked: false, ...arrangement() },
        { version: 2, kind: 'relationship', targetId: null, blocked: false, ...arrangement({ version: 2, relationship: RULE }) },
        { version: 3, kind: 'review', targetId: 'object-2', blocked: true, ...arrangement({ version: 3 }) },
      ]));
    const ui = await open();
    assert.match(ui.text(), /Version 1: A: Counter left\/right 0\.00.*rule: No rule/);
    assert.ok(ui.button('Restore version 1'));
    const restore = ui.button('Restore version 2 and change the rule to “A: Counter stays left of B: Flour stack from the original photo”');
    routes[`POST ${JOB_URL}/undo`] = () => Promise.resolve(json(200, arrangement({ version: 4, relationship: RULE })));
    restore.dispatch('click');
    await settle();
    const [sent] = ui.posts('/undo');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseVersion: 3, targetVersion: 2, ruleChangeConfirmed: true });
  });
});
