import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSourceMetadata, sourceRecord } from './sources.mjs';

const MIB = 1024 * 1024;

// Transport limits for this endpoint only. Final supported formats and content
// checks belong to the upload-validation requirement and are not settled here.
export const LIMITS = Object.freeze({
  requestBytes: 64 * MIB,
  photoCount: 20,
  photoBytes: 20 * MIB,
  voiceBytes: 50 * MIB,
  textChars: 10_000,
});

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = new Set(['text', 'photos', 'voice', 'metadata']);

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

  for (const [key, value] of form) {
    if (!FIELDS.has(key)) throw new RequestError(400, 'The upload contains an unexpected field.');
    if (key === 'text') {
      if (typeof value !== 'string' || text !== null) throw new RequestError(400, 'The written memory could not be read.');
      text = value;
    } else if (key === 'metadata') {
      if (typeof value !== 'string' || metadata !== null) throw new RequestError(400, 'The source details could not be read.');
      metadata = value;
    } else if (typeof value === 'string') {
      throw new RequestError(400, 'The upload could not be read.');
    } else if (key === 'photos') {
      photoFiles.push(value);
    } else {
      if (voiceFile) throw new RequestError(400, 'Only one voice recording can be saved.');
      voiceFile = value;
    }
  }

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
  return { text, photos, voice, sources };
}

export class DraftStore {
  constructor(dataDir) {
    this.draftsDir = path.join(dataDir, 'drafts');
    this.tempDir = path.join(dataDir, 'incoming');
  }

  // Files are written to a private folder and renamed into place last, so a
  // failed save leaves no partial draft and existing drafts are never touched.
  async create({ text, photos, voice, sources }) {
    const id = randomUUID();
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
      await writeFile(path.join(staging, 'draft.json'), JSON.stringify(draft, null, 2));
      await mkdir(this.draftsDir, { recursive: true });
      await rename(staging, path.join(this.draftsDir, id));
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return draft;
  }

  async get(id) {
    if (!ID_PATTERN.test(id)) return null;
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

  // Only names recorded in the draft's own metadata can be served.
  async asset(id, name) {
    const draft = await this.get(id);
    const entry = draft && [...draft.photos, draft.voice].find((item) => item?.name === name);
    return entry ? { ...entry, file: path.join(this.draftsDir, id, entry.name) } : null;
  }
}
