import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { OBJECT_IDS, arrangementOf, assertObjectsConfirmed, isTwoObject } from './arrangements.mjs';
import { captionsIntact, contributionAllows, versionDependencies } from './collaboration.mjs';
import { photoAttested, readPlayback, readReviewPhoto } from './contribution-photos.mjs';
import { RequestError } from './drafts.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TOKEN = /^rhv_[A-Za-z0-9_-]{43}$/;
const MINUTE = 60_000;

export const SHARE_LIMITS = Object.freeze({
  title: 120, views: 8, quotes: 20, cameraCoordinate: 50, cameraDistance: [0.5, 8],
  previewMs: 15 * MINUTE, snapshotMs: 7 * 24 * 60 * MINUTE, snapshotsPerScene: 50, stories: 8, contributorPhotos: 20, recordings: 8,
});
const RECORDING_LABEL = 'Contributor recording; human-written listening captions; not verified history.';
const SHA = /^[0-9a-f]{64}$/;
const CONTRIBUTOR_PHOTO_LABEL = 'Photo supplied by a contributor. Not automatically matched; not verified history.';
const EVIDENCE_ASSET = /^([1-9][0-9]?)\.jpg$/;
// Only these derived files are ever served to a preview or a visitor.
export const SHARED_ASSETS = Object.freeze({ 'surface.json': 'application/json', 'texture.jpg': 'image/jpeg' });
const QUOTABLE = new Set(['submitted', 'adopted', 'alternative']);

export const UNAVAILABLE = 'This shared place is not available.';
const REASONS = {
  source: [403, 'The photo is not marked as public material with permission to build and share the place.'],
  grant: [403, 'A contribution used by a selected view or quote was not shared with permission to build and share the place.'],
  withdrawn: [409, 'A contribution used by a selected view or quote was withdrawn.'],
  unavailable: [409, 'A contributed photo or recording used by a selected view, quote or recording is not available for this use right now. Make a new preview later.'],
  era: [409, 'The time assertion for a selected alternative changed. Make a new preview.'],
  changed: [409, 'The saved scene changed after this preview. Make a new preview.'],
  asset: [409, 'The scene files no longer match this preview. Make a new preview.'],
  story: [409, 'A selected recorded story is no longer available. Make a new preview.'],
};

const fail = (status, message) => new RequestError(status, message);
const unavailable = () => fail(404, UNAVAILABLE);
const UNREADABLE = 'The request could not be read.';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isId = (value) => typeof value === 'string' && UUID.test(value);
const plain = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isVisitToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) return false;
  const body = value.slice(4);
  return Buffer.from(body, 'base64url').toString('base64url') === body;
}

const verifier = (token) => sha256(token);
const sameVerifier = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function parseCamera(camera) {
  if (!exactKeys(camera, ['position', 'target'])) return null;
  const vector = (value) => Array.isArray(value) && value.length === 3 && value.every((item) => finite(item) && Math.abs(item) <= SHARE_LIMITS.cameraCoordinate);
  if (!vector(camera.position) || !vector(camera.target)) return null;
  const distance = Math.hypot(...camera.position.map((value, index) => value - camera.target[index]));
  const [min, max] = SHARE_LIMITS.cameraDistance;
  return distance >= min && distance <= max ? { position: [...camera.position], target: [...camera.target] } : null;
}

function parseViews(views) {
  if (!Array.isArray(views) || views.length < 1 || views.length > SHARE_LIMITS.views) return null;
  const parsed = [];
  for (const view of views) {
    if (!exactKeys(view, ['id', 'kind', 'version', 'variantId']) || !isId(view.id)) return null;
    if (view.kind === 'version' && !(Number.isInteger(view.version) && view.version >= 1 && view.variantId === null)) return null;
    if (view.kind === 'variant' && !(view.version === null && isId(view.variantId))) return null;
    if (view.kind !== 'version' && view.kind !== 'variant') return null;
    parsed.push({ id: view.id, kind: view.kind, version: view.version, variantId: view.variantId });
  }
  const unique = (values) => new Set(values).size === values.length;
  const targets = parsed.map((view) => (view.kind === 'version' ? `v${view.version}` : view.variantId));
  return unique(parsed.map((view) => view.id)) && unique(targets) ? parsed : null;
}

const PREVIEW_KEYS = ['requestId', 'title', 'views', 'startViewId', 'camera', 'contributionIds', 'synthetic'];
const uniqueIds = (values, max) => Array.isArray(values) && values.length <= max && values.every(isId) && new Set(values).size === values.length;

// storyIds and evidencePhotoIds are optional so earlier callers keep working;
// absent means none.
function parsePreview(body) {
  const optional = ['storyIds', 'evidencePhotoIds', 'recordings'].filter((key) => body !== null && typeof body === 'object' && Object.hasOwn(body, key));
  if (!exactKeys(body, [...PREVIEW_KEYS, ...optional])) throw fail(400, UNREADABLE);
  const views = parseViews(body.views);
  const camera = parseCamera(body.camera);
  const quotes = body.contributionIds;
  const storyIds = body.storyIds ?? [];
  const evidencePhotoIds = body.evidencePhotoIds ?? [];
  const valid = isId(body.requestId) && plain(body.title, SHARE_LIMITS.title) && body.title.trim() !== '' && views && camera
    && views.some((view) => view.id === body.startViewId) && typeof body.synthetic === 'boolean'
    && uniqueIds(quotes, SHARE_LIMITS.quotes) && uniqueIds(storyIds, SHARE_LIMITS.stories) && uniqueIds(evidencePhotoIds, SHARE_LIMITS.contributorPhotos);
  if (!valid) throw fail(400, UNREADABLE);
  const recordings = parseRecordings(body.recordings ?? [], views);
  return {
    requestId: body.requestId, title: body.title, views, startViewId: body.startViewId, camera, contributionIds: [...quotes], synthetic: body.synthetic, storyIds: [...storyIds],
    evidencePhotoIds: [...evidencePhotoIds], recordings,
  };
}

// Recordings the owner explicitly links to selected views and to the whole
// place or one object. Nothing is selected by default. The scene decides
// which object IDs are valid.
function parseRecordings(recordings, views) {
  if (!Array.isArray(recordings) || recordings.length > SHARE_LIMITS.recordings) throw fail(400, UNREADABLE);
  const viewIds = new Set(views.map((view) => view.id));
  const parsed = recordings.map((item) => {
    const valid = exactKeys(item, ['contributionId', 'viewIds', 'targetId', 'captionSha256']) && isId(item.contributionId)
      && uniqueIds(item.viewIds, SHARE_LIMITS.views) && item.viewIds.length > 0 && item.viewIds.every((id) => viewIds.has(id))
      && typeof item.targetId === 'string' && ['place', 'selected-foreground', ...OBJECT_IDS].includes(item.targetId)
      && typeof item.captionSha256 === 'string' && SHA.test(item.captionSha256);
    if (!valid) throw fail(400, UNREADABLE);
    return { contributionId: item.contributionId, viewIds: [...item.viewIds], targetId: item.targetId, captionSha256: item.captionSha256 };
  });
  if (new Set(parsed.map((item) => item.contributionId)).size !== parsed.length) throw fail(400, UNREADABLE);
  return parsed;
}

function parseIssue(body) {
  if (!exactKeys(body, ['requestId', 'previewId', 'previewDigest', 'token', 'consent'])) throw fail(400, UNREADABLE);
  const { requestId, previewId, previewDigest, token, consent } = body;
  if (!isId(requestId) || !isId(previewId) || typeof previewDigest !== 'string' || !/^[0-9a-f]{64}$/.test(previewDigest) || !isVisitToken(token)) {
    throw fail(400, UNREADABLE);
  }
  if (consent !== true) throw fail(400, 'Confirm that visitors may see the selected reconstruction and your time assertions.');
  return { requestId, previewId, previewDigest, token };
}

function parseRevoke(body) {
  if (!exactKeys(body, ['requestId']) || !isId(body.requestId)) throw fail(400, UNREADABLE);
  return { requestId: body.requestId };
}

// Renderer input only: grid, depth, mask or object regions, camera
// assumptions and image size. Source IDs, checksums, file names and texture
// records are never served. Object boxes are shared because the whole
// permitted texture is.
export function visitorSurface(surface) {
  const { width, height, depth, foreground, assumptions, source } = surface;
  const shape = surface.schema_version === 2
    ? { schema_version: 2, regions: surface.regions, objects: surface.objects.map(({ id, label, box_xyxy: box }) => ({ id, label, box_xyxy: [...box] })) }
    : { foreground };
  return {
    width, height, depth, ...shape,
    assumptions: {
      horizontal_fov_degrees: assumptions.horizontal_fov_degrees, near: assumptions.near, far: assumptions.far,
      max_triangle_depth_span: assumptions.max_triangle_depth_span,
    },
    source: { image_size: [...source.image_size] },
  };
}

function contributionIssue(manifest, contribution) {
  if (!contribution || contribution.withdrawnAt !== null) return 'withdrawn';
  if (!photoAttested(manifest, contribution)) return 'unavailable';
  if (!contributionAllows(contribution, 'place') || !contributionAllows(contribution, 'share')) return 'grant';
  return null;
}

const sharesOf = (manifest) => manifest.shares ?? { previews: [], snapshots: [], receipts: [] };
const contributionsOf = (manifest) => manifest.collaboration?.contributions ?? [];
const variantsOf = (manifest) => manifest.collaboration?.variants ?? [];

// The saved fields of a version or variant in the scene's own shape: one
// transform, or for two objects both transforms and the optional rule.
function editFields(manifest, edit) {
  return isTwoObject(manifest) ? arrangementOf(edit) : { offset: [...edit.offset], yaw: edit.yaw };
}

function initialEdit(manifest) {
  return isTwoObject(manifest)
    ? { objects: OBJECT_IDS.map((id) => ({ id, offset: [0, 0, 0], yaw: 0 })), relationship: null }
    : { offset: [0, 0, 0], yaw: 0 };
}

// The one resolver for a saved arrangement, shared by snapshots and stories:
// an exact retained version or an immutable variant, with its own transforms
// and inherited contribution dependencies. It never rebinds to the latest edit.
export function savedView(manifest, view) {
  if (view.kind === 'version') {
    if (!Number.isInteger(view.version) || view.version < 1 || view.version > manifest.edit.version) return null;
    const edit = view.version === 1 ? initialEdit(manifest) : manifest.edits.find((item) => item.version === view.version);
    if (!edit) return null;
    return {
      edit: editFields(manifest, edit), dependencies: versionDependencies(manifest, view.version), era: null, eraRevision: null,
      label: `Saved version ${view.version}`,
    };
  }
  const variants = variantsOf(manifest);
  const variant = variants.find((item) => item.id === view.variantId);
  if (!variant) return null;
  const label = variant.kind === 'baseline' ? 'Saved reconstruction' : `Alternative arrangement ${variants.filter((item) => item.kind !== 'baseline').indexOf(variant) + 1}`;
  return {
    edit: editFields(manifest, variant.edit), dependencies: [...variant.contributionIds],
    era: variant.eraAssertions.at(-1) ?? null, eraRevision: variant.eraRevision, label,
  };
}

// Visitor-facing content excludes the snapshot ID and time, so the digest
// binds exactly what the owner previewed.
const contentDigest = (publicView) => {
  const { id, createdAt, ...content } = publicView;
  return sha256(JSON.stringify(content));
};

const UNKNOWN_ERA = Object.freeze({ kind: 'unknown', label: '', start: null, end: null, statement: '', assertedByLabel: null, relation: null, relativeToViewId: null });

// Frozen, owner-approved snapshots of one ready reconstruction. Previews,
// snapshots and receipts live in that reconstruction's manifest, so issuing
// and a contribution withdrawal share its mutex and atomic manifest write.
export class ShareStore {
  constructor({ reconstructions, stories, now = Date.now }) {
    this.reconstructions = reconstructions;
    this.stories = stories;
    this.now = now;
  }

  #owner(principal) {
    if (!principal || !isId(principal.id)) throw fail(401, 'Sign in to continue.');
    if (principal.role !== 'owner') throw fail(403, 'This action is not allowed.');
  }

  async #scene(draftId, jobId) {
    const manifest = await this.reconstructions.readManifest(draftId, jobId);
    if (!manifest) throw fail(404, 'This scene could not be found.');
    return manifest;
  }

  // Source grants and restrictions are read every time; no copy is trusted.
  async #sourceIssue(manifest) {
    if (manifest.status !== 'ready') return 'changed';
    const draft = await this.reconstructions.drafts.get(manifest.draftId);
    const source = Array.isArray(draft?.sources) ? draft.sources.find((item) => item.id === manifest.sourceId) : null;
    if (!source || source.sha256 !== manifest.sourceSha256 || source.origin?.kind !== 'public') return 'source';
    // Current owner restrictions: sharing needs place and share uses, not stopped.
    if (!(await this.reconstructions.sourcePolicies.canUse(draft, manifest.sourceId, 'share'))) return 'source';
    return null;
  }

  // Every dependency and quote needs a live record with place and share
  // grants, for its photo too, whether or not that photo is displayed.
  #contributionIssue(manifest, ids) {
    const contributions = contributionsOf(manifest);
    for (const id of ids) {
      const contribution = contributions.find((item) => item.id === id);
      const issue = contributionIssue(manifest, contribution);
      if (issue) return issue;
    }
    return null;
  }

  // Null when the frozen selection may still be shown.
  async #liveIssue(manifest, frozen) {
    const source = await this.#sourceIssue(manifest);
    if (source) return source;
    if (manifest.sourceSha256 !== frozen.sourceSha256) return 'source';
    if (await this.#assetIssue(manifest, frozen.assets)) return 'asset';
    const contributions = contributionsOf(manifest);
    for (const quote of frozen.quotes) {
      const contribution = contributions.find((item) => item.id === quote.contributionId);
      if (!contribution || contribution.withdrawnAt !== null || contribution.textSha256 !== quote.textSha256) return 'withdrawn';
    }
    const ids = [...frozen.views.flatMap((view) => view.dependencies), ...frozen.quotes.map((quote) => quote.contributionId)];
    const grants = this.#contributionIssue(manifest, ids);
    if (grants) return grants;
    // Shown contributor photos: the pinned record and inspection bytes.
    for (const pinned of frozen.contributorPhotos ?? []) {
      const contribution = contributions.find((item) => item.id === pinned.contributionId);
      if (!contribution || contribution.withdrawnAt !== null) return 'withdrawn';
      const photo = contribution.photo;
      if (!photo || photo.source.id !== pinned.sourceId || photo.review.sha256 !== pinned.reviewSha256 || photo.review.size !== pinned.reviewSize) return 'unavailable';
      if (!photoAttested(manifest, contribution)) return 'unavailable';
    }
    // Linked recordings are part of the snapshot's authorization even when no
    // view depends on them.
    for (const pinned of frozen.recordings ?? []) {
      const issue = this.#recordingIssue(manifest, pinned);
      if (issue) return issue;
    }
    for (const view of frozen.views) {
      if (view.kind === 'version' && !savedView(manifest, view)) return 'changed';
      if (view.kind === 'variant') {
        const variant = variantsOf(manifest).find((item) => item.id === view.variantId);
        if (!variant) return 'withdrawn';
        if (variant.eraRevision !== view.eraRevision) return 'era';
      }
    }
    // Selected recorded stories: the story itself, its voice, photo and
    // dependencies under current share rules, and its pinned playback file.
    for (const pinned of frozen.stories ?? []) {
      if (await this.stories.shareIssue(manifest, pinned)) return 'story';
    }
    return null;
  }

  // Each shared file must still match both the manifest record and the frozen
  // checksum byte for byte; a same-size replacement is not the frozen file.
  async #assetIssue(manifest, bindings) {
    for (const [name, binding] of Object.entries(bindings)) {
      const entry = manifest.derivedAssets.find((item) => item.name === name);
      if (!entry || entry.sha256 !== binding.sha256 || entry.size !== binding.size) return 'asset';
      const bytes = await readFile(path.join(this.reconstructions.jobDir(manifest.draftId, manifest.id), 'assets', name)).catch(() => null);
      if (!bytes || bytes.length !== binding.size || sha256(bytes) !== binding.sha256) return 'asset';
    }
    return null;
  }

  #throwReason(reason) {
    const [status, message] = REASONS[reason];
    throw fail(status, message);
  }

  async #build(manifest, request) {
    const reason = await this.#sourceIssue(manifest);
    if (reason) this.#throwReason(reason);
    assertObjectsConfirmed(manifest);
    const draft = await this.reconstructions.drafts.get(manifest.draftId);
    const source = draft.sources.find((item) => item.id === manifest.sourceId);
    const selected = request.views.map((view) => {
      const resolved = savedView(manifest, view);
      if (!resolved) throw fail(404, 'This version of the scene could not be found.');
      return { view, ...resolved };
    });
    const dependencyReason = this.#contributionIssue(manifest, selected.flatMap((item) => item.dependencies));
    if (dependencyReason) this.#throwReason(dependencyReason);

    const contributions = contributionsOf(manifest);
    const quotes = request.contributionIds.map((id) => {
      const contribution = contributions.find((item) => item.id === id);
      if (!contribution) throw fail(404, 'This contribution could not be found.');
      if (contribution.withdrawnAt !== null) this.#throwReason('withdrawn');
      if (!QUOTABLE.has(contribution.status)) throw fail(409, 'Only submitted, adopted or alternative recollections can be quoted.');
      if (contribution.text === '') throw fail(409, 'This contribution has no writing to quote.');
      const issue = contributionIssue(manifest, contribution);
      if (issue) this.#throwReason(issue);
      return contribution;
    });

    // A contributor photo can be shown only beside a selected view that
    // depends on it; a quoted statement alone never makes its photo eligible.
    const frozenPhotos = [];
    const contributorPhotos = request.evidencePhotoIds.map((id, index) => {
      const viewIds = selected.filter((item) => item.dependencies.includes(id)).map((item) => item.view.id);
      const contribution = contributions.find((item) => item.id === id);
      if (viewIds.length === 0 || !contribution?.photo) throw fail(400, 'Only a contributor photo that a selected view depends on can be shown.');
      const { source, review } = contribution.photo;
      const publicId = `e${index + 1}`;
      frozenPhotos.push({ publicId, contributionId: id, sourceId: source.id, reviewSha256: review.sha256, reviewSize: review.size, viewIds });
      return {
        id: publicId, providerLabel: contribution.provider.displayName, label: CONTRIBUTOR_PHOTO_LABEL, viewIds: [...viewIds],
        asset: { viewId: 'evidence', name: `${index + 1}.jpg` }, width: review.width, height: review.height,
      };
    });

    const views = selected.map(({ view, edit, dependencies, era, label }) => {
      let publicEra = { ...UNKNOWN_ERA };
      if (era) {
        let relativeToViewId = null;
        if (era.relativeToVariantId !== null) {
          const target = selected.find((item) => item.view.variantId === era.relativeToVariantId);
          // A relation to an unselected version would disclose it, so both must be shared.
          if (!target) throw fail(400, 'A selected alternative has a time relation to a version that is not selected. Select that version too.');
          relativeToViewId = target.view.id;
        }
        publicEra = {
          kind: era.kind, label: era.label, start: era.start, end: era.end, statement: era.statement,
          assertedByLabel: era.kind === 'unknown' ? null : 'Place owner', relation: era.relation, relativeToViewId,
        };
      }
      // Every supporting recollection is acknowledged without its wording; only
      // the explicitly selected quotes add text.
      const support = dependencies.map((id) => contributions.find((item) => item.id === id))
        .map((item) => ({ kind: 'human_recollection', providerLabel: item.provider.displayName, status: 'owner-selected' }));
      const supporting = quotes.filter((item) => dependencies.includes(item.id));
      const unattached = quotes.filter((item) => !selected.some((other) => other.dependencies.includes(item.id)));
      return {
        id: view.id,
        label,
        edit: structuredClone(edit),
        era: publicEra,
        evidence: {
          photo: { providerLabel: source.provider || null, attributedCaptureDate: source.dates?.capturedOn ?? null },
          geometry: 'model estimate',
          support,
          recollections: [...supporting, ...unattached].map((item) => ({ providerLabel: item.provider.displayName, text: item.text, periodClaim: item.periodClaim })),
        },
      };
    });
    // Each story must belong to exactly one selected view; it is never moved to another arrangement.
    const pinnedStories = [];
    const publicStories = [];
    for (const storyId of request.storyIds) {
      const shared = await this.stories.forShare(manifest, storyId, selected.map(({ view, eraRevision }) => ({ id: view.id, kind: view.kind, version: view.version, variantId: view.variantId, eraRevision })));
      if (!shared) this.#throwReason('story');
      const publicId = randomUUID();
      pinnedStories.push({ publicId, ...shared.pinned });
      publicStories.push({ id: publicId, ...shared.publicStory });
    }
    const { pinned: pinnedRecordings, published: contributorRecordings } = this.#recordings(manifest, request.recordings);
    const publicView = {
      id: null, title: request.title, createdAt: null, synthetic: request.synthetic, startViewId: request.startViewId,
      camera: { position: [...request.camera.position], target: [...request.camera.target] }, views, stories: publicStories,
      ...(contributorPhotos.length > 0 && { contributorPhotos }),
      ...(contributorRecordings.length > 0 && { contributorRecordings }),
      // The owner's names and source boxes for the two objects, as visible evidence.
      ...(isTwoObject(manifest) && { objects: manifest.objects.map(({ id, label, box }) => ({ id, label, box: [...box] })) }),
    };
    const assets = {};
    for (const name of Object.keys(SHARED_ASSETS)) {
      const entry = manifest.derivedAssets.find((item) => item.name === name);
      if (!entry) this.#throwReason('asset');
      assets[name] = { sha256: entry.sha256, size: entry.size };
    }
    if (await this.#assetIssue(manifest, assets)) this.#throwReason('asset');
    const frozen = {
      sourceSha256: manifest.sourceSha256,
      assets,
      views: selected.map(({ view, dependencies, eraRevision }) => ({ id: view.id, kind: view.kind, version: view.version, variantId: view.variantId, dependencies, eraRevision })),
      quotes: quotes.map((item) => ({ contributionId: item.id, textSha256: item.textSha256 })),
      stories: pinnedStories,
      ...(frozenPhotos.length > 0 && { contributorPhotos: frozenPhotos }),
      ...(pinnedRecordings.length > 0 && { recordings: pinnedRecordings }),
    };
    return { publicView, frozen };
  }

  // Recordings the owner linked to selected views as narration about the
  // place or one object. This association never touches view dependencies or
  // geometry evidence, so it never claims the recording informed the scene.
  // Each needs an eligible bundle with the provider's confirmed captions
  // exactly as the owner previewed them.
  #recordings(manifest, requested) {
    const contributions = contributionsOf(manifest);
    const twoObjects = isTwoObject(manifest);
    const targets = twoObjects ? ['place', ...OBJECT_IDS] : ['place', 'selected-foreground'];
    const pinned = [];
    const published = requested.map((item) => {
      const contribution = contributions.find((entry) => entry.id === item.contributionId);
      if (!contribution) throw fail(404, 'This contribution could not be found.');
      if (contribution.withdrawnAt !== null) this.#throwReason('withdrawn');
      if (!QUOTABLE.has(contribution.status)) throw fail(409, 'Only submitted, adopted or alternative recollections can be shared.');
      if (!contribution.voice) throw fail(400, 'This contribution has no recording.');
      const issue = contributionIssue(manifest, contribution);
      if (issue) this.#throwReason(issue);
      const { source, playback, captions } = contribution.voice;
      if (!captions) throw fail(409, 'Only a recording with the contributor’s own captions can be shared with visitors.');
      if (!captionsIntact(contribution)) this.#throwReason('unavailable');
      if (captions.sha256 !== item.captionSha256) throw fail(409, 'The captions of this recording changed. Make a new preview.');
      if (!targets.includes(item.targetId)) throw fail(400, UNREADABLE);
      const objectLabel = twoObjects ? manifest.objects.find((object) => object.id === item.targetId)?.label : 'the selected foreground object';
      const publicId = randomUUID();
      pinned.push({
        publicId, contributionId: contribution.id, viewIds: [...item.viewIds], targetId: item.targetId,
        originalSha256: source.sha256, playbackSha256: playback.sha256, playbackSize: playback.size, captionSha256: captions.sha256, captionVersion: captions.version,
      });
      return {
        id: publicId, viewIds: [...item.viewIds],
        target: { id: item.targetId, label: item.targetId === 'place' ? 'About this place' : `About ${objectLabel}` },
        title: 'Contributor recording', label: RECORDING_LABEL,
        providerLabel: contribution.provider.displayName, captionAuthorLabel: captions.author.displayName,
        cues: captions.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), durationMs: playback.durationMs, audio: { type: 'audio/wav', size: playback.size },
        // The frozen caption version; earlier versions never reach visitors.
        captionVersion: captions.version,
      };
    });
    return { pinned, published };
  }

  // A pinned recording's issue now, or null: the bundle, its grants and files,
  // and the exact original, listening copy and captions that were pinned.
  #recordingIssue(manifest, pinned) {
    const contribution = contributionsOf(manifest).find((item) => item.id === pinned.contributionId);
    if (contribution?.withdrawnAt) return 'withdrawn';
    if (!contribution?.voice) return 'unavailable';
    const issue = contributionIssue(manifest, contribution);
    if (issue) return issue;
    const { source, playback, captions } = contribution.voice;
    const same = source.sha256 === pinned.originalSha256 && playback.sha256 === pinned.playbackSha256 && playback.size === pinned.playbackSize
      && captionsIntact(contribution) && captions.sha256 === pinned.captionSha256;
    return same ? null : 'unavailable';
  }

  // The pinned listening copy, rehashed against the pin; null when it no longer matches.
  async #recordingAudio(manifest, frozen, publicId) {
    const pinned = (frozen.recordings ?? []).find((item) => item.publicId === publicId);
    const contribution = pinned && contributionsOf(manifest).find((item) => item.id === pinned.contributionId);
    if (!contribution?.voice) return null;
    const body = await readPlayback(this.reconstructions.jobDir(manifest.draftId, manifest.id), contribution, { sha256: pinned.playbackSha256, size: pinned.playbackSize });
    return body && { type: 'audio/wav', body };
  }

  // Returns the fixed binding for an allowlisted asset after checking it still
  // matches the frozen checksum. Never a source path or a sibling file.
  async #asset(manifest, frozen, viewId, name) {
    if (viewId === 'evidence') return this.#evidence(manifest, frozen, name);
    if (!frozen.views.some((view) => view.id === viewId) || !Object.hasOwn(SHARED_ASSETS, name)) return null;
    const file = path.join(this.reconstructions.jobDir(manifest.draftId, manifest.id), 'assets', name);
    const binding = frozen.assets[name];
    if (name === 'surface.json') {
      const bytes = await readFile(file);
      if (sha256(bytes) !== binding.sha256) return null;
      return { name, type: SHARED_ASSETS[name], body: Buffer.from(JSON.stringify(visitorSurface(JSON.parse(bytes.toString('utf8'))))) };
    }
    // The caller verified these bytes against the frozen checksum in this mutex slot.
    const info = await stat(file);
    if (!info.isFile() || info.size !== binding.size) return null;
    return { name, type: SHARED_ASSETS[name], file, size: info.size };
  }

  // A pinned contributor photo's inspection JPEG, rehashed against the pinned
  // checksum on every read. Never the original.
  async #evidence(manifest, frozen, name) {
    const match = EVIDENCE_ASSET.exec(name);
    const pinned = match && (frozen.contributorPhotos ?? []).find((item) => item.publicId === `e${match[1]}`);
    const contribution = pinned && contributionsOf(manifest).find((item) => item.id === pinned.contributionId);
    if (!contribution?.photo) return null;
    const jobDir = this.reconstructions.jobDir(manifest.draftId, manifest.id);
    const body = await readReviewPhoto(jobDir, contribution, { sha256: pinned.reviewSha256, size: pinned.reviewSize });
    return body && { name, type: 'image/jpeg', body };
  }

  #previewResult(preview) {
    return { id: preview.id, digest: preview.digest, expiresAt: preview.expiresAt, publicView: structuredClone(preview.publicView) };
  }

  async createPreview(draftId, jobId, principal, body) {
    this.#owner(principal);
    const request = parsePreview(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const shares = sharesOf(manifest);
      const { requestId, ...values } = request;
      const requestDigest = sha256(JSON.stringify(values));
      const existing = shares.previews.find((item) => item.requestId === requestId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw fail(409, 'This request was already used with different values.');
        // A replay gets the same validity checks as a read; stored words are never returned for a stale preview.
        await this.#checkPreview(manifest, existing);
        return this.#previewResult(existing);
      }
      const { publicView, frozen } = await this.#build(manifest, request);
      const now = this.now();
      const preview = {
        id: randomUUID(), requestId, requestDigest, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SHARE_LIMITS.previewMs).toISOString(),
        createdBy: principal.id, frozen, publicView: { ...publicView, id: null }, digest: contentDigest(publicView), snapshotId: null,
      };
      // Expired previews that were never issued are dropped; issued ones stay for audit.
      const previews = shares.previews.filter((item) => item.snapshotId !== null || Date.parse(item.expiresAt) > now);
      await this.reconstructions.update(manifest, { shares: { ...shares, previews: [...previews, preview] } });
      return this.#previewResult(preview);
    });
  }

  // Callers already hold the manifest mutex.
  async #checkPreview(manifest, preview) {
    if (this.now() >= Date.parse(preview.expiresAt)) throw fail(409, 'This preview expired. Make a new preview.');
    const reason = await this.#liveIssue(manifest, preview.frozen);
    if (reason) this.#throwReason(reason);
  }

  // Checks run under the manifest mutex, and `use` builds the response in the
  // same slot, so no withdrawal can land between the check and the binding.
  async #livePreview(draftId, jobId, principal, previewId, use) {
    this.#owner(principal);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const preview = sharesOf(manifest).previews.find((item) => item.id === previewId);
      if (!preview) throw fail(404, 'This preview could not be found.');
      await this.#checkPreview(manifest, preview);
      return use(manifest, preview);
    });
  }

  getPreview(draftId, jobId, principal, previewId) {
    return this.#livePreview(draftId, jobId, principal, previewId, (manifest, preview) => this.#previewResult(preview));
  }

  previewAsset(draftId, jobId, principal, previewId, viewId, name) {
    return this.#livePreview(draftId, jobId, principal, previewId, async (manifest, preview) => {
      const asset = await this.#asset(manifest, preview.frozen, viewId, name);
      if (!asset) throw fail(404, 'Not found.');
      return asset;
    });
  }

  // Linear scan over recorded jobs; fine for one local workspace.
  async #findSnapshot(digest) {
    for (const draftId of await this.reconstructions.draftIds()) {
      for (const job of await this.reconstructions.list(draftId)) {
        const manifest = await this.reconstructions.readManifest(draftId, job.id);
        let found = null;
        for (const snapshot of sharesOf(manifest ?? {}).snapshots) if (sameVerifier(snapshot.tokenVerifier, digest) && !found) found = snapshot;
        if (found) return { manifest, snapshot: found };
      }
    }
    return null;
  }

  #receipt(snapshot) {
    return { id: snapshot.id, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt, status: snapshot.revokedAt ? 'revoked' : 'active', previewId: snapshot.previewId, digest: snapshot.digest };
  }

  async issue(draftId, jobId, principal, body) {
    this.#owner(principal);
    const request = parseIssue(body);
    await this.reconstructions.recover();
    const tokenVerifier = verifier(request.token);
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const shares = sharesOf(manifest);
      const existing = shares.snapshots.find((item) => item.requestId === request.requestId);
      if (existing) {
        if (existing.previewId !== request.previewId || existing.digest !== request.previewDigest || !sameVerifier(existing.tokenVerifier, tokenVerifier)) {
          throw fail(409, 'This request was already used with different values.');
        }
        return this.#receipt(existing);
      }
      if (await this.#findSnapshot(tokenVerifier)) throw fail(409, 'This link key was already used. Prepare a new one.');
      const preview = shares.previews.find((item) => item.id === request.previewId);
      if (!preview) throw fail(404, 'This preview could not be found.');
      if (preview.snapshotId !== null) throw fail(409, 'This preview was already issued. Make a new preview for another link.');
      if (preview.digest !== request.previewDigest) throw fail(409, 'The preview changed. Review it again before issuing.');
      const now = this.now();
      if (now >= Date.parse(preview.expiresAt)) throw fail(409, 'This preview expired. Make a new preview.');
      if (shares.snapshots.length >= SHARE_LIMITS.snapshotsPerScene) throw fail(409, 'This scene has reached the number of shared snapshots it can keep.');
      const reason = await this.#liveIssue(manifest, preview.frozen);
      if (reason) this.#throwReason(reason);
      const createdAt = new Date(now).toISOString();
      const snapshot = {
        id: randomUUID(), requestId: request.requestId, previewId: preview.id, digest: preview.digest, tokenVerifier,
        createdAt, expiresAt: new Date(now + SHARE_LIMITS.snapshotMs).toISOString(), revokedAt: null, createdBy: principal.id,
        frozen: preview.frozen,
      };
      snapshot.publicView = { ...preview.publicView, id: snapshot.id, createdAt };
      await this.reconstructions.update(manifest, {
        shares: {
          ...shares,
          previews: shares.previews.map((item) => (item.id === preview.id ? { ...item, snapshotId: snapshot.id } : item)),
          snapshots: [...shares.snapshots, snapshot],
        },
      });
      return this.#receipt(snapshot);
    });
  }

  async #status(manifest, snapshot) {
    if (snapshot.revokedAt) return { status: 'revoked', reason: 'Revoked by the owner.' };
    if (this.now() >= Date.parse(snapshot.expiresAt)) return { status: 'expired', reason: 'The link reached its expiry time.' };
    const reason = await this.#liveIssue(manifest, snapshot.frozen);
    return reason ? { status: 'suspended', reason: REASONS[reason][1] } : { status: 'active', reason: null };
  }

  // Owner metadata only: no token verifier, frozen content or link.
  async #metadata(manifest, snapshot) {
    return {
      id: snapshot.id, title: snapshot.publicView.title, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt,
      ...(await this.#status(manifest, snapshot)),
      views: snapshot.publicView.views.map((view) => ({ id: view.id, label: view.label })),
    };
  }

  async list(draftId, jobId, principal) {
    this.#owner(principal);
    await this.reconstructions.recover();
    const manifest = await this.#scene(draftId, jobId);
    const result = [];
    for (const snapshot of [...sharesOf(manifest).snapshots].reverse()) result.push(await this.#metadata(manifest, snapshot));
    return result;
  }

  async revoke(draftId, jobId, principal, snapshotId, body) {
    this.#owner(principal);
    const request = parseRevoke(body);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const shares = sharesOf(manifest);
      const receipt = shares.receipts.find((item) => item.requestId === request.requestId);
      if (receipt && (receipt.action !== 'revoke' || receipt.snapshotId !== snapshotId)) throw fail(409, 'This request was already used with different values.');
      const snapshot = shares.snapshots.find((item) => item.id === snapshotId);
      if (!snapshot) throw fail(404, 'This shared snapshot could not be found.');
      // Revocation is one-way; a later request on a revoked snapshot changes nothing.
      if (receipt || snapshot.revokedAt) return this.#metadata(manifest, snapshot);
      const revoked = { ...snapshot, revokedAt: new Date(this.now()).toISOString() };
      await this.reconstructions.update(manifest, {
        shares: {
          ...shares,
          snapshots: shares.snapshots.map((item) => (item.id === snapshotId ? revoked : item)),
          receipts: [...shares.receipts, { requestId: request.requestId, action: 'revoke', snapshotId }],
        },
      });
      return this.#metadata(manifest, revoked);
    });
  }

  // Every visitor failure is the same generic error; reasons stay with the owner.
  async #visitable(token, use) {
    if (!isVisitToken(token)) throw unavailable();
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const found = await this.#findSnapshot(verifier(token));
      if (!found) throw unavailable();
      const { status } = await this.#status(found.manifest, found.snapshot);
      if (status !== 'active') throw unavailable();
      return use(found.manifest, found.snapshot);
    });
  }

  visit(token) {
    return this.#visitable(token, (manifest, snapshot) => ({ stories: [], ...structuredClone(snapshot.publicView) }));
  }

  // Playback for a story pinned in this preview or snapshot, verified against
  // the pinned checksum in the same mutex slot as the authorization.
  previewStoryAudio(draftId, jobId, principal, previewId, publicStoryId) {
    return this.#livePreview(draftId, jobId, principal, previewId, async (manifest, preview) => {
      const pinned = (preview.frozen.stories ?? []).find((item) => item.publicId === publicStoryId);
      const asset = pinned && (await this.stories.pinnedAudio(manifest, pinned));
      if (!asset) throw fail(404, 'Not found.');
      return asset;
    });
  }

  previewRecordingAudio(draftId, jobId, principal, previewId, publicId) {
    return this.#livePreview(draftId, jobId, principal, previewId, async (manifest, preview) => {
      const asset = await this.#recordingAudio(manifest, preview.frozen, publicId);
      if (!asset) throw fail(404, 'Not found.');
      return asset;
    });
  }

  visitRecordingAudio(token, publicId) {
    return this.#visitable(token, async (manifest, snapshot) => {
      const asset = await this.#recordingAudio(manifest, snapshot.frozen, publicId).catch(() => null);
      if (!asset) throw unavailable();
      return asset;
    });
  }

  visitStoryAudio(token, publicStoryId) {
    return this.#visitable(token, async (manifest, snapshot) => {
      const pinned = (snapshot.frozen.stories ?? []).find((item) => item.publicId === publicStoryId);
      const asset = pinned && (await this.stories.pinnedAudio(manifest, pinned).catch(() => null));
      if (!asset) throw unavailable();
      return asset;
    });
  }

  // Admission only: a stream already handed to a visitor cannot be recalled.
  visitAsset(token, viewId, name) {
    return this.#visitable(token, async (manifest, snapshot) => {
      const asset = await this.#asset(manifest, snapshot.frozen, viewId, name).catch(() => null);
      if (!asset) throw unavailable();
      return asset;
    });
  }
}
