import { createHash } from 'node:crypto';
import { MAX_INPUT_BYTES, MAX_PCM_BYTES, createAudioDecoder, pcmWav } from './audio-derivative.mjs';
import { RequestError, detectMedia } from './drafts.mjs';
import { MediaVerificationError } from './media-verification.mjs';

// Prepares one contributed recording: a single strict local decode of the
// first audio track both verifies the untrusted bytes and yields the 16 kHz
// mono WAV listening copy. The original bytes are never changed; the decoded
// samples and any decoder output are not returned. Files, metadata, captions
// and publication belong to the caller.

const SAMPLE_RATE = 16_000;
const MAX_DURATION_MS = MAX_PCM_BYTES / 32;
// Decoder outcomes mapped to the existing media verification codes.
const DECODE_CODES = Object.freeze({
  'unsupported-type': 'content',
  'invalid-input': 'content',
  'decode-failed': 'content',
  'too-long': 'duration',
  timeout: 'timeout',
  aborted: 'aborted',
  unavailable: 'unavailable',
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const refuse = (code) => new MediaVerificationError(code, 'voice');

export function createRecordingPreparer({ decode = createAudioDecoder({ strict: true }) } = {}) {
  return async ({ bytes, signal }) => {
    if (!Buffer.isBuffer(bytes)) throw refuse('unavailable');
    if (bytes.length === 0) throw refuse('content');
    if (bytes.length > MAX_INPUT_BYTES) throw new RequestError(413, `A voice recording must be ${MAX_INPUT_BYTES / (1024 * 1024)} MB or smaller.`);
    if (signal?.aborted) throw refuse('aborted');
    // The container comes from the bytes; client MIME types and names are never trusted.
    const detected = detectMedia('voice', bytes);
    if (!detected.type) throw refuse('content');
    const originalSha256 = sha256(bytes);

    let decoded;
    try {
      decoded = await decode({ bytes, type: detected.type, signal });
    } catch (error) {
      throw refuse(DECODE_CODES[error?.code] ?? 'unavailable');
    }
    if (signal?.aborted) throw refuse('aborted');
    if (sha256(bytes) !== originalSha256) throw refuse('unavailable');

    // A result outside the decoder's own contract is a decoder fault, not a bad file.
    const { pcm, durationMs } = decoded ?? {};
    if (!Buffer.isBuffer(pcm) || decoded.sampleRate !== SAMPLE_RATE || decoded.channels !== 1 || decoded.bitsPerSample !== 16
      || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS || durationMs !== Math.floor(pcm.length / 32)) {
      throw refuse('unavailable');
    }
    let wav;
    try {
      wav = pcmWav(pcm);
    } catch {
      throw refuse('unavailable');
    }
    return {
      original: { sha256: originalSha256, size: bytes.length, type: detected.type, extension: detected.extension },
      playback: {
        sha256: sha256(wav), size: wav.length, type: 'audio/wav', durationMs, sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16,
        parentSha256: originalSha256,
      },
      wav,
    };
  };
}
