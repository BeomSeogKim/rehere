import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BudgetLedger } from '../meta-model.mjs';
import {
  SEGMENTATION_LABEL, createLiveSegmenter, createStoredSegmenter, parseInstances, parseStoredSegmentations, segmentationBody,
  segmentationDigest, segmenterFromEnv, selectInstance,
} from '../meta-segmentation.mjs';
import { jobStatusText } from '../public/photo-scene.js';
import { client, jpeg, png, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';
import { randomBytes } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-seg-'));
  tempDirs.push(dir);
  return dir;
};

// Synthetic records on a 40 x 30 frame. Payloads are placeholders: only the
// worker decodes masks, so the server checks grammar and geometry alone.
const record = (id, [x1, y1, x2, y2], c = '0.9', size = [40, 30]) => `${id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${size[0]};h=${size[1]};c=${c}|>`
  + `<|mask;x=0;y=0;c=${c};data=${y2 - y1 + 1},${x2 - x1 + 1},~!abc{}~|>`;
const line = (...records) => `<0f>${records.join(',')}`;
const FRAME = { width: 40, height: 30 };

describe('SAM 3.1 request binding', () => {
  it('builds one fixed body whose digest binds prompt, bytes and format', () => {
    const body = segmentationBody({ prompt: 'chair', imageBytes: Buffer.from([1, 2, 3]), format: 'jpeg' });
    assert.deepEqual(Object.keys(body), ['model', 'input', 'stream', 'metadata']);
    assert.equal(body.model, 'sam-3.1');
    assert.deepEqual(body.input[0].content[0], { type: 'input_text', text: 'chair' });
    assert.equal(body.input[0].content[1].image_url, 'data:image/jpeg;base64,AQID');
    assert.deepEqual(body.metadata, { include_confidence: 'true' });
    const digest = segmentationDigest(body);
    assert.equal(digest, segmentationDigest(segmentationBody({ prompt: 'chair', imageBytes: Buffer.from([1, 2, 3]), format: 'jpeg' })));
    assert.notEqual(digest, segmentationDigest(segmentationBody({ prompt: 'Chair', imageBytes: Buffer.from([1, 2, 3]), format: 'jpeg' })));
    assert.notEqual(digest, segmentationDigest(segmentationBody({ prompt: 'chair', imageBytes: Buffer.from([1, 2, 4]), format: 'jpeg' })));
    assert.notEqual(digest, segmentationDigest(segmentationBody({ prompt: 'chair', imageBytes: Buffer.from([1, 2, 3]), format: 'png' })));
    assert.throws(() => segmentationBody({ prompt: 'chair', imageBytes: Buffer.from([1]), format: 'gif' }));
  });
});

describe('SAM 3.1 instance parsing and selection', () => {
  it('parses bounded records that fit the exact photo and treats an empty lane as zero matches', () => {
    const parsed = parseInstances(line(record(0, [2, 4, 13, 25]), record(3, [24, 4, 37, 25])), FRAME);
    assert.deepEqual(parsed.map(({ id, box, confidence }) => ({ id, box, confidence })), [
      { id: 0, box: [2, 4, 14, 26], confidence: 0.9 }, { id: 3, box: [24, 4, 38, 26], confidence: 0.9 },
    ]);
    assert.deepEqual(parseInstances('', FRAME), []);
  });

  it('rejects records from another frame, outside boxes, wrong rasters, bad markers and excess instances', () => {
    const bad = {
      'other frame size': line(record(0, [2, 4, 13, 25], '0.9', [80, 60])),
      'box outside the photo': line(record(0, [2, 4, 40, 25])),
      'raster unlike its box': line(record(0, [2, 4, 13, 25]).replace('data=22,12', 'data=22,13')),
      'unknown marker': line(record(0, [2, 4, 13, 25]).replace(',~!abc', ',#abc')),
      'confidence mismatch': line(record(0, [2, 4, 13, 25]).replace(';c=0.9|><|mask', ';c=0.8|><|mask')),
      'duplicate id': line(record(1, [2, 4, 13, 25]), record(1, [24, 4, 37, 25])),
      'a second frame': `${line(record(0, [2, 4, 13, 25]))}\n<1f>${record(0, [2, 4, 13, 25])}`,
      'a path-like extra field': line(record(0, [2, 4, 13, 25]).replace('<|mask;x=0', '<|mask;file=/etc/passwd;x=0')),
      'too many instances': line(...Array.from({ length: 65 }, (_, i) => record(i, [0, 0, 1, 1]))),
    };
    for (const [name, text] of Object.entries(bad)) assert.throws(() => parseInstances(text, FRAME), undefined, name);
  });

  it('selects one instance by the owner box and refuses weak or tied matches, never by confidence', () => {
    const instances = parseInstances(line(record(0, [2, 4, 13, 25], '0.2'), record(1, [24, 4, 37, 25], '0.99')), FRAME);
    const picked = selectInstance(instances, [2, 4, 14, 26]);
    assert.equal(picked.selection.selectedInstance, 0);
    assert.deepEqual(picked.selection.ownerBox, [2, 4, 14, 26]);
    assert.equal(picked.selection.iou, 1);
    assert.equal(picked.selection.modelConfidence, 0.2);
    assert.match(picked.selection.rule, /IoU >= 0.5/);
    assert.match(selectInstance(instances, [0, 0, 40, 30]).refused, /closely enough/);
    const twins = parseInstances(line(record(0, [2, 4, 13, 25]), record(1, [3, 4, 14, 25])), FRAME);
    assert.match(selectInstance(twins, [2, 4, 15, 26]).refused, /almost equally/);
    assert.match(selectInstance([], [2, 4, 14, 26]).refused, /closely enough/);
  });
});

describe('SAM 3.1 modes', () => {
  const bytes = Buffer.from('synthetic photo');
  const body = segmentationBody({ prompt: 'chair', imageBytes: bytes, format: 'png' });
  const entry = { requestDigest: segmentationDigest(body), responseId: 'resp_synthetic', model: 'sam-3.1', outputText: line(record(0, [2, 4, 13, 25])), recordedAt: '2026-11-04T00:00:00.000Z' };

  it('replays only a byte-identical request and sends nothing on a mismatch', async () => {
    const stored = createStoredSegmenter({ entries: parseStoredSegmentations([entry]) });
    const result = await stored.segment({ prompt: 'chair', imageBytes: bytes, format: 'png' });
    assert.equal(result.mode, 'recorded');
    assert.equal(result.responseId, 'resp_synthetic');
    await assert.rejects(stored.segment({ prompt: 'chair ', imageBytes: bytes, format: 'png' }), /no recorded SAM 3.1 response matches/);
    assert.throws(() => parseStoredSegmentations([{ ...entry, model: 'sam-2' }]));
  });

  const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
  const completed = (text, images = 1) => sse([
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { id: 'resp_live', model: 'sam-3.1', status: 'completed', usage: { images_processed: images } } },
  ]);

  it('reserves before sending, settles a completed image and keeps an uncertain reservation', async () => {
    const dir = await temp();
    const ledger = new BudgetLedger({ file: path.join(dir, 'ledger.json'), limits: { totalUsd: 0.01, perRequestUsd: 0.0025, maxRequests: 3 } });
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      assert.equal((await ledger.read()).entries.at(-1).state, 'reserved');
      return sent.length === 1 ? completed(entry.outputText) : new Response('{}', { status: 500 });
    };
    const recorded = [];
    const live = createLiveSegmenter({ apiKey: 'test-key', ledger, fetch, recorder: async (value) => recorded.push(value) });
    const result = await live.segment({ prompt: 'chair', imageBytes: bytes, format: 'png' });
    assert.equal(result.mode, 'live');
    assert.equal(result.requestDigest, entry.requestDigest);
    assert.equal(sent[0].url, 'https://api.meta.ai/v1/responses');
    assert.deepEqual(sent[0].body, body);
    assert.equal(recorded.length, 1);
    await assert.rejects(live.segment({ prompt: 'chair', imageBytes: bytes, format: 'png' }), /HTTP 500/);
    const states = (await ledger.read()).entries.map((item) => item.state);
    assert.deepEqual(states, ['settled', 'reserved']);
    assert.ok(!JSON.stringify(await ledger.read()).includes('test-key'));
  });

  it('sends nothing once the budget is used up', async () => {
    const dir = await temp();
    const ledger = new BudgetLedger({ file: path.join(dir, 'ledger.json'), limits: { totalUsd: 0.01, perRequestUsd: 0.0025, maxRequests: 0 } });
    let calls = 0;
    const live = createLiveSegmenter({ apiKey: 'k', ledger, fetch: async () => { calls += 1; return completed(''); } });
    await assert.rejects(live.segment({ prompt: 'chair', imageBytes: bytes, format: 'png' }), /budget/);
    assert.equal(calls, 0);
  });

  it('stays off by default and refuses an opt-in without a usable mode', async () => {
    assert.equal(segmenterFromEnv({ ledgerFile: '/nonexistent', env: {} }), null);
    assert.equal(segmenterFromEnv({ ledgerFile: '/nonexistent', env: { MODEL_API_KEY: 'k', REHERE_MODEL_LIVE: '1' } }), null);
    assert.throws(() => segmenterFromEnv({ ledgerFile: '/x', env: { REHERE_SEGMENTATION: 'sam-2' } }), /only sam-3.1/);
    assert.throws(() => segmenterFromEnv({ ledgerFile: '/x', env: { REHERE_SEGMENTATION: 'sam-3.1' } }), /needs/);
    assert.throws(() => segmenterFromEnv({ ledgerFile: '/x', env: { REHERE_SEGMENTATION: 'sam-3.1', REHERE_SEGMENTATION_LIVE: '1' } }), /needs/);
    const dir = await temp();
    const file = path.join(dir, 'stored.json');
    await writeFile(file, JSON.stringify([entry]));
    assert.throws(() => segmenterFromEnv({ ledgerFile: '/x', env: { REHERE_SEGMENTATION: 'sam-3.1', REHERE_SEGMENTATION_REPLAY: file, REHERE_SEGMENTATION_LIVE: '1', MODEL_API_KEY: 'k' } }), /cannot be combined/);
    assert.equal(segmenterFromEnv({ ledgerFile: '/x', env: { REHERE_SEGMENTATION: 'sam-3.1', REHERE_SEGMENTATION_REPLAY: file } }).mode, 'recorded');
    assert.equal(segmenterFromEnv({ ledgerFile: path.join(dir, 'l.json'), env: { REHERE_SEGMENTATION: 'sam-3.1', REHERE_SEGMENTATION_LIVE: '1', MODEL_API_KEY: 'k' } }).mode, 'live');
  });
});

// Two-object builds through the app with a synthetic segmenter and worker.
const grant = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
const OBJECTS = [{ label: 'Display counter', box: [2, 4, 14, 26] }, { label: 'Flour stack', box: [24, 4, 38, 26] }];
const GRID = { width: 16, height: 12 };
const regionsGrid = () => Array.from({ length: GRID.width * GRID.height }, (_, i) => {
  const x = i % GRID.width;
  const y = Math.floor(i / GRID.width);
  const rows = y >= 2 && y <= 9;
  return rows && x >= 1 && x <= 5 ? 1 : rows && x >= 10 && x <= 14 ? 2 : 0;
});

// Writes worker outputs. With --segmentation it echoes the selected
// provenance exactly as the real worker does; `tamper` can alter it.
function syntheticRunner(options = {}) {
  const runner = async (call) => {
    runner.calls.push(call);
    const { imagePath, outputDir, sourceId, objects, segmentation } = call;
    const original = await readFile(imagePath);
    const texture = jpeg(40, 30, 1);
    const selected = objects.map(({ id, label, box }) => ({ id, label, box_xyxy: box }));
    const surface = {
      schema_version: 2,
      source: { source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30], texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' }, selected_objects: selected },
      objects: selected, ...GRID, depth: Array(GRID.width * GRID.height).fill(3), regions: regionsGrid(),
      assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
    };
    const summary = { source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture), overlap: { pixels: 0, ratio: 0 } };
    if (segmentation) {
      const input = JSON.parse(await readFile(segmentation, 'utf8'));
      runner.inputs.push(input);
      summary.models = { mask: { id: 'sam-3.1', label: SEGMENTATION_LABEL, provider: 'Meta Model API' } };
      summary.segmentation = input.objects.map((item) => item.provenance);
    }
    options.tamper?.(summary);
    const files = {
      'texture.jpg': texture, 'depth-preview.png': png(16, 12), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
      'surface.json': JSON.stringify(surface), 'summary.json': JSON.stringify(summary),
    };
    await mkdir(outputDir);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
    return { exitCode: 0, stderr: '' };
  };
  runner.calls = [];
  runner.inputs = [];
  return runner;
}

function fakeSegmenter({ hold = null, texts = {} } = {}) {
  const segmenter = {
    mode: 'recorded',
    calls: [],
    async segment({ prompt, imageBytes, format, signal }) {
      segmenter.calls.push({ prompt, imageSha256: sha256(imageBytes), format });
      if (hold) await hold(signal);
      const box = OBJECTS.find((item) => item.label === prompt).box;
      const text = texts[prompt] ?? line(record(7, [box[0], box[1], box[2] - 1, box[3] - 1]), record(8, [0, 0, 1, 1]));
      return { mode: 'recorded', requestDigest: 'd'.repeat(64), responseId: `resp_${prompt.length}`, model: 'sam-3.1', outputText: text, recordedAt: '2026-11-04T00:00:00.000Z' };
    },
  };
  return segmenter;
}

async function place(options) {
  const dataDir = await temp();
  const app = await startOwnerServer({ dataDir, ...options });
  const owner = client(app.base, app.cookie);
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('metadata', JSON.stringify({ photos: [grant] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  return { app, owner, draft };
}

async function build({ owner, draft }, { objects = OBJECTS, wait = true } = {}) {
  const response = await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, objects });
  assert.equal(response.status, 202);
  const job = await response.json();
  build.accepted = job;
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  let manifest = job;
  for (let i = 0; wait && i < 400 && ['queued', 'processing'].includes(manifest.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    manifest = await owner.json(scene);
  }
  return { scene, manifest };
}

describe('two-object builds with SAM 3.1 outlines', () => {
  it('sends each object name with the exact original and admits only the selected records', async () => {
    const runner = syntheticRunner();
    const segmenter = fakeSegmenter();
    const ctx = await place({ reconstructionRunner: runner, segmenter });
    try {
      const { manifest } = await build(ctx);
      assert.equal(manifest.status, 'ready', manifest.error);
      assert.deepEqual(segmenter.calls.map((call) => call.prompt), ['Display counter', 'Flour stack']);
      assert.ok(segmenter.calls.every((call) => call.imageSha256 === sha256(SYNTHETIC_PHOTO) && call.format === 'png'));
      const [input] = runner.inputs;
      assert.deepEqual(Object.keys(input), ['model', 'label', 'objects']);
      assert.equal(input.objects[0].record, record(7, [2, 4, 13, 25]));
      assert.ok(!JSON.stringify(input).includes('0,0,1,1') && !JSON.stringify(input).includes('<0f>'));
      assert.equal(manifest.segmentation.label, 'SAM 3.1 (Meta Model API)');
      assert.deepEqual(manifest.segmentation.objects.map((item) => [item.id, item.mode, item.selection.selectedInstance, item.selection.instances]), [['object-1', 'recorded', 7, 2], ['object-2', 'recorded', 7, 2]]);
      assert.ok(!JSON.stringify(manifest).includes('<|mask'));
    } finally { await ctx.app.close(); }
  });

  it('names the hosted outline source to the owner from the start and to visitors', async () => {
    const ctx = await place({ reconstructionRunner: syntheticRunner(), segmenter: fakeSegmenter() });
    try {
      const { scene, manifest } = await build(ctx);
      assert.equal(build.accepted.maskModel, 'SAM 3.1 (Meta Model API)');
      assert.match(jobStatusText({ ...build.accepted, status: 'processing' }), /^Building\. SAM 3\.1 \(Meta Model API\) proposes the outlines from your object names and a local model estimates depth/);
      assert.doesNotMatch(jobStatusText({ ...build.accepted, status: 'processing' }), /The local model is working/);
      assert.equal(manifest.segmentation.label, 'SAM 3.1 (Meta Model API)');
      assert.equal((await ctx.owner.post(`${scene}/objects/confirm`, { requestId: randomUUID(), objectIds: ['object-1', 'object-2'] })).status, 200);
      const view = { id: randomUUID(), kind: 'version', version: 1, variantId: null };
      const preview = await (await ctx.owner.post(`${scene}/shares/previews`, {
        requestId: randomUUID(), title: 'Synthetic shop', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
      })).json();
      const token = `rhv_${randomBytes(32).toString('base64url')}`;
      assert.equal((await ctx.owner.post(`${scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true })).status, 201);
      const visit = await (await globalThis.fetch(`${ctx.app.base}/api/visit`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.equal(visit.outlineSource, 'SAM 3.1 (Meta Model API)');
      assert.ok(!JSON.stringify(visit).includes('resp_') && !JSON.stringify(visit).includes('requestDigest'));
    } finally { await ctx.app.close(); }
  });

  it('keeps local SAM2 when no segmenter is configured', async () => {
    const runner = syntheticRunner();
    const ctx = await place({ reconstructionRunner: runner });
    try {
      const { manifest } = await build(ctx);
      assert.equal(manifest.status, 'ready', manifest.error);
      assert.equal(runner.calls[0].segmentation, undefined);
      assert.equal(manifest.segmentation, undefined);
      assert.equal(build.accepted.maskModel, undefined);
      assert.equal(jobStatusText({ ...build.accepted, status: 'processing' }), 'Building. The local model is working; this can take a few minutes.');
    } finally { await ctx.app.close(); }
  });

  it('publishes nothing when the worker reports other provenance', async () => {
    const cases = {
      'altered selection': (summary) => { summary.segmentation[0].selection.selectedInstance = 8; },
      'SAM2 label': (summary) => { summary.models.mask = { id: 'facebook/sam2.1-hiera-tiny' }; },
      'missing provenance': (summary) => { delete summary.segmentation; },
    };
    for (const [name, tamper] of Object.entries(cases)) {
      const ctx = await place({ reconstructionRunner: syntheticRunner({ tamper }), segmenter: fakeSegmenter() });
      try {
        const { manifest } = await build(ctx);
        assert.equal(manifest.status, 'failed', name);
        assert.match(manifest.error, /incomplete or inconsistent/, name);
      } finally { await ctx.app.close(); }
    }
  });

  it('refuses an ambiguous match without starting the worker', async () => {
    const runner = syntheticRunner();
    const segmenter = fakeSegmenter({ texts: { 'Display counter': line(record(0, [2, 4, 13, 25]), record(1, [2, 4, 13, 24])) } });
    const ctx = await place({ reconstructionRunner: runner, segmenter });
    try {
      const { manifest } = await build(ctx);
      assert.equal(manifest.status, 'failed');
      assert.match(manifest.error, /SAM 3.1 \(Meta Model API\) could not match “Display counter”.*almost equally/);
      assert.equal(runner.calls.length, 0);
      assert.equal(segmenter.calls.length, 1);
    } finally { await ctx.app.close(); }
  });

  it('drops a pending result when model permission is turned off during the request', async () => {
    let release;
    let entered;
    const inFlight = new Promise((resolve) => { entered = resolve; });
    const runner = syntheticRunner();
    const segmenter = fakeSegmenter({ hold: (signal) => new Promise((resolve) => { entered(); release = resolve; signal.addEventListener('abort', resolve, { once: true }); }) });
    const ctx = await place({ reconstructionRunner: runner, segmenter });
    try {
      const { scene } = await build(ctx, { wait: false });
      await inFlight;
      const policy = `/api/drafts/${ctx.draft.id}/sources/${ctx.draft.photos[0].sourceId}/policy`;
      const { revision } = await ctx.owner.json(policy);
      assert.equal((await ctx.owner.post(policy, { requestId: randomUUID(), baseRevision: revision, permissions: { place: true, model: false, share: true }, stopUse: false })).status, 200);
      release?.();
      let manifest;
      for (let i = 0; i < 400; i++) {
        manifest = await ctx.owner.json(scene);
        if (!['queued', 'processing'].includes(manifest.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(manifest.status, 'failed');
      assert.match(manifest.error, /turned off model processing/);
      assert.equal(runner.calls.length, 0);
      assert.equal(segmenter.calls.length, 1);
    } finally { await ctx.app.close(); }
  });

  it('cancels a pending request when the place is deleted and never admits its result', async () => {
    let entered;
    const inFlight = new Promise((resolve) => { entered = resolve; });
    let abortedSignal = false;
    const runner = syntheticRunner();
    const segmenter = fakeSegmenter({ hold: (signal) => new Promise((resolve) => {
      entered();
      signal.addEventListener('abort', () => { abortedSignal = true; resolve(); }, { once: true });
    }) });
    const ctx = await place({ reconstructionRunner: runner, segmenter });
    try {
      await build(ctx, { wait: false });
      await inFlight;
      const impact = await ctx.owner.json(`/api/drafts/${ctx.draft.id}/deletion`);
      const request = { requestId: randomUUID(), impactSha256: impact.impactSha256, confirmDeletion: true };
      let state;
      for (let i = 0; i < 200 && state !== 'complete'; i++) {
        state = (await (await ctx.owner.post(`/api/drafts/${ctx.draft.id}/delete`, request)).json()).state;
        if (state !== 'complete') await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(state, 'complete');
      assert.ok(abortedSignal, 'the pending SAM 3.1 request saw the abort');
      assert.equal(segmenter.calls.length, 1);
      assert.equal(runner.calls.length, 0);
    } finally { await ctx.app.close(); }
  });

  it('does not dispatch when the grant is already off', async () => {
    const segmenter = fakeSegmenter();
    const runner = syntheticRunner();
    const ctx = await place({ reconstructionRunner: runner, segmenter });
    try {
      const policy = `/api/drafts/${ctx.draft.id}/sources/${ctx.draft.photos[0].sourceId}/policy`;
      const { revision } = await ctx.owner.json(policy);
      await ctx.owner.post(policy, { requestId: randomUUID(), baseRevision: revision, permissions: { place: true, model: false, share: true }, stopUse: false });
      const response = await ctx.owner.post(`/api/drafts/${ctx.draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: ctx.draft.photos[0].sourceId, objects: OBJECTS });
      assert.notEqual(response.status, 202);
      assert.equal(segmenter.calls.length, 0);
      assert.equal(runner.calls.length, 0);
    } finally { await ctx.app.close(); }
  });
});
