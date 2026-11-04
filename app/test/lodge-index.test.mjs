import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { checkEntryCss, checkEntryHtml, checkPng } from '../judge-entry.mjs';
import { decodeMask, decodeRleCounts, encodePng, overlayPng, renderOverlay } from '../lodge-overlays.mjs';
import { buildLodge, LODGE_NOUNS, LODGE_NOTES, LODGE_PHOTO_FILES, nounSlug, overlayName } from '../lodge-index.mjs';

const ENTRY = new URL('../entry/', import.meta.url);
const read = (name) => readFile(fileURLToPath(new URL(name, ENTRY)), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const data = JSON.parse(await read('lodge-index.json'));
const page = await read('lodge-index.html');
const { photos } = JSON.parse(await read('photos.json'));
const flat = data.photos.flatMap((photo) => photo.results.map((result) => ({ photo: photo.hbs, ...result })));

// Rebuilds the page, the data and every overlay from the committed instances alone. No private file is needed.
const rebuilt = buildLodge({ derived: { results: flat }, photos });

describe('lodge index data', () => {
  it('keeps all 30 outcomes: 3 photographs x 10 nouns, one image each, zero-match answers included', () => {
    assert.deepEqual(data.photos.map((photo) => photo.file), LODGE_PHOTO_FILES);
    assert.deepEqual(data.nouns, LODGE_NOUNS);
    assert.equal(flat.length, 30);
    assert.equal(data.requests, 30);
    for (const photo of data.photos) assert.deepEqual(photo.results.map((result) => result.noun), LODGE_NOUNS);
    assert.equal(new Set(flat.map((result) => result.responseId)).size, 30, 'every request has its own response id');
    for (const result of flat) {
      assert.match(result.responseId, /^resp_[0-9a-f]+$/);
      assert.match(result.requestDigest, /^[0-9a-f]{64}$/);
      assert.equal(result.imagesProcessed, 1);
      assert.equal(result.overlay === null, result.instances.length === 0, 'an overlay exists exactly when the model returned an instance');
    }
    assert.ok(flat.some((result) => result.instances.length === 0), 'zero-match answers are kept');
    assert.ok(flat.some((result) => result.instances.length > 0));
  });

  it('ties every outline to the exact pixel frame of its pinned photograph', () => {
    for (const photo of data.photos) {
      const pinned = photos.find((item) => item.file === photo.file);
      assert.equal(photo.sha256, pinned.sha256);
      assert.deepEqual([photo.width, photo.height], [pinned.width, pinned.height]);
      for (const result of photo.results) {
        for (const instance of result.instances) {
          const [x1, y1, x2, y2] = instance.box;
          assert.ok(x1 >= 0 && y1 >= 0 && x2 <= photo.width && y2 <= photo.height && x1 < x2 && y1 < y2, `${photo.hbs} ${result.noun} box inside the frame`);
          assert.deepEqual(instance.rle.size, [y2 - y1, x2 - x1], 'the mask raster is the box size');
          const mask = decodeMask(instance.rle);
          assert.equal(mask.reduce((sum, value) => sum + value, 0), instance.areaPx, 'decoded area equals the parser area');
          assert.ok(instance.confidence === null || (instance.confidence >= 0 && instance.confidence <= 1));
        }
      }
    }
  });

  it('holds no raw provider text, mask payload, local path, address or secret', () => {
    const text = JSON.stringify(data) + page;
    assert.ok(!/outputText|<\|mask|<\|box|<0f>|data=\d+,\d+,[~!]/.test(text), 'no raw provider output');
    assert.ok(!/\/(?:Users|private|tmp|home|var)\//.test(text), 'no local path');
    assert.ok(!text.includes('/api/'), 'no API route');
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), 'no email address');
    assert.ok(!/rhv_|sk-[A-Za-z0-9]|Bearer|MODEL_API_KEY|w3-lodge|lodge-index-batch/.test(text), 'no capability, key or internal batch id');
    assert.deepEqual(Object.keys(data), ['note', 'model', 'modelId', 'parser', 'requests', 'listPriceEstimateUsd', 'nouns', 'overlays', 'photos']);
  });
});

describe('lodge index overlays', () => {
  it('decodes a hand-made COCO run-length string column by column', () => {
    // COCO stores each run from the fourth on as the difference to the run two places earlier: runs 1, 2, 1, 2 read '1', '2', '1', '0'.
    assert.deepEqual(decodeRleCounts('1210'), [1, 2, 1, 2]);
    const mask = decodeMask({ size: [2, 3], counts: '1210' });
    // column 0 = (row0 = 0, row1 = 1); column 1 = (row0 = 1, row1 = 0); column 2 = (1, 1)
    assert.deepEqual([...mask], [0, 1, 1, 1, 0, 1]);
    assert.throws(() => decodeMask({ size: [2, 3], counts: '1' }), /does not cover/);
    assert.throws(() => decodeMask({ size: [2, 3], counts: '9999' }), /longer than its mask/);
  });

  it('writes a deterministic PNG with only IHDR, IDAT and IEND at the exact photograph size', () => {
    const photo = data.photos[2];
    const result = photo.results.find((item) => item.noun === 'chair');
    const first = overlayPng({ width: photo.width, height: photo.height, instances: result.instances, noun: 'chair' });
    const second = overlayPng({ width: photo.width, height: photo.height, instances: result.instances, noun: 'chair' });
    assert.ok(first.equals(second), 'the same input always gives the same bytes');
    checkPng(first, 'a26 chair overlay');
    assert.equal(first.readUInt32BE(16), photo.width);
    assert.equal(first.readUInt32BE(20), photo.height);
    const chunks = [];
    for (let at = 8; at < first.length; at += 12 + first.readUInt32BE(at)) chunks.push(first.toString('latin1', at + 4, at + 8));
    assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
  });

  it('paints only inside the instance boxes and leaves the rest of the photograph untouched', () => {
    const instance = flat.find((result) => result.photo === 'AZ-135-A-26' && result.noun === 'chair').instances[0];
    const rgba = renderOverlay({ width: 1920, height: 1546, instances: [instance], color: [10, 20, 30] });
    const [x1, y1, x2, y2] = instance.box;
    let painted = 0;
    for (let y = 0; y < 1546; y += 1) {
      for (let x = 0; x < 1920; x += 1) {
        if (rgba[(y * 1920 + x) * 4 + 3] === 0) continue;
        painted += 1;
        assert.ok(x >= x1 && x < x2 && y >= y1 && y < y2, 'painted pixel outside the box');
      }
    }
    assert.equal(painted, instance.areaPx, 'every mask pixel, and only those, is painted');
    assert.throws(() => renderOverlay({ width: 100, height: 100, instances: [instance], color: [0, 0, 0] }), /does not fit/);
  });

  it('rebuilds every listed overlay byte for byte and passes the entry PNG gate', () => {
    assert.deepEqual(rebuilt.data.overlays, data.overlays, 'the listed size and SHA-256 are those of the regenerated files');
    assert.equal(data.overlays.length, flat.filter((result) => result.instances.length).length);
    assert.ok(data.overlays.length <= 64);
    for (const item of data.overlays) {
      assert.match(item.file, /^[a-z0-9][a-z0-9-]{0,63}\.png$/);
      const bytes = rebuilt.overlayFiles.get(item.file);
      assert.equal(bytes.length, item.bytes);
      assert.ok(bytes.length <= 2 * 1024 * 1024);
      assert.equal(sha256(bytes), item.sha256);
      checkPng(bytes, item.file);
    }
  });

  it('refuses a PNG that carries a text chunk', () => {
    const png = encodePng({ width: 2, height: 2, rgba: Buffer.alloc(16) });
    checkPng(png, 'plain');
    const body = Buffer.from('tEXtComment\0hello', 'latin1');
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(body.length - 4, 0);
    body.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(body), body.length + 4);
    const withText = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    assert.throws(() => checkPng(withText, 'tampered'), /tEXt|chunk/i);
  });
});

describe('lodge index page', () => {
  it('is exactly what the builder writes from the committed data (no drift)', () => {
    assert.deepEqual(rebuilt.data, data);
    assert.equal(rebuilt.html, page);
  });

  it('shows the sourced A-16 chair result before the guide and keeps every response once', () => {
    const chair = flat.find((result) => result.photo === 'AZ-135-A-16' && result.noun === 'chair');
    const proof = page.indexOf(`Response <code>${chair.responseId}</code>`);
    assert.ok(page.indexOf(photos[0].locUrl) < proof);
    assert.ok(page.indexOf('Rights: a U.S. Government work') < proof);
    assert.ok(proof < page.indexOf('How to read this page'));
    assert.ok(page.indexOf(LODGE_NOTES['AZ-135-A-16/chair']) < page.indexOf('How to read this page'));
    for (const result of flat) assert.equal(page.split(`Response <code>${result.responseId}</code>`).length - 1, 1);
  });

  it('passes the entry gate without style, script, unapproved links or unlisted files', async () => {
    const targets = ['lodge-index.html', 'lodge-index.json', 'index.html', ...data.overlays.map((item) => `entry/lodge/${item.file}`)];
    checkEntryHtml(page, photos, { requirePhotos: false, targets });
    checkEntryCss(await read('entry.css'));
    const withoutTargets = (html) => checkEntryHtml(html, photos, { requirePhotos: false, targets: ['lodge-index.html', 'index.html'] });
    assert.throws(() => withoutTargets(page), /unlisted file/, 'an overlay that is not listed would be refused');
    assert.ok(!/<style|<script|\sstyle=|\son[a-z]+=/i.test(page));
  });

  it('is labelled as 2D model estimates and makes no 3D, stitching or accuracy claim', () => {
    assert.match(page, /<h1>What SAM 3\.1 \(Meta Model API\) outlines in the lodge photographs: model estimates, not measurements<\/h1>/);
    assert.match(page, /not a measure of accuracy/);
    assert.match(page, /observed (?:model )?answer, not (?:proof|evidence)/);
    assert.match(page, /Missed objects and merged or loose outlines are left in/);
    assert.match(page, /Nothing here is a 3D model, a stitched room or a reconstruction/);
    assert.match(page, /not the outlines used in the reconstructed scene/);
    const lede = /<p class="lede">([^<]*)<\/p>/.exec(page)[1];
    assert.match(lede, /made for this index page and are separate from the outlines used in the reconstructed scene/, 'stated above the fold, in the opening paragraph');
    for (const claim of [/accurate/i, /\bground-truth(?:ed)?\b/i, /full reconstruction/i, /completes? the room/i]) assert.ok(!claim.test(page), String(claim));
  });

  it('gives every photograph its caption, source links and rights line, and every overlay its alt text', () => {
    for (const photo of photos.filter((item) => LODGE_PHOTO_FILES.includes(item.file))) {
      assert.ok(page.includes(photo.caption), `${photo.hbs} caption`);
      assert.ok(page.includes(photo.locUrl) && page.includes(photo.commonsUrl), `${photo.hbs} source links`);
      assert.ok(page.includes(photo.sha256), `${photo.hbs} pinned SHA-256`);
    }
    assert.ok(page.includes('https://www.loc.gov/rr/print/res/114_habs.html'));
    assert.equal((page.match(/No known restrictions|no known restrictions/g) ?? []).length, 3);
    for (const [, alt] of page.matchAll(/<img [^>]*alt="([^"]*)"/g)) assert.ok(alt.length >= 12);
    for (const item of data.overlays) assert.ok(page.includes(`src="entry/lodge/${item.file}"`), item.file);
    assert.equal((page.match(/class="lodge-card"/g) ?? []).length, 30, 'all 30 outcomes are shown, zero-match ones too');
    assert.equal((page.match(/The model returned no instance for this noun/g) ?? []).length, flat.filter((result) => result.instances.length === 0).length);
  });

  it('shows each confidence as the model\'s own number and notes only results that were looked at', () => {
    assert.equal((page.match(/The confidence is the model's own number, not a measure of accuracy/g) ?? []).length, data.overlays.length);
    for (const key of Object.keys(LODGE_NOTES)) {
      const [hbs, noun] = key.split('/');
      assert.ok(flat.some((result) => result.photo === hbs && result.noun === noun && result.instances.length > 0), `${key} has a result to look at`);
    }
    assert.equal(overlayName({ file: 'a16.jpg' }, 'rocking chair'), 'a16-rocking-chair.png');
    assert.equal(nounSlug('rocking chair'), 'rocking-chair');
  });
});
