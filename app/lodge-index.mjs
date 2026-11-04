import { createHash } from 'node:crypto';
import { overlayPng } from './lodge-overlays.mjs';

// SAM 3.1 lodge index: what the SAM 3.1 model (Meta Model API) outlines in the pinned public HABS photographs of the Grand
// Canyon Lodge. These are 2D model estimates, not measurements. This module holds the fixed batch (photos and concept nouns)
// shared by the capture runner, the overlay generator and the page builder.

export const LODGE_BATCH = 'lodge-index-batch-1';
// One concept per request: lists return zero matches. The list is fixed before any call.
export const LODGE_NOUNS = Object.freeze(['chair', 'table', 'rocking chair', 'chandelier', 'window', 'fireplace', 'rug', 'bench', 'lamp', 'door']);
export const LODGE_PHOTO_FILES = Object.freeze(['a16.jpg', 'a19.jpg', 'a26.jpg']);
export const LODGE_LIMITS = Object.freeze({ totalUsd: 0.08, perRequestUsd: 0.0025, maxRequests: LODGE_PHOTO_FILES.length * LODGE_NOUNS.length });

export const nounSlug = (noun) => noun.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------------------------------------------------------------
// Page, derived data and overlay assembly. The committed lodge-index.json and lodge-index.html are produced by
// buildLodge() from the private capture's derived instances, and a test rebuilds them to prove they have not drifted.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const LODGE_MODEL_LABEL = 'SAM 3.1 (Meta Model API)';
export const LODGE_PARSER = 'meta-sam-parser==0.1.0';
export const LODGE_PRICE_ESTIMATE_USD = 0.075;
const HABS_PDF = 'https://tile.loc.gov/storage-services/master/pnp/habshaer/az/az0400/az0459/data/az0459cap.pdf';
const HABS_RIGHTS = 'https://www.loc.gov/rr/print/res/114_habs.html';

// What the page author saw when looking at each overlay on its photograph. A reading by eye, not a measurement: no ground
// truth exists for these photographs. Only results that were looked at carry a note.
export const LODGE_NOTES = Object.freeze({
  'AZ-135-A-16/chair': 'Outlines cover chairs in the near and middle rows; chairs in the distant rows are mostly not outlined.',
  'AZ-135-A-16/table': 'Outlines mostly follow the tablecloths; one or two run down a pedestal base; chairs are not included; several distant tables are not outlined.',
  'AZ-135-A-16/chandelier': 'Three outlines, one on each of the three hanging fixtures.',
  'AZ-135-A-16/window': 'Outlines cover the three large windows, the window on the right wall and several smaller panes; some panes are not outlined.',
  'AZ-135-A-16/lamp': 'Two of the hanging fixtures that the chandelier request also returned come back again as lamps, plus a small object at the lower right edge. The same object can answer two different nouns.',
  'AZ-135-A-19/chair': 'Outlines cover the front rows and a chair on the left; the many chairs in the rear rows are not outlined.',
  'AZ-135-A-19/lamp': 'Five outlines: three hanging fixtures and two wall lamps. Hanging fixtures also answer the chandelier request.',
  'AZ-135-A-19/window': 'Outlines cover the two shaded wall windows, the windows of the rear wall and the tall windows on the right; not every pane is outlined.',
  'AZ-135-A-26/chair': 'One outline, around the rocking chair. The chest of drawers beside it is not outlined.',
  'AZ-135-A-26/rocking chair': 'One outline, around the same chair that the chair request returned.',
});

const photoKey = (photo) => photo.file.replace(/\.jpg$/, '');
export const overlayName = (photo, noun) => `${photoKey(photo)}-${nounSlug(noun)}.png`;

// derived: { results: [{ photo, noun, responseId, requestDigest, imagesProcessed, latencyMs, recordedAt, instances }] }
// photos: entry/photos.json photos. Returns the committed data, the overlay files and the page.
export function buildLodge({ derived, photos: allPhotos }) {
  const photos = LODGE_PHOTO_FILES.map((file) => allPhotos.find((photo) => photo.file === file));
  if (photos.some((photo) => !photo)) throw new Error('A pinned photograph is missing from entry/photos.json.');
  const overlayFiles = new Map();
  const dataPhotos = photos.map((photo) => ({
    hbs: photo.hbs, file: photo.file, sha256: photo.sha256, width: photo.width, height: photo.height,
    results: LODGE_NOUNS.map((noun) => {
      const found = derived.results.filter((item) => item.photo === photo.hbs && item.noun === noun);
      if (found.length !== 1) throw new Error(`${photo.hbs} / ${noun}: expected exactly one result, found ${found.length}.`);
      const [result] = found;
      let overlay = null;
      if (result.instances.length) {
        overlay = overlayName(photo, noun);
        overlayFiles.set(overlay, overlayPng({ width: photo.width, height: photo.height, instances: result.instances, noun }));
      }
      const note = LODGE_NOTES[`${photo.hbs}/${noun}`] ?? null;
      return {
        noun, responseId: result.responseId, requestDigest: result.requestDigest, imagesProcessed: result.imagesProcessed,
        latencyMs: result.latencyMs, recordedAt: result.recordedAt, overlay, ...(note ? { note } : {}),
        instances: result.instances.map(({ id, box, confidence, areaPx, rle }) => ({ id, box, confidence, areaPx, rle })),
      };
    }),
  }));
  const data = {
    note: 'Derived from the private SAM 3.1 responses: ids, counts, boxes, model confidences and outlines only. No raw provider output.',
    model: LODGE_MODEL_LABEL, modelId: 'sam-3.1', parser: LODGE_PARSER, requests: photos.length * LODGE_NOUNS.length,
    listPriceEstimateUsd: LODGE_PRICE_ESTIMATE_USD, nouns: [...LODGE_NOUNS],
    overlays: [...overlayFiles].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha256(bytes) })),
    photos: dataPhotos,
  };
  return { data, overlayFiles, html: renderLodgePage(data, photos) };
}

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function confidenceLine(instances) {
  const values = instances.map((item) => item.confidence).filter((value) => value !== null).sort((a, b) => a - b);
  if (!values.length) return 'no confidence returned';
  if (values.length === 1) return `model confidence ${values[0].toFixed(2)}`;
  const middle = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  return `model confidence ${values[0].toFixed(2)} to ${values[values.length - 1].toFixed(2)} (median ${middle.toFixed(2)})`;
}

function renderCard(photo, result) {
  const count = result.instances.length;
  const head = `<h4>${esc(result.noun)}: ${plural(count, 'instance')}</h4>`;
  if (!count) {
    return `<div class="lodge-card">${head}<p class="lodge-zero">The model returned no instance for this noun. That is an observed model answer, not evidence that the object is absent.</p><p class="lodge-meta">Response <code>${esc(result.responseId)}</code></p></div>`;
  }
  const rows = result.instances.map((item) => `<tr><td>${item.id}</td><td>${item.box.join(', ')}</td><td>${item.confidence === null ? 'none' : item.confidence.toFixed(3)}</td><td>${item.areaPx}</td></tr>`).join('');
  return `<div class="lodge-card">${head}
<div class="lodge-stack"><img src="entry/${esc(photo.file)}" width="${photo.width}" height="${photo.height}" alt="${esc(photo.alt)}"><img class="lodge-overlay" src="entry/lodge/${esc(result.overlay)}" width="${photo.width}" height="${photo.height}" alt="Outlines of the ${plural(count, 'instance')} that SAM 3.1 returned for ${esc(result.noun)}, drawn over the photograph"></div>
<p class="lodge-meta">${plural(count, 'instance')}; ${confidenceLine(result.instances)}. The confidence is the model's own number, not a measure of accuracy. Response <code>${esc(result.responseId)}</code></p>
${result.note ? `<p class="lodge-note">Page author's reading by eye: ${esc(result.note)}</p>` : ''}
<details><summary>Instances, boxes and confidences</summary><table class="lodge-table"><thead><tr><th scope="col">Instance</th><th scope="col">Box x1, y1, x2, y2 (pixels; x2 and y2 exclusive)</th><th scope="col">Confidence</th><th scope="col">Mask area (pixels)</th></tr></thead><tbody>${rows}</tbody></table></details></div>`;
}

export function renderLodgePage(data, photos) {
  const total = data.photos.reduce((sum, photo) => sum + photo.results.reduce((s, r) => s + r.instances.length, 0), 0);
  const summaryRows = data.nouns.map((noun) => `<tr><th scope="row">${esc(noun)}</th>${data.photos.map((photo) => `<td>${photo.results.find((r) => r.noun === noun).instances.length}</td>`).join('')}</tr>`).join('');
  const sections = data.photos.map((entry, index) => {
    const photo = photos[index];
    const heading = `<section class="lodge-photo" aria-labelledby="photo${index + 1}-h">
<h3 id="photo${index + 1}-h">${esc(photo.hbs)}: ${esc(photo.caption)}</h3>
<p class="source">Source: <a href="${photo.locUrl}">Library of Congress record</a>, <a href="${photo.commonsUrl}">Wikimedia Commons file (the copy shown here)</a>, <a href="${HABS_PDF}">HABS caption index (PDF)</a>. Photograph by Richard Frear, July 1982, Historic American Buildings Survey. Rights: a U.S. Government work with no known restrictions on images made by the U.S. Government (<a href="${HABS_RIGHTS}">Library of Congress HABS rights advisory</a>). Frame ${photo.width} x ${photo.height} pixels, SHA-256 <code>${photo.sha256}</code>.</p>
`;
    const cards = entry.results.filter((result) => index !== 0 || result.noun !== 'chair').map((result) => renderCard(photo, result)).join('\n');
    const opening = index === 0 ? `<section class="lodge-photo" aria-labelledby="photo1-rest-h">\n<h3 id="photo1-rest-h">${esc(photo.hbs)}: ${esc(photo.caption)}</h3>\n` : heading;
    return { heading, section: `${opening}<div class="lodge-grid">\n${cards}\n</div>\n</section>` };
  });
  const featured = `${sections[0].heading}<div class="lodge-grid">\n${renderCard(photos[0], data.photos[0].results.find((result) => result.noun === 'chair'))}\n</div>\n</section>`;
  const remainingSections = sections.map((section) => section.section).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>What SAM 3.1 outlines in the lodge photographs - Rehere</title>
  <link rel="stylesheet" href="entry.css">
</head>
<body>
  <a class="skip" href="#photos">Skip to the photographs</a>
  <header class="top">
    <p class="brand">Rehere</p>
    <h1>What SAM 3.1 (Meta Model API) outlines in the lodge photographs: model estimates, not measurements</h1>
    <p class="lede">Three public photographs of the Grand Canyon Lodge, each asked about ten everyday nouns, one noun per request. ${plural(total, 'outline')} came back in ${data.requests} requests. These ${data.requests} requests were made for this index page and are separate from the outlines used in the reconstructed scene of the third photograph (AZ-135-A-26).</p>
    <p><a href="index.html">Back to the saved visit</a></p>
  </header>
  <main id="main">
    <div id="photos">
${featured}
    </div>
    <section aria-labelledby="read-h">
      <h2 id="read-h">How to read this page</h2>
      <ul>
        <li>These are 2D outlines proposed by ${esc(data.model)} for each photograph. They are estimates, not measurements, and there is no ground truth for these photographs here.</li>
        <li>Confidence is the number the model returned with each outline. It is not a measure of accuracy.</li>
        <li>Missed objects and merged or loose outlines are left in. A noun for which the model returned nothing shows zero, and that is an observed answer, not proof that nothing is there.</li>
        <li>Nothing here is a 3D model, a stitched room or a reconstruction. These are fresh requests made for this page; they are not the outlines used in the reconstructed scene of the entry.</li>
        <li>${data.requests} requests, one image each, list price about USD ${data.listPriceEstimateUsd.toFixed(3)} (an estimate from the published price, not a bill). Masks were decoded offline with the official ${esc(data.parser)} parser; each overlay image has exactly the pixel size of its photograph.</li>
      </ul>
    </section>
    <section aria-labelledby="counts-h">
      <h2 id="counts-h">Instances returned per request</h2>
      <table class="lodge-table"><caption>Number of instances SAM 3.1 returned for each noun and photograph</caption><thead><tr><th scope="col">Noun</th>${data.photos.map((entry) => `<th scope="col">${esc(entry.hbs)}</th>`).join('')}</tr></thead><tbody>${summaryRows}</tbody></table>
    </section>
    <section aria-labelledby="photos-h">
      <h2 id="photos-h">The photographs and what came back</h2>
${remainingSections}
    </section>
  </main>
  <footer>
    <p>Source code: <a href="https://github.com/BeomSeogKim/rehere">github.com/BeomSeogKim/rehere</a> (<a href="https://github.com/BeomSeogKim/rehere/blob/main/LICENSE">Apache-2.0</a>). Built during the Meta Global AI Developer Hackathon, October 27 to November 4, 2026.</p>
  </footer>
</body>
</html>
`;
}
