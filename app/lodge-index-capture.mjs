#!/usr/bin/env node
// Grant-gated capture of the SAM 3.1 lodge index through the production live segmenter. One concept noun per request, an
// attempt file created (O_EXCL) before every dispatch, no retries, and the batch stops at the first failed or unclear call.
// Raw provider output goes only to a private recordings file in the private folder, never to Git.
//   MODEL_API_KEY=<key in the environment> node lodge-index-capture.mjs <pinned photos dir> <NEW private dir>
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BudgetLedger } from './meta-model.mjs';
import { createLiveSegmenter, IMAGE_USD, parseInstances, segmentationBody, segmentationDigest, segmentationRecorder } from './meta-segmentation.mjs';
import { LODGE_BATCH, LODGE_LIMITS, LODGE_NOUNS, LODGE_PHOTO_FILES, nounSlug } from './lodge-index.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function writeExclusive(file, value) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  writeSync(fd, JSON.stringify(value, null, 1));
  fsyncSync(fd);
  closeSync(fd);
}

// photos: [{ file, hbs, sha256, width, height, bytes }]. Returns one result per attempted request; the last one explains a stop.
export async function runCapture({ segmenter, photos, nouns = LODGE_NOUNS, dir, headers = { current: null } }) {
  const results = [];
  for (const photo of photos) {
    for (const [index, noun] of nouns.entries()) {
      const label = `${photo.hbs} / ${noun}`;
      if (sha256(photo.bytes) !== photo.sha256) {
        results.push({ photo: photo.hbs, noun, status: 'not sent: photo bytes differ from the pinned SHA-256' });
        return results;
      }
      const requestDigest = segmentationDigest(segmentationBody({ prompt: noun, imageBytes: photo.bytes, format: 'jpeg' }));
      const attempt = { batch: LODGE_BATCH, photo: photo.hbs, photoSha256: photo.sha256, noun, index: index + 1, requestDigest, status: 'dispatching', createdAt: new Date().toISOString() };
      const file = path.join(dir, `attempt-${photo.file.replace(/\.jpg$/, '')}-${nounSlug(noun)}.json`);
      writeExclusive(file, attempt);
      headers.current = null;
      let outcome;
      try {
        const result = await segmenter.segment({ prompt: noun, imageBytes: photo.bytes, format: 'jpeg' });
        const instances = parseInstances(result.outputText, { width: photo.width, height: photo.height })
          .map(({ id, box, confidence }) => ({ id, box, confidence }));
        outcome = {
          status: 'returned', responseId: result.responseId, imagesProcessed: result.imagesProcessed, latencyMs: result.latencyMs,
          recordedAt: result.recordedAt, digestMatches: result.requestDigest === requestDigest, instances,
        };
      } catch (error) {
        outcome = { status: 'uncertain-or-failed', error: `${error.name}: ${error.message}` };
      }
      const finished = { ...attempt, ...outcome, httpHeaders: headers.current, finishedAt: new Date().toISOString() };
      await writeFile(file, JSON.stringify(finished, null, 1), { mode: 0o600 });
      results.push({ photo: photo.hbs, noun, requestDigest, ...outcome, requestId: headers.current?.['x-request-id'] ?? null, label });
      if (outcome.status !== 'returned' || outcome.imagesProcessed !== 1 || !outcome.digestMatches) return results;
    }
  }
  return results;
}

async function loadPhotos(photosDir) {
  const config = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'entry/photos.json'), 'utf8'));
  const photos = [];
  for (const name of LODGE_PHOTO_FILES) {
    const photo = config.photos.find((item) => item.file === name);
    if (!photo) throw new Error(`${name} is not in entry/photos.json.`);
    const bytes = await readFile(path.join(photosDir, name));
    if (bytes.length !== photo.bytes || sha256(bytes) !== photo.sha256) throw new Error(`${name} differs from its pinned size or SHA-256; nothing was sent.`);
    photos.push({ ...photo, bytes });
  }
  return photos;
}

async function main() {
  const [photosDir, outDir] = process.argv.slice(2);
  if (!photosDir || !outDir) throw new Error('Usage: lodge-index-capture.mjs <pinned photos dir> <NEW private dir>');
  if (!process.env.MODEL_API_KEY) throw new Error('STOPPED: MODEL_API_KEY missing; nothing was sent.');
  const photos = await loadPhotos(photosDir);
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  const headers = { current: null };
  const fetchOnce = async (url, init) => {
    const response = await fetch(url, init);
    headers.current = { httpStatus: response.status, 'x-request-id': response.headers.get('x-request-id'), date: response.headers.get('date') };
    return response;
  };
  const ledger = new BudgetLedger({ file: path.join(outDir, 'ledger.json'), limits: LODGE_LIMITS });
  const segmenter = createLiveSegmenter({ apiKey: process.env.MODEL_API_KEY, ledger, fetch: fetchOnce, recorder: segmentationRecorder(path.join(outDir, 'recordings.json')) });
  const results = await runCapture({ segmenter, photos, dir: outDir, headers });
  const summary = { batch: LODGE_BATCH, imageUsdEstimate: IMAGE_USD, requests: results.length, results, ledger: JSON.parse(await readFile(path.join(outDir, 'ledger.json'), 'utf8')) };
  await writeFile(path.join(outDir, 'capture-summary.json'), JSON.stringify(summary, null, 1), { mode: 0o600 });
  for (const item of results) console.log(`${item.photo} | ${item.noun} | ${item.status} | ${item.responseId ?? '-'} | instances=${item.instances?.length ?? '-'}${item.error ? ` | ${item.error}` : ''}`);
  if (results.some((item) => item.status !== 'returned')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Capture stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
