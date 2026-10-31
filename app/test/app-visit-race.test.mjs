import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// Holds app.js's first dynamic import of visits.js open, so route changes can
// pile up while it loads. The held module re-exports the real one.
installViewerShim();
const realVisits = new URL('../public/visits.js', import.meta.url).href;
const gated = `data:text/javascript,${encodeURIComponent(`await globalThis.visitsGate; export * from '${realVisits}';`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './visits.js' && context.parentURL?.endsWith('/public/app.js')) return { url: gated, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
let openGate;
globalThis.visitsGate = new Promise((resolve) => (openGate = resolve));

const A = `rhv_${'a'.repeat(43)}`;
const B = `rhv_${'b'.repeat(43)}`;
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
const visitReads = [];
const listeners = {};

// Fires the route listeners without waiting, as the browser does.
const go = (hash) => {
  location.hash = hash;
  return Promise.all((listeners.hashchange ?? []).map((listener) => listener()));
};

before(async () => {
  byId('owner-app').hidden = true;
  byId('visit').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = (type, listener) => (listeners[type] ??= []).push(listener);
  globalThis.removeEventListener = () => {};
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
  globalThis.location = { hash: '', pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  globalThis.history = { replaceState() {} };
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/session') return json(200, { initialized: true, principal: null });
    if (url === '/api/visit') {
      if (options.method === 'HEAD') return { status: 200, ok: true };
      visitReads.push(options.headers.authorization);
      return json(200, {
        id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
        title: 'Shop',
        createdAt: '2026-10-31T00:00:00.000Z',
        synthetic: true,
        startViewId: VIEW,
        camera: { position: [0, 0, 0], target: [0, 0, -3] },
        views: [{ id: VIEW, label: 'Saved scene', edit: { offset: [0, 0, 0], yaw: 0 }, era: { kind: 'unknown' }, evidence: { support: [], recollections: [] } }],
      });
    }
    if (url.startsWith('/api/visit/assets/')) return json(200, visitorSurface());
    return json(200, []);
  };
  await import('../public/app.js');
  await settle();
});

after(async () => {
  await go('');
  await settle();
});

describe('route changes while the visitor module loads', () => {
  it('mounts only the latest visit after A, B, leaving and A again', async () => {
    const pending = [go(`#/visit/${A}`), go(`#/visit/${B}`), go(''), go(`#/visit/${A}`)];
    await settle();
    assert.deepEqual(visitReads, [], 'nothing mounts while the module is held');
    openGate();
    await Promise.all(pending);
    await settle();
    assert.deepEqual(visitReads, [`Bearer ${A}`], 'exactly one visitor, for the latest link');
    assert.equal(byId('visit').findAll((node) => node.tag === 'h1').length, 1);
    assert.equal(byId('visit').hidden, false);
  });
});
