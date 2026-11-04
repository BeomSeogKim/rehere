// Deterministic overlay images for the SAM 3.1 lodge index. Each overlay is a transparent PNG with exactly the pixel size of the
// photograph it belongs to (the model's frame), holding the mask fill and outline of every instance returned for one noun.
// Inputs are the derived instances in lodge-index.json (box + COCO run-length encoding from the official parser); the output
// has only IHDR, IDAT and IEND chunks, so no text, Exif or time block can ride along. Overlays ship in the release asset, never in Git.
import { crc32, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_RUNS = 5_000_000;

// Colours chosen to stay apart on a black-and-white photograph, one per concept noun.
export const NOUN_COLORS = Object.freeze({
  chair: [230, 159, 0], table: [0, 158, 115], 'rocking chair': [213, 94, 0], chandelier: [240, 228, 66], window: [86, 180, 233],
  fireplace: [204, 121, 167], rug: [160, 82, 45], bench: [148, 103, 189], lamp: [255, 127, 80], door: [64, 224, 208],
});

// COCO compressed run-length string (the format meta-sam-parser emits) to alternating run lengths, background first.
export function decodeRleCounts(counts) {
  const runs = [];
  let at = 0;
  while (at < counts.length) {
    let value = 0;
    let shift = 0;
    let more = true;
    while (more) {
      if (at >= counts.length) throw new Error('The run-length string ends inside a number.');
      const code = counts.charCodeAt(at) - 48;
      if (code < 0 || code > 63) throw new Error('The run-length string has an unexpected character.');
      value |= (code & 0x1f) << (5 * shift);
      more = (code & 0x20) !== 0;
      at += 1;
      shift += 1;
      if (!more && (code & 0x10)) value |= -1 << (5 * shift);
      if (shift > 6) throw new Error('A run length is too long.');
    }
    if (runs.length > 2) value += runs[runs.length - 2];
    if (value < 0) throw new Error('A run length is negative.');
    runs.push(value);
    if (runs.length > MAX_RUNS) throw new Error('The run-length string has too many runs.');
  }
  return runs;
}

// Box-local binary mask (row-major, 1 = inside) from { size: [height, width], counts }. COCO runs go column by column.
export function decodeMask({ size: [height, width], counts }) {
  const mask = new Uint8Array(height * width);
  let position = 0;
  decodeRleCounts(counts).forEach((run, index) => {
    if (position + run > mask.length) throw new Error('The run-length string is longer than its mask.');
    if (index % 2 === 1) {
      for (let k = position; k < position + run; k += 1) mask[(k % height) * width + Math.floor(k / height)] = 1;
    }
    position += run;
  });
  if (position !== mask.length) throw new Error('The run-length string does not cover its mask.');
  return mask;
}

const FILL_ALPHA = 92;
const EDGE = 2;

// RGBA frame (width x height) with the fill and a two-pixel outline of every instance in one colour.
export function renderOverlay({ width, height, instances, color }) {
  const rgba = Buffer.alloc(width * height * 4);
  for (const instance of instances) {
    const [x1, y1, x2, y2] = instance.box;
    const w = x2 - x1;
    const h = y2 - y1;
    if (x1 < 0 || y1 < 0 || x2 > width || y2 > height || instance.rle.size[0] !== h || instance.rle.size[1] !== w) throw new Error('An instance does not fit the photograph frame.');
    const mask = decodeMask(instance.rle);
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (mask[y * w + x] !== 1) continue;
        let edge = false;
        for (let d = 1; d <= EDGE && !edge; d += 1) edge = !inside(x - d, y) || !inside(x + d, y) || !inside(x, y - d) || !inside(x, y + d);
        const offset = ((y1 + y) * width + x1 + x) * 4;
        if (edge) {
          rgba[offset] = color[0]; rgba[offset + 1] = color[1]; rgba[offset + 2] = color[2]; rgba[offset + 3] = 255;
        } else if (rgba[offset + 3] < 255) {
          rgba[offset] = color[0]; rgba[offset + 1] = color[1]; rgba[offset + 2] = color[2]; rgba[offset + 3] = Math.max(rgba[offset + 3], FILL_ALPHA);
        }
      }
    }
  }
  return rgba;
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

// 8-bit RGBA, no interlace, filter type 0 on every row, deflate level 9: the same pixels always give the same bytes.
export function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export const overlayPng = ({ width, height, instances, noun }) => {
  const color = NOUN_COLORS[noun];
  if (!color) throw new Error(`No overlay colour for ${noun}.`);
  return encodePng({ width, height, rgba: renderOverlay({ width, height, instances, color }) });
};
