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
const PHOTO_ORBIT_ANGLE = Math.acos(Math.sqrt(Math.cos(Math.PI / 18)));
const PHOTO_TARGET = [0, 0, -3];

export function originalPhotoCamera(camera) {
  return Array.isArray(camera?.position) && camera.position.length === 3 && camera.position.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e-12)
    && Array.isArray(camera?.target) && camera.target.length === 3 && camera.target.every((n, i) => Number.isFinite(n) && Math.abs(n - PHOTO_TARGET[i]) <= 1e-12);
}

export function cameraWithinPhotoOrbit(camera) {
  if (!camera || !cameraWithinLimits(camera) || !camera.target.every((n, i) => n === PHOTO_TARGET[i])) return false;
  const [x, y, z] = camera.position.map((n, i) => n - PHOTO_TARGET[i]);
  return Math.abs(Math.hypot(x, y, z) - 3) < 1e-8
    && Math.abs(Math.atan2(x, z)) <= PHOTO_ORBIT_ANGLE + 1e-8
    && Math.abs(Math.atan2(y, Math.hypot(x, z))) <= PHOTO_ORBIT_ANGLE + 1e-8;
}

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
export async function createViewer(viewport, surface, textureUrl, label, { onDraw = null, fullObject = null, limitedPhotoView = false } = {}) {
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
    return await setUpViewer(viewport, surface, textureUrl, label, releases, release, onDraw, () => released, fullObject, limitedPhotoView);
  } catch (error) {
    release();
    throw error;
  }
}

async function setUpViewer(viewport, surface, textureUrl, label, releases, release, onDraw, isReleased, fullObject, limitedPhotoView) {
  let renderer;
  try {
    // A full object clears to transparent, so a CSS hatch behind the canvas
    // marks pixels the scene does not draw; other scenes stay opaque.
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: Boolean(fullObject) });
  } catch {
    throw new Error('webgl');
  }
  releases.push(() => {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  });
  const composition = surface?.schema_version === 3;
  const photoOrbit = Boolean(limitedPhotoView) && !composition;
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
  if (twoObjects && fullObject) throw new Error('unsupported');
  let objects;
  let modelMeshes = [];
  let outlineMaskBlob = null;
  let unknownMask = null;
  if (fullObject) {
    const read = async (url, expected, maximum) => {
      if (typeof url !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('full-object');
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('full-object');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > maximum) throw new Error('full-object');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      if (actual !== expected || isReleased()) throw new Error('full-object');
      return bytes;
    };
    const [maskBytes, glbBytes] = await Promise.all([
      read(fullObject.maskUrl, fullObject.outlineSha256, 32 * 1024 * 1024),
      read(fullObject.assetUrl, fullObject.sha256, 128 * 1024 * 1024),
    ]);
    // The outline is decoded from its exact stored bytes, never through the
    // browser's colour-managed image path.
    const [width, height] = surface.source.image_size;
    if (width * height > 32_000_000) throw new Error('full-object');
    const { readBinaryMask } = await import('./object-outline-editor.js');
    let mask;
    try { mask = { width, height, data: await readBinaryMask(maskBytes, width, height) }; } catch { throw new Error('full-object'); }
    if (isReleased()) throw new Error('full-object');
    outlineMaskBlob = new Blob([maskBytes], { type: 'image/png' });
    unknownMask = mask;
    releases.push(() => { outlineMaskBlob = null; unknownMask = null; });
    const { GLTFLoader } = await import('/vendor/loaders/GLTFLoader.js');
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(() => { throw new Error('full-object'); });
    let model;
    try { model = (await new GLTFLoader(manager).parseAsync(glbBytes, '')).scene; } catch { throw new Error('full-object'); }
    model.traverse((item) => { if (item.isMesh) modelMeshes.push(item); });
    releases.push(() => {
      for (const mesh of modelMeshes) {
        mesh.geometry.dispose();
        for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) material?.dispose();
      }
    });
    if (modelMeshes.length !== 1 || !modelMeshes[0].geometry.getAttribute('color') || isReleased()) throw new Error('full-object');
    for (const mesh of modelMeshes) {
      for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) material?.dispose();
      mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    }
    objects = photoScene.createFullObjectSceneObjects(THREE, surface, texture, model, fullObject.initial, mask);
  } else {
    objects = twoObjects ? photoScene.createObjectSceneObjects(THREE, surface, texture) : photoScene.createSceneObjects(THREE, surface, texture);
  }
  const meshes = (fullObject ? [objects.background, ...modelMeshes] : twoObjects ? [objects.background, ...objects.objects.map((object) => object.mesh)] : [objects.background, objects.foreground]).filter(Boolean);
  releases.push(() => {
    for (const mesh of (fullObject ? [objects.background] : meshes)) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  objects.scene.background = fullObject ? null : new THREE.Color(0x161b20);

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
  canvas.classList.toggle('full-object-unknown', Boolean(fullObject));
  viewport.append(canvas);

  const controls = new OrbitControls(camera, canvas);
  releases.push(() => controls.dispose());
  controls.minDistance = CAMERA_LIMITS.minDistance;
  controls.maxDistance = CAMERA_LIMITS.maxDistance;
  if (photoOrbit) {
    // Each axis stays inside a rectangle whose corners lie on the 10-degree
    // cone. Locking the radius also prevents dolly into the partial surfaces.
    controls.minAzimuthAngle = -PHOTO_ORBIT_ANGLE;
    controls.maxAzimuthAngle = PHOTO_ORBIT_ANGLE;
    controls.minPolarAngle = Math.PI / 2 - PHOTO_ORBIT_ANGLE;
    controls.maxPolarAngle = Math.PI / 2 + PHOTO_ORBIT_ANGLE;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.zoomToCursor = false;
    controls.minDistance = 3;
    controls.maxDistance = 3;
  }
  controls.listenToKeyEvents(canvas);
  // Page scrolling by default: until the person chooses to explore, the
  // controls ignore pointer, wheel and keys, touch scrolls the page, and the
  // canvas is not a tab stop. Changing the mode never moves the camera. Only
  // the explicit choice to explore moves focus, to the canvas, so arrow keys
  // work at once. A temporary view can restore the mode without moving focus.
  let interactive = false;
  const setInteractive = (on) => {
    interactive = Boolean(on);
    controls.enabled = interactive;
    canvas.style.touchAction = interactive ? 'none' : 'auto';
    canvas.tabIndex = interactive ? 0 : -1;
  };
  setInteractive(false);
  const explore = (on, { focus = true } = {}) => {
    setInteractive(on);
    if (interactive && focus) canvas.focus();
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
  let context = null;
  let onContext = null;
  let drawHatch = () => {};
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
    if (context) {
      try { drawHatch(); } catch { leaveContext(); onContext?.(false); }
    }
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

  // Inspecting a full object hides the room and orbits the estimated object
  // alone. Everything it changes is recorded first and restored exactly on
  // leaving, and any other camera or mode call leaves it first, so no saved
  // view, share or comparison ever sees the inspector's camera.
  let inspection = null;
  let onInspection = null;
  const inspectObject = (on, reason = null) => {
    if (!fullObject || photoOrbit || isReleased()) return false;
    if (Boolean(on) === Boolean(inspection)) return true;
    if (on) {
      leaveContext();
      inspection = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), fov: camera.fov, zoom: camera.zoom, near: camera.near, far: camera.far, target: controls.target.clone(), framing, interactive };
      objects.background.visible = false;
      canvas.classList.toggle('full-object-unknown', false);
      framing = false;
      resize();
      objects.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(objects.foreground);
      const centre = box.getCenter(new THREE.Vector3());
      // Fit the bounding sphere to the narrower of the two half-angles (zoom
      // included), so a portrait viewport does not clip the object.
      const vertical = (camera.getEffectiveFOV() * Math.PI) / 360;
      const half = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
      const fit = (box.getSize(new THREE.Vector3()).length() / 2 / Math.sin(half)) * 1.1;
      const distance = Math.min(CAMERA_LIMITS.maxDistance, Math.max(CAMERA_LIMITS.minDistance, fit));
      // Open along the current view's ray to the object, so the first view keeps
      // the side and elevation already shown; only a camera exactly at the
      // object's centre falls back to the orbit target's direction.
      const ray = camera.position.clone().sub(centre);
      const direction = (ray.lengthSq() > 0 ? ray : camera.position.clone().sub(controls.target)).normalize();
      controls.target.copy(centre);
      camera.position.copy(centre).addScaledVector(direction, distance);
      controls.update();
      explore(true);
    } else {
      const saved = inspection;
      inspection = null;
      objects.background.visible = true;
      canvas.classList.toggle('full-object-unknown', true);
      camera.up.copy(saved.up);
      camera.fov = saved.fov;
      camera.zoom = saved.zoom;
      // Near and far are restored too; the adaptive clipping at the next draw
      // recomputes them from this same camera and scene, as it always does.
      camera.near = saved.near;
      camera.far = saved.far;
      camera.position.copy(saved.position);
      camera.quaternion.copy(saved.quaternion);
      controls.target.copy(saved.target);
      framing = saved.framing;
      resize();
      explore(saved.interactive, { focus: false });
    }
    draw();
    onInspection?.(Boolean(inspection), reason);
    return true;
  };
  const leaveInspection = () => { if (inspection) inspectObject(false); };
  // Escape on the canvas leaves inspection; the toggle then takes focus back.
  const escape = (event) => {
    if (event.key !== 'Escape' || !inspection) return;
    event.preventDefault();
    inspectObject(false, 'escape');
  };
  canvas.addEventListener('keydown', escape);
  releases.push(() => canvas.removeEventListener('keydown', escape));

  // Photo context, for a comparison only: the room estimate writes depth but
  // no colour, so the photo copy shown behind the transparent canvas stays
  // as it is, and a hatch drawn from the verified outline covers what the
  // object hid in the photo. Everything changed is restored exactly on leaving.
  drawHatch = () => {
    const hatch = context.hatch, scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(frame.width * scale)), height = Math.max(1, Math.round(frame.height * scale));
    Object.assign(hatch.style, { position: 'absolute', left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px`, pointerEvents: 'none' });
    hatch.width = width;
    hatch.height = height;
    const g = hatch.getContext('2d');
    if (!g) throw new Error('hatch');
    const image = g.createImageData(width, height), { width: mw, height: mh, data } = unknownMask;
    for (let y = 0; y < height; y += 1) {
      const row = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / height)) * mw;
      for (let x = 0; x < width; x += 1) {
        if (!data[row + Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / width))]) continue;
        const shade = Math.floor((x + y) / scale) % 10 < 2 ? 42 : 0, i = (y * width + x) * 4;
        image.data[i] = 22 + shade; image.data[i + 1] = 27 + shade; image.data[i + 2] = 32 + shade; image.data[i + 3] = 255;
      }
    }
    g.putImageData(image, 0, 0);
  };
  const leaveContext = () => {
    if (!context) return;
    const saved = context;
    context = null;
    saved.hatch.remove();
    objects.background.material.colorWrite = saved.colorWrite;
    objects.background.renderOrder = saved.renderOrder;
    canvas.classList.toggle('photo-context', false);
    canvas.classList.toggle('full-object-unknown', saved.unknownClass);
    draw();
  };
  releases.push(leaveContext);
  const setPhotoContext = (on) => {
    if (!on) { leaveContext(); return true; }
    if (!fullObject || !unknownMask || !framing || inspection || isReleased()) return false;
    if (context) return true;
    context = { hatch: document.createElement('canvas'), colorWrite: objects.background.material.colorWrite, renderOrder: objects.background.renderOrder, unknownClass: canvas.classList.contains('full-object-unknown') };
    try {
      drawHatch();
    } catch {
      context.hatch.remove();
      context = null;
      return false;
    }
    viewport.insertBefore(context.hatch, canvas);
    objects.background.material.colorWrite = false;
    objects.background.renderOrder = -1;
    canvas.classList.toggle('full-object-unknown', false);
    canvas.classList.toggle('photo-context', true);
    draw();
    return true;
  };

  return {
    limitedPhotoView: photoOrbit,
    setInteractive: (on, options) => { leaveInspection(); if (on) leaveContext(); explore(on, options); },
    // Like getCamera, reports the scene's own mode while inspecting, so a caller
    // that records it (a comparison) restores page scrolling, not the inspector's orbit.
    isInteractive: () => (inspection ? inspection.interactive : interactive),
    canInspectObject: Boolean(fullObject) && !photoOrbit,
    setPhotoContext,
    setContextListener: (listener) => { onContext = listener; },
    inspectObject,
    isInspecting: () => Boolean(inspection),
    setInspectionListener: (listener) => { onInspection = listener; },
    outlineMaskBlob: () => isReleased() ? null : outlineMaskBlob,
    // Photo framing on or off. Changes only the canvas size, its centring
    // offsets and the projection aspect; never the camera, controls, geometry,
    // transforms, texture or field of view.
    setPhotoFraming(on) {
      leaveInspection();
      if (!on) leaveContext();
      if (composition) return false;
      framing = Boolean(on);
      resize();
    },
    originalView: () => { leaveInspection(); return composition ? false : look([0, 0, 0]); },
    showGuide(transform, point, targetId = null) {
      leaveInspection();
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
    sideView: () => { if (photoOrbit) return false; leaveInspection(); leaveContext(); return look(composition ? [4, 2, 5] : [1.6, 0.25, -0.4]); },
    // The camera as two finite vectors, for snapshots that must restore the
    // exact view later.
    getCamera: () => (inspection
      ? { position: inspection.position.toArray(), target: inspection.target.toArray() }
      : { position: camera.position.toArray(), target: controls.target.toArray() }),
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
      if (photoOrbit) return false;
      leaveInspection();
      const selected = twoObjects ? objects.objects.find((object) => object.id === targetId) : null;
      const pivot = composition ? selected?.sourcePivot : twoObjects ? selected?.pivot : objects.pivot;
      const view = pivot && transform ? photographedSideCamera(pivot, transform) : null;
      if (!view) return false;
      leaveContext();
      camera.position.set(...view.position);
      controls.target.set(...view.target);
      controls.update();
      draw();
      return true;
    },
    setCamera({ position, target }) {
      leaveInspection();
      leaveContext();
      if (composition) { camera.fov = 55; camera.updateProjectionMatrix(); }
      const allowed = !photoOrbit || cameraWithinPhotoOrbit({ position, target });
      if (!allowed) { position = [0, 0, 0]; target = [...PHOTO_TARGET]; }
      camera.position.set(...position);
      controls.target.set(...target);
      controls.update();
      draw();
      return allowed;
    },
    applyEdit(edit) {
      leaveInspection();
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

const INSPECT_NOTE = 'Showing only the generated object, without the room. Shape, hidden sides and colour are estimates. Its front is not known. Press Escape to return to the scene.';

// A toggle for viewing a full object's estimate alone. attach(viewer) after the
// viewer exists; it stays hidden for scenes without a full object.
// onChange runs whenever inspection starts or ends, for controls that depend on it.
export function createInspectToggle({ onChange = null } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = 'Inspect estimated object';
  const note = document.createElement('p');
  note.className = 'hint';
  note.setAttribute('role', 'status');
  let viewer = null;
  let supported = false;
  const render = () => {
    const inspecting = Boolean(viewer?.isInspecting?.());
    button.hidden = !supported;
    button.disabled = !viewer;
    button.setAttribute('aria-pressed', String(inspecting));
    note.textContent = inspecting ? INSPECT_NOTE : '';
    note.hidden = !inspecting;
  };
  button.addEventListener('click', () => {
    if (viewer) viewer.inspectObject(!viewer.isInspecting());
  });
  render();
  return {
    button,
    note,
    attach(next) {
      viewer?.setInspectionListener?.(null);
      viewer = next;
      // Detaching (for example during a comparison) disables the button; only a
      // viewer without a full object hides it.
      if (next) supported = Boolean(next.canInspectObject);
      viewer?.setInspectionListener?.((inspecting, reason) => { render(); onChange?.(); if (reason === 'escape') button.focus(); });
      render();
    },
  };
}

const EXPLORE_STATUS = {
  page: 'Scroll here to move the page. Choose Explore in 3D to look around the scene.',
  explore: 'Exploring: drag to look around, scroll or pinch to zoom, arrow keys move the view. Choose Explore in 3D again to return to page scrolling.',
};
const LIMITED_EXPLORE_STATUS = {
  page: 'Scroll here to move the page. Choose Explore in 3D for limited rotation near the photo viewpoint.',
  explore: 'Exploring: drag to rotate within the limited photo view. Panning and zoom are off. Choose Explore in 3D again to return to page scrolling.',
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
    status.textContent = viewer ? (viewer.limitedPhotoView ? LIMITED_EXPLORE_STATUS : EXPLORE_STATUS)[exploring ? 'explore' : 'page'] : '';
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
