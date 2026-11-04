#!/usr/bin/env node
// Exports one saved visitor snapshot as a frozen static site: the visitor page,
// its exact modules, pinned Three.js files and the snapshot's own files. The
// result needs no application server, model or account, only a static file
// server. It is a copy: revoking the link or withdrawing a source later does
// not change it. See STATIC-DEMO.md.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkEntryAgainstSnapshot, fetchFromExport, loadEntry, verifyExportFolder } from './judge-entry.mjs';
import { isComposition } from './public/composition-scene.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const ROOT_DIR = path.join(APP_DIR, '..');
const THREE_DIR = path.join(APP_DIR, 'node_modules', 'three');

const TOKEN = /^rhv_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The same exact names the visitor server admits (SHARE_ASSETS in server.mjs).
const ASSET_NAMES = ['surface.json', 'texture.jpg', 'texture-1.jpg', 'texture-2.jpg', 'object.glb', 'outline.png'];
const EVIDENCE_NAME = /^[1-9][0-9]?\.jpg$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FULL_OBJECT = 'source-photo-full-object-v1';
// Home-directory and temporary-folder prefixes that must never reach a public copy.
const LOCAL_PATHS = ['Users', 'private', 'home'].map((name) => `/${name}/`);
const LIMITS = { file: 64 * 1024 ** 2, total: 256 * 1024 ** 2 };

// Mirrors VISITOR_FILES in server.mjs, with this export's entry in place of
// visitor-entry.js. A test keeps the two lists equal.
export const VISITOR_MODULES = [
  'static-entry.js', 'version-link.js', 'visits.js', 'scene-viewer.js', 'photo-scene.js', 'composition-scene.js', 'composition-description.js',
  'story-player.js', 'playback.js', 'arrangement.js', 'object-outline-editor.js',
];
// Project notices shipped with every export: the exported JavaScript is distributed under the project license.
const NOTICE_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'];
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

// The visitor page ends with a live-visit sentence about closing access. It is
// false for a copy, so the exported module says what actually removes a copy.
const LIVE_DEVICE_NOTE = 'Closing access stops this page from showing the scene. Copies already saved on a device cannot be removed from here.';
export const STATIC_DEVICE_NOTE = 'This frozen copy keeps showing the scene until its files are removed from the file server. Copies already saved on a device cannot be removed from here.';

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

// A credit line is reviewed text supplied by a person, shown under the page:
// plain ASCII, https links only, never markup.
const CREDIT_LIMIT = 1500;
function creditHtml(credit) {
  if (typeof credit !== 'string' || credit.trim() === '' || credit.length > CREDIT_LIMIT || !/^[\x20-\x7e\n]+$/.test(credit)) fail('The credit must be plain ASCII text of at most 1500 characters.');
  if (/\b(?!https:\/\/)[a-z][a-z0-9+.-]*:\/\//i.test(credit)) fail('The credit may link only to https addresses.');
  const paragraphs = credit.trim().split(/\n+/).map((line) => escapeHtml(line).replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}" rel="noreferrer noopener">${url}</a>`));
  return `<footer class="source-credit">${paragraphs.map((line) => `<p>${line}</p>`).join('')}</footer>`;
}

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
  let text = source.replaceAll("'/vendor/", "'./vendor/");
  if (name === 'visits.js') {
    if (!source.includes(LIVE_DEVICE_NOTE)) fail('The visitor page text changed; update the exporter.');
    text = text.replace(LIVE_DEVICE_NOTE, STATIC_DEVICE_NOTE);
  }
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

// Rules for the offline notice and the credit footer, shipped as a file next to
// the page instead of an inline <style>.
export const OFFLINE_CSS = `.offline-notice { margin: 0; padding: .75rem 1rem; border-bottom: 2px solid #8a6d00; background: #fff4c2; color: #2b2200; font: 15px/1.4 system-ui, sans-serif; }
.offline-notice a { color: inherit; font-weight: 700; }
.source-credit { max-width: 60rem; margin: 1.5rem auto; padding: 0 1rem; font: 14px/1.5 system-ui, sans-serif; opacity: .85; }
.source-credit p { margin: .4rem 0; }
.source-credit a { color: inherit; overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) { .offline-notice { background: #3a2f00; color: #fff1b8; border-color: #d4aa00; } }
`;

const pageHtml = (template, date, credit, backLink = false) => {
  const back = backLink ? ' <a href="./">Back to the entry page</a>' : '';
  const notice = `<aside class="offline-notice" role="note"><strong>${escapeHtml(NOTICE.heading)}.</strong> ${escapeHtml(NOTICE.text.replace('{date}', date))}${back}</aside>`;
  let html = template
    .replace('href="/style.css"', 'href="./style.css">\n  <link rel="stylesheet" href="./offline.css"')
    .replace('src="/visitor-entry.js"', 'src="./static-entry.js"')
    .replace('<title>Rehere · shared view</title>', '<title>Rehere · offline snapshot</title>')
    .replace('<body>', `<body>\n  ${notice}\n  <noscript><p class="offline-notice">This snapshot needs JavaScript to draw the scene.</p></noscript>`);
  if (credit !== null) {
    if (!html.includes('</body>')) fail('The visitor page template changed; update the exporter.');
    html = html.replace('</body>', `  ${creditHtml(credit)}\n</body>`);
  }
  if (!html.includes('./static-entry.js') || !html.includes('./style.css') || !html.includes('offline-notice')) fail('The visitor page template changed; update the exporter.');
  if (/(?:href|src)="\//.test(html)) fail('The exported page still has a root-absolute reference.');
  // Styles live in offline.css so a host policy without inline styles still renders the page.
  if (/<style[\s>]|\sstyle=/i.test(html)) fail('The exported page must not carry inline styles.');
  return html;
};

// Reads at most `limit` bytes; a longer body is cancelled, not buffered.
async function readBody(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    fail('A snapshot file is larger than the export limit.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) fail('A snapshot file is larger than the export limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Every file the viewer reads is required: a missing one means the copy could
// not be drawn, so there is no optional fetch.
async function fetchBytes(fetchImpl, url, token, limit) {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    fail(`A snapshot file could not be read (HTTP ${response.status}).`);
  }
  return readBody(response, limit);
}

// The manifest is untrusted text that the page renders. Paths that point out of
// the folder, or links to this machine, stop the export; other links are
// returned so a person can review them.
function inspectManifest(value, location = 'manifest', links = new Set()) {
  if (typeof value === 'string') {
    if (/^(?:\/|~\/|[A-Za-z]:[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) fail(`${location} holds a file path.`);
    for (const match of value.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>]*/gi)) {
      const scheme = match[1].toLowerCase();
      let host = '';
      try {
        host = new URL(match[0]).hostname;
      } catch {
        fail(`${location} holds a malformed link.`);
      }
      if (!['http', 'https'].includes(scheme) || /^(?:localhost|\[?::1\]?|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(?:1[6-9]|2\d|3[01])\..*|.*\.local)$/i.test(host)) fail(`${location} holds a link to a local or non-web address.`);
      links.add(match[0]);
    }
    if (/^(?:javascript|data|file|blob):/i.test(value.trim())) fail(`${location} holds a script or data link.`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => inspectManifest(item, `${location}[${index}]`, links));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) inspectManifest(item, `${location}.${key}`, links);
  }
  return links;
}

// The full-object references the viewer itself requires (fullObjectOf in visits.js).
function pinnedObject(manifest) {
  if (!manifest.views.some((view) => view.representation === FULL_OBJECT)) return null;
  const ids = new Set(manifest.views.map((view) => view.id));
  const valid = (asset, name) => asset?.name === name && ids.has(asset.viewId) && Number.isInteger(asset.size) && asset.size > 0;
  const start = manifest.views.find((view) => view.id === manifest.startViewId)?.fullObject;
  if (!start || !SHA256.test(start.sha256 ?? '') || !SHA256.test(start.outlineSha256 ?? '') || !valid(start.asset, 'object.glb') || !valid(start.mask, 'outline.png')
      || manifest.views.some((view) => view.representation !== FULL_OBJECT)) fail('The full-object references in the manifest are incomplete.');
  return start;
}

// Fails closed: the output must hold no capability, origin, local path, API
// route in exported data or page, and no photo metadata block.
function scan(files, { token, origin }) {
  for (const [name, bytes] of files) {
    if (bytes.includes(token)) fail(`${name} contains the visit capability.`);
    if (bytes.includes(origin)) fail(`${name} contains the source origin.`);
    if (LOCAL_PATHS.some((prefix) => bytes.includes(prefix))) fail(`${name} contains a local path.`);
    if (name === 'index.html' || name === 'snapshot.html' || name.startsWith('data/')) {
      if (bytes.includes('/api/')) fail(`${name} references an API route.`);
      if (name.endsWith('.json') && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(bytes.toString('utf8'))) fail(`${name} contains an email address.`);
    }
    if (name.endsWith('.jpg') && bytes.subarray(0, 65536).includes(Buffer.from('Exif\0\0', 'latin1'))) fail(`${name} carries a photo metadata block.`);
  }
}

export async function exportStaticVisit({
  origin, token, outDir, confirmPublicMaterial = false, credit = null, entry = null, limits = LIMITS, fetchImpl = fetch, now = () => new Date(), publicDir = PUBLIC_DIR, threeDir = THREE_DIR, rootDir = ROOT_DIR,
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
    if (total > limits.total) fail('The export is larger than the total limit.');
    files.set(name, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  };
  const api = (suffix) => new URL(`/api/visit${suffix}`, base).href;

  const get = (suffix) => fetchBytes(fetchImpl, api(suffix), token, Math.max(0, Math.min(limits.file, limits.total - total)));
  const manifestBytes = await get('');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('The snapshot manifest is not JSON.');
  }
  if (!manifest || typeof manifest.id !== 'string' || !Array.isArray(manifest.views) || manifest.views.length === 0) fail('The snapshot manifest is not a visitor view.');
  if (!manifest.views.every((view) => UUID.test(view?.id))) fail('A view has an unsafe identifier.');
  const externalLinks = inspectManifest(manifest);
  put('data/manifest.json', manifestBytes);

  // Exactly what the visitor page reads to draw the start view: its surface and
  // texture(s), and the pinned object and outline of a full-object scene.
  const start = manifest.views.find((view) => view.id === manifest.startViewId);
  if (!start) fail('The start view is not in the snapshot.');
  const asset = async (viewId, name) => {
    const key = `data/assets/${viewId}/${name}`;
    if (!files.has(key)) put(key, await get(`/assets/${viewId}/${name}`));
    return files.get(key);
  };
  let surface;
  try {
    surface = JSON.parse((await asset(start.id, 'surface.json')).toString('utf8'));
  } catch (error) {
    fail(error.message.startsWith('A snapshot') ? error.message : 'The start view surface is not JSON.');
  }
  if (isComposition(manifest) !== isComposition(surface)) fail('The start view surface does not match the snapshot representation.');
  const pinned = pinnedObject(manifest);
  if (pinned && isComposition(manifest)) fail('A composition cannot also hold a full object.');
  for (const name of isComposition(manifest) ? ['texture-1.jpg', 'texture-2.jpg'] : ['texture.jpg']) await asset(start.id, name);
  if (pinned) {
    const object = await asset(pinned.asset.viewId, 'object.glb');
    const outline = await asset(pinned.mask.viewId, 'outline.png');
    if (object.length !== pinned.asset.size || sha256(object) !== pinned.sha256) fail('The pinned object does not match the manifest.');
    if (outline.length !== pinned.mask.size || sha256(outline) !== pinned.outlineSha256) fail('The pinned outline does not match the manifest.');
  }
  for (const photo of manifest.contributorPhotos ?? []) {
    const { viewId, name } = photo.asset ?? {};
    if (!safeAsset(viewId, name)) fail('A contributor photo points outside the asset allowlist.');
    await asset(viewId, name);
  }
  for (const story of manifest.stories ?? []) {
    if (!UUID.test(story.id)) fail('A story has an unsafe identifier.');
    put(`data/stories/${story.id}/audio.wav`, await get(`/stories/${story.id}/audio.wav`));
  }
  for (const recording of manifest.contributorRecordings ?? []) {
    if (!UUID.test(recording.id)) fail('A recording has an unsafe identifier.');
    put(`data/recordings/${recording.id}/audio.wav`, await get(`/recordings/${recording.id}/audio.wav`));
  }
  // A link revoked or a snapshot changed while files were read must not yield a mixed copy.
  const again = await get('').catch(() => null);
  if (!again?.equals(manifestBytes)) fail('The snapshot changed or became unavailable during the export.');

  const date = now().toISOString().slice(0, 10);
  // With an entry, the snapshot page moves to snapshot.html and the hand-written entry page becomes the site's front door.
  const page = pageHtml(await readFile(path.join(publicDir, 'visit.html'), 'utf8'), date, credit, entry !== null);
  if (entry) {
    put('snapshot.html', page);
    const loaded = await loadEntry(entry);
    checkEntryAgainstSnapshot(loaded, manifest);
    for (const [name, bytes] of loaded.files) put(name, bytes);
  } else put('index.html', page);
  const style = await readFile(path.join(publicDir, 'style.css'), 'utf8');
  if (/url\(\s*['"]?\//.test(style)) fail('style.css has a root-absolute url().');
  put('style.css', style);
  put('offline.css', OFFLINE_CSS);
  for (const name of NOTICE_FILES) put(name, await readFile(path.join(rootDir, name)));
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
    credited: credit !== null, entry: entry !== null, externalLinks: [...externalLinks], contributorLabels: [...new Set((manifest.contributorPhotos ?? []).concat(manifest.contributorRecordings ?? []).map((item) => item.providerLabel).filter(Boolean))],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  try {
    const creditFile = option('--credit-file');
    const fromExport = option('--from-export');
    const entryDir = option('--entry');
    if (fromExport) await verifyExportFolder(fromExport);
    const result = await exportStaticVisit({
      origin: fromExport ? 'http://snapshot.invalid' : option('--origin'), outDir: option('--out'),
      token: fromExport ? `rhv_${randomBytes(32).toString('base64url')}` : process.env.REHERE_VISIT_TOKEN, confirmPublicMaterial: args.includes('--confirm-public-material'),
      credit: creditFile ? await readFile(creditFile, 'utf8') : null, fetchImpl: fromExport ? fetchFromExport(fromExport) : fetch,
      entry: entryDir ? { dir: entryDir, photosDir: option('--entry-photos') } : null,
    });
    console.log(`Exported "${result.title}" (${result.files} files, ${result.bytes} bytes) to ${result.outDir}`);
    console.log(`Marked synthetic: ${result.synthetic}. Contributor labels shown to visitors: ${result.contributorLabels.join(', ') || 'none'}.`);
    if (result.externalLinks.length) console.log(`Links inside the snapshot text (review them): ${result.externalLinks.join(' ')}`);
    if (!result.credited) console.log('No --credit-file was given: the page shows only the photo credit recorded in the snapshot.');
    console.log('Review the folder before publishing it; this copy does not follow later revocation or withdrawal.');
  } catch (error) {
    console.error(`Export failed: ${error instanceof TypeError ? 'invalid --origin or --out.' : error.message}`);
    process.exitCode = 1;
  }
}
