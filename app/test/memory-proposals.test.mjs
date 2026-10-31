import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DraftStore } from '../drafts.mjs';
import { anchorYaw, validatePlan } from '../memory-proposals.mjs';
import { ReconstructionStore } from '../reconstructions.mjs';
import { ownerFetch as fetch, startOwnerServer } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Synthetic images and grids only; no personal media.
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
const BOX = [4, 3, 20, 24];
const THUMBNAIL = jpeg(20, 15, 3);

// A 4 x 3 grid at depth 3: the two left columns are the foreground.
function surfaceFor(sourceId, original, texture) {
  return {
    source: {
      source_id: sourceId,
      sha256: sha256(original),
      format: 'PNG',
      image_size: [40, 30],
      texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' },
      selected_object: { id: 'foreground', box_xyxy: BOX },
    },
    width: 4,
    height: 3,
    depth: Array(12).fill(3),
    foreground: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
}

async function runner({ imagePath, outputDir, sourceId, box }) {
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const files = {
    'texture.jpg': texture,
    'depth-preview.png': png(4, 3),
    'mask.png': png(40, 30),
    'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify({ ...surfaceFor(sourceId, original, texture), source: { ...surfaceFor(sourceId, original, texture).source, selected_object: { id: 'foreground', box_xyxy: box } } }),
    'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture) }),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const plan = (change = {}) => ({
  action: 'translate', targetId: 'selected-foreground', sourceId: null, baseVersion: 1,
  delta: [0.5, 0, -0.25], yawDelta: null, anchor: null, question: null, reason: 'The memory places it nearer the window.', ...change,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A scripted stand-in for the hosted model. Each call takes the next answer;
// an answer can be a function of the call or a pending promise.
function fakeModel(answers = []) {
  const calls = [];
  const model = async (call) => {
    calls.push(call);
    const answer = answers.shift() ?? ((input) => ({ ok: true, plan: plan({ sourceId: input.sourceId, baseVersion: input.baseVersion }) }));
    const outcome = await (typeof answer === 'function' ? answer(call) : answer);
    return { model: 'muse-spark-1.3', responseId: `resp_${calls.length}`, usage: { inputTokens: 900, outputTokens: 120, estimatedUsd: 0.0016 }, ...outcome };
  };
  model.calls = calls;
  return model;
}

const grants = (origin = 'public', place = true, model = true) => ({
  provider: 'Synthetic',
  origin: { kind: origin, reference: '' },
  permissions: { place, model, share: false },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
});

const postJson = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function waitUntil(read, done) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

// Starts a server with a finished scene on a public, fully granted photo.
async function setup({ model = fakeModel(), prepareModelImage = async () => THUMBNAIL, permission = grants(), dataDir } = {}) {
  dataDir ??= await mkdtemp(path.join(os.tmpdir(), 'rehere-memory-'));
  tempDirs.push(dataDir);
  const { server, base, close } = await startOwnerServer({ dataDir, reconstructionRunner: runner, proposalModel: model, prepareModelImage });
  const ctx = { server, base, dataDir, model, close };
  if (permission === null) return ctx;
  const form = new FormData();
  form.append('photos', new Blob([PHOTO]), 'photo');
  form.append('metadata', JSON.stringify({ photos: [permission] }));
  let draft;
  let build;
  let scene;
  try {
    draft = await (await fetch(`${base}/api/drafts`, { method: 'POST', body: form })).json();
    build = await (await postJson(`${base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: BOX })).json();
    scene = `${base}/api/drafts/${draft.id}/reconstructions/${build.id}`;
    await waitUntil(async () => (await fetch(scene)).json(), (job) => job.status === 'ready');
  } catch (error) {
    await ctx.close();
    throw error;
  }
  return {
    ...ctx,
    draft,
    sourceId: draft.photos[0].sourceId,
    scene,
    manifestFile: path.join(dataDir, 'reconstructions', draft.id, build.id, 'manifest.json'),
    draftFile: path.join(dataDir, 'drafts', draft.id, 'draft.json'),
    jobId: build.id,
    propose: (body = {}) => postJson(`${scene}/proposals`, { requestId: randomUUID(), baseVersion: 1, text: 'The counter stood closer to the window.', consent: true, ...body }),
    get: async (id) => (await fetch(`${scene}/proposals/${id}`)).json(),
    settle: (id, statuses = ['ready', 'clarify', 'failed', 'stale', 'canceled', 'interrupted']) =>
      waitUntil(async () => (await fetch(`${scene}/proposals/${id}`)).json(), (item) => statuses.includes(item.status)),
    apply: (id, body = {}) => postJson(`${scene}/proposals/${id}/apply`, { requestId: randomUUID(), baseVersion: 1, frontConfirmed: false, ...body }),
    cancel: (id) => postJson(`${scene}/proposals/${id}/cancel`, { requestId: randomUUID() }),
    undo: (body) => postJson(`${scene}/undo`, { requestId: randomUUID(), ...body }),
    edit: (body) => postJson(`${scene}/edit`, { requestId: randomUUID(), ...body }),
    history: async () => (await fetch(`${scene}/history`)).json(),
  };
}

async function readyProposal(app, body) {
  const response = await app.propose(body);
  assert.equal(response.status, 202);
  return app.settle((await response.json()).id);
}

describe('memory proposals', () => {
  it('plans from the stored statement, then applies the server-derived transform as a new version', async () => {
    const app = await setup();
    try {
      const text = '  The counter stood closer to the window.\n';
      const response = await app.propose({ text });
      assert.equal(response.status, 202);
      const queued = await response.json();
      assert.equal(queued.status, 'queued');
      assert.deepEqual(queued.statement, { id: queued.statement.id, kind: 'human_memory', text, sha256: sha256(Buffer.from(text)), modelConsent: true });
      assert.deepEqual(Object.keys(queued).sort(), ['appliedVersion', 'baseVersion', 'createdAt', 'error', 'id', 'model', 'question', 'requestId', 'responseId', 'result', 'statement', 'status', 'updatedAt', 'usage']);

      const ready = await app.settle(queued.id);
      assert.equal(ready.status, 'ready');
      assert.deepEqual(ready.result.transform, { offset: [0.5, 0, -0.25], yaw: 0 });
      assert.deepEqual(ready.usage, { inputTokens: 900, outputTokens: 120, estimatedUsd: 0.0016 });
      assert.equal(ready.responseId, 'resp_1');
      const [call] = app.model.calls;
      assert.equal(call.text, text);
      assert.equal(call.image, THUMBNAIL);
      assert.deepEqual(call.selection, [4 / 40, 3 / 30, 20 / 40, 24 / 30]);
      assert.deepEqual(call.saved, { version: 1, offset: [0, 0, 0], yaw: 0 });
      assert.equal(call.sourceId, app.sourceId);

      // Nothing is saved before Apply.
      assert.equal((await (await fetch(app.scene)).json()).edit.version, 1);
      const applied = await app.apply(ready.id);
      assert.equal(applied.status, 200);
      const { edit, proposal } = await applied.json();
      assert.deepEqual(edit, { version: 2, offset: [0.5, 0, -0.25], yaw: 0 });
      assert.equal(proposal.status, 'applied');
      assert.equal(proposal.appliedVersion, 2);
      assert.equal(proposal.statement.text, text);

      const job = await (await fetch(app.scene)).json();
      assert.deepEqual(job.edit, edit);
      assert.equal(job.proposals, undefined);
      assert.deepEqual(await app.history(), [
        { version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', dependencies: [], blocked: false },
        { version: 2, offset: [0.5, 0, -0.25], yaw: 0, kind: 'proposal', proposalId: ready.id, dependencies: [], blocked: false },
      ]);
    } finally {
      await app.close();
    }
  });

  it('replays a proposal request without another model call and rejects a changed one', async () => {
    const app = await setup();
    try {
      const requestId = randomUUID();
      const first = await (await app.propose({ requestId })).json();
      await app.settle(first.id);
      const again = await app.propose({ requestId });
      assert.equal(again.status, 202);
      assert.equal((await again.json()).id, first.id);
      assert.equal((await app.propose({ requestId, text: 'Something else.' })).status, 409);
      assert.equal(app.model.calls.length, 1);
      assert.equal((await (await fetch(`${app.scene}/proposals`)).json()).length, 1);
    } finally {
      await app.close();
    }
  });

  it('lists proposals newest first', async () => {
    const app = await setup();
    try {
      const first = await readyProposal(app);
      const second = await readyProposal(app, { text: 'It faced the door.' });
      const list = await (await fetch(`${app.scene}/proposals`)).json();
      assert.deepEqual(list.map((item) => item.id), [second.id, first.id]);
    } finally {
      await app.close();
    }
  });

  it('refuses without a configured model and creates nothing', async () => {
    const app = await setup({ model: null });
    try {
      const response = await app.propose();
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /not set up/);
      assert.deepEqual(await (await fetch(`${app.scene}/proposals`)).json(), []);
    } finally {
      await app.close();
    }
  });

  it('refuses consent false, nonpublic or ungranted photos before any model call', async () => {
    for (const permission of [grants('own'), grants('unknown'), grants('other')]) {
      const app = await setup({ permission });
      try {
        assert.equal((await app.propose()).status, 403);
        assert.equal(app.model.calls.length, 0);
      } finally {
        await app.close();
      }
    }
    // Grants are fixed at save time and a scene needs both to be built, so a
    // missing grant is simulated by editing the stored record of a built scene.
    for (const purpose of ['place', 'model']) {
      const app = await setup();
      try {
        const draft = JSON.parse(await readFile(app.draftFile, 'utf8'));
        draft.sources[0].permissions[purpose] = false;
        await writeFile(app.draftFile, JSON.stringify(draft));
        assert.equal((await app.propose()).status, 403);
        assert.equal(app.model.calls.length, 0);
      } finally {
        await app.close();
      }
    }
    const app = await setup();
    try {
      assert.equal((await app.propose({ consent: false })).status, 403);
      assert.equal(app.model.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed bodies, unknown IDs and cross-site requests', async () => {
    const app = await setup();
    try {
      const valid = { requestId: randomUUID(), baseVersion: 1, text: 'Move it left.', consent: true };
      for (const body of [
        { ...valid, extra: 1 },
        { requestId: valid.requestId, baseVersion: 1, text: 'x' },
        { ...valid, requestId: 'not-a-uuid' },
        { ...valid, baseVersion: 0 },
        { ...valid, baseVersion: 1.5 },
        { ...valid, text: '   ' },
        { ...valid, text: 'x'.repeat(2001) },
        { ...valid, consent: 'yes' },
        '{broken',
      ]) {
        assert.equal((await postJson(`${app.scene}/proposals`, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await app.propose({ text: '\uAC00'.repeat(2000) })).status, 202);
      assert.equal((await postJson(`${app.scene}/proposals`, valid, { origin: 'http://example.com' })).status, 403);
      assert.equal((await fetch(`${app.scene}/proposals/${randomUUID()}`)).status, 404);
      assert.equal((await fetch(`${app.scene}/proposals/..%2F..`)).status, 404);
      assert.equal((await app.apply(randomUUID())).status, 404);
      assert.equal((await app.cancel(randomUUID())).status, 404);
      const unknownScene = `${app.base}/api/drafts/${app.draft.id}/reconstructions/${randomUUID()}`;
      assert.equal((await postJson(`${unknownScene}/proposals`, valid)).status, 404);
      assert.equal((await fetch(`${unknownScene}/history`)).status, 404);
      assert.equal((await postJson(`${app.scene}/proposals/${randomUUID()}/apply`, { requestId: randomUUID(), baseVersion: 1 })).status, 400);
      assert.equal((await postJson(`${app.scene}/undo`, { requestId: randomUUID(), baseVersion: 1, targetVersion: 1, extra: true })).status, 400);
    } finally {
      await app.close();
    }
  });

  it('refuses a stale base version and a second proposal while one is running', async () => {
    const gate = deferred();
    const app = await setup({ model: fakeModel([gate.promise.then(() => ({ ok: false, reason: 'provider' }))]) });
    try {
      assert.equal((await app.propose({ baseVersion: 2 })).status, 409);
      const first = await (await app.propose()).json();
      assert.equal((await app.propose()).status, 409);
      gate.resolve();
      const failed = await app.settle(first.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.result, null);
      assert.equal((await app.propose()).status, 202);
    } finally {
      await app.close();
    }
  });
});

describe('proposal plan validation', () => {
  const answer = (change) => fakeModel([(call) => ({ ok: true, plan: plan({ sourceId: call.sourceId, baseVersion: call.baseVersion, ...change }) })]);

  it('turns a clarification into a question without a transform', async () => {
    const app = await setup({ model: answer({ action: 'clarify', targetId: null, delta: null, question: 'Which side of the door?' }) });
    try {
      const item = await readyProposal(app);
      assert.equal(item.status, 'clarify');
      assert.equal(item.question, 'Which side of the door?');
      assert.equal(item.result.transform, null);
      assert.equal((await app.apply(item.id)).status, 409);
    } finally {
      await app.close();
    }
  });

  it('wraps a rotation relative to the saved yaw', async () => {
    const app = await setup({ model: answer({ action: 'rotate', delta: null, yawDelta: 1.5 * Math.PI }) });
    try {
      const item = await readyProposal(app);
      assert.equal(item.status, 'ready');
      assert.ok(Math.abs(item.result.transform.yaw - -0.5 * Math.PI) < 1e-12);
    } finally {
      await app.close();
    }
  });

  it('faces a background anchor and requires front confirmation to apply', async () => {
    const app = await setup({ model: answer({ action: 'face_anchor', delta: null, anchor: { label: 'window', point: [1, 0.5] } }) });
    try {
      const item = await readyProposal(app);
      assert.equal(item.status, 'ready');
      assert.ok(Math.abs(item.result.transform.yaw - Math.PI / 2) < 1e-9);
      assert.deepEqual(item.result.anchor, { label: 'window', point: [1, 0.5] });
      const refused = await app.apply(item.id, { frontConfirmed: false });
      assert.equal(refused.status, 409);
      assert.equal((await (await fetch(app.scene)).json()).edit.version, 1);
      const applied = await app.apply(item.id, { frontConfirmed: true });
      assert.equal(applied.status, 200);
    } finally {
      await app.close();
    }
  });

  it('fails plans that reference other things, leave the range or break the shape', async () => {
    const cases = [
      { change: { delta: [3, 0, 0] }, error: /editable range/ },
      { change: { action: 'face_anchor', delta: null, anchor: { label: 'counter', point: [0, 0] } }, error: /on the object/ },
      { change: { action: 'face_anchor', delta: null, anchor: { label: 'window', point: [1.2, 0.5] } } },
      { change: { action: 'face_anchor', delta: null, anchor: { label: ' ', point: [1, 0.5] } } },
      { change: { targetId: 'door' } },
      { change: { sourceId: randomUUID() } },
      { change: { baseVersion: 2 } },
      { change: { delta: [1, 0] } },
      { change: { delta: [1, 0, Number.NaN] } },
      { change: { yawDelta: 0.1 } },
      { change: { action: 'clarify', delta: null, targetId: null, question: '' } },
      { change: { action: 'clarify', question: 'Which one?' } },
      { change: { action: 'teleport' } },
      { change: { reason: 'x'.repeat(401) } },
      { change: { reason: 'bell\u0007' } },
      { change: { extra: true } },
    ];
    for (const { change, error = /did not match/ } of cases) {
      const app = await setup({ model: answer(change) });
      try {
        const item = await readyProposal(app);
        assert.equal(item.status, 'failed', JSON.stringify(change));
        assert.match(item.error, error);
        assert.equal(item.result, null);
      } finally {
        await app.close();
      }
    }
  });

  it('names the failed check by category for operators, without the plan, statement or browser change', () => {
    const surface = surfaceFor('s', PHOTO, jpeg(40, 30, 1));
    const context = { sourceId: 's', baseVersion: 1, saved: { offset: [0, 0, 0], yaw: 0 }, surface };
    const clarify = { action: 'clarify', targetId: null, delta: null, yawDelta: null, anchor: null, question: 'Which side?' };
    const cases = [
      [{ extra: 1 }, 'plan_keys'],
      [{ action: 'teleport' }, 'action'],
      [{ sourceId: 'other' }, 'source_id'],
      [{ baseVersion: 2 }, 'base_version'],
      [{ reason: 'x'.repeat(401) }, 'reason'],
      [{ ...clarify, targetId: 'selected-foreground' }, 'clarify_targetId_not_null'],
      [{ ...clarify, anchor: { label: 'x', point: [1, 0.5] } }, 'clarify_anchor_not_null'],
      [{ ...clarify, question: ' ' }, 'clarify_question'],
      [{ targetId: 'door' }, 'translate_target_id'],
      [{ question: 'Sure?' }, 'translate_question_not_null'],
      [{ yawDelta: 1 }, 'translate_yawDelta_not_null'],
      [{ delta: [1, 0] }, 'translate_delta'],
      [{ delta: [3, 0, 0] }, 'translate_range'],
      [{ action: 'rotate', yawDelta: 1 }, 'rotate_delta_not_null'],
      [{ action: 'rotate', delta: null, yawDelta: null }, 'rotate_yaw_delta'],
      [{ action: 'face_anchor', anchor: { label: 'x', point: [1, 0.5] } }, 'face_anchor_delta_not_null'],
      [{ action: 'face_anchor', delta: null, anchor: { label: 'x', point: [1, 0.5], why: 1 } }, 'face_anchor_anchor'],
      [{ action: 'face_anchor', delta: null, anchor: { label: '', point: [1, 0.5] } }, 'face_anchor_label'],
      [{ action: 'face_anchor', delta: null, anchor: { label: 'x', point: [1, 2] } }, 'face_anchor_point'],
      [{ action: 'face_anchor', delta: null, anchor: { label: 'x', point: [0, 0] } }, 'face_anchor_on_object'],
    ];
    for (const [change, code] of cases) {
      const checked = validatePlan(plan({ sourceId: 's', ...change }), context);
      assert.equal(checked.code, code, JSON.stringify(change));
      assert.match(checked.code, /^[a-z_A-Z]+$/);
      assert.equal(typeof checked.error, 'string');
    }
  });

  it('logs only the category of a rejected plan and keeps the browser message fixed', async () => {
    const secretish = 'A private memory sentence 12345';
    const app = await setup({ model: fakeModel([(call) => ({ ok: true, plan: plan({ sourceId: call.sourceId, action: 'clarify', delta: null, question: 'Which side?', reason: secretish }) })]) });
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const item = await readyProposal(app, { text: secretish });
      assert.equal(item.status, 'failed');
      assert.equal(item.error, 'The model answer did not match a change this scene supports, so nothing is offered to apply. Try rephrasing the memory.');
      assert.equal(item.result, null);
      const line = logged.find((entry) => entry.includes('plan rejected'));
      assert.equal(line, `proposal ${item.id} plan rejected: clarify_targetId_not_null`);
      assert.ok(!logged.join('\n').includes(secretish));
      assert.ok(!logged.join('\n').includes('Which side?'));
    } finally {
      console.error = original;
      await app.close();
    }
  });

  it('reports provider outcomes as failures, never as a ready plan', async () => {
    for (const reason of ['refused', 'incomplete', 'invalid', 'budget', 'timeout', 'provider', 'tooLarge']) {
      const app = await setup({ model: fakeModel([{ ok: false, reason, usage: null }]) });
      try {
        const item = await readyProposal(app);
        assert.equal(item.status, 'failed');
        assert.equal(item.result, null);
      } finally {
        await app.close();
      }
    }
  });

  it('fails when the photo cannot be prepared, without calling the model', async () => {
    const app = await setup({ prepareModelImage: async () => { throw new Error('bad'); } });
    try {
      const item = await readyProposal(app);
      assert.equal(item.status, 'failed');
      assert.match(item.error, /prepared/);
      assert.equal(app.model.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('computes the anchor yaw from the projected point and rejects a coincident anchor', () => {
    const surface = surfaceFor(randomUUID(), PHOTO, jpeg(40, 30, 1));
    assert.ok(Math.abs(anchorYaw(surface, [1, 0.5], [0, 0, 0]) - Math.PI / 2) < 1e-9);
    assert.equal(anchorYaw(surface, [0.4, 0.5], [0, 0, 0]), null);
    const tangent = Math.tan((55 * Math.PI) / 360);
    const pivotX = ((0 + 1 / 3) / 2 - 0.5) * 2 * tangent * 3;
    const anchorX = 0.5 * 2 * tangent * 3;
    assert.equal(anchorYaw(surface, [1, 0.5], [anchorX - pivotX, 0, 0]), null);
    const ok = validatePlan(plan({ sourceId: 's', delta: [2, 0, 0] }), { sourceId: 's', baseVersion: 1, saved: { offset: [0, 0, 0], yaw: 0 }, surface });
    assert.deepEqual(ok.result.transform, { offset: [2, 0, 0], yaw: 0 });
  });
});

describe('proposal staleness, cancellation and concurrency', () => {
  it('marks open proposals stale after a manual edit and refuses to apply them', async () => {
    const app = await setup();
    try {
      const item = await readyProposal(app);
      assert.equal((await app.edit({ baseVersion: 1, offset: [0, 0, 1], yaw: 0 })).status, 200);
      assert.equal((await app.get(item.id)).status, 'stale');
      assert.equal((await app.apply(item.id, { baseVersion: 2 })).status, 409);
      assert.deepEqual((await (await fetch(app.scene)).json()).edit, { version: 2, offset: [0, 0, 1], yaw: 0 });
    } finally {
      await app.close();
    }
  });

  it('keeps a late model result stale after the version changed and records its usage', async () => {
    const gate = deferred();
    const app = await setup({ model: fakeModel([async (call) => { await gate.promise; return { ok: true, plan: plan({ sourceId: call.sourceId }) }; }]) });
    try {
      const queued = await (await app.propose()).json();
      await app.settle(queued.id, ['processing']);
      assert.equal((await app.edit({ baseVersion: 1, offset: [0, 0, 1], yaw: 0 })).status, 200);
      gate.resolve();
      const late = await waitUntil(() => app.get(queued.id), (item) => item.usage !== null);
      assert.equal(late.status, 'stale');
      assert.equal(late.result, null);
      assert.equal(late.responseId, 'resp_1');
    } finally {
      await app.close();
    }
  });

  it('cancels a running proposal, aborts the model and never lets the late result become ready', async () => {
    const gate = deferred();
    let signal;
    const app = await setup({ model: fakeModel([async (call) => { signal = call.signal; await gate.promise; return { ok: true, plan: plan({ sourceId: call.sourceId }) }; }]) });
    try {
      const queued = await (await app.propose()).json();
      await app.settle(queued.id, ['processing']);
      const canceled = await app.cancel(queued.id);
      assert.equal(canceled.status, 200);
      assert.equal((await canceled.json()).status, 'canceled');
      assert.equal(signal.aborted, true);
      gate.resolve();
      const late = await waitUntil(() => app.get(queued.id), (item) => item.usage !== null);
      assert.equal(late.status, 'canceled');
      assert.equal(late.result, null);
      assert.equal((await app.apply(queued.id)).status, 409);
      assert.equal((await (await fetch(app.scene)).json()).edit.version, 1);
      assert.equal((await app.cancel(queued.id)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('cancels a ready proposal but not an applied one', async () => {
    const app = await setup();
    try {
      const first = await readyProposal(app);
      assert.equal((await (await app.cancel(first.id)).json()).status, 'canceled');
      assert.equal((await app.apply(first.id)).status, 409);
      const second = await readyProposal(app);
      assert.equal((await app.apply(second.id)).status, 200);
      assert.equal((await app.cancel(second.id)).status, 409);
      assert.equal((await app.get(second.id)).status, 'applied');
    } finally {
      await app.close();
    }
  });

  it('lets only one of two concurrent applies from the same base win', async () => {
    const app = await setup();
    try {
      const first = await readyProposal(app);
      const second = await readyProposal(app, { text: 'It sat further back.' });
      const statuses = (await Promise.all([app.apply(first.id), app.apply(second.id)])).map((response) => response.status).sort();
      assert.deepEqual(statuses, [200, 409]);
      const states = [await app.get(first.id), await app.get(second.id)].map((item) => item.status).sort();
      assert.deepEqual(states, ['applied', 'stale']);
      assert.equal((await app.history()).length, 2);
    } finally {
      await app.close();
    }
  });

  it('replays an apply with its original edit after later versions and rejects a changed body', async () => {
    const app = await setup();
    try {
      const item = await readyProposal(app);
      const requestId = randomUUID();
      const first = await (await app.apply(item.id, { requestId })).json();
      assert.equal((await app.edit({ baseVersion: 2, offset: [1, 1, 1], yaw: 1 })).status, 200);
      const replay = await app.apply(item.id, { requestId });
      assert.equal(replay.status, 200);
      assert.deepEqual((await replay.json()).edit, first.edit);
      assert.equal((await app.apply(item.id, { requestId, frontConfirmed: true })).status, 409);
      assert.equal((await app.edit({ requestId, baseVersion: 1, offset: [0.5, 0, -0.25], yaw: 0 })).status, 409);
      assert.equal((await app.apply(item.id, { baseVersion: 3 })).status, 409);
      assert.equal((await (await fetch(app.scene)).json()).edit.version, 3);
    } finally {
      await app.close();
    }
  });

  it('leaves the saved version and proposal intact when the apply write fails', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const app = await setup();
    const dir = path.dirname(app.manifestFile);
    try {
      const item = await readyProposal(app);
      const before = await readFile(app.manifestFile, 'utf8');
      await chmod(dir, 0o500);
      try {
        assert.equal((await app.apply(item.id)).status, 500);
      } finally {
        await chmod(dir, 0o700);
      }
      assert.equal(await readFile(app.manifestFile, 'utf8'), before);
      assert.equal((await app.get(item.id)).status, 'ready');
      assert.equal((await app.apply(item.id)).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('history and undo', () => {
  it('restores an earlier transform as a new version and keeps everything in between', async () => {
    const app = await setup();
    try {
      const item = await readyProposal(app);
      await app.apply(item.id);
      await app.edit({ baseVersion: 2, offset: [1, 0, 0], yaw: 0.5 });
      const open = await readyProposal(app, { baseVersion: 3 });
      const requestId = randomUUID();
      const undone = await app.undo({ requestId, baseVersion: 3, targetVersion: 2 });
      assert.equal(undone.status, 200);
      const edit = await undone.json();
      assert.deepEqual(edit, { version: 4, offset: [0.5, 0, -0.25], yaw: 0 });
      assert.equal((await app.get(open.id)).status, 'stale');
      assert.equal((await app.get(item.id)).status, 'applied');
      assert.equal((await app.get(item.id)).statement.text, 'The counter stood closer to the window.');
      assert.deepEqual((await app.history()).map(({ version, kind, targetVersion }) => [version, kind, targetVersion]), [
        [1, 'initial', undefined], [2, 'proposal', undefined], [3, 'manual', undefined], [4, 'undo', 2],
      ]);

      await app.undo({ baseVersion: 4, targetVersion: 1 });
      const replay = await app.undo({ requestId, baseVersion: 3, targetVersion: 2 });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), edit);
      assert.equal((await app.undo({ requestId, baseVersion: 3, targetVersion: 1 })).status, 409);
      assert.equal((await app.undo({ baseVersion: 4, targetVersion: 1 })).status, 409);
      assert.equal((await app.undo({ baseVersion: 5, targetVersion: 5 })).status, 409);
      assert.equal((await app.undo({ baseVersion: 5, targetVersion: 9 })).status, 409);
      assert.deepEqual((await (await fetch(app.scene)).json()).edit, { version: 5, offset: [0, 0, 0], yaw: 0 });
    } finally {
      await app.close();
    }
  });
});

describe('proposal restart', () => {
  it('marks an unfinished proposal interrupted on shutdown and restart without touching geometry', async () => {
    const gate = deferred();
    const app = await setup({ model: fakeModel([async (call) => { await gate.promise; return { ok: false, reason: call.signal.aborted ? 'canceled' : 'provider' }; }]) });
    const queued = await (await app.propose()).json();
    await app.settle(queued.id, ['processing']);
    const closing = app.close();
    gate.resolve();
    await closing;
    const stored = JSON.parse(await readFile(app.manifestFile, 'utf8'));
    assert.equal(stored.proposals[0].status, 'interrupted');

    // A crash can leave processing on disk; the next start settles it.
    stored.proposals[0].status = 'processing';
    await writeFile(app.manifestFile, JSON.stringify(stored));
    const restarted = await setup({ dataDir: app.dataDir, permission: null });
    try {
      const scene = app.scene.replace(app.base, restarted.base);
      const item = await (await fetch(`${scene}/proposals/${queued.id}`)).json();
      assert.equal(item.status, 'interrupted');
      assert.match(item.error, /may still count toward usage/);
      assert.deepEqual((await (await fetch(scene)).json()).edit, { version: 1, offset: [0, 0, 0], yaw: 0 });
      assert.equal(restarted.model.calls.length, 0);
    } finally {
      await restarted.close();
    }
  });

  it('does not start a model call for a proposal accepted while the store closes', async () => {
    const app = await setup();
    await app.close();
    const model = fakeModel();
    const store = new ReconstructionStore({ dataDir: app.dataDir, drafts: new DraftStore(app.dataDir), runner, proposalModel: model, prepareImage: async () => THUMBNAIL });
    const gate = deferred();
    const writing = deferred();
    const update = store.update.bind(store);
    store.update = async (manifest, changes) => {
      if (changes.proposals?.some((item) => item.status === 'queued')) {
        writing.resolve();
        await gate.promise;
      }
      return update(manifest, changes);
    };
    const creating = store.createProposal(app.draft.id, app.jobId, { requestId: randomUUID(), baseVersion: 1, text: 'Move it left.', consent: true });
    await writing.promise;
    const closing = store.close();
    gate.resolve();
    const [proposal] = await Promise.all([creating, closing]);
    assert.equal(proposal.status, 'interrupted');
    assert.equal(model.calls.length, 0);
    assert.equal(JSON.parse(await readFile(app.manifestFile, 'utf8')).proposals[0].status, 'interrupted');
  });

  it('records a successful answer that arrives after shutdown as interrupted, keeping its usage', async () => {
    const gate = deferred();
    const app = await setup({ model: fakeModel([async (call) => { await gate.promise; return { ok: true, plan: plan({ sourceId: call.sourceId }) }; }]) });
    await app.propose();
    // Processing starts before image preparation and the dispatch check, so
    // wait until the provider call has actually been made.
    await waitUntil(async () => app.model.calls.length, (count) => count === 1);
    const closing = app.close();
    gate.resolve();
    await closing;
    const stored = JSON.parse(await readFile(app.manifestFile, 'utf8')).proposals[0];
    assert.equal(stored.status, 'interrupted');
    assert.equal(stored.result, null);
    assert.equal(stored.usage.inputTokens, 900);
    assert.equal(app.model.calls[0].signal.aborted, true);
  });

  it('reopens a scene saved before proposals existed unchanged', async () => {
    const app = await setup();
    try {
      const before = await readFile(app.manifestFile, 'utf8');
      assert.equal(JSON.parse(before).proposals, undefined);
      assert.deepEqual(await (await fetch(`${app.scene}/proposals`)).json(), []);
      assert.equal((await app.history()).length, 1);
      assert.equal(await readFile(app.manifestFile, 'utf8'), before);
      assert.ok((await readdir(path.dirname(app.manifestFile))).includes('assets'));
    } finally {
      await app.close();
    }
  });
});
