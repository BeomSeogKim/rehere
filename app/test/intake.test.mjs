import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSourceDetails } from '../public/source-details.js';
import { createIntakeSession, detailsFromSourceInput, identify, intakeApi, partHints, pendingIds, planFrom, sha256Hex } from '../public/intake.js';

// A small in-memory server following the intake contract: plan, received
// parts by exact size and hash, compare-and-swap plans, terminal receipts.
function fakeServer() {
  const intakes = new Map();
  const calls = [];
  const faults = [];
  const fault = (name) => {
    const index = faults.findIndex((entry) => entry.name === name);
    if (index < 0) return null;
    return faults.splice(index, 1)[0].result;
  };
  const view = (intake) =>
    intake.status === 'open'
      ? structuredClone({ id: intake.id, status: 'open', revision: intake.revision, createdAt: 't', updatedAt: 't', text: intake.text, metadata: intake.metadata, parts: intake.parts })
      : { id: intake.id, status: intake.status, revision: intake.revision, draftId: intake.draftId ?? null };
  const ok = (body, status = 200) => ({ status, ok: true, body });
  const no = (status, error = 'refused') => ({ status, ok: false, body: { error } });
  const plan = (intake, body) => {
    const previous = new Map(intake.parts.map((part) => [part.partId, part]));
    intake.text = body.text;
    intake.metadata = structuredClone(body.metadata);
    intake.parts = body.parts.map((part) => {
      const kept = previous.get(part.partId);
      return kept && kept.size === part.size && kept.sha256 === part.sha256 ? { ...kept, hints: part.hints } : { ...structuredClone(part), status: 'missing', error: null, detectedType: null };
    });
  };
  const api = {
    calls,
    intakes,
    faults,
    async list() {
      calls.push(['list']);
      return ok([...intakes.values()].filter((intake) => intake.status === 'open').map(view));
    },
    async read(id) {
      calls.push(['read', id]);
      const intake = intakes.get(id);
      return intake ? ok(view(intake)) : no(404);
    },
    async create(body) {
      calls.push(['create', structuredClone(body)]);
      const injected = fault('create');
      if (injected?.before) return injected.result;
      const existing = intakes.get(body.requestId);
      if (existing) return JSON.stringify(existing.body) === JSON.stringify(body) ? ok(view(existing)) : no(409);
      const intake = { id: body.requestId, status: 'open', revision: 1, body: structuredClone(body), parts: [] };
      plan(intake, body);
      intakes.set(intake.id, intake);
      return injected ? injected.result : ok(view(intake), 201);
    },
    async plan(id, body) {
      calls.push(['plan', id, structuredClone(body)]);
      const intake = intakes.get(id);
      if (intake.status !== 'open') return ok(view(intake));
      if (intake.applied?.has(body.requestId)) return ok(view(intake));
      if (body.baseRevision !== intake.revision) return no(409);
      plan(intake, body);
      intake.revision += 1;
      (intake.applied ??= new Set()).add(body.requestId);
      return fault('plan') ?? ok(view(intake));
    },
    async part(id, partId, blob) {
      calls.push(['part', partId]);
      const intake = intakes.get(id);
      const part = intake.parts.find((entry) => entry.partId === partId);
      const injected = fault(`part:${partId}`);
      if (injected) return injected;
      if (blob.size === 0) Object.assign(part, { status: 'failed', error: 'empty' });
      else if ((await sha256Hex(blob)) !== part.sha256) Object.assign(part, { status: 'failed', error: 'hash' });
      else Object.assign(part, { status: 'received', error: null, detectedType: 'image/jpeg' });
      return part.status === 'received' ? ok({ partId, status: 'received', detectedType: 'image/jpeg' }) : no(400);
    },
    async commit(id, body) {
      calls.push(['commit', id, structuredClone(body)]);
      const intake = intakes.get(id);
      if (intake.status === 'committed') return intake.commitRequestId === body.requestId ? ok(view(intake)) : no(409);
      if (body.baseRevision !== intake.revision || intake.parts.some((part) => part.status !== 'received')) return no(409);
      Object.assign(intake, { status: 'committed', draftId: 'draft-1', commitRequestId: body.requestId });
      return fault('commit') ?? ok(view(intake), 201);
    },
    async discard(id, body) {
      calls.push(['discard', id, body]);
      const intake = intakes.get(id);
      if (intake.status === 'committed') return no(409);
      intake.status = 'discarded';
      return ok(view(intake));
    },
  };
  return api;
}

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

const ids = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`;
};

const photo = (bytes, name, details = createSourceDetails()) => ({ kind: 'photo', file: new File([bytes], name, { type: 'image/jpeg', lastModified: 1_700_000_000_000 }), details });

async function prepare(photos, text = 'A line\n', newId) {
  for (const item of photos) await identify(item, newId);
  const intended = planFrom({ text, photos, voice: null, textDetails: createSourceDetails() });
  const files = new Map(photos.filter((item) => item.file).map((item) => [item.partId, item.file]));
  return { intended, files };
}

const sent = (server, kind) => server.calls.filter((call) => call[0] === kind);

describe('resumable save', () => {
  it('sends nothing until save, then creates with the intake ID as request ID, sends each part once and commits', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(storage, 'p-owner'), newId });
    assert.equal(server.calls.length, 0, 'creating a session sends nothing');
    const photos = [photo('aaa', 'kitchen.jpg'), photo('bbb', 'shop.jpg')];
    const { intended, files } = await prepare(photos, 'Line one\n  \n', newId);
    const outcome = await session.save(intended, files);
    assert.deepEqual(outcome, { kind: 'saved', draftId: 'draft-1' });
    const [create] = sent(server, 'create');
    assert.equal(create[1].requestId, session.intakeId, 'the create request ID is the intake ID');
    assert.equal(create[1].text, 'Line one\n  \n', 'text is sent exactly');
    assert.deepEqual(sent(server, 'part').map((call) => call[1]), photos.map((item) => item.partId));
    assert.equal(sent(server, 'commit').length, 1);
    assert.equal(storage.map.size, 0, 'no pending ID remains after the final answer');
  });

  it('keeps received parts after a failure and retries only the failed one under the same IDs', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 413, ok: false, body: { error: 'too large' } } });
    const first = await session.save(intended, files);
    assert.equal(first.kind, 'incomplete');
    assert.equal(session.row(photos[0].partId).status, 'received');
    assert.equal(sent(server, 'commit').length, 0, 'no commit while a part is missing');
    server.calls.length = 0;
    const second = await session.save(intended, files);
    assert.equal(second.kind, 'saved');
    assert.deepEqual(sent(server, 'part').map((call) => call[1]), [photos[1].partId], 'the received photo is not sent again');
    assert.equal(sent(server, 'create').length + sent(server, 'plan').length, 0, 'the same intake and plan');
  });

  it('marks an empty file as failed on its own and the others still arrive', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('', 'empty.jpg'), photo('bbb', 'b.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    assert.equal(intended.parts[0].size, 0, 'a size-0 part is planned');
    const outcome = await session.save(intended, files);
    assert.equal(outcome.kind, 'incomplete');
    assert.deepEqual([session.row(photos[0].partId).status, session.row(photos[1].partId).status], ['failed', 'received']);
  });

  it('repeats an unclear create exactly and never starts a second intake', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: 'create', result: { result: { status: 0, ok: false, body: null } } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'create' });
    assert.equal(session.pending, 'create');
    assert.equal((await session.save(intended, files)).kind, 'saved');
    const creates = sent(server, 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[1][1], creates[0][1], 'the same request ID and body');
    assert.equal(server.intakes.size, 1);
  });

  it('asks about the same intake after an unclear commit before any retry, and never commits twice', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(storage, 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: 'commit', result: { status: 0, ok: false, body: null } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'commit' });
    const [entry] = JSON.parse(storage.map.get('rehere:intakes:p-owner'));
    assert.deepEqual(Object.keys(entry).sort(), ['commitRequestId', 'intakeId'], 'only opaque IDs are stored');
    assert.equal(entry.intakeId, session.intakeId);
    server.calls.length = 0;
    assert.deepEqual(await session.save(intended, files), { kind: 'saved', draftId: 'draft-1' });
    assert.equal(server.calls[0][0], 'read', 'the intake is read first');
    assert.equal(sent(server, 'commit').length, 0, 'the committed intake is not committed again');
  });

  it('records edits between attempts as a plan change, and never overwrites a newer plan', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    let { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    photos[0].details.permissions.place = true;
    photos.pop();
    ({ intended, files } = await prepare(photos, 'x', newId));
    server.calls.length = 0;
    assert.equal((await session.save(intended, files)).kind, 'saved');
    const [[, , body]] = sent(server, 'plan');
    assert.equal(body.baseRevision, 1);
    assert.deepEqual(body.parts.map((part) => part.partId), [photos[0].partId]);
    assert.equal(body.metadata.photos[0].permissions.place, true);
    assert.equal(sent(server, 'part').length, 0, 'the received photo is not re-sent');

    const other = fakeServer();
    const mine = createIntakeSession({ api: other, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const more = [photo('ccc', 'c.jpg'), photo('ddd', 'd.jpg')];
    ({ intended, files } = await prepare(more, 'x', newId));
    other.faults.push({ name: `part:${more[1].partId}`, result: { status: 0, ok: false, body: null } });
    await mine.save(intended, files);
    other.intakes.get(mine.intakeId).revision = 7; // changed in another window
    ({ intended, files } = await prepare(more, 'edited', newId));
    const outcome = await mine.save(intended, files);
    assert.equal(outcome.kind, 'conflict');
    assert.equal(other.intakes.get(mine.intakeId).text, 'x', 'nothing was overwritten');
  });

  it('accepts a plan replay only when the current state is the plan it meant', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    let { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    ({ intended, files } = await prepare(photos, 'edited', newId));
    server.faults.push({ name: 'plan', result: { status: 0, ok: false, body: null } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'plan' });
    assert.equal((await session.save(intended, files)).kind, 'saved');
    const plans = sent(server, 'plan');
    assert.deepEqual(plans[1][2], plans[0][2], 'the replay is the same request');
  });
});

describe('a success whose body cannot be read', () => {
  const unreadable = (status) => ({ status, ok: true, body: null });

  it('keeps an unreadable create pending and repeats it exactly', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(storage, 'p-owner'), newId });
    const { intended, files } = await prepare([photo('aaa', 'a.jpg')], 'x', newId);
    server.faults.push({ name: 'create', result: { result: unreadable(201) } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'create' });
    assert.equal(session.pending, 'create', 'still pending with its exact request');
    assert.equal(JSON.parse(storage.map.get('rehere:intakes:p-owner'))[0].intakeId, session.intakeId);
    assert.deepEqual(await session.save(intended, files), { kind: 'saved', draftId: 'draft-1' });
    const creates = sent(server, 'create');
    assert.deepEqual(creates[1][1], creates[0][1]);
    assert.equal(server.intakes.size, 1);
  });

  it('treats a rejection without a readable error as unknown and repeats the same create', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(storage, 'p-owner'), newId });
    const { intended, files } = await prepare([photo('aaa', 'a.jpg')], 'x', newId);
    // A proxy answers 400 with a body that is not JSON; the server never saw it.
    server.faults.push({ name: 'create', result: { before: true, result: { status: 400, ok: false, body: null } } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'create' });
    const intakeId = session.intakeId;
    assert.equal(session.pending, 'create');
    assert.equal(JSON.parse(storage.map.get('rehere:intakes:p-owner'))[0].intakeId, intakeId, 'the same ID is kept');
    assert.deepEqual(await session.save(intended, files), { kind: 'saved', draftId: 'draft-1' });
    const creates = sent(server, 'create');
    assert.deepEqual(creates[1][1], creates[0][1], 'no fresh create or new ID');
    assert.equal(session.intakeId ?? intakeId, intakeId);
  });

  it('treats only a readable error as a refusal', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const { intended, files } = await prepare([photo('aaa', 'a.jpg')], 'x', newId);
    server.faults.push({ name: 'create', result: { before: true, result: { status: 400, ok: false, body: { error: 'The source details could not be read.' } } } });
    assert.deepEqual(await session.save(intended, files), { kind: 'refused', message: 'The source details could not be read.' });
    assert.equal(session.pending, null);
  });

  it('keeps an unreadable plan change pending and accepts it only as its own plan', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    let { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    ({ intended, files } = await prepare(photos, 'edited', newId));
    server.faults.push({ name: 'plan', result: unreadable(200) });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'plan' });
    assert.equal(session.pending, 'plan');
    assert.equal((await session.save(intended, files)).kind, 'saved');
    const plans = sent(server, 'plan');
    assert.deepEqual(plans[1][2], plans[0][2], 'the same plan request');
  });

  it('never says Saved without a readable receipt, and finds the receipt by reading the same intake', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(storage, 'p-owner'), newId });
    const { intended, files } = await prepare([photo('aaa', 'a.jpg')], 'x', newId);
    server.faults.push({ name: 'commit', result: { status: 201, ok: true, body: { status: 'committed' } } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'commit' }, 'a receipt without an ID is not Saved');
    assert.ok(JSON.parse(storage.map.get('rehere:intakes:p-owner'))[0].commitRequestId, 'the commit request stays pending');
    // A read whose body cannot be understood settles nothing either.
    const read = server.read;
    server.read = async () => unreadable(200);
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'commit' });
    server.read = read;
    assert.deepEqual(await session.save(intended, files), { kind: 'saved', draftId: 'draft-1' });
    assert.equal(sent(server, 'commit').length, 1, 'committed once');
    assert.equal(storage.map.size, 0);
  });

  it('does not take an unreadable discard as discarded', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    server.discard = async () => unreadable(200);
    assert.deepEqual(await session.discard(), { kind: 'unknown', stage: 'discard' });
  });
});

describe('a plan race', () => {
  it('does not take another window’s plan for its own when only a granted use differs', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    let { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    // Another window wins revision 2 with the same text and files but sharing allowed.
    const theirs = structuredClone(intended);
    theirs.metadata.photos[0].permissions.share = true;
    await server.plan(session.intakeId, { requestId: 'other-window', baseRevision: 1, ...theirs });
    photos[0].details.permissions.place = true;
    ({ intended, files } = await prepare(photos, 'x', newId));
    server.calls.length = 0;
    const outcome = await session.save(intended, files);
    assert.equal(outcome.kind, 'conflict');
    assert.equal(sent(server, 'commit').length, 0, 'nothing is finalised');
    assert.equal(server.intakes.get(session.intakeId).metadata.photos[0].permissions.share, true, 'their plan is not overwritten');
  });
});

describe('content checks on the server', () => {
  it('keeps the other files when one fails its content check, and sends only the replacement', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'good.jpg'), photo('bbb', 'broken.jpg')];
    let { intended, files } = await prepare(photos, 'x', newId);
    const part = server.part;
    server.part = async (id, partId, blob) => {
      if (partId !== photos[1].partId) return part(id, partId, blob);
      server.calls.push(['part', partId]);
      Object.assign(server.intakes.get(id).parts.find((entry) => entry.partId === partId), { status: 'failed', error: 'content' });
      return { status: 400, ok: false, body: { error: 'Rehere could not read this photo.' } };
    };
    const first = await session.save(intended, files);
    assert.equal(first.kind, 'incomplete');
    assert.deepEqual([session.row(photos[0].partId).status, session.row(photos[1].partId).status], ['received', 'failed']);
    assert.equal(session.state.parts[1].error, 'content');
    server.part = part;
    photos[1] = photo('ccc', 'fixed.jpg');
    ({ intended, files } = await prepare(photos, 'x', newId));
    server.calls.length = 0;
    assert.equal((await session.save(intended, files)).kind, 'saved');
    assert.deepEqual(sent(server, 'part').map((call) => call[1]), [photos[1].partId], 'only the replacement is sent');
  });

  it('leaves a part unsent when the check is busy, keeps its message, and sends the same part on the next save', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[0].partId}`, result: { status: 503, ok: false, body: { error: 'Rehere is checking another file. Try again shortly.' } } });
    assert.equal((await session.save(intended, files)).kind, 'incomplete');
    assert.deepEqual(session.row(photos[0].partId), { status: 'missing', error: null, notice: 'Rehere is checking another file. Try again shortly.' });
    assert.equal(server.intakes.get(session.intakeId).parts[0].status, 'missing', 'nothing changed on the server');
    server.calls.length = 0;
    assert.equal((await session.save(intended, files)).kind, 'saved');
    assert.deepEqual(sent(server, 'part').map((call) => call[1]), [photos[0].partId], 'the same part, by an explicit save');
    assert.equal(session.row(photos[0].partId).notice, null);
  });
});

describe('a busy notice', () => {
  it('goes away once the server says the part arrived, even without a new send', async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg'), photo('bbb', 'b.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: `part:${photos[0].partId}`, result: { status: 503, ok: false, body: { error: 'Rehere is checking another file. Try again shortly.' } } });
    server.faults.push({ name: `part:${photos[1].partId}`, result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    assert.ok(session.row(photos[0].partId).notice);
    // The part arrived after all (an exact replay elsewhere); a re-read shows it.
    Object.assign(server.intakes.get(session.intakeId).parts[0], { status: 'received', error: null, detectedType: 'image/jpeg' });
    await session.save(intended, new Map([[photos[1].partId, files.get(photos[1].partId)]]));
    assert.equal(session.row(photos[0].partId).status, 'received');
    assert.equal(session.row(photos[0].partId).notice, null);
  });
});

describe('a newer plan from elsewhere is never adopted or committed', () => {
  // Another window replaces the plan with the same text and files, but with
  // sharing allowed for the first photo.
  const otherWindow = async (server, intakeId) => {
    const intake = server.intakes.get(intakeId);
    const theirs = structuredClone({ text: intake.text, parts: intake.parts.map(({ partId, kind, size, sha256, hints }) => ({ partId, kind, size, sha256, hints })), metadata: intake.metadata });
    theirs.metadata.photos[0].permissions.share = true;
    await server.plan(intakeId, { requestId: 'other-window', baseRevision: intake.revision, ...theirs });
  };
  const start = async () => {
    const server = fakeServer();
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const { intended, files } = await prepare([photo('aaa', 'a.jpg')], 'x', newId);
    return { server, session, intended, files };
  };
  const unchanged = (server, session) => {
    assert.equal(sent(server, 'commit').length, 0, 'nothing is committed');
    const intake = server.intakes.get(session.intakeId);
    assert.equal(intake.status, 'open');
    assert.equal(intake.metadata.photos[0].permissions.share, true, 'their plan is not overwritten');
  };

  it('stops when the plan changes while its files are being sent', async () => {
    const { server, session, intended, files } = await start();
    const part = server.part;
    server.part = async (...args) => {
      await otherWindow(server, args[0]);
      return part(...args);
    };
    const outcome = await session.save(intended, files);
    assert.equal(outcome.kind, 'conflict');
    assert.equal(outcome.state.revision, 2);
    assert.equal(session.state.revision, 1, 'the newer plan does not replace the intended one');
    unchanged(server, session);
    assert.equal((await session.save(intended, files)).kind, 'conflict', 'and stays stopped');
    unchanged(server, session);
  });

  it('stops when the plan changed before an unknown commit is looked up', async () => {
    const { server, session, intended, files } = await start();
    const commit = server.commit;
    server.commit = async (id, body) => {
      server.commit = commit;
      server.calls.push(['commit', id, body]);
      return { status: 0, ok: false, body: null }; // lost before the server committed
    };
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'commit' });
    await otherWindow(server, session.intakeId);
    server.calls.length = 0;
    const outcome = await session.save(intended, files);
    assert.equal(outcome.kind, 'conflict');
    unchanged(server, session);
  });

  it('stops when a repeated create finds a newer plan already there', async () => {
    const { server, session, intended, files } = await start();
    server.faults.push({ name: 'create', result: { result: { status: 0, ok: false, body: null } } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'create' });
    await otherWindow(server, session.intakeId);
    server.calls.length = 0;
    const outcome = await session.save(intended, files);
    assert.equal(outcome.kind, 'conflict');
    assert.equal(sent(server, 'plan').length + sent(server, 'part').length, 0, 'no overwrite and no upload');
    unchanged(server, session);
  });

  it('still settles from a terminal receipt', async () => {
    const { server, session, intended, files } = await start();
    server.faults.push({ name: 'commit', result: { status: 0, ok: false, body: null } });
    assert.deepEqual(await session.save(intended, files), { kind: 'unknown', stage: 'commit' });
    assert.deepEqual(await session.save(intended, files), { kind: 'saved', draftId: 'draft-1' });
  });
});

describe('server normalisation', () => {
  it('does not record a needless change when the server returns the plan in its own key order', async () => {
    const server = fakeServer();
    const read = server.read;
    // The server's copy of the metadata comes back with keys in another order.
    const reorder = (value) => (Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorder(value[key])])) : value);
    server.read = async (id) => {
      const result = await read(id);
      if (result.body?.metadata) result.body.metadata = reorder(result.body.metadata);
      return result;
    };
    const newId = ids();
    const session = createIntakeSession({ api: server, ids: pendingIds(memoryStorage(), 'p-owner'), newId });
    const photos = [photo('aaa', 'a.jpg')];
    const { intended, files } = await prepare(photos, 'x', newId);
    server.faults.push({ name: 'commit', result: { status: 0, ok: false, body: null } });
    await session.save(intended, files);
    server.calls.length = 0;
    assert.equal((await session.save(intended, files)).kind, 'saved');
    assert.equal(sent(server, 'plan').length, 0);
  });
});

describe('identity, plan and storage', () => {
  it('keeps a part ID for the exact original and gives a changed file a new one', async () => {
    const newId = ids();
    const item = photo('aaa', 'a.jpg');
    await identify(item, newId);
    const first = item.partId;
    await identify(item, newId);
    assert.equal(item.partId, first, 'unchanged file, same ID');
    item.file = new File(['aaa'], 'renamed.jpg', { type: 'image/jpeg' });
    await identify(item, newId);
    assert.equal(item.partId, first, 'exact same bytes, same ID');
    item.file = new File(['zzz'], 'a.jpg', { type: 'image/jpeg' });
    await identify(item, newId);
    assert.notEqual(item.partId, first, 'changed bytes, new ID');
  });

  it('sends a restored source back exactly as the server holds it, and keeps its file dates when edited', () => {
    // Strings with outer spaces, as another client may have submitted them.
    const input = {
      provider: '  Neighbour ',
      origin: { kind: 'public', reference: ' archive box 3 ' },
      permissions: { place: true, model: false, share: true },
      dates: { capturedOn: '1998-07-01', fileCreatedAt: '2020-01-01T00:00:00.000Z', fileModifiedAt: '2021-02-03T04:05:06.000Z', estimatedPeriod: ' summer ' },
    };
    const restored = { kind: 'photo', file: new File(['aaa'], 'a.jpg', { lastModified: 5 }), details: detailsFromSourceInput(input), keptInput: input, partId: 'p', sha256: 's', size: 3, hints: { name: 'a.jpg', type: 'image/jpeg', lastModified: 5 } };
    const plan = () => planFrom({ text: 't', photos: [restored], voice: null, textDetails: detailsFromSourceInput(input), textKeptInput: input }).metadata;
    assert.deepEqual(plan().photos[0], input, 'unchanged: every string and date exactly as held, not from the restored file');
    assert.deepEqual(plan().text, input);
    restored.details.permissions.model = true;
    const edited = plan().photos[0];
    assert.equal(edited.permissions.model, true);
    assert.deepEqual([edited.dates.fileCreatedAt, edited.dates.fileModifiedAt, edited.dates.capturedOn], ['2020-01-01T00:00:00.000Z', '2021-02-03T04:05:06.000Z', '1998-07-01'], 'edited: the recorded file dates stay');
  });

  it('trims hints to the display limits and never invents a date', () => {
    const hints = partHints({ name: `${'n'.repeat(300)}\u0007`, type: 'image/jp\u00e9g', lastModified: -1 });
    assert.equal(hints.name.length, 255);
    assert.equal(hints.type, '');
    assert.equal(hints.lastModified, null);
  });

  it('stores only opaque IDs per owner and survives unavailable storage', () => {
    const storage = memoryStorage();
    const store = pendingIds(storage, 'p-owner');
    store.add('i-1');
    store.setCommit('i-1', 'c-1');
    assert.deepEqual(JSON.parse(storage.map.get('rehere:intakes:p-owner')), [{ intakeId: 'i-1', commitRequestId: 'c-1' }]);
    assert.deepEqual(pendingIds(storage, 'someone-else').read(), [], 'another owner sees nothing');
    store.remove('i-1');
    assert.equal(storage.map.size, 0);
    const broken = pendingIds({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem() {} }, 'p');
    broken.add('x');
    assert.deepEqual(broken.read(), []);
  });

  it('uses the intake routes with raw bytes for parts', async () => {
    const seen = [];
    const api = intakeApi(async (url, options) => {
      seen.push([url, options.method ?? 'GET', options.headers?.['content-type'] ?? null]);
      return { status: 200, ok: true, json: async () => ({}) };
    });
    await api.create({ requestId: 'i' });
    await api.part('i', 'p', new Blob(['x']));
    await api.commit('i', {});
    assert.deepEqual(seen, [
      ['/api/intakes', 'POST', 'application/json'],
      ['/api/intakes/i/parts/p', 'POST', 'application/octet-stream'],
      ['/api/intakes/i/commit', 'POST', 'application/json'],
    ]);
  });
});
