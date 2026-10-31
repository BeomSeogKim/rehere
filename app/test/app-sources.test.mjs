import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// Boots the real app.js signed in as the owner on one saved memory whose
// sources are partly stopped, then stops the recording from the page.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STOPPED_PHOTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEXT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
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
const marker = (id, kind) => ({ id, kind, role: 'original', sha256: 'b'.repeat(64), provider: 'Owner', permissions: { place: false, model: false, share: false }, policy: { revision: 1, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z' } });

let draft = {
  id: DRAFT,
  createdAt: '2026-10-31T00:00:00.000Z',
  text: 'Private words about the shop.',
  textSourceId: TEXT,
  photos: [{ name: 'photo-1.jpg', type: 'image/jpeg', size: 10, sourceId: PHOTO }],
  voice: { name: 'voice.webm', type: 'audio/webm', size: 10, sourceId: VOICE },
  sources: [live(PHOTO, 'photo'), marker(STOPPED_PHOTO, 'photo'), live(TEXT, 'text'), live(VOICE, 'voice')],
};

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement('div'));
  return elements.get(id);
};
const requests = [];
const voiceCalls = [];
let textStoppedElsewhere = false;

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
    if (url === `/api/drafts/${DRAFT}`) return json(200, draft);
    if (url.endsWith(`/sources/${VOICE}/policy`) && options.method === 'POST') {
      draft = { ...draft, voice: null, sources: draft.sources.map((source) => (source.id === VOICE ? marker(VOICE, 'voice') : source)) };
      return json(200, { saved: true, sourceId: VOICE, revision: 1, permissions: { place: false, model: false, share: false }, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z', changedBy: 'p-owner', impacts: { scenes: 0, snapshots: 0, processing: 1 }, cancellation: { requested: true, status: 'unconfirmed' } });
    }
    // The written memory was stopped from another tab: a save here meets a conflict.
    if (url.endsWith(`/sources/${TEXT}/policy`) && options.method === 'POST') {
      textStoppedElsewhere = true;
      draft = { ...draft, text: '', sources: draft.sources.map((source) => (source.id === TEXT ? marker(TEXT, 'text') : source)) };
      return json(409, { error: 'The uses of this material changed.' });
    }
    if (url.endsWith(`/sources/${TEXT}/policy`) && textStoppedElsewhere) {
      return json(200, { sourceId: TEXT, revision: 1, permissions: { place: false, model: false, share: false }, stopped: true, updatedAt: '2026-11-01T00:00:00.000Z', changedBy: 'p-owner', impacts: { scenes: 0, snapshots: 0, processing: 0 } });
    }
    if (url.endsWith('/policy')) return json(200, { sourceId: url.split('/')[5], revision: 0, permissions: { place: true, model: true, share: true }, stopped: false, updatedAt: null, changedBy: null, impacts: { scenes: 0, snapshots: 0, processing: 0 } });
    return json(200, []);
  };
  await import('../public/app.js');
  await settle();
});

describe('owner view of restricted material', () => {
  it('shows a stopped photo only as a marker, with no image and no controls', () => {
    const photos = byId('viewer-photos');
    assert.equal(photos.findAll((node) => node.tag === 'img').length, 1, 'only the photo still in use is shown');
    assert.match(photos.textContent, /no longer used anywhere in Rehere\. The original is kept, not deleted\./);
    assert.ok(requests.includes(`GET /api/drafts/${DRAFT}/sources/${PHOTO}/policy`));
    assert.ok(requests.includes(`GET /api/drafts/${DRAFT}/sources/${VOICE}/policy`));
    assert.ok(!requests.some((request) => request.includes(`/sources/${STOPPED_PHOTO}/`)), 'no controls for stopped material');
    assert.equal(byId('viewer-text').textContent, 'Private words about the shop.');
    assert.equal(byId('viewer-voice').hidden, false);
  });

  it('stops the recording, re-reads the memory and leaves only the marker after stopping its use', async () => {
    const reads = requests.filter((request) => request === `GET /api/drafts/${DRAFT}`).length;
    const controls = byId('viewer-voice-source');
    const press = (text) => controls.findAll((node) => node.tag === 'button' && node.textContent === text)[0].dispatch('click');
    press('Stop using this material');
    press('Stop using it');
    await settle();
    assert.ok(requests.includes(`POST /api/drafts/${DRAFT}/sources/${VOICE}/policy`));
    assert.ok(requests.filter((request) => request === `GET /api/drafts/${DRAFT}`).length > reads, 'the memory was re-read');
    assert.ok(voiceCalls.includes('pause'), 'playback was stopped');
    assert.equal(byId('viewer-voice').hidden, true);
    assert.equal(byId('viewer-voice').attributes.src, undefined);
    assert.match(byId('viewer-voice-source').textContent, /no longer used anywhere in Rehere/);
    assert.equal(byId('viewer-voice-source').findAll((node) => node.tag === 'button').length, 0);
    assert.match(byId('viewer-message').textContent, /^The voice recording: Saved\. This material is no longer used\. Rehere could not confirm that work in progress stopped/, 'the saved notice survives the re-read');
  });

  it('applies a stop made elsewhere, found by a conflict, to the whole memory without a loop', async () => {
    const reads = requests.filter((request) => request === `GET /api/drafts/${DRAFT}`).length;
    const controls = byId('viewer-text-source');
    const model = controls.findAll((node) => node.tag === 'input' && node.type === 'checkbox')[1];
    model.checked = false;
    model.dispatch('change');
    controls.findAll((node) => node.tag === 'button' && node.textContent === 'Save narrower uses')[0].dispatch('click');
    await settle();
    assert.equal(byId('viewer-text').textContent, '', 'the original text is no longer shown');
    assert.match(byId('viewer-text-source').textContent, /no longer used anywhere in Rehere/);
    assert.match(byId('viewer-message').textContent, /^The written memory: The uses of this material changed\. Review them again/);
    assert.equal(requests.filter((request) => request === `GET /api/drafts/${DRAFT}`).length, reads + 1, 'one re-read, no loop');
  });
});
