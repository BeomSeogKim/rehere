import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim } from './viewer-shim.mjs';

installViewerShim();
const GRID = 20;
const surface = {
  schema_version: 2, width: GRID, height: GRID,
  depth: Array(GRID * GRID).fill(3),
  regions: Array.from({ length: GRID * GRID }, (_, index) => {
    const [x, y] = [index % GRID, Math.floor(index / GRID)];
    return y >= 6 && y <= 13 ? (x >= 2 && x <= 6 ? 1 : x >= 13 && x <= 17 ? 2 : 0) : index === 0 ? -1 : 0;
  }),
  objects: [
    { id: 'object-1', label: 'Counter', box_xyxy: [0, 0, 400, 800] },
    { id: 'object-2', label: 'Sacks', box_xyxy: [600, 0, 1000, 800] },
  ],
  source: { image_size: [1000, 800] },
  assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
};
const job = { id: 'parent', derivedAssets: [{ name: 'surface.json', sha256: 'a'.repeat(64) }] };
let createOutlineSession;
let mountOutlineEditor;
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
class Element extends FakeElement {
  getContext() { return { clearRect() {}, fillRect() {}, drawImage() {} }; }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrolled = options; }
}
before(async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  ({ createOutlineSession, mountOutlineEditor } = await import('../public/outline-editor.js'));
});
after(() => { delete globalThis.document; });
beforeEach(() => { globalThis.viewerLog = []; delete globalThis.viewerFail; });

function mount(post = async () => ({ status: 400, ok: false, body: { error: 'Cannot save this correction.' } })) {
  const container = new Element('section');
  const saved = [];
  const editor = mountOutlineEditor(container, {
    job, surface, textureUrl: '/texture', jobUrl: '/parent', post,
    onSaved: (value, options) => saved.push({ value, ...options }), onCancel() {},
  });
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const frame = find((node) => node.className === 'outline-photo')[0];
  const image = find((node) => node.tag === 'img')[0];
  image.rect = { left: 0, top: 0, width: GRID * 10, height: GRID * 10 };
  image.dispatch('load');
  assert.equal(image.src, '/texture', '2D painting and 3D reuse the same stored-pixel photo copy');
  const pointer = (type, x, y, id = 1) => frame.dispatch(type, { clientX: x * 10 + 5, clientY: y * 10 + 5, pointerId: id, button: 0 });
  const stroke = (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); };
  const inspect = async () => {
    button('Refresh 3D preview').dispatch('click');
    await settle();
    button('Inspect corrected original view').dispatch('click');
    button('Inspect corrected side view').dispatch('click');
    const confirm = find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
    confirm.checked = true;
    confirm.dispatch('change');
  };
  return { editor, container, find, button, frame, image, pointer, stroke, inspect, saved };
}

describe('bounded outline session', () => {
  it('adds only background or original empty cells, removes only its object, and never changes the other object', () => {
    const session = createOutlineSession(surface);
    session.begin();
    session.paint(0, 0, 'remove');
    assert.equal(session.regions[0], -1, 'Remove never turns empty cells into background');
    session.paint(0, 0, 'add');
    session.paint(13, 6, 'add', 1);
    session.paint(13, 6, 'remove', 1);
    session.paint(2, 6, 'remove');
    session.end();
    assert.equal(session.regions[0], 1);
    assert.equal(session.regions[6 * GRID + 2], 0);
    surface.regions.forEach((value, index) => { if (value === 2) assert.equal(session.regions[index], 2); });
    assert.equal(session.choose(2), false, 'dirty work cannot silently change targets');
    session.undo();
    assert.deepEqual(session.regions, surface.regions);
    assert.equal(session.choose(2), true);
    session.begin(); session.paint(13, 6, 'remove'); session.end(true);
    assert.deepEqual(session.regions, surface.regions, 'cancel restores the whole stroke');
  });

  it('restores original empty cells when removing an added cell and clears old-target undo after a clean switch', () => {
    const session = createOutlineSession(surface);
    session.begin(); session.paint(0, 0, 'add'); session.end();
    assert.equal(session.regions[0], 1);
    session.begin(); session.paint(0, 0, 'remove'); session.end();
    assert.equal(session.regions[0], -1);
    assert.equal(session.dirty, false, 'add then remove is an exact net undo for original void');
    assert.equal(session.choose(2), true);
    assert.equal(session.canUndo, false, 'old strokes cannot alter the other object after switching');
    session.undo();
    assert.deepEqual(session.regions, surface.regions);
  });

  it('makes a large brush one undoable stroke and resets to the exact saved map', () => {
    const session = createOutlineSession(surface);
    session.begin(); session.paint(2, 6, 'remove', 1); session.paint(3, 6, 'remove', 1); session.end();
    assert.equal(session.canUndo, true);
    session.undo();
    assert.deepEqual(session.regions, surface.regions);
    session.begin(); session.paint(2, 6, 'remove'); session.end(); session.reset();
    assert.equal(session.dirty, false);
    assert.equal(session.canUndo, false);
  });
});

describe('outline editor lifecycle and saving', () => {
  it('paints through the keyboard, requires current original/side preview, and releases an outdated preview', async () => {
    const ui = mount();
    const heading = ui.find((node) => node.tag === 'h3')[0];
    assert.equal(heading.focused, true);
    assert.deepEqual(heading.scrolled, { block: 'start' });
    ui.button('Add to object').dispatch('click');
    ui.frame.dispatch('keydown', { key: ' ' });
    assert.equal(ui.button('B: Sacks').disabled, true);
    assert.equal(ui.button('Save as new scene').disabled, true);
    await ui.inspect();
    assert.equal(ui.button('Save as new scene').disabled, false);
    ui.stroke(1, 0);
    assert.equal(ui.button('Save as new scene').disabled, true);
    assert.equal(ui.button('Inspect corrected side view').disabled, true);
    assert.ok(globalThis.viewerLog.includes('renderer.dispose'));
    ui.editor.dispose();
  });

  it('cancels only the captured pointer stroke and ignores unrelated pointer events', () => {
    const ui = mount();
    ui.pointer('pointerdown', 2, 6, 1);
    ui.pointer('pointermove', 4, 6, 2);
    ui.pointer('pointerup', 4, 6, 2);
    assert.equal(ui.button('Undo stroke').disabled, true, 'the first pointer still owns the stroke');
    ui.pointer('pointercancel', 2, 6, 1);
    assert.equal(ui.button('Reset outline').disabled, true, 'cancel rolls the stroke back');
    ui.pointer('pointerdown', 2, 6, 3);
    ui.frame.dispatch('lostpointercapture', { pointerId: 3 });
    assert.equal(ui.button('Reset outline').disabled, true);
    ui.editor.dispose();
  });

  it('replays an unknown save with identical payload and accepts a child confirmed in another window', async () => {
    const sent = [];
    const ui = mount(async (url, payload) => {
      sent.push({ url, payload: structuredClone(payload) });
      return sent.length === 1 ? { status: 0, ok: false } : { status: 200, ok: true, body: { id: 'child', status: 'ready', objectsConfirmed: true } };
    });
    ui.stroke(2, 6);
    await ui.inspect();
    ui.button('Save as new scene').dispatch('click');
    await settle();
    assert.match(ui.container.textContent, /could not confirm whether the new scene was saved/);
    assert.equal(ui.button('Reset outline').disabled, true);
    assert.ok(ui.button('Back to scene (save outcome unknown)'));
    assert.match(ui.container.textContent, /check the saved scene list before starting another correction/);
    ui.stroke(3, 6);
    ui.button('Retry saving the same new scene').dispatch('click');
    await settle();
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(sent[0].payload.targetId, 'object-1');
    assert.equal(sent[0].payload.sourceSurfaceSha256, 'a'.repeat(64));
    assert.equal(sent[0].payload.regions[6 * GRID + 3], 1, 'painting during uncertainty was ignored');
    assert.equal(ui.saved[0].value.id, 'child');
    assert.equal(ui.saved[0].value.objectsConfirmed, true, 'replay adopts the current child state');
    ui.editor.dispose();
  });

  it('preserves painting after rejected save or failed image/texture and never calls it a preview', async () => {
    const ui = mount();
    ui.stroke(2, 6);
    globalThis.viewerFail = 'texture';
    await ui.inspect();
    assert.match(ui.container.textContent, /preview could not be shown/);
    assert.equal(ui.button('Save as new scene').disabled, true);
    assert.equal(ui.button('Reset outline').disabled, false);
    delete globalThis.viewerFail;
    await ui.inspect();
    ui.button('Save as new scene').dispatch('click');
    await settle();
    assert.match(ui.container.textContent, /Cannot save this correction/);
    assert.equal(ui.button('Reset outline').disabled, false);
    ui.image.dispatch('error');
    assert.equal(ui.button('Save as new scene').disabled, true);
    assert.equal(ui.button('Refresh 3D preview').disabled, true);
    assert.match(ui.container.textContent, /Your outline changes are kept/);
    ui.editor.dispose();
  });

  it('disposes a viewer that finishes after navigation and marks a late save for list refresh', async () => {
    const first = mount();
    first.stroke(2, 6);
    first.button('Refresh 3D preview').dispatch('click');
    first.editor.dispose();
    await settle();
    assert.ok(globalThis.viewerLog.includes('renderer.dispose'));
    let finish;
    const second = mount(() => new Promise((resolve) => { finish = resolve; }));
    second.stroke(2, 6);
    await second.inspect();
    second.button('Save as new scene').dispatch('click');
    second.editor.dispose();
    finish({ status: 201, ok: true, body: { id: 'child', status: 'ready', objectsConfirmed: false } });
    await settle();
    assert.deepEqual(second.saved, [{ value: { id: 'child', status: 'ready', objectsConfirmed: false }, late: true }], 'late accepted scenes refresh the list without navigation');
  });
});
