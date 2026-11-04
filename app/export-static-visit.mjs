#!/usr/bin/env node
// Exports one saved visitor snapshot as a frozen static site: the visitor page,
// its exact modules, pinned Three.js files and the snapshot's own files. The
// result needs no server, model or account. It is a copy: revoking the link or
// withdrawing a source later does not change it. See STATIC-DEMO.md.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const THREE_DIR = path.join(APP_DIR, 'node_modules', 'three');

const TOKEN = /^rhv_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The same exact names the visitor server admits (SHARE_ASSETS in server.mjs).
const ASSET_NAMES = ['surface.json', 'texture.jpg', 'texture-1.jpg', 'texture-2.jpg', 'object.glb', 'outline.png'];
const EVIDENCE_NAME = /^[1-9][0-9]?\.jpg$/;
// Home-directory and temporary-folder prefixes that must never reach a public copy.
const LOCAL_PATHS = ['Users', 'private', 'home'].map((name) => `/${name}/`);
const MAX_FILE_BYTES = 64 * 1024 ** 2;
const MAX_TOTAL_BYTES = 256 * 1024 ** 2;

// Mirrors VISITOR_FILES in server.mjs, with this export's entry in place of
// visitor-entry.js. A test keeps the two lists equal.
export const VISITOR_MODULES = [
  'static-entry.js', 'visits.js', 'scene-viewer.js', 'photo-scene.js', 'composition-scene.js', 'composition-description.js',
  'story-player.js', 'playback.js', 'arrangement.js', 'object-outline-editor.js',
];
// Exported name -> [file inside node_modules/three, directory of the export relative to the root].
const VENDOR = [
  ['three.module.js', 'build/three.module.js'],
  ['three.core.js', 'build/three.core.js'],
  ['OrbitControls.js', 'examples/jsm/controls/OrbitControls.js'],
  ['loaders/GLTFLoader.js', 'examples/jsm/loaders/GLTFLoader.js'],
  ['utils/BufferGeometryUtils.js', 'examples/jsm/utils/BufferGeometryUtils.js'],
  ['utils/SkeletonUtils.js', 'examples/jsm/utils/SkeletonUtils.js'],
  ['THREE-LICENSE', 'LICENSE'],
];

export const NOTICE = {
  heading: 'Offline snapshot',
  text: 'This is a frozen copy of one saved visitor view, exported on {date}. It is not connected to the Rehere app. '
    + 'If the owner revokes the link, a contributor withdraws a memory, or a source’s permitted use changes, this copy does not change or stop. '
    + 'In the live app those actions stop the views that depend on them.',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error(message);
};
const escapeHtml = (text) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

// An unsafe name must never become a path or a request: exact allowlists only.
const safeAsset = (viewId, name) => (UUID.test(viewId) && ASSET_NAMES.includes(name)) || (viewId === 'evidence' && EVIDENCE_NAME.test(name));

function importsOf(source) {
  const found = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) found.push(match[2]);
  return found;
}

// Copies an allowlisted module with root-absolute vendor imports made relative,
// so the site works from any folder or sub-path. Anything else that would leave
// the allowlist stops the export.
function moduleText(name, source) {
  const text = source.replaceAll("'/vendor/", "'./vendor/");
  for (const specifier of importsOf(text)) {
    if (specifier.startsWith('./vendor/')) {
      if (!VENDOR.some(([target]) => specifier === `./vendor/${target}`)) fail(`${name} imports an unlisted vendor file: ${specifier}`);
    } else if (specifier.startsWith('./')) {
      if (!VISITOR_MODULES.includes(specifier.slice(2))) fail(`${name} imports a module outside the visitor allowlist: ${specifier}`);
    } else {
      fail(`${name} has an import that would not work from a static folder: ${specifier}`);
    }
  }
  return text;
}

function vendorText(target, source) {
  // Bare 'three' becomes a path relative to the exported file.
  const depth = target.split('/').length - 1;
  const text = source.replaceAll("from 'three';", `from '${'../'.repeat(depth) || './'}three.module.js';`);
  if (/from\s+['"]three['"]/.test(text)) fail(`${target} still imports the bare specifier 'three'`);
  return text;
}

const pageHtml = (template, date) => {
  const notice = `<aside class="offline-notice" role="note"><strong>${escapeHtml(NOTICE.heading)}.</strong> ${escapeHtml(NOTICE.text.replace('{date}', date))}</aside>`;
  const style = '<style>.offline-notice{margin:0;padding:.75rem 1rem;border-bottom:2px solid #8a6d00;background:#fff4c2;color:#2b2200;font:15px/1.4 system-ui,sans-serif}'
    + '@media (prefers-color-scheme:dark){.offline-notice{background:#3a2f00;color:#fff1b8;border-color:#d4aa00}}</style>';
  let html = template
    .replace('href="/style.css"', 'href="./style.css"')
    .replace('src="/visitor-entry.js"', 'src="./static-entry.js"')
    .replace('<title>Rehere · shared view</title>', `<title>Rehere · offline snapshot</title>\n  ${style}`)
    .replace('<body>', `<body>\n  ${notice}\n  <noscript><p class="offline-notice">This snapshot needs JavaScript to draw the scene.</p></noscript>`);
  if (!html.includes('./static-entry.js') || !html.includes('./style.css') || !html.includes('offline-notice')) fail('The visitor page template changed; update the exporter.');
  if (/(?:href|src)="\//.test(html)) fail('The exported page still has a root-absolute reference.');
  return html;
};

async function fetchBytes(fetchImpl, url, token, allowMissing) {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) fail(`A snapshot file could not be read (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) fail('A snapshot file is larger than the export limit.');
  return bytes;
}

// Fails closed: the output must hold no capability, origin, local path, API
// route in exported data or page, and no photo metadata block.
function scan(files, { token, origin }) {
  for (const [name, bytes] of files) {
    if (bytes.includes(token)) fail(`${name} contains the visit capability.`);
    if (bytes.includes(origin)) fail(`${name} contains the source origin.`);
    if (LOCAL_PATHS.some((prefix) => bytes.includes(prefix))) fail(`${name} contains a local path.`);
    if (name === 'index.html' || name.startsWith('data/')) {
      if (bytes.includes('/api/')) fail(`${name} references an API route.`);
      if (name.endsWith('.json') && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(bytes.toString('utf8'))) fail(`${name} contains an email address.`);
    }
    if (name.endsWith('.jpg') && bytes.subarray(0, 65536).includes(Buffer.from('Exif\0\0', 'latin1'))) fail(`${name} carries a photo metadata block.`);
  }
}

export async function exportStaticVisit({
  origin, token, outDir, confirmPublicMaterial = false, fetchImpl = fetch, now = () => new Date(), publicDir = PUBLIC_DIR, threeDir = THREE_DIR,
}) {
  if (!confirmPublicMaterial) fail('Confirm that the snapshot holds only public or synthetic material (--confirm-public-material).');
  if (typeof token !== 'string' || !TOKEN.test(token)) fail('The visit capability is missing or malformed.');
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) fail('The origin must be a plain http or https origin.');
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length > 0) fail('The output folder is not empty.');

  const files = new Map();
  let total = 0;
  const put = (name, bytes) => {
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('The export is larger than the total limit.');
    files.set(name, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  };
  const api = (suffix) => new URL(`/api/visit${suffix}`, base).href;

  const manifestBytes = await fetchBytes(fetchImpl, api(''), token, false);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('The snapshot manifest is not JSON.');
  }
  if (!manifest || typeof manifest.id !== 'string' || !Array.isArray(manifest.views) || manifest.views.length === 0) fail('The snapshot manifest is not a visitor view.');
  put('data/manifest.json', manifestBytes);

  for (const view of manifest.views) {
    if (!UUID.test(view.id)) fail('A view has an unsafe identifier.');
    for (const name of ASSET_NAMES) {
      const bytes = await fetchBytes(fetchImpl, api(`/assets/${view.id}/${name}`), token, true);
      if (bytes) put(`data/assets/${view.id}/${name}`, bytes);
    }
  }
  for (const photo of manifest.contributorPhotos ?? []) {
    const { viewId, name } = photo.asset ?? {};
    if (!safeAsset(viewId, name)) fail('A contributor photo points outside the asset allowlist.');
    const key = `data/assets/${viewId}/${name}`;
    if (!files.has(key)) put(key, await fetchBytes(fetchImpl, api(`/assets/${viewId}/${name}`), token, false));
  }
  for (const story of manifest.stories ?? []) {
    if (!UUID.test(story.id)) fail('A story has an unsafe identifier.');
    put(`data/stories/${story.id}/audio.wav`, await fetchBytes(fetchImpl, api(`/stories/${story.id}/audio.wav`), token, false));
  }
  for (const recording of manifest.contributorRecordings ?? []) {
    if (!UUID.test(recording.id)) fail('A recording has an unsafe identifier.');
    put(`data/recordings/${recording.id}/audio.wav`, await fetchBytes(fetchImpl, api(`/recordings/${recording.id}/audio.wav`), token, false));
  }

  const date = now().toISOString().slice(0, 10);
  put('index.html', pageHtml(await readFile(path.join(publicDir, 'visit.html'), 'utf8'), date));
  const style = await readFile(path.join(publicDir, 'style.css'), 'utf8');
  if (/url\(\s*['"]?\//.test(style)) fail('style.css has a root-absolute url().');
  put('style.css', style);
  for (const name of VISITOR_MODULES) put(name, moduleText(name, await readFile(path.join(publicDir, name), 'utf8')));
  for (const [target, source] of VENDOR) {
    const text = await readFile(path.join(threeDir, source), 'utf8');
    put(`vendor/${target}`, target === 'THREE-LICENSE' ? text : vendorText(target, text));
  }

  scan(files, { token, origin: base.origin });
  const listing = [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
  put('EXPORT.json', `${JSON.stringify({ exportedOn: date, snapshotId: manifest.id, files: listing }, null, 2)}\n`);
  for (const [name, bytes] of files) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return {
    outDir: root, snapshotId: manifest.id, title: manifest.title, synthetic: manifest.synthetic === true, files: files.size, bytes: total,
    contributorLabels: [...new Set((manifest.contributorPhotos ?? []).concat(manifest.contributorRecordings ?? []).map((item) => item.providerLabel).filter(Boolean))],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  try {
    const result = await exportStaticVisit({
      origin: option('--origin'), outDir: option('--out'), token: process.env.REHERE_VISIT_TOKEN, confirmPublicMaterial: args.includes('--confirm-public-material'),
    });
    console.log(`Exported "${result.title}" (${result.files} files, ${result.bytes} bytes) to ${result.outDir}`);
    console.log(`Marked synthetic: ${result.synthetic}. Contributor labels shown to visitors: ${result.contributorLabels.join(', ') || 'none'}.`);
    console.log('Review the folder before publishing it; this copy does not follow later revocation or withdrawal.');
  } catch (error) {
    console.error(`Export failed: ${error instanceof TypeError ? 'invalid --origin or --out.' : error.message}`);
    process.exitCode = 1;
  }
}
