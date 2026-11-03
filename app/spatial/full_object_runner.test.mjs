import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createFullObjectRunner } from './full_object_runner.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const prefix = `#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const config=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));
const attempt=path.dirname(process.argv.at(-1));
const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const emit=(value)=>console.log(JSON.stringify({nonce:config.nonce,...value}));
function success() {
  const asset=Buffer.alloc(28);asset.write('glTF');asset.writeUInt32LE(2,4);asset.writeUInt32LE(28,8);
  const workerReceipt=Buffer.from('{}');
  fs.writeFileSync(path.join(config.outputDir,'object.glb'),asset);
  fs.writeFileSync(path.join(config.outputDir,'object.json'),workerReceipt);
  const handle={nonce:config.nonce,pid:process.pid+1,pgid:process.pid+1,created:1,supervisorPid:process.pid,workerSha256:config.workerSha256,
    watchdog:{pid:process.pid+2,pgid:process.pid+1,created:1}};
  fs.writeFileSync(path.join(attempt,'supervisor-result.json'),JSON.stringify({nonce:config.nonce,status:'complete',reason:null,cleanupVerified:true,
    workerExitCode:0,handle,networkProof:{nonce:config.nonce,pid:handle.pid,pgid:handle.pid,networkDenied:true,watchdogPid:handle.watchdog.pid},
    result:{assetSha256:hash(asset),receiptSha256:hash(workerReceipt),bytes:asset.length}}));
}
emit({phase:'ready'});
`;

async function fixture(t, script, onCleanupUncertain = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'object-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  const attempts = path.join(root, 'attempts');
  await mkdir(output, { mode: 0o700 });
  const interpreter = path.join(root, 'dummy-interpreter.mjs');
  await writeFile(interpreter, prefix + script, { mode: 0o700 });
  await chmod(interpreter, 0o700);
  const worker = path.join(root, 'dummy-worker.py');
  await writeFile(worker, 'pass\n');
  const input = path.join(root, 'input');
  await writeFile(input, 'synthetic');
  return { root, output, attempts, worker,
    run: createFullObjectRunner({ pythonPath: interpreter, workerPath: worker, workerSha256: hash('pass\n'), attemptRoot: attempts, onCleanupUncertain }),
    args: { imagePath: input, maskPath: input, parentSurfacePath: input, outputDir: output } };
}

test('settles success only after stopped event, process close and bound private receipt', async (t) => {
  const f = await fixture(t, "success();emit({phase:'stopped',exitCode:0});");
  assert.deepEqual(await f.run(f.args), { exitCode: 0 });
  assert.deepEqual((await readdir(f.output)).sort(), ['object.glb', 'object.json']);
  const [attempt] = await readdir(f.attempts);
  const config = JSON.parse(await readFile(path.join(f.attempts, attempt, 'config.json')));
  assert.equal(config.workerSha256, hash('pass\n'));
});

test('missing supervisor receipt fails despite success exit and stop event', async (t) => {
  const f = await fixture(t, "emit({phase:'stopped',exitCode:0});");
  assert.deepEqual(await f.run(f.args), { exitCode: 1 });
});

test('missing independent EOF watchdog binding cannot report success', async (t) => {
  const f = await fixture(t, "success();const p=path.join(attempt,'supervisor-result.json');const v=JSON.parse(fs.readFileSync(p));delete v.handle.watchdog;fs.writeFileSync(p,JSON.stringify(v));emit({phase:'stopped',exitCode:0});");
  assert.deepEqual(await f.run(f.args), { exitCode: 1 });
});

test('tampered asset fails its private binding', async (t) => {
  const f = await fixture(t, "success();fs.appendFileSync(path.join(config.outputDir,'object.glb'),'changed');emit({phase:'stopped',exitCode:0});");
  assert.deepEqual(await f.run(f.args), { exitCode: 1 });
});

test('changed producer bytes cannot report success', async (t) => {
  const f = await fixture(t, "success();fs.appendFileSync(config.worker,'# changed');emit({phase:'stopped',exitCode:0});");
  assert.deepEqual(await f.run(f.args), { exitCode: 1 });
});

test('already aborted attempt creates no child or output', async (t) => {
  const f = await fixture(t, 'throw new Error("must not run");');
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.run({ ...f.args, signal: controller.signal }), { exitCode: 1 });
  assert.deepEqual(await readdir(f.output), []);
});

test('abort remembered before ready reaches supervisor and waits for stopped', async (t) => {
  const f = await fixture(t, "process.on('SIGTERM',()=>{setTimeout(()=>{emit({phase:'stopped',exitCode:1});process.exit(1);},30);});setInterval(()=>{},100);");
  const controller = new AbortController();
  const operation = f.run({ ...f.args, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await operation, { exitCode: 1 });
});

test('unverified cleanup reports privately and never settles even after supervisor exit', async (t) => {
  let reported;
  const notice = new Promise((resolve) => { reported = resolve; });
  const f = await fixture(t, "emit({phase:'cleanup-unknown',exitCode:1});", reported);
  const operation = f.run(f.args);
  const detail = await notice;
  assert.equal(detail.reason, 'cleanup_unverified');
  assert.ok(detail.attemptDirectory.startsWith(await realpath(f.attempts)));
  assert.equal(await Promise.race([operation.then(() => 'settled'), delay(40, 'pending')]), 'pending');
});

test('unexpected supervisor death retains cleanup uncertainty', async (t) => {
  let reported;
  const notice = new Promise((resolve) => { reported = resolve; });
  const f = await fixture(t, 'process.exit(7);', reported);
  const operation = f.run(f.args);
  await notice;
  assert.equal(await Promise.race([operation.then(() => 'settled'), delay(40, 'pending')]), 'pending');
});

test('wrong nonce never establishes cleanup', async (t) => {
  let reported;
  const notice = new Promise((resolve) => { reported = resolve; });
  const f = await fixture(t, "console.log(JSON.stringify({nonce:'wrong',phase:'stopped',exitCode:1}));", reported);
  const operation = f.run(f.args);
  await notice;
  assert.equal(await Promise.race([operation.then(() => 'settled'), delay(40, 'pending')]), 'pending');
});

test('nonempty output fails without deleting existing bytes', async (t) => {
  const f = await fixture(t, 'throw new Error("must not run");');
  await writeFile(path.join(f.output, 'existing'), 'preserve');
  assert.deepEqual(await f.run(f.args), { exitCode: 1 });
  assert.equal(await readFile(path.join(f.output, 'existing'), 'utf8'), 'preserve');
});

test('missing interpreter is a safe pre-launch failure', async (t) => {
  const f = await fixture(t, 'throw new Error("must not run");');
  const run = createFullObjectRunner({ pythonPath: path.join(f.root, 'missing'), workerPath: f.worker,
    workerSha256: hash('pass\n'), attemptRoot: f.attempts });
  assert.deepEqual(await run(f.args), { exitCode: 1 });
});
