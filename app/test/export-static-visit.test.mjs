import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pcmWav } from '../audio-derivative.mjs';
import { exportStaticVisit, STATIC_DEVICE_NOTE, VISITOR_MODULES } from '../export-static-visit.mjs';

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
  for (const [route, body] of Object.entries(overrides.routes ?? {})) routes.set(route.replace('{view}', viewId), body);
  for (const name of overrides.drop ?? []) routes.delete(name.replace('{story}', storyId).replace('{view}', viewId));
  return { manifest, routes, viewId, storyId, recordingId };
}

async function withVisitor(routes, run, { onManifest } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    let body = req.headers.authorization === `Bearer ${TOKEN}` ? routes.get(req.url) : undefined;
    if (req.url === '/api/visit' && onManifest) body = onManifest(body, requests.filter((item) => item.url === '/api/visit').length);
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
        'EXPORT.json', 'index.html', 'style.css', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md',
        ...VISITOR_MODULES,
        'data/manifest.json',
        `data/assets/${viewId}/surface.json`, `data/assets/${viewId}/texture.jpg`, 'data/assets/evidence/1.jpg',
        `data/stories/${storyId}/audio.wav`, `data/recordings/${recordingId}/audio.wav`,
        'vendor/OrbitControls.js', 'vendor/THREE-LICENSE', 'vendor/loaders/GLTFLoader.js', 'vendor/three.core.js', 'vendor/three.module.js',
        'vendor/utils/BufferGeometryUtils.js', 'vendor/utils/SkeletonUtils.js',
      ].sort());
      assert.deepEqual(JSON.parse(await readFile(path.join(result.outDir, 'data/manifest.json'), 'utf8')), manifest);
      const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
      for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
        assert.deepEqual(await readFile(path.join(result.outDir, name)), await readFile(path.join(repoRoot, name)), name);
      }
      assert.match(await readFile(path.join(result.outDir, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
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
      const visits = await readFile(path.join(outDir, 'visits.js'), 'utf8');
      assert.ok(visits.includes(STATIC_DEVICE_NOTE));
      assert.ok(!visits.includes('Closing access stops this page'));
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
      await assert.rejects(exportInto(origin), /file path/);
    });
    const outside = snapshot({ manifest: { contributorPhotos: [{ viewIds: [], label: 'x', asset: { viewId: randomUUID(), name: 'secret.json.bak' } }] } });
    await withVisitor(outside.routes, async (origin) => {
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

  it('rejects a view whose required geometry or texture is missing', async () => {
    for (const missing of ['/api/visit/assets/{view}/surface.json', '/api/visit/assets/{view}/texture.jpg']) {
      const { routes } = snapshot({ drop: [missing] });
      await withVisitor(routes, async (origin) => {
        await assert.rejects(exportInto(origin), /HTTP 404/, missing);
      });
    }
  });

  it('requires both textures of a two-photo composition and a matching surface', async () => {
    const composition = { representation: 'two-photo-composition-v1' };
    const routes = { '/api/visit/assets/{view}/surface.json': Buffer.from(JSON.stringify(composition)), '/api/visit/assets/{view}/texture-1.jpg': JPEG, '/api/visit/assets/{view}/texture-2.jpg': JPEG };
    const whole = snapshot({ manifest: composition, routes });
    await withVisitor(whole.routes, async (origin) => {
      const { outDir } = await exportInto(origin);
      assert.ok((await walk(outDir)).includes(path.join('data', 'assets', whole.viewId, 'texture-2.jpg')));
    });
    const partial = snapshot({ manifest: composition, routes, drop: ['/api/visit/assets/{view}/texture-2.jpg'] });
    await withVisitor(partial.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /HTTP 404/);
    });
    const mismatch = snapshot({ manifest: composition });
    await withVisitor(mismatch.routes, async (origin) => {
      await assert.rejects(exportInto(origin), /does not match the snapshot representation/);
    });
  });

  it('requires the pinned object and outline of a full-object scene, with matching hashes', async () => {
    const glb = Buffer.from('glTF synthetic object');
    const outline = Buffer.from('synthetic outline');
    const build = (overrides = {}) => {
      const viewId = randomUUID();
      const fullObject = {
        sha256: createHash('sha256').update(glb).digest('hex'), outlineSha256: createHash('sha256').update(outline).digest('hex'),
        asset: { name: 'object.glb', viewId, size: glb.length }, mask: { name: 'outline.png', viewId, size: outline.length }, ...overrides,
      };
      const manifest = { views: [{ id: viewId, representation: 'source-photo-full-object-v1', fullObject }], startViewId: viewId };
      return { viewId, ...snapshot({ manifest, routes: { [`/api/visit/assets/${viewId}/object.glb`]: glb, [`/api/visit/assets/${viewId}/outline.png`]: outline } }) };
    };
    // The start view ID is generated inside snapshot(); build routes after it is known.
    const whole = build();
    whole.routes.set('/api/visit', Buffer.from(JSON.stringify({ ...whole.manifest, startViewId: whole.manifest.views[0].id })));
    for (const name of ['surface.json', 'texture.jpg']) whole.routes.set(`/api/visit/assets/${whole.manifest.views[0].id}/${name}`, name === 'surface.json' ? Buffer.from('{}') : JPEG);
    await withVisitor(whole.routes, async (origin) => {
      const { outDir } = await exportInto(origin);
      const names = (await walk(outDir)).map((file) => path.basename(file));
      assert.ok(names.includes('object.glb') && names.includes('outline.png'));
    });
    const missing = new Map(whole.routes);
    missing.delete(`/api/visit/assets/${whole.manifest.views[0].id}/object.glb`);
    await withVisitor(missing, async (origin) => {
      await assert.rejects(exportInto(origin), /HTTP 404/);
    });
    const tampered = new Map(whole.routes);
    tampered.set(`/api/visit/assets/${whole.manifest.views[0].id}/outline.png`, Buffer.from('other outline!!!!'));
    await withVisitor(tampered, async (origin) => {
      await assert.rejects(exportInto(origin), /does not match the manifest/);
    });
  });

  it('cancels a body that exceeds the limit instead of buffering it', async () => {
    let produced = 0;
    let cancelled = false;
    const endless = () => new Response(new ReadableStream({
      pull(controller) {
        produced += 1024;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    }));
    await assert.rejects(exportStaticVisit({
      origin: 'http://127.0.0.1:9', token: TOKEN, outDir: await tempDir(), confirmPublicMaterial: true, limits: { file: 4096, total: 8192 }, fetchImpl: async () => endless(),
    }), /larger than the export limit/);
    assert.ok(cancelled);
    assert.ok(produced <= 4096 + 4096, `read ${produced} bytes`);
    const { routes } = snapshot();
    await withVisitor(routes, async (origin) => {
      await assert.rejects(exportInto(origin, { limits: { file: 16, total: 1_000_000 } }), /larger than the export limit/);
    });
  });

  it('rejects file paths and local links in the manifest and reports other links for review', async () => {
    for (const title of ['../../owner/secret', '/etc/hosts', 'See http://127.0.0.1:4317/owner', 'file:///tmp/x']) {
      const { routes } = snapshot({ manifest: { title } });
      await withVisitor(routes, async (origin) => {
        await assert.rejects(exportInto(origin), /holds a (?:file path|link)/, title);
      });
    }
    const { routes } = snapshot({ manifest: { title: 'Source https://www.loc.gov/pictures/item/az0459.photos.321989p/' } });
    await withVisitor(routes, async (origin) => {
      const result = await exportInto(origin);
      assert.deepEqual(result.externalLinks, ['https://www.loc.gov/pictures/item/az0459.photos.321989p/']);
    });
  });

  it('rejects a snapshot that changes or becomes unavailable while it is read', async () => {
    const { routes } = snapshot();
    await withVisitor(routes, async (origin) => {
      await assert.rejects(exportInto(origin), /changed or became unavailable/);
    }, { onManifest: (body, count) => (count === 1 ? body : undefined) });
  });

  it('keeps the required file list in step with the visitor page that reads it', async () => {
    const visits = await readFile(fileURLToPath(new URL('../public/visits.js', import.meta.url)), 'utf8');
    for (const literal of ["'surface.json'", "['texture-1.jpg', 'texture-2.jpg']", "['texture.jpg']", "'object.glb'", "'outline.png'", "'source-photo-full-object-v1'"]) {
      assert.ok(visits.includes(literal), literal);
    }
  });

  it('shows a reviewed credit line as escaped text with https links only', async () => {
    const { routes } = snapshot();
    await withVisitor(routes, async (origin) => {
      const credit = 'Photograph: "Test" <b>x</b>.\nSource: https://example.org/item?a=1&b=2';
      const { outDir, credited } = await exportInto(origin, { credit });
      assert.equal(credited, true);
      const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
      assert.match(html, /<footer class="source-credit"><p>Photograph: &quot;Test&quot; &lt;b&gt;x&lt;\/b&gt;\.<\/p><p>Source: <a href="https:\/\/example\.org\/item\?a=1&amp;b=2" rel="noreferrer noopener">/);
      assert.doesNotMatch(html, /<b>x<\/b>/);
      const plain = await exportInto(origin);
      assert.equal(plain.credited, false);
      assert.doesNotMatch(await readFile(path.join(plain.outDir, 'index.html'), 'utf8'), /<footer/);
    });
    await withVisitor(snapshot().routes, async (origin) => {
      for (const credit of ['see http://example.org', 'javascript://x', 'caf\u00e9', '', 'x'.repeat(1501)]) {
        await assert.rejects(exportInto(origin, { credit }), /credit/, credit.slice(0, 20));
      }
    });
  });
});
