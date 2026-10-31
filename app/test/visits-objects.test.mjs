import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

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
  ({ mountVisitor } = await import('../public/visits.js'));
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

async function open() {
  const src = {
    manifest: () => Promise.resolve(manifest()),
    check: () => Promise.resolve(true),
    asset: (viewId, name) => Promise.resolve(name === 'surface.json' ? ok(surface) : texture()),
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
  return { container, view, states, find, button, titles };
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
