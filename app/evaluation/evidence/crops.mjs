// Renders the cropped regions the model pointed at for the failed checks of a
// results file, so EVALUATION.md can show what each wrong answer looked at.
// macOS only (uses sips). Offline: no model, network or app server.
// Usage: crops.mjs --results <results.json> --photos <dir> --out <dir>
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadDataset } from './evaluate.mjs';

const run = promisify(execFile);

// Pixel rectangle of a fractional crop [x0, y0, x1, y1] inside a width x height photo.
export function cropPixels(width, height, crop) {
  const [x0, y0, x1, y1] = crop;
  const left = Math.max(0, Math.floor(x0 * width));
  const top = Math.max(0, Math.floor(y0 * height));
  return { left, top, width: Math.max(1, Math.min(width, Math.ceil(x1 * width)) - left), height: Math.max(1, Math.min(height, Math.ceil(y1 * height)) - top) };
}

async function size(file) {
  const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return [Number(/pixelWidth: (\d+)/.exec(stdout)[1]), Number(/pixelHeight: (\d+)/.exec(stdout)[1])];
}

export async function renderCrops({ results, dataset, photosDir, outDir }) {
  await mkdir(outDir, { recursive: true });
  const files = new Map(dataset.photos.map((photo) => [photo.id, photo.file]));
  const written = [];
  for (const failure of Object.values(results.summary).flatMap((item) => item.failures)) {
    for (const [index, finding] of (failure.findings ?? []).entries()) {
      if (!finding.photo || !Array.isArray(finding.crop)) continue;
      const source = path.join(photosDir, files.get(finding.photo));
      const [width, height] = await size(source);
      const box = cropPixels(width, height, finding.crop);
      const out = path.join(outDir, `${failure.claimId}-${failure.effort}-run${failure.run}-${index + 1}-${finding.verdict}.jpg`);
      await run('sips', ['-c', String(box.height), String(box.width), '--cropOffset', String(box.top), String(box.left), source, '--out', out]);
      written.push(out);
    }
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries([0, 2, 4].map((i) => [process.argv[2 + i], process.argv[3 + i]]));
  if (!args['--results'] || !args['--photos'] || !args['--out']) throw new Error('Usage: crops.mjs --results <results.json> --photos <dir> --out <dir>');
  const written = await renderCrops({ results: JSON.parse(await readFile(args['--results'], 'utf8')), dataset: await loadDataset(), photosDir: args['--photos'], outDir: args['--out'] });
  console.log(`${written.length} crops written`);
}
