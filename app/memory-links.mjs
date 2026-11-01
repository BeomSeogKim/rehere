import { createHash } from 'node:crypto';
import { OBJECT_IDS } from './arrangements.mjs';
import { RequestError } from './drafts.mjs';

// Owner links from a place's whole saved written memory to one confirmed
// scene object: pure validation, request parsing and the availability of
// the exact saved words. A link is the owner's own judgment that these words
// are about this object; it is never a model interpretation, a verified
// source or a statement of how the place was. Storage, locking and file
// access stay with the reconstruction store.

export const MEMORY_LINKS_FILE = 'memory-links.json';
export const MEMORY_LINKS_BYTES = 256 * 1024;
export const MEMORY_RECEIPTS_MAX = 200;
// The written-memory limit at saving (drafts.mjs LIMITS.textChars).
const TEXT_CHARS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isId = (value) => typeof value === 'string' && UUID.test(value);
const isSha = (value) => typeof value === 'string' && SHA256.test(value);
const isTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// The whole stored file, strictly: any other shape is unreadable, never empty.
export function validMemoryLinks(state) {
  if (!exactKeys(state, ['schemaVersion', 'objects']) || state.schemaVersion !== 1) return false;
  const { objects } = state;
  if (objects === null || typeof objects !== 'object' || Array.isArray(objects)) return false;
  return Object.entries(objects).every(([id, entry]) => OBJECT_IDS.includes(id) && exactKeys(entry, ['revision', 'updatedAt', 'link', 'receipts'])
    && Number.isInteger(entry.revision) && entry.revision >= 0 && (entry.updatedAt === null || isTime(entry.updatedAt))
    && (entry.link === null || (exactKeys(entry.link, ['sourceId', 'sourceSha256', 'linkedAt'])
      && isId(entry.link.sourceId) && isSha(entry.link.sourceSha256) && isTime(entry.link.linkedAt)))
    && Array.isArray(entry.receipts) && entry.receipts.length <= MEMORY_RECEIPTS_MAX
    && new Set(entry.receipts.map((receipt) => receipt?.requestId)).size === entry.receipts.length
    && entry.receipts.every((receipt) => exactKeys(receipt, ['requestId', 'digest', 'revision']) && isId(receipt.requestId)
      && isSha(receipt.digest) && Number.isInteger(receipt.revision) && receipt.revision >= 0));
}

// The number of stored links (available or not) in a valid file.
export const storedMemoryLinks = (state) => Object.values(state.objects).filter((entry) => entry.link !== null).length;

export const emptyMemoryEntry = () => ({ revision: 0, updatedAt: null, link: null, receipts: [] });

const UNREADABLE = 'The written memory link could not be read.';

export function parseMemoryLinkRequest(body) {
  if (!exactKeys(body, ['requestId', 'baseRevision', 'action', 'sourceId', 'confirmed'])) throw new RequestError(400, UNREADABLE);
  const { requestId, baseRevision, action, sourceId, confirmed } = body;
  if (!isId(requestId) || !Number.isInteger(baseRevision) || baseRevision < 0 || (action !== 'set' && action !== 'remove') || !isId(sourceId)) {
    throw new RequestError(400, UNREADABLE);
  }
  if (confirmed !== true) throw new RequestError(400, 'Confirm that these words are about this object before saving.');
  return { requestId, baseRevision, action, sourceId };
}

export const memoryRequestDigest = (request) => sha256(JSON.stringify([request.baseRevision, request.action, request.sourceId]));

// The place's saved written memory as it can be shown now: null when the
// draft has none (or is a legacy draft), otherwise its availability. Checks
// run in order: a missing or wrong-kind source or text is 'unreadable', no
// current place use (including a stop) is 'source', and words whose exact
// UTF-8 bytes no longer match the source record are 'checksum'. The words
// are returned exactly as stored, and only when available. `sha256` is the
// recorded checksum a link binds to.
export function writtenSourceView(draft, placeAllowed) {
  if (!Array.isArray(draft?.sources) || !isId(draft.textSourceId)) return null;
  const sourceId = draft.textSourceId;
  const hidden = (reason) => ({ view: { sourceId, available: false, reason, text: null }, sha256: null });
  const source = draft.sources.find((item) => item?.id === sourceId);
  // Trim only detects absence; the stored string is never changed.
  if (!source || source.kind !== 'text' || source.role !== 'original' || typeof draft.text !== 'string' || draft.text.trim() === ''
    || draft.text.length > TEXT_CHARS || !isSha(source.sha256) || !Number.isInteger(source.size)) return hidden('unreadable');
  if (!placeAllowed) return hidden('source');
  const bytes = Buffer.from(draft.text, 'utf8');
  if (bytes.length !== source.size || sha256(bytes) !== source.sha256) return hidden('checksum');
  return { view: { sourceId, available: true, reason: null, text: draft.text }, sha256: source.sha256 };
}

// A stored link as it can be shown now. It never carries the words; it is
// available only while its exact source still matches the checksum it bound.
export function memoryLinkView(link, written) {
  if (!link) return null;
  const view = (available, reason) => ({ sourceId: link.sourceId, linkedAt: link.linkedAt, available, reason });
  if (!written || written.view.sourceId !== link.sourceId) return view(false, 'unreadable');
  if (!written.view.available) return view(false, written.view.reason);
  if (written.sha256 !== link.sourceSha256) return view(false, 'checksum');
  return view(true, null);
}
