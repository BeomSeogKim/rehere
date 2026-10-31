import { createHash } from 'node:crypto';

const ORIGIN_KINDS = new Set(['own', 'public', 'other', 'unknown']);
export const PURPOSES = Object.freeze(['place', 'model', 'share']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

class MetadataError extends Error {}

// Absent metadata must never imply a provider, consent or a known date.
export function unknownSource() {
  return {
    provider: '',
    origin: { kind: 'unknown', reference: '' },
    permissions: { place: false, model: false, share: false },
    dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  };
}

function fail() {
  throw new MetadataError();
}

function object(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail();
  return value;
}

function text(value, max) {
  if (typeof value !== 'string' || value.length > max) fail();
  return value.trim() ? value : '';
}

function isCalendarDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match || !isCalendarDate(match[1])) return false;
  const [hour, minute, second] = match.slice(2, 5).map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  return !match[5] || (Number(match[6]) <= 23 && Number(match[7]) <= 59);
}

function nullable(value, valid) {
  if (value === null) return null;
  if (typeof value !== 'string' || !valid(value)) fail();
  return value;
}

function sourceInput(value) {
  const input = object(value, ['provider', 'origin', 'permissions', 'dates']);
  const origin = object(input.origin, ['kind', 'reference']);
  const permissions = object(input.permissions, PURPOSES);
  const dates = object(input.dates, ['capturedOn', 'fileCreatedAt', 'fileModifiedAt', 'estimatedPeriod']);
  if (!ORIGIN_KINDS.has(origin.kind)) fail();
  if (!PURPOSES.every((purpose) => typeof permissions[purpose] === 'boolean')) fail();
  return {
    provider: text(input.provider, 120),
    origin: { kind: origin.kind, reference: text(origin.reference, 2000) },
    permissions: { place: permissions.place, model: permissions.model, share: permissions.share },
    dates: {
      capturedOn: nullable(dates.capturedOn, isCalendarDate),
      fileCreatedAt: nullable(dates.fileCreatedAt, isTimestamp),
      fileModifiedAt: nullable(dates.fileModifiedAt, isTimestamp),
      estimatedPeriod: text(dates.estimatedPeriod, 160),
    },
  };
}

// Returns one SourceInput per material, or null for an absent material. An
// omitted group or a null text/voice entry gets the unknown default. Returns
// null for the whole metadata when it is invalid, so the caller can report the
// error in its own terms. JSON.parse keeps the last of repeated object keys;
// duplicate keys inside the JSON are not detected.
export function parseSourceMetadata(raw, { photoCount, hasText, hasVoice }) {
  try {
    const metadata = raw === null ? {} : JSON.parse(raw);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) fail();
    if (Object.keys(metadata).some((key) => !['photos', 'text', 'voice'].includes(key))) fail();
    let photos = Array.from({ length: photoCount }, unknownSource);
    if (Object.hasOwn(metadata, 'photos')) {
      if (!Array.isArray(metadata.photos) || metadata.photos.length !== photoCount) fail();
      photos = metadata.photos.map(sourceInput);
    }
    const optional = (value, present) => {
      if (value === undefined || value === null) return present ? unknownSource() : null;
      return present ? sourceInput(value) : fail();
    };
    return {
      photos,
      text: optional(metadata.text, hasText),
      voice: optional(metadata.voice, hasVoice),
    };
  } catch (error) {
    if (error instanceof MetadataError || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sourceRecord(id, kind, input, { name, bytes, type }) {
  return {
    id,
    kind,
    role: 'original',
    parentSourceId: null,
    name,
    sha256: sha256(bytes),
    size: bytes.length,
    type,
    ...input,
  };
}

// A local processing boundary, not user identity or authorization. Only an
// explicit true grant on a known source allows use; legacy drafts deny.
export function canUseSource(draft, sourceId, purpose) {
  if (!PURPOSES.includes(purpose) || !Array.isArray(draft?.sources)) return false;
  const source = draft.sources.find((item) => item?.id === sourceId);
  return source?.permissions?.[purpose] === true;
}
