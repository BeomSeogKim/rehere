import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BudgetLedger, MAX_OUTPUT_TOKENS, createMetaModel, createStoredModel, metaModelFromEnv, parseStoredResponses, requestBody, requestDigest, responseRecorder } from '../meta-model.mjs';
import { modelEvidence } from '../public/memory-edit.js';

const KEY = 'test-key-not-real-0123456789';
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const SOURCE = '00000000-0000-4000-8000-000000000001';
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-stored-'));
  tempDirs.push(dir);
  return dir;
}

const planText = JSON.stringify({ action: 'rotate', targetId: 'selected-foreground', sourceId: SOURCE, baseVersion: 1, delta: null, yawDelta: 0.5, anchor: null, question: null, reason: 'Turned toward the window.' });
const completed = (change = {}) => ({ id: 'resp_recorded_1', model: 'muse-spark-1.3', status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: planText }] }], usage: { input_tokens: 1000, output_tokens: 200 }, ...change });
const input = (change = {}) => ({ text: 'The chair faced the window.', image: IMAGE, selection: [0.1, 0.1, 0.5, 0.8], sourceId: SOURCE, baseVersion: 1, saved: { version: 1, offset: [0, 0, 0], yaw: 0 }, ...change });
const digestOf = (change = {}) => requestDigest({ ...requestBody(input(change)), store: false, reasoning: { effort: 'low' }, max_output_tokens: MAX_OUTPUT_TOKENS });

function admitter() {
  const admit = async (start) => {
    admit.calls += 1;
    return { value: start() };
  };
  admit.calls = 0;
  return admit;
}

describe('Live Meta answers carry their own evidence', () => {
  it('reports the live mode and latency and records the unchanged response for its exact request', async () => {
    const dir = await tempDir();
    const recorded = [];
    let sent;
    const fetch = async (url, init) => {
      if (url.endsWith('/responses/input_tokens')) return Response.json({ input_tokens: 1000 });
      sent = JSON.parse(init.body);
      return Response.json(completed());
    };
    const model = createMetaModel({ apiKey: KEY, ledger: new BudgetLedger({ file: path.join(dir, 'budget.json') }), fetch, recorder: async (entry) => recorded.push(entry) });
    const outcome = await model({ ...input(), admit: admitter() });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.mode, 'live');
    assert.ok(Number.isInteger(outcome.latencyMs) && outcome.latencyMs >= 0);
    assert.equal(outcome.responseId, 'resp_recorded_1');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, 'recorded');
    assert.equal(recorded[0].requestSha256, requestDigest(sent));
    assert.equal(recorded[0].requestSha256, digestOf());
    assert.deepEqual(recorded[0].response, completed());
    assert.ok(!JSON.stringify(recorded).includes(KEY));
  });

  it('records nothing for a failed generation', async () => {
    const dir = await tempDir();
    const recorded = [];
    const fetch = async (url) => (url.endsWith('/responses/input_tokens') ? Response.json({ input_tokens: 10 }) : new Response('{}', { status: 500 }));
    const model = createMetaModel({ apiKey: KEY, ledger: new BudgetLedger({ file: path.join(dir, 'budget.json') }), fetch, recorder: async (entry) => recorded.push(entry) });
    const outcome = await model({ ...input(), admit: admitter() });
    assert.equal(outcome.reason, 'provider');
    assert.equal(outcome.mode, 'live');
    assert.equal(recorded.length, 0);
  });
});

describe('Stored Meta answers', () => {
  const recordedEntry = () => ({ kind: 'recorded', requestSha256: digestOf(), recordedAt: '2026-11-04T03:00:00.000Z', latencyMs: 2345, response: completed() });

  it('replays a recorded answer only through admission, with its recorded identity and no spending', async () => {
    const admit = admitter();
    const outcome = await createStoredModel({ entries: [recordedEntry()] })({ ...input(), admit });
    assert.equal(admit.calls, 1);
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.plan, JSON.parse(planText));
    assert.equal(outcome.mode, 'recorded');
    assert.equal(outcome.model, 'muse-spark-1.3');
    assert.equal(outcome.responseId, 'resp_recorded_1');
    assert.equal(outcome.latencyMs, 2345);
    assert.equal(outcome.recordedAt, '2026-11-04T03:00:00.000Z');
  });

  it('never answers a request whose memory, photo, source or base differs from the recording', async () => {
    const model = createStoredModel({ entries: [recordedEntry()] });
    for (const change of [{ text: 'The chair faced the door.' }, { image: Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]) }, { baseVersion: 2, saved: { version: 2, offset: [0, 0, 0], yaw: 0 } },
      { sourceId: '00000000-0000-4000-8000-000000000002' }, { saved: { version: 1, offset: [0.1, 0, 0], yaw: 0 } }]) {
      const admit = admitter();
      const outcome = await model({ ...input(change), admit });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, 'unrecorded');
      assert.equal(admit.calls, 0);
      assert.equal(outcome.mode, undefined);
    }
  });

  it('labels a hand-written answer as simulated, with no model or response identity', async () => {
    const outcome = await createStoredModel({ entries: [{ kind: 'simulated', requestSha256: digestOf(), response: completed({ id: 'resp_made_up', model: 'muse-spark-1.3' }) }] })({ ...input(), admit: admitter() });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.mode, 'simulated');
    assert.equal(outcome.model, null);
    assert.equal(outcome.responseId, null);
    assert.equal(outcome.usage, null);
  });

  it('stops when admission is refused or no admission is given', async () => {
    const model = createStoredModel({ entries: [recordedEntry()] });
    assert.equal((await model({ ...input(), admit: async () => null })).reason, 'restricted');
    assert.equal((await model(input())).reason, 'restricted');
  });

  it('applies the same response checks as a live answer', async () => {
    const refused = completed({ output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No.' }] }] });
    const outcome = await createStoredModel({ entries: [{ ...recordedEntry(), response: refused }] })({ ...input(), admit: admitter() });
    assert.equal(outcome.reason, 'refused');
    assert.equal(outcome.mode, 'recorded');
  });

  it('rejects malformed or repeated stored responses', () => {
    const good = recordedEntry();
    for (const entries of [null, [{ ...good, kind: 'live' }], [{ ...good, requestSha256: 'abc' }], [{ ...good, recordedAt: undefined }],
      [{ ...good, response: { ...good.response, id: undefined } }], [{ ...good, latencyMs: -1 }], [good, { ...good }], [{ ...good, response: null }]]) {
      assert.throws(() => parseStoredResponses({ entries }));
    }
    assert.equal(parseStoredResponses({ entries: [good, { kind: 'simulated', requestSha256: '0'.repeat(64), response: {} }] }).length, 2);
  });
});

describe('Model mode selection from the environment', () => {
  it('stays off without an explicit mode and keeps stored and live use apart', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'stored.json');
    await writeFile(file, JSON.stringify({ entries: [] }));
    const ledgerFile = path.join(dir, 'budget.json');
    assert.equal(metaModelFromEnv({ ledgerFile, env: {} }), null);
    assert.equal(metaModelFromEnv({ ledgerFile, env: { MODEL_API_KEY: KEY } }), null);
    assert.equal(typeof metaModelFromEnv({ ledgerFile, env: { REHERE_MODEL_REPLAY: file } }), 'function');
    assert.throws(() => metaModelFromEnv({ ledgerFile, env: { MODEL_API_KEY: KEY, REHERE_MODEL_LIVE: '1', REHERE_MODEL_REPLAY: file } }));
    assert.throws(() => metaModelFromEnv({ ledgerFile, env: { REHERE_MODEL_REPLAY: file, REHERE_MODEL_RECORD: path.join(dir, 'out.json') } }));
    assert.throws(() => metaModelFromEnv({ ledgerFile, env: { MODEL_API_KEY: KEY, REHERE_MODEL_RECORD: path.join(dir, 'out.json') } }));
    await writeFile(file, '{"entries": [{"kind": "live"}]}');
    assert.throws(() => metaModelFromEnv({ ledgerFile, env: { REHERE_MODEL_REPLAY: file } }));
  });

  it('records live responses to a file the stored mode can replay', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'recorded.json');
    const record = responseRecorder(file);
    await record({ kind: 'recorded', requestSha256: digestOf(), recordedAt: '2026-11-04T03:00:00.000Z', latencyMs: 10, response: completed({ id: 'resp_old' }) });
    await record({ kind: 'recorded', requestSha256: digestOf(), recordedAt: '2026-11-04T03:05:00.000Z', latencyMs: 12, response: completed() });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0].response.id, 'resp_recorded_1');
    const outcome = await metaModelFromEnv({ ledgerFile: path.join(dir, 'budget.json'), env: { REHERE_MODEL_REPLAY: file } })({ ...input(), admit: admitter() });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.mode, 'recorded');
    assert.equal(outcome.recordedAt, '2026-11-04T03:05:00.000Z');
  });
});

describe('Model evidence shown with a proposal', () => {
  it('describes each mode only from the saved evidence', () => {
    const live = modelEvidence({ mode: 'live', model: 'muse-spark-1.3', responseId: 'resp_1', latencyMs: 1830, usage: { estimatedUsd: 0.00215 } });
    assert.equal(live.heading, 'Live answer from muse-spark-1.3');
    assert.match(live.lines.join(' '), /Meta response ID resp_1 · 1,830 ms/);
    assert.match(live.lines.join(' '), /\$0\.0022/);
    const replayed = modelEvidence({ mode: 'recorded', model: 'muse-spark-1.3', responseId: 'resp_1', latencyMs: 1830, recordedAt: '2026-11-04T03:00:00.000Z', usage: null });
    assert.equal(replayed.heading, 'Replayed answer from muse-spark-1.3, recorded 2026-11-04 03:00 UTC');
    assert.match(replayed.lines.join(' '), /sent nothing and cost nothing/);
    const simulated = modelEvidence({ mode: 'simulated', model: null, responseId: null, usage: null });
    assert.equal(simulated.heading, 'SIMULATED answer, not from Meta');
    assert.doesNotMatch(simulated.lines.join(' '), /muse|response ID/i);
    assert.equal(modelEvidence({ model: 'muse-spark-1.3', usage: null }).lines[0], 'How this answer was obtained was not recorded.');
    assert.equal(modelEvidence({ model: null, usage: null }), null);
    assert.match(modelEvidence({ mode: 'live', model: null, responseId: null, latencyMs: null }).lines[0], /no Meta response ID was returned · latency not recorded/);
  });
});
