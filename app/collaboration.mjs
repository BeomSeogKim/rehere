import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  OBJECT_IDS, arrangementOf, assertObjectsConfirmed, assertRelationship, isTwoObject, withTarget,
} from './arrangements.mjs';
import { RequestError } from './drafts.mjs';
import { ACTIVE_PROPOSAL } from './memory-proposals.mjs';
import {
  PHOTO_BUSY, PHOTO_PREPARE_FAILED, PLAYBACK_NAME, REVIEW_NAME, VOICE_ORIGINAL_NAMES, contributionsDir, parsePhotoFacts, photoAttested, photoDir,
  readPlayback, readReviewPhoto, reviewJpegInfo,
} from './contribution-photos.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Plain text: tab, newline and carriage return are the only control characters allowed.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Text limits count UTF-16 code units, as browsers report string length.
export const COLLABORATION_LIMITS = Object.freeze({ text: 10_000, captionText: 20_000, periodClaim: 300, reason: 1000, eraLabel: 300, eraStatement: 2000, contributions: 200 });
const OFFSET_LIMIT = 2;
const DECISIONS = Object.freeze({ reviewing: 'reviewing', adopt: 'adopted', alternative: 'alternative', hold: 'held', reject: 'rejected' });
const CONFLICTS = new Set(['unknown', 'viewpoint', 'time', 'memory', 'recognition']);
const REVIEWABLE = new Set(['submitted', 'reviewing', 'held']);
const ERA_KINDS = new Set(['unknown', 'exact', 'range', 'relative']);
const RELATIONS = new Set(['before', 'after', 'same-time']);

export const BLOCKED_MESSAGE = 'This scene depends on a contribution that was withdrawn. Restore an earlier saved version that does not depend on it.';
// Integrity failures and photo grants never claim that the provider withdrew.
export const UNAVAILABLE_MESSAGE = 'A contributor photo this scene depends on is not available for this use right now. Restore an earlier saved version that does not depend on it, or try again later.';

const fail = (status, message) => new RequestError(status, message);
const UNREADABLE = 'The request could not be read.';
const NOT_FOUND = 'This scene could not be found.';
const CONTRIBUTION_NOT_FOUND = 'This contribution could not be found.';
const NOT_ALLOWED = 'This action is not allowed.';
const REUSED = 'This request was already used with different values.';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isId = (value) => typeof value === 'string' && UUID.test(value);
const plain = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const nonblank = (value, max) => plain(value, max) && value.trim() !== '';

function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Version 1 and edits saved before contributions existed depend on nothing.

export function versionDependencies(manifest, version) {
  if (version === 1) return [];
  return manifest.edits.find((item) => item.version === version)?.dependencies ?? [];
}

export const currentDependencies = (manifest) => versionDependencies(manifest, manifest.edit.version);

// A bundle allows a purpose only when every material it has allows it:
// its writing (when there is writing), its photo and its recording.
export function contributionAllows(contribution, purpose) {
  return (contribution.permissions === null || contribution.permissions?.[purpose] === true)
    && (!contribution.photo || contribution.photo.source.permissions[purpose] === true)
    && (!contribution.voice || contribution.voice.source.permissions[purpose] === true);
}

// The canonical caption hash: it binds the provider's cues to the exact
// original recording, its listening copy and the caption author.
export const captionHash = (source, playback, authorId, cues) => sha256(JSON.stringify([source.sha256, playback.sha256, authorId, cues]));

// True only for confirmed captions whose stored hash is recomputed from their
// current content and identity, written by the bundle's own provider. A stored
// hash is never trusted on its own.
export function captionsIntact(contribution) {
  const captions = contribution.voice?.captions;
  if (!captions || captions.confirmed !== true || captions.author?.principalId !== contribution.principalId || !Array.isArray(captions.cues)) return false;
  return captions.sha256 === captionHash(contribution.voice.source, contribution.voice.playback, captions.author.principalId, captions.cues);
}

// Grants apply per purpose to every inherited contribution. Any use needs each
// one present, not withdrawn, granted for place construction on every material
// and with every stored file currently verified; a hosted model use also needs
// each model grant, because the saved transform itself carries the memory.
// Only an explicit withdrawal is 'withdrawn'; a missing record, an ungranted
// material or a missing or changed file is 'unavailable'. Returns
// 'withdrawn', 'unavailable', 'model' or null.
export function dependencyIssue(manifest, ids, purpose = 'place') {
  const contributions = manifest.collaboration?.contributions ?? [];
  let issue = null;
  for (const id of ids) {
    const contribution = contributions.find((item) => item.id === id);
    if (contribution && contribution.withdrawnAt !== null) return 'withdrawn';
    if (!contribution || !contributionAllows(contribution, 'place') || !photoAttested(manifest, contribution)) issue = 'unavailable';
    else if (purpose === 'model' && !contributionAllows(contribution, 'model') && issue === null) issue = 'model';
  }
  return issue;
}

export function issueMessage(issue) {
  if (issue === 'model') return MODEL_BLOCKED_MESSAGE;
  return issue === 'unavailable' ? UNAVAILABLE_MESSAGE : BLOCKED_MESSAGE;
}

// Throws a 409 unless every listed dependency may be used for place construction.
function assertDependencies(manifest, ids) {
  const issue = dependencyIssue(manifest, ids);
  if (issue) throw fail(409, issueMessage(issue));
}

export const dependenciesBlocked = (manifest, ids) => dependencyIssue(manifest, ids) !== null;
export const usageBlocked = (manifest) => manifest.status === 'ready' && dependenciesBlocked(manifest, currentDependencies(manifest));
export const modelBlocked = (manifest) => manifest.status === 'ready' && dependencyIssue(manifest, currentDependencies(manifest), 'model') !== null;

const UNAVAILABLE_PHOTO = 'This contributor photo is not available right now.';
const UNAVAILABLE_RECORDING = 'This contributed recording is not available right now.';
const UNAVAILABLE_MATERIAL = 'A photo or recording in this contribution is not available right now.';
export const BUNDLE_BUSY = 'Another recording or photo is being prepared. Nothing was started for this request. Try again in a moment.';
const SHUTTING_DOWN = 'The app is shutting down. Try again later.';
const SOURCE_STOPPED_MESSAGE = 'The owner stopped using this photo or turned off its place use, so no version of this scene can be changed.';

export const REDACTED_PROPOSAL_MESSAGE = 'This proposal was made from a saved version that depends on a withdrawn contribution, so its content is no longer shown.';
const UNAVAILABLE_PROPOSAL_MESSAGE = 'This proposal was made from a saved version that depends on a contributor photo that is not available right now, so its content is not shown.';

// Every proposal leaving the server goes through this projection. A proposal
// made from a version with a withdrawn dependency carries that memory in its
// message and plan, so only audit metadata is shown and it cannot be previewed
// or applied. The full record stays on disk.
export function projectProposal(manifest, proposal) {
  const issue = dependencyIssue(manifest, versionDependencies(manifest, proposal.baseVersion));
  if (!issue) return proposal;
  return {
    ...proposal, statement: { ...proposal.statement, text: null }, result: null, question: null,
    status: 'stale', error: issue === 'unavailable' ? UNAVAILABLE_PROPOSAL_MESSAGE : REDACTED_PROPOSAL_MESSAGE, redacted: true,
  };
}

export const MODEL_BLOCKED_MESSAGE = 'This scene includes a contribution that was not shared for model processing, so the hosted model cannot be used on it. Manual editing is still available.';

// Throws unless the current saved version may be used for `purpose` ('place' or 'model').
export function assertSceneUsable(manifest, purpose) {
  const issue = dependencyIssue(manifest, currentDependencies(manifest), purpose);
  if (issue === 'model') throw new RequestError(403, MODEL_BLOCKED_MESSAGE);
  if (issue) throw new RequestError(409, issueMessage(issue));
}


function parseSubmit(body) {
  const valid = exactKeys(body, ['requestId', 'text', 'permissions', 'periodClaim']) && isId(body.requestId)
    && nonblank(body.text, COLLABORATION_LIMITS.text) && plain(body.periodClaim, COLLABORATION_LIMITS.periodClaim)
    && exactKeys(body.permissions, ['place', 'model', 'share'])
    && ['place', 'model', 'share'].every((key) => typeof body.permissions[key] === 'boolean');
  if (!valid) throw fail(400, UNREADABLE);
  const { place, model, share } = body.permissions;
  return { requestId: body.requestId, text: body.text, permissions: { place, model, share }, periodClaim: body.periodClaim };
}

// A two-object candidate names the one object it moves; the rest of the
// arrangement and its rule come from the saved scene, never from the request.
function parseTransform(transform, twoObjects) {
  if (!exactKeys(transform, twoObjects ? ['targetId', 'offset', 'yaw'] : ['offset', 'yaw'])) return null;
  const { offset, yaw } = transform;
  const valid = Array.isArray(offset) && offset.length === 3 && offset.every((value) => finite(value) && Math.abs(value) <= OFFSET_LIMIT)
    && finite(yaw) && yaw >= -Math.PI && yaw <= Math.PI && (!twoObjects || OBJECT_IDS.includes(transform.targetId));
  if (!valid) return null;
  return twoObjects ? { targetId: transform.targetId, offset: [...offset], yaw } : { offset: [...offset], yaw };
}

// The saved edit fields of a scene version, in its own shape.
const editFields = (edit) => (Array.isArray(edit.objects) ? arrangementOf(edit) : { offset: [...edit.offset], yaw: edit.yaw });

// photoReviewed and voiceReviewed are accepted only as extra keys; whether
// each is required or refused depends on the contribution, checked by the caller.
const ACKNOWLEDGMENTS = ['photoReviewed', 'voiceReviewed'];
function parseReview(body, twoObjects) {
  const keys = ['requestId', 'baseVersion', 'baseRevision', 'decision', 'reason', 'conflict', 'transform'];
  const extra = body !== null && typeof body === 'object' ? ACKNOWLEDGMENTS.filter((key) => Object.hasOwn(body, key)) : [];
  if (!exactKeys(body, [...keys, ...extra])) throw fail(400, UNREADABLE);
  const { requestId, baseVersion, baseRevision, decision, reason, conflict } = body;
  const valid = isId(requestId) && Number.isInteger(baseVersion) && baseVersion >= 1 && Number.isInteger(baseRevision) && baseRevision >= 1
    && Object.hasOwn(DECISIONS, decision) && plain(reason, COLLABORATION_LIMITS.reason) && CONFLICTS.has(conflict);
  if (!valid) throw fail(400, UNREADABLE);
  const geometry = decision === 'adopt' || decision === 'alternative';
  const transform = body.transform === null ? null : parseTransform(body.transform, twoObjects);
  if (geometry ? !transform : body.transform !== null) throw fail(400, 'The candidate position and turn could not be read.');
  const request = { requestId, baseVersion, baseRevision, decision, reason, conflict, transform };
  for (const key of extra) request[key] = body[key];
  return request;
}

// The bundle payload: writing that may be blank, its grants only when there is
// writing, and the photo's and recording's facts when those files are sent.
// Blank writing is stored as '' with no grants; captions are the provider's
// own listening captions, never a transcript.
function parseBundleSubmit(body, files) {
  if (!exactKeys(body, ['requestId', 'text', 'permissions', 'periodClaim', 'photo', 'voice']) || !isId(body.requestId)) throw fail(400, UNREADABLE);
  if (!plain(body.text, COLLABORATION_LIMITS.text) || !plain(body.periodClaim, COLLABORATION_LIMITS.periodClaim)) throw fail(400, UNREADABLE);
  const writing = body.text.trim() !== '';
  let permissions = null;
  if (writing) {
    const valid = exactKeys(body.permissions, ['place', 'model', 'share']) && ['place', 'model', 'share'].every((key) => typeof body.permissions[key] === 'boolean');
    if (!valid) throw fail(400, UNREADABLE);
    const { place, model, share } = body.permissions;
    permissions = { place, model, share };
  } else if (body.permissions !== null) {
    throw fail(400, UNREADABLE);
  }
  if ((body.photo !== null) !== Boolean(files.photo) || (body.voice !== null) !== Boolean(files.voice)) throw fail(400, UNREADABLE);
  if (!writing && body.voice === null) throw fail(400, 'Add your writing or a recording before sending.');
  const photo = body.photo === null ? null : parsePhotoFacts(body.photo);
  let voice = null;
  if (body.voice !== null) {
    if (!exactKeys(body.voice, ['origin', 'dates', 'permissions', 'captionText', 'captionConfirmed'])) throw fail(400, UNREADABLE);
    const { captionText, captionConfirmed, ...facts } = body.voice;
    if (!plain(captionText, COLLABORATION_LIMITS.captionText) || typeof captionConfirmed !== 'boolean') throw fail(400, UNREADABLE);
    const captioned = captionText.trim() !== '';
    if (captioned !== captionConfirmed) {
      throw fail(400, captioned ? 'Confirm that the captions are your own description of what can be heard.' : UNREADABLE);
    }
    voice = { ...parsePhotoFacts(facts), captionText: captioned ? captionText : '', captionConfirmed };
  }
  return { requestId: body.requestId, text: writing ? body.text : '', permissions, periodClaim: body.periodClaim, photo, voice };
}

// The multipart payload: the existing text submission plus the photo's facts.
function parsePhotoSubmit(body) {
  if (!exactKeys(body, ['requestId', 'text', 'permissions', 'periodClaim', 'photo'])) throw fail(400, UNREADABLE);
  const { photo, ...text } = body;
  return { ...parseSubmit(text), photo: parsePhotoFacts(photo) };
}

function parseWithdraw(body) {
  if (!exactKeys(body, ['requestId']) || !isId(body.requestId)) throw fail(400, UNREADABLE);
  return { requestId: body.requestId };
}

function parseEra(body) {
  const keys = ['requestId', 'baseRevision', 'kind', 'label', 'start', 'end', 'statement', 'relation', 'relativeToVariantId', 'confirmed'];
  if (!exactKeys(body, keys)) throw fail(400, UNREADABLE);
  const { requestId, baseRevision, kind, label, start, end, statement, relation, relativeToVariantId, confirmed } = body;
  const shaped = isId(requestId) && Number.isInteger(baseRevision) && baseRevision >= 0 && ERA_KINDS.has(kind)
    && plain(label, COLLABORATION_LIMITS.eraLabel) && plain(statement, COLLABORATION_LIMITS.eraStatement) && typeof confirmed === 'boolean'
    && (relation === null || RELATIONS.has(relation)) && (relativeToVariantId === null || isId(relativeToVariantId))
    && (start === null || isDate(start)) && (end === null || isDate(end));
  if (!shaped) throw fail(400, UNREADABLE);
  const noDates = start === null && end === null;
  const noRelation = relation === null && relativeToVariantId === null;
  const consistent = {
    unknown: label === '' && noDates && noRelation,
    exact: start !== null && end === start && noRelation,
    range: start !== null && end !== null && start <= end && noRelation,
    relative: label.trim() !== '' && noDates && (relation === null) === (relativeToVariantId === null),
  }[kind];
  // Any dated or related assertion must be an explicit, confirmed owner statement.
  if (!consistent || (kind !== 'unknown' && (statement.trim() === '' || confirmed !== true))) {
    throw fail(400, 'The time assertion is incomplete or inconsistent.');
  }
  return { requestId, baseRevision, kind, label, start, end, statement, relation, relativeToVariantId, confirmed };
}

const digest = (request) => {
  const { requestId, ...values } = request;
  return sha256(JSON.stringify(values));
};


const UNKNOWN_ERA = Object.freeze({
  kind: 'unknown', label: '', start: null, end: null, statement: '', relation: null, relativeToVariantId: null, confirmed: false, assertedBy: null, assertedAt: null,
});

// The owner's review reason and conflict label are private notes: a provider
// sees only the fixed decision, linked variant and timestamps. After withdrawal
// the owner's free-form reason may quote the original, so it is not projected
// either; it stays on disk.
// The providing principal (an owner too) also sees the request ID, for receipt
// lookup after a lost response. Photo source IDs, checksums and names stay private.
function projectContribution(manifest, contribution, principal) {
  const owner = principal.role === 'owner';
  const withdrawn = contribution.withdrawnAt !== null;
  const review = contribution.review && {
    decision: contribution.review.decision,
    ...(owner && { reason: withdrawn ? null : contribution.review.reason, conflict: contribution.review.conflict }),
    reviewedAt: contribution.review.reviewedAt,
    variantId: contribution.review.variantId,
    version: contribution.review.version,
  };
  return {
    id: contribution.id,
    principalId: contribution.principalId,
    provider: { displayName: contribution.provider.displayName },
    kind: 'human_recollection',
    // Withdrawn wording is never projected again, even to the owner.
    text: withdrawn ? null : contribution.text,
    periodClaim: withdrawn ? null : contribution.periodClaim,
    textSha256: contribution.textSha256,
    permissions: contribution.permissions ? { ...contribution.permissions } : null,
    createdAt: contribution.createdAt,
    revision: contribution.revision,
    status: contribution.status,
    review,
    withdrawnAt: contribution.withdrawnAt,
    ...(contribution.principalId === principal.id && { requestId: contribution.requestId }),
    photo: projectPhoto(manifest, contribution),
    voice: projectVoice(manifest, contribution),
  };
}

// The recording without IDs, raw hashes or names. The caption hash is the
// pin an owner sends when choosing it for a shared view.
function projectVoice(manifest, contribution) {
  if (!contribution.voice) return null;
  const { source, playback, captions } = contribution.voice;
  const withdrawn = contribution.withdrawnAt !== null;
  const available = !withdrawn && photoAttested(manifest, contribution);
  return {
    available,
    type: source.type,
    durationMs: playback.durationMs,
    // The listening copy's exact size, for the player's size check; never the original's.
    audio: { type: 'audio/wav', size: playback.size },
    origin: { kind: source.origin.kind, reference: withdrawn ? '' : source.origin.reference },
    dates: withdrawn ? null : { ...source.dates },
    permissions: { ...source.permissions },
    receivedAt: source.receivedAt,
    captions: withdrawn || !captions ? null : { cues: captions.cues.map((cue) => ({ ...cue })), sha256: captions.sha256, authorLabel: captions.author.displayName },
    url: available ? `/api/drafts/${manifest.draftId}/reconstructions/${manifest.id}/contributions/${contribution.id}/recording.wav` : null,
  };
}

function projectPhoto(manifest, contribution) {
  if (!contribution.photo) return null;
  const { source, review } = contribution.photo;
  const withdrawn = contribution.withdrawnAt !== null;
  const available = !withdrawn && photoAttested(manifest, contribution);
  return {
    available,
    type: source.type,
    width: source.width,
    height: source.height,
    review: { width: review.width, height: review.height },
    // Withdrawn free text and dates are never projected again.
    origin: { kind: source.origin.kind, reference: withdrawn ? '' : source.origin.reference },
    dates: withdrawn ? null : { ...source.dates },
    permissions: { ...source.permissions },
    receivedAt: source.receivedAt,
    url: available ? `/api/drafts/${manifest.draftId}/reconstructions/${manifest.id}/contributions/${contribution.id}/photo` : null,
  };
}

// A blocked variant's era text and dates may repeat a withdrawn recollection,
// so only the structure of the assertion is projected; the record stays on disk.
function projectEra(variant, blocked) {
  const latest = variant.eraAssertions.at(-1);
  if (!latest) return { ...UNKNOWN_ERA };
  const { id, requestId, ...era } = latest;
  return blocked ? { ...era, label: null, start: null, end: null, statement: null } : era;
}

// `sourceBlocked` is true when the scene's photo has no current place use;
// every variant then counts as blocked.
function projectVariant(manifest, variant, sourceBlocked) {
  const blocked = sourceBlocked || dependenciesBlocked(manifest, variant.contributionIds);
  return {
    id: variant.id,
    // The label names the provider; a blocked variant shows a fixed label instead.
    label: blocked ? 'Blocked reconstruction' : variant.label,
    parentVersion: variant.parentVersion,
    edit: { version: variant.edit.version, ...editFields(variant.edit) },
    contributionIds: [...variant.contributionIds],
    createdAt: variant.createdAt,
    createdBy: variant.createdBy,
    era: projectEra(variant, blocked),
    eraRevision: variant.eraRevision,
    blocked,
  };
}

const collaborationOf = (manifest) => manifest.collaboration ?? { revision: 0, contributions: [], variants: [], receipts: [] };

// A new contribution record; the first one also freezes the saved scene as the
// baseline to compare against: its whole current arrangement and rule for a
// two-object scene.
function addContribution(manifest, collaboration, principal, request, now, extra = {}) {
  const contribution = {
    id: extra.id ?? randomUUID(),
    requestId: request.requestId,
    principalId: principal.id,
    provider: { displayName: principal.displayName },
    text: request.text,
    textSha256: request.text === '' ? null : sha256(request.text),
    periodClaim: request.periodClaim,
    permissions: request.permissions,
    createdAt: now,
    revision: 1,
    status: 'submitted',
    review: null,
    reviews: [],
    withdrawnAt: null,
    ...(extra.photo && { photo: extra.photo }),
    ...(extra.voice && { voice: extra.voice }),
  };
  const variants = collaboration.variants.length > 0 ? collaboration.variants : [{
    id: randomUUID(),
    kind: 'baseline',
    label: 'Saved reconstruction',
    parentVersion: manifest.edit.version,
    edit: { version: manifest.edit.version, ...editFields(manifest.edit) },
    contributionIds: currentDependencies(manifest),
    createdAt: now,
    createdBy: null,
    eraAssertions: [],
    eraRevision: 0,
  }];
  return { contribution, collaboration: { ...collaboration, contributions: [...collaboration.contributions, contribution], variants } };
}


// Written recollections, review decisions, immutable alternatives and owner
// time assertions live in the reconstruction manifest, so every change uses the
// reconstruction store's mutex and single atomic manifest write.
export class CollaborationStore {
  // decodePhoto prepares the private inspection JPEG; tests may inject one,
  // which does not change the stored-photo or privacy rules.
  // prepareRecording verifies a recording and makes its listening copy
  // (contribution-recordings.mjs); tests may inject one in the same way.
  constructor({ reconstructions, decodePhoto = null, prepareRecording = null }) {
    this.reconstructions = reconstructions;
    this.decodePhoto = decodePhoto;
    this.prepareRecording = prepareRecording;
    // Photo submissions being prepared, keyed by principal, place, scene and
    // request ID, so an identical retry joins the same work.
    this.inflight = new Map();
  }

  // Scope is checked before any ID, body or existence check.
  #scope(principal, draftId) {
    if (!principal || !isId(principal.id)) throw fail(401, 'Sign in to continue.');
    if (principal.role === 'owner') return;
    if (principal.role !== 'contributor' || !Array.isArray(principal.draftIds) || !principal.draftIds.includes(draftId)) {
      throw fail(403, NOT_ALLOWED);
    }
  }

  #owner(principal, draftId) {
    this.#scope(principal, draftId);
    if (principal.role !== 'owner') throw fail(403, NOT_ALLOWED);
  }

  async #scene(draftId, jobId) {
    const manifest = await this.reconstructions.readManifest(draftId, jobId);
    if (!manifest) throw fail(404, NOT_FOUND);
    return manifest;
  }

  #ready(manifest) {
    if (manifest.status !== 'ready') throw fail(409, 'Only a finished scene can receive contributions.');
  }

  // Returns the receipt for an exact replay, throws for a reused request ID
  // with other values, and returns null for a new request.
  #receipt(collaboration, request, action, principalId, target, requestDigest = digest(request)) {
    const receipt = collaboration.receipts.find((item) => item.requestId === request.requestId);
    if (!receipt) return null;
    if (receipt.action !== action || receipt.principalId !== principalId || receipt.target !== target || receipt.digest !== requestDigest) {
      throw fail(409, REUSED);
    }
    return receipt;
  }

  #save(manifest, collaboration, receipt) {
    const next = { ...collaboration, revision: collaboration.revision + 1, receipts: [...collaboration.receipts, receipt] };
    return { next, write: () => this.reconstructions.update(manifest, { collaboration: next }) };
  }

  async places(principal) {
    if (!principal || !isId(principal.id)) throw fail(401, 'Sign in to continue.');
    await this.reconstructions.recover();
    const draftIds = principal.role === 'owner' ? await this.reconstructions.draftIds()
      : principal.role === 'contributor' && Array.isArray(principal.draftIds) ? principal.draftIds.filter(isId) : [];
    const places = [];
    for (const draftId of draftIds) {
      for (const job of await this.reconstructions.list(draftId)) {
        if (job.status === 'ready') places.push({ draftId, jobId: job.id, label: `Saved place ${draftId.slice(0, 8)}`, version: job.edit.version });
      }
    }
    return places;
  }

  async get(draftId, jobId, principal) {
    this.#scope(principal, draftId);
    await this.reconstructions.recover();
    const manifest = await this.#scene(draftId, jobId);
    this.#ready(manifest);
    const collaboration = collaborationOf(manifest);
    const owner = principal.role === 'owner';
    const uses = await this.reconstructions.sourceUses(draftId, manifest.sourceId);
    const contributionBlocked = usageBlocked(manifest);
    // Contributors' own testimony stays theirs and is projected as before;
    // only spatial use follows the photo's current restrictions.
    return {
      revision: collaboration.revision,
      contributions: collaboration.contributions.filter((item) => owner || item.principalId === principal.id).map((item) => projectContribution(manifest, item, principal)),
      variants: owner ? collaboration.variants.map((item) => projectVariant(manifest, item, !uses.place)) : [],
      blocked: !uses.place || contributionBlocked,
      modelBlocked: !uses.model || modelBlocked(manifest),
      blockedReason: !uses.place ? 'source' : contributionBlocked ? 'contribution' : null,
      currentVersion: manifest.edit.version,
    };
  }

  async submit(draftId, jobId, principal, body) {
    this.#scope(principal, draftId);
    const request = parseSubmit(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const collaboration = collaborationOf(manifest);
      const replay = this.#receipt(collaboration, request, 'submit', principal.id, `${draftId}/${jobId}`);
      if (replay) return projectContribution(manifest, collaboration.contributions.find((item) => item.id === replay.contributionId), principal);
      this.#ready(manifest);
      this.#roomFor(collaboration);
      const added = addContribution(manifest, collaboration, principal, request, new Date().toISOString());
      const { write } = this.#save(manifest, added.collaboration, {
        requestId: request.requestId, action: 'submit', principalId: principal.id, target: `${draftId}/${jobId}`, digest: digest(request), contributionId: added.contribution.id,
      });
      const stored = await write();
      return projectContribution(stored, added.contribution, principal);
    });
  }

  #roomFor(collaboration) {
    if (collaboration.contributions.length >= COLLABORATION_LIMITS.contributions) {
      throw fail(409, 'This scene has reached the number of contributions it can hold.');
    }
  }

  // Writing plus one photo, as one indivisible contribution (the earlier
  // route, kept exactly: its payload, digest and 409 busy answer).
  async submitPhoto(draftId, jobId, principal, form) {
    this.#scope(principal, draftId);
    const request = parsePhotoSubmit(form.body);
    const photoSha256 = createHash('sha256').update(form.bytes).digest('hex');
    return this.#submitMedia(draftId, jobId, principal, request, { photo: form, voice: null }, digest({ ...request, photoSha256 }), [409, PHOTO_BUSY]);
  }

  // Writing (which may be blank), an optional photo and an optional
  // recording, as one indivisible contribution. Busy is 503.
  async submitBundle(draftId, jobId, principal, form) {
    this.#scope(principal, draftId);
    const request = parseBundleSubmit(form.body, form);
    const hash = (file) => (file ? createHash('sha256').update(file.bytes).digest('hex') : null);
    const requestDigest = digest({ ...request, photoSha256: hash(form.photo), voiceSha256: hash(form.voice) });
    return this.#submitMedia(draftId, jobId, principal, request, { photo: form.photo, voice: form.voice }, requestDigest, [503, BUNDLE_BUSY]);
  }

  // The shared pipeline: exact replay and identical in-flight work answer
  // before the busy check; then the files are prepared outside the manifest
  // mutex in the one contribution media slot, photo first, then recording,
  // staged beside the scene and published with the record in one write.
  async #submitMedia(draftId, jobId, principal, request, media, requestDigest, busy) {
    const target = `${draftId}/${jobId}`;
    await this.reconstructions.recover();
    const joined = this.#running(principal, draftId, jobId, request, requestDigest);
    if (joined) return joined;
    const current = await this.#scene(draftId, jobId);
    const replay = this.#receipt(collaborationOf(current), request, 'submit', principal.id, target, requestDigest);
    if (replay) return projectContribution(current, collaborationOf(current).contributions.find((item) => item.id === replay.contributionId), principal);
    // Checked after the read too: work that finished before it was read as a
    // receipt, and work started meanwhile is joined.
    const running = this.#running(principal, draftId, jobId, request, requestDigest);
    if (running) return running;
    if (this.reconstructions.closed) throw fail(503, SHUTTING_DOWN);
    this.#ready(current);
    this.#roomFor(collaborationOf(current));
    if (this.reconstructions.activeContributionMedia) throw fail(...busy);
    const controller = new AbortController();
    const promise = this.#prepareMedia(draftId, jobId, principal, request, media, requestDigest, controller.signal);
    const slot = { controller, done: promise.catch(() => {}) };
    this.reconstructions.activeContributionMedia = slot;
    const key = JSON.stringify([principal.id, draftId, jobId, request.requestId]);
    this.inflight.set(key, { digest: requestDigest, promise });
    slot.done.finally(() => {
      this.inflight.delete(key);
      if (this.reconstructions.activeContributionMedia === slot) this.reconstructions.activeContributionMedia = null;
    });
    return promise;
  }

  // The same principal's identical request in progress is joined; a changed one is refused.
  #running(principal, draftId, jobId, request, requestDigest) {
    const running = this.inflight.get(JSON.stringify([principal.id, draftId, jobId, request.requestId]));
    if (!running) return null;
    if (running.digest !== requestDigest) throw fail(409, REUSED);
    return running.promise;
  }

  async #preparePhotoFiles(original, signal) {
    const decode = this.decodePhoto;
    if (!decode) throw fail(503, PHOTO_PREPARE_FAILED);
    const reviewBytes = await decode({ bytes: original.bytes, signal });
    if (signal.aborted) throw fail(503, SHUTTING_DOWN);
    const reviewInfo = reviewJpegInfo(reviewBytes);
    if (!reviewInfo) throw fail(503, PHOTO_PREPARE_FAILED);
    return { reviewBytes, reviewInfo };
  }

  // One strict decode by the recording preparer verifies the bytes and makes
  // the listening copy; its result must describe exactly the received bytes.
  async #prepareVoiceFiles(original, signal) {
    if (!this.prepareRecording) throw fail(503, 'Recordings cannot be prepared on this computer right now. Nothing was saved.');
    const prepared = await this.prepareRecording({ bytes: original.bytes, signal });
    if (signal.aborted) throw fail(503, SHUTTING_DOWN);
    const originalSha256 = createHash('sha256').update(original.bytes).digest('hex');
    const wavSha256 = Buffer.isBuffer(prepared?.wav) ? createHash('sha256').update(prepared.wav).digest('hex') : null;
    const { playback } = prepared ?? {};
    const consistent = prepared?.original?.sha256 === originalSha256 && prepared.original.size === original.bytes.length
      && prepared.original.type === original.type && prepared.original.extension === original.extension
      && playback?.type === 'audio/wav' && playback.sha256 === wavSha256 && playback.size === prepared.wav.length && playback.parentSha256 === originalSha256
      && Number.isInteger(playback.durationMs) && playback.durationMs >= 0 && playback.durationMs <= 300_000
      && playback.sampleRate === 16_000 && playback.channels === 1 && playback.bitsPerSample === 16;
    if (!consistent) throw fail(503, 'The recording could not be prepared right now. Nothing was saved.');
    return { originalSha256, wav: prepared.wav, playback };
  }

  async #prepareMedia(draftId, jobId, principal, request, media, requestDigest, signal) {
    const photoFiles = media.photo ? await this.#preparePhotoFiles(media.photo, signal) : null;
    const voiceFiles = media.voice ? await this.#prepareVoiceFiles(media.voice, signal) : null;
    const jobDir = this.reconstructions.jobDir(draftId, jobId);
    const parent = contributionsDir(jobDir);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = path.join(parent, `.staging-${request.requestId}-${randomUUID()}`);
    const photoName = media.photo && `original.${media.photo.extension}`;
    const voiceName = media.voice && VOICE_ORIGINAL_NAMES[media.voice.extension];
    if (media.voice && !voiceName) throw fail(503, 'The recording could not be prepared right now. Nothing was saved.');
    let published = false;
    try {
      await mkdir(staging, { mode: 0o700 });
      if (media.photo) {
        await writeFile(path.join(staging, photoName), media.photo.bytes, { mode: 0o600, flag: 'wx' });
        await writeFile(path.join(staging, REVIEW_NAME), photoFiles.reviewBytes, { mode: 0o600, flag: 'wx' });
      }
      if (media.voice) {
        await writeFile(path.join(staging, voiceName), media.voice.bytes, { mode: 0o600, flag: 'wx' });
        await writeFile(path.join(staging, PLAYBACK_NAME), voiceFiles.wav, { mode: 0o600, flag: 'wx' });
      }
      return await this.reconstructions.serialize(async () => {
        if (this.reconstructions.closed || signal.aborted) throw fail(503, SHUTTING_DOWN);
        this.#scope(principal, draftId);
        const manifest = await this.#scene(draftId, jobId);
        const collaboration = collaborationOf(manifest);
        const target = `${draftId}/${jobId}`;
        const replay = this.#receipt(collaboration, request, 'submit', principal.id, target, requestDigest);
        if (replay) return projectContribution(manifest, collaboration.contributions.find((item) => item.id === replay.contributionId), principal);
        this.#ready(manifest);
        this.#roomFor(collaboration);
        if (await this.#sourceBlocked(manifest)) throw fail(409, SOURCE_STOPPED_MESSAGE);
        const id = randomUUID();
        const now = new Date().toISOString();
        const provider = { principalId: principal.id, displayName: principal.displayName };
        let photo = null;
        if (media.photo) {
          const sourceId = randomUUID();
          photo = {
            source: {
              id: sourceId, kind: 'photo', role: 'original', parentSourceId: null, name: photoName,
              sha256: createHash('sha256').update(media.photo.bytes).digest('hex'), size: media.photo.bytes.length, type: media.photo.type,
              width: media.photo.width, height: media.photo.height, provider,
              origin: request.photo.origin, dates: request.photo.dates, permissions: request.photo.permissions, receivedAt: now,
            },
            review: {
              id: randomUUID(), kind: 'photo', role: 'derived', parentSourceId: sourceId, name: REVIEW_NAME,
              sha256: createHash('sha256').update(photoFiles.reviewBytes).digest('hex'), size: photoFiles.reviewBytes.length, type: 'image/jpeg', ...photoFiles.reviewInfo,
            },
          };
        }
        let voice = null;
        if (media.voice) {
          const sourceId = randomUUID();
          const { playback } = voiceFiles;
          const source = {
            id: sourceId, kind: 'voice', role: 'original', parentSourceId: null, name: voiceName,
            sha256: voiceFiles.originalSha256, size: media.voice.bytes.length, type: media.voice.type, provider,
            origin: request.voice.origin, dates: request.voice.dates, permissions: request.voice.permissions, receivedAt: now,
          };
          const derived = {
            id: randomUUID(), kind: 'voice', role: 'derived', parentSourceId: sourceId, name: PLAYBACK_NAME, sha256: playback.sha256, size: playback.size,
            type: 'audio/wav', durationMs: playback.durationMs, sampleRate: playback.sampleRate, channels: playback.channels, bitsPerSample: playback.bitsPerSample,
          };
          // One whole-recording cue in the provider's own words, bound to
          // both the original and the listening copy.
          let captions = null;
          if (request.voice.captionText) {
            const cues = [{ startMs: 0, endMs: playback.durationMs, text: request.voice.captionText }];
            captions = { version: 1, cues, author: provider, confirmed: true, createdAt: now, sha256: captionHash(source, derived, provider.principalId, cues) };
          }
          voice = { source, playback: derived, captions };
        }
        const added = addContribution(manifest, collaboration, principal, request, now, { id, photo, voice });
        const { write } = this.#save(manifest, added.collaboration, {
          requestId: request.requestId, action: 'submit', principalId: principal.id, target, digest: requestDigest, contributionId: id,
        });
        const final = photoDir(jobDir, id);
        await rename(staging, final);
        published = true;
        // Commit boundary: closing during the awaits above refuses here, and
        // nothing is awaited between this check and starting the manifest
        // write. Once that write starts it may finish as committed.
        if (this.reconstructions.closed || signal.aborted) {
          await rm(final, { recursive: true, force: true }).catch(() => {});
          throw fail(503, SHUTTING_DOWN);
        }
        const writing = write();
        try {
          await writing;
        } catch (error) {
          // No manifest record refers to these files, so they are removed.
          await rm(final, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        // The attestation covers only verified records, so the published
        // manifest is read again before projecting the new bundle.
        const stored = await this.#scene(draftId, jobId);
        return projectContribution(stored, stored.collaboration.contributions.find((item) => item.id === id), principal);
      });
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // The listening copy of a contributed recording, for the owner or the
  // providing principal, rehashed against its record in the mutex. The
  // original recording has no route.
  async recording(draftId, jobId, principal, contributionId) {
    this.#scope(principal, draftId);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const contribution = collaborationOf(manifest).contributions.find((item) => item.id === contributionId);
      const visible = contribution && (principal.role === 'owner' || contribution.principalId === principal.id);
      if (!visible || !contribution.voice || contribution.withdrawnAt !== null) throw fail(404, 'This recording could not be found.');
      const bytes = photoAttested(manifest, contribution) ? await readPlayback(this.reconstructions.jobDir(draftId, jobId), contribution) : null;
      if (!bytes) throw fail(409, UNAVAILABLE_RECORDING);
      return { name: PLAYBACK_NAME, type: 'audio/wav', body: bytes };
    });
  }

  // The private inspection JPEG, for the owner or the providing principal,
  // rehashed against its record in the same mutex slot as the checks.
  async photo(draftId, jobId, principal, contributionId) {
    this.#scope(principal, draftId);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const contribution = collaborationOf(manifest).contributions.find((item) => item.id === contributionId);
      const visible = contribution && (principal.role === 'owner' || contribution.principalId === principal.id);
      if (!visible || !contribution.photo || contribution.withdrawnAt !== null) throw fail(404, 'This photo could not be found.');
      const bytes = photoAttested(manifest, contribution)
        ? await readReviewPhoto(this.reconstructions.jobDir(draftId, jobId), contribution)
        : null;
      if (!bytes) throw fail(409, UNAVAILABLE_PHOTO);
      return { name: REVIEW_NAME, type: 'image/jpeg', body: bytes };
    });
  }

  async review(draftId, jobId, principal, contributionId, body) {
    this.#owner(principal, draftId);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const twoObjects = isTwoObject(manifest);
      const request = parseReview(body, twoObjects);
      const collaboration = collaborationOf(manifest);
      const contribution = collaboration.contributions.find((item) => item.id === contributionId);
      if (!contribution) throw fail(404, CONTRIBUTION_NOT_FOUND);
      const replay = this.#receipt(collaboration, request, 'review', principal.id, contributionId);
      if (replay) return this.#reviewResult(manifest, collaboration, contributionId, replay, await this.#sourceBlocked(manifest), principal);
      // An adoption or alternative needs the owner's explicit acknowledgment
      // for each photo or recording in the bundle; nothing else accepts one.
      // It records the owner's statement, not completed viewing or listening.
      const geometry = request.transform !== null;
      const needed = { photoReviewed: geometry && Boolean(contribution.photo), voiceReviewed: geometry && Boolean(contribution.voice) };
      const prompts = { photoReviewed: 'Confirm that you reviewed the contributor photo beside the scene.', voiceReviewed: 'Confirm that you listened to the contributed recording.' };
      for (const key of ACKNOWLEDGMENTS) {
        if (needed[key] ? request[key] !== true : Object.hasOwn(request, key)) throw fail(400, needed[key] ? prompts[key] : UNREADABLE);
      }
      const photoGeometry = needed.photoReviewed;
      if (contribution.withdrawnAt !== null) throw fail(409, 'This contribution was withdrawn by the person who provided it.');
      if (!REVIEWABLE.has(contribution.status)) throw fail(409, 'This contribution already has a final decision.');
      if (request.baseRevision !== contribution.revision) throw fail(409, 'This contribution changed. Reload it before deciding.');

      const now = new Date().toISOString();
      const review = {
        decision: request.decision, reason: request.reason, conflict: request.conflict,
        reviewedBy: principal.id, reviewedAt: now, baseRevision: request.baseRevision, variantId: null, version: null,
        ...(photoGeometry && { photoReviewed: true }),
        ...(needed.voiceReviewed && { voiceReviewed: true }),
      };
      let variant = null;
      let edit = null;
      let editReceipt = null;
      if (request.transform) {
        this.#ready(manifest);
        if (!contributionAllows(contribution, 'place')) throw fail(403, 'This contribution was not shared with permission to change the place.');
        if (!photoAttested(manifest, contribution)) throw fail(409, contribution.voice ? UNAVAILABLE_MATERIAL : UNAVAILABLE_PHOTO);
        await this.reconstructions.permittedPhoto(draftId, manifest.sourceId);
        if (request.baseVersion !== manifest.edit.version) throw fail(409, 'The scene was changed elsewhere. Reload the saved version before deciding.');
        const parent = currentDependencies(manifest);
        assertDependencies(manifest, parent);
        const dependencies = [contribution.id, ...parent.filter((id) => id !== contribution.id)];
        const adopt = request.decision === 'adopt';
        let fields = request.transform;
        if (twoObjects) {
          assertObjectsConfirmed(manifest);
          // Only the named object changes; a contribution can never clear the rule.
          fields = withTarget(arrangementOf(manifest.edit), request.transform.targetId, request.transform);
          assertRelationship(manifest, fields);
        }
        if (adopt) edit = { version: manifest.edit.version + 1, ...fields };
        variant = {
          id: randomUUID(),
          kind: 'candidate',
          label: `${contribution.provider.displayName}'s recollection`,
          parentVersion: manifest.edit.version,
          // An alternative is not a saved main version, so it has no version number.
          edit: { version: adopt ? edit.version : null, ...fields },
          contributionIds: dependencies,
          createdAt: now,
          createdBy: principal.id,
          eraAssertions: [],
          eraRevision: 0,
        };
        review.variantId = variant.id;
        review.version = edit?.version ?? null;
        if (adopt) {
          editReceipt = {
            requestId: request.requestId, kind: 'contribution', contributionId, baseVersion: request.baseVersion, ...edit, dependencies,
            ...(twoObjects && { targetId: request.transform.targetId }),
          };
        }
      }
      const updated = {
        ...contribution, status: DECISIONS[request.decision], revision: contribution.revision + 1, review, reviews: [...contribution.reviews, review],
      };
      const { next } = this.#save(manifest, {
        ...collaboration,
        contributions: collaboration.contributions.map((item) => (item.id === contributionId ? updated : item)),
        variants: variant ? [...collaboration.variants, variant] : collaboration.variants,
      }, { requestId: request.requestId, action: 'review', principalId: principal.id, target: contributionId, digest: digest(request), variantId: variant?.id ?? null });
      // Adoption writes the new version, its receipt, stale proposals and the review in one manifest.
      const stored = edit
        ? await this.reconstructions.saveVersion(manifest, edit, editReceipt, manifest.proposals ?? [], { collaboration: next })
        : await this.reconstructions.update(manifest, { collaboration: next });
      return this.#reviewResult(stored, next, contributionId, next.receipts.at(-1), false, principal);
    });
  }

  async #sourceBlocked(manifest) {
    return !(await this.reconstructions.sourceUses(manifest.draftId, manifest.sourceId)).place;
  }

  #reviewResult(manifest, collaboration, contributionId, receipt, sourceBlocked, principal) {
    const contribution = collaboration.contributions.find((item) => item.id === contributionId);
    const variant = receipt.variantId && collaboration.variants.find((item) => item.id === receipt.variantId);
    const edit = manifest.edits.find((item) => item.requestId === receipt.requestId && item.kind === 'contribution');
    return {
      contribution: projectContribution(manifest, contribution, principal),
      variant: variant ? projectVariant(manifest, variant, sourceBlocked) : null,
      // The adopted geometry is withheld while that version cannot be used.
      edit: edit && !dependencyIssue(manifest, versionDependencies(manifest, edit.version)) ? { version: edit.version, ...editFields(edit) } : null,
    };
  }

  async withdraw(draftId, jobId, principal, contributionId, body) {
    this.#scope(principal, draftId);
    const request = parseWithdraw(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const collaboration = collaborationOf(manifest);
      const contribution = collaboration.contributions.find((item) => item.id === contributionId);
      // A contributor cannot learn whether someone else's contribution exists.
      if (!contribution || (principal.role !== 'owner' && contribution.principalId !== principal.id)) throw fail(404, CONTRIBUTION_NOT_FOUND);
      if (contribution.principalId !== principal.id) throw fail(403, 'Only the person who provided this contribution can withdraw it.');
      if (this.#receipt(collaboration, request, 'withdraw', principal.id, contributionId)) return projectContribution(manifest, contribution, principal);
      if (contribution.withdrawnAt !== null) throw fail(409, 'This contribution was already withdrawn.');
      const withdrawn = {
        ...contribution, status: 'withdrawn', statusBeforeWithdrawal: contribution.status, withdrawnAt: new Date().toISOString(), revision: contribution.revision + 1,
      };
      // Dependent versions and alternatives are blocked by derivation from this record.
      const { next } = this.#save(manifest, {
        ...collaboration, contributions: collaboration.contributions.map((item) => (item.id === contributionId ? withdrawn : item)),
      }, { requestId: request.requestId, action: 'withdraw', principalId: principal.id, target: contributionId, digest: digest(request) });
      // A model proposal not yet answered whose base or the current version
      // depends on this contribution ends in the same write, and the active
      // call is aborted even if an edit already made it stale. Data already
      // sent cannot be recalled, but nothing further is sent or offered.
      const current = currentDependencies(manifest).includes(contributionId);
      const dependsHere = (item) => current || versionDependencies(manifest, item.baseVersion).includes(contributionId);
      const proposals = manifest.proposals ?? [];
      const affected = proposals.filter((item) => ACTIVE_PROPOSAL.has(item.status) && dependsHere(item)).map((item) => item.id);
      const active = proposals.find((item) => item.id === this.reconstructions.activeProposal?.id);
      const now = new Date().toISOString();
      const changes = { collaboration: next };
      if (affected.length > 0) {
        changes.proposals = manifest.proposals.map((item) => (affected.includes(item.id) ? { ...item, status: 'failed', error: BLOCKED_MESSAGE, updatedAt: now } : item));
      }
      const stored = await this.reconstructions.update(manifest, changes);
      if (active && dependsHere(active)) this.reconstructions.activeProposal?.controller.abort();
      return projectContribution(stored, withdrawn, principal);
    });
  }

  async era(draftId, jobId, principal, variantId, body) {
    this.#owner(principal, draftId);
    const request = parseEra(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const collaboration = collaborationOf(manifest);
      const variant = collaboration.variants.find((item) => item.id === variantId);
      if (!variant) throw fail(404, 'This version of the scene could not be found.');
      const sourceBlocked = await this.#sourceBlocked(manifest);
      if (this.#receipt(collaboration, request, 'era', principal.id, variantId)) return projectVariant(manifest, variant, sourceBlocked);
      if (request.baseRevision !== variant.eraRevision) throw fail(409, 'The time for this version changed. Reload it before saving.');
      if (sourceBlocked) throw fail(409, SOURCE_STOPPED_MESSAGE);
      // A time label never makes a withdrawn dependency usable again.
      assertDependencies(manifest, variant.contributionIds);
      if (request.relativeToVariantId !== null) {
        const other = collaboration.variants.find((item) => item.id === request.relativeToVariantId);
        if (!other || other.id === variantId) throw fail(400, 'The other version for this time relation could not be found.');
        assertDependencies(manifest, other.contributionIds);
      }
      const { requestId, baseRevision, ...era } = request;
      const assertion = { id: randomUUID(), requestId, ...era, assertedBy: principal.id, assertedAt: new Date().toISOString() };
      const updated = { ...variant, eraAssertions: [...variant.eraAssertions, assertion], eraRevision: variant.eraRevision + 1 };
      const { next, write } = this.#save(manifest, {
        ...collaboration, variants: collaboration.variants.map((item) => (item.id === variantId ? updated : item)),
      }, { requestId, action: 'era', principalId: principal.id, target: variantId, digest: digest(request) });
      const stored = await write();
      return projectVariant(stored, next.variants.find((item) => item.id === variantId), false);
    });
  }
}
