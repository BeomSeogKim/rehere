import { latestOnly } from './latest.js';
import { MAX_RECORDING_MS, createRecorder } from './recorder.js';

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
  compose: $('compose'),
  form: $('draft-form'),
  addPhotos: $('add-photos'),
  photoInput: $('photo-input'),
  photoList: $('photo-list'),
  text: $('memory-text'),
  textCount: $('text-count'),
  voiceStatus: $('voice-status'),
  record: $('record'),
  stop: $('stop'),
  discard: $('discard'),
  preview: $('voice-preview'),
  message: $('form-message'),
  save: $('save'),
  saveWithoutVoice: $('save-without-voice'),
  viewer: $('viewer'),
  viewerTitle: $('viewer-title'),
  viewerDate: $('viewer-date'),
  viewerMessage: $('viewer-message'),
  viewerPhotos: $('viewer-photos'),
  viewerText: $('viewer-text'),
  viewerVoice: $('viewer-voice'),
  savedEmpty: $('saved-empty'),
  savedList: $('saved-list'),
};

const photos = [];
const viewRequests = latestOnly();
let saving = false;
let previewBlob = null;
let ticker = null;

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
      item.append(image, remove);
      return item;
    }),
  );
}

function addPhotos(files) {
  const skipped = [];
  for (const file of files) {
    if (photos.length >= PHOTO_LIMIT) skipped.push(`${file.name} (the limit is ${PHOTO_LIMIT} photos)`);
    else if (!PHOTO_TYPES.has(file.type)) skipped.push(`${file.name} (only JPEG or PNG)`);
    else if (file.size > PHOTO_BYTES) skipped.push(`${file.name} (larger than 20 MB)`);
    else photos.push({ file, url: URL.createObjectURL(file) });
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
  recorder.discard();
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
  try {
    const { voice, failed } = await collectVoice(includeVoice);
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
    const body = new FormData();
    body.append('text', text);
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
  let drafts;
  try {
    const response = await fetch('/api/drafts');
    if (!response.ok) throw new Error();
    drafts = await response.json();
  } catch {
    els.savedEmpty.hidden = false;
    els.savedEmpty.textContent = 'Saved memories could not be loaded. Reload the page to try again.';
    return;
  }
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
  els.viewerPhotos.replaceChildren(
    ...draft.photos.map((photo, index) => {
      const item = document.createElement('li');
      const image = document.createElement('img');
      image.src = asset(photo.name);
      image.alt = `Photo ${index + 1}`;
      item.append(image);
      return item;
    }),
  );
  els.viewerText.textContent = draft.text;
  if (draft.voice) {
    els.viewerVoice.src = asset(draft.voice.name);
    els.viewerVoice.hidden = false;
  }
}

function route() {
  const match = /^#\/memories\/([0-9a-f-]{36})$/.exec(location.hash);
  viewRequests.invalidate();
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

recorder.subscribe(renderVoice);
renderVoice();
route();
loadSaved();
