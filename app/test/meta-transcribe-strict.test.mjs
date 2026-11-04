import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { BudgetLedger } from '../meta-model.mjs';
import * as api from '../meta-transcribe.mjs';

const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const limits = { totalUsd: 0.003, perRequestUsd: 0.003, maxRequests: 1 };
const wav = Buffer.alloc(32_044);
const admitted = async (start) => ({ value: start() });
const answer = () => Response.json({ turns: [{ startMs: 0, endMs: 900, transcript: 'Synthetic fixture.' }] });
async function fixture({ initialize = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-strict-transcribe-'));
  dirs.push(dir);
  const file = path.join(dir, 'budget.json'), oneShotFile = path.join(dir, 'attempt.json');
  if (initialize) await writeFile(file, '{"entries":[]}\n');
  const make = () => new api.StrictTranscribeLedger({ file, oneShotFile, limits });
  return { dir, file, oneShotFile, make };
}
const invoke = (transcribe, admit = admitted) => transcribe({ wav, durationMs: 1000, admit });

it('requires an explicit strict limit, existing ledger and distinct one-shot path', async () => {
  const f = await fixture();
  for (const bad of [undefined, {}, { ...limits, totalUsd: NaN }, { ...limits, totalUsd: 0.004 },
    { ...limits, maxRequests: 2 }, { ...limits, maxRequests: 1.1 }, { ...limits, perRequestUsd: 0 }]) {
    assert.throws(() => new api.StrictTranscribeLedger({ file: f.file, oneShotFile: f.oneShotFile, limits: bad }));
  }
  assert.throws(() => new api.StrictTranscribeLedger({ file: f.file, oneShotFile: f.file, limits }));
  assert.throws(() => new api.StrictTranscribeLedger({ file: f.file, limits }));
});

it('rejects missing, corrupt and incompatible ledgers at reserve without creating files or dispatching', async () => {
  for (const bytes of [null, 'broken', '{}', '{"entries":[],"other":1}', '{"entries":[{}]}',
    '{"entries":[{"id":"bad","state":"settled","reservedUsd":0.001,"estimatedUsd":-1,"at":"bad"}]}']) {
    const f = await fixture({ initialize: false });
    if (bytes !== null) await writeFile(f.file, bytes);
    let fetches = 0;
    const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: f.make(), fetch: async () => { fetches++; return answer(); } });
    await assert.rejects(invoke(transcribe));
    assert.equal(fetches, 0);
    await assert.rejects(readFile(f.oneShotFile), { code: 'ENOENT' });
    if (bytes === null) await assert.rejects(readFile(f.file), { code: 'ENOENT' });
    else assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
});

it('validates the existing ledger again before a never-started refund', async () => {
  for (const bytes of [null, 'broken', '{}', '{"entries":[]}', '{"entries":[],"other":1}']) {
    const f = await fixture();
    const budget = f.make();
    let fetches = 0;
    const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, fetch: async () => { fetches++; return answer(); } });
    await assert.rejects(invoke(transcribe, async () => {
      if (bytes === null) await rm(f.file);
      else await writeFile(f.file, bytes);
      return null;
    }));
    assert.equal(fetches, 0);
    assert.ok((await readFile(f.oneShotFile)).length > 0);
    if (bytes === null) await assert.rejects(readFile(f.file), { code: 'ENOENT' });
    else assert.equal(await readFile(f.file, 'utf8'), bytes);
    await assert.rejects(f.make().reserve(0.00005));
  }
});

it('refunds only a proven unstarted owned reservation and never reuses its one-shot marker', async () => {
  const f = await fixture();
  let fetches = 0;
  const budget = f.make();
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, fetch: async () => { fetches++; return answer(); } });
  assert.equal((await invoke(transcribe, async () => null)).reason, 'restricted');
  assert.equal((await budget.read()).entries[0].estimatedUsd, 0);
  assert.equal((await invoke(transcribe)).reason, 'budget');
  assert.equal(await f.make().reserve(0.00005), null);
  assert.equal(fetches, 0);
});

for (const mode of ['throw', 'reject', 'null', 'duplicate']) it(`retains a started attempt when admission returns ${mode}`, async () => {
  const f = await fixture();
  const budget = f.make();
  let fetches = 0;
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, fetch: async () => { fetches++; return answer(); } });
  const result = await invoke(transcribe, (start) => {
    start();
    if (mode === 'reject') return Promise.reject(new Error('after start'));
    if (mode === 'null') return null;
    if (mode === 'duplicate') start();
    throw new Error('after start');
  });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.equal(result.call.dispatched, true);
  assert.equal(fetches, 1);
  const [entry] = (await budget.read()).entries;
  assert.equal(entry.state, 'reserved');
  assert.equal(entry.reservedUsd, 1000 * api.USD_PER_AUDIO_MS);
  await assert.rejects(budget.settle(entry.id, 0));
  await assert.rejects(f.make().settle(entry.id, 0));
  assert.equal(await f.make().reserve(entry.reservedUsd), null);
});

it('refuses a start callback retained beyond a rejected admission', async () => {
  const f = await fixture(); let startLater, fetches = 0;
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: f.make(), fetch: async () => { fetches++; return answer(); } });
  const result = await invoke(transcribe, async (start) => { startLater = start; return null; });
  assert.equal(result.reason, 'restricted');
  assert.throws(() => startLater());
  assert.equal(fetches, 0);
});

it('checks ledger and marker synchronously at start without adding an admission await', async () => {
  for (const bytes of [null, 'broken', '{"entries":[]}']) {
    const f = await fixture(); let fetches = 0;
    const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: f.make(), fetch: async () => { fetches++; return answer(); } });
    await assert.rejects(invoke(transcribe, async (start) => {
      if (bytes === null) await rm(f.file); else await writeFile(f.file, bytes);
      return { value: start() };
    }));
    assert.equal(fetches, 0);
    assert.ok((await readFile(f.oneShotFile)).length > 0);
  }
});

it('drains a lost started promise and retains an unknown transport rejection', async () => {
  const f = await fixture(); const budget = f.make(); let fetches = 0;
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, fetch: async () => { fetches++; throw new Error('transport'); } });
  const result = await invoke(transcribe, async (start) => { start(); throw new Error('lost envelope'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.unknown, true);
  assert.equal(fetches, 1);
  assert.equal((await budget.read()).entries[0].state, 'reserved');
});

it('a disappeared ledger after a response blocks acceptance rather than recreating financial state', async () => {
  const f = await fixture(); let fetches = 0;
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: f.make(), fetch: async () => { fetches++; await rm(f.file); return answer(); } });
  await assert.rejects(invoke(transcribe));
  assert.equal(fetches, 1);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.ok((await readFile(f.oneShotFile)).length > 0);
});

it('keeps success, HTTP failure, invalid response and unknown outcomes reserved with one attempt', async () => {
  for (const respond of [answer, () => new Response('', { status: 502 }), () => Response.json({ turns: [] }),
    () => { throw new Error('transport'); }]) {
    const f = await fixture(); const budget = f.make(); let fetches = 0;
    const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, fetch: async () => { fetches++; return respond(); } });
    await invoke(transcribe);
    assert.equal((await budget.read()).entries[0].state, 'reserved');
    assert.equal((await invoke(transcribe)).reason, 'budget');
    assert.equal(fetches, 1);
  }
});

it('strict timeout sends once and keeps its reservation and permanent marker', async () => {
  const f = await fixture(); const budget = f.make(); let fetches = 0;
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, timeoutMs: 500,
    fetch: (url, init) => { fetches++; return new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }); } });
  const result = await invoke(transcribe);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.unknown, true);
  assert.equal(result.call.dispatched, true);
  assert.equal(fetches, 1);
  assert.equal((await budget.read()).entries[0].state, 'reserved');
  assert.equal(await f.make().reserve(0.00005), null);
});

it('a failed reservation write leaves its marker permanently refusing further attempts', async () => {
  const f = await fixture(); const budget = f.make(); let fetches = 0;
  budget.write = async () => { throw new Error('simulated persistence failure'); };
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger: budget, fetch: async () => { fetches++; return answer(); } });
  await assert.rejects(invoke(transcribe));
  assert.equal(fetches, 0);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).entries.length, 0);
  assert.ok((await readFile(f.oneShotFile)).length > 0);
  await assert.rejects(f.make().reserve(0.00005));
});

it('a permanent marker refuses reset ledgers, partial marker writes and competing instances', async () => {
  const f = await fixture();
  const reservations = await Promise.allSettled([f.make().reserve(0.00005), f.make().reserve(0.00005)]);
  assert.equal(reservations.filter((r) => r.status === 'fulfilled' && r.value).length, 1);
  await writeFile(f.file, '{"entries":[]}\n');
  await assert.rejects(f.make().reserve(0.00005));
  await writeFile(f.oneShotFile, 'partial');
  await assert.rejects(f.make().reserve(0.00005));
});

it('default standalone admission retains its legacy refund behavior explicitly', async () => {
  const f = await fixture({ initialize: false });
  const ledger = new BudgetLedger({ file: f.file }); let fetches = 0;
  const transcribe = api.createMetaTranscriber({ apiKey: 'fake', ledger, fetch: async () => { fetches++; return answer(); } });
  const result = await invoke(transcribe, async (start) => { start(); throw new Error('legacy admission'); });
  assert.equal(fetches, 1);
  assert.equal(result.call.dispatched, false);
  assert.equal((await ledger.read()).entries[0].estimatedUsd, 0);
  await assert.rejects(readFile(f.oneShotFile), { code: 'ENOENT' });
});

it('strict environment selection requires explicit bounded limits and an explicit marker path', async () => {
  const f = await fixture();
  const env = { MODEL_API_KEY: 'fake', REHERE_TRANSCRIBE_LIVE: '1', REHERE_TRANSCRIBE_STRICT: '1',
    REHERE_TRANSCRIBE_TOTAL_USD: '0.003', REHERE_TRANSCRIBE_MAX_REQUESTS: '1' };
  assert.equal(typeof api.metaTranscriberFromEnv({ ledgerFile: f.file, oneShotFile: f.oneShotFile, env }), 'function');
  assert.throws(() => api.metaTranscriberFromEnv({ ledgerFile: f.file, env }));
  for (const patch of [{ REHERE_TRANSCRIBE_TOTAL_USD: undefined }, { REHERE_TRANSCRIBE_MAX_REQUESTS: undefined },
    { REHERE_TRANSCRIBE_TOTAL_USD: 'NaN' }, { REHERE_TRANSCRIBE_TOTAL_USD: '0.004' }, { REHERE_TRANSCRIBE_TOTAL_USD: '0' },
    { REHERE_TRANSCRIBE_MAX_REQUESTS: '1.5' }, { REHERE_TRANSCRIBE_MAX_REQUESTS: '2' }]) {
    assert.throws(() => api.metaTranscriberFromEnv({ ledgerFile: f.file, oneShotFile: f.oneShotFile, env: { ...env, ...patch } }));
  }
});

for (const phase of ['before-marker', 'partial-marker', 'marker-before-ledger', 'during-ledger-write', 'ledger-before-start', 'after-start']) {
  it(`SIGKILL at ${phase} preserves admission state across restart without another transport`, async () => {
    const f = await fixture();
    const moduleUrl = new URL('../meta-transcribe.mjs', import.meta.url).href;
    const code = `
      import {writeFile,readFile} from 'node:fs/promises';
      import {StrictTranscribeLedger,createMetaTranscriber} from ${JSON.stringify(moduleUrl)};
      const file=${JSON.stringify(f.file)},oneShotFile=${JSON.stringify(f.oneShotFile)},phase=${JSON.stringify(phase)};
      const wait=()=>new Promise(()=>{});const ready=()=>{process.stdout.write('READY\\n');setInterval(()=>{},1000);};
      if(phase==='partial-marker'){await writeFile(oneShotFile,'{',{flag:'wx'});ready();await wait();}
      const ledger=new StrictTranscribeLedger({file,oneShotFile,limits:{totalUsd:.003,perRequestUsd:.003,maxRequests:1}});
      if(phase==='before-marker'){ready();await wait();}
      if(phase==='marker-before-ledger'){ledger.write=async()=>{ready();await wait();};}
      if(phase==='during-ledger-write'){ledger.write=async()=>{await writeFile(file+'.partial.tmp','{',{flag:'wx'});ready();await wait();};}
      if(phase==='marker-before-ledger'||phase==='during-ledger-write'){await ledger.reserve(.00005);}
      if(phase==='ledger-before-start'){await ledger.reserve(.00005);ready();await wait();}
      if(phase==='after-start'){
        const transcribe=createMetaTranscriber({apiKey:'fake',ledger,fetch:()=>{ready();return wait();}});
        await transcribe({wav:Buffer.alloc(32044),durationMs:1000,admit:async start=>({value:start()})});
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', (b) => { errors += b; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (b) => { if (b.toString().includes('READY')) resolve(); });
      child.once('exit', (c) => reject(new Error(`child exited ${c}: ${errors}`)));
    });
    try {
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('child readiness timeout')), 5000).unref())]);
      child.kill('SIGKILL'); await once(child, 'exit');
      const restarted = f.make();
      const state = JSON.parse(await readFile(f.file, 'utf8'));
      if (phase === 'before-marker') {
        assert.deepEqual(await restarted.read(), { entries: [] });
        await assert.rejects(readFile(f.oneShotFile), { code: 'ENOENT' });
        return;
      }
      if (state.entries.length) assert.equal(await restarted.reserve(0.00005), null);
      else await assert.rejects(restarted.reserve(0.00005));
      if (state.entries.length) {
        assert.equal(state.entries[0].state, 'reserved');
        await assert.rejects(restarted.settle(state.entries[0].id, 0));
      }
      assert.ok((await readFile(f.oneShotFile)).length > 0);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
}
