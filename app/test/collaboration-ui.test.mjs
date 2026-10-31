import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import {
  contributionStatusText,
  describeEra,
  eraProblem,
  invitationToken,
  mountBlockedScene,
  mountCollaboration,
  mountContributor,
  mountInvitations,
  submissionProblem,
  transformProblem,
} from '../public/collaboration.js';

const DRAFT = '11111111-1111-4111-8111-111111111111';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_URL = `/api/drafts/${DRAFT}/reconstructions/${JOB}`;
const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VID2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

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
  routes = {};
});

const posts = (url) => requests.filter((r) => r.method === 'POST' && r.url === url);
const finder = (root) => {
  const find = (predicate) => root.findAll(predicate);
  return {
    find,
    button: (text) => find((node) => node.tag === 'button' && node.textContent === text)[0],
    checkboxes: () => find((node) => node.tag === 'input' && node.type === 'checkbox'),
    message: () => find((node) => node.className?.startsWith('form-message')).map((node) => node.textContent).join(' '),
  };
};

function contribution(overrides = {}) {
  return {
    id: CID,
    principalId: 'p-contrib',
    provider: { displayName: 'Mina' },
    kind: 'human_recollection',
    text: 'The counter <b>faced</b> the window.',
    textSha256: 'a'.repeat(64),
    permissions: { place: true, model: false, share: false },
    periodClaim: 'summer, long ago',
    createdAt: '2026-10-31T00:00:00.000Z',
    revision: 1,
    status: 'submitted',
    review: null,
    withdrawnAt: null,
    ...overrides,
  };
}

function variant(overrides = {}) {
  return {
    id: VID,
    label: 'Saved reconstruction',
    parentVersion: 1,
    edit: { version: 1, offset: [0, 0, 0], yaw: 0 },
    contributionIds: [],
    createdAt: '2026-10-31T00:00:00.000Z',
    createdBy: 'p-owner',
    era: { kind: 'unknown', label: '', start: null, end: null, statement: '', relation: null, relativeToVariantId: null, confirmed: false, assertedBy: null, assertedAt: null },
    eraRevision: 0,
    blocked: false,
    ...overrides,
  };
}

describe('collaboration helpers', () => {
  it('makes one-use invitation codes in the invitation token family', () => {
    const a = invitationToken();
    assert.match(a, /^rhi_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, invitationToken());
  });

  it('checks recollection length without reading its meaning', () => {
    assert.equal(submissionProblem({ text: ' x ', periodClaim: '' }), null);
    assert.match(submissionProblem({ text: '  ', periodClaim: '' }), /Write your recollection/);
    assert.match(submissionProblem({ text: 'x'.repeat(10_001), periodClaim: '' }), /10,000/);
    assert.match(submissionProblem({ text: 'x', periodClaim: 'y'.repeat(301) }), /300/);
  });

  it('bounds a hand-set candidate exactly like the manual editor', () => {
    assert.equal(transformProblem({ offset: [2, -2, 0], yaw: Math.PI }), null);
    assert.match(transformProblem({ offset: [2.1, 0, 0], yaw: 0 }), /between -2 and 2/);
    assert.match(transformProblem({ offset: [0, 0, 0], yaw: 4 }), /180/);
  });

  it('accepts only explicit, confirmed owner time assertions and never invents a year', () => {
    const base = { kind: 'unknown', label: '', start: null, end: null, relation: null, relativeToVariantId: null, statement: '', confirmed: false };
    assert.equal(eraProblem(base), null);
    assert.match(eraProblem({ ...base, kind: 'exact', start: '2001-02-30', statement: 'x', confirmed: true }), /real calendar date/);
    assert.match(eraProblem({ ...base, kind: 'range', start: '2002-01-01', end: '2001-01-01', statement: 'x', confirmed: true }), /start before/);
    assert.match(eraProblem({ ...base, kind: 'relative', label: 'before the renovation', statement: 'x', confirmed: false }), /Confirm/);
    assert.match(eraProblem({ ...base, kind: 'relative', label: 'x', relation: 'before', statement: 'x', confirmed: true }), /both the relation/);
    assert.equal(eraProblem({ ...base, kind: 'relative', label: 'before the renovation', statement: 'Shop records', confirmed: true }), null);
    assert.equal(describeEra(null), 'Time unknown');
    assert.equal(describeEra({ kind: 'relative', label: 'before the renovation', relation: null }), 'Owner’s assertion: before the renovation');
    assert.equal(describeEra({ kind: 'relative', label: 'same day', relation: 'same-time', relativeToVariantId: VID }, () => 'Saved reconstruction'), 'Owner’s assertion: same day (same time as Saved reconstruction)');
    assert.doesNotMatch(describeEra({ kind: 'relative', label: 'before the renovation', relation: null }), /\d{4}/);
  });

  it('describes statuses without claiming historical truth', () => {
    assert.match(contributionStatusText({ status: 'adopted' }), /adjust the current scene/);
    assert.match(contributionStatusText({ status: 'withdrawn' }), /no longer shows or uses/);
    for (const status of ['submitted', 'reviewing', 'held', 'adopted', 'alternative', 'rejected', 'withdrawn']) {
      assert.doesNotMatch(contributionStatusText({ status }), /verified|true|confirmed/i);
    }
  });
});

describe('contributor screen', () => {
  const PLACE = { draftId: DRAFT, jobId: JOB, label: 'Saved place 11111111', version: 1 };

  async function mount(own = []) {
    routes['GET /api/contributor/places'] = () => Promise.resolve(json(200, [PLACE]));
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { revision: 1, contributions: own, variants: [], blocked: false, currentVersion: 1 }));
    const root = new FakeElement('div');
    const view = mountContributor(root);
    await settle();
    return { view, root, ...finder(root) };
  }

  it('uses only the scoped place list and own recollections, with every use unchecked', async () => {
    const ui = await mount();
    assert.deepEqual(requests.map((r) => r.url), ['/api/contributor/places', `${JOB_URL}/collaboration`]);
    assert.equal(ui.checkboxes().length, 3);
    assert.ok(ui.checkboxes().every((box) => !box.checked));
    assert.equal(ui.find((node) => node.tag === 'input' && node.type === 'file').length, 0, 'no photo upload');
  });

  it('sends the raw text with explicit grants and repeats exactly after an unconfirmed send', async () => {
    const ui = await mount();
    const text = ui.find((node) => node.tag === 'textarea')[0];
    const period = ui.find((node) => node.tag === 'input' && node.type === 'text')[0];
    text.value = '  The counter faced the window.\n';
    period.value = 'around my school years';
    ui.checkboxes()[0].checked = true;
    routes[`POST ${JOB_URL}/contributions`] = lost;
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm whether it arrived/);
    assert.equal(text.value, '  The counter faced the window.\n');
    routes[`POST ${JOB_URL}/contributions`] = () => Promise.resolve(json(201, contribution()));
    ui.button('Send recollection').dispatch('click');
    await settle();
    const [first, second] = posts(`${JOB_URL}/contributions`);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(first.body, {
      requestId: first.body.requestId,
      text: '  The counter faced the window.\n',
      periodClaim: 'around my school years',
      permissions: { place: true, model: false, share: false },
    });
    assert.equal(text.value, '');
    assert.ok(ui.checkboxes().every((box) => !box.checked));
  });

  it('never shows the owner’s private review note, and says notes are private', async () => {
    const ui = await mount([contribution({ status: 'rejected', review: { decision: 'reject', reason: 'It conflicts with what Jun told me privately.', conflict: 'memory', reviewedAt: '2026-11-01T00:00:00.000Z', variantId: null, version: null } })]);
    assert.doesNotMatch(ui.root.textContent, /Jun told me/);
    assert.match(ui.root.textContent, /private review notes are not shared/);
    assert.match(ui.root.textContent, /decided not to use it/);
  });

  it('withdraws only after a second confirmation, repeating the same request when unconfirmed', async () => {
    const ui = await mount([contribution()]);
    ui.button('Withdraw').dispatch('click');
    assert.equal(posts(`${JOB_URL}/contributions/${CID}/withdraw`).length, 0);
    assert.match(ui.root.textContent, /Copies someone already saved outside Rehere cannot be removed/);
    routes[`POST ${JOB_URL}/contributions/${CID}/withdraw`] = lost;
    ui.button('Withdraw this recollection').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm the withdrawal/);
    routes[`POST ${JOB_URL}/contributions/${CID}/withdraw`] = () => Promise.resolve(json(200, { contribution: contribution({ status: 'withdrawn', text: null }) }));
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { revision: 2, contributions: [contribution({ status: 'withdrawn', text: null, revision: 2 })], variants: [], blocked: false, currentVersion: 1 }));
    ui.button('Withdraw this recollection').dispatch('click');
    await settle();
    const sent = posts(`${JOB_URL}/contributions/${CID}/withdraw`);
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.deepEqual(Object.keys(sent[0].body), ['requestId']);
    assert.match(ui.root.textContent, /The text is no longer shown/);
    assert.match(ui.root.textContent, /All further use withdrawn\./);
    assert.doesNotMatch(ui.root.textContent, /Allowed:/);
    assert.equal(ui.button('Withdraw'), undefined);
  });

  it('never lets an older list answer bring back words after a newer redacted one', async () => {
    const reads = [];
    routes['GET /api/contributor/places'] = () => Promise.resolve(json(200, [PLACE]));
    routes[`GET ${JOB_URL}/collaboration`] = () => new Promise((resolve) => reads.push(resolve));
    const root = new FakeElement('div');
    const view = mountContributor(root);
    await settle();
    const ui = finder(root);
    ui.find((node) => node.tag === 'textarea')[0].value = 'Another recollection.';
    routes[`POST ${JOB_URL}/contributions`] = () => Promise.resolve(json(200, contribution()));
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.equal(reads.length, 2, 'the send started a newer read');
    reads[1](json(200, { revision: 3, contributions: [contribution({ status: 'withdrawn', text: null, periodClaim: null })], variants: [], blocked: false, currentVersion: 1 }));
    await settle();
    reads[0](json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 }));
    await settle();
    assert.doesNotMatch(root.textContent, /counter/);
    assert.match(root.textContent, /The text is no longer shown/);
    view.dispose();
  });

  it('frees the form when the place changes during a send, and the old send leaves the new place alone', async () => {
    const OTHER = { draftId: '22222222-2222-4222-8222-222222222222', jobId: JOB, label: 'Saved place 22222222', version: 1 };
    const otherUrl = `/api/drafts/${OTHER.draftId}/reconstructions/${JOB}`;
    routes['GET /api/contributor/places'] = () => Promise.resolve(json(200, [PLACE, OTHER]));
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { revision: 1, contributions: [], variants: [], blocked: false, currentVersion: 1 }));
    routes[`GET ${otherUrl}/collaboration`] = routes[`GET ${JOB_URL}/collaboration`];
    let respond;
    routes[`POST ${JOB_URL}/contributions`] = () => new Promise((resolve) => (respond = resolve));
    const root = new FakeElement('div');
    const view = mountContributor(root);
    await settle();
    const ui = finder(root);
    const placeSelect = ui.find((node) => node.tag === 'select')[0];
    placeSelect.value = `${DRAFT}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
    const text = ui.find((node) => node.tag === 'textarea')[0];
    text.value = 'For place A.';
    ui.button('Send recollection').dispatch('click');
    assert.equal(ui.button('Send recollection').disabled, true);
    placeSelect.value = `${OTHER.draftId}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
    assert.equal(ui.button('Send recollection').disabled, false);
    text.value = 'For place B, still being written.';
    respond(json(200, contribution()));
    await settle();
    assert.equal(text.value, 'For place B, still being written.');
    assert.equal(ui.button('Send recollection').disabled, false);
    view.dispose();
  });

  it('ignores responses that arrive after it is closed', async () => {
    let respond;
    routes['GET /api/contributor/places'] = () => Promise.resolve(json(200, [PLACE]));
    routes[`GET ${JOB_URL}/collaboration`] = () => new Promise((resolve) => (respond = resolve));
    const root = new FakeElement('div');
    const view = mountContributor(root);
    await settle();
    view.dispose();
    respond(json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 }));
    await settle();
    assert.doesNotMatch(root.textContent, /counter/);
  });
});

describe('invitation manager', () => {
  it('creates a code locally, repeats the exact request when unconfirmed, and shows the code only in its control', async () => {
    routes['GET /api/invitations'] = () => Promise.resolve(json(200, []));
    routes['POST /api/invitations'] = lost;
    const root = new FakeElement('div');
    const view = mountInvitations(root, { draftId: DRAFT });
    await settle();
    const ui = finder(root);
    ui.button('Create an invitation').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm the invitation/);
    routes['POST /api/invitations'] = () => Promise.resolve(json(201, { id: 'i1', draftId: DRAFT, expiresAt: '2026-11-01T00:00:00.000Z', status: 'active' }));
    routes['GET /api/invitations'] = () =>
      Promise.resolve(json(200, [{ id: 'i1', draftId: DRAFT, expiresAt: '2026-11-01T00:00:00.000Z', status: 'active' }, { id: 'i2', draftId: 'other', expiresAt: '2026-11-01T00:00:00.000Z', status: 'active' }]));
    ui.button('Create an invitation').dispatch('click');
    await settle();
    const [first, second] = posts('/api/invitations');
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(Object.keys(first.body).sort(), ['draftId', 'expiresInHours', 'requestId', 'token']);
    assert.match(first.body.token, /^rhi_[A-Za-z0-9_-]{43}$/);
    assert.equal(first.body.expiresInHours, 24);
    assert.ok(requests.every((r) => !r.url.includes(first.body.token)), 'the code never goes into a URL');
    assert.equal(ui.find((node) => node.tag === 'code')[0].textContent, first.body.token);
    assert.equal(ui.find((node) => node.tag === 'li').length, 1, 'only this place’s invitations');
    routes['POST /api/invitations/i1/revoke'] = () => Promise.resolve(json(200, { id: 'i1', draftId: DRAFT, status: 'revoked' }));
    ui.button('Revoke').dispatch('click');
    await settle();
    assert.deepEqual(posts('/api/invitations/i1/revoke')[0].body, {});
    assert.match(ui.message(), /can still withdraw them/);
    view.dispose();
  });
});

describe('owner review panel', () => {
  function bridge({ drawn = true, clean = true } = {}) {
    const calls = [];
    const b = {
      jobUrl: JOB_URL,
      state: { version: 1, offset: [0, 0, 0], yaw: 0, clean },
      editor: () => ({ ...b.state }),
      showTransform: (transform) => {
        calls.push(['show', transform]);
        return drawn && Boolean(transform);
      },
      setLocked: (value) => calls.push(['lock', value]),
      saved: (edit) => {
        calls.push(['saved', edit]);
        b.state = { ...edit, clean: true };
      },
      unconfirmed: () => calls.push(['unconfirmed']),
      conflict: () => calls.push(['conflict']),
      blocked: () => calls.push(['blocked']),
      calls,
    };
    return b;
  }

  async function mount(options = {}, data = {}) {
    const collab = { revision: 1, contributions: [contribution()], variants: [variant()], blocked: false, currentVersion: 1, ...data };
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, collab));
    const root = new FakeElement('section');
    const b = bridge(options);
    const view = mountCollaboration(root, b);
    await settle();
    const ui = finder(root);
    const select = (index) => ui.find((node) => node.tag === 'select')[index];
    const setDecision = (value) => {
      select(0).value = value;
      select(0).dispatch('change');
    };
    const candidate = (values) => {
      const inputs = ui.find((node) => node.tag === 'input' && node.type === 'number');
      values.forEach((value, i) => {
        inputs[i].value = String(value);
        inputs[i].dispatch('input');
      });
    };
    return { view, root, b, ui, setDecision, candidate, select };
  }

  it('shows each recollection as written, attributed and with its time claim marked unchecked', async () => {
    const { root, ui } = await mount();
    assert.match(root.textContent, /Mina · Received/);
    ui.button('Review').dispatch('click');
    assert.match(root.textContent, /Review Mina’s recollection/);
    assert.doesNotMatch(root.textContent, /undefined/);
    assert.match(root.textContent, /The counter <b>faced<\/b> the window\./);
    assert.equal(ui.find((node) => node.tag === 'b').length, 0);
    assert.match(root.textContent, /their words, not checked\): summer, long ago/);
    assert.match(root.textContent, /Allowed: use to reconstruct this place\./);
    assert.doesNotMatch(root.findAll((node) => node.className === 'collab-list')[0].textContent, /Your note/, 'no note line before any review');
    assert.doesNotMatch(root.textContent, /(?<!not )verified/i);
  });

  it('adopts only after the hand-set candidate was actually previewed, then hands over the saved edit', async () => {
    const { b, ui, root, setDecision, candidate } = await mount();
    ui.button('Review').dispatch('click');
    setDecision('adopt');
    candidate([0.5, 0, 0, 30]);
    assert.equal(ui.button('Save decision').disabled, true);
    assert.match(root.textContent, /Preview the candidate on the scene before saving it/);
    ui.button('Preview candidate on the scene').dispatch('click');
    const expected = { offset: [0.5, 0, 0], yaw: (30 * Math.PI) / 180 };
    assert.deepEqual(b.calls.filter(([name]) => name === 'show').at(-1), ['show', expected]);
    assert.ok(b.calls.some(([name, value]) => name === 'lock' && value === true));
    assert.equal(ui.button('Save decision').disabled, false);
    assert.ok(!b.calls.some(([name]) => name === 'saved'), 'nothing saved by previewing');

    const edit = { version: 2, offset: [0.5, 0, 0], yaw: expected.yaw };
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(200, { contribution: contribution({ status: 'adopted', revision: 2 }), variant: variant({ id: VID2 }), edit }));
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/${CID}/review`);
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, decision: 'adopt', reason: '', conflict: 'unknown', transform: expected, baseVersion: 1, baseRevision: 1 });
    assert.deepEqual(b.calls.find(([name]) => name === 'saved')[1], edit);
    assert.ok(b.calls.some(([name, value]) => name === 'show' && value === null));
  });

  it('says the current saved scene is not shown while a candidate or alternative is drawn', async () => {
    const alt = variant({ id: VID2, label: 'Mina’s recollection', edit: { version: null, offset: [1, 0, 0], yaw: 0.5 } });
    const { root, ui, setDecision, candidate } = await mount({}, { variants: [variant(), alt] });
    const compareText = () => root.findAll((node) => node.className === 'collab-compare')[0].textContent;
    assert.match(compareText(), /Current saved scene, version 1 \(shown\)/);
    ui.button('Review').dispatch('click');
    setDecision('adopt');
    candidate([0.25, 0, 0, 46]);
    ui.button('Preview candidate on the scene').dispatch('click');
    assert.match(compareText(), /Current saved scene, version 1 \(not shown\)/);
    assert.match(compareText(), /Shown on the scene now: a review candidate set by hand\. It is not saved\./);
    assert.doesNotMatch(compareText(), /\(shown\)/);
    setDecision('hold');
    assert.match(compareText(), /version 1 \(shown\)/, 'back to the saved scene when the preview ends');
    ui.find((node) => node.tag === 'button' && node.textContent === 'Show on the scene')[1].dispatch('click');
    assert.match(compareText(), /\(not shown\)/);
    assert.match(compareText(), /Shown on the scene now: “Mina’s recollection”\. The current saved scene is unchanged\./);
  });

  it('refuses geometry without WebGL, without a place grant, or on a blocked scene, but still allows holding', async () => {
    let ui = (await mount({ drawn: false })).ui;
    ui.button('Review').dispatch('click');
    let s = ui.find((node) => node.tag === 'select')[0];
    s.value = 'adopt';
    s.dispatch('change');
    ui.button('Preview candidate on the scene').dispatch('click');
    assert.equal(ui.button('Save decision').disabled, true);
    assert.match(ui.message() + ui.find((n) => n.tag === 'p').map((n) => n.textContent).join(' '), /could not be previewed/);

    const noPlace = await mount({}, { contributions: [contribution({ permissions: { place: false, model: true, share: true } })] });
    noPlace.ui.button('Review').dispatch('click');
    noPlace.setDecision('alternative');
    assert.equal(noPlace.ui.button('Preview candidate on the scene').disabled, true);
    assert.equal(noPlace.ui.button('Save decision').disabled, true);
    noPlace.setDecision('hold');
    assert.equal(noPlace.ui.button('Save decision').disabled, false);
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(200, { contribution: contribution({ status: 'held', revision: 2 }), variant: null, edit: null }));
    noPlace.ui.button('Save decision').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/contributions/${CID}/review`)[0].body.transform, null);

    const blocked = await mount({}, { blocked: true });
    blocked.ui.button('Review').dispatch('click');
    blocked.setDecision('adopt');
    assert.equal(blocked.ui.button('Save decision').disabled, true);
    assert.match(blocked.root.textContent, /depends on a withdrawn recollection/);
  });

  it('keeps the form and repeats the exact review after an unconfirmed adopt; a conflict asks for a reload', async () => {
    const { b, ui, setDecision, candidate } = await mount();
    ui.button('Review').dispatch('click');
    setDecision('adopt');
    candidate([0.25, 0, 0, 0]);
    ui.button('Preview candidate on the scene').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = lost;
    ui.button('Save decision').dispatch('click');
    await settle();
    assert.ok(b.calls.some(([name]) => name === 'unconfirmed'));
    assert.equal(ui.find((node) => node.tag === 'input' && node.type === 'number')[0].value, '0.25', 'typed values survive the refresh');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => Promise.resolve(json(409, { error: 'The scene changed.' }));
    ui.button('Save decision').dispatch('click');
    await settle();
    const sent = posts(`${JOB_URL}/contributions/${CID}/review`);
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.ok(b.calls.some(([name]) => name === 'conflict'));
    assert.ok(!b.calls.some(([name]) => name === 'saved'));
  });

  it('ends a candidate preview at once when its recollection is withdrawn, and reports a newly blocked scene once', async () => {
    const { view, b, ui, setDecision } = await mount();
    ui.button('Review').dispatch('click');
    setDecision('alternative');
    ui.button('Preview candidate on the scene').dispatch('click');
    assert.ok(b.calls.at(-1)[0] === 'lock' && b.calls.at(-1)[1] === true);
    routes[`GET ${JOB_URL}/collaboration`] = () =>
      Promise.resolve(json(200, { revision: 2, contributions: [contribution({ status: 'withdrawn', text: null, revision: 2 })], variants: [variant()], blocked: false, currentVersion: 1 }));
    await view.refresh();
    assert.deepEqual(b.calls.filter(([name]) => name === 'show').at(-1), ['show', null]);
    assert.ok(!b.calls.some(([name]) => name === 'blocked'));

    routes[`GET ${JOB_URL}/collaboration`] = () =>
      Promise.resolve(json(200, { revision: 3, contributions: [contribution({ status: 'withdrawn', text: null, revision: 2 })], variants: [variant()], blocked: true, currentVersion: 2 }));
    await view.refresh();
    await view.refresh();
    assert.equal(b.calls.filter(([name]) => name === 'blocked').length, 1);
  });

  it('does not offer a withdrawn recollection for review or show its words, grants or notes', async () => {
    const { root, ui } = await mount({}, {
      contributions: [
        contribution({ status: 'withdrawn', text: null, periodClaim: null, withdrawnAt: '2026-11-01T00:00:00.000Z', review: { decision: 'hold', reason: null, conflict: null, reviewedAt: '2026-10-31T12:00:00.000Z', variantId: null, version: null } }),
      ],
    });
    assert.equal(ui.button('Review'), undefined);
    assert.doesNotMatch(root.textContent, /counter|summer, long ago/);
    assert.match(root.textContent, /All further use withdrawn\./);
    const listText = root.findAll((node) => node.className === 'collab-list')[0].textContent;
    assert.doesNotMatch(listText, /Allowed:|Your note|\bnone\b/);
    assert.match(root.textContent, /Withdrawn by the person who wrote it/);
  });

  it('shows a saved alternative temporarily and returns to the current scene; a blocked one cannot be shown', async () => {
    const alt = variant({ id: VID2, label: 'Mina’s recollection', edit: { version: 1, offset: [1, 0, 0], yaw: 0.5 }, contributionIds: [CID], eraRevision: 0 });
    const blockedAlt = variant({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', label: 'Blocked one', blocked: true });
    const { b, ui } = await mount({}, { variants: [variant(), alt, blockedAlt] });
    const shows = ui.find((node) => node.tag === 'button' && node.textContent === 'Show on the scene');
    assert.equal(shows.length, 2, 'the blocked alternative has no show button');
    shows[1].dispatch('click');
    assert.deepEqual(b.calls.filter(([name]) => name === 'show').at(-1), ['show', alt.edit]);
    assert.match(ui.message(), /The saved scene is unchanged/);
    ui.button('Back to the current scene').dispatch('click');
    assert.deepEqual(b.calls.filter(([name]) => name === 'show').at(-1), ['show', null]);
    assert.equal(posts(`${JOB_URL}/contributions/${CID}/review`).length, 0);
  });

  it('shows a blocked alternative only by its label and the reason it cannot be used', async () => {
    const blockedAlt = variant({ id: VID2, label: 'Blocked reconstruction', blocked: true, era: { kind: 'range', label: null, start: null, end: null, statement: null, relation: null, relativeToVariantId: null, confirmed: true, assertedBy: null, assertedAt: null } });
    const { root } = await mount({}, { variants: [variant(), blockedAlt] });
    const compareText = root.findAll((node) => node.className === 'collab-compare')[0].textContent;
    assert.match(compareText, /Blocked reconstruction/);
    assert.match(compareText, /Blocked: it depends on a withdrawn recollection/);
    assert.match(compareText, /Time details withheld after withdrawal\./);
    const blockedItem = root.findAll((node) => node.tag === 'li' && node.children[0]?.textContent === 'Blocked reconstruction')[0];
    assert.doesNotMatch(blockedItem.textContent, /null|Owner’s assertion| to |Time unknown/);
    assert.equal(root.findAll((node) => node.tag === 'summary' && node.textContent === 'Record when this was').length, 1, 'only the usable baseline has a time form');
  });

  it('records a same-time relation between alternatives as an explicit owner assertion with no date', async () => {
    const alt = variant({ id: VID2, label: 'Mina’s recollection' });
    const { root, ui } = await mount({}, { variants: [variant(), alt] });
    const form = root.findAll((node) => node.tag === 'details')[1];
    const f = finder(form);
    const selects = f.find((node) => node.tag === 'select');
    selects[0].value = 'relative';
    f.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'same afternoon';
    selects[1].value = 'same-time';
    selects[2].value = VID;
    f.find((node) => node.tag === 'textarea')[0].value = 'Both photos show the same delivery van.';
    routes[`POST ${JOB_URL}/variants/${VID2}/era`] = () => Promise.resolve(json(200, alt));
    f.button('Save time assertion').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/variants/${VID2}/era`).length, 0, 'not sent without the owner’s confirmation');
    f.checkboxes()[0].checked = true;
    f.button('Save time assertion').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/variants/${VID2}/era`);
    assert.deepEqual(sent.body, {
      requestId: sent.body.requestId,
      kind: 'relative',
      label: 'same afternoon',
      start: null,
      end: null,
      relation: 'same-time',
      relativeToVariantId: VID,
      statement: 'Both photos show the same delivery van.',
      confirmed: true,
      baseRevision: 0,
    });
    assert.match(ui.message(), /no order between scenes was inferred/);
  });

  it('clears its preview and ignores late responses when closed', async () => {
    const { view, b, ui, root, setDecision } = await mount();
    ui.button('Review').dispatch('click');
    setDecision('alternative');
    ui.button('Preview candidate on the scene').dispatch('click');
    let respond;
    routes[`GET ${JOB_URL}/collaboration`] = () => new Promise((resolve) => (respond = resolve));
    view.refresh();
    view.dispose();
    assert.deepEqual(b.calls.slice(-2), [['show', null], ['lock', false]]);
    respond(json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 }));
    await settle();
    assert.equal(root.children.length, 0);
  });
});

describe('blocked scene', () => {
  it('offers only unaffected saved versions and restores one as a new version', async () => {
    routes[`GET ${JOB_URL}/history`] = () =>
      Promise.resolve(
        json(200, [
          { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', blocked: false },
          { version: 2, offset: [1, 0, 0], yaw: 0, kind: 'contribution', blocked: true },
          { version: 3, offset: [1, 0.5, 0], yaw: 0, kind: 'manual', blocked: true },
        ]),
      );
    const root = new FakeElement('div');
    let restored = 0;
    mountBlockedScene(root, { jobUrl: JOB_URL, currentVersion: 3, onRestored: () => (restored += 1) });
    await settle();
    const ui = finder(root);
    assert.ok(ui.button('Restore version 1'));
    assert.equal(ui.button('Restore version 2'), undefined);
    assert.equal(ui.button('Restore version 3'), undefined);
    routes[`POST ${JOB_URL}/undo`] = lost;
    ui.button('Restore version 1').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm the restore/);
    routes[`POST ${JOB_URL}/undo`] = () => Promise.resolve(json(200, { version: 4, offset: [0, 0, 0], yaw: 0 }));
    ui.button('Restore version 1').dispatch('click');
    await settle();
    const sent = posts(`${JOB_URL}/undo`);
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.deepEqual(sent[0].body, { requestId: sent[0].body.requestId, baseVersion: 3, targetVersion: 1 });
    assert.equal(restored, 1);
  });
});
