import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { FakeElement } from './fake-dom.mjs';

const W = 9;
const H = 6;
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

class Element extends FakeElement {
  getContext() {
    const canvas = this;
    return {
      clearRect() {}, putImageData(image) { canvas.painted = image; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(4 * w * h) }),
    };
  }
  focus() { this.focused = true; }
  scrollIntoView() {}
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== listener); }
}

let editor;
before(async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { href: 'http://app.test/space', origin: 'http://app.test' };
  editor = await import('../public/object-outline-editor.js');
});
after(() => { delete globalThis.document; delete globalThis.location; delete globalThis.fetch; delete globalThis.createImageBitmap; });
beforeEach(() => { delete globalThis.fetch; delete globalThis.createImageBitmap; });

function parsePng(bytes) {
  const buffer = Buffer.from(bytes);
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    assert.equal(buffer.readUInt32BE(at + 8 + length), crc32(buffer.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    chunks.push({ type, data: buffer.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const header = chunks.find((item) => item.type === 'IHDR').data;
  const raw = inflateSync(Buffer.concat(chunks.filter((item) => item.type === 'IDAT').map((item) => item.data)));
  return { chunks: chunks.map((item) => item.type), width: header.readUInt32BE(0), height: header.readUInt32BE(4), format: [...header.subarray(8, 13)], raw };
}

function pixelsOf(raw, width, height) {
  const out = [];
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width + 1)], 0, 'unfiltered rows');
    out.push(...raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)));
  }
  return out;
}

describe('mask session at source-pixel precision', () => {
  it('paints discs, records one undo step per stroke and cancels a stroke exactly', () => {
    const session = editor.createMaskSession(W, H);
    session.begin();
    session.paint([4, 3], [4, 3], 1, 'add');
    session.end();
    assert.equal(session.count, 5, 'radius 1 covers the centre and its four neighbours');
    session.begin();
    session.paint([0, 0], [8, 0], 0, 'add');
    session.end(true);
    assert.equal(session.count, 5, 'a cancelled stroke leaves no trace');
    session.begin();
    session.paint([4, 3], [4, 3], 0, 'remove');
    session.end();
    assert.equal(session.count, 4);
    session.undo();
    assert.equal(session.count, 5);
    session.undo();
    assert.equal(session.count, 0);
    assert.equal(session.canUndo, false);
  });

  it('fills a shape including its clicked edge pixels and clips at the photo border', () => {
    const session = editor.createMaskSession(W, H);
    assert.equal(session.fillPolygon([[2, 1], [5, 1], [5, 4], [2, 4]], 'add'), true);
    const selected = [...session.mask.keys()].filter((index) => session.mask[index]).map((index) => [index % W, Math.floor(index / W)]);
    assert.equal(selected.length, 16, 'a 4 × 4 block including the vertex pixels');
    assert.ok(selected.every(([x, y]) => x >= 2 && x <= 5 && y >= 1 && y <= 4));
    session.fillPolygon([[-3, -3], [20, -3], [20, 20]], 'remove');
    assert.ok(session.count < 16, 'out-of-photo vertices are clipped, not rejected');
    session.undo();
    assert.equal(session.count, 16);
    assert.equal(session.fillPolygon([[0, 0], [1, 1]], 'add'), false, 'two points are not a shape');
  });

  it('maps pointer positions to source pixels at any zoom', () => {
    assert.deepEqual(editor.sourcePixelAt(35, 13, { left: 0, top: 0, width: W * 4, height: H * 4 }, W, H), [8, 3]);
    assert.deepEqual(editor.sourcePixelAt(5.9, 0, { left: 2, top: 0, width: W, height: H }, W, H), [3, 0]);
    assert.equal(editor.sourcePixelAt(-1, 0, { left: 0, top: 0, width: W, height: H }, W, H), null);
  });
});

describe('fixed-format mask export and native mask reading', () => {
  it('writes an opaque 8-bit grayscale PNG with only 0 and 255 and a matching hash', async () => {
    const mask = new Uint8Array(W * H);
    mask[0] = mask[W * H - 1] = mask[W + 3] = 1;
    const bytes = await editor.encodeMaskPng(mask, W, H);
    const png = parsePng(bytes);
    assert.deepEqual(png.chunks, ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual([png.width, png.height, ...png.format], [W, H, 8, 0, 0, 0, 0]);
    assert.deepEqual(pixelsOf(png.raw, W, H), [...mask].map((value) => value * 255));
    assert.equal(await editor.sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(editor.encodeMaskPng(new Uint8Array(3), W, H));
  });

  it('reads back its own exported masks exactly and refuses a wrong size', async () => {
    const width = 15;
    const height = 11;
    const mask = new Uint8Array(width * height);
    mask[0] = mask[3 * width + 7] = mask[10 * width + 14] = 1;
    const bytes = await editor.encodeMaskPng(mask, width, height);
    assert.deepEqual(await editor.readBinaryMask(bytes, width, height), mask);
    await assert.rejects(editor.readBinaryMask(bytes, width + 1, height), /does not fit this photo/);
  });
});

function mount({ initialMaskUrl = null, onConfirm = async () => true, natural = [W, H] } = {}) {
  const host = new Element('section');
  const calls = { confirm: [], cancel: 0 };
  const component = editor.mountObjectOutlineEditor(host, {
    source: { url: '/api/drafts/d/assets/photo.png', width: W, height: H, sha256: 'a'.repeat(64) },
    initialMaskUrl,
    onConfirm: (payload) => { calls.confirm.push(payload); return onConfirm(payload); },
    onCancel: () => { calls.cancel += 1; },
  });
  const find = (predicate) => host.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const image = find((node) => node.tag === 'img')[0];
  const frame = image.parent;
  const check = find((node) => node.tag === 'input' && node.type === 'checkbox')[0];
  const status = () => find((node) => node.className === 'form-message')[0].textContent;
  const position = () => find((node) => node.className === 'hint' && node.role === 'status')[0].textContent;
  // A viewport exactly the photo's size draws the overlay one-to-one, so the
  // drawn selection gives the exact selected count without any visible number.
  Object.assign(frame.parent, { clientWidth: W, clientHeight: H, scrollLeft: 0, scrollTop: 0 });
  const overlay = frame.children.find((node) => node.tag === 'canvas');
  const selected = () => { const data = overlay.painted?.data ?? []; let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) n += 1; return n; };
  const load = () => {
    Object.assign(image, { naturalWidth: natural[0], naturalHeight: natural[1], rect: { left: 0, top: 0, width: W * 10, height: H * 10 } });
    image.dispatch('load');
    button('Finest brush').dispatch('click');
  };
  const pointer = (type, x, y, id = 1) => frame.dispatch(type, { clientX: x * 10 + 5, clientY: y * 10 + 5, pointerId: id, button: 0 });
  const stroke = (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); };
  const tick = () => { check.checked = true; check.dispatch('change'); };
  return { host, component, calls, button, image, frame, check, status, position, selected, load, pointer, stroke, tick };
}

describe('object outline editor component', () => {
  it('loads the supplied photo copy, refuses a resized copy and keeps editing disabled', () => {
    const view = mount({ natural: [W / 3 | 0, H / 3 | 0] });
    assert.equal(view.image.src, '/api/drafts/d/assets/photo.png');
    view.load();
    assert.match(view.status(), /not the same size as the original/);
    view.stroke(1, 1);
    assert.equal(view.selected(), 0);
    assert.match(view.position(), /Nothing is selected yet/);
    assert.equal(view.button('Use this outline').disabled, true);
  });

  it('uses the caller-supplied photo copy as is and refuses any size other than the stored grid, including a quarter-turn swap', () => {
    const view = mount({ natural: [H, W] });
    assert.equal(view.image.alt, 'Copy of the photo for outlining the object', 'not presented as the original bytes');
    assert.equal(view.image.style.imageOrientation, 'none');
    view.load();
    assert.match(view.status(), /not the same size as the original/);
    view.stroke(1, 1);
    assert.equal(view.selected(), 0);
  });

  it('paints, requires the explicit check, and confirms once with the exact mask bytes', { timeout: 5000 }, async () => {
    let release;
    // onConfirm runs only after the mask is encoded and hashed; wait for that
    // call itself rather than a fixed number of turns.
    let called;
    const confirming = new Promise((resolve) => { called = resolve; });
    const view = mount({ onConfirm: () => new Promise((resolve) => { release = resolve; called(); }) });
    view.load();
    view.stroke(2, 2);
    view.stroke(3, 2);
    assert.equal(view.selected(), 2);
    assert.match(view.position(), /2 pixels selected\./);
    assert.doesNotMatch(view.position(), /source/, 'no implementation wording');
    assert.equal(view.button('Use this outline').disabled, true, 'the check is required');
    view.tick();
    view.button('Use this outline').dispatch('click');
    view.button('Use this outline').dispatch('click');
    await confirming;
    assert.equal(view.calls.confirm.length, 1, 'one call per attempt while pending');
    assert.equal(view.button('Use this outline').disabled, true);
    view.stroke(5, 5);
    assert.equal(view.selected(), 2, 'no edits while pending');
    const payload = view.calls.confirm[0];
    assert.deepEqual([payload.width, payload.height, payload.crop], [W, H, [0, 0, W, H]]);
    assert.equal(payload.mask.type, 'image/png');
    const bytes = new Uint8Array(await payload.mask.arrayBuffer());
    assert.equal(payload.maskSha256, createHash('sha256').update(bytes).digest('hex'));
    const pixels = pixelsOf(parsePng(bytes).raw, W, H);
    assert.deepEqual(pixels.flatMap((value, index) => (value ? [index] : [])), [2 * W + 2, 2 * W + 3]);
    release({ outlineId: 'x' });
    await settle();
    assert.match(view.status(), /will be used/);
    assert.equal(view.button('Use this outline').disabled, true, 'locked after acceptance');
    assert.equal(view.button('Cancel').disabled, true, 'an accepted outline cannot be cancelled as unwritten');
    view.stroke(6, 4);
    assert.equal(view.selected(), 2);
  });

  it('keeps the drawing after a refused or failed confirmation and retries with identical bytes', { timeout: 5000 }, async () => {
    const answers = [() => false, () => Promise.reject(new Error('offline')), () => true];
    // Each attempt's onConfirm call is awaited before its result is checked.
    let entered;
    const view = mount({ onConfirm: () => { entered(); return answers.shift()(); } });
    view.load();
    view.stroke(4, 1);
    view.tick();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = new Promise((resolve) => { entered = resolve; });
      view.button('Use this outline').dispatch('click');
      await entry;
      await settle();
      if (attempt < 2) {
        assert.match(view.status(), /not used\. Your drawing is kept/);
        assert.equal(view.selected(), 1);
        assert.equal(view.button('Use this outline').focused, true, 'focus returns to the retry action');
      }
    }
    assert.equal(view.calls.confirm.length, 3);
    assert.equal(new Set(view.calls.confirm.map((payload) => payload.maskSha256)).size, 1);
    assert.equal(new Set(view.calls.confirm.map((payload) => payload.mask)).size, 1, 'an unchanged drawing reuses the same encoded Blob');
    assert.match(view.status(), /will be used/);
  });

  it('blocks an empty or full outline and invalidates the check after every edit', () => {
    const view = mount();
    view.load();
    view.tick();
    assert.equal(view.button('Use this outline').disabled, true, 'empty outline');
    view.button('Draw a shape').dispatch('click');
    for (const [x, y] of [[0, 0], [8, 0], [8, 5], [0, 5]]) view.pointer('pointerdown', x, y);
    view.button('Close shape').dispatch('click');
    assert.equal(view.selected(), W * H);
    assert.equal(view.check.checked, false, 'editing clears the check');
    view.tick();
    assert.equal(view.button('Use this outline').disabled, true, 'a full-photo outline is not an object');
    view.button('Undo').dispatch('click');
    assert.equal(view.selected(), 0);
    assert.match(view.position(), /Nothing is selected yet/);
  });

  it('announces every keyboard selection change in its status text', () => {
    const view = mount();
    view.load();
    const said = [view.position()];
    for (const key of [' ', 'ArrowRight', ' ']) view.frame.dispatch('keydown', { key });
    said.push(view.position());
    view.frame.dispatch('keydown', { key: 'z', ctrlKey: true });
    said.push(view.position());
    view.frame.dispatch('keydown', { key: 'z', ctrlKey: true });
    said.push(view.position());
    assert.match(said[0], /Nothing is selected yet\./);
    assert.match(said[1], /2 pixels selected\./);
    assert.match(said[2], /1 pixel selected\./);
    assert.match(said[3], /Nothing is selected yet\./);
    for (let i = 1; i < said.length; i += 1) assert.notEqual(said[i], said[i - 1], 'the live status changes after each edit');
  });

  it('works from the keyboard at single source-pixel steps', () => {
    const view = mount();
    view.load();
    view.frame.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true });
    view.frame.dispatch('keydown', { key: 'ArrowDown' });
    view.frame.dispatch('keydown', { key: ' ' });
    assert.match(view.position(), /Pointer at 1, 5\./);
    assert.equal(view.selected(), 1);
    view.frame.dispatch('keydown', { key: 'z', ctrlKey: true });
    assert.equal(view.selected(), 0);
    view.button('Draw a shape').dispatch('click');
    for (const key of [' ', 'ArrowRight', ' ', 'ArrowUp', ' ']) view.frame.dispatch('keydown', { key });
    assert.match(view.position(), /The shape has 3 corners/);
    view.frame.dispatch('keydown', { key: 'Escape' });
    assert.doesNotMatch(view.position(), /The shape has/);
    view.frame.dispatch('keydown', { key: '+' });
    assert.match(view.position(), /Zoom 200%/);
  });

  it('locks Cancel, zoom and editing while a confirmation is in flight, and unlocks them after a refusal', { timeout: 5000 }, async () => {
    let release;
    // onConfirm runs only after the mask is encoded and hashed; wait for that
    // call itself rather than a fixed number of turns.
    let called;
    const confirming = new Promise((resolve) => { called = resolve; });
    const view = mount({ onConfirm: () => new Promise((resolve) => { release = resolve; called(); }) });
    view.load();
    view.stroke(1, 1);
    view.tick();
    view.button('Use this outline').dispatch('click');
    await confirming;
    for (const text of ['Cancel', 'Zoom in', 'Undo', 'Small brush', 'Draw a shape']) assert.equal(view.button(text).disabled, true, `${text} is locked while pending`);
    view.button('Cancel').disabled = false;
    view.button('Cancel').dispatch('click');
    view.frame.dispatch('keydown', { key: '+' });
    assert.equal(view.calls.cancel, 0, 'the handler itself refuses Cancel while a write may complete');
    assert.match(view.position(), /Zoom 100%/);
    release(false);
    await settle();
    assert.equal(view.button('Cancel').disabled, false);
    view.button('Cancel').dispatch('click');
    assert.equal(view.calls.cancel, 1);
  });

  it('cancels without writing and dispose ignores a late confirmation', { timeout: 5000 }, async () => {
    let release;
    // onConfirm runs only after the mask is encoded and hashed; wait for that
    // call itself rather than a fixed number of turns.
    let called;
    const confirming = new Promise((resolve) => { called = resolve; });
    const view = mount({ onConfirm: () => new Promise((resolve) => { release = resolve; called(); }) });
    view.load();
    view.button('Cancel').dispatch('click');
    assert.deepEqual([view.calls.cancel, view.calls.confirm.length], [1, 0]);
    view.stroke(1, 1);
    view.tick();
    view.button('Use this outline').dispatch('click');
    await confirming;
    assert.equal(view.button('Cancel').disabled, true, 'Cancel is unavailable while the write is in flight');
    const before = view.status();
    view.component.dispose();
    release(true);
    await settle();
    assert.equal(view.status(), before, 'no late update after dispose');
    assert.equal(view.calls.confirm.length, 1);
    assert.equal((view.frame.listeners.pointerdown ?? []).length, 0, 'listeners are removed');
    view.component.dispose();
  });

  it('starts from a same-origin proposed mask read from its exact bytes', async () => {
    const proposal = new Uint8Array(W * H);
    proposal[W + 1] = proposal[W + 2] = 1;
    const bytes = await editor.encodeMaskPng(proposal, W, H);
    const requests = [];
    globalThis.fetch = async (url, options) => { requests.push([url, options]); return { ok: true, arrayBuffer: async () => bytes.slice().buffer }; };
    globalThis.createImageBitmap = () => { throw new Error('the colour-managed image path must not be used'); };
    const view = mount({ initialMaskUrl: '/api/drafts/d/reconstructions/j/mask.png' });
    view.load();
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], 'http://app.test/api/drafts/d/reconstructions/j/mask.png');
    assert.equal(requests[0][1].credentials, 'same-origin');
    assert.equal(view.selected(), 2);
  });

  it('refuses an invalid or foreign proposed mask and offers a blank manual outline', async () => {
    globalThis.fetch = async () => { throw new Error('must not fetch'); };
    const foreign = mount({ initialMaskUrl: 'https://elsewhere.test/mask.png' });
    foreign.load();
    await settle();
    assert.match(foreign.status(), /could not be used/);
    const notPng = new Uint8Array([1, 2, 3]);
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => notPng.buffer });
    const view = mount({ initialMaskUrl: '/mask.png' });
    view.load();
    await settle();
    assert.match(view.status(), /suggested outline could not be read.*blank outline/);
    view.stroke(1, 1);
    assert.equal(view.selected(), 0, 'nothing is editable from a refused proposal');
    view.button('Start a blank outline').dispatch('click');
    view.button('Finest brush').dispatch('click');
    view.stroke(1, 1);
    assert.equal(view.selected(), 1);
  });
});
