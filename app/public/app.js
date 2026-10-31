import { mountAccess } from './access-ui.js';
import { mountContributor } from './collaboration.js';
import { latestOnly } from './latest.js';
import { MAX_RECORDING_MS, createRecorder } from './recorder.js';
import {
  buildMetadata,
  createSourceDetails,
  createVoiceSource,
  detailsProblem,
  renderSavedSource,
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
// A lost response does not mean the server did not store the memory.
const UNCONFIRMED = 'Rehere could not confirm whether this was saved. Your photos, writing and recording are still here. Check Saved memories before trying again.';

const $ = (id) => document.getElementById(id);
const els = {
  access: $('access'),
  ownerApp: $('owner-app'),
  compose: $('compose'),
  form: $('draft-form'),
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
  viewerMessage: $('viewer-message'),
  viewerPhotos: $('viewer-photos'),
  viewerText: $('viewer-text'),
  viewerTextSource: $('viewer-text-source'),
  viewerVoice: $('viewer-voice'),
  viewerVoiceSource: $('viewer-voice-source'),
  viewerSpace: $('viewer-space'),
  savedEmpty: $('saved-empty'),
  savedList: $('saved-list'),
};

// Each photo object owns its source details, so they follow the photo when
// others are added or removed.
const photos = [];
let textSource = { details: createSourceDetails(), state: {} };
const viewRequests = latestOnly();
let space = null;
let spaceGeneration = 0;
let saving = false;
let previewBlob = null;
let ticker = null;
// Private content loads only while an owner session is active. Each sign-out
// bumps the generation so responses started before it are dropped.
let ownerActive = false;
let sessionGeneration = 0;
const stillOwner = (generation) => ownerActive && generation === sessionGeneration;

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
      const image = document.createElement('img');
      image.src = photo.url;
      image.alt = `Selected photo ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(photo.url);
        photos.splice(photos.indexOf(photo), 1);
        renderPhotos();
        els.addPhotos.focus();
      });
      frame.append(image, remove);
      item.append(frame, renderSourceControls(document, { ...photo, label: `photo ${index + 1}` }));
      return item;
    }),
  );
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
    else photos.push({ file, url: URL.createObjectURL(file), details: createSourceDetails(), state: {} });
  }
  renderPhotos();
  setMessage(skipped.length ? `Some photos were not added: ${skipped.join(', ')}.` : '');
}

function renderVoice() {
  const { state, message, recording, startedAt } = recorder.snapshot();
  const statusText = {
    unavailable: message,
    idle: 'Tell this memory in your own voice. Recording starts only when you press Record.',
    requesting: 'Waiting for microphone permission. You can still save photos and writing.',
    recording: `Recording ${formatTime(Date.now() - (startedAt ?? Date.now()))} of ${formatTime(MAX_RECORDING_MS)}`,
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
}

function renderActions() {
  const { state } = recorder.snapshot();
  const capturing = state === 'recording' || state === 'finalizing';
  els.save.textContent = capturing ? 'Stop and save' : state === 'requesting' ? 'Save without voice' : 'Save';
  els.saveWithoutVoice.hidden = !capturing;
  els.form.inert = saving;
  els.form.setAttribute('aria-busy', String(saving));
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
  els.text.value = '';
  els.textCount.textContent = '0';
  textSource = { details: createSourceDetails(), state: {} };
  renderTextSource();
  recorder.discard();
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

function savedNotice(id) {
  const fragment = document.createDocumentFragment();
  const link = document.createElement('a');
  link.href = `#/memories/${id}`;
  link.textContent = 'View what you saved';
  fragment.append('Saved. ', link);
  return fragment;
}

async function save(includeVoice) {
  if (saving) return;
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
    const total = photos.reduce((sum, photo) => sum + photo.file.size, 0) + (voice?.size ?? 0);
    if (total > REQUEST_BYTES) {
      setMessage('Everything saved at once must total 64 MB or less. Remove a photo or record a shorter message.');
      return;
    }
    const problem = sourceProblem(voice);
    if (problem) {
      setMessage(`${problem} ${KEPT}`);
      return;
    }
    const metadata = buildMetadata({
      photos,
      text,
      textDetails: textSource.details,
      voice,
      voiceDetails: voiceSource.current.details,
    });
    const body = new FormData();
    body.append('text', text);
    body.append('metadata', JSON.stringify(metadata));
    for (const photo of photos) body.append('photos', photo.file);
    if (voice) body.append('voice', voice, 'voice');

    let response;
    let result = null;
    try {
      response = await fetch('/api/drafts', { method: 'POST', body });
      result = await response.json().catch(() => null);
    } catch {
      response = null;
    }
    if (!stillOwner(generation)) return;
    if (response && !response.ok && typeof result?.error === 'string') {
      setMessage(`${result.error} ${KEPT}`);
      return;
    }
    if (!response?.ok || !result?.id) {
      setMessage(UNCONFIRMED);
      await loadSaved();
      return;
    }
    resetForm();
    setMessage(savedNotice(result.id), 'success');
    await loadSaved();
  } finally {
    saving = false;
    renderActions();
  }
}

async function loadSaved() {
  const generation = sessionGeneration;
  let drafts;
  try {
    const response = await fetch('/api/drafts');
    if (!response.ok) throw new Error();
    drafts = await response.json();
  } catch {
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

async function showDraft(id) {
  els.viewerDate.textContent = '';
  els.viewerMessage.textContent = '';
  els.viewerPhotos.replaceChildren();
  els.viewerText.textContent = '';
  els.viewerTextSource.replaceChildren();
  els.viewerVoiceSource.replaceChildren();
  els.viewerVoice.hidden = true;
  els.viewerVoice.removeAttribute('src');
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
  const asset = (name) => `/api/drafts/${draft.id}/assets/${encodeURIComponent(name)}`;
  els.viewerDate.textContent = `Saved ${formatDate(draft.createdAt)}`;
  // Drafts saved before source details have no sources; each item then shows
  // an unavailable state with nothing granted.
  const sources = Array.isArray(draft.sources) ? draft.sources : [];
  const source = (id) => sources.find((record) => record.id === id) ?? null;
  els.viewerPhotos.replaceChildren(
    ...draft.photos.map((photo, index) => {
      const item = document.createElement('li');
      const frame = document.createElement('div');
      frame.className = 'photo-frame';
      const image = document.createElement('img');
      image.src = asset(photo.name);
      image.alt = `Photo ${index + 1}`;
      frame.append(image);
      item.append(frame, renderSavedSource(document, source(photo.sourceId)));
      return item;
    }),
  );
  els.viewerText.textContent = draft.text;
  if (draft.text.trim()) els.viewerTextSource.append(renderSavedSource(document, source(draft.textSourceId)));
  if (draft.voice) {
    els.viewerVoice.src = asset(draft.voice.name);
    els.viewerVoice.hidden = false;
    els.viewerVoiceSource.append(renderSavedSource(document, source(draft.voice.sourceId)));
  }
  if (draft.photos.length) openSpace(draft, source);
}

// The 3D module loads only for a memory with photos; if it cannot load, the
// rest of the memory stays readable.
async function openSpace(draft, source) {
  const generation = spaceGeneration;
  els.viewerSpace.hidden = false;
  try {
    const module = await import('./space.js');
    if (generation !== spaceGeneration) return;
    space = module.mountSpace(els.viewerSpace, { draft, sourceFor: source });
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
  const match = /^#\/memories\/([0-9a-f-]{36})$/.exec(location.hash);
  viewRequests.invalidate();
  closeSpace();
  els.compose.hidden = Boolean(match);
  els.viewer.hidden = !match;
  if (match) {
    recorder.leave();
    showDraft(match[1]);
  }
}

els.addPhotos.addEventListener('click', () => els.photoInput.click());
els.photoInput.addEventListener('change', () => {
  addPhotos([...els.photoInput.files]);
  els.photoInput.value = '';
});
els.text.addEventListener('input', () => {
  els.textCount.textContent = els.text.value.length.toLocaleString('en-US');
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
  els.viewerDate.textContent = '';
  els.viewerMessage.textContent = '';
  els.viewerPhotos.replaceChildren();
  els.viewerText.textContent = '';
  els.viewerTextSource.replaceChildren();
  els.viewerVoiceSource.replaceChildren();
  els.viewerVoice.hidden = true;
  els.viewerVoice.removeAttribute('src');
}

function startOwner() {
  ownerActive = true;
  els.ownerApp.hidden = false;
  route();
  loadSaved();
}

// Removes everything private from the page and stops capture, synchronously,
// before any sign-out request is sent.
function stopOwner() {
  ownerActive = false;
  sessionGeneration += 1;
  viewRequests.invalidate();
  closeSpace();
  resetForm();
  setMessage('');
  clearViewer();
  els.savedList.replaceChildren();
  els.savedEmpty.hidden = false;
  els.savedEmpty.textContent = 'Nothing has been saved yet.';
  els.ownerApp.hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname);
}

const access = mountAccess(els.access, { onOwner: startOwner, onSignedOut: stopOwner, renderContributor: (node) => mountContributor(node) });

// Any private request answered 401 means the session expired or was replaced,
// including requests made by the scene and proposal modules.
const PUBLIC_API = /^\/api\/(session(\/|$)|invitations\/redeem$)/;
const baseFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
  // A 401 for a request sent in an earlier session must not end a newer one.
  const sentIn = sessionGeneration;
  const response = await baseFetch(input, options);
  const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
  if (response.status === 401 && sentIn === sessionGeneration && path.startsWith('/api/') && !PUBLIC_API.test(path)) access.sessionEnded();
  return response;
};

renderTextSource();
renderVoiceSource();
recorder.subscribe(renderVoice);
renderVoice();
access.start();
