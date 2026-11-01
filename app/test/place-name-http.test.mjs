import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { freshCredentials, generateSecret } from '../access.mjs';
import { parsePlaceName } from '../drafts.mjs';
import { canonicalPlaceName, placeNameProblem } from '../public/intake.js';
import { client, enrolledContributor, png, readyScene, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

// Synthetic names and files only.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const UNNAMED = { name: null, revision: 0, updatedAt: null, unavailable: false };
const UNAVAILABLE = { name: null, revision: null, updatedAt: null, unavailable: true };
const NAME_ERROR = 'The place name could not be used. Use one line of up to 120 characters.';
const PHOTO = png(40, 30, 7);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function workspace(options = {}, dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-place-name-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, ...options });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

const GRANT = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
function draftForm({ placeNames = [], photo = true, text = null } = {}) {
  const form = new FormData();
  for (const name of placeNames) form.append('placeName', name);
  if (photo) form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo');
  if (text) form.append('text', text);
  form.append('metadata', JSON.stringify({ photos: photo ? [GRANT] : [], ...(text && { text: GRANT }) }));
  return form;
}
const saveDraft = (owner, options) => owner.request('/api/drafts', { method: 'POST', body: draftForm(options) });
const rename = (owner, draftId, baseRevision, name, requestId = randomUUID()) => owner.post(`/api/drafts/${draftId}/place-name`, { requestId, baseRevision, name });
const placeFile = (dataDir, draftId) => path.join(dataDir, 'drafts', draftId, 'place.json');

// Every file under the folders, except the place names themselves.
async function hashes(...dirs) {
  const result = {};
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name !== 'place.json') result[path.join(entry.parentPath, entry.name)] = sha256(await readFile(path.join(entry.parentPath, entry.name)));
    }
  }
  return result;
}

async function waitReady(owner, scene) {
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await owner.json(scene)).status, 'ready');
}

async function secondScene(owner, draft) {
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  await waitReady(owner, `/api/drafts/${draft.id}/reconstructions/${job.id}`);
  return job;
}

describe('place names on direct saves', () => {
  it('keeps an optional trimmed name beside the draft through list, reopen and restart, never in draft.json', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const created = await saveDraft(owner, { placeNames: ['  Corner shop  '] });
      assert.equal(created.status, 201);
      const draft = await created.json();
      assert.deepEqual(draft.place, { name: 'Corner shop', revision: 1, updatedAt: draft.createdAt, unavailable: false });
      assert.ok(!(await readFile(path.join(dataDir, 'drafts', draft.id, 'draft.json'), 'utf8')).includes('Corner shop'));
      assert.equal((await stat(placeFile(dataDir, draft.id))).mode & 0o777, 0o600);

      const plain = await (await saveDraft(owner, { placeNames: ['   '] })).json();
      assert.deepEqual(plain.place, UNNAMED, 'whitespace alone is explicitly unnamed');
      await assert.rejects(stat(placeFile(dataDir, plain.id)), { code: 'ENOENT' });
      // Ordinary right-to-left letters are kept exactly; 120 UTF-16 units fit.
      const rtl = '\u05DE\u05E7\u05D5\u05DD \u05D9\u05E9\u05DF';
      assert.equal((await (await saveDraft(owner, { placeNames: [rtl] })).json()).place.name, rtl);
      const longest = 'x'.repeat(120);
      assert.equal((await (await saveDraft(owner, { placeNames: [longest] })).json()).place.name, longest);

      const count = (await owner.json('/api/drafts')).length;
      const refused = [
        [{ placeNames: ['y'.repeat(121)] }, 400, NAME_ERROR],
        [{ placeNames: [' '.repeat(119) + 'zz'] }, 400, NAME_ERROR],
        [{ placeNames: ['Line one\nLine two'] }, 400, NAME_ERROR],
        [{ placeNames: ['Shop\u202Eevil'] }, 400, NAME_ERROR],
        [{ placeNames: ['Shop\u0085'] }, 400, NAME_ERROR],
        [{ placeNames: ['Shop\u061Cname'] }, 400, NAME_ERROR],
        [{ placeNames: ['Shop\u200Ename'] }, 400, NAME_ERROR],
        [{ placeNames: ['Shop\u200Fname'] }, 400, NAME_ERROR],
        [{ placeNames: ['One', 'Two'] }, 400, NAME_ERROR],
        [{ placeNames: ['A name alone'], photo: false }, 400, 'Add a photo, a written memory or a voice recording before saving.'],
      ];
      for (const [options, status, error] of refused) {
        const response = await saveDraft(owner, options);
        assert.equal(response.status, status, JSON.stringify(options).slice(0, 60));
        assert.deepEqual(await response.json(), { error });
      }
      assert.equal((await owner.json('/api/drafts')).length, count, 'no refused name saved anything');

      await app.close();
      ({ app, owner } = await workspace({}, dataDir));
      const listed = (await owner.json('/api/drafts')).find((item) => item.id === draft.id);
      assert.deepEqual(listed.place, draft.place);
      assert.deepEqual((await owner.json(`/api/drafts/${draft.id}`)).place, draft.place);
    } finally {
      await app.close();
    }
  });
});

describe('place name rules', () => {
  // The server and the owner page accept and canonicalize exactly the same names.
  it('match the owner page for every BMP code unit, length boundary and trim case', () => {
    const backend = (value) => {
      try {
        return { ok: true, name: parsePlaceName(value) };
      } catch {
        return { ok: false };
      }
    };
    const samples = ['', '   ', ' Hall ', '\u00a0Hall\u3000', 'x'.repeat(120), 'x'.repeat(121), ' '.repeat(119) + 'zz', '\u05DE\u05E7\u05D5\u05DD', '\u0645\u0643\u0627\u0646'];
    for (let code = 0; code <= 0xffff; code++) samples.push(`a${String.fromCharCode(code)}b`);
    for (const value of samples) {
      const front = placeNameProblem(value) === null ? { ok: true, name: canonicalPlaceName(value) } : { ok: false };
      assert.deepEqual(backend(value), front, `U+${[...value].map((c) => c.codePointAt(0).toString(16)).join(' ')}`.slice(0, 80));
    }
  });
});

describe('place names on resumable saves', () => {
  const text = 'A synthetic memory.';
  const metadata = { photos: [GRANT], text: GRANT };
  const part = () => ({ partId: randomUUID(), kind: 'photo', size: PHOTO.length, sha256: sha256(PHOTO), hints: { name: 'photo.png', type: 'image/png', lastModified: null } });

  it('carries the name through create, a name-only plan change, restart and commit', async () => {
    let { app, owner, dataDir } = await workspace();
    try {
      const planned = part();
      const body = { requestId: randomUUID(), text, parts: [planned], metadata, placeName: ' Front room ' };
      const created = await owner.post('/api/intakes', body);
      assert.equal(created.status, 201);
      const open = await created.json();
      assert.equal(open.placeName, 'Front room');
      assert.deepEqual(await (await owner.post('/api/intakes', body)).json(), open, 'an identical retry replays');
      assert.equal((await owner.post('/api/intakes', { ...body, placeName: 'Other' })).status, 409);
      assert.equal((await owner.post('/api/intakes', { ...body, requestId: randomUUID(), placeName: 'z'.repeat(121) })).status, 400);
      const upload = await owner.request(`/api/intakes/${open.id}/parts/${planned.partId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PHOTO });
      assert.equal(upload.status, 200);

      // A name-only change keeps the received part and moves the revision.
      const plan = { requestId: randomUUID(), baseRevision: 1, text, parts: [planned], metadata, placeName: 'Back room' };
      const changed = await (await owner.post(`/api/intakes/${open.id}/plan`, plan)).json();
      assert.equal(changed.revision, 2);
      assert.equal(changed.placeName, 'Back room');
      assert.equal(changed.parts[0].status, 'received');
      assert.equal((await owner.post(`/api/intakes/${open.id}/commit`, { requestId: randomUUID(), baseRevision: 1 })).status, 409);

      await app.close();
      ({ app, owner } = await workspace({}, dataDir));
      assert.equal((await owner.json(`/api/intakes/${open.id}`)).placeName, 'Back room', 'resumed after a restart');
      const intakeFile = path.join(dataDir, 'intakes', open.id, 'intake.json');
      const openRecord = await readFile(intakeFile);
      const committed = await owner.post(`/api/intakes/${open.id}/commit`, { requestId: randomUUID(), baseRevision: 2 });
      assert.equal(committed.status, 201);
      const { draftId } = await committed.json();
      const draft = await owner.json(`/api/drafts/${draftId}`);
      assert.deepEqual(draft.place, { name: 'Back room', revision: 1, updatedAt: draft.createdAt, unavailable: false });
      assert.deepEqual(await readFile(path.join(dataDir, 'drafts', draftId, draft.photos[0].name)), PHOTO);
      assert.ok(!(await readFile(path.join(dataDir, 'drafts', draftId, 'draft.json'), 'utf8')).includes('Back room'));

      // Recovery trusts the commit receipt, not a later rename: with the
      // committed record lost, the reopened intake is still committed.
      assert.equal((await rename(owner, draftId, 1, 'Renamed later')).status, 200);
      await writeFile(intakeFile, openRecord);
      const recovered = await owner.json(`/api/intakes/${open.id}`);
      assert.deepEqual([recovered.status, recovered.draftId], ['committed', draftId]);
      assert.equal((await owner.json(`/api/drafts/${draftId}`)).place.name, 'Renamed later');
    } finally {
      await app.close();
    }
  });

  it('never clears a name from a plan that omits it, while old replays still answer', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const planned = part();
      const open = await (await owner.post('/api/intakes', { requestId: randomUUID(), text, parts: [planned], metadata })).json();
      const route = `/api/intakes/${open.id}/plan`;
      // An unnamed upload keeps the old omission behaviour and its replay.
      const unnamed = { requestId: randomUUID(), baseRevision: 1, text: 'Changed once.', parts: [planned], metadata };
      assert.equal((await (await owner.post(route, unnamed)).json()).revision, 2);
      assert.equal((await owner.post(route, unnamed)).status, 200, 'the unnamed omission replays');
      const named = await (await owner.post(route, { ...unnamed, requestId: randomUUID(), baseRevision: 2, placeName: 'Hall' })).json();
      assert.deepEqual([named.revision, named.placeName], [3, 'Hall']);
      // The exact older request still replays, and reports the current state.
      const replay = await owner.post(route, unnamed);
      assert.equal(replay.status, 200);
      assert.deepEqual([(await replay.json()).placeName], ['Hall']);

      const file = path.join(dataDir, 'intakes', open.id, 'intake.json');
      const before = await readFile(file);
      const omitted = await owner.post(route, { requestId: randomUUID(), baseRevision: 3, text: 'Changed twice.', parts: [planned], metadata });
      assert.equal(omitted.status, 409);
      assert.deepEqual(await omitted.json(), { error: 'This upload has a place name. Reload it and include the name, or clear it, before changing it.' });
      assert.deepEqual(await readFile(file), before, 'nothing was changed');
      assert.deepEqual([(await owner.json(`/api/intakes/${open.id}`)).placeName], ['Hall']);

      const cleared = await (await owner.post(route, { requestId: randomUUID(), baseRevision: 3, text: 'Changed twice.', parts: [planned], metadata, placeName: null })).json();
      assert.deepEqual([cleared.revision, cleared.placeName], [4, null], 'an explicit null clears');
      assert.equal((await owner.post(route, { requestId: randomUUID(), baseRevision: 4, text: 'Changed again.', parts: [planned], metadata })).status, 200);
    } finally {
      await app.close();
    }
  });

  it('keeps the exact earlier digest for unnamed plans and resumes a record made before names', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const planned = part();
      const body = { requestId: randomUUID(), text, parts: [planned], metadata };
      const open = await (await owner.post('/api/intakes', body)).json();
      assert.equal(open.placeName, null);
      const file = path.join(dataDir, 'intakes', open.id, 'intake.json');
      const record = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(record.initialSha256, sha256(JSON.stringify([text, [planned], metadata])));
      assert.equal(record.planSha256, record.initialSha256);
      // The same plan with an explicit null name is the same plan.
      assert.equal((await owner.post('/api/intakes', { ...body, placeName: null })).status, 200);
      assert.equal((await owner.post('/api/intakes', { ...body, placeName: '   ' })).status, 200);

      // A record written before names existed has no placeName field.
      const { placeName, ...legacy } = record;
      await writeFile(file, JSON.stringify(legacy, null, 2));
      assert.equal((await owner.post('/api/intakes', body)).status, 200, 'an old replay still matches');
      assert.equal((await owner.json(`/api/intakes/${open.id}`)).placeName, null);
      await owner.request(`/api/intakes/${open.id}/parts/${planned.partId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PHOTO });
      const committed = await owner.post(`/api/intakes/${open.id}/commit`, { requestId: randomUUID(), baseRevision: 1 });
      assert.equal(committed.status, 201);
      const { draftId } = await committed.json();
      assert.deepEqual((await owner.json(`/api/drafts/${draftId}`)).place, UNNAMED);
      await assert.rejects(stat(placeFile(dataDir, draftId)), { code: 'ENOENT' });
    } finally {
      await app.close();
    }
  });
});

describe('place renames', () => {
  it('compare-and-swap with a receipt for every success, truthful replays, clearing and unchanged source bytes', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await readyScene(owner);
      const id = scene.draft.id;
      const before = await hashes(path.join(dataDir, 'drafts', id), path.join(dataDir, 'reconstructions', id));
      assert.deepEqual((await owner.json(`/api/drafts/${id}`)).place, UNNAMED, 'a place saved without a name is unnamed');

      // A first legacy no-op keeps its receipt, so its ID cannot be reused.
      const noop = randomUUID();
      const first = await rename(owner, id, 0, null, noop);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { draftId: id, place: UNNAMED, changed: false, replayed: false, appliedRevision: 0 });
      assert.equal((await rename(owner, id, 0, 'Reuse', noop)).status, 409);

      const a = { requestId: randomUUID(), baseRevision: 0, name: ' Workshop ' };
      const named = await (await owner.post(`/api/drafts/${id}/place-name`, a)).json();
      assert.equal(named.changed, true);
      assert.equal(named.appliedRevision, 1);
      assert.equal(named.place.name, 'Workshop');
      assert.equal(named.place.revision, 1);
      assert.equal((await rename(owner, id, 0, 'Stale')).status, 409);
      assert.equal((await rename(owner, id, 1, 'Garage')).status, 200);

      // An older request's replay reports the current name, not its own.
      const replay = await owner.post(`/api/drafts/${id}/place-name`, { ...a, name: 'Workshop' });
      assert.equal(replay.status, 200, 'the canonical body matches');
      const replayed = await replay.json();
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.changed, false);
      assert.equal(replayed.appliedRevision, 1);
      assert.equal(replayed.place.name, 'Garage');
      assert.equal(replayed.place.revision, 2);
      assert.equal((await owner.post(`/api/drafts/${id}/place-name`, { ...a, name: 'Workshop 2' })).status, 409);

      const same = randomUUID();
      const unchanged = await (await rename(owner, id, 2, 'Garage', same)).json();
      assert.deepEqual([unchanged.changed, unchanged.place.revision, unchanged.appliedRevision], [false, 2, 2]);
      assert.equal((await rename(owner, id, 2, 'Other', same)).status, 409, 'a no-op ID is spent');
      const cleared = await (await rename(owner, id, 2, '  ')).json();
      assert.deepEqual([cleared.changed, cleared.place.name, cleared.place.revision], [true, null, 3]);

      for (const body of [{ requestId: randomUUID(), baseRevision: 3 }, { requestId: randomUUID(), baseRevision: 3, name: 'x', extra: 1 }, { requestId: randomUUID(), baseRevision: -1, name: 'x' },
        { requestId: 'nope', baseRevision: 3, name: 'x' }, { requestId: randomUUID(), baseRevision: 3, name: 7 }, { requestId: randomUUID(), baseRevision: 3, name: 'a\tb' }]) {
        assert.equal((await owner.post(`/api/drafts/${id}/place-name`, body)).status, 400, JSON.stringify(body));
      }
      for (const mark of ['\u061C', '\u200E', '\u200F']) assert.equal((await rename(owner, id, 3, `Mark${mark}`)).status, 400);
      assert.equal((await rename(owner, randomUUID(), 0, 'x')).status, 404);
      assert.equal((await rename(owner, 'not-an-id', 0, 'x')).status, 404);
      assert.equal((await owner.request(`/api/drafts/${id}/place-name`)).status, 405);
      const { session: contributor } = await enrolledContributor(owner, app.base, id);
      assert.equal((await rename(contributor, id, 3, 'Mine')).status, 403);
      assert.equal((await rename(client(app.base), id, 3, 'Mine')).status, 401);
      assert.equal((await rename(owner, id, 3, 'Mine', randomUUID())).status, 200);
      assert.equal((await owner.post(`/api/drafts/${id}/place-name`, { requestId: randomUUID(), baseRevision: 4, name: 'x' }, { origin: 'http://attacker.example' })).status, 403);

      assert.deepEqual(await hashes(path.join(dataDir, 'drafts', id), path.join(dataDir, 'reconstructions', id)), before, 'originals, draft.json, policies and manifests unchanged');
    } finally {
      await app.close();
    }
  });

  it('lets exactly one of two concurrent changes from the same base win, and keeps the receipt cap', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const draft = await (await saveDraft(owner)).json();
      const results = await Promise.all([rename(owner, draft.id, 0, 'North'), rename(owner, draft.id, 0, 'South')]);
      assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
      const winner = (await owner.json(`/api/drafts/${draft.id}`)).place;
      assert.equal(winner.revision, 1);
      assert.ok(['North', 'South'].includes(winner.name));

      const file = placeFile(dataDir, draft.id);
      const state = JSON.parse(await readFile(file, 'utf8'));
      const kept = state.receipts[0];
      const filler = Array.from({ length: 199 }, () => ({ requestId: randomUUID(), digest: sha256(randomUUID()), revision: 1 }));
      await writeFile(file, JSON.stringify({ ...state, receipts: [kept, ...filler] }));
      assert.equal((await rename(owner, draft.id, 1, 'East')).status, 409, 'no change after 200 receipts');
      const replay = await owner.post(`/api/drafts/${draft.id}/place-name`, { requestId: kept.requestId, baseRevision: 0, name: winner.name });
      assert.equal(replay.status, 200, 'an exact replay is found before the cap');
      assert.equal((await replay.json()).replayed, true);
    } finally {
      await app.close();
    }
  });

  it('reports unreadable naming metadata as unavailable without hiding the place or other places', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const broken = await readyScene(owner);
      const other = await (await saveDraft(owner, { placeNames: ['Kept'] })).json();
      const { session: contributor } = await enrolledContributor(owner, app.base, broken.draft.id);
      const file = placeFile(dataDir, broken.draft.id);
      for (const content of ['{broken', JSON.stringify({ schemaVersion: 1, name: ' padded ', revision: 1, updatedAt: null, receipts: [] })]) {
        await writeFile(file, content);
        const list = await owner.json('/api/drafts');
        assert.deepEqual(list.find((item) => item.id === broken.draft.id).place, UNAVAILABLE);
        assert.equal(list.find((item) => item.id === other.id).place.name, 'Kept');
        const detail = await owner.json(`/api/drafts/${broken.draft.id}`);
        assert.deepEqual(detail.place, UNAVAILABLE);
        assert.equal(detail.photos.length, 1);
        assert.equal((await owner.request(broken.original)).status, 200);
        const refused = await rename(owner, broken.draft.id, 0, 'Fix');
        assert.equal(refused.status, 503);
        assert.equal(await readFile(file, 'utf8'), content, 'nothing was changed');
        const [row] = await contributor.json('/api/contributor/places');
        assert.deepEqual([row.placeName, row.nameUnavailable, row.label, row.draftId], [null, true, 'Place name unavailable', broken.draft.id]);
        const invitation = (await owner.json('/api/invitations')).find((item) => item.draftId === broken.draft.id);
        assert.deepEqual([invitation.placeName, invitation.nameUnavailable], [null, true]);
      }
    } finally {
      await app.close();
    }
  });
});

describe('place name visibility', () => {
  it('shows names only in granted context, distinguishes scenes without IDs, and never reaches visitors, snapshots or the model', async () => {
    const calls = [];
    const proposalModel = async (call) => {
      calls.push(call);
      return { ok: false, reason: 'provider', model: null, responseId: null, usage: null };
    };
    const { app, owner, dataDir } = await workspace({ proposalModel, prepareModelImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    try {
      const SECRET = `Attic ${randomBytes(6).toString('hex')}`;
      const kitchen = await readyScene(owner, { share: true });
      await secondScene(owner, kitchen.draft);
      const twin = await readyScene(owner);
      const attic = await readyScene(owner, { share: true });
      assert.equal((await rename(owner, kitchen.draft.id, 0, 'Kitchen')).status, 200);
      assert.equal((await rename(owner, twin.draft.id, 0, 'Kitchen')).status, 200);

      // A snapshot issued before the attic is named keeps its frozen bytes.
      const shares = `${attic.scene}/shares`;
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const preview = await (await owner.post(`${shares}/previews`, { requestId: randomUUID(), title: 'Synthetic visit', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true })).json();
      const token = `rhv_${randomBytes(32).toString('base64url')}`;
      assert.equal((await owner.post(shares, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true })).status, 201);
      const visit = (route = '/api/visit') => globalThis.fetch(`${app.base}${route}`, { headers: { authorization: `Bearer ${token}` } });
      const manifestFile = path.join(dataDir, 'reconstructions', attic.draft.id, attic.job.id, 'manifest.json');
      const frozen = JSON.stringify(JSON.parse(await readFile(manifestFile, 'utf8')).shares.snapshots);
      const visitBefore = await (await visit()).text();
      assert.equal((await rename(owner, attic.draft.id, 0, SECRET)).status, 200);
      assert.equal(JSON.stringify(JSON.parse(await readFile(manifestFile, 'utf8')).shares.snapshots), frozen);
      const visitAfter = await (await visit()).text();
      assert.equal(visitAfter, visitBefore);
      assert.ok(!visitAfter.includes(SECRET));
      for (const route of [`/api/visit/assets/${view.id}/surface.json`, `/api/visit/assets/${view.id}/texture.jpg`, '/api/visit/assets/not-a-view/texture.jpg']) {
        assert.ok(!Buffer.from(await (await visit(route)).arrayBuffer()).toString('latin1').includes(SECRET), route);
      }

      // The invited contributor sees only their place, with structured context.
      const { session: contributor } = await enrolledContributor(owner, app.base, kitchen.draft.id);
      const rows = await contributor.json('/api/contributor/places');
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.label).sort(), ['Kitchen · scene 1', 'Kitchen · scene 2']);
      assert.ok(rows.every((row) => row.draftId === kitchen.draft.id && row.placeName === 'Kitchen' && row.sceneCount === 2 && row.photoNumber === 1
        && row.draftSavedAt === kitchen.draft.createdAt && typeof row.buildRequestedAt === 'string' && row.nameUnavailable === false));
      assert.deepEqual(rows.map((row) => row.sceneOrdinal).sort(), [1, 2]);
      assert.ok(!JSON.stringify(rows).includes(SECRET));
      // The owner sees every place; duplicate names stay apart by structure, not IDs.
      const all = await owner.json('/api/contributor/places');
      assert.equal(all.length, 4);
      assert.ok(all.every((row) => !row.label.includes(row.draftId.slice(0, 8)) && !row.label.includes(row.jobId.slice(0, 8))));
      assert.equal(all.find((row) => row.draftId === twin.draft.id).label, 'Kitchen');
      assert.deepEqual((await owner.json('/api/invitations')).map((item) => item.placeName), ['Kitchen']);

      // Invalid or revoked invitations never reveal a name.
      const revokedToken = generateSecret('invitation');
      const invite = await (await owner.post('/api/invitations', { requestId: randomUUID(), draftId: attic.draft.id, expiresInHours: 24, token: revokedToken })).json();
      assert.equal((await owner.post(`/api/invitations/${invite.id}/revoke`, {})).status, 200);
      for (const candidate of [revokedToken, generateSecret('invitation')]) {
        const response = await client(app.base).post('/api/invitations/redeem', { token: candidate, requestId: randomUUID(), displayName: 'Probe', ...freshCredentials() });
        assert.notEqual(response.status, 200);
        const text = await response.text();
        assert.ok(!text.includes(SECRET) && !text.includes('Kitchen'), text);
      }

      // The model never receives the owner's place name.
      const proposal = await (await owner.post(`${attic.scene}/proposals`, { requestId: randomUUID(), baseVersion: 1, text: 'Turn it toward the window.', consent: true })).json();
      for (let attempt = 0; attempt < 200; attempt++) {
        const item = await owner.json(`${attic.scene}/proposals/${proposal.id}`);
        if (!['queued', 'processing'].includes(item.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(calls.length, 1);
      assert.ok(!JSON.stringify(calls[0], (key, value) => (Buffer.isBuffer(value) || value instanceof Uint8Array ? `bytes:${value.length}` : value)).includes(SECRET));
    } finally {
      await app.close();
    }
  });
});
