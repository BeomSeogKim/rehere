import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { quaternionFromEuler } from '../public/composition-scene.js';
import { client, enrolledContributor, jpeg, png, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic scenes, recollections and recordings only. An owner revision
// derives a new immutable alternative from a saved one; nothing here
// interprets a contributor's words or calls a model.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const GRANT = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const audioDecoder = async () => ({ pcm: Buffer.alloc(32_000), sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];
const GRID = { width: 16, height: 12 };
const LEFT_OF = { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' };

// One-photo scenes: a single foreground, or two objects in separate column bands.
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

async function workspace(dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-revisions-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner, audioDecoder });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function expectStatus(response, status, label = '') {
  const body = await response.json();
  assert.equal(response.status, status, `${label} ${JSON.stringify(body)}`);
  return body;
}

async function scene(owner, { objects = null, voice = false } = {}) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  if (voice) form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice');
  form.append('metadata', JSON.stringify({ photos: [GRANT], ...(voice && { voice: GRANT }) }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const build = objects ? { objects } : { box: [4, 3, 20, 24] };
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, ...build })).json();
  const route = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && ['queued', 'processing'].includes((await owner.json(route)).status); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (objects) await expectStatus(await owner.post(`${route}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] }), 200, 'confirm');
  return { draft, job, route, original: `/api/drafts/${draft.id}/assets/${draft.photos[0].name}` };
}

const manifestFile = (dataDir, place) => path.join(dataDir, 'reconstructions', place.draft.id, place.job.id, 'manifest.json');
const disk = async (dataDir, place) => JSON.parse(await readFile(manifestFile(dataDir, place), 'utf8'));
const view = (owner, place) => owner.json(`${place.route}/collaboration`);
const revisions = (place, id) => `${place.route}/variants/${id}/revisions`;
const context = (place, id) => `${place.route}/variants/${id}/revision-context`;
const revisionBody = (transform, change = {}) => ({ requestId: randomUUID(), baseEraRevision: 0, transform, timeMode: 'unknown', confirmed: true, ...change });
const policyRoute = (place, index = 0) => `/api/drafts/${place.draft.id}/sources/${place.draft.photos[index].sourceId}/policy`;

async function restrict(owner, place, permissions, index = 0) {
  const { revision } = await owner.json(policyRoute(place, index));
  await expectStatus(await owner.post(policyRoute(place, index), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse: false }), 200, 'restrict');
}

// A recollection with place and share grants but no model grant, reviewed by the owner.
async function recollect(owner, session, place, text, decision, transform, baseVersion) {
  const submitted = await expectStatus(await session.post(`${place.route}/contributions`, { requestId: randomUUID(), text, permissions: { place: true, model: false, share: true }, periodClaim: '' }), 200, 'submit');
  const body = { requestId: randomUUID(), baseVersion, baseRevision: 1, decision, reason: 'Synthetic note.', conflict: 'unknown', transform };
  const reviewed = await expectStatus(await owner.post(`${place.route}/contributions/${submitted.id}/review`, body), 200, 'review');
  return { id: submitted.id, variant: reviewed.variant };
}

async function share(owner, place, views, extra = {}) {
  const body = { requestId: randomUUID(), title: 'Synthetic place', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, ...extra };
  const preview = await owner.post(`${place.route}/shares/previews`, body);
  if (preview.status !== 201) return { status: preview.status, error: await preview.json() };
  const created = await preview.json();
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  await expectStatus(await owner.post(`${place.route}/shares`, { requestId: randomUUID(), previewId: created.id, previewDigest: created.digest, token, consent: true }), 201, 'issue');
  return { status: 201, preview: created, token };
}
const variantView = (id) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: id });

describe('owner revisions of saved alternatives', () => {
  it('revises one object from the parent arrangement, leaving main, the parent and originals unchanged, across replay and restart', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner, { objects: OBJECTS });
      await expectStatus(await owner.post(`${place.route}/relationship`, { requestId: randomUUID(), baseVersion: 1, relationship: LEFT_OF, confirmed: true }), 200, 'rule');
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const a = await recollect(owner, session, place, 'The counter stood higher.', 'alternative', { targetId: 'object-1', offset: [0, 0.2, 0], yaw: 0 }, 2);
      // Main moves the other object afterwards; the revision must not see it.
      await expectStatus(await owner.post(`${place.route}/edit`, { requestId: randomUUID(), baseVersion: 2, targetId: 'object-2', offset: [0.1, 0, 0], yaw: 0.1 }), 200, 'main edit');
      const snapshot = await share(owner, place, [variantView(a.variant.id)]);
      assert.equal(snapshot.status, 201);
      const before = await disk(dataDir, place);
      const originalBytes = Buffer.from(await (await owner.request(place.original)).arrayBuffer());

      const prepared = await expectStatus(await owner.request(context(place, a.variant.id)), 200, 'context');
      assert.deepEqual(prepared, {
        parentVariantId: a.variant.id, eraRevision: 0, latestEra: a.variant.era, edit: a.variant.edit, contributionIds: a.variant.contributionIds, revisionAllowed: true,
        statementSources: [{ statementSource: { kind: 'contribution-text', contributionId: a.id, sourceSha256: sha256('The counter stood higher.') },
          text: 'The counter stood higher.', attribution: { kind: 'contribution-text', providerLabel: 'Synthetic contributor', creator: null, originKind: 'unknown', reference: '' }, modelAllowed: false }],
      });
      // Contributors are refused before any body is read.
      await expectStatus(await session.request(context(place, a.variant.id)), 403, 'contributor context');
      assert.equal((await session.post(revisions(place, a.variant.id), '{not json')).status, 403);

      const body = revisionBody({ targetId: 'object-1', offset: [0, 0.2, 0.1], yaw: 0.3 });
      const child = await expectStatus(await owner.post(revisions(place, a.variant.id), body), 201, 'revision');
      assert.deepEqual(child.edit, {
        version: null,
        objects: [{ id: 'object-1', offset: [0, 0.2, 0.1], yaw: 0.3 }, a.variant.edit.objects[1]],
        relationship: LEFT_OF,
      });
      assert.deepEqual(a.variant.edit.objects[1], { id: 'object-2', offset: [0, 0, 0], yaw: 0 }, 'the parent, not main, supplies the untargeted object');
      assert.deepEqual(child.revision, { parentVariantId: a.variant.id, targetId: 'object-1', timeMode: 'unknown' });
      assert.equal(child.targetId, null);
      assert.equal(child.label, 'Alternative arrangement 2 · Owner revision');
      assert.deepEqual(child.contributionIds, a.variant.contributionIds);
      assert.equal(child.parentVersion, a.variant.parentVersion);
      assert.equal(child.era.kind, 'unknown');
      assert.equal(child.eraRevision, 0);
      const listed = await view(owner, place);
      for (const item of listed.variants.filter((entry) => entry.id !== child.id)) assert.equal(Object.hasOwn(item, 'revision'), false, 'older shapes are unchanged');

      const afterSave = await disk(dataDir, place);
      for (const key of ['edit', 'edits', 'proposals', 'shares', 'stories']) assert.deepEqual(afterSave[key], before[key], key);
      assert.deepEqual(afterSave.collaboration.contributions, before.collaboration.contributions);
      assert.deepEqual(afterSave.collaboration.variants.slice(0, -1), before.collaboration.variants);
      assert.deepEqual(Buffer.from(await (await owner.request(place.original)).arrayBuffer()), originalBytes);

      // Exact replay, reuse with other values or another parent, a fresh request and a no-op.
      assert.equal((await expectStatus(await owner.post(revisions(place, a.variant.id), body), 200, 'replay')).id, child.id);
      await expectStatus(await owner.post(revisions(place, a.variant.id), { ...body, transform: { ...body.transform, yaw: 0.31 } }), 409, 'changed body');
      const baseline = listed.variants.find((item) => item.label === 'Saved reconstruction');
      await expectStatus(await owner.post(revisions(place, baseline.id), body), 409, 'other parent');
      const again = await expectStatus(await owner.post(revisions(place, a.variant.id), { ...body, requestId: randomUUID() }), 201, 'new request');
      assert.notEqual(again.id, child.id);
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', offset: [0, 0.2, 0], yaw: 0 })), 409, 'no-op');
      // The yaw endpoints are one orientation; a tiny real change still saves.
      const half = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', offset: [0, 0.2, 0], yaw: Math.PI })), 201, 'yaw PI');
      await expectStatus(await owner.post(revisions(place, half.id), revisionBody({ targetId: 'object-1', offset: [0, 0.2, 0], yaw: -Math.PI })), 409, 'yaw -PI no-op');
      assert.equal(half.edit.objects[0].yaw, Math.PI, 'stored as sent');
      await expectStatus(await owner.post(revisions(place, half.id), revisionBody({ targetId: 'object-1', offset: [0, 0.2, 1e-9], yaw: -Math.PI })), 201, 'tiny change');

      // Two identical requests at once save one child.
      const twin = revisionBody({ targetId: 'object-2', offset: [0, -0.1, 0], yaw: 0 });
      const both = await Promise.all([0, 1].map(() => owner.post(revisions(place, a.variant.id), twin)));
      assert.deepEqual(both.map((item) => item.status).sort(), [200, 201]);
      const [first, second] = await Promise.all(both.map((item) => item.json()));
      assert.equal(first.id, second.id);

      // The parent's rule and the actual named surfaces gate the child; nothing is written.
      const unchanged = await readFile(manifestFile(dataDir, place));
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', offset: [2, 0.2, 0], yaw: 0 })), 409, 'rule');
      const overlap = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', offset: [1.2, 0.2, 0], yaw: 0 })), 409, 'overlap');
      assert.match(overlap.error, /overlap|could not finish/);
      assert.deepEqual(await readFile(manifestFile(dataDir, place)), unchanged);

      // A revision can be revised again, and frozen and adopted parents also qualify.
      const grandchild = await expectStatus(await owner.post(revisions(place, child.id), revisionBody({ targetId: 'object-2', offset: [0, 0.1, 0], yaw: 0 })), 201, 'revise revision');
      assert.deepEqual(grandchild.edit.objects[0], child.edit.objects[0]);
      assert.equal(grandchild.revision.parentVariantId, child.id);
      const b = await recollect(owner, session, place, 'The stack was taller.', 'adopt', { targetId: 'object-2', offset: [0, 0.3, 0], yaw: 0 }, 3);
      const parents = await disk(dataDir, place);
      for (const parent of [baseline, b.variant]) {
        const derived = await expectStatus(await owner.post(revisions(place, parent.id), revisionBody({ targetId: 'object-1', offset: [-0.1, 0, 0], yaw: 0 })), 201, 'frozen parent');
        assert.equal(derived.edit.version, null);
        assert.equal(derived.parentVersion, parent.parentVersion);
        assert.deepEqual(derived.edit.objects[1], parent.edit.objects[1]);
      }
      const later = await disk(dataDir, place);
      assert.deepEqual(later.collaboration.variants.slice(0, parents.collaboration.variants.length), parents.collaboration.variants);
      assert.deepEqual(later.edit, parents.edit);

      // A new snapshot of the child records a manual owner change; the earlier snapshot is untouched.
      const shared = await share(owner, place, [variantView(child.id)]);
      assert.equal(shared.status, 201, JSON.stringify(shared.error));
      const [publicView] = shared.preview.publicView.views;
      assert.equal(publicView.evidence.arrangement, 'manual');
      assert.equal(JSON.stringify(shared.preview.publicView).includes(a.variant.id), false, 'no private lineage');
      assert.deepEqual(later.shares.snapshots[0], before.shares.snapshots[0]);

      await app.close();
      ({ app, owner } = await workspace(dataDir));
      assert.equal((await expectStatus(await owner.post(revisions(place, a.variant.id), body), 200, 'replay after restart')).id, child.id);
      assert.equal((await view(owner, place)).variants.filter((item) => item.revision).length, 8);
      const visit = await globalThis.fetch(`${app.base}/api/visit`, { headers: { authorization: `Bearer ${snapshot.token}` } });
      assert.equal(visit.status, 200);
    } finally {
      await app.close();
    }
  });

  it('starts time unknown or as a new owner confirmation, bound to the parent time revision', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner, { voice: true });
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const other = await enrolledContributor(owner, app.base, place.draft.id, 'Second contributor');
      const a = await recollect(owner, session, place, 'The counter faced the door.', 'alternative', { offset: [0, 0, 0.1], yaw: 0.2 }, 1);
      const c = await recollect(owner, other.session, place, 'It was further back.', 'alternative', { offset: [0, 0, -0.1], yaw: 0 }, 1);
      const era = (change) => ({ requestId: randomUUID(), kind: 'relative', label: 'before the renovation', start: null, end: null, statement: 'The owner places this before the renovation.', relation: 'before', relativeToVariantId: c.variant.id, confirmed: true, ...change });
      await expectStatus(await owner.post(`${place.route}/variants/${a.variant.id}/era`, era({ baseRevision: 0 })), 200, 'era');
      const transform = { offset: [0, 0.1, 0.1], yaw: 0.2 };

      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody(transform)), 409, 'stale time revision');
      const reconfirmed = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody(transform, { baseEraRevision: 1, timeMode: 'reconfirm-parent' })), 201, 'reconfirm');
      const parentEra = (await view(owner, place)).variants.find((item) => item.id === a.variant.id).era;
      for (const key of ['kind', 'label', 'start', 'end', 'statement', 'relation', 'relativeToVariantId']) assert.deepEqual(reconfirmed.era[key], parentEra[key], key);
      assert.equal(reconfirmed.eraRevision, 1);
      assert.equal(reconfirmed.revision.timeMode, 'reconfirm-parent');
      const stored = (await disk(dataDir, place)).collaboration.variants;
      const [parentAssertion] = stored.find((item) => item.id === a.variant.id).eraAssertions;
      const [childAssertion] = stored.find((item) => item.id === reconfirmed.id).eraAssertions;
      assert.notEqual(childAssertion.id, parentAssertion.id);
      assert.equal(childAssertion.confirmed, true);
      assert.equal(stored.find((item) => item.id === a.variant.id).eraAssertions.length, 1, 'the parent keeps its own assertions');
      await expectStatus(await owner.post(revisions(place, c.variant.id), revisionBody(transform, { timeMode: 'reconfirm-parent' })), 400, 'no time to confirm');

      // A story and a new snapshot can select the child through the existing paths.
      const story = await owner.post(`${place.route}/stories`, {
        requestId: randomUUID(), voiceSourceId: place.draft.voice.sourceId, view: { kind: 'variant', version: null, variantId: reconfirmed.id, eraRevision: 1 },
        title: 'Synthetic tone', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic test tone; no speech.' }], captionConfirmed: true,
      });
      assert.ok([200, 201].includes(story.status), JSON.stringify(await story.json()));
      const both = [variantView(reconfirmed.id), variantView(c.variant.id)];
      assert.equal((await share(owner, place, both)).status, 201);

      // A relation is never dropped: an unusable reference refuses the confirmation.
      await expectStatus(await other.session.post(`${place.route}/contributions/${c.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw');
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody(transform, { baseEraRevision: 1, timeMode: 'reconfirm-parent', requestId: randomUUID() })), 409, 'relative target');
      const unknown = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody(transform, { baseEraRevision: 1 })), 201, 'unknown time');
      assert.equal(unknown.era.kind, 'unknown');

      // A parent time change after the preview requires a new review.
      const prepared = await expectStatus(await owner.request(context(place, a.variant.id)), 200, 'context');
      await expectStatus(await owner.post(`${place.route}/variants/${a.variant.id}/era`, { ...era({ baseRevision: 1 }), kind: 'exact', label: '', start: '1990-05-01', end: '1990-05-01', relation: null, relativeToVariantId: null }), 200, 'era change');
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ offset: [0, 0.2, 0.1], yaw: 0.2 }, { baseEraRevision: prepared.eraRevision })), 409, 'time changed');
      const exact = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody(transform, { baseEraRevision: 2, timeMode: 'reconfirm-parent' })), 201, 'exact');
      assert.equal(exact.era.start, '1990-05-01');
    } finally {
      await app.close();
    }
  });

  it('names each owner revision by the ordinal its shares and stories use, stable across blocking, deletion and restart', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner, { voice: true });
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const other = await enrolledContributor(owner, app.base, place.draft.id, 'Second contributor');
      const named = (variant, ordinal) => assert.equal(variant.label, `Alternative arrangement ${ordinal} · Owner revision`);
      // Candidates and revisions interleave; both count, the baseline does not.
      const a = await recollect(owner, session, place, 'Closer to the window.', 'alternative', { offset: [0.1, 0, 0], yaw: 0 }, 1);
      const r1Body = revisionBody({ offset: [0.2, 0, 0], yaw: 0 });
      const r1 = await expectStatus(await owner.post(revisions(place, a.variant.id), r1Body), 201, 'r1');
      const b = await recollect(owner, other.session, place, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      const r2 = await expectStatus(await owner.post(revisions(place, a.variant.id), { ...r1Body, requestId: randomUUID() }), 201, 'r2 same parent and pose');
      const rb = await expectStatus(await owner.post(revisions(place, b.variant.id), revisionBody({ offset: [0, 0, 0], yaw: 0.6 })), 201, 'rb');
      const r3 = await expectStatus(await owner.post(revisions(place, r1.id), revisionBody({ offset: [0.2, 0.1, 0], yaw: 0 })), 201, 'r3 nested');
      const baseline = (await view(owner, place)).variants.find((item) => item.label === 'Saved reconstruction');
      const r4 = await expectStatus(await owner.post(revisions(place, baseline.id), revisionBody({ offset: [0, 0.1, 0], yaw: 0 })), 201, 'r4');
      [[r1, 2], [r2, 4], [rb, 5], [r3, 6], [r4, 7]].forEach(([item, ordinal]) => named(item, ordinal));
      assert.deepEqual(r2.edit, r1.edit);

      // Reads, an exact replay and a time assertion agree; other labels are untouched.
      const listed = new Map((await view(owner, place)).variants.map((item) => [item.id, item.label]));
      assert.deepEqual([...listed.values()], [
        'Saved reconstruction', a.variant.label, 'Alternative arrangement 2 · Owner revision', b.variant.label,
        'Alternative arrangement 4 · Owner revision', 'Alternative arrangement 5 · Owner revision', 'Alternative arrangement 6 · Owner revision', 'Alternative arrangement 7 · Owner revision',
      ]);
      for (const candidate of [a.variant, b.variant]) assert.match(candidate.label, /'s recollection$/);
      named(await expectStatus(await owner.post(revisions(place, a.variant.id), r1Body), 200, 'replay'), 2);
      const era = { requestId: randomUUID(), baseRevision: 0, kind: 'exact', label: '', start: '1990-05-01', end: '1990-05-01', statement: 'The owner places this in May 1990.', relation: null, relativeToVariantId: null, confirmed: true };
      named(await expectStatus(await owner.post(`${place.route}/variants/${r2.id}/era`, era), 200, 'era'), 4);

      // The owner name begins with the unchanged saved share and story name.
      const shared = await share(owner, place, [variantView(r2.id), variantView(r4.id)]);
      assert.equal(shared.status, 201, JSON.stringify(shared.error));
      assert.deepEqual(shared.preview.publicView.views.map((item) => item.label), ['Alternative arrangement 4', 'Alternative arrangement 7']);
      const packet = JSON.stringify(shared.preview.publicView);
      for (const leak of ['Owner revision', a.variant.id, r1.id, baseline.id]) assert.equal(packet.includes(leak), false, leak);
      const story = await owner.post(`${place.route}/stories`, {
        requestId: randomUUID(), voiceSourceId: place.draft.voice.sourceId, view: { kind: 'variant', version: null, variantId: r3.id, eraRevision: 0 },
        title: 'Synthetic tone', cues: [{ startMs: 0, endMs: 900, text: 'Synthetic test tone; no speech.' }], captionConfirmed: true,
      });
      assert.ok([200, 201].includes(story.status), JSON.stringify(await story.json()));
      const saved = await disk(dataDir, place);
      assert.equal(saved.stories.items.at(-1).context.label, 'Alternative arrangement 6');
      for (const item of saved.collaboration.variants.filter((entry) => entry.kind === 'revision')) assert.equal(item.label, 'Owner revision', 'stored labels are unchanged');
      const records = { shares: saved.shares, stories: saved.stories };

      // Blocking or deleting earlier entries keeps every later number.
      await expectStatus(await session.post(`${place.route}/contributions/${a.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw');
      const impact = await expectStatus(await other.session.request(`${place.route}/contributions/${b.id}/deletion`), 200, 'deletion preview');
      await expectStatus(await other.session.post(`${place.route}/contributions/${b.id}/delete`, { requestId: randomUUID(), impactSha256: impact.impactSha256, confirmDeletion: true }), 200, 'delete');
      const r5Body = revisionBody({ offset: [0, 0.2, 0], yaw: 0 });
      const r5 = await expectStatus(await owner.post(revisions(place, baseline.id), r5Body), 201, 'r5');
      named(r5, 8);
      const check = async () => {
        const labels = new Map((await view(owner, place)).variants.map((item) => [item.id, item.label]));
        for (const id of [a.variant.id, r1.id, r2.id, r3.id, b.variant.id, rb.id]) assert.equal(labels.get(id), 'Blocked reconstruction', id);
        assert.equal(labels.get(r4.id), 'Alternative arrangement 7 · Owner revision');
        assert.equal(labels.get(r5.id), 'Alternative arrangement 8 · Owner revision');
      };
      await check();
      const stored = await disk(dataDir, place);
      assert.equal(stored.collaboration.variants.find((item) => item.id === rb.id).label, 'Contribution removed');
      assert.deepEqual(stored.collaboration.variants.find((item) => item.id === r4.id).edit, r4.edit, 'the stored pose is unchanged');

      await app.close();
      ({ app, owner } = await workspace(dataDir));
      await check();
      named(await expectStatus(await owner.post(revisions(place, baseline.id), r5Body), 200, 'replay after restart'), 8);
      const final = await disk(dataDir, place);
      assert.equal(final.stories.items.at(-1).context.label, records.stories.items.at(-1).context.label);
      assert.deepEqual(final.shares.snapshots.at(-1).publicView, records.shares.snapshots.at(-1).publicView);
    } finally {
      await app.close();
    }
  });

  it('blocks saves, replays and previews through inherited withdrawal, deletion and source restriction', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const a = await recollect(owner, session, place, 'Closer to the window.', 'alternative', { offset: [0.1, 0, 0], yaw: 0 }, 1);
      const b = await recollect(owner, session, place, 'Turned toward the door.', 'alternative', { offset: [0, 0, 0], yaw: 0.5 }, 1);
      const e = await recollect(owner, session, place, 'Against the shelf.', 'alternative', { offset: [0, 0.1, 0], yaw: 0 }, 1);
      // Model processing is not needed for this deterministic operation.
      await restrict(owner, place, { place: true, model: false, share: true });
      const body = revisionBody({ offset: [0.2, 0, 0], yaw: 0 });
      const child = await expectStatus(await owner.post(revisions(place, a.variant.id), body), 201, 'model off');
      // Single foreground: the yaw endpoints are one orientation for the no-op check.
      const turned = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ offset: [0.1, 0, 0], yaw: -Math.PI })), 201, 'yaw -PI');
      assert.equal(turned.edit.yaw, -Math.PI, 'stored as sent');
      await expectStatus(await owner.post(revisions(place, turned.id), revisionBody({ offset: [0.1, 0, 0], yaw: Math.PI })), 409, 'yaw PI no-op');
      assert.equal((await disk(dataDir, place)).proposals, undefined, 'nothing was dispatched');

      // A failed manifest write leaves no child and no main change.
      const jobDir = path.dirname(manifestFile(dataDir, place));
      const before = await readFile(manifestFile(dataDir, place));
      const failing = revisionBody({ offset: [0.3, 0, 0], yaw: 0 });
      await chmod(jobDir, 0o500);
      let status;
      try {
        status = (await owner.post(revisions(place, a.variant.id), failing)).status;
      } finally {
        await chmod(jobDir, 0o700);
      }
      assert.ok(status >= 500, `storage failure answered ${status}`);
      assert.deepEqual(await readFile(manifestFile(dataDir, place)), before);
      await expectStatus(await owner.post(revisions(place, a.variant.id), failing), 201, 'retry after storage failure');

      // Only the supported saved kinds can be revised; an unknown kind is refused.
      const manifest = await disk(dataDir, place);
      const future = { ...manifest.collaboration.variants.find((item) => item.id === a.variant.id), id: randomUUID(), kind: 'future-kind' };
      await writeFile(manifestFile(dataDir, place), JSON.stringify({ ...manifest, collaboration: { ...manifest.collaboration, variants: [...manifest.collaboration.variants, future] } }));
      await expectStatus(await owner.request(context(place, future.id)), 409, 'unknown kind context');
      await expectStatus(await owner.post(revisions(place, future.id), revisionBody({ offset: [0.4, 0, 0], yaw: 0 })), 409, 'unknown kind save');

      // A changed original byte is refused even with current place use.
      const draftPhoto = path.join(dataDir, 'drafts', place.draft.id, place.draft.photos[0].name);
      const photoBytes = await readFile(draftPhoto);
      await writeFile(draftPhoto, Buffer.concat([photoBytes.subarray(0, -1), Buffer.from([photoBytes.at(-1) ^ 1])]));
      await expectStatus(await owner.request(context(place, a.variant.id)), 409, 'checksum');
      await writeFile(draftPhoto, photoBytes);

      // Deletion review covers children, and deletion blocks their replay.
      const preview = await expectStatus(await session.request(`${place.route}/contributions/${b.id}/deletion`), 200, 'deletion preview');
      const bChild = revisionBody({ offset: [0, 0, 0], yaw: 0.6 });
      await expectStatus(await owner.post(revisions(place, b.variant.id), bChild), 201, 'b child');
      const remove = (impactSha256) => session.post(`${place.route}/contributions/${b.id}/delete`, { requestId: randomUUID(), impactSha256, confirmDeletion: true });
      await expectStatus(await remove(preview.impactSha256), 409, 'impact changed');
      const reviewed = await expectStatus(await session.request(`${place.route}/contributions/${b.id}/deletion`), 200, 'deletion preview again');
      await expectStatus(await remove(reviewed.impactSha256), 200, 'delete');
      await expectStatus(await owner.post(revisions(place, b.variant.id), bChild), 409, 'deleted replay');
      const stored = await disk(dataDir, place);
      const removedChild = stored.collaboration.variants.find((item) => item.revision?.parentVariantId === b.variant.id);
      assert.equal(removedChild.label, 'Contribution removed');
      assert.equal(stored.collaboration.receipts.find((item) => item.requestId === bChild.requestId).digest, 'deleted');

      // Withdrawal blocks the child, its replay and its preview; the lineage stays opaque.
      await expectStatus(await session.post(`${place.route}/contributions/${a.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw');
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ offset: [0.5, 0, 0], yaw: 0 })), 409, 'withdrawn save');
      await expectStatus(await owner.post(revisions(place, a.variant.id), body), 409, 'withdrawn replay');
      await expectStatus(await owner.request(context(place, child.id)), 409, 'withdrawn context');
      const blocked = (await view(owner, place)).variants.find((item) => item.id === child.id);
      assert.equal(blocked.blocked, true);
      assert.equal(blocked.label, 'Blocked reconstruction');
      assert.deepEqual(blocked.revision, { parentVariantId: a.variant.id, targetId: null, timeMode: 'unknown' });

      // A stopped scene photo blocks a save, an exact replay and a preview. Uses
      // cannot be granted again through this route, so this runs last.
      const eBody = revisionBody({ offset: [0, 0.2, 0], yaw: 0 });
      await expectStatus(await owner.post(revisions(place, e.variant.id), eBody), 201, 'e child');
      await restrict(owner, place, { place: false, model: false, share: false });
      await expectStatus(await owner.post(revisions(place, e.variant.id), revisionBody({ offset: [0.4, 0, 0], yaw: 0 })), 409, 'source save');
      await expectStatus(await owner.post(revisions(place, e.variant.id), eBody), 409, 'source replay');
      await expectStatus(await owner.request(context(place, e.variant.id)), 409, 'source context');
    } finally {
      await app.close();
    }
  });

  it('keeps an independent lineage revisable while main is blocked, without claiming its assets render', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const a = await recollect(owner, session, place, 'Nearer the wall.', 'alternative', { offset: [0, 0, -0.1], yaw: 0 }, 1);
      const d = await recollect(owner, session, place, 'Further out.', 'adopt', { offset: [0, 0, 0.2], yaw: 0 }, 1);
      await expectStatus(await session.post(`${place.route}/contributions/${d.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw main dependency');
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ offset: [0, 0.1, -0.1], yaw: 0 })), 201, 'independent lineage');
      // The existing asset route follows the current main version and stays refused.
      assert.equal((await owner.request(`${place.route}/assets/texture.jpg`)).status, 409);
    } finally {
      await app.close();
    }
  });

  it('holds at most 200 owner revisions per scene while exact replay keeps working', async () => {
    const { app, owner } = await workspace();
    try {
      const place = await scene(owner);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const a = await recollect(owner, session, place, 'Slightly left.', 'alternative', { offset: [-0.1, 0, 0], yaw: 0 }, 1);
      const first = revisionBody({ offset: [0, 0, 0.001], yaw: 0 });
      await expectStatus(await owner.post(revisions(place, a.variant.id), first), 201, 'first');
      for (let index = 2; index <= 200; index++) {
        const response = await owner.post(revisions(place, a.variant.id), revisionBody({ offset: [0, 0, index / 1000], yaw: 0 }));
        assert.equal(response.status, 201, `revision ${index}`);
      }
      const full = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ offset: [0, 0, 0.5], yaw: 0 })), 409, 'cap');
      assert.match(full.error, /200 owner revisions/);
      await expectStatus(await owner.post(revisions(place, a.variant.id), first), 200, 'replay at cap');
    } finally {
      await app.close();
    }
  });
});

describe('owner revisions of two-photo compositions', () => {
  const pose = (x, scale = 1) => ({ position: [x, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]), scale });

  async function composition() {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-revisions-composition-'));
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
    const app = await startOwnerServer({ dataDir, reconstructionRunner: compositionRunner });
    const owner = client(app.base, app.cookie), form = new FormData();
    for (const fill of [7, 8]) form.append('photos', new Blob([png(40, 30, fill)]), 'photo.png');
    form.append('metadata', JSON.stringify({ photos: [GRANT, GRANT] }));
    const draft = await expectStatus(await owner.request('/api/drafts', { method: 'POST', body: form }), 201, 'draft');
    const base = `/api/drafts/${draft.id}/reconstructions`, parents = [];
    for (const photo of draft.photos) {
      let parent = await expectStatus(await owner.post(base, { requestId: randomUUID(), sourceId: photo.sourceId, box: [1, 1, 18, 28] }), 202, 'build');
      for (let i = 0; i < 200 && ['queued', 'processing'].includes(parent.status); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        parent = await owner.json(`${base}/${parent.id}`);
      }
      parents.push(parent);
    }
    const job = await expectStatus(await owner.post(base, {
      kind: 'two-photo-composition', requestId: randomUUID(), context: { keep: true, bounds: [0, 0, 40, 30] }, confirmed: true, scaleBasis: 'owner-assumed-relative',
      objects: parents.map((parent, index) => ({ label: `Component ${index + 1}`, pose: pose(index ? 3 : -3, index ? 0.7 : 1.1),
        component: { jobId: parent.id, objectId: 'selected-foreground', surfaceSha256: parent.derivedAssets.find((item) => item.name === 'surface.json').sha256 } })),
    }), 201, 'compose');
    const place = { draft, job, route: `${base}/${job.id}` };
    await expectStatus(await owner.post(`${place.route}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'], surfaceIdentityConfirmed: true, layoutConfirmed: true, scaleBasis: 'owner-assumed-relative' }), 200, 'confirm');
    return { app, owner, dataDir, place };
  }

  it('keeps exact parent scales and untargeted poses, refuses q/-q no-ops and records the owner change without erasing object associations', async () => {
    const { app, owner, dataDir, place } = await composition();
    try {
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const keptPose = { position: [-2.5, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]) };
      const a = await recollect(owner, session, place, 'The first piece sat closer.', 'alternative', { targetId: 'object-1', pose: keptPose }, 1);
      await expectStatus(await owner.post(`${place.route}/edit`, { requestId: randomUUID(), baseVersion: 1, targetId: 'object-2', pose: pose(3.2, 0.9) }), 200, 'main edit');
      const before = await disk(dataDir, place);

      const moved = { position: [-2.2, 0.2, -3], quaternion: quaternionFromEuler([0, 0.4, 0]) };
      const child = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', pose: moved })), 201, 'revision');
      const [parentFirst, parentSecond] = a.variant.edit.objects;
      assert.equal(child.edit.frame, 'owner-composition');
      assert.equal(child.edit.objects[0].scale, parentFirst.scale);
      assert.deepEqual(child.edit.objects[1], parentSecond, 'the parent pose, not the main edit');
      assert.equal(parentSecond.scale, 0.7);
      assert.deepEqual(child.edit.relationship, a.variant.edit.relationship);
      const after = await disk(dataDir, place);
      assert.deepEqual(after.edit, before.edit);
      assert.deepEqual(after.collaboration.variants.slice(0, -1), before.collaboration.variants);

      const negated = { position: parentFirst.position, quaternion: parentFirst.quaternion.map((value) => -value) };
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', pose: negated })), 409, 'q/-q no-op');
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', pose: { ...moved, scale: 2 } })), 400, 'no scale field');

      // The recollection keeps the object it was recorded about; the owner's
      // change is identified by the arrangement origin and the owner lineage.
      const other = await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-2', pose: { position: [3.1, 0.125, -3], quaternion: parentSecond.quaternion } })), 201, 'other object');
      const shared = await share(owner, place, [variantView(child.id), variantView(other.id), variantView(a.variant.id)]);
      assert.equal(shared.status, 201, JSON.stringify(shared.error));
      const [revisedView, otherView, parentView] = shared.preview.publicView.views;
      assert.equal(revisedView.evidence.arrangement, 'manual');
      assert.deepEqual(revisedView.evidence.support.map((item) => item.objectId), ['object-1']);
      assert.deepEqual(otherView.evidence.support.map((item) => item.objectId), ['object-1']);
      assert.deepEqual(parentView.evidence.support.map((item) => item.objectId), ['object-1']);
      assert.equal(parentView.evidence.arrangement, 'alternative');
      const nested = await expectStatus(await owner.post(revisions(place, other.id), revisionBody({ targetId: 'object-1', pose: moved })), 201, 'nested');
      const nestedShare = await share(owner, place, [variantView(nested.id)]);
      assert.deepEqual(nestedShare.preview.publicView.views[0].evidence.support.map((item) => item.objectId), ['object-1']);
      assert.equal(nestedShare.preview.publicView.views[0].evidence.arrangement, 'manual');
      assert.deepEqual(nested.revision, { parentVariantId: other.id, targetId: 'object-1', timeMode: 'unknown' });
      const contribution = (await disk(dataDir, place)).collaboration.contributions.find((item) => item.id === a.id);
      assert.deepEqual(contribution, before.collaboration.contributions.find((item) => item.id === a.id), 'words, review and target unchanged');
      assert.equal((await view(owner, place)).contributions.find((item) => item.id === a.id).review.targetId, 'object-1');
      assert.equal(JSON.stringify(shared.preview.publicView).includes(a.variant.id), false);

      // Either photo's place use gates the whole closure; model use is not needed.
      const body = revisionBody({ targetId: 'object-1', pose: { position: [-2.3, 0.125, -3], quaternion: moved.quaternion } });
      await restrict(owner, place, { place: true, model: false, share: true }, 1);
      await expectStatus(await owner.post(revisions(place, a.variant.id), body), 201, 'second model off');
      await restrict(owner, place, { place: false, model: false, share: false }, 1);
      await expectStatus(await owner.post(revisions(place, a.variant.id), revisionBody({ targetId: 'object-1', pose: moved }, { requestId: randomUUID() })), 409, 'second source save');
      await expectStatus(await owner.post(revisions(place, a.variant.id), body), 409, 'second source replay');
      await expectStatus(await owner.request(context(place, a.variant.id)), 409, 'second source context');
    } finally {
      await app.close();
    }
  });
});
