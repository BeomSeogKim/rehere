import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LIMITS } from '../drafts.mjs';
import { ownerCookie, ownerFetch as fetch, startOwnerServer } from './auth-helper.mjs';
import { canUseSource } from '../sources.mjs';

// Synthetic bytes with real container signatures; no personal media is used.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const MP4_AUDIO = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(64, 4)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 5)]);

const tempDirs = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-app-'));
  tempDirs.push(dir);
  return dir;
}
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

// Content routes require the owner session; requests go through that client.
const start = startOwnerServer;

function form({ text, photos = [], voice, metadata } = {}) {
  const body = new FormData();
  if (text !== undefined) body.append('text', text);
  for (const [index, bytes] of photos.entries()) body.append('photos', new Blob([bytes], { type: 'image/jpeg' }), `p${index}.jpg`);
  if (voice) body.append('voice', new Blob([voice], { type: 'audio/webm' }), 'voice');
  if (metadata !== undefined) body.append('metadata', typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  return body;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function source(provider, permissions, dates = {}) {
  return {
    provider,
    origin: { kind: 'own', reference: '' },
    permissions: { place: false, model: false, share: false, ...permissions },
    dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '', ...dates },
  };
}

const UNKNOWN = {
  provider: '',
  origin: { kind: 'unknown', reference: '' },
  permissions: { place: false, model: false, share: false },
  dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
};

const post = (base, body, headers) => fetch(`${base}/api/drafts`, { method: 'POST', body, headers });
const bytes = async (response) => Buffer.from(await response.arrayBuffer());

function rawRequest(base, { method = 'GET', path: target = '/', headers = {}, chunks = [] } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: target, headers: { cookie: ownerCookie(base), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    // The server may reject and close before the whole body is written.
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe('draft server', () => {
  let app;
  let dataDir;
  before(async () => {
    dataDir = await tempDir();
    app = await start({ dataDir });
  });
  after(() => app.close());

  it('serves the entry screen with protective headers', async () => {
    const response = await fetch(`${app.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await response.text(), /Add your memories/);
    for (const script of ['/app.js', '/recorder.js', '/latest.js']) {
      assert.match((await fetch(`${app.base}${script}`)).headers.get('content-type'), /text\/javascript/, script);
    }
  });

  it('saves photos and text without any voice and reopens them', async () => {
    const response = await post(app.base, form({ text: '  The blue gate by the bakery.  ', photos: [JPEG, PNG] }));
    assert.equal(response.status, 201);
    const draft = await response.json();
    assert.equal(draft.text, '  The blue gate by the bakery.  ');
    assert.deepEqual(draft.photos.map((photo) => [photo.name, photo.type]), [['photo-1.jpg', 'image/jpeg'], ['photo-2.png', 'image/png']]);
    assert.equal(draft.voice, null);

    const reopened = await (await fetch(`${app.base}/api/drafts/${draft.id}`)).json();
    assert.deepEqual(reopened, draft);
    const photo = await fetch(`${app.base}/api/drafts/${draft.id}/assets/photo-2.png`);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.deepEqual(await bytes(photo), PNG);

    const list = await (await fetch(`${app.base}/api/drafts`)).json();
    assert.ok(list.some((item) => item.id === draft.id && item.photoCount === 2 && !item.hasVoice));
  });

  it('saves a voice recording on its own and serves byte ranges', async () => {
    const draft = await (await post(app.base, form({ voice: MP4_AUDIO }))).json();
    assert.deepEqual(draft.voice, { name: 'voice.m4a', type: 'audio/mp4', size: MP4_AUDIO.length, sourceId: draft.sources[0].id });
    const partial = await fetch(`${app.base}/api/drafts/${draft.id}/assets/voice.m4a`, { headers: { range: 'bytes=4-11' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 4-11/${MP4_AUDIO.length}`);
    assert.equal((await bytes(partial)).toString(), 'ftypM4A ');
    const invalid = await fetch(`${app.base}/api/drafts/${draft.id}/assets/voice.m4a`, { headers: { range: 'bytes=999-' } });
    assert.equal(invalid.status, 416);
  });

  it('rejects an empty save', async () => {
    for (const body of [form(), form({ text: ' \n\t ' })]) {
      const response = await post(app.base, body);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Add a photo, a written memory or a voice recording/);
    }
  });

  it('rejects files whose content does not match the allowed types', async () => {
    const cases = [
      [form({ photos: [Buffer.from('not an image')] }), 400, /JPEG or PNG/],
      [form({ photos: [HEIC] }), 400, /HEIC photos are not supported/],
      [form({ photos: [Buffer.alloc(0)] }), 400, /empty/],
      [form({ voice: JPEG }), 400, /voice recording could not be read/],
    ];
    for (const [body, status, message] of cases) {
      const response = await post(app.base, body);
      assert.equal(response.status, status);
      assert.match((await response.json()).error, message);
    }
  });

  it('rejects malformed or unexpected uploads', async () => {
    const unexpected = form({ text: 'x' });
    unexpected.append('path', '../../etc');
    const textAsFile = new FormData();
    textAsFile.append('text', new Blob(['x']), 'text.txt');
    const photoAsText = new FormData();
    photoAsText.append('photos', 'not a file');
    const twoVoices = form({ voice: WEBM });
    twoVoices.append('voice', new Blob([WEBM]), 'voice');
    for (const body of [unexpected, textAsFile, photoAsText, twoVoices]) {
      assert.equal((await post(app.base, body)).status, 400);
    }

    const broken = await rawRequest(app.base, {
      method: 'POST',
      path: '/api/drafts',
      headers: { 'content-type': 'multipart/form-data; boundary=abc' },
      chunks: ['--abc\r\nthis is not a valid part'],
    });
    assert.equal(broken.status, 400);
    const json = await post(app.base, JSON.stringify({ text: 'x' }), { 'content-type': 'application/json' });
    assert.equal(json.status, 415);
  });

  it('serves only assets recorded in the draft and rejects unsafe paths', async () => {
    const draft = await (await post(app.base, form({ photos: [JPEG] }))).json();
    const targets = [
      `/api/drafts/${draft.id}/assets/draft.json`,
      `/api/drafts/${draft.id}/assets/..%2f..%2fpackage.json`,
      `/api/drafts/${draft.id}/assets/photo-2.jpg`,
      `/api/drafts/..%2f..%2fserver.mjs`,
      `/api/drafts/%2e%2e/assets/photo-1.jpg`,
      '/api/drafts/not-an-id',
      '/..%2fserver.mjs',
      '/public/app.js',
      '/data/',
    ];
    for (const target of targets) {
      const response = await rawRequest(app.base, { path: target, headers: { host: new URL(app.base).host } });
      assert.equal(response.status, 404, target);
    }
  });

  it('rejects requests for other host names and cross-site saves', async () => {
    const { port } = app.server.address();
    const rebound = await rawRequest(app.base, { headers: { host: `attacker.example:${port}` } });
    assert.equal(rebound.status, 403);
    const crossSite = await post(app.base, form({ text: 'x' }), { origin: 'https://attacker.example' });
    assert.equal(crossSite.status, 403);
    const sameSite = await post(app.base, form({ text: 'x' }), { origin: app.base });
    assert.equal(sameSite.status, 201);
  });

  it('rejects unsupported methods', async () => {
    assert.equal((await fetch(`${app.base}/api/drafts`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${app.base}/`, { method: 'POST' })).status, 405);
  });
});

describe('draft limits', () => {
  const limits = { ...LIMITS, requestBytes: 4096, photoCount: 2, photoBytes: 256, voiceBytes: 256, textChars: 20 };
  let app;
  let dataDir;
  before(async () => {
    dataDir = await tempDir();
    app = await start({ dataDir, limits });
  });
  after(() => app.close());

  async function stored() {
    return readdir(path.join(dataDir, 'drafts')).catch(() => []);
  }

  it('rejects a body over the total cap declared by Content-Length', async () => {
    const response = await post(app.base, form({ text: 'x'.repeat(5000) }));
    assert.equal(response.status, 413);
    assert.deepEqual(await stored(), []);
  });

  it('stops reading a streamed body without Content-Length at the cap', async () => {
    const chunk = 'x'.repeat(1024);
    const response = await rawRequest(app.base, {
      method: 'POST',
      path: '/api/drafts',
      headers: { 'content-type': 'multipart/form-data; boundary=abc', 'transfer-encoding': 'chunked' },
      chunks: Array(8).fill(chunk),
    });
    assert.equal(response.status, 413);
    assert.match(JSON.parse(response.body).error, /must total/);
    assert.deepEqual(await stored(), []);
  });

  it('enforces per-item limits', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(300)]);
    const bigVoice = Buffer.concat([WEBM, Buffer.alloc(300)]);
    const cases = [
      form({ photos: [JPEG, JPEG, JPEG] }),
      form({ photos: [big] }),
      form({ voice: bigVoice }),
      form({ text: 'x'.repeat(21) }),
    ];
    for (const body of cases) assert.equal((await post(app.base, body)).status, 413);
    assert.deepEqual(await stored(), []);
  });
});

describe('draft persistence', () => {
  it('keeps photo, text and voice bytes across a server restart', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const draft = await (await post(first.base, form({ text: 'Kitchen window', photos: [JPEG], voice: WEBM }))).json();
    await first.close();

    const second = await start({ dataDir });
    try {
      const reopened = await (await fetch(`${second.base}/api/drafts/${draft.id}`)).json();
      assert.equal(reopened.text, 'Kitchen window');
      assert.deepEqual(await bytes(await fetch(`${second.base}/api/drafts/${draft.id}/assets/photo-1.jpg`)), JPEG);
      const voice = await fetch(`${second.base}/api/drafts/${draft.id}/assets/voice.webm`);
      assert.equal(voice.headers.get('content-type'), 'audio/webm');
      assert.deepEqual(await bytes(voice), WEBM);
    } finally {
      await second.close();
    }
  });

  it('reports a storage failure without success and keeps earlier drafts readable', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const dataDir = await tempDir();
    const app = await start({ dataDir });
    const draftsDir = path.join(dataDir, 'drafts');
    try {
      const earlier = await (await post(app.base, form({ text: 'Earlier memory' }))).json();
      await chmod(draftsDir, 0o500);
      const failed = await post(app.base, form({ text: 'New memory', photos: [JPEG] }));
      assert.equal(failed.status, 500);
      assert.equal((await failed.json()).id, undefined);

      const list = await (await fetch(`${app.base}/api/drafts`)).json();
      assert.deepEqual(list.map((item) => item.id), [earlier.id]);
      assert.equal((await (await fetch(`${app.base}/api/drafts/${earlier.id}`)).json()).text, 'Earlier memory');
      assert.deepEqual(await readdir(path.join(dataDir, 'incoming')), [], 'partial files removed');
    } finally {
      await chmod(draftsDir, 0o700);
      await app.close();
    }
  });
});

describe('draft sources', () => {
  let app;
  let dataDir;
  before(async () => {
    dataDir = await tempDir();
    app = await start({ dataDir });
  });
  after(() => app.close());

  const stored = () => readdir(path.join(dataDir, 'drafts')).catch(() => []);

  it('records each original with its own attribution, checksum and exact text', async () => {
    const text = '  Grandma\u2019s \uACE8\uBAA9, 1998 \u2014\n<b>not markup</b>  ';
    const metadata = {
      photos: [
        source('Mina', { place: true }, { capturedOn: '1998-07-04' }),
        { ...source('City archive', { place: true, share: true }, { estimatedPeriod: 'late 1990s' }), origin: { kind: 'public', reference: 'https://example.org/archive/12' } },
      ],
      text: source('Joon', { model: true }),
      voice: source('Ara', {}, { fileModifiedAt: '2026-10-30T08:15:00.000Z' }),
    };
    const response = await post(app.base, form({ text, photos: [JPEG, PNG], voice: WEBM, metadata }));
    assert.equal(response.status, 201);
    const draft = await response.json();
    // Multipart encoding sends line breaks in text fields as CRLF; the server
    // stores and hashes exactly the text it received.
    const received = text.replace(/\n/g, '\r\n');

    assert.equal(draft.schemaVersion, 2);
    assert.equal(draft.text, received);
    assert.deepEqual(draft.sources.map((item) => item.kind), ['photo', 'photo', 'text', 'voice']);
    assert.deepEqual(draft.sources.map((item) => item.provider), ['Mina', 'City archive', 'Joon', 'Ara']);
    assert.deepEqual(draft.sources.map((item) => item.sha256), [sha256(JPEG), sha256(PNG), sha256(Buffer.from(received, 'utf8')), sha256(WEBM)]);
    assert.deepEqual(draft.sources.map((item) => item.size), [JPEG.length, PNG.length, Buffer.byteLength(received, 'utf8'), WEBM.length]);
    assert.deepEqual(draft.sources.map((item) => item.type), ['image/jpeg', 'image/png', 'text/plain; charset=utf-8', 'audio/webm']);
    assert.deepEqual(draft.sources.map((item) => item.name), ['photo-1.jpg', 'photo-2.png', null, 'voice.webm']);
    for (const item of draft.sources) {
      assert.equal(item.role, 'original');
      assert.equal(item.parentSourceId, null);
      assert.match(item.id, /^[0-9a-f-]{36}$/);
    }
    assert.equal(new Set(draft.sources.map((item) => item.id)).size, 4);
    assert.deepEqual(draft.photos.map((photo) => photo.sourceId), [draft.sources[0].id, draft.sources[1].id]);
    assert.equal(draft.textSourceId, draft.sources[2].id);
    assert.equal(draft.voice.sourceId, draft.sources[3].id);
    assert.deepEqual(draft.sources[1].origin, metadata.photos[1].origin);
    assert.deepEqual(draft.sources[3].dates, metadata.voice.dates);

    const [first, second, written, voice] = draft.sources.map((item) => item.id);
    assert.equal(canUseSource(draft, first, 'place'), true);
    assert.equal(canUseSource(draft, first, 'model'), false);
    assert.equal(canUseSource(draft, first, 'share'), false);
    assert.equal(canUseSource(draft, second, 'share'), true);
    assert.equal(canUseSource(draft, written, 'place'), false);
    assert.equal(canUseSource(draft, written, 'model'), true);
    assert.equal(canUseSource(draft, voice, 'place'), false);

    assert.deepEqual(await (await fetch(`${app.base}/api/drafts/${draft.id}`)).json(), draft);
    assert.deepEqual(await bytes(await fetch(`${app.base}/api/drafts/${draft.id}/assets/photo-2.png`)), PNG);
  });

  it('defaults to unknown sources without consent when metadata is absent', async () => {
    const draft = await (await post(app.base, form({ text: 'Kept', photos: [JPEG] }))).json();
    assert.equal(draft.sources.length, 2);
    for (const item of draft.sources) {
      const { provider, origin, permissions, dates } = item;
      assert.deepEqual({ provider, origin, permissions, dates }, UNKNOWN);
      for (const purpose of ['place', 'model', 'share']) assert.equal(canUseSource(draft, item.id, purpose), false);
    }
  });

  it('treats whitespace-only text as no statement and no source', async () => {
    const draft = await (await post(app.base, form({ text: ' \n ', photos: [JPEG], metadata: { photos: [source('Mina', {})], text: null } }))).json();
    assert.equal(draft.text, '');
    assert.equal(draft.textSourceId, null);
    assert.deepEqual(draft.sources.map((item) => item.kind), ['photo']);
  });

  it('rejects invalid or misplaced metadata without storing anything', async () => {
    const before = await stored();
    const cases = [
      form({ photos: [JPEG], metadata: 'not json' }),
      form({ photos: [JPEG], metadata: { photos: [] } }),
      form({ photos: [JPEG, PNG], metadata: { photos: [source('a', {})] } }),
      form({ photos: [JPEG], metadata: { photos: [source('a', {}, { capturedOn: '2023-02-29' })] } }),
      form({ photos: [JPEG], metadata: { photos: [source('a', { place: 'yes' })] } }),
      form({ text: 'x', metadata: { voice: source('a', {}) } }),
      form({ text: '   ', photos: [JPEG], metadata: { text: source('a', {}) } }),
      form({ text: 'x', metadata: { text: source('a', {}), unexpected: true } }),
    ];
    const repeated = form({ text: 'x', metadata: {} });
    repeated.append('metadata', '{}');
    const asFile = form({ text: 'x' });
    asFile.append('metadata', new Blob(['{}']), 'metadata.json');
    for (const body of [...cases, repeated, asFile]) {
      const response = await post(app.base, body);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /source details could not be read/);
    }
    assert.deepEqual(await stored(), before);
  });

  it('reopens a draft saved before source records as metadata unavailable', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const legacy = { id, createdAt: '2026-10-01T00:00:00.000Z', text: 'Old memory', photos: [{ name: 'photo-1.jpg', type: 'image/jpeg', size: JPEG.length }], voice: null };
    await mkdir(path.join(dataDir, 'drafts', id), { recursive: true });
    await writeFile(path.join(dataDir, 'drafts', id, 'draft.json'), JSON.stringify(legacy));
    await writeFile(path.join(dataDir, 'drafts', id, 'photo-1.jpg'), JPEG);

    const reopened = await (await fetch(`${app.base}/api/drafts/${id}`)).json();
    assert.deepEqual(reopened, legacy);
    assert.equal(reopened.sources, undefined);
    assert.equal(canUseSource(reopened, 'anything', 'place'), false);
    assert.deepEqual(await bytes(await fetch(`${app.base}/api/drafts/${id}/assets/photo-1.jpg`)), JPEG);
    const list = await (await fetch(`${app.base}/api/drafts`)).json();
    assert.ok(list.some((item) => item.id === id && item.photoCount === 1));
  });
});

describe('draft source persistence', () => {
  it('keeps source records and original bytes together across a restart', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const metadata = { photos: [source('Mina', { place: true, share: true })], voice: source('Ara', { model: true }) };
    const draft = await (await post(first.base, form({ text: ' Kitchen window ', photos: [JPEG], voice: WEBM, metadata }))).json();
    await first.close();

    const second = await start({ dataDir });
    try {
      const reopened = await (await fetch(`${second.base}/api/drafts/${draft.id}`)).json();
      assert.deepEqual(reopened, draft);
      assert.equal(reopened.text, ' Kitchen window ');
      const photo = await bytes(await fetch(`${second.base}/api/drafts/${draft.id}/assets/photo-1.jpg`));
      const voice = await bytes(await fetch(`${second.base}/api/drafts/${draft.id}/assets/voice.webm`));
      assert.equal(sha256(photo), reopened.sources[0].sha256);
      assert.equal(sha256(voice), reopened.voice && reopened.sources[2].sha256);
      assert.deepEqual(reopened.sources[1].permissions, { place: false, model: false, share: false });
    } finally {
      await second.close();
    }
  });

  it('stores neither metadata nor originals when saving fails', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const dataDir = await tempDir();
    const app = await start({ dataDir });
    const draftsDir = path.join(dataDir, 'drafts');
    try {
      await mkdir(draftsDir, { recursive: true });
      await chmod(draftsDir, 0o500);
      const failed = await post(app.base, form({ text: 'New', photos: [JPEG], metadata: { photos: [source('Mina', { place: true })] } }));
      assert.equal(failed.status, 500);
      assert.deepEqual(await readdir(draftsDir), []);
      assert.deepEqual(await readdir(path.join(dataDir, 'incoming')), []);
    } finally {
      await chmod(draftsDir, 0o700);
      await app.close();
    }
  });
});
