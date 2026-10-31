import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  PLAYBACK_NAME, REVIEW_NAME, VOICE_ORIGINAL_NAMES, contributionsDir, forgetContributionFiles, photoDir,
} from './contribution-photos.mjs';

// Removes the app's own stored files for one deleted contribution, and crash
// leftover manifest copies. Only server-generated names are eligible: the
// contribution's UUID folder, the fixed media file names inside it, and
// `manifest.json.<uuid>.tmp`. Symbolic links are never followed or removed,
// and an unknown file, folder or link is left in place. Each function resolves
// true only when absence was verified afterwards, and false (never throws)
// when anything was unsafe, unexpected or failed. Every path component from
// rootDir (the app's data boundary) down to the job folder must be a real
// directory; folders above rootDir are not checked. Callers serialize; a
// concurrent outside swap is not guarded against. Removal is a file-system
// unlink, not secure erasure.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANIFEST_TEMP = /^manifest\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const MEDIA_NAMES = new Set(['original.jpg', 'original.png', REVIEW_NAME, ...Object.values(VOICE_ORIGINAL_NAMES), PLAYBACK_NAME]);

const normalized = (dir) => typeof dir === 'string' && path.isAbsolute(dir) && path.resolve(dir) === dir;

// 'missing', 'directory', 'file' or 'other' (a link or special file); null on a read error.
async function kind(target) {
  try {
    const info = await lstat(target);
    if (info.isDirectory()) return 'directory';
    return info.isFile() ? 'file' : 'other';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : null;
  }
}

// 'directory' when rootDir and every component down to jobDir are real
// directories, 'missing' when one does not exist, otherwise null.
async function jobFolder(jobDir, rootDir) {
  if (!normalized(jobDir) || !normalized(rootDir)) return null;
  const relative = path.relative(rootDir, jobDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  let current = rootDir;
  for (const part of ['', ...(relative === '' ? [] : relative.split(path.sep))]) {
    current = path.join(current, part);
    const found = await kind(current);
    if (found !== 'directory') return found === 'missing' ? 'missing' : null;
  }
  return 'directory';
}

// True only when jobDir is a real directory reached from rootDir through real
// directories; false when missing, linked, outside rootDir or unreadable.
export async function safeJobDirectory(jobDir, rootDir = jobDir) {
  try {
    return (await jobFolder(jobDir, rootDir)) === 'directory';
  } catch {
    return false;
  }
}

// Unlinks a regular file found under a fixed name; any other kind stays.
async function removeFile(file) {
  if ((await kind(file)) !== 'file') return false;
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  return (await kind(file)) === 'missing';
}

export async function cleanupContributionFiles(jobDir, contributionId, rootDir = jobDir) {
  if (typeof contributionId !== 'string' || !UUID.test(contributionId)) return false;
  try {
    const job = await jobFolder(jobDir, rootDir);
    if (job === 'missing') return true;
    if (job !== 'directory') return false;
    const parent = await kind(contributionsDir(jobDir));
    if (parent === 'missing') return true;
    if (parent !== 'directory') return false;
    const dir = photoDir(jobDir, contributionId);
    const found = await kind(dir);
    if (found === 'missing') return true;
    if (found !== 'directory') return false;
    let clean = true;
    // Every known media file is removed even when something unknown stays, so
    // the least possible material remains while deletion is pending.
    for (const name of await readdir(dir)) {
      if (!MEDIA_NAMES.has(name) || !(await removeFile(path.join(dir, name)))) clean = false;
    }
    if (!clean || (await readdir(dir)).length !== 0) return false;
    try {
      await rmdir(dir);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
    return (await kind(dir)) === 'missing';
  } catch {
    return false;
  } finally {
    if (typeof jobDir === 'string') forgetContributionFiles(jobDir, contributionId);
  }
}

export async function removeManifestTemps(jobDir, rootDir = jobDir) {
  try {
    const found = await jobFolder(jobDir, rootDir);
    if (found === 'missing') return true;
    if (found !== 'directory') return false;
    let clean = true;
    for (const name of await readdir(jobDir)) {
      if (MANIFEST_TEMP.test(name) && !(await removeFile(path.join(jobDir, name)))) clean = false;
    }
    return clean && !(await readdir(jobDir)).some((name) => MANIFEST_TEMP.test(name));
  } catch {
    return false;
  }
}
