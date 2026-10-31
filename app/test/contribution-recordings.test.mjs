import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { AudioDecodeError } from '../audio-derivative.mjs';
import { createRecordingPreparer } from '../contribution-recordings.mjs';
import { RequestError } from '../drafts.mjs';
import { MediaVerificationError } from '../media-verification.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypiso5'), Buffer.alloc(60, 2)]);

// A decoder stand-in that records its calls and returns `pcm`.
function fakeDecode(pcm = Buffer.alloc(32_000, 3), extra = {}) {
  const calls = [];
  const decode = async (call) => {
    calls.push(call);
    return { pcm, sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: Math.floor(pcm.length / 32), ...extra };
  };
  decode.calls = calls;
  return decode;
}

const isRefusal = (code, status) => (error) => error instanceof MediaVerificationError && error.code === code && error.status === status;

describe('recording preparation', () => {
  it('decodes once with the detected type and returns only the original facts, playback facts and WAV', async () => {
    const decode = fakeDecode();
    const bytes = Buffer.from(MP4);
    const result = await createRecordingPreparer({ decode })({ bytes, signal: new AbortController().signal });
    assert.equal(decode.calls.length, 1);
    assert.equal(decode.calls[0].type, 'audio/mp4');
    assert.equal(decode.calls[0].bytes, bytes);
    assert.deepEqual(Object.keys(result).sort(), ['original', 'playback', 'wav']);
    assert.deepEqual(result.original, { sha256: sha256(MP4), size: MP4.length, type: 'audio/mp4', extension: 'm4a' });
    assert.deepEqual(result.playback, {
      sha256: sha256(result.wav), size: 32_044, type: 'audio/wav', durationMs: 1000, sampleRate: 16000, channels: 1, bitsPerSample: 16, parentSha256: sha256(MP4),
    });
    assert.equal(result.wav.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.deepEqual(result.wav.subarray(44), Buffer.alloc(32_000, 3));
    assert.deepEqual(bytes, MP4);
  });

  it('keeps a sub-millisecond decode with a floored duration of zero', async () => {
    const result = await createRecordingPreparer({ decode: fakeDecode(Buffer.alloc(2)) })({ bytes: Buffer.from(WEBM) });
    assert.deepEqual([result.playback.durationMs, result.playback.size], [0, 46]);
  });

  it('maps every decoder outcome to the existing media codes', async () => {
    const expected = {
      'unsupported-type': ['content', 400], 'invalid-input': ['content', 400], 'decode-failed': ['content', 400],
      'too-long': ['duration', 400], timeout: ['timeout', 503], aborted: ['aborted', 503], unavailable: ['unavailable', 503],
    };
    for (const [decoderCode, [code, status]] of Object.entries(expected)) {
      const decode = async () => { throw new AudioDecodeError(decoderCode); };
      await assert.rejects(createRecordingPreparer({ decode })({ bytes: Buffer.from(WEBM) }), isRefusal(code, status), decoderCode);
    }
    await assert.rejects(createRecordingPreparer({ decode: async () => { throw new Error('internal /private/path detail'); } })({ bytes: Buffer.from(WEBM) }),
      (error) => isRefusal('unavailable', 503)(error) && !error.message.includes('private'));
  });

  it('refuses empty, unrecognized, oversized and non-buffer input before decoding', async () => {
    const decode = fakeDecode();
    const prepare = createRecordingPreparer({ decode });
    await assert.rejects(prepare({ bytes: Buffer.alloc(0) }), isRefusal('content', 400));
    await assert.rejects(prepare({ bytes: Buffer.from('not a recording at all') }), isRefusal('content', 400));
    await assert.rejects(prepare({ bytes: Buffer.concat([WEBM, Buffer.alloc(50 * 1024 * 1024)]) }),
      (error) => error instanceof RequestError && !(error instanceof MediaVerificationError) && error.status === 413 && error.message === 'A voice recording must be 50 MB or smaller.');
    await assert.rejects(prepare({ bytes: new Uint8Array(WEBM) }), isRefusal('unavailable', 503));
    assert.equal(decode.calls.length, 0);
  });

  it('honours an abort before and after decoding', async () => {
    const decode = fakeDecode();
    const before = new AbortController();
    before.abort();
    await assert.rejects(createRecordingPreparer({ decode })({ bytes: Buffer.from(WEBM), signal: before.signal }), isRefusal('aborted', 503));
    assert.equal(decode.calls.length, 0);
    const during = new AbortController();
    const late = async () => { during.abort(); return fakeDecode()({}); };
    await assert.rejects(createRecordingPreparer({ decode: late })({ bytes: Buffer.from(WEBM), signal: during.signal }), isRefusal('aborted', 503));
  });

  it('refuses a result if the input changed or the decoder broke its contract', async () => {
    const mutating = async ({ bytes }) => { bytes[10] ^= 0xff; return fakeDecode()({}); };
    await assert.rejects(createRecordingPreparer({ decode: mutating })({ bytes: Buffer.from(WEBM) }), isRefusal('unavailable', 503));
    for (const broken of [fakeDecode(Buffer.alloc(3)), fakeDecode(Buffer.alloc(32), { durationMs: 5 }), fakeDecode(Buffer.alloc(32), { sampleRate: 44100 }),
      fakeDecode(Buffer.alloc(9_600_002)), async () => ({ durationMs: 0 })]) {
      await assert.rejects(createRecordingPreparer({ decode: broken })({ bytes: Buffer.from(WEBM) }), isRefusal('unavailable', 503));
    }
  });
});

// Tiny synthetic tones generated in memory by the local ffmpeg; no files are written.
const ffmpeg = process.env.REHERE_FFMPEG || 'ffmpeg';
const ffmpegReady = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const TONE = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
const CONTAINERS = {
  'audio/webm': [['-c:a', 'libopus', '-f', 'webm'], 'webm'],
  'audio/ogg': [['-c:a', 'libopus', '-f', 'ogg'], 'ogg'],
  'audio/mp4': [['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4'], 'm4a'],
};

describe('synthetic tones with the production decoder', { skip: !ffmpegReady && 'ffmpeg is not available' }, () => {
  for (const [type, [args, extension]] of Object.entries(CONTAINERS)) {
    it(`prepares a one-second ${type} tone with a strict decode`, async () => {
      const generated = spawnSync(ffmpeg, [...TONE, ...args, 'pipe:1'], { maxBuffer: 1024 * 1024 });
      assert.equal(generated.status, 0);
      const bytes = generated.stdout;
      const before = sha256(bytes);
      const result = await createRecordingPreparer()({ bytes, signal: new AbortController().signal });
      assert.deepEqual(result.original, { sha256: before, size: bytes.length, type, extension });
      // AAC priming can add a few tens of milliseconds to the decoded length.
      assert.ok(Math.abs(result.playback.durationMs - 1000) <= 60, `${result.playback.durationMs} ms`);
      assert.equal(result.playback.parentSha256, before);
      assert.equal(result.playback.size, result.wav.length);
      assert.equal(result.wav.length, 44 + result.wav.readUInt32LE(40));
      assert.equal(sha256(result.wav), result.playback.sha256);
      assert.equal(sha256(bytes), before, 'original bytes unchanged');
    });
  }
});
