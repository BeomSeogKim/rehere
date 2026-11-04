// The player for a recorded story, used by the owner and by visitors. Audio is
// fetched through the caller's authorized fetch, fully and within a fixed
// bound, checked as the expected 16 kHz mono 16-bit WAV, then played from a
// local Blob URL. Nothing plays without an explicit Play; any stop tears the
// audio down, and a late fetch or play() answer cannot start it again.

import { claim, register, release, unregister } from './playback.js';

export const WAV_HEADER_BYTES = 44;
export const MAX_WAV_BYTES = WAV_HEADER_BYTES + 9_600_000;

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

// The WAV media types a response may carry, with or without parameters. Static hosts often label .wav as audio/x-wav,
// so that alias is accepted next to audio/wav; every other type is refused, and the bytes are still checked by wavProblem.
const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);
const isWavType = (value) => WAV_TYPES.has(String(value).split(';')[0].trim().toLowerCase());

// Returns a fixed problem, or null when the bytes are exactly the expected WAV.
export function wavProblem(bytes, expectedSize) {
  if (!(bytes instanceof Uint8Array)) return 'not-bytes';
  if (bytes.length > MAX_WAV_BYTES || bytes.length !== expectedSize) return 'size';
  if (bytes.length <= WAV_HEADER_BYTES || (bytes.length - WAV_HEADER_BYTES) % 2 !== 0) return 'size';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ok =
    ascii(bytes, 0, 4) === 'RIFF' &&
    view.getUint32(4, true) === bytes.length - 8 &&
    ascii(bytes, 8, 4) === 'WAVE' &&
    ascii(bytes, 12, 4) === 'fmt ' &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16000 &&
    view.getUint32(28, true) === 32000 &&
    view.getUint16(32, true) === 2 &&
    view.getUint16(34, true) === 16 &&
    ascii(bytes, 36, 4) === 'data' &&
    view.getUint32(40, true) === bytes.length - WAV_HEADER_BYTES;
  return ok ? null : 'header';
}

export function formatMs(ms) {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

// A position in an original recording: the usual tenths when exact, otherwise
// exact milliseconds, so a chosen bound is never shown as a different position.
export function formatPosition(ms) {
  if (ms % 100 === 0) return formatMs(ms);
  const minutes = Math.floor(ms / 60_000);
  const rest = ms - minutes * 60_000;
  return `${minutes}:${String(Math.floor(rest / 1000)).padStart(2, '0')}.${String(rest % 1000).padStart(3, '0')}`;
}

// The optional bounds of an excerpt story, or null for a whole recording.
const excerptOf = (story) => {
  const range = story.sourceRange;
  return range && Number.isInteger(range.startMs) && Number.isInteger(range.endMs) && range.startMs >= 0 && range.endMs > range.startMs ? range : null;
};

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

// Reads a response body up to `limit` bytes; more than that is an error.
async function readBounded(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('size');
  if (!response.body?.getReader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error('size');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error('size');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// story: { title, cues:[{startMs,endMs,text}], durationMs, audio:{type,size} }.
// fetchAudio(signal) -> Response from the caller's authorized fetch.
// onPlaying() is called each time this player's current play() has actually
// started, never for a stale or abandoned one.
export function createStoryPlayer({ story, fetchAudio, owner = Symbol('story'), onPlaying = null }) {
  let generation = 0;
  let controller = null;
  let url = null;
  let audio = null;
  let activeCue = -1;
  let disposed = false;

  const status = el('p', { className: 'hint', role: 'status' });
  status.setAttribute('aria-live', 'polite');
  const now = el('p', { className: 'story-now' });
  now.setAttribute('aria-live', 'polite');
  const play = el('button', { type: 'button', textContent: 'Play' });
  const pause = el('button', { type: 'button', className: 'secondary', textContent: 'Pause', disabled: true });
  const stop = el('button', { type: 'button', className: 'secondary', textContent: 'Stop', disabled: true });
  const cueItems = story.cues.map((cue) => {
    const marker = el('span', { className: 'story-cue-marker', textContent: '' });
    return el('li', {}, [marker, el('span', { textContent: `${formatMs(cue.startMs)}–${formatMs(cue.endMs)} ` }), el('span', { textContent: cue.text })]);
  });
  const excerpt = excerptOf(story);
  const element = el('div', { className: 'story-player' }, [
    el('div', { className: 'actions space-camera' }, [play, pause, stop]),
    status,
    now,
    ...(excerpt
      ? [el('p', { className: 'hint', textContent: `Excerpt from the original recording: ${formatPosition(excerpt.startMs)}–${formatPosition(excerpt.endMs)}. Playback and caption times start at 0:00 of this excerpt.` })]
      : []),
    el('p', {
      className: 'hint',
      textContent: !story.cues.length ? 'No captions supplied.'
        : story.captionDraft ? 'Captions (AI-drafted, then reviewed by a person; not checked by Rehere):' : 'Captions (supplied text; not checked by Rehere):',
    }),
    el('ol', { className: 'story-cues' }, cueItems),
  ]);

  function showCue(index) {
    if (index === activeCue) return;
    if (activeCue >= 0) {
      cueItems[activeCue].children[0].textContent = '';
      cueItems[activeCue].removeAttribute('aria-current');
    }
    activeCue = index;
    if (index >= 0) {
      cueItems[index].children[0].textContent = 'Now: ';
      cueItems[index].setAttribute('aria-current', 'true');
    }
    now.textContent = index >= 0 ? story.cues[index].text : '';
  }

  // Silences and forgets the audio entirely. A new Play fetches it again.
  function teardown(message = '') {
    generation += 1;
    controller?.abort();
    controller = null;
    if (audio) {
      audio.pause?.();
      audio.removeAttribute('src');
      audio.load?.();
      audio = null;
    }
    if (url) URL.revokeObjectURL(url);
    url = null;
    showCue(-1);
    release(owner);
    play.disabled = disposed;
    pause.disabled = true;
    stop.disabled = true;
    status.textContent = message;
  }

  // Play is claimed before anything is fetched, so pressing Play elsewhere stops
  // this one at once, even while it is still loading. Every media event and
  // play() answer is bound to the element and generation it started with.
  async function begin(media, mine) {
    try {
      await media.play();
    } catch {
      if (mine === generation && audio === media) teardown('The recording could not be played. Press Play to try again.');
      return;
    }
    if (mine !== generation || audio !== media || disposed) {
      media.pause?.();
      return;
    }
    play.disabled = true;
    pause.disabled = false;
    stop.disabled = false;
    status.textContent = 'Playing.';
    onPlaying?.();
  }

  async function start() {
    if (disposed) return;
    if (audio && url) {
      claim(owner, () => teardown());
      await begin(audio, generation);
      return;
    }
    teardown('Loading the recording…');
    claim(owner, () => teardown());
    const mine = generation;
    controller = new AbortController();
    play.disabled = true;
    stop.disabled = false;
    let bytes;
    try {
      const response = await fetchAudio(controller.signal);
      if (mine !== generation) return;
      if (!response.ok || !isWavType(response.headers?.get?.('content-type') ?? story.audio.type)) throw new Error('response');
      bytes = await readBounded(response, Math.min(story.audio.size, MAX_WAV_BYTES));
    } catch {
      if (mine === generation) teardown('The recording is not available.');
      return;
    }
    if (mine !== generation) return;
    if (wavProblem(bytes, story.audio.size)) {
      teardown('The recording is not available.');
      return;
    }
    url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const media = document.createElement('audio');
    audio = media;
    media.preload = 'auto';
    const current = () => mine === generation && audio === media && !disposed;
    media.addEventListener('error', () => {
      if (current()) teardown('The recording could not be played. Press Play to try again.');
    });
    media.addEventListener('timeupdate', () => {
      if (!current()) return;
      const ms = media.currentTime * 1000;
      showCue(story.cues.findIndex((cue) => ms >= cue.startMs && ms < cue.endMs));
    });
    media.addEventListener('ended', () => {
      if (!current()) return;
      showCue(-1);
      release(owner);
      play.disabled = false;
      pause.disabled = true;
      status.textContent = 'Finished.';
    });
    media.src = url;
    await begin(media, mine);
  }

  register(owner, () => teardown());
  play.addEventListener('click', start);
  pause.addEventListener('click', () => {
    if (!audio) return;
    audio.pause?.();
    release(owner);
    play.disabled = false;
    pause.disabled = true;
    status.textContent = 'Paused.';
  });
  stop.addEventListener('click', () => teardown('Stopped.'));

  return {
    element,
    stop: () => teardown(),
    dispose() {
      disposed = true;
      unregister(owner);
      teardown();
      element.replaceChildren();
    },
  };
}
