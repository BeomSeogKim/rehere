import { mountAccess } from './access-ui.js';
import { mountContributor } from './collaboration.js';
import { registerElement, stopAll } from './playback.js';
import { isStopped, mountSourceControls, renderStoppedMarker } from './source-controls.js';
import {
  canonicalPlaceName,
  createIntakeSession,
  detailsFromSourceInput,
  identify,
  intakeApi,
  isOpenState,
  isTerminalState,
  pendingIds,
  placeNameProblem,
  planFrom,
  sha256Hex,
} from './intake.js';
import { latestOnly } from './latest.js';
import { MAX_RECORDING_MS, createRecorder } from './recorder.js';
import {
  buildMetadata,
  createSourceDetails,
  createVoiceSource,
  detailsProblem,
  renderSavedSource,
  renderPhotoUses,
  renderSourceControls,
} from './source-details.js';

const MIB = 1024 * 1024;
const PHOTO_LIMIT = 20;
const PHOTO_BYTES = 20 * MIB;
const REQUEST_BYTES = 64 * MIB;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png']);
// Finishing a recording normally takes well under a second; this bounds a stuck recorder.
const FINALIZE_TIMEOUT_MS = 10_000;
const KEPT = 'Nothing was saved, and your photos, writing and recording are still here.';

const $ = (id) => document.getElementById(id);
const els = {
  access: $('access'),
  visit: $('visit'),
  ownerApp: $('owner-app'),
  compose: $('compose'),
  form: $('draft-form'),
  placeName: $('place-name'),
  addPhotos: $('add-photos'),
  photoInput: $('photo-input'),
  photoList: $('photo-list'),
  text: $('memory-text'),
  textSource: $('text-source'),
  textCount: $('text-count'),
  voiceStatus: $('voice-status'),
  record: $('record'),
  stop: $('stop'),
  discard: $('discard'),
  preview: $('voice-preview'),
  voiceSource: $('voice-source'),
  message: $('form-message'),
  save: $('save'),
  saveWithoutVoice: $('save-without-voice'),
  viewer: $('viewer'),
  viewerTitle: $('viewer-title'),
  viewerDate: $('viewer-date'),
  viewerPlaceName: $('viewer-place-name'),
  viewerMessage: $('viewer-message'),
  viewerPhotos: $('viewer-photos'),
  viewerText: $('viewer-text'),
  viewerTextSource: $('viewer-text-source'),
  viewerVoice: $('viewer-voice'),
  viewerVoiceSource: $('viewer-voice-source'),
  viewerSpace: $('viewer-space'),
  viewerMaterials: $('viewer-materials'),
  savedEmpty: $('saved-empty'),
  savedList: $('saved-list'),
  intakeResume: $('intake-resume'),
  intakeStatus: $('intake-status'),
  inputPanels: [$('name-panel'), $('photos-panel'), $('text-panel'), $('voice-panel')],
};

// Each photo object owns its source details, so they follow the photo when
// others are added or removed.
const photos = [];
let textSource = { details: createSourceDetails(), state: {} };
const viewRequests = latestOnly();
// The saved list: only the most recently started read may replace it, so an
// older read cannot bring back a name a newer one already shows.
const listRequests = latestOnly();
let space = null;
let spaceGeneration = 0;
let saving = false;
let previewBlob = null;
let ticker = null;
// Private content loads only while an owner session is active. Each sign-out
// bumps the generation so responses started before it are dropped.
let ownerActive = false;
// True while a visit link is shown instead of the app.
let visiting = false;
let sessionGeneration = 0;
const stillOwner = (generation) => ownerActive && generation === sessionGeneration;

// The unfinished save the form belongs to, if any, and what it needs: the
// owner's API with a signal that sign-out aborts, opaque pending IDs, the
// recording's identity, a lost recording, and the source input a restored
// written memory had on the server.
let ownerId = null;
let intakeAbort = null;
let intake = null;
let voiceItem = null;
let lostVoice = null;
let textKeptInput = null;
let resumeButtons = [];
let offerButtons = [];
// True while a chosen unfinished save is being loaded: the form, Save and
// every other offer wait, so a restore never overwrites newer work.
let restoring = false;
// Reading localStorage itself can throw (blocked storage); then no IDs are
// kept in the browser and the server's list of open intakes is the fallback.
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
const intakeIds = () => pendingIds(browserStorage(), ownerId);
const newIntake = () => createIntakeSession({ api: intakeApi(globalThis.fetch.bind(globalThis), intakeAbort?.signal), ids: intakeIds() });

const recorder = createRecorder({
  mediaDevices: navigator.mediaDevices,
  MediaRecorder: window.MediaRecorder,
});

function setMessage(content, kind = 'error') {
  els.message.replaceChildren(...(content ? [content] : []));
  els.message.className = `form-message${content ? ` is-${kind}` : ''}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderPhotos() {
  els.photoList.replaceChildren(
    ...photos.map((photo, index) => {
      const item = document.createElement('li');
      const frame = document.createElement('div');
      frame.className = 'photo-frame';
      const image = photo.missing ? missingSlot(photo, index) : document.createElement('img');
      if (!photo.missing) {
        image.src = photo.url;
        image.alt = `Selected photo ${index + 1}`;
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.addEventListener('click', () => {
        if (photo.url) URL.revokeObjectURL(photo.url);
        photos.splice(photos.indexOf(photo), 1);
        renderPhotos();
        els.addPhotos.focus();
      });
      frame.append(image, remove);
      // The whole list is rebuilt together, so ids by position stay unique.
      const usesId = `photo-uses-${index + 1}`;
      const uses = renderPhotoUses(document, photo.details, usesId);
      item.append(frame, uses.element, renderSourceControls(document, { ...photo, label: `photo ${index + 1}`, onChange: uses.refresh, describedBy: usesId }));
      return item;
    }),
  );
  updateResumeLabels();
}

// A restored photo whose bytes never reached Rehere. Choosing the same file
// again (same size and SHA-256) keeps its part and source settings; any other
// file is a new photo whose uses start off.
function missingSlot(photo, index) {
  const slot = document.createElement('div');
  slot.className = 'photo-missing';
  const note = document.createElement('p');
  note.className = 'hint';
  // Cause-neutral: the row above says whether it was never received or failed a check.
  note.textContent = `Photo ${index + 1}${photo.hints?.name ? ` (${photo.hints.name})` : ''} is not in this form. Choose the file again, or remove it.`;
  const choose = document.createElement('input');
  choose.type = 'file';
  choose.accept = 'image/jpeg,image/png';
  choose.setAttribute('aria-label', `Choose photo ${index + 1} again`);
  choose.addEventListener('change', async () => {
    const [file] = choose.files ?? [];
    if (!file) return;
    const generation = sessionGeneration;
    const same = file.size === photo.size && (await sha256Hex(file)) === photo.sha256;
    if (!stillOwner(generation) || !photos.includes(photo)) return;
    if (same) {
      Object.assign(photo, { file, url: URL.createObjectURL(file), missing: false, identity: { file, partId: photo.partId } });
      setMessage('');
    } else {
      photos.splice(photos.indexOf(photo), 1, { kind: 'photo', file, url: URL.createObjectURL(file), details: createSourceDetails(), state: {} });
      setMessage('That is a different file, so it is added as a new photo and its source settings start with no uses allowed.');
    }
    renderPhotos();
  });
  slot.append(note, choose);
  return slot;
}

function renderTextSource() {
  els.textSource.replaceChildren(renderSourceControls(document, { ...textSource, label: 'the written memory' }));
}

function renderVoiceSource() {
  els.voiceSource.replaceChildren(renderSourceControls(document, { ...voiceSource.current, label: 'the voice recording' }));
}

const voiceSource = createVoiceSource(recorder, renderVoiceSource);

function addPhotos(files) {
  const skipped = [];
  for (const file of files) {
    if (photos.length >= PHOTO_LIMIT) skipped.push(`${file.name} (the limit is ${PHOTO_LIMIT} photos)`);
    else if (!PHOTO_TYPES.has(file.type)) skipped.push(`${file.name} (only JPEG or PNG)`);
    else if (file.size > PHOTO_BYTES) skipped.push(`${file.name} (larger than 20 MB)`);
    else photos.push({ kind: 'photo', file, url: URL.createObjectURL(file), details: createSourceDetails(), state: {} });
  }
  renderPhotos();
  setMessage(skipped.length ? `Some photos were not added: ${skipped.join(', ')}.` : '');
}

function renderVoice() {
  const { state, message, recording, startedAt } = recorder.snapshot();
  const statusText = {
    unavailable: message,
    idle: 'Tell this memory in your own voice. Recording starts only when you press Record and stops on its own just before five minutes.',
    requesting: 'Waiting for microphone permission. You can still save photos and writing.',
    recording: `Recording ${formatTime(Date.now() - (startedAt ?? Date.now()))} of ${formatTime(MAX_RECORDING_MS)}; it stops on its own before five minutes`,
    finalizing: 'Finishing the recording...',
    recorded: 'Recording ready. Listen back before saving, or discard it.',
    denied: message,
    error: message,
  }[state];
  els.voiceStatus.textContent = statusText;
  els.voiceStatus.classList.toggle('is-recording', state === 'recording');

  els.record.hidden = !['idle', 'denied', 'error', 'unavailable'].includes(state);
  els.record.disabled = state === 'unavailable';
  els.record.textContent = state === 'denied' || state === 'error' ? 'Try again' : 'Record';
  els.stop.hidden = state !== 'recording';
  els.discard.hidden = !['requesting', 'recording', 'finalizing', 'recorded'].includes(state);
  els.discard.textContent = state === 'requesting' ? 'Cancel' : 'Discard recording';

  if (recording !== previewBlob) {
    if (els.preview.src) URL.revokeObjectURL(els.preview.src);
    previewBlob = recording;
    if (recording) els.preview.src = URL.createObjectURL(recording);
    else els.preview.removeAttribute('src');
  }
  els.preview.hidden = !recording;
  els.voiceSource.hidden = !['recording', 'finalizing', 'recorded'].includes(state);

  if (state === 'recording' && !ticker) ticker = setInterval(renderVoice, 500);
  if (state !== 'recording' && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  renderActions();
  updateResumeLabels();
}

function renderActions() {
  const { state } = recorder.snapshot();
  const capturing = state === 'recording' || state === 'finalizing';
  els.save.textContent = capturing ? 'Stop and save' : state === 'requesting' ? 'Save without voice' : 'Save';
  els.saveWithoutVoice.hidden = !capturing;
  els.form.inert = saving || restoring;
  els.form.setAttribute('aria-busy', String(saving || restoring));
  updateResumeLabels();
  // While an outcome is unknown only Save, which checks it, stays usable.
  for (const panel of els.inputPanels) panel.inert = Boolean(intake?.pending);
}

function timeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function collectVoice(includeVoice) {
  if (!includeVoice) return { voice: null };
  const { state, recording } = recorder.snapshot();
  if (state === 'recorded') return { voice: recording };
  if (state !== 'recording' && state !== 'finalizing') return { voice: null };
  const voice = await timeout(recorder.stop(), FINALIZE_TIMEOUT_MS);
  return voice ? { voice } : { failed: true };
}

function resetForm() {
  for (const photo of photos) URL.revokeObjectURL(photo.url);
  photos.length = 0;
  renderPhotos();
  els.placeName.value = '';
  els.text.value = '';
  els.textCount.textContent = '0';
  textSource = { details: createSourceDetails(), state: {} };
  textKeptInput = null;
  renderTextSource();
  recorder.discard();
  intake = null;
  voiceItem = null;
  lostVoice = null;
  renderIntake();
}

function sourceProblem(voice) {
  const items = photos.map((photo, index) => [`photo ${index + 1}`, photo.details]);
  if (els.text.value.trim()) items.push(['the written memory', textSource.details]);
  if (voice) items.push(['the voice recording', voiceSource.current.details]);
  for (const [label, details] of items) {
    const problem = detailsProblem(details);
    if (problem) return `Source details for ${label} ${problem}.`;
  }
  return null;
}

// hasPhoto: true only when the saved input is known to have held a photo; a
// scene can then be built from it. The link is navigation only.
function savedNotice(id, hasPhoto = false) {
  const fragment = document.createDocumentFragment();
  const link = document.createElement('a');
  link.href = `#/memories/${id}`;
  link.textContent = hasPhoto ? 'Continue to building this place' : 'View what you saved';
  fragment.append('Saved. ', link);
  return fragment;
}

async function save(includeVoice) {
  if (saving || restoring) return;
  saving = true;
  setMessage('');
  renderActions();
  const generation = sessionGeneration;
  try {
    const { voice, failed } = await collectVoice(includeVoice);
    if (!stillOwner(generation)) return;
    if (failed) {
      setMessage('The recording could not be finished. Your photos and writing are still here. Discard the recording to save without it.');
      return;
    }
    const text = els.text.value;
    if (photos.length === 0 && !text.trim() && !voice) {
      setMessage('Add a photo, a written memory or a voice recording before saving.');
      return;
    }
    const nameProblem = placeNameProblem(els.placeName.value);
    if (nameProblem) {
      setMessage(`${nameProblem} ${KEPT}`);
      return;
    }
    const total = photos.reduce((sum, photo) => sum + (photo.file?.size ?? photo.size ?? 0), 0) + (voice?.size ?? 0);
    if (total > REQUEST_BYTES) {
      setMessage('Everything saved at once must total 64 MB or less. Remove a photo or record a shorter message.');
      return;
    }
    const problem = sourceProblem(voice);
    if (problem) {
      setMessage(`${problem} ${KEPT}`);
      return;
    }
    // Every item gets the identity of its exact original before anything is sent.
    voiceItem = voice ? (voiceItem?.file === voice ? voiceItem : { kind: 'voice', file: voice }) : null;
    if (voiceItem) {
      voiceItem.details = voiceSource.current.details;
      // A new take replaces a recording that was lost; nothing is inherited.
      lostVoice = null;
    }
    const recording = voiceItem ?? (includeVoice ? lostVoice : null);
    for (const item of [...photos, ...(recording ? [recording] : [])]) await identify(item);
    if (!stillOwner(generation)) return;
    const intended = planFrom({ text, photos, voice: recording, textDetails: textSource.details, textKeptInput, placeName: canonicalPlaceName(els.placeName.value) });
    const files = new Map([...photos, ...(recording ? [recording] : [])].filter((item) => item.file).map((item) => [item.partId, item.file]));
    intake ??= newIntake();
    const session = intake;
    const outcome = await session.save(intended, files, renderIntake);
    if (!stillOwner(generation) || session !== intake) return;
    settleIntake(outcome, intended.parts.some((part) => part.kind === 'photo'));
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  } finally {
    // Only the session that started this save may end its lock; a sign-out
    // has already reset it, and a later session's own work stays locked.
    if (generation === sessionGeneration) {
      saving = false;
      renderActions();
      renderIntake();
    }
  }
}

// What the form says after an attempt. Only a final draft ID means Saved.
function settleIntake(outcome, hasPhoto = false) {
  switch (outcome.kind) {
    case 'saved':
      resetForm();
      setMessage(savedNotice(outcome.draftId, hasPhoto), 'success');
      loadSaved();
      break;
    case 'discarded':
      intake = null;
      setMessage('This unfinished save was discarded elsewhere. The form is unchanged; saving again starts a new one.');
      break;
    case 'unknown':
      setMessage('Rehere could not confirm the last step. Nothing in the form was changed. Press Save to check again; it repeats the same request and never starts a second save.');
      break;
    case 'conflict':
      setMessage('This unfinished save was changed in another window, so nothing was overwritten. Reload the page and resume it to continue from what Rehere has.');
      break;
    case 'refused':
      setMessage(`${outcome.message} ${KEPT}`);
      break;
    default: {
      const parts = outcome.state?.parts ?? [];
      const received = parts.filter((part) => part.status === 'received').length;
      const failed = parts.some((part) => part.status === 'failed');
      setMessage(
        failed
          ? `Not saved yet: ${received} of ${parts.length} files reached Rehere. Replace or remove the files marked Failed, then save again; files Rehere already received are kept and not sent again.`
          : `Not saved yet: ${received} of ${parts.length} files reached Rehere. Saving again sends only the files still missing; you can also remove or replace a file first.`,
      );
    }
  }
}

const PART_TEXT = {
  missing: 'Not sent yet',
  sending: 'Sending…',
  received: 'Received by Rehere, not saved yet',
  failed: 'Failed',
  unknown: 'Sending result unclear; it will be checked',
};
// Why the server refused a file for good, and what the person can do. Only the
// server's fixed codes are used; no decoder output is ever shown.
const FAILURES = {
  photo: {
    empty: 'the file is empty. Remove it and add the photo again',
    size: 'the file changed while it was sent. Remove it and add it again',
    hash: 'the file changed while it was sent. Remove it and add it again',
    type: 'it is not a JPEG or PNG photo. Remove it and add a JPEG or PNG copy',
    content: 'Rehere could not read this photo. Remove it and add a JPEG or 8-bit PNG copy',
    pixels: 'the photo is larger than 32 megapixels. Remove it and add a smaller copy',
  },
  voice: {
    empty: 'the recording is empty. Discard it and record again',
    size: 'the recording changed while it was sent. Discard it and record again',
    hash: 'the recording changed while it was sent. Discard it and record again',
    type: 'it is not a supported recording type. Discard it and record again',
    content: 'Rehere could not read this recording. Discard it and record again',
    duration: 'the recording is longer than five minutes. Discard it and record a shorter one',
  },
};

// Per-file progress of the unfinished save, from the server's own record.
function renderIntake() {
  const state = intake?.state;
  if (!state) {
    els.intakeStatus.replaceChildren();
    return;
  }
  let photoNumber = 0;
  const list = document.createElement('ul');
  for (const part of state.parts) {
    const row = intake.row(part.partId);
    const item = document.createElement('li');
    const label = part.kind === 'voice' ? 'The recording' : `Photo ${(photoNumber += 1)}`;
    const failure = row.status === 'failed' ? `: ${FAILURES[part.kind]?.[part.error] ?? 'it could not be stored'}` : '';
    // A busy or unavailable check left the file unsent; its fixed message is
    // kept here until the next attempt.
    const notice = row.status === 'missing' && row.notice ? ` (${row.notice.replace(/\.$/, '')}; saving again tries it again)` : '';
    item.textContent = `${label}${part.hints?.name ? ` (${part.hints.name})` : ''}: ${PART_TEXT[row.status] ?? PART_TEXT.missing}${failure}${notice}.`;
    list.append(item);
  }
  const nodes = [list];
  if (lostVoice) {
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'secondary';
    drop.textContent = 'Remove the lost recording';
    drop.addEventListener('click', () => {
      lostVoice = null;
      renderIntake();
    });
    const note = document.createElement('p');
    note.textContent = 'The recording cannot be restored into this form. Remove it, or record a new one; a new recording starts with no uses allowed.';
    nodes.push(note, drop);
  }
  if (!saving && !intake.pending) {
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'secondary';
    discard.textContent = 'Discard this unfinished save';
    discard.addEventListener('click', () => discardIntake(intake));
    nodes.push(discard);
  }
  els.intakeStatus.replaceChildren(...nodes);
}

// Removes the server's copy of an unfinished save. The form keeps its content.
async function discardIntake(session) {
  const generation = sessionGeneration;
  const outcome = await session.discard();
  if (!stillOwner(generation)) return;
  if (outcome.kind === 'saved') {
    if (session === intake) settleIntake(outcome);
    return;
  }
  if (outcome.kind !== 'discarded') {
    setMessage(outcome.kind === 'unknown' ? 'Rehere could not confirm the discard. Try again.' : outcome.message);
    return;
  }
  if (session === intake) {
    intake = null;
    lostVoice = null;
    setMessage('The unfinished save was discarded. Your form is unchanged; saving again starts a new one.', 'success');
  }
  renderIntake();
  offerResume();
}

async function loadSaved() {
  const generation = sessionGeneration;
  const { current, value: drafts } = await listRequests.run(async () => {
    try {
      const response = await fetch('/api/drafts');
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  });
  if (!current) return;
  if (!Array.isArray(drafts)) {
    if (!stillOwner(generation)) return;
    els.savedEmpty.hidden = false;
    els.savedEmpty.textContent = 'Saved memories could not be loaded. Reload the page to try again.';
    return;
  }
  if (!stillOwner(generation)) return;
  els.savedEmpty.hidden = drafts.length > 0;
  els.savedEmpty.textContent = 'Nothing has been saved yet.';
  els.savedList.replaceChildren(
    ...drafts.map((draft) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#/memories/${draft.id}`;
      const name = document.createElement('span');
      name.className = 'saved-name';
      name.textContent = placeLabel(placeOf(draft));
      link.append(name);
      const meta = document.createElement('span');
      meta.className = 'saved-meta';
      const parts = [formatDate(draft.createdAt)];
      if (draft.photoCount) parts.push(`${draft.photoCount} photo${draft.photoCount === 1 ? '' : 's'}`);
      if (draft.hasVoice) parts.push('voice');
      meta.textContent = parts.join(' · ');
      link.append(meta);
      if (draft.textPreview) {
        const preview = document.createElement('span');
        preview.className = 'saved-preview';
        preview.textContent = draft.textPreview;
        link.append(preview);
      }
      item.append(link);
      return item;
    }),
  );
}

// Stops a playing recording and drops its address, so stopped or closed
// material is not heard after it leaves the screen.
function stopViewerVoice() {
  stopAll();
  els.viewerVoice.pause?.();
  els.viewerVoice.removeAttribute('src');
  els.viewerVoice.load?.();
  els.viewerVoice.hidden = true;
}

// Owner controls for each source in the open memory; disposed whenever the
// memory is closed or re-read.
let sourceViews = [];
function disposeSourceViews() {
  for (const view of sourceViews) view.dispose();
  sourceViews = [];
}

// notice: a message to keep showing after the memory is re-read, such as a
// saved restriction and whether work in progress stopped.
// The memory and scene the owner route names. A scene route opens exactly that
// reconstruction; the address is updated only for an explicit choice there.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEMORY_ROUTE = new RegExp(`^#/memories/(${UUID})(?:/scenes/(${UUID}))?$`);
let routeDraft = null;
let routeScene = null;
// The memory whose materials disclosure is shown, so a re-read of the same
// memory keeps it open or closed as the owner left it.
let materialsFor = null;

async function showDraft(id, notice = '', sceneId = null) {
  // Another memory never shows this one's name, not even while loading.
  if (placeView?.draftId !== id) clearPlace();
  // A rename answered while this read was out is newer than what it returns.
  const epoch = placeView?.epoch ?? null;
  disposeSourceViews();
  els.viewerDate.textContent = '';
  els.viewerMessage.textContent = '';
  els.viewerPhotos.replaceChildren();
  els.viewerText.textContent = '';
  els.viewerTextSource.replaceChildren();
  els.viewerVoiceSource.replaceChildren();
  stopViewerVoice();
  els.viewerTitle.tabIndex = -1;
  els.viewerTitle.focus();

  const { current, value: draft } = await viewRequests.run(async () => {
    try {
      const response = await fetch(`/api/drafts/${id}`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  });
  if (!current) return;
  if (!draft) {
    els.viewerMessage.textContent = 'This memory could not be opened.';
    return;
  }
  // A memory without photos opens on its materials; otherwise the scene comes
  // first and the materials stay one press away.
  if (materialsFor !== draft.id) {
    materialsFor = draft.id;
    els.viewerMaterials.open = draft.photos.length === 0;
  }
  const asset = (name) => `/api/drafts/${draft.id}/assets/${encodeURIComponent(name)}`;
  // A re-read of the same memory keeps an open rename and its typed text.
  if (placeView?.draftId !== draft.id) placeView = { draftId: draft.id, place: placeOf(draft), editing: false, value: '', attempt: null, busy: false, message: '', epoch: 0 };
  else if (!placeView.busy && placeView.epoch === epoch) placeView.place = placeOf(draft);
  renderPlace();
  els.viewerDate.textContent = `Saved ${formatDate(draft.createdAt)}`;
  els.viewerMessage.textContent = notice;
  // Drafts saved before source details have no sources; each item then shows
  // an unavailable state with nothing granted.
  const sources = Array.isArray(draft.sources) ? draft.sources : [];
  const source = (id) => sources.find((record) => record.id === id) ?? null;
  // A saved change re-reads the memory, so stopped material disappears and the
  // scene is reopened under the current policy.
  const refresh = (notice) => {
    closeSpace();
    showDraft(draft.id, notice, routeScene);
  };
  const controls = (record, label) => {
    const holder = document.createElement('div');
    if (record && !isStopped(record)) {
      sourceViews.push(
        mountSourceControls(holder, {
          draftId: draft.id,
          sourceId: record.id,
          label,
          knownRevision: record.policy?.revision ?? null,
          onChanged: (policy, message) => refresh(message ? `${label[0].toUpperCase()}${label.slice(1)}: ${message}` : ''),
        }),
      );
    }
    return holder;
  };
  const stoppedPhotos = sources.filter((record) => record.kind === 'photo' && isStopped(record));
  els.viewerPhotos.replaceChildren(
    ...draft.photos.map((photo, index) => {
      const item = document.createElement('li');
      const frame = document.createElement('div');
      frame.className = 'photo-frame';
      const image = document.createElement('img');
      image.src = asset(photo.name);
      image.alt = `Photo ${index + 1}`;
      frame.append(image);
      item.append(frame, renderSavedSource(document, source(photo.sourceId)), controls(source(photo.sourceId), `photo ${index + 1}`));
      return item;
    }),
    ...stoppedPhotos.map((record) => {
      const item = document.createElement('li');
      item.className = 'source-stopped-item';
      item.append(renderStoppedMarker(record));
      return item;
    }),
  );
  els.viewerText.textContent = draft.text;
  const textRecord = source(draft.textSourceId);
  if (isStopped(textRecord)) els.viewerTextSource.append(renderStoppedMarker(textRecord));
  else if (draft.text.trim()) els.viewerTextSource.append(renderSavedSource(document, textRecord), controls(textRecord, 'the written memory'));
  const voiceRecord = draft.voice ? source(draft.voice.sourceId) : sources.find((record) => record.kind === 'voice' && isStopped(record));
  if (draft.voice && !isStopped(voiceRecord)) {
    els.viewerVoice.src = asset(draft.voice.name);
    els.viewerVoice.hidden = false;
    els.viewerVoiceSource.append(renderSavedSource(document, voiceRecord), controls(voiceRecord, 'the voice recording'));
  } else if (isStopped(voiceRecord)) {
    els.viewerVoiceSource.append(renderStoppedMarker(voiceRecord));
  }
  // A scene route mounts the workspace even when every photo is stopped, so
  // that exact reconstruction shows its own state.
  if (draft.photos.length || sceneId) openSpace(draft, source, sceneId);
}

// ------------------------------------------------------------ place names

// The place metadata the server derives for a saved memory. Anything
// unreadable is shown as unavailable, never as unnamed.
function placeOf(record) {
  const place = record?.place;
  const named = place?.name === null || (typeof place?.name === 'string' && place.name !== '');
  if (place?.unavailable === false && named && Number.isInteger(place.revision) && place.revision >= 0) return { name: place.name, revision: place.revision, unavailable: false };
  return { name: null, revision: null, unavailable: true };
}
const placeLabel = (place) => (place.unavailable ? 'Place name unavailable' : place.name ?? 'Unnamed place');
const quotedName = (place) => (place.unavailable ? 'unavailable' : place.name === null ? 'unnamed' : `“${place.name}”`);

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  Object.assign(element, props);
  element.append(...children);
  return element;
}

// The open memory's name and its rename: { draftId, place, editing, value,
// attempt, busy, message, epoch }. attempt is a rename whose answer is not
// known yet; Save repeats it exactly while the typed name is the same. epoch
// counts rename answers applied; a read of the name applies only if none was
// applied since it began. Renaming changes only the heading, this
// region and the saved list, never the scene.
let placeView = null;

function clearPlace() {
  placeView = null;
  els.viewerTitle.textContent = 'Saved memory';
  els.viewerPlaceName.replaceChildren();
}

function renderPlace() {
  const view = placeView;
  if (!view) {
    els.viewerPlaceName.replaceChildren();
    return;
  }
  els.viewerTitle.textContent = placeLabel(view.place);
  const nodes = [];
  if (view.place.unavailable) {
    nodes.push(node('p', { className: 'hint', textContent: 'The name of this place could not be read, so it cannot be changed right now. Its photos, writing and scenes are not affected.' }));
  }
  if (view.editing) {
    const input = node('input', { type: 'text', maxLength: 120, value: view.value, disabled: view.busy, autocomplete: 'off' });
    input.setAttribute('aria-label', 'Place name');
    input.addEventListener('input', () => {
      view.value = input.value;
    });
    const save = node('button', { type: 'button', textContent: 'Save name', disabled: view.busy || view.place.unavailable });
    save.addEventListener('click', saveName);
    const cancel = node('button', { type: 'button', className: 'secondary', textContent: 'Cancel', disabled: view.busy });
    cancel.addEventListener('click', cancelRename);
    nodes.push(
      input,
      node('p', { className: 'hint', textContent: 'Leave it empty to remove the name. Titles of shared views are not changed.' }),
      node('div', { className: 'actions' }, [cancel, save]),
    );
  } else if (!view.place.unavailable) {
    const rename = node('button', { type: 'button', className: 'secondary', textContent: view.place.name === null ? 'Name this place' : 'Rename' });
    rename.addEventListener('click', () => {
      Object.assign(view, { editing: true, value: view.place.name ?? '', message: '' });
      renderPlace();
      els.viewerPlaceName.querySelector?.('input')?.focus();
    });
    nodes.push(node('div', { className: 'actions' }, [rename]));
  }
  if (view.message) nodes.push(node('p', { className: 'hint', role: 'status', textContent: view.message }));
  els.viewerPlaceName.replaceChildren(...nodes);
}

async function placeRequest(url, options) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

// The current name from the server, or null when it cannot be read now.
async function readPlace(draftId) {
  const result = await placeRequest(`/api/drafts/${draftId}`, { cache: 'no-store' });
  return result.ok && result.body?.id === draftId ? placeOf(result.body) : null;
}

async function saveName() {
  const view = placeView;
  if (!view || view.busy || view.place.unavailable) return;
  const problem = placeNameProblem(view.value);
  if (problem) {
    view.message = `${problem} The name was not changed.`;
    renderPlace();
    return;
  }
  const name = canonicalPlaceName(view.value);
  if (view.attempt?.name !== name) view.attempt = { name, body: { requestId: crypto.randomUUID(), baseRevision: view.place.revision, name } };
  const { body } = view.attempt;
  view.busy = true;
  view.message = 'Saving the name…';
  renderPlace();
  const generation = sessionGeneration;
  const result = await placeRequest(`/api/drafts/${view.draftId}/place-name`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!stillOwner(generation) || placeView !== view) return;
  view.busy = false;
  const reason = typeof result.body?.error === 'string' ? result.body.error : '';
  const answered = result.ok && result.body?.draftId === view.draftId && placeOf(result.body).unavailable === false;
  if (answered) {
    // The answer names the current place, which a replay may show renamed since.
    const place = placeOf(result.body);
    view.epoch += 1;
    Object.assign(view, { place, editing: false, value: '', attempt: null });
    view.message =
      place.name !== body.name
        ? `That rename was recorded earlier, and the place has been renamed since. Its name is now ${quotedName(place)}.`
        : result.body.changed === false && result.body.replayed !== true
          ? 'The name was already this, so nothing changed.'
          : 'Name saved.';
    renderPlace();
    loadSaved();
    return;
  }
  if (result.status === 409) {
    // Changed elsewhere: show the current name and keep the typed text. Only
    // a further explicit Save replaces it.
    view.attempt = null;
    view.busy = true;
    renderPlace();
    const current = await readPlace(view.draftId);
    if (!stillOwner(generation) || placeView !== view) return;
    view.busy = false;
    view.epoch += 1;
    if (current) view.place = current;
    view.message = current
      ? `The name was changed elsewhere, so yours was not saved. It is now ${quotedName(current)}. Your text is still here; press Save name to replace it, or Cancel.`
      : `${reason || 'The name was changed elsewhere, so yours was not saved.'} Your text is still here. Reload the page to see the current name.`;
    renderPlace();
    loadSaved();
    return;
  }
  if (result.status === 0 || result.status >= 500 || !reason || result.ok) {
    // No clear answer: it may or may not have been saved.
    view.message = `${reason ? `${reason} ` : ''}Rehere could not confirm the rename. Press Save name to repeat the same request, or Cancel to see the current name.`;
    renderPlace();
    return;
  }
  view.attempt = null;
  view.message = `${reason} The name was not changed.`;
  renderPlace();
}

async function cancelRename() {
  const view = placeView;
  if (!view || view.busy) return;
  const uncertain = Boolean(view.attempt);
  Object.assign(view, { editing: false, value: '', attempt: null, message: '' });
  renderPlace();
  if (!uncertain) return;
  // A rename whose answer never arrived: show what the server holds now.
  const generation = sessionGeneration;
  const epoch = view.epoch;
  const current = await readPlace(view.draftId);
  if (!stillOwner(generation) || placeView !== view || view.editing || view.epoch !== epoch) return;
  if (current) view.place = current;
  else view.message = 'The current name could not be read. Reload the page to see it.';
  renderPlace();
  loadSaved();
}

// The 3D module loads only for a memory with photos; if it cannot load, the
// rest of the memory stays readable.
async function openSpace(draft, source, sceneId = null) {
  const generation = spaceGeneration;
  const session = sessionGeneration;
  // An explicit scene choice names it in the address without a new history
  // entry or a remount; nothing late, closed or from another memory may.
  const onScene = (id) => {
    if (!stillOwner(session) || generation !== spaceGeneration || routeDraft !== draft.id) return;
    // The address must still be the route this workspace was opened for: a
    // newer address typed before its hashchange event wins over a late open.
    const tracked = routeScene ? `#/memories/${routeDraft}/scenes/${routeScene}` : `#/memories/${routeDraft}`;
    if (location.hash !== tracked) return;
    routeScene = id ?? null;
    const next = routeScene ? `#/memories/${draft.id}/scenes/${routeScene}` : `#/memories/${draft.id}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  };
  els.viewerSpace.hidden = false;
  try {
    const module = await import('./space.js');
    if (generation !== spaceGeneration) return;
    // An advisory caption bound from the saved recording's already loaded
    // metadata; the server checks the converted recording itself.
    const durationHintMs = (sourceId) =>
      draft.voice?.sourceId === sourceId && Number.isFinite(els.viewerVoice.duration) ? Math.round(els.viewerVoice.duration * 1000) : null;
    space = module.mountSpace(els.viewerSpace, { draft, sourceFor: source, durationHintMs, sceneId, onScene });
  } catch {
    if (generation !== spaceGeneration) return;
    const message = document.createElement('p');
    message.className = 'hint';
    message.textContent = 'Partial scenes could not be loaded in this browser. The photos, writing and recording are still here.';
    els.viewerSpace.replaceChildren(message);
  }
}

function closeSpace() {
  spaceGeneration += 1;
  space?.dispose();
  space = null;
  els.viewerSpace.replaceChildren();
  els.viewerSpace.hidden = true;
}

function route() {
  if (!ownerActive) return;
  // Parsed strictly before anything is fetched; a malformed memory or scene
  // address opens nothing.
  const memoryLink = location.hash.startsWith('#/memories/');
  const match = MEMORY_ROUTE.exec(location.hash);
  viewRequests.invalidate();
  closeSpace();
  routeDraft = match?.[1] ?? null;
  routeScene = match?.[2] ?? null;
  // A navigation starts the materials disclosure from its default; only a
  // re-read of the same memory keeps the owner's choice.
  materialsFor = null;
  if (!match) {
    stopViewerVoice();
    disposeSourceViews();
    clearPlace();
  }
  els.compose.hidden = memoryLink;
  els.viewer.hidden = !memoryLink;
  if (memoryLink) recorder.leave();
  if (match) showDraft(match[1], '', match[2] ?? null);
  else if (memoryLink) {
    clearViewer();
    els.viewerMessage.textContent = 'This address is not a valid memory or scene link.';
  }
}

els.addPhotos.addEventListener('click', () => els.photoInput.click());
els.photoInput.addEventListener('change', () => {
  addPhotos([...els.photoInput.files]);
  els.photoInput.value = '';
});
els.placeName.addEventListener('input', updateResumeLabels);
els.text.addEventListener('input', () => {
  els.textCount.textContent = els.text.value.length.toLocaleString('en-US');
  updateResumeLabels();
});
els.record.addEventListener('click', () => {
  setMessage('');
  recorder.start();
});
els.stop.addEventListener('click', () => recorder.stop());
els.discard.addEventListener('click', () => recorder.discard());
els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  save(true);
});
els.saveWithoutVoice.addEventListener('click', () => save(false));
window.addEventListener('hashchange', route);

function clearViewer() {
  clearPlace();
  disposeSourceViews();
  els.viewerDate.textContent = '';
  els.viewerMessage.textContent = '';
  els.viewerPhotos.replaceChildren();
  els.viewerText.textContent = '';
  els.viewerTextSource.replaceChildren();
  els.viewerVoiceSource.replaceChildren();
  stopViewerVoice();
}

function startOwner(principal) {
  // A session answer that arrives while a visit is open never starts the app.
  if (visiting) return;
  ownerActive = true;
  ownerId = principal?.id ?? null;
  intakeAbort = new AbortController();
  els.ownerApp.hidden = false;
  route();
  loadSaved();
  offerResume();
}

// Unsent input includes a take in progress: asking for the microphone,
// recording or finishing, as well as a finished recording.
const TAKE_STATES = new Set(['requesting', 'recording', 'finalizing', 'recorded']);
function formHasContent() {
  const { state, recording } = recorder.snapshot();
  return photos.length > 0 || els.placeName.value.trim() !== '' || els.text.value.trim() !== '' || Boolean(recording) || TAKE_STATES.has(state);
}

// After sign-in: settle saves this browser was waiting on, then offer every
// unfinished save the server holds. Nothing is loaded until the person
// chooses Resume, and resuming over unsent input says so on the button.
async function offerResume() {
  const generation = sessionGeneration;
  const api = intakeApi(globalThis.fetch.bind(globalThis), intakeAbort?.signal);
  const ids = intakeIds();
  try {
    const listed = await api.list();
    if (!stillOwner(generation)) return;
    const open = listed.ok && Array.isArray(listed.body) ? listed.body.filter(isOpenState) : [];
    for (const { intakeId } of ids.read()) {
      if (open.some((state) => state.id === intakeId)) continue;
      const result = await api.read(intakeId);
      if (!stillOwner(generation)) return;
      if (result.status === 404 || (isTerminalState(result.body) && result.body.status === 'discarded')) ids.remove(intakeId);
      else if (isTerminalState(result.body) && result.body.status === 'committed') {
        ids.remove(intakeId);
        setMessage(savedNotice(result.body.draftId), 'success');
        loadSaved();
      }
    }
    renderResume(open.filter((state) => state.id !== intake?.intakeId));
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  }
}

// Each Resume button says whether it replaces what the form holds now, and
// follows the form as it changes, so resuming never overwrites it silently.
function updateResumeLabels() {
  for (const button of offerButtons) button.disabled = restoring || saving;
  if (resumeButtons.length === 0) return;
  const replaces = formHasContent();
  for (const button of resumeButtons) button.textContent = replaces ? 'Resume it (replaces what is in the form now)' : 'Resume it';
}

function renderResume(open) {
  resumeButtons = [];
  offerButtons = [];
  els.intakeResume.replaceChildren(
    ...open.map((state) => {
      const received = state.parts.filter((part) => part.status === 'received').length;
      const box = document.createElement('div');
      box.className = 'panel';
      const text = document.createElement('p');
      text.textContent = `An unfinished save from ${formatDate(state.updatedAt ?? state.createdAt)}: ${received} of ${state.parts.length} files reached Rehere. They are kept there, not saved as a memory, until you finish or discard it.`;
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.addEventListener('click', () => resumeIntake(state.id));
      resumeButtons.push(resume);
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'secondary';
      discard.textContent = 'Discard it';
      discard.addEventListener('click', () => {
        const session = newIntake();
        session.resume(state);
        discardIntake(session);
      });
      const later = document.createElement('button');
      later.type = 'button';
      later.className = 'secondary';
      later.textContent = 'Not now';
      later.addEventListener('click', () => box.remove());
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(later, discard, resume);
      offerButtons.push(discard, resume);
      box.append(text, actions);
      return box;
    }),
  );
  updateResumeLabels();
}

// Loads one unfinished save into the form: only parts the server received
// come back as files; the rest are shown as not received. Source settings
// and recorded file dates are kept exactly; a recording never touches the
// microphone or plays.
async function resumeIntake(id) {
  if (saving || restoring) return;
  restoring = true;
  renderActions();
  const generation = sessionGeneration;
  const api = intakeApi(globalThis.fetch.bind(globalThis), intakeAbort?.signal);
  try {
    const read = await api.read(id);
    if (!stillOwner(generation)) return;
    if (!read.ok || !isOpenState(read.body)) {
      if (isTerminalState(read.body) && read.body.status === 'committed') setMessage(savedNotice(read.body.draftId), 'success');
      else if (read.ok || read.status === 404) setMessage('That unfinished save is no longer available.');
      else setMessage('Rehere could not read that unfinished save. Nothing in the form was changed; try again.');
      offerResume();
      return;
    }
    const state = read.body;
    const bytes = new Map();
    for (const part of state.parts) {
      if (part.status !== 'received') continue;
      const blob = await api.partBytes(state.id, part.partId);
      if (!stillOwner(generation)) return;
      if (blob) bytes.set(part.partId, blob);
    }
    // The server's record decides what arrived. If a file it received cannot
    // be downloaded now, nothing is restored and the form is left as it was.
    const received = state.parts.filter((part) => part.status === 'received');
    const unread = received.filter((part) => !bytes.has(part.partId)).length;
    if (unread) {
      setMessage(`Resuming could not finish: ${unread} of the ${received.length} file${received.length === 1 ? '' : 's'} Rehere received could not be downloaded just now. They are still kept by Rehere, and nothing in the form was changed. Try Resume again.`);
      offerResume();
      return;
    }
    resetForm();
    const photoParts = state.parts.filter((part) => part.kind === 'photo');
    photoParts.forEach((part, index) => {
      const input = state.metadata?.photos?.[index];
      const blob = bytes.get(part.partId);
      const lastModified = input?.dates?.fileModifiedAt ? Date.parse(input.dates.fileModifiedAt) : 0;
      const file = blob ? new File([blob], part.hints.name || `photo-${index + 1}`, { type: part.detectedType || part.hints.type || blob.type, lastModified }) : null;
      photos.push({
        kind: 'photo',
        file,
        url: file ? URL.createObjectURL(file) : null,
        missing: !file,
        details: detailsFromSourceInput(input),
        state: {},
        partId: part.partId,
        sha256: part.sha256,
        size: part.size,
        hints: part.hints,
        keptInput: input ?? null,
        identity: file ? { file, partId: part.partId } : null,
      });
    });
    els.placeName.value = state.placeName ?? '';
    els.text.value = state.text;
    els.textCount.textContent = state.text.length.toLocaleString('en-US');
    if (state.metadata?.text) {
      textSource = { details: detailsFromSourceInput(state.metadata.text), state: {} };
      textKeptInput = state.metadata.text;
    }
    const voicePart = state.parts.find((part) => part.kind === 'voice');
    if (voicePart) {
      const blob = bytes.get(voicePart.partId);
      const kept = { partId: voicePart.partId, sha256: voicePart.sha256, size: voicePart.size, hints: voicePart.hints, keptInput: state.metadata?.voice ?? null };
      if (blob && recorder.restore(blob)) {
        Object.assign(voiceSource.current.details, detailsFromSourceInput(state.metadata?.voice));
        voiceItem = { kind: 'voice', file: blob, ...kept, identity: { file: blob, partId: voicePart.partId } };
        renderVoiceSource();
      } else {
        lostVoice = { kind: 'voice', file: null, details: detailsFromSourceInput(state.metadata?.voice), ...kept };
      }
    }
    intake = newIntake();
    intake.resume(state);
    renderPhotos();
    renderTextSource();
    renderVoice();
    renderIntake();
    els.intakeResume.replaceChildren();
    // What the person must do, not why: a part may never have arrived or may
    // have failed a content check; its row says which.
    const reselect = photoParts.filter((part) => part.status !== 'received').length;
    const lostRecording = Boolean(voicePart) && voicePart.status !== 'received';
    const steps = [
      ...(reselect ? [`Choose ${reselect} file${reselect === 1 ? '' : 's'} again or remove ${reselect === 1 ? 'it' : 'them'} before saving.`] : []),
      ...(lostRecording ? ['Remove the recording or record a new one before saving.'] : []),
    ];
    setMessage(steps.length ? `Resumed. ${steps.join(' ')}` : 'Resumed. Press Save to finish saving this memory.', 'success');
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  } finally {
    // As for saving: a sign-out already reset the lock, and a restore from an
    // earlier session never releases a later session's work.
    if (generation === sessionGeneration) {
      restoring = false;
      renderActions();
    }
  }
}

// Removes everything private from the page and stops capture, synchronously,
// before any sign-out request is sent.
function stopOwner() {
  stopAll();
  ownerActive = false;
  sessionGeneration += 1;
  // Late intake answers are aborted and dropped; nothing private stays shown.
  // The busy locks belong to this session and end with it.
  intakeAbort?.abort();
  intakeAbort = null;
  saving = false;
  restoring = false;
  ownerId = null;
  resumeButtons = [];
  offerButtons = [];
  els.intakeResume.replaceChildren();
  viewRequests.invalidate();
  closeSpace();
  routeDraft = null;
  routeScene = null;
  materialsFor = null;
  resetForm();
  renderActions();
  setMessage('');
  clearViewer();
  els.savedList.replaceChildren();
  els.savedEmpty.hidden = false;
  els.savedEmpty.textContent = 'Nothing has been saved yet.';
  els.ownerApp.hidden = true;
  // Only a private memory route is cleared; a visit fragment stays for the visit.
  if (/^#\/memories\//.test(location.hash)) history.replaceState(null, '', location.pathname);
}

const access = mountAccess(els.access, { onOwner: startOwner, onSignedOut: stopOwner, renderContributor: (node, principal) => mountContributor(node, { principal }) });

// Any private request answered 401 means the session expired or was replaced,
// including requests made by the scene and proposal modules.
// Visitor reads use only a visit token; their failures never end an owner's
// session in another part of the page.
const PUBLIC_API = /^\/api\/(session(\/|$)|invitations\/redeem$|visit(\/|$))/;
const baseFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
  // A 401 for a request sent in an earlier session must not end a newer one.
  const sentIn = sessionGeneration;
  const response = await baseFetch(input, options);
  const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
  if (response.status === 401 && sentIn === sessionGeneration && path.startsWith('/api/') && !PUBLIC_API.test(path)) access.sessionEnded();
  return response;
};

// A visit link is recognised before anything private loads: no session check,
// no sign-in and no owner request. The token stays in the fragment, which is
// never sent to the server, and in memory.
const VISIT = /^#\/visit\/(rhv_[A-Za-z0-9_-]{43})$/;
let visitor = null;
let visitModule = null;
// Every entry to or exit from a visit takes a new number; after the module
// import only the latest call may mount, so A -> B -> A mounts once.
let routeGeneration = 0;

async function routeVisit() {
  const mine = ++routeGeneration;
  const match = VISIT.exec(location.hash);
  if (!match) {
    if (!visiting) return false;
    // Leaving a visit removes it completely before the normal app starts.
    stopAll();
    visiting = false;
    visitor?.dispose();
    visitor = null;
    els.visit.hidden = true;
    els.access.hidden = false;
    access.start();
    return false;
  }
  visiting = true;
  stopAll();
  // Drops any pending session or sign-in answer and any contributor screen, so
  // nothing private starts or stays while the visit is shown.
  access.suspend();
  if (ownerActive) stopOwner();
  visitor?.dispose();
  visitor = null;
  els.access.hidden = true;
  els.ownerApp.hidden = true;
  els.visit.hidden = false;
  const token = match[1];
  visitModule ??= await import('./visits.js');
  if (mine !== routeGeneration) return true;
  visitor = visitModule.mountVisitor(els.visit, visitModule.visitSource(token));
  return true;
}

window.addEventListener('hashchange', routeVisit);

// One playback across the page; a hidden or closing page plays nothing.
registerElement(els.preview, 'recorder-listen-back');
registerElement(els.viewerVoice, 'saved-recording');
document.addEventListener?.('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopAll();
});
window.addEventListener('pagehide', () => stopAll());

renderTextSource();
renderVoiceSource();
recorder.subscribe(renderVoice);
renderVoice();
if (!VISIT.test(location.hash)) access.start();
else routeVisit();
