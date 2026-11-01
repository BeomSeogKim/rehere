import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { STOPPED_TEXT, cancellationText, impactText, isStopped, mountSourceControls, renderStoppedMarker } from '../public/source-controls.js';

const DRAFT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const URL_ = `/api/drafts/${DRAFT}/sources/${SOURCE}/policy`;

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const policy = (overrides = {}) => ({
  sourceId: SOURCE,
  revision: 0,
  permissions: { place: true, model: true, share: false },
  stopped: false,
  updatedAt: null,
  changedBy: null,
  impacts: { scenes: 2, snapshots: 1, processing: 1 },
  ...overrides,
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
  routes = { [`GET ${URL_}`]: () => Promise.resolve(json(200, policy())) };
});

async function mount() {
  const root = new FakeElement('div');
  const changes = [];
  const view = mountSourceControls(root, { draftId: DRAFT, sourceId: SOURCE, label: 'photo 1', onChanged: (next, notice) => changes.push({ next, notice }) });
  await settle();
  const find = (predicate) => root.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const boxes = () => find((node) => node.tag === 'input' && node.type === 'checkbox');
  const message = () => find((node) => node.className === 'form-message')[0].textContent;
  return { root, view, changes, find, button, boxes, message };
}

const posts = () => requests.filter((r) => r.method === 'POST');

describe('source control helpers', () => {
  it('recognises stopped records and describes cancellation and impact honestly', () => {
    assert.equal(isStopped({ policy: { stopped: true } }), true);
    assert.equal(isStopped({ policy: { stopped: false } }), false);
    assert.equal(isStopped(null), false);
    assert.equal(cancellationText({ status: 'not-running' }), '');
    assert.match(cancellationText({ status: 'requested' }), /cannot be recalled/);
    assert.match(cancellationText({ status: 'unconfirmed' }), /restriction is saved/);
    assert.equal(impactText({ scenes: 1, snapshots: 0, processing: 2 }), 'Currently used by 1 scene and 0 shared links, with 2 pieces of work in progress.');
    assert.match(impactText(null), /could not count/);
    assert.equal(impactText({ scenes: 2, stories: 1, snapshots: 3, processing: 0 }), 'Currently used by 2 scenes, 1 recorded story and 3 shared links, with 0 pieces of work in progress.');
    assert.equal(
      impactText({ scenes: 1, stories: 0, linkedRegions: 2, snapshots: 0, processing: 0 }),
      'Currently used by 1 scene, 0 recorded stories, 2 linked photo regions and 0 shared links, with 0 pieces of work in progress.',
    );
    assert.equal(
      impactText({ scenes: 1, linkedRegions: null, snapshots: 1, processing: 0 }),
      'Currently used by 1 scene and 1 shared link, with 0 pieces of work in progress. Linked photo regions could not be counted.',
      'an unreadable count is said to be unknown, never zero, and the other counts stay',
    );
  });

  it('marks stopped material by provider and checksum only', () => {
    const marker = renderStoppedMarker({ id: SOURCE, kind: 'photo', provider: 'Owner', sha256: 'a'.repeat(64), policy: { stopped: true } });
    assert.match(marker.textContent, /no longer used anywhere in Rehere\. The original is kept, not deleted\./);
    assert.match(marker.textContent, /Provided by Owner/);
    assert.match(marker.textContent, /a{64}/);
  });
});

describe('source use controls', () => {
  it('lets the owner only narrow current uses; a disallowed use cannot be checked', async () => {
    const ui = await mount();
    const [place, model, share] = ui.boxes();
    assert.deepEqual([place.checked, model.checked, share.checked], [true, true, false]);
    assert.deepEqual([place.disabled, model.disabled, share.disabled], [false, false, true]);
    assert.equal(ui.button('Save narrower uses').disabled, true);
    share.checked = true;
    share.dispatch('change');
    model.checked = false;
    model.dispatch('change');
    routes[`POST ${URL_}`] = () => Promise.resolve(json(200, { saved: true, ...policy({ revision: 1, permissions: { place: true, model: false, share: false } }), cancellation: { requested: true, status: 'requested' } }));
    ui.button('Save narrower uses').dispatch('click');
    await settle();
    const [sent] = posts();
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseRevision: 0, permissions: { place: true, model: false, share: false }, stopUse: false });
    assert.match(ui.message(), /narrower uses apply now\. Stopping work already in progress was requested/);
    assert.equal(ui.changes.length, 1);
    assert.match(ui.changes[0].notice, /Stopping work already in progress was requested/, 'the page receives the notice to keep');
  });

  it('repeats the exact request after an unknown outcome, and re-reads after a conflict without overwriting', async () => {
    const ui = await mount();
    const model = ui.boxes()[1];
    model.checked = false;
    model.dispatch('change');
    routes[`POST ${URL_}`] = lost;
    ui.button('Save narrower uses').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm whether this was saved/);
    routes[`POST ${URL_}`] = () => Promise.resolve(json(409, { error: 'The policy changed.' }));
    ui.button('Save narrower uses').dispatch('click');
    await settle();
    const sent = posts();
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.match(ui.message(), /The policy changed\. Review them again before saving\./);
    assert.equal(requests.filter((r) => r.method === 'GET').length, 2, 're-read after the conflict');
    assert.equal(ui.changes.length, 0);
  });

  it('stops use only after a second press that shows the impact, and then offers no controls', async () => {
    const ui = await mount();
    ui.button('Stop using this material').dispatch('click');
    assert.equal(posts().length, 0);
    assert.match(ui.root.textContent, /Currently used by 2 scenes and 1 shared link, with 1 piece of work in progress\./);
    assert.match(ui.root.textContent, /cannot be undone\. The original stays stored and is not deleted\./);
    routes[`POST ${URL_}`] = () => Promise.resolve(json(200, { saved: true, ...policy({ revision: 1, stopped: true, permissions: { place: false, model: false, share: false } }), cancellation: { requested: true, status: 'unconfirmed' } }));
    ui.button('Stop using it').dispatch('click');
    await settle();
    const [sent] = posts();
    assert.deepEqual(sent.body, { requestId: sent.body.requestId, baseRevision: 0, permissions: { place: false, model: false, share: false }, stopUse: true });
    assert.match(ui.root.textContent, new RegExp(STOPPED_TEXT.replace(/[.]/g, '\\.')));
    assert.match(ui.message(), /could not confirm that work in progress stopped\. The restriction is saved/);
    assert.equal(ui.boxes().length, 0);
    assert.equal(ui.button('Stop using this material'), undefined);
    assert.equal(ui.changes.length, 1);
  });

  it('passes a policy changed elsewhere up to the page after a conflict, once', async () => {
    const ui = await mount();
    const model = ui.boxes()[1];
    model.checked = false;
    model.dispatch('change');
    routes[`POST ${URL_}`] = () => Promise.resolve(json(409, { error: 'The policy changed.' }));
    routes[`GET ${URL_}`] = () => Promise.resolve(json(200, policy({ revision: 1, stopped: true, permissions: { place: false, model: false, share: false } })));
    ui.button('Save narrower uses').dispatch('click');
    await settle();
    assert.equal(ui.changes.length, 1);
    assert.equal(ui.changes[0].next.stopped, true);
    assert.match(ui.changes[0].notice, /Review them again/);
    assert.match(ui.root.textContent, /no longer used anywhere in Rehere/);
  });

  it('reports a newer policy found on the first read, and nothing for the revision the page already has', async () => {
    routes[`GET ${URL_}`] = () => Promise.resolve(json(200, policy({ revision: 1, stopped: true, permissions: { place: false, model: false, share: false } })));
    for (const [known, expected] of [[0, 1], [1, 0], [null, 0]]) {
      const root = new FakeElement('div');
      const changes = [];
      const view = mountSourceControls(root, { draftId: DRAFT, sourceId: SOURCE, label: 'photo 1', knownRevision: known, onChanged: (next, notice) => changes.push({ next, notice }) });
      await settle();
      assert.equal(changes.length, expected, `known revision ${known}`);
      if (expected) assert.match(changes[0].notice, /changed since this memory was opened/);
      view.dispose();
    }
  });

  it('drops a policy read that arrives after it was closed', async () => {
    let respond;
    routes[`GET ${URL_}`] = () => new Promise((resolve) => (respond = resolve));
    const root = new FakeElement('div');
    const view = mountSourceControls(root, { draftId: DRAFT, sourceId: SOURCE, label: 'photo 1' });
    view.dispose();
    respond(json(200, policy()));
    await settle();
    assert.equal(root.children.length, 0);
  });
});
