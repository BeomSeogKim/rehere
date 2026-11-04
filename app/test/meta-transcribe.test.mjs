import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BudgetLedger } from '../meta-model.mjs';
import { MAX_DRAFT_MS, TRANSCRIBE_MODEL, USD_PER_AUDIO_MS, createMetaTranscriber, cuesFromTurns, metaTranscriberFromEnv } from '../meta-transcribe.mjs';

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function ledger(limits) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-transcribe-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'transcribe-budget.json');
  return { file, ledger: new BudgetLedger({ file, ...(limits && { limits }) }) };
}

const turn = (turnId, startMs, endMs, transcript) => ({ turnId, startMs, endMs, transcript });
const admitNow = async (start) => ({ value: start() });
const WAV = Buffer.alloc(44 + 32_000);
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });

describe('mapping transcription turns to caption cues', () => {
  it('keeps ordered spoken turns on the recording timeline', () => {
    const result = cuesFromTurns({ turns: [turn('t1', 0, 1200, ' The counter was here. '), turn('t2', 1500, 3000, 'By the window.')] }, 3000);
    assert.deepEqual(result, { ok: true, cues: [{ startMs: 0, endMs: 1200, text: 'The counter was here.' }, { startMs: 1500, endMs: 3000, text: 'By the window.' }] });
  });

  it('reports silent or empty audio as no speech', () => {
    assert.deepEqual(cuesFromTurns({ transcript: '', turns: [] }, 1000), { ok: false, reason: 'empty' });
    assert.deepEqual(cuesFromTurns({ turns: [turn('t1', 0, 900, '   ')] }, 1000), { ok: false, reason: 'empty' });
  });

  it('rejects the whole answer for malformed, overlapping, out-of-order or out-of-range turns', () => {
    for (const turns of [
      [turn('t1', 0, 500, 7)], [turn('t1', 0.5, 500, 'a')], [turn('t1', -1, 500, 'a')], [turn('t1', 500, 500, 'a')], [null],
      [turn('t1', 0, 600, 'a'), turn('t2', 500, 900, 'b')],
      [turn('t1', 500, 900, 'a'), turn('t2', 0, 400, 'b')],
      [turn('t1', 0, 1101, 'a')],
      [turn('t1', 1000, 1050, 'a')],
      [turn('t1', 0, 500, 'x'.repeat(2001))],
    ]) assert.deepEqual(cuesFromTurns({ turns }, 1000), { ok: false, reason: 'invalid' }, JSON.stringify(turns).slice(0, 80));
    for (const result of [null, {}, { turns: 'none' }]) assert.deepEqual(cuesFromTurns(result, 1000), { ok: false, reason: 'invalid' });
  });

  it('clamps an end that rounds at most 100 ms past the recording and drops control characters', () => {
    assert.deepEqual(cuesFromTurns({ turns: [turn('t1', 0, 1100, 'bell\u0007 rang')] }, 1000), { ok: true, cues: [{ startMs: 0, endMs: 1000, text: 'bell  rang' }] });
  });
});

describe('the Muse Voice Transcribe client', () => {
  it('sends one ENDPOINTING WAV request and records the provider IDs without inventing usage', async () => {
    const { ledger: budget } = await ledger();
    const calls = [];
    let clock = 1000;
    const transcribe = createMetaTranscriber({
      apiKey: 'test-key', ledger: budget, now: () => (clock += 25),
      fetch: async (url, init) => {
        calls.push({ url, init, request: JSON.parse(await init.body.get('request').text()), audio: init.body.get('audio') });
        return json({ sessionId: 'session-from-provider', transcript: 'Hello.', audioDurationMs: 1000, turns: [turn('t1', 0, 900, 'Hello.')] }, { headers: { 'x-request-id': 'provider-request-1' } });
      },
    });
    const result = await transcribe({ wav: WAV, durationMs: 1000, admit: admitNow });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.meta.ai/v1/asr/transcribe');
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
    assert.equal(calls[0].init.redirect, 'error');
    assert.deepEqual(calls[0].request, { model: TRANSCRIBE_MODEL, mode: 'ENDPOINTING', audioEncoding: 'WAV' });
    assert.equal(calls[0].audio.type, 'audio/wav');
    assert.equal(calls[0].audio.size, WAV.length);
    assert.deepEqual(result, {
      ok: true, cues: [{ startMs: 0, endMs: 900, text: 'Hello.' }],
      call: {
        model: TRANSCRIBE_MODEL, modelLabel: 'Muse Voice Transcribe', dispatched: true, httpStatus: 200, providerRequestId: 'provider-request-1', providerSessionId: 'session-from-provider',
        latencyMs: 25, admittedDurationMs: 1000, estimatedUsd: 1000 * USD_PER_AUDIO_MS,
      },
    });
    assert.equal(Object.hasOwn(result.call, 'usage'), false);
    // A dispatched request keeps its estimated reservation: the API reports no usage.
    assert.deepEqual((await budget.read()).entries.map(({ state, reservedUsd }) => ({ state, reservedUsd })), [{ state: 'reserved', reservedUsd: 1000 * USD_PER_AUDIO_MS }]);
  });

  it('marks provider IDs unavailable when the response has none', async () => {
    const { ledger: budget } = await ledger();
    const transcribe = createMetaTranscriber({ apiKey: 'k', ledger: budget, fetch: async () => json({ turns: [turn('t1', 0, 500, 'a')] }) });
    const { call } = await transcribe({ wav: WAV, durationMs: 1000, admit: admitNow });
    assert.equal(call.providerRequestId, null);
    assert.equal(call.providerSessionId, null);
  });

  it('sends nothing without admission or over 60 seconds, and settles a refused admission at zero', async () => {
    const { ledger: budget } = await ledger({ totalUsd: 0.05, perRequestUsd: 0.005, maxRequests: 10 });
    let fetched = 0;
    const transcribe = createMetaTranscriber({ apiKey: 'k', ledger: budget, fetch: async () => { fetched += 1; return json({ turns: [] }); } });
    assert.equal((await transcribe({ wav: WAV, durationMs: 1000 })).reason, 'restricted');
    assert.equal((await transcribe({ wav: WAV, durationMs: 1000, admit: async () => null })).reason, 'restricted');
    assert.equal((await transcribe({ wav: WAV, durationMs: 1000, admit: async () => { throw new Error('changed'); } })).reason, 'restricted');
    assert.equal((await transcribe({ wav: WAV, durationMs: MAX_DRAFT_MS + 1, admit: admitNow })).reason, 'tooLong');
    assert.equal(fetched, 0);
    assert.deepEqual((await budget.read()).entries.map((entry) => [entry.state, entry.estimatedUsd]), [['settled', 0], ['settled', 0]]);
  });

  it('enforces the request limit across ledger instances', async () => {
    const { file } = await ledger();
    const limits = { totalUsd: 0.05, perRequestUsd: 0.005, maxRequests: 2 };
    let fetched = 0;
    const make = () => createMetaTranscriber({ apiKey: 'k', ledger: new BudgetLedger({ file, limits }), fetch: async () => { fetched += 1; return json({ turns: [turn('t1', 0, 500, 'a')] }); } });
    assert.equal((await make()({ wav: WAV, durationMs: 1000, admit: admitNow })).ok, true);
    assert.equal((await make()({ wav: WAV, durationMs: 1000, admit: admitNow })).ok, true);
    assert.equal((await make()({ wav: WAV, durationMs: 1000, admit: admitNow })).reason, 'budget');
    assert.equal(fetched, 2);
  });

  it('keeps the reservation for every dispatched request, including error responses and unusable answers', async () => {
    const { ledger: budget } = await ledger();
    const answers = [
      () => new Response('{"error":{"type":"invalid_request"}}', { status: 400 }),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('', { status: 504 }),
      () => new Response('not json', { status: 200 }),
      () => json({ turns: [turn('t1', 0, 5000, 'past the end')] }),
      () => { throw new TypeError('network'); },
    ];
    const transcribe = createMetaTranscriber({ apiKey: 'k', ledger: budget, fetch: async () => answers.shift()() });
    const results = [];
    for (let index = 0; index < 6; index++) results.push(await transcribe({ wav: WAV, durationMs: 1000, admit: admitNow }));
    assert.deepEqual(results.map(({ reason, unknown, call }) => [reason, unknown === true, call.dispatched, call.httpStatus]),
      [['provider', false, true, 400], ['provider', false, true, 502], ['provider', false, true, 504], ['invalid', false, true, 200], ['invalid', false, true, 200], ['provider', true, true, null]]);
    assert.deepEqual((await budget.read()).entries.map((entry) => entry.state), Array(6).fill('reserved'));
  });

  it('times out once with no retry and keeps the reservation', async () => {
    const { ledger: budget } = await ledger();
    let fetched = 0;
    const transcribe = createMetaTranscriber({
      apiKey: 'k', ledger: budget, timeoutMs: 20,
      fetch: (url, init) => { fetched += 1; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); },
    });
    const result = await transcribe({ wav: WAV, durationMs: 1000, admit: admitNow });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.call.dispatched, true);
    assert.equal(fetched, 1);
    assert.deepEqual((await budget.read()).entries.map((entry) => entry.state), ['reserved']);
  });

  it('discards an answer that arrives after the caller aborted', async () => {
    const { ledger: budget } = await ledger();
    const controller = new AbortController();
    const transcribe = createMetaTranscriber({ apiKey: 'k', ledger: budget, fetch: async () => { controller.abort(); return json({ turns: [turn('t1', 0, 500, 'late')] }); } });
    const result = await transcribe({ wav: WAV, durationMs: 1000, signal: controller.signal, admit: admitNow });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'canceled');
    assert.equal(result.cues, undefined);
  });

  it('is off unless the key and its own live flag are set, and limits can only be lowered', async () => {
    const { file } = await ledger();
    assert.equal(metaTranscriberFromEnv({ ledgerFile: file, env: { MODEL_API_KEY: 'k' } }), null);
    assert.equal(metaTranscriberFromEnv({ ledgerFile: file, env: { MODEL_API_KEY: 'k', REHERE_MODEL_LIVE: '1' } }), null);
    assert.equal(typeof metaTranscriberFromEnv({ ledgerFile: file, env: { MODEL_API_KEY: 'k', REHERE_TRANSCRIBE_LIVE: '1', REHERE_TRANSCRIBE_MAX_REQUESTS: '2' } }), 'function');
    assert.throws(() => metaTranscriberFromEnv({ ledgerFile: file, env: { MODEL_API_KEY: 'k', REHERE_TRANSCRIBE_LIVE: '1', REHERE_TRANSCRIBE_TOTAL_USD: '5' } }));
  });
});
