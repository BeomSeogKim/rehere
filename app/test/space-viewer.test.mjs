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
let collaboration;
let storyList;
let history;

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
    if (url.endsWith('/proposals')) return json(200, proposals);
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
  for (const name of ['document', 'window', 'ResizeObserver', 'fetch', 'viewerLog', 'viewerFail']) delete globalThis[name];
});

beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  posts = [];
  heldGets = null;
  proposals = [];
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

async function openScene({ sources = [] } = {}) {
  const container = new FakeElement('section');
  const draft = { id: DRAFT_ID, photos: [{ name: 'photo-1.jpg', sourceId: SOURCE_ID }], sources };
  const granted = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: false } };
  const space = mountSpace(container, { draft, sourceFor: () => granted });
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  button('Open scene').dispatch('click');
  await settle();
  const editStatus = () => find((node) => node.tag === 'p' && node.role === 'status' && node.parent?.className === 'space-edit')[0].textContent;
  // The scene's own message follows its viewport.
  const viewMessage = () => {
    const viewport = find((node) => node.className === 'space-viewport')[0];
    return viewport.parent.children[viewport.parent.children.indexOf(viewport) + 1].textContent;
  };
  const axis = (label) => find((node) => node.tag === 'input' && node.attributes['aria-label'] === label)[0];
  const canvases = () => find((node) => node.tag === 'canvas');
  return { space, button, editStatus, viewMessage, axis, canvases, find };
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
    const [title, start, end] = storyPanel.findAll((node) => node.tag === 'input' && node.type === 'text');
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
    assert.match(sharePanel.textContent, /Recorded stories changed\. Make a new preview before issuing a link\./);
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
