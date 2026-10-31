import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';

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
  render() {}
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
}`;
const controlsShim = `
import { Vector3 } from '${three}';
export class OrbitControls {
  constructor() {
    this.target = new Vector3();
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

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      let respond;
      const promise = new Promise((resolve) => (respond = resolve));
      posts.push({ body: JSON.parse(options.body), respond });
      return promise;
    }
    if (url.endsWith('/surface.json')) return json(200, surfaceBody);
    if (url.endsWith('/reconstructions')) return json(200, [job]);
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
  for (const name of ['document', 'window', 'ResizeObserver', 'fetch', 'viewerLog', 'viewerFail']) delete globalThis[name];
});

beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  posts = [];
  heldGets = null;
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

async function openScene() {
  const container = new FakeElement('section');
  const draft = { id: DRAFT_ID, photos: [{ name: 'photo-1.jpg', sourceId: SOURCE_ID }] };
  const granted = { kind: 'photo', permissions: { place: true, model: true, share: false } };
  const space = mountSpace(container, { draft, sourceFor: () => granted });
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  button('Open scene').dispatch('click');
  await settle();
  const editStatus = () => find((node) => node.tag === 'p' && node.role === 'status' && node.parent?.className === 'space-edit')[0].textContent;
  const viewMessage = () => find((node) => node.className === 'form-message')[0].textContent;
  const axis = (label) => find((node) => node.tag === 'input' && node.attributes['aria-label'] === label)[0];
  const canvases = () => find((node) => node.tag === 'canvas');
  return { space, button, editStatus, viewMessage, axis, canvases };
}

const count = (entry) => globalThis.viewerLog.filter((item) => item === entry).length;

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
