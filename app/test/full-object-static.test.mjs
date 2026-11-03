import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { startOwnerServer } from './auth-helper.mjs';

it('serves the exact pinned GLTF closure on both listeners without opening owner modules', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-object-static-'));
  const app = await startOwnerServer({ dataDir, visitorOrigin: 'https://visit.example' });
  try {
    await new Promise((resolve) => app.server.visitorServer.listen(0, '127.0.0.1', resolve));
    const port = app.server.visitorServer.address().port;
    const routes = [
      ['/vendor/loaders/GLTFLoader.js', 'loaders/GLTFLoader.js'],
      ['/vendor/utils/BufferGeometryUtils.js', 'utils/BufferGeometryUtils.js'],
      ['/vendor/utils/SkeletonUtils.js', 'utils/SkeletonUtils.js'],
    ];
    for (const [route, file] of routes) {
      const actual = await fetch(`${app.base}${route}`);
      assert.equal(actual.status, 200, route);
      const source = await readFile(new URL(`../node_modules/three/examples/jsm/${file}`, import.meta.url), 'utf8');
      assert.equal(await actual.text(), source.replace("from 'three';", "from '/vendor/three.module.js';"));
      const status = await new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: route, headers: { host: 'visit.example' } }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
      });
      assert.equal(status, 200, route);
    }
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
