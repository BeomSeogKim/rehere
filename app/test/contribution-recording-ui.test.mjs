import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

// A contributor's own recording: recorded in the page (no file chooser), sent
// with or without writing, listened to by the owner before it can inform a
// change, and linked to shared views only by the owner's explicit choice.
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
const RECORDING_URL = `${JOB_URL}/contributions/${CID}/recording.wav`;

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
const wavResponse = (bytes = wav()) => ({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? 'audio/wav' : String(bytes.length)) }, arrayBuffer: async () => bytes.buffer, body: null });

// A stand-in microphone and recorder; no real device.
class FakeStream {
  tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  getTracks() {
    return this.tracks;
  }
}
class FakeMediaRecorder extends EventTarget {
  static instances = [];
  constructor(stream) {
    super();
    this.stream = stream;
    this.mimeType = 'audio/webm';
    this.state = 'inactive';
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
  finalize(bytes) {
    const data = new Event('dataavailable');
    data.data = new Blob([bytes], { type: 'audio/webm' });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event('stop'));
  }
}

let requests;
let routes;
let storage;
let micRequests;
let streams;
let audios;

before(() => {
  globalThis.document = {
    createElement: (tag) => {
      const node = new FakeElement(tag);
      if (tag === 'audio') {
        node.calls = [];
        node.play = () => (node.calls.push('play'), node.playResult ?? Promise.resolve());
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
    let body = null;
    let entries = null;
    if (options.body instanceof FormData) {
      body = JSON.parse(options.body.get('payload'));
      entries = Object.fromEntries([...options.body.keys()].map((key) => [key, options.body.get(key)]));
    } else if (typeof options.body === 'string') body = JSON.parse(options.body);
    requests.push({ url, method: options.method ?? 'GET', body, entries });
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
  micRequests = 0;
  streams = [];
  audios = [];
  FakeMediaRecorder.instances = [];
});

afterEach(() => mock.restoreAll());

const media = (answer = 'grant') => ({
  mediaDevices: {
    getUserMedia: () => {
      micRequests += 1;
      if (answer === 'deny') return Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
      const stream = new FakeStream();
      streams.push(stream);
      return Promise.resolve(stream);
    },
  },
  MediaRecorder: FakeMediaRecorder,
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
    text: '',
    textSha256: null,
    permissions: null,
    periodClaim: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    revision: 1,
    status: 'submitted',
    review: null,
    withdrawnAt: null,
    photo: null,
    voice: {
      available: true,
      type: 'audio/webm',
      durationMs: 4000,
      origin: { kind: 'own', reference: '' },
      dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
      permissions: { place: true, model: false, share: true },
      receivedAt: '2026-11-01T00:00:00.000Z',
      captions: null,
      url: RECORDING_URL,
      // The checked playback copy (not the original): what the player expects exactly.
      audio: { type: 'audio/wav', size: wav().length },
    },
    ...overrides,
  };
}

describe('a contributor’s recording', () => {
  async function mount({ answer = 'grant', places = [PLACE] } = {}) {
    routes['GET /api/contributor/places'] = () => json(200, places);
    for (const url of [JOB_URL, B_URL]) routes[`GET ${url}/collaboration`] = () => json(200, { revision: 1, contributions: [], variants: [], blocked: false, currentVersion: 1 });
    const { mountContributor } = await import('../public/collaboration.js');
    const root = new FakeElement('div');
    const view = mountContributor(root, { principal: PRINCIPAL, media: media(answer) });
    await settle();
    const ui = finder(root);
    const recordTake = async (bytes) => {
      ui.button('Record').dispatch('click');
      await settle();
      ui.button('Stop').dispatch('click');
      FakeMediaRecorder.instances.at(-1).finalize(bytes);
      await settle();
    };
    const voiceUses = () => ui.legendSet('Allowed uses of your recording').findAll((node) => node.type === 'checkbox');
    const caption = () => ui.find((node) => node.tag === 'textarea')[1];
    const captionConfirm = () => ui.find((node) => node.tag === 'label' && /I wrote these captions myself/.test(node.textContent))[0].children[0];
    return { view, root, ui, recordTake, voiceUses, caption, captionConfirm };
  }

  it('asks for nothing on load, and sends a recording alone with no writing, its uses off and no captions', async () => {
    const { ui, recordTake, voiceUses } = await mount();
    assert.equal(micRequests, 0, 'no microphone request on load');
    assert.equal(ui.find((node) => node.tag === 'input' && node.type === 'file').length, 1, 'only the photo has a file chooser');
    await recordTake('take-one');
    assert.ok(voiceUses().every((box) => !box.checked), 'the recording’s uses start off');
    routes[`POST ${JOB_URL}/contributions/bundle`] = () => json(200, contribution());
    ui.button('Send recollection').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/bundle`);
    assert.deepEqual(Object.keys(sent.entries).sort(), ['payload', 'voice']);
    assert.equal(await sent.entries.voice.text(), 'take-one');
    assert.deepEqual(sent.body, {
      requestId: sent.body.requestId,
      text: '',
      periodClaim: '',
      permissions: null,
      photo: null,
      voice: {
        origin: { kind: 'own', reference: '' },
        dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
        permissions: { place: false, model: false, share: false },
        captionText: '',
        captionConfirmed: false,
      },
    });
    assert.match(ui.message(), /^Sent\./);
  });

  it('needs the writer’s confirmation for captions, and sends them exactly', async () => {
    const { ui, recordTake, caption, captionConfirm } = await mount();
    await recordTake('take');
    caption().value = 'A bell rings twice.\n';
    ui.button('Send recollection').dispatch('click');
    assert.match(ui.message(), /Confirm that you wrote the captions yourself/);
    assert.equal(posts(`${JOB_URL}/contributions/bundle`).length, 0);
    captionConfirm().checked = true;
    routes[`POST ${JOB_URL}/contributions/bundle`] = () => json(200, contribution());
    ui.button('Send recollection').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/bundle`);
    assert.equal(sent.body.voice.captionText, 'A bell rings twice.\n');
    assert.equal(sent.body.voice.captionConfirmed, true);
  });

  it('keeps words and a photo usable when the microphone is refused', async () => {
    const { ui } = await mount({ answer: 'deny' });
    ui.button('Record').dispatch('click');
    await settle();
    assert.match(ui.find((node) => node.role === 'status').map((node) => node.textContent).join(' '), /Microphone access was not allowed/);
    ui.find((node) => node.tag === 'textarea')[0].value = 'Only words.';
    routes[`POST ${JOB_URL}/contributions`] = () => json(201, contribution({ text: 'Only words.', voice: null }));
    ui.button('Send recollection').dispatch('click');
    await settle();
    assert.equal(posts(`${JOB_URL}/contributions`).length, 1);
  });

  it('repeats an unknown send with the same take even after a new one, and never reuses an old ID for a new take after reload', async () => {
    const { ui, recordTake } = await mount();
    await recordTake('first-take');
    routes[`POST ${JOB_URL}/contributions/bundle`] = () => json(503, { error: 'Another recording or photo is being prepared. Nothing was started for this request. Try again in a moment.' });
    ui.button('Send recollection').dispatch('click');
    await settle();
    ui.button('Discard recording').dispatch('click');
    await recordTake('second-take');
    routes[`POST ${JOB_URL}/contributions/bundle`] = () => json(200, contribution());
    ui.button('Send again (same request)').dispatch('click');
    await settle();
    const [first, second] = posts(`${JOB_URL}/contributions/bundle`);
    assert.equal(second.body.requestId, first.body.requestId);
    assert.equal(await second.entries.voice.text(), 'first-take', 'the same recording, not the newer take');

    // A reload leaves only the opaque ID; a take made now is new work.
    storage.set(`rehere:contribution-pending:p-contrib:${DRAFT}:${JOB}`, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    const again = await mount();
    await again.recordTake('after-reload');
    again.ui.button('Check earlier submission').dispatch('click');
    await settle();
    assert.match(again.ui.message(), /To send what the form holds now, start a new submission\./);
    assert.equal(posts(`${JOB_URL}/contributions/bundle`).filter((r) => r.body.requestId === 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee').length, 0);
    again.ui.button('Start a new submission instead').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/bundle`] = () => json(200, contribution());
    again.ui.button('Send recollection').dispatch('click');
    await settle();
    assert.notEqual(posts(`${JOB_URL}/contributions/bundle`).at(-1).body.requestId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  });

  it('stops capture on a place change and keeps a finished take, its uses and captions with its own place only', async () => {
    const { ui, recordTake, voiceUses, caption } = await mount({ places: [PLACE, PLACE_B] });
    const placeSelect = ui.find((node) => node.tag === 'select')[0];
    const go = async (entry) => {
      placeSelect.value = `${entry.draftId}/${entry.jobId}`;
      placeSelect.dispatch('change');
      await settle();
    };
    await go(PLACE);
    await recordTake('take-for-a');
    voiceUses()[2].checked = true;
    caption().value = 'Words for A.';
    await go(PLACE_B);
    assert.equal(ui.find((node) => node.tag === 'audio' && !node.hidden).length, 0, 'no take at the new place');
    assert.ok(voiceUses().every((box) => !box.checked), 'no uses carried over');
    assert.equal(caption().value, '');
    ui.button('Record').dispatch('click');
    await settle();
    await go(PLACE);
    assert.ok(streams.at(-1).tracks.every((track) => track.stopped), 'capture stopped and the microphone released');
    assert.equal(voiceUses()[2].checked, true, 'A’s take comes back with its own uses');
    assert.equal(caption().value, 'Words for A.');
  });
});

describe('listening back to a take before sending', () => {
  it('is one player among the page’s, stops on page-wide stops, and is released by a new take, a place change and closing', async () => {
    const revoked = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => (revoked.push(url), realRevoke(url));
    try {
      const playback = await import('../public/playback.js');
      routes['GET /api/contributor/places'] = () => json(200, [PLACE, PLACE_B]);
      for (const url of [JOB_URL, B_URL]) routes[`GET ${url}/collaboration`] = () => json(200, { revision: 1, contributions: [], variants: [], blocked: false, currentVersion: 1 });
      const { mountContributor } = await import('../public/collaboration.js');
      const root = new FakeElement('div');
      const view = mountContributor(root, { principal: PRINCIPAL, media: media() });
      await settle();
      const ui = finder(root);
      const placeSelect = ui.find((node) => node.tag === 'select')[0];
      placeSelect.value = `${DRAFT}/${JOB}`;
      placeSelect.dispatch('change');
      await settle();
      const take = async (bytes) => {
        ui.button('Record').dispatch('click');
        await settle();
        ui.button('Stop').dispatch('click');
        FakeMediaRecorder.instances.at(-1).finalize(bytes);
        await settle();
      };
      const listen = () => ui.find((node) => node.tag === 'audio')[0];
      await take('first');
      const firstUrl = listen().src;
      assert.ok(firstUrl);
      // Playing another player stops the listen-back, and a page-wide stop does too.
      listen().dispatch('play');
      let otherStopped = 0;
      playback.claim('other-player', () => (otherStopped += 1));
      assert.ok(listen().calls.includes('pause'), 'another player took over');
      listen().calls.length = 0;
      listen().dispatch('play');
      assert.equal(otherStopped, 1, 'and playing it again stops the other player');
      playback.stopAll();
      assert.ok(listen().calls.includes('pause'), 'a page-wide stop silences it');

      listen().calls.length = 0;
      ui.button('Discard recording').dispatch('click');
      await settle();
      assert.ok(listen().calls.includes('pause') && listen().calls.includes('load'), 'released on discard');
      assert.equal(listen().attributes.src, undefined);
      assert.ok(revoked.includes(firstUrl));

      await take('second');
      const secondUrl = listen().src;
      listen().calls.length = 0;
      placeSelect.value = `${B_DRAFT}/${JOB}`;
      placeSelect.dispatch('change');
      await settle();
      assert.ok(listen().calls.includes('pause'), 'released on a place change');
      assert.ok(revoked.includes(secondUrl));

      await take('third');
      const thirdUrl = listen().src;
      const audio = listen();
      audio.calls.length = 0;
      view.dispose();
      assert.ok(audio.calls.includes('pause'), 'released on closing');
      assert.ok(revoked.includes(thirdUrl));
      audio.calls.length = 0;
      playback.stopAll();
      assert.equal(audio.calls.length, 0, 'no longer registered after closing');
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });
});

describe('the own list for a recording without words', () => {
  it('says once that no words were sent, and a withdrawal names the recording without claiming deletion', async () => {
    routes['GET /api/contributor/places'] = () => json(200, [PLACE]);
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 });
    const { mountContributor } = await import('../public/collaboration.js');
    const root = new FakeElement('div');
    const view = mountContributor(root, { principal: PRINCIPAL, media: media() });
    await settle();
    const ui = finder(root);
    assert.equal(root.textContent.split('No written words were sent.').length - 1, 1, 'said once');
    ui.button('Withdraw').dispatch('click');
    assert.ok(ui.button('Withdraw this recollection and its recording'));
    routes[`POST ${JOB_URL}/contributions/${CID}/withdraw`] = () => json(200, { contribution: contribution({ status: 'withdrawn' }) });
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 2, contributions: [contribution({ status: 'withdrawn', text: null, voice: { ...contribution().voice, available: false, url: null } })], variants: [], blocked: false, currentVersion: 1 });
    ui.button('Withdraw this recollection and its recording').dispatch('click');
    await settle();
    assert.match(ui.message(), /^Withdrawn\. Rehere no longer shows or uses your recording, and scenes and shared views that depended on it are blocked\./);
    assert.doesNotMatch(root.textContent, /these words|deleted|erased/);
    view.dispose();
  });
});

describe('quoting words from a recollection with a recording', () => {
  it('offers the words only when every material it sent allows sharing', async () => {
    const withWords = (share) => contribution({ text: 'The counter faced the window.', textSha256: 'a'.repeat(64), permissions: { place: true, model: false, share: true }, voice: { ...contribution().voice, permissions: { place: true, model: false, share } } });
    routes[`GET ${JOB_URL}/history`] = () => json(200, [{ version: 1, dependencies: [], blocked: false }]);
    routes[`GET ${JOB_URL}/stories`] = () => json(200, { stories: [] });
    routes[`GET ${JOB_URL}/shares`] = () => json(200, []);
    const { mountShares } = await import('../public/shares.js');
    const quotes = async (entry) => {
      routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [entry], variants: [], blocked: false, currentVersion: 1 });
      const root = new FakeElement('section');
      const view = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 1 }), getCamera: () => null });
      await settle();
      const text = finder(root).legendSet('Recollections to quote (optional)').textContent;
      view.dispose();
      return text;
    };
    assert.match(await quotes(withWords(false)), /No recollection can be quoted\./, 'the recording does not allow sharing');
    assert.match(await quotes(withWords(true)), /Mina: “The counter faced the window\.”/);
    assert.match(await quotes(contribution()), /No recollection can be quoted\./, 'no words, nothing to quote');
  });
});

describe('listening to one’s own recording', () => {
  it('plays from the list on Play only, and stops for good on a new list, a place change or closing', async () => {
    const B_RECORDING = `${B_URL}/contributions/${CID}/recording.wav`;
    let answer = null;
    let aborted = 0;
    routes['GET /api/contributor/places'] = () => json(200, [PLACE, PLACE_B]);
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${B_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [contribution({ voice: { ...contribution().voice, url: B_RECORDING } })], variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${RECORDING_URL}`] = () => new Promise((resolve) => (answer = resolve));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options = {}) => {
      options.signal?.addEventListener?.('abort', () => (aborted += 1));
      return realFetch(url, options);
    };
    try {
      const { mountContributor } = await import('../public/collaboration.js');
      const root = new FakeElement('div');
      const view = mountContributor(root, { principal: PRINCIPAL, media: media() });
      await settle();
      const ui = finder(root);
      const placeSelect = ui.find((node) => node.tag === 'select')[0];
      placeSelect.value = `${DRAFT}/${JOB}`;
      placeSelect.dispatch('change');
      await settle();
      assert.match(root.textContent, /Your recording.*No captions supplied\./s);
      assert.equal(requests.filter((r) => r.url === RECORDING_URL).length, 0, 'nothing loads before Play');
      ui.button('Play').dispatch('click');
      await settle();
      assert.equal(requests.filter((r) => r.url === RECORDING_URL).length, 1);

      // A place change while it is still loading: the load is abandoned and a
      // late answer plays nothing in the next place's list.
      placeSelect.value = `${B_DRAFT}/${JOB}`;
      placeSelect.dispatch('change');
      await settle();
      assert.equal(aborted, 1, 'the pending load was abandoned');
      answer(wavResponse());
      await settle();
      assert.equal(audios.filter((audio) => audio.calls.includes('play')).length, 0, 'nothing plays from the earlier place');

      // Playing in the new list, then closing the screen, stops it.
      routes[`GET ${B_RECORDING}`] = () => wavResponse();
      ui.button('Play').dispatch('click');
      await settle();
      const playing = audios.find((audio) => audio.calls.includes('play'));
      assert.ok(playing, 'the new place’s own recording plays');
      view.dispose();
      assert.ok(playing.calls.includes('pause'), 'closing stops it');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the owner listening before a change', () => {
  it('unlocks the acknowledgment only after this player really started, and records it for the change', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [contribution()], variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${RECORDING_URL}`] = () => wavResponse();
    const { mountCollaboration } = await import('../public/collaboration.js');
    const root = new FakeElement('section');
    const b = {
      jobUrl: JOB_URL,
      state: { version: 1, offset: [0, 0, 0], yaw: 0, clean: true },
      editor: () => ({ ...b.state }),
      showTransform: (transform) => Boolean(transform),
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
    assert.match(root.textContent, /Recording included · recording allowed/);
    assert.match(root.textContent, /No written words were sent\./);
    ui.button('Review').dispatch('click');
    assert.match(root.textContent, /No captions supplied\./);
    assert.equal(requests.filter((r) => r.url === RECORDING_URL).length, 0, 'nothing loads before Play');
    const decision = ui.find((node) => node.tag === 'select')[0];
    decision.value = 'adopt';
    decision.dispatch('change');
    const ack = () => ui.find((node) => node.tag === 'label' && /I listened to this recording myself/.test(node.textContent))[0].children[0];
    assert.equal(ack().disabled, true, 'not before playing');
    assert.match(root.textContent, /Play the recording here before using it for a change/);
    ui.button('Play').dispatch('click');
    await settle();
    assert.equal(ack().disabled, false, 'unlocked after the player actually started');
    ack().checked = true;
    ack().dispatch('change');
    ui.button('Preview candidate on the scene').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/${CID}/review`] = () => json(200, { contribution: contribution({ status: 'adopted' }), edit: { version: 2, offset: [0, 0, 0], yaw: 0 } });
    ui.button('Save decision').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/contributions/${CID}/review`);
    assert.equal(sent.body.voiceReviewed, true);
    assert.equal('photoReviewed' in sent.body, false);
    view.dispose();
  });
});

describe('linking a recording to shared views', () => {
  it('offers only a captioned, fully permitted recording, chooses nothing, and sends the explicit link with its caption pin', async () => {
    const captioned = contribution({ voice: { ...contribution().voice, captions: { cues: [{ startMs: 0, endMs: 4000, text: 'A bell.' }], sha256: 'c'.repeat(64), authorLabel: 'Mina' } } });
    const uncaptioned = contribution({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', provider: { displayName: 'Jun' } });
    routes[`GET ${JOB_URL}/collaboration`] = () => json(200, { revision: 1, contributions: [captioned, uncaptioned], variants: [], blocked: false, currentVersion: 1 });
    routes[`GET ${JOB_URL}/history`] = () => json(200, [{ version: 1, dependencies: [], blocked: false }]);
    routes[`GET ${JOB_URL}/stories`] = () => json(200, { stories: [] });
    routes[`GET ${JOB_URL}/shares`] = () => json(200, []);
    routes[`GET ${JOB_URL}`] = () => json(200, { objects: [{ id: 'object-1', label: 'Counter' }, { id: 'object-2', label: 'Flour stack' }] });
    routes[`POST ${JOB_URL}/shares/previews`] = () => json(400, { error: 'Not in this test.' });
    const { mountShares } = await import('../public/shares.js');
    const root = new FakeElement('section');
    const view = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 1 }), getCamera: () => ({ position: [0, 0, 0], target: [0, 0, -3] }) });
    await settle();
    const ui = finder(root);
    const set = () => ui.legendSet('Contributor recordings to include (optional)');
    assert.equal(set().findAll((node) => node.tag === 'label' && /^ Recording by/.test(node.textContent)).length, 1, 'only the captioned one');
    assert.match(set().textContent, /it does not change the scene or say the recording informed it/);
    const include = set().findAll((node) => node.type === 'checkbox')[0];
    assert.equal(include.checked, false, 'nothing chosen by default');
    ui.find((node) => node.tag === 'input' && node.type === 'text')[0].value = 'The shop';
    ui.button('Use the current camera view').dispatch('click');
    include.checked = true;
    include.dispatch('change');
    ui.button('Preview what visitors will see').dispatch('click');
    await settle();
    assert.match(ui.message(), /choose the views it goes with and what it is about/);
    assert.equal(posts(`${JOB_URL}/shares/previews`).length, 0);
    const [viewBox] = set().findAll((node) => node.type === 'checkbox').slice(1);
    viewBox.checked = true;
    viewBox.dispatch('change');
    const about = set().findAll((node) => node.tag === 'select')[0];
    assert.deepEqual(about.children.map((option) => option.value), ['', 'place', 'object-1', 'object-2']);
    about.value = 'object-2';
    about.dispatch('change');
    ui.button('Preview what visitors will see').dispatch('click');
    await settle();
    const [sent] = posts(`${JOB_URL}/shares/previews`);
    assert.deepEqual(sent.body.recordings, [{ contributionId: CID, viewIds: [sent.body.views[0].id], targetId: 'object-2', captionSha256: 'c'.repeat(64) }]);
    view.dispose();
  });
});

describe('telling recordings apart when sharing', () => {
  it('labels two recordings from the same person by their length and captions, with neither chosen', async () => {
    const take = (id, durationMs, text) =>
      contribution({ id, voice: { ...contribution().voice, durationMs, captions: { cues: [{ startMs: 0, endMs: durationMs, text }], sha256: id.slice(0, 1).repeat(64), authorLabel: 'Mina' } } });
    routes[`GET ${JOB_URL}/collaboration`] = () =>
      json(200, {
        revision: 1,
        contributions: [
          take(CID, 4000, 'A bell rings twice from the shop door, then the counter drawer opens.'),
          take('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 61500, 'The flour sacks stood by the window.'),
        ],
        variants: [],
        blocked: false,
        currentVersion: 1,
      });
    routes[`GET ${JOB_URL}/history`] = () => json(200, [{ version: 1, dependencies: [], blocked: false }]);
    routes[`GET ${JOB_URL}/stories`] = () => json(200, { stories: [] });
    routes[`GET ${JOB_URL}/shares`] = () => json(200, []);
    const { mountShares } = await import('../public/shares.js');
    const root = new FakeElement('section');
    const view = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 1 }), getCamera: () => null });
    await settle();
    const ui = finder(root);
    const labels = ui
      .legendSet('Contributor recordings to include (optional)')
      .findAll((node) => node.tag === 'label' && /^ Recording by/.test(node.textContent))
      .map((node) => node.textContent.trim());
    assert.deepEqual(labels, [
      'Recording by Mina · 0:04.0 long · captions: “A bell rings twice from the shop door, then the counter…”',
      'Recording by Mina · 1:01.5 long · captions: “The flour sacks stood by the window.”',
    ]);
    assert.equal(new Set(labels).size, 2, 'the two choices can be told apart');
    assert.ok(ui.legendSet('Contributor recordings to include (optional)').findAll((node) => node.type === 'checkbox').every((box) => !box.checked), 'neither is chosen');
    view.dispose();
  });
});

describe('a contributor recording for visitors', () => {
  it('appears only under its linked view, labelled as a person’s recording, and plays only on Play', async () => {
    const { mountVisitor } = await import('../public/visits.js');
    const view = (id, label) => ({
      id,
      label,
      edit: { offset: [0, 0, 0], yaw: 0 },
      era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null },
      evidence: { photo: null, geometry: 'model estimate', recollections: [], support: [] },
    });
    const bytes = wav();
    const manifest = {
      id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab',
      title: 'Corner shop, synthetic',
      createdAt: '2026-10-31T00:00:00.000Z',
      synthetic: true,
      startViewId: 'v1',
      camera: { position: [0, 0, 0], target: [0, 0, -3] },
      views: [view('v1', 'Saved scene'), view('v2', 'Mina’s alternative')],
      contributorRecordings: [
        {
          id: 'r-1',
          viewIds: ['v2'],
          target: { id: 'place', label: 'About this place' },
          title: 'Contributor recording',
          label: 'Contributor recording; human-written listening captions; not verified history.',
          providerLabel: 'Mina',
          captionAuthorLabel: 'Mina',
          cues: [{ startMs: 0, endMs: 4000, text: 'A bell.' }],
          durationMs: 4000,
          audio: { type: 'audio/wav', size: bytes.length },
        },
      ],
    };
    const heard = [];
    const source = {
      manifest: async () => manifest,
      check: async () => true,
      asset: async (viewId, name) => (name === 'surface.json' ? json(200, visitorSurface()) : { ok: true, status: 200, blob: async () => new Blob(['jpeg']) }),
      storyAudio: async () => null,
      recordingAudio: async (id) => (heard.push(id), wavResponse(bytes)),
    };
    globalThis.viewerLog = [];
    const root = new FakeElement('div');
    const visitor = mountVisitor(root, source);
    try {
      await settle();
      const ui = finder(root);
      assert.doesNotMatch(root.textContent, /Contributor recordings for this view/, 'not under an unlinked view');
      ui.button('Mina’s alternative').dispatch('click');
      assert.match(root.textContent, /About this place · Contributor recording; human-written listening captions; not verified history\./);
      assert.match(root.textContent, /Captions written by Mina; not a transcript\. Nothing plays until you press Play\./);
      assert.deepEqual(heard, [], 'nothing loads before Play');
      ui.button('Play').dispatch('click');
      await settle();
      assert.deepEqual(heard, ['r-1']);
      ui.button('Saved scene').dispatch('click');
      assert.ok(audios.some((audio) => audio.calls.includes('pause')), 'changing view stops it');
    } finally {
      visitor.dispose();
    }
  });
});

describe('the shared player', () => {
  it('reports a real start only and says when there are no captions', async () => {
    const { createStoryPlayer } = await import('../public/story-player.js');
    const bytes = wav();
    let started = 0;
    const playing = createStoryPlayer({ story: { title: 't', cues: [], durationMs: 1, audio: { type: 'audio/wav', size: bytes.length } }, fetchAudio: async () => wavResponse(bytes), onPlaying: () => (started += 1) });
    assert.match(playing.element.textContent, /No captions supplied\./);
    playing.element.findAll((node) => node.tag === 'button' && node.textContent === 'Play')[0].dispatch('click');
    await settle();
    assert.equal(started, 1, 'reported once play() resolved');
    playing.dispose();
    started = 0;
    const refusing = createStoryPlayer({ story: { title: 't', cues: [], durationMs: 1, audio: { type: 'audio/wav', size: bytes.length } }, fetchAudio: async () => wavResponse(bytes), onPlaying: () => (started += 1) });
    const realCreate = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
      const node = realCreate(tag);
      if (tag === 'audio') node.playResult = Promise.reject(new Error('NotAllowedError'));
      return node;
    };
    refusing.element.findAll((node) => node.tag === 'button' && node.textContent === 'Play')[0].dispatch('click');
    await settle();
    globalThis.document.createElement = realCreate;
    assert.equal(started, 0, 'a refused play() reports nothing');
    refusing.dispose();
  });
});
