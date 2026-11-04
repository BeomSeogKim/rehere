#!/usr/bin/env node
// Rebuilds the committed lodge-index.json and lodge-index.html from the private capture's derived instances and writes the
// overlay images into a NEW folder (they ship in the release asset, never in Git).
//   node lodge-index-build.mjs <derived.json> <NEW overlay folder>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLodge } from './lodge-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [derivedFile, overlaysDir] = process.argv.slice(2);
if (!derivedFile || !overlaysDir) {
  console.error('Usage: lodge-index-build.mjs <derived.json> <NEW overlay folder>');
  process.exit(2);
}
const derived = JSON.parse(await readFile(derivedFile, 'utf8'));
const { photos } = JSON.parse(await readFile(path.join(here, 'entry/photos.json'), 'utf8'));
const { data, overlayFiles, html } = buildLodge({ derived, photos });
await mkdir(overlaysDir, { recursive: false, mode: 0o755 });
for (const [name, bytes] of overlayFiles) await writeFile(path.join(overlaysDir, name), bytes, { flag: 'wx' });
await writeFile(path.join(here, 'entry/lodge-index.json'), `${JSON.stringify(data, null, 1)}\n`);
await writeFile(path.join(here, 'entry/lodge-index.html'), html);
console.log(`Wrote lodge-index.json, lodge-index.html and ${overlayFiles.size} overlays to ${overlaysDir}`);
