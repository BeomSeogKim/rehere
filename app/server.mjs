import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessStore, isToken } from './access.mjs';
import { CollaborationStore } from './collaboration.mjs';
import { ShareStore, UNAVAILABLE as VISIT_UNAVAILABLE, isVisitToken } from './shares.mjs';
import { createAudioDecoder } from './audio-derivative.mjs';
import { StoryStore } from './stories.mjs';
import { DraftStore, LIMITS, RequestError, parseDraft } from './drafts.mjs';
import { parseApplyRequest, parseCancelRequest } from './memory-proposals.mjs';
import { metaModelFromEnv } from './meta-model.mjs';
import { ReconstructionStore, UUID_PATTERN, parseBuildRequest, pythonModelImage, pythonRunner } from './reconstructions.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const DEFAULT_PORT = 4317;
const THREE_DIR = fileURLToPath(new URL('./node_modules/three/', import.meta.url));
const JSON_BODY_BYTES = 16 * 1024;
// A written recollection may hold 10,000 UTF-16 code units; even with every
// unit escaped as \uXXXX (6 bytes) the body stays under this cap.
const CONTRIBUTION_BODY_BYTES = 64 * 1024;
// A recorded story may carry 20,000 code units of captions in up to 200 cues.
const STORY_BODY_BYTES = 256 * 1024;

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
  ['/access-ui.js', ['access-ui.js', 'text/javascript; charset=utf-8']],
  ['/collaboration.js', ['collaboration.js', 'text/javascript; charset=utf-8']],
  ['/visits.js', ['visits.js', 'text/javascript; charset=utf-8']],
  ['/scene-viewer.js', ['scene-viewer.js', 'text/javascript; charset=utf-8']],
  ['/shares.js', ['shares.js', 'text/javascript; charset=utf-8']],
  ['/source-controls.js', ['source-controls.js', 'text/javascript; charset=utf-8']],
  ['/playback.js', ['playback.js', 'text/javascript; charset=utf-8']],
  ['/story-player.js', ['story-player.js', 'text/javascript; charset=utf-8']],
  ['/stories.js', ['stories.js', 'text/javascript; charset=utf-8']],
  ['/scene-relations.js', ['scene-relations.js', 'text/javascript; charset=utf-8']],
  ['/arrangement.js', ['arrangement.js', 'text/javascript; charset=utf-8']],
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
const SOURCE_POLICY_PATH = /^\/api\/drafts\/([^/]+)\/sources\/([^/]+)\/policy$/;
const JOBS_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions$/;
const JOB_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)$/;
const JOB_EDIT_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/edit$/;
const JOB_ASSET_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/assets\/([^/]+)$/;
const PROPOSALS_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/proposals$/;
const PROPOSAL_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/proposals\/([^/]+)$/;
const PROPOSAL_ACTION_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/proposals\/([^/]+)\/(cancel|apply)$/;
const HISTORY_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/history$/;
const UNDO_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/undo$/;
const RELATIONSHIP_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/relationship$/;
const OBJECTS_CONFIRM_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/objects\/confirm$/;
const REVOKE_PATH = /^\/api\/invitations\/([^/]+)\/revoke$/;
const SCENE_COLLABORATION_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/(contributions|collaboration)$/;
const CONTRIBUTION_ACTION_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/contributions\/([^/]+)\/(review|withdraw)$/;
const ERA_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/variants\/([^/]+)\/era$/;
const NOT_FOUND = 'This scene could not be found.';
const SHARES_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/shares$/;
const PREVIEWS_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/shares\/previews$/;
const PREVIEW_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/shares\/previews\/([^/]+)$/;
const PREVIEW_ASSET_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/shares\/previews\/([^/]+)\/assets\/([^/]+)\/([^/]+)$/;
const SHARE_REVOKE_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/shares\/([^/]+)\/revoke$/;
const VISIT_ASSET_PATH = /^\/api\/visit\/assets\/([^/]+)\/([^/]+)$/;
const VISIT_STORY_PATH = /^\/api\/visit\/stories\/([^/]+)\/audio\.wav$/;
const PREVIEW_STORY_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/shares\/previews\/([^/]+)\/stories\/([^/]+)\/audio\.wav$/;
const STORIES_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/stories$/;
const STORY_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/stories\/([^/]+)$/;
const STORY_ACTION_PATH = /^\/api\/drafts\/([^/]+)\/reconstructions\/([^/]+)\/stories\/([^/]+)\/(audio\.wav|withdraw)$/;
const SHARE_ASSETS = new Set(['surface.json', 'texture.jpg']);
// Accepts exactly one Authorization header holding a canonical visit token.
function visitToken(req) {
  const values = req.headersDistinct?.authorization;
  if (!Array.isArray(values) || values.length !== 1 || !values[0].startsWith('Bearer ')) return null;
  const token = values[0].slice('Bearer '.length);
  return isVisitToken(token) ? token : null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const ATTEMPT_ADDRESSES = 1000;
const UNAUTHORIZED = 'Sign in to continue.';
const FORBIDDEN = 'This action is not allowed.';

// Counts rejected credential attempts per socket address in a sliding window.
// Attempts still being checked hold a slot, so concurrent guesses cannot all
// pass admission before their failures are recorded. Forwarded-IP headers are
// ignored, so on loopback every local client shares one bucket; the limit
// slows guessing but never locks an account permanently.
function attemptLimiter(now = Date.now) {
  const entries = new Map();
  const entry = (address) => {
    const current = entries.get(address) ?? { failures: [], pending: 0 };
    current.failures = current.failures.filter((time) => now() - time < ATTEMPT_WINDOW_MS);
    entries.delete(address);
    entries.set(address, current);
    if (entries.size > ATTEMPT_ADDRESSES) entries.delete(entries.keys().next().value);
    return current;
  };
  return {
    admit(address) {
      const current = entry(address);
      if (current.failures.length + current.pending >= ATTEMPT_LIMIT) return false;
      current.pending += 1;
      return true;
    },
    release(address, failed) {
      const current = entry(address);
      current.pending = Math.max(0, current.pending - 1);
      if (failed) current.failures.push(now());
    },
  };
}

function strictBody(body, keys) {
  const valid = body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));
  if (!valid) throw new RequestError(400, 'The request could not be read.');
  return body;
}

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

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

async function readJsonBody(req, maxBytes = JSON_BODY_BYTES) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new RequestError(415, 'The request could not be read.');
  }
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new RequestError(413, 'The request is too large.');
  const body = await readBody(req, maxBytes).catch((error) => {
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
  const size = asset.body ? asset.body.length : asset.size;
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': asset.type,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': end - start + 1,
    ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // A generated payload (such as a sanitized surface) is served from memory.
  if (asset.body) {
    res.end(asset.body.subarray(start, end + 1));
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
  accessStore = new AccessStore({ dataDir }),
  audioDecoder = createAudioDecoder(),
} = {}) {
  const store = new DraftStore(dataDir);
  const attempts = attemptLimiter();
  const reconstructions = new ReconstructionStore({
    dataDir, drafts: store, runner: reconstructionRunner, timeoutMs: reconstructionTimeoutMs, proposalModel, prepareImage: prepareModelImage,
  });
  const collaboration = new CollaborationStore({ reconstructions });
  const stories = new StoryStore({ reconstructions, audioDecoder });
  const shares = new ShareStore({ reconstructions, stories });

  // Visitor routes authenticate only with a Bearer visit token; cookies and
  // query strings are never read. Every refusal looks the same, and errors are
  // logged by name only so a token cannot reach the log.
  async function handleVisit(req, res, pathname) {
    const unavailable = () => sendJson(res, 404, { error: VISIT_UNAVAILABLE });
    const assetMatch = VISIT_ASSET_PATH.exec(pathname);
    const storyMatch = VISIT_STORY_PATH.exec(pathname);
    const token = visitToken(req);
    const reading = req.method === 'GET' || req.method === 'HEAD';
    const known = pathname === '/api/visit' || (assetMatch && UUID.test(assetMatch[1]) && SHARE_ASSETS.has(assetMatch[2])) || (storyMatch && UUID.test(storyMatch[1]));
    if (!reading || !token || !known) {
      unavailable();
      return;
    }
    try {
      if (assetMatch) sendAsset(req, res, await shares.visitAsset(token, assetMatch[1], assetMatch[2]));
      else if (storyMatch) sendAsset(req, res, await shares.visitStoryAudio(token, storyMatch[1]));
      else sendJson(res, 200, await shares.visit(token));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof RequestError) {
        unavailable();
        return;
      }
      console.error(`visit failed: ${error?.name ?? 'error'}`);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  }

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
    if (pathname === '/api/visit' || pathname.startsWith('/api/visit/')) {
      await handleVisit(req, res, pathname);
      return;
    }

    // The cookie name carries the port: browsers share cookies across ports
    // of one host, so another local instance must not replace this session.
    const cookieName = `rehere_session_${port}`;
    const cookie = (token, maxAge) => ({ 'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` });
    const sessionToken = () => {
      const token = cookieValue(req.headers.cookie, cookieName);
      return isToken(token, 'session') ? token : null;
    };
    const principal = async () => {
      const token = sessionToken();
      return token ? accessStore.session(token) : null;
    };
    const requirePrincipal = async () => {
      const current = await principal();
      if (!current) throw new RequestError(401, UNAUTHORIZED);
      return current;
    };
    const requireOwner = async () => {
      const current = await requirePrincipal();
      if (current.role !== 'owner') throw new RequestError(403, FORBIDDEN);
      return current;
    };
    // A contributor may reach only the memories they were invited to. The raw
    // path segment is compared, so a malformed ID is refused before any lookup.
    const requireScope = async (draftId) => {
      const current = await requirePrincipal();
      if (current.role !== 'owner' && !current.draftIds.includes(draftId)) throw new RequestError(403, FORBIDDEN);
      return current;
    };
    // Rejected attempts count toward the limit whatever the reason.
    const attempt = async (task) => {
      const address = req.socket.remoteAddress ?? '';
      if (!attempts.admit(address)) throw new RequestError(429, 'Too many attempts. Try again later.');
      let failed = false;
      try {
        return await task();
      } catch (error) {
        failed = error instanceof RequestError && error.status < 500;
        throw error;
      } finally {
        attempts.release(address, failed);
      }
    };

    if (pathname === '/api/session' && reading) {
      const { initialized } = await accessStore.state();
      sendJson(res, 200, { initialized, principal: await principal() });
      return;
    }
    if (pathname === '/api/session/login' && req.method === 'POST') {
      const { accessKey } = strictBody(await readJsonBody(req), ['accessKey']);
      const login = await attempt(() => accessStore.login(accessKey));
      sendJson(res, 200, { principal: login.principal }, cookie(login.sessionToken, SESSION_MAX_AGE_SECONDS));
      return;
    }
    if (pathname === '/api/session/logout' && req.method === 'POST') {
      strictBody(await readJsonBody(req), []);
      const token = sessionToken();
      if (token) await accessStore.logout(token);
      sendJson(res, 200, { ok: true }, cookie('', 0));
      return;
    }
    if (pathname === '/api/session/recover' && req.method === 'POST') {
      // The browser cookie is cleared whatever the outcome; a failed attempt
      // leaves every server-side session as it was.
      let recovered;
      try {
        const body = strictBody(await readJsonBody(req), ['recoveryKey', 'newAccessKey', 'newRecoveryKey']);
        recovered = await attempt(() => accessStore.recover(body));
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        sendJson(res, error.status, { error: error.message }, { ...cookie('', 0), connection: 'close' });
        return;
      }
      sendJson(res, 200, { principal: recovered }, cookie('', 0));
      return;
    }
    if (pathname === '/api/invitations/redeem' && req.method === 'POST') {
      const body = strictBody(await readJsonBody(req), ['token', 'requestId', 'displayName', 'accessKey', 'recoveryKey']);
      sendJson(res, 200, { principal: await attempt(() => accessStore.redeemInvitation(body)) });
      return;
    }
    if (pathname === '/api/invitations' && reading) {
      const owner = await requireOwner();
      sendJson(res, 200, await accessStore.invitations(owner.id));
      return;
    }
    if (pathname === '/api/invitations' && req.method === 'POST') {
      const owner = await requireOwner();
      const body = strictBody(await readJsonBody(req), ['requestId', 'draftId', 'expiresInHours', 'token']);
      if (typeof body.draftId !== 'string' || !UUID.test(body.draftId)) throw new RequestError(400, 'The request could not be read.');
      if (!(await store.get(body.draftId))) throw new RequestError(404, 'This memory could not be found.');
      sendJson(res, 201, await accessStore.createInvitation(owner.id, body));
      return;
    }
    const revokeMatch = REVOKE_PATH.exec(pathname);
    if (revokeMatch && req.method === 'POST') {
      const owner = await requireOwner();
      strictBody(await readJsonBody(req), []);
      sendJson(res, 200, await accessStore.revokeInvitation(owner.id, revokeMatch[1]));
      return;
    }
    if (pathname === '/api/contributor/places') {
      const current = await requirePrincipal();
      if (!reading) throw new RequestError(405, 'Method not allowed.');
      sendJson(res, 200, await collaboration.places(current));
      return;
    }
    const sceneCollaboration = SCENE_COLLABORATION_PATH.exec(pathname);
    const contributionAction = CONTRIBUTION_ACTION_PATH.exec(pathname);
    const eraMatch = ERA_PATH.exec(pathname);
    const collaborationMatch = sceneCollaboration ?? contributionAction ?? eraMatch;
    if (collaborationMatch) {
      const [, draftId, jobId, third, fourth] = collaborationMatch;
      const current = await requireScope(draftId);
      const ownerOnly = eraMatch || fourth === 'review';
      if (ownerOnly && current.role !== 'owner') throw new RequestError(403, FORBIDDEN);
      const writing = req.method === 'POST' && (!sceneCollaboration || third === 'contributions');
      if (!(sceneCollaboration && reading) && !writing) throw new RequestError(405, 'Method not allowed.');
      if (!UUID.test(draftId) || !UUID.test(jobId)) throw new RequestError(404, NOT_FOUND);
      if (sceneCollaboration && reading) {
        sendJson(res, 200, await collaboration.get(draftId, jobId, current));
        return;
      }
      if (sceneCollaboration) {
        const body = strictBody(await readJsonBody(req, CONTRIBUTION_BODY_BYTES), ['requestId', 'text', 'permissions', 'periodClaim']);
        sendJson(res, 200, await collaboration.submit(draftId, jobId, current, body));
        return;
      }
      if (!UUID.test(third)) throw new RequestError(404, eraMatch ? 'This version could not be found.' : 'This contribution could not be found.');
      if (eraMatch) {
        const body = strictBody(await readJsonBody(req), ['requestId', 'baseRevision', 'kind', 'label', 'start', 'end', 'statement', 'relation', 'relativeToVariantId', 'confirmed']);
        sendJson(res, 200, await collaboration.era(draftId, jobId, current, third, body));
        return;
      }
      if (fourth === 'review') {
        const body = strictBody(await readJsonBody(req), ['requestId', 'baseVersion', 'baseRevision', 'decision', 'reason', 'conflict', 'transform']);
        sendJson(res, 200, await collaboration.review(draftId, jobId, current, third, body));
        return;
      }
      const body = strictBody(await readJsonBody(req), ['requestId']);
      sendJson(res, 200, await collaboration.withdraw(draftId, jobId, current, third, body));
      return;
    }
    // Every other API route serves private content: the owner session is
    // checked before any path, ID, range or body is examined.
    const owner = pathname.startsWith('/api/') ? await requireOwner() : null;

    const policyMatch = SOURCE_POLICY_PATH.exec(pathname);
    if (policyMatch) {
      const [, draftId, sourceId] = policyMatch;
      if (!UUID.test(draftId) || !UUID.test(sourceId)) throw new RequestError(404, 'This material could not be found.');
      if (reading) {
        sendJson(res, 200, await reconstructions.sourcePolicy(draftId, sourceId, owner));
        return;
      }
      if (req.method !== 'POST') throw new RequestError(405, 'Method not allowed.');
      const body = strictBody(await readJsonBody(req), ['requestId', 'baseRevision', 'permissions', 'stopUse']);
      sendJson(res, 200, await reconstructions.restrictSource(draftId, sourceId, owner, body));
      return;
    }

    const storiesMatch = STORIES_PATH.exec(pathname);
    const storyMatch = STORY_PATH.exec(pathname);
    const storyActionMatch = STORY_ACTION_PATH.exec(pathname);
    const anyStoryMatch = storiesMatch ?? storyMatch ?? storyActionMatch;
    if (anyStoryMatch) {
      const [, draftId, jobId, storyId, action] = anyStoryMatch;
      if (!UUID.test(draftId) || !UUID.test(jobId)) throw new RequestError(404, NOT_FOUND);
      if (storyId !== undefined && !UUID.test(storyId)) throw new RequestError(404, 'This story could not be found.');
      if (storiesMatch && reading) {
        sendJson(res, 200, await stories.list(draftId, jobId, owner));
        return;
      }
      if (storiesMatch && req.method === 'POST') {
        const body = await readJsonBody(req, STORY_BODY_BYTES);
        sendJson(res, 201, await stories.create(draftId, jobId, owner, body));
        return;
      }
      if (storyMatch && reading) {
        sendJson(res, 200, await stories.get(draftId, jobId, owner, storyId));
        return;
      }
      if (action === 'audio.wav' && reading) {
        sendAsset(req, res, await stories.audio(draftId, jobId, owner, storyId));
        return;
      }
      if (action === 'withdraw' && req.method === 'POST') {
        sendJson(res, 200, await stories.withdraw(draftId, jobId, owner, storyId, await readJsonBody(req)));
        return;
      }
      throw new RequestError(405, 'Method not allowed.');
    }
    const previewStoryMatch = PREVIEW_STORY_PATH.exec(pathname);
    if (previewStoryMatch) {
      const [, draftId, jobId, previewId, publicStoryId] = previewStoryMatch;
      if (![draftId, jobId, previewId, publicStoryId].every((id) => UUID.test(id))) throw new RequestError(404, 'Not found.');
      if (!reading) throw new RequestError(405, 'Method not allowed.');
      sendAsset(req, res, await shares.previewStoryAudio(draftId, jobId, owner, previewId, publicStoryId));
      return;
    }

    const previewsMatch = PREVIEWS_PATH.exec(pathname);
    const previewMatch = PREVIEW_PATH.exec(pathname);
    const previewAssetMatch = PREVIEW_ASSET_PATH.exec(pathname);
    const sharesMatch = SHARES_PATH.exec(pathname);
    const revokeShareMatch = SHARE_REVOKE_PATH.exec(pathname);
    const shareMatch = previewsMatch ?? previewMatch ?? previewAssetMatch ?? sharesMatch ?? revokeShareMatch;
    if (shareMatch) {
      // The owner gate above already ran; IDs are checked before any lookup.
      const owner = await requireOwner();
      const [, draftId, jobId, third, fourth, fifth] = shareMatch;
      if (!UUID.test(draftId) || !UUID.test(jobId)) throw new RequestError(404, NOT_FOUND);
      if ((previewMatch || previewAssetMatch || revokeShareMatch) && !UUID.test(third)) throw new RequestError(404, 'This share could not be found.');
      if (previewsMatch && req.method === 'POST') {
        // Exact keys, including the optional storyIds, are checked by the share store.
        const body = await readJsonBody(req);
        sendJson(res, 201, await shares.createPreview(draftId, jobId, owner, body));
        return;
      }
      if (previewMatch && reading) {
        sendJson(res, 200, await shares.getPreview(draftId, jobId, owner, third));
        return;
      }
      if (previewAssetMatch && reading) {
        if (!UUID.test(fourth) || !SHARE_ASSETS.has(fifth)) throw new RequestError(404, 'Not found.');
        sendAsset(req, res, await shares.previewAsset(draftId, jobId, owner, third, fourth, fifth));
        return;
      }
      if (sharesMatch && req.method === 'POST') {
        const body = strictBody(await readJsonBody(req), ['requestId', 'previewId', 'previewDigest', 'token', 'consent']);
        sendJson(res, 201, await shares.issue(draftId, jobId, owner, body));
        return;
      }
      if (sharesMatch && reading) {
        sendJson(res, 200, await shares.list(draftId, jobId, owner));
        return;
      }
      if (revokeShareMatch && req.method === 'POST') {
        const body = strictBody(await readJsonBody(req), ['requestId']);
        sendJson(res, 200, await shares.revoke(draftId, jobId, owner, third, body));
        return;
      }
      throw new RequestError(405, 'Method not allowed.');
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
      // One- and two-object scenes take different bodies; the store reads the scene first.
      sendJson(res, 200, await reconstructions.edit(editMatch[1], editMatch[2], await readJsonBody(req)));
      return;
    }
    const proposalsMatch = PROPOSALS_PATH.exec(pathname);
    if (proposalsMatch && req.method === 'POST') {
      sendJson(res, 202, await reconstructions.createProposal(proposalsMatch[1], proposalsMatch[2], await readJsonBody(req)));
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
      sendJson(res, 200, await reconstructions.undo(undoMatch[1], undoMatch[2], await readJsonBody(req)));
      return;
    }
    const relationshipMatch = RELATIONSHIP_PATH.exec(pathname);
    if (relationshipMatch && req.method === 'POST') {
      sendJson(res, 200, await reconstructions.relationship(relationshipMatch[1], relationshipMatch[2], await readJsonBody(req)));
      return;
    }
    const confirmMatch = OBJECTS_CONFIRM_PATH.exec(pathname);
    if (confirmMatch && req.method === 'POST') {
      sendJson(res, 200, await reconstructions.confirmObjects(confirmMatch[1], confirmMatch[2], await readJsonBody(req)));
      return;
    }
    const jobAssetMatch = JOB_ASSET_PATH.exec(pathname);
    if (jobAssetMatch && reading) {
      const asset = await reconstructions.asset(...jobAssetMatch.slice(1));
      if (!asset) sendJson(res, 404, { error: 'Not found.' });
      else sendAsset(req, res, asset);
      return;
    }

    // Draft reads always go through the current source-use projection, so
    // stopped material never appears in a draft, its summary or a preview.
    const policies = reconstructions.sourcePolicies;
    if (pathname === '/api/drafts' && req.method === 'POST') {
      const draft = await store.create(await parseDraft(await readForm(req, limits.requestBytes), limits));
      sendJson(res, 201, await policies.projectDraft(draft));
      return;
    }
    if (pathname === '/api/drafts' && reading) {
      const drafts = await store.list();
      sendJson(res, 200, (await Promise.all(drafts.map((draft) => policies.projectDraft(draft)))).map(summary));
      return;
    }
    const assetMatch = ASSET_PATH.exec(pathname);
    if (assetMatch && reading) {
      const draft = await store.get(assetMatch[1]);
      if (!draft) throw new RequestError(404, 'Not found.');
      // Checked before any file lookup, range or HEAD handling.
      await policies.assertArchiveAsset(draft, assetMatch[2]);
      const asset = await store.asset(assetMatch[1], assetMatch[2]);
      if (!asset) sendJson(res, 404, { error: 'Not found.' });
      else sendAsset(req, res, asset);
      return;
    }
    const draftMatch = DRAFT_PATH.exec(pathname);
    if (draftMatch && reading) {
      const draft = await store.get(draftMatch[1]);
      if (draft) sendJson(res, 200, await policies.projectDraft(draft));
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
