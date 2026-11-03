import assert from 'node:assert/strict';
import { after, before, beforeEach, afterEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { currentCamera, installViewerShim, rendererState, visitorSurface } from './viewer-shim.mjs';

// The visitor's comparison with the photograph, on the real visitor screen and
// the real viewer through the Three.js stand-ins. The visitor surface's photo
// is 600 x 500.
installViewerShim();

const START = '11111111-1111-4111-8111-111111111111';
const ALT = '22222222-2222-4222-8222-222222222222';
const CAMERA = { position: [0.5, 0.2, 0.4], target: [0, 0, -3] };
const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);

function manifest() {
  const view = (id, label, offset) => ({
    id,
    label,
    edit: { offset, yaw: 0 },
    era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null },
    evidence: { photo: { providerLabel: 'Owner', attributedCaptureDate: null }, geometry: 'model estimate', recollections: [], support: [] },
  });
  return {
    id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
    title: 'Corner shop, synthetic',
    createdAt: '2026-10-31T00:00:00.000Z',
    synthetic: true,
    startViewId: START,
    camera: CAMERA,
    views: [view(START, 'Saved scene', [0, 0, 0]), view(ALT, 'Mina’s recollection', [0.5, 0, 0])],
    stories: [{ id: 'story-1', viewId: START, title: 'Bell', providerLabel: 'Owner', captionAuthorLabel: 'Owner', cues: [{ startMs: 0, endMs: 500, text: 'Synthetic test tone; no speech.' }], durationMs: 500, audio: { type: 'audio/wav', size: 60 } }],
  };
}

function storyWav() {
  const bytes = new Uint8Array(60);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => [...text].forEach((char, i) => (bytes[offset + i] = char.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 52, true);
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
let created;
let revoked;
let audios;
let docListeners;

before(async () => {
  docListeners = {};
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
    addEventListener: (type, listener) => (docListeners[type] = listener),
    removeEventListener: (type) => delete docListeners[type],
  };
  ({ mountVisitor, HEARTBEAT_MS } = await import('../public/visits.js'));
});

after(() => {
  delete globalThis.document;
});

beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  created = [];
  revoked = [];
  audios = [];
  const realCreate = URL.createObjectURL;
  mock.method(URL, 'createObjectURL', (blob) => {
    const url = realCreate(blob);
    created.push(url);
    return url;
  });
  mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

async function open({ check = () => Promise.resolve(true), storyAudio } = {}) {
  const assets = [];
  const source = {
    manifest: () => Promise.resolve(manifest()),
    check,
    asset: (viewId, name) => {
      assets.push(`${viewId}/${name}`);
      return Promise.resolve(name === 'surface.json' ? ok(visitorSurface()) : texture());
    },
    storyAudio: storyAudio ?? (() => Promise.resolve({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? 'audio/wav' : '60') }, arrayBuffer: async () => storyWav().buffer })),
  };
  const container = new FakeElement('div');
  const states = [];
  const view = mountVisitor(container, source, { onState: (state) => states.push(state) });
  await flush();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const viewport = find((node) => node.className === 'space-viewport')[0];
  if (viewport) Object.assign(viewport, { clientWidth: 800, clientHeight: 400 });
  const photo = () => find((node) => node.tag === 'img' && node.className === 'visit-compare-photo')[0];
  return { container, view, states, find, button, viewport, photo, assets };
}

const pressed = (node) => node.attributes['aria-pressed'];

describe('comparing with the photograph', () => {
  it('opens from the photograph’s own viewpoint, fitted to the photo, and shows the photo only after it loads', async () => {
    const v = await open();
    assert.equal(v.states.at(-1), '3d');
    assert.deepEqual(currentCamera(), CAMERA, 'the visit starts from the saved camera');
    const fetched = [...v.assets];
    const urlsBefore = created.length;
    v.button('Compare with the photograph').dispatch('click');
    assert.ok(close(currentCamera().position, [0, 0, 0]) && close(currentCamera().target, [0, 0, -3]), 'the original camera, not the saved start');
    assert.deepEqual(rendererState().size, [480, 400], 'a 600 x 500 photo fitted inside 800 x 400, not stretched or cropped');
    assert.equal(v.button('Compare with the photograph').hidden, true);
    assert.equal(v.button('Photo with the estimated object').hidden, true, 'offered only for a full object');
    assert.equal(pressed(v.button('This reconstruction')), 'true');
    assert.equal(pressed(v.button('Photo')), 'false');
    assert.equal(v.button('Back to the starting view').disabled, true, 'the starting camera is not offered while comparing');
    assert.equal(v.button('Explore in 3D').disabled, true, 'the frame cannot be moved');

    v.button('Photo').dispatch('click');
    assert.match(v.container.textContent, /Loading the photograph…/);
    assert.equal(pressed(v.button('Photo')), 'false', 'not before the image has loaded');
    assert.equal(v.photo().hidden, true);
    v.photo().onload();
    assert.equal(pressed(v.button('Photo')), 'true');
    assert.equal(v.photo().hidden, false);
    assert.equal(v.photo().src, created[0], 'the texture already loaded for this scene');
    assert.deepEqual(v.assets, fetched, 'no new request');
    assert.equal(created.length, urlsBefore, 'no new object URL');
    assert.match(v.container.textContent, /Photo is the copy used for this scene\. Both views use the photo’s viewpoint\./);
    assert.match(v.container.textContent, /model estimate from this one photo, not a measurement\. Areas the photo did not show are left empty\./, 'the always-visible scene note stays');
    v.button('This reconstruction').dispatch('click');
    assert.equal(v.photo().hidden, true);
    v.view.dispose();
  });

  it('leaves exactly as it was: the camera, exploring and the normal framing', async () => {
    const v = await open();
    v.button('Explore in 3D').dispatch('click');
    globalThis.viewerCamera.camera.position.set(1.2, 0.3, 0.9);
    const before = currentCamera();
    v.button('Compare with the photograph').dispatch('click');
    v.button('Leave the comparison').dispatch('click');
    assert.deepEqual(currentCamera(), before, 'the camera viewed before');
    assert.deepEqual(rendererState().size, [800, 400], 'the whole viewport again');
    assert.equal(pressed(v.button('Explore in 3D')), 'true', 'exploring as before');
    assert.equal(v.button('Back to the starting view').disabled, false);
    assert.equal(v.button('Compare with the photograph').hidden, false);
    v.view.dispose();
  });

  it('keeps the photograph’s viewpoint while views change, and the photo is the same photo', async () => {
    const v = await open();
    v.button('Compare with the photograph').dispatch('click');
    v.button('Mina’s recollection').dispatch('click');
    assert.ok(close(currentCamera().position, [0, 0, 0]));
    assert.equal(pressed(v.button('This reconstruction')), 'true');
    assert.match(v.container.textContent, /Switching saved arrangements changes only the reconstruction; it does not establish when the place changed\./);
    v.view.dispose();
  });

  it('keeps the reconstruction when the photo cannot load, and ignores a load that finishes too late', async () => {
    const v = await open();
    v.button('Compare with the photograph').dispatch('click');
    v.button('Photo').dispatch('click');
    v.photo().onerror();
    assert.match(v.container.textContent, /The photograph could not be shown here\. The reconstruction stays as it was\./);
    assert.equal(pressed(v.button('Photo')), 'false');
    assert.equal(v.photo().hidden, true);

    v.button('Photo').dispatch('click');
    mock.timers.tick(10_000);
    assert.match(v.container.textContent, /could not be shown here/, 'a load that takes too long is given up');

    v.button('Photo').dispatch('click');
    const late = v.photo().onload;
    v.button('Leave the comparison').dispatch('click');
    late();
    assert.equal(v.photo().hidden, true, 'nothing shows after leaving');
    assert.equal(v.button('Compare with the photograph').hidden, false);
    v.view.dispose();
  });

  it('keeps the reconstruction when it is chosen while the photo is still loading, and Photo works again after', async () => {
    const v = await open();
    v.button('Compare with the photograph').dispatch('click');
    v.button('Photo').dispatch('click');
    const late = v.photo().onload;
    assert.match(v.container.textContent, /Loading the photograph…/);
    v.button('This reconstruction').dispatch('click');
    assert.doesNotMatch(v.container.textContent, /Loading the photograph…/, 'the pending load is cancelled');
    late();
    assert.equal(pressed(v.button('This reconstruction')), 'true', 'the later choice wins');
    assert.equal(pressed(v.button('Photo')), 'false');
    assert.equal(v.photo().hidden, true);
    mock.timers.tick(10_000);
    assert.doesNotMatch(v.container.textContent, /could not be shown/, 'no stale timeout message');
    v.button('Photo').dispatch('click');
    assert.equal(v.photo().src, created[0], 'a fresh load of the same texture');
    v.photo().onload();
    assert.equal(pressed(v.button('Photo')), 'true');
    assert.equal(v.photo().hidden, false);
    v.view.dispose();
  });

  it('stops a story whose recording is still loading, lists stories without players, and plays nothing after leaving', async () => {
    let answer;
    let aborted = false;
    const v = await open({
      storyAudio: (id, signal) =>
        new Promise((resolve) => {
          answer = resolve;
          signal?.addEventListener('abort', () => (aborted = true));
        }),
    });
    v.find((node) => node.tag === 'button' && node.textContent === 'Play')[0].dispatch('click');
    await flush();
    v.button('Compare with the photograph').dispatch('click');
    assert.equal(aborted, true, 'the pending recording is abandoned');
    assert.equal(v.find((node) => node.tag === 'button' && node.textContent === 'Play').length, 0, 'no player while comparing');
    assert.match(v.container.textContent, /Bell.*Stories can be played after you leave the comparison|Stories can be played after you leave the comparison.*Bell/s);
    answer({ ok: true, status: 200, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => storyWav().buffer });
    await flush();
    v.button('Leave the comparison').dispatch('click');
    await flush();
    assert.ok(v.find((node) => node.tag === 'button' && node.textContent === 'Play')[0], 'a fresh player after leaving');
    assert.equal(audios.every((audio) => !audio.calls.includes('play')), true, 'nothing plays on its own');
    v.view.dispose();
  });

  it('clears the comparison when access is withdrawn, even with the photo showing or loading', async () => {
    let allowed = true;
    const v = await open({ check: () => Promise.resolve(allowed) });
    const textureUrl = created[0];
    v.button('Compare with the photograph').dispatch('click');
    v.button('Photo').dispatch('click');
    v.photo().onload();
    v.button('This reconstruction').dispatch('click');
    v.button('Photo').dispatch('click');
    allowed = false;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.doesNotMatch(v.container.textContent, /Compare|photograph|Corner shop/);
    assert.ok(revoked.includes(textureUrl), 'the photo’s object URL is released');
    v.view.dispose();
  });

  it('starts again without the comparison after the page was hidden', async () => {
    const v = await open();
    v.button('Compare with the photograph').dispatch('click');
    globalThis.document.visibilityState = 'hidden';
    docListeners.visibilitychange();
    assert.equal(v.states.at(-1), 'paused');
    globalThis.document.visibilityState = 'visible';
    docListeners.visibilitychange();
    await flush();
    assert.equal(v.states.at(-1), '3d');
    assert.deepEqual(currentCamera(), CAMERA, 'the saved snapshot camera, not the comparison');
    assert.equal(v.find((node) => node.tag === 'button' && node.textContent === 'Compare with the photograph')[0].hidden, false);
    assert.equal(v.find((node) => node.className === 'visit-compare')[0].hidden, true);
    v.view.dispose();
  });

  it('offers no comparison when the 3D view cannot start', async () => {
    globalThis.viewerFail = 'webgl';
    const v = await open();
    assert.equal(v.states.at(-1), '2d');
    assert.equal(v.button('Compare with the photograph').hidden, true);
    v.view.dispose();
  });
});
