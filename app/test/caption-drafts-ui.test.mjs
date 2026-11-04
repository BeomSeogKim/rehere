import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

installViewerShim();
const { captionCredit, draftCallEvidence, mountStories } = await import('../public/stories.js');
const { createStoryPlayer } = await import('../public/story-player.js');

const JOB_URL = '/api/drafts/11111111-1111-4111-8111-111111111111/reconstructions/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRAFTS_URL = `${JOB_URL}/stories/caption-drafts`;
const VOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DRAFT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ASK = 'Draft captions with Muse Voice Transcribe';
const SEND = 'Send the recording for a draft';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const voice = (model = true) => ({ id: VOICE, kind: 'voice', provider: 'Owner', permissions: { place: true, model, share: false }, policy: { revision: 0, stopped: false } });
const CALL = {
  model: 'muse-voice-transcribe-1.0', dispatched: true, httpStatus: 200, providerRequestId: null, providerSessionId: 'fixture-session-1',
  latencyMs: 3115, admittedDurationMs: 2000, estimatedUsd: 0.0001,
};
const draftAnswer = ({ id = DRAFT_ID, call = CALL } = {}) => json(201, {
  draft: {
    id, model: 'muse-voice-transcribe-1.0', modelLabel: 'Muse Voice Transcribe', voiceSourceId: VOICE, voiceSha256: 'a'.repeat(64),
    view: { kind: 'version', version: 1, variantId: null, eraRevision: null }, durationMs: 2000, confirmed: false,
    cues: [{ startMs: 0, endMs: 1200, text: 'Synthetic fixture speech.' }, { startMs: 1400, endMs: 2000, text: 'Second part.' }],
    call,
  },
});

let requests;
let routes;

before(() => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    const handler = routes[`${options.method ?? 'GET'} ${url}`];
    return handler ? handler(body) : Promise.resolve(json(404, { error: 'Not found.' }));
  };
});

after(() => {
  delete globalThis.document;
  delete globalThis.fetch;
});

beforeEach(() => {
  requests = [];
  routes = {
    [`GET ${JOB_URL}/stories`]: () => Promise.resolve(json(200, { stories: [] })),
    [`GET ${JOB_URL}/history`]: () => Promise.resolve(json(200, [{ version: 1, blocked: false }, { version: 2, blocked: false }])),
    [`GET ${JOB_URL}/collaboration`]: () => Promise.resolve(json(200, { variants: [] })),
  };
});

async function mount({ sources = [voice()], objects } = {}) {
  const root = new FakeElement('div');
  const view = mountStories(root, { jobUrl: JOB_URL, sources, editor: () => ({ version: 2 }), durationHintMs: () => 2000, objects });
  await settle();
  const find = (predicate) => root.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const viewSelect = () => find((node) => node.tag === 'select')[1];
  const rows = () => find((node) => node.className === 'story-cue-row');
  const cueTexts = () => rows().map((row) => row.findAll((node) => node.tag === 'textarea')[0].value);
  const confirm = () => find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
  const note = () => find((node) => node.role === 'status' && node.tag === 'p').map((node) => node.textContent).join(' ');
  const evidence = () => {
    const block = find((node) => node.className === 'model-evidence')[0];
    return block.hidden ? null : block.textContent;
  };
  const chooseView = (key) => {
    viewSelect().value = key;
    viewSelect().dispatch('change');
  };
  const requestDraft = () => {
    button(ASK).dispatch('click');
    button(SEND).dispatch('click');
  };
  return { root, view, find, button, rows, cueTexts, confirm, note, evidence, chooseView, requestDraft };
}

const draftPosts = () => requests.filter((r) => r.method === 'POST' && r.url === DRAFTS_URL);
const storyPosts = () => requests.filter((r) => r.method === 'POST' && r.url === `${JOB_URL}/stories`);

describe('caption draft composer', () => {
  it('is offered only for a whole recording whose provider allowed model processing', async () => {
    const without = await mount({ sources: [voice(false)] });
    assert.equal(without.button(ASK).hidden, true);
    without.view.dispose();
    const ui = await mount();
    assert.equal(ui.button(ASK).hidden, false);
    const [whole, excerpt] = ui.find((node) => node.type === 'radio');
    whole.checked = false;
    excerpt.checked = true;
    excerpt.dispatch('change');
    assert.equal(ui.button(ASK).hidden, true);
  });

  it('sends only after an explicit confirmation, applies unconfirmed cues and credits the draft on save', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    const ui = await mount();
    ui.chooseView('version:1');
    ui.button(ASK).dispatch('click');
    assert.equal(draftPosts().length, 0, 'asking shows what is sent, nothing more');
    ui.confirm().checked = true;
    ui.button(SEND).dispatch('click');
    await settle();
    const [sent] = draftPosts();
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, voiceSourceId: VOICE, view: { kind: 'version', version: 1, variantId: null, eraRevision: null } });
    assert.deepEqual(ui.cueTexts(), ['Synthetic fixture speech.', 'Second part.']);
    assert.equal(ui.confirm().checked, false, 'a draft is never pre-confirmed');
    assert.match(ui.note(), /may be wrong/);

    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Morning bell';
    ui.confirm().checked = true;
    routes[`POST ${JOB_URL}/stories`] = () => Promise.reject(new TypeError('network'));
    ui.button('Save story').dispatch('click');
    await settle();
    const [first] = storyPosts();
    assert.equal(first.body.captionDraftId, DRAFT_ID);
    assert.deepEqual(first.body.cues, [{ startMs: 0, endMs: 1200, text: 'Synthetic fixture speech.' }, { startMs: 1400, endMs: 2000, text: 'Second part.' }]);
    // An unresolved save repeats exactly the original body, draft included.
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, {}));
    ui.button('Retry the earlier save').dispatch('click');
    await settle();
    assert.deepEqual(storyPosts()[1].body, first.body);
  });

  it('asks for confirmation again after any edit to drafted captions', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    ui.confirm().checked = true;
    const text = ui.rows()[0].findAll((node) => node.tag === 'textarea')[0];
    text.value = 'Corrected by the owner.';
    text.dispatch('input');
    assert.equal(ui.confirm().checked, false);
    ui.confirm().checked = true;
    ui.button('Add a caption').dispatch('click');
    assert.equal(ui.confirm().checked, false);
  });

  it('never applies a late draft over caption edits made while it was pending', async () => {
    const answer = deferred();
    routes[`POST ${DRAFTS_URL}`] = () => answer.promise;
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    assert.equal(ui.button(ASK).disabled, true, 'one request at a time');
    const text = ui.rows()[0].findAll((node) => node.tag === 'textarea')[0];
    text.value = 'Written by hand meanwhile.';
    answer.resolve(draftAnswer());
    await settle();
    assert.deepEqual(ui.cueTexts(), ['Written by hand meanwhile.']);
    assert.match(ui.note(), /was not applied/);
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Morning bell';
    ui.rows()[0].findAll((node) => node.tag === 'input').forEach((input, index) => { input.value = ['0:00', '0:01.0'][index]; });
    ui.confirm().checked = true;
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, {}));
    ui.button('Save story').dispatch('click');
    await settle();
    assert.equal(Object.hasOwn(storyPosts()[0].body, 'captionDraftId'), false);
  });

  it('never applies a late draft after the view or recording part changed', async () => {
    const answer = deferred();
    routes[`POST ${DRAFTS_URL}`] = () => answer.promise;
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    ui.chooseView('version:2');
    answer.resolve(draftAnswer());
    await settle();
    assert.deepEqual(ui.cueTexts(), ['']);
    assert.match(ui.note(), /was not applied/);
  });

  it('never saves drafted captions as the owner’s own after the choices change', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, {}));
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Morning bell';
    ui.chooseView('version:2');
    assert.match(ui.note(), /AI draft of a different recording, view, part or object/);
    ui.confirm().checked = true;
    ui.button('Save story').dispatch('click');
    await settle();
    assert.equal(storyPosts().length, 0);
    assert.match(ui.find((node) => node.className === 'form-message')[0].textContent, /discard them, before saving/);

    // Returning to the draft's choices restores its credit.
    ui.chooseView('version:1');
    ui.confirm().checked = true;
    ui.button('Save story').dispatch('click');
    await settle();
    assert.equal(storyPosts()[0].body.captionDraftId, DRAFT_ID);
  });

  it('discards drafted captions explicitly, leaving an empty caption to write by hand', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    ui.chooseView('version:2');
    ui.button('Discard the AI-drafted captions').dispatch('click');
    assert.deepEqual(ui.cueTexts(), ['']);
    assert.equal(ui.button('Discard the AI-drafted captions').hidden, true);
    const row = ui.rows()[0];
    row.findAll((node) => node.tag === 'input').forEach((input, index) => { input.value = ['0:00', '0:01.0'][index]; });
    row.findAll((node) => node.tag === 'textarea')[0].value = 'Written by hand.';
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Morning bell';
    ui.confirm().checked = true;
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, {}));
    ui.button('Save story').dispatch('click');
    await settle();
    assert.equal(Object.hasOwn(storyPosts()[0].body, 'captionDraftId'), false);
  });

  it('never applies a late draft after a change that was later undone', async () => {
    for (const change of [
      (ui) => { ui.chooseView('version:2'); ui.chooseView('version:1'); },
      (ui) => {
        const text = ui.rows()[0].findAll((node) => node.tag === 'textarea')[0];
        text.value = 'typed';
        text.dispatch('input');
        text.value = '';
        text.dispatch('input');
      },
    ]) {
      const answer = deferred();
      routes[`POST ${DRAFTS_URL}`] = () => answer.promise;
      const ui = await mount();
      ui.chooseView('version:1');
      ui.requestDraft();
      await settle();
      change(ui);
      answer.resolve(draftAnswer());
      await settle();
      assert.deepEqual(ui.cueTexts(), ['']);
      assert.match(ui.note(), /was not applied/);
      ui.view.dispose();
    }
  });

  it('admits one draft request even when the send control fires twice', async () => {
    const answer = deferred();
    routes[`POST ${DRAFTS_URL}`] = () => answer.promise;
    const ui = await mount();
    ui.chooseView('version:1');
    ui.button(ASK).dispatch('click');
    const send = ui.button(SEND);
    send.dispatch('click');
    send.dispatch('click');
    answer.resolve(draftAnswer());
    await settle();
    assert.equal(draftPosts().length, 1);
  });

  it('labels a drafted story’s captions as AI-drafted in the player', () => {
    const story = { id: 's', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic fixture speech.' }], durationMs: 1000 };
    const text = (item) => createStoryPlayer({ story: item, fetchAudio: () => Promise.reject(new Error('unused')) }).element.textContent;
    assert.match(text({ ...story, captionDraft: { model: 'muse-voice-transcribe-1.0', label: 'Muse Voice Transcribe' } }), /Captions \(AI-drafted, then reviewed by a person; not checked by Rehere\):/);
    assert.doesNotMatch(text({ ...story, captionDraft: { model: 'muse-voice-transcribe-1.0', label: 'Muse Voice Transcribe' } }), /written by a person/);
    assert.match(text(story), /Captions \(written by a person, not checked by Rehere\):/);
  });

  it('ignores an answer that arrives after the composer closed', async () => {
    const answer = deferred();
    routes[`POST ${DRAFTS_URL}`] = () => answer.promise;
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    ui.view.dispose();
    answer.resolve(draftAnswer());
    await settle();
    assert.equal(ui.root.children.length, 0);
  });

  it('repeats the same request ID after an unknown outcome, and a fresh one after a known failure', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.reject(new TypeError('network'));
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    assert.match(ui.note(), /never sent to the model twice/);
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(json(422, { error: 'No speech was recognized in this recording. Write the captions yourself.' }));
    ui.requestDraft();
    await settle();
    assert.match(ui.note(), /No speech was recognized/);
    ui.requestDraft();
    await settle();
    const [first, second, third] = draftPosts();
    assert.equal(second.body.requestId, first.body.requestId);
    assert.notEqual(third.body.requestId, first.body.requestId);
  });

  it('binds a two-object draft to the chosen object and drops its credit when the object changes', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    const ui = await mount({ objects: [{ id: 'object-1', name: 'Counter' }, { id: 'object-2', name: 'Flour stack' }] });
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    assert.equal(draftPosts().length, 0);
    assert.match(ui.note(), /saved view and object first/);
    const target = ui.find((node) => node.tag === 'select')[2];
    target.value = 'object-1';
    target.dispatch('change');
    ui.requestDraft();
    await settle();
    assert.equal(draftPosts()[0].body.targetId, 'object-1');
    target.value = 'object-2';
    target.dispatch('change');
    assert.match(ui.note(), /AI draft of a different recording, view, part or object/);
  });

  it('shows the applied draft’s call evidence, naming IDs that were not returned', async () => {
    const answer = deferred();
    routes[`POST ${DRAFTS_URL}`] = () => answer.promise;
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    assert.equal(ui.evidence(), null, 'nothing while pending');
    answer.resolve(draftAnswer());
    await settle();
    const text = ui.evidence();
    assert.match(text, /Live answer from muse-voice-transcribe-1\.0/);
    assert.match(text, /HTTP 200 · 3,115 ms/);
    assert.match(text, /Provider request ID: not returned · Provider session ID: fixture-session-1/);
    assert.match(text, /Audio sent: 2,000 ms · Estimated cost \$0\.00010 \(an estimate, not the bill\)/);
    assert.deepEqual(draftCallEvidence({ call: { ...CALL, providerSessionId: null, latencyMs: undefined, estimatedUsd: undefined } }).lines.slice(0, 3), [
      'Sent once to the Meta Model API · HTTP 200 · latency not recorded',
      'Provider request ID: not returned · Provider session ID: not returned',
      'Audio sent: 2,000 ms',
    ]);
    assert.equal(draftCallEvidence({ call: { ...CALL, dispatched: false } }), null);
    assert.equal(draftCallEvidence({}), null);
  });

  it('hides call evidence while the draft does not apply, and clears it when discarded', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    assert.ok(ui.evidence());
    ui.chooseView('version:2');
    assert.equal(ui.evidence(), null);
    assert.deepEqual(ui.cueTexts(), ['Synthetic fixture speech.', 'Second part.'], 'AI cues stay, still blocked from saving');
    ui.chooseView('version:1');
    assert.match(ui.evidence(), /fixture-session-1/);
    ui.button('Discard the AI-drafted captions').dispatch('click');
    assert.equal(ui.evidence(), null);
  });

  it('keeps the earlier draft and its evidence when a later answer arrives after an undone change', async () => {
    routes[`POST ${DRAFTS_URL}`] = () => Promise.resolve(draftAnswer());
    const ui = await mount();
    ui.chooseView('version:1');
    ui.requestDraft();
    await settle();
    const late = deferred();
    routes[`POST ${DRAFTS_URL}`] = () => late.promise;
    ui.requestDraft();
    await settle();
    assert.equal(ui.evidence(), null, 'stale evidence is cleared while a new request is pending');
    ui.chooseView('version:2');
    ui.chooseView('version:1');
    late.resolve(draftAnswer({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', call: { ...CALL, providerSessionId: 'fixture-session-2' } }));
    await settle();
    assert.match(ui.note(), /was not applied/);
    assert.deepEqual(ui.cueTexts(), ['Synthetic fixture speech.', 'Second part.']);
    assert.match(ui.evidence(), /fixture-session-1/);
    assert.doesNotMatch(ui.evidence(), /fixture-session-2/);
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Morning bell';
    ui.confirm().checked = true;
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, {}));
    ui.button('Save story').dispatch('click');
    await settle();
    assert.equal(storyPosts()[0].body.captionDraftId, DRAFT_ID);
  });

  it('credits AI drafting and the reviewing owner in saved stories', async () => {
    assert.equal(captionCredit(null, 'Owner'), 'Captions written by Owner');
    assert.equal(captionCredit({ model: 'muse-voice-transcribe-1.0', label: 'Muse Voice Transcribe' }, 'Owner'), 'Captions AI-drafted (Muse Voice Transcribe), reviewed by Owner');
  });
});
