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

const POLL_MS = 2000;
const SOURCE_BLOCKED_TEXT = 'Its photo is no longer allowed to be used for reconstructing this place, or its use was stopped. Every saved version depends on that photo, so none can be restored. The original photo is kept, not deleted.';
const sourceBlocked = (job) => job.blockedReason === 'source';
const UNCONFIRMED_BUILD = 'Rehere could not confirm whether the build was accepted. Pressing Build again safely repeats the same request.';
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
export function mountSpace(container, { draft, sourceFor, durationHintMs = () => null }) {
  let disposed = false;
  let pollTimer = null;
  let pollingJob = null;
  let viewer = null;
  let memoryEdit = null;
  let collaborationPanel = null;
  let sharesPanel = null;
  let storiesPanel = null;
  let blockedPanel = null;
  // Bumped whenever the panel is closed or replaced; a response for an older
  // selection or scene must not change the panel that replaced it.
  let panelGeneration = 0;
  const base = `/api/drafts/${draft.id}/reconstructions`;
  const assetUrl = (jobId, name) => `${base}/${jobId}/assets/${encodeURIComponent(name)}`;
  const photoAsset = (photo) => `/api/drafts/${draft.id}/assets/${encodeURIComponent(photo.name)}`;
  const photoNumber = (sourceId) => draft.photos.findIndex((photo) => photo.sourceId === sourceId) + 1;

  const status = el('p', { className: 'hint', role: 'status' });
  status.setAttribute('aria-live', 'polite');
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

  container.replaceChildren(
    el('h2', { textContent: 'Partial scenes' }),
    el('p', {
      className: 'hint',
      textContent:
        'A partial scene turns one photo into the surfaces visible in it, so you can look around them. You choose an object in front; a local model proposes its outline and the depth. It does not add what the photo did not show, and it does not confirm what the place was like.',
    }),
    choices,
    status,
    buildList,
    invitationsSection,
    panel,
  );
  const invitations = mountInvitations(invitationsSection, { draftId: draft.id });

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollingJob = null;
  }

  function closePanel() {
    panelGeneration += 1;
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
    viewer?.dispose();
    viewer = null;
    panel.replaceChildren();
  }

  function renderJobs(jobs) {
    buildList.replaceChildren(
      ...jobs.map((job) => {
        const number = photoNumber(job.sourceId);
        const when = new Date(job.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        const item = el('li', {}, [
          el('span', { className: 'space-choice-label', textContent: `${number ? `Photo ${number}` : 'A photo no longer shown'} · ${when}` }),
          el('span', { className: 'hint', textContent: jobStatusText(job) }),
        ]);
        if (job.status === 'ready' && job.usageBlocked) {
          item.append(el('span', { className: 'hint', textContent: 'Not shown: it depends on a withdrawn recollection or a use that is no longer allowed.' }));
        }
        if (job.status === 'ready') {
          const open = el('button', { type: 'button', className: 'secondary', textContent: 'Open scene' });
          open.setAttribute('aria-label', `Open the partial scene from photo ${number} built ${when}`);
          open.addEventListener('click', () => openScene(job.id));
          item.append(open);
        }
        return item;
      }),
    );
  }

  async function loadJobs({ resumePolling = true } = {}) {
    const result = await request(base);
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      status.textContent = 'Saved partial scenes could not be loaded. Reload the page to try again.';
      return;
    }
    renderJobs(result.body);
    const active = result.body.find((job) => ACTIVE_STATUSES.has(job.status));
    if (resumePolling && active && pollingJob !== active.id) poll(active.id);
  }

  // Polls one job at a time; a newer poll or navigation drops older responses.
  function poll(jobId) {
    stopPolling();
    pollingJob = jobId;
    const tick = async () => {
      const result = await request(`${base}/${jobId}`);
      if (disposed || pollingJob !== jobId) return;
      if (result.ok && result.body) {
        status.textContent = `Photo ${photoNumber(result.body.sourceId)}: ${jobStatusText(result.body)}`;
        if (!ACTIVE_STATUSES.has(result.body.status)) {
          stopPolling();
          // Do not restart polling from a list that may lag this response.
          await loadJobs({ resumePolling: false });
          return;
        }
      } else if (result.status === 404) {
        stopPolling();
        status.textContent = 'This build could not be found.';
        return;
      } else {
        status.textContent = 'Checking the build again…';
      }
      pollTimer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  function openSelection(photo, index) {
    closePanel();
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
        // The person moved on; an accepted job still appears in the list.
        if (accepted) await loadJobs();
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
      status.textContent = `Photo ${index + 1}: ${jobStatusText(result.body)}`;
      await loadJobs();
      if (ACTIVE_STATUSES.has(result.body.status)) poll(result.body.id);
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
    const jobResult = await request(`${base}/${jobId}`);
    if (disposed || token !== panelGeneration) return;
    const job = jobResult.body;
    if (!jobResult.ok || job?.status !== 'ready') {
      heading.textContent = 'This scene could not be opened.';
      return;
    }
    const number = photoNumber(job.sourceId);
    // A scene whose current version depends on a withdrawn recollection is not
    // loaded at all; only restoring an unaffected saved version is offered.
    // Every version depends on the photo, so a stopped or no-longer-allowed photo
    // leaves nothing to restore.
    if (job.usageBlocked && sourceBlocked(job)) {
      heading.textContent = 'This scene is no longer shown';
      panel.append(el('p', { textContent: SOURCE_BLOCKED_TEXT }));
      return;
    }
    if (job.usageBlocked) {
      heading.textContent = `Partial scene from photo ${number} is blocked`;
      const holder = el('div');
      panel.append(holder);
      const names = Array.isArray(job.edit?.objects) ? objectNames(job.objects) : null;
      blockedPanel = mountBlockedScene(holder, {
        jobUrl: `${base}/${jobId}`,
        currentVersion: job.edit.version,
        onRestored: () => openScene(jobId),
        ...(names ? { describe: (entry) => describeArrangement(entry, names), ruleText: (rule) => ruleWords(rule, names), currentRule: job.edit.relationship ?? null } : {}),
      });
      return;
    }
    const surfaceResult = await request(assetUrl(jobId, 'surface.json'));
    if (disposed || token !== panelGeneration) return;
    if (!surfaceResult.ok) {
      heading.textContent = 'This scene could not be opened.';
      return;
    }
    heading.textContent = `Partial scene from photo ${number}`;
    if (surfaceResult.body?.schema_version === 2) {
      await openObjectScene({ job, jobId, surface: surfaceResult.body, token, heading, number });
      return;
    }

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
      photoSide.button.disabled = !viewer;
      memoryEdit?.sync();
      collaborationPanel?.sync();
    };
    const readControls = (source) => {
      const values = controls.map((control) => (control[source].value.trim() === '' ? NaN : Number(control[source].value)));
      return { offset: values.slice(0, 3), yaw: (values[3] * Math.PI) / 180 };
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
    // Save only what the fields show: never a cached preview behind an invalid field.
    const visibleProblem = () => firstInvalid() ?? editProblem(readControls('number'));
    for (const control of controls) {
      for (const source of ['range', 'number']) {
        control[source].addEventListener('input', () => {
          const node = control[source];
          typing = node;
          // A slider sets its axis outright; a number field is checked on its own.
          if (source === 'range') invalid.delete(control.number);
          else {
            const own = axisProblem(controls.indexOf(control), node.value);
            if (own) invalid.set(node, own);
            else invalid.delete(node);
          }
          // Valid fields keep updating the preview; an invalid field's axis
          // keeps its previewed value until the field itself is fixed.
          const edit = readControls(source);
          const kept = session.preview;
          controls.forEach((other, i) => {
            if (!invalid.has(other.number)) return;
            if (i < 3) edit.offset[i] = kept.offset[i];
            else edit.yaw = kept.yaw;
          });
          const editIssue = editProblem(edit);
          editMessage.textContent = firstInvalid() ?? editIssue ?? '';
          if (!editIssue) session.setPreview(edit);
          showEdit();
        });
        control[source].addEventListener('blur', () => leaveField(control[source]));
      }
    }
    revert.addEventListener('click', () => {
      typing = null;
      invalid.clear();
      session.revert();
      editMessage.textContent = '';
      showEdit();
    });
    reset.addEventListener('click', () => {
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

    panel.replaceChildren(
      heading,
      sceneWorkspace(
        [el('div', { className: 'actions space-camera' }, [explore.button, original, side, photoSide.button]), explore.status, photoSide.status, viewport, viewMessage, ...photoCredit(job), el('p', { className: 'hint', textContent: SCENE_NOTE })],
        [
          el('fieldset', { className: 'space-edit' }, [
            el('legend', { textContent: 'Move the selected object' }),
            el('p', { className: 'hint', textContent: 'Changes are a preview until you apply and save them. Moving the object leaves an empty gap where it was; nothing is generated to fill it.' }),
            ...controls.map(({ name, range, number }) => el('div', { className: 'space-axis' }, [el('span', { textContent: name }), range, number])),
            editStatus,
            editMessage,
            el('div', { className: 'actions' }, [reload, reset, revert, save]),
          ]),
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
      source: sourceFor(job.sourceId),
      editor: editorFor('memory'),
      // Returns the shown facing relation for a face-anchor point, or null when
      // there is no 3D view to show it in.
      showTransform(transform, point = null) {
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
      editor: editorFor('collaboration'),
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
        if (accepted) await loadJobs();
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
      status.textContent = `Photo ${index + 1}: ${jobStatusText(result.body)}`;
      await loadJobs();
      if (ACTIVE_STATUSES.has(result.body.status)) poll(result.body.id);
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
    const objects = Array.isArray(job.objects) ? job.objects : [];
    const letterOf = (id) => (objects.findIndex((object) => object.id === id) === 0 ? 'A' : 'B');
    const nameOf = (id) => `${letterOf(id)}: ${objects.find((object) => object.id === id)?.label ?? ''}`;
    const pivots = objects.map(({ id, pivot }) => ({ id, pivot }));
    const viewport = el('div', { className: 'space-viewport' });
    const badges = el('div', { className: 'object-badges' });
    badges.setAttribute('aria-hidden', 'true');
    const viewMessage = el('p', { className: 'form-message', role: 'alert' });
    const original = el('button', { type: 'button', className: 'secondary', textContent: 'Original viewpoint' });
    const photoSide = photographedSideControls();
    const side = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect from the side' });
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
    const [imageWidth, imageHeight] = surface.source.image_size;
    const boxOver = (object) => {
      const [x1, y1, x2, y2] = object.box;
      const box = el('div', { className: `box-overlay box-overlay-${letterOf(object.id).toLowerCase()}` }, [el('span', { className: 'box-badge', textContent: nameOf(object.id) })]);
      Object.assign(box.style, { left: `${(x1 / imageWidth) * 100}%`, top: `${(y1 / imageHeight) * 100}%`, width: `${((x2 - x1) / imageWidth) * 100}%`, height: `${((y2 - y1) / imageHeight) * 100}%` });
      return box;
    };

    async function mountViewer() {
      let created = null;
      try {
        created = await createViewer(viewport, surface, assetUrl(jobId, 'texture.jpg'), `3D partial scene with two objects from photo ${number}`, { onDraw: drawBadges });
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
    const stage = [el('div', { className: 'actions space-camera' }, [explore.button, original, side, photoSide.button]), explore.status, photoSide.status, el('div', { className: 'space-viewport-wrap' }, [viewport, badges]), viewMessage, ...photoCredit(job), el('p', { className: 'hint', textContent: SCENE_NOTE })];

    if (!job.objectsConfirmed) {
      // No object can be chosen before the outlines are confirmed.
      photoSide.button.hidden = true;
      let confirmId = null;
      const message = el('p', { className: 'form-message', role: 'alert' });
      const confirm = el('button', { type: 'button', textContent: 'The outlines match A and B' });
      const mismatch = el('button', { type: 'button', className: 'secondary', textContent: 'They do not match' });
      confirm.addEventListener('click', async () => {
        confirmId ??= crypto.randomUUID();
        confirm.disabled = true;
        const result = await postJson(`${jobUrl}/objects/confirm`, { requestId: confirmId, objectIds: objects.map((object) => object.id) });
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
      mismatch.addEventListener('click', () => {
        message.textContent = 'This build stays as it is and cannot be edited, planned, shared or given stories. Build again with different boxes to get new outlines.';
      });
      panel.append(
        sceneWorkspace(stage, [
          el('section', { className: 'memory-edit object-confirm' }, [
            el('h4', { textContent: 'Check the two outlines' }),
            el('p', { className: 'hint', textContent: 'The model proposed these outlines inside your boxes. Nothing can be edited, planned, shared or given a story until you confirm they match the objects you named.' }),
            el('div', { className: 'anchor-frame' }, [el('img', { src: assetUrl(jobId, 'mask-overlay.jpg'), alt: `Photo ${number} with the two proposed outlines tinted` }), ...objects.map(boxOver)]),
            el('ul', { className: 'hint' }, [
              ...objects.map((object) => el('li', { textContent: `${nameOf(object.id)}: the tinted area inside box ${letterOf(object.id)}.` })),
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

    const session = createArrangementSession(job.edit, () => crypto.randomUUID());
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
    const axes = [
      ['Left / right', OFFSET_LIMIT, 0.01],
      ['Down / up', OFFSET_LIMIT, 0.01],
      ['Away / toward', OFFSET_LIMIT, 0.01],
      ['Turn (degrees)', 180, 1],
    ];
    const controls = axes.map(([name, limit, step]) => {
      const range = el('input', { type: 'range', min: -limit, max: limit, step });
      const field = el('input', { type: 'number', min: -limit, max: limit, step });
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
    const reset = el('button', { type: 'button', className: 'secondary', textContent: 'Reset object position' });
    const reload = el('button', { type: 'button', className: 'secondary', textContent: 'Load saved version', hidden: true });
    const toggle = el('button', { type: 'button', className: 'secondary', textContent: 'Show saved arrangement' });
    const strip = el('div', { className: 'relation-strip' });
    const evidence = el('div', { className: 'object-evidence' });
    const evidenceSummary = el('summary');
    const evidenceBox = el('details', { className: 'source-details' }, [evidenceSummary, evidence]);
    const ruleState = el('p', { className: 'hint' });
    const ruleOrder = el('select');
    for (const [leftId, rightId] of [[objects[0]?.id, objects[1]?.id], [objects[1]?.id, objects[0]?.id]]) {
      ruleOrder.append(el('option', { value: `${leftId}|${rightId}`, textContent: `Keep ${nameOf(leftId)} left of ${nameOf(rightId)}` }));
    }
    ruleOrder.value = `${objects[0]?.id}|${objects[1]?.id}`;
    const ruleConfirm = el('input', { type: 'checkbox' });
    const ruleSave = el('button', { type: 'button', textContent: 'Save this rule' });
    const ruleRemove = el('button', { type: 'button', className: 'secondary', textContent: 'Remove the rule' });
    const ruleMessage = el('p', { className: 'form-message', role: 'alert' });

    const toDegrees = (radians) => Math.round((radians * 180) / Math.PI);
    const ruleText = (rule) => (rule ? `${nameOf(rule.leftId)} stays left of ${nameOf(rule.rightId)} from the original photo` : 'No rule');
    const check = (arrangement, rule = arrangement.relationship) => (relations ? relations.checkRelationship(arrangement, pivots, rule) : null);
    const orderText = (arrangement) => {
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
      evidenceSummary.textContent = selected ? `Photo evidence for ${nameOf(selected)}` : 'Photo evidence (choose an object)';
      if (!selected) {
        evidence.replaceChildren(el('p', { className: 'hint', textContent: 'Choose an object to see the box you drew for it in the photo.' }));
        return;
      }
      const object = objects.find((entry) => entry.id === selected);
      evidence.replaceChildren(
        el('p', { className: 'hint', textContent: `Photo evidence for ${nameOf(selected)}: the box you drew. The outline inside it is the model’s proposal.` }),
        el('div', { className: 'anchor-frame' }, [el('img', { src: assetUrl(jobId, 'texture.jpg'), alt: `Photo ${number} with the box for ${nameOf(selected)}` }), boxOver(object)]),
      );
    }

    function showEdit() {
      shown = proposalPreview ?? (showingSaved ? session.saved : session.preview);
      viewer?.applyArrangement(shown);
      const target = selected ? objectState(session.preview, selected) : null;
      if (target) {
        [...target.offset, toDegrees(target.yaw)].forEach((value, i) => {
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
      save.disabled = busy || conflict || !dirty || !selected || Boolean(ruleBreak) || invalid.size > 0;
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
        el('p', { className: 'hint', textContent: 'An aid, not proof: the left–right order of the two visible centres as seen from the original camera.' }),
        el('p', { textContent: `Saved: ${orderText(session.saved)}` }),
        el('p', { textContent: `Shown now, ${shownLabel}: ${orderText(shown)}` }),
        ...(dirty && (proposalPreview || showingSaved) ? [el('p', { textContent: `Your unsaved change (not shown): ${orderText(session.preview)}` })] : []),
      );
      const rule = session.saved.relationship;
      ruleState.textContent = `Current rule: ${ruleText(rule)}. ${rule ? 'It compares where the visible centres appear from the original camera; it does not detect collisions or measure distances.' : ''}`.trim();
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
      selected = id;
      editMessage.textContent = '';
      renderEvidence();
      showEdit();
    }

    const readControls = (source) => {
      const values = controls.map((control) => (control[source].value.trim() === '' ? NaN : Number(control[source].value)));
      return { offset: values.slice(0, 3), yaw: (values[3] * Math.PI) / 180 };
    };
    // Leaving a field shows its parsed value; a draft that is not a valid
    // value stays as typed, with its message, and keeps blocking saves.
    // One field's text checked against the rest of the chosen object's preview.
    const axisProblem = (i, raw) => {
      const target = objectState(session.preview, selected);
      const values = [...target.offset, (target.yaw * 180) / Math.PI];
      values[i] = raw.trim() === '' ? NaN : Number(raw);
      return editProblem({ offset: values.slice(0, 3), yaw: (values[3] * Math.PI) / 180 });
    };
    const leaveField = (node) => {
      if (typing !== node || invalid.has(node)) return;
      typing = null;
      showEdit();
    };
    // Save only what the fields show: never a cached preview behind an invalid field.
    const visibleProblem = () => firstInvalid() ?? editProblem(readControls('number'));
    for (const control of controls) {
      for (const source of ['range', 'number']) {
        control[source].addEventListener('input', () => {
          if (!selected) return;
          const node = control[source];
          typing = node;
          // A slider sets its axis outright; a number field is checked on its own.
          if (source === 'range') invalid.delete(control.number);
          else {
            const own = axisProblem(controls.indexOf(control), node.value);
            if (own) invalid.set(node, own);
            else invalid.delete(node);
          }
          // Valid fields keep updating the preview; an invalid field's axis
          // keeps its previewed value until the field itself is fixed.
          const edit = readControls(source);
          const kept = objectState(session.preview, selected);
          controls.forEach((other, i) => {
            if (!invalid.has(other.number)) return;
            if (i < 3) edit.offset[i] = kept.offset[i];
            else edit.yaw = kept.yaw;
          });
          const editIssue = editProblem(edit);
          editMessage.textContent = firstInvalid() ?? editIssue ?? '';
          if (!editIssue) session.setPreview(selected, edit);
          showEdit();
        });
        control[source].addEventListener('blur', () => leaveField(control[source]));
      }
    }
    toggle.addEventListener('click', () => {
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
      typing = null;
      invalid.clear();
      session.revert();
      showingSaved = false;
      editMessage.textContent = '';
      showEdit();
    });
    reset.addEventListener('click', () => {
      if (!selected) return;
      typing = null;
      invalid.clear();
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
      if (saving || reloading || conflict || !selected) return;
      if (visibleProblem()) {
        editMessage.textContent = visibleProblem();
        showEdit();
        return;
      }
      if (breaks(session.preview)) return;
      const body = session.saveRequest(selected);
      saving = true;
      editMessage.textContent = '';
      showEdit();
      const result = await postJson(`${jobUrl}/edit`, body);
      if (disposed || token !== panelGeneration) return;
      saving = false;
      if (result.ok && Number.isInteger(result.body?.version) && Array.isArray(result.body?.objects)) {
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
      const relationship = { kind: 'left_of', leftId, rightId, frame: 'original-photo' };
      const result = check(session.saved, relationship);
      if (result && !result.ok) {
        ruleMessage.textContent =
          result.reason === 'invalid'
            ? 'Choose which object stays left of the other.'
            : `The saved arrangement does not meet this rule now (${result.reason === 'front' ? 'an object’s centre is not in front of the original camera' : 'the order is the other way'}), so it cannot be saved.`;
        return;
      }
      saveRule(relationship);
    });
    ruleRemove.addEventListener('click', () => invalid.size === 0 && !ruleSaving && !ruleUncertain && saveRule(null));

    panel.append(
      sceneWorkspace(stage, [
        el('div', { className: 'actions', role: 'group' }, [el('span', { textContent: 'Object: ' }), ...pick]),
        el('fieldset', { className: 'space-edit' }, [
          el('legend', { textContent: 'Move the chosen object' }),
          el('p', { className: 'hint', textContent: 'Only the chosen object moves; the other object and the background stay as saved. Changes are a preview until you apply and save them.' }),
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
          el('label', { className: 'memory-consent' }, [ruleConfirm, ' I want to change the rule; this saves a new version of the arrangement']),
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
        describe: (arrangement) => describeArrangement(arrangement, names),
        ruleText: (rule) => ruleWords(rule, names),
        anchorRegion([u, v]) {
          const column = Math.round(u * (surface.width - 1));
          const row = Math.round(v * (surface.height - 1));
          return surface.regions?.[row * surface.width + column] ?? null;
        },
      };
      const asArrangement = (transform) => (!transform ? null : transform.objects ? transform : withObject(session.saved, transform.targetId, transform));
      // editor(targetId) reads that object's saved transform (a plan's own
      // object); with no argument, the selected one. The version is global.
      const editorFor = (name) => (targetId) => {
        const saved = session.saved;
        const id = targetId === undefined ? selected : targetId;
        const target = id ? objectState(saved, id) : null;
        return {
          version: saved.version,
          offset: target ? target.offset : [0, 0, 0],
          yaw: target ? target.yaw : 0,
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
      memoryEdit = mountMemoryEdit(memorySection, {
        jobUrl,
        textureUrl: assetUrl(jobId, 'texture.jpg'),
        source: sourceFor(job.sourceId),
        editor: editorFor('memory'),
        targets,
        showTransform(transform, point = null, targetId = null) {
          proposalPreview = transform ? asArrangement({ targetId, ...transform }) : null;
          previewTarget = transform ? targetId : null;
          showEdit();
          return viewer ? viewer.showGuide(transform, point, targetId) : null;
        },
        setLocked: lockFor('memory'),
        saved: savedFrom(() => [collaborationPanel, sharesPanel, storiesPanel]),
        unconfirmed,
        conflict: conflicted,
      });
      collaborationPanel = mountCollaboration(collaborationSection, {
        jobUrl,
        editor: editorFor('collaboration'),
        targets,
        showTransform(transform) {
          proposalPreview = asArrangement(transform);
          previewTarget = transform?.targetId ?? null;
          showEdit();
          viewer?.showGuide(null, null);
          return Boolean(viewer && transform);
        },
        setLocked: lockFor('collaboration'),
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
  return {
    dispose() {
      disposed = true;
      stopPolling();
      closePanel();
      invitations.dispose();
    },
  };
}
