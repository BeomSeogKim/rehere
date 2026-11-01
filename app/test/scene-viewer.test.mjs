import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as THREE from 'three';
import { FakeElement } from './fake-dom.mjs';
import { currentCamera, installViewerShim, rendererState, visitorSurface } from './viewer-shim.mjs';
import * as photoScene from '../public/photo-scene.js';
import { COMPOSITION_REPRESENTATION, quaternionFromEuler, rotateVector } from '../public/composition-scene.js';

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
installViewerShim();

let createViewer;
before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.devicePixelRatio = 3;
  ({ createViewer } = await import('../public/scene-viewer.js'));
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

function compositionSurface() {
  return {
    schema_version: 3, representation: COMPOSITION_REPRESENTATION,
    components: [visitorSurface(), surfaceWithSize(400, 600)].map((surface, index) => ({
      id: `object-${index + 1}`, label: `Object ${index + 1}`, texture: `texture-${index + 1}.jpg`, selectedObjectId: 'selected-foreground', surface,
    })),
    context: { kind: 'photographed-background', componentId: 'object-1', bounds: null, pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 } },
  };
}
const textureUrls = { 'texture-1.jpg': 'blob:one', 'texture-2.jpg': 'blob:two' };

describe('two-photo composition viewer', () => {
  it('loads both textures, uses a common camera and releases both without claiming one original view', async () => {
    const viewport = viewportOf(800, 600), surface = compositionSurface();
    const viewer = await createViewer(viewport, surface, textureUrls, 'Composition');
    assert.deepEqual(globalThis.viewerLog.filter((n) => n.startsWith('texture ')), ['texture blob:one', 'texture blob:two']);
    assert.deepEqual(currentCamera(), { position: [0, 0, 5], target: [0, 0, 0] });
    assert.equal(viewer.originalView(), false);
    assert.equal(viewer.setPhotoFraming(true), false);
    const pose = { position: [-1, 0.2, 0], quaternion: quaternionFromEuler([0.1, 0.8, -0.2]), scale: 0.8 };
    viewer.applyArrangement({ frame: 'owner-composition', objects: [{ id: 'object-1', ...pose }, { id: 'object-2', position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }], relationship: null });
    assert.equal(viewer.projectCentres().length, 2);
    const pivot = photoScene.objectSurfaceMeshes(surface).objects[0].sourcePivot;
    const ray = rotateVector(pivot.map((n) => -n * pose.scale), pose.quaternion);
    assert.equal(viewer.viewPhotographedSide(pose, 'object-1'), true);
    assert.deepEqual(currentCamera(), { position: pose.position.map((n, i) => n + ray[i]), target: pose.position });
    const inspected = viewer.getCamera(), camera = globalThis.viewerCamera.camera;
    assert.equal(camera.fov, 55, 'the photographed-side vantage keeps the common composition projection');
    const projection = [...camera.projectionMatrix.elements];
    viewer.setCamera(inspected);
    assert.deepEqual(viewer.getCamera(), inspected);
    assert.deepEqual(camera.projectionMatrix.elements, projection, 'saving and restoring the vectors preserves the projection');
    const target = pose.position.map((n, i) => n + rotateVector([0, 0, 1], pose.quaternion)[i]);
    assert.equal(viewer.showGuide(pose, target, 'object-1').aligned, true);
    viewer.setCamera({ position: [0, 0, 5], target: [0, 0, 0] });
    assert.equal(globalThis.viewerCamera.camera.fov, 55);
    viewer.dispose(); viewer.dispose();
    assert.equal(globalThis.viewerLog.filter((n) => n === 'texture.dispose').length, 2);
    assert.equal(globalThis.viewerLog.filter((n) => n === 'renderer.dispose').length, 1);
    assert.equal(viewport.children.length, 0);
  });

  it('cleans the first texture and renderer when the second texture fails late', async () => {
    let rejectSecond;
    globalThis.viewerTextureWait = { 'blob:two': new Promise((_, reject) => { rejectSecond = reject; }) };
    const viewport = viewportOf(800, 600);
    const pending = createViewer(viewport, compositionSurface(), textureUrls, 'Composition');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(globalThis.viewerLog.filter((n) => n.startsWith('texture ')), ['texture blob:one']);
    rejectSecond(new Error('late failure'));
    await assert.rejects(pending, /texture/);
    assert.equal(globalThis.viewerLog.filter((n) => n === 'texture.dispose').length, 1);
    assert.equal(globalThis.viewerLog.filter((n) => n === 'renderer.dispose').length, 1);
    assert.equal(viewport.children.length, 0);
  });

  it('releases both textures on malformed geometry after loading and permits explicit context-off', async () => {
    const invalid = compositionSurface(); invalid.components[1].selectedObjectId = 'missing';
    await assert.rejects(createViewer(viewportOf(800, 600), invalid, textureUrls, 'Composition'));
    assert.equal(globalThis.viewerLog.filter((n) => n === 'texture.dispose').length, 2);
    const source = compositionSurface(); source.context = null;
    const viewer = await createViewer(viewportOf(800, 600), source, textureUrls, 'Two observed surfaces');
    viewer.dispose();
  });
});

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

function viewportOf(width, height) {
  const viewport = new FakeElement('div');
  viewport.clientWidth = width;
  viewport.clientHeight = height;
  return viewport;
}
const resizeTo = (viewport, width, height) => {
  viewport.clientWidth = width;
  viewport.clientHeight = height;
  for (const observer of observers) observer.callback();
};
const surfaceWithSize = (width, height) => ({ ...visitorSurface(), source: { image_size: [width, height] } });

// Where a photograph shown with contain-fit in the viewport puts source pixel (u, v).
function containPoint(viewport, [imageWidth, imageHeight], [u, v]) {
  const scale = Math.min(viewport.clientWidth / imageWidth, viewport.clientHeight / imageHeight);
  const left = (viewport.clientWidth - imageWidth * scale) / 2;
  const top = (viewport.clientHeight - imageHeight * scale) / 2;
  return [left + u * scale, top + v * scale];
}

// A point the original camera sees at source pixel (u, v), at depth `depth`,
// from the same horizontal field of view the surface assumes.
function sourceRay(surface, [u, v], depth = 3) {
  const [imageWidth, imageHeight] = surface.source.image_size;
  const horizontal = Math.tan((surface.assumptions.horizontal_fov_degrees * Math.PI) / 360);
  const vertical = (horizontal * imageHeight) / imageWidth;
  return new THREE.Vector3(((2 * u) / imageWidth - 1) * horizontal * depth, (1 - (2 * v) / imageHeight) * vertical * depth, -depth);
}

// Where the viewer draws a world point, in viewport pixels: canvas offset plus
// its position inside the canvas, from the camera the viewer actually uses.
function drawnAt(viewport, point) {
  const [width, height] = rendererState().size;
  const canvas = viewport.children.at(-1);
  const left = Number.parseFloat(canvas.style.marginLeft || '0');
  const top = Number.parseFloat(canvas.style.marginTop || '0');
  const ndc = point.clone().project(globalThis.viewerCamera.camera);
  return [left + ((ndc.x + 1) / 2) * width, top + ((1 - ndc.y) / 2) * height];
}

const LANDMARKS = (width, height) => [[width * 0.1, height * 0.1], [width * 0.9, height * 0.9], [width / 2, height / 2], [width * 0.75, height * 0.2], [0, height], [width, 0]];

describe('photo framing', () => {
  it('keeps the legacy photo projection through photographed-side camera roundtrips', async () => {
    const surface = visitorSurface(), viewport = viewportOf(800, 600);
    const viewer = await createViewer(viewport, surface, 'blob:texture', 'Legacy scene');
    const camera = globalThis.viewerCamera.camera, fov = camera.fov;
    assert.notEqual(fov, 55);
    assert.equal(viewer.viewPhotographedSide({ offset: [0.1, 0, 0], yaw: 0.3 }), true);
    const inspected = viewer.getCamera(), projection = [...camera.projectionMatrix.elements];
    viewer.setCamera(inspected);
    assert.deepEqual(viewer.getCamera(), inspected);
    assert.equal(camera.fov, fov);
    assert.deepEqual(camera.projectionMatrix.elements, projection);
    viewer.dispose();
  });
  for (const [label, source, viewportSize] of [
    ['wide viewport, landscape photo', [600, 500], [1000, 400]],
    ['narrow viewport, landscape photo', [600, 500], [300, 800]],
    ['wide viewport, portrait photo', [400, 600], [900, 500]],
    ['narrow viewport, portrait photo', [400, 600], [320, 900]],
  ]) {
    it(`registers the scene with a contain-fit photograph: ${label}`, async () => {
      const surface = surfaceWithSize(...source);
      const viewport = viewportOf(...viewportSize);
      const viewer = await createViewer(viewport, surface, 'blob:texture', 'Scene');
      viewer.originalView();
      viewer.setPhotoFraming(true);

      const scale = Math.min(viewportSize[0] / source[0], viewportSize[1] / source[1]);
      const [fitWidth, fitHeight] = [source[0] * scale, source[1] * scale];
      const [rendered, canvas] = [rendererState().size, viewport.children.at(-1)];
      close(rendered[0], fitWidth, 'canvas width');
      close(rendered[1], fitHeight, 'canvas height');
      close(Number.parseFloat(canvas.style.marginLeft), (viewportSize[0] - fitWidth) / 2, 'left offset');
      close(Number.parseFloat(canvas.style.marginTop), (viewportSize[1] - fitHeight) / 2, 'top offset');
      close(globalThis.viewerCamera.camera.aspect, source[0] / source[1], 'projection aspect');
      for (const landmark of LANDMARKS(...source)) {
        const [x, y] = drawnAt(viewport, sourceRay(surface, landmark));
        const [expectedX, expectedY] = containPoint(viewport, source, landmark);
        close(x, expectedX, `${label} x of ${landmark}`);
        close(y, expectedY, `${label} y of ${landmark}`);
      }

      // The vertical field of view is fixed, so normal framing already matches
      // in a viewport wider than the photo; a narrower one does not line up,
      // which is why the seam exists.
      viewer.setPhotoFraming(false);
      const corner = LANDMARKS(...source)[0];
      const [unframedX, unframedY] = drawnAt(viewport, sourceRay(surface, corner));
      const [photoX, photoY] = containPoint(viewport, source, corner);
      const offset = Math.hypot(unframedX - photoX, unframedY - photoY);
      if (viewportSize[0] / viewportSize[1] < source[0] / source[1]) assert.ok(offset > 1, `${label}: normal framing differs from the photograph`);
      else assert.ok(offset < 1e-6, `${label}: normal framing already matches`);
      viewer.dispose();
    });
  }

  it('stays registered through viewport resizes and restores normal full-viewport framing', async () => {
    const surface = visitorSurface();
    const source = surface.source.image_size;
    const viewport = viewportOf(1200, 600);
    const viewer = await createViewer(viewport, surface, 'blob:texture', 'Scene');
    viewer.originalView();
    // A browser reports the observed size once on observe().
    resizeTo(viewport, 1200, 600);
    const normal = { size: [...rendererState().size], aspect: globalThis.viewerCamera.camera.aspect };
    assert.deepEqual(normal, { size: [1200, 600], aspect: 2 });

    viewer.setPhotoFraming(true);
    for (const [width, height] of [[360, 780], [1500, 500], [700, 700]]) {
      resizeTo(viewport, width, height);
      for (const landmark of LANDMARKS(...source)) {
        const [x, y] = drawnAt(viewport, sourceRay(surface, landmark));
        const [expectedX, expectedY] = containPoint(viewport, source, landmark);
        close(x, expectedX, `${width}x${height} x`);
        close(y, expectedY, `${width}x${height} y`);
      }
      close(globalThis.viewerCamera.camera.aspect, source[0] / source[1], `${width}x${height} aspect`);
    }

    viewer.setPhotoFraming(false);
    const canvas = viewport.children.at(-1);
    assert.deepEqual(rendererState().size, [700, 700]);
    assert.equal(globalThis.viewerCamera.camera.aspect, 1);
    assert.deepEqual([canvas.style.marginLeft, canvas.style.marginTop], ['', '']);
    resizeTo(viewport, 1200, 600);
    assert.deepEqual({ size: rendererState().size, aspect: globalThis.viewerCamera.camera.aspect }, normal, 'off: resizes fill the viewport again');
    viewer.dispose();
  });

  it('changes no camera, field of view, pixel ratio, allocation or interaction state', async () => {
    const viewport = viewportOf(1000, 400);
    const viewer = await createViewer(viewport, visitorSurface(), 'blob:texture', 'Scene');
    viewer.setCamera({ position: [1.2, 0.4, -0.5], target: [0, 0, -3] });
    viewer.setInteractive(true);
    const camera = globalThis.viewerCamera.camera;
    const before = { camera: currentCamera(), fov: camera.fov, near: camera.near, far: camera.far, pixelRatio: rendererState().pixelRatio, log: [...globalThis.viewerLog] };
    assert.equal(before.pixelRatio, 2, 'the existing pixel-ratio cap');
    viewer.setPhotoFraming(true);
    viewer.setPhotoFraming(true);
    viewer.setPhotoFraming(false);
    const now = { camera: currentCamera(), fov: camera.fov, near: camera.near, far: camera.far, pixelRatio: rendererState().pixelRatio, log: [...globalThis.viewerLog] };
    assert.deepEqual(now, before);
    assert.equal(viewer.isInteractive(), true);
    assert.deepEqual(globalThis.viewerLog.filter((entry) => entry.startsWith('texture')), ['texture blob:texture'], 'the texture loads once');
    viewer.dispose();
  });

  it('places two-object labels over the framed canvas, and unchanged when framing is off', async () => {
    const grid = 20;
    const surface = {
      schema_version: 2, width: grid, height: grid, depth: Array(grid * grid).fill(3),
      regions: Array.from({ length: grid * grid }, (_, i) => {
        const x = i % grid;
        const y = Math.floor(i / grid);
        return y >= 6 && y <= 13 ? (x >= 2 && x <= 6 ? 1 : x >= 13 && x <= 17 ? 2 : 0) : 0;
      }),
      objects: [{ id: 'object-1', label: 'Counter', box_xyxy: [0, 435, 226, 790] }, { id: 'object-2', label: 'Stack', box_xyxy: [490, 450, 982, 781] }],
      assumptions: { near: 1, far: 4, horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
      source: { image_size: [1000, 800] },
    };
    const pivots = photoScene.createObjectSceneObjects(THREE, surface, new THREE.Texture()).objects.map(({ id, pivot }) => ({ id, pivot }));
    const viewport = viewportOf(300, 900);
    const viewer = await createViewer(viewport, surface, 'blob:texture', 'Scene');
    viewer.originalView();
    const unframed = viewer.projectCentres();
    for (const [index, { pivot }] of pivots.entries()) {
      const ndc = new THREE.Vector3(...pivot).project(globalThis.viewerCamera.camera);
      close(unframed[index].x, ((ndc.x + 1) / 2) * 300, 'normal label x');
    }
    viewer.setPhotoFraming(true);
    const framed = viewer.projectCentres();
    for (const [index, { pivot }] of pivots.entries()) {
      const [x, y] = drawnAt(viewport, new THREE.Vector3(...pivot));
      close(framed[index].x, x, 'framed label x');
      close(framed[index].y, y, 'framed label y');
    }
    viewer.dispose();
  });
});
