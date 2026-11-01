import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSourceMetadata, sourceRecord } from './sources.mjs';

const MIB = 1024 * 1024;

// Request and per-file limits. The checks here (size, count and leading
// signature) are only the cheap preflight; every accepted photo and recording
// is then decoded in full by media-verification.mjs before it is stored.
export const LIMITS = Object.freeze({
  requestBytes: 64 * MIB,
  photoCount: 20,
  photoBytes: 20 * MIB,
  voiceBytes: 50 * MIB,
  textChars: 10_000,
});

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const INTAKE_RECEIPT = 'intake-receipt.json';
const FIELDS = new Set(['text', 'photos', 'voice', 'metadata', 'placeName']);

// The owner's optional place name lives in place.json beside the immutable
// draft.json and originals, which naming never rewrites. Without the file a
// place is unnamed.
const PLACE_FILE = 'place.json';
export const PLACE_NAME_MAX = 120;
export const PLACE_RECEIPTS_MAX = 200;
// C0 and C1 controls (including line breaks) and bidi formatting controls:
// the Arabic letter mark, LRM/RLM, embeddings, overrides and isolates. The
// owner page refuses exactly the same set; ordinary right-to-left letters
// are allowed.
const PLACE_NAME_REFUSED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const PLACE_NAME_INVALID = 'The place name could not be used. Use one line of up to 120 characters.';
const PLACE_UNAVAILABLE = 'Place names are unavailable right now. Nothing was changed.';
const UNNAMED = Object.freeze({ name: null, revision: 0, updatedAt: null, unavailable: false });
const UNAVAILABLE_NAME = Object.freeze({ name: null, revision: null, updatedAt: null, unavailable: true });
const isUuid = (value) => typeof value === 'string' && ID_PATTERN.test(value);

// The canonical name: raw length and characters are checked before the outer
// whitespace is trimmed; an empty result means unnamed. Nothing else changes.
// The fixed error never repeats the input.
export function parsePlaceName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > PLACE_NAME_MAX || PLACE_NAME_REFUSED.test(value)) throw new RequestError(400, PLACE_NAME_INVALID);
  const name = value.trim();
  return name === '' ? null : name;
}

function canonicalName(value) {
  try {
    return value === parsePlaceName(value);
  } catch {
    return false;
  }
}

function validPlaceFile(state) {
  return state?.schemaVersion === 1 && (state.name === null || canonicalName(state.name))
    && Number.isInteger(state.revision) && state.revision >= 0 && (state.name === null || state.revision >= 1)
    && (state.updatedAt === null || typeof state.updatedAt === 'string')
    && Array.isArray(state.receipts) && state.receipts.length <= PLACE_RECEIPTS_MAX
    && state.receipts.every((item) => isUuid(item?.requestId) && typeof item.digest === 'string' && /^[0-9a-f]{64}$/.test(item.digest)
      && Number.isInteger(item.revision) && item.revision >= 0);
}

const placeView = (state) => ({ name: state.name, revision: state.revision, updatedAt: state.updatedAt, unavailable: false });

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function startsWith(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function isHeif(bytes) {
  return ascii(bytes, 4, 8) === 'ftyp' && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif)$/.test(ascii(bytes, 8, 12));
}

function photoType(bytes) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', extension: 'jpg' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', extension: 'png' };
  return null;
}

// Only the containers that browser MediaRecorder implementations produce.
function voiceType(bytes) {
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { type: 'audio/webm', extension: 'webm' };
  if (ascii(bytes, 0, 4) === 'OggS') return { type: 'audio/ogg', extension: 'ogg' };
  if (ascii(bytes, 4, 8) === 'ftyp' && !isHeif(bytes)) return { type: 'audio/mp4', extension: 'm4a' };
  return null;
}

// The detected type of one photo or voice file, or a fixed refusal message.
// Shared with resumable intakes so both paths accept exactly the same files.
export function detectMedia(kind, bytes) {
  if (kind === 'photo') {
    const detected = photoType(bytes);
    if (detected) return detected;
    return { error: isHeif(bytes) ? 'HEIC photos are not supported yet. Please export the photo as JPEG or PNG.' : 'Photos must be JPEG or PNG images.' };
  }
  return voiceType(bytes) ?? { error: 'The voice recording could not be read.' };
}

async function readPhoto(file, limits) {
  if (file.size === 0) throw new RequestError(400, 'One of the photos is empty.');
  if (file.size > limits.photoBytes) {
    throw new RequestError(413, `Each photo must be ${limits.photoBytes / MIB} MB or smaller.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = photoType(bytes);
  if (detected) return { ...detected, bytes };
  if (isHeif(bytes)) {
    throw new RequestError(400, 'HEIC photos are not supported yet. Please export the photo as JPEG or PNG.');
  }
  throw new RequestError(400, 'Photos must be JPEG or PNG images.');
}

async function readVoice(file, limits) {
  if (file.size === 0) throw new RequestError(400, 'The voice recording is empty.');
  if (file.size > limits.voiceBytes) {
    throw new RequestError(413, `A voice recording must be ${limits.voiceBytes / MIB} MB or smaller.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = voiceType(bytes);
  if (!detected) throw new RequestError(400, 'The voice recording could not be read.');
  return { ...detected, bytes };
}

export async function parseDraft(form, limits = LIMITS) {
  let text = null;
  const photoFiles = [];
  let voiceFile = null;
  let metadata = null;
  let placeName;

  for (const [key, value] of form) {
    if (!FIELDS.has(key)) throw new RequestError(400, 'The upload contains an unexpected field.');
    if (key === 'text') {
      if (typeof value !== 'string' || text !== null) throw new RequestError(400, 'The written memory could not be read.');
      text = value;
    } else if (key === 'metadata') {
      if (typeof value !== 'string' || metadata !== null) throw new RequestError(400, 'The source details could not be read.');
      metadata = value;
    } else if (key === 'placeName') {
      if (typeof value !== 'string' || placeName !== undefined) throw new RequestError(400, PLACE_NAME_INVALID);
      placeName = value;
    } else if (typeof value === 'string') {
      throw new RequestError(400, 'The upload could not be read.');
    } else if (key === 'photos') {
      photoFiles.push(value);
    } else {
      if (voiceFile) throw new RequestError(400, 'Only one voice recording can be saved.');
      voiceFile = value;
    }
  }

  // A name is checked before anything else is read, and never counts as content.
  placeName = parsePlaceName(placeName);
  // Meaningful text is kept exactly as written; whitespace alone is no statement.
  text ??= '';
  if (!text.trim()) text = '';
  if (text.length > limits.textChars) {
    throw new RequestError(413, `The written memory must be ${limits.textChars.toLocaleString('en-US')} characters or fewer.`);
  }
  if (photoFiles.length > limits.photoCount) {
    throw new RequestError(413, `Up to ${limits.photoCount} photos can be saved at once.`);
  }
  if (!text && photoFiles.length === 0 && !voiceFile) {
    throw new RequestError(400, 'Add a photo, a written memory or a voice recording before saving.');
  }

  const photos = [];
  for (const file of photoFiles) photos.push(await readPhoto(file, limits));
  const voice = voiceFile ? await readVoice(voiceFile, limits) : null;
  const sources = parseSourceMetadata(metadata, { photoCount: photos.length, hasText: Boolean(text), hasVoice: Boolean(voice) });
  if (!sources) throw new RequestError(400, 'The source details could not be read.');
  return { text, photos, voice, sources, placeName };
}

export class DraftStore {
  constructor(dataDir) {
    this.draftsDir = path.join(dataDir, 'drafts');
    this.tempDir = path.join(dataDir, 'incoming');
    this.placeDeletions = null;
  }

  // The app server attaches its place-deletion barrier store; without one
  // (direct store use) no place is ever treated as deleted.
  usePlaceDeletions(placeDeletions) {
    this.placeDeletions = placeDeletions;
  }

  async #deleted(id) {
    return Boolean(this.placeDeletions) && (await this.placeDeletions.deleted(id));
  }

  // Files are written to a private folder and renamed into place last, so a
  // failed save leaves no partial draft and existing drafts are never touched.
  // An intake commit passes its reserved ID and a receipt, which lands in the
  // same rename as draft.json; the receipt is never listed or served.
  // `signal` is checked last before the final rename, which is the commit
  // boundary: once that rename has started the draft may be saved.
  // A given place name is written as place.json in the same staging folder,
  // so it is published by the same rename as the draft, or not at all.
  async create({ text, photos, voice, sources, placeName = null }, { id = randomUUID(), receipt = null, signal = null } = {}) {
    const staging = path.join(this.tempDir, id);
    const draft = {
      id,
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      text,
      textSourceId: null,
      photos: [],
      voice: null,
      sources: [],
    };
    const addSource = (kind, input, content) => {
      const record = sourceRecord(randomUUID(), kind, input, content);
      draft.sources.push(record);
      return record.id;
    };
    try {
      await mkdir(staging, { recursive: true });
      for (const [index, photo] of photos.entries()) {
        const name = `photo-${index + 1}.${photo.extension}`;
        await writeFile(path.join(staging, name), photo.bytes);
        const sourceId = addSource('photo', sources.photos[index], { name, bytes: photo.bytes, type: photo.type });
        draft.photos.push({ name, type: photo.type, size: photo.bytes.length, sourceId });
      }
      if (text) {
        draft.textSourceId = addSource('text', sources.text, {
          name: null,
          bytes: Buffer.from(text, 'utf8'),
          type: 'text/plain; charset=utf-8',
        });
      }
      if (voice) {
        const name = `voice.${voice.extension}`;
        await writeFile(path.join(staging, name), voice.bytes);
        const sourceId = addSource('voice', sources.voice, { name, bytes: voice.bytes, type: voice.type });
        draft.voice = { name, type: voice.type, size: voice.bytes.length, sourceId };
      }
      if (receipt) await writeFile(path.join(staging, INTAKE_RECEIPT), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      if (placeName !== null) {
        const place = { schemaVersion: 1, name: placeName, revision: 1, updatedAt: draft.createdAt, receipts: [] };
        await writeFile(path.join(staging, PLACE_FILE), JSON.stringify(place, null, 2), { mode: 0o600 });
      }
      await writeFile(path.join(staging, 'draft.json'), JSON.stringify(draft, null, 2));
      await mkdir(this.draftsDir, { recursive: true });
      // The final rename is the publication. With a deletion barrier store it
      // runs in the shared commit section, after a fresh barrier check, so a
      // deleted place's ID can never be published again.
      const publish = async () => {
        if (signal?.aborted) throw new RequestError(503, 'The app is shutting down. Nothing was saved.');
        if (await this.#deleted(id)) throw new RequestError(409, 'This place was deleted. Nothing was saved.');
        await rename(staging, path.join(this.draftsDir, id));
      };
      await (this.placeDeletions ? this.placeDeletions.commit(publish) : publish());
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return draft;
  }

  async get(id) {
    if (!ID_PATTERN.test(id)) return null;
    if (await this.#deleted(id)) return null;
    try {
      return JSON.parse(await readFile(path.join(this.draftsDir, id, 'draft.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list() {
    let names;
    try {
      names = await readdir(this.draftsDir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const drafts = [];
    for (const name of names) {
      const draft = await this.get(name).catch(() => null);
      if (draft) drafts.push(draft);
    }
    return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // The stored state, null when there is none, or an error for an unreadable
  // or invalid file.
  async #placeState(id) {
    let text;
    try {
      text = await readFile(path.join(this.draftsDir, id, PLACE_FILE), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new RequestError(503, PLACE_UNAVAILABLE);
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw new RequestError(503, PLACE_UNAVAILABLE);
    }
    if (!validPlaceFile(state)) throw new RequestError(503, PLACE_UNAVAILABLE);
    return state;
  }

  // The owner metadata of one place, read fresh. Unreadable metadata is
  // reported as unavailable, never as unnamed, and never hides the draft.
  async place(id) {
    if (!ID_PATTERN.test(id) || (await this.#deleted(id))) return { ...UNAVAILABLE_NAME };
    try {
      const state = await this.#placeState(id);
      return state ? placeView(state) : { ...UNNAMED };
    } catch {
      return { ...UNAVAILABLE_NAME };
    }
  }

  // Owner rename. The caller serializes it (the reconstruction store's mutex).
  // An exact replay is found before the revision and cap checks and never
  // reapplies; every successful request, a no-op included, keeps a receipt so
  // its ID cannot be reused for another change.
  async renamePlace(id, body) {
    const valid = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 3
      && isUuid(body.requestId) && Number.isInteger(body.baseRevision) && body.baseRevision >= 0 && Object.hasOwn(body, 'name');
    if (!valid) throw new RequestError(400, 'The request could not be read.');
    const name = parsePlaceName(body.name);
    if (!(await this.get(id))) throw new RequestError(404, 'This memory could not be found.');
    const state = await this.#placeState(id);
    const digest = createHash('sha256').update(JSON.stringify([body.baseRevision, name])).digest('hex');
    const current = state ?? { schemaVersion: 1, name: null, revision: 0, updatedAt: null, receipts: [] };
    const receipt = current.receipts.find((item) => item.requestId === body.requestId);
    if (receipt) {
      if (receipt.digest !== digest) throw new RequestError(409, 'This request was already used with different values.');
      return { draftId: id, place: placeView(current), changed: false, replayed: true, appliedRevision: receipt.revision };
    }
    if (current.receipts.length >= PLACE_RECEIPTS_MAX) throw new RequestError(409, 'This place name cannot be changed again.');
    if (body.baseRevision !== current.revision) throw new RequestError(409, 'The place name changed elsewhere. Reload it before saving.');
    const changed = name !== current.name;
    const next = changed ? { ...current, name, revision: current.revision + 1, updatedAt: new Date().toISOString() } : { ...current };
    next.receipts = [...current.receipts, { requestId: body.requestId, digest, revision: next.revision }];
    const file = path.join(this.draftsDir, id, PLACE_FILE);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new RequestError(503, 'The place name could not be saved. Nothing was changed.');
    }
    return { draftId: id, place: placeView(next), changed, replayed: false, appliedRevision: next.revision };
  }

  // Only names recorded in the draft's own metadata can be served.
  async asset(id, name) {
    const draft = await this.get(id);
    const entry = draft && [...draft.photos, draft.voice].find((item) => item?.name === name);
    return entry ? { ...entry, file: path.join(this.draftsDir, id, entry.name) } : null;
  }
}
