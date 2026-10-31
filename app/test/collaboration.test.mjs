import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { CollaborationStore } from '../collaboration.mjs';
import { DraftStore, RequestError, parseDraft } from '../drafts.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';

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

const PHOTO = png(40, 30, 7);
const BOX = [4, 3, 20, 24];
const THUMBNAIL = jpeg(20, 15, 3);

async function runner({ imagePath, outputDir, sourceId, box }) {
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

function fakeModel() {
  const calls = [];
  const model = async (call) => {
    calls.push(call);
    return {
      ok: true, model: 'synthetic', responseId: `resp_${calls.length}`, usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 },
      plan: { action: 'translate', targetId: 'selected-foreground', sourceId: call.sourceId, baseVersion: call.baseVersion, delta: [0.1, 0, 0], yawDelta: null, anchor: null, question: null, reason: 'Synthetic.' },
    };
  };
  model.calls = calls;
  return model;
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

function open(dataDir, { model = fakeModel(), prepareImage = async () => THUMBNAIL } = {}) {
  const drafts = new DraftStore(dataDir);
  const reconstructions = new ReconstructionStore({ dataDir, drafts, runner, proposalModel: model, prepareImage });
  stores.push(reconstructions);
  return { drafts, reconstructions, collaboration: new CollaborationStore({ reconstructions }), model };
}

// A ready scene on a public, fully granted synthetic photo, with an owner,
// two scoped contributors and one contributor scoped to another place.
async function setup(options) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-collaboration-'));
  tempDirs.push(dataDir);
  const opened = open(dataDir, options);
  const form = new FormData();
  form.append('photos', new Blob([PHOTO]), 'photo');
  form.append('metadata', JSON.stringify({ photos: [{
    provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: false },
    dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  }] }));
  const draft = await opened.drafts.create(await parseDraft(form));
  const job = await opened.reconstructions.create(draft.id, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: BOX });
  await waitUntil(() => opened.reconstructions.get(draft.id, job.id), (item) => item.status === 'ready');
  const person = (role, displayName, draftIds) => ({ id: randomUUID(), role, displayName, draftIds });
  const ctx = {
    ...opened,
    dataDir,
    draftId: draft.id,
    jobId: job.id,
    sourceId: draft.photos[0].sourceId,
    owner: person('owner', 'Owner', []),
    alex: person('contributor', 'Alex', [draft.id]),
    blair: person('contributor', 'Blair', [draft.id]),
    outsider: person('contributor', 'Casey', [randomUUID()]),
    manifestFile: path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json'),
  };
  ctx.submit = (principal, change = {}) => ctx.collaboration.submit(ctx.draftId, ctx.jobId, principal, {
    requestId: randomUUID(), text: 'The counter stood by the window, facing the door.', permissions: { place: true, model: true, share: false }, periodClaim: '', ...change,
  });
  ctx.review = (contribution, change = {}) => ctx.collaboration.review(ctx.draftId, ctx.jobId, ctx.owner, contribution.id, {
    requestId: randomUUID(), baseVersion: 1, baseRevision: contribution.revision, decision: 'adopt', reason: 'Matches the window light.', conflict: 'unknown',
    transform: { offset: [0.5, 0, 0], yaw: 0.25 }, ...change,
  });
  ctx.withdraw = (principal, contribution, requestId = randomUUID()) => ctx.collaboration.withdraw(ctx.draftId, ctx.jobId, principal, contribution.id, { requestId });
  ctx.era = (variant, change = {}) => ctx.collaboration.era(ctx.draftId, ctx.jobId, ctx.owner, variant.id, {
    requestId: randomUUID(), baseRevision: variant.eraRevision, kind: 'unknown', label: '', start: null, end: null, statement: '', relation: null, relativeToVariantId: null, confirmed: false, ...change,
  });
  ctx.edit = (baseVersion, offset = [0, 0.1, 0]) => ctx.reconstructions.edit(ctx.draftId, ctx.jobId, { requestId: randomUUID(), baseVersion, offset, yaw: 0 });
  ctx.undo = (baseVersion, targetVersion) => ctx.reconstructions.undo(ctx.draftId, ctx.jobId, { requestId: randomUUID(), baseVersion, targetVersion });
  ctx.scene = () => ctx.reconstructions.get(ctx.draftId, ctx.jobId);
  ctx.stored = async () => JSON.parse(await readFile(ctx.manifestFile, 'utf8'));
  ctx.owned = () => ctx.collaboration.get(ctx.draftId, ctx.jobId, ctx.owner);
  ctx.propose = (baseVersion) => ctx.reconstructions.createProposal(ctx.draftId, ctx.jobId, { requestId: randomUUID(), baseVersion, text: 'Move it left.', consent: true });
  ctx.settle = (id, statuses) => waitUntil(() => ctx.reconstructions.proposal(ctx.draftId, ctx.jobId, id), (item) => statuses.includes(item.status));
  return ctx;
}

describe('collaboration scope', () => {
  it('checks the principal and scope before IDs, bodies or existence', async () => {
    const ctx = await setup();
    const unknownJob = randomUUID();
    await assert.rejects(ctx.collaboration.get(ctx.draftId, ctx.jobId, null), status(401));
    await assert.rejects(ctx.collaboration.get(ctx.draftId, unknownJob, ctx.outsider), status(403));
    await assert.rejects(ctx.collaboration.submit(ctx.draftId, unknownJob, ctx.outsider, { junk: true }), status(403));
    await assert.rejects(ctx.collaboration.review(ctx.draftId, unknownJob, ctx.alex, randomUUID(), { junk: true }), status(403));
    await assert.rejects(ctx.collaboration.era(ctx.draftId, unknownJob, ctx.alex, randomUUID(), { junk: true }), status(403));
    await assert.rejects(ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, { junk: true }), status(400));
    await assert.rejects(ctx.collaboration.get(ctx.draftId, unknownJob, ctx.alex), status(404));
    await assert.rejects(ctx.collaboration.get(ctx.draftId, unknownJob, ctx.owner), status(404));
  });

  it('lists only scoped ready places without source details', async () => {
    const ctx = await setup();
    const expected = [{ draftId: ctx.draftId, jobId: ctx.jobId, label: `Saved place ${ctx.draftId.slice(0, 8)}`, version: 1 }];
    assert.deepEqual(await ctx.collaboration.places(ctx.alex), expected);
    assert.deepEqual(await ctx.collaboration.places(ctx.owner), expected);
    assert.deepEqual(await ctx.collaboration.places(ctx.outsider), []);
    await assert.rejects(ctx.collaboration.places(null), status(401));
  });
});

describe('contributions', () => {
  it('stores an original recollection without changing the scene, with exact replay', async () => {
    const ctx = await setup();
    const requestId = randomUUID();
    const text = 'It was turned toward the door. \u00e9';
    const body = { requestId, text, permissions: { place: true, model: false, share: false }, periodClaim: 'Around a summer' };
    const submitted = await ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, body);
    assert.deepEqual({ ...submitted, id: null, createdAt: null }, {
      id: null, principalId: ctx.alex.id, provider: { displayName: 'Alex' }, kind: 'human_recollection', text, periodClaim: 'Around a summer',
      textSha256: sha256(Buffer.from(text, 'utf8')), permissions: { place: true, model: false, share: false }, createdAt: null,
      revision: 1, status: 'submitted', review: null, withdrawnAt: null,
    });
    assert.deepEqual(await ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, body), submitted);
    await assert.rejects(ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, { ...body, text: 'Changed.' }), status(409));
    await assert.rejects(ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.blair, body), status(409));
    assert.deepEqual((await ctx.scene()).edit, { version: 1, offset: [0, 0, 0], yaw: 0 });

    const owned = await ctx.owned();
    assert.equal(owned.contributions.length, 1);
    assert.deepEqual(owned.variants.map(({ label, parentVersion, edit, contributionIds, createdBy, blocked, eraRevision }) =>
      ({ label, parentVersion, edit, contributionIds, createdBy, blocked, eraRevision })), [
      { label: 'Saved reconstruction', parentVersion: 1, edit: { version: 1, offset: [0, 0, 0], yaw: 0 }, contributionIds: [], createdBy: null, blocked: false, eraRevision: 0 },
    ]);
    assert.equal(owned.variants[0].era.kind, 'unknown');
  });

  it('validates text, grants and the time claim strictly', async () => {
    const ctx = await setup();
    const base = { requestId: randomUUID(), text: 'x', permissions: { place: false, model: false, share: false }, periodClaim: '' };
    const invalid = [
      { text: '   ' }, { text: 'a'.repeat(10_001) }, { text: 'bad\u0007' }, { periodClaim: 'p'.repeat(301) },
      { permissions: { place: true, model: true } }, { permissions: { place: 'yes', model: false, share: false } }, { extra: 1 },
    ];
    for (const change of invalid) {
      await assert.rejects(ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, { ...base, requestId: randomUUID(), ...change }), status(400), JSON.stringify(change).slice(0, 40));
    }
    const long = await ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, { ...base, text: 'a'.repeat(10_000) });
    assert.equal(long.text.length, 10_000);
  });

  it('shows a contributor only their own entries, without owner notes or variants', async () => {
    const ctx = await setup();
    const own = await ctx.submit(ctx.alex);
    await ctx.submit(ctx.blair, { text: 'Blair remembers it differently.' });
    const reviewed = await ctx.review(own, { decision: 'hold', transform: null, reason: 'Blair disagrees; check with Blair.', conflict: 'memory' });
    assert.equal(reviewed.contribution.review.reason, 'Blair disagrees; check with Blair.');
    const view = await ctx.collaboration.get(ctx.draftId, ctx.jobId, ctx.alex);
    assert.deepEqual(Object.keys(view).sort(), ['blocked', 'blockedReason', 'contributions', 'currentVersion', 'modelBlocked', 'revision', 'variants']);
    assert.equal(view.blockedReason, null);
    assert.deepEqual(view.variants, []);
    assert.deepEqual(view.contributions.map((item) => item.id), [own.id]);
    assert.deepEqual(Object.keys(view.contributions[0].review).sort(), ['decision', 'reviewedAt', 'variantId', 'version']);
    assert.doesNotMatch(JSON.stringify(view), /Blair/);
  });
});

describe('review', () => {
  it('adopts atomically: new version, dependency receipt, candidate variant, stale proposals', async () => {
    const ctx = await setup();
    const proposal = await ctx.propose(1);
    await ctx.settle(proposal.id, ['ready']);
    const contribution = await ctx.submit(ctx.alex);
    const result = await ctx.review(contribution);
    assert.deepEqual(result.edit, { version: 2, offset: [0.5, 0, 0], yaw: 0.25 });
    assert.equal(result.contribution.status, 'adopted');
    assert.deepEqual({ ...result.variant, id: null, createdAt: null, era: null }, {
      id: null, label: "Alex's recollection", parentVersion: 1, edit: { version: 2, offset: [0.5, 0, 0], yaw: 0.25 }, contributionIds: [contribution.id],
      createdAt: null, createdBy: ctx.owner.id, era: null, eraRevision: 0, blocked: false,
    });
    const stored = await ctx.stored();
    assert.deepEqual(stored.edit, result.edit);
    assert.deepEqual(stored.edits.at(-1).dependencies, [contribution.id]);
    assert.equal(stored.edits.at(-1).kind, 'contribution');
    assert.equal(stored.proposals[0].status, 'stale');
    assert.equal((await ctx.scene()).collaboration, undefined);
  });

  it('replays exactly, rejects changes, stale revisions, versions and final decisions', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    const requestId = randomUUID();
    const first = await ctx.review(contribution, { requestId });
    assert.deepEqual(await ctx.review(contribution, { requestId }), first);
    await assert.rejects(ctx.review(contribution, { requestId, reason: 'Other.' }), status(409));
    await assert.rejects(ctx.review(contribution, { decision: 'reject', transform: null }), status(409));
    const second = await ctx.submit(ctx.blair);
    await assert.rejects(ctx.review(second, { baseRevision: 2, decision: 'hold', transform: null }), status(409));
    await assert.rejects(ctx.review(second, { baseVersion: 1 }), status(409));
    for (const change of [{ decision: 'hold' }, { decision: 'adopt', transform: null }, { transform: { offset: [3, 0, 0], yaw: 0 } }, { conflict: 'fact' }, { reason: 'r'.repeat(1001) }]) {
      await assert.rejects(ctx.review(second, { baseVersion: 2, ...change }), status(400), JSON.stringify(change));
    }
  });

  it('keeps an alternative without changing the saved scene', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    const { variant, edit, contribution: reviewed } = await ctx.review(contribution, { decision: 'alternative', conflict: 'viewpoint' });
    assert.equal(edit, null);
    assert.equal(reviewed.status, 'alternative');
    assert.deepEqual(variant.edit, { version: null, offset: [0.5, 0, 0], yaw: 0.25 });
    assert.equal(variant.parentVersion, 1);
    // A viewpoint conflict never assigns a time.
    assert.equal(variant.era.kind, 'unknown');
    assert.deepEqual((await ctx.scene()).edit, { version: 1, offset: [0, 0, 0], yaw: 0 });
  });

  it('needs a place grant for geometry; model:false still allows manual adoption', async () => {
    const ctx = await setup();
    const noPlace = await ctx.submit(ctx.alex, { permissions: { place: false, model: true, share: true } });
    await assert.rejects(ctx.review(noPlace), status(403));
    const held = await ctx.review(noPlace, { decision: 'hold', transform: null });
    assert.equal(held.contribution.status, 'held');
    const noModel = await ctx.submit(ctx.blair, { permissions: { place: true, model: false, share: false } });
    assert.equal((await ctx.review(noModel)).edit.version, 2);
  });

  it('leaves no review applied when the manifest cannot be saved', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    const before = await readFile(ctx.manifestFile, 'utf8');
    const dir = path.dirname(ctx.manifestFile);
    await chmod(dir, 0o500);
    try {
      await assert.rejects(ctx.review(contribution));
    } finally {
      await chmod(dir, 0o700);
    }
    assert.equal(await readFile(ctx.manifestFile, 'utf8'), before);
    assert.equal((await ctx.review(contribution)).edit.version, 2);
  });
});

describe('dependencies and withdrawal', () => {
  it('propagates dependencies through manual edits, model applies and undo', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution);
    await ctx.edit(2);
    const proposal = await ctx.propose(3);
    await ctx.settle(proposal.id, ['ready']);
    await ctx.reconstructions.applyProposal(ctx.draftId, ctx.jobId, proposal.id, { requestId: randomUUID(), baseVersion: 3, frontConfirmed: false });
    await ctx.undo(4, 1);
    const deps = (await ctx.stored()).edits.map((item) => [item.version, item.kind ?? 'manual', item.dependencies]);
    assert.deepEqual(deps, [[2, 'contribution', [contribution.id]], [3, 'manual', [contribution.id]], [4, 'proposal', [contribution.id]], [5, 'undo', []]]);
  });

  it('blocks a dependent scene everywhere after withdrawal until an unaffected version is restored', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution);
    await ctx.edit(2);
    const proposal = await ctx.propose(3);
    await ctx.settle(proposal.id, ['ready']);
    const withdrawn = await ctx.withdraw(ctx.alex, contribution);
    assert.equal(withdrawn.text, null);
    assert.equal(withdrawn.status, 'withdrawn');

    const scene = await ctx.scene();
    assert.equal(scene.usageBlocked, true);
    assert.equal((await ctx.reconstructions.list(ctx.draftId))[0].usageBlocked, true);
    await assert.rejects(ctx.reconstructions.asset(ctx.draftId, ctx.jobId, 'texture.jpg'), status(409));
    await assert.rejects(ctx.edit(3), status(409));
    await assert.rejects(ctx.propose(3), status(409));
    await assert.rejects(ctx.reconstructions.applyProposal(ctx.draftId, ctx.jobId, proposal.id, { requestId: randomUUID(), baseVersion: 3, frontConfirmed: false }), status(409));
    await assert.rejects(ctx.undo(3, 2), status(409));
    const history = await ctx.reconstructions.history(ctx.draftId, ctx.jobId);
    assert.deepEqual(history.map(({ version, blocked }) => [version, blocked]), [[1, false], [2, true], [3, true]]);

    const owned = await ctx.owned();
    assert.equal(owned.blocked, true);
    assert.equal(owned.contributions[0].text, null);
    assert.equal(owned.contributions[0].periodClaim, null);
    assert.equal(owned.contributions[0].textSha256, contribution.textSha256);
    assert.deepEqual(owned.variants.map((item) => item.blocked), [false, true]);
    await assert.rejects(ctx.era(owned.variants[1]), status(409));
    // The private original stays on disk, never in any projection.
    assert.equal((await ctx.stored()).collaboration.contributions[0].text, contribution.text);

    assert.equal((await ctx.undo(3, 1)).version, 4);
    assert.equal((await ctx.scene()).usageBlocked, false);
    assert.ok(await ctx.reconstructions.asset(ctx.draftId, ctx.jobId, 'texture.jpg'));
  });

  it('stops projecting owner notes and era text that may quote a withdrawn recollection', async () => {
    const ctx = await setup();
    const original = 'The counter stood by the window, facing the door.';
    const contribution = await ctx.submit(ctx.alex, { text: original });
    const { variant } = await ctx.review(contribution, { decision: 'alternative', reason: `Alex wrote: "${original}"`, conflict: 'memory' });
    await ctx.era(variant, { kind: 'range', label: original, start: '1990-01-01', end: '1995-12-31', statement: `Quoting Alex: ${original}`, confirmed: true });
    await ctx.withdraw(ctx.alex, contribution);

    const owned = await ctx.owned();
    assert.equal(owned.contributions[0].review.reason, null);
    assert.equal(owned.contributions[0].review.conflict, 'memory');
    const [, blocked] = owned.variants;
    assert.equal(blocked.blocked, true);
    assert.deepEqual({ kind: blocked.era.kind, label: blocked.era.label, start: blocked.era.start, end: blocked.era.end, statement: blocked.era.statement, confirmed: blocked.era.confirmed },
      { kind: 'range', label: null, start: null, end: null, statement: null, confirmed: true });
    assert.ok(!JSON.stringify(owned).includes(original));
    assert.ok(!JSON.stringify(await ctx.reconstructions.get(ctx.draftId, ctx.jobId)).includes(original));
    // Kept privately on disk for the audit record.
    const stored = (await ctx.stored()).collaboration;
    assert.match(stored.contributions[0].review.reason, /facing the door/);
    assert.equal(stored.variants[1].eraAssertions[0].label, original);
  });

  it('lets only the provider withdraw, idempotently, and redacts replayed submissions', async () => {
    const ctx = await setup();
    const submitBody = { requestId: randomUUID(), text: 'Original wording.', permissions: { place: true, model: true, share: false }, periodClaim: 'Spring' };
    const contribution = await ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, submitBody);
    await assert.rejects(ctx.withdraw(ctx.owner, contribution), status(403));
    await assert.rejects(ctx.withdraw(ctx.blair, contribution), status(404));
    // Recovery keeps the principal ID and grants, so the same identity can withdraw.
    const recovered = { ...ctx.alex };
    const requestId = randomUUID();
    const first = await ctx.withdraw(recovered, contribution, requestId);
    assert.deepEqual(await ctx.withdraw(recovered, contribution, requestId), first);
    await assert.rejects(ctx.withdraw(recovered, contribution), status(409));
    const replayed = await ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, submitBody);
    assert.equal(replayed.text, null);
    assert.equal(replayed.status, 'withdrawn');
    await assert.rejects(ctx.review(replayed, { decision: 'hold', transform: null }), status(409));
  });

  it('serializes a concurrent adoption and withdrawal into a blocked or rejected result', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctx = await setup();
      const contribution = await ctx.submit(ctx.alex);
      const [adopted] = await Promise.allSettled([ctx.review(contribution), ctx.withdraw(ctx.alex, contribution)]);
      const scene = await ctx.scene();
      if (adopted.status === 'fulfilled') assert.equal(scene.usageBlocked, true);
      else assert.deepEqual(scene.edit, { version: 1, offset: [0, 0, 0], yaw: 0 });
    }
  });

  it('blocks hosted model use when an inherited contribution lacks a model grant', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex, { permissions: { place: true, model: false, share: false } });
    await ctx.review(contribution);
    assert.equal((await ctx.scene()).modelBlocked, true);
    await assert.rejects(ctx.propose(2), status(403));
    assert.equal(ctx.model.calls.length, 0);
    assert.equal((await ctx.edit(2)).version, 3);
    await assert.rejects(ctx.propose(3), status(403));
    assert.equal((await ctx.undo(3, 1)).version, 4);
    const proposal = await ctx.propose(4);
    await ctx.settle(proposal.id, ['ready']);
  });

  it('never sends a proposal to the model after a withdrawal during image preparation', async () => {
    const gate = deferred();
    const started = deferred();
    const model = fakeModel();
    const ctx = await setup({ model, prepareImage: async () => { started.resolve(); await gate.promise; return THUMBNAIL; } });
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution);
    const proposal = await ctx.propose(2);
    await started.promise;
    await ctx.withdraw(ctx.alex, contribution);
    gate.resolve();
    const settled = await waitUntil(async () => (await ctx.stored()).proposals[0], (item) => ['failed', 'interrupted'].includes(item.status));
    assert.equal(model.calls.length, 0);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error, /withdrawn/);
  });

  it('aborts an in-flight model call on withdrawal even after an undo made the proposal stale', async () => {
    const gate = deferred();
    const calls = [];
    const model = async (call) => {
      calls.push(call);
      await gate.promise;
      return { ok: false, reason: 'provider', model: 'synthetic', usage: null, responseId: null };
    };
    model.calls = calls;
    const ctx = await setup({ model });
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution);
    const proposal = await ctx.propose(2);
    await waitUntil(async () => calls.length, (count) => count === 1);
    await ctx.undo(2, 1);
    assert.equal((await ctx.stored()).proposals[0].status, 'stale');
    assert.equal(calls[0].signal.aborted, false);
    await ctx.withdraw(ctx.alex, contribution);
    assert.equal(calls[0].signal.aborted, true);
    gate.resolve();
    await waitUntil(async () => ctx.reconstructions.activeProposal, (active) => active === null);
    assert.equal(calls.length, 1);
    assert.equal((await ctx.stored()).proposals[0].id, proposal.id);
  });

  it('redacts proposals made from a withdrawn base on every route, also after restoring a clean version and restart', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution);
    const applyBody = { requestId: randomUUID(), baseVersion: 2, frontConfirmed: false };
    const applied = await ctx.propose(2);
    await ctx.settle(applied.id, ['ready']);
    await ctx.reconstructions.applyProposal(ctx.draftId, ctx.jobId, applied.id, applyBody);
    const createBody = { requestId: randomUUID(), baseVersion: 3, text: 'Turn it toward the light.', consent: true };
    const pending = await ctx.reconstructions.createProposal(ctx.draftId, ctx.jobId, createBody);
    await ctx.settle(pending.id, ['ready']);
    await ctx.withdraw(ctx.alex, contribution);

    const redacted = (item, id) => {
      assert.equal(item.id, id);
      assert.deepEqual([item.status, item.redacted, item.statement.text, item.result, item.question], ['stale', true, null, null, null]);
      assert.match(item.error, /withdrawn contribution/);
      assert.equal(typeof item.statement.sha256, 'string');
    };
    redacted(await ctx.reconstructions.cancelProposal(ctx.draftId, ctx.jobId, pending.id), pending.id);
    assert.equal((await ctx.undo(3, 1)).version, 4);
    assert.equal((await ctx.scene()).usageBlocked, false);

    const check = async (store) => {
      const list = await store.proposals(ctx.draftId, ctx.jobId);
      redacted(list.find((item) => item.id === applied.id), applied.id);
      redacted(list.find((item) => item.id === pending.id), pending.id);
      redacted(await store.proposal(ctx.draftId, ctx.jobId, applied.id), applied.id);
      redacted(await store.createProposal(ctx.draftId, ctx.jobId, createBody), pending.id);
      redacted((await store.applyProposal(ctx.draftId, ctx.jobId, applied.id, applyBody)).proposal, applied.id);
    };
    await check(ctx.reconstructions);
    await ctx.reconstructions.close();
    await check(open(ctx.dataDir).reconstructions);

    const [, variant] = (await ctx.owned()).variants;
    assert.equal(variant.label, 'Blocked reconstruction');
    const stored = await ctx.stored();
    assert.equal(stored.proposals.find((item) => item.id === pending.id).statement.text, createBody.text);
    assert.ok(stored.proposals.find((item) => item.id === applied.id).result);
    assert.equal(stored.collaboration.variants[1].label, "Alex's recollection");
  });

  it('keeps the source photo, its metadata and the draft unchanged', async () => {
    const ctx = await setup();
    const draftFile = path.join(ctx.dataDir, 'drafts', ctx.draftId, 'draft.json');
    const before = await readFile(draftFile, 'utf8');
    const photo = await ctx.drafts.asset(ctx.draftId, (await ctx.drafts.get(ctx.draftId)).sources[0].name);
    const bytes = await readFile(photo.file);
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution);
    await ctx.withdraw(ctx.alex, contribution);
    assert.equal(await readFile(draftFile, 'utf8'), before);
    assert.deepEqual(await readFile(photo.file), bytes);
  });
});

describe('owner time assertions', () => {
  it('records explicit assertions separately, keeps history and never invents a year', async () => {
    const ctx = await setup();
    const alt = (await ctx.review(await ctx.submit(ctx.alex), { decision: 'alternative', conflict: 'viewpoint' })).variant;
    const [baseline] = (await ctx.owned()).variants;
    const sameTime = await ctx.era(alt, {
      kind: 'relative', label: 'Seen from the doorway', statement: 'Both views show the same afternoon.', relation: 'same-time', relativeToVariantId: baseline.id, confirmed: true,
    });
    assert.deepEqual({ ...sameTime.era, assertedAt: null }, {
      kind: 'relative', label: 'Seen from the doorway', start: null, end: null, statement: 'Both views show the same afternoon.',
      relation: 'same-time', relativeToVariantId: baseline.id, confirmed: true, assertedBy: ctx.owner.id, assertedAt: null,
    });
    const relative = await ctx.era(sameTime, { kind: 'relative', label: 'before the renovation', statement: 'The owner recalls this.', confirmed: true });
    assert.equal(relative.eraRevision, 2);
    assert.equal(relative.era.start, null);
    await assert.rejects(ctx.era(sameTime, { kind: 'unknown' }), status(409));
    const exact = await ctx.era(baseline, { kind: 'exact', label: '', start: '1998-02-28', end: '1998-02-28', statement: 'From the dated receipt.', confirmed: true });
    assert.equal(exact.era.start, '1998-02-28');
    const stored = (await ctx.stored()).collaboration.variants.find((item) => item.id === alt.id);
    assert.equal(stored.eraAssertions.length, 2);
    const contributions = (await ctx.owned()).contributions;
    assert.equal(contributions[0].periodClaim, '');
  });

  it('rejects incomplete, inconsistent or unconfirmed assertions', async () => {
    const ctx = await setup();
    await ctx.submit(ctx.alex);
    const [baseline] = (await ctx.owned()).variants;
    const confirmed = { statement: 'Stated by the owner.', confirmed: true };
    const invalid = [
      { kind: 'exact', start: '1998-02-30', end: '1998-02-30', ...confirmed },
      { kind: 'exact', start: '1998-02-01', end: '1998-02-02', ...confirmed },
      { kind: 'range', start: '1999-01-01', end: '1998-01-01', ...confirmed },
      { kind: 'range', start: '1998-01-01', end: '1999-01-01', statement: 'x', confirmed: false },
      { kind: 'relative', label: '', ...confirmed },
      { kind: 'relative', label: 'before', relation: 'before', ...confirmed },
      { kind: 'unknown', label: 'something' },
      { kind: 'unknown', start: '1998-01-01' },
      { kind: 'decade' },
    ];
    for (const change of invalid) await assert.rejects(ctx.era(baseline, change), status(400), JSON.stringify(change));
    await assert.rejects(ctx.era(baseline, { kind: 'relative', label: 'same day', relation: 'same-time', relativeToVariantId: baseline.id, ...confirmed }), status(400));
    await assert.rejects(ctx.era(baseline, { kind: 'relative', label: 'same day', relation: 'same-time', relativeToVariantId: randomUUID(), ...confirmed }), status(400));
  });
});

describe('photo use restrictions', () => {
  const restrict = async (ctx, change) => {
    const current = await ctx.reconstructions.sourcePolicy(ctx.draftId, ctx.sourceId, ctx.owner);
    return ctx.reconstructions.restrictSource(ctx.draftId, ctx.sourceId, ctx.owner, {
      requestId: randomUUID(), baseRevision: current.revision, permissions: current.permissions, stopUse: false, ...change,
    });
  };

  it('keeps manual adoption and alternatives after a model-only reduction', async () => {
    const ctx = await setup();
    const first = await ctx.submit(ctx.alex);
    const second = await ctx.submit(ctx.blair);
    await restrict(ctx, { permissions: { place: true, model: false, share: false } });
    assert.equal((await ctx.review(first, { decision: 'alternative' })).variant.blocked, false);
    assert.equal((await ctx.review(second)).edit.version, 2);
    const owned = await ctx.owned();
    assert.deepEqual([owned.blocked, owned.modelBlocked, owned.blockedReason], [false, true, null]);
    assert.ok(owned.variants.every((item) => !item.blocked));
  });

  it('blocks every variant use and hides era text when the photo is stopped, keeping testimony', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    const { variant } = await ctx.review(contribution, { decision: 'alternative' });
    await ctx.era(variant, { kind: 'relative', label: 'Seen from the doorway', statement: 'The owner recalls this.', confirmed: true });
    const other = await ctx.submit(ctx.blair);
    await restrict(ctx, { stopUse: true });

    const owned = await ctx.owned();
    assert.deepEqual([owned.blocked, owned.modelBlocked, owned.blockedReason], [true, true, 'source']);
    assert.ok(owned.variants.every((item) => item.blocked && item.label === 'Blocked reconstruction'));
    const blockedEra = owned.variants.find((item) => item.id === variant.id).era;
    assert.deepEqual([blockedEra.kind, blockedEra.label, blockedEra.statement], ['relative', null, null]);
    assert.doesNotMatch(JSON.stringify(owned.variants), /doorway|recalls|Alex/);
    assert.equal(owned.contributions.find((item) => item.id === other.id).text, other.text);
    const [baseline] = owned.variants;
    await assert.rejects(ctx.era(baseline), status(409));
    await assert.rejects(ctx.review(other, { decision: 'alternative' }), status(403));
    await assert.rejects(ctx.review(other), status(403));
    const own = await ctx.collaboration.get(ctx.draftId, ctx.jobId, ctx.blair);
    assert.equal(own.contributions[0].text, other.text);
  });
});

describe('restart', () => {
  it('reads the same collaboration state after a cold restart', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit(ctx.alex);
    await ctx.review(contribution, { decision: 'alternative' });
    const before = await ctx.owned();
    const reopened = open(ctx.dataDir);
    assert.deepEqual(await reopened.collaboration.get(ctx.draftId, ctx.jobId, ctx.owner), before);
  });
});
