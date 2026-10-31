import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cleanupContributionFiles, removeManifestTemps, safeJobDirectory } from '../contribution-deletion-files.mjs';
import { PHOTO_ATTESTATIONS, attestPhotos, forgetContributionFiles } from '../contribution-photos.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MEDIA = ['original.jpg', 'original.png', 'review.jpg', 'voice-original.webm', 'voice-original.ogg', 'voice-original.m4a', 'playback.wav'];

let root;
let jobDir;
let outside;

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

// A contribution folder holding the given fixed-name files.
async function bundle(id, names = MEDIA) {
  const dir = path.join(jobDir, 'contributions', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of names) await writeFile(path.join(dir, name), `${id}:${name}`, { mode: 0o600 });
  return dir;
}

// Every file under a directory with its bytes, links as their targets.
async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, file);
    if (entry.isSymbolicLink()) out[key] = `link:${await readlink(file)}`;
    else if (entry.isFile()) out[key] = (await readFile(file)).toString('latin1');
    else out[key] = 'dir';
  }
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rehere-deletion-files-'));
  jobDir = path.join(root, 'data', 'draft', 'job');
  outside = path.join(root, 'outside');
  await mkdir(jobDir, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'outside sentinel');
});

afterEach(async () => {
  await chmod(root, 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe('contribution file cleanup', () => {
  it('removes every fixed media file and the folder, leaving everything else byte-identical', async () => {
    const id = randomUUID();
    const other = randomUUID();
    await bundle(id);
    await bundle(other);
    await writeFile(path.join(jobDir, 'manifest.json'), '{"keep":true}');
    await mkdir(path.join(jobDir, 'contributions', `.staging-${randomUUID()}`));
    const before = await snapshot(root);
    assert.equal(await cleanupContributionFiles(jobDir, id), true);
    assert.equal(await exists(path.join(jobDir, 'contributions', id)), false);
    const after = await snapshot(root);
    const expected = Object.fromEntries(Object.entries(before).filter(([key]) => !key.includes(id)));
    assert.deepEqual(after, expected);
  });

  it('treats an already absent folder or contributions directory as verified absence', async () => {
    assert.equal(await cleanupContributionFiles(jobDir, randomUUID()), true);
    await bundle(randomUUID());
    assert.equal(await cleanupContributionFiles(jobDir, randomUUID()), true);
    assert.equal(await cleanupContributionFiles(path.join(root, 'no-such-job'), randomUUID()), true);
  });

  it('refuses anything but a strict lowercase UUID and an absolute job folder, removing nothing', async () => {
    const id = randomUUID();
    await bundle(id);
    const before = await snapshot(root);
    for (const bad of [id.toUpperCase(), `../${id}`, '..', '.', '', `.staging-${id}`, `${id}/`, null, 42]) {
      assert.equal(await cleanupContributionFiles(jobDir, bad), false, String(bad));
    }
    assert.equal(await cleanupContributionFiles(path.relative(process.cwd(), jobDir), id), false);
    assert.equal(await cleanupContributionFiles(undefined, id), false);
    assert.deepEqual(await snapshot(root), before);
  });

  it('removes known files but stays pending while an unknown file remains, across repeated calls', async () => {
    const id = randomUUID();
    const dir = await bundle(id);
    await writeFile(path.join(dir, 'notes.txt'), 'added by someone else');
    assert.equal(await cleanupContributionFiles(jobDir, id), false);
    assert.deepEqual(await readdir(dir), ['notes.txt']);
    // A restart retries with the same result and never removes the unknown file.
    assert.equal(await cleanupContributionFiles(jobDir, id), false);
    assert.equal(await readFile(path.join(dir, 'notes.txt'), 'utf8'), 'added by someone else');
    await rm(path.join(dir, 'notes.txt'));
    assert.equal(await cleanupContributionFiles(jobDir, id), true);
    assert.equal(await exists(dir), false);
  });

  it('never follows or removes links, and leaves unexpected folders in place', async () => {
    const id = randomUUID();
    const dir = await bundle(id, ['original.jpg']);
    await symlink(path.join(outside, 'sentinel.txt'), path.join(dir, 'playback.wav'));
    await symlink(outside, path.join(dir, 'linked-folder'));
    await mkdir(path.join(dir, 'review.jpg'));
    await writeFile(path.join(dir, 'review.jpg', 'inner.bin'), 'inner');
    assert.equal(await cleanupContributionFiles(jobDir, id), false);
    assert.equal(await exists(path.join(dir, 'original.jpg')), false);
    assert.equal(await readlink(path.join(dir, 'playback.wav')), path.join(outside, 'sentinel.txt'));
    assert.equal(await readlink(path.join(dir, 'linked-folder')), outside);
    assert.equal(await readFile(path.join(dir, 'review.jpg', 'inner.bin'), 'utf8'), 'inner');
    assert.deepEqual(await snapshot(outside), { 'sentinel.txt': 'outside sentinel' });
  });

  it('refuses a linked contribution folder or contributions directory without touching the target', async () => {
    const id = randomUUID();
    await mkdir(path.join(jobDir, 'contributions'));
    await writeFile(path.join(outside, 'playback.wav'), 'outside media');
    await symlink(outside, path.join(jobDir, 'contributions', id));
    assert.equal(await cleanupContributionFiles(jobDir, id), false);
    const linkedJob = path.join(root, 'linked-job');
    await mkdir(linkedJob);
    await mkdir(path.join(outside, id));
    await writeFile(path.join(outside, id, 'review.jpg'), 'outside review');
    await symlink(outside, path.join(linkedJob, 'contributions'));
    assert.equal(await cleanupContributionFiles(linkedJob, id), false);
    assert.deepEqual(await snapshot(outside), {
      'sentinel.txt': 'outside sentinel', 'playback.wav': 'outside media', [id]: 'dir', [path.join(id, 'review.jpg')]: 'outside review',
    });
    assert.equal(await readlink(path.join(jobDir, 'contributions', id)), outside);
  });

  it('refuses a linked job folder without touching the target', async () => {
    const id = randomUUID();
    await mkdir(path.join(outside, 'contributions', id), { recursive: true });
    await writeFile(path.join(outside, 'contributions', id, 'playback.wav'), 'outside media');
    const linkedJob = path.join(root, 'linked-job');
    await symlink(outside, linkedJob);
    const before = await snapshot(outside);
    assert.equal(await cleanupContributionFiles(linkedJob, id), false);
    assert.deepEqual(await snapshot(outside), before);
    assert.equal(await readlink(linkedJob), outside);
  });

  it('resolves false instead of throwing when removal fails, and true once it can finish', { skip: process.getuid?.() === 0 && 'root ignores folder permissions' }, async () => {
    const id = randomUUID();
    const dir = await bundle(id, ['review.jpg']);
    await chmod(dir, 0o500);
    try {
      assert.equal(await cleanupContributionFiles(jobDir, id), false);
      assert.equal(await readFile(path.join(dir, 'review.jpg'), 'utf8'), `${id}:review.jpg`);
    } finally {
      await chmod(dir, 0o700);
    }
    await chmod(dir, 0o000);
    try {
      assert.equal(await cleanupContributionFiles(jobDir, id), false);
    } finally {
      await chmod(dir, 0o700);
    }
    assert.equal(await cleanupContributionFiles(jobDir, id), true);
  });

  it('a removed bundle no longer attests, and forgetting is a synchronous no-throw', async () => {
    const id = randomUUID();
    const dir = await bundle(id, []);
    const original = Buffer.from('original bytes');
    const review = Buffer.from('review bytes');
    await writeFile(path.join(dir, 'original.jpg'), original);
    await writeFile(path.join(dir, 'review.jpg'), review);
    const manifest = {
      draftId: randomUUID(), id: randomUUID(),
      collaboration: { contributions: [{
        id, principalId: randomUUID(), withdrawnAt: null, voice: null,
        photo: { source: { name: 'original.jpg', sha256: sha256(original), size: original.length }, review: { name: 'review.jpg', sha256: sha256(review), size: review.length } },
      }] },
    };
    await attestPhotos(manifest, manifest.draftId, manifest.id, jobDir);
    assert.equal(manifest[PHOTO_ATTESTATIONS].get(id).available, true);
    assert.equal(await cleanupContributionFiles(jobDir, id), true);
    await attestPhotos(manifest, manifest.draftId, manifest.id, jobDir);
    assert.equal(manifest[PHOTO_ATTESTATIONS].get(id).available, false);
    assert.equal(forgetContributionFiles(jobDir, id), undefined);
    assert.equal(forgetContributionFiles(jobDir, 'not-a-uuid'), undefined);
  });
});

describe('the data boundary from rootDir to the job folder', () => {
  // The fixture's tmpdir may sit under OS links (for example /var on macOS);
  // only components from rootDir down are checked, so these calls still work.
  const dataDir = () => path.join(root, 'data');

  it('cleans through real directories below rootDir and treats a missing component as absence', async () => {
    const id = randomUUID();
    await bundle(id);
    const temp = path.join(jobDir, `manifest.json.${randomUUID()}.tmp`);
    await writeFile(temp, 'copy');
    assert.equal(await cleanupContributionFiles(jobDir, id, dataDir()), true);
    assert.equal(await removeManifestTemps(jobDir, dataDir()), true);
    assert.equal(await exists(temp), false);
    const missing = path.join(dataDir(), 'no-draft', 'job');
    assert.equal(await cleanupContributionFiles(missing, id, dataDir()), true);
    assert.equal(await removeManifestTemps(missing, dataDir()), true);
  });

  it('refuses a linked draft folder or intermediate component and leaves the outside target intact', async () => {
    const id = randomUUID();
    await mkdir(path.join(outside, 'job', 'contributions', id), { recursive: true });
    await writeFile(path.join(outside, 'job', 'contributions', id, 'playback.wav'), 'outside media');
    await writeFile(path.join(outside, 'job', `manifest.json.${randomUUID()}.tmp`), 'outside temp');
    await symlink(outside, path.join(dataDir(), 'linked-draft'));
    const nested = path.join(dataDir(), 'draft', 'deeper');
    await mkdir(nested);
    await symlink(outside, path.join(nested, 'linked-middle'));
    const before = await snapshot(outside);
    for (const linkedJob of [path.join(dataDir(), 'linked-draft', 'job'), path.join(nested, 'linked-middle', 'job')]) {
      assert.equal(await cleanupContributionFiles(linkedJob, id, dataDir()), false, linkedJob);
      assert.equal(await removeManifestTemps(linkedJob, dataDir()), false, linkedJob);
    }
    assert.deepEqual(await snapshot(outside), before);
  });

  it('refuses a linked rootDir, a job folder outside rootDir and unnormalized paths', async () => {
    const id = randomUUID();
    await bundle(id);
    await writeFile(path.join(jobDir, `manifest.json.${randomUUID()}.tmp`), 'copy');
    const linkedRoot = path.join(root, 'linked-data');
    await symlink(dataDir(), linkedRoot);
    const before = await snapshot(root);
    const cases = [
      [path.join(linkedRoot, 'draft', 'job'), linkedRoot],
      [jobDir, path.join(root, 'elsewhere')],
      [path.join(root, 'data-sibling', 'job'), dataDir()],
      [`${dataDir()}/draft/../draft/job`, dataDir()],
      [`${jobDir}/`, dataDir()],
      [jobDir, 'data'],
      [jobDir, null],
    ];
    for (const [job, boundary] of cases) {
      assert.equal(await cleanupContributionFiles(job, id, boundary), false, `${job} ${boundary}`);
      assert.equal(await removeManifestTemps(job, boundary), false, `${job} ${boundary}`);
    }
    assert.deepEqual(await snapshot(root), before);
  });
});

describe('safe job directory check', () => {
  it('is true only for a real job directory reached through real directories below rootDir', async () => {
    const dataDir = path.join(root, 'data');
    assert.equal(await safeJobDirectory(jobDir, dataDir), true);
    assert.equal(await safeJobDirectory(jobDir), true);
    assert.equal(await safeJobDirectory(dataDir, dataDir), true);
    await symlink(outside, path.join(dataDir, 'linked-draft'));
    await mkdir(path.join(outside, 'job'));
    await symlink(outside, path.join(jobDir, '..', 'linked-job'));
    await writeFile(path.join(jobDir, '..', 'file-job'), 'not a folder');
    const before = await snapshot(outside);
    const cases = [
      [path.join(dataDir, 'linked-draft', 'job'), dataDir],
      [path.join(dataDir, 'draft', 'linked-job'), dataDir],
      [path.join(dataDir, 'draft', 'linked-job')],
      [path.join(dataDir, 'draft', 'file-job'), dataDir],
      [path.join(dataDir, 'missing', 'job'), dataDir],
      [path.join(root, 'outside', 'job'), dataDir],
      [`${jobDir}/`, dataDir],
      [`${dataDir}/draft/../draft/job`, dataDir],
      ['relative/job', 'relative'],
      [jobDir, null],
      [undefined],
    ];
    for (const [job, boundary] of cases) assert.equal(await safeJobDirectory(job, boundary), false, `${job} ${boundary}`);
    assert.deepEqual(await snapshot(outside), before);
  });

  it('is false for an unreadable component instead of throwing', { skip: process.getuid?.() === 0 && 'root ignores folder permissions' }, async () => {
    const draft = path.join(root, 'data', 'draft');
    await chmod(draft, 0o000);
    try {
      assert.equal(await safeJobDirectory(jobDir, path.join(root, 'data')), false);
    } finally {
      await chmod(draft, 0o700);
    }
  });
});

describe('manifest temp cleanup', () => {
  it('removes only strict manifest.json.<uuid>.tmp files', async () => {
    const temps = [randomUUID(), randomUUID()].map((uuid) => `manifest.json.${uuid}.tmp`);
    for (const name of temps) await writeFile(path.join(jobDir, name), '{"text":"old private copy"}');
    const kept = ['manifest.json', 'manifest.json.tmp', `manifest.json.${randomUUID().toUpperCase()}.tmp`, `other.json.${randomUUID()}.tmp`,
      `manifest.json.${randomUUID()}.tmp.bak`, `xmanifest.json.${randomUUID()}.tmp`];
    for (const name of kept) await writeFile(path.join(jobDir, name), name);
    await bundle(randomUUID(), ['review.jpg']);
    const before = await snapshot(root);
    assert.equal(await removeManifestTemps(jobDir), true);
    const expected = Object.fromEntries(Object.entries(before).filter(([key]) => !temps.some((name) => key.endsWith(name))));
    assert.deepEqual(await snapshot(root), expected);
    assert.equal(await removeManifestTemps(jobDir), true);
  });

  it('leaves a linked or folder temp name in place and reports it', async () => {
    const linked = `manifest.json.${randomUUID()}.tmp`;
    const folder = `manifest.json.${randomUUID()}.tmp`;
    const plain = `manifest.json.${randomUUID()}.tmp`;
    await symlink(path.join(outside, 'sentinel.txt'), path.join(jobDir, linked));
    await mkdir(path.join(jobDir, folder));
    await writeFile(path.join(jobDir, plain), 'copy');
    assert.equal(await removeManifestTemps(jobDir), false);
    assert.equal(await exists(path.join(jobDir, plain)), false);
    assert.equal(await readlink(path.join(jobDir, linked)), path.join(outside, 'sentinel.txt'));
    assert.equal(await exists(path.join(jobDir, folder)), true);
    assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel');
  });

  it('treats a missing job folder as absence and refuses a relative path or a linked job folder', async () => {
    assert.equal(await removeManifestTemps(path.join(root, 'missing')), true);
    assert.equal(await removeManifestTemps('relative/job'), false);
    const name = `manifest.json.${randomUUID()}.tmp`;
    await writeFile(path.join(outside, name), 'outside temp');
    const linked = path.join(root, 'linked-job');
    await symlink(outside, linked);
    assert.equal(await removeManifestTemps(linked), false);
    assert.equal(await readFile(path.join(outside, name), 'utf8'), 'outside temp');
  });
});
