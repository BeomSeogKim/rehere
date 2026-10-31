import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// Deleting one's own contribution from the page: a preview of what it
// affects, an explicit acknowledgment and final press, one immutable request,
// list-only checks after a reload, and a content-free record afterwards for
// both the provider and the owner. Synthetic fixtures only.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const B_DRAFT = '22222222-2222-4222-8222-222222222222';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_URL = `/api/drafts/${DRAFT}/reconstructions/${JOB}`;
const B_URL = `/api/drafts/${B_DRAFT}/reconstructions/${JOB}`;
const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLACE = { draftId: DRAFT, jobId: JOB, label: 'Saved place A', version: 1 };
const PLACE_B = { draftId: B_DRAFT, jobId: JOB, label: 'Saved place B', version: 1 };
const PRINCIPAL = { id: 'p-contrib', role: 'contributor', displayName: 'Mina' };
const PREVIEW_URL = `${JOB_URL}/contributions/${CID}/deletion`;
const DELETE_URL = `${JOB_URL}/contributions/${CID}/delete`;
const PENDING_KEY = `rehere:deletion-pending:p-contrib:${DRAFT}:${JOB}:${CID}`;
const CAPTION_KEY = `rehere:caption-pending:p-contrib:${DRAFT}:${JOB}:${CID}`;
const OLD_ID = '99999999-9999-4999-8999-999999999999';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function wav(samples = 8) {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => [...text].forEach((char, i) => (bytes[offset + i] = char.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples * 2, true);
  return bytes;
}
const WAV = wav();
const wavResponse = () => ({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? 'audio/wav' : String(WAV.length)) }, arrayBuffer: async () => WAV.buffer, body: null });
const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let requests;
let routes;
let storage;
let audios;

before(() => {
  globalThis.document = {
    createElement: (tag) => {
      const node = new FakeElement(tag);
      if (tag === 'audio') {
        node.calls = [];
        node.play = () => (node.calls.push('play'), Promise.resolve());
        node.pause = () => node.calls.push('pause');
        node.load = () => node.calls.push('load');
        audios.push(node);
      }
      return node;
    },
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    const handler = routes[`${options.method ?? 'GET'} ${url}`];
    return handler ? handler(body) : json(404, { error: 'Not found.' });
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }),
  });
});

after(() => {
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.localStorage;
});

beforeEach(() => {
  requests = [];
  routes = {};
  storage = new Map();
  audios = [];
});

const finder = (root) => {
  const find = (predicate) => root.findAll(predicate);
  return {
    find,
    button: (text) => find((node) => node.tag === 'button' && node.textContent === text)[0],
    ack: () => find((node) => node.tag === 'label' && / I understand this deletion cannot be undone$/.test(node.textContent))[0]?.children[0],
    notes: () => find((node) => node.className?.startsWith('form-message')).map((node) => node.textContent).join(' '),
  };
};
const posts = () => requests.filter((r) => r.method === 'POST');
const mutations = () => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');

function contribution(overrides = {}) {
  return {
    id: CID,
    principalId: 'p-contrib',
    provider: { displayName: 'Mina' },
    kind: 'human_recollection',
    text: 'The bakery had a green door.',
    permissions: { place: true, model: false, share: true },
    periodClaim: 'Summer 1998',
    revision: 1,
    status: 'submitted',
    review: null,
    photo: null,
    voice: {
      available: true,
      type: 'audio/webm',
      durationMs: 4000,
      permissions: { place: true, model: false, share: true },
      captions: { cues: [{ startMs: 0, endMs: 4000, text: 'A bell.' }], sha256: 'c'.repeat(64), authorLabel: 'Mina', version: 2, createdAt: '2026-11-01T00:00:00.000Z' },
      captionHistory: [{ version: 1, cues: [{ startMs: 0, endMs: 4000, text: 'Bell.' }], sha256: 'd'.repeat(64), authorLabel: 'Mina', createdAt: '2026-11-01T00:00:00.000Z', supersededAt: '2026-11-01T01:00:00.000Z' }],
      url: `${JOB_URL}/contributions/${CID}/recording.wav`,
      audio: { type: 'audio/wav', size: WAV.length },
    },
    ...overrides,
  };
}
const INVENTORY = { writing: 1, photo: 0, voice: 1, playback: 1, captionVersions: 2, usedInPlace: true, sharedViewsAffected: true };
const tombstone = (state = 'access-stopped', id = CID) => ({
  id,
  kind: 'human_recollection',
  status: 'deleted',
  deletedAt: '2026-11-01T02:00:00.000Z',
  deletion: { state, completedAt: state === 'complete' ? '2026-11-01T02:00:05.000Z' : null, inventory: INVENTORY },
});
const list = (...contributions) => json(200, { revision: 1, contributions, variants: [], blocked: false, currentVersion: 1 });
const preview = (hash = HASH_A) => json(200, { state: 'present', impact: INVENTORY, impactSha256: hash });

async function contributor(places = [PLACE]) {
  routes['GET /api/contributor/places'] = () => json(200, places);
  const { mountContributor } = await import('../public/collaboration.js');
  const root = new FakeElement('div');
  const view = mountContributor(root, { principal: PRINCIPAL, media: {} });
  await settle();
  const ui = finder(root);
  if (places.length > 1) {
    const placeSelect = ui.find((node) => node.tag === 'select')[0];
    placeSelect.value = `${DRAFT}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
  }
  return { root, view, ui };
}

describe('deleting one’s own contribution', () => {
  it('previews what it affects, changes nothing before the final press, and leaves a content-free record', async () => {
    storage.set(CAPTION_KEY, OLD_ID);
    let current = contribution();
    routes[`GET ${JOB_URL}/collaboration`] = () => list(current);
    routes[`GET ${PREVIEW_URL}`] = () => preview();
    routes[`POST ${DELETE_URL}`] = (body) => {
      assert.equal(storage.get(PENDING_KEY), body.requestId, 'only the opaque ID is kept, before the answer');
      current = tombstone();
      return json(200, { contribution: current });
    };
    const { root, view, ui } = await contributor();
    ui.button('Withdraw').dispatch('click');
    assert.match(root.textContent, /Rehere keeps what you sent privately; to remove it from this app's stored data, use Delete from Rehere\./, 'withdrawal is told apart');
    ui.button('Keep it').dispatch('click');
    ui.button('Delete from Rehere…').dispatch('click');
    await settle();
    assert.match(root.textContent, /Deleting removes the words, the recording, its listening copy and 2 caption versions from this app's tracked storage on this computer\. It cannot be undone\./);
    assert.match(root.textContent, /Saved scenes that depended on it stay blocked/);
    assert.match(root.textContent, /Shared views and previews that use it stop for good/);
    assert.match(root.textContent, /Linked copies are cleared too/);
    assert.match(root.textContent, /backups of this computer or data its disk keeps after deletion/);
    assert.doesNotMatch(root.textContent, /a{64}/, 'no impact hash shown');
    assert.equal(ui.ack().checked, false);
    assert.equal(ui.button('Delete permanently').disabled, true);
    ui.button('Delete permanently').dispatch('click');
    await settle();
    assert.equal(mutations().length, 0, 'nothing changes before the acknowledgment and final press');
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    const [sent] = posts();
    assert.deepEqual(Object.keys(sent.body), ['requestId', 'impactSha256', 'confirmDeletion']);
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, impactSha256: HASH_A, confirmDeletion: true });
    assert.equal(storage.size, 0, 'deletion and caption IDs are gone');
    assert.match(ui.notes(), /Deleted from use\./);
    assert.match(root.textContent, /You deleted this recollection\./);
    assert.match(root.textContent, /Removing its stored files \(the words, the recording, its listening copy and 2 caption versions\) on this computer is still finishing\./);
    assert.doesNotMatch(root.textContent, /green door|Summer 1998|A bell|Previous captions|Withdraw|Delete from Rehere/);
    assert.equal(ui.button('Play'), undefined);
    assert.ok(ui.button('Check again'));
    assert.ok(ui.button('Retry local cleanup'));
    view.dispose();
  });

  it('a Keep it press sends nothing and restores the start button', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    routes[`GET ${PREVIEW_URL}`] = () => preview();
    const { view, ui } = await contributor();
    ui.button('Delete from Rehere…').dispatch('click');
    await settle();
    ui.button('Keep it').dispatch('click');
    assert.ok(ui.button('Delete from Rehere…'));
    assert.equal(mutations().length, 0);
    view.dispose();
  });
});

describe('an accepted deletion while the list is slow', () => {
  it('replaces the row and stops its audio at once, keeping other rows and the form', async () => {
    const other = contribution({ id: OTHER, text: 'The tram stopped here.', periodClaim: '', voice: null });
    let hold;
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution(), other);
    routes[`GET ${JOB_URL}/contributions/${CID}/recording.wav`] = () => wavResponse();
    routes[`GET ${PREVIEW_URL}`] = () => preview();
    routes[`POST ${DELETE_URL}`] = () => {
      routes[`GET ${JOB_URL}/collaboration`] = () => new Promise((resolve) => (hold = resolve));
      return json(200, { contribution: tombstone('access-stopped') });
    };
    const { root, view, ui } = await contributor();
    const form = ui.find((node) => node.tag === 'textarea')[0];
    form.value = 'An unsent recollection.';
    ui.button('Play').dispatch('click');
    await settle();
    const playing = audios.find((audio) => audio.calls.includes('play'));
    assert.ok(playing, 'the recording plays');
    ui.find((node) => node.tag === 'button' && node.textContent === 'Delete from Rehere…')[0].dispatch('click');
    await settle();
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    assert.ok(hold, 'the follow-up list read is still waiting');
    assert.ok(playing.calls.includes('pause'), 'its audio stopped before the list answered');
    assert.doesNotMatch(root.textContent, /green door|Summer 1998|A bell|Previous captions/);
    assert.equal(ui.button('Play'), undefined, 'no player left for it');
    assert.match(root.textContent, /You deleted this recollection\..*still finishing/s);
    assert.ok(ui.button('Retry local cleanup'));
    assert.match(root.textContent, /The tram stopped here\./, 'another row stays');
    assert.equal(form.value, 'An unsent recollection.', 'the form stays');
    hold(list(tombstone('complete'), other));
    await settle();
    assert.match(root.textContent, /Removed from this app's tracked storage on this computer on /);
    view.dispose();
  });
});

describe('a deletion preview when the list changes', () => {
  it('drops a shown preview and its acknowledgment, but keeps a sent request exactly', async () => {
    const other = contribution({ id: OTHER, text: 'The tram stopped here.', periodClaim: '', voice: null });
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution(), other);
    routes[`GET ${PREVIEW_URL}`] = () => preview();
    routes[`POST ${JOB_URL}/contributions/${OTHER}/withdraw`] = () => json(200, { id: OTHER });
    const reloadViaOtherWithdrawal = async (ui) => {
      ui.find((node) => node.tag === 'button' && node.textContent === 'Withdraw').at(-1).dispatch('click');
      ui.button('Withdraw this recollection').dispatch('click');
      await settle();
    };
    const { view, ui } = await contributor();
    ui.find((node) => node.tag === 'button' && node.textContent === 'Delete from Rehere…')[0].dispatch('click');
    await settle();
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    await reloadViaOtherWithdrawal(ui);
    assert.equal(ui.ack(), undefined, 'the old preview is gone');
    assert.equal(ui.button('Delete permanently').hidden, true);
    assert.match(ui.notes(), /Your list changed\. Review what deleting affects again before deleting\./);
    assert.ok(ui.button('Review the deletion again'));
    assert.equal(posts().filter((r) => r.url === DELETE_URL).length, 0);

    // A request already sent with an unknown outcome is kept as it was.
    routes[`POST ${DELETE_URL}`] = () => json(502, null);
    ui.button('Review the deletion again').dispatch('click');
    await settle();
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    await reloadViaOtherWithdrawal(ui);
    assert.ok(ui.ack().checked, 'the sent request’s acknowledgment and preview stay');
    ui.button('Delete again (same request)').dispatch('click');
    await settle();
    const sent = posts().filter((r) => r.url === DELETE_URL);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body, sent[0].body);
    view.dispose();
  });
});

describe('an unknown deletion outcome', () => {
  it('repeats the exact request, keeps it unknown after 401, and a reload only reads the list until a record settles it', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    routes[`GET ${PREVIEW_URL}`] = () => preview();
    const answers = [json(502, null), json(200, { contribution: tombstone('access-stopped', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') }), json(401, { error: 'Sign in again.' })];
    routes[`POST ${DELETE_URL}`] = () => answers.shift();
    const { view, ui } = await contributor();
    ui.button('Delete from Rehere…').dispatch('click');
    await settle();
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    assert.match(ui.notes(), /could not confirm whether the deletion was accepted/);
    ui.button('Delete again (same request)').dispatch('click');
    await settle();
    assert.match(ui.notes(), /could not confirm/, 'an answer about another contribution confirms nothing');
    ui.button('Delete again (same request)').dispatch('click');
    await settle();
    const sent = posts();
    assert.equal(sent.length, 3);
    assert.ok(sent.every((r) => JSON.stringify(r.body) === JSON.stringify(sent[0].body)), 'the same request each time');
    assert.equal(storage.get(PENDING_KEY), sent[0].body.requestId);
    assert.match(ui.notes(), /Whether an earlier try was accepted is still unknown/);
    view.dispose();

    // After a reload: only the list is read; a present row proves nothing.
    const again = await contributor();
    assert.match(again.ui.notes(), /An earlier deletion may have been accepted/);
    assert.equal(again.ui.button('Delete permanently').hidden, true, 'nothing to resend');
    again.ui.button('Check earlier deletion').dispatch('click');
    await settle();
    assert.equal(posts().length, 3, 'no automatic resend');
    assert.match(again.ui.notes(), /does not prove the earlier deletion was refused/);
    assert.equal(storage.get(PENDING_KEY), sent[0].body.requestId);
    routes[`GET ${JOB_URL}/collaboration`] = () => list(tombstone('complete'));
    again.ui.button('Check earlier deletion').dispatch('click');
    await settle();
    assert.equal(storage.size, 0, 'the record settles it');
    assert.match(again.root.textContent, /Removed from this app's tracked storage on this computer on /);
    assert.equal(again.ui.button('Retry local cleanup'), undefined);
    again.view.dispose();
  });
});

describe('a deletion whose impact changed', () => {
  it('re-previews, asks again, and the next press is a new request', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    let hash = HASH_A;
    routes[`GET ${PREVIEW_URL}`] = () => preview(hash);
    routes[`POST ${DELETE_URL}`] = (body) => {
      if (body.impactSha256 === HASH_A) {
        hash = HASH_B;
        return json(409, { error: 'What this deletion affects has changed.' });
      }
      return json(200, { contribution: tombstone('complete') });
    };
    const { view, ui } = await contributor();
    ui.button('Delete from Rehere…').dispatch('click');
    await settle();
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    assert.equal(requests.filter((r) => r.url === PREVIEW_URL).length, 2, 'previewed again');
    assert.match(ui.notes(), /What this deletion affects has changed\. Nothing was deleted\. Review what it affects again before deleting\./);
    assert.equal(ui.ack().checked, false, 'confirmed again, never automatically');
    assert.equal(ui.button('Delete permanently').disabled, true);
    assert.equal(storage.size, 0);
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    const [first, second] = posts();
    assert.notEqual(second.body.requestId, first.body.requestId);
    assert.equal(second.body.impactSha256, HASH_B);
    view.dispose();
  });
});

describe('local cleanup still pending', () => {
  it('checks read-only, and retries cleanup only on an explicit press with a new ID and no impact', async () => {
    let state = 'access-stopped';
    routes[`GET ${JOB_URL}/collaboration`] = () => list(tombstone(state));
    routes[`POST ${DELETE_URL}`] = () => json(200, { contribution: tombstone(state) });
    const { root, view, ui } = await contributor();
    ui.button('Check again').dispatch('click');
    await settle();
    assert.equal(posts().length, 0, 'Check again only reads');
    ui.button('Retry local cleanup').dispatch('click');
    await settle();
    assert.match(ui.notes(), /Local cleanup is still not finished\. Every use stays stopped/);
    state = 'complete';
    ui.button('Retry local cleanup').dispatch('click');
    await settle();
    const [first, second] = posts();
    for (const sent of [first, second]) assert.deepEqual(sent.body, { requestId: sent.body.requestId, impactSha256: null, confirmDeletion: true });
    assert.notEqual(first.body.requestId, second.body.requestId);
    assert.equal(storage.size, 0, 'nothing kept for a cleanup retry');
    assert.match(root.textContent, /Removed from this app's tracked storage on this computer on .*: the words, the recording, its listening copy and 2 caption versions\./);
    assert.equal(ui.button('Retry local cleanup'), undefined);
    assert.doesNotMatch(root.textContent, /all copies|erased/i);
    view.dispose();
  });
});

describe('a late deletion answer', () => {
  it('after a place change draws nothing and the earlier place keeps only its unknown ID', async () => {
    let answer;
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    routes[`GET ${B_URL}/collaboration`] = () => list();
    routes[`GET ${PREVIEW_URL}`] = () => preview();
    routes[`POST ${DELETE_URL}`] = () => new Promise((resolve) => (answer = resolve));
    const { root, view, ui } = await contributor([PLACE, PLACE_B]);
    ui.button('Delete from Rehere…').dispatch('click');
    await settle();
    ui.ack().checked = true;
    ui.ack().dispatch('change');
    ui.button('Delete permanently').dispatch('click');
    await settle();
    assert.equal(ui.button('Delete again (same request)').disabled, true, 'no overlapping request');
    const placeSelect = ui.find((node) => node.tag === 'select')[0];
    placeSelect.value = `${B_DRAFT}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
    const bReads = requests.filter((r) => r.url === `${B_URL}/collaboration`).length;
    answer(json(200, { contribution: tombstone() }));
    await settle();
    assert.equal(requests.filter((r) => r.url === `${B_URL}/collaboration`).length, bReads, 'nothing redrawn');
    assert.doesNotMatch(root.textContent, /Deleted/);
    assert.equal(storage.get(PENDING_KEY), posts()[0].body.requestId);
    view.dispose();
  });
});

describe('the owner’s view of a deleted contribution', () => {
  it('shows a nameless record without review, history or media, and closes an open review', async () => {
    let current = contribution();
    routes[`GET ${JOB_URL}/collaboration`] = () => list(current);
    const { mountCollaboration } = await import('../public/collaboration.js');
    const root = new FakeElement('section');
    const b = { jobUrl: JOB_URL, editor: () => ({ version: 1, offset: [0, 0, 0], yaw: 0, clean: true }), showTransform: () => true, setLocked() {}, saved() {}, unconfirmed() {}, conflict() {}, blocked() {} };
    const view = mountCollaboration(root, b);
    await settle();
    const ui = finder(root);
    ui.button('Review').dispatch('click');
    assert.match(root.textContent, /Review Mina’s recollection/);
    current = tombstone('complete');
    ui.button('Refresh').dispatch('click');
    await settle();
    assert.match(root.textContent, /Removed contribution · Deleted by the person who sent it\./);
    assert.match(root.textContent, /Removed from this app's tracked storage on this computer/);
    assert.doesNotMatch(root.textContent, /Mina|green door|A bell|Previous captions|Review Mina/);
    assert.equal(ui.button('Review'), undefined);
    assert.equal(ui.button('Play'), undefined);
    view.dispose();
  });
});

describe('a shared view stopped by a deletion', () => {
  it('shows the server’s fixed reason, offers no revoke, and lists no views', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list();
    routes[`GET ${JOB_URL}/history`] = () => json(200, [{ version: 1, dependencies: [], blocked: false }]);
    routes[`GET ${JOB_URL}/stories`] = () => json(200, { stories: [] });
    routes[`GET ${JOB_URL}/shares`] = () =>
      json(200, [{ id: 's-1', title: 'Removed contribution', status: 'revoked', reason: 'A contribution this view used was deleted.', createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-02T00:00:00.000Z', views: [] }]);
    const { mountShares } = await import('../public/shares.js');
    const root = new FakeElement('section');
    const view = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 1 }), getCamera: () => null });
    await settle();
    const ui = finder(root);
    assert.match(root.textContent, /Removed contribution · Revoked/);
    assert.match(root.textContent, /A contribution this view used was deleted\./);
    assert.equal(ui.button('Revoke'), undefined);
    view.dispose();
  });
});
