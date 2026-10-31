import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCKED_MESSAGE, MODEL_BLOCKED_MESSAGE, assertSceneUsable, projectProposal, currentDependencies, dependenciesBlocked, dependencyIssue, modelBlocked, usageBlocked, versionDependencies,
} from './collaboration.mjs';
import { RequestError } from './drafts.mjs';
import {
  ACTIVE_PROPOSAL, PROPOSAL_MESSAGES, editHistory, newProposal, pythonImagePreparer, staleProposals, validatePlan,
} from './memory-proposals.mjs';
import { canUseSource, sha256 } from './sources.mjs';

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
  return ({ imagePath, outputDir, sourceId, box, signal }) =>
    new Promise((resolve) => {
      const env = workerEnv();
      const args = [path.join(SPATIAL_DIR, 'reconstruct.py'), '--image', imagePath, '--output', outputDir, '--source-id', sourceId, '--box', ...box.map(String)];
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

export function parseBuildRequest(body) {
  if (!exactKeys(body, ['requestId', 'sourceId', 'box'])) throw new RequestError(400, 'The build request could not be read.');
  const { requestId, sourceId, box } = body;
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId) || typeof sourceId !== 'string' || !UUID_PATTERN.test(sourceId)) {
    throw new RequestError(400, 'The build request could not be read.');
  }
  if (!Array.isArray(box) || box.length !== 4 || !box.every(finite)) throw new RequestError(400, 'The selected box could not be read.');
  const [x1, y1, x2, y2] = box;
  if (x1 < 0 || y1 < 0 || !(x2 > x1) || !(y2 > y1)) throw new RequestError(400, 'The selected box must have a size and start inside the photo.');
  return { requestId, sourceId, box: [x1, y1, x2, y2] };
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

// Internal request, collaboration and share records stay on disk; clients see
// the manifest contract plus whether withdrawn or ungranted contributions block use.
export function publicManifest(manifest) {
  const { edits, proposals, collaboration, shares, ...rest } = manifest;
  return { ...rest, usageBlocked: usageBlocked(manifest), modelBlocked: modelBlocked(manifest) };
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
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
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

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (bytes, signature) => signature.every((value, index) => bytes[index] === value);

export class ReconstructionStore {
  constructor({ dataDir, drafts, runner, timeoutMs = RECONSTRUCTION_TIMEOUT_MS, proposalModel = null, prepareImage = pythonModelImage() }) {
    this.drafts = drafts;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.proposalModel = proposalModel;
    this.prepareImage = prepareImage;
    this.activeProposal = null;
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
          const file = path.join(this.jobDir(draftId, jobId), 'manifest.json');
          const manifest = await readJson(file).catch(() => null);
          if (!manifest) continue;
          const now = new Date().toISOString();
          const unfinished = (manifest.proposals ?? []).some((item) => ACTIVE_PROPOSAL.has(item.status));
          const changes = {};
          if (manifest.status === 'queued' || manifest.status === 'processing') Object.assign(changes, { status: 'interrupted', error: MESSAGES.interrupted });
          // Saved geometry is untouched; any usage of a sent request stays in the budget ledger.
          if (unfinished) {
            changes.proposals = manifest.proposals.map((item) =>
              ACTIVE_PROPOSAL.has(item.status) ? { ...item, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted, updatedAt: now } : item);
          }
          if (Object.keys(changes).length > 0) await writeJsonAtomic(file, { ...manifest, ...changes, updatedAt: now });
        }
      }
      await rm(this.stagingDir, { recursive: true, force: true });
    });
    return this.recovered;
  }

  async readManifest(draftId, jobId) {
    if (!UUID_PATTERN.test(draftId) || !UUID_PATTERN.test(jobId)) return null;
    return readJson(path.join(this.jobDir(draftId, jobId), 'manifest.json'));
  }

  async get(draftId, jobId) {
    await this.recover();
    const manifest = await this.readManifest(draftId, jobId);
    return manifest && publicManifest(manifest);
  }

  async list(draftId) {
    await this.recover();
    if (!UUID_PATTERN.test(draftId)) return [];
    const manifests = [];
    for (const jobId of await listDirs(path.join(this.rootDir, draftId))) {
      const manifest = await this.readManifest(draftId, jobId).catch(() => null);
      if (manifest) manifests.push(publicManifest(manifest));
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async draftIds() {
    await this.recover();
    return listDirs(this.rootDir);
  }

  async asset(draftId, jobId, name) {
    const manifest = await this.get(draftId, jobId);
    if (manifest?.status !== 'ready' || !Object.hasOwn(OUTPUTS, name)) return null;
    // Derived pixels and surfaces reproduce the blocked transform's scene.
    if (manifest.usageBlocked) throw new RequestError(409, BLOCKED_MESSAGE);
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

  async permittedPhoto(draftId, sourceId) {
    const draft = await this.drafts.get(draftId);
    if (!draft) throw new RequestError(404, 'This memory could not be found.');
    if (!Array.isArray(draft.sources)) {
      throw new RequestError(403, 'This memory was saved before source details existed, so no permission to build a scene was recorded.');
    }
    const source = draft.sources.find((item) => item.id === sourceId);
    if (!source) throw new RequestError(404, 'This photo could not be found in the memory.');
    if (source.kind !== 'photo') throw new RequestError(400, 'Only a photo can be used to build a scene.');
    if (!canUseSource(draft, sourceId, 'place') || !canUseSource(draft, sourceId, 'model')) {
      throw new RequestError(403, 'This photo was not saved with permission for both place building and model processing.');
    }
    return { draft, source };
  }

  // A permitted photo whose stored bytes still match the recorded checksum,
  // with its size in stored pixel order (EXIF orientation is not applied).
  async verifiedOriginal(draftId, sourceId) {
    const { source } = await this.permittedPhoto(draftId, sourceId);
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
        if (existing.draftId !== draftId || existing.sourceId !== request.sourceId || !sameValues(existing.box, request.box)) {
          throw new RequestError(409, 'This build request was already used for a different photo or box.');
        }
        return { manifest: existing, start: false };
      }
      const { source, imagePath, size } = await this.verifiedOriginal(draftId, request.sourceId);
      const [, , x2, y2] = request.box;
      if (x2 > size.width || y2 > size.height) {
        throw new RequestError(400, `The selected box must stay inside the photo (${size.width} x ${size.height} pixels).`);
      }
      if (this.closed) throw new RequestError(503, 'The app is shutting down. Try again later.');
      if (this.active) throw new RequestError(409, 'Another scene is being built right now. Try again when it finishes.');

      const now = new Date().toISOString();
      const manifest = {
        id: randomUUID(),
        draftId,
        sourceId: request.sourceId,
        sourceSha256: source.sha256,
        box: request.box,
        requestId: request.requestId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        error: null,
        derivedAssets: [],
        edit: { version: 1, offset: [0, 0, 0], yaw: 0 },
        edits: [],
      };
      await mkdir(this.jobDir(draftId, manifest.id), { recursive: true });
      await writeJsonAtomic(path.join(this.jobDir(draftId, manifest.id), 'manifest.json'), manifest);
      this.active = { id: manifest.id, controller: new AbortController(), done: null };
      return { manifest, start: true, imagePath, size };
    });
    if (accepted.start) {
      this.active.done = this.run(accepted.manifest, accepted.imagePath, accepted.size);
    }
    return publicManifest(accepted.manifest);
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
      manifest = await this.serialize(() => this.update(manifest, { status: 'processing' }));
      await mkdir(staging, { recursive: true });
      const stopped = () => {
        const error = timedOut ? MESSAGES.timeout : MESSAGES.interrupted;
        return this.update(manifest, { status: timedOut ? 'failed' : 'interrupted', error });
      };
      // A runner that ignores the signal is not awaited; its late result is discarded.
      const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
      const running = Promise.resolve()
        .then(() => this.runner({ imagePath, outputDir, sourceId: manifest.sourceId, box: manifest.box, signal: controller.signal }))
        .catch((error) => ({ exitCode: null, stderr: '', spawnError: error?.code }));
      const result = controller.signal.aborted ? null : await Promise.race([running, aborted]);
      if (controller.signal.aborted) {
        manifest = await this.serialize(stopped);
        return;
      }
      if (result?.exitCode !== 0) {
        logFailure(manifest.id, result ?? {});
        manifest = await this.serialize(() => this.update(manifest, { status: 'failed', error: failureMessage(result ?? {}) }));
        return;
      }
      const derivedAssets = await this.verifyOutputs(outputDir, manifest, size);
      if (!derivedAssets) {
        manifest = await this.serialize(() => (controller.signal.aborted ? stopped() : this.update(manifest, { status: 'failed', error: MESSAGES.invalidOutput })));
        return;
      }
      manifest = await this.serialize(async () => {
        if (controller.signal.aborted) return stopped();
        const assetsDir = path.join(this.jobDir(manifest.draftId, manifest.id), 'assets');
        await rename(outputDir, assetsDir);
        // Commit boundary: an abort seen here unpublishes the outputs. Once the
        // ready manifest write starts, nothing else rewrites this job's status.
        if (controller.signal.aborted) {
          await rm(assetsDir, { recursive: true, force: true });
          return stopped();
        }
        return this.update(manifest, { status: 'ready', derivedAssets });
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
    const expected = { ...size, sourceId: manifest.sourceId, sourceSha256: manifest.sourceSha256, box: manifest.box, textureSha256: sha256(files['texture.jpg']) };
    if (!checkSurface(surface, summary, expected)) return null;
    return Object.keys(OUTPUTS).map((name) => ({
      name,
      type: OUTPUTS[name].type,
      size: files[name].length,
      sha256: sha256(files[name]),
      parentSourceId: manifest.sourceId,
      role: 'derived',
    }));
  }

  async edit(draftId, jobId, request) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.readManifest(draftId, jobId);
      if (!manifest) throw new RequestError(404, 'This scene could not be found.');
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if ((previous.kind ?? 'manual') !== 'manual' || previous.baseVersion !== request.baseVersion || !sameValues(previous.offset, request.offset) || previous.yaw !== request.yaw) {
          throw new RequestError(409, 'This edit request was already used with different values.');
        }
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

  // One manifest write holds the new transform, its request receipt and every
  // proposal status change, so no partial apply can be observed or persisted.
  // Every receipt names the contributions its transform depends on.
  saveVersion(manifest, edit, receipt, proposals = manifest.proposals ?? [], extra = {}) {
    const changes = { ...extra, edit, edits: [...manifest.edits, receipt] };
    if (manifest.proposals || proposals.length > 0) changes.proposals = staleProposals(proposals, edit.version, new Date().toISOString());
    return this.update(manifest, changes);
  }

  async editableScene(draftId, jobId) {
    const manifest = await this.readManifest(draftId, jobId);
    if (!manifest) throw new RequestError(404, 'This scene could not be found.');
    return manifest;
  }

  async proposals(draftId, jobId) {
    await this.recover();
    const manifest = await this.editableScene(draftId, jobId);
    return [...(manifest.proposals ?? [])].reverse().map((item) => projectProposal(manifest, item));
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
    return editHistory(manifest).map((entry) => ({ ...entry, blocked: dependenciesBlocked(manifest, versionDependencies(manifest, entry.version)) }));
  }

  async createProposal(draftId, jobId, request) {
    await this.recover();
    const accepted = await this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      const proposals = manifest.proposals ?? [];
      const existing = proposals.find((item) => item.requestId === request.requestId);
      if (existing) {
        if (existing.baseVersion !== request.baseVersion || existing.statement.text !== request.text) {
          throw new RequestError(409, 'This proposal request was already used with a different message or version.');
        }
        return { proposal: projectProposal(manifest, existing), start: false };
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
      if (!this.proposalModel) throw new RequestError(503, 'Memory-based editing with the hosted model is not set up on this computer.');
      if (this.closed) throw new RequestError(503, 'The app is shutting down. Try again later.');
      if (this.activeProposal) throw new RequestError(409, 'Another proposal is being prepared right now. Try again when it finishes.');
      const now = new Date().toISOString();
      const proposal = newProposal({ id: randomUUID(), statementId: randomUUID(), now, ...request });
      const stored = await this.update(manifest, { proposals: [...proposals, proposal] });
      // close() may have started while the record was being written; never start a call after it.
      if (this.closed) {
        const interrupted = { ...proposal, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
        await this.update(stored, { proposals: [...proposals, interrupted] });
        return { proposal: interrupted, start: false };
      }
      this.activeProposal = { id: proposal.id, controller: new AbortController(), done: null };
      const [x1, y1, x2, y2] = manifest.box;
      const selection = [x1 / size.width, y1 / size.height, x2 / size.width, y2 / size.height];
      return { proposal, start: true, imagePath, selection, box: manifest.box, sourceId: manifest.sourceId, saved: manifest.edit };
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
    const changes = change(current, manifest);
    if (!changes) return current;
    const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
    await this.update(manifest, { proposals: proposals.map((item) => (item.id === proposalId ? next : item)) });
    return next;
  }

  // The model runs outside the manifest mutex. Its result is committed only if
  // the proposal is still processing and the saved version is unchanged.
  async runProposal(draftId, jobId, { proposal, imagePath, selection, box, sourceId, saved }) {
    const { controller } = this.activeProposal;
    const { signal } = controller;
    const finish = (changes) => this.serialize(() => this.changeProposal(draftId, jobId, proposal.id, (current) => (current.status === 'processing' ? changes : null)));
    try {
      // Grants are checked again at dispatch: a withdrawal may have arrived since creation.
      const started = await this.serialize(() => this.changeProposal(draftId, jobId, proposal.id, (current, manifest) => {
        if (current.status !== 'queued') return null;
        const issue = dependencyIssue(manifest, currentDependencies(manifest), 'model');
        if (issue) return { status: 'failed', error: issue === 'model' ? MODEL_BLOCKED_MESSAGE : BLOCKED_MESSAGE };
        return { status: 'processing' };
      }));
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
        if (signal.aborted || this.closed) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted }));
          return null;
        }
        const issue = dependencyIssue(manifest, currentDependencies(manifest), 'model');
        if (issue) {
          await this.changeProposal(draftId, jobId, proposal.id, () => ({ status: 'failed', error: issue === 'model' ? MODEL_BLOCKED_MESSAGE : BLOCKED_MESSAGE }));
          return null;
        }
        return { call: this.proposalModel({ text: proposal.statement.text, image, selection, sourceId, baseVersion: proposal.baseVersion, saved, signal }) };
      });
      if (!dispatched) return;
      const outcome = await dispatched.call;
      await this.serialize(() => this.changeProposal(draftId, jobId, proposal.id, (current, manifest) => {
        const record = { model: outcome?.model ?? null, usage: outcome?.usage ?? null, responseId: outcome?.responseId ?? null };
        // A canceled or stale proposal keeps its status; only what was spent is recorded.
        if (current.status !== 'processing') return record;
        // Still processing after an abort means shutdown: a late success is not offered.
        if (signal.aborted || this.closed) return { ...record, status: 'interrupted', error: PROPOSAL_MESSAGES.interrupted };
        if (manifest.edit.version !== current.baseVersion) return { ...record, status: 'stale' };
        const issue = dependencyIssue(manifest, currentDependencies(manifest), 'model');
        if (issue) return { ...record, status: 'failed', error: issue === 'model' ? MODEL_BLOCKED_MESSAGE : BLOCKED_MESSAGE };
        if (!outcome?.ok) {
          return { ...record, status: 'failed', error: PROPOSAL_MESSAGES[outcome?.reason] ?? PROPOSAL_MESSAGES.provider };
        }
        const checked = validatePlan(outcome.plan, { sourceId, baseVersion: current.baseVersion, saved: manifest.edit, surface });
        if (checked.error) {
          console.error(`proposal ${current.id} plan rejected: ${checked.code}`);
          return { ...record, status: 'failed', error: checked.error };
        }
        const { result } = checked;
        if (result.action === 'clarify') return { ...record, status: 'clarify', result, question: result.question };
        return { ...record, status: 'ready', result };
      }));
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
      return projectProposal(await this.editableScene(draftId, jobId), proposal);
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
        return { edit: { version: previous.version, offset: previous.offset, yaw: previous.yaw }, proposal: projectProposal(manifest, proposal) };
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
      const { offset, yaw } = proposal.result.transform;
      const edit = { version: manifest.edit.version + 1, offset: [...offset], yaw };
      const applied = { ...proposal, status: 'applied', appliedVersion: edit.version, updatedAt: new Date().toISOString() };
      const receipt = {
        requestId: request.requestId, kind: 'proposal', proposalId, frontConfirmed: request.frontConfirmed, baseVersion: request.baseVersion, ...edit,
        dependencies: currentDependencies(manifest),
      };
      await this.saveVersion(manifest, edit, receipt, proposals.map((item) => (item.id === proposalId ? applied : item)));
      return { edit, proposal: applied };
    });
  }

  async undo(draftId, jobId, request) {
    await this.recover();
    return this.serialize(async () => {
      const manifest = await this.editableScene(draftId, jobId);
      const previous = manifest.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if (previous.kind !== 'undo' || previous.baseVersion !== request.baseVersion || previous.targetVersion !== request.targetVersion) {
          throw new RequestError(409, 'This undo request was already used with different values.');
        }
        return { version: previous.version, offset: previous.offset, yaw: previous.yaw };
      }
      if (manifest.status !== 'ready') throw new RequestError(409, 'Only a finished scene can be edited.');
      await this.permittedPhoto(draftId, manifest.sourceId);
      if (request.baseVersion !== manifest.edit.version) {
        throw new RequestError(409, 'The scene was changed elsewhere. Reload the saved version before undoing.');
      }
      const target = editHistory(manifest).find((item) => item.version === request.targetVersion);
      if (!target || target.version >= manifest.edit.version) throw new RequestError(409, 'Only an earlier saved version can be restored.');
      // Undo is the way out of a blocked scene, so it checks the target, not the current version.
      const dependencies = versionDependencies(manifest, target.version);
      if (dependenciesBlocked(manifest, dependencies)) throw new RequestError(409, 'That saved version depends on a withdrawn contribution and cannot be restored.');
      const edit = { version: manifest.edit.version + 1, offset: [...target.offset], yaw: target.yaw };
      await this.saveVersion(manifest, edit, { requestId: request.requestId, kind: 'undo', targetVersion: target.version, baseVersion: request.baseVersion, ...edit, dependencies });
      return edit;
    });
  }

  // Stops the active worker; its job is recorded as interrupted, never ready.
  // Waits for queued manifest work, so a proposal accepted during shutdown is
  // recorded as interrupted rather than started.
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    this.activeProposal?.controller.abort();
    await this.serialize(() => {});
    await Promise.all([this.active?.done, this.activeProposal?.done]);
  }
}
