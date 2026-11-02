import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';
import { objectSurfaceMeshes } from '../public/photo-scene.js';
import { quaternionFromEuler } from '../public/composition-scene.js';

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
  const source = { kind: 'photo', origin: { kind: 'public' }, permissions: { place: true, model: false, share: true } };
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
  const child = (body) => { const edit = clone(f.parent.edit); if (kind === 'legacy') Object.assign(edit, body.transform); else Object.assign(edit.objects.find((object) => object.id === body.transform.targetId), body.transform.pose ?? { offset: body.transform.offset, yaw: body.transform.yaw }); return { ...clone(f.parent), id: CHILD, label: 'Owner revision', edit: { ...edit, version: null }, revision: { parentVariantId: PARENT, targetId: body.transform.targetId ?? null, timeMode: body.timeMode }, targetId: null, era: body.timeMode === 'unknown' ? { kind: 'unknown' } : clone(ERA), eraRevision: body.timeMode === 'unknown' ? 0 : 1 }; };
  const saveRoute = () => { routes[`POST ${SAVE}`] = (body) => { const saved = child(body); variants = [...variants, saved]; return Promise.resolve(json(201, saved)); }; };
  return { ...f, root, view, find, button, field, choose, begin, input, target, time, preview, child, saveRoute, setVariants(next) { variants = next; } };
}

describe('revision of a selected alternative in the mounted scene workspace', () => {
  for (const kind of ['legacy', 'two-object', 'composition']) it(`${kind}: saves from parent A despite independently changed main B`, async () => {
    const ui = await mount(kind), mainBefore = clone(ui.job.edit), parentBefore = clone(ui.parent);
    let drawn; globalThis.viewerRenderer.render = (scene) => { drawn = scene; };
    await ui.begin(); if (kind !== 'legacy') ui.target();
    ui.input(kind === 'composition' ? 'Position Y' : 'Down / up', 0.5);
    assert.equal(ui.button('Save revised alternative').disabled, true);
    ui.time(); await ui.preview(); assert.equal(ui.button('Save revised alternative').disabled, false);
    if (kind === 'composition') {
      const untouched = drawn.getObjectByName('object-2');
      assert.deepEqual(untouched.position.toArray(), parentBefore.edit.objects[1].position, 'real viewer uses parent B, not main B');
      assert.deepEqual(untouched.quaternion.toArray(), parentBefore.edit.objects[1].quaternion);
      assert.equal(untouched.scale.x, parentBefore.edit.objects[1].scale);
      assert.deepEqual(drawn.getObjectByName('object-1').quaternion.toArray(), parentBefore.edit.objects[0].quaternion, 'translation preserves exact quaternion');
    }
    ui.saveRoute(); ui.button('Save revised alternative').dispatch('click'); await settle();
    const sent = requests.find((entry) => entry.url === SAVE).body;
    assert.deepEqual(Object.keys(sent).sort(), ['requestId', 'baseEraRevision', 'transform', 'timeMode', 'confirmed'].sort());
    assert.equal(sent.baseEraRevision, 2); assert.equal(sent.timeMode, 'unknown'); assert.equal(sent.confirmed, true);
    if (kind === 'composition') assert.deepEqual(sent.transform, { targetId: 'object-1', pose: { position: [-1, 0.5, parentBefore.edit.objects[0].position[2]], quaternion: parentBefore.edit.objects[0].quaternion } });
    else { const base = kind === 'legacy' ? parentBefore.edit : parentBefore.edit.objects[0]; assert.deepEqual(sent.transform, { ...(kind === 'legacy' ? {} : { targetId: 'object-1' }), offset: [base.offset[0], 0.5, base.offset[2]], yaw: base.yaw }); }
    assert.deepEqual(ui.job.edit, mainBefore); assert.deepEqual(ui.parent, parentBefore);
    assert.equal(requests.some((entry) => entry.method === 'POST' && entry.url.endsWith('/edit')), false);
    assert.match(ui.root.textContent, /Owner revision of “Parent alternative”/);
    assert.match(ui.root.textContent, /current scene and its parent alternative are unchanged/);
    assert.match(ui.find((node) => node.className === 'collab-compare')[0].children[0].children[0].textContent, /“Owner revision”/, 'without newer intent the new child is shown');
    const shares = ui.find((node) => node.tag === 'fieldset' && node.children[0]?.textContent === 'Views to share')[0];
    assert.match(shares.textContent, /Owner revision/);
    assert.ok(ui.find((node) => node.tag === 'select' && node.children.some((option) => /Owner revision/.test(option.textContent))).length, 'child is a new story choice');
  });

  it('checks the parent relationship and real photographed meshes before previewing or saving', async () => {
    const ruled = await mount('two-object'); await ruled.begin(); ruled.target(); ruled.input('Left / right', 2); ruled.time(); await ruled.preview();
    assert.match(ruled.root.textContent, /parent alternative’s retained relationship rule/);
    assert.equal(ruled.button('Save revised alternative').disabled, true);
    const noRule = fixture('two-object'); noRule.parent.edit.relationship = null; noRule.context.edit.relationship = null;
    const overlapping = await mount('two-object', { parent: noRule.parent, context: noRule.context }); await overlapping.begin(); overlapping.target();
    const [a, b] = objectSurfaceMeshes(overlapping.surface).objects;
    const other = overlapping.parent.edit.objects[1];
    overlapping.input('Left / right', b.pivot[0] + other.offset[0] - a.pivot[0]);
    overlapping.input('Down / up', other.offset[1]); overlapping.input('Away / toward', other.offset[2]); overlapping.input('Turn (degrees)', other.yaw * 180 / Math.PI);
    overlapping.time(); await overlapping.preview();
    assert.match(overlapping.root.textContent, /photographed surfaces/);
    assert.doesNotMatch(overlapping.find((node) => node.className === 'alternative-revision')[0].textContent, /retained relationship rule/);
    assert.equal(overlapping.button('Save revised alternative').disabled, true);
    assert.equal(requests.some((entry) => entry.url === SAVE), false);
  });

  it('requires a fresh preview after input/time changes and explicit parent time re-confirmation', async () => {
    const ui = await mount(); await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time(); await ui.preview();
    assert.equal(ui.button('Save revised alternative').disabled, false);
    ui.time('reconfirm-parent'); assert.equal(ui.button('Save revised alternative').disabled, true);
    const confirm = ui.find((node) => node.tag === 'label' && /I assert the displayed parent time/.test(node.textContent))[0].children[0];
    assert.equal(confirm.checked, false); confirm.checked = true; confirm.dispatch('change'); await ui.preview();
    ui.input('Position Y', 0.6); assert.equal(ui.button('Save revised alternative').disabled, true);
    await ui.preview(); ui.saveRoute(); ui.button('Save revised alternative').dispatch('click'); await settle();
    assert.equal(requests.find((entry) => entry.url === SAVE).body.timeMode, 'reconfirm-parent');
  });

  it('drops stale parent time and late admission after navigation', async () => {
    const ui = await mount(); await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time();
    routes[`GET ${CONTEXT}`] = () => Promise.resolve(json(200, { ...ui.context, eraRevision: 3 })); await ui.preview();
    assert.match(ui.root.textContent, /parent or its time assertion changed/); assert.equal(ui.button('Save revised alternative').disabled, true);
    ui.button('Close revision').dispatch('click'); ui.button('Show on the scene').dispatch('click');
    let release; routes[`GET ${CONTEXT}`] = () => new Promise((resolve) => { release = resolve; });
    ui.button('Make a revised alternative').dispatch('click'); ui.view.dispose(); release(json(200, ui.context)); await settle();
    assert.equal(ui.find((node) => node.className === 'alternative-revision').length, 0);
  });

  it('replays an unknown save exactly after a later parent time change', async () => {
    const ui = await mount(); await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time(); await ui.preview();
    routes[`POST ${SAVE}`] = () => Promise.resolve(json(503, { error: 'Receipt unavailable.' })); ui.button('Save revised alternative').dispatch('click'); await settle();
    assert.equal(ui.field('Revision Position Y').disabled, true); assert.equal(ui.button('Close revision').disabled, true);
    assert.match(ui.root.textContent, /could not confirm whether this revision was saved/);
    routes[`GET ${CONTEXT}`] = () => Promise.resolve(json(200, { ...ui.context, eraRevision: 3 }));
    routes[`POST ${SAVE}`] = (body) => { const child = ui.child(body); ui.setVariants([ui.parent, child]); return Promise.resolve(json(200, child)); };
    ui.button('Retry the earlier revision save').dispatch('click'); await settle();
    const sent = requests.filter((entry) => entry.url === SAVE); assert.equal(sent.length, 2); assert.deepEqual(sent[1].body, sent[0].body); assert.equal(sent[1].body.baseEraRevision, 2);
  });

  it('withholds parent details and clears preview when inherited support becomes blocked', async () => {
    const ui = await mount(); await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time(); await ui.preview();
    ui.setVariants([{ ...ui.parent, label: 'Blocked reconstruction', blocked: true, era: { kind: 'relative', label: null, statement: null } }]);
    ui.button('Refresh').dispatch('click'); await settle();
    assert.match(ui.root.textContent, /not available under its current sources/); assert.equal(ui.button('Save revised alternative').disabled, true);
    const revision = ui.find((node) => node.className === 'alternative-revision')[0];
    assert.equal(revision.children.find((node) => node.tag === 'fieldset').hidden, true);
    assert.doesNotMatch(revision.textContent, /Owner records/); assert.equal(requests.some((entry) => entry.url === SAVE), false);
  });

  it('clears a failed admission and ignores a late context after closing the local revision form', async () => {
    const ui = await mount();
    routes[`GET ${CONTEXT}`] = () => Promise.resolve(json(403, { error: 'Parent use stopped.' }));
    await ui.begin();
    assert.match(ui.root.textContent, /Parent use stopped/);
    assert.equal(ui.button('Save revised alternative').disabled, true);
    ui.button('Close revision').dispatch('click'); ui.button('Show on the scene').dispatch('click');
    let finish; routes[`GET ${CONTEXT}`] = () => new Promise((resolve) => { finish = resolve; });
    ui.button('Make a revised alternative').dispatch('click');
    assert.equal(ui.button('Close revision').disabled, false, 'a pending read can be canceled');
    ui.button('Close revision').dispatch('click'); finish(json(200, ui.context)); await settle();
    assert.equal(ui.find((node) => node.className === 'alternative-revision').length, 0);
    assert.equal(requests.some((entry) => entry.url === SAVE), false);
  });

  it('does not repaint or reopen after a revision save resolves following navigation', async () => {
    const ui = await mount(); await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time(); await ui.preview();
    let finish, body;
    routes[`POST ${SAVE}`] = (sent) => { body = sent; return new Promise((resolve) => { finish = resolve; }); };
    ui.button('Save revised alternative').dispatch('click');
    ui.view.dispose(); finish(json(201, ui.child(body))); await settle();
    assert.equal(ui.find((node) => node.className === 'alternative-revision').length, 0);
    assert.doesNotMatch(ui.root.textContent, /Saved a new owner revision/);
  });

  for (const choice of ['same parent', 'another alternative', 'main preview', 'main preview then revert']) {
    it(`keeps a newer ${choice} while the confirmed child’s refresh is delayed`, async () => {
      const ui = await mount();
      const other = { ...clone(ui.parent), id: '99999999-9999-4999-8999-999999999999', label: 'Another alternative' };
      ui.setVariants([ui.parent, other]); ui.button('Refresh').dispatch('click'); await settle();
      ui.button('A: Counter').dispatch('click');
      await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time(); await ui.preview();
      let release, saved;
      routes[`POST ${SAVE}`] = (body) => {
        saved = ui.child(body);
        let held = false;
        routes[`GET ${URL}/collaboration`] = () => {
          if (!held) { held = true; return new Promise((resolve) => { release = resolve; }); }
          return Promise.resolve(json(200, { contributions: [], variants: [ui.parent, other, saved], blocked: false, currentVersion: 3 }));
        };
        return Promise.resolve(json(201, saved));
      };
      ui.button('Save revised alternative').dispatch('click'); await settle();
      assert.equal(ui.button('Save revised alternative'), undefined, 'confirmed save cannot be submitted twice');
      if (choice === 'same parent' || choice === 'another alternative') {
        const label = choice === 'same parent' ? 'Parent alternative' : 'Another alternative';
        const row = ui.find((node) => node.tag === 'li' && node.children[0]?.textContent === label)[0];
        const show = row.findAll((node) => node.tag === 'button' && node.textContent === 'Show on the scene')[0];
        assert.equal(show.disabled, false, 'navigation is available while the list refresh waits');
        show.dispatch('click');
      } else {
        const field = ui.field('Position Y');
        assert.equal(field.disabled, false, 'main preview is available while the list refresh waits');
        field.value = '0.8'; field.dispatch('input');
        if (choice === 'main preview then revert') ui.button('Revert to saved').dispatch('click');
      }
      release(json(200, { contributions: [], variants: [ui.parent, other, saved], blocked: false, currentVersion: 3 })); await settle();
      const current = ui.find((node) => node.className === 'collab-compare')[0].children[0].children[0].textContent;
      assert.doesNotMatch(current, /“Owner revision”/);
      if (choice === 'same parent') assert.match(current, /“Parent alternative”/);
      else if (choice === 'another alternative') assert.match(current, /“Another alternative”/);
      else assert.equal(ui.field('Position Y').value, choice === 'main preview' ? '0.8' : String(ui.job.edit.objects[0].position[1]));
      assert.match(ui.root.textContent, /Saved a new owner revision. Your newer view is kept/);
      assert.match(ui.find((node) => node.tag === 'fieldset' && node.children[0]?.textContent === 'Views to share')[0].textContent, /Owner revision/);
      assert.equal(requests.filter((entry) => entry.url === SAVE).length, 1);
    });
  }

  it('keeps a confirmed save terminal when its display refresh fails', async () => {
    const ui = await mount(); await ui.begin(); ui.target(); ui.input('Position Y', 0.5); ui.time(); await ui.preview();
    routes[`POST ${SAVE}`] = (body) => { routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(503, { error: 'Read unavailable.' })); return Promise.resolve(json(201, ui.child(body))); };
    ui.button('Save revised alternative').dispatch('click'); await settle();
    assert.match(ui.root.textContent, /owner revision was saved, but current access could not confirm/);
    assert.equal(ui.button('Save revised alternative'), undefined);
    assert.equal(ui.button('Retry the earlier revision save'), undefined);
    assert.equal(requests.filter((entry) => entry.url === SAVE).length, 1);
  });

  it('allows a revision parent and keeps its target picker independent of main selection', async () => {
    const ui = await mount('composition', { parent: { revision: { parentVariantId: 'earlier', targetId: 'object-2', timeMode: 'unknown' }, targetId: null } });
    ui.button('A: Counter').dispatch('click'); await ui.begin(); ui.target('object-2'); ui.input('Position Y', 0.7); ui.time(); await ui.preview(); ui.saveRoute();
    ui.button('Save revised alternative').dispatch('click'); await settle();
    assert.equal(requests.find((entry) => entry.url === SAVE).body.transform.targetId, 'object-2'); assert.equal(ui.button('A: Counter').attributes['aria-pressed'], 'true');
  });
});
