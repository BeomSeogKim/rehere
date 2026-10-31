import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LIMITS } from '../drafts.mjs';
import { createAppServer } from '../server.mjs';

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

async function start(options) {
  const server = createAppServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function form({ text, photos = [], voice } = {}) {
  const body = new FormData();
  if (text !== undefined) body.append('text', text);
  for (const [index, bytes] of photos.entries()) body.append('photos', new Blob([bytes], { type: 'image/jpeg' }), `p${index}.jpg`);
  if (voice) body.append('voice', new Blob([voice], { type: 'audio/webm' }), 'voice');
  return body;
}

const post = (base, body, headers) => fetch(`${base}/api/drafts`, { method: 'POST', body, headers });
const bytes = async (response) => Buffer.from(await response.arrayBuffer());

function rawRequest(base, { method = 'GET', path: target = '/', headers = {}, chunks = [] } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: target, headers }, (res) => {
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
    assert.equal(draft.text, 'The blue gate by the bakery.');
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
    assert.deepEqual(draft.voice, { name: 'voice.m4a', type: 'audio/mp4', size: MP4_AUDIO.length });
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
