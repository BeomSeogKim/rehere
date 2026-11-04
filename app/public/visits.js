// The read-only visitor screen for a saved snapshot. The same component shows
// the owner's preview before issue and the public visit afterwards; only the
// source of data differs. It never edits, never asks for sign-in and never
// links to files. Access is re-checked on a heartbeat and whenever the page
// returns to view; any doubt closes the scene.

import { copyPose, isComposition, poseProblem } from './composition-scene.js';
import { compositionDifference } from './composition-description.js';
import { createExploreToggle, createInspectToggle, createViewer, originalPhotoCamera } from './scene-viewer.js';
import { createStoryPlayer } from './story-player.js';
import { describeArrangement, objectNames, ruleText } from './arrangement.js';

export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 20_000;
export const UNAVAILABLE = 'This shared view is not available.';
const DEVICE_NOTE = 'Closing access stops this page from showing the scene. Copies already saved on a device cannot be removed from here.';

// Server-provided attribution of source-backed words, exactly
// { creator: string|null, originKind, reference: string }; absent for legacy
// words. A malformed value withholds the words rather than showing them
// without their attribution.
const ORIGIN_WORDS = { public: 'Public source', own: 'Own source', other: 'Someone else’s source', unknown: 'Source type not specified' };
const attributionOf = (words) => {
  if (!Object.hasOwn(words, 'attribution')) return { valid: true, lines: [] };
  const a = words.attribution;
  if (!a || typeof a !== 'object' || !(a.creator === null || typeof a.creator === 'string') || !Object.hasOwn(ORIGIN_WORDS, a.originKind) || typeof a.reference !== 'string') return { valid: false, lines: [] };
  return { valid: true, lines: [a.creator ? `Attributed to ${a.creator}` : 'From this place’s written source', ...(a.reference ? [a.reference] : []), `${ORIGIN_WORDS[a.originKind]}; attribution as given by the owner, not verified.`] };
};
// The view's shared words with their attribution lines, or null when there are
// none or they cannot be shown with their attribution.
const sharedWords = (view) => {
  const words = view?.memoryWords;
  if (!words || typeof words.text !== 'string') return null;
  const attribution = attributionOf(words);
  return attribution.valid ? { text: words.text, lines: attribution.lines } : null;
};
const excerptOf = (text) => {
  const compact = Array.from(text.replace(/\s+/g, ' ').trim());
  return compact.length > 80 ? `${compact.slice(0, 80).join('')}…` : compact.join('');
};

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
    recordingAudio: (recordingId, signal) => fetch(`/api/visit/recordings/${encodeURIComponent(recordingId)}/audio.wav`, init(signal)),
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
    recordingAudio: (recordingId, signal) => fetch(`${url}/recordings/${encodeURIComponent(recordingId)}/audio.wav`, init(signal)),
  };
}

function eraText(era, labelOf) {
  if (!era || era.kind === 'unknown' || (era.kind !== 'relative' && !era.start)) return 'Time unknown';
  const when = { exact: era.start, range: `${era.start} to ${era.end}`, relative: era.label }[era.kind];
  if (!when) return 'Time unknown';
  const relation = era.relation && era.relativeToViewId ? ` (${era.relation === 'same-time' ? 'same time as' : era.relation} “${labelOf(era.relativeToViewId)}”)` : '';
  return `Owner’s assertion: ${when}${relation}`;
}

// Shown beside the scene for every view, so it stays in sight while scrolling.
const SCENE_NOTE = 'Shape and depth: a model estimate from this one photo, not a measurement. Areas the photo did not show are left empty.';
const COMPOSITION_NOTE = 'Two photographed surfaces, placed by the owner. Position, orientation and relative scale are assumptions, not measurements or automatic photo alignment. Each photo’s depth remains a model estimate. Unseen areas stay empty.';
const FULL_OBJECT_NOTE = 'The room and the object are estimates from one photo, not measurements. The object’s unseen sides were not photographed and its front is not known. In the 3D view, hatching marks background hidden by the object and gaps in the room estimate; it is not a reconstructed surface.';
const FULL_OBJECT = 'source-photo-full-object-v1';
const MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_OUTLINE_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

// Every view of a full-object snapshot must name the same object; the viewer
// draws one object and views differ only by its move and turn. Each view
// addresses the bytes through its own view ID, so identity is compared on the
// hashes, sizes and initial pose. The start view's own references are used.
export function fullObjectOf(manifest) {
  const views = manifest?.views ?? [];
  if (!views.some((view) => view.representation === FULL_OBJECT)) return null;
  const valid = (asset, name, limit) => asset?.name === name && typeof asset.viewId === 'string' && Number.isInteger(asset.size) && asset.size > 0 && asset.size <= limit;
  const identity = (object) => JSON.stringify([object?.sha256, object?.outlineSha256, object?.initial, object?.asset?.size, object?.mask?.size]);
  const start = views.find((view) => view.id === manifest.startViewId)?.fullObject;
  if (!start || !SHA256.test(start.sha256 ?? '') || !SHA256.test(start.outlineSha256 ?? '')
      || views.some((view) => view.representation !== FULL_OBJECT || !valid(view.fullObject?.asset, 'object.glb', MAX_OBJECT_BYTES)
        || !valid(view.fullObject?.mask, 'outline.png', MAX_OUTLINE_BYTES) || identity(view.fullObject) !== identity(start))) throw new Error('representation');
  return start;
}

// Reads one authorized asset in full and accepts it only with the exact
// pinned length and SHA-256.
async function verifiedBytes(response, size, sha256) {
  if (!response.ok) throw new Error('asset');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== size) throw new Error('asset');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  if (digest !== sha256) throw new Error('asset');
  return bytes;
}
const CORRECTED_SCENE_NOTE = 'Outlines: include a correction the owner made on this photo. Depth: the existing model estimate, not a measurement. This does not fix depth errors or add unseen surfaces. Areas the photo did not show are left empty.';
// Two-object 3D views: one deliberate camera move to the chosen object's
// photographed side, as that object is arranged in the selected saved view.
const SIDE_CHOOSE = 'See photographed side (choose an object first)';
const SIDE_MOVED = (name, label) =>
  `Camera moved to inspect the photographed side of ${name}, as arranged in “${label}” when you pressed the button. Sides the photo did not capture stay empty. This is not the photo’s original viewpoint, and it does not show history or physical accuracy.`;
const SIDE_REFUSED = (name) => `The photographed side of ${name} is outside this scene’s camera limits, so the camera did not move.`;
const SIDE_MISSING = (name, label) => `“${label}” has no usable saved placement for ${name}, so the camera did not move.`;

// `summary` (the saved arrangement differences) follows the time assertion,
// before the photo, provider and recollection text.
// How the shown saved arrangement was recorded, from the link's own fixed
// field: the most recent saved change, never a claim about the whole
// arrangement, its full history or the past. Anything not exactly one of
// these values, including links issued before the field existed, is unknown.
const ARRANGEMENT_TEXT = Object.freeze({
  initial: 'Arrangement: the initial placement in this photo-derived reconstruction. It is an estimate, not verified history.',
  manual: 'Arrangement: its most recent saved change was a placement change the owner made by hand. This does not establish how the place was in the past.',
  relationship: "Arrangement: its most recent saved change was the owner's change to an object relationship rule. This does not establish how the place was in the past.",
  memory: "Arrangement: its most recent saved change was a placement change the owner approved from a model's proposal based on written memory. The memory's words are not included here.",
  recollection: 'Arrangement: its most recent saved change was a placement change the owner adopted from a contributed recollection. This is separate from the photo-derived shape estimate.',
  restored: 'Arrangement: its most recent saved change returned it to an earlier saved arrangement. Its full change history is not included here.',
  alternative: 'Arrangement: the owner retained a recollection-based arrangement as a comparison choice. This does not establish a different time or verified history.',
  unknown: 'How this arrangement was made is not recorded in this link.',
});
const arrangementText = (value) => (typeof value === 'string' && Object.hasOwn(ARRANGEMENT_TEXT, value) ? ARRANGEMENT_TEXT[value] : ARRANGEMENT_TEXT.unknown);

const knownObjectId = (id) => id === 'object-1' || id === 'object-2';

function objectRecollections(view, objectId, nameOf) {
  const support = (view.evidence?.support ?? []).filter((item) => item?.kind === 'human_recollection');
  const related = support.filter((item) => item.objectId === objectId);
  const nodes = [el('h4', { textContent: `Recollections used for ${nameOf(objectId)} in “${view.label}”` })];
  if (related.length) {
    for (const item of related) nodes.push(el('p', { textContent: `This saved view uses a recollection about ${nameOf(objectId)} by ${item.providerLabel || 'an unnamed person'}, selected by the owner. This does not establish history or mean it was the only basis for the layout.` }));
  } else nodes.push(el('p', { className: 'hint', textContent: 'No recollection about this object is recorded as supporting this saved view.' }));
  if (support.some((item) => !knownObjectId(item.objectId))) nodes.push(el('p', { className: 'hint', textContent: 'This view also uses a recollection whose object was not recorded. It is not assigned to this object.' }));
  return nodes;
}

function viewDetails(view, labelOf, summary = [], nameOf = objectNames(null)) {
  const nodes = [el('h3', { textContent: view.label })];
  nodes.push(el('p', { textContent: eraText(view.era, labelOf) }));
  if (view.era && view.era.kind !== 'unknown' && view.era.statement) {
    nodes.push(el('p', { className: 'hint', textContent: `Based on: ${view.era.statement}${view.era.assertedByLabel ? ` (asserted by ${view.era.assertedByLabel})` : ''}` }));
  }
  nodes.push(...summary);
  const photo = view.evidence?.photo;
  if (photo) {
    nodes.push(
      el('p', {
        className: 'hint',
        textContent: `Photo: provided by ${photo.providerLabel || 'an unnamed provider'}; ${photo.attributedCaptureDate ? `date given by them: ${photo.attributedCaptureDate}` : 'date unknown'}.`,
      }),
    );
  }
  for (const photo of view.evidence?.photos ?? []) nodes.push(el('p', { className: 'hint', textContent: `Source photo for ${photo.objectId === 'object-1' ? 'A' : 'B'}: provided by ${photo.providerLabel || 'an unnamed provider'}; ${photo.attributedCaptureDate ? `date given by them: ${photo.attributedCaptureDate}` : 'date unknown'}.` }));
  if (isComposition(view.edit)) nodes.push(el('p', { className: 'hint', textContent: 'This saved layout and relative size are owner assumptions. The two photos were not automatically registered.' }));
  nodes.push(el('p', { className: 'hint', textContent: view.evidence?.arrangement === 'memory' && sharedWords(view)
    ? "Arrangement: the owner approved a model's proposed placement change based on these shared words. This is not verified history."
    : arrangementText(view.evidence?.arrangement) }));
  for (const support of view.evidence?.support ?? []) {
    if (support?.kind === 'reviewed_story') {
      nodes.push(el('p', { className: 'hint', textContent: `Source attribution: a reviewed story by ${support.providerLabel || 'an unnamed provider'}, selected by the owner. ${support.captionDraft ? `Captions AI-drafted (${support.captionDraft.label || support.captionDraft.model || 'model not recorded'}), reviewed by` : 'Captions written by'} ${support.captionAuthorLabel || 'the owner'}. This attribution does not include the story’s words or establish historical truth.` }));
      continue;
    }
    if (support?.kind !== 'human_recollection') continue;
    nodes.push(
      el('p', {
        className: 'hint',
        textContent: isComposition(view.edit)
          ? `This saved view uses a recollection by ${support.providerLabel || 'an unnamed person'}${knownObjectId(support.objectId) ? ` about ${nameOf(support.objectId)}` : ', with no recorded object'}, selected by the owner. This is separate from the model’s shape estimate and does not identify the only basis for its current layout.`
          : `Arrangement: based on a recollection by ${support.providerLabel || 'an unnamed person'}, selected by the owner. This is separate from the model’s shape estimate.`,
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

const finite3 = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

// Saved arrangements compared with the published start view only:
// for the single foreground or each stable object id, each coordinate and turn compared
// exactly (no rounding), and the rule compared field by field. Anything that
// cannot be compared is said to be unknown, never unchanged.
const AXES = [
  ['left-right position', 'farther right', 'farther left'],
  ['height', 'higher', 'lower'],
  ['depth', 'nearer', 'farther back'],
];
const DIFFERENCE_NOTE = 'These are differences between saved arrangements. They do not establish when or whether the place changed, and do not make either view earlier or more accurate.';
const placement = (edit, id) => {
  const object = Array.isArray(edit?.objects) ? edit.objects.find((entry) => entry?.id === id) : null;
  return object && (isComposition(edit) ? !poseProblem(object) : finite3(object.offset) && Number.isFinite(object.yaw)) ? object : null;
};
const sameRule = (a, b) => {
  if (!a || !b) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
};
function arrangementDifference(view, start, views, objects, nameOf) {
  if (!objects) {
    if (views.length < 2) return [];
    if (view.id === start.id) return [el('p', { className: 'hint', textContent: `“${start.label}” is the published starting view. Other saved positions are compared with it, not with historical measurements.` })];
    const now = view.edit;
    const then = start.edit;
    let text = 'Selected object: unknown; its saved placement is not available in both views.';
    if (finite3(now?.offset) && finite3(then?.offset) && Number.isFinite(now.yaw) && Number.isFinite(then.yaw)) {
      const changes = AXES.flatMap(([, more, less], index) => now.offset[index] === then.offset[index] ? [] : [now.offset[index] > then.offset[index] ? more : less]);
      if (now.yaw !== then.yaw) changes.push('different turn');
      text = changes.length ? `Selected object: ${changes.join(', ')}.` : 'Selected object: saved position and turn unchanged.';
    }
    return [
      el('p', { className: 'space-choice-label', textContent: `Saved change compared with “${start.label}”` }),
      el('p', { textContent: text }),
      el('p', { className: 'hint', textContent: `Directions use the original photo viewpoint and relative scene coordinates. ${DIFFERENCE_NOTE}` }),
    ];
  }
  if (!Array.isArray(view.edit?.objects)) return [];
  const base = `“${start.label}”`;
  if (view.id === start.id) {
    const others = views.some((other) => other.id !== start.id && Array.isArray(other.edit?.objects));
    if (!others) return [];
    return [el('p', { className: 'hint', textContent: `${base} is the published starting view. Other views’ saved arrangements are compared with it. ${DIFFERENCE_NOTE}` })];
  }
  const lines = isComposition(view.edit) ? compositionDifference(start.edit, view.edit, nameOf).map((entry) => entry.text) : objects.map((object) => {
    const now = placement(view.edit, object.id);
    const then = placement(start.edit, object.id);
    if (!now || !then) return `${nameOf(object.id)}: unknown; its saved placement is not available in both views.`;
    const changed = [];
    const same = [];
    AXES.forEach(([name, more, less], i) => {
      if (now.offset[i] === then.offset[i]) same.push(name);
      else changed.push(now.offset[i] > then.offset[i] ? more : less);
    });
    if (now.yaw === then.yaw) same.push('turn');
    else changed.push('different turn');
    if (!changed.length) return `${nameOf(object.id)}: position and turn unchanged.`;
    return `${nameOf(object.id)}: ${changed.join(', ')}${same.length ? `; ${same.join(', ')} unchanged` : ''}.`;
  });
  const now = view.edit.relationship;
  const then = start.edit?.relationship;
  const rule =
    now === undefined || then === undefined
      ? 'Rule: unknown; it is not available in both views.'
      : sameRule(now, then)
        ? 'Rule: unchanged.'
        : `Rule: different (this view: ${ruleText(now, nameOf)}; ${base}: ${ruleText(then, nameOf)}).`;
  return [
    el('p', { textContent: `Saved arrangement compared with ${base}, the published starting view. ${isComposition(view.edit) ? 'Coordinates are in the owner composition frame, not from either source photo or your current camera' : 'Directions are as seen from the original photo, not from your current camera'}:` }),
    el('ul', { className: 'collab-list' }, [...lines, rule].map((line) => el('li', { textContent: line }))),
    el('p', { className: 'hint', textContent: DIFFERENCE_NOTE }),
  ];
}
const copyCamera = (camera) => (camera && finite3(camera.position) && finite3(camera.target) ? { position: [...camera.position], target: [...camera.target] } : null);

// source: { manifest(signal) -> view|null, check(signal) -> boolean,
// asset(viewId, name, signal) -> Response }. onState receives 'loading',
// '3d', '2d', 'paused' or 'unavailable'; '2d' means the 3D scene was not shown.
export function mountVisitor(container, source, { onState = () => {}, limitedPhotoView = false } = {}) {
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
  // A public visit only: where the person was, kept in memory while the page
  // is hidden as opaque IDs and camera numbers, nothing else. A return still
  // goes through the full fresh admission before any of it is used.
  let resume = null;
  // Reads that context from the screen on show; dropped with the screen.
  let captureContext = null;

  const setState = (next) => {
    state = next;
    onState(next);
  };

  // Releases everything this screen holds: the 3D view, object URLs, pending
  // reads and the heartbeat.
  function clear() {
    captureContext = null;
    clearTimeout(timer);
    timer = null;
    disposePlayers();
    releasePhotos();
    controller?.abort();
    controller = null;
    viewer?.dispose();
    viewer = null;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    container.replaceChildren();
  }

  function unavailable() {
    resume = null;
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

  // Contributor photos shown for the current view; their local copies are
  // released whenever the view changes or the screen closes.
  let photoUrls = [];
  let photoToken = 0;
  function releasePhotos() {
    photoToken += 1;
    for (const url of photoUrls) URL.revokeObjectURL(url);
    photoUrls = [];
  }

  async function render(manifest, surface, textureUrl, mine, fullObject = null) {
    const correctedOutline = manifest.outline?.kind === 'owner-corrected';
    const composition = isComposition(surface);
    const photoOrbit = limitedPhotoView && !composition && originalPhotoCamera(manifest.camera);
    const textureFor = (id) => composition ? textureUrl[surface.components.find((component) => component.id === id).texture] : textureUrl;
    const views = new Map(manifest.views.map((view) => [view.id, view]));
    const labelOf = (id) => views.get(id)?.label ?? 'another view';
    // Earlier context applies only to the same saved copy; each ID is used
    // only while it still exists, otherwise the published start is used.
    const visit = source.kind === 'visit' && typeof manifest.id === 'string' && manifest.id !== '';
    const restore = visit && resume?.snapshotId === manifest.id ? resume : null;
    const viewRestored = Boolean(restore) && views.has(restore.viewId);
    let currentId = viewRestored ? restore.viewId : manifest.startViewId;
    const viewport = el('div', { className: 'space-viewport' });
    const details = el('div', { className: 'visit-details' });
    const memoryWords = el('section', { className: 'memory-edit visit-memory-summary', hidden: true });
    const fullMemoryWords = el('details', { className: 'source-details visit-memory-full', hidden: true });
    const origins = el('section', { className: 'visit-evidence-strip' });
    origins.setAttribute('aria-label', 'Photo, memory and model origins');
    const selectedWords = el('section', { className: 'memory-edit visit-shared-excerpts', hidden: true });
    memoryWords.setAttribute('data-kind', 'remembered');
    fullMemoryWords.setAttribute('data-kind', 'remembered');
    const message = el('p', { className: 'hint', role: 'status' });
    const buttons = el('div', { className: 'actions space-camera' });
    const storyBox = el('div', { className: 'visit-stories' });
    // Two-object scenes: the visitor may pick one object to see its photo
    // evidence and only its stories. Picking stops any playing story.
    const objects = Array.isArray(manifest.objects) && manifest.objects.length === 2 ? manifest.objects : null;
    const nameOf = objectNames(objects);
    let objectId = restore && objects?.some((entry) => entry.id === restore.objectId) ? restore.objectId : null;
    const objectButtons = el('div', { className: 'actions', role: 'group' });
    const sideButton = el('button', { type: 'button', className: 'secondary', textContent: SIDE_CHOOSE, hidden: true, disabled: true });
    const sideStatus = el('p', { className: 'hint', role: 'status' });
    const evidence = el('div', { className: 'object-evidence' });
    const evidenceTitle = composition ? 'Photo and memory evidence' : 'Photo evidence';
    const evidenceSummary = el('summary', { textContent: `${evidenceTitle} (choose an object)` });
    const evidenceBox = el('details', { className: 'source-details' }, [evidenceSummary, evidence]);
    const credit = el('p', { className: 'hint' });
    const renderObjects = () => {
      if (!objects) return;
      for (const button of objectButtons.children) if (button.objectId !== undefined) button.setAttribute('aria-pressed', String(button.objectId === objectId));
      const object = objects.find((entry) => entry.id === objectId);
      evidenceSummary.textContent = object ? `${evidenceTitle} for ${nameOf(object.id)}` : `${evidenceTitle} (choose an object)`;
      if (!object) {
        evidence.replaceChildren();
        return;
      }
      const [width, height] = composition ? surface.components.find((component) => component.id === object.id).surface.source.image_size : surface.source?.image_size ?? [1, 1];
      const [x1, y1, x2, y2] = object.box;
      const badge = el('span', { className: 'box-badge', textContent: nameOf(object.id) });
      badge.setAttribute('data-kind', 'seen');
      badge.setAttribute('aria-label', `${nameOf(object.id)} (box around this object in the photograph)`);
      badge.setAttribute('role', 'img');
      const box = el('div', { className: `box-overlay box-overlay-${objects.indexOf(object) === 0 ? 'a' : 'b'}` }, [badge]);
      Object.assign(box.style, { left: `${(x1 / width) * 100}%`, top: `${(y1 / height) * 100}%`, width: `${((x2 - x1) / width) * 100}%`, height: `${((y2 - y1) / height) * 100}%` });
      evidence.replaceChildren(
        el('p', { className: 'hint', textContent: composition ? `Source photo for ${nameOf(object.id)}: its photographed surface and estimated depth come from this photo. Its composition pose and relative scale were chosen by the owner.` : correctedOutline
          ? `Photo evidence for ${nameOf(object.id)}: this box encloses its current outline. This scene includes an owner-made outline correction; the depth remains a model estimate. Neither establishes history.`
          : `Photo evidence for ${nameOf(object.id)}: the box the owner drew. ${typeof manifest.outlineSource === 'string' ? `The outline inside it was proposed by ${manifest.outlineSource} from the owner's object name; it is a model estimate.` : 'The outline inside it is a model estimate.'}` }),
        el('div', { className: 'anchor-frame' }, [el('img', { src: textureFor(object.id), alt: `The source photo for ${nameOf(object.id)} in “${manifest.title}”, with its box` }), box]),
        ...(composition ? objectRecollections(views.get(currentId), object.id, nameOf) : []),
      );
    };
    // Offered only with a working 3D view of two objects and a chosen object;
    // disabled while comparing so the photo framing and its return camera stay.
    const renderSide = () => {
      sideButton.hidden = !objects || !viewer || photoOrbit;
      sideButton.disabled = !objectId || comparing || !viewer;
      sideButton.textContent = objectId ? `See photographed side of ${nameOf(objectId)}` : SIDE_CHOOSE;
    };
    // Only on a deliberate press: the selected view's current transform for
    // the selected object. Moves the camera only; a refusal leaves it as it was.
    const viewSide = () => {
      if (!viewer || comparing || !objectId) return;
      const view = views.get(currentId);
      const name = nameOf(objectId);
      const placed = placement(view.edit, objectId);
      if (!placed) {
        sideStatus.textContent = SIDE_MISSING(name, view.label);
        return;
      }
      const moved = viewer.viewPhotographedSide(composition ? copyPose(placed) : { offset: [...placed.offset], yaw: placed.yaw }, objectId);
      sideStatus.textContent = moved ? SIDE_MOVED(name, view.label) : SIDE_REFUSED(name);
    };
    // While comparing with the photograph, stories stay listed but have no
    // player: nothing plays or downloads until the comparison is left.
    let comparing = false;
    const renderStories = (viewId) => {
      disposePlayers();
      const viewStories = (manifest.stories ?? []).filter((story) => story.viewId === viewId && (!objectId || story.target?.id === objectId));
      storyBox.replaceChildren(
        ...(viewStories.length ? [el('h3', { textContent: 'Recorded stories for this view' })] : []),
        ...(viewStories.length && comparing ? [el('p', { className: 'hint', textContent: 'Stories can be played after you leave the comparison with the photograph.' })] : []),
        ...viewStories.map((story) => {
          const player = comparing ? null : createStoryPlayer({ story, fetchAudio: (signal) => source.storyAudio(story.id, signal) });
          if (player) players.push(player);
          return el('div', { className: 'visit-story' }, [
            el('p', { className: 'space-choice-label', textContent: story.title }),
            ...(objects && story.target ? [el('p', { className: 'hint', textContent: `About ${nameOf(story.target.id)}` })] : []),
            el('p', {
              className: 'hint',
              textContent: `Recording by ${story.providerLabel || 'an unnamed provider'}. ${story.captionDraft ? `Captions AI-drafted (${story.captionDraft.label || 'Muse Voice Transcribe'}), reviewed by` : 'Captions written by'} ${story.captionAuthorLabel || 'the owner'}; they are not checked by Rehere. Nothing plays until you press Play.`,
            }),
            ...(player ? [player.element] : []),
          ]);
        }),
        ...renderRecordings(viewId),
      );
    };
    // Contributor recordings the owner linked to this view: about the whole
    // place (kept under any object choice) or one object. Each is a person's
    // own recording with captions they wrote, shown as such.
    const contributorRecordings = Array.isArray(manifest.contributorRecordings) ? manifest.contributorRecordings : [];
    const renderRecordings = (viewId) => {
      const linked = contributorRecordings.filter(
        (recording) => Array.isArray(recording.viewIds) && recording.viewIds.includes(viewId) && (!objectId || recording.target?.id === 'place' || recording.target?.id === objectId),
      );
      if (!linked.length) return [];
      return [
        el('h3', { textContent: 'Contributor recordings for this view' }),
        ...(comparing ? [el('p', { className: 'hint', textContent: 'Recordings can be played after you leave the comparison with the photograph.' })] : []),
        ...linked.map((recording) => {
          const player = comparing
            ? null
            : createStoryPlayer({
                story: { title: recording.title, cues: recording.cues ?? [], durationMs: recording.durationMs, audio: recording.audio },
                fetchAudio: (signal) => source.recordingAudio(recording.id, signal),
              });
          if (player) players.push(player);
          return el('div', { className: 'visit-story' }, [
            el('p', { className: 'space-choice-label', textContent: recording.title }),
            el('p', { className: 'hint', textContent: `${recording.target?.label ?? 'About this place'} · ${recording.label}` }),
            el('p', {
              className: 'hint',
              textContent: `Recording by ${recording.providerLabel || 'a contributor'}. Listening captions, version ${recording.captionVersion ?? 1}${(recording.captionVersion ?? 1) >= 2 ? ', corrected by the contributor' : ''}; written by ${recording.captionAuthorLabel || recording.providerLabel || 'the contributor'}; not a transcript. Nothing plays until you press Play.`,
            }),
            ...(player ? [player.element] : []),
          ]);
        }),
      ];
    };
    // Only photos related to the current view, collapsed until asked for and
    // fetched only then. Each is a contributor's photo, shown as such.
    const contributorPhotos = Array.isArray(manifest.contributorPhotos) ? manifest.contributorPhotos : [];
    const photoBox = el('div');
    const renderContributorPhotos = (viewId) => {
      releasePhotos();
      const related = contributorPhotos.filter((photo) => Array.isArray(photo.viewIds) && photo.viewIds.includes(viewId));
      if (!related.length) {
        photoBox.replaceChildren();
        return;
      }
      const items = related.map((photo) => ({ photo, slot: el('div') }));
      const section = el('details', { className: 'source-details' }, [
        el('summary', { textContent: `Contributor photos (${related.length})` }),
        ...items.map(({ photo, slot }) =>
          el('figure', { className: 'anchor-figure' }, [slot, el('figcaption', { className: 'hint', textContent: `${photo.providerLabel || 'A contributor'}: ${photo.label}` })]),
        ),
      ]);
      let loaded = false;
      section.addEventListener('toggle', async () => {
        if (!section.open || loaded) return;
        loaded = true;
        const token = photoToken;
        for (const { photo, slot } of items) {
          let url = null;
          try {
            const response = await source.asset(photo.asset.viewId, photo.asset.name, controller?.signal);
            if (response?.ok) url = URL.createObjectURL(await response.blob());
          } catch {
            url = null;
          }
          if (mine !== generation || token !== photoToken) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          if (url) photoUrls.push(url);
          slot.replaceChildren(
            url
              ? el('img', { className: 'space-proposal', src: url, alt: `Photo supplied by ${photo.providerLabel || 'a contributor'}`, width: photo.width, height: photo.height })
              : el('p', { className: 'hint', textContent: 'This photo could not be loaded.' }),
          );
        }
      });
      photoBox.replaceChildren(section);
    };
    const showView = (id) => {
      currentId = id;
      sideStatus.textContent = '';
      const view = views.get(id);
      const shared = sharedWords(view);
      const photos = view.evidence?.photos ?? (view.evidence?.photo ? [view.evidence.photo] : []);
      const originLine = (kind, text) => {
        const node = el('p', { textContent: text });
        node.setAttribute('data-kind', kind);
        return node;
      };
      origins.replaceChildren(
        ...photos.map((photo) => originLine('seen', `Photo${photo.objectId ? ` (${nameOf(photo.objectId)})` : ''}: provided by ${photo.providerLabel || 'an unnamed provider'}.`)),
        ...(!photos.length ? [originLine('seen', 'Photo attribution is not recorded for this view.')] : []),
        originLine('remembered', manifest.synthetic ? 'Memory: synthetic demonstration; any shared words or voices are not witness accounts.' : 'Memory: any shared words or voices are attributed accounts, not verified history.'),
        originLine('guessed', `Model: ${fullObject ? 'shape, depth and unseen object sides are estimates' : composition ? 'shape and depth are estimates; layout and scale are owner assumptions' : 'shape and depth are estimates; unseen surfaces stay empty'}.${view.evidence?.arrangement === 'memory' ? ' This saved view includes an owner-approved model proposal.' : ''}`),
      );
      const quotes = view.evidence?.recollections ?? [];
      selectedWords.hidden = quotes.length === 0;
      selectedWords.replaceChildren(...(quotes.length ? [
        el('h4', { textContent: manifest.synthetic ? 'Synthetic words shared alongside this view' : 'Words shared alongside this view' }),
        ...quotes.flatMap((quote) => [
          el('p', { className: 'hint', textContent: `Shared by ${quote.providerLabel || 'an unnamed contributor'}` }),
          el('p', { className: 'memory-text', textContent: `Excerpt: “${excerptOf(quote.text)}”` }),
        ]),
        el('p', { className: 'hint', textContent: 'These selected words are shared alongside this view. Their presence does not establish which change they informed. Full words and recorded support are below.' }),
      ] : []));
      memoryWords.hidden = !shared;
      fullMemoryWords.hidden = memoryWords.hidden;
      fullMemoryWords.open = false;
      const words = shared?.text ?? '';
      const excerpt = excerptOf(words);
      memoryWords.replaceChildren(...(memoryWords.hidden ? [] : [
        el('h3', { textContent: 'Words shared about this change' }),
        el('p', { textContent: `Excerpt: “${excerpt}”` }),
        ...shared.lines.map((line) => el('p', { className: 'hint', textContent: line })),
        el('p', { className: 'hint', textContent: 'The owner approved a model-proposed placement change based on these words. They are not verified history.' }),
      ]));
      fullMemoryWords.replaceChildren(...(fullMemoryWords.hidden ? [] : [
        el('summary', { textContent: 'Read all shared words' }),
        el('p', { textContent: words }),
      ]));
      if (view.edit?.objects) viewer?.applyArrangement(view.edit);
      else viewer?.applyEdit(view.edit);
      details.replaceChildren(...viewDetails(view, labelOf, arrangementDifference(view, views.get(manifest.startViewId), manifest.views, objects, nameOf), nameOf));
      const provider = view.evidence?.photo?.providerLabel;
      credit.textContent = composition ? (view.evidence?.photos ?? []).map((photo) => `${nameOf(photo.objectId)}: photo provided by ${photo.providerLabel || 'an unnamed provider'}`).join('; ') : provider ? `Photo provided by ${provider}` : '';
      if (objects && view.edit?.objects) {
        details.append(
          el('p', { textContent: `Rule: ${ruleText(view.edit.relationship, nameOf)}.${view.edit.relationship ? composition ? ' It constrains the owner-assumed layout, not historic truth or solid collision.' : ' It compares where the two centres appear from the original photo; it does not measure distance.' : ''}` }),
          el('p', { className: 'hint', textContent: `Arrangement in this view: ${describeArrangement(view.edit, nameOf)}.` }),
        );
      }
      if (composition) renderObjects();
      renderStories(id);
      renderContributorPhotos(id);
      for (const button of buttons.children) button.setAttribute('aria-pressed', String(button.viewId === id));
    };
    for (const view of manifest.views) {
      const button = el('button', { type: 'button', className: 'secondary', textContent: view.label, viewId: view.id, onclick: () => showView(view.id) });
      buttons.append(button);
    }
    const back = el('button', { type: 'button', className: 'secondary', textContent: 'Back to the starting view' });
    const explore = createExploreToggle();
    // Exploring is driven by the inspection while it lasts.
    const inspect = createInspectToggle({ onChange: () => explore.attach(viewer?.isInspecting?.() ? null : viewer) });
    // Comparison with the photograph: the same photo pixels this scene was
    // built from (the texture already loaded for it) and the selected saved
    // arrangement, both from the photograph's own viewpoint and fitted to the
    // photo's shape. Nothing is generated, blended or animated.
    const compareButton = el('button', { type: 'button', className: 'secondary', textContent: 'Compare with the photograph', hidden: true });
    const showPhoto = el('button', { type: 'button', className: 'secondary', textContent: 'Photo' });
    const showScene = el('button', { type: 'button', className: 'secondary', textContent: 'This reconstruction' });
    const leaveCompare = el('button', { type: 'button', className: 'secondary', textContent: 'Leave the comparison' });
    // Optional, full objects only: the photo copy with the estimated object
    // drawn over it from the photo's viewpoint.
    const showContext = el('button', { type: 'button', className: 'secondary', textContent: 'Photo with the estimated object', hidden: !fullObject });
    const contextNote = el('p', { className: 'hint', hidden: true, textContent: 'The photo copy used for this scene, with the estimated object drawn from the photo’s viewpoint in this view’s saved arrangement. Hatching marks what the object hid in the photo: unknown, approximate edge. Approximate projection: where the room estimate has gaps, what hides the object is uncertain and the object is drawn in front.' });
    let wantContext = false;
    const compareStatus = el('p', { className: 'hint', role: 'status' });
    const compareBar = el('div', { className: 'visit-compare', hidden: true }, [
      el('div', { className: 'actions' }, [showPhoto, showContext, showScene, leaveCompare]),
      el('p', {
        className: 'hint',
        textContent:
          'Photo is the copy used for this scene. Both views use the photo’s viewpoint. Switching saved arrangements changes only the reconstruction; it does not establish when the place changed.',
      }),
      compareStatus,
      contextNote,
    ]);
    const photoImage = el('img', { className: 'visit-compare-photo', alt: `The photograph used for “${manifest.title}”`, hidden: true });
    const unseenLabel = el('span', { className: 'viewport-unseen-label', textContent: fullObject ? 'Unseen background remains unknown' : 'Unseen surfaces stay empty' });
    unseenLabel.setAttribute('data-kind', 'unseen');
    const stageFrame = el('div', { className: 'visit-compare-frame space-viewport-wrap' }, [viewport, photoImage, unseenLabel]);
    let saved = null;
    let photoLoad = 0;
    let photoReady = false;
    let photoTimer = null;
    // Drops a Photo load still in progress: its late completion is ignored,
    // and the next Photo choice starts a fresh load.
    const cancelPhotoLoad = () => {
      if (photoReady) return;
      photoLoad += 1;
      clearTimeout(photoTimer);
      photoTimer = null;
      photoImage.onload = null;
      photoImage.onerror = null;
      photoImage.removeAttribute('src');
      if (compareStatus.textContent === 'Loading the photograph…') compareStatus.textContent = '';
    };
    const PHOTO_LOAD_MS = 10_000;
    const setPressed = (photo, context = false) => {
      if (!context) viewer?.setPhotoContext?.(false);
      showPhoto.setAttribute('aria-pressed', String(photo && !context));
      showContext.setAttribute('aria-pressed', String(context));
      showScene.setAttribute('aria-pressed', String(!photo));
      photoImage.hidden = !photo;
      contextNote.hidden = !context;
      unseenLabel.hidden = photo && !context;
      stageFrame.classList?.toggle('is-photo', photo && !context);
      stageFrame.classList?.toggle('is-context', context);
    };
    // The object is drawn over the photo only with its unknown hatch in place;
    // otherwise the reconstruction stays as it was.
    const showChosen = () => {
      if (!wantContext) return setPressed(true);
      if (viewer?.setPhotoContext?.(true) === true) return setPressed(true, true);
      compareStatus.textContent = 'The photo with the estimated object could not be shown here. The reconstruction stays as it was.';
      setPressed(false);
    };
    // Photo is shown only after the image has actually loaded; a load that
    // finishes after leaving, closing or a newer load is ignored.
    const choosePhoto = (context = false) => {
      if (!comparing || !viewer) return;
      wantContext = context;
      if (photoReady) {
        showChosen();
        return;
      }
      const load = ++photoLoad;
      compareStatus.textContent = 'Loading the photograph…';
      const settled = (ok) => {
        if (load !== photoLoad || mine !== generation || !comparing) return;
        photoLoad += 1;
        clearTimeout(photoTimer);
        photoTimer = null;
        if (ok) {
          photoReady = true;
          compareStatus.textContent = '';
          showChosen();
        } else {
          photoImage.removeAttribute('src');
          compareStatus.textContent = 'The photograph could not be shown here. The reconstruction stays as it was.';
          setPressed(false);
        }
      };
      photoImage.onload = () => settled(true);
      photoImage.onerror = () => settled(false);
      clearTimeout(photoTimer);
      photoTimer = setTimeout(() => settled(false), PHOTO_LOAD_MS);
      photoImage.src = textureUrl;
    };
    const enterCompare = () => {
      if (composition || comparing || !viewer) return;
      saved = { camera: viewer.getCamera(), interactive: viewer.isInteractive() };
      comparing = true;
      viewer.setInteractive(false);
      explore.attach(null);
      inspect.attach(null);
      back.disabled = true;
      viewer.setPhotoFraming(true);
      viewer.originalView();
      compareButton.hidden = true;
      compareBar.hidden = false;
      compareStatus.textContent = '';
      setPressed(false);
      sideStatus.textContent = '';
      renderSide();
      // Stopping comparison never brings audio back on its own.
      renderStories(currentId);
    };
    const exitCompare = () => {
      if (!comparing) return;
      comparing = false;
      cancelPhotoLoad();
      photoLoad += 1;
      photoReady = false;
      photoImage.onload = null;
      photoImage.onerror = null;
      photoImage.removeAttribute('src');
      setPressed(false);
      photoImage.hidden = true;
      compareBar.hidden = true;
      compareButton.hidden = false;
      viewer?.setPhotoFraming(false);
      viewer?.setCamera(saved.camera);
      if (saved.interactive) viewer?.setInteractive(true);
      explore.attach(viewer);
      inspect.attach(viewer);
      back.disabled = false;
      saved = null;
      renderSide();
      renderStories(currentId);
    };
    compareButton.addEventListener('click', enterCompare);
    showPhoto.addEventListener('click', () => choosePhoto(false));
    showContext.addEventListener('click', () => choosePhoto(true));
    showScene.addEventListener('click', () => {
      if (!comparing) return;
      // Choosing the reconstruction wins over a photo still loading.
      cancelPhotoLoad();
      setPressed(false);
    });
    leaveCompare.addEventListener('click', exitCompare);
    if (objects) {
      const pickObject = (id) => {
        objectId = id;
        sideStatus.textContent = '';
        renderSide();
        renderObjects();
        renderStories(currentId);
      };
      objectButtons.append(
        el('span', { textContent: 'Objects: ' }),
        el('button', { type: 'button', className: 'secondary', textContent: 'All objects', objectId: null, onclick: () => pickObject(null) }),
        ...objects.map((object) => el('button', { type: 'button', className: 'secondary', textContent: nameOf(object.id), objectId: object.id, onclick: () => pickObject(object.id) })),
      );
      renderObjects();
    }
    // The screen's context, copied as plain IDs and numbers; while comparing
    // with the photograph, the camera from before the comparison.
    const live = () => ({
      snapshotId: manifest.id,
      viewId: currentId,
      objectId: typeof objectId === 'string' ? objectId : null,
      camera: copyCamera(comparing ? saved?.camera : viewer?.getCamera?.()),
    });
    // The screen is live: earlier context is used up, and this one is read on hide.
    const goLive = () => {
      resume = null;
      if (visit) captureContext = live;
    };
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
      // The stage keeps the scene and its notes in sight; the inspector beside
      // it (below it on small or short screens) scrolls with the page.
      el('div', { className: 'scene-workspace' }, [
        el('div', { className: 'scene-stage' }, [
          el('p', { className: 'hint', textContent: manifest.synthetic ? 'Synthetic test material, shared by the owner.' : 'Shared by the owner.' }),
          el('div', { className: 'actions space-camera' }, [explore.button, inspect.button, back, compareButton]),
          explore.status,
          ...(photoOrbit ? [el('p', { className: 'hint', textContent: 'Limited-view demo: rotation stays within 10 degrees of the photo viewing direction. Unseen areas remain unknown; this does not validate the reconstructed geometry.' })] : []),
          inspect.note,
          compareBar,
          stageFrame,
          message,
          credit,
          el('p', { className: 'hint', textContent: composition ? `${COMPOSITION_NOTE} ${surface.context ? 'Only the first source photo’s observed background is kept, fixed at its initial placement.' : 'Only two observed surfaces are shown; no background is included.'}` : fullObject ? FULL_OBJECT_NOTE : correctedOutline ? CORRECTED_SCENE_NOTE : SCENE_NOTE }),
        ]),
        el('div', { className: 'scene-inspector' }, [
          buttons,
          origins,
          memoryWords,
          fullMemoryWords,
          selectedWords,
          ...(objects ? [objectButtons, sideButton, sideStatus, evidenceBox] : []),
          details,
          photoBox,
          storyBox,
          el('p', { className: 'hint', textContent: DEVICE_NOTE }),
        ]),
      ]),
    );

    let created = null;
    try {
      created = await createViewer(viewport, surface, textureUrl, `3D view: ${manifest.title}`, { fullObject, limitedPhotoView: photoOrbit });
    } catch (error) {
      if (mine !== generation) return;
      if (error?.message !== 'webgl') {
        unavailable();
        return;
      }
      // The derived photo and the text, clearly not presented as the 3D scene.
      viewport.replaceChildren(...(composition ? surface.components.map((component) => el('img', { className: 'space-proposal', src: textureFor(component.id), alt: `Source photo for ${nameOf(component.id)}` })) : [el('img', { className: 'space-proposal', src: textureUrl, alt: `The photo used for “${manifest.title}”` })]));
      unseenLabel.hidden = true;
      message.textContent = composition ? 'The 3D view is not available. Showing the two source photos separately, not a combined scene. Saved pose and relative-scale differences are described in the text.' : 'The 3D view is not available in this browser. Showing the photo used for the scene instead; the arrangement between views is described in the text.';
      back.hidden = true;
      showView(currentId);
      goLive();
      setState('2d');
      scheduleHeartbeat(mine);
      return;
    }
    if (mine !== generation) {
      created.dispose();
      return;
    }
    viewer = created;
    viewer.setContextListener?.(() => {
      if (!comparing) return;
      compareStatus.textContent = 'The photo with the estimated object could not be shown here. The reconstruction stays as it was.';
      setPressed(false);
    });
    explore.attach(viewer);
    inspect.attach(viewer);
    // A camera returns only with its own restored view.
    viewer.setCamera(viewRestored && copyCamera(restore.camera) ? copyCamera(restore.camera) : manifest.camera);
    back.addEventListener('click', () => {
      sideStatus.textContent = '';
      viewer?.setCamera(manifest.camera);
    });
    sideButton.addEventListener('click', viewSide);
    // Offered only with a working 3D view; the 2D fallback has none.
    compareButton.hidden = composition;
    renderSide();
    message.textContent = 'Switching views keeps the same camera so they can be compared.';
    showView(currentId);
    goLive();
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
      const surfaceResponse = await timed((signal) => source.asset(start.id, 'surface.json', signal), LOAD_TIMEOUT_MS, outer);
      if (mine !== generation) return;
      if (!surfaceResponse.ok) throw new Error('asset');
      const surface = await surfaceResponse.json();
      if (mine !== generation) return;
      const composition = isComposition(manifest);
      if (composition !== isComposition(surface)) throw new Error('representation');
      const pinned = fullObjectOf(manifest);
      if (pinned && composition) throw new Error('representation');
      const names = composition ? ['texture-1.jpg', 'texture-2.jpg'] : ['texture.jpg'];
      const responses = await Promise.all(names.map((name) => timed((signal) => source.asset(start.id, name, signal), LOAD_TIMEOUT_MS, outer)));
      if (mine !== generation) return;
      if (responses.some((response) => !response.ok)) throw new Error('asset');
      const textures = await Promise.all(responses.map((response) => response.blob()));
      if (mine !== generation) return;
      // The object and its outline arrive as authorized bytes and are checked
      // here, then again by the viewer; no token ever enters a URL.
      let objectParts = null;
      if (pinned) {
        const [glbResponse, maskResponse] = await Promise.all([
          timed((signal) => source.asset(pinned.asset.viewId, 'object.glb', signal), LOAD_TIMEOUT_MS, outer),
          timed((signal) => source.asset(pinned.mask.viewId, 'outline.png', signal), LOAD_TIMEOUT_MS, outer),
        ]);
        if (mine !== generation) return;
        objectParts = await Promise.all([
          verifiedBytes(glbResponse, pinned.asset.size, pinned.sha256),
          verifiedBytes(maskResponse, pinned.mask.size, pinned.outlineSha256),
        ]);
        if (mine !== generation) return;
      }
      const stillAllowed = await timed((signal) => source.check(signal), HEARTBEAT_TIMEOUT_MS, outer);
      if (mine !== generation) return;
      if (!stillAllowed) throw new Error('revoked');
      const loaded = textures.map((texture) => URL.createObjectURL(texture));
      urls.push(...loaded);
      const textureInput = composition ? Object.fromEntries(names.map((name, index) => [name, loaded[index]])) : loaded[0];
      let fullObject = null;
      if (objectParts) {
        const assetUrl = URL.createObjectURL(new Blob([objectParts[0]], { type: 'model/gltf-binary' }));
        urls.push(assetUrl);
        const maskUrl = URL.createObjectURL(new Blob([objectParts[1]], { type: 'image/png' }));
        urls.push(maskUrl);
        fullObject = { sha256: pinned.sha256, outlineSha256: pinned.outlineSha256, initial: pinned.initial, assetUrl, maskUrl };
      }
      await render(manifest, surface, textureInput, mine, fullObject);
    } catch {
      if (mine === generation) unavailable();
    }
  }

  // Hidden pages stop at once; coming back starts again with fresh checks.
  function pause() {
    if (disposed || state === 'unavailable' || state === 'paused') return;
    // Only a live screen updates the context; a hide while opening keeps the
    // latest one, and clear() then drops the screen and its reader.
    if (captureContext) resume = captureContext();
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
      resume = null;
      generation += 1;
      clear();
      document.removeEventListener?.('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('pagehide', pause);
      globalThis.removeEventListener?.('pageshow', onVisibility);
    },
  };
}
