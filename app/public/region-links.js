// The owner's links from one confirmed scene object to a box in other photos
// of the same memory. A link is the owner's own judgment that a region shows
// this object: Rehere does not recognise objects, compare photos, align them,
// infer dates or change the scene. Nothing here calls a model, a build, a
// share or a story route, and nothing is kept in browser storage.
import { boxFromPoints, boxProblem } from './photo-scene.js';

const MEANING =
  'Each link is your own judgment that a box in another photo shows this object. Rehere does not automatically recognise objects or match regions between photos, and a link does not align the photos, set a date or change the scene. Regions are boxes, not outlines.';
const REASONS = {
  source: 'Its photo is no longer allowed to be used for reconstructing this place, or its use was stopped. The link is kept but not shown.',
  checksum: 'Its photo no longer matches its recorded checksum, so the region is not shown.',
  unreadable: 'Its photo could not be read, so the region is not shown.',
};
const CHOICE_REASONS = {
  details: 'saved before source details existed, so it cannot be linked',
  stopped: 'its use was stopped',
  place: 'its use to reconstruct this place is not allowed',
};
const UNREADABLE = 'Linked regions could not be read right now. This does not mean there are none.';

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

async function request(url, options = {}) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

const reasonOf = (result) => (typeof result.body?.error === 'string' ? result.body.error.trim() : '');
const unclear = (result) => result.status === 0 || result.status >= 500;
const isBox = (box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite);
const isSize = (size) => Array.isArray(size) && size.length === 2 && size.every((value) => Number.isInteger(value) && value > 0);
const sameBox = (a, b) => isBox(a) && isBox(b) && a.every((value, i) => value === b[i]);
const sameSize = (a, b) => isSize(a) && isSize(b) && a[0] === b[0] && a[1] === b[1];

// A link projection is used only when every link has a consistent shape:
// available links carry a box and size, unavailable ones neither.
function validProjection(body, objectId) {
  if (body?.objectId !== objectId || !Number.isInteger(body.revision) || !Array.isArray(body.links)) return false;
  return body.links.every((link) =>
    typeof link?.sourceId === 'string' && link.available === true
      ? isBox(link.box) && isSize(link.imageSize) && link.reason === null
      : link?.available === false && link.box === null && link.imageSize === null && Object.hasOwn(REASONS, link.reason),
  );
}

// Where a box in stored pixels sits over its photo, in percent.
const placement = ([x1, y1, x2, y2], [width, height]) => ({ left: `${(x1 / width) * 100}%`, top: `${(y1 / height) * 100}%`, width: `${((x2 - x1) / width) * 100}%`, height: `${((y2 - y1) / height) * 100}%` });
function boxOverlay(box, size, label, letter) {
  const overlay = el('div', { className: `box-overlay box-overlay-${letter}` }, [el('span', { className: 'box-badge', textContent: label })]);
  Object.assign(overlay.style, placement(box, size));
  return overlay;
}

// options: { draftId, jobUrl, objectId, name, letter, photos, sourceFor,
// scenePhoto: { sourceId, box, size, url, number } }. photos: the memory's
// photos in order ({ name, sourceId }); sourceFor(sourceId) -> source record.
export function mountRegionLinks(container, { draftId, jobUrl, objectId, name, letter, photos, sourceFor, scenePhoto }) {
  let alive = true;
  // Only the most recently started read may replace what is shown.
  let readSeq = 0;
  let data = null;
  let readError = null;
  let message = '';
  // The open add/change form, or null. A new object replaces it entirely, so
  // a late callback for an older form changes nothing.
  let editor = null;
  // The link awaiting its second removal confirmation, and a removal whose
  // answer is not known yet.
  let removing = null;
  let removeAttempt = null;
  let busy = false;
  const url = `${jobUrl}/objects/${encodeURIComponent(objectId)}/region-links`;
  const assetUrl = (photo) => `/api/drafts/${draftId}/assets/${encodeURIComponent(photo.name)}`;
  const numbered = photos.map((photo, index) => ({ ...photo, number: index + 1 }));
  const photoOf = (sourceId) => numbered.find((photo) => photo.sourceId === sourceId) ?? null;
  const photoText = (sourceId) => {
    const photo = photoOf(sourceId);
    const provider = sourceFor(sourceId)?.provider?.trim();
    return `${photo ? `Photo ${photo.number}` : 'A photo no longer listed'}${provider ? `, provided by ${provider}` : ''}`;
  };
  // Why a photo cannot be offered, judged from the source settings the page
  // already shows; the reference check on the server stays authoritative.
  const choiceProblem = (sourceId) => {
    const record = sourceFor(sourceId);
    if (!record || record.kind !== 'photo') return CHOICE_REASONS.details;
    if (record.policy?.stopped === true || record.stopped === true) return CHOICE_REASONS.stopped;
    if (record.permissions?.place !== true) return CHOICE_REASONS.place;
    return null;
  };
  const candidates = numbered.filter((photo) => photo.sourceId !== scenePhoto.sourceId);
  // The scene's own box beside a box in another photo, so the two regions are
  // judged together; on a narrow inspector the grid stacks them.
  const sceneImage = () => el('img', { src: scenePhoto.url, alt: `Photo ${scenePhoto.number} with the box for ${name}` });
  const pair = (referenceFrame, referenceCaption, baseImage = sceneImage()) =>
    el('div', { className: 'photo-grid region-pair' }, [
      el('figure', { className: 'anchor-figure' }, [
        el('div', { className: 'anchor-frame' }, [baseImage, boxOverlay(scenePhoto.box, scenePhoto.size, name, letter)]),
        el('figcaption', { className: 'hint', textContent: `Photo ${scenePhoto.number}: the scene’s own box` }),
      ]),
      el('figure', { className: 'anchor-figure' }, [referenceFrame, el('figcaption', { className: 'hint', textContent: referenceCaption })]),
    ]);

  const root = el('div', { className: 'region-links' });
  container.replaceChildren(root);

  function render() {
    if (!alive) return;
    const nodes = [el('h4', { textContent: `Regions you linked in other photos for ${name}` }), el('p', { className: 'hint', textContent: MEANING })];
    if (readError) {
      const retry = el('button', { type: 'button', className: 'secondary', textContent: 'Read the links again', onclick: () => load() });
      nodes.push(el('p', { className: 'hint', role: 'status', textContent: readError }), el('div', { className: 'actions' }, [retry]));
    } else if (!data) {
      nodes.push(el('p', { className: 'hint', role: 'status', textContent: 'Reading linked regions…' }));
    } else {
      nodes.push(data.links.length ? el('ul', { className: 'collab-list' }, data.links.map(renderLink)) : el('p', { className: 'hint', textContent: `No region in another photo is linked to ${name}.` }));
      if (!editor) {
        const add = el('button', { type: 'button', className: 'secondary', textContent: 'Link a region in another photo', disabled: busy || candidates.length === 0, onclick: () => openEditor(null) });
        nodes.push(el('div', { className: 'actions' }, [add]));
        if (candidates.length === 0) nodes.push(el('p', { className: 'hint', textContent: 'This memory has no other photo to link.' }));
      }
    }
    if (editor) nodes.push(renderEditor());
    if (message) nodes.push(el('p', { className: 'form-message', role: 'alert', textContent: message }));
    root.replaceChildren(...nodes);
    syncEditor();
  }

  function renderLink(link) {
    const item = el('li');
    const caption = `${photoText(link.sourceId)}: linked by you${Number.isFinite(Date.parse(link.linkedAt)) ? ` on ${new Date(link.linkedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.`;
    if (link.available) {
      const photo = photoOf(link.sourceId);
      item.append(
        el('p', { className: 'hint', textContent: `${caption} You said this box shows ${name}.` }),
        ...(photo
          ? [pair(el('div', { className: 'anchor-frame region-photo' }, [el('img', { src: assetUrl(photo), alt: `${photoText(link.sourceId)} with the box you linked to ${name}` }), boxOverlay(link.box, link.imageSize, name, letter)]), `${photoText(link.sourceId)}: your linked box`)]
          : []),
      );
    } else {
      // The pixels of an unavailable reference are never requested.
      item.append(el('p', { className: 'hint', textContent: `${caption} ${REASONS[link.reason]}` }));
    }
    const actions = el('div', { className: 'actions' });
    if (removing === link.sourceId) {
      actions.append(
        el('p', { className: 'hint', textContent: 'Remove this link? The photo and the scene stay as they are.' }),
        el('button', { type: 'button', className: 'secondary', textContent: 'Keep the link', disabled: busy, onclick: keepLink }),
        el('button', { type: 'button', textContent: 'Remove this link', disabled: busy, onclick: () => remove(link.sourceId) }),
      );
    } else if (!editor) {
      if (link.available) actions.append(el('button', { type: 'button', className: 'secondary', textContent: 'Change region', disabled: busy, onclick: () => openEditor(link.sourceId) }));
      actions.append(el('button', { type: 'button', className: 'secondary', textContent: 'Remove link', disabled: busy, onclick: () => ((removing = link.sourceId), (message = ''), render()) }));
    }
    item.append(actions);
    return item;
  }

  function keepLink() {
    const uncertain = Boolean(removeAttempt);
    removing = null;
    removeAttempt = null;
    if (uncertain) reconcile();
    else render();
  }

  // --------------------------------------------------------------- editor

  function openEditor(sourceId) {
    editor = { sourceId: null, size: null, admitting: false, loaded: false, failed: false, box: null, confirmed: false, attempt: null, note: '', frame: null, inputs: null };
    removing = null;
    message = '';
    if (sourceId) choosePhoto(sourceId);
    else render();
  }

  // Closing after a change whose answer never arrived: it may have been
  // saved, so the links are read again before any list is shown.
  function closeEditor() {
    const uncertain = Boolean(editor?.attempt);
    editor = null;
    if (uncertain) reconcile();
    else render();
  }

  function reconcile() {
    data = null;
    readError = null;
    message = 'Rehere could not confirm the earlier change, so the links are read again before they are shown.';
    render();
    load();
  }

  // Admits the chosen photo for a region before any of its pixels are drawn.
  async function choosePhoto(sourceId) {
    const mine = { sourceId, size: null, admitting: true, loaded: false, failed: false, box: null, confirmed: false, attempt: null, note: '', frame: null, inputs: null };
    editor = mine;
    render();
    const problem = choiceProblem(sourceId);
    if (problem) {
      Object.assign(mine, { admitting: false, note: `Photo ${photoOf(sourceId)?.number ?? ''} cannot be linked: ${problem}. Nothing was saved.` });
      render();
      return;
    }
    const result = await request(`${jobUrl}/region-reference/${encodeURIComponent(sourceId)}`);
    if (!alive || editor !== mine) return;
    mine.admitting = false;
    const { width, height } = result.body ?? {};
    if (!result.ok || !isSize([width, height])) {
      mine.note = `${reasonOf(result) || 'This photo could not be prepared for a link.'} No region can be drawn on it, and nothing was saved.`;
      render();
      return;
    }
    mine.size = [width, height];
    const existing = data?.links.find((link) => link.sourceId === sourceId && link.available && sameSize(link.imageSize, mine.size));
    if (existing) mine.box = [...existing.box];
    render();
  }

  function setBox(next, fromInputs = false) {
    const current = editor;
    current.box = next;
    // A different box is a different judgment: it must be confirmed again.
    current.confirmed = false;
    current.attempt = null;
    if (!fromInputs) next.forEach((value, i) => (current.inputs[i].value = String(value)));
    syncEditor();
  }

  // Updates the drawn box and Save without rebuilding the form, so drawing and
  // typing keep their elements.
  function syncEditor() {
    const current = editor;
    if (!current?.frame) return;
    const valid = Boolean(current.box) && boxProblem(current.box, ...current.size) === null;
    const shown = current.loaded && current.baseLoaded && !current.failed && !current.baseFailed;
    current.overlay.hidden = !valid || !current.loaded;
    if (!current.overlay.hidden) Object.assign(current.overlay.style, placement(current.box, current.size));
    current.leave.disabled = busy;
    // While a save is out, the box cannot change: what is shown stays what
    // was sent, and an unclear answer repeats exactly that.
    for (const input of current.inputs) input.disabled = busy || current.failed;
    current.confirm.checked = current.confirmed;
    current.confirm.disabled = !valid || !shown || busy;
    current.save.disabled = !valid || !shown || !current.confirmed || busy;
    current.problem.textContent = current.box && !valid ? boxProblem(current.box, ...current.size) : '';
  }

  function renderEditor() {
    const current = editor;
    const nodes = [el('h4', { textContent: `Link a region to ${name}` })];
    const select = el('select', { disabled: busy || current.admitting });
    select.setAttribute('aria-label', 'Photo to link');
    select.append(
      el('option', { value: '', textContent: 'Choose a photo' }),
      ...candidates.map((photo) => {
        const problem = choiceProblem(photo.sourceId);
        return el('option', { value: photo.sourceId, disabled: Boolean(problem), textContent: `${photoText(photo.sourceId)}${problem ? ` (${problem})` : ''}` });
      }),
    );
    select.value = current.sourceId ?? '';
    select.addEventListener('change', () => {
      if (select.value) choosePhoto(select.value);
    });
    nodes.push(select);
    if (current.admitting) nodes.push(el('p', { className: 'hint', role: 'status', textContent: 'Checking that this photo can be linked…' }));
    if (current.note) nodes.push(el('p', { className: 'hint', textContent: current.note }));
    if (!current.size) {
      nodes.push(el('div', { className: 'actions' }, [el('button', { type: 'button', className: 'secondary', textContent: 'Not sure — leave unlinked', disabled: busy, onclick: closeEditor })]));
      return el('div', { className: 'region-editor' }, nodes);
    }
    // Built once per admitted photo and kept across renders, so the image
    // that finished loading is the one on screen.
    current.drawing ??= buildDrawing(current);
    nodes.push(...current.drawing);
    return el('div', { className: 'region-editor' }, nodes);
  }

  function buildDrawing(current) {
    const photo = photoOf(current.sourceId);
    // Drawn as stored, without camera rotation, so the box is in the stored
    // pixels the server checked.
    const image = el('img', { src: assetUrl(photo), alt: `${photoText(current.sourceId)}. Drag on it to draw a box around ${name}.`, draggable: false });
    current.overlay = el('div', { className: `box-overlay box-overlay-${letter}`, hidden: true });
    const frame = el('div', { className: 'box-select region-photo' }, [image, current.overlay]);
    current.frame = frame;
    current.inputs = [0, 1, 2, 3].map((i) => el('input', { type: 'number', step: 1, min: 0, max: current.size[i % 2], inputMode: 'numeric', value: current.box ? String(current.box[i]) : '' }));
    current.confirm = el('input', { type: 'checkbox', checked: current.confirmed });
    current.save = el('button', { type: 'button', textContent: 'Save link', onclick: () => save() });
    current.leave = el('button', { type: 'button', className: 'secondary', textContent: 'Not sure — leave unlinked', onclick: closeEditor });
    current.problem = el('p', { className: 'hint' });
    image.addEventListener('load', () => {
      if (!alive || editor !== current) return;
      current.loaded = true;
      syncEditor();
    });
    image.addEventListener('error', () => {
      if (!alive || editor !== current) return;
      current.failed = true;
      current.confirmed = false;
      current.note = 'The photo could not be shown, so no region can be saved. Nothing was saved.';
      render();
    });
    // The scene's own photo must be visible too: the two boxes are judged together.
    const baseImage = sceneImage();
    baseImage.addEventListener('load', () => {
      if (!alive || editor !== current) return;
      current.baseLoaded = true;
      syncEditor();
    });
    baseImage.addEventListener('error', () => {
      if (!alive || editor !== current) return;
      current.baseFailed = true;
      current.confirmed = false;
      current.note = 'The scene’s own photo could not be shown, so the two boxes cannot be compared and no region can be saved. Nothing was saved.';
      render();
    });
    const toImage = (event) => {
      const rect = image.getBoundingClientRect();
      return [((event.clientX - rect.left) * current.size[0]) / rect.width, ((event.clientY - rect.top) * current.size[1]) / rect.height];
    };
    let start = null;
    frame.addEventListener('pointerdown', (event) => {
      if (!current.loaded || current.failed || busy || event.button !== 0) return;
      event.preventDefault?.();
      frame.setPointerCapture?.(event.pointerId);
      start = toImage(event);
    });
    frame.addEventListener('pointermove', (event) => {
      if (start && editor === current) setBox(boxFromPoints(start, toImage(event), ...current.size));
    });
    const finish = () => (start = null);
    frame.addEventListener('pointerup', finish);
    frame.addEventListener('pointercancel', finish);
    for (const input of current.inputs) {
      input.addEventListener('input', () => {
        if (editor !== current || busy) return;
        setBox(current.inputs.map((field) => (field.value.trim() === '' ? NaN : Number(field.value))), true);
      });
    }
    current.confirm.addEventListener('change', () => {
      if (editor !== current) return;
      current.confirmed = current.confirm.checked === true;
      syncEditor();
    });
    return [
      el('p', {
        className: 'hint',
        textContent: `Compare with the box you drew for ${name} in photo ${scenePhoto.number}. Drag a box around the same object, or type its edges in pixels. The photo is shown as stored, without camera rotation.`,
      }),
      pair(frame, `${photoText(current.sourceId)}: your box`, baseImage),
      el('fieldset', { className: 'box-fields' }, [el('legend', { textContent: 'Box in photo pixels' }), ...['Left', 'Top', 'Right', 'Bottom'].map((label, i) => el('label', {}, [`${label} `, current.inputs[i]]))]),
      current.problem,
      el('label', { className: 'memory-consent' }, [current.confirm, ' These show the same object']),
      el('div', { className: 'actions' }, [current.leave, current.save]),
    ];
  }

  // ----------------------------------------------------------- mutations

  // Shared handling of a set or remove answer. intended: the request body.
  async function settle(result, intended, keep) {
    const reason = reasonOf(result);
    if (result.ok && validProjection(result.body, objectId)) {
      data = result.body;
      readError = null;
      const now = data.links.find((link) => link.sourceId === intended.sourceId);
      if (intended.action === 'set') {
        message =
          now?.available && sameBox(now.box, intended.box)
            ? result.body.changed === false && result.body.replayed !== true
              ? 'This region was already linked, so nothing changed.'
              : 'Link saved.'
            : 'That link was recorded earlier and has changed since. The current links are shown.';
      } else {
        message = now ? 'That removal was recorded earlier, and the photo has been linked again since. The current links are shown.' : 'Link removed. The photo and the scene are unchanged.';
      }
      return 'done';
    }
    // Only the server's own readable error is a definite answer; any other
    // failure (a proxy page, a cut-off body) may have followed a saved change.
    if (!reason || result.ok || unclear(result)) {
      message = `${reason ? `${reason} ` : ''}Rehere could not confirm this. Pressing it again repeats the same request.`;
      return 'unknown';
    }
    if (result.status === 409) {
      message = `${reason} The current links are shown${keep ? '; your box is still here. Save again to replace them' : ''}.`;
      await load();
      return 'conflict';
    }
    message = `${reason} Nothing was changed.`;
    return 'refused';
  }

  async function save() {
    const current = editor;
    if (!current || busy || !data || !current.confirmed || !current.loaded || !current.baseLoaded || current.failed || current.baseFailed || !current.box || boxProblem(current.box, ...current.size) !== null) return;
    current.attempt ??= { requestId: crypto.randomUUID(), baseRevision: data.revision, action: 'set', sourceId: current.sourceId, box: [...current.box], confirmed: true };
    const body = current.attempt;
    busy = true;
    message = 'Saving the link…';
    render();
    const result = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!alive || editor !== current) return;
    busy = false;
    const outcome = await settle(result, body, true);
    if (!alive || editor !== current) return;
    if (outcome === 'done') editor = null;
    else if (outcome !== 'unknown') current.attempt = null;
    render();
  }

  async function remove(sourceId) {
    if (busy || !data) return;
    if (removeAttempt?.sourceId !== sourceId) removeAttempt = { requestId: crypto.randomUUID(), baseRevision: data.revision, action: 'remove', sourceId, box: null, confirmed: true };
    const body = removeAttempt;
    busy = true;
    message = 'Removing the link…';
    render();
    const result = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!alive || removeAttempt !== body) return;
    busy = false;
    const outcome = await settle(result, body, false);
    if (!alive || removeAttempt !== body) return;
    if (outcome !== 'unknown') {
      removeAttempt = null;
      removing = null;
    }
    render();
  }

  // --------------------------------------------------------------- reads

  async function load() {
    const seq = ++readSeq;
    const result = await request(url);
    if (!alive || seq !== readSeq) return;
    if (result.ok && validProjection(result.body, objectId)) {
      data = result.body;
      readError = null;
    } else {
      // A failed read never shows as an empty list.
      data = null;
      readError = result.status === 503 || unclear(result) ? UNREADABLE : `${reasonOf(result) || UNREADABLE} Nothing was changed.`;
    }
    render();
  }

  render();
  load();
  return {
    dispose() {
      alive = false;
      readSeq += 1;
      editor = null;
      container.replaceChildren();
    },
  };
}
