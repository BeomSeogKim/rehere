import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pythonRunner } from '../reconstructions.mjs';
import { ownerFetch as fetch, startOwnerServer } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Synthetic images whose headers carry real dimensions; no personal media.
function png(width, height, fill = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), header, Buffer.alloc(36, fill)]);
}

function jpeg(width, height, fill = 0) {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), frame, Buffer.alloc(32, fill), Buffer.from([0xff, 0xd9])]);
}

const PHOTO = png(40, 30, 7);
const OTHER_PHOTO = jpeg(64, 48, 9);
const BOX = [4, 3, 20, 25];

const tempDirs = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-scene-'));
  tempDirs.push(dir);
  return dir;
}
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

// Writes the worker's six outputs from the actual input file, like reconstruct.py.
async function writeOutputs({ imagePath, outputDir, sourceId, box }, change = {}) {
  const original = await readFile(imagePath);
  const size = original[0] === 0x89 ? [original.readUInt32BE(16), original.readUInt32BE(20)] : [original.readUInt16BE(15), original.readUInt16BE(13)];
  const texture = jpeg(...size, 1);
  const width = 4;
  const height = 3;
  const surface = {
    source: {
      source_id: sourceId,
      sha256: sha256(original),
      format: 'PNG',
      image_size: size,
      texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' },
      selected_object: { id: 'foreground', box_xyxy: box },
    },
    width,
    height,
    depth: Array(width * height).fill(3),
    foreground: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
    ...change.surface,
  };
  const summary = { source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture) };
  const files = {
    'texture.jpg': texture,
    'depth-preview.png': png(width, height),
    'mask.png': png(...size),
    'mask-overlay.jpg': jpeg(...size, 2),
    'surface.json': JSON.stringify(surface),
    'summary.json': JSON.stringify(summary),
    ...change.files,
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) if (content !== null) await writeFile(path.join(outputDir, name), content);
}

function fakeRunner(behaviour = async (call) => { await writeOutputs(call); return { exitCode: 0, stderr: '' }; }) {
  const calls = [];
  const runner = async (call) => {
    calls.push({ ...call, bytes: await readFile(call.imagePath) });
    return behaviour(call, calls.length);
  };
  runner.calls = calls;
  return runner;
}

// Content routes require the owner session; requests go through that client.
const start = startOwnerServer;

const grants = (place, model) => ({
  provider: 'Synthetic',
  origin: { kind: 'own', reference: '' },
  permissions: { place, model, share: false },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

async function saveDraft(base, { photos = [PHOTO], permissions = photos.map(() => grants(true, true)), text } = {}) {
  const body = new FormData();
  if (text) body.append('text', text);
  for (const bytes of photos) body.append('photos', new Blob([bytes]), 'photo');
  body.append('metadata', JSON.stringify({ photos: permissions }));
  const response = await fetch(`${base}/api/drafts`, { method: 'POST', body });
  assert.equal(response.status, 201);
  return response.json();
}

const postJson = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const build = (base, draft, body) => postJson(`${base}/api/drafts/${draft.id}/reconstructions`, body);
const buildBody = (draft, change = {}) => ({ requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: BOX, ...change });

async function waitFor(base, draftId, jobId, statuses = ['ready', 'failed', 'interrupted']) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await (await fetch(`${base}/api/drafts/${draftId}/reconstructions/${jobId}`)).json();
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not settle');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('reconstruction builds', () => {
  it('builds a source-linked scene from the stored original without changing it', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner();
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const draft = await saveDraft(app.base, { photos: [PHOTO, OTHER_PHOTO] });
      const draftFile = await readFile(path.join(dataDir, 'drafts', draft.id, 'draft.json'));
      const second = draft.sources[1];
      const accepted = await build(app.base, draft, buildBody(draft, { sourceId: second.id, box: [1, 2, 60, 40] }));
      assert.equal(accepted.status, 202);
      const queued = await accepted.json();
      assert.equal(queued.draftId, draft.id);
      assert.deepEqual(queued.edit, { version: 1, offset: [0, 0, 0], yaw: 0 });
      assert.deepEqual(queued.derivedAssets, []);
      assert.equal(queued.edits, undefined);

      const job = await waitFor(app.base, draft.id, queued.id);
      assert.equal(job.status, 'ready', job.error);
      assert.equal(job.error, null);
      assert.equal(job.sourceId, second.id);
      assert.equal(job.sourceSha256, second.sha256);
      assert.deepEqual(job.box, [1, 2, 60, 40]);
      assert.deepEqual(Object.keys(job).sort(), ['box', 'createdAt', 'derivedAssets', 'draftId', 'edit', 'error', 'id', 'requestId', 'sourceId', 'sourceSha256', 'status', 'updatedAt']);

      assert.equal(runner.calls.length, 1);
      assert.deepEqual(runner.calls[0].bytes, OTHER_PHOTO, 'the selected uploaded image reaches the runner');
      assert.deepEqual(runner.calls[0].box, [1, 2, 60, 40]);
      assert.equal(runner.calls[0].sourceId, second.id);

      assert.deepEqual(job.derivedAssets.map((item) => item.name).sort(), ['depth-preview.png', 'mask-overlay.jpg', 'mask.png', 'summary.json', 'surface.json', 'texture.jpg']);
      for (const item of job.derivedAssets) {
        assert.equal(item.role, 'derived');
        assert.equal(item.parentSourceId, second.id);
        const served = await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}/assets/${item.name}`);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get('content-type'), item.type);
        const bytes = Buffer.from(await served.arrayBuffer());
        assert.equal(sha256(bytes), item.sha256);
        assert.equal(bytes.length, item.size);
      }
      const surface = await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}/assets/surface.json`)).json();
      assert.equal(surface.source.source_id, second.id);
      assert.equal(surface.source.sha256, second.sha256);

      assert.deepEqual(await readFile(path.join(dataDir, 'drafts', draft.id, 'draft.json')), draftFile, 'draft and source records unchanged');
      const original = Buffer.from(await (await fetch(`${app.base}/api/drafts/${draft.id}/assets/${second.name}`)).arrayBuffer());
      assert.deepEqual(original, OTHER_PHOTO);

      const list = await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions`)).json();
      assert.deepEqual(list, [job]);
      assert.deepEqual(await readdir(path.join(dataDir, 'reconstruction-staging')), []);
    } finally {
      await app.close();
    }
  });

  it('serves only recorded outputs of ready jobs inside the data folder', async () => {
    const dataDir = await tempDir();
    const app = await start({ dataDir, reconstructionRunner: fakeRunner() });
    try {
      const draft = await saveDraft(app.base);
      const job = await waitFor(app.base, draft.id, (await (await build(app.base, draft, buildBody(draft))).json()).id);
      const prefix = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
      const targets = [
        `${prefix}/assets/manifest.json`,
        `${prefix}/assets/..%2fmanifest.json`,
        `${prefix}/assets/photo-1.png`,
        `/api/drafts/${draft.id}/reconstructions/not-a-job`,
        `/api/drafts/${draft.id}/reconstructions/${randomUUID()}`,
        `/api/drafts/..%2f..%2fdrafts/reconstructions/${job.id}`,
        `/api/drafts/${randomUUID()}/reconstructions/${job.id}/assets/texture.jpg`,
      ];
      for (const target of targets) assert.equal((await fetch(`${app.base}${target}`)).status, 404, target);
      assert.deepEqual(await (await fetch(`${app.base}/api/drafts/not-a-draft/reconstructions`)).json(), []);
      assert.equal((await fetch(`${app.base}${prefix}`, { method: 'DELETE' })).status, 405);
    } finally {
      await app.close();
    }
  });

  it('refuses sources without both grants, legacy drafts, text and unknown sources before running', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner();
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const draft = await saveDraft(app.base, {
        photos: [PHOTO, PHOTO, PHOTO],
        permissions: [grants(true, false), grants(false, true), grants(false, false)],
        text: 'A note',
      });
      for (const source of draft.sources.filter((item) => item.kind === 'photo')) {
        const response = await build(app.base, draft, buildBody(draft, { sourceId: source.id }));
        assert.equal(response.status, 403);
        assert.match((await response.json()).error, /permission/);
      }
      assert.equal((await build(app.base, draft, buildBody(draft, { sourceId: draft.textSourceId }))).status, 400);
      assert.equal((await build(app.base, draft, buildBody(draft, { sourceId: randomUUID() }))).status, 404);
      assert.equal((await postJson(`${app.base}/api/drafts/${randomUUID()}/reconstructions`, buildBody(draft))).status, 404);
      assert.equal((await postJson(`${app.base}/api/drafts/not-an-id/reconstructions`, buildBody(draft))).status, 404);

      const legacyId = randomUUID();
      await mkdir(path.join(dataDir, 'drafts', legacyId));
      await writeFile(path.join(dataDir, 'drafts', legacyId, 'draft.json'), JSON.stringify({ id: legacyId, createdAt: '2026-10-01T00:00:00.000Z', text: '', photos: [{ name: 'photo-1.png', type: 'image/png', size: PHOTO.length }], voice: null }));
      await writeFile(path.join(dataDir, 'drafts', legacyId, 'photo-1.png'), PHOTO);
      const legacy = await postJson(`${app.base}/api/drafts/${legacyId}/reconstructions`, buildBody(draft));
      assert.equal(legacy.status, 403);
      assert.match((await legacy.json()).error, /before source details existed/);

      assert.equal(runner.calls.length, 0);
      assert.deepEqual(await readdir(path.join(dataDir, 'reconstructions')).catch(() => []), []);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed bodies, boxes and cross-site requests before running', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner();
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const draft = await saveDraft(app.base);
      const url = `${app.base}/api/drafts/${draft.id}/reconstructions`;
      const valid = buildBody(draft);
      const cases = [
        [{ ...valid, extra: true }, 400],
        [{ requestId: valid.requestId, sourceId: valid.sourceId }, 400],
        [{ ...valid, requestId: 'not-a-uuid' }, 400],
        [{ ...valid, requestId: valid.requestId.toUpperCase() }, 400],
        [{ ...valid, sourceId: 7 }, 400],
        [{ ...valid, box: [1, 2, 3] }, 400],
        [{ ...valid, box: ['1', 2, 3, 4] }, 400],
        [{ ...valid, box: [5, 5, 5, 10] }, 400],
        [{ ...valid, box: [5, 9, 10, 2] }, 400],
        [{ ...valid, box: [-1, 0, 10, 10] }, 400],
        [{ ...valid, box: [0, 0, 41, 30] }, 400],
        [{ ...valid, box: [0, 0, 40, 31] }, 400],
        [[valid], 400],
        ['{"requestId":', 400],
        ['1e999', 400],
      ];
      for (const [body, status] of cases) assert.equal((await postJson(url, body)).status, status, JSON.stringify(body));
      assert.match((await (await postJson(url, { ...valid, box: [0, 0, 41, 30] })).json()).error, /40 x 30/);
      assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(valid) })).status, 415);
      assert.equal((await postJson(url, JSON.stringify({ ...valid, pad: 'x'.repeat(17_000) }))).status, 413);
      assert.equal((await postJson(url, valid, { origin: 'https://attacker.example' })).status, 403);
      assert.equal(runner.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('refuses an original whose bytes no longer match the recorded checksum', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner();
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const draft = await saveDraft(app.base);
      await writeFile(path.join(dataDir, 'drafts', draft.id, draft.photos[0].name), png(40, 30, 8));
      const response = await build(app.base, draft, buildBody(draft));
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /checksum/);
      assert.equal(runner.calls.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('reconstruction idempotency and concurrency', () => {
  it('returns the same job for a repeated request, also after restart, and rejects a changed one', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner();
    const first = await start({ dataDir, reconstructionRunner: runner });
    const draft = await saveDraft(first.base, { photos: [PHOTO, PHOTO] });
    const body = buildBody(draft);
    const job = await (await build(first.base, draft, body)).json();
    await waitFor(first.base, draft.id, job.id);
    const replay = await build(first.base, draft, body);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).id, job.id);
    assert.equal((await build(first.base, draft, { ...body, box: [4, 3, 21, 25] })).status, 409);
    assert.equal((await build(first.base, draft, { ...body, sourceId: draft.photos[1].sourceId })).status, 409);
    await first.close();

    const second = await start({ dataDir, reconstructionRunner: runner });
    try {
      const again = await (await build(second.base, draft, body)).json();
      assert.equal(again.id, job.id);
      assert.equal(again.status, 'ready');
      assert.equal(runner.calls.length, 1);
    } finally {
      await second.close();
    }
  });

  it('runs one model process at a time and rejects a distinct build while busy', async () => {
    const dataDir = await tempDir();
    const release = deferred();
    const runner = fakeRunner(async (call) => {
      await release.promise;
      await writeOutputs(call);
      return { exitCode: 0, stderr: '' };
    });
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const draft = await saveDraft(app.base);
      // Each request is session-checked first, so either may reach the store first.
      const bodies = [buildBody(draft), buildBody(draft)];
      const responses = await Promise.all(bodies.map((item) => build(app.base, draft, item)));
      assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
      const winner = responses.findIndex((response) => response.status === 202);
      const body = bodies[winner];
      assert.match((await responses[1 - winner].json()).error, /Try again when it finishes/);
      const job = await responses[winner].json();
      const replay = await build(app.base, draft, body);
      assert.equal(replay.status, 202, 'a replay is answered even while busy');
      assert.equal((await replay.json()).id, job.id);
      assert.equal((await waitFor(app.base, draft.id, job.id, ['processing'])).status, 'processing');
      assert.equal((await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}/assets/surface.json`)).status, 404);
      release.resolve();
      assert.equal((await waitFor(app.base, draft.id, job.id)).status, 'ready');
      const next = await build(app.base, draft, buildBody(draft));
      assert.equal(next.status, 202, 'free again after finishing');
      await waitFor(app.base, draft.id, (await next.json()).id);
      assert.equal(runner.calls.length, 2);
    } finally {
      release.resolve();
      await app.close();
    }
  });
});

describe('reconstruction failures', () => {
  async function failedJob(behaviour) {
    const dataDir = await tempDir();
    const app = await start({ dataDir, reconstructionRunner: fakeRunner(behaviour) });
    try {
      const draft = await saveDraft(app.base);
      const queued = await (await build(app.base, draft, buildBody(draft))).json();
      const job = await waitFor(app.base, draft.id, queued.id);
      const asset = await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}/assets/surface.json`);
      assert.equal(asset.status, 404);
      assert.deepEqual(job.derivedAssets, []);
      assert.deepEqual(await readdir(path.join(dataDir, 'reconstruction-staging')), []);
      return job;
    } finally {
      await app.close();
    }
  }

  it('reports fixed plain messages per failure category and never worker output', async () => {
    const stderr = 'Traceback\nerror: cannot read /secret or /example/some one/My Photos/a b.png: token=abc\n';
    const setup = await failedJob(async () => ({ exitCode: 3, stderr }));
    assert.equal(setup.status, 'failed');
    assert.match(setup.error, /app\/spatial\/README\.md/);

    const input = await failedJob(async () => ({ exitCode: 2, stderr }));
    assert.equal(input.error, 'The photo or selected box could not be used. Adjust the box or choose another photo.');

    const rejected = await failedJob(async () => ({ exitCode: 4, stderr }));
    assert.equal(rejected.error, 'The model could not separate a usable foreground and background from this selection. Try a different box or photo.');
    for (const job of [setup, input, rejected]) assert.doesNotMatch(job.error, /secret|example|Photos|token|Traceback/);

    const crashed = await failedJob(async () => ({ exitCode: 1, stderr: 'Segmentation fault at /opt/secret\n' }));
    assert.equal(crashed.error, 'The scene could not be built. Please try again.');
    const thrown = await failedJob(async () => {
      throw new Error('boom');
    });
    assert.equal(thrown.status, 'failed');
  });

  it('fails honestly when the configured Python cannot be started', async () => {
    const job = await failedJob((call) => pythonRunner({ python: path.join(os.tmpdir(), `missing-python-${randomUUID()}`) })(call));
    assert.equal(job.status, 'failed');
    assert.match(job.error, /not set up/);
  });

  it('does not publish incomplete, mismatched or unrenderable outputs', async () => {
    const outputs = (change) => async (call) => {
      await writeOutputs(call, change);
      return { exitCode: 0, stderr: '' };
    };
    const checkerboard = { foreground: [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0] };
    const cases = [
      { files: { 'summary.json': null } },
      { files: { 'extra.txt': 'x' } },
      { files: { 'mask.png': jpeg(40, 30) } },
      { files: { 'mask.png': png(20, 15) } },
      { files: { 'texture.jpg': jpeg(40, 30, 3) } },
      { files: { 'surface.json': '{not json' } },
      { surface: { depth: Array(12).fill(9) } },
      { surface: { depth: Array(11).fill(3) } },
      { surface: { foreground: Array(12).fill(1) } },
      { surface: checkerboard },
      { surface: { depth: [2, 4.9, 2, 4.9, 4.9, 2, 4.9, 2, 2, 4.9, 2, 4.9] } },
      { surface: { source: { source_id: randomUUID() } } },
      ...[undefined, 0, 180, -10, '55', null].map((fov) => ({
        surface: { assumptions: { horizontal_fov_degrees: fov, near: 2, far: 5, max_triangle_depth_span: 0.35 } },
      })),
      { surface: { assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5 } } },
      { surface: { assumptions: { horizontal_fov_degrees: 55, near: 0, far: 5, max_triangle_depth_span: 0.35 } } },
    ];
    for (const change of cases) {
      const job = await failedJob(outputs(change));
      assert.equal(job.status, 'failed', JSON.stringify(change));
      assert.match(job.error, /incomplete or inconsistent/);
    }
    const wrongBox = await failedJob(async (call) => {
      await writeOutputs({ ...call, box: [0, 0, 1, 1] });
      return { exitCode: 0, stderr: '' };
    });
    assert.equal(wrongBox.status, 'failed');
    const otherOriginal = await failedJob(async (call) => {
      const imagePath = path.join(path.dirname(call.outputDir), 'other.png');
      await writeFile(imagePath, png(40, 30, 99));
      await writeOutputs({ ...call, imagePath });
      return { exitCode: 0, stderr: '' };
    });
    assert.equal(otherOriginal.status, 'failed');
  });

  it('keeps an earlier ready scene unchanged when a later build fails', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner(async (call, count) => {
      if (count === 2) return { exitCode: 4, stderr: 'error: depth prediction is constant\n' };
      await writeOutputs(call);
      return { exitCode: 0, stderr: '' };
    });
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const draft = await saveDraft(app.base);
      const ready = await waitFor(app.base, draft.id, (await (await build(app.base, draft, buildBody(draft))).json()).id);
      const texture = Buffer.from(await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${ready.id}/assets/texture.jpg`)).arrayBuffer());
      const failed = await waitFor(app.base, draft.id, (await (await build(app.base, draft, buildBody(draft))).json()).id);
      assert.equal(failed.status, 'failed');
      assert.deepEqual(await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${ready.id}`)).json(), ready);
      assert.deepEqual(Buffer.from(await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${ready.id}/assets/texture.jpg`)).arrayBuffer()), texture);
    } finally {
      await app.close();
    }
  });

  it('stops a build at the timeout and discards its late result', async () => {
    const dataDir = await tempDir();
    const late = deferred();
    let signal;
    const runner = fakeRunner(async (call) => {
      signal = call.signal;
      await late.promise;
      await writeOutputs(call).catch(() => {});
      return { exitCode: 0, stderr: '' };
    });
    const app = await start({ dataDir, reconstructionRunner: runner, reconstructionTimeoutMs: 50 });
    try {
      const draft = await saveDraft(app.base);
      const queued = await (await build(app.base, draft, buildBody(draft))).json();
      const job = await waitFor(app.base, draft.id, queued.id);
      assert.equal(job.status, 'failed');
      assert.match(job.error, /longer than/);
      assert.equal(signal.aborted, true);
      late.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${queued.id}`)).json();
      assert.equal(after.status, 'failed');
      assert.equal((await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${queued.id}/assets/surface.json`)).status, 404);
      assert.equal((await build(app.base, draft, buildBody(draft))).status, 202, 'the slot is released');
    } finally {
      late.resolve();
      await app.close();
    }
  });
});

describe('reconstruction restart and shutdown', () => {
  it('marks the active build interrupted when the server closes', async () => {
    const dataDir = await tempDir();
    const started = deferred();
    let signal;
    const runner = fakeRunner(async (call) => {
      signal = call.signal;
      started.resolve();
      await new Promise(() => {});
    });
    const app = await start({ dataDir, reconstructionRunner: runner });
    const draft = await saveDraft(app.base);
    const queued = await (await build(app.base, draft, buildBody(draft))).json();
    await started.promise;
    await app.close();
    assert.equal(signal.aborted, true);
    let manifest;
    for (let attempt = 0; attempt < 100; attempt++) {
      manifest = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', draft.id, queued.id, 'manifest.json'), 'utf8'));
      if (manifest.status !== 'processing') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manifest.status, 'interrupted');
  });

  it('turns stale queued or processing jobs into interrupted ones on restart and keeps ready ones', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir, reconstructionRunner: fakeRunner() });
    const draft = await saveDraft(first.base);
    const ready = await waitFor(first.base, draft.id, (await (await build(first.base, draft, buildBody(draft))).json()).id);
    await first.close();

    const staleIds = [randomUUID(), randomUUID()];
    for (const [index, id] of staleIds.entries()) {
      const dir = path.join(dataDir, 'reconstructions', draft.id, id);
      await mkdir(dir);
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...ready, id, requestId: randomUUID(), status: ['queued', 'processing'][index], derivedAssets: [], edits: [] }));
    }
    await mkdir(path.join(dataDir, 'reconstruction-staging', staleIds[1], 'output'), { recursive: true });

    const second = await start({ dataDir, reconstructionRunner: fakeRunner() });
    try {
      for (const id of staleIds) {
        const job = await (await fetch(`${second.base}/api/drafts/${draft.id}/reconstructions/${id}`)).json();
        assert.equal(job.status, 'interrupted');
        assert.match(job.error, /stopped before/);
      }
      assert.deepEqual(await (await fetch(`${second.base}/api/drafts/${draft.id}/reconstructions/${ready.id}`)).json(), ready);
      assert.deepEqual(await readdir(dataDir).then((names) => names.includes('reconstruction-staging')), false);
    } finally {
      await second.close();
    }
  });
});

describe('reconstruction edits', () => {
  async function readyScene(options = {}) {
    const dataDir = options.dataDir ?? (await tempDir());
    const app = await start({ dataDir, reconstructionRunner: fakeRunner(options.behaviour) });
    const draft = await saveDraft(app.base);
    const job = await waitFor(app.base, draft.id, (await (await build(app.base, draft, buildBody(draft))).json()).id);
    const url = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}/edit`;
    return { app, dataDir, draft, job, url };
  }

  const editBody = (change = {}) => ({ requestId: randomUUID(), baseVersion: 1, offset: [0.5, -0.25, 1], yaw: 0.75, ...change });

  it('saves versioned transforms, replays a request and keeps them across restart', async () => {
    const { app, dataDir, draft, job, url } = await readyScene();
    const surfaceBefore = await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}/assets/surface.json`)).text();
    const body = editBody();
    const saved = await postJson(url, body);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { version: 2, offset: [0.5, -0.25, 1], yaw: 0.75 });
    const replay = await postJson(url, body);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { version: 2, offset: [0.5, -0.25, 1], yaw: 0.75 });
    assert.equal((await postJson(url, { ...body, yaw: 0.5 })).status, 409);
    const stale = await postJson(url, editBody({ baseVersion: 1 }));
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /Reload the saved version/);
    assert.deepEqual(await (await postJson(url, editBody({ baseVersion: 2, offset: [-2, 2, 0], yaw: -Math.PI }))).json(), { version: 3, offset: [-2, 2, 0], yaw: -Math.PI });
    await app.close();

    const reopened = await start({ dataDir, reconstructionRunner: fakeRunner() });
    try {
      const restored = await (await fetch(`${reopened.base}/api/drafts/${draft.id}/reconstructions/${job.id}`)).json();
      assert.deepEqual(restored.edit, { version: 3, offset: [-2, 2, 0], yaw: -Math.PI });
      assert.equal(restored.edits, undefined);
      assert.equal(await (await fetch(`${reopened.base}/api/drafts/${draft.id}/reconstructions/${job.id}/assets/surface.json`)).text(), surfaceBefore, 'surface data is not rewritten by edits');
    } finally {
      await reopened.close();
    }
  });

  it('lets only one of two concurrent edits from the same base win', async () => {
    const { app, url } = await readyScene();
    try {
      const responses = await Promise.all([postJson(url, editBody()), postJson(url, editBody({ yaw: -1 }))]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid edits and edits of unfinished or unknown scenes', async () => {
    const { app, draft, url } = await readyScene();
    try {
      const invalid = [
        editBody({ extra: 1 }),
        { requestId: randomUUID(), baseVersion: 1, offset: [0, 0, 0] },
        editBody({ baseVersion: 0 }),
        editBody({ baseVersion: 1.5 }),
        editBody({ baseVersion: '1' }),
        editBody({ offset: [0, 0] }),
        editBody({ offset: [0, 0, 2.01] }),
        editBody({ offset: [0, '0', 0] }),
        editBody({ yaw: 3.2 }),
        editBody({ yaw: null }),
        editBody({ requestId: 'x' }),
      ];
      for (const body of invalid) assert.equal((await postJson(url, body)).status, 400, JSON.stringify(body));
      assert.equal((await postJson(`${app.base}/api/drafts/${draft.id}/reconstructions/${randomUUID()}/edit`, editBody())).status, 404);
    } finally {
      await app.close();
    }
  });

  it('rejects an edit of a scene that is not ready', async () => {
    const { app, url } = await readyScene({ behaviour: async () => ({ exitCode: 4, stderr: '' }) });
    try {
      const response = await postJson(url, editBody());
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /Only a finished scene/);
    } finally {
      await app.close();
    }
  });

  it('leaves the saved transform intact when saving fails', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const { app, dataDir, draft, job, url } = await readyScene();
    const jobDir = path.join(dataDir, 'reconstructions', draft.id, job.id);
    try {
      await chmod(jobDir, 0o500);
      const failed = await postJson(url, editBody());
      assert.equal(failed.status, 500);
      await chmod(jobDir, 0o700);
      const current = await (await fetch(`${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`)).json();
      assert.deepEqual(current.edit, { version: 1, offset: [0, 0, 0], yaw: 0 });
      assert.equal((await postJson(url, editBody())).status, 200, 'a retry from the saved base succeeds');
    } finally {
      await chmod(jobDir, 0o700);
      await app.close();
    }
  });
});

describe('vendor modules', () => {
  it('serves pinned Three.js files with OrbitControls importing the local module', async () => {
    const app = await start({ dataDir: await tempDir(), reconstructionRunner: fakeRunner() });
    try {
      const controls = await fetch(`${app.base}/vendor/OrbitControls.js`);
      assert.equal(controls.status, 200);
      assert.match(controls.headers.get('content-type'), /text\/javascript/);
      assert.match(controls.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(controls.headers.get('x-content-type-options'), 'nosniff');
      const text = await controls.text();
      assert.match(text, /from '\/vendor\/three\.module\.js';/);
      assert.doesNotMatch(text, /from 'three'/);
      const module = await (await fetch(`${app.base}/vendor/three.module.js`)).text();
      assert.match(module, /from '\.\/three\.core\.js'/);
      assert.equal((await fetch(`${app.base}/vendor/three.core.js`)).status, 200);
      assert.match(await (await fetch(`${app.base}/vendor/THREE-LICENSE`)).text(), /MIT License/);
      for (const target of ['/vendor/', '/vendor/three.cjs', '/vendor/..%2fpackage.json', '/node_modules/three/build/three.module.js']) {
        assert.equal((await fetch(`${app.base}${target}`)).status, 404, target);
      }
    } finally {
      await app.close();
    }
  });
});

describe('reconstruction publication', () => {
  // Holds the move of finished outputs into place so cancellation can land
  // between that move and the ready manifest write.
  async function pausedPromotion(stop, options = {}) {
    const dataDir = await tempDir();
    const original = fs.promises.rename;
    const reached = deferred();
    const resume = deferred();
    fs.promises.rename = async (from, to) => {
      if (String(to).endsWith(`${path.sep}assets`)) {
        reached.resolve();
        await resume.promise;
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    const app = await start({ dataDir, reconstructionRunner: fakeRunner(), ...options });
    try {
      const draft = await saveDraft(app.base);
      const queued = await (await build(app.base, draft, buildBody(draft))).json();
      await reached.promise;
      await stop(app);
      resume.resolve();
      const file = path.join(dataDir, 'reconstructions', draft.id, queued.id, 'manifest.json');
      let manifest;
      for (let attempt = 0; attempt < 200; attempt++) {
        manifest = JSON.parse(await readFile(file, 'utf8'));
        if (!['queued', 'processing'].includes(manifest.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const settled = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(settled, manifest, 'no later contradictory write');
      const published = await readdir(path.dirname(file));
      return { manifest, published };
    } finally {
      resume.resolve();
      fs.promises.rename = original;
      syncBuiltinESMExports();
      await app.close();
    }
  }

  it('does not publish ready when the server closes during promotion', async () => {
    // close() now waits for the paused promotion to settle, so it is awaited
    // only after the promotion is resumed.
    let closing;
    const { manifest, published } = await pausedPromotion((app) => {
      closing = app.close();
    });
    await closing;
    assert.equal(manifest.status, 'interrupted');
    assert.deepEqual(manifest.derivedAssets, []);
    assert.deepEqual(published, ['manifest.json']);
  });

  it('does not publish ready when the timeout fires during promotion', async () => {
    const { manifest, published } = await pausedPromotion(
      () => new Promise((resolve) => setTimeout(resolve, 80)),
      { reconstructionTimeoutMs: 40 },
    );
    assert.equal(manifest.status, 'failed');
    assert.match(manifest.error, /longer than/);
    assert.deepEqual(published, ['manifest.json']);
  });
});

describe('source image size', () => {
  // EXIF orientation 6 (rotate 90 degrees for display) in front of a frame
  // header that stores 1007 x 801 pixels; browsers report 801 x 1007.
  function sidewaysJpeg() {
    const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
    const frame = jpeg(1007, 801, 4).subarray(8);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, frame]);
  }

  it('reports stored pixel size of a sideways phone JPEG without starting a model', async () => {
    const dataDir = await tempDir();
    const runner = fakeRunner();
    const app = await start({ dataDir, reconstructionRunner: runner });
    try {
      const photo = sidewaysJpeg();
      const draft = await saveDraft(app.base, { photos: [photo] });
      const url = `${app.base}/api/drafts/${draft.id}/sources/${draft.photos[0].sourceId}/image-size`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { width: 1007, height: 801 });
      assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
      assert.equal((await build(app.base, draft, buildBody(draft, { box: [0, 0, 1000, 900] }))).status, 400, 'display-orientation bounds are not used');
      assert.equal(runner.calls.length, 0);
      const original = Buffer.from(await (await fetch(`${app.base}/api/drafts/${draft.id}/assets/${draft.photos[0].name}`)).arrayBuffer());
      assert.deepEqual(original, photo);
      assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    } finally {
      await app.close();
    }
  });

  it('refuses sizes for ungranted, legacy, text, unknown or changed sources', async () => {
    const dataDir = await tempDir();
    const app = await start({ dataDir, reconstructionRunner: fakeRunner() });
    try {
      const draft = await saveDraft(app.base, { photos: [PHOTO, PHOTO], permissions: [grants(true, false), grants(true, true)], text: 'A note' });
      const size = (draftId, sourceId) => fetch(`${app.base}/api/drafts/${draftId}/sources/${sourceId}/image-size`);
      assert.equal((await size(draft.id, draft.photos[0].sourceId)).status, 403);
      assert.equal((await size(draft.id, draft.textSourceId)).status, 400);
      assert.equal((await size(draft.id, randomUUID())).status, 404);
      assert.equal((await size(draft.id, 'not-an-id')).status, 404);
      assert.equal((await size(randomUUID(), draft.photos[1].sourceId)).status, 404);
      assert.equal((await size('..%2f..', draft.photos[1].sourceId)).status, 404);

      const legacyId = randomUUID();
      await mkdir(path.join(dataDir, 'drafts', legacyId));
      await writeFile(path.join(dataDir, 'drafts', legacyId, 'draft.json'), JSON.stringify({ id: legacyId, createdAt: '2026-10-01T00:00:00.000Z', text: '', photos: [], voice: null }));
      assert.equal((await size(legacyId, draft.photos[1].sourceId)).status, 403);

      await writeFile(path.join(dataDir, 'drafts', draft.id, draft.photos[1].name), png(40, 30, 8));
      assert.equal((await size(draft.id, draft.photos[1].sourceId)).status, 409);
    } finally {
      await app.close();
    }
  });
});
