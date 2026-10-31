// One playback at a time across the whole page: the recorder's listen-back,
// the saved original recording and every story player. Starting one stops the
// one before it; stopAll() is for sign-out, navigation, hidden pages and
// access failures.

let active = null;
// Every live player, audible or not, with what forgets its audio. Lifecycle
// stops (sign-out, hidden page) must also clear paused or finished players so
// a later Play has to fetch again with fresh access.
const live = new Map();

export function register(owner, teardown) {
  live.set(owner, teardown);
}

export function unregister(owner) {
  live.delete(owner);
}

// owner: any stable value naming the player; stop: silences it.
export function claim(owner, stop) {
  if (active && active.owner !== owner) {
    const previous = active;
    active = null;
    try {
      previous.stop();
    } catch {
      // A failing stop must not keep the new playback from starting.
    }
  }
  active = { owner, stop };
}

export function release(owner) {
  if (active?.owner === owner) active = null;
}

export function stopAll() {
  const previous = active;
  active = null;
  for (const stop of [previous?.stop, ...live.values()]) {
    try {
      stop?.();
    } catch {
      // Keep stopping the rest.
    }
  }
}

// For an existing <audio> element with its own controls: pressing play there
// stops whatever else plays, and playing something else pauses it.
export function registerElement(element, owner) {
  element.addEventListener('play', () => claim(owner, () => element.pause?.()));
  for (const type of ['pause', 'ended']) element.addEventListener(type, () => release(owner));
}
