// Written recollections from invited contributors, the owner's manual review
// of them, saved alternatives with owner time assertions, and invitations.
// Nothing here reads meaning from a recollection: any change to the scene is
// a transform the owner sets by hand, previews on the real viewer and saves
// explicitly. Recollections, photos and model reconstructions stay separate
// kinds of evidence; none of them is shown as verified history.

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
const FINAL = new Set(['adopted', 'alternative', 'rejected', 'withdrawn']);

// A contributor photo: one JPEG or PNG, recognised by its first bytes, up to
// the raw limit. The server decodes it and remains the authority.
export const PHOTO_LIMIT_MB = 20;
const PHOTO_ORIGINS = { unknown: 'Not known', own: 'My own photo', public: 'A public source', other: 'Someone else' };
export async function photoProblem(file) {
  if (!file || file.size === 0) return 'That file is empty.';
  if (file.size > PHOTO_LIMIT_MB * 1024 * 1024) return `Choose a photo of ${PHOTO_LIMIT_MB} MB or less.`;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte);
  return jpeg || png ? null : 'Choose a JPEG or PNG photo.';
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
const photoBinding = (photo) => (photo ? JSON.stringify([photo.available === true, photo.url ?? null, photo.permissions ?? null]) : '');
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
      return 'Withdrawn. Rehere no longer shows or uses these words.';
    default:
      return 'Status unknown.';
  }
}

export function submissionProblem({ text, periodClaim }) {
  if (!text.trim()) return 'Write your recollection before sending it.';
  if (text.length > TEXT_LIMIT) return `Keep your recollection to ${TEXT_LIMIT.toLocaleString('en-US')} characters or fewer.`;
  if (periodClaim.length > PERIOD_LIMIT) return `Keep the time as you remember it to ${PERIOD_LIMIT} characters or fewer.`;
  return null;
}

export function transformProblem(transform) {
  if (!transform) return 'Set the candidate position first.';
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

const formatTransform = ({ offset, yaw }) =>
  `left/right ${offset[0].toFixed(2)}, down/up ${offset[1].toFixed(2)}, away/toward ${offset[2].toFixed(2)}, turn ${Math.round((yaw * 180) / Math.PI)}°`;

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
const usesText = (entry) => (entry.status === 'withdrawn' ? 'All further use withdrawn.' : grantsText(entry.permissions));

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
export function mountContributor(container, { principal = null } = {}) {
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
  let ownUrls = [];
  // Invalidates a photo check still reading a file, and own-list photo loads.
  let selectToken = 0;
  let ownToken = 0;

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
  const startNew = el('button', { type: 'button', className: 'secondary', textContent: 'Start a new submission instead', hidden: true });
  const uncertainNote = el('p', { className: 'hint' });
  const message = el('p', { className: 'form-message', role: 'alert' });
  const status = el('p', { className: 'hint', role: 'status' });
  const own = el('ul', { className: 'collab-list' });
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
    el('div', { className: 'actions' }, [startNew, send]),
    uncertainNote,
    message,
    el('h2', { textContent: 'What you have sent' }),
    el('p', { className: 'hint', textContent: 'You see what happened to each recollection. The owner’s private review notes are not shared with you.' }),
    status,
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
  function storePending(id) {
    const key = storeKey();
    if (!key) return;
    try {
      if (id) storage()?.setItem(key, id);
      else storage()?.removeItem(key);
    } catch {
      // Recovery then relies on checking this session only.
    }
  }
  function storedPending() {
    const key = storeKey();
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
    send.textContent = on ? 'Send again (same request)' : 'Send recollection';
    uncertainNote.textContent = on && attempt ? 'Sending again repeats exactly what was sent before, including its photo. Any newer changes in the form stay there for a new submission.' : '';
  }

  function revokeOwn() {
    ownToken += 1;
    for (const url of ownUrls) URL.revokeObjectURL(url);
    ownUrls = [];
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
  function clearForm() {
    text.value = '';
    period.value = '';
    for (const box of [...Object.values(grants), ...Object.values(photoGrants)]) box.checked = false;
    photoOrigin.value = 'unknown';
    photoReference.value = '';
    photoCaptured.value = '';
    photoPeriod.value = '';
    setPhoto(null);
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
  async function photoImage(url, alt) {
    const token = ownToken;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return null;
      const blob = await response.blob();
      // A later render or closing already released this list.
      if (disposed || token !== ownToken) return null;
      const objectUrl = URL.createObjectURL(blob);
      ownUrls.push(objectUrl);
      return el('img', { className: 'space-proposal', src: objectUrl, alt });
    } catch {
      return null;
    }
  }

  function renderOwn(contributions) {
    revokeOwn();
    const mine = generation;
    own.replaceChildren(
      ...contributions.map((contribution) => {
        const item = el('li', {}, [
          el('p', { className: 'collab-status', textContent: contributionStatusText(contribution) }),
          contribution.text === null
            ? el('p', { className: 'hint', textContent: contribution.photo ? 'Your words and photo are no longer shown or used.' : 'The text is no longer shown.' })
            : el('p', { className: 'memory-text', textContent: contribution.text }),
        ]);
        if (contribution.periodClaim) item.append(el('p', { className: 'hint', textContent: `Time as you remember it: ${contribution.periodClaim}` }));
        item.append(el('p', { className: 'hint', textContent: usesText(contribution) }));
        if (contribution.photo && contribution.status !== 'withdrawn') {
          item.append(el('p', { className: 'hint', textContent: `Your photo · ${photoUsesText(contribution.photo)}` }));
          if (contribution.photo.available && contribution.photo.url) {
            const slot = el('div');
            item.append(slot);
            photoImage(contribution.photo.url, 'Your photo, as the owner sees it, without file details').then((image) => {
              if (disposed || mine !== generation) return;
              slot.replaceChildren(image ?? el('p', { className: 'hint', textContent: 'The photo is not available now.' }));
            });
          } else item.append(el('p', { className: 'hint', textContent: 'The photo is not available now.' }));
        }
        if (contribution.status !== 'withdrawn') item.append(withdrawControl(contribution));
        return item;
      }),
    );
    status.textContent = contributions.length ? '' : 'Nothing sent yet.';
  }

  // Withdrawal takes two presses: it hides the words and any photo and
  // blocks every scene that used them.
  function withdrawControl(contribution) {
    const wrap = el('div', { className: 'actions' });
    const start = el('button', { type: 'button', className: 'secondary', textContent: 'Withdraw' });
    start.addEventListener('click', () => {
      const confirm = el('button', { type: 'button', textContent: contribution.photo ? 'Withdraw this recollection and its photo' : 'Withdraw this recollection' });
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Keep it' });
      cancel.addEventListener('click', () => wrap.replaceChildren(start));
      confirm.addEventListener('click', () => withdraw(contribution, confirm));
      wrap.replaceChildren(
        el('p', {
          className: 'hint',
          textContent: `Rehere will stop showing and using these words${contribution.photo ? ' and this photo' : ''}, and any scene that depends on them will be blocked. Copies someone already saved outside Rehere cannot be removed from here.`,
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
    message.textContent = result.ok
      ? `Withdrawn. Rehere no longer shows or uses these words${contribution.photo ? ' or this photo' : ''}, and scenes that depended on them are blocked.`
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
      status.textContent = 'Your recollections could not be loaded. Try again later.';
      return null;
    }
    renderOwn(result.body.contributions);
    if (pendingId && result.body.contributions.some((contribution) => contribution.requestId === pendingId)) {
      const sameForm = pendingInput && sameJson(pendingInput, collect()) && (attempt?.file ?? null) === photoFile;
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
    return {
      text: text.value,
      periodClaim: period.value,
      permissions: Object.fromEntries(Object.entries(grants).map(([key, box]) => [key, box.checked === true])),
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

  function choose(next) {
    generation += 1;
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
    showUncertain(Boolean(stored));
    if (stored) message.textContent = 'An earlier recollection may not have reached Rehere. Checking…';
    if (place) {
      loadOwn().then((arrived) => {
        if (arrived !== false || !pendingId || pendingId !== stored) return;
        message.textContent =
          'Rehere has no record of your earlier recollection yet. To retry it exactly, enter the same words and settings and choose the same photo, then press Send again. Or start a new submission.';
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
    // file included; newer edits stay in the form for a new submission. After
    // a reload only the ID is known, so the person re-enters the same input.
    const current = attempt ?? { input: collect(), file: photoFile };
    const problem = submissionProblem(current.input) ?? photoFieldsProblem(current.input.photo);
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
    const { photo, ...words } = current.input;
    let result;
    if (photo) {
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
      const sameForm = sameJson(collect(), current.input) && photoFile === current.file;
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
    placeSelect.replaceChildren(
      el('option', { value: '', textContent: result.body.length ? 'Choose a place' : 'No scene is ready yet' }),
      ...result.body.map((entry) => el('option', { value: `${entry.draftId}/${entry.jobId}`, textContent: entry.label })),
    );
    if (result.body.length === 1) {
      placeSelect.value = `${result.body[0].draftId}/${result.body[0].jobId}`;
      choose(result.body[0]);
    }
  })();

  return {
    dispose() {
      disposed = true;
      generation += 1;
      revokeOwn();
      setPhoto(null);
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

  container.replaceChildren(
    el('details', { className: 'source-details collab-invitations' }, [
      el('summary', { textContent: 'Invite someone to add a recollection' }),
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
// targets?, onChanged? }. onChanged() is called after a fresh read finds the
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
  const releaseReviewPhoto = () => {
    reviewPhotoToken += 1;
    if (reviewPhotoUrl) URL.revokeObjectURL(reviewPhotoUrl);
    reviewPhotoUrl = null;
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

  function render() {
    if (disposed || !state) return;
    list.replaceChildren(
      ...state.contributions.map((entry) => {
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
        item.append(el('p', { className: 'hint', textContent: usesText(entry) }));
        if (entry.photo && entry.status !== 'withdrawn') item.append(el('p', { className: 'hint', textContent: `Photo included · ${photoUsesText(entry.photo)}` }));
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
    const photoKey = photoBinding(entry.photo);
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
    const axes = ['Left / right', 'Down / up', 'Away / toward', 'Turn (degrees)'];
    const savedValues = (state) => [...state.offset, Math.round((state.yaw * 180) / Math.PI)].map(String);
    const values = bridge.targets ? ['', '', '', ''] : savedValues(editor);
    const inputs = axes.map((name, i) => {
      const input = el('input', { type: 'number', step: i === 3 ? 1 : 0.01, min: i === 3 ? -180 : -OFFSET_LIMIT, max: i === 3 ? 180 : OFFSET_LIMIT, value: values[i] });
      input.setAttribute('aria-label', `Candidate ${name}`);
      return input;
    });
    // Two-object scenes: the fields belong to one object at a time. Each
    // object's typed values are kept separately, and an object seen for the
    // first time starts from its own saved position, never another's.
    const targetDrafts = new Map();
    let fieldsTarget = null;
    const bindTarget = () => {
      if (!bridge.targets) return;
      const target = bridge.targets.selected();
      if (target === fieldsTarget) return;
      if (fieldsTarget) targetDrafts.set(fieldsTarget, inputs.map((input) => input.value));
      fieldsTarget = target;
      const next = !target ? ['', '', '', ''] : targetDrafts.get(target) ?? savedValues(bridge.editor(target));
      inputs.forEach((input, i) => (input.value = next[i]));
    };
    const candidateBox = el('fieldset', { className: 'space-edit', hidden: true }, [
      el('legend', { textContent: 'Candidate position, set by hand' }),
      el('p', { className: 'hint', textContent: 'Set where the object would be if this recollection is right. Rehere does not read a position from the words.' }),
      ...inputs.map((input, i) => el('div', { className: 'space-axis' }, [el('span', { textContent: axes[i] }), input])),
    ]);
    const preview = el('button', { type: 'button', className: 'secondary', textContent: 'Preview candidate on the scene' });
    const save = el('button', { type: 'button', textContent: 'Save decision' });
    const note = el('p', { className: 'hint' });

    const targetNote = el('p', { className: 'hint' });
    const candidate = () => {
      const numbers = inputs.map((input) => (input.value.trim() === '' ? NaN : Number(input.value)));
      const transform = { offset: numbers.slice(0, 3), yaw: (numbers[3] * Math.PI) / 180 };
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
      if (geometry()) {
        if (entry.permissions?.place !== true) reasonText = 'This recollection does not allow use to reconstruct the place, so it cannot change the scene. You can hold or decline it.';
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
      preview.disabled = busy || noTarget() || entry.permissions?.place !== true || Boolean(photoProblemText()) || Boolean(state.blocked) || Boolean(transformProblem(candidate())) || (!editorNow.clean && showing?.kind !== 'candidate');
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
    for (const input of inputs) {
      input.addEventListener('input', () => {
        if (showing?.kind === 'candidate' && !transformProblem(candidate())) show('candidate', entry.id, candidate());
        refreshControls();
      });
    }
    preview.addEventListener('click', () => {
      show('candidate', entry.id, candidate());
      refreshControls();
    });
    save.addEventListener('click', async () => {
      const input = {
        decision: decision.value,
        reason: reason.value,
        conflict: conflict.value,
        transform: geometry() ? candidate() : null,
        baseVersion: bridge.editor().version,
        baseRevision: entry.revision,
        // Recorded only for a change informed by the photo.
        ...(photo && geometry() ? { photoReviewed: true } : {}),
      };
      if (photo && geometry() && photoProblemText()) return;
      if (reason.value.length > REASON_LIMIT) {
        message.textContent = `Keep the note to ${REASON_LIMIT} characters or fewer.`;
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

  async function refresh() {
    const token = ++readToken;
    const result = await request(`${bridge.jobUrl}/collaboration`);
    if (disposed || token !== readToken) return;
    if (!result.ok || !Array.isArray(result.body?.contributions) || !Array.isArray(result.body?.variants)) {
      status.textContent = 'Recollections could not be loaded. Try Refresh.';
      return;
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
  }

  refresh();
  return {
    refresh,
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
