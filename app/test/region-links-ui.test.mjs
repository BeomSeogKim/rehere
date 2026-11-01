import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The owner's links from a confirmed scene object to boxes in other photos of
// the same memory, mounted inside the real space.js scene: admission before
// any pixels, explicit confirmation, exact retries, conflicts, unavailable
// markers and late answers.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const P3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const P4 = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
const P5 = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;
const linksUrl = (objectId) => `${JOB_URL}/objects/${objectId}/region-links`;
const asset = (name) => `/api/drafts/${DRAFT}/assets/${name}`;

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
const photo = (sourceId, n) => ({ name: `photo-${n}.jpg`, sourceId });
const record = (permissions, extra = {}) => ({ kind: 'photo', provider: 'Mina', origin: { kind: 'own', reference: '' }, permissions, policy: { revision: 0, stopped: false }, ...extra });
const SOURCES = {
  [P1]: record({ place: true, model: true, share: true }),
  [P2]: record({ place: true, model: true, share: false }),
  // A reference photo that may be used for this place but never by a model.
  [P3]: record({ place: true, model: false, share: false }, { provider: '' }),
  [P4]: record({ place: true, model: true, share: true }, { policy: { revision: 2, stopped: true } }),
  [P5]: record({ place: false, model: false, share: false }),
};
// Stored pixel sizes; photo 3 is stored taller than wide (as an EXIF 6 JPEG
// would be), and its box is placed in that stored pixel order.
const SIZES = { [P2]: [1200, 800], [P3]: [600, 900] };

// --- a fake link store following the shared DTO ---------------------------
let store;
let requests;
let routes;
let mountSpace;
let mounted;
const projection = (objectId) => {
  const state = store[objectId];
  return {
    draftId: DRAFT,
    jobId: JOB,
    objectId,
    label: objectId === 'object-1' ? 'Window' : 'Counter',
    scenePhoto: { sourceId: P1, box: job().objects.find((object) => object.id === objectId).box },
    revision: state.revision,
    updatedAt: state.revision ? '2026-11-02T10:00:00.000Z' : null,
    links: [...state.links.entries()].map(([sourceId, link]) =>
      link.reason ? { sourceId, box: null, imageSize: null, linkedAt: link.linkedAt, available: false, reason: link.reason } : { sourceId, box: [...link.box], imageSize: [...SIZES[sourceId]], linkedAt: link.linkedAt, available: true, reason: null },
    ),
  };
};
function postLinks(objectId, body) {
  const state = store[objectId];
  const seen = state.receipts.get(body.requestId);
  if (seen) return seen.body === JSON.stringify(body) ? json(200, { ...projection(objectId), changed: false, replayed: true, appliedRevision: seen.applied }) : json(409, { error: 'That request was already used for a different change.' });
  if (body.baseRevision !== state.revision) return json(409, { error: 'The links for this object changed elsewhere.' });
  const before = state.links.get(body.sourceId);
  let changed;
  if (body.action === 'set') {
    changed = !before || before.reason || before.box.join() !== body.box.join();
    if (changed) state.links.set(body.sourceId, { box: [...body.box], linkedAt: '2026-11-02T10:00:00.000Z', reason: null });
  } else {
    if (!before) return json(409, { error: 'There is no link for that photo.' });
    state.links.delete(body.sourceId);
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
    const links = /\/objects\/(object-[12])\/region-links$/.exec(url);
    if (links) return Promise.resolve(method === 'GET' ? json(200, projection(links[1])) : postLinks(links[1], body));
    const reference = /\/region-reference\/([^/]+)$/.exec(url);
    if (reference) {
      const size = SIZES[reference[1]];
      return Promise.resolve(size ? json(200, { width: size[0], height: size[1] }) : json(403, { error: 'This photo may not be used to reconstruct this place.' }));
    }
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
  store = { 'object-1': { revision: 0, links: new Map(), receipts: new Map() }, 'object-2': { revision: 0, links: new Map(), receipts: new Map() } };
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
  const draft = { id: DRAFT, photos: [photo(P1, 1), photo(P2, 2), photo(P3, 3), photo(P4, 4), photo(P5, 5)], sources: [] };
  const space = mountSpace(container, { draft, sourceFor: (id) => SOURCES[id] ?? null });
  mounted.push(space);
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  button('Open scene').dispatch('click');
  await settle();
  const panel = () => find((node) => node.className === 'region-links')[0];
  const inPanel = (predicate) => panel()?.findAll(predicate) ?? [];
  const ui = {
    space,
    container,
    find,
    button,
    panel,
    inPanel,
    text: () => panel()?.textContent ?? '',
    panelButton: (text) => inPanel((node) => node.tag === 'button' && node.textContent === text)[0],
    select: () => inPanel((node) => node.tag === 'select')[0],
    drawing: () => inPanel((node) => node.tag === 'img' && /Drag on it/.test(node.alt))[0],
    // The scene's own photo inside the add/change form.
    base: () => inPanel((node) => node.className === 'region-editor')[0]?.findAll((node) => node.tag === 'img' && /^Photo 1 with the box/.test(node.alt))[0],
    loadImages() {
      ui.base().dispatch('load');
      ui.drawing().dispatch('load');
    },
    inputs: () => inPanel((node) => node.tag === 'input' && node.type === 'number'),
    confirm: () => inPanel((node) => node.tag === 'input' && node.type === 'checkbox')[0],
    posts: (objectId) => requests.filter((r) => r.method === 'POST' && r.url === linksUrl(objectId)),
    async choose(objectButton) {
      button(objectButton).dispatch('click');
      await settle();
    },
    async startLink(sourceId) {
      ui.panelButton('Link a region in another photo').dispatch('click');
      const select = ui.select();
      select.value = sourceId;
      select.dispatch('change');
      await settle();
    },
    typeBox(box) {
      ui.inputs().forEach((input, i) => {
        input.value = String(box[i]);
        input.dispatch('input');
      });
    },
    tick() {
      const box = ui.confirm();
      assert.equal(box.disabled, false, 'the confirmation can be given');
      box.checked = true;
      box.dispatch('change');
    },
  };
  return ui;
}

const forbidden = () => requests.filter((r) => /image-size|\/proposals|\/shares|\/stories$|\/edit$|\/memory/.test(r.url) && r.method === 'POST' || /\/image-size$/.test(r.url) || (r.method === 'POST' && r.url === BASE));

describe('owner links between a scene object and regions in other photos', () => {
  it('links two other photos to one object with explicit confirmation, reopens them per object, and uses only the place-gated reference read', async () => {
    const ui = await open();
    assert.equal(ui.panel(), undefined, 'nothing until an object is chosen');
    await ui.choose('A: Window');
    assert.match(ui.text(), /^Regions you linked in other photos for A: Window/);
    assert.match(ui.text(), /your own judgment .* Rehere does not automatically recognise objects or match regions between photos, and a link does not align the photos, set a date or change the scene/);
    assert.match(ui.text(), /No region in another photo is linked to A: Window\./);

    for (const [sourceId, box] of [
      [P2, [100, 120, 400, 600]],
      [P3, [60, 90, 300, 450]],
    ]) {
      await ui.startLink(sourceId);
      assert.deepEqual(requests.at(-1), { url: `${JOB_URL}/region-reference/${sourceId}`, method: 'GET', body: null }, 'admitted before any pixels');
      ui.loadImages();
      ui.typeBox(box);
      assert.equal(ui.panelButton('Save link').disabled, true, 'not before the same-object confirmation');
      ui.tick();
      ui.panelButton('Save link').dispatch('click');
      await settle();
      assert.match(ui.text(), /Link saved\./);
      const sent = ui.posts('object-1').at(-1).body;
      assert.deepEqual(sent, { requestId: sent.requestId, baseRevision: sourceId === P2 ? 0 : 1, action: 'set', sourceId, box, confirmed: true });
    }
    assert.equal(forbidden().length, 0, 'no image-size, build, model, share, story or edit request');

    // A new mount reads the stored links again, for the chosen object only.
    ui.space.dispose();
    const again = await open();
    await again.choose('A: Window');
    assert.match(again.text(), /Photo 2, provided by Mina: linked by you on .*\. You said this box shows A: Window\./);
    assert.match(again.text(), /Photo 3: linked by you on /, 'no provider is invented');
    // Each reopened link is shown as a pair: the scene's own box beside the linked box.
    const pairs = again.inPanel((node) => node.className === 'photo-grid region-pair');
    assert.equal(pairs.length, 2, 'one pair per saved link');
    const texture = `${JOB_URL}/assets/texture.jpg`;
    for (const [index, reference] of [asset('photo-2.jpg'), asset('photo-3.jpg')].entries()) {
      const figures = pairs[index].findAll((node) => node.tag === 'figure');
      assert.deepEqual(figures.map((figure) => figure.findAll((node) => node.tag === 'img')[0].src), [texture, reference]);
      const [base] = figures[0].findAll((node) => node.className === 'box-overlay box-overlay-a');
      assert.deepEqual([base.style.left, base.style.top, base.style.width], ['0%', `${(435 / 800) * 100}%`, `${(226 / 1000) * 100}%`], 'the scene box from its own 1000 x 800 photo');
      assert.match(figures[0].textContent, /Photo 1: the scene’s own box/);
      assert.match(figures[1].textContent, new RegExp(`Photo ${index + 2}.*: your linked box`));
    }
    const tall = pairs[1].findAll((node) => node.className === 'box-overlay box-overlay-a')[1];
    assert.deepEqual([tall.style.left, tall.style.top, tall.style.width, tall.style.height], ['10%', '10%', '40%', '40%'], 'stored 600 x 900 pixel order, not rotated');
    assert.ok(again.inPanel((node) => node.className === 'anchor-frame region-photo').length === 2, 'read-only photos are drawn unrotated');
    await again.choose('B: Counter');
    assert.match(again.text(), /No region in another photo is linked to B: Counter\./);
    assert.ok(!/A: Window/.test(again.text()));
  });

  it('offers only other permitted photos, and a refused admission draws nothing', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    ui.panelButton('Link a region in another photo').dispatch('click');
    const options = ui.select().children.slice(1).map((option) => [option.value, option.disabled === true, option.textContent]);
    assert.deepEqual(options.map(([value]) => value), [P2, P3, P4, P5], 'never the scene’s own photo');
    assert.deepEqual(options.map(([, disabled]) => disabled), [false, false, true, true]);
    assert.match(options[2][2], /Photo 4, provided by Mina \(its use was stopped\)/);
    assert.match(options[3][2], /Photo 5, provided by Mina \(its use to reconstruct this place is not allowed\)/);
    delete SIZES[P2];
    try {
      const select = ui.select();
      select.value = P2;
      select.dispatch('change');
      await settle();
    } finally {
      SIZES[P2] = [1200, 800];
    }
    assert.match(ui.text(), /This photo may not be used to reconstruct this place\. No region can be drawn on it, and nothing was saved\./);
    assert.equal(ui.drawing(), undefined, 'no pixels of a refused photo');
    assert.ok(!requests.some((r) => r.url === asset('photo-2.jpg')));
    ui.panelButton('Not sure — leave unlinked').dispatch('click');
    assert.equal(ui.posts('object-1').length, 0);
  });

  it('holds Save until the photo has loaded and the box is confirmed; a new box or photo clears the confirmation; an image error holds the save', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.typeBox([10, 10, 200, 200]);
    assert.equal(ui.confirm().disabled, true, 'not before the image has loaded');
    ui.loadImages();
    ui.tick();
    assert.equal(ui.panelButton('Save link').disabled, false);
    ui.typeBox([10, 10, 210, 200]);
    assert.equal(ui.confirm().checked, false, 'a different box must be confirmed again');
    assert.equal(ui.panelButton('Save link').disabled, true);
    ui.typeBox([10, 10, 5000, 200]);
    assert.equal(ui.confirm().disabled, true, 'a box outside the photo cannot be confirmed');
    ui.typeBox([10, 10, 210, 200]);
    ui.tick();
    const select = ui.select();
    select.value = P3;
    select.dispatch('change');
    await settle();
    assert.equal(ui.confirm().checked, false, 'another photo starts unconfirmed');
    ui.drawing().dispatch('error');
    assert.match(ui.text(), /The photo could not be shown, so no region can be saved\. Nothing was saved\./);
    ui.typeBox([1, 1, 50, 50]);
    assert.equal(ui.confirm().disabled, true);
    assert.equal(ui.panelButton('Save link').disabled, true);
    ui.panelButton('Not sure — leave unlinked').dispatch('click');
    assert.equal(ui.posts('object-1').length, 0, 'leaving unlinked writes nothing');
  });

  it('needs the scene’s own photo shown as well; its failure holds the save and clears the confirmation', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.typeBox([100, 120, 400, 600]);
    ui.drawing().dispatch('load');
    assert.equal(ui.confirm().disabled, true, 'not while the scene photo is still loading');
    const oldBase = ui.base();
    oldBase.dispatch('load');
    ui.tick();
    assert.equal(ui.panelButton('Save link').disabled, false);
    oldBase.dispatch('error');
    assert.match(ui.text(), /The scene’s own photo could not be shown, so the two boxes cannot be compared and no region can be saved\. Nothing was saved\./);
    assert.equal(ui.confirm().checked, false, 'the confirmation is cleared');
    assert.equal(ui.confirm().disabled, true);
    assert.equal(ui.panelButton('Save link').disabled, true);
    // A late answer from the earlier form's image changes nothing in a new one.
    const select = ui.select();
    select.value = P3;
    select.dispatch('change');
    await settle();
    ui.typeBox([60, 90, 300, 450]);
    ui.loadImages();
    ui.tick();
    oldBase.dispatch('error');
    assert.equal(ui.confirm().checked, true);
    assert.equal(ui.panelButton('Save link').disabled, false);
    // The reference photo failing after the confirmation clears it as well.
    ui.drawing().dispatch('error');
    assert.equal(ui.confirm().checked, false);
    assert.equal(ui.panelButton('Save link').disabled, true);
    assert.equal(ui.posts('object-1').length, 0);
  });

  it('treats a failed answer without the server’s own readable error as unknown, never as nothing changed', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.loadImages();
    ui.typeBox([100, 120, 400, 600]);
    ui.tick();
    for (const answer of [
      () => Promise.resolve({ status: 400, ok: false, json: async () => { throw new SyntaxError('proxy page'); } }),
      () => Promise.resolve(json(409, {})),
      (body) => (postLinks('object-1', body), Promise.resolve(json(502, null))),
    ]) {
      routes[`POST ${linksUrl('object-1')}`] = answer;
      ui.panelButton('Save link').dispatch('click');
      await settle();
      assert.match(ui.text(), /Rehere could not confirm this\. Pressing it again repeats the same request\./);
      assert.doesNotMatch(ui.text(), /Nothing was changed/);
    }
    delete routes[`POST ${linksUrl('object-1')}`];
    ui.panelButton('Save link').dispatch('click');
    await settle();
    const bodies = ui.posts('object-1').map((post) => post.body);
    assert.equal(bodies.length, 4);
    for (const body of bodies) assert.deepEqual(body, bodies[0], 'one identical request throughout');
    assert.match(ui.text(), /Link saved\./);
    assert.equal(store['object-1'].revision, 1, 'applied once');
  });

  it('repeats the exact request after an unclear answer and keeps the box on a conflict, saving only on a further explicit press', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.loadImages();
    ui.typeBox([100, 120, 400, 600]);
    ui.tick();
    routes[`POST ${linksUrl('object-1')}`] = (body) => (postLinks('object-1', body), lost());
    ui.panelButton('Save link').dispatch('click');
    await settle();
    assert.match(ui.text(), /Rehere could not confirm this\. Pressing it again repeats the same request\./);
    delete routes[`POST ${linksUrl('object-1')}`];
    ui.panelButton('Save link').dispatch('click');
    await settle();
    const [first, second] = ui.posts('object-1');
    assert.deepEqual(second.body, first.body, 'same request ID and body');
    assert.match(ui.text(), /Link saved\./, 'the replay shows the recorded link');
    assert.equal(store['object-1'].revision, 1, 'applied once');

    // Elsewhere the link changes; this form still uses the older revision.
    await ui.startLink(P2);
    ui.loadImages();
    assert.deepEqual(ui.inputs().map((input) => Number(input.value)), [100, 120, 400, 600], 'Change starts from the stored box');
    ui.typeBox([50, 60, 300, 500]);
    ui.tick();
    store['object-1'].links.set(P2, { box: [1, 2, 3, 4], linkedAt: '2026-11-02T11:00:00.000Z', reason: null });
    store['object-1'].revision = 2;
    ui.panelButton('Save link').dispatch('click');
    await settle();
    assert.match(ui.text(), /The links for this object changed elsewhere\. The current links are shown; your box is still here\. Save again to replace them\./);
    assert.deepEqual(ui.inputs().map((input) => Number(input.value)), [50, 60, 300, 500]);
    assert.deepEqual(store['object-1'].links.get(P2).box, [1, 2, 3, 4], 'nothing overwritten');
    ui.panelButton('Save link').dispatch('click');
    await settle();
    const [stale, replace] = ui.posts('object-1').slice(-2);
    assert.equal(stale.body.baseRevision, 1);
    assert.equal(replace.body.baseRevision, 2);
    assert.notEqual(replace.body.requestId, stale.body.requestId);
    assert.deepEqual(store['object-1'].links.get(P2).box, [50, 60, 300, 500]);
  });

  it('locks the box while a save is out, so an unclear answer repeats exactly what is shown', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.loadImages();
    ui.typeBox([100, 120, 400, 600]);
    ui.tick();
    let answer;
    routes[`POST ${linksUrl('object-1')}`] = () => new Promise((resolve) => (answer = resolve));
    ui.panelButton('Save link').dispatch('click');
    await settle();
    assert.ok(ui.inputs().every((input) => input.disabled === true), 'the box fields are locked while it is sent');
    assert.equal(ui.confirm().disabled, true);
    assert.equal(ui.select().disabled, true);
    assert.equal(ui.panelButton('Not sure — leave unlinked').disabled, true);
    ui.inputs()[2].dispatch('input');
    answer(json(503, { error: 'Unavailable.' }));
    await settle();
    delete routes[`POST ${linksUrl('object-1')}`];
    assert.match(ui.text(), /Rehere could not confirm this/);
    assert.ok(ui.inputs().every((input) => input.disabled === false), 'unlocked again');
    assert.deepEqual(ui.inputs().map((input) => Number(input.value)), [100, 120, 400, 600], 'shown as sent');
    assert.equal(ui.confirm().checked, true);
    ui.panelButton('Save link').dispatch('click');
    await settle();
    const [first, second] = ui.posts('object-1');
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(store['object-1'].links.get(P2).box, [100, 120, 400, 600]);
  });

  it('never shows unlinked after leaving an applied but unanswered link; it reads the links again', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.loadImages();
    ui.typeBox([100, 120, 400, 600]);
    ui.tick();
    routes[`POST ${linksUrl('object-1')}`] = (body) => (postLinks('object-1', body), lost());
    ui.panelButton('Save link').dispatch('click');
    await settle();
    delete routes[`POST ${linksUrl('object-1')}`];
    let release;
    routes[`GET ${linksUrl('object-1')}`] = () => new Promise((resolve) => (release = () => resolve(json(200, projection('object-1')))));
    ui.panelButton('Not sure — leave unlinked').dispatch('click');
    assert.doesNotMatch(ui.text(), /No region in another photo is linked/, 'not while the truth is unknown');
    assert.match(ui.text(), /Rehere could not confirm the earlier change, so the links are read again before they are shown\./);
    release();
    await settle();
    delete routes[`GET ${linksUrl('object-1')}`];
    assert.equal(ui.inPanel((node) => node.className === 'photo-grid region-pair').length, 1, 'the link the server holds is shown');
    assert.match(ui.text(), /Photo 2, provided by Mina: linked by you/);

    // The same for keeping a link whose removal was applied but unanswered,
    // and a re-read that fails says so instead of guessing.
    routes[`POST ${linksUrl('object-1')}`] = (body) => (postLinks('object-1', body), lost());
    ui.inPanel((node) => node.tag === 'button' && node.textContent === 'Remove link')[0].dispatch('click');
    ui.panelButton('Remove this link').dispatch('click');
    await settle();
    delete routes[`POST ${linksUrl('object-1')}`];
    routes[`GET ${linksUrl('object-1')}`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    ui.panelButton('Keep the link').dispatch('click');
    await settle();
    assert.match(ui.text(), /Linked regions could not be read right now\. This does not mean there are none\./);
    assert.doesNotMatch(ui.text(), /Photo 2, provided by Mina: linked by you/, 'the removed link is not shown as kept');
    delete routes[`GET ${linksUrl('object-1')}`];
  });

  it('says an unreadable link record could not be read, never that there are none', async () => {
    routes[`GET ${linksUrl('object-1')}`] = () => Promise.resolve(json(503, { error: 'Linked regions are unavailable right now.' }));
    const ui = await open();
    await ui.choose('A: Window');
    assert.match(ui.text(), /Linked regions could not be read right now\. This does not mean there are none\./);
    assert.doesNotMatch(ui.text(), /No region in another photo is linked/);
    assert.equal(ui.panelButton('Link a region in another photo'), undefined, 'nothing can be added over an unknown list');
    delete routes[`GET ${linksUrl('object-1')}`];
    ui.panelButton('Read the links again').dispatch('click');
    await settle();
    assert.match(ui.text(), /No region in another photo is linked to A: Window\./);
  });

  it('applies only the latest of competing reads and the latest chosen photo', async () => {
    let calls = 0;
    const held = [];
    routes[`GET ${linksUrl('object-1')}`] = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(json(503, { error: 'Unavailable.' }));
      return new Promise((resolve) => held.push(resolve));
    };
    const ui = await open();
    await ui.choose('A: Window');
    ui.panelButton('Read the links again').dispatch('click');
    ui.panelButton('Read the links again').dispatch('click');
    await settle();
    const older = { ...projection('object-1'), revision: 5, links: [{ sourceId: P2, box: [1, 1, 9, 9], imageSize: [1200, 800], linkedAt: '2026-11-02T09:00:00.000Z', available: true, reason: null }] };
    held[1](json(200, projection('object-1')));
    await settle();
    held[0](json(200, older));
    await settle();
    assert.match(ui.text(), /No region in another photo is linked to A: Window\./, 'the older read answering last changes nothing');
    delete routes[`GET ${linksUrl('object-1')}`];

    let releaseFirst;
    routes[`GET ${JOB_URL}/region-reference/${P2}`] = () => new Promise((resolve) => (releaseFirst = () => resolve(json(200, { width: 1200, height: 800 }))));
    ui.panelButton('Link a region in another photo').dispatch('click');
    const select = ui.select();
    select.value = P2;
    select.dispatch('change');
    await settle();
    delete routes[`GET ${JOB_URL}/region-reference/${P2}`];
    const again = ui.select();
    again.value = P3;
    again.dispatch('change');
    await settle();
    releaseFirst();
    await settle();
    assert.match(ui.drawing().alt, /^Photo 3\./, 'the photo chosen last stays');
    assert.equal(ui.inPanel((node) => node.tag === 'img' && node.src === asset('photo-2.jpg')).length, 0);
  });

  it('shows an unavailable link without loading its pixels and removes it only after a second confirmation', async () => {
    store['object-1'].links.set(P4, { box: null, linkedAt: '2026-11-02T09:00:00.000Z', reason: 'source' });
    store['object-1'].links.set(P2, { box: null, linkedAt: '2026-11-02T09:30:00.000Z', reason: 'checksum' });
    store['object-1'].revision = 3;
    const ui = await open();
    await ui.choose('A: Window');
    assert.match(ui.text(), /Photo 4, provided by Mina: linked by you on .*\. Its photo is no longer allowed to be used for reconstructing this place, or its use was stopped\. The link is kept but not shown\./);
    assert.match(ui.text(), /Photo 2, provided by Mina: .*no longer matches its recorded checksum/);
    assert.equal(ui.inPanel((node) => node.tag === 'img').length, 0, 'no pixels of an unavailable reference');
    assert.equal(ui.panelButton('Change region'), undefined);
    ui.inPanel((node) => node.tag === 'button' && node.textContent === 'Remove link')[0].dispatch('click');
    assert.equal(ui.posts('object-1').length, 0, 'the first press only asks');
    assert.match(ui.text(), /Remove this link\? The photo and the scene stay as they are\./);
    ui.panelButton('Remove this link').dispatch('click');
    await settle();
    assert.deepEqual(ui.posts('object-1')[0].body, { requestId: ui.posts('object-1')[0].body.requestId, baseRevision: 3, action: 'remove', sourceId: P4, box: null, confirmed: true });
    assert.match(ui.text(), /Link removed\. The photo and the scene are unchanged\./);
    assert.ok(!store['object-1'].links.has(P4));
    assert.ok(!requests.some((r) => r.url === asset('photo-4.jpg')));
  });

  it('shows a refusal for a scene that became blocked and changes nothing', async () => {
    const ui = await open();
    await ui.choose('A: Window');
    await ui.startLink(P2);
    ui.loadImages();
    ui.typeBox([100, 120, 400, 600]);
    ui.tick();
    routes[`POST ${linksUrl('object-1')}`] = () => Promise.resolve(json(403, { error: 'This scene is blocked because its photo may no longer be used here.' }));
    ui.panelButton('Save link').dispatch('click');
    await settle();
    assert.match(ui.text(), /This scene is blocked because its photo may no longer be used here\. Nothing was changed\./);
    assert.equal(store['object-1'].revision, 0);
  });

  it('drops late reads, admissions and image loads after an object switch or close, and keeps the scene, camera and unsaved change on a save', async () => {
    let releaseRead;
    routes[`GET ${linksUrl('object-1')}`] = () => new Promise((resolve) => (releaseRead = () => resolve(json(200, { ...projection('object-1'), links: [{ sourceId: P2, box: [1, 1, 9, 9], imageSize: [1200, 800], linkedAt: '2026-11-02T09:00:00.000Z', available: true, reason: null }] }))));
    const ui = await open();
    await ui.choose('A: Window');
    await ui.choose('B: Counter');
    releaseRead();
    await settle();
    assert.match(ui.text(), /for B: Counter/);
    assert.match(ui.text(), /No region in another photo is linked to B: Counter\./, 'the late read for A changes nothing');
    delete routes[`GET ${linksUrl('object-1')}`];

    // An admission answered after the panel closed draws nothing.
    let releaseReference;
    routes[`GET ${JOB_URL}/region-reference/${P2}`] = () => new Promise((resolve) => (releaseReference = () => resolve(json(200, { width: 1200, height: 800 }))));
    ui.panelButton('Link a region in another photo').dispatch('click');
    const select = ui.select();
    select.value = P2;
    select.dispatch('change');
    await settle();
    const panelBefore = ui.panel();
    ui.space.dispose();
    releaseReference();
    await settle();
    assert.equal(panelBefore.findAll((node) => node.tag === 'img').length, 0);
    assert.equal(ui.container.findAll((node) => node.className === 'region-links').length, 0);
    delete routes[`GET ${JOB_URL}/region-reference/${P2}`];

    // A save keeps the renderer, the camera and an unsaved change.
    const next = await open();
    await next.choose('A: Window');
    const x = next.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '0.4';
    x.dispatch('input');
    const renderers = globalThis.viewerLog.filter((entry) => entry === 'renderer').length;
    const camera = globalThis.viewerCamera.camera.position.toArray();
    await next.startLink(P3);
    const image = next.drawing();
    next.typeBox([60, 90, 300, 450]);
    next.loadImages();
    next.tick();
    next.panelButton('Save link').dispatch('click');
    await settle();
    assert.match(next.text(), /Link saved\./);
    image.dispatch('load');
    assert.equal(globalThis.viewerLog.filter((entry) => entry === 'renderer').length, renderers, 'the scene was not remounted');
    assert.deepEqual(globalThis.viewerCamera.camera.position.toArray(), camera);
    assert.equal(x.value, '0.4', 'the unsaved change is kept');
    assert.equal(next.button('Apply and save').disabled, false);
    assert.equal(requests.filter((r) => r.method === 'POST' && r.url === `${JOB_URL}/edit`).length, 0, 'no arrangement version');
    assert.equal(forbidden().length, 0);
  });
});
