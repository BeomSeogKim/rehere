import { validateSurface } from './photo-scene.js';
import { createExploreToggle, createViewer } from './scene-viewer.js';

// One object's correction: the other object's cells are never paintable.
export function createOutlineSession(surface) {
  validateSurface(surface);
  if (surface.schema_version !== 2) throw new Error('Two objects are required.');
  const original = [...surface.regions];
  let regions = [...original];
  let target = 1;
  let stroke = null;
  const history = [];
  const dirty = () => regions.some((value, index) => value !== original[index]);
  return {
    get regions() { return [...regions]; },
    get targetId() { return surface.objects[target - 1].id; },
    get target() { return target; },
    get dirty() { return dirty(); },
    get painting() { return stroke !== null; },
    get canUndo() { return history.length > 0; },
    choose(value) {
      if (stroke || dirty() || ![1, 2].includes(value)) return false;
      if (target !== value) history.length = 0;
      target = value;
      return true;
    },
    begin() { if (!stroke) stroke = new Map(); },
    paint(x, y, mode, radius = 0) {
      if (!stroke) return;
      for (let row = Math.max(0, y - radius); row <= Math.min(surface.height - 1, y + radius); row += 1) {
        for (let col = Math.max(0, x - radius); col <= Math.min(surface.width - 1, x + radius); col += 1) {
          const index = row * surface.width + col;
          const value = regions[index];
          const next = mode === 'add' && (value === 0 || value === -1) ? target : mode === 'remove' && value === target ? (original[index] === -1 ? -1 : 0) : value;
          if (next !== value) {
            if (!stroke.has(index)) stroke.set(index, value);
            regions[index] = next;
          }
        }
      }
    },
    end(cancel = false) {
      if (!stroke) return;
      if (cancel) for (const [index, value] of stroke) regions[index] = value;
      else if (stroke.size) history.push(stroke);
      stroke = null;
    },
    undo() {
      if (stroke) return;
      for (const [index, value] of history.pop() ?? []) regions[index] = value;
    },
    reset() {
      if (stroke) return;
      regions = [...original];
      history.length = 0;
    },
  };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function mountOutlineEditor(container, { job, surface, textureUrl, jobUrl, post, onSaved, onCancel }) {
  const session = createOutlineSession(surface);
  const heading = el('h3', { textContent: 'Correct one object outline', tabIndex: -1 });
  const sourceSurfaceSha256 = job.derivedAssets?.find((asset) => asset.name === 'surface.json')?.sha256;
  let disposed = false;
  let imageReady = false;
  let mode = 'remove';
  let radius = 0;
  let pointerId = null;
  let previous = null;
  let cursor = [0, 0];
  let preview = null;
  let generation = 0;
  let previewing = false;
  let previewFresh = false;
  let originalSeen = false;
  let sideSeen = false;
  let pending = null;
  let saving = false;
  const image = el('img', { src: textureUrl, alt: 'Photo copy used to correct the chosen object outline', draggable: false });
  const overlay = el('canvas', { width: surface.width, height: surface.height });
  overlay.setAttribute('aria-hidden', 'true');
  const marker = el('span', { className: 'outline-cursor' });
  marker.setAttribute('aria-hidden', 'true');
  const frame = el('div', { className: 'outline-photo', tabIndex: 0 }, [image, overlay, marker]);
  frame.setAttribute('role', 'group');
  frame.setAttribute('aria-label', 'Outline painting grid. Arrow keys move one cell; Space paints with the chosen brush.');
  const cutout = el('canvas', { className: 'outline-cutout', width: surface.width, height: surface.height });
  cutout.style.aspectRatio = `${surface.source.image_size[0]} / ${surface.source.image_size[1]}`;
  cutout.setAttribute('role', 'img');
  cutout.setAttribute('aria-label', 'Chosen object cutout at the outline grid precision');
  const mask = el('canvas', { width: surface.width, height: surface.height });
  const [overlayContext, cutoutContext, maskContext] = [overlay, cutout, mask].map((canvas) => canvas.getContext('2d'));
  const canvasReady = Boolean(overlayContext && cutoutContext && maskContext);
  const message = el('p', { className: 'form-message', role: 'status' });
  const position = el('p', { className: 'hint', role: 'status' });
  const viewport = el('div', { className: 'space-viewport', hidden: true });
  const explore = createExploreToggle();
  const original = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect corrected original view', disabled: true });
  const side = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect corrected side view', disabled: true });
  const refresh = el('button', { type: 'button', className: 'secondary', textContent: 'Refresh 3D preview' });
  const confirm = el('input', { type: 'checkbox' });
  const save = el('button', { type: 'button', textContent: 'Save as new scene', disabled: true });
  const undo = el('button', { type: 'button', className: 'secondary', textContent: 'Undo stroke' });
  const reset = el('button', { type: 'button', className: 'secondary', textContent: 'Reset outline' });
  const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Back to scene' });
  const choices = surface.objects.map((object, index) => el('button', { type: 'button', className: 'secondary', textContent: `${index === 0 ? 'A' : 'B'}: ${object.label}` }));
  const modes = ['remove', 'add'].map((value) => el('button', { type: 'button', className: 'secondary', textContent: value === 'remove' ? 'Remove from object' : 'Add to object' }));
  const sizes = [0, 1].map((value) => el('button', { type: 'button', className: 'secondary', textContent: value === 0 ? 'Small brush: 1 cell' : 'Large brush: 3 × 3 cells' }));
  const locked = () => disposed || saving || pending !== null || previewing;
  const editable = () => !locked() && imageReady && canvasReady;
  const releasePreview = () => {
    generation += 1;
    previewing = false;
    preview?.dispose();
    preview = null;
    previewFresh = false;
    originalSeen = false;
    sideSeen = false;
    confirm.checked = false;
    viewport.hidden = true;
    explore.attach(null);
  };
  function render() {
    const regions = session.regions;
    if (canvasReady) {
      overlayContext.clearRect(0, 0, surface.width, surface.height);
      maskContext.clearRect(0, 0, surface.width, surface.height);
      for (let index = 0; index < regions.length; index += 1) {
        const value = regions[index];
        const [x, y] = [index % surface.width, Math.floor(index / surface.width)];
        if (value !== 0) {
          overlayContext.fillStyle = value === 1 ? 'rgba(34,147,255,0.5)' : value === 2 ? 'rgba(255,166,37,0.5)' : 'rgba(255,255,255,0.85)';
          overlayContext.fillRect(x, y, 1, 1);
        }
        if (value === session.target) {
          maskContext.fillStyle = '#fff';
          maskContext.fillRect(x, y, 1, 1);
        }
      }
      cutoutContext.clearRect(0, 0, surface.width, surface.height);
      if (imageReady) {
        cutoutContext.globalCompositeOperation = 'source-over';
        cutoutContext.drawImage(image, 0, 0, surface.width, surface.height);
        cutoutContext.globalCompositeOperation = 'destination-in';
        cutoutContext.drawImage(mask, 0, 0);
        cutoutContext.globalCompositeOperation = 'source-over';
      }
    }
    const [left, top] = [Math.max(0, cursor[0] - radius), Math.max(0, cursor[1] - radius)];
    marker.style.left = `${(left / surface.width) * 100}%`;
    marker.style.top = `${(top / surface.height) * 100}%`;
    marker.style.width = `${((Math.min(surface.width - 1, cursor[0] + radius) - left + 1) / surface.width) * 100}%`;
    marker.style.height = `${((Math.min(surface.height - 1, cursor[1] + radius) - top + 1) / surface.height) * 100}%`;
    position.textContent = `Grid cell ${cursor[0] + 1}, ${cursor[1] + 1} of ${surface.width} × ${surface.height}. ${session.dirty ? 'Undo or reset before choosing the other object.' : 'Choose one object to correct.'}`;
    choices.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(index + 1 === session.target));
      button.disabled = locked() || session.painting || (session.dirty && index + 1 !== session.target);
    });
    modes.forEach((button, index) => { button.disabled = locked() || session.painting; button.setAttribute('aria-pressed', String(mode === ['remove', 'add'][index])); });
    sizes.forEach((button, index) => { button.disabled = locked() || session.painting; button.setAttribute('aria-pressed', String(radius === index)); });
    undo.disabled = locked() || session.painting || !session.canUndo;
    reset.disabled = locked() || session.painting || !session.dirty;
    refresh.disabled = !editable() || session.painting || !session.dirty;
    original.disabled = side.disabled = locked() || !previewFresh;
    confirm.disabled = locked() || !previewFresh || !originalSeen || !sideSeen;
    save.disabled = saving || previewing || (!pending && (!editable() || session.painting || !session.dirty || !previewFresh || !originalSeen || !sideSeen || !confirm.checked || !/^[a-f0-9]{64}$/.test(sourceSurfaceSha256 ?? '')));
    save.textContent = pending ? 'Retry saving the same new scene' : 'Save as new scene';
    cancel.textContent = pending ? 'Back to scene (save outcome unknown)' : 'Back to scene';
  }
  function changed() {
    releasePreview();
    message.textContent = session.dirty ? 'Outline changed. Refresh the 3D preview to inspect it before saving.' : 'The saved outline is unchanged. Choose an object to correct.';
    render();
  }
  choices.forEach((button, index) => button.addEventListener('click', () => { if (!locked() && session.choose(index + 1)) render(); }));
  modes.forEach((button, index) => button.addEventListener('click', () => { if (!locked() && !session.painting) { mode = ['remove', 'add'][index]; render(); } }));
  sizes.forEach((button, index) => button.addEventListener('click', () => { if (!locked() && !session.painting) { radius = index; render(); } }));
  undo.addEventListener('click', () => { if (!locked()) { session.undo(); changed(); } });
  reset.addEventListener('click', () => { if (!locked()) { session.reset(); changed(); } });
  image.addEventListener('load', () => {
    if (disposed) return;
    imageReady = true;
    message.textContent = !canvasReady ? 'This browser could not show the painting grid. Nothing can be changed here.' : !/^[a-f0-9]{64}$/.test(sourceSurfaceSha256 ?? '') ? 'The saved outline reference is unavailable. Reload the scene before saving a correction.' : 'Choose an object and paint its outline.';
    render();
  });
  image.addEventListener('error', () => {
    if (disposed) return;
    imageReady = false;
    session.end(true);
    pointerId = null;
    releasePreview();
    message.textContent = 'The source photo could not be loaded. Your outline changes are kept. Reload the scene to try again.';
    render();
  });
  const paint = (point) => {
    const start = previous ?? point;
    const steps = Math.max(Math.abs(point[0] - start[0]), Math.abs(point[1] - start[1]), 1);
    for (let step = 0; step <= steps; step += 1) session.paint(Math.round(start[0] + (point[0] - start[0]) * step / steps), Math.round(start[1] + (point[1] - start[1]) * step / steps), mode, radius);
    previous = point;
    cursor = point;
    render();
  };
  const cellAt = (event) => {
    const rect = image.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    return [Math.max(0, Math.min(surface.width - 1, Math.floor((event.clientX - rect.left) * surface.width / rect.width))), Math.max(0, Math.min(surface.height - 1, Math.floor((event.clientY - rect.top) * surface.height / rect.height)))];
  };
  frame.addEventListener('pointerdown', (event) => {
    if (!editable() || pointerId !== null || event.button !== 0) return;
    const point = cellAt(event);
    if (!point) return;
    event.preventDefault();
    frame.focus();
    frame.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    previous = null;
    session.begin();
    releasePreview();
    paint(point);
  });
  frame.addEventListener('pointermove', (event) => { if (event.pointerId === pointerId) { const point = cellAt(event); if (point) paint(point); } });
  const finish = (event, cancelStroke) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const captured = pointerId;
    pointerId = null;
    previous = null;
    session.end(cancelStroke);
    frame.releasePointerCapture?.(captured);
    changed();
  };
  frame.addEventListener('pointerup', (event) => finish(event, false));
  frame.addEventListener('pointercancel', (event) => finish(event, true));
  frame.addEventListener('lostpointercapture', (event) => finish(event, true));
  frame.addEventListener('keydown', (event) => {
    if (!editable() || session.painting) return;
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (move) {
      event.preventDefault();
      cursor = [Math.max(0, Math.min(surface.width - 1, cursor[0] + move[0])), Math.max(0, Math.min(surface.height - 1, cursor[1] + move[1]))];
      render();
    } else if (event.key === ' ' && !event.repeat) {
      event.preventDefault();
      session.begin();
      session.paint(...cursor, mode, radius);
      session.end();
      changed();
    }
  });
  refresh.addEventListener('click', async () => {
    if (!editable() || !session.dirty || session.painting) return;
    releasePreview();
    const token = generation;
    previewing = true;
    message.textContent = 'Preparing the corrected preview…';
    render();
    let created;
    try {
      created = await createViewer(viewport, { ...surface, regions: session.regions }, textureUrl, 'Corrected outlines at their original positions');
    } catch {
      if (disposed || token !== generation) return;
      previewing = false;
      message.textContent = 'The corrected 3D preview could not be shown. Your painting is kept. Try refreshing the preview again.';
      render();
      return;
    }
    if (disposed || token !== generation) { created.dispose(); return; }
    preview = created;
    previewing = false;
    previewFresh = true;
    viewport.hidden = false;
    explore.attach(preview);
    message.textContent = 'Preview only, with both objects at their original positions. Inspect the original and side views before saving.';
    render();
  });
  original.addEventListener('click', () => { if (!locked() && previewFresh) { preview.originalView(); originalSeen = true; render(); } });
  side.addEventListener('click', () => { if (!locked() && previewFresh) { preview.sideView(); sideSeen = true; render(); } });
  confirm.addEventListener('change', render);
  save.addEventListener('click', async () => {
    if (save.disabled || disposed) return;
    pending ??= { requestId: crypto.randomUUID(), targetId: session.targetId, sourceSurfaceSha256, regions: session.regions, confirmed: true };
    saving = true;
    message.textContent = 'Saving a new scene…';
    render();
    const result = await post(`${jobUrl}/outline-corrections`, pending);
    saving = false;
    const accepted = result.ok && result.body?.status === 'ready' && typeof result.body.id === 'string' && result.body.id !== job.id;
    if (disposed) {
      if (accepted) onSaved(result.body, { late: true });
      return;
    }
    if (result.status === 0 || result.status >= 500 || (result.ok && !accepted)) {
      message.textContent = 'Rehere could not confirm whether the new scene was saved. Painting is paused. Retry saving to repeat exactly the same request. If you leave, check the saved scene list before starting another correction.';
      render();
      return;
    }
    pending = null;
    if (!accepted) {
      message.textContent = typeof result.body?.error === 'string' ? result.body.error : 'The new scene could not be saved. Your painting is kept.';
      render();
      return;
    }
    onSaved(result.body);
  });
  cancel.addEventListener('click', () => { if (!disposed) onCancel({ unknown: pending !== null }); });
  container.replaceChildren(
    heading,
    el('p', { className: 'hint', textContent: `Paint the actual ${surface.width} × ${surface.height} outline grid over the source photo. Blue is A, orange is B, white is empty. Add uses only background or empty cells; Remove leaves original empty areas empty and returns this object’s other cells to the background. The other object stays unchanged.` }),
    el('div', { className: 'actions' }, choices),
    el('div', { className: 'actions' }, modes),
    el('div', { className: 'actions' }, sizes),
    frame, position,
    el('p', { className: 'hint', textContent: 'Keyboard: focus the photo, move the cell cursor with arrow keys, and press Space to paint.' }),
    el('h4', { textContent: 'Chosen object cutout' }), cutout,
    el('div', { className: 'actions' }, [undo, reset, refresh]),
    el('div', { className: 'actions space-camera' }, [explore.button, original, side]), explore.status,
    viewport,
    el('p', { className: 'hint', textContent: 'Only photographed surfaces exist. Holes and unseen areas remain empty. The saved depth is still a model estimate; correcting an outline does not verify depth or history. No model runs again.' }),
    el('label', {}, [confirm, ' I inspected both views and want to save this outline as a new scene at the original positions. The previous scene is kept.']),
    message, el('div', { className: 'actions' }, [cancel, save]),
  );
  if (!/^[a-f0-9]{64}$/.test(sourceSurfaceSha256 ?? '')) message.textContent = 'The saved outline reference is unavailable. Reload the scene before saving a correction.';
  render();
  heading.focus();
  heading.scrollIntoView?.({ block: 'start' });
  return { dispose() {
    disposed = true;
    const captured = pointerId;
    pointerId = null;
    session.end(true);
    if (captured !== null) frame.releasePointerCapture?.(captured);
    releasePreview();
  } };
}
