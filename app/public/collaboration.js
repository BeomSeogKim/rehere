// Written recollections from invited contributors, the owner's manual review
// of them, saved alternatives with owner time assertions, and invitations.
// Nothing here reads meaning from a recollection: any change to the scene is
// a transform the owner sets by hand, previews on the real viewer and saves
// explicitly. Recollections, photos and model reconstructions stay separate
// kinds of evidence; none of them is shown as verified history.

import { copyPose, isComposition, poseProblem } from './composition-scene.js';
import { poseAxes, poseValues, poseWithAxis } from './composition-editor.js';
import { formatTransform } from './memory-edit.js';
import { MAX_RECORDING_MS, createRecorder } from './recorder.js';
import { register, registerElement, unregister } from './playback.js';
import { createStoryPlayer, formatMs } from './story-player.js';
import { TEXT_LIMITS as SOURCE_LIMITS, isCalendarDate } from './source-details.js';

export const TEXT_LIMIT = 10_000;
export const PERIOD_LIMIT = 300;
export const REASON_LIMIT = 1000;
export const ERA_LABEL_LIMIT = 300;
export const ERA_STATEMENT_LIMIT = 2000;
export const OFFSET_LIMIT = 2;
export const DECISIONS = Object.freeze(['reviewing', 'adopt', 'alternative', 'hold', 'reject']);
export const CONFLICTS = Object.freeze({
  unknown: 'Not known',
  viewpoint: 'Different viewpoint',
  time: 'Different time',
  memory: 'Memories differ',
  recognition: 'Different object recognised',
});
const DECISION_LABELS = {
  reviewing: 'Mark as being reviewed',
  adopt: 'Adopt into the current scene',
  alternative: 'Keep as a separate alternative',
  hold: 'Hold for now',
  reject: 'Do not use',
};
const PERMISSION_LABELS = {
  place: 'Use to reconstruct this place',
  model: 'Use for model processing',
  share: 'Share with others',
};
const FINAL = new Set(['adopted', 'alternative', 'rejected', 'withdrawn', 'deleted']);

// A contributor photo: one JPEG or PNG, recognised by its first bytes, up to
// the raw limit. The server decodes it and remains the authority.
export const PHOTO_LIMIT_MB = 20;
export const VOICE_LIMIT_MB = 50;
export const BUNDLE_LIMIT_MB = 64;
export const CAPTION_LIMIT = 20_000;
const PHOTO_ORIGINS = { unknown: 'Not known', own: 'My own photo', public: 'A public source', other: 'Someone else' };
export async function photoProblem(file) {
  if (!file || file.size === 0) return 'That file is empty.';
  if (file.size > PHOTO_LIMIT_MB * 1024 * 1024) return `Choose a photo of ${PHOTO_LIMIT_MB} MB or less.`;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte);
  return jpeg || png ? null : 'Choose a JPEG or PNG photo.';
}
// A sent recording's captions need the writer's confirmation, and everything
// sent at once must fit the limits.
export function voiceProblem({ input, file = null, voice = null }) {
  if (input.voice) {
    if (input.voice.captionText.length > CAPTION_LIMIT) return `Keep the captions to ${CAPTION_LIMIT.toLocaleString('en-US')} characters or fewer.`;
    if (input.voice.captionText.trim() && input.voice.captionConfirmed !== true) return 'Confirm that you wrote the captions yourself, or leave them empty.';
    if (voice && voice.size > VOICE_LIMIT_MB * 1024 * 1024) return `The recording is larger than ${VOICE_LIMIT_MB} MB. Record a shorter one.`;
  }
  const total = (file?.size ?? 0) + (voice?.size ?? 0);
  if (total > BUNDLE_LIMIT_MB * 1024 * 1024) return `Everything sent at once must total ${BUNDLE_LIMIT_MB} MB or less. Remove the photo or record a shorter recording.`;
  return null;
}
export function photoFieldsProblem(photo) {
  if (!photo) return null;
  if (photo.origin.reference.length > SOURCE_LIMITS.reference) return `Keep the photo’s reference to ${SOURCE_LIMITS.reference.toLocaleString('en-US')} characters or fewer.`;
  if (photo.dates.estimatedPeriod.length > SOURCE_LIMITS.estimatedPeriod) return `Keep the photo’s period to ${SOURCE_LIMITS.estimatedPeriod} characters or fewer.`;
  if (photo.dates.capturedOn && !isCalendarDate(photo.dates.capturedOn)) return 'The photo’s date taken is not a real calendar date.';
  return null;
}
// The contributor's own statements about the photo, as given; nothing here is
// read from the file.
function photoFactsText(photo) {
  const facts = [`Where it comes from, as they say: ${PHOTO_ORIGINS[photo.origin?.kind] ?? 'not known'}${photo.origin?.reference ? ` (${photo.origin.reference})` : ''}.`];
  if (photo.dates?.capturedOn) facts.push(`Date taken, as they say: ${photo.dates.capturedOn}.`);
  if (photo.dates?.estimatedPeriod) facts.push(`Period, as they say: ${photo.dates.estimatedPeriod}.`);
  return facts.join(' ');
}
// What a review form's photo depends on: its availability, address and uses.
const photoBinding = (photo, voice = null) =>
  JSON.stringify([photo ? [photo.available === true, photo.url ?? null, photo.permissions ?? null] : null, voice ? [voice.available === true, voice.url ?? null, voice.permissions ?? null, voice.captions?.sha256 ?? null] : null]);
// The start of a recording's current captions, as its provider wrote them,
// cut at a word boundary within the first 60 characters.
export function captionExcerpt(captions) {
  const words = (captions?.cues ?? []).map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim();
  const cut = words.slice(0, 60);
  return words.length > 60 ? `${(cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trimEnd()}…` : words;
}
// Tells one person's recordings apart: how long it plays and the start of its
// current captions, or that none were supplied. No IDs or hashes.
export function recordingContext(voice) {
  const excerpt = captionExcerpt(voice?.captions);
  const words = voice?.captions ? `captions version ${voice.captions.version ?? 1}${excerpt ? `: “${excerpt}”` : ''}` : 'No captions supplied.';
  return `${formatMs(voice?.durationMs ?? 0)} long · ${words}`;
}
const captionWords = (captions) => (captions?.cues ?? []).map((cue) => cue.text).join('\n');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'an unknown time');
// Earlier caption versions, private to the owner and the provider, newest
// first. Text only; nothing plays from here.
function captionHistoryBox(voice) {
  const history = Array.isArray(voice?.captionHistory) ? voice.captionHistory : [];
  if (!history.length) return null;
  return el('details', { className: 'source-details' }, [
    el('summary', { textContent: `Previous captions (${history.length})` }),
    el(
      'ul',
      { className: 'collab-list' },
      history.map((entry) =>
        el('li', {}, [
          el('p', { className: 'hint', textContent: `Version ${entry.version}, written by ${entry.authorLabel || 'the provider'} on ${when(entry.createdAt)}; replaced on ${when(entry.supersededAt)}.` }),
          el('p', { className: 'memory-text', textContent: captionWords(entry) }),
        ]),
      ),
    ),
  ]);
}
const CAPTION_BINDING_TEXT = {
  changed: 'The listening captions were added or corrected after this review. The review describes what you saw then.',
  unknown: 'Which listening captions this review saw is not known.',
};
// A deleted contribution, as both the owner and its provider see it: whether
// local cleanup finished, and which of the provider's own materials were
// removed. Nothing about its content, provider or reviews is left to show.
const DELETION_LIMITS =
  'Rehere cannot remove copies someone downloaded, viewed or screenshotted; notes others wrote without linking them to it; account profiles; terminal logs already written; backups of this computer or data its disk keeps after deletion; or anything already sent to a hosted service.';
function deletionMaterials(inventory) {
  const parts = [
    inventory?.writing ? 'the words' : null,
    inventory?.photo ? 'the photo' : null,
    inventory?.voice ? 'the recording' : null,
    inventory?.playback ? 'its listening copy' : null,
    Number.isInteger(inventory?.captionVersions) && inventory.captionVersions > 0 ? `${inventory.captionVersions} caption version${inventory.captionVersions === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? 'what was sent';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
function deletionStateText(deletion) {
  return deletion?.state === 'complete'
    ? `Removed from this app's tracked storage on this computer${deletion.completedAt ? ` on ${when(deletion.completedAt)}` : ''}: ${deletionMaterials(deletion.inventory)}.`
    : `Every use has stopped and its content is gone from Rehere's records. Removing its stored files (${deletionMaterials(deletion?.inventory)}) on this computer is still finishing.`;
}
// What a withdrawal covers, named by what was actually sent.
function withdrawnParts(contribution) {
  const parts = [contribution.text?.trim() ? 'your words' : null, contribution.photo ? 'your photo' : null, contribution.voice ? 'your recording' : null].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? 'this recollection';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
const recordingUsesText = (voice) => grantsText(voice?.permissions).replace(/^Allowed:/, 'Recording allowed:').replace(/^No uses allowed\./, 'No recording uses allowed.');
const photoUsesText = (photo) => grantsText(photo?.permissions).replace(/^Allowed:/, 'photo allowed:').replace(/^No uses allowed\./, 'no photo uses allowed.');

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function invitationToken(crypto = globalThis.crypto) {
  return `rhi_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function contributionStatusText(contribution) {
  switch (contribution.status) {
    case 'submitted':
      return 'Received. The owner has not reviewed it yet.';
    case 'reviewing':
      return 'The owner is reviewing it.';
    case 'held':
      return 'The owner is holding it for now.';
    case 'adopted':
      return 'The owner used it to adjust the current scene.';
    case 'alternative':
      return 'The owner kept it as a separate alternative scene.';
    case 'rejected':
      return 'The owner decided not to use it.';
    case 'withdrawn':
      return 'Withdrawn. Rehere no longer shows or uses this recollection.';
    case 'deleted':
      return 'Deleted by the person who sent it.';
    default:
      return 'Status unknown.';
  }
}

// Writing is needed unless a recording is sent; a photo alone is not enough.
export function submissionProblem({ text, periodClaim, voice = null }) {
  if (!text.trim() && !voice) return 'Write your recollection before sending it, or record it.';
  if (text.length > TEXT_LIMIT) return `Keep your recollection to ${TEXT_LIMIT.toLocaleString('en-US')} characters or fewer.`;
  if (periodClaim.length > PERIOD_LIMIT) return `Keep the time as you remember it to ${PERIOD_LIMIT} characters or fewer.`;
  return null;
}

export function transformProblem(transform) {
  if (!transform) return 'Set the candidate position first.';
  if (transform.pose) return poseProblem({ ...transform.pose, scale: 1 });
  const { offset, yaw } = transform;
  if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isFinite)) return 'Each position value must be a number.';
  if (offset.some((value) => Math.abs(value) > OFFSET_LIMIT)) return `Each position value must be between -${OFFSET_LIMIT} and ${OFFSET_LIMIT}.`;
  if (!Number.isFinite(yaw) || Math.abs(yaw) > Math.PI) return 'The turn must be between -180 and 180 degrees.';
  return null;
}

export function eraProblem(era) {
  const { kind, label, start, end, relation, relativeToVariantId, statement, confirmed } = era;
  if (label.length > ERA_LABEL_LIMIT) return `Keep the label to ${ERA_LABEL_LIMIT} characters or fewer.`;
  if (statement.length > ERA_STATEMENT_LIMIT) return `Keep the statement to ${ERA_STATEMENT_LIMIT} characters or fewer.`;
  if (kind === 'unknown') return null;
  if (!statement.trim()) return 'Write what the time is based on.';
  if (!confirmed) return 'Confirm that this is your own assertion.';
  if (kind === 'exact' && !isCalendarDate(start ?? '')) return 'Enter a real calendar date.';
  if (kind === 'range') {
    if (!isCalendarDate(start ?? '') || !isCalendarDate(end ?? '')) return 'Enter real calendar dates for both ends.';
    if (start > end) return 'The range must start before it ends.';
  }
  if (kind === 'relative') {
    if (!label.trim()) return 'Describe the time, for example “before the renovation”.';
    if (Boolean(relation) !== Boolean(relativeToVariantId)) return 'Choose both the relation and the other scene, or neither.';
  }
  return null;
}

// The owner's assertion, phrased as an assertion. A missing or unknown era is
// shown as unknown; no year is ever inferred.
export function describeEra(era, labelFor = () => 'another scene') {
  if (!era || era.kind === 'unknown') return 'Time unknown';
  const relation = era.relation ? ` (${era.relation === 'same-time' ? 'same time as' : era.relation} ${labelFor(era.relativeToVariantId)})` : '';
  const when = { exact: era.start, range: `${era.start} to ${era.end}`, relative: era.label }[era.kind];
  return `Owner’s assertion: ${when}${era.kind !== 'relative' && era.label ? ` · ${era.label}` : ''}${relation}`;
}

// The provider's display name as recorded when they wrote it.
const providerName = (entry) => entry.provider?.displayName || 'Someone';

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

let fieldCount = 0;
function field(labelText, input, hintText = '') {
  input.id = `collab-field-${++fieldCount}`;
  const nodes = [el('label', { htmlFor: input.id, textContent: labelText }), input];
  if (hintText) nodes.push(el('p', { className: 'hint', textContent: hintText }));
  return el('div', { className: 'source-field' }, nodes);
}

function select(options, value) {
  const node = el('select');
  for (const [optionValue, text] of options) node.append(el('option', { value: optionValue, textContent: text }));
  node.value = value;
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

const postJson = (url, payload) =>
  request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
// No answer, a server error, or a refusal whose body is not Rehere's own
// {error}: the outcome is unknown and the same request is repeated.
const unclear = (result) => result.status === 0 || result.status >= 500 || (!result.ok && typeof result.body?.error !== 'string');
const reasonOf = (result) => (typeof result.body?.error === 'string' ? result.body.error.trim() : '');
const withReason = (result, note) => (reasonOf(result) ? `${reasonOf(result)} ${note}` : note);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Keeps one prepared request per action. It is reused only after an unknown
// outcome and only while the input is unchanged; any server answer clears it.
function attempts() {
  let held = null;
  return {
    prepare(key, input, build) {
      if (!held || held.key !== key || !sameJson(held.input, input)) held = { key, input, body: build() };
      return held.body;
    },
    settle() {
      held = null;
    },
  };
}

// A withdrawn recollection keeps its original grants on the server, but none of
// them applies any more.
const usesText = (entry) => (entry.status === 'withdrawn' ? 'All further use withdrawn.' : entry.permissions ? grantsText(entry.permissions) : 'No written words were sent.');

function grantsText(permissions) {
  const allowed = Object.entries(PERMISSION_LABELS).filter(([key]) => permissions?.[key] === true);
  return allowed.length ? `Allowed: ${allowed.map(([, label]) => label.toLowerCase()).join('; ')}.` : 'No uses allowed.';
}

// ---------------------------------------------------------------- contributor

// A contributor's own screen: choose a place, send a written recollection
// with at most one photo, see what happened to it and withdraw it. No scene,
// microphone or other people's words are requested.
//
// A send whose outcome is unknown keeps its request ID until Rehere's record
// of this contributor's own recollections shows whether it arrived: sending
// again repeats that ID, and only an explicit new submission gets a new one.
// The browser keeps only that opaque ID, per principal and place, never the
// words, the photo, its name or its settings.
// Contributor choices: the owner's place name (or an honest unnamed or
// unavailable state) with the scene's own photo and build time, composed from
// the server's structured fields. The time is when the build was requested,
// not when it finished or when the photo was taken. No ID fragment is shown; a choice ordinal is
// added only when two full labels would still read the same. Rows from a
// server without these fields keep its own label.
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });
const longDate = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function placeChoiceLabels(rows) {
  const labels = rows.map((row) => {
    if (typeof row?.nameUnavailable !== 'boolean' || !validDate(row.buildRequestedAt)) return String(row?.label ?? 'A place');
    const place = row.nameUnavailable
      ? 'Place name unavailable'
      : typeof row.placeName === 'string' && row.placeName !== ''
        ? row.placeName
        : `Unnamed place${validDate(row.draftSavedAt) ? ` saved ${shortDate(row.draftSavedAt)}` : ''}`;
    const photo = Number.isInteger(row.photoNumber) && row.photoNumber > 0 ? `photo ${row.photoNumber}` : 'a photo no longer shown';
    const scene = Number.isInteger(row.sceneCount) && row.sceneCount > 1 && Number.isInteger(row.sceneOrdinal) ? `, scene ${row.sceneOrdinal} of ${row.sceneCount}` : '';
    return `${place} · scene from ${photo}, build requested ${longDate(row.buildRequestedAt)}${scene}`;
  });
  const seen = new Map();
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
  const counted = new Map();
  return labels.map((label) => {
    if (seen.get(label) === 1) return label;
    const index = (counted.get(label) ?? 0) + 1;
    counted.set(label, index);
    return `${label} (choice ${index} of ${seen.get(label)})`;
  });
}

export function mountContributor(container, { principal = null, media = null } = {}) {
  let disposed = false;
  let place = null;
  let generation = 0;
  // Each read of the own list carries a token; a write or a newer read makes
  // older reads stale, so a slow older answer cannot bring back withdrawn words.
  let readToken = 0;
  const withdrawAttempt = attempts();
  // The request ID of a send not known to have arrived, and what it held.
  let pendingId = null;
  let pendingInput = null;
  // The exact attempt behind pendingId in this session: its input and file.
  // "Send again" repeats it, whatever the form holds now.
  let attempt = null;
  let photoFile = null;
  let previewUrl = null;
  // Object URLs and players of the list, each with the contribution it shows,
  // so one row can be released on its own.
  let ownUrls = [];
  // The rendered row of each contribution in the list.
  const ownRows = new Map();
  // Players for the person's own recordings in the list; every render, place
  // change or close disposes them, which aborts a pending load and stops sound.
  let ownPlayers = [];
  // Invalidates a photo check still reading a file, and own-list photo loads.
  let selectToken = 0;
  let ownToken = 0;
  // A finished take belongs to the place it was recorded for. Switching place
  // keeps it there (with its captions, uses and any unconfirmed send) and the
  // new place starts without one.
  const placeTakes = new Map();
  // Open caption editors and the last caption outcome, per contribution of
  // this place; a re-render keeps them, a place change or closing drops them.
  const captionEditors = new Map();
  const captionNotes = new Map();
  // Deletions being previewed or not known to have been accepted, per
  // contribution of this place.
  const deletions = new Map();
  // The last local-cleanup retry outcome per deleted contribution.
  const cleanupNotes = new Map();
  const recorder = createRecorder(media ?? { mediaDevices: globalThis.navigator?.mediaDevices, MediaRecorder: globalThis.MediaRecorder });
  let takeUrl = null;
  let takeBlob = null;

  const placeSelect = el('select');
  const text = el('textarea', { rows: 6, maxLength: TEXT_LIMIT });
  const period = el('input', { type: 'text', maxLength: PERIOD_LIMIT });
  const grants = Object.fromEntries(Object.keys(PERMISSION_LABELS).map((key) => [key, el('input', { type: 'checkbox' })]));
  const photoInput = el('input', { type: 'file', accept: 'image/jpeg,image/png' });
  const photoPreview = el('img', { className: 'space-proposal', alt: 'The photo you chose', hidden: true });
  const removePhoto = el('button', { type: 'button', className: 'secondary', textContent: 'Remove photo', hidden: true });
  const photoOrigin = select(Object.entries(PHOTO_ORIGINS), 'unknown');
  const photoReference = el('input', { type: 'text', maxLength: SOURCE_LIMITS.reference });
  const photoCaptured = el('input', { type: 'date' });
  const photoPeriod = el('input', { type: 'text', maxLength: SOURCE_LIMITS.estimatedPeriod });
  const photoGrants = Object.fromEntries(Object.keys(PERMISSION_LABELS).map((key) => [key, el('input', { type: 'checkbox' })]));
  const photoFields = el('div', { hidden: true }, [
    field('Where the photo comes from', photoOrigin),
    field('Reference (optional)', photoReference, 'A link or note about where it came from.'),
    field('Date taken (optional)', photoCaptured, 'Leave blank if unknown. Rehere does not read dates from the file.'),
    field('Approximate period (optional)', photoPeriod, 'For example, summer 1998. Kept as you write it.'),
    el('fieldset', { className: 'source-permissions' }, [
      el('legend', { textContent: 'Allowed uses of your photo' }),
      el('p', { className: 'hint', textContent: 'A use needs your permission for both your words and your photo.' }),
      ...Object.entries(PERMISSION_LABELS).map(([key, label]) => el('label', {}, [photoGrants[key], ` ${label}`])),
    ]),
  ]);
  const send = el('button', { type: 'button', textContent: 'Send recollection' });
  const record = el('button', { type: 'button', className: 'secondary', textContent: 'Record' });
  const stopTake = el('button', { type: 'button', className: 'secondary', textContent: 'Stop', hidden: true });
  const discardTake = el('button', { type: 'button', className: 'secondary', textContent: 'Discard recording', hidden: true });
  const takeStatus = el('p', { className: 'hint', role: 'status' });
  const takeAudio = el('audio', { controls: true, hidden: true });
  // The take's listen-back is one player among the page's: playing it stops
  // others, and page-wide stops (sign-out, navigation, hidden page) silence it.
  const takeOwner = Symbol('contribution-take');
  registerElement(takeAudio, takeOwner);
  const captionText = el('textarea', { rows: 4, maxLength: CAPTION_LIMIT });
  const captionConfirm = el('input', { type: 'checkbox' });
  const voiceGrants = Object.fromEntries(Object.keys(PERMISSION_LABELS).map((key) => [key, el('input', { type: 'checkbox' })]));
  const voiceFields = el('div', { hidden: true }, [
    field('Captions for listeners (optional)', captionText, 'If you want people to be able to hear this in a shared view, write what is heard in your own words. Rehere does not transcribe or check them, and you can send the recording without them.'),
    el('label', { className: 'memory-consent' }, [captionConfirm, ' I wrote these captions myself; they convey what is heard']),
    el('fieldset', { className: 'source-permissions' }, [
      el('legend', { textContent: 'Allowed uses of your recording' }),
      el('p', { className: 'hint', textContent: 'A use needs your permission for every part you send: words, photo and recording.' }),
      ...Object.entries(PERMISSION_LABELS).map(([key, label]) => el('label', {}, [voiceGrants[key], ` ${label}`])),
    ]),
  ]);
  const startNew = el('button', { type: 'button', className: 'secondary', textContent: 'Start a new submission instead', hidden: true });
  const uncertainNote = el('p', { className: 'hint' });
  const message = el('p', { className: 'form-message', role: 'alert' });
  const status = el('p', { className: 'hint', role: 'status' });
  const own = el('ul', { className: 'collab-list' });
  // Unsaved caption text, kept reachable when the list cannot be read again.
  // It holds only the person's own typing and its outcome: no media, history
  // or players from the list that could not be confirmed.
  const captionRecovery = el('div');
  const form = el('div', { hidden: true }, [
    field('What you remember about this place', text, 'Your words are kept exactly as you write them. The owner may use them to adjust the scene by hand; nothing reads meaning from them automatically, and nothing here is checked as historical fact.'),
    field('When this was, as you remember it (optional)', period, 'Kept as your own words. It is not turned into a date.'),
    el('fieldset', { className: 'source-permissions' }, [
      el('legend', { textContent: 'Allowed uses of your words' }),
      ...Object.entries(PERMISSION_LABELS).map(([key, label]) => el('label', {}, [grants[key], ` ${label}`])),
    ]),
    el('fieldset', { className: 'source-permissions' }, [
      el('legend', { textContent: 'Add a photo (optional)' }),
      el('p', {
        className: 'hint',
        textContent: `JPEG or PNG, up to ${PHOTO_LIMIT_MB} MB and 32 megapixels. If a PNG is not accepted, export it as a JPEG or an 8-bit PNG. Rehere keeps your original and shows the owner a copy without file details such as location. What the photo shows, such as faces or signs, is not hidden. Nothing is sent until you press Send.`,
      }),
      photoInput,
      photoPreview,
      el('div', { className: 'actions' }, [removePhoto]),
      photoFields,
    ]),
    el('fieldset', { className: 'source-permissions' }, [
      el('legend', { textContent: 'Record your recollection (optional)' }),
      el('p', {
        className: 'hint',
        textContent: 'Your voice is kept as recorded and is not transcribed. Recording starts only when you press Record and stops on its own just before five minutes. You can send a recording without writing anything.',
      }),
      el('div', { className: 'actions' }, [record, stopTake, discardTake]),
      takeStatus,
      takeAudio,
      voiceFields,
    ]),
    el('p', { className: 'hint', textContent: `Everything sent at once must total ${BUNDLE_LIMIT_MB} MB or less: a photo up to ${PHOTO_LIMIT_MB} MB and a recording up to ${VOICE_LIMIT_MB} MB.` }),
    el('div', { className: 'actions' }, [startNew, send]),
    uncertainNote,
    message,
    el('h2', { textContent: 'What you have sent' }),
    el('p', { className: 'hint', textContent: 'You see what happened to each recollection. The owner’s private review notes are not shared with you.' }),
    status,
    captionRecovery,
    own,
  ]);

  container.replaceChildren(
    el('section', { className: 'panel collab' }, [
      el('h1', { textContent: 'Add your recollection' }),
      field('Place', placeSelect),
      form,
    ]),
  );

  const scope = () => `/api/drafts/${place.draftId}/reconstructions/${place.jobId}`;

  // Only an opaque ID, scoped to this principal and place; blocked storage
  // simply keeps nothing.
  const storeKey = () => (principal?.id && place ? `rehere:contribution-pending:${principal.id}:${place.draftId}:${place.jobId}` : null);
  function storage() {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }
  function storePending(id, key = storeKey()) {
    if (!key) return;
    try {
      if (id) storage()?.setItem(key, id);
      else storage()?.removeItem(key);
    } catch {
      // Recovery then relies on checking this session only.
    }
  }
  function storedPending(key = storeKey()) {
    try {
      const value = key ? storage()?.getItem(key) : null;
      return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  // The ID is kept before a send starts; the person is offered the explicit
  // choice between repeating it and starting anew only once it is uncertain.
  function setPending(id, input = null) {
    pendingId = id;
    pendingInput = input;
    storePending(id);
    if (!id) {
      attempt = null;
      showUncertain(false);
    }
  }
  function showUncertain(on) {
    startNew.hidden = !on;
    // With the exact attempt in memory, Send repeats it. With only a restored
    // ID, the button can only check whether that earlier send arrived.
    send.textContent = on ? (attempt ? 'Send again (same request)' : 'Check earlier submission') : 'Send recollection';
    uncertainNote.textContent = on && attempt ? 'Sending again repeats exactly what was sent before, including its photo. Any newer changes in the form stay there for a new submission.' : '';
  }

  function revokeOwn() {
    ownToken += 1;
    for (const { url } of ownUrls) URL.revokeObjectURL(url);
    ownUrls = [];
    for (const { player } of ownPlayers.splice(0)) player.dispose();
    ownRows.clear();
  }
  // A different original starts with its facts unknown and every use off;
  // re-choosing the same file keeps what was set for it. Text uses are kept.
  function resetPhotoFacts() {
    photoOrigin.value = 'unknown';
    photoReference.value = '';
    photoCaptured.value = '';
    photoPeriod.value = '';
    for (const box of Object.values(photoGrants)) box.checked = false;
  }
  function setPhoto(file) {
    selectToken += 1;
    if (file !== photoFile) resetPhotoFacts();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    photoFile = file;
    if (file) {
      previewUrl = URL.createObjectURL(file);
      photoPreview.src = previewUrl;
    } else {
      photoPreview.removeAttribute?.('src');
      photoInput.value = '';
    }
    photoPreview.hidden = !file;
    removePhoto.hidden = !file;
    photoFields.hidden = !file;
  }
  // A different take starts with no captions and every use off.
  function resetVoiceFacts() {
    captionText.value = '';
    captionConfirm.checked = false;
    for (const box of Object.values(voiceGrants)) box.checked = false;
  }
  // Silences and forgets the listen-back copy: a new take, a discard, a place
  // change and closing all come through here.
  function releaseTakeAudio() {
    takeAudio.pause?.();
    takeAudio.removeAttribute?.('src');
    takeAudio.load?.();
    if (takeUrl) URL.revokeObjectURL(takeUrl);
    takeUrl = null;
  }
  register(takeOwner, () => takeAudio.pause?.());
  function renderTake() {
    const { state, message: note, recording } = recorder.snapshot();
    if (recording !== takeBlob) {
      releaseTakeAudio();
      takeBlob = recording;
      resetVoiceFacts();
      if (recording) {
        takeUrl = URL.createObjectURL(recording);
        takeAudio.src = takeUrl;
      }
    }
    takeStatus.textContent =
      {
        unavailable: note,
        idle: '',
        requesting: 'Waiting for microphone permission. Words and a photo can still be sent.',
        recording: `Recording; it stops on its own before ${Math.ceil(MAX_RECORDING_MS / 60000)} minutes.`,
        finalizing: 'Finishing the recording…',
        recorded: 'Recording ready. Listen back before sending, or discard it.',
        denied: note,
        error: note,
      }[state] ?? '';
    record.hidden = !['idle', 'denied', 'error', 'unavailable'].includes(state);
    record.disabled = state === 'unavailable';
    stopTake.hidden = state !== 'recording';
    discardTake.hidden = !['requesting', 'recording', 'finalizing', 'recorded'].includes(state);
    takeAudio.hidden = !recording;
    voiceFields.hidden = !recording;
  }
  recorder.subscribe(renderTake);
  record.addEventListener('click', () => recorder.start());
  stopTake.addEventListener('click', () => recorder.stop());
  discardTake.addEventListener('click', () => recorder.discard());
  renderTake();

  function clearForm() {
    text.value = '';
    period.value = '';
    for (const box of [...Object.values(grants), ...Object.values(photoGrants)]) box.checked = false;
    photoOrigin.value = 'unknown';
    photoReference.value = '';
    photoCaptured.value = '';
    photoPeriod.value = '';
    setPhoto(null);
    recorder.discard();
    resetVoiceFacts();
  }

  photoInput.addEventListener('change', async () => {
    const [file] = photoInput.files ?? [];
    if (!file) return;
    const mine = generation;
    // A newer choice, a removal or closing makes this check stale.
    const token = ++selectToken;
    const problem = await photoProblem(file);
    if (disposed || mine !== generation || token !== selectToken) return;
    if (problem) {
      // A refused choice leaves no photo: preview, input and what Send
      // would send agree.
      setPhoto(null);
      message.textContent = problem;
      return;
    }
    message.textContent = '';
    setPhoto(file);
  });
  removePhoto.addEventListener('click', () => setPhoto(null));

  // Loads one review copy for display; it is released on the next render.
  async function photoImage(url, alt, id) {
    const token = ownToken;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return null;
      const blob = await response.blob();
      // A later render or closing already released this list.
      if (disposed || token !== ownToken) return null;
      const objectUrl = URL.createObjectURL(blob);
      // This row was already replaced, for example by its deletion.
      if (!ownRows.has(id)) {
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      ownUrls.push({ id, url: objectUrl });
      return el('img', { className: 'space-proposal', src: objectUrl, alt });
    } catch {
      return null;
    }
  }

  // Only the opaque request ID of a caption change not known to have been
  // saved, per principal, place and contribution; never the words.
  const captionKey = (id) => (storeKey() ? `rehere:caption-pending:${principal.id}:${place.draftId}:${place.jobId}:${id}` : null);
  // A save is confirmed only by an answer about this contribution: a version
  // within the 20-version bound, and either the withdrawn record or current
  // captions at least that new. Anything else leaves the outcome unknown.
  const captionAnswer = (result, id) => {
    const contribution = result.ok ? result.body?.contribution : null;
    const applied = result.body?.appliedCaptionVersion;
    if (!contribution || typeof contribution !== 'object' || contribution.id !== id || !Number.isInteger(applied) || applied < 1 || applied > 20) return false;
    if (contribution.status === 'withdrawn' || contribution.status === 'deleted') return true;
    const now = contribution.voice?.captions;
    return Boolean(now) && typeof now.sha256 === 'string' && Number.isInteger(now.version) && now.version >= applied && now.version <= 20 && Array.isArray(now.cues);
  };

  function showCaptionRecovery() {
    const editors = [...captionEditors.values()];
    if (!editors.length) {
      captionRecovery.replaceChildren();
      return;
    }
    const retry = el('button', { type: 'button', className: 'secondary', textContent: 'Refresh your recollections' });
    retry.addEventListener('click', () => loadOwn());
    captionRecovery.replaceChildren(
      el('p', { className: 'hint', textContent: 'Your caption text is kept below while your recollections cannot be shown. Refresh to see them again.' }),
      retry,
      ...editors.map((editor) => {
        refreshCaptionEditor(editor, editor.voice);
        return editor.wrap;
      }),
    );
  }

  function captionControl(contribution) {
    const slot = el('div');
    let editor = captionEditors.get(contribution.id);
    if (!editor && storedPending(captionKey(contribution.id))) editor = openCaptionEditor(contribution, true);
    if (editor) {
      refreshCaptionEditor(editor, contribution.voice);
      slot.append(editor.wrap);
      return slot;
    }
    const open = el('button', { type: 'button', className: 'secondary', textContent: contribution.voice.captions ? 'Correct listening captions' : 'Add listening captions' });
    open.addEventListener('click', () => {
      captionNotes.delete(contribution.id);
      const created = openCaptionEditor(contribution, false);
      refreshCaptionEditor(created, contribution.voice);
      slot.replaceChildren(created.wrap);
    });
    slot.append(open);
    return slot;
  }

  // An editor starts from the current captions it was opened on. After a
  // reload with an earlier change unconfirmed, it can only look that change up.
  function openCaptionEditor(contribution, lookup) {
    const voice = contribution.voice;
    const editor = {
      id: contribution.id,
      base: voice.captions?.sha256 ?? null,
      attempt: null,
      pendingId: lookup ? storedPending(captionKey(contribution.id)) : null,
      busy: false,
      open: !lookup,
      voice,
      text: el('textarea', { rows: 4, maxLength: CAPTION_LIMIT, value: lookup ? '' : captionWords(voice.captions) }),
      confirm: el('input', { type: 'checkbox' }),
      save: el('button', { type: 'button' }),
      startNew: el('button', { type: 'button', className: 'secondary', textContent: 'Start a new caption change instead' }),
      reopen: el('button', { type: 'button', className: 'secondary', textContent: 'Reopen the current captions' }),
      staleNote: el('p', { className: 'hint' }),
      note: el('p', { className: 'form-message', role: 'alert', textContent: lookup ? 'An earlier caption change may not have reached Rehere. Check it before starting a new one.' : '' }),
    };
    editor.fields = el('div', { hidden: lookup }, [
      el('p', {
        className: 'hint',
        textContent:
          'Listening captions are your own written account of what is heard, not a transcript and not a check of what happened. Your recording and anything you wrote stay as they are, and earlier captions stay listed as earlier versions. Saving stops any shared view that uses this recording; the owner needs a new preview and link to share it again. Copies someone already downloaded cannot be recalled.',
      }),
      field('Listening captions', editor.text, `Plain text, up to ${CAPTION_LIMIT.toLocaleString('en-US')} characters.`),
      el('label', { className: 'memory-consent' }, [editor.confirm, ' I wrote these listening captions']),
      editor.staleNote,
    ]);
    editor.wrap = el('div', {}, [editor.fields, el('div', { className: 'actions' }, [editor.reopen, editor.startNew, editor.save]), editor.note]);
    editor.save.addEventListener('click', () => saveCaptions(editor));
    // Discards the typed text only on this explicit request; an unconfirmed
    // attempt stays as it was sent.
    editor.reopen.addEventListener('click', () => {
      editor.text.value = captionWords(editor.voice.captions);
      editor.confirm.checked = false;
      editor.base = editor.voice.captions?.sha256 ?? null;
      editor.note.textContent = '';
      refreshCaptionEditor(editor, editor.voice);
    });
    editor.startNew.addEventListener('click', () => {
      storePending(null, captionKey(editor.id));
      editor.pendingId = null;
      editor.attempt = null;
      if (!editor.open) {
        editor.open = true;
        editor.fields.hidden = false;
        editor.text.value = captionWords(editor.voice.captions);
        editor.base = editor.voice.captions?.sha256 ?? null;
      }
      editor.note.textContent = 'Your next save is a new caption change. The earlier one may still have been saved; Rehere could not confirm it.';
      refreshCaptionEditor(editor, editor.voice);
    });
    captionEditors.set(contribution.id, editor);
    return editor;
  }

  // A newer list may show captions the editor was not opened on: the typed
  // text stays, but cannot be saved over them.
  function refreshCaptionEditor(editor, voice) {
    editor.voice = voice;
    const stale = editor.open && editor.base !== (voice.captions?.sha256 ?? null);
    editor.staleNote.textContent = stale
      ? 'The listening captions changed after you opened this editor. Your text is still here, but it cannot be saved over captions you have not seen. Reopen the current captions to continue from them.'
      : '';
    editor.reopen.hidden = !stale;
    editor.startNew.hidden = !editor.pendingId || editor.busy;
    editor.save.textContent = editor.attempt ? 'Save again (same request)' : editor.pendingId ? 'Check earlier caption change' : 'Save listening captions';
    editor.save.disabled = editor.busy || (!editor.attempt && !editor.pendingId && stale);
  }

  // One immutable attempt per change: saving again repeats it exactly, even
  // after more typing. Late answers for another place, a closed screen or a
  // dropped editor change nothing.
  async function saveCaptions(editor) {
    if (editor.busy || !place) return;
    const mine = generation;
    const target = place;
    const current = () => !disposed && mine === generation && place === target && captionEditors.get(editor.id) === editor;
    const url = `${scope()}/contributions/${editor.id}/captions`;
    captionNotes.delete(editor.id);
    if (!editor.attempt && editor.pendingId) {
      editor.busy = true;
      refreshCaptionEditor(editor, editor.voice);
      readToken += 1;
      const result = await request(`${url}/requests/${editor.pendingId}`);
      if (!current()) return;
      editor.busy = false;
      if (captionAnswer(result, editor.id)) {
        await captionSaved(editor, result.body, null);
        return;
      }
      editor.note.textContent =
        result.status === 404
          ? 'Rehere has no record of your earlier caption change yet; it may still arrive. Check again later, or start a new caption change.'
          : 'Rehere could not check your earlier caption change. Try again.';
      refreshCaptionEditor(editor, editor.voice);
      return;
    }
    let attempt = editor.attempt;
    if (!attempt) {
      const captionText = editor.text.value;
      const problem = !captionText.trim()
        ? 'Write the listening captions before saving.'
        : captionText.length > CAPTION_LIMIT
          ? `Keep the captions to ${CAPTION_LIMIT.toLocaleString('en-US')} characters or fewer.`
          : editor.confirm.checked !== true
            ? 'Confirm that you wrote these listening captions yourself.'
            : '';
      if (problem) {
        editor.note.textContent = problem;
        return;
      }
      const requestId = crypto.randomUUID();
      attempt = { requestId, body: { requestId, baseCaptionSha256: editor.base, captionText, captionConfirmed: true } };
    }
    editor.attempt = attempt;
    editor.pendingId = attempt.requestId;
    storePending(attempt.requestId, captionKey(editor.id));
    editor.busy = true;
    refreshCaptionEditor(editor, editor.voice);
    readToken += 1;
    let result = await postJson(url, attempt.body);
    if (!current()) return;
    editor.busy = false;
    if (result.ok && !captionAnswer(result, editor.id)) result = { ...result, ok: false, status: 0 };
    if (unclear(result)) {
      editor.note.textContent = withReason(result, 'Rehere could not confirm whether your captions were saved. What you typed is still here; saving again repeats the same request.');
      refreshCaptionEditor(editor, editor.voice);
      return;
    }
    if (result.ok) {
      await captionSaved(editor, result.body, attempt.body.captionText);
      return;
    }
    // Signed out or not allowed says nothing about an earlier try of this
    // request: its ID and exact attempt stay until a receipt settles it or
    // the person starts a new change. Reading the list again decides whether
    // the draft may stay on screen.
    if (result.status === 401 || result.status === 403) {
      const note = 'Rehere did not accept this save because you are signed out or no longer allowed here. Whether an earlier try was saved is still unknown; once you can sign in again, Rehere can check it.';
      editor.note.textContent = note;
      message.textContent = note;
      refreshCaptionEditor(editor, editor.voice);
      await loadOwn();
      return;
    }
    // A definite refusal: nothing was saved, and the typed text stays.
    storePending(null, captionKey(editor.id));
    editor.attempt = null;
    editor.pendingId = null;
    editor.note.textContent = `${reasonOf(result) || 'The captions could not be saved.'} What you typed is still here.`;
    refreshCaptionEditor(editor, editor.voice);
    await loadOwn();
  }

  // Saved means a 200 answer or a found receipt. The version this change
  // saved is named apart from whatever is current now.
  async function captionSaved(editor, body, savedText) {
    const mine = generation;
    const target = place;
    const contribution = body.contribution;
    const applied = body.appliedCaptionVersion;
    const gone = contribution.status === 'withdrawn' || contribution.status === 'deleted';
    const now = gone ? null : contribution.voice?.captions ?? null;
    storePending(null, captionKey(editor.id));
    editor.attempt = null;
    editor.pendingId = null;
    editor.note.textContent = '';
    captionNotes.set(
      editor.id,
      gone
        ? `Your caption change was saved before this recollection was ${contribution.status}. It is no longer shown or used.`
        : now?.version !== applied
          ? `Your listening captions were saved as version ${applied}. A later version${now ? ` (version ${now.version})` : ''} is now current.`
          : applied === 1
            ? 'Your listening captions were saved as version 1.'
            : `Your listening captions were saved as version ${applied}; earlier versions stay listed. Shared views that used the earlier captions have stopped, and the owner needs a new preview and link to share this recording again.`,
    );
    // An editor still holding exactly what was saved closes; newer typing
    // stays, continuing from this save only while it is still current.
    if (!editor.open || savedText === editor.text.value) captionEditors.delete(editor.id);
    else if (now && now.version === applied) editor.base = now.sha256;
    // The save stays confirmed even when the list cannot be read again: the
    // outcome moves to the form message, which does not depend on the list.
    if ((await loadOwn()) === null && !disposed && mine === generation && place === target) {
      message.textContent = `${captionNotes.get(editor.id)} Your list could not be refreshed; reload the page to see it.`;
    }
  }

  // A deleted contribution's row. Accepting it settles any earlier deletion
  // attempt and leaves nothing of the contribution's own state in this page.
  function tombstoneRow(contribution) {
    deletions.delete(contribution.id);
    storePending(null, deletionKey(contribution.id));
    captionEditors.delete(contribution.id);
    captionNotes.delete(contribution.id);
    storePending(null, captionKey(contribution.id));
    const item = el('li', {}, [
      el('p', { className: 'collab-status', textContent: 'You deleted this recollection.' }),
      el('p', { className: 'hint', textContent: deletionStateText(contribution.deletion) }),
      el('p', { className: 'hint', textContent: DELETION_LIMITS }),
    ]);
    if (contribution.deletion?.state !== 'complete') {
      // Check again only reads; retrying cleanup is a separate explicit
      // request that resumes the accepted deletion and starts nothing new.
      const again = el('button', { type: 'button', className: 'secondary', textContent: 'Check again' });
      again.addEventListener('click', () => loadOwn());
      const retry = el('button', { type: 'button', className: 'secondary', textContent: 'Retry local cleanup' });
      retry.addEventListener('click', () => retryCleanup(contribution.id, retry));
      item.append(el('div', { className: 'actions' }, [again, retry]));
    } else cleanupNotes.delete(contribution.id);
    if (cleanupNotes.has(contribution.id)) item.append(el('p', { className: 'form-message', textContent: cleanupNotes.get(contribution.id) }));
    ownRows.set(contribution.id, item);
    return item;
  }

  // Applies an accepted deletion at once, before any list read: that row's
  // players stop, its URLs are released and it becomes the deleted record.
  // Other rows and the form stay as they are.
  function acceptTombstone(contribution) {
    const id = contribution.id;
    for (const entry of ownPlayers.filter((entry) => entry.id === id)) entry.player.dispose();
    ownPlayers = ownPlayers.filter((entry) => entry.id !== id);
    for (const entry of ownUrls.filter((entry) => entry.id === id)) URL.revokeObjectURL(entry.url);
    ownUrls = ownUrls.filter((entry) => entry.id !== id);
    const old = ownRows.get(id);
    const row = tombstoneRow(contribution);
    if (old && [...own.children].includes(old)) {
      if (typeof old.replaceWith === 'function') old.replaceWith(row);
      else own.replaceChildren(...[...own.children].map((child) => (child === old ? row : child)));
    }
    if (captionRecovery.children.length) showCaptionRecovery();
  }

  function renderOwn(contributions) {
    revokeOwn();
    const mine = generation;
    own.replaceChildren(
      ...contributions.map((contribution) => {
        // A deletion was accepted: it settles any earlier deletion attempt and
        // leaves nothing of the contribution's own state in this page.
        if (contribution.status === 'deleted') return tombstoneRow(contribution);
        const item = el('li', {}, [
          el('p', { className: 'collab-status', textContent: contributionStatusText(contribution) }),
          contribution.text === null
            ? el('p', { className: 'hint', textContent: contribution.photo || contribution.voice ? 'What you sent is no longer shown or used.' : 'The text is no longer shown.' })
            : contribution.text === ''
              ? el('p', { className: 'hint', textContent: 'No written words were sent.' })
              : el('p', { className: 'memory-text', textContent: contribution.text }),
        ]);
        ownRows.set(contribution.id, item);
        if (contribution.periodClaim) item.append(el('p', { className: 'hint', textContent: `Time as you remember it: ${contribution.periodClaim}` }));
        // Without words there are no word uses; the line above already says so.
        if (contribution.permissions || contribution.status === 'withdrawn') item.append(el('p', { className: 'hint', textContent: usesText(contribution) }));
        // Withdrawal ends caption changes; nothing of an editor or its
        // unconfirmed request is kept.
        if (contribution.status === 'withdrawn') {
          captionEditors.delete(contribution.id);
          storePending(null, captionKey(contribution.id));
        }
        if (contribution.voice && contribution.status !== 'withdrawn') {
          const voice = contribution.voice;
          item.append(
            el('p', {
              className: 'hint',
              textContent: `Your recording · ${recordingContext(voice)} ${recordingUsesText(voice)}`,
            }),
          );
          // The checked playback copy, only on the person's own Play.
          if (voice.available && voice.url && voice.audio) {
            const player = createStoryPlayer({
              story: { title: 'Your recording', cues: voice.captions?.cues ?? [], durationMs: voice.durationMs, audio: voice.audio },
              fetchAudio: (signal) => fetch(voice.url, { credentials: 'same-origin', cache: 'no-store', signal }),
            });
            ownPlayers.push({ id: contribution.id, player });
            item.append(player.element);
          } else item.append(el('p', { className: 'hint', textContent: 'Your recording is not available now.' }));
          const history = captionHistoryBox(voice);
          if (history) item.append(history);
          if (voice.available) item.append(captionControl(contribution));
        }
        if (captionNotes.has(contribution.id)) item.append(el('p', { className: 'form-message', textContent: captionNotes.get(contribution.id) }));
        if (contribution.photo && contribution.status !== 'withdrawn') {
          item.append(el('p', { className: 'hint', textContent: `Your photo · ${photoUsesText(contribution.photo)}` }));
          if (contribution.photo.available && contribution.photo.url) {
            const slot = el('div');
            item.append(slot);
            photoImage(contribution.photo.url, 'Your photo, as the owner sees it, without file details', contribution.id).then((image) => {
              if (disposed || mine !== generation || ownRows.get(contribution.id) !== item) return;
              slot.replaceChildren(image ?? el('p', { className: 'hint', textContent: 'The photo is not available now.' }));
            });
          } else item.append(el('p', { className: 'hint', textContent: 'The photo is not available now.' }));
        }
        if (contribution.status !== 'withdrawn') item.append(withdrawControl(contribution));
        item.append(deleteControl(contribution));
        return item;
      }),
    );
    status.textContent = contributions.length ? '' : 'Nothing sent yet.';
  }

  // Only the opaque request ID of a deletion not known to have been accepted.
  const deletionKey = (id) => (storeKey() ? `rehere:deletion-pending:${principal.id}:${place.draftId}:${place.jobId}:${id}` : null);
  const tombstoneAnswer = (result, id) => {
    const contribution = result.ok ? result.body?.contribution : null;
    return Boolean(contribution) && contribution.id === id && contribution.status === 'deleted' && ['access-stopped', 'complete'].includes(contribution.deletion?.state);
  };

  // Deleting: a preview of what it affects, an unchecked acknowledgment and
  // a final press. Nothing changes on the server before that press.
  function deleteControl(contribution) {
    const slot = el('div');
    const start = el('button', { type: 'button', className: 'secondary', textContent: 'Delete from Rehere…' });
    start.addEventListener('click', () => {
      const created = openDeletion(contribution.id, false);
      created.onCancel = () => slot.replaceChildren(start);
      slot.replaceChildren(created.wrap);
      loadDeletionPreview(created);
    });
    let d = deletions.get(contribution.id);
    if (!d && storedPending(deletionKey(contribution.id))) d = openDeletion(contribution.id, true);
    // A new list may mean a different impact: a shown or loading preview and
    // its acknowledgment are dropped. A sent request stays exactly as it was.
    if (d && !d.attempt && (d.preview || d.previewLoading)) {
      d.previewToken += 1;
      d.previewLoading = false;
      d.busy = false;
      d.preview = null;
      d.ack.checked = false;
      d.note.textContent = 'Your list changed. Review what deleting affects again before deleting.';
    }
    if (d) {
      d.onCancel = () => slot.replaceChildren(start);
      renderDeletion(d);
      slot.append(d.wrap);
    } else slot.append(start);
    return slot;
  }

  function openDeletion(id, lookup) {
    const d = {
      id,
      attempt: null,
      pendingId: lookup ? storedPending(deletionKey(id)) : null,
      preview: null,
      previewToken: 0,
      previewLoading: false,
      busy: false,
      onCancel: null,
      view: el('div'),
      ack: el('input', { type: 'checkbox' }),
      final: el('button', { type: 'button' }),
      check: el('button', { type: 'button', className: 'secondary', textContent: 'Check earlier deletion' }),
      review: el('button', { type: 'button', className: 'secondary', textContent: 'Review the deletion again' }),
      cancel: el('button', { type: 'button', className: 'secondary', textContent: 'Keep it' }),
      note: el('p', { className: 'form-message', role: 'alert', textContent: lookup ? 'An earlier deletion may have been accepted. Check it before doing anything else.' : '' }),
    };
    d.wrap = el('div', {}, [d.view, el('div', { className: 'actions' }, [d.cancel, d.review, d.check, d.final]), d.note]);
    d.ack.addEventListener('change', () => renderDeletion(d));
    d.final.addEventListener('click', () => deleteNow(d));
    d.review.addEventListener('click', () => loadDeletionPreview(d));
    d.cancel.addEventListener('click', () => {
      deletions.delete(d.id);
      d.onCancel?.();
    });
    // The list decides: a deleted row settles the earlier request; a row still
    // present does not prove it was refused.
    d.check.addEventListener('click', async () => {
      const mine = generation;
      d.busy = true;
      renderDeletion(d);
      await loadOwn();
      if (disposed || mine !== generation || deletions.get(d.id) !== d) return;
      d.busy = false;
      d.note.textContent = 'Your list still shows it. That does not prove the earlier deletion was refused; it may still be recorded. Check again later, or review the deletion again to make a new request.';
      renderDeletion(d);
    });
    deletions.set(id, d);
    return d;
  }

  function renderDeletion(d) {
    d.view.replaceChildren();
    if (d.preview) {
      const impact = d.preview.impact;
      d.view.append(
        el('p', { className: 'hint', textContent: `Deleting removes ${deletionMaterials(impact)} from this app's tracked storage on this computer. It cannot be undone. Withdrawing only stops use and keeps what you sent privately.` }),
        ...(impact.usedInPlace ? [el('p', { className: 'hint', textContent: 'It was used for this place. Saved scenes that depended on it stay blocked; their positions are kept without your material.' })] : []),
        ...(impact.sharedViewsAffected ? [el('p', { className: 'hint', textContent: 'Shared views and previews that use it stop for good, and what visitors would see from them is cleared.' })] : []),
        el('p', {
          className: 'hint',
          textContent: 'Linked copies are cleared too: the owner’s review notes about it, labels and time notes on alternatives made from it, and model suggestions based on scenes that used it. Other people’s own material is kept.',
        }),
        el('p', { className: 'hint', textContent: DELETION_LIMITS }),
        el('label', { className: 'memory-consent' }, [d.ack, ' I understand this deletion cannot be undone']),
      );
    }
    const unknown = Boolean(d.pendingId);
    d.final.textContent = d.attempt ? 'Delete again (same request)' : 'Delete permanently';
    d.final.hidden = !d.attempt && !d.preview;
    d.final.disabled = d.busy || (!d.attempt && d.ack.checked !== true);
    d.check.hidden = !unknown || Boolean(d.attempt);
    d.check.disabled = d.busy;
    d.review.hidden = Boolean(d.attempt) || Boolean(d.preview) || d.busy;
    d.cancel.hidden = unknown || d.busy;
  }

  async function loadDeletionPreview(d) {
    const mine = generation;
    const target = place;
    const token = ++d.previewToken;
    d.busy = true;
    d.previewLoading = true;
    d.preview = null;
    d.ack.checked = false;
    renderDeletion(d);
    const result = await request(`${scope()}/contributions/${d.id}/deletion`);
    if (disposed || mine !== generation || place !== target || deletions.get(d.id) !== d || token !== d.previewToken) return;
    d.busy = false;
    d.previewLoading = false;
    const body = result.body;
    if (result.ok && body?.state && body.state !== 'present') {
      // Already deleted: the list shows it.
      await loadOwn();
      return;
    }
    if (result.ok && body?.state === 'present' && body.impact && typeof body.impact === 'object' && /^[0-9a-f]{64}$/.test(body.impactSha256 ?? '')) {
      d.preview = { impact: body.impact, impactSha256: body.impactSha256 };
    } else d.note.textContent = `${reasonOf(result) || 'Rehere could not show what deleting would affect.'} Nothing was deleted.`;
    renderDeletion(d);
  }

  async function retryCleanup(id, button) {
    const mine = generation;
    const target = place;
    button.disabled = true;
    readToken += 1;
    const requestId = crypto.randomUUID();
    const result = await postJson(`${scope()}/contributions/${id}/delete`, { requestId, impactSha256: null, confirmDeletion: true });
    if (disposed || mine !== generation || place !== target) return;
    button.disabled = false;
    cleanupNotes.set(
      id,
      tombstoneAnswer(result, id)
        ? result.body.contribution.deletion.state === 'complete'
          ? 'Local cleanup finished.'
          : 'Local cleanup is still not finished. Every use stays stopped; you can try again later.'
        : unclear(result)
          ? 'Rehere could not confirm the cleanup retry. Every use stays stopped; check again or retry later.'
          : `${reasonOf(result)} Every use stays stopped.`,
    );
    if (tombstoneAnswer(result, id)) acceptTombstone(result.body.contribution);
    if ((await loadOwn()) === null && !disposed && mine === generation && place === target) message.textContent = `${cleanupNotes.get(id)} Your list could not be refreshed; reload the page to see it.`;
  }

  // One immutable request: pressing again after an unknown outcome repeats
  // it exactly. Late answers for another place or a closed screen are dropped.
  async function deleteNow(d) {
    if (d.busy || !place) return;
    let attempt = d.attempt;
    if (!attempt) {
      if (!d.preview || d.ack.checked !== true) return;
      const requestId = crypto.randomUUID();
      attempt = { requestId, body: { requestId, impactSha256: d.preview.impactSha256, confirmDeletion: true } };
    }
    const mine = generation;
    const target = place;
    d.attempt = attempt;
    d.pendingId = attempt.requestId;
    storePending(attempt.requestId, deletionKey(d.id));
    d.busy = true;
    d.note.textContent = '';
    renderDeletion(d);
    readToken += 1;
    let result = await postJson(`${scope()}/contributions/${d.id}/delete`, attempt.body);
    if (disposed || mine !== generation || place !== target || deletions.get(d.id) !== d) return;
    d.busy = false;
    if (result.ok && !tombstoneAnswer(result, d.id)) result = { ...result, ok: false, status: 0 };
    if (unclear(result)) {
      d.note.textContent = withReason(result, 'Rehere could not confirm whether the deletion was accepted. Pressing it again repeats the same request.');
      renderDeletion(d);
      return;
    }
    if (result.ok) {
      const done = result.body.contribution.deletion.state === 'complete';
      acceptTombstone(result.body.contribution);
      const note = done
        ? 'Deleted. It was removed from this app’s tracked storage on this computer.'
        : 'Deleted from use. Every use has stopped and its content is gone from Rehere’s records; removing its stored files is still finishing.';
      message.textContent = note;
      if ((await loadOwn()) === null && !disposed && mine === generation && place === target) message.textContent = `${note} Your list could not be refreshed; reload the page to see it.`;
      return;
    }
    // Signed out or not allowed says nothing about an earlier try.
    if (result.status === 401 || result.status === 403) {
      d.note.textContent = 'Rehere did not accept this because you are signed out or no longer allowed here. Whether an earlier try was accepted is still unknown.';
      message.textContent = d.note.textContent;
      renderDeletion(d);
      await loadOwn();
      return;
    }
    storePending(null, deletionKey(d.id));
    d.attempt = null;
    d.pendingId = null;
    if (result.status === 409) {
      // What it affects changed: a new preview and a new acknowledgment.
      await loadDeletionPreview(d);
      if (deletions.get(d.id) === d) d.note.textContent = `${reasonOf(result)} Nothing was deleted. Review what it affects again before deleting.`;
      return;
    }
    d.ack.checked = false;
    d.note.textContent = `${reasonOf(result) || 'It could not be deleted.'} Nothing was deleted.`;
    renderDeletion(d);
  }

  // Withdrawal takes two presses: it hides the words and any photo and
  // blocks every scene that used them.
  function withdrawControl(contribution) {
    const wrap = el('div', { className: 'actions' });
    const start = el('button', { type: 'button', className: 'secondary', textContent: 'Withdraw' });
    start.addEventListener('click', () => {
      const parts = [contribution.photo ? 'photo' : null, contribution.voice ? 'recording' : null].filter(Boolean);
      const confirm = el('button', { type: 'button', textContent: parts.length ? `Withdraw this recollection and its ${parts.join(' and ')}` : 'Withdraw this recollection' });
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Keep it' });
      cancel.addEventListener('click', () => wrap.replaceChildren(start));
      confirm.addEventListener('click', () => withdraw(contribution, confirm));
      wrap.replaceChildren(
        el('p', {
          className: 'hint',
          textContent: `Rehere will stop showing and using what you sent${parts.length ? `, including the ${parts.join(' and ')}` : ''}, and any scene or shared view that depends on it will be blocked. Rehere keeps what you sent privately; to remove it from this app's stored data, use Delete from Rehere. Copies someone already saved outside Rehere cannot be removed from here.`,
        }),
        cancel,
        confirm,
      );
    });
    wrap.append(start);
    return wrap;
  }

  async function withdraw(contribution, button) {
    const mine = generation;
    const target = place;
    readToken += 1;
    const body = withdrawAttempt.prepare(contribution.id, {}, () => ({ requestId: crypto.randomUUID() }));
    button.disabled = true;
    const result = await postJson(`${scope()}/contributions/${contribution.id}/withdraw`, body);
    if (disposed || mine !== generation || place !== target) return;
    button.disabled = false;
    if (unclear(result)) {
      message.textContent = withReason(result, 'Rehere could not confirm the withdrawal. Pressing it again repeats the same request.');
      return;
    }
    withdrawAttempt.settle();
    if (result.ok) {
      captionEditors.delete(contribution.id);
      storePending(null, captionKey(contribution.id));
    }
    message.textContent = result.ok
      ? `Withdrawn. Rehere no longer shows or uses ${withdrawnParts(contribution)}, and scenes and shared views that depended on it are blocked. Copies someone already saved outside Rehere are not affected.`
      : reasonOf(result) || 'The recollection could not be withdrawn.';
    await loadOwn();
  }

  // Reads this contributor's own recollections. An unknown send is settled
  // here: its request ID in the list means it arrived.
  async function loadOwn() {
    const mine = generation;
    const target = place;
    const token = ++readToken;
    const result = await request(`${scope()}/collaboration`);
    if (disposed || mine !== generation || place !== target || token !== readToken) return null;
    if (!result.ok || !Array.isArray(result.body?.contributions)) {
      // Nothing stays playable from a list that can no longer be confirmed.
      revokeOwn();
      own.replaceChildren();
      status.textContent = 'Your recollections could not be loaded. Try again later.';
      // Signed out or no longer allowed: no draft stays. Otherwise unsaved
      // caption text stays reachable with a way to read the list again.
      if (result.status === 401 || result.status === 403) {
        captionEditors.clear();
        deletions.clear();
      }
      showCaptionRecovery();
      return null;
    }
    captionRecovery.replaceChildren();
    renderOwn(result.body.contributions);
    if (pendingId && result.body.contributions.some((contribution) => contribution.requestId === pendingId)) {
      const sameForm = pendingInput && sameJson(pendingInput, collect()) && (attempt?.file ?? null) === photoFile && (attempt?.voice ?? null) === (recorder.snapshot().recording ?? null);
      setPending(null);
      if (sameForm) clearForm();
      message.textContent = sameForm
        ? 'Your earlier recollection arrived. The owner decides whether and how to use it.'
        : 'Your earlier recollection arrived. Your newer changes are still in the form; send them as a new recollection if you want.';
      return true;
    }
    return false;
  }

  function collect() {
    const take = recorder.snapshot().state === 'recorded' ? recorder.snapshot().recording : null;
    const caption = captionText.value;
    return {
      text: text.value,
      periodClaim: period.value,
      // Uses of the words exist only when there are words.
      permissions: text.value.trim() ? Object.fromEntries(Object.entries(grants).map(([key, box]) => [key, box.checked === true])) : null,
      voice: take
        ? {
            origin: { kind: 'own', reference: '' },
            dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
            permissions: Object.fromEntries(Object.entries(voiceGrants).map(([key, box]) => [key, box.checked === true])),
            captionText: caption,
            captionConfirmed: caption.trim() ? captionConfirm.checked === true : false,
          }
        : null,
      photo: photoFile
        ? {
            origin: { kind: photoOrigin.value, reference: photoReference.value.trim() },
            dates: {
              capturedOn: photoCaptured.value || null,
              fileCreatedAt: null,
              // Informational only: when the file was last written, not when it was taken.
              fileModifiedAt: Number.isFinite(photoFile.lastModified) && photoFile.lastModified > 0 ? new Date(photoFile.lastModified).toISOString() : null,
              estimatedPeriod: photoPeriod.value.trim(),
            },
            permissions: Object.fromEntries(Object.entries(photoGrants).map(([key, box]) => [key, box.checked === true])),
          }
        : null,
    };
  }

  const placeKey = (entry) => (entry ? `${entry.draftId}/${entry.jobId}` : null);
  function choose(next) {
    // The previous place keeps its finished take and unconfirmed attempt; any
    // capture in progress stops and the microphone is released.
    if (place) {
      const { state, recording } = recorder.snapshot();
      placeTakes.set(placeKey(place), {
        take: state === 'recorded' ? { blob: recording, captionText: captionText.value, captionConfirmed: captionConfirm.checked, grants: Object.fromEntries(Object.entries(voiceGrants).map(([key, box]) => [key, box.checked])) } : null,
        attempt,
        attemptId: pendingId,
      });
    }
    recorder.discard();
    generation += 1;
    captionEditors.clear();
    captionNotes.clear();
    deletions.clear();
    cleanupNotes.clear();
    captionRecovery.replaceChildren();
    place = next;
    // A send still pending for the previous place no longer holds this form.
    send.disabled = false;
    message.textContent = '';
    form.hidden = !place;
    revokeOwn();
    own.replaceChildren();
    pendingId = null;
    pendingInput = null;
    // Another place's exact attempt never travels under this place's ID.
    attempt = null;
    const stored = place ? storedPending() : null;
    setPending(stored);
    const kept = place ? placeTakes.get(placeKey(place)) : null;
    if (kept?.take && recorder.restore(kept.take.blob)) {
      captionText.value = kept.take.captionText;
      captionConfirm.checked = kept.take.captionConfirmed;
      for (const [key, value] of Object.entries(kept.take.grants)) voiceGrants[key].checked = value;
    }
    // Only this place's own unconfirmed attempt can be repeated here.
    if (kept?.attempt && stored && kept.attemptId === stored) attempt = kept.attempt;
    showUncertain(Boolean(stored));
    if (stored) message.textContent = 'An earlier recollection may not have reached Rehere. Checking…';
    if (place) {
      loadOwn().then((arrived) => {
        if (arrived !== false || !pendingId || pendingId !== stored) return;
        message.textContent = 'Rehere has no record of your earlier recollection yet; it may still arrive. You can check again, or start a new submission to send what the form holds now.';
      });
    }
  }

  placeSelect.addEventListener('change', () => choose(placesById.get(placeSelect.value) ?? null));
  startNew.addEventListener('click', () => {
    setPending(null);
    message.textContent = 'The next send starts a new submission with what the form holds now.';
  });
  send.addEventListener('click', async () => {
    if (!place) return;
    // An uncertain send from this session is repeated exactly as it was sent,
    // files included; newer edits stay in the form for a new submission.
    // After a reload only the earlier ID is known, never what it carried: it
    // is only looked up. Whatever the form holds now is a new submission.
    if (!attempt && pendingId) {
      const mine = generation;
      const target = place;
      send.disabled = true;
      const arrived = await loadOwn();
      if (disposed || mine !== generation || place !== target) return;
      send.disabled = false;
      if (arrived) return;
      showUncertain(true);
      message.textContent = 'Rehere has no record of your earlier recollection yet; it may still arrive. To send what the form holds now, start a new submission.';
      return;
    }
    const current = attempt ?? { input: collect(), file: photoFile, voice: recorder.snapshot().state === 'recorded' ? recorder.snapshot().recording : null };
    const problem = submissionProblem(current.input) ?? photoFieldsProblem(current.input.photo) ?? voiceProblem(current);
    if (problem) {
      message.textContent = problem;
      return;
    }
    const mine = generation;
    const target = place;
    // An uncertain send is repeated with its own ID; a new ID only for new work.
    const requestId = pendingId ?? crypto.randomUUID();
    setPending(requestId, current.input);
    attempt = current;
    send.disabled = true;
    readToken += 1;
    const { photo, voice, ...words } = current.input;
    let result;
    if (voice) {
      const form = new FormData();
      form.append('payload', JSON.stringify({ requestId, ...words, photo, voice }));
      if (photo) form.append('photo', current.file);
      form.append('voice', current.voice, 'recording');
      result = await request(`${scope()}/contributions/bundle`, { method: 'POST', body: form });
    } else if (photo) {
      const form = new FormData();
      form.append('payload', JSON.stringify({ requestId, ...words, photo }));
      form.append('photo', current.file);
      result = await request(`${scope()}/contributions/photo`, { method: 'POST', body: form });
    } else {
      result = await postJson(`${scope()}/contributions`, { requestId, ...words });
    }
    if (disposed || mine !== generation || place !== target) return;
    send.disabled = false;
    // A success without a readable contribution is not taken as sent.
    if (result.ok && typeof result.body?.id !== 'string') result = { ...result, ok: false, status: 0 };
    if (unclear(result)) {
      showUncertain(true);
      message.textContent = withReason(result, 'Rehere could not confirm whether it arrived. What you entered is still here; sending again repeats the same request.');
      return;
    }
    if (result.ok) {
      // Only a form still holding exactly what was sent is cleared.
      const sameForm = sameJson(collect(), current.input) && photoFile === current.file && (recorder.snapshot().recording ?? null) === (current.voice ?? null);
      setPending(null);
      if (sameForm) clearForm();
      message.textContent = sameForm ? 'Sent. The owner decides whether and how to use it.' : 'Your earlier recollection was sent. Your newer changes are still in the form; send them as a new recollection if you want.';
      await loadOwn();
      return;
    }
    if (result.status === 409) {
      // Busy, or the same request already holds something: the record decides.
      if (await loadOwn()) return;
      if (disposed || mine !== generation || place !== target) return;
      showUncertain(true);
      message.textContent = `${reasonOf(result) || 'Rehere could not accept it right now.'} It is not in your recollections yet. Send again to repeat the same request, or start a new submission.`;
      return;
    }
    // A definite refusal: nothing was kept for this request.
    setPending(null);
    message.textContent = `${reasonOf(result) || 'The recollection could not be sent.'}${photo ? ' If the photo is not accepted, export it as a JPEG or an 8-bit PNG and try again.' : ''}`;
  });

  const placesById = new Map();
  (async () => {
    const result = await request('/api/contributor/places');
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      placeSelect.replaceChildren(el('option', { value: '', textContent: 'Places could not be loaded' }));
      return;
    }
    for (const entry of result.body) placesById.set(`${entry.draftId}/${entry.jobId}`, entry);
    const labels = placeChoiceLabels(result.body);
    placeSelect.replaceChildren(
      el('option', { value: '', textContent: result.body.length ? 'Choose a place' : 'No scene is ready yet' }),
      ...result.body.map((entry, index) => el('option', { value: `${entry.draftId}/${entry.jobId}`, textContent: labels[index] })),
    );
    // A single place is chosen for the person only when its name could be read.
    if (result.body.length === 1 && result.body[0].nameUnavailable !== true) {
      placeSelect.value = `${result.body[0].draftId}/${result.body[0].jobId}`;
      choose(result.body[0]);
    }
  })();

  return {
    dispose() {
      disposed = true;
      generation += 1;
      captionEditors.clear();
      deletions.clear();
      revokeOwn();
      setPhoto(null);
      recorder.discard();
      releaseTakeAudio();
      unregister(takeOwner);
      container.replaceChildren();
    },
  };
}

// Owner-only invitations for one place. The one-use code is generated here and
// kept in memory until the owner closes it; it never goes into a URL or
// storage.
export function mountInvitations(container, { draftId }) {
  let disposed = false;
  const createAttempt = attempts();
  const list = el('ul', { className: 'collab-list' });
  const hours = select([[1, '1 hour'], [24, '1 day'], [72, '3 days']].map(([value, text]) => [String(value), text]), '24');
  const create = el('button', { type: 'button', className: 'secondary', textContent: 'Create an invitation' });
  const issued = el('div');
  const message = el('p', { className: 'form-message', role: 'alert' });

  const summary = el('summary', { textContent: 'Invite someone to add a recollection' });
  container.replaceChildren(
    el('details', { className: 'source-details collab-invitations' }, [
      summary,
      el('p', {
        className: 'hint',
        textContent:
          'An invitation lets one person join once and add written recollections to this place only. Share the code privately. It works only for someone who can reach this computer’s Rehere address; nothing is published on the internet.',
      }),
      field('Expires after', hours),
      el('div', { className: 'actions' }, [create]),
      issued,
      message,
      list,
    ]),
  );

  async function loadList() {
    const result = await request('/api/invitations');
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      message.textContent = 'Invitations could not be loaded.';
      return;
    }
    // The place is named from the owner's own authorized rows, when there are any.
    const named = result.body.find((invite) => invite.draftId === draftId && (typeof invite.nameUnavailable === 'boolean' || invite.placeName !== undefined));
    summary.textContent = !named
      ? 'Invite someone to add a recollection'
      : named.nameUnavailable === true
        ? 'Invite someone to add a recollection to this place (name unavailable)'
        : typeof named.placeName === 'string' && named.placeName !== ''
          ? `Invite someone to add a recollection to “${named.placeName}”`
          : 'Invite someone to add a recollection to this unnamed place';
    list.replaceChildren(
      ...result.body
        .filter((invite) => invite.draftId === draftId)
        .map((invite) => {
          const when = new Date(invite.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
          const item = el('li', {}, [el('span', { textContent: `${{ active: 'Unused', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired' }[invite.status] ?? invite.status} · expires ${when}` })]);
          if (invite.status === 'active') {
            const revoke = el('button', { type: 'button', className: 'secondary', textContent: 'Revoke' });
            revoke.addEventListener('click', async () => {
              revoke.disabled = true;
              const result = await postJson(`/api/invitations/${invite.id}/revoke`, {});
              if (disposed) return;
              revoke.disabled = false;
              message.textContent = result.ok
                ? 'Revoked. Anyone who already joined keeps their own recollections and can still withdraw them.'
                : withReason(result, 'The invitation could not be revoked.');
              await loadList();
            });
            item.append(revoke);
          }
          return item;
        }),
    );
  }

  create.addEventListener('click', async () => {
    const input = { expiresInHours: Number(hours.value) };
    const body = createAttempt.prepare(draftId, input, () => ({ requestId: crypto.randomUUID(), draftId, ...input, token: invitationToken() }));
    hours.disabled = true;
    create.disabled = true;
    const result = await postJson('/api/invitations', body);
    if (disposed) return;
    create.disabled = false;
    if (unclear(result)) {
      message.textContent = withReason(result, 'Rehere could not confirm the invitation. Pressing Create again repeats the same request with the same code.');
      return;
    }
    createAttempt.settle();
    hours.disabled = false;
    if (!result.ok) {
      message.textContent = reasonOf(result) || 'The invitation could not be created.';
      return;
    }
    message.textContent = '';
    const done = el('button', { type: 'button', className: 'secondary', textContent: 'I have shared it' });
    done.addEventListener('click', () => issued.replaceChildren());
    issued.replaceChildren(
      el('div', { className: 'access-keys' }, [
        el('p', { textContent: 'Invitation code. It is shown only now and works once:' }),
        el('div', { className: 'access-key' }, [el('code', { textContent: body.token })]),
        done,
      ]),
    );
    await loadList();
  });

  loadList();
  return {
    dispose() {
      disposed = true;
      container.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- owner review

// The owner's panel inside a ready scene. bridge: { jobUrl, editor(),
// showTransform(transform|null) -> boolean (true only when the 3D view drew
// it), setLocked(boolean), saved(edit), unconfirmed(), conflict(), blocked(),
// targets?, onChanged?, surfaceProblem? }. surfaceProblem(candidate) -> null |
// text, only on two-object scenes, checks the photographed surfaces of a
// candidate before it is adopted or kept as an alternative. onChanged() is
// called after a fresh read finds the
// recollections or alternatives changed. targets, only on two-object scenes: { selected() -> id | null,
// nameOf(id), describe(arrangement) }; a candidate then moves the selected
// object and carries its targetId, and editor() is that object's saved state.
// blocked() is called once when a refresh finds the current scene blocked, so
// the scene that depends on a withdrawn recollection stops being shown.
export function mountCollaboration(container, bridge) {
  let disposed = false;
  let state = null;
  let readToken = 0;
  let selectedId = null;
  let busy = false;
  // What the viewer is temporarily showing: a review candidate or a saved
  // alternative. Only one at a time; cleared before anything else is shown.
  let showing = null;
  let blockedReported = false;
  let lastSeen = null;
  // The review copy shown in the open review form; released when that form
  // is replaced or the panel closes, and late loads are dropped.
  let reviewPhotoUrl = null;
  let reviewPhotoToken = 0;
  // The review form's recording player, released with the form.
  let reviewPlayer = null;
  const releaseReviewPhoto = () => {
    reviewPhotoToken += 1;
    if (reviewPhotoUrl) URL.revokeObjectURL(reviewPhotoUrl);
    reviewPhotoUrl = null;
    reviewPlayer?.dispose();
    reviewPlayer = null;
  };
  const reviewAttempt = attempts();
  const eraAttempt = attempts();
  // Forms are kept while their record is unchanged, so typed input and a
  // prepared retry survive refreshes and editor state changes.
  let reviewForm = null;
  const eraForms = new Map();

  const status = el('p', { className: 'hint', role: 'status' });
  const message = el('p', { className: 'form-message', role: 'alert' });
  const list = el('ul', { className: 'collab-list' });
  const review = el('div', { className: 'collab-review' });
  const compare = el('div', { className: 'collab-compare' });
  const refreshButton = el('button', { type: 'button', className: 'secondary', textContent: 'Refresh', onclick: () => refresh() });
  // Owner navigation from one object's sources: the list can be narrowed to
  // recollections the owner adopted or kept for that object. List-only state;
  // it never selects, previews or changes a review.
  const objectFilter = el('div', { className: 'object-filter' });
  let filterId = null;
  let revealToken = 0;
  let revealNote = '';
  let filterHeading = null;

  container.replaceChildren(
    el('h4', { textContent: 'Recollections from others' }),
    el('p', {
      className: 'hint',
      textContent:
        'These are people’s own recollections, kept as written. They are separate from what the photo shows and from the model’s reconstruction, and none of them is checked as historical fact. Any change to the scene is one you set by hand.',
    }),
    el('div', { className: 'actions access-links' }, [refreshButton]),
    status,
    message,
    objectFilter,
    list,
    review,
    el('h4', { textContent: 'Compare saved scenes' }),
    compare,
  );

  function stopShowing() {
    if (!showing) return;
    showing = null;
    bridge.showTransform(null);
    bridge.setLocked(busy);
    if (state) renderCompare();
  }

  function show(kind, id, transform) {
    stopShowing();
    const drawn = bridge.showTransform(transform);
    showing = { kind, id, transform, drawn };
    bridge.setLocked(true);
    if (state) renderCompare();
    return drawn;
  }

  const contribution = () => state?.contributions.find((entry) => entry.id === selectedId) ?? null;
  const variantLabel = (id) => state?.variants.find((variant) => variant.id === id)?.label ?? 'another scene';

  // The object the owner adopted or kept a recollection for, as recorded.
  const usedFor = (entry) => (['adopted', 'alternative'].includes(entry.status) ? entry.review?.targetId ?? null : null);
  const matches = (entry) => Boolean(filterId) && usedFor(entry) === filterId;
  function render() {
    if (disposed || !state) return;
    const rows = filterId ? state.contributions.filter(matches) : state.contributions;
    renderFilter();
    list.replaceChildren(
      ...rows.map((entry) => {
        if (entry.status === 'deleted') {
          return el('li', {}, [
            el('p', { className: 'collab-status' }, [el('strong', { textContent: 'Removed contribution' }), ` · ${contributionStatusText(entry)}`]),
            el('p', { className: 'hint', textContent: deletionStateText(entry.deletion) }),
          ]);
        }
        const pick = el('button', { type: 'button', className: 'secondary', textContent: entry.id === selectedId ? 'Selected' : 'Review', disabled: entry.id === selectedId });
        pick.addEventListener('click', () => {
          stopShowing();
          selectedId = entry.id;
          message.textContent = '';
          render();
        });
        const item = el('li', {}, [
          el('p', { className: 'collab-status' }, [el('strong', { textContent: providerName(entry) }), ` · ${contributionStatusText(entry)}`]),
          entry.text === null
            ? el('p', { className: 'hint', textContent: 'Withdrawn by the person who wrote it. The text is no longer shown or used.' })
            : el('p', { className: 'memory-text', textContent: entry.text }),
        ]);
        if (entry.periodClaim && entry.text !== null) item.append(el('p', { className: 'hint', textContent: `Time as they remember it (their words, not checked): ${entry.periodClaim}` }));
        // Owner-only: which object the owner's decision used it for.
        if (bridge.targets && ['adopted', 'alternative'].includes(entry.status)) {
          const target = usedFor(entry);
          item.append(
            el('p', {
              className: 'hint',
              textContent: target ? `You ${entry.status === 'adopted' ? 'adopted this' : 'kept this as an alternative'} for ${bridge.targets.nameOf(target)}.` : 'The object for this arrangement was not recorded.',
            }),
          );
        }
        item.append(el('p', { className: 'hint', textContent: usesText(entry) }));
        if (entry.photo && entry.status !== 'withdrawn') item.append(el('p', { className: 'hint', textContent: `Photo included · ${photoUsesText(entry.photo)}` }));
        if (entry.voice && entry.status !== 'withdrawn') {
          item.append(el('p', { className: 'hint', textContent: `Recording included · ${recordingContext(entry.voice)} ${recordingUsesText(entry.voice)}` }));
          // A review keeps describing what it saw; later caption changes are named, never folded in.
          if (CAPTION_BINDING_TEXT[entry.review?.captionBinding]) item.append(el('p', { className: 'hint', textContent: CAPTION_BINDING_TEXT[entry.review.captionBinding] }));
          // Earlier caption versions stay inspectable on every row, final
          // decisions included, not only while a review is open.
          const history = captionHistoryBox(entry.voice);
          if (history) item.append(history);
        }
        // Only what the owner actually recorded; nothing for a withdrawn entry.
        const notes = [];
        if (entry.status !== 'withdrawn' && entry.review?.reason) notes.push(`Your note: ${entry.review.reason}`);
        if (entry.status !== 'withdrawn' && CONFLICTS[entry.review?.conflict]) notes.push(`Possible reason for a difference: ${CONFLICTS[entry.review.conflict]}`);
        if (notes.length) item.append(el('p', { className: 'hint', textContent: notes.join(' · ') }));
        if (!FINAL.has(entry.status)) item.append(pick);
        return item;
      }),
    );
    status.textContent = state.contributions.length ? '' : 'No recollections yet.';
    renderReview();
    renderCompare();
  }

  function renderReview() {
    const entry = contribution();
    if (!entry || FINAL.has(entry.status)) {
      reviewForm = null;
      releaseReviewPhoto();
      review.replaceChildren();
      return;
    }
    // The photo binding is part of what the form was built for: a photo that
    // became unavailable or changed rebuilds it, dropping the old image, the
    // acknowledgment and any candidate shown on the scene.
    const photoKey = photoBinding(entry.photo, entry.voice);
    if (reviewForm && reviewForm.id === entry.id && reviewForm.revision === entry.revision && reviewForm.status === entry.status && reviewForm.photoKey === photoKey) {
      reviewForm.refreshControls();
      return;
    }
    if (reviewForm && reviewForm.id === entry.id && reviewForm.photoKey !== photoKey && showing?.kind === 'candidate') stopShowing();
    releaseReviewPhoto();
    const editor = bridge.editor();
    const decision = select(DECISIONS.map((value) => [value, DECISION_LABELS[value]]), 'reviewing');
    // A photo-backed recollection: its review copy is shown beside the scene,
    // loaded only now, and a change from it needs the owner's own comparison.
    const photo = entry.photo ?? null;
    let photoState = photo ? (photo.available && photo.url ? 'loading' : 'unavailable') : 'none';
    const photoAck = el('input', { type: 'checkbox' });
    const photoSlot = el('div');
    const photoBox = photo
      ? el('figure', { className: 'anchor-figure' }, [
          photoSlot,
          el('figcaption', { className: 'hint', textContent: `Photo supplied by ${providerName(entry)}, shown without file details. ${photoFactsText(photo)} Not checked as historical fact; Rehere does not compare it with the scene.` }),
          el('label', { className: 'memory-consent' }, [photoAck, ' I compared this photo with the current scene myself; the position I set is my own judgment, not matched automatically']),
        ])
      : null;
    if (photoState === 'loading') {
      const token = reviewPhotoToken;
      photoSlot.replaceChildren(el('p', { className: 'hint', textContent: 'Loading the photo…' }));
      (async () => {
        let url = null;
        try {
          const response = await fetch(photo.url, { credentials: 'same-origin', cache: 'no-store' });
          if (response.ok) url = URL.createObjectURL(await response.blob());
        } catch {
          url = null;
        }
        if (disposed || token !== reviewPhotoToken) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        reviewPhotoUrl = url;
        const unavailable = () => {
          photoState = 'unavailable';
          photoAck.checked = false;
          if (showing?.kind === 'candidate') stopShowing();
          photoSlot.replaceChildren(el('p', { className: 'hint', textContent: 'This photo is not available now, so it cannot support a change. You can hold or decline it.' }));
          reviewForm?.refreshControls();
        };
        if (!url) {
          unavailable();
          return;
        }
        // Loaded means the image actually decoded and is on screen; a broken
        // image is unavailable and undoes the acknowledgment.
        const image = el('img', { className: 'space-proposal', src: url, alt: `Photo supplied by ${providerName(entry)}`, hidden: true });
        image.addEventListener('load', () => {
          if (disposed || token !== reviewPhotoToken) return;
          image.hidden = false;
          photoState = 'loaded';
          photoSlot.replaceChildren(image);
          reviewForm?.refreshControls();
        });
        image.addEventListener('error', () => {
          if (disposed || token !== reviewPhotoToken) return;
          unavailable();
        });
        photoSlot.append(image);
      })();
    } else if (photoState === 'unavailable') {
      photoSlot.replaceChildren(el('p', { className: 'hint', textContent: 'This photo is not available now, so it cannot support a change. You can hold or decline it.' }));
    }
    // A recording: played here on the owner's own press, from the checked
    // playback copy. The acknowledgment unlocks only after this form's player
    // actually started, and records only that the owner listened.
    const voice = entry.voice ?? null;
    let voicePlayed = false;
    const voiceAck = el('input', { type: 'checkbox', disabled: true });
    const voiceBox = voice ? el('figure', { className: 'anchor-figure' }) : null;
    if (voice) {
      const formToken = reviewPhotoToken;
      if (voice.available && voice.url && voice.audio) {
        reviewPlayer = createStoryPlayer({
          story: { title: `Recording by ${providerName(entry)}`, cues: voice.captions?.cues ?? [], durationMs: voice.durationMs, audio: voice.audio },
          fetchAudio: (signal) => fetch(voice.url, { credentials: 'same-origin', cache: 'no-store', signal }),
          onPlaying: () => {
            if (disposed || formToken !== reviewPhotoToken) return;
            voicePlayed = true;
            voiceAck.disabled = false;
            reviewForm?.refreshControls();
          },
        });
      }
      voiceBox.append(
        ...(reviewPlayer ? [reviewPlayer.element] : [el('p', { className: 'hint', textContent: 'This recording is not available now, so it cannot support a change. You can hold or decline it.' })]),
        el('figcaption', {
          className: 'hint',
          textContent: `Recording supplied by ${providerName(entry)}, kept as recorded. ${voice.captions ? `Captions version ${voice.captions.version ?? 1}, written by ${voice.captions.authorLabel}; not a transcript.` : ''} Not checked as historical fact; Rehere does not compare it with the scene.`.replace(/\s+/g, ' '),
        }),
        el('label', { className: 'memory-consent' }, [voiceAck, ' I listened to this recording myself; the position I set is my own judgment, not taken from the recording automatically']),
      );
    }
    const voiceProblemText = () => {
      if (!voice) return '';
      if (!voice.available || !voice.url || !voice.audio) return 'This recording is not available now, so it cannot support a change. You can hold or decline it.';
      if (voice.permissions?.place !== true) return 'The recording’s provider did not allow use to reconstruct the place, so this recollection cannot change the scene. You can hold or decline it.';
      if (!voicePlayed) return 'Play the recording here before using it for a change.';
      if (voiceAck.checked !== true) return 'Confirm that you listened to the recording yourself before previewing or saving.';
      return '';
    };
    voiceAck.addEventListener('change', () => {
      if (voiceAck.checked !== true && showing?.kind === 'candidate') stopShowing();
      reviewForm?.refreshControls();
    });
    const photoProblemText = () => {
      if (!photo) return '';
      if (photo.permissions?.place !== true) return 'The photo’s provider did not allow use to reconstruct the place, so this recollection cannot change the scene. You can hold or decline it.';
      if (photoState === 'loading') return 'Loading the photo…';
      if (photoState !== 'loaded') return 'This photo is not available now, so it cannot support a change. You can hold or decline it.';
      if (photoAck.checked !== true) return 'Confirm that you compared the photo with the scene yourself before previewing or saving.';
      return '';
    };
    const reason = el('textarea', { rows: 2, maxLength: REASON_LIMIT });
    const conflict = select(Object.entries(CONFLICTS), 'unknown');
    const composition = isComposition(editor);
    const axes = composition ? poseAxes.slice(0, 6).map(([name]) => name) : ['Left / right', 'Down / up', 'Away / toward', 'Turn (degrees)'];
    const savedValues = (state) => (composition ? poseValues(state).slice(0, 6) : [...state.offset, Math.round((state.yaw * 180) / Math.PI)]).map(String);
    // The fields show the saved position, the turn rounded to whole degrees.
    // A field the owner has not typed in keeps its exact saved value, so the
    // candidate never rounds what was left alone. Everything is bound to the
    // saved version this review was opened on.
    const formVersion = editor.version;
    const sceneMoved = () => bridge.editor().version !== formVersion;
    const exact = (state) => composition ? copyPose(state) : { offset: [...state.offset], yaw: state.yaw };
    let baseline = bridge.targets ? null : exact(editor);
    let edited = axes.map(() => false);
    const values = bridge.targets ? axes.map(() => '') : savedValues(editor);
    const inputs = axes.map((name, i) => {
      const input = el('input', { type: 'number', step: i >= 3 ? 1 : 0.01, min: composition ? i >= 3 ? -180 : -10 : i === 3 ? -180 : -OFFSET_LIMIT, max: composition ? i >= 3 ? 180 : 10 : i === 3 ? 180 : OFFSET_LIMIT, value: values[i] });
      input.setAttribute('aria-label', `Candidate ${name}`);
      return input;
    });
    // Two-object scenes: the fields belong to one object at a time. Each
    // object's typed values, edited fields and exact saved values are kept
    // separately, and an object seen for the first time starts from its own
    // saved position in this review's version, never another's.
    const targetDrafts = new Map();
    let fieldsTarget = null;
    const bindTarget = () => {
      if (!bridge.targets) return;
      const target = bridge.targets.selected();
      if (target === fieldsTarget) return;
      if (fieldsTarget) targetDrafts.set(fieldsTarget, { values: inputs.map((input) => input.value), edited, baseline });
      fieldsTarget = target;
      const saved = target ? bridge.editor(target) : null;
      const fresh = saved && saved.version === formVersion ? { values: savedValues(saved), edited: axes.map(() => false), baseline: exact(saved) } : null;
      const next = (target && targetDrafts.get(target)) ?? fresh ?? { values: axes.map(() => ''), edited: axes.map(() => false), baseline: null };
      edited = [...next.edited];
      baseline = next.baseline;
      inputs.forEach((input, i) => (input.value = next.values[i]));
    };
    const candidateBox = el('fieldset', { className: 'space-edit', hidden: true }, [
      el('legend', { textContent: 'Candidate position, set by hand' }),
      el('p', { className: 'hint', textContent: composition ? 'Set this object’s position and orientation in the owner composition. Its exact saved relative scale stays unchanged. This is your judgment from the recollection, not automatic alignment.' : 'Set where the object would be if this recollection is right. Rehere does not read a position from the words.' }),
      ...inputs.map((input, i) => el('div', { className: 'space-axis' }, [el('span', { textContent: axes[i] }), input])),
    ]);
    const preview = el('button', { type: 'button', className: 'secondary', textContent: 'Preview candidate on the scene' });
    const save = el('button', { type: 'button', textContent: 'Save decision' });
    const note = el('p', { className: 'hint' });

    const targetNote = el('p', { className: 'hint' });
    const candidate = () => {
      if (composition) {
        if (!baseline) return { targetId: fieldsTarget, pose: { position: [NaN, NaN, NaN], quaternion: [0, 0, 0, 1] } };
        let pose = copyPose(baseline);
        for (let axis = 0; axis < inputs.length; axis += 1) if (edited[axis]) { pose = poseWithAxis(pose, axis, inputs[axis].value); if (!pose) return { targetId: fieldsTarget, pose: { position: [NaN, NaN, NaN], quaternion: [0, 0, 0, 1] } }; }
        return { targetId: fieldsTarget, pose: { position: pose.position, quaternion: pose.quaternion } };
      }
      const numbers = inputs.map((input) => (input.value.trim() === '' ? NaN : Number(input.value)));
      const typed = (i) => edited[i] || !baseline;
      const transform = {
        offset: [0, 1, 2].map((i) => (typed(i) ? numbers[i] : baseline.offset[i])),
        yaw: typed(3) ? (numbers[3] * Math.PI) / 180 : baseline.yaw,
      };
      return bridge.targets ? { targetId: fieldsTarget, ...transform } : transform;
    };
    const noTarget = () => Boolean(bridge.targets) && (!bridge.targets.selected() || fieldsTarget !== bridge.targets.selected());
    const geometry = () => decision.value === 'adopt' || decision.value === 'alternative';
    const previewed = () => showing?.kind === 'candidate' && showing.drawn && sameJson(showing.transform, candidate());
    const refreshControls = () => {
      bindTarget();
      for (const input of inputs) input.disabled = noTarget();
      const editorNow = bridge.editor();
      candidateBox.hidden = !geometry();
      preview.hidden = !geometry();
      let reasonText = '';
      // A candidate belongs to the saved version this review opened on; after
      // another save it is neither shown nor saved, and nothing is rebased.
      if (geometry() && sceneMoved() && showing?.kind === 'candidate') stopShowing();
      if (geometry()) {
        if (sceneMoved()) reasonText = `The saved scene changed to version ${editorNow.version} after this review was opened on version ${formVersion}. Reload the page and reopen this review to start from the current saved scene; the values here are kept until then.`;
        else if (entry.permissions && entry.permissions.place !== true) reasonText = 'This recollection does not allow use to reconstruct the place, so it cannot change the scene. You can hold or decline it.';
        else if (voiceProblemText()) reasonText = voiceProblemText();
        else if (photoProblemText()) reasonText = photoProblemText();
        else if (state.blocked) reasonText = 'The current scene depends on a withdrawn recollection. Restore an unaffected saved version first.';
        else if (noTarget()) reasonText = 'Choose the object this recollection is about first; the candidate moves only that object.';
        else if (!editorNow.clean && !showing) reasonText = 'Save or revert your manual change, or finish the memory proposal, first.';
        else if (transformProblem(candidate())) reasonText = transformProblem(candidate());
        else if (!previewed()) reasonText = showing?.kind === 'candidate' && !showing.drawn
          ? 'The 3D view is not available, so the candidate could not be previewed. Without a preview it cannot be adopted or kept; you can hold or decline it.'
          : 'Preview the candidate on the scene before saving it.';
      }
      note.textContent = reasonText;
      targetNote.textContent = bridge.targets && !noTarget() ? `The candidate moves ${bridge.targets.nameOf(bridge.targets.selected())}; the other object stays as saved.` : '';
      preview.disabled = busy || sceneMoved() || noTarget() || Boolean(entry.permissions && entry.permissions.place !== true) || Boolean(photoProblemText()) || Boolean(voiceProblemText()) || Boolean(state.blocked) || Boolean(transformProblem(candidate())) || (!editorNow.clean && showing?.kind !== 'candidate');
      save.disabled = busy || (geometry() && Boolean(reasonText));
    };

    decision.addEventListener('change', () => {
      if (!geometry()) stopShowing();
      refreshControls();
    });
    photoAck.addEventListener('change', () => {
      // Without the acknowledgment no candidate stays on the scene.
      if (photoAck.checked !== true && showing?.kind === 'candidate') stopShowing();
      refreshControls();
    });
    inputs.forEach((input, i) => {
      input.addEventListener('input', () => {
        // Typing makes this field explicit, even when it ends up as shown.
        edited[i] = true;
        if (showing?.kind === 'candidate' && !sceneMoved() && !transformProblem(candidate())) show('candidate', entry.id, candidate());
        refreshControls();
      });
    });
    preview.addEventListener('click', () => {
      if (sceneMoved()) return;
      show('candidate', entry.id, candidate());
      refreshControls();
    });
    save.addEventListener('click', async () => {
      const input = {
        decision: decision.value,
        reason: reason.value,
        conflict: conflict.value,
        transform: geometry() ? candidate() : null,
        // A candidate is bound to the version it was set against.
        baseVersion: geometry() ? formVersion : bridge.editor().version,
        baseRevision: entry.revision,
        // Recorded only for a change informed by the photo.
        ...(photo && geometry() ? { photoReviewed: true } : {}),
        ...(voice && geometry() ? { voiceReviewed: true } : {}),
      };
      if (geometry() && sceneMoved()) return;
      if (photo && geometry() && photoProblemText()) return;
      if (voice && geometry() && voiceProblemText()) return;
      if (reason.value.length > REASON_LIMIT) {
        message.textContent = `Keep the note to ${REASON_LIMIT} characters or fewer.`;
        return;
      }
      // A hold sends nothing and keeps the candidate, its preview and the form.
      const held = geometry() ? bridge.surfaceProblem?.(input.transform) ?? null : null;
      if (held) {
        message.textContent = `${held} The saved scene is still version ${formVersion}; your candidate and decision are kept.`;
        return;
      }
      const body = reviewAttempt.prepare(entry.id, input, () => ({ requestId: crypto.randomUUID(), ...input }));
      await mutate(async () => {
        const result = await postJson(`${bridge.jobUrl}/contributions/${entry.id}/review`, body);
        if (disposed) return;
        if (unclear(result)) {
          if (input.decision === 'adopt') bridge.unconfirmed();
          message.textContent = withReason(result, 'Rehere could not confirm the decision. Saving again repeats the same request.');
          return;
        }
        reviewAttempt.settle();
        if (!result.ok) {
          if (result.status === 409 && input.decision === 'adopt') bridge.conflict();
          message.textContent = `${reasonOf(result) || 'The decision could not be saved.'} Nothing was changed by this attempt.`;
          return;
        }
        stopShowing();
        if (result.body?.edit) bridge.saved(result.body.edit);
        message.textContent = {
          adopt: 'Adopted. The current scene was saved as a new version that depends on this recollection.',
          alternative: 'Kept as a separate alternative. The current scene did not change.',
        }[input.decision] ?? 'Decision saved. The scene did not change.';
      });
    });

    review.replaceChildren(
      el('h4', { textContent: `Review ${providerName(entry)}’s recollection` }),
      field('Decision', decision),
      field('Your note (optional)', reason),
      field('Possible reason for a difference', conflict, 'A label for your own review. It does not decide which account is right or set a time.'),
      ...(photoBox ? [photoBox] : []),
      ...(voiceBox ? [voiceBox] : []),
      candidateBox,
      targetNote,
      note,
      el('div', { className: 'actions' }, [preview, save]),
    );
    reviewForm = { id: entry.id, revision: entry.revision, status: entry.status, photoKey, refreshControls };
    refreshControls();
  }

  function renderCompare() {
    const editor = bridge.editor();
    const choices = el('ul', { className: 'collab-list' });
    // Says exactly what the viewer draws: the saved scene only when nothing
    // temporary is shown.
    const shownNow = !showing
      ? null
      : showing.kind === 'candidate'
        ? 'a review candidate set by hand. It is not saved.'
        : `“${variantLabel(showing.id)}”. The current saved scene is unchanged.`;
    const current = el('li', {}, [
      el('span', { textContent: `Current saved scene, version ${editor.version}${showing ? ' (not shown)' : ' (shown)'}` }),
    ]);
    if (shownNow && showing.drawn) current.append(el('span', { className: 'hint', textContent: `Shown on the scene now: ${shownNow}` }));
    if (showing?.kind === 'variant') current.append(el('button', { type: 'button', className: 'secondary', textContent: 'Back to the current scene', onclick: () => { stopShowing(); render(); } }));
    choices.append(current);
    for (const variant of state.variants) {
      const item = el('li', {}, [el('span', { className: 'space-choice-label', textContent: variant.label })]);
      // A blocked alternative's details are redacted by the server; only its
      // label and the reason it cannot be used are shown.
      if (variant.blocked) {
        item.append(
          el('span', { className: 'hint', textContent: 'Blocked: it depends on a withdrawn recollection or a use that is not allowed.' }),
          el('span', { className: 'hint', textContent: 'Time details withheld after withdrawal.' }),
        );
      }
      else {
        item.append(el('span', { className: 'hint', textContent: `${describeEra(variant.era, variantLabel)} · ${variant.edit?.objects && bridge.targets ? bridge.targets.describe(variant.edit) : formatTransform(variant.edit)}` }));
        // A recollection-based alternative names the object the owner kept it for.
        if (bridge.targets && variant.contributionIds?.length) {
          item.append(el('span', { className: 'hint', textContent: variant.targetId ? `Kept for ${bridge.targets.nameOf(variant.targetId)}.` : 'The object for this arrangement was not recorded.' }));
        }
        const isShown = showing?.kind === 'variant' && showing.id === variant.id;
        const view = el('button', { type: 'button', className: 'secondary', textContent: isShown ? 'Shown' : 'Show on the scene', disabled: isShown || busy || (!bridge.editor().clean && !showing) });
        view.addEventListener('click', () => {
          if (!bridge.editor().clean && !showing) return;
          const drawn = show('variant', variant.id, variant.edit);
          message.textContent = drawn ? `Showing “${variant.label}”. The saved scene is unchanged.` : 'The 3D view is not available, so this alternative cannot be shown here.';
          render();
        });
        const cached = eraForms.get(variant.id);
        const form = cached?.eraRevision === variant.eraRevision ? cached.node : eraControl(variant);
        eraForms.set(variant.id, { eraRevision: variant.eraRevision, node: form });
        item.append(view, form);
      }
      choices.append(item);
    }
    compare.replaceChildren(choices);
  }

  function eraControl(variant) {
    const wrap = el('details', { className: 'source-details' }, [el('summary', { textContent: 'Record when this was' })]);
    const kind = select([['unknown', 'Unknown'], ['exact', 'A date'], ['range', 'A date range'], ['relative', 'Relative to something']], variant.era?.kind ?? 'unknown');
    const label = el('input', { type: 'text', maxLength: ERA_LABEL_LIMIT, value: variant.era?.label ?? '' });
    const start = el('input', { type: 'date', value: variant.era?.start ?? '' });
    const end = el('input', { type: 'date', value: variant.era?.end ?? '' });
    const others = state.variants.filter((other) => other.id !== variant.id);
    const relation = select([['', 'No comparison'], ['before', 'Before'], ['after', 'After'], ['same-time', 'Same time as']], variant.era?.relation ?? '');
    const relativeTo = select([['', 'Choose a scene'], ...others.map((other) => [other.id, other.label])], variant.era?.relativeToVariantId ?? '');
    const statement = el('textarea', { rows: 2, maxLength: ERA_STATEMENT_LIMIT });
    const confirmed = el('input', { type: 'checkbox' });
    const save = el('button', { type: 'button', textContent: 'Save time assertion' });
    const note = el('p', { className: 'form-message', role: 'alert' });
    save.addEventListener('click', async () => {
      const value = {
        kind: kind.value,
        label: kind.value === 'unknown' ? '' : label.value,
        start: ['exact', 'range'].includes(kind.value) ? start.value : null,
        end: kind.value === 'range' ? end.value : kind.value === 'exact' ? start.value : null,
        relation: kind.value === 'relative' && relation.value ? relation.value : null,
        relativeToVariantId: kind.value === 'relative' && relation.value ? relativeTo.value || null : null,
        statement: statement.value,
        confirmed: kind.value === 'unknown' ? false : confirmed.checked,
      };
      const problem = eraProblem(value);
      if (problem) {
        note.textContent = problem;
        return;
      }
      const input = { ...value, baseRevision: variant.eraRevision };
      const body = eraAttempt.prepare(variant.id, input, () => ({ requestId: crypto.randomUUID(), ...input }));
      await mutate(async () => {
        const result = await postJson(`${bridge.jobUrl}/variants/${variant.id}/era`, body);
        if (disposed) return;
        if (unclear(result)) {
          note.textContent = withReason(result, 'Rehere could not confirm this. Saving again repeats the same request.');
          return;
        }
        eraAttempt.settle();
        note.textContent = result.ok ? '' : reasonOf(result) || 'The time could not be saved.';
        if (result.ok) message.textContent = 'Saved as your assertion. Earlier assertions are kept, and no order between scenes was inferred.';
      });
    });
    wrap.append(
      el('p', { className: 'hint', textContent: 'This is your own assertion as the owner, kept separately from what contributors wrote. Same-time alternatives stay side by side; no order is inferred.' }),
      field('Kind', kind),
      field('Description', label),
      field('Date, or start of the range', start),
      field('End of the range', end),
      field('Compared with another scene', relation),
      field('Other scene', relativeTo),
      field('What this is based on', statement),
      el('label', { className: 'memory-consent' }, [confirmed, ' I assert this time myself; it is not verified']),
      el('div', { className: 'actions' }, [save]),
      note,
    );
    return wrap;
  }

  // Runs one write with the manual editor locked; reads started before it are
  // dropped and a fresh read follows.
  async function mutate(run) {
    busy = true;
    readToken += 1;
    bridge.setLocked(true);
    reviewForm?.refreshControls();
    try {
      await run();
    } finally {
      if (!disposed) {
        busy = false;
        bridge.setLocked(Boolean(showing));
        refresh();
      }
    }
  }

  // Resolves true for a valid fresh read, false for a failed one, and null
  // when a newer read replaced it (that read's own promise is latestRead).
  let latestRead = null;
  function refresh() {
    latestRead = readOnce();
    return latestRead;
  }
  async function readOnce() {
    const token = ++readToken;
    const result = await request(`${bridge.jobUrl}/collaboration`);
    if (disposed || token !== readToken) return null;
    if (!result.ok || !Array.isArray(result.body?.contributions) || !Array.isArray(result.body?.variants)) {
      status.textContent = 'Recollections could not be loaded. Try Refresh.';
      return false;
    }
    // Other panels (sharing) hear about a real change only: a fresh valid
    // read that differs from the last one seen, including a photo's
    // availability at the same revision. The first read is not a change.
    const seen = JSON.stringify([result.body.contributions, result.body.variants, result.body.blocked ?? false]);
    const changed = lastSeen !== null && seen !== lastSeen;
    lastSeen = seen;
    state = result.body;
    if (showing?.kind === 'variant' && !state.variants.some((variant) => variant.id === showing.id && !variant.blocked)) stopShowing();
    const candidateSource = showing?.kind === 'candidate' ? state.contributions.find((entry) => entry.id === showing.id) : null;
    if (showing?.kind === 'candidate' && (!candidateSource || FINAL.has(candidateSource.status))) stopShowing();
    if (state.blocked) {
      stopShowing();
      if (!blockedReported) {
        blockedReported = true;
        bridge.blocked?.();
        if (disposed) return;
      }
    }
    render();
    if (changed && !disposed) bridge.onChanged?.();
    return true;
  }

  function renderFilter() {
    if (!bridge.targets || (!filterId && !revealNote)) {
      objectFilter.replaceChildren();
      return;
    }
    const nodes = [];
    filterHeading = null;
    if (revealNote) nodes.push(el('p', { className: 'hint', role: 'status', textContent: revealNote }));
    if (filterId && state && revealNote) {
      // While a newer jump is reading or has failed, the list still shown is
      // the earlier one: say so, with no fresh count or "none".
      filterHeading = el('p', { className: 'hint', textContent: `Still showing the earlier results for ${bridge.targets.nameOf(filterId)}.` });
      nodes.push(filterHeading);
    } else if (filterId && state) {
      const shown = state.contributions.filter(matches).length;
      const unassigned = state.contributions.filter((entry) => ['adopted', 'alternative'].includes(entry.status) && !usedFor(entry)).length;
      const name = bridge.targets.nameOf(filterId);
      filterHeading = el('p', { className: 'hint', textContent: shown ? `Showing recollections used for ${name} (${shown}).` : `No recollection is recorded as used for ${name}.` });
      nodes.push(
        filterHeading,
        ...(unassigned ? [el('p', { className: 'hint', textContent: `${unassigned} without a recorded object ${unassigned === 1 ? 'is' : 'are'} under Show all.` })] : []),
      );
    }
    if (filterId || revealNote) nodes.push(el('div', { className: 'actions' }, [el('button', { type: 'button', className: 'secondary', textContent: 'Show all recollections', onclick: showAll })]));
    objectFilter.replaceChildren(...nodes);
  }

  // Shows only recollections used for one object, after a fresh read. Nothing
  // is declared before that read succeeds, and a late answer for a newer jump,
  // object or scene changes nothing.
  async function revealForObject(objectId, isCurrent) {
    const mine = ++revealToken;
    revealNote = `Reading recollections used for ${bridge.targets?.nameOf(objectId) ?? 'this object'}…`;
    renderFilter();
    // Follow only a genuinely newer read. A write that invalidated this read
    // without starting another leaves nothing to follow: this jump ends
    // without declaring anything, and the write's own refresh follows.
    let read = refresh();
    let ok = await read;
    while (ok === null && !disposed && latestRead !== read) {
      read = latestRead;
      ok = await read;
    }
    if (disposed || mine !== revealToken) return 'stale';
    if (ok === null || !isCurrent()) {
      revealNote = '';
      renderFilter();
      return 'stale';
    }
    if (!ok) {
      revealNote = `Recollections could not be read just now, so nothing is shown as used for ${bridge.targets?.nameOf(objectId) ?? 'this object'}. Try again.`;
      renderFilter();
      return 'failed';
    }
    revealNote = '';
    filterId = objectId;
    render();
    const target = list.children[0] ?? filterHeading ?? objectFilter;
    target.setAttribute?.('tabindex', '-1');
    target.focus?.();
    target.scrollIntoView?.({ block: 'nearest' });
    return 'shown';
  }

  function showAll() {
    revealToken += 1;
    revealNote = '';
    filterId = null;
    if (state) render();
    else renderFilter();
  }

  refresh();
  return {
    refresh,
    revealForObject,
    showAll,
    // Re-renders controls that depend on the manual editor's state.
    sync() {
      reviewForm?.refreshControls();
    },
    dispose() {
      disposed = true;
      readToken += 1;
      releaseReviewPhoto();
      if (showing) {
        showing = null;
        bridge.showTransform(null);
        bridge.setLocked(false);
      }
      container.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- blocked scene

// Shown instead of a scene whose current version depends on a withdrawn
// recollection. The only way forward offered is restoring a saved version that
// does not depend on it; that saves a new version.
// On a two-object scene, describe(arrangement) and ruleText(rule) name both
// objects, and currentRule is the blocked version's rule: a restore that
// changes it says so on the button, and pressing it confirms that change.
export function mountBlockedScene(container, { jobUrl, currentVersion, onRestored, describe = null, ruleText = null, currentRule = null }) {
  let disposed = false;
  const restoreAttempt = attempts();
  const message = el('p', { className: 'form-message', role: 'alert' });
  const list = el('ul', { className: 'collab-list' });
  container.replaceChildren(
    el('p', {
      textContent:
        'This scene depends on a recollection that was withdrawn, or on a use that is no longer allowed, so it is not shown. Its saved history is kept. Restore a saved version that does not depend on it to continue.',
    }),
    list,
    message,
  );

  (async () => {
    const result = await request(`${jobUrl}/history`);
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      message.textContent = 'The saved versions could not be loaded.';
      return;
    }
    const usable = result.body.filter((entry) => entry.version !== currentVersion && entry.blocked === false).sort((a, b) => b.version - a.version);
    if (!usable.length) message.textContent = 'No saved version without this dependency was found.';
    list.replaceChildren(
      ...usable.map((entry) => {
        const ruleChange = Boolean(entry.objects && describe) && JSON.stringify(entry.relationship ?? null) !== JSON.stringify(currentRule ?? null);
        const extra = entry.objects && describe ? { ruleChangeConfirmed: ruleChange } : {};
        const restore = el('button', {
          type: 'button',
          className: 'secondary',
          textContent: ruleChange ? `Restore version ${entry.version} and change the rule to “${ruleText(entry.relationship)}”` : `Restore version ${entry.version}`,
        });
        restore.addEventListener('click', async () => {
          const body = restoreAttempt.prepare(entry.version, { targetVersion: entry.version }, () => ({ requestId: crypto.randomUUID(), baseVersion: currentVersion, targetVersion: entry.version, ...extra }));
          restore.disabled = true;
          const outcome = await postJson(`${jobUrl}/undo`, body);
          if (disposed) return;
          restore.disabled = false;
          if (unclear(outcome)) {
            message.textContent = withReason(outcome, 'Rehere could not confirm the restore. Pressing it again repeats the same request.');
            return;
          }
          restoreAttempt.settle();
          if (!outcome.ok) {
            message.textContent = reasonOf(outcome) || 'That version could not be restored.';
            return;
          }
          onRestored();
        });
        return el('li', {}, [el('span', { textContent: `Version ${entry.version}: ${entry.objects && describe ? describe(entry) : formatTransform(entry)}` }), restore]);
      }),
    );
  })();

  return {
    dispose() {
      disposed = true;
      container.replaceChildren();
    },
  };
}
