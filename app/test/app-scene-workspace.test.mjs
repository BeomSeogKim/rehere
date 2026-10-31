import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// The owner's scene route, end to end with the real app.js and space.js (only
// WebGL is replaced): an exact saved scene opens from its address, an explicit
// switch renames the address without a remount, a policy re-read keeps the
// current scene, and malformed, unknown and stale routes open nothing else.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEXT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const J1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const J2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const J3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const live = (id, kind) => ({
  id,
  kind,
  role: 'original',
  provider: 'Owner',
  sha256: 'a'.repeat(64),
  origin: { kind: 'public', reference: '' },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  permissions: { place: true, model: true, share: true },
  policy: { revision: 0, stopped: false, updatedAt: null },
});
const stopped = (id, kind) => ({ ...live(id, kind), permissions: { place: false, model: false, share: false }, policy: { revision: 1, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z' } });
const job = (id, createdAt) => ({ id, draftId: DRAFT, sourceId: PHOTO, box: [100, 100, 400, 400], status: 'ready', createdAt, error: null, edit: { version: 1, offset: [0, 0, 0], yaw: 0 } });
const JOBS = { [J1]: job(J1, '2026-11-01T00:00:00.000Z'), [J2]: job(J2, '2026-11-01T00:01:00.000Z') };

let draft;
let requests;
let replaced;
let draftGate;
let jobGate;
const listeners = {};
const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement('div'));
  return elements.get(id);
};
const gets = (path) => requests.filter((request) => request === `GET ${path}`).length;
// Only opening a scene reads its surface; other panels also read the job itself.
const opens = (id) => gets(`${BASE}/${id}/assets/surface.json`);
const posts = () => requests.filter((request) => request.startsWith('POST '));
function go(hash) {
  globalThis.location.hash = hash;
  for (const listener of listeners.hashchange ?? []) listener();
}
const space = () => byId('viewer-space');
const buttons = (text) => space().findAll((node) => node.tag === 'button' && node.textContent === text);

function freshDraft() {
  return {
    id: DRAFT,
    createdAt: '2026-10-31T00:00:00.000Z',
    text: 'Private words about the shop.',
    textSourceId: TEXT,
    photos: [{ name: 'photo-1.jpg', type: 'image/jpeg', size: 10, sourceId: PHOTO }],
    voice: null,
    sources: [live(PHOTO, 'photo'), live(TEXT, 'text')],
  };
}

before(async () => {
  draft = freshDraft();
  requests = [];
  replaced = [];
  byId('owner-app').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = (type, listener) => (listeners[type] ??= []).push(listener);
  globalThis.MediaRecorder = class {};
  globalThis.devicePixelRatio = 1;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
  globalThis.location = { hash: `#/memories/${DRAFT}/scenes/${J1}`, pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  // The address changes without a hashchange event, as in a browser.
  globalThis.history = {
    replaceState(_state, _title, url) {
      replaced.push(url);
      globalThis.location.hash = url.startsWith('#') ? url : '';
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    requests.push(`${options.method ?? 'GET'} ${url}`);
    if (url === '/api/session') return json(200, { initialized: true, principal: owner });
    if (url === `/api/drafts/${DRAFT}`) {
      if (draftGate) await draftGate.promise;
      return json(200, draft);
    }
    if (url === BASE) return json(200, Object.values(JOBS));
    for (const id of [J1, J2]) {
      if (url === `${BASE}/${id}`) {
        if (id === J1 && jobGate) return (await jobGate.promise) ?? json(200, JOBS[id]);
        return json(200, JOBS[id]);
      }
      if (url === `${BASE}/${id}/assets/surface.json`) return json(200, { ...visitorSurface(), source: { source_id: PHOTO, sha256: 'a'.repeat(64), image_size: [600, 500] } });
    }
    if (url.endsWith(`/sources/${TEXT}/policy`) && options.method === 'POST') {
      draft = { ...draft, text: '', sources: draft.sources.map((source) => (source.id === TEXT ? stopped(TEXT, 'text') : source)) };
      return json(200, { saved: true, sourceId: TEXT, revision: 1, permissions: { place: false, model: false, share: false }, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z', changedBy: 'p-owner', impacts: { scenes: 0, snapshots: 0, processing: 0 } });
    }
    if (url.endsWith('/policy')) return json(200, { sourceId: url.split('/')[5], revision: 0, permissions: { place: true, model: true, share: true }, stopped: false, updatedAt: null, changedBy: null, impacts: { scenes: 0, snapshots: 0, processing: 0 } });
    if (url.startsWith(`${BASE}/`)) return json(404, { error: 'Not found.' });
    return json(200, []);
  };
  await import('../public/app.js');
  await settle();
});

beforeEach(() => {
  replaced.length = 0;
});

describe('the scene-first page', () => {
  it('puts the scene before a disclosure that holds every original material and its controls', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const at = (needle) => html.indexOf(needle);
    assert.ok(at('id="viewer-message"') < at('id="viewer-space"'));
    assert.ok(at('id="viewer-space"') < at('<details id="viewer-materials"'));
    const materials = html.slice(at('<details id="viewer-materials"'), html.indexOf('</details>', at('<details id="viewer-materials"')));
    assert.match(materials, /<summary>Original materials and allowed uses<\/summary>/);
    for (const id of ['viewer-photos', 'viewer-text', 'viewer-text-source', 'viewer-voice', 'viewer-voice-source']) assert.ok(materials.includes(`id="${id}"`), id);
  });
});

describe('an owner scene address', () => {
  it('opens exactly the named saved scene, with materials closed and nothing built or sent', () => {
    assert.equal(opens(J1), 1);
    assert.equal(opens(J2), 0, 'never another scene');
    assert.deepEqual(posts(), [], 'navigation sends nothing');
    assert.equal(space().hidden, false);
    assert.match(space().textContent, /Partial scene from photo 1/);
    assert.equal(byId('viewer-materials').open, false, 'a memory with photos opens on its scene');
    assert.equal(byId('viewer-photos').findAll((node) => node.tag === 'img').length, 1, 'originals are still there');
  });

  it('names an explicitly chosen scene in the address without a remount, and toggling materials changes nothing', async () => {
    const draftReads = gets(`/api/drafts/${DRAFT}`);
    const before = requests.length;
    byId('viewer-materials').open = true;
    byId('viewer-materials').open = false;
    assert.equal(requests.length, before, 'the disclosure loads nothing');
    const open = space().findAll((node) => node.tag === 'button' && node.textContent === 'Open scene' && /Scene dddddddd/.test(node.attributes['aria-label'] ?? ''))[0];
    open.dispatch('click');
    await settle();
    assert.deepEqual(replaced, [`#/memories/${DRAFT}/scenes/${J2}`]);
    assert.equal(gets(`/api/drafts/${DRAFT}`), draftReads, 'no remount');
    assert.equal(opens(J2), 1);
    assert.deepEqual(posts(), []);
  });

  it('keeps the currently shown scene and the open materials across a policy re-read', async () => {
    byId('viewer-materials').open = true;
    const j1 = opens(J1);
    const j2 = opens(J2);
    const controls = byId('viewer-text-source');
    const press = (text) => controls.findAll((node) => node.tag === 'button' && node.textContent === text)[0].dispatch('click');
    press('Stop using this material');
    press('Stop using it');
    await settle();
    assert.equal(opens(J2), j2 + 1, 'the same current scene is checked again');
    assert.equal(opens(J1), j1, 'never the scene the page first opened');
    assert.equal(globalThis.location.hash, `#/memories/${DRAFT}/scenes/${J2}`);
    assert.equal(byId('viewer-materials').open, true, 'the owner left it open');
  });

  it('refuses a malformed address before fetching anything', async () => {
    const before = requests.length;
    go(`#/memories/${DRAFT}/scenes/${J1.toUpperCase()}`);
    await settle();
    assert.equal(requests.length, before);
    assert.match(byId('viewer-message').textContent, /not a valid memory or scene link/);
    assert.equal(space().hidden, true);
  });

  it('shows an unknown scene truthfully and opens no other one', async () => {
    const fallback = opens(J1) + opens(J2);
    go(`#/memories/${DRAFT}/scenes/${J3}`);
    await settle();
    assert.equal(gets(`${BASE}/${J3}`), 1);
    assert.match(space().textContent, /This scene could not be found\./);
    assert.equal(opens(J1) + opens(J2), fallback, 'no fallback scene');
    assert.equal(globalThis.location.hash, `#/memories/${DRAFT}/scenes/${J3}`, 'the address stays');
    assert.equal(buttons('Open scene').length, 2, 'other scenes stay offered to choose explicitly');
  });

  it('lets only the latest of two quick scene addresses for one memory open, and leaving rewrites nothing', async () => {
    draftGate = Promise.withResolvers();
    const j1 = opens(J1);
    const j2 = opens(J2);
    go(`#/memories/${DRAFT}/scenes/${J1}`);
    go(`#/memories/${DRAFT}/scenes/${J2}`);
    draftGate.resolve();
    draftGate = null;
    await settle();
    assert.equal(opens(J1), j1, 'the older address opened nothing');
    assert.equal(opens(J2), j2 + 1);
    go('#');
    await settle();
    assert.deepEqual(replaced, [], 'closing never calls back into the address');
    assert.equal(space().hidden, true);
  });

  it('lets a newly typed address win over a late open that finishes before its hashchange event', async () => {
    go(`#/memories/${DRAFT}`);
    await settle();
    jobGate = Promise.withResolvers();
    go(`#/memories/${DRAFT}/scenes/${J1}`);
    await settle();
    const j2 = opens(J2);
    // The address changes now; its hashchange event is still to come.
    globalThis.location.hash = `#/memories/${DRAFT}/scenes/${J2}`;
    jobGate.resolve();
    jobGate = null;
    await settle();
    assert.deepEqual(replaced, [], 'the late open rewrites nothing');
    assert.equal(globalThis.location.hash, `#/memories/${DRAFT}/scenes/${J2}`);
    for (const listener of listeners.hashchange ?? []) listener();
    await settle();
    assert.equal(opens(J2), j2 + 1, 'the typed scene opens');
    assert.equal(globalThis.location.hash, `#/memories/${DRAFT}/scenes/${J2}`);
  });

  it('mounts the scene workspace for a scene address even when every photo is stopped', async () => {
    draft = { ...freshDraft(), photos: [], sources: [stopped(PHOTO, 'photo'), live(TEXT, 'text')] };
    // Left closed by the owner earlier; a new navigation starts from the default.
    byId('viewer-materials').open = false;
    const j1 = opens(J1);
    go(`#/memories/${DRAFT}/scenes/${J1}`);
    await settle();
    assert.equal(space().hidden, false);
    assert.equal(opens(J1), j1 + 1, 'the exact scene shows its own state');
    assert.equal(byId('viewer-materials').open, true, 'a memory without photos opens on its materials');
    go(`#/memories/${DRAFT}`);
    await settle();
    assert.equal(space().hidden, true, 'without a scene address nothing is mounted for it');
    draft = freshDraft();
  });

  // Last: it ends the owner session.
  it('drops an open that is answered after the session ended, without rendering or naming a scene', async () => {
    go(`#/memories/${DRAFT}`);
    await settle();
    jobGate = Promise.withResolvers();
    go(`#/memories/${DRAFT}/scenes/${J1}`);
    await settle();
    // The scene read itself finds the session ended.
    jobGate.resolve(json(401, { error: 'Sign in again.' }));
    jobGate = null;
    await settle();
    assert.ok(!replaced.some((url) => url.includes('/scenes/')), 'no scene address written');
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(space().hidden, true);
    assert.equal(space().children.length, 0, 'nothing of the scene is left');
  });
});
