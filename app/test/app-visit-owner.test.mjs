import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// Boots the real app.js signed out of any visit, then moves between the app
// and visit links in the same page. Steps run in order on one page.
installViewerShim();

const TOKEN = `rhv_${'c'.repeat(43)}`;
const VIEW = '11111111-1111-4111-8111-111111111111';
const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const contributor = { id: 'p-contrib', role: 'contributor', displayName: 'Mina', draftIds: ['22222222-2222-4222-8222-222222222222'] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement('div'));
  return elements.get(id);
};
const requests = [];
const listeners = {};
let session;

const manifest = {
  id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
  title: 'Shop',
  createdAt: '2026-10-31T00:00:00.000Z',
  synthetic: true,
  startViewId: VIEW,
  camera: { position: [0, 0, 0], target: [0, 0, -3] },
  views: [{ id: VIEW, label: 'Saved scene', edit: { offset: [0, 0, 0], yaw: 0 }, era: { kind: 'unknown' }, evidence: { support: [], recollections: [] } }],
};

async function go(hash) {
  location.hash = hash;
  for (const listener of listeners.hashchange ?? []) await listener();
  await settle();
}

before(async () => {
  byId('owner-app').hidden = true;
  byId('visit').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = (type, listener) => (listeners[type] ??= []).push(listener);
  globalThis.removeEventListener = () => {};
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
  globalThis.location = { hash: '', pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  // Like the browser: replacing the URL with the bare path removes the fragment.
  globalThis.history = { replaceState: (state, title, url) => (location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '') };
  globalThis.fetch = (url, options = {}) => {
    requests.push(url);
    if (url === '/api/session') return session();
    if (url === '/api/drafts') return Promise.resolve(json(200, []));
    if (url === '/api/visit') return Promise.resolve(options.method === 'HEAD' ? { status: 200, ok: true } : json(200, manifest));
    if (url.startsWith('/api/visit/assets/')) return Promise.resolve(json(200, visitorSurface()));
    return Promise.resolve(json(200, []));
  };
  let respond;
  session = () => new Promise((resolve) => (respond = resolve));
  await import('../public/app.js');
  await settle();
  globalThis.respondFirstSession = respond;
});

// Leaving the visit disposes it, so its heartbeat timer does not outlive the tests.
after(async () => {
  session = () => Promise.resolve(json(200, { initialized: true, principal: null }));
  await go('');
});

const privateRequests = () => requests.filter((url) => url === '/api/drafts' || url.startsWith('/api/contributor') || url.startsWith('/api/invitations'));

describe('moving between the app and visit links in one page', () => {
  it('drops a pending owner session answer when a visit opens, so no private request follows', async () => {
    assert.deepEqual(requests, ['/api/session']);
    await go(`#/visit/${TOKEN}`);
    globalThis.respondFirstSession(json(200, { initialized: true, principal: owner }));
    await settle();
    assert.deepEqual(privateRequests(), []);
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(byId('visit').hidden, false);
    assert.match(byId('visit').textContent, /Shop/);
  });

  it('starts the owner app normally after leaving the visit', async () => {
    session = () => Promise.resolve(json(200, { initialized: true, principal: owner }));
    await go('');
    assert.equal(byId('visit').hidden, true);
    assert.equal(byId('visit').children.length, 0);
    assert.equal(byId('owner-app').hidden, false);
    assert.ok(requests.includes('/api/drafts'));
  });

  it('opens a visit link from an active owner app, keeping the fragment and removing private content', async () => {
    const visitsBefore = requests.filter((url) => url === '/api/visit').length;
    await go(`#/visit/${TOKEN}`);
    assert.equal(location.hash, `#/visit/${TOKEN}`, 'the visit fragment is kept');
    assert.ok(requests.filter((url) => url === '/api/visit').length > visitsBefore, 'the visit actually mounted');
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(byId('saved-list').children.length, 0);
    assert.match(byId('visit').textContent, /Shop/);
  });

  it('drops a pending contributor answer when a visit opens, so no contributor screen or request starts', async () => {
    let respond;
    session = () => new Promise((resolve) => (respond = resolve));
    await go('');
    await go(`#/visit/${TOKEN}`);
    const before = privateRequests().length;
    respond(json(200, { initialized: true, principal: contributor }));
    await settle();
    assert.equal(privateRequests().length, before);
    assert.doesNotMatch(byId('access').textContent, /contributor/i);
    assert.match(byId('visit').textContent, /Shop/);
  });
});
