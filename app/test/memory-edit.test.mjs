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

function mount({ source = publicSource, editor = { version: 1, offset: [0, 0, 0], yaw: 0, clean: true } } = {}) {
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
    state.proposalGet = () => json(200, proposal({ status: 'processing', result: null, model: null, usage: null }));
    posts[0].respond(json(202, proposal({ status: 'queued', result: null, model: null, usage: null })));
    await settle();
    assert.match(view.container.textContent, /Meta is reading your memory/);
    assert.ok(view.button('Cancel planning'));
    state.proposalGet = () => json(200, proposal());

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
    assert.match(textNow, /no longer shown, because the scene they were made for depends on a withdrawn recollection/);
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
