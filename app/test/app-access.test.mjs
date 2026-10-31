import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';

// Boots the real app.js against a fake page, microphone and server. The app
// module loads once, so the steps below run in order on one page.
const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const DRAFT = { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-31T00:00:00.000Z', photoCount: 1, hasVoice: false, textPreview: 'Private memory text' };

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement('div'));
  return elements.get(id);
};
const requests = [];
const routes = {};
const tracks = [];

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return false;
  }
  constructor() {
    super();
    this.state = 'inactive';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
}

before(async () => {
  byId('owner-app').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId };
  globalThis.addEventListener = () => {};
  globalThis.window = globalThis;
  globalThis.MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = { stopped: false, stop() { this.stopped = true; } };
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    },
  });
  globalThis.location = { hash: '', pathname: '/', href: 'http://127.0.0.1:4317/' };
  globalThis.history = { replaceState() {} };
  globalThis.fetch = (url, options = {}) => {
    const key = `${options.method ?? 'GET'} ${url}`;
    requests.push(key);
    const handler = routes[key];
    return handler ? handler() : Promise.resolve(json(404, { error: 'Not found.' }));
  };
  routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: null }));
  await import('../public/app.js');
  await settle();
});

const access = () => byId('access');
const findIn = (root, predicate) => root.findAll(predicate);
const button = (text) => findIn(access(), (node) => node.tag === 'button' && node.textContent === text)[0];

async function signIn() {
  routes['POST /api/session/login'] = () => Promise.resolve(json(200, { principal: owner }));
  findIn(access(), (node) => node.tag === 'input' && node.type === 'password')[0].value = 'rha_' + 'a'.repeat(43);
  findIn(access(), (node) => node.tag === 'form')[0].dispatch('submit');
  await settle();
}

describe('owner app behind the session gate', () => {
  it('loads no private content and keeps the app hidden before sign-in', () => {
    assert.deepEqual(requests, ['GET /api/session']);
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(tracks.length, 0, 'no microphone request on load');
  });

  it('loads saved memories only after an owner signs in', async () => {
    routes['GET /api/drafts'] = () => Promise.resolve(json(200, [DRAFT]));
    await signIn();
    assert.ok(requests.indexOf('GET /api/drafts') > requests.indexOf('POST /api/session/login'));
    assert.equal(byId('owner-app').hidden, false);
    assert.match(byId('saved-list').textContent, /Private memory text/);
  });

  it('stops the microphone and clears private content on sign-out, even before the response', async () => {
    byId('record').dispatch('click');
    await settle();
    assert.equal(tracks.length, 1);
    byId('memory-text').value = 'Unsaved private words';
    let respond;
    routes['POST /api/session/logout'] = () => new Promise((resolve) => (respond = resolve));
    button('Sign out').dispatch('click');
    assert.equal(tracks[0].stopped, true);
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(byId('saved-list').children.length, 0);
    assert.equal(byId('memory-text').value, '');
    respond(json(200, { ok: true }));
    await settle();
  });

  it('drops a private list that arrives after sign-out', async () => {
    let respond;
    routes['GET /api/drafts'] = () => new Promise((resolve) => (respond = resolve));
    await signIn();
    routes['POST /api/session/logout'] = () => Promise.resolve(json(200, { ok: true }));
    button('Sign out').dispatch('click');
    respond(json(200, [DRAFT]));
    await settle();
    assert.equal(byId('saved-list').children.length, 0);
    assert.doesNotMatch(byId('saved-list').textContent, /Private memory text/);
  });

  it('treats a 401 from a private request as the end of the session', async () => {
    routes['GET /api/drafts'] = () => Promise.resolve(json(200, [DRAFT]));
    await signIn();
    assert.equal(byId('owner-app').hidden, false);
    routes['GET /api/drafts'] = () => Promise.resolve(json(401, { error: 'Sign in to continue.' }));
    await fetch('/api/drafts');
    await settle();
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(byId('saved-list').children.length, 0);
    assert.match(access().textContent, /Your session ended/);
  });

  it('ignores a 401 for a request sent before a sign-out and new sign-in', async () => {
    // Back to a signed-out page with the app hidden.
    routes['POST /api/session/login'] = () => Promise.resolve(json(200, { principal: owner }));
    routes['GET /api/drafts'] = () => Promise.resolve(json(200, [DRAFT]));
    await signIn();
    assert.equal(byId('owner-app').hidden, false);
    let respondOld;
    routes['GET /api/drafts/old'] = () => new Promise((resolve) => (respondOld = resolve));
    const old = fetch('/api/drafts/old');
    routes['POST /api/session/logout'] = () => Promise.resolve(json(200, { ok: true }));
    button('Sign out').dispatch('click');
    await settle();
    await signIn();
    assert.equal(byId('owner-app').hidden, false);
    respondOld(json(401, { error: 'Sign in to continue.' }));
    await old;
    await settle();
    assert.equal(byId('owner-app').hidden, false, 'the new session stays open');
    assert.doesNotMatch(access().textContent, /Your session ended/);
    button('Sign out').dispatch('click');
    await settle();
  });

  it('does not treat a refused sign-in as a session ending', async () => {
    routes['POST /api/session/login'] = () => Promise.resolve(json(401, { error: 'Sign-in failed.' }));
    findIn(access(), (node) => node.tag === 'input' && node.type === 'password')[0].value = 'rha_wrong';
    findIn(access(), (node) => node.tag === 'form')[0].dispatch('submit');
    await settle();
    assert.match(access().textContent, /Sign-in failed\./);
    assert.doesNotMatch(access().textContent, /Your session ended/);
  });
});
