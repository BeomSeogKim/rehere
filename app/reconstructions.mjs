import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestPhotos, contributionsDir } from './contribution-photos.mjs';
import { cleanupContributionFiles, removeManifestTemps, safeJobDirectory } from './contribution-deletion-files.mjs';
import {
  assertSceneUsable, issueMessage, projectProposal, currentDependencies, dependenciesBlocked, dependencyIssue, modelBlocked, usageBlocked, versionDependencies,
} from './collaboration.mjs';
import { RequestError } from './drafts.mjs';
import {
  ACTIVE_PROPOSAL, PROPOSAL_MESSAGES, editHistory, newProposal, parseProposalRequest, parseUndoRequest, pythonImagePreparer, staleProposals, validatePlan,
} from './memory-proposals.mjs';
import {
  OBJECT_IDS, arrangementOf, assertObjectsConfirmed, assertRelationship, isTwoObject, objectMarker, objectPivots, withTarget,
} from './arrangements.mjs';
import { objectSurfaceMeshes } from './public/photo-scene.js';
import { checkRelationship } from './public/scene-relations.js';
import { SourcePolicies, allows } from './source-policies.mjs';
import { sha256 } from './sources.mjs';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RECONSTRUCTION_TIMEOUT_MS = 180_000;
const SPATIAL_DIR = fileURLToPath(new URL('./spatial/', import.meta.url));
const MIB = 1024 * 1024;
const STDERR_BYTES = 8192;

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
      child.on('error', (error) => resolve({ exitCode: null, stderr, spawnError: error.code ?? 'error' }));
      child.on('close', (exitCode) => resolve({ exitCode, stderr }));
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
  const twoObjects = exactKeys(body, ['requestId', 'sourceId', 'objects']);
  if (!twoObjects && !exactKeys(body, ['requestId', 'sourceId', 'box'])) throw new RequestError(400, 'The build request could not be read.');
  const { requestId, sourceId } = body;
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId) || typeof sourceId !== 'string' || !UUID_PATTERN.test(sourceId)) {
    throw new RequestError(400, 'The build request could not be read.');
  }
  return twoObjects ? { requestId, sourceId, objects: parseObjects(body.objects) } : { requestId, sourceId, box: parseBox(body.box) };
}

const transformValid = (offset, yaw) => Array.isArray(offset) && offset.length === 3 && offset.every((value) => finite(value) && value >= -2 && value <= 2)
  && finite(yaw) && yaw >= -Math.PI && yaw <= Math.PI;

export function parseObjectEditRequest(body) {
  if (!exactKeys(body, ['requestId', 'baseVersion', 'targetId', 'offset', 'yaw'])) throw new RequestError(400, 'The edit could not be read.');
  const { requestId, baseVersion, targetId, offset, yaw } = body;
  const valid = typeof requestId === 'string' && UUID_PATTERN.test(requestId) && Number.isInteger(baseVersion) && baseVersion >= 1
    && OBJECT_IDS.includes(targetId) && transformValid(offset, yaw);
  if (!valid) throw new RequestError(400, 'The edit could not be read.');
  return { requestId, baseVersion, targetId, offset: [...offset], yaw };
}

function parseRule(rule) {
  if (rule === null) return null;
  const valid = exactKeys(rule, ['kind', 'leftId', 'rightId', 'frame']) && rule.kind === 'left_of' && rule.frame === 'original-photo'
    && OBJECT_IDS.includes(rule.leftId) && OBJECT_IDS.includes(rule.rightId) && rule.leftId !== rule.rightId;
  if (!valid) throw new RequestError(400, 'The relationship could not be read.');
  return { kind: 'left_of', leftId: rule.leftId, rightId: rule.rightId, frame: 'original-photo' };
}

export function parseRelationshipRequest(body) {
  if (!exactKeys(body, ['requestId', 'baseVersion', 'relationship', 'confirmed'])) throw new RequestError(400, 'The relationship could not be read.');
  const { requestId, baseVersion, confirmed } = body;
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId) || !Number.isInteger(baseVersion) || baseVersion < 1) {
    throw new RequestError(400, 'The relationship could not be read.');
  }
  if (confirmed !== true) throw new RequestError(400, 'Confirm the relationship change before saving it.');
  return { requestId, baseVersion, relationship: parseRule(body.relationship) };
}

function parseConfirmRequest(body) {
  const valid = exactKeys(body, ['requestId', 'objectIds']) && typeof body.requestId === 'string' && UUID_PATTERN.test(body.requestId)
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
const SOURCE_REDACTED_PROPOSAL = 'This proposal used a photo that is no longer available for place use, so its content is no longer shown.';

// Internal request, collaboration and share records stay on disk; clients see
// the manifest contract plus whether the photo's current uses or withdrawn or
// ungranted contributions block use. `source` is the photo's current uses.
export function publicManifest(manifest, source = { place: true, model: true }) {
  const { edits, proposals, collaboration, shares, stories, ...rest } = manifest;
  const ready = manifest.status === 'ready';
  const sourceBlocked = ready && !source.place;
  const contributionBlocked = usageBlocked(manifest);
  return {
    ...rest,
    // Labels are the owner's text about the photo; without its place use only
    // fixed markers are shown. The stored labels are kept on disk.
    ...(isTwoObject(manifest) && {
      objects: manifest.objects.map(({ id, label, box, pivot }) => ({
        id, label: source.place ? label : objectMarker(id), box: [...box], pivot: pivot ? [...pivot] : null,
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
function modelContext(manifest, targetId) {
  return {
    targetId,
    objects: manifest.objects.map(({ id, label, box }) => {
      const saved = manifest.edit.objects.find((item) => item.id === id);
      return { id, label, box: [...box], offset: [...saved.offset], yaw: saved.yaw };
    }),
    relationship: manifest.edit.relationship ? { ...manifest.edit.relationship } : null,
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
  }) {
    this.drafts = drafts;
    this.runner = runner;
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
      for (const draftId of await listDirs(this.rootDir)) {
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
      await rm(this.stagingDir, { recursive: true, force: true });
    });
    return this.recovered;
  }

  // The one read path for scene manifests. It also attests contributor photo
  // bundles, which every sync dependency check then requires.
  async readManifest(draftId, jobId) {
    if (!UUID_PATTERN.test(draftId) || !UUID_PATTERN.test(jobId)) return null;
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

  async get(draftId, jobId) {
    await this.recover();
    const manifest = await this.readManifest(draftId, jobId);
    return manifest && publicManifest(manifest, await this.sourceUses(draftId, manifest.sourceId));
  }

  async list(draftId) {
    await this.recover();
    if (!UUID_PATTERN.test(draftId)) return [];
    const manifests = [];
    for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
      const manifest = await this.readManifest(draftId, jobId).catch(() => null);
      if (manifest) manifests.push(publicManifest(manifest, await this.sourceUses(draftId, manifest.sourceId)));
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async draftIds() {
    await this.recover();
    return listDirs(this.rootDir);
  }

  async asset(draftId, jobId, name) {
    await this.recover();
    const raw = await this.readManifest(draftId, jobId);
    const manifest = raw && publicManifest(raw, await this.sourceUses(draftId, raw.sourceId));
    if (manifest?.status !== 'ready' || !Object.hasOwn(OUTPUTS, name)) return null;
    // Derived pixels and surfaces reproduce the blocked transform's scene.
    if (manifest.usageBlocked) {
      throw new RequestError(409, manifest.blockedReason === 'source' ? SOURCE_BLOCKED_MESSAGE : issueMessage(dependencyIssue(raw, currentDependencies(raw))));
    }
    const entry = manifest.derivedAssets.find((item) => item.name === name);
    return entry ? { ...entry, file: path.join(this.jobDir(draftId, jobId), 'assets', name) } : null;
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
    const bytes = asset && (await readFile(asset.file));
    if (!bytes || sha256(bytes) !== source.sha256) {
      throw new RequestError(409, 'The saved photo no longer matches its recorded checksum, so it cannot be used.');
    }
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
    await this.recover();
    if (!UUID_PATTERN.test(draftId)) throw new RequestError(404, 'This memory could not be found.');
    const accepted = await this.serialize(async () => {
      const existing = await this.findRequest(request.requestId);
      if (existing) {
        const sameSelection = request.objects
          ? sameValues(existing.objects?.map(({ id, label, box }) => ({ id, label, box })), request.objects)
          : !existing.objects && sameValues(existing.box, request.box);
        if (existing.draftId !== draftId || existing.sourceId !== request.sourceId || !sameSelection) {
          throw new RequestError(409, 'This build request was already used for a different photo or box.');
        }
        return { manifest: existing, start: false };
      }
      const { source, imagePath, size } = await this.verifiedOriginal(draftId, request.sourceId);
      for (const [, , x2, y2] of request.objects ? request.objects.map((item) => item.box) : [request.box]) {
        if (x2 > size.width || y2 > size.height) {
          throw new RequestError(400, `The selected box must stay inside the photo (${size.width} x ${size.height} pixels).`);
        }
      }
      if (this.closed) throw new RequestError(503, 'The app is shutting down. Try again later.');
      if (this.active) throw new RequestError(409, 'Another scene is being built right now. Try again when it finishes.');

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
    return publicManifest(accepted.manifest, await this.sourceUses(draftId, accepted.manifest.sourceId));
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
      const permitted = () => this.sourceUses(manifest.draftId, manifest.sourceId).then((uses) => uses.model);
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
      await rm(staging, { recursive: true, force: true }).catch(() => {});
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
        return { version: previous.version, offset: previous.offset, yaw: previous.yaw };
      }
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
      await this.permittedPhoto(draftId, manifest.sourceId);
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before applying this edit.');
      }
      assertSceneUsable(manifest, 'place');
      const edit = { version: manifest.edit.version + 1, offset: request.offset, yaw: request.yaw };
      await this.saveVersion(manifest, edit, { requestId: request.requestId, baseVersion: request.baseVersion, ...edit, dependencies: currentDependencies(manifest) });
      return edit;
    });
  }

  // Callers hold the mutex. Common checks before a new two-object version.
  async #objectVersionAllowed(manifest, baseVersion) {
    if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
    await this.permittedPhoto(manifest.draftId, manifest.sourceId);
    if (baseVersion !== manifest.edit.version) {
      throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before applying this edit.');
    }
    assertSceneUsable(manifest, 'place');
    assertObjectsConfirmed(manifest);
  }

  // Moves or turns one object. The server starts from the whole saved
  // arrangement, so the other object and the rule cannot be changed here.
  async #editObject(manifest, request) {
    const previous = manifest.edits.find((item) => item.requestId === request.requestId);
    if (previous) {
      const same = previous.kind === 'manual' && previous.baseVersion === request.baseVersion && previous.targetId === request.targetId
        && sameValues(previous.request, { offset: request.offset, yaw: request.yaw });
      if (!same) throw new RequestError(409, 'This edit request was already used with different values.');
      assertReplayUsable(manifest, previous.version);
      return { version: previous.version, ...arrangementOf(previous) };
    }
    await this.#objectVersionAllowed(manifest, request.baseVersion);
    const arrangement = withTarget(arrangementOf(manifest.edit), request.targetId, request);
    assertRelationship(manifest, arrangement);
    const edit = { version: manifest.edit.version + 1, ...arrangement };
    await this.saveVersion(manifest, edit, {
      requestId: request.requestId, kind: 'manual', targetId: request.targetId, request: { offset: request.offset, yaw: request.yaw },
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
      const request = parseRelationshipRequest(body);
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if (previous.kind !== 'relationship' || previous.baseVersion !== request.baseVersion || !sameValues(previous.relationship, request.relationship)) {
          throw new RequestError(409, 'This request was already used with different values.');
        }
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
      const { requestId } = parseConfirmRequest(body);
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be confirmed.');
      await this.permittedPhoto(draftId, manifest.sourceId);
      let current = manifest;
      if (!manifest.objectsConfirmed) {
        if (!(await this.sourceUses(draftId, manifest.sourceId)).place) throw new RequestError(403, SOURCE_BLOCKED_MESSAGE);
        current = await this.update(manifest, { objectsConfirmed: { requestId, confirmedAt: new Date().toISOString() } });
      }
      const { objects, objectsConfirmed } = publicManifest(current, await this.sourceUses(draftId, manifest.sourceId));
      return { objects, objectsConfirmed };
    });
  }

  // One manifest write holds the new transform, its request receipt and every
  // proposal status change, so no partial apply can be observed or persisted.
  // Every receipt names the contributions its transform depends on.
  // Every new main version passes the visible-surface gate before anything is written.
  async saveVersion(manifest, edit, receipt, proposals = manifest.proposals ?? [], extra = {}) {
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
    if (!entry || !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > OUTPUTS['surface.json'].maxBytes) return null;
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
    return this.projectProposals(manifest, [...(manifest.proposals ?? [])].reverse());
  }

  // Every proposal leaving the server: a photo without place use hides the
  // message and plan of every proposal of its scenes; disk records stay intact.
  async projectProposals(manifest, proposals) {
    const { place } = await this.sourceUses(manifest.draftId, manifest.sourceId);
    return proposals.map((item) => (place ? projectProposal(manifest, item) : {
      ...item, statement: { ...item.statement, text: null }, result: null, question: null, status: 'stale', error: SOURCE_REDACTED_PROPOSAL, redacted: true,
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
    const manifest = await this.editableScene(draftId, jobId);
    // Owner-only audit: whether restoring each version is still allowed.
    const { place } = await this.sourceUses(draftId, manifest.sourceId);
    return editHistory(manifest).map((entry) => {
      const dependencies = versionDependencies(manifest, entry.version);
      return { ...entry, dependencies: [...dependencies], blocked: !place || dependenciesBlocked(manifest, dependencies) };
    });
  }

  async createProposal(draftId, jobId, body) {
    await this.recover();
    const accepted = await this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      const twoObjects = isTwoObject(manifest);
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
      const now = new Date().toISOString();
      const proposal = newProposal({ id: randomUUID(), statementId: randomUUID(), now, ...request, targetId: request.targetId ?? null });
      const stored = await this.update(manifest, { proposals: [...proposals, proposal] });
      // close() may have started while the record was being written; never start a call after it.
      if (this.closed) {
        const interrupted = { ...proposal, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
        await this.update(stored, { proposals: [...proposals, interrupted] });
        return { proposal: interrupted, start: false };
      }
      this.activeProposal = { id: proposal.id, draftId, jobId, sourceId: manifest.sourceId, controller: new AbortController(), done: null };
      // For two objects the model sees the selected object's box and transform,
      // plus the whole arrangement as context; it may change only that object.
      const target = twoObjects ? manifest.objects.find((item) => item.id === request.targetId) : null;
      const box = target ? target.box : manifest.box;
      const [x1, y1, x2, y2] = box;
      const selection = [x1 / size.width, y1 / size.height, x2 / size.width, y2 / size.height];
      const targetSaved = target && manifest.edit.objects.find((item) => item.id === target.id);
      const saved = targetSaved ? { offset: [...targetSaved.offset], yaw: targetSaved.yaw } : manifest.edit;
      return { proposal, start: true, imagePath, selection, box, sourceId: manifest.sourceId, saved, context: twoObjects ? modelContext(manifest, request.targetId) : null };
    });
    if (accepted.start) this.activeProposal.done = this.runProposal(draftId, jobId, accepted);
    return accepted.proposal;
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
  async runProposal(draftId, jobId, { proposal, imagePath, selection, box, sourceId, saved, context }) {
    const { controller } = this.activeProposal;
    const { signal } = controller;
    const finish = (changes) => this.serialize(() => this.changeProposal(draftId, jobId, proposal.id, (current) => (current.status === 'processing' ? changes : null)));
    try {
      const modelAllowed = () => this.sourceUses(draftId, sourceId).then((uses) => uses.model);
      // Grants are checked again at dispatch: a withdrawal may have arrived since creation.
      const started = await this.serialize(async () => { const allowed = await modelAllowed(); return this.changeProposal(draftId, jobId, proposal.id, (current, manifest) => {
        if (current.status !== 'queued') return null;
        if (!allowed) return { status: 'failed', error: PROPOSAL_MESSAGES.restricted };
        const issue = dependencyIssue(manifest, currentDependencies(manifest), 'model');
        if (issue) return { status: 'failed', error: issueMessage(issue) };
        return { status: 'processing' };
      }); });
      if (started.status !== 'processing') return;
      const surface = JSON.parse(await readFile(path.join(this.jobDir(draftId, jobId), 'assets', 'surface.json'), 'utf8'));
      let image;
      try {
        image = await this.prepareImage({ imagePath, box, signal });
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
        const issue = dependencyIssue(manifest, currentDependencies(manifest), 'model');
        if (issue) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'failed', error: issueMessage(issue) }));
          return null;
        }
        // Each outbound request the model makes is admitted here, under the
        // same mutex as restrictions, withdrawals and cancellations.
        const admit = (start) => this.serialize(async () => {
          if (signal.aborted || this.closed || !(await modelAllowed())) return null;
          const scene = await this.editableScene(draftId, jobId);
          const now = (scene.proposals ?? []).find((item) => item.id === proposal.id);
          if (now?.status !== 'processing' || dependencyIssue(scene, currentDependencies(scene), 'model')) return null;
          return { value: start() };
        });
        return { call: this.proposalModel({ text: proposal.statement.text, image, selection, sourceId, baseVersion: proposal.baseVersion, saved, signal, admit, ...context }) };
      });
      if (!dispatched) return;
      const outcome = await dispatched.call;
      await this.serialize(async () => { const allowed = await modelAllowed(); return this.changeProposal(draftId, jobId, proposal.id, async (current, manifest) => {
        const record = { model: outcome?.model ?? null, usage: outcome?.usage ?? null, responseId: outcome?.responseId ?? null };
        // A canceled or stale proposal keeps its status; only what was spent is recorded.
        if (current.status !== 'processing') return record;
        // A restriction saved while the call ran: usage is kept, no result is offered.
        if (!allowed) return { ...record, status: 'failed', error: PROPOSAL_MESSAGES.restricted };
        // Still processing after an abort means shutdown: a late success is not offered.
        if (signal.aborted || this.closed) return { ...record, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
        if (manifest.edit.version !== current.baseVersion) return { ...record, status: 'stale' };
        const issue = dependencyIssue(manifest, currentDependencies(manifest), 'model');
        if (issue) return { ...record, status: 'failed', error: issueMessage(issue) };
        if (!outcome?.ok) {
          return { ...record, status: 'failed', error: PROPOSAL_MESSAGES[outcome?.reason] ?? PROPOSAL_MESSAGES.provider };
        }
        const twoObjects = isTwoObject(manifest);
        const targetSaved = twoObjects ? manifest.edit.objects.find((item) => item.id === current.targetId) : manifest.edit;
        const checked = validatePlan(outcome.plan, {
          sourceId, baseVersion: current.baseVersion, saved: targetSaved, surface, ...(twoObjects && { targetId: current.targetId }),
        });
        if (checked.error) {
          console.error(`proposal ${current.id} plan rejected: ${checked.code}`);
          return { ...record, status: 'failed', error: checked.error };
        }
        const { result } = checked;
        if (result.action === 'clarify') return { ...record, status: 'clarify', result, question: result.question };
        // The candidate is merged into the whole arrangement and must keep its rule.
        if (twoObjects) {
          const arrangement = withTarget(arrangementOf(manifest.edit), current.targetId, result.transform);
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
        return { ...record, status: 'ready', result };
      }); });
    } catch (error) {
      console.error(`proposal ${proposal.id} failed: ${error?.code ?? error?.name ?? 'error'}`);
      await finish({ status: 'failed', error: PROPOSAL_MESSAGES.unknown }).catch(() => {});
    } finally {
      this.activeProposal = null;
    }
  }

  async cancelProposal(draftId, jobId, proposalId) {
    await this.recover();
    return this.serialize(async () => {
      const proposal = await this.changeProposal(draftId, jobId, proposalId, (current) => {
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
      const proposals = manifest.proposals ?? [];
      const proposal = proposals.find((item) => item.id === proposalId);
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
      await this.permittedPhoto(draftId, manifest.sourceId);
      if (proposal.status === 'applied') throw new RequestError(409, 'This proposal was already applied.');
      if (proposal.status === 'stale' || (proposal.status === 'ready' && proposal.baseVersion !== manifest.edit.version)) {
        throw new RequestError(409, 'The scene changed after this proposal was made. Ask for a new proposal.');
      }
      if (proposal.status !== 'ready') throw new RequestError(409, 'Only a ready proposal can be applied.');
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before applying this proposal.');
      }
      if (proposal.result.action === 'face_anchor' && request.frontConfirmed !== true) {
        throw new RequestError(409, 'Confirm that the visible side of the object is its front before applying this turn.');
      }
      assertSceneUsable(manifest, 'model');
      assertObjectsConfirmed(manifest);
      const { offset, yaw } = proposal.result.transform;
      let edit;
      if (isTwoObject(manifest)) {
        const arrangement = withTarget(arrangementOf(manifest.edit), proposal.targetId, { offset, yaw });
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
      const twoObjects = isTwoObject(manifest);
      const request = parseUndoRequest(body, { twoObjects });
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
      await this.permittedPhoto(draftId, manifest.sourceId);
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

  // Local current uses of a source: scenes built from it, live shared
  // snapshots of those scenes, and model work still running for them.
  // Counts saved uses of a photo or recording: a scene built from the photo,
  // its stories, and stories that use the recording. Each snapshot counts once.
  async sourceImpacts(draftId, sourceId) {
    const impacts = { scenes: 0, stories: 0, snapshots: 0, processing: 0 };
    if (!UUID_PATTERN.test(draftId)) return impacts;
    const now = Date.now();
    for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
      const manifest = await this.readManifest(draftId, jobId).catch(() => null);
      if (!manifest) continue;
      const photo = manifest.sourceId === sourceId;
      const storyIds = (manifest.stories?.items ?? [])
        .filter((story) => story.status === 'ready' && (photo || story.context.voice.sourceId === sourceId)).map((story) => story.id);
      if (!photo && storyIds.length === 0) continue;
      if (photo && manifest.status === 'ready') impacts.scenes += 1;
      if (photo && (manifest.status === 'queued' || manifest.status === 'processing')) impacts.processing += 1;
      if (photo) impacts.processing += (manifest.proposals ?? []).filter((item) => ACTIVE_PROPOSAL.has(item.status)).length;
      impacts.stories += storyIds.length;
      impacts.snapshots += (manifest.shares?.snapshots ?? []).filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > now
        && (photo || (item.frozen.stories ?? []).some((pinned) => storyIds.includes(pinned.storyId)))).length;
    }
    if (this.activeStory?.draftId === draftId && this.activeStory.sourceIds.includes(sourceId)) impacts.processing += 1;
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
      // Model work needs the model use; a story decode is local and needs only
      // the place use, so a model- or share-only reduction leaves it running.
      const work = [[this.active, 'model'], [this.activeProposal, 'model'], [this.activeStory, 'place']];
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

  // Stops the active worker; its job is recorded as interrupted, never ready.
  // Waits for queued manifest work, so a proposal accepted during shutdown is
  // recorded as interrupted rather than started.
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    this.activeProposal?.controller.abort();
    this.activeStory?.controller.abort();
    this.activeContributionMedia?.controller.abort();
    await this.serialize(() => {});
    await Promise.all([this.active?.done, this.activeProposal?.done, this.activeStory?.done, this.activeContributionMedia?.done]);
  }
}
