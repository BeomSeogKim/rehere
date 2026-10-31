import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { RequestError } from './drafts.mjs';
import { surfaceMeshes } from './public/photo-scene.js';

export const TARGET_ID = 'selected-foreground';
export const ACTIONS = Object.freeze(['translate', 'rotate', 'face_anchor', 'clarify']);
export const PLAN_KEYS = Object.freeze(['action', 'targetId', 'sourceId', 'baseVersion', 'delta', 'yawDelta', 'anchor', 'question', 'reason']);
export const TEXT_LIMIT = 2000;
const OFFSET_LIMIT = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Plain text only: no control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const IMAGE_BYTES = 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;

export const ACTIVE_PROPOSAL = new Set(['queued', 'processing']);
// Unapplied proposals that a new saved version makes out of date.
const OPEN_PROPOSAL = new Set(['queued', 'processing', 'ready', 'clarify']);

export const PROPOSAL_MESSAGES = {
  canceled: 'The proposal was canceled.',
  interrupted: 'The app stopped before this proposal finished. A model request that was already sent may still count toward usage.',
  image: 'The photo could not be prepared for the model.',
  invalid: 'The model answer did not match a change this scene supports, so nothing is offered to apply. Try rephrasing the memory.',
  range: 'The proposed change would move or turn the object outside the editable range, so nothing is offered to apply.',
  anchor: 'The proposed facing point is on the object itself or at its centre, so nothing is offered to apply.',
  refused: 'The model declined to plan this change.',
  incomplete: 'The model did not finish an answer, so nothing is offered to apply.',
  budget: 'The local spending limit for model generations has been reached, so no generation request was sent. The photo and message may already have been sent for token counting.',
  tooLarge: 'The input for the model was larger than allowed, so no generation request was sent. The photo and message were already sent for token counting.',
  timeout: 'The model took too long and the request was stopped.',
  provider: 'The model service could not complete the request.',
  unknown: 'The proposal could not be prepared. Please try again.',
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isRequestId = (value) => typeof value === 'string' && UUID.test(value);
const isVersion = (value) => Number.isInteger(value) && value >= 1;

function readable(body, keys, valid) {
  if (!exactKeys(body, keys) || !valid(body)) throw new RequestError(400, 'The request could not be read.');
  return { ...body };
}

export function parseProposalRequest(body) {
  const request = readable(body, ['requestId', 'baseVersion', 'text', 'consent'], ({ requestId, baseVersion, text, consent }) =>
    isRequestId(requestId) && isVersion(baseVersion) && typeof text === 'string' && text.trim() !== ''
    && Array.from(text).length <= TEXT_LIMIT && typeof consent === 'boolean');
  if (request.consent !== true) throw new RequestError(403, 'Sending the photo and message to the model needs explicit consent.');
  return request;
}

export const parseCancelRequest = (body) => readable(body, ['requestId'], ({ requestId }) => isRequestId(requestId));

export const parseApplyRequest = (body) =>
  readable(body, ['requestId', 'baseVersion', 'frontConfirmed'], ({ requestId, baseVersion, frontConfirmed }) =>
    isRequestId(requestId) && isVersion(baseVersion) && typeof frontConfirmed === 'boolean');

export const parseUndoRequest = (body) =>
  readable(body, ['requestId', 'baseVersion', 'targetVersion'], ({ requestId, baseVersion, targetVersion }) =>
    isRequestId(requestId) && isVersion(baseVersion) && isVersion(targetVersion));

export function newProposal({ id, requestId, baseVersion, text, statementId, now }) {
  return {
    id,
    requestId,
    baseVersion,
    statement: { id: statementId, kind: 'human_memory', text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), modelConsent: true },
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    result: null,
    question: null,
    error: null,
    model: null,
    usage: null,
    responseId: null,
    appliedVersion: null,
  };
}

// Marks every unapplied proposal made for an older version as stale. A model
// call still in flight keeps running; its late result is recorded but stays stale.
export function staleProposals(proposals, version, now) {
  return proposals.map((item) => (OPEN_PROPOSAL.has(item.status) && item.baseVersion < version ? { ...item, status: 'stale', updatedAt: now } : item));
}

// Version 1 is the unedited build; every later version has a stored receipt.
export function editHistory(manifest) {
  const entries = manifest.edits.map(({ version, offset, yaw, kind = 'manual', proposalId, targetVersion }) => ({
    version,
    offset,
    yaw,
    kind,
    ...(proposalId !== undefined && { proposalId }),
    ...(targetVersion !== undefined && { targetVersion }),
  }));
  return [{ version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial' }, ...entries].sort((a, b) => a.version - b.version);
}

export function wrapYaw(yaw) {
  if (yaw >= -Math.PI && yaw <= Math.PI) return yaw;
  const turn = 2 * Math.PI;
  return ((((yaw + Math.PI) % turn) + turn) % turn) - Math.PI;
}

// Projects a normalized point of the stored-pixel image onto the depth grid
// exactly as photo-scene.surfaceMeshes places vertices, then returns the yaw
// that turns the object's visible front (local +z) toward it. Returns null for
// a point on the foreground or one at the object's current centre.
export function anchorYaw(surface, [u, v], offset) {
  const { width, height, depth, foreground, assumptions } = surface;
  const [imageWidth, imageHeight] = surface.source.image_size;
  const column = Math.round(u * (width - 1));
  const row = Math.round(v * (height - 1));
  const index = row * width + column;
  if (foreground[index] !== 0) return null;
  const tangent = Math.tan((assumptions.horizontal_fov_degrees * Math.PI) / 360);
  const d = depth[index];
  const gridU = column / (width - 1);
  const gridV = row / (height - 1);
  const anchor = [(gridU - 0.5) * 2 * tangent * d, ((0.5 - gridV) * 2 * tangent * d * imageHeight) / imageWidth, -d];
  const { pivot } = surfaceMeshes(surface).foreground;
  const dx = anchor[0] - (pivot[0] + offset[0]);
  const dz = anchor[2] - (pivot[2] + offset[2]);
  if (Math.hypot(dx, dz) < 1e-6) return null;
  return Math.atan2(dx, dz);
}

const plain = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const filled = (value, max) => plain(value, max) && value.trim() !== '';

// Checks a parsed model plan against the scene it was asked about and derives
// the absolute transform from the saved one. Returns { result } or
// { error, code }: error is the fixed browser message, code a fixed category
// for operator logs that never contains model, human or provider text.
export function validatePlan(plan, { sourceId, baseVersion, saved, surface }) {
  const reject = (code, error = PROPOSAL_MESSAGES.invalid) => ({ error, code });
  if (!exactKeys(plan, PLAN_KEYS)) return reject('plan_keys');
  if (!ACTIONS.includes(plan.action)) return reject('action');
  const { action, targetId, delta, yawDelta, anchor, question, reason } = plan;
  if (plan.sourceId !== sourceId) return reject('source_id');
  if (plan.baseVersion !== baseVersion) return reject('base_version');
  if (!plain(reason, 400)) return reject('reason');
  // The first field, in fixed order, that must be null for this action but is not.
  const extra = (fields) => fields.find((field) => plan[field] !== null);
  const result = (transform) => ({ result: { ...plan, delta: delta && [...delta], anchor: anchor && { label: anchor.label, point: [...anchor.point] }, transform } });

  if (action === 'clarify') {
    const field = extra(['targetId', 'delta', 'yawDelta', 'anchor']);
    if (field) return reject(`clarify_${field}_not_null`);
    if (!filled(question, 400)) return reject('clarify_question');
    return result(null);
  }
  if (targetId !== TARGET_ID) return reject(`${action}_target_id`);
  if (question !== null) return reject(`${action}_question_not_null`);
  if (action === 'translate') {
    const field = extra(['yawDelta', 'anchor']);
    if (field) return reject(`translate_${field}_not_null`);
    if (!Array.isArray(delta) || delta.length !== 3 || !delta.every(finite)) return reject('translate_delta');
    const offset = saved.offset.map((value, axis) => value + delta[axis]);
    if (offset.some((value) => Math.abs(value) > OFFSET_LIMIT)) return reject('translate_range', PROPOSAL_MESSAGES.range);
    return result({ offset, yaw: saved.yaw });
  }
  if (action === 'rotate') {
    const field = extra(['delta', 'anchor']);
    if (field) return reject(`rotate_${field}_not_null`);
    if (!finite(yawDelta)) return reject('rotate_yaw_delta');
    return result({ offset: [...saved.offset], yaw: wrapYaw(saved.yaw + yawDelta) });
  }
  const field = extra(['delta', 'yawDelta']);
  if (field) return reject(`face_anchor_${field}_not_null`);
  if (!exactKeys(anchor, ['label', 'point'])) return reject('face_anchor_anchor');
  if (!filled(anchor.label, 120)) return reject('face_anchor_label');
  const { point } = anchor;
  if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => finite(value) && value >= 0 && value <= 1)) return reject('face_anchor_point');
  const yaw = anchorYaw(surface, point, saved.offset);
  if (yaw === null) return reject('face_anchor_on_object', PROPOSAL_MESSAGES.anchor);
  return result({ offset: [...saved.offset], yaw });
}

// Runs the thumbnail helper with server-chosen arguments and
// the same environment allowlist as the reconstruction worker, so no secret
// reaches the child. Returns metadata-free JPEG bytes or throws.
export function pythonImagePreparer({ python, spatialDir, env }) {
  return ({ imagePath, box, signal }) =>
    new Promise((resolve, reject) => {
      const args = [path.join(spatialDir, 'prepare_model_image.py'), '--image', imagePath, '--box', ...box.map(String)];
      const child = spawn(python, args, { cwd: spatialDir, env: env(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: IMAGE_TIMEOUT_MS, killSignal: 'SIGKILL' });
      const chunks = [];
      let size = 0;
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > IMAGE_BYTES) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 2000) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => reject(new Error(`image helper: ${error.code ?? 'error'}`)));
      child.on('close', (code) => {
        const bytes = Buffer.concat(chunks);
        if (code === 0 && size <= IMAGE_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8) resolve(bytes);
        else reject(new Error(`image helper exit ${code}: ${stderr.split('\n')[0].slice(0, 300)}`));
      });
    });
}
