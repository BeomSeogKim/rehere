import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { currentCamera, installViewerShim, visitorSurface } from './viewer-shim.mjs';

// The real OrbitControls drives these tests: pointer, wheel and key events go
// through its own listeners, and every assertion reads back its own state.
installViewerShim({ realOrbitControls: true });

// Every ResizeObserver callback the viewer registers, so a test can report a
// changed viewport size the way a browser would.
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  disconnect() {}
};

let createViewer, cameraWithinPhotoOrbit;
before(async () => {
  // The real controls listen on the canvas owner's document and capture
  // pointers; neither exists on the bare fake elements, so the test document
  // provides both.
  const ownerDocument = {
    listeners: {},
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    },
    removeEventListener(type, listener) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener);
    },
    dispatch(type, event = {}) {
      for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, ...event });
    },
  };
  globalThis.document = {
    ownerDocument,
    createElement: (tag) => {
      const element = new FakeElement(tag);
      element.ownerDocument = ownerDocument;
      element.releasePointerCapture = () => {};
      element.removeEventListener = (type, listener) => {
        element.listeners[type] = (element.listeners[type] ?? []).filter((entry) => entry !== listener);
      };
      return element;
    },
  };
  globalThis.devicePixelRatio = 3;
  ({ createViewer, cameraWithinPhotoOrbit } = await import('../public/scene-viewer.js'));
});
after(() => {
  delete globalThis.document;
  delete globalThis.devicePixelRatio;
});
beforeEach(() => {
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  delete globalThis.viewerTextureWait;
  observers.length = 0;
});

function viewportOf(width, height) {
  const viewport = new FakeElement('div');
  viewport.clientWidth = width;
  viewport.clientHeight = height;
  return viewport;
}

// The canvas the viewer renders into; the real controls measure drags against
// its size, so it carries the viewport size the way a laid-out canvas would.
function canvasOf(width, height) {
  const canvas = globalThis.viewerRenderer.domElement;
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  return canvas;
}
const controlsOf = () => globalThis.viewerCamera.controls;
const targetOf = () => currentCamera().target;
const radiusOf = () => {
  const { position, target } = currentCamera();
  return Math.hypot(...position.map((value, index) => value - target[index]));
};
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
function assertBounded(viewer) {
  const { position, target } = viewer.getCamera();
  const ray = position.map((n, i) => n - target[i]);
  const angle = Math.acos(Math.max(-1, Math.min(1, ray[2] / Math.hypot(...ray)))) * 180 / Math.PI;
  assert.ok(angle <= 10 + 1e-6, `actual angle ${angle} exceeds ten degrees`);
  assert.deepEqual(target, [0, 0, -3]);
  close(radiusOf(), 3, 'fixed radius');
}

const pointerDown = (canvas, { pointerId = 1, pointerType = 'mouse', button = 0, x = 100, y = 100 } = {}) =>
  canvas.dispatch('pointerdown', { pointerId, pointerType, button, clientX: x, clientY: y, pageX: x, pageY: y, isPrimary: true });
const pointerMove = ({ pointerId = 1, pointerType = 'mouse', x = 100, y = 100 } = {}) =>
  globalThis.document.ownerDocument.dispatch('pointermove', { pointerId, pointerType, clientX: x, clientY: y, pageX: x, pageY: y, isPrimary: true });
const pointerUp = ({ pointerId = 1, pointerType = 'mouse', x = 100, y = 100 } = {}) =>
  globalThis.document.ownerDocument.dispatch('pointerup', { pointerId, pointerType, clientX: x, clientY: y, pageX: x, pageY: y, isPrimary: true });

// A full press-drag-release through the real pointer listeners.
function drag(canvas, { pointerType = 'mouse', button = 0, from = [100, 100], to = [500, 400] } = {}) {
  pointerDown(canvas, { pointerType, button, x: from[0], y: from[1] });
  pointerMove({ pointerType, x: to[0], y: to[1] });
  pointerUp({ pointerType, x: to[0], y: to[1] });
  controlsOf().update();
}

describe('limited photo-view controls', () => {
  it('keeps drags, keys and wheel inside the ten-degree cone at a fixed distance', async () => {
    const viewer = await createViewer(viewportOf(800, 600), visitorSurface(), 'blob:texture', 'Limited photo view', { limitedPhotoView: true });
    const canvas = canvasOf(800, 600);
    const controls = controlsOf();
    assert.equal(controls.enablePan, false);
    assert.equal(controls.enableZoom, false);
    viewer.setInteractive(true);

    // Long drags in every direction: rotation stays clamped, never recentred.
    const original = viewer.getCamera();
    drag(canvas, { to: [700, 500] });
    assert.notDeepEqual(viewer.getCamera().position, original.position, 'limited exploration still rotates');
    assertBounded(viewer);
    drag(canvas, { from: [700, 500], to: [100, 100] });
    assertBounded(viewer);
    drag(canvas, { pointerType: 'touch' });
    assertBounded(viewer);
    const beforeRightDrag = viewer.getCamera();
    drag(canvas, { button: 2 });
    assert.deepEqual(viewer.getCamera(), beforeRightDrag, 'right dragging cannot pan');
    for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) canvas.dispatch('keydown', { code });
    controls.update();
    assert.deepEqual(targetOf(), [0, 0, -3]);
    close(radiusOf(), 3, 'orbit radius');
    assert.equal(cameraWithinPhotoOrbit(viewer.getCamera()), true);
    assertBounded(viewer);

    // Wheeling in and out cannot dolly.
    canvas.dispatch('wheel', { deltaX: 0, deltaY: -300 });
    canvas.dispatch('wheel', { deltaX: 0, deltaY: 300 });
    controls.update();
    close(radiusOf(), 3, 'wheel radius');
    assert.deepEqual(targetOf(), [0, 0, -3]);

    // A two-finger pinch cannot dolly or recenter either.
    pointerDown(canvas, { pointerId: 1, pointerType: 'touch', x: 300, y: 300 });
    pointerDown(canvas, { pointerId: 2, pointerType: 'touch', x: 500, y: 300 });
    pointerMove({ pointerId: 1, pointerType: 'touch', x: 100, y: 300 });
    pointerMove({ pointerId: 2, pointerType: 'touch', x: 700, y: 300 });
    pointerUp({ pointerId: 1, pointerType: 'touch', x: 100, y: 300 });
    pointerUp({ pointerId: 2, pointerType: 'touch', x: 700, y: 300 });
    controls.update();
    close(radiusOf(), 3, 'pinch radius');
    assert.deepEqual(targetOf(), [0, 0, -3]);
    assert.equal(cameraWithinPhotoOrbit(viewer.getCamera()), true);
    assertBounded(viewer);
    viewer.dispose();
  });

  it('resets a programmatic stale camera outside the limits on update', async () => {
    const viewer = await createViewer(viewportOf(800, 600), visitorSurface(), 'blob:texture', 'Limited photo view', { limitedPhotoView: true });
    canvasOf(800, 600);
    viewer.setInteractive(true);
    for (const stale of [
      { position: [1, 0, 0], target: [0, 0, -3] },
      { position: [0, 0, 0], target: [1, 0, -3] },
    ]) {
      assert.equal(viewer.setCamera(stale), false);
      const reset = viewer.getCamera();
      reset.position.forEach((value, index) => close(value, [0, 0, 0][index], 'reset position'));
      assert.deepEqual(reset.target, [0, 0, -3]);
      assert.equal(cameraWithinPhotoOrbit(viewer.getCamera()), true);
    }
    viewer.dispose();
  });
});

describe('ordinary viewer controls', () => {
  it('still pans with arrow keys and dollies with the wheel', async () => {
    const viewer = await createViewer(viewportOf(800, 600), visitorSurface(), 'blob:texture', 'Ordinary view');
    const canvas = canvasOf(800, 600);
    const controls = controlsOf();
    assert.equal(viewer.limitedPhotoView, false);
    assert.equal(controls.enablePan, true);
    assert.equal(controls.enableZoom, true);
    viewer.setInteractive(true);

    canvas.dispatch('keydown', { code: 'ArrowRight' });
    assert.notDeepEqual(targetOf(), [0, 0, -3]);

    const before = radiusOf();
    canvas.dispatch('wheel', { deltaX: 0, deltaY: -300 });
    assert.ok(radiusOf() < before, `wheel dollies in: ${radiusOf()} < ${before}`);
    viewer.dispose();
  });
});
