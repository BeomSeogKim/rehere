import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

// The outline is read from its exact PNG bytes. These cases use synthetic
// masks only, including the 400x300 synthetic outline whose colour-managed
// browser decode was refused.
const FAILED_SAFARI_MASK = 'iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAAAAADI3LoeAAACI0lEQVR4nO3RIQ7AMAwEQaf//3OLw8qyimawgU87AwAAAAAAAAAAAAAAdevv4TuXDIl7Tj/ATpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREkRpAYQWIEiREEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIC5zQd19AKk4Lsl9gAAAABJRU5ErkJggg==';

let readBinaryMask;
before(async () => {
  // The reader must not touch the browser's image decode or canvas path.
  globalThis.createImageBitmap = () => { throw new Error('image decode must not be used'); };
  globalThis.OffscreenCanvas = class { constructor() { throw new Error('canvas must not be used'); } };
  ({ readBinaryMask } = await import('../public/object-outline-editor.js'));
});
after(() => { delete globalThis.createImageBitmap; delete globalThis.OffscreenCanvas; });

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
// Filters packed rows with the given per-row filter types.
function filtered(rows, filters, step) {
  const out = [];
  let previous = Buffer.alloc(rows[0].length);
  rows.forEach((row, y) => {
    const kind = filters[y % filters.length], line = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i += 1) {
      const left = i >= step ? row[i - step] : 0, up = previous[i], corner = i >= step ? previous[i - step] : 0;
      line[i] = (row[i] - [0, left, up, (left + up) >> 1, paeth(left, up, corner)][kind]) & 255;
    }
    out.push(Buffer.from([kind]), line);
    previous = row;
  });
  return Buffer.concat(out);
}
function png({ width, height, depth = 8, colour = 0, rows, filters = [0], step = 1, before = [], after = [], interlace = 0, raw = null }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header.set([depth, colour, 0, 0, interlace], 8);
  const data = raw ?? filtered(rows, filters, step);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...before, chunk('IDAT', deflateSync(data)), ...after, chunk('IEND', Buffer.alloc(0))]));
}
const greyRows = (mask, width, height) => Array.from({ length: height }, (_, y) => Buffer.from(Array.from({ length: width }, (_, x) => (mask[y * width + x] ? 255 : 0))));
const sample = (width, height) => Uint8Array.from({ length: width * height }, (_, i) => ((i * 7) % 5 === 0 ? 1 : 0));

describe('exact PNG outline reading', () => {
  it('reads the synthetic outline that the colour-managed browser decode refused', async () => {
    const bytes = new Uint8Array(Buffer.from(FAILED_SAFARI_MASK, 'base64'));
    const mask = await readBinaryMask(bytes, 400, 300);
    const expected = Uint8Array.from({ length: 400 * 300 }, (_, i) => { const x = i % 400, y = Math.floor(i / 400); return x >= 40 && x < 200 && y >= 30 && y < 240 ? 1 : 0; });
    assert.equal(mask.reduce((sum, value) => sum + value, 0), 33600);
    assert.deepEqual(mask, expected);
  });

  it('undoes every standard row filter exactly', async () => {
    const [width, height] = [13, 10], mask = sample(width, height);
    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      assert.deepEqual(await readBinaryMask(png({ width, height, rows: greyRows(mask, width, height), filters }), width, height), mask, `filters ${filters}`);
    }
  });

  it('accepts greyscale at 1, 2 and 4 bits and 8-bit RGB and RGBA with equal opaque channels', async () => {
    const [width, height] = [11, 4], mask = sample(width, height);
    const packed = (depth) => Array.from({ length: height }, (_, y) => {
      const row = Buffer.alloc(Math.ceil((width * depth) / 8));
      for (let x = 0; x < width; x += 1) if (mask[y * width + x]) { const bit = x * depth; row[bit >> 3] |= ((1 << depth) - 1) << (8 - depth - (bit & 7)); }
      return row;
    });
    for (const depth of [1, 2, 4]) assert.deepEqual(await readBinaryMask(png({ width, height, depth, rows: packed(depth), filters: [0, 1, 4] }), width, height), mask, `grey ${depth}`);
    const colour = (channels) => Array.from({ length: height }, (_, y) => Buffer.from(Array.from({ length: width }, (_, x) => { const v = mask[y * width + x] ? 255 : 0; return channels === 3 ? [v, v, v] : [v, v, v, 255]; }).flat()));
    assert.deepEqual(await readBinaryMask(png({ width, height, colour: 2, rows: colour(3), filters: [1, 3], step: 3 }), width, height), mask);
    assert.deepEqual(await readBinaryMask(png({ width, height, colour: 6, rows: colour(4), filters: [2, 4], step: 4 }), width, height), mask);
  });

  it('refuses non-binary, unequal or transparent pixels instead of converting them', async () => {
    const [width, height] = [5, 3];
    const grey = (value) => Array.from({ length: height }, (_, y) => Buffer.from(Array.from({ length: width }, (_, x) => (x === 2 && y === 1 ? value : 0))));
    for (const value of [1, 128, 254]) await assert.rejects(readBinaryMask(png({ width, height, rows: grey(value) }), width, height), /could not be read/);
    const rgb = Array.from({ length: height }, () => Buffer.from([255, 255, 254, ...Array(12).fill(0)]));
    await assert.rejects(readBinaryMask(png({ width, height, colour: 2, rows: rgb, step: 3 }), width, height), /could not be read/);
    const rgba = Array.from({ length: height }, () => Buffer.from([255, 255, 255, 254, ...Array(16).fill(255)]));
    await assert.rejects(readBinaryMask(png({ width, height, colour: 6, rows: rgba, step: 4 }), width, height), /could not be read/);
  });

  it('refuses malformed, truncated, oversized and wrongly sized files', async () => {
    const [width, height] = [6, 4], rows = greyRows(sample(width, height), width, height);
    const good = png({ width, height, rows });
    await assert.rejects(readBinaryMask(good, width + 1, height), /does not fit this photo/);
    const badCrc = good.slice(); badCrc[29] ^= 1;
    await assert.rejects(readBinaryMask(badCrc, width, height), /could not be read/, 'chunk checksum');
    await assert.rejects(readBinaryMask(good.slice(0, good.length - 6), width, height), /could not be read/, 'truncated');
    assert.deepEqual(await readBinaryMask(new Uint8Array([...good, 0, 1, 2]), width, height), sample(width, height), 'bytes after a zero-length IEND are ignored, as the server does');
    await assert.rejects(readBinaryMask(good.slice(8), width, height), /could not be read/, 'no signature');
    const nonEmptyEnd = Buffer.concat([Buffer.from(good.slice(0, good.length - 12)), chunk('IEND', Buffer.from([0]))]);
    await assert.rejects(readBinaryMask(new Uint8Array(nonEmptyEnd), width, height), /could not be read/, 'IEND with data, valid checksum');
    const extra = Buffer.concat([filtered(rows, [0], 1), Buffer.from([0])]);
    await assert.rejects(readBinaryMask(png({ width, height, raw: extra }), width, height), /could not be read/, 'more data than the image holds');
    await assert.rejects(readBinaryMask(png({ width, height, raw: filtered(rows, [0], 1).subarray(1) }), width, height), /could not be read/, 'less data than the image holds');
    const badFilter = filtered(rows, [0], 1); badFilter[0] = 5;
    await assert.rejects(readBinaryMask(png({ width, height, raw: badFilter }), width, height), /could not be read/, 'unknown row filter');
    await assert.rejects(readBinaryMask(png({ width, height, rows, before: [chunk('XXXX', Buffer.alloc(1))] }), width, height), /could not be read/, 'unknown critical chunk');
    assert.deepEqual(await readBinaryMask(png({ width, height, rows, before: [chunk('gAMA', Buffer.from([0, 0, 177, 143]))] }), width, height), sample(width, height), 'colour metadata is ignored, never applied');
    await assert.rejects(readBinaryMask(new Uint8Array(32 * 1024 * 1024 + 1), width, height), /could not be read/, 'over the size bound');
  });

  // Expectations follow the server validator (Pillow 13.0.0): 16-bit samples by
  // their high byte, tRNS keys by their low byte, grey with alpha only at 16
  // bits, interlaced files admitted.
  it('reads the 16-bit, grey-with-alpha, transparency-key and interlaced forms the validator admits', async () => {
    const [width, height] = [9, 7], mask = Uint8Array.from({ length: width * height }, (_, i) => ((i % width) * 3 + Math.floor(i / width)) % 4 === 0 ? 1 : 0);
    const at = (x, y) => mask[y * width + x];
    const s16 = (value) => [value >> 8, value & 255];
    const rows = (pixel) => Array.from({ length: height }, (_, y) => Buffer.from(Array.from({ length: width }, (_, x) => pixel(x, y)).flat()));
    const grey8 = rows((x, y) => [at(x, y) ? 255 : 0]);
    const tRNS = (...keys) => chunk('tRNS', Buffer.from(keys.flatMap(s16)));
    assert.deepEqual(await readBinaryMask(png({ width, height, depth: 16, colour: 2, rows: rows((x, y) => [s16(at(x, y) ? 0xff00 : 0x00ff), s16(at(x, y) ? 0xff00 : 0x00ff), s16(at(x, y) ? 0xff00 : 0x00ff)].flat()), step: 6 }), width, height), mask, 'RGB 16 by high byte');
    assert.deepEqual(await readBinaryMask(png({ width, height, depth: 16, colour: 6, rows: rows((x, y) => [...s16(at(x, y) ? 0xffff : 0), ...s16(at(x, y) ? 0xffff : 0), ...s16(at(x, y) ? 0xffff : 0), ...s16(0xff00)]), step: 8 }), width, height), mask, 'RGBA 16');
    await assert.rejects(readBinaryMask(png({ width, height, depth: 16, colour: 6, rows: rows((x, y) => [...s16(0), ...s16(0), ...s16(0), ...s16(0xfeff)]), step: 8 }), width, height), /could not be read/, 'alpha high byte below 255');
    assert.deepEqual(await readBinaryMask(png({ width, height, depth: 16, colour: 4, rows: rows((x, y) => [...s16(at(x, y) ? 0xffff : 0), ...s16(0xffff)]), step: 4 }), width, height), mask, 'grey with alpha 16');
    await assert.rejects(readBinaryMask(png({ width, height, depth: 8, colour: 4, rows: rows((x, y) => [at(x, y) ? 255 : 0, 255]), step: 2 }), width, height), /does not support/, 'grey with alpha 8');
    await assert.rejects(readBinaryMask(png({ width, height, depth: 16, colour: 0, rows: rows((x, y) => s16(at(x, y) ? 0xffff : 0)), step: 2 }), width, height), /does not support/, 'grey 16');
    await assert.rejects(readBinaryMask(png({ width, height, depth: 8, colour: 3, rows: grey8 }), width, height), /does not support/, 'palette');
    assert.deepEqual(await readBinaryMask(png({ width, height, rows: grey8, before: [tRNS(0x0080)] }), width, height), mask, 'an unused key changes nothing');
    await assert.rejects(readBinaryMask(png({ width, height, rows: grey8, before: [tRNS(0x0100)] }), width, height), /could not be read/, 'key low byte 0 makes black transparent');
    await assert.rejects(readBinaryMask(png({ width, height, rows: grey8, before: [chunk('tRNS', Buffer.from([0]))] }), width, height), /could not be read/, 'short key');
    await assert.rejects(readBinaryMask(png({ width, height, depth: 8, colour: 2, rows: rows((x, y) => Array(3).fill(at(x, y) ? 255 : 0)), step: 3, before: [tRNS(0x1200, 0x1200, 0x1200)] }), width, height), /could not be read/, 'RGB key by low byte');
    const adam7 = (pixel, bytesPerPixel) => {
      const out = [];
      for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
        const xs = []; for (let x = x0; x < width; x += dx) xs.push(x);
        const ys = []; for (let y = y0; y < height; y += dy) ys.push(y);
        if (!xs.length || !ys.length) continue;
        out.push(filtered(ys.map((y) => Buffer.from(xs.flatMap((x) => pixel(x, y)))), [0, 1, 2, 3, 4], bytesPerPixel));
      }
      return Buffer.concat(out);
    };
    assert.deepEqual(await readBinaryMask(png({ width, height, interlace: 1, raw: adam7((x, y) => [at(x, y) ? 255 : 0], 1) }), width, height), mask, 'interlaced grey');
    assert.deepEqual(await readBinaryMask(png({ width, height, colour: 6, interlace: 1, raw: adam7((x, y) => [...Array(3).fill(at(x, y) ? 255 : 0), 255], 4) }), width, height), mask, 'interlaced RGBA');
  });

  // Hand-authored Adam7 streams (PNG 3, 8.2): each non-empty pass is listed in
  // pass order as filter byte + samples; empty passes contribute nothing.
  it('places hand-authored interlaced samples for sizes with empty passes', async () => {
    const W = 255, B = 0;
    // 2x2: pass 1 (0,0); pass 6 (1,0); pass 7 row y=1: (0,1),(1,1).
    assert.deepEqual(await readBinaryMask(png({ width: 2, height: 2, interlace: 1, raw: Buffer.from([0, W, 0, B, 0, B, W]) }), 2, 2), Uint8Array.from([1, 0, 0, 1]));
    // 1x9: pass 1 y=0,8; pass 3 y=4; pass 5 y=2,6; pass 7 y=1,3,5,7.
    const column = [1, 0, 1, 1, 0, 0, 1, 0, 1].map((v) => (v ? W : B));
    const tall = Buffer.from([0, column[0], 0, column[8], 0, column[4], 0, column[2], 0, column[6], 0, column[1], 0, column[3], 0, column[5], 0, column[7]]);
    assert.deepEqual(await readBinaryMask(png({ width: 1, height: 9, interlace: 1, raw: tall }), 1, 9), Uint8Array.from([1, 0, 1, 1, 0, 0, 1, 0, 1]));
    // 9x1: pass 1 x=0,8; pass 2 x=4; pass 4 x=2,6; pass 6 x=1,3,5,7.
    const line = [0, 1, 1, 0, 1, 1, 0, 0, 1].map((v) => (v ? W : B));
    const wide = Buffer.from([0, line[0], line[8], 0, line[4], 0, line[2], line[6], 0, line[1], line[3], line[5], line[7]]);
    assert.deepEqual(await readBinaryMask(png({ width: 9, height: 1, interlace: 1, raw: wide }), 9, 1), Uint8Array.from([0, 1, 1, 0, 1, 1, 0, 0, 1]));
    // The same 9x1 stream with Sub filtering in pass 6 (filters apply to bytes before sample extraction).
    const sub = Buffer.from([0, line[0], line[8], 0, line[4], 0, line[2], line[6], 1, line[1], (line[3] - line[1]) & 255, (line[5] - line[3]) & 255, (line[7] - line[5]) & 255]);
    assert.deepEqual(await readBinaryMask(png({ width: 9, height: 1, interlace: 1, raw: sub }), 9, 1), Uint8Array.from([0, 1, 1, 0, 1, 1, 0, 0, 1]));
    // An extra row for an empty pass is surplus data and is refused.
    await assert.rejects(readBinaryMask(png({ width: 2, height: 2, interlace: 1, raw: Buffer.from([0, W, 0, B, 0, B, 0, B, W]) }), 2, 2), /could not be read/);
  });
});
