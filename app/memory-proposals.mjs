import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { RequestError } from './drafts.mjs';
import { validStatementSource } from './sources.mjs';
import { objectSurfaceMeshes, surfaceMeshes } from './public/photo-scene.js';
import { copyArrangement, copyPose, faceObjectPose, isComposition, poseProblem, rotatePoseYaw } from './public/composition-scene.js';

export const TARGET_ID = 'selected-foreground';
export const ACTIONS = Object.freeze(['translate', 'rotate', 'face_anchor', 'clarify']);
export const PLAN_KEYS = Object.freeze(['action', 'targetId', 'sourceId', 'baseVersion', 'delta', 'yawDelta', 'anchor', 'question', 'reason']);
export const COMPOSITION_ACTIONS = Object.freeze(['translate', 'rotate', 'face_object', 'clarify']);
export const COMPOSITION_PLAN_KEYS = Object.freeze(['action', 'targetId', 'sourceIds', 'baseVersion', 'delta', 'yawDelta', 'faceObjectId', 'question', 'reason']);
// A plan for a selected saved alternative echoes that alternative and its time
// revision in place of the main version.
export const VARIANT_PLAN_KEYS = Object.freeze(['action', 'targetId', 'sourceId', 'parentVariantId', 'baseEraRevision', 'delta', 'yawDelta', 'anchor', 'question', 'reason']);
export const COMPOSITION_VARIANT_PLAN_KEYS = Object.freeze(['action', 'targetId', 'sourceIds', 'parentVariantId', 'baseEraRevision', 'delta', 'yawDelta', 'faceObjectId', 'question', 'reason']);
export const TEXT_LIMIT = 2000;
const OFFSET_LIMIT = 2;
const FULL_TURN = 2 * Math.PI;
// For a saved alternative, a turn by an exact whole number of full turns is no
// turn at all: the saved pose is kept as it is, without the floating-point
// noise adding a full turn would leave. Plans for main are unaffected.
const noTurn = (alternative, yawDelta) => alternative !== null && yawDelta % FULL_TURN === 0;
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
  restricted: 'The owner turned off model processing or stopped using this photo, so no proposal is offered. A model request that was already sent may still count toward usage.',
  relationship: 'This change would break the relationship preserved for this arrangement. Nothing was changed. Keep that relationship or explicitly change it before trying again.',
  facing: 'The objects do not give a supported facing direction. Nothing was changed. Choose another position or direction.',
  unchanged: 'The proposed change would leave the selected arrangement as it is, so nothing is offered to save.',
  scene: 'The saved scene or its photos could not be verified, so no proposal is offered.',
  unrecorded: 'This app answers only from stored model responses, and none matches this exact memory, photo and saved version. Nothing was sent and nothing is offered to apply.',
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

export function parseProposalRequest(body, { targetIds = null } = {}) {
  const targeted = Array.isArray(targetIds);
  const keys = ['requestId', 'baseVersion', 'text', 'consent', ...(targeted ? ['targetId'] : [])];
  const request = readable(body, keys, ({ requestId, baseVersion, text, consent, targetId }) =>
    isRequestId(requestId) && isVersion(baseVersion) && typeof text === 'string' && text.trim() !== ''
    && Array.from(text).length <= TEXT_LIMIT && typeof consent === 'boolean'
    && (!targeted || targetIds.includes(targetId)));
  if (request.consent !== true) throw new RequestError(403, 'Sending the photo and message to the model needs explicit consent.');
  return request;
}

const TIME_MODES = ['unknown', 'reconfirm-parent'];

// A memory proposal for one object of a selected saved alternative. The time
// mode is the owner's own choice; the model never chooses a time.
export function parseVariantProposalRequest(body, targetIds) {
  const sourced = body !== null && typeof body === 'object' && Object.hasOwn(body, 'statementSource');
  const field = sourced ? 'statementSource' : 'text';
  const request = readable(body, ['requestId', 'baseEraRevision', 'targetId', 'timeMode', field, 'consent'],
    ({ requestId, baseEraRevision, targetId, timeMode, text, statementSource, consent }) =>
      isRequestId(requestId) && Number.isInteger(baseEraRevision) && baseEraRevision >= 0 && targetIds.includes(targetId)
      && TIME_MODES.includes(timeMode) && (sourced ? validStatementSource(statementSource)
        : typeof text === 'string' && text.trim() !== '' && Array.from(text).length <= TEXT_LIMIT)
      && typeof consent === 'boolean');
  if (request.consent !== true) throw new RequestError(403, 'Sending the photo and message to the model needs explicit consent.');
  return request;
}

export function parseVariantApplyRequest(body) {
  const request = readable(body, ['requestId', 'baseEraRevision', 'frontConfirmed', 'confirmed'], ({ requestId, baseEraRevision, frontConfirmed, confirmed }) =>
    isRequestId(requestId) && Number.isInteger(baseEraRevision) && baseEraRevision >= 0 && typeof frontConfirmed === 'boolean' && typeof confirmed === 'boolean');
  if (request.confirmed !== true) throw new RequestError(400, 'Confirm that you want to save this change as a new alternative.');
  return request;
}

export const parseCancelRequest = (body) => readable(body, ['requestId'], ({ requestId }) => isRequestId(requestId));

export const parseApplyRequest = (body) =>
  readable(body, ['requestId', 'baseVersion', 'frontConfirmed'], ({ requestId, baseVersion, frontConfirmed }) =>
    isRequestId(requestId) && isVersion(baseVersion) && typeof frontConfirmed === 'boolean');

export const parseUndoRequest = (body, { twoObjects = false } = {}) =>
  readable(body, ['requestId', 'baseVersion', 'targetVersion', ...(twoObjects ? ['ruleChangeConfirmed'] : [])], ({ requestId, baseVersion, targetVersion, ruleChangeConfirmed }) =>
    isRequestId(requestId) && isVersion(baseVersion) && isVersion(targetVersion)
    && (!twoObjects || typeof ruleChangeConfirmed === 'boolean'));

// A main proposal is bound to a main version; a scoped one only to its
// `scope` ({ kind: 'variant', parentVariantId, baseEraRevision, timeMode }).
export function newProposal({ id, requestId, baseVersion, text, statementId, now, targetId = null, scope = null, statementSource = null }) {
  return {
    id,
    requestId,
    ...(scope ? { scope: { ...scope } } : { baseVersion }),
    ...(targetId !== null && { targetId }),
    statement: { id: statementId, kind: 'human_memory', text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), modelConsent: true,
      ...(statementSource && { source: { ...statementSource } }) },
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    result: null,
    question: null,
    error: null,
    model: null,
    usage: null,
    responseId: null,
    ...(scope ? { appliedVariantId: null } : { appliedVersion: null }),
  };
}

// Marks every unapplied proposal made for an older version as stale. A model
// call still in flight keeps running; its late result is recorded but stays stale.
// Proposals scoped to a saved alternative never follow the main version.
export function staleProposals(proposals, version, now) {
  return proposals.map((item) => (!item.scope && OPEN_PROPOSAL.has(item.status) && item.baseVersion < version ? { ...item, status: 'stale', updatedAt: now } : item));
}

// A new time assertion on a saved alternative makes its open scoped proposals stale.
export function staleVariantProposals(proposals, parentVariantId, now) {
  return proposals.map((item) => (item.scope?.parentVariantId === parentVariantId && OPEN_PROPOSAL.has(item.status) ? { ...item, status: 'stale', updatedAt: now } : item));
}

// Version 1 is the unedited build; every later version has a stored receipt.
export function editHistory(manifest) {
  if (isComposition(manifest)) {
    const history = [manifest.initialArrangement, ...manifest.edits];
    if (history.some((edit) => edit?.frame !== 'owner-composition' || !Array.isArray(edit.objects)
      || edit.objects.length !== 2 || new Set(edit.objects.map((item) => item.id)).size !== 2
      || !edit.objects.every((item) => ['object-1', 'object-2'].includes(item.id) && !poseProblem(item)))) {
      throw new Error('The saved composition history could not be read.');
    }
    const entries = manifest.edits.map((entry) => ({
      ...copyArrangement(entry), kind: entry.kind ?? 'manual',
      ...Object.fromEntries(['proposalId', 'targetVersion', 'targetId'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])),
    }));
    return [{ ...copyArrangement(manifest.initialArrangement), version: 1, kind: 'initial' }, ...entries].sort((a, b) => a.version - b.version);
  }
  if (Array.isArray(manifest.objects)) {
    const entries = manifest.edits.map(({ version, objects, relationship, kind = 'manual', proposalId, targetVersion, targetId }) => ({
      version, objects: objects.map((item) => ({ ...item, offset: [...item.offset] })), relationship: relationship && { ...relationship }, kind,
      ...(proposalId !== undefined && { proposalId }),
      ...(targetVersion !== undefined && { targetVersion }),
      ...(targetId !== undefined && { targetId }),
    }));
    const initial = { version: 1, objects: manifest.objects.map(({ id }) => ({ id, offset: [0, 0, 0], yaw: 0 })), relationship: null, kind: 'initial' };
    return [initial, ...entries].sort((a, b) => a.version - b.version);
  }
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
export function anchorYaw(surface, [u, v], offset, targetId = TARGET_ID) {
  const { width, height, depth, foreground, assumptions } = surface;
  const [imageWidth, imageHeight] = surface.source.image_size;
  const column = Math.round(u * (width - 1));
  const row = Math.round(v * (height - 1));
  const index = row * width + column;
  let pivot;
  if (surface.schema_version === 2) {
    const selected = surface.objects.findIndex((item) => item.id === targetId);
    if (selected < 0 || surface.regions[index] !== 0) return null;
    pivot = objectSurfaceMeshes(surface).objects.find((item) => item.id === targetId)?.pivot;
    if (!pivot) return null;
  } else {
    if (foreground[index] !== 0 || targetId !== TARGET_ID) return null;
    ({ pivot } = surfaceMeshes(surface).foreground);
  }
  const tangent = Math.tan((assumptions.horizontal_fov_degrees * Math.PI) / 360);
  const d = depth[index];
  const gridU = column / (width - 1);
  const gridV = row / (height - 1);
  const anchor = [(gridU - 0.5) * 2 * tangent * d, ((0.5 - gridV) * 2 * tangent * d * imageHeight) / imageWidth, -d];
  const dx = anchor[0] - (pivot[0] + offset[0]);
  const dz = anchor[2] - (pivot[2] + offset[2]);
  if (Math.hypot(dx, dz) < 1e-6) return null;
  return Math.atan2(dx, dz);
}

const plain = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const filled = (value, max) => plain(value, max) && value.trim() !== '';

// The plan must echo exactly what it was asked about: the main version, or the
// selected alternative and its time revision. Returns a fixed code or null.
function bindingProblem(plan, baseVersion, alternative) {
  if (!alternative) return plan.baseVersion === baseVersion ? null : 'base_version';
  if (plan.parentVariantId !== alternative.parentVariantId) return 'parent_variant_id';
  return plan.baseEraRevision === alternative.baseEraRevision ? null : 'base_era_revision';
}

// Checks a parsed model plan against the scene it was asked about and derives
// the absolute transform from the saved one. Returns { result } or
// { error, code }: error is the fixed browser message, code a fixed category
// for operator logs that never contains model, human or provider text.
export function validatePlan(plan, context) {
  if (context.surface?.schema_version === 3) return validateCompositionPlan(plan, context);
  const { sourceId, baseVersion, saved, surface, targetId: expectedTargetId = TARGET_ID, alternative = null } = context;
  const reject = (code, error = PROPOSAL_MESSAGES.invalid) => ({ error, code });
  if (!exactKeys(plan, alternative ? VARIANT_PLAN_KEYS : PLAN_KEYS)) return reject('plan_keys');
  if (!ACTIONS.includes(plan.action)) return reject('action');
  const { action, targetId, delta, yawDelta, anchor, question, reason } = plan;
  if (plan.sourceId !== sourceId) return reject('source_id');
  const binding = bindingProblem(plan, baseVersion, alternative);
  if (binding) return reject(binding);
  if (!plain(reason, 400)) return reject('reason');
  if (surface?.schema_version === 2 && !surface.objects.some((item) => item.id === expectedTargetId)) return reject('context_target_id');
  // The first field, in fixed order, that must be null for this action but is not.
  const extra = (fields) => fields.find((field) => plan[field] !== null);
  const result = (transform) => ({ result: { ...plan, delta: delta && [...delta], anchor: anchor && { label: anchor.label, point: [...anchor.point] }, transform } });
  const clarifyObject = (question) => ({ result: { ...plan, action: 'clarify', targetId: null, delta: null, yawDelta: null, anchor: null, question, transform: null } });

  if (action === 'clarify') {
    const field = extra(['targetId', 'delta', 'yawDelta', 'anchor']);
    if (field) return reject(`clarify_${field}_not_null`);
    if (!filled(question, 400)) return reject('clarify_question');
    return result(null);
  }
  if (targetId !== expectedTargetId) return reject(`${action}_target_id`);
  if (question !== null) return reject(`${action}_question_not_null`);
  if (action === 'translate') {
    const field = extra(['yawDelta', 'anchor']);
    if (field) return reject(`translate_${field}_not_null`);
    if (!Array.isArray(delta) || delta.length !== 3 || !delta.every(finite)) return reject('translate_delta');
    if (context.fullObject && delta[1] !== 0) return clarifyObject('Vertical movement is unsupported. Describe a sideways move or an explicit relative turn.');
    const offset = saved.offset.map((value, axis) => value + delta[axis]);
    if (offset.some((value) => Math.abs(value) > OFFSET_LIMIT)) return reject('translate_range', PROPOSAL_MESSAGES.range);
    return result({ offset, yaw: saved.yaw });
  }
  if (action === 'rotate') {
    const field = extra(['delta', 'anchor']);
    if (field) return reject(`rotate_${field}_not_null`);
    if (!finite(yawDelta)) return reject('rotate_yaw_delta');
    if (noTurn(alternative, yawDelta)) return result({ offset: [...saved.offset], yaw: saved.yaw });
    return result({ offset: [...saved.offset], yaw: wrapYaw(saved.yaw + yawDelta) });
  }
  const field = extra(['delta', 'yawDelta']);
  if (field) return reject(`face_anchor_${field}_not_null`);
  if (!exactKeys(anchor, ['label', 'point'])) return reject('face_anchor_anchor');
  if (!filled(anchor.label, 120)) return reject('face_anchor_label');
  const { point } = anchor;
  if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => finite(value) && value >= 0 && value <= 1)) return reject('face_anchor_point');
  if (context.fullObject) return clarifyObject('The object’s historical front is unknown. Describe an explicit relative turn instead.');
  const yaw = anchorYaw(surface, point, saved.offset, expectedTargetId);
  if (yaw === null) return reject('face_anchor_on_object', PROPOSAL_MESSAGES.anchor);
  return result({ offset: [...saved.offset], yaw });
}

export function validateCompositionPlan(plan, { sourceIds, baseVersion, saved, surface, targetId, arrangement, alternative = null }) {
  const reject = (code, error = PROPOSAL_MESSAGES.invalid) => ({ error, code });
  if (!exactKeys(plan, alternative ? COMPOSITION_VARIANT_PLAN_KEYS : COMPOSITION_PLAN_KEYS)) return reject('composition_plan_keys');
  if (!COMPOSITION_ACTIONS.includes(plan.action)) return reject('composition_action');
  if (!Array.isArray(sourceIds) || sourceIds.length !== 2 || new Set(sourceIds).size !== 2 || !sourceIds.every(isRequestId)
    || !Array.isArray(plan.sourceIds) || plan.sourceIds.length !== 2 || !plan.sourceIds.every((id, index) => id === sourceIds[index])) return reject('composition_source_ids');
  const binding = bindingProblem(plan, baseVersion, alternative);
  if (binding) return reject(binding);
  if (!plain(plan.reason, 400)) return reject('reason');
  const ids = surface?.components?.map((item) => item.id);
  if (!Array.isArray(ids) || ids.length !== 2 || !['object-1', 'object-2'].every((id) => ids.includes(id)) || !ids.includes(targetId)
    || arrangement?.frame !== 'owner-composition' || !Array.isArray(arrangement.objects) || arrangement.objects.length !== 2
    || new Set(arrangement.objects.map((item) => item.id)).size !== 2
    || !arrangement.objects.every((item) => ids.includes(item.id) && !poseProblem(item)) || poseProblem(saved)) return reject('composition_context');
  const selected = arrangement.objects.find((item) => item.id === targetId);
  if (selected.scale !== saved.scale || !selected.position.every((n, i) => n === saved.position[i])
    || !selected.quaternion.every((n, i) => n === saved.quaternion[i])) return reject('composition_saved_pose');
  const extra = (fields) => fields.find((key) => plan[key] !== null);
  const result = (transform) => ({ result: { ...plan, sourceIds: [...plan.sourceIds], delta: plan.delta && [...plan.delta], transform } });
  if (plan.action === 'clarify') {
    const field = extra(['targetId', 'delta', 'yawDelta', 'faceObjectId']);
    if (field) return reject(`clarify_${field}_not_null`);
    if (!filled(plan.question, 400)) return reject('clarify_question');
    return result(null);
  }
  if (plan.targetId !== targetId) return reject(`${plan.action}_target_id`);
  if (plan.question !== null) return reject(`${plan.action}_question_not_null`);
  if (plan.action === 'translate') {
    const field = extra(['yawDelta', 'faceObjectId']);
    if (field) return reject(`translate_${field}_not_null`);
    if (!Array.isArray(plan.delta) || plan.delta.length !== 3 || !plan.delta.every(finite)) return reject('translate_delta');
    const transform = { ...copyPose(saved), position: saved.position.map((n, i) => n + plan.delta[i]) };
    if (poseProblem(transform)) return reject('translate_range', PROPOSAL_MESSAGES.range);
    return result(transform);
  }
  if (plan.action === 'rotate') {
    const field = extra(['delta', 'faceObjectId']);
    if (field) return reject(`rotate_${field}_not_null`);
    if (!finite(plan.yawDelta)) return reject('rotate_yaw_delta');
    if (noTurn(alternative, plan.yawDelta)) return result(copyPose(saved));
    return result(rotatePoseYaw(saved, plan.yawDelta));
  }
  const field = extra(['delta', 'yawDelta']);
  if (field) return reject(`face_object_${field}_not_null`);
  if (!ids.includes(plan.faceObjectId) || plan.faceObjectId === targetId) return reject('face_object_target');
  const other = arrangement.objects.find((item) => item.id === plan.faceObjectId);
  const transform = faceObjectPose(saved, other.position);
  return transform ? result(transform) : reject('face_object_direction', PROPOSAL_MESSAGES.facing);
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
