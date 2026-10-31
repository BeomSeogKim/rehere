import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The real space.js on a two-object scene; Three.js runs through the viewer
// stand-ins and the relation math is the shared scene-relations module.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const RULE = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
function arrangement(overrides = {}) {
  return {
    version: 1,
    objects: [
      { id: 'object-1', offset: [0, 0, 0], yaw: 0 },
      { id: 'object-2', offset: [0, 0, 0], yaw: 0 },
    ],
    relationship: null,
    ...overrides,
  };
}
const zeroB = { id: 'object-2', offset: [0, 0, 0], yaw: 0 };
function job(overrides = {}) {
  return {
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
    [`GET /api/drafts/${DRAFT}/sources/${PHOTO}/image-size`]: () => Promise.resolve(json(200, { width: 1000, height: 800 })),
  };
});

afterEach(() => {
  for (const space of mounted.splice(0)) space.dispose();
});

async function mount() {
  const container = new FakeElement('section');
  const draft = { id: DRAFT, photos: [{ name: 'photo-1.jpg', sourceId: PHOTO }], sources: [] };
  const granted = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true } };
  const space = mountSpace(container, { draft, sourceFor: () => granted });
  mounted.push(space);
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const posts = (suffix) => requests.filter((r) => r.method === 'POST' && r.url === `${JOB_URL}${suffix}`);
  const text = () => container.textContent;
  return { container, find, button, posts, text };
}

async function openScene(ui) {
  ui.button('Open scene').dispatch('click');
  await settle();
}

describe('two-object build selection', () => {
  it('sends two named boxes in order, and asks for distinct names', async () => {
    const ui = await mount();
    ui.button('Build with two objects').dispatch('click');
    await settle();
    ui.find((node) => node.tag === 'img')[0].dispatch('load');
    const fieldsets = ui.find((node) => node.tag === 'fieldset');
    const fill = (set, label, box) => {
      const [name, ...edges] = set.findAll((node) => node.tag === 'input');
      name.value = label;
      name.dispatch('input');
      box.forEach((value, i) => (edges[i].value = String(value)));
      edges[0].dispatch('input');
    };
    fill(fieldsets[0], 'Counter', [0, 435, 226, 790]);
    fill(fieldsets[1], ' counter ', [490, 450, 982, 781]);
    assert.equal(ui.button('Build partial scene with two objects').disabled, true, 'names must differ');
    fill(fieldsets[1], 'Flour stack', [490, 450, 982, 781]);
    assert.match(ui.text(), /A: Counter/);
    assert.match(ui.text(), /B: Flour stack/);
    routes[`POST ${BASE}`] = () => Promise.resolve(json(202, { id: JOB, sourceId: PHOTO, status: 'queued', createdAt: '2026-11-01T00:00:00.000Z' }));
    ui.button('Build partial scene with two objects').dispatch('click');
    await settle();
    const [sent] = requests.filter((r) => r.method === 'POST' && r.url === BASE);
    assert.deepEqual(sent.body, {
      requestId: sent.body.requestId,
      sourceId: PHOTO,
      objects: [
        { label: 'Counter', box: [0, 435, 226, 790] },
        { label: 'Flour stack', box: [490, 450, 982, 781] },
      ],
    });
  });
});

describe('two-object scene', () => {
  it('stays read-only until both outlines are confirmed, then opens for editing', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ objectsConfirmed: false })));
    const ui = await mount();
    await openScene(ui);
    assert.match(ui.text(), /Check the two outlines/);
    assert.match(ui.text(), /White: the two outlines overlapped there; those pixels are left empty/);
    assert.equal(ui.button('Apply and save'), undefined, 'no editing before confirmation');
    routes[`POST ${JOB_URL}/objects/confirm`] = lost;
    ui.button('The outlines match A and B').dispatch('click');
    await settle();
    routes[`POST ${JOB_URL}/objects/confirm`] = () => Promise.resolve(json(200, job()));
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job()));
    ui.button('The outlines match A and B').dispatch('click');
    await settle();
    const sent = ui.posts('/objects/confirm');
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.deepEqual(sent[0].body, { requestId: sent[0].body.requestId, objectIds: ['object-1', 'object-2'] });
    assert.ok(ui.button('Apply and save'), 'editing opens after confirmation');
  });

  it('moves only the chosen object and saves it by target, adopting the whole saved arrangement', async () => {
    const ui = await mount();
    await openScene(ui);
    assert.match(ui.text(), /Choose an object to move/);
    ui.button('B: Flour stack').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '0.5';
    x.dispatch('input');
    assert.match(ui.text(), /Preview only: B: Flour stack moved/);
    routes[`POST ${JOB_URL}/edit`] = (body) => Promise.resolve(json(200, arrangement({ version: 2, objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: body.offset, yaw: body.yaw }] })));
    ui.button('Apply and save').dispatch('click');
    await settle();
    const [sent] = ui.posts('/edit');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseVersion: 1, targetId: 'object-2', offset: [0.5, 0, 0], yaw: 0 });
    assert.match(ui.text(), /Saved, version 2\./);
  });

  it('will not switch objects over an unsaved change, and switching stops any playback', async () => {
    const playback = await import('../public/playback.js');
    let stopped = 0;
    playback.claim('test-audio', () => (stopped += 1));
    const ui = await mount();
    await openScene(ui);
    ui.button('A: Counter').dispatch('click');
    assert.equal(stopped, 1, 'choosing an object stops playing audio');
    assert.ok(ui.find((node) => node.tag === 'summary' && node.textContent === 'Photo evidence for A: Counter').length, 'the collapsed evidence names the chosen object');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '0.2';
    x.dispatch('input');
    ui.button('B: Flour stack').dispatch('click');
    assert.match(ui.text(), /Save or revert your change to A: Counter first\./);
    assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true');
  });

  it('describes the left–right order from the original photo and refuses a change that breaks the rule', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: arrangement({ relationship: RULE }) })));
    const ui = await mount();
    await openScene(ui);
    assert.match(ui.text(), /Saved: From the original photo, A: Counter is left of B: Flour stack\./);
    assert.match(ui.text(), /Current rule: A: Counter stays left of B: Flour stack from the original photo\./);
    ui.button('A: Counter').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '1.5';
    x.dispatch('input');
    assert.match(ui.text(), /Shown now, your unsaved change: From the original photo, B: Flour stack is left of A: Counter\./);
    assert.match(ui.text(), /This change would break your rule/);
    assert.equal(ui.button('Apply and save').disabled, true);
    ui.button('Apply and save').dispatch('click');
    assert.equal(ui.posts('/edit').length, 0, 'nothing is sent');
  });

  it('saves a rule only with explicit confirmation and only if the saved arrangement meets it', async () => {
    const ui = await mount();
    await openScene(ui);
    const ruleBox = ui.find((node) => node.tag === 'fieldset' && /Rule between the two objects/.test(node.textContent))[0];
    const order = ruleBox.findAll((node) => node.tag === 'select')[0];
    assert.equal(order.value, 'object-1|object-2', 'the first order is chosen by default');
    assert.equal(ui.button('Save this rule').disabled, true);
    const confirm = ui.find((node) => node.tag === 'label' && /I want to change the rule/.test(node.textContent))[0].children[0];
    confirm.checked = true;
    confirm.dispatch('change');
    order.value = 'object-2|object-1';
    ui.button('Save this rule').dispatch('click');
    assert.match(ui.text(), /does not meet this rule now \(the order is the other way\)/);
    assert.equal(ui.posts('/relationship').length, 0);
    order.value = 'object-1|object-2';
    routes[`POST ${JOB_URL}/relationship`] = () => Promise.resolve(json(200, arrangement({ version: 2, relationship: RULE })));
    ui.button('Save this rule').dispatch('click');
    await settle();
    const [sent] = ui.posts('/relationship');
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseVersion: 1, relationship: RULE, confirmed: true });
    assert.match(ui.text(), /Saved as version 2: A: Counter stays left of B: Flour stack/);
  });

  it('keeps the typed text of the chosen object while typing and recovers from an intermediate value', async () => {
    const ui = await mount();
    await openScene(ui);
    ui.button('A: Counter').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    const slider = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right slider')[0];
    for (const typed of ['0.', '0.4']) {
      x.value = typed;
      x.dispatch('input');
      assert.equal(x.value, typed, 'the field being typed is not rewritten');
    }
    assert.equal(slider.value, '0.4');
    x.value = '';
    x.dispatch('input');
    assert.equal(x.value, '');
    assert.equal(ui.button('Apply and save').disabled, true);
    x.value = '0.4';
    x.dispatch('input');
    x.dispatch('blur');
    assert.equal(x.value, '0.4');
    routes[`POST ${JOB_URL}/edit`] = (body) => Promise.resolve(json(200, arrangement({ version: 2, objects: [{ id: 'object-1', offset: body.offset, yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }] })));
    ui.button('Apply and save').dispatch('click');
    await settle();
    assert.deepEqual(ui.posts('/edit')[0].body.offset, [0.4, 0, 0]);
  });

  it('never saves the last valid preview behind an invalid field, and holds the object and rule until it is fixed or reverted', async () => {
    const ui = await mount();
    await openScene(ui);
    ui.button('A: Counter').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    x.value = '0.3';
    x.dispatch('input');
    x.value = '40';
    x.dispatch('input');
    x.dispatch('blur');
    assert.equal(x.value, '40', 'the invalid draft stays visible');
    assert.equal(ui.button('Apply and save').disabled, true);
    ui.button('Apply and save').dispatch('click');
    assert.equal(ui.posts('/edit').length, 0, 'the cached 0.3 is not sent');
    ui.button('Revert to saved').dispatch('click');
    assert.equal(x.value, '0');
    x.value = '40';
    x.dispatch('input');
    assert.equal(ui.button('Revert to saved').disabled, false, 'revert is offered over a clean preview');
    ui.button('B: Flour stack').dispatch('click');
    assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true', 'the object cannot change under an invalid draft');
    const confirm = ui.find((node) => node.tag === 'label' && /I want to change the rule/.test(node.textContent))[0].children[0];
    confirm.checked = true;
    confirm.dispatch('change');
    assert.equal(ui.button('Save this rule').disabled, true);
    x.value = '0.3';
    x.dispatch('input');
    assert.equal(ui.button('Apply and save').disabled, false, 'valid typing recovers');
    routes[`POST ${JOB_URL}/edit`] = (body) => Promise.resolve(json(200, arrangement({ version: 2, objects: [{ id: 'object-1', offset: body.offset, yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }] })));
    ui.button('Apply and save').dispatch('click');
    await settle();
    assert.deepEqual(ui.posts('/edit')[0].body.offset, [0.3, 0, 0]);
  });

  it('pauses editing while a rule change is pending, and retries an unknown outcome exactly before anything else changes', async () => {
    const ui = await mount();
    await openScene(ui);
    ui.button('A: Counter').dispatch('click');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Left / right')[0];
    const confirm = ui.find((node) => node.tag === 'label' && /I want to change the rule/.test(node.textContent))[0].children[0];
    confirm.checked = true;
    confirm.dispatch('change');
    let answer;
    routes[`POST ${JOB_URL}/relationship`] = () => new Promise((resolve) => (answer = resolve));
    ui.button('Save this rule').dispatch('click');
    await settle();
    assert.match(ui.text(), /Saving the rule…/);
    assert.equal(x.disabled, true, 'no manual change while the rule is pending');
    ui.button('B: Flour stack').dispatch('click');
    assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true', 'no switching while the rule is pending');
    answer({ status: 0, ok: false, json: async () => null });
    await settle();
    assert.match(ui.text(), /could not confirm whether the rule change was saved/);
    assert.equal(x.disabled, true, 'an unknown rule outcome blocks new edits');
    ui.button('B: Flour stack').dispatch('click');
    assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true');
    const order = ui.find((node) => node.tag === 'fieldset' && /Rule between the two objects/.test(node.textContent))[0].findAll((node) => node.tag === 'select')[0];
    order.value = 'object-2|object-1';
    routes[`POST ${JOB_URL}/relationship`] = () => Promise.resolve(json(200, arrangement({ version: 2, relationship: RULE })));
    ui.button('Retry the earlier rule change').dispatch('click');
    await settle();
    const sent = ui.posts('/relationship');
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body, sent[0].body, 'the retry is the same request');
    assert.deepEqual(sent[0].body.relationship, RULE);
    assert.match(ui.text(), /Saved as version 2: A: Counter stays left of B: Flour stack/);
    assert.equal(x.disabled, false, 'editing resumes once the outcome is known');
    x.value = '0.1';
    x.dispatch('input');
    assert.match(ui.text(), /Preview only: A: Counter moved/);
  });

  it('keeps an invalid field as typed when another field changes, and sends nothing until every field is valid', async () => {
    const ui = await mount();
    await openScene(ui);
    ui.button('A: Counter').dispatch('click');
    const axis = (name) => ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === name)[0];
    const [x, y] = [axis('Left / right'), axis('Down / up')];
    x.value = '0.4';
    x.dispatch('input');
    x.value = '40';
    x.dispatch('input');
    x.dispatch('blur');
    y.value = '0.1';
    y.dispatch('input');
    y.dispatch('blur');
    assert.equal(x.value, '40', 'the invalid field is not reset to the cached 0.4');
    assert.equal(ui.button('Apply and save').disabled, true);
    ui.button('Apply and save').dispatch('click');
    assert.equal(ui.posts('/edit').length, 0);
    x.value = '0.3';
    x.dispatch('input');
    routes[`POST ${JOB_URL}/edit`] = (body) => Promise.resolve(json(200, arrangement({ version: 2, objects: [{ id: 'object-1', offset: body.offset, yaw: 0 }, zeroB] })));
    ui.button('Apply and save').dispatch('click');
    await settle();
    assert.deepEqual(ui.posts('/edit')[0].body.offset, [0.3, 0.1, 0]);
  });

  it('lets the saved version be loaded to settle an unknown rule outcome', async () => {
    const ui = await mount();
    await openScene(ui);
    const confirm = ui.find((node) => node.tag === 'label' && /I want to change the rule/.test(node.textContent))[0].children[0];
    confirm.checked = true;
    confirm.dispatch('change');
    routes[`POST ${JOB_URL}/relationship`] = lost;
    ui.button('Save this rule').dispatch('click');
    await settle();
    assert.match(ui.text(), /could not confirm whether the rule change was saved/);
    const reload = ui.button('Load saved version');
    assert.equal(reload.hidden, false);
    assert.equal(reload.disabled, false);
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: arrangement({ version: 2, relationship: RULE }) })));
    reload.dispatch('click');
    await settle();
    assert.match(ui.text(), /Saved, version 2\. Choose an object to move\./);
    assert.equal(ui.button('Save this rule').textContent, 'Save this rule');
    ui.button('A: Counter').dispatch('click');
    assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true', 'editing resumes after the reload');
  });

  describe('see the photographed side', () => {
    // A surface the real two-object builder accepts, so a 3D view exists:
    // object A on the left (columns 2-6), B on the right (columns 13-17).
    const GRID = 20;
    const drawable = {
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
        { id: 'object-1', label: 'Counter', box_xyxy: [0, 435, 226, 790] },
        { id: 'object-2', label: 'Flour stack', box_xyxy: [490, 450, 982, 781] },
      ],
      assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
      source: { image_size: [1000, 800] },
    };
    const DEG = Math.PI / 180;
    const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);
    const cameraNow = () => ({ position: globalThis.viewerCamera.camera.position.toArray(), target: globalThis.viewerCamera.controls.target.toArray() });

    it('inspects the selected object as drawn, keeps the camera through Show saved, and changes nothing', async () => {
      const { photographedSideCamera } = await import('../public/scene-viewer.js');
      routes[`GET ${JOB_URL}/assets/surface.json`] = () => Promise.resolve(json(200, drawable));
      const ui = await mount();
      await openScene(ui);
      assert.equal(ui.button('See photographed side (choose an object first)').disabled, true);
      ui.button('B: Flour stack').dispatch('click');
      const turn = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Turn (degrees)')[0];
      turn.value = '150';
      turn.dispatch('input');
      const strip = () => ui.find((node) => node.className === 'relation-strip')[0].textContent;
      const stripBefore = strip();
      ui.button('See photographed side of B: Flour stack').dispatch('click');
      const now = cameraNow();
      assert.ok(now.target[0] > 0, 'it looks at B, the right-hand object');
      assert.ok(close(now.position, photographedSideCamera(now.target, { offset: [0, 0, 0], yaw: 150 * DEG }).position), 'from B’s drawn 150° preview');
      assert.match(ui.text(), /Camera moved to inspect the photographed side of B: Flour stack, as it was drawn when you pressed the button\./);
      assert.equal(strip(), stripBefore, 'comparisons use the original camera, unchanged');
      assert.match(ui.text(), /Preview only: B: Flour stack moved/);
      assert.equal(requests.filter((r) => r.method === 'POST').length, 0, 'nothing is saved');

      ui.button('Show saved arrangement').dispatch('click');
      assert.deepEqual(cameraNow(), now, 'showing the saved arrangement does not move the camera');
      ui.button('See photographed side of B: Flour stack').dispatch('click');
      assert.ok(close(cameraNow().position, photographedSideCamera(now.target, { offset: [0, 0, 0], yaw: 0 }).position), 'pressed again, it uses the drawn saved state');
      ui.button('Original viewpoint').dispatch('click');
      assert.doesNotMatch(ui.text(), /Camera moved/);
    });

    it('is never offered before both outlines are confirmed, and stays disabled without a 3D view', async () => {
      routes[`GET ${JOB_URL}/assets/surface.json`] = () => Promise.resolve(json(200, drawable));
      routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ objectsConfirmed: false })));
      const unconfirmed = await mount();
      await openScene(unconfirmed);
      const offered = unconfirmed.find((node) => node.tag === 'button' && /^See photographed side/.test(node.textContent));
      assert.equal(offered.length, 1);
      assert.equal(offered[0].hidden, true, 'hidden before confirmation');
      assert.equal(offered[0].disabled, true, 'and never enabled');
      const camera = cameraNow();
      offered[0].dispatch('click');
      assert.deepEqual(cameraNow(), camera, 'pressing it does nothing');
      assert.doesNotMatch(unconfirmed.text(), /Camera moved/);

      routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job()));
      routes[`GET ${JOB_URL}/assets/surface.json`] = () => Promise.resolve(json(200, surface));
      const fallback = await mount();
      await openScene(fallback);
      assert.match(fallback.text(), /could not be shown/, 'no 3D view');
      fallback.button('B: Flour stack').dispatch('click');
      assert.equal(fallback.button('See photographed side of B: Flour stack').disabled, true);
    });

    it('inspects the object a panel preview is about, even when another object is selected', async () => {
      routes[`GET ${JOB_URL}/assets/surface.json`] = () => Promise.resolve(json(200, drawable));
      const proposal = {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        baseVersion: 1,
        targetId: 'object-2',
        statement: { id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', kind: 'human_memory', text: 'The flour turned round.', sha256: 'a'.repeat(64), modelConsent: true },
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        status: 'ready',
        result: { action: 'rotate', targetId: 'object-2', sourceId: PHOTO, baseVersion: 1, delta: null, yawDelta: 150 * DEG, anchor: null, question: null, reason: 'It turned.', transform: { offset: [0, 0, 0], yaw: 150 * DEG } },
        question: null,
        error: null,
        model: 'muse-spark-1.3',
        usage: null,
        responseId: null,
        appliedVersion: null,
      };
      routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [proposal]));
      const ui = await mount();
      await openScene(ui);
      ui.button('A: Counter').dispatch('click');
      assert.ok(ui.button('See photographed side of A: Counter'));
      ui.button('Preview on the scene').dispatch('click');
      assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true', 'A stays selected');
      ui.button('See photographed side of B: Flour stack').dispatch('click');
      assert.ok(cameraNow().target[0] > 0, 'the camera inspects B, the object the preview is about');
      ui.button('Stop preview').dispatch('click');
      assert.ok(ui.button('See photographed side of A: Counter'), 'with the preview gone it names the selected object again');
    });
  });
});
