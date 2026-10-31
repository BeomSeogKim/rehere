import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { generateSecret } from '../access.mjs';
import { client, enrolledContributor, readyScene, sceneRunner, startOwnerServer } from './auth-helper.mjs';

const UNAVAILABLE = { error: 'This shared place is not available.' };
const visitToken = () => `rhv_${randomBytes(32).toString('base64url')}`;
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function workspace(dataDir) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-share-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

const sharesOf = (scene) => `/api/drafts/${scene.draft.id}/reconstructions/${scene.job.id}/shares`;
const camera = { position: [0, 0, 2], target: [0, 0, -3] };

function previewBody(views, change = {}) {
  return { requestId: randomUUID(), title: 'Synthetic corner shop', views, startViewId: views[0].id, camera, contributionIds: [], synthetic: true, ...change };
}

const versionView = (version) => ({ id: randomUUID(), kind: 'version', version, variantId: null });

// Builds a preview, then issues it with a client-made token.
async function issued(owner, scene, views = [versionView(1)], change = {}) {
  const preview = await owner.post(`${sharesOf(scene)}/previews`, previewBody(views, change));
  assert.equal(preview.status, 201);
  const { id, digest } = await preview.json();
  const token = visitToken();
  const body = { requestId: randomUUID(), previewId: id, previewDigest: digest, token, consent: true };
  const response = await owner.post(sharesOf(scene), body);
  assert.equal(response.status, 201);
  return { token, body, receipt: await response.json(), views };
}

// An anonymous browser holding only the visit token.
function visitor(base, token, headers = {}) {
  const request = (route, init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers, ...init.headers } });
  return { request, json: async (route) => (await request(route)).json() };
}

async function assertUnavailable(response, label, method = 'GET') {
  assert.equal(response.status, 404, label);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  assert.equal(response.headers.get('set-cookie'), null, label);
  if (method !== 'HEAD') assert.deepEqual(await response.json(), UNAVAILABLE, label);
}

// Every key and string a visitor receives, for leak checks.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

describe('visitor boundary', () => {
  it('answers every malformed, missing or wrong-family credential with one generic refusal', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const { token, views } = await issued(owner, scene);
      const asset = `/api/visit/assets/${views[0].id}/texture.jpg`;
      const variants = [
        [null, {}],
        [null, { authorization: `bearer ${token}` }],
        [null, { authorization: `Bearer  ${token}` }],
        [null, { authorization: `Token ${token}` }],
        [`${token}x`, {}],
        [token.slice(0, -1), {}],
        [visitToken(), {}],
        [generateSecret('access'), {}],
        [generateSecret('session'), {}],
        [generateSecret('invitation'), {}],
        [null, { cookie: app.cookie }],
      ];
      for (const [credential, headers] of variants) {
        for (const route of ['/api/visit', asset]) {
          await assertUnavailable(await visitor(app.base, credential, headers).request(route), `${route} ${JSON.stringify(headers)} ${credential?.slice(0, 4)}`);
        }
        await assertUnavailable(await visitor(app.base, credential, headers).request('/api/visit', { method: 'HEAD' }), 'HEAD', 'HEAD');
      }
      await assertUnavailable(await globalThis.fetch(`${app.base}/api/visit?token=${token}`), 'query token');
      await assertUnavailable(await globalThis.fetch(`${app.base}/api/visit?access_token=${token}`, { headers: { cookie: app.cookie } }), 'query with owner cookie');
      // Two Authorization headers are refused even if both are valid. Node's
      // parser answers 400 with an empty body before the app runs.
      const doubled = await new Promise((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const req = request(`${app.base}/api/visit`, { headers: [['authorization', `Bearer ${token}`], ['authorization', `Bearer ${token}`]] }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          req.on('error', reject);
          req.end();
        });
      });
      assert.ok([400, 404].includes(doubled.status), String(doubled.status));
      assert.ok(!doubled.body.includes('Synthetic'));
      await assertUnavailable(await visitor(app.base, token).request('/api/visit', { method: 'POST' }), 'POST');
      await assertUnavailable(await visitor(app.base, token).request('/api/visit/unknown'), 'unknown path');
    } finally {
      await app.close();
    }
  });

  it('never lets a visit token reach owner, contributor or session routes', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const { token } = await issued(owner, scene);
      const guest = visitor(app.base, token);
      for (const route of ['/api/drafts', `/api/drafts/${scene.draft.id}`, scene.scene, scene.asset, scene.original, `${scene.scene}/history`, `${scene.scene}/proposals`,
        `${scene.scene}/collaboration`, sharesOf(scene), '/api/contributor/places', '/api/invitations']) {
        assert.equal((await guest.request(route)).status, 401, route);
      }
      assert.deepEqual((await guest.json('/api/session')).principal, null);
    } finally {
      await app.close();
    }
  });
});

describe('visitor snapshot content', () => {
  it('serves an allowlisted manifest and geometry-only surface, with ranges and no conditional shortcut', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const { token, views } = await issued(owner, scene);
      const guest = visitor(app.base, token);
      const manifest = await guest.json('/api/visit');
      assert.deepEqual(Object.keys(manifest).sort(), ['camera', 'createdAt', 'id', 'startViewId', 'synthetic', 'title', 'views']);
      assert.deepEqual(manifest.camera, camera);
      assert.equal(manifest.views[0].id, views[0].id);
      const leaked = strings(manifest).join('\n');
      for (const secret of [scene.draft.id, scene.job.id, scene.draft.photos[0].sourceId, scene.draft.photos[0].name, token, 'sha256', 'permissions', 'history', 'proposal']) {
        assert.ok(!leaked.includes(secret), secret);
      }

      const surfaceResponse = await guest.request(`/api/visit/assets/${views[0].id}/surface.json`);
      assert.equal(surfaceResponse.status, 200);
      assert.equal(surfaceResponse.headers.get('cache-control'), 'no-store');
      assert.equal(surfaceResponse.headers.get('x-content-type-options'), 'nosniff');
      const surface = await surfaceResponse.json();
      assert.deepEqual(surface.source, { image_size: [40, 30] });
      assert.ok(Array.isArray(surface.depth) && Array.isArray(surface.foreground));
      assert.ok(!JSON.stringify(surface).includes(scene.draft.photos[0].sourceId));
      const stored = JSON.parse(await readFile(path.join(dataDir, 'reconstructions', scene.draft.id, scene.job.id, 'assets', 'surface.json'), 'utf8'));
      assert.equal(stored.source.source_id, scene.draft.photos[0].sourceId, 'stored surface is not mutated');

      const texture = `/api/visit/assets/${views[0].id}/texture.jpg`;
      const full = Buffer.from(await (await guest.request(texture)).arrayBuffer());
      assert.deepEqual([...full.subarray(0, 2)], [0xff, 0xd8]);
      const partial = await guest.request(texture, { headers: { range: 'bytes=0-3' } });
      assert.equal(partial.status, 206);
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), full.subarray(0, 4));
      const surfaceRange = await guest.request(`/api/visit/assets/${views[0].id}/surface.json`, { headers: { range: 'bytes=0-0' } });
      assert.equal(surfaceRange.status, 206);
      assert.equal(await surfaceRange.text(), '{');
      assert.equal((await guest.request(texture, { headers: { range: 'bytes=999999-' } })).status, 416);
      const head = await guest.request(texture, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get('content-length')), full.length);
      const conditional = await guest.request(texture, { headers: { 'if-none-match': '*', 'if-modified-since': new Date().toUTCString() } });
      assert.equal(conditional.status, 200);
      assert.equal(conditional.headers.get('etag'), null);

      for (const name of ['mask.png', 'depth-preview.png', 'mask-overlay.jpg', 'summary.json', '..%2Fmanifest.json', scene.draft.photos[0].name]) {
        await assertUnavailable(await guest.request(`/api/visit/assets/${views[0].id}/${name}`), name);
      }
      await assertUnavailable(await guest.request(`/api/visit/assets/${randomUUID()}/texture.jpg`), 'unknown view');
    } finally {
      await app.close();
    }
  });

  it('keeps owner share routes owner-only and lists metadata without tokens', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const { token, body, receipt } = await issued(owner, scene);
      const { session: contributor } = await enrolledContributor(owner, app.base, scene.draft.id);
      for (const [method, route] of [['GET', sharesOf(scene)], ['POST', `${sharesOf(scene)}/previews`], ['POST', sharesOf(scene)], ['POST', `${sharesOf(scene)}/${receipt.id}/revoke`]]) {
        const init = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method };
        assert.equal((await client(app.base).request(route, init)).status, 401, route);
        assert.equal((await contributor.request(route, init)).status, 403, route);
      }
      const list = await owner.json(sharesOf(scene));
      assert.equal(list.length, 1);
      assert.equal(list[0].status, 'active');
      assert.ok(Date.parse(list[0].expiresAt) > Date.now());
      assert.ok(!JSON.stringify(list).includes(token));

      const replay = await owner.post(sharesOf(scene), body);
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), receipt);
      assert.equal((await owner.post(sharesOf(scene), { ...body, consent: false })).status, 400);
      assert.equal((await owner.post(sharesOf(scene), { ...body, requestId: randomUUID() })).status, 409, 'token reuse');
      assert.equal((await owner.post(sharesOf(scene), { ...body, requestId: randomUUID(), token: visitToken() })).status, 409, 'one issue per preview');
      assert.equal((await owner.json(sharesOf(scene))).length, 1);

      for (const file of await listFiles(dataDir)) {
        assert.ok(!(await readFile(file, 'latin1')).includes(token), file);
      }
    } finally {
      await app.close();
    }
  });
});

describe('snapshot authorization over time', () => {
  it('stops a revoked link at once and never reactivates it', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const { token, body, receipt, views } = await issued(owner, scene);
      const guest = visitor(app.base, token);
      assert.equal((await guest.request('/api/visit')).status, 200);
      const revokeBody = { requestId: randomUUID() };
      const revoked = await owner.post(`${sharesOf(scene)}/${receipt.id}/revoke`, revokeBody);
      assert.equal(revoked.status, 200);
      assert.equal((await revoked.json()).status, 'revoked');
      assert.equal((await owner.post(`${sharesOf(scene)}/${receipt.id}/revoke`, revokeBody)).status, 200);
      await assertUnavailable(await guest.request('/api/visit'), 'revoked');
      await assertUnavailable(await guest.request(`/api/visit/assets/${views[0].id}/texture.jpg`), 'revoked asset');
      const replay = await owner.post(sharesOf(scene), body);
      assert.equal((await replay.json()).status, 'revoked');
      await assertUnavailable(await guest.request('/api/visit'), 'after replay');
    } finally {
      await app.close();
    }
  });

  it('keeps a clean shared version visitable when a later private version is blocked, and stops one that depends on a withdrawn recollection', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await readyScene(owner, { share: true });
      const clean = await issued(owner, scene);
      const contributor = await enrolledContributor(owner, app.base, scene.draft.id);
      const collaboration = `${scene.scene}/collaboration`;
      await contributor.session.post(`${scene.scene}/contributions`, {
        requestId: randomUUID(), text: 'The counter stood further back.', permissions: { place: true, model: false, share: true }, periodClaim: '',
      });
      const [item] = (await owner.json(collaboration)).contributions;
      const adopted = await owner.post(`${scene.scene}/contributions/${item.id}/review`, {
        requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: '', conflict: 'unknown', transform: { offset: [0, 0, -0.5], yaw: 0 },
      });
      assert.equal(adopted.status, 200);
      const dependent = await issued(owner, scene, [versionView(2)], { contributionIds: [item.id] });
      const dependentManifest = await visitor(app.base, dependent.token).json('/api/visit');
      assert.equal(dependentManifest.views[0].evidence.recollections[0].text, 'The counter stood further back.');

      assert.equal((await contributor.session.post(`${scene.scene}/contributions/${item.id}/withdraw`, { requestId: randomUUID() })).status, 200);
      await assertUnavailable(await visitor(app.base, dependent.token).request('/api/visit'), 'dependent after withdrawal');
      await assertUnavailable(await visitor(app.base, dependent.token).request(`/api/visit/assets/${dependent.views[0].id}/texture.jpg`), 'dependent asset');
      assert.equal((await owner.json(scene.scene)).usageBlocked, true);
      assert.equal((await visitor(app.base, clean.token).request('/api/visit')).status, 200);
      assert.equal((await visitor(app.base, clean.token).request(`/api/visit/assets/${clean.views[0].id}/texture.jpg`)).status, 200);

      // Snapshots survive a cold restart unchanged.
      const before = await visitor(app.base, clean.token).json('/api/visit');
      await app.close();
      const restarted = await workspace(dataDir);
      try {
        assert.deepEqual(await visitor(restarted.app.base, clean.token).json('/api/visit'), before);
        await assertUnavailable(await visitor(restarted.app.base, dependent.token).request('/api/visit'), 'after restart');
      } finally {
        await restarted.app.close();
      }
    } finally {
      await app.close();
    }
  });

  it('refuses a preview of a photo without the share grant', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner, { share: false });
      const response = await owner.post(`${sharesOf(scene)}/previews`, previewBody([versionView(1)]));
      assert.equal(response.status, 403);
    } finally {
      await app.close();
    }
  });
});

async function listFiles(dir) {
  const files = [];
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}
