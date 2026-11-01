// The visitor-only entry: opens one shared view from #/visit/<capability>.
// It has no sign-in or contribution controls, never reads or sets cookies or
// browser storage, and asks the server for nothing until a well-formed link
// is in the address. Hiding, leaving and returning (including from the
// back-forward cache) are handled by the visit itself, which re-checks access.
import { mountVisitor, visitSource } from './visits.js';
import { stopAll } from './playback.js';

// The same rule as the owner app's visit route.
export const VISIT = /^#\/visit\/(rhv_[A-Za-z0-9_-]{43})$/;
export const NO_LINK = 'This page opens a view someone shared with you. Open the complete link you were given; nothing is shown without it.';

export function startVisitorEntry(container, { location = globalThis.location, target = globalThis } = {}) {
  let visitor = null;
  let token = null;
  // Every address change replaces what is shown at once; an earlier visit's
  // reads end with it and can never draw again.
  function route() {
    const match = VISIT.exec(location.hash);
    const next = match ? match[1] : null;
    if (next && next === token && visitor) return;
    stopAll();
    visitor?.dispose();
    visitor = null;
    token = next;
    if (!next) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = NO_LINK;
      container.replaceChildren(note);
      return;
    }
    visitor = mountVisitor(container, visitSource(next));
  }
  // Leaving the page stops sound; the visit pauses itself and re-checks access
  // when the page is shown again.
  const onPageHide = () => stopAll();
  target.addEventListener?.('hashchange', route);
  target.addEventListener?.('pagehide', onPageHide);
  route();
  return {
    dispose() {
      target.removeEventListener?.('hashchange', route);
      target.removeEventListener?.('pagehide', onPageHide);
      stopAll();
      visitor?.dispose();
      visitor = null;
      token = null;
    },
  };
}

const container = globalThis.document?.getElementById?.('visit');
if (container) startVisitorEntry(container);
