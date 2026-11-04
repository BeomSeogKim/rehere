import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { BudgetLedger, createMetaModel } from '../meta-model.mjs';
import { client, enrolledContributor, jpeg, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const limits = { totalUsd: 5.312512, perRequestUsd: 1.328128, maxRequests: 4 };
const read = async (response, status = 200) => { const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const poll = async (owner, route) => {
  for (let i = 0; i < 300; i++) {
    const result = await read(await owner.request(route));
    if (!['queued', 'processing'].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic request did not finish.');
};

// Real HTTP, source admission and ledger writes; synthetic media/transport.
// The fake fetch never opens a provider connection or calls COUNT.
async function fixture(t, { reserveGate = null, responseGate = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-count-free-http-'));
  const ledgerFile = path.join(dataDir, 'model-budget.json');
  await writeFile(ledgerFile, '{"entries":[]}', { flag: 'wx', mode: 0o600 });
  const book = new BudgetLedger({ file: ledgerFile, limits }), calls = [];
  if (reserveGate) {
    const write = book.write.bind(book);
    book.write = async (state) => { await write(state); reserveGate.reached.resolve(); await reserveGate.release.promise; };
  }
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body), context = JSON.parse(body.input[0].content[0].text);
    const [entry] = (await book.read()).entries;
    assert.equal(entry.reservedUsd, 1.328128); assert.equal(entry.requestSha256, sha(init.body));
    calls.push({ url, body, requestSha256: sha(init.body) });
    if (responseGate) { responseGate.reached.resolve(); await responseGate.release.promise; }
    const plan = { action: 'rotate', targetId: 'selected-foreground', sourceId: context.sourceId, parentVariantId: context.parentVariantId, baseEraRevision: context.baseEraRevision,
      delta: null, yawDelta: 0.1, anchor: null, question: null, reason: 'Synthetic bounded response.' };
    return Response.json({ id: 'synthetic-response', model: 'muse-spark-1.3', status: 'completed', usage: { input_tokens: 1000, output_tokens: 100 },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] });
  };
  const proposalModel = createMetaModel({ apiKey: 'synthetic-key', ledger: book, countFree: true, fetch });
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, proposalModel, prepareModelImage: async () => jpeg(40, 30) });
  t.after(async () => { reserveGate?.release.resolve(); responseGate?.release.resolve(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = client(app.base, app.cookie), form = new FormData();
  const source = { provider: 'Synthetic source', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true },
    dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png'); form.append('metadata', JSON.stringify({ photos: [source] }));
  const draft = await read(await owner.request('/api/drafts', { method: 'POST', body: form }), 201);
  const job = await read(await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] }), 202);
  const route = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  assert.equal((await poll(owner, route)).status, 'ready');
  const { session } = await enrolledContributor(owner, app.base, draft.id, 'Synthetic contributor');
  const contribution = await read(await session.post(`${route}/contributions`, { requestId: randomUUID(), text: 'Synthetic retained turn memory.', permissions: { place: true, model: true, share: true }, periodClaim: '' }));
  const parent = (await read(await owner.request(`${route}/collaboration`))).variants[0];
  const context = await read(await owner.request(`${route}/variants/${parent.id}/revision-context`));
  const statementSource = context.statementSources.find((item) => item.statementSource.contributionId === contribution.id).statementSource;
  const proposalRoute = `${route}/variants/${parent.id}/proposals`;
  const body = { requestId: randomUUID(), baseEraRevision: parent.eraRevision, targetId: 'selected-foreground', timeMode: 'unknown', statementSource, sourceReviewed: true, consent: true };
  const file = path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json');
  return { owner, app, draft, route, session, contribution, parent, proposalRoute, body, book, calls, file };
}

it('does not resend an exact owner request; explicit new attempts reserve fully and stop at one retry', async (t) => {
  const f = await fixture(t);
  const created = await read(await f.owner.post(f.proposalRoute, f.body), 202);
  const ready = await poll(f.owner, `${f.proposalRoute}/${created.id}`);
  assert.equal(ready.status, 'ready'); assert.deepEqual(ready.statement.source, f.body.statementSource);
  const replay = await read(await f.owner.post(f.proposalRoute, f.body)); assert.equal(replay.id, created.id);
  assert.equal(f.calls.length, 1); assert.equal((await f.book.read()).entries.length, 1);
  const retry = await read(await f.owner.post(f.proposalRoute, { ...f.body, requestId: randomUUID() }), 202);
  assert.equal((await poll(f.owner, `${f.proposalRoute}/${retry.id}`)).status, 'ready');
  const stopped = await read(await f.owner.post(f.proposalRoute, { ...f.body, requestId: randomUUID() }), 202);
  assert.equal((await poll(f.owner, `${f.proposalRoute}/${stopped.id}`)).status, 'failed');
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every((item) => item.url === 'https://api.meta.ai/v1/responses'));
  assert.equal((await f.book.totals()).chargedUsd, 2 * 1.328128);
  assert.equal((JSON.parse(await readFile(f.file))).collaboration.variants.length, 1, 'planning alone creates no child');
});

for (const restriction of ['photo-model', 'photo-place', 'withdraw', 'parent-time', 'source-bytes']) {
  it(`rechecks ${restriction} under the scene mutex after reservation and before any outbound`, async (t) => {
    const reserveGate = { reached: gate(), release: gate() }, f = await fixture(t, { reserveGate });
    const created = await read(await f.owner.post(f.proposalRoute, f.body), 202);
    await reserveGate.reached.promise;
    if (restriction.startsWith('photo-')) {
      const route = `/api/drafts/${f.draft.id}/sources/${f.draft.photos[0].sourceId}/policy`;
      const current = await read(await f.owner.request(route));
      await read(await f.owner.post(route, { requestId: randomUUID(), baseRevision: current.revision, permissions: { place: restriction !== 'photo-place', model: false, share: true }, stopUse: false }));
    } else if (restriction === 'withdraw') {
      await read(await f.session.post(`${f.route}/contributions/${f.contribution.id}/withdraw`, { requestId: randomUUID() }));
    } else if (restriction === 'parent-time') {
      await read(await f.owner.post(`${f.route}/variants/${f.parent.id}/era`, { requestId: randomUUID(), baseRevision: 0, kind: 'unknown', label: '', start: null, end: null,
        statement: '', relation: null, relativeToVariantId: null, confirmed: true }));
    } else {
      const manifest = JSON.parse(await readFile(f.file)); manifest.collaboration.contributions[0].text += ' changed';
      await writeFile(`${f.file}.synthetic`, JSON.stringify(manifest)); await rename(`${f.file}.synthetic`, f.file);
    }
    reserveGate.release.resolve();
    const result = await poll(f.owner, `${f.proposalRoute}/${created.id}`);
    assert.notEqual(result.status, 'ready'); assert.equal(f.calls.length, 0);
    assert.equal((JSON.parse(await readFile(f.file))).collaboration.variants.length, 1);
  });
}

it('keeps a late response inapplicable after withdrawal and retains its full reservation', async (t) => {
  const responseGate = { reached: gate(), release: gate() }, f = await fixture(t, { responseGate });
  const created = await read(await f.owner.post(f.proposalRoute, f.body), 202);
  await responseGate.reached.promise;
  await read(await f.session.post(`${f.route}/contributions/${f.contribution.id}/withdraw`, { requestId: randomUUID() }));
  responseGate.release.resolve();
  const result = await poll(f.owner, `${f.proposalRoute}/${created.id}`);
  assert.equal(result.redacted, true); assert.equal(result.statement.text, null); assert.equal(result.statement.attribution, null);
  assert.equal(result.result, null); assert.equal(result.candidate, null);
  assert.equal((await f.book.totals()).chargedUsd, 1.328128);
});
