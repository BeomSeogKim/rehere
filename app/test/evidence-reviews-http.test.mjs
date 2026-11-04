import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BudgetLedger, createMetaSender } from '../meta-model.mjs';
import { EVIDENCE_MESSAGES, checkEvidence, evidenceModelFromEnv, evidenceRequestBody, validCrop } from '../evidence-reviews.mjs';
import { client, png, startOwnerServer } from './auth-helper.mjs';

// Synthetic photos, a synthetic note and a fake provider. Nothing here
// reaches the network.
const NOTE = 'I think the room had tall windows along the far wall and a flat ceiling.';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const grant = (permissions = {}, provider = 'Synthetic provider') => ({
  provider, origin: { kind: 'public', reference: '' },
  permissions: { place: true, model: true, share: false, ...permissions },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

const generated = (answer, extra = {}) => ({
  id: 'resp_fixture', model: 'muse-spark-1.3', status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] }],
  usage: { input_tokens: 2000, output_tokens: 120 }, ...extra,
});
const reply = (json, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

// The production sender with a fake provider. `generate(body)` answers the
// generation request; it may wait or throw.
async function fixtureModel(generate, maxRequests = 4) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-evidence-ledger-'));
  tempDirs.push(dir);
  const ledger = new BudgetLedger({ file: path.join(dir, 'budget.json'), limits: { totalUsd: 0.2, perRequestUsd: 0.05, maxRequests } });
  const calls = [];
  const model = createMetaSender({
    apiKey: 'fixture-key', ledger,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.endsWith('/responses/input_tokens')) return reply({ input_tokens: 2000 });
      return generate(body);
    },
  });
  return { model, calls, ledger, generations: () => calls.filter((call) => call.url.endsWith('/responses')) };
}

function imagePreparer() {
  const prepare = async ({ imagePath, box }) => {
    prepare.calls.push({ imagePath, box });
    return JPEG;
  };
  prepare.calls = [];
  return prepare;
}

async function workspace({ model = null, dataDir } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-evidence-'));
    tempDirs.push(dataDir);
  }
  const prepareModelImage = imagePreparer();
  const app = await startOwnerServer({ dataDir, evidenceModel: model?.model ?? null, prepareModelImage });
  return { app, dataDir, prepareModelImage, owner: client(app.base, app.cookie) };
}

// One memory: the note and three photos; the third never allows model use.
async function memory(owner, { note = NOTE, noteGrant = grant({}, 'Demonstration operator') } = {}) {
  const form = new FormData();
  form.append('text', note);
  for (const fill of [1, 2, 3]) form.append('photos', new Blob([png(40, 30, fill)]), `photo-${fill}.png`);
  form.append('metadata', JSON.stringify({ photos: [grant({}, 'Archive photo A'), grant({}, 'Archive photo B'), grant({ model: false }, 'Owner photo C')], text: noteGrant }));
  const response = await owner.request('/api/drafts', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const draft = await response.json();
  const photoIds = draft.photos.map((photo) => photo.sourceId);
  return { draft, photoIds };
}

const route = (draftId) => `/api/drafts/${draftId}/evidence-reviews`;
const ask = (owner, draftId, sourceIds, extra = {}) => owner.post(route(draftId), { requestId: randomUUID(), consent: true, sourceIds, ...extra });
const valid = (photoIds) => ({
  findings: [
    { part: 'tall windows along the far wall', verdict: 'supports', sourceId: photoIds[0], crop: [0.1, 0.2, 0.6, 0.7], observation: 'Tall windows fill the far wall.' },
    { part: 'a flat ceiling', verdict: 'conflicts', sourceId: photoIds[0], crop: [0, 0, 1, 0.25], observation: 'Exposed beams cross the ceiling.' },
  ],
  uncertainty: 'The photos cannot show what the windows looked out at.',
});

async function restrict(owner, draftId, sourceId, permissions) {
  const policy = await owner.json(`/api/drafts/${draftId}/sources/${sourceId}/policy`);
  const response = await owner.post(`/api/drafts/${draftId}/sources/${sourceId}/policy`, { requestId: randomUUID(), baseRevision: policy.revision, permissions, stopUse: false });
  assert.equal(response.status, 200);
}

describe('owner evidence reviews over HTTP', () => {
  it('sends the note and only the chosen allowed photos, keeps a checked answer and the owner decision across a restart', async () => {
    let photoIds;
    const fixture = await fixtureModel(async () => reply(generated(valid(photoIds))));
    const { app, owner, dataDir, prepareModelImage } = await workspace({ model: fixture });
    const made = await memory(owner);
    photoIds = made.photoIds;
    const draftId = made.draft.id;

    const listed = await owner.json(route(draftId));
    assert.equal(listed.enabled, true);
    assert.deepEqual(listed.note, { available: true, modelAllowed: true, tooLong: false });
    assert.deepEqual(listed.photos.map((item) => item.modelAllowed), [true, true, false]);

    const response = await ask(owner, draftId, photoIds.slice(0, 2));
    assert.equal(response.status, 201);
    const { review, replayed } = await response.json();
    assert.equal(replayed, false);
    assert.equal(review.status, 'answered');
    assert.deepEqual(review.result, valid(photoIds));
    assert.deepEqual(review.call, { model: 'muse-spark-1.3', responseId: 'resp_fixture', usage: { inputTokens: 2000, outputTokens: 120, estimatedUsd: 2000 * 1.25e-6 + 120 * 4.25e-6 }, mode: 'live', latencyMs: review.call.latencyMs });
    assert.equal(review.decision, null);

    // One count and one generation, with the same input; two images; nothing
    // about providers, names or dates.
    assert.equal(fixture.calls.length, 2);
    const [count, generation] = fixture.calls;
    assert.deepEqual(count.body.input, generation.body.input);
    assert.equal(generation.body.store, false);
    const content = generation.body.input[0].content;
    assert.equal(content.filter((part) => part.type === 'input_image').length, 2);
    const context = JSON.parse(content[0].text);
    assert.deepEqual(context, { note: NOTE, photos: [{ photo: 1, sourceId: photoIds[0] }, { photo: 2, sourceId: photoIds[1] }] });
    const sent = JSON.stringify(generation.body);
    for (const absent of ['Archive photo', 'Owner photo', 'Demonstration operator', photoIds[2], 'photo-1.png']) assert.equal(sent.includes(absent), false, absent);
    assert.deepEqual(generation.body.text.format.schema.properties.findings.items.properties.sourceId.anyOf[0].enum, photoIds.slice(0, 2));
    assert.deepEqual(prepareModelImage.calls.map((call) => call.box), [[0, 0, 1, 1], [0, 0, 1, 1]]);
    const { entries } = await fixture.ledger.read();
    assert.deepEqual(entries.map((entry) => entry.state), ['settled']);

    // The owner decides once; the same choice repeats, another is refused.
    const route2 = `${route(draftId)}/${review.id}/decision`;
    const accepted = await owner.post(route2, { choice: 'accepted' });
    assert.equal(accepted.status, 200);
    const decided = (await accepted.json()).review;
    assert.equal(decided.decision.choice, 'accepted');
    assert.equal(decided.decision.by.displayName, 'Synthetic owner');
    assert.equal((await owner.post(route2, { choice: 'accepted' })).status, 200);
    assert.equal((await owner.post(route2, { choice: 'dismissed' })).status, 409);
    assert.equal((await owner.post(route2, { choice: 'maybe' })).status, 400);

    // A visitor without the owner session sees nothing.
    assert.equal((await client(app.base).request(route(draftId))).status, 401);
    // The memory itself does not carry the reviews.
    assert.equal(JSON.stringify(await owner.json(`/api/drafts/${draftId}`)).includes('evidence'), false);

    await app.close();
    const reopened = await workspace({ dataDir });
    const after = await reopened.owner.json(route(draftId));
    assert.equal(after.enabled, false);
    assert.equal(after.reviews.length, 1);
    assert.equal(after.reviews[0].status, 'answered');
    assert.equal(after.reviews[0].decision.choice, 'accepted');
    assert.deepEqual(after.reviews[0].result, valid(photoIds));
    assert.equal(after.reviews[0].call.responseId, 'resp_fixture');
    await reopened.app.close();
  });

  it('answers a repeated request from its record without sending again', async () => {
    let photoIds;
    const fixture = await fixtureModel(async () => reply(generated(valid(photoIds))));
    const { app, owner } = await workspace({ model: fixture });
    const made = await memory(owner);
    photoIds = made.photoIds;
    const body = { requestId: randomUUID(), consent: true, sourceIds: [photoIds[0]] };
    assert.equal((await owner.post(route(made.draft.id), body)).status, 201);
    const again = await owner.post(route(made.draft.id), body);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).replayed, true);
    assert.equal((await owner.post(route(made.draft.id), { ...body, sourceIds: [photoIds[1]] })).status, 409);
    assert.equal(fixture.generations().length, 1);
    await app.close();
  });

  it('refuses before sending: no consent, no setup, a photo or note without model use, foreign or repeated photos', async () => {
    const fixture = await fixtureModel(async () => { throw new Error('must not generate'); });
    const { app, owner } = await workspace({ model: fixture });
    const { draft, photoIds } = await memory(owner);
    const other = await memory(owner);
    assert.equal((await ask(owner, draft.id, [photoIds[0]], { consent: false })).status, 403);
    assert.equal((await ask(owner, draft.id, [photoIds[2]])).status, 403);
    assert.equal((await ask(owner, draft.id, [other.photoIds[0]])).status, 400);
    assert.equal((await ask(owner, draft.id, [randomUUID()])).status, 400);
    assert.equal((await ask(owner, draft.id, [photoIds[0], photoIds[0]])).status, 400);
    assert.equal((await ask(owner, draft.id, [])).status, 400);
    assert.equal((await owner.post(route(draft.id), { requestId: randomUUID(), consent: true, sourceIds: [photoIds[0]], extra: 1 })).status, 400);
    const noModelNote = await memory(owner, { noteGrant: grant({ model: false }) });
    const refused = await ask(owner, noModelNote.draft.id, [noModelNote.photoIds[0]]);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, EVIDENCE_MESSAGES.noteModel);
    await restrict(owner, draft.id, photoIds[1], { place: true, model: false, share: false });
    assert.equal((await ask(owner, draft.id, [photoIds[0], photoIds[1]])).status, 403);
    assert.equal(fixture.calls.length, 0);
    await app.close();

    const off = await workspace();
    const plain = await memory(off.owner);
    const notSetUp = await ask(off.owner, plain.draft.id, [plain.photoIds[0]]);
    assert.equal(notSetUp.status, 503);
    assert.equal((await off.owner.json(route(plain.draft.id))).enabled, false);
    await off.app.close();
  });

  it('rejects an answer that names an unsent photo, a region outside the photo or words not in the note', async () => {
    let photoIds;
    let answer;
    const fixture = await fixtureModel(async () => reply(generated(answer(photoIds))), 10);
    const { app, owner, dataDir } = await workspace({ model: fixture });
    const made = await memory(owner);
    photoIds = made.photoIds;
    const cases = [
      ['source', (ids) => ({ ...valid(ids), findings: [{ ...valid(ids).findings[0], sourceId: ids[1] }] })],
      ['source', (ids) => ({ ...valid(ids), findings: [{ ...valid(ids).findings[0], sourceId: ids[2] }] })],
      ['crop', (ids) => ({ ...valid(ids), findings: [{ ...valid(ids).findings[0], crop: [0.6, 0.2, 0.1, 0.7] }] })],
      ['crop', (ids) => ({ ...valid(ids), findings: [{ ...valid(ids).findings[0], crop: [0.1, 0.2, 1.4, 0.7] }] })],
      ['part_not_in_note', (ids) => ({ ...valid(ids), findings: [{ ...valid(ids).findings[0], part: 'tall windows looking out over the canyon' }] })],
      ['unlocated', (ids) => ({ ...valid(ids), findings: [{ ...valid(ids).findings[0], sourceId: null, crop: null }] })],
    ];
    for (const [code, make] of cases) {
      answer = make;
      const response = await ask(owner, made.draft.id, [photoIds[0]]);
      assert.equal(response.status, 201);
      const { review } = await response.json();
      assert.equal(review.status, 'failed', code);
      assert.equal(review.result, null);
      assert.equal(review.error, EVIDENCE_MESSAGES.invalid);
      assert.equal(review.call.responseId, 'resp_fixture');
    }
    const stored = JSON.parse(await readFile(path.join(dataDir, 'drafts', made.draft.id, 'evidence-reviews.json'), 'utf8'));
    assert.deepEqual(stored.reviews.map((item) => item.rejected), cases.map(([code]) => code));
    assert.ok(stored.reviews.every((item) => item.result === null));
    // A rejected answer is not offered for a decision.
    assert.equal((await owner.post(`${route(made.draft.id)}/${stored.reviews[0].id}/decision`, { choice: 'accepted' })).status, 409);
    await app.close();
  });

  it('stops the check and never generates when model use is withdrawn during the count', async () => {
    const gate = deferred();
    const counting = deferred();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-evidence-ledger-'));
    tempDirs.push(dir);
    const ledger = new BudgetLedger({ file: path.join(dir, 'budget.json') });
    const urls = [];
    const model = createMetaSender({
      apiKey: 'fixture-key', ledger,
      fetch: async (url) => {
        urls.push(url);
        counting.resolve();
        await gate.promise;
        return reply({ input_tokens: 2000 });
      },
    });
    const { app, owner } = await workspace({ model: { model } });
    const { draft, photoIds } = await memory(owner);
    const pending = ask(owner, draft.id, [photoIds[0]]);
    await counting.promise;
    await restrict(owner, draft.id, photoIds[0], { place: true, model: false, share: false });
    gate.resolve();
    const { review } = await (await pending).json();
    assert.equal(review.status, 'failed');
    assert.equal(review.error, EVIDENCE_MESSAGES.restricted);
    assert.deepEqual(urls.map((url) => new URL(url).pathname), ['/v1/responses/input_tokens']);
    // The restriction also stopped the running check, so nothing was reserved.
    assert.deepEqual((await ledger.read()).entries, []);
    await app.close();
  });

  it('keeps the reservation and never retries when the outcome is unknown or the provider fails', async () => {
    for (const generate of [async () => { throw new TypeError('network'); }, async () => reply({ error: 'busy' }, 500)]) {
      const fixture = await fixtureModel(generate);
      const { app, owner } = await workspace({ model: fixture });
      const { draft, photoIds } = await memory(owner);
      const { review } = await (await ask(owner, draft.id, [photoIds[0]])).json();
      assert.equal(review.status, 'failed');
      assert.equal(review.error, EVIDENCE_MESSAGES.provider);
      assert.equal(review.call?.usage ?? null, null);
      assert.equal(fixture.generations().length, 1);
      const { entries } = await fixture.ledger.read();
      assert.deepEqual(entries.map((entry) => entry.state), ['reserved']);
      await app.close();
    }
  });

  it('withholds excerpts once a material is stopped and lets the place be deleted with its reviews', async () => {
    let photoIds;
    const fixture = await fixtureModel(async () => reply(generated(valid(photoIds))));
    const { app, owner, dataDir } = await workspace({ model: fixture });
    const made = await memory(owner);
    photoIds = made.photoIds;
    await ask(owner, made.draft.id, [photoIds[0]]);
    const policy = await owner.json(`/api/drafts/${made.draft.id}/sources/${photoIds[0]}/policy`);
    await owner.post(`/api/drafts/${made.draft.id}/sources/${photoIds[0]}/policy`, { requestId: randomUUID(), baseRevision: policy.revision, permissions: { place: false, model: false, share: false }, stopUse: true });
    const [hidden] = (await owner.json(route(made.draft.id))).reviews;
    assert.equal(hidden.available, false);
    assert.equal(hidden.result, null);
    assert.equal((await owner.post(`${route(made.draft.id)}/${hidden.id}/decision`, { choice: 'accepted' })).status, 409);

    const { impactSha256 } = await owner.json(`/api/drafts/${made.draft.id}/deletion`);
    const removed = await owner.post(`/api/drafts/${made.draft.id}/delete`, { requestId: randomUUID(), impactSha256, confirmDeletion: true });
    assert.equal((await removed.json()).state, 'complete');
    await assert.rejects(stat(path.join(dataDir, 'drafts', made.draft.id)), { code: 'ENOENT' });
    assert.equal((await owner.request(route(made.draft.id))).status, 404);
    await app.close();
  });
});

describe('evidence answer checks', () => {
  const ids = [randomUUID(), randomUUID()];
  const note = 'The dining room had large windows looking out over the canyon.';
  const finding = { part: 'large windows', verdict: 'supports', sourceId: ids[0], crop: [0.1, 0.1, 0.5, 0.5], observation: 'Large windows are visible.' };
  const check = (findings, uncertainty = 'The view is not visible.') => checkEvidence({ findings, uncertainty }, { note, sourceIds: ids });

  it('accepts verbatim parts, located findings and unlocated not-visible ones', () => {
    const notVisible = { part: 'looking out over the canyon', verdict: 'not_visible', sourceId: null, crop: null, observation: 'The view outside is not shown.' };
    const near = { ...notVisible, sourceId: ids[1], crop: [0, 0, 0.2, 0.2], part: 'The dining room' };
    assert.deepEqual(check([finding, notVisible, near]).result.findings, [finding, notVisible, near]);
  });

  it('rejects every malformed or widened answer', () => {
    assert.equal(check([]).code, 'findings_count');
    assert.equal(check([finding, { ...finding, part: 'windows' }, { ...finding, part: 'canyon' }, { ...finding, part: 'room' }]).code, 'findings_count');
    assert.equal(check([finding, finding]).code, 'part_not_in_note');
    assert.equal(check([{ ...finding, part: 'large windows over the canyon' }]).code, 'part_not_in_note');
    assert.equal(check([{ ...finding, part: '   ' }]).code, 'part_not_in_note');
    assert.equal(check([{ ...finding, verdict: 'proves' }]).code, 'verdict');
    assert.equal(check([{ ...finding, sourceId: randomUUID() }]).code, 'source');
    assert.equal(check([{ ...finding, sourceId: null }]).code, 'source');
    assert.equal(check([{ ...finding, crop: null }]).code, 'crop');
    assert.equal(check([{ ...finding, sourceId: null, crop: null }]).code, 'unlocated');
    assert.equal(check([{ ...finding, observation: '' }]).code, 'observation');
    assert.equal(check([{ ...finding, observation: 'x'.repeat(301) }]).code, 'observation');
    assert.equal(check([finding], '').code, 'uncertainty');
    assert.equal(check([{ ...finding, extra: 1 }]).code, 'finding_shape');
    assert.equal(checkEvidence({ findings: [finding] }, { note, sourceIds: ids }).code, 'shape');
  });

  it('accepts only finite regions inside the photo with a visible size', () => {
    assert.equal(validCrop([0, 0, 1, 1]), true);
    for (const crop of [[NaN, 0, 1, 1], [0, 0, Infinity, 1], [-0.1, 0, 1, 1], [0, 0, 1.01, 1], [0.5, 0, 0.4, 1], [0, 0, 0.01, 1], [0, 0, 1], ['0', 0, 1, 1], null]) {
      assert.equal(validCrop(crop), false, JSON.stringify(crop));
    }
  });

  it('builds one request with only ids, images and the note', () => {
    const body = evidenceRequestBody({ note, images: ids.map((sourceId) => ({ sourceId, image: JPEG })) });
    assert.equal(body.model, 'muse-spark-1.3');
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(JSON.parse(body.input[0].content[0].text), { note, photos: ids.map((sourceId, index) => ({ photo: index + 1, sourceId })) });
    assert.throws(() => evidenceRequestBody({ note: '', images: [{ sourceId: ids[0], image: JPEG }] }));
    assert.throws(() => evidenceRequestBody({ note, images: [] }));
    assert.throws(() => evidenceRequestBody({ note, images: [{ sourceId: ids[0], image: JPEG }, { sourceId: ids[0], image: JPEG }] }));
  });

  it('is off without both the key and its own flag, and limits can only be lowered', () => {
    assert.equal(evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { MODEL_API_KEY: 'k' } }), null);
    assert.equal(evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1' } }), null);
    assert.equal(typeof evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_TOTAL_USD: '0.05' } }), 'function');
    assert.throws(() => evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_TOTAL_USD: '5' } }));
    assert.equal(typeof evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_MAX_REQUESTS: '1' } }), 'function');
    assert.equal(typeof evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_MAX_REQUESTS: '' } }), 'function');
    assert.throws(() => evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_MAX_REQUESTS: '1.5' } }), /must be a whole number of requests/);
    assert.throws(() => evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_MAX_REQUESTS: '0' } }), /can only be lowered/);
    assert.throws(() => evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_MAX_REQUESTS: '-2' } }), /can only be lowered/);
    assert.throws(() => evidenceModelFromEnv({ ledgerFile: '/nonexistent', env: { REHERE_EVIDENCE_LIVE: '1', MODEL_API_KEY: 'k', REHERE_EVIDENCE_MAX_REQUESTS: '1000000' } }), /can only be lowered/);
  });
});
