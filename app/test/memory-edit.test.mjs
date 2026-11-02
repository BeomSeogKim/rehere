import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { formatTransform, historyLabel, mountMemoryEdit, proposalBlockedReason, proposalStatusText } from '../public/memory-edit.js';

const JOB_URL = '/api/drafts/11111111-1111-4111-8111-111111111111/reconstructions/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROPOSAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const publicSource = { kind: 'photo', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: false } };

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => ({ status: 0, ok: false, json: async () => null });
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function proposal(overrides = {}) {
  return {
    id: PROPOSAL_ID,
    requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    baseVersion: 1,
    statement: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'human_memory', text: 'The counter faced the window.', sha256: 'a'.repeat(64), modelConsent: true },
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    status: 'ready',
    result: {
      action: 'rotate',
      targetId: 'selected-foreground',
      sourceId: 'src',
      baseVersion: 1,
      delta: null,
      yawDelta: Math.PI / 4,
      anchor: null,
      question: null,
      reason: 'The memory says the counter turned toward the window.',
      transform: { offset: [0, 0, 0], yaw: Math.PI / 4 },
    },
    question: null,
    error: null,
    model: 'muse-spark-1.3',
    usage: { inputTokens: 900, outputTokens: 120, estimatedUsd: 0.0016 },
    responseId: null,
    appliedVersion: null,
    ...overrides,
  };
}

let posts;
let state;

before(() => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      let respond;
      const promise = new Promise((resolve) => (respond = resolve));
      posts.push({ url, body: JSON.parse(options.body), respond });
      return promise;
    }
    if (url === `${JOB_URL}/proposals`) return state.listGet ? state.listGet() : json(200, state.proposals);
    if (url === `${JOB_URL}/history`) return json(200, state.history);
    if (url === `${JOB_URL}/proposals/${PROPOSAL_ID}`) return state.proposalGet();
    if (state.byUrl?.[url]) return state.byUrl[url]();
    return json(404, { error: 'Not found.' });
  };
});

after(() => {
  delete globalThis.document;
  delete globalThis.fetch;
});

beforeEach(() => {
  posts = [];
  state = {
    proposals: [],
    history: [{ version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial' }],
    proposalGet: () => json(200, proposal()),
  };
});

function mount({ source = publicSource, editor = { version: 1, offset: [0, 0, 0], yaw: 0, clean: true }, extra = {} } = {}) {
  const calls = [];
  const bridge = {
    jobUrl: JOB_URL,
    textureUrl: `${JOB_URL}/assets/texture.jpg`,
    source,
    editorState: { ...editor },
    editor: () => ({ ...bridge.editorState }),
    guide: { readable: true, aligned: true },
    showTransform: (transform) => {
      calls.push(['showTransform', transform]);
      return transform ? bridge.guide : null;
    },
    setLocked: (value) => calls.push(['setLocked', value]),
    saved: (edit) => {
      calls.push(['saved', edit]);
      bridge.editorState = { ...edit, clean: true };
    },
    unconfirmed: () => {
      calls.push(['unconfirmed']);
      bridge.editorState.clean = false;
    },
    conflict: () => {
      calls.push(['conflict']);
      bridge.editorState.clean = false;
    },
    ...extra,
  };
  const container = new FakeElement('section');
  const handle = mountMemoryEdit(container, bridge);
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const text = () => find((node) => node.tag === 'textarea')[0];
  const consent = () => find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
  const write = (value) => {
    text().value = value;
    text().dispatch('input');
  };
  const agree = () => {
    consent().checked = true;
    consent().dispatch('change');
  };
  const message = () => find((node) => node.className === 'form-message')[0].textContent;
  return { handle, bridge, calls, container, find, button, text, consent, write, agree, message };
}

describe('proposal helpers', () => {
  it('requires both grants and a public source, without implying either grant', () => {
    assert.equal(proposalBlockedReason(publicSource), null);
    assert.match(proposalBlockedReason(null), /no uses were granted/);
    assert.match(proposalBlockedReason({ ...publicSource, permissions: { place: true, model: false, share: true } }), /model processing/);
    assert.match(proposalBlockedReason({ ...publicSource, origin: { kind: 'own', reference: '' } }), /public source/);
  });

  it('describes states without claiming a save before it happens', () => {
    assert.match(proposalStatusText({ status: 'ready' }), /Nothing has changed yet/);
    assert.match(proposalStatusText({ status: 'failed', error: 'The model service is not set up.' }), /not set up/);
    assert.match(proposalStatusText({ status: 'applied', appliedVersion: 3 }), /version 3/);
    assert.match(proposalStatusText({ status: 'interrupted' }), /cost already counted/);
    assert.equal(historyLabel({ kind: 'undo', targetVersion: 2 }), 'Return to version 2');
    assert.equal(historyLabel({ kind: 'contribution' }), 'Change from a recollection');
    assert.equal(formatTransform({ offset: [0.5, 0, -0.25], yaw: Math.PI / 2 }), 'left/right 0.50, down/up 0.00, away/toward -0.25, turn 90°');
  });
});

describe('memory proposal panel', () => {
  it('offers no planning for a private or ungranted source', async () => {
    const view = mount({ source: { ...publicSource, origin: { kind: 'own', reference: '' } } });
    await settle();
    assert.equal(view.text(), undefined);
    assert.equal(view.button('Plan a change'), undefined);
    assert.match(view.container.textContent, /only photos saved as a public source/);
    view.handle.dispose();
  });

  it('plans only with text, explicit consent and a clean manual editor, sending the raw text', async () => {
    const view = mount({ editor: { version: 1, offset: [0, 0, 0], yaw: 0, clean: false } });
    await settle();
    view.write('  The counter faced the window.\n');
    view.agree();
    assert.equal(view.button('Plan a change').disabled, true);
    assert.match(view.container.textContent, /Save or revert your manual change/);
    view.bridge.editorState.clean = true;
    view.handle.sync();
    assert.equal(view.button('Plan a change').disabled, false);

    view.button('Plan a change').dispatch('click');
    assert.equal(posts[0].url, `${JOB_URL}/proposals`);
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['baseVersion', 'consent', 'requestId', 'text']);
    assert.equal(posts[0].body.text, '  The counter faced the window.\n');
    assert.equal(posts[0].body.consent, true);
    assert.equal(posts[0].body.baseVersion, 1);
    view.handle.dispose();
  });

  it('keeps the message and reuses the request ID after an unconfirmed plan request, not after a refusal', async () => {
    const view = mount();
    await settle();
    view.write('Turn it toward the door.');
    view.agree();
    view.button('Plan a change').dispatch('click');
    posts[0].respond(lost());
    await settle();
    assert.match(view.message(), /could not confirm whether your memory was received/);
    assert.equal(view.text().value, 'Turn it toward the door.');
    view.button('Plan a change').dispatch('click');
    assert.equal(posts[1].body.requestId, posts[0].body.requestId);

    posts[1].respond(json(403, { error: 'Planning is not set up on this server.' }));
    await settle();
    assert.match(view.message(), /not set up on this server/);
    view.button('Plan a change').dispatch('click');
    assert.notEqual(posts[2].body.requestId, posts[0].body.requestId);
    view.handle.dispose();
  });

  it('shows the server’s reason for a 503 and keeps the raw message for a safe retry', async () => {
    const view = mount();
    await settle();
    const raw = '  The counter faced the window.\n';
    view.write(raw);
    view.agree();
    view.button('Plan a change').dispatch('click');
    const reason = 'Memory-based editing with the hosted model is not set up on this server.';
    posts[0].respond(json(503, { error: reason }));
    await settle();
    assert.ok(view.message().startsWith(reason));
    assert.match(view.message(), /repeats the same request and will not send it twice/);
    assert.equal(view.text().value, raw);
    view.button('Plan a change').dispatch('click');
    assert.equal(posts[1].body.requestId, posts[0].body.requestId);
    assert.equal(posts[1].body.text, raw);

    posts[1].respond(json(503, { error: '   ' }));
    await settle();
    assert.match(view.message(), /^Rehere could not confirm whether your memory was received/);
    view.handle.dispose();
  });

  it('shows a server reason alongside an unconfirmed apply', async () => {
    state.proposals = [proposal()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    posts[0].respond(json(503, { error: 'Saving is temporarily unavailable.' }));
    await settle();
    assert.match(view.message(), /^Saving is temporarily unavailable\. Rehere could not confirm whether the proposal was applied/);
    assert.ok(view.calls.some(([name]) => name === 'unconfirmed'));
    view.handle.dispose();
  });

  it('polls an accepted proposal, then shows it as a preview that is not saved', async () => {
    const view = mount();
    await settle();
    view.write('The counter faced the window.');
    view.agree();
    view.button('Plan a change').dispatch('click');
    // As on the server: the accepted proposal is listed, and each later state is newer.
    state.proposalGet = () => json(200, proposal({ status: 'processing', result: null, model: null, usage: null, updatedAt: '2026-10-31T00:00:01.000Z' }));
    state.proposals = [proposal({ status: 'queued', result: null, model: null, usage: null })];
    posts[0].respond(json(202, proposal({ status: 'queued', result: null, model: null, usage: null })));
    await settle();
    assert.match(view.container.textContent, /Meta is reading your memory/);
    assert.ok(view.button('Cancel planning'));
    state.proposalGet = () => json(200, proposal({ updatedAt: '2026-10-31T00:00:02.000Z' }));

    await new Promise((resolve) => setTimeout(resolve, 2100));
    await settle();
    const textNow = view.container.textContent;
    assert.match(textNow, /A change is proposed\. Nothing has changed yet\./);
    assert.match(textNow, /Your memory: “The counter faced the window\.”/);
    assert.match(textNow, /Proposal \(AI suggestion\): Turn the selected object/);
    assert.match(textNow, /After this change: .*turn 45°/);
    assert.match(textNow, /an estimate, not the bill/);
    assert.equal(view.button('Apply and save this proposal').disabled, true, 'apply needs a preview first');
    assert.ok(!view.calls.some(([name]) => name === 'saved'));
    view.handle.dispose();
  });

  it('applies through the server and hands the confirmed edit to the manual editor', async () => {
    state.proposals = [proposal()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    assert.deepEqual(view.calls.slice(-2), [['showTransform', { offset: [0, 0, 0], yaw: Math.PI / 4 }], ['setLocked', true]]);
    view.button('Apply and save this proposal').dispatch('click');
    assert.deepEqual(posts[0].body, { requestId: posts[0].body.requestId, baseVersion: 1, frontConfirmed: false });
    assert.ok(!view.calls.some(([name]) => name === 'saved'), 'nothing is saved before the response');

    const edit = { version: 2, offset: [0, 0, 0], yaw: Math.PI / 4 };
    state.proposals = [proposal({ status: 'applied', appliedVersion: 2 })];
    state.history.push({ version: 2, ...edit, kind: 'proposal', proposalId: PROPOSAL_ID });
    posts[0].respond(json(200, { edit, proposal: state.proposals[0] }));
    await settle();
    assert.deepEqual(view.calls.find(([name]) => name === 'saved')[1], edit);
    assert.ok(view.calls.some(([name, value]) => name === 'showTransform' && value === null));
    assert.deepEqual(view.calls.at(-1), ['setLocked', false]);
    assert.match(view.container.textContent, /Version 2 \(current\): Change from a memory/);
    assert.match(view.container.textContent, /AI suggestion: The memory says/);
    const count = (text) => view.container.textContent.split(text).length - 1;
    const live = view.find((node) => node.role === 'status' && node.parent === view.container)[0];
    assert.equal(live.textContent, 'Saved new arrangement version 2.', 'the live status confirms the save once');
    assert.equal(count('Saved new arrangement version 2.'), 1);
    assert.equal(count('This proposal was applied as version 2.'), 1, 'the review is a receipt, not a second confirmation');
    assert.doesNotMatch(view.container.textContent, /Applied and saved as version/);

    view.button('Return to version 1').dispatch('click');
    assert.deepEqual(posts[1].body, { requestId: posts[1].body.requestId, baseVersion: 2, targetVersion: 1 });
    state.history.push({ version: 3, offset: [0, 0, 0], yaw: 0, kind: 'undo', targetVersion: 1 });
    posts[1].respond(json(200, { version: 3, offset: [0, 0, 0], yaw: 0 }));
    await settle();
    assert.match(live.textContent, /^Returned to the position of version 1, saved as version 3\./);
    assert.match(view.container.textContent, /This proposal was applied as version 2\. The saved scene is now version 3\./);
    assert.doesNotMatch(view.container.textContent, /Applied and saved as version 2|Saved new arrangement version 2/, 'no stale confirmation reads as current');
    view.handle.dispose();
  });

  it('reports an unconfirmed apply to the manual editor and retries with the same request', async () => {
    state.proposals = [proposal()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    posts[0].respond(lost());
    await settle();
    assert.ok(view.calls.some(([name]) => name === 'unconfirmed'));
    assert.ok(!view.calls.some(([name]) => name === 'saved'));
    assert.match(view.message(), /could not confirm whether the proposal was applied/);
    assert.equal(view.button('Preview on the scene').disabled, true, 'reconcile first');

    view.bridge.editorState.clean = true;
    view.handle.sync();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    assert.deepEqual(posts[1].body, posts[0].body);
    view.handle.dispose();
  });

  const faceAnchor = () =>
    proposal({
      result: {
        ...proposal().result,
        action: 'face_anchor',
        yawDelta: null,
        anchor: { label: 'window <b>', point: [0.25, 0.75] },
        transform: { offset: [0, 0, 0], yaw: 1 },
      },
    });

  it('labels a face-anchor proposal as turning the photographed side and marks the source point', async () => {
    state.proposals = [faceAnchor()];
    const view = mount();
    await settle();
    const marker = view.find((node) => node.className === 'anchor-marker')[0];
    assert.deepEqual([marker.style.left, marker.style.top], ['25%', '75%']);
    const textNow = view.container.textContent;
    assert.match(textNow, /Turn the side of the selected object seen in the photo toward “window <b>”/);
    assert.match(textNow, /not necessarily the object’s real front/);
    assert.doesNotMatch(textNow, /is its front/);
    assert.equal(view.find((node) => node.tag === 'b').length, 0);
    view.handle.dispose();
  });

  it('requires confirming the drawn arrow and line before a face-anchor apply', async () => {
    state.proposals = [faceAnchor()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    assert.match(view.container.textContent, /yellow arrow points along the level blue line/);
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    const confirm = view.find((node) => node.tag === 'input' && node.type === 'checkbox').at(-1);
    confirm.checked = true;
    confirm.dispatch('change');
    view.handle.sync();
    view.button('Apply and save this proposal').dispatch('click');
    assert.equal(posts[0].body.frontConfirmed, true);
    view.handle.dispose();
  });

  for (const [name, guide, pattern] of [
    ['no 3D view', null, /3D preview is not available/],
    ['a target too close to show', { readable: false, aligned: false }, /too close to the object/],
    ['an arrow that misses the target', { readable: true, aligned: false }, /does not point at the marked point/],
  ]) {
    it(`blocks a face-anchor apply with ${name}`, async () => {
      state.proposals = [faceAnchor()];
      const view = mount();
      view.bridge.guide = guide;
      await settle();
      view.button('Preview on the scene').dispatch('click');
      assert.match(view.container.textContent, pattern);
      assert.doesNotMatch(view.container.textContent, /I checked the scene/);
      assert.equal(view.button('Apply and save this proposal').disabled, true);
      view.button('Apply and save this proposal').dispatch('click');
      assert.equal(posts.length, 0);
      view.handle.dispose();
    });
  }

  it('marks a conflicting apply as reload-required and saves nothing', async () => {
    state.proposals = [proposal()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    state.proposals = [proposal({ status: 'stale' })];
    posts[0].respond(json(409, { error: 'The scene changed after this proposal.' }));
    await settle();
    assert.ok(view.calls.some(([name]) => name === 'conflict'));
    assert.ok(!view.calls.some(([name]) => name === 'saved'));
    assert.match(view.message(), /changed after this proposal\. Nothing was changed/);
    assert.match(view.container.textContent, /older saved version/);
    view.handle.dispose();
  });

  it('does not offer to apply a proposal made for another saved version', async () => {
    state.proposals = [proposal({ baseVersion: 1 })];
    const view = mount({ editor: { version: 2, offset: [0, 0, 0], yaw: 0, clean: true } });
    await settle();
    assert.equal(view.button('Apply and save this proposal'), undefined);
    assert.match(view.container.textContent, /made for version 1, but the saved position is now version 2/);
    view.handle.dispose();
  });

  it('shows a clarification question as text and keeps the message for refining', async () => {
    state.proposals = [proposal({ status: 'clarify', result: null, question: 'Which <i>window</i> do you mean?' })];
    const view = mount();
    await settle();
    view.write('The counter faced the window.');
    assert.match(view.container.textContent, /Meta asks: Which <i>window<\/i> do you mean\?/);
    assert.equal(view.find((node) => node.tag === 'i').length, 0);
    assert.equal(view.button('Apply and save this proposal'), undefined);
    assert.equal(view.text().value, 'The counter faced the window.');
    view.handle.dispose();
  });

  it('cancels only when the server acknowledges it', async () => {
    state.proposals = [proposal({ status: 'processing', result: null })];
    state.proposalGet = () => json(200, proposal({ status: 'processing', result: null }));
    const view = mount();
    await settle();
    view.button('Cancel planning').dispatch('click');
    posts[0].respond(lost());
    await settle();
    assert.match(view.message(), /could not confirm the cancel/);
    assert.doesNotMatch(view.container.textContent, /Canceled\./);
    view.button('Cancel planning').dispatch('click');
    assert.equal(posts[1].body.requestId, posts[0].body.requestId);
    state.proposals = [proposal({ status: 'canceled', result: null })];
    posts[1].respond(json(200, proposal({ status: 'canceled', result: null })));
    await settle();
    assert.match(view.container.textContent, /Canceled\. Nothing was changed\./);
    view.handle.dispose();
  });

  it('returns to an earlier version as a new saved version and keeps the history', async () => {
    state.history = [
      { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial' },
      { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'manual' },
    ];
    const view = mount({ editor: { version: 2, offset: [1, 0, 0], yaw: 0, clean: true } });
    await settle();
    assert.equal(view.button('Return to version 2'), undefined, 'the current version has no undo');
    view.button('Return to version 1').dispatch('click');
    assert.deepEqual(posts[0].body, { requestId: posts[0].body.requestId, baseVersion: 2, targetVersion: 1 });
    const edit = { version: 3, offset: [0, 0, 0], yaw: 0 };
    state.history.push({ ...edit, kind: 'undo', targetVersion: 1 });
    posts[0].respond(json(200, edit));
    await settle();
    assert.deepEqual(view.calls.find(([name]) => name === 'saved')[1], edit);
    const textNow = view.container.textContent;
    assert.match(textNow, /Version 3 \(current\): Return to version 1/);
    assert.match(textNow, /Version 2: Manual change/);
    assert.match(textNow, /Earlier versions are kept/);
    view.handle.dispose();
  });

  it('settles an unconfirmed undo once the saved version moves on, and never adopts an older receipt', async () => {
    state.history = [
      { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial' },
      { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'manual' },
    ];
    const view = mount({ editor: { version: 2, offset: [1, 0, 0], yaw: 0, clean: true } });
    await settle();
    view.button('Return to version 1').dispatch('click');
    posts[0].respond(lost());
    await settle();
    assert.ok(view.calls.some(([name]) => name === 'unconfirmed'));

    // Load saved version found the undo as version 3; a manual save then made version 4.
    view.bridge.editorState = { version: 4, offset: [0.5, 0, 0], yaw: 0, clean: true };
    state.history.push({ version: 3, offset: [0, 0, 0], yaw: 0, kind: 'undo', targetVersion: 1 }, { version: 4, offset: [0.5, 0, 0], yaw: 0, kind: 'manual' });
    await view.handle.refresh();
    view.button('Return to version 1').dispatch('click');
    assert.notEqual(posts[1].body.requestId, posts[0].body.requestId);
    assert.equal(posts[1].body.baseVersion, 4);

    posts[1].respond(json(200, { version: 3, offset: [0, 0, 0], yaw: 0 }));
    await settle();
    assert.ok(!view.calls.some(([name]) => name === 'saved'), 'an older version is not adopted');
    assert.equal(view.bridge.editorState.version, 4);
    assert.match(view.message(), /already saved as version 3; the saved position is now version 4/);
    view.handle.dispose();
  });

  it('ignores a list read that started before a plan and an acknowledged cancel', async () => {
    const lists = [];
    state.listGet = () => new Promise((resolve) => lists.push(resolve));
    const view = mount();
    await settle();
    view.write('The counter faced the window.');
    view.agree();
    view.button('Plan a change').dispatch('click');
    state.proposalGet = () => json(200, proposal({ status: 'processing', result: null }));
    posts[0].respond(json(202, proposal({ status: 'queued', result: null })));
    await settle();
    view.button('Cancel planning').dispatch('click');
    posts[1].respond(json(200, proposal({ status: 'canceled', result: null })));
    await settle();
    // The read held since mount describes the proposal as ready.
    lists[0](json(200, [proposal()]));
    await settle();
    assert.match(view.container.textContent, /Canceled\. Nothing was changed\./);
    assert.equal(view.button('Preview on the scene'), undefined);
    // Reads started after the actions still apply.
    for (const resolve of lists.slice(1)) resolve(json(200, [proposal({ status: 'canceled', result: null })]));
    await settle();
    assert.match(view.container.textContent, /Canceled\. Nothing was changed\./);
    view.handle.dispose();
  });

  it('keeps an acknowledged cancel when an older poll answers later', async () => {
    state.proposals = [proposal({ status: 'processing', result: null })];
    const reads = [];
    state.proposalGet = () => new Promise((resolve) => reads.push(resolve));
    const view = mount();
    await settle();
    assert.equal(reads.length, 1, 'a poll read is in flight');
    view.button('Cancel planning').dispatch('click');
    state.proposals = [proposal({ status: 'canceled', result: null })];
    posts[0].respond(json(200, proposal({ status: 'canceled', result: null })));
    await settle();
    reads[0](json(200, proposal()));
    await settle();
    assert.match(view.container.textContent, /Canceled\. Nothing was changed\./);
    assert.equal(view.button('Preview on the scene'), undefined);
    view.handle.dispose();
  });

  it('shows a redacted proposal and its history entry without any words, result or preview', async () => {
    const redacted = proposal({ status: 'stale', redacted: true, statement: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'human_memory', text: null, sha256: 'a'.repeat(64), modelConsent: true }, result: null, question: null, error: 'This proposal is no longer available.' });
    state.proposals = [redacted];
    state.history.push({ version: 2, offset: [0, 0, 0], yaw: 0.5, kind: 'proposal', proposalId: PROPOSAL_ID });
    const view = mount({ editor: { version: 2, offset: [0, 0, 0], yaw: 0.5, clean: true } });
    await settle();
    const textNow = view.container.textContent;
    assert.match(textNow, /This saved proposal is no longer shown, because the scene it was made for can no longer be used\./);
    assert.match(textNow, /The memory for this change is no longer shown\./);
    assert.doesNotMatch(textNow, /null|AI suggestion|Your memory: /);
    assert.equal(view.button('Preview on the scene'), undefined);
    view.handle.dispose();
  });

  it('stops updating after it is closed', async () => {
    state.proposals = [proposal({ status: 'processing', result: null })];
    let gets = 0;
    state.proposalGet = () => {
      gets += 1;
      return json(200, proposal({ status: 'processing', result: null }));
    };
    const view = mount();
    await settle();
    view.handle.dispose();
    const before = gets;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(gets, before);
  });

});

describe('saved proposals chooser', () => {
  const ID_A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  const ID_B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
  const ID_C = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
  const statement = (text) => ({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'human_memory', text, sha256: 'a'.repeat(64), modelConsent: true });
  // Newest first, as the server lists them.
  const clarifyA = () => proposal({ id: ID_A, status: 'clarify', result: null, question: 'Which window?', statement: statement('It faced a window.'), createdAt: '2026-10-31T10:00:00.000Z', updatedAt: '2026-10-31T10:00:05.000Z' });
  const readyB = (overrides = {}) =>
    proposal({ id: ID_B, statement: statement('The counter was turned toward the door, the way it stood when the shop was busy.'), createdAt: '2026-10-30T09:00:00.000Z', updatedAt: '2026-10-30T09:00:05.000Z', ...overrides });
  const faceAnchor = (id, label) => ({
    action: 'face_anchor', targetId: 'selected-foreground', sourceId: 'src', baseVersion: 1, delta: null, yawDelta: null,
    anchor: { label, point: [0.2, 0.3] }, question: null, reason: `It faced the ${label}.`, transform: { offset: [0, 0, 0], yaw: 0.3 },
  });
  const row = (view, words) => view.find((node) => node.tag === 'li' && node.textContent.includes(words))[0];
  const pick = (view, words) => row(view, words).findAll((node) => node.tag === 'button')[0];
  const shown = (view) => view.calls.filter(([name, transform]) => name === 'showTransform' && transform);

  it('reviews an older ready response chosen over the newest clarification, sending nothing and moving nothing', async () => {
    state.proposals = [clarifyA(), readyB()];
    const view = mount();
    await settle();
    view.write('My newer note, not sent.');
    view.agree();
    assert.match(view.container.textContent, /Saved proposals \(2\)/);
    assert.match(view.container.textContent, /Which window\?/, 'the newest not applied is reviewed first');
    assert.match(row(view, 'It faced a window').textContent, /Oct 31, 2026.*Needs more detail · “It faced a window\.”/);
    assert.match(row(view, 'toward the door').textContent, /Proposed change · “The counter was turned toward the door, the way it stood…”/);
    pick(view, 'toward the door').dispatch('click');
    await settle();
    assert.equal(posts.length, 0, 'choosing sends nothing');
    assert.equal(shown(view).length, 0, 'nothing is shown on the scene before Preview');
    assert.equal(pick(view, 'toward the door').textContent, 'Reviewing');
    assert.match(view.container.textContent, /Saved response from muse-spark-1\.3, requested on Oct 30, 2026.*It was stored then; reviewing it sends nothing new\./);
    assert.match(view.container.textContent, /Reason given: The memory says the counter turned toward the window\./);
    assert.equal(view.text().value, 'My newer note, not sent.');
    assert.equal(view.consent().checked, true);
    view.button('Preview on the scene').dispatch('click');
    assert.equal(shown(view).length, 1, 'only an explicit preview shows it');
    view.handle.dispose();
  });

  it('says when a response time is unknown', async () => {
    state.proposals = [readyB({ createdAt: null, model: null })];
    const view = mount();
    await settle();
    assert.match(view.container.textContent, /Saved response from an unknown model, requested at an unknown time\./);
    assert.match(row(view, 'toward the door').textContent, /^Time unknown · /);
    view.handle.dispose();
  });

  it('ends a preview when another proposal is chosen, so its guide and front check must be done again', async () => {
    state.proposals = [readyB({ id: ID_C, result: faceAnchor(ID_C, 'window'), statement: statement('Facing the window.') }), readyB({ result: faceAnchor(ID_B, 'door') })];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    const front = () => view.find((node) => node.tag === 'label' && /I checked the scene/.test(node.textContent))[0]?.children[0];
    front().checked = true;
    front().dispatch('change');
    assert.equal(view.button('Apply and save this proposal').disabled, false);
    pick(view, 'toward the door').dispatch('click');
    assert.deepEqual(view.calls.at(-2), ['showTransform', null], 'the old guide is removed');
    assert.deepEqual(view.calls.at(-1), ['setLocked', false]);
    assert.ok(view.button('Preview on the scene'), 'a fresh preview is needed');
    assert.equal(view.button('Apply and save this proposal').disabled, true);
    view.button('Preview on the scene').dispatch('click');
    assert.equal(front().checked, false, 'the front check is asked again');
    assert.equal(posts.length, 0);
    view.handle.dispose();
  });

  it('offers no preview for stale, applied or redacted records, and shows no words for a redacted one', async () => {
    const redacted = readyB({ id: ID_C, status: 'stale', redacted: true, statement: { ...statement(null) }, result: null, question: null, error: 'Internal reason.', model: 'muse-spark-1.3' });
    state.proposals = [readyB({ id: ID_A, status: 'stale', statement: statement('Older base.') }), readyB({ status: 'applied', appliedVersion: 2, statement: statement('Applied one.') }), redacted];
    const view = mount({ editor: { version: 2, offset: [0, 0, 0], yaw: 0.3, clean: true } });
    await settle();
    for (const words of ['Older base', 'Applied one', 'no longer shown']) {
      const button = pick(view, words);
      if (button.textContent !== 'Reviewing') button.dispatch('click');
      assert.equal(view.button('Preview on the scene'), undefined, words);
    }
    const line = row(view, 'no longer shown').textContent;
    assert.match(line, /This saved proposal is no longer shown, because the scene it was made for can no longer be used\./);
    assert.doesNotMatch(view.container.textContent, /null|Internal reason|Saved response from/);
    assert.match(row(view, 'Applied one').textContent, /Applied as version 2/);
    view.handle.dispose();
  });

  it('keeps the chosen ID across reads, clears it when it is gone without choosing another, and never shows redacted words again', async () => {
    state.proposals = [clarifyA(), readyB()];
    const view = mount();
    await settle();
    pick(view, 'toward the door').dispatch('click');
    view.button('Preview on the scene').dispatch('click');
    await view.handle.refresh();
    assert.equal(pick(view, 'toward the door').textContent, 'Reviewing', 'kept by ID');

    state.proposals = [clarifyA(), readyB({ status: 'stale', redacted: true, statement: statement(null), result: null })];
    await view.handle.refresh();
    assert.deepEqual(view.calls.filter(([name]) => name === 'showTransform').at(-1), ['showTransform', null], 'the preview ends');
    assert.match(view.container.textContent, /This saved proposal is no longer shown/);
    state.proposals = [clarifyA(), readyB()];
    await view.handle.refresh();
    assert.doesNotMatch(view.container.textContent, /toward the door/, 'a later read cannot bring the words back');

    state.proposals = [clarifyA()];
    await view.handle.refresh();
    assert.match(view.container.textContent, /The proposal you were reviewing is no longer listed/);
    assert.doesNotMatch(view.container.textContent, /Which window\?/, 'nothing else is chosen in its place');
    await view.handle.refresh();
    assert.doesNotMatch(view.container.textContent, /Which window\?/, 'not later either');
    view.handle.dispose();
  });

  it('keeps a choice made while an older list read was still on its way', async () => {
    state.proposals = [clarifyA(), readyB()];
    const view = mount();
    await settle();
    const held = [];
    state.listGet = () => new Promise((resolve) => held.push(resolve));
    view.handle.refresh();
    pick(view, 'toward the door').dispatch('click');
    held[0](json(200, [clarifyA(), readyB()]));
    await settle();
    assert.equal(pick(view, 'toward the door').textContent, 'Reviewing');
    view.handle.dispose();
  });

  it('keeps planning in progress reachable and blocks other proposals and new plans until it ends', async () => {
    state.proposals = [readyB()];
    const view = mount();
    await settle();
    // Planning started elsewhere appears in a later list.
    state.proposals = [proposal({ status: 'processing', result: null, updatedAt: '2026-10-31T11:00:00.000Z', createdAt: '2026-10-31T11:00:00.000Z' }), readyB()];
    await view.handle.refresh();
    assert.equal(pick(view, 'toward the door').textContent, 'Reviewing');
    assert.match(view.container.textContent, /A memory is being planned\. Until it finishes or is canceled, only that planning can be reviewed\./);
    view.write('Another memory.');
    view.agree();
    assert.equal(view.button('Plan a change').disabled, true, 'no second planning');
    const live = pick(view, 'faced the window');
    assert.equal(live.disabled, false, 'the planning is reachable');
    state.proposalGet = () => json(200, proposal({ status: 'processing', result: null, updatedAt: '2026-10-31T11:00:01.000Z' }));
    live.dispatch('click');
    await settle();
    assert.match(view.container.textContent, /Meta is reading your memory/);
    assert.ok(view.button('Cancel planning'));
    assert.equal(pick(view, 'toward the door').disabled, true, 'historical proposals wait');
    view.handle.dispose();
  });

  it('blocks switching after an unknown apply and repeats the same request', async () => {
    state.proposals = [clarifyA(), readyB()];
    const view = mount();
    await settle();
    pick(view, 'toward the door').dispatch('click');
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    assert.equal(pick(view, 'It faced a window').disabled, true, 'not while the action runs');
    posts[0].respond(lost());
    await settle();
    assert.match(view.container.textContent, /Rehere could not confirm an earlier request/);
    assert.equal(pick(view, 'It faced a window').disabled, true);
    view.bridge.editorState.clean = true;
    view.handle.sync();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    assert.equal(posts[1].body.requestId, posts[0].body.requestId, 'the same request');
    assert.equal(posts[1].url, `${JOB_URL}/proposals/${ID_B}/apply`);
    view.handle.dispose();
  });

  it('repeats an unconfirmed plan exactly even after the text changes, until the server answers', async () => {
    const view = mount();
    await settle();
    view.write('Turn it toward the door.');
    view.agree();
    view.button('Plan a change').dispatch('click');
    posts[0].respond(lost());
    await settle();
    view.write('Actually toward the window.');
    assert.match(view.container.textContent, /repeats the earlier unconfirmed request exactly/);
    view.button('Plan a change').dispatch('click');
    assert.deepEqual(posts[1].body, posts[0].body, 'the same request, not the newer text');
    posts[1].respond(json(403, { error: 'Planning is not set up on this server.' }));
    await settle();
    view.button('Plan a change').dispatch('click');
    assert.notEqual(posts[2].body.requestId, posts[0].body.requestId);
    assert.equal(posts[2].body.text, 'Actually toward the window.', 'the raw newer text, once settled');
    view.handle.dispose();
  });

  it('ends a preview when the reviewed record comes back redacted, even with status ready, and an older read cannot bring it back', async () => {
    for (const hidden of [
      { redacted: true, statement: statement(null), result: null },
      { statement: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'human_memory' } },
    ]) {
      state.proposals = [readyB({ result: faceAnchor(ID_B, 'door') })];
      const view = mount();
      await settle();
      view.button('Preview on the scene').dispatch('click');
      const front = view.find((node) => node.tag === 'label' && /I checked the scene/.test(node.textContent))[0].children[0];
      front.checked = true;
      front.dispatch('change');
      const held = [];
      state.listGet = () => new Promise((resolve) => held.push(resolve));
      const older = view.handle.refresh();
      state.listGet = null;
      state.proposals = [readyB({ status: 'ready', ...hidden, updatedAt: '2026-10-30T09:00:05.000Z' })];
      await view.handle.refresh();
      assert.deepEqual(view.calls.filter(([name]) => name === 'showTransform').at(-1), ['showTransform', null], 'the guide is removed');
      assert.deepEqual(view.calls.filter(([name]) => name === 'setLocked').at(-1), ['setLocked', false], 'the editor is unlocked');
      assert.equal(view.button('Preview on the scene'), undefined);
      assert.equal(view.button('Apply and save this proposal'), undefined);
      assert.match(view.container.textContent, /This saved proposal is no longer shown/);
      // The read started earlier answers last with the words.
      held[0](json(200, [readyB({ result: faceAnchor(ID_B, 'door'), updatedAt: '2026-10-30T09:00:09.000Z' })]));
      await older;
      await settle();
      assert.doesNotMatch(view.container.textContent, /toward the door|Reason given|Preview on the scene/);
      state.proposals = [readyB({ result: faceAnchor(ID_B, 'door'), updatedAt: '2026-10-30T09:00:09.000Z' })];
      await view.handle.refresh();
      assert.doesNotMatch(view.container.textContent, /toward the door|Reason given/, 'a newer read cannot bring it back either');
      assert.equal(view.button('Preview on the scene'), undefined);
      view.handle.dispose();
    }
  });

  it('first shows planning still in progress, even when a newer response is listed, so it is never hidden', async () => {
    state.proposals = [readyB({ id: ID_C, createdAt: '2026-10-31T12:00:00.000Z', statement: statement('A newer saved response.') }), proposal({ status: 'processing', result: null })];
    state.proposalGet = () => json(200, proposal({ status: 'processing', result: null }));
    const view = mount();
    await settle();
    assert.equal(pick(view, 'faced the window').textContent, 'Reviewing');
    assert.ok(view.button('Cancel planning'), 'its cancel is reachable');
    assert.equal(pick(view, 'A newer saved response').disabled, true);
    view.handle.dispose();
  });

  it('takes nothing from an apply answered after its proposal was redacted or removed', async () => {
    for (const later of [() => [clarifyA(), readyB({ status: 'stale', redacted: true, statement: statement(null), result: null })], () => [clarifyA()]]) {
      posts = [];
      state.proposals = [clarifyA(), readyB()];
      const view = mount();
      await settle();
      pick(view, 'toward the door').dispatch('click');
      view.button('Preview on the scene').dispatch('click');
      view.button('Apply and save this proposal').dispatch('click');
      state.proposals = later();
      await view.handle.refresh();
      posts[0].respond(json(200, { edit: { version: 2, offset: [0, 0, 0], yaw: Math.PI / 4 }, proposal: readyB({ status: 'applied', appliedVersion: 2, updatedAt: '2026-10-30T09:00:09.000Z' }) }));
      await settle();
      assert.ok(!view.calls.some(([name]) => name === 'saved'), 'the edit is not taken into the editor here');
      assert.ok(view.calls.some(([name]) => name === 'conflict'), 'the saved version must be loaded');
      assert.match(view.message(), /saved this change as version 2, but its proposal is no longer shown here\. Load the saved version/);
      assert.doesNotMatch(view.container.textContent, /toward the door|Reason given|Applied as version 2/);
      view.handle.dispose();
    }
  });

  it('drops a poll answer made obsolete by a fresh list that shows the planning finished', async () => {
    state.proposals = [proposal({ status: 'processing', result: null, updatedAt: '2026-10-31T00:00:01.000Z' })];
    const polls = [];
    state.proposalGet = () => new Promise((resolve) => polls.push(resolve));
    const view = mount();
    await settle();
    assert.equal(polls.length, 1, 'a poll is on its way');
    state.proposals = [proposal({ updatedAt: '2026-10-31T00:00:05.000Z' })];
    await view.handle.refresh();
    assert.ok(view.button('Preview on the scene'));
    polls[0](json(200, proposal({ status: 'processing', result: null, updatedAt: '2026-10-31T00:00:01.000Z' })));
    await settle();
    assert.match(view.container.textContent, /A change is proposed\. Nothing has changed yet\./);
    assert.ok(view.button('Preview on the scene'), 'the ready proposal stays reviewable');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(polls.length, 1, 'no further polling of a finished proposal');
    view.handle.dispose();
  });

  it('keeps a proposal that left the list out of the panel even if a later read lists it again', async () => {
    state.proposals = [clarifyA(), readyB()];
    const view = mount();
    await settle();
    pick(view, 'toward the door').dispatch('click');
    state.proposals = [clarifyA()];
    await view.handle.refresh();
    state.proposals = [clarifyA(), readyB({ updatedAt: '2026-10-30T09:00:09.000Z' })];
    await view.handle.refresh();
    assert.doesNotMatch(view.container.textContent, /toward the door|Reason given/);
    assert.equal(row(view, 'toward the door'), undefined, 'not offered again');
    assert.equal(view.button('Preview on the scene'), undefined);
    assert.match(view.container.textContent, /Saved proposals \(1\)/);
    view.handle.dispose();
  });

  it('drops an older poll answer but keeps polling while the planning shown is still in progress', async () => {
    state.proposals = [proposal({ status: 'queued', result: null, updatedAt: '2026-10-31T00:00:01.000Z' })];
    const polls = [];
    state.proposalGet = () => new Promise((resolve) => polls.push(resolve));
    const view = mount();
    await settle();
    assert.equal(polls.length, 1);
    // A fresh list already shows it processing (newer); the held poll then answers queued (older).
    state.proposals = [proposal({ status: 'processing', result: null, updatedAt: '2026-10-31T00:00:02.000Z' })];
    await view.handle.refresh();
    polls[0](json(200, proposal({ status: 'queued', result: null, updatedAt: '2026-10-31T00:00:01.000Z' })));
    await settle();
    assert.match(view.container.textContent, /Meta is reading your memory/, 'the older answer changes nothing');
    state.proposalGet = () => json(200, proposal({ updatedAt: '2026-10-31T00:00:09.000Z' }));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await settle();
    assert.match(view.container.textContent, /A change is proposed\. Nothing has changed yet\./, 'polling continued without a manual refresh');
    assert.ok(view.button('Preview on the scene'));
    view.handle.dispose();
  });

  it('ignores an older poll answer even when the fresh list left polling running', async () => {
    // Both are still planning, so the list does not stop the poll; only the age check drops the answer.
    state.proposals = [proposal({ status: 'queued', result: null, updatedAt: '2026-10-31T00:00:01.000Z' })];
    const polls = [];
    state.proposalGet = () => new Promise((resolve) => polls.push(resolve));
    const view = mount();
    await settle();
    state.proposals = [proposal({ status: 'processing', result: null, updatedAt: '2026-10-31T00:00:02.000Z' })];
    await view.handle.refresh();
    polls[0](json(200, proposal({ status: 'queued', result: null, updatedAt: '2026-10-31T00:00:01.000Z' })));
    await settle();
    assert.doesNotMatch(view.container.textContent, /Waiting to send your memory/);
    view.handle.dispose();
  });

  it('drops an obsolete poll answer for records without timestamps once a fresh list shows the planning finished', async () => {
    state.proposals = [proposal({ status: 'processing', result: null, updatedAt: undefined })];
    const polls = [];
    state.proposalGet = () => new Promise((resolve) => polls.push(resolve));
    const view = mount();
    await settle();
    state.proposals = [proposal({ updatedAt: undefined })];
    await view.handle.refresh();
    polls[0](json(200, proposal({ status: 'processing', result: null, updatedAt: undefined })));
    await settle();
    assert.ok(view.button('Preview on the scene'), 'the finished state stays');
    view.handle.dispose();
  });

  it('takes nothing from an apply receipt whose proposal arrives redacted, with no read in between', async () => {
    state.proposals = [readyB()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    // A replayed receipt after the source stopped: the edit plus the redacted proposal.
    posts[0].respond(json(200, { edit: { version: 2, offset: [0, 0, 0], yaw: Math.PI / 4 }, proposal: readyB({ status: 'stale', redacted: true, statement: statement(null), result: null, question: null }) }));
    await settle();
    assert.ok(!view.calls.some(([name]) => name === 'saved'), 'the edit is not taken into the editor here');
    assert.ok(view.calls.some(([name]) => name === 'conflict'));
    assert.match(view.message(), /saved this change as version 2, but its proposal is no longer shown here/);
    assert.doesNotMatch(view.container.textContent, /toward the door|Reason given/);
    view.handle.dispose();
  });

  it('scrubs a redacted apply receipt from the review and the list at once, before any later read answers', async () => {
    state.proposals = [readyB()];
    const view = mount();
    await settle();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    // The read that follows the action is held, so only the receipt itself can scrub.
    const held = [];
    state.listGet = () => new Promise((resolve) => held.push(resolve));
    posts[0].respond(json(200, { edit: { version: 2, offset: [0, 0, 0], yaw: Math.PI / 4 }, proposal: readyB({ status: 'stale', redacted: true, statement: statement(null), result: null, question: null }) }));
    await settle();
    assert.equal(held.length, 1, 'the follow-up read has not answered');
    const textNow = view.container.textContent;
    assert.doesNotMatch(textNow, /toward the door|Reason given|After this change/, 'no words while the read is pending');
    assert.match(row(view, 'no longer shown').textContent, /This saved proposal is no longer shown/);
    assert.match(textNow, /This saved proposal is no longer shown, because the scene it was made for can no longer be used\./);
    assert.equal(view.button('Preview on the scene'), undefined);
    assert.ok(!view.calls.some(([name]) => name === 'saved'));
    // A stale answer to that read cannot bring the words back either.
    held[0](json(200, [readyB()]));
    await settle();
    assert.doesNotMatch(view.container.textContent, /toward the door|Reason given/);
    view.handle.dispose();
  });
});

describe('blocked planning guidance', () => {
  const privateSource = { ...publicSource, origin: { kind: 'own', reference: '' } };
  const noModel = { ...publicSource, permissions: { place: true, model: false, share: true } };
  const names = { 'object-1': 'A: Counter', 'object-2': 'B: Lamp' };
  const composed = (sources, nameOf = (id) => names[id]) => mount({ extra: { frame: 'owner-composition', geometrySources: sources, targets: { nameOf, selected: () => null } } });
  const recoveryText = (view) => view.find((node) => node.tag === 'p' && /separate place/.test(node.textContent ?? '')).map((node) => node.textContent);
  const blockedText = (view) => view.find((node) => node.className === 'memory-blocked').flatMap((list) => list.children.map((node) => node.textContent));
  const assertClosed = async (view) => {
    await settle();
    assert.equal(view.button('Plan a change'), undefined);
    assert.equal(view.text(), undefined);
    assert.equal(view.find((node) => node.tag === 'button').length, 0);
    assert.deepEqual(posts, []);
    view.handle.dispose();
  };

  it('explains a legacy photo with a generic label and its current-use facts, with recovery once', async () => {
    const view = mount({ source: noModel });
    const [item] = blockedText(view);
    assert.match(item, /^This scene photo: .*model processing/);
    assert.match(item, /Not currently allowed: “Use for model processing”\./);
    assert.doesNotMatch(item, /Not currently allowed:.*reconstruct|not granted|owner|private/i);
    assert.doesNotMatch(item, /photo \d|separate place/);
    const [recovery] = recoveryText(view);
    assert.equal(recoveryText(view).length, 1);
    assert.match(recovery, /can only be narrowed, never broadened/);
    assert.match(recovery, /public label creates no rights and does not make a photo public/);
    assert.match(recovery, /provider can truthfully allow the needed uses and whose actual origin is public/);
    assert.match(recovery, /save it as a new memory with those uses allowed, then build a scene there/);
    assert.match(recovery, /separate place: this place’s scene, recollections, stories and visitor links are not moved or unblocked/);
    assert.match(recovery, /cannot be combined with photos here/);
    assert.doesNotMatch(recovery, /owner|append|add (it|material) to this/i);
    await assertClosed(view);
  });

  it('describes a non-public origin as saved, without calling it private', async () => {
    for (const origin of [{ kind: 'own' }, { kind: 'other' }, { kind: 'unknown' }, { kind: 'stock' }, undefined, { kind: '<b>x</b>' }]) {
      const view = mount({ source: { ...publicSource, origin } });
      const [item] = blockedText(view);
      assert.match(item, /only photos saved as a public source/);
      assert.match(item, /saved origin is not recorded as a public source/);
      assert.doesNotMatch(item, /private|<b>|“(?:own|other|unknown|stock)”|Not currently allowed/);
      assert.doesNotMatch(recoveryText(view)[0], /private/);
      await assertClosed(view);
    }
  });

  it('gives no recommendation when the legacy source is missing', async () => {
    const view = mount({ source: null });
    const [item] = blockedText(view);
    assert.match(item, /no source details/);
    assert.match(item, /no specific recommendation/);
    assert.doesNotMatch(item, /different|new memory|separate place/);
    assert.equal(recoveryText(view).length, 0);
    await assertClosed(view);
  });

  it('lists only the blocked composition photo, labeled by its scene object', async () => {
    const view = composed([publicSource, privateSource]);
    const items = blockedText(view);
    assert.equal(items.length, 1);
    assert.match(items[0], /^Source photo for object B: .*public source/);
    assert.doesNotMatch(items[0], /Counter|Lamp/);
    assert.match(items[0], /saved origin is not recorded as a public source/);
    assert.doesNotMatch(items[0], /separate place|new memory/);
    assert.match(view.container.textContent, /until both source photos qualify/);
    await assertClosed(view);
  });

  it('lists both blocked composition photos with their distinct reasons', async () => {
    const view = composed([noModel, privateSource]);
    const items = blockedText(view);
    assert.equal(items.length, 2);
    assert.match(items[0], /^Source photo for object A: .*model processing/);
    assert.match(items[1], /^Source photo for object B: .*public source/);
    assert.match(items[0], /Not currently allowed: “Use for model processing”/);
    assert.doesNotMatch(items[0], /saved origin/);
    assert.doesNotMatch(items[1], /Not currently allowed/);
    assert.equal(recoveryText(view).length, 1);
    assert.equal(view.container.textContent.split('separate place').length, 2);
    assert.doesNotMatch(view.container.textContent, /combine.*(new|other) place|composition from/i);
    await assertClosed(view);
  });

  it('falls back to a generic label for untrusted or mismatched object names', async () => {
    const generic = ['A scene source photo', 'A scene source photo'];
    const cases = [
      [() => 'B: swapped', ['A scene source photo', 'Source photo for object B']],
      [() => undefined, generic],
      [() => ({ A: 1 }), generic],
      [() => '<img src=x>', generic],
      [() => { throw new Error('bad'); }, generic],
    ];
    for (const [nameOf, expected] of cases) {
      const view = composed([privateSource, privateSource], nameOf);
      assert.deepEqual(blockedText(view).map((item) => item.split(':')[0]), expected);
      await assertClosed(view);
    }
  });

  it('keeps planning off, with no specific advice, for malformed composition sources', async () => {
    for (const sources of [undefined, [], [publicSource], [publicSource, publicSource, publicSource]]) {
      const view = composed(sources);
      assert.equal(blockedText(view).length, 0);
      assert.match(view.container.textContent, /Both photo source records are required before planning\. Which photo is affected cannot be told/);
      assert.equal(recoveryText(view).length, 0);
      await assertClosed(view);
    }
    const view = composed([null, publicSource]);
    assert.match(blockedText(view)[0], /^Source photo for object A: This photo has no source details/);
    assert.match(blockedText(view)[0], /no specific recommendation/);
    assert.equal(blockedText(view).length, 1);
    await assertClosed(view);
    const onlyMissing = composed([null, null]);
    assert.equal(blockedText(onlyMissing).length, 2);
    assert.equal(recoveryText(onlyMissing).length, 0);
    await assertClosed(onlyMissing);
  });

  it('leaves ready composition and legacy photos unchanged', async () => {
    const view = composed([publicSource, publicSource]);
    await settle();
    assert.equal(blockedText(view).length, 0);
    assert.ok(view.text());
    assert.ok(view.button('Plan a change'));
    assert.doesNotMatch(view.container.textContent, /Planning stays off|until both source photos|separate place/);
    view.handle.dispose();
    const legacy = mount();
    await settle();
    assert.ok(legacy.button('Plan a change'));
    assert.doesNotMatch(legacy.container.textContent, /Planning stays off/);
    legacy.handle.dispose();
  });

  it('keeps the exported reasons and legacy guard returns', () => {
    assert.match(proposalBlockedReason({ ...publicSource, permissions: { place: false, model: true } }), /reconstruct this place/);
    assert.equal(proposalBlockedReason(undefined) !== null, true);
  });
});

describe('single-object comparison boundaries', () => {
  const setup = async () => {
    state.proposals = [proposal()];
    let opened = null;
    let closed = 0;
    const source = structuredClone(publicSource);
    const comparison = {
      available: () => true,
      source: () => source,
      open(details) { opened = details; return true; },
      close() { closed += 1; },
    };
    const view = mount({ source, extra: { sourceId: 'src', comparison } });
    await settle();
    return { view, source, opened: () => opened, closed: () => closed };
  };

  it('closes the comparison on redaction and ignores its obsolete callbacks', async () => {
    const test = await setup();
    test.view.button('Compare photo, saved and proposal').dispatch('click');
    const old = test.opened();
    assert.ok(old);
    assert.equal(old.select('proposed'), true);
    state.proposals = [proposal({ redacted: true, statement: { ...proposal().statement, text: null }, result: null })];
    await test.view.handle.refresh();
    assert.equal(test.closed(), 1);
    assert.equal(old.select('photo'), false);
    assert.doesNotMatch(test.view.container.textContent, /The counter faced the window/);
    assert.equal(posts.length, 0);
    test.view.handle.dispose();
  });

  it('closes when a version or source permission changes and refuses a late selection', async () => {
    for (const change of ['version', 'permission']) {
      const test = await setup();
      test.view.button('Compare photo, saved and proposal').dispatch('click');
      const old = test.opened();
      assert.equal(old.select('proposed'), true);
      if (change === 'version') test.view.bridge.editorState.version = 2;
      else test.source.permissions.place = false;
      assert.equal(old.select('photo'), false);
      assert.equal(test.closed(), 1);
      assert.equal(posts.length, 0);
      test.view.handle.dispose();
    }
  });

  it('does not compare or apply a proposal bound to another source', async () => {
    const test = await setup();
    state.proposals = [proposal({ result: { ...proposal().result, sourceId: 'another-source' } })];
    await test.view.handle.refresh();
    assert.equal(test.view.button('Compare photo, saved and proposal').disabled, true);
    assert.equal(test.view.button('Preview on the scene').disabled, true);
    assert.equal(test.view.button('Apply and save this proposal').disabled, true);
    assert.match(test.view.container.textContent, /does not identify this scene’s photo and selected object/);
    assert.equal(posts.length, 0);
    test.view.handle.dispose();
  });

  it('holds comparison when history reveals a newer saved version', async () => {
    const test = await setup();
    test.view.button('Compare photo, saved and proposal').dispatch('click');
    const old = test.opened();
    assert.equal(old.select('proposed'), true);
    state.history = [...state.history, { version: 2, offset: [0.2, 0, 0], yaw: 0, kind: 'manual' }];
    await test.view.handle.refresh();
    assert.equal(test.closed(), 1);
    assert.ok(test.view.calls.some(([name]) => name === 'conflict'));
    assert.equal(test.view.button('Compare photo, saved and proposal').disabled, true);
    assert.equal(test.view.button('Apply and save this proposal').disabled, true);
    assert.equal(posts.length, 0);
    test.view.handle.dispose();
  });

  it('keeps exact-request recovery available when the 3D preview is unavailable', async () => {
    state.proposals = [proposal()];
    let available = true;
    const comparison = { available: () => available, source: () => publicSource, open: () => true, close() {} };
    const view = mount({ extra: { sourceId: 'src', comparison } });
    await settle();
    view.button('Preview on the scene').dispatch('click');
    view.button('Apply and save this proposal').dispatch('click');
    posts[0].respond(lost());
    await settle();
    available = false;
    view.handle.sync();
    assert.equal(view.button('Preview on the scene').disabled, true);
    const retry = view.button('Retry the unconfirmed apply');
    assert.equal(retry.disabled, false);
    retry.dispatch('click');
    assert.deepEqual(posts[1].body, posts[0].body);
    view.handle.dispose();
  });
});
