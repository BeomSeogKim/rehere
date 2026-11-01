import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_INPUT_BYTES, MAX_PCM_BYTES, createAudioDecoder } from './audio-derivative.mjs';
import { RequestError } from './drafts.mjs';

// Owner input verification: every saved photo and recording is decoded in full
// once by a local decoder before it is accepted. The decoded output is
// discarded; originals are stored exactly as received and are never sent to a
// model, regenerated or rewritten.

const MIB = 1024 * 1024;
const SPATIAL_DIR = fileURLToPath(new URL('./spatial/', import.meta.url));
const PHOTO_SCRIPT = path.join(SPATIAL_DIR, 'verify_owner_photo.py');
// Non-secret variables only; credentials in the server environment never reach a decoder.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const STDOUT_BYTES = 4 * 1024;
const PHOTO_TIMEOUT_MS = 15_000;

// The validation rules an attestation is bound to. Changing any of them gives a
// new hash, so earlier attestations no longer count and files are checked again.
export const VALIDATION_POLICY = Object.freeze({
  version: 1,
  photo: {
    decoder: 'verify_owner_photo/1', types: ['image/jpeg', 'image/png'], maxBytes: 20 * MIB, maxPixels: 32_000_000,
    variants: { pngCrc: 'verify', multiFramePng: 'refuse', png16BitTransparency: 'refuse' },
  },
  voice: {
    decoder: 'ffmpeg-first-audio/strict-1', types: ['audio/webm', 'audio/ogg', 'audio/mp4'], maxBytes: MAX_INPUT_BYTES, maxPcmBytes: MAX_PCM_BYTES,
    strict: 'crccheck+bitstream+buffer+explode; any decoder error output fails', timestamps: 'asetpts=N/SR/TB', sampleRate: 16_000,
  },
});
export const POLICY_SHA256 = createHash('sha256').update(JSON.stringify(VALIDATION_POLICY)).digest('hex');
// The decoded cap in milliseconds: 9,600,000 bytes of 16 kHz 16-bit mono.
const MAX_DURATION_MS = MAX_PCM_BYTES / 32;
const SHA256 = /^[0-9a-f]{64}$/;
const positive = (value) => Number.isInteger(value) && value > 0;

// A decoded result within the policy: positive photo dimensions of at most
// 32 MP, or a floored duration from 0 to 300,000 ms (non-empty PCM is the
// decoder's own rule, so a sub-millisecond decode may report 0).
function validResult(kind, result) {
  if (result === null || typeof result !== 'object') return false;
  if (kind === 'photo') {
    return Object.keys(result).length === 2 && positive(result.width) && positive(result.height)
      && result.width * result.height <= VALIDATION_POLICY.photo.maxPixels;
  }
  return Object.keys(result).length === 1 && Number.isInteger(result.durationMs) && result.durationMs >= 0 && result.durationMs <= MAX_DURATION_MS;
}

// Fixed public wording; decoder output never reaches a response or log.
export const MEDIA_MESSAGES = Object.freeze({
  content: {
    photo: 'This photo could not be read in full. Export it again as a JPEG or an 8-bit PNG and add it again.',
    voice: 'This recording could not be played in full. Record it again or choose another recording.',
  },
  pixels: 'This photo is larger than 32 megapixels. Save a smaller copy and add it again.',
  duration: 'This recording is longer than five minutes. Record a shorter take of five minutes or less.',
  busy: 'Another file is being checked. Nothing was changed. Try again in a moment.',
  unavailable: 'Files cannot be checked on this computer right now. Nothing was changed.',
  // Only for the known photo-checker setup failures below; never inferred from decoder output.
  setup: 'Photo checking is not set up on this computer. Follow app/spatial/README.md, or set PHOTO_PYTHON to a Python environment with Pillow, then save again. Nothing was changed.',
  timeout: 'Checking this file took too long. Nothing was changed. Try again.',
  aborted: 'The app is shutting down. Nothing was changed.',
});

// Permanent outcomes describe the file; transient ones leave everything unchanged.
export const PERMANENT_CODES = Object.freeze(['content', 'pixels', 'duration']);

export class MediaVerificationError extends RequestError {
  constructor(code, kind) {
    const permanent = PERMANENT_CODES.includes(code);
    super(permanent ? 400 : 503, code === 'content' ? MEDIA_MESSAGES.content[kind] : MEDIA_MESSAGES[code]);
    this.code = code;
    this.permanent = permanent;
  }
}

// The configured photo checker could not run at all (missing or not executable),
// as opposed to any other spawn fault, which stays 'unavailable'.
const SETUP_SPAWN_CODES = new Set(['ENOENT', 'EACCES']);
// verify_owner_photo.py exits 3 only when Pillow cannot be imported.
const EXIT_SETUP = 3;

// Spawns the owner photo verifier: fixed script, one fixed format argument and
// the stored bytes on stdin; success prints exactly {"width","height"}. The call
// settles once, on exit or at once on overflow, the time limit or an abort,
// whether or not the kill succeeds. spawnProcess is a test seam only.
export function pythonPhotoVerifier({
  python = process.env.PHOTO_PYTHON || path.join(SPATIAL_DIR, '.venv/bin/python'), timeoutMs = PHOTO_TIMEOUT_MS, spawnProcess = spawn,
} = {}) {
  return ({ bytes, type, signal }) => new Promise((resolve, reject) => {
    const expect = { 'image/jpeg': 'jpeg', 'image/png': 'png' }[type];
    if (!expect) return reject(new MediaVerificationError('content', 'photo'));
    if (signal?.aborted) return reject(new MediaVerificationError('aborted', 'photo'));
    const env = { PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    let settled = false;
    let child = null;
    let timer = null;
    const onAbort = () => stop('aborted');
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    function stop(code) {
      settle(new MediaVerificationError(code, 'photo'));
      try {
        child?.kill('SIGKILL');
      } catch {
        // The process may already be gone; the outcome is already settled.
      }
    }
    try {
      child = spawnProcess(python, [PHOTO_SCRIPT, '--expect', expect], { cwd: SPATIAL_DIR, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return settle(new MediaVerificationError(SETUP_SPAWN_CODES.has(error?.code) ? 'setup' : 'unavailable', 'photo'));
    }
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > STDOUT_BYTES) return stop('unavailable');
      chunks.push(chunk);
    });
    // Drained and discarded; never kept, returned or logged.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (error) => stop(SETUP_SPAWN_CODES.has(error?.code) ? 'setup' : 'unavailable'));
    child.on('close', (code) => {
      if (code === 2) return settle(new MediaVerificationError('content', 'photo'));
      if (code === 4) return settle(new MediaVerificationError('pixels', 'photo'));
      if (code === EXIT_SETUP) return settle(new MediaVerificationError('setup', 'photo'));
      if (code !== 0) return settle(new MediaVerificationError('unavailable', 'photo'));
      let result = null;
      try {
        result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } catch {
        // Unreadable success output is a decoder fault, not a property of the file.
      }
      const valid = validResult('photo', result);
      settle(valid ? null : new MediaVerificationError('unavailable', 'photo'), valid ? { width: result.width, height: result.height } : undefined);
    });
    child.stdin.end(bytes);
  });
}

const AUDIO_CODES = Object.freeze({
  'too-long': 'duration', 'decode-failed': 'content', 'invalid-input': 'content', 'unsupported-type': 'content',
  unavailable: 'unavailable', timeout: 'timeout', aborted: 'aborted',
});

// The existing recording decoder in strict input mode; the samples are discarded.
export function ffmpegVoiceVerifier({ decode = createAudioDecoder({ strict: true }) } = {}) {
  return async ({ bytes, type, signal }) => {
    try {
      const { durationMs } = await decode({ bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), type, signal });
      return { durationMs };
    } catch (error) {
      throw new MediaVerificationError(AUDIO_CODES[error?.code] ?? 'unavailable', 'voice');
    }
  };
}

// One verification slot per server, with no queue: a second request while it
// is held is refused as busy. close() aborts the admitted work and waits for it.
export function createMediaVerifier({ photo = pythonPhotoVerifier(), voice = ffmpegVoiceVerifier() } = {}) {
  let active = null;
  let closed = false;
  const decoders = { photo, voice };
  return {
    get closed() {
      return closed;
    },
    // Runs `task(signal)` holding the slot. The signal aborts on close.
    async exclusive(task) {
      if (closed) throw new MediaVerificationError('aborted');
      if (active) throw new MediaVerificationError('busy');
      const controller = new AbortController();
      const slot = { controller, done: null };
      active = slot;
      slot.done = (async () => task(controller.signal))();
      try {
        return await slot.done;
      } finally {
        if (active === slot) active = null;
      }
    },
    // Decodes one file in full. Caller holds the slot and passes its signal.
    // A result outside the policy is a decoder fault, never an accepted file.
    async verify({ kind, type, bytes, signal }) {
      if (signal?.aborted) throw new MediaVerificationError('aborted', kind);
      let result;
      try {
        result = await decoders[kind]({ bytes, type, signal });
      } catch (error) {
        throw error instanceof MediaVerificationError ? error : new MediaVerificationError('unavailable', kind);
      }
      if (!validResult(kind, result)) throw new MediaVerificationError('unavailable', kind);
      return result;
    },
    async close() {
      closed = true;
      const current = active;
      current?.controller.abort();
      await current?.done.catch(() => {});
    },
  };
}

// The private record an accepted intake part keeps. Only server code builds it,
// from a completed decode of exactly these bytes under the current policy.
export function attestation(part, detectedType, result) {
  const values = part.kind === 'photo' ? { width: result.width, height: result.height } : { durationMs: result.durationMs };
  return { policySha256: POLICY_SHA256, kind: part.kind, type: detectedType, size: part.size, sha256: part.sha256, ...values };
}

// Absent, stale or malformed records never count as verification: the record
// must match the current policy (allowed kind, type and byte cap, result
// bounds) and the part's complete identity and detected type.
export function attested(part) {
  const record = part?.verification;
  if (part?.status !== 'received' || record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  const policy = VALIDATION_POLICY[record.kind];
  if ((record.kind !== 'photo' && record.kind !== 'voice') || !policy.types.includes(record.type)) return false;
  if (!positive(record.size) || record.size > policy.maxBytes || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)) return false;
  const { policySha256, kind, type, size, sha256, ...result } = record;
  if (!validResult(kind, result)) return false;
  return policySha256 === POLICY_SHA256 && kind === part.kind && type === part.detectedType && size === part.size && sha256 === part.sha256;
}
