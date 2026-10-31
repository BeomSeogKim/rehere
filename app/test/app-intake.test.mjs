import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// Boots the real app.js as the owner with one unfinished save left on the
// server, then saves through the intake routes of a small in-memory server.
installViewerShim();

const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) });
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
// Hashing runs off the main thread, so some steps need more than a few ticks.
const waitFor = async (check, label) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
const OLD = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const P1 = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const P2 = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const V = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const P3 = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const input = (overrides = {}) => ({
  provider: '',
  origin: { kind: 'unknown', reference: '' },
  permissions: { place: false, model: false, share: false },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  ...overrides,
});

// --- a small server for the intake routes -----------------------------------
const intakes = new Map();
const bytes = new Map();
const requests = [];
const faults = [];
let held = null;
// Further holds for part uploads, used in order; ignoreAbort models a request
// whose answer still arrives after a sign-out.
const holds = [];
// Holds the next read of received bytes until released.
let heldRead = null;
let micRequests = 0;
let grantMic = null;

intakes.set(OLD, {
  id: OLD,
  status: 'open',
  revision: 1,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:05:00.000Z',
  text: 'Line one\n  two\n',
  metadata: {
    photos: [
      input({ provider: 'Neighbour', origin: { kind: 'public', reference: 'archive' }, permissions: { place: true, model: true, share: false }, dates: { capturedOn: '1998-07-01', fileCreatedAt: null, fileModifiedAt: '2021-02-03T04:05:06.000Z', estimatedPeriod: '' } }),
      input(),
      input(),
    ],
    text: input({ provider: 'Me', origin: { kind: 'own', reference: '' }, permissions: { place: true, model: false, share: true } }),
    voice: input({ provider: 'Me', origin: { kind: 'own', reference: '' }, permissions: { place: false, model: false, share: true } }),
  },
  parts: [
    { partId: P1, kind: 'photo', size: 3, sha256: sha('aaa'), hints: { name: 'kitchen.jpg', type: 'image/jpeg', lastModified: 5 }, status: 'received', error: null, detectedType: 'image/jpeg' },
    // Arrived, then refused by the content check: not "never received".
    { partId: P2, kind: 'photo', size: 3, sha256: sha('bbb'), hints: { name: 'shop.jpg', type: 'image/jpeg', lastModified: 6 }, status: 'failed', error: 'content', detectedType: null },
    { partId: P3, kind: 'photo', size: 3, sha256: sha('www'), hints: { name: 'back.jpg', type: 'image/jpeg', lastModified: 7 }, status: 'missing', error: null, detectedType: null },
    { partId: V, kind: 'voice', size: 3, sha256: sha('vvv'), hints: { name: 'voice', type: 'audio/webm', lastModified: null }, status: 'received', error: null, detectedType: 'audio/webm' },
  ],
});
bytes.set(`${OLD}/${P1}`, 'aaa');
bytes.set(`${OLD}/${V}`, 'vvv');

const view = (intake) => (intake.status === 'open' ? structuredClone(intake) : { id: intake.id, status: intake.status, revision: intake.revision, draftId: intake.draftId ?? null });
const plan = (intake, body) => {
  const previous = new Map(intake.parts.map((part) => [part.partId, part]));
  Object.assign(intake, { text: body.text, metadata: structuredClone(body.metadata) });
  intake.parts = body.parts.map((part) => {
    const kept = previous.get(part.partId);
    return kept && kept.sha256 === part.sha256 ? { ...kept } : { ...structuredClone(part), status: 'missing', error: null, detectedType: null };
  });
};
const takeFault = (name) => {
  const index = faults.indexOf(name);
  if (index < 0) return false;
  faults.splice(index, 1);
  return true;
};
const lost = () => Promise.reject(new TypeError('network'));

async function intakeRoute(path, method, options) {
  const [, , , id, kind, partId] = path.split('/');
  const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;
  if (!id) {
    if (method === 'GET') return json(200, [...intakes.values()].filter((intake) => intake.status === 'open').map(view));
    const intake = { id: body.requestId, status: 'open', revision: 1, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', parts: [] };
    plan(intake, body);
    intakes.set(intake.id, intake);
    return json(201, view(intake));
  }
  const intake = intakes.get(id);
  if (!intake) return json(404, { error: 'Not found.' });
  if (!kind) return json(200, view(intake));
  if (kind === 'plan') {
    if (body.baseRevision !== intake.revision) return json(409, { error: 'Changed.' });
    plan(intake, body);
    intake.revision += 1;
    return json(200, view(intake));
  }
  if (kind === 'parts' && method === 'GET') {
    const stored = bytes.get(`${id}/${partId}`);
    if (takeFault(`read-fail:${partId}`)) return json(503, { error: 'Unavailable.' });
    if (heldRead && !heldRead.release) {
      await new Promise((resolve) => (heldRead.release = resolve));
    }
    return stored ? { status: 200, ok: true, blob: async () => new Blob([stored]) } : json(404, { error: 'Not found.' });
  }
  if (kind === 'parts') {
    const part = intake.parts.find((entry) => entry.partId === partId);
    const hold = holds.shift();
    if (hold) {
      await new Promise((resolve, reject) => {
        hold.release = resolve;
        if (!hold.ignoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      bytes.set(`${id}/${partId}`, await options.body.text());
      Object.assign(part, { status: 'received', error: null, detectedType: 'image/jpeg' });
      return json(200, { partId, status: 'received', detectedType: 'image/jpeg' });
    }
    if (held) {
      return new Promise((resolve, reject) => {
        held.release = () => resolve(json(200, { partId, status: 'received', detectedType: 'image/jpeg' }));
        options.signal?.addEventListener('abort', () => {
          held.aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (takeFault(`busy:${part.hints.name}`)) return json(503, { error: 'Rehere is checking another file. Try again shortly.' });
    for (const code of ['content', 'pixels']) {
      if (takeFault(`${code}:${part.hints.name}`)) {
        Object.assign(part, { status: 'failed', error: code });
        return json(code === 'pixels' ? 413 : 400, { error: 'Refused.' });
      }
    }
    if (takeFault(`type:${part.hints.name}`)) {
      Object.assign(part, { status: 'failed', error: 'type' });
      return json(400, { error: 'Not a supported type.' });
    }
    bytes.set(`${id}/${partId}`, await options.body.text());
    Object.assign(part, { status: 'received', error: null, detectedType: 'image/jpeg' });
    return json(200, { partId, status: 'received', detectedType: 'image/jpeg' });
  }
  if (kind === 'commit') {
    if (intake.status === 'committed') return json(200, view(intake));
    if (body.baseRevision !== intake.revision || intake.parts.some((part) => part.status !== 'received')) return json(409, { error: 'Not ready.' });
    Object.assign(intake, { status: 'committed', draftId: `draft-${intakes.size}` });
    if (takeFault('commit')) return lost();
    if (takeFault('commit-unreadable')) return { status: 201, ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
    return json(201, view(intake));
  }
  if (kind === 'discard') {
    if (intake.status === 'committed') return json(409, { error: 'Already saved.' });
    intake.status = 'discarded';
    return json(200, view(intake));
  }
  return json(404, { error: 'Not found.' });
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id === 'photo-list' || id === 'saved-list' ? 'ul' : 'div'));
  return elements.get(id);
};
const storage = new Map();
let storageBlocked = false;

before(async () => {
  byId('owner-app').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, createDocumentFragment: () => new FakeElement('fragment'), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = () => {};
  // A stand-in microphone: each request is counted and answered with a fake
  // stream only when the test grants it. No real device is involved.
  globalThis.MediaRecorder = class extends EventTarget {
    constructor() {
      super();
      this.state = 'inactive';
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.dispatchEvent(new Event('stop'));
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => ((micRequests += 1), (grantMic = () => resolve({ getTracks: () => [{ stop() {} }] })))) } },
  });
  const local = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  // Like a browser with blocked site data, the getter itself can throw.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (storageBlocked) throw new DOMException('The operation is insecure.', 'SecurityError');
      return local;
    },
  });
  globalThis.location = { hash: '', pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  globalThis.history = { replaceState() {} };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/session') return json(200, { initialized: true, principal: owner });
    if (url === '/api/session/login') {
      const { accessKey } = JSON.parse(options.body);
      return json(200, { principal: accessKey === 'key-b' ? { ...owner, id: 'p-owner-b', displayName: 'Owner B' } : owner });
    }
    if (url.startsWith('/api/session')) return json(200, {});
    if (url === '/api/drafts') return json(200, []);
    if (url.startsWith('/api/intakes')) return intakeRoute(url, method, options);
    return json(404, { error: 'Not found.' });
  };
  await import('../public/app.js');
  await settle();
});

const all = (predicate) => [...elements.values()].flatMap((root) => root.findAll(predicate));
const button = (text) => all((node) => node.tag === 'button' && node.textContent === text)[0];
const message = () => byId('form-message').textContent;
const rows = () => byId('intake-status').findAll((node) => node.tag === 'li').map((node) => node.textContent);
const intakePosts = () => requests.filter((request) => request.startsWith('POST /api/intakes'));
const addFiles = async (...files) => {
  byId('photo-input').files = files;
  byId('photo-input').dispatch('change');
  await settle();
};
const save = async () => {
  const before = message();
  byId('form-message').replaceChildren();
  byId('draft-form').dispatch('submit');
  await waitFor(() => message() !== '', `an outcome after "${before}"`);
  await settle();
};
const jpeg = (content, name) => new File([content], name, { type: 'image/jpeg', lastModified: 1_700_000_000_000 });

describe('resumable saving in the app', () => {
  it('offers the unfinished save, says when resuming replaces the form, and restores only what arrived', async () => {
    assert.match(byId('intake-resume').textContent, /An unfinished save from .*: 2 of 4 files reached Rehere\. They are kept there, not saved as a memory/);
    assert.ok(button('Resume it'));
    assert.equal(intakePosts().length, 0, 'nothing is sent on load');
    // A take in progress is unsent input: asking, recording, then discarded.
    byId('record').dispatch('click');
    await settle();
    assert.ok(button('Resume it (replaces what is in the form now)'), 'while asking for the microphone');
    grantMic();
    await settle();
    assert.match(byId('voice-status').textContent, /^Recording/);
    assert.ok(button('Resume it (replaces what is in the form now)'), 'while recording');
    byId('discard').dispatch('click');
    await settle();
    assert.ok(button('Resume it'), 'back to plain once the take is discarded');
    const micBefore = micRequests;
    await addFiles(jpeg('zzz', 'other.jpg'));
    assert.equal(intakePosts().length, 0, 'nothing is sent on Add');
    // A received file that cannot be downloaded stops the restore: the form
    // is kept and nothing is called missing.
    faults.push(`read-fail:${P1}`);
    button('Resume it (replaces what is in the form now)').dispatch('click');
    await waitFor(() => /Resuming could not finish/.test(message()), 'the failed restore');
    assert.match(message(), /^Resuming could not finish: 1 of the 2 files Rehere received could not be downloaded just now\. They are still kept by Rehere, and nothing in the form was changed\. Try Resume again\./);
    assert.equal(byId('photo-list').children.length, 1);
    assert.equal(byId('photo-list').children[0].findAll((node) => node.tag === 'img').length, 1, 'the unsent photo is still there');
    assert.doesNotMatch(byId('photo-list').textContent, /did not reach Rehere/);
    assert.equal(byId('voice-preview').src, undefined, 'no recording was restored');
    assert.deepEqual(rows(), [], 'no rows from the unfinished save');
    assert.equal(intakePosts().length, 0, 'nothing was sent again');
    await waitFor(() => button('Resume it (replaces what is in the form now)') && !button('Resume it (replaces what is in the form now)').disabled, 'the offer again');

    heldRead = {};
    const resume = button('Resume it (replaces what is in the form now)');
    resume.dispatch('click');
    await waitFor(() => heldRead.release, 'the held read of received bytes');
    // While it loads, nothing else can change the form or start another restore.
    assert.equal(byId('draft-form').inert, true, 'the form waits');
    assert.equal(resume.disabled, true, 'no second Resume');
    const reads = requests.length;
    resume.dispatch('click');
    byId('draft-form').dispatch('submit');
    await settle();
    assert.equal(requests.length, reads, 'neither a second restore nor a save started');
    assert.equal(byId('photo-list').children.length, 1, 'the form is untouched until the restore completes');
    heldRead.release();
    heldRead = null;
    await settle();
    assert.equal(byId('draft-form').inert, false);

    const items = byId('photo-list').children;
    assert.equal(items.length, 3, 'the unsent input was replaced, as the button said');
    assert.equal(items[0].findAll((node) => node.tag === 'img').length, 1);
    // What to do, not a claim about why: one failed a check, one never arrived.
    assert.match(items[1].textContent, /Photo 2 \(shop\.jpg\) is not in this form\. Choose the file again, or remove it\./);
    assert.match(items[2].textContent, /Photo 3 \(back\.jpg\) is not in this form\. Choose the file again, or remove it\./);
    assert.doesNotMatch(byId('photo-list').textContent + message(), /did not reach/);
    assert.equal(message(), 'Resumed. Choose 2 files again or remove them before saving.');
    assert.equal(items[0].findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0].checked, true, 'source settings come back as they were');
    assert.equal(byId('memory-text').value, 'Line one\n  two\n', 'the text comes back exactly');
    assert.ok(byId('voice-preview').src, 'the received recording is back');
    assert.equal(micRequests, micBefore, 'restoring a recording never asks for the microphone');
    assert.deepEqual(rows(), [
      'Photo 1 (kitchen.jpg): Received by Rehere, not saved yet.',
      'Photo 2 (shop.jpg): Failed: Rehere could not read this photo. Remove it and add a JPEG or 8-bit PNG copy.',
      'Photo 3 (back.jpg): Not sent yet.',
      'The recording (voice): Received by Rehere, not saved yet.',
    ]);
    assert.equal(byId('intake-resume').children.length, 0);
    assert.doesNotMatch(message(), /Saved/);

    const choose = items[1].findAll((node) => node.tag === 'input' && node.type === 'file')[0];
    choose.files = [jpeg('bbb', 'shop-again.jpg')];
    choose.dispatch('change');
    await settle();
    byId('photo-list').children[2].findAll((node) => node.tag === 'button' && node.textContent === 'Remove')[0].dispatch('click');
    requests.length = 0;
    await save();
    assert.deepEqual(intakePosts().filter((request) => request.includes('/parts/')), [`POST /api/intakes/${OLD}/parts/${P2}`], 'only the reselected photo is sent');
    assert.equal(intakePosts().filter((request) => request === 'POST /api/intakes').length, 0, 'the same intake, never a new one');
    assert.match(message(), /^Saved\. View what you saved/);
    assert.equal(byId('photo-list').children.length, 0, 'the form resets only after the final answer');
    assert.equal(storage.size, 0);
  });

  it('keeps received files after a failure, leaves the form editable, and sends only the failed file again', async () => {
    await addFiles(jpeg('ccc', 'good.jpg'), jpeg('ddd', 'bad.jpg'));
    faults.push('type:bad.jpg');
    requests.length = 0;
    await save();
    assert.match(message(), /^Not saved yet: 1 of 2 files reached Rehere\./);
    assert.deepEqual(rows(), ['Photo 1 (good.jpg): Received by Rehere, not saved yet.', 'Photo 2 (bad.jpg): Failed: it is not a JPEG or PNG photo. Remove it and add a JPEG or PNG copy.']);
    assert.equal(byId('photo-list').children.length, 2);
    assert.equal(byId('photos-panel').inert, false, 'editing stays possible between attempts');
    const [entry] = JSON.parse(storage.get('rehere:intakes:p-owner'));
    assert.deepEqual(Object.keys(entry).sort(), ['commitRequestId', 'intakeId'], 'only opaque IDs are kept in the browser');
    const sentParts = intakePosts().filter((request) => request.includes('/parts/'));
    requests.length = 0;
    await save();
    assert.deepEqual(intakePosts().filter((request) => request.includes('/parts/')), [sentParts[1]], 'the received photo is not sent again');
    assert.match(message(), /^Saved\./);
  });

  it('says what to do about a file that failed its content check, keeps the rest, and retries a busy check with the same file', async () => {
    assert.match(byId('voice-status').textContent, /stops on its own just before five minutes/);
    await addFiles(jpeg('mmm', 'kept.jpg'), jpeg('nnn', 'broken.jpg'), jpeg('ooo', 'huge.jpg'), jpeg('ppp', 'later.jpg'));
    faults.push('content:broken.jpg', 'pixels:huge.jpg', 'busy:later.jpg');
    requests.length = 0;
    await save();
    assert.match(message(), /^Not saved yet: 1 of 4 files reached Rehere\. Replace or remove the files marked Failed, then save again; files Rehere already received are kept and not sent again\./);
    assert.deepEqual(rows(), [
      'Photo 1 (kept.jpg): Received by Rehere, not saved yet.',
      'Photo 2 (broken.jpg): Failed: Rehere could not read this photo. Remove it and add a JPEG or 8-bit PNG copy.',
      'Photo 3 (huge.jpg): Failed: the photo is larger than 32 megapixels. Remove it and add a smaller copy.',
      'Photo 4 (later.jpg): Not sent yet (Rehere is checking another file. Try again shortly; saving again tries it again).',
    ]);
    // Files are sent in order, so the last part request was the busy photo's.
    const busyPart = requests.filter((request) => request.includes('/parts/')).at(-1);
    const removeButtons = () => byId('photo-list').findAll((node) => node.tag === 'button' && node.textContent === 'Remove');
    removeButtons()[2].dispatch('click');
    removeButtons()[1].dispatch('click');
    await addFiles(jpeg('qqq', 'fixed.jpg'));
    requests.length = 0;
    await save();
    const sentParts = requests.filter((request) => request.includes('/parts/'));
    assert.equal(sentParts.length, 2, 'the busy file again and the replacement, not the received one');
    assert.ok(sentParts.includes(busyPart), 'the busy file is sent under the same part ID');
    assert.match(message(), /^Saved\./);
  });

  it('locks only the inputs while a final answer is unknown, and asks about the same intake before retrying', async () => {
    await addFiles(jpeg('eee', 'e.jpg'));
    faults.push('commit');
    await save();
    assert.match(message(), /could not confirm the last step\. Nothing in the form was changed/);
    assert.equal(byId('photos-panel').inert, true);
    assert.notEqual(byId('save').disabled, true, 'Save stays usable to check the outcome');
    assert.equal(byId('photo-list').children.length, 1, 'the form is not reset while the outcome is unknown');
    requests.length = 0;
    await save();
    assert.match(requests[0], /^GET \/api\/intakes\/[0-9a-f-]+$/, 'the same intake is read first');
    assert.equal(requests.filter((request) => request.endsWith('/commit')).length, 0, 'no second commit');
    assert.match(message(), /^Saved\./);
    assert.equal(byId('photos-panel').inert, false);
  });

  it('does not say Saved when the final answer cannot be read, and settles it from the same intake', async () => {
    await addFiles(jpeg('ggg', 'g.jpg'));
    faults.push('commit-unreadable');
    await save();
    assert.match(message(), /could not confirm the last step/);
    assert.doesNotMatch(message(), /Saved/);
    assert.equal(byId('photo-list').children.length, 1, 'the form is kept');
    assert.equal(byId('photos-panel').inert, true);
    requests.length = 0;
    await save();
    assert.match(requests[0], /^GET \/api\/intakes\/[0-9a-f-]+$/);
    assert.equal(requests.filter((request) => request.endsWith('/commit')).length, 0);
    assert.match(message(), /^Saved\./);
  });

  it('saves, discards and lists without browser storage when reading it throws', async () => {
    storageBlocked = true;
    try {
      await addFiles(jpeg('hhh', 'h-good.jpg'), jpeg('iii', 'h-bad.jpg'));
      faults.push('type:h-bad.jpg');
      await save();
      assert.match(message(), /^Not saved yet: 1 of 2 files reached Rehere\./);
      assert.equal(storage.size, 0, 'nothing is kept in the browser');
      button('Discard this unfinished save').dispatch('click');
      await waitFor(() => /discarded/.test(message()), 'the discard');
      assert.match(message(), /^The unfinished save was discarded\./);
      await settle();
      assert.ok(requests.includes('GET /api/intakes'), 'the server list is still asked');
      await save();
      assert.match(message(), /^Saved\./);
      assert.equal(storage.size, 0);
    } finally {
      storageBlocked = false;
    }
  });

  it('gives separate guidance for a restored recording that cannot come back, without saying why', async () => {
    const LOST = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    const LV = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
    intakes.set(LOST, {
      id: LOST,
      status: 'open',
      revision: 1,
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T08:00:00.000Z',
      text: 'Only words and a recording.',
      metadata: { photos: [], text: input(), voice: input() },
      parts: [{ partId: LV, kind: 'voice', size: 3, sha256: sha('zzz'), hints: { name: 'voice', type: 'audio/webm', lastModified: null }, status: 'failed', error: 'content', detectedType: null }],
    });
    // Discarding an unfinished save shows the offers again.
    await addFiles(jpeg('rrr', 'r-good.jpg'), jpeg('sss', 'r-bad.jpg'));
    faults.push('type:r-bad.jpg');
    await save();
    button('Discard this unfinished save').dispatch('click');
    await waitFor(() => button('Resume it (replaces what is in the form now)'), 'the offer');
    button('Resume it (replaces what is in the form now)').dispatch('click');
    await waitFor(() => /^Resumed\./.test(message()), 'the restore');
    assert.equal(message(), 'Resumed. Remove the recording or record a new one before saving.');
    assert.match(byId('intake-status').textContent, /The recording \(voice\): Failed: Rehere could not read this recording\. Discard it and record again\./);
    assert.match(byId('intake-status').textContent, /The recording cannot be restored into this form\. Remove it, or record a new one/);
    assert.doesNotMatch(byId('intake-status').textContent + message(), /did not reach/);
    button('Discard this unfinished save').dispatch('click');
    await waitFor(() => /discarded/.test(message()), 'the discard');
  });

  it('aborts sending on sign-out and lets no late answer bring anything back', async () => {
    await addFiles(jpeg('fff', 'f.jpg'));
    held = {};
    byId('draft-form').dispatch('submit');
    await waitFor(() => held.release, 'the held upload');
    assert.match(rows()[0], /Sending…/);
    button('Sign out').dispatch('click');
    await settle();
    assert.equal(held.aborted, true, 'the upload was aborted');
    held.release?.();
    await settle();
    assert.equal(byId('photo-list').children.length, 0);
    assert.deepEqual(rows(), []);
    assert.equal(message(), '');
    assert.equal(byId('intake-resume').children.length, 0);
  });

  it('ends one session’s locks at sign-out, and a late answer from it cannot release the next session’s work', async () => {
    const signInWith = async (key) => {
      const form = byId('access').findAll((node) => node.tag === 'form')[0];
      form.findAll((node) => node.tag === 'input')[0].value = key;
      form.dispatch('submit');
      await waitFor(() => byId('owner-app').hidden === false, 'the owner app');
      await settle();
    };
    // The previous test ended signed out.
    await signInWith('key-a');
    await addFiles(jpeg('kkk', 'a.jpg'));
    const a = { ignoreAbort: true };
    holds.push(a);
    byId('draft-form').dispatch('submit');
    await waitFor(() => a.release, 'A’s upload');
    assert.equal(byId('draft-form').inert, true, 'A is saving');
    button('Sign out').dispatch('click');
    await settle();
    assert.equal(byId('draft-form').inert, false, 'sign-out ends A’s lock');

    await signInWith('key-b');
    assert.equal(byId('draft-form').inert, false, 'B does not inherit A’s lock');
    await addFiles(jpeg('lll', 'b.jpg'));
    const b = {};
    holds.push(b);
    byId('draft-form').dispatch('submit');
    await waitFor(() => b.release, 'B’s upload');
    assert.equal(byId('draft-form').inert, true, 'B is saving');

    a.release();
    await settle();
    assert.equal(byId('draft-form').inert, true, 'A’s late answer does not release B’s save');
    assert.equal(byId('photo-list').children.length, 1, 'B’s form is untouched');
    assert.doesNotMatch(message(), /Saved/);

    b.release();
    await waitFor(() => /^Saved\./.test(message()), 'B’s save');
    assert.equal(byId('draft-form').inert, false);
  });
});
