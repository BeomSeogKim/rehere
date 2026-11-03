import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { FakeElement } from './fake-dom.mjs';

// The visitor screen's 3D viewer is replaced by a recorder; Node has no WebGL.
const viewerStub = `export function createViewer(...args) { globalThis.visitViewerCalls.push(args); return Promise.resolve({ dispose() { globalThis.visitViewerCalls.disposed = true; }, applyEdit(edit) { globalThis.visitViewerCalls.edits.push(edit); }, setCamera() {}, getCamera() { return null; }, originalView() { return true; }, setInteractive() {}, isInteractive() { return false; } }); }
export function createExploreToggle() { const button = document.createElement('button'); const status = document.createElement('p'); return { button, status, attach() {}, detach() {} }; }
export function createInspectToggle() { const button = document.createElement('button'); const note = document.createElement('p'); return { button, note, attach() {} }; }`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './scene-viewer.js' && context.parentURL?.endsWith('/public/visits.js')) return { url: `data:text/javascript,${encodeURIComponent(viewerStub)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const DRAFT = '11111111-1111-4111-8111-111111111111', JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASELINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PROPOSAL = '88888888-8888-4888-8888-888888888888';
const JOB_URL = `/api/drafts/${DRAFT}/reconstructions/${JOB}`;
const PROPOSALS = `${JOB_URL}/variants/${BASELINE}/proposals`;
const B = {
  buildId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256: 'e'.repeat(64), asset: 'object.glb', sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  sourceSha256: 'b'.repeat(64), outlineId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', outlineSha256: 'd'.repeat(64),
  initial: { position: [0, 0, -3], quaternion: [0, 0, 0, 1], scale: 1, modelPivot: [0, 0, 0] },
};
const CHECKED = { status: 'checked', scope: 'retained-geometry-only', reason: null };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const baselineVariant = () => ({ id: BASELINE, label: 'Starting alternative', parentVersion: 4, edit: { version: null, offset: [0, 0, 0], yaw: 0, fullObject: structuredClone(B) }, contributionIds: [], createdAt: '2026-11-03T00:00:00Z', createdBy: 'owner', era: { kind: 'unknown' }, eraRevision: 0, blocked: false, targetId: 'selected-foreground' });

let mountCollaboration, mountAlternativeMemory, mountShares, mountVisitor, visitSource, routes, requests, mounted;
const realFetch = globalThis.fetch;
before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    return routes[`${options.method ?? 'GET'} ${url}`]?.(body) ?? Promise.resolve(json(200, []));
  };
  ({ mountCollaboration } = await import('../public/collaboration.js'));
  ({ mountAlternativeMemory } = await import('../public/alternative-memory.js'));
  ({ mountVisitor, visitSource } = await import('../public/visits.js'));
  ({ mountShares } = await import('../public/shares.js'));
});
beforeEach(() => { routes = {}; requests = []; mounted = []; });
afterEach(() => mounted.forEach((panel) => panel.dispose?.()));

function owner(variants) {
  const root = new FakeElement('section');
  const shown = [];
  const panel = mountCollaboration(root, {
    jobUrl: JOB_URL, fullObject: true,
    editor: () => ({ version: 4, offset: [0, 0, 0], yaw: 0, fullObject: B, clean: true }),
    showTransform(transform) { shown.push(transform); return Boolean(transform); },
    setLocked() {}, saved() {}, unconfirmed() {}, conflict() {}, onChanged() {},
    memorySources: [{ origin: { kind: 'public' }, permissions: { place: true, model: true } }],
  });
  mounted.push(panel);
  const find = (predicate) => root.findAll(predicate);
  const button = (name) => find((node) => node.tag === 'button' && node.textContent === name)[0];
  const field = (name) => find((node) => node.attributes['aria-label'] === name)[0];
  return { root, find, button, field, shown, variants };
}

describe('full-object owner alternatives', () => {
  it('starts one alternative from the current scene and retries the same request after an unknown outcome', async () => {
    let variants = [];
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [], variants, blocked: false, currentVersion: 4 }));
    const view = owner();
    await settle();
    const start = 'Save the current scene as a starting alternative';
    assert.ok(view.button(start), 'a full-object scene offers a starting alternative');
    routes[`POST ${JOB_URL}/variants/baseline`] = () => Promise.resolve(json(503, null));
    view.button(start).dispatch('click');
    await settle();
    const first = requests.filter((entry) => entry.method === 'POST');
    assert.equal(first.length, 1);
    assert.deepEqual(Object.keys(first[0].body).sort(), ['baseVersion', 'requestId']);
    assert.equal(first[0].body.baseVersion, 4);
    routes[`POST ${JOB_URL}/variants/baseline`] = () => { variants = [baselineVariant()]; return Promise.resolve(json(201, baselineVariant())); };
    view.button('Retry saving the starting alternative').dispatch('click');
    await settle();
    const posts = requests.filter((entry) => entry.method === 'POST');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, posts[0].body, 'the retry repeats the identical request');
    assert.equal(view.button(start), undefined, 'no second copy is offered once the current scene has one');
    assert.deepEqual(view.shown.at(-1)?.fullObject, B, 'the saved alternative is shown with its own object binding');
  });

  it('keeps height fixed and keeps the form open when the server holds a movement', async () => {
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [], variants: [baselineVariant()], blocked: false, currentVersion: 4 }));
    routes[`GET ${JOB_URL}/variants/${BASELINE}/revision-context`] = () => Promise.resolve(json(200, {
      parentVariantId: BASELINE, eraRevision: 0, latestEra: { kind: 'unknown' }, edit: baselineVariant().edit, contributionIds: [], revisionAllowed: true,
      motion: { status: 'held', scope: 'retained-geometry-only', reason: 'The starting pose was not checked.' },
      capabilities: { actions: ['translate', 'rotate', 'clarify'], front: 'unknown' },
    }));
    const view = owner();
    await settle();
    view.button('Show on the scene').dispatch('click');
    view.button('Make a revised alternative').dispatch('click');
    await settle();
    assert.equal(view.field('Revision Down / up (kept from the parent)').disabled, true);
    assert.match(view.root.textContent, /starting position has not been confirmed as clear of the photo \(The starting pose was not checked\.\)/);
    assert.match(view.root.textContent, /It does not check the floor, hidden parts of the room, or the path the object would take, and it is not a safety check\./);
    const turn = view.field('Revision Turn (degrees)');
    turn.value = '30'; turn.dispatch('input');
    const time = view.field('Time for revised alternative');
    time.value = 'unknown'; time.dispatch('change');
    view.button('Preview revised alternative').dispatch('click');
    await settle();
    assert.equal(view.shown.at(-1).yaw, Math.PI / 6);
    assert.deepEqual(view.shown.at(-1).fullObject, B, 'the preview keeps the parent object binding');
    routes[`POST ${JOB_URL}/variants/${BASELINE}/revisions`] = () => Promise.resolve(json(409, { error: 'Movement held.', motion: { status: 'held', scope: 'retained-geometry-only', reason: 'The moved object may overlap kept background.' } }));
    view.button('Save revised alternative').dispatch('click');
    await settle();
    const save = requests.filter((entry) => entry.url.endsWith('/revisions'));
    assert.equal(save.length, 1);
    assert.deepEqual(save[0].body.transform, { offset: [0, 0, 0], yaw: Math.PI / 6 }, 'the browser never sends the object binding');
    assert.match(view.root.textContent, /Not saved\. This move could not be confirmed: The moved object may overlap kept background\./);
    assert.equal(view.button('Save revised alternative').textContent, 'Save revised alternative', 'a held refusal is not treated as an unknown outcome');
    assert.equal(turn.disabled, false, 'the pose can be changed and previewed again');
    assert.equal(view.field('Revision Down / up (kept from the parent)').disabled, true);
  });
});

describe('full-object scoped proposals', () => {
  function plan(proposal) {
    const root = new FakeElement('section');
    const edit = baselineVariant().edit;
    const previews = [];
    routes[`GET ${PROPOSALS}`] = () => Promise.resolve(json(200, [proposal]));
    routes[`GET ${PROPOSALS}/${PROPOSAL}`] = () => Promise.resolve(json(200, proposal));
    const panel = mountAlternativeMemory(root, {
      parentId: BASELINE, proposalUrl: PROPOSALS, initialProposalId: PROPOSAL,
      binding: () => ({ parentVariantId: BASELINE, baseEraRevision: 0, edit, targetId: 'selected-foreground', timeMode: 'unknown', ready: true }),
      nameOf: () => 'the selected foreground', blocked: () => null, admitParent: async () => true,
      preview(candidate) { previews.push(candidate); return { drawn: true, guide: null }; },
      clearPreview() {}, setPending() {}, saved() {}, showSaved() {}, selectScope() {},
    });
    mounted.push(panel);
    const button = (name) => root.findAll((node) => node.tag === 'button' && node.textContent === name)[0];
    return { root, button, previews };
  }
  const ready = (overrides = {}) => ({
    id: PROPOSAL, status: 'ready', targetId: 'selected-foreground', updatedAt: '2026-11-03T00:00:01Z', createdAt: '2026-11-03T00:00:00Z',
    scope: { kind: 'variant', parentVariantId: BASELINE, baseEraRevision: 0, timeMode: 'unknown' },
    statement: { text: 'It was turned toward the window.' }, result: { action: 'rotate' },
    candidate: { version: null, offset: [0, 0, 0], yaw: 0.5, fullObject: structuredClone(B) }, motion: CHECKED, ...overrides,
  });

  it('allows preview and save only for a checked move of the same object', async () => {
    const view = plan(ready());
    await settle();
    assert.match(view.root.textContent, /This move does not overlap what is kept from the photo\. This check only looks at whether the object would overlap the parts of the photo kept in the scene/);
    assert.equal(view.button('Preview alternative proposal').disabled, false);
    view.button('Preview alternative proposal').dispatch('click');
    await settle();
    assert.deepEqual(view.previews.at(-1).fullObject, B);
    assert.equal(view.button('Save proposal as a new alternative').disabled, false);
  });

  it('holds a proposal whose movement was not cleared, whose object changed or whose height changed', async () => {
    const cases = [
      [ready({ motion: { status: 'held', scope: 'retained-geometry-only', reason: 'The check could not run.' } }), /This move could not be confirmed: The check could not run\./],
      [ready({ motion: undefined }), /The movement could not be checked\./],
      [ready({ candidate: { version: null, offset: [0, 0, 0], yaw: 0.5, fullObject: { ...structuredClone(B), sha256: 'a'.repeat(64) } } }), /does not keep the same estimated object/],
      [ready({ candidate: { version: null, offset: [0, 0.2, 0], yaw: 0.5, fullObject: structuredClone(B) } }), /Height changes are not supported/],
    ];
    for (const [proposal, text] of cases) {
      const view = plan(proposal);
      await settle();
      assert.match(view.root.textContent, text);
      assert.equal(view.button('Preview alternative proposal').disabled, true);
      assert.equal(view.button('Save proposal as a new alternative').disabled, true);
      mounted.pop().dispose();
    }
  });
});

describe('full-object sharing choices', () => {
  it('offers only views of the same object and owner words supplied by the server', async () => {
    const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', OTHER = '99999999-9999-4999-8999-999999999999';
    const words = { proposalId: PROPOSAL, statementSha256: 'c'.repeat(64), text: 'It was turned toward the window.' };
    const child = { ...baselineVariant(), id: CHILD, label: 'Turned toward the window', edit: { version: null, offset: [0, 0, 0], yaw: 0.5, fullObject: structuredClone(B) }, shareMemoryWords: words };
    const other = { ...baselineVariant(), id: OTHER, label: 'Another object', edit: { version: null, offset: [0, 0, 0], yaw: 0, fullObject: { ...structuredClone(B), sha256: 'a'.repeat(64) } } };
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [], variants: [{ ...baselineVariant(), shareMemoryWords: null }, child, other], blocked: false }));
    routes[`GET ${JOB_URL}/history`] = () => Promise.resolve(json(200, [{ version: 4, kind: 'manual', blocked: false }, { version: 3, kind: 'manual', blocked: false }]));
    routes[`GET ${JOB_URL}/stories`] = () => Promise.resolve(json(200, { stories: [] }));
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, []));
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, { status: 'ready', box: [0, 0, 10, 10], sourceId: B.sourceId, edit: { version: 4, offset: [0, 0, 0], yaw: 0, fullObject: B } }));
    routes[`GET ${JOB_URL}/shares`] = () => Promise.resolve(json(200, []));
    const root = new FakeElement('section');
    const panel = mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 4, offset: [0, 0, 0], yaw: 0 }), getCamera: () => null });
    mounted.push(panel);
    await settle();
    const labels = root.findAll((node) => node.tag === 'label').map((node) => node.textContent);
    assert.ok(labels.includes(' Saved version 4 (current)'));
    assert.ok(labels.includes(' Starting alternative') && labels.includes(' Turned toward the window'));
    assert.equal(labels.some((text) => /Saved version 3|Another object/.test(text)), false, 'older versions and other objects are not offered together');
    assert.equal(root.findAll((node) => node.className === 'share-memory-words').length, 0, 'no words until the child is chosen');
    const childBox = root.findAll((node) => node.tag === 'label' && node.textContent === ' Turned toward the window')[0].children.find((item) => item.tag === 'input');
    childBox.checked = true; childBox.dispatch('change');
    const offered = root.findAll((node) => node.className === 'share-memory-words');
    assert.equal(offered.length, 1);
    assert.equal(offered[0].textContent, 'Alternative “Turned toward the window”: “It was turned toward the window.”');
  });

  it('shows the server attribution beside source-backed share words, and does not offer malformed ones', async () => {
    const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const sourced = { proposalId: PROPOSAL, statementSha256: 'c'.repeat(64), text: 'Synthetic source words.', attribution: { creator: null, originKind: 'own', reference: '' } };
    const malformed = { proposalId: PROPOSAL, statementSha256: 'd'.repeat(64), text: 'Synthetic other words.', attribution: { creator: 7, originKind: 'own', reference: '' } };
    const child = { ...baselineVariant(), id: CHILD, label: 'Source-backed child', edit: { version: null, offset: [0, 0, 0], yaw: 0.5, fullObject: structuredClone(B) }, shareMemoryWords: sourced };
    const other = { ...baselineVariant(), id: OTHER, label: 'Malformed child', edit: { version: null, offset: [0, 0, 0], yaw: 0.2, fullObject: structuredClone(B) }, shareMemoryWords: malformed };
    routes[`GET ${JOB_URL}/collaboration`] = () => Promise.resolve(json(200, { contributions: [], variants: [{ ...baselineVariant(), shareMemoryWords: null }, child, other], blocked: false }));
    routes[`GET ${JOB_URL}/history`] = () => Promise.resolve(json(200, [{ version: 4, kind: 'manual', blocked: false }]));
    routes[`GET ${JOB_URL}/stories`] = () => Promise.resolve(json(200, { stories: [] }));
    routes[`GET ${JOB_URL}/proposals`] = () => Promise.resolve(json(200, []));
    routes[`GET ${JOB_URL}`] = () => Promise.resolve(json(200, { status: 'ready', box: [0, 0, 10, 10], sourceId: B.sourceId, edit: { version: 4, offset: [0, 0, 0], yaw: 0, fullObject: B } }));
    routes[`GET ${JOB_URL}/shares`] = () => Promise.resolve(json(200, []));
    const root = new FakeElement('section');
    mounted.push(mountShares(root, { sharesUrl: `${JOB_URL}/shares`, jobUrl: JOB_URL, editor: () => ({ version: 4, offset: [0, 0, 0], yaw: 0 }), getCamera: () => null }));
    await settle();
    for (const label of [' Source-backed child', ' Malformed child']) {
      const box = root.findAll((node) => node.tag === 'label' && node.textContent === label)[0].children.find((item) => item.tag === 'input');
      box.checked = true; box.dispatch('change');
    }
    const offered = root.findAll((node) => node.className === 'share-memory-words');
    assert.equal(offered.length, 1, 'malformed attribution is not offered');
    assert.equal(offered[0].textContent, 'Alternative “Source-backed child”: “Synthetic source words.”');
    const text = root.textContent;
    assert.match(text, /From this place’s written source/);
    assert.match(text, /Own source; attribution as given by the owner, not verified\./);
    assert.doesNotMatch(text, /Synthetic other words/);
  });
});

describe('full-object visitor view', () => {
  const PARENT_VIEW = '11111111-1111-4111-8111-111111111111', CHILD_VIEW = '22222222-2222-4222-8222-222222222222';
  const glb = new TextEncoder().encode('glTF synthetic object bytes');
  const png = new TextEncoder().encode('PNG synthetic outline bytes');
  const hex = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  async function pinned() {
    return { sha256: await hex(glb), outlineSha256: await hex(png), initial: structuredClone(B.initial),
      asset: { viewId: PARENT_VIEW, name: 'object.glb', size: glb.byteLength }, mask: { viewId: PARENT_VIEW, name: 'outline.png', size: png.byteLength } };
  }
  const view = (id, label, edit, fullObject) => ({ id, label, edit, representation: 'source-photo-full-object-v1', fullObject,
    era: { kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null },
    evidence: { photo: { providerLabel: 'Owner', attributedCaptureDate: null }, geometry: 'model estimate', recollections: [], support: [] } });
  const surface = { width: 2, height: 2, depth: [3, 3, 3, 3], foreground: [0, 1, 0, 0], source: { image_size: [10, 8] }, assumptions: { horizontal_fov_degrees: 55 } };
  async function visit(manifestFor, bytes = { 'object.glb': glb, 'outline.png': png }) {
    const created = [], revoked = [], assets = [];
    const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { const url = realCreate(blob); created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); realRevoke(url); };
    globalThis.visitViewerCalls = []; globalThis.visitViewerCalls.edits = [];
    const manifest = await manifestFor();
    const respond = (body) => ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob([body]), arrayBuffer: async () => body.slice().buffer });
    const source = {
      kind: 'visit',
      manifest: async () => manifest,
      check: async () => true,
      asset: async (viewId, name) => { assets.push(`${viewId}/${name}`); return name === 'surface.json' ? { ok: true, status: 200, json: async () => surface } : respond(bytes[name] ?? new TextEncoder().encode('jpeg')); },
      storyAudio: async () => ({ ok: false }), recordingAudio: async () => ({ ok: false }),
    };
    const container = new FakeElement('div');
    const states = [];
    // Resolves with the screen's first state after loading, so a case can wait
    // for the actual outcome instead of a fixed number of ticks.
    let settled;
    const outcome = new Promise((resolve) => { settled = resolve; });
    const screen = mountVisitor(container, source, { onState: (state) => { states.push(state); if (state !== 'loading') settled(state); } });
    await settle();
    const restore = () => { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; };
    return { container, screen, states, outcome, created, revoked, assets, restore };
  }

  it('draws the pinned object from verified bytes and releases every local copy', async () => {
    const v = await visit(async () => {
      const object = await pinned();
      return { id: '7f3a9c2e-1d4b-4e8a-9b6c-0123456789ab', title: 'Synthetic room', createdAt: '2026-11-03T00:00:00Z', synthetic: true, startViewId: PARENT_VIEW, camera: { position: [0, 0, 0], target: [0, 0, -3] },
        views: [view(PARENT_VIEW, 'Starting alternative', { offset: [0, 0, 0], yaw: 0 }, object), view(CHILD_VIEW, 'Turned toward the window', { offset: [0, 0, 0], yaw: 0.5 }, { ...structuredClone(object), asset: { ...object.asset, viewId: CHILD_VIEW }, mask: { ...object.mask, viewId: CHILD_VIEW } })] };
    });
    try {
      assert.equal(v.states.at(-1), '3d');
      assert.ok(v.assets.includes(`${PARENT_VIEW}/object.glb`) && v.assets.includes(`${PARENT_VIEW}/outline.png`));
      const [call] = globalThis.visitViewerCalls;
      const fullObject = call[4].fullObject;
      assert.equal(fullObject.sha256, await hex(glb));
      assert.equal(fullObject.outlineSha256, await hex(png));
      assert.deepEqual(fullObject.initial, B.initial);
      assert.match(fullObject.assetUrl, /^blob:/);
      assert.match(fullObject.maskUrl, /^blob:/);
      assert.match(v.container.textContent, /its front is not known/);
      v.screen.dispose();
      assert.deepEqual([...v.revoked].sort(), [...v.created].sort(), 'every local copy is released on close');
    } finally { v.restore(); }
  });

  // Bounded: a screen stuck in loading fails here instead of hanging the run.
  it('closes without drawing when the object bytes do not match or views name different objects', { timeout: 5000 }, async () => {
    const changed = new TextEncoder().encode('glTF synthetic object bytez');
    const mismatch = await visit(async () => {
      const object = await pinned();
      return { id: 'a', title: 'Synthetic room', createdAt: '2026-11-03T00:00:00Z', synthetic: true, startViewId: PARENT_VIEW, camera: { position: [0, 0, 0], target: [0, 0, -3] }, views: [view(PARENT_VIEW, 'Start', { offset: [0, 0, 0], yaw: 0 }, object)] };
    }, { 'object.glb': changed, 'outline.png': png });
    try {
      assert.equal(await mismatch.outcome, 'unavailable');
      assert.equal(mismatch.states.at(-1), 'unavailable');
      assert.equal(globalThis.visitViewerCalls.length, 0);
      assert.deepEqual([...mismatch.revoked].sort(), [...mismatch.created].sort());
    } finally { mismatch.screen.dispose(); mismatch.restore(); }
    const differing = await visit(async () => {
      const object = await pinned();
      return { id: 'b', title: 'Synthetic room', createdAt: '2026-11-03T00:00:00Z', synthetic: true, startViewId: PARENT_VIEW, camera: { position: [0, 0, 0], target: [0, 0, -3] },
        views: [view(PARENT_VIEW, 'Start', { offset: [0, 0, 0], yaw: 0 }, object), view(CHILD_VIEW, 'Other', { offset: [0, 0, 0], yaw: 0 }, { ...object, sha256: 'a'.repeat(64) })] };
    });
    try {
      assert.equal(differing.states.at(-1), 'unavailable');
      assert.equal(globalThis.visitViewerCalls.length, 0);
      assert.equal(differing.assets.some((name) => name.endsWith('object.glb')), false, 'no object bytes are requested for an inconsistent snapshot');
    } finally { differing.screen.dispose(); differing.restore(); }
  });
});

// The real owner server with synthetic media, outline and planner seams; the
// actual frontend modules drive it over HTTP. This checks the agreed request
// and response shapes end to end. It is not a browser, a real object build or
// a real recording.
describe('frontend against the real backend (synthetic inputs)', () => {
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  async function waitFor(check, label) {
    for (let i = 0; i < 400; i += 1) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Timed out waiting for ${label}`);
  }
  async function scene(t) {
    globalThis.fetch = realFetch;
    const helpers = await import('./auth-helper.mjs');
    const { syntheticGlb } = await import('./full-object-fixtures.js');
    const { expectedInitialPose, validateObjectGlb } = await import('../full-objects.mjs');
    const { encodeMaskPng } = await import('../public/object-outline-editor.js');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-frontend-'));
    const outline = { bounds: [4, 3, 20, 25], coveredGridIndices: [0, 1, 4] };
    const validator = async ({ maskPath, width, height, gridWidth, gridHeight }) => ({ width, height, maskSha256: sha(await readFile(maskPath)), ...outline, selectedPixels: 352, gridWidth, gridHeight });
    const runFullObject = async ({ imagePath, maskPath, parentSurfacePath, outputDir }) => {
      const bytes = syntheticGlb(), geometry = validateObjectGlb(bytes), surfaceBytes = await readFile(parentSurfacePath);
      await writeFile(path.join(outputDir, 'object.glb'), bytes);
      await writeFile(path.join(outputDir, 'object.json'), JSON.stringify({ representation: 'source-photo-full-object-v1', asset: 'object.glb', sha256: sha(bytes), bytes: bytes.length,
        initial: expectedInitialPose(JSON.parse(surfaceBytes), outline, geometry.bounds),
        model: { id: 'stabilityai/TripoSR', revision: '5b521936b01fbe1890f6f9baed0254ab6351c04a', checkpointSha256: '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee' },
        input: { sourceSha256: sha(await readFile(imagePath)), outlineSha256: sha(await readFile(maskPath)), parentSurfaceSha256: sha(surfaceBytes) } }));
      return { exitCode: 0 };
    };
    const proposalModel = async (call) => ({ ok: true, model: 'synthetic', usage: null, plan: { action: 'rotate', targetId: 'selected-foreground', sourceId: call.sourceId, ...call.alternative, delta: null, yawDelta: Math.PI / 2, anchor: null, question: null, reason: 'Synthetic relative turn.' } });
    const app = await helpers.startOwnerServer({ dataDir, reconstructionRunner: helpers.sceneRunner, fullObjectMaskValidator: validator, runFullObject, proposalModel, prepareModelImage: async () => helpers.jpeg(40, 30) });
    t.after(async () => { globalThis.fetch = realFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    const owner = (url, init = {}) => realFetch(url, { ...init, headers: { cookie: helpers.ownerCookie(url), ...init.headers } });
    const read = async (response, status) => { const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
    const post = (url, body) => owner(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const until = async (url, done) => { for (let i = 0; i < 200; i += 1) { const value = await read(await owner(url), 200); if (done(value)) return value; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail('Synthetic operation did not finish.'); };
    const grant = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
    const form = new FormData(); form.append('photos', new Blob([helpers.SYNTHETIC_PHOTO]), 'photo.png'); form.append('metadata', JSON.stringify({ photos: [grant] }));
    const draft = await read(await owner(`${app.base}/api/drafts`, { method: 'POST', body: form }), 201);
    const source = draft.sources.find((item) => item.id === draft.photos[0].sourceId);
    const job = await read(await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: source.id, box: [4, 3, 20, 24] }), 202);
    const url = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`;
    const ready = await until(url, (value) => value.status === 'ready');
    const data = new Uint8Array(1200); for (let y = 3; y < 25; y += 1) for (let x = 4; x < 20; x += 1) data[y * 40 + x] = 1;
    const mask = Buffer.from(await encodeMaskPng(data, 40, 30)), outlineId = randomUUID();
    await read(await owner(`${url}/full-object/outlines/${outlineId}`, { method: 'PUT', body: mask, headers: { 'content-type': 'image/png', 'x-source-id': source.id, 'x-source-sha256': source.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': ready.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '1' } }), 201);
    const build = await read(await post(`${url}/full-object/builds`, { requestId: randomUUID(), sourceId: source.id, sourceSha256: source.sha256, outlineId, outlineSha256: sha(mask) }), 202);
    await until(`${url}/full-object/builds/${build.id}`, (value) => value.status === 'ready');
    await read(await post(`${url}/full-object/builds/${build.id}/confirm`, { requestId: randomUUID(), baseVersion: 1 }), 200);
    const main = await read(await owner(url), 200);
    // Frontend modules use absolute owner URLs; visitor requests are relative
    // paths sent without the owner cookie.
    globalThis.fetch = (target, init = {}) => String(target).startsWith('/api/visit') ? realFetch(`${app.base}${target}`, init) : owner(target, init);
    return { app, url, main, mask, glb: syntheticGlb(), read, post, owner, source };
  }

  it('saves a starting alternative and a reviewed memory child that keep the bound object, then shows the pair to a visitor', async (t) => {
    const s = await scene(t);
    const B0 = s.main.edit.fullObject;
    assert.ok(B0, 'the confirmed scene has a bound object');
    const root = new FakeElement('section');
    const shown = [];
    const publicSource = { origin: { kind: 'public' }, permissions: { place: true, model: true } };
    const panel = mountCollaboration(root, { jobUrl: s.url, fullObject: true,
      editor: () => ({ version: s.main.edit.version, offset: [0, 0, 0], yaw: 0, clean: true }),
      showTransform(transform) { shown.push(transform); return Boolean(transform); },
      setLocked() {}, saved() {}, unconfirmed() {}, conflict() {}, onChanged() {}, memorySources: [publicSource] });
    t.after(() => panel.dispose());
    const find = (predicate) => root.findAll(predicate);
    const button = (name) => find((node) => node.tag === 'button' && node.textContent === name)[0];
    const labelled = (name) => find((node) => node.attributes['aria-label'] === name)[0];
    (await waitFor(() => button('Save the current scene as a starting alternative'), 'starting button')).dispatch('click');
    await waitFor(() => shown.at(-1)?.fullObject, 'shown starting alternative');
    assert.deepEqual(shown.at(-1).fullObject, B0, 'the starting alternative keeps the bound object');
    (await waitFor(() => button('Make a revised alternative') && !button('Make a revised alternative').disabled && button('Make a revised alternative'), 'revise button')).dispatch('click');
    await waitFor(() => /starting position/.test(root.textContent), 'parent motion text');
    const mode = labelled('Alternative revision method'); mode.value = 'memory'; mode.dispatch('change');
    const time = labelled('Time for revised alternative'); time.value = 'unknown'; time.dispatch('change');
    const text = labelled('Remembered instruction for this alternative'); text.value = 'Synthetic memory: it was turned a quarter turn.'; text.dispatch('input');
    const consent = find((node) => node.tag === 'label' && /Send this instruction/.test(node.textContent))[0].children.find((child) => child.tag === 'input');
    consent.checked = true; consent.dispatch('change');
    (await waitFor(() => button('Plan a change to this alternative') && !button('Plan a change to this alternative').disabled && button('Plan a change to this alternative'), 'plan button')).dispatch('click');
    await waitFor(() => /This move does not overlap what is kept from the photo\./.test(root.textContent), 'checked movement from the real planner path');
    (await waitFor(() => button('Preview alternative proposal') && !button('Preview alternative proposal').disabled && button('Preview alternative proposal'), 'preview')).dispatch('click');
    (await waitFor(() => button('Save proposal as a new alternative') && !button('Save proposal as a new alternative').disabled && button('Save proposal as a new alternative'), 'save')).dispatch('click');
    let variants;
    for (let i = 0; i < 200 && !(variants?.length >= 2); i += 1) { variants = (await s.read(await s.owner(`${s.url}/collaboration`), 200)).variants; await new Promise((resolve) => setTimeout(resolve, 5)); }
    const child = variants.find((variant) => variant.revision?.proposalId);
    const parent = variants.find((variant) => variant.id === child?.revision.parentVariantId);
    assert.ok(child && parent, 'a reviewed child of the starting alternative was saved');
    assert.deepEqual(child.edit.fullObject, B0);
    assert.equal(child.edit.yaw, Math.PI / 2);
    assert.deepEqual((await s.read(await s.owner(s.url), 200)).edit, s.main.edit, 'the current scene is unchanged');

    const views = [parent, child].map((item) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: item.id }));
    const preview = await s.read(await s.post(`${s.url}/shares/previews`, { requestId: randomUUID(), title: 'Synthetic pair', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true }), 201);
    const token = `rhv_${randomBytes(32).toString('base64url')}`;
    await s.read(await s.post(`${s.url}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true }), 201);
    globalThis.visitViewerCalls = []; globalThis.visitViewerCalls.edits = [];
    const container = new FakeElement('div');
    const states = [];
    const screen = mountVisitor(container, visitSource(token), { onState: (state) => states.push(state) });
    t.after(() => screen.dispose());
    await waitFor(() => states.includes('3d') || states.includes('unavailable'), 'visitor screen');
    assert.equal(states.at(-1), '3d');
    const fullObject = globalThis.visitViewerCalls[0][4].fullObject;
    assert.equal(fullObject.sha256, sha(s.glb));
    assert.equal(fullObject.outlineSha256, sha(s.mask));
    assert.deepEqual(fullObject.initial, B0.initial);
    container.findAll((node) => node.tag === 'button' && node.viewId === views[1].id)[0].dispatch('click');
    assert.deepEqual(globalThis.visitViewerCalls.edits.at(-1), { offset: [0, 0, 0], yaw: Math.PI / 2 }, 'switching to the child turns the same object');
  });
});
