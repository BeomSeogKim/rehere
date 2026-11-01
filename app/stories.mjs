import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PCM_BYTES, SAMPLE_RATE, pcmWav } from './audio-derivative.mjs';
import { OBJECT_IDS, assertObjectsConfirmed, isTwoObject, objectMarker } from './arrangements.mjs';
import { contributionAllows, dependenciesBlocked } from './collaboration.mjs';
import { RequestError } from './drafts.mjs';
import { savedView } from './shares.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Plain text: tab and newline are allowed in cues, nothing else below space.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
export const STORY_LIMITS = Object.freeze({ title: 120, cues: 200, cueText: 2000, cueTotal: 20_000 });
export const STORY_TARGET = Object.freeze({ id: 'selected-foreground', label: 'Selected foreground object' });
const WAV_TYPE = 'audio/wav';
// Excerpts: integer milliseconds of 16 kHz mono 16-bit PCM, 32 bytes each,
// within the five-minute decoded limit; the WAV header is 44 bytes.
const PCM_BYTES_PER_MS = 32;
const WAV_HEADER_BYTES = 44;
const MAX_RANGE_MS = 300_000;
const SAMPLES_PER_MS = 16;
const MAX_SAMPLES = 4_800_000; // 300 seconds at 16 kHz
const UNREADABLE = 'The request could not be read.';

// Fixed browser messages for the decoder's fixed failure codes.
const DECODE_MESSAGES = {
  'unsupported-type': [400, 'This recording format cannot be prepared for playback.'],
  'invalid-input': [400, 'The recording could not be read. The original is unchanged.'],
  'too-long': [400, 'The recording is longer than 300 seconds, so no playback copy was made. The original is unchanged.'],
  timeout: [409, 'Preparing the playback copy took too long and was stopped. The original is unchanged.'],
  aborted: [409, 'Preparing the playback copy was stopped because the material is no longer in use or the app is closing.'],
  unavailable: [503, 'The audio decoder is not set up on this computer.'],
  'decode-failed': [400, 'The recording could not be decoded. The original is unchanged.'],
};

// Fixed reasons a saved story cannot be used now. No story text is included.
const BLOCKED = {
  withdrawn: 'This story was withdrawn.',
  photo: 'The photo this story belongs to is no longer available for this use.',
  voice: 'The recording is no longer available for this use.',
  contribution: 'A recollection this arrangement depends on was withdrawn or is not permitted.',
  view: 'The arrangement this story belongs to is no longer available.',
  era: 'The time assertion for this arrangement changed after the story was saved.',
  range: 'The selected part of the recording no longer matches its record.',
};

const fail = (status, message) => new RequestError(status, message);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isId = (value) => typeof value === 'string' && UUID.test(value);
const plain = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const filled = (value, max) => plain(value, max) && value.trim() !== '';

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseView(view) {
  if (!exactKeys(view, ['kind', 'version', 'variantId', 'eraRevision'])) return null;
  const { kind, version, variantId, eraRevision } = view;
  if (kind === 'version' && Number.isInteger(version) && version >= 1 && variantId === null && eraRevision === null) return { kind, version, variantId, eraRevision };
  if (kind === 'variant' && version === null && isId(variantId) && Number.isInteger(eraRevision) && eraRevision >= 0) return { kind, version, variantId, eraRevision };
  return null;
}

// Ordered, non-overlapping integer millisecond cues; end bounds are checked
// against the decoded duration later.
function parseCues(cues) {
  if (!Array.isArray(cues) || cues.length < 1 || cues.length > STORY_LIMITS.cues) return null;
  let total = 0;
  let previousEnd = 0;
  const parsed = [];
  for (const cue of cues) {
    if (!exactKeys(cue, ['startMs', 'endMs', 'text'])) return null;
    const { startMs, endMs, text } = cue;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < previousEnd || endMs <= startMs) return null;
    if (!filled(text, STORY_LIMITS.cueText)) return null;
    total += text.length;
    previousEnd = endMs;
    parsed.push({ startMs, endMs, text });
  }
  return total <= STORY_LIMITS.cueTotal ? parsed : null;
}

const STORY_KEYS = ['requestId', 'voiceSourceId', 'view', 'title', 'cues', 'captionConfirmed'];

// An excerpt of the original recording: integer milliseconds from its start.
function validRange(range) {
  return exactKeys(range, ['startMs', 'endMs']) && Number.isInteger(range.startMs) && Number.isInteger(range.endMs)
    && range.startMs >= 0 && range.endMs > range.startMs && range.endMs <= MAX_RANGE_MS;
}

// A two-object scene also names the one object the story is about.
// An optional sourceRange selects an excerpt; without it the whole first
// track is used and the request (and its digest) is exactly as before.
export function parseStoryRequest(body, twoObjects = false) {
  const keys = twoObjects ? [...STORY_KEYS, 'targetId'] : STORY_KEYS;
  const hasRange = body !== null && typeof body === 'object' && Object.hasOwn(body, 'sourceRange');
  if (!exactKeys(body, hasRange ? [...keys, 'sourceRange'] : keys)) throw fail(400, UNREADABLE);
  if (hasRange && !validRange(body.sourceRange)) throw fail(400, 'The selected part of the recording could not be read.');
  const view = parseView(body.view);
  const cues = parseCues(body.cues);
  const valid = isId(body.requestId) && isId(body.voiceSourceId) && view && cues && filled(body.title, STORY_LIMITS.title)
    && (!twoObjects || OBJECT_IDS.includes(body.targetId));
  if (!valid) throw fail(400, UNREADABLE);
  if (body.captionConfirmed !== true) throw fail(400, 'Confirm that the captions convey what can be heard in the recording.');
  return {
    requestId: body.requestId, voiceSourceId: body.voiceSourceId, view, title: body.title, cues, ...(twoObjects && { targetId: body.targetId }),
    ...(hasRange && { sourceRange: { startMs: body.sourceRange.startMs, endMs: body.sourceRange.endMs } }),
  };
}

// The object a story is about: the owner's named object, or the one
// foreground of a single-object scene.
const storyTarget = (context, showLabel = true) => {
  if (context.targetLabel === undefined) return { ...STORY_TARGET };
  // A blocked story shows a fixed marker, not the owner's object name.
  return { id: context.target, label: showLabel ? context.targetLabel : objectMarker(context.target) };
};

const storiesOf = (manifest) => manifest.stories ?? { items: [], receipts: [] };
const viewKey = (view) => (view.kind === 'version' ? `version:${view.version}` : `variant:${view.variantId}`);

// Recorded stories bound to one saved arrangement of one ready scene. Records
// live in the scene manifest and playback copies beside it, so saving, a
// withdrawal and a source restriction share the reconstruction mutex.
export class StoryStore {
  constructor({ reconstructions, audioDecoder }) {
    this.reconstructions = reconstructions;
    this.audioDecoder = audioDecoder;
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

  #file(manifest, storyId) {
    return path.join(this.reconstructions.jobDir(manifest.draftId, manifest.id), 'stories', `${storyId}.wav`);
  }

  // Everything a story depends on, resolved now for the request. Callers hold
  // the mutex. Returns the frozen context and the recording's stored file.
  async #context(manifest, request) {
    if (manifest.status !== 'ready') throw fail(409, 'Only a finished scene can have recorded stories.');
    assertObjectsConfirmed(manifest);
    const r = this.reconstructions;
    const draft = await r.drafts.get(manifest.draftId);
    const sources = Array.isArray(draft?.sources) ? draft.sources : [];
    const photo = sources.find((item) => item.id === manifest.sourceId);
    if (!photo || photo.sha256 !== manifest.sourceSha256 || !(await r.sourcePolicies.canUse(draft, photo.id, 'place'))) {
      throw fail(403, BLOCKED.photo);
    }
    const voice = sources.find((item) => item.id === request.voiceSourceId && item.kind === 'voice');
    if (!voice || draft.voice?.sourceId !== voice.id) throw fail(404, 'This recording could not be found in the memory.');
    if (!(await r.sourcePolicies.canUse(draft, voice.id, 'place'))) throw fail(403, BLOCKED.voice);
    const resolved = savedView(manifest, request.view);
    if (!resolved) throw fail(404, 'This arrangement could not be found.');
    // The revision the owner reviewed must still be the current one.
    if (request.view.kind === 'variant' && resolved.eraRevision !== request.view.eraRevision) {
      throw fail(409, 'The time assertion for this arrangement changed. Review it and try again.');
    }
    if (dependenciesBlocked(manifest, resolved.dependencies)) throw fail(409, BLOCKED.contribution);
    const era = resolved.era && (({ id, requestId, ...rest }) => rest)(resolved.era);
    return {
      context: {
        view: { ...request.view },
        label: resolved.label,
        edit: resolved.edit,
        dependencies: resolved.dependencies,
        era,
        target: request.targetId ?? STORY_TARGET.id,
        ...(request.targetId && { targetLabel: manifest.objects.find((item) => item.id === request.targetId).label }),
        photo: { sourceId: photo.id, sha256: photo.sha256 },
        voice: {
          sourceId: voice.id, sha256: voice.sha256, provider: voice.provider || null,
          // The excerpt's position in this exact original, bound by its checksum.
          ...(request.sourceRange && { sourceRange: { ...request.sourceRange } }),
        },
      },
      recording: { name: draft.voice.name, type: draft.voice.type, size: voice.size, sha256: voice.sha256 },
    };
  }

  // Null when the story may be used for `purpose` ('place' privately, 'share'
  // for visitors) under current restrictions, grants and arrangements.
  async #blocked(manifest, story, purpose) {
    if (story.status === 'withdrawn') return 'withdrawn';
    const r = this.reconstructions;
    const { context } = story;
    // A saved excerpt must be exactly the recorded selection; it is never
    // treated as the whole recording and nothing is decoded again.
    // Either excerpt field marks an excerpt, and then both must be valid; a
    // whole-recording story has neither.
    const voiceFields = context.voice ?? {};
    if (Object.hasOwn(voiceFields, 'sourceRange') || Object.hasOwn(voiceFields, 'sourceSampleCount')) {
      const range = context.voice.sourceRange;
      const length = validRange(range) ? range.endMs - range.startMs : null;
      // The decoded original's sample count, recorded at publication, must
      // still contain the selection: this catches an isolated corrupted or
      // shifted range of the same length (not a coherent rewrite of the record).
      const count = context.voice.sourceSampleCount;
      const extentKnown = Number.isInteger(count) && count > 0 && count <= MAX_SAMPLES && length !== null && range.endMs * SAMPLES_PER_MS <= count;
      if (length === null || !extentKnown || story.durationMs !== length || story.audio?.size !== WAV_HEADER_BYTES + length * PCM_BYTES_PER_MS) return 'range';
    }
    if (manifest.status !== 'ready' || manifest.sourceSha256 !== context.photo.sha256) return 'photo';
    const draft = await r.drafts.get(manifest.draftId);
    const voice = Array.isArray(draft?.sources) ? draft.sources.find((item) => item.id === context.voice.sourceId) : null;
    if (!(await r.sourcePolicies.canUse(draft, context.photo.sourceId, purpose))) return 'photo';
    if (!voice || voice.sha256 !== context.voice.sha256 || !(await r.sourcePolicies.canUse(draft, voice.id, purpose))) return 'voice';
    if (dependenciesBlocked(manifest, context.dependencies)) return 'contribution';
    if (purpose === 'share') {
      const contributions = manifest.collaboration?.contributions ?? [];
      const shareable = (id) => {
        const item = contributions.find((entry) => entry.id === id);
        return Boolean(item) && contributionAllows(item, 'share');
      };
      if (!context.dependencies.every(shareable)) return 'contribution';
    }
    const resolved = savedView(manifest, context.view);
    if (!resolved) return 'view';
    if (context.view.kind === 'variant' && resolved.eraRevision !== context.view.eraRevision) return 'era';
    return null;
  }

  // Owner projection. An unusable or withdrawn story shows only fixed labels,
  // attribution and its reason, never its title, captions or time wording.
  async #project(manifest, story) {
    const reason = await this.#blocked(manifest, story, 'place');
    const available = reason === null;
    const { context } = story;
    return {
      id: story.id,
      status: story.status,
      available,
      blockedReason: reason && BLOCKED[reason],
      title: available ? story.title : '',
      target: storyTarget(context, available),
      view: { ...context.view, label: context.label, era: available ? context.era : null },
      voice: { sourceId: context.voice.sourceId, provider: context.voice.provider },
      captionAuthor: { displayName: story.captionAuthor.displayName },
      cues: available ? story.cues.map((cue) => ({ ...cue })) : [],
      durationMs: story.durationMs,
      audio: available ? { type: WAV_TYPE, size: story.audio.size } : null,
      ...(available && context.voice.sourceRange && { sourceRange: { ...context.voice.sourceRange } }),
      error: null,
      createdAt: story.createdAt,
      withdrawnAt: story.withdrawnAt,
    };
  }

  async list(draftId, jobId, principal) {
    this.#owner(principal);
    await this.reconstructions.recover();
    const manifest = await this.#scene(draftId, jobId);
    const stories = [];
    for (const story of [...storiesOf(manifest).items].reverse()) stories.push(await this.#project(manifest, story));
    return { stories };
  }

  async get(draftId, jobId, principal, storyId) {
    this.#owner(principal);
    await this.reconstructions.recover();
    const manifest = await this.#scene(draftId, jobId);
    const story = storiesOf(manifest).items.find((item) => item.id === storyId);
    if (!story) throw fail(404, 'This story could not be found.');
    return this.#project(manifest, story);
  }

  // Admission and publication run under the reconstruction mutex; decoding
  // runs between them, outside it, in the single story slot. Nothing is
  // recorded unless the playback copy was made and every check still holds.
  async create(draftId, jobId, principal, body) {
    this.#owner(principal);
    const r = this.reconstructions;
    await r.recover();
    // Whether a scene has two objects is fixed when it is built, so the body
    // shape can be chosen before the admission slot.
    const request = parseStoryRequest(body, isTwoObject(await this.#scene(draftId, jobId)));
    const { requestId, ...values } = request;
    const requestDigest = sha256(JSON.stringify(values));
    const admitted = await r.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const existing = storiesOf(manifest).items.find((item) => item.requestId === requestId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw fail(409, 'This request was already used with different values.');
        return { manifest, story: existing };
      }
      if (r.closed) throw fail(503, 'The app is shutting down. Try again later.');
      if (r.activeStory) throw fail(409, 'Another recorded story is being prepared right now. Try again when it finishes.');
      const { context, recording } = await this.#context(manifest, request);
      const slot = { draftId, sourceIds: [context.voice.sourceId, context.photo.sourceId], controller: new AbortController(), done: null };
      r.activeStory = slot;
      return { context, recording, slot };
    });
    if (admitted.story) return this.#project(admitted.manifest, admitted.story);

    const { slot, recording } = admitted;
    let settle;
    slot.done = new Promise((resolve) => {
      settle = resolve;
    });
    const storyId = randomUUID();
    const jobDir = r.jobDir(draftId, jobId);
    const staged = path.join(jobDir, 'story-staging', `${storyId}.wav`);
    // Under the mutex: the request is still unused, nothing was aborted or
    // closed, and every admission check still gives the admitted context. A
    // restriction commits under the same mutex, so it cannot land between this
    // check and whatever the caller starts in the same slot.
    const stillAdmitted = async () => {
      if (slot.controller.signal.aborted || r.closed) throw fail(...DECODE_MESSAGES.aborted);
      const manifest = await this.#scene(draftId, jobId);
      if (storiesOf(manifest).items.some((item) => item.requestId === requestId)) throw fail(409, 'This request was already used.');
      const { context } = await this.#context(manifest, request);
      if (JSON.stringify(context) !== JSON.stringify(admitted.context)) {
        throw fail(409, 'The arrangement or its sources changed while the story was prepared. Review it and try again.');
      }
      return { manifest, context };
    };
    try {
      const wav = await this.#prepare(draftId, recording, request.cues, slot.controller.signal, stillAdmitted, request.sourceRange);
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, wav.bytes, { flag: 'wx' });
      return await r.serialize(async () => {
        const { manifest, context } = await stillAdmitted();
        const file = this.#file(manifest, storyId);
        await mkdir(path.dirname(file), { recursive: true });
        await rename(staged, file);
        // close() can land during the awaits above without the mutex. The
        // manifest write is the commit boundary: before it, an abort removes
        // the unreferenced copy; once it starts, the story is published.
        if (slot.controller.signal.aborted || r.closed) {
          await rm(file, { force: true }).catch(() => {});
          throw fail(...DECODE_MESSAGES.aborted);
        }
        const stories = storiesOf(manifest);
        // An excerpt also keeps, privately, how many samples the whole decoded
        // original had; it is added only now so the admission check compares
        // exactly the context resolved before decoding.
        const saved = request.sourceRange ? { ...context, voice: { ...context.voice, sourceSampleCount: wav.sourceSampleCount } } : context;
        const story = {
          id: storyId, requestId, requestDigest, status: 'ready', title: request.title, cues: request.cues, context: saved,
          captionAuthor: { principalId: principal.id, displayName: principal.displayName }, captionConfirmed: true,
          durationMs: wav.durationMs, audio: { type: WAV_TYPE, size: wav.bytes.length, sha256: sha256(wav.bytes) },
          createdAt: new Date().toISOString(), withdrawnAt: null,
        };
        try {
          await r.update(manifest, { stories: { ...stories, items: [...stories.items, story] } });
        } catch (error) {
          // A deleted place's copy is left to the deletion's exact cleanup.
          if (!(await r.placeDeleted(draftId))) await rm(file, { force: true }).catch(() => {});
          throw error;
        }
        return this.#project(manifest, story);
      });
    } finally {
      if (!(await r.placeDeleted(draftId).catch(() => true))) await rm(staged, { force: true }).catch(() => {});
      r.activeStory = null;
      settle();
    }
  }

  // Reads the stored original, checks it is the recorded file, decodes the
  // whole first audio track and builds the WAV playback copy. The decoder is
  // started inside a final admission under the mutex and awaited outside it,
  // so a restriction saved while the original was read always prevents the start.
  async #prepare(draftId, recording, cues, signal, stillAdmitted, sourceRange = undefined) {
    const asset = await this.reconstructions.drafts.asset(draftId, recording.name);
    const bytes = asset && (await readFile(asset.file));
    if (!bytes || bytes.length !== recording.size || sha256(bytes) !== recording.sha256) {
      throw fail(409, 'The saved recording no longer matches its recorded checksum, so it cannot be used.');
    }
    const started = await this.reconstructions.serialize(async () => {
      await stillAdmitted();
      // Started synchronously in this slot, and wrapped so the slot ends when
      // the decode starts, not when it finishes.
      return { decoding: (async () => this.audioDecoder({ bytes, type: recording.type, signal }))() };
    });
    let decoded;
    try {
      decoded = await started.decoding;
    } catch (error) {
      const known = DECODE_MESSAGES[error?.code];
      if (!known) console.error(`story decode failed: ${error?.name ?? 'error'}`);
      throw fail(...(known ?? DECODE_MESSAGES['decode-failed']));
    }
    if (signal.aborted) throw fail(...DECODE_MESSAGES.aborted);
    if (sourceRange) {
      // The whole decoded track must be valid PCM in the fixed layout before
      // any part of it is taken; then exactly [start, end) is kept.
      const { pcm } = decoded;
      const valid = Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % 2 === 0 && pcm.length <= MAX_PCM_BYTES
        && decoded.sampleRate === SAMPLE_RATE && decoded.channels === 1 && decoded.bitsPerSample === 16;
      if (!valid) throw fail(...DECODE_MESSAGES['decode-failed']);
      if (sourceRange.endMs * PCM_BYTES_PER_MS > pcm.length) throw fail(400, 'The selected part ends after the recording ends. Adjust the end time.');
      const durationMs = sourceRange.endMs - sourceRange.startMs;
      if (cues.at(-1).endMs > durationMs) throw fail(400, 'A caption ends after the selected part ends. Caption times start at the beginning of the selected part.');
      return { bytes: pcmWav(pcm.subarray(sourceRange.startMs * PCM_BYTES_PER_MS, sourceRange.endMs * PCM_BYTES_PER_MS)), durationMs, sourceSampleCount: pcm.length / 2 };
    }
    const { durationMs } = decoded;
    if (cues.at(-1).endMs > durationMs) throw fail(400, 'A caption ends after the recording ends. Adjust the caption times.');
    return { bytes: pcmWav(decoded.pcm), durationMs };
  }

  async withdraw(draftId, jobId, principal, storyId, body) {
    this.#owner(principal);
    if (!exactKeys(body, ['requestId']) || !isId(body.requestId)) throw fail(400, UNREADABLE);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const stories = storiesOf(manifest);
      const receipt = stories.receipts.find((item) => item.requestId === body.requestId);
      if (receipt && receipt.storyId !== storyId) throw fail(409, 'This request was already used with different values.');
      const story = stories.items.find((item) => item.id === storyId);
      if (!story) throw fail(404, 'This story could not be found.');
      // One-way: a withdrawn story is never made usable again; files are kept.
      if (receipt || story.status === 'withdrawn') return this.#project(manifest, story);
      const withdrawn = { ...story, status: 'withdrawn', withdrawnAt: new Date().toISOString() };
      await this.reconstructions.update(manifest, {
        stories: {
          items: stories.items.map((item) => (item.id === storyId ? withdrawn : item)),
          receipts: [...stories.receipts, { requestId: body.requestId, storyId }],
        },
      });
      return this.#project(manifest, withdrawn);
    });
  }

  // Playback bytes after current checks, verified against the recorded
  // checksum and returned whole so the served bytes are the verified ones.
  async #audio(manifest, story, purpose, expectedSha256) {
    if (await this.#blocked(manifest, story, purpose)) return null;
    const bytes = await this.#verifiedAudio(manifest, story, expectedSha256);
    return bytes && { type: WAV_TYPE, body: bytes };
  }

  async audio(draftId, jobId, principal, storyId) {
    this.#owner(principal);
    await this.reconstructions.recover();
    return this.reconstructions.serialize(async () => {
      const manifest = await this.#scene(draftId, jobId);
      const story = storiesOf(manifest).items.find((item) => item.id === storyId);
      if (!story) throw fail(404, 'This story could not be found.');
      const reason = await this.#blocked(manifest, story, 'place');
      if (reason) throw fail(409, BLOCKED[reason]);
      const asset = await this.#audio(manifest, story, 'place', story.audio.sha256);
      if (!asset) throw fail(409, 'The playback copy no longer matches its record.');
      return asset;
    });
  }

  // For the share store, which holds the mutex. Returns the visitor fields and
  // the private pin for a story that belongs to exactly one selected view, or
  // null when it cannot be shared now.
  async forShare(manifest, storyId, views) {
    const story = storiesOf(manifest).items.find((item) => item.id === storyId);
    if (!story || (await this.#blocked(manifest, story, 'share'))) return null;
    // The playback file must be the recorded bytes before it can be pinned.
    if (!(await this.#audioMatches(manifest, story, story.audio.sha256))) return null;
    const matches = views.filter((view) => viewKey(view) === viewKey(story.context.view)
      && (view.kind === 'version' || view.eraRevision === story.context.view.eraRevision));
    if (matches.length !== 1) return null;
    return {
      pinned: { storyId: story.id, viewId: matches[0].id, audioSha256: story.audio.sha256, contentSha256: sha256(JSON.stringify([story.title, story.cues, story.context])) },
      publicStory: {
        viewId: matches[0].id, target: storyTarget(story.context), title: story.title, providerLabel: story.context.voice.provider, captionAuthorLabel: story.captionAuthor.displayName,
        cues: story.cues.map((cue) => ({ ...cue })), durationMs: story.durationMs, audio: { type: WAV_TYPE, size: story.audio.size },
        ...(story.context.voice.sourceRange && { sourceRange: { ...story.context.voice.sourceRange } }),
      },
    };
  }

  // True when a pinned story can no longer be shown to visitors. Like frozen
  // scene assets, the playback file itself must still be the pinned bytes, so
  // a missing or altered copy suspends the snapshot rather than only its audio.
  async shareIssue(manifest, pinned) {
    const story = storiesOf(manifest).items.find((item) => item.id === pinned.storyId);
    if (!story || story.audio.sha256 !== pinned.audioSha256) return true;
    if (sha256(JSON.stringify([story.title, story.cues, story.context])) !== pinned.contentSha256) return true;
    if (await this.#blocked(manifest, story, 'share')) return true;
    return !(await this.#audioMatches(manifest, story, pinned.audioSha256));
  }

  // The recorded playback copy, read whole (it is at most 300 seconds of
  // 16 kHz mono PCM), when its size and checksum still match; otherwise null.
  async #verifiedAudio(manifest, story, expectedSha256) {
    const bytes = await readFile(this.#file(manifest, story.id)).catch(() => null);
    if (!bytes || bytes.length !== story.audio.size || sha256(bytes) !== story.audio.sha256 || story.audio.sha256 !== expectedSha256) return null;
    return bytes;
  }

  async #audioMatches(manifest, story, expectedSha256) {
    return (await this.#verifiedAudio(manifest, story, expectedSha256)) !== null;
  }

  async pinnedAudio(manifest, pinned) {
    const story = storiesOf(manifest).items.find((item) => item.id === pinned.storyId);
    return story ? this.#audio(manifest, story, 'share', pinned.audioSha256) : null;
  }
}
