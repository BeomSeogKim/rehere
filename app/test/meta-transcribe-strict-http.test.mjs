import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { pcmWav } from '../audio-derivative.mjs';
import { BudgetLedger } from '../meta-model.mjs';
import { StrictTranscribeLedger, createMetaTranscriber, metaTranscriberFromEnv } from '../meta-transcribe.mjs';
import { client, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const view = { kind: 'version', version: 1, variantId: null, eraRevision: null };
const limits = { totalUsd: 0.003, perRequestUsd: 0.003, maxRequests: 1 };
const answer = () => Response.json({ sessionId: 'synthetic-session', turns: [{ startMs: 0, endMs: 1900, transcript: 'Synthetic spatial note.' }] },
  { headers: { 'x-request-id': 'synthetic-request' } });
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-strict-asr-http-')); dirs.push(dir);
  const file = path.join(dir, 'budget.json'), oneShotFile = path.join(dir, 'attempt.json');
  await writeFile(file, '{"entries":[]}\n');
  return { file, oneShotFile, ledger: new StrictTranscribeLedger({ file, oneShotFile, limits }) };
}
const grant = () => ({ provider: 'Synthetic fixture', origin: { kind: 'own', reference: 'Fictional fixture' },
  permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } });
async function workspace(transcriber) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-strict-asr-scene-')); dirs.push(dataDir);
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, captionTranscriber: transcriber,
    audioDecoder: async () => ({ pcm: Buffer.alloc(64_000), durationMs: 2000, sampleRate: 16000, channels: 1, bitsPerSample: 16 }) });
  const owner = client(app.base, app.cookie);
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('voice', new Blob([WEBM], { type: 'audio/webm' }), 'voice.webm');
  form.append('metadata', JSON.stringify({ photos: [grant()], voice: grant() }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((r) => setTimeout(r, 5));
  const request = { requestId: randomUUID(), voiceSourceId: draft.voice.sourceId, view };
  const route = `${scene}/stories/caption-drafts`;
  return { app, owner, draft, job, scene, route, request };
}
async function removeModelUse(f) {
  const route = `/api/drafts/${f.draft.id}/sources/${f.draft.voice.sourceId}/policy`;
  const policy = await f.owner.json(route);
  const response = await f.owner.post(route, { requestId: randomUUID(), baseRevision: policy.revision,
    permissions: { place: true, model: false, share: true }, stopUse: false });
  assert.equal(response.status, 200);
}

it('strict env factory drafts once through the normal route with a reserved ledger before fake dispatch', async () => {
  const budget = await fixture(); const calls = [];
  const originalFetch = globalThis.fetch;
  let transcribe;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal((await budget.ledger.read()).entries[0].state, 'reserved');
      assert.ok((await readFile(budget.oneShotFile)).length > 0);
      calls.push({ url, options: await init.body.get('request').text(), wav: Buffer.from(await init.body.get('audio').arrayBuffer()) });
      return answer();
    };
    transcribe = metaTranscriberFromEnv({ ledgerFile: budget.file, oneShotFile: budget.oneShotFile,
      env: { MODEL_API_KEY: 'fake', REHERE_TRANSCRIBE_LIVE: '1', REHERE_TRANSCRIBE_STRICT: '1', REHERE_TRANSCRIBE_TOTAL_USD: '0.003', REHERE_TRANSCRIBE_MAX_REQUESTS: '1' } });
  } finally { globalThis.fetch = originalFetch; }
  const f = await workspace(transcribe);
  try {
    const response = await f.owner.post(f.route, f.request);
    assert.equal(response.status, 201);
    const { draft } = await response.json();
    assert.equal(draft.confirmed, false);
    assert.equal(draft.voiceSourceId, f.request.voiceSourceId);
    assert.deepEqual(draft.view, view);
    assert.equal(draft.targetId, 'selected-foreground');
    assert.equal(draft.call.responseOrigin, 'live');
    assert.equal(draft.call.providerRequestId, 'synthetic-request');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.meta.ai/v1/asr/transcribe');
    assert.equal(calls[0].options, '{"model":"muse-voice-transcribe-1.0","mode":"ENDPOINTING","audioEncoding":"WAV"}');
    assert.deepEqual(calls[0].wav, pcmWav(Buffer.alloc(64_000)));
    assert.equal((await f.owner.post(f.route, f.request)).status, 409, 'exact retry does not resend or return lost cues');
    assert.equal((await f.owner.post(f.route, { ...f.request, requestId: randomUUID() })).status, 409, 'one-shot limit also blocks a new request ID');
    assert.equal(calls.length, 1);
    assert.equal((await budget.ledger.read()).entries[0].state, 'reserved');
  } finally { await f.app.close(); }
});

it('normal HTTP admission rejects a missing ledger without creating it or sending', async () => {
  const budget = await fixture(); let fetches = 0;
  const transcribe = createMetaTranscriber({ apiKey: 'fake', ledger: budget.ledger, fetch: async () => { fetches++; return answer(); } });
  const f = await workspace(transcribe);
  try {
    await rm(budget.file);
    assert.equal((await f.owner.post(f.route, f.request)).status, 500);
    assert.equal(fetches, 0);
    await assert.rejects(readFile(budget.file), { code: 'ENOENT' });
    await assert.rejects(readFile(budget.oneShotFile), { code: 'ENOENT' });
  } finally { await f.app.close(); }
});

it('restriction while waiting after reserve refuses dispatch and refunds only the proven unstarted attempt', async () => {
  const budget = await fixture(); const reserved = deferred(), release = deferred(); let fetches = 0;
  const reserve = budget.ledger.reserve.bind(budget.ledger);
  budget.ledger.reserve = async (amount) => { const id = await reserve(amount); reserved.resolve(); await release.promise; return id; };
  const transcribe = createMetaTranscriber({ apiKey: 'fake', ledger: budget.ledger, fetch: async () => { fetches++; return answer(); } });
  const f = await workspace(transcribe);
  try {
    const pending = f.owner.post(f.route, f.request);
    await reserved.promise;
    await removeModelUse(f);
    release.resolve();
    assert.equal((await pending).status, 409);
    assert.equal(fetches, 0);
    assert.equal((await budget.ledger.read()).entries[0].estimatedUsd, 0);
    assert.ok((await readFile(budget.oneShotFile)).length > 0);
    assert.equal(await new StrictTranscribeLedger({ file: budget.file, oneShotFile: budget.oneShotFile, limits }).reserve(0.0001), null);
  } finally { release.resolve(); await f.app.close(); }
});

it('a response after voice restriction cannot apply and its started reservation remains held', async () => {
  const budget = await fixture(); const started = deferred(), release = deferred(); let fetches = 0;
  const transcribe = createMetaTranscriber({ apiKey: 'fake', ledger: budget.ledger, fetch: async () => { fetches++; started.resolve(); await release.promise; return answer(); } });
  const f = await workspace(transcribe);
  try {
    const pending = f.owner.post(f.route, f.request);
    await started.promise;
    await removeModelUse(f);
    release.resolve();
    assert.notEqual((await pending).status, 201);
    assert.equal(fetches, 1);
    assert.equal((await budget.ledger.read()).entries[0].state, 'reserved');
    assert.deepEqual(await f.owner.json(`${f.scene}/stories`), { stories: [] });
  } finally { release.resolve(); await f.app.close(); }
});

it('default factory keeps permissive missing-ledger and multiple-attempt behavior explicit', async () => {
  const budget = await fixture(); await rm(budget.file);
  const originalFetch = globalThis.fetch; const calls = []; let transcribe;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, options: await init.body.get('request').text(), wav: Buffer.from(await init.body.get('audio').arrayBuffer()) }); return answer();
    };
    transcribe = metaTranscriberFromEnv({ ledgerFile: budget.file, env: { MODEL_API_KEY: 'fake', REHERE_TRANSCRIBE_LIVE: '1', REHERE_TRANSCRIBE_MAX_REQUESTS: '2' } });
  } finally { globalThis.fetch = originalFetch; }
  for (let index = 0; index < 2; index++) assert.equal((await transcribe({ wav: pcmWav(Buffer.alloc(64_000)), durationMs: 2000, admit: async (start) => ({ value: start() }) })).ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].options, '{"model":"muse-voice-transcribe-1.0","mode":"ENDPOINTING","audioEncoding":"WAV"}');
  assert.equal((await new BudgetLedger({ file: budget.file }).read()).entries.length, 2);
  await assert.rejects(readFile(budget.oneShotFile), { code: 'ENOENT' });
});
