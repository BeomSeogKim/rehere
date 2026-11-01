import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// Boots the real app.js as the owner against a small in-memory server: place
// names at creation, through unclear answers and resume, in the saved list
// and heading, and the inline rename with its compare-and-swap answers.
installViewerShim();

const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const waitFor = async (check, label) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}; status: ${byId('viewer-place-name').textContent}`);
};

const RESUMABLE = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const NAMED = '11111111-1111-4111-8111-111111111111';
const UNNAMED = '22222222-2222-4222-8222-222222222222';
const BROKEN = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

// --- a small server ---------------------------------------------------------
const requests = [];
const faults = [];
const intakes = new Map();
const drafts = new Map();
// Rename receipts per draft: requestId -> { body, appliedRevision }.
const receipts = new Map();
let renameHold = null;
// One-shot holds for a list or detail read; the answer is what the server held
// when the read arrived, as a slow real read would be.
let listHold = null;
let detailHold = null;

intakes.set(RESUMABLE, {
  id: RESUMABLE,
  status: 'open',
  revision: 1,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:05:00.000Z',
  text: 'Flour on the steps.',
  placeName: 'Bakery',
  metadata: { photos: [], text: null, voice: null },
  parts: [],
});
const place = (name, revision = 0) => ({ name, revision, updatedAt: revision ? '2026-11-01T10:00:00.000Z' : null, unavailable: false });
const addDraft = (id, placeValue, text = 'Words.') =>
  drafts.set(id, { id, createdAt: '2026-10-30T08:00:00.000Z', text, textSourceId: null, photos: [], voice: null, sources: [], place: placeValue });
addDraft(NAMED, place('Harbour', 2), 'By the water.');
addDraft(UNNAMED, place(null, 0), 'No name yet.');
addDraft(BROKEN, { name: null, revision: null, updatedAt: null, unavailable: true }, 'Name file unreadable.');
addDraft(OTHER, place('Mill', 1), 'Grain.');

const takeFault = (name) => {
  const index = faults.indexOf(name);
  if (index < 0) return false;
  faults.splice(index, 1);
  return true;
};
const view = (intake) => (intake.status === 'open' ? structuredClone(intake) : { id: intake.id, status: intake.status, revision: intake.revision, draftId: intake.draftId ?? null });
const summary = (draft) => ({ id: draft.id, createdAt: draft.createdAt, photoCount: 0, hasVoice: false, textPreview: draft.text, place: structuredClone(draft.place) });

function intakeRoute(path, method, body) {
  const [, , , id, kind] = path.split('/');
  if (!id) {
    if (method === 'GET') return json(200, [...intakes.values()].filter((intake) => intake.status === 'open').map(view));
    if (intakes.has(body.requestId)) return json(200, view(intakes.get(body.requestId)));
    const { requestId, ...plan } = body;
    const intake = { id: requestId, status: 'open', revision: 1, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', placeName: null, ...structuredClone(plan), parts: [] };
    intakes.set(intake.id, intake);
    if (takeFault('create-lost')) return lost();
    return json(201, view(intake));
  }
  const intake = intakes.get(id);
  if (!intake) return json(404, { error: 'Not found.' });
  if (!kind) return json(200, view(intake));
  if (kind === 'plan') {
    if (body.baseRevision !== intake.revision) return json(409, { error: 'Changed.' });
    Object.assign(intake, { text: body.text, metadata: structuredClone(body.metadata), placeName: body.placeName ?? null, revision: intake.revision + 1 });
    return json(200, view(intake));
  }
  if (kind === 'commit') {
    if (intake.status !== 'committed') {
      const draftId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(drafts.size).padStart(12, '0')}`;
      addDraft(draftId, place(intake.placeName ?? null, 0), intake.text);
      Object.assign(intake, { status: 'committed', draftId });
    }
    return json(201, view(intake));
  }
  return json(404, { error: 'Not found.' });
}

async function renameRoute(draftId, body) {
  const draft = drafts.get(draftId);
  if (renameHold) await new Promise((resolve) => (renameHold.release = resolve));
  if (draft.place.unavailable) return json(503, { error: 'The place name is unavailable right now.' });
  const mine = receipts.get(draftId) ?? new Map();
  receipts.set(draftId, mine);
  const answer = (receipt, replayed) => json(200, { draftId, place: structuredClone(draft.place), changed: !replayed && receipt.changed, replayed, appliedRevision: receipt.appliedRevision });
  const seen = mine.get(body.requestId);
  if (seen) return JSON.stringify(seen.body) === JSON.stringify(body) ? answer(seen, true) : json(409, { error: 'That request was already used for a different name.' });
  if (body.baseRevision !== draft.place.revision) return json(409, { error: 'The name was changed elsewhere.' });
  const changed = body.name !== draft.place.name;
  if (changed) draft.place = place(body.name, draft.place.revision + 1);
  const receipt = { body: structuredClone(body), appliedRevision: draft.place.revision, changed };
  mine.set(body.requestId, receipt);
  if (takeFault('rename-lost')) return lost();
  return answer(receipt, false);
}

const listeners = {};
const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id === 'saved-list' || id === 'photo-list' ? 'ul' : id === 'place-name' ? 'input' : 'div'));
  return elements.get(id);
};

before(async () => {
  byId('owner-app').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, createDocumentFragment: () => new FakeElement('fragment'), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = (type, listener) => (listeners[type] ??= []).push(listener);
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) } });
  globalThis.location = { hash: '', pathname: '/', href: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317' };
  globalThis.history = { replaceState(_state, _title, url) { globalThis.location.hash = url.startsWith('#') ? url : ''; } };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({ method, url, body });
    if (url === '/api/session') return json(200, { initialized: true, principal: owner });
    if (url === '/api/session/logout') return json(200, { ok: true });
    if (url.startsWith('/api/session')) return json(200, {});
    if (url === '/api/drafts') {
      const snapshot = [...drafts.values()].map(summary);
      const hold = listHold;
      listHold = null;
      if (hold) await new Promise((resolve) => (hold.release = resolve));
      return json(200, snapshot);
    }
    if (url.startsWith('/api/intakes')) return intakeRoute(url, method, body);
    const rename = /^\/api\/drafts\/([^/]+)\/place-name$/.exec(url);
    if (rename && method === 'POST') return renameRoute(rename[1], body);
    const detail = /^\/api\/drafts\/([^/]+)$/.exec(url);
    if (detail && drafts.has(detail[1])) {
      if (takeFault('detail-lost')) return lost();
      const snapshot = structuredClone(drafts.get(detail[1]));
      const hold = detailHold;
      detailHold = null;
      if (hold) await new Promise((resolve) => (hold.release = resolve));
      return json(200, snapshot);
    }
    return json(404, { error: 'Not found.' });
  };
  await import('../public/app.js');
  await settle();
});

const all = (predicate) => [...elements.values()].flatMap((root) => root.findAll(predicate));
const button = (text) => all((node) => node.tag === 'button' && node.textContent === text)[0];
const message = () => byId('form-message').textContent;
const posts = (prefix) => requests.filter((request) => request.method === 'POST' && request.url.startsWith(prefix));
const listNames = () => byId('saved-list').findAll((node) => node.className === 'saved-name').map((node) => node.textContent);
const heading = () => byId('viewer-title').textContent;
const region = () => byId('viewer-place-name');
const status = () => region().findAll((node) => node.role === 'status').map((node) => node.textContent).join(' ');
const renameInput = () => region().findAll((node) => node.tag === 'input')[0];
const detailReads = (id) => requests.filter((request) => request.method === 'GET' && request.url === `/api/drafts/${id}`).length;
const save = async () => {
  byId('form-message').replaceChildren();
  byId('draft-form').dispatch('submit');
  await waitFor(() => message() !== '', 'a save outcome');
  await settle();
};
const go = async (hash) => {
  globalThis.location.hash = hash;
  for (const listener of listeners.hashchange ?? []) listener();
  await settle();
};
const type = (value) => {
  renameInput().value = value;
  renameInput().dispatch('input');
};

describe('place names in the owner app', () => {
  it('lists named, unnamed and unreadable names honestly, never guessing one', () => {
    const names = listNames();
    assert.ok(names.includes('Harbour'));
    assert.ok(names.includes('Unnamed place'));
    assert.ok(names.includes('Place name unavailable'), 'an unreadable name is not shown as unnamed');
    assert.match(byId('saved-list').textContent, /HarbourOct 30, 2026.*By the water\./, 'name first, date and preview kept');
  });

  it('treats a name alone as no content and refuses an invalid name, keeping everything and sending nothing', async () => {
    const before = posts('/api/intakes').length;
    byId('place-name').value = 'Only a name';
    await save();
    assert.equal(message(), 'Add a photo, a written memory or a voice recording before saving.');
    byId('memory-text').value = 'Some words.';
    for (const [raw, pattern] of [
      ['A‮B', /^The place name must be one line without control or text-direction characters\. Nothing was saved/],
      ['Line\nbreak', /^The place name must be one line/],
      ['x'.repeat(121), /^Keep the place name to 120 characters or fewer\. Nothing was saved/],
    ]) {
      byId('place-name').value = raw;
      await save();
      assert.match(message(), pattern);
      assert.ok(!message().includes(raw), 'the fixed message does not repeat the input');
      assert.equal(byId('place-name').value, raw, 'the typed name is kept');
      assert.equal(byId('memory-text').value, 'Some words.');
    }
    assert.equal(posts('/api/intakes').length, before, 'nothing was sent');
    byId('place-name').value = '';
    byId('memory-text').value = '';
  });

  it('warns before resuming over a typed name, restores the saved name, and records a name-only change as a plan change', async () => {
    byId('place-name').value = 'Typed only';
    byId('place-name').dispatch('input');
    const resume = button('Resume it (replaces what is in the form now)');
    assert.ok(resume, 'a form holding only a typed name is not replaced silently');
    resume.dispatch('click');
    await waitFor(() => /^Resumed/.test(message()), 'the resume');
    assert.equal(byId('place-name').value, 'Bakery');
    assert.equal(byId('memory-text').value, 'Flour on the steps.');
    byId('place-name').value = 'Bakery on the corner';
    await save();
    const [change] = posts(`/api/intakes/${RESUMABLE}/plan`);
    assert.equal(change.body.placeName, 'Bakery on the corner');
    assert.equal(change.body.baseRevision, 1);
    assert.equal(change.body.text, 'Flour on the steps.');
    assert.match(message(), /^Saved\./);
    assert.equal(byId('place-name').value, '', 'a confirmed save alone clears it');
    await waitFor(() => listNames().includes('Bakery on the corner'), 'the new name in the list');
  });

  it('sends a trimmed name exactly as typed inside, and repeats the same create after an unclear answer', async () => {
    byId('place-name').value = '  Caf\u00e9 “Rosa” \u5317 \u0645\u0642\u0647\u0649  ';
    byId('memory-text').value = 'We met here.';
    faults.push('create-lost');
    await save();
    assert.match(message(), /could not confirm the last step/);
    assert.equal(byId('place-name').value, '  Caf\u00e9 “Rosa” \u5317 \u0645\u0642\u0647\u0649  ', 'kept as typed');
    await save();
    const creates = posts('/api/intakes').filter((request) => request.url === '/api/intakes');
    const [first, second] = creates.slice(-2);
    assert.deepEqual(second.body, first.body, 'the same request, name included');
    assert.equal(first.body.placeName, 'Caf\u00e9 “Rosa” \u5317 \u0645\u0642\u0647\u0649', 'outer whitespace only; right-to-left letters kept');
    assert.match(message(), /^Saved\./);
    await waitFor(() => listNames().includes('Caf\u00e9 “Rosa” \u5317 \u0645\u0642\u0647\u0649'), 'the name in the list');
  });

  it('sends an explicit null name for an unnamed save', async () => {
    byId('memory-text').value = 'No name for this one.';
    await save();
    const create = posts('/api/intakes').filter((request) => request.url === '/api/intakes').at(-1);
    assert.ok(Object.hasOwn(create.body, 'placeName'));
    assert.equal(create.body.placeName, null, 'an omitted name is never sent');
    assert.match(message(), /^Saved\./);
  });

  it('shows the name as the heading and an unreadable name as unavailable, with no rename offered', async () => {
    await go(`#/memories/${NAMED}`);
    assert.equal(heading(), 'Harbour');
    assert.ok(button('Rename'));
    await go(`#/memories/${UNNAMED}`);
    assert.equal(heading(), 'Unnamed place');
    assert.ok(button('Name this place'), 'a legacy place can be named');
    await go(`#/memories/${BROKEN}`);
    assert.equal(heading(), 'Place name unavailable');
    assert.match(region().textContent, /could not be read, so it cannot be changed right now/);
    assert.equal(button('Rename'), undefined);
    assert.equal(button('Name this place'), undefined);
  });

  it('renames in place without re-reading the memory or touching unsaved work elsewhere', async () => {
    await go(`#/memories/${NAMED}`);
    byId('memory-text').value = 'Unsaved words in the form';
    const reads = detailReads(NAMED);
    button('Rename').dispatch('click');
    assert.equal(renameInput().value, 'Harbour');
    type('  Harbour steps ');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.', 'the rename');
    const sent = posts(`/api/drafts/${NAMED}/place-name`).at(-1).body;
    assert.deepEqual(Object.keys(sent).sort(), ['baseRevision', 'name', 'requestId']);
    assert.equal(sent.name, 'Harbour steps');
    assert.equal(sent.baseRevision, 2);
    assert.equal(heading(), 'Harbour steps');
    await waitFor(() => listNames().includes('Harbour steps'), 'the list');
    assert.equal(detailReads(NAMED), reads, 'the memory and its scenes were not reopened');
    assert.equal(byId('memory-text').value, 'Unsaved words in the form');
    byId('memory-text').value = '';
  });

  it('on a change elsewhere shows the current name, keeps the typed text, and replaces only on a further Save', async () => {
    await go(`#/memories/${OTHER}`);
    button('Rename').dispatch('click');
    type('Old mill');
    drafts.get(OTHER).place = place('Water mill', 2);
    button('Save name').dispatch('click');
    await waitFor(() => /changed elsewhere/.test(status()), 'the conflict');
    assert.match(status(), /^The name was changed elsewhere, so yours was not saved\. It is now “Water mill”\. Your text is still here/);
    assert.equal(heading(), 'Water mill');
    assert.equal(renameInput().value, 'Old mill');
    assert.equal(drafts.get(OTHER).place.name, 'Water mill', 'nothing was overwritten');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.', 'the explicit replacement');
    const [stale, again] = posts(`/api/drafts/${OTHER}/place-name`).slice(-2);
    assert.equal(stale.body.baseRevision, 1);
    assert.equal(again.body.baseRevision, 2);
    assert.notEqual(again.body.requestId, stale.body.requestId);
    assert.equal(heading(), 'Old mill');
  });

  it('repeats the exact request after an unclear answer, and a later replay never paints an older name', async () => {
    await go(`#/memories/${UNNAMED}`);
    button('Name this place').dispatch('click');
    type('Courtyard');
    faults.push('rename-lost');
    button('Save name').dispatch('click');
    await waitFor(() => /could not confirm the rename/.test(status()), 'the unclear answer');
    assert.equal(renameInput().value, 'Courtyard');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.', 'the replay');
    const [first, second] = posts(`/api/drafts/${UNNAMED}/place-name`).slice(-2);
    assert.deepEqual(second.body, first.body, 'same request ID and body');
    assert.equal(first.body.baseRevision, 0, 'a first legacy rename');
    assert.equal(drafts.get(UNNAMED).place.revision, 1, 'applied once');

    // Renamed elsewhere and read again; then a rename applied but unanswered,
    // and a further rename elsewhere before the exact repeat.
    drafts.get(UNNAMED).place = place('Inner yard', 2);
    await go(`#/memories/${OTHER}`);
    await go(`#/memories/${UNNAMED}`);
    assert.equal(heading(), 'Inner yard');
    button('Rename').dispatch('click');
    type('Courtyard');
    faults.push('rename-lost');
    button('Save name').dispatch('click');
    await waitFor(() => /could not confirm/.test(status()), 'a new unclear rename');
    drafts.get(UNNAMED).place = place('Gate', 4);
    button('Save name').dispatch('click');
    await waitFor(() => /renamed since/.test(status()), 'the truthful replay');
    assert.equal(status(), 'That rename was recorded earlier, and the place has been renamed since. Its name is now “Gate”.');
    assert.equal(heading(), 'Gate');
  });

  it('clears a name to unnamed and reports a no-op without claiming a change', async () => {
    await go(`#/memories/${NAMED}`);
    button('Rename').dispatch('click');
    type('Harbour steps');
    button('Save name').dispatch('click');
    await waitFor(() => /nothing changed/.test(status()), 'the no-op');
    assert.equal(status(), 'The name was already this, so nothing changed.');
    button('Rename').dispatch('click');
    type('   ');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.', 'the clear');
    assert.equal(posts(`/api/drafts/${NAMED}/place-name`).at(-1).body.name, null);
    assert.equal(heading(), 'Unnamed place');
    assert.ok(button('Name this place'));
  });

  it('keeps an invalid typed name and sends nothing', async () => {
    await go(`#/memories/${NAMED}`);
    button('Name this place').dispatch('click');
    const before = posts(`/api/drafts/${NAMED}/place-name`).length;
    type('Tab\there');
    button('Save name').dispatch('click');
    await settle();
    assert.equal(status(), 'The place name must be one line without control or text-direction characters. The name was not changed.');
    assert.equal(renameInput().value, 'Tab\there');
    assert.equal(posts(`/api/drafts/${NAMED}/place-name`).length, before);
    button('Cancel').dispatch('click');
    await settle();
  });

  it('ignores a read started by Cancel once a newer rename is saved', async () => {
    await go(`#/memories/${OTHER}`);
    button('Rename').dispatch('click');
    type('First');
    faults.push('rename-lost');
    button('Save name').dispatch('click');
    await waitFor(() => /could not confirm/.test(status()), 'the unclear rename');
    assert.equal(drafts.get(OTHER).place.name, 'First', 'it was applied, unanswered');
    const oldRead = (detailHold = {});
    button('Cancel').dispatch('click');
    await waitFor(() => oldRead.release, 'the held read from Cancel');
    button('Rename').dispatch('click');
    type('Second');
    button('Save name').dispatch('click');
    await waitFor(() => /changed elsewhere/.test(status()), 'the conflict from the stale base');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.', 'the explicit Second');
    assert.equal(drafts.get(OTHER).place.name, 'Second');
    oldRead.release();
    await settle();
    assert.equal(heading(), 'Second', 'the older read does not paint First');
    assert.ok(listNames().includes('Second'));
  });

  it('keeps the newest name in the list when an older list read answers last', async () => {
    await go(`#/memories/${OTHER}`);
    button('Rename').dispatch('click');
    type('Older');
    const oldList = (listHold = {});
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.' && oldList.release, 'the first rename and its held list read');
    button('Rename').dispatch('click');
    type('Newest');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.' && listNames().includes('Newest'), 'the newer list');
    oldList.release();
    await settle();
    assert.ok(listNames().includes('Newest'), 'the older list read does not bring back Older');
    assert.ok(!listNames().includes('Older'));
    assert.equal(heading(), 'Newest');
  });

  it('keeps a rename answered while a re-read of the same place was still out', async () => {
    await go(`#/memories/${OTHER}`);
    const before = heading();
    const reread = (detailHold = {});
    globalThis.location.hash = `#/memories/${OTHER}`;
    for (const listener of listeners.hashchange ?? []) listener();
    await waitFor(() => reread.release, 'the held re-read');
    button('Rename').dispatch('click');
    type('Renamed during a re-read');
    button('Save name').dispatch('click');
    await waitFor(() => status() === 'Name saved.', 'the rename');
    reread.release();
    await settle();
    assert.notEqual(before, 'Renamed during a re-read');
    assert.equal(heading(), 'Renamed during a re-read', 'the older read does not paint the earlier name');
  });

  it('drops a rename answer that arrives after navigating to another place or signing out', async () => {
    await go(`#/memories/${NAMED}`);
    button('Name this place').dispatch('click');
    type('Late name');
    renameHold = {};
    button('Save name').dispatch('click');
    await waitFor(() => renameHold.release, 'the held rename');
    await go(`#/memories/${OTHER}`);
    const otherHeading = heading();
    const release = renameHold.release;
    renameHold = null;
    release();
    await settle();
    assert.equal(heading(), otherHeading, 'the other place keeps its own name');
    assert.doesNotMatch(region().textContent, /Late name|Name saved/);

    button('Rename').dispatch('click');
    type('After sign-out');
    renameHold = {};
    button('Save name').dispatch('click');
    await waitFor(() => renameHold.release, 'the second held rename');
    button('Sign out').dispatch('click');
    await settle();
    const late = renameHold.release;
    renameHold = null;
    late();
    await settle();
    assert.equal(heading(), 'Saved memory', 'nothing private is painted after sign-out');
    assert.equal(region().children.length, 0);
    assert.equal(byId('saved-list').children.length, 0);
  });
});
