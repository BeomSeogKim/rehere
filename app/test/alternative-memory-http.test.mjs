import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { quaternionFromEuler } from '../public/composition-scene.js';
import { client, enrolledContributor, jpeg, png, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic scenes and an injected planner only: no provider is ever called.
// A memory proposal for a selected saved alternative is planned, previewed
// and saved as a new immutable child without reading or changing main.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const GRANT = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];
const GRID = { width: 16, height: 12 };
const LEFT_OF = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };
const IMAGE = async () => jpeg(40, 30, 1);

async function runner(call) {
  if (!call.objects) return sceneRunner(call);
  const { imagePath, outputDir, sourceId, objects } = call;
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const selected = objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box }));
  const regions = [];
  for (let y = 0; y < GRID.height; y++) {
    for (let x = 0; x < GRID.width; x++) regions.push(y >= 2 && y <= 9 && x >= 1 && x <= 5 ? 1 : y >= 2 && y <= 9 && x >= 10 && x <= 14 ? 2 : 0);
  }
  const surface = {
    schema_version: 2,
    source: { source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30], texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' }, selected_objects: selected },
    objects: selected, ...GRID, depth: Array(GRID.width * GRID.height).fill(3), regions,
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(16, 12), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2), 'surface.json': JSON.stringify(surface),
    'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture), overlap: { pixels: 0, ratio: 0 } }),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

// An injected planner: each call takes the next queued step.
function planner() {
  const calls = [];
  const steps = [];
  const model = async (call) => {
    calls.push(call);
    const step = steps.shift();
    if (!step) throw new Error('unexpected model call');
    return step(call);
  };
  return { calls, steps, model };
}
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};
// A plan echoing exactly what it was asked about.
const plan = (call, change = {}) => ({
  ok: true, model: 'synthetic-model', usage: { inputTokens: 1, outputTokens: 1 }, responseId: 'synthetic-response',
  plan: {
    action: 'translate', targetId: call.targetId ?? 'selected-foreground', ...(call.images ? { sourceIds: call.sourceIds } : { sourceId: call.sourceId }),
    parentVariantId: call.alternative.parentVariantId, baseEraRevision: call.alternative.baseEraRevision,
    delta: [0, 0, 0.1], yawDelta: null, ...(call.images ? { faceObjectId: null } : { anchor: null }), question: null, reason: 'Synthetic plan.', ...change,
  },
});
// A planner step that sends one admitted request, optionally after a gate.
const admitted = (change = {}, hold = null) => async (call) => {
  if (hold) {
    hold.reached.open();
    await Promise.race([hold.release.promise, new Promise((resolve) => call.signal.addEventListener('abort', resolve))]);
  }
  const sent = await call.admit(() => true);
  return sent ? plan(call, change) : { ok: false, reason: 'provider', model: 'synthetic-model', usage: null, responseId: null };
};
const held = () => ({ reached: gate(), release: gate() });

async function workspace(model, dataDir = null, prepareModelImage = IMAGE) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-alternative-memory-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner, proposalModel: model, prepareModelImage });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function expectStatus(response, status, label = '') {
  const body = await response.json();
  assert.equal(response.status, status, `${label} ${JSON.stringify(body)}`);
  return body;
}

async function scene(owner, objects = null) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('metadata', JSON.stringify({ photos: [GRANT] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const build = objects ? { objects } : { box: [4, 3, 20, 24] };
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, ...build })).json();
  const route = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && ['queued', 'processing'].includes((await owner.json(route)).status); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (objects) await expectStatus(await owner.post(`${route}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] }), 200, 'confirm');
  return { draft, job, route };
}

const manifestFile = (dataDir, place) => path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json');
const disk = async (dataDir, place) => JSON.parse(await readFile(manifestFile(dataDir, place), 'utf8'));
const variants = async (owner, place) => (await owner.json(`${place.route}/collaboration`)).variants;
const scoped = (place, parentId, rest = '') => `${place.route}/variants/${parentId}/proposals${rest}`;
const ask = (change = {}) => ({ requestId: randomUUID(), baseEraRevision: 0, targetId: 'selected-foreground', timeMode: 'unknown', text: 'It stood a little further back.', consent: true, ...change });
const save = (change = {}) => ({ requestId: randomUUID(), baseEraRevision: 0, frontConfirmed: false, confirmed: true, ...change });
const revisionBody = (transform, change = {}) => ({ requestId: randomUUID(), baseEraRevision: 0, transform, timeMode: 'unknown', confirmed: true, ...change });
const policyRoute = (place, index = 0) => `/api/drafts/${place.draft.id}/sources/${place.draft.photos[index].sourceId}/policy`;
const eraBody = (baseRevision) => ({ requestId: randomUUID(), baseRevision, kind: 'exact', label: '', start: '1990-05-01', end: '1990-05-01', statement: 'The owner places this in May 1990.', relation: null, relativeToVariantId: null, confirmed: true });

// Rewrites the stored origin of the draft's photos (synthetic temp data; there
// is no editing route for it) to check stored-source integrity.
async function setOrigin(dataDir, draftId, kind, indexes = null) {
  const file = path.join(dataDir, 'drafts', draftId, 'draft.json');
  const draft = JSON.parse(await readFile(file, 'utf8'));
  const photos = draft.sources.filter((item) => item.kind === 'photo').map((item) => item.id);
  const chosen = new Set((indexes ?? photos.map((_, index) => index)).map((index) => photos[index]));
  await writeFile(file, JSON.stringify({ ...draft, sources: draft.sources.map((item) => (chosen.has(item.id) ? { ...item, origin: { ...item.origin, kind } } : item)) }));
}

async function settle(owner, url) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const item = await owner.json(url);
    if (!['queued', 'processing'].includes(item.status)) return item;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('proposal did not settle');
}

async function restrict(owner, place, permissions, index = 0) {
  const { revision } = await owner.json(policyRoute(place, index));
  await expectStatus(await owner.post(policyRoute(place, index), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse: false }), 200, 'restrict');
}

async function recollect(owner, session, place, text, decision, transform, baseVersion, model = true) {
  const submitted = await expectStatus(await session.post(`${place.route}/contributions`, { requestId: randomUUID(), text, permissions: { place: true, model, share: true }, periodClaim: '' }), 200, 'submit');
  const body = { requestId: randomUUID(), baseVersion, baseRevision: 1, decision, reason: 'Synthetic note.', conflict: 'unknown', transform };
  const reviewed = await expectStatus(await owner.post(`${place.route}/contributions/${submitted.id}/review`, body), 200, 'review');
  return { id: submitted.id, variant: reviewed.variant };
}

async function share(owner, place, variantId) {
  const view = { id: randomUUID(), kind: 'variant', version: null, variantId };
  const body = { requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true };
  const preview = await expectStatus(await owner.post(`${place.route}/shares/previews`, body), 201, 'preview');
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  await expectStatus(await owner.post(`${place.route}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true }), 201, 'issue');
  return preview;
}

describe('memory proposals for a selected saved alternative', () => {
  it('plans from the parent, not main, previews the whole candidate and saves exactly one child across replay and restart', async () => {
    const p = planner();
    let { app, owner, dataDir } = await workspace(p.model);
    try {
      const place = await scene(owner, OBJECTS);
      await expectStatus(await owner.post(`${place.route}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true }), 200, 'rule');
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const a = await recollect(owner, session, place, 'The counter stood higher.', 'alternative', { targetId: 'object-1', offset: [0, 0.2, 0], yaw: 0 }, 2);
      const parent = await expectStatus(await owner.post(`${place.route}/variants/${a.variant.id}/revisions`, revisionBody({ targetId: 'object-2', offset: [0, 0.1, 0], yaw: 0.2 })), 201, 'parent');
      // Main differs from the parent in both objects.
      await expectStatus(await owner.post(`${place.route}/edit`, { requestId: randomUUID(), baseVersion: 2, targetId: 'object-2', offset: [0.1, 0, 0], yaw: 0.1 }), 200, 'main edit');
      const before = await disk(dataDir, place);

      const hold = held();
      p.steps.push(admitted({ targetId: 'object-1', delta: [0, 0, 0.1] }, hold));
      const body = ask({ targetId: 'object-1' });
      const queued = await expectStatus(await owner.post(scoped(place, parent.id), body), 202, 'create');
      assert.deepEqual(queued.scope, { kind: 'variant', parentVariantId: parent.id, baseEraRevision: 0, timeMode: 'unknown' });
      assert.equal(queued.targetId, 'object-1');
      assert.equal(Object.hasOwn(queued, 'baseVersion'), false);
      assert.equal(queued.appliedVariantId, null);
      assert.equal(queued.candidate, null);
      // An exact replay returns the same proposal; changed input with that ID conflicts.
      assert.equal((await expectStatus(await owner.post(scoped(place, parent.id), body), 200, 'replay')).id, queued.id);
      await expectStatus(await owner.post(scoped(place, parent.id), { ...body, text: 'Another memory.' }), 409, 'changed text');
      await expectStatus(await owner.post(scoped(place, a.variant.id), body), 409, 'other parent');
      await expectStatus(await owner.post(scoped(place, parent.id), ask({ targetId: 'object-2' })), 409, 'busy');

      // Main advances while the call is out; the parent stays the target.
      await hold.reached.promise;
      await expectStatus(await owner.post(`${place.route}/edit`, { requestId: randomUUID(), baseVersion: 3, targetId: 'object-1', offset: [-0.1, 0, 0], yaw: 0 }), 200, 'main moves during the call');
      hold.release.open();
      const ready = await settle(owner, scoped(place, parent.id, `/${queued.id}`));
      assert.equal(ready.status, 'ready', ready.error);
      const [call] = p.calls;
      assert.deepEqual(call.alternative, { parentVariantId: parent.id, baseEraRevision: 0 });
      assert.equal(Object.hasOwn(call, 'baseVersion'), false);
      assert.equal(call.targetId, 'object-1');
      assert.deepEqual(call.saved, { offset: [0, 0.2, 0], yaw: 0 });
      assert.deepEqual(call.objects.map(({ id, offset, yaw }) => ({ id, offset, yaw })), parent.edit.objects);
      assert.deepEqual(call.relationship, LEFT_OF);
      assert.deepEqual(call.selection, [2 / 40, 4 / 30, 14 / 40, 26 / 30]);
      assert.equal(call.text, body.text);
      assert.deepEqual(ready.candidate, {
        version: null, objects: [{ id: 'object-1', offset: [0, 0.2, 0.1], yaw: 0 }, parent.edit.objects[1]], relationship: LEFT_OF,
      });
      assert.equal(ready.responseId, 'synthetic-response');

      // Main routes never offer a scoped proposal, and other parents never see it.
      assert.equal((await owner.json(`${place.route}/proposals`)).some((item) => item.id === queued.id), false);
      await expectStatus(await owner.request(`${place.route}/proposals/${queued.id}`), 404, 'main get');
      await expectStatus(await owner.post(`${place.route}/proposals/${queued.id}/apply`, { requestId: randomUUID(), baseVersion: 4, frontConfirmed: false }), 404, 'main apply');
      await expectStatus(await owner.post(`${place.route}/proposals/${queued.id}/cancel`, { requestId: randomUUID() }), 404, 'main cancel');
      assert.deepEqual(await owner.json(scoped(place, a.variant.id)), []);
      await expectStatus(await owner.request(scoped(place, a.variant.id, `/${queued.id}`)), 404, 'other parent get');
      await expectStatus(await owner.post(scoped(place, a.variant.id, `/${queued.id}/apply`), save()), 404, 'other parent apply');
      assert.deepEqual((await owner.json(scoped(place, parent.id))).map((item) => item.id), [queued.id]);
      // Contributors are refused before anything else is read.
      await expectStatus(await session.request(scoped(place, parent.id)), 403, 'contributor');

      // Saving uses the stored result; nothing else changes.
      const saveBody = save();
      const saved = await expectStatus(await owner.post(scoped(place, parent.id, `/${queued.id}/apply`), saveBody), 201, 'save');
      assert.equal(saved.proposal.status, 'applied');
      assert.equal(saved.proposal.appliedVariantId, saved.variant.id);
      assert.equal(saved.proposal.candidate, null);
      assert.deepEqual(saved.variant.edit, ready.candidate);
      assert.deepEqual(saved.variant.revision, { parentVariantId: parent.id, targetId: 'object-1', timeMode: 'unknown', proposalId: queued.id });
      assert.equal(saved.variant.era.kind, 'unknown');
      assert.match(saved.variant.label, /^Alternative arrangement \d+ · Owner revision$/);
      const stored = await disk(dataDir, place);
      assert.deepEqual(stored.collaboration.variants.slice(0, -1), before.collaboration.variants, 'the parent and other alternatives are unchanged');
      assert.equal(stored.edits.length, before.edits.length + 1, 'only the owner main edit made during the call');
      assert.equal(stored.edit.version, 4);
      // Exact replay returns the same child; a new request cannot save it twice.
      const replayed = await expectStatus(await owner.post(scoped(place, parent.id, `/${queued.id}/apply`), saveBody), 200, 'save replay');
      assert.equal(replayed.variant.id, saved.variant.id);
      await expectStatus(await owner.post(scoped(place, parent.id, `/${queued.id}/apply`), save()), 409, 'second save');
      await expectStatus(await owner.post(scoped(place, parent.id, `/${queued.id}/apply`), { ...saveBody, frontConfirmed: true }), 409, 'changed body');

      // The public record says memory and carries no private lineage.
      const preview = await share(owner, place, saved.variant.id);
      assert.equal(preview.publicView.views[0].evidence.arrangement, 'memory');
      const packet = JSON.stringify(preview.publicView);
      for (const secret of [queued.id, parent.id, body.text, 'synthetic-response']) assert.equal(packet.includes(secret), false, secret);
      const manualPreview = await share(owner, place, parent.id);
      assert.equal(manualPreview.publicView.views[0].evidence.arrangement, 'manual');

      await app.close();
      ({ app, owner } = await workspace(p.model, dataDir));
      assert.equal((await expectStatus(await owner.post(scoped(place, parent.id, `/${queued.id}/apply`), saveBody), 200, 'replay after restart')).variant.id, saved.variant.id);
      assert.equal((await expectStatus(await owner.post(scoped(place, parent.id), body), 200, 'create replay after restart')).id, queued.id);
      assert.equal(p.calls.length, 1);
    } finally {
      await app.close();
    }
  });

  it('binds time, clarification, cancellation and grants to the parent and saves nothing otherwise', async () => {
    const p = planner();
    const { app, owner, dataDir } = await workspace(p.model);
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const other = await enrolledContributor(owner, app.base, place.draft.id, 'Second contributor');
      const denied = await recollect(owner, session, place, 'Closer to the window.', 'alternative', { offset: [0.1, 0, 0], yaw: 0 }, 1, false);
      const b = await recollect(owner, other.session, place, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      const baseline = (await variants(owner, place)).find((item) => item.label === 'Saved reconstruction');
      const variantCount = async () => (await disk(dataDir, place)).collaboration.variants.length;
      const count = await variantCount();

      // A parent inheriting a contribution without model permission is refused
      // before anything is sent; manual revision remains available.
      await expectStatus(await owner.post(scoped(place, denied.variant.id), ask()), 403, 'model-denied parent');
      assert.equal(p.calls.length, 0);
      await expectStatus(await owner.post(`${place.route}/variants/${denied.variant.id}/revisions`, revisionBody({ offset: [0.2, 0, 0], yaw: 0 })), 201, 'manual still allowed');
      await expectStatus(await owner.post(scoped(place, b.variant.id), ask({ consent: false })), 403, 'consent');
      await expectStatus(await owner.post(scoped(place, b.variant.id), ask({ targetId: 'object-1' })), 400, 'target');
      await expectStatus(await owner.post(scoped(place, b.variant.id), ask({ timeMode: 'reconfirm-parent' })), 400, 'nothing to reconfirm');
      await expectStatus(await owner.post(scoped(place, b.variant.id), ask({ baseEraRevision: 1 })), 409, 'time revision');
      await expectStatus(await owner.post(scoped(place, randomUUID()), ask()), 404, 'unknown parent');

      // Clarify, a wrong echo and an unchanged result offer nothing to save.
      p.steps.push(admitted({ action: 'clarify', targetId: null, delta: null, question: 'Which side is the front?' }));
      const clarify = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
      assert.equal(clarify.status, 'clarify');
      assert.equal(clarify.question, 'Which side is the front?');
      assert.equal(clarify.candidate, null);
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${clarify.id}/apply`), save()), 409, 'clarify save');
      p.steps.push(admitted({ baseEraRevision: 1 }));
      const wrong = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
      assert.equal(wrong.status, 'failed');
      p.steps.push(admitted({ delta: [0, 0, 0] }));
      const unchanged = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
      assert.equal(unchanged.status, 'failed');
      assert.match(unchanged.error, /leave the selected arrangement as it is/);

      // Cancellation stops the call; a late answer is recorded only as usage.
      let hold = held();
      p.steps.push(admitted({}, hold));
      const canceled = await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202);
      await hold.reached.promise;
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${canceled.id}/cancel`), { requestId: randomUUID() }), 200, 'cancel');
      const afterCancel = await settle(owner, scoped(place, b.variant.id, `/${canceled.id}`));
      assert.equal(afterCancel.status, 'canceled');
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${canceled.id}/apply`), save()), 409, 'canceled save');

      // A new parent time while planning makes the proposal stale at once; its
      // late admission is refused and it can never be saved.
      hold = held();
      p.steps.push(admitted({}, hold));
      const timed = await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202);
      await hold.reached.promise;
      await expectStatus(await owner.post(`${place.route}/variants/${b.variant.id}/era`, eraBody(0)), 200, 'era');
      assert.equal((await owner.json(scoped(place, b.variant.id, `/${timed.id}`))).status, 'stale');
      hold.release.open();
      assert.equal((await settle(owner, scoped(place, b.variant.id, `/${timed.id}`))).status, 'stale');
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${timed.id}/apply`), save({ baseEraRevision: 1 })), 409, 'stale save');
      assert.equal(await variantCount(), count + 1, 'only the manual revision was saved');

      // The owner may reconfirm the parent's time; the child gets a new owner assertion.
      p.steps.push(admitted());
      const reconfirm = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask({ baseEraRevision: 1, timeMode: 'reconfirm-parent' })), 202)).id}`));
      assert.equal(reconfirm.status, 'ready', reconfirm.error);
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${reconfirm.id}/apply`), save()), 409, 'old time in save');
      const confirmedBody = save({ baseEraRevision: 1 });
      const confirmed = await expectStatus(await owner.post(scoped(place, b.variant.id, `/${reconfirm.id}/apply`), confirmedBody), 201, 'reconfirm save');
      assert.equal(confirmed.variant.era.start, '1990-05-01');
      assert.equal(confirmed.variant.eraRevision, 1);
      assert.equal(confirmed.variant.revision.timeMode, 'reconfirm-parent');

      // A contribution used only by main never stops a proposal for an independent parent.
      const c = await recollect(owner, session, place, 'It was lower.', 'adopt', { offset: [0, -0.1, 0], yaw: 0 }, 1);
      hold = held();
      p.steps.push(admitted({}, hold));
      const independent = await expectStatus(await owner.post(scoped(place, baseline.id), ask()), 202);
      await hold.reached.promise;
      await expectStatus(await session.post(`${place.route}/contributions/${c.id}/withdraw`, { requestId: randomUUID() }), 200, 'main-only withdrawal');
      hold.release.open();
      const independentReady = await settle(owner, scoped(place, baseline.id, `/${independent.id}`));
      assert.equal(independentReady.status, 'ready', independentReady.error);

      // Model-off blocks a new save; a committed save still resolves by exact replay, even after a later time change.
      await expectStatus(await owner.post(`${place.route}/variants/${b.variant.id}/era`, eraBody(1)), 200, 'later era');
      await restrict(owner, place, { place: true, model: false, share: true });
      await expectStatus(await owner.post(scoped(place, baseline.id, `/${independent.id}/apply`), save()), 403, 'model off save');
      assert.equal((await expectStatus(await owner.post(scoped(place, b.variant.id, `/${reconfirm.id}/apply`), confirmedBody), 200, 'committed replay')).variant.id, confirmed.variant.id);
      await expectStatus(await owner.post(scoped(place, baseline.id), ask()), 403, 'model off plan');
      await expectStatus(await owner.post(`${place.route}/variants/${baseline.id}/revisions`, revisionBody({ offset: [0, 0.3, 0], yaw: 0 })), 201, 'manual after model off');

      // Withdrawing the parent's contribution redacts its proposals and blocks the child and its replay.
      await expectStatus(await other.session.post(`${place.route}/contributions/${b.id}/withdraw`, { requestId: randomUUID() }), 200, 'parent withdrawal');
      const redacted = await owner.json(scoped(place, b.variant.id, `/${reconfirm.id}`));
      assert.equal(redacted.redacted, true);
      assert.equal(redacted.statement.text, null);
      assert.equal(redacted.candidate, null);
      assert.deepEqual(redacted.scope, reconfirm.scope);
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${reconfirm.id}/apply`), confirmedBody), 409, 'withdrawn replay');
      assert.equal((await owner.json(scoped(place, baseline.id, `/${independent.id}`))).redacted, undefined, 'an independent parent is unaffected');
    } finally {
      await app.close();
    }
  });

  it('scrubs scoped proposals on deletion, fails closed on a storage fault and interrupts work on restart', async () => {
    const p = planner();
    let { app, owner, dataDir } = await workspace(p.model);
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const b = await recollect(owner, session, place, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      p.steps.push(admitted());
      const ready = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
      assert.equal(ready.status, 'ready', ready.error);

      // A failed manifest write publishes no child and leaves the proposal ready.
      const jobDir = path.dirname(manifestFile(dataDir, place));
      const before = await readFile(manifestFile(dataDir, place));
      await chmod(jobDir, 0o500);
      let status;
      try {
        status = (await owner.post(scoped(place, b.variant.id, `/${ready.id}/apply`), save())).status;
      } finally {
        await chmod(jobDir, 0o700);
      }
      assert.ok(status >= 500, `storage failure answered ${status}`);
      assert.deepEqual(await readFile(manifestFile(dataDir, place)), before);
      const saveBody = save();
      const saved = await expectStatus(await owner.post(scoped(place, b.variant.id, `/${ready.id}/apply`), saveBody), 201, 'retry');

      // Deleting the parent's contribution scrubs its scoped proposals and blocks
      // the child and its replay; main, which never used it, stays usable.
      const baseline = (await variants(owner, place)).find((item) => item.label === 'Saved reconstruction');
      const preview = await expectStatus(await session.request(`${place.route}/contributions/${b.id}/deletion`), 200, 'deletion preview');
      await expectStatus(await session.post(`${place.route}/contributions/${b.id}/delete`, { requestId: randomUUID(), impactSha256: preview.impactSha256, confirmDeletion: true }), 200, 'delete');
      const [scrubbed] = (await disk(dataDir, place)).proposals.filter((item) => item.scope);
      assert.equal(scrubbed.statement.text, null);
      assert.equal(scrubbed.result, null);
      assert.equal((await owner.json(scoped(place, b.variant.id, `/${ready.id}`))).redacted, true);
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${ready.id}/apply`), saveBody), 409, 'deleted replay');
      assert.equal((await variants(owner, place)).find((item) => item.id === saved.variant.id).blocked, true);
      await expectStatus(await owner.post(`${place.route}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0, 0, 0.2], yaw: 0 }), 200, 'main still usable');

      // Work still running when the app stops is interrupted on restart; usage only.
      const hold = held();
      p.steps.push(admitted({}, hold));
      const running = await expectStatus(await owner.post(scoped(place, baseline.id), ask()), 202);
      await hold.reached.promise;
      await app.close();
      ({ app, owner } = await workspace(p.model, dataDir));
      assert.equal((await owner.json(scoped(place, baseline.id, `/${running.id}`))).status, 'interrupted');
    } finally {
      await app.close();
    }
  });
});

describe('memory proposal boundaries for a selected saved alternative', () => {
  it('treats an exact full turn as no change from a turned parent, while a small real turn is offered', async () => {
    const p = planner();
    const { app, owner } = await workspace(p.model);
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      // 0.3 plus and minus a full turn (2 * pi) is not exactly 0.3 in floating point.
      const b = await recollect(owner, session, place, 'Turned toward the door.', 'alternative', { offset: [0.1, 0, 0], yaw: 0.3 }, 1);
      for (const yawDelta of [2 * Math.PI, -2 * Math.PI]) {
        p.steps.push(admitted({ action: 'rotate', delta: null, yawDelta }));
        const turn = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
        assert.equal(turn.status, 'failed', `full turn ${yawDelta}`);
        assert.match(turn.error, /leave the selected arrangement as it is/);
      }
      p.steps.push(admitted({ action: 'rotate', delta: null, yawDelta: 0.1 }));
      const small = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
      assert.equal(small.status, 'ready', small.error);
      assert.equal(small.candidate.yaw, 0.4);
    } finally {
      await app.close();
    }
  });

  it('requires the photo to be public material at every outbound step, not only at creation', async () => {
    const p = planner();
    const { app, owner, dataDir } = await workspace(p.model);
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const b = await recollect(owner, session, place, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      const hold = held();
      let sent = null;
      p.steps.push(async (call) => {
        hold.reached.open();
        await hold.release.promise;
        sent = await call.admit(() => true);
        return sent ? plan(call) : { ok: false, reason: 'provider', model: null, usage: null, responseId: null };
      });
      const queued = await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202);
      await hold.reached.promise;
      // The recorded origin no longer says public material (synthetic temp data).
      const draftFile = path.join(dataDir, 'drafts', place.draft.id, 'draft.json');
      const draft = JSON.parse(await readFile(draftFile, 'utf8'));
      await writeFile(draftFile, JSON.stringify({ ...draft, sources: draft.sources.map((item) => ({ ...item, origin: { kind: 'private', reference: '' } })) }));
      hold.release.open();
      const ended = await settle(owner, scoped(place, b.variant.id, `/${queued.id}`));
      assert.equal(sent, null, 'no outbound request was admitted');
      assert.equal(ended.status, 'failed');
      assert.equal(ended.candidate, null);
    } finally {
      await app.close();
    }
  });

  it('refuses a first save once the stored photo is no longer public material, while a committed save still replays', async () => {
    const p = planner();
    const { app, owner, dataDir } = await workspace(p.model);
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const b = await recollect(owner, session, place, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      const proposeReady = async () => {
        p.steps.push(admitted());
        const ready = await settle(owner, scoped(place, b.variant.id, `/${(await expectStatus(await owner.post(scoped(place, b.variant.id), ask()), 202)).id}`));
        assert.equal(ready.status, 'ready', ready.error);
        return ready;
      };
      const committed = await proposeReady();
      const committedBody = save();
      const child = await expectStatus(await owner.post(scoped(place, b.variant.id, `/${committed.id}/apply`), committedBody), 201, 'committed');
      const pending = await proposeReady();
      const count = (await disk(dataDir, place)).collaboration.variants.length;
      await setOrigin(dataDir, place.draft.id, 'private');
      await expectStatus(await owner.post(scoped(place, b.variant.id, `/${pending.id}/apply`), save()), 403, 'first save after origin change');
      assert.equal((await disk(dataDir, place)).collaboration.variants.length, count, 'no child');
      assert.equal((await owner.json(scoped(place, b.variant.id, `/${pending.id}`))).status, 'ready', 'still unsaved');
      assert.equal((await expectStatus(await owner.post(scoped(place, b.variant.id, `/${committed.id}/apply`), committedBody), 200, 'committed replay')).variant.id, child.variant.id);
    } finally {
      await app.close();
    }
  });

  it('stops on a restriction during image preparation or admission and when the place is deleted while planning', async () => {
    const p = planner();
    let preparing = null;
    const prepare = async () => {
      if (preparing) {
        preparing.reached.open();
        await preparing.release.promise;
      }
      return jpeg(40, 30, 1);
    };
    const { app, owner, dataDir } = await workspace(p.model, null, prepare);
    try {
      const childCount = async (place) => (await disk(dataDir, place)).collaboration.variants.filter((item) => item.kind === 'revision').length;
      // Model use turned off while the photo is being prepared: nothing is sent.
      const first = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, first.draft.id);
      const b = await recollect(owner, session, first, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      preparing = held();
      const prepared = await expectStatus(await owner.post(scoped(first, b.variant.id), ask()), 202);
      await preparing.reached.promise;
      await restrict(owner, first, { place: true, model: false, share: true });
      preparing.release.open();
      preparing = null;
      const stopped = await settle(owner, scoped(first, b.variant.id, `/${prepared.id}`));
      assert.ok(['failed', 'interrupted'].includes(stopped.status), stopped.status);
      assert.equal(p.calls.length, 0, 'the model was never called');
      assert.equal(await childCount(first), 0);

      // Place use stopped while the call waits for admission: the request is refused and no result is offered.
      const second = await scene(owner);
      const other = await enrolledContributor(owner, app.base, second.draft.id);
      const c = await recollect(owner, other.session, second, 'Further back.', 'alternative', { offset: [0, 0, 0], yaw: 0.4 }, 1);
      let sent = 'not reached';
      let hold = held();
      p.steps.push(async (call) => {
        hold.reached.open();
        await Promise.race([hold.release.promise, new Promise((resolve) => call.signal.addEventListener('abort', resolve))]);
        sent = await call.admit(() => true);
        return sent ? plan(call) : { ok: false, reason: 'provider', model: null, usage: null, responseId: null };
      });
      const admittedLate = await expectStatus(await owner.post(scoped(second, c.variant.id), ask()), 202);
      await hold.reached.promise;
      await restrict(owner, second, { place: false, model: false, share: false });
      hold.release.open();
      const refused = await settle(owner, scoped(second, c.variant.id, `/${admittedLate.id}`));
      assert.equal(sent, null);
      assert.notEqual(refused.status, 'ready');
      assert.equal(refused.candidate, null);
      assert.equal(await childCount(second), 0);

      // The place is deleted while a call is out: the late answer is never stored or offered.
      const third = await scene(owner);
      const third2 = await enrolledContributor(owner, app.base, third.draft.id);
      const d = await recollect(owner, third2.session, third, 'Closer to the wall.', 'alternative', { offset: [0, 0, 0], yaw: 0.2 }, 1);
      sent = 'not reached';
      hold = held();
      p.steps.push(async (call) => {
        hold.reached.open();
        await Promise.race([hold.release.promise, new Promise((resolve) => call.signal.addEventListener('abort', resolve))]);
        sent = await call.admit(() => true).catch(() => null);
        return sent ? plan(call) : { ok: false, reason: 'provider', model: null, usage: null, responseId: null };
      });
      await expectStatus(await owner.post(scoped(third, d.variant.id), ask()), 202);
      await hold.reached.promise;
      const review = await expectStatus(await owner.request(`/api/drafts/${third.draft.id}/deletion`), 200, 'place deletion review');
      const removal = await owner.post(`/api/drafts/${third.draft.id}/delete`, { requestId: randomUUID(), impactSha256: review.impactSha256, confirmDeletion: true });
      assert.ok([200, 202].includes(removal.status), `place deletion answered ${removal.status} ${JSON.stringify(await removal.json())}`);
      hold.release.open();
      for (let attempt = 0; attempt < 200 && sent === 'not reached'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(sent, null, 'no request is admitted for a deleted place');
      assert.equal((await owner.request(scoped(third, d.variant.id))).status, 404);
    } finally {
      await app.close();
    }
  });

  it('refuses a result that breaks the parent rule or overlaps the actual surfaces at completion', async () => {
    const p = planner();
    const { app, owner, dataDir } = await workspace(p.model);
    try {
      const place = await scene(owner, OBJECTS);
      await expectStatus(await owner.post(`${place.route}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true }), 200, 'rule');
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const a = await recollect(owner, session, place, 'The counter stood higher.', 'alternative', { targetId: 'object-1', offset: [0, 0.2, 0], yaw: 0 }, 2);
      const count = (await disk(dataDir, place)).collaboration.variants.length;
      p.steps.push(admitted({ targetId: 'object-1', delta: [2, 0, 0] }));
      const rule = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(rule.status, 'failed');
      assert.match(rule.error, /relationship/);
      p.steps.push(admitted({ targetId: 'object-1', delta: [1.2, 0, 0] }));
      const overlap = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(overlap.status, 'failed');
      assert.match(overlap.error, /overlap|could not finish/);
      for (const item of [rule, overlap]) {
        assert.equal(item.candidate, null);
        await expectStatus(await owner.post(scoped(place, a.variant.id, `/${item.id}/apply`), save()), 409, 'refused save');
      }
      assert.equal((await disk(dataDir, place)).collaboration.variants.length, count);
    } finally {
      await app.close();
    }
  });
});

describe('memory proposals for a saved two-photo composition', () => {
  const pose = (x, scale = 1) => ({ position: [x, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]), scale });

  it('sends both ordered photos and the parent poses, keeps exact scale and gates facing on confirmation', async () => {
    const p = planner();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-alternative-memory-composition-'));
    tempDirs.push(dataDir);
    const compositionRunner = async ({ imagePath, outputDir, sourceId, box }) => {
      const original = await readFile(imagePath), fill = original.at(-1);
      const texture = jpeg(40, 30, fill);
      const surface = {
        source: { source_id: sourceId, sha256: sha256(original), image_size: [40, 30], texture: { file: 'texture.jpg', sha256: sha256(texture) }, selected_object: { box_xyxy: box } },
        width: 8, height: 6, depth: Array.from({ length: 48 }, (_, i) => 3 + Math.sin(i * 0.3) * 0.04), foreground: Array.from({ length: 48 }, (_, i) => (i % 8 < 3 ? 1 : 0)),
        assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
      };
      const files = { 'surface.json': JSON.stringify(surface), 'texture.jpg': texture, 'depth-preview.png': png(8, 6), 'mask.png': png(40, 30), 'mask-overlay.jpg': texture,
        'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: surface.source.sha256, texture_sha256: sha256(texture) }) };
      await mkdir(outputDir);
      for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(outputDir, name), bytes);
      return { exitCode: 0 };
    };
    const prepared = [];
    const app = await startOwnerServer({ dataDir, reconstructionRunner: compositionRunner, proposalModel: p.model, prepareModelImage: async (call) => { prepared.push(call.imagePath); return jpeg(40, 30); } });
    try {
      const owner = client(app.base, app.cookie), form = new FormData();
      for (const fill of [7, 8]) form.append('photos', new Blob([png(40, 30, fill)]), 'photo.png');
      form.append('metadata', JSON.stringify({ photos: [GRANT, GRANT] }));
      const draft = await expectStatus(await owner.request('/api/drafts', { method: 'POST', body: form }), 201, 'draft');
      const base = `/api/drafts/${draft.id}/reconstructions`, parents = [];
      for (const photo of draft.photos) {
        let built = await expectStatus(await owner.post(base, { requestId: randomUUID(), sourceId: photo.sourceId, box: [1, 1, 18, 28] }), 202, 'build');
        for (let i = 0; i < 200 && ['queued', 'processing'].includes(built.status); i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          built = await owner.json(`${base}/${built.id}`);
        }
        parents.push(built);
      }
      const job = await expectStatus(await owner.post(base, {
        kind: 'two-photo-composition', requestId: randomUUID(), context: { keep: true, bounds: [0, 0, 40, 30] }, confirmed: true, scaleBasis: 'owner-assumed-relative',
        objects: parents.map((built, index) => ({ label: `Component ${index + 1}`, pose: pose(index ? 3 : -3, index ? 0.7 : 1.1),
          component: { jobId: built.id, objectId: 'selected-foreground', surfaceSha256: built.derivedAssets.find((item) => item.name === 'surface.json').sha256 } })),
      }), 201, 'compose');
      const place = { draft, job, route: `${base}/${job.id}` };
      await expectStatus(await owner.post(`${place.route}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'], surfaceIdentityConfirmed: true, layoutConfirmed: true, scaleBasis: 'owner-assumed-relative' }), 200, 'confirm');
      const { session } = await enrolledContributor(owner, app.base, draft.id);
      const a = await recollect(owner, session, place, 'The first piece sat closer.', 'alternative', { targetId: 'object-1', pose: { position: [-2.5, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]) } }, 1);
      await expectStatus(await owner.post(`${place.route}/edit`, { requestId: randomUUID(), baseVersion: 1, targetId: 'object-2', pose: pose(3.2, 0.9) }), 200, 'main edit');
      const scene = await disk(dataDir, place);

      p.steps.push(admitted({ targetId: 'object-1', action: 'rotate', delta: null, yawDelta: 0.3 }));
      const rotate = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(rotate.status, 'ready', rotate.error);
      const [call] = p.calls;
      assert.equal(prepared.length, 2);
      assert.deepEqual(call.images.map((item) => item.sourceId), scene.sourceBindings.map((item) => item.sourceId));
      assert.deepEqual(call.images.map((item) => item.selection), scene.objects.map((item) => item.box));
      assert.deepEqual(call.alternative, { parentVariantId: a.variant.id, baseEraRevision: 0 });
      assert.equal(Object.hasOwn(call, 'baseVersion'), false);
      assert.deepEqual(call.arrangement, { frame: 'owner-composition', objects: a.variant.edit.objects, relationship: a.variant.edit.relationship });
      assert.deepEqual(call.objects.map((item) => ({ id: item.id, ...item.pose })), a.variant.edit.objects);
      const [first, second] = a.variant.edit.objects;
      assert.equal(rotate.candidate.objects[0].scale, first.scale);
      assert.deepEqual(rotate.candidate.objects[1], second, 'the parent pose, not the main edit');
      const savedBody = save();
      const saved = await expectStatus(await owner.post(scoped(place, a.variant.id, `/${rotate.id}/apply`), savedBody), 201, 'save');
      assert.deepEqual(saved.variant.edit, rotate.candidate);
      assert.equal(saved.variant.edit.objects[1].scale, 0.7);

      // An exact full turn of a tilted parent pose is no change.
      p.steps.push(admitted({ targetId: 'object-1', action: 'rotate', delta: null, yawDelta: 2 * Math.PI }));
      const fullTurn = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(fullTurn.status, 'failed');
      assert.match(fullTurn.error, /leave the selected arrangement as it is/);

      // A result that leaves the parent exactly as it is is never offered.
      p.steps.push(admitted({ targetId: 'object-1', delta: [0, 0, 0] }));
      const same = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(same.status, 'failed');
      assert.match(same.error, /leave the selected arrangement as it is/);

      // Facing the other object needs the owner's front confirmation before saving.
      p.steps.push(admitted({ targetId: 'object-1', action: 'face_object', delta: null, faceObjectId: 'object-2' }));
      const face = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(face.status, 'ready', face.error);
      await expectStatus(await owner.post(scoped(place, a.variant.id, `/${face.id}/apply`), save()), 409, 'front not confirmed');
      const faced = await expectStatus(await owner.post(scoped(place, a.variant.id, `/${face.id}/apply`), save({ frontConfirmed: true })), 201, 'front confirmed');
      assert.equal(faced.variant.edit.objects[0].scale, first.scale);
      const after = await disk(dataDir, place);
      assert.deepEqual(after.edit, scene.edit, 'main is unchanged');

      // A first save needs both stored photos to be public material; a committed save still replays.
      p.steps.push(admitted({ targetId: 'object-1', delta: [0, 0.05, 0] }));
      const pending = await settle(owner, scoped(place, a.variant.id, `/${(await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202)).id}`));
      assert.equal(pending.status, 'ready', pending.error);
      await setOrigin(dataDir, draft.id, 'private', [1]);
      await expectStatus(await owner.post(scoped(place, a.variant.id, `/${pending.id}/apply`), save()), 403, 'second photo no longer public');
      assert.equal((await expectStatus(await owner.post(scoped(place, a.variant.id, `/${rotate.id}/apply`), savedBody), 200, 'committed replay')).variant.id, saved.variant.id);
      await setOrigin(dataDir, draft.id, 'public', [1]);
      await expectStatus(await owner.post(scoped(place, a.variant.id, `/${pending.id}/apply`), save()), 201, 'saved once public again');

      // Both photos are checked: a changed second original refuses planning.
      const secondPhoto = path.join(dataDir, 'drafts', draft.id, draft.photos[1].name);
      const bytes = await readFile(secondPhoto);
      await writeFile(secondPhoto, Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1) ^ 1])]));
      const calls = p.calls.length;
      await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 409, 'second original changed');
      await writeFile(secondPhoto, bytes);
      // Model use of the second photo turned off while the call waits: nothing is admitted.
      let sent = 'not reached';
      const hold = held();
      p.steps.push(async (call) => {
        hold.reached.open();
        await Promise.race([hold.release.promise, new Promise((resolve) => call.signal.addEventListener('abort', resolve))]);
        sent = await call.admit(() => true);
        return sent ? plan(call, { targetId: 'object-1' }) : { ok: false, reason: 'provider', model: null, usage: null, responseId: null };
      });
      const waiting = await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 202);
      await hold.reached.promise;
      await restrict(owner, place, { place: true, model: false, share: true }, 1);
      hold.release.open();
      const refused = await settle(owner, scoped(place, a.variant.id, `/${waiting.id}`));
      assert.equal(sent, null);
      assert.notEqual(refused.status, 'ready');
      await expectStatus(await owner.post(scoped(place, a.variant.id), ask({ targetId: 'object-1' })), 403, 'second photo without model use');
      assert.equal(p.calls.length, calls + 1, 'only the admitted-then-refused call was prepared');
    } finally {
      await app.close();
    }
  });
});
