export const MAX_RECORDING_MS = 5 * 60 * 1000;

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];

// Voice capture as an explicit state machine. Browser APIs are injected so the
// same module runs against fakes in tests and a synthetic stream in QA.
//
// States: unavailable, idle, requesting, recording, finalizing, recorded,
// denied, error. The microphone is requested only by start().
export function createRecorder({ mediaDevices, MediaRecorder, maxMs = MAX_RECORDING_MS, timers = globalThis } = {}) {
  const supported = typeof mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder === 'function';
  let state = supported ? 'idle' : 'unavailable';
  let message = supported ? '' : 'Voice recording is not available in this browser. You can still save photos and writing.';
  let attempt = 0;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recording = null;
  let startedAt = null;
  let limitTimer = null;
  let stopWaiters = [];
  // The state to return to when a restored recording is discarded.
  let restoredFrom = null;
  const listeners = new Set();

  const snapshot = () => ({ state, message, recording, startedAt });

  function set(next, nextMessage = '') {
    state = next;
    message = nextMessage;
    for (const listener of listeners) listener(snapshot());
  }

  function stopTracks(target) {
    for (const track of target?.getTracks() ?? []) track.stop();
  }

  function release() {
    timers.clearTimeout(limitTimer);
    limitTimer = null;
    stopTracks(stream);
    stream = null;
    recorder = null;
    chunks = [];
    startedAt = null;
  }

  function settle(result) {
    const waiters = stopWaiters;
    stopWaiters = [];
    for (const resolve of waiters) resolve(result);
  }

  function fail(text) {
    release();
    set('error', text);
    settle(null);
  }

  function finish(type) {
    const blob = new Blob(chunks, { type });
    release();
    if (blob.size === 0) {
      fail('Nothing was recorded. Please try again.');
      return;
    }
    recording = blob;
    set('recorded');
    settle(blob);
  }

  async function start() {
    if (!['idle', 'denied', 'error'].includes(state)) return;
    const current = ++attempt;
    set('requesting');
    let granted;
    try {
      granted = await mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (current !== attempt) return;
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        set('denied', 'Microphone access was not allowed. You can still save photos and writing.');
      } else if (error?.name === 'NotFoundError') {
        set('error', 'No microphone was found. You can still save photos and writing.');
      } else {
        set('error', 'The microphone could not be started. You can still save photos and writing.');
      }
      return;
    }
    // A permission answer can arrive after the request was cancelled or replaced.
    if (current !== attempt || state !== 'requesting') {
      stopTracks(granted);
      return;
    }
    stream = granted;
    let own;
    try {
      const mimeType = PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
      own = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder = own;
      own.addEventListener('dataavailable', (event) => {
        if (own === recorder && event.data?.size > 0) chunks.push(event.data);
      });
      // The final chunk is delivered asynchronously before 'stop'.
      own.addEventListener('stop', () => {
        if (own === recorder) finish(own.mimeType || chunks[0]?.type || '');
      });
      own.addEventListener('error', () => {
        if (own === recorder) fail('Recording stopped unexpectedly. Please try again.');
      });
      own.start();
    } catch {
      fail('Recording could not be started. You can still save photos and writing.');
      return;
    }
    startedAt = Date.now();
    limitTimer = timers.setTimeout(() => stop(), maxMs);
    set('recording');
  }

  // Resolves with the recording once the recorder has delivered its final data,
  // or with null when it is discarded or fails first.
  function stop() {
    if (state === 'recorded') return Promise.resolve(recording);
    if (state !== 'recording' && state !== 'finalizing') return Promise.resolve(null);
    const done = new Promise((resolve) => stopWaiters.push(resolve));
    if (state === 'recording') {
      timers.clearTimeout(limitTimer);
      limitTimer = null;
      set('finalizing');
      try {
        recorder.stop();
      } catch {
        fail('The recording could not be finished. Please try again.');
      }
    }
    return done;
  }

  // Cancels a pending request, abandons a recording in progress, or removes a
  // finished recording. Always releases the microphone.
  function discard() {
    if (state === 'unavailable') return;
    attempt += 1;
    const active = recorder;
    release();
    try {
      if (active && active.state !== 'inactive') active.stop();
    } catch {
      // The tracks are already stopped, which ends the recording either way.
    }
    recording = null;
    settle(null);
    const back = restoredFrom ?? { state: 'idle', message: '' };
    restoredFrom = null;
    set(back.state, back.message);
  }

  // Shows a recording the server already received as a finished one. It never
  // asks for the microphone; discarding it returns to the earlier state, so a
  // browser that cannot record does not appear able to.
  function restore(blob) {
    if (!['idle', 'unavailable'].includes(state) || !(blob instanceof Blob) || blob.size === 0) return false;
    restoredFrom = { state, message };
    recording = blob;
    set('recorded');
    return true;
  }

  // For leaving the entry screen: no capture may continue out of view, but a
  // recording the person made is kept rather than thrown away.
  function leave() {
    if (state === 'requesting') discard();
    else if (state === 'recording') stop();
  }

  return {
    start,
    stop,
    discard,
    restore,
    leave,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
