import { proposalBlockedReason } from './memory-edit.js';
import { buildBlockedReason } from './photo-scene.js';

export const TEXT_LIMITS = Object.freeze({ provider: 120, attributedCreator: 120, reference: 2000, estimatedPeriod: 160 });

export const ORIGIN_LABELS = Object.freeze({
  unknown: 'Not specified',
  own: 'My own',
  public: 'Public source',
  other: 'Someone else',
});

export const PERMISSION_LABELS = Object.freeze({
  place: 'Use to reconstruct this place',
  model: 'Use for model processing',
  share: 'Share with others',
});

const PERMISSIONS = Object.keys(PERMISSION_LABELS);

// Every permission starts denied; nothing is granted unless a box is checked.
export function createSourceDetails() {
  return {
    provider: '',
    // Written sources only: who the words are attributed to, as the owner
    // states it. It is not the provider (who supplied the material).
    attributedCreator: '',
    originKind: 'unknown',
    reference: '',
    permissions: { place: false, model: false, share: false },
    capturedOn: '',
    estimatedPeriod: '',
  };
}

const VOICE_TAKE_STATES = new Set(['requesting', 'recording', 'finalizing', 'recorded']);

// Voice details belong to one take: from Record through the finished recording.
// When the take ends without a recording (discarded, cancelled or failed), its
// details and grants are dropped so they never attach to a later recording.
// A failed save or leaving the page keeps the recording, and so its details.
export function createVoiceSource(recorder, onReset) {
  let current = { details: createSourceDetails(), state: {} };
  let inTake = VOICE_TAKE_STATES.has(recorder.snapshot().state);
  recorder.subscribe(({ state }) => {
    const wasInTake = inTake;
    inTake = VOICE_TAKE_STATES.has(state);
    if (wasInTake && !inTake) {
      current = { details: createSourceDetails(), state: {} };
      onReset();
    }
  });
  return {
    get current() {
      return current;
    },
  };
}

export function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Returns a user-facing problem, or null when the details can be sent.
export function detailsProblem(details) {
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    if (details[key].trim().length > max) return `must be ${max.toLocaleString('en-US')} characters or fewer`;
  }
  if (details.capturedOn && !isCalendarDate(details.capturedOn)) return 'has a date that is not a real calendar date';
  return null;
}

// File.lastModified is when the file was last written, not when the photo was
// taken or the file created, so it maps only to fileModifiedAt.
export function toSourceInput(details, file = null, { attribution = false } = {}) {
  const lastModified = file?.lastModified;
  const creator = attribution ? details.attributedCreator.trim() : '';
  return {
    provider: details.provider.trim(),
    origin: { kind: details.originKind, reference: details.reference.trim() },
    permissions: Object.fromEntries(PERMISSIONS.map((key) => [key, details.permissions[key] === true])),
    dates: {
      capturedOn: details.capturedOn || null,
      fileCreatedAt: null,
      fileModifiedAt: Number.isFinite(lastModified) && lastModified > 0 ? new Date(lastModified).toISOString() : null,
      estimatedPeriod: details.estimatedPeriod.trim(),
    },
    ...(creator && { attributedCreator: creator }),
  };
}

// photos: [{ file, details }] in multipart order. Text metadata is sent only for
// text the server will keep, and voice metadata only with a recording.
export function buildMetadata({ photos, text, textDetails, voice, voiceDetails }) {
  return {
    photos: photos.map((photo) => toSourceInput(photo.details, photo.file)),
    text: text.trim() ? toSourceInput(textDetails, null, { attribution: true }) : null,
    voice: voice ? toSourceInput(voiceDetails) : null,
  };
}

export function summarize(details) {
  const granted = PERMISSIONS.filter((key) => details.permissions[key]).length;
  const origin = details.provider.trim() || ORIGIN_LABELS[details.originKind];
  const uses = granted === 0 ? 'no uses allowed' : `${granted} of 3 uses allowed`;
  return `${origin} · ${uses}`;
}

function formatCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
}

function formatTimestamp(value) {
  return new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// Rows for a saved source. A missing record means the memory predates source
// details, so nothing is shown as granted.
export function describeSource(record) {
  if (!record) {
    return {
      available: false,
      rows: [{ label: 'Source details', value: 'Unavailable for this item. No uses were granted.' }],
    };
  }
  const { dates, permissions } = record;
  const rows = [
    ...(record.kind === 'text' && record.attributedCreator ? [{ label: 'Attributed to (as stated by the owner)', value: record.attributedCreator }] : []),
    { label: 'Provided by', value: record.provider || 'Not specified' },
    { label: 'Source type', value: ORIGIN_LABELS[record.origin.kind] ?? ORIGIN_LABELS.unknown },
  ];
  if (record.origin.reference) rows.push({ label: 'Reference', value: record.origin.reference });
  for (const key of PERMISSIONS) {
    rows.push({ label: PERMISSION_LABELS[key], value: permissions[key] === true ? 'Allowed' : 'Not allowed' });
  }
  rows.push(
    { label: 'Date taken', value: dates.capturedOn ? formatCalendarDate(dates.capturedOn) : 'Unknown' },
    { label: 'Approximate period', value: dates.estimatedPeriod || 'Unknown' },
  );
  if (record.kind !== 'text') {
    rows.push(
      { label: 'File created (file metadata)', value: dates.fileCreatedAt ? formatTimestamp(dates.fileCreatedAt) : 'Unknown' },
      { label: 'File modified (file metadata)', value: dates.fileModifiedAt ? formatTimestamp(dates.fileModifiedAt) : 'Unknown' },
    );
  }
  rows.push({ label: 'Original checksum (SHA-256)', value: record.sha256 });
  return { available: true, rows };
}

let nextControlId = 0;

function field(doc, labelText, control, hintText) {
  const wrap = doc.createElement('div');
  wrap.className = 'source-field';
  control.id = `source-control-${++nextControlId}`;
  const label = doc.createElement('label');
  label.htmlFor = control.id;
  label.textContent = labelText;
  wrap.append(label, control);
  if (hintText) {
    const hint = doc.createElement('p');
    hint.className = 'hint';
    hint.id = `${control.id}-hint`;
    hint.textContent = hintText;
    control.setAttribute('aria-describedby', hint.id);
    wrap.append(hint);
  }
  return wrap;
}

function textInput(doc, details, key, onChange) {
  const input = doc.createElement('input');
  input.type = 'text';
  input.maxLength = TEXT_LIMITS[key];
  input.value = details[key];
  input.addEventListener('input', () => {
    details[key] = input.value;
    onChange();
  });
  return input;
}

// Builds collapsible controls that read and write `details` in place, so the
// state stays with the owning photo, text or recording across re-renders.
// `state.open` remembers whether the panel was expanded.
export function renderSourceControls(doc, { details, state, label, file = null, onChange = null, describedBy = null, attribution = false }) {
  const root = doc.createElement('details');
  root.className = 'source-details';
  root.open = Boolean(state.open);
  root.addEventListener('toggle', () => {
    state.open = root.open;
  });

  const summary = doc.createElement('summary');
  const title = doc.createElement('span');
  title.textContent = 'Source details';
  title.setAttribute('aria-label', `Source details for ${label}`);
  if (describedBy) summary.setAttribute('aria-describedby', describedBy);
  const status = doc.createElement('span');
  status.className = 'source-summary';
  summary.append(title, status);
  const refresh = () => {
    status.textContent = summarize(details);
    onChange?.();
  };
  refresh();

  const provider = textInput(doc, details, 'provider', refresh);
  const origin = doc.createElement('select');
  for (const [value, text] of Object.entries(ORIGIN_LABELS)) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    origin.append(option);
  }
  origin.value = details.originKind;
  origin.addEventListener('change', () => {
    details.originKind = origin.value;
    refresh();
  });

  const permissions = doc.createElement('fieldset');
  permissions.className = 'source-permissions';
  const legend = doc.createElement('legend');
  legend.textContent = 'Allowed uses';
  permissions.append(legend);
  for (const [key, text] of Object.entries(PERMISSION_LABELS)) {
    const row = doc.createElement('label');
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = details.permissions[key];
    box.addEventListener('change', () => {
      details.permissions[key] = box.checked;
      refresh();
    });
    row.append(box, ` ${text}`);
    permissions.append(row);
  }

  const captured = doc.createElement('input');
  captured.type = 'date';
  captured.value = details.capturedOn;
  captured.addEventListener('input', () => {
    details.capturedOn = captured.value;
  });
  // Some browsers draw an empty date input with a placeholder date, so an
  // empty input also says plainly that the date stays unknown. It only shows
  // or hides this line; the value is never set or inferred.
  const dateEmpty = doc.createElement('p');
  dateEmpty.className = 'hint';
  dateEmpty.textContent = 'No date entered; it will be saved as unknown.';
  const showDateEmpty = () => { dateEmpty.hidden = Boolean(captured.value); };
  captured.addEventListener('input', showDateEmpty);
  captured.addEventListener('change', showDateEmpty);
  showDateEmpty();
  const withDateEmpty = (wrap) => {
    dateEmpty.id = `${captured.id}-empty`;
    captured.setAttribute('aria-describedby', `${captured.id}-hint ${dateEmpty.id}`);
    wrap.append(dateEmpty);
    return wrap;
  };

  root.append(
    summary,
    ...(attribution ? [field(doc, 'Words attributed to', textInput(doc, details, 'attributedCreator', refresh), 'Optional. Who wrote or said these words, as you state it. Rehere does not verify it. Leave blank if unknown.')] : []),
    field(doc, 'Provided by', provider, 'A name or label for your own reference. Rehere does not verify it.'),
    field(doc, 'Source type', origin),
    field(doc, 'Reference', textInput(doc, details, 'reference', refresh), 'A link or note about where it came from.'),
    permissions,
    withDateEmpty(field(doc, 'Date taken', captured, 'Leave blank if unknown.')),
    field(doc, 'Approximate period', textInput(doc, details, 'estimatedPeriod', refresh), 'For example, summer 1998. Leave blank if unknown.'),
  );

  if (Number.isFinite(file?.lastModified) && file.lastModified > 0) {
    const note = doc.createElement('p');
    note.className = 'hint';
    note.textContent = `File metadata: last modified ${formatTimestamp(file.lastModified)}. This is not necessarily when the photo was taken.`;
    root.append(note);
  }
  return root;
}

// What each use of a new photo needs from its own settings, in the words of
// the checkboxes and the source type. Building and planning are decided by
// their canonical checks; a visit link follows the server's share check
// (public source with reconstruction and sharing; no model processing).
const NEEDS = {
  place: (record) => record.permissions.place === true,
  model: (record) => record.permissions.model === true,
  share: (record) => record.permissions.share === true,
  public: (record) => record.origin.kind === 'public',
};
const NEED_LABELS = { place: 'reconstruct this place', model: 'model processing', share: 'share with others', public: 'public source' };
export const PHOTO_USES = [
  { name: 'Build scene', needs: ['place', 'model'], permitted: (record) => buildBlockedReason(record) === null },
  { name: 'Memory edits', needs: ['place', 'model', 'public'], permitted: (record) => proposalBlockedReason(record) === null },
  { name: 'Visit link', needs: ['place', 'share', 'public'], permitted: (record) => ['place', 'share', 'public'].every((need) => NEEDS[need](record)) },
];

// For each use: null when the photo's settings permit it, otherwise the
// missing pieces by label.
export function photoUseNeeds(details) {
  const record = { kind: 'photo', ...toSourceInput(details) };
  return PHOTO_USES.map((use) => ({
    name: use.name,
    missing: use.permitted(record) ? null : use.needs.filter((need) => !NEEDS[need](record)).map((need) => NEED_LABELS[need]),
  }));
}

// Three short rows beside a new photo's Source details, the controls that
// change them. They describe only this photo's settings and never write them.
export function renderPhotoUses(doc, details, id) {
  const list = doc.createElement('ul');
  list.className = 'hint photo-uses';
  list.id = id;
  const rows = PHOTO_USES.map(() => doc.createElement('li'));
  list.append(...rows);
  const refresh = () => {
    photoUseNeeds(details).forEach(({ name, missing }, i) => {
      rows[i].textContent = missing ? `${name}: needs ${missing.join(' + ')}` : `${name}: permitted by these settings`;
    });
  };
  refresh();
  return { element: list, refresh };
}

export function renderSavedSource(doc, record) {
  const { available, rows } = describeSource(record);
  const root = doc.createElement('details');
  root.className = 'source-details';
  const summary = doc.createElement('summary');
  summary.textContent = available ? 'Source details' : 'Source details unavailable';
  const list = doc.createElement('dl');
  for (const { label, value } of rows) {
    const term = doc.createElement('dt');
    term.textContent = label;
    const description = doc.createElement('dd');
    description.textContent = value;
    list.append(term, description);
  }
  root.append(summary, list);
  return root;
}
