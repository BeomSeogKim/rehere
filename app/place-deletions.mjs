import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from './drafts.mjs';
import { OUTPUTS } from './reconstructions.mjs';
import { PLAYBACK_NAME, REVIEW_NAME, VOICE_ORIGINAL_NAMES } from './contribution-photos.mjs';
import { MEMORY_LINKS_BYTES, MEMORY_LINKS_FILE, storedMemoryLinks, validMemoryLinks } from './memory-links.mjs';
import { geometrySources } from './geometry-sources.mjs';
import { COMPOSITION_OUTPUTS } from './composition-assets.mjs';

// Owner removal of one saved place from this app's tracked local storage.
// A permanent, content-free barrier in data/place-deletions/<draftId>.json is
// written first; every read and write of that place then treats it as absent.
// Cleanup removes only the app's own trees and server-generated names, never
// follows or removes links, special files or unexpected files, and marks the
// deletion complete only after absence is verified. This is file-system
// removal, not secure erasure, and covers no backups, logs, caches, downloads,
// operator copies or provider-side retention.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_BYTES = 1024 * 1024;
const JSON_BYTES = 64 * 1024 * 1024;
const isId = (value) => typeof value === 'string' && UUID.test(value);
const isSha = (value) => typeof value === 'string' && SHA256.test(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => new RequestError(status, message);

export const PLACE_DELETED = 'This place was deleted. Nothing was changed.';
const NOT_FOUND = 'This memory could not be found.';
const UNREVIEWABLE = 'This place cannot be reviewed for deletion right now. Nothing was changed.';
const UNAVAILABLE = 'Place deletion records are unavailable right now. Nothing was changed.';
const STALE = 'This place changed since it was reviewed. Review it again. Nothing was deleted.';
const REUSED = 'This request was already used with different values.';
const ALREADY = 'This place was already deleted by another request.';

export const INVENTORY_NUMBERS = Object.freeze([
  'photos', 'scenes', 'recordedStories', 'contributions', 'contributionProviders', 'visitorSnapshots', 'visitorPreviews',
  'linkedRegions', 'invitations', 'intakes', 'processing',
]);
// Schema 1 records (before written memory links) keep their exact 13-key
// inventory; schema 2 records, written by every new deletion, require the
// written memory link count too. A count is never synthesized for schema 1.
const INVENTORY_KEYS = [...INVENTORY_NUMBERS, 'writtenMemory', 'recording'];
const INVENTORY_KEYS_V2 = [...INVENTORY_KEYS, 'linkedMemories'];
const RECORD_KEYS = ['schemaVersion', 'draftId', 'requestId', 'impactSha256', 'state', 'requestedAt', 'completedAt', 'inventory', 'jobIds', 'intakeIds', 'retiredVerifiers', 'steps'];

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const validInventory = (inventory, schemaVersion) => exactKeys(inventory, schemaVersion === 2 ? INVENTORY_KEYS_V2 : INVENTORY_KEYS)
  && [...INVENTORY_NUMBERS, ...(schemaVersion === 2 ? ['linkedMemories'] : [])].every((key) => Number.isSafeInteger(inventory[key]) && inventory[key] >= 0)
  && typeof inventory.writtenMemory === 'boolean' && typeof inventory.recording === 'boolean';

// A canonical ISO timestamp, as written by toISOString().
const isTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// Fails closed on any inconsistency: a complete record needs every earlier
// step done and a completion time no earlier than its request.
function validRecord(record, draftId) {
  return exactKeys(record, RECORD_KEYS) && (record.schemaVersion === 1 || record.schemaVersion === 2) && record.draftId === draftId && isId(record.requestId)
    && isSha(record.impactSha256) && (record.state === 'access-stopped' || record.state === 'complete') && isTime(record.requestedAt)
    && (record.state === 'complete'
      ? isTime(record.completedAt) && Date.parse(record.completedAt) >= Date.parse(record.requestedAt)
        && record.steps?.intakesConsumed === true && record.steps?.invitationsRevoked === true
      : record.completedAt === null)
    && validInventory(record.inventory, record.schemaVersion)
    && Array.isArray(record.jobIds) && record.jobIds.every(isId) && Array.isArray(record.intakeIds) && record.intakeIds.every(isId)
    && Array.isArray(record.retiredVerifiers) && record.retiredVerifiers.every(isSha)
    && exactKeys(record.steps, ['intakesConsumed', 'invitationsRevoked'])
    && typeof record.steps.intakesConsumed === 'boolean' && typeof record.steps.invitationsRevoked === 'boolean';
}

export const publicRecord = (record) => ({
  draftId: record.draftId, requestId: record.requestId, impactSha256: record.impactSha256, state: record.state,
  requestedAt: record.requestedAt, completedAt: record.completedAt, inventory: { ...record.inventory },
});

// Reads at most `limit + 1` bytes through one handle; throws on any read error.
async function readCapped(file, limit, flags = 'r') {
  const handle = await open(file, flags);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw new Error('too large');
    return buffer.subarray(0, total);
  } finally {
    await handle.close().catch(() => {});
  }
}

// The barrier store and the one short shared commit section. The section
// runs one task at a time and is not re-entrant: a task only reads barriers
// and makes one awaited atomic publication. Lock order is always an existing
// store mutex (scene, intake or access) first, then this section; no store
// mutex is ever taken inside it and no task calls commit() again.
export class PlaceDeletions {
  constructor({ dataDir }) {
    this.dataDir = path.resolve(dataDir);
    this.dir = path.join(this.dataDir, 'place-deletions');
    this.queue = Promise.resolve();
  }

  commit(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  #file(draftId) {
    return path.join(this.dir, `${draftId}.json`);
  }

  // The stored record, null only when there is none (ENOENT). Anything else
  // unreadable or invalid throws: it is never treated as absent.
  async read(draftId) {
    if (!isId(draftId)) return null;
    let bytes;
    try {
      bytes = await readCapped(this.#file(draftId), RECORD_BYTES);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw fail(503, UNAVAILABLE);
    }
    let record = null;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch {
      record = null;
    }
    if (!validRecord(record, draftId)) throw fail(503, UNAVAILABLE);
    return record;
  }

  // Fails closed: any barrier, or an unreadable one, means deleted.
  async deleted(draftId) {
    if (!isId(draftId)) return false;
    try {
      return (await this.read(draftId)) !== null;
    } catch {
      return true;
    }
  }

  async write(record) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.#file(record.draftId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw fail(503, 'The deletion could not be recorded. Nothing was deleted.');
    }
    return record;
  }

  // Every record; any unreadable one throws, so nothing is decided from a partial list.
  async records() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw fail(503, UNAVAILABLE);
    }
    const records = [];
    for (const name of names) {
      const match = /^([0-9a-f-]{36})\.json$/.exec(name);
      if (!match) continue;
      if (!isId(match[1])) throw fail(503, UNAVAILABLE);
      records.push(await this.read(match[1]));
    }
    return records.filter(Boolean);
  }

  // True when a deleted place used this visitor-token verifier. Fails closed.
  async retired(tokenVerifier) {
    return (await this.records()).some((record) => record.retiredVerifiers.includes(tokenVerifier));
  }
}

// ---- Safe removal of exact app-owned trees ----

async function kind(target) {
  try {
    const info = await lstat(target);
    if (info.isDirectory()) return 'directory';
    return info.isFile() ? 'file' : 'other';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : null;
  }
}

// 'directory' when every component from rootDir down to target is a real
// directory, 'missing' when one does not exist, otherwise null.
async function folder(target, rootDir) {
  const relative = path.relative(rootDir, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  let current = rootDir;
  for (const part of ['', ...relative.split(path.sep)]) {
    current = path.join(current, part);
    const found = await kind(current);
    if (found !== 'directory') return found;
  }
  return 'directory';
}

// Removes `target` and everything below it that `allowed(parts, kind)` names.
// Unknown entries, links and special files stay; true only when target is
// verified absent afterwards. Never throws.
export async function removeTree(target, rootDir, allowed) {
  try {
    const found = await folder(target, rootDir);
    if (found === 'missing') return true;
    if (found !== 'directory') return false;
    const walk = async (dir, parts) => {
      let clean = true;
      for (const name of await readdir(dir)) {
        const child = path.join(dir, name);
        const childKind = await kind(child);
        const childParts = [...parts, name];
        if (childKind === 'directory' && allowed(childParts, 'directory')) {
          if (!(await walk(child, childParts))) clean = false;
        } else if (childKind === 'file' && allowed(childParts, 'file')) {
          try {
            await unlink(child);
          } catch (error) {
            if (error?.code !== 'ENOENT') clean = false;
          }
        } else if (childKind !== 'missing') {
          clean = false;
        }
      }
      if (!clean || (await readdir(dir)).length !== 0) return false;
      try {
        await rmdir(dir);
      } catch (error) {
        if (error?.code !== 'ENOENT') return false;
      }
      return (await kind(dir)) === 'missing';
    };
    return await walk(target, []);
  } catch {
    return false;
  }
}

// Removes the regular files directly in `dir` whose names match `pattern`;
// a matching link or special file stays. True only when no matching name
// remains (or dir is absent). Never throws.
export async function removeMatching(dir, rootDir, pattern) {
  try {
    const found = await folder(dir, rootDir);
    if (found === 'missing') return true;
    if (found !== 'directory') return false;
    for (const name of await readdir(dir)) {
      if (!pattern.test(name)) continue;
      if ((await kind(path.join(dir, name))) !== 'file') continue;
      try {
        await unlink(path.join(dir, name));
      } catch (error) {
        if (error?.code !== 'ENOENT') return false;
      }
    }
    return !(await readdir(dir)).some((name) => pattern.test(name));
  } catch {
    return false;
  }
}

const temp = (name) => new RegExp(`^${name.replace(/\./g, '\\.')}\\.${UUID_SOURCE}\\.tmp$`);
const DRAFT_FILES = [/^draft\.json$/, /^intake-receipt\.json$/, /^policy\.json$/, /^place\.json$/, temp('policy.json'), temp('place.json'),
  /^evidence-reviews\.json$/, temp('evidence-reviews.json'), /^photo-[1-9][0-9]?\.(jpg|png)$/, /^voice\.(webm|ogg|m4a)$/];
const MEDIA = new Set(['original.jpg', 'original.png', REVIEW_NAME, PLAYBACK_NAME, ...Object.values(VOICE_ORIGINAL_NAMES)]);
const JOB_FILES = [/^manifest\.json$/, /^region-links\.json$/, /^memory-links\.json$/, temp('manifest.json'), temp('region-links.json'), temp('memory-links.json')];
const WAV = new RegExp(`^${UUID_SOURCE}\\.wav$`);
const CONTRIBUTION_DIR = new RegExp(`^(${UUID_SOURCE}|\\.staging-${UUID_SOURCE}-${UUID_SOURCE})$`);
const PART_FILE = new RegExp(`^${UUID_SOURCE}(\\.bin|\\.${UUID_SOURCE}\\.tmp)$`);
const FULL_OUTLINE_STAGE = new RegExp(`^outline-${UUID_SOURCE}-${UUID_SOURCE}$`);

export const draftTree = (parts, type) => type === 'file' && parts.length === 1 && DRAFT_FILES.some((pattern) => pattern.test(parts[0]));

export function sceneTree(parts, type) {
  const [job, second, third, fourth, fifth, sixth] = parts;
  if (!isId(job)) return false;
  if (parts.length === 1) return type === 'directory';
  if (parts.length === 2) {
    if (type === 'file') return JOB_FILES.some((pattern) => pattern.test(second));
    return ['assets', 'stories', 'story-staging', 'contributions', 'full-object'].includes(second);
  }
  if (parts.length === 3) {
    if (second === 'assets') return type === 'file' && (Object.hasOwn(OUTPUTS, third) || Object.hasOwn(COMPOSITION_OUTPUTS, third));
    if (second === 'stories' || second === 'story-staging') return type === 'file' && WAV.test(third);
    if (second === 'contributions') return type === 'directory' && CONTRIBUTION_DIR.test(third);
    if (second === 'full-object') return type === 'directory' && (['outlines', 'builds'].includes(third) || FULL_OUTLINE_STAGE.test(third));
    return false;
  }
  if (second === 'full-object' && parts.length === 4) {
    if (FULL_OUTLINE_STAGE.test(third)) return type === 'file' && ['mask.png', 'outline.json'].includes(fourth);
    return type === 'directory' && ['outlines', 'builds'].includes(third) && isId(fourth);
  }
  if (second === 'full-object' && parts.length === 5 && isId(fourth)) {
    if (third === 'outlines') return type === 'file' && ['mask.png', 'outline.json'].includes(fifth);
    if (third === 'builds') return type === 'directory' ? fifth === 'output'
      : type === 'file' && (['build.json', 'object.glb'].includes(fifth) || temp('build.json').test(fifth));
  }
  if (second === 'full-object' && parts.length === 6 && third === 'builds' && isId(fourth) && fifth === 'output') {
    return type === 'file' && ['object.glb', 'object.json'].includes(sixth);
  }
  return parts.length === 4 && second === 'contributions' && type === 'file' && MEDIA.has(fourth);
}

export const stagingTree = (parts, type) => {
  if (parts[0] === 'child') {
    if (parts.length === 1) return type === 'directory';
    if (parts.length === 2) return type === 'directory' ? parts[1] === 'assets' : type === 'file' && (parts[1] === 'manifest.json' || temp('manifest.json').test(parts[1]));
    return parts.length === 3 && parts[1] === 'assets' && type === 'file' && Object.hasOwn(COMPOSITION_OUTPUTS, parts[2]);
  }
  return parts.length === 1 ? type === 'directory' && parts[0] === 'output'
    : parts.length === 2 && parts[0] === 'output' && type === 'file' && Object.hasOwn(OUTPUTS, parts[1]);
};

export const partsTree = (parts, type) => parts.length === 1 && type === 'file' && PART_FILE.test(parts[0]);
// A crash-left copy of an intake record, which can hold its text and metadata.
export const INTAKE_RECORD_TEMP = temp('intake.json');

// ---- The owner deletion flow ----

function parseDelete(body) {
  if (!exactKeys(body, ['requestId', 'impactSha256', 'confirmDeletion']) || !isId(body.requestId) || !isSha(body.impactSha256)) {
    throw fail(400, 'The deletion request could not be read.');
  }
  if (body.confirmDeletion !== true) throw fail(400, 'Confirm that this place should be deleted from this computer.');
  return { requestId: body.requestId, impactSha256: body.impactSha256 };
}

async function readJsonFile(file) {
  let bytes;
  try {
    bytes = await readCapped(file, JSON_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    throw fail(503, UNREVIEWABLE);
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), sha: sha256(bytes) };
  } catch {
    throw fail(503, UNREVIEWABLE);
  }
}

const list = (value) => (Array.isArray(value) ? value : null);

// Full-object records live beside the scene manifest. Bind accepted records
// into deletion review so a newly accepted outline or build makes it stale.
async function fullObjectRecords(jobDir, rootDir) {
  const base = path.join(jobDir, 'full-object');
  const found = await folder(base, rootDir);
  if (found === 'missing') return null;
  if (found !== 'directory') throw fail(503, UNREVIEWABLE);
  const entries = [];
  for (const [group, filename, limit] of [['outlines', 'outline.json', 32], ['builds', 'build.json', 16]]) {
    const directory = path.join(base, group), state = await folder(directory, rootDir);
    if (state === 'missing') continue;
    if (state !== 'directory') throw fail(503, UNREVIEWABLE);
    const ids = (await readdir(directory)).sort();
    if (ids.length > limit || !ids.every(isId)) throw fail(503, UNREVIEWABLE);
    for (const id of ids) {
      const recordDir = path.join(directory, id);
      if ((await folder(recordDir, rootDir)) !== 'directory') throw fail(503, UNREVIEWABLE);
      const file = path.join(recordDir, filename);
      try {
        if (!(await lstat(file)).isFile()) throw new Error('not a file');
        const bytes = await readCapped(file, 4 * 1024 * 1024, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (group === 'outlines' ? value.dto?.outlineId !== id : value.id !== id)) throw new Error('invalid record');
        entries.push([group, id, sha256(bytes)]);
      } catch { throw fail(503, UNREVIEWABLE); }
    }
  }
  return entries;
}

export class PlaceDeletionService {
  constructor({ dataDir, placeDeletions, reconstructions, intakes, accessStore }) {
    this.dataDir = path.resolve(dataDir);
    this.places = placeDeletions;
    this.reconstructions = reconstructions;
    this.intakes = intakes;
    this.access = accessStore;
    this.advancing = new Map();
    this.closed = false;
  }

  // Raw stored state of one place: inventory, impact and the scoped
  // identifiers. Callers hold the scene mutex and the shared section.
  // Permission projections are never used; anything that cannot be read
  // safely refuses the review instead of counting zero.
  async #review(draftId) {
    const draftDir = path.join(this.dataDir, 'drafts', draftId);
    const sceneDir = path.join(this.dataDir, 'reconstructions', draftId);
    const draftFolder = await folder(draftDir, this.dataDir);
    const sceneFolder = await folder(sceneDir, this.dataDir);
    const usable = (found) => found === 'directory' || found === 'missing';
    if (!usable(draftFolder) || !usable(sceneFolder)) throw fail(503, UNREVIEWABLE);
    const draftFile = draftFolder === 'directory' ? await readJsonFile(path.join(draftDir, 'draft.json')) : { missing: true };
    if (draftFile.missing) {
      if (sceneFolder === 'missing') throw fail(404, NOT_FOUND);
      throw fail(503, UNREVIEWABLE);
    }
    const draft = draftFile.value;
    if (draft?.id !== draftId || !list(draft.photos) || typeof draft.text !== 'string' || (draft.voice !== null && typeof draft.voice !== 'object')) {
      throw fail(503, UNREVIEWABLE);
    }
    const extra = {};
    for (const name of ['policy.json', 'place.json']) {
      const file = await readJsonFile(path.join(draftDir, name));
      extra[name] = file.missing ? null : file.sha;
    }

    const inventory = {
      photos: draft.photos.length, writtenMemory: draft.text !== '', recording: Boolean(draft.voice), scenes: 0, recordedStories: 0,
      contributions: 0, contributionProviders: 0, visitorSnapshots: 0, visitorPreviews: 0, linkedRegions: 0, invitations: 0, intakes: 0, processing: 0,
      linkedMemories: 0,
    };
    const providers = new Set();
    const jobs = [];
    const retiredVerifiers = [];
    const names = sceneFolder === 'directory' ? (await readdir(sceneDir)).filter(isId).sort() : [];
    for (const jobId of names) {
      const jobDir = path.join(sceneDir, jobId);
      if ((await folder(jobDir, this.dataDir)) !== 'directory') throw fail(503, UNREVIEWABLE);
      inventory.scenes += 1;
      const manifestFile = await readJsonFile(path.join(jobDir, 'manifest.json'));
      const linksFile = await readJsonFile(path.join(jobDir, 'region-links.json'));
      // A scene folder without its manifest cannot prove which link keys or
      // copied content it held: the review is refused, never counted as zero.
      if (manifestFile.missing) throw fail(503, UNREVIEWABLE);
      const manifest = manifestFile.value;
      {
        // Only a real scene record of this exact place and job is reviewed.
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.id !== jobId || manifest.draftId !== draftId
          || typeof manifest.status !== 'string' || typeof manifest.createdAt !== 'string') throw fail(503, UNREVIEWABLE);
        try {
          if (!geometrySources(manifest).every(({ sourceId }) => isId(sourceId))) throw new Error();
        } catch { throw fail(503, UNREVIEWABLE); }
        // Only an absent (legacy) container counts as empty. A present one must
        // be a plain object whose list holds records; anything else is refused.
        const records = (key, field) => {
          if (!Object.hasOwn(manifest, key)) return [];
          const container = manifest[key];
          if (container === null || typeof container !== 'object' || Array.isArray(container)) return null;
          const items = list(container[field]);
          return items && items.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item)) ? items : null;
        };
        const stories = records('stories', 'items');
        const contributions = records('collaboration', 'contributions');
        const snapshots = records('shares', 'snapshots');
        const previews = records('shares', 'previews');
        if (!stories || !contributions || !snapshots || !previews) throw fail(503, UNREVIEWABLE);
        inventory.recordedStories += stories.length;
        inventory.contributions += contributions.length;
        for (const item of contributions) if (item?.principalId) providers.add(item.principalId);
        inventory.visitorSnapshots += snapshots.length;
        inventory.visitorPreviews += previews.length;
        for (const snapshot of snapshots) {
          if (!isSha(snapshot?.tokenVerifier)) throw fail(503, UNREVIEWABLE);
          retiredVerifiers.push(snapshot.tokenVerifier);
        }
      }
      if (!linksFile.missing) {
        const objects = linksFile.value?.objects;
        if (objects === null || typeof objects !== 'object' || Array.isArray(objects)) throw fail(503, UNREVIEWABLE);
        for (const entry of Object.values(objects)) {
          if (!list(entry?.links)) throw fail(503, UNREVIEWABLE);
          inventory.linkedRegions += entry.links.length;
        }
      }
      // Written memory links: the exact bytes, read to their own cap and
      // validated strictly; anything else refuses the review.
      let memories = null;
      try {
        // A regular file only, never read through a link.
        const memoriesFile = path.join(jobDir, MEMORY_LINKS_FILE);
        if (!(await lstat(memoriesFile)).isFile()) throw fail(503, UNREVIEWABLE);
        const bytes = await readCapped(memoriesFile, MEMORY_LINKS_BYTES, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let state = null;
        try {
          state = JSON.parse(bytes.toString('utf8'));
        } catch {
          state = null;
        }
        if (!validMemoryLinks(state)) throw fail(503, UNREVIEWABLE);
        inventory.linkedMemories += storedMemoryLinks(state);
        memories = sha256(bytes);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw fail(503, UNREVIEWABLE);
      }
      const fullObjects = await fullObjectRecords(jobDir, this.dataDir);
      jobs.push({ id: jobId, manifest: manifestFile.sha, links: linksFile.missing ? null : linksFile.sha, memories,
        ...(fullObjects !== null && { fullObjects }) });
    }
    inventory.contributionProviders = providers.size;

    const intakeIds = [];
    const intakeShas = [];
    const intakesDir = path.join(this.dataDir, 'intakes');
    let intakeNames = [];
    try {
      intakeNames = (await readdir(intakesDir)).filter(isId).sort();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fail(503, UNREVIEWABLE);
    }
    for (const id of intakeNames) {
      const file = await readJsonFile(path.join(intakesDir, id, 'intake.json'));
      if (file.missing) continue;
      if (file.value === null || typeof file.value !== 'object') throw fail(503, UNREVIEWABLE);
      if (file.value.draftId !== draftId) continue;
      intakeIds.push(id);
      intakeShas.push([id, file.sha]);
    }
    inventory.intakes = intakeIds.length;

    const access = await readJsonFile(path.join(this.dataDir, 'access.json'));
    const invitations = access.missing ? [] : list(access.value?.invitations);
    if (!invitations) throw fail(503, UNREVIEWABLE);
    const scoped = invitations.filter((item) => item?.draftId === draftId).map((item) => [item.id, item.status]).sort();
    inventory.invitations = scoped.length;
    inventory.processing = this.reconstructions.placeOperations(draftId) + this.intakes.placeOperations(intakeIds);

    const impactSha256 = sha256(JSON.stringify({
      draftId, draft: draftFile.sha, policy: extra['policy.json'], place: extra['place.json'], jobs, intakes: intakeShas, invitations: scoped, inventory,
    }));
    return { inventory, impactSha256, jobIds: names, intakeIds, retiredVerifiers: [...new Set(retiredVerifiers)] };
  }

  // Under the scene mutex then the shared section, as for every barrier write.
  #authority(task) {
    return this.reconstructions.serialize(() => this.places.commit(task));
  }

  async state(draftId) {
    if (!isId(draftId)) throw fail(404, NOT_FOUND);
    const record = await this.places.read(draftId);
    if (record) return publicRecord(record);
    const review = await this.#authority(async () => {
      const again = await this.places.read(draftId);
      return again ? { record: again } : this.#review(draftId);
    });
    if (review.record) return publicRecord(review.record);
    return { draftId, state: 'present', impactSha256: review.impactSha256, inventory: review.inventory };
  }

  async pending() {
    return { items: (await this.places.records()).filter((record) => record.state === 'access-stopped').map(publicRecord) };
  }

  #sameRequest(record, request) {
    if (record.requestId === request.requestId && record.impactSha256 === request.impactSha256) return true;
    throw fail(409, record.requestId === request.requestId ? REUSED : ALREADY);
  }

  async #usedElsewhere(requestId, draftId) {
    return (await this.places.records()).some((record) => record.requestId === requestId && record.draftId !== draftId);
  }

  // Returns { status, record }: 202 while cleanup is pending, 200 once complete.
  async delete(draftId, body) {
    if (!isId(draftId)) throw fail(404, NOT_FOUND);
    const request = parseDelete(body);
    const existing = await this.places.read(draftId);
    if (existing) {
      this.#sameRequest(existing, request);
      return this.#result(await this.advance(draftId));
    }
    if (await this.#usedElsewhere(request.requestId, draftId)) throw fail(409, REUSED);
    const accepted = await this.#authority(async () => {
      const again = await this.places.read(draftId);
      if (again) return again;
      if (await this.#usedElsewhere(request.requestId, draftId)) throw fail(409, REUSED);
      const review = await this.#review(draftId);
      if (review.impactSha256 !== request.impactSha256) throw fail(409, STALE);
      return this.places.write({
        schemaVersion: 2, draftId, requestId: request.requestId, impactSha256: review.impactSha256, state: 'access-stopped',
        requestedAt: new Date().toISOString(), completedAt: null, inventory: review.inventory, jobIds: review.jobIds,
        intakeIds: review.intakeIds, retiredVerifiers: review.retiredVerifiers, steps: { intakesConsumed: false, invitationsRevoked: false },
      });
    });
    this.#sameRequest(accepted, request);
    // Cancellation is requested only after the barrier is durable; nothing waits here.
    this.reconstructions.abortPlace(draftId);
    return this.#result(await this.advance(draftId));
  }

  #result(record) {
    return { status: record.state === 'complete' ? 200 : 202, record: publicRecord(record) };
  }

  // One step at a time, never under the scene mutex or the shared section
  // while an intake or access mutex is awaited. Any failure leaves the
  // deletion pending; it is never reported as "nothing deleted".
  advance(draftId) {
    const running = this.advancing.get(draftId);
    if (running) return running;
    const work = this.#advance(draftId).finally(() => {
      if (this.advancing.get(draftId) === work) this.advancing.delete(draftId);
    });
    this.advancing.set(draftId, work);
    return work;
  }

  async #step(draftId, change) {
    return this.#authority(async () => {
      const current = await this.places.read(draftId);
      return this.places.write(change(current));
    });
  }

  async #advance(draftId) {
    let record = await this.places.read(draftId);
    if (!record || record.state === 'complete') return record;
    try {
      if (!record.steps.intakesConsumed) {
        await this.intakes.consumePlace(draftId);
        record = await this.#step(draftId, (current) => ({ ...current, steps: { ...current.steps, intakesConsumed: true } }));
      }
      if (!record.steps.invitationsRevoked) {
        await this.access.revokePlace(draftId);
        record = await this.#step(draftId, (current) => ({ ...current, steps: { ...current.steps, invitationsRevoked: true } }));
      }
      if (this.reconstructions.placeOperations(draftId) > 0 || this.intakes.placeOperations(record.intakeIds) > 0) return record;
      const removed = await this.reconstructions.serialize(() => this.#remove(record));
      if (!removed || this.reconstructions.placeOperations(draftId) > 0 || this.intakes.placeOperations(record.intakeIds) > 0) return record;
      return await this.#step(draftId, (current) => ({ ...current, state: 'complete', completedAt: new Date().toISOString() }));
    } catch {
      return (await this.places.read(draftId).catch(() => null)) ?? record;
    }
  }

  // Removes every tracked copy, then verifies all of it is absent.
  async #remove(record) {
    const root = this.dataDir;
    let clean = true;
    const targets = [
      [path.join(root, 'drafts', record.draftId), draftTree],
      // A direct or intake save's staging folder for this exact ID.
      [path.join(root, 'incoming', record.draftId), draftTree],
      [path.join(root, 'reconstructions', record.draftId), sceneTree],
      ...record.jobIds.map((jobId) => [path.join(root, 'reconstruction-staging', jobId), stagingTree]),
      ...record.intakeIds.map((intakeId) => [path.join(root, 'intakes', intakeId, 'parts'), partsTree]),
    ];
    for (const [target, allowed] of targets) if (!(await removeTree(target, root, allowed))) clean = false;
    for (const [target] of targets) if ((await kind(target)) !== 'missing') clean = false;
    for (const intakeId of record.intakeIds) {
      if (!(await removeMatching(path.join(root, 'intakes', intakeId), root, INTAKE_RECORD_TEMP))) clean = false;
    }
    return clean && (await this.intakes.placeConsumed(record.draftId));
  }

  // Resumes every pending deletion once, at startup.
  async resumePending() {
    let records = [];
    try {
      records = await this.places.records();
    } catch {
      return;
    }
    for (const record of records) {
      if (this.closed) return;
      if (record.state === 'access-stopped') await this.advance(record.draftId).catch(() => {});
    }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.advancing.values()].map((work) => work.catch(() => {})));
  }
}
