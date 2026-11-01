import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

// The owner's choice of the whole recording or an excerpt of it for a story,
// mounted with the real stories panel and shared story player: the whole
// request is unchanged, the range is exact and checked before sending, the
// caption confirmation is asked again, an unknown save repeats exactly, and
// saved excerpts carry a visible original-position label.
installViewerShim();
const { mountStories } = await import('../public/stories.js');
const { createStoryPlayer } = await import('../public/story-player.js');

const JOB_URL = '/api/drafts/11111111-1111-4111-8111-111111111111/reconstructions/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VOICE2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const voice = (id, provider) => ({ id, kind: 'voice', provider, permissions: { place: true, model: false, share: false }, policy: { revision: 0, stopped: false } });
const storyRecord = (overrides = {}) => ({
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
  audio: { type: 'audio/wav', size: 32_044 },
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
    [`GET ${JOB_URL}/collaboration`]: () => Promise.resolve(json(200, { variants: [] })),
  };
});

async function mount({ sources = [voice(VOICE, 'Owner'), voice(VOICE2, 'Jun')], durationHintMs = () => 3000 } = {}) {
  const root = new FakeElement('div');
  const view = mountStories(root, { jobUrl: JOB_URL, sources, editor: () => ({ version: 2 }), durationHintMs });
  await settle();
  const find = (predicate) => root.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const radios = () => find((node) => node.tag === 'input' && node.type === 'radio');
  const label = (text) => find((node) => node.tag === 'label' && node.textContent.startsWith(text))[0];
  // Each range field is the input its label names.
  const rangeField = (text) => find((node) => node.tag === 'input' && node.id === label(text).htmlFor)[0];
  const confirm = () => find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
  const ui = {
    root,
    view,
    find,
    button,
    radios,
    confirm,
    start: () => rangeField('Start in the original recording'),
    end: () => rangeField('End in the original recording'),
    voiceSelect: () => find((node) => node.tag === 'select')[0],
    message: () => find((node) => node.className === 'form-message')[0].textContent,
    text: () => root.textContent,
    choose(mode) {
      const radio = radios().find((input) => input.value === mode);
      for (const input of radios()) input.checked = input === radio;
      radio.dispatch('change');
    },
    type(input, value) {
      input.value = value;
      input.dispatch('input');
    },
    fill({ title = 'Morning bell', cues = [['0:00', '0:01.0', 'Synthetic test tone; no speech.']] } = {}) {
      find((node) => node.tag === 'select')[1].value = 'version:1';
      find((node) => node.tag === 'input' && node.type === 'text')[0].value = title;
      const add = button('Add a caption');
      cues.forEach((cue, i) => {
        if (i > 0 && !find((node) => node.className === 'story-cue-row')[i]) add.dispatch('click');
        const row = find((node) => node.className === 'story-cue-row')[i];
        const [start, end] = row.findAll((node) => node.tag === 'input');
        start.value = cue[0];
        end.value = cue[1];
        row.findAll((node) => node.tag === 'textarea')[0].value = cue[2];
      });
    },
    acknowledge() {
      confirm().checked = true;
    },
  };
  return ui;
}

const posts = () => requests.filter((request) => request.method === 'POST' && request.url === `${JOB_URL}/stories`);

describe('choosing the part of a recording a story plays', () => {
  it('sends exactly the earlier request for the whole recording, which is the default', async () => {
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, storyRecord()));
    const ui = await mount();
    assert.equal(ui.radios().find((input) => input.value === 'whole').checked, true);
    assert.match(ui.text(), /Excerpt positions are in the original recording\. Captions start at 0:00 of the part you choose\./);
    assert.match(ui.text(), /This recording is about 0:03\.0 long\. Rehere checks the exact length when saving\./);
    assert.match(ui.text(), /either its whole first audio track or one excerpt of it that you choose\. An excerpt may leave out parts of what was said\./);
    assert.match(ui.text(), /convey the meaningful audible content of the part chosen to play \(the whole recording or the excerpt\)/);
    ui.fill();
    ui.acknowledge();
    ui.button('Save story').dispatch('click');
    await settle();
    const [sent] = posts();
    assert.deepEqual(Object.keys(sent.body).sort(), ['captionConfirmed', 'cues', 'requestId', 'title', 'view', 'voiceSourceId']);
  });

  it('sends the exact excerpt range in original-recording milliseconds, with blank start as 0:00', async () => {
    routes[`POST ${JOB_URL}/stories`] = () => Promise.resolve(json(201, storyRecord({ sourceRange: { startMs: 0, endMs: 1500 }, durationMs: 1500 })));
    const ui = await mount();
    ui.fill();
    ui.choose('excerpt');
    ui.type(ui.end(), '1.5');
    ui.acknowledge();
    ui.button('Save story').dispatch('click');
    await settle();
    assert.deepEqual(posts()[0].body.sourceRange, { startMs: 0, endMs: 1500 });
    assert.equal(ui.radios().find((input) => input.value === 'whole').checked, true, 'an exact success resets the part to whole');
    assert.equal(ui.end().value, '');

    ui.fill();
    ui.choose('excerpt');
    ui.type(ui.start(), '1:00.05');
    ui.type(ui.end(), '1:01.05');
    ui.acknowledge();
    ui.button('Save story').dispatch('click');
    await settle();
    assert.deepEqual(posts()[1].body.sourceRange, { startMs: 60_050, endMs: 61_050 });
  });

  it('sends nothing for an unusable range or captions longer than the excerpt, keeping the form', async () => {
    const ui = await mount();
    ui.fill({ cues: [['0:00', '0:01.5', 'Too long for a one-second excerpt.']] });
    ui.choose('excerpt');
    const cases = [
      ['', '', /^Enter where the excerpt ends in the original recording\.$/],
      ['x', '2', /^Enter where the excerpt starts in the original recording as minutes:seconds/],
      ['2', 'y', /^Enter where the excerpt ends as minutes:seconds/],
      ['2', '2', /^The excerpt must end after it starts\.$/],
      ['0', '5:00.001', /^An excerpt must end by 5:00\.0 in the original recording\.$/],
      ['1', '2', /^The last caption ends at 0:01\.5, after the end of the excerpt at 0:01\.0\. Caption times start at 0:00 of the excerpt\.$/],
    ];
    for (const [start, end, pattern] of cases) {
      ui.type(ui.start(), start);
      ui.type(ui.end(), end);
      ui.acknowledge();
      ui.button('Save story').dispatch('click');
      await settle();
      assert.match(ui.message(), pattern, `${start}–${end}`);
      assert.equal(ui.start().value, start, 'the typed range is kept');
    }
    assert.equal(posts().length, 0);
  });

  it('asks for the caption confirmation again after a different recording, part or range', async () => {
    const ui = await mount();
    ui.fill();
    for (const change of [
      () => {
        ui.voiceSelect().value = VOICE2;
        ui.voiceSelect().dispatch('change');
      },
      () => ui.choose('excerpt'),
      () => ui.type(ui.start(), '0:01'),
      () => ui.type(ui.end(), '0:02'),
      () => ui.choose('whole'),
    ]) {
      ui.acknowledge();
      change();
      assert.equal(ui.confirm().checked, false);
    }
  });

  it('repeats exactly the earlier excerpt request after an unclear answer, keeping newer edits', async () => {
    let answer = lost;
    routes[`POST ${JOB_URL}/stories`] = () => answer();
    const ui = await mount();
    ui.fill();
    ui.choose('excerpt');
    ui.type(ui.start(), '1');
    ui.type(ui.end(), '2');
    ui.acknowledge();
    ui.button('Save story').dispatch('click');
    await settle();
    assert.match(ui.message(), /could not confirm whether the story “Morning bell” was saved/);
    ui.type(ui.end(), '3');
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'Newer title';
    answer = () => Promise.resolve(json(201, storyRecord({ sourceRange: { startMs: 1000, endMs: 2000 } })));
    ui.button('Retry the earlier save').dispatch('click');
    await settle();
    const [first, second] = posts();
    assert.deepEqual(second.body, first.body, 'the same request and range');
    assert.deepEqual(second.body.sourceRange, { startMs: 1000, endMs: 2000 });
    assert.equal(ui.end().value, '3', 'newer edits stay');
    assert.equal(ui.radios().find((input) => input.value === 'excerpt').checked, true);
    assert.match(ui.message(), /Your newer changes are still in the form/);
  });

  it('keeps the part and range through refreshes, failed reads and list navigation', async () => {
    const ui = await mount();
    ui.fill();
    ui.choose('excerpt');
    ui.type(ui.start(), '0:01');
    ui.type(ui.end(), '0:02.5');
    routes[`GET ${JOB_URL}/history`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    routes[`GET ${JOB_URL}/stories`] = () => Promise.resolve(json(503, { error: 'Unavailable.' }));
    await ui.view.refresh();
    ui.view.showAll();
    await settle();
    assert.equal(ui.radios().find((input) => input.value === 'excerpt').checked, true);
    assert.deepEqual([ui.start().value, ui.end().value], ['0:01', '0:02.5']);
    assert.equal(ui.find((node) => node.tag === 'select')[1].value, 'version:1');
  });

  it('labels saved excerpts with their original positions and a 0:00 origin, never whole stories, and fetches nothing before Play', async () => {
    routes[`GET ${JOB_URL}/stories`] = () =>
      Promise.resolve(json(200, { stories: [storyRecord({ id: 'ex', title: 'Bell excerpt', sourceRange: { startMs: 1000, endMs: 2050 }, durationMs: 1050 }), storyRecord({ id: 'wh', title: 'Whole bell' })] }));
    const ui = await mount();
    const items = ui.find((node) => node.tag === 'li' && /Bell excerpt|Whole bell/.test(node.textContent));
    const excerptItem = items.find((node) => /Bell excerpt/.test(node.textContent));
    const wholeItem = items.find((node) => /Whole bell/.test(node.textContent));
    assert.match(excerptItem.textContent, /Excerpt from the original recording: 0:01\.0–0:02\.050\. Playback and caption times start at 0:00 of this excerpt\./);
    assert.doesNotMatch(wholeItem.textContent, /Excerpt from the original recording/);
    assert.equal(requests.filter((request) => request.url.endsWith('/audio.wav')).length, 0);

    // The shared player alone, as visitors use it, with no fetch until Play.
    let fetched = 0;
    const player = createStoryPlayer({ story: storyRecord({ sourceRange: { startMs: 60_000, endMs: 61_200 } }), fetchAudio: () => ((fetched += 1), lost()) });
    assert.match(player.element.textContent, /Excerpt from the original recording: 1:00\.0–1:01\.2\./);
    assert.equal(fetched, 0);
    player.dispose();
    const contributor = createStoryPlayer({ story: { title: 'A recording', cues: [], durationMs: 1000, audio: { type: 'audio/wav', size: 32_044 } }, fetchAudio: lost });
    assert.doesNotMatch(contributor.element.textContent, /Excerpt/);
    contributor.dispose();
  });
});
