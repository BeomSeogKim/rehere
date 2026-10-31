import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestError, detectMedia } from './drafts.mjs';
import { parseSourceMetadata } from './sources.mjs';

const MIB = 1024 * 1024;

// A contributor's photo lives under its contribution, never in the owner's
// draft sources, and is never a reconstruction or hosted-model input.
export const CONTRIBUTION_PHOTO_LIMITS = Object.freeze({
  payloadBytes: 128 * 1024,
  requestBytes: 20 * MIB + 512 * 1024,
  photoBytes: 20 * MIB,
  reviewBytes: 2 * MIB,
  reviewEdge: 2048,
  stderrBytes: 4 * 1024,
  timeoutMs: 15_000,
});

// Writing, an optional photo and an optional recording in one request.
export const CONTRIBUTION_BUNDLE_LIMITS = Object.freeze({
  payloadBytes: 128 * 1024,
  requestBytes: 64 * MIB,
  photoBytes: 20 * MIB,
  voiceBytes: 50 * MIB,
});
const VOICE_UNREADABLE = 'The recording could not be read. Record it again.';

export const REVIEW_NAME = 'review.jpg';
const ORIGINAL_NAMES = new Set(['original.jpg', 'original.png']);
// A contributed recording's stored files, beside the photo files.
export const PLAYBACK_NAME = 'playback.wav';
export const VOICE_ORIGINAL_NAMES = Object.freeze({ webm: 'voice-original.webm', ogg: 'voice-original.ogg', m4a: 'voice-original.m4a' });
const SPATIAL_DIR = fileURLToPath(new URL('./spatial/', import.meta.url));
const SCRIPT = path.join(SPATIAL_DIR, 'prepare_contribution_photo.py');
// Non-secret variables only; credentials in the server environment never reach the decoder.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG'];

// Fixed input guidance for every decoder input refusal; decoder output is never shown.
export const PHOTO_UNREADABLE = 'This photo could not be read. Export it as a JPEG or an 8-bit PNG of 32 megapixels or fewer and 20 MB or smaller, then try again. Nothing was saved.';
export const PHOTO_PREPARE_FAILED = 'The photo could not be prepared for review right now. Nothing was saved.';
export const PHOTO_BUSY = 'Another photo is being prepared. Nothing was started for this request. Try again in a moment.';
const PHOTO_DECODER_MISSING = 'Photo review is not available on this computer right now. Nothing was saved.';
const PHOTO_TOO_DETAILED = 'This photo could not be prepared for review within the size limit. Nothing was saved.';
const SHUTTING_DOWN = 'The app is shutting down. Try again later.';

const fail = (status, message) => new RequestError(status, message);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const UNREADABLE = 'The request could not be read.';

export const contributionsDir = (jobDir) => path.join(jobDir, 'contributions');
export const photoDir = (jobDir, contributionId) => path.join(contributionsDir(jobDir), contributionId);

// Reads the exactly-two-entry form: a JSON payload string and one photo file.
// File names and declared types are never used for validation or paths.
export async function readPhotoForm(form) {
  const names = [...form.keys()];
  if (names.length !== 2 || !names.includes('payload') || !names.includes('photo')) throw fail(400, UNREADABLE);
  const payload = form.get('payload');
  const photo = form.get('photo');
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > CONTRIBUTION_PHOTO_LIMITS.payloadBytes) throw fail(400, UNREADABLE);
  if (photo === null || typeof photo === 'string') throw fail(400, UNREADABLE);
  if (photo.size === 0) throw fail(400, PHOTO_UNREADABLE);
  if (photo.size > CONTRIBUTION_PHOTO_LIMITS.photoBytes) throw fail(413, `The photo must be ${CONTRIBUTION_PHOTO_LIMITS.photoBytes / MIB} MB or smaller.`);
  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    throw fail(400, UNREADABLE);
  }
  const bytes = Buffer.from(await photo.arrayBuffer());
  const detected = detectMedia('photo', bytes);
  if (detected.error) throw fail(415, detected.error);
  const size = imageSize(detected.type, bytes);
  if (!size) throw fail(400, PHOTO_UNREADABLE);
  return { body, bytes, type: detected.type, extension: detected.extension, ...size };
}

// Reads the bundle form: one JSON payload string and at most one photo and
// one recording file, nothing else. File names and declared types are never
// used; a file is present exactly when the payload describes it, which the
// caller checks once the payload is parsed. Only cheap checks happen here.
export async function readBundleForm(form) {
  const names = [...form.keys()];
  const allowed = new Set(['payload', 'photo', 'voice']);
  if (!names.includes('payload') || names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length) throw fail(400, UNREADABLE);
  const payload = form.get('payload');
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > CONTRIBUTION_BUNDLE_LIMITS.payloadBytes) throw fail(400, UNREADABLE);
  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    throw fail(400, UNREADABLE);
  }
  let photo = null;
  if (names.includes('photo')) {
    const file = form.get('photo');
    if (typeof file === 'string') throw fail(400, UNREADABLE);
    if (file.size === 0) throw fail(400, PHOTO_UNREADABLE);
    if (file.size > CONTRIBUTION_BUNDLE_LIMITS.photoBytes) throw fail(413, `The photo must be ${CONTRIBUTION_BUNDLE_LIMITS.photoBytes / MIB} MB or smaller.`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const detected = detectMedia('photo', bytes);
    if (detected.error) throw fail(415, detected.error);
    const size = imageSize(detected.type, bytes);
    if (!size) throw fail(400, PHOTO_UNREADABLE);
    photo = { bytes, type: detected.type, extension: detected.extension, ...size };
  }
  let voice = null;
  if (names.includes('voice')) {
    const file = form.get('voice');
    if (typeof file === 'string') throw fail(400, UNREADABLE);
    if (file.size === 0) throw fail(400, VOICE_UNREADABLE);
    if (file.size > CONTRIBUTION_BUNDLE_LIMITS.voiceBytes) throw fail(413, `The recording must be ${CONTRIBUTION_BUNDLE_LIMITS.voiceBytes / MIB} MB or smaller.`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const detected = detectMedia('voice', bytes);
    if (detected.error) throw fail(415, VOICE_UNREADABLE);
    voice = { bytes, type: detected.type, extension: detected.extension };
  }
  return { body, photo, voice };
}

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// Origin, dates and grants of the photo through the existing SourceInput
// validator. The provider is never a client label: the validator receives an
// empty one, and the caller records the authenticated principal.
export function parsePhotoFacts(value) {
  if (!exactKeys(value, ['origin', 'dates', 'permissions'])) throw fail(400, UNREADABLE);
  const parsed = parseSourceMetadata(JSON.stringify({ photos: [{ provider: '', ...value }] }), { photoCount: 1, hasText: false, hasVoice: false });
  if (!parsed) throw fail(400, 'The photo details could not be read.');
  const { origin, dates, permissions } = parsed.photos[0];
  return { origin, dates, permissions };
}

// Stored-pixel dimensions from the image header; EXIF orientation is not applied.
export function imageSize(type, bytes) {
  if (type === 'image/png') {
    if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return jpegFrame(bytes);
}

// Dimensions from the first JPEG frame header, or null.
function jpegFrame(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      if (offset + 9 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

// The decoder's output must be one bounded JPEG within the review edge.
export function reviewJpegInfo(bytes) {
  const { reviewBytes, reviewEdge } = CONTRIBUTION_PHOTO_LIMITS;
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > reviewBytes) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  const size = jpegFrame(bytes);
  return size && size.width <= reviewEdge && size.height <= reviewEdge ? size : null;
}

// Spawns the local inspection decoder: fixed script, stored bytes on stdin,
// a metadata-free JPEG on stdout. Errors are fixed public messages; decoder
// output never reaches a response or log. The promise settles exactly once:
// on exit, or at once on an output overflow, the time limit or an abort,
// whether or not the kill succeeds or a close follows. Later output is ignored.
// spawnProcess is a test seam only.
export function pythonPhotoDecoder({
  python = process.env.PHOTO_PYTHON || path.join(SPATIAL_DIR, '.venv/bin/python'),
  timeoutMs = CONTRIBUTION_PHOTO_LIMITS.timeoutMs,
  spawnProcess = spawn,
} = {}) {
  return ({ bytes, signal }) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail(503, SHUTTING_DOWN));
    const env = { PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    let settled = false;
    let child = null;
    let timer = null;
    const onAbort = () => stop(fail(503, SHUTTING_DOWN));
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    // Settles first, then tries to kill; a failed or throwing kill changes nothing.
    function stop(error) {
      settle(error);
      try {
        child?.kill('SIGKILL');
      } catch {
        // The process may already be gone.
      }
    }
    try {
      child = spawnProcess(python, [SCRIPT], { cwd: SPATIAL_DIR, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return settle(fail(503, PHOTO_DECODER_MISSING));
    }
    timer = setTimeout(() => stop(fail(503, PHOTO_PREPARE_FAILED)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const chunks = [];
    let size = 0;
    let stderr = 0;
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > CONTRIBUTION_PHOTO_LIMITS.reviewBytes) return stop(fail(503, PHOTO_PREPARE_FAILED));
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderr += chunk.length;
      if (stderr > CONTRIBUTION_PHOTO_LIMITS.stderrBytes) stop(fail(503, PHOTO_PREPARE_FAILED));
    });
    child.stdin.on('error', () => {});
    child.on('error', () => stop(fail(503, PHOTO_DECODER_MISSING)));
    child.on('close', (code) => {
      if (code === 0) return settle(null, Buffer.concat(chunks, size));
      if (code === 2) return settle(fail(400, PHOTO_UNREADABLE));
      if (code === 3) return settle(fail(503, PHOTO_DECODER_MISSING));
      if (code === 4) return settle(fail(400, PHOTO_TOO_DETAILED));
      return settle(fail(503, PHOTO_PREPARE_FAILED));
    });
    child.stdin.end(bytes);
  });
}

// The attestation every sync dependency check reads. It is a symbol-keyed
// property: object spread keeps it, JSON never stores or returns it, and a
// structured clone drops it, which then reads as unverified.
export const PHOTO_ATTESTATIONS = Symbol('contributionPhotoAttestations');

// Binds an attestation to the exact place, scene, contribution, provider and
// photo records, so a replaced or newly appended record is never covered.
// The attestation covers every stored material of the bundle: the photo and
// its inspection copy, and the recording and its playback copy.
export function photoFingerprint(draftId, jobId, contribution) {
  return sha256(JSON.stringify([draftId, jobId, contribution.id, contribution.principalId, contribution.photo ?? null, contribution.voice ?? null]));
}

// True when the bundle has no stored files, or every one was verified for
// exactly these records. The name is kept from the photo-only unit.
export function photoAttested(manifest, contribution) {
  if (!contribution.photo && !contribution.voice) return true;
  const entry = manifest[PHOTO_ATTESTATIONS]?.get(contribution.id);
  return entry?.available === true && entry.fingerprint === photoFingerprint(manifest.draftId, manifest.id, contribution);
}

// Successful byte checks only, keyed by file and the expected record plus the
// file's identity and times. A changed stat rehashes; an unchanged stat with
// silently changed bytes (for example media decay) is not detected here, while
// every served review photo is rehashed independently.
const verified = new Map();

async function verifyFile(file, expected) {
  let info;
  try {
    info = await lstat(file, { bigint: true });
  } catch {
    return false;
  }
  if (!info.isFile() || info.size !== BigInt(expected.size)) return false;
  const identity = [expected.sha256, expected.size, info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(':');
  if (verified.get(file) === identity) return true;
  verified.delete(file);
  const bytes = await readFile(file).catch(() => null);
  if (!bytes || bytes.length !== expected.size || sha256(bytes) !== expected.sha256) return false;
  verified.set(file, identity);
  return true;
}

async function bundleAvailable(jobDir, contribution) {
  const dir = photoDir(jobDir, contribution.id);
  if (contribution.photo) {
    const { source, review } = contribution.photo;
    if (!ORIGINAL_NAMES.has(source?.name) || review?.name !== REVIEW_NAME) return false;
    if (!(await verifyFile(path.join(dir, source.name), source)) || !(await verifyFile(path.join(dir, REVIEW_NAME), review))) return false;
  }
  if (contribution.voice) {
    const { source, playback } = contribution.voice;
    if (!Object.values(VOICE_ORIGINAL_NAMES).includes(source?.name) || playback?.name !== PLAYBACK_NAME) return false;
    if (!(await verifyFile(path.join(dir, source.name), source)) || !(await verifyFile(path.join(dir, PLAYBACK_NAME), playback))) return false;
  }
  return true;
}

// Attests every bundle with stored files that is not withdrawn. Any read error is unavailable.
export async function attestPhotos(manifest, draftId, jobId, jobDir) {
  const attestations = new Map();
  for (const contribution of manifest.collaboration?.contributions ?? []) {
    if ((!contribution?.photo && !contribution?.voice) || contribution.withdrawnAt !== null) continue;
    const available = await bundleAvailable(jobDir, contribution).catch(() => false);
    attestations.set(contribution.id, { fingerprint: photoFingerprint(draftId, jobId, contribution), available });
  }
  manifest[PHOTO_ATTESTATIONS] = attestations;
  return manifest;
}

// The review JPEG bytes for serving, rehashed on every read; null when they no
// longer match the record.
export async function readReviewPhoto(jobDir, contribution, expected = contribution.photo.review) {
  if (contribution.photo.review.name !== REVIEW_NAME) return null;
  return readChecked(path.join(photoDir(jobDir, contribution.id), REVIEW_NAME), expected);
}

// The playback WAV bytes for serving, rehashed on every read; null when they
// no longer match the record.
export async function readPlayback(jobDir, contribution, expected = contribution.voice.playback) {
  if (contribution.voice.playback.name !== PLAYBACK_NAME) return null;
  return readChecked(path.join(photoDir(jobDir, contribution.id), PLAYBACK_NAME), expected);
}

async function readChecked(file, expected) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size !== expected.size) return null;
    const bytes = await readFile(file);
    return bytes.length === expected.size && sha256(bytes) === expected.sha256 ? bytes : null;
  } catch {
    return null;
  }
}
