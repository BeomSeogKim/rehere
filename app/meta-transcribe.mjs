import { BudgetLedger, META_API } from './meta-model.mjs';
import { STORY_LIMITS } from './stories.mjs';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
export const TRANSCRIBE_LABEL = 'Muse Voice Transcribe';
// A product limit for reviewable drafts; the provider accepts up to 10 minutes.
export const MAX_DRAFT_MS = 60_000;
// The published price is per hour of processed audio, rounded down to whole
// seconds, so an estimate from the exact admitted milliseconds is never below
// the billed amount. Estimates are local bounds, not bills.
export const USD_PER_AUDIO_MS = 0.18 / 3_600_000;
export const DEFAULT_TRANSCRIBE_LIMITS = Object.freeze({ totalUsd: 0.05, perRequestUsd: 0.005, maxRequests: 10 });
const STRICT_TOTAL_USD = 0.003;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

async function syncDirectory(file) {
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// A dedicated one-attempt workspace. The permanent marker precedes the ledger
// write, so an interrupted reservation refuses reuse even before any send.
export class StrictTranscribeLedger {
  #unstarted = new Set();
  constructor({ file, oneShotFile, limits }) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || typeof oneShotFile !== 'string' || !path.isAbsolute(oneShotFile)
        || path.resolve(file) === path.resolve(oneShotFile) || !exact(limits, ['totalUsd', 'perRequestUsd', 'maxRequests'])
        || !positive(limits.totalUsd) || limits.totalUsd > STRICT_TOTAL_USD || !positive(limits.perRequestUsd)
        || limits.perRequestUsd > limits.totalUsd || limits.maxRequests !== 1) throw new Error('Strict transcription requires explicit one-attempt limits and distinct absolute ledger paths.');
    this.file = file;
    this.oneShotFile = oneShotFile;
    this.limits = Object.freeze({ ...limits });
    this.queue = Promise.resolve();
  }

  serialize(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async #marker() {
    let text;
    try { text = await readFile(this.oneShotFile, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return this.#validateMarker(JSON.parse(text));
  }

  #validateMarker(marker) {
    if (!exact(marker, ['id', 'reservedUsd', 'at']) || !UUID.test(marker.id) || !positive(marker.reservedUsd)
        || marker.reservedUsd > this.limits.perRequestUsd || !timestamp(marker.at)) throw new Error('The transcription one-shot marker is unreadable.');
    return marker;
  }

  async read() {
    const state = JSON.parse(await readFile(this.file, 'utf8'));
    return this.#validateState(state, await this.#marker());
  }

  #validateState(state, marker) {
    if (!exact(state, ['entries']) || !Array.isArray(state.entries) || state.entries.length > 1) throw new Error('The strict transcription ledger is unreadable.');
    const [entry] = state.entries;
    if (!entry) {
      if (marker) throw new Error('The transcription reservation was interrupted or reset.');
      return state;
    }
    if (!exact(entry, ['id', 'state', 'reservedUsd', 'estimatedUsd', 'at']) || !UUID.test(entry.id)
        || !['reserved', 'settled'].includes(entry.state) || !positive(entry.reservedUsd) || entry.reservedUsd > this.limits.perRequestUsd
        || !timestamp(entry.at) || (entry.state === 'reserved' ? entry.estimatedUsd !== null : entry.estimatedUsd !== 0)
        || !marker || marker.id !== entry.id || marker.reservedUsd !== entry.reservedUsd || marker.at !== entry.at) throw new Error('The strict transcription reservation is inconsistent.');
    return state;
  }

  async write(state, { reservation = false } = {}) {
    // Marker creation temporarily precedes the first ledger row. Require the
    // existing file itself here; never create or repair a missing ledger.
    const current = JSON.parse(await readFile(this.file, 'utf8'));
    if (!exact(current, ['entries']) || !Array.isArray(current.entries) || current.entries.length > 1) throw new Error('The strict transcription ledger is unreadable.');
    if (reservation) {
      const marker = await this.#marker(), entry = state.entries[0];
      if (current.entries.length || !marker || marker.id !== entry.id || marker.reservedUsd !== entry.reservedUsd || marker.at !== entry.at) {
        throw new Error('The transcription reservation could not be persisted.');
      }
    } else await this.read();
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
      await syncDirectory(this.file);
    } finally { await rm(temp, { force: true }); }
  }

  reserve(reservedUsd) {
    return this.serialize(async () => {
      const state = await this.read();
      if (state.entries.length || !positive(reservedUsd) || reservedUsd > this.limits.perRequestUsd || reservedUsd > this.limits.totalUsd) return null;
      const marker = { id: randomUUID(), reservedUsd, at: new Date().toISOString() };
      let handle;
      try { handle = await open(this.oneShotFile, 'wx', 0o600); } catch (error) {
        if (error.code === 'EEXIST') return null;
        throw error;
      }
      try { await handle.writeFile(JSON.stringify(marker)); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(this.oneShotFile);
      await this.write({ entries: [{ ...marker, state: 'reserved', estimatedUsd: null }] }, { reservation: true });
      this.#unstarted.add(marker.id);
      return marker.id;
    });
  }

  markStarted(id) {
    // This synchronous check stays inside the caller's admission mutex.
    const state = this.#validateState(JSON.parse(readFileSync(this.file, 'utf8')),
      this.#validateMarker(JSON.parse(readFileSync(this.oneShotFile, 'utf8'))));
    if (state.entries[0]?.id !== id || state.entries[0].state !== 'reserved') throw new Error('The transcription reservation is unavailable.');
    if (!this.#unstarted.delete(id)) throw new Error('The transcription attempt cannot be started again.');
  }

  settle(id, estimatedUsd) {
    return this.serialize(async () => {
      const state = await this.read();
      const [entry] = state.entries;
      if (!entry || entry.id !== id || entry.state !== 'reserved' || estimatedUsd !== 0 || !this.#unstarted.delete(id)) {
        throw new Error('A started or unknown transcription reservation cannot be released.');
      }
      await this.write({ entries: [{ ...entry, state: 'settled', estimatedUsd: 0 }] });
    });
  }
}
// The language names the provider documents for `languageBias`.
export const BIAS_LANGUAGES = Object.freeze([
  'Arabic', 'Bengali', 'Dutch', 'English', 'French', 'German', 'Hebrew', 'Hindi', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean',
  'Malay', 'Mandarin Chinese', 'Marathi', 'Polish', 'Portuguese', 'Spanish', 'Tagalog', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Vietnamese',
]);
const TIMEOUT_MS = 30_000;
const RESPONSE_BYTES = 256 * 1024;
// Turn ends may round past the decoded length; a larger overshoot means the
// turns do not describe this recording.
const END_TOLERANCE_MS = 100;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const failure = (reason) => ({ ok: false, reason });

// Maps ENDPOINTING turns to caption cues on the decoded recording's timeline.
// Silent turns are skipped. Any malformed, overlapping, out-of-order or
// out-of-range turn rejects the whole answer instead of guessing a repair.
export function cuesFromTurns(result, durationMs) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.turns)) return failure('invalid');
  const cues = [];
  let previousEnd = 0;
  let total = 0;
  for (const turn of result.turns) {
    if (!turn || typeof turn !== 'object' || typeof turn.transcript !== 'string') return failure('invalid');
    const { startMs } = turn;
    let { endMs } = turn;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) return failure('invalid');
    const text = turn.transcript.replace(CONTROL, ' ').trim();
    if (text === '') continue;
    if (endMs > durationMs) {
      if (endMs - durationMs > END_TOLERANCE_MS) return failure('invalid');
      endMs = durationMs;
    }
    if (startMs < previousEnd || endMs <= startMs || text.length > STORY_LIMITS.cueText) return failure('invalid');
    total += text.length;
    previousEnd = endMs;
    cues.push({ startMs, endMs, text });
  }
  if (cues.length === 0) return failure('empty');
  if (cues.length > STORY_LIMITS.cues || total > STORY_LIMITS.cueTotal) return failure('invalid');
  return { ok: true, cues };
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The production caption drafter. Reserve, then send once; there are no
// automatic retries. The request starts only through `admit`, which the caller
// runs under its policy mutex: `admit(start)` resolves to { value: start() }
// when sending is still allowed, or null. The key is sent only in the
// Authorization header and never logged. `language` optionally biases
// recognition toward one documented language name; without it the provider
// detects the language.
//
// Every outcome carries `call`: whether a request was dispatched, its HTTP
// status, the provider's request and session IDs when it returned them (null
// otherwise) and the latency. The API reports no usage, so none is invented:
// a dispatched request always keeps its full estimated reservation, because an
// error response alone does not establish that no audio was processed.
export function createMetaTranscriber({ apiKey, ledger, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = Date.now, language = null }) {
  if (!apiKey) throw new Error('A model API key is required.');
  if (language !== null && !BIAS_LANGUAGES.includes(language)) throw new Error('The transcription language must be one of the documented language names.');
  const options = { model: TRANSCRIBE_MODEL, mode: 'ENDPOINTING', audioEncoding: 'WAV', ...(language && { languageBias: [language] }) };
  const strict = ledger instanceof StrictTranscribeLedger;
  let busy = false;
  const post = async (wav, signal) => {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify(options)], { type: 'application/json' }));
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    const response = await fetch(`${META_API}/asr/transcribe`, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, body: form, signal, redirect: 'error',
    });
    const requestId = response.headers?.get?.('x-request-id') ?? null;
    const raw = await readLimited(response, RESPONSE_BYTES);
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { ok: response.ok, status: response.status, requestId, json };
  };
  const call = (fields = {}) => ({
    model: TRANSCRIBE_MODEL, modelLabel: TRANSCRIBE_LABEL, dispatched: false, httpStatus: null, providerRequestId: null, providerSessionId: null, latencyMs: null,
    admittedDurationMs: null, estimatedUsd: null, responseOrigin: 'live', ...fields,
  });
  const id = (value) => (typeof value === 'string' && value !== '' ? value.slice(0, 200) : null);

  return async function transcribe({ wav, durationMs, signal, admit }) {
    if (typeof admit !== 'function') return { ...failure('restricted'), call: call() };
    if (!Buffer.isBuffer(wav) || !Number.isInteger(durationMs) || durationMs <= 0) return { ...failure('invalid'), call: call() };
    if (durationMs > MAX_DRAFT_MS) return { ...failure('tooLong'), call: call() };
    if (busy) return { ...failure('busy'), call: call() };
    busy = true;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const stopped = () => failure(signal?.aborted ? 'canceled' : 'timeout');
    try {
      const estimate = { admittedDurationMs: durationMs, estimatedUsd: durationMs * USD_PER_AUDIO_MS };
      const reservation = await ledger.reserve(estimate.estimatedUsd);
      if (!reservation) return { ...failure('budget'), call: call() };
      let sending = null;
      let started = null;
      let startedRequest = null;
      let admissionOpen = true;
      try {
        sending = await admit(() => {
          if (strict) {
            if (!admissionOpen || started !== null) throw new Error('The transcription admission is no longer open.');
            ledger.markStarted(reservation);
          }
          started = now();
          startedRequest = post(wav, combined);
          // Admission can fail after start without returning its promise.
          if (strict) startedRequest.catch(() => {});
          return startedRequest;
        });
      } catch {
        sending = null;
      } finally {
        admissionOpen = false;
      }
      if (!sending || (strict && sending.value !== startedRequest)) {
        if (strict && started !== null) {
          return { ...(combined.aborted ? stopped() : failure('provider')), unknown: true,
            call: call({ ...estimate, dispatched: true, latencyMs: now() - started }) };
        }
        await ledger.settle(reservation, 0);
        return { ...(combined.aborted ? stopped() : failure('restricted')), call: call() };
      }
      let answer;
      try {
        answer = await sending.value;
      } catch {
        // An unknown outcome keeps its full reservation.
        return { ...(combined.aborted ? stopped() : failure('provider')), unknown: true, call: call({ ...estimate, dispatched: true, latencyMs: now() - started }) };
      }
      if (strict) await ledger.read();
      const record = call({
        ...estimate, dispatched: true, httpStatus: answer.status, providerRequestId: id(answer.requestId), providerSessionId: id(answer.json?.sessionId), latencyMs: now() - started,
      });
      if (!answer.ok) {
        console.error(`transcription failed: HTTP ${answer.status}`);
        return { ...failure('provider'), call: record };
      }
      if (combined.aborted) return { ...stopped(), call: record };
      return { ...cuesFromTurns(answer.json, durationMs), call: record };
    } finally {
      busy = false;
    }
  };
}

function limit(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > fallback) throw new Error('Transcription limits can only be lowered.');
  return number;
}

// Live use needs the key and its own enable flag, separate from the planner's.
// Limit overrides can only lower the defaults. REHERE_TRANSCRIBE_LANGUAGE
// optionally names one documented language to bias recognition toward.
export function metaTranscriberFromEnv({ ledgerFile, oneShotFile, env = process.env }) {
  if (!env.MODEL_API_KEY || env.REHERE_TRANSCRIBE_LIVE !== '1') return null;
  if (env.REHERE_TRANSCRIBE_STRICT === '1') {
    const totalUsd = Number(env.REHERE_TRANSCRIBE_TOTAL_USD);
    if (!positive(totalUsd) || totalUsd > STRICT_TOTAL_USD || Number(env.REHERE_TRANSCRIBE_MAX_REQUESTS) !== 1) {
      throw new Error('Strict transcription requires an explicit total no greater than 0.003 and exactly one attempt.');
    }
    const ledger = new StrictTranscribeLedger({ file: ledgerFile, oneShotFile, limits: { totalUsd, perRequestUsd: totalUsd, maxRequests: 1 } });
    const language = env.REHERE_TRANSCRIBE_LANGUAGE ? env.REHERE_TRANSCRIBE_LANGUAGE : null;
    return createMetaTranscriber({ apiKey: env.MODEL_API_KEY, ledger, language });
  }
  const limits = {
    totalUsd: limit(env.REHERE_TRANSCRIBE_TOTAL_USD, DEFAULT_TRANSCRIBE_LIMITS.totalUsd),
    perRequestUsd: DEFAULT_TRANSCRIBE_LIMITS.perRequestUsd,
    maxRequests: Math.floor(limit(env.REHERE_TRANSCRIBE_MAX_REQUESTS, DEFAULT_TRANSCRIBE_LIMITS.maxRequests)),
  };
  const language = env.REHERE_TRANSCRIBE_LANGUAGE ? env.REHERE_TRANSCRIBE_LANGUAGE : null;
  return createMetaTranscriber({ apiKey: env.MODEL_API_KEY, ledger: new BudgetLedger({ file: ledgerFile, limits }), language });
}
