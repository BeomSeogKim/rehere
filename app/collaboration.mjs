import { createHash, randomUUID } from 'node:crypto';
import { RequestError } from './drafts.mjs';
import { ACTIVE_PROPOSAL } from './memory-proposals.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Plain text: tab, newline and carriage return are the only control characters allowed.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Text limits count UTF-16 code units, as browsers report string length.
export const COLLABORATION_LIMITS = Object.freeze({ text: 10_000, periodClaim: 300, reason: 1000, eraLabel: 300, eraStatement: 2000, contributions: 200 });
const OFFSET_LIMIT = 2;
const DECISIONS = Object.freeze({ reviewing: 'reviewing', adopt: 'adopted', alternative: 'alternative', hold: 'held', reject: 'rejected' });
const CONFLICTS = new Set(['unknown', 'viewpoint', 'time', 'memory', 'recognition']);
const REVIEWABLE = new Set(['submitted', 'reviewing', 'held']);
const ERA_KINDS = new Set(['unknown', 'exact', 'range', 'relative']);
const RELATIONS = new Set(['before', 'after', 'same-time']);

export const BLOCKED_MESSAGE = 'This scene depends on a contribution that was withdrawn. Restore an earlier saved version that does not depend on it.';

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

// Grants apply per purpose to every inherited contribution. Any use needs each
// one present, not withdrawn, and granted for place construction; a hosted model
// use also needs each model grant, because the saved transform itself carries
// the memory. Returns 'withdrawn', 'model' or null.
export function dependencyIssue(manifest, ids, purpose = 'place') {
  const contributions = manifest.collaboration?.contributions ?? [];
  let issue = null;
  for (const id of ids) {
    const contribution = contributions.find((item) => item.id === id);
    if (!contribution || contribution.withdrawnAt !== null || contribution.permissions.place !== true) return 'withdrawn';
    if (purpose === 'model' && contribution.permissions.model !== true) issue = 'model';
  }
  return issue;
}

export const dependenciesBlocked = (manifest, ids) => dependencyIssue(manifest, ids) !== null;
export const usageBlocked = (manifest) => manifest.status === 'ready' && dependenciesBlocked(manifest, currentDependencies(manifest));
export const modelBlocked = (manifest) => manifest.status === 'ready' && dependencyIssue(manifest, currentDependencies(manifest), 'model') !== null;

const SOURCE_STOPPED_MESSAGE = 'The owner stopped using this photo or turned off its place use, so no version of this scene can be changed.';

export const REDACTED_PROPOSAL_MESSAGE = 'This proposal was made from a saved version that depends on a withdrawn contribution, so its content is no longer shown.';

// Every proposal leaving the server goes through this projection. A proposal
// made from a version with a withdrawn dependency carries that memory in its
// message and plan, so only audit metadata is shown and it cannot be previewed
// or applied. The full record stays on disk.
export function projectProposal(manifest, proposal) {
  if (!dependenciesBlocked(manifest, versionDependencies(manifest, proposal.baseVersion))) return proposal;
  return {
    ...proposal, statement: { ...proposal.statement, text: null }, result: null, question: null,
    status: 'stale', error: REDACTED_PROPOSAL_MESSAGE, redacted: true,
  };
}

export const MODEL_BLOCKED_MESSAGE = 'This scene includes a contribution that was not shared for model processing, so the hosted model cannot be used on it. Manual editing is still available.';

// Throws unless the current saved version may be used for `purpose` ('place' or 'model').
export function assertSceneUsable(manifest, purpose) {
  const issue = dependencyIssue(manifest, currentDependencies(manifest), purpose);
  if (issue === 'withdrawn') throw new RequestError(409, BLOCKED_MESSAGE);
  if (issue === 'model') throw new RequestError(403, MODEL_BLOCKED_MESSAGE);
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

function parseTransform(transform) {
  if (!exactKeys(transform, ['offset', 'yaw'])) return null;
  const { offset, yaw } = transform;
  const valid = Array.isArray(offset) && offset.length === 3 && offset.every((value) => finite(value) && Math.abs(value) <= OFFSET_LIMIT)
    && finite(yaw) && yaw >= -Math.PI && yaw <= Math.PI;
  return valid ? { offset: [...offset], yaw } : null;
}

function parseReview(body) {
  if (!exactKeys(body, ['requestId', 'baseVersion', 'baseRevision', 'decision', 'reason', 'conflict', 'transform'])) throw fail(400, UNREADABLE);
  const { requestId, baseVersion, baseRevision, decision, reason, conflict } = body;
  const valid = isId(requestId) && Number.isInteger(baseVersion) && baseVersion >= 1 && Number.isInteger(baseRevision) && baseRevision >= 1
    && Object.hasOwn(DECISIONS, decision) && plain(reason, COLLABORATION_LIMITS.reason) && CONFLICTS.has(conflict);
  if (!valid) throw fail(400, UNREADABLE);
  const geometry = decision === 'adopt' || decision === 'alternative';
  const transform = body.transform === null ? null : parseTransform(body.transform);
  if (geometry ? !transform : body.transform !== null) throw fail(400, 'The candidate position and turn could not be read.');
  return { requestId, baseVersion, baseRevision, decision, reason, conflict, transform };
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
function projectContribution(contribution, owner) {
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
    permissions: { ...contribution.permissions },
    createdAt: contribution.createdAt,
    revision: contribution.revision,
    status: contribution.status,
    review,
    withdrawnAt: contribution.withdrawnAt,
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
    edit: { ...variant.edit, offset: [...variant.edit.offset] },
    contributionIds: [...variant.contributionIds],
    createdAt: variant.createdAt,
    createdBy: variant.createdBy,
    era: projectEra(variant, blocked),
    eraRevision: variant.eraRevision,
    blocked,
  };
}

const collaborationOf = (manifest) => manifest.collaboration ?? { revision: 0, contributions: [], variants: [], receipts: [] };


// Written recollections, review decisions, immutable alternatives and owner
// time assertions live in the reconstruction manifest, so every change uses the
// reconstruction store's mutex and single atomic manifest write.
export class CollaborationStore {
  constructor({ reconstructions }) {
    this.reconstructions = reconstructions;
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
  #receipt(collaboration, request, action, principalId, target) {
    const receipt = collaboration.receipts.find((item) => item.requestId === request.requestId);
    if (!receipt) return null;
    if (receipt.action !== action || receipt.principalId !== principalId || receipt.target !== target || receipt.digest !== digest(request)) {
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
      contributions: collaboration.contributions.filter((item) => owner || item.principalId === principal.id).map((item) => projectContribution(item, owner)),
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
      if (replay) return projectContribution(collaboration.contributions.find((item) => item.id === replay.contributionId), principal.role === 'owner');
      this.#ready(manifest);
      if (collaboration.contributions.length >= COLLABORATION_LIMITS.contributions) {
        throw fail(409, 'This scene has reached the number of contributions it can hold.');
      }
      const now = new Date().toISOString();
      const contribution = {
        id: randomUUID(),
        requestId: request.requestId,
        principalId: principal.id,
        provider: { displayName: principal.displayName },
        text: request.text,
        textSha256: sha256(request.text),
        periodClaim: request.periodClaim,
        permissions: request.permissions,
        createdAt: now,
        revision: 1,
        status: 'submitted',
        review: null,
        reviews: [],
        withdrawnAt: null,
      };
      // The first contribution freezes the saved scene as the baseline to compare against.
      const variants = collaboration.variants.length > 0 ? collaboration.variants : [{
        id: randomUUID(),
        kind: 'baseline',
        label: 'Saved reconstruction',
        parentVersion: manifest.edit.version,
        edit: { version: manifest.edit.version, offset: [...manifest.edit.offset], yaw: manifest.edit.yaw },
        contributionIds: currentDependencies(manifest),
        createdAt: now,
        createdBy: null,
        eraAssertions: [],
        eraRevision: 0,
      }];
      const { write } = this.#save(manifest, { ...collaboration, contributions: [...collaboration.contributions, contribution], variants }, {
        requestId: request.requestId, action: 'submit', principalId: principal.id, target: `${draftId}/${jobId}`, digest: digest(request), contributionId: contribution.id,
      });
      await write();
      return projectContribution(contribution, principal.role === 'owner');
    });
  }

  async review(draftId, jobId, principal, contributionId, body) {
    this.#owner(principal, draftId);
    const request = parseReview(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const collaboration = collaborationOf(manifest);
      const contribution = collaboration.contributions.find((item) => item.id === contributionId);
      if (!contribution) throw fail(404, CONTRIBUTION_NOT_FOUND);
      const replay = this.#receipt(collaboration, request, 'review', principal.id, contributionId);
      if (replay) return this.#reviewResult(manifest, collaboration, contributionId, replay, await this.#sourceBlocked(manifest));
      if (contribution.withdrawnAt !== null) throw fail(409, 'This contribution was withdrawn by the person who provided it.');
      if (!REVIEWABLE.has(contribution.status)) throw fail(409, 'This contribution already has a final decision.');
      if (request.baseRevision !== contribution.revision) throw fail(409, 'This contribution changed. Reload it before deciding.');

      const now = new Date().toISOString();
      const review = {
        decision: request.decision, reason: request.reason, conflict: request.conflict,
        reviewedBy: principal.id, reviewedAt: now, baseRevision: request.baseRevision, variantId: null, version: null,
      };
      let variant = null;
      let edit = null;
      let editReceipt = null;
      if (request.transform) {
        this.#ready(manifest);
        if (contribution.permissions.place !== true) throw fail(403, 'This contribution was not shared with permission to change the place.');
        await this.reconstructions.permittedPhoto(draftId, manifest.sourceId);
        if (request.baseVersion !== manifest.edit.version) throw fail(409, 'The scene was changed elsewhere. Reload the saved version before deciding.');
        const parent = currentDependencies(manifest);
        if (dependenciesBlocked(manifest, parent)) throw fail(409, BLOCKED_MESSAGE);
        const dependencies = [contribution.id, ...parent.filter((id) => id !== contribution.id)];
        const adopt = request.decision === 'adopt';
        if (adopt) edit = { version: manifest.edit.version + 1, ...request.transform };
        variant = {
          id: randomUUID(),
          kind: 'candidate',
          label: `${contribution.provider.displayName}'s recollection`,
          parentVersion: manifest.edit.version,
          // An alternative is not a saved main version, so it has no version number.
          edit: { version: adopt ? edit.version : null, ...request.transform },
          contributionIds: dependencies,
          createdAt: now,
          createdBy: principal.id,
          eraAssertions: [],
          eraRevision: 0,
        };
        review.variantId = variant.id;
        review.version = edit?.version ?? null;
        if (adopt) {
          editReceipt = { requestId: request.requestId, kind: 'contribution', contributionId, baseVersion: request.baseVersion, ...edit, dependencies };
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
      return this.#reviewResult(stored, next, contributionId, next.receipts.at(-1), false);
    });
  }

  async #sourceBlocked(manifest) {
    return !(await this.reconstructions.sourceUses(manifest.draftId, manifest.sourceId)).place;
  }

  #reviewResult(manifest, collaboration, contributionId, receipt, sourceBlocked) {
    const contribution = collaboration.contributions.find((item) => item.id === contributionId);
    const variant = receipt.variantId && collaboration.variants.find((item) => item.id === receipt.variantId);
    const edit = manifest.edits.find((item) => item.requestId === receipt.requestId && item.kind === 'contribution');
    return {
      contribution: projectContribution(contribution, true),
      variant: variant ? projectVariant(manifest, variant, sourceBlocked) : null,
      edit: edit ? { version: edit.version, offset: edit.offset, yaw: edit.yaw } : null,
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
      if (this.#receipt(collaboration, request, 'withdraw', principal.id, contributionId)) return projectContribution(contribution, principal.role === 'owner');
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
      await this.reconstructions.update(manifest, changes);
      if (active && dependsHere(active)) this.reconstructions.activeProposal?.controller.abort();
      return projectContribution(withdrawn, principal.role === 'owner');
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
      if (dependenciesBlocked(manifest, variant.contributionIds)) throw fail(409, BLOCKED_MESSAGE);
      if (request.relativeToVariantId !== null) {
        const other = collaboration.variants.find((item) => item.id === request.relativeToVariantId);
        if (!other || other.id === variantId) throw fail(400, 'The other version for this time relation could not be found.');
        if (dependenciesBlocked(manifest, other.contributionIds)) throw fail(409, BLOCKED_MESSAGE);
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
