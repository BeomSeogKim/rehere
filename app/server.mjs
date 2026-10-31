import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DraftStore, LIMITS, RequestError, parseDraft } from './drafts.mjs';
import { parseApplyRequest, parseCancelRequest, parseProposalRequest, parseUndoRequest } from './memory-proposals.mjs';
import { metaModelFromEnv } from './meta-model.mjs';
import { ReconstructionStore, UUID_PATTERN, parseBuildRequest, parseEditRequest, pythonModelImage, pythonRunner } from './reconstructions.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const DEFAULT_PORT = 4317;
const THREE_DIR = fileURLToPath(new URL('./node_modules/three/', import.meta.url));
const JSON_BODY_BYTES = 16 * 1024;

// A fixed list keeps request paths from ever reaching the file system directly.
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/recorder.js', ['recorder.js', 'text/javascript; charset=utf-8']],
  ['/latest.js', ['latest.js', 'text/javascript; charset=utf-8']],
  ['/source-details.js', ['source-details.js', 'text/javascript; charset=utf-8']],
  ['/space.js', ['space.js', 'text/javascript; charset=utf-8']],
  ['/photo-scene.js', ['photo-scene.js', 'text/javascript; charset=utf-8']],
  ['/memory-edit.js', ['memory-edit.js', 'text/javascript; charset=utf-8']],
]);

// Pinned local Three.js files. OrbitControls imports the bare specifier
// 'three', which browsers cannot resolve without an inline import map.
const VENDOR_FILES = new Map([
  ['/vendor/three.module.js', ['build/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.core.js', ['build/three.core.js', 'text/javascript; charset=utf-8']],
  ['/vendor/OrbitControls.js', ['examples/jsm/controls/OrbitControls.js', 'text/javascript; charset=utf-8', (text) => text.replace("from 'three';", "from '/vendor/three.module.js';")]],
  ['/vendor/THREE-LICENSE', ['LICENSE', 'text/plain; charset=utf-8']],
]);

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
};

const ASSET_PATH = /^\/api\/drafts\/([^/]+)\/assets\/([^/]+)$/;
const DRAFT_PATH = /^\/api\/drafts\/([^/]+)$/;
const SOURCE_SIZE_PATH = /^\/api\/drafts\/([^/]+)\/sources\/([^/]+)\/image-size$/;
const JOBS_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions$/;
const JOB_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)$/;
const JOB_EDIT_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/edit$/;
const JOB_ASSET_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/assets\/([^/]+)$/;
const PROPOSALS_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/proposals$/;
const PROPOSAL_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/proposals\/([^/]+)$/;
const PROPOSAL_ACTION_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/proposals\/([^/]+)\/(cancel|apply)$/;
const HISTORY_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/history$/;
const UNDO_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/undo$/;

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

// Counts bytes as they arrive, so a missing or false Content-Length cannot make
// the server buffer more than the cap before multipart parsing starts.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        req.pause();
        reject(tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function tooLarge(maxBytes) {
  return new RequestError(413, `Everything saved at once must total ${maxBytes / (1024 * 1024)} MB or less.`);
}

async function readForm(req, maxBytes) {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    throw new RequestError(415, 'The upload could not be read.');
  }
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw tooLarge(maxBytes);
  const body = await readBody(req, maxBytes);
  try {
    return await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
  } catch {
    throw new RequestError(400, 'The upload could not be read.');
  }
}

async function readJsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new RequestError(415, 'The request could not be read.');
  }
  const declared = Number(req.headers['content-length']);
  if (declared > JSON_BODY_BYTES) throw new RequestError(413, 'The request is too large.');
  const body = await readBody(req, JSON_BODY_BYTES).catch((error) => {
    throw error instanceof RequestError ? new RequestError(413, 'The request is too large.') : error;
  });
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RequestError(400, 'The request could not be read.');
  }
}

async function sendStatic(req, res, file, type, transform) {
  let body = await readFile(file);
  if (transform) body = Buffer.from(transform(body.toString('utf8')));
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function summary(draft) {
  return {
    id: draft.id,
    createdAt: draft.createdAt,
    photoCount: draft.photos.length,
    hasVoice: Boolean(draft.voice),
    textPreview: draft.text.slice(0, 140),
  };
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(size - Number(match[2]), 0);
    end = size - 1;
  }
  return start <= end && start < size ? { start, end } : 'invalid';
}

// Safari plays recorded audio only when byte ranges are supported.
function sendAsset(req, res, asset) {
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': asset.type,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const range = req.headers.range ? parseRange(req.headers.range, asset.size) : null;
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${asset.size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: asset.size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': end - start + 1,
    ...(range && { 'content-range': `bytes ${start}-${end}/${asset.size}` }),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(asset.file, { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
}

// reconstructionRunner, reconstructionTimeoutMs, proposalModel and
// prepareModelImage are for tests and local wiring only; no request can choose
// the runner, the model, its endpoint, key or limits. Without a proposalModel
// memory-based proposals are refused rather than simulated.
export function createAppServer({
  dataDir = DEFAULT_DATA_DIR,
  limits = LIMITS,
  reconstructionRunner = pythonRunner(),
  reconstructionTimeoutMs,
  proposalModel = null,
  prepareModelImage = pythonModelImage(),
} = {}) {
  const store = new DraftStore(dataDir);
  const reconstructions = new ReconstructionStore({
    dataDir, drafts: store, runner: reconstructionRunner, timeoutMs: reconstructionTimeoutMs, proposalModel, prepareImage: prepareModelImage,
  });

  async function handle(req, res) {
    const { port } = server.address();
    const host = req.headers.host;
    // Rejects other host names, including DNS-rebinding attempts from web pages.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      sendJson(res, 403, { error: 'This address is not allowed.' });
      return;
    }
    const { pathname } = new URL(req.url, `http://${host}`);
    const reading = req.method === 'GET' || req.method === 'HEAD';

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        sendJson(res, 403, { error: 'This request is not allowed.' });
        return;
      }
    }

    const sizeMatch = SOURCE_SIZE_PATH.exec(pathname);
    if (sizeMatch && reading) {
      sendJson(res, 200, await reconstructions.imageSize(sizeMatch[1], sizeMatch[2]));
      return;
    }
    const jobsMatch = JOBS_PATH.exec(pathname);
    if (jobsMatch && req.method === 'POST') {
      const request = parseBuildRequest(await readJsonBody(req));
      sendJson(res, 202, await reconstructions.create(jobsMatch[1], request));
      return;
    }
    if (jobsMatch && reading) {
      sendJson(res, 200, await reconstructions.list(jobsMatch[1]));
      return;
    }
    const jobMatch = JOB_PATH.exec(pathname);
    if (jobMatch && reading) {
      const job = await reconstructions.get(jobMatch[1], jobMatch[2]);
      if (job) sendJson(res, 200, job);
      else sendJson(res, 404, { error: 'This scene could not be found.' });
      return;
    }
    const editMatch = JOB_EDIT_PATH.exec(pathname);
    if (editMatch && req.method === 'POST') {
      const request = parseEditRequest(await readJsonBody(req));
      sendJson(res, 200, await reconstructions.edit(editMatch[1], editMatch[2], request));
      return;
    }
    const proposalsMatch = PROPOSALS_PATH.exec(pathname);
    if (proposalsMatch && req.method === 'POST') {
      const request = parseProposalRequest(await readJsonBody(req));
      sendJson(res, 202, await reconstructions.createProposal(proposalsMatch[1], proposalsMatch[2], request));
      return;
    }
    if (proposalsMatch && reading) {
      sendJson(res, 200, await reconstructions.proposals(proposalsMatch[1], proposalsMatch[2]));
      return;
    }
    const proposalMatch = PROPOSAL_PATH.exec(pathname) ?? PROPOSAL_ACTION_PATH.exec(pathname);
    if (proposalMatch && !UUID_PATTERN.test(proposalMatch[3])) {
      sendJson(res, 404, { error: 'This proposal could not be found.' });
      return;
    }
    const [, draftId, jobId, proposalId, action] = proposalMatch ?? [];
    if (proposalMatch && !action && reading) {
      sendJson(res, 200, await reconstructions.proposal(draftId, jobId, proposalId));
      return;
    }
    if (action === 'cancel' && req.method === 'POST') {
      parseCancelRequest(await readJsonBody(req));
      sendJson(res, 200, await reconstructions.cancelProposal(draftId, jobId, proposalId));
      return;
    }
    if (action === 'apply' && req.method === 'POST') {
      const request = parseApplyRequest(await readJsonBody(req));
      sendJson(res, 200, await reconstructions.applyProposal(draftId, jobId, proposalId, request));
      return;
    }
    const historyMatch = HISTORY_PATH.exec(pathname);
    if (historyMatch && reading) {
      sendJson(res, 200, await reconstructions.history(historyMatch[1], historyMatch[2]));
      return;
    }
    const undoMatch = UNDO_PATH.exec(pathname);
    if (undoMatch && req.method === 'POST') {
      const request = parseUndoRequest(await readJsonBody(req));
      sendJson(res, 200, await reconstructions.undo(undoMatch[1], undoMatch[2], request));
      return;
    }
    const jobAssetMatch = JOB_ASSET_PATH.exec(pathname);
    if (jobAssetMatch && reading) {
      const asset = await reconstructions.asset(...jobAssetMatch.slice(1));
      if (!asset) sendJson(res, 404, { error: 'Not found.' });
      else sendAsset(req, res, asset);
      return;
    }

    if (pathname === '/api/drafts' && req.method === 'POST') {
      const draft = await store.create(await parseDraft(await readForm(req, limits.requestBytes), limits));
      sendJson(res, 201, draft);
      return;
    }
    if (pathname === '/api/drafts' && reading) {
      sendJson(res, 200, (await store.list()).map(summary));
      return;
    }
    const assetMatch = ASSET_PATH.exec(pathname);
    if (assetMatch && reading) {
      const asset = await store.asset(assetMatch[1], assetMatch[2]);
      if (!asset) sendJson(res, 404, { error: 'Not found.' });
      else sendAsset(req, res, asset);
      return;
    }
    const draftMatch = DRAFT_PATH.exec(pathname);
    if (draftMatch && reading) {
      const draft = await store.get(draftMatch[1]);
      if (draft) sendJson(res, 200, draft);
      else sendJson(res, 404, { error: 'This memory could not be found.' });
      return;
    }
    const staticFile = STATIC_FILES.get(pathname);
    if (staticFile && reading) {
      const [name, type] = staticFile;
      await sendStatic(req, res, path.join(PUBLIC_DIR, name), type);
      return;
    }
    const vendorFile = VENDOR_FILES.get(pathname);
    if (vendorFile && reading) {
      const [name, type, transform] = vendorFile;
      await sendStatic(req, res, path.join(THREE_DIR, name), type, transform);
      return;
    }
    if (staticFile || vendorFile || pathname.startsWith('/api/drafts')) {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    sendJson(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof RequestError) {
        // An unread request body may still be arriving; closing avoids reading it.
        sendJson(res, error.status, { error: error.message }, { connection: 'close' });
        return;
      }
      console.error(error);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' }, { connection: 'close' });
    });
  });
  // Closing the server also stops an active model process.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    const stopping = reconstructions.close();
    return closeServer((error) => stopping.then(() => callback?.(error), () => callback?.(error)));
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createAppServer({ proposalModel: metaModelFromEnv({ ledgerFile: path.join(DEFAULT_DATA_DIR, 'model-budget.json') }) }).listen(port, '127.0.0.1', () => {
    console.log(`Rehere is running at http://127.0.0.1:${port}/`);
  });
}
