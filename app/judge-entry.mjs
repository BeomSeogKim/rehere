// Support for the judge entry page that sits in front of an exported snapshot (see STATIC-DEMO.md): pinned public
// photographs, a lossless metadata strip, validation of the hand-written entry files, and a file-backed fetch that lets
// the exporter rebuild a site from an earlier, hash-verified export when the live snapshot no longer exists.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error(message);
};

// Removes Exif/XMP (APP1), Photoshop (APP13) and comment segments from a JPEG without touching the image data.
export function stripJpegMetadata(jpeg) {
  if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) fail('Not a JPEG file.');
  const out = [jpeg.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xda) break;
    const end = at + 2 + jpeg.readUInt16BE(at + 2);
    if (end > jpeg.length) fail('A JPEG segment runs past the end of the file.');
    if (![0xe1, 0xed, 0xfe].includes(marker)) out.push(jpeg.subarray(at, end));
    at = end;
  }
  out.push(jpeg.subarray(at));
  return Buffer.concat(out);
}

// Links the entry page may contain: exactly the sources it cites. Everything else is refused.
const ALLOWED_LINKS = [
  /^https:\/\/www\.loc\.gov\/pictures\/item\/az0459\.photos\.\d+p\/$/,
  /^https:\/\/www\.loc\.gov\/rr\/print\/res\/114_habs\.html$/,
  /^https:\/\/tile\.loc\.gov\/storage-services\/master\/pnp\/habshaer\/az\/az0400\/az0459\/data\/az0459cap\.pdf$/,
  /^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^"\s]+$/,
  /^https:\/\/www\.nps\.gov\/grca\/learn\/news\/dragon-bravo-fire-update-july-13-2025\.htm$/,
  /^https:\/\/github\.com\/BeomSeogKim\/rehere$/,
  /^https:\/\/github\.com\/BeomSeogKim\/rehere\/blob\/main\/LICENSE$/,
];

export function checkEntryHtml(html, photos) {
  if (/<style[\s>]|\sstyle=|<script[\s>]|\son[a-z]+=/i.test(html)) fail('The entry page must not carry inline styles, scripts or event handlers.');
  if (/(?:href|src)="\/(?!\/)/.test(html)) fail('The entry page has a root-absolute reference.');
  for (const [, url] of html.matchAll(/href="(https?:[^"]+)"/g)) {
    const plain = url.replace(/&amp;/g, '&');
    if (!ALLOWED_LINKS.some((rule) => rule.test(plain))) fail(`The entry page links to an address that is not an approved source: ${url}`);
  }
  for (const [, target] of html.matchAll(/(?:href|src)="(?!https?:|#|mailto:)([^"]+)"/g)) {
    const file = target.split(/[?#]/)[0];
    if (!['', 'snapshot.html', 'entry.css'].includes(file) && !photos.some((photo) => `entry/${photo.file}` === file)) fail(`The entry page points to an unlisted file: ${target}`);
  }
  for (const photo of photos) {
    if (!html.includes(`src="entry/${photo.file}"`)) fail(`The entry page does not show ${photo.file}.`);
    if (!html.includes(photo.caption)) fail(`The entry page lacks the verbatim caption of ${photo.hbs}.`);
    if (!html.includes(photo.locUrl) || !html.includes(photo.commonsUrl)) fail(`The entry page lacks the source links of ${photo.hbs}.`);
  }
  if ([...html.matchAll(/<img\b[^>]*>/g)].some(([tag]) => !/\salt="[^"]{12,}"/.test(tag))) fail('Every entry image needs descriptive alt text.');
  if (!/<html lang="en"/.test(html) || !/<title>[^<]{8,}<\/title>/.test(html) || !/name="viewport"/.test(html)) fail('The entry page needs lang, title and viewport.');
  return html;
}

// Loads the hand-written entry (index.html, entry.css, photos.json) and the prepared, hash-pinned photo files.
export async function loadEntry({ dir, photosDir }) {
  const config = JSON.parse(await readFile(path.join(dir, 'photos.json'), 'utf8'));
  const html = checkEntryHtml(await readFile(path.join(dir, 'index.html'), 'utf8'), config.photos);
  const files = new Map([['index.html', Buffer.from(html)], ['entry.css', await readFile(path.join(dir, 'entry.css'))]]);
  for (const photo of config.photos) {
    const bytes = await readFile(path.join(photosDir, photo.file));
    if (bytes.length !== photo.bytes || sha256(bytes) !== photo.sha256) fail(`${photo.file} differs from its pinned size or SHA-256.`);
    if (bytes.includes(Buffer.from('Exif\0\0', 'latin1'))) fail(`${photo.file} still carries a metadata block.`);
    files.set(`entry/${photo.file}`, bytes);
  }
  return { files, photos: config.photos };
}

// A fetch that answers the visitor routes from the data folder of an earlier export. Only files that export wrote are served.
export function fetchFromExport(dir) {
  const route = (pathname) => {
    if (pathname === '/api/visit') return 'data/manifest.json';
    const asset = /^\/api\/visit\/assets\/([0-9a-f-]{36}|evidence)\/([^/]+)$/.exec(pathname);
    if (asset) return `data/assets/${asset[1]}/${asset[2]}`;
    const audio = /^\/api\/visit\/(stories|recordings)\/([0-9a-f-]{36})\/audio\.wav$/.exec(pathname);
    return audio ? `data/${audio[1]}/${audio[2]}/audio.wav` : null;
  };
  return async (url) => {
    const target = route(new URL(url).pathname);
    try {
      if (!target) return new Response(null, { status: 404 });
      return new Response(await readFile(path.join(dir, target)), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

// An earlier export is trusted only after every file it lists matches its recorded hash and nothing else is in the folder.
export async function verifyExportFolder(dir) {
  const listed = JSON.parse(await readFile(path.join(dir, 'EXPORT.json'), 'utf8')).files;
  const found = [];
  const visit = async (base) => {
    for (const entry of await readdir(path.join(dir, base), { withFileTypes: true })) {
      const rel = path.posix.join(base, entry.name);
      if (entry.isDirectory()) await visit(rel);
      else found.push(rel);
    }
  };
  await visit('.');
  const names = found.map((name) => name.replace(/^\.\//, ''));
  const extra = names.filter((name) => name !== 'EXPORT.json' && !listed.some((item) => item.path === name));
  if (extra.length) fail(`The earlier export holds unlisted files: ${extra.join(', ')}`);
  for (const item of listed) {
    if (sha256(await readFile(path.join(dir, item.path))) !== item.sha256) fail(`The earlier export differs from its record: ${item.path}`);
  }
  return listed.length;
}
