import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { INTAKE_RECEIPT, LIMITS, RequestError, detectMedia, parsePlaceName } from './drafts.mjs';
import { MediaVerificationError, POLICY_SHA256, attestation, attested } from './media-verification.mjs';
import { parseSourceMetadata } from './sources.mjs';

// Resumable input: files and settings received after an explicit Save, kept
// per part until one final commit turns them into an ordinary saved draft.
// An intake is temporary server progress, never a saved memory. There is no
// automatic expiry in this unit; open intakes stay until committed or discarded.
// One process coordinates writes; recovery covers process restarts only.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// RegExp.test converts its argument to a string, so an array holding a UUID
// would pass; every client UUID must be an actual string.
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const CONTROL = /[\u0000-\u001f\u007f]/;
const PRINTABLE = /^[ -~]*$/;
const MAX_TIME_MS = 8.64e15;
export const INTAKE_LIMITS = Object.freeze({ ...LIMITS, aggregateBytes: 64 * 1024 * 1024, bodyBytes: 512 * 1024 });
const UNREADABLE = 'The upload plan could not be read.';
const UNAVAILABLE = 'This upload cannot be checked right now. Nothing was changed.';
const PART_CODES = new Set(['empty', 'size', 'hash', 'type', 'content', 'pixels', 'duration']);
const NOT_RECEIVED = 'Some files have not been received yet.';
// A part refused by its full decode stays refused: its stored bytes are never recovered.
const DECODE_REFUSALS = new Set(['content', 'pixels', 'duration']);
const CHANGED_DURING_CHECK = 'Some files changed while they were being checked. Reload the upload and save again.';

const fail = (status, message) => new RequestError(status, message);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parsePart(part) {
  const valid = exactKeys(part, ['partId', 'kind', 'size', 'sha256', 'hints']) && isUuid(part.partId)
    && (part.kind === 'photo' || part.kind === 'voice') && Number.isInteger(part.size) && part.size >= 0
    && typeof part.sha256 === 'string' && SHA256.test(part.sha256)
    && exactKeys(part.hints, ['name', 'type', 'lastModified'])
    && typeof part.hints.name === 'string' && part.hints.name.length <= 255 && !CONTROL.test(part.hints.name)
    && typeof part.hints.type === 'string' && part.hints.type.length <= 120 && PRINTABLE.test(part.hints.type)
    && (part.hints.lastModified === null || (Number.isInteger(part.hints.lastModified) && part.hints.lastModified >= 0 && part.hints.lastModified <= MAX_TIME_MS));
  if (!valid) throw fail(400, UNREADABLE);
  const { name, type, lastModified } = part.hints;
  return { partId: part.partId, kind: part.kind, size: part.size, sha256: part.sha256, hints: { name, type, lastModified } };
}

// A whole plan: raw text kept exactly, planned parts, source settings in the
// existing strict schema, and the optional place name (omitted means none).
// Blank text counts as no text, as at commit; a name alone is no content.
function parsePlan({ text, parts, metadata, placeName }, limits) {
  if (typeof text !== 'string' || !Array.isArray(parts)) throw fail(400, UNREADABLE);
  if (text.length > limits.textChars) throw fail(413, `The written memory must be ${limits.textChars.toLocaleString('en-US')} characters or fewer.`);
  const parsed = parts.map(parsePart);
  if (new Set(parsed.map((part) => part.partId)).size !== parsed.length) throw fail(400, UNREADABLE);
  const photos = parsed.filter((part) => part.kind === 'photo');
  const voices = parsed.filter((part) => part.kind === 'voice');
  if (photos.length > limits.photoCount) throw fail(413, `Up to ${limits.photoCount} photos can be saved at once.`);
  if (voices.length > 1) throw fail(400, 'Only one voice recording can be saved.');
  if (photos.some((part) => part.size > limits.photoBytes)) throw fail(413, `Each photo must be ${limits.photoBytes / (1024 * 1024)} MB or smaller.`);
  if (voices.some((part) => part.size > limits.voiceBytes)) throw fail(413, `A voice recording must be ${limits.voiceBytes / (1024 * 1024)} MB or smaller.`);
  if (parsed.reduce((sum, part) => sum + part.size, 0) > limits.aggregateBytes) throw fail(413, 'Everything saved at once must total 64 MB or less.');
  const hasText = text.trim() !== '';
  if (!hasText && parsed.length === 0) throw fail(400, 'Add a photo, a written memory or a voice recording before saving.');
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw fail(400, 'The source details could not be read.');
  const sources = parseSourceMetadata(JSON.stringify(metadata), { photoCount: photos.length, hasText, hasVoice: voices.length === 1 });
  if (!sources) throw fail(400, 'The source details could not be read.');
  return { text, parts: parsed, metadata, placeName: parsePlaceName(placeName) };
}

// Unnamed plans keep the exact earlier digest, so open intakes, replays and
// receipts made before names existed still match; a name extends it.
const planDigest = (plan) => sha256(JSON.stringify(plan.placeName === null
  ? [plan.text, plan.parts, plan.metadata] : [plan.text, plan.parts, plan.metadata, plan.placeName]));
// The plan body keys, with the optional place name.
const planKeys = (body, keys) => exactKeys(body, keys) || exactKeys(body, [...keys, 'placeName']);
const identity = (part) => JSON.stringify([part.partId, part.kind, part.size, part.sha256]);

// One part with new state; a part that is not received keeps no verification.
function withPart(record, part, changes) {
  return {
    ...record, updatedAt: new Date().toISOString(),
    parts: record.parts.map((item) => {
      if (item !== part) return item;
      const next = { ...item, ...changes };
      if (next.status !== 'received') delete next.verification;
      return next;
    }),
  };
}

// Terminal states keep only identifiers and digests, never content.
function terminal(record) {
  return {
    id: record.id, status: record.status, revision: record.revision,
    ...(record.draftId !== undefined && record.status === 'committed' && { draftId: record.draftId }),
    ...(record.receipt && { receipt: { ...record.receipt } }),
  };
}

function projectOpen(record) {
  return {
    id: record.id, status: 'open', revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
    text: record.text, metadata: record.metadata, placeName: record.placeName ?? null,
    // The private verification record is never projected; the part shape is unchanged.
    parts: record.parts.map(({ verification, ...part }) => ({ ...part, hints: { ...part.hints } })),
  };
}

export const projectIntake = (record) => (record.status === 'open' ? projectOpen(record) : terminal(record));

export class IntakeStore {
  // `verifier` decodes each file in full (media-verification.mjs); without one
  // no file can be accepted and checks answer as unavailable.
  constructor({ dataDir, drafts, limits = INTAKE_LIMITS, verifier = null }) {
    this.root = path.join(dataDir, 'intakes');
    this.drafts = drafts;
    this.limits = limits;
    this.verifier = verifier;
    this.queue = Promise.resolve();
    this.swept = false;
    this.shutdown = new AbortController();
    // Decodes in progress, keyed by exact part identity, detected type and policy.
    this.inflight = new Map();
  }

  // Stops accepting and publishing, then waits for queued record work.
  async close() {
    this.shutdown.abort();
    await this.serialize(() => {}).catch(() => {});
  }

  #running(kind) {
    if (this.shutdown.signal.aborted) throw new MediaVerificationError('aborted', kind);
  }

  // Every task runs alone. The first one after a start removes temporary
  // files left by an interrupted process; later tasks leave them alone, since
  // an upload in progress writes its temporary file outside the mutex.
  serialize(task) {
    const run = this.queue.then(async () => {
      if (!this.swept) {
        await this.#sweep();
        this.swept = true;
      }
      return task();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async #sweep() {
    let ids = [];
    try {
      ids = (await readdir(this.root)).filter((name) => isUuid(name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const id of ids) {
      for (const dir of [this.#dir(id), path.join(this.#dir(id), 'parts')]) {
        const names = await readdir(dir).catch(() => []);
        for (const name of names) if (name.endsWith('.tmp')) await rm(path.join(dir, name), { force: true });
      }
    }
  }

  #dir(id) {
    return path.join(this.root, id);
  }

  #partFile(id, partId) {
    return path.join(this.#dir(id), 'parts', `${partId}.bin`);
  }

  async #read(id) {
    if (!isUuid(id)) return null;
    try {
      return JSON.parse(await readFile(path.join(this.#dir(id), 'intake.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #write(record) {
    const file = path.join(this.#dir(record.id), 'intake.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return record;
  }

  async #cleanup(id) {
    await rm(path.join(this.#dir(id), 'parts'), { recursive: true, force: true }).catch(() => {});
  }

  // Validates bytes against one planned part. Returns { detectedType } or { code }.
  #check(part, bytes) {
    if (bytes.length === 0) return { code: 'empty' };
    if (bytes.length !== part.size) return { code: 'size' };
    if (sha256(bytes) !== part.sha256) return { code: 'hash' };
    const media = detectMedia(part.kind, bytes);
    return media.error ? { code: 'type', message: media.error } : { detectedType: media.type, extension: media.extension };
  }

  // Run first, under the mutex, by every read and mutation. The reserved
  // draft folder decides: a matching receipt makes the intake committed (even
  // after a crash or lost update); a conflicting one fails closed. For an open
  // intake, part files are reconciled with the current plan.
  async #resolve(id) {
    const record = await this.#read(id);
    if (!record) return null;
    if (record.status !== 'open') {
      await this.#cleanup(id);
      return record;
    }
    // Only a missing folder means "not committed". Any other I/O error is
    // unknown, so nothing open is returned and nothing is recorded.
    const draftDir = path.join(this.drafts.draftsDir, record.draftId);
    let draftExists = true;
    try {
      await stat(draftDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail(409, UNAVAILABLE);
      draftExists = false;
    }
    if (draftExists) {
      // The folder only proves a commit when its receipt matches this intake
      // and the saved draft and originals are exactly what was planned. Any
      // other content, or anything unreadable, fails closed on every access
      // without writing: the open record and every staged byte are kept.
      let receipt = null;
      try {
        receipt = JSON.parse(await readFile(path.join(draftDir, INTAKE_RECEIPT), 'utf8'));
      } catch {
        throw fail(409, UNAVAILABLE);
      }
      const matches = receipt && receipt.intakeId === id && receipt.ownerId === record.ownerId && receipt.revision === record.revision
        && receipt.planSha256 === record.planSha256 && isUuid(receipt.commitRequestId);
      if (!matches || !(await this.#finalDraftMatches(record, draftDir))) throw fail(409, UNAVAILABLE);
      const committed = this.#terminalRecord(record, 'committed', { receipt: { ...receipt }, commitRequestId: receipt.commitRequestId });
      await this.#write(committed);
      await this.#cleanup(id);
      return committed;
    }
    return this.#reconcileParts(record);
  }

  // Checks the saved draft itself, from its raw files rather than any policy
  // projection, so a later source restriction is never mistaken for damage:
  // the reserved ID and schema, the text as commit would store it, and each
  // planned original present in order with its recorded and actual checksum.
  async #finalDraftMatches(record, draftDir) {
    try {
      const draft = JSON.parse(await readFile(path.join(draftDir, 'draft.json'), 'utf8'));
      if (draft?.id !== record.draftId || draft.schemaVersion !== 2 || !Array.isArray(draft.photos) || !Array.isArray(draft.sources)) return false;
      if (draft.text !== (record.text.trim() ? record.text : '')) return false;
      const planned = record.parts.filter((item) => item.kind === 'photo');
      const voice = record.parts.find((item) => item.kind === 'voice') ?? null;
      if (draft.photos.length !== planned.length || Boolean(draft.voice) !== Boolean(voice)) return false;
      const entries = [...draft.photos.map((entry, index) => [entry, planned[index]]), ...(voice ? [[draft.voice, voice]] : [])];
      for (const [entry, part] of entries) {
        const source = draft.sources.find((item) => item.id === entry.sourceId);
        if (typeof entry.name !== 'string' || path.basename(entry.name) !== entry.name) return false;
        if (!source || source.sha256 !== part.sha256 || source.size !== part.size || entry.size !== part.size) return false;
        const bytes = await readFile(path.join(draftDir, entry.name));
        if (bytes.length !== part.size || sha256(bytes) !== part.sha256) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Removes temporary and removed-part files, and recovers a fully stored part
  // whose acknowledgement was lost by validating its bytes again.
  async #reconcileParts(record) {
    const dir = path.join(this.#dir(record.id), 'parts');
    let names = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let changed = false;
    const parts = record.parts.map((part) => ({ ...part }));
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      const full = path.join(dir, name);
      const partId = name.slice(0, -4);
      const part = parts.find((item) => item.partId === partId);
      if (!part) {
        await rm(full, { force: true });
        continue;
      }
      if (part.status === 'received') continue;
      if (part.status === 'failed' && DECODE_REFUSALS.has(part.error)) {
        await rm(full, { force: true }).catch(() => {});
        continue;
      }
      const checked = this.#check(part, await readFile(full));
      if (checked.code) {
        await rm(full, { force: true });
      } else {
        // Recovered bytes are received but stay unverified until decoded again.
        Object.assign(part, { status: 'received', error: null, detectedType: checked.detectedType });
        delete part.verification;
        changed = true;
      }
    }
    for (const part of parts) {
      if (part.status === 'received' && !names.includes(`${part.partId}.bin`)) {
        Object.assign(part, { status: 'missing', error: null, detectedType: null });
        delete part.verification;
        changed = true;
      }
    }
    return changed ? this.#write({ ...record, parts, updatedAt: new Date().toISOString() }) : record;
  }

  #terminalRecord(record, status, extra = {}) {
    return {
      id: record.id, status, revision: record.revision, ownerId: record.ownerId, initialSha256: record.initialSha256,
      planRequests: record.planRequests, draftId: record.draftId, ...extra,
    };
  }

  async #resolved(id) {
    const record = await this.#resolve(id);
    if (!record) throw fail(404, 'This upload could not be found.');
    return record;
  }

  async create(owner, body) {
    if (!planKeys(body, ['requestId', 'text', 'parts', 'metadata']) || !isUuid(body.requestId)) throw fail(400, UNREADABLE);
    const plan = parsePlan(body, this.limits);
    const initialSha256 = planDigest(plan);
    return this.serialize(async () => {
      const existing = await this.#resolve(body.requestId);
      if (existing) {
        if (existing.initialSha256 !== initialSha256 || existing.ownerId !== owner.id) throw fail(409, 'This upload was already started with different content.');
        return { status: 200, intake: projectIntake(existing) };
      }
      const now = new Date().toISOString();
      const record = {
        id: body.requestId, status: 'open', revision: 1, ownerId: owner.id, draftId: randomUUID(), createdAt: now, updatedAt: now,
        initialSha256, planSha256: initialSha256, planRequests: {},
        text: plan.text, metadata: plan.metadata, placeName: plan.placeName,
        parts: plan.parts.map((part) => ({ ...part, status: 'missing', error: null, detectedType: null })),
      };
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.#dir(record.id), 'parts'), { recursive: true, mode: 0o700 });
      await chmod(this.#dir(record.id), 0o700);
      await this.#write(record);
      return { status: 201, intake: projectOpen(record) };
    });
  }

  async list() {
    return this.serialize(async () => {
      let ids = [];
      try {
        ids = (await readdir(this.root)).filter((name) => isUuid(name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const open = [];
      for (const id of ids) {
        const record = await this.#resolve(id).catch(() => null);
        if (record?.status === 'open') open.push(projectOpen(record));
      }
      return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async get(id) {
    return this.serialize(async () => projectIntake(await this.#resolved(id)));
  }

  async plan(id, body) {
    if (!planKeys(body, ['requestId', 'baseRevision', 'text', 'parts', 'metadata']) || !isUuid(body.requestId)
      || !Number.isInteger(body.baseRevision) || body.baseRevision < 1) throw fail(400, UNREADABLE);
    const plan = parsePlan(body, this.limits);
    const digest = sha256(JSON.stringify([body.baseRevision, planDigest(plan)]));
    return this.serialize(async () => {
      const record = await this.#resolved(id);
      const previous = record.planRequests?.[body.requestId];
      // A replay never reapplies an older plan: it returns the current state.
      if (previous !== undefined) {
        if (previous !== digest) throw fail(409, 'This change was already used with different content.');
        return projectIntake(record);
      }
      if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
      // An older client that omits the name never clears an existing one;
      // only an explicit null does. Exact replays were answered above.
      if (!Object.hasOwn(body, 'placeName') && (record.placeName ?? null) !== null) {
        throw fail(409, 'This upload has a place name. Reload it and include the name, or clear it, before changing it.');
      }
      if (body.baseRevision !== record.revision) throw fail(409, 'The upload changed elsewhere. Reload it before changing it.');
      const current = new Map(record.parts.map((part) => [part.partId, part]));
      const parts = plan.parts.map((part) => {
        const kept = current.get(part.partId);
        if (!kept) return { ...part, status: 'missing', error: null, detectedType: null };
        // A different file needs a new part ID; hints may be updated.
        if (identity(kept) !== identity(part)) throw fail(409, 'A changed file needs a new part.');
        return { ...kept, hints: part.hints };
      });
      const removed = record.parts.filter((part) => !plan.parts.some((item) => item.partId === part.partId));
      const next = {
        ...record, revision: record.revision + 1, updatedAt: new Date().toISOString(), planSha256: planDigest(plan),
        planRequests: { ...record.planRequests, [body.requestId]: digest }, text: plan.text, metadata: plan.metadata, placeName: plan.placeName, parts,
      };
      await this.#write(next);
      for (const part of removed) await rm(this.#partFile(id, part.partId), { force: true });
      return projectOpen(next);
    });
  }

  // The body cap for one part, from its planned kind, before any byte is read.
  async partCap(id, partId) {
    return this.serialize(async () => {
      const record = await this.#resolved(id);
      if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
      const part = record.parts.find((item) => item.partId === partId);
      if (!part) throw fail(404, 'This file is not part of the upload.');
      return part.kind === 'photo' ? this.limits.photoBytes : this.limits.voiceBytes;
    });
  }

  // Records a part refused before its bytes could be read (over its cap).
  async refusePart(id, partId, code) {
    return this.serialize(async () => {
      const record = await this.#resolved(id);
      if (record.status !== 'open' || !PART_CODES.has(code)) return;
      const part = record.parts.find((item) => item.partId === partId);
      if (!part || part.status === 'received') return;
      await this.#write({ ...record, updatedAt: new Date().toISOString(), parts: record.parts.map((item) => (item === part ? { ...item, status: 'failed', error: code, detectedType: null } : item)) });
    });
  }

  // Bytes are checked outside the mutex, then published under it only if the
  // part is still active with the same identity; a late upload for a removed
  // or replaced part is discarded. An accepted part is never replaced. The
  // order is: exact replay of an accepted part, cheap preflight (empty, size,
  // checksum, signature), one full decode in the verification slot, then the
  // identity-guarded publish of the bytes with their private verification.
  async receivePart(id, partId, bytes) {
    const found = await this.serialize(async () => {
      const record = await this.#resolved(id);
      if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
      const part = record.parts.find((item) => item.partId === partId);
      if (!part) throw fail(404, 'This file is not part of the upload.');
      if (attested(part)) {
        if (bytes.length === part.size && sha256(bytes) === part.sha256) return { replay: { partId, status: 'received', detectedType: part.detectedType } };
        throw fail(409, 'This file was already received with different content.');
      }
      return { planned: { ...part } };
    });
    if (found.replay) return found.replay;
    const { planned } = found;
    const checked = this.#check(planned, bytes);
    if (checked.code) return this.#refuseUpload(id, planned, checked);
    let result;
    try {
      result = await this.#certify(id, planned, checked.detectedType, bytes);
    } catch (error) {
      if (error.permanent) await this.#markFailed(id, planned, error.code);
      throw error;
    }
    this.#running(planned.kind);
    const temp = path.join(this.#dir(id), 'parts', `${partId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
      return await this.serialize(async () => {
        this.#running(planned.kind);
        const record = await this.#resolved(id);
        if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
        const part = record.parts.find((item) => item.partId === partId);
        if (!part || identity(part) !== identity(planned)) throw fail(409, 'This file was removed or replaced in the upload.');
        if (attested(part)) return { partId, status: 'received', detectedType: part.detectedType };
        const file = this.#partFile(id, partId);
        await rename(temp, file);
        // Publication boundary: nothing is awaited between this check and
        // starting the record write. A close before it leaves no new file.
        if (this.shutdown.signal.aborted) {
          if (part.status !== 'received') await rm(file, { force: true }).catch(() => {});
          throw new MediaVerificationError('aborted', planned.kind);
        }
        await this.#write(withPart(record, part, {
          status: 'received', error: null, detectedType: checked.detectedType, verification: attestation(part, checked.detectedType, result),
        }));
        return { partId, status: 'received', detectedType: checked.detectedType };
      });
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  // A preflight refusal: never decoded. A received file with other bytes is a
  // conflict; otherwise the still-matching part is marked failed.
  async #refuseUpload(id, planned, checked) {
    return this.serialize(async () => {
      const record = await this.#resolved(id);
      if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
      const part = record.parts.find((item) => item.partId === planned.partId);
      if (!part || identity(part) !== identity(planned)) throw fail(409, 'This file was removed or replaced in the upload.');
      if (part.status === 'received') throw fail(409, 'This file was already received with different content.');
      await this.#write(withPart(record, part, { status: 'failed', error: checked.code, detectedType: null }));
      throw fail(400, checked.message ?? {
        empty: 'This file is empty.', size: 'This file does not match its planned size.', hash: 'This file does not match its planned checksum.',
      }[checked.code]);
    });
  }

  // One full decode of exactly these bytes in the verification slot, outside
  // the mutex. Identical concurrent work joins; other identities never share.
  #certify(id, part, detectedType, bytes) {
    const key = JSON.stringify([id, part.partId, part.kind, part.size, part.sha256, detectedType, POLICY_SHA256]);
    const running = this.inflight.get(key);
    if (running) return running;
    this.#running(part.kind);
    if (!this.verifier) return Promise.reject(new MediaVerificationError('unavailable', part.kind));
    const promise = this.verifier.exclusive((signal) => this.verifier.verify({ kind: part.kind, type: detectedType, bytes, signal }));
    this.inflight.set(key, promise);
    promise.catch(() => {}).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    return promise;
  }

  // A permanent decode refusal marks only a part that still has the same
  // identity and no verification; its stored bytes are removed with it.
  async #markFailed(id, planned, code) {
    await this.serialize(async () => {
      if (this.shutdown.signal.aborted) return;
      const record = await this.#resolve(id);
      if (record?.status !== 'open') return;
      const part = record.parts.find((item) => item.partId === planned.partId);
      if (!part || identity(part) !== identity(planned) || attested(part)) return;
      await this.#write(withPart(record, part, { status: 'failed', error: code, detectedType: null }));
      await rm(this.#partFile(id, part.partId), { force: true });
    }).catch(() => {});
  }

  // Certifies a received part that has no current verification, such as one
  // received before content validation or recovered after a crash. Its stored
  // bytes are preflighted and decoded outside the mutex; the record is then
  // written only if the part, its identity and the bytes on disk are unchanged.
  async #certifyStored(id, part, refusal) {
    const bytes = await readFile(this.#partFile(id, part.partId)).catch(() => null);
    const checked = bytes && this.#check(part, bytes);
    if (!checked || checked.code) throw refusal();
    let result;
    try {
      result = await this.#certify(id, part, checked.detectedType, bytes);
    } catch (error) {
      if (error.permanent) await this.#markFailed(id, part, error.code);
      throw error;
    }
    await this.serialize(async () => {
      this.#running(part.kind);
      const record = await this.#resolved(id);
      if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
      const current = record.parts.find((item) => item.partId === part.partId);
      if (!current || identity(current) !== identity(part) || current.status !== 'received') throw refusal();
      if (attested(current)) return;
      const disk = await readFile(this.#partFile(id, part.partId)).catch(() => null);
      if (!disk || disk.length !== part.size || sha256(disk) !== part.sha256) throw refusal();
      this.#running(part.kind);
      await this.#write(withPart(record, current, { detectedType: checked.detectedType, verification: attestation(current, checked.detectedType, result) }));
    });
  }

  // Owner-private bytes of a received, active, verified part of an open intake
  // only. A part without a current verification is certified first. The bytes
  // are read and hashed against the verified size and checksum in the mutex,
  // and exactly those bytes are served, never the mutable file path.
  async partAsset(id, partId) {
    const asset = async (record) => {
      if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
      const part = record.parts.find((item) => item.partId === partId);
      if (!part || part.status !== 'received') throw fail(404, 'This file has not been received.');
      if (!attested(part)) return { pending: { ...part } };
      const body = await readFile(this.#partFile(id, partId)).catch(() => null);
      if (!body || body.length !== part.verification.size || sha256(body) !== part.verification.sha256) throw fail(409, UNAVAILABLE);
      return { type: part.detectedType, body };
    };
    const found = await this.serialize(async () => asset(await this.#resolved(id)));
    if (!found.pending) return found;
    await this.#certifyStored(id, found.pending, () => fail(404, 'This file has not been received.'));
    const verified = await this.serialize(async () => asset(await this.#resolved(id)));
    if (verified.pending) throw fail(404, 'This file has not been received.');
    return verified;
  }

  // Commit never decodes under the mutex. Received parts without a current
  // verification are certified first, outside it, and each success is kept;
  // the final commit then repeats every check before building the draft.
  async commit(id, owner, body) {
    if (!exactKeys(body, ['requestId', 'baseRevision']) || !isUuid(body.requestId) || !Number.isInteger(body.baseRevision) || body.baseRevision < 1) {
      throw fail(400, UNREADABLE);
    }
    const first = await this.serialize(() => this.#commitNow(id, owner, body));
    if (first.result) return first.result;
    for (const part of first.pending) await this.#certifyStored(id, part, () => fail(409, NOT_RECEIVED));
    const second = await this.serialize(() => this.#commitNow(id, owner, body));
    if (second.result) return second.result;
    throw fail(409, CHANGED_DURING_CHECK);
  }

  // Under the mutex. Returns { result } or the parts still needing certification.
  async #commitNow(id, owner, body) {
    const record = await this.#resolved(id);
    if (record.status === 'committed') {
      if (record.commitRequestId === body.requestId && record.revision === body.baseRevision) return { result: { status: 200, intake: terminal(record) } };
      throw fail(409, 'This upload was already saved.');
    }
    if (record.status !== 'open') throw fail(409, 'This upload is already finished.');
    if (body.baseRevision !== record.revision) throw fail(409, 'The upload changed elsewhere. Reload it before saving.');
    if (record.ownerId !== owner.id) throw fail(403, 'This action is not allowed.');
    if (!record.parts.every((part) => part.status === 'received')) throw fail(409, NOT_RECEIVED);
    const pending = record.parts.filter((part) => !attested(part)).map((part) => ({ ...part }));
    if (pending.length > 0) return { pending };
    // Every stored file is checked again before the final draft is built.
    const media = [];
    for (const part of record.parts) {
      const bytes = await readFile(this.#partFile(id, part.partId)).catch(() => null);
      const checked = bytes && this.#check(part, bytes);
      if (!checked || checked.code) throw fail(409, NOT_RECEIVED);
      media.push({ part, bytes: new Uint8Array(bytes), type: checked.detectedType, extension: checked.extension });
    }
    const photos = media.filter((item) => item.part.kind === 'photo');
    const voice = media.find((item) => item.part.kind === 'voice') ?? null;
    // Blank text becomes no written memory only now, as in a direct save.
    const text = record.text.trim() ? record.text : '';
    const sources = parseSourceMetadata(JSON.stringify(record.metadata), { photoCount: photos.length, hasText: Boolean(text), hasVoice: Boolean(voice) });
    if (!sources) throw fail(400, 'The source details could not be read.');
    const receipt = { ownerId: owner.id, intakeId: id, commitRequestId: body.requestId, revision: record.revision, planSha256: record.planSha256 };
    // The draft folder rename is the commit boundary; a close before it saves
    // nothing. The initial name is published by the same rename.
    await this.drafts.create({
      text, sources, placeName: record.placeName ?? null,
      photos: photos.map(({ bytes, type, extension }) => ({ bytes, type, extension })),
      voice: voice && { bytes: voice.bytes, type: voice.type, extension: voice.extension },
    }, { id: record.draftId, receipt, signal: this.shutdown.signal });
    const committed = this.#terminalRecord(record, 'committed', { receipt, commitRequestId: body.requestId });
    await this.#write(committed).catch(() => {});
    await this.#cleanup(id);
    return { result: { status: 201, intake: terminal(committed) } };
  }

  async discard(id, body) {
    if (!exactKeys(body, ['requestId']) || !isUuid(body.requestId)) throw fail(400, UNREADABLE);
    return this.serialize(async () => {
      const record = await this.#resolved(id);
      if (record.status === 'committed') throw fail(409, 'This upload was already saved.');
      if (record.status === 'discarded') return terminal(record);
      const discarded = this.#terminalRecord(record, 'discarded', { discardRequestId: body.requestId });
      await this.#write(discarded);
      await this.#cleanup(id);
      return terminal(discarded);
    });
  }
}
