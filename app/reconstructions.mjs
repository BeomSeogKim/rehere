import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { attestPhotos, contributionsDir } from './contribution-photos.mjs';
import { cleanupContributionFiles, removeManifestTemps, safeJobDirectory } from './contribution-deletion-files.mjs';
import {
  assertSceneUsable, issueMessage, projectProposal, currentDependencies, dependenciesBlocked, dependencyIssue, modelBlocked, proposalBinding, sameArrangement,
  usageBlocked, variantFields, versionDependencies, proposalSourceDependencies, variantSourceDependencies,
} from './collaboration.mjs';
import { LIMITS, RequestError } from './drafts.mjs';
import {
  ACTIVE_PROPOSAL, PROPOSAL_MESSAGES, editHistory, newProposal, parseProposalRequest, parseUndoRequest, pythonImagePreparer, staleProposals, validatePlan,
} from './memory-proposals.mjs';
import {
  OBJECT_IDS, arrangementOf, assertObjectsConfirmed, assertRelationship, isTwoObject, objectMarker, objectPivots, withTarget,
} from './arrangements.mjs';
import { objectSurfaceMeshes } from './public/photo-scene.js';
import { checkRelationship } from './public/scene-relations.js';
import {
  MEMORY_LINKS_BYTES, MEMORY_LINKS_FILE, MEMORY_RECEIPTS_MAX, emptyMemoryEntry, memoryLinkView, memoryRequestDigest, parseMemoryLinkRequest,
  validMemoryLinks, writtenSourceView, sourceDependenciesOf, validStatementSource,
} from './memory-links.mjs';
import { SourcePolicies, allows } from './source-policies.mjs';
import { sha256 } from './sources.mjs';
import { geometrySources } from './geometry-sources.mjs';
import { COMPOSITION_OUTPUTS, parseCompositionPose, parseCompositionRequest, verifiedAsset } from './composition-assets.mjs';
import { COMPOSITION_REPRESENTATION, canonicalPose, copyPose, isComposition } from './public/composition-scene.js';
import { heldObjectMotion } from './full-objects.mjs';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RECONSTRUCTION_TIMEOUT_MS = 180_000;
const SPATIAL_DIR = fileURLToPath(new URL('./spatial/', import.meta.url));
const MIB = 1024 * 1024;
const STDERR_BYTES = 8192;
const OUTLINE_TIMEOUT_MS = 30_000;
const OUTLINE_MESSAGES = Object.freeze({
  input: 'The outline correction could not be read.',
  changed: 'This outline request was already used with different values.',
  surface: 'The saved scene files could not be verified. Nothing was changed.',
  regions: 'Change only the selected object. Keep the other object and unassigned areas unchanged.',
  rejected: 'The corrected outlines do not meet the scene coverage, overlap or visible-surface limits. No scene was saved.',
  setup: 'Outline correction needs the local Pillow environment described in app/spatial/README.md. No scene was saved.',
  stopped: 'Outline correction stopped before saving a scene. Retry the same request to check its result.',
  failed: 'The corrected scene could not be saved. Retry the same request to check its result.',
});

// The worker's fixed output set. Nothing else in a job folder is ever served.
export const OUTPUTS = Object.freeze({
  'surface.json': { type: 'application/json; charset=utf-8', maxBytes: 32 * MIB },
  'texture.jpg': { type: 'image/jpeg', maxBytes: 64 * MIB },
  'depth-preview.png': { type: 'image/png', maxBytes: 8 * MIB },
  'mask-overlay.jpg': { type: 'image/jpeg', maxBytes: 64 * MIB },
  'mask.png': { type: 'image/png', maxBytes: 32 * MIB },
  'summary.json': { type: 'application/json; charset=utf-8', maxBytes: MIB },
});

const MESSAGES = {
  setup: 'The local photo model is not set up on this computer. Follow the setup steps in app/spatial/README.md (Python environment and cached model weights), then try again.',
  timeout: `Building the scene took longer than ${RECONSTRUCTION_TIMEOUT_MS / 1000} seconds and was stopped. Try a smaller photo or try again later.`,
  input: 'The photo or selected box could not be used. Adjust the box or choose another photo.',
  rejected: 'The model could not separate a usable foreground and background from this selection. Try a different box or photo.',
  invalidOutput: 'The model output was incomplete or inconsistent, so no scene was published. Please try again.',
  interrupted: 'The app stopped before this build finished. Start a new build.',
  restricted: 'The owner turned off model processing or stopped using this photo, so no scene was published.',
  unknown: 'The scene could not be built. Please try again.',
};

const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HF_HOME', 'HF_HUB_CACHE'];
const defaultPython = () => process.env.PHOTO_PYTHON || path.join(SPATIAL_DIR, '.venv/bin/python');

// Tokens and other credentials in the server environment are not passed to
// Python children.
function workerEnv() {
  const env = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

export const pythonModelImage = ({ python = defaultPython() } = {}) => pythonImagePreparer({ python, spatialDir: SPATIAL_DIR, env: workerEnv });

// Spawns the offline worker with server-chosen arguments only.
export function pythonRunner({ python = defaultPython() } = {}) {
  return ({ imagePath, outputDir, sourceId, box, objects, signal }) =>
    new Promise((resolve) => {
      const env = workerEnv();
      // A two-object build sends both admitted labels and boxes, in object order.
      const selection = objects ? ['--objects', JSON.stringify(objects.map(({ label, box: objectBox }) => ({ label, box: objectBox })))] : ['--box', ...box.map(String)];
      const args = [path.join(SPATIAL_DIR, 'reconstruct.py'), '--image', imagePath, '--output', outputDir, '--source-id', sourceId, ...selection];
      const child = spawn(python, args, { cwd: SPATIAL_DIR, env, shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal, killSignal: 'SIGKILL' });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        if (stderr.length < STDERR_BYTES) stderr += chunk.toString('utf8');
      });
      // Settles only once the child has actually closed, so a settled runner
      // can no longer write its output. A process that never started settles
      // on its spawn error (Node also closes it right after).
      let spawnError = null;
      child.on('error', (error) => {
        spawnError ??= error.code ?? 'error';
        if (child.pid === undefined) resolve({ exitCode: null, stderr, spawnError });
      });
      child.on('close', (exitCode) => resolve(spawnError ? { exitCode: null, stderr, spawnError } : { exitCode, stderr }));
    });
}

// Only Pillow and the standard library are loaded by this separate producer.
export function pythonOutlineRunner({ python = defaultPython() } = {}) {
  return ({ inputDir, requestPath, outputDir, signal }) => new Promise((resolve) => {
    const child = spawn(python, [path.join(SPATIAL_DIR, 'correct_outline.py'), '--input', inputDir, '--request', requestPath, '--output', outputDir], {
      cwd: SPATIAL_DIR, env: workerEnv(), shell: false, stdio: 'ignore', signal, killSignal: 'SIGKILL',
    });
    let spawnError = null;
    child.on('error', (error) => { spawnError ??= error.code ?? 'error'; });
    child.on('close', (exitCode) => resolve({ exitCode, spawnError }));
  });
}

// Browser messages are fixed per exit category; worker stderr can hold local
// paths and stays in the server log only.
function failureMessage({ exitCode, spawnError }) {
  if (spawnError === 'ENOENT' || spawnError === 'EACCES' || exitCode === 3) return MESSAGES.setup;
  if (exitCode === 2) return MESSAGES.input;
  if (exitCode === 4) return MESSAGES.rejected;
  return MESSAGES.unknown;
}

function logFailure(jobId, { exitCode, stderr = '', spawnError }) {
  const line = stderr.split('\n').find((item) => item.startsWith('error: ')) ?? '';
  console.error(`reconstruction ${jobId} failed: ${spawnError ?? `exit ${exitCode}`}${line ? ` (${line.slice(0, 500)})` : ''}`);
}

// Width and height from the stored header, so a box can be checked before the
// heavy worker starts and worker output can be matched to the original.
export function imageSize(bytes) {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length >= 24 && view.readUInt32BE(0) === 0x89504e47 && view.toString('latin1', 12, 16) === 'IHDR') {
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  }
  if (view[0] !== 0xff || view[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < view.length) {
    if (view[offset] !== 0xff) return null;
    const marker = view[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: view.readUInt16BE(offset + 7), height: view.readUInt16BE(offset + 5) };
    if (marker === 0xd9 || marker === 0xda || length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function parseBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(finite)) throw new RequestError(400, 'The selected box could not be read.');
  const [x1, y1, x2, y2] = box;
  if (x1 < 0 || y1 < 0 || !(x2 > x1) || !(y2 > y1)) throw new RequestError(400, 'The selected box must have a size and start inside the photo.');
  return [x1, y1, x2, y2];
}

// Frozen limits for a two-object build, recomputed from the delivered grid
// rather than taken from the worker's summary: each object covers 1-50% of the
// grid, both together at most 60%, the background and each object keep at
// least 32 triangles, and a mask overlap is at most 1% of the smaller mask.
export const MIN_REGION_TRIANGLES = 32;
export const OBJECT_COVERAGE = Object.freeze({ min: 0.01, max: 0.5, combined: 0.6 });
export const MAX_OVERLAP_RATIO = 0.01;
const LABEL_LIMIT = 80;
const LABEL_CONTROL = /[\u0000-\u001f\u007f]/;

function parseObjects(objects) {
  if (!Array.isArray(objects) || objects.length !== OBJECT_IDS.length || !objects.every((item) => exactKeys(item, ['label', 'box']))) {
    throw new RequestError(400, 'The two objects could not be read.');
  }
  const parsed = objects.map(({ label, box }, index) => {
    const name = typeof label === 'string' ? label.trim() : '';
    if (!name || name.length > LABEL_LIMIT || LABEL_CONTROL.test(name)) throw new RequestError(400, 'Give each object a name of 1 to 80 characters.');
    return { id: OBJECT_IDS[index], label: name, box: parseBox(box) };
  });
  if (parsed[0].label.toLowerCase() === parsed[1].label.toLowerCase()) {
    throw new RequestError(400, 'Give the two objects different names so each can be told apart.');
  }
  return parsed;
}

export function parseBuildRequest(body) {
  if (body?.kind === 'two-photo-composition') return parseCompositionRequest(body);
  const twoObjects = exactKeys(body, ['requestId', 'sourceId', 'objects']);
  if (!twoObjects && !exactKeys(body, ['requestId', 'sourceId', 'box'])) throw new RequestError(400, 'The build request could not be read.');
  const { requestId, sourceId } = body;
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId) || typeof sourceId !== 'string' || !UUID_PATTERN.test(sourceId)) {
    throw new RequestError(400, 'The build request could not be read.');
  }
  return twoObjects ? { requestId, sourceId, objects: parseObjects(body.objects) } : { requestId, sourceId, box: parseBox(body.box) };
}

export function parseOutlineRequest(body) {
  if (!exactKeys(body, ['requestId', 'sourceSurfaceSha256', 'targetId', 'regions', 'confirmed'])
    || typeof body.requestId !== 'string' || !UUID_PATTERN.test(body.requestId)
    || typeof body.sourceSurfaceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sourceSurfaceSha256)
    || !OBJECT_IDS.includes(body.targetId) || body.confirmed !== true || !Array.isArray(body.regions)
    || body.regions.length > 262_144 || !body.regions.every((r) => Number.isInteger(r) && [-1, 0, 1, 2].includes(r))) {
    throw new RequestError(400, OUTLINE_MESSAGES.input);
  }
  return { requestId: body.requestId, sourceSurfaceSha256: body.sourceSurfaceSha256, targetId: body.targetId, regions: [...body.regions] };
}

function correctedObjects(surface, request) {
  const target = OBJECT_IDS.indexOf(request.targetId) + 1;
  if (surface.regions.length !== request.regions.length) throw new RequestError(400, OUTLINE_MESSAGES.input);
  let changed = false;
  let minX = surface.width, minY = surface.height, maxX = -1, maxY = -1;
  request.regions.forEach((after, i) => {
    const before = surface.regions[i];
    const valid = before === -1 ? after === -1 || after === target
      : before === 0 || before === target ? after === 0 || after === target : after === before;
    if (!valid) throw new RequestError(400, OUTLINE_MESSAGES.regions);
    if (before !== after) changed = true;
    if (after === target) {
      minX = Math.min(minX, i % surface.width); maxX = Math.max(maxX, i % surface.width);
      minY = Math.min(minY, Math.floor(i / surface.width)); maxY = Math.max(maxY, Math.floor(i / surface.width));
    }
  });
  if (!changed) throw new RequestError(400, 'Change the selected outline before saving a new scene.');
  if (maxX < 0) throw new RequestError(409, OUTLINE_MESSAGES.rejected);
  const [width, height] = surface.source.image_size;
  const extent = [
    Math.min(width - 1, Math.floor(minX * width / (surface.width - 1))),
    Math.min(height - 1, Math.floor(minY * height / (surface.height - 1))),
    Math.min(width, Math.ceil(maxX * width / (surface.width - 1)) + 1),
    Math.min(height, Math.ceil(maxY * height / (surface.height - 1)) + 1),
  ];
  return surface.objects.map(({ id, label, box_xyxy: box }) => ({ id, label, box_xyxy: id === request.targetId
    ? [Math.min(box[0], extent[0]), Math.min(box[1], extent[1]), Math.max(box[2], extent[2]), Math.max(box[3], extent[3])]
    : [...box] }));
}

const transformValid = (offset, yaw) => Array.isArray(offset) && offset.length === 3 && offset.every((value) => finite(value) && value >= -2 && value <= 2)
  && finite(yaw) && yaw >= -Math.PI && yaw <= Math.PI;

export function parseObjectEditRequest(body) {
  if (exactKeys(body, ['requestId', 'baseVersion', 'targetId', 'pose'])) {
    if (typeof body.requestId !== 'string' || !UUID_PATTERN.test(body.requestId) || !Number.isInteger(body.baseVersion) || body.baseVersion < 1 || !OBJECT_IDS.includes(body.targetId)) throw new RequestError(400, 'The edit could not be read.');
    return { requestId: body.requestId, baseVersion: body.baseVersion, targetId: body.targetId, pose: parseCompositionPose(body.pose) };
  }
  if (!exactKeys(body, ['requestId', 'baseVersion', 'targetId', 'offset', 'yaw'])) throw new RequestError(400, 'The edit could not be read.');
  const { requestId, baseVersion, targetId, offset, yaw } = body;
  const valid = typeof requestId === 'string' && UUID_PATTERN.test(requestId) && Number.isInteger(baseVersion) && baseVersion >= 1
    && OBJECT_IDS.includes(targetId) && transformValid(offset, yaw);
  if (!valid) throw new RequestError(400, 'The edit could not be read.');
  return { requestId, baseVersion, targetId, offset: [...offset], yaw };
}

function parseRule(rule, composition = false) {
  if (rule === null) return null;
  if (composition) {
    if (exactKeys(rule, ['kind', 'leftId', 'rightId', 'frame']) && rule.kind === 'left_of' && rule.frame === 'owner-composition'
      && OBJECT_IDS.includes(rule.leftId) && OBJECT_IDS.includes(rule.rightId) && rule.leftId !== rule.rightId) return { ...rule };
    if (exactKeys(rule, ['kind', 'subjectId', 'targetId', 'frame', 'frontBasis']) && rule.kind === 'faces' && rule.frame === 'owner-composition'
      && rule.frontBasis === 'owner-confirmed-photographed-side' && OBJECT_IDS.includes(rule.subjectId) && OBJECT_IDS.includes(rule.targetId) && rule.subjectId !== rule.targetId) return { ...rule };
    throw new RequestError(400, 'The relationship could not be read.');
  }
  const valid = exactKeys(rule, ['kind', 'leftId', 'rightId', 'frame']) && rule.kind === 'left_of' && rule.frame === 'original-photo'
    && OBJECT_IDS.includes(rule.leftId) && OBJECT_IDS.includes(rule.rightId) && rule.leftId !== rule.rightId;
  if (!valid) throw new RequestError(400, 'The relationship could not be read.');
  return { kind: 'left_of', leftId: rule.leftId, rightId: rule.rightId, frame: 'original-photo' };
}

export function parseRelationshipRequest(body, composition = false) {
  if (!exactKeys(body, ['requestId', 'baseVersion', 'relationship', 'confirmed'])) throw new RequestError(400, 'The relationship could not be read.');
  const { requestId, baseVersion, confirmed } = body;
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId) || !Number.isInteger(baseVersion) || baseVersion < 1) {
    throw new RequestError(400, 'The relationship could not be read.');
  }
  if (confirmed !== true) throw new RequestError(400, 'Confirm the relationship change before saving it.');
  return { requestId, baseVersion, relationship: parseRule(body.relationship, composition) };
}

function parseConfirmRequest(body, composition = false) {
  const keys = ['requestId', 'objectIds', ...(composition ? ['surfaceIdentityConfirmed', 'layoutConfirmed', 'scaleBasis'] : [])];
  const valid = exactKeys(body, keys) && (!composition || (body.surfaceIdentityConfirmed === true && body.layoutConfirmed === true && body.scaleBasis === 'owner-assumed-relative')) && typeof body.requestId === 'string' && UUID_PATTERN.test(body.requestId)
    && Array.isArray(body.objectIds) && body.objectIds.length === OBJECT_IDS.length && new Set(body.objectIds).size === OBJECT_IDS.length
    && body.objectIds.every((id) => OBJECT_IDS.includes(id));
  if (!valid) throw new RequestError(400, 'The confirmation could not be read.');
  return { requestId: body.requestId };
}



export function parseEditRequest(body) {
  if (!exactKeys(body, ['requestId', 'baseVersion', 'offset', 'yaw'])) throw new RequestError(400, 'The edit could not be read.');
  const { requestId, baseVersion, offset, yaw } = body;
  const valid = typeof requestId === 'string' && UUID_PATTERN.test(requestId)
    && Number.isInteger(baseVersion) && baseVersion >= 1
    && Array.isArray(offset) && offset.length === 3 && offset.every((value) => finite(value) && value >= -2 && value <= 2)
    && finite(yaw) && yaw >= -Math.PI && yaw <= Math.PI;
  if (!valid) throw new RequestError(400, 'The edit could not be read.');
  return { requestId, baseVersion, offset: [...offset], yaw };
}

function sameValues(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const SOURCE_BLOCKED_MESSAGE = 'The owner stopped using this photo or turned off its place use, so no version of this scene can be used.';
const WRITTEN_REDACTED_PROPOSAL = 'A written source used by this proposal is no longer available, so its content is no longer shown.';
const SOURCE_REDACTED_PROPOSAL = 'This proposal used a photo that is no longer available for place use, so its content is no longer shown.';

// Internal request, collaboration and share records stay on disk; clients see
// the manifest contract plus whether the photo's current uses or withdrawn or
// ungranted contributions block use. `source` is the photo's current uses.
export function publicManifest(manifest, source = { place: true, model: true }) {
  const { edits, proposals, collaboration, shares, stories, outlineCorrection, compositionCreation, ...rest } = manifest;
  const ready = manifest.status === 'ready';
  const sourceBlocked = ready && !source.place;
  const contributionBlocked = usageBlocked(manifest);
  return {
    ...rest,
    // Labels are the owner's text about the photo; without its place use only
    // fixed markers are shown. The stored labels are kept on disk.
    ...(isTwoObject(manifest) && {
      objects: manifest.objects.map(({ id, label, box, pivot, sourceId }) => ({
        id, label: source.place ? label : objectMarker(id), box: [...box], pivot: pivot ? [...pivot] : null,
        ...(isComposition(manifest) && { sourceId }),
      })),
      objectsConfirmed: Boolean(manifest.objectsConfirmed),
    }),
    usageBlocked: sourceBlocked || contributionBlocked,
    modelBlocked: sourceBlocked || (ready && !source.model) || modelBlocked(manifest),
    blockedReason: sourceBlocked ? 'source' : contributionBlocked ? 'contribution' : null,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// Reads at most `limit + 1` bytes through one file handle, so a file that
// grew after any check is never read in full. Throws on a missing or
// unreadable file.
async function readUpTo(file, limit, flags = 'r') {
  const handle = await open(file, flags);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close().catch(() => {});
  }
}

// A recorded photo size the bounded read may trust: within the photo limit.
const recordedPhotoSize = (source) => Number.isInteger(source?.size) && source.size > 0 && source.size <= LIMITS.photoBytes;

// The stored original of a photo source, read up to its recorded size plus
// one byte; null unless it is exactly that size. Checksums are the caller's.
async function boundedOriginal(file, source) {
  if (!file || !recordedPhotoSize(source)) return null;
  const bytes = await readUpTo(file, source.size).catch(() => null);
  return bytes && bytes.length === source.size ? bytes : null;
}

// Owner region links: private, mutable owner judgments that a box in another
// photo of the same memory shows one confirmed object of a scene. They are
// kept in region-links.json beside the manifest and never change the
// manifest, the originals, a version or anything shared or sent to a model.
const REGION_LINKS_FILE = 'region-links.json';
const REGION_LINKS_BYTES = 256 * 1024;
const REGION_RECEIPTS_MAX = 200;
const REGION_LINKS_MAX = LIMITS.photoCount - 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REGION_NOT_READY = 'Link photo regions after both objects are confirmed.';
const REGION_UNAVAILABLE = 'Photo region links are unavailable right now. Nothing was changed.';
const REGION_UNREADABLE = 'The photo region link could not be read.';
const CHECKSUM_MESSAGE = 'The saved photo no longer matches its recorded checksum, so it cannot be used.';
const MEMORY_UNAVAILABLE = 'Written memory links are unavailable right now. Nothing was changed.';
const regionBoxValid = (box, [width, height]) => Array.isArray(box) && box.length === 4 && box.every(finite)
  && box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= width && box[3] <= height;
const positiveInt = (value) => Number.isInteger(value) && value > 0;

function validRegionLinks(state) {
  if (state?.schemaVersion !== 1 || !exactKeys(state, ['schemaVersion', 'objects'])) return false;
  const { objects } = state;
  if (objects === null || typeof objects !== 'object' || Array.isArray(objects)) return false;
  return Object.entries(objects).every(([id, entry]) => OBJECT_IDS.includes(id) && exactKeys(entry, ['revision', 'updatedAt', 'links', 'receipts'])
    && Number.isInteger(entry.revision) && entry.revision >= 0 && (entry.updatedAt === null || typeof entry.updatedAt === 'string')
    && Array.isArray(entry.links) && entry.links.length <= REGION_LINKS_MAX
    && new Set(entry.links.map((link) => link?.sourceId)).size === entry.links.length
    && entry.links.every((link) => exactKeys(link, ['sourceId', 'sourceSha256', 'imageSize', 'box', 'linkedAt'])
      && typeof link.sourceId === 'string' && UUID_PATTERN.test(link.sourceId) && typeof link.sourceSha256 === 'string' && SHA256_HEX.test(link.sourceSha256)
      && Array.isArray(link.imageSize) && link.imageSize.length === 2 && link.imageSize.every(positiveInt)
      && regionBoxValid(link.box, link.imageSize) && typeof link.linkedAt === 'string')
    && Array.isArray(entry.receipts) && entry.receipts.length <= REGION_RECEIPTS_MAX
    && entry.receipts.every((receipt) => exactKeys(receipt, ['requestId', 'digest', 'revision']) && typeof receipt.requestId === 'string'
      && UUID_PATTERN.test(receipt.requestId) && typeof receipt.digest === 'string' && SHA256_HEX.test(receipt.digest)
      && Number.isInteger(receipt.revision) && receipt.revision >= 0));
}

function parseRegionLinkRequest(body) {
  if (!exactKeys(body, ['requestId', 'baseRevision', 'action', 'sourceId', 'box', 'confirmed'])) throw new RequestError(400, REGION_UNREADABLE);
  const { requestId, baseRevision, action, sourceId, box, confirmed } = body;
  const valid = typeof requestId === 'string' && UUID_PATTERN.test(requestId) && Number.isInteger(baseRevision) && baseRevision >= 0
    && (action === 'set' || action === 'remove') && typeof sourceId === 'string' && UUID_PATTERN.test(sourceId)
    && (action === 'set' ? Array.isArray(box) : box === null);
  if (!valid) throw new RequestError(400, REGION_UNREADABLE);
  if (confirmed !== true) throw new RequestError(400, 'Confirm that the regions show the same object before saving.');
  return { requestId, baseRevision, action, sourceId, box: action === 'set' ? parseBox(box) : null };
}

const emptyRegionEntry = () => ({ revision: 0, updatedAt: null, links: [], receipts: [] });

// A replayed receipt returns its saved geometry only while that version's own
// dependencies may still be used; an unrelated later blockage does not matter.
function assertReplayUsable(manifest, version) {
  const issue = dependencyIssue(manifest, versionDependencies(manifest, version));
  if (issue) throw new RequestError(409, issueMessage(issue));
}

// Removes contributor photo folders that no manifest record refers to: staging
// left by an interrupted submission, or a folder renamed before its manifest
// write failed. Referenced folders are never touched.
async function sweepContributionPhotos(jobDir, manifest) {
  // Deleted contributions are never swept here: their bounded deletion
  // cleanup owns their folders, even after completion.
  const referenced = new Set((manifest.collaboration?.contributions ?? []).filter((item) => item?.photo || item?.voice || item?.status === 'deleted').map((item) => item.id));
  // Only a real directory is swept; a symlinked contributions folder is never followed.
  try {
    if (!(await lstat(contributionsDir(jobDir))).isDirectory()) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let names;
  try {
    names = await readdir(contributionsDir(jobDir));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (name.startsWith('.staging-') || (UUID_PATTERN.test(name) && !referenced.has(name))) {
      await rm(path.join(contributionsDir(jobDir), name), { recursive: true, force: true });
    }
  }
}

async function listDirs(dir) {
  try {
    return (await readdir(dir)).filter((name) => UUID_PATTERN.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Mirrors the scene builder: each grid cell yields triangles (a, c, b) and
// (b, c, d), kept only when all corners share a region and their depth span is
// within the limit. Ready requires at least one triangle in each region.
function hasRenderableRegions(width, height, depth, foreground, span) {
  if (!finite(span) || !(span > 0)) return false;
  const found = [false, false];
  const keep = (points) => {
    const region = foreground[points[0]];
    if (found[region] || !points.every((index) => foreground[index] === region)) return;
    const values = points.map((index) => depth[index]);
    if (Math.max(...values) - Math.min(...values) <= span) found[region] = true;
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = y * width + x;
      keep([a, a + width, a + 1]);
      keep([a + 1, a + width, a + width + 1]);
      if (found[0] && found[1]) return true;
    }
  }
  return false;
}

function checkSurface(surface, summary, expected) {
  const { width, height, depth, foreground, source, assumptions } = surface ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > 262_144) return false;
  if (source?.source_id !== expected.sourceId || source?.sha256 !== expected.sourceSha256) return false;
  if (!sameValues(source.image_size, [expected.width, expected.height])) return false;
  if (!sameValues(source.selected_object?.box_xyxy, expected.box)) return false;
  if (source.texture?.file !== 'texture.jpg' || source.texture?.sha256 !== expected.textureSha256) return false;
  const fov = assumptions?.horizontal_fov_degrees;
  if (!finite(fov) || !(fov > 0 && fov < 180)) return false;
  const near = assumptions?.near;
  const far = assumptions?.far;
  if (!finite(near) || !finite(far) || !(near > 0) || !(far > near)) return false;
  const cells = width * height;
  if (!Array.isArray(depth) || depth.length !== cells || !depth.every((value) => finite(value) && value >= near - 1e-5 && value <= far + 1e-5)) return false;
  if (!Array.isArray(foreground) || foreground.length !== cells || !foreground.every((value) => value === 0 || value === 1)) return false;
  if (!hasRenderableRegions(width, height, depth, foreground, assumptions.max_triangle_depth_span)) return false;
  return summary?.source_id === expected.sourceId && summary?.source_sha256 === expected.sourceSha256 && summary?.texture_sha256 === expected.textureSha256;
}

// A two-object surface must match the admitted request exactly and leave
// enough triangles for the background and each object. Returns the pivots the
// renderer will use, computed once by the same pure mesh code.
function checkObjectSurface(surface, summary, expected) {
  const { width, height, depth, regions, source, assumptions, objects } = surface ?? {};
  if (surface?.schema_version !== 2) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > 262_144) return null;
  if (source?.source_id !== expected.sourceId || source?.sha256 !== expected.sourceSha256) return null;
  if (!sameValues(source.image_size, [expected.width, expected.height])) return null;
  const requested = expected.objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box }));
  if (!sameValues(source.selected_objects, requested) || !sameValues(objects, requested)) return null;
  if (source.texture?.file !== 'texture.jpg' || source.texture?.sha256 !== expected.textureSha256) return null;
  const fov = assumptions?.horizontal_fov_degrees;
  const { near, far, max_triangle_depth_span: span } = assumptions ?? {};
  if (!finite(fov) || !(fov > 0 && fov < 180) || !finite(near) || !finite(far) || !(near > 0) || !(far > near) || !finite(span) || !(span > 0)) return null;
  const cells = width * height;
  if (!Array.isArray(depth) || depth.length !== cells || !depth.every((value) => finite(value) && value >= near - 1e-5 && value <= far + 1e-5)) return null;
  if (!Array.isArray(regions) || regions.length !== cells || !regions.every((value) => value === -1 || value === 0 || value === 1 || value === 2)) return null;
  if (summary?.source_id !== expected.sourceId || summary?.source_sha256 !== expected.sourceSha256 || summary?.texture_sha256 !== expected.textureSha256) return null;
  const coverage = [1, 2].map((region) => regions.filter((value) => value === region).length / cells);
  if (!coverage.every((value) => value >= OBJECT_COVERAGE.min && value <= OBJECT_COVERAGE.max)) return null;
  if (coverage[0] + coverage[1] > OBJECT_COVERAGE.combined) return null;
  // Void cells exist exactly when the masks overlapped, and the overlap is small.
  const overlap = summary.overlap;
  if (!exactKeys(overlap, ['pixels', 'ratio']) || !Number.isInteger(overlap.pixels) || overlap.pixels < 0) return null;
  if (!finite(overlap.ratio) || overlap.ratio < 0 || overlap.ratio > MAX_OVERLAP_RATIO || (overlap.pixels === 0) !== (overlap.ratio === 0)) return null;
  if (regions.includes(-1) !== overlap.pixels > 0) return null;
  let meshes;
  try {
    meshes = objectSurfaceMeshes(surface);
  } catch {
    return null;
  }
  const enough = (part) => part.indices.length / 3 >= MIN_REGION_TRIANGLES;
  if (!enough(meshes.background) || meshes.objects.length !== OBJECT_IDS.length || !meshes.objects.every(enough)) return null;
  const pivots = meshes.objects.map(({ id, pivot }) => ({ id, pivot: [...pivot] }));
  if (!pivots.every(({ id, pivot }, index) => id === OBJECT_IDS[index] && Array.isArray(pivot) && pivot.length === 3 && pivot.every(finite))) return null;
  return pivots;
}

// Arguments the model adapter receives for a two-object scene: the selected
// target, both objects with their labels, boxes and saved transforms, and the rule.
function modelContext(manifest, targetId, arrangement = manifest.edit) {
  return {
    targetId,
    objects: manifest.objects.map(({ id, label, box }) => {
      const saved = arrangement.objects.find((item) => item.id === id);
      return { id, label, box: [...box], offset: [...saved.offset], yaw: saved.yaw };
    }),
    relationship: arrangement.relationship ? { ...arrangement.relationship } : null,
  };
}

// Shown when the saved surface bytes no longer match the scene's record, so
// the photographed surfaces cannot be checked against a new arrangement.
const VISIBLE_SURFACE_UNVERIFIED = 'The photographed surfaces of this scene could not be verified. Nothing was changed.';

// Loaded on first use: single-object scenes never need Three.js on the server.
let visibleGate = null;
const loadVisibleGate = () => {
  if (!visibleGate) {
    visibleGate = Promise.all([import('./public/visible-surfaces.js'), import('three'), import('three-mesh-bvh')])
      .then(([helper, THREE, { MeshBVH }]) => ({ ...helper, THREE, MeshBVH }));
    visibleGate.catch(() => { visibleGate = null; });
  }
  return visibleGate;
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (bytes, signature) => signature.every((value, index) => bytes[index] === value);

export class ReconstructionStore {
  constructor({
    dataDir, drafts, runner, timeoutMs = RECONSTRUCTION_TIMEOUT_MS, proposalModel = null, prepareImage = pythonModelImage(), visibleSurfaceLimits,
    placeDeletions = null, outlineRunner = pythonOutlineRunner(), outlineTimeoutMs = OUTLINE_TIMEOUT_MS,
  }) {
    this.drafts = drafts;
    // Place-deletion barriers; a deleted place reads as absent everywhere.
    this.placeDeletions = placeDeletions;
    // Every build runner until it has actually settled, by job:
    // { draftId, settled }. It can outlive the build that started it.
    this.runners = new Map();
    this.runner = runner;
    this.outlineRunner = outlineRunner;
    this.outlineTimeoutMs = outlineTimeoutMs;
    this.activeOutline = null;
    this.activeComposition = null;
    this.timeoutMs = timeoutMs;
    this.proposalModel = proposalModel;
    this.prepareImage = prepareImage;
    // Only fault and budget tests pass limits; the shared gate's defaults apply otherwise.
    this.visibleSurfaceLimits = visibleSurfaceLimits;
    // The one last prepared surface: { key, prepared }. Its bytes are still
    // read and hashed on every check.
    this.visibleCache = null;
    // The one policy instance every route and the share store read through.
    this.sourcePolicies = new SourcePolicies({ dataDir, drafts });
    this.activeProposal = null;
    // The one story decode in progress, set and cleared by the story store:
    // { draftId, sourceIds, controller, done }.
    this.activeStory = null;
    // The one contributed bundle whose photo or recording is being prepared,
    // set and cleared by the collaboration store: { controller, done }.
    this.activeContributionMedia = null;
    this.rootDir = path.join(dataDir, 'reconstructions');
    this.stagingDir = path.join(dataDir, 'reconstruction-staging');
    this.queue = Promise.resolve();
    this.active = null;
    this.recovered = null;
    this.closed = false;
  }

  // Mutations run one at a time in this process; there is no cross-process lock.
  serialize(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  jobDir(draftId, jobId) {
    return path.join(this.rootDir, draftId, jobId);
  }

  async recover() {
    this.recovered ??= this.serialize(async () => {
      // Barriers are checked before any content recovery: a deleted place is
      // never reopened, swept or rewritten here; its own cleanup handles it.
      let deletedJobs = null;
      try {
        deletedJobs = new Set((this.placeDeletions ? await this.placeDeletions.records() : []).flatMap((record) => record.jobIds));
      } catch {
        deletedJobs = null;
      }
      for (const draftId of await listDirs(this.rootDir)) {
        if (await this.placeDeleted(draftId)) continue;
        for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
          // Nothing in a job is read or changed unless every folder from the
          // data root down to it is a real directory; an unsafe job is skipped
          // and the others are still recovered.
          if (!(await safeJobDirectory(this.jobDir(draftId, jobId), this.rootDir).catch(() => false))) continue;
          const file = path.join(this.jobDir(draftId, jobId), 'manifest.json');
          // Story playback files are staged per job; anything left there was never published.
          await rm(path.join(this.jobDir(draftId, jobId), 'story-staging'), { recursive: true, force: true });
          const manifest = await readJson(file).catch(() => null);
          if (!manifest) continue;
          await sweepContributionPhotos(this.jobDir(draftId, jobId), manifest);
          const now = new Date().toISOString();
          const unfinished = (manifest.proposals ?? []).some((item) => ACTIVE_PROPOSAL.has(item.status));
          const changes = {};
          if (manifest.status === 'queued' || manifest.status === 'processing') Object.assign(changes, { status: 'interrupted', error: MESSAGES.interrupted });
          // Saved geometry is untouched; any usage of a sent request stays in the budget ledger.
          if (unfinished) {
            changes.proposals = manifest.proposals.map((item) =>
              ACTIVE_PROPOSAL.has(item.status) ? { ...item, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted, updatedAt: now } : item);
          }
          let current = manifest;
          if (Object.keys(changes).length > 0) {
            current = { ...manifest, ...changes, updatedAt: now };
            await writeJsonAtomic(file, current);
          }
          // Deletions whose access stopped resume their cleanup; a failure
          // leaves them pending without affecting anything else.
          await this.completeDeletions(current).catch(() => {});
        }
      }
      // Staging of deleted places is left to their own exact cleanup; with an
      // unreadable deletion record nothing is swept at all.
      if (deletedJobs?.size === 0) await rm(this.stagingDir, { recursive: true, force: true });
      else if (deletedJobs) {
        for (const name of await listDirs(this.stagingDir)) {
          if (!deletedJobs.has(name)) await rm(path.join(this.stagingDir, name), { recursive: true, force: true });
        }
      }
    });
    return this.recovered;
  }

  // The one read path for scene manifests. It also attests contributor photo
  // bundles, which every sync dependency check then requires.
  async readManifest(draftId, jobId) {
    if (!UUID_PATTERN.test(draftId) || !UUID_PATTERN.test(jobId)) return null;
    if (await this.placeDeleted(draftId)) return null;
    const manifest = await readJson(path.join(this.jobDir(draftId, jobId), 'manifest.json'));
    return manifest && attestPhotos(manifest, draftId, jobId, this.jobDir(draftId, jobId));
  }

  // Current uses of a scene's photo under the owner's restrictions.
  async sourceUses(draftId, sourceId) {
    const draft = await this.drafts.get(draftId);
    const source = await this.sourcePolicies.effectiveSource(draft, sourceId);
    const policy = source ? { permissions: source.permissions, stopped: source.policy.stopped } : null;
    const use = (purpose) => Boolean(policy) && allows(policy, purpose);
    return { place: use('place'), model: use('model'), share: use('share') };
  }

  async writtenSourceContext(draftId) {
    const draft = await this.drafts.get(draftId);
    const source = draft?.textSourceId && await this.sourcePolicies.effectiveSource(draft, draft.textSourceId);
    const policy = source && { permissions: source.permissions, stopped: source.policy.stopped };
    const written = writtenSourceView(draft, Boolean(policy) && allows(policy, 'place'));
    if (!written) return undefined;
    const available = written.view.available;
    return {
      ...written.view, sourceSha256: available ? written.sha256 : null,
      attribution: available ? { creator: source.attributedCreator || null, originKind: source.origin.kind, reference: source.origin.reference }
        : { creator: null, originKind: 'unknown', reference: '' },
      modelAllowed: available && allows(policy, 'model'),
    };
  }

  async sourceDependencyIssue(manifest, holder, purpose = 'place') {
    const variant = manifest.collaboration?.variants?.find((item) => item.id === holder.id);
    const refs = variant ? variantSourceDependencies(manifest, variant) : sourceDependenciesOf(holder);
    if (refs === null) return 'unavailable';
    if (refs.length === 0) return null;
    const written = await this.writtenSourceContext(manifest.draftId);
    for (const ref of refs) {
      if (!written?.available || written.sourceId !== ref.sourceId || written.sourceSha256 !== ref.sourceSha256) return 'unavailable';
      if (!(await this.sourcePolicies.canUse(await this.drafts.get(manifest.draftId), ref.sourceId, purpose))) return purpose === 'model' ? 'model' : 'unavailable';
    }
    return null;
  }

  async assertSourceDependencies(manifest, holder, purpose = 'place') {
    const issue = await this.sourceDependencyIssue(manifest, holder, purpose);
    if (issue) throw new RequestError(issue === 'model' ? 403 : 409, issue === 'model'
      ? 'Model use is off for this written source.' : 'A written source used by this arrangement is unavailable.');
  }

  async resolveStatementSource(manifest, ref, purpose = 'model') {
    if (!validStatementSource(ref)) throw new RequestError(400, 'The written source reference could not be read.');
    const written = await this.writtenSourceContext(manifest.draftId);
    if (!written?.available || written.sourceId !== ref.sourceId || written.sourceSha256 !== ref.sourceSha256) throw new RequestError(409, 'The written source changed or could not be verified.');
    await this.assertSourceDependencies(manifest, { sourceDependencies: [{ kind: 'written-source', ...ref }] }, purpose);
    return written;
  }

  async sceneSourceUses(manifest) {
    const bindings = geometrySources(manifest);
    const uses = await Promise.all(bindings.map(({ sourceId }) => this.sourceUses(manifest.draftId, sourceId)));
    return Object.fromEntries(['place', 'model', 'share'].map((purpose) => [purpose, uses.length > 0 && uses.every((entry) => entry[purpose])]));
  }

  async assertSceneSources(manifest, purpose = 'place') {
    const photos = [];
    for (const binding of geometrySources(manifest)) {
      if (!isComposition(manifest)) {
        photos.push(await this.permittedPhoto(manifest.draftId, binding.sourceId, purpose));
        continue;
      }
      const photo = await this.verifiedOriginal(manifest.draftId, binding.sourceId, purpose);
      if (photo.source.sha256 !== binding.sourceSha256) throw new RequestError(409, CHECKSUM_MESSAGE);
      photos.push(photo);
    }
    return photos;
  }

  // Callers hold the mutex. Every original photo of the scene, with current
  // place use, and every derived file must still match its recorded checksum.
  async assertSceneFiles(manifest) {
    for (const binding of geometrySources(manifest)) {
      const original = await this.verifiedOriginal(manifest.draftId, binding.sourceId, 'place');
      if (original.source.sha256 !== binding.sourceSha256) throw new RequestError(409, CHECKSUM_MESSAGE);
    }
    if (isComposition(manifest)) {
      await this.compositionAssets(manifest);
      return;
    }
    const assets = path.join(this.jobDir(manifest.draftId, manifest.id), 'assets');
    if (!(await safeJobDirectory(assets, this.rootDir)) || manifest.derivedAssets?.length !== Object.keys(OUTPUTS).length) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
    for (const name of Object.keys(OUTPUTS)) await verifiedAsset(path.join(assets, name), manifest.derivedAssets.find((entry) => entry.name === name), OUTPUTS[name]);
  }

  async compositionAssets(manifest) {
    const folder = path.join(this.jobDir(manifest.draftId, manifest.id), 'assets');
    if (!(await safeJobDirectory(folder, this.rootDir)) || manifest.derivedAssets?.length !== 3) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
    const files = {};
    for (const [name, spec] of Object.entries(COMPOSITION_OUTPUTS)) {
      const entry = manifest.derivedAssets.find((item) => item.name === name);
      if (entry?.type !== spec.type || entry.role !== 'derived') throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
      files[name] = await verifiedAsset(path.join(folder, name), entry, spec);
    }
    return files;
  }

  async #compositionParent(draftId, reference) {
    const manifest = await this.editableScene(draftId, reference.jobId);
    if (manifest.status !== 'ready' || isComposition(manifest)) throw new RequestError(409, 'Select an object from a finished single-photo scene.');
    if (manifest.edit?.fullObject) throw new RequestError(409, 'Composing a full-object version is not available yet.');
    if (isTwoObject(manifest)) assertObjectsConfirmed(manifest);
    assertSceneUsable(manifest, 'place');
    const original = await this.verifiedOriginal(draftId, manifest.sourceId, 'place');
    if (original.source.sha256 !== manifest.sourceSha256) throw new RequestError(409, CHECKSUM_MESSAGE);
    const assets = path.join(this.jobDir(draftId, reference.jobId), 'assets');
    if (!(await safeJobDirectory(assets, this.rootDir))) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
    const files = {};
    for (const name of Object.keys(OUTPUTS)) files[name] = await verifiedAsset(path.join(assets, name), manifest.derivedAssets.find((entry) => entry.name === name), OUTPUTS[name]);
    if (sha256(files['surface.json']) !== reference.surfaceSha256) throw new RequestError(409, 'The selected surface changed. Reopen it before composing.');
    const surface = JSON.parse(files['surface.json'].toString('utf8'));
    const verified = await this.verifyOutputs(assets, manifest, original.size);
    if (!verified || (isTwoObject(manifest) && !sameValues(verified.pivots, objectPivots(manifest)))) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
    const selected = objectSurfaceMeshes(surface).objects.find((item) => item.id === reference.objectId);
    if (!selected) throw new RequestError(400, 'This source object could not be found.');
    const box = isTwoObject(manifest) ? manifest.objects.find((item) => item.id === reference.objectId)?.box : manifest.box;
    return { manifest, surface, texture: files['texture.jpg'], selected, box, original };
  }

  async createComposition(draftId, body) {
    const request = parseCompositionRequest(body);
    if (!UUID_PATTERN.test(draftId)) throw new RequestError(404, 'This memory could not be found.');
    await this.recover();
    const digest = sha256(JSON.stringify([draftId, request]));
    const admitted = await this.serialize(async () => {
      const existing = await this.findRequest(request.requestId);
      if (existing) {
        if (existing.compositionCreation?.requestDigest !== digest) throw new RequestError(409, 'This request was already used with different values.');
        await this.assertSceneSources(existing);
        return { status: 200, manifest: existing };
      }
      if (this.activeComposition) {
        if (this.activeComposition.requestId !== request.requestId) throw new RequestError(409, 'Another composition is being saved.');
        if (this.activeComposition.digest !== digest) throw new RequestError(409, 'This request was already used with different values.');
        return { status: 200, operation: this.activeComposition };
      }
      if (this.activeOutline?.requestId === request.requestId) throw new RequestError(409, 'This request was already used with different values.');
      const parents = [];
      for (const object of request.objects) parents.push(await this.#compositionParent(draftId, object.component));
      if (parents[0].manifest.sourceId === parents[1].manifest.sourceId) throw new RequestError(400, 'Select objects from two different photos of this place.');
      if (this.closed) throw new RequestError(503, 'The app is shutting down.');
      const operation = { id: randomUUID(), draftId, requestId: request.requestId, digest, sourceIds: parents.map((parent) => parent.manifest.sourceId), controller: new AbortController(), done: null };
      this.activeComposition = operation;
      operation.done = this.#runComposition(operation, request, parents);
      return { status: 201, operation };
    });
    const saved = admitted.manifest ?? await admitted.operation.done;
    const current = await this.editableScene(draftId, saved.id);
    await this.assertSceneSources(current);
    return { status: admitted.status, manifest: publicManifest(current, await this.sceneSourceUses(current)) };
  }

  async #runComposition(operation, request, parents) {
    const { id, draftId } = operation;
    const staging = path.join(this.stagingDir, id), child = path.join(staging, 'child');
    const assets = path.join(child, 'assets');
    const stopped = async () => {
      if (this.closed || operation.controller.signal.aborted) throw new RequestError(503, 'The composition stopped before saving. Retry the same request to check its result.');
      if (await this.placeDeleted(draftId)) throw new RequestError(404, 'This place could not be found.');
    };
    try {
      const components = request.objects.map((object, index) => ({ id: OBJECT_IDS[index], label: object.label, selectedObjectId: object.component.objectId, texture: `texture-${index + 1}.jpg`, surface: parents[index].surface }));
      const surface = { schema_version: 3, representation: COMPOSITION_REPRESENTATION, components, context: request.context.keep
        ? { kind: 'photographed-background', componentId: 'object-1', bounds: request.context.bounds, pose: copyPose(request.objects[0].pose) } : null };
      // The shared builder validates the actual selected meshes and context crop.
      try { objectSurfaceMeshes(surface); } catch {
        throw new RequestError(400, 'The selected context must contain an observed background surface inside the first photo.');
      }
      const initialArrangement = { version: 1, frame: 'owner-composition', objects: request.objects.map((object, index) => ({ id: OBJECT_IDS[index], ...copyPose(object.pose) })), relationship: null };
      const now = new Date().toISOString();
      const files = { 'surface.json': Buffer.from(JSON.stringify(surface)), 'texture-1.jpg': parents[0].texture, 'texture-2.jpg': parents[1].texture };
      const sourceBindings = parents.map((parent, index) => ({ sourceId: parent.manifest.sourceId, sourceSha256: parent.manifest.sourceSha256, objectIds: [OBJECT_IDS[index]] }));
      const manifest = { id, draftId, representation: COMPOSITION_REPRESENTATION, scaleBasis: 'owner-assumed-relative', sourceBindings, requestId: request.requestId,
        compositionCreation: { requestDigest: operation.digest }, status: 'ready', createdAt: now, updatedAt: now, error: null,
        objects: request.objects.map((object, index) => ({ id: OBJECT_IDS[index], label: object.label, sourceId: sourceBindings[index].sourceId, box: [...parents[index].box], pivot: [0, 0, 0],
          component: { parentJobId: object.component.jobId, parentObjectId: object.component.objectId, parentSurfaceSha256: object.component.surfaceSha256, sourcePivot: [...parents[index].selected.pivot] } })),
        objectsConfirmed: false, initialArrangement, edit: structuredClone(initialArrangement), edits: [],
        derivedAssets: Object.entries(files).map(([name, bytes]) => ({ name, type: COMPOSITION_OUTPUTS[name].type, size: bytes.length, sha256: sha256(bytes), role: 'derived', parentSourceIds: sourceBindings.filter((_, index) => name === 'surface.json' || name === `texture-${index + 1}.jpg`).map(({ sourceId }) => sourceId) })),
      };
      await stopped();
      await mkdir(assets, { recursive: true, mode: 0o700 });
      for (const [name, bytes] of Object.entries(files)) {
        if (bytes.length > COMPOSITION_OUTPUTS[name].maxBytes) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
        await writeFile(path.join(assets, name), bytes, { mode: 0o600, flag: 'wx' });
      }
      // The creation itself is a new arrangement and must pass the real mesh gate.
      const { THREE, MeshBVH, prepareVisibleGeometry, checkVisibleArrangement, visibleSurfaceProblem } = await loadVisibleGate();
      const problem = visibleSurfaceProblem(checkVisibleArrangement(prepareVisibleGeometry(THREE, MeshBVH, surface), initialArrangement, this.visibleSurfaceLimits));
      if (problem) throw new RequestError(409, problem);
      await writeJsonAtomic(path.join(child, 'manifest.json'), manifest);
      return await this.serialize(async () => {
        const publish = async () => {
          await stopped();
          for (const object of request.objects) await this.#compositionParent(draftId, object.component);
          await this.assertSceneSources(manifest);
          for (const entry of manifest.derivedAssets) await verifiedAsset(path.join(assets, entry.name), entry, COMPOSITION_OUTPUTS[entry.name]);
          await mkdir(path.join(this.rootDir, draftId), { recursive: true });
          await stopped();
          await rename(child, this.jobDir(draftId, id));
          return manifest;
        };
        return this.placeDeletions ? this.placeDeletions.commit(publish) : publish();
      });
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(503, 'The composition could not be saved. Retry the same request to check its result.');
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (this.activeComposition === operation) this.activeComposition = null;
    }
  }

  async get(draftId, jobId) {
    await this.recover();
    const manifest = await this.readManifest(draftId, jobId);
    if (manifest?.edit?.fullObject) return this.fullObjects.withCommit(async () => {
      const current = await this.readManifest(draftId, jobId);
      if (!current) return null;
      if (current.edit?.fullObject) await this.fullObjects.validateBinding(draftId, jobId, current.edit.fullObject);
      return publicManifest(current, await this.sceneSourceUses(current));
    });
    return manifest && publicManifest(manifest, await this.sceneSourceUses(manifest));
  }

  async list(draftId) {
    await this.recover();
    if (!UUID_PATTERN.test(draftId) || (await this.placeDeleted(draftId))) return [];
    const manifests = [];
    for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
      const manifest = await this.readManifest(draftId, jobId).catch(() => null);
      if (manifest) manifests.push(publicManifest(manifest, await this.sceneSourceUses(manifest)));
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async draftIds() {
    await this.recover();
    const ids = [];
    for (const draftId of await listDirs(this.rootDir)) if (!(await this.placeDeleted(draftId))) ids.push(draftId);
    return ids;
  }

  // Fails closed: an unreadable barrier also means deleted.
  async placeDeleted(draftId) {
    return Boolean(this.placeDeletions) && (await this.placeDeletions.deleted(draftId));
  }

  // Requests cancellation of this place's running work. Only called once its
  // deletion barrier is durable; nothing is awaited and no data is recalled.
  abortPlace(draftId) {
    for (const item of [this.active, this.activeProposal, this.activeStory, this.activeContributionMedia, this.activeOutline, this.activeComposition, this.fullObjects?.active]) {
      if (item?.draftId !== draftId) continue;
      try {
        item.controller.abort();
      } catch {
        // Best effort: the deletion stays pending until the work has settled.
      }
    }
  }

  // A build and its runner count once; proposals, stories, contributions and
  // outline corrections each remain active until their own cleanup settles.
  placeOperations(draftId) {
    const builds = new Set();
    if (this.active?.draftId === draftId) builds.add(this.active.id);
    for (const [jobId, runner] of this.runners) if (runner.draftId === draftId) builds.add(jobId);
    return builds.size + [this.activeProposal, this.activeStory, this.activeContributionMedia, this.activeOutline, this.activeComposition, this.fullObjects?.active].filter((item) => item?.draftId === draftId).length;
  }

  async asset(draftId, jobId, name) {
    await this.recover();
    const raw = await this.readManifest(draftId, jobId);
    const manifest = raw && publicManifest(raw, await this.sceneSourceUses(raw));
    if (manifest?.status !== 'ready' || !Object.hasOwn(isComposition(raw) ? COMPOSITION_OUTPUTS : OUTPUTS, name)) return null;
    // Derived pixels and surfaces reproduce the blocked transform's scene.
    if (manifest.usageBlocked) {
      throw new RequestError(409, manifest.blockedReason === 'source' ? SOURCE_BLOCKED_MESSAGE : issueMessage(dependencyIssue(raw, currentDependencies(raw))));
    }
    const entry = manifest.derivedAssets.find((item) => item.name === name);
    if (!entry) return null;
    if (isComposition(raw)) {
      await this.assertSceneSources(raw);
      await this.compositionAssets(raw);
      const assets = path.join(this.jobDir(draftId, jobId), 'assets');
      if (!(await safeJobDirectory(assets, this.rootDir))) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
      return { ...entry, body: await verifiedAsset(path.join(assets, name), entry, COMPOSITION_OUTPUTS[name]) };
    }
    if (name === 'texture.jpg') {
      const original = await this.verifiedOriginal(draftId, raw.sourceId, 'place');
      if (original.source.sha256 !== raw.sourceSha256) throw new RequestError(409, CHECKSUM_MESSAGE);
      const assets = path.join(this.jobDir(draftId, jobId), 'assets');
      if (!(await safeJobDirectory(assets, this.rootDir))) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
      await verifiedAsset(path.join(assets, 'surface.json'), raw.derivedAssets.find((item) => item.name === 'surface.json'), OUTPUTS['surface.json']);
      return { ...entry, body: await verifiedAsset(path.join(assets, name), entry, OUTPUTS[name]) };
    }
    return { ...entry, file: path.join(this.jobDir(draftId, jobId), 'assets', name) };
  }

  async findRequest(requestId) {
    for (const draftId of await listDirs(this.rootDir)) {
      for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
        const manifest = await this.readManifest(draftId, jobId).catch(() => null);
        if (manifest?.requestId === requestId) return manifest;
      }
    }
    return null;
  }

  // `purpose` is 'place' for viewing and manual editing, 'model' for local or
  // hosted model processing. Grants are the owner's current restrictions.
  async permittedPhoto(draftId, sourceId, purpose = 'place') {
    const draft = await this.drafts.get(draftId);
    if (!draft) throw new RequestError(404, 'This memory could not be found.');
    if (!Array.isArray(draft.sources)) {
      throw new RequestError(403, 'This memory was saved before source details existed, so no permission to build a scene was recorded.');
    }
    const source = draft.sources.find((item) => item.id === sourceId);
    if (!source) throw new RequestError(404, 'This photo could not be found in the memory.');
    if (source.kind !== 'photo') throw new RequestError(400, 'Only a photo can be used to build a scene.');
    if (!(await this.sourcePolicies.canUse(draft, sourceId, purpose))) {
      throw new RequestError(403, purpose === 'model'
        ? 'This photo does not currently have permission for both place building and model processing.'
        : 'This photo does not currently have permission for place building.');
    }
    return { draft, source };
  }

  // A permitted photo whose stored bytes still match the recorded checksum,
  // with its size in stored pixel order (EXIF orientation is not applied).
  async verifiedOriginal(draftId, sourceId, purpose = 'model') {
    const { source } = await this.permittedPhoto(draftId, sourceId, purpose);
    const asset = await this.drafts.asset(draftId, source.name);
    // Read through one handle up to the recorded size plus one byte.
    const bytes = await boundedOriginal(asset?.file, source);
    if (!bytes || sha256(bytes) !== source.sha256) throw new RequestError(409, CHECKSUM_MESSAGE);
    const size = imageSize(bytes);
    if (!size || size.width < 1 || size.height < 1) throw new RequestError(400, 'The size of this photo could not be read.');
    return { source, imagePath: asset.file, size };
  }

  async imageSize(draftId, sourceId) {
    if (!UUID_PATTERN.test(draftId)) throw new RequestError(404, 'This memory could not be found.');
    if (!UUID_PATTERN.test(sourceId)) throw new RequestError(404, 'This photo could not be found in the memory.');
    const { size } = await this.verifiedOriginal(draftId, sourceId);
    return { width: size.width, height: size.height };
  }

  async create(draftId, request) {
    if (request.kind === 'two-photo-composition') return this.createComposition(draftId, request);
    await this.recover();
    if (!UUID_PATTERN.test(draftId)) throw new RequestError(404, 'This memory could not be found.');
    const accepted = await this.serialize(async () => {
      const existing = await this.findRequest(request.requestId);
      if (existing) {
        const sameSelection = request.objects
          ? sameValues(existing.objects?.map(({ id, label, box }) => ({ id, label, box })), request.objects)
          : !existing.objects && sameValues(existing.box, request.box);
        if (existing.outlineCorrection || existing.draftId !== draftId || existing.sourceId !== request.sourceId || !sameSelection) {
          throw new RequestError(409, 'This build request was already used for a different photo or box.');
        }
        return { manifest: existing, start: false };
      }
      if (this.activeOutline?.requestId === request.requestId) throw new RequestError(409, OUTLINE_MESSAGES.changed);
      if (this.activeComposition?.requestId === request.requestId) throw new RequestError(409, 'This request is already being used for a composition.');
      const { source, imagePath, size } = await this.verifiedOriginal(draftId, request.sourceId);
      for (const [, , x2, y2] of request.objects ? request.objects.map((item) => item.box) : [request.box]) {
        if (x2 > size.width || y2 > size.height) {
          throw new RequestError(400, `The selected box must stay inside the photo (${size.width} x ${size.height} pixels).`);
        }
      }
      if (this.closed) throw new RequestError(503, 'The app is shutting down. Try again later.');
      if (this.active || this.runners.size || this.fullObjects?.active) throw new RequestError(409, 'Another scene is being built right now. Try again when it finishes.');

      const now = new Date().toISOString();
      const manifest = {
        id: randomUUID(),
        draftId,
        sourceId: request.sourceId,
        sourceSha256: source.sha256,
        ...(request.objects
          ? { objects: request.objects.map((item) => ({ ...item, box: [...item.box], pivot: null })), objectsConfirmed: null }
          : { box: request.box }),
        requestId: request.requestId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        error: null,
        derivedAssets: [],
        edit: request.objects
          ? { version: 1, objects: OBJECT_IDS.map((id) => ({ id, offset: [0, 0, 0], yaw: 0 })), relationship: null }
          : { version: 1, offset: [0, 0, 0], yaw: 0 },
        edits: [],
      };
      await mkdir(this.jobDir(draftId, manifest.id), { recursive: true });
      await writeJsonAtomic(path.join(this.jobDir(draftId, manifest.id), 'manifest.json'), manifest);
      this.active = { id: manifest.id, draftId, sourceId: request.sourceId, controller: new AbortController(), done: null };
      return { manifest, start: true, imagePath, size };
    });
    if (accepted.start) {
      this.active.done = this.run(accepted.manifest, accepted.imagePath, accepted.size);
    }
    return publicManifest(accepted.manifest, await this.sceneSourceUses(accepted.manifest));
  }

  // Callers hold the mutex, so no manifest write is in progress. Removes the
  // files of every deletion whose access stopped and leftover temporary
  // manifests, then records completion for those whose absence is verified.
  async completeDeletions(manifest) {
    const jobDir = this.jobDir(manifest.draftId, manifest.id);
    const collaboration = manifest.collaboration;
    const pending = (collaboration?.contributions ?? []).filter((item) => item?.status === 'deleted' && item.deletion?.state === 'access-stopped');
    if (pending.length === 0) return manifest;
    const cleaned = [];
    // The data root is passed so every path component down to the job folder
    // is checked; a symlinked draft or job folder is never followed.
    for (const item of pending) if (await cleanupContributionFiles(jobDir, item.id, this.rootDir)) cleaned.push(item.id);
    // Leftover temporary manifests can hold old text, so they are removed on
    // every attempt, even while some media cleanup is still pending.
    const tempsRemoved = await removeManifestTemps(jobDir, this.rootDir);
    if (cleaned.length === 0 || !tempsRemoved) return manifest;
    const completedAt = new Date().toISOString();
    return this.update(manifest, {
      collaboration: {
        ...collaboration,
        contributions: collaboration.contributions.map((item) => (cleaned.includes(item.id) ? { ...item, deletion: { ...item.deletion, state: 'complete', completedAt } } : item)),
      },
    });
  }

  async update(manifest, changes) {
    if (await this.placeDeleted(manifest.draftId)) throw new RequestError(404, 'This scene could not be found.');
    const next = { ...manifest, ...changes, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(this.jobDir(manifest.draftId, manifest.id), 'manifest.json'), next);
    return next;
  }

  async run(queued, imagePath, size) {
    const { controller } = this.active;
    const staging = path.join(this.stagingDir, queued.id);
    const outputDir = path.join(staging, 'output');
    let manifest = queued;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const permitted = () => this.sceneSourceUses(manifest).then((uses) => uses.model);
      // The grant is checked again when work starts and inside the publish slot.
      const started = await this.serialize(async () => {
        if (!(await permitted())) {
          manifest = await this.update(manifest, { status: 'failed', error: MESSAGES.restricted });
          return false;
        }
        manifest = await this.update(manifest, { status: 'processing' });
        return true;
      });
      if (!started) return;
      await mkdir(staging, { recursive: true });
      const stopped = async () => {
        if (!timedOut && !(await permitted())) return this.update(manifest, { status: 'failed', error: MESSAGES.restricted });
        const error = timedOut ? MESSAGES.timeout : MESSAGES.interrupted;
        return this.update(manifest, { status: timedOut ? 'failed' : 'interrupted', error });
      };
      // A runner that ignores the signal is not awaited; its late result is discarded.
      const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
      // The worker starts inside a mutex slot right after a last grant check, so
      // a restriction saved while staging was prepared is honoured even when
      // its abort failed. The run itself is awaited outside the slot.
      const launch = await this.serialize(async () => {
        if (controller.signal.aborted) return null;
        if (!(await permitted())) {
          manifest = await this.update(manifest, { status: 'failed', error: MESSAGES.restricted });
          return null;
        }
        let started;
        try {
          const selection = isTwoObject(manifest) ? { objects: manifest.objects.map(({ id, label, box }) => ({ id, label, box })) } : { box: manifest.box };
          started = Promise.resolve(this.runner({ imagePath, outputDir, sourceId: manifest.sourceId, ...selection, signal: controller.signal }));
        } catch (error) {
          started = Promise.reject(error);
        }
        // Tracked until the runner itself settles, not the abort race below.
        const settled = started.then(() => {}, () => {});
        this.runners.set(manifest.id, { draftId: manifest.draftId, settled });
        settled.then(() => {
          if (this.runners.get(manifest.id)?.settled === settled) this.runners.delete(manifest.id);
        });
        return { running: started.catch((error) => ({ exitCode: null, stderr: '', spawnError: error?.code })) };
      });
      if (!launch && !controller.signal.aborted) return;
      const result = controller.signal.aborted ? null : await Promise.race([launch.running, aborted]);
      if (controller.signal.aborted) {
        manifest = await this.serialize(stopped);
        return;
      }
      if (result?.exitCode !== 0) {
        logFailure(manifest.id, result ?? {});
        manifest = await this.serialize(() => this.update(manifest, { status: 'failed', error: failureMessage(result ?? {}) }));
        return;
      }
      const verified = await this.verifyOutputs(outputDir, manifest, size);
      const derivedAssets = verified?.derivedAssets;
      if (!derivedAssets) {
        manifest = await this.serialize(() => (controller.signal.aborted ? stopped() : this.update(manifest, { status: 'failed', error: MESSAGES.invalidOutput })));
        return;
      }
      manifest = await this.serialize(async () => {
        if (controller.signal.aborted) return stopped();
        // A deleted place publishes nothing; its staging is removed by the deletion.
        if (await this.placeDeleted(manifest.draftId)) return manifest;
        if (!(await permitted())) return this.update(manifest, { status: 'failed', error: MESSAGES.restricted });
        const assetsDir = path.join(this.jobDir(manifest.draftId, manifest.id), 'assets');
        await rename(outputDir, assetsDir);
        // Commit boundary: an abort seen here unpublishes the outputs. Once the
        // ready manifest write starts, nothing else rewrites this job's status.
        if (controller.signal.aborted) {
          await rm(assetsDir, { recursive: true, force: true });
          return stopped();
        }
        // The pivots are computed once from the verified surface and never change.
        const objects = verified.pivots && manifest.objects.map((item) => ({ ...item, pivot: verified.pivots.find((entry) => entry.id === item.id).pivot }));
        return this.update(manifest, { status: 'ready', derivedAssets, ...(objects && { objects }) });
      });
    } catch (error) {
      console.error('reconstruction failed:', error?.code ?? error?.name ?? 'error');
      await this.serialize(() => this.update(manifest, { status: 'failed', error: MESSAGES.unknown })).catch(() => {});
    } finally {
      clearTimeout(timer);
      // A deleted place's staging (its runner may still be writing) is left
      // to the deletion's exact cleanup once the runner has settled.
      if (!(await this.placeDeleted(manifest.draftId))) await rm(staging, { recursive: true, force: true }).catch(() => {});
      this.active = null;
    }
  }

  async verifyOutputs(outputDir, manifest, size) {
    let names;
    try {
      names = (await readdir(outputDir)).sort();
    } catch {
      return null;
    }
    if (!sameValues(names, Object.keys(OUTPUTS).sort())) return null;
    const files = {};
    for (const name of names) {
      const info = await lstat(path.join(outputDir, name));
      if (!info.isFile() || info.size === 0 || info.size > OUTPUTS[name].maxBytes) return null;
      files[name] = await readFile(path.join(outputDir, name));
    }
    if (!startsWith(files['texture.jpg'], JPEG) || !startsWith(files['mask-overlay.jpg'], JPEG)) return null;
    if (!startsWith(files['mask.png'], PNG) || !startsWith(files['depth-preview.png'], PNG)) return null;
    const maskSize = imageSize(files['mask.png']);
    const textureSize = imageSize(files['texture.jpg']);
    if (!sameValues(maskSize, size) || !sameValues(textureSize, size)) return null;
    let surface;
    let summary;
    try {
      surface = JSON.parse(files['surface.json'].toString('utf8'));
      summary = JSON.parse(files['summary.json'].toString('utf8'));
    } catch {
      return null;
    }
    const expected = { ...size, sourceId: manifest.sourceId, sourceSha256: manifest.sourceSha256, box: manifest.box, objects: manifest.objects, textureSha256: sha256(files['texture.jpg']) };
    let pivots = null;
    if (isTwoObject(manifest)) {
      pivots = checkObjectSurface(surface, summary, expected);
      if (!pivots) return null;
    } else if (!checkSurface(surface, summary, expected)) {
      return null;
    }
    const derivedAssets = Object.keys(OUTPUTS).map((name) => ({
      name,
      type: OUTPUTS[name].type,
      size: files[name].length,
      sha256: sha256(files[name]),
      parentSourceId: manifest.sourceId,
      role: 'derived',
    }));
    return { derivedAssets, pivots };
  }

  async #outlineParent(draftId, jobId, surfaceSha256) {
    const manifest = await this.editableScene(draftId, jobId);
    if (manifest.status !== 'ready' || !isTwoObject(manifest) || isComposition(manifest)) throw new RequestError(409, 'Only a finished single-photo two-object scene can have its outline corrected.');
    assertSceneUsable(manifest, 'place');
    const { source, size } = await this.verifiedOriginal(draftId, manifest.sourceId, 'place');
    if (source.sha256 !== manifest.sourceSha256) throw new RequestError(409, CHECKSUM_MESSAGE);
    const assets = path.join(this.jobDir(draftId, jobId), 'assets');
    if (!(await safeJobDirectory(assets, this.rootDir))) throw new RequestError(409, OUTLINE_MESSAGES.surface);
    if (manifest.derivedAssets?.length !== Object.keys(OUTPUTS).length) throw new RequestError(409, OUTLINE_MESSAGES.surface);
    const files = {};
    for (const name of Object.keys(OUTPUTS)) {
      const entry = manifest.derivedAssets.find((item) => item.name === name);
      if (!entry || !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > OUTPUTS[name].maxBytes) throw new RequestError(409, OUTLINE_MESSAGES.surface);
      const file = path.join(assets, name);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.size !== entry.size) throw new RequestError(409, OUTLINE_MESSAGES.surface);
      const bytes = await readUpTo(file, entry.size, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new RequestError(409, OUTLINE_MESSAGES.surface);
      files[name] = bytes;
    }
    if (sha256(files['surface.json']) !== surfaceSha256) throw new RequestError(409, 'The scene outline changed. Reopen it before correcting it.');
    const verified = await this.verifyOutputs(assets, manifest, size);
    if (!verified || !sameValues(verified.pivots, objectPivots(manifest))) throw new RequestError(409, OUTLINE_MESSAGES.surface);
    return { manifest, size, files, surface: JSON.parse(files['surface.json'].toString('utf8')) };
  }

  async correctOutline(draftId, parentJobId, body) {
    const request = parseOutlineRequest(body);
    if (!UUID_PATTERN.test(draftId) || !UUID_PATTERN.test(parentJobId)) throw new RequestError(404, 'This scene could not be found.');
    await this.recover();
    const digest = sha256(JSON.stringify([draftId, parentJobId, request.sourceSurfaceSha256, request.targetId, request.regions]));
    const accepted = await this.serialize(async () => {
      const existing = await this.findRequest(request.requestId);
      if (existing) {
        if (existing.outlineCorrection?.requestDigest !== digest) throw new RequestError(409, OUTLINE_MESSAGES.changed);
        return { status: 200, manifest: existing };
      }
      if (this.activeComposition?.requestId === request.requestId) throw new RequestError(409, OUTLINE_MESSAGES.changed);
      if (this.activeOutline) {
        if (this.activeOutline.requestId === request.requestId) {
          if (this.activeOutline.digest !== digest) throw new RequestError(409, OUTLINE_MESSAGES.changed);
          return { status: 200, operation: this.activeOutline };
        }
        throw new RequestError(409, 'Another outline correction is being saved. Try again when it finishes.');
      }
      const parent = await this.#outlineParent(draftId, parentJobId, request.sourceSurfaceSha256);
      const objects = correctedObjects(parent.surface, request);
      if (this.closed) throw new RequestError(503, OUTLINE_MESSAGES.stopped);
      const operation = {
        id: randomUUID(), draftId, sourceId: parent.manifest.sourceId, requestId: request.requestId, digest,
        controller: new AbortController(), done: null,
      };
      this.activeOutline = operation;
      operation.done = this.#runOutline(operation, parentJobId, request, parent, objects);
      return { status: 201, operation };
    });
    const manifest = accepted.manifest ?? await accepted.operation.done;
    // A concurrent exact replay may have waited while the child was edited.
    const current = await this.readManifest(draftId, manifest.id);
    if (!current) throw new RequestError(404, 'This scene could not be found.');
    return { status: accepted.status, manifest: publicManifest(current, await this.sceneSourceUses(current)) };
  }

  async #runOutline(operation, parentJobId, request, parent, objects) {
    const { id, draftId, controller } = operation;
    const staging = path.join(this.stagingDir, id);
    const inputDir = path.join(staging, 'input');
    const childDir = path.join(staging, 'child');
    const outputDir = path.join(childDir, 'assets');
    const requestPath = path.join(staging, 'request.json');
    const stopped = () => {
      if (controller.signal.aborted || this.closed) throw new RequestError(503, OUTLINE_MESSAGES.stopped);
    };
    const timer = setTimeout(() => controller.abort(), this.outlineTimeoutMs);
    try {
      await mkdir(inputDir, { recursive: true });
      await mkdir(childDir);
      for (const [name, bytes] of Object.entries(parent.files)) await writeFile(path.join(inputDir, name), bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(requestPath, JSON.stringify({ regions: request.regions, targetId: request.targetId, objects }), { flag: 'wx', mode: 0o600 });
      const launch = await this.serialize(async () => {
        stopped();
        await this.permittedPhoto(draftId, parent.manifest.sourceId, 'place');
        if (await this.placeDeleted(draftId)) throw new RequestError(404, 'This scene could not be found.');
        stopped();
        return { running: Promise.resolve(this.outlineRunner({ inputDir, requestPath, outputDir, signal: controller.signal })) };
      });
      const result = await launch.running;
      stopped();
      if (result?.spawnError === 'ENOENT' || result?.spawnError === 'EACCES' || result?.exitCode === 3) throw new RequestError(503, OUTLINE_MESSAGES.setup);
      if (result?.exitCode === 4) throw new RequestError(409, OUTLINE_MESSAGES.rejected);
      if (result?.exitCode !== 0) throw new RequestError(503, OUTLINE_MESSAGES.failed);
      const now = new Date().toISOString();
      const manifest = {
        id, draftId, sourceId: parent.manifest.sourceId, sourceSha256: parent.manifest.sourceSha256,
        requestId: request.requestId, status: 'ready', createdAt: now, updatedAt: now, error: null,
        outline: { kind: 'owner-corrected' },
        outlineCorrection: { parentJobId, sourceSurfaceSha256: request.sourceSurfaceSha256, targetId: request.targetId, requestDigest: operation.digest },
        objects: objects.map(({ id: objectId, label, box_xyxy: box }) => ({ id: objectId, label, box: [...box], pivot: null })),
        objectsConfirmed: null, edit: { version: 1, objects: OBJECT_IDS.map((objectId) => ({ id: objectId, offset: [0, 0, 0], yaw: 0 })), relationship: null },
        edits: [], derivedAssets: [],
      };
      const verified = await this.verifyOutputs(outputDir, manifest, parent.size);
      if (!verified) throw new RequestError(409, OUTLINE_MESSAGES.rejected);
      const actual = JSON.parse(await readFile(path.join(outputDir, 'surface.json'), 'utf8'));
      const expected = {
        schema_version: 2, source: { ...parent.surface.source, selected_objects: objects }, objects,
        width: parent.surface.width, height: parent.surface.height, depth: parent.surface.depth,
        regions: request.regions, assumptions: parent.surface.assumptions, outline: { kind: 'owner-corrected' },
      };
      if (!isDeepStrictEqual(actual, expected) || ['texture.jpg', 'depth-preview.png'].some((name) =>
        verified.derivedAssets.find((entry) => entry.name === name).sha256 !== sha256(parent.files[name]))) throw new RequestError(409, OUTLINE_MESSAGES.surface);
      manifest.derivedAssets = verified.derivedAssets;
      manifest.objects = manifest.objects.map((object) => ({ ...object, pivot: verified.pivots.find((entry) => entry.id === object.id).pivot }));
      await writeJsonAtomic(path.join(childDir, 'manifest.json'), manifest);
      const publish = async () => {
        stopped();
        // Recheck original, all parent hashes and current grants inside publication authority.
        await this.#outlineParent(draftId, parentJobId, request.sourceSurfaceSha256);
        await mkdir(path.join(this.rootDir, draftId), { recursive: true });
        stopped();
        // Atomic commit: readers see either no child, or its complete ready directory.
        await rename(childDir, this.jobDir(draftId, id));
        return manifest;
      };
      return await this.serialize(() => this.placeDeletions ? this.placeDeletions.commit(publish) : publish());
    } catch (error) {
      if (error instanceof RequestError) throw error;
      console.error(`outline correction failed: ${error?.code ?? error?.name ?? 'error'}`);
      throw new RequestError(503, OUTLINE_MESSAGES.failed);
    } finally {
      clearTimeout(timer);
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (this.activeOutline === operation) this.activeOutline = null;
    }
  }

  async edit(draftId, jobId, body) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.readManifest(draftId, jobId);
      if (!manifest) throw new RequestError(404, 'This scene could not be found.');
      if (isTwoObject(manifest)) return this.#editObject(manifest, parseObjectEditRequest(body));
      const request = parseEditRequest(body);
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if ((previous.kind ?? 'manual') !== 'manual' || previous.baseVersion !== request.baseVersion || !sameValues(previous.offset, request.offset) || previous.yaw !== request.yaw) {
          throw new RequestError(409, 'This edit request was already used with different values.');
        }
        assertReplayUsable(manifest, previous.version);
        if (previous.fullObject) await this.fullObjects.validateBinding(draftId, jobId, previous.fullObject);
        return { version: previous.version, offset: previous.offset, yaw: previous.yaw, ...(previous.fullObject && { fullObject: previous.fullObject }) };
      }
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
      await this.assertSceneSources(manifest);
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before applying this edit.');
      }
      assertSceneUsable(manifest, 'place');
      if (manifest.edit.fullObject) await this.fullObjects.validateBinding(draftId, jobId, manifest.edit.fullObject);
      const edit = { version: manifest.edit.version + 1, offset: request.offset, yaw: request.yaw, ...(manifest.edit.fullObject && { fullObject: manifest.edit.fullObject }) };
      if (edit.fullObject) await this.fullObjects.assertMotion(manifest, edit, manifest.edit);
      await this.saveVersion(manifest, edit, { requestId: request.requestId, baseVersion: request.baseVersion, ...edit, dependencies: currentDependencies(manifest) });
      return edit;
    });
  }

  // Callers hold the mutex. Common checks before a new two-object version.
  async #objectVersionAllowed(manifest, baseVersion) {
    if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
    await this.assertSceneSources(manifest);
    if (baseVersion !== manifest.edit.version) {
      throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before applying this edit.');
    }
    assertSceneUsable(manifest, 'place');
    assertObjectsConfirmed(manifest);
  }

  // Moves or turns one object. The server starts from the whole saved
  // arrangement, so the other object and the rule cannot be changed here.
  async #editObject(manifest, request) {
    if (isComposition(manifest) !== Boolean(request.pose)) throw new RequestError(400, 'The edit could not be read.');
    if (isComposition(manifest)) await this.assertSceneSources(manifest);
    const requested = request.pose ? { pose: request.pose } : { offset: request.offset, yaw: request.yaw };
    const previous = manifest.edits.find((item) => item.requestId === request.requestId);
    if (previous) {
      const same = previous.kind === 'manual' && previous.baseVersion === request.baseVersion && previous.targetId === request.targetId
        && sameValues(previous.request, requested);
      if (!same) throw new RequestError(409, 'This edit request was already used with different values.');
      assertReplayUsable(manifest, previous.version);
      return { version: previous.version, ...arrangementOf(previous) };
    }
    await this.#objectVersionAllowed(manifest, request.baseVersion);
    const arrangement = withTarget(arrangementOf(manifest.edit), request.targetId, request.pose ?? request);
    assertRelationship(manifest, arrangement);
    const edit = { version: manifest.edit.version + 1, ...arrangement };
    await this.saveVersion(manifest, edit, {
      requestId: request.requestId, kind: 'manual', targetId: request.targetId, request: requested,
      baseVersion: request.baseVersion, ...edit, dependencies: currentDependencies(manifest),
    });
    return edit;
  }

  // Saves, changes or removes the one relationship rule as a new version. The
  // rule must already hold for the saved arrangement.
  async relationship(draftId, jobId, body) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      if (!isTwoObject(manifest)) throw new RequestError(409, 'This scene has one object, so it has no relationship to set.');
      const request = parseRelationshipRequest(body, isComposition(manifest));
      if (isComposition(manifest)) await this.assertSceneSources(manifest);
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if (previous.kind !== 'relationship' || previous.baseVersion !== request.baseVersion || !sameValues(previous.relationship, request.relationship)) {
          throw new RequestError(409, 'This request was already used with different values.');
        }
        assertReplayUsable(manifest, previous.version);
        return { version: previous.version, ...arrangementOf(previous) };
      }
      await this.#objectVersionAllowed(manifest, request.baseVersion);
      if (sameValues(manifest.edit.relationship, request.relationship)) throw new RequestError(409, 'This relationship is already saved.');
      const arrangement = { ...arrangementOf(manifest.edit), relationship: request.relationship };
      assertRelationship(manifest, arrangement);
      const edit = { version: manifest.edit.version + 1, ...arrangement };
      await this.saveVersion(manifest, edit, {
        requestId: request.requestId, kind: 'relationship', baseVersion: request.baseVersion, ...edit, dependencies: currentDependencies(manifest),
      });
      return edit;
    });
  }

  // Records once that the owner checked both outlined objects. Not a version.
  async confirmObjects(draftId, jobId, body) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      if (!isTwoObject(manifest)) throw new RequestError(409, 'This scene has one object, so there is nothing to confirm.');
      const { requestId } = parseConfirmRequest(body, isComposition(manifest));
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be confirmed.');
      await this.assertSceneSources(manifest);
      let current = manifest;
      if (!manifest.objectsConfirmed) {
        if (!(await this.sceneSourceUses(manifest)).place) throw new RequestError(403, SOURCE_BLOCKED_MESSAGE);
        current = await this.update(manifest, { objectsConfirmed: { requestId, confirmedAt: new Date().toISOString() } });
      }
      const { objects, objectsConfirmed } = publicManifest(current, await this.sceneSourceUses(manifest));
      return { objects, objectsConfirmed };
    });
  }

  // One manifest write holds the new transform, its request receipt and every
  // proposal status change, so no partial apply can be observed or persisted.
  // Every receipt names the contributions its transform depends on.
  // Every new main version passes the visible-surface gate before anything is written.
  async saveVersion(manifest, edit, receipt, proposals = manifest.proposals ?? [], extra = {}) {
    if (isComposition(manifest)) {
      await this.assertSceneSources(manifest);
      if (edit.frame !== 'owner-composition' || edit.objects.length !== 2 || edit.objects.some((item, index) => item.id !== OBJECT_IDS[index])) throw new RequestError(400, 'The arrangement could not be read.');
      for (const object of edit.objects) canonicalPose(object);
      assertRelationship(manifest, edit);
    }
    await this.assertVisibleArrangement(manifest, edit);
    const changes = { ...extra, edit, edits: [...manifest.edits, receipt] };
    if (manifest.proposals || proposals.length > 0) changes.proposals = staleProposals(proposals, edit.version, new Date().toISOString());
    return this.update(manifest, changes);
  }

  // Callers hold the mutex. Refuses with a fixed 409 unless the two named
  // objects' photographed surfaces are clear of each other in `arrangement`.
  // Single-object scenes have nothing to compare. The surface is read from the
  // job and must match its recorded size and checksum on every call.
  async assertVisibleArrangement(manifest, arrangement) {
    if (!isTwoObject(manifest)) return;
    if (isComposition(manifest)) await this.compositionAssets(manifest);
    let result;
    try {
      const { checkVisibleArrangement, visibleSurfaceProblem } = await loadVisibleGate();
      const prepared = await this.#visibleGeometry(manifest);
      if (!prepared) throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
      result = visibleSurfaceProblem(checkVisibleArrangement(prepared, arrangement, this.visibleSurfaceLimits));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      console.error(`scene ${manifest.id} visible-surface check failed: ${error?.name ?? 'error'}`);
      throw new RequestError(409, VISIBLE_SURFACE_UNVERIFIED);
    }
    if (result) throw new RequestError(409, result);
  }

  // The prepared surface geometry for the scene's verified surface.json, or
  // null when the file is missing, changed, oversized or not the scene's own.
  async #visibleGeometry(manifest) {
    const entry = manifest.derivedAssets?.find((item) => item.name === 'surface.json');
    if (!entry || !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > (isComposition(manifest) ? COMPOSITION_OUTPUTS : OUTPUTS)['surface.json'].maxBytes) return null;
    const assets = path.join(this.jobDir(manifest.draftId, manifest.id), 'assets');
    // Every folder from the data root to the assets folder must be real, and
    // the file's own size is checked before any bytes are allocated.
    if (!(await safeJobDirectory(assets, this.rootDir))) return null;
    const file = path.join(assets, 'surface.json');
    let bytes;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size !== entry.size) return null;
      bytes = await readFile(file);
    } catch {
      return null;
    }
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) return null;
    const key = `${manifest.draftId}/${manifest.id}/${entry.sha256}`;
    let prepared = this.visibleCache?.key === key ? this.visibleCache.prepared : null;
    if (!prepared) {
      const { THREE, MeshBVH, prepareVisibleGeometry } = await loadVisibleGate();
      let surface;
      try {
        surface = JSON.parse(bytes.toString('utf8'));
      } catch {
        return null;
      }
      prepared = prepareVisibleGeometry(THREE, MeshBVH, surface);
      this.visibleCache = { key, prepared };
    }
    // The checked meshes must turn about the same pivots the scene records.
    const parts = prepared.parts?.map(({ id, pivot }) => ({ id, pivot: [...pivot] }));
    return sameValues(parts, objectPivots(manifest)) ? prepared : null;
  }

  async editableScene(draftId, jobId) {
    const manifest = await this.readManifest(draftId, jobId);
    if (!manifest) throw new RequestError(404, 'This scene could not be found.');
    return manifest;
  }

  async proposals(draftId, jobId) {
    await this.recover();
    const manifest = await this.editableScene(draftId, jobId);
    if (manifest.edit?.fullObject) throw new RequestError(409, 'Memory proposals for this full-object version are not available yet.');
    // Proposals for a saved alternative are listed only under that alternative.
    return this.projectProposals(manifest, (manifest.proposals ?? []).filter((item) => !item.scope).reverse());
  }

  // Every proposal leaving the server: a photo without place use hides the
  // message and plan of every proposal of its scenes; disk records stay intact.
  async projectProposals(manifest, proposals) {
    const { place } = await this.sceneSourceUses(manifest);
    return Promise.all(proposals.map(async (item) => {
      const refs = proposalSourceDependencies(manifest, item);
      const sourceIssue = refs === null || await this.sourceDependencyIssue(manifest, { sourceDependencies: refs });
      let written = null;
      if (!sourceIssue && item.statement && Object.hasOwn(item.statement, 'source')) {
        written = await this.resolveStatementSource(manifest, item.statement.source, 'place').catch(() => null);
        if (!written || written.text !== item.statement.text || written.sourceSha256 !== item.statement.sha256) written = null;
      }
      const invalidStatement = item.statement && Object.hasOwn(item.statement, 'source') && !written;
      if (place && !sourceIssue && !invalidStatement) {
        const projected = projectProposal(manifest, item);
        return written ? { ...projected, statement: { ...projected.statement, attribution: written.attribution } } : projected;
      }
      return { ...item, statement: { ...item.statement, text: null }, result: null, question: null, status: 'stale', error: sourceIssue || invalidStatement ? WRITTEN_REDACTED_PROPOSAL : SOURCE_REDACTED_PROPOSAL, redacted: true,
        ...(item.scope && { candidate: null }) };
    }));
  }

  async projectProposal(manifest, proposal) {
    return (await this.projectProposals(manifest, [proposal]))[0];
  }

  async proposal(draftId, jobId, proposalId) {
    const found = (await this.proposals(draftId, jobId)).find((item) => item.id === proposalId);
    if (!found) throw new RequestError(404, 'This proposal could not be found.');
    return found;
  }

  async history(draftId, jobId) {
    await this.recover();
    const read = async () => {
      const manifest = await this.editableScene(draftId, jobId);
      if (isComposition(manifest)) await this.assertSceneSources(manifest);
      // Owner-only audit: whether restoring each version is still allowed.
      const { place } = await this.sceneSourceUses(manifest);
      return Promise.all(editHistory(manifest).map(async (entry) => {
        const dependencies = versionDependencies(manifest, entry.version);
        const fullObject = manifest.edits.find((item) => item.version === entry.version)?.fullObject;
        if (fullObject) await this.fullObjects.validateBinding(draftId, jobId, fullObject);
        return { ...entry, ...(fullObject && { fullObject }), dependencies: [...dependencies], blocked: !place || dependenciesBlocked(manifest, dependencies) };
      }));
    };
    return this.serialize(() => this.placeDeletions ? this.placeDeletions.commit(read) : read());
  }

  async createProposal(draftId, jobId, body) {
    await this.recover();
    const accepted = await this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      if (manifest.edit?.fullObject) throw new RequestError(409, 'Memory proposals for this full-object version are not available yet.');
      const twoObjects = isTwoObject(manifest);
      if (isComposition(manifest)) await this.assertSceneSources(manifest);
      const request = parseProposalRequest(body, { targetIds: twoObjects ? [...OBJECT_IDS] : null });
      const proposals = manifest.proposals ?? [];
      const existing = proposals.find((item) => item.requestId === request.requestId);
      if (existing) {
        if (existing.baseVersion !== request.baseVersion || existing.statement.text !== request.text || (existing.targetId ?? null) !== (request.targetId ?? null)) {
          throw new RequestError(409, 'This proposal request was already used with a different message or version.');
        }
        return { proposal: await this.projectProposal(manifest, existing), start: false };
      }
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
      if (isComposition(manifest)) return this.#compositionProposal(manifest, request, proposals);
      const { source, imagePath, size } = await this.verifiedOriginal(draftId, manifest.sourceId);
      if (source.origin?.kind !== 'public') {
        throw new RequestError(403, 'During development, only photos marked as public material can be sent to the hosted model.');
      }
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before asking for a proposal.');
      }
      assertSceneUsable(manifest, 'model');
      assertObjectsConfirmed(manifest);
      if (!this.proposalModel) throw new RequestError(503, 'Memory-based editing with the hosted model is not set up on this computer.');
      if (this.closed) throw new RequestError(503, 'The app is shutting down. Try again later.');
      if (this.activeProposal) throw new RequestError(409, 'Another proposal is being prepared right now. Try again when it finishes.');
      const proposal = newProposal({ id: randomUUID(), statementId: randomUUID(), now: new Date().toISOString(), ...request, targetId: request.targetId ?? null });
      return this.beginProposal(manifest, proposals, proposal, this.proposalDispatch(manifest, request.targetId, manifest.edit, { original: { imagePath, size } }));
    });
    this.launchProposal(draftId, jobId, accepted);
    return accepted.proposal;
  }

  // Writes a new queued proposal and takes the single model slot. Callers hold
  // the mutex and have checked the request; close() may have started while
  // the record was being written, and then no call is ever started.
  async beginProposal(manifest, proposals, proposal, dispatch) {
    const stored = await this.update(manifest, { proposals: [...proposals, proposal] });
    if (this.closed) {
      const interrupted = { ...proposal, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
      await this.update(stored, { proposals: [...proposals, interrupted] });
      return { proposal: interrupted, start: false };
    }
    this.activeProposal = {
      id: proposal.id, draftId: manifest.draftId, jobId: manifest.id, ...(dispatch.photos ? { sourceIds: dispatch.context.sourceIds } : { sourceId: dispatch.sourceId }),
      sourceIds: [...new Set([...(dispatch.photos ? dispatch.context.sourceIds : [dispatch.sourceId]), ...(proposalSourceDependencies(manifest, proposal) ?? []).map((ref) => ref.sourceId)])],
      controller: new AbortController(), done: null,
    };
    return { proposal, start: true, ...dispatch };
  }

  launchProposal(draftId, jobId, accepted) {
    if (accepted.start) this.activeProposal.done = this.runProposal(draftId, jobId, accepted);
  }

  // What the model is sent about one object of a whole saved arrangement (main
  // or a saved alternative): the selected photo region, or both ordered photos
  // with their raw boxes, and the arrangement as context. It may change only
  // that object. `original` or `photos` were admitted by the caller.
  proposalDispatch(manifest, targetId, arrangement, { original = null, photos = null }) {
    if (photos) {
      const sourceIds = geometrySources(manifest).map(({ sourceId }) => sourceId);
      const objects = manifest.objects.map(({ id, label, sourceId, box }) => ({ id, label, sourceId, box: [...box], pose: copyPose(arrangement.objects.find((item) => item.id === id)) }));
      return {
        photos: photos.map((photo, index) => ({ ...photo, box: objects[index].box })), saved: copyPose(arrangement.objects.find((item) => item.id === targetId)),
        context: {
          representation: COMPOSITION_REPRESENTATION, sourceIds, targetId, objects,
          // A saved alternative has no main version, and none is invented for it.
          arrangement: { ...(arrangement.version !== undefined && { version: arrangement.version }), ...arrangementOf(arrangement) },
          relationship: arrangement.relationship && { ...arrangement.relationship },
        },
      };
    }
    const twoObjects = isTwoObject(manifest);
    const target = twoObjects ? manifest.objects.find((item) => item.id === targetId) : null;
    const box = target ? target.box : manifest.box;
    const { imagePath, size } = original;
    const [x1, y1, x2, y2] = box;
    const selection = [x1 / size.width, y1 / size.height, x2 / size.width, y2 / size.height];
    const targetSaved = target && arrangement.objects.find((item) => item.id === target.id);
    const saved = targetSaved ? { offset: [...targetSaved.offset], yaw: targetSaved.yaw }
      : arrangement.fullObject ? { offset: [...arrangement.offset], yaw: arrangement.yaw } : arrangement;
    return { imagePath, selection, box, sourceId: manifest.sourceId, saved, context: twoObjects ? modelContext(manifest, targetId, arrangement) : null };
  }

  async #compositionProposal(manifest, request, proposals) {
    const photos = await this.assertSceneSources(manifest, 'model');
    await this.compositionAssets(manifest);
    if (photos.some(({ source }) => source.origin?.kind !== 'public')) throw new RequestError(403, 'Only public photos can be sent to the hosted model.');
    if (request.baseVersion !== manifest.edit.version) throw new RequestError(409, 'The scene changed. Reload it before asking for a proposal.');
    assertObjectsConfirmed(manifest);
    assertSceneUsable(manifest, 'model');
    if (!this.proposalModel) throw new RequestError(503, 'Memory-based editing with the hosted model is not set up on this computer.');
    if (this.closed) throw new RequestError(503, 'The app is shutting down.');
    if (this.activeProposal) throw new RequestError(409, 'Another proposal is being prepared right now.');
    const proposal = newProposal({ id: randomUUID(), statementId: randomUUID(), now: new Date().toISOString(), ...request });
    return this.beginProposal(manifest, proposals, proposal, this.proposalDispatch(manifest, request.targetId, manifest.edit, { photos }));
  }

  // Applies `change(proposal, manifest)` under the caller's mutex slot and
  // returns the stored proposal; null changes leave the manifest untouched.
  async changeProposal(draftId, jobId, proposalId, change) {
    const manifest = await this.editableScene(draftId, jobId);
    const proposals = manifest.proposals ?? [];
    const current = proposals.find((item) => item.id === proposalId);
    if (!current) throw new RequestError(404, 'This proposal could not be found.');
    const changes = await change(current, manifest);
    if (!changes) return current;
    const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
    await this.update(manifest, { proposals: proposals.map((item) => (item.id === proposalId ? next : item)) });
    return next;
  }

  // The model runs outside the manifest mutex. Its result is committed only if
  // the proposal is still processing and the saved version is unchanged.
  async runProposal(draftId, jobId, { proposal, imagePath, selection, box, sourceId, saved, context, photos }) {
    const { controller } = this.activeProposal;
    const { signal } = controller;
    const finish = (changes) => this.serialize(() => this.changeProposal(draftId, jobId, proposal.id, (current) => (current.status === 'processing' ? changes : null)));
    try {
      const modelAllowed = async () => {
        if (!photos) {
          const { model } = await this.sourceUses(draftId, sourceId);
          // A proposal for a saved alternative sends only public material, checked at every outbound step.
          if (!model || !proposal.scope) return model;
          const draft = await this.drafts.get(draftId);
          return draft?.sources?.find((item) => item.id === sourceId)?.origin?.kind === 'public';
        }
        try {
          const scene = await this.editableScene(draftId, jobId);
          const originals = await this.assertSceneSources(scene, 'model');
          return originals.every(({ source }) => source.origin?.kind === 'public');
        } catch { return false; }
      };
      // A proposal for a saved alternative also needs, at every check, the
      // finished scene and the exact bytes of every original and derived file.
      const intact = async () => {
        if (!proposal.scope) return true;
        try {
          const scene = await this.editableScene(draftId, jobId);
          await this.assertSceneFiles(scene);
          const bound = proposalBinding(scene, proposal);
          if (!bound) return false;
          if (bound.arrangement.fullObject) await this.fullObjects.validateBinding(draftId, jobId, bound.arrangement.fullObject);
          return scene.status === 'ready';
        } catch { return false; }
      };
      // Dependencies of what the proposal is bound to: main, or its parent alternative.
      const bindingIssue = async (manifest, current) => {
        const refs = proposalSourceDependencies(manifest, current);
        if (refs === null) return 'written';
        const sourceIssue = await this.sourceDependencyIssue(manifest, { sourceDependencies: refs }, 'model');
        if (sourceIssue) return sourceIssue === 'model' ? 'written-model' : 'written';
        if (current.statement && Object.hasOwn(current.statement, 'source')) {
          const written = await this.resolveStatementSource(manifest, current.statement.source).catch(() => null);
          if (!written || written.text !== current.statement.text || written.sourceSha256 !== current.statement.sha256) return 'written';
        }
        const binding = proposalBinding(manifest, current);
        return binding ? dependencyIssue(manifest, binding.dependencies, 'model') : 'unavailable';
      };
      const bindingMessage = (issue) => issue === 'written-model' ? 'Model use is off for this written source.'
        : issue === 'written' ? WRITTEN_REDACTED_PROPOSAL : issueMessage(issue);
      // Grants are checked again at dispatch: a withdrawal may have arrived since creation.
      const started = await this.serialize(async () => { const allowed = await modelAllowed(); const whole = await intact(); return this.changeProposal(draftId, jobId, proposal.id, async (current, manifest) => {
        if (current.status !== 'queued') return null;
        if (!allowed) return { status: 'failed', error: PROPOSAL_MESSAGES.restricted };
        if (!whole) return { status: 'failed', error: PROPOSAL_MESSAGES.scene };
        const issue = await bindingIssue(manifest, current);
        if (issue) return { status: 'failed', error: bindingMessage(issue) };
        return { status: 'processing' };
      }); });
      if (started.status !== 'processing') return;
      const scene = await this.editableScene(draftId, jobId);
      const surface = JSON.parse((photos ? (await this.compositionAssets(scene))['surface.json'] : await readFile(path.join(this.jobDir(draftId, jobId), 'assets', 'surface.json'))).toString('utf8'));
      let image;
      let images;
      try {
        if (photos) {
          images = [];
          for (const photo of photos) {
            if (!(await modelAllowed()) || !(await intact()) || signal.aborted || this.closed) throw new Error('Source unavailable');
            images.push({ sourceId: photo.source.id, image: await this.prepareImage({ imagePath: photo.imagePath, box: photo.box, signal }),
              selection: [...photo.box] });
          }
        } else {
          if (!(await intact())) throw new Error('Scene unavailable');
          image = await this.prepareImage({ imagePath, box, signal });
        }
      } catch (error) {
        console.error(`proposal ${proposal.id} image preparation failed: ${String(error?.message ?? 'error').slice(0, 300)}`);
        await finish(signal.aborted ? { status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted } : { status: 'failed', error: PROPOSAL_MESSAGES.image });
        return;
      }
      // Last check before anything reaches the provider: under the mutex, the
      // proposal must still be processing and every inherited grant still valid.
      // The call starts inside the slot but is awaited outside it.
      const dispatched = await this.serialize(async () => {
        const manifest = await this.editableScene(draftId, jobId);
        if (photos) await this.compositionAssets(manifest);
        const current = (manifest.proposals ?? []).find((item) => item.id === proposal.id);
        if (current?.status !== 'processing') return null;
        if (!(await modelAllowed())) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'failed', error: PROPOSAL_MESSAGES.restricted }));
          return null;
        }
        if (signal.aborted || this.closed) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted }));
          return null;
        }
        if (!(await intact())) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'failed', error: PROPOSAL_MESSAGES.scene }));
          return null;
        }
        const issue = await bindingIssue(manifest, current);
        if (issue) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'failed', error: bindingMessage(issue) }));
          return null;
        }
        // Each outbound request the model makes is admitted here, under the
        // same mutex as restrictions, withdrawals and cancellations.
        const admit = (start) => this.serialize(async () => {
          if (signal.aborted || this.closed || !(await modelAllowed()) || !(await intact())) return null;
          const scene = await this.editableScene(draftId, jobId);
          const now = (scene.proposals ?? []).find((item) => item.id === proposal.id);
          if (now?.status !== 'processing' || await bindingIssue(scene, now)) return null;
          if (photos) await this.compositionAssets(scene);
          return { value: start() };
        });
        // A saved alternative is named by its ID and time revision; it has no main version.
        const binding = proposal.scope
          ? { alternative: { parentVariantId: proposal.scope.parentVariantId, baseEraRevision: proposal.scope.baseEraRevision } } : { baseVersion: proposal.baseVersion };
        return { call: this.proposalModel({ text: proposal.statement.text, ...(photos ? { images } : { image, selection, sourceId }), ...binding, saved, signal, admit, ...context }) };
      });
      if (!dispatched) return;
      const outcome = await dispatched.call;
      await this.serialize(async () => { const allowed = await modelAllowed(); const whole = await intact(); return this.changeProposal(draftId, jobId, proposal.id, async (current, manifest) => {
        const record = { model: outcome?.model ?? null, usage: outcome?.usage ?? null, responseId: outcome?.responseId ?? null, mode: outcome?.mode ?? null, latencyMs: outcome?.latencyMs ?? null,
          ...(outcome?.recordedAt && { recordedAt: outcome.recordedAt }) };
        // A canceled or stale proposal keeps its status; only what was spent is recorded.
        if (current.status !== 'processing') return record;
        // A restriction saved while the call ran: usage is kept, no result is offered.
        if (!allowed) return { ...record, status: 'failed', error: PROPOSAL_MESSAGES.restricted };
        // Still processing after an abort means shutdown: a late success is not offered.
        if (signal.aborted || this.closed) return { ...record, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
        if (!whole) return { ...record, status: 'failed', error: PROPOSAL_MESSAGES.scene };
        const binding = proposalBinding(manifest, current);
        if (!binding) return { ...record, status: 'failed', error: issueMessage('unavailable') };
        if (binding.stale) return { ...record, status: 'stale' };
        const issue = await bindingIssue(manifest, current);
        if (issue) return { ...record, status: 'failed', error: bindingMessage(issue) };
        if (!outcome?.ok) {
          return { ...record, status: 'failed', error: PROPOSAL_MESSAGES[outcome?.reason] ?? PROPOSAL_MESSAGES.provider };
        }
        const twoObjects = isTwoObject(manifest);
        const base = binding.arrangement;
        const targetSaved = twoObjects ? base.objects.find((item) => item.id === current.targetId) : base;
        const checked = validatePlan(outcome.plan, {
          ...(photos ? { sourceIds: context.sourceIds, arrangement: base } : { sourceId }),
          ...(current.scope ? { alternative: { parentVariantId: current.scope.parentVariantId, baseEraRevision: current.scope.baseEraRevision } } : { baseVersion: current.baseVersion }),
          saved: targetSaved, surface, fullObject: Boolean(base.fullObject), ...(twoObjects && { targetId: current.targetId }),
        });
        if (checked.error) {
          console.error(`proposal ${current.id} plan rejected: ${checked.code}`);
          return { ...record, status: 'failed', error: checked.error, ...(base.fullObject && { motion: heldObjectMotion(checked.error) }) };
        }
        const { result } = checked;
        if (result.action === 'clarify') return { ...record, status: 'clarify', result, question: result.question, ...(base.fullObject && { motion: heldObjectMotion(result.question) }) };
        // The candidate is the whole bound arrangement with one object changed.
        const arrangement = variantFields(manifest, base, current.targetId, result.transform);
        // A scoped result that changes nothing is never offered.
        if (current.scope && sameArrangement(arrangement, base)) {
          console.error(`proposal ${current.id} plan rejected: unchanged`);
          return { ...record, status: 'failed', error: PROPOSAL_MESSAGES.unchanged };
        }
        let motion;
        if (base.fullObject) {
          motion = await this.fullObjects.motion(manifest, arrangement);
          if (motion.status !== 'checked') return { ...record, status: 'failed', error: motion.reason, motion };
          if (signal.aborted || this.closed) return { ...record, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted, motion: heldObjectMotion(PROPOSAL_MESSAGES.interrupted) };
        }
        // It must keep the arrangement's rule.
        if (twoObjects) {
          if (!checkRelationship(arrangement, objectPivots(manifest)).ok) {
            console.error(`proposal ${current.id} plan rejected: relationship`);
            return { ...record, status: 'failed', error: PROPOSAL_MESSAGES.relationship };
          }
          // A candidate whose photographed surfaces overlap is never offered.
          let held = null;
          try {
            await this.assertVisibleArrangement(manifest, arrangement);
          } catch (error) {
            held = error.message;
          }
          // close() aborts outside the mutex, so a shutdown that began while
          // the surfaces were read wins over both a ready and a held result.
          if (signal.aborted || this.closed) return { ...record, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
          if (held) {
            console.error(`proposal ${current.id} plan rejected: visible surfaces`);
            return { ...record, status: 'failed', error: held };
          }
        }
        return { ...record, status: 'ready', result, ...(motion && { motion }) };
      }); });
    } catch (error) {
      console.error(`proposal ${proposal.id} failed: ${error?.code ?? error?.name ?? 'error'}`);
      await finish({ status: 'failed', error: PROPOSAL_MESSAGES.unknown }).catch(() => {});
    } finally {
      this.activeProposal = null;
    }
  }

  // `parentVariantId` names the saved alternative a scoped proposal belongs
  // to; main routes pass null and never reach a scoped proposal.
  async cancelProposal(draftId, jobId, proposalId, parentVariantId = null) {
    await this.recover();
    return this.serialize(async () => {
      const proposal = await this.changeProposal(draftId, jobId, proposalId, (current) => {
        if ((current.scope?.parentVariantId ?? null) !== parentVariantId) throw new RequestError(404, 'This proposal could not be found.');
        if (current.status === 'canceled') return null;
        if (!['queued', 'processing', 'ready', 'clarify'].includes(current.status)) {
          throw new RequestError(409, 'This proposal has already finished and cannot be canceled.');
        }
        return { status: 'canceled', error: PROPOSAL_MESSAGES.canceled };
      });
      if (this.activeProposal?.id === proposalId) this.activeProposal.controller.abort();
      return this.projectProposal(await this.editableScene(draftId, jobId), proposal);
    });
  }

  async applyProposal(draftId, jobId, proposalId, request) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      if (manifest.edit?.fullObject) throw new RequestError(409, 'Memory proposals for this full-object version are not available yet.');
      if (isComposition(manifest)) await this.assertSceneSources(manifest);
      const proposals = manifest.proposals ?? [];
      const proposal = proposals.find((item) => item.id === proposalId && !item.scope);
      if (!proposal) throw new RequestError(404, 'This proposal could not be found.');
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if (previous.kind !== 'proposal' || previous.proposalId !== proposalId || previous.baseVersion !== request.baseVersion || previous.frontConfirmed !== request.frontConfirmed) {
          throw new RequestError(409, 'This apply request was already used with different values.');
        }
        assertReplayUsable(manifest, previous.version);
        const replayed = isTwoObject(manifest) ? { version: previous.version, ...arrangementOf(previous) } : { version: previous.version, offset: previous.offset, yaw: previous.yaw };
        return { edit: replayed, proposal: await this.projectProposal(manifest, proposal) };
      }
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
      await this.assertSceneSources(manifest);
      if (proposal.status === 'applied') throw new RequestError(409, 'This proposal was already applied.');
      if (proposal.status === 'stale' || (proposal.status === 'ready' && proposal.baseVersion !== manifest.edit.version)) {
        throw new RequestError(409, 'The scene changed after this proposal was made. Ask for a new proposal.');
      }
      if (proposal.status !== 'ready') throw new RequestError(409, 'Only a ready proposal can be applied.');
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before applying this proposal.');
      }
      if (['face_anchor', 'face_object'].includes(proposal.result.action) && request.frontConfirmed !== true) {
        throw new RequestError(409, 'Confirm that the visible side of the object is its front before applying this turn.');
      }
      assertSceneUsable(manifest, 'model');
      assertObjectsConfirmed(manifest);
      const { offset, yaw } = proposal.result.transform;
      let edit;
      if (isTwoObject(manifest)) {
        const arrangement = withTarget(arrangementOf(manifest.edit), proposal.targetId, isComposition(manifest) ? proposal.result.transform : { offset, yaw });
        assertRelationship(manifest, arrangement);
        edit = { version: manifest.edit.version + 1, ...arrangement };
      } else {
        edit = { version: manifest.edit.version + 1, offset: [...offset], yaw };
      }
      const applied = { ...proposal, status: 'applied', appliedVersion: edit.version, updatedAt: new Date().toISOString() };
      const receipt = {
        requestId: request.requestId, kind: 'proposal', proposalId, frontConfirmed: request.frontConfirmed, baseVersion: request.baseVersion, ...edit,
        ...(proposal.targetId !== undefined && { targetId: proposal.targetId }),
        dependencies: currentDependencies(manifest),
      };
      await this.saveVersion(manifest, edit, receipt, proposals.map((item) => (item.id === proposalId ? applied : item)));
      return { edit, proposal: applied };
    });
  }

  async undo(draftId, jobId, body) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      if (isComposition(manifest)) await this.assertSceneSources(manifest);
      const twoObjects = isTwoObject(manifest);
      const request = parseUndoRequest(body, { twoObjects });
      if (manifest.edit?.fullObject || manifest.edits.some((item) => item.version === request.targetVersion && item.fullObject)) {
        throw new RequestError(409, 'Restoring a full-object version is not available yet.');
      }
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if (previous.kind !== 'undo' || previous.baseVersion !== request.baseVersion || previous.targetVersion !== request.targetVersion
          || (twoObjects && previous.ruleChangeConfirmed !== request.ruleChangeConfirmed)) {
          throw new RequestError(409, 'This undo request was already used with different values.');
        }
        assertReplayUsable(manifest, previous.version);
        return twoObjects ? { version: previous.version, ...arrangementOf(previous) } : { version: previous.version, offset: previous.offset, yaw: previous.yaw };
      }
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
      await this.assertSceneSources(manifest);
      assertObjectsConfirmed(manifest);
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before undoing.');
      }
      const target = editHistory(manifest).find((item) => item.version === request.targetVersion);
      if (!target || target.version >= manifest.edit.version) throw new RequestError(409, 'Only an earlier saved version can be restored.');
      // Undo is the way out of a blocked scene, so it checks the target, not the current version.
      const dependencies = versionDependencies(manifest, target.version);
      const issue = dependencyIssue(manifest, dependencies);
      if (issue === 'unavailable') throw new RequestError(409, 'That saved version depends on a contributor photo that is not available right now and cannot be restored.');
      if (issue) throw new RequestError(409, 'That saved version depends on a withdrawn contribution and cannot be restored.');
      if (twoObjects) {
        // Restoring a version also restores its rule; a different rule needs explicit confirmation.
        const arrangement = arrangementOf(target);
        if (!sameValues(arrangement.relationship, manifest.edit.relationship) && request.ruleChangeConfirmed !== true) {
          throw new RequestError(409, 'Restoring this version also changes the relationship between the objects. Confirm that change to continue.');
        }
        assertRelationship(manifest, arrangement);
        const edit = { version: manifest.edit.version + 1, ...arrangement };
        await this.saveVersion(manifest, edit, {
          requestId: request.requestId, kind: 'undo', targetVersion: target.version, ruleChangeConfirmed: request.ruleChangeConfirmed, baseVersion: request.baseVersion, ...edit, dependencies,
        });
        return edit;
      }
      const edit = { version: manifest.edit.version + 1, offset: [...target.offset], yaw: target.yaw };
      await this.saveVersion(manifest, edit, { requestId: request.requestId, kind: 'undo', targetVersion: target.version, baseVersion: request.baseVersion, ...edit, dependencies });
      return edit;
    });
  }

  #requireOwner(principal) {
    if (!principal?.id) throw new RequestError(401, 'Sign in to continue.');
    if (principal.role !== 'owner') throw new RequestError(403, 'This action is not allowed.');
  }

  // The stored links of one scene: { schemaVersion, objects }, empty when
  // there is no file. A larger, unreadable or invalid file, or an unsafe job
  // folder, throws a fixed 503; it never reads as an empty list.
  async #readRegionLinks(draftId, jobId) {
    const jobDir = this.jobDir(draftId, jobId);
    if (!(await safeJobDirectory(jobDir, this.rootDir).catch(() => false))) throw new RequestError(503, REGION_UNAVAILABLE);
    let bytes;
    try {
      bytes = await readUpTo(path.join(jobDir, REGION_LINKS_FILE), REGION_LINKS_BYTES);
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, objects: {} };
      throw new RequestError(503, REGION_UNAVAILABLE);
    }
    let state = null;
    try {
      if (bytes.length <= REGION_LINKS_BYTES) state = JSON.parse(bytes.toString('utf8'));
    } catch {
      state = null;
    }
    if (!validRegionLinks(state)) throw new RequestError(503, REGION_UNAVAILABLE);
    return state;
  }

  // Callers hold the mutex. A ready two-object scene whose objects were
  // confirmed, that is usable through its own photo and its dependencies,
  // and whose original still matches its record.
  async #linkScene(draftId, jobId) {
    const manifest = await this.readManifest(draftId, jobId);
    if (!manifest) throw new RequestError(404, 'This scene could not be found.');
    if (manifest.status !== 'ready' || !isTwoObject(manifest) || !manifest.objectsConfirmed) throw new RequestError(409, REGION_NOT_READY);
    if (!(await this.sceneSourceUses(manifest)).place) throw new RequestError(409, SOURCE_BLOCKED_MESSAGE);
    assertSceneUsable(manifest, 'place');
    if (isComposition(manifest)) await this.assertSceneSources(manifest);
    else {
      const { source } = await this.verifiedOriginal(draftId, manifest.sourceId, 'place');
      if (source.sha256 !== manifest.sourceSha256) throw new RequestError(409, CHECKSUM_MESSAGE);
    }
    return { manifest, draft: await this.drafts.get(draftId) };
  }

  // Callers hold the mutex. Another photo of the same memory with current
  // place use (never model use) and verified bytes; returns its stored size.
  async #admitReference(draft, manifest, sourceId) {
    const source = Array.isArray(draft?.sources) ? draft.sources.find((item) => item.id === sourceId) : null;
    if (!source || source.kind !== 'photo' || geometrySources(manifest).some((entry) => entry.sourceId === sourceId)) throw new RequestError(400, 'Link a region in a different photo of this memory.');
    const { size } = await this.verifiedOriginal(draft.id, sourceId, 'place');
    return { source, size };
  }

  // The current safe view of one stored link. Grants are checked before any
  // byte is read, so the pixels of a disallowed photo are never opened; an
  // unavailable link keeps only its photo and time.
  async #projectRegionLink(draft, link) {
    const hidden = (reason) => ({ sourceId: link.sourceId, box: null, imageSize: null, linkedAt: link.linkedAt, available: false, reason });
    const source = Array.isArray(draft?.sources) ? draft.sources.find((item) => item.id === link.sourceId && item.kind === 'photo') : null;
    if (!source) return hidden('unreadable');
    if (!(await this.sourcePolicies.canUse(draft, link.sourceId, 'place'))) return hidden('source');
    const asset = await this.drafts.asset(draft.id, source.name);
    if (!asset || !recordedPhotoSize(source)) return hidden('unreadable');
    let bytes;
    try {
      bytes = await readUpTo(asset.file, source.size);
    } catch {
      return hidden('unreadable');
    }
    if (bytes.length !== source.size || sha256(bytes) !== source.sha256 || source.sha256 !== link.sourceSha256) return hidden('checksum');
    const size = imageSize(bytes);
    if (!size) return hidden('unreadable');
    if (size.width !== link.imageSize[0] || size.height !== link.imageSize[1]) return hidden('checksum');
    return { sourceId: link.sourceId, box: [...link.box], imageSize: [size.width, size.height], linkedAt: link.linkedAt, available: true, reason: null };
  }

  async #regionView(draft, manifest, objectId, entry) {
    const object = manifest.objects.find((item) => item.id === objectId);
    const links = [];
    for (const link of entry.links) links.push(await this.#projectRegionLink(draft, link));
    return {
      draftId: manifest.draftId, jobId: manifest.id, objectId, label: object.label,
      scenePhoto: { sourceId: isComposition(manifest) ? object.sourceId : manifest.sourceId, box: [...object.box] }, revision: entry.revision, updatedAt: entry.updatedAt, links,
    };
  }

  async regionLinks(draftId, jobId, objectId) {
    if (!OBJECT_IDS.includes(objectId)) throw new RequestError(404, 'This object could not be found.');
    await this.recover();
    return this.serialize(async () => {
      const { manifest, draft } = await this.#linkScene(draftId, jobId);
      const state = await this.#readRegionLinks(draftId, jobId);
      return this.#regionView(draft, manifest, objectId, state.objects[objectId] ?? emptyRegionEntry());
    });
  }

  // The stored pixel size of another photo the owner may link, admitted with
  // place use only. The links file is not read.
  async regionReference(draftId, jobId, sourceId) {
    await this.recover();
    return this.serialize(async () => {
      const { manifest, draft } = await this.#linkScene(draftId, jobId);
      const { size } = await this.#admitReference(draft, manifest, sourceId);
      return { width: size.width, height: size.height };
    });
  }

  // One explicit set or remove for one object. An exact replay is found before
  // the cap and the revision check and never reapplies; every success, a
  // no-op included, keeps a receipt. The whole file is rewritten from its
  // latest state, so the other object's links are kept.
  async changeRegionLink(draftId, jobId, objectId, body) {
    if (!OBJECT_IDS.includes(objectId)) throw new RequestError(404, 'This object could not be found.');
    const request = parseRegionLinkRequest(body);
    await this.recover();
    return this.serialize(async () => {
      const { manifest, draft } = await this.#linkScene(draftId, jobId);
      const state = await this.#readRegionLinks(draftId, jobId);
      const entry = state.objects[objectId] ?? emptyRegionEntry();
      const digest = sha256(JSON.stringify([request.baseRevision, request.action, request.sourceId, request.box]));
      const receipt = entry.receipts.find((item) => item.requestId === request.requestId);
      if (receipt) {
        if (receipt.digest !== digest) throw new RequestError(409, 'This request was already used with different values.');
        return { ...(await this.#regionView(draft, manifest, objectId, entry)), changed: false, replayed: true, appliedRevision: receipt.revision };
      }
      if (entry.receipts.length >= REGION_RECEIPTS_MAX) throw new RequestError(409, 'These photo links cannot be changed again.');
      if (request.baseRevision !== entry.revision) throw new RequestError(409, 'These photo links changed elsewhere. Reload them before saving.');
      const existing = entry.links.find((link) => link.sourceId === request.sourceId);
      let links = entry.links;
      if (request.action === 'remove') {
        // A link whose photo is no longer available can still be removed.
        if (!existing) throw new RequestError(404, 'This photo region link could not be found.');
        links = entry.links.filter((link) => link !== existing);
      } else {
        const { source, size } = await this.#admitReference(draft, manifest, request.sourceId);
        const [, , x2, y2] = request.box;
        if (x2 > size.width || y2 > size.height) throw new RequestError(400, `The selected box must stay inside the photo (${size.width} x ${size.height} pixels).`);
        const same = existing && sameValues(existing.box, request.box) && existing.sourceSha256 === source.sha256
          && existing.imageSize[0] === size.width && existing.imageSize[1] === size.height;
        if (!same) {
          const link = { sourceId: request.sourceId, sourceSha256: source.sha256, imageSize: [size.width, size.height], box: [...request.box], linkedAt: new Date().toISOString() };
          links = existing ? entry.links.map((item) => (item === existing ? link : item)) : [...entry.links, link];
        }
      }
      const changed = links !== entry.links;
      const revision = changed ? entry.revision + 1 : entry.revision;
      const next = {
        revision, updatedAt: changed ? new Date().toISOString() : entry.updatedAt, links,
        receipts: [...entry.receipts, { requestId: request.requestId, digest, revision }],
      };
      const file = path.join(this.jobDir(draftId, jobId), REGION_LINKS_FILE);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, objects: { ...state.objects, [objectId]: next } }, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new RequestError(503, 'The photo region link could not be saved. Nothing was changed.');
      }
      return { ...(await this.#regionView(draft, manifest, objectId, next)), changed, replayed: false, appliedRevision: revision };
    });
  }

  // The stored written memory links of one scene, empty when there is no
  // file. A larger, unreadable or invalid file, or an unsafe job folder,
  // throws a fixed 503; it never reads as empty.
  async #readMemoryLinks(draftId, jobId) {
    const jobDir = this.jobDir(draftId, jobId);
    if (!(await safeJobDirectory(jobDir, this.rootDir).catch(() => false))) throw new RequestError(503, MEMORY_UNAVAILABLE);
    // Only a regular file is read, and never through a link: a symlinked,
    // special or swapped entry is unavailable, not empty.
    const file = path.join(jobDir, MEMORY_LINKS_FILE);
    let bytes;
    try {
      if (!(await lstat(file)).isFile()) throw new RequestError(503, MEMORY_UNAVAILABLE);
      bytes = await readUpTo(file, MEMORY_LINKS_BYTES, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, objects: {} };
      throw new RequestError(503, MEMORY_UNAVAILABLE);
    }
    let state = null;
    try {
      if (bytes.length <= MEMORY_LINKS_BYTES) state = JSON.parse(bytes.toString('utf8'));
    } catch {
      state = null;
    }
    if (!validMemoryLinks(state)) throw new RequestError(503, MEMORY_UNAVAILABLE);
    return state;
  }

  // Callers hold the mutex. The current written source is read fresh from
  // the saved draft with its current place use; the words appear only while
  // available, and the link never carries them.
  async #memoryView(draft, manifest, objectId, entry) {
    const placeAllowed = Boolean(draft?.textSourceId) && (await this.sourcePolicies.canUse(draft, draft.textSourceId, 'place'));
    const written = writtenSourceView(draft, placeAllowed);
    const link = memoryLinkView(entry.link, written);
    // While a stored link's binding is unavailable, no current words are shown
    // for it, even ones that would validate against changed metadata.
    const source = written && link && !link.available
      ? { sourceId: written.view.sourceId, available: false, reason: link.reason, text: null }
      : written && { ...written.view };
    return {
      draftId: manifest.draftId, jobId: manifest.id, objectId, label: manifest.objects.find((item) => item.id === objectId).label,
      revision: entry.revision, updatedAt: entry.updatedAt, source, link,
    };
  }

  async memoryLink(draftId, jobId, objectId) {
    if (!OBJECT_IDS.includes(objectId)) throw new RequestError(404, 'This object could not be found.');
    await this.recover();
    return this.serialize(async () => {
      const { manifest, draft } = await this.#linkScene(draftId, jobId);
      const state = await this.#readMemoryLinks(draftId, jobId);
      return this.#memoryView(draft, manifest, objectId, state.objects[objectId] ?? emptyMemoryEntry());
    });
  }

  // One explicit set or remove for one object, in the same order as photo
  // region links: exact replay first (never reapplied), then the receipt
  // cap, then the revision. Every success, a no-op included, keeps a receipt.
  async changeMemoryLink(draftId, jobId, objectId, body) {
    if (!OBJECT_IDS.includes(objectId)) throw new RequestError(404, 'This object could not be found.');
    const request = parseMemoryLinkRequest(body);
    await this.recover();
    return this.serialize(async () => {
      const { manifest, draft } = await this.#linkScene(draftId, jobId);
      const state = await this.#readMemoryLinks(draftId, jobId);
      const entry = state.objects[objectId] ?? emptyMemoryEntry();
      const digest = memoryRequestDigest(request);
      const receipt = entry.receipts.find((item) => item.requestId === request.requestId);
      if (receipt) {
        if (receipt.digest !== digest) throw new RequestError(409, 'This request was already used with different values.');
        return { ...(await this.#memoryView(draft, manifest, objectId, entry)), changed: false, replayed: true, appliedRevision: receipt.revision };
      }
      if (entry.receipts.length >= MEMORY_RECEIPTS_MAX) throw new RequestError(409, 'This written memory link cannot be changed again.');
      if (request.baseRevision !== entry.revision) throw new RequestError(409, 'This written memory link changed elsewhere. Reload it before saving.');
      let link = entry.link;
      if (request.action === 'remove') {
        // A link to words that are no longer available can still be removed.
        if (!entry.link) throw new RequestError(404, 'There is no written memory link to remove.');
        if (entry.link.sourceId !== request.sourceId) throw new RequestError(409, 'This written memory link refers to different words. Reload it before removing.');
        link = null;
      } else {
        const placeAllowed = Boolean(draft?.textSourceId) && (await this.sourcePolicies.canUse(draft, draft.textSourceId, 'place'));
        const written = writtenSourceView(draft, placeAllowed);
        if (!written || written.view.sourceId !== request.sourceId || written.view.reason === 'unreadable') {
          throw new RequestError(400, 'This place has no saved written memory that can be linked.');
        }
        if (written.view.reason === 'source') throw new RequestError(403, 'This written memory does not currently have permission for place use.');
        if (written.view.reason === 'checksum') throw new RequestError(409, 'The saved written memory no longer matches its recorded checksum, so it cannot be linked.');
        const same = entry.link && entry.link.sourceId === request.sourceId && entry.link.sourceSha256 === written.sha256;
        if (!same) link = { sourceId: request.sourceId, sourceSha256: written.sha256, linkedAt: new Date().toISOString() };
      }
      const changed = link !== entry.link;
      const revision = changed ? entry.revision + 1 : entry.revision;
      const next = { revision, updatedAt: changed ? new Date().toISOString() : entry.updatedAt, link, receipts: [...entry.receipts, { requestId: request.requestId, digest, revision }] };
      const file = path.join(this.jobDir(draftId, jobId), MEMORY_LINKS_FILE);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, objects: { ...state.objects, [objectId]: next } }, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new RequestError(503, 'The written memory link could not be saved. Nothing was changed.');
      }
      return { ...(await this.#memoryView(draft, manifest, objectId, next)), changed, replayed: false, appliedRevision: revision };
    });
  }

  // Local current uses of a source: scenes built from it, live shared
  // snapshots of those scenes, and model work still running for them.
  // Counts saved uses of a photo or recording: a scene built from the photo,
  // its stories, and stories that use the recording. Each snapshot counts once.
  async sourceImpacts(draftId, sourceId) {
    const impacts = { scenes: 0, stories: 0, snapshots: 0, processing: 0, linkedRegions: 0, linkedMemories: 0 };
    if (!UUID_PATTERN.test(draftId)) return impacts;
    const now = Date.now();
    for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
      const manifest = await this.readManifest(draftId, jobId).catch(() => null);
      // Stored links, available or not, whose reference or base photo is this
      // source. Metadata only and no lock. An unreadable links file, or stored
      // links whose scene manifest cannot be read (so their base photo is
      // unknown), make the count unknown (null); neither blocks a restriction.
      if (impacts.linkedRegions !== null) {
        const links = await this.#readRegionLinks(draftId, jobId).catch(() => undefined);
        const entries = links ? Object.values(links.objects) : [];
        if (links === undefined || (!manifest && entries.some((entry) => entry.links.length > 0))) impacts.linkedRegions = null;
        else if (manifest) {
          for (const entry of entries) {
            impacts.linkedRegions += entry.links.filter((link) => link.sourceId === sourceId || geometrySources(manifest).some((entry) => entry.sourceId === sourceId)).length;
          }
        }
      }
      // Written memory links the same way: each stored link once, when it
      // refers to this source or its scene's base photo is this source.
      if (impacts.linkedMemories !== null) {
        const links = await this.#readMemoryLinks(draftId, jobId).catch(() => undefined);
        const stored = links ? Object.values(links.objects).filter((entry) => entry.link !== null) : [];
        // The base photo is trusted only from this exact scene's own record.
        const baseKnown = Boolean(manifest) && manifest.id === jobId && manifest.draftId === draftId
          && geometrySources(manifest).every((entry) => UUID_PATTERN.test(entry.sourceId));
        if (links === undefined || (!baseKnown && stored.length > 0)) impacts.linkedMemories = null;
        else if (baseKnown) impacts.linkedMemories += stored.filter((entry) => entry.link.sourceId === sourceId || geometrySources(manifest).some((entry) => entry.sourceId === sourceId)).length;
      }
      if (!manifest) continue;
      const photo = geometrySources(manifest).some((entry) => entry.sourceId === sourceId);
      const writtenUse = (holder) => (sourceDependenciesOf(holder) ?? []).some((ref) => ref.sourceId === sourceId);
      const derived = (manifest.collaboration?.variants ?? []).some(writtenUse);
      const storyIds = (manifest.stories?.items ?? [])
        .filter((story) => story.status === 'ready' && (photo || writtenUse(story.context) || story.context.voice.sourceId === sourceId)).map((story) => story.id);
      if (!photo && !derived && storyIds.length === 0) continue;
      if ((photo || derived) && manifest.status === 'ready') impacts.scenes += 1;
      if (photo && (manifest.status === 'queued' || manifest.status === 'processing')) impacts.processing += 1;
      impacts.processing += (manifest.proposals ?? []).filter((item) => ACTIVE_PROPOSAL.has(item.status)
        && (photo || (proposalSourceDependencies(manifest, item) ?? []).some((ref) => ref.sourceId === sourceId))).length;
      impacts.stories += storyIds.length;
      impacts.snapshots += (manifest.shares?.snapshots ?? []).filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > now
        && (photo || item.frozen.views.some(writtenUse) || (item.frozen.stories ?? []).some((pinned) => storyIds.includes(pinned.storyId)))).length;
    }
    if (this.activeStory?.draftId === draftId && this.activeStory.sourceIds.includes(sourceId)) impacts.processing += 1;
    if (this.activeOutline?.draftId === draftId && this.activeOutline.sourceId === sourceId) impacts.processing += 1;
    if (this.activeComposition?.draftId === draftId && this.activeComposition.sourceIds.includes(sourceId)) impacts.processing += 1;
    if (this.fullObjects?.active?.draftId === draftId && this.fullObjects.active.sourceId === sourceId) impacts.processing += 1;
    return impacts;
  }

  async sourcePolicy(draftId, sourceId, principal) {
    this.#requireOwner(principal);
    await this.recover();
    const policy = await this.sourcePolicies.get(draftId, sourceId);
    return { ...policy, impacts: await this.sourceImpacts(draftId, sourceId) };
  }

  // Saves the restriction under the global mutex first, then asks running
  // model work for this photo to stop. The saved restriction never depends on
  // that abort succeeding; data already sent cannot be recalled.
  async restrictSource(draftId, sourceId, principal, body) {
    this.#requireOwner(principal);
    await this.recover();
    return this.serialize(async () => {
      const { policy } = await this.sourcePolicies.restrict(draftId, sourceId, principal, body);
      let status = 'not-running';
      // Also on an exact replay: running work that the saved policy no longer
      // allows is asked to stop again, and the answer reflects that attempt.
      // Story decoding and outline correction need only place use, so a
      // model- or share-only reduction leaves that local work running. A
      // caption draft in the story slot sends its recording to a model.
      const work = [[this.active, 'model'], [this.activeProposal, 'model'], [this.activeStory, this.activeStory?.purpose ?? 'place'], [this.activeOutline, 'place'], [this.activeComposition, 'place'], [this.fullObjects?.active, 'model']];
      const running = work.filter(([item, purpose]) => item?.draftId === draftId
        && (item.sourceIds ?? [item.sourceId]).includes(sourceId) && !allows(policy, purpose)).map(([item]) => item);
      if (running.length > 0) {
        status = 'requested';
        for (const item of running) {
          try {
            item.controller.abort();
          } catch {
            status = 'unconfirmed';
          }
        }
      }
      const impacts = await this.sourceImpacts(draftId, sourceId);
      return { saved: true, ...policy, impacts, cancellation: { requested: status !== 'not-running', status } };
    });
  }

  // Abort unfinished work and wait for queued writes and owned cleanup.
  // A correction committed before shutdown keeps its complete ready child.
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    this.activeProposal?.controller.abort();
    this.activeStory?.controller.abort();
    this.activeContributionMedia?.controller.abort();
    this.activeOutline?.controller.abort();
    this.activeComposition?.controller.abort();
    this.fullObjects?.active?.controller.abort();
    await this.serialize(() => {});
    await Promise.all([this.active?.done, this.activeProposal?.done, this.activeStory?.done, this.activeContributionMedia?.done, this.activeOutline?.done.catch(() => {}), this.activeComposition?.done.catch(() => {}), this.fullObjects?.active?.done.catch(() => {})]);
  }
}
