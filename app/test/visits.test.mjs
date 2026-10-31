import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { currentCamera, installViewerShim, visitorSurface } from './viewer-shim.mjs';

installViewerShim();

const TOKEN = `rhv_${'a'.repeat(43)}`;
const START = '11111111-1111-4111-8111-111111111111';
const ALT = '22222222-2222-4222-8222-222222222222';
const CAMERA = { position: [0.5, 0.2, 0.4], target: [0, 0, -3] };

function manifest() {
  return {
    id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
    title: 'Corner shop, synthetic',
    createdAt: '2026-10-31T00:00:00.000Z',
    synthetic: true,
    startViewId: START,
    camera: CAMERA,
    views: [
      {
        id: START,
        label: 'Saved scene',
        edit: { offset: [0, 0, 0], yaw: 0 },
        era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null },
        evidence: { photo: { providerLabel: 'Owner', attributedCaptureDate: null }, geometry: 'model estimate', recollections: [], support: [] },
      },
      {
        id: ALT,
        label: 'Mina’s recollection',
        edit: { offset: [0.5, 0, 0], yaw: 0.4 },
        era: { kind: 'relative', label: 'before the renovation', start: null, end: null, statement: 'Shop records', assertedByLabel: 'Owner', relation: 'before', relativeToViewId: START },
        evidence: {
          photo: { providerLabel: 'Owner', attributedCaptureDate: '1998-07-01' },
          geometry: 'model estimate',
          support: [{ kind: 'human_recollection', providerLabel: 'Mina', status: 'owner-selected' }],
          recollections: [{ providerLabel: 'Mina', text: 'The counter <b>faced</b> the window.', periodClaim: 'summer' }],
        },
      },
    ],
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) });
const textureResponse = () => ({ ok: true, status: 200, json: async () => ({}), blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }) });
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let mountVisitor;
let visitSource;
let HEARTBEAT_MS;
let HEARTBEAT_TIMEOUT_MS;
let revoked;
let created;
let docListeners;
let audios = [];

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
  ({ mountVisitor, visitSource, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS } = await import('../public/visits.js'));
});

after(() => {
  delete globalThis.document;
});

beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  revoked = [];
  created = [];
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

// A source whose every call is recorded and can be held or answered later.
function source(overrides = {}) {
  const calls = [];
  const s = {
    calls,
    manifest: (signal) => {
      calls.push('manifest');
      return overrides.manifest ? overrides.manifest(signal) : Promise.resolve(manifest());
    },
    check: (signal) => {
      calls.push('check');
      return overrides.check ? overrides.check(signal) : Promise.resolve(true);
    },
    asset: (viewId, name, signal) => {
      calls.push(`asset ${viewId} ${name}`);
      if (overrides.asset) return overrides.asset(viewId, name, signal);
      return Promise.resolve(name === 'surface.json' ? ok(visitorSurface()) : textureResponse());
    },
  };
  return s;
}

function open(src) {
  const container = new FakeElement('div');
  const states = [];
  const view = mountVisitor(container, src, { onState: (state) => states.push(state) });
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  return { container, view, states, find, button };
}

const count = (entry) => globalThis.viewerLog.filter((item) => item === entry).length;

describe('visitor screen', () => {
  it('loads the start view’s assets, checks access once more, then shows the scene from the saved camera', async () => {
    const src = source();
    const v = open(src);
    await flush();
    assert.deepEqual(src.calls, ['manifest', `asset ${START} surface.json`, `asset ${START} texture.jpg`, 'check']);
    assert.equal(v.states.at(-1), '3d');
    assert.equal(count('renderer'), 1);
    assert.deepEqual(currentCamera(), CAMERA);
    assert.match(v.container.textContent, /Corner shop, synthetic/);
    const shared = new Date('2026-10-31T00:00:00.000Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    assert.ok(v.container.textContent.includes(`Shared ${shared} · saved copy 7f3a9c2e`));
    assert.doesNotMatch(v.container.textContent, /0123456789ab/, 'only a short form of the public id');
    assert.match(v.container.textContent, /Synthetic test material/);
    assert.match(v.container.textContent, /Time unknown/);
    assert.match(v.container.textContent, /model estimate from this one photo, not a measurement/);
    assert.equal(v.find((node) => node.tag === 'a').length, 0, 'no download links');
    assert.equal(v.find((node) => ['input', 'textarea', 'form'].includes(node.tag)).length, 0, 'no editing or contribution controls');
    v.view.dispose();
  });

  it('switches views on the same camera, labels recollections and assertions, and can return to the start', async () => {
    const v = open(source());
    await flush();
    globalThis.viewerCamera.camera.position.set(1, 1, 1);
    v.button('Mina’s recollection').dispatch('click');
    assert.deepEqual(currentCamera().position, [1, 1, 1], 'switching keeps the camera');
    const text = v.container.textContent;
    assert.match(text, /Owner’s assertion: before the renovation \(before “Saved scene”\)/);
    assert.match(text, /Based on: Shop records \(asserted by Owner\)/);
    assert.match(text, /date given by them: 1998-07-01/);
    assert.match(text, /Arrangement: based on a recollection by Mina, selected by the owner\. This is separate from the model’s shape estimate\./);
    assert.match(text, /In Mina’s own words:The counter <b>faced<\/b> the window\./);
    assert.equal(v.find((node) => node.tag === 'b').length, 0);
    assert.match(text, /None of this is verified history/);
    v.button('Back to the starting view').dispatch('click');
    assert.deepEqual(currentCamera(), CAMERA);
    v.view.dispose();
  });

  it('closes everything at the first failed heartbeat and shows only a generic message', async () => {
    let allowed = true;
    const v = open(source({ check: () => Promise.resolve(allowed) }));
    await flush();
    assert.equal(v.states.at(-1), '3d');
    allowed = false;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.equal(count('renderer.dispose'), 1);
    assert.deepEqual(revoked, created, 'every object URL was revoked');
    assert.match(v.container.textContent, /^This shared view is not available\./);
    assert.match(v.container.textContent, /cannot be removed from here/);
    assert.doesNotMatch(v.container.textContent, /Corner shop|Mina/);
    v.view.dispose();
  });

  it('treats a heartbeat that does not answer within the timeout as a failure', async () => {
    let calls = 0;
    const check = (signal) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(true);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const v = open(source({ check }));
    await flush();
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(v.states.at(-1), '3d', 'still waiting within the timeout');
    mock.timers.tick(HEARTBEAT_TIMEOUT_MS);
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.equal(count('renderer.dispose'), 1);
    v.view.dispose();
  });

  it('stops at once when hidden, ignores the old heartbeat, and re-authorizes from scratch on return', async () => {
    let answer;
    let held = false;
    const src = source({
      check: () => {
        if (!held) return Promise.resolve(true);
        return new Promise((resolve) => (answer = resolve));
      },
    });
    const v = open(src);
    await flush();
    held = true;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    globalThis.document.visibilityState = 'hidden';
    docListeners.visibilitychange();
    assert.equal(v.states.at(-1), 'paused');
    assert.equal(count('renderer.dispose'), 1);
    assert.doesNotMatch(v.container.textContent, /Corner shop/);
    answer(true);
    await flush();
    assert.equal(v.states.at(-1), 'paused', 'the old heartbeat cannot reopen it');
    const before = src.calls.filter((call) => call === 'manifest').length;
    held = false;
    globalThis.document.visibilityState = 'visible';
    docListeners.visibilitychange();
    await flush();
    assert.equal(src.calls.filter((call) => call === 'manifest').length, before + 1);
    assert.equal(v.states.at(-1), '3d');
    v.view.dispose();
  });

  it('ignores a denial from a heartbeat that belonged to an earlier opening', async () => {
    let answer;
    let held = false;
    const src = source({
      check: () => {
        if (!held) return Promise.resolve(true);
        return new Promise((resolve) => (answer = resolve));
      },
    });
    const v = open(src);
    await flush();
    held = true;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    const stale = answer;
    held = false;
    globalThis.document.visibilityState = 'hidden';
    docListeners.visibilitychange();
    globalThis.document.visibilityState = 'visible';
    docListeners.visibilitychange();
    await flush();
    assert.equal(v.states.at(-1), '3d', 'reopened with fresh checks');
    stale(false);
    await flush();
    assert.equal(v.states.at(-1), '3d', 'the old denial does not close the new view');
    v.view.dispose();
  });

  it('fetches nothing while the page starts hidden, then authorizes from scratch when shown', async () => {
    globalThis.document.visibilityState = 'hidden';
    const src = source();
    const v = open(src);
    await flush();
    assert.deepEqual(src.calls, []);
    assert.equal(v.states.at(-1), 'paused');
    assert.equal(count('renderer'), 0);
    globalThis.document.visibilityState = 'visible';
    docListeners.visibilitychange();
    await flush();
    assert.deepEqual(src.calls, ['manifest', `asset ${START} surface.json`, `asset ${START} texture.jpg`, 'check']);
    assert.equal(v.states.at(-1), '3d');
    v.view.dispose();
  });

  it('does not show the scene when the last check before showing it fails', async () => {
    const v = open(source({ check: () => Promise.resolve(false) }));
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.equal(count('renderer'), 0);
    v.view.dispose();
  });

  it('drops answers that arrive after it was closed', async () => {
    let respond;
    const v = open(source({ manifest: () => new Promise((resolve) => (respond = resolve)) }));
    await flush();
    v.view.dispose();
    respond(manifest());
    await flush();
    assert.equal(count('renderer'), 0);
    assert.equal(v.container.children.length, 0);
  });

  it('shows the photo and text without claiming a 3D view when WebGL is unavailable', async () => {
    globalThis.viewerFail = 'webgl';
    const v = open(source());
    await flush();
    assert.equal(v.states.at(-1), '2d');
    assert.ok(!v.states.includes('3d'));
    assert.match(v.container.textContent, /3D view is not available in this browser/);
    assert.equal(v.find((node) => node.tag === 'img')[0].src, created[0]);
    v.view.dispose();
    assert.deepEqual(revoked, created);
  });

  it('reads a public visit with the visit token only, never cookies', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      if (url === '/api/visit') return init.method === 'HEAD' ? { ok: true, status: 200 } : ok(manifest());
      return url.endsWith('surface.json') ? ok(visitorSurface()) : textureResponse();
    };
    const v = open(visitSource(TOKEN));
    await flush();
    assert.equal(v.states.at(-1), '3d');
    assert.deepEqual(
      requests.map((r) => `${r.init.method} ${r.url}`),
      ['GET /api/visit', `GET /api/visit/assets/${START}/surface.json`, `GET /api/visit/assets/${START}/texture.jpg`, 'HEAD /api/visit'],
    );
    for (const { url, init } of requests) {
      assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.referrerPolicy, 'no-referrer');
      assert.ok(!url.includes(TOKEN), 'the token is never in a URL');
    }
    v.view.dispose();
    delete globalThis.fetch;
  });
});

describe('recorded stories for visitors', () => {
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

  function withStory() {
    const data = manifest();
    data.stories = [{ id: 'pub-story', viewId: ALT, title: 'Bell', providerLabel: 'Owner', captionAuthorLabel: 'Owner', cues: [{ startMs: 0, endMs: 500, text: 'Synthetic test tone; no speech.' }], durationMs: 500, audio: { type: 'audio/wav', size: 60 } }];
    return data;
  }

  it('lists a story only on its own view, plays nothing until Play, and stops it on a view change', async () => {
    const requested = [];
    let allowed = true;
    const src = source({ manifest: () => Promise.resolve(withStory()), check: () => Promise.resolve(allowed) });
    src.storyAudio = (id) => {
      requested.push(id);
      const bytes = storyWav();
      return Promise.resolve({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? 'audio/wav' : '60') }, arrayBuffer: async () => bytes.buffer });
    };
    const v = open(src);
    await flush();
    assert.doesNotMatch(v.container.textContent, /Recorded stories/, 'not on the start view');
    v.button('Mina’s recollection').dispatch('click');
    assert.match(v.container.textContent, /Recorded stories for this view/);
    assert.match(v.container.textContent, /Recording by Owner\. Captions written by Owner; they are not checked by Rehere\. Nothing plays until you press Play\./);
    assert.deepEqual(requested, []);
    v.find((node) => node.tag === 'button' && node.textContent === 'Play')[0].dispatch('click');
    await flush();
    assert.deepEqual(requested, ['pub-story']);
    assert.equal(audios.length, 1);
    v.button('Saved scene').dispatch('click');
    assert.ok(audios[0].calls.includes('pause'), 'switching view stops the story');
    assert.equal(audios[0].attributes.src, undefined);

    v.button('Mina’s recollection').dispatch('click');
    v.find((node) => node.tag === 'button' && node.textContent === 'Play')[0].dispatch('click');
    await flush();
    allowed = false;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.ok(audios[1].calls.includes('pause'), 'a failed heartbeat silences the story');
    assert.deepEqual([...revoked].sort(), [...created].sort(), 'every local copy was released');
    v.view.dispose();
  });
});
