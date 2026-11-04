// The entry of a frozen, exported visitor snapshot (see STATIC-DEMO.md). It
// reuses the visitor rendering and reads only files exported next to the page.
// Nothing here can reach the app: there is no token, no API request and no
// access re-check, so revocation and withdrawal are not live in this copy.
import { mountVisitor } from './visits.js';
import { stopAll } from './playback.js';
import { pickViewButton } from './version-link.js';

const read = (path, signal) => fetch(`./data/${path}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });

// The same source shape as the live visit. `kind: 'visit'` selects the visitor
// presentation; `check` is always true because there is no server to ask.
export function staticSource() {
  return {
    kind: 'visit',
    manifest: async (signal) => {
      const response = await read('manifest.json', signal);
      return response.ok ? response.json() : null;
    },
    check: async () => true,
    asset: (viewId, name, signal) => read(`assets/${encodeURIComponent(viewId)}/${name}`, signal),
    storyAudio: (storyId, signal) => read(`stories/${encodeURIComponent(storyId)}/audio.wav`, signal),
    recordingAudio: (recordingId, signal) => read(`recordings/${encodeURIComponent(recordingId)}/audio.wav`, signal),
  };
}

// A link may ask to open on one saved version: snapshot.html?version=<exact version button text>. The text is compared only
// with the saved-view buttons the page draws (see version-link.js); one match is pressed once, anything else is ignored, and
// the page works the same without the parameter.
function openRequestedVersion(container, label) {
  const press = () => {
    const button = pickViewButton(container.querySelectorAll('button'), label);
    button?.click();
    return Boolean(button);
  };
  if (press()) return;
  const watcher = new MutationObserver(() => press() && watcher.disconnect());
  watcher.observe(container, { childList: true, subtree: true });
  setTimeout(() => watcher.disconnect(), 15_000);
}

const container = globalThis.document?.getElementById?.('visit');
if (container) {
  mountVisitor(container, staticSource(), { limitedPhotoView: true });
  const requested = new URLSearchParams(globalThis.location?.search ?? '').get('version');
  if (requested) openRequestedVersion(container, requested);
  globalThis.addEventListener?.('pagehide', () => stopAll());
}
