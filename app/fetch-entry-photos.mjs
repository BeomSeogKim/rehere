#!/usr/bin/env node
// Fetches the three pinned public photographs of the judge entry from Wikimedia Commons (JPEG derivatives of the Library of
// Congress HABS scans), checks each against its recorded SHA-256, removes the Exif block losslessly, checks the result against
// its pinned SHA-256 and writes it to a NEW folder. Nothing is written when any check fails. The photographs are never
// committed: the repository guard refuses binary files, and the site ships as a release asset.
//   node fetch-entry-photos.mjs <new folder>
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJpegMetadata } from './judge-entry.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node fetch-entry-photos.mjs <new folder>');
  process.exit(2);
}
try {
  const { photos } = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'entry/photos.json'), 'utf8'));
  const results = [];
  for (const photo of photos) {
    const response = await fetch(photo.sourceUrl, { headers: { 'user-agent': 'RehereJudgeEntryBuild/1.0 (https://github.com/BeomSeogKim/rehere; pinned public photographs)' }, redirect: 'error' });
    if (!response.ok) throw new Error(`${photo.hbs}: the source answered HTTP ${response.status}.`);
    const source = Buffer.from(await response.arrayBuffer());
    if (source.length !== photo.sourceBytes || sha256(source) !== photo.sourceSha256) throw new Error(`${photo.hbs}: the source differs from the pinned file; nothing was written.`);
    const clean = stripJpegMetadata(source);
    if (clean.length !== photo.bytes || sha256(clean) !== photo.sha256) throw new Error(`${photo.hbs}: the cleaned file differs from its pinned hash; nothing was written.`);
    results.push([photo.file, clean]);
  }
  await mkdir(outDir, { recursive: false, mode: 0o755 });
  for (const [name, bytes] of results) await writeFile(path.join(outDir, name), bytes, { flag: 'wx' });
  console.log(`Wrote ${results.length} photographs to ${outDir}`);
} catch (error) {
  console.error(`Fetch failed: ${error.message}`);
  process.exitCode = 1;
}
