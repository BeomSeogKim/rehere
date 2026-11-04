// Optional SAM 3.1 (Meta Model API) outline proposals for two-object builds.
// Off unless REHERE_SEGMENTATION=sam-3.1; without it the local SAM2 worker
// path is unchanged. One concept prompt (the owner's object name) and the
// exact original photo bytes go to the Responses API per object. The server
// then selects at most one returned instance per owner box, or refuses.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BudgetLedger, META_API } from './meta-model.mjs';

export const SEGMENTATION_MODEL = 'sam-3.1';
export const SEGMENTATION_LABEL = 'SAM 3.1 (Meta Model API)';
// $2.50 per 1,000 images (dev.meta.ai/docs/pricing-rate-limits).
export const IMAGE_USD = 0.0025;
export const DEFAULT_SEGMENTATION_LIMITS = Object.freeze({ totalUsd: 0.05, perRequestUsd: IMAGE_USD, maxRequests: 20 });
export const MATCH_RULE = 'owner box vs returned instance box: IoU >= 0.5 and runner-up at least 0.15 lower; otherwise refused';
const MIN_IOU = 0.5;
const MIN_MARGIN = 0.15;
const MAX_INSTANCES = 64;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png' };

export class SegmentationError extends Error {
  constructor(message, code) {
    super(message);
    if (code !== undefined) this.code = code;
  }
}

// The exact Responses body. Key order is fixed here, so the digest of its
// JSON text binds prompt, photo bytes and options.
export function segmentationBody({ prompt, imageBytes, format }) {
  if (!MIME[format]) throw new SegmentationError('unsupported photo format');
  return {
    model: SEGMENTATION_MODEL,
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: prompt },
      { type: 'input_image', image_url: `data:${MIME[format]};base64,${Buffer.from(imageBytes).toString('base64')}` },
    ] }],
    stream: true,
    metadata: { include_confidence: 'true' },
  };
}

export const segmentationDigest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

const INT = '(0|[1-9][0-9]{0,6})';
const DEC = '([01](?:\\.[0-9]{1,20})?)';
const RECORD = new RegExp(`^${INT}<\\|box;x1=${INT};y1=${INT};x2=${INT};y2=${INT};w=${INT};h=${INT}(?:;c=${DEC})?\\|>`
  + `<\\|mask;x=0;y=0(?:;c=${DEC})?;data=${INT},${INT},([~!])([!-{}~]*)\\|>$`);

// Splits one image line into bounded records. Box and mask must agree with
// the exact photo: frame size equal, inclusive box inside it, mask raster the
// box size, marker lossless or one_bit. Anything else rejects the response.
export function parseInstances(outputText, { width, height }) {
  if (typeof outputText !== 'string' || outputText.length > MAX_OUTPUT_CHARS) throw new SegmentationError('response too large');
  const text = outputText.trim();
  if (text === '') return [];
  if (!text.startsWith('<0f>') || text.includes('\n')) throw new SegmentationError('response is not one image line');
  const parts = text.slice(4).split(/,(?=(?:0|[1-9][0-9]{0,6})<\|box;)/);
  if (parts.length > MAX_INSTANCES) throw new SegmentationError('too many instances');
  const seen = new Set();
  return parts.map((part) => {
    const m = RECORD.exec(part);
    if (!m) throw new SegmentationError('malformed instance record');
    const [, id, x1, y1, x2, y2, w, h, boxC, maskC, mh, mw] = m;
    const n = (value) => Number(value);
    if (seen.has(id)) throw new SegmentationError('duplicate instance id');
    seen.add(id);
    if (n(w) !== width || n(h) !== height) {
      if (width !== height && n(w) === height && n(h) === width) throw new SegmentationError('instance frame is the photo turned by 90 degrees', 'rotated');
      throw new SegmentationError('instance frame does not match the photo');
    }
    if (!(n(x1) <= n(x2) && n(y1) <= n(y2) && n(x2) < width && n(y2) < height)) throw new SegmentationError('instance box outside the photo');
    if (n(mw) !== n(x2) - n(x1) + 1 || n(mh) !== n(y2) - n(y1) + 1) throw new SegmentationError('mask raster does not match its box');
    if ((boxC ?? null) !== (maskC ?? null)) throw new SegmentationError('box and mask confidence differ');
    return { id: n(id), box: [n(x1), n(y1), n(x2) + 1, n(y2) + 1], confidence: boxC === undefined ? null : n(boxC), record: part };
  });
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

// Picks the one instance whose exclusive box matches the owner's box, or
// refuses on no match, a weak match or a near tie. Confidence is recorded
// as the model's estimate and never used to choose.
export function selectInstance(instances, ownerBox) {
  const scored = instances.map((item) => ({ ...item, iou: iou(item.box, ownerBox) })).sort((a, b) => b.iou - a.iou);
  const [best, next] = scored;
  if (!best || best.iou < MIN_IOU) return { refused: 'no returned instance matches the box closely enough', instances: instances.length };
  if (next && best.iou - next.iou < MIN_MARGIN) return { refused: 'two returned instances match the box almost equally', instances: instances.length };
  return {
    record: best.record,
    selection: {
      rule: MATCH_RULE, ownerBox: [...ownerBox], instances: instances.length, selectedInstance: best.id, selectedBox: best.box,
      iou: Number(best.iou.toFixed(4)), runnerUpIou: next ? Number(next.iou.toFixed(4)) : null, modelConfidence: best.confidence,
    },
  };
}

// Reads the Responses event stream; only output_text and the final record matter.
async function readStream(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  const out = { text: '', responseId: null, model: null, status: null, imagesProcessed: null };
  const handle = (line) => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return;
    const event = JSON.parse(line.slice(6));
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') out.text += event.delta;
    if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      out.status = event.response?.status ?? null;
      out.responseId = event.response?.id ?? null;
      out.model = event.response?.model ?? null;
      out.imagesProcessed = event.response?.usage?.images_processed ?? null;
    }
  };
  for (;;) {
    if (signal?.aborted) throw new SegmentationError('stopped');
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_OUTPUT_CHARS * 2) throw new SegmentationError('response too large');
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, index).replace(/\r$/, ''));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) handle(buffer.trim());
  return out;
}

// Live dispatch. A reservation is made before sending and settled only when
// the stream completes with one processed image; any other outcome keeps it.
export function createLiveSegmenter({ apiKey, ledger, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, recorder = null }) {
  return {
    mode: 'live',
    async segment({ prompt, imageBytes, format, signal }) {
      const body = segmentationBody({ prompt, imageBytes, format });
      const requestDigest = segmentationDigest(body);
      const reservation = await ledger.reserve(IMAGE_USD);
      if (!reservation) throw new SegmentationError('the segmentation budget is used up', 'budget');
      const started = Date.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(`${META_API}/responses`, {
        method: 'POST', signal: both,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new SegmentationError(`segmentation request failed (HTTP ${response.status})`);
      const out = await readStream(response, both);
      if (out.status !== 'completed' || out.model !== SEGMENTATION_MODEL || !out.responseId) throw new SegmentationError('segmentation did not complete');
      if (out.imagesProcessed === 1) await ledger.settle(reservation, IMAGE_USD);
      const result = { mode: 'live', requestDigest, responseId: out.responseId, model: out.model, outputText: out.text,
        imagesProcessed: out.imagesProcessed, latencyMs: Date.now() - started, recordedAt: new Date().toISOString() };
      if (recorder) await recorder({ ...result, prompt });
      return result;
    },
  };
}

export function parseStoredSegmentations(json) {
  if (!Array.isArray(json)) throw new SegmentationError('stored segmentations must be a list');
  return json.map((entry) => {
    if (!/^[0-9a-f]{64}$/.test(entry?.requestDigest ?? '') || entry.model !== SEGMENTATION_MODEL || typeof entry.responseId !== 'string'
      || typeof entry.outputText !== 'string' || typeof entry.recordedAt !== 'string') throw new SegmentationError('stored segmentation entry is invalid');
    return { requestDigest: entry.requestDigest, responseId: entry.responseId, model: entry.model, outputText: entry.outputText,
      imagesProcessed: entry.imagesProcessed ?? null, latencyMs: entry.latencyMs ?? null, recordedAt: entry.recordedAt };
  });
}

// Replays only a byte-identical request. A mismatch sends nothing and fails.
export function createStoredSegmenter({ entries }) {
  return {
    mode: 'recorded',
    async segment({ prompt, imageBytes, format, signal }) {
      if (signal?.aborted) throw new SegmentationError('stopped');
      const requestDigest = segmentationDigest(segmentationBody({ prompt, imageBytes, format }));
      const entry = entries.find((item) => item.requestDigest === requestDigest);
      if (!entry) throw new SegmentationError('no recorded SAM 3.1 response matches this exact request; nothing was sent');
      return { mode: 'recorded', ...entry };
    },
  };
}

export function segmentationRecorder(file) {
  return async (result) => {
    await mkdir(path.dirname(file), { recursive: true });
    let entries = [];
    try {
      entries = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify([...entries, result], null, 1), { mode: 0o600 });
    await rename(temp, file);
  };
}

const lower = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > fallback) throw new Error('Segmentation limits can only be lowered.');
  return number;
};

// null keeps the local SAM2 default. Opting in without a usable mode stops startup.
export function segmenterFromEnv({ ledgerFile, env = process.env }) {
  if (env.REHERE_SEGMENTATION === undefined || env.REHERE_SEGMENTATION === '') return null;
  if (env.REHERE_SEGMENTATION !== SEGMENTATION_MODEL) throw new Error('REHERE_SEGMENTATION accepts only sam-3.1.');
  const live = env.REHERE_SEGMENTATION_LIVE === '1';
  if (env.REHERE_SEGMENTATION_REPLAY) {
    if (live || env.REHERE_SEGMENTATION_RECORD) throw new Error('Stored SAM 3.1 responses cannot be combined with live use or recording.');
    return createStoredSegmenter({ entries: parseStoredSegmentations(JSON.parse(readFileSync(env.REHERE_SEGMENTATION_REPLAY, 'utf8'))) });
  }
  if (!live || !env.MODEL_API_KEY) throw new Error('SAM 3.1 segmentation needs REHERE_SEGMENTATION_REPLAY, or REHERE_SEGMENTATION_LIVE=1 with MODEL_API_KEY.');
  const maxRequests = lower(env.REHERE_SEGMENTATION_MAX_REQUESTS, DEFAULT_SEGMENTATION_LIMITS.maxRequests);
  if (!Number.isInteger(maxRequests)) throw new Error('REHERE_SEGMENTATION_MAX_REQUESTS must be a whole number of requests.');
  const limits = {
    totalUsd: lower(env.REHERE_SEGMENTATION_TOTAL_USD, DEFAULT_SEGMENTATION_LIMITS.totalUsd),
    perRequestUsd: IMAGE_USD,
    maxRequests,
  };
  const recorder = env.REHERE_SEGMENTATION_RECORD ? segmentationRecorder(env.REHERE_SEGMENTATION_RECORD) : null;
  return createLiveSegmenter({ apiKey: env.MODEL_API_KEY, ledger: new BudgetLedger({ file: ledgerFile, limits }), recorder });
}
