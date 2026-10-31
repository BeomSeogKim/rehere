import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// Boots the real app.js on a visit link. The app module loads once, so the
// steps run in order on one page.
installViewerShim();

const TOKEN = `rhv_${'b'.repeat(43)}`;
const VIEW = '11111111-1111-4111-8111-111111111111';
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

before(async () => {
  byId('owner-app').hidden = true;
  byId('visit').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = (type, listener) => (listeners[type] ??= []).push(listener);
  globalThis.removeEventListener = () => {};
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
  globalThis.location = { hash: `#/visit/${TOKEN}`, pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  globalThis.history = { replaceState() {} };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/session') return json(200, { initialized: true, principal: null });
    if (url === '/api/visit') {
      if (options.method === 'HEAD') return { status: 200, ok: true };
      return json(200, {
        id: 's1',
        title: 'Shop',
        createdAt: '2026-10-31T00:00:00.000Z',
        synthetic: true,
        startViewId: VIEW,
        camera: { position: [0, 0, 0], target: [0, 0, -3] },
        views: [{ id: VIEW, label: 'Saved scene', edit: { offset: [0, 0, 0], yaw: 0 }, era: { kind: 'unknown' }, evidence: { support: [], recollections: [] } }],
      });
    }
    if (url.startsWith('/api/visit/assets/')) return json(200, visitorSurface());
    return json(404, { error: 'Not found.' });
  };
  await import('../public/app.js');
  await settle();
});

describe('visit links', () => {
  it('opens a visit without any session check, sign-in or private request', () => {
    assert.ok(requests.length > 0);
    assert.ok(requests.every(({ url }) => url.startsWith('/api/visit')), requests.map((r) => r.url).join(', '));
    for (const { url, options } of requests) {
      assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(options.credentials, 'omit');
      assert.ok(!url.includes(TOKEN));
    }
    assert.equal(byId('visit').hidden, false);
    assert.equal(byId('owner-app').hidden, true);
    assert.equal(byId('access').hidden, true);
    assert.match(byId('visit').textContent, /Shop/);
  });

  it('removes the visit completely before the normal app starts when the link is left', async () => {
    location.hash = '';
    for (const listener of listeners.hashchange ?? []) await listener();
    await settle();
    assert.equal(byId('visit').hidden, true);
    assert.equal(byId('visit').children.length, 0);
    assert.ok(requests.some(({ url }) => url === '/api/session'), 'the normal session check starts only now');
    assert.equal(byId('access').hidden, false);
  });
});
