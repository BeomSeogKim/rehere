import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The memory is read while its recording is still in use; the recording's
// first policy read already says it was stopped elsewhere. Boots the real
// app.js as the owner.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const TEXT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const live = (id, kind) => ({ id, kind, role: 'original', provider: 'Owner', sha256: 'a'.repeat(64), origin: { kind: 'public', reference: '' }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' }, permissions: { place: true, model: true, share: true }, policy: { revision: 0, stopped: false, updatedAt: null } });
const marker = (id, kind) => ({ id, kind, role: 'original', sha256: 'b'.repeat(64), provider: 'Owner', permissions: { place: false, model: false, share: false }, policy: { revision: 1, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z' } });

// The first draft read is from before the stop; every later read is after it.
const before_ = { id: DRAFT, createdAt: '2026-10-31T00:00:00.000Z', text: 'Words still in use.', textSourceId: TEXT, photos: [], voice: { name: 'voice.webm', type: 'audio/webm', size: 10, sourceId: VOICE }, sources: [live(TEXT, 'text'), live(VOICE, 'voice')] };
const after_ = { ...before_, voice: null, sources: [live(TEXT, 'text'), marker(VOICE, 'voice')] };

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement('div'));
  return elements.get(id);
};
const requests = [];
const voiceCalls = [];
let draftReads = 0;

before(async () => {
  byId('owner-app').hidden = true;
  const voice = byId('viewer-voice');
  voice.pause = () => voiceCalls.push('pause');
  voice.load = () => voiceCalls.push('load');
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = () => {};
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
  globalThis.location = { hash: `#/memories/${DRAFT}`, pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  globalThis.history = { replaceState() {} };
  globalThis.fetch = async (url, options = {}) => {
    requests.push(`${options.method ?? 'GET'} ${url}`);
    if (url === '/api/session') return json(200, { initialized: true, principal: owner });
    if (url === `/api/drafts/${DRAFT}`) {
      draftReads += 1;
      return json(200, draftReads === 1 ? before_ : after_);
    }
    if (url.endsWith(`/sources/${VOICE}/policy`)) return json(200, { sourceId: VOICE, revision: 1, permissions: { place: false, model: false, share: false }, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z', changedBy: 'p-owner', impacts: { scenes: 0, snapshots: 0, processing: 0 } });
    if (url.endsWith('/policy')) return json(200, { sourceId: TEXT, revision: 0, permissions: { place: true, model: true, share: true }, stopped: false, updatedAt: null, changedBy: null, impacts: { scenes: 0, snapshots: 0, processing: 0 } });
    return json(200, []);
  };
  await import('../public/app.js');
  await settle();
});

describe('a stop that happened after the memory was read', () => {
  it('re-reads the memory once, stops the recording and shows only its marker', () => {
    assert.equal(draftReads, 2, 'one re-read, and no loop once the revisions match');
    assert.ok(voiceCalls.includes('pause'), 'playback was stopped');
    assert.equal(byId('viewer-voice').hidden, true);
    assert.equal(byId('viewer-voice').attributes.src, undefined);
    assert.match(byId('viewer-voice-source').textContent, /no longer used anywhere in Rehere/);
    assert.match(byId('viewer-message').textContent, /^The voice recording: The uses of this material changed since this memory was opened\./);
    assert.equal(byId('viewer-text').textContent, 'Words still in use.', 'material still in use stays');
  });
});
