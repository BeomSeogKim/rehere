import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// A contributor's photo with their written recollection: sent only on Send,
// with its own uses, repeated exactly while its outcome is unknown, reviewed
// by the owner beside the scene, and optionally shown to visitors.
installViewerShim();

const DRAFT = '11111111-1111-4111-8111-111111111111';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_URL = `/api/drafts/${DRAFT}/reconstructions/${JOB}`;
const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLACE = { draftId: DRAFT, jobId: JOB, label: 'Saved place 11111111', version: 1 };
const PRINCIPAL = { id: 'p-contrib', role: 'contributor', displayName: 'Mina' };
const STORE_KEY = `rehere:contribution-pending:p-contrib:${DRAFT}:${JOB}`;
const PHOTO_URL = `${JOB_URL}/contributions/${CID}/photo`;

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) });
const image = () => ({ status: 200, ok: true, json: async () => ({}), blob: async () => new Blob(['review-jpeg'], { type: 'image/jpeg' }) });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const jpeg = (name = 'shop.jpg') => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], name, { type: 'image/jpeg', lastModified: Date.UTC(2020, 0, 2) });

let requests;
let routes;
let storage;
let created;
let revoked;

before(() => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = async (url, options = {}) => {
    let body = null;
    let file = null;
    if (options.body instanceof FormData) {
      body = JSON.parse(options.body.get('payload'));
      file = options.body.get('photo');
    } else if (typeof options.body === 'string') body = JSON.parse(options.body);
    requests.push({ url, method: options.method ?? 'GET', body, file, form: options.body instanceof FormData ? [...options.body.keys()] : null });
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
  created = [];
  revoked = [];
  const realCreate = URL.createObjectURL;
  mock.method(URL, 'createObjectURL', (blob) => {
    const url = realCreate(blob);
    created.push(url);
    return url;
  });
  mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
});

const finder = (root) => {
  const find = (predicate) => root.findAll(predicate);
  return {
    find,
    button: (text) => find((node) => node.tag === 'button' && node.textContent === text)[0],
    message: () => find((node) => node.className?.startsWith('form-message')).map((node) => node.textContent).join(' '),
    legendSet: (legend) => find((node) => node.tag === 'fieldset' && node.children[0]?.textContent === legend)[0],
  };
};
const posts = (url) => requests.filter((r) => r.method === 'POST' && r.url === url);

function contribution(overrides = {}) {
  return {
    id: CID,
    principalId: 'p-contrib',
    provider: { displayName: 'Mina' },
    kind: 'human_recollection',
    text: 'The counter faced the window.',
    textSha256: 'a'.repeat(64),
    permissions: { place: true, model: false, share: true },
    periodClaim: '',
    createdAt: '2026-10-31T00:00:00.000Z',
    revision: 1,
    status: 'submitted',
    review: null,
    withdrawnAt: null,
    photo: {
      available: true,
      type: 'image/jpeg',
      width: 4000,
      height: 3000,
      review: { width: 2048, height: 1536 },
      origin: { kind: 'own', reference: 'family album' },
      dates: { capturedOn: '1998-07-01', fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: 'summer' },
      permissions: { place: true, model: false, share: true },
      receivedAt: '2026-10-31T00:00:00.000Z',
      url: PHOTO_URL,
    },
    ...overrides,
  };
}

describe('contributor photo bundle', () => {
  async function mount(own = []) {
    routes['GET /api/contributor/places'] = () => json(200, [PLACE]);
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: own, variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${PHOTO_URL}`] = () => image();
    const { mountContributor } = await import('../public/collaboration.js');
    const root = new FakeElement('div');
    const view = mountContributor(root, { principal: PRINCIPAL });
    await settle();
    const ui = finder(root);
    const choose = async (file) => {
      const input = ui.find((node) => node.tag === 'input' && node.type === 'file')[0];
      input.files = [file];
      input.dispatch('change');
      await settle();
    };
    const fill = () => {
      ui.find((node) => node.tag === 'textarea')[0].value = 'The counter faced the window.\n';
      ui.legendSet('Allowed uses of your words').findAll((node) => node.type === 'checkbox')[0].checked = true;
    };
    const photoBoxes = () => ui.legendSet('Allowed uses of your photo').findAll((node) => node.type === 'checkbox');
    return { view, root, ui, choose, fill, photoBoxes };
  }

  it('sends nothing on choosing a photo, then one multipart request with the photo’s own uses and source facts', async () => {
    const { ui, choose, fill, photoBoxes } = await mount();
    const before = requests.length;
    await choose(jpeg());
    assert.equal(requests.length, before, 'choosing a photo sends nothing');
    assert.ok(photoBoxes().every((box) => !box.checked), 'photo uses start off');
    fill();
    photoBoxes()[2].checked = true;
    ui.find((node) => node.tag === 'select')[1].value = 'public';
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(201, contribution());
    ui.button('Send recollection').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/photo`);
    assert.deepEqual(sent.form, ['payload', 'photo']);
    assert.equal(sent.file.name, 'shop.jpg');
    assert.deepEqual(sent.body, {
      requestId: sent.body.requestId,
      text: 'The counter faced the window.\n',
      periodClaim: '',
      permissions: { place: true, model: false, share: false },
      photo: {
        origin: { kind: 'public', reference: '' },
        dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: '2020-01-02T00:00:00.000Z', estimatedPeriod: '' },
        permissions: { place: false, model: false, share: true },
      },
    });
    assert.match(ui.message(), /^Sent\./);
    assert.ok(created.every((url) => revoked.includes(url) || url === created.at(-1)), 'the chosen photo preview is released');
    assert.equal(storage.size, 0, 'nothing is left in the browser');
  });

  it('repeats an unknown send with the same ID and photo, keeping only that opaque ID in the browser', async () => {
    const { ui, choose, fill } = await mount();
    await choose(jpeg());
    fill();
    routes[`POST ${JOB_URL}/contributions/photo`] = () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError('not json'); } });
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm whether it arrived/);
    const [first] = posts(`${JOB_URL}/contributions/photo`);
    assert.equal(storage.get(STORE_KEY), first.body.requestId, 'only the request ID is kept');
    assert.equal([...storage.values()].join('').includes('counter'), false);
    routes[`POST ${JOB_URL}/contributions/photo`] = () => ({ status: 400, ok: false, json: async () => null });
    ui.button('Send again (same request)').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm/, 'a rejection without a readable error is still unknown');
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(201, contribution());
    ui.button('Send again (same request)').dispatch('click');
    await settle();
    const sent = posts(`${JOB_URL}/contributions/photo`);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[2].body, sent[0].body, 'the same request');
    assert.equal(sent[2].file, sent[0].file);
    assert.equal(storage.size, 0);
  });

  it('keeps the ID through a busy refusal until the own record is checked, and starts anew only when asked', async () => {
    const { ui, choose, fill } = await mount();
    await choose(jpeg());
    fill();
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(409, { error: 'Another photo is being prepared. Try again shortly.' });
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.match(ui.message(), /Another photo is being prepared\. Try again shortly\. It is not in your recollections yet/);
    assert.ok(requests.filter((r) => r.url === `${JOB_URL}/collaboration`).length >= 2, 'the own record was checked');
    const [first] = posts(`${JOB_URL}/contributions/photo`);
    ui.button('Send again (same request)').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/contributions/photo`)[1].body.requestId, first.body.requestId, 'no new ID after a busy answer');
    ui.button('Start a new submission instead').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(201, contribution());
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.notEqual(posts(`${JOB_URL}/contributions/photo`)[2].body.requestId, first.body.requestId, 'only an explicit new submission gets a new ID');
  });

  it('after a reload, settles a pending ID from the own record, or explains how to retry it exactly', async () => {
    storage.set(STORE_KEY, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    const found = await mount([contribution({ requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })]);
    await settle();
    assert.match(found.ui.message(), /Your earlier recollection arrived/);
    assert.equal(storage.size, 0);
    found.view.dispose();

    storage.set(STORE_KEY, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    const missing = await mount([]);
    await settle();
    assert.match(missing.ui.message(), /no record of your earlier recollection yet\. To retry it exactly, enter the same words and settings and choose the same photo/);
    missing.fill();
    routes[`POST ${JOB_URL}/contributions`] = () => json(201, contribution({ photo: null }));
    missing.ui.button('Send again (same request)').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/contributions`)[0].body.requestId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'the pending ID, not a new one');
  });

  it('refuses a file that is not a JPEG or PNG without sending anything', async () => {
    const { ui, choose } = await mount();
    const before = requests.length;
    await choose(new File(['GIF89a....'], 'x.gif', { type: 'image/gif' }));
    assert.match(ui.message(), /Choose a JPEG or PNG photo/);
    assert.equal(requests.length, before);
  });

  it('leaves PNG variants to the server, and on its refusal suggests a JPEG or 8-bit PNG', async () => {
    const { ui, choose, fill } = await mount();
    const header = new Uint8Array(32);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4, 16, 6]);
    await choose(new File([header], 'deep.png', { type: 'image/png' }));
    assert.doesNotMatch(ui.message(), /16-bit|PNG/, 'a 16-bit PNG is not refused by the page');
    fill();
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(400, { error: 'This photo cannot be used.' });
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.equal(ui.message(), 'This photo cannot be used. If the photo is not accepted, export it as a JPEG or an 8-bit PNG and try again.');
  });

  it('repeats exactly what was sent after an unknown outcome, and keeps newer edits when it finally arrives', async () => {
    const { ui, choose, fill } = await mount();
    await choose(jpeg('first.jpg'));
    fill();
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(0, null);
    ui.button('Send recollection').dispatch('click');
    await settle();
    const textArea = ui.find((node) => node.tag === 'textarea')[0];
    textArea.value = 'Edited after the unknown send.';
    await choose(jpeg('second.jpg'));
    let answer;
    routes[`POST ${JOB_URL}/contributions/photo`] = () => new Promise((resolve) => (answer = resolve));
    ui.button('Send again (same request)').dispatch('click');
    await settle();
    const [first, second] = posts(`${JOB_URL}/contributions/photo`);
    assert.deepEqual(second.body, first.body, 'the same payload, not the edited form');
    assert.equal(second.file.name, 'first.jpg', 'and the same photo');
    textArea.value = 'Edited while it was being sent.';
    answer(json(201, contribution()));
    await settle();
    assert.equal(textArea.value, 'Edited while it was being sent.', 'newer edits are not cleared');
    assert.match(ui.message(), /newer changes are still in the form/);
  });

  it('does not take a success it cannot read as sent', async () => {
    const { ui, choose, fill } = await mount();
    await choose(jpeg());
    fill();
    routes[`POST ${JOB_URL}/contributions/photo`] = () => ({ status: 201, ok: true, json: async () => { throw new SyntaxError('cut off'); } });
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm whether it arrived/);
    assert.ok(storage.get(STORE_KEY), 'the ID is kept');
    assert.equal(ui.find((node) => node.tag === 'textarea')[0].value, 'The counter faced the window.\n', 'the form is kept');
    assert.ok(ui.button('Send again (same request)'));
  });

  it('keeps the newer photo when an earlier file check finishes late', async () => {
    const { ui, choose, fill } = await mount();
    let finish;
    const slow = { name: 'a.jpg', size: 8, lastModified: 0, slice: () => ({ arrayBuffer: () => new Promise((resolve) => (finish = resolve)) }) };
    const input = ui.find((node) => node.tag === 'input' && node.type === 'file')[0];
    input.files = [slow];
    input.dispatch('change');
    await choose(jpeg('b.jpg'));
    finish(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).buffer);
    await settle();
    fill();
    routes[`POST ${JOB_URL}/contributions/photo`] = () => json(201, contribution());
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/contributions/photo`)[0].file.name, 'b.jpg');
  });

  it('releases an own-list photo that finishes loading after the screen closed', async () => {
    let release;
    const { view } = await mount([]);
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${PHOTO_URL}`] = () => new Promise((resolve) => (release = () => resolve(image())));
    const { mountContributor } = await import('../public/collaboration.js');
    const root = new FakeElement('div');
    const late = mountContributor(root, { principal: PRINCIPAL });
    await settle();
    late.dispose();
    view.dispose();
    release();
    await settle();
    assert.equal(created.filter((url) => !revoked.includes(url)).length, 0, 'no object URL outlives the screen');
  });

  it('never sends one place’s attempt under another place’s pending ID', async () => {
    const B_DRAFT = '22222222-2222-4222-8222-222222222222';
    const B_URL = `/api/drafts/${B_DRAFT}/reconstructions/${JOB}`;
    const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    storage.set(`rehere:contribution-pending:p-contrib:${B_DRAFT}:${JOB}`, B_ID);
    routes['GET /api/contributor/places'] = () => json(200, [PLACE, { draftId: B_DRAFT, jobId: JOB, label: 'Saved place 22222222', version: 1 }]);
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [], variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${B_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [], variants: [], blocked: false, currentVersion: 1 });
    const { mountContributor } = await import('../public/collaboration.js');
    const root = new FakeElement('div');
    const view = mountContributor(root, { principal: PRINCIPAL });
    await settle();
    const ui = finder(root);
    const placeSelect = ui.find((node) => node.tag === 'select')[0];
    const textArea = () => ui.find((node) => node.tag === 'textarea')[0];
    placeSelect.value = `${DRAFT}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
    textArea().value = 'Words for place A.';
    routes[`POST ${JOB_URL}/contributions`] = () => json(0, null);
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.ok(ui.button('Send again (same request)'), 'A is uncertain');
    placeSelect.value = `${B_DRAFT}/${JOB}`;
    placeSelect.dispatch('change');
    await settle();
    textArea().value = 'Words for place B.';
    routes[`POST ${B_URL}/contributions`] = () => json(201, contribution({ photo: null }));
    ui.button('Send again (same request)').dispatch('click');
    await settle();
    const [sent] = posts(`${B_URL}/contributions`);
    assert.equal(sent.body.requestId, B_ID, 'B’s own pending ID');
    assert.equal(sent.body.text, 'Words for place B.', 'never A’s payload');
    view.dispose();
  });

  it('starts a different photo with unknown facts and no uses, keeps the same file’s, and leaves the words’ uses alone', async () => {
    const { ui, choose, fill, photoBoxes } = await mount();
    const first = jpeg('first.jpg');
    await choose(first);
    fill();
    photoBoxes()[0].checked = true;
    photoBoxes()[2].checked = true;
    const origin = () => ui.find((node) => node.tag === 'select')[1];
    origin().value = 'public';
    const reference = () => ui.find((node) => node.tag === 'input' && node.type === 'text')[1];
    reference().value = 'family album';
    await choose(first);
    assert.deepEqual(photoBoxes().map((box) => box.checked), [true, false, true], 'the same file keeps its settings');
    assert.equal(origin().value, 'public');
    await choose(jpeg('second.jpg'));
    assert.deepEqual(photoBoxes().map((box) => box.checked), [false, false, false], 'a different original starts with no uses');
    assert.equal(origin().value, 'unknown');
    assert.equal(reference().value, '');
    const words = ui.legendSet('Allowed uses of your words').findAll((node) => node.type === 'checkbox');
    assert.equal(words[0].checked, true, 'the words’ uses are untouched');

    // A refused choice leaves no photo, so nothing stale is sent.
    await choose(new File(['GIF89a....'], 'x.gif', { type: 'image/gif' }));
    assert.match(ui.message(), /Choose a JPEG or PNG photo/);
    assert.equal(ui.find((node) => node.tag === 'img' && node.alt === 'The photo you chose')[0].hidden, true);
    routes[`POST ${JOB_URL}/contributions`] = () => json(201, contribution({ photo: null }));
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/contributions/photo`).length, 0);
    assert.equal(posts(`${JOB_URL}/contributions`).length, 1, 'sent as words only');
  });

  it('shows the photo it sent and says withdrawal covers the words and the photo', async () => {
    const { root, ui } = await mount([contribution()]);
    await settle();
    assert.match(root.textContent, /Your photo · photo allowed: use to reconstruct this place; share with others\./);
    assert.equal(ui.find((node) => node.tag === 'img' && node.alt?.startsWith('Your photo')).length, 1);
    ui.button('Withdraw').dispatch('click');
    assert.ok(ui.button('Withdraw this recollection and its photo'));
    assert.match(root.textContent, /these words and this photo/);
  });
});

describe('owner review of a photo bundle', () => {
  async function mount(entry = contribution()) {
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [entry], variants: [], blocked: false, currentVersion: 1 });
    let release;
    routes[`GET ${PHOTO_URL}`] = () => new Promise((resolve) => (release = () => resolve(image())));
    const { mountCollaboration } = await import('../public/collaboration.js');
    const root = new FakeElement('section');
    const b = {
      jobUrl: JOB_URL,
      state: { version: 1, offset: [0, 0, 0], yaw: 0, clean: true },
      editor: () => ({ ...b.state }),
      calls: [],
      showTransform: (transform) => {
        b.calls.push(transform);
        return Boolean(transform);
      },
      setLocked() {},
      saved(edit) {
        b.state = { ...edit, clean: true };
      },
      unconfirmed() {},
      conflict() {},
      blocked() {},
    };
    const view = mountCollaboration(root, b);
    await settle();
    const ui = finder(root);
    const decide = (value) => {
      const select = ui.find((node) => node.tag === 'select')[0];
      select.value = value;
      select.dispatch('change');
    };
    const ack = () => ui.find((node) => node.tag === 'label' && /I compared this photo with the current scene myself/.test(node.textContent))[0]?.children[0];
    // The browser's own answer to the image: it decoded, or it is broken.
    const imageEvent = async (type) => {
      await settle();
      ui.find((node) => node.tag === 'img')[0]?.dispatch(type);
      await settle();
    };
    return { view, root, ui, b, decide, ack, imageEvent, release: () => release?.() };
  }

  it('loads the photo only for review and records the owner’s own comparison for a change', async () => {
    const { root, ui, decide, ack, release, imageEvent } = await mount();
    assert.match(root.textContent, /Photo included · photo allowed/);
    assert.equal(requests.filter((r) => r.url === PHOTO_URL).length, 0, 'not loaded with the list');
    ui.button('Review').dispatch('click');
    assert.equal(requests.filter((r) => r.url === PHOTO_URL).length, 1);
    assert.match(root.textContent, /Photo supplied by Mina, shown without file details\. Where it comes from, as they say: My own photo \(family album\)\. Date taken, as they say: 1998-07-01\. Period, as they say: summer\. Not checked as historical fact; Rehere does not compare it with the scene\./);
    decide('adopt');
    assert.equal(ui.button('Preview candidate on the scene').disabled, true, 'not before the photo has loaded');
    release();
    await settle();
    assert.match(root.textContent, /Loading the photo…Preview candidate/, 'the fetched image is not yet decoded');
    ack().checked = true;
    ack().dispatch('change');
    assert.equal(ui.button('Preview candidate on the scene').disabled, true, 'with the acknowledgment, still not before the image has actually decoded');
    await imageEvent('load');
    assert.equal(ui.find((node) => node.tag === 'img' && !node.hidden).length, 1);
    assert.equal(ui.button('Preview candidate on the scene').disabled, false, 'decoded and acknowledged');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Candidate Left / right')[0];
    x.value = '0.3';
    x.dispatch('input');
    ui.button('Preview candidate on the scene').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => json(200, { contribution: contribution({ status: 'adopted' }), edit: { version: 2, offset: [0.3, 0, 0], yaw: 0 } });
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/${CID}/review`);
    assert.equal(sent.body.photoReviewed, true);
    assert.equal(sent.body.decision, 'adopt');
  });

  it('records no acknowledgment for a decision that changes nothing', async () => {
    const { ui, decide, release } = await mount();
    ui.button('Review').dispatch('click');
    release();
    await settle();
    decide('hold');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => json(200, { contribution: contribution({ status: 'held' }) });
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/${CID}/review`);
    assert.equal('photoReviewed' in sent.body, false);
  });

  it('refuses a change from a photo without its place use, or one that is not available, while hold still works', async () => {
    const noPlace = await mount(contribution({ photo: { ...contribution().photo, permissions: { place: false, model: false, share: true } } }));
    noPlace.ui.button('Review').dispatch('click');
    noPlace.release();
    await noPlace.imageEvent('load');
    noPlace.decide('alternative');
    assert.match(noPlace.root.textContent, /The photo’s provider did not allow use to reconstruct the place/);
    assert.equal(noPlace.ui.button('Save decision').disabled, true);
    noPlace.view.dispose();

    const unavailable = await mount(contribution({ photo: { ...contribution().photo, available: false, url: null } }));
    const fetched = requests.filter((r) => r.url === PHOTO_URL).length;
    unavailable.ui.button('Review').dispatch('click');
    await settle();
    assert.equal(requests.filter((r) => r.url === PHOTO_URL).length, fetched, 'nothing is fetched for an unavailable photo');
    unavailable.decide('adopt');
    assert.match(unavailable.root.textContent, /This photo is not available now, so it cannot support a change/);
    assert.equal(unavailable.ui.button('Save decision').disabled, true);
    unavailable.decide('hold');
    assert.equal(unavailable.ui.button('Save decision').disabled, false);
  });

  it('treats a photo that will not decode as unavailable and undoes the acknowledgment', async () => {
    const { root, ui, decide, ack, release, imageEvent } = await mount();
    ui.button('Review').dispatch('click');
    decide('adopt');
    ack().checked = true;
    ack().dispatch('change');
    release();
    await imageEvent('error');
    assert.match(root.textContent, /This photo is not available now, so it cannot support a change/);
    assert.equal(ack().checked, false);
    assert.equal(ui.button('Preview candidate on the scene').disabled, true);
  });

  it('rebuilds the review when the photo becomes unavailable at the same revision, dropping the candidate', async () => {
    const { view, root, ui, b, decide, ack, release, imageEvent } = await mount();
    ui.button('Review').dispatch('click');
    release();
    await imageEvent('load');
    decide('alternative');
    ack().checked = true;
    ack().dispatch('change');
    const x = ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === 'Candidate Left / right')[0];
    x.value = '0.3';
    x.dispatch('input');
    ui.button('Preview candidate on the scene').dispatch('click');
    assert.ok(b.calls.at(-1), 'a candidate is shown');
    const before = ui.find((node) => node.tag === 'img')[0].src;
    routes[`GET ${JOB_URL}/collaboration`] = () =>
      json(200, { revision: 1, contributions: [contribution({ photo: { ...contribution().photo, available: false, url: null } })], variants: [], blocked: false, currentVersion: 1 });
    view.refresh();
    await settle();
    assert.equal(b.calls.at(-1), null, 'the candidate is taken off the scene');
    assert.ok(revoked.includes(before), 'the old image is released');
    assert.equal(ui.find((node) => node.tag === 'img').length, 0);
    assert.match(root.textContent, /This photo is not available now/);
    decide('alternative');
    assert.equal(ui.button('Save decision').disabled, true);
  });

  it('releases the photo copy when the panel closes, and drops a load that answers late', async () => {
    const shown = await mount();
    shown.ui.button('Review').dispatch('click');
    shown.release();
    await shown.imageEvent('load');
    const url = shown.ui.find((node) => node.tag === 'img')[0].src;
    shown.view.dispose();
    assert.ok(revoked.includes(url));

    const late = await mount();
    late.ui.button('Review').dispatch('click');
    late.view.dispose();
    late.release();
    await settle();
    assert.equal(created.filter((entry) => !revoked.includes(entry)).length, 0, 'a late copy is released at once');
  });
});

describe('sharing a contributor photo with visitors', () => {
  it('offers only photos of recollections the chosen views depend on, none chosen, and sends the choice', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () =>
      json(200, { revision: 1, contributions: [contribution(), contribution({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', provider: { displayName: 'Jun' } })], variants: [], blocked: false, currentVersion: 2 });
    routes[`GET ${JOB_URL}/history`] = () => json(200, [{ version: 1, dependencies: [], blocked: false }, { version: 2, dependencies: [CID], blocked: false }]);
    routes[`GET ${JOB_URL}/stories`] = () => json(200, { stories: [] });
    routes[`GET ${JOB_URL}/shares`] = () => json(200, []);
    routes[`POST ${JOB_URL}/shares/previews`] = () => json(400, { error: 'Not in this test.' });
    const { mountShares } = await import('../public/shares.js');
    const root = new FakeElement('section');
    const view = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 2 }), getCamera: () => ({ position: [0, 0, 0], target: [0, 0, -3] }) });
    await settle();
    const ui = finder(root);
    const photos = () => ui.legendSet('Contributor photos to show (optional)').findAll((node) => node.type === 'checkbox');
    assert.equal(photos().length, 1, 'only Mina’s photo: version 2 depends on it, Jun’s is not a dependency');
    assert.equal(photos()[0].checked, false, 'nothing chosen by default');
    assert.match(root.textContent, /Photo supplied by Mina/);
    assert.match(root.textContent, /still needs both permissions to be shared even when the photo is not shown/);
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'The shop';
    ui.button('Use the current camera view').dispatch('click');
    photos()[0].checked = true;
    ui.button('Preview what visitors will see').dispatch('click');
    await settle();
    assert.deepEqual(posts(`${JOB_URL}/shares/previews`)[0].body.evidencePhotoIds, [CID]);
    view.dispose();
  });
});

describe('a contributor photo for visitors', () => {
  it('shows only the current view’s photos, collapsed and loaded on request, and releases them on view change', async () => {
    const { mountVisitor } = await import('../public/visits.js');
    const START = 'v1';
    const OTHER = 'v2';
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
      startViewId: START,
      camera: { position: [0, 0, 0], target: [0, 0, -3] },
      views: [view(START, 'Saved scene'), view(OTHER, 'Mina’s recollection')],
      contributorPhotos: [{ id: 'e1', providerLabel: 'Mina', label: 'Photo supplied by a contributor. Not automatically matched; not verified history.', viewIds: [OTHER], asset: { viewId: 'evidence', name: '1.jpg' }, width: 2048, height: 1536 }],
    };
    const assets = [];
    const source = {
      manifest: async () => manifest,
      check: async () => true,
      asset: async (viewId, name) => {
        assets.push(`${viewId}/${name}`);
        return name === 'surface.json' ? json(200, visitorSurface()) : image();
      },
      storyAudio: async () => null,
    };
    globalThis.viewerLog = [];
    const root = new FakeElement('div');
    const visitor = mountVisitor(root, source);
    try {
      await settle();
      const ui = finder(root);
      assert.doesNotMatch(root.textContent, /Contributor photos/, 'not shown with an unrelated view');
      ui.button('Mina’s recollection').dispatch('click');
      const section = ui.find((node) => node.tag === 'details' && /Contributor photos \(1\)/.test(node.textContent))[0];
      assert.notEqual(section.open, true, 'collapsed');
      assert.equal(assets.includes('evidence/1.jpg'), false, 'nothing fetched until opened');
      assert.match(root.textContent, /Mina: Photo supplied by a contributor\. Not automatically matched; not verified history\./);
      assert.doesNotMatch(root.textContent, /e1|1\.jpg/);
      section.dispatch('toggle');
      await settle();
      assert.equal(assets.includes('evidence/1.jpg'), false, 'a toggle that leaves it closed fetches nothing');
      section.open = true;
      section.dispatch('toggle');
      await settle();
      assert.ok(assets.includes('evidence/1.jpg'));
      const url = ui.find((node) => node.tag === 'img' && node.alt === 'Photo supplied by Mina')[0].src;
      ui.button('Saved scene').dispatch('click');
      assert.ok(revoked.includes(url), 'released on view change');
      assert.doesNotMatch(root.textContent, /Contributor photos/);
    } finally {
      // The heartbeat timer must not outlive the test, even on failure.
      visitor.dispose();
    }
  });
});
