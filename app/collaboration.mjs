import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  OBJECT_IDS, arrangementOf, assertObjectsConfirmed, assertRelationship, isTwoObject, withTarget,
} from './arrangements.mjs';
import { RequestError } from './drafts.mjs';
import {
  ACTIVE_PROPOSAL, TARGET_ID, newProposal, parseCancelRequest, parseVariantApplyRequest, parseVariantProposalRequest, staleVariantProposals,
} from './memory-proposals.mjs';
import {
  PHOTO_BUSY, PHOTO_PREPARE_FAILED, PLAYBACK_NAME, REVIEW_NAME, VOICE_ORIGINAL_NAMES, contributionsDir, parsePhotoFacts, photoAttested, photoDir,
  readPlayback, readReviewPhoto, reviewJpegInfo,
} from './contribution-photos.mjs';
import { canonicalPose, copyPose, isComposition } from './public/composition-scene.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Plain text: tab, newline and carriage return are the only control characters allowed.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Text limits count UTF-16 code units, as browsers report string length.
export const COLLABORATION_LIMITS = Object.freeze({ text: 10_000, captionText: 20_000, periodClaim: 300, reason: 1000, eraLabel: 300, eraStatement: 2000, contributions: 200, revisions: 200 });
const OFFSET_LIMIT = 2;
// A message to the provider about one review: at most this many UTF-16 code
// units, and the reviewed object's saved name under the scene's own name rule.
const FEEDBACK_NOTE_LIMIT = 500;
const FOREGROUND_LABEL = 'Selected foreground object';
const objectName = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 80 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
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
const VARIANT_NOT_FOUND = 'This version of the scene could not be found.';
const PROPOSAL_NOT_FOUND = 'This proposal could not be found.';

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

// Deletion of one whole contribution by its provider. Access stops in one
// atomic manifest write that leaves a content-free tombstone and clears every
// linked copy the app tracks; the files are removed afterwards and only then
// is the deletion complete.
const DELETED_DIGEST = 'deleted';
const REMOVED_LABEL = 'Contribution removed';
const DELETED_MESSAGE = 'This contribution was deleted.';

// Only what the provider may see: the deletion state and their own material counts.
function projectTombstone(contribution) {
  const { state, completedAt, inventory } = contribution.deletion;
  return { id: contribution.id, kind: 'human_recollection', status: 'deleted', deletedAt: contribution.deletedAt, deletion: { state, completedAt, inventory: { ...inventory } } };
}

// Whether a frozen share selection refers to a contribution in any way.
export function shareReferences(frozen, id) {
  return Boolean(frozen) && (
    (frozen.views ?? []).some((view) => (view.dependencies ?? []).includes(id))
    || (frozen.quotes ?? []).some((quote) => quote.contributionId === id)
    || (frozen.contributorPhotos ?? []).some((item) => item.contributionId === id)
    || (frozen.recordings ?? []).some((item) => item.contributionId === id));
}

// Everything in the manifest that holds or derives from one contribution.
function deletionScope(manifest, contribution) {
  const { id } = contribution;
  const collaboration = collaborationOf(manifest);
  const variants = collaboration.variants.filter((variant) => variant.contributionIds.includes(id));
  const variantIds = new Set(variants.map((variant) => variant.id));
  const shares = manifest.shares ?? { previews: [], snapshots: [] };
  return {
    variants,
    versions: (manifest.edits ?? []).filter((edit) => (edit.dependencies ?? []).includes(id)).map((edit) => edit.version),
    proposals: (manifest.proposals ?? []).filter((proposal) => (proposalDependencies(manifest, proposal) ?? []).includes(id)),
    stories: (manifest.stories?.items ?? []).filter((story) => (story.context?.dependencies ?? []).includes(id)),
    previews: shares.previews.filter((preview) => shareReferences(preview.frozen, id)),
    snapshots: shares.snapshots.filter((snapshot) => shareReferences(snapshot.frozen, id)),
    receipts: collaboration.receipts.filter((receipt) => receipt.contributionId === id || receipt.target === id || variantIds.has(receipt.target) || variantIds.has(receipt.variantId)),
  };
}

// The provider's own material, and whether it is used: fixed keys only.
function ownInventory(contribution, scope) {
  const voice = contribution.voice;
  const history = Array.isArray(voice?.captionHistory) ? voice.captionHistory.length : 0;
  return {
    writing: contribution.text ? 1 : 0, photo: contribution.photo ? 1 : 0, voice: voice ? 1 : 0, playback: voice ? 1 : 0,
    captionVersions: voice ? (voice.captions ? 1 : 0) + history : 0,
    usedInPlace: scope.versions.length > 0 || scope.variants.some((variant) => variant.kind !== 'baseline'),
    sharedViewsAffected: scope.previews.length + scope.snapshots.length > 0,
  };
}

// The private impact the provider confirms, as a hash: every affected ID,
// revision and membership, sorted. Any relevant change gives another hash.
function impactHash(contribution, scope) {
  const sorted = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  return sha256(JSON.stringify({
    contribution: [contribution.id, contribution.revision, contribution.status, contribution.withdrawnAt, contribution.review?.decision ?? null, contribution.voice?.captions?.sha256 ?? null],
    inventory: ownInventory(contribution, scope),
    variants: sorted(scope.variants.map((variant) => [variant.id, variant.kind, variant.eraRevision, variant.label])),
    versions: [...scope.versions].sort((a, b) => a - b),
    proposals: sorted(scope.proposals.map((proposal) => [proposal.id, proposal.status, proposal.updatedAt])),
    stories: sorted(scope.stories.map((story) => [story.id, story.status])),
    previews: sorted(scope.previews.map((preview) => [preview.id, preview.snapshotId, preview.removedFor ?? null])),
    snapshots: sorted(scope.snapshots.map((snapshot) => [snapshot.id, snapshot.revokedAt, snapshot.removedFor ?? null])),
  }));
}

function parseDeletion(body) {
  const valid = exactKeys(body, ['requestId', 'impactSha256', 'confirmDeletion']) && isId(body.requestId)
    && (body.impactSha256 === null || (typeof body.impactSha256 === 'string' && /^[0-9a-f]{64}$/.test(body.impactSha256)));
  if (!valid) throw fail(400, UNREADABLE);
  if (body.confirmDeletion !== true) throw fail(400, 'Confirm that you want to delete this contribution from Rehere.');
  return { requestId: body.requestId, impactSha256: body.impactSha256 };
}

// Caption versions a recording can have, the first one included.
export const CAPTION_VERSIONS = 20;

// The canonical caption hash: it binds the provider's cues to the exact
// original recording, its listening copy, the caption author and, from
// version 2 on, the version itself, so an earlier text saved again never
// matches an older pin. Only {startMs, endMs, text} of each cue count, in
// that order; version 1 keeps the serialization committed recordings used.
export function captionHash(source, playback, authorId, cues, version = 1) {
  const canonical = cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
  const values = [source.sha256, playback.sha256, authorId, canonical];
  return sha256(JSON.stringify(version === 1 ? values : [...values, version]));
}

// One saved caption version: confirmed, by the bundle's own provider, a
// single whole-recording cue of plain text, and a stored hash that matches
// the hash recomputed under its own version.
function captionVersionValid(contribution, captions, version) {
  const { source, playback } = contribution.voice;
  if (captions === null || typeof captions !== 'object' || captions.confirmed !== true || captions.version !== version) return false;
  if (captions.author?.principalId !== contribution.principalId || !Array.isArray(captions.cues) || captions.cues.length !== 1) return false;
  const [cue] = captions.cues;
  if (!exactKeys(cue, ['startMs', 'endMs', 'text']) || cue.startMs !== 0 || cue.endMs !== playback.durationMs || !nonblank(cue.text, COLLABORATION_LIMITS.captionText)) return false;
  return typeof captions.sha256 === 'string' && captions.sha256 === captionHash(source, playback, contribution.principalId, captions.cues, version);
}

// Earlier caption versions as stored: an absent field means none, and any
// present value that is not an array (null included) is malformed: null.
function captionHistoryOf(voice) {
  if (!Object.hasOwn(voice, 'captionHistory')) return [];
  return Array.isArray(voice.captionHistory) ? voice.captionHistory : null;
}

// True only when the current captions and every earlier version form one
// valid chain: earlier versions exactly 1..N, oldest first, each superseded,
// and the current version N + 1, all bound by recomputed hashes. A stored hash
// is never trusted on its own, and a rolled-back current caption on a newer
// history never counts. Missing history means none (version 1 only).
export function captionsIntact(contribution) {
  const voice = contribution.voice;
  if (!voice?.captions) return false;
  const history = captionHistoryOf(voice);
  if (!history || history.length >= CAPTION_VERSIONS) return false;
  for (const [index, entry] of history.entries()) {
    if (!captionVersionValid(contribution, entry, index + 1) || typeof entry.supersededAt !== 'string') return false;
  }
  return captionVersionValid(contribution, voice.captions, history.length + 1);
}

// The recording's caption record as a whole: intact captions, or none (null
// or a missing field, version 0) with no history at all. Any other value,
// such as false, 0 or '', is malformed rather than "no captions".
function captionChainValid(contribution) {
  const { captions } = contribution.voice;
  if (captions === null || captions === undefined) return captionHistoryOf(contribution.voice)?.length === 0;
  return captionsIntact(contribution);
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
const PUBLIC_ONLY_MESSAGE = 'During development, a model result can be saved only while every photo of the scene is marked as public material.';
const MODEL_STOPPED_MESSAGE = 'Model processing is turned off for a photo in this scene, so this proposal cannot be saved. You can still place the object manually.';

export const REDACTED_PROPOSAL_MESSAGE = 'This proposal was made from a saved version that depends on a withdrawn contribution, so its content is no longer shown.';
const UNAVAILABLE_PROPOSAL_MESSAGE = 'This proposal was made from a saved version that depends on a contributor photo that is not available right now, so its content is not shown.';

// Every proposal leaving the server goes through this projection. A proposal
// made from a version with a withdrawn dependency carries that memory in its
// message and plan, so only audit metadata is shown and it cannot be previewed
// or applied. The full record stays on disk.
// A proposal for a saved alternative also carries, when ready, the whole
// arrangement it would save; that candidate is derived here, never stored.
export function projectProposal(manifest, proposal) {
  const dependencies = proposalDependencies(manifest, proposal);
  const issue = dependencies === null ? 'unavailable' : dependencyIssue(manifest, dependencies);
  if (!issue) return proposal.scope ? { ...proposal, candidate: proposalCandidate(manifest, proposal) } : proposal;
  return {
    ...proposal, statement: { ...proposal.statement, text: null }, result: null, question: null,
    status: 'stale', error: issue === 'unavailable' ? UNAVAILABLE_PROPOSAL_MESSAGE : REDACTED_PROPOSAL_MESSAGE, redacted: true,
    ...(proposal.scope && { candidate: null }),
  };
}

// The contributions a proposal derives from: those of the main version it was
// made for, or those of its parent alternative. A missing parent is null
// (unavailable), never an empty set.
export function proposalDependencies(manifest, proposal) {
  if (!proposal.scope) return versionDependencies(manifest, proposal.baseVersion);
  const parent = collaborationOf(manifest).variants.find((item) => item.id === proposal.scope.parentVariantId);
  return parent ? [...parent.contributionIds] : null;
}

// What a proposal is checked against at every step: the main version and its
// dependencies, or the parent alternative's own arrangement and dependencies
// at its pinned time revision. A missing or unreadable parent is null.
export function proposalBinding(manifest, proposal) {
  if (!proposal.scope) {
    return { dependencies: currentDependencies(manifest), stale: manifest.edit.version !== proposal.baseVersion, arrangement: editFields(manifest.edit) };
  }
  const parent = collaborationOf(manifest).variants.find((item) => item.id === proposal.scope.parentVariantId);
  if (!parent || !REVISABLE_KINDS.has(parent.kind)) return null;
  try {
    return { dependencies: [...parent.contributionIds], stale: parent.eraRevision !== proposal.scope.baseEraRevision, arrangement: parentArrangement(manifest, parent) };
  } catch {
    return null;
  }
}

// The whole arrangement a change to one object gives: only that object moves,
// and a composition keeps the base's exact scale.
export function variantFields(manifest, base, targetId, pose) {
  if (!isTwoObject(manifest)) return { offset: [...pose.offset], yaw: pose.yaw, ...(base.fullObject && { fullObject: structuredClone(base.fullObject) }) };
  if (!isComposition(manifest)) return withTarget(base, targetId, pose);
  return withTarget(base, targetId, { ...copyPose(base.objects.find((item) => item.id === targetId)), ...pose });
}

function proposalCandidate(manifest, proposal) {
  if (proposal.status !== 'ready' || !proposal.result?.transform) return null;
  const binding = proposalBinding(manifest, proposal);
  if (!binding || binding.stale) return null;
  if (binding.arrangement.fullObject && proposal.motion?.status !== 'checked') return null;
  return { version: null, ...variantFields(manifest, binding.arrangement, proposal.targetId, proposal.result.transform) };
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
function parseTransform(transform, twoObjects, composition = false) {
  if (composition) {
    if (!exactKeys(transform, ['targetId', 'pose']) || !OBJECT_IDS.includes(transform.targetId) || !exactKeys(transform.pose, ['position', 'quaternion'])) return null;
    try {
      const { position, quaternion } = canonicalPose({ ...transform.pose, scale: 1 });
      return { targetId: transform.targetId, pose: { position, quaternion } };
    } catch { return null; }
  }
  if (!exactKeys(transform, twoObjects ? ['targetId', 'offset', 'yaw'] : ['offset', 'yaw'])) return null;
  const { offset, yaw } = transform;
  const valid = Array.isArray(offset) && offset.length === 3 && offset.every((value) => finite(value) && Math.abs(value) <= OFFSET_LIMIT)
    && finite(yaw) && yaw >= -Math.PI && yaw <= Math.PI && (!twoObjects || OBJECT_IDS.includes(transform.targetId));
  if (!valid) return null;
  return twoObjects ? { targetId: transform.targetId, offset: [...offset], yaw } : { offset: [...offset], yaw };
}

// The saved edit fields of a scene version, in its own shape.
const editFields = (edit) => (Array.isArray(edit.objects) ? arrangementOf(edit) : { offset: [...edit.offset], yaw: edit.yaw, ...(edit.fullObject && { fullObject: structuredClone(edit.fullObject) }) });

// photoReviewed and voiceReviewed are accepted only as extra keys; whether
// each is required or refused depends on the contribution, checked by the caller.
const ACKNOWLEDGMENTS = ['photoReviewed', 'voiceReviewed'];
function parseReview(body, twoObjects, composition = false) {
  const keys = ['requestId', 'baseVersion', 'baseRevision', 'decision', 'reason', 'conflict', 'transform'];
  const extra = body !== null && typeof body === 'object' ? [...ACKNOWLEDGMENTS, 'feedback'].filter((key) => Object.hasOwn(body, key)) : [];
  if (!exactKeys(body, [...keys, ...extra])) throw fail(400, UNREADABLE);
  const { requestId, baseVersion, baseRevision, decision, reason, conflict } = body;
  const valid = isId(requestId) && Number.isInteger(baseVersion) && baseVersion >= 1 && Number.isInteger(baseRevision) && baseRevision >= 1
    && Object.hasOwn(DECISIONS, decision) && plain(reason, COLLABORATION_LIMITS.reason) && CONFLICTS.has(conflict);
  if (!valid) throw fail(400, UNREADABLE);
  const geometry = decision === 'adopt' || decision === 'alternative';
  const transform = body.transform === null ? null : parseTransform(body.transform, twoObjects, composition);
  if (geometry ? !transform : body.transform !== null) throw fail(400, 'The candidate position and turn could not be read.');
  const request = { requestId, baseVersion, baseRevision, decision, reason, conflict, transform };
  for (const key of extra) request[key] = key === 'feedback' ? parseFeedback(body.feedback, decision) : body[key];
  return request;
}

// What the owner chose to tell the provider: the received note exactly as
// sent, never rewritten, and whether to name the reviewed part. A note that
// is only whitespace says nothing; an empty note needs the part disclosure.
function parseFeedback(feedback, decision) {
  const valid = exactKeys(feedback, ['showTarget', 'note']) && typeof feedback.showTarget === 'boolean' && plain(feedback.note, FEEDBACK_NOTE_LIMIT)
    && (feedback.note === '' ? feedback.showTarget : feedback.note.trim() !== '');
  if (!valid) throw fail(400, UNREADABLE);
  if (feedback.showTarget && decision !== 'adopt' && decision !== 'alternative') {
    throw fail(400, 'Only a decision that uses the recollection in an arrangement can name the part it changed.');
  }
  return { showTarget: feedback.showTarget, note: feedback.note };
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

// A caption addition or correction: the provider's own nonblank listening
// captions, confirmed, against the caption version they started from.
function parseCaptions(body) {
  const valid = exactKeys(body, ['requestId', 'baseCaptionSha256', 'captionText', 'captionConfirmed']) && isId(body.requestId)
    && (body.baseCaptionSha256 === null || (typeof body.baseCaptionSha256 === 'string' && /^[0-9a-f]{64}$/.test(body.baseCaptionSha256)))
    && plain(body.captionText, COLLABORATION_LIMITS.captionText) && typeof body.captionConfirmed === 'boolean';
  if (!valid) throw fail(400, UNREADABLE);
  if (body.captionText.trim() === '') throw fail(400, 'Write the listening captions before saving.');
  if (body.captionConfirmed !== true) throw fail(400, 'Confirm that you wrote these listening captions.');
  return { requestId: body.requestId, baseCaptionSha256: body.baseCaptionSha256, captionText: body.captionText, captionConfirmed: true };
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

const TIME_MODES = new Set(['unknown', 'reconfirm-parent']);
// Saved arrangements an owner revision may start from; any other kind is refused.
const REVISABLE_KINDS = new Set(['baseline', 'candidate', 'revision']);

// An owner revision of one saved arrangement: the same transform shapes as a
// recollection review, so a composition request carries no scale.
function parseRevision(body, twoObjects, composition) {
  const valid = exactKeys(body, ['requestId', 'baseEraRevision', 'transform', 'timeMode', 'confirmed']) && isId(body.requestId)
    && Number.isInteger(body.baseEraRevision) && body.baseEraRevision >= 0 && TIME_MODES.has(body.timeMode);
  if (!valid) throw fail(400, UNREADABLE);
  if (body.confirmed !== true) throw fail(400, 'Confirm that this revision is your own change before saving it.');
  const transform = parseTransform(body.transform, twoObjects, composition);
  if (!transform) throw fail(400, 'The revised position and turn could not be read.');
  return { requestId: body.requestId, baseEraRevision: body.baseEraRevision, transform, timeMode: body.timeMode, confirmed: true };
}

const REVISION_UNREADABLE = 'This saved arrangement could not be read, so it cannot be revised.';
const transformValid = (item) => Array.isArray(item?.offset) && item.offset.length === 3 && item.offset.every((value) => finite(value) && Math.abs(value) <= OFFSET_LIMIT)
  && finite(item.yaw) && Math.abs(item.yaw) <= Math.PI;

// The parent's whole saved arrangement, only when it is exactly the scene's
// own representation; nothing is repaired or defaulted.
function parentArrangement(manifest, variant) {
  const edit = variant?.edit;
  if (!isTwoObject(manifest)) {
    if (!transformValid(edit) || Object.hasOwn(edit, 'objects')) throw fail(409, REVISION_UNREADABLE);
    const retained = manifest.edits.find((item) => item.version === variant.parentVersion)?.fullObject;
    if (Boolean(retained) !== Boolean(edit.fullObject) || (retained && JSON.stringify(retained) !== JSON.stringify(edit.fullObject))) throw fail(409, REVISION_UNREADABLE);
    return { offset: [...edit.offset], yaw: edit.yaw, ...(edit.fullObject && { fullObject: structuredClone(edit.fullObject) }) };
  }
  const composition = isComposition(manifest);
  const shaped = Array.isArray(edit?.objects) && edit.objects.length === OBJECT_IDS.length && edit.objects.every((item, index) => item?.id === OBJECT_IDS[index])
    && composition === (edit.frame === 'owner-composition');
  if (!shaped) throw fail(409, REVISION_UNREADABLE);
  for (const item of edit.objects) {
    if (!composition && !transformValid(item)) throw fail(409, REVISION_UNREADABLE);
    if (composition) {
      try { canonicalPose(item); } catch { throw fail(409, REVISION_UNREADABLE); }
    }
  }
  return arrangementOf(edit);
}

// Arrangements compared by meaning, for this check only: a composition
// quaternion and its negation are the same orientation, and so are the yaw
// endpoints -PI and PI. Stored values are never rewritten.
const sameYaw = (item) => ({ ...item, yaw: item.yaw === -Math.PI ? Math.PI : item.yaw });
export const sameArrangement = (a, b) => {
  const canonical = (fields) => {
    if (isComposition(fields)) return { ...fields, objects: fields.objects.map((item) => ({ id: item.id, ...canonicalPose(item) })) };
    return Array.isArray(fields.objects) ? { ...fields, objects: fields.objects.map(sameYaw) } : sameYaw(fields);
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};


const UNKNOWN_ERA = Object.freeze({
  kind: 'unknown', label: '', start: null, end: null, statement: '', relation: null, relativeToVariantId: null, confirmed: false, assertedBy: null, assertedAt: null,
});

// The object the owner adopted or kept a recollection for, as recorded at
// review time: a known object ID, or null whenever it is not exactly
// established. Only two-object adopt/alternative decisions with a unique,
// consistent candidate association count. A present field that is invalid
// or disagrees is never repaired, and nothing is inferred from transforms,
// labels or wording. An adoption must also agree with its unique retained
// version receipt, which alone identifies the target of a pre-field adoption.
const knownObject = (value) => (OBJECT_IDS.includes(value) ? value : undefined);

export function reviewTarget(manifest, contribution) {
  const review = contribution?.review;
  if (!isTwoObject(manifest) || !review || (review.decision !== 'adopt' && review.decision !== 'alternative')) return null;
  const variants = collaborationOf(manifest).variants.filter((item) => item.id === review.variantId);
  const linked = collaborationOf(manifest).contributions.filter((item) => item.review?.variantId === review.variantId);
  if (typeof review.variantId !== 'string' || variants.length !== 1 || linked.length !== 1) return null;
  const [variant] = variants;
  if (variant.kind !== 'candidate') return null;
  const adopt = review.decision === 'adopt';
  // An adoption made a saved version 2 or later that still exists.
  const current = manifest.edit?.version;
  const validVersion = Number.isInteger(review.version) && review.version >= 2 && Number.isInteger(current) && review.version <= current;
  if (adopt ? !(validVersion && variant.edit?.version === review.version) : (review.version !== null || variant.edit?.version !== null)) return null;
  const found = [];
  for (const record of [review, variant]) {
    if (!Object.hasOwn(record, 'targetId')) continue;
    if (!knownObject(record.targetId)) return null;
    found.push(record.targetId);
  }
  if (adopt) {
    const receipts = (manifest.edits ?? []).filter((item) => item?.kind === 'contribution' && item.contributionId === contribution.id && item.version === review.version);
    if (receipts.length !== 1 || !knownObject(receipts[0].targetId)) return null;
    found.push(receipts[0].targetId);
  }
  return found.length > 0 && found.every((id) => id === found[0]) ? found[0] : null;
}

// A candidate's target only through its unique linked review; a baseline,
// an orphan or a candidate claimed by several reviews has none.
function variantTarget(manifest, variant) {
  if (variant.kind !== 'candidate') return null;
  const linked = collaborationOf(manifest).contributions.filter((item) => item.review?.variantId === variant.id);
  return linked.length === 1 ? reviewTarget(manifest, linked[0]) : null;
}

// The owner's review reason and conflict label are private notes: a provider
// sees the fixed decision, linked variant and timestamps, plus any separate
// feedback the owner explicitly wrote for them (projectFeedback). After withdrawal
// the owner's free-form reason may quote the original, so it is not projected
// either; it stays on disk.
// The providing principal (an owner too) also sees the request ID, for receipt
// lookup after a lost response. Photo source IDs, checksums and names stay private.
// `sourceBlocked` is the scene photo's current place-use state; anything but
// an explicit false hides review feedback.
function projectContribution(manifest, contribution, principal, sourceBlocked) {
  if (contribution.status === 'deleted') return projectTombstone(contribution);
  const owner = principal.role === 'owner';
  const withdrawn = contribution.withdrawnAt !== null;
  const review = contribution.review && {
    decision: contribution.review.decision,
    ...(owner && {
      reason: withdrawn ? null : contribution.review.reason, conflict: contribution.review.conflict, captionBinding: captionBinding(contribution),
      targetId: reviewTarget(manifest, contribution),
    }),
    reviewedAt: contribution.review.reviewedAt,
    variantId: contribution.review.variantId,
    version: contribution.review.version,
    ...(Object.hasOwn(contribution.review, 'feedback') && { feedback: projectFeedback(manifest, contribution, sourceBlocked) }),
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

// Review feedback for the owner and the provider, as a checked copy. It is
// shown only while the scene photo has place use, the provider has not
// withdrawn, their own photo or recording is still available, and a linked
// arrangement's own dependencies (never current main's) are usable for the
// place. A malformed record shows nothing.
function projectFeedback(manifest, contribution, sourceBlocked) {
  const { review } = contribution;
  const { feedback } = review;
  const linked = typeof review.variantId === 'string';
  const shaped = exactKeys(feedback, ['partLabel', 'note']) && plain(feedback.note, FEEDBACK_NOTE_LIMIT)
    && (feedback.partLabel === null ? feedback.note.trim() !== '' : linked && objectName(feedback.partLabel) && (feedback.note === '' || feedback.note.trim() !== ''));
  if (!shaped || sourceBlocked !== false || contribution.withdrawnAt !== null || !photoAttested(manifest, contribution)) return null;
  if (review.variantId !== null) {
    const variant = collaborationOf(manifest).variants.find((item) => item.id === review.variantId);
    if (!variant || dependenciesBlocked(manifest, variant.contributionIds)) return null;
  }
  return { partLabel: feedback.partLabel, note: feedback.note };
}

// The recording without IDs, raw hashes or names. The caption hash is the
// pin an owner sends when choosing it for a shared view.
function projectCaptions(captions) {
  return {
    cues: captions.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), sha256: captions.sha256, authorLabel: captions.author.displayName,
    version: captions.version, createdAt: captions.createdAt,
  };
}

// Whether an owner's geometry review of a recording saw today's captions.
// null: no recording or not a geometry review; 'unknown': a review saved
// before the binding was kept.
function captionBinding(contribution) {
  const review = contribution.review;
  if (!contribution.voice || !review || review.variantId === null) return null;
  if (!Object.hasOwn(review, 'captionSha256')) return 'unknown';
  return review.captionSha256 === (contribution.voice.captions?.sha256 ?? null) ? 'current' : 'changed';
}

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
    captions: withdrawn || !captions ? null : projectCaptions(captions),
    // Earlier versions, newest first, for the owner and the provider only.
    captionHistory: withdrawn ? [] : [...(captionHistoryOf(contribution.voice) ?? [])].reverse().map((entry) => ({ ...projectCaptions(entry), supersededAt: entry.supersededAt })),
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
  parentArrangement(manifest, variant);
  const blocked = sourceBlocked || dependenciesBlocked(manifest, variant.contributionIds);
  // An owner revision takes the ordinal its shares and stories use (shares.mjs
  // savedView); variants are only appended or replaced in place, so it is stable.
  const ordinal = collaborationOf(manifest).variants.filter((item) => item.kind !== 'baseline').findIndex((item) => item.id === variant.id) + 1;
  return {
    id: variant.id,
    // The label names the provider; a blocked variant shows a fixed label instead.
    label: blocked ? 'Blocked reconstruction' : variant.kind === 'revision' ? `Alternative arrangement ${ordinal} · Owner revision` : variant.label,
    parentVersion: variant.parentVersion,
    edit: { version: variant.edit.version, ...editFields(variant.edit) },
    contributionIds: [...variant.contributionIds],
    createdAt: variant.createdAt,
    createdBy: variant.createdBy,
    era: projectEra(variant, blocked),
    eraRevision: variant.eraRevision,
    blocked,
    targetId: variantTarget(manifest, variant),
    // Only owner revisions carry their opaque lineage; it names no words or sources.
    ...(variant.kind === 'revision' && {
      revision: {
        parentVariantId: variant.revision.parentVariantId, targetId: variant.revision.targetId, timeMode: variant.revision.timeMode,
        ...(variant.revision.proposalId && { proposalId: variant.revision.proposalId }),
      },
    }),
  };
}

const collaborationOf = (manifest) => manifest.collaboration ?? { revision: 0, contributions: [], variants: [], receipts: [] };

// Discovery and snapshot validation use the same exact applied-child predicate;
// offering words never grants permission to publish them.
export async function fullObjectMemoryWords(reconstructions, manifest, child) {
  try {
    if (!child?.edit.fullObject || child.kind !== 'revision' || !child.revision.proposalId) return null;
    const collaboration = collaborationOf(manifest), revision = child.revision;
    const parent = collaboration.variants.find((item) => item.id === revision.parentVariantId);
    const proposals = (manifest.proposals ?? []).filter((item) => item.id === revision.proposalId);
    const receipts = collaboration.receipts.filter((item) => item.action === 'proposal-revision' && item.variantId === child.id && item.target === revision.proposalId);
    if (!parent || proposals.length !== 1 || receipts.length !== 1) return null;
    const [proposal] = proposals;
    if (proposal.status !== 'applied' || proposal.appliedVariantId !== child.id
        || proposal.scope?.parentVariantId !== parent.id || proposal.scope.baseEraRevision !== revision.parentEraRevision
        || !['translate', 'rotate'].includes(proposal.result?.action) || proposal.result.sourceId !== manifest.sourceId
        || proposal.result.parentVariantId !== parent.id || proposal.result.baseEraRevision !== revision.parentEraRevision
        || JSON.stringify(variantFields(manifest, parentArrangement(manifest, parent), null, proposal.result.transform)) !== JSON.stringify(parentArrangement(manifest, child))
        || JSON.stringify(child.contributionIds) !== JSON.stringify(parent.contributionIds)) return null;
    if (dependencyIssue(manifest, child.contributionIds) || !child.contributionIds.every((id) => contributionAllows(collaboration.contributions.find((item) => item.id === id), 'share'))) return null;
    const uses = await reconstructions.sceneSourceUses(manifest);
    if (!uses.place || !uses.share) return null;
    const original = await reconstructions.verifiedOriginal(manifest.draftId, manifest.sourceId, 'share');
    if (original.source.origin?.kind !== 'public') return null;
    await reconstructions.assertSceneFiles(manifest);
    await reconstructions.fullObjects.validateBinding(manifest.draftId, manifest.id, child.edit.fullObject);
    const projected = await reconstructions.projectProposal(manifest, proposal), statement = projected.statement;
    if (projected.redacted || statement?.kind !== 'human_memory' || !isId(statement.id) || typeof statement.text !== 'string' || !statement.text.trim() || sha256(statement.text) !== statement.sha256) return null;
    return { proposalId: proposal.id, statementSha256: statement.sha256, text: statement.text, statementId: statement.id,
      editSha256: sha256(JSON.stringify(child.edit)), receiptSha256: sha256(JSON.stringify(receipts[0])) };
  } catch { return null; }
}

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
    if (receipt.action !== action || receipt.principalId !== principalId || receipt.target !== target) throw fail(409, REUSED);
    // A receipt whose content was removed by a deletion keeps only its barrier:
    // the same actor, action and target get the content-free current result,
    // and nothing is ever recreated.
    if (receipt.digest === DELETED_DIGEST) return receipt;
    if (receipt.digest !== requestDigest) throw fail(409, REUSED);
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
      const jobs = (await this.reconstructions.list(draftId)).filter((job) => job.status === 'ready');
      if (jobs.length === 0) continue;
      // Only granted drafts reach here. Their owner-chosen name and context
      // are structured; the label never carries an ID fragment. The scene
      // ordinal is a display-order cue among ready scenes, not an identity,
      // and buildRequestedAt is when the build was requested, not finished.
      const drafts = this.reconstructions.drafts;
      const draft = await drafts.get(draftId).catch(() => null);
      const place = await drafts.place(draftId);
      const base = place.unavailable ? 'Place name unavailable' : place.name ?? 'Unnamed place';
      const ordinals = new Map([...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((job, index) => [job.id, index + 1]));
      for (const job of jobs) {
        const index = Array.isArray(draft?.photos) ? draft.photos.findIndex((photo) => photo?.sourceId === job.sourceId) : -1;
        const sceneOrdinal = ordinals.get(job.id);
        places.push({
          draftId, jobId: job.id, version: job.edit.version,
          label: jobs.length > 1 ? `${base} · scene ${sceneOrdinal}` : base,
          placeName: place.name, nameUnavailable: place.unavailable, draftSavedAt: draft?.createdAt ?? null,
          photoNumber: index >= 0 ? index + 1 : null, buildRequestedAt: job.createdAt, sceneOrdinal, sceneCount: jobs.length,
        });
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
    const uses = await this.reconstructions.sceneSourceUses(manifest);
    const contributionBlocked = usageBlocked(manifest);
    // Contributors' own testimony stays theirs and is projected as before;
    // only spatial use follows the photo's current restrictions.
    return {
      revision: collaboration.revision,
      contributions: collaboration.contributions.filter((item) => owner || item.principalId === principal.id).map((item) => projectContribution(manifest, item, principal, !uses.place)),
      variants: owner ? await Promise.all(collaboration.variants.map(async (item) => {
        if (item.edit.fullObject && uses.place && !dependenciesBlocked(manifest, item.contributionIds)) {
          await this.reconstructions.fullObjects.validateBinding(draftId, jobId, item.edit.fullObject);
        }
        return {
          ...projectVariant(manifest, item, !uses.place),
          ...(item.edit.fullObject && { shareMemoryWords: await fullObjectMemoryWords(this.reconstructions, manifest, item).then((words) => words && ({ proposalId: words.proposalId, statementSha256: words.statementSha256, text: words.text })) }),
        };
      })) : [],
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
      if (replay) return await this.#project(manifest, collaboration.contributions.find((item) => item.id === replay.contributionId), principal);
      this.#ready(manifest);
      this.#roomFor(collaboration);
      const added = addContribution(manifest, collaboration, principal, request, new Date().toISOString());
      const { write } = this.#save(manifest, added.collaboration, {
        requestId: request.requestId, action: 'submit', principalId: principal.id, target: `${draftId}/${jobId}`, digest: digest(request), contributionId: added.contribution.id,
      });
      const stored = await write();
      return await this.#project(stored, added.contribution, principal);
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
    if (replay) return await this.#project(current, collaborationOf(current).contributions.find((item) => item.id === replay.contributionId), principal);
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
    // The place and scene let a place deletion cancel and wait for this work.
    const slot = { draftId, jobId, controller, done: promise.catch(() => {}) };
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
        if (replay) return await this.#project(manifest, collaboration.contributions.find((item) => item.id === replay.contributionId), principal);
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
            captions = { version: 1, cues, author: provider, confirmed: true, createdAt: now, sha256: captionHash(source, derived, provider.principalId, cues, 1) };
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
          // No manifest record refers to these files, so they are removed,
          // unless the place was deleted: its own cleanup removes them.
          if (!(await this.reconstructions.placeDeleted(draftId))) await rm(final, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        // The attestation covers only verified records, so the published
        // manifest is read again before projecting the new bundle.
        const stored = await this.#scene(draftId, jobId);
        return await this.#project(stored, stored.collaboration.contributions.find((item) => item.id === id), principal);
      });
    } finally {
      // A deleted place's residue is left to the deletion's exact cleanup.
      if (!published && !(await this.reconstructions.placeDeleted(draftId))) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Only the contribution's own provider, whatever their role, may change or
  // look up its captions, or delete it. Checked before anything else about it.
  #providerContribution(manifest, principal, contributionId) {
    const contribution = collaborationOf(manifest).contributions.find((item) => item.id === contributionId);
    if (!contribution) throw fail(404, CONTRIBUTION_NOT_FOUND);
    if (contribution.principalId !== principal.id) throw principal.role === 'owner' ? fail(403, NOT_ALLOWED) : fail(404, CONTRIBUTION_NOT_FOUND);
    return contribution;
  }

  // Adds listening captions to a recording, or corrects them, as a new
  // attributed version: the previous one moves unchanged into the history. The
  // recording, writing, grants and saved versions are untouched. An exact
  // replay answers first with the version that request saved.
  async captions(draftId, jobId, principal, contributionId, body) {
    this.#scope(principal, draftId);
    const request = parseCaptions(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const collaboration = collaborationOf(manifest);
      const contribution = this.#providerContribution(manifest, principal, contributionId);
      const replay = this.#receipt(collaboration, request, 'captions', principal.id, contributionId);
      if (replay) return { contribution: await this.#project(manifest, contribution, principal), appliedCaptionVersion: replay.captionVersion };
      if (contribution.withdrawnAt !== null) throw fail(409, 'This contribution was withdrawn, so its captions cannot change.');
      if (!contribution.voice) throw fail(409, 'This contribution has no recording.');
      if (!photoAttested(manifest, contribution) || !captionChainValid(contribution)) throw fail(409, UNAVAILABLE_MATERIAL);
      const { voice } = contribution;
      const current = voice.captions ?? null;
      if (request.baseCaptionSha256 !== (current?.sha256 ?? null)) throw fail(409, 'The captions changed since you started. Reload them before saving.');
      if (current && current.cues[0].text === request.captionText) throw fail(400, 'These captions are the same as the current ones.');
      // The chain check above guarantees an array here.
      const history = captionHistoryOf(voice);
      const saved = history.length + (current ? 1 : 0);
      if (saved >= CAPTION_VERSIONS) throw fail(409, `This recording already has ${CAPTION_VERSIONS} caption versions, the most it can keep.`);
      const version = saved + 1;
      const now = new Date().toISOString();
      const author = { principalId: contribution.principalId, displayName: contribution.provider.displayName };
      const cues = [{ startMs: 0, endMs: voice.playback.durationMs, text: request.captionText }];
      const captions = { version, cues, author, confirmed: true, createdAt: now, sha256: captionHash(voice.source, voice.playback, author.principalId, cues, version) };
      const updated = {
        ...contribution, revision: contribution.revision + 1,
        voice: { ...voice, captions, captionHistory: current ? [...history, { ...current, supersededAt: now }] : history },
      };
      const { write } = this.#save(manifest, {
        ...collaboration, contributions: collaboration.contributions.map((item) => (item.id === contributionId ? updated : item)),
      }, { requestId: request.requestId, action: 'captions', principalId: principal.id, target: contributionId, digest: digest(request), captionVersion: version, captionSha256: captions.sha256 });
      await write();
      // The attestation covers the changed record only after a fresh read.
      const stored = await this.#scene(draftId, jobId);
      return { contribution: await this.#project(stored, collaborationOf(stored).contributions.find((item) => item.id === contributionId), principal), appliedCaptionVersion: version };
    });
  }

  // What deleting a contribution would do, for its provider: only their own
  // material counts and whether it is used, plus a hash binding the full
  // private impact. For a deleted contribution, its deletion state.
  async deletionPreview(draftId, jobId, principal, contributionId) {
    this.#scope(principal, draftId);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const contribution = this.#providerContribution(manifest, principal, contributionId);
      if (contribution.status === 'deleted') {
        return { state: contribution.deletion.state, impact: { ...contribution.deletion.inventory }, impactSha256: null };
      }
      const scope = deletionScope(manifest, contribution);
      return { state: 'present', impact: ownInventory(contribution, scope), impactSha256: impactHash(contribution, scope) };
    });
  }

  // Deletes one whole contribution for its provider. First, under the mutex,
  // one atomic write stops access: a content-free tombstone, every tracked
  // linked copy cleared and a minimal receipt. Only after that write is
  // dependent model work aborted and are the files removed; the deletion is
  // complete only once their absence is verified. A replay, or a cleanup-only
  // request with no impact hash on an existing tombstone, resumes cleanup.
  async delete(draftId, jobId, principal, contributionId, body) {
    this.#scope(principal, draftId);
    const request = parseDeletion(body);
    await this.reconstructions.recover();
    const stopped = await this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const collaboration = collaborationOf(manifest);
      const contribution = this.#providerContribution(manifest, principal, contributionId);
      const replay = collaboration.receipts.find((item) => item.requestId === request.requestId);
      if (replay) {
        if (replay.action !== 'delete' || replay.principalId !== principal.id || replay.target !== contributionId) throw fail(409, REUSED);
        return { aborts: [] };
      }
      if (contribution.status === 'deleted') return { aborts: [] };
      if (request.impactSha256 === null) throw fail(409, 'Review what deleting this contribution removes, then confirm again.');
      const scope = deletionScope(manifest, contribution);
      if (impactHash(contribution, scope) !== request.impactSha256) throw fail(409, 'What deleting this contribution affects has changed. Review it again before confirming.');
      const { changes, aborts } = this.#redaction(manifest, contribution, scope, principal, request);
      await this.reconstructions.update(manifest, changes);
      return { aborts };
    });
    // Access has stopped. Dependent model work ends now, whatever its stored
    // status says; a late result is refused by the existing admission checks.
    // Aborting is best effort and never undoes or blocks the stop or cleanup.
    const active = this.reconstructions.activeProposal;
    if (active && stopped.aborts.includes(active.id)) {
      try {
        active.controller.abort();
      } catch {
        console.error('deletion: stopping dependent model work failed');
      }
    }
    await this.#completeDeletion(draftId, jobId);
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      return { contribution: projectTombstone(this.#providerContribution(manifest, principal, contributionId)) };
    });
  }

  // The one atomic change that stops access and clears linked copies.
  #redaction(manifest, contribution, scope, principal, request) {
    const now = new Date().toISOString();
    const id = contribution.id;
    const collaboration = collaborationOf(manifest);
    const inventory = ownInventory(contribution, scope);
    const review = contribution.review && {
      decision: contribution.review.decision, reviewedBy: contribution.review.reviewedBy, reviewedAt: contribution.review.reviewedAt,
      baseRevision: contribution.review.baseRevision, variantId: contribution.review.variantId, version: contribution.review.version,
    };
    const tombstone = {
      id, requestId: contribution.requestId, principalId: contribution.principalId, provider: { displayName: null },
      text: '', textSha256: null, periodClaim: '', permissions: null, photo: null, voice: null,
      createdAt: contribution.createdAt, revision: contribution.revision + 1, status: 'deleted', review, reviews: [],
      withdrawnAt: contribution.withdrawnAt ?? now, deletedAt: now,
      deletion: {
        state: 'access-stopped', completedAt: null, inventory,
        linked: {
          variants: scope.variants.length, proposals: scope.proposals.length, stories: scope.stories.length,
          shareRecords: scope.previews.length + scope.snapshots.length, receipts: scope.receipts.length,
        },
      },
    };
    const linkedVariants = new Set(scope.variants.map((variant) => variant.id));
    const linkedReceipts = new Set(scope.receipts);
    const scrubEra = (era) => era && { ...era, label: '', statement: '', assertedBy: null };
    const next = {
      ...collaboration,
      contributions: collaboration.contributions.map((item) => (item.id === id ? tombstone : item)),
      variants: collaboration.variants.map((variant) => (linkedVariants.has(variant.id)
        ? { ...variant, label: REMOVED_LABEL, eraAssertions: variant.eraAssertions.map(scrubEra) } : variant)),
      receipts: collaboration.receipts.map((receipt) => {
        if (!linkedReceipts.has(receipt)) return receipt;
        const { captionSha256, ...kept } = receipt;
        return { ...kept, digest: DELETED_DIGEST };
      }),
    };
    const { next: saved } = this.#save(manifest, next, { requestId: request.requestId, action: 'delete', principalId: principal.id, target: id, digest: DELETED_DIGEST });
    const changes = { collaboration: saved };

    // Proposals made from a version that depends on it: their statement,
    // result and question may carry the contribution; active ones fail.
    const affected = new Set(scope.proposals.map((proposal) => proposal.id));
    const current = currentDependencies(manifest).includes(id);
    // Every dependent proposal's live model call is stopped, even when its
    // stored status is no longer active; only active ones change status here.
    // A proposal for a saved alternative depends only on its parent, never on main.
    const aborts = (manifest.proposals ?? []).filter((proposal) => (current && !proposal.scope) || affected.has(proposal.id)).map((proposal) => proposal.id);
    const failing = (manifest.proposals ?? []).filter((proposal) => ACTIVE_PROPOSAL.has(proposal.status) && aborts.includes(proposal.id)).map((proposal) => proposal.id);
    if (manifest.proposals) {
      changes.proposals = manifest.proposals.map((proposal) => {
        const active = failing.includes(proposal.id);
        if (!affected.has(proposal.id) && !active) return proposal;
        const cleared = affected.has(proposal.id)
          ? { ...proposal, statement: { ...proposal.statement, text: null, sha256: null }, result: null, question: null } : proposal;
        return active ? { ...cleared, status: 'failed', error: BLOCKED_MESSAGE, updatedAt: now } : cleared;
      });
    }
    // Owner stories keep their own title, recording and captions; only the
    // copied arrangement label and time assertion are cleared.
    if (manifest.stories && scope.stories.length > 0) {
      const stories = new Set(scope.stories.map((story) => story.id));
      changes.stories = {
        ...manifest.stories,
        items: manifest.stories.items.map((story) => (stories.has(story.id)
          ? { ...story, context: { ...story.context, label: REMOVED_LABEL, era: scrubEra(story.context.era) } } : story)),
      };
    }
    // Every share preview or snapshot that refers to it keeps only its opaque
    // barriers and is revoked; its visitor content and frozen pins are removed.
    if (manifest.shares && scope.previews.length + scope.snapshots.length > 0) {
      const previews = new Set(scope.previews.map((item) => item.id));
      const snapshots = new Set(scope.snapshots.map((item) => item.id));
      const removed = (record) => ({ ...record, frozen: null, publicView: null, digest: DELETED_DIGEST, removedFor: 'contribution-deleted' });
      changes.shares = {
        ...manifest.shares,
        previews: manifest.shares.previews.map((preview) => (previews.has(preview.id) ? { ...removed(preview), requestDigest: DELETED_DIGEST } : preview)),
        snapshots: manifest.shares.snapshots.map((snapshot) => (snapshots.has(snapshot.id) ? { ...removed(snapshot), revokedAt: snapshot.revokedAt ?? now } : snapshot)),
      };
    }
    return { changes, aborts };
  }

  // Removes the files of every deletion whose access already stopped, under
  // the mutex so no manifest write is in progress, and records completion only
  // after their absence is verified. Any failure leaves the deletion pending.
  async #completeDeletion(draftId, jobId) {
    await this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      await this.reconstructions.completeDeletions(manifest);
    }).catch(() => {});
  }

  // The outcome of one committed caption request by this provider, with the
  // contribution as it is now (redacted after withdrawal). Unknown is 404,
  // which does not prove the request will never arrive.
  async captionRequest(draftId, jobId, principal, contributionId, requestId) {
    this.#scope(principal, draftId);
    if (!isId(requestId)) throw fail(404, 'This caption change could not be found.');
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const contribution = this.#providerContribution(manifest, principal, contributionId);
      const receipt = collaborationOf(manifest).receipts.find((item) => item.requestId === requestId && item.action === 'captions'
        && item.principalId === principal.id && item.target === contributionId);
      if (!receipt) throw fail(404, 'This caption change could not be found.');
      return { contribution: await this.#project(manifest, contribution, principal), appliedCaptionVersion: receipt.captionVersion };
    });
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
      const request = parseReview(body, twoObjects, isComposition(manifest));
      if (isComposition(manifest)) await this.reconstructions.assertSceneSources(manifest);
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
      // New feedback is saved only where the provider could see it now.
      let feedback = null;
      if (request.feedback) {
        if (await this.#sourceBlocked(manifest)) throw fail(409, SOURCE_STOPPED_MESSAGE);
        if (!photoAttested(manifest, contribution)) throw fail(409, contribution.voice ? UNAVAILABLE_MATERIAL : UNAVAILABLE_PHOTO);
        let partLabel = null;
        if (request.feedback.showTarget) {
          // The reviewed object's saved name now; later renames never change it.
          partLabel = twoObjects ? manifest.objects.find((item) => item.id === request.transform.targetId)?.label : FOREGROUND_LABEL;
          if (!objectName(partLabel)) throw fail(409, 'The name of the reviewed object could not be read, so it cannot be shown to the contributor.');
        }
        feedback = { partLabel, note: request.feedback.note };
      }

      const now = new Date().toISOString();
      const review = {
        decision: request.decision, reason: request.reason, conflict: request.conflict,
        reviewedBy: principal.id, reviewedAt: now, baseRevision: request.baseRevision, variantId: null, version: null,
        ...(photoGeometry && { photoReviewed: true }),
        // The captions the owner had when acknowledging the recording; later
        // additions or corrections show as a changed binding, never as approved.
        ...(needed.voiceReviewed && { voiceReviewed: true, captionSha256: contribution.voice.captions?.sha256 ?? null }),
        ...(feedback && { feedback }),
      };
      let variant = null;
      let edit = null;
      let editReceipt = null;
      if (request.transform) {
        this.#ready(manifest);
        if (!contributionAllows(contribution, 'place')) throw fail(403, 'This contribution was not shared with permission to change the place.');
        if (!photoAttested(manifest, contribution)) throw fail(409, contribution.voice ? UNAVAILABLE_MATERIAL : UNAVAILABLE_PHOTO);
        await this.reconstructions.assertSceneSources(manifest);
        if (request.baseVersion !== manifest.edit.version) throw fail(409, 'The scene was changed elsewhere. Reload the saved version before deciding.');
        const parent = currentDependencies(manifest);
        assertDependencies(manifest, parent);
        const dependencies = [contribution.id, ...parent.filter((id) => id !== contribution.id)];
        const adopt = request.decision === 'adopt';
        let fields = manifest.edit.fullObject ? variantFields(manifest, manifest.edit, null, request.transform) : request.transform;
        if (manifest.edit.fullObject) await this.reconstructions.fullObjects.assertMotion(manifest, fields, manifest.edit);
        if (twoObjects) {
          assertObjectsConfirmed(manifest);
          // Only the named object changes; a contribution can never clear the rule.
          const transform = isComposition(manifest) ? { ...copyPose(manifest.edit.objects.find((item) => item.id === request.transform.targetId)), ...request.transform.pose } : request.transform;
          fields = withTarget(arrangementOf(manifest.edit), request.transform.targetId, transform);
          assertRelationship(manifest, fields);
        }
        if (adopt) edit = { version: manifest.edit.version + 1, ...fields };
        // An adoption is checked when its version is saved; an alternative is
        // never saved as a version, so it is checked here before it is stored.
        else if (twoObjects) await this.reconstructions.assertVisibleArrangement(manifest, fields);
        // The owner's chosen object, kept with the review and its candidate
        // in this same write (the request digest already covers it).
        if (twoObjects) review.targetId = request.transform.targetId;
        variant = {
          id: randomUUID(),
          kind: 'candidate',
          label: `${contribution.provider.displayName}'s recollection`,
          ...(twoObjects && { targetId: request.transform.targetId }),
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
    return !(await this.reconstructions.sceneSourceUses(manifest)).place;
  }

  // Projects one contribution. Source settings are read only for a review
  // that carries feedback, so other projections never depend on them; a
  // lookup that fails only hides that feedback.
  async #project(manifest, contribution, principal) {
    let sourceBlocked = true;
    if (contribution?.review && Object.hasOwn(contribution.review, 'feedback')) {
      try {
        sourceBlocked = await this.#sourceBlocked(manifest);
      } catch {
        sourceBlocked = true;
      }
    }
    return projectContribution(manifest, contribution, principal, sourceBlocked);
  }

  #reviewResult(manifest, collaboration, contributionId, receipt, sourceBlocked, principal) {
    const contribution = collaboration.contributions.find((item) => item.id === contributionId);
    const variant = receipt.variantId && collaboration.variants.find((item) => item.id === receipt.variantId);
    const edit = manifest.edits.find((item) => item.requestId === receipt.requestId && item.kind === 'contribution');
    return {
      contribution: projectContribution(manifest, contribution, principal, sourceBlocked),
      variant: variant ? projectVariant(manifest, variant, sourceBlocked) : null,
      // The adopted geometry is withheld while that version cannot be used.
      edit: edit && !sourceBlocked && !dependencyIssue(manifest, versionDependencies(manifest, edit.version)) ? { version: edit.version, ...editFields(edit) } : null,
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
      if (this.#receipt(collaboration, request, 'withdraw', principal.id, contributionId)) return await this.#project(manifest, contribution, principal);
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
      // A proposal for a saved alternative depends only on its parent, never on main.
      const dependsHere = (item) => (item.scope ? (proposalDependencies(manifest, item) ?? []).includes(contributionId)
        : current || versionDependencies(manifest, item.baseVersion).includes(contributionId));
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
      return await this.#project(stored, withdrawn, principal);
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
      if (variant.edit.fullObject) await this.#revisable(manifest, variant);
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
      const { next } = this.#save(manifest, {
        ...collaboration, variants: collaboration.variants.map((item) => (item.id === variantId ? updated : item)),
      }, { requestId, action: 'era', principalId: principal.id, target: variantId, digest: digest(request) });
      // Open proposals for this arrangement were asked about its earlier time;
      // they become stale in the same write and are never sent or saved.
      const proposals = manifest.proposals ?? [];
      const staled = staleVariantProposals(proposals, variantId, assertion.assertedAt);
      const changed = staled.some((item, index) => item !== proposals[index]);
      const stored = await this.reconstructions.update(manifest, { collaboration: next, ...(changed && { proposals: staled }) });
      return projectVariant(stored, next.variants.find((item) => item.id === variantId), false);
    });
  }

  // Callers hold the mutex. Everything a revision derives from must be usable
  // now: the finished, confirmed scene, current place use and the exact bytes
  // of every original photo and derived file, and every contribution the
  // arrangement inherits. Model permission is never needed.
  async #revisable(manifest, variant) {
    if (!REVISABLE_KINDS.has(variant.kind)) throw fail(409, REVISION_UNREADABLE);
    this.#ready(manifest);
    assertObjectsConfirmed(manifest);
    if (await this.#sourceBlocked(manifest)) throw fail(409, SOURCE_STOPPED_MESSAGE);
    await this.reconstructions.assertSceneFiles(manifest);
    if (variant.edit.fullObject) await this.reconstructions.fullObjects.validateBinding(manifest.draftId, manifest.id, variant.edit.fullObject);
    assertDependencies(manifest, variant.contributionIds);
  }

  async baseline(draftId, jobId, principal, body) {
    this.#owner(principal, draftId);
    if (!exactKeys(body, ['requestId', 'baseVersion']) || !isId(body.requestId) || !Number.isInteger(body.baseVersion) || body.baseVersion < 1) throw fail(400, UNREADABLE);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId), collaboration = collaborationOf(manifest);
      const replay = this.#receipt(collaboration, body, 'baseline', principal.id, String(body.baseVersion));
      if (replay) {
        const variant = collaboration.variants.find((item) => item.id === replay.variantId && item.kind === 'baseline');
        if (!variant) throw fail(409, REVISION_UNREADABLE);
        await this.#revisable(manifest, variant);
        return { created: false, variant: projectVariant(manifest, variant, false) };
      }
      if (!manifest.edit?.fullObject || manifest.edit.version !== body.baseVersion) throw fail(409, 'Reload the accepted full-object version before saving a comparison.');
      const existing = collaboration.variants.find((item) => item.kind === 'baseline' && item.parentVersion === body.baseVersion && sameArrangement(editFields(item.edit), editFields(manifest.edit)));
      if (!existing) this.#revisionCapacity(collaboration);
      const variant = existing ?? {
        id: randomUUID(), kind: 'baseline', label: 'Saved reconstruction', parentVersion: body.baseVersion,
        edit: { version: body.baseVersion, ...editFields(manifest.edit) }, contributionIds: currentDependencies(manifest),
        createdAt: new Date().toISOString(), createdBy: principal.id, eraAssertions: [], eraRevision: 0,
      };
      await this.#revisable(manifest, variant);
      await this.#save(manifest, { ...collaboration, variants: existing ? collaboration.variants : [...collaboration.variants, variant] }, {
        requestId: body.requestId, action: 'baseline', principalId: principal.id, target: String(body.baseVersion), digest: digest(body), variantId: variant.id,
      }).write();
      return { created: !existing, variant: projectVariant(manifest, variant, false) };
    });
  }

  // What an owner revision would start from, checked as a save would be.
  async revisionContext(draftId, jobId, principal, parentId) {
    this.#owner(principal, draftId);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const parent = collaborationOf(manifest).variants.find((item) => item.id === parentId);
      if (!parent) throw fail(404, VARIANT_NOT_FOUND);
      await this.#revisable(manifest, parent);
      return {
        parentVariantId: parent.id, eraRevision: parent.eraRevision, latestEra: projectEra(parent, false),
        edit: { version: parent.edit.version, ...parentArrangement(manifest, parent) }, contributionIds: [...parent.contributionIds], revisionAllowed: true,
        ...(parent.edit.fullObject && { motion: await this.reconstructions.fullObjects.motion(manifest, parent.edit), capabilities: { actions: ['translate', 'rotate', 'clarify'], front: 'unknown' } }),
      };
    });
  }

  // Saves the owner's change to one object of a saved arrangement as a new
  // immutable child. It starts from the parent's whole arrangement, keeps its
  // contribution dependencies in order and never touches the main version,
  // the parent or its time assertions. The child's time is unknown, or a new
  // owner confirmation of the parent's latest assertion; never inherited.
  async revision(draftId, jobId, principal, parentId, body) {
    this.#owner(principal, draftId);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const request = parseRevision(body, isTwoObject(manifest), isComposition(manifest));
      const collaboration = collaborationOf(manifest);
      const replay = this.#receipt(collaboration, request, 'revision', principal.id, parentId);
      if (replay) {
        const child = collaboration.variants.find((item) => item.id === replay.variantId && item.kind === 'revision');
        if (!child) throw fail(409, REVISION_UNREADABLE);
        await this.#revisable(manifest, child);
        return { created: false, variant: projectVariant(manifest, child, false) };
      }
      const parent = collaboration.variants.find((item) => item.id === parentId);
      if (!parent) throw fail(404, VARIANT_NOT_FOUND);
      await this.#revisable(manifest, parent);
      if (request.baseEraRevision !== parent.eraRevision) throw fail(409, 'The time for this arrangement changed. Review it again before saving the revision.');
      const child = await this.#revisionChild(manifest, collaboration, parent, {
        requestId: request.requestId, targetId: request.transform.targetId ?? null,
        pose: isComposition(manifest) ? request.transform.pose : request.transform, timeMode: request.timeMode,
      }, principal);
      const { write } = this.#save(manifest, { ...collaboration, variants: [...collaboration.variants, child] }, {
        requestId: request.requestId, action: 'revision', principalId: principal.id, target: parentId, digest: digest(request), variantId: child.id,
      });
      if (this.reconstructions.closed) throw fail(503, SHUTTING_DOWN);
      const stored = await write();
      return { created: true, variant: projectVariant(stored, child, false) };
    });
  }

  #revisionCapacity(collaboration) {
    if (collaboration.variants.filter((item) => item.kind === 'revision').length >= COLLABORATION_LIMITS.revisions) {
      throw fail(409, `This scene already holds ${COLLABORATION_LIMITS.revisions} owner revisions, the most it can keep. Nothing was saved.`);
    }
  }

  // The parent's latest time, when it can be confirmed again exactly: a
  // relation is kept or the confirmation is refused; it is never dropped.
  #reconfirmable(manifest, collaboration, parent) {
    const latest = parent.eraAssertions.at(-1);
    if (!latest || latest.kind === 'unknown') throw fail(400, 'The selected arrangement has no confirmed time to confirm again. Keep the time unknown instead.');
    if (latest.relativeToVariantId !== null) {
      const other = collaboration.variants.find((item) => item.id === latest.relativeToVariantId);
      if (!other || dependenciesBlocked(manifest, other.contributionIds)) {
        throw fail(409, 'The arrangement this time is relative to is not available now, so the time cannot be confirmed again. Keep the time unknown instead.');
      }
    }
    return latest;
  }

  // Callers hold the mutex and have checked the parent and its time revision.
  // The immutable child changes one object of the parent's whole arrangement,
  // keeps its contribution dependencies in order and must pass the parent's
  // rule and the actual named surfaces. Its time is unknown, or a new owner
  // confirmation of the parent's latest assertion; never inherited.
  async #revisionChild(manifest, collaboration, parent, { requestId, targetId, pose, timeMode, proposalId = null }, principal) {
    this.#revisionCapacity(collaboration);
    const now = new Date().toISOString();
    const eraAssertions = [];
    if (timeMode === 'reconfirm-parent') {
      const { kind, label, start, end, statement, relation, relativeToVariantId } = this.#reconfirmable(manifest, collaboration, parent);
      eraAssertions.push({ id: randomUUID(), requestId, kind, label, start, end, statement, relation, relativeToVariantId, confirmed: true, assertedBy: principal.id, assertedAt: now });
    }
    const base = parentArrangement(manifest, parent);
    const fields = variantFields(manifest, base, targetId, pose);
    if (sameArrangement(fields, base)) throw fail(409, 'This revision does not change the selected arrangement. Nothing was saved.');
    if (base.fullObject) await this.reconstructions.fullObjects.assertMotion(manifest, fields, base);
    if (isTwoObject(manifest)) {
      assertRelationship(manifest, fields);
      await this.reconstructions.assertVisibleArrangement(manifest, fields);
    }
    return {
      id: randomUUID(),
      kind: 'revision',
      label: 'Owner revision',
      revision: { parentVariantId: parent.id, parentEraRevision: parent.eraRevision, targetId, timeMode, ...(proposalId && { proposalId }) },
      parentVersion: parent.parentVersion,
      edit: { version: null, ...fields },
      contributionIds: [...parent.contributionIds],
      createdAt: now,
      createdBy: principal.id,
      eraAssertions,
      eraRevision: eraAssertions.length,
    };
  }

  // Asks the model about one object of a selected saved alternative. The
  // proposal is bound to the parent, its time revision and the owner's time
  // choice; main is never read for its pose or its dependencies. An exact
  // replay returns the same proposal before any busy check.
  async createVariantProposal(draftId, jobId, principal, parentId, body) {
    this.#owner(principal, draftId);
    await this.reconstructions.recover();
    const accepted = await this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const twoObjects = isTwoObject(manifest);
      const request = parseVariantProposalRequest(body, twoObjects ? OBJECT_IDS : [TARGET_ID]);
      const proposals = manifest.proposals ?? [];
      const existing = proposals.find((item) => item.requestId === request.requestId);
      if (existing) {
        const same = existing.scope?.parentVariantId === parentId && existing.scope.baseEraRevision === request.baseEraRevision
          && existing.scope.timeMode === request.timeMode && existing.targetId === request.targetId && existing.statement.text === request.text;
        if (!same) throw fail(409, 'This proposal request was already used with a different message, arrangement or time.');
        return { replay: true, proposal: existing };
      }
      const collaboration = collaborationOf(manifest);
      const parent = collaboration.variants.find((item) => item.id === parentId);
      if (!parent) throw fail(404, VARIANT_NOT_FOUND);
      await this.#revisable(manifest, parent);
      if (request.baseEraRevision !== parent.eraRevision) throw fail(409, 'The time for this arrangement changed. Review it again before asking for a proposal.');
      // Nothing is sent for a proposal that could never be saved.
      this.#revisionCapacity(collaboration);
      if (request.timeMode === 'reconfirm-parent') this.#reconfirmable(manifest, collaboration, parent);
      const base = parentArrangement(manifest, parent);
      if (dependencyIssue(manifest, parent.contributionIds, 'model')) throw fail(403, MODEL_BLOCKED_MESSAGE);
      let original = null;
      let photos = null;
      if (isComposition(manifest)) {
        photos = await this.reconstructions.assertSceneSources(manifest, 'model');
        if (photos.some(({ source }) => source.origin?.kind !== 'public')) throw fail(403, 'Only public photos can be sent to the hosted model.');
      } else {
        original = await this.reconstructions.verifiedOriginal(draftId, manifest.sourceId, 'model');
        if (original.source.origin?.kind !== 'public') throw fail(403, 'During development, only photos marked as public material can be sent to the hosted model.');
      }
      if (!this.reconstructions.proposalModel) throw fail(503, 'Memory-based editing with the hosted model is not set up on this computer.');
      if (this.reconstructions.closed) throw fail(503, SHUTTING_DOWN);
      if (this.reconstructions.activeProposal) throw fail(409, 'Another proposal is being prepared right now. Try again when it finishes.');
      const proposal = newProposal({
        id: randomUUID(), statementId: randomUUID(), now: new Date().toISOString(), requestId: request.requestId, text: request.text, targetId: request.targetId,
        scope: { kind: 'variant', parentVariantId: parent.id, baseEraRevision: parent.eraRevision, timeMode: request.timeMode },
      });
      const dispatch = this.reconstructions.proposalDispatch(manifest, request.targetId, base, { original, photos });
      return { ...(await this.reconstructions.beginProposal(manifest, proposals, proposal, dispatch)), manifest };
    });
    if (accepted.replay) return { created: false, proposal: await this.reconstructions.projectProposal(await this.#scene(draftId, jobId), accepted.proposal) };
    this.reconstructions.launchProposal(draftId, jobId, accepted);
    return { created: true, proposal: await this.reconstructions.projectProposal(accepted.manifest, accepted.proposal) };
  }

  // One saved alternative's own proposals, newest first; never main's.
  async variantProposals(draftId, jobId, principal, parentId) {
    this.#owner(principal, draftId);
    await this.reconstructions.recover();
    const manifest = await this.#scene(draftId, jobId);
    const parent = collaborationOf(manifest).variants.find((item) => item.id === parentId);
    if (!parent) throw fail(404, VARIANT_NOT_FOUND);
    if (parent.edit.fullObject && (await this.reconstructions.sceneSourceUses(manifest)).place && !dependenciesBlocked(manifest, parent.contributionIds)) await this.#revisable(manifest, parent);
    const scoped = (manifest.proposals ?? []).filter((item) => item.scope?.parentVariantId === parentId).reverse();
    return this.reconstructions.projectProposals(manifest, scoped);
  }

  async variantProposal(draftId, jobId, principal, parentId, proposalId) {
    const found = (await this.variantProposals(draftId, jobId, principal, parentId)).find((item) => item.id === proposalId);
    if (!found) throw fail(404, PROPOSAL_NOT_FOUND);
    return found;
  }

  async cancelVariantProposal(draftId, jobId, principal, parentId, proposalId, body) {
    this.#owner(principal, draftId);
    parseCancelRequest(body);
    return this.reconstructions.cancelProposal(draftId, jobId, proposalId, parentId);
  }

  // Saves a ready proposal's stored result as a new immutable child of its
  // parent, in one manifest write with the proposal's applied state and the
  // replay receipt. An exact committed replay needs only the child's current
  // place use, files and dependencies: it resolves a lost response after a
  // later time change or model-off without creating anything.
  async applyVariantProposal(draftId, jobId, principal, parentId, proposalId, body) {
    this.#owner(principal, draftId);
    const request = parseVariantApplyRequest(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const proposals = manifest.proposals ?? [];
      const proposal = proposals.find((item) => item.id === proposalId && item.scope?.parentVariantId === parentId);
      if (!proposal) throw fail(404, PROPOSAL_NOT_FOUND);
      const collaboration = collaborationOf(manifest);
      const replay = this.#receipt(collaboration, request, 'proposal-revision', principal.id, proposalId);
      if (replay) {
        const child = collaboration.variants.find((item) => item.id === replay.variantId && item.kind === 'revision');
        if (!child) throw fail(409, REVISION_UNREADABLE);
        await this.#revisable(manifest, child);
        return { created: false, proposal: await this.reconstructions.projectProposal(manifest, proposal), variant: projectVariant(manifest, child, false) };
      }
      if (proposal.status === 'applied') throw fail(409, 'This proposal was already saved as a new alternative.');
      const parent = collaboration.variants.find((item) => item.id === parentId);
      if (!parent) throw fail(404, VARIANT_NOT_FOUND);
      await this.#revisable(manifest, parent);
      if (proposal.status === 'stale' || (proposal.status === 'ready' && proposal.scope.baseEraRevision !== parent.eraRevision)) {
        throw fail(409, 'The time for this arrangement changed after this proposal was made. Ask for a new proposal.');
      }
      if (proposal.status !== 'ready') throw fail(409, 'Only a ready proposal can be saved.');
      if (parent.edit.fullObject && (!['translate', 'rotate'].includes(proposal.result?.action) || proposal.motion?.status !== 'checked')) throw fail(409, 'This proposal does not have a supported checked movement.');
      if (request.baseEraRevision !== parent.eraRevision) throw fail(409, 'The time for this arrangement changed. Review it again before saving the revision.');
      if (['face_anchor', 'face_object'].includes(proposal.result.action) && request.frontConfirmed !== true) {
        throw fail(409, 'Confirm that the visible side of the object is its front before saving this turn.');
      }
      // Saving a model result is new model use: every scene photo and inherited contribution must still allow it.
      if (!(await this.reconstructions.sceneSourceUses(manifest)).model) throw fail(403, MODEL_STOPPED_MESSAGE);
      if (dependencyIssue(manifest, parent.contributionIds, 'model')) throw fail(403, MODEL_BLOCKED_MESSAGE);
      // Every stored scene photo must still be recorded as public material.
      const photos = await this.reconstructions.assertSceneSources(manifest, 'model');
      if (photos.some(({ source }) => source.origin?.kind !== 'public')) throw fail(403, PUBLIC_ONLY_MESSAGE);
      const child = await this.#revisionChild(manifest, collaboration, parent, {
        requestId: request.requestId, targetId: isTwoObject(manifest) ? proposal.targetId : null, pose: proposal.result.transform,
        timeMode: proposal.scope.timeMode, proposalId,
      }, principal);
      const applied = { ...proposal, status: 'applied', appliedVariantId: child.id, updatedAt: child.createdAt };
      const { next } = this.#save(manifest, { ...collaboration, variants: [...collaboration.variants, child] }, {
        requestId: request.requestId, action: 'proposal-revision', principalId: principal.id, target: proposalId, digest: digest(request), variantId: child.id,
      });
      if (this.reconstructions.closed) throw fail(503, SHUTTING_DOWN);
      const stored = await this.reconstructions.update(manifest, { collaboration: next, proposals: proposals.map((item) => (item.id === proposalId ? applied : item)) });
      return { created: true, proposal: await this.reconstructions.projectProposal(stored, applied), variant: projectVariant(stored, child, false) };
    });
  }
}
