import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportStaticVisit } from '../export-static-visit.mjs';
import { checkEntryHtml, fetchFromExport, loadEntry, stripJpegMetadata, verifyExportFolder } from '../judge-entry.mjs';

const ENTRY = fileURLToPath(new URL('../entry/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-entry-'));
  tempDirs.push(dir);
  return dir;
};
const walk = async (dir, base = dir) => (await readdir(dir, { withFileTypes: true })).reduce(async (all, item) => {
  const found = await all;
  const full = path.join(dir, item.name);
  return item.isDirectory() ? [...found, ...await walk(full, base)] : [...found, path.relative(base, full).split(path.sep).join('/')];
}, Promise.resolve([]));

// A small JPEG: SOI, JFIF, an Exif block, a comment, then a scan.
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const jpegWith = (...extra) => Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), ...extra, segment(0xdb, Buffer.alloc(65, 3)), Buffer.from([0xff, 0xda, 0, 3, 0, 1, 2, 3, 0xff, 0xd9])]);
const EXIF = segment(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\b\0\0', 'latin1'));
const PHOTOSHOP = segment(0xed, Buffer.from('Photoshop 3.0\0abc', 'latin1'));
const COMMENT = segment(0xfe, Buffer.from('a private note', 'latin1'));

describe('metadata strip', () => {
  it('drops Exif, Photoshop and comment segments and keeps the rest byte for byte', () => {
    const clean = stripJpegMetadata(jpegWith(EXIF, PHOTOSHOP, COMMENT));
    assert.deepEqual(clean, jpegWith());
    assert.ok(!clean.includes(Buffer.from('Exif')) && !clean.includes(Buffer.from('private note')));
    assert.deepEqual(stripJpegMetadata(jpegWith()), jpegWith(), 'a JPEG without metadata is unchanged');
  });

  it('refuses a file that is not a JPEG or whose segment runs past the end', () => {
    assert.throws(() => stripJpegMetadata(Buffer.from('GIF89a')), /Not a JPEG/);
    assert.throws(() => stripJpegMetadata(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff]), Buffer.alloc(8)])), /past the end/);
  });
});

describe('the entry page and its pinned photographs', () => {
  it('lists exactly the three approved photographs with verbatim captions and source links', async () => {
    const { photos } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
    assert.deepEqual(photos.map((photo) => [photo.hbs, photo.caption]), [
      ['AZ-135-A-16', 'INTERIOR VIEW OF DINING ROOM OF MAIN LODGE'],
      ['AZ-135-A-19', 'INTERIOR VIEW OF RECREATION ROOM OF MAIN LODGE LOOKING EAST'],
      ['AZ-135-A-26', 'WICKER CHEST AND ROCKING CHAIR'],
    ]);
    for (const photo of photos) {
      assert.match(photo.locUrl, /^https:\/\/www\.loc\.gov\/pictures\/item\/az0459\.photos\.\d+p\/$/);
      assert.match(photo.commonsUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      assert.match(photo.sourceUrl, /^https:\/\/upload\.wikimedia\.org\/|^https:\/\/thumb\.wikimedia\.org\//);
      assert.match(photo.sourceSha256, /^[0-9a-f]{64}$/);
      assert.match(photo.sha256, /^[0-9a-f]{64}$/);
      assert.ok(photo.bytes < photo.sourceBytes && photo.bytes > 100_000);
      assert.ok(photo.alt.length > 40 && !/outdoor|grass|tree|forest|terrace|garden/i.test(photo.alt), 'alt text describes the photograph without naming a setting');
    }
  });

  it('carries the approved copy and no claim beyond it', async () => {
    const html = await readFile(path.join(ENTRY, 'index.html'), 'utf8');
    for (const text of [
      'Three photographs of a place that is gone. One has been rebuilt as a partial scene.',
      'The Grand Canyon Lodge on the North Rim was lost in the Dragon Bravo Fire in July 2025.',
      'National Park Service, July 13, 2025',
      'Shown here as a photograph only; no reconstructed scene is included for this stop.',
      'The one partial scene in this demo: only what the camera saw is rebuilt, and unseen surfaces stay empty. One owner-approved change turns the chest by 5 degrees; the earlier version is one click away.',
      'Notes, the voice and the contributor in this demo are labelled synthetic test material; all roles are played by the demo operator.',
      'This is a read-only offline copy: withdrawal is enforced only in the running app.',
      'a U.S. Government work with no known restrictions on images made by the U.S. Government',
      'snapshot.html?version=Alternative%20arrangement%202',
    ]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /\bhero\b|stitch|validated|participant|Muse Image|live backend|public domain|\b(left|right)\b/i);
    assert.doesNotMatch(html, /Brand|ABC15/, 'the video-only quotation is not on the site');
    assert.equal(html.split('Shown here as a photograph only; no reconstructed scene is included for this stop.').length - 1, 2, 'both photograph-only stops carry the scoped sentence');
    assert.doesNotMatch(html, /No scene has been built/, 'no claim that a build has never happened');
  });

  it('accepts the real page and refuses scripts, styles, handlers, other links, missing alt text or captions', async () => {
    const { photos } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
    const html = await readFile(path.join(ENTRY, 'index.html'), 'utf8');
    assert.equal(checkEntryHtml(html, photos), html);
    const bad = (change, pattern) => assert.throws(() => checkEntryHtml(change(html), photos), pattern);
    bad((h) => h.replace('</head>', '<style>p{}</style></head>'), /inline styles/);
    bad((h) => h.replace('<body>', '<body onload="x()">'), /inline styles|handlers/);
    bad((h) => h.replace('</body>', '<script>1</script></body>'), /scripts/);
    bad((h) => h.replace('<p class="brand">', '<p style="color:red" class="brand">'), /inline styles/);
    bad((h) => h.replace('https://github.com/BeomSeogKim/rehere"', 'https://example.org/track"'), /approved source/);
    bad((h) => h.replace('href="entry.css"', 'href="/entry.css"'), /root-absolute/);
    bad((h) => h.replace('href="snapshot.html?version=Alternative%20arrangement%202"', 'href="other.html"'), /unlisted file/);
    bad((h) => h.replace(/alt="[^"]*"/, 'alt="x"'), /alt text/);
    bad((h) => h.replace('WICKER CHEST AND ROCKING CHAIR', 'A chest and a chair'), /verbatim caption/);
    bad((h) => h.replace(photos[0].locUrl, 'https://www.loc.gov/'), /source links|approved source/);
    bad((h) => h.replace('<html lang="en">', '<html>'), /lang/);
  });
});

describe('building a site from an earlier export with an entry', () => {
  const TOKEN = `rhv_${'D'.repeat(43)}`;
  const JPEG_PLAIN = jpegWith();

  async function earlierExport() {
    const viewId = randomUUID();
    const manifest = { id: randomUUID(), title: 'Synthetic test place', synthetic: true, startViewId: viewId, views: [{ id: viewId, label: 'Original photograph' }], stories: [], contributorPhotos: [], contributorRecordings: [] };
    const routes = new Map([['/api/visit', Buffer.from(JSON.stringify(manifest))], [`/api/visit/assets/${viewId}/surface.json`, Buffer.from('{"synthetic":true}')], [`/api/visit/assets/${viewId}/texture.jpg`, JPEG_PLAIN]]);
    const server = http.createServer((req, res) => {
      const body = req.headers.authorization === `Bearer ${TOKEN}` ? routes.get(req.url) : undefined;
      res.writeHead(body ? 200 : 404).end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const outDir = path.join(await tempDir(), 'earlier');
      await exportStaticVisit({ origin: `http://127.0.0.1:${server.address().port}`, token: TOKEN, outDir, confirmPublicMaterial: true });
      return outDir;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // The real entry files, with the photograph pins replaced by pins of small synthetic files.
  async function entryAndPhotos() {
    const base = await tempDir();
    const entryDir = path.join(base, 'entry');
    const photosDir = path.join(base, 'photos');
    await cp(ENTRY, entryDir, { recursive: true });
    const config = JSON.parse(await readFile(path.join(entryDir, 'photos.json'), 'utf8'));
    await mkdir(photosDir);
    for (const [index, photo] of config.photos.entries()) {
      const bytes = jpegWith(segment(0xe2, Buffer.from(`photo-${index}`.padEnd(16, 'x'), 'latin1')));
      await writeFile(path.join(photosDir, photo.file), bytes);
      Object.assign(photo, { bytes: bytes.length, sha256: sha256(bytes) });
    }
    await writeFile(path.join(entryDir, 'photos.json'), `${JSON.stringify(config, null, 2)}\n`);
    return { entry: { dir: entryDir, photosDir }, photos: config.photos };
  }

  it('verifies an earlier export before trusting it', async () => {
    const earlier = await earlierExport();
    assert.ok(await verifyExportFolder(earlier) > 20);
    await writeFile(path.join(earlier, 'extra.txt'), 'x');
    await assert.rejects(verifyExportFolder(earlier), /unlisted files: extra\.txt/);
    await rm(path.join(earlier, 'extra.txt'));
    await writeFile(path.join(earlier, 'offline.css'), 'tampered');
    await assert.rejects(verifyExportFolder(earlier), /differs from its record: offline\.css/);
  });

  it('rebuilds identical snapshot data from the earlier export, with the entry as the front door', async () => {
    const earlier = await earlierExport();
    const { entry, photos } = await entryAndPhotos();
    const outDir = path.join(await tempDir(), 'site');
    const result = await exportStaticVisit({
      origin: 'http://snapshot.invalid', token: `rhv_${'E'.repeat(43)}`, outDir, confirmPublicMaterial: true, fetchImpl: fetchFromExport(earlier), entry,
    });
    assert.equal(result.entry, true);
    const files = await walk(outDir);
    for (const name of ['index.html', 'snapshot.html', 'entry.css', ...photos.map((photo) => `entry/${photo.file}`), 'EXPORT.json', 'LICENSE', 'static-entry.js']) assert.ok(files.includes(name), name);
    for (const name of files.filter((file) => file.startsWith('data/'))) assert.deepEqual(await readFile(path.join(outDir, name)), await readFile(path.join(earlier, name)), name);
    assert.match(await readFile(path.join(outDir, 'index.html'), 'utf8'), /Three photographs of a place that is gone/);
    const snapshot = await readFile(path.join(outDir, 'snapshot.html'), 'utf8');
    assert.match(snapshot, /Offline snapshot\./);
    assert.match(snapshot, /<a href="\.\/">Back to the entry page<\/a>/);
    assert.doesNotMatch(snapshot, /Three photographs/);
    const listing = JSON.parse(await readFile(path.join(outDir, 'EXPORT.json'), 'utf8')).files;
    assert.deepEqual(listing.map((item) => item.path).sort(), files.filter((file) => file !== 'EXPORT.json').sort());
    for (const item of listing) assert.equal(sha256(await readFile(path.join(outDir, item.path))), item.sha256, item.path);
    assert.equal(await verifyExportFolder(outDir), listing.length, 'the new site passes the same closed-inventory check the publish workflow applies');
  });

  it('without an entry the site is unchanged: index.html is the snapshot page', async () => {
    const earlier = await earlierExport();
    const outDir = path.join(await tempDir(), 'plain');
    await exportStaticVisit({ origin: 'http://snapshot.invalid', token: `rhv_${'F'.repeat(43)}`, outDir, confirmPublicMaterial: true, fetchImpl: fetchFromExport(earlier) });
    const files = await walk(outDir);
    assert.ok(files.includes('index.html') && !files.includes('snapshot.html') && !files.some((file) => file.startsWith('entry')));
    assert.doesNotMatch(await readFile(path.join(outDir, 'index.html'), 'utf8'), /Back to the entry page/);
  });

  it('refuses a photograph that differs from its pin, still has metadata, or is missing', async () => {
    const earlier = await earlierExport();
    const run = async (mutate) => {
      const { entry, photos } = await entryAndPhotos();
      await mutate(entry, photos);
      return exportStaticVisit({ origin: 'http://snapshot.invalid', token: `rhv_${'G'.repeat(43)}`, outDir: path.join(await tempDir(), 'x'), confirmPublicMaterial: true, fetchImpl: fetchFromExport(earlier), entry });
    };
    await assert.rejects(run((entry, photos) => writeFile(path.join(entry.photosDir, photos[0].file), jpegWith(segment(0xe0, Buffer.from('changed-bytes', 'latin1'))))), /differs from its pinned size or SHA-256/);
    await assert.rejects(run(async (entry, photos) => {
      const withExif = jpegWith(EXIF);
      await writeFile(path.join(entry.photosDir, photos[1].file), withExif);
      const config = JSON.parse(await readFile(path.join(entry.dir, 'photos.json'), 'utf8'));
      Object.assign(config.photos[1], { bytes: withExif.length, sha256: sha256(withExif) });
      await writeFile(path.join(entry.dir, 'photos.json'), JSON.stringify(config));
    }), /metadata block/);
    await assert.rejects(run((entry, photos) => rm(path.join(entry.photosDir, photos[2].file))), /ENOENT/);
  });

  it('serves only the files an earlier export wrote and answers everything else with 404', async () => {
    const earlier = await earlierExport();
    const get = fetchFromExport(earlier);
    assert.equal((await get('http://x.invalid/api/visit')).status, 200);
    for (const bad of ['/api/visit/assets/../../EXPORT.json', '/api/visit/assets/abc/surface.json', '/api/owner', '/api/visit/stories/not-a-uuid/audio.wav', '/EXPORT.json']) {
      assert.equal((await get(`http://x.invalid${bad}`)).status, 404, bad);
    }
  });
});
