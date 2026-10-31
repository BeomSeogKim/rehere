import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { AudioDecodeError, MAX_PCM_BYTES, createAudioDecoder, decoderArgs, pcmWav } from '../audio-derivative.mjs';

const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const code = (expected) => (error) => error instanceof AudioDecodeError && error.code === expected;

// A child process stand-in: records its input and exits only when told to or killed.
function fakeSpawn({ stdout = Buffer.alloc(0), exitCode = 0, hang = false, stderr = 'private decoder detail /private-input/voice.webm' } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    const input = [];
    child.stdin = new Writable({ write(chunk, encoding, done) { input.push(chunk); done(); } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = null;
    child.kill = (signal) => {
      child.killed = signal;
      setImmediate(() => child.emit('close', null));
      return true;
    };
    calls.push({ executable, args, options, input, child });
    if (!hang) {
      child.stdin.on('finish', () => {
        if (stderr) child.stderr.write(stderr);
        child.stdout.end(stdout);
        setImmediate(() => child.emit('close', exitCode));
      });
    }
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

describe('playback WAV', () => {
  it('writes a fixed 44-byte PCM header and nothing else', () => {
    const pcm = Buffer.from([1, 0, 255, 127]);
    const wav = pcmWav(pcm);
    assert.equal(wav.length, 48);
    assert.deepEqual(wav.subarray(0, 44), Buffer.from([
      0x52, 0x49, 0x46, 0x46, 40, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0,
      0x80, 0x3e, 0, 0, 0x00, 0x7d, 0, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61, 4, 0, 0, 0,
    ]));
    assert.deepEqual(wav.subarray(44), pcm);
    assert.deepEqual(pcmWav(pcm), wav);
  });

  it('refuses empty, odd, oversized or non-buffer samples', () => {
    for (const pcm of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(MAX_PCM_BYTES + 2), 'abcd']) {
      assert.throws(() => pcmWav(pcm), code('decode-failed'));
    }
    assert.equal(pcmWav(Buffer.alloc(MAX_PCM_BYTES)).length, MAX_PCM_BYTES + 44);
  });
});

describe('strict input verification option', () => {
  it('adds strict error detection before the input, fails on any decoder error output, and leaves playback defaults unchanged', async () => {
    assert.deepEqual(decoderArgs('audio/webm', { strict: false }), decoderArgs('audio/webm'));
    assert.ok(!decoderArgs('audio/webm').includes('-err_detect'), 'story playback arguments are unchanged');
    const strict = decoderArgs('audio/ogg', { strict: true });
    const at = strict.indexOf('-err_detect');
    assert.deepEqual(strict.slice(at, at + 2), ['-err_detect', 'crccheck+bitstream+buffer+explode']);
    assert.ok(at < strict.indexOf('-i'), 'an input option');
    const filter = strict.indexOf('-af');
    assert.deepEqual(strict.slice(filter, filter + 2), ['-af', 'asetpts=N/SR/TB'], 'timestamps renumbered from the sample count');
    assert.ok(filter > strict.indexOf('-i') && filter < strict.indexOf('-ac'), 'an output filter before resampling');
    assert.deepEqual(strict.filter((_, index) => ![at, at + 1, filter, filter + 1].includes(index)), decoderArgs('audio/ogg'));

    const pcm = Buffer.alloc(3200);
    // The default decode ignores error output when ffmpeg exits 0.
    assert.equal((await createAudioDecoder({ spawnImpl: fakeSpawn({ stdout: pcm }) })({ bytes: WEBM_MAGIC, type: 'audio/webm' })).pcm.length, 3200);
    const reported = fakeSpawn({ stdout: pcm });
    const error = await createAudioDecoder({ spawnImpl: reported, strict: true })({ bytes: WEBM_MAGIC, type: 'audio/webm' }).catch((caught) => caught);
    assert.ok(code('decode-failed')(error), 'strict: any error output fails even with exit 0');
    assert.ok(!error.message.includes('private'));
    assert.deepEqual(reported.calls[0].args, decoderArgs('audio/webm', { strict: true }));
    const clean = await createAudioDecoder({ spawnImpl: fakeSpawn({ stdout: pcm, stderr: '' }), strict: true })({ bytes: WEBM_MAGIC, type: 'audio/webm' });
    assert.deepEqual([clean.pcm.length, clean.durationMs], [3200, 100], 'silent samples are valid');
    await assert.rejects(createAudioDecoder({ spawnImpl: fakeSpawn({ stdout: Buffer.alloc(0), stderr: '' }), strict: true })({ bytes: WEBM_MAGIC, type: 'audio/webm' }), code('decode-failed'));
  });
});

describe('decoder process contract', () => {
  it('runs ffmpeg without a shell, from stdin to stdout, with a forced demuxer and allowlisted environment', async () => {
    const saved = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = 'secret-not-for-the-decoder';
    try {
      const spawnImpl = fakeSpawn({ stdout: Buffer.alloc(64) });
      const result = await createAudioDecoder({ executable: '/opt/ffmpeg', spawnImpl })({ bytes: WEBM_MAGIC, type: 'audio/webm' });
      assert.deepEqual(result, { pcm: Buffer.alloc(64), sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 2 });
      const [call] = spawnImpl.calls;
      assert.equal(call.executable, '/opt/ffmpeg');
      assert.deepEqual(call.args, decoderArgs('audio/webm'));
      assert.equal(call.options.shell, false);
      assert.ok(Object.keys(call.options.env).every((key) => ['PATH', 'TMPDIR', 'LANG'].includes(key)));
      assert.deepEqual(Buffer.concat(call.input), WEBM_MAGIC);
    } finally {
      if (saved === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = saved;
    }
    const args = decoderArgs('audio/mp4');
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.deepEqual([after('-protocol_whitelist'), after('-f'), after('-i'), after('-map'), args.at(-1)], ['pipe', 'mov', 'pipe:0', '0:a:0', 'pipe:1']);
    for (const flag of ['-vn', '-sn', '-dn', '-xerror']) assert.ok(args.includes(flag));
    assert.equal(after('-map_metadata'), '-1');
    assert.equal(after('-map_chapters'), '-1');
    assert.ok(!args.includes('-t'));
    assert.deepEqual([decoderArgs('audio/webm')[decoderArgs('audio/webm').indexOf('-f') + 1], decoderArgs('audio/ogg')[decoderArgs('audio/ogg').indexOf('-f') + 1]], ['matroska', 'ogg']);
  });

  it('uses REHERE_FFMPEG when no executable is given', async () => {
    const saved = process.env.REHERE_FFMPEG;
    process.env.REHERE_FFMPEG = '/fixed/ffmpeg';
    try {
      const spawnImpl = fakeSpawn({ stdout: Buffer.alloc(2) });
      await createAudioDecoder({ spawnImpl })({ bytes: WEBM_MAGIC, type: 'audio/webm' });
      assert.equal(spawnImpl.calls[0].executable, '/fixed/ffmpeg');
    } finally {
      if (saved === undefined) delete process.env.REHERE_FFMPEG;
      else process.env.REHERE_FFMPEG = saved;
    }
  });

  it('rejects unsupported, empty, oversized or mismatched input before spawning', async () => {
    const spawnImpl = fakeSpawn();
    const decode = createAudioDecoder({ spawnImpl });
    await assert.rejects(decode({ bytes: WEBM_MAGIC, type: 'audio/wav' }), code('unsupported-type'));
    for (const [bytes, type] of [[Buffer.alloc(0), 'audio/webm'], [Buffer.from('OggS0000'), 'audio/webm'], [WEBM_MAGIC, 'audio/ogg'], [WEBM_MAGIC, 'audio/mp4'], ['text', 'audio/webm'],
      [Buffer.concat([WEBM_MAGIC, Buffer.alloc(50 * 1024 * 1024)]), 'audio/webm']]) {
      await assert.rejects(decode({ bytes, type }), code('invalid-input'));
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(decode({ bytes: WEBM_MAGIC, type: 'audio/webm', signal: controller.signal }), code('aborted'));
    assert.equal(spawnImpl.calls.length, 0);
  });

  it('rejects failed, empty or odd output, and never exposes decoder messages', async () => {
    for (const options of [{ stdout: Buffer.alloc(64), exitCode: 1 }, { stdout: Buffer.alloc(0) }, { stdout: Buffer.alloc(3) }]) {
      const error = await createAudioDecoder({ spawnImpl: fakeSpawn(options) })({ bytes: WEBM_MAGIC, type: 'audio/webm' }).catch((caught) => caught);
      assert.ok(code('decode-failed')(error));
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private|voice\.webm/);
    }
  });

  it('kills only its own child on output overflow, time limit or abort', async () => {
    const overflow = fakeSpawn({ stdout: Buffer.alloc(34) });
    await assert.rejects(createAudioDecoder({ spawnImpl: overflow, maxPcmBytes: 32 })({ bytes: WEBM_MAGIC, type: 'audio/webm' }), code('too-long'));
    assert.equal(overflow.calls[0].child.killed, 'SIGKILL');

    const slow = fakeSpawn({ hang: true });
    await assert.rejects(createAudioDecoder({ spawnImpl: slow, timeoutMs: 20 })({ bytes: WEBM_MAGIC, type: 'audio/webm' }), code('timeout'));
    assert.equal(slow.calls[0].child.killed, 'SIGKILL');

    const running = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const pending = createAudioDecoder({ spawnImpl: running })({ bytes: WEBM_MAGIC, type: 'audio/webm', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, code('aborted'));
    assert.equal(running.calls[0].child.killed, 'SIGKILL');
  });

  it('rejects within a bounded time even when the kill throws, fails or the child never exits', async () => {
    const uncaught = [];
    const onUncaught = (error) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const stuck = (kill) => {
        const spawnImpl = fakeSpawn({ hang: true });
        return (...args) => {
          const child = spawnImpl(...args);
          child.kill = kill;
          spawnImpl.calls.at(-1).child = child;
          return child;
        };
      };
      const throwing = stuck(() => {
        throw new Error('kill failed');
      });
      const refused = stuck(() => false);
      const started = Date.now();
      await assert.rejects(createAudioDecoder({ spawnImpl: throwing, timeoutMs: 10, killGraceMs: 20 })({ bytes: WEBM_MAGIC, type: 'audio/webm' }), code('timeout'));
      const controller = new AbortController();
      const pending = createAudioDecoder({ spawnImpl: refused, killGraceMs: 20 })({ bytes: WEBM_MAGIC, type: 'audio/webm', signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, code('aborted'));

      // Output past the limit, then silence: the overflow is rejected and late output is ignored.
      const late = fakeSpawn({ hang: true });
      const overflowing = (...args) => {
        const child = late(...args);
        child.kill = () => false;
        child.stdin.on('finish', () => {
          child.stdout.write(Buffer.alloc(40));
          setTimeout(() => child.stdout.write(Buffer.alloc(40)), 5);
        });
        return child;
      };
      await assert.rejects(createAudioDecoder({ spawnImpl: overflowing, maxPcmBytes: 32, killGraceMs: 20 })({ bytes: WEBM_MAGIC, type: 'audio/webm' }), code('too-long'));
      assert.ok(Date.now() - started < 1000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(uncaught, []);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('reports a missing executable as unavailable', async () => {
    await assert.rejects(createAudioDecoder({ executable: '/nonexistent/rehere-ffmpeg' })({ bytes: WEBM_MAGIC, type: 'audio/webm' }), code('unavailable'));
  });
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

describe('real ffmpeg decoding of synthetic test tones', { skip: !ffmpegAvailable && 'ffmpeg is not installed; real decoding tests skipped' }, () => {
  let dir;
  const fixture = async (name, args) => {
    const file = path.join(dir, name);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
    return readFile(file);
  };
  const tone = (frequency, seconds) => ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`];
  const decode = createAudioDecoder({ executable: 'ffmpeg' });
  // Dominant frequency from zero crossings of the decoded samples.
  const frequency = (pcm) => {
    let crossings = 0;
    for (let offset = 2; offset < pcm.length; offset += 2) if ((pcm.readInt16LE(offset - 2) < 0) !== (pcm.readInt16LE(offset) < 0)) crossings += 1;
    return crossings / 2 / (pcm.length / 2 / 16000);
  };

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-audio-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('decodes the full recording from WebM, Ogg and fast-start MP4 containers', async () => {
    const inputs = [
      ['tone.webm', 'audio/webm', [...tone(440, 2), '-c:a', 'libopus']],
      ['tone.ogg', 'audio/ogg', [...tone(440, 2), '-c:a', 'libopus']],
      ['tone.m4a', 'audio/mp4', [...tone(440, 2), '-c:a', 'aac', '-movflags', '+faststart']],
    ];
    for (const [name, type, args] of inputs) {
      const bytes = await fixture(name, args);
      const before = Buffer.from(bytes);
      const result = await decode({ bytes, type });
      assert.deepEqual([result.sampleRate, result.channels, result.bitsPerSample], [16000, 1, 16]);
      assert.ok(Math.abs(result.durationMs - 2000) <= 40, `${name}: ${result.durationMs} ms`);
      assert.ok(Math.abs(frequency(result.pcm) - 440) < 10, `${name}: ${frequency(result.pcm)} Hz`);
      assert.equal(result.pcm.length % 2, 0);
      assert.deepEqual(bytes, before);
      const wav = pcmWav(result.pcm);
      assert.equal(wav.readUInt32LE(40), result.pcm.length);
    }
  });

  it('decodes only the first audio track and copies no video, metadata or chapters', async () => {
    const chapters = path.join(dir, 'chapters.txt');
    await writeFile(chapters, ';FFMETADATA1\ntitle=Synthetic title marker\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=Synthetic chapter marker\n');
    const bytes = await fixture('tracks.mkv', [
      ...tone(440, 1), ...tone(1500, 1), '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=1', '-i', chapters,
      '-map', '0:a', '-map', '1:a', '-map', '2:v', '-map_metadata', '3', '-map_chapters', '3', '-c:a', 'libopus', '-c:v', 'mjpeg', '-f', 'matroska',
    ]);
    assert.ok(bytes.includes('Synthetic chapter marker'));
    const result = await decode({ bytes, type: 'audio/webm' });
    assert.ok(Math.abs(frequency(result.pcm) - 440) < 10, `${frequency(result.pcm)} Hz`);
    assert.ok(Math.abs(result.durationMs - 1000) <= 40);
    assert.ok(!pcmWav(result.pcm).includes('Synthetic'));
  });

  it('rejects a recording longer than 300 seconds instead of truncating it', async () => {
    const bytes = await fixture('long.webm', [...tone(440, 301), '-c:a', 'libopus', '-b:a', '16k']);
    await assert.rejects(decode({ bytes, type: 'audio/webm' }), code('too-long'));
    const exact = await fixture('exact.webm', [...tone(440, 1), '-c:a', 'libopus']);
    const { pcm } = await decode({ bytes: exact, type: 'audio/webm' });
    await assert.doesNotReject(createAudioDecoder({ maxPcmBytes: pcm.length })({ bytes: exact, type: 'audio/webm' }));
    await assert.rejects(createAudioDecoder({ maxPcmBytes: pcm.length - 2 })({ bytes: exact, type: 'audio/webm' }), code('too-long'));
  });

  it('fails honestly on malformed input and on MP4 whose index follows the audio', async () => {
    const garbage = Buffer.concat([WEBM_MAGIC, Buffer.alloc(4096, 0x5a)]);
    await assert.rejects(decode({ bytes: garbage, type: 'audio/webm' }), code('decode-failed'));
    const ogg = await fixture('cut.ogg', [...tone(440, 2), '-c:a', 'libopus']);
    await assert.rejects(decode({ bytes: Buffer.concat([ogg.subarray(0, 60), Buffer.alloc(2048, 0xff)]), type: 'audio/ogg' }), code('decode-failed'));
    // A pipe cannot seek, so a normal-length MP4 with its index at the end is refused.
    const endIndex = await fixture('end-index.m4a', [...tone(440, 120), '-c:a', 'aac']);
    await assert.rejects(decode({ bytes: endIndex, type: 'audio/mp4' }), code('decode-failed'));
  });
});
