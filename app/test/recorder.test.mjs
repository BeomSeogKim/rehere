import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRecorder } from '../public/recorder.js';

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  get stopped() {
    return this.tracks.every((track) => track.stopped);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mirrors MediaRecorder: stop() only requests the end; the final
// 'dataavailable' and 'stop' events arrive later via finalize().
class FakeMediaRecorder extends EventTarget {
  static instances = [];
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus';
  }
  constructor(stream, options) {
    super();
    this.stream = stream;
    this.mimeType = options?.mimeType ?? '';
    this.state = 'inactive';
    this.stopCalls = 0;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.stopCalls += 1;
    this.state = 'inactive';
  }
  finalize(bytes = 'audio-bytes') {
    const data = new Event('dataavailable');
    data.data = new Blob([bytes], { type: this.mimeType });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event('stop'));
  }
}

function setup({ maxMs } = {}) {
  FakeMediaRecorder.instances = [];
  const requests = [];
  const mediaDevices = {
    getUserMedia(constraints) {
      const request = deferred();
      requests.push({ constraints, ...request });
      return request.promise;
    },
  };
  const timers = { pending: [], setTimeout(fn, ms) { this.pending.push({ fn, ms }); return this.pending.length; }, clearTimeout(id) { if (id) this.pending[id - 1] = null; } };
  const recorder = createRecorder({ mediaDevices, MediaRecorder: FakeMediaRecorder, maxMs, timers });
  return { recorder, requests, timers, media: () => FakeMediaRecorder.instances.at(-1) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const state = (recorder) => recorder.snapshot().state;

async function startRecording(context) {
  context.recorder.start();
  const stream = new FakeStream();
  context.requests.at(-1).resolve(stream);
  await flush();
  return stream;
}

describe('voice recorder', () => {
  it('is unavailable without microphone or recorder support and never asks', () => {
    assert.equal(state(createRecorder({})), 'unavailable');
    const withoutRecorder = createRecorder({ mediaDevices: { getUserMedia: () => assert.fail('asked') } });
    withoutRecorder.start();
    assert.equal(state(withoutRecorder), 'unavailable');
  });

  it('does not request the microphone until start is called', () => {
    const { recorder, requests } = setup();
    assert.equal(state(recorder), 'idle');
    assert.equal(requests.length, 0);
    recorder.start();
    assert.equal(state(recorder), 'requesting');
    assert.deepEqual(requests[0].constraints, { audio: true });
  });

  it('records, finalizes asynchronously, and releases the microphone', async () => {
    const context = setup();
    const stream = await startRecording(context);
    assert.equal(state(context.recorder), 'recording');
    assert.equal(context.media().mimeType, 'audio/webm;codecs=opus');

    const stopped = context.recorder.stop();
    assert.equal(state(context.recorder), 'finalizing');
    assert.equal(context.recorder.snapshot().recording, null, 'not ready before final data');
    let settled = false;
    stopped.then(() => (settled = true));
    await flush();
    assert.equal(settled, false);

    context.media().finalize('voice');
    const blob = await stopped;
    assert.equal(await blob.text(), 'voice');
    assert.equal(blob.type, 'audio/webm;codecs=opus');
    assert.equal(state(context.recorder), 'recorded');
    assert.equal(context.recorder.snapshot().recording, blob);
    assert.ok(stream.stopped);
  });

  it('lets a save wait for an in-progress stop and receive the same recording', async () => {
    const context = setup();
    await startRecording(context);
    const first = context.recorder.stop();
    const second = context.recorder.stop();
    context.media().finalize();
    assert.equal(await first, await second);
    assert.equal(await context.recorder.stop(), context.recorder.snapshot().recording);
  });

  it('discards during finalization, ignores late data and releases the microphone', async () => {
    const context = setup();
    const stream = await startRecording(context);
    const stopped = context.recorder.stop();
    context.recorder.discard();
    assert.equal(state(context.recorder), 'idle');
    assert.ok(stream.stopped);
    assert.equal(await stopped, null);

    context.media().finalize();
    assert.equal(state(context.recorder), 'idle');
    assert.equal(context.recorder.snapshot().recording, null);
  });

  it('discards an active recording by stopping the recorder and tracks', async () => {
    const context = setup();
    const stream = await startRecording(context);
    context.recorder.discard();
    assert.equal(context.media().stopCalls, 1);
    assert.ok(stream.stopped);
    assert.equal(state(context.recorder), 'idle');
    assert.equal(context.timers.pending.filter(Boolean).length, 0, 'duration limit cleared');
  });

  it('removes a finished recording on discard', async () => {
    const context = setup();
    await startRecording(context);
    const stopped = context.recorder.stop();
    context.media().finalize();
    await stopped;
    context.recorder.discard();
    assert.equal(state(context.recorder), 'idle');
    assert.equal(context.recorder.snapshot().recording, null);
  });

  it('stops a stream granted after the request was cancelled', async () => {
    const { recorder, requests } = setup();
    recorder.start();
    recorder.discard();
    assert.equal(state(recorder), 'idle');
    const late = new FakeStream();
    requests[0].resolve(late);
    await flush();
    assert.ok(late.stopped);
    assert.equal(state(recorder), 'idle');
    assert.equal(FakeMediaRecorder.instances.length, 0);
  });

  it('ignores a late denial after the request was cancelled', async () => {
    const { recorder, requests } = setup();
    recorder.start();
    recorder.discard();
    requests[0].reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await flush();
    assert.equal(state(recorder), 'idle');
  });

  for (const order of ['A then B', 'B then A']) {
    it(`keeps the newer request when an older grant arrives late (${order})`, async () => {
      const { recorder, requests, media } = setup();
      recorder.start();
      recorder.discard();
      recorder.start();
      const [a, b] = [new FakeStream(), new FakeStream()];
      const resolveA = () => requests[0].resolve(a);
      const resolveB = () => requests[1].resolve(b);
      if (order === 'A then B') {
        resolveA();
        await flush();
        assert.equal(state(recorder), 'requesting');
        resolveB();
      } else {
        resolveB();
        await flush();
        resolveA();
      }
      await flush();
      assert.ok(a.stopped, 'stale stream released');
      assert.equal(b.stopped, false, 'current stream untouched');
      assert.equal(state(recorder), 'recording');
      assert.equal(media().stream, b);
    });
  }

  it('reports a denied microphone and allows another attempt', async () => {
    const { recorder, requests } = setup();
    recorder.start();
    requests[0].reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await flush();
    assert.equal(state(recorder), 'denied');
    assert.match(recorder.snapshot().message, /still save photos and writing/);
    recorder.start();
    assert.equal(state(recorder), 'requesting');
  });

  it('reports a missing microphone as an error', async () => {
    const { recorder, requests } = setup();
    recorder.start();
    requests[0].reject(Object.assign(new Error('none'), { name: 'NotFoundError' }));
    await flush();
    assert.equal(state(recorder), 'error');
    assert.match(recorder.snapshot().message, /No microphone/);
  });

  it('stops automatically at the duration limit', async () => {
    const context = setup({ maxMs: 1000 });
    await startRecording(context);
    const [limit] = context.timers.pending;
    assert.equal(limit.ms, 1000);
    limit.fn();
    assert.equal(state(context.recorder), 'finalizing');
    context.media().finalize();
    assert.equal(state(context.recorder), 'recorded');
  });

  it('treats an empty recording as an error', async () => {
    const context = setup();
    const stream = await startRecording(context);
    const stopped = context.recorder.stop();
    context.media().dispatchEvent(new Event('stop'));
    assert.equal(await stopped, null);
    assert.equal(state(context.recorder), 'error');
    assert.ok(stream.stopped);
  });

  it('releases the microphone when the recorder fails', async () => {
    const context = setup();
    const stream = await startRecording(context);
    const stopped = context.recorder.stop();
    context.media().dispatchEvent(new Event('error'));
    assert.equal(await stopped, null);
    assert.equal(state(context.recorder), 'error');
    assert.ok(stream.stopped);
  });

  describe('leaving the entry screen', () => {
    it('cancels a pending request and releases a late grant', async () => {
      const { recorder, requests } = setup();
      recorder.start();
      recorder.leave();
      assert.equal(state(recorder), 'idle');
      const late = new FakeStream();
      requests[0].resolve(late);
      await flush();
      assert.ok(late.stopped);
      assert.equal(state(recorder), 'idle');
    });

    it('stops an active capture and keeps the finished recording', async () => {
      const context = setup();
      const stream = await startRecording(context);
      context.recorder.leave();
      assert.equal(state(context.recorder), 'finalizing');
      assert.equal(context.media().stopCalls, 1);
      context.media().finalize('kept');
      assert.equal(state(context.recorder), 'recorded');
      assert.equal(await context.recorder.snapshot().recording.text(), 'kept');
      assert.ok(stream.stopped);
    });

    it('lets a pending stop-and-save receive the recording', async () => {
      const context = setup();
      await startRecording(context);
      const saving = context.recorder.stop();
      context.recorder.leave();
      assert.equal(context.media().stopCalls, 1, 'no second stop');
      context.media().finalize();
      assert.equal(await saving, context.recorder.snapshot().recording);
    });

    it('keeps a completed recording and changes nothing else', async () => {
      const context = setup();
      await startRecording(context);
      const stopped = context.recorder.stop();
      context.media().finalize();
      const blob = await stopped;
      context.recorder.leave();
      assert.equal(state(context.recorder), 'recorded');
      assert.equal(context.recorder.snapshot().recording, blob);

      const denied = setup();
      denied.recorder.start();
      denied.requests[0].reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      await flush();
      denied.recorder.leave();
      assert.equal(state(denied.recorder), 'denied');
      assert.equal(state(createRecorder({})), 'unavailable');
      createRecorder({}).leave();
    });
  });

  it('notifies subscribers of each state change', async () => {
    const context = setup();
    const seen = [];
    context.recorder.subscribe((snapshot) => seen.push(snapshot.state));
    await startRecording(context);
    context.recorder.stop();
    context.media().finalize();
    assert.deepEqual(seen, ['requesting', 'recording', 'finalizing', 'recorded']);
  });
});

describe('restoring a received recording', () => {
  it('shows it as finished without asking for the microphone, and discarding it returns to idle', () => {
    const r = setup();
    const blob = new Blob(['voice'], { type: 'audio/webm' });
    assert.equal(r.recorder.restore(blob), true);
    assert.equal(r.requests.length, 0, 'no microphone request');
    assert.equal(r.recorder.snapshot().state, 'recorded');
    assert.equal(r.recorder.snapshot().recording, blob);
    r.recorder.discard();
    assert.equal(r.recorder.snapshot().state, 'idle');
    assert.equal(r.recorder.snapshot().recording, null);
  });

  it('is refused during a take, and a browser that cannot record goes back to unavailable', async () => {
    const r = setup();
    r.recorder.start();
    assert.equal(r.recorder.restore(new Blob(['voice'])), false, 'a take in progress is never replaced');
    r.recorder.discard();
    assert.equal(r.recorder.restore(new Blob([])), false, 'an empty recording is not restored');

    const unsupported = createRecorder({});
    const { message } = unsupported.snapshot();
    assert.equal(unsupported.restore(new Blob(['voice'])), true);
    assert.equal(unsupported.snapshot().state, 'recorded');
    unsupported.discard();
    assert.deepEqual([unsupported.snapshot().state, unsupported.snapshot().message], ['unavailable', message], 'Record does not become available');
  });
});

describe('the automatic stop', () => {
  it('stops a take one second before five minutes by default', async () => {
    const { MAX_RECORDING_MS } = await import('../public/recorder.js');
    assert.equal(MAX_RECORDING_MS, 299_000);
    const context = setup();
    await startRecording(context);
    assert.equal(context.timers.pending.filter(Boolean).at(-1).ms, 299_000);
  });
});
