import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { BudgetLedger, COUNT_FREE_RESERVATION_USD, INPUT_USD, OUTPUT_USD, createCountFreeSender, createMetaModel, createStoredModel, metaModelFromEnv, requestBody, requestDigest } from '../meta-model.mjs';

const SHA = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RESERVE = 1.328128;
const LIMITS = { totalUsd: 5.312512, perRequestUsd: RESERVE, maxRequests: 4 };
const SOURCE = '00000000-0000-4000-8000-000000000001';
const input = (change = {}) => ({ text: 'Synthetic bounded instruction.', image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), selection: [0, 0, 1, 1], sourceId: SOURCE, baseVersion: 1,
  saved: { version: 1, offset: [0, 0, 0], yaw: 0 }, admit: async (start) => ({ value: start() }), ...change });
const answer = (change = {}) => ({ id: 'synthetic-response', model: 'muse-spark-1.3', status: 'completed', usage: { input_tokens: 1000, output_tokens: 100 }, output: [{
  type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ action: 'clarify', targetId: null, sourceId: SOURCE, baseVersion: 1,
    delta: null, yawDelta: null, anchor: null, question: 'Synthetic clarification?', reason: 'Synthetic response.' }) }],
}], ...change });
async function fixture(t, limits = LIMITS) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-count-free-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'budget.json');
  await writeFile(file, '{"entries":[]}', { flag: 'wx', mode: 0o600 });
  return { file, book: new BudgetLedger({ file, limits }) };
}
const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
const send = (book, fetch, extra = {}) => createCountFreeSender({ apiKey: 'synthetic-key', ledger: book, fetch, ...extra });

it('reserves the full window before admission and sends exactly one unchanged bounded body without COUNT', async (t) => {
  const { book } = await fixture(t), requests = [];
  assert.equal(COUNT_FREE_RESERVATION_USD, RESERVE);
  assert.equal(COUNT_FREE_RESERVATION_USD, Number((1_048_576 * INPUT_USD + 4096 * OUTPUT_USD).toFixed(6)));
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const [entry] = (await book.read()).entries;
    assert.equal(entry.state, 'reserved'); assert.equal(entry.reservedUsd, RESERVE);
    assert.equal(entry.requestSha256, SHA(init.body));
    assert.equal(entry.attempt, 1); assert.equal(entry.retryOf, null);
    return Response.json(answer());
  };
  const body = requestBody(input());
  const result = await send(book, fetch)({ body, admit: async (start) => {
    assert.equal((await book.totals()).chargedUsd, RESERVE);
    return { value: start() };
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(requests.map((r) => r.url), ['https://api.meta.ai/v1/responses']);
  assert.deepEqual(JSON.parse(requests[0].init.body), { ...body, store: false, reasoning: { effort: 'low' }, max_output_tokens: 4096 });
  assert.equal(JSON.stringify(result.generation), requests[0].init.body);
  assert.equal((await book.read()).entries[0].state, 'reserved', 'known success also retains the conservative reservation');
  assert.equal(result.record.usage.estimatedUsd, 0.001675);
});

it('rejects unsupported nested input, model, output, tools, history and tier before any request or reservation', async (t) => {
  const { book } = await fixture(t); let calls = 0;
  const sender = send(book, async () => { calls++; return Response.json(answer()); });
  const original = requestBody(input());
  const bad = [
    { ...original, model: 'another-model' }, { ...original, tools: [] }, { ...original, previous_response_id: 'old' },
    { ...original, service_tier: 'priority' }, { ...original, background: true }, { ...original, max_output_tokens: 1 },
    { ...original, input: [...original.input, original.input[0]] }, { ...original, input: [{ ...original.input[0], role: 'assistant' }] },
    { ...original, input: [{ ...original.input[0], tool: 'x' }] },
    { ...original, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Synthetic' }, { type: 'input_image', image_url: 'https://example.com/image.jpg' }] }] },
    { ...original, input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file' }] }] },
    { ...original, input: [{ role: 'user', content: [...original.input[0].content, original.input[0].content[1]] }] },
    { ...original, text: { ...original.text, n: 2 } },
    { ...original, text: { format: { ...original.text.format, strict: false } } },
    { ...original, text: { format: { ...original.text.format, schema: { ...original.text.format.schema, $ref: 'https://example.com/schema' } } } },
  ];
  for (const body of bad) assert.equal((await sender({ body, admit: input().admit })).ok, false);
  assert.equal(calls, 0); assert.deepEqual((await book.read()).entries, []);
});

it('never dispatches for failed reserve, missing/corrupt ledger or a failed durable write', async (t) => {
  for (const limits of [{ ...LIMITS, perRequestUsd: 0.05 }, { ...LIMITS, totalUsd: 1 }, { ...LIMITS, maxRequests: 0 }]) {
    const { book } = await fixture(t, limits); let calls = 0;
    assert.equal((await send(book, async () => { calls++; })({ body: requestBody(input()), admit: input().admit })).ok, false);
    assert.equal(calls, 0);
  }
  for (const corrupted of [null, '{', '{"entries":[{"state":"reserved","reservedUsd":-1}]}', '{"entries":[],"unexpected":true}']) {
    const { book, file } = await fixture(t); let calls = 0;
    if (corrupted === null) await rm(file); else await writeFile(file, corrupted);
    assert.equal((await send(book, async () => { calls++; })({ body: requestBody(input()), admit: input().admit })).ok, false);
    assert.equal(calls, 0);
    if (corrupted !== null) assert.equal(await readFile(file, 'utf8'), corrupted);
  }
  const { book } = await fixture(t); let calls = 0;
  book.write = async () => { throw new Error('synthetic storage failure'); };
  assert.equal((await send(book, async () => { calls++; })({ body: requestBody(input()), admit: input().admit })).ok, false);
  assert.equal(calls, 0);
});

it('refunds only proven unsent admission and never starts a delayed or duplicate callback', async (t) => {
  const { book } = await fixture(t); let calls = 0, late;
  const sender = send(book, async () => { calls++; return Response.json(answer()); });
  assert.equal((await sender({ body: requestBody(input()), admit: async (start) => { late = start; return null; } })).ok, false);
  await late(); assert.equal(calls, 0); assert.equal((await book.totals()).chargedUsd, 0);
  const second = await sender({ body: requestBody(input({ text: 'Different synthetic request.' })), admit: async (start) => ({ value: Promise.all([start(), start()]) }) });
  assert.equal(second.ok, true); assert.equal(calls, 1);
});

it('does not recreate a ledger removed while an unsent admission is pending', async (t) => {
  const { book, file } = await fixture(t); let calls = 0;
  const result = await send(book, async () => { calls++; })({ body: requestBody(input()), admit: async () => { await rm(file); return null; } });
  assert.equal(result.ok, false); assert.equal(calls, 0);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

it('keeps full reservation when admission starts a request then throws or rejects', async (t) => {
  for (const asynchronous of [false, true]) {
    const { book } = await fixture(t); let calls = 0;
    const sender = send(book, async () => { calls++; return Response.json(answer()); });
    const result = await sender({ body: requestBody(input()), admit: (start) => {
      start(); if (asynchronous) return Promise.reject(new Error('synthetic rejection'));
      throw new Error('synthetic throw');
    } });
    assert.equal(result.ok, false); assert.equal(calls, 1);
    assert.equal((await book.totals()).chargedUsd, RESERVE);
    assert.equal((await book.read()).entries[0].state, 'reserved');
  }
});

it('retains HTTP rejection, unknown, timeout and invalid or over-bound usage without returning an applicable response', async (t) => {
  const cases = [
    async () => new Response('{}', { status: 400 }), async () => { throw new Error('synthetic transport failure'); },
    async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
    async () => Response.json(answer({ usage: null })),
    async () => Response.json(answer({ model: 'another-model' })),
    ...[{ input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: 1_048_577, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 4097 }, { input_tokens: 1_048_576, output_tokens: 4096 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 }]
      .map((usage) => async () => Response.json(answer({ usage }))),
  ];
  for (const fetch of cases) {
    const { book } = await fixture(t);
    const result = await send(book, fetch, { timeoutMs: 10 })({ body: requestBody(input()), admit: input().admit });
    assert.equal(result.ok, false);
    assert.equal((await book.totals()).chargedUsd, RESERVE);
    assert.equal((await book.read()).entries[0].state, 'reserved');
  }
});

it('uses exact transmitted-byte digest and canonical retry identity after key reordering and changed external request IDs', async (t) => {
  const { book, file } = await fixture(t), wire = [];
  const fetch = async (_url, init) => { wire.push(init.body); return Response.json(answer()); };
  const body = requestBody(input());
  assert.equal((await send(book, fetch)({ body, requestId: randomUUID(), admit: input().admit })).ok, true);
  const restarted = new BudgetLedger({ file, limits: LIMITS });
  assert.equal((await send(restarted, fetch)({ body: reverseKeys(body), requestId: randomUUID(), admit: input().admit })).ok, true);
  assert.equal((await send(restarted, fetch)({ body, requestId: randomUUID(), admit: input().admit })).reason, 'budget');
  assert.equal(wire.length, 2); assert.notEqual(wire[0], wire[1]);
  const [a, b] = (await restarted.read()).entries;
  assert.equal(a.requestSha256, SHA(wire[0])); assert.equal(b.requestSha256, SHA(wire[1]));
  assert.notEqual(a.requestSha256, b.requestSha256); assert.equal(a.retryKeySha256, b.retryKeySha256);
  assert.equal(b.attempt, 2); assert.equal(b.retryOf, a.id); assert.equal((await restarted.totals()).chargedUsd, 2 * RESERVE);
});

it('preserves the default generation digest and stored-response replay for normal proposal requests', async (t) => {
  const { book } = await fixture(t), recorded = [], wire = [];
  const model = createMetaModel({ apiKey: 'synthetic-key', ledger: book, countFree: true, recorder: async (entry) => recorded.push(entry),
    fetch: async (_url, init) => { wire.push(init.body); return Response.json(answer()); } });
  assert.equal((await model(input())).ok, true);
  const expected = { ...requestBody(input()), store: false, reasoning: { effort: 'low' }, max_output_tokens: 4096 };
  assert.equal(recorded[0].requestSha256, requestDigest(expected));
  assert.equal(recorded[0].requestSha256, SHA(wire[0]));
  assert.equal((await createStoredModel({ entries: recorded })(input())).mode, 'recorded');
  assert.equal(wire.length, 1);
});

it('serializes concurrent attempts and carries existing legacy charges instead of resetting them', async (t) => {
  const { book } = await fixture(t); await book.reserve(0.01);
  let calls = 0;
  const sender = send(book, async () => { calls++; return Response.json(answer()); });
  const results = await Promise.all(Array.from({ length: 6 }, () => sender({ body: requestBody(input()), admit: input().admit })));
  assert.equal(results.filter((item) => item.ok).length, 2); assert.equal(calls, 2);
  assert.equal((await book.totals()).chargedUsd, 0.01 + 2 * RESERVE);
  assert.equal((await book.read()).entries.length, 3);
});

it('keeps distinct text, image and parent requests distinct while enforcing the four-attempt batch ceiling', async (t) => {
  const { book } = await fixture(t); let calls = 0;
  const sender = send(book, async () => { calls++; return Response.json(answer()); });
  const inputs = [input(), input({ text: 'Different synthetic memory.' }), input({ image: Buffer.from([255, 216, 1, 255, 217]) }),
    input({ baseVersion: undefined, alternative: { parentVariantId: '00000000-0000-4000-8000-000000000010', baseEraRevision: 0 } })];
  for (const value of inputs) assert.equal((await sender({ body: requestBody(value), admit: input().admit })).ok, true);
  assert.equal((await sender({ body: requestBody(input({ text: 'Fifth synthetic request.' })), admit: input().admit })).reason, 'budget');
  const { entries } = await book.read();
  assert.equal(new Set(entries.map((entry) => entry.retryKeySha256)).size, 4);
  assert.equal(calls, 4); assert.equal((await book.totals()).chargedUsd, 5.312512);
});

it('requires explicit finite bounded config and preserves the default counted path', async (t) => {
  const { file } = await fixture(t);
  const env = { MODEL_API_KEY: 'synthetic-key', REHERE_MODEL_LIVE: '1', REHERE_MODEL_COUNT_FREE: '1', REHERE_MODEL_TOTAL_USD: '5.312512', REHERE_MODEL_MAX_REQUESTS: '4' };
  assert.equal(typeof metaModelFromEnv({ ledgerFile: file, env }), 'function');
  assert.throws(() => createMetaModel({ apiKey: 'synthetic-key', ledger: new BudgetLedger({ file }), countFree: 'yes' }));
  for (const change of [{ REHERE_MODEL_TOTAL_USD: undefined }, { REHERE_MODEL_MAX_REQUESTS: undefined }, { REHERE_MODEL_TOTAL_USD: 'NaN' },
    { REHERE_MODEL_TOTAL_USD: 'Infinity' }, { REHERE_MODEL_TOTAL_USD: '0' }, { REHERE_MODEL_TOTAL_USD: '5.312513' },
    { REHERE_MODEL_MAX_REQUESTS: '1.5' }, { REHERE_MODEL_MAX_REQUESTS: '5' }, { REHERE_MODEL_MAX_REQUESTS: '0' }, { REHERE_MODEL_COUNT_FREE: 'yes' }]) {
    assert.throws(() => metaModelFromEnv({ ledgerFile: file, env: { ...env, ...change } }));
  }
  const requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { requests.push(url); return Response.json(url.endsWith('input_tokens') ? { input_tokens: 1 } : answer()); };
  try {
    const counted = metaModelFromEnv({ ledgerFile: file, env: { MODEL_API_KEY: 'synthetic-key', REHERE_MODEL_LIVE: '1' } });
    await counted(input()); assert.equal(requests[0], 'https://api.meta.ai/v1/responses/input_tokens');
  } finally { globalThis.fetch = originalFetch; }
});

it('retains a full reservation across abrupt process death before and after start, enforcing one explicit retry on restart', async (t) => {
  for (const phase of ['before', 'after']) {
    const { file, book } = await fixture(t);
    const moduleUrl = new URL('../meta-model.mjs', import.meta.url).href;
    const worker = `import {BudgetLedger,createCountFreeSender,requestBody} from ${JSON.stringify(moduleUrl)};
      const book=new BudgetLedger({file:process.argv[1],limits:${JSON.stringify(LIMITS)}});
      const hold=()=>new Promise(()=>{});
      const sender=createCountFreeSender({apiKey:'synthetic-key',ledger:book,fetch:()=>{process.stdout.write('ready\\n');return hold();}});
      const body=requestBody({...${JSON.stringify({ ...input(), image: undefined, admit: undefined })},image:new Uint8Array([255,216,255,217])});
      await sender({body,admit:async(start)=>{if(process.argv[2]==='before'){process.stdout.write('ready\\n');await hold();}return {value:start()};}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, file, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([status]) => { throw new Error(`synthetic worker exited ${status}`); })]);
    const died = once(child, 'exit'); child.kill('SIGKILL'); await died;
    assert.equal((await book.totals()).chargedUsd, RESERVE);
    let calls = 0;
    const restarted = new BudgetLedger({ file, limits: LIMITS }), sender = send(restarted, async () => { calls++; return Response.json(answer()); });
    assert.equal((await sender({ body: requestBody(input()), admit: input().admit })).ok, true);
    assert.equal((await sender({ body: requestBody(input()), admit: input().admit })).reason, 'budget');
    assert.equal(calls, 1); assert.equal((await restarted.totals()).chargedUsd, 2 * RESERVE);
  }
});
