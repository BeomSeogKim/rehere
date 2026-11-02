import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';
import { copyPose, faceObjectPose, quaternionFromEuler } from '../public/composition-scene.js';

installViewerShim();
const DRAFT = '11111111-1111-4111-8111-111111111111';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARENTS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const SOURCES = ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'];
const BASE = `/api/drafts/${DRAFT}/reconstructions`;
const JOB_URL = `${BASE}/${JOB}`;
const REPRESENTATION = 'two-photo-composition-v1';
const pose = (position, scale = 1, angles = [0, 0, 0]) => ({ position, quaternion: quaternionFromEuler(angles), scale });
const initial = { version: 1, frame: 'owner-composition', objects: [
  { id: 'object-1', ...pose([-1, 0.125678, -3], 0.512345, [0.1, 0.2, 0.05]) },
  { id: 'object-2', ...pose([1, 0, -3], 1.234567, [-0.1, 0.1, 0.2]) },
], relationship: null };
function parentSurface(index) {
  const width = 12, height = 10;
  return { width, height,
    depth: Array.from({ length: width * height }, (_, i) => 3 + (i % width) * 0.01),
    foreground: Array.from({ length: width * height }, (_, i) => { const [x, y] = [i % width, Math.floor(i / width)]; return x >= 4 && x <= 7 && y >= 3 && y <= 6 ? 1 : 0; }),
    source: { image_size: [600 + index * 100, 500], selected_object: { box_xyxy: [180, 100, 450, 400] } },
    assumptions: { horizontal_fov_degrees: 50 + index * 10, max_triangle_depth_span: 0.35 },
  };
}
const surfaces = [parentSurface(0), parentSurface(1)];
const compositionSurface = { schema_version: 3, representation: REPRESENTATION,
  components: surfaces.map((surface, index) => ({ id: `object-${index + 1}`, label: ['Cabinet', 'Table'][index], selectedObjectId: 'selected-foreground', texture: `texture-${index + 1}.jpg`, surface })), context: null };
const parents = PARENTS.map((id, index) => ({ id, sourceId: SOURCES[index], status: 'ready', usageBlocked: false, box: [180, 100, 450, 400], derivedAssets: [{ name: 'surface.json', sha256: String(index + 1).repeat(64) }], createdAt: '2026-11-01T00:00:00Z' }));
const job = (overrides = {}) => ({ id: JOB, representation: REPRESENTATION, status: 'ready', usageBlocked: false, objectsConfirmed: true,
  createdAt: '2026-11-01T00:00:00Z', sourceBindings: SOURCES.map((sourceId, index) => ({ sourceId, objectIds: [`object-${index + 1}`] })),
  objects: ['Cabinet', 'Table'].map((label, index) => ({ id: `object-${index + 1}`, label, box: [180, 100, 450, 400], component: { sourcePivot: [0, 0, -3] } })),
  initialArrangement: structuredClone(initial), edit: structuredClone(initial), ...overrides });
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const granted = { kind: 'photo', provider: 'Public archive', origin: { kind: 'public' }, permissions: { place: true, model: true, share: true } };
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
let mountSpace;
let mountVisitor;
let routes;
let requests;
let mounted;
before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    return routes[`${options.method ?? 'GET'} ${url}`]?.(body) ?? Promise.resolve(json(200, []));
  };
  ({ mountSpace } = await import('../public/space.js'));
  ({ mountVisitor } = await import('../public/visits.js'));
});
beforeEach(() => {
  requests = []; mounted = []; globalThis.viewerLog = []; delete globalThis.viewerFail;
  routes = { [`GET ${BASE}`]: () => Promise.resolve(json(200, [...parents, job()])), [`GET ${JOB_URL}`]: () => Promise.resolve(json(200, job())), [`GET ${JOB_URL}/assets/surface.json`]: () => Promise.resolve(json(200, compositionSurface)) };
  parents.forEach((parent, index) => { routes[`GET ${BASE}/${parent.id}`] = () => Promise.resolve(json(200, parent)); routes[`GET ${BASE}/${parent.id}/assets/surface.json`] = () => Promise.resolve(json(200, surfaces[index])); });
});
afterEach(() => { mounted.forEach((entry) => entry.dispose()); });
async function mount({ open = true, sourceFor = () => granted } = {}) {
  const container = new FakeElement('section');
  const space = mountSpace(container, { draft: { id: DRAFT, photos: SOURCES.map((sourceId, index) => ({ sourceId, name: `photo-${index}.jpg` })), sources: [] }, sourceFor, sceneId: open ? JOB : null });
  mounted.push(space); await settle();
  const find = (predicate) => container.findAll(predicate);
  return { container, find, button: (name) => find((node) => node.tag === 'button' && node.textContent === name)[0], field: (name) => find((node) => node.tag === 'input' && node.attributes['aria-label'] === name)[0] };
}

async function prepareComposition(ui, { samePhoto = false, context = true } = {}) {
  ui.button('Compose objects from two photos').dispatch('click'); await settle();
  const selects = ui.find((node) => node.tag === 'select');
  for (let index = 0; index < 2; index += 1) { selects[index].value = `${PARENTS[samePhoto ? 0 : index]}|selected-foreground`; selects[index].dispatch('change'); }
  await settle();
  ['A', 'B'].forEach((letter, index) => { const input = ui.field(`Name object ${letter}`); input.value = ['Cabinet', 'Table'][index]; input.dispatch('input'); });
  if (!context) {
    const keep = ui.find((node) => node.tag === 'label' && /Keep the first photo/.test(node.textContent))[0].children[0];
    keep.checked = false; keep.dispatch('change');
  }
  ui.button('Preview the composition').dispatch('click'); await settle();
}

describe('composition owner workspace', () => {
  it('preserves untouched pose coordinates, quaternion and other object while changing explicit relative scale', async () => {
    const ui = await mount();
    ui.button('A: Cabinet').dispatch('click');
    ui.field('Assumed relative scale').value = '0.7'; ui.field('Assumed relative scale').dispatch('input');
    routes[`POST ${JOB_URL}/edit`] = (body) => Promise.resolve(json(200, { ...structuredClone(initial), version: 2, objects: [{ id: 'object-1', ...body.pose }, initial.objects[1]] }));
    ui.button('Apply and save').dispatch('click'); await settle();
    const sent = requests.find((entry) => entry.url === `${JOB_URL}/edit`).body;
    assert.deepEqual(sent.pose, { ...copyPose(initial.objects[0]), scale: 0.7 });
    assert.equal(ui.button('Original viewpoint').hidden, true);
    assert.match(ui.container.textContent, /Position, orientation and relative scale are assumptions/);
    ui.button('B: Table').dispatch('click');
    assert.equal(ui.field('Assumed relative scale').value, String(initial.objects[1].scale));
    const sourceImage = ui.find((node) => node.tag === 'img' && /with the box/.test(node.alt))[0];
    assert.equal(sourceImage.src, `${JOB_URL}/assets/texture-2.jpg`);
  });

  it('confirms both source identities and assumed layout using the agreed composition body', async () => {
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ objectsConfirmed: false })));
    const ui = await mount();
    const button = ui.button('Confirm these surfaces and my assumed layout');
    assert.equal(button.disabled, true);
    const checks = ui.find((node) => node.tag === 'input' && node.type === 'checkbox');
    checks.forEach((check) => { check.checked = true; check.dispatch('change'); });
    routes[`POST ${JOB_URL}/objects/confirm`] = () => Promise.resolve(json(200, job()));
    button.dispatch('click'); await settle();
    const sent = requests.find((entry) => entry.url.endsWith('/objects/confirm')).body;
    assert.deepEqual(sent, { requestId: sent.requestId, objectIds: ['object-1', 'object-2'], surfaceIdentityConfirmed: true, layoutConfirmed: true, scaleBasis: 'owner-assumed-relative' });
  });

  it('resets to the explicit initial pose rather than synthesizing a zero placement', async () => {
    const moved = structuredClone(initial); moved.version = 2; moved.objects[0].position = [-2, 0.8, -4]; moved.objects[0].scale = 0.9;
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ edit: moved })));
    const ui = await mount(); ui.button('A: Cabinet').dispatch('click');
    ui.button('Reset object to initial pose').dispatch('click');
    assert.equal(ui.field('Position X').value, String(initial.objects[0].position[0]));
    assert.equal(ui.field('Assumed relative scale').value, String(initial.objects[0].scale));
    routes[`POST ${JOB_URL}/edit`] = (body) => Promise.resolve(json(200, { ...structuredClone(initial), version: 3 }));
    ui.button('Apply and save').dispatch('click'); await settle();
    assert.deepEqual(requests.find((entry) => entry.url === `${JOB_URL}/edit`).body.pose, copyPose(initial.objects[0]));
  });

  it('uses both actual photo source records for model eligibility without blocking deterministic viewing', async () => {
    const ui = await mount({ sourceFor: (id) => id === SOURCES[1] ? { ...granted, permissions: { place: true, model: false, share: true } } : granted });
    assert.match(ui.container.textContent, /Planning from a memory needs/);
    assert.equal(ui.button('Plan a change'), undefined);
    ui.button('A: Cabinet').dispatch('click');
    assert.equal(ui.field('Assumed relative scale').disabled, false);
  });

  it('keeps contribution candidates on their own object with scale absent from the submitted pose', async () => {
    const contribution = { id: 'contribution', revision: 1, provider: { displayName: 'Visitor' }, kind: 'human_recollection', text: 'The cabinet was a little higher.', permissions: { place: true, model: false, share: true }, status: 'submitted', review: null };
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [contribution], variants: [], blocked: false }));
    const ui = await mount();
    ui.button('Review').dispatch('click');
    const decision = ui.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'alternative'))[0];
    decision.value = 'alternative'; decision.dispatch('change');
    ui.button('A: Cabinet').dispatch('click');
    const height = ui.field('Candidate Position Y');
    height.value = '0.5'; height.dispatch('input');
    assert.equal(ui.field('Candidate Assumed relative scale'), undefined);
    ui.button('Preview candidate on the scene').dispatch('click');
    routes[`POST ${JOB_URL}/contributions/contribution/review`] = () => Promise.resolve(json(200, { contribution: { ...contribution, status: 'alternative' } }));
    ui.button('Save decision').dispatch('click'); await settle();
    const body = requests.find((entry) => entry.url.endsWith('/contribution/review')).body;
    assert.deepEqual(body.transform, { targetId: 'object-1', pose: { position: [-1, 0.5, -3], quaternion: initial.objects[0].quaternion } });
    assert.equal(ui.field('Assumed relative scale').value, String(initial.objects[0].scale));
  });

  it('previews a model face-object proposal and applies only after the photographed-side confirmation', async () => {
    const transform = faceObjectPose(initial.objects[0], initial.objects[1].position);
    const proposal = { id: 'proposal', targetId: 'object-1', baseVersion: 1, status: 'ready', statement: { text: 'The cabinet faced the table.' }, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', result: { action: 'face_object', targetId: 'object-1', faceObjectId: 'object-2', sourceIds: SOURCES, transform, reason: 'It faced the table.' } };
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, [proposal]));
    const ui = await mount();
    assert.match(ui.container.textContent, /Saved now \(version 1\): In the owner's assumed layout/);
    assert.match(ui.container.textContent, /After this change: In the owner's assumed layout/);
    assert.doesNotMatch(ui.container.textContent, /owner position|orientation 0\.\d+,/);
    ui.button('Preview on the scene').dispatch('click');
    assert.equal(ui.button('Apply and save this proposal').disabled, true);
    const front = ui.find((node) => node.tag === 'label' && /I choose this photographed side/.test(node.textContent))[0].children[0];
    front.checked = true; front.dispatch('change');
    routes[`POST ${JOB_URL}/proposals/proposal/apply`] = () => Promise.resolve(json(200, { edit: { ...structuredClone(initial), version: 2, objects: [{ id: 'object-1', ...transform }, initial.objects[1]] }, proposal: { ...proposal, status: 'applied' } }));
    ui.button('Apply and save this proposal').dispatch('click'); await settle();
    assert.equal(requests.find((entry) => entry.url.endsWith('/proposal/apply')).body.frontConfirmed, true);
    assert.match(ui.container.textContent, /Saved new arrangement version 2/);
  });

  it('requires explicit photographed-side acknowledgment for a local face-object preview', async () => {
    const ui = await mount();
    ui.button('A: Cabinet').dispatch('click');
    ui.button('Preview photographed side facing the other object').dispatch('click');
    assert.equal(ui.button('Apply and save').disabled, true);
    const label = ui.find((node) => node.tag === 'label' && /I choose the photographed side/.test(node.textContent))[0];
    label.children[0].checked = true; label.children[0].dispatch('change');
    assert.equal(ui.button('Apply and save').disabled, false);
  });
});

describe('composition creation', () => {
  it('drops a source read if the person clears that selection before it finishes', async () => {
    const ui = await mount({ open: false });
    ui.button('Compose objects from two photos').dispatch('click'); await settle();
    let finish;
    routes[`GET ${BASE}/${PARENTS[0]}`] = () => new Promise((resolve) => { finish = resolve; });
    const first = ui.find((node) => node.tag === 'select')[0];
    first.value = `${PARENTS[0]}|selected-foreground`; first.dispatch('change');
    first.value = ''; first.dispatch('change');
    finish(json(200, parents[0])); await settle();
    assert.equal(ui.find((node) => node.tag === 'img').length, 0, 'cleared source never reappears from an older read');
    ui.button('Preview the composition').dispatch('click');
    assert.match(ui.container.textContent, /Choose both source objects/);
    assert.equal(ui.button('Save this composition').disabled, true);
  });

  it('refuses two components of one source photo before preview or creation', async () => {
    const ui = await mount({ open: false });
    await prepareComposition(ui, { samePhoto: true });
    assert.match(ui.container.textContent, /two different photos of this place/);
    assert.equal(ui.button('Save this composition').disabled, true);
    assert.equal(requests.some((entry) => entry.method === 'POST' && entry.url === BASE), false);
    assert.equal(globalThis.viewerLog.length, 0);
  });

  it('retries an unknown creation exactly and labels an explicit no-background composition', async () => {
    const ui = await mount({ open: false });
    await prepareComposition(ui, { context: false });
    assert.match(ui.container.textContent, /only two observed surfaces are shown. No room background is included/);
    const check = ui.find((node) => node.tag === 'label' && /I inspected the two surfaces/.test(node.textContent))[0].children[0];
    check.checked = true; check.dispatch('change');
    let attempts = 0;
    routes[`POST ${BASE}`] = () => Promise.resolve(++attempts === 1 ? json(503, { error: 'Unknown save' }) : attempts === 2 ? json(403, { error: 'Access unavailable' }) : json(200, job()));
    ui.button('Save this composition').dispatch('click'); await settle();
    assert.equal(ui.field('A Assumed relative scale').disabled, true);
    assert.match(ui.container.textContent, /save outcome is unknown/);
    ui.button('Retry saving the same composition').dispatch('click'); await settle();
    assert.match(ui.container.textContent, /outcome remains unknown/);
    assert.equal(ui.field('A Assumed relative scale').disabled, true, 'a failed access check does not settle an earlier save');
    ui.button('Retry saving the same composition').dispatch('click'); await settle();
    const sent = requests.filter((entry) => entry.method === 'POST' && entry.url === BASE);
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.deepEqual(sent[2].body, sent[0].body);
    assert.deepEqual(sent[0].body.context, { keep: false, bounds: null });
  });

  it('keeps an unresolved composition warning through a background completion, its list failure and later navigation', async () => {
    const BACKGROUND = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const building = { id: BACKGROUND, sourceId: SOURCES[0], status: 'processing', createdAt: '2026-11-01T00:00:00Z', usageBlocked: false };
    routes[`GET ${BASE}`] = () => Promise.resolve(json(200, [...parents, job(), building]));
    let finish;
    routes[`GET ${BASE}/${BACKGROUND}`] = () => new Promise((resolve) => { finish = resolve; });
    const ui = await mount({ open: false });
    assert.ok(finish, 'the background build is being polled');
    await prepareComposition(ui, { context: false });
    const check = ui.find((node) => node.tag === 'label' && /I inspected the two surfaces/.test(node.textContent))[0].children[0];
    check.checked = true; check.dispatch('change');
    routes[`POST ${BASE}`] = () => Promise.resolve(json(503, { error: 'Unknown save' }));
    ui.button('Save this composition').dispatch('click'); await settle();
    ui.button('Cancel').dispatch('click'); await settle();
    const status = ui.container.children.find((node) => node.role === 'status');
    const warning = 'The composition save outcome is unknown. Check the refreshed saved scene list before starting another composition.';
    assert.equal(status.textContent, warning);
    routes[`GET ${BASE}`] = () => Promise.resolve(json(503, null));
    finish(json(200, { ...building, status: 'ready' })); await settle();
    assert.equal(status.textContent, warning, 'neither the completion nor its list failure replaces the warning');
    const background = ui.find((node) => node.className === 'hint space-background')[0];
    assert.equal(background.textContent, 'Photo 1: A partial scene finished building. The saved scene list could not be loaded; reload the page to see it.');
    ui.button('Build a partial scene').dispatch('click'); await settle();
    assert.equal(status.textContent, warning, 'a later navigation keeps the warning');
  });

  it('previews two distinct stored surfaces and saves exact explicit poses with optional fixed context', async () => {
    const ui = await mount({ open: false });
    ui.button('Compose objects from two photos').dispatch('click'); await settle();
    const selects = ui.find((node) => node.tag === 'select');
    for (let index = 0; index < 2; index += 1) { selects[index].value = `${PARENTS[index]}|selected-foreground`; selects[index].dispatch('change'); }
    await settle();
    const names = ['A', 'B'].map((letter) => ui.field(`Name object ${letter}`));
    names[0].value = 'Cabinet'; names[1].value = 'Table'; names.forEach((name) => name.dispatch('input'));
    ui.button('Preview the composition').dispatch('click'); await settle();
    assert.ok(globalThis.viewerLog.includes(`texture ${BASE}/${PARENTS[0]}/assets/texture.jpg`));
    assert.ok(globalThis.viewerLog.includes(`texture ${BASE}/${PARENTS[1]}/assets/texture.jpg`));
    const confirm = ui.find((node) => node.tag === 'label' && /I inspected the two surfaces/.test(node.textContent))[0].children[0];
    confirm.checked = true; confirm.dispatch('change');
    routes[`POST ${BASE}`] = () => { routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, job({ objectsConfirmed: false }))); return Promise.resolve(json(201, job({ objectsConfirmed: false }))); };
    ui.button('Save this composition').dispatch('click'); await settle();
    const sent = requests.find((entry) => entry.method === 'POST' && entry.url === BASE).body;
    assert.equal(sent.kind, 'two-photo-composition');
    assert.equal(sent.scaleBasis, 'owner-assumed-relative');
    assert.deepEqual(sent.context, { keep: true, bounds: null });
    assert.equal(sent.objects[1].component.surfaceSha256, '2'.repeat(64));
    assert.deepEqual(sent.objects[0].pose, pose([-1, 0, -3]));
    assert.ok(ui.button('Confirm these surfaces and my assumed layout'));
  });
});

function publicPacket() {
  return { id: 'snapshot', title: 'Shared two-photo place', representation: REPRESENTATION, scaleBasis: 'owner-assumed-relative', createdAt: '2026-11-01T00:00:00Z', startViewId: 'view-1', camera: { position: [0, 0, 5], target: [0, 0, -3] },
    objects: job().objects.map(({ id, label, box }, index) => ({ id, label, box, sourceIndex: index + 1 })),
    views: [{ id: 'view-1', label: 'Assumed layout', edit: structuredClone(initial), evidence: { photos: [{ objectId: 'object-1', providerLabel: 'Archive A' }, { objectId: 'object-2', providerLabel: 'Archive B' }], arrangement: 'initial' } }], stories: [] };
}
describe('composition visitor', () => {
  for (const fallback of [false, true]) it(`explains a saved relation change without numeric poses in ${fallback ? '2D fallback' : '3D'}`, async () => {
    if (fallback) globalThis.viewerFail = 'webgl';
    const packet = publicPacket();
    const changed = structuredClone(packet.views[0]);
    changed.id = 'view-2'; changed.label = 'Another arrangement';
    changed.edit.objects[0] = { id: 'object-1', ...pose([2, 0.8, -2.5], 0.7, [0, Math.PI / 2, 0]) };
    packet.views.push(changed);
    const container = new FakeElement('section');
    const visitor = mountVisitor(container, { kind: 'preview', manifest: async () => packet, check: async () => true,
      asset: async () => ({ ok: true, json: async () => compositionSurface, blob: async () => new Blob(['photo']) }) });
    mounted.push(visitor); await settle();
    container.findAll((node) => node.tag === 'button' && node.textContent === changed.label)[0].dispatch('click');
    const details = container.findAll((node) => node.className === 'visit-details')[0].textContent;
    assert.match(details, /A: Cabinet.*right of B: Table/);
    assert.match(details, /owner[’']s assumed layout/i);
    assert.match(details, /assumed relative size/i);
    assert.doesNotMatch(details, /owner position|position, orientation.*different|0\.125678|0\.512345/);
  });

  for (const fallback of [false, true]) it(`keeps recollections on the selected object and saved view in ${fallback ? '2D fallback' : '3D'}`, async () => {
    if (fallback) globalThis.viewerFail = 'webgl';
    const packet = publicPacket();
    const support = (objectId, providerLabel) => ({ kind: 'human_recollection', objectId, providerLabel, status: 'owner-selected' });
    packet.views[0].evidence.support = [support('object-1', 'Person A'), support('object-2', '<b>Person B</b>')];
    packet.views.push({ ...structuredClone(packet.views[0]), id: 'view-2', label: 'Another recollection', evidence: {
      ...structuredClone(packet.views[0].evidence), support: [support('object-1', 'Another person'), support(null, 'Unknown target')],
    } });
    const container = new FakeElement('section');
    const visitor = mountVisitor(container, { kind: 'preview', manifest: async () => packet, check: async () => true,
      asset: async () => ({ ok: true, json: async () => compositionSurface, blob: async () => new Blob(['photo']) }) });
    mounted.push(visitor); await settle();
    assert.equal(visitor.state(), fallback ? '2d' : '3d');
    const button = (text) => container.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
    const evidence = () => container.findAll((node) => node.className === 'object-evidence')[0];
    button('A: Cabinet').dispatch('click');
    assert.match(evidence().textContent, /about A: Cabinet by Person A/);
    assert.doesNotMatch(evidence().textContent, /Person B|Unknown target/);
    button('B: Table').dispatch('click');
    assert.match(evidence().textContent, /about B: Table by <b>Person B<\/b>/);
    assert.doesNotMatch(evidence().textContent, /Person A/);
    assert.equal(evidence().findAll((node) => node.tag === 'b').length, 0, 'provider text is not markup');
    button('Another recollection').dispatch('click');
    assert.match(evidence().textContent, /in “Another recollection”/);
    assert.match(evidence().textContent, /No recollection about this object/);
    assert.match(evidence().textContent, /object was not recorded. It is not assigned to this object/);
    assert.doesNotMatch(evidence().textContent, /Person B|Another person|Unknown target/);
    button('A: Cabinet').dispatch('click');
    assert.match(evidence().textContent, /about A: Cabinet by Another person/);
    assert.doesNotMatch(evidence().textContent, /Person A|Person B/);
    assert.equal(container.findAll((node) => node.className === 'memory-text').length, 0, 'support attribution does not grant a quotation');
  });

  it('leaves the object unknown for older composition support with no target field', async () => {
    const packet = publicPacket();
    packet.views[0].evidence.support = [{ kind: 'human_recollection', providerLabel: 'Earlier contributor', status: 'owner-selected' }];
    const container = new FakeElement('section');
    const visitor = mountVisitor(container, { kind: 'preview', manifest: async () => packet, check: async () => true,
      asset: async () => ({ ok: true, json: async () => compositionSurface, blob: async () => new Blob(['photo']) }) });
    mounted.push(visitor); await settle();
    for (const label of ['A: Cabinet', 'B: Table']) {
      container.findAll((node) => node.tag === 'button' && node.textContent === label)[0].dispatch('click');
      const evidence = container.findAll((node) => node.className === 'object-evidence')[0];
      assert.match(evidence.textContent, /No recollection about this object/);
      assert.match(evidence.textContent, /object was not recorded/);
      assert.doesNotMatch(evidence.textContent, /by Earlier contributor/);
    }
  });

  it('closes the whole visitor when either texture is unavailable, and drops a late second texture after disposal', async () => {
    const container = new FakeElement('section');
    const source = { kind: 'preview', manifest: async () => publicPacket(), check: async () => true, asset: async (view, name) => ({ ok: name !== 'texture-2.jpg', json: async () => compositionSurface, blob: async () => new Blob([name]) }) };
    const visitor = mountVisitor(container, source); mounted.push(visitor); await settle();
    assert.equal(visitor.state(), 'unavailable');
    assert.equal(globalThis.viewerLog.length, 0, 'no partial one-texture scene');
    let finish;
    const late = mountVisitor(new FakeElement('section'), { ...source, asset: async (view, name) => name === 'texture-2.jpg' ? new Promise((resolve) => { finish = resolve; }) : { ok: true, json: async () => compositionSurface, blob: async () => new Blob([name]) } });
    mounted.push(late); await settle(); late.dispose();
    finish({ ok: true, blob: async () => new Blob(['second']) }); await settle();
    assert.equal(globalThis.viewerLog.length, 0, 'a late pair never starts a disposed viewer');
  });

  it('loads both textures, uses selected-source evidence and offers no global photograph comparison', async () => {
    const container = new FakeElement('section');
    const assets = [];
    const source = { kind: 'preview', manifest: async () => publicPacket(), check: async () => true, asset: async (view, name) => { assets.push(name); return { ok: true, json: async () => compositionSurface, blob: async () => new Blob([name], { type: 'image/jpeg' }) }; } };
    const visitor = mountVisitor(container, source); mounted.push(visitor); await settle();
    assert.equal(visitor.state(), '3d');
    assert.deepEqual(assets, ['surface.json', 'texture-1.jpg', 'texture-2.jpg']);
    const button = (text) => container.findAll((node) => node.tag === 'button' && node.textContent === text)[0];
    assert.equal(button('Compare with the photograph').hidden, true);
    button('B: Table').dispatch('click');
    const evidence = container.findAll((node) => node.className === 'object-evidence')[0];
    assert.match(evidence.textContent, /composition pose and relative scale were chosen by the owner/);
    assert.match(container.textContent, /Archive A/); assert.match(container.textContent, /Archive B/);
  });
});
