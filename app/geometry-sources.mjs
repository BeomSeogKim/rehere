import { RequestError } from './drafts.mjs';
import { COMPOSITION_REPRESENTATION } from './public/composition-scene.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const IDS = ['object-1', 'object-2'];

// Every scene use follows its entire immutable photo closure, even offscreen.
export function geometrySources(manifest) {
  if (manifest?.representation === COMPOSITION_REPRESENTATION) {
    const bindings = manifest.sourceBindings;
    if (Object.hasOwn(manifest, 'sourceId') || Object.hasOwn(manifest, 'sourceSha256') || !Array.isArray(bindings) || bindings.length !== 2
      || !bindings.every((entry, index) => typeof entry?.sourceId === 'string' && UUID.test(entry.sourceId) && typeof entry?.sourceSha256 === 'string' && SHA.test(entry.sourceSha256)
        && Object.keys(entry).length === 3 && Array.isArray(entry.objectIds) && entry.objectIds.length === 1 && entry.objectIds[0] === IDS[index])
      || bindings[0].sourceId === bindings[1].sourceId) {
      throw new RequestError(409, 'The scene photo bindings could not be verified.');
    }
    return bindings.map((entry) => ({ ...entry, objectIds: [...entry.objectIds] }));
  }
  if (manifest?.representation !== undefined || manifest?.sourceBindings !== undefined) throw new RequestError(409, 'The scene photo bindings could not be verified.');
  return [{ sourceId: manifest.sourceId, sourceSha256: manifest.sourceSha256, objectIds: manifest.objects?.map(({ id }) => id) ?? ['selected-foreground'] }];
}
