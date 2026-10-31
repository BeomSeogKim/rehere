// The actual photo-surface viewer, shared by the owner's scene editor and the
// read-only visitor screen. It renders with Three.js from the local vendor
// copy and releases every allocation on dispose or on a failed setup.

import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { createSceneObjects, facingGuide, surfacePoint } from './photo-scene.js';

// Camera limits the viewer itself enforces; a saved camera must stay within them.
export const CAMERA_LIMITS = Object.freeze({ coordinate: 50, minDistance: 0.5, maxDistance: 8 });

// Renders the photo as a WebGL scene. Throws when the browser cannot create a
// WebGL context or the texture cannot load, so the caller can say so instead
// of showing a blank or untextured scene as if it had worked.
// Every allocation registers its release as soon as it exists, so a failure at
// any later step frees what was already created.
export async function createViewer(viewport, surface, textureUrl, label) {
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
    return await setUpViewer(viewport, surface, textureUrl, label, releases, release);
  } catch (error) {
    release();
    throw error;
  }
}

async function setUpViewer(viewport, surface, textureUrl, label, releases, release) {
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
  let texture;
  try {
    texture = await new THREE.TextureLoader().loadAsync(textureUrl);
  } catch {
    throw new Error('texture');
  }
  releases.push(() => texture.dispose());
  texture.colorSpace = THREE.SRGBColorSpace;
  const objects = createSceneObjects(THREE, surface, texture);
  releases.push(() => {
    for (const mesh of [objects.background, objects.foreground]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  objects.scene.background = new THREE.Color(0x161b20);

  const camera = new THREE.PerspectiveCamera(objects.verticalFovDegrees, 1, 0.01, 50);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
  viewport.append(canvas);

  const controls = new OrbitControls(camera, canvas);
  releases.push(() => controls.dispose());
  controls.minDistance = CAMERA_LIMITS.minDistance;
  controls.maxDistance = CAMERA_LIMITS.maxDistance;
  controls.listenToKeyEvents(canvas);
  const draw = () => renderer.render(objects.scene, camera);
  controls.addEventListener('change', draw);

  // The photo was taken from the origin looking down -z; the target sits inside
  // the pseudo-depth range so orbiting turns around the photographed surfaces.
  const look = (position) => {
    camera.position.set(...position);
    controls.target.set(0, 0, -3);
    controls.update();
    draw();
  };
  const resize = () => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    draw();
  };
  const observer = new ResizeObserver(resize);
  releases.push(() => observer.disconnect());
  observer.observe(viewport);
  look([0, 0, 0]);

  // A face-anchor preview draws the photographed side as an arrow and a line to
  // the target point, so a person can check the relation before applying.
  let guide = null;
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
    originalView: () => look([0, 0, 0]),
    showGuide(transform, point) {
      clearGuide();
      if (!transform || !point) {
        draw();
        return null;
      }
      const centre = objects.pivot.map((value, axis) => value + transform.offset[axis]);
      const target = surfacePoint(surface, point);
      const relation = facingGuide(centre, transform.yaw, target);
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
    sideView: () => look([1.6, 0.25, -0.4]),
    // The camera as two finite vectors, for snapshots that must restore the
    // exact view later.
    getCamera: () => ({ position: camera.position.toArray(), target: controls.target.toArray() }),
    setCamera({ position, target }) {
      camera.position.set(...position);
      controls.target.set(...target);
      controls.update();
      draw();
    },
    applyEdit(edit) {
      objects.applyEdit(edit);
      draw();
    },
    dispose: release,
  };
}
