import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { quaternionFromEuler } from '../public/composition-scene.js';
import { client, enrolledContributor, jpeg, png, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic scenes, contributions and photos only. A review may carry an
// explicit message for the provider; it is shown to the owner and that
// provider only while the material it is about may still be used.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const GRANT = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];
const GRID = { width: 16, height: 12 };
const REVIEW_JPEG = jpeg(64, 48, 9);
const PRIVATE_REASON = 'Private owner reasoning that must stay with the owner.';
const PRIVATE_LABEL_PROBE = 'Display counter';

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
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-contributor-feedback-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: runner, contributionPhotoDecoder: async () => REVIEW_JPEG });
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
const policyRoute = (place) => `/api/drafts/${place.draft.id}/sources/${place.draft.photos[0].sourceId}/policy`;
const submit = (session, place, text = 'The counter stood further back.', permissions = { place: true, model: false, share: true }) =>
  session.post(`${place.route}/contributions`, { requestId: randomUUID(), text, permissions, periodClaim: '' });
const review = (place, id, change = {}) => ({
  requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'hold', reason: PRIVATE_REASON, conflict: 'unknown', transform: null, ...change,
});
const own = async (session, place, id) => (await session.json(`${place.route}/collaboration`)).contributions.find((item) => item.id === id);
const ownerView = async (owner, place, id) => (await owner.json(`${place.route}/collaboration`)).contributions.find((item) => item.id === id);

async function restrict(owner, place, permissions) {
  const { revision } = await owner.json(policyRoute(place));
  await expectStatus(await owner.post(policyRoute(place), { requestId: randomUUID(), baseRevision: revision, permissions, stopUse: false }), 200, 'restrict');
}

describe('review feedback for the providing contributor', () => {
  it('shows an explicit note and the reviewed part to the owner and that provider only, keeping legacy reviews and private notes unchanged', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner);
      const provider = await enrolledContributor(owner, app.base, place.draft.id);
      const other = await enrolledContributor(owner, app.base, place.draft.id, 'Second contributor');
      const first = await expectStatus(await submit(provider.session, place), 200, 'submit');
      const second = await expectStatus(await submit(provider.session, place, 'The window faced the street.'), 200, 'second submit');
      const legacy = await expectStatus(await submit(provider.session, place, 'There was a bench.'), 200, 'legacy submit');
      await expectStatus(await submit(other.session, place, 'Another memory.'), 200, 'other submit');

      // Invalid feedback is refused before anything is written.
      const before = await readFile(manifestFile(dataDir, place));
      const refused = [
        { feedback: { showTarget: false, note: '' } },
        { feedback: { showTarget: false, note: '   ' } },
        { feedback: { showTarget: false, note: 'x'.repeat(501) } },
        { feedback: { showTarget: true, note: '' } },
        { feedback: { showTarget: 'yes', note: 'Thanks.' } },
        { feedback: { showTarget: false, note: 'Thanks.', partLabel: 'Forged label' } },
        { feedback: { showTarget: false } },
        { feedback: null },
        { feedback: { showTarget: false, note: 'bad \u0007 bell' } },
      ];
      for (const change of refused) await expectStatus(await owner.post(`${place.route}/contributions/${first.id}/review`, review(place, first.id, change)), 400, JSON.stringify(change));
      assert.deepEqual(await readFile(manifestFile(dataDir, place)), before, 'nothing was written');

      // A legacy review keeps its exact shape: no feedback key anywhere.
      const legacyBody = review(place, legacy.id, { decision: 'reject' });
      const legacyReviewed = await expectStatus(await owner.post(`${place.route}/contributions/${legacy.id}/review`, legacyBody), 200, 'legacy review');
      assert.equal(Object.hasOwn(legacyReviewed.contribution.review, 'feedback'), false);
      assert.equal(Object.hasOwn((await own(provider.session, place, legacy.id)).review, 'feedback'), false);
      assert.equal(Object.hasOwn((await disk(dataDir, place)).collaboration.contributions.find((item) => item.id === legacy.id).review, 'feedback'), false);
      assert.equal((await expectStatus(await owner.post(`${place.route}/contributions/${legacy.id}/review`, legacyBody), 200, 'legacy replay')).contribution.review.decision, 'reject');

      // A note on a review in progress, then a used arrangement naming its part.
      const note = '  Thank you; this helped place the counter.\nSee the kept arrangement.  ';
      await expectStatus(await owner.post(`${place.route}/contributions/${first.id}/review`, review(place, first.id, { decision: 'reviewing', feedback: { showTarget: false, note: 'Looking at this now.' } })), 200, 'reviewing note');
      assert.deepEqual((await own(provider.session, place, first.id)).review.feedback, { partLabel: null, note: 'Looking at this now.' });
      const adoptBody = review(place, first.id, {
        baseRevision: 2, decision: 'alternative', transform: { offset: [0, 0, -0.5], yaw: 0 }, feedback: { showTarget: true, note: 'x'.repeat(500) },
      });
      await expectStatus(await owner.post(`${place.route}/contributions/${first.id}/review`, { ...adoptBody, feedback: { showTarget: true, note: 'x'.repeat(501) } }), 400, 'long note');
      const kept = await expectStatus(await owner.post(`${place.route}/contributions/${first.id}/review`, adoptBody), 200, 'alternative with part');
      assert.deepEqual(kept.contribution.review.feedback, { partLabel: 'Selected foreground object', note: 'x'.repeat(500) });
      const holdBody = review(place, second.id, { feedback: { showTarget: false, note } });
      await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, { ...holdBody, feedback: { showTarget: true, note } }), 400, 'hold cannot name a part');
      const held = await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, holdBody), 200, 'hold with note');
      assert.deepEqual(held.contribution.review.feedback, { partLabel: null, note }, 'the received note is kept exactly');

      // The provider sees the message, never the private reason, conflict or target.
      const providerView = await own(provider.session, place, first.id);
      assert.deepEqual(providerView.review.feedback, { partLabel: 'Selected foreground object', note: 'x'.repeat(500) });
      for (const key of ['reason', 'conflict', 'targetId', 'captionBinding']) assert.equal(Object.hasOwn(providerView.review, key), false, key);
      assert.equal(JSON.stringify(await provider.session.json(`${place.route}/collaboration`)).includes(PRIVATE_REASON), false);
      assert.deepEqual((await ownerView(owner, place, second.id)).review.feedback, { partLabel: null, note });
      assert.equal((await ownerView(owner, place, second.id)).review.reason, PRIVATE_REASON);
      // Another contributor never sees it.
      const otherList = JSON.stringify(await other.session.json(`${place.route}/collaboration`));
      for (const secret of [note, 'Selected foreground object', 'x'.repeat(500)]) assert.equal(otherList.includes(secret), false);
      const stored = (await disk(dataDir, place)).collaboration.contributions.find((item) => item.id === first.id);
      assert.deepEqual(stored.review.feedback, { partLabel: 'Selected foreground object', note: 'x'.repeat(500) });
      assert.deepEqual(stored.reviews.at(-1).feedback, stored.review.feedback);

      // Exact replay answers again; the same ID with another message conflicts.
      assert.deepEqual((await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, holdBody), 200, 'replay')).contribution.review.feedback, { partLabel: null, note });
      await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, { ...holdBody, feedback: { showTarget: false, note: 'Changed.' } }), 409, 'changed note');
      await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, { ...holdBody, feedback: undefined }), 409, 'feedback removed');

      // A visitor packet never carries it.
      const view = { id: randomUUID(), kind: 'variant', version: null, variantId: kept.contribution.review.variantId };
      const preview = await expectStatus(await owner.post(`${place.route}/shares/previews`, {
        requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [first.id], synthetic: true,
      }), 201, 'preview');
      const packet = JSON.stringify(preview.publicView);
      for (const secret of ['x'.repeat(500), 'Selected foreground object', PRIVATE_REASON]) assert.equal(packet.includes(secret), false);

      // A storage failure saves nothing and the same request can be retried.
      const fresh = await expectStatus(await submit(provider.session, place, 'One more memory.'), 200, 'fresh');
      const jobDir = path.dirname(manifestFile(dataDir, place));
      const unchanged = await readFile(manifestFile(dataDir, place));
      const faultBody = review(place, fresh.id, { feedback: { showTarget: false, note: 'Saved after a retry.' } });
      await chmod(jobDir, 0o500);
      let status;
      try {
        status = (await owner.post(`${place.route}/contributions/${fresh.id}/review`, faultBody)).status;
      } finally {
        await chmod(jobDir, 0o700);
      }
      assert.ok(status >= 500, `storage failure answered ${status}`);
      assert.deepEqual(await readFile(manifestFile(dataDir, place)), unchanged);
      await expectStatus(await owner.post(`${place.route}/contributions/${fresh.id}/review`, faultBody), 200, 'retry');

      // After a restart the saved message and replay are unchanged.
      await app.close();
      ({ app, owner } = await workspace(dataDir));
      assert.deepEqual((await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, holdBody), 200, 'replay after restart')).contribution.review.feedback, { partLabel: null, note });

      // The provider's own withdrawal alone hides a note that has no linked arrangement.
      const session = client(app.base);
      assert.equal((await session.login(provider.keys.accessKey)).status, 200);
      const withdrawn = await expectStatus(await session.post(`${place.route}/contributions/${second.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw');
      assert.equal(withdrawn.review.feedback, null);
      assert.equal((await own(session, place, second.id)).review.feedback, null);
      assert.equal((await ownerView(owner, place, second.id)).review.feedback, null);
      assert.equal((await expectStatus(await owner.post(`${place.route}/contributions/${second.id}/review`, holdBody), 200, 'replay after withdrawal')).contribution.review.feedback, null);
      assert.deepEqual((await disk(dataDir, place)).collaboration.contributions.find((item) => item.id === second.id).review.feedback, { partLabel: null, note }, 'withdrawal does not rewrite the record');
    } finally {
      await app.close();
    }
  });

  it('captures the reviewed object name once and hides feedback whenever the reviewed material or arrangement cannot be used', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner, OBJECTS);
      const { session } = await enrolledContributor(owner, app.base, place.draft.id);
      const other = await enrolledContributor(owner, app.base, place.draft.id, 'Second contributor');
      const a = await expectStatus(await submit(session, place), 200, 'a');
      const c = await expectStatus(await submit(other.session, place, 'The stack was taller.'), 200, 'c');
      const d = await expectStatus(await submit(session, place, 'The counter was lower.'), 200, 'd');

      // A forged label or target in the message is refused; the name comes from the reviewed object.
      const body = review(place, a.id, { decision: 'alternative', transform: { targetId: 'object-2', offset: [0, 0.1, 0], yaw: 0 }, feedback: { showTarget: true, note: '' } });
      await expectStatus(await owner.post(`${place.route}/contributions/${a.id}/review`, { ...body, feedback: { showTarget: true, note: '', targetId: 'object-1' } }), 400, 'forged target');
      const kept = await expectStatus(await owner.post(`${place.route}/contributions/${a.id}/review`, body), 200, 'alternative');
      assert.deepEqual(kept.contribution.review.feedback, { partLabel: 'Flour stack', note: '' });
      const providerJson = JSON.stringify(await own(session, place, a.id));
      assert.equal(providerJson.includes(PRIVATE_LABEL_PROBE), false, 'only the reviewed object is named');
      assert.equal(providerJson.includes('object-2'), false, 'no target ID is disclosed');

      // A later rename does not change the saved name.
      const renamed = await disk(dataDir, place);
      renamed.objects = renamed.objects.map((item) => (item.id === 'object-2' ? { ...item, label: 'Renamed stack' } : item));
      await writeFile(manifestFile(dataDir, place), JSON.stringify(renamed));
      assert.equal((await own(session, place, a.id)).review.feedback.partLabel, 'Flour stack');

      // An unreadable saved object name is refused for a new disclosure.
      const broken = await disk(dataDir, place);
      const savedObjects = broken.objects;
      broken.objects = broken.objects.map((item) => (item.id === 'object-1' ? { ...item, label: ' padded ' } : item));
      await writeFile(manifestFile(dataDir, place), JSON.stringify(broken));
      const blockedName = review(place, d.id, { decision: 'alternative', transform: { targetId: 'object-1', offset: [0, 0.1, 0], yaw: 0 }, feedback: { showTarget: true, note: 'Thanks.' } });
      await expectStatus(await owner.post(`${place.route}/contributions/${d.id}/review`, blockedName), 409, 'unreadable name');
      await writeFile(manifestFile(dataDir, place), JSON.stringify({ ...(await disk(dataDir, place)), objects: savedObjects }));

      // The linked arrangement's own closure decides, never main's: main
      // adopts c and c is withdrawn, which blocks main but not a's alternative.
      await expectStatus(await owner.post(`${place.route}/contributions/${c.id}/review`, review(place, c.id, {
        decision: 'adopt', transform: { targetId: 'object-1', offset: [0, 0.1, 0], yaw: 0 }, feedback: { showTarget: true, note: 'Used for the counter.' },
      })), 200, 'adopt c');
      const dReview = review(place, d.id, { baseVersion: 2, decision: 'alternative', transform: { targetId: 'object-1', offset: [0, 0.2, 0], yaw: 0 }, feedback: { showTarget: false, note: 'Kept separately.' } });
      await expectStatus(await owner.post(`${place.route}/contributions/${d.id}/review`, dReview), 200, 'd inherits c');
      await expectStatus(await other.session.post(`${place.route}/contributions/${c.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw c');
      assert.deepEqual((await own(session, place, a.id)).review.feedback, { partLabel: 'Flour stack', note: '' }, 'independent of main');
      assert.equal((await own(session, place, d.id)).review.feedback, null, 'its own arrangement inherits the withdrawn contribution');
      assert.equal((await ownerView(owner, place, d.id)).review.feedback, null);
      assert.equal((await own(other.session, place, c.id)).review.feedback, null, 'withdrawn');

      // Stopping the scene photo's place use hides feedback on every read and
      // replay, and refuses new feedback while plain decisions still work.
      await restrict(owner, place, { place: false, model: false, share: false });
      assert.equal((await own(session, place, a.id)).review.feedback, null);
      assert.equal((await expectStatus(await owner.post(`${place.route}/contributions/${a.id}/review`, body), 200, 'replay while stopped')).contribution.review.feedback, null);
      const e = await expectStatus(await submit(session, place, 'A late memory.'), 200, 'e');
      assert.equal(Object.hasOwn(e, 'review'), true);
      await expectStatus(await owner.post(`${place.route}/contributions/${e.id}/review`, review(place, e.id, { feedback: { showTarget: false, note: 'Holding this.' } })), 409, 'new feedback while stopped');
      await expectStatus(await owner.post(`${place.route}/contributions/${e.id}/review`, review(place, e.id)), 200, 'plain hold still allowed');
    } finally {
      await app.close();
    }
  });

  it('hides feedback when the contributed photo is unavailable and scrubs it on deletion', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner);
      const provider = await enrolledContributor(owner, app.base, place.draft.id);
      const facts = { origin: { kind: 'own', reference: '' }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' }, permissions: { place: true, model: false, share: true } };
      const form = new FormData();
      form.append('payload', JSON.stringify({ requestId: randomUUID(), text: 'This photo shows the counter.', permissions: { place: true, model: false, share: true }, periodClaim: '', photo: facts }));
      form.append('photo', new Blob([SYNTHETIC_PHOTO], { type: 'image/png' }), 'photo.png');
      const withPhoto = await expectStatus(await provider.session.request(`${place.route}/contributions/photo`, { method: 'POST', body: form }), 200, 'photo submit');
      const plain = await expectStatus(await submit(provider.session, place, 'A second memory.'), 200, 'plain');
      const photoNote = 'Your photo helped.';
      await expectStatus(await owner.post(`${place.route}/contributions/${withPhoto.id}/review`, review(place, withPhoto.id, { feedback: { showTarget: false, note: photoNote } })), 200, 'photo hold');
      await expectStatus(await owner.post(`${place.route}/contributions/${plain.id}/review`, review(place, plain.id, { feedback: { showTarget: false, note: 'Unrelated note.' } })), 200, 'plain hold');
      assert.equal((await own(provider.session, place, withPhoto.id)).review.feedback.note, photoNote);

      // A changed stored review photo makes the material unavailable.
      const bundle = path.join(path.dirname(manifestFile(dataDir, place)), 'contributions', withPhoto.id);
      const [name] = (await readdir(bundle)).filter((item) => item.endsWith('.jpg'));
      const bytes = await readFile(path.join(bundle, name));
      await writeFile(path.join(bundle, name), Buffer.concat([bytes, Buffer.from([0])]));
      assert.equal((await own(provider.session, place, withPhoto.id)).review.feedback, null);
      await writeFile(path.join(bundle, name), bytes);

      // Deletion keeps only the tombstone; the note and history are gone, unrelated feedback stays.
      const impact = await expectStatus(await provider.session.request(`${place.route}/contributions/${withPhoto.id}/deletion`), 200, 'deletion preview');
      await expectStatus(await provider.session.post(`${place.route}/contributions/${withPhoto.id}/delete`, { requestId: randomUUID(), impactSha256: impact.impactSha256, confirmDeletion: true }), 200, 'delete');
      const tombstone = await own(provider.session, place, withPhoto.id);
      assert.equal(tombstone.status, 'deleted');
      assert.equal(Object.hasOwn(tombstone, 'review'), false);
      const manifest = await disk(dataDir, place);
      const record = manifest.collaboration.contributions.find((item) => item.id === withPhoto.id);
      assert.equal(Object.hasOwn(record.review, 'feedback'), false);
      assert.deepEqual(record.reviews, []);
      assert.equal(JSON.stringify(manifest).includes(photoNote), false);
      assert.ok(manifest.collaboration.receipts.filter((item) => item.target === withPhoto.id && item.action === 'review').every((item) => item.digest === 'deleted'));
      assert.equal((await own(provider.session, place, plain.id)).review.feedback.note, 'Unrelated note.');
    } finally {
      await app.close();
    }
  });

  it('keeps ordinary submissions working when source settings cannot be read, hiding only feedback and refusing new feedback', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const place = await scene(owner);
      const provider = await enrolledContributor(owner, app.base, place.draft.id);
      const contribute = (body) => provider.session.post(`${place.route}/contributions`, body);
      const firstBody = { requestId: randomUUID(), text: 'The counter stood further back.', permissions: { place: true, model: false, share: true }, periodClaim: '' };
      const first = await expectStatus(await contribute(firstBody), 200, 'first');
      await expectStatus(await owner.post(`${place.route}/contributions/${first.id}/review`, review(place, first.id, { feedback: { showTarget: false, note: 'Holding this for now.' } })), 200, 'hold with note');

      const policyFile = path.join(dataDir, 'drafts', place.draft.id, 'policy.json');
      const saved = await readFile(policyFile).catch(() => null);
      await writeFile(policyFile, '{bad json');
      try {
        // A submission without feedback needs no source settings, also on exact replay.
        const body = { requestId: randomUUID(), text: 'Written while the settings cannot be read.', permissions: { place: true, model: false, share: true }, periodClaim: '' };
        const added = await expectStatus(await contribute(body), 200, 'submit under fault');
        assert.equal(added.review, null);
        assert.equal((await expectStatus(await contribute(body), 200, 'exact replay under fault')).id, added.id);
        // Saved feedback is hidden, never shown on an unknown state.
        const replayed = await expectStatus(await contribute(firstBody), 200, 'replay of a reviewed submission');
        assert.equal(replayed.review.feedback, null);
        // New feedback is refused without a write; a plain decision is unchanged.
        const unchanged = await readFile(manifestFile(dataDir, place));
        await expectStatus(await owner.post(`${place.route}/contributions/${added.id}/review`, review(place, added.id, { feedback: { showTarget: false, note: 'Thanks.' } })), 503, 'new feedback under fault');
        assert.deepEqual(await readFile(manifestFile(dataDir, place)), unchanged, 'nothing was written');
        await expectStatus(await owner.post(`${place.route}/contributions/${added.id}/review`, review(place, added.id)), 200, 'plain hold under fault');
        // Withdrawal still works and shows no feedback.
        const withdrawn = await expectStatus(await provider.session.post(`${place.route}/contributions/${first.id}/withdraw`, { requestId: randomUUID() }), 200, 'withdraw under fault');
        assert.equal(withdrawn.review.feedback, null);
      } finally {
        if (saved) await writeFile(policyFile, saved);
        else await rm(policyFile, { force: true });
      }
      assert.equal(Object.hasOwn((await disk(dataDir, place)).collaboration.contributions.find((item) => item.id === first.id).review, 'feedback'), true, 'the stored record is kept');
    } finally {
      await app.close();
    }
  });

  it('hides a malformed stored message and captures a composition component name', async () => {
    const pose = (x, scale = 1) => ({ position: [x, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]), scale });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-contributor-feedback-composition-'));
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
      const a = await expectStatus(await submit(session, place), 200, 'submit');
      const kept = await expectStatus(await owner.post(`${place.route}/contributions/${a.id}/review`, review(place, a.id, {
        decision: 'alternative', transform: { targetId: 'object-2', pose: { position: [3.1, 0.125, -3], quaternion: quaternionFromEuler([0.1, 0.2, -0.05]) } }, feedback: { showTarget: true, note: 'Kept as its own arrangement.' },
      })), 200, 'composition alternative');
      assert.deepEqual(kept.contribution.review.feedback, { partLabel: 'Component 2', note: 'Kept as its own arrangement.' });
      assert.deepEqual((await own(session, place, a.id)).review.feedback, { partLabel: 'Component 2', note: 'Kept as its own arrangement.' });

      // Malformed stored shapes never reach the browser.
      for (const malformed of [
        { partLabel: 'Component 2', note: 'Ok', extra: 1 },
        { partLabel: 'x'.repeat(81), note: '' },
        { partLabel: null, note: '   ' },
        { partLabel: 'Component 2', note: 'y'.repeat(501) },
        'not an object',
      ]) {
        const manifest = await disk(dataDir, place);
        manifest.collaboration.contributions = manifest.collaboration.contributions.map((item) => (item.id === a.id ? { ...item, review: { ...item.review, feedback: malformed } } : item));
        await writeFile(manifestFile(dataDir, place), JSON.stringify(manifest));
        assert.equal((await own(session, place, a.id)).review.feedback, null, JSON.stringify(malformed));
      }
    } finally {
      await app.close();
    }
  });
});
