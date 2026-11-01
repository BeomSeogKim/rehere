import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The owner's link from a confirmed scene object to the place's whole saved
// written memory, mounted inside the real space.js scene: fresh server words,
// explicit confirmation, exact retries, conflicts, unavailable markers and
// late answers.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEXT = 'abababab-abab-4bab-8bab-abababababab';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;
const linkUrl = (objectId) => `${JOB_URL}/objects/${objectId}/memory-link`;
const WORDS = 'The counter faced the window.\r\n  We sat there  every summer.\r\n';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

// --- a fake link store following the shared DTO ---------------------------
let store;
let source;
let requests;
let routes;
let mountSpace;
let mounted;
const projection = (objectId) => {
  const state = store[objectId];
  const link = state.link ? { sourceId: state.link.sourceId, linkedAt: state.link.linkedAt, available: source?.available === true && state.link.reason === null, reason: source?.available ? state.link.reason : (state.link.reason ?? source?.reason ?? 'unreadable') } : null;
  return {
    draftId: DRAFT,
    jobId: JOB,
    objectId,
    label: objectId === 'object-1' ? 'Window' : 'Counter',
    revision: state.revision,
    updatedAt: state.revision ? '2026-11-02T10:00:00.000Z' : null,
    source: source ? structuredClone(source) : null,
    link,
  };
};
function postLink(objectId, body) {
  const state = store[objectId];
  const seen = state.receipts.get(body.requestId);
  if (seen) return seen.body === JSON.stringify(body) ? json(200, { ...projection(objectId), changed: false, replayed: true, appliedRevision: seen.applied }) : json(409, { error: 'That request was already used for a different change.' });
  if (body.baseRevision !== state.revision) return json(409, { error: 'The written memory link changed elsewhere.' });
  let changed;
  if (body.action === 'set') {
    if (!source) return json(400, { error: 'This place has no saved written memory to link.' });
    if (!source.available) return json(403, { error: 'The saved written memory may not be used for this place.' });
    changed = !state.link;
    if (changed) state.link = { sourceId: body.sourceId, linkedAt: '2026-11-02T10:00:00.000Z', reason: null };
  } else {
    if (!state.link) return json(409, { error: 'There is no link to remove.' });
    state.link = null;
    changed = true;
  }
  if (changed) state.revision += 1;
  state.receipts.set(body.requestId, { body: JSON.stringify(body), applied: state.revision });
  return json(200, { ...projection(objectId), changed, replayed: false, appliedRevision: state.revision });
}

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body });
    const handler = routes[`${method} ${url}`];
    if (handler) return handler(body);
    const link = /\/objects\/(object-[12])\/memory-link$/.exec(url);
    if (link) return Promise.resolve(method === 'GET' ? json(200, projection(link[1])) : postLink(link[1], body));
    if (/\/region-links$/.test(url)) return Promise.resolve(json(200, { draftId: DRAFT, jobId: JOB, objectId: url.includes('object-1') ? 'object-1' : 'object-2', label: '', scenePhoto: null, revision: 0, updatedAt: null, links: [] }));
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
  source = { sourceId: TEXT, available: true, reason: null, text: WORDS };
  store = { 'object-1': { revision: 0, link: null, receipts: new Map() }, 'object-2': { revision: 0, link: null, receipts: new Map() } };
  routes = {
    [`GET ${BASE}`]: () => Promise.resolve(json(200, [job()])),
    [`GET ${JOB_URL}`]: () => Promise.resolve(json(200, job())),
    [`GET ${JOB_URL}/assets/surface.json`]: () => Promise.resolve(json(200, surface)),
    [`GET ${JOB_URL}/collaboration`]: () => Promise.resolve(json(200, { contributions: [], variants: [], blocked: false })),
    [`GET ${JOB_URL}/stories`]: () => Promise.resolve(json(200, { stories: [] })),
    [`GET ${JOB_URL}/history`]: () => Promise.resolve(json(200, [{ version: 1, kind: 'initial', targetId: null, blocked: false, ...job().edit }])),
  };
});

afterEach(() => {
  for (const space of mounted.splice(0)) space.dispose();
});

async function open() {
  const container = new FakeElement('section');
  // The page's own copy of the writing is stale on purpose: the panel must not use it.
  const draft = { id: DRAFT, text: 'STALE PAGE COPY', textSourceId: TEXT, photos: [{ name: 'photo-1.jpg', sourceId: P1 }], sources: [] };
  const space = mountSpace(container, { draft, sourceFor: () => ({ kind: 'photo', provider: 'Mina', permissions: { place: true, model: true, share: true }, policy: { revision: 0, stopped: false } }) });
  mounted.push(space);
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  button('Open scene').dispatch('click');
  await settle();
  const panel = () => find((node) => node.className === 'memory-link')[0];
  const ui = {
    space,
    container,
    find,
    button,
    panel,
    text: () => panel()?.textContent ?? '',
    words: () => panel()?.findAll((node) => node.className === 'memory-text').map((node) => node.textContent) ?? [],
    panelButton: (text) => panel()?.findAll((node) => node.tag === 'button' && node.textContent === text)[0],
    tick() {
      const box = panel().findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0];
      box.checked = true;
      box.dispatch('change');
    },
    posts: (objectId) => requests.filter((r) => r.method === 'POST' && r.url === linkUrl(objectId)),
    async choose(label) {
      button(label).dispatch('click');
      await settle();
    },
  };
  return ui;
}

describe('owner link from an object to the saved written memory', () => {
  it('shows the fresh saved words only on a deliberate review, needs the confirmation, and links the whole writing', async () => {
    const ui = await open();
    assert.ok(ui.find((node) => node.tag === 'summary' && node.textContent === 'Sources (choose an object)').length, 'writing is not called photo evidence');
    await ui.choose('A: Window');
    assert.ok(ui.find((node) => node.tag === 'summary' && node.textContent === 'Sources for A: Window').length);
    assert.match(ui.text(), /^Saved written memory/);
    assert.match(ui.text(), /Your saved written memory is not linked to A: Window\./);
    assert.deepEqual(ui.words(), [], 'no words before a deliberate review');
    ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
    assert.deepEqual(ui.words(), [WORDS], 'the exact server words, line endings and spacing kept');
    assert.doesNotMatch(ui.container.textContent, /STALE PAGE COPY/);
    assert.match(ui.text(), /Linking is your own judgment that these exact words are about this object\. It is not a model reading, a date or proof of how the place was\./);
    assert.equal(ui.panelButton('Link').disabled, true);
    ui.panelButton('Not now').dispatch('click');
    assert.equal(ui.posts('object-1').length, 0, 'not now writes nothing');
    ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
    ui.tick();
    ui.panelButton('Link').dispatch('click');
    await settle();
    const [sent] = ui.posts('object-1');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseRevision: 0, action: 'set', sourceId: TEXT, confirmed: true });
    assert.match(ui.text(), /Linked by you to A: Window on .*\. Linking is your own judgment/);
    assert.deepEqual(ui.words(), [WORDS]);
    assert.match(ui.text(), /Linked\./);
    await ui.choose('B: Counter');
    assert.match(ui.text(), /Your saved written memory is not linked to B: Counter\./, 'each object is separate');
    assert.ok(!requests.some((r) => /proposals|shares|stories$|\/edit$/.test(r.url) && r.method === 'POST'), 'no model, share, story or arrangement request');
  });

  it('removes a link only after a second confirmation', async () => {
    store['object-1'] = { revision: 1, link: { sourceId: TEXT, linkedAt: '2026-11-02T09:00:00.000Z', reason: null }, receipts: new Map() };
    const ui = await open();
    await ui.choose('A: Window');
    ui.panelButton('Remove link').dispatch('click');
    assert.equal(ui.posts('object-1').length, 0, 'the first press only asks');
    ui.panelButton('Remove this link').dispatch('click');
    await settle();
    assert.deepEqual(ui.posts('object-1')[0].body, { requestId: ui.posts('object-1')[0].body.requestId, baseRevision: 1, action: 'remove', sourceId: TEXT, confirmed: true });
    assert.match(ui.text(), /Link removed\. The written memory and the scene are unchanged\./);
  });

  it('keeps an unconfirmed request through a Check that still looks unlinked, repeats it exactly, and lets the owner abandon it', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
    ui.tick();
    routes[`POST ${linkUrl('object-1')}`] = () => lost();
    ui.panelButton('Link').dispatch('click');
    await settle();
    assert.match(ui.text(), /Rehere could not confirm this change\. It may have been saved\./);
    ui.panelButton('Check').dispatch('click');
    await settle();
    assert.match(ui.text(), /not linked to A: Window/);
    assert.ok(ui.panelButton('Link again (same request)'), 'a read does not settle it');
    delete routes[`POST ${linkUrl('object-1')}`];
    ui.panelButton('Link again (same request)').dispatch('click');
    await settle();
    const [first, second] = ui.posts('object-1');
    assert.deepEqual(second.body, first.body, 'exactly the same request');
    assert.match(ui.text(), /Linked\./);

    // Abandoning is an explicit choice, and the state is read again.
    await ui.choose('B: Counter');
    ui.panelButton('Link your saved written memory to B: Counter').dispatch('click');
    ui.tick();
    routes[`POST ${linkUrl('object-2')}`] = () => Promise.resolve({ status: 400, ok: false, json: async () => { throw new SyntaxError('proxy'); } });
    ui.panelButton('Link').dispatch('click');
    await settle();
    assert.match(ui.text(), /could not confirm/, 'a refusal without the server’s own words is not definite');
    ui.panelButton('Abandon this request').dispatch('click');
    await settle();
    assert.match(ui.text(), /The unconfirmed request was abandoned here\. It may still have been saved/);
    assert.equal(ui.panelButton('Link again (same request)'), undefined);
  });

  it('on a conflict shows the current state and keeps the review for an explicit new save', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
    ui.tick();
    store['object-1'].revision = 3;
    ui.panelButton('Link').dispatch('click');
    await settle();
    assert.match(ui.text(), /The written memory link changed elsewhere\. The current state is shown; save again to change it\./);
    assert.equal(ui.panelButton('Link').disabled, false, 'the review and its confirmation stay');
    ui.panelButton('Link').dispatch('click');
    await settle();
    const [stale, again] = ui.posts('object-1');
    assert.equal(stale.body.baseRevision, 0);
    assert.equal(again.body.baseRevision, 3);
    assert.notEqual(again.body.requestId, stale.body.requestId);
    assert.match(ui.text(), /Linked\./);
  });

  it('clears confirmation when a conflict reread changes the exact words or their source', async () => {
    for (const changed of [{ text: `${WORDS}Changed words.` }, { sourceId: 'dededede-dede-4ded-8ded-dededededede' }]) {
      store['object-1'] = { revision: 0, link: null, receipts: new Map() };
      source = { sourceId: TEXT, available: true, reason: null, text: WORDS };
      const ui = await open();
      await ui.choose('A: Window');
      ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
      ui.tick();
      source = { ...source, ...changed };
      store['object-1'].revision = 3;
      ui.panelButton('Link').dispatch('click');
      await settle();
      assert.deepEqual(ui.words(), [source.text]);
      assert.equal(ui.panelButton('Link').disabled, true, 'different words or source need a new confirmation');
      const box = ui.panel().findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0];
      assert.equal(box.checked, false);
      ui.tick();
      ui.panelButton('Link').dispatch('click');
      await settle();
      assert.match(ui.text(), /Linked\./);
      assert.equal(ui.posts('object-1').at(-1).body.sourceId, source.sourceId);
      ui.space.dispose();
    }
  });

  it('keeps a malformed mutation receipt unknown and retries the exact accepted request', async () => {
    for (const corrupt of [
      () => ({}),
      (body) => ({ ...body, changed: undefined }),
      (body) => ({ ...body, replayed: undefined }),
      (body) => ({ ...body, appliedRevision: undefined }),
      (body) => ({ ...body, changed: 'true' }),
      (body) => ({ ...body, replayed: 'false' }),
      (body) => ({ ...body, appliedRevision: -1 }),
      (body) => ({ ...body, appliedRevision: body.revision + 1 }),
      (body) => ({ ...body, changed: true, replayed: true }),
    ]) {
      store['object-1'] = { revision: 0, link: null, receipts: new Map() };
      const ui = await open();
      await ui.choose('A: Window');
      ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
      ui.tick();
      routes[`POST ${linkUrl('object-1')}`] = async (body) => {
        const accepted = await postLink('object-1', body).json();
        return json(200, { ...projection('object-1'), ...corrupt(accepted) });
      };
      ui.panelButton('Link').dispatch('click');
      await settle();
      const first = ui.posts('object-1').at(-1).body;
      assert.match(ui.text(), /Rehere could not confirm this change/);
      ui.panelButton('Check').dispatch('click');
      await settle();
      assert.ok(ui.panelButton('Link again (same request)'), 'a read with the link present does not settle the receipt');
      delete routes[`POST ${linkUrl('object-1')}`];
      ui.panelButton('Link again (same request)').dispatch('click');
      await settle();
      assert.deepEqual(ui.posts('object-1').at(-1).body, first);
      assert.equal(ui.panelButton('Link again (same request)'), undefined);
      assert.match(ui.text(), /Linked\./);
      ui.space.dispose();
    }
  });

  it('shows the fixed refusals and changes nothing', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    ui.panelButton('Link your saved written memory to A: Window').dispatch('click');
    ui.tick();
    routes[`POST ${linkUrl('object-1')}`] = () => Promise.resolve(json(403, { error: 'The saved written memory may not be used for this place.' }));
    ui.panelButton('Link').dispatch('click');
    await settle();
    assert.match(ui.text(), /The saved written memory may not be used for this place\. Nothing was changed\./);
    assert.equal(store['object-1'].link, null);
  });

  it('never shows words for an unavailable link or source, and an unreadable answer is not called unlinked', async () => {
    store['object-1'] = { revision: 1, link: { sourceId: TEXT, linkedAt: '2026-11-02T09:00:00.000Z', reason: null }, receipts: new Map() };
    source = { sourceId: TEXT, available: false, reason: 'source', text: null };
    const ui = await open();
    await ui.choose('A: Window');
    assert.match(ui.text(), /A written memory is linked to A: Window\. Its use to reconstruct this place is not allowed now, or its use was stopped\. The link is kept; the words are not shown\./);
    assert.deepEqual(ui.words(), []);
    assert.ok(ui.panelButton('Remove link'), 'still removable');

    await ui.choose('B: Counter');
    assert.match(ui.text(), /The saved written memory cannot be linked now: its use to reconstruct this place is not allowed/);
    assert.equal(ui.panelButton('Link your saved written memory to B: Counter'), undefined);
    source = { sourceId: TEXT, available: false, reason: 'checksum', text: null };
    ui.space.dispose();
    const next = await open();
    await next.choose('B: Counter');
    assert.match(next.text(), /no longer matches its recorded checksum/);
    source = null;
    next.space.dispose();
    const none = await open();
    await none.choose('B: Counter');
    assert.match(none.text(), /This place has no saved written memory that can be linked\./);

    for (const bad of [
      { ...projection('object-2'), objectId: 'object-1' },
      { ...projection('object-2'), source: { sourceId: TEXT, available: true, reason: null, text: null } },
      { ...projection('object-2'), link: { sourceId: TEXT, linkedAt: '2026-11-02T09:00:00.000Z', available: true, reason: null } },
    ]) {
      routes[`GET ${linkUrl('object-2')}`] = () => Promise.resolve(json(200, bad));
      none.space.dispose();
      const ui2 = await open();
      await ui2.choose('B: Counter');
      assert.match(ui2.text(), /could not be read right now\. This does not mean it is unlinked\./);
      assert.doesNotMatch(ui2.text(), /not linked to/);
    }
    routes[`GET ${linkUrl('object-2')}`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    const last = await open();
    await last.choose('B: Counter');
    assert.match(last.text(), /could not be read right now/);
  });

  it('drops late answers after an object switch or close, and keeps the scene and an unsaved change on a link', async () => {
    let release;
    routes[`GET ${linkUrl('object-1')}`] = () => new Promise((resolve) => (release = () => resolve(json(200, { ...projection('object-1'), link: { sourceId: TEXT, linkedAt: '2026-11-02T09:00:00.000Z', available: true, reason: null } }))));
    const ui = await open();
    await ui.choose('A: Window');
    await ui.choose('B: Counter');
    release();
    await settle();
    assert.match(ui.text(), /not linked to B: Counter/, 'the late read for A changes nothing');
    delete routes[`GET ${linkUrl('object-1')}`];

    let answer;
    routes[`POST ${linkUrl('object-2')}`] = (body) => new Promise((resolve) => (answer = () => resolve(postLink('object-2', body))));
    ui.panelButton('Link your saved written memory to B: Counter').dispatch('click');
    ui.tick();
    ui.panelButton('Link').dispatch('click');
    await settle();
    const before = ui.panel();
    ui.space.dispose();
    answer();
    await settle();
    assert.equal(before.findAll((node) => /Linked\./.test(node.textContent ?? '')).length, 0);
    delete routes[`POST ${linkUrl('object-2')}`];

    const next = await open();
    await next.choose('A: Window');
    const x = next.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '0.4';
    x.dispatch('input');
    const renderers = globalThis.viewerLog.filter((entry) => entry === 'renderer').length;
    next.panelButton('Link your saved written memory to A: Window').dispatch('click');
    next.tick();
    next.panelButton('Link').dispatch('click');
    await settle();
    assert.match(next.text(), /Linked\./);
    assert.equal(globalThis.viewerLog.filter((entry) => entry === 'renderer').length, renderers, 'no scene remount');
    assert.equal(x.value, '0.4', 'the unsaved change is kept');
    assert.equal(next.button('Apply and save').disabled, false);
  });
});
