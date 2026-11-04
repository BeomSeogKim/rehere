import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { exportStaticVisit } from '../export-static-visit.mjs';
import { pcmWav } from '../audio-derivative.mjs';
import { checkEntryAgainstSnapshot, checkEntryCss, checkEntryHtml, checkPng, fetchFromExport, loadEntry, stripJpegMetadata, verifyExportFolder } from '../judge-entry.mjs';

const ENTRY = fileURLToPath(new URL('../entry/', import.meta.url));
const { route: PENN_ROUTE } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
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

// A small PNG built chunk by chunk, so a test can add a forbidden chunk, break a checksum or append data.
const chunk = (type, data = Buffer.alloc(0)) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, crc]);
};
const header = (width, height) => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.set([8, 6, 0, 0, 0], 8);
  return data;
};
function png({ width = 4, height = 4, extra = [], tail = Buffer.alloc(0), noEnd = false, idat = null, ihdr = null } = {}) {
  const image = idat ?? deflateSync(Buffer.alloc(height * (1 + width * 4)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr ?? chunk('IHDR', header(width, height)), ...extra, chunk('IDAT', image), ...(noEnd ? [] : [chunk('IEND')]), tail]);
}

describe('overlay images', () => {
  it('accepts a plain PNG and refuses every way of carrying more than an image', () => {
    assert.deepEqual(checkPng(png({ extra: [chunk('pHYs', Buffer.alloc(9)), chunk('sRGB', Buffer.from([0]))] })), { width: 4, height: 4 });
    for (const [name, bytes, message] of [
      ['not a PNG', Buffer.from('GIF89a'.repeat(10)), /not a PNG/],
      ['tEXt', png({ extra: [chunk('tEXt', Buffer.from('Comment\0private'))] }), /tEXt chunk/],
      ['iTXt', png({ extra: [chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0x'))] }), /iTXt chunk/],
      ['eXIf', png({ extra: [chunk('eXIf', Buffer.from('MM\0*'))] }), /eXIf chunk/],
      ['tIME', png({ extra: [chunk('tIME', Buffer.alloc(7))] }), /tIME chunk/],
      ['iCCP', png({ extra: [chunk('iCCP', Buffer.from('p\0\0x'))] }), /iCCP chunk/],
      ['a private chunk', png({ extra: [chunk('prVt', Buffer.from('x'))] }), /prVt chunk/],
      ['data after IEND', png({ tail: Buffer.from('trailing bytes') }), /after its end chunk|truncated/],
      ['no IEND', png({ noEnd: true }), /incomplete/],
      ['header not first', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('sRGB', Buffer.from([0])), chunk('IHDR', header(4, 4)), chunk('IDAT', deflateSync(Buffer.alloc(80))), chunk('IEND')]), /does not start with its header/],
      ['a second header', png({ extra: [chunk('IHDR', header(4, 4))] }), /malformed header/],
      ['too wide', png({ width: 5000, height: 1 }), /pixels on a side/],
      ['zero height', png({ ihdr: chunk('IHDR', header(4, 0)) }), /pixels on a side/],
      ['image data bigger than the header declares', png({ idat: deflateSync(Buffer.alloc(100_000)) }), /does not decode within its declared size/],
      ['image data that is not zlib', png({ idat: Buffer.from('not zlib data') }), /does not decode/],
    ]) assert.throws(() => checkPng(bytes, 'x.png'), message, name);
    const broken = png();
    broken[broken.length - 20] ^= 0xff;
    assert.throws(() => checkPng(broken, 'x.png'), /bad checksum|does not decode/);
    assert.throws(() => checkPng(Buffer.alloc(3 * 1024 ** 2, 1), 'x.png'), /larger than/);
  });
});

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
  it('pins the Penn source and retains all three Lodge appendix photographs', async () => {
    const { photos } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
    assert.deepEqual(photos.map((photo) => [photo.hbs, photo.caption]), [
      ['AZ-135-A-16', 'INTERIOR VIEW OF DINING ROOM OF MAIN LODGE'],
      ['AZ-135-A-19', 'INTERIOR VIEW OF RECREATION ROOM OF MAIN LODGE LOOKING EAST'],
      ['AZ-135-A-26', 'WICKER CHEST AND ROCKING CHAIR'],
      ['NY-5471', 'Main concourse of Pennsylvania Station, New York City on April 24, 1962'],
    ]);
    const penn = photos.find((photo) => photo.file === 'penn8.jpg');
    assert.equal(penn.sourceSha256, '80a4e27ca08caf3d3ad9e90df603725584e42c3ab8ae2addf39dc4c4b1b5a026');
    assert.equal(penn.sha256, 'a30e687411342a1c5d9d2854dc8ecec8334b92d99d7c058921b4343a92229bf1');
    assert.deepEqual([penn.sourceBytes, penn.bytes, penn.width, penn.height], [4175148, 4174944, 4715, 3350]);
    for (const photo of photos) {
      if (photo.locUrl) assert.match(photo.locUrl, /^https:\/\/www\.loc\.gov\/pictures\/item\/az0459\.photos\.\d+p\/$/);
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
      'Show a place you remember to someone you love.',
      'Visit the saved scene',
      'Compare the photograph with the saved scene and its labelled sources.',
      "New York's original Penn Station, demolished in 1963",
      'empty and torn edges',
      'Story, voice and notes are synthetic demonstration material',
      'Synthetic voice (OpenAI TTS)',
      'whole-track cue is copied manually from that script',
      'Listening and editorial review are pending.',
      'not a newly saved story in the running app',
      'The clock change is a demonstration hypothesis',
      'previewed and approved by the demo owner',
      'local SAM 2.1, with local depth estimation',
      'This scene does not use SAM 3.1',
      'this copy does not follow later withdrawal',
      'No known restrictions on images made by the U.S. Government.',
      'snapshot.html?version=Saved%20version%201',
      'snapshot.html?version=Saved%20version%202',
      'href="lodge-index.html"',
    ]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /Dragon Bravo|National Park Service|Alternative%20arrangement|turns the chest|public domain/);
    assert.ok(html.indexOf('id="scene"') < html.indexOf('id="appendix"'));
    assert.equal(html.split('Shown here as an archival photograph only; no Lodge scene is included in this export.').length - 1, 3);
    assert.doesNotMatch(html, /No scene has been built/, 'no claim that a build has never happened');
  });

  it('accepts the real page and refuses scripts, styles, handlers, other links, missing alt text or captions', async () => {
    const { photos } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
    const html = await readFile(path.join(ENTRY, 'index.html'), 'utf8');
    const withPage = { targets: ['lodge-index.html'] };
    assert.equal(checkEntryHtml(html, photos, withPage), html);
    assert.throws(() => checkEntryHtml(html, photos), /unlisted file: lodge-index\.html/, 'the link to the second page is refused when that page is not part of the build');
    assert.equal(html.split('href="lodge-index.html"').length - 1, 1, 'one link to the second page');
    const bad = (change, pattern) => assert.throws(() => checkEntryHtml(change(html), photos, withPage), pattern);
    bad((h) => h.replace('</head>', '<style>p{}</style></head>'), /inline styles/);
    bad((h) => h.replace('<body>', '<body onload="x()">'), /inline styles|handlers/);
    bad((h) => h.replace('</body>', '<script>1</script></body>'), /scripts/);
    bad((h) => h.replace('<p class="brand">', '<p style="color:red" class="brand">'), /inline styles/);
    bad((h) => h.replace('https://github.com/BeomSeogKim/rehere"', 'https://example.org/track"'), /approved source/);
    bad((h) => h.replace('href="entry.css"', 'href="/entry.css"'), /only its own entry\.css/);
    bad((h) => h.replace('<p class="brand">', '<p class="brand"><a href="/elsewhere">x</a>'), /root-absolute/);
    bad((h) => h.replace('href="snapshot.html?version=Saved%20version%201"', 'href="other.html"'), /unlisted file/);
    bad((h) => h.replace(/alt="[^"]*"/, 'alt="x"'), /alt text/);
    bad((h) => h.replace('WICKER CHEST AND ROCKING CHAIR', 'A chest and a chair'), /verbatim caption/);
    bad((h) => h.replace(photos[0].locUrl, 'https://www.loc.gov/'), /source links|approved source/);
    bad((h) => h.replace('<html lang="en">', '<html>'), /lang/);
  });
});

describe('entry page gate against attacker-style forms', () => {
  it('refuses every way of reaching an unapproved address, however it is quoted or cased', async () => {
    const { photos } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
    const html = await readFile(path.join(ENTRY, 'index.html'), 'utf8');
    const add = (fragment) => html.replace('<p class="brand">Rehere</p>', `${fragment}<p class="brand">Rehere</p>`);
    for (const fragment of [
      '<a HREF="https://evil.example/">x</a>', "<a href='https://evil.example/'>x</a>", '<a href=https://evil.example/>x</a>', '<A Href = "https://evil.example/">x</A>',
      '<a href="//evil.example/">x</a>', '<a href="mailto:someone@example.com">x</a>', '<a href="javascript:void(0)">x</a>', '<a href="data:text/html,x">x</a>',
      '<img src="https://tracker.example/p.gif" alt="a tracking pixel for a test">', '<img src="entry/a16.jpg" srcset="https://tracker.example/p.jpg 1x" alt="a photograph for a test">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">', '<link rel="preload" href="https://evil.example/x">', '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<img src="entry/a16.jpg" onerror ="x()" alt="a photograph for a test">', '<svg/onload="x()"></svg>', '<iframe src="entry/a16.jpg"></iframe>', '<form action="https://evil.example/"></form>', '<base href="https://evil.example/">',
    ]) assert.throws(() => checkEntryHtml(add(fragment), photos, { targets: ['lodge-index.html'] }), /inline styles|approved source|http-equiv|only its own|root-absolute|unlisted/, fragment);
  });

  it('refuses a stylesheet that imports or loads anything', () => {
    for (const css of ['@import "x.css";', 'a{background:url(https://evil.example/x.png)}', 'a { background : URL ( x.png ) }', 'a{behavior:url(x)}']) assert.throws(() => checkEntryCss(css), /import or load/, css);
    assert.equal(checkEntryCss('a { color: red; }'), 'a { color: red; }');
  });
});

describe('building a site from an earlier export with an entry', () => {
  const TOKEN = `rhv_${'D'.repeat(43)}`;
  const JPEG_PLAIN = jpegWith();

  const edit = (yaw) => ({ offset: [0, 0, 0], yaw });
  const childViews = (overrides = {}) => [
    { id: PENN_ROUTE.original.viewId, label: 'Saved version 1', edit: edit(0), evidence: { arrangement: 'initial' } },
    { id: PENN_ROUTE.approved.viewId, label: 'Saved version 2', edit: edit((-10 * Math.PI) / 180), evidence: { arrangement: 'memory' }, ...overrides },
  ];
  const WAV = pcmWav(Buffer.alloc(PENN_ROUTE.story.audioBytes - 44));
  const snapshot = (views = childViews()) => ({
    id: PENN_ROUTE.snapshotId, title: 'Synthetic test place', synthetic: true, startViewId: views[0].id, views,
    stories: [{ id: PENN_ROUTE.storyId, viewId: PENN_ROUTE.original.viewId, target: structuredClone(PENN_ROUTE.story.target), title: PENN_ROUTE.story.title, providerLabel: PENN_ROUTE.story.providerLabel, captionAuthorLabel: PENN_ROUTE.story.captionAuthorLabel, durationMs: PENN_ROUTE.story.durationMs,
      cues: structuredClone(PENN_ROUTE.story.cues), audio: { type: 'audio/wav', size: WAV.length } }],
    contributorPhotos: [], contributorRecordings: [],
  });

  async function earlierExport(views = childViews()) {
    const viewId = views[0].id;
    const manifest = snapshot(views);
    const routes = new Map([['/api/visit', Buffer.from(JSON.stringify(manifest))], [`/api/visit/assets/${viewId}/surface.json`, Buffer.from('{"synthetic":true}')], [`/api/visit/assets/${viewId}/texture.jpg`, JPEG_PLAIN], [`/api/visit/stories/${PENN_ROUTE.storyId}/audio.wav`, WAV]]);
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

  // The real entry and appendix files (the real lodge index page is tested in lodge-index.test.mjs; withLodge adds a synthetic one
  // where a test needs a second page), with the photograph pins replaced by pins of small synthetic files.
  async function entryAndPhotos() {
    const base = await tempDir();
    const entryDir = path.join(base, 'entry');
    const photosDir = path.join(base, 'photos');
    await cp(ENTRY, entryDir, { recursive: true, filter: (source) => !path.basename(source).startsWith('lodge-index.') });
    // Without the second page the link to it must go too, or the gate (rightly) refuses the folder.
    const page = await readFile(path.join(entryDir, 'index.html'), 'utf8');
    const withoutLink = page.replace(/\n +<p class="route"><a href="lodge-index\.html">[^\n]*<\/p>/, '');
    assert.notEqual(withoutLink, page, 'the real entry page links to the second page');
    await writeFile(path.join(entryDir, 'index.html'), withoutLink);
    const config = JSON.parse(await readFile(path.join(entryDir, 'photos.json'), 'utf8'));
    await mkdir(photosDir);
    for (const [index, photo] of config.photos.entries()) {
      const bytes = jpegWith(segment(0xe2, Buffer.from(`photo-${index}`.padEnd(16, 'x'), 'latin1')));
      await writeFile(path.join(photosDir, photo.file), bytes);
      Object.assign(photo, { bytes: bytes.length, sha256: sha256(bytes) });
    }
    config.route.story.audioSha256 = sha256(WAV);
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

  it('rejects an earlier export that lists a file not in the folder', async () => {
    const earlier = await earlierExport();
    const recordPath = path.join(earlier, 'EXPORT.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    const original = record.files[0].path;
    record.files[0] = { ...record.files[0], path: '../outside.txt' };
    await writeFile(recordPath, JSON.stringify(record));
    await rm(path.join(earlier, original));
    await assert.rejects(verifyExportFolder(earlier), /not in the folder/);

    const later = await earlierExport();
    const laterRecordPath = path.join(later, 'EXPORT.json');
    const laterRecord = JSON.parse(await readFile(laterRecordPath, 'utf8'));
    const laterOriginal = laterRecord.files[0].path;
    laterRecord.files[0] = { ...laterRecord.files[0], path: 'missing-inside.txt' };
    await writeFile(laterRecordPath, JSON.stringify(laterRecord));
    await rm(path.join(later, laterOriginal));
    await assert.rejects(verifyExportFolder(later), /not in the folder/);
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
    assert.match(await readFile(path.join(outDir, 'index.html'), 'utf8'), /Show a place you remember/);
    const snapshot = await readFile(path.join(outDir, 'snapshot.html'), 'utf8');
    assert.match(snapshot, /Offline snapshot\./);
    assert.match(snapshot, /<a href="\.\/">Back to the entry page<\/a>/);
    assert.doesNotMatch(snapshot, /Show a place you remember/);
    const listing = JSON.parse(await readFile(path.join(outDir, 'EXPORT.json'), 'utf8')).files;
    assert.deepEqual(listing.map((item) => item.path).sort(), files.filter((file) => file !== 'EXPORT.json').sort());
    for (const item of listing) assert.equal(sha256(await readFile(path.join(outDir, item.path))), item.sha256, item.path);
    assert.equal(await verifyExportFolder(outDir), listing.length, 'the new site passes the same closed-inventory check the publish workflow applies');
  });

  it('refuses replacement audio whose bytes differ from the entry pin', async () => {
    const earlier = await earlierExport();
    const { entry } = await entryAndPhotos();
    const config = JSON.parse(await readFile(path.join(entry.dir, 'photos.json'), 'utf8'));
    config.route.story.audioSha256 = 'a'.repeat(64);
    await writeFile(path.join(entry.dir, 'photos.json'), JSON.stringify(config));
    await assert.rejects(exportStaticVisit({ origin: 'http://snapshot.invalid', token: `rhv_${'M'.repeat(43)}`, outDir: path.join(await tempDir(), 'site'), confirmPublicMaterial: true, fetchImpl: fetchFromExport(earlier), entry }), /pinned SHA-256/);
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

  it('refuses an entry whose version link or change claim the snapshot does not back', async () => {
    const build = async (views) => {
      const earlier = await earlierExport(views);
      const { entry } = await entryAndPhotos();
      return exportStaticVisit({ origin: 'http://snapshot.invalid', token: `rhv_${'H'.repeat(43)}`, outDir: path.join(await tempDir(), 'x'), confirmPublicMaterial: true, fetchImpl: fetchFromExport(earlier), entry });
    };
    await assert.rejects(build(childViews().map((view, index) => (index === 1 ? { ...view, label: 'Saved version 2 owner revision' } : view))), /no single pinned saved view/);
    await assert.rejects(build([...childViews(), { id: randomUUID(), label: 'Saved version 2', edit: edit(0), evidence: { arrangement: 'memory' } }]), /exactly two saved versions/);
    await assert.rejects(build(childViews({ edit: edit((10 * Math.PI) / 180) })), /does not record a -10 degree/);
    await assert.rejects(build(childViews({ edit: edit(0) })), /does not record a -10 degree/);
    await assert.rejects(build(childViews({ edit: { offset: [1, 0, 0], yaw: (-10 * Math.PI) / 180 } })), /zero translation/);
    await assert.rejects(build(childViews({ evidence: { arrangement: 'alternative' } })), /not recorded as memory/);
    await assert.doesNotReject(build(childViews()));
  });

  it('binds the primary original, approved version and story to their exact snapshot identities', async () => {
    const html = await readFile(path.join(ENTRY, 'index.html'), 'utf8');
    const check = (manifest, page = html) => checkEntryAgainstSnapshot({ html: page, route: PENN_ROUTE }, manifest);
    assert.doesNotThrow(() => check(snapshot()));
    const bad = (mutate, message) => {
      const manifest = snapshot();
      mutate(manifest);
      assert.throws(() => check(manifest), message);
    };
    bad((m) => { m.id = randomUUID(); }, /pinned synthetic snapshot/);
    bad((m) => { m.synthetic = false; }, /pinned synthetic snapshot/);
    bad((m) => { m.startViewId = PENN_ROUTE.approved.viewId; }, /start at its pinned original/);
    bad((m) => { m.views[0].id = randomUUID(); }, /single pinned saved view/);
    bad((m) => { m.views[1].label = m.views[0].label; }, /single pinned saved view/);
    bad((m) => { m.views[0].edit.yaw = 0.1; }, /0 degree/);
    bad((m) => { m.views[1].edit = { objects: [{ id: 'clock', yaw: -Math.PI / 18, offset: [0, 0, 0] }] }; }, /single-object/);
    bad((m) => { m.stories[0].viewId = PENN_ROUTE.approved.viewId; }, /story slot must belong only/);
    bad((m) => { m.stories[0].id = randomUUID(); }, /story slot must belong only/);
    bad((m) => { m.stories = []; }, /story slot must belong only/);
    bad((m) => { m.stories.push({ ...m.stories[0], viewId: PENN_ROUTE.approved.viewId }); }, /story slot must belong only/);
    bad((m) => { delete m.stories[0].captionAuthorLabel; }, /story slot/);
    bad((m) => { m.stories[0].audio.size = 0; }, /story slot/);
    bad((m) => { m.stories[0].cues = []; }, /story slot/);
    bad((m) => { m.stories[0].audio.type = 'audio/mpeg'; }, /story slot/);
    bad((m) => { m.stories = [null]; }, /story slot/);
    for (const mutate of [
      (s) => { s.providerLabel = 'Synthetic demonstration voice'; },
      (s) => { s.title = 'Historical native story'; },
      (s) => { s.captionDraft = { label: 'Muse Voice Transcribe' }; },
      (s) => { s.durationMs = 10574; },
      (s) => { s.cues[0].endMs = 10140; },
      (s) => { s.cues[0].text += ' Extra words.'; },
      (s) => { s.audio.size += 2; },
      (s) => { s.sourceRange = { startMs: 0, endMs: 9950 }; },
      (s) => { s.sourceId = randomUUID(); },
      (s) => { s.audio.model = 'unapproved provenance'; },
      (s) => { delete s.target; },
      (s) => { s.target = null; },
      (s) => { s.target = { id: 'unapproved-object', label: 'Unapproved' }; },
      (s) => { s.target.id = 'unapproved-object'; },
      (s) => { s.target.label = 'Unapproved'; },
      (s) => { s.target.model = 'unapproved provenance'; },
      (s) => { s.target = [s.target, s.target]; },
    ]) bad((m) => mutate(m.stories[0]), /static editorial replacement/);
    bad((m) => { m.contributorRecordings = [{ id: randomUUID() }]; }, /static editorial replacement/);
    for (const text of ['Synthetic voice (OpenAI TTS)', 'One 0-9950 ms whole-track cue is copied manually from that script', 'Listening and editorial review are pending.', 'not a newly saved story in the running app']) {
      assert.throws(() => check(snapshot(), html.replace(text, 'Unapproved claim')), /editorial replacement disclosure/);
    }
    assert.throws(() => check(snapshot(), html.replace('href="snapshot.html?version=Saved%20version%201"', 'href="snapshot.html?version=Saved%20version%202"')), /primary scene link/);
    for (const href of ['snapshot.html', 'snapshot.html?version=Saved%20version%201&version=Saved%20version%202', 'snapshot.html?version=Saved%20version%201#other', 'snapshot.html?version=Saved%20version%201&extra=1', 'snapshot.html?version=Alternative%20arrangement%202', ' snapshot.html?version=Saved%20version%203 ']) {
      assert.throws(() => check(snapshot(), html.replace('snapshot.html?version=Saved%20version%201', href)), /unapproved snapshot version route/, href);
    }
    assert.throws(() => check(snapshot(), html.replace('href="snapshot.html?version=Saved%20version%202"', 'href="#scene"')), /no link to/);
    assert.doesNotThrow(() => check(snapshot(), html.replace('href="snapshot.html?version=Saved%20version%202"', "HREF='snapshot.html?version=Saved%20version%202'")));
  });

  it('refuses duplicate attributes before a browser can choose a different primary route', async () => {
    const html = await readFile(path.join(ENTRY, 'index.html'), 'utf8');
    const { photos } = JSON.parse(await readFile(path.join(ENTRY, 'photos.json'), 'utf8'));
    const original = 'href="snapshot.html?version=Saved%20version%201"';
    for (const attributes of [
      'href="snapshot.html?version=Saved%20version%202" href="snapshot.html?version=Saved%20version%201"',
      'href="snapshot.html?version=Saved%20version%202" HREF="snapshot.html?version=Saved%20version%201"',
      "Href='snapshot.html?version=Saved%20version%201' href='snapshot.html?version=Saved%20version%202'",
      'href="https://evil.example/" HREF="snapshot.html?version=Saved%20version%201"',
    ]) {
      const page = html.replace(original, attributes);
      assert.throws(() => checkEntryHtml(page, photos, { targets: ['lodge-index.html'] }), /duplicate attribute: href/, attributes);
      assert.throws(() => checkEntryAgainstSnapshot({ html: page, route: PENN_ROUTE }, snapshot()), /duplicate attribute: href/, attributes);
    }
    for (const page of [
      html.replace('src="entry/penn8.jpg"', 'src="entry/penn8.jpg" SRC="entry/a16.jpg"'),
      html.replace('class="button"', 'class="button" CLASS="secondary"'),
      html.replace('lang="en"', 'lang="en" LANG="fr"'),
      html.replace('alt="Black-and-white archival', 'alt="Another descriptive photograph" ALT="Black-and-white archival'),
    ]) assert.throws(() => checkEntryHtml(page, photos, { targets: ['lodge-index.html'] }), /duplicate attribute/);
  });

  // A second entry page with overlay images, written beside the real entry files; the overlays folder holds exactly what the JSON lists.
  const LODGE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lodge index test page</title><link rel="stylesheet" href="entry.css"></head>
<body><a href="index.html">Back to the entry page</a>
<img src="entry/a16.jpg" width="10" height="10" alt="Black-and-white photograph of a dining room">
<img src="entry/lodge/a16-all.png" width="4" height="4" alt="Overlay outlining every table in the photograph">
<a href="lodge-index.json">Derived data</a></body>
</html>
`;
  async function withLodge(entry, { page = LODGE_PAGE, overlays = [['a16-all.png', png()]], mutate = null } = {}) {
    const overlaysDir = await tempDir();
    const listed = overlays.map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha256(bytes) }));
    for (const [file, bytes] of overlays) await writeFile(path.join(overlaysDir, file), bytes);
    await writeFile(path.join(entry.dir, 'lodge-index.html'), page);
    const json = { overlays: listed, note: 'derived data only' };
    await mutate?.({ json, overlaysDir, listed });
    await writeFile(path.join(entry.dir, 'lodge-index.json'), `${JSON.stringify(json, null, 2)}\n`);
    return { ...entry, overlaysDir };
  }
  const exportWith = async (entry) => exportStaticVisit({
    origin: 'http://snapshot.invalid', token: `rhv_${'J'.repeat(43)}`, outDir: path.join(await tempDir(), 'x'), confirmPublicMaterial: true, fetchImpl: fetchFromExport(await earlierExport()), entry,
  });

  it('adds a second entry page and its overlays to the closed inventory, through the same gate', async () => {
    const { entry } = await entryAndPhotos();
    const lodge = await withLodge(entry);
    const earlier = await earlierExport();
    const outDir = path.join(await tempDir(), 'site');
    await exportStaticVisit({ origin: 'http://snapshot.invalid', token: `rhv_${'K'.repeat(43)}`, outDir, confirmPublicMaterial: true, fetchImpl: fetchFromExport(earlier), entry: lodge });
    const files = await walk(outDir);
    for (const name of ['index.html', 'lodge-index.html', 'lodge-index.json', 'entry/lodge/a16-all.png', 'snapshot.html']) assert.ok(files.includes(name), name);
    const listing = JSON.parse(await readFile(path.join(outDir, 'EXPORT.json'), 'utf8')).files;
    assert.ok(listing.some((item) => item.path === 'entry/lodge/a16-all.png'));
    assert.equal(await verifyExportFolder(outDir), listing.length);
    assert.match(await readFile(path.join(outDir, 'index.html'), 'utf8'), /Show a place you remember/);
  });

  it('lets the entry link to the second page only when that page exists', async () => {
    const { entry } = await entryAndPhotos();
    const link = (html) => html.replace('<p class="brand">Rehere</p>', '<p class="brand">Rehere</p><a href="lodge-index.html">Lodge index</a>');
    const original = await readFile(path.join(entry.dir, 'index.html'), 'utf8');
    await writeFile(path.join(entry.dir, 'index.html'), link(original));
    await assert.rejects(exportWith(entry), /unlisted file: lodge-index\.html/);
    await assert.doesNotReject(exportWith(await withLodge(entry)));
  });

  it('refuses a second page that breaks the gate or points outside its listed files', async () => {
    for (const [name, page, message] of [
      ['an unlisted overlay', LODGE_PAGE.replace('a16-all.png', 'a16-other.png'), /unlisted file/],
      ['an external link', LODGE_PAGE.replace('<a href="index.html">', '<a href="https://example.org/">'), /approved source/],
      ['an inline style', LODGE_PAGE.replace('<body>', '<body style="margin:0">'), /inline styles/],
      ['a script', LODGE_PAGE.replace('</body>', '<script>1</script></body>'), /scripts/],
      ['an image without alt text', LODGE_PAGE.replace('alt="Overlay outlining every table in the photograph"', 'alt="x"'), /alt text/],
      ['a missing language', LODGE_PAGE.replace('<html lang="en">', '<html>'), /lang/],
      ['a root-absolute image', LODGE_PAGE.replace('src="entry/lodge/a16-all.png"', 'src="/entry/lodge/a16-all.png"'), /root-absolute/],
      ['a file of the snapshot', LODGE_PAGE.replace('href="index.html"', 'href="data/manifest.json"'), /unlisted file/],
    ]) {
      const { entry } = await entryAndPhotos();
      await assert.rejects(exportWith(await withLodge(entry, { page })), message, name);
    }
  });

  it('refuses overlays that differ from the list, carry metadata, or are not exactly the listed files', async () => {
    const cases = [
      ['a changed overlay', { mutate: ({ listed, json }) => { json.overlays = listed.map((item) => ({ ...item, sha256: 'a'.repeat(64) })); } }, /differs from its listed size or SHA-256/],
      ['a wrong size', { mutate: ({ listed, json }) => { json.overlays = listed.map((item) => ({ ...item, bytes: item.bytes + 1 })); } }, /differs from its listed size/],
      ['an overlay with a text chunk', { overlays: [['a16-all.png', png({ extra: [chunk('tEXt', Buffer.from('Comment\0x'))] })]] }, /tEXt chunk/],
      ['an unlisted extra file', { mutate: async ({ overlaysDir }) => writeFile(path.join(overlaysDir, 'extra.png'), png()) }, /exactly the listed files/],
      ['a missing file', { mutate: async ({ overlaysDir }) => rm(path.join(overlaysDir, 'a16-all.png')) }, /exactly the listed files/],
      ['a path in a name', { overlays: [['a16-all.png', png()]], mutate: ({ json }) => { json.overlays[0].file = '../a16-all.png'; } }, /unsafe or duplicate/],
      ['an upper-case name', { overlays: [['A16.png', png()]] }, /unsafe or duplicate/],
      ['a duplicate name', { mutate: ({ json }) => { json.overlays.push({ ...json.overlays[0] }); } }, /unsafe or duplicate/],
      ['more than 64 overlays', { mutate: ({ json }) => { json.overlays = Array.from({ length: 65 }, (_, i) => ({ file: `o${i}.png`, bytes: 1, sha256: 'b'.repeat(64) })); } }, /at most 64/],
      ['no overlays list', { mutate: ({ json }) => { delete json.overlays; } }, /overlays list/],
    ];
    for (const [name, options, message] of cases) {
      const { entry } = await entryAndPhotos();
      await assert.rejects(exportWith(await withLodge(entry, options)), message, name);
    }
    const { entry } = await entryAndPhotos();
    const lodge = await withLodge(entry);
    await assert.rejects(exportWith({ dir: lodge.dir, photosDir: lodge.photosDir }), /needs --entry-overlays/);
  });

  it('applies the exporter scan to the derived JSON as well', async () => {
    for (const [name, mutate, message] of [
      ['an email address', ({ json }) => { json.note = 'ask someone@example.org'; }, /email address/],
      ['an API route', ({ json }) => { json.note = 'see /api/visit'; }, /API route/],
    ]) {
      const { entry } = await entryAndPhotos();
      await assert.rejects(exportWith(await withLodge(entry, { mutate })), message, name);
    }
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
