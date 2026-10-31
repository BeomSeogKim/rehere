import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pcmWav } from '../audio-derivative.mjs';
import { CAPTION_VERSIONS } from '../collaboration.mjs';
import { detectMedia } from '../drafts.mjs';
import { client, enrolledContributor, jpeg, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Synthetic bytes only; the injected preparer stands in for the strict local
// decode with its exact result shape.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(96, 5)]);
const WAV = pcmWav(Buffer.alloc(3200));
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const preparer = async ({ bytes }) => {
  const { type, extension } = detectMedia('voice', bytes);
  return {
    original: { sha256: sha256(bytes), size: bytes.length, type, extension },
    playback: { sha256: sha256(WAV), size: WAV.length, type: 'audio/wav', durationMs: 100, sampleRate: 16_000, channels: 1, bitsPerSample: 16, parentSha256: sha256(bytes) },
    wav: WAV,
  };
};

async function workspace(dataDir) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-captions-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, contributionPhotoDecoder: async () => jpeg(64, 48, 9), recordingPreparer: preparer });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

async function place(owner) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo.png');
  form.append('metadata', JSON.stringify({ photos: [{
    provider: 'Synthetic provider', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: true },
    dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  }] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: [4, 3, 20, 24] })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    draft, job, scene,
    captions: (id) => `${scene}/contributions/${id}/captions`,
    lookup: (id, requestId) => `${scene}/contributions/${id}/captions/requests/${requestId}`,
    recording: (id) => `${scene}/contributions/${id}/recording.wav`,
    review: (id) => `${scene}/contributions/${id}/review`,
    withdraw: (id) => `${scene}/contributions/${id}/withdraw`,
  };
}

const grants = { place: true, model: false, share: true };
const voiceFacts = (captionText = '') => ({
  origin: { kind: 'own', reference: 'Recorded at home' }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
  permissions: grants, captionText, captionConfirmed: captionText !== '',
});
async function submitVoice(session, scene, { captionText = '', text = '' } = {}) {
  const form = new FormData();
  form.append('payload', JSON.stringify({ requestId: randomUUID(), text, permissions: text ? grants : null, periodClaim: '', photo: null, voice: voiceFacts(captionText) }));
  form.append('voice', new Blob([WEBM]), 'take');
  const response = await session.request(`${scene.scene}/contributions/bundle`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  return response.json();
}
async function provider(app, owner, scene, options, name = 'Synthetic speaker') {
  const { session, principal } = await enrolledContributor(owner, app.base, scene.draft.id, name);
  return { session, principal, contribution: await submitVoice(session, scene, options) };
}
const change = (base, captionText, requestId = randomUUID()) => ({ requestId, baseCaptionSha256: base, captionText, captionConfirmed: true });
const jobDirOf = (dataDir, scene) => path.join(dataDir, 'reconstructions', scene.draft.id, scene.job.id);
const manifestFile = (dataDir, scene) => path.join(jobDirOf(dataDir, scene), 'manifest.json');
const storedOf = async (dataDir, scene, id) => JSON.parse(await readFile(manifestFile(dataDir, scene), 'utf8')).collaboration.contributions.find((item) => item.id === id);
const reviewBody = (revision, extra = {}) => ({
  requestId: randomUUID(), baseVersion: 1, baseRevision: revision, decision: 'adopt', reason: 'Matches.', conflict: 'unknown',
  transform: { offset: [0, 0, -0.5], yaw: 0 }, voiceReviewed: true, ...extra,
});
const versionView = (version) => ({ id: randomUUID(), kind: 'version', version, variantId: null });
const previewBody = (views, recordings = []) => ({
  requestId: randomUUID(), title: 'Synthetic place', views, startViewId: views[0].id, camera: { position: [0, 0, 2], target: [0, 0, -3] },
  contributionIds: [], synthetic: true, recordings,
});
const visit = (base, token, route = '/api/visit', init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
async function issue(owner, scene, preview) {
  const token = `rhv_${randomBytes(32).toString('base64url')}`;
  const response = await owner.post(`${scene.scene}/shares`, { requestId: randomUUID(), previewId: preview.id, previewDigest: preview.digest, token, consent: true });
  assert.equal(response.status, 201);
  return token;
}

describe('adding and correcting listening captions', () => {
  it('adds captions to an uncaptioned recording, then corrects them as new versions, changing nothing else', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session, principal, contribution } = await provider(app, owner, scene, { text: 'My separate writing.' });
      const before = await storedOf(dataDir, scene, contribution.id);
      const dir = path.join(jobDirOf(dataDir, scene), 'contributions', contribution.id);

      const first = await session.post(scene.captions(contribution.id), change(null, 'A kettle, then my description.'));
      assert.equal(first.status, 200);
      const added = await first.json();
      assert.deepEqual(Object.keys(added).sort(), ['appliedCaptionVersion', 'contribution']);
      assert.equal(added.appliedCaptionVersion, 1);
      const v1 = added.contribution.voice.captions;
      assert.deepEqual([v1.version, v1.cues, v1.authorLabel, added.contribution.voice.captionHistory], [1, [{ startMs: 0, endMs: 100, text: 'A kettle, then my description.' }], 'Synthetic speaker', []]);
      const stored1 = await storedOf(dataDir, scene, contribution.id);
      assert.equal(v1.sha256, sha256(JSON.stringify([before.voice.source.sha256, before.voice.playback.sha256, principal.id, v1.cues])), 'version 1 keeps the committed formula');

      const second = await session.post(scene.captions(contribution.id), change(v1.sha256, 'Corrected: a kettle, then my description of the counter.'));
      assert.equal(second.status, 200);
      const corrected = await second.json();
      const v2 = corrected.contribution.voice.captions;
      assert.equal(corrected.appliedCaptionVersion, 2);
      assert.equal(v2.sha256, sha256(JSON.stringify([before.voice.source.sha256, before.voice.playback.sha256, principal.id, v2.cues, 2])), 'version 2 adds the version');
      assert.deepEqual(corrected.contribution.voice.captionHistory.map(({ version, sha256: hash, cues }) => ({ version, hash, cues })), [{ version: 1, hash: v1.sha256, cues: v1.cues }]);
      assert.equal(typeof corrected.contribution.voice.captionHistory[0].supersededAt, 'string');

      const stored2 = await storedOf(dataDir, scene, contribution.id);
      assert.deepEqual(stored2.voice.captionHistory[0], { ...stored1.voice.captions, supersededAt: stored2.voice.captionHistory[0].supersededAt });
      assert.deepEqual([stored2.voice.source, stored2.voice.playback, stored2.text, stored2.permissions], [before.voice.source, before.voice.playback, before.text, before.permissions]);
      assert.equal(stored2.revision, before.revision + 2);
      assert.deepEqual(await readFile(path.join(dir, 'voice-original.webm')), WEBM);
      assert.deepEqual(await readFile(path.join(dir, 'playback.wav')), WAV);
      assert.equal((await owner.json(scene.scene)).edit.version, 1, 'no geometry change');

      for (const [label, body, status] of [
        ['identical', change(v2.sha256, v2.cues[0].text), 400],
        ['blank', change(v2.sha256, '   '), 400],
        ['unconfirmed', { ...change(v2.sha256, 'Other.'), captionConfirmed: false }, 400],
        ['control character', change(v2.sha256, 'bell\u0007'), 400],
        ['stale base', change(v1.sha256, 'Other.'), 409],
        ['null base with captions', change(null, 'Other.'), 409],
      ]) {
        const response = await session.post(scene.captions(contribution.id), body);
        assert.equal(response.status, status, label);
        assert.deepEqual(Object.keys(await response.json()), ['error'], label);
      }
      assert.equal((await storedOf(dataDir, scene, contribution.id)).voice.captions.version, 2, 'refusals change nothing');
    } finally {
      await app.close();
    }
  });

  it('lets only the provider change their own captions, the owner included when they are the provider', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await place(owner);
      const { contribution } = await provider(app, owner, scene);
      const { session: peer } = await enrolledContributor(owner, app.base, scene.draft.id, 'Synthetic peer');
      assert.equal((await owner.post(scene.captions(contribution.id), change(null, 'Owner words.'))).status, 403);
      assert.equal((await peer.post(scene.captions(contribution.id), change(null, 'Peer words.'))).status, 404);
      assert.equal((await client(app.base).post(scene.captions(contribution.id), change(null, 'Anyone.'))).status, 401);
      assert.equal((await owner.post(scene.captions(randomUUID()), change(null, 'Missing.'))).status, 404);
      const lookup = scene.lookup(contribution.id, randomUUID());
      assert.deepEqual([(await owner.request(lookup)).status, (await peer.request(lookup)).status], [403, 404]);

      const own = await submitVoice(owner, scene);
      assert.equal((await owner.post(scene.captions(own.id), change(null, 'The owner’s own recording.'))).status, 200);
      const { session: writer } = await enrolledContributor(owner, app.base, scene.draft.id, 'Writer');
      const form = new FormData();
      form.append('payload', JSON.stringify({ requestId: randomUUID(), text: 'Words only.', permissions: grants, periodClaim: '', photo: null, voice: null }));
      const words = await (await writer.request(`${scene.scene}/contributions/bundle`, { method: 'POST', body: form })).json();
      assert.equal((await writer.post(scene.captions(words.id), change(null, 'No recording.'))).status, 409);
    } finally {
      await app.close();
    }
  });
});

describe('caption request outcomes', () => {
  it('replays and looks up the version each request saved, before refusals and after withdrawal, without old text', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await provider(app, owner, scene);
      const firstBody = change(null, 'First words.');
      const first = await (await session.post(scene.captions(contribution.id), firstBody)).json();
      const secondBody = change(first.contribution.voice.captions.sha256, 'Second words.');
      const second = await (await session.post(scene.captions(contribution.id), secondBody)).json();

      const replay = await session.post(scene.captions(contribution.id), firstBody);
      assert.equal(replay.status, 200, 'a first-add replay keeps its null base');
      const replayed = await replay.json();
      assert.equal(replayed.appliedCaptionVersion, 1);
      assert.deepEqual(replayed.contribution.voice.captions, second.contribution.voice.captions, 'the current state is never rewound');
      assert.equal(replayed.contribution.voice.captionHistory.length, 1, 'no new history entry');
      assert.equal((await session.post(scene.captions(contribution.id), { ...firstBody, captionText: 'Changed.' })).status, 409);

      const looked = await session.request(scene.lookup(contribution.id, firstBody.requestId));
      assert.equal(looked.status, 200);
      assert.deepEqual(await looked.json(), replayed);
      assert.equal((await session.request(scene.lookup(contribution.id, firstBody.requestId), { method: 'HEAD' })).status, 200);
      assert.equal((await session.request(scene.lookup(contribution.id, randomUUID()))).status, 404);

      assert.equal((await session.post(scene.withdraw(contribution.id), { requestId: randomUUID() })).status, 200);
      for (const response of [await session.post(scene.captions(contribution.id), secondBody), await session.request(scene.lookup(contribution.id, secondBody.requestId))]) {
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.appliedCaptionVersion, 2);
        assert.deepEqual([result.contribution.voice.captions, result.contribution.voice.captionHistory, result.contribution.text], [null, [], null]);
        const text = JSON.stringify(result);
        for (const secret of ['First words', 'Second words', first.contribution.voice.captions.sha256, second.contribution.voice.captions.sha256]) assert.ok(!text.includes(secret), secret);
      }
      assert.equal((await session.post(scene.captions(contribution.id), change(null, 'After withdrawal.'))).status, 409);
    } finally {
      await app.close();
    }
  });

  it('keeps at most 20 caption versions, publishes nothing on a failed write and survives a restart', async () => {
    const { app, owner, dataDir } = await workspace();
    let restarted = null;
    try {
      const scene = await place(owner);
      const { session, contribution } = await provider(app, owner, scene, { captionText: 'Version 1.' });
      let current = contribution.voice.captions.sha256;
      for (let version = 2; version <= CAPTION_VERSIONS; version++) {
        const result = await (await session.post(scene.captions(contribution.id), change(current, `Version ${version}.`))).json();
        assert.equal(result.appliedCaptionVersion, version);
        current = result.contribution.voice.captions.sha256;
      }
      const capped = await session.post(scene.captions(contribution.id), change(current, 'One too many.'));
      assert.equal(capped.status, 409);
      const stored = await storedOf(dataDir, scene, contribution.id);
      assert.deepEqual([stored.voice.captions.version, stored.voice.captionHistory.length], [CAPTION_VERSIONS, CAPTION_VERSIONS - 1]);

      const other = await provider(app, owner, scene, { captionText: 'Before.' }, 'Second speaker');
      const before = await readFile(manifestFile(dataDir, scene), 'utf8');
      const body = change(other.contribution.voice.captions.sha256, 'After.');
      await chmod(jobDirOf(dataDir, scene), 0o500);
      let failed;
      try {
        failed = await other.session.post(scene.captions(other.contribution.id), body);
      } finally {
        await chmod(jobDirOf(dataDir, scene), 0o700);
      }
      assert.equal(failed.status, 500);
      assert.equal(await readFile(manifestFile(dataDir, scene), 'utf8'), before, 'no partial change');
      assert.equal((await other.session.request(scene.lookup(other.contribution.id, body.requestId))).status, 404);
      assert.equal((await other.session.post(scene.captions(other.contribution.id), body)).status, 200, 'the same request can be retried');

      await app.close();
      ({ app: restarted } = await workspace(dataDir));
      const reopened = client(restarted.base, restarted.cookie);
      const view = (await reopened.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === other.contribution.id);
      assert.deepEqual([view.voice.captions.version, view.voice.captions.cues[0].text, view.voice.captionHistory.length], [2, 'After.', 1]);
    } finally {
      if (restarted) await restarted.close();
      else await app.close();
    }
  });
});

describe('captions in shared views', () => {
  it('suspends every pin of an earlier version, never revives it for the same words again, and shares only the current version', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await provider(app, owner, scene, { captionText: 'Words A.' });
      const v1 = versionView(1);
      const previews = `${scene.scene}/shares/previews`;
      const link = (sha) => [{ contributionId: contribution.id, viewIds: [v1.id], targetId: 'place', captionSha256: sha }];
      const shaA = contribution.voice.captions.sha256;
      const pending = await (await owner.post(previews, previewBody([v1], link(shaA)))).json();
      const issued = await (await owner.post(previews, previewBody([v1], link(shaA)))).json();
      assert.equal(issued.publicView.contributorRecordings[0].captionVersion, 1);
      const token = await issue(owner, scene, issued);
      const plain = await issue(owner, scene, await (await owner.post(previews, previewBody([v1]))).json());
      const audio = `/api/visit/recordings/${issued.publicView.contributorRecordings[0].id}/audio.wav`;
      assert.equal((await visit(app.base, token, audio)).status, 200);

      const b = await (await session.post(scene.captions(contribution.id), change(shaA, 'Words B.'))).json();
      const a3 = await (await session.post(scene.captions(contribution.id), change(b.contribution.voice.captions.sha256, 'Words A.'))).json();
      assert.equal(a3.appliedCaptionVersion, 3);
      assert.notEqual(a3.contribution.voice.captions.sha256, shaA, 'the same words again are a new version');
      assert.equal((await visit(app.base, token)).status, 404);
      assert.equal((await visit(app.base, token, audio)).status, 404);
      assert.equal((await visit(app.base, token, audio, { method: 'HEAD' })).status, 404);
      assert.equal((await owner.request(`${previews}/${pending.id}`)).status, 409);
      assert.equal((await owner.post(previews, previewBody([v1], link(shaA)))).status, 409, 'the old pin is never revived');
      assert.equal((await visit(app.base, plain)).status, 200, 'an independent snapshot stays available');

      const current = await owner.post(previews, previewBody([v1], link(a3.contribution.voice.captions.sha256)));
      assert.equal(current.status, 201);
      const publicView = (await current.json()).publicView;
      assert.deepEqual([publicView.contributorRecordings[0].captionVersion, publicView.contributorRecordings[0].cues[0].text], [3, 'Words A.']);
      assert.ok(!JSON.stringify(publicView).includes('Words B.'), 'no caption history reaches visitors');

      // A current caption rolled back onto a newer history never counts.
      const manifest = JSON.parse(await readFile(manifestFile(dataDir, scene), 'utf8'));
      const record = manifest.collaboration.contributions.find((item) => item.id === contribution.id);
      record.voice.captions = { ...record.voice.captionHistory[0] };
      delete record.voice.captions.supersededAt;
      await writeFile(manifestFile(dataDir, scene), JSON.stringify(manifest, null, 2));
      assert.equal((await owner.post(previews, previewBody([v1], link(shaA)))).status, 409, 'rolled back');
      assert.equal((await session.post(scene.captions(contribution.id), change(shaA, 'Words C.'))).status, 409, 'no change on a broken chain');
    } finally {
      await app.close();
    }
  });
});

describe('malformed caption history', () => {
  it('refuses a first add or a shared caption when a present history is not an array', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await provider(app, owner, scene);
      const captioned = await provider(app, owner, scene, { captionText: 'Shared words.' }, 'Second speaker');
      const original = await readFile(manifestFile(dataDir, scene), 'utf8');
      const setHistory = async (id, value) => {
        const manifest = JSON.parse(original);
        manifest.collaboration.contributions.find((item) => item.id === id).voice.captionHistory = value;
        await writeFile(manifestFile(dataDir, scene), JSON.stringify(manifest, null, 2));
      };
      const v1 = versionView(1);
      const link = [{ contributionId: captioned.contribution.id, viewIds: [v1.id], targetId: 'place', captionSha256: captioned.contribution.voice.captions.sha256 }];
      for (const malformed of ['', null, {}, { length: 0 }, 0]) {
        await setHistory(contribution.id, malformed);
        assert.equal((await session.post(scene.captions(contribution.id), change(null, 'First words.'))).status, 409, `first add over ${JSON.stringify(malformed)}`);
        await setHistory(captioned.contribution.id, malformed);
        assert.equal((await owner.post(`${scene.scene}/shares/previews`, previewBody([v1], link))).status, 409, `shared caption over ${JSON.stringify(malformed)}`);
      }
      // Absent and an empty array both mean no earlier versions.
      await setHistory(captioned.contribution.id, []);
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, previewBody([v1], link))).status, 201);
      await writeFile(manifestFile(dataDir, scene), original);
      assert.equal((await owner.post(`${scene.scene}/shares/previews`, previewBody([v1], link))).status, 201);
      assert.equal((await session.post(scene.captions(contribution.id), change(null, 'First words.'))).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('malformed current captions', () => {
  it('refuses a first add over a falsy non-null current caption value, and allows null or a missing field', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await provider(app, owner, scene);
      const original = await readFile(manifestFile(dataDir, scene), 'utf8');
      const setCaptions = async (value) => {
        const manifest = JSON.parse(original);
        const voice = manifest.collaboration.contributions.find((item) => item.id === contribution.id).voice;
        if (value === undefined) delete voice.captions;
        else voice.captions = value;
        await writeFile(manifestFile(dataDir, scene), JSON.stringify(manifest, null, 2));
      };
      for (const malformed of [false, 0, '']) {
        await setCaptions(malformed);
        assert.equal((await session.post(scene.captions(contribution.id), change(null, 'First words.'))).status, 409, `over ${JSON.stringify(malformed)}`);
      }
      await setCaptions(undefined);
      assert.equal((await session.post(scene.captions(contribution.id), change(null, 'With the field missing.'))).status, 200);
      await setCaptions(null);
      assert.equal((await session.post(scene.captions(contribution.id), change(null, 'With null.'))).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('owner reviews and caption changes', () => {
  it('shows the owner whether a review saw today’s captions, and refuses a review made against earlier ones', async () => {
    const { app, owner, dataDir } = await workspace();
    try {
      const scene = await place(owner);
      const { session, contribution } = await provider(app, owner, scene, { captionText: 'Reviewed words.' });
      assert.equal((await owner.post(scene.review(contribution.id), reviewBody(1))).status, 200);
      const binding = async () => (await owner.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === contribution.id).review.captionBinding;
      assert.equal(await binding(), 'current');
      const providerView = (await session.json(`${scene.scene}/collaboration`)).contributions[0].review;
      assert.deepEqual(Object.keys(providerView).sort(), ['decision', 'reviewedAt', 'variantId', 'version'], 'the provider view is unchanged');
      const stored = await storedOf(dataDir, scene, contribution.id);
      assert.equal(stored.review.captionSha256, contribution.voice.captions.sha256);

      assert.equal((await session.post(scene.captions(contribution.id), change(contribution.voice.captions.sha256, 'Corrected words.'))).status, 200);
      assert.equal(await binding(), 'changed');
      assert.equal((await owner.json(scene.scene)).edit.version, 2, 'the adopted version is not rewritten');

      const manifest = JSON.parse(await readFile(manifestFile(dataDir, scene), 'utf8'));
      delete manifest.collaboration.contributions.find((item) => item.id === contribution.id).review.captionSha256;
      await writeFile(manifestFile(dataDir, scene), JSON.stringify(manifest, null, 2));
      assert.equal(await binding(), 'unknown');

      // A review prepared against earlier captions cannot commit after a correction.
      const { session: other, contribution: second } = await provider(app, owner, scene, {}, 'Second speaker');
      assert.equal((await other.post(scene.captions(second.id), change(null, 'Added later.'))).status, 200);
      assert.equal((await owner.post(scene.review(second.id), reviewBody(1, { baseVersion: 2 }))).status, 409);
      const holding = await owner.post(scene.review(second.id), { requestId: randomUUID(), baseVersion: 2, baseRevision: 2, decision: 'hold', reason: '', conflict: 'unknown', transform: null });
      assert.equal(holding.status, 200);
      assert.equal((await owner.json(`${scene.scene}/collaboration`)).contributions.find((item) => item.id === second.id).review.captionBinding, null, 'not a geometry review');
    } finally {
      await app.close();
    }
  });
});
