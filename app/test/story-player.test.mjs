import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { claim, register, registerElement, stopAll, unregister } from '../public/playback.js';
import { MAX_WAV_BYTES, createStoryPlayer, wavProblem } from '../public/story-player.js';

// An <audio> stand-in: play() returns a promise the test settles, and media
// events are dispatched by the test.
class FakeAudio extends FakeElement {
  constructor() {
    super('audio');
    this.currentTime = 0;
    this.paused = true;
    this.plays = [];
    this.calls = [];
  }
  play() {
    this.calls.push('play');
    return new Promise((resolve, reject) => this.plays.push({ resolve, reject }));
  }
  pause() {
    this.calls.push('pause');
    this.paused = true;
  }
  load() {
    this.calls.push('load');
  }
}

// A valid 16 kHz mono 16-bit WAV of `samples` samples.
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

const response = (bytes, type = 'audio/wav') => ({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? type : String(bytes.length)) }, arrayBuffer: async () => bytes.buffer.slice(0) });
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let audios;
let created;
let revoked;

before(() => {
  globalThis.document = {
    createElement: (tag) => {
      if (tag !== 'audio') return new FakeElement(tag);
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
  };
});

after(() => {
  delete globalThis.document;
});

beforeEach(() => {
  audios = [];
  created = [];
  revoked = [];
  mock.method(URL, 'createObjectURL', () => {
    const url = `blob:test/${created.length}`;
    created.push(url);
    return url;
  });
  mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  stopAll();
});

afterEach(() => {
  mock.restoreAll();
  stopAll();
});

const story = (overrides = {}) => ({
  title: 'Morning bell',
  cues: [
    { startMs: 0, endMs: 1000, text: 'Synthetic test tone; no speech.' },
    { startMs: 1000, endMs: 2000, text: 'Second <b>cue</b>' },
  ],
  durationMs: 2000,
  audio: { type: 'audio/wav', size: wav().length },
  ...overrides,
});

function player(fetchAudio, overrides = {}) {
  const p = createStoryPlayer({ story: story(overrides), fetchAudio });
  const button = (text) => p.element.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
  const status = () => p.element.findAll((node) => node.role === 'status')[0].textContent;
  return { ...p, button, status };
}

describe('WAV checks', () => {
  it('accepts exactly the expected 16 kHz mono 16-bit WAV and rejects anything else', () => {
    const good = wav();
    assert.equal(wavProblem(good, good.length), null);
    assert.equal(wavProblem(good, good.length + 2), 'size');
    const stereo = wav();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    assert.equal(wavProblem(stereo, stereo.length), 'header');
    const odd = new Uint8Array(45);
    assert.equal(wavProblem(odd, 45), 'size');
    assert.equal(MAX_WAV_BYTES, 9_600_044);
  });
});

describe('story player', () => {
  it('plays only after Play, from a local copy, and shows captions as text with the current one named', async () => {
    let fetched = 0;
    const p = player(async () => {
      fetched += 1;
      return response(wav());
    });
    assert.equal(fetched, 0, 'nothing is fetched or played before Play');
    p.button('Play').dispatch('click');
    await flush();
    const [audio] = audios;
    assert.equal(audio.src, 'blob:test/0');
    audio.plays[0].resolve();
    await flush();
    assert.match(p.status(), /Playing/);
    audio.currentTime = 1.2;
    audio.dispatch('timeupdate');
    const current = p.element.findAll((node) => node.attributes?.['aria-current'] === 'true');
    assert.equal(current.length, 1);
    assert.match(current[0].textContent, /^Now: 0:01\.0–0:02\.0 Second <b>cue<\/b>$/);
    assert.equal(p.element.findAll((node) => node.tag === 'b').length, 0);
    p.dispose();
    assert.deepEqual(revoked, ['blob:test/0']);
    assert.ok(audio.calls.includes('pause') && audio.calls.includes('load'));
    assert.equal(audio.attributes.src, undefined);
  });

  it('stops a loading story at once when another one is played, and a late answer cannot take over', async () => {
    let answerA;
    let signalA;
    const a = player((signal) => {
      signalA = signal;
      return new Promise((resolve) => (answerA = resolve));
    });
    const b = player(async () => response(wav()));
    a.button('Play').dispatch('click');
    await flush();
    b.button('Play').dispatch('click');
    assert.equal(signalA.aborted, true, 'A is stopped as soon as B is pressed');
    await flush();
    audios[0].plays[0].resolve();
    await flush();
    answerA(response(wav()));
    await flush();
    assert.equal(audios.length, 1, 'A never created a player');
    assert.match(b.status(), /Playing/);
    a.dispose();
    b.dispose();
  });

  it('ignores media events and play() answers that belong to a stopped playback', async () => {
    const p = player(async () => response(wav()));
    p.button('Play').dispatch('click');
    await flush();
    const [audio] = audios;
    p.button('Stop').dispatch('click');
    audio.plays[0].resolve();
    await flush();
    assert.ok(audio.calls.filter((call) => call === 'pause').length >= 2, 'the late play() answer silences the old element again');
    assert.equal(p.status(), 'Stopped.');
    audio.currentTime = 1.5;
    audio.dispatch('timeupdate');
    audio.dispatch('ended');
    assert.equal(p.element.findAll((node) => node.attributes?.['aria-current'] === 'true').length, 0);
    assert.equal(p.status(), 'Stopped.', 'a late ended does not report Finished');
    assert.equal(p.button('Pause').disabled, true);
    p.dispose();
  });

  for (const state of ['starting', 'playing', 'paused', 'finished']) {
    it(`clears a ${state} recording after a media error and retries only on a new Play`, async () => {
      let fetched = 0;
      let playing = 0;
      const p = createStoryPlayer({
        story: story(),
        fetchAudio: async () => {
          fetched += 1;
          return response(wav());
        },
        onPlaying: () => { playing += 1; },
      });
      const button = (name) => p.element.findAll((node) => node.tag === 'button' && node.textContent === name)[0];
      const status = () => p.element.findAll((node) => node.role === 'status')[0].textContent;
      button('Play').dispatch('click');
      await flush();
      const first = audios[0];
      if (state !== 'starting') {
        first.plays[0].resolve();
        await flush();
        first.currentTime = 1.2;
        first.dispatch('timeupdate');
        if (state === 'paused') button('Pause').dispatch('click');
        if (state === 'finished') first.dispatch('ended');
      }
      first.dispatch('error');
      assert.equal(status(), 'The recording could not be played. Press Play to try again.');
      assert.equal(button('Play').disabled, false);
      assert.equal(button('Pause').disabled, true);
      assert.equal(button('Stop').disabled, true);
      assert.equal(first.attributes.src, undefined);
      assert.ok(first.calls.includes('pause') && first.calls.includes('load'));
      assert.deepEqual(revoked, ['blob:test/0']);
      assert.equal(p.element.findAll((node) => node.attributes?.['aria-current'] === 'true').length, 0);
      assert.equal(p.element.findAll((node) => node.tag === 'li').length, 2, 'the listening captions remain readable');
      assert.equal(fetched, 1, 'an error never retries or fetches automatically');
      const expectedPlaying = state === 'starting' ? 0 : 1;
      first.plays[0].resolve();
      first.dispatch('ended');
      await flush();
      assert.equal(playing, expectedPlaying, 'a late play answer never reports a failed recording as started');
      assert.equal(status(), 'The recording could not be played. Press Play to try again.');
      button('Play').dispatch('click');
      await flush();
      assert.equal(fetched, 2, 'explicit retry fetches again through current authorization');
      const second = audios[1];
      second.plays[0].resolve();
      await flush();
      first.dispatch('error');
      first.dispatch('ended');
      first.dispatch('timeupdate');
      assert.equal(status(), 'Playing.', 'old media events cannot stop the replacement');
      assert.equal(playing, expectedPlaying + 1);
      assert.deepEqual(revoked, ['blob:test/0']);
      p.dispose();
      second.dispatch('error');
      assert.deepEqual(revoked, ['blob:test/0', 'blob:test/1']);
    });
  }

  it('reports a rejected play request and lets a new Play fetch again', async () => {
    let fetched = 0;
    const p = player(async () => {
      fetched += 1;
      return response(wav());
    });
    p.button('Play').dispatch('click');
    await flush();
    audios[0].plays[0].reject(new Error('Playback failed'));
    await flush();
    assert.equal(p.status(), 'The recording could not be played. Press Play to try again.');
    assert.equal(p.button('Play').disabled, false);
    assert.deepEqual(revoked, ['blob:test/0']);
    p.button('Play').dispatch('click');
    await flush();
    assert.equal(fetched, 2);
    audios[1].plays[0].resolve();
    await flush();
    assert.equal(p.status(), 'Playing.');
    p.dispose();
  });

  for (const [state, settleIt] of [
    ['paused', (p) => p.button('Pause').dispatch('click')],
    ['finished', () => audios[0].dispatch('ended')],
  ]) {
    it(`forgets the local copy of a ${state} story on a page-wide stop, so Play fetches again`, async () => {
      let fetched = 0;
      const p = player(async () => {
        fetched += 1;
        return response(wav());
      });
      p.button('Play').dispatch('click');
      await flush();
      audios[0].plays[0].resolve();
      await flush();
      settleIt(p);
      stopAll();
      assert.deepEqual(revoked, ['blob:test/0'], 'the paused or finished copy was released');
      assert.equal(audios[0].attributes.src, undefined);
      p.button('Play').dispatch('click');
      await flush();
      assert.equal(fetched, 2, 'Play after a page-wide stop fetches again');
      p.dispose();
    });
  }

  it('is no longer reached by a page-wide stop once disposed', async () => {
    const p = player(async () => response(wav()));
    p.button('Play').dispatch('click');
    await flush();
    p.dispose();
    const calls = audios[0].calls.length;
    stopAll();
    assert.equal(audios[0].calls.length, calls);
  });

  it('plays a valid WAV that a static host labels audio/x-wav, with parameters or another case', async () => {
    for (const type of ['audio/x-wav', 'AUDIO/X-WAV', 'audio/wav; charset=binary', 'audio/x-wav ; foo=bar', 'audio/wave']) {
      const before = audios.length;
      const p = player(async () => response(wav(), type));
      p.button('Play').dispatch('click');
      await flush();
      assert.equal(audios.length, before + 1, `${type} reaches playback`);
      audios[before].plays[0].resolve();
      await flush();
      assert.match(p.status(), /Playing/, type);
      p.dispose();
    }
  });

  it('refuses a wrong type, an oversized body or a malformed WAV without playing', async () => {
    for (const make of [() => response(wav(), 'text/html'), () => response(wav(), 'audio/mpeg'), () => response(wav(), 'application/octet-stream'), () => response(wav(), 'audio/wavx'), () => response(wav(), 'audio/x-wavx'), () => response(wav(64)), () => response(new Uint8Array(wav().length))]) {
      const p = player(async () => make());
      p.button('Play').dispatch('click');
      await flush();
      assert.equal(audios.length, 0);
      assert.equal(p.status(), 'The recording is not available.');
      p.dispose();
    }
  });
});

describe('one playback across the page', () => {
  it('pauses a native audio element when a story plays, and stops a story when the element plays', async () => {
    const native = new FakeAudio();
    registerElement(native, 'saved-recording');
    const p = player(async () => response(wav()));
    native.dispatch('play');
    p.button('Play').dispatch('click');
    assert.ok(native.calls.includes('pause'), 'the saved recording paused when the story was pressed');
    await flush();
    audios[0].plays[0].resolve();
    await flush();
    native.dispatch('play');
    assert.equal(p.status(), '', 'the story was torn down');
    assert.equal(audios[0].attributes.src, undefined);
    stopAll();
    assert.equal(native.calls.filter((call) => call === 'pause').length, 2);
    p.dispose();
  });

  it('stops every registered player on a page-wide stop until it is unregistered', () => {
    let stopped = 0;
    register('quiet', () => (stopped += 1));
    stopAll();
    assert.equal(stopped, 1, 'a registered player is stopped even when it is not playing');
    unregister('quiet');
    stopAll();
    assert.equal(stopped, 1, 'an unregistered player is left alone');
  });

  it('stopAll silences whatever is playing', () => {
    let stopped = 0;
    claim('x', () => (stopped += 1));
    stopAll();
    stopAll();
    assert.equal(stopped, 1);
  });
});
