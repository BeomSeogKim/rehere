import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supervisorPath = fileURLToPath(new URL('./full_object_supervisor.py', import.meta.url));
const allowedEnvironment = new Set(['FULL_OBJECT_TRIPOSR_SOURCE', 'FULL_OBJECT_MODEL_DIR', 'FULL_OBJECT_DINO_CONFIG',
  'HF_HOME', 'HF_HUB_CACHE', 'XDG_CACHE_HOME', 'NUMBA_CACHE_DIR', 'TMPDIR']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('The runner requires a protected directory.');
  }
}

// Configuration is trusted deployment input, never a request body or public DTO.
export function createFullObjectRunner({ pythonPath, workerPath, workerSha256, attemptRoot, environment = {}, onCleanupUncertain = () => {} }) {
  if (![pythonPath, workerPath, attemptRoot].every((p) => typeof p === 'string' && path.isAbsolute(p))
    || !/^[a-f0-9]{64}$/.test(workerSha256)
    || Object.keys(environment).some((key) => !allowedEnvironment.has(key))
    || Object.values(environment).some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('The supervised worker configuration is invalid.');
  }
  return async function runFullObject({ imagePath, maskPath, parentSurfacePath, outputDir, signal }) {
    if (signal?.aborted) return { exitCode: 1 };
    const startedEpoch = Date.now() / 1000;
    let attempt, config, log;
    try {
      if (![imagePath, maskPath, parentSurfacePath, outputDir].every((p) => typeof p === 'string' && path.isAbsolute(p))) throw new Error();
      await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
      await privateDirectory(attemptRoot);
      await privateDirectory(outputDir);
      if ((await readdir(outputDir)).length || hash(await readFile(workerPath)) !== workerSha256) throw new Error();
      attempt = await mkdtemp(path.join(await realpath(attemptRoot), 'object-'));
      config = { nonce: randomBytes(16).toString('hex'), worker: await realpath(workerPath), workerSha256,
        imagePath, maskPath, parentSurfacePath, outputDir, environment, startedEpoch };
      await writeFile(path.join(attempt, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      log = await open(path.join(attempt, 'supervisor.log'), 'wx', 0o600);
    } catch {
      await log?.close();
      return { exitCode: 1 };
    }
    return new Promise((resolve) => {
      let child, timer, ready = false, event = null, buffer = '', uncertain = false;
      const reportUncertain = () => {
        if (uncertain) return;
        uncertain = true;
        try { onCleanupUncertain({ attemptDirectory: attempt, reason: 'cleanup_unverified' }); } catch { /* Keep the operation active. */ }
      };
      const abort = () => {
        // Before ready, remember cancellation; the supervisor installs handlers first.
        if (ready) {
          try { child.kill('SIGTERM'); } catch { reportUncertain(); }
        }
      };
      const finish = (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ exitCode });
      };
      try {
        const env = { ...process.env };
        for (const key of ['PYTHONPATH', 'PYTHONHOME', 'TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD']) delete env[key];
        Object.assign(env, { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' });
        child = spawn(pythonPath, ['-I', '-B', supervisorPath, path.join(attempt, 'config.json')], {
          cwd: attempt, env, stdio: ['ignore', 'pipe', log.fd],
        });
      } catch {
        void log.close();
        finish(1);
        return;
      }
      void log.close();
      timer = setTimeout(() => { abort(); if (!ready) reportUncertain(); }, 600_000);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 16384) { buffer = ''; reportUncertain(); abort(); return; }
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.nonce !== config.nonce) throw new Error();
            if (value.phase === 'ready' && Object.keys(value).length === 2 && !ready) {
              ready = true;
              if (signal?.aborted) abort();
            } else if (ready && ['stopped', 'cleanup-unknown'].includes(value.phase)
              && Object.keys(value).length === 3 && [0, 1].includes(value.exitCode) && !event) {
              event = value;
              if (value.phase === 'cleanup-unknown') reportUncertain();
            } else throw new Error();
          } catch { reportUncertain(); abort(); }
        }
      });
      child.stdout.on('error', () => { reportUncertain(); abort(); });
      child.on('error', () => {
        if (!child.pid) finish(1);
        else reportUncertain();
      });
      child.on('close', async (code, terminationSignal) => {
        if (!child.pid) return;
        if (uncertain || !event || event.phase !== 'stopped' || buffer.trim()) { reportUncertain(); return; }
        if (signal?.aborted || terminationSignal || code !== 0 || event.exitCode !== 0) { finish(1); return; }
        try {
          const receiptPath = path.join(attempt, 'supervisor-result.json');
          if ((await lstat(receiptPath)).isSymbolicLink() || (await lstat(receiptPath)).size > 32768) throw new Error();
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
          const handle = receipt.handle;
          if (receipt.nonce !== config.nonce || receipt.status !== 'complete' || receipt.cleanupVerified !== true
            || receipt.reason !== null || receipt.workerExitCode !== 0 || receipt.handle?.workerSha256 !== workerSha256
            || handle?.nonce !== config.nonce || handle?.supervisorPid !== child.pid
            || !Number.isInteger(handle?.pid) || handle.pid <= 0 || handle.pgid !== handle.pid || !Number.isFinite(handle.created)
            || !Number.isInteger(handle?.watchdog?.pid) || handle.watchdog.pid <= 0 || handle.watchdog.pid === handle.pid
            || handle.watchdog.pgid !== handle.pid || !Number.isFinite(handle.watchdog.created)
            || receipt.networkProof?.nonce !== config.nonce || receipt.networkProof?.pid !== handle.pid
            || receipt.networkProof?.pgid !== handle.pid || receipt.networkProof?.watchdogPid !== handle.watchdog.pid
            || receipt.networkProof?.networkDenied !== true) throw new Error();
          const assetInfo = await lstat(path.join(outputDir, 'object.glb'));
          const workerReceiptInfo = await lstat(path.join(outputDir, 'object.json'));
          if (!assetInfo.isFile() || assetInfo.size > 128 * 1024 ** 2 || assetInfo.size < 28
            || !workerReceiptInfo.isFile() || workerReceiptInfo.size > 65536) throw new Error();
          const asset = await readFile(path.join(outputDir, 'object.glb'));
          const workerReceipt = await readFile(path.join(outputDir, 'object.json'));
          if (hash(asset) !== receipt.result?.assetSha256 || hash(workerReceipt) !== receipt.result?.receiptSha256
            || asset.length !== receipt.result?.bytes || hash(await readFile(workerPath)) !== workerSha256) throw new Error();
          finish(signal?.aborted ? 1 : 0);
        } catch { finish(1); }
      });
    });
  };
}
