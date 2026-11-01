import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AccessStore, freshCredentials, generateSecret } from '../access.mjs';
import { DraftStore } from '../drafts.mjs';
import { IntakeStore } from '../intakes.mjs';
import { PlaceDeletions } from '../place-deletions.mjs';
import { pythonRunner } from '../reconstructions.mjs';
import { acceptingTestMediaVerifier, client, enrolledContributor, jpeg, png, readyScene, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic places, text and photos only; no model call, no shared runtime data.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const NOT_FOUND = { error: 'This memory could not be found.' };
const VISIT_UNAVAILABLE = 'This shared place is not available.';
const INVENTORY_KEYS = ['contributionProviders', 'contributions', 'intakes', 'invitations', 'linkedMemories', 'linkedRegions', 'photos', 'processing', 'recordedStories',
  'recording', 'scenes', 'visitorPreviews', 'visitorSnapshots', 'writtenMemory'];

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Holds the first real rename whose target matches until released (the
// repository's existing pattern), so a publication is paused inside its commit.
function holdRename(matches) {
  const original = fs.promises.rename;
  const reached = deferred();
  const release = deferred();
  let held = false;
  fs.promises.rename = async (from, to) => {
    if (!held && matches(String(to))) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  return {
    reached: reached.promise,
    release: release.resolve,
    restore() {
      release.resolve();
      fs.promises.rename = original;
      syncBuiltinESMExports();
    },
  };
}

// Holds the first real writeFile whose target matches, after it has written,
// until released: the file exists while its finalizer waits.
function holdWrite(matches) {
  const original = fs.promises.writeFile;
  const reached = deferred();
  const release = deferred();
  let held = false;
  fs.promises.writeFile = async (file, ...rest) => {
    const result = await original(file, ...rest);
    if (!held && matches(String(file))) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return result;
  };
  syncBuiltinESMExports();
  return {
    reached: reached.promise,
    release: release.resolve,
    restore() {
      release.resolve();
      fs.promises.writeFile = original;
      syncBuiltinESMExports();
    },
  };
}

// A runner that, while `hold` is set, ignores abort and writes its outputs
// only after release, the way a stuck worker could.
function heldRunner() {
  const runner = async (call) => {
    if (!runner.hold) return sceneRunner(call);
    const gate = runner.hold;
    runner.started.resolve();
    await gate.promise;
    await mkdir(call.outputDir, { recursive: true });
    await writeFile(path.join(call.outputDir, 'texture.jpg'), jpeg(40, 30, 1));
    return { exitCode: 0, stderr: '' };
  };
  runner.hold = null;
  runner.started = deferred();
  return runner;
}

async function workspace(options = {}, dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-place-deletion-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: options.runner ?? sceneRunner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

const review = (owner, draftId) => owner.json(`/api/drafts/${draftId}/deletion`);
const remove = (owner, draftId, body) => owner.post(`/api/drafts/${draftId}/delete`, body);
const confirm = (impactSha256, requestId = randomUUID()) => ({ requestId, impactSha256, confirmDeletion: true });
async function deletePlace(owner, draftId) {
  const { impactSha256 } = await review(owner, draftId);
  const body = confirm(impactSha256);
  const response = await remove(owner, draftId, body);
  return { response, body, record: await response.json() };
}
const exists = (file) => lstat(file).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));

// Every stored file except access.json, whose sessions record each request.
async function hashTree(dir) {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && !(entry.parentPath === dir && entry.name === 'access.json')) result[path.relative(dir, path.join(entry.parentPath, entry.name))] = sha256(await readFile(path.join(entry.parentPath, entry.name)));
  }
  return result;
}

// One synthetic place with a contribution, a snapshot, a name and a pending invitation.
async function richPlace(app, owner) {
  const scene = await readyScene(owner, { share: true });
  assert.equal((await owner.post(`/api/drafts/${scene.draft.id}/place-name`, { requestId: randomUUID(), baseRevision: 0, name: 'Synthetic corner shop' })).status, 200);
  const { session: contributor } = await enrolledContributor(owner, app.base, scene.draft.id);
  assert.equal((await contributor.post(`${scene.scene}/contributions`, {
    requestId: randomUUID(), text: 'Synthetic recollection about the counter.', permissions: { place: true, model: false, share: false }, periodClaim: '',
  })).status, 200);
  const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
  const preview = await (await owner.post(`${scene.scene}/shares/previews`, {
    requestId: randomUUID(), title: 'Synthetic visit', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
  })).json();
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  assert.equal((await owner.post(`${scene.scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true })).status, 201);
  const inviteToken = generateSecret('invitation');
  assert.equal((await owner.post('/api/invitations', { requestId: randomUUID(), draftId: scene.draft.id, expiresInHours: 24, token: inviteToken })).status, 201);
  return { ...scene, contributor, token, viewId: view.id, inviteToken };
}

describe('owner place deletion', () => {
  it('reviews raw stored counts without writing, refuses stale or reused requests, and replays exactly', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await richPlace(app, owner);
      // A stopped source is still a stored original and still counted.
      const { revision } = await owner.json(`/api/drafts/${place.draft.id}/sources/${place.draft.photos[0].sourceId}/policy`);
      assert.equal((await owner.post(`/api/drafts/${place.draft.id}/sources/${place.draft.photos[0].sourceId}/policy`, {
        requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true,
      })).status, 200);
      const before = await hashTree(dataDir);
      const state = await review(owner, place.draft.id);
      assert.deepEqual(Object.keys(state).sort(), ['draftId', 'impactSha256', 'inventory', 'state']);
      assert.equal(state.state, 'present');
      assert.deepEqual(Object.keys(state.inventory).sort(), INVENTORY_KEYS);
      assert.deepEqual(state.inventory, {
        photos: 1, writtenMemory: false, recording: false, scenes: 1, recordedStories: 0, contributions: 1, contributionProviders: 1,
        visitorSnapshots: 1, visitorPreviews: 1, linkedRegions: 0, invitations: 2, intakes: 0, processing: 0, linkedMemories: 0,
      });
      assert.equal((await owner.request(`/api/drafts/${place.draft.id}/deletion`, { method: 'HEAD' })).status, 200);
      assert.deepEqual(await hashTree(dataDir), before, 'reviewing writes nothing');

      for (const [body, status] of [[{ ...confirm(state.impactSha256), confirmDeletion: false }, 400], [{ requestId: 'x', impactSha256: state.impactSha256, confirmDeletion: true }, 400],
        [{ ...confirm(state.impactSha256), extra: 1 }, 400], [confirm(sha256('stale')), 409]]) {
        assert.equal((await remove(owner, place.draft.id, body)).status, status, JSON.stringify(body).slice(0, 60));
      }
      assert.equal((await remove(owner, randomUUID(), confirm(state.impactSha256))).status, 404);
      assert.equal((await remove(owner, 'not-an-id', confirm(state.impactSha256))).status, 404);
      assert.equal((await owner.request(`/api/drafts/${place.draft.id}/delete`)).status, 405);
      assert.equal((await place.contributor.post(`/api/drafts/${place.draft.id}/delete`, confirm(state.impactSha256))).status, 403);
      assert.equal((await client(app.base).request(`/api/drafts/${place.draft.id}/deletion`)).status, 401);
      assert.deepEqual(await hashTree(dataDir), before, 'every refusal writes nothing');
      // An invitation created after the review makes that review stale.
      assert.equal((await owner.post('/api/invitations', { requestId: randomUUID(), draftId: place.draft.id, expiresInHours: 24, token: generateSecret('invitation') })).status, 201);
      assert.equal((await remove(owner, place.draft.id, confirm(state.impactSha256))).status, 409);
      assert.equal(await exists(path.join(dataDir, 'place-deletions', `${place.draft.id}.json`)), false);
      Object.assign(state, await review(owner, place.draft.id));
      assert.equal(state.inventory.invitations, 3);

      const body = confirm(state.impactSha256);
      const accepted = await remove(owner, place.draft.id, body);
      assert.equal(accepted.status, 200);
      const record = await accepted.json();
      assert.deepEqual(Object.keys(record).sort(), ['completedAt', 'draftId', 'impactSha256', 'inventory', 'requestId', 'requestedAt', 'state']);
      assert.deepEqual([record.draftId, record.requestId, record.impactSha256, record.state], [place.draft.id, body.requestId, state.impactSha256, 'complete']);
      assert.deepEqual(record.inventory, state.inventory);
      assert.equal(record.inventory.invitations, 3);
      assert.deepEqual(await (await remove(owner, place.draft.id, body)).json(), record, 'an exact replay returns the record');
      assert.equal((await remove(owner, place.draft.id, { ...body, impactSha256: sha256('other') })).status, 409);
      assert.equal((await remove(owner, place.draft.id, confirm(state.impactSha256))).status, 409, 'a new request for a deleted place');
      assert.deepEqual(await review(owner, place.draft.id), record, 'the state stays readable');
      const other = await readyScene(owner);
      const otherReview = await review(owner, other.draft.id);
      assert.equal((await remove(owner, other.draft.id, { ...body, impactSha256: otherReview.impactSha256 })).status, 409, 'a request ID used by another place');
      assert.deepEqual(await owner.json('/api/place-deletions'), { items: [] }, 'complete is not pending');
    } finally {
      await app.close();
    }
  });

  it('refuses to review or delete a place whose scene folder lost its manifest, writing nothing', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await richPlace(app, owner);
      const before = await review(owner, place.draft.id);
      const manifestPath = path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json');
      const original = await readFile(manifestPath);
      // An empty or foreign record is not a reviewable scene either.
      for (const content of ['{}', JSON.stringify({ ...JSON.parse(original), id: randomUUID() })]) {
        await writeFile(manifestPath, content);
        assert.equal((await owner.request(`/api/drafts/${place.draft.id}/deletion`)).status, 503, content.slice(0, 20));
        assert.equal((await remove(owner, place.draft.id, confirm(before.impactSha256))).status, 503);
      }
      // Present but invalid containers are never read as empty.
      const valid = JSON.parse(original);
      const invalid = [];
      for (const key of ['stories', 'collaboration', 'shares']) for (const value of [false, 0, null, '', [], 'x']) invalid.push({ ...valid, [key]: value });
      invalid.push({ ...valid, shares: { ...valid.shares, snapshots: null } }, { ...valid, shares: { ...valid.shares, previews: {} } },
        { ...valid, shares: { ...valid.shares, snapshots: [null] } }, { ...valid, shares: { ...valid.shares, snapshots: [[]] } },
        { ...valid, collaboration: { ...valid.collaboration, contributions: [0] } }, { ...valid, stories: { items: 'none' } });
      for (const manifest of invalid) {
        await writeFile(manifestPath, JSON.stringify(manifest));
        const label = JSON.stringify(manifest).slice(-60);
        assert.equal((await owner.request(`/api/drafts/${place.draft.id}/deletion`)).status, 503, label);
        assert.equal((await remove(owner, place.draft.id, confirm(before.impactSha256))).status, 503, label);
        assert.equal(await exists(path.join(dataDir, 'place-deletions', `${place.draft.id}.json`)), false, label);
      }
      await rm(manifestPath);
      const snapshot = await hashTree(dataDir);
      const refused = await owner.request(`/api/drafts/${place.draft.id}/deletion`);
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: 'This place cannot be reviewed for deletion right now. Nothing was changed.' });
      assert.equal((await remove(owner, place.draft.id, confirm(before.impactSha256))).status, 503);
      assert.equal(await exists(path.join(dataDir, 'place-deletions', `${place.draft.id}.json`)), false, 'no barrier');
      assert.deepEqual(await hashTree(dataDir), snapshot, 'nothing removed or written');
      assert.equal((await owner.request(`/api/drafts/${place.draft.id}`)).status, 200, 'the place is still there');
    } finally {
      await app.close();
    }
  });

  it('treats an inconsistent or unreadable deletion record as deleted, never as complete or absent', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await readyScene(owner);
      const { record, body } = await deletePlace(owner, place.draft.id);
      assert.equal(record.state, 'complete');
      const file = path.join(dataDir, 'place-deletions', `${place.draft.id}.json`);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      for (const broken of [
        { ...stored, steps: { intakesConsumed: true, invitationsRevoked: false } },
        { ...stored, completedAt: 'yesterday' },
        { ...stored, requestedAt: '2026-13-40T00:00:00.000Z' },
        { ...stored, completedAt: new Date(Date.parse(stored.requestedAt) - 1000).toISOString() },
        { ...stored, state: 'access-stopped' },
      ]) {
        await writeFile(file, JSON.stringify(broken));
        assert.equal((await owner.request(`/api/drafts/${place.draft.id}/deletion`)).status, 503, JSON.stringify(broken).slice(0, 40));
        assert.equal((await remove(owner, place.draft.id, body)).status, 503);
        assert.equal((await owner.request(`/api/drafts/${place.draft.id}`)).status, 404, 'still deleted');
        assert.equal((await owner.request('/api/place-deletions')).status, 503);
      }
    } finally {
      await app.close();
    }
  });

  it('stops all access at once, removes every tracked copy and leaves other places, access and the ledger unchanged', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await richPlace(app, owner);
      const kept = await richPlace(app, owner);
      const ledger = path.join(dataDir, 'model-budget.json');
      await writeFile(ledger, '{"synthetic":"ledger"}\n');
      const keptBefore = {
        drafts: await hashTree(path.join(dataDir, 'drafts', kept.draft.id)),
        scenes: await hashTree(path.join(dataDir, 'reconstructions', kept.draft.id)),
        ledger: await readFile(ledger),
      };
      const keptVisit = await (await globalThis.fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${kept.token}` } })).text();
      const asset = `/api/drafts/${place.draft.id}/assets/${place.draft.photos[0].name}`;
      const routes = [`/api/drafts/${place.draft.id}`, asset, place.scene, `${place.scene}/assets/texture.jpg`, `${place.scene}/collaboration`, `${place.scene}/shares`,
        `/api/drafts/${place.draft.id}/sources/${place.draft.photos[0].sourceId}/policy`, `${place.scene}/history`];

      const { response, record } = await deletePlace(owner, place.draft.id);
      assert.equal(response.status, 200);
      for (const route of routes) {
        for (const method of ['GET', 'HEAD']) assert.equal((await owner.request(route, { method, headers: { range: 'bytes=0-3' } })).status, 404, `${method} ${route}`);
      }
      assert.deepEqual(await (await owner.request(`/api/drafts/${place.draft.id}`)).json(), NOT_FOUND);
      assert.ok(!(await owner.json('/api/drafts')).some((item) => item.id === place.draft.id));
      assert.equal((await owner.post(`/api/drafts/${place.draft.id}/place-name`, { requestId: randomUUID(), baseRevision: 1, name: 'x' })).status, 404);
      assert.equal((await owner.post('/api/invitations', { requestId: randomUUID(), draftId: place.draft.id, expiresInHours: 24, token: generateSecret('invitation') })).status, 404);
      assert.deepEqual(await place.contributor.json('/api/contributor/places'), []);
      assert.equal((await place.contributor.request(`${place.scene}/collaboration`)).status, 404);
      for (const route of ['/api/visit', `/api/visit/assets/${place.viewId}/texture.jpg`]) {
        const visit = await globalThis.fetch(`${app.base}${route}`, { headers: { authorization: `Bearer ${place.token}` } });
        assert.equal(visit.status, 404);
        assert.deepEqual(await visit.json(), { error: VISIT_UNAVAILABLE });
      }
      const redeem = await client(app.base).post('/api/invitations/redeem', { token: place.inviteToken, requestId: randomUUID(), displayName: 'Late', ...freshCredentials() });
      assert.equal(redeem.status, 403, 'the pending invitation was revoked');
      assert.ok((await owner.json('/api/invitations')).filter((item) => item.draftId === place.draft.id).every((item) => item.status !== 'active'));

      for (const target of [path.join('drafts', place.draft.id), path.join('reconstructions', place.draft.id)]) assert.equal(await exists(path.join(dataDir, target)), false, target);
      const stored = await readFile(path.join(dataDir, 'place-deletions', `${place.draft.id}.json`), 'utf8');
      for (const text of ['Synthetic corner shop', 'Synthetic recollection', 'Synthetic visit', 'Synthetic', place.token, place.inviteToken]) assert.ok(!stored.includes(text), text);
      assert.equal(record.state, 'complete');

      assert.deepEqual(await hashTree(path.join(dataDir, 'drafts', kept.draft.id)), keptBefore.drafts);
      assert.deepEqual(await hashTree(path.join(dataDir, 'reconstructions', kept.draft.id)), keptBefore.scenes);
      assert.deepEqual(await readFile(ledger), keptBefore.ledger, 'the idle ledger is untouched');
      assert.equal(await (await globalThis.fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${kept.token}` } })).text(), keptVisit);
      assert.equal((await kept.contributor.json('/api/contributor/places')).length, 1);
    } finally {
      await app.close();
    }
  });

  it('never issues a deleted place link key again, even after a restart', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const place = await richPlace(app, owner);
      const other = await readyScene(owner, { share: true });
      await deletePlace(owner, place.draft.id);
      await app.close();
      ({ app, owner } = await workspace({}, dataDir));
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const preview = await (await owner.post(`${other.scene}/shares/previews`, {
        requestId: randomUUID(), title: 'Other visit', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
      })).json();
      const reused = await owner.post(`${other.scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token: place.token, consent: true });
      assert.equal(reused.status, 409);
      assert.equal((await globalThis.fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${place.token}` } })).status, 404);
    } finally {
      await app.close();
    }
  });

  it('keeps access stopped while cleanup is unsafe, never touches links or unexpected files, and completes after a restart', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const place = await richPlace(app, owner);
      const outside = path.join(dataDir, 'outside-target.txt');
      await writeFile(outside, 'operator file\n');
      const draftDir = path.join(dataDir, 'drafts', place.draft.id);
      await symlink(outside, path.join(draftDir, 'linked'));
      await writeFile(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'operator-note.txt'), 'note\n');
      const { response, record, body } = await deletePlace(owner, place.draft.id);
      assert.equal(response.status, 202);
      assert.equal(record.state, 'access-stopped');
      assert.deepEqual((await owner.json('/api/place-deletions')).items, [record]);
      assert.equal((await owner.request(`/api/drafts/${place.draft.id}`)).status, 404, 'access is stopped before cleanup finishes');
      assert.equal((await globalThis.fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${place.token}` } })).status, 404);
      assert.equal(await readFile(outside, 'utf8'), 'operator file\n');
      assert.ok((await lstat(path.join(draftDir, 'linked'))).isSymbolicLink(), 'the link is neither followed nor removed');
      assert.equal(await exists(path.join(draftDir, 'draft.json')), false, 'known copies are removed meanwhile');
      assert.equal((await remove(owner, place.draft.id, body)).status, 202, 'still pending on retry');

      // The operator removes the unexpected entries; a restart resumes cleanup.
      await rm(path.join(draftDir, 'linked'));
      await rm(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'operator-note.txt'));
      await app.close();
      ({ app, owner } = await workspace({}, dataDir));
      let state;
      for (let attempt = 0; attempt < 100; attempt++) {
        state = await review(owner, place.draft.id);
        if (state.state === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(state.state, 'complete');
      assert.equal(await exists(draftDir), false);
      assert.equal(await readFile(outside, 'utf8'), 'operator file\n');
    } finally {
      await app.close();
    }
  });

  it('stays pending while an aborted build runner still runs, and removes its late output once it has settled', async () => {
    const runner = heldRunner();
    const { app, owner, dataDir } = await workspace({ runner });
    try {
      const place = await readyScene(owner);
      runner.hold = deferred();
      after(() => runner.hold?.resolve());
      const job = await (await owner.post(`/api/drafts/${place.draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: place.draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
      await runner.started.promise;
      const state = await review(owner, place.draft.id);
      assert.equal(state.inventory.processing, 1, 'the build and its runner are one operation');
      const body = confirm(state.impactSha256);
      const accepted = await remove(owner, place.draft.id, body);
      assert.equal(accepted.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await remove(owner, place.draft.id, body)).status, 202, 'an aborted but unsettled runner keeps it pending');
      // While pending, the still-stored scene is already unreadable everywhere.
      for (const route of [place.scene, `${place.scene}/assets/texture.jpg`, `${place.scene}/history`]) {
        assert.equal((await owner.request(route)).status, 404, route);
      }
      assert.deepEqual(await owner.json(`/api/drafts/${place.draft.id}/reconstructions`), []);
      assert.equal(await exists(path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json')), true, 'still stored while pending');
      const staging = path.join(dataDir, 'reconstruction-staging', job.id);
      await writeFile(path.join(staging, 'operator-note.txt'), 'note\n');
      runner.hold.resolve();
      runner.hold = null;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await remove(owner, place.draft.id, body)).status, 202, 'an unexpected staging file keeps it pending');
      assert.equal(await readFile(path.join(staging, 'operator-note.txt'), 'utf8'), 'note\n', 'the build finalizer left the residue alone');
      await rm(path.join(staging, 'operator-note.txt'));
      let status;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = (await remove(owner, place.draft.id, body)).status;
        if (status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(status, 200);
      assert.equal(await exists(staging), false, 'late runner output was removed');
      assert.equal(await exists(path.join(dataDir, 'reconstructions', place.draft.id)), false);
    } finally {
      await app.close();
    }
  });

  it('stays pending while a contributor photo is being prepared, and publishes nothing from it afterwards', async () => {
    const gate = deferred();
    const started = deferred();
    const contributionPhotoDecoder = async () => {
      started.resolve();
      await gate.promise;
      return jpeg(64, 48, 9);
    };
    const { app, owner, dataDir } = await workspace({ contributionPhotoDecoder });
    after(() => gate.resolve());
    try {
      const place = await readyScene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const form = new FormData();
      form.append('payload', JSON.stringify({
        requestId: randomUUID(), text: 'Synthetic photo note.', permissions: { place: true, model: false, share: false }, periodClaim: '',
        photo: { origin: { kind: 'own', reference: 'synthetic' }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' }, permissions: { place: true, model: false, share: false } },
      }));
      form.append('photo', new Blob([SYNTHETIC_PHOTO], { type: 'image/png' }), 'photo.png');
      const submitted = session.request(`${place.scene}/contributions/photo`, { method: 'POST', body: form });
      await started.promise;
      const { response, body } = await deletePlace(owner, place.draft.id);
      assert.equal(response.status, 202);
      gate.resolve();
      assert.notEqual((await submitted).status, 200, 'the late contribution is not published');
      let status;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = (await remove(owner, place.draft.id, body)).status;
        if (status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(status, 200);
      assert.equal(await exists(path.join(dataDir, 'reconstructions', place.draft.id)), false);
    } finally {
      await app.close();
    }
  });

  it('stays pending while a story is staged, rejects its late publication and leaves its residue to the guarded cleanup', async () => {
    const audioDecoder = async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
    const { app, owner, dataDir } = await workspace({ audioDecoder });
    const hold = holdWrite((file) => file.includes(`${path.sep}story-staging${path.sep}`));
    try {
      const form = new FormData();
      form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
      form.append('voice', new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)])], { type: 'audio/webm' }), 'voice');
      const grant = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
      form.append('metadata', JSON.stringify({ photos: [grant], voice: grant }));
      const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
      const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
      const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
      for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      const story = owner.post(`${scene}/stories`, {
        requestId: randomUUID(), voiceSourceId: draft.voice.sourceId, view: { kind: 'version', version: 1, variantId: null, eraRevision: null },
        title: 'Synthetic story', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic caption.' }], captionConfirmed: true,
      });
      await hold.reached;
      const stagingDir = path.join(dataDir, 'reconstructions', draft.id, job.id, 'story-staging');
      const [staged] = await readdir(stagingDir);
      const { response, body, record } = await deletePlace(owner, draft.id);
      assert.equal(response.status, 202);
      assert.equal(record.inventory.processing, 1, 'the staged story is one operation');
      await writeFile(path.join(stagingDir, 'operator-note.txt'), 'note\n');
      hold.release();
      const late = await story;
      assert.notEqual(late.status, 201, 'the late story is not published');
      assert.notEqual(late.status, 200);
      assert.equal(await exists(path.join(stagingDir, staged)), true, 'the finalizer left the staged copy to the guarded cleanup');
      assert.equal(await exists(path.join(dataDir, 'reconstructions', draft.id, job.id, 'stories')), false, 'nothing was published');
      assert.equal((await remove(owner, draft.id, body)).status, 202, 'the unexpected file keeps it pending');
      assert.equal(await readFile(path.join(stagingDir, 'operator-note.txt'), 'utf8'), 'note\n');
      assert.equal(await exists(path.join(stagingDir, staged)), false, 'the known staged copy is removed by the deletion');
      await rm(path.join(stagingDir, 'operator-note.txt'));
      assert.equal((await remove(owner, draft.id, body)).status, 200);
      assert.equal(await exists(path.join(dataDir, 'reconstructions', draft.id)), false);
    } finally {
      hold.restore();
      await app.close();
    }
  });

  it('turns a crash-left open intake of the place into a content-free record that can never recommit', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const planned = { partId: randomUUID(), kind: 'photo', size: SYNTHETIC_PHOTO.length, sha256: sha256(SYNTHETIC_PHOTO), hints: { name: 'p.png', type: 'image/png', lastModified: null } };
      const grant = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
      const created = await (await owner.post('/api/intakes', { requestId: randomUUID(), text: 'Synthetic intake text.', parts: [planned], metadata: { photos: [grant], text: grant }, placeName: 'Synthetic intake name' })).json();
      await owner.request(`/api/intakes/${created.id}/parts/${planned.partId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: SYNTHETIC_PHOTO });
      const intakeFile = path.join(dataDir, 'intakes', created.id, 'intake.json');
      const openRecord = await readFile(intakeFile);
      const committed = await (await owner.post(`/api/intakes/${created.id}/commit`, { requestId: randomUUID(), baseRevision: 1 })).json();
      // The committed record write was lost: the open record with text is back.
      await writeFile(intakeFile, openRecord);
      // Crash-left copies holding text: an exact-ID save staging folder and an
      // intake record temporary file; plus a link under a temp-like name.
      const incoming = path.join(dataDir, 'incoming', committed.draftId);
      await mkdir(incoming, { recursive: true });
      await writeFile(path.join(incoming, 'draft.json'), '{"text":"Synthetic intake text."}');
      const recordTemp = path.join(dataDir, 'intakes', created.id, `intake.json.${randomUUID()}.tmp`);
      await writeFile(recordTemp, openRecord);
      const outside = path.join(dataDir, 'outside.txt');
      await writeFile(outside, 'operator\n');
      const linkTemp = path.join(dataDir, 'intakes', created.id, `intake.json.${randomUUID()}.tmp`);
      await symlink(outside, linkTemp);
      const state = await review(owner, committed.draftId);
      assert.equal(state.inventory.intakes, 1);
      const body = confirm(state.impactSha256);
      assert.equal((await remove(owner, committed.draftId, body)).status, 202, 'a linked temp name keeps it pending');
      assert.equal(await exists(recordTemp), false, 'the text copy is removed meanwhile');
      assert.equal(await exists(incoming), false, 'the exact-ID staging folder is removed');
      assert.ok((await lstat(linkTemp)).isSymbolicLink());
      assert.equal(await readFile(outside, 'utf8'), 'operator\n');
      await rm(linkTemp);
      assert.equal((await remove(owner, committed.draftId, body)).status, 200);
      const stored = JSON.parse(await readFile(intakeFile, 'utf8'));
      assert.deepEqual(stored, { id: created.id, status: 'deleted', revision: 1, draftId: committed.draftId });
      assert.equal((await owner.json(`/api/intakes/${created.id}`)).status, 'deleted');
      assert.ok(!(await owner.json('/api/intakes')).some((item) => item.id === created.id));
      assert.equal((await owner.post(`/api/intakes/${created.id}/commit`, { requestId: randomUUID(), baseRevision: 1 })).status, 409);
      assert.equal((await owner.request(`/api/intakes/${created.id}/parts/${planned.partId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: SYNTHETIC_PHOTO })).status, 409);
      assert.equal(await exists(path.join(dataDir, 'drafts', committed.draftId)), false);
      assert.equal(await exists(path.join(dataDir, 'intakes', created.id, 'parts')), false);
    } finally {
      await app.close();
    }
  });
});

describe('shared commit section', () => {
  // Real stores around a held section: the publication and the barrier are
  // linearized, in both orders, at the actual publication.
  async function stores() {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-place-commit-'));
    tempDirs.push(dataDir);
    const places = new PlaceDeletions({ dataDir });
    const drafts = new DraftStore(dataDir);
    drafts.usePlaceDeletions(places);
    const barrier = (draftId) => places.write({
      schemaVersion: 1, draftId, requestId: randomUUID(), impactSha256: sha256(draftId), state: 'access-stopped', requestedAt: new Date().toISOString(), completedAt: null,
      inventory: { photos: 0, writtenMemory: false, recording: false, scenes: 0, recordedStories: 0, contributions: 0, contributionProviders: 0, visitorSnapshots: 0, visitorPreviews: 0, linkedRegions: 0, invitations: 0, intakes: 0, processing: 0 },
      jobIds: [], intakeIds: [], retiredVerifiers: [], steps: { intakesConsumed: false, invitationsRevoked: false },
    });
    return { dataDir, places, drafts, barrier };
  }
  const draftInput = { text: 'Synthetic.', photos: [], voice: null, sources: { photos: [], text: { provider: 'Synthetic', origin: { kind: 'own', reference: '' }, permissions: { place: false, model: false, share: false }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } }, voice: null } };

  it('publishes a draft before a later barrier, and never after an earlier one', async () => {
    const { dataDir, places, drafts, barrier } = await stores();
    for (const order of ['publish-first', 'barrier-first']) {
      const id = randomUUID();
      const gate = deferred();
      const held = places.commit(() => gate.promise);
      let create;
      let mark;
      if (order === 'publish-first') {
        create = drafts.create(draftInput, { id });
        await new Promise((resolve) => setTimeout(resolve, 20));
        mark = places.commit(() => barrier(id));
      } else {
        mark = places.commit(() => barrier(id));
        create = drafts.create(draftInput, { id });
      }
      gate.resolve();
      await held;
      const outcome = await create.then(() => 'published', (error) => error.status);
      await mark;
      assert.equal(outcome, order === 'publish-first' ? 'published' : 409, order);
      assert.equal(await exists(path.join(dataDir, 'drafts', id)), order === 'publish-first', order);
      assert.equal(await drafts.get(id), null, 'reads see the barrier');
    }
    assert.deepEqual(await readdir(path.join(dataDir, 'incoming')).catch(() => []), [], 'no staging is left');
  });

  it('holds a barrier until a draft publication paused inside its real rename has finished', async () => {
    const { dataDir, places, drafts, barrier } = await stores();
    const id = randomUUID();
    const target = path.join(dataDir, 'drafts', id);
    const hold = holdRename((to) => to === target);
    try {
      const create = drafts.create(draftInput, { id });
      await hold.reached;
      let marked = false;
      const mark = places.commit(() => barrier(id)).then(() => {
        marked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(marked, false, 'the barrier cannot be accepted during the publication');
      assert.equal(await exists(path.join(dataDir, 'place-deletions', `${id}.json`)), false);
      hold.release();
      await create;
      await mark;
      assert.equal(await exists(target), true, 'published first, then the barrier');
      assert.equal(await drafts.get(id), null);
    } finally {
      hold.restore();
    }
  });

  it('holds a barrier until an invitation create or redemption paused inside its real rename has finished', async () => {
    const { dataDir, places, barrier } = await stores();
    const access = new AccessStore({ dataDir });
    const credentials = freshCredentials();
    await access.bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...credentials });
    access.usePlaceCommits(places);
    const ownerId = (await access.login(credentials.accessKey)).principal.id;
    const accessFile = path.join(dataDir, 'access.json');
    for (const action of ['create', 'redeem']) {
      const draftId = randomUUID();
      const token = generateSecret('invitation');
      if (action === 'redeem') await access.createInvitation(ownerId, { requestId: randomUUID(), draftId, expiresInHours: 24, token });
      const hold = holdRename((to) => to === accessFile);
      try {
        const work = action === 'create'
          ? access.createInvitation(ownerId, { requestId: randomUUID(), draftId, expiresInHours: 24, token })
          : access.redeemInvitation({ token, requestId: randomUUID(), displayName: 'Synthetic', ...freshCredentials() });
        await hold.reached;
        let marked = false;
        const mark = places.commit(() => barrier(draftId)).then(() => {
          marked = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(marked, false, `${action}: the barrier cannot be accepted during the commit`);
        hold.release();
        await work;
        await mark;
        const stored = JSON.parse(await readFile(accessFile, 'utf8')).invitations.find((item) => item.draftId === draftId);
        assert.equal(stored.status, action === 'create' ? 'active' : 'redeemed', action);
      } finally {
        hold.restore();
      }
    }
  });

  it('refuses exact invitation replays once the place is deleted, keeping credentials', async () => {
    const { dataDir, places, barrier } = await stores();
    const access = new AccessStore({ dataDir });
    const credentials = freshCredentials();
    await access.bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...credentials });
    access.usePlaceCommits(places);
    const ownerId = (await access.login(credentials.accessKey)).principal.id;
    const draftId = randomUUID();
    const token = generateSecret('invitation');
    const create = { requestId: randomUUID(), draftId, expiresInHours: 24, token };
    await access.createInvitation(ownerId, create);
    const enrollment = { token, requestId: randomUUID(), displayName: 'Synthetic', ...freshCredentials() };
    await access.redeemInvitation(enrollment);
    await places.commit(() => barrier(draftId));
    await assert.rejects(access.createInvitation(ownerId, create), { status: 404 });
    await assert.rejects(access.redeemInvitation(enrollment), { status: 403 });
    assert.equal((await access.login(enrollment.accessKey)).principal.draftIds[0], draftId, 'credentials are not purged');
  });

  it('leaves an intake commit\'s residue to the deletion when its record write is refused after the barrier', async () => {
    const { dataDir, places, drafts, barrier } = await stores();
    const intakes = new IntakeStore({ dataDir, drafts, verifier: acceptingTestMediaVerifier(), placeCommits: places });
    const owner = { id: randomUUID() };
    const grant = { provider: 'Synthetic', origin: { kind: 'own', reference: '' }, permissions: { place: true, model: false, share: false }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
    const part = { partId: randomUUID(), kind: 'photo', size: SYNTHETIC_PHOTO.length, sha256: sha256(SYNTHETIC_PHOTO), hints: { name: 'p.png', type: 'image/png', lastModified: null } };
    const { intake } = await intakes.create(owner, { requestId: randomUUID(), text: '', parts: [part], metadata: { photos: [grant] } });
    await intakes.receivePart(intake.id, part.partId, SYNTHETIC_PHOTO);
    const { draftId } = JSON.parse(await readFile(path.join(dataDir, 'intakes', intake.id, 'intake.json'), 'utf8'));
    const note = path.join(dataDir, 'intakes', intake.id, 'parts', 'operator-note.txt');
    await writeFile(note, 'note\n');
    const hold = holdRename((to) => to === path.join(dataDir, 'drafts', draftId));
    try {
      const commit = intakes.commit(intake.id, owner, { requestId: randomUUID(), baseRevision: 1 });
      await hold.reached;
      const mark = places.commit(() => barrier(draftId));
      hold.release();
      await commit.catch(() => {});
      await mark;
      assert.equal(await readFile(note, 'utf8'), 'note\n', 'no recursive cleanup after the barrier');
      assert.equal(await exists(path.join(dataDir, 'intakes', intake.id, 'parts', `${part.partId}.bin`)), true, 'left for the guarded cleanup');
      assert.equal(JSON.parse(await readFile(path.join(dataDir, 'intakes', intake.id, 'intake.json'), 'utf8')).status, 'open', 'the refused record was not written');
    } finally {
      hold.restore();
    }
  });

  it('publishes an intake record before a later barrier, and refuses one after an earlier one', async () => {
    const { dataDir, places, drafts, barrier } = await stores();
    const intakes = new IntakeStore({ dataDir, drafts, placeCommits: places });
    const owner = { id: randomUUID() };
    const grant = { provider: 'Synthetic', origin: { kind: 'own', reference: '' }, permissions: { place: false, model: false, share: false }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
    for (const order of ['publish-first', 'barrier-first']) {
      const { intake } = await intakes.create(owner, { requestId: randomUUID(), text: 'Synthetic.', parts: [], metadata: { photos: [], text: grant } });
      const file = path.join(dataDir, 'intakes', intake.id, 'intake.json');
      const { draftId } = JSON.parse(await readFile(file, 'utf8'));
      const gate = deferred();
      const held = places.commit(() => gate.promise);
      const plan = { requestId: randomUUID(), baseRevision: 1, text: 'Synthetic changed text.', parts: [], metadata: { photos: [], text: grant } };
      let change;
      let mark;
      if (order === 'publish-first') {
        change = intakes.plan(intake.id, plan);
        await new Promise((resolve) => setTimeout(resolve, 20));
        mark = places.commit(() => barrier(draftId));
      } else {
        mark = places.commit(() => barrier(draftId));
        change = intakes.plan(intake.id, plan);
      }
      gate.resolve();
      await held;
      const outcome = await change.then(() => 'published', (error) => error.status);
      await mark;
      const stored = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(outcome, order === 'publish-first' ? 'published' : 409, order);
      assert.equal(stored.text, order === 'publish-first' ? 'Synthetic changed text.' : 'Synthetic.', order);
      assert.equal((await intakes.get(intake.id)).status, 'deleted', 'reads see the barrier');
    }
  });

  it('redeems or creates an invitation before a later barrier, and refuses both after an earlier one', async () => {
    const { dataDir, places, barrier } = await stores();
    const access = new AccessStore({ dataDir });
    const owner = freshCredentials();
    await access.bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...owner });
    access.usePlaceCommits(places);
    const ownerId = (await access.login(owner.accessKey)).principal.id;
    for (const order of ['first', 'barrier-first']) {
      const draftId = randomUUID();
      const token = generateSecret('invitation');
      if (order === 'first') {
        await access.createInvitation(ownerId, { requestId: randomUUID(), draftId, expiresInHours: 24, token });
        const gate = deferred();
        const held = places.commit(() => gate.promise);
        const redeem = access.redeemInvitation({ token, requestId: randomUUID(), displayName: 'Synthetic', ...freshCredentials() });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const mark = places.commit(() => barrier(draftId));
        gate.resolve();
        await held;
        assert.equal((await redeem).draftIds[0], draftId, 'redeemed before the barrier');
        await mark;
      } else {
        await access.createInvitation(ownerId, { requestId: randomUUID(), draftId, expiresInHours: 24, token });
        await places.commit(() => barrier(draftId));
        await assert.rejects(access.redeemInvitation({ token, requestId: randomUUID(), displayName: 'Synthetic', ...freshCredentials() }), { status: 403 });
        await assert.rejects(access.createInvitation(ownerId, { requestId: randomUUID(), draftId, expiresInHours: 24, token: generateSecret('invitation') }), { status: 404 });
        await access.revokePlace(draftId);
        assert.ok((await access.invitations(ownerId)).filter((item) => item.draftId === draftId).every((item) => item.status === 'revoked'));
      }
    }
  });
});

describe('build runner settlement', () => {
  it('settles a runner whose executable is missing, with its spawn error, from a real spawn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-runner-'));
    tempDirs.push(dir);
    const result = await Promise.race([
      pythonRunner({ python: path.join(dir, 'missing', 'python') })({ imagePath: path.join(dir, 'in.png'), outputDir: path.join(dir, 'out'), sourceId: randomUUID(), box: [0, 0, 1, 1], signal: new AbortController().signal }),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 2000)),
    ]);
    assert.deepEqual(result, { exitCode: null, stderr: '', spawnError: 'ENOENT' });
    assert.equal(await exists(path.join(dir, 'out')), false);
  });

  // Event simulation through the spawn seam, not an observed failed kill: a
  // child that has a pid reports an error (as a failed kill can) and only
  // closes later; the runner must not settle until it has closed.
  it('does not settle on an error while the child has a pid, only on its close', async () => {
    const original = childProcess.spawn;
    const child = new EventEmitter();
    child.pid = 4242;
    child.stderr = new EventEmitter();
    childProcess.spawn = () => child;
    syncBuiltinESMExports();
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-runner-'));
      tempDirs.push(dir);
      let settled = null;
      const running = pythonRunner({ python: '/simulated/python' })({ imagePath: path.join(dir, 'in.png'), outputDir: path.join(dir, 'out'), sourceId: randomUUID(), box: [0, 0, 1, 1], signal: new AbortController().signal })
        .then((value) => {
          settled = value;
        });
      child.stderr.emit('data', Buffer.from('synthetic stderr'));
      child.emit('error', Object.assign(new Error('kill failed'), { code: 'EPERM' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, null, 'still running after the error');
      child.emit('close', null);
      await running;
      assert.deepEqual(settled, { exitCode: null, stderr: 'synthetic stderr', spawnError: 'EPERM' });
    } finally {
      childProcess.spawn = original;
      syncBuiltinESMExports();
    }
  });
});
