import { BudgetLedger, META_API } from './meta-model.mjs';
import { STORY_LIMITS } from './stories.mjs';

export const TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
export const TRANSCRIBE_LABEL = 'Muse Voice Transcribe';
// A product limit for reviewable drafts; the provider accepts up to 10 minutes.
export const MAX_DRAFT_MS = 60_000;
// The published price is per hour of processed audio, billed per whole second.
export const USD_PER_AUDIO_MS = 0.18 / 3_600_000;
export const DEFAULT_TRANSCRIBE_LIMITS = Object.freeze({ totalUsd: 0.05, perRequestUsd: 0.005, maxRequests: 10 });
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
    admittedDurationMs: null, estimatedUsd: null, ...fields,
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
      try {
        sending = await admit(() => {
          started = now();
          return post(wav, combined);
        });
      } catch {
        sending = null;
      }
      if (!sending) {
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
export function metaTranscriberFromEnv({ ledgerFile, env = process.env }) {
  if (!env.MODEL_API_KEY || env.REHERE_TRANSCRIBE_LIVE !== '1') return null;
  const limits = {
    totalUsd: limit(env.REHERE_TRANSCRIBE_TOTAL_USD, DEFAULT_TRANSCRIBE_LIMITS.totalUsd),
    perRequestUsd: DEFAULT_TRANSCRIBE_LIMITS.perRequestUsd,
    maxRequests: Math.floor(limit(env.REHERE_TRANSCRIBE_MAX_REQUESTS, DEFAULT_TRANSCRIBE_LIMITS.maxRequests)),
  };
  const language = env.REHERE_TRANSCRIBE_LANGUAGE ? env.REHERE_TRANSCRIBE_LANGUAGE : null;
  return createMetaTranscriber({ apiKey: env.MODEL_API_KEY, ledger: new BudgetLedger({ file: ledgerFile, limits }), language });
}
