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
import { createViewer } from './scene-viewer.js';
import { mountShares } from './shares.js';
import { mountStories } from './stories.js';

const POLL_MS = 2000;
const SOURCE_BLOCKED_TEXT = 'Its photo is no longer allowed to be used for reconstructing this place, or its use was stopped. Every saved version depends on that photo, so none can be restored. The original photo is kept, not deleted.';
const sourceBlocked = (job) => job.blockedReason === 'source';
const UNCONFIRMED_BUILD = 'Rehere could not confirm whether the build was accepted. Pressing Build again safely repeats the same request.';
const SCENE_NOTE = 'Drag to look around; scroll or pinch to zoom; arrow keys move the view when the scene has focus. Only surfaces visible in the photo exist: dark gaps, hidden areas and the backs of objects are unknown and left empty. Depth is a relative model estimate, not a measurement.';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
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
      item.append(button);
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
      blockedPanel = mountBlockedScene(holder, { jobUrl: `${base}/${jobId}`, currentVersion: job.edit.version, onRestored: () => openScene(jobId) });
      return;
    }
    const surfaceResult = await request(assetUrl(jobId, 'surface.json'));
    if (disposed || token !== panelGeneration) return;
    if (!surfaceResult.ok) {
      heading.textContent = 'This scene could not be opened.';
      return;
    }
    heading.textContent = `Partial scene from photo ${number}`;

    const viewport = el('div', { className: 'space-viewport' });
    const viewMessage = el('p', { className: 'form-message', role: 'alert' });
    const original = el('button', { type: 'button', className: 'secondary', textContent: 'Original viewpoint' });
    const side = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect from the side' });
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

    const toDegrees = (radians) => Math.round((radians * 180) / Math.PI);
    const showEdit = () => {
      const { offset, yaw } = session.preview;
      [...offset, toDegrees(yaw)].forEach((value, i) => {
        controls[i].range.value = String(value);
        controls[i].number.value = String(value);
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
      save.disabled = busy || conflict || !dirty;
      revert.disabled = busy || !dirty;
      reset.disabled = reloading || locked;
      for (const control of controls) control.range.disabled = control.number.disabled = reloading || locked;
      reload.hidden = !(session.uncertain || conflict);
      reload.disabled = busy;
      memoryEdit?.sync();
      collaborationPanel?.sync();
    };
    const readControls = (source) => {
      const values = controls.map((control) => (control[source].value.trim() === '' ? NaN : Number(control[source].value)));
      return { offset: values.slice(0, 3), yaw: (values[3] * Math.PI) / 180 };
    };
    for (const control of controls) {
      for (const source of ['range', 'number']) {
        control[source].addEventListener('input', () => {
          const edit = readControls(source);
          const problem = editProblem(edit);
          editMessage.textContent = problem ?? '';
          if (problem) return;
          session.setPreview(edit);
          showEdit();
        });
      }
    }
    revert.addEventListener('click', () => {
      session.revert();
      editMessage.textContent = '';
      showEdit();
    });
    reset.addEventListener('click', () => {
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
      editMessage.textContent = 'Loaded the saved version. Your unsaved preview was replaced.';
      showEdit();
      memoryEdit?.refresh();
      collaborationPanel?.refresh();
    });
    save.addEventListener('click', async () => {
      if (saving || reloading || conflict) return;
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
      el('div', { className: 'actions space-camera' }, [original, side]),
      viewport,
      viewMessage,
      el('p', { className: 'hint', textContent: SCENE_NOTE }),
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
    );
    const editorFor = (name) => () => ({
      ...session.saved,
      clean: !session.isDirty() && !session.uncertain && !conflict && !saving && !reloading && ![...lockedBy].some((holder) => holder !== name),
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
    original.addEventListener('click', () => viewer?.originalView());
    side.addEventListener('click', () => viewer?.sideView());
    showEdit();
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
