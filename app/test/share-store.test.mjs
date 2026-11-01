import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { CollaborationStore } from '../collaboration.mjs';
import { DraftStore, RequestError, parseDraft } from '../drafts.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';
import { SHARE_LIMITS, ShareStore, UNAVAILABLE, arrangementOrigin } from '../shares.mjs';

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
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, units: 'arbitrary; not metric depth', max_triangle_depth_span: 0.35 },
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

function clock() {
  const now = () => now.value;
  now.value = Date.parse('2026-06-01T00:00:00Z');
  return now;
}

function open(dataDir, now) {
  const drafts = new DraftStore(dataDir);
  const reconstructions = new ReconstructionStore({ dataDir, drafts, runner, proposalModel: null, prepareImage: async () => null });
  stores.push(reconstructions);
  return { drafts, reconstructions, collaboration: new CollaborationStore({ reconstructions }), shares: new ShareStore({ reconstructions, now }) };
}

async function setup({ origin = 'public', permissions = { place: true, model: true, share: true } } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-shares-'));
  tempDirs.push(dataDir);
  const now = clock();
  const opened = open(dataDir, now);
  const form = new FormData();
  form.append('photos', new Blob([PHOTO]), 'photo');
  form.append('metadata', JSON.stringify({ photos: [{
    provider: 'Synthetic archive', origin: { kind: origin, reference: '' }, permissions,
    dates: { capturedOn: '1936-07-01', fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  }] }));
  const draft = await opened.drafts.create(await parseDraft(form));
  const job = await opened.reconstructions.create(draft.id, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: BOX });
  await waitUntil(() => opened.reconstructions.get(draft.id, job.id), (item) => item.status === 'ready');
  const person = (role, displayName, draftIds) => ({ id: randomUUID(), role, displayName, draftIds });
  const ctx = {
    ...opened, now, dataDir, draftId: draft.id, jobId: job.id, sourceId: draft.photos[0].sourceId,
    owner: person('owner', 'Owner', []), alex: person('contributor', 'Alex', [draft.id]),
    manifestFile: path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json'),
  };
  const grants = { place: true, model: true, share: true };
  ctx.submit = (change = {}) => ctx.collaboration.submit(ctx.draftId, ctx.jobId, ctx.alex, {
    requestId: randomUUID(), text: 'The counter faced the window.', permissions: grants, periodClaim: 'A summer', ...change,
  });
  ctx.review = (contribution, change = {}) => ctx.collaboration.review(ctx.draftId, ctx.jobId, ctx.owner, contribution.id, {
    requestId: randomUUID(), baseVersion: 1, baseRevision: contribution.revision, decision: 'adopt', reason: 'Private owner note.', conflict: 'unknown',
    transform: { offset: [0.5, 0, 0], yaw: 0.25 }, ...change,
  });
  ctx.edit = (baseVersion) => ctx.reconstructions.edit(ctx.draftId, ctx.jobId, { requestId: randomUUID(), baseVersion, offset: [0, 0.2, 0], yaw: 0 });
  ctx.variants = async () => (await ctx.collaboration.get(ctx.draftId, ctx.jobId, ctx.owner)).variants;
  ctx.versionView = (version, id = randomUUID()) => ({ id, kind: 'version', version, variantId: null });
  ctx.variantView = (variantId, id = randomUUID()) => ({ id, kind: 'variant', version: null, variantId });
  ctx.preview = (views, change = {}) => ctx.shares.createPreview(ctx.draftId, ctx.jobId, ctx.owner, {
    requestId: randomUUID(), title: 'Synthetic general store', views, startViewId: views[0]?.id ?? randomUUID(),
    camera: { position: [0, 0.5, 1], target: [0, 0, -3] }, contributionIds: [], synthetic: true, ...change,
  });
  ctx.issue = (preview, change = {}) => ctx.shares.issue(ctx.draftId, ctx.jobId, ctx.owner, {
    requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token: visitToken(), consent: true, ...change,
  });
  ctx.disk = () => readFile(ctx.manifestFile, 'utf8');
  return ctx;
}

async function shared(ctx, views, change) {
  const preview = await ctx.preview(views, change);
  const token = visitToken();
  const receipt = await ctx.issue(preview, { token });
  return { preview, token, receipt };
}

describe('share store previews', () => {
  it('requires the owner and rejects malformed selections', async () => {
    const ctx = await setup();
    const view = ctx.versionView(1);
    await assert.rejects(ctx.shares.createPreview(ctx.draftId, ctx.jobId, null, {}), status(401));
    await assert.rejects(ctx.shares.createPreview(ctx.draftId, ctx.jobId, ctx.alex, {}), status(403));
    const invalid = [
      { title: '  ' }, { title: 't'.repeat(121) }, { startViewId: randomUUID() }, { synthetic: 'yes' },
      { views: [] }, { views: [view, view] }, { views: [view, ctx.versionView(1)] }, { views: Array.from({ length: 9 }, () => ctx.variantView(randomUUID())) },
      { views: [{ ...view, variantId: randomUUID() }] }, { camera: { position: [0, 0, 0.1], target: [0, 0, 0] } },
      { camera: { position: [0, 0, 60], target: [0, 0, 55] } }, { camera: { position: [0, 0, Number.NaN], target: [0, 0, 0] } },
      { contributionIds: [view.id, view.id] }, { contributionIds: Array.from({ length: 21 }, () => randomUUID()) }, { extra: true },
    ];
    for (const change of invalid) {
      const views = change.views ?? [view];
      await assert.rejects(ctx.preview(views, { startViewId: views[0]?.id ?? view.id, ...change }), status(400), JSON.stringify(change).slice(0, 60));
    }
    // A version that was never saved does not exist; it is not a newer copy of the current one.
    await assert.rejects(ctx.preview([ctx.versionView(2)]), status(404));
    await assert.rejects(ctx.preview([ctx.variantView(randomUUID())]), status(404));
  });

  it('needs public origin and a share grant on the photo', async () => {
    // A photo without a place grant cannot be built into a scene, so it never reaches sharing.
    for (const options of [{ origin: 'own' }, { permissions: { place: true, model: true, share: false } }]) {
      const ctx = await setup(options);
      await assert.rejects(ctx.preview([ctx.versionView(1)]), status(403), JSON.stringify(options));
    }
  });

  it('needs share grants on every dependency even when its quote is omitted', async () => {
    const ctx = await setup();
    const unshared = await ctx.submit({ permissions: { place: true, model: false, share: false } });
    await ctx.review(unshared);
    await assert.rejects(ctx.preview([ctx.versionView(2)]), status(403));
    const [baseline] = await ctx.variants();
    await assert.rejects(ctx.preview([ctx.variantView(baseline.id)], { contributionIds: [unshared.id] }), status(403));
    const held = await ctx.submit();
    await ctx.review(held, { decision: 'hold', transform: null });
    await assert.rejects(ctx.preview([ctx.variantView(baseline.id)], { contributionIds: [held.id] }), status(409));
    assert.ok(await ctx.preview([ctx.variantView(baseline.id)]));
  });

  it('applies the live checks to an exact preview replay and never returns stale words', async () => {
    const ctx = await setup();
    const quoted = await ctx.submit({ text: 'Quoted words that will be withdrawn.' });
    const { variant } = await ctx.review(quoted, { decision: 'alternative' });
    const [baseline] = await ctx.variants();
    const replay = async (views, change) => {
      const body = { requestId: randomUUID(), ...change };
      const first = await ctx.preview(views, body);
      assert.deepEqual(await ctx.preview(views, body), first);
      return () => ctx.preview(views, body);
    };
    const byWithdrawal = await replay([ctx.variantView(variant.id)], { contributionIds: [quoted.id] });
    const byEra = await replay([ctx.variantView(baseline.id)]);
    const byExpiry = await replay([ctx.versionView(1)]);

    await ctx.collaboration.era(ctx.draftId, ctx.jobId, ctx.owner, baseline.id, {
      requestId: randomUUID(), baseRevision: 0, kind: 'exact', label: '', start: '1936-07-01', end: '1936-07-01', statement: 'Catalog date.', relation: null, relativeToVariantId: null, confirmed: true,
    });
    await assert.rejects(byEra(), status(409));
    await ctx.collaboration.withdraw(ctx.draftId, ctx.jobId, ctx.alex, quoted.id, { requestId: randomUUID() });
    await assert.rejects(byWithdrawal(), (error) => status(409)(error) && !error.message.includes(quoted.text));
    assert.ok(await byExpiry());
    ctx.now.value += SHARE_LIMITS.previewMs;
    await assert.rejects(byExpiry(), status(409));
  });

  it('requires a related alternative to be selected and maps the relation to its view', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit();
    const { variant } = await ctx.review(contribution, { decision: 'alternative', conflict: 'viewpoint' });
    const [baseline] = await ctx.variants();
    await ctx.collaboration.era(ctx.draftId, ctx.jobId, ctx.owner, variant.id, {
      requestId: randomUUID(), baseRevision: 0, kind: 'relative', label: 'Seen from the doorway', start: null, end: null,
      statement: 'Same afternoon as the saved view.', relation: 'same-time', relativeToVariantId: baseline.id, confirmed: true,
    });
    await assert.rejects(ctx.preview([ctx.variantView(variant.id)]), status(400));
    const baseView = ctx.variantView(baseline.id);
    const altView = ctx.variantView(variant.id);
    const preview = await ctx.preview([baseView, altView]);
    const alt = preview.publicView.views[1];
    assert.equal(alt.label, 'Alternative arrangement 1');
    assert.deepEqual(alt.era, {
      kind: 'relative', label: 'Seen from the doorway', start: null, end: null, statement: 'Same afternoon as the saved view.',
      assertedByLabel: 'Place owner', relation: 'same-time', relativeToViewId: baseView.id,
    });
    assert.equal(preview.publicView.views[0].era.kind, 'unknown');
  });
});

describe('share store issue and visit', () => {
  it('serves only the allowlisted public projection and a geometry-only surface', async () => {
    const ctx = await setup();
    const quoted = await ctx.submit({ text: 'Synthetic recollection: flour sacks by the door.' });
    const other = await ctx.submit({ text: 'Unquoted private wording.' });
    const { variant } = await ctx.review(quoted, { decision: 'alternative' });
    const startView = ctx.versionView(1);
    const altView = ctx.variantView(variant.id);
    const { token, receipt } = await shared(ctx, [startView, altView], { contributionIds: [quoted.id], startViewId: startView.id });
    assert.deepEqual(Object.keys(receipt).sort(), ['createdAt', 'digest', 'expiresAt', 'id', 'previewId', 'status']);

    const view = await ctx.shares.visit(token);
    assert.deepEqual(Object.keys(view).sort(), ['camera', 'createdAt', 'id', 'startViewId', 'stories', 'synthetic', 'title', 'views']);
    assert.equal(view.id, receipt.id);
    assert.deepEqual(view.camera, { position: [0, 0.5, 1], target: [0, 0, -3] });
    for (const item of view.views) {
      assert.deepEqual(Object.keys(item).sort(), ['edit', 'era', 'evidence', 'id', 'label']);
      assert.deepEqual(Object.keys(item.evidence).sort(), ['arrangement', 'geometry', 'photo', 'recollections', 'support']);
      assert.deepEqual(item.evidence.photo, { providerLabel: 'Synthetic archive', attributedCaptureDate: '1936-07-01' });
      assert.equal(item.evidence.geometry, 'model estimate');
    }
    assert.deepEqual(view.views[0].edit, { offset: [0, 0, 0], yaw: 0 });
    assert.deepEqual(view.views[1].edit, { offset: [0.5, 0, 0], yaw: 0.25 });
    assert.deepEqual(view.views[1].evidence.recollections, [{ providerLabel: 'Alex', text: quoted.text, periodClaim: 'A summer' }]);
    assert.deepEqual(view.views[0].evidence.support, []);
    assert.deepEqual(view.views[1].evidence.support, [{ kind: 'human_recollection', providerLabel: 'Alex', status: 'owner-selected' }]);
    const text = JSON.stringify(view);
    for (const secret of [ctx.draftId, ctx.jobId, ctx.sourceId, quoted.id, other.text, ctx.owner.id, ctx.alex.id, 'Private owner note', 'sha256', 'photo.png', token]) {
      assert.ok(!text.includes(secret), `public view leaks ${secret}`);
    }

    const surface = await ctx.shares.visitAsset(token, startView.id, 'surface.json');
    const parsed = JSON.parse(surface.body.toString('utf8'));
    assert.deepEqual(Object.keys(parsed).sort(), ['assumptions', 'depth', 'foreground', 'height', 'source', 'width']);
    assert.deepEqual(parsed.source, { image_size: [40, 30] });
    assert.deepEqual(Object.keys(parsed.assumptions).sort(), ['far', 'horizontal_fov_degrees', 'max_triangle_depth_span', 'near']);
    const texture = await ctx.shares.visitAsset(token, altView.id, 'texture.jpg');
    assert.equal(texture.file, path.join(path.dirname(ctx.manifestFile), 'assets', 'texture.jpg'));
    assert.equal(texture.type, 'image/jpeg');
    assert.ok(JSON.parse(await readFile(path.join(path.dirname(ctx.manifestFile), 'assets', 'surface.json'), 'utf8')).source.source_id, 'stored surface unchanged');
    for (const [viewId, name] of [[startView.id, 'mask.png'], [startView.id, 'depth-preview.png'], [startView.id, '../manifest.json'], [startView.id, 'summary.json'], [randomUUID(), 'texture.jpg']]) {
      await assert.rejects(ctx.shares.visitAsset(token, viewId, name), unavailable, name);
    }
  });

  it('acknowledges supporting recollections without their wording when no quote is selected', async () => {
    const ctx = await setup();
    const contribution = await ctx.submit({ text: 'Wording that was not selected for quoting.', periodClaim: 'Private time claim' });
    await ctx.review(contribution);
    const { token } = await shared(ctx, [ctx.versionView(2)]);
    const [view] = (await ctx.shares.visit(token)).views;
    assert.deepEqual(view.evidence.support, [{ kind: 'human_recollection', providerLabel: 'Alex', status: 'owner-selected' }]);
    assert.deepEqual(view.evidence.recollections, []);
    const text = JSON.stringify(view);
    for (const secret of [contribution.text, 'Private time claim', contribution.id, contribution.createdAt]) assert.ok(!text.includes(secret));
  });

  it('gives one generic answer for every invalid, revoked or expired token', async () => {
    const ctx = await setup();
    const { token, receipt } = await shared(ctx, [ctx.versionView(1)]);
    const accessKey = `rha_${randomBytes(32).toString('base64url')}`;
    for (const bad of [visitToken(), accessKey, `${token}x`, token.slice(0, -1), '', null, `Bearer ${token}`]) {
      await assert.rejects(ctx.shares.visit(bad), unavailable, String(bad).slice(0, 8));
    }
    await ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.owner, receipt.id, { requestId: randomUUID() });
    await assert.rejects(ctx.shares.visit(token), unavailable);
    await assert.rejects(ctx.shares.visitAsset(token, receipt.id, 'texture.jpg'), unavailable);

    const second = await shared(ctx, [ctx.versionView(1)]);
    ctx.now.value += SHARE_LIMITS.snapshotMs;
    await assert.rejects(ctx.shares.visit(second.token), unavailable);
    const listed = await ctx.shares.list(ctx.draftId, ctx.jobId, ctx.owner);
    assert.deepEqual(listed.map((item) => item.status), ['expired', 'revoked']);
  });

  it('replays an issue exactly and never reuses or reactivates a link key', async () => {
    const ctx = await setup();
    const preview = await ctx.preview([ctx.versionView(1)]);
    const token = visitToken();
    const body = { requestId: randomUUID(), token };
    const receipt = await ctx.issue(preview, body);
    assert.deepEqual(await ctx.issue(preview, body), receipt);
    await assert.rejects(ctx.issue(preview, { ...body, token: visitToken() }), status(409));
    await assert.rejects(ctx.issue(preview), status(409));
    await ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.owner, receipt.id, { requestId: randomUUID() });
    assert.equal((await ctx.issue(preview, body)).status, 'revoked');
    await assert.rejects(ctx.shares.visit(token), unavailable);
    await assert.rejects(ctx.issue(await ctx.preview([ctx.versionView(1)]), { token }), status(409));
    await assert.rejects(ctx.issue(await ctx.preview([ctx.versionView(1)]), { consent: false }), status(400));
    const stale = await ctx.preview([ctx.versionView(1)]);
    await assert.rejects(ctx.issue(stale, { previewDigest: '0'.repeat(64) }), status(409));
    ctx.now.value += SHARE_LIMITS.previewMs;
    await assert.rejects(ctx.issue(stale), status(409));
    await assert.rejects(ctx.shares.getPreview(ctx.draftId, ctx.jobId, ctx.owner, stale.id), status(409));
    const stored = JSON.parse(await ctx.disk()).shares.snapshots;
    assert.equal(stored.length, 1);
    assert.ok(!(await ctx.disk()).includes(token.slice(4)));
  });

  it('requires a new preview after a selected change, but not after a later private edit', async () => {
    const ctx = await setup();
    const withdrawnLater = await ctx.submit();
    const { variant } = await ctx.review(withdrawnLater, { decision: 'alternative' });
    const [baseline] = await ctx.variants();

    const byWithdrawal = await ctx.preview([ctx.variantView(variant.id)]);
    const byEra = await ctx.preview([ctx.variantView(baseline.id)]);
    const byEdit = await ctx.preview([ctx.versionView(1)]);
    const unrelated = await ctx.preview([ctx.variantView(baseline.id)]);

    // A retained version stays pinned: a later private edit neither invalidates nor rebinds it.
    await ctx.edit(1);
    const pinnedToken = visitToken();
    assert.equal((await ctx.issue(byEdit, { token: pinnedToken })).status, 'active');
    assert.deepEqual((await ctx.shares.visit(pinnedToken)).views[0].edit, { offset: [0, 0, 0], yaw: 0 });
    assert.equal((await ctx.issue(unrelated)).status, 'active');
    await ctx.collaboration.era(ctx.draftId, ctx.jobId, ctx.owner, baseline.id, {
      requestId: randomUUID(), baseRevision: 0, kind: 'exact', label: '', start: '1936-07-01', end: '1936-07-01', statement: 'Catalog date.', relation: null, relativeToVariantId: null, confirmed: true,
    });
    await assert.rejects(ctx.issue(byEra), status(409));
    await ctx.collaboration.withdraw(ctx.draftId, ctx.jobId, ctx.alex, withdrawnLater.id, { requestId: randomUUID() });
    await assert.rejects(ctx.issue(byWithdrawal), status(409));
    const listed = await ctx.shares.list(ctx.draftId, ctx.jobId, ctx.owner);
    assert.deepEqual(listed.map((item) => [item.status, item.reason]), [
      ['suspended', 'The time assertion for a selected alternative changed. Make a new preview.'],
      ['active', null],
    ]);
  });

  it('keeps a clean shared version visitable when a later private version is blocked, but not a dependent one', async () => {
    const ctx = await setup();
    const clean = await shared(ctx, [ctx.versionView(1)]);
    const contribution = await ctx.submit();
    await ctx.review(contribution);
    const dependent = await shared(ctx, [ctx.versionView(2)]);
    await ctx.edit(2);
    const cleanView = await ctx.shares.visit(clean.token);
    assert.deepEqual(cleanView.views[0].edit, { offset: [0, 0, 0], yaw: 0 });

    await ctx.collaboration.withdraw(ctx.draftId, ctx.jobId, ctx.alex, contribution.id, { requestId: randomUUID() });
    assert.equal((await ctx.reconstructions.get(ctx.draftId, ctx.jobId)).usageBlocked, true);
    assert.deepEqual(await ctx.shares.visit(clean.token), cleanView);
    assert.ok(await ctx.shares.visitAsset(clean.token, cleanView.views[0].id, 'texture.jpg'));
    await assert.rejects(ctx.shares.visit(dependent.token), unavailable);
    await assert.rejects(ctx.shares.visitAsset(dependent.token, dependent.receipt.id, 'surface.json'), unavailable);
    const listed = await ctx.shares.list(ctx.draftId, ctx.jobId, ctx.owner);
    assert.deepEqual(listed.map((item) => item.status), ['suspended', 'active']);
    assert.match(listed[0].reason, /withdrawn/);
  });

  it('never leaves a withdrawn dependency visitable after a concurrent issue', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctx = await setup();
      const contribution = await ctx.submit();
      await ctx.review(contribution);
      const preview = await ctx.preview([ctx.versionView(2)]);
      const token = visitToken();
      const [issued] = await Promise.allSettled([
        ctx.issue(preview, { token }),
        ctx.collaboration.withdraw(ctx.draftId, ctx.jobId, ctx.alex, contribution.id, { requestId: randomUUID() }),
      ]);
      if (issued.status === 'rejected') assert.ok(status(409)(issued.reason));
      await assert.rejects(ctx.shares.visit(token), unavailable);
    }
  });

  it('denies a same-size replacement of the shared texture everywhere', async () => {
    const ctx = await setup();
    const { token, receipt } = await shared(ctx, [ctx.versionView(1)]);
    const pending = await ctx.preview([ctx.versionView(1)]);
    const file = path.join(path.dirname(ctx.manifestFile), 'assets', 'texture.jpg');
    const original = await readFile(file);
    const replacement = jpeg(40, 30, 9);
    assert.equal(replacement.length, original.length);
    assert.notDeepEqual(replacement, original);
    await writeFile(file, replacement);

    await assert.rejects(ctx.shares.visit(token), unavailable);
    await assert.rejects(ctx.shares.visitAsset(token, receipt.id, 'texture.jpg'), unavailable);
    await assert.rejects(ctx.shares.visitAsset(token, receipt.id, 'surface.json'), unavailable);
    await assert.rejects(ctx.shares.getPreview(ctx.draftId, ctx.jobId, ctx.owner, pending.id), status(409));
    await assert.rejects(ctx.shares.previewAsset(ctx.draftId, ctx.jobId, ctx.owner, pending.id, pending.publicView.views[0].id, 'texture.jpg'), status(409));
    await assert.rejects(ctx.issue(pending), status(409));
    await assert.rejects(ctx.preview([ctx.versionView(1)]), status(409));
    assert.deepEqual((await ctx.shares.list(ctx.draftId, ctx.jobId, ctx.owner)).map((item) => item.status), ['suspended']);

    await writeFile(file, original);
    assert.ok(await ctx.shares.visit(token));
  });

  it('issues nothing when the manifest cannot be saved, and never writes the token', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const ctx = await setup();
    const preview = await ctx.preview([ctx.versionView(1)]);
    const token = visitToken();
    const dir = path.dirname(ctx.manifestFile);
    await chmod(dir, 0o500);
    try {
      await assert.rejects(ctx.issue(preview, { token }));
    } finally {
      await chmod(dir, 0o700);
    }
    await assert.rejects(ctx.shares.visit(token), unavailable);
    assert.equal(JSON.parse(await ctx.disk()).shares.snapshots.length, 0);
    for (const name of await readdir(dir)) {
      if (name.endsWith('.json') || name.endsWith('.tmp')) assert.ok(!(await readFile(path.join(dir, name), 'utf8')).includes(token.slice(4)));
    }
    assert.equal((await ctx.issue(preview, { token })).status, 'active');
  });

  it('survives a cold restart and keeps share records out of the scene manifest and owner list', async () => {
    const ctx = await setup();
    const { token } = await shared(ctx, [ctx.versionView(1)]);
    const before = await ctx.shares.visit(token);
    const reopened = open(ctx.dataDir, ctx.now);
    assert.deepEqual(await reopened.shares.visit(token), before);
    const scene = await reopened.reconstructions.get(ctx.draftId, ctx.jobId);
    assert.equal(scene.shares, undefined);
    assert.equal((await reopened.reconstructions.list(ctx.draftId))[0].shares, undefined);
    const [listed] = await reopened.shares.list(ctx.draftId, ctx.jobId, ctx.owner);
    assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'expiresAt', 'id', 'reason', 'status', 'title', 'views']);
    assert.ok(!JSON.stringify(listed).includes(token.slice(4)));
    assert.doesNotMatch(JSON.stringify(listed), /tokenVerifier|frozen/);
  });

  it('revokes one way with idempotent replay', async () => {
    const ctx = await setup();
    const { receipt } = await shared(ctx, [ctx.versionView(1)]);
    const requestId = randomUUID();
    const revoked = await ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.owner, receipt.id, { requestId });
    assert.equal(revoked.status, 'revoked');
    assert.deepEqual(await ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.owner, receipt.id, { requestId }), revoked);
    assert.equal((await ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.owner, receipt.id, { requestId: randomUUID() })).status, 'revoked');
    await assert.rejects(ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.owner, randomUUID(), { requestId }), status(409));
    await assert.rejects(ctx.shares.revoke(ctx.draftId, ctx.jobId, ctx.alex, receipt.id, { requestId: randomUUID() }), status(403));
  });
});

describe('shared arrangement origin', () => {
  const ORIGINS = ['initial', 'manual', 'relationship', 'memory', 'recollection', 'restored', 'alternative', 'unknown'];
  const single = (edits, variants = []) => ({ edit: { version: edits.length + 1, offset: [0, 0, 0], yaw: 0 }, edits, collaboration: { variants } });
  const pair = (edits, variants = []) => ({
    objects: [{ id: 'object-1', label: 'A', box: [0, 0, 1, 1], pivot: [0, 0, 0] }, { id: 'object-2', label: 'B', box: [1, 1, 2, 2], pivot: [1, 0, 0] }],
    edit: { version: edits.length + 1, objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }], relationship: null },
    edits, collaboration: { variants },
  });
  const flat = (version, kind, offset = [0, 0, 0]) => ({ version, offset, yaw: 0, ...(kind !== undefined && { kind }) });
  const twin = (version, kind, offset = [0, 0, 0]) => ({
    version, objects: [{ id: 'object-1', offset, yaw: 0 }, { id: 'object-2', offset: [0, 0, 0], yaw: 0 }], relationship: null, ...(kind !== undefined && { kind }),
  });
  const version = (v) => ({ kind: 'version', version: v, variantId: null });
  const variant = (id) => ({ kind: 'variant', version: null, variantId: id });

  it('maps each exact saved version by its own receipt, for both scene shapes', () => {
    for (const [build, receipt] of [[single, flat], [pair, twin]]) {
      const kinds = ['manual', 'relationship', 'proposal', 'contribution', 'undo', 'other', '__proto__', 7];
      const manifest = build(kinds.map((kind, index) => receipt(index + 2, kind, [index, 0, 0])));
      assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => arrangementOrigin(manifest, version(v))),
        ['initial', 'manual', 'relationship', 'memory', 'recollection', 'restored', 'unknown', 'unknown', 'unknown']);
      assert.equal(arrangementOrigin(manifest, version(42)), 'unknown', 'a version without a receipt');
    }
    // A receipt without a kind is a manual edit only on a single-object scene.
    assert.equal(arrangementOrigin(single([flat(2)]), version(2)), 'manual');
    assert.equal(arrangementOrigin(pair([twin(2)]), version(2)), 'unknown');
    // An older version keeps its own origin after newer edits.
    const later = single([flat(2, 'manual'), flat(3, 'undo'), flat(4, 'contribution')]);
    assert.equal(arrangementOrigin(later, version(2)), 'manual');
  });

  it('marks candidates as alternatives and baselines only as their exact parent version', () => {
    const edits = [flat(2, 'proposal', [0.5, 0, 0])];
    const baseline = (change = {}) => ({ id: 'b', kind: 'baseline', parentVersion: 2, edit: { version: 2, offset: [0.5, 0, 0], yaw: 0 }, ...change });
    const candidate = (change = {}) => ({ id: 'c', kind: 'candidate', parentVersion: 2, edit: { version: null, offset: [1, 0, 0], yaw: 0 }, ...change });
    assert.equal(arrangementOrigin(single(edits, [baseline()]), variant('b')), 'memory');
    assert.equal(arrangementOrigin(single([], [baseline({ parentVersion: 1, edit: { version: 1, offset: [0, 0, 0], yaw: 0 } })]), variant('b')), 'initial');
    for (const change of [{ edit: { version: 2, offset: [0.6, 0, 0], yaw: 0 } }, { edit: { version: 3, offset: [0.5, 0, 0], yaw: 0 } }, { parentVersion: 9 }, { parentVersion: 'x' }, { edit: null }]) {
      assert.equal(arrangementOrigin(single(edits, [baseline(change)]), variant('b')), 'unknown', JSON.stringify(change));
    }
    assert.equal(arrangementOrigin(single([], [baseline()]), variant('b')), 'unknown', 'parent receipt missing');
    assert.equal(arrangementOrigin(single(edits, [candidate()]), variant('c')), 'alternative');
    assert.equal(arrangementOrigin(single(edits, [candidate({ edit: { version: 2, offset: [0.5, 0, 0], yaw: 0 } })]), variant('c')), 'alternative', 'adopted too');
    assert.equal(arrangementOrigin(single(edits, [{ id: 'z', kind: 'other' }]), variant('z')), 'unknown');
    assert.equal(arrangementOrigin(single(edits), variant('missing')), 'unknown');
    // The pair baseline compares the whole arrangement including the rule.
    const pairEdits = [twin(2, 'relationship')];
    const pairBaseline = { id: 'b', kind: 'baseline', parentVersion: 2, edit: { version: 2, objects: pairEdits[0].objects, relationship: null } };
    assert.equal(arrangementOrigin(pair(pairEdits, [pairBaseline]), variant('b')), 'relationship');
    const ruled = { ...pairBaseline, edit: { ...pairBaseline.edit, relationship: { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' } } };
    assert.equal(arrangementOrigin(pair(pairEdits, [ruled]), variant('b')), 'unknown');
  });

  it('puts the origin of real saved operations in each built view, bound into the digest', async () => {
    const ctx = await setup();
    await ctx.edit(1);
    const contribution = await ctx.submit();
    await ctx.review(contribution, { baseVersion: 2 });
    await ctx.reconstructions.undo(ctx.draftId, ctx.jobId, { requestId: randomUUID(), baseVersion: 3, targetVersion: 1 });
    const variants = await ctx.variants();
    const views = [1, 2, 3, 4].map((v) => ctx.versionView(v)).concat(variants.map((item) => ctx.variantView(item.id)));
    const preview = await ctx.preview(views);
    const origins = preview.publicView.views.map((item) => item.evidence.arrangement);
    assert.deepEqual(origins.slice(0, 4), ['initial', 'manual', 'recollection', 'restored']);
    // The baseline is exactly version 2, a manual edit; the adopted candidate is an alternative.
    assert.deepEqual([...origins.slice(4)].sort(), ['alternative', 'manual']);
    assert.ok(origins.every((origin) => ORIGINS.includes(origin)));
    const text = JSON.stringify(preview.publicView.views.map((item) => item.evidence));
    for (const hidden of [contribution.id, 'Private owner note.']) assert.ok(!text.includes(hidden), hidden);
    // The field is inside the digest the owner previewed and the snapshot binds.
    const { id, createdAt, ...content } = preview.publicView;
    assert.equal(preview.digest, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
    const changed = structuredClone(content);
    changed.views[0].evidence.arrangement = 'manual';
    assert.notEqual(createHash('sha256').update(JSON.stringify(changed)).digest('hex'), preview.digest);
    const token = visitToken();
    await ctx.issue(preview, { token });
    assert.deepEqual((await ctx.shares.visit(token)).views.map((item) => item.evidence.arrangement), origins);
  });

  it('issues, replays and serves a consistent preview made before the field existed, never enriching it', async () => {
    const ctx = await setup();
    await ctx.edit(1);
    const fresh = await ctx.preview([ctx.versionView(2)]);
    // Make it a consistent pre-field preview: no field, and the digest the
    // store computes over exactly that content.
    const manifest = JSON.parse(await ctx.disk());
    const stored = manifest.shares.previews.find((item) => item.id === fresh.id);
    for (const view of stored.publicView.views) delete view.evidence.arrangement;
    const { id, createdAt, ...content } = stored.publicView;
    stored.digest = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    await writeFile(ctx.manifestFile, JSON.stringify(manifest, null, 2));
    const legacyView = structuredClone(stored.publicView.views);

    const token = visitToken();
    const request = { requestId: randomUUID(), previewId: fresh.id, previewDigest: stored.digest, token, consent: true };
    const receipt = await ctx.shares.issue(ctx.draftId, ctx.jobId, ctx.owner, request);
    assert.equal(receipt.status, 'active');
    assert.equal(receipt.digest, stored.digest, 'issued from the legacy digest');
    const afterIssue = JSON.stringify(JSON.parse(await ctx.disk()).shares);
    assert.deepEqual(await ctx.shares.issue(ctx.draftId, ctx.jobId, ctx.owner, request), receipt, 'an exact replay returns the same receipt');
    const visited = await ctx.shares.visit(token);
    assert.deepEqual(visited.views, legacyView, 'served exactly as stored, without the field');
    const reopened = open(ctx.dataDir, ctx.now);
    assert.deepEqual(await reopened.shares.issue(ctx.draftId, ctx.jobId, ctx.owner, request), receipt, 'the replay holds after a restart');
    assert.deepEqual((await reopened.shares.visit(token)).views, legacyView, 'and so does the visit');
    assert.equal(JSON.stringify(JSON.parse(await ctx.disk()).shares), afterIssue, 'replay, visits and restart change no stored byte');
    const snapshot = JSON.parse(afterIssue).snapshots.find((item) => item.id === receipt.id);
    assert.ok(snapshot.publicView.views.every((view) => !('arrangement' in view.evidence)), 'the snapshot was not enriched');
  });

  it('keeps current rights: a stopped source still blocks the view whatever its origin', async () => {
    const ctx = await setup();
    await ctx.edit(1);
    const { token } = await shared(ctx, [ctx.versionView(2)]);
    assert.equal((await ctx.shares.visit(token)).views[0].evidence.arrangement, 'manual');
    const { revision } = await ctx.reconstructions.sourcePolicy(ctx.draftId, ctx.sourceId, ctx.owner);
    await ctx.reconstructions.restrictSource(ctx.draftId, ctx.sourceId, ctx.owner, { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true });
    await assert.rejects(ctx.shares.visit(token), unavailable);
    await assert.rejects(ctx.preview([ctx.versionView(2)]), (error) => error instanceof RequestError && error.status >= 400);
  });
});
