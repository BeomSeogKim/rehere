import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// Boots the real app.js as the owner against a small in-memory server that
// follows the place-deletion contract: review, one immutable request, exact
// replay, stale impact, pending cleanup and old addresses.
installViewerShim();

const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const waitFor = async (check, label) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const ids = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((letter, i) => [letter, `${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-4${String(i + 1).repeat(3)}-8${String(i + 1).repeat(3)}-${String(i + 1).repeat(12)}`]));
const hash = (n) => n.toString(16).padStart(64, '0');
const inventory = (overrides = {}) => ({
  photos: 2,
  writtenMemory: true,
  recording: false,
  scenes: 1,
  recordedStories: 0,
  contributions: 3,
  contributionProviders: 2,
  visitorSnapshots: 1,
  visitorPreviews: 0,
  linkedRegions: 4,
  invitations: 1,
  intakes: 0,
  processing: 0,
  ...overrides,
});

// --- a small server ---------------------------------------------------------
const requests = [];
const faults = [];
const present = new Map();
const deleted = new Map();
const receipts = new Map();
const impact = new Map();
const holds = {};
const addPlace = (key, name) => {
  present.set(ids[key], name);
  impact.set(ids[key], hash(ids[key].charCodeAt(0)));
};
Object.assign(ids, { I: 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9', J: 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9', K: 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9', L: 'd9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9' });
for (const [key, name] of [['L', 'Loft'], ['I', 'Inn'], ['J', 'Jetty'], ['K', 'Kiln'], ['A', 'Bakery'], ['B', 'Harbour'], ['E', 'Mill'], ['F', 'Courtyard'], ['G', 'Gate'], ['H', 'Hall']]) addPlace(key, name);
const record = (draftId, requestId, impactSha256, state = 'access-stopped') => ({
  draftId,
  requestId,
  impactSha256,
  state,
  requestedAt: '2026-11-02T10:00:00.000Z',
  completedAt: state === 'complete' ? '2026-11-02T10:05:00.000Z' : null,
  inventory: inventory(),
});
deleted.set(ids.C, record(ids.C, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', hash(3)));
deleted.set(ids.D, record(ids.D, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', hash(4), 'complete'));
receipts.set(deleted.get(ids.C).requestId, { draftId: ids.C, impactSha256: hash(3) });

const take = (name) => {
  const index = faults.indexOf(name);
  if (index < 0) return false;
  faults.splice(index, 1);
  return true;
};
const hold = async (name) => {
  if (!holds[name]) return;
  const held = holds[name];
  delete holds[name];
  await new Promise((resolve) => (held.release = resolve));
};
const answerRecord = (r) => json(r.state === 'complete' ? 200 : 202, structuredClone(r));

async function remove(draftId, body) {
  await hold('delete');
  if (take('delete-lost-before')) return lost();
  if (take('delete-foreign-record')) return json(202, record(draftId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', body.impactSha256));
  if (take('delete-complete-without-time')) return json(200, { ...record(draftId, body.requestId, body.impactSha256, 'complete'), completedAt: null });
  const seen = receipts.get(body.requestId);
  if (seen) {
    if (seen.draftId !== draftId || seen.impactSha256 !== body.impactSha256) return json(409, { error: 'That request was already used for something else.' });
    const r = deleted.get(draftId);
    if (take('cleanup-completes')) r.state = 'complete';
    if (r.state === 'complete') r.completedAt ??= '2026-11-02T10:06:00.000Z';
    return answerRecord(r);
  }
  if (deleted.has(draftId)) return json(409, { error: 'This place was already deleted by another request.' });
  if (body.impactSha256 !== impact.get(draftId)) return json(409, { error: 'What deleting would remove has changed.' });
  present.delete(draftId);
  deleted.set(draftId, record(draftId, body.requestId, body.impactSha256));
  receipts.set(body.requestId, { draftId, impactSha256: body.impactSha256 });
  if (take('delete-lost-after')) return lost();
  return answerRecord(deleted.get(draftId));
}

const detail = (id) => ({ id, createdAt: '2026-10-30T08:00:00.000Z', text: `Words about ${present.get(id)}.`, textSourceId: null, photos: [], voice: null, sources: [], place: { name: present.get(id), revision: 0, updatedAt: null, unavailable: false } });

const listeners = {};
const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id === 'saved-list' || id === 'photo-list' ? 'ul' : 'div'));
  return elements.get(id);
};
const storage = new Map();

before(async () => {
  byId('owner-app').hidden = true;
  globalThis.document = { createElement: (tag) => new FakeElement(tag), getElementById: byId, createDocumentFragment: () => new FakeElement('fragment'), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = (type, listener) => (listeners[type] ??= []).push(listener);
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => assert.fail('no microphone request') } } });
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
    if (url === '/api/intakes') return json(200, []);
    if (url === '/api/drafts') return json(200, [...present.keys()].map((id) => ({ id, createdAt: '2026-10-30T08:00:00.000Z', photoCount: 0, hasVoice: false, textPreview: `Words about ${present.get(id)}.`, place: detail(id).place })));
    if (url === '/api/place-deletions') return json(200, { items: [...deleted.values()].filter((r) => r.state === 'access-stopped').map((r) => structuredClone(r)) });
    const state = /^\/api\/drafts\/([^/]+)\/deletion$/.exec(url);
    if (state) {
      await hold('state');
      if (take('state-unreadable')) return json(503, { error: 'Unavailable.' });
      const id = state[1];
      if (deleted.has(id)) return json(200, structuredClone(deleted.get(id)));
      if (present.has(id)) return json(200, { draftId: id, state: 'present', impactSha256: impact.get(id), inventory: inventory() });
      return json(404, { error: 'This memory could not be found.' });
    }
    const del = /^\/api\/drafts\/([^/]+)\/delete$/.exec(url);
    if (del && method === 'POST') return remove(del[1], body);
    const draft = /^\/api\/drafts\/([^/]+)$/.exec(url);
    if (draft) {
      // A held read answers with what was there when it arrived.
      const answer = present.has(draft[1]) ? json(200, detail(draft[1])) : json(404, { error: 'This memory could not be found.' });
      await hold('detail');
      return answer;
    }
    return json(404, { error: 'Not found.' });
  };
  await import('../public/app.js');
  await settle();
});

const all = (predicate) => [...elements.values()].flatMap((root) => root.findAll(predicate));
const button = (text) => all((node) => node.tag === 'button' && node.textContent === text)[0];
const panel = () => byId('viewer-place-removal');
const panelText = () => panel().textContent;
const panelButton = (text) => panel().findAll((node) => node.tag === 'button' && node.textContent === text)[0];
const ack = () => panel().findAll((node) => node.tag === 'input' && node.type === 'checkbox')[0];
const details = () => panel().findAll((node) => node.tag === 'details')[0];
const posts = (id) => requests.filter((r) => r.method === 'POST' && r.url === `/api/drafts/${id}/delete`);
const listText = () => byId('saved-list').textContent;
const pendingText = () => byId('place-deletions').textContent;
const message = () => byId('form-message').textContent;
const stored = (id) => storage.get(`rehere:place-deletion-pending:${owner.id}:${id}`);
const go = async (hash) => {
  globalThis.location.hash = hash;
  for (const listener of listeners.hashchange ?? []) listener();
  await settle();
};
const openReview = async () => {
  details().open = true;
  details().dispatch('toggle');
  await settle();
};
const tick = () => {
  ack().checked = true;
  ack().dispatch('change');
};

describe('owner deletion of a whole place', () => {
  it('lists only places still being cleaned up, content-free, beside the saved list', () => {
    assert.match(pendingText(), /^Places still being deleted/);
    assert.match(pendingText(), /Access to it has stopped\. Removal of its stored files on this computer has not been verified yet\./);
    assert.doesNotMatch(pendingText(), /gone from Rehere|still finishing/);
    assert.match(pendingText(), /Recorded when deletion was requested: .*0 pieces of work active when deletion was requested\./);
    assert.equal(byId('place-deletions').findAll((node) => node.tag === 'li').length, 1, 'the complete removal is not listed');
    assert.ok(!/Bakery|Harbour/.test(pendingText()), 'no names');
    assert.ok(listText().includes('Bakery') && !listText().includes(ids.C));
  });

  it('opening only reads; keeping the place sends nothing; the acknowledgement gates the final button', async () => {
    await go(`#/memories/${ids.A}`);
    assert.equal(details().open, false);
    assert.match(details().textContent, /^Delete this place from this computer…/);
    await openReview();
    assert.equal(requests.at(-1).url, `/api/drafts/${ids.A}/deletion`);
    assert.match(panelText(), /Deleting removes this place and everything this app keeps for it on this computer: 2 original photos, the written memory, 1 scene, 0 recorded stories, 3 contributions from 2 contributors, 1 visitor link, 0 visitor previews, 4 linked photo regions, 1 invitation, 0 related upload records and 0 pieces of work in progress\./);
    assert.match(panelText(), /This is not a withdrawal made for the people who sent them/);
    assert.match(panelText(), /Unsaved changes on this screen, such as scene edits, previews or an open rename, are discarded when you confirm\./);
    assert.match(panelText(), /It is not secure erasure, and it cannot remove backups, logs, caches, downloads, screenshots/);
    assert.match(panelText(), /No use permission or public-origin rule changes, and nothing is published\./);
    assert.equal(ack().checked, false);
    assert.equal(panelButton('Delete this place permanently').disabled, true);
    tick();
    assert.equal(panelButton('Delete this place permanently').disabled, false);
    panelButton('Keep this place').dispatch('click');
    await settle();
    assert.equal(posts(ids.A).length, 0, 'keeping sends nothing');
    assert.equal(details().open, false);
    assert.equal(byId('viewer-title').textContent, 'Bakery', 'the saved view is unchanged');
    await openReview();
    assert.equal(ack().checked, false, 'a new review starts unacknowledged');
  });

  it('closes the place view before the answer, then returns to the list without it and shows its state', async () => {
    await go(`#/memories/${ids.A}`);
    await openReview();
    tick();
    const held = (holds.delete = {});
    panelButton('Delete this place permanently').dispatch('click');
    await waitFor(() => held.release, 'the held request');
    assert.equal(byId('viewer-title').textContent, 'Saved memory', 'the name and rename close before the answer');
    assert.equal(byId('viewer-place-name').children.length, 0);
    const kept = JSON.parse(stored(ids.A));
    assert.deepEqual(Object.keys(kept).sort(), ['impactSha256', 'requestId'], 'only the opaque request and digest are kept');
    const [sent] = posts(ids.A);
    assert.deepEqual(sent.body, { requestId: kept.requestId, impactSha256: impact.get(ids.A), confirmDeletion: true });
    held.release();
    await settle();
    assert.equal(globalThis.location.hash, '', 'back to the list');
    assert.equal(byId('viewer').hidden, true);
    assert.match(message(), /^This place was deleted on .*\. Access to it has stopped\. Removal of its stored files on this computer has not been verified yet\.$/);
    assert.ok(!listText().includes('Bakery'), 'the deleted place is omitted');
    assert.equal(byId('place-deletions').findAll((node) => node.tag === 'li').length, 2, 'now listed as still being deleted');
    assert.equal(stored(ids.A), undefined, 'the settled request is forgotten');
  });

  it('retries local cleanup with the accepted request itself, then stops listing it', async () => {
    const accepted = deleted.get(ids.C);
    faults.push('cleanup-completes');
    const retry = byId('place-deletions').findAll((node) => node.tag === 'button' && node.textContent === 'Retry local cleanup')[0];
    retry.dispatch('click');
    await settle();
    assert.deepEqual(posts(ids.C).at(-1).body, { requestId: accepted.requestId, impactSha256: accepted.impactSha256, confirmDeletion: true }, 'the same accepted body');
    assert.match(message(), /^This place was deleted from this computer\. Local cleanup finished on /);
    assert.equal(byId('place-deletions').findAll((node) => node.tag === 'li').length, 1, 'only the other pending removal remains');
  });

  it('keeps an unconfirmed request through a reload, never claims nothing was deleted, and repeats exactly that request', async () => {
    await go(`#/memories/${ids.B}`);
    await openReview();
    tick();
    faults.push('delete-lost-before');
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    assert.match(panelText(), /Rehere could not confirm the deletion\. It may have been accepted\./);
    assert.doesNotMatch(panelText(), /Nothing was deleted|not deleted/i);
    assert.equal(panelButton('Delete this place permanently'), undefined, 'no new request is offered');
    const kept = stored(ids.B);
    assert.ok(kept);
    panelButton('Check earlier deletion').dispatch('click');
    await settle();
    assert.match(panelText(), /This place is still here, but the earlier request may still be accepted\. Delete again repeats exactly that request\./);
    assert.equal(stored(ids.B), kept, 'a present place does not clear the request');

    // Leaving and coming back mounts a new panel from storage, as a reload would.
    await go(`#/memories/${ids.A}`);
    await go(`#/memories/${ids.B}`);
    assert.equal(details().open, true);
    assert.ok(panelButton('Delete again (same request)'), 'reconciled from the stored request before anything new');
    assert.equal(panelButton('Delete this place permanently'), undefined);
    panelButton('Delete again (same request)').dispatch('click');
    await settle();
    const [first, second] = posts(ids.B);
    assert.deepEqual(second.body, first.body, 'exactly the same request');
    assert.equal(globalThis.location.hash, '');
    assert.ok(!listText().includes('Harbour'));
    assert.equal(stored(ids.B), undefined);
  });

  it('does not accept a well-formed answer that is not its own request', async () => {
    await go(`#/memories/${ids.H}`);
    await openReview();
    tick();
    faults.push('delete-foreign-record');
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    assert.match(panelText(), /Rehere could not confirm the deletion\. It may have been accepted\./);
    assert.equal(globalThis.location.hash, `#/memories/${ids.H}`);
    assert.ok(stored(ids.H), 'its own request stays to be repeated');
    panelButton('Delete again (same request)').dispatch('click');
    await settle();
    assert.equal(globalThis.location.hash, '', 'its own answer is accepted');
  });

  it('after a stale-impact refusal reads the state first, then asks for a new review of the place still here', async () => {
    await go(`#/memories/${ids.E}`);
    await openReview();
    tick();
    impact.set(ids.E, hash(99));
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    const stateReads = requests.filter((r) => r.url === `/api/drafts/${ids.E}/deletion`).length;
    assert.ok(stateReads >= 2, 'the state was read after the refusal');
    assert.match(byId('viewer-message').textContent, /What deleting would remove has changed\. This request was not applied to the place as it is now\. Review it again before deleting\./);
    assert.equal(byId('viewer-title').textContent, 'Mill', 'the place is read again');
    assert.equal(details().open, false);
    assert.equal(stored(ids.E), undefined);
    await openReview();
    assert.equal(ack().checked, false);
    tick();
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    assert.equal(posts(ids.E).at(-1).body.impactSha256, hash(99), 'a new request from the new review');
    assert.notEqual(posts(ids.E).at(-1).body.requestId, posts(ids.E)[0].body.requestId);
    assert.equal(globalThis.location.hash, '');
  });

  it('shows a deletion by another request as this place’s state, not a refusal', async () => {
    await go(`#/memories/${ids.F}`);
    await openReview();
    tick();
    deleted.set(ids.F, record(ids.F, 'ffffffff-ffff-4fff-8fff-ffffffffffff', hash(6)));
    present.delete(ids.F);
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    assert.equal(globalThis.location.hash, '');
    assert.match(message(), /^This place was deleted on /);
    assert.doesNotMatch(message(), /not applied|Nothing was deleted/);
  });

  it('shows an old address’s deletion state instead of opening it, and a missing one as before', async () => {
    await go(`#/memories/${ids.D}`);
    assert.match(byId('viewer-message').textContent, /^This place was deleted from this computer\. Local cleanup finished on .* for what was recorded when deletion was requested: 2 original photos/);
    assert.match(byId('viewer-message').textContent, /0 pieces of work active when deletion was requested/, 'the frozen scope, not work still running');
    assert.doesNotMatch(byId('viewer-message').textContent, /in progress/);
    assert.equal(requests.filter((r) => r.url.includes(`${ids.D}/reconstructions`)).length, 0, 'no scene is opened');
    assert.equal(panel().children.length, 0, 'nothing to delete again');
    await go('#/memories/99999999-9999-4999-8999-999999999999');
    assert.equal(byId('viewer-message').textContent, 'This memory could not be opened.');
  });

  it('never shows a deleted place again from a read that was still out when it was deleted', async () => {
    await go(`#/memories/${ids.I}`);
    await openReview();
    tick();
    // The same address handled again starts a re-read that is held.
    const reread = (holds.detail = {});
    for (const listener of listeners.hashchange ?? []) listener();
    await waitFor(() => reread.release, 'the held re-read');
    // Unconfirmed first: the closed view stays closed while it is uncertain.
    faults.push('delete-lost-after');
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    assert.match(panelText(), /It may have been accepted/);
    reread.release();
    await settle();
    assert.equal(byId('viewer-title').textContent, 'Saved memory', 'the held read does not show the place again');
    assert.doesNotMatch(byId('viewer-text').textContent, /Inn/);
    // Then accepted: a read held at that moment does not restore it either.
    const second = (holds.detail = {});
    for (const listener of listeners.hashchange ?? []) listener();
    await waitFor(() => second.release, 'a second held read');
    panelButton('Delete again (same request)').dispatch('click');
    await settle();
    assert.equal(globalThis.location.hash, '');
    second.release();
    await settle();
    assert.equal(byId('viewer').hidden, true);
    assert.doesNotMatch(byId('viewer-title').textContent + byId('viewer-text').textContent, /Inn/, 'the held read does not restore it');
  });

  it('does not show a place again when opening its review finds it already deleted while a read is out', async () => {
    await go(`#/memories/${ids.L}`);
    const reread = (holds.detail = {});
    for (const listener of listeners.hashchange ?? []) listener();
    await waitFor(() => reread.release, 'the held re-read');
    deleted.set(ids.L, record(ids.L, 'abababab-abab-4bab-8bab-abababababab', hash(12)));
    present.delete(ids.L);
    await openReview();
    assert.equal(globalThis.location.hash, '', 'its deletion is shown instead');
    reread.release();
    await settle();
    assert.equal(byId('viewer').hidden, true);
    assert.doesNotMatch(byId('viewer-title').textContent + byId('viewer-text').textContent, /Loft/);
  });

  it('leaves a newer address alone when a late acceptance arrives before its navigation runs', async () => {
    await go(`#/memories/${ids.J}`);
    await openReview();
    tick();
    const held = (holds.delete = {});
    panelButton('Delete this place permanently').dispatch('click');
    await waitFor(() => held.release, 'the held request');
    const newer = `#/memories/${ids.K}`;
    globalThis.location.hash = newer;
    held.release();
    await settle();
    assert.equal(globalThis.location.hash, newer, 'the newer address is not replaced');
    assert.match(message(), /^This place was deleted on /, 'the deletion is still reported');
    for (const listener of listeners.hashchange ?? []) listener();
    await settle();
    assert.equal(byId('viewer-title').textContent, 'Kiln');
  });

  it('treats a complete answer without its completion time as unconfirmed and keeps the request', async () => {
    await go(`#/memories/${ids.K}`);
    await openReview();
    tick();
    faults.push('delete-complete-without-time');
    byId('form-message').replaceChildren();
    panelButton('Delete this place permanently').dispatch('click');
    await settle();
    assert.match(panelText(), /Rehere could not confirm the deletion\. It may have been accepted\./);
    assert.doesNotMatch(message(), /finished/);
    assert.ok(stored(ids.K), 'the request stays for an exact repeat');
    assert.equal(globalThis.location.hash, `#/memories/${ids.K}`);
  });

  it('drops answers that arrive after navigating away or signing out', async () => {
    await go(`#/memories/${ids.G}`);
    const reviewHeld = (holds.state = {});
    details().open = true;
    details().dispatch('toggle');
    await waitFor(() => reviewHeld.release, 'the held review');
    await go(`#/memories/${ids.D}`);
    reviewHeld.release();
    await settle();
    await go(`#/memories/${ids.G}`);
    await openReview();
    tick();
    const sendHeld = (holds.delete = {});
    panelButton('Delete this place permanently').dispatch('click');
    await waitFor(() => sendHeld.release, 'the held request');
    await go('');
    byId('form-message').replaceChildren();
    sendHeld.release();
    await settle();
    assert.equal(globalThis.location.hash, '');
    assert.doesNotMatch(message(), /This place was deleted/, 'a late answer for a closed view shows nothing');
    assert.ok(stored(ids.G), 'its request stays to be reconciled on the next visit');

    await go(`#/memories/${ids.G}`);
    assert.match(byId('viewer-message').textContent, /^This place was deleted on /, 'the next visit shows what the late answer had done');
    assert.equal(panel().children.length, 0, 'and offers no new request');
    assert.equal(stored(ids.G), undefined, 'its stored request is forgotten once the deletion is read');
    button('Sign out').dispatch('click');
    await settle();
    assert.equal(byId('place-deletions').children.length, 0, 'the pending list is cleared');
    assert.equal(panel().children.length, 0);
  });
});
