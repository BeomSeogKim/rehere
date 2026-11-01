// The actual photo-surface viewer, shared by the owner's scene editor and the
// read-only visitor screen. It renders with Three.js from the local vendor
// copy and releases every allocation on dispose or on a failed setup.

import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';
// A namespace import: the two-object builder is looked up only for a
// two-object surface, so the legacy viewer never depends on it.
import * as photoScene from './photo-scene.js';
import { compositionFacingGuide, rotateVector } from './composition-scene.js';

// Camera limits the viewer itself enforces; a saved camera must stay within them.
export const CAMERA_LIMITS = Object.freeze({ coordinate: 50, minDistance: 0.5, maxDistance: 8 });

// The same rule a saved share camera must meet (parseCamera on the server):
// finite coordinates within the limit, and a position-to-target distance the
// controls allow. A camera that fails is not used, rather than clamped.
export function cameraWithinLimits({ position, target }) {
  const vector = (value) => Array.isArray(value) && value.length === 3 && value.every((item) => Number.isFinite(item) && Math.abs(item) <= CAMERA_LIMITS.coordinate);
  if (!vector(position) || !vector(target)) return false;
  const distance = Math.hypot(...position.map((value, index) => value - target[index]));
  return distance >= CAMERA_LIMITS.minDistance && distance <= CAMERA_LIMITS.maxDistance;
}

// The photo's own vantage carried round with one object: the original camera
// (at the origin) as seen from the object's unmoved centre, turned by the
// object's yaw about the vertical axis and moved with its offset. The camera
// looks at the object's centre, so the framing differs from the photo; it is
// not the photo's projection. Null when that vantage is outside the limits.
export function photographedSideCamera(pivot, transform) {
  if (transform.position) {
    const delta = rotateVector(pivot.map((n) => -n * transform.scale), transform.quaternion);
    const camera = { position: transform.position.map((n, i) => n + delta[i]), target: [...transform.position] };
    return cameraWithinLimits(camera) ? camera : null;
  }
  const { offset, yaw } = transform;
  const centre = pivot.map((value, axis) => value + offset[axis]);
  const [x, y, z] = pivot.map((value) => -value);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const camera = { position: [centre[0] + x * cos + z * sin, centre[1] + y, centre[2] - x * sin + z * cos], target: centre };
  return cameraWithinLimits(camera) ? camera : null;
}

// Renders the photo as a WebGL scene. Throws when the browser cannot create a
// WebGL context or the texture cannot load, so the caller can say so instead
// of showing a blank or untextured scene as if it had worked.
// Every allocation registers its release as soon as it exists, so a failure at
// any later step frees what was already created.
// onDraw, when given, runs after every frame is drawn (camera moves included),
// for anything placed over the canvas.
export async function createViewer(viewport, surface, textureUrl, label, { onDraw = null } = {}) {
  const releases = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const step of releases.reverse()) {
      try {
        step();
      } catch {
        // Keep releasing the rest.
      }
    }
  };
  try {
    return await setUpViewer(viewport, surface, textureUrl, label, releases, release, onDraw, () => released);
  } catch (error) {
    release();
    throw error;
  }
}

async function setUpViewer(viewport, surface, textureUrl, label, releases, release, onDraw, isReleased) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    throw new Error('webgl');
  }
  releases.push(() => {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  });
  const composition = surface?.schema_version === 3;
  const loadTexture = async (url) => {
    let texture;
    try { texture = await new THREE.TextureLoader().loadAsync(url); } catch { throw new Error('texture'); }
    releases.push(() => texture.dispose());
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  let texture;
  if (composition) {
    texture = {};
    for (const name of ['texture-1.jpg', 'texture-2.jpg']) {
      if (typeof textureUrl?.[name] !== 'string') throw new Error('texture');
      texture[name] = await loadTexture(textureUrl[name]);
    }
  } else texture = await loadTexture(textureUrl);
  const twoObjects = surface?.schema_version === 2 || composition;
  if (twoObjects && typeof photoScene.createObjectSceneObjects !== 'function') throw new Error('unsupported');
  const objects = twoObjects ? photoScene.createObjectSceneObjects(THREE, surface, texture) : photoScene.createSceneObjects(THREE, surface, texture);
  const meshes = (twoObjects ? [objects.background, ...objects.objects.map((object) => object.mesh)] : [objects.background, objects.foreground]).filter(Boolean);
  releases.push(() => {
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  objects.scene.background = new THREE.Color(0x161b20);

  // The vertical field of view follows from the horizontal one and the photo's
  // aspect, as the surface builder computes it.
  const [imageWidth, imageHeight] = composition ? [1, 1] : surface.source.image_size;
  const tangent = Math.tan(((composition ? 55 : surface.assumptions.horizontal_fov_degrees) * Math.PI) / 360);
  const verticalFov = composition ? 55 : objects.verticalFovDegrees ?? (2 * Math.atan((tangent * imageHeight) / imageWidth) * 180) / Math.PI;
  const camera = new THREE.PerspectiveCamera(verticalFov, 1, 0.01, 50);
  const point = new THREE.Vector3(), viewMatrix = new THREE.Matrix4();
  const meshBounds = meshes.map((mesh) => {
    const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
    const box = new THREE.Box3();
    for (let i = 0; i < (index?.count ?? position.count); i += 1) {
      box.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i) : i));
    }
    return { mesh, position, index, box };
  });
  const updateClipping = () => {
    objects.scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    let nearest = Infinity, farthest = 0;
    for (const { mesh, position, index, box } of meshBounds) {
      viewMatrix.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
      let min = Infinity, max = -Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        point.set(x, y, z).applyMatrix4(viewMatrix);
        min = Math.min(min, -point.z);
        max = Math.max(max, -point.z);
      }
      if (max <= 0) continue;
      farthest = Math.max(farthest, max);
      if (min >= 0.01) nearest = Math.min(nearest, min);
      else {
        // An empty box corner near the eye must not collapse depth precision.
        // Verify drawn vertices before reducing the ordinary near distance.
        // Any triangle crossing the eye itself still meets a positive near plane.
        for (let i = 0; i < (index?.count ?? position.count); i += 1) {
          point.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(viewMatrix);
          if (point.z < 0) nearest = Math.min(nearest, -point.z);
        }
      }
    }
    const near = nearest < 0.01 ? nearest / 2 : 0.01;
    const far = farthest >= 50 ? farthest * 1.01 : 50;
    if (camera.near !== near || camera.far !== far) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
  viewport.append(canvas);

  const controls = new OrbitControls(camera, canvas);
  releases.push(() => controls.dispose());
  controls.minDistance = CAMERA_LIMITS.minDistance;
  controls.maxDistance = CAMERA_LIMITS.maxDistance;
  controls.listenToKeyEvents(canvas);
  // Page scrolling by default: until the person chooses to explore, the
  // controls ignore pointer, wheel and keys, touch scrolls the page, and the
  // canvas is not a tab stop. Changing the mode never moves the camera. Only
  // the explicit choice to explore moves focus, to the canvas, so arrow keys
  // work at once; callers use setInteractive(true) only for that choice.
  let interactive = false;
  const setInteractive = (on) => {
    interactive = Boolean(on);
    controls.enabled = interactive;
    canvas.style.touchAction = interactive ? 'none' : 'auto';
    canvas.tabIndex = interactive ? 0 : -1;
  };
  setInteractive(false);
  const explore = (on) => {
    setInteractive(on);
    if (interactive) canvas.focus();
  };
  const draw = () => {
    if (isReleased()) return;
    updateClipping();
    renderer.render(objects.scene, camera);
    onDraw?.();
  };
  controls.addEventListener('change', draw);

  // The photo was taken from the origin looking down -z; the target sits inside
  // the pseudo-depth range so orbiting turns around the photographed surfaces.
  const look = (position) => {
    camera.position.set(...position);
    controls.target.set(0, 0, composition ? 0 : -3);
    controls.update();
    draw();
  };
  // Normally the canvas fills the viewport. In photo framing it is the
  // largest rectangle of the photo's own aspect that fits, centred, so a
  // photograph shown with contain-fit in the same viewport lines up with it
  // pixel for pixel; the projection uses exactly that aspect.
  const sourceAspect = imageWidth / imageHeight;
  let framing = false;
  let frame = null;
  const resize = () => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    if (framing) {
      const fitWidth = Math.min(width, height * sourceAspect);
      const fitHeight = fitWidth / sourceAspect;
      frame = { left: (width - fitWidth) / 2, top: (height - fitHeight) / 2, width: fitWidth, height: fitHeight };
      camera.aspect = sourceAspect;
    } else {
      frame = { left: 0, top: 0, width, height };
      camera.aspect = width / height;
    }
    camera.updateProjectionMatrix();
    renderer.setSize(frame.width, frame.height);
    canvas.style.marginLeft = framing ? `${frame.left}px` : '';
    canvas.style.marginTop = framing ? `${frame.top}px` : '';
    draw();
  };
  const observer = new ResizeObserver(resize);
  releases.push(() => observer.disconnect());
  observer.observe(viewport);
  look(composition ? [0, 0, 5] : [0, 0, 0]);

  // A face-anchor preview draws the photographed side as an arrow and a line to
  // the target point, so a person can check the relation before applying.
  let guide = null;
  let arrangement = null;
  const clearGuide = () => {
    if (!guide) return;
    objects.scene.remove(guide.group);
    guide.arrow.dispose();
    for (const line of [guide.line, guide.drop]) {
      line.geometry.dispose();
      line.material.dispose();
    }
    guide.marker.geometry.dispose();
    guide.marker.material.dispose();
    guide = null;
  };
  releases.push(clearGuide);

  return {
    setInteractive: explore,
    isInteractive: () => interactive,
    // Photo framing on or off. Changes only the canvas size, its centring
    // offsets and the projection aspect; never the camera, controls, geometry,
    // transforms, texture or field of view.
    setPhotoFraming(on) {
      if (composition) return false;
      framing = Boolean(on);
      resize();
    },
    originalView: () => composition ? false : look([0, 0, 0]),
    showGuide(transform, point, targetId = null) {
      clearGuide();
      if (!transform || !point) {
        draw();
        return null;
      }
      const pivot = twoObjects ? objects.objects.find((object) => object.id === targetId)?.pivot : objects.pivot;
      if (!pivot) {
        draw();
        return null;
      }
      const centre = composition ? [...transform.position] : pivot.map((value, axis) => value + transform.offset[axis]);
      const target = composition ? (typeof point === 'string' ? arrangement?.objects.find((object) => object.id === point)?.position : point) : photoScene.surfacePoint(surface, point);
      const relation = composition ? compositionFacingGuide(transform, target) : photoScene.facingGuide(centre, transform.yaw, target);
      if (!relation.direction) return null;
      const group = new THREE.Group();
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(...relation.direction), new THREE.Vector3(...centre), 0.6, 0xffd400, 0.15, 0.08);
      // The level line is what the turn can face; the drop line joins it to
      // the marked point straight above or below.
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...centre), new THREE.Vector3(...relation.level)]),
        new THREE.LineBasicMaterial({ color: 0x3fa9ff, depthTest: false }),
      );
      const drop = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...relation.level), new THREE.Vector3(...target)]),
        new THREE.LineBasicMaterial({ color: 0xbbbbbb, depthTest: false }),
      );
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: 0x3fa9ff, depthTest: false }));
      marker.position.set(...target);
      group.add(arrow, line, drop, marker);
      objects.scene.add(group);
      guide = { group, arrow, line, drop, marker };
      draw();
      return relation;
    },
    sideView: () => look(composition ? [4, 2, 5] : [1.6, 0.25, -0.4]),
    // The camera as two finite vectors, for snapshots that must restore the
    // exact view later.
    getCamera: () => ({ position: camera.position.toArray(), target: controls.target.toArray() }),
    // Where each object's visible centre appears on screen now, in viewport
    // pixels, for text labels drawn over the canvas. Two-object surfaces only.
    projectCentres() {
      if (!twoObjects) return [];
      const { left, top, width, height } = framing && frame ? frame : { left: 0, top: 0, width: viewport.clientWidth, height: viewport.clientHeight };
      return objects.objects.map(({ id, pivot }) => {
        const transform = arrangement?.objects.find((object) => object.id === id);
        const offset = transform?.offset ?? [0, 0, 0];
        const centre = composition && transform ? transform.position : pivot.map((n, i) => n + offset[i]);
        const point = new THREE.Vector3(...centre).project(camera);
        return { id, x: left + ((point.x + 1) / 2) * width, y: top + ((1 - point.y) / 2) * height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 };
      });
    },
    // Moves the camera to the photographed side of one object as drawn with
    // `transform`; changes nothing else. False when there is no such object or
    // the vantage is outside the limits, and the camera stays where it was.
    viewPhotographedSide(transform, targetId = null) {
      const selected = twoObjects ? objects.objects.find((object) => object.id === targetId) : null;
      const pivot = composition ? selected?.sourcePivot : twoObjects ? selected?.pivot : objects.pivot;
      const view = pivot && transform ? photographedSideCamera(pivot, transform) : null;
      if (!view) return false;
      camera.position.set(...view.position);
      controls.target.set(...view.target);
      controls.update();
      draw();
      return true;
    },
    setCamera({ position, target }) {
      if (composition) { camera.fov = 55; camera.updateProjectionMatrix(); }
      camera.position.set(...position);
      controls.target.set(...target);
      controls.update();
      draw();
    },
    applyEdit(edit) {
      objects.applyEdit(edit);
      draw();
    },
    // Two-object surfaces: shows a whole arrangement, both objects at once.
    applyArrangement(edit) {
      arrangement = edit;
      objects.applyArrangement(edit);
      draw();
    },
    dispose: release,
  };
}

const EXPLORE_STATUS = {
  page: 'Scroll here to move the page. Choose Explore in 3D to look around the scene.',
  explore: 'Exploring: drag to look around, scroll or pinch to zoom, arrow keys move the view. Choose Explore in 3D again to return to page scrolling.',
};

// The one control that switches a viewer between page scrolling and exploring:
// a toggle button with a stable label whose pressed state says which is on.
// attach(viewer) after the viewer exists; attach(null) when there is no 3D view.
export function createExploreToggle() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = 'Explore in 3D';
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  let viewer = null;
  const render = () => {
    const exploring = Boolean(viewer?.isInteractive());
    button.setAttribute('aria-pressed', String(exploring));
    button.disabled = !viewer;
    status.textContent = viewer ? EXPLORE_STATUS[exploring ? 'explore' : 'page'] : '';
  };
  button.addEventListener('click', () => {
    if (!viewer) return;
    viewer.setInteractive(!viewer.isInteractive());
    render();
  });
  render();
  return {
    button,
    status,
    attach(next) {
      viewer = next;
      render();
    },
  };
}
