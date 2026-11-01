import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { currentCamera, installViewerShim } from './viewer-shim.mjs';
import { objectSurfaceMeshes } from '../public/photo-scene.js';

// A shared two-object scene: the visitor sees both objects named in text, the
// rule as text, and can pick one object for its photo evidence and stories.
installViewerShim();

const START = '11111111-1111-4111-8111-111111111111';
const CAMERA = { position: [0, 0, 0], target: [0, 0, -3] };
const RULE = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const GRID = 20;
const objects = [
  { id: 'object-1', label: 'Counter', box: [0, 435, 226, 790] },
  { id: 'object-2', label: 'Flour stack', box: [490, 450, 982, 781] },
];
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
  objects: objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box })),
  assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  source: { image_size: [1000, 800] },
};
const story = (id, targetId, label) => ({
  id,
  viewId: START,
  title: `About the ${label}`,
  target: { id: targetId, label },
  providerLabel: 'Owner',
  captionAuthorLabel: 'Owner',
  cues: [{ startMs: 0, endMs: 500, text: 'Synthetic test tone; no speech.' }],
  durationMs: 500,
  audio: { type: 'audio/wav', size: 60 },
});
const manifest = () => ({
  id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
  title: 'Bakery, synthetic',
  createdAt: '2026-11-01T00:00:00.000Z',
  synthetic: true,
  startViewId: START,
  camera: CAMERA,
  objects,
  views: [
    {
      id: START,
      label: 'Saved scene',
      edit: { objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0.5, 0, 0], yaw: 0 }], relationship: RULE },
      era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null },
      evidence: { photo: { providerLabel: 'Owner', attributedCaptureDate: null }, geometry: 'model estimate', recollections: [], support: [] },
    },
  ],
  stories: [story('s-a', 'object-1', 'Counter'), story('s-b', 'object-2', 'Flour stack')],
});

function storyWav() {
  const bytes = new Uint8Array(44 + 16);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => [...text].forEach((char, i) => (bytes[offset + i] = char.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, 16, true);
  return bytes;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) });
const texture = () => ({ ok: true, status: 200, json: async () => ({}), blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }) });
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let mountVisitor;
let HEARTBEAT_MS;
let photographedSideCamera;
let audios;

before(async () => {
  globalThis.document = {
    createElement: (tag) => {
      if (tag !== 'audio') return new FakeElement(tag);
      const audio = new FakeElement('audio');
      audio.calls = [];
      audio.play = () => (audio.calls.push('play'), Promise.resolve());
      audio.pause = () => audio.calls.push('pause');
      audio.load = () => audio.calls.push('load');
      audios.push(audio);
      return audio;
    },
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  ({ mountVisitor, HEARTBEAT_MS } = await import('../public/visits.js'));
  ({ photographedSideCamera } = await import('../public/scene-viewer.js'));
});

after(() => {
  delete globalThis.document;
});

beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  audios = [];
  mock.method(URL, 'revokeObjectURL', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

async function open(data = manifest(), scene = surface) {
  const calls = [];
  const src = {
    calls,
    allowed: true,
    manifest: () => (calls.push('manifest'), Promise.resolve(data)),
    check: () => (calls.push('check'), Promise.resolve(src.allowed)),
    asset: (viewId, name) => (calls.push(`asset ${name}`), Promise.resolve(name === 'surface.json' ? ok(scene) : texture())),
    storyAudio: () => {
      const bytes = storyWav();
      return Promise.resolve({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? 'audio/wav' : '60') }, arrayBuffer: async () => bytes.buffer });
    },
  };
  const container = new FakeElement('div');
  const states = [];
  const view = mountVisitor(container, src, { onState: (state) => states.push(state) });
  await flush();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const titles = () => find((node) => node.className === 'space-choice-label').map((node) => node.textContent);
  return { container, view, states, find, button, titles, src };
}

describe('visitor view of a two-object scene', () => {
  it('names both objects and the rule in text', async () => {
    const v = await open();
    assert.equal(v.states.at(-1), '3d');
    assert.equal(v.button('Explore in 3D').disabled, false, 'exploring is offered once the 3D view exists');
    const text = v.container.textContent;
    assert.match(text, /Rule: A: Counter stays left of B: Flour stack from the original photo\./);
    assert.match(text, /Arrangement in this view: A: Counter left\/right 0\.00.*; B: Flour stack left\/right 0\.50/);
    assert.deepEqual(v.titles(), ['About the Counter', 'About the Flour stack']);
    v.view.dispose();
  });

  it('picking an object shows its box evidence and only its stories, and stops a playing story', async () => {
    const v = await open();
    v.find((node) => node.tag === 'button' && node.textContent === 'Play')[0].dispatch('click');
    await flush();
    assert.equal(audios.length, 1);
    v.button('B: Flour stack').dispatch('click');
    assert.ok(audios[0].calls.includes('pause'), 'picking an object stops the story');
    assert.equal(v.button('B: Flour stack').attributes['aria-pressed'], 'true');
    assert.deepEqual(v.titles(), ['About the Flour stack']);
    assert.match(v.container.textContent, /Photo evidence for B: Flour stack: the box the owner drew\./);
    assert.equal(v.find((node) => node.tag === 'summary')[0].textContent, 'Photo evidence for B: Flour stack', 'named even while collapsed');
    const box = v.find((node) => node.className === 'box-overlay box-overlay-b')[0];
    assert.deepEqual([box.style.left, box.style.width], ['49%', '49.2%']);
    v.button('All objects').dispatch('click');
    assert.deepEqual(v.titles(), ['About the Counter', 'About the Flour stack']);
    assert.doesNotMatch(v.container.textContent, /Photo evidence for/);
    v.view.dispose();
  });
});

describe('photographed side of a chosen object for visitors', () => {
  const ALT = '22222222-2222-4222-8222-222222222222';
  const TURNED = (166 * Math.PI) / 180;
  const CHOOSE = 'See photographed side (choose an object first)';
  const withAlternative = () => {
    const data = manifest();
    data.views.push({
      ...data.views[0],
      id: ALT,
      label: 'Alternative arrangement',
      edit: { objects: [{ id: 'object-1', offset: [0.3, 0, 0.2], yaw: TURNED }, { id: 'object-2', offset: [0.5, 0, 0], yaw: 0 }], relationship: RULE },
    });
    return data;
  };
  const pivots = Object.fromEntries(objectSurfaceMeshes(surface).objects.map((object) => [object.id, object.pivot]));
  const expected = (id, transform) => photographedSideCamera(pivots[id], transform);
  const near = (actual, wanted) => [...actual.position, ...actual.target].every((value, i) => Math.abs(value - [...wanted.position, ...wanted.target][i]) < 1e-9);
  const side = (v) => v.find((node) => node.tag === 'button' && (node.textContent === CHOOSE || node.textContent.startsWith('See photographed side of ')))[0];
  const status = (v) => v.find((node) => node.role === 'status' && /photographed side|camera did not move/.test(node.textContent))[0]?.textContent ?? '';
  const pressedText = (v) => v.find((node) => node.tag === 'button' && node.attributes['aria-pressed'] === 'true').map((node) => node.textContent);

  it('needs a chosen object and moves only on a press, to the selected view’s current transform with its exact turn', async () => {
    const data = withAlternative();
    const before = structuredClone(data);
    const v = await open(data);
    assert.deepEqual(currentCamera(), CAMERA, 'the published camera first');
    assert.equal(side(v).textContent, CHOOSE);
    assert.equal(side(v).disabled, true);
    assert.equal(side(v).hidden, false);
    v.button('A: Counter').dispatch('click');
    v.button('Alternative arrangement').dispatch('click');
    assert.deepEqual(currentCamera(), CAMERA, 'choosing an object or a view never moves the camera');
    assert.equal(side(v).textContent, 'See photographed side of A: Counter');
    const calls = v.src.calls.length;
    side(v).dispatch('click');
    const turned = expected('object-1', { offset: [0.3, 0, 0.2], yaw: TURNED });
    assert.ok(turned && near(currentCamera(), turned), 'the Alternative arrangement transform, 166 degrees');
    assert.ok(!near(currentCamera(), expected('object-1', { offset: [0.3, 0, 0.2], yaw: Math.round(TURNED * 100) / 100 })), 'the exact stored turn, not a rounded one');
    assert.match(status(v), /^Camera moved to inspect the photographed side of A: Counter, as arranged in “Alternative arrangement” when you pressed the button\. Sides the photo did not capture stay empty\. This is not the photo’s original viewpoint, and it does not show history or physical accuracy\.$/);
    assert.deepEqual(v.src.calls.slice(calls), [], 'nothing is requested');
    assert.deepEqual(data, before, 'nothing is edited');
    assert.deepEqual(pressedText(v), ['Alternative arrangement', 'A: Counter'], 'view and object stay selected; exploring is not turned on');
    assert.equal(audios.length, 0, 'nothing plays');

    const moved = currentCamera();
    v.button('Saved scene').dispatch('click');
    assert.deepEqual(currentCamera(), moved, 'switching keeps the same camera and does not repeat the move');
    assert.equal(status(v), '', 'the old status is cleared');
    side(v).dispatch('click');
    assert.ok(near(currentCamera(), expected('object-1', { offset: [0, 0, 0], yaw: 0 })), 'now the Saved scene transform');
    assert.match(status(v), /as arranged in “Saved scene”/);
    v.button('B: Flour stack').dispatch('click');
    assert.equal(status(v), '');
    assert.ok(near(currentCamera(), expected('object-1', { offset: [0, 0, 0], yaw: 0 })), 'picking another object does not move');
    side(v).dispatch('click');
    assert.ok(near(currentCamera(), expected('object-2', { offset: [0.5, 0, 0], yaw: 0 })));
    v.button('Back to the starting view').dispatch('click');
    assert.deepEqual(currentCamera(), CAMERA);
    assert.equal(status(v), '', 'the published camera replaces the inspected one');
    side(v).dispatch('click');
    v.button('All objects').dispatch('click');
    assert.equal(side(v).textContent, CHOOSE);
    assert.equal(side(v).disabled, true);
    assert.equal(status(v), '');
    v.view.dispose();
  });

  it('is unavailable while comparing with the photograph and returns without moving', async () => {
    const v = await open(withAlternative());
    v.button('A: Counter').dispatch('click');
    side(v).dispatch('click');
    const inspected = currentCamera();
    v.button('Compare with the photograph').dispatch('click');
    assert.equal(side(v).disabled, true);
    assert.equal(status(v), '', 'the earlier status no longer describes the camera');
    const framed = currentCamera();
    side(v).dispatch('click');
    assert.deepEqual(currentCamera(), framed, 'the photo framing is kept');
    v.button('Leave the comparison').dispatch('click');
    assert.ok(near(currentCamera(), inspected), 'back to the camera from before comparing');
    assert.equal(side(v).disabled, false);
    assert.equal(status(v), '');
    v.view.dispose();
  });

  it('keeps the camera and says so when the viewer refuses the move', async () => {
    const far = { ...surface, depth: Array(GRID * GRID).fill(9), assumptions: { ...surface.assumptions, far: 9 } };
    const v = await open(manifest(), far);
    assert.equal(v.states.at(-1), '3d');
    v.button('A: Counter').dispatch('click');
    const before = currentCamera();
    side(v).dispatch('click');
    assert.deepEqual(currentCamera(), before);
    assert.equal(status(v), 'The photographed side of A: Counter is outside this scene’s camera limits, so the camera did not move.');
    v.view.dispose();
  });

  it('is not offered in the 2D fallback or for a one-object visit', async () => {
    globalThis.viewerFail = 'webgl';
    const flat = await open(withAlternative());
    assert.equal(flat.states.at(-1), '2d');
    assert.equal(side(flat).hidden, true);
    flat.button('A: Counter').dispatch('click');
    assert.equal(side(flat).hidden, true);
    flat.view.dispose();
    globalThis.viewerFail = null;
    const legacy = manifest();
    delete legacy.objects;
    const one = await open(legacy);
    assert.equal(side(one), undefined);
    one.view.dispose();
  });

  it('leaves nothing of the control or its status after revocation or disposal', async () => {
    const v = await open(withAlternative());
    v.button('A: Counter').dispatch('click');
    side(v).dispatch('click');
    v.src.allowed = false;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.equal(side(v), undefined);
    assert.doesNotMatch(v.container.textContent, /photographed side|Counter/);
    v.view.dispose();
    const w = await open(withAlternative());
    w.button('A: Counter').dispatch('click');
    side(w).dispatch('click');
    w.view.dispose();
    assert.equal(w.container.children.length, 0);
  });
});
