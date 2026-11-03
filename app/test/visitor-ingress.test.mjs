import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pcmWav } from '../audio-derivative.mjs';
import { detectMedia } from '../drafts.mjs';
import { createAppServer, listenAll, parseVisitorOrigin, visitorSettings } from '../server.mjs';
import { UNAVAILABLE as VISIT_UNAVAILABLE } from '../shares.mjs';
import { client, enrolledContributor, jpeg, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const ORIGIN = 'https://visit.example';
const VISITOR_HOST = 'visit.example';
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(96, 5)]);
const WAV = pcmWav(Buffer.alloc(3200));
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-visitor-ingress-'));
  tempDirs.push(dir);
  return dir;
};

// Synthetic stand-ins for the photo worker and recording preparer only; the
// visitor listener, stores and authorization are the real ones.
const recordingPreparer = async ({ bytes }) => {
  const { type, extension } = detectMedia('voice', bytes);
  return {
    original: { sha256: sha256(bytes), size: bytes.length, type, extension },
    playback: { sha256: sha256(WAV), size: WAV.length, type: 'audio/wav', durationMs: 100, sampleRate: 16_000, channels: 1, bitsPerSample: 16, parentSha256: sha256(bytes) },
    wav: WAV,
  };
};

// A raw request to the visitor listener, with any Host and headers; the
// target may be an absolute-form URL or carry encoded segments.
function raw(port, method, target, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host: VISITOR_HOST, ...headers }, setHost: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function workspace(options = {}) {
  const dataDir = options.dataDir ?? (await tempDir());
  const app = await startOwnerServer({
    dataDir, reconstructionRunner: sceneRunner, contributionPhotoDecoder: async () => jpeg(64, 48, 9), recordingPreparer, visitorOrigin: ORIGIN, ...options,
  });
  await new Promise((resolve) => app.server.visitorServer.listen(0, '127.0.0.1', resolve));
  const visitorPort = app.server.visitorServer.address().port;
  return { app, dataDir, visitorPort, owner: client(app.base, app.cookie) };
}

const fullGrant = { provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };
async function place(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('metadata', JSON.stringify({ photos: [fullGrant] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return { draft, job, scene, sourceId: draft.photos[0].sourceId };
}
async function recording(app, owner, scene) {
  const { session } = await enrolledContributor(owner, app.base, scene.draft.id, 'Synthetic speaker');
  const form = new FormData();
  form.append('payload', JSON.stringify({
    requestId: randomUUID(), text: '', permissions: null, periodClaim: '', photo: null,
    voice: { origin: { kind: 'own', reference: '' }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' }, permissions: { place: true, model: false, share: true }, captionText: 'Synthetic description.', captionConfirmed: true },
  }));
  form.append('voice', new Blob([WEBM]), 'take');
  const response = await session.request(`${scene.scene}/contributions/bundle`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  return { session, contribution: await response.json() };
}
const versionView = () => ({ id: randomUUID(), kind: 'version', version: 1, variantId: null });
async function share(owner, scene, extra = {}) {
  const view = versionView();
  const preview = await (await owner.post(`${scene.scene}/shares/previews`, {
    requestId: randomUUID(), title: 'Synthetic place', views: [view], startViewId: view.id, camera: { position: [0, 0, 2], target: [0, 0, -3] }, contributionIds: [], synthetic: true,
    ...(typeof extra === 'function' ? extra(view) : extra),
  })).json();
  const body = { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token: `rhv_${randomBytes(32).toString('base64url')}`, consent: true };
  const issued = await owner.post(`${scene.scene}/shares`, body);
  assert.equal(issued.status, 201);
  return { view, preview, body, token: body.token, receipt: await issued.json() };
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });

describe('visitor origin settings', () => {
  it('accept only exact canonical origins and paired valid settings, and change nothing by default', () => {
    for (const value of ['https://visit.example', 'https://visit.example:8443', 'http://127.0.0.1:9000', 'http://localhost:9000']) {
      assert.equal(parseVisitorOrigin(value).origin, value, value);
    }
    for (const value of [
      'http://visit.example', 'http://localhost', 'http://127.0.0.1', 'http://localhost:0', 'https://visit.example:0', 'https://visit.example/', 'https://visit.example/path',
      'https://visit.example?x=1', 'https://visit.example#x', 'https://user:pass@visit.example', 'https://user@visit.example', 'https://VISIT.example', 'https://*.example',
      'ftp://visit.example', 'visit.example', '', null, 42, ['https://visit.example'],
    ]) {
      assert.throws(() => parseVisitorOrigin(value), TypeError, String(value));
    }
    assert.throws(() => createAppServer({ dataDir: '/nonexistent-never-read', visitorOrigin: 'http://visit.example' }), TypeError, 'synchronous refusal');
    assert.equal(createAppServer({ dataDir: '/nonexistent-never-read' }).visitorServer, null, 'no visitor listener by default');
    const configured = createAppServer({ dataDir: '/nonexistent-never-read', visitorOrigin: ORIGIN });
    assert.equal(configured.visitorServer.listening, false, 'created, not bound');

    assert.equal(visitorSettings({}, 4317), null);
    assert.deepEqual(visitorSettings({ REHERE_VISITOR_ORIGIN: ORIGIN, REHERE_VISITOR_PORT: '4318' }, 4317), { origin: ORIGIN, port: 4318 });
    for (const env of [
      { REHERE_VISITOR_ORIGIN: ORIGIN }, { REHERE_VISITOR_PORT: '4318' }, { REHERE_VISITOR_ORIGIN: ORIGIN, REHERE_VISITOR_PORT: '4317' },
      { REHERE_VISITOR_ORIGIN: ORIGIN, REHERE_VISITOR_PORT: '0' }, { REHERE_VISITOR_ORIGIN: ORIGIN, REHERE_VISITOR_PORT: '65536' },
      { REHERE_VISITOR_ORIGIN: ORIGIN, REHERE_VISITOR_PORT: '43a' }, { REHERE_VISITOR_ORIGIN: 'http://visit.example', REHERE_VISITOR_PORT: '4318' },
    ]) assert.throws(() => visitorSettings(env, 4317), TypeError, JSON.stringify(env));
  });

  it('fails closed when either listener cannot bind, leaving neither running', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = blocker.address().port;
    try {
      const dataDir = await tempDir();
      const app = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      const own = () => {};
      app.on('error', own);
      app.visitorServer.on('error', own);
      await assert.rejects(listenAll(app, 0, taken), /could not start/);
      assert.deepEqual([app.listening, app.visitorServer.listening], [false, false], 'the visitor port was taken: nothing stays up');
      assert.deepEqual([app.listeners('error'), app.visitorServer.listeners('error')], [[own], [own]], 'caller error listeners are kept');
      const second = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      await assert.rejects(listenAll(second, taken, 0), /could not start/);
      assert.deepEqual([second.listening, second.visitorServer.listening], [false, false], 'the app port was taken: nothing stays up');
      const ok = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      await listenAll(ok, 0, 0);
      assert.deepEqual([ok.listening, ok.visitorServer.listening], [true, true]);
      ok.visitorServer.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual([ok.listening, ok.visitorServer.listening], [true, false], 'closing only the visitor listener keeps the app');
      await new Promise((resolve) => ok.close(resolve));
      // A visitor request still in flight keeps the app's close from completing.
      const both = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      await listenAll(both, 0, 0);
      const socket = net.connect(both.visitorServer.address().port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      let reply = '';
      socket.on('data', (chunk) => (reply += chunk));
      const ended = new Promise((resolve) => socket.once('close', resolve));
      socket.write(`GET /style.css HTTP/1.1\r\nHost: ${VISITOR_HOST}\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      let closed = false;
      const closing = new Promise((resolve) => both.close(() => {
        closed = true;
        resolve();
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        assert.equal(closed, false, 'close waits for the in-flight visitor request');
        socket.write('\r\n');
        await closing;
        await ended;
      } finally {
        socket.destroy();
      }
      assert.match(reply, /^HTTP\/1\.1 200/, 'the in-flight request was answered before close completed');
      assert.deepEqual([both.listening, both.visitorServer.listening], [false, false], 'closing the app closes both');

      // The visitor listener closed directly while a request is held, then the
      // app closed: completion still waits for that drain.
      const direct = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      await listenAll(direct, 0, 0);
      const held = net.connect(direct.visitorServer.address().port, '127.0.0.1');
      await new Promise((resolve) => held.once('connect', resolve));
      let answer = '';
      held.on('data', (chunk) => (answer += chunk));
      const heldEnded = new Promise((resolve) => held.once('close', resolve));
      held.write(`GET /style.css HTTP/1.1\r\nHost: ${VISITOR_HOST}\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      direct.visitorServer.close();
      assert.equal(direct.visitorServer.listening, false, 'already not listening while it drains');
      let appClosed = false;
      const appClosing = new Promise((resolve) => direct.close(() => {
        appClosed = true;
        resolve();
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        assert.equal(appClosed, false, 'app close waits for the draining visitor listener');
        held.write('\r\n');
        await appClosing;
        await heldEnded;
      } finally {
        held.destroy();
      }
      assert.match(answer, /^HTTP\/1\.1 200/);

      // Unbound, default and already fully closed listeners complete at once.
      const unbound = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      await new Promise((resolve) => unbound.listen(0, '127.0.0.1', resolve));
      await new Promise((resolve) => unbound.close(resolve));
      const plainApp = createAppServer({ dataDir });
      await listenAll(plainApp, 0);
      await new Promise((resolve) => plainApp.close(resolve));
      const finished = createAppServer({ dataDir, visitorOrigin: ORIGIN });
      await listenAll(finished, 0, 0);
      await new Promise((resolve) => finished.visitorServer.close(resolve));
      await new Promise((resolve) => finished.close(resolve));
      assert.deepEqual([finished.listening, finished.visitorServer.listening], [false, false]);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe('the visitor listener', () => {
  it('serves a real stored snapshot from the same live state, and stops on revocation, source stop and withdrawal', async () => {
    const { app, owner, visitorPort } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await recording(app, owner, scene);
      const linked = await share(owner, scene, (view) => ({
        recordings: [{ contributionId: contribution.id, viewIds: [view.id], targetId: 'place', captionSha256: contribution.voice.captions.sha256 }],
      }));
      assert.equal(linked.receipt.visitOrigin, ORIGIN, 'the issue response names the configured origin');
      const replay = await owner.post(`${scene.scene}/shares`, linked.body);
      assert.equal((await replay.json()).visitOrigin, ORIGIN, 'also on replay');
      const stored = JSON.stringify(JSON.parse(await readFile(path.join(app.dataDir, 'reconstructions', scene.draft.id, scene.job.id, 'manifest.json'), 'utf8')).shares);
      assert.ok(!stored.includes('visit.example'), 'the stored receipt is unchanged');

      const manifest = await raw(visitorPort, 'GET', '/api/visit', bearer(linked.token));
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers['cache-control'], 'no-store');
      assert.equal(manifest.headers['permissions-policy'], 'microphone=(), camera=(), geolocation=()');
      assert.equal(manifest.headers['set-cookie'], undefined);
      const publicView = JSON.parse(manifest.body.toString());
      const viewId = publicView.views[0].id;
      for (const name of ['texture.jpg', 'surface.json']) {
        assert.equal((await raw(visitorPort, 'GET', `/api/visit/assets/${viewId}/${name}`, bearer(linked.token))).status, 200, name);
      }
      assert.equal((await raw(visitorPort, 'HEAD', `/api/visit/assets/${viewId}/texture.jpg`, bearer(linked.token))).status, 200);
      const ranged = await raw(visitorPort, 'GET', `/api/visit/assets/${viewId}/texture.jpg`, { ...bearer(linked.token), range: 'bytes=0-3' });
      assert.deepEqual([ranged.status, ranged.body.length], [206, 4]);
      const audio = await raw(visitorPort, 'GET', `/api/visit/recordings/${publicView.contributorRecordings[0].id}/audio.wav`, bearer(linked.token));
      assert.deepEqual([audio.status, audio.body], [200, WAV]);
      for (const headers of [{}, bearer(`rhv_${randomBytes(32).toString('base64url')}`), { authorization: 'Bearer nope' }, { cookie: app.cookie }]) {
        const refused = await raw(visitorPort, 'GET', '/api/visit', headers);
        assert.equal(refused.status, 404, JSON.stringify(headers).slice(0, 40));
        assert.equal(refused.headers['set-cookie'], undefined);
      }

      const revoked = await share(owner, scene);
      assert.equal((await raw(visitorPort, 'GET', '/api/visit', bearer(revoked.token))).status, 200);
      assert.equal((await owner.post(`${scene.scene}/shares/${revoked.receipt.id}/revoke`, { requestId: randomUUID() })).status, 200);
      assert.equal((await raw(visitorPort, 'GET', '/api/visit', bearer(revoked.token))).status, 404, 'revocation applies at once');

      const plain = await share(owner, scene);
      assert.equal((await session.post(`${scene.scene}/contributions/${contribution.id}/withdraw`, { requestId: randomUUID() })).status, 200);
      assert.equal((await raw(visitorPort, 'GET', '/api/visit', bearer(linked.token))).status, 404, 'withdrawal applies at once');
      assert.equal((await raw(visitorPort, 'GET', '/api/visit', bearer(plain.token))).status, 200, 'an independent snapshot stays');

      const policy = `/api/drafts/${scene.draft.id}/sources/${scene.sourceId}/policy`;
      const { revision } = await owner.json(policy);
      assert.equal((await owner.post(policy, { requestId: randomUUID(), baseRevision: revision, permissions: { place: true, model: true, share: false }, stopUse: false })).status, 200);
      assert.equal((await raw(visitorPort, 'GET', '/api/visit', bearer(plain.token))).status, 404, 'a source share stop applies at once');

      // The private listener is unchanged.
      assert.equal((await owner.request('/app.js')).status, 200);
      assert.equal((await client(app.base).request('/api/visit', { headers: bearer(plain.token) })).status, 404);
    } finally {
      await app.close();
    }
  });

  it('never reaches a private route, file or cookie, whatever the method, headers or path', async () => {
    const { app, owner, dataDir, visitorPort } = await workspace();
    try {
      const scene = await place(owner);
      const { token } = await share(owner, scene);
      const manifestFile = path.join(dataDir, 'reconstructions', scene.draft.id, scene.job.id, 'manifest.json');
      const before = await readFile(manifestFile, 'utf8');
      const privatePort = new URL(app.base).port;
      const targets = [
        '/api/session', '/api/session/login', '/api/session/logout', '/api/session/recover', '/api/invitations', '/api/invitations/redeem', '/api/contributor/places',
        '/api/drafts', `/api/drafts/${scene.draft.id}`, `/api/drafts/${scene.draft.id}/assets/photo-1.png`, `/api/drafts/${scene.draft.id}/reconstructions`, scene.scene,
        `${scene.scene}/edit`, `${scene.scene}/shares`, `${scene.scene}/shares/previews`, `${scene.scene}/collaboration`, `${scene.scene}/contributions`, `${scene.scene}/proposals`,
        `${scene.scene}/assets/texture.jpg`, '/api/intakes', `/api/drafts/${scene.draft.id}/sources/${scene.sourceId}/policy`,
        '/app.js', '/space.js', '/collaboration.js', '/access-ui.js', '/shares.js', '/intake.js', '/index.html', '/data/access.json', '/server.mjs',
        '/visible-surfaces.js', '/vendor/three-mesh-bvh.js', '/vendor/THREE-MESH-BVH-LICENSE',
        '/../app.js', '/%2e%2e/app.js', '/%2F..%2Fapp.js', '//api/drafts', '/api/visit/../drafts', '/visits.js/../app.js', `http://127.0.0.1:${privatePort}/api/drafts`,
      ];
      const forged = { cookie: app.cookie, origin: app.base, 'x-forwarded-host': `127.0.0.1:${privatePort}`, 'x-forwarded-proto': 'http', forwarded: `host=127.0.0.1:${privatePort}`, ...bearer(token) };
      for (const target of targets) {
        for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'DELETE']) {
          const response = await raw(visitorPort, method, target, { ...forged, ...(method === 'POST' && { 'content-type': 'application/json' }) }, method === 'POST' ? '{"requestId":"x"}' : null);
          assert.equal(response.status, 404, `${method} ${target}`);
          assert.equal(response.headers['set-cookie'], undefined, `${method} ${target}`);
          // A path under /api/visit stays in the visit handler and gets its fixed refusal.
          const expected = target.startsWith('/api/visit') && (method === 'GET' || method === 'HEAD') ? VISIT_UNAVAILABLE : 'Not found.';
          if (method !== 'HEAD') assert.deepEqual(JSON.parse(response.body.toString()), { error: expected }, `${method} ${target}`);
        }
      }
      for (const host of [`127.0.0.1:${privatePort}`, `localhost:${privatePort}`, `127.0.0.1:${visitorPort}`, 'evil.example', '']) {
        const response = await raw(visitorPort, 'GET', '/api/drafts', { host, cookie: app.cookie });
        assert.equal(response.status, 403, `Host ${host}`);
      }
      assert.equal((await raw(visitorPort, 'POST', '/api/visit', bearer(token), 'x'.repeat(1024))).status, 404, 'no visitor POST');
      assert.equal(await readFile(manifestFile, 'utf8'), before, 'nothing changed');
      assert.equal((await owner.json('/api/drafts')).length, 1);
    } finally {
      await app.close();
    }
  });

  it('serves only the visit page files and pinned Three.js with visitor headers', async () => {
    const { app, visitorPort } = await workspace();
    try {
      for (const target of ['/style.css', '/visits.js', '/scene-viewer.js', '/photo-scene.js', '/story-player.js', '/playback.js', '/arrangement.js', '/vendor/three.module.js', '/vendor/three.core.js', '/vendor/OrbitControls.js']) {
        const response = await raw(visitorPort, 'GET', target, { cookie: app.cookie });
        assert.equal(response.status, 200, target);
        assert.equal(response.headers['permissions-policy'], 'microphone=(), camera=(), geolocation=()', target);
        assert.equal(response.headers['set-cookie'], undefined, target);
        assert.match(response.headers['content-security-policy'], /default-src 'self'/);
      }
      // The visit page and its entry module are required.
      const page = await raw(visitorPort, 'GET', '/');
      assert.equal(page.status, 200);
      assert.equal(page.body.toString(), await readFile(path.join(PUBLIC, 'visit.html'), 'utf8'), 'the visit page, not the app page');
      assert.equal((await raw(visitorPort, 'GET', '/visitor-entry.js')).status, 200);
      // The viewer imports only the mask reader; serving its static module
      // does not mount the editor or authorize an owner route.
      assert.equal((await raw(visitorPort, 'GET', '/object-outline-editor.js')).status, 200);
      // Every module the visit page can load is on the allowlist.
      const seen = new Set();
      const queue = ['visitor-entry.js'];
      while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        const source = await readFile(path.join(PUBLIC, file), 'utf8');
        for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.\/[^'"]+)['"]|import\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
          const dependency = (match[1] ?? match[2]).slice(2);
          queue.push(dependency);
        }
      }
      for (const file of seen) assert.equal((await raw(visitorPort, 'GET', `/${file}`)).status, 200, `${file} is served`);
    } finally {
      await app.close();
    }
  });
});
