import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { FakeElement } from './fake-dom.mjs';

// The visitor screen's 3D viewer is replaced by a recorder; Node has no WebGL.
const viewerStub = `export function createViewer(...args) { globalThis.visitViewerCalls.push(args); return Promise.resolve({ dispose() {}, applyEdit(edit) { globalThis.visitViewerCalls.edits.push(edit); }, setCamera() {}, getCamera() { return null; }, originalView() { return true; }, setInteractive() {}, isInteractive() { return false; } }); }
export function createExploreToggle() { const button = document.createElement('button'); const status = document.createElement('p'); return { button, status, attach() {}, detach() {} }; }
export function createInspectToggle() { const button = document.createElement('button'); const note = document.createElement('p'); return { button, note, attach() {} }; }`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './scene-viewer.js' && context.parentURL?.endsWith('/public/visits.js')) return { url: `data:text/javascript,${encodeURIComponent(viewerStub)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const realFetch = globalThis.fetch;

// Technical fixtures only: the source text and creator below are synthetic
// test strings, not anyone's recollection.
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHA = 'a'.repeat(64);
const PROPOSALS = `/api/drafts/d/reconstructions/j/variants/${PARENT}/proposals`;
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

let sourceDetails, mountAlternativeMemory, mountCollaboration, mountShares, mountVisitor, visitSource, requests, mounted;
before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    return options.method === 'POST' ? json(503, {}) : json(200, []);
  };
  sourceDetails = await import('../public/source-details.js');
  ({ mountAlternativeMemory } = await import('../public/alternative-memory.js'));
  ({ mountCollaboration } = await import('../public/collaboration.js'));
  ({ mountShares } = await import('../public/shares.js'));
  ({ mountVisitor, visitSource } = await import('../public/visits.js'));
});
beforeEach(() => { requests = []; mounted = []; });
afterEach(() => { for (const panel of mounted) panel?.dispose?.(); });

describe('owner intake attribution for the written source', () => {
  it('sends a trimmed creator only for the written text, and never for photos or the recording', () => {
    const details = () => ({ ...sourceDetails.createSourceDetails(), attributedCreator: '  Synthetic Author  ' });
    const metadata = sourceDetails.buildMetadata({ photos: [{ details: details(), file: null }], text: 'Synthetic words.', textDetails: details(), voice: true, voiceDetails: details() });
    assert.equal(metadata.text.attributedCreator, 'Synthetic Author');
    assert.equal(Object.hasOwn(metadata.photos[0], 'attributedCreator'), false);
    assert.equal(Object.hasOwn(metadata.voice, 'attributedCreator'), false);
    const blank = sourceDetails.buildMetadata({ photos: [], text: 'Synthetic words.', textDetails: sourceDetails.createSourceDetails(), voice: null });
    assert.deepEqual(Object.keys(blank.text).sort(), ['dates', 'origin', 'permissions', 'provider'], 'an empty creator keeps the old text metadata shape');
  });

  it('shows the creator field only where asked, and the saved creator only on a text record', () => {
    const labels = (root) => root.findAll((node) => node.tag === 'label').map((node) => node.textContent);
    const state = {};
    assert.ok(labels(sourceDetails.renderSourceControls(document, { details: sourceDetails.createSourceDetails(), state, label: 'the written memory', attribution: true })).includes('Words attributed to'));
    assert.ok(!labels(sourceDetails.renderSourceControls(document, { details: sourceDetails.createSourceDetails(), state, label: 'photo 1' })).includes('Words attributed to'));
    const record = { kind: 'text', provider: 'Supplier', attributedCreator: 'Synthetic Author', origin: { kind: 'public', reference: 'Synthetic reference' }, permissions: { place: true, model: true, share: false }, dates: { capturedOn: null, estimatedPeriod: '' }, sha256: SHA };
    const rows = sourceDetails.describeSource(record).rows;
    assert.deepEqual(rows.find((row) => row.label.startsWith('Attributed to')), { label: 'Attributed to (as stated by the owner)', value: 'Synthetic Author' });
    assert.equal(rows.find((row) => row.label === 'Provided by').value, 'Supplier', 'the provider stays separate');
    assert.equal(sourceDetails.describeSource({ ...record, kind: 'photo' }).rows.some((row) => row.label.startsWith('Attributed to')), false);
  });
});

describe('choosing the place’s written source for an alternative plan', () => {
  const panel = async (writtenSource) => {
    const container = new FakeElement('section');
    const bridge = {
      parentId: PARENT, proposalUrl: PROPOSALS, writtenSource: () => writtenSource,
      binding: () => ({ parentVariantId: PARENT, baseEraRevision: 2, edit: { version: null, offset: [0, 0, 0], yaw: 0 }, targetId: 'selected-foreground', timeMode: 'unknown', ready: true }),
      nameOf: () => 'the selected foreground', blocked: () => null, setPending() {}, clearPreview() {}, selectScope() {}, saved() {},
    };
    mounted.push(mountAlternativeMemory(container, bridge));
    await settle();
    const find = (predicate) => container.findAll(predicate);
    const plan = find((node) => node.tag === 'button' && /alternative plan|Plan a change/.test(node.textContent))[0];
    const [useSource, consent] = find((node) => node.tag === 'input' && node.type === 'checkbox');
    const text = find((node) => node.tag === 'textarea')[0];
    const choice = useSource.parent;
    return { container, find, plan, useSource, consent, text, choice, words: () => container.textContent };
  };
  const posted = () => requests.filter((request) => request.method === 'POST').map((request) => request.body);

  it('keeps only the legacy instruction when the parent has no written source', async () => {
    const view = await panel(null);
    assert.equal(view.choice.hidden, true);
    view.text.value = 'Synthetic instruction'; view.text.dispatch('input');
    view.consent.checked = true; view.consent.dispatch('change');
    view.plan.dispatch('click'); await settle();
    assert.equal(posted()[0].text, 'Synthetic instruction');
    assert.equal(Object.hasOwn(posted()[0], 'statementSource'), false);
  });

  it('sends only the server-resolved source identity, never typed or pasted words', async () => {
    const view = await panel({ available: true, reason: null, sourceId: SOURCE, sourceSha256: SHA, text: 'Synthetic source words.', attribution: { creator: 'Synthetic Author', originKind: 'public', reference: 'Synthetic reference' }, modelAllowed: true });
    assert.match(view.words(), /Synthetic source words\./);
    assert.match(view.words(), /Attributed to Synthetic Author/);
    assert.match(view.words(), /Synthetic reference/);
    assert.match(view.words(), /Public source; attribution as given by the owner, not verified\./);
    view.text.value = 'Pasted citation that must not be sent'; view.text.dispatch('input');
    view.useSource.checked = true; view.useSource.dispatch('change');
    assert.equal(view.text.hidden, true);
    view.consent.checked = true; view.consent.dispatch('change');
    view.plan.dispatch('click'); await settle();
    const body = posted()[0];
    assert.deepEqual(body.statementSource, { sourceId: SOURCE, sourceSha256: SHA });
    assert.equal(Object.hasOwn(body, 'text'), false, 'no client words with a source-backed plan');
    view.plan.dispatch('click'); await settle();
    assert.deepEqual(posted()[1], body, 'an unknown outcome retries the identical request');
  });

  it('shows a readable source but disables the choice when model use is off', async () => {
    const view = await panel({ available: true, reason: null, sourceId: SOURCE, sourceSha256: SHA, text: 'Synthetic source words.', attribution: { creator: null, originKind: 'own', reference: '' }, modelAllowed: false });
    assert.match(view.words(), /Synthetic source words\./);
    assert.match(view.words(), /Creator not given/);
    assert.match(view.words(), /Model use is off for this written source\./);
    assert.doesNotMatch(view.words(), /could not be read/);
    assert.equal(view.useSource.disabled, true);
  });

  it('shows only the plain reason for an unavailable source and cannot plan from it', async () => {
    const view = await panel({ available: false, reason: 'checksum', sourceId: SOURCE, sourceSha256: null, text: null, attribution: { creator: null, originKind: 'unknown', reference: '' }, modelAllowed: false });
    assert.match(view.words(), /The written source changed or could not be verified\./);
    assert.equal(view.useSource.disabled, true);
    view.useSource.checked = true; view.useSource.dispatch('change');
    view.consent.checked = true; view.consent.dispatch('change');
    assert.equal(view.plan.disabled, true, 'an unavailable source can never be submitted');
    assert.equal(posted().length, 0);
  });
});

// One synthetic integration case: the actual frontend modules drive the real
// owner server over HTTP, with a synthetic photo, object and planner. Not a
// browser, a real model, a real object build or anyone's recollection.
describe('source-backed memory, frontend against the real backend (synthetic inputs)', () => {
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  async function waitFor(check, label) {
    for (let i = 0; i < 400; i += 1) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Timed out waiting for ${label}`);
  }

  it('plans from the whole written source, saves one child of the same object, and carries the server attribution to the owner preview and visitor', { timeout: 60_000 }, async (t) => {
    const fakeFetch = globalThis.fetch;
    globalThis.fetch = realFetch;
    t.after(() => { globalThis.fetch = fakeFetch; });
    const helpers = await import('./auth-helper.mjs');
    const { syntheticGlb } = await import('./full-object-fixtures.js');
    const { expectedInitialPose, validateObjectGlb } = await import('../full-objects.mjs');
    const { encodeMaskPng } = await import('../public/object-outline-editor.js');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-source-backed-frontend-'));
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
    const plannerTexts = [];
    const proposalModel = async (call) => {
      plannerTexts.push(call.text);
      return { ok: true, model: 'synthetic', usage: null, plan: { action: 'rotate', targetId: 'selected-foreground', sourceId: call.sourceId, ...call.alternative, delta: null, yawDelta: Math.PI / 2, anchor: null, question: null, reason: 'Synthetic relative turn.' } };
    };
    const app = await helpers.startOwnerServer({ dataDir, reconstructionRunner: helpers.sceneRunner, fullObjectMaskValidator: validator, runFullObject, proposalModel, prepareModelImage: async () => helpers.jpeg(40, 30) });
    t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    const owner = (url, init = {}) => realFetch(url, { ...init, headers: { cookie: helpers.ownerCookie(url), ...init.headers } });
    const read = async (response, status) => { const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
    const post = (url, body) => owner(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const until = async (url, done) => { for (let i = 0; i < 200; i += 1) { const value = await read(await owner(url), 200); if (done(value)) return value; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail('Synthetic operation did not finish.'); };

    // A synthetic written source longer than the legacy 2,000-character instruction limit.
    const words = Array.from({ length: 70 }, (_, i) => `Synthetic source sentence ${i + 1}.`).join(' ');
    assert.ok(words.length > 2000 && words.length <= 10_000);
    const grant = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
    const textGrant = { ...grant, provider: 'Synthetic supplier', origin: { kind: 'public', reference: 'Synthetic reference, p. 1' }, attributedCreator: 'Synthetic Author' };
    const form = new FormData();
    form.append('text', words);
    form.append('photos', new Blob([helpers.SYNTHETIC_PHOTO]), 'photo.png');
    form.append('metadata', JSON.stringify({ photos: [grant], text: textGrant }));
    const draft = await read(await owner(`${app.base}/api/drafts`, { method: 'POST', body: form }), 201);
    const photo = draft.sources.find((item) => item.id === draft.photos[0].sourceId);
    // The server's retained text and hash are the reference; transport may
    // normalise line endings, so the pre-submit string is not compared.
    const retained = draft.text, written = draft.sources.find((item) => item.id === draft.textSourceId);
    assert.equal(written.sha256, sha(retained));
    assert.ok(retained.length > 2000);
    const job = await read(await post(`${app.base}/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: photo.id, box: [4, 3, 20, 24] }), 202);
    const url = `${app.base}/api/drafts/${draft.id}/reconstructions/${job.id}`;
    const ready = await until(url, (value) => value.status === 'ready');
    const data = new Uint8Array(1200); for (let y = 3; y < 25; y += 1) for (let x = 4; x < 20; x += 1) data[y * 40 + x] = 1;
    const mask = Buffer.from(await encodeMaskPng(data, 40, 30)), outlineId = randomUUID();
    await read(await owner(`${url}/full-object/outlines/${outlineId}`, { method: 'PUT', body: mask, headers: { 'content-type': 'image/png', 'x-source-id': photo.id, 'x-source-sha256': photo.sha256, 'x-mask-sha256': sha(mask), 'x-image-width': '40', 'x-image-height': '30', 'x-crop-xyxy': '0,0,40,30', 'x-outline-confirmed': 'true', 'x-parent-surface-sha256': ready.derivedAssets.find((asset) => asset.name === 'surface.json').sha256, 'x-base-version': '1' } }), 201);
    const build = await read(await post(`${url}/full-object/builds`, { requestId: randomUUID(), sourceId: photo.id, sourceSha256: photo.sha256, outlineId, outlineSha256: sha(mask) }), 202);
    await until(`${url}/full-object/builds/${build.id}`, (value) => value.status === 'ready');
    await read(await post(`${url}/full-object/builds/${build.id}/confirm`, { requestId: randomUUID(), baseVersion: 1 }), 200);
    const main = await read(await owner(url), 200);
    const B0 = main.edit.fullObject;
    // Owner modules use absolute owner URLs; visitor requests are relative and
    // carry only the Bearer token. Owner proposal bodies are recorded.
    const proposalBodies = [];
    globalThis.fetch = (target, init = {}) => {
      if (String(target).startsWith('/api/visit')) return realFetch(`${app.base}${target}`, init);
      if (init.method === 'POST' && /\/variants\/[^/]+\/proposals$/.test(String(target))) proposalBodies.push(JSON.parse(init.body));
      return owner(target, init);
    };

    const root = new FakeElement('section');
    const shown = [];
    const panel = mountCollaboration(root, { jobUrl: url, fullObject: true,
      editor: () => ({ version: main.edit.version, offset: [0, 0, 0], yaw: 0, clean: true }),
      showTransform(transform) { shown.push(transform); return Boolean(transform); },
      setLocked() {}, saved() {}, unconfirmed() {}, conflict() {}, onChanged() {}, memorySources: [{ origin: { kind: 'public' }, permissions: { place: true, model: true } }] });
    t.after(() => panel.dispose());
    const find = (predicate) => root.findAll(predicate);
    const button = (name) => find((node) => node.tag === 'button' && node.textContent === name)[0];
    const enabled = (name) => () => button(name) && !button(name).disabled && button(name);
    const labelled = (name) => find((node) => node.attributes['aria-label'] === name)[0];
    (await waitFor(() => button('Save the current scene as a starting alternative'), 'starting button')).dispatch('click');
    await waitFor(() => shown.at(-1)?.fullObject, 'starting alternative');
    (await waitFor(enabled('Make a revised alternative'), 'revise button')).dispatch('click');
    await waitFor(() => /starting position/.test(root.textContent), 'parent context');
    const mode = labelled('Alternative revision method'); mode.value = 'memory'; mode.dispatch('change');
    const time = labelled('Time for revised alternative'); time.value = 'unknown'; time.dispatch('change');

    // The real revision-context supplies the whole source with its owner-stated creator.
    await waitFor(() => root.textContent.includes(retained), 'whole written source shown');
    assert.match(root.textContent, /Attributed to Synthetic Author/);
    assert.match(root.textContent, /Synthetic reference, p\. 1/);
    assert.doesNotMatch(root.textContent, /Attributed to Synthetic supplier/, 'the provider is not the speaker');
    const typed = labelled('Remembered instruction for this alternative');
    typed.value = 'Typed words that must not be sent.'; typed.dispatch('input');
    const useSource = find((node) => node.tag === 'label' && /Use this place’s written source/.test(node.textContent))[0].children.find((child) => child.tag === 'input');
    useSource.checked = true; useSource.dispatch('change');
    const consent = find((node) => node.tag === 'label' && /Send this instruction/.test(node.textContent))[0].children.find((child) => child.tag === 'input');
    consent.checked = true; consent.dispatch('change');
    (await waitFor(enabled('Plan a change to this alternative'), 'plan button')).dispatch('click');
    await waitFor(() => /This move does not overlap what is kept from the photo\./.test(root.textContent), 'checked movement from the real planner path');
    assert.equal(proposalBodies.length, 1);
    assert.deepEqual(Object.keys(proposalBodies[0]).sort(), ['baseEraRevision', 'consent', 'requestId', 'statementSource', 'targetId', 'timeMode']);
    assert.deepEqual(proposalBodies[0].statementSource, { sourceId: draft.textSourceId, sourceSha256: written.sha256 });
    assert.equal(Object.hasOwn(proposalBodies[0], 'text'), false, 'no typed words are sent');
    assert.deepEqual(plannerTexts, [retained], 'the planner receives the exact retained source text');
    (await waitFor(enabled('Preview alternative proposal'), 'preview')).dispatch('click');
    (await waitFor(enabled('Save proposal as a new alternative'), 'save')).dispatch('click');

    let variants;
    for (let i = 0; i < 200 && !variants?.some((variant) => variant.revision?.proposalId); i += 1) { variants = (await read(await owner(`${url}/collaboration`), 200)).variants; await new Promise((resolve) => setTimeout(resolve, 5)); }
    const children = variants.filter((variant) => variant.revision?.proposalId);
    assert.equal(children.length, 1, 'one child was saved');
    const [child] = children;
    const parent = variants.find((variant) => variant.id === child.revision.parentVariantId);
    assert.deepEqual(child.edit.fullObject, B0, 'the child keeps the same bound object');
    // The lineage is stored, not exposed to the owner's collaboration view.
    const stored = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', draft.id, job.id, 'manifest.json'))).collaboration.variants;
    assert.deepEqual(stored.find((variant) => variant.id === child.id).sourceDependencies, [{ kind: 'written-source', sourceId: draft.textSourceId, sourceSha256: written.sha256 }]);
    assert.equal(Object.hasOwn(stored.find((variant) => variant.id === parent.id), 'sourceDependencies'), false, 'the parent is unchanged');
    assert.deepEqual(child.shareMemoryWords?.attribution, { creator: 'Synthetic Author', originKind: 'public', reference: 'Synthetic reference, p. 1' });
    assert.deepEqual((await read(await owner(url), 200)).edit, main.edit, 'the current scene is unchanged');

    // The owner's share preview shows the server attribution beside the words.
    const shareRoot = new FakeElement('section');
    const shares = mountShares(shareRoot, { sharesUrl: `${url}/shares`, jobUrl: url, editor: () => ({ version: main.edit.version, offset: [0, 0, 0], yaw: 0 }), getCamera: () => null });
    t.after(() => shares.dispose?.());
    const childBox = await waitFor(() => shareRoot.findAll((node) => node.tag === 'label' && node.textContent === ` ${child.label}`)[0]?.children.find((item) => item.tag === 'input'), 'child share choice');
    childBox.checked = true; childBox.dispatch('change');
    await waitFor(() => shareRoot.findAll((node) => node.className === 'share-memory-words').length === 1, 'offered words');
    assert.match(shareRoot.textContent, /Attributed to Synthetic Author/);
    assert.doesNotMatch(shareRoot.textContent, /Attributed to Synthetic supplier/);

    // An anonymous visitor (Bearer token only) sees the same attribution.
    const views = [parent, child].map((item) => ({ id: randomUUID(), kind: 'variant', version: null, variantId: item.id }));
    const memoryWords = { viewId: views[1].id, proposalId: child.shareMemoryWords.proposalId, statementSha256: child.shareMemoryWords.statementSha256, permission: true };
    const preview = await read(await post(`${url}/shares/previews`, { requestId: randomUUID(), title: 'Synthetic pair', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true, memoryWords }), 201);
    const token = `rhv_${randomBytes(32).toString('base64url')}`;
    await read(await post(`${url}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true }), 201);
    globalThis.visitViewerCalls = []; globalThis.visitViewerCalls.edits = [];
    const container = new FakeElement('div');
    const states = [];
    const screen = mountVisitor(container, visitSource(token), { onState: (state) => states.push(state) });
    t.after(() => screen.dispose());
    await waitFor(() => states.includes('3d') || states.includes('unavailable'), 'visitor screen');
    assert.equal(states.at(-1), '3d');
    container.findAll((node) => node.tag === 'button' && node.viewId === views[1].id)[0].dispatch('click');
    const visitorText = container.textContent;
    assert.match(visitorText, /Attributed to Synthetic Author/);
    assert.match(visitorText, /Synthetic reference, p\. 1/);
    assert.match(visitorText, /Public source; attribution as given by the owner, not verified\./);
    assert.doesNotMatch(visitorText, /Attributed to Synthetic supplier/);
    assert.deepEqual(globalThis.visitViewerCalls.edits.at(-1), { offset: [0, 0, 0], yaw: Math.PI / 2 }, 'the child turns the same object');
  });
});
