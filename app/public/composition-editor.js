import { validateSurface } from './photo-scene.js';
import { COMPOSITION_REPRESENTATION, copyPose, eulerFromQuaternion, poseProblem, quaternionFromEuler } from './composition-scene.js';

export const COMPOSITION_NOTE = 'Two photographed surfaces, placed by the owner. Position, orientation and relative scale are assumptions, not measurements or automatic photo alignment. Each photo’s depth remains a model estimate. Unseen areas stay empty.';
export const poseAxes = [
  ['Position X', -10, 10, 0.01], ['Position Y', -10, 10, 0.01], ['Position Z', -10, 10, 0.01],
  ['Tilt X (degrees)', -180, 180, 1], ['Turn Y (degrees)', -180, 180, 1], ['Roll Z (degrees)', -180, 180, 1],
  ['Assumed relative scale', 0.05, 5, 0.01],
];
export const poseValues = (pose) => [...pose.position, ...eulerFromQuaternion(pose.quaternion).map((n) => n * 180 / Math.PI), pose.scale];
export function poseWithAxis(pose, index, raw) {
  const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  const result = copyPose(pose);
  if (index < 3) result.position[index] = value;
  else if (index === 6) result.scale = value;
  else {
    if (!Number.isFinite(value) || Math.abs(value) > 180) return null;
    const angles = eulerFromQuaternion(pose.quaternion);
    angles[index - 3] = value * Math.PI / 180;
    result.quaternion = quaternionFromEuler(angles);
  }
  return result;
}
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// Creation feeds the ordinary scene workspace once saved; it never publishes
// a placeholder scene, copies old claims, or changes a selected parent scene.
export function mountCompositionEditor(container, { base, sourceFor, request, post, createGate, createViewer, createExploreToggle, onSaved, onCancel }) {
  let disposed = false;
  let generation = 0;
  let preview = null;
  let gate = null;
  let saving = false;
  let preparing = false;
  let pending = null;
  let uncertain = false;
  let candidates = [];
  let previewInput = null;
  let lastHold = null;
  const selected = [null, null];
  const poses = [-1, 1].map((x) => ({ position: [x, 0, -3], quaternion: [0, 0, 0, 1], scale: 1 }));
  const heading = el('h3', { textContent: 'Compose objects from two photos', tabIndex: -1 });
  const message = el('p', { className: 'form-message', role: 'status' });
  const contextNote = el('p', { className: 'hint' });
  const viewport = el('div', { className: 'space-viewport', hidden: true });
  const explore = createExploreToggle();
  const confirm = el('input', { type: 'checkbox' });
  const keep = el('input', { type: 'checkbox', checked: true });
  const crop = el('input', { type: 'checkbox' });
  const bounds = [0, 1, 2, 3].map(() => el('input', { type: 'number', step: 1, min: 0, value: '' }));
  const refresh = el('button', { type: 'button', className: 'secondary', textContent: 'Preview the composition' });
  const save = el('button', { type: 'button', textContent: 'Save this composition', disabled: true });
  const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Cancel' });
  const entries = ['A', 'B'].map((letter, index) => {
    const select = el('select');
    select.setAttribute('aria-label', `Source object ${letter}`);
    const name = el('input', { type: 'text', maxLength: 80 });
    name.setAttribute('aria-label', `Name object ${letter}`);
    const inputs = poseAxes.map(([label, min, max, step], axis) => {
      const input = el('input', { type: 'number', min, max, step, value: String(poseValues(poses[index])[axis]) });
      input.setAttribute('aria-label', `${letter} ${label}`);
      input.addEventListener('input', invalidate);
      return input;
    });
    const evidence = el('div');
    select.addEventListener('change', () => choose(index, select.value));
    name.addEventListener('input', invalidate);
    return { select, name, inputs, evidence, section: el('fieldset', { className: 'space-edit' }, [
      el('legend', { textContent: `Object ${letter}` }), select, el('label', {}, ['Name ', name]), evidence,
      ...inputs.map((input, axis) => el('label', { className: 'space-axis' }, [poseAxes[axis][0], input])),
    ]) };
  });
  const fields = [keep, crop, ...bounds, ...entries.flatMap((entry) => [entry.select, entry.name, ...entry.inputs])];
  const current = () => !disposed;
  const disposePreview = () => {
    generation += 1;
    preview?.dispose(); preview = null; gate = null; previewInput = null;
    explore.attach(null); viewport.hidden = true; confirm.checked = false; contextNote.textContent = ''; lastHold = null;
  };
  function invalidate() {
    if (pending || saving) return;
    disposePreview();
    render();
  }
  const readPose = (entry, index) => {
    let pose = copyPose(poses[index]);
    for (let axis = 0; axis < 7; axis += 1) {
      const next = poseWithAxis(pose, axis, entry.inputs[axis].value);
      if (!next || poseProblem(next)) return null;
      pose = next;
    }
    return pose;
  };
  function input() {
    const objects = entries.map((entry, index) => ({ label: entry.name.value.trim(), component: selected[index]?.ref, pose: readPose(entry, index) }));
    if (objects.some((object) => !object.component || !object.label || !object.pose)) return { error: 'Choose both source objects, name them, and enter a valid position, orientation and relative scale.' };
    if (selected[0].sourceId === selected[1].sourceId) return { error: 'Choose objects from two different photos of this place.' };
    if (objects[0].label.toLowerCase() === objects[1].label.toLowerCase()) return { error: 'Give A and B distinct names.' };
    const rectangle = keep.checked && crop.checked ? bounds.map((field) => field.value.trim() === '' ? NaN : Number(field.value)) : null;
    const [width, height] = selected[0].surface.source.image_size;
    if (rectangle && (!rectangle.every(Number.isInteger) || rectangle[0] < 0 || rectangle[1] < 0 || rectangle[2] > width || rectangle[3] > height || rectangle[2] <= rectangle[0] || rectangle[3] <= rectangle[1])) return { error: 'Enter a background rectangle inside the first photo, with right and bottom greater than left and top.' };
    return { body: { kind: 'two-photo-composition', objects, context: { keep: keep.checked === true, bounds: rectangle }, confirmed: true, scaleBasis: 'owner-assumed-relative' } };
  }
  function render() {
    if (disposed) return;
    const locked = saving || pending !== null || preparing;
    fields.forEach((field) => { field.disabled = locked; });
    confirm.disabled = locked || !preview;
    const held = previewInput && gate ? gate.problem(previewInput.arrangement) : null;
    save.disabled = saving || preparing || (!pending && (!preview || !confirm.checked || Boolean(held)));
    save.textContent = pending ? 'Retry saving the same composition' : 'Save this composition';
    refresh.disabled = locked;
    if (held && preview) message.textContent = held;
    else if (lastHold && message.textContent === lastHold) message.textContent = 'Preview ready. Inspect the surfaces and your assumed layout before saving.';
    lastHold = held;
  }
  async function choose(index, key) {
    if (pending || saving) return;
    invalidate();
    const mine = ++entries[index].generation;
    const candidate = candidates.find((entry) => entry.key === key);
    selected[index] = null;
    entries[index].evidence.replaceChildren();
    if (!candidate) { render(); return; }
    entries[index].name.value = candidate.object.label;
    const [jobResult, surfaceResult] = await Promise.all([request(`${base}/${candidate.job.id}`), request(`${base}/${candidate.job.id}/assets/surface.json`)]);
    if (disposed || mine !== entries[index].generation) return;
    const parent = jobResult.body;
    const hash = parent?.derivedAssets?.find((asset) => asset.name === 'surface.json')?.sha256;
    try {
      if (!jobResult.ok || parent?.status !== 'ready' || parent.usageBlocked || parent.representation || parent.sourceId !== candidate.job.sourceId || !surfaceResult.ok || !/^[a-f0-9]{64}$/.test(hash ?? '') || (candidate.object.id !== 'selected-foreground' && parent.objectsConfirmed !== true)) throw new Error('unavailable');
      validateSurface(surfaceResult.body);
      if (sourceFor(parent.sourceId)?.permissions?.place !== true) throw new Error('source');
      selected[index] = { ref: { jobId: parent.id, objectId: candidate.object.id, surfaceSha256: hash }, sourceId: parent.sourceId, surface: surfaceResult.body, texture: `${base}/${parent.id}/assets/texture.jpg` };
      const image = el('img', { src: selected[index].texture, alt: `Source photo for object ${index === 0 ? 'A' : 'B'}: ${candidate.object.label}` });
      const [width, height] = selected[index].surface.source.image_size;
      const box = candidate.object.id === 'selected-foreground' ? parent.box : parent.objects.find((object) => object.id === candidate.object.id)?.box;
      const overlay = el('div', { className: `box-overlay box-overlay-${index === 0 ? 'a' : 'b'}` });
      if (Array.isArray(box)) Object.assign(overlay.style, { left: `${box[0] / width * 100}%`, top: `${box[1] / height * 100}%`, width: `${(box[2] - box[0]) / width * 100}%`, height: `${(box[3] - box[1]) / height * 100}%` });
      else overlay.hidden = true;
      entries[index].evidence.replaceChildren(el('div', { className: 'anchor-frame' }, [image, overlay]), el('p', { className: 'hint', textContent: `Source photo: ${width} × ${height} pixels. The box identifies the selected source object. It keeps its photographed surface and estimated depth. Its new placement is yours.` }));
      message.textContent = 'Choose objects from distinct photos of the same place. Set their placement and relative size explicitly.';
    } catch {
      message.textContent = 'This source object could not be prepared under its current uses. Choose another source object.';
    }
    render();
  }
  refresh.addEventListener('click', async () => {
    const read = input();
    if (read.error) { message.textContent = read.error; return; }
    disposePreview(); preparing = true; render();
    const mine = generation;
    const arrangement = { version: 1, frame: 'owner-composition', objects: read.body.objects.map((entry, index) => ({ id: `object-${index + 1}`, ...copyPose(entry.pose) })), relationship: null };
    const surface = { schema_version: 3, representation: COMPOSITION_REPRESENTATION,
      components: selected.map((entry, index) => ({ id: `object-${index + 1}`, label: read.body.objects[index].label, selectedObjectId: entry.ref.objectId, texture: `texture-${index + 1}.jpg`, surface: entry.surface })),
      context: read.body.context.keep ? { kind: 'photographed-background', componentId: 'object-1', bounds: read.body.context.bounds, pose: copyPose(read.body.objects[0].pose) } : null };
    let created;
    try {
      created = await createViewer(viewport, surface, { 'texture-1.jpg': selected[0].texture, 'texture-2.jpg': selected[1].texture }, 'Owner-assumed composition of two photographed objects');
      created.applyArrangement(arrangement);
    } catch {
      created?.dispose();
      if (disposed || mine !== generation) return;
      preparing = false; message.textContent = 'The two-photo preview could not be shown. Nothing was saved. Check both source objects and try again.'; render(); return;
    }
    if (disposed || mine !== generation) { created.dispose(); return; }
    preparing = false; preview = created; previewInput = { body: read.body, arrangement }; viewport.hidden = false; explore.attach(preview);
    gate = createGate(surface, () => current() && mine === generation, render);
    contextNote.textContent = read.body.context.keep ? 'Preview with the first photo’s observed background fixed at A’s initial placement. B’s photo background is not imported.' : 'Preview: only two observed surfaces are shown. No room background is included.';
    message.textContent = 'Inspect the preview before saving your assumed layout.';
    render();
  });
  keep.addEventListener('change', invalidate); crop.addEventListener('change', invalidate);
  bounds.forEach((field) => field.addEventListener('input', invalidate));
  confirm.addEventListener('change', render);
  save.addEventListener('click', async () => {
    if (save.disabled || disposed) return;
    pending ??= { requestId: crypto.randomUUID(), ...previewInput.body };
    const retrying = uncertain;
    saving = true; render();
    const result = await post(base, pending);
    saving = false;
    const accepted = result.ok && result.body?.status === 'ready' && result.body?.representation === COMPOSITION_REPRESENTATION && typeof result.body.id === 'string';
    if (disposed) { if (accepted) onSaved(result.body, { late: true }); return; }
    if (result.status === 0 || result.status >= 500 || (result.ok && !accepted)) {
      uncertain = true;
      message.textContent = 'The save outcome is unknown. Retrying sends exactly the same composition. Check the saved scene list if you leave.'; render(); return;
    }
    if (retrying && [401, 403, 409].includes(result.status)) {
      message.textContent = 'Rehere could not check the earlier save under your current access or scene state. Its outcome remains unknown. Retry the same composition when access returns, or check the saved scene list.';
      render(); return;
    }
    pending = null; uncertain = false;
    if (!accepted) { message.textContent = result.body?.error || 'This composition could not be saved. Your choices are kept.'; render(); return; }
    onSaved(result.body);
  });
  cancel.addEventListener('click', () => onCancel({ unknown: pending !== null }));
  container.replaceChildren(heading, el('p', { className: 'hint', textContent: COMPOSITION_NOTE }), ...entries.map((entry) => entry.section),
    el('fieldset', { className: 'space-edit' }, [el('legend', { textContent: 'Observed context from the first photo' }), el('label', {}, [keep, ' Keep the first photo’s observed background, fixed at A’s initial placement']), el('label', {}, [crop, ' Limit that background to this source-pixel rectangle (objects are never cropped)']), ...bounds.map((field, index) => el('label', {}, [`${['Left', 'Top', 'Right', 'Bottom'][index]} `, field]))]),
    el('div', { className: 'actions' }, [refresh, explore.button]), explore.status, viewport, contextNote,
    el('label', {}, [confirm, ' I inspected the two surfaces and choose this placement, orientation, assumed relative scale and context choice. This is my layout, not automatic alignment.']), message, el('div', { className: 'actions' }, [cancel, save]));
  entries.forEach((entry) => { entry.generation = 0; });
  request(base).then((result) => {
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) { message.textContent = 'Saved source scenes could not be read.'; return; }
    candidates = result.body.filter((job) => job.status === 'ready' && !job.usageBlocked && !job.representation && sourceFor(job.sourceId)?.permissions?.place === true).flatMap((job) => {
      const objects = Array.isArray(job.objects) ? job.objectsConfirmed ? job.objects : [] : [{ id: 'selected-foreground', label: 'Foreground object' }];
      return objects.map((object) => ({ job, object, key: `${job.id}|${object.id}` }));
    });
    entries.forEach((entry) => { entry.select.replaceChildren(el('option', { value: '', textContent: 'Choose a saved source object' }), ...candidates.map((candidate) => el('option', { value: candidate.key, textContent: `${candidate.object.label} · scene ${candidate.job.id.slice(0, 8)}` }))); entry.select.value = ''; });
    message.textContent = candidates.length ? 'Choose two objects from different photos of this place.' : 'Build source scenes first. Use a ready foreground object or a confirmed object from a two-object scene.';
  });
  render(); heading.focus(); heading.scrollIntoView?.({ block: 'start' });
  return { dispose() { disposed = true; disposePreview(); } };
}
