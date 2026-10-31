import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// stories.js reaches the 3D viewer through shares.js and visits.js.
installViewerShim();
const { cuesProblem, mountStories, parseTime, usableVoices } = await import('../public/stories.js');

const JOB_URL = '/api/drafts/11111111-1111-4111-8111-111111111111/reconstructions/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const voice = (overrides = {}) => ({ id: VOICE, kind: 'voice', provider: 'Owner', permissions: { place: true, model: false, share: false }, policy: { revision: 0, stopped: false }, ...overrides });
const readyStory = (overrides = {}) => ({
  id: 'st1',
  status: 'ready',
  available: true,
  blockedReason: null,
  title: 'Morning bell',
  target: { id: 'selected-foreground', label: 'Selected foreground object' },
  view: { kind: 'version', version: 1, variantId: null, eraRevision: null, label: 'Saved version 1', era: null },
  voice: { sourceId: VOICE, provider: 'Owner' },
  captionAuthor: { displayName: 'Owner' },
  cues: [{ startMs: 0, endMs: 1000, text: 'Synthetic test tone; no speech.' }],
  durationMs: 1000,
  audio: { type: 'audio/wav', size: 2044 },
  error: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  withdrawnAt: null,
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
  routes = {
    [`GET ${JOB_URL}/stories`]: () => Promise.resolve(json(200, { stories: [] })),
    [`GET ${JOB_URL}/history`]: () => Promise.resolve(json(200, [{ version: 1, blocked: false }, { version: 2, blocked: false }])),
    [`GET ${JOB_URL}/collaboration`]: () => Promise.resolve(json(200, { variants: [{ id: VID, label: 'Mina’s recollection', blocked: false, eraRevision: 3, era: { kind: 'relative', label: 'before the renovation' } }] })),
  };
});

async function mount({ sources = [voice()], durationHintMs = () => null } = {}) {
  const root = new FakeElement('div');
  const view = mountStories(root, { jobUrl: JOB_URL, sources, editor: () => ({ version: 2 }), durationHintMs });
  await settle();
  const find = (predicate) => root.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const selects = () => find((node) => node.tag === 'select');
  const message = () => find((node) => node.className === 'form-message')[0].textContent;
  const fill = ({ viewKey = 'version:1', title = 'Morning bell', cues = [['0:00', '0:01.0', 'Synthetic test tone; no speech.']], confirm = true } = {}) => {
    selects()[1].value = viewKey;
    find((node) => node.tag === 'input' && node.type === 'text')[0].value = title;
    const add = button('Add a caption');
    cues.forEach((cue, i) => {
      if (i > 0) add.dispatch('click');
      const row = find((node) => node.className === 'story-cue-row')[i];
      const [start, end] = row.findAll((node) => node.tag === 'input');
      start.value = cue[0];
      end.value = cue[1];
      row.findAll((node) => node.tag === 'textarea')[0].value = cue[2];
    });
    const box = find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
    box.checked = confirm;
  };
  return { root, view, find, button, selects, message, fill };
}

const posts = () => requests.filter((r) => r.method === 'POST' && r.url === `${JOB_URL}/stories`);
const sameBody = (a, b) => JSON.stringify(a) === JSON.stringify(b);

describe('story helpers', () => {
  it('reads caption times and checks order, overlap and the recording length hint', () => {
    assert.equal(parseTime('1:04.5'), 64_500);
    assert.equal(parseTime('4.25'), 4_250);
    assert.ok(Number.isNaN(parseTime('1:75')));
    assert.equal(cuesProblem([{ startMs: 0, endMs: 1000, text: 'a' }]), null);
    assert.match(cuesProblem([]), /at least one/);
    assert.match(cuesProblem([{ startMs: 1000, endMs: 1000, text: 'a' }]), /end must come after/);
    assert.match(cuesProblem([{ startMs: 0, endMs: 2000, text: 'a' }, { startMs: 1500, endMs: 3000, text: 'b' }]), /must not overlap/);
    assert.match(cuesProblem([{ startMs: 0, endMs: 9000, text: 'a' }], 5000), /after the recording’s end/);
  });

  it('offers only recordings of this memory that may be used to reconstruct the place', () => {
    const sources = [voice(), voice({ id: 'x', permissions: { place: false, model: true, share: true } }), voice({ id: 'y', policy: { stopped: true } }), { id: 'p', kind: 'photo', permissions: { place: true } }];
    assert.deepEqual(usableVoices(sources).map((record) => record.id), [VOICE]);
  });
});

describe('story composer', () => {
  it('offers retained versions and alternatives explicitly, with nothing preselected', async () => {
    const ui = await mount();
    const options = ui.selects()[1].children.map((option) => option.textContent);
    assert.deepEqual(options, ['Choose a saved view', 'Saved version 2 (current) · Time unknown', 'Saved version 1 · Time unknown', 'Mina’s recollection · Owner’s assertion: before the renovation']);
    assert.equal(ui.selects()[1].value, '');
    ui.button('Save story').dispatch('click');
    assert.match(ui.message(), /Choose the saved view/);
    assert.equal(posts().length, 0);
  });

  it('sends the exact story with the era revision that was shown, and repeats it unchanged after an unknown outcome', async () => {
    const ui = await mount();
    ui.fill({ viewKey: VID });
    routes[`POST ${JOB_URL}/stories`] = lost;
    ui.button('Save story').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm whether the story “Morning bell” was saved/);
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, readyStory()));
    ui.button('Retry the earlier save').dispatch('click');
    await settle();
    const [first, second] = posts();
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(first.body, {
      requestId: first.body.requestId,
      voiceSourceId: VOICE,
      view: { kind: 'variant', version: null, variantId: VID, eraRevision: 3 },
      title: 'Morning bell',
      cues: [{ startMs: 0, endMs: 1000, text: 'Synthetic test tone; no speech.' }],
      captionConfirmed: true,
    });
  });

  it('reconciles an unconfirmed save with its original request before anything newer is sent', async () => {
    const ui = await mount();
    ui.fill({ viewKey: 'version:1', title: 'Morning bell' });
    routes[`POST ${JOB_URL}/stories`] = lost;
    ui.button('Save story').dispatch('click');
    await settle();
    const titleInput = ui.find((node) => node.tag === 'input' && node.type === 'text')[0];
    titleInput.value = 'Morning bell, corrected';
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, readyStory()));
    ui.button('Retry the earlier save').dispatch('click');
    await settle();
    const [first, second] = posts();
    assert.deepEqual(second.body, first.body, 'the original request, not the edited form');
    assert.equal(second.body.title, 'Morning bell');
    assert.match(ui.message(), /The earlier story “Morning bell” was saved\. Your newer changes are still in the form/);
    assert.equal(titleInput.value, 'Morning bell, corrected', 'newer edits are kept');
    ui.button('Save story').dispatch('click');
    await settle();
    const third = posts()[2];
    assert.equal(third.body.title, 'Morning bell, corrected');
    assert.notEqual(third.body.requestId, first.body.requestId);
  });

  for (const status of [401, 403]) {
    it(`keeps an unconfirmed save unresolved when a retry is refused with ${status}, without claiming it was not kept`, async () => {
      const ui = await mount();
      ui.fill({ viewKey: 'version:1' });
      routes[`POST ${JOB_URL}/stories`] = lost;
      ui.button('Save story').dispatch('click');
      await settle();
      routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(status, { error: 'Sign in to continue.' }));
      ui.button('Retry the earlier save').dispatch('click');
      await settle();
      assert.ok(ui.button('Retry the earlier save'), 'still unresolved');
      assert.match(ui.message(), /could not check whether the earlier story “Morning bell” was saved\. Sign in again or check your access/);
      assert.doesNotMatch(ui.message(), /not kept/);
      routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, readyStory()));
      ui.button('Retry the earlier save').dispatch('click');
      await settle();
      const sent = posts();
      assert.ok(sent.every((post) => sameBody(post.body, sent[0].body)), 'the same original request throughout');
    });
  }

  it('keeps edits made while a save is running when that save answers', async () => {
    const ui = await mount();
    ui.fill({ viewKey: 'version:1', title: 'Morning bell' });
    let respond;
    routes[`POST ${JOB_URL}/stories`] = () => new Promise((resolve) => (respond = resolve));
    ui.button('Save story').dispatch('click');
    await settle();
    const titleInput = ui.find((node) => node.tag === 'input' && node.type === 'text')[0];
    titleInput.value = 'Morning bell, second take';
    respond(json(201, readyStory()));
    await settle();
    assert.equal(titleInput.value, 'Morning bell, second take');
    assert.match(ui.message(), /The earlier story “Morning bell” was saved while you were editing\. Your newer changes are still in the form/);
  });

  it('keeps an unconfirmed save unresolved through a busy answer and never sends a duplicate', async () => {
    const ui = await mount();
    ui.fill({ viewKey: 'version:1' });
    routes[`POST ${JOB_URL}/stories`] = lost;
    ui.button('Save story').dispatch('click');
    await settle();
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(409, { error: 'Another recorded story is being prepared right now. Try again when it finishes.' }));
    ui.button('Retry the earlier save').dispatch('click');
    await settle();
    assert.ok(ui.button('Retry the earlier save'), 'still unresolved');
    assert.ok(!ui.button('Stop waiting for the earlier save').hidden);
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Something else';
    ui.button('Retry the earlier save').dispatch('click');
    await settle();
    const sent = posts();
    assert.equal(sent.length, 3);
    assert.ok(sent.every((post) => sameBody(post.body, sent[0].body)), 'every send is the same original request');
  });

  it('after a conflict, re-reads and requires choosing the view again instead of using a newer time', async () => {
    const ui = await mount();
    ui.fill({ viewKey: VID });
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(409, { error: 'The saved view changed.' }));
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { variants: [{ id: VID, label: 'Mina’s recollection', blocked: false, eraRevision: 4, era: { kind: 'exact', start: '1998-07-01' } }] }));
    ui.button('Save story').dispatch('click');
    await settle();
    assert.match(ui.message(), /The saved view changed\. If the saved view changed, choose it again/);
    assert.equal(ui.selects()[1].value, '', 'no view is chosen automatically');
    ui.button('Save story').dispatch('click');
    assert.equal(posts().length, 1);
    ui.selects()[1].value = VID;
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, readyStory()));
    ui.button('Save story').dispatch('click');
    await settle();
    const [first, second] = posts();
    assert.equal(second.body.view.eraRevision, 4);
    assert.notEqual(second.body.requestId, first.body.requestId);
  });

  it('needs the caption confirmation and warns when captions run past the loaded recording length', async () => {
    let ui = await mount();
    ui.fill({ confirm: false });
    ui.button('Save story').dispatch('click');
    assert.match(ui.message(), /Confirm that your captions convey what is heard/);
    ui = await mount({ durationHintMs: () => 800 });
    ui.fill();
    ui.button('Save story').dispatch('click');
    assert.match(ui.message(), /after the recording’s end at about 0:00\.8/);
    assert.equal(posts().length, 0);
  });

  it('explains when no recording can be used and offers no save', async () => {
    const ui = await mount({ sources: [voice({ permissions: { place: false, model: false, share: false } })] });
    assert.match(ui.root.textContent, /No recording of this memory may be used for a story/);
    assert.equal(ui.button('Save story').disabled, true);
  });
});

describe('story list', () => {
  it('shows available stories with provider and caption author apart, and unavailable or withdrawn ones without their words', async () => {
    routes[`GET ${JOB_URL}/stories`] = () =>
      Promise.resolve(
        json(200, {
          stories: [
            readyStory(),
            { id: 'st2', status: 'ready', available: false, blockedReason: 'The recording is no longer allowed.', voice: { provider: 'Owner' }, title: null, cues: [] },
            { id: 'st3', status: 'withdrawn', available: false, blockedReason: null, voice: { provider: 'Owner' }, title: null, cues: [] },
          ],
        }),
      );
    const ui = await mount();
    const text = ui.root.textContent;
    assert.match(text, /Recording by Owner\. Captions written by Owner\. Length 0:01\.0\. You hear a converted playback copy; the original is unchanged\./);
    assert.match(text, /Not available: The recording is no longer allowed\./);
    assert.match(text, /Withdrawn story\. It is no longer played or shared; the original recording is kept\./);
    assert.equal(ui.find((node) => node.tag === 'button' && node.textContent === 'Play').length, 1, 'only the available story can be played');
  });

  it('withdraws only after a second press, repeating the same request when unconfirmed', async () => {
    routes[`GET ${JOB_URL}/stories`] = () => Promise.resolve(json(200, { stories: [readyStory()] }));
    const ui = await mount();
    ui.button('Withdraw story').dispatch('click');
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
    routes[`POST ${JOB_URL}/stories/st1/withdraw`] = lost;
    ui.button('Withdraw this story').dispatch('click');
    await settle();
    routes[`POST ${JOB_URL}/stories/st1/withdraw`] = () => Promise.resolve(json(200, readyStory({ status: 'withdrawn', available: false })));
    ui.button('Withdraw this story').dispatch('click');
    await settle();
    const sent = requests.filter((r) => r.url === `${JOB_URL}/stories/st1/withdraw`);
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.deepEqual(Object.keys(sent[0].body), ['requestId']);
    assert.match(ui.message(), /Copies already saved on a device cannot be removed/);
  });
});
