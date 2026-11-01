import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// The visitor-only entry page: it opens only a well-formed visit link with
// the real visit screen, sends no cookie-bearing request, has no sign-in, and
// replaces what is shown on every address change.
installViewerShim();

const A = `rhv_${'a'.repeat(43)}`;
const B = `rhv_${'b'.repeat(43)}`;
const VIEW = '11111111-1111-4111-8111-111111111111';
const manifest = (title) => ({
  id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
  title,
  createdAt: '2026-10-31T00:00:00.000Z',
  synthetic: true,
  startViewId: VIEW,
  camera: { position: [0, 0, 0], target: [0, 0, -3] },
  views: [{ id: VIEW, label: 'Saved scene', edit: { offset: [0, 0, 0], yaw: 0 }, era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null }, evidence: { photo: null, geometry: 'model estimate', recollections: [], support: [] } }],
});
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let entry;
let requests;
let held;
let pageListeners;
const titles = { [A]: 'Corner shop A', [B]: 'Corner shop B' };

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  // The visit itself listens for page hide and show on the global object.
  globalThis.addEventListener = (type, listener) => (pageListeners[type] ??= new Set()).add(listener);
  globalThis.removeEventListener = (type, listener) => pageListeners[type]?.delete(listener);
  globalThis.fetch = async (url, options = {}) => {
    const token = options.headers?.authorization?.replace(/^Bearer /, '');
    requests.push({ url, method: options.method ?? 'GET', credentials: options.credentials, token, cookie: options.headers?.cookie });
    if (held[token] && url === '/api/visit' && (options.method ?? 'GET') === 'GET') await held[token].promise;
    if (url === '/api/visit') return { ok: true, status: 200, json: async () => manifest(titles[token]) };
    if (url.endsWith('surface.json')) return { ok: true, status: 200, json: async () => visitorSurface() };
    return { ok: true, status: 200, blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) };
  };
  entry = await import('../public/visitor-entry.js');
});

after(() => {
  for (const name of ['document', 'fetch', 'addEventListener', 'removeEventListener']) delete globalThis[name];
});

beforeEach(() => {
  requests = [];
  held = {};
  pageListeners = {};
  globalThis.viewerLog = [];
});

function start(hash) {
  const location = { hash };
  const listeners = {};
  const target = { addEventListener: (type, listener) => (listeners[type] = listener), removeEventListener: (type) => delete listeners[type] };
  const container = new FakeElement('div');
  const handle = entry.startVisitorEntry(container, { location, target });
  const go = (next) => {
    location.hash = next;
    listeners.hashchange();
  };
  const fire = (type) => {
    listeners[type]?.();
    for (const listener of pageListeners[type] ?? []) listener();
  };
  return { container, handle, go, fire, listeners };
}
const headings = (container) => container.findAll((node) => node.tag === 'h1').map((node) => node.textContent);

describe('visitor-only entry', () => {
  it('shows a plain notice and asks the server for nothing without a complete link', async () => {
    for (const hash of ['', '#', '#/visit/', `#/visit/${A}x`, `#/visit/${A.slice(0, -1)}`, `#/memories/${VIEW}`, `#/visit/rhv_${'a'.repeat(42)}!`]) {
      const v = start(hash);
      await flush();
      assert.equal(requests.length, 0, hash);
      assert.equal(v.container.textContent, entry.NO_LINK);
      assert.equal(v.container.findAll((node) => node.tag === 'button').length, 0);
      assert.doesNotMatch(v.container.textContent, /sign in|password|contribut/i);
      v.handle.dispose();
    }
  });

  it('opens the real visit with only the link in the authorization header and no cookies', async () => {
    const v = start(`#/visit/${A}`);
    await flush();
    assert.deepEqual(headings(v.container), ['Corner shop A']);
    assert.ok(requests.length >= 4);
    for (const request of requests) {
      assert.ok(request.url.startsWith('/api/visit'), request.url);
      assert.equal(request.credentials, 'omit');
      assert.equal(request.token, A);
      assert.equal(request.cookie, undefined);
      assert.ok(!request.url.includes(A), 'the link is never in a request address');
    }
    v.handle.dispose();
  });

  it('replaces the shown visit at once on every address change, and late answers never draw', async () => {
    held[A] = Promise.withResolvers();
    held[B] = Promise.withResolvers();
    const v = start(`#/visit/${A}`);
    await flush();
    v.go(`#/visit/${B}`);
    await flush();
    v.go('#/visit/not-a-link');
    assert.equal(v.container.textContent, entry.NO_LINK);
    held[A].resolve();
    held[B].resolve();
    await flush();
    assert.equal(v.container.textContent, entry.NO_LINK, 'neither earlier visit comes back');
    assert.equal(globalThis.viewerLog.filter((line) => line === 'renderer').length, 0);

    held = {};
    v.go(`#/visit/${A}`);
    await flush();
    assert.deepEqual(headings(v.container), ['Corner shop A']);
    held[A] = Promise.withResolvers();
    v.go(`#/visit/${B}`);
    await flush();
    v.go(`#/visit/${A}`);
    held[A].resolve();
    await flush();
    assert.deepEqual(headings(v.container), ['Corner shop A'], 'A -> B -> A shows A once');
    v.handle.dispose();
  });

  it('pauses on page hide and opens afresh on page show, without being closed for good', async () => {
    const v = start(`#/visit/${A}`);
    await flush();
    const reads = requests.filter((r) => r.url === '/api/visit' && r.method === 'GET').length;
    v.fire('pagehide');
    assert.doesNotMatch(v.container.textContent, /Corner shop A/);
    v.fire('pageshow');
    await flush();
    assert.equal(requests.filter((r) => r.url === '/api/visit' && r.method === 'GET').length, reads + 1, 'access is read again');
    assert.deepEqual(headings(v.container), ['Corner shop A']);
    v.handle.dispose();
  });

  it('is a page with only the stylesheet and this entry, importing only the visit modules', () => {
    const html = readFileSync(new URL('../public/visit.html', import.meta.url), 'utf8');
    assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]), ['/style.css', '/visitor-entry.js']);
    assert.doesNotMatch(html, /<form|<input|<button|app\.js|access|sign in/i);
    const source = readFileSync(new URL('../public/visitor-entry.js', import.meta.url), 'utf8');
    assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]), ['./visits.js', './playback.js']);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB|fetch\(/);
  });
});
