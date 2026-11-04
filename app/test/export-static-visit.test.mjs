import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pcmWav } from '../audio-derivative.mjs';
import { exportStaticVisit, VISITOR_MODULES } from '../export-static-visit.mjs';

const TOKEN = `rhv_${'A'.repeat(43)}`;
const WAV = pcmWav(Buffer.alloc(3200));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
const JPEG_WITH_EXIF = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-static-'));
  tempDirs.push(dir);
  return dir;
};

function snapshot(overrides = {}) {
  const viewId = randomUUID();
  const storyId = randomUUID();
  const recordingId = randomUUID();
  const manifest = {
    id: randomUUID(), title: 'Synthetic test place', synthetic: true, startViewId: viewId,
    views: [{ id: viewId, label: 'Original photograph' }],
    stories: [{ id: storyId, viewId }],
    contributorPhotos: [{ viewIds: [viewId], label: 'A synthetic photo', providerLabel: 'Synthetic contributor', asset: { viewId: 'evidence', name: '1.jpg' } }],
    contributorRecordings: [{ id: recordingId, viewIds: [viewId], providerLabel: 'Synthetic contributor' }],
    ...overrides.manifest,
  };
  const routes = new Map([
    ['/api/visit', Buffer.from(JSON.stringify(manifest))],
    [`/api/visit/assets/${viewId}/surface.json`, Buffer.from('{"synthetic":true}')],
    [`/api/visit/assets/${viewId}/texture.jpg`, JPEG],
    ['/api/visit/assets/evidence/1.jpg', overrides.evidence ?? JPEG],
    [`/api/visit/stories/${storyId}/audio.wav`, WAV],
    [`/api/visit/recordings/${recordingId}/audio.wav`, WAV],
  ]);
  for (const name of overrides.drop ?? []) routes.delete(name.replace('{story}', storyId));
  return { manifest, routes, viewId, storyId, recordingId };
}

async function withVisitor(routes, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const body = req.headers.authorization === `Bearer ${TOKEN}` ? routes.get(req.url) : undefined;
    res.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const exportInto = async (origin, extra = {}) => exportStaticVisit({ origin, token: TOKEN, outDir: await tempDir(), confirmPublicMaterial: true, ...extra });
const walk = async (dir, base = dir) => (await readdir(dir, { withFileTypes: true })).flatMap((entry) => (entry.isDirectory()
  ? []
  : [path.relative(base, path.join(dir, entry.name))])).concat(...await Promise.all((await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => walk(path.join(dir, entry.name), base))));

describe('static visitor export', () => {
  it('writes only the allowlisted snapshot, page, modules and pinned vendor files', async () => {
    const { manifest, routes, viewId, storyId, recordingId } = snapshot();
    await withVisitor(routes, async (origin) => {
      const result = await exportInto(origin);
      assert.equal(result.synthetic, true);
      assert.deepEqual(result.contributorLabels, ['Synthetic contributor']);
      const files = (await walk(result.outDir)).map((file) => file.split(path.sep).join('/')).sort();
      assert.deepEqual(files, [
        'EXPORT.json', 'index.html', 'style.css',
        ...VISITOR_MODULES,
        'data/manifest.json',
        `data/assets/${viewId}/surface.json`, `data/assets/${viewId}/texture.jpg`, 'data/assets/evidence/1.jpg',
        `data/stories/${storyId}/audio.wav`, `data/recordings/${recordingId}/audio.wav`,
        'vendor/OrbitControls.js', 'vendor/THREE-LICENSE', 'vendor/loaders/GLTFLoader.js', 'vendor/three.core.js', 'vendor/three.module.js',
        'vendor/utils/BufferGeometryUtils.js', 'vendor/utils/SkeletonUtils.js',
      ].sort());
      assert.deepEqual(JSON.parse(await readFile(path.join(result.outDir, 'data/manifest.json'), 'utf8')), manifest);
      const listing = JSON.parse(await readFile(path.join(result.outDir, 'EXPORT.json'), 'utf8'));
      for (const item of listing.files) {
        assert.equal(createHash('sha256').update(await readFile(path.join(result.outDir, item.path))).digest('hex'), item.sha256);
      }
    });
  });

  it('shows the offline notice and leaves no capability, origin, API call or absolute reference', async () => {
    const { routes } = snapshot();
    await withVisitor(routes, async (origin) => {
      const { outDir } = await exportInto(origin, { now: () => new Date('2026-11-04T12:00:00Z') });
      const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
      assert.match(html, /Offline snapshot\./);
      assert.match(html, /exported on 2026-11-04/);
      assert.match(html, /revokes the link, a contributor withdraws a memory/);
      assert.match(html, /src="\.\/static-entry\.js"/);
      assert.doesNotMatch(html, /(?:href|src)="\//);
      for (const file of await walk(outDir)) {
        const bytes = await readFile(path.join(outDir, file));
        assert.ok(!bytes.includes(TOKEN), file);
        assert.ok(!bytes.includes(origin), file);
        if (file === 'index.html' || file.startsWith('data')) assert.ok(!bytes.includes('/api/'), file);
        if (file.endsWith('.js') && !file.startsWith('vendor')) assert.doesNotMatch(bytes.toString('utf8'), /(?:from\s*|import\s*\(\s*)['"]\/(?!\/)/, file);
      }
      assert.match(await readFile(path.join(outDir, 'scene-viewer.js'), 'utf8'), /from '\.\/vendor\/three\.module\.js'/);
      assert.match(await readFile(path.join(outDir, 'vendor/OrbitControls.js'), 'utf8'), /from '\.\/three\.module\.js'/);
      assert.match(await readFile(path.join(outDir, 'vendor/loaders/GLTFLoader.js'), 'utf8'), /from '\.\.\/three\.module\.js'/);
    });
  });

  it('exports a closed module graph: every relative import resolves inside the folder', async () => {
    const { routes } = snapshot();
    await withVisitor(routes, async (origin) => {
      const { outDir } = await exportInto(origin);
      const exported = new Set((await walk(outDir)).map((file) => file.split(path.sep).join('/')));
      for (const file of exported) {
        if (!file.endsWith('.js')) continue;
        const source = await readFile(path.join(outDir, file), 'utf8');
        for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
          assert.ok(exported.has(target), `${file} imports ${match[2]}`);
        }
      }
    });
  });

  it('sends the capability only as a bearer header, never in a URL', async () => {
    const { routes } = snapshot();
    await withVisitor(routes, async (origin, requests) => {
      await exportInto(origin);
      assert.ok(requests.length >= 5);
      for (const request of requests) {
        assert.equal(request.authorization, `Bearer ${TOKEN}`);
        assert.ok(!request.url.includes(TOKEN));
      }
    });
  });

  it('serves the same visitor module list as the visitor listener', async () => {
    const server = await readFile(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
    const block = /const VISITOR_FILES = new Map\(\[[\s\S]*?\.\.\.\[([^\]]*)\]/.exec(server)[1];
    const served = [...block.matchAll(/'([^']+\.js)'/g)].map((match) => match[1]).map((name) => (name === 'visitor-entry.js' ? 'static-entry.js' : name));
    assert.deepEqual([...VISITOR_MODULES].sort(), served.sort());
  });

  it('refuses without confirmation, with a malformed capability, or into a non-empty folder', async () => {
    const { routes } = snapshot();
    await withVisitor(routes, async (origin) => {
      await assert.rejects(exportInto(origin, { confirmPublicMaterial: false }), /public or synthetic/);
      await assert.rejects(exportInto(origin, { token: 'rhv_short' }), /malformed/);
      const occupied = await tempDir();
      await exportStaticVisit({ origin, token: TOKEN, outDir: path.join(occupied, 'a'), confirmPublicMaterial: true });
      await assert.rejects(exportStaticVisit({ origin, token: TOKEN, outDir: path.join(occupied, 'a'), confirmPublicMaterial: true }), /not empty/);
    });
  });

  it('stops when the snapshot is unavailable, points outside the allowlist, or lacks a referenced file', async () => {
    await withVisitor(snapshot().routes, async (origin) => {
      await assert.rejects(exportInto(origin, { token: `rhv_${'B'.repeat(43)}` }), /HTTP 404/);
    });
    const unsafe = snapshot({ manifest: { contributorPhotos: [{ viewIds: [], label: 'x', asset: { viewId: '..', name: 'secret.json' } }] } });
    await withVisitor(unsafe.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /outside the asset allowlist/);
    });
    const badView = snapshot({ manifest: { views: [{ id: '../owner' }] } });
    await withVisitor(badView.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /unsafe identifier/);
    });
    const missing = snapshot({ drop: ['/api/visit/stories/{story}/audio.wav'] });
    await withVisitor(missing.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /HTTP 404/);
    });
  });

  it('refuses a photo that carries a metadata block', async () => {
    const { routes } = snapshot({ evidence: JPEG_WITH_EXIF });
    await withVisitor(routes, async (origin) => {
      await assert.rejects(exportInto(origin), /metadata block/);
    });
  });

  it('refuses a manifest that exposes an email address or the capability', async () => {
    const withEmail = snapshot({ manifest: { title: 'Contact someone@example.org' } });
    await withVisitor(withEmail.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /email address/);
    });
    const withToken = snapshot({ manifest: { title: TOKEN } });
    await withVisitor(withToken.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /visit capability/);
    });
  });
});
