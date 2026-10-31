import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runCli } from '../access-cli.mjs';
import { AccessStore, freshCredentials, generateSecret } from '../access.mjs';
import { createAppServer } from '../server.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Synthetic images and grids only; no personal media.
function png(width, height, fill = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), header, Buffer.alloc(36, fill)]);
}

function jpeg(width, height, fill = 0) {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), frame, Buffer.alloc(32, fill), Buffer.from([0xff, 0xd9])]);
}

const PHOTO = png(40, 30, 7);
const BOX = [4, 3, 20, 24];

async function runner({ imagePath, outputDir, sourceId, box }) {
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const surface = {
    source: {
      source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30],
      texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' },
      selected_object: { id: 'foreground', box_xyxy: box },
    },
    width: 4, height: 3, depth: Array(12).fill(3), foreground: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(4, 3), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify(surface),
    'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture) }),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

const tempDirs = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-access-'));
  tempDirs.push(dir);
  return dir;
}
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function start(dataDir, options = {}) {
  const server = createAppServer({ dataDir, reconstructionRunner: runner, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A real HTTP client that keeps only the cookie the server set for it.
function client(base, cookie = null) {
  const request = (route, init = {}) => fetch(`${base}${route}`, { ...init, headers: { ...(cookie && { cookie }), ...init.headers } });
  return {
    get cookie() {
      return cookie;
    },
    request,
    post: (route, body, headers = {}) => request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    async login(accessKey) {
      const response = await this.post('/api/session/login', { accessKey });
      if (response.status === 200) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    },
  };
}

async function ownerWorkspace(options) {
  const dataDir = await tempDir();
  const credentials = freshCredentials();
  const owner = await new AccessStore({ dataDir }).bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...credentials });
  const app = await start(dataDir, options);
  const session = client(app.base);
  assert.equal((await session.login(credentials.accessKey)).status, 200);
  return { app, dataDir, credentials, owner, session };
}

const grants = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: false }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };

// A saved memory with a ready scene and one saved edit, made through the owner session.
async function savedScene(session) {
  const form = new FormData();
  form.append('photos', new Blob([PHOTO]), 'photo');
  form.append('metadata', JSON.stringify({ photos: [grants] }));
  const draft = await (await session.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await session.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: BOX })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await (await session.request(scene)).json()).status !== 'ready'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await session.post(`${scene}/edit`, { requestId: randomUUID(), baseVersion: 1, offset: [0.5, 0, 0], yaw: 0.25 })).status, 200);
  return { draft, scene, asset: `/api/drafts/${draft.id}/assets/${draft.photos[0].name}` };
}

// Every content route, with known and unknown IDs, readable and writing methods.
function contentRequests({ draft, scene, asset }) {
  const unknown = randomUUID();
  return [
    ['GET', '/api/drafts'],
    ['POST', '/api/drafts'],
    ['GET', `/api/drafts/${draft.id}`],
    ['HEAD', `/api/drafts/${draft.id}`],
    ['GET', asset],
    ['HEAD', asset],
    ['GET', asset, { range: 'bytes=0-3' }],
    ['GET', `/api/drafts/${unknown}`],
    ['GET', `/api/drafts/not-an-id/assets/x`],
    ['GET', `/api/drafts/${draft.id}/sources/${draft.photos[0].sourceId}/image-size`],
    ['GET', `/api/drafts/${draft.id}/reconstructions`],
    ['POST', `/api/drafts/${draft.id}/reconstructions`],
    ['GET', scene],
    ['GET', `${scene}/assets/texture.jpg`],
    ['GET', `${scene}/assets/texture.jpg`, { range: 'bytes=0-3' }],
    ['POST', `${scene}/edit`],
    ['GET', `${scene}/history`],
    ['POST', `${scene}/undo`],
    ['GET', `${scene}/proposals`],
    ['POST', `${scene}/proposals`],
    ['GET', `${scene}/proposals/${unknown}`],
    ['POST', `${scene}/proposals/${unknown}/apply`],
    ['POST', `${scene}/proposals/${unknown}/cancel`],
    ['GET', '/api/unknown'],
  ];
}

async function assertDenied(session, routes, status) {
  for (const [method, route, headers = {}] of routes) {
    const init = { method, headers: { ...headers, ...(method === 'POST' && { 'content-type': 'application/json' }) } };
    if (method === 'POST') init.body = '{}';
    const response = await session.request(route, init);
    assert.equal(response.status, status, `${method} ${route}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${route}`);
    if (method !== 'HEAD') {
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['error'], `${method} ${route}`);
      assert.equal(body.error, status === 401 ? 'Sign in to continue.' : 'This action is not allowed.');
    }
  }
}

describe('workspace access before setup', () => {
  it('reports setup needed and serves no content or session', async () => {
    const dataDir = await tempDir();
    const app = await start(dataDir);
    try {
      const anonymous = client(app.base);
      assert.deepEqual(await (await anonymous.request('/api/session')).json(), { initialized: false, principal: null });
      assert.equal((await anonymous.login(generateSecret('access'))).status, 401);
      assert.equal((await anonymous.request('/api/drafts')).status, 401);
      assert.equal((await anonymous.request('/')).status, 200);
      assert.equal((await anonymous.request('/app.js')).status, 200);
      assert.deepEqual(await readdir(dataDir), []);
    } finally {
      await app.close();
    }
  });
});

describe('owner sessions', () => {
  it('signs in with a port-scoped HttpOnly cookie that only the cookie header carries', async () => {
    const { app, owner, session, credentials } = await ownerWorkspace();
    try {
      const response = await client(app.base).login(credentials.accessKey);
      const header = response.headers.get('set-cookie');
      assert.match(header, new RegExp(`^rehere_session_${app.port}=rhs_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200$`));
      const body = await response.json();
      assert.deepEqual(body, { principal: owner });
      assert.ok(!JSON.stringify(body).includes('rhs_'));
      assert.deepEqual(await (await session.request('/api/session')).json(), { initialized: true, principal: owner });

      const token = session.cookie.split('=')[1];
      for (const init of [{ headers: { authorization: `Bearer ${token}` } }, { headers: { cookie: `rehere_session_1=${token}` } }]) {
        assert.equal((await fetch(`${app.base}/api/drafts`, init)).status, 401);
      }
      assert.equal((await fetch(`${app.base}/api/drafts?session=${token}`)).status, 401);
    } finally {
      await app.close();
    }
  });

  it('rejects wrong keys generically, other families, malformed bodies and cross-site sign-in', async () => {
    const { app, credentials } = await ownerWorkspace();
    try {
      const anonymous = client(app.base);
      for (const key of [generateSecret('access'), credentials.recoveryKey, 'rha_short']) {
        const response = await anonymous.login(key);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(await response.json(), { error: 'The key was not accepted.' });
      }
      assert.equal((await anonymous.post('/api/session/login', { accessKey: credentials.accessKey, extra: 1 })).status, 400);
      assert.equal((await anonymous.post('/api/session/login', { accessKey: credentials.accessKey }, { origin: 'http://attacker.example' })).status, 403);
    } finally {
      await app.close();
    }
  });

  it('ends the session on logout and keeps sessions across restart', async () => {
    const { app, dataDir, session, credentials } = await ownerWorkspace();
    const second = client(app.base);
    await second.login(credentials.accessKey);
    await app.close();
    const restarted = await start(dataDir);
    try {
      const again = client(restarted.base, second.cookie.replace(/_\d+=/, `_${restarted.port}=`));
      assert.equal((await again.request('/api/drafts')).status, 200);
      const out = await again.post('/api/session/logout', {});
      assert.equal(out.status, 200);
      assert.equal(out.headers.get('set-cookie'), `rehere_session_${restarted.port}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      assert.equal((await again.request('/api/drafts')).status, 401);
      assert.equal((await again.post('/api/session/logout', {})).status, 200);
      const other = client(restarted.base, session.cookie.replace(/_\d+=/, `_${restarted.port}=`));
      assert.equal((await other.request('/api/drafts')).status, 200);
    } finally {
      await restarted.close();
    }
  });

  it('expires a session after idle time on the server clock', async () => {
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const dataDir = await tempDir();
    const accessStore = new AccessStore({ dataDir, now: () => clock });
    const credentials = freshCredentials();
    await accessStore.bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...credentials });
    const app = await start(dataDir, { accessStore });
    try {
      const session = client(app.base);
      await session.login(credentials.accessKey);
      assert.equal((await session.request('/api/drafts')).status, 200);
      clock += 30 * 60_000;
      assert.equal((await session.request('/api/drafts')).status, 401);
    } finally {
      await app.close();
    }
  });
});

describe('content authority', () => {
  it('denies every content route without a session, including HEAD, ranges and unknown IDs', async () => {
    const { app, session } = await ownerWorkspace();
    try {
      const saved = await savedScene(session);
      await assertDenied(client(app.base), contentRequests(saved), 401);
      await assertDenied(client(app.base, `rehere_session_${app.port}=${generateSecret('session')}`), contentRequests(saved), 401);
    } finally {
      await app.close();
    }
  });

  it('enrolls a contributor through a one-use invitation who can neither read nor edit owner content', async () => {
    const { app, session } = await ownerWorkspace();
    try {
      const saved = await savedScene(session);
      const token = generateSecret('invitation');
      const inviteBody = { requestId: randomUUID(), draftId: saved.draft.id, expiresInHours: 24, token };
      const created = await session.post('/api/invitations', inviteBody);
      assert.equal(created.status, 201);
      const invite = await created.json();
      assert.deepEqual(Object.keys(invite).sort(), ['draftId', 'expiresAt', 'id', 'status']);
      assert.deepEqual(await (await session.post('/api/invitations', inviteBody)).json(), invite);
      assert.equal((await session.post('/api/invitations', { ...inviteBody, expiresInHours: 2 })).status, 409);
      assert.equal((await session.post('/api/invitations', { ...inviteBody, requestId: randomUUID(), draftId: randomUUID(), token: generateSecret('invitation') })).status, 404);
      assert.equal((await session.post('/api/invitations', { ...inviteBody, draftId: 'x' })).status, 400);

      const keys = freshCredentials();
      const redeem = { token, requestId: randomUUID(), displayName: 'Synthetic contributor', ...keys };
      const anonymous = client(app.base);
      const redeemed = await anonymous.post('/api/invitations/redeem', redeem);
      assert.equal(redeemed.status, 200);
      assert.equal(redeemed.headers.get('set-cookie'), null);
      const { principal } = await redeemed.json();
      assert.deepEqual(principal, { id: principal.id, role: 'contributor', displayName: 'Synthetic contributor', draftIds: [saved.draft.id] });
      assert.deepEqual(await (await anonymous.post('/api/invitations/redeem', redeem)).json(), { principal });
      assert.equal((await anonymous.post('/api/invitations/redeem', { ...redeem, requestId: randomUUID(), ...freshCredentials() })).status, 409);

      const contributor = client(app.base);
      assert.equal((await contributor.login(keys.accessKey)).status, 200);
      assert.deepEqual((await (await contributor.request('/api/session')).json()).principal, principal);
      await assertDenied(contributor, contentRequests(saved), 403);
      await assertDenied(contributor, [['GET', '/api/invitations'], ['POST', '/api/invitations'], ['POST', `/api/invitations/${invite.id}/revoke`]], 403);

      const list = await (await session.request('/api/invitations')).json();
      assert.deepEqual(list.map((item) => [item.id, item.status]), [[invite.id, 'redeemed']]);
      assert.ok(!JSON.stringify(list).includes(token));
    } finally {
      await app.close();
    }
  });

  it('refuses a revoked invitation and keeps the access file free of raw keys', async () => {
    const { app, dataDir, session, credentials } = await ownerWorkspace();
    try {
      const saved = await savedScene(session);
      const token = generateSecret('invitation');
      const invite = await (await session.post('/api/invitations', { requestId: randomUUID(), draftId: saved.draft.id, expiresInHours: 1, token })).json();
      const revoked = await session.post(`/api/invitations/${invite.id}/revoke`, {});
      assert.equal(revoked.status, 200);
      assert.equal((await revoked.json()).status, 'revoked');
      const keys = freshCredentials();
      assert.equal((await client(app.base).post('/api/invitations/redeem', { token, requestId: randomUUID(), displayName: 'Late', ...keys })).status, 403);
      const stored = await readFile(path.join(dataDir, 'access.json'), 'utf8');
      for (const secret of [token, credentials.accessKey, credentials.recoveryKey, keys.accessKey, session.cookie.split('=')[1]]) {
        assert.ok(!stored.includes(secret));
      }
    } finally {
      await app.close();
    }
  });
});

describe('owner recovery', () => {
  it('replaces both keys, ends every session and reopens the same scene and history after a new sign-in', async () => {
    const { app, dataDir, session, owner, credentials } = await ownerWorkspace();
    try {
      const saved = await savedScene(session);
      const history = await (await session.request(`${saved.scene}/history`)).json();
      const fresh = freshCredentials();
      const recovered = await session.post('/api/session/recover', { recoveryKey: credentials.recoveryKey, newAccessKey: fresh.accessKey, newRecoveryKey: fresh.recoveryKey });
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), { principal: owner });
      assert.match(recovered.headers.get('set-cookie'), /Max-Age=0$/);
      assert.equal((await session.request('/api/drafts')).status, 401);

      const anonymous = client(app.base);
      assert.equal((await anonymous.login(credentials.accessKey)).status, 401);
      assert.equal((await anonymous.post('/api/session/recover', { recoveryKey: credentials.recoveryKey, ...(({ accessKey, recoveryKey }) => ({ newAccessKey: accessKey, newRecoveryKey: recoveryKey }))(freshCredentials()) })).status, 401);

      await app.close();
      const restarted = await start(dataDir);
      try {
        const signedIn = client(restarted.base);
        assert.equal((await signedIn.login(fresh.accessKey)).status, 200);
        assert.deepEqual((await (await signedIn.request('/api/session')).json()).principal, owner);
        assert.deepEqual(await (await signedIn.request(`${saved.scene}/history`)).json(), history);
        assert.deepEqual((await (await signedIn.request(saved.scene)).json()).edit, { version: 2, offset: [0.5, 0, 0], yaw: 0.25 });
        const original = await signedIn.request(saved.asset);
        assert.equal(sha256(Buffer.from(await original.arrayBuffer())), sha256(PHOTO));
      } finally {
        await restarted.close();
      }
    } finally {
      await app.close();
    }
  });
});

describe('failed owner recovery', () => {
  it('clears the browser cookie but keeps server sessions and keys unchanged', async () => {
    const { app, dataDir, session, credentials } = await ownerWorkspace();
    try {
      const before = await readFile(path.join(dataDir, 'access.json'), 'utf8');
      const fresh = freshCredentials();
      for (const body of [
        { recoveryKey: generateSecret('recovery'), newAccessKey: fresh.accessKey, newRecoveryKey: fresh.recoveryKey },
        { recoveryKey: credentials.recoveryKey, newAccessKey: fresh.accessKey },
      ]) {
        const response = await session.post('/api/session/recover', body);
        assert.ok([400, 401].includes(response.status));
        assert.equal(response.headers.get('set-cookie'), `rehere_session_${app.port}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.equal((await session.request('/api/drafts')).status, 200);
      assert.equal((await client(app.base).login(credentials.accessKey)).status, 200);
      assert.equal((await client(app.base).login(fresh.accessKey)).status, 401);
      const after = JSON.parse(await readFile(path.join(dataDir, 'access.json'), 'utf8'));
      assert.deepEqual(after.principals, JSON.parse(before).principals);
    } finally {
      await app.close();
    }
  });
});

describe('credential attempt limit', () => {
  it('blocks sign-in, recovery and redemption after ten rejected attempts from one address', async () => {
    const { app, credentials } = await ownerWorkspace();
    try {
      const anonymous = client(app.base);
      for (let attempt = 0; attempt < 5; attempt++) assert.equal((await anonymous.login(generateSecret('access'))).status, 401);
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal((await anonymous.post('/api/session/recover', { recoveryKey: generateSecret('recovery'), newAccessKey: generateSecret('access'), newRecoveryKey: generateSecret('recovery') })).status, 401);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal((await anonymous.post('/api/invitations/redeem', { token: generateSecret('invitation'), requestId: randomUUID(), displayName: 'x', ...freshCredentials() })).status, 403);
      }
      const blocked = await anonymous.login(credentials.accessKey);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('set-cookie'), null);
      assert.equal((await anonymous.request('/api/session')).status, 200);
    } finally {
      await app.close();
    }
  });

  it('counts attempts still in flight, so concurrent wrong keys cannot all be checked', async () => {
    const { app, credentials } = await ownerWorkspace();
    try {
      const anonymous = client(app.base);
      const statuses = (await Promise.all(Array.from({ length: 20 }, () => anonymous.login(generateSecret('access'))))).map((response) => response.status);
      assert.equal(statuses.filter((status) => status === 401).length, 10);
      assert.equal(statuses.filter((status) => status === 429).length, 10);
      assert.equal((await anonymous.login(credentials.accessKey)).status, 429);
    } finally {
      await app.close();
    }
  });
});

describe('owner setup command', () => {
  const quiet = () => {
    const lines = [];
    return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) };
  };

  it('writes a private card before saving the owner and never prints keys', async () => {
    const dataDir = await tempDir();
    const card = path.join(await tempDir(), 'owner-card.json');
    const log = quiet();
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'Synthetic owner'], { dataDir, env: { PORT: '19802' }, ...log }), 0);
    const saved = JSON.parse(await readFile(card, 'utf8'));
    assert.equal((await stat(card)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(saved), ['format', 'note', 'origin', 'createdAt', 'workspace', 'requestId', 'displayName', 'accessKey', 'recoveryKey']);
    assert.equal(saved.format, 'rehere-owner-recovery-card');
    assert.equal(saved.origin, 'http://127.0.0.1:19802');
    assert.equal(new Date(saved.createdAt).toISOString(), saved.createdAt);
    assert.equal(saved.workspace, path.resolve(dataDir));
    assert.equal(saved.displayName, 'Synthetic owner');
    assert.match(saved.requestId, /^[0-9a-f-]{36}$/);
    assert.match(saved.accessKey, /^rha_/);
    assert.match(saved.recoveryKey, /^rhr_/);
    assert.ok(!log.lines.join('\n').includes(saved.accessKey));
    assert.ok(!log.lines.join('\n').includes(saved.recoveryKey));
    assert.equal((await readFile(path.join(dataDir, 'access.json'), 'utf8')).includes(saved.accessKey), false);

    const app = await start(dataDir);
    try {
      assert.equal((await client(app.base).login(saved.accessKey)).status, 200);
    } finally {
      await app.close();
    }
    const second = path.join(path.dirname(card), 'second.json');
    assert.equal(await runCli(['init', '--credentials-file', second, '--name', 'Another'], { dataDir, ...quiet() }), 1);
    await assert.rejects(stat(second));
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'Synthetic owner'], { dataDir, ...quiet() }), 1);
  });

  it('refuses served folders, an existing file and a card from another workspace', async () => {
    const dataDir = await tempDir();
    const appDir = path.resolve(import.meta.dirname, '..');
    const repoDir = path.resolve(appDir, '..');
    const outside = await tempDir();
    for (const target of [
      path.join(appDir, 'public', 'card.json'),
      path.join(appDir, 'public', '..owner-card.json'),
      path.join(appDir, 'node_modules', 'card.json'),
      path.join(appDir, 'card.json'),
      path.join(appDir, 'test', 'card.json'),
      path.join(repoDir, 'docs', 'card.json'),
      path.join(repoDir, 'card.json'),
      path.join(appDir, 'data'),
      path.join(outside, '.git', 'card.json'),
    ]) {
      assert.equal(await runCli(['init', '--credentials-file', target, '--name', 'x'], { dataDir, ...quiet() }), 2, target);
      if (target !== path.join(appDir, 'data')) await assert.rejects(stat(target), target);
    }
    // The ignored data folder is the one place inside the repository a card may go.
    const inData = path.join(appDir, 'data', `test-card-${randomUUID()}.json`);
    try {
      assert.equal(await runCli(['init', '--credentials-file', inData, '--name', 'x'], { dataDir: await tempDir(), ...quiet() }), 0);
      assert.equal((await stat(inData)).mode & 0o777, 0o600);
    } finally {
      await rm(inData, { force: true });
    }
    // A symlinked parent that resolves into a served folder is refused before anything is written.
    const linkDir = await tempDir();
    for (const name of ['public', 'node_modules']) {
      await symlink(path.join(appDir, name), path.join(linkDir, name));
      const target = path.join(linkDir, name, `rehere-card-${randomUUID()}.json`);
      try {
        assert.equal(await runCli(['init', '--credentials-file', target, '--name', 'x'], { dataDir, ...quiet() }), 2);
        await assert.rejects(stat(target));
      } finally {
        await rm(path.join(appDir, name, path.basename(target)), { force: true });
      }
    }
    const defaultCard = path.join(await tempDir(), 'default.json');
    assert.equal(await runCli(['init', '--credentials-file', defaultCard, '--name', 'x'], { dataDir: await tempDir(), env: {}, ...quiet() }), 0);
    assert.equal(JSON.parse(await readFile(defaultCard, 'utf8')).origin, 'http://127.0.0.1:4317');
    const badPort = path.join(await tempDir(), 'bad-port.json');
    assert.equal(await runCli(['init', '--credentials-file', badPort, '--name', 'x'], { dataDir, env: { PORT: '80x' }, ...quiet() }), 2);
    await assert.rejects(stat(badPort));
    const existing = path.join(await tempDir(), 'existing.json');
    await writeFile(existing, 'unrelated');
    assert.equal(await runCli(['init', '--credentials-file', existing, '--name', 'x'], { dataDir, ...quiet() }), 1);
    assert.equal(await readFile(existing, 'utf8'), 'unrelated');
    assert.equal(await runCli(['init', '--credentials-file', existing, '--name', 'x', '--resume'], { dataDir, ...quiet() }), 1);
    assert.deepEqual(await readdir(dataDir), []);

    const card = path.join(await tempDir(), 'card.json');
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'x'], { dataDir: await tempDir(), ...quiet() }), 0);
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'x', '--resume'], { dataDir, ...quiet() }), 1);
    assert.deepEqual(await readdir(dataDir), []);
  });

  it('reports a completed setup even when existing memories cannot be counted', async () => {
    const dataDir = await tempDir();
    // A file where the drafts folder belongs makes listing fail after the owner is saved.
    await writeFile(path.join(dataDir, 'drafts'), '');
    const log = quiet();
    const card = path.join(await tempDir(), 'card.json');
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'x'], { dataDir, ...log }), 0);
    assert.match(log.lines.join('\n'), /Workspace owner is set up/);
    assert.match(log.lines.join('\n'), /could not be counted/);
    assert.equal((await new AccessStore({ dataDir }).state()).initialized, true);
  });

  it('finishes with --resume after a failed save and only confirms the setup once keys were rotated', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const card = path.join(await tempDir(), 'card.json');
    // A read-only data folder lets the state read succeed but the owner save fail after the card is written.
    const blocked = await tempDir();
    await chmod(blocked, 0o500);
    const failed = quiet();
    try {
      assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'Synthetic owner'], { dataDir: blocked, ...failed }), 1);
    } finally {
      await chmod(blocked, 0o700);
    }
    assert.match(failed.lines.join('\n'), /card is saved .* --resume/);
    assert.deepEqual(await readdir(blocked), []);
    // A card from before origin and createdAt existed still resumes, and is never rewritten.
    const legacy = JSON.parse(await readFile(card, 'utf8'));
    delete legacy.origin;
    delete legacy.createdAt;
    await writeFile(card, JSON.stringify(legacy), { mode: 0o600 });
    const saved = legacy;
    const log = quiet();
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'ignored', '--resume'], { dataDir: blocked, ...log }), 0);
    assert.match(log.lines.join('\n'), /no longer sign in/);
    assert.equal(await readFile(card, 'utf8'), JSON.stringify(legacy));

    const access = new AccessStore({ dataDir: blocked });
    const fresh = freshCredentials();
    await access.recover({ recoveryKey: saved.recoveryKey, newAccessKey: fresh.accessKey, newRecoveryKey: fresh.recoveryKey });
    assert.equal(await runCli(['init', '--credentials-file', card, '--name', 'ignored', '--resume'], { dataDir: blocked, ...quiet() }), 0);
    const app = await start(blocked);
    try {
      assert.equal((await client(app.base).login(saved.accessKey)).status, 401);
      assert.equal((await client(app.base).login(fresh.accessKey)).status, 200);
    } finally {
      await app.close();
    }
  });
});
