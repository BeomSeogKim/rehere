// Resumable saving. Save first records a plan on the server (an intake), then
// sends each file separately, then asks the server to turn the intake into a
// saved memory. Files the server already received are never sent again, and
// an unclear answer is resolved by asking about the same intake, never by
// starting a new one. Nothing here touches the page.
import { buildMetadata } from './source-details.js';

// No answer, a server error, or a rejection whose body is not the server's
// own {error: string} (a proxy page, a cut-off body): the outcome is unknown
// and the same request is repeated. Only a readable {error} is a refusal.
const unclear = (result) => result.status === 0 || result.status >= 500 || (!result.ok && typeof result.body?.error !== 'string');

async function call(fetchImpl, url, options = {}) {
  try {
    const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { status: 0, ok: false, body: null };
  }
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function intakeApi(fetchImpl, signal) {
  const base = '/api/intakes';
  const at = (id) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () => call(fetchImpl, base, { signal }),
    read: (id) => call(fetchImpl, at(id), { signal }),
    create: (body) => call(fetchImpl, base, { ...json(body), signal }),
    plan: (id, body) => call(fetchImpl, `${at(id)}/plan`, { ...json(body), signal }),
    commit: (id, body) => call(fetchImpl, `${at(id)}/commit`, { ...json(body), signal }),
    discard: (id, body) => call(fetchImpl, `${at(id)}/discard`, { ...json(body), signal }),
    part: (id, partId, blob) =>
      call(fetchImpl, `${at(id)}/parts/${encodeURIComponent(partId)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob, signal }),
    // The received bytes of one part of an open intake, or null.
    async partBytes(id, partId) {
      try {
        const response = await fetchImpl(`${at(id)}/parts/${encodeURIComponent(partId)}`, { credentials: 'same-origin', cache: 'no-store', signal });
        return response.ok ? await response.blob() : null;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return null;
      }
    },
  };
}

// Browser storage holds only opaque IDs, per owner: which intakes this
// browser started and, for one awaiting a final answer, its commit request.
// No text, names, settings or media. Unavailable storage is simply skipped.
export function pendingIds(storage, ownerId) {
  const key = `rehere:intakes:${ownerId}`;
  const read = () => {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? '[]');
      return Array.isArray(value) ? value.filter((entry) => typeof entry?.intakeId === 'string') : [];
    } catch {
      return [];
    }
  };
  const write = (entries) => {
    try {
      if (entries.length) storage?.setItem(key, JSON.stringify(entries.map(({ intakeId, commitRequestId }) => ({ intakeId, commitRequestId: commitRequestId ?? null }))));
      else storage?.removeItem(key);
    } catch {
      // Recovery then relies on the server's list of open intakes.
    }
  };
  return {
    read,
    add(intakeId) {
      if (!read().some((entry) => entry.intakeId === intakeId)) write([...read(), { intakeId, commitRequestId: null }]);
    },
    setCommit(intakeId, commitRequestId) {
      write([...read().filter((entry) => entry.intakeId !== intakeId), { intakeId, commitRequestId }]);
    },
    remove(intakeId) {
      write(read().filter((entry) => entry.intakeId !== intakeId));
    },
  };
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Display-only hints, trimmed to the server's limits. They never decide dates.
export function partHints(file) {
  const name = [...String(file?.name ?? '')].filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f).join('');
  let trimmed = '';
  for (const char of name) {
    if (trimmed.length + char.length > 255) break;
    trimmed += char;
  }
  const type = typeof file?.type === 'string' && /^[\x20-\x7e]{0,120}$/.test(file.type) ? file.type : '';
  const lastModified = Number.isInteger(file?.lastModified) && file.lastModified >= 0 && file.lastModified <= 8.64e15 ? file.lastModified : null;
  return { name: trimmed, type, lastModified };
}

// Only a well-formed answer is ever acted on: an open state with its plan and
// part states, or a terminal receipt. A success with an unreadable or
// malformed body is treated like no answer at all.
const PART_STATES = new Set(['missing', 'received', 'failed']);
export function isOpenState(body) {
  return (
    body?.status === 'open' &&
    typeof body.id === 'string' &&
    Number.isInteger(body.revision) &&
    typeof body.text === 'string' &&
    body.metadata !== null &&
    typeof body.metadata === 'object' &&
    Array.isArray(body.parts) &&
    body.parts.every((part) => typeof part?.partId === 'string' && (part.kind === 'photo' || part.kind === 'voice') && Number.isInteger(part.size) && typeof part.sha256 === 'string' && part.hints !== null && typeof part.hints === 'object' && PART_STATES.has(part.status))
  );
}
export function isTerminalState(body) {
  if (typeof body?.id !== 'string' || !Number.isInteger(body.revision)) return false;
  return (body.status === 'committed' && typeof body.draftId === 'string' && body.draftId !== '') || body.status === 'discarded';
}

// Key order never decides equality, and an absent value equals null.
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).filter((key) => value[key] !== null && value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value ?? null);

// Editable source details from a source input the server holds, keeping its
// strings and uses exactly (the input itself is kept as keptInput).
export function detailsFromSourceInput(input) {
  return {
    provider: input?.provider ?? '',
    originKind: input?.origin?.kind ?? 'unknown',
    reference: input?.origin?.reference ?? '',
    permissions: { place: input?.permissions?.place === true, model: input?.permissions?.model === true, share: input?.permissions?.share === true },
    capturedOn: input?.dates?.capturedOn ?? '',
    estimatedPeriod: input?.dates?.estimatedPeriod ?? '',
  };
}

// Gives every item the identity of its exact original: a part ID, size and
// hash. An item keeps its ID only while its file is unchanged.
export async function identify(item, newId = () => crypto.randomUUID()) {
  if (!item.file) return item;
  if (item.identity?.file === item.file) return item;
  const sha256 = await sha256Hex(item.file);
  const same = Boolean(item.partId) && item.sha256 === sha256 && item.size === item.file.size;
  item.identity = { file: item.file, partId: same ? item.partId : newId() };
  item.partId = item.identity.partId;
  item.sha256 = sha256;
  item.size = item.file.size;
  if (!same || !item.hints) item.hints = partHints(item.file);
  return item;
}

// A restored source input is sent back exactly as the server holds it while
// its settings are unchanged; once edited, the edited settings are sent with
// the file dates the server recorded, never dates from the restored file.
function restoredInput(fresh, details, kept) {
  if (!kept) return fresh;
  if (canonical(detailsFromSourceInput(kept)) === canonical(details)) return structuredClone(kept);
  return { ...fresh, dates: { ...fresh.dates, fileCreatedAt: kept.dates?.fileCreatedAt ?? null, fileModifiedAt: kept.dates?.fileModifiedAt ?? null } };
}

// The plan the form holds now. items: photos then at most one voice, each
// { kind, file|null, details, partId, sha256, size, hints, keptInput? }.
// keptInput is the source input a restored item had on the server.
export function planFrom({ text, photos, voice, textDetails, textKeptInput = null }) {
  const metadata = buildMetadata({
    photos: photos.map((item) => ({ details: item.details, file: item.file })),
    text,
    textDetails,
    voice: voice ? true : null,
    voiceDetails: voice?.details ?? null,
  });
  metadata.photos = metadata.photos.map((input, index) => restoredInput(input, photos[index].details, photos[index].keptInput));
  if (metadata.voice) metadata.voice = restoredInput(metadata.voice, voice.details, voice.keptInput);
  if (metadata.text) metadata.text = restoredInput(metadata.text, textDetails, textKeptInput);
  const part = (item) => ({ partId: item.partId, kind: item.kind, size: item.size, sha256: item.sha256, hints: item.hints });
  return { text, parts: [...photos.map(part), ...(voice ? [part(voice)] : [])], metadata };
}

const planOf = (state) => ({
  text: state.text,
  parts: state.parts.map(({ partId, kind, size, sha256, hints }) => ({ partId, kind, size, sha256, hints })),
  metadata: state.metadata,
});
// Whether a returned state is the plan this client recorded on base: the next
// revision with the whole plan equal, text, parts with hints, and every
// source setting. Anything else, even a plan that differs only in a granted
// use, is a newer plan from elsewhere and is never adopted or overwritten.
const isOurs = (state, intended, base) => state.revision === base + 1 && canonical(planOf(state)) === canonical(intended);

// One unfinished save. Outcomes of save():
//   { kind: 'saved', draftId }       the server confirmed a final saved memory
//   { kind: 'discarded' }            the intake was discarded (elsewhere)
//   { kind: 'unknown', stage }       no clear answer: retry repeats the same request
//   { kind: 'incomplete', state }    some files have not reached the server
//   { kind: 'conflict', state }      the intake changed elsewhere; nothing was overwritten
//   { kind: 'refused', message }     the server refused the request
export function createIntakeSession({ api, ids, newId = () => crypto.randomUUID() }) {
  let intakeId = null;
  let state = null;
  // The revision and full canonical plan this client explicitly intends: the
  // plan it created or changed and saw confirmed, or the one it resumed. Only
  // that state is ever adopted, uploaded to or committed.
  let expected = null;
  // Set once the intake holds a plan this client did not intend; from then on
  // nothing is changed or committed until the person resumes from the server.
  let conflicted = null;
  // A request whose outcome is unknown; it is repeated exactly.
  let pending = null;
  let commitRequestId = null;
  const rows = new Map();

  const terminal = (result) => {
    if (!isTerminalState(result)) return null;
    ids.remove(intakeId);
    return result.status === 'committed' ? { kind: 'saved', draftId: result.draftId } : { kind: 'discarded' };
  };
  const showParts = (next) => {
    for (const part of next.parts) rows.set(part.partId, { status: part.status, error: part.error });
  };
  // Explicit adoption: next must be the plan recorded by this client.
  const adopt = (next, recorded) => {
    state = next;
    expected = { revision: next.revision, plan: canonical(recorded) };
    showParts(next);
  };
  const conflict = (next) => {
    conflicted = { kind: 'conflict', state: next };
    return conflicted;
  };
  // A well-formed read of the intake, or none.
  const readState = async () => {
    const result = await api.read(intakeId);
    return isOpenState(result.body) || isTerminalState(result.body) ? { result, body: result.ok ? result.body : null } : { result, body: null };
  };
  // Progress of the intended plan. A terminal receipt settles it; an open state
  // with any other revision or content is a conflict and replaces nothing.
  const reread = async () => {
    const { body } = await readState();
    if (!body) return { unread: true };
    const done = terminal(body);
    if (done) return { done };
    if (body.revision !== expected.revision || canonical(planOf(body)) !== expected.plan) return { done: conflict(body) };
    state = body;
    showParts(body);
    return {};
  };

  // The request stays pending, to be repeated exactly, until a clear refusal
  // or a well-formed answer: a state for create and plan, a receipt for commit.
  async function send(stage, request, body) {
    pending = { stage, body };
    const result = await request(body);
    const wellFormed = stage === 'commit' ? isTerminalState(result.body) : isOpenState(result.body) || isTerminalState(result.body);
    if (unclear(result) || (result.ok && !wellFormed)) return { unknown: true };
    pending = null;
    return { result };
  }

  // The answer to a create, or to its replay: adopted only as this client's
  // own first revision; a newer plan already there is a conflict.
  function settleCreate(result, recorded) {
    const done = terminal(result.body);
    if (done) return done;
    if (!result.ok) return { kind: 'refused', message: result.body?.error ?? 'The save could not be started.' };
    if (!isOurs(result.body, recorded, 0)) return conflict(result.body);
    adopt(result.body, recorded);
    return null;
  }

  // The answer to a plan change, or to its replay: our plan on the next
  // revision is adopted; anything else stops without overwriting.
  async function settlePlan(result, recorded, base) {
    const done = terminal(result.body);
    if (done) return done;
    let current = result.ok && isOpenState(result.body) ? result.body : null;
    if (!current) {
      const read = await readState();
      if (!read.body) return { kind: 'unknown', stage: 'plan' };
      const finished = terminal(read.body);
      if (finished) return finished;
      current = read.body;
      if (result.status !== 409 && !isOurs(current, recorded, base)) return { kind: 'refused', message: result.body?.error ?? 'The change could not be recorded.' };
    }
    if (!isOurs(current, recorded, base)) return conflict(current);
    adopt(current, recorded);
    return null;
  }

  async function commit() {
    commitRequestId ??= newId();
    ids.setCommit(intakeId, commitRequestId);
    const { result, unknown } = await send('commit', (body) => api.commit(intakeId, body), { requestId: commitRequestId, baseRevision: expected.revision });
    if (unknown) return { kind: 'unknown', stage: 'commit' };
    const done = terminal(result.body);
    if (done) return done;
    // A refusal says nothing about which files: the intake itself does.
    const again = await reread();
    if (again.done) return again.done;
    if (!again.unread && state.parts.every((part) => part.status === 'received')) return { kind: 'refused', message: result.body?.error ?? 'The memory could not be saved.' };
    return { kind: 'incomplete', state };
  }

  return {
    get intakeId() {
      return intakeId;
    },
    get state() {
      return state;
    },
    get pending() {
      return pending?.stage ?? null;
    },
    row: (partId) => rows.get(partId) ?? { status: 'missing', error: null },
    // Continues an intake read from the server: resuming is the person's
    // explicit choice of that plan.
    resume(next) {
      intakeId = next.id;
      adopt(next, planOf(next));
      ids.add(intakeId);
    },
    // intended: planFrom(...); files: partId -> Blob for the parts the form holds.
    async save(intended, files, onRow = () => {}) {
      // 1. Settle a request whose outcome is unknown, exactly as it was sent.
      if (pending?.stage === 'commit') {
        const again = await reread();
        if (again.done) return again.done;
        if (again.unread) return { kind: 'unknown', stage: 'commit' };
        pending = null;
      } else if (pending) {
        const { stage, body } = pending;
        const repeat = await send(stage, stage === 'create' ? api.create : (request) => api.plan(intakeId, request), body);
        if (repeat.unknown) return { kind: 'unknown', stage };
        const { requestId, baseRevision, ...recorded } = body;
        const outcome = stage === 'create' ? settleCreate(repeat.result, recorded) : await settlePlan(repeat.result, recorded, baseRevision);
        if (outcome) return outcome;
        // The form may have changed since; it is recorded below as a new plan.
      }
      if (conflicted) return conflicted;
      // 2. Record the plan: a new intake, or a compare-and-swap change.
      if (!intakeId) {
        intakeId = newId();
        ids.add(intakeId);
        const created = await send('create', api.create, { requestId: intakeId, ...intended });
        if (created.unknown) return { kind: 'unknown', stage: 'create' };
        if (!created.result.ok && !isTerminalState(created.result.body)) {
          ids.remove(intakeId);
          intakeId = null;
          return { kind: 'refused', message: created.result.body?.error ?? 'The save could not be started.' };
        }
        const outcome = settleCreate(created.result, intended);
        if (outcome) return outcome;
      } else if (canonical(intended) !== expected.plan) {
        const base = expected.revision;
        const changed = await send('plan', (body) => api.plan(intakeId, body), { requestId: newId(), baseRevision: base, ...intended });
        if (changed.unknown) return { kind: 'unknown', stage: 'plan' };
        const outcome = await settlePlan(changed.result, intended, base);
        if (outcome) return outcome;
      }
      // 3. Send only the parts the server has not received.
      let sentAny = false;
      for (const part of state.parts) {
        if (rows.get(part.partId)?.status === 'received' || !files.has(part.partId)) continue;
        rows.set(part.partId, { status: 'sending', error: null });
        onRow(part.partId);
        const result = await api.part(intakeId, part.partId, files.get(part.partId));
        sentAny = true;
        const acknowledged = result.ok && result.body?.status === 'received' && result.body.partId === part.partId;
        rows.set(part.partId, acknowledged ? { status: 'received', error: null } : { status: unclear(result) || result.ok ? 'unknown' : 'failed', error: null });
        onRow(part.partId);
      }
      if (sentAny || state.parts.some((part) => rows.get(part.partId)?.status !== 'received')) {
        const again = await reread();
        if (again.done) return again.done;
        if (again.unread) return { kind: 'incomplete', state };
      }
      // 4. Ask for the final saved memory once everything of the intended plan
      // is received.
      if (state.parts.every((part) => part.status === 'received')) return commit();
      return { kind: 'incomplete', state };
    },
    async discard() {
      if (!intakeId) return { kind: 'discarded' };
      const result = await api.discard(intakeId, { requestId: newId() });
      if (unclear(result)) return { kind: 'unknown', stage: 'discard' };
      const done = terminal(result.body);
      if (done) return done;
      // A success without a readable receipt is not taken as discarded.
      if (result.ok) return { kind: 'unknown', stage: 'discard' };
      return { kind: 'refused', message: result.body?.error ?? 'The unfinished save could not be discarded.' };
    },
  };
}
