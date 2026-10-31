import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { freshCredentials } from '../access.mjs';
import { client, enrolledContributor, readyScene, sceneRunner, startOwnerServer, SYNTHETIC_PHOTO } from './auth-helper.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function workspace(dataDir) {
  if (!dataDir) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-collab-'));
    tempDirs.push(dataDir);
  }
  const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner });
  return { app, dataDir, owner: client(app.base, app.cookie) };
}

const submission = (change = {}) => ({
  requestId: randomUUID(),
  text: 'The counter stood a little further back from the window when I worked there.',
  permissions: { place: true, model: false, share: false },
  periodClaim: 'the late nineties',
  ...change,
});

const review = (change = {}) => ({
  requestId: randomUUID(), baseVersion: 1, baseRevision: 1, decision: 'adopt', reason: 'Matches the doorway spacing.', conflict: 'unknown',
  transform: { offset: [0, 0, -0.5], yaw: 0 }, ...change,
});

const routes = (scene) => {
  const base = `/api/drafts/${scene.draft.id}/reconstructions/${scene.job.id}`;
  return {
    contributions: `${base}/contributions`,
    collaboration: `${base}/collaboration`,
    review: (id) => `${base}/contributions/${id}/review`,
    withdraw: (id) => `${base}/contributions/${id}/withdraw`,
    era: (id) => `${base}/variants/${id}/era`,
    scene: base,
  };
};

async function expectStatus(response, status, label, method = 'GET') {
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  if (method !== 'HEAD' && status !== 200 && status !== 201) {
    assert.deepEqual(Object.keys(await response.json()), ['error'], label);
  }
}

describe('collaboration route authority', () => {
  it('requires a session, scope and the owner role before any ID, body or existence check', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner);
      const other = await readyScene(owner);
      const { session: contributor } = await enrolledContributor(owner, app.base, scene.draft.id);
      const anonymous = client(app.base);
      const own = routes(scene);
      const foreign = routes(other);
      const unknown = randomUUID();
      const all = (r) => [
        ['GET', r.contributions], ['HEAD', r.contributions], ['POST', r.contributions],
        ['GET', r.collaboration], ['HEAD', r.collaboration],
        ['POST', r.review(unknown)], ['POST', r.withdraw(unknown)], ['POST', r.era(unknown)],
      ];
      const send = (session, [method, route]) => session.request(route, method === 'POST'
        ? { method, headers: { 'content-type': 'application/json' }, body: '{"junk":true}' }
        : { method });

      for (const request of [...all(own), ['GET', '/api/contributor/places'], ['GET', '/api/drafts/not-an-id/reconstructions/x/collaboration']]) {
        await expectStatus(await send(anonymous, request), 401, `anonymous ${request.join(' ')}`, request[0]);
      }
      const unscoped = [...all(foreign), ['GET', `/api/drafts/${unknown}/reconstructions/${unknown}/collaboration`], ['GET', '/api/drafts/not-an-id/reconstructions/x/collaboration']];
      for (const request of unscoped) await expectStatus(await send(contributor, request), 403, `unscoped ${request.join(' ')}`, request[0]);
      for (const request of [['POST', own.review(unknown)], ['POST', own.era(unknown)]]) {
        await expectStatus(await send(contributor, request), 403, `contributor ${request.join(' ')}`);
      }
      const missing = `/api/drafts/${scene.draft.id}/reconstructions/${unknown}/collaboration`;
      await expectStatus(await contributor.request(missing), 404, 'scoped missing scene');
      await expectStatus(await owner.request(missing), 404, 'owner missing scene');
      // Legacy scene and asset routes stay owner only.
      for (const route of [own.scene, scene.asset, scene.original, `${own.scene}/history`]) {
        await expectStatus(await contributor.request(route), 403, `legacy ${route}`);
      }
      await expectStatus(await contributor.post(own.contributions, submission(), { origin: 'http://attacker.example' }), 403, 'cross-site');
    } finally {
      await app.close();
    }
  });

  it('lists only scoped ready places without source details', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner);
      await readyScene(owner);
      const { session: contributor } = await enrolledContributor(owner, app.base, scene.draft.id);
      const places = await contributor.json('/api/contributor/places');
      assert.deepEqual(places.map((place) => Object.keys(place).sort()), [['draftId', 'jobId', 'label', 'version']]);
      assert.equal(places[0].draftId, scene.draft.id);
      assert.equal(places[0].jobId, scene.job.id);
      assert.ok(!JSON.stringify(places).includes(scene.draft.photos[0].sourceId));
      assert.equal((await owner.json('/api/contributor/places')).length, 2);
    } finally {
      await app.close();
    }
  });
});

describe('contributions over HTTP', () => {
  it('projects only a contributor\'s own submissions and gives the owner every attributed original', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner);
      const r = routes(scene);
      const first = await enrolledContributor(owner, app.base, scene.draft.id, 'First contributor');
      const second = await enrolledContributor(owner, app.base, scene.draft.id, 'Second contributor');
      const body = submission();
      const created = await first.session.post(r.contributions, body);
      assert.ok([200, 201].includes(created.status));
      const replay = await first.session.post(r.contributions, body);
      assert.ok([200, 201].includes(replay.status));
      assert.equal((await first.session.post(r.contributions, { ...body, text: 'Changed.' })).status, 409);
      await second.session.post(r.contributions, submission({ text: 'It faced the other way.' }));

      const mine = await first.session.json(r.collaboration);
      assert.deepEqual(mine.variants, []);
      assert.equal(mine.contributions.length, 1);
      assert.equal(mine.contributions[0].text, body.text);
      assert.ok(!JSON.stringify(mine).includes('It faced the other way.'));
      assert.deepEqual(await first.session.json(r.contributions), mine);

      const all = await owner.json(r.collaboration);
      assert.equal(all.contributions.length, 2);
      assert.ok(all.variants.length >= 1);
      const original = all.contributions.find((item) => item.principalId === first.principal.id);
      assert.equal(original.text, body.text);
      assert.equal(original.textSha256, sha256(Buffer.from(body.text, 'utf8')));
    } finally {
      await app.close();
    }
  });

  it('rejects malformed bodies, unknown keys and oversized JSON', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner);
      const r = routes(scene);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      for (const body of [{ ...submission(), extra: 1 }, (({ periodClaim, ...rest }) => rest)(submission()), '{broken', '[]']) {
        await expectStatus(await session.post(r.contributions, body), 400, JSON.stringify(body).slice(0, 60));
      }
      // Limits are in UTF-16 code units, not bytes: 10,000 Korean characters fit
      // whether sent as UTF-8 or with every character escaped.
      const korean = '\uAC00'.repeat(10_000);
      const escaped = (body) => JSON.stringify(body).replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
      await expectStatus(await session.post(r.contributions, submission({ text: '\uAC00'.repeat(10_001) })), 400, 'too long');
      await expectStatus(await session.post(r.contributions, escaped(submission({ text: '\uAC00'.repeat(10_001) }))), 400, 'too long escaped');
      await expectStatus(await session.post(r.contributions, 'x'.repeat(64 * 1024 + 1)), 413, 'oversized');
      // Other JSON routes keep the 16KiB cap.
      await expectStatus(await session.post(r.withdraw(randomUUID()), { requestId: 'x'.repeat(17_000) }), 413, 'other route cap');
      assert.deepEqual((await session.json(r.collaboration)).contributions, []);

      const plain = submission({ text: korean });
      assert.ok(Buffer.byteLength(JSON.stringify(plain)) > 16 * 1024);
      assert.equal((await session.post(r.contributions, plain)).status, 200);
      const escapedBody = escaped(submission({ text: korean }));
      assert.ok(Buffer.byteLength(escapedBody) > 60_000 && Buffer.byteLength(escapedBody) < 64 * 1024);
      assert.equal((await session.post(r.contributions, escapedBody)).status, 200);
      const stored = (await session.json(r.collaboration)).contributions;
      assert.equal(stored.length, 2);
      assert.ok(stored.every((item) => item.text === korean));
    } finally {
      await app.close();
    }
  });
});

describe('review, alternatives, eras and withdrawal over HTTP', () => {
  it('adopts as a new saved version, keeps an alternative without moving the scene, and records an era assertion', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner);
      const r = routes(scene);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      await session.post(r.contributions, submission());
      await session.post(r.contributions, submission({ text: 'From the doorway it looked turned.' }));
      const [a, b] = (await owner.json(r.collaboration)).contributions;

      const adopted = await owner.post(r.review(a.id), review());
      assert.equal(adopted.status, 200);
      const job = await owner.json(r.scene);
      assert.deepEqual(job.edit, { version: 2, offset: [0, 0, -0.5], yaw: 0 });
      assert.equal((await owner.json(`${r.scene}/history`)).at(-1).kind, 'contribution');

      const kept = await owner.post(r.review(b.id), review({ baseVersion: 2, decision: 'alternative', conflict: 'viewpoint', transform: { offset: [0, 0, 0], yaw: 0.4 } }));
      assert.equal(kept.status, 200);
      assert.deepEqual((await owner.json(r.scene)).edit, job.edit);
      const state = await owner.json(r.collaboration);
      // An immutable alternative is not a main saved version: it records its parent instead.
      const alternative = state.variants.find((variant) => variant.contributionIds.includes(b.id));
      assert.ok(alternative);
      assert.equal(alternative.parentVersion, 2);
      assert.deepEqual(alternative.edit, { version: null, offset: [0, 0, 0], yaw: 0.4 });
      assert.equal(alternative.era.kind, 'unknown');

      const era = { requestId: randomUUID(), baseRevision: alternative.eraRevision, kind: 'relative', label: 'before the renovation', start: null, end: null, statement: 'The owner remembers this layout before the renovation.', relation: null, relativeToVariantId: null, confirmed: true };
      await expectStatus(await session.post(r.era(alternative.id), era), 403, 'contributor era');
      const asserted = await owner.post(r.era(alternative.id), era);
      assert.equal(asserted.status, 200);
      const recorded = (await owner.json(r.collaboration)).variants.find((variant) => variant.id === alternative.id).era;
      assert.equal(recorded.kind, 'relative');
      assert.equal(recorded.start, null);
      assert.equal(recorded.end, null);
      assert.equal(recorded.label, era.label);
      assert.equal(recorded.statement, era.statement);
      assert.doesNotMatch(`${recorded.label} ${recorded.statement}`, /\d{4}/, 'no invented year');
      assert.equal((await owner.post(r.era(alternative.id), era)).status, 200);
      assert.equal((await owner.post(r.era(alternative.id), { ...era, label: 'changed' })).status, 409);

      // Owner notes stay private: the provider sees fixed statuses, links and times only.
      const own = await session.json(r.collaboration);
      assert.deepEqual(own.variants, []);
      const shared = JSON.stringify(own);
      for (const ownerText of ['Matches the doorway spacing.', 'viewpoint', 'before the renovation', 'owner remembers']) {
        assert.ok(!shared.includes(ownerText), ownerText);
      }
      assert.deepEqual(own.contributions.map((item) => item.status).sort(), ['adopted', 'alternative']);
    } finally {
      await app.close();
    }
  });

  it('lets the provider withdraw after invitation revocation and recovery, then blocks dependent assets until an unaffected undo', async () => {
    const { app, owner } = await workspace();
    try {
      const scene = await readyScene(owner);
      const r = routes(scene);
      const contributor = await enrolledContributor(owner, app.base, scene.draft.id);
      await contributor.session.post(r.contributions, submission());
      const [item] = (await owner.json(r.collaboration)).contributions;
      assert.equal((await owner.post(r.review(item.id), review())).status, 200);

      assert.equal((await owner.post(`/api/invitations/${contributor.invite.id}/revoke`, {})).status, 200);
      const fresh = freshCredentials();
      assert.equal((await contributor.session.post('/api/session/recover', { recoveryKey: contributor.keys.recoveryKey, newAccessKey: fresh.accessKey, newRecoveryKey: fresh.recoveryKey })).status, 200);
      const recovered = client(app.base);
      assert.equal((await recovered.login(fresh.accessKey)).status, 200);

      await expectStatus(await owner.post(r.withdraw(item.id), { requestId: randomUUID() }), 403, 'owner withdrawing another provider');
      const withdrawBody = { requestId: randomUUID() };
      assert.equal((await recovered.post(r.withdraw(item.id), withdrawBody)).status, 200);
      assert.equal((await recovered.post(r.withdraw(item.id), withdrawBody)).status, 200);

      const state = await owner.json(r.collaboration);
      assert.equal(state.contributions[0].text, null);
      assert.ok(state.contributions[0].withdrawnAt);
      assert.equal((await owner.json(r.scene)).usageBlocked, true);
      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-3' } }]) {
        assert.equal((await owner.request(scene.asset, init)).status, 409, JSON.stringify(init));
      }
      assert.equal((await owner.post(`${r.scene}/edit`, { requestId: randomUUID(), baseVersion: 2, offset: [0, 0, 0], yaw: 0 })).status, 409);

      const undone = await owner.post(`${r.scene}/undo`, { requestId: randomUUID(), baseVersion: 2, targetVersion: 1 });
      assert.equal(undone.status, 200);
      assert.equal((await owner.request(scene.asset)).status, 200);
      const photo = await owner.request(scene.original);
      assert.equal(sha256(Buffer.from(await photo.arrayBuffer())), sha256(SYNTHETIC_PHOTO));
    } finally {
      await app.close();
    }
  });

  it('refuses hosted model planning on a scene that depends on a contribution without model permission', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-collab-'));
    tempDirs.push(dataDir);
    const calls = [];
    const proposalModel = async (call) => {
      calls.push(call);
      return { ok: false, reason: 'provider', model: null, responseId: null, usage: null };
    };
    const app = await startOwnerServer({ dataDir, reconstructionRunner: sceneRunner, proposalModel, prepareModelImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    const owner = client(app.base, app.cookie);
    try {
      const scene = await readyScene(owner);
      const r = routes(scene);
      const { session } = await enrolledContributor(owner, app.base, scene.draft.id);
      await session.post(r.contributions, submission({ permissions: { place: true, model: false, share: false } }));
      const [item] = (await owner.json(r.collaboration)).contributions;
      assert.equal((await owner.post(r.review(item.id), review())).status, 200);
      const proposal = await owner.post(`${r.scene}/proposals`, { requestId: randomUUID(), baseVersion: 2, text: 'Turn it toward the light.', consent: true });
      assert.ok([403, 409].includes(proposal.status), String(proposal.status));
      assert.equal(calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('keeps contributions, reviews and withdrawals across a restart', async () => {
    const first = await workspace();
    const scene = await readyScene(first.owner);
    const r = routes(scene);
    const { session, keys } = await enrolledContributor(first.owner, first.app.base, scene.draft.id);
    await session.post(r.contributions, submission());
    const before = await first.owner.json(r.collaboration);
    await first.app.close();
    const second = await workspace(first.dataDir);
    try {
      assert.deepEqual(await second.owner.json(r.collaboration), before);
      const again = client(second.app.base);
      assert.equal((await again.login(keys.accessKey)).status, 200);
      assert.equal((await again.json(r.collaboration)).contributions.length, 1);
      const stored = await readFile(path.join(first.dataDir, 'access.json'), 'utf8');
      assert.ok(!stored.includes(keys.accessKey));
    } finally {
      await second.app.close();
    }
  });
});
