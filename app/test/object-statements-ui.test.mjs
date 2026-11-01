import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// From a selected object's sources, deliberate jumps to that object's saved
// proposals, recollections and stories in the panels that already list them,
// mounted in the real space.js scene: fresh reads first, honest failures,
// Show all, and no choice, preview, playback or input change from a jump.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;

// The write-during-jump scenarios run in a child process with an OS timeout,
// so a regression to an endless wait can never hang this test run.
const CHILD = process.env.REHERE_STATEMENTS_CHILD === '1';
const STALE_SCENARIO = 'a write that invalidates a jump’s read ends the jump and lets the write finish';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const zero = (id) => ({ id, offset: [0, 0, 0], yaw: 0 });
const job = () => ({
  id: JOB,
  draftId: DRAFT,
  sourceId: P1,
  status: 'ready',
  createdAt: '2026-11-01T00:00:00.000Z',
  error: null,
  usageBlocked: false,
  blockedReason: null,
  objectsConfirmed: true,
  objects: [
    { id: 'object-1', label: 'Window', box: [0, 435, 226, 790], pivot: [-0.5, 0, -3] },
    { id: 'object-2', label: 'Counter', box: [490, 450, 982, 781], pivot: [0.5, 0, -3] },
  ],
  edit: { version: 1, objects: [zero('object-1'), zero('object-2')], relationship: null },
});
const GRID = 20;
const surface = {
  schema_version: 2,
  width: GRID,
  height: GRID,
  depth: Array(GRID * GRID).fill(3),
  regions: Array.from({ length: GRID * GRID }, (_, i) => {
    const x = i % GRID;
    const y = Math.floor(i / GRID);
    return y >= 6 && y <= 13 ? (x >= 2 && x <= 6 ? 1 : x >= 13 && x <= 17 ? 2 : 0) : 0;
  }),
  objects: [
    { id: 'object-1', label: 'Window', box_xyxy: [0, 435, 226, 790] },
    { id: 'object-2', label: 'Counter', box_xyxy: [490, 450, 982, 781] },
  ],
  assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  source: { image_size: [1000, 800] },
};


const proposal = (id, targetId, status, extra = {}) => ({
  id,
  requestId: `${id.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`,
  baseVersion: 1,
  ...(targetId ? { targetId } : {}),
  statement: { id: `${id.slice(0, 8)}-0000-4000-8000-000000000000`, kind: 'human_memory', text: `Memory for ${targetId ?? 'nobody'}.`, sha256: 'a'.repeat(64), modelConsent: true },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  status,
  result: status === 'failed' ? null : { action: 'translate', targetId: targetId ?? 'object-1', sourceId: P1, baseVersion: 1, delta: [0.1, 0, 0], yawDelta: null, anchor: null, question: null, reason: 'Moved.', transform: { offset: [0.1, 0, 0], yaw: 0 } },
  question: null,
  error: null,
  model: 'synthetic',
  usage: null,
  responseId: null,
  appliedVersion: status === 'applied' ? 2 : null,
  ...extra,
});
const contribution = (id, provider, status, targetId) => ({
  id,
  principalId: `p-${provider}`,
  provider: { displayName: provider },
  kind: 'human_recollection',
  text: `${provider} remembers the place.`,
  textSha256: 'a'.repeat(64),
  permissions: { place: true, model: false, share: false },
  periodClaim: null,
  createdAt: '2026-10-31T00:00:00.000Z',
  revision: 2,
  status,
  review: status === 'submitted' ? null : { decision: status === 'adopted' ? 'adopt' : 'alternative', reason: '', conflict: null, reviewedAt: '2026-10-31T01:00:00.000Z', variantId: null, version: status === 'adopted' ? 2 : null, targetId },
  withdrawnAt: null,
});
const story = (id, title, targetId) => ({
  id,
  status: 'ready',
  available: true,
  blockedReason: null,
  title,
  target: { id: targetId, label: targetId === 'object-1' ? 'A: Window' : 'B: Counter' },
  view: { kind: 'version', version: 1, variantId: null, eraRevision: null, label: 'Saved version 1', era: null },
  voice: { sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', provider: 'Owner' },
  captionAuthor: { displayName: 'Owner' },
  cues: [{ startMs: 0, endMs: 1000, text: 'Synthetic test tone; no speech.' }],
  durationMs: 1000,
  audio: { type: 'audio/wav', size: 2044 },
  error: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  withdrawnAt: null,
});

const PA = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const PB = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const PL = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const CA = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const CB = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const CU = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const CS = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';

let requests;
let routes;
let mountSpace;
let mounted;
let proposals;
let collab;
let stories;

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ url, method });
    const handler = routes[`${method} ${url}`];
    if (handler) return handler();
    if (/\/region-links$|\/memory-link$/.test(url)) return Promise.resolve(json(503, { error: 'Not part of this test.' }));
    return Promise.resolve(json(200, []));
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
  // B's ready proposal is the one under review when the scene opens.
  proposals = [proposal(PA, 'object-1', 'applied'), proposal(PB, 'object-2', 'ready'), proposal(PL, null, 'applied')];
  collab = {
    contributions: [contribution(CA, 'Mina', 'adopted', 'object-1'), contribution(CB, 'Jun', 'alternative', 'object-2'), contribution(CU, 'Old', 'adopted', null), contribution(CS, 'New', 'submitted', null)],
    variants: [],
    blocked: false,
  };
  stories = [story('s1', 'Window song', 'object-1'), story('s2', 'Counter talk', 'object-2')];
  routes = {
    [`GET ${BASE}`]: () => Promise.resolve(json(200, [job()])),
    [`GET ${JOB_URL}`]: () => Promise.resolve(json(200, job())),
    [`GET ${JOB_URL}/assets/surface.json`]: () => Promise.resolve(json(200, surface)),
    [`GET ${JOB_URL}/proposals`]: () => Promise.resolve(json(200, structuredClone(proposals))),
    [`GET ${JOB_URL}/collaboration`]: () => Promise.resolve(json(200, structuredClone(collab))),
    [`GET ${JOB_URL}/stories`]: () => Promise.resolve(json(200, { stories: structuredClone(stories) })),
    [`GET ${JOB_URL}/history`]: () => Promise.resolve(json(200, [{ version: 1, kind: 'initial', targetId: null, blocked: false, ...job().edit }])),
  };
});

afterEach(() => {
  for (const space of mounted.splice(0)) space.dispose();
});

async function open() {
  const container = new FakeElement('section');
  const draft = { id: DRAFT, text: '', photos: [{ name: 'photo-1.jpg', sourceId: P1 }], sources: [] };
  const space = mountSpace(container, { draft, sourceFor: () => ({ kind: 'photo', provider: 'Mina', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, policy: { revision: 0, stopped: false } }) });
  mounted.push(space);
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  button('Open scene').dispatch('click');
  await settle();
  const ui = {
    space,
    find,
    button,
    text: () => container.textContent,
    chooserItems: () => find((node) => node.className === 'memory-proposals')[0].children.map((li) => li.textContent),
    ownerRows: () => find((node) => node.tag === 'section' && /Recollections from others/.test(node.textContent))[0].findAll((node) => node.tag === 'ul' && node.className === 'collab-list')[0].children.map((li) => li.textContent),
    storyTitles: () => find((node) => node.tag === 'details' && /^Recorded stories/.test(node.textContent))[0].findAll((node) => node.className === 'space-choice-label').map((node) => node.textContent),
    async choose(label) {
      button(label).dispatch('click');
      await settle();
    },
  };
  return ui;
}

const reads = (suffix) => requests.filter((request) => request.method === 'GET' && request.url === `${JOB_URL}${suffix}`).length;
const writes = () => requests.filter((request) => request.method !== 'GET');

describe('jumping from an object’s sources to its statements', () => {
  it('names the object the owner adopted or kept each recollection for, or says it was not recorded', async () => {
    const ui = await open();
    const rows = ui.ownerRows();
    assert.match(rows[0], /You adopted this for A: Window\./);
    assert.match(rows[1], /You kept this as an alternative for B: Counter\./);
    assert.match(rows[2], /The object for this arrangement was not recorded\./);
    assert.doesNotMatch(rows[3], /adopted this|kept this|not recorded/, 'a submitted recollection gets no object');
  });

  it('refreshes, then shows only the selected object’s proposals, keeps the reviewed one, and Show all restores everything', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    assert.match(ui.text(), /Other statements about A: Window/);
    const before = reads('/proposals');
    ui.button('Saved proposals for A: Window').dispatch('click');
    await settle();
    assert.equal(reads('/proposals'), before + 1, 'a fresh read first');
    assert.deepEqual(ui.chooserItems().map((text) => /Memory for (\S+)\./.exec(text)?.[1]), ['object-1'], 'exact stored request target only');
    assert.match(ui.text(), /Showing saved proposals for A: Window \(1\)\./);
    assert.match(ui.text(), /1 without a recorded object is under Show all\./);
    assert.match(ui.text(), /Planned for B: Counter\./, 'the proposal under review stays, with its own object');
    assert.equal(writes().length, 0, 'no model or other request from a jump');
    ui.button('Show all saved proposals').dispatch('click');
    assert.equal(ui.chooserItems().length, 3);
    assert.doesNotMatch(ui.text(), /Showing saved proposals/);
  });

  it('shows only recollections used for the object, never unknown or unreviewed ones, and keeps the review form and typed memory', async () => {
    const ui = await open();
    await ui.choose('B: Counter');
    // An open review of the unreviewed recollection with a typed note, and a typed memory with consent.
    const owner = ui.find((node) => node.tag === 'section' && /Recollections from others/.test(node.textContent))[0];
    owner.findAll((node) => node.tag === 'button' && node.textContent === 'Review')[0].dispatch('click');
    await settle();
    const note = owner.findAll((node) => node.tag === 'textarea')[0];
    note.value = 'Typed note';
    note.dispatch('input');
    const memoryText = ui.find((node) => node.tag === 'textarea' && /^memory-text-/.test(node.id ?? ''))[0];
    memoryText.value = 'A memory being typed';
    memoryText.dispatch('input');
    const consent = ui.find((node) => node.tag === 'label' && /Send this message and the photo to Meta/.test(node.textContent))[0].findAll((node) => node.tag === 'input')[0];
    consent.checked = true;
    consent.dispatch('change');
    ui.button('Recollections used for B: Counter').dispatch('click');
    await settle();
    const rows = ui.ownerRows();
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^Jun/);
    assert.match(ui.text(), /Showing recollections used for B: Counter \(1\)\./);
    assert.match(ui.text(), /1 without a recorded object is under Show all\./);
    assert.equal(owner.findAll((node) => node.tag === 'textarea')[0], note, 'the open review form is the same');
    assert.equal(note.value, 'Typed note');
    ui.button('Saved proposals for B: Counter').dispatch('click');
    await settle();
    assert.equal(memoryText.value, 'A memory being typed');
    assert.equal(consent.checked, true);
    ui.button('Show all recollections').dispatch('click');
    assert.equal(ui.ownerRows().length, 4);
    assert.equal(writes().length, 0);
  });

  it('shows only stories about the object, plays nothing, and Show all restores them', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    ui.button('Recorded stories about A: Window').dispatch('click');
    await settle();
    assert.deepEqual(ui.storyTitles(), ['Window song']);
    assert.match(ui.text(), /Showing recorded stories about A: Window \(1\)\./);
    assert.equal(requests.filter((request) => request.url.endsWith('/audio.wav')).length, 0, 'no audio fetched by navigation');
    ui.button('Show all recorded stories').dispatch('click');
    assert.deepEqual(ui.storyTitles(), ['Window song', 'Counter talk']);
  });

  it('never claims none after a failed read, and a failed first stories read stays an error under Show all', async () => {
    routes[`GET ${JOB_URL}/stories`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    const ui = await open();
    assert.match(ui.text(), /Recorded stories could not be read just now\./);
    assert.doesNotMatch(ui.text(), /No recorded stories yet/);
    await ui.choose('A: Window');
    ui.button('Recorded stories about A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /Recorded stories could not be read just now, so nothing is shown as about A: Window\. Try again\./);
    assert.doesNotMatch(ui.text(), /No recorded story is about/);
    ui.button('Show all recorded stories').dispatch('click');
    assert.match(ui.text(), /Recorded stories could not be read just now\./);
    assert.doesNotMatch(ui.text(), /No recorded stories yet/);

    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    ui.button('Saved proposals for A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /Saved proposals could not be read just now, so nothing is shown as being for A: Window\. Try again\./);
    assert.doesNotMatch(ui.text(), /No saved proposal is recorded/);
    assert.equal(ui.chooserItems().length, 3, 'the earlier list is not filtered on a failure');

    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    ui.button('Recollections used for A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /Recollections could not be read just now, so nothing is shown as used for A: Window\. Try again\./);
    assert.equal(ui.ownerRows().length, 4);
  });

  it('keeps the story form’s saved-view choice when a jump’s ancillary reads fail', async () => {
    // Version 2 is current; the form chooses the older version 1, which only history lists.
    const current = () => ({ ...job(), edit: { ...job().edit, version: 2 } });
    routes[`GET ${BASE}`] = () => Promise.resolve(json(200, [current()]));
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, current()));
    routes[`GET ${JOB_URL}/history`] = () =>
      Promise.resolve(json(200, [{ version: 1, kind: 'initial', targetId: null, blocked: false, ...job().edit }, { version: 2, kind: 'manual', targetId: 'object-1', blocked: false, ...current().edit }]));
    const ui = await open();
    const panel = ui.find((node) => node.tag === 'details' && /^Recorded stories/.test(node.textContent))[0];
    const view = panel.findAll((node) => node.tag === 'select' && node.children.some((option) => option.textContent === 'Choose a saved view'))[0];
    const option = view.children.find((entry) => entry.value === 'version:1');
    assert.ok(option, 'the older version is offered');
    view.value = option.value;
    view.dispatch('change');
    routes[`GET ${JOB_URL}/history`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    await ui.choose('A: Window');
    ui.button('Recorded stories about A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /Showing recorded stories about A: Window \(1\)\./, 'the list read itself succeeded');
    assert.equal(view.value, option.value, 'list navigation never retargets the form');
    assert.ok(view.children.some((entry) => entry.value === option.value));
  });

  it('labels earlier results as earlier while a newer jump reads or fails, with no fresh count or none', async () => {
    proposals = [proposal(PB, 'object-2', 'ready'), proposal(PL, null, 'applied')];
    const ui = await open();
    await ui.choose('A: Window');
    ui.button('Saved proposals for A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /No saved proposal is recorded for A: Window\./);
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    ui.button('Saved proposals for A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /Saved proposals could not be read just now, so nothing is shown as being for A: Window\. Try again\./);
    assert.match(ui.text(), /Still showing the earlier results for A: Window\./);
    assert.doesNotMatch(ui.text(), /No saved proposal is recorded|Showing saved proposals/);
    assert.doesNotMatch(ui.text(), /without a recorded object/);
  });

  it('ignores a jump answered after its object was left and chosen again', async () => {
    let release;
    routes[`GET ${JOB_URL}/stories`] = () => new Promise((resolve) => (release = () => resolve(json(200, { stories: structuredClone(stories) }))));
    const ui = await open();
    await ui.choose('A: Window');
    ui.button('Recorded stories about A: Window').dispatch('click');
    await settle();
    await ui.choose('B: Counter');
    await ui.choose('A: Window');
    const focused = [];
    for (const node of ui.find(() => true)) node.focus = () => focused.push(node);
    release();
    await settle();
    assert.doesNotMatch(ui.text(), /Showing recorded stories about A: Window/, 'the abandoned jump applies no filter');
    assert.doesNotMatch(ui.text(), /Reading recorded stories/);
    assert.equal(ui.storyTitles().length, 2);
    assert.deepEqual(focused, [], 'and focuses nothing');
  });

  it('says none only after a successful read finds none', async () => {
    stories = [story('s2', 'Counter talk', 'object-2')];
    const ui = await open();
    await ui.choose('A: Window');
    ui.button('Recorded stories about A: Window').dispatch('click');
    await settle();
    assert.match(ui.text(), /No recorded story is about A: Window\./);
    assert.deepEqual(ui.storyTitles(), []);
  });

  it('drops a jump answered after another object, another jump or Show all, and keeps the unsaved arrangement', async () => {
    let release;
    routes[`GET ${JOB_URL}/stories`] = () => new Promise((resolve) => (release = () => resolve(json(200, { stories: structuredClone(stories) }))));
    const ui = await open();
    await ui.choose('A: Window');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    ui.button('Recorded stories about A: Window').dispatch('click');
    await settle();
    // Selecting the other object before the answer: the late answer changes nothing.
    await ui.choose('B: Counter');
    release();
    await settle();
    assert.doesNotMatch(ui.text(), /Showing recorded stories about A: Window/);
    assert.equal(ui.storyTitles().length, 2);

    // Show all cancels a pending jump.
    ui.button('Recorded stories about B: Counter').dispatch('click');
    await settle();
    ui.button('Show all recorded stories').dispatch('click');
    release();
    await settle();
    assert.doesNotMatch(ui.text(), /Showing recorded stories about B: Counter/);
    assert.equal(ui.storyTitles().length, 2);

    // An unsaved change and the scene survive jumps.
    delete routes[`GET ${JOB_URL}/stories`];
    x.value = '0.3';
    x.dispatch('input');
    const renderers = globalThis.viewerLog.filter((entry) => entry === 'renderer').length;
    ui.button('Saved proposals for B: Counter').dispatch('click');
    await settle();
    ui.button('Recollections used for B: Counter').dispatch('click');
    await settle();
    assert.equal(x.value, '0.3');
    assert.equal(ui.button('Apply and save').disabled, false);
    assert.equal(globalThis.viewerLog.filter((entry) => entry === 'renderer').length, renderers, 'no scene remount');
    assert.equal(writes().length, 0);
  });

  // Registered only in the child; the parent registers only the bounded check.
  if (CHILD) it(STALE_SCENARIO, async () => {
    const ui = await open();
    await ui.choose('A: Window');
    // Proposals: the jump's read is answered only after a Plan write started.
    const memoryText = ui.find((node) => node.tag === 'textarea' && /^memory-text-/.test(node.id ?? ''))[0];
    memoryText.value = 'The window was open.';
    memoryText.dispatch('input');
    const consent = ui.find((node) => node.tag === 'label' && /Send this message and the photo to Meta/.test(node.textContent))[0].findAll((node) => node.tag === 'input')[0];
    consent.checked = true;
    consent.dispatch('change');
    let releaseRead;
    routes[`GET ${JOB_URL}/proposals`] = () => new Promise((resolve) => (releaseRead = () => resolve(json(200, structuredClone(proposals)))));
    ui.button('Saved proposals for A: Window').dispatch('click');
    await settle();
    let releaseWrite;
    routes[`POST ${JOB_URL}/proposals`] = () => new Promise((resolve) => (releaseWrite = () => resolve(json(202, { ...proposal('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1', 'object-1', 'queued'), result: null }))));
    ui.button('Plan a change').dispatch('click');
    await settle();
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, structuredClone(proposals)));
    releaseRead();
    await settle();
    assert.doesNotMatch(ui.text(), /Reading saved proposals for A: Window/, 'the jump ended');
    assert.doesNotMatch(ui.text(), /Showing saved proposals|No saved proposal is recorded/, 'and declared nothing');
    const before = reads('/proposals');
    releaseWrite();
    await settle();
    assert.ok(reads('/proposals') > before, 'the write finished and its own refresh followed');

    // Recollections: the same with a review decision being saved.
    const owner = ui.find((node) => node.tag === 'section' && /Recollections from others/.test(node.textContent))[0];
    owner.findAll((node) => node.tag === 'button' && node.textContent === 'Review')[0].dispatch('click');
    await settle();
    let releaseCollab;
    routes[`GET ${JOB_URL}/collaboration`] = () => new Promise((resolve) => (releaseCollab = () => resolve(json(200, structuredClone(collab)))));
    ui.button('Recollections used for A: Window').dispatch('click');
    await settle();
    const decision = owner.findAll((node) => node.tag === 'select' && node.children.some((option) => option.value === 'hold'))[0];
    decision.value = 'hold';
    decision.dispatch('change');
    let releaseReview;
    routes[`POST ${JOB_URL}/contributions/${CS}/review`] = () => new Promise((resolve) => (releaseReview = () => resolve(json(200, { contribution: contribution(CS, 'New', 'submitted', null) }))));
    owner.findAll((node) => node.tag === 'button' && node.textContent === 'Save decision')[0].dispatch('click');
    await settle();
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, structuredClone(collab)));
    releaseCollab();
    await settle();
    assert.doesNotMatch(ui.text(), /Reading recollections used for A: Window/);
    const collabReads = reads('/collaboration');
    releaseReview?.();
    await settle();
    assert.ok(reads('/collaboration') > collabReads, 'the review write finished and refreshed');
  });

  if (!CHILD) it('cannot hang when a write invalidates a jump’s read (bounded child process)', () => {
    // A fresh runner of its own, not a child of this one.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', STALE_SCENARIO, fileURLToPath(import.meta.url)], {
      env: { ...env, REHERE_STATEMENTS_CHILD: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.signal, null, `the scenario did not finish in time:\n${result.stdout}`);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /# pass 1/);
  });
});
