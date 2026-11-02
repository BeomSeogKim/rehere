import {
  ACTIVE_STATUSES,
  OFFSET_LIMIT,
  boxFromPoints,
  boxProblem,
  buildBlockedReason,
  createEditSession,
  editProblem,
  jobStatusText,
} from './photo-scene.js';
import { mountBlockedScene, mountCollaboration, mountInvitations } from './collaboration.js';
import { mountMemoryEdit } from './memory-edit.js';
import { createExploreToggle, createViewer } from './scene-viewer.js';
import { createArrangementSession, describeArrangement, objectNames, objectState, ruleText as ruleWords, withObject } from './arrangement.js';
import { stopAll } from './playback.js';
import { mountShares } from './shares.js';
import { mountStories } from './stories.js';
import { mountRegionLinks } from './region-links.js';
import { mountMemoryLink } from './memory-link.js';
import { mountOutlineEditor } from './outline-editor.js';
import { COMPOSITION_NOTE, mountCompositionEditor, poseAxes, poseValues, poseWithAxis } from './composition-editor.js';
import { copyPose, faceObjectPose, isComposition, poseProblem } from './composition-scene.js';

const POLL_MS = 2000;
const SOURCE_BLOCKED_TEXT = 'Its photo is no longer allowed to be used for reconstructing this place, or its use was stopped. Every saved version depends on that photo, so none can be restored. The original photo is kept, not deleted.';
const sourceBlocked = (job) => job.blockedReason === 'source';
const UNCONFIRMED_BUILD = 'Rehere could not confirm whether the build was accepted. Pressing Build again safely repeats the same request.';
export const SURFACE_SCOPE = 'Before an arrangement is saved, Rehere checks that the two objects’ surfaces seen in the photo do not overlap. Only those photographed surfaces are checked, not unseen backs, the background or the room, so a clear check does not mean the arrangement is physically possible.';
export const SURFACE_PENDING = 'Rehere is still preparing the check of the two photographed surfaces. Nothing was changed. Try again in a moment.';
export const SURFACE_FAILED = 'Rehere could not prepare the check of the two photographed surfaces, so no arrangement can be saved here. Nothing was changed. Reload the page to try again.';

// The shared photographed-surface check for one loaded two-object surface.
// The geometry is prepared once after its modules load; each distinct arrangement
// is checked once, only when an action would save it, never per slider input.
// Until preparation succeeds every check holds. A preparation that finishes
// after its scene closed is dropped and calls nothing. The server checks
// again and remains authoritative.
function visibleSurfaceGate(surface, current, onReady) {
  let state = 'loading';
  let prepared = null;
  let visible = null;
  let lastKey = null;
  let lastText = null;
  (async () => {
    try {
      const [THREE, bvh, helper] = await Promise.all([import('/vendor/three.module.js'), import('/vendor/three-mesh-bvh.js'), import('./visible-surfaces.js')]);
      if (!current()) return;
      // Synchronous: nothing else runs between building and keeping it.
      prepared = helper.prepareVisibleGeometry(THREE, bvh.MeshBVH, surface);
      [visible, state] = [helper, 'ready'];
    } catch {
      if (!current()) return;
      state = 'failed';
    }
    onReady();
  })();
  return {
    // Null only for a clear check; otherwise the fixed text to show.
    problem(arrangement) {
      if (state === 'loading') return SURFACE_PENDING;
      if (state === 'failed') return SURFACE_FAILED;
      const key = JSON.stringify(arrangement.objects);
      if (key !== lastKey) {
        let result;
        try {
          result = visible.checkVisibleArrangement(prepared, arrangement);
        } catch {
          result = { status: 'unresolved', reason: 'error', scope: 'named-visible-surfaces' };
        }
        // Anything but an explicit clear holds.
        lastText = result?.status === 'clear' ? null : visible.visibleSurfaceProblem(result?.status === 'intersects' ? result : { ...result, status: 'unresolved' });
        lastKey = key;
      }
      return lastText;
    },
  };
}
// A ready scene: the 3D stage and its always-visible notes on one side, the
// tools that act on it on the other (one column on small or short screens).
// The same nodes are placed once, before the viewer starts.
function sceneWorkspace(stage, inspector) {
  return el('div', { className: 'scene-workspace' }, [el('div', { className: 'scene-stage' }, stage), el('div', { className: 'scene-inspector' }, inspector)]);
}

// One explicit camera action per scene: look at an object's photographed
// side as it is drawn at the moment of the press. Nothing moves the camera
// there on its own, and nothing about the scene changes.
const SIDE_MOVED = (name) => `Camera moved to inspect the photographed side of ${name}, as it was drawn when you pressed the button. Sides the photo did not capture stay empty.`;
const SIDE_OUTSIDE = 'That photographed side is outside the scene’s camera limits, so the camera did not move.';
function photographedSideControls() {
  // Disabled until a scene enables it for a drawn object.
  return { button: el('button', { type: 'button', className: 'secondary', textContent: 'See photographed side', disabled: true }), status: el('p', { className: 'hint', role: 'status' }) };
}

const SCENE_NOTE = 'A partial scene from one photo. Only surfaces visible in the photo exist: dark gaps, hidden areas and the backs of objects are unknown and left empty. Depth is a relative model estimate, not a measurement.';

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

async function request(url, options) {
  try {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

const postJson = (url, payload) =>
  request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

const serverError = (result, fallback) => (typeof result.body?.error === 'string' ? result.body.error : fallback);

// Mounts partial-scene building and viewing for one saved memory. Every request
// is bound to this draft; dispose() stops polling and releases the 3D view so
// nothing from this memory updates the screen after navigation.
// sceneId opens that exact saved scene once, never another one. onScene(id)
// reports the scene whose panel is shown after an open, and null after an
// explicit build choice; dispose never calls it.
export function mountSpace(container, { draft, sourceFor, durationHintMs = () => null, sceneId = null, onScene = () => {} }) {
  let disposed = false;
  let pollTimer = null;
  let pollingJob = null;
  // Accepted builds waiting while another build is polled. Each is polled by
  // its exact ID once polling is free, so none is dropped without a result.
  const waiting = new Set();
  // The ready build the background notice currently describes, until a list
  // read confirms it; any newer notice retires it.
  let notice = null;
  let handoff = null;
  let jobsGeneration = 0;
  let viewer = null;
  let outlineEditor = null;
  let compositionEditor = null;
  let memoryEdit = null;
  let collaborationPanel = null;
  let sharesPanel = null;
  let storiesPanel = null;
  let blockedPanel = null;
  let currentPlace = draft.place;
  let placeHeading = null;
  // The selected object's links to regions in other photos, inside its photo
  // evidence; replaced on every object choice.
  let regionLinksPanel = null;
  // The selected object's link to the saved written memory, beside it.
  let memoryLinkPanel = null;
  // Bumped whenever the panel is closed or replaced; a response for an older
  // selection or scene must not change the panel that replaced it.
  let panelGeneration = 0;
  const base = `/api/drafts/${draft.id}/reconstructions`;
  const assetUrl = (jobId, name) => `${base}/${jobId}/assets/${encodeURIComponent(name)}`;
  const photoAsset = (photo) => `/api/drafts/${draft.id}/assets/${encodeURIComponent(photo.name)}`;
  // A short saved-scene reference that tells apart builds of one photo made in the same minute.
  const sceneRef = (jobId) => `Scene ${jobId.slice(0, 8)}`;
  const photoNumber = (sourceId) => draft.photos.findIndex((photo) => photo.sourceId === sourceId) + 1;
  function showPlaceHeading() {
    if (!placeHeading) return;
    const place = currentPlace;
    placeHeading.textContent = place?.unavailable === false && typeof place.name === 'string' && place.name.trim() && Number.isInteger(place.revision) && place.revision >= 0
      ? place.name : 'A place to revisit';
  }

  const status = el('p', { className: 'hint', role: 'status' });
  status.setAttribute('aria-live', 'polite');
  const readyAction = el('div', { className: 'actions space-ready' });
  // Builds the creator is not following are announced here, apart from the
  // status above, so they never replace guidance such as an unresolved save.
  const backgroundStatus = el('p', { className: 'hint space-background', role: 'status' });
  backgroundStatus.setAttribute('aria-live', 'polite');
  const buildList = el('ul', { className: 'space-builds' });
  const panel = el('div', { className: 'space-panel' });

  const choices = el('ul', { className: 'space-choices' });
  const invitationsSection = el('div');
  for (const [index, photo] of draft.photos.entries()) {
    const reason = buildBlockedReason(sourceFor(photo.sourceId));
    const item = el('li', {}, [el('span', { className: 'space-choice-label', textContent: `Photo ${index + 1}` })]);
    if (reason) item.append(el('p', { className: 'hint', textContent: reason }));
    else {
      const button = el('button', { type: 'button', className: 'secondary', textContent: 'Build a partial scene' });
      button.setAttribute('aria-label', `Build a partial scene from photo ${index + 1}`);
      button.addEventListener('click', () => openSelection(photo, index));
      const two = el('button', { type: 'button', className: 'secondary', textContent: 'Build with two objects' });
      two.setAttribute('aria-label', `Build a partial scene with two objects from photo ${index + 1}`);
      two.addEventListener('click', () => openTwoSelection(photo, index));
      item.append(button, two);
    }
    choices.append(item);
  }

  const compose = el('button', { type: 'button', className: 'secondary', textContent: 'Compose objects from two photos' });
  compose.addEventListener('click', () => {
    closePanel();
    onScene(null);
    compositionEditor = mountCompositionEditor(panel, {
      base, sourceFor, request, post: postJson, createGate: visibleSurfaceGate, createViewer, createExploreToggle,
      onSaved: (job, { late = false } = {}) => {
        if (disposed) return;
        loadJobs({ resumePolling: false });
        if (!late) openScene(job.id);
      },
      onCancel: ({ unknown }) => {
        if (unknown) status.textContent = 'The composition save outcome is unknown. Check the refreshed saved scene list before starting another composition.';
        loadJobs({ resumePolling: false });
        closePanel();
      },
    });
  });

  // Building or choosing another scene is secondary to the selected scene.
  const others = el('details', { className: 'space-others', open: sceneId === null }, [
    el('summary', { textContent: 'Build or choose another scene' }),
    choices,
    compose,
    buildList,
  ]);
  container.replaceChildren(
    el('h2', { textContent: 'Partial scenes' }),
    el('p', {
      className: 'hint',
      textContent:
        'A partial scene turns one photo into the surfaces visible in it, so you can look around them. You choose an object in front; a local model proposes its outline and the depth. It does not add what the photo did not show, and it does not confirm what the place was like.',
    }),
    panel,
    status,
    readyAction,
    backgroundStatus,
    others,
    invitationsSection,
  );
  const invitations = mountInvitations(invitationsSection, { draftId: draft.id });

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollingJob = null;
  }

  function closePanel() {
    panelGeneration += 1;
    placeHeading = null;
    if (handoff) status.textContent = '';
    handoff = null;
    readyAction.replaceChildren();
    compositionEditor?.dispose();
    compositionEditor = null;
    outlineEditor?.dispose();
    outlineEditor = null;
    memoryEdit?.dispose();
    memoryEdit = null;
    collaborationPanel?.dispose();
    collaborationPanel = null;
    sharesPanel?.dispose();
    sharesPanel = null;
    storiesPanel?.dispose();
    storiesPanel = null;
    blockedPanel?.dispose();
    blockedPanel = null;
    regionLinksPanel?.dispose();
    regionLinksPanel = null;
    memoryLinkPanel?.dispose();
    memoryLinkPanel = null;
    viewer?.dispose();
    viewer = null;
    panel.replaceChildren();
  }

  const following = (jobId) => handoff?.id === jobId && handoff.generation === panelGeneration;

  function showBuild(job) {
    if (!following(job.id)) return;
    const number = photoNumber(job.sourceId);
    const photo = number ? `Photo ${number}` : 'This photo';
    readyAction.replaceChildren();
    if (job.status === 'ready' && job.usageBlocked === false) {
      status.textContent = job.objectsConfirmed === false
        ? `${photo}: Your partial scene is ready. Open it to check the two proposed outlines first.`
        : `${photo}: Your partial scene is ready to review.`;
      const open = el('button', { type: 'button', textContent: 'Open scene' });
      open.setAttribute('aria-label', `Open the ready scene from ${number ? `photo ${number}` : 'this photo'}`);
      open.addEventListener('click', () => {
        if (!disposed && handoff?.id === job.id && handoff.generation === panelGeneration) openScene(job.id);
      });
      readyAction.append(open);
    } else if (job.status === 'ready') {
      status.textContent = job.usageBlocked === true
        ? `${photo}: This scene cannot be shown under its current source or recollection uses.`
        : `${photo}: The scene's current access could not be confirmed. Reload to check.`;
    } else status.textContent = `${photo}: ${jobStatusText(job)}`;
  }

  const finishedText = (job, where) => {
    const number = photoNumber(job.sourceId);
    return `${number ? `Photo ${number}` : 'This photo'}: ${job.status === 'ready' ? `A partial scene finished building. ${where}` : jobStatusText(job)}`;
  };

  // Announces a known outcome at once, in text only: no action, focus,
  // navigation or panel change, and never after waiting for a list read.
  function announceBackground(job) {
    notice = job.status === 'ready' ? { job, checked: false } : null;
    backgroundStatus.textContent = finishedText(job, 'Checking the saved scene list…');
  }

  // A list read refines only the current notice. A ready build is said to be
  // listed only when the list shows that exact job as ready. `jobs` is null
  // when the read failed.
  function refineNotice(jobs) {
    if (!notice) return;
    const { job } = notice;
    if (jobs?.some((entry) => entry.id === job.id && entry.status === 'ready')) {
      notice = null;
      backgroundStatus.textContent = finishedText(job, 'It is listed under “Build or choose another scene”.');
    } else if (!notice.checked) {
      notice.checked = true;
      backgroundStatus.textContent = finishedText(job, jobs
        ? 'The saved scene list does not show it yet; reload the page to check.'
        : 'The saved scene list could not be loaded; reload the page to see it.');
    }
  }

  // Observes an accepted build by its exact ID before any list read, which may
  // never settle. It is followed only from the panel that started it and takes
  // polling over only then; otherwise it waits for polling to be free.
  function followBuild(job, { follow = true } = {}) {
    if (follow) {
      handoff = { id: job.id, generation: panelGeneration };
      showBuild(job);
    }
    const active = ACTIVE_STATUSES.has(job.status);
    if (active && (follow || pollingJob === null)) poll(job.id);
    else if (active) waiting.add(job.id);
    else if (!follow) announceBackground(job);
    loadJobs({ resumePolling: false, quiet: !follow });
  }

  function nextActions(memory, collaboration, shares) {
    const go = (target, disclosure = false) => {
      const details = disclosure ? target.children[0] : null;
      if (details) details.open = true;
      // Focus lands on the section's heading so its name is announced.
      const destination = details?.children[0] ?? target.querySelector?.('h4') ?? target;
      if (!details) destination.setAttribute('tabindex', '-1');
      destination.focus();
      destination.scrollIntoView?.({ block: 'start' });
    };
    const label = el('p', { textContent: 'Continue with this place' });
    label.setAttribute('aria-hidden', 'true');
    const nav = el('nav', { className: 'memory-edit' }, [
      label,
      el('div', { className: 'actions' }, [
        el('button', { type: 'button', className: 'secondary', textContent: 'Change from a memory', onclick: () => go(memory) }),
        el('button', { type: 'button', className: 'secondary', textContent: 'Review recollections', onclick: () => go(collaboration) }),
        el('button', { type: 'button', className: 'secondary', textContent: 'Invite someone', onclick: () => go(invitationsSection, true) }),
        el('button', { type: 'button', className: 'secondary', textContent: 'Visitor sharing', onclick: () => go(shares, true) }),
      ]),
    ]);
    nav.setAttribute('aria-label', 'Continue with this place');
    return nav;
  }

  function renderJobs(jobs) {
    buildList.replaceChildren(
      ...jobs.map((job) => {
        const number = photoNumber(job.sourceId);
        const subject = isComposition(job) ? 'Two-photo composition' : number ? `Photo ${number}` : 'A photo no longer shown';
        const when = new Date(job.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        const item = el('li', {}, [
          el('span', { className: 'space-choice-label', textContent: `${subject} · ${when} · ${sceneRef(job.id)}` }),
          el('span', { className: 'hint', textContent: jobStatusText(job) }),
        ]);
        if (job.status === 'ready' && job.usageBlocked) {
          item.append(el('span', { className: 'hint', textContent: 'Not shown: it depends on a withdrawn recollection or a use that is no longer allowed.' }));
        }
        if (job.status === 'ready') {
          const open = el('button', { type: 'button', className: 'secondary', textContent: 'Open scene' });
          open.setAttribute('aria-label', `Open the partial scene from ${number ? `photo ${number}` : 'a photo no longer shown'} built ${when}, ${sceneRef(job.id)}`);
          open.addEventListener('click', () => openScene(job.id));
          item.append(open);
        }
        return item;
      }),
    );
  }

  // A quiet refresh leaves the creator's status line alone.
  async function loadJobs({ resumePolling = true, quiet = false } = {}) {
    const generation = ++jobsGeneration;
    const panelAtStart = panelGeneration;
    const result = await request(base);
    if (disposed || generation !== jobsGeneration) return;
    if (!result.ok || !Array.isArray(result.body)) {
      if (!quiet && panelAtStart === panelGeneration) {
        status.textContent = 'Saved partial scenes could not be loaded. Reload the page to try again.';
        readyAction.replaceChildren();
      }
      refineNotice(null);
      return;
    }
    renderJobs(result.body);
    refineNotice(result.body);
    const active = result.body.find((job) => ACTIVE_STATUSES.has(job.status));
    if (resumePolling && active && pollingJob !== active.id) {
      if (!handoff && sceneId === null && panelAtStart === 0 && panelGeneration === panelAtStart) {
        handoff = { id: active.id, generation: panelGeneration };
      }
      poll(active.id);
    }
  }

  function pollNext() {
    const [next] = waiting;
    if (next !== undefined && pollingJob === null && !disposed) poll(next);
  }

  // Polls one job at a time; a newer poll or navigation drops older responses,
  // and a build it replaces waits for its turn.
  function poll(jobId) {
    if (pollingJob !== null && pollingJob !== jobId) waiting.add(pollingJob);
    waiting.delete(jobId);
    stopPolling();
    pollingJob = jobId;
    const tick = async () => {
      const result = await request(`${base}/${jobId}`);
      if (disposed || pollingJob !== jobId) return;
      if (result.ok && result.body) {
        if (result.body.id !== jobId) {
          if (following(jobId)) {
            status.textContent = 'This build could not be confirmed. Reload the page to check.';
            readyAction.replaceChildren();
          }
          stopPolling();
          pollNext();
          return;
        }
        showBuild(result.body);
        if (!ACTIVE_STATUSES.has(result.body.status)) {
          stopPolling();
          pollNext();
          const followed = following(jobId);
          if (!followed) announceBackground(result.body);
          // Not awaited, and polling is not restarted from a list that may lag this response.
          loadJobs({ resumePolling: false, quiet: !followed });
          return;
        }
      } else if (result.status === 404) {
        stopPolling();
        if (following(jobId)) {
          status.textContent = 'This build could not be found.';
          readyAction.replaceChildren();
        }
        pollNext();
        return;
      } else {
        if (following(jobId)) status.textContent = 'Checking the build again…';
      }
      pollTimer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  function openSelection(photo, index) {
    closePanel();
    onScene(null);
    const token = panelGeneration;
    const sourceId = photo.sourceId;
    let box = null;
    let requestId = null;
    // Stored-pixel size from the server's header read. The browser's
    // naturalWidth/Height follow EXIF rotation even with image-orientation:
    // none, so they cannot be the box basis.
    let size = null;
    let imageShown = false;
    const ready = () => Boolean(size) && imageShown;

    const image = el('img', { src: photoAsset(photo), alt: `Photo ${index + 1}. Drag on it to draw a box around one object.`, draggable: false });
    const overlay = el('div', { className: 'box-overlay', hidden: true });
    const frame = el('div', { className: 'box-select' }, [image, overlay]);
    const inputs = [0, 1, 2, 3].map(() => el('input', { type: 'number', step: 1, min: 0, inputMode: 'numeric' }));
    const fields = el('fieldset', { className: 'box-fields' }, [
      el('legend', { textContent: 'Box in photo pixels' }),
      ...['Left', 'Top', 'Right', 'Bottom'].map((name, i) => el('label', {}, [`${name} `, inputs[i]])),
    ]);
    const message = el('p', { className: 'form-message', role: 'alert' });
    const build = el('button', { type: 'button', textContent: 'Build partial scene', disabled: true });
    const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Cancel' });

    const showBox = () => {
      overlay.hidden = !box || !ready() || boxProblem(box, ...size) !== null;
      if (!overlay.hidden) {
        const [x1, y1, x2, y2] = box;
        overlay.style.left = `${(x1 / size[0]) * 100}%`;
        overlay.style.top = `${(y1 / size[1]) * 100}%`;
        overlay.style.width = `${((x2 - x1) / size[0]) * 100}%`;
        overlay.style.height = `${((y2 - y1) / size[1]) * 100}%`;
      }
      build.disabled = !ready() || boxProblem(box, ...size) !== null;
    };
    const setBox = (next, fromInputs = false) => {
      box = next;
      requestId = null;
      if (!fromInputs) box.forEach((value, i) => (inputs[i].value = String(value)));
      if (ready()) message.textContent = '';
      showBox();
    };

    image.addEventListener('load', () => {
      imageShown = true;
      showBox();
    });
    image.addEventListener('error', () => {
      message.textContent = 'The photo could not be shown, so a box cannot be chosen. Nothing was sent to the model.';
    });
    const reading = 'Reading the photo size…';
    message.textContent = reading;
    request(`/api/drafts/${draft.id}/sources/${sourceId}/image-size`).then((result) => {
      if (disposed || token !== panelGeneration) return;
      const { width, height } = result.body ?? {};
      if (!result.ok || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        message.textContent = `${serverError(result, 'The photo size could not be read.')} A box cannot be chosen, and nothing was sent to the model.`;
        fields.disabled = true;
        return;
      }
      size = [width, height];
      inputs.forEach((input, i) => (input.max = String(size[i % 2])));
      if (message.textContent === reading) message.textContent = '';
      showBox();
    });
    // The image is drawn in stored-pixel orientation (image-orientation: none),
    // so its on-screen rectangle maps linearly onto the stored size.
    const toImage = (event) => {
      const rect = image.getBoundingClientRect();
      return [((event.clientX - rect.left) * size[0]) / rect.width, ((event.clientY - rect.top) * size[1]) / rect.height];
    };
    let start = null;
    frame.addEventListener('pointerdown', (event) => {
      if (!ready() || event.button !== 0) return;
      event.preventDefault();
      frame.setPointerCapture(event.pointerId);
      start = toImage(event);
    });
    frame.addEventListener('pointermove', (event) => {
      if (start) setBox(boxFromPoints(start, toImage(event), ...size));
    });
    const finish = () => (start = null);
    frame.addEventListener('pointerup', finish);
    frame.addEventListener('pointercancel', finish);
    for (const input of inputs) {
      input.addEventListener('input', () => {
        setBox(inputs.map((field) => (field.value.trim() === '' ? NaN : Number(field.value))), true);
      });
    }

    build.addEventListener('click', async () => {
      if (!ready()) return;
      const problem = boxProblem(box, ...size);
      if (problem) {
        message.textContent = problem;
        return;
      }
      // Reused only when the previous attempt's outcome is unknown.
      requestId ??= crypto.randomUUID();
      build.disabled = true;
      message.textContent = 'Sending the build request…';
      const result = await postJson(base, { requestId, sourceId, box });
      if (disposed) return;
      const accepted = result.ok && Boolean(result.body?.id);
      if (token !== panelGeneration) {
        // The person moved on; the accepted build is observed in the background.
        if (accepted) followBuild(result.body, { follow: false });
        return;
      }
      build.disabled = false;
      if (result.status === 0 || result.status >= 500 || (result.ok && !accepted)) {
        message.textContent = UNCONFIRMED_BUILD;
        return;
      }
      requestId = null;
      if (!result.ok) {
        message.textContent = serverError(result, 'The build could not be started.');
        return;
      }
      closePanel();
      followBuild(result.body);
    });
    cancel.addEventListener('click', closePanel);

    panel.replaceChildren(
      el('h3', { textContent: `Choose an object in photo ${index + 1}` }),
      el('p', {
        className: 'hint',
        textContent:
          'Drag a box around one object near the front, or type its edges in pixels. The model proposes the object’s outline inside your box; you can check that outline after the build. The photo is shown as stored, without camera rotation, so the box matches the pixels the model reads.',
      }),
      frame,
      fields,
      message,
      el('div', { className: 'actions' }, [cancel, build]),
    );
    image.focus?.();
  }

  // Who provided the photo, shown beside the scene when it is recorded.
  const photoCredit = (job) => {
    const provider = sourceFor(job.sourceId)?.provider?.trim();
    return provider ? [el('p', { className: 'hint', textContent: `Photo provided by ${provider}` })] : [];
  };

  async function openScene(jobId) {
    closePanel();
    const token = panelGeneration;
    const heading = el('h3', { textContent: 'Opening the scene…', tabIndex: -1 });
    panel.replaceChildren(heading);
    heading.focus();
    // Brings the admitted scene, or its truthful status, to the top of the
    // viewport. Called only right after the current-selection check.
    const land = () => heading.scrollIntoView?.({ block: 'start' });
    const jobResult = await request(`${base}/${jobId}`);
    if (disposed || token !== panelGeneration) return;
    // The address names the scene shown here, whatever its state.
    onScene(jobId);
    const job = jobResult.body;
    if (!jobResult.ok || job?.status !== 'ready') {
      // A truthful status, and the other scenes and builds to choose from.
      others.open = true;
      if (jobResult.status === 404) heading.textContent = 'This scene could not be found.';
      else if (jobResult.ok && job?.status) {
        heading.textContent = 'This scene is not ready to open.';
        panel.append(el('p', { className: 'hint', textContent: jobStatusText(job) }));
      } else heading.textContent = 'This scene could not be opened.';
      land();
      return;
    }
    const number = photoNumber(job.sourceId);
    // A scene whose current version depends on a withdrawn recollection is not
    // loaded at all; only restoring an unaffected saved version is offered.
    // Every version depends on the photo, so a stopped or no-longer-allowed photo
    // leaves nothing to restore.
    if (job.usageBlocked) others.open = true;
    if (job.usageBlocked && sourceBlocked(job)) {
      heading.textContent = `This scene is no longer shown · ${sceneRef(jobId)}`;
      panel.append(el('p', { textContent: isComposition(job) ? 'One of this composition’s two source photos is no longer allowed to reconstruct the place, or its use was stopped. Every saved version depends on both sources, so the whole scene is unavailable and none can be restored. Originals are kept.' : SOURCE_BLOCKED_TEXT }));
      land();
      return;
    }
    if (job.usageBlocked) {
      heading.textContent = `Partial scene from photo ${number} is blocked · ${sceneRef(jobId)}`;
      const holder = el('div');
      panel.append(holder);
      const names = Array.isArray(job.edit?.objects) ? objectNames(job.objects) : null;
      blockedPanel = mountBlockedScene(holder, {
        jobUrl: `${base}/${jobId}`,
        currentVersion: job.edit.version,
        onRestored: () => openScene(jobId),
        ...(names ? { describe: (entry) => describeArrangement(entry, names), ruleText: (rule) => ruleWords(rule, names), currentRule: job.edit.relationship ?? null } : {}),
      });
      land();
      return;
    }
    const surfaceResult = await request(assetUrl(jobId, 'surface.json'));
    if (disposed || token !== panelGeneration) return;
    if (!surfaceResult.ok) {
      others.open = true;
      heading.textContent = 'This scene could not be opened.';
      land();
      return;
    }
    others.open = false;
    heading.textContent = isComposition(job) ? `Two-photo composition · ${sceneRef(jobId)}` : `Partial scene from photo ${number} · ${sceneRef(jobId)}`;
    land();
    if ([2, 3].includes(surfaceResult.body?.schema_version)) {
      await openObjectScene({ job, jobId, surface: surfaceResult.body, token, heading, number });
      return;
    }
    placeHeading = heading;
    showPlaceHeading();

    const viewport = el('div', { className: 'space-viewport' });
    const viewMessage = el('p', { className: 'form-message', role: 'alert' });
    const original = el('button', { type: 'button', className: 'secondary', textContent: 'Original viewpoint' });
    const photoSide = photographedSideControls();
    const side = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect from the side' });
    const explore = createExploreToggle();
    const [x1, y1, x2, y2] = job.box;
    const proposals = el('details', { className: 'source-details' }, [
      el('summary', { textContent: 'Model proposals: outline and depth' }),
      el('p', { className: 'hint', textContent: `Your box: ${x1}, ${y1} to ${x2}, ${y2} pixels. The outline and depth below are model proposals, not confirmed observations.` }),
      el('img', { className: 'space-proposal', src: assetUrl(jobId, 'mask-overlay.jpg'), alt: `Photo ${number} with the proposed outline of the selected object tinted blue` }),
      el('img', { className: 'space-proposal', src: assetUrl(jobId, 'depth-preview.png'), alt: `Relative depth estimate for photo ${number} as a greyscale image` }),
    ]);

    const session = createEditSession(job.edit, () => crypto.randomUUID());
    const axes = [
      ['Left / right', OFFSET_LIMIT, 0.01],
      ['Down / up', OFFSET_LIMIT, 0.01],
      ['Away / toward', OFFSET_LIMIT, 0.01],
      ['Turn (degrees)', 180, 1],
    ];
    const controls = axes.map(([name, limit, step]) => {
      const range = el('input', { type: 'range', min: -limit, max: limit, step });
      const number = el('input', { type: 'number', min: -limit, max: limit, step });
      range.setAttribute('aria-label', `${name} slider`);
      number.setAttribute('aria-label', name);
      return { name, range, number };
    });
    const editStatus = el('p', { className: 'hint', role: 'status' });
    editStatus.setAttribute('aria-live', 'polite');
    const editMessage = el('p', { className: 'form-message', role: 'alert' });
    const save = el('button', { type: 'button', textContent: 'Apply and save' });
    const revert = el('button', { type: 'button', className: 'secondary', textContent: 'Revert to saved' });
    const reset = el('button', { type: 'button', className: 'secondary', textContent: 'Reset object position' });
    const reload = el('button', { type: 'button', className: 'secondary', textContent: 'Load saved version', hidden: true });
    const memorySection = el('section', { className: 'memory-edit' });
    const collaborationSection = el('section', { className: 'memory-edit collab-owner' });
    const sharesSection = el('section', { className: 'memory-edit share-owner' });
    const storiesSection = el('section', { className: 'memory-edit story-owner' });
    let saving = false;
    // A save and a reload never overlap, so an older saved state read by a
    // reload cannot replace a newer one confirmed by a save.
    let reloading = false;
    let conflict = false;
    // Set while the memory panel or the collaboration panel previews or saves;
    // manual changes pause, and each panel sees the editor as busy while the
    // other holds it, so no two editors write from different states.
    const lockedBy = new Set();
    let proposalPreview = null;
    let comparison = null;
    // The manual field being typed in, and every number field whose own text
    // is not a valid value (field -> message). Neither is rewritten from the
    // preview, and any invalid field blocks saving, until it is fixed or an
    // explicit revert, reset, reload or object choice replaces it.
    let typing = null;
    const invalid = new Map();
    const firstInvalid = () => [...invalid.values()][0] ?? null;

    const toDegrees = (radians) => Math.round((radians * 180) / Math.PI);
    const showEdit = () => {
      const { offset, yaw } = session.preview;
      [...offset, toDegrees(yaw)].forEach((value, i) => {
        // The field being typed keeps its raw text until an explicit action.
        if (controls[i].range !== typing) controls[i].range.value = String(value);
        if (controls[i].number !== typing && !invalid.has(controls[i].number)) controls[i].number.value = String(value);
      });
      viewer?.applyEdit(proposalPreview ?? session.preview);
      const { version } = session.saved;
      const dirty = session.isDirty();
      const locked = lockedBy.size > 0;
      const busy = saving || reloading || locked;
      editStatus.textContent = saving
        ? 'Saving…'
        : reloading
          ? 'Loading the saved version…'
          : conflict
            ? `The saved position changed since version ${version}. Load the saved version before saving again.`
            : session.uncertain
              ? `Rehere could not confirm whether your last change was saved; the saved position may be newer than version ${version}. Load the saved version to check${dirty ? ', or apply and save again' : ''}.`
              : locked
                ? `Manual changes are paused while a memory proposal is shown or saved. The saved position is version ${version}.`
                : dirty
                  ? `Preview only. Not saved yet; the saved position is version ${version}.`
                  : `Saved, version ${version}.`;
      save.disabled = busy || conflict || !dirty || invalid.size > 0;
      revert.disabled = busy || (!dirty && invalid.size === 0);
      reset.disabled = reloading || locked;
      for (const control of controls) control.range.disabled = control.number.disabled = reloading || locked;
      reload.hidden = !(session.uncertain || conflict);
      reload.disabled = busy;
      photoSide.button.disabled = !viewer || Boolean(comparison);
      memoryEdit?.sync();
      collaborationPanel?.sync();
    };
    // One edited axis applied to the exact current geometry. Fields show
    // rounded angles and sliders snap to their steps, so untouched axes are
    // never read back from them; an explicitly entered angle is used as typed.
    const withAxis = (geometry, i, raw) => {
      const edit = { offset: [...geometry.offset], yaw: geometry.yaw };
      const value = Number(raw);
      if (i < 3) edit.offset[i] = value;
      else edit.yaw = (value * Math.PI) / 180;
      return edit;
    };
    // Leaving a field shows its parsed value; a draft that is not a valid
    // value stays as typed, with its message, and keeps blocking saves.
    // One field's text checked against the rest of the current preview.
    const axisProblem = (i, raw) => {
      const values = [...session.preview.offset, (session.preview.yaw * 180) / Math.PI];
      values[i] = raw.trim() === '' ? NaN : Number(raw);
      return editProblem({ offset: values.slice(0, 3), yaw: (values[3] * Math.PI) / 180 });
    };
    const leaveField = (node) => {
      if (typing !== node || invalid.has(node)) return;
      typing = null;
      showEdit();
    };
    // Never save behind an invalid field; otherwise the exact previewed candidate.
    const visibleProblem = () => firstInvalid() ?? editProblem(session.preview);
    for (const control of controls) {
      for (const source of ['range', 'number']) {
        control[source].addEventListener('input', () => {
          collaborationPanel?.noteViewIntent();
          const node = control[source];
          typing = node;
          // A slider sets its axis outright; a number field is checked on its own.
          if (source === 'range') invalid.delete(control.number);
          else {
            const own = axisProblem(controls.indexOf(control), node.value);
            if (own) invalid.set(node, own);
            else invalid.delete(node);
          }
          // Only a valid edited field changes the preview, and only its own
          // axis; every other axis keeps its exact previewed value, and an
          // invalid field keeps its axis until the field itself is fixed.
          const edit = invalid.has(node) ? null : withAxis(session.preview, controls.indexOf(control), node.value);
          const editIssue = edit && editProblem(edit);
          editMessage.textContent = firstInvalid() ?? editIssue ?? '';
          if (edit && !editIssue) session.setPreview(edit);
          showEdit();
        });
        control[source].addEventListener('blur', () => leaveField(control[source]));
      }
    }
    revert.addEventListener('click', () => {
      collaborationPanel?.noteViewIntent();
      typing = null;
      invalid.clear();
      session.revert();
      editMessage.textContent = '';
      showEdit();
    });
    reset.addEventListener('click', () => {
      collaborationPanel?.noteViewIntent();
      typing = null;
      invalid.clear();
      session.resetObject();
      editMessage.textContent = '';
      showEdit();
    });
    reload.addEventListener('click', async () => {
      if (saving || reloading) return;
      reloading = true;
      editMessage.textContent = '';
      showEdit();
      const latest = await request(`${base}/${jobId}`);
      if (disposed || token !== panelGeneration) return;
      reloading = false;
      if (!latest.ok || !latest.body?.edit) {
        editMessage.textContent = 'The saved version could not be loaded. Try again.';
        showEdit();
        return;
      }
      // The scene became blocked meanwhile: reopening disposes this viewer and
      // shows the blocked state instead of the old scene.
      if (latest.body.usageBlocked) {
        openScene(jobId);
        return;
      }
      session.replaceSaved(latest.body.edit);
      conflict = false;
      typing = null;
      invalid.clear();
      editMessage.textContent = 'Loaded the saved version. Your unsaved preview was replaced.';
      showEdit();
      memoryEdit?.refresh();
      collaborationPanel?.refresh();
    });
    save.addEventListener('click', async () => {
      if (saving || reloading || conflict) return;
      if (visibleProblem()) {
        editMessage.textContent = visibleProblem();
        showEdit();
        return;
      }
      const body = session.saveRequest();
      saving = true;
      editMessage.textContent = '';
      showEdit();
      const result = await postJson(`${base}/${jobId}/edit`, body);
      if (disposed || token !== panelGeneration) return;
      saving = false;
      if (result.ok && Number.isInteger(result.body?.version)) {
        session.confirm(result.body);
        conflict = false;
        memoryEdit?.refresh();
        collaborationPanel?.refresh();
        sharesPanel?.refresh();
        storiesPanel?.refresh();
      } else if (result.status === 409) {
        editMessage.textContent = `${serverError(result, 'The saved version changed.')} Your preview is kept but not saved.`;
        conflict = true;
      } else if (result.status === 0 || result.status >= 500 || result.ok) {
        session.markUncertain();
        editMessage.textContent = 'Rehere could not confirm the save. Your preview is kept and marked unsaved.';
      } else {
        editMessage.textContent = `${serverError(result, 'The change could not be saved.')} Your preview is kept but not saved.`;
      }
      showEdit();
    });

    const comparisonPhoto = el('img', { className: 'visit-compare-photo', alt: 'The photo copy used to build this scene', hidden: true });
    const comparisonBox = el('div', { className: 'box-overlay', hidden: true });
    comparisonBox.setAttribute('aria-hidden', 'true');
    const comparisonFrame = el('div', { className: 'visit-compare-frame memory-comparison-frame' }, [viewport, comparisonPhoto, comparisonBox]);
    const comparisonWords = el('p', { className: 'memory-comparison-words', tabIndex: 0 });
    const comparisonAction = el('p');
    const comparisonStatus = el('p', { className: 'hint', role: 'status' });
    const comparisonPhotoNote = el('p', { className: 'hint', hidden: true });
    const photoChoice = el('button', { type: 'button', className: 'secondary', textContent: 'Photo' });
    const savedChoice = el('button', { type: 'button', className: 'secondary', textContent: 'Saved' });
    const proposedChoice = el('button', { type: 'button', className: 'secondary', textContent: 'Proposed' });
    const leaveComparison = el('button', { type: 'button', className: 'secondary', textContent: 'Leave comparison' });
    const comparisonBar = el('div', { className: 'visit-compare memory-comparison', hidden: true }, [
      el('div', { className: 'actions' }, [photoChoice, savedChoice, proposedChoice, leaveComparison]),
      comparisonWords, comparisonAction,
      el('p', { className: 'hint', textContent: 'Photo is the copy used to build this scene. Saved and Proposed use the same photo viewpoint. Switching does not save a change.' }),
      comparisonPhotoNote, comparisonStatus,
    ]);
    const cameraActions = el('div', { className: 'actions space-camera' }, [explore.button, original, side, photoSide.button]);
    let comparisonLoad = 0;
    let comparisonTimer = null;
    let comparisonResize = null;
    let shownComparisonView = 'saved';
    const imageSize = surfaceResult.body?.source?.image_size;
    const boxUsable = Array.isArray(imageSize) && imageSize.length === 2 && imageSize.every((value) => Number.isInteger(value) && value > 0) &&
      !boxProblem(job.box, ...imageSize);
    const positionComparisonBox = () => {
      comparisonBox.hidden = true;
      if (shownComparisonView !== 'photo' || !boxUsable) return;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (!width || !height) return;
      const [imageWidth, imageHeight] = imageSize;
      const [x1, y1, x2, y2] = job.box;
      const fitWidth = Math.min(width, height * imageWidth / imageHeight);
      const fitHeight = fitWidth * imageHeight / imageWidth;
      Object.assign(comparisonBox.style, {
        left: `${(width - fitWidth) / 2 + fitWidth * x1 / imageWidth}px`,
        top: `${(height - fitHeight) / 2 + fitHeight * y1 / imageHeight}px`,
        width: `${fitWidth * (x2 - x1) / imageWidth}px`,
        height: `${fitHeight * (y2 - y1) / imageHeight}px`,
      });
      comparisonBox.hidden = false;
    };
    const cancelComparisonPhoto = () => {
      comparisonLoad += 1;
      clearTimeout(comparisonTimer);
      comparisonTimer = null;
      comparisonPhoto.onload = null;
      comparisonPhoto.onerror = null;
      comparisonPhoto.removeAttribute('src');
    };
    const showComparisonView = (view) => {
      shownComparisonView = view;
      for (const [button, name] of [[photoChoice, 'photo'], [savedChoice, 'saved'], [proposedChoice, 'proposed']]) {
        button.setAttribute('aria-pressed', String(view === name));
      }
      comparisonPhoto.hidden = view !== 'photo';
      comparisonPhotoNote.hidden = view !== 'photo';
      comparisonFrame.classList.toggle('is-photo', view === 'photo');
      positionComparisonBox();
    };
    const comparisonBridge = {
      available: () => Boolean(viewer && surfaceResult.body?.source?.source_id === job.sourceId && !disposed && token === panelGeneration),
      source: () => sourceFor(job.sourceId),
      open(details) {
        if (!this.available() || comparison) return false;
        comparison = { ...details, camera: viewer.getCamera(), interactive: viewer.isInteractive() };
        comparisonWords.textContent = `Your memory: “${details.statement}”`;
        comparisonAction.textContent = `Proposed change: ${details.action}`;
        comparisonPhotoNote.textContent = boxUsable ? 'The box marks the selected photo region; it is not a confirmed object outline.' : 'The selected photo box could not be shown here.';
        comparisonStatus.textContent = '';
        comparisonBar.hidden = false;
        viewer.setInteractive(false);
        explore.attach(null);
        original.disabled = side.disabled = photoSide.button.disabled = true;
        cameraActions.hidden = explore.status.hidden = photoSide.status.hidden = true;
        comparisonFrame.classList.toggle('is-comparing', true);
        viewer.setPhotoFraming(true);
        viewer.originalView();
        comparisonResize = new ResizeObserver(positionComparisonBox);
        comparisonResize.observe(viewport);
        showComparisonView('saved');
        savedChoice.focus();
        return true;
      },
      close({ focusHidden = true } = {}) {
        if (!comparison) return;
        const saved = comparison;
        const focusWasInside = comparisonBar.contains(document.activeElement);
        comparison = null;
        comparisonResize?.disconnect();
        comparisonResize = null;
        cancelComparisonPhoto();
        showComparisonView('saved');
        comparisonBar.hidden = true;
        comparisonWords.textContent = '';
        comparisonAction.textContent = '';
        comparisonStatus.textContent = '';
        cameraActions.hidden = explore.status.hidden = photoSide.status.hidden = false;
        comparisonFrame.classList.toggle('is-comparing', false);
        viewer?.setPhotoFraming(false);
        viewer?.setCamera(saved.camera);
        if (saved.interactive) viewer?.setInteractive(true, { focus: false });
        explore.attach(viewer);
        original.disabled = side.disabled = !viewer;
        photoSide.button.disabled = !viewer;
        if (focusHidden && focusWasInside) original.focus();
      },
    };
    const chooseComparisonScene = (view) => {
      if (!comparison || !comparison.select(view) || !comparison) return;
      cancelComparisonPhoto();
      comparisonStatus.textContent = '';
      showComparisonView(view);
    };
    savedChoice.addEventListener('click', () => chooseComparisonScene('saved'));
    proposedChoice.addEventListener('click', () => chooseComparisonScene('proposed'));
    photoChoice.addEventListener('click', () => {
      // Until the photo actually loads, the drawn and selected view is Saved.
      if (!comparison || !comparison.select('saved') || !comparison) return;
      const retrying = comparisonStatus.textContent.startsWith('The photo could not be shown.');
      cancelComparisonPhoto();
      showComparisonView('saved');
      const load = comparisonLoad;
      comparisonStatus.textContent = retrying
        ? 'The photo could not be shown. Trying again; the saved scene is still available.'
        : 'Loading the photo…';
      const settled = (ok) => {
        if (!comparison || load !== comparisonLoad || disposed || token !== panelGeneration) return;
        clearTimeout(comparisonTimer);
        comparisonTimer = null;
        comparisonLoad += 1;
        comparisonPhoto.onload = null;
        comparisonPhoto.onerror = null;
        if (ok) {
          if (!comparison.select('photo') || !comparison) return;
          comparisonStatus.textContent = '';
          showComparisonView('photo');
        } else {
          comparisonPhoto.removeAttribute('src');
          comparison.select('saved');
          comparisonStatus.textContent = 'The photo could not be shown. The saved scene is still available.';
          showComparisonView('saved');
        }
      };
      comparisonPhoto.onload = () => settled(true);
      comparisonPhoto.onerror = () => settled(false);
      comparisonTimer = setTimeout(() => settled(false), 10_000);
      // A failed image can remain in the browser's image cache after the file
      // returns. Each explicit choice requests the same asset under a new URL.
      comparisonPhoto.src = `${assetUrl(jobId, 'texture.jpg')}?comparison=${crypto.randomUUID()}`;
    });
    leaveComparison.addEventListener('click', () => comparison?.exit());

    const placeWords = el('p', { className: 'place-words', textContent: 'Checking this place’s saved memory…' });
    const fullWords = el('p', { className: 'place-words' });
    const fullWordsDetails = el('details', { className: 'source-details', hidden: true }, [el('summary', { textContent: 'Read all the words' }), fullWords]);
    const placeStatus = el('p', { className: 'hint', role: 'status' });
    const placeAction = el('button', { type: 'button', textContent: 'Change from a memory' });
    const visitAction = el('button', { type: 'button', className: 'secondary', textContent: 'Prepare a visit', hidden: true });
    let placeSummary = { kind: 'checking' };
    let lastWords = null;
    const focusSection = (section, disclosure = false) => {
      const destination = disclosure ? section.children[0]?.children[0] : section.querySelector?.('h4');
      if (disclosure && section.children[0]) section.children[0].open = true;
      if (!destination) return;
      if (!disclosure) destination.setAttribute('tabindex', '-1');
      destination.focus();
      destination.scrollIntoView?.({ block: 'start' });
    };
    const originalPhoto = el('button', { type: 'button', className: 'secondary', textContent: 'See the original photo' });
    originalPhoto.addEventListener('click', () => {
      const materials = document.getElementById?.('viewer-materials');
      if (!materials) {
        placeStatus.textContent = 'The original materials are not available here.';
        return;
      }
      materials.open = true;
      materials.querySelector('summary')?.focus();
      materials.scrollIntoView?.({ block: 'start' });
    });
    placeAction.addEventListener('click', () => {
      if (placeSummary.kind === 'proposal') {
        if (!memoryEdit?.compareFrom(placeAction)) placeStatus.textContent = 'This proposal is no longer ready to compare. Review the saved proposals below.';
      } else focusSection(memorySection);
    });
    visitAction.addEventListener('click', () => focusSection(sharesSection, true));
    const placeLanding = el('section', { className: 'place-landing', 'aria-label': 'This place' }, [
      el('h4', { textContent: 'This place' }),
      el('p', { className: 'hint', textContent: 'The scene begins with one photograph. Its shape and depth are estimates; a memory is someone’s account.' }),
      placeWords,
      fullWordsDetails,
      el('div', { className: 'actions' }, [placeAction, originalPhoto, visitAction]),
      placeStatus,
    ]);
    placeLanding.setAttribute('aria-label', 'This place');
    const updatePlaceSummary = (summary) => {
      placeSummary = summary;
      placeAction.textContent = summary.kind === 'proposal' ? 'Compare this change' : 'Change from a memory';
      const words = summary.kind === 'proposal' || summary.kind === 'saved' ? summary.text : null;
      const label = summary.kind === 'proposal' ? 'Proposed from your words' : `Saved change, version ${summary.version}, from your words`;
      const characters = words ? Array.from(words) : [];
      const nextLong = characters.length > 160;
      const changed = summary.kind !== 'checking' && words !== lastWords;
      if (fullWordsDetails.contains(document.activeElement) && (!nextLong || changed)) placeAction.focus();
      if (words) {
        placeWords.textContent = `${label}: “${characters.slice(0, 160).join('')}${characters.length > 160 ? '…' : ''}”`;
        fullWords.textContent = words;
        fullWordsDetails.hidden = !nextLong;
      } else {
        fullWords.textContent = '';
        fullWordsDetails.hidden = true;
        placeWords.textContent = summary.kind === 'checking' ? 'Checking this place’s saved memory…'
          : summary.kind === 'unavailable' ? 'The memory for this saved view is not available right now.'
            : 'No saved change from a written memory for this view.';
      }
      if (changed) fullWordsDetails.open = false;
      if (summary.kind !== 'checking') lastWords = words;
      visitAction.hidden = session.saved.version <= 1;
      placeStatus.textContent = '';
    };

    const manualEdit = el('details', { className: 'source-details' }, [
      el('summary', { textContent: 'Move the object by hand' }),
      el('fieldset', { className: 'space-edit' }, [
        el('legend', { textContent: 'Move the selected object' }),
        el('p', { className: 'hint', textContent: 'Changes are a preview until you apply and save them. Moving the object leaves an empty gap where it was; nothing is generated to fill it.' }),
        ...controls.map(({ name, range, number }) => el('div', { className: 'space-axis' }, [el('span', { textContent: name }), range, number])),
        editStatus,
        editMessage,
        el('div', { className: 'actions' }, [reload, reset, revert, save]),
      ]),
    ]);
    const otherActions = el('details', { className: 'source-details' }, [
      el('summary', { textContent: 'More ways to continue' }),
      nextActions(memorySection, collaborationSection, sharesSection),
    ]);
    panel.replaceChildren(
      heading,
      sceneWorkspace(
        [cameraActions, explore.status, photoSide.status, comparisonBar, comparisonFrame, viewMessage, ...photoCredit(job), el('p', { className: 'hint', textContent: SCENE_NOTE })],
        [
          placeLanding,
          manualEdit,
          otherActions,
          memorySection,
          collaborationSection,
          storiesSection,
          sharesSection,
          proposals,
        ],
      ),
    );
    const editorFor = (name) => () => ({
      ...session.saved,
      clean: invalid.size === 0 && !session.isDirty() && !session.uncertain && !conflict && !saving && !reloading && ![...lockedBy].some((holder) => holder !== name),
    });
    const lockFor = (name) => (value) => {
      if (value) lockedBy.add(name);
      else lockedBy.delete(name);
      showEdit();
    };
    memoryEdit = mountMemoryEdit(memorySection, {
      jobUrl: `${base}/${jobId}`,
      textureUrl: assetUrl(jobId, 'texture.jpg'),
      sourceId: job.sourceId,
      source: sourceFor(job.sourceId),
      editor: editorFor('memory'),
      comparison: comparisonBridge,
      onPlaceSummary: updatePlaceSummary,
      // Returns the shown facing relation for a face-anchor point, or null when
      // there is no 3D view to show it in.
      showTransform(transform, point = null) {
        collaborationPanel?.noteViewIntent();
        proposalPreview = transform;
        showEdit();
        return viewer ? viewer.showGuide(transform, point) : null;
      },
      setLocked: lockFor('memory'),
      saved(edit) {
        session.replaceSaved(edit);
        conflict = false;
        editMessage.textContent = '';
        showEdit();
        collaborationPanel?.refresh();
        sharesPanel?.refresh();
        storiesPanel?.refresh();
      },
      unconfirmed() {
        session.markUncertain();
        showEdit();
      },
      conflict() {
        conflict = true;
        showEdit();
      },
    });
    collaborationPanel = mountCollaboration(collaborationSection, {
      jobUrl: `${base}/${jobId}`,
      // New alternatives or recollections change story and sharing choices.
      onChanged: () => { sharesPanel?.refreshOptions(); storiesPanel?.refresh(); },
      editor: editorFor('collaboration'),
      memorySources: [sourceFor(job.sourceId)],
      memoryTextureUrl: assetUrl(jobId, 'texture.jpg'),
      revisionGuide: (transform, point) => viewer?.showGuide(transform, point) ?? null,
      // True only when the 3D view actually drew the transform.
      showTransform(transform) {
        proposalPreview = transform;
        showEdit();
        viewer?.showGuide(null, null);
        return Boolean(viewer && transform);
      },
      setLocked: lockFor('collaboration'),
      // The current version now depends on a withdrawn recollection: reopen,
      // which reads usageBlocked, disposes this viewer and offers a restore.
      blocked() {
        if (disposed || token !== panelGeneration) return;
        openScene(jobId);
      },
      saved(edit) {
        session.replaceSaved(edit);
        conflict = false;
        editMessage.textContent = '';
        showEdit();
        memoryEdit?.refresh();
        sharesPanel?.refresh();
        storiesPanel?.refresh();
      },
      unconfirmed() {
        session.markUncertain();
        showEdit();
      },
      conflict() {
        conflict = true;
        showEdit();
      },
    });

    storiesPanel = mountStories(storiesSection, {
      jobUrl: `${base}/${jobId}`,
      sources: Array.isArray(draft.sources) ? draft.sources : [],
      editor: () => session.saved,
      durationHintMs,
      onChanged: () => sharesPanel?.refreshOptions(),
    });
    sharesPanel = mountShares(sharesSection, {
      sharesUrl: `${base}/${jobId}/shares`,
      jobUrl: `${base}/${jobId}`,
      editor: () => session.saved,
      getCamera: () => viewer?.getCamera() ?? null,
    });

    let created = null;
    try {
      created = await createViewer(viewport, surfaceResult.body, assetUrl(jobId, 'texture.jpg'), `3D partial scene from photo ${number}`);
    } catch (error) {
      viewport.hidden = true;
      original.disabled = true;
      side.disabled = true;
      viewMessage.textContent = {
        webgl: 'This browser could not start 3D graphics (WebGL), so the scene cannot be shown here. The photos, writing and the model’s outline and depth images are still available.',
        texture: 'The scene’s image could not be loaded, so the scene is not shown. The original photo is unchanged; reload the page to try again.',
      }[error.message] ?? 'The scene data could not be shown. The original photo is unchanged.';
    }
    if (disposed || token !== panelGeneration) {
      created?.dispose();
      return;
    }
    viewer = created;
    explore.attach(viewer);
    original.addEventListener('click', () => {
      viewer?.originalView();
      photoSide.status.textContent = '';
    });
    side.addEventListener('click', () => {
      viewer?.sideView();
      photoSide.status.textContent = '';
    });
    // The transform drawn now: a panel's preview, else the manual preview.
    photoSide.button.addEventListener('click', () => {
      if (!viewer) return;
      photoSide.status.textContent = viewer.viewPhotographedSide(proposalPreview ?? session.preview) ? SIDE_MOVED('the object') : SIDE_OUTSIDE;
    });
    showEdit();
  }

  // Two objects: one box each, with a label the person types. The model
  // proposes an outline inside each box; the person checks both after the build.
  function openTwoSelection(photo, index) {
    closePanel();
    onScene(null);
    const token = panelGeneration;
    const sourceId = photo.sourceId;
    let requestId = null;
    let size = null;
    let imageShown = false;
    let active = 0;
    const ready = () => Boolean(size) && imageShown;
    const image = el('img', { src: photoAsset(photo), alt: `Photo ${index + 1}. Drag on it to draw box A, then box B.`, draggable: false });
    const entries = ['A', 'B'].map((letter) => {
      const badge = el('span', { className: 'box-badge', textContent: letter });
      return {
        letter,
        box: null,
        label: el('input', { type: 'text', maxLength: 200 }),
        inputs: [0, 1, 2, 3].map(() => el('input', { type: 'number', step: 1, min: 0, inputMode: 'numeric' })),
        badge,
        overlay: el('div', { className: `box-overlay box-overlay-${letter.toLowerCase()}`, hidden: true }, [badge]),
      };
    });
    const frame = el('div', { className: 'box-select' }, [image, ...entries.map((entry) => entry.overlay)]);
    const drawButtons = entries.map((entry, i) => el('button', { type: 'button', className: 'secondary', textContent: `Draw box ${entry.letter}`, onclick: () => choose(i) }));
    const message = el('p', { className: 'form-message', role: 'alert' });
    const build = el('button', { type: 'button', textContent: 'Build partial scene with two objects', disabled: true });
    const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Cancel', onclick: () => closePanel() });

    const labelOf = (entry) => entry.label.value.trim();
    const problem = () => {
      for (const entry of entries) {
        if (!labelOf(entry)) return `Name object ${entry.letter}.`;
        if (labelOf(entry).length > 80) return `Keep the name of object ${entry.letter} to 80 characters or fewer.`;
        const boxIssue = boxProblem(entry.box, ...size);
        if (boxIssue) return `Box ${entry.letter}: ${boxIssue}`;
      }
      if (labelOf(entries[0]).toLowerCase() === labelOf(entries[1]).toLowerCase()) return 'Give the two objects different names, so each can be chosen later.';
      return null;
    };
    const show = () => {
      for (const entry of entries) {
        entry.badge.textContent = labelOf(entry) ? `${entry.letter}: ${labelOf(entry)}` : entry.letter;
        entry.overlay.hidden = !entry.box || !ready() || boxProblem(entry.box, ...size) !== null;
        if (!entry.overlay.hidden) {
          const [x1, y1, x2, y2] = entry.box;
          Object.assign(entry.overlay.style, { left: `${(x1 / size[0]) * 100}%`, top: `${(y1 / size[1]) * 100}%`, width: `${((x2 - x1) / size[0]) * 100}%`, height: `${((y2 - y1) / size[1]) * 100}%` });
        }
      }
      drawButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === active)));
      build.disabled = !ready() || problem() !== null;
    };
    const choose = (i) => {
      active = i;
      show();
    };
    const setBox = (entry, box, fromInputs = false) => {
      entry.box = box;
      requestId = null;
      if (!fromInputs) box.forEach((value, i) => (entry.inputs[i].value = String(value)));
      show();
    };
    image.addEventListener('load', () => {
      imageShown = true;
      show();
    });
    request(`/api/drafts/${draft.id}/sources/${sourceId}/image-size`).then((result) => {
      if (disposed || token !== panelGeneration) return;
      const { width, height } = result.body ?? {};
      if (!result.ok || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        message.textContent = `${serverError(result, 'The photo size could not be read.')} Boxes cannot be chosen, and nothing was sent to the model.`;
        return;
      }
      size = [width, height];
      show();
    });
    const toImage = (event) => {
      const rect = image.getBoundingClientRect();
      return [((event.clientX - rect.left) * size[0]) / rect.width, ((event.clientY - rect.top) * size[1]) / rect.height];
    };
    let start = null;
    frame.addEventListener('pointerdown', (event) => {
      if (!ready() || event.button !== 0) return;
      event.preventDefault();
      frame.setPointerCapture(event.pointerId);
      start = toImage(event);
    });
    frame.addEventListener('pointermove', (event) => {
      if (start) setBox(entries[active], boxFromPoints(start, toImage(event), ...size));
    });
    const finish = () => {
      if (start && active === 0 && entries[0].box && !entries[1].box) active = 1;
      start = null;
      show();
    };
    frame.addEventListener('pointerup', finish);
    frame.addEventListener('pointercancel', finish);
    for (const entry of entries) {
      entry.label.addEventListener('input', () => {
        requestId = null;
        show();
      });
      for (const input of entry.inputs) {
        input.addEventListener('input', () => setBox(entry, entry.inputs.map((field) => (field.value.trim() === '' ? NaN : Number(field.value))), true));
      }
    }
    build.addEventListener('click', async () => {
      if (!ready()) return;
      const issue = problem();
      if (issue) {
        message.textContent = issue;
        return;
      }
      requestId ??= crypto.randomUUID();
      build.disabled = true;
      message.textContent = 'Sending the build request…';
      const result = await postJson(base, { requestId, sourceId, objects: entries.map((entry) => ({ label: entry.label.value, box: entry.box })) });
      if (disposed) return;
      const accepted = result.ok && Boolean(result.body?.id);
      if (token !== panelGeneration) {
        if (accepted) followBuild(result.body, { follow: false });
        return;
      }
      build.disabled = false;
      if (result.status === 0 || result.status >= 500 || (result.ok && !accepted)) {
        message.textContent = UNCONFIRMED_BUILD;
        return;
      }
      requestId = null;
      if (!result.ok) {
        message.textContent = serverError(result, 'The build could not be started.');
        return;
      }
      closePanel();
      followBuild(result.body);
    });

    panel.replaceChildren(
      el('h3', { textContent: `Choose two objects in photo ${index + 1}` }),
      el('p', {
        className: 'hint',
        textContent:
          'Draw box A around one object and box B around another, and name each. The names are yours, not the model’s. The model proposes an outline inside each box; you check both outlines after the build. Where the outlines overlap, those pixels are left empty.',
      }),
      el('div', { className: 'actions space-camera' }, drawButtons),
      frame,
      ...entries.map((entry) =>
        el('fieldset', { className: 'box-fields' }, [
          el('legend', { textContent: `Object ${entry.letter}` }),
          el('label', {}, ['Name ', entry.label]),
          ...['Left', 'Top', 'Right', 'Bottom'].map((name, i) => el('label', {}, [`${name} `, entry.inputs[i]])),
        ]),
      ),
      message,
      el('div', { className: 'actions' }, [cancel, build]),
    );
  }

  // A two-object scene. Until the person confirms that both outlines match
  // their objects, the scene is read-only.
  async function openObjectScene({ job, jobId, surface, token, heading, number }) {
    const jobUrl = `${base}/${jobId}`;
    const composition = isComposition(surface);
    const texture = composition ? { 'texture-1.jpg': assetUrl(jobId, 'texture-1.jpg'), 'texture-2.jpg': assetUrl(jobId, 'texture-2.jpg') } : assetUrl(jobId, 'texture.jpg');
    const componentFor = (id) => surface.components?.find((component) => component.id === id);
    const sourceIdFor = (id) => composition ? job.sourceBindings?.find((binding) => binding.objectIds?.includes(id))?.sourceId : job.sourceId;
    const photoFor = (id) => {
      const component = componentFor(id);
      return { sourceId: sourceIdFor(id), size: composition ? component.surface.source.image_size : surface.source.image_size, url: composition ? texture[component.texture] : texture, number: photoNumber(sourceIdFor(id)) };
    };
    const objects = Array.isArray(job.objects) ? job.objects : [];
    const letterOf = (id) => (objects.findIndex((object) => object.id === id) === 0 ? 'A' : 'B');
    const nameOf = (id) => `${letterOf(id)}: ${objects.find((object) => object.id === id)?.label ?? ''}`;
    const pivots = objects.map(({ id, pivot }) => ({ id, pivot: composition ? [0, 0, 0] : pivot }));
    const viewport = el('div', { className: 'space-viewport' });
    const badges = el('div', { className: 'object-badges' });
    badges.setAttribute('aria-hidden', 'true');
    const viewMessage = el('p', { className: 'form-message', role: 'alert' });
    const original = el('button', { type: 'button', className: 'secondary', textContent: 'Original viewpoint' });
    const photoSide = photographedSideControls();
    const side = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect from the side' });
    if (composition) original.hidden = true;
    let shown = job.edit;
    const drawBadges = () => {
      if (!viewer) return;
      badges.replaceChildren(
        ...viewer
          .projectCentres()
          .filter((point) => point.visible)
          .map((point) => {
            const badge = el('span', { className: 'object-badge', textContent: nameOf(point.id) });
            badge.style.left = `${point.x}px`;
            badge.style.top = `${point.y}px`;
            return badge;
          }),
      );
    };
    const [imageWidth, imageHeight] = composition ? surface.components[0].surface.source.image_size : surface.source.image_size;
    const boxOver = (object) => {
      const [width, height] = photoFor(object.id).size;
      const [x1, y1, x2, y2] = object.box;
      const box = el('div', { className: `box-overlay box-overlay-${letterOf(object.id).toLowerCase()}` }, [el('span', { className: 'box-badge', textContent: nameOf(object.id) })]);
      Object.assign(box.style, { left: `${(x1 / width) * 100}%`, top: `${(y1 / height) * 100}%`, width: `${((x2 - x1) / width) * 100}%`, height: `${((y2 - y1) / height) * 100}%` });
      return box;
    };

    async function mountViewer() {
      let created = null;
      try {
        created = await createViewer(viewport, surface, texture, composition ? 'Two-photo owner composition' : `3D partial scene with two objects from photo ${number}`, { onDraw: drawBadges });
      } catch (error) {
        viewport.hidden = true;
        original.disabled = true;
        side.disabled = true;
        viewMessage.textContent = {
          webgl: 'This browser could not start 3D graphics (WebGL), so the scene cannot be shown here. The model’s outline and depth images are still available.',
          texture: 'The scene’s image could not be loaded, so the scene is not shown. The original photo is unchanged; reload the page to try again.',
        }[error.message] ?? 'The scene data could not be shown. The original photo is unchanged.';
      }
      if (disposed || token !== panelGeneration) {
        created?.dispose();
        return false;
      }
      viewer = created;
      explore.attach(viewer);
      original.addEventListener('click', () => {
        viewer?.originalView();
        photoSide.status.textContent = '';
      });
      side.addEventListener('click', () => {
        viewer?.sideView();
        photoSide.status.textContent = '';
      });
      viewer?.applyArrangement(shown);
      return true;
    }

    const explore = createExploreToggle();
    const stage = [el('div', { className: 'actions space-camera' }, [explore.button, original, side, photoSide.button]), explore.status, photoSide.status, el('div', { className: 'space-viewport-wrap' }, [viewport, badges]), viewMessage, ...(composition ? objects.flatMap((object) => photoCredit({ sourceId: sourceIdFor(object.id) })) : photoCredit(job)), ...(job.outline?.kind === 'owner-corrected' ? [el('p', { className: 'hint', textContent: 'Outlines include an owner-made correction; depth remains the existing model estimate.' })] : []), el('p', { className: 'hint', textContent: composition ? `${COMPOSITION_NOTE} ${surface.context ? 'The first photo’s observed background is fixed at its initial placement.' : 'Only the two observed surfaces are shown, with no background.'}` : SCENE_NOTE })];

    if (!job.objectsConfirmed) {
      // No object can be chosen before the outlines are confirmed.
      photoSide.button.hidden = true;
      let confirmId = null;
      const message = el('p', { className: 'form-message', role: 'alert' });
      const confirm = el('button', { type: 'button', textContent: composition ? 'Confirm these surfaces and my assumed layout' : 'The outlines match A and B' });
      const mismatch = el('button', { type: 'button', className: 'secondary', textContent: 'They do not match' });
      const identity = el('input', { type: 'checkbox' });
      const layout = el('input', { type: 'checkbox' });
      if (composition) confirm.disabled = true;
      for (const checkbox of [identity, layout]) checkbox.addEventListener('change', () => { confirm.disabled = composition && (!identity.checked || !layout.checked); });
      confirm.addEventListener('click', async () => {
        if (composition && (!identity.checked || !layout.checked)) return;
        confirmId ??= crypto.randomUUID();
        confirm.disabled = true;
        const result = await postJson(`${jobUrl}/objects/confirm`, { requestId: confirmId, objectIds: objects.map((object) => object.id), ...(composition ? { surfaceIdentityConfirmed: true, layoutConfirmed: true, scaleBasis: 'owner-assumed-relative' } : {}) });
        if (disposed || token !== panelGeneration) return;
        confirm.disabled = false;
        if (result.status === 0 || result.status >= 500) {
          message.textContent = `${serverError(result, '')} Rehere could not confirm this. Pressing it again repeats the same request.`.trim();
          return;
        }
        confirmId = null;
        if (!result.ok) {
          message.textContent = serverError(result, 'The confirmation could not be saved.');
          return;
        }
        openScene(jobId);
      });
      if (composition) mismatch.hidden = true;
      mismatch.addEventListener('click', () => {
        if (composition) return;
        closePanel();
        onScene(jobId);
        outlineEditor = mountOutlineEditor(panel, {
          job, surface, textureUrl: assetUrl(jobId, 'texture.jpg'), jobUrl, post: postJson,
          onSaved: (child, { late = false } = {}) => {
            if (disposed) return;
            if (late) {
              loadJobs({ resumePolling: false });
              return;
            }
            status.textContent = 'A new scene was saved at the original positions. Check its corrected outlines before confirming both objects. The previous scene is kept.';
            loadJobs({ resumePolling: false });
            openScene(child.id);
          },
          onCancel: ({ unknown }) => {
            if (unknown) {
              status.textContent = 'The new scene’s save outcome is still unknown. Check the saved scene list before starting another correction.';
              loadJobs({ resumePolling: false });
            }
            openScene(jobId);
          },
        });
      });
      if (composition) {
        panel.append(sceneWorkspace(stage, [el('section', { className: 'memory-edit object-confirm' }, [
          el('h4', { textContent: 'Check the selected surfaces and your layout' }),
          ...objects.map((object) => el('figure', {}, [el('img', { className: 'space-proposal', src: photoFor(object.id).url, alt: `Source photo for ${nameOf(object.id)}` }), el('figcaption', { textContent: `${nameOf(object.id)} · photo ${photoFor(object.id).number}` })])),
          el('p', { className: 'hint', textContent: describeArrangement(job.edit, nameOf) }),
          el('label', {}, [identity, ' These photographed surfaces are the objects I named']),
          el('label', {}, [layout, ' I chose this position, full orientation and assumed relative scale; no alignment or historical size was inferred']),
          confirm, message,
        ])]));
        await mountViewer();
        return;
      }
      panel.append(
        sceneWorkspace(stage, [
          el('section', { className: 'memory-edit object-confirm' }, [
            el('h4', { textContent: 'Check the two outlines' }),
            el('p', { className: 'hint', textContent: `${job.outline?.kind === 'owner-corrected' ? 'This scene includes an owner-made outline correction. Check both outlines against the named objects.' : 'The model proposed these outlines inside your boxes.'} Nothing can be moved, planned, shared or given a story until you confirm they match the objects you named.` }),
            el('div', { className: 'anchor-frame' }, [el('img', { src: assetUrl(jobId, 'mask-overlay.jpg'), alt: `Photo ${number} with the two ${job.outline?.kind === 'owner-corrected' ? 'saved' : 'proposed'} outlines tinted` }), ...objects.map(boxOver)]),
            el('ul', { className: 'hint' }, [
              ...objects.map((object) => el('li', { textContent: `${nameOf(object.id)}: the ${letterOf(object.id) === 'A' ? 'blue' : 'orange'} tinted area.` })),
              el('li', { textContent: 'Background: the rest of the photo, not tinted.' }),
              el('li', { textContent: 'White: the two outlines overlapped there; those pixels are left empty in the scene.' }),
            ]),
            el('img', { className: 'space-proposal', src: assetUrl(jobId, 'depth-preview.png'), alt: `Relative depth estimate for photo ${number} as a greyscale image` }),
            el('div', { className: 'actions' }, [mismatch, confirm]),
            message,
          ]),
        ]),
      );
      await mountViewer();
      return;
    }

    let relations = null;
    try {
      relations = await import('./scene-relations.js');
    } catch {
      relations = null;
    }
    if (disposed || token !== panelGeneration) return;

    const session = createArrangementSession(job.edit, () => crypto.randomUUID(), job.initialArrangement ?? job.edit);
    const surfaces = visibleSurfaceGate(surface, () => !disposed && token === panelGeneration, () => showEdit());
    // Set while the memory or collaboration panel previews or saves: manual
    // changes and switching objects pause, and the viewer shows that preview.
    const lockedBy = new Set();
    let proposalPreview = null;
    // The one object a panel's preview is about, when it is about one; the
    // camera action then inspects that object, whatever is selected.
    let previewTarget = null;
    const cameraTarget = () => (proposalPreview ? previewTarget ?? selected : selected);
    // The manual field being typed in, and every number field whose own text
    // is not a valid value (field -> message). Neither is rewritten from the
    // preview, and any invalid field blocks saving, until it is fixed or an
    // explicit revert, reset, reload or object choice replaces it.
    let typing = null;
    const invalid = new Map();
    const firstInvalid = () => [...invalid.values()][0] ?? null;
    const memorySection = el('section', { className: 'memory-edit' });
    const collaborationSection = el('section', { className: 'memory-edit collab-owner' });
    const storiesSection = el('section', { className: 'memory-edit story-owner' });
    const sharesSection = el('section', { className: 'memory-edit share-owner' });
    let selected = null;
    let selectionGen = 0;
    let showingSaved = false;
    let saving = false;
    let reloading = false;
    let conflict = false;
    let ruleAttempt = null;
    // A rule change in flight, or one whose outcome is unknown: manual edits,
    // switching objects and the other panels wait. An unknown outcome is
    // settled only by an exact retry or by loading the saved version.
    let ruleSaving = false;
    let ruleUncertain = false;
    const axes = composition ? poseAxes.map(([name, min, max, step]) => [name, max, step, min]) : [
      ['Left / right', OFFSET_LIMIT, 0.01],
      ['Down / up', OFFSET_LIMIT, 0.01],
      ['Away / toward', OFFSET_LIMIT, 0.01],
      ['Turn (degrees)', 180, 1],
    ];
    const controls = axes.map(([name, limit, step, minimum = -limit]) => {
      const range = el('input', { type: 'range', min: minimum, max: limit, step });
      const field = el('input', { type: 'number', min: minimum, max: limit, step });
      range.setAttribute('aria-label', `${name} slider`);
      field.setAttribute('aria-label', name);
      return { name, range, number: field };
    });
    const pick = objects.map((object) => el('button', { type: 'button', className: 'secondary', textContent: nameOf(object.id), onclick: () => select(object.id) }));
    const editStatus = el('p', { className: 'hint', role: 'status' });
    editStatus.setAttribute('aria-live', 'polite');
    const editMessage = el('p', { className: 'form-message', role: 'alert' });
    const save = el('button', { type: 'button', textContent: 'Apply and save' });
    const revert = el('button', { type: 'button', className: 'secondary', textContent: 'Revert to saved' });
    const reset = el('button', { type: 'button', className: 'secondary', textContent: composition ? 'Reset object to initial pose' : 'Reset object position' });
    const reload = el('button', { type: 'button', className: 'secondary', textContent: 'Load saved version', hidden: true });
    const toggle = el('button', { type: 'button', className: 'secondary', textContent: 'Show saved arrangement' });
    let facingPreview = false;
    const faceConfirm = el('input', { type: 'checkbox' });
    const face = el('button', { type: 'button', className: 'secondary', textContent: 'Preview photographed side facing the other object', hidden: !composition });
    face.addEventListener('click', () => {
      if (!composition || !selected || saving || reloading || lockedBy.size || invalid.size) return;
      const other = session.preview.objects.find((object) => object.id !== selected);
      const pose = faceObjectPose(objectState(session.preview, selected), other.position);
      if (!pose || !viewer) { editMessage.textContent = 'A usable direction and 3D preview are required for this turn.'; return; }
      session.setPreview(selected, pose); facingPreview = true; faceConfirm.checked = false;
      showEdit(); viewer.showGuide(pose, other.position, selected);
    });
    faceConfirm.addEventListener('change', () => showEdit());
    const strip = el('div', { className: 'relation-strip' });
    const evidence = el('div', { className: 'object-evidence' });
    const evidenceSummary = el('summary');
    const evidenceBox = el('details', { className: 'source-details' }, [evidenceSummary, evidence]);
    const ruleState = el('p', { className: 'hint' });
    const ruleOrder = el('select');
    for (const [leftId, rightId] of [[objects[0]?.id, objects[1]?.id], [objects[1]?.id, objects[0]?.id]]) {
      ruleOrder.append(el('option', { value: `${leftId}|${rightId}`, textContent: `Keep ${nameOf(leftId)} left of ${nameOf(rightId)}` }));
    }
    if (composition) for (const object of objects) ruleOrder.append(el('option', { value: `faces|${object.id}`, textContent: `Keep photographed side of ${nameOf(object.id)} facing the other object (my chosen face)` }));
    ruleOrder.value = `${objects[0]?.id}|${objects[1]?.id}`;
    const ruleConfirm = el('input', { type: 'checkbox' });
    const ruleSave = el('button', { type: 'button', textContent: 'Save this rule' });
    const ruleRemove = el('button', { type: 'button', className: 'secondary', textContent: 'Remove the rule' });
    const ruleMessage = el('p', { className: 'form-message', role: 'alert' });

    const toDegrees = (radians) => Math.round((radians * 180) / Math.PI);
    const ruleText = (rule) => ruleWords(rule, nameOf);
    const check = (arrangement, rule = arrangement.relationship) => (relations ? relations.checkRelationship(arrangement, pivots, rule) : null);
    const orderText = (arrangement) => {
      if (composition) {
        const [a, b] = arrangement.objects;
        if (a.position[0] === b.position[0]) return `${nameOf(a.id)} and ${nameOf(b.id)} are level on owner X.`;
        const [left, right] = a.position[0] < b.position[0] ? [a, b] : [b, a];
        return `In the owner composition frame, ${nameOf(left.id)} is left of ${nameOf(right.id)}.`;
      }
      if (!relations) return 'Order from the original photo: not available.';
      const { positions } = check(arrangement, null);
      const [a, b] = objects.map((object) => positions?.[object.id]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Order from the original photo: unavailable, because an object’s centre is not in front of the original camera.';
      if (a === b) return `From the original photo, ${nameOf(objects[0].id)} and ${nameOf(objects[1].id)} are level.`;
      const [left, right] = a < b ? [objects[0], objects[1]] : [objects[1], objects[0]];
      return `From the original photo, ${nameOf(left.id)} is left of ${nameOf(right.id)}.`;
    };
    const breaks = (arrangement) => {
      const rule = session.saved.relationship;
      if (!rule || !relations) return null;
      const result = check(arrangement, rule);
      return result.ok ? null : result.reason;
    };

    function renderEvidence() {
      regionLinksPanel?.dispose();
      regionLinksPanel = null;
      memoryLinkPanel?.dispose();
      memoryLinkPanel = null;
      // Its sources: the photo box, linked photo regions and the written memory.
      evidenceSummary.textContent = selected ? `Sources for ${nameOf(selected)}` : 'Sources (choose an object)';
      if (!selected) {
        evidence.replaceChildren(el('p', { className: 'hint', textContent: 'Choose an object to see its sources: the box you drew for it in the photo, and any photo regions or written memory you linked to it.' }));
        return;
      }
      const object = objects.find((entry) => entry.id === selected);
      const sourcePhoto = photoFor(selected);
      evidence.replaceChildren(
        el('p', { className: 'hint', textContent: composition ? `Source photo ${sourcePhoto.number} for ${nameOf(selected)}. This photographed surface retains the source depth estimate; its pose and relative scale are owner assumptions.` : `Photo evidence for ${nameOf(selected)}: the box you drew. The outline inside it is the model’s proposal.` }),
        el('div', { className: 'anchor-frame' }, [el('img', { src: sourcePhoto.url, alt: `Photo ${sourcePhoto.number} with the box for ${nameOf(selected)}` }), boxOver(object)]),
      );
      const links = el('div');
      evidence.append(links);
      regionLinksPanel = mountRegionLinks(links, {
        draftId: draft.id,
        jobUrl,
        objectId: selected,
        name: nameOf(selected),
        letter: letterOf(selected).toLowerCase(),
        photos: draft.photos,
        sourceFor,
        scenePhoto: { ...sourcePhoto, box: object.box },
      });
      const memory = el('div');
      evidence.append(memory);
      memoryLinkPanel = mountMemoryLink(memory, { jobUrl, draftId: draft.id, jobId, objectId: selected, name: nameOf(selected) });
      evidence.append(otherStatements(selected));
    }

    // Deliberate jumps to this object's statements in the panels that already
    // list them; nothing is copied here. A jump belongs to this scene, this
    // object and the latest press, so a late answer changes nothing elsewhere.
    let jumpSeq = 0;
    function otherStatements(id) {
      const jump = (panel) => {
        const mine = ++jumpSeq;
        const lifetime = selectionGen;
        panel?.revealForObject(id, () => !disposed && token === panelGeneration && selected === id && selectionGen === lifetime && jumpSeq === mine);
      };
      const name = nameOf(id);
      return el('section', { className: 'object-statements' }, [
        el('h4', { textContent: `Other statements about ${name}` }),
        el('div', { className: 'actions' }, [
          el('button', { type: 'button', className: 'secondary', textContent: `Saved proposals for ${name}`, onclick: () => jump(memoryEdit) }),
          el('button', { type: 'button', className: 'secondary', textContent: `Recollections used for ${name}`, onclick: () => jump(collaborationPanel) }),
          el('button', { type: 'button', className: 'secondary', textContent: `Recorded stories about ${name}`, onclick: () => jump(storiesPanel) }),
        ]),
      ]);
    }

    function showEdit() {
      shown = proposalPreview ?? (showingSaved ? session.saved : session.preview);
      viewer?.applyArrangement(shown);
      const target = selected ? objectState(session.preview, selected) : null;
      if (target) {
        (composition ? poseValues(target) : [...target.offset, toDegrees(target.yaw)]).forEach((value, i) => {
          // The field being typed keeps its raw text until an explicit action.
          if (controls[i].range !== typing) controls[i].range.value = String(value);
          if (controls[i].number !== typing && !invalid.has(controls[i].number)) controls[i].number.value = String(value);
        });
      }
      const dirty = session.isDirty();
      const locked = lockedBy.size > 0;
      const busy = saving || reloading || locked || ruleSaving || ruleUncertain;
      const ruleBreak = dirty ? breaks(session.preview) : null;
      const { version } = session.saved;
      editStatus.textContent = saving
        ? 'Saving…'
        : ruleSaving
          ? 'Saving the rule…'
          : ruleUncertain && !reloading
            ? `Rehere could not confirm whether the rule change was saved; the saved arrangement may be newer than version ${version}. Retry the rule change or load the saved version to check.`
        : reloading
          ? 'Loading the saved version…'
          : conflict
            ? `The saved arrangement changed since version ${version}. Load the saved version before saving again.`
            : session.uncertain
              ? `Rehere could not confirm whether your last change was saved; the saved arrangement may be newer than version ${version}. Load the saved version to check.`
              : locked
                ? `Manual changes are paused while a memory proposal or a recollection is shown or saved. The saved arrangement is version ${version}.`
                : !selected
                ? `Saved, version ${version}. Choose an object to move.`
                : dirty
                  ? `Preview only: ${nameOf(selected)} moved. Not saved yet; the saved arrangement is version ${version}.`
                  : `Saved, version ${version}.`;
      editMessage.textContent = ruleBreak ? `This change would break your rule (${ruleText(session.saved.relationship)}), so it cannot be saved.` : editMessage.textContent;
      save.disabled = busy || conflict || !dirty || !selected || Boolean(ruleBreak) || invalid.size > 0 || (facingPreview && !faceConfirm.checked);
      face.disabled = busy || !selected || showingSaved || invalid.size > 0;
      revert.disabled = busy || (!dirty && invalid.size === 0);
      reset.disabled = busy || !selected;
      for (const control of controls) control.range.disabled = control.number.disabled = busy || !selected || showingSaved;
      reload.hidden = !(session.uncertain || conflict);
      // Loading the saved version settles an unknown rule outcome, so only a
      // pending request or another holder blocks it.
      reload.disabled = saving || reloading || locked || ruleSaving;
      const sideTarget = cameraTarget();
      photoSide.button.textContent = sideTarget ? `See photographed side of ${nameOf(sideTarget)}` : 'See photographed side (choose an object first)';
      photoSide.button.disabled = !viewer || !sideTarget;
      toggle.textContent = showingSaved ? 'Show your preview' : 'Show saved arrangement';
      toggle.disabled = !dirty && !showingSaved;
      pick.forEach((button, i) => button.setAttribute('aria-pressed', String(objects[i].id === selected)));
      // Describes what the view actually draws, named by the same choice that
      // picked it; an unsaved change that is not drawn is listed as such.
      const shownLabel = proposalPreview
        ? 'a preview from the memory or recollection panel, not saved'
        : !showingSaved && dirty
          ? 'your unsaved change'
          : 'the saved arrangement';
      strip.replaceChildren(
        el('p', { className: 'hint', textContent: composition ? 'An aid, not proof: centre order on owner X, independent of the viewing camera. This is an assumed layout.' : 'An aid, not proof: the left–right order of the two visible centres as seen from the original camera.' }),
        el('p', { textContent: `Saved: ${orderText(session.saved)}` }),
        el('p', { textContent: `Shown now, ${shownLabel}: ${orderText(shown)}` }),
        ...(dirty && (proposalPreview || showingSaved) ? [el('p', { textContent: `Your unsaved change (not shown): ${orderText(session.preview)}` })] : []),
      );
      const rule = session.saved.relationship;
      ruleState.textContent = `Current rule: ${ruleText(rule)}. ${rule ? composition ? 'It constrains the owner-assumed layout; it is not a measurement or solid collision check.' : 'It compares where the visible centres appear from the original camera; it does not detect collisions or measure distances.' : ''}`.trim();
      const clean = !dirty && invalid.size === 0 && !session.uncertain && !conflict && !busy;
      ruleSave.textContent = ruleUncertain ? 'Retry the earlier rule change' : 'Save this rule';
      ruleSave.disabled = ruleUncertain ? ruleSaving || reloading : !clean || ruleConfirm.checked !== true;
      ruleRemove.disabled = ruleUncertain || !clean || !rule || ruleConfirm.checked !== true;
      ruleOrder.disabled = ruleSaving || ruleUncertain;
      memoryEdit?.sync();
      collaborationPanel?.sync();
    }

    function select(id) {
      if (id === selected) return;
      if (lockedBy.size > 0) {
        editMessage.textContent = 'Finish or close the memory proposal or recollection preview first.';
        return;
      }
      if (invalid.size > 0 || session.isDirty() || session.uncertain || conflict || saving || reloading || ruleSaving || ruleUncertain) {
        editMessage.textContent = `Save or revert your change to ${nameOf(selected)} first.`;
        return;
      }
      stopAll();
      typing = null;
      invalid.clear();
      facingPreview = false; faceConfirm.checked = false;
      selected = id;
      // Each change of selection is a new lifetime for jumps started before it.
      selectionGen += 1;
      editMessage.textContent = '';
      renderEvidence();
      showEdit();
    }

    // One edited axis applied to the chosen object's exact current geometry;
    // untouched axes are never read back from rounded fields or snapped sliders.
    const withAxis = (geometry, i, raw) => {
      if (composition) return poseWithAxis(geometry, i, raw);
      const edit = { offset: [...geometry.offset], yaw: geometry.yaw };
      const value = Number(raw);
      if (i < 3) edit.offset[i] = value;
      else edit.yaw = (value * Math.PI) / 180;
      return edit;
    };
    // Leaving a field shows its parsed value; a draft that is not a valid
    // value stays as typed, with its message, and keeps blocking saves.
    // One field's text checked against the rest of the chosen object's preview.
    const axisProblem = (i, raw) => {
      const target = objectState(session.preview, selected);
      if (composition) { const pose = poseWithAxis(target, i, raw); return pose ? poseProblem(pose) : 'Enter an angle between -180 and 180 degrees.'; }
      const values = [...target.offset, (target.yaw * 180) / Math.PI];
      values[i] = raw.trim() === '' ? NaN : Number(raw);
      return editProblem({ offset: values.slice(0, 3), yaw: (values[3] * Math.PI) / 180 });
    };
    const leaveField = (node) => {
      if (typing !== node || invalid.has(node)) return;
      typing = null;
      showEdit();
    };
    // Never save behind an invalid field; otherwise the chosen object's exact previewed candidate.
    const visibleProblem = () => firstInvalid() ?? (selected ? (composition ? poseProblem : editProblem)(objectState(session.preview, selected)) : null);
    for (const control of controls) {
      for (const source of ['range', 'number']) {
        control[source].addEventListener('input', () => {
          collaborationPanel?.noteViewIntent();
          if (!selected) return;
          if (composition) { facingPreview = false; faceConfirm.checked = false; viewer?.showGuide(null, null); }
          const node = control[source];
          typing = node;
          // A slider sets its axis outright; a number field is checked on its own.
          if (source === 'range') invalid.delete(control.number);
          else {
            const own = axisProblem(controls.indexOf(control), node.value);
            if (own) invalid.set(node, own);
            else invalid.delete(node);
          }
          // Only a valid edited field changes the preview, and only its own
          // axis; every other axis keeps its exact previewed value, and an
          // invalid field keeps its axis until the field itself is fixed.
          const edit = invalid.has(node) ? null : withAxis(objectState(session.preview, selected), controls.indexOf(control), node.value);
          const editIssue = edit && (composition ? poseProblem : editProblem)(edit);
          editMessage.textContent = firstInvalid() ?? editIssue ?? '';
          if (edit && !editIssue) session.setPreview(selected, edit);
          showEdit();
        });
        control[source].addEventListener('blur', () => leaveField(control[source]));
      }
    }
    toggle.addEventListener('click', () => {
      collaborationPanel?.noteViewIntent();
      showingSaved = !showingSaved;
      showEdit();
    });
    // The object and transform drawn now, from what is shown, not the session.
    photoSide.button.addEventListener('click', () => {
      const id = cameraTarget();
      if (!viewer || !id) return;
      photoSide.status.textContent = viewer.viewPhotographedSide(objectState(shown, id), id) ? SIDE_MOVED(nameOf(id)) : SIDE_OUTSIDE;
    });
    revert.addEventListener('click', () => {
      collaborationPanel?.noteViewIntent();
      typing = null;
      invalid.clear();
      facingPreview = false; faceConfirm.checked = false;
      session.revert();
      showingSaved = false;
      editMessage.textContent = '';
      showEdit();
    });
    reset.addEventListener('click', () => {
      collaborationPanel?.noteViewIntent();
      if (!selected) return;
      typing = null;
      invalid.clear();
      facingPreview = false; faceConfirm.checked = false;
      session.resetObject(selected);
      showingSaved = false;
      editMessage.textContent = '';
      showEdit();
    });
    reload.addEventListener('click', async () => {
      if (saving || reloading || ruleSaving) return;
      reloading = true;
      showEdit();
      const latest = await request(jobUrl);
      if (disposed || token !== panelGeneration) return;
      reloading = false;
      if (!latest.ok || !Array.isArray(latest.body?.edit?.objects)) {
        editMessage.textContent = 'The saved arrangement could not be loaded. Try again.';
        showEdit();
        return;
      }
      if (latest.body.usageBlocked) {
        openScene(jobId);
        return;
      }
      facingPreview = false; faceConfirm.checked = false;
      session.replaceSaved(latest.body.edit);
      conflict = false;
      typing = null;
      invalid.clear();
      ruleAttempt = null;
      ruleUncertain = false;
      refreshPanels();
      editMessage.textContent = 'Loaded the saved arrangement. Your unsaved preview was replaced.';
      showEdit();
    });
    save.addEventListener('click', async () => {
      if (saving || reloading || conflict || !selected || (facingPreview && !faceConfirm.checked)) return;
      if (visibleProblem()) {
        editMessage.textContent = visibleProblem();
        showEdit();
        return;
      }
      if (breaks(session.preview)) return;
      const held = surfaces.problem(session.preview);
      if (held) {
        editMessage.textContent = `${held} The saved arrangement is still version ${session.saved.version}; your preview is kept.`;
        showEdit();
        return;
      }
      const body = session.saveRequest(selected);
      saving = true;
      editMessage.textContent = '';
      showEdit();
      const result = await postJson(`${jobUrl}/edit`, body);
      if (disposed || token !== panelGeneration) return;
      saving = false;
      if (result.ok && Number.isInteger(result.body?.version) && Array.isArray(result.body?.objects)) {
        facingPreview = false; faceConfirm.checked = false;
        session.confirm(result.body);
        conflict = false;
        showingSaved = false;
        refreshPanels();
      } else if (result.status === 409) {
        editMessage.textContent = `${serverError(result, 'The saved arrangement changed.')} Your preview is kept but not saved.`;
        conflict = true;
      } else if (result.status === 0 || result.status >= 500 || result.ok) {
        session.markUncertain();
        editMessage.textContent = 'Rehere could not confirm the save. Your preview is kept and marked unsaved.';
      } else {
        editMessage.textContent = `${serverError(result, 'The change could not be saved.')} Your preview is kept but not saved.`;
      }
      showEdit();
    });

    async function saveRule(relationship) {
      // A rule change saves the saved arrangement again as a new version.
      const held = surfaces.problem(session.saved);
      if (held) {
        ruleMessage.textContent = `${held} The rule and the saved arrangement (version ${session.saved.version}) are unchanged.`;
        return;
      }
      const input = { baseVersion: session.saved.version, relationship };
      // An unknown earlier outcome is retried exactly, whatever the form shows now.
      if (!ruleUncertain && (!ruleAttempt || JSON.stringify(ruleAttempt.input) !== JSON.stringify(input))) ruleAttempt = { input, body: { requestId: crypto.randomUUID(), ...input, confirmed: true } };
      const sent = ruleAttempt;
      ruleSaving = true;
      showEdit();
      const result = await postJson(`${jobUrl}/relationship`, sent.body);
      if (disposed || token !== panelGeneration) return;
      ruleSaving = false;
      if (result.status === 0 || result.status >= 500) {
        ruleUncertain = true;
        session.markUncertain();
        ruleMessage.textContent = `${serverError(result, '')} Rehere could not confirm the rule change. Retrying repeats the same request; nothing else can change until it is confirmed or the saved version is loaded.`.trim();
        showEdit();
        return;
      }
      ruleAttempt = null;
      ruleUncertain = false;
      relationship = sent.input.relationship;
      ruleConfirm.checked = false;
      if (!result.ok || !Array.isArray(result.body?.objects)) {
        ruleMessage.textContent = `${serverError(result, 'The rule could not be saved.')} The saved arrangement is unchanged.`;
        if (result.status === 409) conflict = true;
        else if (session.uncertain) session.replaceSaved(session.saved);
        showEdit();
        return;
      }
      // Editing was paused while the rule was pending, so nothing newer is lost.
      session.replaceSaved(result.body);
      refreshPanels();
      ruleMessage.textContent = relationship ? `Saved as version ${result.body.version}: ${ruleText(relationship)}.` : `Rule removed in version ${result.body.version}.`;
      showEdit();
    }
    ruleConfirm.addEventListener('change', () => showEdit());
    ruleSave.addEventListener('click', () => {
      if (ruleSaving) return;
      if (ruleUncertain) {
        saveRule(ruleAttempt.input.relationship);
        return;
      }
      if (invalid.size > 0) return;
      const [leftId, rightId] = ruleOrder.value.split('|');
      const relationship = leftId === 'faces' ? { kind: 'faces', subjectId: rightId, targetId: objects.find((object) => object.id !== rightId).id, frame: 'owner-composition', frontBasis: 'owner-confirmed-photographed-side' } : { kind: 'left_of', leftId, rightId, frame: composition ? 'owner-composition' : 'original-photo' };
      const result = check(session.saved, relationship);
      if (result && !result.ok) {
        ruleMessage.textContent =
          result.reason === 'invalid'
            ? 'Choose which object stays left of the other.'
            : `The saved arrangement does not meet this rule now (${['facing', 'direction'].includes(result.reason) ? 'the chosen photographed side does not have a usable direction toward the other object' : result.reason === 'front' ? 'an object’s centre is not in front of the original camera' : 'the order is the other way'}), so it cannot be saved.`;
        return;
      }
      saveRule(relationship);
    });
    ruleRemove.addEventListener('click', () => invalid.size === 0 && !ruleSaving && !ruleUncertain && saveRule(null));

    panel.append(
      nextActions(memorySection, collaborationSection, sharesSection),
      sceneWorkspace(stage, [
        el('div', { className: 'actions', role: 'group' }, [el('span', { textContent: 'Object: ' }), ...pick]),
        el('fieldset', { className: 'space-edit' }, [
          el('legend', { textContent: 'Move the chosen object' }),
          el('p', { className: 'hint', textContent: composition ? 'Only the chosen object’s pose or relative scale changes. The other object and any fixed observed context stay as saved. Values use the owner composition axes, not either photo’s camera. Changes are a preview until saved.' : 'Only the chosen object moves; the other object and the background stay as saved. Changes are a preview until you apply and save them.' }),
          el('p', { className: 'hint', textContent: composition ? SURFACE_SCOPE.replace('seen in the photo', 'seen in their source photos') : SURFACE_SCOPE }),
          ...(composition ? [face, el('label', {}, [faceConfirm, ' I choose the photographed side as the face to point. This is my judgment, not an automatic front.'])] : []),
          ...controls.map(({ name, range, number: field }) => el('div', { className: 'space-axis' }, [el('span', { textContent: name }), range, field])),
          el('div', { className: 'actions' }, [toggle]),
          editStatus,
          editMessage,
          el('div', { className: 'actions' }, [reload, reset, revert, save]),
        ]),
        strip,
        el('fieldset', { className: 'space-edit' }, [
          el('legend', { textContent: 'Rule between the two objects' }),
          ruleState,
          el('label', {}, ['Rule ', ruleOrder]),
          el('label', { className: 'memory-consent' }, [ruleConfirm, composition ? ' I want this rule. For a facing rule, I choose the photographed side as the face to point; this does not identify an automatic semantic front.' : ' I want to change the rule; this saves a new version of the arrangement']),
          el('div', { className: 'actions' }, [ruleRemove, ruleSave]),
          ruleMessage,
        ]),
        // The memory panel, with any face-anchor point and its confirmation,
        // stays open; only the general photo evidence can be collapsed.
        memorySection,
        evidenceBox,
        collaborationSection,
        storiesSection,
        sharesSection,
      ]),
    );
    mountObjectPanels();
    renderEvidence();
    showEdit();
    if (await mountViewer()) showEdit();

    function refreshPanels() {
      memoryEdit?.refresh();
      collaborationPanel?.refresh();
      sharesPanel?.refresh();
      storiesPanel?.refresh();
    }

    // The panels see the selected object's saved transform as the editor, and
    // whatever they preview is drawn as a whole arrangement: a target
    // transform replaces only its object in the saved arrangement.
    function mountObjectPanels() {
      const names = objectNames(objects);
      const targets = {
        selected: () => selected,
        nameOf: names,
        labelOf: (id) => objects.find((object) => object.id === id)?.label ?? null,
        describe: (arrangement) => describeArrangement(arrangement, names),
        ruleText: (rule) => ruleWords(rule, names),
        anchorRegion([u, v]) {
          const column = Math.round(u * (surface.width - 1));
          const row = Math.round(v * (surface.height - 1));
          return surface.regions?.[row * surface.width + column] ?? null;
        },
      };
      const asArrangement = (transform) => !transform ? null : transform.objects ? transform : withObject(session.saved, transform.targetId, composition && transform.pose ? { ...transform.pose, scale: objectState(session.saved, transform.targetId).scale } : transform);
      // editor(targetId) reads that object's saved transform (a plan's own
      // object); with no argument, the selected one. The version is global.
      const editorFor = (name) => (targetId) => {
        const saved = session.saved;
        const id = targetId === undefined ? selected : targetId;
        const target = id ? objectState(saved, id) : null;
        return {
          version: saved.version,
          ...(composition ? { frame: 'owner-composition', ...(target ? copyPose(target) : {}), arrangement: saved } : { offset: target ? target.offset : [0, 0, 0], yaw: target ? target.yaw : 0 }),
          relationship: saved.relationship,
          clean: !ruleSaving && !ruleUncertain && invalid.size === 0 && !session.isDirty() && !session.uncertain && !conflict && !saving && !reloading && ![...lockedBy].some((holder) => holder !== name),
        };
      };
      const lockFor = (name) => (value) => {
        if (value) lockedBy.add(name);
        else lockedBy.delete(name);
        showEdit();
      };
      const savedFrom = (others) => (edit) => {
        session.replaceSaved(edit);
        conflict = false;
        editMessage.textContent = '';
        showEdit();
        for (const other of others()) other?.refresh();
      };
      const unconfirmed = () => {
        session.markUncertain();
        showEdit();
      };
      const conflicted = () => {
        conflict = true;
        showEdit();
      };
      // The photographed-surface check for what an action would save: a whole
      // arrangement, or one object's transform over the saved arrangement.
      const surfaceProblem = (candidate) => surfaces.problem(asArrangement(candidate));
      memoryEdit = mountMemoryEdit(memorySection, {
        jobUrl,
        textureUrl: composition ? null : texture,
        ...(composition ? { representation: job.representation, geometrySources: (job.sourceBindings ?? []).map((binding) => sourceFor(binding.sourceId)) } : { source: sourceFor(job.sourceId) }),
        editor: editorFor('memory'),
        targets,
        showTransform(transform, point = null, targetId = null) {
          collaborationPanel?.noteViewIntent();
          proposalPreview = transform ? asArrangement({ targetId, ...transform }) : null;
          previewTarget = transform ? targetId : null;
          showEdit();
          return viewer ? viewer.showGuide(transform, point, targetId) : null;
        },
        setLocked: lockFor('memory'),
        surfaceProblem,
        saved: savedFrom(() => [collaborationPanel, sharesPanel, storiesPanel]),
        unconfirmed,
        conflict: conflicted,
      });
      collaborationPanel = mountCollaboration(collaborationSection, {
        jobUrl,
        // New alternatives or recollections change story and sharing choices.
        onChanged: () => { sharesPanel?.refreshOptions(); storiesPanel?.refresh(); },
        editor: editorFor('collaboration'),
        memoryTextureUrl: composition ? null : texture,
        memorySources: composition ? (job.sourceBindings ?? []).map((binding) => sourceFor(binding.sourceId)) : [sourceFor(job.sourceId)],
        revisionGuide: (transform, point, targetId) => viewer?.showGuide(transform, point, targetId) ?? null,
        targets,
        showTransform(transform) {
          proposalPreview = asArrangement(transform);
          previewTarget = transform?.targetId ?? null;
          showEdit();
          viewer?.showGuide(null, null);
          return Boolean(viewer && transform);
        },
        setLocked: lockFor('collaboration'),
        surfaceProblem,
        revisionProblem(candidate) {
          const relation = check(candidate, candidate.relationship);
          if (!relation) return 'The retained relationship could not be checked, so this revision cannot be saved.';
          if (!relation.ok) return 'This revision would break the parent alternative’s retained relationship rule. The parent and current scene are unchanged.';
          return surfaces.problem(candidate);
        },
        blocked() {
          if (disposed || token !== panelGeneration) return;
          openScene(jobId);
        },
        saved: savedFrom(() => [memoryEdit, sharesPanel, storiesPanel]),
        unconfirmed,
        conflict: conflicted,
      });
      storiesPanel = mountStories(storiesSection, {
        jobUrl,
        sources: Array.isArray(draft.sources) ? draft.sources : [],
        editor: () => session.saved,
        durationHintMs,
        objects: objects.map((object) => ({ id: object.id, name: names(object.id) })),
        onChanged: () => sharesPanel?.refreshOptions(),
      });
      sharesPanel = mountShares(sharesSection, {
        sharesUrl: `${jobUrl}/shares`,
        jobUrl,
        editor: () => session.saved,
        getCamera: () => viewer?.getCamera() ?? null,
      });
    }
  }

  loadJobs();
  if (sceneId !== null) openScene(sceneId);
  return {
    setPlace(draftId, place) {
      if (disposed || draftId !== draft.id) return;
      currentPlace = place;
      showPlaceHeading();
    },
    dispose() {
      disposed = true;
      stopPolling();
      closePanel();
      invitations.dispose();
    },
  };
}
