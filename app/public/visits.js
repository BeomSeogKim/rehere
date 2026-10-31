// The read-only visitor screen for a saved snapshot. The same component shows
// the owner's preview before issue and the public visit afterwards; only the
// source of data differs. It never edits, never asks for sign-in and never
// links to files. Access is re-checked on a heartbeat and whenever the page
// returns to view; any doubt closes the scene.

import { createViewer } from './scene-viewer.js';
import { createStoryPlayer } from './story-player.js';

export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 20_000;
export const UNAVAILABLE = 'This shared view is not available.';
const DEVICE_NOTE = 'Closing access stops this page from showing the scene. Copies already saved on a device cannot be removed from here.';

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

// Runs one request with its own abort after `ms`, also aborted by `outer`.
async function timed(start, ms, outer) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort);
  const timer = setTimeout(abort, ms);
  try {
    return await start(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

// A public visit: only the visit token in the Authorization header, no cookies.
export function visitSource(token) {
  const init = (signal, method = 'GET') => ({
    method,
    headers: { authorization: `Bearer ${token}` },
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal,
  });
  return {
    kind: 'visit',
    manifest: async (signal) => {
      const response = await fetch('/api/visit', init(signal));
      return response.ok ? response.json() : null;
    },
    check: async (signal) => (await fetch('/api/visit', init(signal, 'HEAD'))).ok,
    asset: (viewId, name, signal) => fetch(`/api/visit/assets/${encodeURIComponent(viewId)}/${name}`, init(signal)),
    storyAudio: (storyId, signal) => fetch(`/api/visit/stories/${encodeURIComponent(storyId)}/audio.wav`, init(signal)),
  };
}

// The owner's preview of a candidate, read with the owner's own session.
export function previewSource(sharesUrl, previewId) {
  const init = (signal) => ({ credentials: 'same-origin', cache: 'no-store', signal });
  const url = `${sharesUrl}/previews/${encodeURIComponent(previewId)}`;
  return {
    kind: 'preview',
    manifest: async (signal) => {
      const response = await fetch(url, init(signal));
      return response.ok ? (await response.json())?.publicView ?? null : null;
    },
    check: async (signal) => (await fetch(url, init(signal))).ok,
    asset: (viewId, name, signal) => fetch(`${url}/assets/${encodeURIComponent(viewId)}/${name}`, init(signal)),
    storyAudio: (storyId, signal) => fetch(`${url}/stories/${encodeURIComponent(storyId)}/audio.wav`, init(signal)),
  };
}

function eraText(era, labelOf) {
  if (!era || era.kind === 'unknown' || (era.kind !== 'relative' && !era.start)) return 'Time unknown';
  const when = { exact: era.start, range: `${era.start} to ${era.end}`, relative: era.label }[era.kind];
  if (!when) return 'Time unknown';
  const relation = era.relation && era.relativeToViewId ? ` (${era.relation === 'same-time' ? 'same time as' : era.relation} “${labelOf(era.relativeToViewId)}”)` : '';
  return `Owner’s assertion: ${when}${relation}`;
}

function viewDetails(view, labelOf) {
  const nodes = [el('h3', { textContent: view.label })];
  nodes.push(el('p', { textContent: eraText(view.era, labelOf) }));
  if (view.era && view.era.kind !== 'unknown' && view.era.statement) {
    nodes.push(el('p', { className: 'hint', textContent: `Based on: ${view.era.statement}${view.era.assertedByLabel ? ` (asserted by ${view.era.assertedByLabel})` : ''}` }));
  }
  const photo = view.evidence?.photo;
  if (photo) {
    nodes.push(
      el('p', {
        className: 'hint',
        textContent: `Photo: provided by ${photo.providerLabel || 'an unnamed provider'}; ${photo.attributedCaptureDate ? `date given by them: ${photo.attributedCaptureDate}` : 'date unknown'}.`,
      }),
    );
  }
  nodes.push(el('p', { className: 'hint', textContent: 'Shape and depth: a model estimate from this one photo, not a measurement. Areas the photo did not show are left empty.' }));
  for (const support of view.evidence?.support ?? []) {
    if (support?.kind !== 'human_recollection') continue;
    nodes.push(
      el('p', {
        className: 'hint',
        textContent: `Arrangement: based on a recollection by ${support.providerLabel || 'an unnamed person'}, selected by the owner. This is separate from the model’s shape estimate.`,
      }),
    );
  }
  const quotes = view.evidence?.recollections ?? [];
  if (quotes.length) {
    nodes.push(
      el('ul', { className: 'collab-list' },
        quotes.map((quote) => {
          const item = el('li', {}, [el('p', { className: 'hint', textContent: `In ${quote.providerLabel || 'their'}’s own words:` }), el('p', { className: 'memory-text', textContent: quote.text })]);
          if (quote.periodClaim) item.append(el('p', { className: 'hint', textContent: `When, as they remember it: ${quote.periodClaim}` }));
          return item;
        }),
      ),
    );
  }
  nodes.push(el('p', { className: 'hint', textContent: 'None of this is verified history: the photo, the model’s estimate and people’s recollections are shown as what they are.' }));
  return nodes;
}

// source: { manifest(signal) -> view|null, check(signal) -> boolean,
// asset(viewId, name, signal) -> Response }. onState receives 'loading',
// '3d', '2d', 'paused' or 'unavailable'; '2d' means the 3D scene was not shown.
export function mountVisitor(container, source, { onState = () => {} } = {}) {
  let generation = 0;
  let controller = null;
  let viewer = null;
  let urls = [];
  // Story players of the view on screen; every close or view change disposes
  // them, which stops and forgets their audio.
  let players = [];
  const disposePlayers = () => {
    for (const player of players.splice(0)) player.dispose();
  };
  let timer = null;
  let state = 'loading';
  let disposed = false;

  const setState = (next) => {
    state = next;
    onState(next);
  };

  // Releases everything this screen holds: the 3D view, object URLs, pending
  // reads and the heartbeat.
  function clear() {
    clearTimeout(timer);
    timer = null;
    disposePlayers();
    controller?.abort();
    controller = null;
    viewer?.dispose();
    viewer = null;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    container.replaceChildren();
  }

  function unavailable() {
    generation += 1;
    clear();
    container.append(el('p', { className: 'form-message is-error', role: 'alert', textContent: UNAVAILABLE }), el('p', { className: 'hint', textContent: DEVICE_NOTE }));
    setState('unavailable');
  }

  function scheduleHeartbeat(mine) {
    timer = setTimeout(async () => {
      if (mine !== generation) return;
      let ok = false;
      try {
        ok = await timed((signal) => source.check(signal), HEARTBEAT_TIMEOUT_MS, controller?.signal);
      } catch {
        ok = false;
      }
      if (mine !== generation) return;
      if (!ok) unavailable();
      else scheduleHeartbeat(mine);
    }, HEARTBEAT_MS);
  }

  async function render(manifest, surface, textureUrl, mine) {
    const views = new Map(manifest.views.map((view) => [view.id, view]));
    const labelOf = (id) => views.get(id)?.label ?? 'another view';
    let currentId = manifest.startViewId;
    const viewport = el('div', { className: 'space-viewport' });
    const details = el('div', { className: 'visit-details' });
    const message = el('p', { className: 'hint', role: 'status' });
    const buttons = el('div', { className: 'actions space-camera' });
    const storyBox = el('div', { className: 'visit-stories' });
    const renderStories = (viewId) => {
      disposePlayers();
      const viewStories = (manifest.stories ?? []).filter((story) => story.viewId === viewId);
      storyBox.replaceChildren(
        ...(viewStories.length ? [el('h3', { textContent: 'Recorded stories for this view' })] : []),
        ...viewStories.map((story) => {
          const player = createStoryPlayer({ story, fetchAudio: (signal) => source.storyAudio(story.id, signal) });
          players.push(player);
          return el('div', { className: 'visit-story' }, [
            el('p', { className: 'space-choice-label', textContent: story.title }),
            el('p', {
              className: 'hint',
              textContent: `Recording by ${story.providerLabel || 'an unnamed provider'}. Captions written by ${story.captionAuthorLabel || 'the owner'}; they are not checked by Rehere. Nothing plays until you press Play.`,
            }),
            player.element,
          ]);
        }),
      );
    };
    const showView = (id) => {
      currentId = id;
      const view = views.get(id);
      viewer?.applyEdit(view.edit);
      details.replaceChildren(...viewDetails(view, labelOf));
      renderStories(id);
      for (const button of buttons.children) button.setAttribute('aria-pressed', String(button.viewId === id));
    };
    for (const view of manifest.views) {
      const button = el('button', { type: 'button', className: 'secondary', textContent: view.label, viewId: view.id, onclick: () => showView(view.id) });
      buttons.append(button);
    }
    const back = el('button', { type: 'button', className: 'secondary', textContent: 'Back to the starting view' });
    container.replaceChildren(
      el('h1', { textContent: manifest.title }),
      // Identifies which saved copy this is; the copy does not change later. A
      // preview has no copy id or date until it is issued, so it says so.
      el('p', {
        className: 'hint',
        textContent:
          source.kind === 'preview'
            ? 'Preview — not yet issued'
            : `Shared ${new Date(manifest.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} · saved copy ${String(manifest.id).slice(0, 8)}`,
      }),
      el('p', { className: 'hint', textContent: manifest.synthetic ? 'Synthetic test material, shared by the owner.' : 'Shared by the owner.' }),
      viewport,
      message,
      buttons,
      back,
      details,
      storyBox,
      el('p', { className: 'hint', textContent: DEVICE_NOTE }),
    );

    let created = null;
    try {
      created = await createViewer(viewport, surface, textureUrl, `3D view: ${manifest.title}`);
    } catch (error) {
      if (mine !== generation) return;
      if (error?.message !== 'webgl') {
        unavailable();
        return;
      }
      // The derived photo and the text, clearly not presented as the 3D scene.
      viewport.replaceChildren(el('img', { className: 'space-proposal', src: textureUrl, alt: `The photo used for “${manifest.title}”` }));
      message.textContent = 'The 3D view is not available in this browser. Showing the photo used for the scene instead; the arrangement between views is described in the text.';
      back.hidden = true;
      showView(currentId);
      setState('2d');
      scheduleHeartbeat(mine);
      return;
    }
    if (mine !== generation) {
      created.dispose();
      return;
    }
    viewer = created;
    viewer.setCamera(manifest.camera);
    back.addEventListener('click', () => viewer?.setCamera(manifest.camera));
    message.textContent = 'Drag to look around; switching views keeps the same camera so they can be compared.';
    showView(currentId);
    setState('3d');
    scheduleHeartbeat(mine);
  }

  // Opens from scratch: manifest, start-view assets, a final access check,
  // then the scene. Every step is dropped if a newer open or a close happened.
  async function open() {
    if (disposed) return;
    generation += 1;
    const mine = generation;
    clear();
    container.append(el('p', { className: 'hint', textContent: 'Opening the shared view…' }));
    setState('loading');
    controller = new AbortController();
    const outer = controller.signal;
    try {
      const manifest = await timed((signal) => source.manifest(signal), LOAD_TIMEOUT_MS, outer);
      if (mine !== generation) return;
      const start = manifest?.views?.find((view) => view.id === manifest.startViewId);
      if (!start) throw new Error('manifest');
      const [surfaceResponse, textureResponse] = await Promise.all([
        timed((signal) => source.asset(start.id, 'surface.json', signal), LOAD_TIMEOUT_MS, outer),
        timed((signal) => source.asset(start.id, 'texture.jpg', signal), LOAD_TIMEOUT_MS, outer),
      ]);
      if (mine !== generation) return;
      if (!surfaceResponse.ok || !textureResponse.ok) throw new Error('asset');
      const [surface, texture] = await Promise.all([surfaceResponse.json(), textureResponse.blob()]);
      if (mine !== generation) return;
      const stillAllowed = await timed((signal) => source.check(signal), HEARTBEAT_TIMEOUT_MS, outer);
      if (mine !== generation) return;
      if (!stillAllowed) throw new Error('revoked');
      const url = URL.createObjectURL(texture);
      urls.push(url);
      await render(manifest, surface, url, mine);
    } catch {
      if (mine === generation) unavailable();
    }
  }

  // Hidden pages stop at once; coming back starts again with fresh checks.
  function pause() {
    if (disposed || state === 'unavailable' || state === 'paused') return;
    generation += 1;
    clear();
    container.append(el('p', { className: 'hint', textContent: 'Paused while this page is hidden. Access is checked again when you return.' }));
    setState('paused');
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') pause();
    else if (state === 'paused') open();
  };
  document.addEventListener?.('visibilitychange', onVisibility);
  globalThis.addEventListener?.('pagehide', pause);
  globalThis.addEventListener?.('pageshow', onVisibility);

  // A page that starts hidden fetches nothing until it is shown.
  if (document.visibilityState === 'hidden') {
    container.replaceChildren(el('p', { className: 'hint', textContent: 'Paused while this page is hidden. Access is checked again when you return.' }));
    setState('paused');
  } else {
    open();
  }
  return {
    state: () => state,
    dispose() {
      disposed = true;
      generation += 1;
      clear();
      document.removeEventListener?.('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('pagehide', pause);
      globalThis.removeEventListener?.('pageshow', onVisibility);
    },
  };
}
