import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { client, enrolledContributor, png, readyScene, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const SECOND_PHOTO = png(40, 30, 9);
const TEXT = 'The bakery sign was green when I lived above it.';
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function workspace(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-policy-'));
  tempDirs.push(dataDir);
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

const grant = (permissions = {}) => ({
  provider: 'Synthetic', origin: { kind: 'public', reference: '' },
  permissions: { place: true, model: true, share: true, ...permissions },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

// A memory with two photos, writing and a recording, all synthetic.
async function mixedDraft(owner) {
  const form = new FormData();
  form.append('text', TEXT);
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'a.png');
  form.append('photos', new Blob([SECOND_PHOTO]), 'b.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [grant(), grant()], text: grant(), voice: grant() }));
  const response = await owner.request('/api/drafts', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  return response.json();
}

const policyOf = (draftId, sourceId) => `/api/drafts/${draftId}/sources/${sourceId}/policy`;
const restriction = (baseRevision, permissions, stopUse = false) => ({ requestId: randomUUID(), baseRevision, permissions, stopUse });
const ALL = { place: true, model: true, share: true };

async function restrict(owner, draftId, sourceId, permissions, stopUse = false) {
  const { revision } = await owner.json(policyOf(draftId, sourceId));
  const response = await owner.post(policyOf(draftId, sourceId), restriction(revision, permissions, stopUse));
  assert.equal(response.status, 200);
  return response.json();
}

async function denied(response, label) {
  assert.ok(![200, 206, 304, 416].includes(response.status), `${label}: ${response.status}`);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
}

async function filesUnder(dir) {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name !== 'policy.json') result[path.join(entry.parentPath, entry.name)] = sha256(await readFile(path.join(entry.parentPath, entry.name)));
  }
  return result;
}

const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;
async function snapshot(owner, scene, version) {
  const shares = `${scene.scene}/shares`;
  const view = { id: randomUUID(), kind: 'version', version, variantId: null };
  const preview = await owner.post(`${shares}/previews`, {
    requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id,
    camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
  });
  assert.equal(preview.status, 201);
  const { id, digest } = await preview.json();
  const token = visitToken();
  assert.equal((await owner.post(shares, { requestId: randomUUID(), previewId: id, previewDigest: digest, token, consent: true })).status, 201);
  return { token, viewId: view.id };
}
const visit = (base, token, route = '/api/visit') => globalThis.fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });

describe('source policy routes', () => {
  it('are owner-only and check identity before IDs or bodies', async () => {
    const { app, owner } = await workspace();
    try {
      const draft = await mixedDraft(owner);
      const route = policyOf(draft.id, draft.photos[0].sourceId);
      const { session: contributor } = await enrolledContributor(owner, app.base, draft.id);
      for (const target of [route, policyOf('not-an-id', 'x')]) {
        assert.equal((await client(app.base).request(target)).status, 401, target);
        assert.equal((await client(app.base).post(target, '{}')).status, 401, target);
        assert.equal((await contributor.request(target)).status, 403, target);
        assert.equal((await contributor.post(target, '{}')).status, 403, target);
      }
      assert.equal((await owner.request(policyOf('not-an-id', draft.photos[0].sourceId))).status, 404);
      assert.equal((await owner.request(policyOf(draft.id, randomUUID()))).status, 404);
      assert.equal((await owner.post(policyOf(draft.id, randomUUID()), restriction(0, ALL))).status, 404);
      for (const body of [{ ...restriction(0, ALL), extra: 1 }, (({ stopUse, ...rest }) => rest)(restriction(0, ALL)), '{broken']) {
        const response = await owner.post(route, body);
        assert.equal(response.status, 400, JSON.stringify(body).slice(0, 50));
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.equal((await owner.post(route, restriction(0, ALL), { origin: 'http://attacker.example' })).status, 403);
      const initial = await owner.json(route);
      assert.equal(initial.sourceId, draft.photos[0].sourceId);
      assert.equal(initial.revision, 0);
      assert.deepEqual(initial.permissions, ALL);
      assert.equal(initial.stopped, false);
    } finally {
      await app.close();
    }
  });

  it('only reduces uses, never reopens a stopped source and leaves every original byte unchanged', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const draft = await mixedDraft(owner);
      const before = await filesUnder(path.join(dataDir, 'drafts', draft.id));
      const route = policyOf(draft.id, draft.photos[0].sourceId);

      const reduce = restriction(0, { place: true, model: true, share: false });
      const saved = await owner.post(route, reduce);
      assert.equal(saved.status, 200);
      const body = await saved.json();
      assert.equal(body.saved, true);
      assert.equal(body.revision, 1);
      assert.deepEqual(body.permissions, { place: true, model: true, share: false });
      assert.equal(body.cancellation.status, 'not-running');
      assert.equal((await owner.post(route, reduce)).status, 200, 'exact replay');
      assert.equal((await owner.post(route, { ...reduce, stopUse: true })).status, 409, 'changed receipt');
      assert.equal((await owner.post(route, restriction(0, { place: true, model: false, share: false }))).status, 409, 'stale base');
      assert.equal((await owner.post(route, restriction(1, ALL))).status, 409, 'expansion');

      const stopBody = restriction(1, { place: false, model: false, share: false }, true);
      assert.equal((await owner.post(route, stopBody)).status, 200);
      assert.equal((await owner.post(route, restriction(2, { place: false, model: false, share: false }, false))).status, 409, 'unstop');
      const replayed = await owner.post(route, reduce);
      assert.equal(replayed.status, 200);
      assert.equal((await replayed.json()).stopped, true, 'an old receipt never restores grants');
      assert.equal((await owner.json(route)).stopped, true);

      assert.deepEqual(await filesUnder(path.join(dataDir, 'drafts', draft.id)), before);
      const other = await owner.json(policyOf(draft.id, draft.photos[1].sourceId));
      assert.equal(other.stopped, false);
      assert.deepEqual(other.permissions, ALL);

      // The policy survives a restart of the server.
      await app.close();
      const restarted = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner });
      try {
        assert.equal((await client(restarted.base, restarted.cookie).json(route)).stopped, true);
      } finally {
        await restarted.close();
      }
    } finally {
      await app.close();
    }
  });
});

describe('archive reads after a stop', () => {
  it('hides stopped writing, photos and recordings from drafts, summaries and raw asset reads per source', async () => {
    const { app, owner } = await workspace();
    try {
      const draft = await mixedDraft(owner);
      const [stoppedPhoto, keptPhoto] = draft.photos;
      const asset = (photo) => `/api/drafts/${draft.id}/assets/${photo.name}`;
      for (const sourceId of [stoppedPhoto.sourceId, draft.textSourceId, draft.voice.sourceId]) {
        await restrict(owner, draft.id, sourceId, { place: false, model: false, share: false }, true);
      }
      const projected = await owner.json(`/api/drafts/${draft.id}`);
      assert.equal(projected.text, '');
      assert.equal(projected.voice, null);
      assert.deepEqual(projected.photos.map((photo) => photo.sourceId), [keptPhoto.sourceId]);
      const serialized = JSON.stringify(projected);
      for (const hidden of [TEXT, stoppedPhoto.name, draft.voice.name]) assert.ok(!serialized.includes(hidden), hidden);
      const marker = projected.sources.find((source) => source.id === stoppedPhoto.sourceId);
      assert.ok(marker, 'the stopped source keeps a limited marker');
      assert.ok(!('name' in marker) && !('origin' in marker), 'no original file name or origin reference');

      const summary = (await owner.json('/api/drafts')).find((item) => item.id === draft.id);
      assert.deepEqual(summary, { id: draft.id, createdAt: draft.createdAt, photoCount: 1, hasVoice: false, textPreview: '' });

      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-3' } }, { headers: { range: 'bytes=999999-' } }, { headers: { 'if-none-match': '*' } }]) {
        await denied(await owner.request(asset(stoppedPhoto), init), `photo ${JSON.stringify(init)}`);
        await denied(await owner.request(`/api/drafts/${draft.id}/assets/${draft.voice.name}`, init), `voice ${JSON.stringify(init)}`);
      }
      const kept = await owner.request(asset(keptPhoto));
      assert.equal(kept.status, 200);
      assert.equal(sha256(Buffer.from(await kept.arrayBuffer())), sha256(SECOND_PHOTO));
    } finally {
      await app.close();
    }
  });
});

describe('derived uses after a restriction', () => {
  it('blocks every version and snapshot of a stopped photo, and undo cannot restore them', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      // A version view must be the current saved version when it is shared.
      const old = await snapshot(owner, scene, 1);
      assert.equal((await owner.post(`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0.5, 0, 0], yaw: 0 })).status, 200);
      const latest = await snapshot(owner, scene, 2);
      const result = await restrict(owner, scene.draft.id, scene.draft.photos[0].sourceId, { place: false, model: false, share: false }, true);
      assert.equal(result.stopped, true);

      assert.equal((await owner.json(scene.scene)).usageBlocked, true);
      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-3' } }]) await denied(await owner.request(scene.asset, init), 'scene asset');
      for (const { token, viewId } of [old, latest]) {
        await denied(await visit(app.base, token), 'snapshot');
        await denied(await visit(app.base, token, `/api/visit/assets/${viewId}/texture.jpg`), 'snapshot asset');
      }
      await denied(await owner.post(`${scene.scene}/undo`, { requestId: randomUUID(), baseVersion: 2, targetVersion: 1 }), 'undo');
      await denied(await owner.post(`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 2, offset: [0, 0, 0], yaw: 0 }), 'edit');
      assert.equal((await owner.json(scene.scene)).usageBlocked, true);
    } finally {
      await app.close();
    }
  });

  it('stops visitors after a share-only reduction but keeps the owner\'s private view and editing', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const shared = await snapshot(owner, scene, 1);
      assert.equal((await visit(app.base, shared.token)).status, 200);
      await restrict(owner, scene.draft.id, scene.draft.photos[0].sourceId, { place: true, model: true, share: false });
      await denied(await visit(app.base, shared.token), 'visit');
      assert.equal((await owner.request(scene.asset)).status, 200);
      assert.equal((await owner.post(`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0, 0, 0.5], yaw: 0 })).status, 200);
      const view = { id: randomUUID(), kind: 'version', version: 2, variantId: null };
      const preview = await owner.post(`${scene.scene}/shares/previews`, {
        requestId: randomUUID(), title: 'x', views: [view], startViewId: view.id,
        camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
      });
      assert.equal(preview.status, 403, 'no new share without the source share grant');
    } finally {
      await app.close();
    }
  });

  it('stops new model work after a model-only reduction but keeps manual editing and existing sharing', async () => {
    const calls = [];
    const { app, owner } = await workspace({
      proposalModel: async (call) => {
        calls.push(call);
        return { ok: false, reason: 'provider', model: null, responseId: null, usage: null };
      },
      prepareModelImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    try {
      const scene = await readyScene(owner, { share: true });
      const shared = await snapshot(owner, scene, 1);
      await restrict(owner, scene.draft.id, scene.draft.photos[0].sourceId, { place: true, model: false, share: true });
      const proposal = await owner.post(`${scene.scene}/proposals`, { requestId: randomUUID(), baseVersion: 1, text: 'Turn it toward the light.', consent: true });
      assert.ok([403, 409].includes(proposal.status), String(proposal.status));
      assert.equal(calls.length, 0);
      assert.equal((await owner.post(`${scene.scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0, 0, 0.5], yaw: 0 })).status, 200);
      assert.equal((await visit(app.base, shared.token)).status, 200);
      assert.equal((await visit(app.base, shared.token, `/api/visit/assets/${shared.viewId}/texture.jpg`)).status, 200);
    } finally {
      await app.close();
    }
  });
});
