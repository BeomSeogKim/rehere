import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { RequestError } from './drafts.mjs';
import { canonicalPose } from './public/composition-scene.js';
import { sha256 } from './sources.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
export const COMPOSITION_OUTPUTS = Object.freeze({
  'surface.json': { type: 'application/json; charset=utf-8', maxBytes: 64 * 1024 * 1024 },
  'texture-1.jpg': { type: 'image/jpeg', maxBytes: 64 * 1024 * 1024 },
  'texture-2.jpg': { type: 'image/jpeg', maxBytes: 64 * 1024 * 1024 },
});
export const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = () => new RequestError(400, 'The composition request could not be read.');

export function parseCompositionPose(value) {
  if (!exactKeys(value, ['position', 'quaternion', 'scale'])) throw invalid();
  try { return canonicalPose(value); } catch { throw invalid(); }
}

export function parseCompositionRequest(body) {
  if (!exactKeys(body, ['kind', 'requestId', 'objects', 'context', 'confirmed', 'scaleBasis'])
    || body.kind !== 'two-photo-composition' || typeof body.requestId !== 'string' || !UUID.test(body.requestId) || body.confirmed !== true || body.scaleBasis !== 'owner-assumed-relative'
    || !Array.isArray(body.objects) || body.objects.length !== 2 || !exactKeys(body.context, ['keep', 'bounds']) || typeof body.context.keep !== 'boolean') throw invalid();
  const objects = body.objects.map((item) => {
    if (!exactKeys(item, ['label', 'component', 'pose']) || !exactKeys(item.component, ['jobId', 'objectId', 'surfaceSha256'])
      || typeof item.component.jobId !== 'string' || !UUID.test(item.component.jobId) || !['selected-foreground', 'object-1', 'object-2'].includes(item.component.objectId)
      || typeof item.component.surfaceSha256 !== 'string' || !SHA.test(item.component.surfaceSha256)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(item.label)) throw invalid();
    return { label: item.label.trim(), component: { ...item.component }, pose: parseCompositionPose(item.pose) };
  });
  if (objects[0].label.toLowerCase() === objects[1].label.toLowerCase()) throw invalid();
  const { bounds, keep } = body.context;
  if ((!keep && bounds !== null) || (bounds !== null && (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
    || bounds[0] < 0 || bounds[1] < 0 || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]))) throw invalid();
  return { kind: body.kind, requestId: body.requestId, objects, context: { keep, bounds: bounds && [...bounds] }, confirmed: true, scaleBasis: body.scaleBasis };
}

// Reads exactly the pinned regular file through one bounded, no-follow handle.
export async function verifiedAsset(file, entry, spec) {
  if (!entry || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > spec.maxBytes || !SHA.test(entry.sha256)) throw new RequestError(409, 'The saved scene files could not be verified.');
  let handle;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size !== entry.size) throw new Error();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(entry.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== entry.size || sha256(bytes.subarray(0, offset)) !== entry.sha256) throw new Error();
    return bytes.subarray(0, offset);
  } catch {
    throw new RequestError(409, 'The saved scene files could not be verified.');
  } finally { await handle?.close().catch(() => {}); }
}
