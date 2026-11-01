import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { CollaborationStore } from '../collaboration.mjs';
import { DraftStore, RequestError, parseDraft } from '../drafts.mjs';
import { BudgetLedger, createMetaModel } from '../meta-model.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';
import { ShareStore, UNAVAILABLE } from '../shares.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Synthetic images and grids only; no personal media.
function png(width, height, fill = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), header, Buffer.alloc(36, fill)]);
}

function jpeg(width, height, fill = 0) {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), frame, Buffer.alloc(32, fill), Buffer.from([0xff, 0xd9])]);
}

const BOX = [4, 3, 20, 24];
const THUMBNAIL = jpeg(20, 15, 3);

async function writeOutputs({ imagePath, outputDir, sourceId, box }) {
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const surface = {
    source: {
      source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30],
      texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' },
      selected_object: { id: 'foreground', box_xyxy: box },
    },
    width: 4, height: 3, depth: Array(12).fill(3), foreground: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(4, 3), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify(surface),
    'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture) }),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(read, done) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

const tempDirs = [];
const stores = [];
after(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const status = (code) => (error) => error instanceof RequestError && error.status === code;
const unavailable = (error) => error instanceof RequestError && error.status === 404 && error.message === UNAVAILABLE;
const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;
const plan = (call) => ({ action: 'translate', targetId: 'selected-foreground', sourceId: call.sourceId, baseVersion: call.baseVersion, delta: [0.1, 0, 0], yawDelta: null, anchor: null, question: null, reason: 'Synthetic.' });

function fakeModel() {
  const calls = [];
  const model = async (call) => {
    calls.push(call);
    return { ok: true, model: 'synthetic', responseId: 'resp', usage: null, plan: plan(call) };
  };
  model.calls = calls;
  return model;
}

function open(dataDir, { runner = writeOutputs, model = fakeModel(), prepareImage = async () => THUMBNAIL } = {}) {
  const drafts = new DraftStore(dataDir);
  const reconstructions = new ReconstructionStore({ dataDir, drafts, runner, proposalModel: model, prepareImage });
  stores.push(reconstructions);
  return { drafts, reconstructions, collaboration: new CollaborationStore({ reconstructions }), shares: new ShareStore({ reconstructions }), model };
}

const grants = { place: true, model: true, share: true };
const source = (permissions = grants) => ({
  provider: 'Synthetic archive', origin: { kind: 'public', reference: 'https://example.org/item' }, permissions,
  dates: { capturedOn: '1936-07-01', fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: 'Summer' },
});

// A draft with two synthetic photos and written text; the first photo is built into a ready scene.
async function setup(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-policy-'));
  tempDirs.push(dataDir);
  const opened = open(dataDir, options);
  const form = new FormData();
  form.append('photos', new Blob([png(40, 30, 7)]), 'one');
  form.append('photos', new Blob([png(40, 30, 8)]), 'two');
  form.append('text', 'Synthetic note about the counter.');
  form.append('metadata', JSON.stringify({ photos: [source(), source()], text: source() }));
  const draft = await opened.drafts.create(await parseDraft(form));
  const [photo, other] = draft.photos.map((item) => item.sourceId);
  const ctx = {
    ...opened, dataDir, draft, draftId: draft.id, photo, other, textSource: draft.textSourceId,
    owner: { id: randomUUID(), role: 'owner', displayName: 'Owner', draftIds: [] },
    alex: { id: randomUUID(), role: 'contributor', displayName: 'Alex', draftIds: [draft.id] },
    draftDir: path.join(dataDir, 'drafts', draft.id),
  };
  ctx.build = async () => {
    const job = await ctx.reconstructions.create(ctx.draftId, { requestId: randomUUID(), sourceId: photo, box: BOX });
    return waitUntil(() => ctx.reconstructions.get(ctx.draftId, job.id), (item) => ['ready', 'failed', 'interrupted'].includes(item.status));
  };
  ctx.policy = (sourceId = photo) => ctx.reconstructions.sourcePolicy(ctx.draftId, sourceId, ctx.owner);
  ctx.restrict = async (change = {}, sourceId = photo) => {
    const current = await ctx.policy(sourceId);
    return ctx.reconstructions.restrictSource(ctx.draftId, sourceId, ctx.owner, {
      requestId: randomUUID(), baseRevision: current.revision, permissions: current.permissions, stopUse: false, ...change,
    });
  };
  ctx.share = async (jobId, version) => {
    const view = { id: randomUUID(), kind: 'version', version, variantId: null };
    const preview = await ctx.shares.createPreview(ctx.draftId, jobId, ctx.owner, {
      requestId: randomUUID(), title: 'Synthetic', views: [view], startViewId: view.id, camera: { position: [0, 0, 1], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
    });
    const token = visitToken();
    await ctx.shares.issue(ctx.draftId, jobId, ctx.owner, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true });
    return { token, viewId: view.id };
  };
  ctx.edit = (jobId, baseVersion) => ctx.reconstructions.edit(ctx.draftId, jobId, { requestId: randomUUID(), baseVersion, offset: [0, 0.1, 0], yaw: 0 });
  ctx.propose = (jobId, baseVersion) => ctx.reconstructions.createProposal(ctx.draftId, jobId, { requestId: randomUUID(), baseVersion, text: 'Move it left.', consent: true });
  ctx.settle = (jobId, id, statuses) => waitUntil(async () => (JSON.parse(await readFile(path.join(dataDir, 'reconstructions', ctx.draftId, jobId, 'manifest.json'), 'utf8')).proposals ?? []).find((item) => item.id === id), (item) => statuses.includes(item?.status));
  return ctx;
}

const fileHashes = async (dir) => Object.fromEntries(await Promise.all((await readdir(dir)).filter((name) => name !== 'policy.json').map(async (name) => [name, sha256(await readFile(path.join(dir, name)))])));

describe('source policy records', () => {
  it('starts from the recorded grants and only narrows, with replay that never restores grants', async () => {
    const ctx = await setup();
    assert.deepEqual({ ...(await ctx.policy()), sourceId: null }, {
      sourceId: null, revision: 0, permissions: grants, stopped: false, updatedAt: null, changedBy: null, impacts: { scenes: 0, stories: 0, snapshots: 0, processing: 0, linkedRegions: 0 },
    });
    const before = await fileHashes(ctx.draftDir);
    const requestId = randomUUID();
    const body = { requestId, baseRevision: 0, permissions: { place: true, model: false, share: true }, stopUse: false };
    const saved = await ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, body);
    assert.deepEqual([saved.saved, saved.revision, saved.permissions, saved.stopped, saved.changedBy], [true, 1, body.permissions, false, ctx.owner.id]);
    assert.deepEqual(saved.cancellation, { requested: false, status: 'not-running' });
    await assert.rejects(ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, { ...body, permissions: grants }), status(409));
    await assert.rejects(ctx.restrict({ permissions: grants }), status(409));
    await assert.rejects(ctx.restrict({ baseRevision: 0 }), status(409));
    const stopped = await ctx.restrict({ stopUse: true });
    assert.deepEqual([stopped.stopped, stopped.permissions], [true, { place: false, model: false, share: false }]);
    const replay = await ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, body);
    assert.deepEqual([replay.revision, replay.stopped], [2, true]);
    await assert.rejects(ctx.restrict({ stopUse: false }), status(409));
    assert.deepEqual(await fileHashes(ctx.draftDir), before);
    const other = await ctx.policy(ctx.other);
    assert.deepEqual([other.revision, other.permissions, other.stopped], [0, grants, false]);
    const reopened = open(ctx.dataDir);
    assert.equal((await reopened.reconstructions.sourcePolicy(ctx.draftId, ctx.photo, ctx.owner)).stopped, true);
    const file = JSON.parse(await readFile(path.join(ctx.draftDir, 'policy.json'), 'utf8'));
    assert.deepEqual(Object.keys(file.sources), [ctx.photo]);
  });

  it('checks the owner first and rejects malformed or unknown requests', async () => {
    const ctx = await setup();
    await assert.rejects(ctx.reconstructions.sourcePolicy(ctx.draftId, ctx.photo, null), status(401));
    await assert.rejects(ctx.reconstructions.restrictSource(ctx.draftId, randomUUID(), ctx.alex, {}), status(403));
    await assert.rejects(ctx.reconstructions.sourcePolicy(ctx.draftId, randomUUID(), ctx.owner), status(404));
    for (const body of [{}, { requestId: 'x', baseRevision: 0, permissions: grants, stopUse: false }, { requestId: randomUUID(), baseRevision: -1, permissions: grants, stopUse: false },
      { requestId: randomUUID(), baseRevision: 0, permissions: { place: true }, stopUse: false }, { requestId: randomUUID(), baseRevision: 0, permissions: grants, stopUse: 'yes' }]) {
      await assert.rejects(ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, body), status(400));
    }
  });

  it('keeps the restriction unsaved and the files unchanged when the policy cannot be written', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const ctx = await setup();
    await chmod(ctx.draftDir, 0o500);
    try {
      await assert.rejects(ctx.restrict({ stopUse: true }), status(503));
    } finally {
      await chmod(ctx.draftDir, 0o700);
    }
    assert.equal((await ctx.policy()).revision, 0);
    assert.ok(!(await readdir(ctx.draftDir)).some((name) => name.startsWith('policy.json')));
  });

  it('projects drafts and refuses archive files of stopped material only', async () => {
    const ctx = await setup();
    await ctx.restrict({ stopUse: true });
    await ctx.restrict({ stopUse: true }, ctx.textSource);
    const draft = await ctx.drafts.get(ctx.draftId);
    const projected = await ctx.reconstructions.sourcePolicies.projectDraft(draft);
    assert.equal(projected.text, '');
    assert.deepEqual(projected.photos.map((item) => item.sourceId), [ctx.other]);
    const marker = projected.sources.find((item) => item.id === ctx.photo);
    assert.deepEqual(Object.keys(marker).sort(), ['id', 'kind', 'permissions', 'policy', 'provider', 'role', 'sha256']);
    assert.equal(marker.policy.stopped, true);
    const kept = projected.sources.find((item) => item.id === ctx.other);
    assert.deepEqual([kept.permissions, kept.policy.stopped, kept.origin.reference], [grants, false, 'https://example.org/item']);
    assert.doesNotMatch(JSON.stringify(projected), /Synthetic note|photo-1\.png/);
    await assert.rejects(ctx.reconstructions.sourcePolicies.assertArchiveAsset(draft, draft.photos[0].name), status(409));
    await ctx.reconstructions.sourcePolicies.assertArchiveAsset(draft, draft.photos[1].name);
    assert.equal((await ctx.drafts.get(ctx.draftId)).text, 'Synthetic note about the counter.');
  });
});

describe('restricted photo uses', () => {
  it('stopping a photo blocks every version, proposal and snapshot of its scenes', async () => {
    const ctx = await setup();
    const job = await ctx.build();
    const clean = await ctx.share(job.id, 1);
    await ctx.edit(job.id, 1);
    const latest = await ctx.share(job.id, 2);
    const proposal = await ctx.propose(job.id, 2);
    await ctx.settle(job.id, proposal.id, ['ready']);
    const contribution = await ctx.collaboration.submit(ctx.draftId, job.id, ctx.alex, { requestId: randomUUID(), text: 'Synthetic.', permissions: grants, periodClaim: '' });
    const before = await fileHashes(ctx.draftDir);

    const saved = await ctx.restrict({ stopUse: true });
    assert.deepEqual(saved.impacts, { scenes: 1, stories: 0, snapshots: 2, processing: 0, linkedRegions: 0 });
    const scene = await ctx.reconstructions.get(ctx.draftId, job.id);
    assert.deepEqual([scene.usageBlocked, scene.modelBlocked, scene.blockedReason], [true, true, 'source']);
    await assert.rejects(ctx.reconstructions.asset(ctx.draftId, job.id, 'texture.jpg'), status(409));
    await assert.rejects(ctx.edit(job.id, 2), status(403));
    await assert.rejects(ctx.reconstructions.undo(ctx.draftId, job.id, { requestId: randomUUID(), baseVersion: 2, targetVersion: 1 }), status(403));
    await assert.rejects(ctx.propose(job.id, 2), status(403));
    await assert.rejects(ctx.reconstructions.applyProposal(ctx.draftId, job.id, proposal.id, { requestId: randomUUID(), baseVersion: 2, frontConfirmed: false }), status(403));
    await assert.rejects(ctx.collaboration.review(ctx.draftId, job.id, ctx.owner, contribution.id, {
      requestId: randomUUID(), baseVersion: 2, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { offset: [0, 0, 0], yaw: 0 },
    }), status(403));
    assert.ok((await ctx.reconstructions.history(ctx.draftId, job.id)).every((entry) => entry.blocked));
    const [listed] = await ctx.reconstructions.proposals(ctx.draftId, job.id);
    assert.deepEqual([listed.redacted, listed.statement.text, listed.result, listed.status], [true, null, null, 'stale']);
    for (const shared of [clean, latest]) {
      await assert.rejects(ctx.shares.visit(shared.token), unavailable);
      await assert.rejects(ctx.shares.visitAsset(shared.token, shared.viewId, 'texture.jpg'), unavailable);
    }
    assert.deepEqual(await fileHashes(ctx.draftDir), before);
    const stored = JSON.parse(await readFile(path.join(ctx.dataDir, 'reconstructions', ctx.draftId, job.id, 'manifest.json'), 'utf8'));
    assert.equal(stored.proposals[0].statement.text, 'Move it left.');
  });

  it('returns current policy flags when a finished build request is replayed', async () => {
    const ctx = await setup();
    const request = { requestId: randomUUID(), sourceId: ctx.photo, box: BOX };
    const job = await ctx.reconstructions.create(ctx.draftId, request);
    await waitUntil(() => ctx.reconstructions.get(ctx.draftId, job.id), (item) => item.status === 'ready');
    await ctx.restrict({ stopUse: true });
    const replay = await ctx.reconstructions.create(ctx.draftId, request);
    assert.deepEqual([replay.id, replay.usageBlocked, replay.modelBlocked, replay.blockedReason], [job.id, true, true, 'source']);
  });

  it('a share-only reduction stops visitors but not the private scene', async () => {
    const ctx = await setup();
    const job = await ctx.build();
    const shared = await ctx.share(job.id, 1);
    await ctx.restrict({ permissions: { place: true, model: true, share: false } });
    await assert.rejects(ctx.shares.visit(shared.token), unavailable);
    await assert.rejects(ctx.share(job.id, 1), status(403));
    assert.equal((await ctx.reconstructions.get(ctx.draftId, job.id)).usageBlocked, false);
    assert.ok(await ctx.reconstructions.asset(ctx.draftId, job.id, 'texture.jpg'));
    assert.equal((await ctx.edit(job.id, 1)).version, 2);
  });

  it('a model-only reduction stops new model work but keeps manual use, ready plans and sharing', async () => {
    const ctx = await setup();
    const job = await ctx.build();
    const proposal = await ctx.propose(job.id, 1);
    await ctx.settle(job.id, proposal.id, ['ready']);
    const shared = await ctx.share(job.id, 1);
    await ctx.restrict({ permissions: { place: true, model: false, share: true } });
    const scene = await ctx.reconstructions.get(ctx.draftId, job.id);
    assert.deepEqual([scene.usageBlocked, scene.modelBlocked, scene.blockedReason], [false, true, null]);
    await assert.rejects(ctx.propose(job.id, 1), status(403));
    await assert.rejects(ctx.reconstructions.create(ctx.draftId, { requestId: randomUUID(), sourceId: ctx.photo, box: BOX }), status(403));
    const calls = ctx.model.calls.length;
    const applied = await ctx.reconstructions.applyProposal(ctx.draftId, job.id, proposal.id, { requestId: randomUUID(), baseVersion: 1, frontConfirmed: false });
    assert.equal(applied.edit.version, 2);
    assert.equal(ctx.model.calls.length, calls);
    assert.equal((await ctx.edit(job.id, 2)).version, 3);
    assert.ok(await ctx.shares.visit(shared.token));
  });
});

describe('restrictions during running work', () => {
  it('publishes no scene when model use is turned off while the local model runs', async () => {
    const gate = deferred();
    const entered = deferred();
    const runner = async (job) => {
      entered.resolve();
      await gate.promise;
      return writeOutputs(job);
    };
    const ctx = await setup({ runner });
    const job = await ctx.reconstructions.create(ctx.draftId, { requestId: randomUUID(), sourceId: ctx.photo, box: BOX });
    await entered.promise;
    const saved = await ctx.restrict({ permissions: { place: true, model: false, share: true } });
    assert.deepEqual(saved.cancellation, { requested: true, status: 'requested' });
    gate.resolve();
    const done = await waitUntil(() => ctx.reconstructions.get(ctx.draftId, job.id), (item) => !['queued', 'processing'].includes(item.status));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /no scene was published/);
    await assert.rejects(stat(path.join(ctx.dataDir, 'reconstructions', ctx.draftId, job.id, 'assets')), { code: 'ENOENT' });
  });

  it('starts no local worker after a restriction saved while staging, even when the abort fails', async () => {
    const calls = [];
    const ctx = await setup({ runner: async (job) => { calls.push(job); return writeOutputs(job); } });
    // Holds the build after its first grant check, while it creates its own
    // staging folder and before the final grant check that admits the worker.
    const stagingRoot = path.join(ctx.dataDir, 'reconstruction-staging') + path.sep;
    const original = fs.promises.mkdir;
    const reached = deferred();
    const release = deferred();
    fs.promises.mkdir = async (target, ...rest) => {
      if (String(target).startsWith(stagingRoot)) {
        reached.resolve();
        await release.promise;
      }
      return original(target, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const job = await ctx.reconstructions.create(ctx.draftId, { requestId: randomUUID(), sourceId: ctx.photo, box: BOX });
      await reached.promise;
      const running = ctx.reconstructions.active.done;
      ctx.reconstructions.active.controller.abort = () => {
        throw new Error('termination failed');
      };
      const saved = await ctx.restrict({ permissions: { place: true, model: false, share: true } });
      assert.deepEqual(saved.cancellation, { requested: true, status: 'unconfirmed' });
      release.resolve();
      await running;
      assert.equal(calls.length, 0);
      const done = await ctx.reconstructions.get(ctx.draftId, job.id);
      assert.equal(done.status, 'failed');
      assert.match(done.error, /no scene was published/);
    } finally {
      release.resolve();
      fs.promises.mkdir = original;
      syncBuiltinESMExports();
    }
  });

  it('asks running work to stop again on an exact restriction replay and reports it truthfully', async () => {
    const gate = deferred();
    const entered = deferred();
    const ctx = await setup({ runner: async (job) => { entered.resolve(); await gate.promise; return writeOutputs(job); } });
    const job = await ctx.reconstructions.create(ctx.draftId, { requestId: randomUUID(), sourceId: ctx.photo, box: BOX });
    await entered.promise;
    let attempts = 0;
    ctx.reconstructions.active.controller.abort = () => {
      attempts += 1;
      throw new Error('termination failed');
    };
    const body = { requestId: randomUUID(), baseRevision: 0, permissions: { place: true, model: false, share: true }, stopUse: false };
    const first = await ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, body);
    const replay = await ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, body);
    assert.deepEqual([first.cancellation.status, replay.cancellation.status, replay.revision, attempts], ['unconfirmed', 'unconfirmed', 1, 2]);
    // The failed status is written before cleanup releases the build slot,
    // so wait for the run itself to finish before expecting nothing running.
    const running = ctx.reconstructions.active.done;
    gate.resolve();
    await running;
    assert.equal((await ctx.reconstructions.get(ctx.draftId, job.id)).status, 'failed');
    const idle = await ctx.reconstructions.restrictSource(ctx.draftId, ctx.photo, ctx.owner, body);
    assert.deepEqual(idle.cancellation, { requested: false, status: 'not-running' });
  });

  it('admits no token count after a restriction saved during image preparation', async () => {
    const gate = deferred();
    const started = deferred();
    const fetchCalls = [];
    const fetch = async (url) => {
      fetchCalls.push(url);
      return Response.json({ input_tokens: 10 });
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-ledger-'));
    tempDirs.push(dir);
    const model = createMetaModel({ apiKey: 'test-key-not-real', ledger: new BudgetLedger({ file: path.join(dir, 'ledger.json') }), fetch });
    const ctx = await setup({ model, prepareImage: async () => { started.resolve(); await gate.promise; return THUMBNAIL; } });
    const job = await ctx.build();
    const proposal = await ctx.propose(job.id, 1);
    await started.promise;
    await ctx.restrict({ permissions: { place: true, model: false, share: true } });
    gate.resolve();
    const settled = await ctx.settle(job.id, proposal.id, ['failed', 'interrupted']);
    assert.equal(fetchCalls.length, 0);
    assert.equal(settled.status, 'failed');
  });

  it('sends no generation after a restriction saved during counting, even when the abort fails', async () => {
    const countGate = deferred();
    const counting = deferred();
    const fetchCalls = [];
    const fetch = async (url) => {
      fetchCalls.push(url);
      if (url.endsWith('/input_tokens')) {
        counting.resolve();
        await countGate.promise;
        return Response.json({ input_tokens: 10 });
      }
      return Response.json({ id: 'resp', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 1 } });
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-ledger-'));
    tempDirs.push(dir);
    const ledgerFile = path.join(dir, 'ledger.json');
    const model = createMetaModel({ apiKey: 'test-key-not-real', ledger: new BudgetLedger({ file: ledgerFile }), fetch });
    const ctx = await setup({ model });
    const job = await ctx.build();
    const proposal = await ctx.propose(job.id, 1);
    await counting.promise;
    ctx.reconstructions.activeProposal.controller.abort = () => {
      throw new Error('termination failed');
    };
    const saved = await ctx.restrict({ permissions: { place: true, model: false, share: true } });
    assert.deepEqual([saved.saved, saved.permissions.model, saved.cancellation], [true, false, { requested: true, status: 'unconfirmed' }]);
    countGate.resolve();
    const settled = await ctx.settle(job.id, proposal.id, ['failed', 'interrupted']);
    assert.deepEqual(fetchCalls.map((url) => url.split('/v1/')[1]), ['responses/input_tokens']);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.result, null);
    const { entries } = JSON.parse(await readFile(ledgerFile, 'utf8'));
    assert.deepEqual(entries.map(({ state, estimatedUsd }) => [state, estimatedUsd]), [['settled', 0]]);
    assert.equal((await ctx.policy()).permissions.model, false);
  });

  it('linearizes a snapshot issue against a concurrent stop', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctx = await setup();
      const job = await ctx.build();
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const preview = await ctx.shares.createPreview(ctx.draftId, job.id, ctx.owner, {
        requestId: randomUUID(), title: 'Synthetic', views: [view], startViewId: view.id, camera: { position: [0, 0, 1], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
      });
      const token = visitToken();
      const [issued] = await Promise.allSettled([
        ctx.shares.issue(ctx.draftId, job.id, ctx.owner, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true }),
        ctx.restrict({ stopUse: true }),
      ]);
      if (issued.status === 'rejected') assert.ok(status(403)(issued.reason));
      await assert.rejects(ctx.shares.visit(token), unavailable);
    }
  });
});
