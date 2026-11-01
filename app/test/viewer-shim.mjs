import { registerHooks } from 'node:module';

// Node has no WebGL. This maps the browser's /vendor modules to Three.js with
// recording stand-ins for the renderer, texture loader and orbit controls, so
// the real scene-viewer.js runs. Allocations and releases go to
// globalThis.viewerLog; globalThis.viewerFail can name a step to fail.
const three = import.meta.resolve('three');
const threeShim = `
export * from '${three}';
import * as T from '${three}';
const log = (entry) => globalThis.viewerLog?.push(entry);
export class WebGLRenderer {
  constructor() {
    if (globalThis.viewerFail === 'webgl') throw new Error('no context');
    this.domElement = document.createElement('canvas');
    // Size and pixel ratio are kept on the instance, never in viewerLog, so
    // exact log assertions elsewhere are unaffected.
    this.size = null;
    this.pixelRatio = null;
    globalThis.viewerRenderer = this;
    log('renderer');
  }
  setPixelRatio(ratio) { this.pixelRatio = ratio; }
  setSize(width, height) { this.size = [width, height]; }
  render() {}
  dispose() { log('renderer.dispose'); }
  forceContextLoss() {}
}
export class TextureLoader {
  async loadAsync(url) {
    if (globalThis.viewerTextureWait?.[url]) await globalThis.viewerTextureWait[url];
    if (globalThis.viewerFail === 'texture' || globalThis.viewerFail === 'texture:' + url) throw new Error('404');
    const texture = new T.Texture();
    texture.dispose = () => log('texture.dispose');
    log('texture ' + url);
    return texture;
  }
}`;
const controlsShim = `
import { Vector3 } from '${three}';
export class OrbitControls {
  constructor(camera) {
    this.object = camera;
    this.target = new Vector3();
    globalThis.viewerCamera = { camera, controls: this };
  }
  listenToKeyEvents() {}
  addEventListener() {}
  update() {}
  dispose() { globalThis.viewerLog?.push('controls.dispose'); }
}`;
const SHIMS = {
  '/vendor/three.module.js': `data:text/javascript,${encodeURIComponent(threeShim)}`,
  '/vendor/OrbitControls.js': `data:text/javascript,${encodeURIComponent(controlsShim)}`,
  // The actual library; the browser route serves its bundled ESM build.
  '/vendor/three-mesh-bvh.js': import.meta.resolve('three-mesh-bvh'),
};

export function installViewerShim() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return SHIMS[specifier] ? { url: SHIMS[specifier], shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  globalThis.window ??= globalThis;
}

// The last renderer's CSS size and pixel ratio, as the viewer last set them.
export const rendererState = () => ({ size: globalThis.viewerRenderer.size, pixelRatio: globalThis.viewerRenderer.pixelRatio });

// The camera the viewer currently uses, as plain vectors.
export const currentCamera = () => ({
  position: globalThis.viewerCamera.camera.position.toArray(),
  target: globalThis.viewerCamera.controls.target.toArray(),
});

// A minimal surface the real scene builder accepts: background plus a small
// foreground block, with no source IDs, as visitors receive it.
export function visitorSurface() {
  const width = 6;
  const height = 5;
  const foreground = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) foreground.push(x >= 2 && x <= 4 && y >= 1 && y <= 3 ? 1 : 0);
  return {
    source: { image_size: [600, 500] },
    width,
    height,
    depth: foreground.map((selected) => (selected ? 3.9 : 4)),
    foreground,
    assumptions: { horizontal_fov_degrees: 55, max_triangle_depth_span: 0.35 },
  };
}
