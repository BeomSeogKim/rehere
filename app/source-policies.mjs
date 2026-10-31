import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from './drafts.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURPOSES = ['place', 'model', 'share'];
export const STOPPED_MESSAGE = 'The owner stopped using this material. The original is retained but is no longer used.';

const fail = (status, message) => new RequestError(status, message);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Original grants are booleans recorded at import; anything else grants nothing.
const originalGrants = (source) => Object.fromEntries(PURPOSES.map((purpose) => [purpose, source?.permissions?.[purpose] === true]));

// Purposes are cumulative: model and share uses of a photo both build on place.
export function allows(policy, purpose) {
  if (policy.stopped) return false;
  if (purpose === 'archive') return true;
  if (purpose === 'place') return policy.permissions.place;
  if (purpose === 'model' || purpose === 'share') return policy.permissions.place && policy.permissions[purpose];
  return false;
}

function parseRestriction(body) {
  const valid = exactKeys(body, ['requestId', 'baseRevision', 'permissions', 'stopUse']) && typeof body.requestId === 'string' && UUID.test(body.requestId)
    && Number.isInteger(body.baseRevision) && body.baseRevision >= 0 && typeof body.stopUse === 'boolean'
    && exactKeys(body.permissions, PURPOSES) && PURPOSES.every((purpose) => typeof body.permissions[purpose] === 'boolean');
  if (!valid) throw fail(400, 'The request could not be read.');
  const { place, model, share } = body.permissions;
  return { requestId: body.requestId, baseRevision: body.baseRevision, permissions: { place, model, share }, stopUse: body.stopUse };
}

function validPolicyFile(state) {
  return state?.schemaVersion === 1 && state.sources !== null && typeof state.sources === 'object' && !Array.isArray(state.sources)
    && Object.entries(state.sources).every(([id, entry]) => UUID.test(id) && Number.isInteger(entry?.revision) && entry.revision >= 1
      && typeof entry.stopped === 'boolean' && exactKeys(entry.permissions, PURPOSES) && PURPOSES.every((purpose) => typeof entry.permissions[purpose] === 'boolean')
      && Array.isArray(entry.receipts));
}

// The owner's current use restrictions for imported originals. Each draft has
// one policy.json beside its immutable draft.json; originals and draft.json are
// never rewritten. Without an entry, a source has exactly its recorded grants.
// Mutations are serialized by the caller (the reconstruction store's mutex).
export class SourcePolicies {
  constructor({ dataDir, drafts }) {
    this.draftsDir = path.join(dataDir, 'drafts');
    this.drafts = drafts;
  }

  #file(draftId) {
    return path.join(this.draftsDir, draftId, 'policy.json');
  }

  // Read fresh on every call, so a restriction applies at once everywhere.
  async #read(draftId) {
    let text;
    try {
      text = await readFile(this.#file(draftId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, sources: {} };
      throw fail(503, 'Source use settings are unavailable.');
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw fail(503, 'Source use settings are unavailable.');
    }
    if (!validPolicyFile(state)) throw fail(503, 'Source use settings are unavailable.');
    return state;
  }

  #effective(source, entry) {
    if (!entry) return { sourceId: source.id, revision: 0, permissions: originalGrants(source), stopped: false, updatedAt: null, changedBy: null };
    // An overlay can only narrow the recorded grants.
    const original = originalGrants(source);
    const permissions = Object.fromEntries(PURPOSES.map((purpose) => [purpose, !entry.stopped && original[purpose] && entry.permissions[purpose]]));
    return { sourceId: source.id, revision: entry.revision, permissions, stopped: entry.stopped, updatedAt: entry.updatedAt, changedBy: entry.changedBy };
  }

  #source(draft, sourceId) {
    return Array.isArray(draft?.sources) ? draft.sources.find((item) => item?.id === sourceId) ?? null : null;
  }

  async get(draftId, sourceId) {
    const draft = await this.drafts.get(draftId);
    const source = this.#source(draft, sourceId);
    if (!source) throw fail(404, 'This material could not be found.');
    return this.#effective(source, (await this.#read(draftId)).sources[sourceId]);
  }

  // The source record with effective permissions and policy metadata, or null.
  async effectiveSource(draft, sourceId) {
    const source = this.#source(draft, sourceId);
    if (!source) return null;
    const policy = this.#effective(source, (await this.#read(draft.id)).sources[sourceId]);
    return { ...source, permissions: policy.permissions, policy: { revision: policy.revision, stopped: policy.stopped, updatedAt: policy.updatedAt } };
  }

  // A legacy draft without source records grants no processing or sharing.
  async canUse(draft, sourceId, purpose) {
    const source = this.#source(draft, sourceId);
    if (!source) return false;
    return allows(this.#effective(source, (await this.#read(draft.id)).sources[sourceId]), purpose);
  }

  // Owner view of a draft under current restrictions. A stopped source keeps a
  // marker with its ID, kind, checksum and provider; its text, file name, media
  // entry, origin reference and dates are not projected.
  async projectDraft(draft) {
    if (!Array.isArray(draft.sources)) return draft;
    const overlay = (await this.#read(draft.id)).sources;
    const policies = new Map(draft.sources.map((source) => [source.id, this.#effective(source, overlay[source.id])]));
    const stopped = (id) => policies.get(id)?.stopped === true;
    return {
      ...draft,
      text: stopped(draft.textSourceId) ? '' : draft.text,
      photos: draft.photos.filter((photo) => !stopped(photo.sourceId)),
      voice: draft.voice && stopped(draft.voice.sourceId) ? null : draft.voice,
      sources: draft.sources.map((source) => {
        const policy = policies.get(source.id);
        const meta = { revision: policy.revision, stopped: policy.stopped, updatedAt: policy.updatedAt };
        if (!policy.stopped) return { ...source, permissions: policy.permissions, policy: meta };
        return { id: source.id, kind: source.kind, role: source.role, sha256: source.sha256, provider: source.provider, permissions: policy.permissions, policy: meta };
      }),
    };
  }

  // Refuses a stored photo or recording of a stopped source. Matches only
  // names recorded in the draft, before any file is opened.
  async assertArchiveAsset(draft, name) {
    const entry = [...(draft?.photos ?? []), draft?.voice].find((item) => item?.name === name);
    if (!entry || !Array.isArray(draft.sources)) return;
    if (!(await this.canUse(draft, entry.sourceId, 'archive'))) throw fail(409, STOPPED_MESSAGE);
  }

  // Narrows or stops one source. Returns { policy, changed }.
  async restrict(draftId, sourceId, principal, body) {
    const request = parseRestriction(body);
    const draft = await this.drafts.get(draftId);
    const source = this.#source(draft, sourceId);
    if (!source) throw fail(404, 'This material could not be found.');
    const state = await this.#read(draftId);
    const entry = state.sources[sourceId];
    const current = this.#effective(source, entry);
    const { requestId, ...values } = request;
    const digest = sha256(JSON.stringify(values));
    const receipt = entry?.receipts.find((item) => item.requestId === requestId);
    if (receipt) {
      if (receipt.digest !== digest) throw fail(409, 'This request was already used with different values.');
      // A replay reports the current state; it never restores earlier grants.
      return { policy: current, changed: false };
    }
    if (request.baseRevision !== current.revision) throw fail(409, 'These settings changed elsewhere. Reload them before saving.');
    if (current.stopped && !request.stopUse) throw fail(409, 'Stopped material cannot be used again.');
    if (PURPOSES.some((purpose) => request.permissions[purpose] && !current.permissions[purpose])) {
      throw fail(409, 'Uses can only be turned off here, not added.');
    }
    const permissions = request.stopUse ? { place: false, model: false, share: false } : request.permissions;
    const next = {
      revision: current.revision + 1, permissions, stopped: request.stopUse, updatedAt: new Date().toISOString(), changedBy: principal.id,
      receipts: [...(entry?.receipts ?? []), { requestId, digest, revision: current.revision + 1 }],
    };
    const file = this.#file(draftId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...state, sources: { ...state.sources, [sourceId]: next } }, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw fail(503, 'The restriction could not be saved. Nothing was changed.');
    }
    return { policy: this.#effective(source, next), changed: true };
  }
}
