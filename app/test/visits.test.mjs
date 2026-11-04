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

function open(src, options = {}) {
  const container = new FakeElement('div');
  const states = [];
  const view = mountVisitor(container, src, { ...options, onState: (state) => states.push(state) });
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  return { container, view, states, find, button };
}

const count = (entry) => globalThis.viewerLog.filter((item) => item === entry).length;

describe('visitor screen', () => {
  it('opts into the labelled limited view for the source camera with harmless orbit roundoff', async () => {
    const data = manifest();
    data.camera = { position: [0, 1.8369701987210297e-16, 0], target: [0, 0, -3] };
    const v = open(source({ manifest: async () => data }), { limitedPhotoView: true });
    await flush();
    assert.match(v.container.textContent, /Limited-view demo: rotation stays within 10 degrees/);
    assert.equal(globalThis.viewerCamera.controls.enablePan, false);
    assert.equal(globalThis.viewerCamera.controls.enableZoom, false);
    v.button('Explore in 3D').dispatch('click');
    assert.match(v.container.textContent, /Panning and zoom are off/);
    v.button('Mina’s recollection').dispatch('click');
    assert.deepEqual(currentCamera(), data.camera);
    v.view.dispose();
    const custom = open(source(), { limitedPhotoView: true });
    await flush();
    assert.doesNotMatch(custom.container.textContent, /Limited-view demo/);
    assert.deepEqual(currentCamera(), CAMERA);
    custom.view.dispose();
  });
  it('shows shared words only beside their selected saved view and keeps the camera', async () => {
    const data = manifest();
    data.views[1].evidence.arrangement = 'memory';
    data.views[1].memoryWords = { text: 'Fictional words about the counter.' };
    const v = open(source({ manifest: async () => data }));
    await flush();
    assert.doesNotMatch(v.container.textContent, /Fictional words about the counter/);
    v.button('Mina’s recollection').dispatch('click');
    assert.match(v.container.textContent, /Words shared about this change/);
    assert.match(v.container.textContent, /Fictional words about the counter/);
    assert.doesNotMatch(v.container.textContent, /memory's words are not included/);
    assert.deepEqual(currentCamera(), CAMERA);
    v.button('Saved scene').dispatch('click');
    assert.doesNotMatch(v.container.textContent, /Fictional words about the counter/);
    assert.deepEqual(currentCamera(), CAMERA);
    v.view.dispose();
  });
  it('shows the server attribution of source-backed words, and withholds words whose attribution is malformed', async () => {
    const data = manifest();
    data.views[1].evidence.arrangement = 'memory';
    data.views[1].memoryWords = { text: 'Synthetic source words.', attribution: { creator: 'Synthetic Author', originKind: 'public', reference: 'Synthetic reference, p. 1' } };
    const v = open(source({ manifest: async () => data }));
    await flush();
    v.button('Mina’s recollection').dispatch('click');
    const text = v.container.textContent;
    assert.match(text, /Attributed to Synthetic Author/);
    assert.match(text, /Synthetic reference, p\. 1/);
    assert.match(text, /Public source; attribution as given by the owner, not verified\./);
    v.view.dispose();
    const bad = manifest();
    bad.views[1].evidence.arrangement = 'memory';
    bad.views[1].memoryWords = { text: 'Synthetic source words.', attribution: { creator: 'Synthetic Author', originKind: 'invented', reference: '' } };
    const w = open(source({ manifest: async () => bad }));
    await flush();
    w.button('Mina’s recollection').dispatch('click');
    assert.doesNotMatch(w.container.textContent, /Synthetic source words/);
    assert.doesNotMatch(w.container.textContent, /based on these shared words/);
    w.view.dispose();
  });
  it('clears shared words when a later access check fails', async () => {
    const data = manifest();
    data.views[0].evidence.arrangement = 'memory';
    data.views[0].memoryWords = { text: 'Fictional words about the counter.' };
    let allowed = true;
    const v = open(source({ manifest: async () => data, check: async () => allowed }));
    await flush();
    assert.match(v.container.textContent, /Fictional words about the counter/);
    allowed = false;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.doesNotMatch(v.container.textContent, /Fictional words about the counter/);
    v.view.dispose();
  });
  it('keeps a long multiline statement compact beside the scene while preserving its exact full text', async () => {
    const data = manifest();
    const text = `${'x'.repeat(1950)}\nA second synthetic line.`;
    assert.ok(text.length <= 2000);
    data.views[0].evidence.arrangement = 'memory';
    data.views[0].memoryWords = { text };
    const v = open(source({ manifest: async () => data }));
    await flush();
    const stage = v.find((node) => node.className === 'scene-stage')[0];
    const inspector = v.find((node) => node.className === 'scene-inspector')[0];
    const compact = v.find((node) => node.className?.includes('visit-memory-summary'))[0];
    const full = v.find((node) => node.className?.includes('visit-memory-full'))[0];
    assert.equal(compact.parent, inspector);
    assert.ok(compact.textContent.length < 400);
    assert.match(compact.textContent, /Excerpt:/);
    assert.equal(full.tag, 'details');
    assert.equal(full.open, false);
    assert.equal(full.children.find((node) => node.tag === 'p').textContent, text);
    assert.notEqual(full.parent, stage, 'expanded text cannot grow the stage');
    // Switching between a view with words and one without must not change
    // what sits above or around the 3D view, so the scene keeps its size.
    const layout = () => stage.children.map((node) => `${node.tag}.${node.className}:${Boolean(node.hidden)}`);
    const withWords = layout();
    v.button('Mina’s recollection').dispatch('click');
    assert.equal(compact.hidden, true);
    assert.deepEqual(layout(), withWords);
    v.view.dispose();
  });
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
    assert.equal(v.button('Inspect estimated object').hidden, true, 'no inspection without a full object');
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

describe('returning to a hidden visit', () => {
  const OBJECTS = [
    { id: 'object-1', label: 'Counter', box: [100, 100, 300, 300] },
    { id: 'object-2', label: 'Flour stack', box: [320, 120, 500, 380] },
  ];
  const MOVED = { position: [1.25, -0.5, 2.75], target: [0.1, 0.2, -2.9] };
  const twoObjects = (overrides = {}) => ({ ...manifest(), objects: OBJECTS, ...overrides });
  const hide = () => {
    globalThis.document.visibilityState = 'hidden';
    docListeners.visibilitychange();
  };
  const show = () => {
    globalThis.document.visibilityState = 'visible';
    docListeners.visibilitychange();
  };
  const moveCamera = ({ position, target }) => {
    globalThis.viewerCamera.camera.position.set(...position);
    globalThis.viewerCamera.controls.target.set(...target);
  };
  const close = (actual, expected) => [...actual.position, ...actual.target].every((value, i) => Math.abs(value - [...expected.position, ...expected.target][i]) < 1e-9);
  const pressed = (v, predicate) => v.find((node) => node.tag === 'button' && predicate(node))[0]?.attributes['aria-pressed'];
  const viewPressed = (v, id) => pressed(v, (node) => node.viewId === id);
  const objectPressed = (v, id) => pressed(v, (node) => node.objectId === id);
  // A visit source whose manifest can be replaced or held per opening.
  function visit(manifests) {
    const queue = [...manifests];
    const src = source({ manifest: () => (queue.length > 1 ? queue.shift() : queue[0])() });
    src.kind = 'visit';
    return src;
  }
  async function chooseAndMove(v) {
    v.find((node) => node.tag === 'button' && node.viewId === ALT)[0].dispatch('click');
    v.find((node) => node.tag === 'button' && node.objectId === 'object-2')[0].dispatch('click');
    moveCamera(MOVED);
  }

  it('drops everything on hide, shows nothing until the fresh checks pass, then restores the same view, object and camera', async () => {
    let answer;
    const answers = [() => Promise.resolve(twoObjects()), () => new Promise((resolve) => (answer = resolve))];
    const src = visit(answers);
    const v = open(src);
    await flush();
    await chooseAndMove(v);
    const urlsBefore = [...created];
    hide();
    assert.equal(v.states.at(-1), 'paused');
    assert.ok(globalThis.viewerLog.includes('renderer.dispose'), 'the scene is released at once');
    for (const url of urlsBefore) assert.ok(revoked.includes(url), 'its local copies are released');
    assert.doesNotMatch(v.container.textContent, /Corner shop|Mina|counter/);
    const calls = src.calls.length;
    show();
    await flush();
    assert.equal(src.calls[calls], 'manifest', 'a fresh read starts');
    assert.doesNotMatch(v.container.textContent, /Corner shop/, 'nothing is shown while it is being checked');
    answer(twoObjects());
    await flush();
    assert.deepEqual(src.calls.slice(calls), ['manifest', `asset ${START} surface.json`, `asset ${START} texture.jpg`, 'check'], 'the full admission, unchanged');
    assert.equal(v.states.at(-1), '3d');
    assert.equal(viewPressed(v, ALT), 'true');
    assert.equal(objectPressed(v, 'object-2'), 'true');
    assert.ok(close(currentCamera(), MOVED), 'the same camera');
    assert.equal(v.button('Explore in 3D').attributes['aria-pressed'], 'false', 'back in page-scroll mode');
    assert.equal(v.button('Compare with the photograph').hidden, false, 'not comparing');
    assert.equal(audios.filter((audio) => audio.calls.includes('play')).length, 0, 'no audio plays');
    v.view.dispose();
  });

  it('uses the published start for a different saved copy, a missing view or a missing object, and a camera only with its own view', async () => {
    const cases = [
      { next: twoObjects({ id: '00000000-0000-4000-8000-000000000000' }), view: START, object: null, camera: CAMERA },
      { next: twoObjects({ views: [manifest().views[0]] }), view: START, object: 'object-2', camera: CAMERA },
      { next: twoObjects({ objects: [OBJECTS[0], { ...OBJECTS[1], id: 'object-3' }] }), view: ALT, object: null, camera: MOVED },
    ];
    for (const { next, view, object, camera } of cases) {
      const v = open(visit([() => Promise.resolve(twoObjects()), () => Promise.resolve(next)]));
      await flush();
      await chooseAndMove(v);
      hide();
      show();
      await flush();
      assert.equal(v.states.at(-1), '3d');
      assert.equal(viewPressed(v, view), 'true', `view ${view}`);
      if (object) assert.equal(objectPressed(v, object), 'true');
      else assert.equal(objectPressed(v, null), 'true', 'all objects');
      assert.ok(close(currentCamera(), camera), 'camera');
      v.view.dispose();
    }
  });

  it('keeps the latest choice through repeated hides while reads are held, and a late older read changes nothing', async () => {
    const held = [];
    const v = open(visit([() => Promise.resolve(twoObjects()), () => new Promise((resolve) => held.push(resolve)), () => Promise.resolve(twoObjects())]));
    await flush();
    await chooseAndMove(v);
    hide();
    show();
    await flush();
    hide();
    show();
    await flush();
    assert.equal(v.states.at(-1), '3d');
    assert.equal(viewPressed(v, ALT), 'true');
    assert.ok(close(currentCamera(), MOVED));
    held[0](twoObjects({ id: '00000000-0000-4000-8000-000000000000' }));
    await flush();
    assert.equal(viewPressed(v, ALT), 'true', 'the late read is ignored');
    v.view.dispose();
  });

  it('shows unavailable on a return that is no longer allowed, and keeps nothing for later', async () => {
    let allowed = true;
    const src = visit([() => Promise.resolve(twoObjects())]);
    src.check = () => Promise.resolve(allowed);
    const v = open(src);
    await flush();
    await chooseAndMove(v);
    hide();
    allowed = false;
    show();
    await flush();
    assert.equal(v.states.at(-1), 'unavailable');
    assert.doesNotMatch(v.container.textContent, /Corner shop|Mina/);
    v.view.dispose();
  });

  it('returns from a comparison hidden mid-way at the camera from before it, with the comparison closed', async () => {
    const v = open(visit([() => Promise.resolve(twoObjects())]));
    await flush();
    moveCamera(MOVED);
    v.button('Compare with the photograph').dispatch('click');
    assert.ok(!close(currentCamera(), MOVED), 'comparing uses the photo viewpoint');
    hide();
    show();
    await flush();
    assert.ok(close(currentCamera(), MOVED));
    assert.equal(v.button('Compare with the photograph').hidden, false);
    v.view.dispose();
  });

  it('restores nothing for an owner preview', async () => {
    const src = source({ manifest: () => Promise.resolve(twoObjects()) });
    src.kind = 'preview';
    const v = open(src);
    await flush();
    await chooseAndMove(v);
    hide();
    show();
    await flush();
    assert.equal(viewPressed(v, START), 'true');
    assert.ok(close(currentCamera(), CAMERA));
    v.view.dispose();
  });

  it('keeps contributor photos collapsed and unfetched after a return to a view that has them', async () => {
    const photos = { contributorPhotos: [{ asset: { viewId: ALT, name: 'evidence/1.jpg' }, viewIds: [ALT], providerLabel: 'Mina', label: 'The shop window', width: 600, height: 500 }] };
    const src = visit([() => Promise.resolve(twoObjects(photos))]);
    const v = open(src);
    await flush();
    await chooseAndMove(v);
    hide();
    show();
    await flush();
    assert.equal(viewPressed(v, ALT), 'true');
    const section = v.find((node) => node.tag === 'details' && /Contributor photos/.test(node.textContent))[0];
    assert.ok(section, 'listed for the restored view');
    assert.notEqual(section.open, true, 'collapsed');
    assert.ok(!src.calls.some((call) => call.includes('evidence')), 'not fetched');
    v.view.dispose();
  });

  it('names the photo box in words, not only by colour', async () => {
    const src = visit([() => Promise.resolve(twoObjects())]);
    const v = open(src);
    await flush();
    v.find((node) => node.tag === 'button' && node.objectId === 'object-2')[0].dispatch('click');
    await flush();
    const badge = v.find((node) => node.tag === 'span' && node.className === 'box-badge')[0];
    assert.ok(badge, 'badge is shown');
    assert.equal(badge.attributes['aria-label'], `${badge.textContent} (box around this object in the photograph)`);
    v.view.dispose();
  });
});

describe('saved arrangement differences for visitors', () => {
  const GRID = 20;
  const OBJECTS = [
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
    objects: OBJECTS.map(({ id, label, box }) => ({ id, label, box_xyxy: box })),
    assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
    source: { image_size: [1000, 800] },
  };
  const RULE = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
  const YAW = 0.30000000000000004;
  const arrangement = (a, b, relationship = RULE) => ({
    objects: [
      { id: 'object-1', ...a },
      { id: 'object-2', ...b },
    ],
    relationship,
  });
  const BASE = arrangement({ offset: [0.1, 0, 0.2], yaw: YAW }, { offset: [0.5, 0, 0], yaw: 0 });
  const views = (...alternatives) => [
    { ...manifest().views[0], label: 'Saved version 2', edit: BASE },
    ...alternatives.map((edit, i) => ({ ...manifest().views[1], id: i === 0 ? ALT : `33333333-3333-4333-8333-33333333333${i}`, label: `Alternative arrangement ${i + 1}`, edit })),
  ];
  const mount = (list, extra = {}) => {
    const data = { ...manifest(), objects: OBJECTS, views: list, ...extra };
    const v = open(source({ manifest: () => Promise.resolve(data), asset: (viewId, name) => Promise.resolve(name === 'surface.json' ? ok(surface) : textureResponse()) }));
    return v;
  };
  const choose = (v, label) => v.button(label).dispatch('click');
  const items = (v) => v.find((node) => node.tag === 'li' && /^(A|B): |^Rule: /.test(node.textContent)).map((node) => node.textContent);
  const NOTE = /These are differences between saved arrangements\. They do not establish when or whether the place changed/;

  it('names the published start as baseline and shows an X-only change with the exact turn kept as unchanged', async () => {
    const xOnly = arrangement({ offset: [0.35, 0, 0.2], yaw: YAW }, { offset: [0.5, 0, 0], yaw: 0 });
    const v = mount(views(xOnly));
    await flush();
    assert.equal(v.states.at(-1), '3d');
    assert.match(v.container.textContent, /“Saved version 2” is the published starting view\. Other views’ saved arrangements are compared with it\./);
    assert.equal(items(v).length, 0, 'no difference list at the baseline itself');
    globalThis.viewerCamera.camera.position.set(1, 2, 3);
    choose(v, 'Alternative arrangement 1');
    assert.deepEqual(currentCamera().position, [1, 2, 3], 'the camera is not changed');
    const text = v.container.textContent;
    assert.match(text, /Saved arrangement compared with “Saved version 2”, the published starting view\. Directions are as seen from the original photo, not from your current camera:/);
    const details = v.find((node) => node.className === 'visit-details')[0].textContent;
    const order = ['Alternative arrangement 1', 'Owner’s assertion: before the renovation', 'Based on: Shop records', 'Saved arrangement compared with', 'A: Counter: farther right', 'These are differences between saved arrangements', 'Photo: provided by', 'Arrangement: based on a recollection', 'In Mina’s own words', 'Rule: A: Counter stays left', 'Arrangement in this view:'];
    const at = order.map((part) => details.indexOf(part));
    assert.ok(at.every((index) => index >= 0), `all present: ${order.filter((_, i) => at[i] < 0)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'heading, time, differences, then photo and recollection prose, then the rule and numbers');
    assert.deepEqual(items(v), [
      'A: Counter: farther right; height, depth, turn unchanged.',
      'B: Flour stack: position and turn unchanged.',
      'Rule: unchanged.',
    ]);
    assert.doesNotMatch(details, /\bmoved\b/, 'no claim of historical movement');
    assert.match(text, NOTE);
    assert.match(text, /Arrangement in this view: A: Counter left\/right 0\.35, down\/up 0\.00, away\/toward 0\.20, turn 17°/, 'full numeric detail stays');
    assert.match(text, /Owner’s assertion: before the renovation/, 'era kept');
    assert.match(text, /Arrangement: based on a recollection by Mina, selected by the owner/, 'source kept');
    assert.match(text, /In Mina’s own words:The counter <b>faced<\/b> the window\./, 'recollection kept as text');
    assert.equal(v.find((node) => node.tag === 'b').length, 0, 'no raw HTML');
    choose(v, 'Saved version 2');
    assert.equal(items(v).length, 0);
    assert.match(v.container.textContent, /Time unknown/);
    v.view.dispose();
  });

  it('compares every axis and the turn by id with directions, regardless of stored order or the previously visited view', async () => {
    const all = { objects: [{ id: 'object-2', offset: [0.4, 0.1, -0.5], yaw: 1 }, { id: 'object-1', offset: [0.1, -0.2, 0.3], yaw: 0 }], relationship: { ...RULE } };
    const tiny = arrangement({ offset: [0.1 + 1e-9, 0, 0.2], yaw: YAW + 1e-12 }, { offset: [0.5, 1e-7, -1e-6], yaw: 0 });
    const v = mount(views(all, tiny));
    await flush();
    choose(v, 'Alternative arrangement 2');
    choose(v, 'Alternative arrangement 1');
    assert.deepEqual(items(v), [
      'A: Counter: lower, nearer, different turn; left-right position unchanged.',
      'B: Flour stack: farther left, higher, farther back, different turn.',
      'Rule: unchanged.',
    ], 'baseline is the start, not the view visited just before');
    choose(v, 'Alternative arrangement 2');
    assert.deepEqual(items(v), [
      'A: Counter: farther right, different turn; height, depth unchanged.',
      'B: Flour stack: higher, farther back; left-right position, turn unchanged.',
      'Rule: unchanged.',
    ], 'tiny real changes are not hidden by display rounding');
    assert.match(v.container.textContent, /A: Counter left\/right 0\.10, down\/up 0\.00, away\/toward 0\.20, turn 17°; B: Flour stack left\/right 0\.50, down\/up 0\.00, away\/toward -0\.00/, 'the rounded detail looks the same');
    v.view.dispose();
  });

  it('compares the rule by all its fields, with no rule versus a rule as a change', async () => {
    const same = { objects: BASE.objects, relationship: { frame: 'original-photo', rightId: 'object-2', leftId: 'object-1', kind: 'left_of' } };
    const flipped = { objects: BASE.objects, relationship: { ...RULE, leftId: 'object-2', rightId: 'object-1' } };
    const frame = { objects: BASE.objects, relationship: { ...RULE, frame: 'other' } };
    const none = { objects: BASE.objects, relationship: null };
    const v = mount(views(same, flipped, frame, none));
    await flush();
    const ruleLine = (label) => (choose(v, label), items(v).at(-1));
    assert.equal(ruleLine('Alternative arrangement 1'), 'Rule: unchanged.');
    assert.deepEqual(items(v).slice(0, 2), ['A: Counter: position and turn unchanged.', 'B: Flour stack: position and turn unchanged.']);
    assert.equal(ruleLine('Alternative arrangement 2'), 'Rule: different (this view: B: Flour stack stays left of A: Counter from the original photo; “Saved version 2”: A: Counter stays left of B: Flour stack from the original photo).');
    assert.match(ruleLine('Alternative arrangement 3'), /^Rule: different/, 'a field the text does not show still counts');
    assert.equal(ruleLine('Alternative arrangement 4'), 'Rule: different (this view: No rule; “Saved version 2”: A: Counter stays left of B: Flour stack from the original photo).');
    v.view.dispose();
  });

  it('says unknown, not unchanged, when a counterpart placement or rule is missing', async () => {
    globalThis.viewerFail = 'webgl';
    const missing = { objects: [{ id: 'object-2', offset: [0.5, 0, 0], yaw: 0 }] };
    const broken = arrangement({ offset: [0.1, 0, 0.2], yaw: null }, { offset: [0.5, 0, 0], yaw: 0 });
    const v = mount(views(missing, broken));
    await flush();
    assert.equal(v.states.at(-1), '2d');
    choose(v, 'Alternative arrangement 1');
    assert.deepEqual(items(v), [
      'A: Counter: unknown; its saved placement is not available in both views.',
      'B: Flour stack: position and turn unchanged.',
      'Rule: unknown; it is not available in both views.',
    ]);
    choose(v, 'Alternative arrangement 2');
    assert.equal(items(v)[0], 'A: Counter: unknown; its saved placement is not available in both views.');
    v.view.dispose();
  });

  it('shows no comparison for a single view or a legacy one-object visit', async () => {
    const single = mount(views());
    await flush();
    assert.doesNotMatch(single.container.textContent, /published starting view|Saved arrangement compared/);
    assert.match(single.container.textContent, /Arrangement in this view:/);
    single.view.dispose();
    const legacy = open(source());
    await flush();
    legacy.button('Mina’s recollection').dispatch('click');
    assert.doesNotMatch(legacy.container.textContent, /published starting view|Saved arrangement compared|differences between saved arrangements/);
    legacy.view.dispose();
  });
});

describe('how each shared arrangement was recorded', () => {
  const LINES = {
    initial: 'Arrangement: the initial placement in this photo-derived reconstruction. It is an estimate, not verified history.',
    manual: 'Arrangement: its most recent saved change was a placement change the owner made by hand. This does not establish how the place was in the past.',
    relationship: "Arrangement: its most recent saved change was the owner's change to an object relationship rule. This does not establish how the place was in the past.",
    memory: "Arrangement: its most recent saved change was a placement change the owner approved from a model's proposal based on written memory. The memory's words are not included here.",
    recollection: 'Arrangement: its most recent saved change was a placement change the owner adopted from a contributed recollection. This is separate from the photo-derived shape estimate.',
    restored: 'Arrangement: its most recent saved change returned it to an earlier saved arrangement. Its full change history is not included here.',
    alternative: 'Arrangement: the owner retained a recollection-based arrangement as a comparison choice. This does not establish a different time or verified history.',
  };
  const UNKNOWN = 'How this arrangement was made is not recorded in this link.';
  const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const base = manifest().views[0];
  const viewWith = (n, label, arrangement, { evidence = {} } = {}) => ({
    ...structuredClone(base),
    id: id(n),
    label,
    evidence: { ...structuredClone(base.evidence), ...evidence, ...(arrangement === undefined ? {} : { arrangement }) },
  });
  const values = Object.keys(LINES);
  const hostile = ['<b>initial</b>', {}, '__proto__', 'constructor', 'toString', null, 3, 'Initial'];
  const data = () => {
    const views = [
      ...values.map((value, i) => viewWith(i + 1, `View ${value}`, value)),
      viewWith(20, 'Older link', undefined),
      ...hostile.map((value, i) => viewWith(30 + i, `Odd ${i}`, value)),
      viewWith(50, 'With support', 'recollection', { evidence: { support: [{ kind: 'human_recollection', providerLabel: 'Mina', status: 'owner-selected' }] } }),
    ];
    return { ...manifest(), startViewId: views[0].id, views };
  };
  const details = (v) => v.find((node) => node.className === 'visit-details')[0].textContent;
  const lines = (v) => v.find((node) => node.tag === 'p' && (/^Arrangement: (the initial|its most recent|the owner retained)/.test(node.textContent) || node.textContent === UNKNOWN)).map((node) => node.textContent);

  it('shows the fixed line for each recorded operation, changing with the selected view', async () => {
    const v = open(source({ manifest: () => Promise.resolve(data()) }));
    await flush();
    assert.equal(v.states.at(-1), '3d');
    assert.deepEqual(lines(v), [LINES.initial], 'the start view');
    for (const value of values) {
      v.button(`View ${value}`).dispatch('click');
      assert.deepEqual(lines(v), [LINES[value]], value);
    }
    v.view.dispose();
  });

  it('says unknown for a link without the field and for anything not exactly a known value, as text only', async () => {
    const v = open(source({ manifest: () => Promise.resolve(data()) }));
    await flush();
    v.button('Older link').dispatch('click');
    assert.deepEqual(lines(v), [UNKNOWN], 'never silently initial or manual');
    hostile.forEach((value, i) => {
      v.button(`Odd ${i}`).dispatch('click');
      assert.deepEqual(lines(v), [UNKNOWN], JSON.stringify(value));
    });
    assert.equal(v.find((node) => node.tag === 'b').length, 0, 'no raw HTML');
    v.view.dispose();
  });

  it('places the line after the photo evidence and before the recollection support, and keeps the existing notes', async () => {
    const v = open(source({ manifest: () => Promise.resolve(data()) }));
    await flush();
    v.button('With support').dispatch('click');
    const text = details(v);
    const order = ['Photo: provided by', LINES.recollection, 'Arrangement: based on a recollection by Mina', 'None of this is verified history'].map((part) => text.indexOf(part));
    assert.ok(order.every((index) => index >= 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(text, /Time unknown/);
    assert.match(v.container.textContent, /Shape and depth: a model estimate from this one photo/);
    v.view.dispose();
  });

  it('shows the line in the 2D fallback, and nothing of it after closing or a failed check', async () => {
    globalThis.viewerFail = 'webgl';
    const flat = open(source({ manifest: () => Promise.resolve(data()) }));
    await flush();
    assert.equal(flat.states.at(-1), '2d');
    assert.deepEqual(lines(flat), [LINES.initial]);
    flat.button('View memory').dispatch('click');
    assert.deepEqual(lines(flat), [LINES.memory]);
    flat.view.dispose();
    assert.equal(flat.container.children.length, 0);
    globalThis.viewerFail = null;

    let allowed = true;
    const live = open(source({ manifest: () => Promise.resolve(data()), check: () => Promise.resolve(allowed) }));
    await flush();
    allowed = false;
    mock.timers.tick(HEARTBEAT_MS);
    await flush();
    assert.equal(live.states.at(-1), 'unavailable');
    assert.doesNotMatch(live.container.textContent, /Arrangement|How this arrangement/);
    live.view.dispose();
  });
});
