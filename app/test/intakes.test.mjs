import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DraftStore } from '../drafts.mjs';
import { IntakeStore } from '../intakes.mjs';
import { acceptingTestMediaVerifier, client, enrolledContributor, png, startOwnerServer } from './auth-helper.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Synthetic files only: two distinct PNGs and a WebM header.
const PHOTO_1 = png(40, 30, 7);
const PHOTO_2 = png(40, 30, 9);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const TEXT = '  A raw memory,\nwith its own line breaks and trailing spaces.  \n';
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function workspace(dataDir) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-intake-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

const grant = (provider, permissions = { place: true, model: false, share: false }) => ({
  provider, origin: { kind: 'own', reference: 'synthetic' }, permissions,
  dates: { capturedOn: '2020-05-01', fileCreatedAt: null, fileModifiedAt: '2020-05-02T10:00:00Z', estimatedPeriod: 'spring' },
});
const part = (bytes, kind = 'photo', hints = { name: 'photo.png', type: 'image/png', lastModified: 1_600_000_000_000 }) => ({
  partId: randomUUID(), kind, size: bytes.length, sha256: sha256(bytes), hints,
});
const createBody = (parts, change = {}) => ({
  requestId: randomUUID(), text: TEXT, parts,
  metadata: { photos: parts.filter((item) => item.kind === 'photo').map((_, index) => grant(`Photo source ${index + 1}`)), text: grant('Text source'), ...(parts.some((item) => item.kind === 'voice') && { voice: grant('Voice source') }) },
  ...change,
});
const upload = (owner, id, partId, bytes, type = 'application/octet-stream') => owner.request(`/api/intakes/${id}/parts/${partId}`, { method: 'POST', headers: { 'content-type': type }, body: bytes });
const state = (owner, id) => owner.json(`/api/intakes/${id}`);
const intakeFile = (dataDir, id) => path.join(dataDir, 'intakes', id, 'intake.json');

describe('intake creation', () => {
  it('keeps the raw text and settings exactly, replays an identical create and refuses a changed one', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const body = createBody([part(PHOTO_1), part(WEBM, 'voice', { name: 'take', type: 'audio/webm', lastModified: null })]);
      const created = await owner.post('/api/intakes', body);
      assert.equal(created.status, 201);
      const open = await created.json();
      assert.deepEqual(Object.keys(open).sort(), ['createdAt', 'id', 'metadata', 'parts', 'placeName', 'revision', 'status', 'text', 'updatedAt']);
      assert.equal(open.placeName, null);
      assert.equal(open.id, body.requestId);
      assert.equal(open.status, 'open');
      assert.equal(open.revision, 1);
      assert.equal(open.text, TEXT);
      assert.deepEqual(open.metadata, body.metadata);
      assert.deepEqual(open.parts.map((item) => [item.status, item.error, item.detectedType]), [['missing', null, null], ['missing', null, null]]);
      assert.deepEqual(open.parts[1].hints, { name: 'take', type: 'audio/webm', lastModified: null });
      const replay = await owner.post('/api/intakes', body);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), open);
      assert.equal((await owner.post('/api/intakes', { ...body, text: 'changed' })).status, 409);
      assert.deepEqual((await owner.json('/api/intakes')).map((item) => item.id), [open.id]);
      const mode = (await stat(path.join(dataDir, 'intakes', open.id))).mode & 0o777;
      assert.equal(mode, 0o700);
      assert.equal((await stat(intakeFile(dataDir, open.id))).mode & 0o777, 0o600);
      assert.equal((await owner.json('/api/drafts')).length, 0, 'an intake is not a saved memory');
    } finally {
      await app.close();
    }
  });

  it('refuses malformed plans and limits before anything is stored', async () => {
    const { app, owner } = await workspace();
    try {
      const good = part(PHOTO_1);
      const cases = [
        [400, { ...createBody([good]), extra: 1 }],
        [400, createBody([{ ...good, partId: 'nope' }])],
        [400, createBody([{ ...good, sha256: 'ABC' }])],
        [400, createBody([{ ...good, size: -1 }])],
        [400, createBody([{ ...good, hints: { name: 'bad\u0007', type: '', lastModified: null } }])],
        [400, createBody([{ ...good, hints: { name: '', type: 'image/p\u00e9ng', lastModified: null } }])],
        [400, createBody([{ ...good, hints: { name: '', type: '', lastModified: 1.5 } }])],
        [400, createBody([{ ...good, hints: { name: 'x'.repeat(256), type: '', lastModified: null } }])],
        [400, createBody([good, { ...good }])],
        [413, createBody(Array.from({ length: 21 }, () => part(PHOTO_1)))],
        [400, createBody([part(WEBM, 'voice'), part(WEBM, 'voice')])],
        [413, createBody([{ ...good, size: 20 * 1024 * 1024 + 1 }])],
        [413, createBody(Array.from({ length: 4 }, () => ({ ...part(PHOTO_1), size: 17 * 1024 * 1024 })))],
        [400, createBody([], { text: '   ' })],
        [413, createBody([good], { text: 'x'.repeat(10_001) })],
        [400, createBody([good], { metadata: { photos: [] } })],
        [400, createBody([good], { text: '  \n ' })],
      ];
      for (const [status, body] of cases) {
        assert.equal((await owner.post('/api/intakes', body)).status, status, JSON.stringify(body).slice(0, 80));
      }
      assert.equal((await owner.post('/api/intakes', createBody([good], { text: 'x'.repeat(600_000) }))).status, 413);
      assert.deepEqual(await owner.json('/api/intakes'), []);
      // Blank text with no text source is a valid staged plan; the blank text is kept until commit.
      const blank = createBody([good], { text: ' \n', metadata: { photos: [grant('Photo')] } });
      const created = await owner.post('/api/intakes', blank);
      assert.equal(created.status, 201);
      assert.equal((await created.json()).text, ' \n');
    } finally {
      await app.close();
    }
  });
});

describe('client UUID fields', () => {
  it('refuses arrays and objects that would coerce to a valid UUID, in every body', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const id = randomUUID();
      const good = part(PHOTO_1);
      for (const wrap of [(value) => [value], (value) => ({ toString: value })]) {
        assert.equal((await owner.post('/api/intakes', createBody([{ ...good, partId: wrap(good.partId) }]))).status, 400, 'partId');
        assert.equal((await owner.post('/api/intakes', createBody([good], { requestId: wrap(id) }))).status, 400, 'create requestId');
        assert.equal((await owner.post('/api/intakes', createBody([{ ...good, sha256: wrap(good.sha256) }]))).status, 400, 'sha256');
      }
      assert.deepEqual(await readdir(path.join(dataDir, 'intakes')).catch(() => []), [], 'nothing was stored');
      const body = createBody([good]);
      await owner.post('/api/intakes', body);
      const planBody = { requestId: randomUUID(), baseRevision: 1, text: body.text, parts: [good], metadata: body.metadata };
      assert.equal((await owner.post(`/api/intakes/${body.requestId}/plan`, { ...planBody, requestId: [planBody.requestId] })).status, 400, 'plan requestId');
      assert.equal((await owner.post(`/api/intakes/${body.requestId}/plan`, { ...planBody, parts: [{ ...good, partId: [good.partId] }] })).status, 400, 'plan partId');
      assert.equal((await owner.post(`/api/intakes/${body.requestId}/commit`, { requestId: [randomUUID()], baseRevision: 1 })).status, 400, 'commit requestId');
      assert.equal((await owner.post(`/api/intakes/${body.requestId}/discard`, { requestId: [randomUUID()] })).status, 400, 'discard requestId');
      const now = await state(owner, body.requestId);
      assert.equal(now.revision, 1);
      assert.equal(typeof now.parts[0].partId, 'string');
    } finally {
      await app.close();
    }
  });
});

describe('intake parts', () => {
  it('receives each part independently, isolates failures and lets only that part be retried', async () => {
    const { app, owner } = await workspace();
    try {
      const good = part(PHOTO_1);
      const other = part(PHOTO_2);
      const empty = { ...part(Buffer.alloc(0)), size: 0 };
      const voice = part(WEBM, 'voice');
      const body = createBody([good, other, empty, voice]);
      const { id } = await (await owner.post('/api/intakes', body)).json();

      const received = await upload(owner, id, good.partId, PHOTO_1);
      assert.equal(received.status, 200);
      assert.deepEqual(await received.json(), { partId: good.partId, status: 'received', detectedType: 'image/png' });
      assert.equal((await upload(owner, id, good.partId, PHOTO_1)).status, 200, 'an exact repeat');
      assert.equal((await upload(owner, id, good.partId, PHOTO_2)).status, 409, 'a received part is never replaced');

      assert.equal((await upload(owner, id, other.partId, PHOTO_1)).status, 400, 'wrong checksum');
      assert.equal((await upload(owner, id, empty.partId, Buffer.alloc(0))).status, 400, 'empty');
      assert.equal((await upload(owner, id, voice.partId, WEBM, 'text/plain')).status, 415);
      let now = await state(owner, id);
      assert.deepEqual(now.parts.map((item) => [item.status, item.error]), [['received', null], ['failed', 'hash'], ['failed', 'empty'], ['missing', null]]);

      assert.equal((await upload(owner, id, other.partId, PHOTO_2)).status, 200, 'retry of only the failed part');
      assert.equal((await upload(owner, id, voice.partId, WEBM)).status, 200);
      now = await state(owner, id);
      assert.deepEqual(now.parts.map((item) => item.status), ['received', 'received', 'failed', 'received']);
      assert.equal(now.revision, 1, 'part receipts do not change the plan revision');

      const bytes = await owner.request(`/api/intakes/${id}/parts/${good.partId}`);
      assert.equal(bytes.status, 200);
      assert.equal(bytes.headers.get('content-type'), 'image/png');
      assert.equal(bytes.headers.get('cache-control'), 'no-store');
      assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(sha256(Buffer.from(await bytes.arrayBuffer())), good.sha256);
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${good.partId}`, { headers: { range: 'bytes=0-3' } })).status, 206);
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${good.partId}`, { method: 'HEAD' })).status, 200);
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${empty.partId}`)).status, 404);
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${randomUUID()}`)).status, 404);

      // Over the photo cap: refused before buffering the rest, and only that part fails.
      const huge = part(PHOTO_1);
      const plan = await owner.post(`/api/intakes/${id}/plan`, { requestId: randomUUID(), baseRevision: 1, text: body.text, parts: [good, other, voice, huge], metadata: { ...body.metadata, photos: [grant('a'), grant('b'), grant('c')] } });
      assert.equal(plan.status, 200);
      assert.equal((await upload(owner, id, huge.partId, Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413);
      now = await state(owner, id);
      assert.deepEqual(now.parts.map((item) => [item.status, item.error]), [['received', null], ['received', null], ['received', null], ['failed', 'size']]);
    } finally {
      await app.close();
    }
  });
});

describe('intake plans', () => {
  it('uses compare-and-swap, keeps unchanged received parts, removes dropped ones and never reapplies an older plan', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const keep = part(PHOTO_1);
      const drop = part(PHOTO_2);
      const body = createBody([keep, drop]);
      const { id } = await (await owner.post('/api/intakes', body)).json();
      await upload(owner, id, keep.partId, PHOTO_1);
      await upload(owner, id, drop.partId, PHOTO_2);

      const planBody = {
        requestId: randomUUID(), baseRevision: 1, text: 'Edited\ntext', parts: [{ ...keep, hints: { name: 'renamed.png', type: 'image/png', lastModified: null } }],
        metadata: { photos: [grant('Edited source', { place: false, model: false, share: false })], text: grant('Text') },
      };
      const planned = await owner.post(`/api/intakes/${id}/plan`, planBody);
      assert.equal(planned.status, 200);
      const v2 = await planned.json();
      assert.equal(v2.revision, 2);
      assert.equal(v2.text, 'Edited\ntext');
      assert.deepEqual(v2.parts.map((item) => [item.partId, item.status, item.hints.name]), [[keep.partId, 'received', 'renamed.png']]);
      assert.deepEqual(v2.metadata.photos[0].permissions, { place: false, model: false, share: false });
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${drop.partId}`)).status, 404);
      assert.deepEqual(await readdir(path.join(dataDir, 'intakes', id, 'parts')), [`${keep.partId}.bin`]);
      assert.equal((await upload(owner, id, drop.partId, PHOTO_2)).status, 404, 'a removed part cannot be revived');

      assert.equal((await owner.post(`/api/intakes/${id}/plan`, { ...planBody, requestId: randomUUID() })).status, 409, 'stale base revision');
      const v3 = await (await owner.post(`/api/intakes/${id}/plan`, { ...planBody, requestId: randomUUID(), baseRevision: 2, text: 'Third' })).json();
      assert.equal(v3.revision, 3);
      const replay = await owner.post(`/api/intakes/${id}/plan`, planBody);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), v3, 'a replay returns the current plan, never the older one');
      assert.equal((await owner.post(`/api/intakes/${id}/plan`, { ...planBody, text: 'other' })).status, 409);
      assert.equal((await owner.post(`/api/intakes/${id}/plan`, { ...planBody, requestId: randomUUID(), baseRevision: 3, parts: [{ ...keep, sha256: sha256(PHOTO_2) }] })).status, 409, 'a changed file needs a new part ID');
    } finally {
      await app.close();
    }
  });

  it('discards a late upload whose part was removed while its bytes were being checked', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-intake-'));
    tempDirs.push(dataDir);
    const store = new IntakeStore({ dataDir, drafts: new DraftStore(dataDir), verifier: acceptingTestMediaVerifier() /* disclosed media seam, see auth-helper */ });
    const owner = { id: randomUUID(), role: 'owner' };
    const late = part(PHOTO_1);
    const stay = part(PHOTO_2);
    const body = createBody([late, stay]);
    await store.create(owner, body);
    const uploading = store.receivePart(body.requestId, late.partId, PHOTO_1);
    const replanning = store.plan(body.requestId, { requestId: randomUUID(), baseRevision: 1, text: body.text, parts: [stay], metadata: { ...body.metadata, photos: [grant('stay')] } });
    await assert.rejects(uploading, (error) => error.status === 409);
    await replanning;
    const now = await store.get(body.requestId);
    assert.deepEqual(now.parts.map((item) => item.partId), [stay.partId]);
    assert.deepEqual(await readdir(path.join(dataDir, 'intakes', body.requestId, 'parts')), []);
  });
});

describe('late uploads after re-planning', () => {
  it('never publishes old bytes for a part ID that was removed and re-added for a different file', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-intake-'));
    tempDirs.push(dataDir);
    const store = new IntakeStore({ dataDir, drafts: new DraftStore(dataDir), verifier: acceptingTestMediaVerifier() /* disclosed media seam, see auth-helper */ });
    const owner = { id: randomUUID(), role: 'owner' };
    const original = part(PHOTO_1);
    const body = createBody([original]);
    await store.create(owner, body);
    const uploading = store.receivePart(body.requestId, original.partId, PHOTO_1);
    const removed = store.plan(body.requestId, { requestId: randomUUID(), baseRevision: 1, text: body.text, parts: [], metadata: { text: grant('Text') } });
    const readded = { ...original, size: PHOTO_2.length, sha256: sha256(PHOTO_2) };
    const replaced = store.plan(body.requestId, { requestId: randomUUID(), baseRevision: 2, text: body.text, parts: [readded], metadata: { ...body.metadata, photos: [grant('new')] } });
    await assert.rejects(uploading, (error) => error.status === 409);
    await removed;
    await replaced;
    const now = await store.get(body.requestId);
    assert.deepEqual(now.parts.map((item) => [item.partId, item.sha256, item.status]), [[original.partId, sha256(PHOTO_2), 'missing']]);
    assert.deepEqual(await readdir(path.join(dataDir, 'intakes', body.requestId, 'parts')), []);
  });
});

describe('intake commit', () => {
  async function readyIntake(owner) {
    const one = part(PHOTO_1);
    const two = part(PHOTO_2);
    const voice = part(WEBM, 'voice');
    const body = createBody([one, two, voice]);
    const { id } = await (await owner.post('/api/intakes', body)).json();
    for (const [item, bytes] of [[one, PHOTO_1], [two, PHOTO_2], [voice, WEBM]]) assert.equal((await upload(owner, id, item.partId, bytes)).status, 200);
    return { id, body, parts: [one, two, voice] };
  }

  it('commits once into an ordinary draft with the same bytes and settings and returns only a receipt', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const { id, body } = await readyIntake(owner);
      const missing = createBody([part(PHOTO_1)]);
      const { id: incomplete } = await (await owner.post('/api/intakes', missing)).json();
      assert.equal((await owner.post(`/api/intakes/${incomplete}/commit`, { requestId: randomUUID(), baseRevision: 1 })).status, 409);
      assert.equal((await owner.post(`/api/intakes/${id}/commit`, { requestId: randomUUID(), baseRevision: 2 })).status, 409);

      const commitBody = { requestId: randomUUID(), baseRevision: 1 };
      const committed = await owner.post(`/api/intakes/${id}/commit`, commitBody);
      assert.equal(committed.status, 201);
      const receipt = await committed.json();
      assert.deepEqual(Object.keys(receipt).sort(), ['draftId', 'id', 'receipt', 'revision', 'status']);
      assert.equal(receipt.status, 'committed');
      assert.deepEqual(Object.keys(receipt.receipt).sort(), ['commitRequestId', 'intakeId', 'ownerId', 'planSha256', 'revision']);
      const replay = await owner.post(`/api/intakes/${id}/commit`, commitBody);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), receipt);
      assert.equal((await owner.post(`/api/intakes/${id}/commit`, { requestId: randomUUID(), baseRevision: 1 })).status, 409);

      const draft = await owner.json(`/api/drafts/${receipt.draftId}`);
      assert.equal(draft.schemaVersion, 2);
      assert.equal(draft.text, TEXT);
      assert.deepEqual(draft.sources.filter((item) => item.kind === 'photo').map((item) => [item.provider, item.dates.fileModifiedAt, item.permissions.place]), [
        ['Photo source 1', '2020-05-02T10:00:00Z', true], ['Photo source 2', '2020-05-02T10:00:00Z', true],
      ]);
      for (const [index, bytes] of [PHOTO_1, PHOTO_2].entries()) {
        const asset = await owner.request(`/api/drafts/${receipt.draftId}/assets/${draft.photos[index].name}`);
        assert.equal(sha256(Buffer.from(await asset.arrayBuffer())), sha256(bytes));
      }
      assert.equal((await owner.request(`/api/drafts/${receipt.draftId}/assets/intake-receipt.json`)).status, 404, 'the receipt is never served');
      const stored = JSON.parse(await readFile(path.join(dataDir, 'drafts', receipt.draftId, 'intake-receipt.json'), 'utf8'));
      assert.deepEqual(stored, receipt.receipt);
      assert.equal(stored.intakeId, id);

      // Every terminal surface is the receipt only.
      const after = await state(owner, id);
      assert.deepEqual(after, receipt);
      assert.equal(JSON.stringify(after).includes('raw memory'), false);
      assert.ok(!(await owner.json('/api/intakes')).some((item) => item.id === id), 'a committed intake is not listed');
      const createReplay = await owner.post('/api/intakes', body);
      assert.equal(createReplay.status, 200);
      assert.deepEqual(await createReplay.json(), receipt);
      assert.equal((await owner.post(`/api/intakes/${id}/plan`, { requestId: randomUUID(), baseRevision: 1, text: 'x', parts: [], metadata: {} })).status, 409);
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${body.parts[0].partId}`)).status, 409);
      assert.equal((await owner.post(`/api/intakes/${id}/discard`, { requestId: randomUUID() })).status, 409);
      await assert.rejects(stat(path.join(dataDir, 'intakes', id, 'parts')));
      assert.equal((await owner.json('/api/drafts')).length, 1);
    } finally {
      await app.close();
    }
  });

  it('makes exactly one draft from two concurrent commits', async () => {
    const { app, owner } = await workspace();
    try {
      const { id } = await readyIntake(owner);
      const statuses = (await Promise.all([1, 2].map(() => owner.post(`/api/intakes/${id}/commit`, { requestId: randomUUID(), baseRevision: 1 })))).map((response) => response.status).sort();
      assert.deepEqual(statuses, [201, 409]);
      assert.equal((await owner.json('/api/drafts')).length, 1);
    } finally {
      await app.close();
    }
  });

  it('recovers a commit whose intake update was lost after the draft rename, without a duplicate or reopened staging', async () => {
    const first = await workspace();
    const { id, parts } = await readyIntake(first.owner);
    const openRecord = await readFile(intakeFile(first.dataDir, id), 'utf8');
    const commitBody = { requestId: randomUUID(), baseRevision: 1 };
    const receipt = await (await first.owner.post(`/api/intakes/${id}/commit`, commitBody)).json();
    await first.app.close();
    // Simulate a crash after the rename: the intake still says open and keeps its parts.
    await writeFile(intakeFile(first.dataDir, id), openRecord);
    await mkdir(path.join(first.dataDir, 'intakes', id, 'parts'), { recursive: true });
    await writeFile(path.join(first.dataDir, 'intakes', id, 'parts', `${parts[0].partId}.bin`), PHOTO_1);
    const second = await workspace(first.dataDir);
    try {
      assert.equal((await second.owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`)).status, 409);
      assert.equal((await second.owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`, { method: 'HEAD' })).status, 409);
      assert.deepEqual(await state(second.owner, id), receipt);
      const replay = await second.owner.post(`/api/intakes/${id}/commit`, commitBody);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), receipt);
      assert.equal((await second.owner.json('/api/drafts')).length, 1);
      await assert.rejects(stat(path.join(first.dataDir, 'intakes', id, 'parts')));
    } finally {
      await second.app.close();
    }
  });

  it('keeps every terminal surface receipt-only when cleanup fails and the photo is later stopped', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const { id, parts } = await readyIntake(owner);
      const receipt = await (await owner.post(`/api/intakes/${id}/commit`, { requestId: randomUUID(), baseRevision: 1 })).json();
      // Leftover staging after a failed cleanup must stay unreachable.
      await mkdir(path.join(dataDir, 'intakes', id, 'parts'), { recursive: true });
      await writeFile(path.join(dataDir, 'intakes', id, 'parts', `${parts[0].partId}.bin`), PHOTO_1);
      const draft = await owner.json(`/api/drafts/${receipt.draftId}`);
      const policy = `/api/drafts/${receipt.draftId}/sources/${draft.photos[0].sourceId}/policy`;
      const { revision } = await owner.json(policy);
      assert.equal((await owner.post(policy, { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true })).status, 200);
      assert.notEqual((await owner.request(`/api/drafts/${receipt.draftId}/assets/${draft.photos[0].name}`)).status, 200);
      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-3' } }]) {
        assert.equal((await owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`, init)).status, 409, JSON.stringify(init));
      }
      assert.deepEqual(await state(owner, id), receipt);
      assert.equal((await owner.post(`/api/intakes/${id}/plan`, { requestId: randomUUID(), baseRevision: 1, text: TEXT, parts: [], metadata: {} })).status, 409);
    } finally {
      await app.close();
    }
  });

  it('exposes nothing and changes nothing when the reserved draft folder cannot be checked', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const { app, owner, dataDir } = await workspace();
    const draftsDir = path.join(dataDir, 'drafts');
    try {
      const { id, parts } = await readyIntake(owner);
      const openRecord = await readFile(intakeFile(dataDir, id), 'utf8');
      const commitBody = { requestId: randomUUID(), baseRevision: 1 };
      const receipt = await (await owner.post(`/api/intakes/${id}/commit`, commitBody)).json();
      const draft = await owner.json(`/api/drafts/${receipt.draftId}`);
      const policy = `/api/drafts/${receipt.draftId}/sources/${draft.photos[0].sourceId}/policy`;
      const { revision } = await owner.json(policy);
      assert.equal((await owner.post(policy, { requestId: randomUUID(), baseRevision: revision, permissions: { place: false, model: false, share: false }, stopUse: true })).status, 200);
      // The crash seam again: the intake still says open and keeps a part file.
      await writeFile(intakeFile(dataDir, id), openRecord);
      await mkdir(path.join(dataDir, 'intakes', id, 'parts'), { recursive: true });
      await writeFile(path.join(dataDir, 'intakes', id, 'parts', `${parts[0].partId}.bin`), PHOTO_1);

      // A real EACCES: the reserved folder's parent cannot be searched.
      await chmod(draftsDir, 0o000);
      try {
        const surfaces = [
          owner.request(`/api/intakes/${id}`),
          owner.request(`/api/intakes/${id}`, { method: 'HEAD' }),
          owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`),
          owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`, { method: 'HEAD' }),
          owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`, { headers: { range: 'bytes=0-3' } }),
          owner.post(`/api/intakes/${id}/plan`, { requestId: randomUUID(), baseRevision: 1, text: TEXT, parts: [], metadata: { text: grant('Text') } }),
          owner.post(`/api/intakes/${id}/commit`, commitBody),
          owner.post(`/api/intakes/${id}/discard`, { requestId: randomUUID() }),
          upload(owner, id, parts[0].partId, PHOTO_1),
        ];
        for (const response of await Promise.all(surfaces)) {
          assert.equal(response.status, 409, response.url);
          const text = await response.text();
          assert.ok(!text.includes('raw memory') && !text.includes('Photo source'), response.url);
        }
        const listed = await owner.json('/api/intakes');
        assert.ok(!listed.some((item) => item.id === id), 'not listed as open');
        const stored = JSON.parse(await readFile(intakeFile(dataDir, id), 'utf8'));
        assert.equal(stored.status, 'open', 'nothing was recorded while the state was unknown');
      } finally {
        await chmod(draftsDir, 0o700);
      }
      // Once readable again, the receipt decides: committed, with no duplicate.
      assert.deepEqual(await state(owner, id), receipt);
      assert.equal((await owner.json('/api/drafts')).length, 1);
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`)).status, 409);
    } finally {
      await chmod(draftsDir, 0o700).catch(() => {});
      await app.close();
    }
  });

  it('never claims a commit from a damaged final folder, and keeps the open record and staged bytes', async () => {
    const corruptions = {
      'missing draft.json': (dir) => rm(path.join(dir, 'draft.json')),
      'missing photo original': async (dir) => {
        const draft = JSON.parse(await readFile(path.join(dir, 'draft.json'), 'utf8'));
        await rm(path.join(dir, draft.photos[0].name));
      },
      'same-size corrupt photo': async (dir) => {
        const draft = JSON.parse(await readFile(path.join(dir, 'draft.json'), 'utf8'));
        const file = path.join(dir, draft.photos[1].name);
        const bytes = await readFile(file);
        bytes[bytes.length - 1] ^= 0xff;
        await writeFile(file, bytes);
      },
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
      const { app, owner, dataDir } = await workspace();
      try {
        const { id, parts } = await readyIntake(owner);
        const openRecord = await readFile(intakeFile(dataDir, id), 'utf8');
        const commitBody = { requestId: randomUUID(), baseRevision: 1 };
        const receipt = await (await owner.post(`/api/intakes/${id}/commit`, commitBody)).json();
        const finalDir = path.join(dataDir, 'drafts', receipt.draftId);
        const saved = await readdir(finalDir);
        const backup = Object.fromEntries(await Promise.all(saved.map(async (file) => [file, await readFile(path.join(finalDir, file))])));
        // The crash seam: the intake still says open and keeps a staged part.
        await writeFile(intakeFile(dataDir, id), openRecord);
        await mkdir(path.join(dataDir, 'intakes', id, 'parts'), { recursive: true });
        const staged = path.join(dataDir, 'intakes', id, 'parts', `${parts[0].partId}.bin`);
        await writeFile(staged, PHOTO_1);
        await corrupt(finalDir);

        for (const response of await Promise.all([
          owner.request(`/api/intakes/${id}`),
          owner.request(`/api/intakes/${id}/parts/${parts[0].partId}`),
          owner.post(`/api/intakes/${id}/commit`, commitBody),
          owner.post(`/api/intakes/${id}/plan`, { requestId: randomUUID(), baseRevision: 1, text: TEXT, parts: [], metadata: { text: grant('Text') } }),
          owner.post(`/api/intakes/${id}/discard`, { requestId: randomUUID() }),
        ])) {
          assert.equal(response.status, 409, `${name}: ${response.url}`);
          assert.ok(!(await response.text()).includes('raw memory'), name);
        }
        assert.ok(!(await owner.json('/api/intakes')).some((item) => item.id === id), name);
        assert.equal(JSON.parse(await readFile(intakeFile(dataDir, id), 'utf8')).status, 'open', `${name}: the open record is kept`);
        assert.deepEqual(await readFile(staged), PHOTO_1, `${name}: the staged original is kept`);

        // Once the final folder is whole again, the receipt resolves the commit.
        for (const [file, bytes] of Object.entries(backup)) await writeFile(path.join(finalDir, file), bytes);
        assert.deepEqual(await state(owner, id), receipt, name);
        assert.equal((await owner.json('/api/drafts')).length, 1, name);
      } finally {
        await app.close();
      }
    }
  });

  it('recovers a fully stored part whose acknowledgement was lost, and fails closed on a conflicting reserved folder', async () => {
    const first = await workspace();
    const one = part(PHOTO_1);
    const body = createBody([one]);
    const { id } = await (await first.owner.post('/api/intakes', body)).json();
    await first.app.close();
    // A crash after the part rename but before the intake update: bytes stored, state still missing.
    await writeFile(path.join(first.dataDir, 'intakes', id, 'parts', `${one.partId}.bin`), PHOTO_1);
    await writeFile(path.join(first.dataDir, 'intakes', id, 'parts', `${randomUUID()}.bin`), PHOTO_2);
    await writeFile(path.join(first.dataDir, 'intakes', id, 'parts', `${one.partId}.x.tmp`), 'partial');
    const second = await workspace(first.dataDir);
    try {
      const now = await state(second.owner, id);
      assert.deepEqual(now.parts.map((item) => [item.status, item.detectedType]), [['received', 'image/png']]);
      assert.deepEqual(await readdir(path.join(first.dataDir, 'intakes', id, 'parts')), [`${one.partId}.bin`]);
      const committed = await second.owner.post(`/api/intakes/${id}/commit`, { requestId: randomUUID(), baseRevision: 1 });
      assert.equal(committed.status, 201, 'no re-upload was needed');

      const other = createBody([part(PHOTO_2)]);
      const { id: conflictId } = await (await second.owner.post('/api/intakes', other)).json();
      const reserved = JSON.parse(await readFile(intakeFile(first.dataDir, conflictId), 'utf8')).draftId;
      await mkdir(path.join(first.dataDir, 'drafts', reserved), { recursive: true });
      await writeFile(path.join(first.dataDir, 'drafts', reserved, 'intake-receipt.json'), JSON.stringify({ intakeId: randomUUID() }));
      assert.equal((await second.owner.request(`/api/intakes/${conflictId}`)).status, 409);
      assert.equal((await second.owner.post(`/api/intakes/${conflictId}/commit`, { requestId: randomUUID(), baseRevision: 1 })).status, 409);
    } finally {
      await second.app.close();
    }
  });
});

describe('intake discard and authority', () => {
  it('discards explicitly and idempotently, and keeps a discarded intake receipt-only', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const one = part(PHOTO_1);
      const body = createBody([one]);
      const { id } = await (await owner.post('/api/intakes', body)).json();
      await upload(owner, id, one.partId, PHOTO_1);
      const discardBody = { requestId: randomUUID() };
      const discarded = await owner.post(`/api/intakes/${id}/discard`, discardBody);
      assert.equal(discarded.status, 200);
      assert.deepEqual(await discarded.json(), { id, status: 'discarded', revision: 1 });
      assert.equal((await owner.post(`/api/intakes/${id}/discard`, discardBody)).status, 200);
      assert.deepEqual(await (await owner.post('/api/intakes', body)).json(), { id, status: 'discarded', revision: 1 });
      assert.equal((await owner.request(`/api/intakes/${id}/parts/${one.partId}`)).status, 409);
      assert.equal((await owner.post(`/api/intakes/${id}/commit`, { requestId: randomUUID(), baseRevision: 1 })).status, 409);
      await assert.rejects(stat(path.join(dataDir, 'intakes', id, 'parts')));
      assert.deepEqual(await owner.json('/api/intakes'), []);
    } finally {
      await app.close();
    }
  });

  it('denies anonymous, contributor and cross-site access to every intake route', async () => {
    const { app, owner } = await workspace();
    try {
      const one = part(PHOTO_1);
      const { id } = await (await owner.post('/api/intakes', createBody([one]))).json();
      const form = new FormData();
      form.append('text', 'Synthetic memory');
      const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
      const { session: contributor } = await enrolledContributor(owner, app.base, draft.id);
      const routes = [
        ['GET', '/api/intakes'], ['POST', '/api/intakes'], ['GET', `/api/intakes/${id}`], ['HEAD', `/api/intakes/${id}`],
        ['GET', `/api/intakes/${id}/parts/${one.partId}`], ['POST', `/api/intakes/${id}/parts/${one.partId}`],
        ['POST', `/api/intakes/${id}/plan`], ['POST', `/api/intakes/${id}/commit`], ['POST', `/api/intakes/${id}/discard`],
      ];
      for (const [method, route] of routes) {
        const init = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method };
        assert.equal((await client(app.base).request(route, init)).status, 401, `${method} ${route}`);
        assert.equal((await contributor.request(route, init)).status, 403, `${method} ${route}`);
      }
      assert.equal((await owner.post('/api/intakes', createBody([part(PHOTO_2)]), { origin: 'http://attacker.example' })).status, 403);
      assert.equal((await owner.request('/api/intakes/not-a-uuid')).status, 404);
    } finally {
      await app.close();
    }
  });
});
