// One object's outline at the original photo's full pixel size. The mask is
// kept as one byte per source pixel (0 or 1) and is never resampled, so a
// confirmed outline names exactly the pixels the owner saw selected.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const BRUSH_RADII = [0, 3, 12, 40];
const BRUSH_LABELS = ['Finest brush', 'Small brush', 'Medium brush', 'Large brush'];
const MAX_ZOOM = 16;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function transform(bytes, stream) {
  const body = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Fixed format: opaque 8-bit grayscale, values 0 and 255 only, unfiltered
// rows. Encoding here avoids a full-photo canvas.
export async function encodeMaskPng(mask, width, height) {
  if (typeof CompressionStream !== 'function') throw new Error('This browser cannot prepare the outline file.');
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) throw new Error('Mask size does not match the photo.');
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    for (let x = 0; x < width; x += 1) raw[row + 1 + x] = mask[y * width + x] ? 255 : 0;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', await transform(raw, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const TILE = 1024;

// Reads a natively decoded mask in bounded 1:1 tiles, so no canvas ever holds
// the whole photo and nothing is resampled. Only opaque pixels with equal
// channels at 0 or 255 are accepted; anything else is refused, not converted.
export function readBinaryMask(bitmap, width, height, makeCanvas) {
  if (bitmap.width !== width || bitmap.height !== height) throw new Error('The suggested outline does not fit this photo.');
  const mask = new Uint8Array(width * height);
  const canvas = makeCanvas(Math.min(TILE, width), Math.min(TILE, height));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The suggested outline could not be read in this browser.');
  context.imageSmoothingEnabled = false;
  for (let top = 0; top < height; top += TILE) {
    for (let left = 0; left < width; left += TILE) {
      const [w, h] = [Math.min(TILE, width - left), Math.min(TILE, height - top)];
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, left, top, w, h, 0, 0, w, h);
      const { data } = context.getImageData(0, 0, w, h);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const at = 4 * (y * w + x);
          const value = data[at];
          if ((value !== 0 && value !== 255) || data[at + 1] !== value || data[at + 2] !== value || data[at + 3] !== 255) {
            throw new Error('The suggested outline could not be read.');
          }
          mask[(top + y) * width + left + x] = value ? 1 : 0;
        }
      }
    }
  }
  return mask;
}

function makeTileCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement('canvas'), { width, height });
}

// Maps a pointer position to the source pixel under it, whatever the zoom.
export function sourcePixelAt(clientX, clientY, rect, width, height) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const x = Math.floor((clientX - rect.left) * width / rect.width);
  const y = Math.floor((clientY - rect.top) * height / rect.height);
  return x < 0 || y < 0 || x >= width || y >= height ? null : [x, y];
}

export function createMaskSession(width, height, initial = null) {
  if (!(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0)) throw new Error('Invalid photo size.');
  const mask = initial ? Uint8Array.from(initial) : new Uint8Array(width * height);
  if (mask.length !== width * height) throw new Error('Mask size does not match the photo.');
  let count = mask.reduce((sum, value) => sum + value, 0);
  const history = [];
  let stroke = null;
  const set = (index, value) => {
    if (mask[index] === value) return;
    stroke.push(index);
    mask[index] = value;
    count += value ? 1 : -1;
  };
  const disc = (cx, cy, radius, value) => {
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) set(y * width + x, value);
      }
    }
  };
  const line = (from, to, radius, value) => {
    const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), 1);
    for (let step = 0; step <= steps; step += 1) {
      disc(Math.round(from[0] + (to[0] - from[0]) * step / steps), Math.round(from[1] + (to[1] - from[1]) * step / steps), radius, value);
    }
  };
  const finish = () => {
    // Every pixel changes at most once per stroke because a stroke has one mode.
    if (stroke.length) history.push({ indices: Uint32Array.from(stroke), value: mask[stroke[0]] });
    stroke = null;
  };
  return {
    get mask() { return mask; },
    get count() { return count; },
    get painting() { return stroke !== null; },
    get canUndo() { return history.length > 0; },
    begin() { stroke ??= []; },
    paint(from, to, radius, mode) { if (stroke) line(from, to, radius, mode === 'add' ? 1 : 0); },
    end(cancel = false) {
      if (!stroke) return;
      if (cancel) {
        const restore = stroke.length ? 1 - mask[stroke[0]] : 0;
        for (const index of stroke) mask[index] = restore;
        count += stroke.length * (restore ? 1 : -1);
        stroke = null;
      } else finish();
    },
    // Vertices are source pixels. The edges are drawn as one-pixel lines and
    // the interior is filled at pixel centres, so the clicked pixels are included.
    fillPolygon(points, mode) {
      if (stroke || points.length < 3) return false;
      const value = mode === 'add' ? 1 : 0;
      stroke = [];
      const centres = points.map(([x, y]) => [x + 0.5, y + 0.5]);
      const ys = centres.map((point) => point[1]);
      for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(height - 1, Math.ceil(Math.max(...ys))); y += 1) {
        const centre = y + 0.5;
        const crossings = [];
        centres.forEach(([x0, y0], i) => {
          const [x1, y1] = centres[(i + 1) % centres.length];
          if ((y0 <= centre && centre < y1) || (y1 <= centre && centre < y0)) crossings.push(x0 + (centre - y0) * (x1 - x0) / (y1 - y0));
        });
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          for (let x = Math.max(0, Math.ceil(crossings[i] - 0.5)); x <= Math.min(width - 1, Math.ceil(crossings[i + 1] - 0.5) - 1); x += 1) set(y * width + x, value);
        }
      }
      points.forEach((point, i) => line(point, points[(i + 1) % points.length], 0, value));
      finish();
      return true;
    },
    undo() {
      if (stroke) return;
      const last = history.pop();
      if (!last) return;
      for (const index of last.indices) mask[index] = 1 - last.value;
      count += last.indices.length * (last.value ? -1 : 1);
    },
  };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function mountObjectOutlineEditor(host, { source, initialMaskUrl = null, onConfirm, onCancel }) {
  const { url, width, height } = source;
  if (!(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0)) throw new Error('Invalid photo size.');
  const listeners = [];
  const on = (target, type, handler) => { target.addEventListener(type, handler); listeners.push([target, type, handler]); };
  const abort = new AbortController();
  let session = null;
  let disposed = false;
  let imageReady = false;
  let pending = false;
  let used = false;
  let tool = 'brush';
  let mode = 'add';
  let radius = BRUSH_RADII[1];
  let zoom = null;
  let cursor = [Math.floor(width / 2), Math.floor(height / 2)];
  let pointerId = null;
  let previous = null;
  let shape = [];
  let drawQueued = false;
  let revision = 0;
  let encoded = null;

  const heading = el('h3', { textContent: 'Outline the object in this photo', tabIndex: -1 });
  const image = el('img', { alt: 'Copy of the photo for outlining the object', draggable: false });
  // source.url must be a metadata-free photo copy whose pixels are already in
  // the source grid; the component cannot detect orientation tags itself.
  image.style.imageOrientation = 'none';
  image.style.display = 'block';
  image.style.width = '100%';
  image.style.height = '100%';
  image.style.userSelect = 'none';
  const overlay = el('canvas');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.position = 'absolute';
  overlay.style.pointerEvents = 'none';
  overlay.style.imageRendering = 'pixelated';
  const marker = el('span', { className: 'outline-cursor' });
  marker.setAttribute('aria-hidden', 'true');
  const frame = el('div', { tabIndex: 0 }, [image, overlay, marker]);
  frame.style.position = 'relative';
  frame.style.touchAction = 'none';
  frame.style.cursor = 'crosshair';
  frame.setAttribute('role', 'group');
  frame.setAttribute('aria-label', 'Photo for outlining. Arrow keys move one step, Shift moves further. Space paints or adds a corner, Enter closes the shape, Escape discards it.');
  const viewport = el('div', {}, [frame]);
  viewport.style.overflow = 'auto';
  viewport.style.maxHeight = '70vh';
  viewport.style.position = 'relative';
  const context = overlay.getContext('2d');
  const message = el('p', { className: 'form-message', role: 'status' });
  const position = el('p', { className: 'hint', role: 'status' });
  const tools = ['brush', 'shape'].map((value) => el('button', { type: 'button', className: 'secondary', textContent: value === 'brush' ? 'Brush' : 'Draw a shape' }));
  const modes = ['add', 'remove'].map((value) => el('button', { type: 'button', className: 'secondary', textContent: value === 'add' ? 'Add to outline' : 'Remove from outline' }));
  const sizes = BRUSH_RADII.map((value, i) => el('button', { type: 'button', className: 'secondary', textContent: BRUSH_LABELS[i] }));
  const closeShape = el('button', { type: 'button', className: 'secondary', textContent: 'Close shape' });
  const discardShape = el('button', { type: 'button', className: 'secondary', textContent: 'Discard shape' });
  const zoomOut = el('button', { type: 'button', className: 'secondary', textContent: 'Zoom out' });
  const zoomIn = el('button', { type: 'button', className: 'secondary', textContent: 'Zoom in' });
  const fit = el('button', { type: 'button', className: 'secondary', textContent: 'Fit photo' });
  const undo = el('button', { type: 'button', className: 'secondary', textContent: 'Undo' });
  const blank = el('button', { type: 'button', className: 'secondary', textContent: 'Start a blank outline', hidden: true });
  const checked = el('input', { type: 'checkbox' });
  const use = el('button', { type: 'button', textContent: 'Use this outline' });
  const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Cancel' });

  const editable = () => !disposed && !pending && !used && imageReady && session !== null;
  const fitScale = () => (viewport.clientWidth > 0 ? Math.min(1, viewport.clientWidth / width) : 1);
  const scale = () => zoom ?? fitScale();

  function drawOverlay() {
    drawQueued = false;
    if (disposed || !context) return;
    const s = scale();
    const [left, top] = [viewport.scrollLeft || 0, viewport.scrollTop || 0];
    const w = Math.max(0, Math.min(viewport.clientWidth || 0, Math.ceil(width * s - left)));
    const h = Math.max(0, Math.min(viewport.clientHeight || 0, Math.ceil(height * s - top)));
    overlay.width = w;
    overlay.height = h;
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    if (!w || !h || !session) return;
    const pixels = context.createImageData(w, h);
    const columns = new Int32Array(w);
    for (let i = 0; i < w; i += 1) columns[i] = Math.min(width - 1, Math.floor((left + i + 0.5) / s));
    for (let j = 0; j < h; j += 1) {
      const row = Math.min(height - 1, Math.floor((top + j + 0.5) / s)) * width;
      for (let i = 0; i < w; i += 1) {
        if (!session.mask[row + columns[i]]) continue;
        const at = 4 * (j * w + i);
        pixels.data[at] = 34; pixels.data[at + 1] = 147; pixels.data[at + 2] = 255; pixels.data[at + 3] = 128;
      }
    }
    context.putImageData(pixels, 0, 0);
    if (shape.length) {
      context.strokeStyle = '#ffb000';
      context.lineWidth = 2;
      context.beginPath();
      shape.forEach(([x, y], i) => context[i ? 'lineTo' : 'moveTo']((x + 0.5) * s - left, (y + 0.5) * s - top));
      context.stroke();
    }
  }
  function render() {
    const s = scale();
    frame.style.width = `${width * s}px`;
    frame.style.height = `${height * s}px`;
    const r = tool === 'brush' ? radius : 0;
    marker.style.left = `${(cursor[0] - r) * s}px`;
    marker.style.top = `${(cursor[1] - r) * s}px`;
    marker.style.width = marker.style.height = `${Math.max(2, (2 * r + 1) * s)}px`;
    const count = session?.count ?? 0;
    position.textContent = `Pointer at ${cursor[0] + 1}, ${cursor[1] + 1}. Zoom ${Math.round(s * 100)}%. ${count === 0 ? 'Nothing is selected yet.' : `${count.toLocaleString('en-US')} ${count === 1 ? 'pixel' : 'pixels'} selected.`}${shape.length ? ` The shape has ${shape.length} corners.` : ''}`;
    const idle = editable() && !session.painting;
    tools.forEach((button, i) => { button.disabled = !idle || shape.length > 0; button.setAttribute('aria-pressed', String(tool === ['brush', 'shape'][i])); });
    modes.forEach((button, i) => { button.disabled = !idle || shape.length > 0; button.setAttribute('aria-pressed', String(mode === ['add', 'remove'][i])); });
    sizes.forEach((button, i) => { button.disabled = !idle || tool !== 'brush'; button.setAttribute('aria-pressed', String(radius === BRUSH_RADII[i])); });
    closeShape.disabled = !idle || shape.length < 3;
    discardShape.disabled = !idle || shape.length === 0;
    const viewable = !disposed && !pending && imageReady;
    zoomIn.disabled = !viewable || s >= MAX_ZOOM;
    zoomOut.disabled = !viewable || s <= fitScale();
    fit.disabled = !viewable || zoom === null;
    undo.disabled = !idle || shape.length > 0 || !session.canUndo;
    checked.disabled = !idle || shape.length > 0;
    if (!idle || shape.length > 0) checked.checked = checked.checked && pending;
    use.disabled = !idle || shape.length > 0 || !checked.checked || count === 0 || count === width * height;
    // After Use is pressed, a write may still complete, so Cancel would not mean "nothing written".
    cancel.disabled = disposed || pending || used;
    if (!drawQueued) {
      drawQueued = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drawOverlay);
      else drawOverlay();
    }
  }
  function changed() {
    revision += 1;
    checked.checked = false;
    render();
  }
  function setZoom(next) {
    const s = Math.min(MAX_ZOOM, next);
    zoom = s <= fitScale() ? null : s;
    render();
    const applied = scale();
    viewport.scrollLeft = Math.max(0, (cursor[0] + 0.5) * applied - (viewport.clientWidth || 0) / 2);
    viewport.scrollTop = Math.max(0, (cursor[1] + 0.5) * applied - (viewport.clientHeight || 0) / 2);
    render();
  }
  function start(initial, text) {
    try {
      session = createMaskSession(width, height, initial);
    } catch {
      session = null;
      message.textContent = 'The outline could not be prepared in this browser.';
      render();
      return;
    }
    revision += 1;
    blank.hidden = true;
    message.textContent = text;
    render();
  }
  function refuse(reason) {
    session = null;
    blank.hidden = false;
    message.textContent = `${reason} Nothing was changed. You can start a blank outline and trace the object by hand.`;
    render();
  }
  async function loadInitial() {
    let target;
    try {
      target = new URL(initialMaskUrl, globalThis.location?.href);
    } catch {
      refuse('The suggested outline could not be found.');
      return;
    }
    if (globalThis.location && target.origin !== globalThis.location.origin) {
      refuse('The suggested outline could not be used.');
      return;
    }
    try {
      if (typeof createImageBitmap !== 'function') throw new Error('The suggested outline could not be read in this browser.');
      const response = await fetch(target.href, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error('The suggested outline could not be loaded.');
      const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      try {
        if (!disposed) start(readBinaryMask(bitmap, width, height, makeTileCanvas), 'Check the suggested outline against the photo. Add or remove parts where it is wrong.');
      } finally {
        bitmap.close?.();
      }
    } catch (error) {
      if (!disposed) refuse(error?.message?.startsWith('The suggested outline') ? error.message : 'The suggested outline could not be loaded.');
    }
  }

  const paintTo = (point) => {
    session.paint(previous ?? point, point, radius, mode);
    previous = point;
    cursor = point;
    render();
  };
  const addPoint = (point) => {
    shape.push(point);
    cursor = point;
    render();
  };
  const commitShape = () => {
    if (session.fillPolygon(shape, mode)) {
      shape = [];
      changed();
    }
  };

  on(image, 'load', () => {
    if (disposed) return;
    if (image.naturalWidth !== width || image.naturalHeight !== height) {
      imageReady = false;
      message.textContent = 'This copy of the photo is not the same size as the original, so it cannot be used for outlining. Nothing was changed.';
      render();
      return;
    }
    imageReady = true;
    render();
  });
  on(image, 'error', () => {
    if (disposed) return;
    imageReady = false;
    if (session?.painting) session.end(true);
    pointerId = null;
    message.textContent = 'The photo could not be shown. Your outline is kept. Reload to try again.';
    render();
  });
  on(frame, 'pointerdown', (event) => {
    if (!editable() || session.painting || pointerId !== null || event.button !== 0) return;
    const point = sourcePixelAt(event.clientX, event.clientY, image.getBoundingClientRect(), width, height);
    if (!point) return;
    event.preventDefault();
    frame.focus();
    if (tool === 'shape') { addPoint(point); return; }
    frame.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    previous = null;
    session.begin();
    paintTo(point);
  });
  on(frame, 'pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const point = sourcePixelAt(event.clientX, event.clientY, image.getBoundingClientRect(), width, height);
    if (point) paintTo(point);
  });
  const finish = (event, cancelStroke) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const captured = pointerId;
    pointerId = null;
    previous = null;
    session.end(cancelStroke);
    frame.releasePointerCapture?.(captured);
    changed();
  };
  on(frame, 'pointerup', (event) => finish(event, false));
  on(frame, 'pointercancel', (event) => finish(event, true));
  on(frame, 'lostpointercapture', (event) => finish(event, true));
  on(frame, 'keydown', (event) => {
    if (!imageReady || disposed || pending) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(scale() * 2); return; }
    if (event.key === '-') { event.preventDefault(); setZoom(scale() / 2); return; }
    if (!editable() || session.painting) return;
    const step = event.shiftKey ? 10 : 1;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (move) {
      event.preventDefault();
      cursor = [Math.max(0, Math.min(width - 1, cursor[0] + move[0])), Math.max(0, Math.min(height - 1, cursor[1] + move[1]))];
      render();
    } else if (event.key === ' ' && !event.repeat) {
      event.preventDefault();
      if (tool === 'shape') addPoint(cursor);
      else { session.begin(); session.paint(cursor, cursor, radius, mode); session.end(); changed(); }
    } else if (event.key === 'Enter' && tool === 'shape' && shape.length >= 3) {
      event.preventDefault();
      commitShape();
    } else if (event.key === 'Escape' && shape.length) {
      event.preventDefault();
      shape = [];
      render();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !shape.length) {
      event.preventDefault();
      session.undo();
      changed();
    }
  });
  on(viewport, 'scroll', () => render());
  tools.forEach((button, i) => on(button, 'click', () => { if (editable() && !shape.length) { tool = ['brush', 'shape'][i]; render(); } }));
  modes.forEach((button, i) => on(button, 'click', () => { if (editable() && !shape.length) { mode = ['add', 'remove'][i]; render(); } }));
  sizes.forEach((button, i) => on(button, 'click', () => { if (editable()) { radius = BRUSH_RADII[i]; render(); } }));
  on(closeShape, 'click', () => { if (editable() && shape.length >= 3) commitShape(); });
  on(discardShape, 'click', () => { if (editable()) { shape = []; render(); } });
  on(zoomIn, 'click', () => { if (!zoomIn.disabled) setZoom(scale() * 2); });
  on(zoomOut, 'click', () => { if (!zoomOut.disabled) setZoom(scale() / 2); });
  on(fit, 'click', () => { if (!fit.disabled) setZoom(0); });
  on(undo, 'click', () => { if (editable() && !shape.length) { session.undo(); changed(); } });
  on(blank, 'click', () => { if (!disposed && !pending && !used) start(null, 'Trace the object by hand. Only the parts you select become the outline.'); });
  on(checked, 'change', () => render());
  on(use, 'click', async () => {
    if (use.disabled || disposed || pending) return;
    pending = true;
    message.textContent = 'Preparing the outline…';
    render();
    let accepted = false;
    try {
      // A retry of an unchanged drawing resends the same bytes and hash.
      if (encoded?.revision !== revision) {
        const bytes = await encodeMaskPng(session.mask, width, height);
        encoded = { revision, mask: new Blob([bytes], { type: 'image/png' }), maskSha256: await sha256Hex(bytes) };
      }
      if (disposed) return;
      message.textContent = 'Sending the outline…';
      const result = await onConfirm({ mask: encoded.mask, width, height, maskSha256: encoded.maskSha256, crop: [0, 0, width, height] });
      accepted = result !== false;
    } catch {
      accepted = false;
    }
    if (disposed) return;
    pending = false;
    if (accepted) {
      used = true;
      message.textContent = 'This outline will be used. Your photo is unchanged.';
      render();
      return;
    }
    message.textContent = 'The outline was not used. Your drawing is kept, and you can try again.';
    render();
    use.focus?.();
  });
  on(cancel, 'click', () => { if (!disposed && !pending && !used) onCancel(); });

  host.replaceChildren(
    heading,
    el('p', { className: 'hint', textContent: 'Mark only where the object appears in this photo. Blue shows what is selected. Sides hidden in the photo cannot be outlined, and your photo is never changed.' }),
    el('div', { className: 'actions' }, [...tools, ...modes]),
    el('div', { className: 'actions' }, sizes),
    el('div', { className: 'actions' }, [closeShape, discardShape, undo, blank]),
    el('div', { className: 'actions' }, [zoomOut, zoomIn, fit]),
    viewport, position,
    el('p', { className: 'hint', textContent: 'Keyboard: focus the photo, move with the arrow keys (Shift for bigger steps), press Space to paint or add a corner, Enter to close the shape, Escape to discard it, Ctrl or Command with Z to undo, and plus or minus to zoom.' }),
    el('label', {}, [checked, ' I checked this outline against the photo. It only marks where the object appears here; it is not a memory and does not confirm the object’s hidden shape or history.']),
    message,
    el('div', { className: 'actions' }, [cancel, use]),
  );
  image.src = url;
  if (initialMaskUrl === null) start(null, 'Trace the object by hand. Only the parts you select become the outline.');
  else { message.textContent = 'Loading the suggested outline…'; render(); loadInitial(); }
  heading.focus();
  heading.scrollIntoView?.({ block: 'start' });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      const captured = pointerId;
      pointerId = null;
      if (session?.painting) session.end(true);
      if (captured !== null) frame.releasePointerCapture?.(captured);
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
      listeners.length = 0;
    },
  };
}
