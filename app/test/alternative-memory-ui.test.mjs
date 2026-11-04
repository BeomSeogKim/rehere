import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';
import { objectSurfaceMeshes, surfacePoint } from '../public/photo-scene.js';
import { copyPose, faceObjectPose, quaternionFromEuler } from '../public/composition-scene.js';

installViewerShim();
const DRAFT = '11111111-1111-4111-8111-111111111111', JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', SECOND = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BASE = `/api/drafts/${DRAFT}/reconstructions`, URL = `${BASE}/${JOB}`;
const CONTEXT = `${URL}/variants/${PARENT}/revision-context`, SAVE = `${URL}/variants/${PARENT}/revisions`;
const ERA = { kind: 'relative', label: 'Before renovation', statement: 'Owner records', relation: null, relativeToVariantId: null, confirmed: true };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const clone = (value) => structuredClone(value);
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const posed = (id, position, angles, scale) => ({ id, position, quaternion: quaternionFromEuler(angles), scale });
function fixture(kind) {
  const size = 20;
  const surface = { schema_version: 2, width: size, height: size, depth: Array(size * size).fill(3),
    regions: Array.from({ length: size * size }, (_, i) => { const [x, y] = [i % size, Math.floor(i / size)]; return y >= 6 && y <= 13 ? x >= 2 && x <= 6 ? 1 : x >= 13 && x <= 17 ? 2 : 0 : 0; }),
    objects: [{ id: 'object-1', label: 'Counter', box_xyxy: [0, 200, 350, 600] }, { id: 'object-2', label: 'Sacks', box_xyxy: [600, 200, 950, 600] }],
    source: { image_size: [1000, 800] }, assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 } };
  let edit = { version: null, objects: [{ id: 'object-1', offset: [0.01234567, 0.01234567, -0.01234567], yaw: 0.123456789 }, { id: 'object-2', offset: [0.23456789, 0.34567891, -0.23456789], yaw: -0.234567891 }], relationship: { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'original-photo' } };
  if (kind === 'composition') edit = { version: null, frame: 'owner-composition', objects: [posed('object-1', [-1, 0.123456789, -3.123456789], [0.123456789, 0.234567891, -0.123456789], 0.5123456789), posed('object-2', [1, 0.345678912, -3.234567891], [-0.23456789, 0.123456789, 0.234567891], 1.234567891)], relationship: { kind: 'left_of', leftId: 'object-1', rightId: 'object-2', frame: 'owner-composition' } };
  if (kind === 'legacy') edit = { version: null, offset: [0.123456789, 0.234567891, -0.234567891], yaw: 0.123456789 };
  const main = { ...clone(edit), version: 3 };
  if (kind === 'composition') { main.objects[1].position = [2, 1.23456789, -4]; main.objects[1].scale = 2.3456789; }
  else if (kind === 'two-object') main.objects[1].offset = [0.9, 1.23456789, -0.5];
  else main.offset = [0.8, 0.9, 0.7];
  const parent = { id: PARENT, label: 'Parent alternative', parentVersion: 1, edit, contributionIds: ['support-a', 'support-b'], createdAt: '2026-11-02T00:00:00Z', createdBy: 'owner', era: clone(ERA), eraRevision: 2, blocked: false, targetId: 'object-1' };
  const context = { parentVariantId: PARENT, eraRevision: 2, latestEra: clone(ERA), edit: clone(edit), contributionIds: [...parent.contributionIds], revisionAllowed: true };
  const job = { id: JOB, draftId: DRAFT, status: 'ready', createdAt: '2026-11-02T00:00:00Z', usageBlocked: false, sourceId: SOURCE, objectsConfirmed: true, edit: main, objects: surface.objects.map(({ id, label, box_xyxy }) => ({ id, label, box: box_xyxy, pivot: [id === 'object-1' ? -0.6 : 0.6, 0, -3] })) };
  let selectedSurface = surface;
  if (kind === 'composition') {
    delete job.sourceId; job.representation = 'two-photo-composition-v1';
    job.sourceBindings = [{ sourceId: SOURCE, objectIds: ['object-1'] }, { sourceId: SECOND, objectIds: ['object-2'] }];
    job.initialArrangement = { ...clone(main), version: 1 };
    selectedSurface = { schema_version: 3, representation: job.representation, components: surface.objects.map((object, i) => ({ id: object.id, label: object.label, selectedObjectId: object.id, texture: `texture-${i + 1}.jpg`, surface })), context: null };
  }
  if (kind === 'legacy') { delete job.objects; delete job.objectsConfirmed; job.box = [0, 200, 350, 600]; selectedSurface = { width: size, height: size, depth: surface.depth, foreground: surface.regions.map((value) => Number(value === 1)), source: surface.source, assumptions: surface.assumptions }; }
  return { kind, surface: selectedSurface, job, parent, context };
}
let mountSpace, routes, requests, mounted;
before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => { const body = options.body ? JSON.parse(options.body) : null; requests.push({ url, method: options.method ?? 'GET', body }); return routes[`${options.method ?? 'GET'} ${url}`]?.(body) ?? Promise.resolve(json(200, [])); };
  ({ mountSpace } = await import('../public/space.js'));
});
beforeEach(() => { routes = {}; requests = []; mounted = []; globalThis.viewerLog = []; });
afterEach(() => { mounted.forEach((view) => view.dispose()); });
async function mount(kind = 'composition', overrides = {}) {
  const f = fixture(kind); Object.assign(f.parent, overrides.parent); Object.assign(f.context, overrides.context);
  let variants = [f.parent];
  routes[`GET ${BASE}`] = () => Promise.resolve(json(200, [f.job]));
  routes[`GET ${URL}`] = () => Promise.resolve(json(200, f.job));
  routes[`GET ${URL}/assets/surface.json`] = () => Promise.resolve(json(200, f.surface));
  routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [], variants, blocked: false, currentVersion: 3 }));
  routes[`GET ${URL}/stories`] = () => Promise.resolve(json(200, { stories: [] }));
  routes[`GET ${URL}/history`] = () => Promise.resolve(json(200, []));
  routes[`GET ${CONTEXT}`] = () => Promise.resolve(json(200, f.context));
  const root = new FakeElement('section');
  const source = { kind: 'photo', origin: { kind: 'public' }, permissions: { place: true, model: true, share: true } };
  const view = mountSpace(root, { draft: { id: DRAFT, photos: [{ sourceId: SOURCE, name: 'first.jpg' }, { sourceId: SECOND, name: 'second.jpg' }], sources: [] }, sourceFor: () => source, sceneId: JOB });
  mounted.push(view); await settle();
  const find = (predicate) => root.findAll(predicate);
  const button = (name) => find((node) => node.tag === 'button' && node.textContent === name)[0];
  const field = (name) => find((node) => node.tag === 'input' && node.attributes['aria-label'] === name)[0];
  const choose = (name) => find((node) => node.tag === 'select' && node.attributes['aria-label'] === name)[0];
  const begin = async () => { button('Show on the scene').dispatch('click'); button('Make a revised alternative').dispatch('click'); await settle(); };
  const input = (name, value) => { const node = field(`Revision ${name}`); node.value = String(value); node.dispatch('input'); };
  const target = (id = 'object-1') => { const node = choose('Object in this alternative to revise'); node.value = id; node.dispatch('change'); };
  const time = (mode = 'unknown') => { const node = choose('Time for revised alternative'); node.value = mode; node.dispatch('change'); };
  const preview = async () => { button('Preview revised alternative').dispatch('click'); await settle(); };
  return { source, ...f, root, view, find, button, field, choose, begin, input, target, time, preview, setVariants(next) { variants = next; } };
}

const PROPOSAL = '88888888-8888-4888-8888-888888888888';
const PROPOSALS = `${URL}/variants/${PARENT}/proposals`;
function proposal(ui, body = {}, action = 'translate') {
  const id = ui.kind === 'legacy' ? 'selected-foreground' : body.targetId ?? 'object-1';
  const candidate = clone(ui.parent.edit);
  const target = ui.kind === 'legacy' ? candidate : candidate.objects.find((object) => object.id === id);
  if (ui.kind === 'composition') {
    if (action === 'face_object') Object.assign(target, faceObjectPose(target, candidate.objects.find((object) => object.id !== id).position));
    else target.position[1] += 0.2;
  } else if (action === 'face_anchor') {
    const pivot = objectSurfaceMeshes(ui.surface).objects.find((object) => object.id === id).pivot;
    const point = surfacePoint(ui.surface, [0.5, 0.1]);
    target.yaw = Math.atan2(point[0] - pivot[0] - target.offset[0], point[2] - pivot[2] - target.offset[2]);
  } else target.offset[1] += 0.2;
  const transform = ui.kind === 'composition' ? copyPose(target) : { offset: [...target.offset], yaw: target.yaw };
  return { id: PROPOSAL, requestId: body.requestId ?? '77777777-7777-4777-8777-777777777777', targetId: id,
    scope: { kind: 'variant', parentVariantId: PARENT, baseEraRevision: body.baseEraRevision ?? 2, timeMode: body.timeMode ?? 'unknown' },
    statement: { text: body.text ?? 'The counter was higher.', modelConsent: true }, status: 'ready', createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
    result: { action, transform, faceObjectId: action === 'face_object' ? 'object-2' : null, anchor: action === 'face_anchor' ? { label: 'upper background', point: [0.5, 0.1] } : null }, candidate, appliedVariantId: null };
}
const memoryChild = (ui, planned) => ({ ...clone(ui.parent), id: CHILD, label: 'Alternative arrangement 4', edit: clone(planned.candidate), targetId: null, revision: { parentVariantId: PARENT, targetId: planned.targetId === 'selected-foreground' ? null : planned.targetId, timeMode: planned.scope.timeMode, proposalId: planned.id } });
async function memory(ui, { withTime = true } = {}) {
  routes[`GET ${PROPOSALS}`] ??= () => Promise.resolve(json(200, []));
  await ui.begin(); if (ui.kind !== 'legacy') ui.target(); if (withTime) ui.time();
  const method = ui.choose('Alternative revision method'); method.value = 'memory'; method.dispatch('change'); await settle();
  const instruction = ui.find((node) => node.tag === 'textarea' && node.attributes['aria-label'] === 'Remembered instruction for this alternative')[0];
  const consent = ui.find((node) => node.tag === 'label' && /Send this instruction and the permitted photo/.test(node.textContent))[0].children[0];
  instruction.value = 'The counter was higher in 1990.'; instruction.dispatch('input'); consent.checked = true; consent.dispatch('change');
  return { instruction, consent, method };
}
async function plan(ui, action = 'translate', alter = (value) => value) {
  let planned;
  routes[`POST ${PROPOSALS}`] = (body) => { planned = proposal(ui, body, action); return Promise.resolve(json(202, alter(clone(planned)))); };
  routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, planned));
  ui.button('Plan a change to this alternative').dispatch('click'); await settle();
  return () => planned;
}
async function previewMemory(ui) { ui.button('Preview alternative proposal').dispatch('click'); await settle(); }
function applyRoute(ui, planned) {
  const child = memoryChild(ui, planned);
  routes[`POST ${PROPOSALS}/${PROPOSAL}/apply`] = () => {
    ui.setVariants([ui.parent, child]);
    return Promise.resolve(json(201, { proposal: { ...planned, status: 'applied', candidate: null, appliedVariantId: CHILD }, variant: child }));
  };
  return child;
}

describe('memory proposals for the selected alternative', () => {
  for (const kind of ['legacy', 'two-object', 'composition']) it(`${kind}: saves only the stored whole-parent proposal as a child`, async () => {
    const ui = await mount(kind); const main = clone(ui.job.edit), parent = clone(ui.parent);
    await memory(ui); const get = await plan(ui);
    assert.equal(requests.some((entry) => entry.url === SAVE), false, 'planning never calls manual save');
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    let drawn; globalThis.viewerRenderer.render = (scene) => { drawn = scene; };
    await previewMemory(ui);
    if (kind === 'composition') {
      assert.deepEqual(drawn.getObjectByName('object-2').position.toArray(), parent.edit.objects[1].position);
      assert.equal(drawn.getObjectByName('object-2').scale.x, parent.edit.objects[1].scale);
      assert.deepEqual(drawn.getObjectByName('object-1').quaternion.toArray(), parent.edit.objects[0].quaternion);
    }
    const planned = get(); applyRoute(ui, planned);
    ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    const create = requests.find((entry) => entry.method === 'POST' && entry.url === PROPOSALS).body;
    assert.deepEqual(Object.keys(create).sort(), ['requestId', 'baseEraRevision', 'targetId', 'timeMode', 'text', 'consent'].sort());
    assert.equal(create.targetId, kind === 'legacy' ? 'selected-foreground' : 'object-1'); assert.equal(create.baseVersion, undefined);
    const sent = requests.find((entry) => entry.method === 'POST' && entry.url.endsWith('/apply')).body;
    assert.deepEqual(sent, { requestId: sent.requestId, baseEraRevision: 2, frontConfirmed: false, confirmed: true });
    assert.deepEqual(ui.job.edit, main); assert.deepEqual(ui.parent, parent);
    assert.equal(requests.some((entry) => entry.method === 'POST' && (entry.url === `${URL}/proposals` || entry.url.endsWith('/edit'))), false);
    assert.match(ui.root.textContent, /Model-assisted owner revision/); assert.ok(ui.button('Inspect saved memory proposal'));
    assert.doesNotMatch(ui.root.textContent, new RegExp(PROPOSAL));
  });

  it('requires explicit object/time/consent and states that dates in the message do not change time', async () => {
    const ui = await mount(); const form = await memory(ui, { withTime: false });
    assert.equal(ui.button('Plan a change to this alternative').disabled, true); ui.time();
    form.consent.checked = false; form.consent.dispatch('change'); assert.equal(ui.button('Plan a change to this alternative').disabled, true);
    form.consent.checked = true; form.consent.dispatch('change'); assert.equal(ui.button('Plan a change to this alternative').disabled, false);
    assert.match(ui.root.textContent, /Dates in your message do not change the selected unknown or re-confirmed time/);
    assert.equal(requests.some((entry) => entry.method === 'POST'), false);
  });

  it('shows the stored answer’s model, change, reason and how it was obtained', async () => {
    let ui = await mount(); await memory(ui);
    const recorded = { mode: 'recorded', model: 'muse-spark-1.3', responseId: 'resp_rec_1', latencyMs: 2345, recordedAt: '2026-11-04T03:00:00.000Z', usage: null };
    await plan(ui, 'translate', (value) => ({ ...value, ...recorded, result: { ...value.result, reason: 'The memory says it was higher.' } }));
    const review = ui.find((node) => node.className === 'alternative-memory-review')[0];
    assert.equal(review.attributes['data-kind'], 'guessed');
    const evidence = () => ui.find((node) => node.className === 'model-evidence')[0];
    assert.equal(evidence().attributes['data-mode'], 'recorded');
    assert.match(evidence().textContent, /Replayed answer from muse-spark-1\.3, recorded 2026-11-04 03:00 UTC.*Meta response ID resp_rec_1 · 2,345 ms when recorded.*A live response to this exact request was recorded and saved unchanged; replaying it sent nothing and cost nothing/);
    assert.match(review.textContent, /Proposal \(AI suggestion\): Move the selected object \(A: Counter\)/);
    assert.match(review.textContent, /Reason given: The memory says it was higher\./);

    ui = await mount(); await memory(ui);
    await plan(ui, 'translate', (value) => ({ ...value, mode: 'simulated', model: null, responseId: null, usage: null, latencyMs: null }));
    assert.equal(evidence().attributes['data-mode'], 'simulated');
    assert.match(evidence().textContent, /SIMULATED answer, not from Meta/);
    assert.match(ui.find((node) => node.className === 'alternative-memory-review')[0].textContent, /Proposal \(SIMULATED, not from Meta\): Move the selected object/);

    ui = await mount('legacy'); await memory(ui);
    await plan(ui, 'face_anchor', (value) => ({ ...value, mode: 'simulated', model: null, responseId: null, usage: null, latencyMs: null }));
    const caption = ui.find((node) => node.tag === 'figcaption')[0].textContent;
    assert.match(caption, /^The simulated answer proposed this point in the source photo\./);
    assert.doesNotMatch(caption, /The model/);
  });

  for (const mismatch of ['requestId', 'era', 'time', 'target', 'missing id']) it(`keeps a mismatched create ${mismatch} response unclear and retries exactly`, async () => {
    const ui = await mount(); await memory(ui);
    await plan(ui, 'translate', (value) => { if (mismatch === 'requestId') value.requestId = 'other'; if (mismatch === 'era') value.scope.baseEraRevision = 3; if (mismatch === 'time') value.scope.timeMode = 'reconfirm-parent'; if (mismatch === 'target') value.targetId = 'object-2'; if (mismatch === 'missing id') delete value.id; return value; });
    assert.ok(ui.button('Retry the earlier alternative plan')); assert.equal(ui.button('Preview alternative proposal'), undefined);
    routes[`POST ${PROPOSALS}`] = (body) => { const fixed = proposal(ui, body); routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, fixed)); return Promise.resolve(json(200, fixed)); };
    ui.button('Retry the earlier alternative plan').dispatch('click'); await settle();
    const sent = requests.filter((entry) => entry.method === 'POST' && entry.url === PROPOSALS);
    assert.deepEqual(sent[1].body, sent[0].body); assert.ok(ui.button('Preview alternative proposal'));
  });

  for (const mismatch of ['proposal', 'parent', 'lineage', 'version']) it(`keeps a mismatched apply ${mismatch} response unclear and replays past a later time change`, async () => {
    const ui = await mount(); await memory(ui); const get = await plan(ui); await previewMemory(ui);
    const planned = get(), child = memoryChild(ui, planned);
    routes[`POST ${PROPOSALS}/${PROPOSAL}/apply`] = () => {
      const result = { proposal: { ...clone(planned), status: 'applied', candidate: null, appliedVariantId: CHILD }, variant: clone(child) };
      if (mismatch === 'proposal') result.proposal.id = 'other'; if (mismatch === 'parent') result.variant.revision.parentVariantId = 'other'; if (mismatch === 'lineage') result.variant.revision.proposalId = 'other'; if (mismatch === 'version') result.variant.edit.version = 1;
      return Promise.resolve(json(201, result));
    };
    ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    assert.match(ui.root.textContent, /save outcome is unknown/);
    const reads = requests.filter((entry) => entry.url === CONTEXT).length;
    routes[`GET ${CONTEXT}`] = () => Promise.resolve(json(200, { ...ui.context, eraRevision: 3 }));
    applyRoute(ui, planned); ui.button('Retry saving the earlier alternative').dispatch('click'); await settle();
    const attempts = requests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/apply'));
    assert.deepEqual(attempts[1].body, attempts[0].body);
    assert.equal(requests.filter((entry) => entry.url === CONTEXT).length, reads, 'committed receipt retry bypasses new time/admission checks');
  });

  for (const [kind, action] of [['legacy', 'face_anchor'], ['composition', 'face_object']]) it(`${action}: requires actual readable guide and an explicit photographed-side confirmation`, async () => {
    const ui = await mount(kind); await memory(ui); const get = await plan(ui, action); await previewMemory(ui);
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    const front = ui.find((node) => node.tag === 'label' && /I choose this photographed side/.test(node.textContent))[0].children[0];
    front.checked = true; front.dispatch('change'); applyRoute(ui, get()); ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    assert.equal(requests.find((entry) => entry.method === 'POST' && entry.url.endsWith('/apply')).body.frontConfirmed, true);
  });

  it('blocks new planning after an initial list failure and recovers only after a successful read', async () => {
    const ui = await mount(); routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(503, null)); await memory(ui);
    assert.equal(ui.button('Plan a change to this alternative').disabled, true);
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, [])); ui.button('Read saved alternative proposals').dispatch('click'); await settle();
    assert.equal(ui.button('Plan a change to this alternative').disabled, false);
  });

  it('inspects an already-applied scoped proposal after reload without offering another save', async () => {
    const ui = await mount(); const ready = proposal(ui), child = memoryChild(ui, ready);
    ui.setVariants([ui.parent, child]); ui.button('Refresh').dispatch('click'); await settle();
    const applied = { ...ready, status: 'applied', candidate: null, appliedVariantId: CHILD };
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, [applied]));
    ui.button('Inspect saved memory proposal').dispatch('click'); await settle();
    assert.ok(ui.button('Inspect the saved alternative')); assert.equal(ui.button('Save proposal as a new alternative'), undefined);
    ui.button('Inspect the saved alternative').dispatch('click'); await settle();
    assert.equal(requests.some((entry) => entry.method === 'POST' && entry.url.endsWith('/apply')), false);
  });
  it('does not accept another proposal from a successful preview GET or poll', async () => {
    const ui = await mount(); await memory(ui); const get = await plan(ui);
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, { ...get(), id: 'another', statement: { text: 'Unexpected other proposal' } }));
    await previewMemory(ui);
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    assert.doesNotMatch(ui.root.textContent, /Unexpected other proposal/);
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, get()));
    await previewMemory(ui); assert.equal(ui.button('Save proposal as a new alternative').disabled, false);
    ui.button('Stop alternative proposal preview').dispatch('click');
    routes[`POST ${PROPOSALS}`] = (body) => Promise.resolve(json(202, { ...proposal(ui, body), status: 'queued', candidate: null, result: null }));
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, { ...get(), id: 'another', statement: { text: 'Unexpected other proposal' } }));
    ui.button('Plan a change to this alternative').dispatch('click'); await settle();
    assert.equal(ui.button('Preview alternative proposal'), undefined, 'wrong poll record never becomes ready here');
    assert.doesNotMatch(ui.root.textContent, /Unexpected other proposal/);
  });

  it('creates no child for clarification or cancel and ignores completion after disposal', async () => {
    const ui = await mount(); await memory(ui);
    routes[`POST ${PROPOSALS}`] = (body) => Promise.resolve(json(202, { ...proposal(ui, body), status: 'clarify', candidate: null, result: { action: 'clarify', question: 'Which side do you mean?' }, question: 'Which side do you mean?' }));
    ui.button('Plan a change to this alternative').dispatch('click'); await settle();
    assert.match(ui.root.textContent, /Which side do you mean/); assert.equal(ui.button('Save proposal as a new alternative'), undefined);
    let release;
    routes[`POST ${PROPOSALS}`] = (body) => { const queued = { ...proposal(ui, body), status: 'queued', candidate: null, result: null }; routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => new Promise((resolve) => { release = resolve; }); return Promise.resolve(json(202, queued)); };
    ui.button('Plan a change to this alternative').dispatch('click'); await settle();
    routes[`POST ${PROPOSALS}/${PROPOSAL}/cancel`] = () => Promise.resolve(json(200, { ...proposal(ui), status: 'canceled', candidate: null, result: null, updatedAt: '2026-11-02T00:01:00Z' }));
    ui.button('Cancel this alternative plan').dispatch('click'); await settle();
    release(json(200, proposal(ui))); await settle();
    assert.equal(ui.button('Save proposal as a new alternative'), undefined);
    assert.equal(requests.some((entry) => entry.url.endsWith('/apply') || entry.url === SAVE), false);
    ui.view.dispose();
    assert.equal(ui.find((node) => node.className === 'alternative-memory-review').length, 0);
  });

  it('retains the exact unclear cancel request when a later list cannot find the proposal', async () => {
    const ui = await mount(); await memory(ui);
    routes[`POST ${PROPOSALS}`] = (body) => Promise.resolve(json(202, { ...proposal(ui, body), status: 'queued', candidate: null, result: null }));
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(503, null));
    ui.button('Plan a change to this alternative').dispatch('click'); await settle();
    routes[`POST ${PROPOSALS}/${PROPOSAL}/cancel`] = () => Promise.resolve(json(503, null));
    ui.button('Cancel this alternative plan').dispatch('click'); await settle();
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, []));
    ui.button('Read saved alternative proposals').dispatch('click'); await settle();
    const retry = ui.button('Retry canceling the earlier plan'); assert.ok(retry); assert.equal(retry.disabled, false);
    routes[`POST ${PROPOSALS}/${PROPOSAL}/cancel`] = () => Promise.resolve(json(200, { ...proposal(ui), status: 'canceled', candidate: null, result: null }));
    retry.dispatch('click'); await settle();
    const attempts = requests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/cancel'));
    assert.deepEqual(attempts[1].body, attempts[0].body);
    assert.equal(ui.button('Plan a change to this alternative').disabled, false);
    assert.equal(requests.some((entry) => entry.url.endsWith('/apply')), false);
  });

  it('blocks ready preview and first apply until an unclear cancel is resolved', async () => {
    const ui = await mount(); await memory(ui);
    let planned;
    routes[`POST ${PROPOSALS}`] = (body) => { planned = proposal(ui, body); return Promise.resolve(json(202, { ...planned, status: 'queued', candidate: null, result: null })); };
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(503, null));
    ui.button('Plan a change to this alternative').dispatch('click'); await settle();
    routes[`POST ${PROPOSALS}/${PROPOSAL}/cancel`] = () => Promise.resolve(json(503, null));
    ui.button('Cancel this alternative plan').dispatch('click'); await settle();
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, [planned]));
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, planned));
    ui.button('Read saved alternative proposals').dispatch('click'); await settle();
    assert.equal(ui.button('Preview alternative proposal').disabled, true);
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    await previewMemory(ui); ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    assert.equal(requests.some((entry) => entry.url.endsWith('/apply')), false);
    assert.equal(ui.button('Retry canceling the earlier plan').disabled, false);
    routes[`POST ${PROPOSALS}/${PROPOSAL}/cancel`] = () => Promise.resolve(json(200, { ...planned, status: 'canceled', candidate: null, result: null }));
    ui.button('Retry canceling the earlier plan').dispatch('click'); await settle();
    const attempts = requests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/cancel'));
    assert.deepEqual(attempts[1].body, attempts[0].body);
    assert.equal(ui.button('Plan a change to this alternative').disabled, false);
  });

  it('blocks an older ready proposal during an unclear create and permits only the frozen create retry', async () => {
    const ui = await mount(); await memory(ui); await plan(ui);
    routes[`POST ${PROPOSALS}`] = () => Promise.resolve(json(503, null));
    ui.button('Plan a change to this alternative').dispatch('click'); await settle();
    assert.equal(ui.button('Preview alternative proposal').disabled, true);
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    await previewMemory(ui); ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    assert.equal(requests.some((entry) => entry.url.endsWith('/apply')), false);
    assert.equal(ui.button('Retry the earlier alternative plan').disabled, false);
    routes[`POST ${PROPOSALS}`] = (body) => Promise.resolve(json(200, { ...proposal(ui, body), id: '99999999-9999-4999-8999-999999999999' }));
    ui.button('Retry the earlier alternative plan').dispatch('click'); await settle();
    const attempts = requests.filter((entry) => entry.method === 'POST' && entry.url === PROPOSALS);
    assert.deepEqual(attempts[2].body, attempts[1].body);
    assert.equal(ui.button('Preview alternative proposal').disabled, false);
  });

  it('blocks a ready proposal while a different saved proposal is still active', async () => {
    const ui = await mount(); await memory(ui); const get = await plan(ui);
    await previewMemory(ui); assert.equal(ui.button('Save proposal as a new alternative').disabled, false);
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, [get(), { ...get(), id: '99999999-9999-4999-8999-999999999999', status: 'processing', candidate: null, result: null }]));
    ui.button('Read saved alternative proposals').dispatch('click'); await settle();
    assert.equal(ui.button('Stop alternative proposal preview').disabled, true);
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    assert.equal(requests.some((entry) => entry.url.endsWith('/apply')), false);
  });

  it('keeps a ready proposal unsavable after model-off while manual revision stays available', async () => {
    const ui = await mount(); await memory(ui); const get = await plan(ui); await previewMemory(ui);
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, [get()]));
    ui.source.permissions.model = false;
    ui.button('Read saved alternative proposals').dispatch('click'); await settle();
    assert.equal(ui.button('Save proposal as a new alternative').disabled, true);
    const method = ui.choose('Alternative revision method'); assert.equal(method.disabled, false);
    method.value = 'manual'; method.dispatch('change');
    assert.equal(ui.field('Revision Position Y').disabled, false);
    ui.input('Position Y', 0.5); await ui.preview();
    assert.equal(ui.button('Save revised alternative').disabled, false);
  });

  it('retains unknown apply recovery when the current parent time read becomes stale', async () => {
    const ui = await mount(); await memory(ui); const get = await plan(ui); await previewMemory(ui);
    routes[`POST ${PROPOSALS}/${PROPOSAL}/apply`] = () => Promise.resolve(json(503, null));
    ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    ui.setVariants([{ ...ui.parent, eraRevision: 3 }]); ui.button('Refresh').dispatch('click'); await settle();
    const retry = ui.button('Retry saving the earlier alternative'); assert.ok(retry);
    assert.equal(retry.disabled, false);
    applyRoute(ui, get()); retry.dispatch('click'); await settle();
    const attempts = requests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/apply'));
    assert.deepEqual(attempts[1].body, attempts[0].body);
  });

  it('preserves a newer parent view when a committed memory child’s refresh is delayed', async () => {
    const ui = await mount(); await memory(ui); const get = await plan(ui); await previewMemory(ui);
    let release;
    routes[`POST ${PROPOSALS}/${PROPOSAL}/apply`] = () => {
      const child = memoryChild(ui, get()); let held = false;
      const body = { contributions: [], variants: [ui.parent, child], blocked: false, currentVersion: 3 };
      routes[`GET ${URL}/collaboration`] = () => !held ? (held = true, new Promise((resolve) => { release = () => resolve(json(200, body)); })) : Promise.resolve(json(200, body));
      return Promise.resolve(json(201, { proposal: { ...get(), status: 'applied', candidate: null, appliedVariantId: CHILD }, variant: child }));
    };
    ui.button('Save proposal as a new alternative').dispatch('click'); await settle();
    ui.button('Show on the scene').dispatch('click'); release(); await settle();
    const current = ui.find((node) => node.className === 'collab-compare')[0].children[0].children[0].textContent;
    assert.match(current, /Parent alternative/); assert.doesNotMatch(current, /Alternative arrangement 4/);
    assert.equal(requests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/apply')).length, 1);
  });

});
