import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AccessStore, SESSION_LIMITS, freshCredentials, generateSecret, isToken } from '../access.mjs';
import { RequestError } from '../drafts.mjs';

const MINUTE = 60_000;
const MODULE = new URL('../access.mjs', import.meta.url).href;

// Runs bootstrap in a separate Node process, starting at a shared instant so
// competing initializers overlap; resolves to the principal or the error status.
async function bootstrapInProcess(dataDir, input, startAt) {
  const script = `
    const { AccessStore } = await import(${JSON.stringify(MODULE)});
    const [dataDir, input, startAt] = JSON.parse(process.argv[1]);
    while (Date.now() < startAt);
    try {
      process.stdout.write(JSON.stringify({ principal: await new AccessStore({ dataDir }).bootstrap(input) }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: error.status ?? 'unexpected' }));
    }`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([dataDir, input, startAt])],
    { cwd: path.dirname(fileURLToPath(MODULE)), timeout: 20_000 });
  return JSON.parse(stdout);
}
const HOUR = 60 * MINUTE;

function clock(start = Date.parse('2026-01-01T00:00:00Z')) {
  const now = () => now.value;
  now.value = start;
  now.advance = ms => { now.value += ms; };
  return now;
}

const status = code => error => error instanceof RequestError && error.status === code;

function enrollment(name = 'Owner') {
  return { requestId: randomUUID(), displayName: name, ...freshCredentials() };
}

describe('access store', () => {
  let dir, now, store, owner, ownerKeys;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rehere-access-'));
    now = clock();
    store = new AccessStore({ dataDir: dir, now });
    ownerKeys = enrollment();
    owner = await store.bootstrap(ownerKeys);
  });

  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const reopen = () => new AccessStore({ dataDir: dir, now });
  const diskText = () => readFile(path.join(dir, 'access.json'), 'utf8');

  async function invite(overrides = {}) {
    const token = generateSecret('invitation');
    const input = { requestId: randomUUID(), draftId: randomUUID(), expiresInHours: 24, token, ...overrides };
    return { input, invitation: await store.createInvitation(owner.id, input) };
  }

  describe('credentials', () => {
    it('generates distinct, strictly formatted credentials per family', () => {
      const { accessKey, recoveryKey } = freshCredentials();
      assert.ok(isToken(accessKey, 'access') && isToken(recoveryKey, 'recovery'));
      assert.ok(!isToken(accessKey, 'recovery') && !isToken(recoveryKey, 'access'));
      assert.notEqual(freshCredentials().accessKey, accessKey);
      const body = accessKey.slice(4);
      for (const bad of [`${accessKey}A`, accessKey.slice(0, -1), `rha_${body.slice(0, -1)}+`, ` ${accessKey}`, `RHA_${body}`, null, 42]) {
        assert.equal(isToken(bad, 'access'), false, String(bad));
      }
    });

    it('rejects keys from another family everywhere', async () => {
      await assert.rejects(store.login(ownerKeys.recoveryKey), status(401));
      await assert.rejects(store.recover({ recoveryKey: ownerKeys.accessKey, ...freshNewKeys() }), status(401));
      const { sessionToken } = await store.login(ownerKeys.accessKey);
      assert.equal(await store.session(ownerKeys.accessKey), null);
      await assert.rejects(store.login(sessionToken), status(401));
      const { input } = await invite();
      await assert.rejects(store.login(input.token), status(401));
    });
  });

  function freshNewKeys() {
    const { accessKey, recoveryKey } = freshCredentials();
    return { newAccessKey: accessKey, newRecoveryKey: recoveryKey };
  }

  describe('bootstrap', () => {
    it('creates one owner, replays exactly, and refuses a second or changed bootstrap', async () => {
      assert.deepEqual(owner, { id: owner.id, role: 'owner', displayName: 'Owner', draftIds: [] });
      assert.deepEqual(await store.state(), { initialized: true });
      assert.deepEqual(await store.bootstrap(ownerKeys), owner);
      assert.deepEqual(await reopen().bootstrap(ownerKeys), owner);
      await assert.rejects(store.bootstrap({ ...ownerKeys, displayName: 'Other' }), status(409));
      await assert.rejects(store.bootstrap({ ...ownerKeys, accessKey: freshCredentials().accessKey }), status(409));
      await assert.rejects(store.bootstrap(enrollment('Second')), status(409));
    });

    it('replays the initial bootstrap after recovery without restoring the old keys', async () => {
      const keys = freshNewKeys();
      await store.recover({ recoveryKey: ownerKeys.recoveryKey, ...keys });
      assert.deepEqual(await store.bootstrap(ownerKeys), owner);
      await assert.rejects(store.login(ownerKeys.accessKey), status(401));
      await assert.rejects(store.recover({ recoveryKey: ownerKeys.recoveryKey, ...freshNewKeys() }), status(401));
      assert.deepEqual((await reopen().login(keys.newAccessKey)).principal, owner);
    });

    it('reports an uninitialized store and validates names and request IDs', async () => {
      const fresh = new AccessStore({ dataDir: path.join(dir, 'empty'), now });
      assert.deepEqual(await fresh.state(), { initialized: false });
      for (const displayName of ['', '   ', 'a'.repeat(81), 'bad\u0007name', 7]) {
        await assert.rejects(fresh.bootstrap({ ...enrollment(), displayName }), status(400));
      }
      await assert.rejects(fresh.bootstrap({ ...enrollment(), requestId: 'not-a-uuid' }), status(400));
      assert.deepEqual(await fresh.state(), { initialized: false });
      const named = await fresh.bootstrap({ ...enrollment(), displayName: '  \u00e9'.padEnd(82, '\u00e9') });
      assert.equal([...named.displayName].length, 80);
    });
  });

  describe('sessions', () => {
    it('logs in with a new random session and rejects unknown keys without changing state', async () => {
      const before = await diskText();
      await assert.rejects(store.login(freshCredentials().accessKey), error => status(401)(error) && error.message === 'The key was not accepted.');
      await assert.rejects(store.login('rha_short'), status(401));
      assert.equal(await diskText(), before);
      const first = await store.login(ownerKeys.accessKey);
      const second = await store.login(ownerKeys.accessKey);
      assert.notEqual(first.sessionToken, second.sessionToken);
      assert.ok(isToken(first.sessionToken, 'session'));
      assert.deepEqual(first.principal, owner);
      assert.equal(first.expiresAt, new Date(now() + 12 * HOUR).toISOString());
      assert.deepEqual(await store.session(first.sessionToken), owner);
    });

    it('expires sessions after 30 idle minutes and 12 absolute hours, exactly at the bound', async () => {
      const idle = await store.login(ownerKeys.accessKey);
      now.advance(SESSION_LIMITS.idleMs - 1);
      assert.deepEqual(await store.session(idle.sessionToken), owner);
      now.advance(SESSION_LIMITS.idleMs);
      assert.equal(await store.session(idle.sessionToken), null);

      const active = await store.login(ownerKeys.accessKey);
      for (let elapsed = 0; elapsed < 12 * HOUR - 20 * MINUTE; elapsed += 20 * MINUTE) {
        now.advance(20 * MINUTE);
        assert.deepEqual(await store.session(active.sessionToken), owner);
      }
      now.value = Date.parse(active.expiresAt) - 1;
      assert.deepEqual(await store.session(active.sessionToken), owner);
      now.advance(1);
      assert.equal(await store.session(active.sessionToken), null);
    });

    it('measures idle time from the latest activity, also after restart', async () => {
      const { sessionToken } = await store.login(ownerKeys.accessKey);
      now.advance(30_000);
      assert.deepEqual(await store.session(sessionToken), owner);
      const touched = now();
      assert.equal(JSON.parse(await diskText()).sessions[0].lastSeenAt, touched);
      now.value = touched + SESSION_LIMITS.idleMs - 1;
      assert.deepEqual(await reopen().session(sessionToken), owner);
      now.value += SESSION_LIMITS.idleMs;
      assert.equal(await reopen().session(sessionToken), null);
    });

    it('persists sessions and activity across restart', async () => {
      const { sessionToken } = await store.login(ownerKeys.accessKey);
      now.advance(25 * MINUTE);
      assert.deepEqual(await store.session(sessionToken), owner);
      now.advance(25 * MINUTE);
      assert.deepEqual(await reopen().session(sessionToken), owner);
      now.advance(SESSION_LIMITS.idleMs);
      assert.equal(await reopen().session(sessionToken), null);
    });

    it('keeps at most ten sessions per principal, discarding the oldest', async () => {
      const tokens = [];
      for (let i = 0; i < 11; i++) {
        tokens.push((await store.login(ownerKeys.accessKey)).sessionToken);
        now.advance(1);
      }
      assert.equal(await store.session(tokens[0]), null);
      for (const token of tokens.slice(1)) assert.deepEqual(await store.session(token), owner);
    });

    it('logs out one session harmlessly and repeatably', async () => {
      const kept = await store.login(ownerKeys.accessKey);
      const ended = await store.login(ownerKeys.accessKey);
      await store.logout(ended.sessionToken);
      await store.logout(ended.sessionToken);
      await store.logout(generateSecret('session'));
      await store.logout('garbage');
      assert.equal(await store.session(ended.sessionToken), null);
      assert.deepEqual(await store.session(kept.sessionToken), owner);
    });
  });

  describe('recovery', () => {
    it('replaces both keys, revokes all sessions, and keeps identity and grants', async () => {
      const { input } = await invite();
      const contributorKeys = enrollment('Helper');
      const contributor = await store.redeemInvitation({ token: input.token, ...contributorKeys });
      const ownerSession = await store.login(ownerKeys.accessKey);
      const contributorSession = await store.login(contributorKeys.accessKey);

      const keys = freshNewKeys();
      const recovered = await store.recover({ recoveryKey: contributorKeys.recoveryKey, ...keys });
      assert.deepEqual(recovered, contributor);
      assert.deepEqual(recovered.draftIds, [input.draftId]);
      assert.equal(await store.session(contributorSession.sessionToken), null);
      assert.deepEqual(await store.session(ownerSession.sessionToken), owner);
      await assert.rejects(store.login(contributorKeys.accessKey), status(401));
      await assert.rejects(store.recover({ recoveryKey: contributorKeys.recoveryKey, ...freshNewKeys() }), status(401));
      assert.deepEqual((await store.login(keys.newAccessKey)).principal, contributor);
    });

    it('rejects reused or malformed new keys without changing anything', async () => {
      const before = await diskText();
      const reused = [
        { newAccessKey: ownerKeys.accessKey, newRecoveryKey: freshCredentials().recoveryKey },
        { newAccessKey: freshCredentials().accessKey, newRecoveryKey: ownerKeys.recoveryKey },
      ];
      for (const keys of reused) await assert.rejects(store.recover({ recoveryKey: ownerKeys.recoveryKey, ...keys }), status(409));
      await assert.rejects(store.recover({ recoveryKey: ownerKeys.recoveryKey, newAccessKey: 'rha_x', newRecoveryKey: freshCredentials().recoveryKey }), status(400));
      assert.equal(await diskText(), before);

      const first = freshNewKeys();
      await store.recover({ recoveryKey: ownerKeys.recoveryKey, ...first });
      const back = { newAccessKey: ownerKeys.accessKey, newRecoveryKey: ownerKeys.recoveryKey };
      await assert.rejects(store.recover({ recoveryKey: first.newRecoveryKey, ...back }), status(409));
    });

    it('never accepts any earlier key again, even after many rotations', async () => {
      const initial = { newAccessKey: ownerKeys.accessKey, newRecoveryKey: ownerKeys.recoveryKey };
      let recoveryKey = ownerKeys.recoveryKey;
      for (let i = 0; i < 25; i++) {
        const keys = freshNewKeys();
        await store.recover({ recoveryKey, ...keys });
        recoveryKey = keys.newRecoveryKey;
      }
      await assert.rejects(store.recover({ recoveryKey, ...initial }), status(409));
      await assert.rejects(store.login(ownerKeys.accessKey), status(401));
    });

    it('leaves the old credentials valid when the state write fails', async () => {
      const keys = freshNewKeys();
      await chmod(dir, 0o500);
      await assert.rejects(store.recover({ recoveryKey: ownerKeys.recoveryKey, ...keys }), status(503));
      await chmod(dir, 0o700);
      assert.deepEqual((await store.login(ownerKeys.accessKey)).principal, owner);
      await assert.rejects(store.login(keys.newAccessKey), status(401));
      assert.deepEqual((await reopen().login(ownerKeys.accessKey)).principal, owner);
      assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
    });
  });

  describe('invitations', () => {
    it('creates owner-only invitations with exact replay and bounded expiry', async () => {
      const { input, invitation } = await invite();
      assert.deepEqual(Object.keys(invitation).sort(), ['draftId', 'expiresAt', 'id', 'status']);
      assert.equal(invitation.status, 'active');
      assert.equal(invitation.expiresAt, new Date(now() + 24 * HOUR).toISOString());
      assert.deepEqual(await store.createInvitation(owner.id, input), invitation);
      for (const change of [{ draftId: randomUUID() }, { expiresInHours: 2 }, { token: generateSecret('invitation') }]) {
        await assert.rejects(store.createInvitation(owner.id, { ...input, ...change }), status(409));
      }
      await assert.rejects(store.createInvitation(owner.id, { ...input, requestId: randomUUID() }), status(409));
      for (const expiresInHours of [0, 73, 1.5, '24']) {
        await assert.rejects(store.createInvitation(owner.id, { ...input, requestId: randomUUID(), token: generateSecret('invitation'), expiresInHours }), status(400));
      }
      await assert.rejects(store.createInvitation(randomUUID(), { ...input, requestId: randomUUID() }), status(403));
      assert.deepEqual(await store.invitations(owner.id), [invitation]);
    });

    it('enrolls exactly one scoped contributor per invitation with exact replay', async () => {
      const { input, invitation } = await invite();
      const keys = enrollment('Helper');
      const contributor = await store.redeemInvitation({ token: input.token, ...keys });
      assert.deepEqual(contributor, { id: contributor.id, role: 'contributor', displayName: 'Helper', draftIds: [input.draftId] });
      assert.deepEqual(await store.redeemInvitation({ token: input.token, ...keys }), contributor);
      await assert.rejects(store.redeemInvitation({ token: input.token, ...enrollment('Other') }), status(409));
      await assert.rejects(store.redeemInvitation({ token: input.token, ...keys, displayName: 'Renamed' }), status(409));
      assert.equal((await store.invitations(owner.id))[0].status, 'redeemed');
      assert.deepEqual(await store.revokeInvitation(owner.id, invitation.id), { ...invitation, status: 'redeemed' });

      await assert.rejects(store.invitations(contributor.id), status(403));
      await assert.rejects(store.createInvitation(contributor.id, { requestId: randomUUID(), draftId: randomUUID(), expiresInHours: 1, token: generateSecret('invitation') }), status(403));
      await assert.rejects(store.revokeInvitation(contributor.id, invitation.id), status(403));
      assert.deepEqual((await store.login(keys.accessKey)).principal, contributor);
    });

    it('refuses revoked, expired, unknown and malformed invitations generically', async () => {
      const revoked = await invite();
      assert.equal((await store.revokeInvitation(owner.id, revoked.invitation.id)).status, 'revoked');
      const expired = await invite({ expiresInHours: 1 });
      now.advance(HOUR);
      assert.equal((await store.invitations(owner.id)).find(item => item.id === expired.invitation.id).status, 'expired');
      for (const token of [revoked.input.token, expired.input.token, generateSecret('invitation'), 'rhi_bad', ownerKeys.accessKey]) {
        await assert.rejects(store.redeemInvitation({ token, ...enrollment('Helper') }), error => status(403)(error) && error.message === 'This action is not allowed.');
      }
      await assert.rejects(store.revokeInvitation(owner.id, randomUUID()), status(403));
      const reuse = { requestId: randomUUID(), draftId: randomUUID(), expiresInHours: 24 };
      for (const token of [revoked.input.token, expired.input.token]) {
        await assert.rejects(store.createInvitation(owner.id, { ...reuse, token }), status(409));
      }
    });

    it('rejects enrollment that reuses an existing key or request ID', async () => {
      const first = await invite();
      const second = await invite();
      const keys = enrollment('Helper');
      await store.redeemInvitation({ token: first.input.token, ...keys });
      await assert.rejects(store.redeemInvitation({ token: second.input.token, ...enrollment('B'), accessKey: ownerKeys.accessKey }), status(409));
      await assert.rejects(store.redeemInvitation({ token: second.input.token, ...enrollment('B'), requestId: keys.requestId }), status(409));
      assert.equal((await store.invitations(owner.id)).find(item => item.id === second.invitation.id).status, 'active');
    });

    it('keeps contributor access and recovery after the invitation expires or is revoked', async () => {
      const { input, invitation } = await invite({ expiresInHours: 1 });
      const keys = enrollment('Helper');
      const contributor = await store.redeemInvitation({ token: input.token, ...keys });
      await store.revokeInvitation(owner.id, invitation.id);
      now.advance(2 * HOUR);
      const newKeys = freshNewKeys();
      assert.deepEqual(await store.recover({ recoveryKey: keys.recoveryKey, ...newKeys }), contributor);
      assert.deepEqual(await store.redeemInvitation({ token: input.token, ...keys }), contributor);
      await assert.rejects(store.login(keys.accessKey), status(401));
      assert.deepEqual((await reopen().login(newKeys.newAccessKey)).principal, contributor);
    });
  });

  describe('cross-process bootstrap', () => {
    it('lets exactly one of two competing processes create the owner', async () => {
      const shared = path.join(dir, 'race');
      const startAt = Date.now() + 1500;
      const results = await Promise.all([enrollment('A'), enrollment('B')].map(input => bootstrapInProcess(shared, input, startAt)));
      assert.equal(results.filter(result => result.principal).length, 1);
      assert.deepEqual(results.filter(result => result.status).map(result => result.status), [409]);
      const winner = results.find(result => result.principal).principal;
      assert.equal((await readdir(shared)).filter(name => name.endsWith('.tmp')).length, 0);
      assert.equal(JSON.parse(await readFile(path.join(shared, 'access.json'), 'utf8')).principals[0].id, winner.id);
    });

    it('resolves stores that both read an empty state through the exclusive link', async () => {
      const shared = path.join(dir, 'link');
      const stores = [new AccessStore({ dataDir: shared, now }), new AccessStore({ dataDir: shared, now })];
      const results = await Promise.allSettled([stores[0].bootstrap(enrollment('A')), stores[1].bootstrap(enrollment('B'))]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(status(409)(results.find(result => result.status === 'rejected').reason));
      const winner = results.find(result => result.status === 'fulfilled').value;
      for (const item of stores) assert.deepEqual(await item.state(), { initialized: true });
      assert.equal(JSON.parse(await readFile(path.join(shared, 'access.json'), 'utf8')).principals[0].id, winner.id);
    });

    it('returns the same owner to concurrent exact replays', async () => {
      const shared = path.join(dir, 'replay');
      const input = enrollment('Same');
      const startAt = Date.now() + 1500;
      const results = await Promise.all([input, input].map(item => bootstrapInProcess(shared, item, startAt)));
      assert.ok(results.every(result => result.principal));
      assert.deepEqual(results[0].principal, results[1].principal);
    });

    it('lets a server that saw no owner authenticate after another process initializes', async () => {
      const shared = path.join(dir, 'observer');
      const server = new AccessStore({ dataDir: shared, now });
      assert.deepEqual(await server.state(), { initialized: false });
      await assert.rejects(server.login(freshCredentials().accessKey), status(401));
      const input = enrollment('Later');
      const { principal } = await bootstrapInProcess(shared, input, Date.now());
      assert.deepEqual(await server.state(), { initialized: true });
      const { sessionToken } = await server.login(input.accessKey);
      assert.deepEqual(await server.session(sessionToken), principal);
    });

    it('cannot let a late initializer overwrite later recovery and sessions', async () => {
      const keys = freshNewKeys();
      await store.recover({ recoveryKey: ownerKeys.recoveryKey, ...keys });
      const { sessionToken } = await store.login(keys.newAccessKey);
      const before = await diskText();
      assert.deepEqual(await bootstrapInProcess(dir, enrollment('Late'), Date.now()), { status: 409 });
      assert.deepEqual(await bootstrapInProcess(dir, ownerKeys, Date.now()), { principal: owner });
      assert.equal(await diskText(), before);
      assert.deepEqual(await reopen().session(sessionToken), owner);
      await assert.rejects(reopen().login(ownerKeys.accessKey), status(401));
    });
  });

  describe('storage', () => {
    it('stores only verifiers and never exposes them', async () => {
      const { input } = await invite();
      const keys = enrollment('Helper');
      await store.redeemInvitation({ token: input.token, ...keys });
      const { sessionToken } = await store.login(ownerKeys.accessKey);
      const text = await diskText();
      for (const secret of [ownerKeys.accessKey, ownerKeys.recoveryKey, keys.accessKey, keys.recoveryKey, input.token, sessionToken]) {
        assert.ok(!text.includes(secret) && !text.includes(secret.slice(4)), 'raw secret written to disk');
      }
      assert.equal(JSON.parse(text).schemaVersion, 1);
      const shown = JSON.stringify([owner, await store.session(sessionToken), await store.invitations(owner.id)]);
      assert.doesNotMatch(shown, /[0-9a-f]{64}|erifier|requestId|eceipt/);
    });

    it('fails closed on corrupt state', async () => {
      const { sessionToken } = await store.login(ownerKeys.accessKey);
      const file = path.join(dir, 'access.json');
      for (const corrupt of ['{not json', JSON.stringify({ schemaVersion: 2, principals: [], sessions: [], invitations: [] }),
        JSON.stringify({ ...JSON.parse(await diskText()), sessions: [{ verifier: 'x' }] })]) {
        await writeFile(file, corrupt);
        const broken = reopen();
        await assert.rejects(broken.session(sessionToken), status(503));
        await assert.rejects(broken.login(ownerKeys.accessKey), status(503));
        await assert.rejects(broken.state(), status(503));
      }
    });

    it('fails closed when an edited file would let a contributor session resolve as the owner', async () => {
      const { input } = await invite();
      const keys = enrollment('Helper');
      const contributor = await store.redeemInvitation({ token: input.token, ...keys });
      const { sessionToken } = await store.login(keys.accessKey);
      const file = path.join(dir, 'access.json');
      const valid = JSON.parse(await diskText());
      const edit = change => { const copy = structuredClone(valid); change(copy); return copy; };
      const ownerRow = state => state.principals.find(item => item.role === 'owner');
      const contributorRow = state => state.principals.find(item => item.role === 'contributor');
      const corruptions = {
        'duplicate principal ID': state => { ownerRow(state).id = contributor.id; },
        'session for unknown principal': state => { state.sessions[0].principalId = randomUUID(); },
        'duplicate session': state => { state.sessions.push({ ...state.sessions[0] }); },
        'shared access key': state => { contributorRow(state).accessVerifier = ownerRow(state).accessVerifier; },
        'retired key reused': state => { ownerRow(state).retiredVerifiers.push(contributorRow(state).recoveryVerifier); },
        'redeemed by owner': state => { state.invitations[0].redeemedBy = ownerRow(state).id; },
        'grant outside invitation': state => { contributorRow(state).draftIds = [randomUUID()]; },
        'contributor without invitation': state => { state.invitations[0].status = 'revoked'; state.invitations[0].redeemedBy = null; },
        'owner with draft grant': state => { ownerRow(state).draftIds = [input.draftId]; },
        'second owner': state => { contributorRow(state).role = 'owner'; },
        'invitation from unknown owner': state => { state.invitations[0].ownerId = randomUUID(); },
      };
      for (const [name, change] of Object.entries(corruptions)) {
        await writeFile(file, JSON.stringify(edit(change)));
        await assert.rejects(reopen().session(sessionToken), status(503), name);
      }
      await writeFile(file, JSON.stringify(valid));
      assert.deepEqual(await reopen().session(sessionToken), contributor);
    });

    it('serializes concurrent redemptions of one invitation', async () => {
      const { input } = await invite();
      const results = await Promise.allSettled([1, 2, 3].map(i => store.redeemInvitation({ token: input.token, ...enrollment(`H${i}`) })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(results.filter(result => result.status === 'rejected').every(result => status(409)(result.reason)));
    });
  });
});
