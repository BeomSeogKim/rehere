import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// Listening captions a provider adds or corrects after sending a recording:
// each save is one immutable request, a reload can only look an unconfirmed
// one up, typed text survives refusals and newer versions, and owners and
// visitors see which version they are looking at.
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
const CAPTIONS_URL = `${JOB_URL}/contributions/${CID}/captions`;
const PENDING_KEY = `rehere:caption-pending:p-contrib:${DRAFT}:${JOB}:${CID}`;
const OLD_ID = '99999999-9999-4999-8999-999999999999';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let requests;
let routes;
let storage;

before(() => {
  globalThis.document = {
    createElement: (tag) => {
      const node = new FakeElement(tag);
      if (tag === 'audio') {
        node.calls = [];
        node.play = () => (node.calls.push('play'), Promise.resolve());
        node.pause = () => node.calls.push('pause');
        node.load = () => node.calls.push('load');
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
});

const finder = (root) => {
  const find = (predicate) => root.findAll(predicate);
  return {
    find,
    button: (text) => find((node) => node.tag === 'button' && node.textContent === text)[0],
    // The caption editor, wherever it is shown, apart from the send form.
    textarea: () => find((node) => node.tag === 'textarea' && node.parent?.children[0]?.textContent === 'Listening captions')[0],
    confirm: () => find((node) => node.tag === 'label' && / I wrote these listening captions$/.test(node.textContent))[0]?.children[0],
    notes: () => find((node) => node.className?.startsWith('form-message')).map((node) => node.textContent).join(' '),
  };
};
const posts = (url) => requests.filter((r) => r.method === 'POST' && r.url === url);
const captions = (version, text, sha) => ({ cues: [{ startMs: 0, endMs: 4000, text }], sha256: sha.repeat(64), authorLabel: 'Mina', version, createdAt: '2026-11-01T00:00:00.000Z' });

function contribution(overrides = {}) {
  return {
    id: CID,
    principalId: 'p-contrib',
    provider: { displayName: 'Mina' },
    text: '',
    permissions: null,
    periodClaim: '',
    revision: 1,
    status: 'submitted',
    review: null,
    photo: null,
    voice: {
      available: true,
      type: 'audio/webm',
      durationMs: 4000,
      permissions: { place: true, model: false, share: true },
      captions: null,
      captionHistory: [],
      url: `${JOB_URL}/contributions/${CID}/recording.wav`,
      audio: { type: 'audio/wav', size: 60 },
    },
    ...overrides,
  };
}
const withCaptions = (current, history = [], extra = {}) => contribution({ ...extra, voice: { ...contribution().voice, captions: current, captionHistory: history } });
const list = (...contributions) => json(200, { revision: 1, contributions, variants: [], blocked: false, currentVersion: 1 });

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

describe('a provider adding captions to a voice-only recording', () => {
  it('saves one exact first version only after confirmation, keeps only the opaque ID, and then offers correction', async () => {
    let current = contribution();
    routes[`GET ${JOB_URL}/collaboration`] = () => list(current);
    routes[`POST ${CAPTIONS_URL}`] = (body) => {
      assert.equal(storage.get(PENDING_KEY), body.requestId, 'only the opaque ID is kept, before the answer');
      current = withCaptions(captions(1, body.captionText, 'a'));
      return json(200, { contribution: current, appliedCaptionVersion: 1 });
    };
    const { root, view, ui } = await contributor();
    assert.match(root.textContent, /Your recording · 0:04\.0 long · No captions supplied\./);
    ui.button('Add listening captions').dispatch('click');
    assert.match(root.textContent, /not a transcript/);
    assert.match(root.textContent, /stops any shared view that uses this recording; the owner needs a new preview and link/);
    assert.match(root.textContent, /Copies someone already downloaded cannot be recalled\./);
    ui.textarea().value = 'A bell rings twice.';
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.match(ui.notes(), /Confirm that you wrote these listening captions yourself\./);
    assert.equal(posts(CAPTIONS_URL).length, 0, 'nothing sent unconfirmed');
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    const [sent] = posts(CAPTIONS_URL);
    assert.deepEqual(Object.keys(sent.body), ['requestId', 'baseCaptionSha256', 'captionText', 'captionConfirmed']);
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseCaptionSha256: null, captionText: 'A bell rings twice.', captionConfirmed: true });
    assert.equal(storage.size, 0, 'nothing is kept once saved');
    assert.match(ui.notes(), /saved as version 1/);
    assert.match(root.textContent, /0:04\.0 long · captions version 1: “A bell rings twice\.”/);
    assert.ok(ui.button('Correct listening captions'), 'a correction is offered next');
    assert.equal(ui.textarea(), undefined, 'the saved editor closed');
    view.dispose();
  });
});

describe('an unconfirmed correction', () => {
  it('repeats the exact request despite newer typing, and names a saved version apart from a newer current one', async () => {
    const v1 = captions(1, 'A bell.', 'a');
    let answer = json(502, null);
    routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(v1));
    routes[`POST ${CAPTIONS_URL}`] = () => answer;
    const { root, view, ui } = await contributor();
    ui.button('Correct listening captions').dispatch('click');
    assert.equal(ui.textarea().value, 'A bell.', 'starts from the current captions');
    ui.textarea().value = 'A bell rings twice.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.match(ui.notes(), /could not confirm whether your captions were saved/);
    assert.equal(ui.textarea().value, 'A bell rings twice.', 'typing kept');
    ui.textarea().value = 'A bell rings twice from the door.';
    answer = json(200, { contribution: withCaptions(captions(3, 'Someone else’s later text.', 'c'), [captions(2, 'A bell rings twice.', 'b'), v1]), appliedCaptionVersion: 2 });
    routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(captions(3, 'Later.', 'c'), [captions(2, 'A bell rings twice.', 'b'), v1]));
    ui.button('Save again (same request)').dispatch('click');
    await settle();
    const [first, second] = posts(CAPTIONS_URL);
    assert.deepEqual(second.body, first.body, 'the same request, not the newer typing');
    assert.equal(first.body.baseCaptionSha256, 'a'.repeat(64));
    assert.match(ui.notes(), /saved as version 2\. A later version \(version 3\) is now current\./);
    assert.equal(ui.textarea().value, 'A bell rings twice from the door.', 'newer typing still there');
    assert.match(root.textContent, /The listening captions changed after you opened this editor/);
    assert.equal(ui.button('Save listening captions').disabled, true, 'cannot be saved over unseen captions');
    assert.match(root.textContent, /Previous captions \(2\)/);
    assert.match(root.textContent, /Version 2, written by Mina/);
    view.dispose();
  });
});

describe('a refused save', () => {
  it('keeps the typed text, shows the newer captions as stale, and reopens them only on request', async () => {
    const v1 = captions(1, 'A bell.', 'a');
    const v2 = captions(2, 'Two bells.', 'b');
    let current = withCaptions(v1);
    routes[`GET ${JOB_URL}/collaboration`] = () => list(current);
    routes[`POST ${CAPTIONS_URL}`] = (body) => {
      if (body.baseCaptionSha256 === v2.sha256) return json(200, { contribution: withCaptions(captions(3, body.captionText, 'd'), [v2, v1]), appliedCaptionVersion: 3 });
      current = withCaptions(v2, [v1]);
      return json(409, { error: 'These captions changed since you opened them.' });
    };
    const { root, view, ui } = await contributor();
    ui.button('Correct listening captions').dispatch('click');
    ui.textarea().value = 'My edit.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.match(ui.notes(), /These captions changed since you opened them\. What you typed is still here\./);
    assert.equal(ui.textarea().value, 'My edit.');
    assert.equal(storage.size, 0, 'a definite refusal leaves nothing pending');
    assert.equal(ui.button('Save listening captions').disabled, true);
    ui.button('Reopen the current captions').dispatch('click');
    assert.equal(ui.textarea().value, 'Two bells.');
    assert.equal(ui.confirm().checked, false, 'confirmation is given again');
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    const [, retry] = posts(CAPTIONS_URL);
    assert.equal(retry.body.baseCaptionSha256, v2.sha256);
    assert.notEqual(retry.body.requestId, posts(CAPTIONS_URL)[0].body.requestId);
    assert.match(root.textContent, /saved as version 3; earlier versions stay listed/);
    view.dispose();
  });
});

describe('a confirmed save whose list cannot be read again', () => {
  it('stays visibly saved with refresh guidance, once, without sending again', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    routes[`POST ${CAPTIONS_URL}`] = () => {
      routes[`GET ${JOB_URL}/collaboration`] = () => json(503, null);
      return json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a')), appliedCaptionVersion: 1 });
    };
    const { root, view, ui } = await contributor();
    ui.button('Add listening captions').dispatch('click');
    ui.textarea().value = 'A bell.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.match(root.textContent, /Your recollections could not be loaded/);
    assert.match(ui.notes(), /saved as version 1\. Your list could not be refreshed; reload the page to see it\./);
    assert.equal(ui.notes().match(/saved as version 1/g).length, 1, 'said once');
    assert.equal(posts(CAPTIONS_URL).length, 1, 'not sent again');
    assert.equal(storage.size, 0, 'confirmed, nothing pending');
    assert.doesNotMatch(ui.notes(), /could not confirm/);
    view.dispose();
  });
});

describe('unsaved caption text when the list cannot be read again', () => {
  it('keeps a refused draft and its reason reachable without media, and refreshes on request', async () => {
    const v1 = captions(1, 'A bell.', 'a');
    routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(v1));
    routes[`POST ${CAPTIONS_URL}`] = () => {
      routes[`GET ${JOB_URL}/collaboration`] = () => json(503, null);
      return json(400, { error: 'These captions are the same as the current ones.' });
    };
    const { root, view, ui } = await contributor();
    ui.button('Correct listening captions').dispatch('click');
    ui.textarea().value = 'My edit.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.match(root.textContent, /Your recollections could not be loaded/);
    assert.equal(ui.textarea().value, 'My edit.', 'the draft is still reachable');
    assert.match(ui.notes(), /These captions are the same as the current ones\. What you typed is still here\./);
    assert.equal(ui.button('Play'), undefined, 'no player kept from the unconfirmed list');
    assert.doesNotMatch(root.textContent, /Previous captions/);
    assert.equal(posts(CAPTIONS_URL).length, 1, 'not sent again');
    routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(v1));
    ui.button('Refresh your recollections').dispatch('click');
    await settle();
    assert.equal(ui.button('Refresh your recollections'), undefined);
    assert.equal(ui.find((node) => node.tag === 'textarea' && node.parent?.children[0]?.textContent === 'Listening captions').length, 1, 'shown once, back in its row');
    assert.equal(ui.textarea().value, 'My edit.');
    assert.ok(ui.button('Play'), 'the list and its player are back');
    view.dispose();
  });

  it('keeps newer typing after a confirmed save whose refresh failed, and drops drafts when access ends', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    routes[`POST ${CAPTIONS_URL}`] = () => {
      ui.textarea().value = 'A bell rings twice.';
      routes[`GET ${JOB_URL}/collaboration`] = () => json(503, null);
      return json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a')), appliedCaptionVersion: 1 });
    };
    const { view, ui } = await contributor();
    ui.button('Add listening captions').dispatch('click');
    ui.textarea().value = 'A bell.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.match(ui.notes(), /saved as version 1\. Your list could not be refreshed/);
    assert.equal(ui.textarea().value, 'A bell rings twice.', 'newer typing still reachable');
    assert.equal(posts(CAPTIONS_URL).length, 1);
    routes[`GET ${JOB_URL}/collaboration`] = () => json(403, { error: 'Not allowed.' });
    ui.button('Refresh your recollections').dispatch('click');
    await settle();
    assert.equal(ui.textarea(), undefined, 'no draft stays once access ends');
    view.dispose();
  });
});

describe('an unknown save refused for access', () => {
  for (const code of [401, 403]) {
    it(`keeps the earlier request unknown after a ${code}, and a later lookup settles it`, async () => {
      routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
      const answers = [json(502, null), json(code, { error: 'Sign in again.' })];
      routes[`POST ${CAPTIONS_URL}`] = () => answers.shift();
      const { view, ui } = await contributor();
      ui.button('Add listening captions').dispatch('click');
      ui.textarea().value = 'A bell.';
      ui.confirm().checked = true;
      ui.button('Save listening captions').dispatch('click');
      await settle();
      routes[`GET ${JOB_URL}/collaboration`] = () => json(code, { error: 'Sign in again.' });
      ui.button('Save again (same request)').dispatch('click');
      await settle();
      const [first, second] = posts(CAPTIONS_URL);
      assert.deepEqual(second.body, first.body);
      assert.equal(storage.get(PENDING_KEY), first.body.requestId, 'the ID stays');
      assert.match(ui.notes(), /Whether an earlier try was saved is still unknown/);
      assert.doesNotMatch(ui.notes(), /could not be saved|What you typed is still here/);
      assert.equal(ui.textarea(), undefined, 'no draft stays on screen once access ends');
      view.dispose();

      // Signed in again after a reload: only the receipt is looked up.
      routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
      routes[`GET ${CAPTIONS_URL}/requests/${first.body.requestId}`] = () => {
        routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(captions(1, 'A bell.', 'a')));
        return json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a')), appliedCaptionVersion: 1 });
      };
      const again = await contributor();
      again.ui.button('Check earlier caption change').dispatch('click');
      await settle();
      assert.equal(posts(CAPTIONS_URL).length, 2, 'no duplicate save');
      assert.equal(storage.size, 0);
      assert.match(again.root.textContent, /saved as version 1/);
      again.view.dispose();
    });
  }
});

describe('an answer that does not confirm this save', () => {
  it('keeps the exact attempt and the typed text after a malformed or wrong-target 200, for saves and lookups', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    const answers = [
      json(200, { contribution: {}, appliedCaptionVersion: 1 }),
      json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a'), [], { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), appliedCaptionVersion: 1 }),
      json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a')), appliedCaptionVersion: 21 }),
      json(200, { contribution: contribution(), appliedCaptionVersion: 1 }),
    ];
    routes[`POST ${CAPTIONS_URL}`] = () => answers.shift();
    const { root, view, ui } = await contributor();
    ui.button('Add listening captions').dispatch('click');
    ui.textarea().value = 'A bell.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    for (let i = 0; i < 3; i += 1) {
      ui.button('Save again (same request)').dispatch('click');
      await settle();
    }
    const sent = posts(CAPTIONS_URL);
    assert.equal(sent.length, 4);
    assert.ok(sent.every((r) => JSON.stringify(r.body) === JSON.stringify(sent[0].body)), 'the same request each time');
    assert.equal(storage.get(PENDING_KEY), sent[0].body.requestId, 'still unconfirmed');
    assert.equal(ui.textarea().value, 'A bell.');
    assert.doesNotMatch(root.textContent, /saved as version/);
    view.dispose();

    // After a reload, a lookup answer about another contribution is not a receipt.
    routes[`GET ${CAPTIONS_URL}/requests/${OLD_ID}`] = () => json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a'), [], { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), appliedCaptionVersion: 1 });
    storage.set(PENDING_KEY, OLD_ID);
    const again = await contributor();
    again.ui.button('Check earlier caption change').dispatch('click');
    await settle();
    assert.equal(storage.get(PENDING_KEY), OLD_ID);
    assert.match(again.ui.notes(), /could not check your earlier caption change/);
    again.view.dispose();
  });
});

describe('after a reload', () => {
  it('only looks the earlier change up, and a new change gets a new ID', async () => {
    storage.set(PENDING_KEY, OLD_ID);
    routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(captions(1, 'A bell.', 'a')));
    const { root, view, ui } = await contributor();
    assert.match(ui.notes(), /An earlier caption change may not have reached Rehere/);
    assert.equal(ui.textarea().parent.parent.hidden, true, 'no editor to rebuild it from');
    ui.button('Check earlier caption change').dispatch('click');
    await settle();
    assert.deepEqual(requests.filter((r) => r.url.includes('/captions')).map((r) => `${r.method} ${r.url}`), [`GET ${CAPTIONS_URL}/requests/${OLD_ID}`]);
    assert.match(ui.notes(), /no record of your earlier caption change yet; it may still arrive/);
    assert.equal(storage.get(PENDING_KEY), OLD_ID, 'still unknown');
    ui.button('Start a new caption change instead').dispatch('click');
    assert.equal(storage.has(PENDING_KEY), false);
    assert.match(ui.notes(), /The earlier one may still have been saved/);
    assert.equal(ui.textarea().value, 'A bell.');
    ui.textarea().value = 'New words.';
    ui.confirm().checked = true;
    routes[`POST ${CAPTIONS_URL}`] = () => json(503, null);
    ui.button('Save listening captions').dispatch('click');
    await settle();
    const [sent] = posts(CAPTIONS_URL);
    assert.notEqual(sent.body.requestId, OLD_ID);
    assert.equal(storage.get(PENDING_KEY), sent.body.requestId);
    assert.ok(!root.textContent.includes(OLD_ID));
    view.dispose();
  });

  it('settles a found change that was saved before withdrawal without showing its text', async () => {
    storage.set(PENDING_KEY, OLD_ID);
    const redacted = contribution({ status: 'withdrawn', text: null, voice: null });
    routes[`GET ${JOB_URL}/collaboration`] = () => list(withCaptions(captions(1, 'A bell.', 'a')));
    routes[`GET ${CAPTIONS_URL}/requests/${OLD_ID}`] = () => {
      routes[`GET ${JOB_URL}/collaboration`] = () => list(redacted);
      return json(200, { contribution: redacted, appliedCaptionVersion: 2 });
    };
    const { root, view, ui } = await contributor();
    ui.button('Check earlier caption change').dispatch('click');
    await settle();
    assert.match(root.textContent, /saved before this recollection was withdrawn\. It is no longer shown or used\./);
    assert.equal(storage.size, 0);
    assert.equal(ui.button('Correct listening captions'), undefined);
    assert.doesNotMatch(root.textContent, /A bell|Previous captions/);
    view.dispose();
  });
});

describe('late answers', () => {
  it('a save answered after a place change draws nothing and its outcome stays unknown', async () => {
    let answer;
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution());
    routes[`GET ${B_URL}/collaboration`] = () => list();
    routes[`POST ${CAPTIONS_URL}`] = () => new Promise((resolve) => (answer = resolve));
    const { root, view, ui } = await contributor([PLACE, PLACE_B]);
    ui.button('Add listening captions').dispatch('click');
    ui.textarea().value = 'A bell.';
    ui.confirm().checked = true;
    ui.button('Save listening captions').dispatch('click');
    await settle();
    assert.equal(ui.button('Save again (same request)').disabled, true, 'no overlapping write');
    const placeSelect = ui.find((node) => node.tag === 'select')[0];
    placeSelect.value = `${B_DRAFT}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
    const bReads = () => requests.filter((r) => r.url === `${B_URL}/collaboration`).length;
    const before = bReads();
    answer(json(200, { contribution: withCaptions(captions(1, 'A bell.', 'a')), appliedCaptionVersion: 1 }));
    await settle();
    assert.equal(bReads(), before, 'the late answer redraws nothing in the new place');
    assert.doesNotMatch(root.textContent, /saved as version|A bell/);
    assert.equal(storage.get(PENDING_KEY), posts(CAPTIONS_URL)[0].body.requestId, 'the earlier place keeps only its unknown ID');
    view.dispose();
  });
});

describe('a withdrawn recollection', () => {
  it('drops the editor, its history and any unconfirmed caption ID', async () => {
    storage.set(PENDING_KEY, OLD_ID);
    routes[`GET ${JOB_URL}/collaboration`] = () => list(contribution({ status: 'withdrawn', text: null, voice: null }));
    const { root, view, ui } = await contributor();
    assert.equal(storage.size, 0);
    assert.equal(ui.button('Check earlier caption change'), undefined);
    assert.equal(ui.button('Add listening captions'), undefined);
    assert.doesNotMatch(root.textContent, /Previous captions/);
    view.dispose();
  });
});

describe('the owner’s view of caption versions', () => {
  it('tells one person’s recordings apart, names a review that saw other captions, and offers history but no editing', async () => {
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'];
    const take = (id, durationMs, voiceExtra, extra = {}) => contribution({ id, ...extra, voice: { ...contribution().voice, durationMs, ...voiceExtra } });
    routes[`GET ${JOB_URL}/collaboration`] = () =>
      list(
        take(ids[0], 4000, {}),
        take(ids[1], 61500, { captions: captions(2, 'The flour sacks stood by the window, and the bell over the door rang twice.', 'b'), captionHistory: [captions(1, 'Flour sacks.', 'a')] }),
        take(ids[2], 12000, { captions: captions(3, 'A bell.', 'c'), captionHistory: [captions(2, 'Two bells.', 'e'), captions(1, 'A bell.', 'd')] }, { status: 'alternative', review: { decision: 'alternative', captionBinding: 'changed' } }),
      );
    const { mountCollaboration } = await import('../public/collaboration.js');
    const root = new FakeElement('section');
    const b = { jobUrl: JOB_URL, editor: () => ({ version: 1, offset: [0, 0, 0], yaw: 0, clean: true }), showTransform: () => true, setLocked() {}, saved() {}, unconfirmed() {}, conflict() {}, blocked() {} };
    const view = mountCollaboration(root, b);
    await settle();
    const ui = finder(root);
    const lines = ui.find((node) => node.tag === 'p' && /^Recording included/.test(node.textContent)).map((node) => node.textContent);
    assert.equal(lines.length, 3);
    assert.equal(new Set(lines).size, 3, 'three distinct rows');
    assert.match(lines[0], /0:04\.0 long · No captions supplied\./);
    assert.match(lines[1], /1:01\.5 long · captions version 2: “The flour sacks stood by the window, and the bell over the…”/);
    assert.match(root.textContent, /The listening captions were added or corrected after this review\./);
    // A final decision has no Review button, yet its earlier captions stay inspectable.
    const rows = ui.find((node) => node.tag === 'li' && /^Mina/.test(node.textContent));
    const finalRow = rows[2];
    assert.match(finalRow.textContent, /The owner kept it as a separate alternative scene\./);
    assert.equal(finalRow.findAll((node) => node.tag === 'button' && node.textContent === 'Review').length, 0);
    assert.match(finalRow.textContent, /captions version 3: “A bell\.”/);
    assert.match(finalRow.textContent, /Previous captions \(2\)Version 2, written by Mina.*Two bells\.Version 1, written by Mina.*A bell\./s);
    assert.ok(!lines.join(' ').includes('b'.repeat(64)) && !lines.join(' ').includes(ids[1]), 'no hashes or IDs');
    ui.find((node) => node.tag === 'button' && node.textContent === 'Review')[1].dispatch('click');
    assert.match(root.textContent, /Captions version 2, written by Mina; not a transcript\./);
    assert.equal(root.textContent.match(/Previous captions \(1\)/g).length, 1, 'shown once, on its row, not again in the review form');
    assert.match(rows[1].textContent, /Version 1, written by Mina.*Flour sacks\./s);
    assert.equal(ui.button('Correct listening captions'), undefined, 'owners do not edit another person’s captions');
    view.dispose();
  });
});

describe('sharing a recording whose captions changed', () => {
  it('labels the version and clears a choice whose captions changed instead of carrying it over', async () => {
    let current = withCaptions(captions(1, 'A bell.', 'a'));
    routes[`GET ${JOB_URL}/collaboration`] = () => list(current);
    routes[`GET ${JOB_URL}/history`] = () => json(200, [{ version: 1, dependencies: [], blocked: false }]);
    routes[`GET ${JOB_URL}/stories`] = () => json(200, { stories: [] });
    routes[`GET ${JOB_URL}/shares`] = () => json(200, []);
    const { mountShares } = await import('../public/shares.js');
    const root = new FakeElement('section');
    const view = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 1 }), getCamera: () => null });
    await settle();
    const ui = finder(root);
    const set = () => ui.find((node) => node.tag === 'fieldset' && node.children[0]?.textContent === 'Contributor recordings to include (optional)')[0];
    assert.match(set().textContent, /Recording by Mina · 0:04\.0 long · captions version 1: “A bell\.”/);
    const include = set().findAll((node) => node.type === 'checkbox')[0];
    include.checked = true;
    include.dispatch('change');
    current = withCaptions(captions(2, 'Two bells.', 'b'), [captions(1, 'A bell.', 'a')]);
    view.refreshOptions();
    await settle();
    assert.match(set().textContent, /captions version 2: “Two bells\.”/);
    assert.equal(set().findAll((node) => node.type === 'checkbox')[0].checked, false, 'not chosen again automatically');
    assert.match(ui.notes(), /The captions of a chosen recording changed, so it is no longer chosen/);
    assert.doesNotMatch(set().textContent, /A bell/, 'no earlier version offered');
    view.dispose();
  });
});

describe('a corrected recording for visitors', () => {
  it('shows the caption version and that the contributor corrected it, without history', async () => {
    const { mountVisitor } = await import('../public/visits.js');
    const view = (id, label) => ({
      id,
      label,
      edit: { offset: [0, 0, 0], yaw: 0 },
      era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null },
      evidence: { photo: null, geometry: 'model estimate', recollections: [], support: [] },
    });
    const manifest = {
      id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
      title: 'Corner shop, synthetic',
      createdAt: '2026-10-31T00:00:00.000Z',
      synthetic: true,
      startViewId: 'v1',
      camera: { position: [0, 0, 0], target: [0, 0, -3] },
      views: [view('v1', 'Saved scene')],
      contributorRecordings: [
        { id: 'r-1', viewIds: ['v1'], target: { id: 'place', label: 'About this place' }, title: 'Contributor recording', label: 'Contributor recording; human-written listening captions; not verified history.', providerLabel: 'Mina', captionAuthorLabel: 'Mina', captionVersion: 2, cues: [{ startMs: 0, endMs: 4000, text: 'Two bells.' }], durationMs: 4000, audio: { type: 'audio/wav', size: 60 } },
      ],
    };
    const source = {
      manifest: async () => manifest,
      check: async () => true,
      asset: async (viewId, name) => (name === 'surface.json' ? json(200, visitorSurface()) : { ok: true, status: 200, blob: async () => new Blob(['jpeg']) }),
      storyAudio: async () => null,
      recordingAudio: async () => null,
    };
    globalThis.viewerLog = [];
    const root = new FakeElement('div');
    const visitor = mountVisitor(root, source);
    try {
      await settle();
      assert.match(root.textContent, /Listening captions, version 2, corrected by the contributor; written by Mina; not a transcript\./);
      assert.doesNotMatch(root.textContent, /Previous captions/);
    } finally {
      visitor.dispose();
    }
  });
});
