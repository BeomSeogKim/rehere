import { spawn } from 'node:child_process';

// Playback derivatives of stored voice originals: the full first audio track,
// decoded by a local ffmpeg to 16 kHz mono signed 16-bit little-endian PCM.
// Nothing is truncated; a recording longer than the limit is rejected.

export const SAMPLE_RATE = 16_000;
export const MAX_PCM_BYTES = 9_600_000; // 300 seconds at 16 kHz, 16-bit mono
export const MAX_INPUT_BYTES = 50 * 1024 * 1024; // the stored voice upload limit
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

// The demuxer is forced from the stored type; nothing is guessed from content
// or a file name. MP4 is read from a pipe without seeking, so only files whose
// index precedes the audio (fast-start or fragmented) can be decoded.
const DEMUXERS = Object.freeze({ 'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/mp4': 'mov' });
const SIGNATURES = Object.freeze({
  'audio/webm': (bytes) => bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
  'audio/ogg': (bytes) => bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'OggS',
  'audio/mp4': (bytes) => bytes.length >= 8 && bytes.toString('latin1', 4, 8) === 'ftyp',
});

export const DECODE_ERRORS = Object.freeze(['unsupported-type', 'invalid-input', 'too-long', 'timeout', 'aborted', 'unavailable', 'decode-failed']);

// Carries only a fixed code: never input bytes or decoder output.
export class AudioDecodeError extends Error {
  constructor(code) {
    super(`Audio decoding failed: ${code}.`);
    this.code = code;
  }
}

const ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'LANG'];
const workerEnv = () => Object.fromEntries(ENV_ALLOWLIST.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

// Input verification only: also fails on CRC, bitstream or buffer errors the
// default playback decode would conceal. Story playback keeps the default.
const STRICT_INPUT = ['-err_detect', 'crccheck+bitstream+buffer+explode'];
// Input verification only: output timestamps are renumbered from the decoded
// sample count, so a container's repeated or out-of-order timestamps (as in
// Safari's MediaRecorder WebM) do not produce output-muxer errors. Decoding and
// corrupt-input detection are unchanged; samples are not added or dropped.
const STRICT_TIMESTAMPS = ['-af', 'asetpts=N/SR/TB'];

export function decoderArgs(type, { strict = false } = {}) {
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-xerror',
    '-protocol_whitelist', 'pipe', ...(strict ? STRICT_INPUT : []), '-f', DEMUXERS[type], '-i', 'pipe:0',
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', ...(strict ? STRICT_TIMESTAMPS : []),
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
  ];
}

// A fixed 44-byte PCM WAV header followed by the samples, with no other chunks.
export function pcmWav(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > MAX_PCM_BYTES) {
    throw new AudioDecodeError('decode-failed');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Returns the decode function. `executable` defaults to REHERE_FFMPEG, else
// `ffmpeg` found on PATH; an absolute path is recommended for local operation.
// The limits are fixed in production; spawnImpl and killGraceMs are for tests only.
// `strict` is for owner input verification: strict error detection, and any
// decoder error output fails the decode even when ffmpeg exits 0.
export function createAudioDecoder({
  executable = process.env.REHERE_FFMPEG || 'ffmpeg', timeoutMs = 30_000, maxPcmBytes = MAX_PCM_BYTES, spawnImpl = spawn, killGraceMs = 1000, strict = false,
} = {}) {
  return function decode({ bytes, type, signal }) {
    if (!Object.hasOwn(DEMUXERS, type)) return Promise.reject(new AudioDecodeError('unsupported-type'));
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_INPUT_BYTES || !SIGNATURES[type](bytes)) {
      return Promise.reject(new AudioDecodeError('invalid-input'));
    }
    if (signal?.aborted) return Promise.reject(new AudioDecodeError('aborted'));

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(executable, decoderArgs(type, { strict }), { shell: false, env: workerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        reject(new AudioDecodeError('unavailable'));
        return;
      }
      const chunks = [];
      let size = 0;
      let failure = null;
      let settled = false;
      let grace = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        signal?.removeEventListener('abort', onAbort);
        chunks.length = 0;
        if (error) reject(error);
        else resolve(value);
      };
      // Stops only this child. The call rejects when the child exits, or after
      // a short grace period if the kill fails or no exit is ever reported, so
      // a stuck or unkillable process can never hold the caller.
      const stop = (code) => {
        if (failure || settled) return;
        failure = code;
        chunks.length = 0;
        try {
          child.kill('SIGKILL');
        } catch {
          // The rejection below does not depend on the kill succeeding.
        }
        grace = setTimeout(() => finish(new AudioDecodeError(code)), killGraceMs);
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      // An abort that landed between the first check and registration still counts.
      if (signal?.aborted) onAbort();

      child.stdout.on('data', (chunk) => {
        if (failure || settled) return;
        size += chunk.length;
        // Over the limit means longer than allowed: reject rather than truncate.
        if (size > maxPcmBytes) {
          chunks.length = 0;
          stop('too-long');
          return;
        }
        chunks.push(chunk);
      });
      // Drained and discarded: decoder messages are never kept, returned or logged.
      // In strict mode only their presence is counted.
      let reported = false;
      if (strict) child.stderr.on('data', () => { reported = true; });
      else child.stderr.resume();
      child.stdin.on('error', () => {}); // ffmpeg may exit before reading all input
      child.on('error', (error) => {
        // A process that never started has nothing to wait for.
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') finish(new AudioDecodeError('unavailable'));
        else if (!failure) failure = 'decode-failed';
      });
      child.on('close', (exitCode) => {
        if (failure) {
          finish(new AudioDecodeError(failure));
          return;
        }
        const pcm = Buffer.concat(chunks, size);
        if (exitCode !== 0 || reported || pcm.length === 0 || pcm.length % 2 !== 0) {
          finish(new AudioDecodeError('decode-failed'));
          return;
        }
        finish(null, { pcm, sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, durationMs: Math.floor(pcm.length / BYTES_PER_MS) });
      });
      child.stdin.end(bytes);
    });
  };
}
