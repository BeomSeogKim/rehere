import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { surfaceMeshes, surfacePoint } from '../public/photo-scene.js';

// Node has no WebGL, so the renderer, texture loader and controls are replaced
// with recording stand-ins. Geometry and material are the real Three.js classes
// with their dispose() recorded; scene building itself is unchanged.
const three = import.meta.resolve('three');
const threeShim = `
export * from '${three}';
import * as T from '${three}';
const log = (entry) => globalThis.viewerLog.push(entry);
const failing = (step) => globalThis.viewerFail === step;
export class WebGLRenderer {
  constructor() {
    if (failing('webgl')) throw new Error('no context');
    this.domElement = document.createElement('canvas');
    log('renderer');
  }
  setPixelRatio() {}
  setSize() {}
  render(scene) { globalThis.lastRenderedScene = scene; }
  dispose() { log('renderer.dispose'); }
  forceContextLoss() { log('renderer.forceContextLoss'); }
}
export class TextureLoader {
  async loadAsync() {
    if (failing('texture')) throw new Error('404');
    const texture = new T.Texture();
    texture.dispose = () => log('texture.dispose');
    log('texture');
    return texture;
  }
}
export class BufferGeometry extends T.BufferGeometry {
  dispose() { log('geometry.dispose'); super.dispose(); }
}
export class MeshBasicMaterial extends T.MeshBasicMaterial {
  dispose() { log('material.dispose'); super.dispose(); }
}
export class ArrowHelper extends T.ArrowHelper {
  constructor(direction, origin, ...rest) {
    super(direction, origin, ...rest);
    log('arrow ' + [...direction.toArray(), ...origin.toArray()].map((value) => value.toFixed(3)).join(' '));
  }
  dispose() { log('arrow.dispose'); super.dispose(); }
}
export class Line extends T.Line {
  constructor(geometry, material) {
    super(geometry, material);
    log('line ' + Array.from(geometry.attributes.position.array, (value) => value.toFixed(3)).join(' '));
  }
}`;
const controlsShim = `
import { Vector3 } from '${three}';
export class OrbitControls {
  constructor(camera) {
    this.object = camera;
    this.target = new Vector3();
    globalThis.viewerControls = this;
    globalThis.viewerLog.push('controls');
  }
  listenToKeyEvents() {}
  addEventListener() {}
  update() {}
  dispose() { globalThis.viewerLog.push('controls.dispose'); }
}`;
const SHIMS = {
  '/vendor/three.module.js': `data:text/javascript,${encodeURIComponent(threeShim)}`,
  '/vendor/OrbitControls.js': `data:text/javascript,${encodeURIComponent(controlsShim)}`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    return SHIMS[specifier] ? { url: SHIMS[specifier], shortCircuit: true } : nextResolve(specifier, context);
  },
});

class FakeResizeObserver {
  constructor(callback) {
    globalThis.viewerResize = callback;
  }
  observe() {
    if (globalThis.viewerFail === 'observe') throw new Error('observe failed');
    globalThis.viewerLog.push('observer');
  }
  disconnect() {
    globalThis.viewerLog.push('observer.disconnect');
  }
}

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function surface() {
  const width = 6;
  const height = 5;
  const foreground = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) foreground.push(x >= 2 && x <= 4 && y >= 1 && y <= 3 ? 1 : 0);
  return {
    source: { source_id: SOURCE_ID, sha256: 'b'.repeat(64), image_size: [600, 500] },
    width,
    height,
    depth: foreground.map((selected) => (selected ? 3.9 : 4)),
    foreground,
    assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  };
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

let mountSpace;
let job;
let surfaceBody;
let posts;
let heldGets;
let proposals;
let heldProposals;
let collaboration;
// Every URL fetched, in order.
let gets = [];
let storyList;
let history;

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.fetch = async (url, options = {}) => {
    gets.push(url);
    if (options.method === 'POST') {
      let respond;
      const promise = new Promise((resolve) => (respond = resolve));
      posts.push({ body: JSON.parse(options.body), respond });
      return promise;
    }
    if (url.endsWith('/surface.json')) return json(200, surfaceBody);
    if (url.endsWith('/reconstructions')) return json(200, [job]);
    if (url.endsWith('/proposals')) return heldProposals ? heldProposals.promise : json(200, proposals);
    if (url.endsWith('/collaboration')) return json(200, collaboration);
    if (url.endsWith('/stories')) return json(200, { stories: storyList });
    if (url === '/api/invitations') return json(200, []);
    if (url.endsWith('/history')) return json(200, history);
    if (heldGets) {
      let respond;
      const promise = new Promise((resolve) => (respond = resolve));
      heldGets.push(respond);
      return promise;
    }
    return json(200, job);
  };
  ({ mountSpace } = await import('../public/space.js'));
});

after(() => {
  for (const name of ['document', 'window', 'ResizeObserver', 'fetch', 'viewerLog', 'viewerFail', 'lastRenderedScene']) delete globalThis[name];
});

beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  globalThis.document.activeElement = null;
  posts = [];
  heldGets = null;
  gets = [];
  proposals = [];
  heldProposals = null;
  collaboration = { revision: 0, contributions: [], variants: [], blocked: false, currentVersion: 1 };
  storyList = [];
  history = [{ version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial' }];
  surfaceBody = surface();
  job = {
    id: JOB_ID,
    draftId: DRAFT_ID,
    sourceId: SOURCE_ID,
    box: [100, 100, 400, 400],
    status: 'ready',
    createdAt: new Date().toISOString(),
    error: null,
    edit: { version: 1, offset: [0, 0, 0], yaw: 0 },
  };
});

async function openScene({ sources = [], text = '', textRecord = null } = {}) {
  const container = new FakeElement('section');
  const draft = { id: DRAFT_ID, photos: [{ name: 'photo-1.jpg', sourceId: SOURCE_ID }], sources, text, textSourceId: 'text-id' };
  const granted = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: false } };
  const space = mountSpace(container, { draft, sourceFor: (id) => id === 'text-id' ? textRecord : granted });
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  button('Open scene').dispatch('click');
  await settle();
  const editStatus = () => find((node) => node.tag === 'p' && node.role === 'status' && node.parent?.className === 'space-edit')[0].textContent;
  // The scene's own message follows its viewport.
  const viewMessage = () => {
    const viewport = find((node) => node.className === 'space-viewport')[0];
    return viewport.parent.parent.children.find((node) => node.className === 'form-message' && node.role === 'alert').textContent;
  };
  const axis = (label) => find((node) => node.tag === 'input' && node.attributes['aria-label'] === label)[0];
  const canvases = () => find((node) => node.tag === 'canvas');
  return { space, button, editStatus, viewMessage, axis, canvases, find, source: granted };
}

const count = (entry) => globalThis.viewerLog.filter((item) => item === entry).length;

describe('place landing', () => {
  it('offers the original and a memory action without starting a write', async () => {
    const view = await openScene();
    const landing = view.find((node) => node.className === 'place-landing')[0];
    assert.match(landing.textContent, /No saved change from a written memory for this view/);
    const memory = view.find((node) => node.className === 'memory-edit' && node.children[0]?.textContent === 'Change it from a memory')[0];
    let focused = false;
    memory.querySelector = () => memory.children[0];
    memory.children[0].focus = () => { focused = true; };
    landing.findAll((node) => node.tag === 'button' && node.textContent === 'Change from a memory')[0].dispatch('click');
    assert.equal(focused, true);
    const materials = { open: false, querySelector: () => ({ focus() {} }), scrollIntoView() {} };
    globalThis.document.getElementById = (id) => id === 'viewer-materials' ? materials : null;
    landing.findAll((node) => node.tag === 'button' && node.textContent === 'See the original photo')[0].dispatch('click');
    assert.equal(materials.open, true);
    assert.equal(posts.length, 0);
    delete globalThis.document.getElementById;
    view.space.dispose();
  });

  it('does not use archive-only writing as scene context', async () => {
    const view = await openScene({ text: 'Synthetic restricted words.', textRecord: { id: 'text-id', kind: 'text', permissions: { place: false }, policy: { stopped: false } } });
    const landing = view.find((node) => node.className === 'place-landing')[0];
    assert.doesNotMatch(landing.textContent, /Synthetic restricted words/);
    assert.match(landing.textContent, /No saved change from a written memory for this view/);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('moves focus only out of a hidden disclosure and restores its open state after the same held read', async () => {
    const words = 'A fictional sentence. '.repeat(20);
    job.edit = { version: 2, offset: [0, 0, 0], yaw: 0 };
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    proposals = [{ id, status: 'applied', appliedVersion: 2, baseVersion: 1, statement: { kind: 'human_memory', text: words }, result: { sourceId: SOURCE_ID, targetId: 'selected-foreground', baseVersion: 1 } }];
    history = [{ version: 1, kind: 'initial', offset: [0, 0, 0], yaw: 0 }, { version: 2, kind: 'proposal', proposalId: id, blocked: false, offset: [0, 0, 0], yaw: 0 }];
    const view = await openScene();
    const landing = view.find((node) => node.className === 'place-landing')[0];
    const disclosure = landing.findAll((node) => node.tag === 'details')[0];
    const action = landing.findAll((node) => node.tag === 'button' && node.textContent === 'Change from a memory')[0];
    action.focus = () => { globalThis.document.activeElement = action; };
    assert.equal(disclosure.hidden, false);
    disclosure.open = true;
    const x = view.axis('Left / right');
    x.value = '0.5'; x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    posts[0].respond(json(503, { error: 'Unknown.' }));
    await settle();
    heldProposals = Promise.withResolvers();
    globalThis.document.activeElement = disclosure.children[0];
    view.button('Load saved version').dispatch('click');
    await settle();
    assert.equal(disclosure.hidden, true);
    assert.equal(globalThis.document.activeElement, action);
    heldProposals.resolve(json(200, proposals));
    heldProposals = null;
    await settle();
    assert.equal(disclosure.hidden, false);
    assert.equal(disclosure.open, true, 'the same words retain the explicit open choice');
    const unrelated = new FakeElement('button');
    globalThis.document.activeElement = unrelated;
    view.button('Load saved version').dispatch('click');
    await settle();
    assert.equal(globalThis.document.activeElement, unrelated, 'unrelated focus is not moved');
    view.space.dispose();
  });
});

describe('inspecting the selected object', () => {
  it('checks the exact saved scene before showing the outline and returns focus without a write', async () => {
    const view = await openScene();
    const trigger = view.button('Inspect selected object');
    const details = view.find((node) => node.className === 'source-details object-inspection')[0];
    const image = details.findAll((node) => node.tag === 'img')[0];
    let focused = false;
    trigger.focus = () => { focused = true; };
    trigger.dispatch('click');
    await settle();
    assert.equal(details.open, true);
    assert.equal(image.hidden, true, 'the image is hidden until it loads and the scene is checked again');
    assert.match(image.src, /mask-overlay\.jpg\?inspect=/);
    await image.onload();
    assert.equal(image.hidden, false);
    const depth = details.findAll((node) => node.tag === 'img')[1];
    assert.equal(depth.hidden, true, 'depth waits for its own load and current-scene check');
    await depth.onload();
    assert.equal(depth.hidden, false);
    assert.match(details.textContent, /model-proposed outline/);
    assert.match(details.textContent, /If the highlighted area is not the object you meant/);
    view.button('Return to this place').dispatch('click');
    assert.equal(details.open, false);
    assert.equal(image.hidden, true);
    assert.equal(focused, true);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('hides both images if a delayed depth load finds the scene restricted', async () => {
    const view = await openScene();
    view.button('Inspect selected object').dispatch('click');
    await settle();
    const details = view.find((node) => node.className === 'source-details object-inspection')[0];
    const [image, depth] = details.findAll((node) => node.tag === 'img');
    await image.onload();
    assert.equal(image.hidden, false);
    assert.equal(depth.hidden, true);
    job.usageBlocked = true;
    await depth.onload();
    assert.equal(image.hidden, true);
    assert.equal(depth.hidden, true);
    assert.match(details.textContent, /unavailable/);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('does not show cached or late images after a restriction, load failure or close', async () => {
    const view = await openScene();
    const trigger = view.button('Inspect selected object');
    const details = view.find((node) => node.className === 'source-details object-inspection')[0];
    const image = details.findAll((node) => node.tag === 'img')[0];
    job.usageBlocked = true;
    trigger.dispatch('click');
    await settle();
    assert.equal(image.hidden, true);
    assert.match(details.textContent, /unavailable/);
    job.usageBlocked = false;
    trigger.dispatch('click');
    await settle();
    job.usageBlocked = true;
    await image.onload();
    assert.equal(image.hidden, true, 'a restriction after the image request prevents display');
    assert.match(details.textContent, /unavailable/);
    job.usageBlocked = false;
    trigger.dispatch('click');
    await settle();
    image.onerror();
    assert.equal(image.hidden, true);
    assert.match(details.textContent, /could not be shown/);
    trigger.dispatch('click');
    await settle();
    const late = image.onload;
    view.button('Return to this place').dispatch('click');
    await late();
    assert.equal(image.hidden, true);
    assert.equal(details.open, false);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('opens scene choices for a wrong object without building or altering the scene', async () => {
    const view = await openScene();
    const others = view.find((node) => node.className === 'space-others')[0];
    let focused = false;
    others.children[0].focus = () => { focused = true; };
    view.button('Inspect selected object').dispatch('click');
    await settle();
    view.button('Choose another scene').dispatch('click');
    assert.equal(others.open, true);
    assert.equal(focused, true);
    assert.equal(posts.length, 0);
    assert.equal(view.canvases().length, 1);
    view.space.dispose();
  });
});

describe('viewer setup failures release what was created', () => {
  it('releases the renderer and texture when the surface is malformed', async () => {
    surfaceBody = { ...surface(), depth: surface().depth.map(() => -1) };
    const view = await openScene();
    assert.equal(count('renderer'), 1);
    assert.equal(count('texture'), 1);
    assert.equal(count('renderer.dispose'), 1);
    assert.equal(count('renderer.forceContextLoss'), 1);
    assert.equal(count('texture.dispose'), 1);
    assert.equal(view.canvases().length, 0);
    assert.match(view.viewMessage(), /could not be shown/);
    view.space.dispose();
    assert.equal(count('renderer.dispose'), 1, 'not released twice');
  });

  it('releases the renderer when the texture cannot load, and says so', async () => {
    globalThis.viewerFail = 'texture';
    const view = await openScene();
    assert.equal(count('renderer.dispose'), 1);
    assert.equal(count('renderer.forceContextLoss'), 1);
    assert.match(view.viewMessage(), /image could not be loaded/);
    view.space.dispose();
  });

  it('releases controls, meshes, texture and renderer when a later step fails', async () => {
    globalThis.viewerFail = 'observe';
    const view = await openScene();
    for (const entry of ['controls.dispose', 'observer.disconnect', 'texture.dispose', 'renderer.dispose', 'renderer.forceContextLoss']) {
      assert.equal(count(entry), 1, entry);
    }
    assert.equal(count('geometry.dispose'), 2);
    assert.equal(count('material.dispose'), 2);
    assert.equal(view.canvases().length, 0);
    view.space.dispose();
  });

  it('reports missing WebGL without allocating anything', async () => {
    globalThis.viewerFail = 'webgl';
    const view = await openScene();
    assert.deepEqual(globalThis.viewerLog, []);
    assert.match(view.viewMessage(), /WebGL/);
    view.space.dispose();
  });

  it('releases everything once when a working scene is closed', async () => {
    const view = await openScene();
    assert.equal(view.canvases().length, 1);
    view.space.dispose();
    view.space.dispose();
    for (const entry of ['controls.dispose', 'observer.disconnect', 'texture.dispose', 'renderer.dispose', 'renderer.forceContextLoss']) {
      assert.equal(count(entry), 1, entry);
    }
    assert.equal(count('geometry.dispose'), 2);
  });
});

describe('unconfirmed edit save', () => {
  it('stays unconfirmed after the preview is reset, and settles by loading the saved version', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '1';
    x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    assert.deepEqual(posts[0].body.offset, [1, 0, 0]);
    view.button('Reset object position').dispatch('click');

    posts[0].respond({ status: 0, ok: false, json: async () => null });
    await settle();

    assert.doesNotMatch(view.editStatus(), /^Saved/);
    assert.match(view.editStatus(), /could not confirm whether your last change was saved/);
    assert.equal(view.button('Load saved version').hidden, false);

    view.button('Revert to saved').dispatch('click');
    assert.match(view.editStatus(), /could not confirm/);

    job.edit = { version: 2, offset: [1, 0, 0], yaw: 0 };
    view.button('Load saved version').dispatch('click');
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    assert.equal(view.button('Load saved version').hidden, true);
    assert.equal(x.value, '1');
    view.space.dispose();
  });

  it('blocks saving and editing while the saved version reloads, so an older read cannot replace a newer save', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '1';
    x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    posts[0].respond({ status: 0, ok: false, json: async () => null });
    await settle();

    heldGets = [];
    view.button('Load saved version').dispatch('click');
    assert.equal(view.editStatus(), 'Loading the saved version…');
    for (const name of ['Apply and save', 'Load saved version', 'Reset object position']) {
      assert.equal(view.button(name).disabled, true, name);
    }
    assert.equal(x.disabled, true);
    view.button('Apply and save').dispatch('click');
    assert.equal(posts.length, 1, 'no save starts during the reload');

    heldGets[0](json(200, { ...job, edit: { version: 2, offset: [1, 0, 0], yaw: 0 } }));
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    assert.equal(x.disabled, false);
    view.space.dispose();
  });

  it('keeps a save conflict as reload-required through reset and revert, and blocks Apply until reconciled', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '1';
    x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    view.button('Reset object position').dispatch('click');
    posts[0].respond(json(409, { error: 'The scene was changed elsewhere.' }));
    await settle();

    assert.match(view.editStatus(), /changed since version 1\. Load the saved version before saving again/);
    view.button('Revert to saved').dispatch('click');
    view.button('Reset object position').dispatch('click');
    x.value = '0.3';
    x.dispatch('input');
    assert.match(view.editStatus(), /Load the saved version before saving again/);
    assert.equal(view.button('Apply and save').disabled, true);
    view.button('Apply and save').dispatch('click');
    assert.equal(posts.length, 1);

    job.edit = { version: 2, offset: [0.7, 0, 0], yaw: 0 };
    view.button('Load saved version').dispatch('click');
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    assert.equal(view.button('Load saved version').hidden, true);
    view.space.dispose();
  });

  it('retries the same unconfirmed change with the same request ID', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '0.5';
    x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    posts[0].respond({ status: 503, ok: false, json: async () => null });
    await settle();
    assert.equal(view.button('Apply and save').disabled, false);
    view.button('Apply and save').dispatch('click');
    assert.equal(posts[1].body.requestId, posts[0].body.requestId);
    posts[1].respond(json(200, { version: 2, offset: [0.5, 0, 0], yaw: 0 }));
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    assert.equal(view.button('Load saved version').hidden, true);
    view.space.dispose();
  });
});

describe('memory proposals inside the scene', () => {
  const ready = () => ({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    baseVersion: 1,
    statement: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'human_memory', text: 'It was further left.', sha256: 'a'.repeat(64), modelConsent: true },
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    status: 'ready',
    result: { action: 'translate', targetId: 'selected-foreground', sourceId: SOURCE_ID, baseVersion: 1, delta: [-0.5, 0, 0], yawDelta: null, anchor: null, question: null, reason: 'Moved left as remembered.', transform: { offset: [-0.5, 0, 0], yaw: 0 } },
    question: null,
    error: null,
    model: 'muse-spark-1.3',
    usage: null,
    responseId: null,
    appliedVersion: null,
  });

  it('compares the actual saved and proposed transforms at one camera and restores the previous view', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Explore in 3D').dispatch('click');
    view.button('Inspect from the side').dispatch('click');
    const previous = { position: globalThis.viewerControls.object.position.toArray(), target: globalThis.viewerControls.target.toArray() };
    const foreground = globalThis.lastRenderedScene.getObjectByName('selected-foreground');
    const savedPosition = foreground.position.toArray();
    const viewport = view.find((node) => node.className === 'space-viewport')[0];
    Object.assign(viewport, { clientWidth: 400, clientHeight: 300 });
    const compare = view.button('Compare photo, saved and proposal');
    assert.equal(compare.disabled, false);
    compare.dispatch('click');
    const bar = view.find((node) => node.classList.contains('visit-compare'))[0];
    const frame = view.find((node) => node.classList.contains('memory-comparison-frame'))[0];
    const pressed = () => ['Photo', 'Saved', 'Proposed'].filter((name) => view.button(name).attributes['aria-pressed'] === 'true');
    assert.equal(bar.hidden, false);
    assert.ok(bar.parent.children.indexOf(bar) < bar.parent.children.indexOf(frame), 'controls and context precede the scene');
    assert.deepEqual(pressed(), ['Saved']);
    assert.equal(view.button('Preview on the scene'), undefined, 'the redundant inspector preview is hidden');
    assert.match(bar.textContent, /Your memory: “It was further left\.”/);
    assert.match(bar.textContent, /Proposed change: Move the selected object/);
    assert.equal(view.button('Original viewpoint').parent.hidden, true, 'camera controls pause during comparison');
    assert.equal(view.button('Explore in 3D').disabled, true);
    assert.equal(view.axis('Left / right').disabled, true);
    const camera = globalThis.viewerControls.object.position.toArray();
    const target = globalThis.viewerControls.target.toArray();
    const projection = [...globalThis.viewerControls.object.projectionMatrix.elements];
    assert.deepEqual(camera, [0, 0, 0]);
    assert.deepEqual(foreground.position.toArray(), savedPosition);
    assert.equal(view.button('Apply and save this proposal').disabled, true);

    view.button('Proposed').dispatch('click');
    assert.deepEqual(pressed(), ['Proposed']);
    assert.equal(foreground.position.x, savedPosition[0] - 0.5);
    assert.deepEqual(globalThis.viewerControls.object.position.toArray(), camera);
    assert.deepEqual(globalThis.viewerControls.target.toArray(), target);
    assert.deepEqual([...globalThis.viewerControls.object.projectionMatrix.elements], projection);
    assert.equal(view.button('Apply and save this proposal').disabled, false);
    view.button('Saved').dispatch('click');
    assert.deepEqual(pressed(), ['Saved']);
    assert.deepEqual(foreground.position.toArray(), savedPosition);
    assert.deepEqual(globalThis.viewerControls.object.position.toArray(), camera);
    assert.deepEqual([...globalThis.viewerControls.object.projectionMatrix.elements], projection);
    assert.equal(view.button('Apply and save this proposal').disabled, true);

    view.button('Photo').dispatch('click');
    assert.deepEqual(pressed(), ['Saved'], 'the photo is not selected before its bytes load');
    const image = view.find((node) => node.className === 'visit-compare-photo')[0];
    assert.equal(new URL(image.src, 'http://127.0.0.1').pathname, `/api/drafts/${DRAFT_ID}/reconstructions/${JOB_ID}/assets/texture.jpg`);
    const lateLoad = image.onload;
    view.button('Proposed').dispatch('click');
    lateLoad();
    assert.deepEqual(pressed(), ['Proposed']);
    assert.equal(image.hidden, true, 'a late Photo load cannot replace the newer choice');
    assert.equal(foreground.position.x, savedPosition[0] - 0.5);
    view.button('Photo').dispatch('click');
    image.onload();
    assert.deepEqual(pressed(), ['Photo']);
    assert.equal(image.hidden, false);
    const box = view.find((node) => node.className === 'box-overlay')[0];
    assert.equal(box.hidden, false);
    assert.deepEqual({ left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height },
      { left: '80px', top: '60px', width: '180px', height: '180px' });
    assert.match(bar.textContent, /box marks the selected photo region/);
    Object.assign(viewport, { clientWidth: 300, clientHeight: 300 });
    globalThis.viewerResize();
    assert.deepEqual({ left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height },
      { left: '50px', top: '75px', width: '150px', height: '150px' });
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.button('Leave comparison').dispatch('click');
    assert.equal(bar.hidden, true);
    assert.deepEqual(foreground.position.toArray(), savedPosition);
    assert.deepEqual(globalThis.viewerControls.object.position.toArray(), previous.position);
    assert.deepEqual(globalThis.viewerControls.target.toArray(), previous.target);
    assert.equal(view.button('Original viewpoint').parent.hidden, false);
    assert.equal(view.button('Explore in 3D').attributes['aria-pressed'], 'true');
    assert.equal(view.axis('Left / right').disabled, false);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('holds an unsaved manual edit and only sends a visible proposed change on explicit apply', async () => {
    proposals = [ready()];
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '0.3';
    x.dispatch('input');
    assert.equal(view.button('Compare photo, saved and proposal').disabled, true);
    assert.equal(x.value, '0.3');
    assert.equal(posts.length, 0);
    view.button('Revert to saved').dispatch('click');
    view.button('Compare photo, saved and proposal').dispatch('click');
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.button('Proposed').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.baseVersion, 1);
    assert.equal(posts[0].body.frontConfirmed, false);
    const edit = { version: 2, offset: [-0.5, 0, 0], yaw: 0 };
    proposals = [{ ...ready(), status: 'applied', appliedVersion: 2 }];
    posts[0].respond(json(200, { edit, proposal: proposals[0] }));
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    assert.equal(x.value, '-0.5');
    view.space.dispose();
    job.edit = edit;
    const reopened = await openScene();
    assert.equal(reopened.editStatus(), 'Saved, version 2.');
    assert.equal(reopened.axis('Left / right').value, '-0.5');
    reopened.space.dispose();
  });

  it('keeps the saved scene usable when the bound photo fails, and drops a load after source withdrawal', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Compare photo, saved and proposal').dispatch('click');
    const bar = view.find((node) => node.classList.contains('visit-compare'))[0];
    const image = view.find((node) => node.className === 'visit-compare-photo')[0];
    view.button('Photo').dispatch('click');
    image.onerror();
    assert.equal(image.hidden, true);
    assert.match(bar.textContent, /photo could not be shown/);
    assert.equal(view.button('Saved').attributes['aria-pressed'], 'true');
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.button('Photo').dispatch('click');
    const late = image.onload;
    view.source.permissions.place = false;
    late();
    assert.equal(bar.hidden, true);
    assert.equal(image.hidden, true);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('retries a restored photo with a fresh URL and ignores the failed request’s late callbacks', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Compare photo, saved and proposal').dispatch('click');
    const bar = view.find((node) => node.classList.contains('visit-compare'))[0];
    const image = view.find((node) => node.className === 'visit-compare-photo')[0];
    const pressed = () => ['Photo', 'Saved', 'Proposed'].filter((name) => view.button(name).attributes['aria-pressed'] === 'true');
    view.button('Photo').dispatch('click');
    const firstUrl = image.src;
    const firstLoad = image.onload;
    const firstError = image.onerror;
    firstError();
    assert.match(bar.textContent, /photo could not be shown/);
    assert.deepEqual(pressed(), ['Saved']);
    view.button('Photo').dispatch('click');
    const secondUrl = image.src;
    assert.notEqual(secondUrl, firstUrl);
    assert.equal(new URL(secondUrl, 'http://127.0.0.1').pathname, new URL(firstUrl, 'http://127.0.0.1').pathname);
    assert.match(bar.textContent, /photo could not be shown\. Trying again/);
    assert.equal(image.hidden, true);
    assert.deepEqual(pressed(), ['Saved']);
    const secondLoad = image.onload;
    firstLoad();
    firstError();
    assert.match(bar.textContent, /photo could not be shown\. Trying again/, 'an obsolete outcome cannot hide the retry');
    assert.equal(image.hidden, true);
    image.onerror();
    assert.match(bar.textContent, /photo could not be shown/, 'a repeated failure remains visible');
    assert.deepEqual(pressed(), ['Saved']);
    view.button('Photo').dispatch('click');
    assert.notEqual(image.src, secondUrl);
    secondLoad();
    assert.equal(image.hidden, true, 'an old successful callback cannot replace the latest request');
    image.onload();
    assert.equal(image.hidden, false);
    assert.deepEqual(pressed(), ['Photo']);
    assert.doesNotMatch(bar.textContent, /photo could not be shown|Loading the photo/);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('does not steal unrelated focus when a held photo load observes a source restriction', async () => {
    proposals = [ready()];
    const view = await openScene();
    const canvas = view.canvases()[0];
    let canvasFocuses = 0;
    canvas.focus = () => { canvasFocuses += 1; globalThis.document.activeElement = canvas; };
    view.button('Explore in 3D').dispatch('click');
    assert.equal(canvasFocuses, 1, 'an explicit Explore choice focuses the canvas');
    view.button('Compare photo, saved and proposal').dispatch('click');
    view.button('Photo').dispatch('click');
    const image = view.find((node) => node.className === 'visit-compare-photo')[0];
    const late = image.onload;
    const unrelated = view.find((node) => node.tag === 'textarea')[0];
    globalThis.document.activeElement = unrelated;
    view.source.permissions.place = false;
    late();
    assert.equal(view.find((node) => node.classList.contains('visit-compare'))[0].hidden, true);
    assert.equal(canvasFocuses, 1, 'restoring exploration is not a new Explore choice');
    assert.equal(globalThis.document.activeElement, unrelated);
    assert.equal(view.button('Explore in 3D').attributes['aria-pressed'], 'true');
    view.space.dispose();
  });

  it('moves focus to a visible control when asynchronous closure hides the focused comparison', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Compare photo, saved and proposal').dispatch('click');
    view.button('Photo').dispatch('click');
    const image = view.find((node) => node.className === 'visit-compare-photo')[0];
    const late = image.onload;
    const focused = view.button('Saved');
    const original = view.button('Original viewpoint');
    original.focus = () => { globalThis.document.activeElement = original; };
    globalThis.document.activeElement = focused;
    view.source.permissions.place = false;
    late();
    assert.equal(view.find((node) => node.classList.contains('visit-compare'))[0].hidden, true);
    assert.equal(globalThis.document.activeElement, original);
    assert.equal(original.disabled, false);
    assert.equal(view.button('Explore in 3D').attributes['aria-pressed'], 'false');
    view.space.dispose();
  });

  it('returns focus to the comparison trigger on explicit Leave', async () => {
    const originalFocus = FakeElement.prototype.focus;
    FakeElement.prototype.focus = function focus() { globalThis.document.activeElement = this; };
    try {
      proposals = [ready()];
      const view = await openScene();
      view.button('Compare photo, saved and proposal').dispatch('click');
      assert.equal(globalThis.document.activeElement, view.button('Saved'));
      view.button('Leave comparison').dispatch('click');
      assert.equal(globalThis.document.activeElement, view.button('Compare photo, saved and proposal'));
      assert.equal(globalThis.document.activeElement.disabled, false);
      view.space.dispose();
    } finally {
      FakeElement.prototype.focus = originalFocus;
    }
  });

  it('rechecks source permission at apply even if the visible button was enabled earlier', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Compare photo, saved and proposal').dispatch('click');
    view.button('Proposed').dispatch('click');
    const apply = view.button('Apply and save this proposal');
    assert.equal(apply.disabled, false);
    view.source.permissions.place = false;
    apply.dispatch('click');
    assert.equal(posts.length, 0);
    assert.equal(view.find((node) => node.classList.contains('visit-compare'))[0].hidden, true);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.space.dispose();
  });

  it('replays the exact unconfirmed apply without requiring another preview', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Compare photo, saved and proposal').dispatch('click');
    view.button('Proposed').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    posts[0].respond({ status: 0, ok: false, json: async () => null });
    await settle();
    assert.equal(view.button('Compare photo, saved and proposal').disabled, true);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    const retry = view.button('Retry the unconfirmed apply');
    assert.equal(retry.disabled, false);
    retry.dispatch('click');
    assert.deepEqual(posts[1].body, posts[0].body);
    const edit = { version: 2, offset: [-0.5, 0, 0], yaw: 0 };
    proposals = [{ ...ready(), status: 'applied', appliedVersion: 2 }];
    posts[1].respond(json(200, { edit, proposal: proposals[0] }));
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    view.space.dispose();
  });

  it('pauses manual editing while a proposal is previewed and adopts the server-confirmed version', async () => {
    proposals = [ready()];
    const view = await openScene();
    const x = view.axis('Left / right');
    view.button('Preview on the scene').dispatch('click');
    assert.match(view.editStatus(), /Manual changes are paused/);
    assert.equal(x.disabled, true);
    assert.equal(view.button('Reset object position').disabled, true);
    assert.equal(x.value, '0', 'the manual preview is not changed by the proposal preview');

    view.button('Apply and save this proposal').dispatch('click');
    assert.deepEqual(posts[0].body, { requestId: posts[0].body.requestId, baseVersion: 1, frontConfirmed: false });
    assert.match(view.editStatus(), /paused/, 'not saved before the response');
    const edit = { version: 2, offset: [-0.5, 0, 0], yaw: 0 };
    proposals = [{ ...ready(), status: 'applied', appliedVersion: 2 }];
    history = [...history, { ...edit, kind: 'proposal', proposalId: proposals[0].id }];
    posts[0].respond(json(200, { edit, proposal: proposals[0] }));
    await settle();
    assert.equal(view.editStatus(), 'Saved, version 2.');
    assert.equal(x.disabled, false);
    assert.equal(x.value, '-0.5');
    view.space.dispose();
  });

  it('turns an unconfirmed apply into the manual editor’s reload-required state', async () => {
    proposals = [ready()];
    const view = await openScene();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    posts[0].respond({ status: 0, ok: false, json: async () => null });
    await settle();
    assert.match(view.editStatus(), /could not confirm whether your last change was saved/);
    assert.equal(view.button('Load saved version').hidden, false);
    assert.equal(view.axis('Left / right').value, '0');
    view.space.dispose();
  });

  it('blocks planning while a manual change is unsaved', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '0.4';
    x.dispatch('input');
    const text = view.find((node) => node.tag === 'textarea')[0];
    text.value = 'It was by the door.';
    text.dispatch('input');
    const consent = view.find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
    consent.checked = true;
    consent.dispatch('change');
    assert.equal(view.button('Plan a change').disabled, true);
    view.button('Revert to saved').dispatch('click');
    assert.equal(view.button('Plan a change').disabled, false);
    view.space.dispose();
  });
});

describe('face-anchor preview in the scene', () => {
  // The top-left corner sits above the object's centre, so the target has height.
  const anchorPoint = [0, 0];
  const faceProposal = (yawShift = 0) => {
    const pivot = surfaceMeshes(surface()).foreground.pivot;
    const target = surfacePoint(surface(), anchorPoint);
    const yaw = Math.atan2(target[0] - pivot[0], target[2] - pivot[2]) + yawShift;
    return {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      baseVersion: 1,
      statement: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'human_memory', text: 'It faced the left wall.', sha256: 'a'.repeat(64), modelConsent: true },
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
      status: 'ready',
      result: { action: 'face_anchor', targetId: 'selected-foreground', sourceId: SOURCE_ID, baseVersion: 1, delta: null, yawDelta: null, anchor: { label: 'left wall', point: anchorPoint }, question: null, reason: 'Turned toward the wall.', transform: { offset: [0, 0, 0], yaw } },
      question: null,
      error: null,
      model: 'muse-spark-1.3',
      usage: null,
      responseId: null,
      appliedVersion: null,
    };
  };

  it('requires a fresh visible direction check when comparison returns to Proposed', async () => {
    proposals = [faceProposal()];
    const view = await openScene();
    view.button('Compare photo, saved and proposal').dispatch('click');
    view.button('Proposed').dispatch('click');
    let check = view.find((node) => node.tag === 'input' && node.type === 'checkbox' && node.parent?.textContent.includes('I checked the scene'))[0];
    assert.ok(check);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    check.checked = true;
    check.dispatch('change');
    assert.equal(view.button('Apply and save this proposal').disabled, false);
    view.button('Saved').dispatch('click');
    view.button('Proposed').dispatch('click');
    check = view.find((node) => node.tag === 'input' && node.type === 'checkbox' && node.parent?.textContent.includes('I checked the scene'))[0];
    assert.ok(check);
    assert.equal(check.checked, false);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    assert.equal(posts.length, 0);
    view.space.dispose();
  });

  it('draws the photographed side and the target line, and offers confirmation only when they agree', async () => {
    proposals = [faceProposal()];
    const view = await openScene();
    view.button('Preview on the scene').dispatch('click');
    assert.match(view.find((node) => node.className === 'memory-review')[0].textContent, /yellow arrow points along the level blue line/);
    const { yaw } = proposals[0].result.transform;
    const pivot = surfaceMeshes(surface()).foreground.pivot;
    const arrows = globalThis.viewerLog.filter((entry) => entry.startsWith('arrow '));
    assert.deepEqual(arrows, [`arrow ${[Math.sin(yaw), 0, Math.cos(yaw), ...pivot].map((value) => value.toFixed(3)).join(' ')}`]);
    const target = surfacePoint(surface(), anchorPoint);
    assert.ok(target[1] - pivot[1] > 0.5, 'the target is well above the object');
    const level = [target[0], pivot[1], target[2]];
    const fixed = (points) => points.flat().map((value) => value.toFixed(3)).join(' ');
    assert.deepEqual(
      globalThis.viewerLog.filter((entry) => entry.startsWith('line ')),
      [`line ${fixed([pivot, level])}`, `line ${fixed([level, target])}`],
    );
    view.button('Stop preview').dispatch('click');
    assert.equal(count('arrow.dispose'), 1);
    assert.doesNotMatch(view.find((node) => node.className === 'memory-review')[0].textContent, /I checked the scene/);
    view.button('Preview on the scene').dispatch('click');
    view.space.dispose();
    assert.equal(count('arrow.dispose'), 2, 'closing the scene releases a guide that is still shown');
  });

  it('refuses a face-anchor turn that does not point at its target', async () => {
    proposals = [faceProposal(0.4)];
    const view = await openScene();
    view.button('Preview on the scene').dispatch('click');
    assert.match(view.find((node) => node.className === 'memory-review')[0].textContent, /does not point at the marked point/);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.space.dispose();
  });

  it('cannot confirm a face-anchor turn without WebGL', async () => {
    globalThis.viewerFail = 'webgl';
    proposals = [faceProposal()];
    const view = await openScene();
    view.button('Preview on the scene').dispatch('click');
    assert.match(view.find((node) => node.className === 'memory-review')[0].textContent, /3D preview is not available/);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.space.dispose();
  });
});

describe('recollections and blocked scenes', () => {
  it('does not load a blocked scene, and offers only an unaffected restore', async () => {
    job.usageBlocked = true;
    job.edit = { version: 2, offset: [1, 0, 0], yaw: 0 };
    history = [
      { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', blocked: false },
      { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'contribution', blocked: true },
    ];
    const view = await openScene();
    assert.equal(count('renderer'), 0, 'no viewer for a blocked scene');
    assert.equal(count('texture'), 0);
    assert.equal(view.canvases().length, 0);
    assert.ok(view.button('Restore version 1'));
    assert.equal(view.button('Restore version 2'), undefined);
    assert.equal(view.button('Apply and save'), undefined, 'no manual editing of a blocked scene');
    view.space.dispose();
  });

  it('stops showing a loaded scene when a refresh finds it blocked by a withdrawal', async () => {
    const view = await openScene();
    assert.equal(view.canvases().length, 1);
    // Another person withdrew a recollection the current version depends on.
    job.usageBlocked = true;
    job.edit = { version: 2, offset: [1, 0, 0], yaw: 0 };
    collaboration = { ...collaboration, blocked: true, currentVersion: 2 };
    history = [
      { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', blocked: false },
      { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'contribution', blocked: true },
    ];
    view.button('Refresh').dispatch('click');
    await settle();
    assert.equal(view.canvases().length, 0, 'the dependent scene is no longer drawn');
    assert.equal(count('renderer.dispose'), 1);
    assert.ok(view.button('Restore version 1'));
    assert.equal(view.button('Apply and save'), undefined);
    view.space.dispose();
  });

  it('pauses manual editing and memory planning while a recollection candidate is previewed', async () => {
    collaboration = {
      revision: 1,
      contributions: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', principalId: 'p-contrib', provider: { displayName: 'Mina' }, kind: 'human_recollection', text: 'It stood by the door.', textSha256: 'a'.repeat(64), permissions: { place: true, model: false, share: false }, periodClaim: '', createdAt: '2026-10-31T00:00:00.000Z', revision: 1, status: 'submitted', review: null, withdrawnAt: null },
      ],
      variants: [],
      blocked: false,
      currentVersion: 1,
    };
    const view = await openScene();
    const owner = view.find((node) => node.className === 'memory-edit collab-owner')[0];
    const inOwner = (text) => owner.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
    inOwner('Review').dispatch('click');
    const decision = owner.findAll((node) => node.tag === 'select')[0];
    decision.value = 'adopt';
    decision.dispatch('change');
    owner.findAll((node) => node.tag === 'input' && node.type === 'number')[0].value = '0.5';
    inOwner('Preview candidate on the scene').dispatch('click');
    assert.match(view.editStatus(), /Manual changes are paused/);
    assert.equal(view.axis('Left / right').disabled, true);
    assert.equal(view.axis('Left / right').value, '0', 'the manual preview is untouched');
    const text = view.find((node) => node.tag === 'textarea')[0];
    text.value = 'It faced the door.';
    text.dispatch('input');
    const consent = view.find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
    consent.checked = true;
    consent.dispatch('change');
    assert.equal(view.button('Plan a change').disabled, true, 'memory planning waits for the candidate preview to end');
    assert.equal(inOwner('Save decision').disabled, false, 'a drawn preview allows the explicit save');
    view.space.dispose();
    assert.equal(posts.filter((post) => post.body?.decision).length, 0, 'nothing was saved without the explicit action');
  });
});

describe('sharing from a ready scene', () => {
  it('captures the camera from the real viewer into the preview request', async () => {
    const view = await openScene();
    const panel = view.find((node) => node.className === 'memory-edit share-owner')[0];
    const inPanel = (text) => panel.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
    panel.findAll((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Shop';
    inPanel('Use the current camera view').dispatch('click');
    assert.match(panel.textContent, /Camera view captured/);
    inPanel('Preview what visitors will see').dispatch('click');
    await settle();
    const preview = posts.find((post) => post.body?.camera);
    assert.deepEqual(preview.body.camera, { position: [0, 0, 0], target: [0, 0, -3] }, 'the viewer’s actual starting camera');
    assert.equal(preview.body.views[0].kind, 'version');
    assert.equal(preview.body.views[0].version, 1);
    view.space.dispose();
  });
});

describe('scenes whose photo can no longer be used', () => {
  it('shows a fixed explanation with no viewer and nothing to restore', async () => {
    job.usageBlocked = true;
    job.blockedReason = 'source';
    // Even a version the history marks unaffected cannot be restored: every
    // version depends on the photo.
    history = [
      { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', blocked: false },
      { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'manual', blocked: true },
    ];
    const view = await openScene();
    assert.equal(count('renderer'), 0);
    assert.equal(view.canvases().length, 0);
    assert.match(view.find((node) => node.tag === 'h3')[0].textContent, /no longer shown/);
    assert.ok(view.find((node) => node.tag === 'p' && /Every saved version depends on that photo, so none can be restored\. The original photo is kept, not deleted\./.test(node.textContent))[0]);
    assert.equal(view.find((node) => node.tag === 'button' && /^Restore version/.test(node.textContent)).length, 0);
    view.space.dispose();
  });

  it('disposes the live viewer when a reload finds the scene blocked by its photo', async () => {
    const view = await openScene();
    assert.equal(view.canvases().length, 1);
    const x = view.axis('Left / right');
    x.value = '1';
    x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    posts[0].respond({ status: 0, ok: false, json: async () => null });
    await settle();
    job.usageBlocked = true;
    job.blockedReason = 'source';
    view.button('Load saved version').dispatch('click');
    await settle();
    assert.equal(count('renderer.dispose'), 1);
    assert.equal(view.canvases().length, 0);
    assert.match(view.find((node) => node.tag === 'h3')[0].textContent, /no longer shown/);
    view.space.dispose();
  });

  it('keeps the restore panel for a scene blocked only by a withdrawn recollection', async () => {
    job.usageBlocked = true;
    job.blockedReason = 'contribution';
    job.edit = { version: 2, offset: [1, 0, 0], yaw: 0 };
    history = [
      { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', blocked: false },
      { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'contribution', blocked: true },
    ];
    const view = await openScene();
    assert.equal(count('renderer'), 0);
    assert.ok(view.button('Restore version 1'));
    assert.doesNotMatch(view.find((node) => node.tag === 'h3')[0].textContent, /no longer shown/);
    view.space.dispose();
  });
});

describe('stories and sharing in one scene', () => {
  const VOICE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const voice = { id: VOICE, kind: 'voice', provider: 'Owner', permissions: { place: true, model: false, share: true }, policy: { revision: 0, stopped: false } };
  const story = (overrides = {}) => ({
    id: 'st1',
    status: 'ready',
    available: true,
    blockedReason: null,
    title: 'Morning bell',
    target: { id: 'selected-foreground', label: 'Selected foreground object' },
    view: { kind: 'version', version: 1, variantId: null, eraRevision: null, label: 'Saved version 1', era: null },
    voice: { sourceId: VOICE, provider: 'Owner' },
    captionAuthor: { displayName: 'Owner' },
    cues: [{ startMs: 0, endMs: 1000, text: 'Synthetic test tone; no speech.' }],
    durationMs: 1000,
    audio: { type: 'audio/wav', size: 32044 },
    error: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    withdrawnAt: null,
    ...overrides,
  });

  it('offers a just-saved story for sharing, and withdrawing it removes the option and discards an unissued preview', async () => {
    const view = await openScene({ sources: [voice] });
    const storyPanel = view.find((node) => node.className === 'memory-edit story-owner')[0];
    const sharePanel = view.find((node) => node.className === 'memory-edit share-owner')[0];
    const inStory = (text) => storyPanel.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
    const inShare = (text) => sharePanel.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
    const storyOption = () => sharePanel.findAll((node) => node.tag === 'label' && node.textContent.includes('“Morning bell”'))[0];
    assert.match(sharePanel.textContent, /No recorded story belongs to the chosen views/);

    // Save a story for the current saved version through the real composer.
    storyPanel.findAll((node) => node.tag === 'select')[1].value = 'version:1';
    // The title is the first text field; the caption times are in the caption row.
    const [title] = storyPanel.findAll((node) => node.tag === 'input' && node.type === 'text');
    const [start, end] = storyPanel.findAll((node) => node.className === 'story-cue-row')[0].findAll((node) => node.tag === 'input' && node.type === 'text');
    title.value = 'Morning bell';
    start.value = '0:00';
    end.value = '0:01.0';
    storyPanel.findAll((node) => node.tag === 'textarea')[0].value = 'Synthetic test tone; no speech.';
    storyPanel.findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0].checked = true;
    inStory('Save story').dispatch('click');
    await settle();
    const created = posts.find((post) => post.body?.voiceSourceId);
    storyList = [story()];
    created.respond(json(201, story()));
    await settle();
    assert.ok(storyOption(), 'the new story is offered for the chosen view');
    assert.equal(storyOption().children[0].checked, false, 'never selected automatically');

    // A preview made before the withdrawal no longer matches afterwards.
    sharePanel.findAll((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Shop';
    inShare('Use the current camera view').dispatch('click');
    inShare('Preview what visitors will see').dispatch('click');
    await settle();
    const preview = posts.find((post) => post.body?.camera);
    preview.respond(json(200, { id: 'p1', digest: 'd1', expiresAt: new Date(Date.now() + 900_000).toISOString(), publicView: null }));
    await settle();
    assert.ok(inShare('Issue a visitor link'), 'a preview exists');

    inStory('Withdraw story').dispatch('click');
    inStory('Withdraw this story').dispatch('click');
    await settle();
    const withdraw = posts.find((post) => post.body && Object.keys(post.body).length === 1 && post.body.requestId && !post.body.camera);
    storyList = [story({ status: 'withdrawn', available: false })];
    withdraw.respond(json(200, story({ status: 'withdrawn', available: false })));
    await settle();
    assert.equal(storyOption(), undefined, 'the withdrawn story is no longer offered');
    assert.equal(inShare('Issue a visitor link'), undefined, 'the unissued preview was discarded');
    assert.match(sharePanel.textContent, /Saved views, recollections or recorded stories changed\. Make a new preview before issuing a link\./);
    view.space.dispose();
  });
});

describe('typing a manual value', () => {
  it('keeps the typed text while typing, and never saves a cached value behind an invalid field', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    const slider = view.axis('Left / right slider');
    for (const typed of ['0.', '0.4']) {
      x.value = typed;
      x.dispatch('input');
      assert.equal(x.value, typed, 'the field being typed is not rewritten');
    }
    assert.equal(slider.value, '0.4', 'the other control follows the parsed value');
    x.value = '';
    x.dispatch('input');
    assert.equal(x.value, '', 'an empty intermediate (also what a lone minus sign reads as) stays');
    assert.equal(view.button('Apply and save').disabled, true);
    x.value = '40';
    x.dispatch('input');
    x.dispatch('blur');
    assert.equal(x.value, '40', 'an invalid draft is not silently dropped');
    assert.equal(view.button('Apply and save').disabled, true, 'the last valid 0.4 cannot be saved behind 40');
    view.button('Apply and save').dispatch('click');
    assert.equal(posts.length, 0);
    x.value = '-0.3';
    x.dispatch('input');
    x.dispatch('blur');
    assert.equal(view.button('Apply and save').disabled, false);
    view.button('Apply and save').dispatch('click');
    assert.deepEqual(posts[0].body.offset, [-0.3, 0, 0]);
    view.space.dispose();
  });

  it('offers Revert for an invalid draft over a clean preview, and Revert restores the saved value', async () => {
    const view = await openScene();
    const x = view.axis('Left / right');
    x.value = '40';
    x.dispatch('input');
    assert.equal(view.button('Revert to saved').disabled, false);
    view.button('Revert to saved').dispatch('click');
    assert.equal(x.value, '0');
    assert.equal(view.button('Revert to saved').disabled, true);
    view.space.dispose();
  });

  it('keeps an invalid field as typed when another field changes, and sends nothing until it is valid', async () => {
    const view = await openScene();
    const [x, y] = [view.axis('Left / right'), view.axis('Down / up')];
    x.value = '0.4';
    x.dispatch('input');
    x.value = '40';
    x.dispatch('input');
    x.dispatch('blur');
    y.value = '0.1';
    y.dispatch('input');
    y.dispatch('blur');
    assert.equal(x.value, '40');
    assert.equal(view.button('Apply and save').disabled, true);
    view.button('Apply and save').dispatch('click');
    assert.equal(posts.length, 0);
    x.value = '0.3';
    x.dispatch('input');
    view.button('Apply and save').dispatch('click');
    assert.deepEqual(posts[0].body.offset, [0.3, 0.1, 0]);
    view.space.dispose();
  });
});

describe('page scrolling and exploring the scene', () => {
  const cameraNow = () => ({ position: globalThis.viewerControls.object.position.toArray(), target: globalThis.viewerControls.target.toArray() });

  it('starts in page scrolling, explores only on request, and never moves the camera when the mode or size changes', async () => {
    const view = await openScene();
    const [canvas] = view.canvases();
    const controls = globalThis.viewerControls;
    assert.equal(controls.enabled, false, 'pointer, wheel and keys reach the page');
    assert.equal(canvas.style.touchAction, 'auto');
    assert.equal(canvas.tabIndex, -1, 'not a tab stop while it does nothing');
    assert.ok(view.find((node) => node.attributes?.role === 'status' && /^Scroll here to move the page\. Choose Explore in 3D to look around the scene\.$/.test(node.textContent)).length);
    let focused = 0;
    canvas.focus = () => (focused += 1);
    view.button('Inspect from the side').dispatch('click');
    const before = cameraNow();
    assert.equal(focused, 0);
    const toggle = view.button('Explore in 3D');
    assert.equal(toggle.attributes['aria-pressed'], 'false');

    toggle.dispatch('click');
    assert.equal(toggle.textContent, 'Explore in 3D', 'the label stays; the pressed state changes');
    assert.equal(toggle.attributes['aria-pressed'], 'true');
    assert.equal(controls.enabled, true);
    assert.equal(canvas.style.touchAction, 'none');
    assert.equal(canvas.tabIndex, 0);
    assert.equal(focused, 1, 'the explicit choice moves focus to the scene');
    assert.ok(view.find((node) => node.attributes?.role === 'status' && /^Exploring: drag to look around.*Choose Explore in 3D again to return to page scrolling\.$/.test(node.textContent)).length);
    assert.deepEqual(cameraNow(), before, 'exploring does not move the camera');

    const viewport = view.find((node) => node.className === 'space-viewport')[0];
    Object.assign(viewport, { clientWidth: 900, clientHeight: 500 });
    globalThis.viewerResize();
    assert.deepEqual(cameraNow(), before, 'a resize keeps the camera');
    assert.equal(controls.enabled, true, 'and keeps the mode');

    toggle.dispatch('click');
    assert.equal(toggle.attributes['aria-pressed'], 'false');
    assert.equal(controls.enabled, false);
    assert.equal(canvas.style.touchAction, 'auto');
    assert.equal(canvas.tabIndex, -1);
    assert.equal(focused, 1, 'finishing does not move focus');
    assert.deepEqual(cameraNow(), before);
    view.space.dispose();
  });

  it('offers no exploring without a 3D view', async () => {
    globalThis.viewerFail = 'webgl';
    const view = await openScene();
    assert.equal(view.button('Explore in 3D').disabled, true);
    assert.equal(view.button('Explore in 3D').attributes['aria-pressed'], 'false');
    assert.equal(view.find((node) => node.attributes?.role === 'status' && /Scroll here|Exploring/.test(node.textContent)).length, 0);
    view.space.dispose();
  });
});

describe('see the photographed side', () => {
  const DEG = Math.PI / 180;
  const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);
  const cameraNow = () => ({ position: globalThis.viewerControls.object.position.toArray(), target: globalThis.viewerControls.target.toArray() });

  it('carries the photo’s vantage round with the object, within the share camera limits', async () => {
    const { photographedSideCamera, cameraWithinLimits, CAMERA_LIMITS } = await import('../public/scene-viewer.js');
    const { SHARE_LIMITS } = await import('../shares.mjs');
    assert.equal(CAMERA_LIMITS.coordinate, SHARE_LIMITS.cameraCoordinate);
    assert.deepEqual([CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance], SHARE_LIMITS.cameraDistance);

    const pivot = [0.5, 0, -3];
    const straight = photographedSideCamera(pivot, { offset: [0, 0, 0], yaw: 0 });
    assert.ok(close(straight.position, [0, 0, 0]) && close(straight.target, pivot), 'unturned: the original camera, looking at the object');
    const turned = photographedSideCamera(pivot, { offset: [0, 0, 0], yaw: 150 * DEG });
    const rel = turned.position.map((value, i) => value - pivot[i]);
    assert.ok(close(rel, [-0.5 * Math.cos(150 * DEG) + 3 * Math.sin(150 * DEG), 0, 0.5 * Math.sin(150 * DEG) + 3 * Math.cos(150 * DEG)]));
    assert.ok(rel[2] < 0, 'at 150° the photographed side faces away from the photo, so the camera is behind the object');
    assert.ok(Math.abs(Math.hypot(...rel) - Math.hypot(...pivot)) < 1e-9, 'the distance is unchanged');
    const moved = photographedSideCamera(pivot, { offset: [0.2, 0.1, 0], yaw: 0 });
    assert.ok(close(moved.target, [0.7, 0.1, -3]) && close(moved.position, [0.2, 0.1, 0]));
    assert.equal(photographedSideCamera([0, 0, -9], { offset: [0, 0, 0], yaw: 0 }), null, 'too far: unavailable, not clamped');

    const at = (distance, coordinate = 0) => cameraWithinLimits({ position: [coordinate, 0, distance], target: [coordinate, 0, 0] });
    assert.deepEqual([at(0.5), at(8), at(0.4999), at(8.0001)], [true, true, false, false]);
    assert.deepEqual([at(1, 50), at(1, 50.01)], [true, false]);
    assert.equal(cameraWithinLimits({ position: [NaN, 0, 1], target: [0, 0, 0] }), false);
  });

  it('moves only the camera, to the side of the object as drawn, and nothing moves it back on its own', async () => {
    const { photographedSideCamera } = await import('../public/scene-viewer.js');
    const view = await openScene();
    const turn = view.axis('Turn (degrees)');
    turn.value = '150';
    turn.dispatch('input');
    const before = view.editStatus();
    view.button('See photographed side').dispatch('click');
    const now = cameraNow();
    const expected = photographedSideCamera(now.target, { offset: [0, 0, 0], yaw: 150 * DEG });
    assert.ok(close(now.position, expected.position), 'the drawn 150° preview decides the vantage');
    assert.match(view.find((node) => node.role === 'status' && /^Camera moved to inspect the photographed side/.test(node.textContent))[0].textContent, /Sides the photo did not capture stay empty\.$/);
    assert.equal(view.editStatus(), before, 'the preview is unchanged and unsaved');
    assert.equal(posts.length, 0, 'nothing is sent');

    view.button('Revert to saved').dispatch('click');
    const viewport = view.find((node) => node.className === 'space-viewport')[0];
    Object.assign(viewport, { clientWidth: 800, clientHeight: 400 });
    globalThis.viewerResize();
    assert.deepEqual(cameraNow(), now, 'reverting and resizing leave the camera where it is');

    view.button('Original viewpoint').dispatch('click');
    assert.deepEqual(cameraNow().position, [0, 0, 0]);
    assert.equal(view.find((node) => node.role === 'status' && /Camera moved/.test(node.textContent)).length, 0, 'the receipt clears');
    view.space.dispose();
  });

  it('is unavailable without a 3D view', async () => {
    globalThis.viewerFail = 'webgl';
    const view = await openScene();
    assert.equal(view.button('See photographed side').disabled, true);
    view.space.dispose();
  });
});

describe('sharing follows the recollection panel (one-object scene)', () => {
  it('reads the share choices again when a fresh read finds a new alternative', async () => {
    const view = await openScene();
    const historyReads = () => gets.filter((url) => url.endsWith('/history')).length;
    const sharePanel = () => view.find((node) => node.tag === 'details' && /Share a saved view with visitors/.test(node.textContent))[0];
    const before = historyReads();
    collaboration = { ...collaboration, variants: [{ id: 'vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv', label: 'Kept from Mina', parentVersion: 1, edit: { version: null, offset: [0.2, 0, 0], yaw: 0 }, contributionIds: [], era: null, eraRevision: 0, blocked: false }] };
    view.find((node) => node.tag === 'button' && node.textContent === 'Refresh')[0].dispatch('click');
    await settle();
    await settle();
    assert.ok(historyReads() > before, 'the share choices were read again');
    assert.match(sharePanel().textContent, /Kept from Mina/);
    view.space.dispose();
  });
});
