import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The real space.js opened for one exact saved scene: the sceneId and onScene
// mount options, the secondary build disclosure and the short scene reference.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const CREATED = '2026-11-01T00:00:00.000Z';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

function job(id, overrides = {}) {
  return {
    id,
    draftId: DRAFT,
    sourceId: PHOTO,
    status: 'ready',
    createdAt: CREATED,
    error: null,
    usageBlocked: false,
    blockedReason: null,
    objectsConfirmed: true,
    objects: [
      { id: 'object-1', label: 'Counter', box: [0, 435, 226, 790], pivot: [-0.5, 0, -3] },
      { id: 'object-2', label: 'Flour stack', box: [490, 450, 982, 781], pivot: [0.5, 0, -3] },
    ],
    edit: {
      version: 1,
      objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }],
      relationship: null,
    },
    ...overrides,
  };
}
const surface = { schema_version: 2, width: 4, height: 3, depth: [], regions: [], objects: [], source: { image_size: [1000, 800] }, assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 } };

let requests;
let routes;
let mountSpace;
let mounted;

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET' });
    const handler = routes[`${options.method ?? 'GET'} ${url}`];
    return handler ? handler() : Promise.resolve(json(200, []));
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
    [`GET ${BASE}`]: () => Promise.resolve(json(200, [job(JOB), job(JOB2)])),
    [`GET ${BASE}/${JOB}`]: () => Promise.resolve(json(200, job(JOB))),
    [`GET ${BASE}/${JOB2}`]: () => Promise.resolve(json(200, job(JOB2))),
    [`GET ${BASE}/${JOB}/assets/surface.json`]: () => Promise.resolve(json(200, surface)),
    [`GET ${BASE}/${JOB2}/assets/surface.json`]: () => Promise.resolve(json(200, surface)),
  };
});

afterEach(() => {
  for (const space of mounted.splice(0)) space.dispose();
});

const granted = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true } };

async function mount({ sceneId, photos = [{ name: 'photo-1.jpg', sourceId: PHOTO }], wait = true } = {}) {
  const container = new FakeElement('section');
  const calls = [];
  const options = { draft: { id: DRAFT, photos, sources: [] }, sourceFor: () => granted, onScene: (id) => calls.push(id) };
  if (sceneId !== undefined) options.sceneId = sceneId;
  const space = mountSpace(container, options);
  mounted.push(space);
  if (wait) await settle();
  const find = (predicate) => container.findAll(predicate);
  const others = () => find((node) => node.tag === 'details' && node.className === 'space-others')[0];
  const panel = () => find((node) => node.className === 'space-panel')[0];
  const heading = () => panel().findAll((node) => node.tag === 'h3')[0]?.textContent;
  const openButton = (ref) => find((node) => node.tag === 'button' && node.textContent === 'Open scene' && node.attributes['aria-label'].includes(`Scene ${ref}`))[0];
  // The distinct saved scenes this mount touched, in first-use order.
  const jobFetches = () => [...new Set(requests.filter((r) => r.url.startsWith(`${BASE}/`)).map((r) => r.url.slice(BASE.length + 1, BASE.length + 37)))];
  const labels = () => find((node) => node.className === 'space-builds')[0].findAll((node) => node.className === 'space-choice-label').map((node) => node.textContent);
  const posts = () => requests.filter((r) => r.method !== 'GET');
  return { container, space, calls, find, others, panel, heading, openButton, jobFetches, labels, posts };
}

describe('opening one exact saved scene', () => {
  it('opens only the named scene, reports it and puts it before the secondary build choices', async () => {
    const ui = await mount({ sceneId: JOB2 });
    assert.deepEqual(ui.jobFetches(), [JOB2], 'no other scene is fetched or chosen');
    assert.deepEqual(ui.calls, [JOB2]);
    assert.equal(ui.heading(), 'Partial scene from photo 1 · Scene dddddddd');
    assert.equal(ui.others().open, false, 'build choices close once the scene is open');
    const order = ui.container.children;
    assert.ok(order.indexOf(ui.panel()) < order.indexOf(ui.others()), 'the selected scene comes first in DOM order');
    assert.match(ui.others().children[0].textContent, /^Build or choose another scene$/);
    assert.equal(ui.posts().length, 0, 'navigation sends no build, model or share request');
  });

  it('without a scene opens nothing, keeps the build choices open and never reports', async () => {
    const ui = await mount();
    assert.deepEqual(ui.jobFetches(), []);
    assert.deepEqual(ui.calls, []);
    assert.equal(ui.others().open, true);
    assert.equal(ui.panel().children.length, 0);
  });

  it('tells apart two builds of one photo made in the same minute, and reports the exact chosen one', async () => {
    const ui = await mount();
    const labels = ui.labels();
    assert.equal(labels.length, 2);
    assert.notEqual(labels[0], labels[1]);
    assert.match(labels[0], /· Scene cccccccc$/);
    assert.match(labels[1], /· Scene dddddddd$/);
    const buttons = ui.find((node) => node.tag === 'button' && node.textContent === 'Open scene');
    assert.notEqual(buttons[0].attributes['aria-label'], buttons[1].attributes['aria-label']);
    assert.ok(!ui.container.textContent.includes(JOB) && !ui.container.textContent.includes(JOB2), 'never the full ID');
    for (const button of buttons) assert.ok(!button.attributes['aria-label'].includes(JOB) && !button.attributes['aria-label'].includes(JOB2));
    assert.equal(ui.others().open, true);
    ui.openButton('dddddddd').dispatch('click');
    await settle();
    assert.deepEqual(ui.calls, [JOB2]);
    assert.equal(ui.others().open, false, 'an explicit successful open closes the other choices');
    assert.deepEqual(ui.jobFetches(), [JOB2]);
    assert.equal(ui.heading(), 'Partial scene from photo 1 · Scene dddddddd');
    ui.openButton('cccccccc').dispatch('click');
    await settle();
    assert.deepEqual(ui.calls, [JOB2, JOB], 'a new explicit choice reports that scene');
  });
});

describe('continuing from an opened scene', () => {
  it('moves focus to the existing sections without triggering their actions', async () => {
    const ui = await mount({ sceneId: JOB });
    const nav = ui.find((node) => node.tag === 'nav' && node.attributes['aria-label'] === 'Continue with this place')[0];
    assert.ok(nav);
    const findTarget = (predicate) => ui.find(predicate)[0];
    assert.equal(nav.children[0].attributes['aria-hidden'], 'true', 'the visible label does not repeat the navigation name');
    // The fake DOM has no selectors; answer the heading query the way a browser would.
    const heading = (text) => {
      const section = findTarget((node) => node.tag === 'section' && node.children[0]?.tag === 'h4' && node.children[0].textContent === text);
      section.querySelector = (selector) => (selector === 'h4' ? section.children[0] : null);
      return section.children[0];
    };
    const memory = heading('Change it from a memory');
    const recollections = heading('Recollections from others');
    const invite = findTarget((node) => node.tag === 'details' && node.className === 'source-details collab-invitations');
    const sharing = findTarget((node) => node.tag === 'details' && node.className === 'source-details share-panel');
    const clicks = [
      ['Change from a memory', memory],
      ['Review recollections', recollections],
      ['Invite someone', invite.children[0]],
      ['Visitor sharing', sharing.children[0]],
    ];
    for (const [label, target] of clicks) {
      let focused = false;
      let scrolled = false;
      target.focus = () => { focused = true; };
      target.scrollIntoView = () => { scrolled = true; };
      nav.findAll((node) => node.tag === 'button' && node.textContent === label)[0].dispatch('click');
      assert.equal(focused, true, label);
      assert.equal(scrolled, true, label);
    }
    assert.equal(memory.attributes.tabindex, '-1', 'focus lands on the named section heading');
    assert.equal(recollections.attributes.tabindex, '-1');
    assert.equal(invite.open, true);
    assert.equal(sharing.open, true);
    assert.equal(invite.children[0].attributes.tabindex, undefined, 'the invitation summary remains keyboard reachable');
    assert.equal(sharing.children[0].attributes.tabindex, undefined, 'the sharing summary remains keyboard reachable');
    assert.equal(ui.posts().length, 0, 'navigation sends no model, contribution or share action');
    assert.deepEqual(ui.calls, [JOB]);
  });

  it('keeps the outline check first when two objects are not confirmed', async () => {
    routes[`GET ${BASE}/${JOB}`] = () => Promise.resolve(json(200, job(JOB, { objectsConfirmed: false })));
    const ui = await mount({ sceneId: JOB });
    assert.match(ui.panel().textContent, /Check the two outlines/);
    assert.equal(ui.find((node) => node.tag === 'nav' && node.attributes['aria-label'] === 'Continue with this place').length, 0);
    assert.equal(ui.posts().length, 0);
  });
});

describe('a scene that cannot be shown keeps its address and offers the other choices', () => {
  const cases = {
    unknown: [() => Promise.resolve(json(404, { error: 'Not found.' })), /^This scene could not be found\.$/],
    unfinished: [() => Promise.resolve(json(200, job(JOB, { status: 'processing' }))), /^This scene is not ready to open\.Building\./],
    failed: [() => Promise.resolve(json(200, job(JOB, { status: 'failed', error: 'The build did not finish.' }))), /^This scene is not ready to open\.Failed\./],
    unavailable: [() => Promise.resolve(json(503, { error: 'Busy.' })), /^This scene could not be opened\.$/],
  };
  for (const [name, [handler, text]] of Object.entries(cases)) {
    it(`${name}: a truthful status, no other scene and the build choices open`, async () => {
      routes[`GET ${BASE}/${JOB}`] = handler;
      const ui = await mount({ sceneId: JOB });
      assert.match(ui.panel().textContent, text);
      assert.deepEqual(ui.calls, [JOB], 'the route keeps naming the requested scene');
      assert.deepEqual(ui.jobFetches(), [JOB]);
      assert.equal(ui.others().open, true);
      assert.equal(ui.posts().length, 0);
    });
  }

  it('mounts with no shown photos and shows the exact scene as no longer shown', async () => {
    routes[`GET ${BASE}`] = () => Promise.resolve(json(200, [job(JOB, { usageBlocked: true, blockedReason: 'source' })]));
    routes[`GET ${BASE}/${JOB}`] = () => Promise.resolve(json(200, job(JOB, { usageBlocked: true, blockedReason: 'source' })));
    const ui = await mount({ sceneId: JOB, photos: [] });
    assert.equal(ui.heading(), 'This scene is no longer shown · Scene cccccccc');
    assert.deepEqual(ui.calls, [JOB]);
    assert.equal(ui.others().open, true);
    assert.match(ui.labels()[0], /^A photo no longer shown · .* · Scene cccccccc$/);
    const aria = ui.openButton('cccccccc').attributes['aria-label'];
    assert.match(aria, /^Open the partial scene from a photo no longer shown built .*, Scene cccccccc$/);
    assert.doesNotMatch(aria, /photo 0/);
    assert.equal(ui.posts().length, 0);
  });
});

describe('lifecycle', () => {
  for (const [outcome, overrides, notice] of [
    ['ready', {}, 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.'],
    ['failed', { status: 'failed', error: 'The build failed.' }, 'Photo 1: Failed. The build failed.'],
  ]) {
    it(`a ${outcome} background build is announced in text without replacing an explicitly opened scene`, async () => {
      const pending = deferred();
      const building = job(JOB, { status: 'processing' });
      routes[`GET ${BASE}`] = () => Promise.resolve(json(200, [building, job(JOB2)]));
      routes[`GET ${BASE}/${JOB}`] = () => pending.promise;
      const ui = await mount();
      ui.openButton('dddddddd').dispatch('click');
      await settle();
      const before = ui.panel().textContent;
      const status = ui.container.children.find((node) => node.role === 'status');
      const statusBefore = status.textContent;
      const focused = [];
      const focus = FakeElement.prototype.focus;
      FakeElement.prototype.focus = function () { focused.push(this); };
      routes[`GET ${BASE}`] = () => Promise.resolve(json(200, [job(JOB, overrides), job(JOB2)]));
      try {
        pending.resolve(json(200, job(JOB, overrides)));
        await settle();
      } finally {
        FakeElement.prototype.focus = focus;
      }
      assert.equal(ui.find((node) => node.className === 'hint space-background')[0].textContent, notice);
      assert.equal(status.textContent, statusBefore, 'the creator\'s status line is left alone');
      assert.equal(focused.length, 0, 'completion does not move focus');
      assert.deepEqual(ui.calls, [JOB2]);
      assert.equal(ui.panel().textContent, before);
      assert.equal(ui.others().open, false, 'the other choices stay as the creator left them');
      assert.equal(ui.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
      assert.equal(ui.posts().length, 0);
    });
  }

  it('an explicit build choice reports no scene', async () => {
    const ui = await mount({ sceneId: JOB });
    ui.find((node) => node.tag === 'button' && node.textContent === 'Build a partial scene')[0].dispatch('click');
    await settle();
    assert.deepEqual(ui.calls, [JOB, null]);
    assert.equal(ui.posts().length, 0, 'choosing to build starts nothing');
  });

  it('dispose during a pending open never reports or renders', async () => {
    const pending = deferred();
    routes[`GET ${BASE}/${JOB}`] = () => pending.promise;
    const ui = await mount({ sceneId: JOB });
    assert.equal(ui.others().open, false, 'a named scene starts with the other choices closed');
    const before = ui.panel().textContent;
    ui.space.dispose();
    pending.resolve(json(200, job(JOB)));
    await settle();
    assert.deepEqual(ui.calls, []);
    assert.equal(ui.panel().textContent, '');
    assert.ok(before.startsWith('Opening the scene'));
    assert.equal(requests.some((r) => r.url.endsWith('/assets/surface.json')), false);
  });

  it('a later explicit choice wins over a slower initial open', async () => {
    const pending = deferred();
    routes[`GET ${BASE}/${JOB}`] = () => pending.promise;
    const ui = await mount({ sceneId: JOB });
    ui.openButton('dddddddd').dispatch('click');
    await settle();
    pending.resolve(json(200, job(JOB)));
    await settle();
    assert.deepEqual(ui.calls, [JOB2], 'the stale open never reports');
    assert.equal(ui.heading(), 'Partial scene from photo 1 · Scene dddddddd');
    assert.equal(requests.some((r) => r.url === `${BASE}/${JOB}/assets/surface.json`), false);
  });
});

describe('landing on the selected scene', () => {
  // A spy on the fake DOM for this file only; the shared fake DOM is unchanged.
  let scrolls;
  before(() => {
    FakeElement.prototype.scrollIntoView = function scrollIntoView(options) {
      scrolls.push({ tag: this.tag, text: this.textContent, options });
    };
  });
  after(() => {
    delete FakeElement.prototype.scrollIntoView;
  });
  beforeEach(() => {
    scrolls = [];
  });

  it('a direct route lands once on the admitted scene heading', async () => {
    await mount({ sceneId: JOB2 });
    assert.deepEqual(scrolls, [{ tag: 'h3', text: 'Partial scene from photo 1 · Scene dddddddd', options: { block: 'start' } }]);
  });

  it('an explicit open lands on its heading, and the list alone never scrolls', async () => {
    const ui = await mount();
    assert.deepEqual(scrolls, []);
    ui.openButton('cccccccc').dispatch('click');
    await settle();
    assert.deepEqual(scrolls.map((entry) => entry.text), ['Partial scene from photo 1 · Scene cccccccc']);
  });

  it('a blocked or unknown scene lands on its truthful status', async () => {
    routes[`GET ${BASE}/${JOB}`] = () => Promise.resolve(json(200, job(JOB, { usageBlocked: true, blockedReason: 'source' })));
    await mount({ sceneId: JOB, photos: [] });
    routes[`GET ${BASE}/${JOB2}`] = () => Promise.resolve(json(404, { error: 'Not found.' }));
    await mount({ sceneId: JOB2 });
    assert.deepEqual(scrolls.map((entry) => entry.text), ['This scene is no longer shown · Scene cccccccc', 'This scene could not be found.']);
  });

  it('a stale or disposed open never scrolls', async () => {
    const pending = deferred();
    routes[`GET ${BASE}/${JOB}`] = () => pending.promise;
    const ui = await mount({ sceneId: JOB });
    ui.openButton('dddddddd').dispatch('click');
    await settle();
    pending.resolve(json(200, job(JOB)));
    await settle();
    assert.deepEqual(scrolls.map((entry) => entry.text), ['Partial scene from photo 1 · Scene dddddddd']);
    const late = deferred();
    routes[`GET ${BASE}/${JOB2}`] = () => late.promise;
    const other = await mount({ sceneId: JOB2 });
    other.space.dispose();
    late.resolve(json(200, job(JOB2)));
    await settle();
    assert.equal(scrolls.length, 1, 'nothing scrolls after dispose');
  });
});
