import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from './drafts.mjs';

// Credentials are 32 random bytes, base64url, behind a family prefix so a key
// from one family can never be accepted where another is expected.
export const PREFIXES = Object.freeze({ access: 'rha_', recovery: 'rhr_', session: 'rhs_', invitation: 'rhi_' });
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 3_600_000;
export const SESSION_LIMITS = Object.freeze({ absoluteMs: 12 * HOUR, idleMs: 30 * 60_000, perPrincipal: 10 });
const NAME_CHARS = 80;

const MESSAGES = {
  400: 'The access request could not be read.',
  401: 'The key was not accepted.',
  403: 'This action is not allowed.',
  409: 'This request conflicts with the current access state.',
  503: 'Access state is unavailable.',
};
const fail = status => new RequestError(status, MESSAGES[status]);

export function generateSecret(family) {
  if (!Object.hasOwn(PREFIXES, family)) throw new TypeError('unknown credential family');
  return PREFIXES[family] + randomBytes(32).toString('base64url');
}

export function freshCredentials() {
  return { accessKey: generateSecret('access'), recoveryKey: generateSecret('recovery') };
}

export function isToken(value, family) {
  if (typeof value !== 'string' || !value.startsWith(PREFIXES[family])) return false;
  const body = value.slice(PREFIXES[family].length);
  // Re-encoding rejects non-canonical final characters that decode to the same bytes.
  return TOKEN_BODY.test(body) && Buffer.from(body, 'base64url').toString('base64url') === body;
}

const verifier = token => createHash('sha256').update(token).digest('hex');
const enrollmentReceipt = ({ requestId, displayName, accessKey, recoveryKey }) =>
  verifier(JSON.stringify([requestId, displayName, verifier(accessKey), verifier(recoveryKey)]));

function sameVerifier(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length
    && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Visits every candidate so the comparison time does not reveal which one matched.
function findByVerifier(items, field, digest) {
  let found = null;
  for (const item of items) if (sameVerifier(item[field], digest) && !found) found = item;
  return found;
}

function requireToken(value, family, status) {
  if (!isToken(value, family)) throw fail(status);
  return value;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(400);
  return value;
}

function requireName(value) {
  if (typeof value !== 'string') throw fail(400);
  const name = value.trim();
  if (!name || [...name].length > NAME_CHARS || /\p{Cc}/u.test(name)) throw fail(400);
  return name;
}

function publicPrincipal(principal) {
  return { id: principal.id, role: principal.role, displayName: principal.displayName, draftIds: [...principal.draftIds] };
}

const emptyState = () => ({ schemaVersion: 1, principals: [], sessions: [], invitations: [] });

const DIGEST = /^[0-9a-f]{64}$/;
const isDigest = value => typeof value === 'string' && DIGEST.test(value);

const unique = values => new Set(values).size === values.length;

// Persisted state is trusted only when every record is well formed, every ID,
// credential and request is unique, and every reference points at the right
// record; otherwise a corrupt or edited file could merge or escalate identities.
function validState(state) {
  if (!state || state.schemaVersion !== 1 || !['principals', 'sessions', 'invitations'].every(key => Array.isArray(state[key]))) return false;
  const { principals, sessions, invitations } = state;
  const wellFormed = principals.every(item => UUID.test(item?.id) && ['owner', 'contributor'].includes(item.role)
      && typeof item.displayName === 'string' && UUID.test(item.requestId) && Array.isArray(item.draftIds) && item.draftIds.every(id => UUID.test(id))
      && isDigest(item.accessVerifier) && isDigest(item.recoveryVerifier) && isDigest(item.enrollmentReceipt)
      && Array.isArray(item.retiredVerifiers) && item.retiredVerifiers.every(isDigest))
    && sessions.every(item => isDigest(item?.verifier) && UUID.test(item.principalId)
      && Number.isFinite(item.createdAt) && Number.isFinite(item.lastSeenAt) && item.createdAt <= item.lastSeenAt)
    && invitations.every(item => UUID.test(item?.id) && UUID.test(item.requestId) && UUID.test(item.draftId) && UUID.test(item.ownerId)
      && isDigest(item.tokenVerifier) && ['active', 'redeemed', 'revoked'].includes(item.status) && Number.isFinite(Date.parse(item.expiresAt)));
  if (!wellFormed) return false;
  const owners = principals.filter(item => item.role === 'owner');
  if (principals.length && (owners.length !== 1 || owners[0].draftIds.length !== 0)) return false;
  const byId = new Map(principals.map(item => [item.id, item]));
  const credentials = principals.flatMap(item => [item.accessVerifier, item.recoveryVerifier, ...item.retiredVerifiers]);
  if (!unique(principals.map(item => item.id)) || !unique(principals.map(item => item.requestId)) || !unique(credentials)
    || !unique(sessions.map(item => item.verifier)) || !unique(invitations.map(item => item.id))
    || !unique(invitations.map(item => item.requestId)) || !unique(invitations.map(item => item.tokenVerifier))) return false;
  if (!sessions.every(item => byId.has(item.principalId))) return false;
  const redeemers = invitations.filter(item => item.status === 'redeemed').map(item => item.redeemedBy);
  const contributors = principals.filter(item => item.role === 'contributor');
  return unique(redeemers)
    && invitations.every(item => item.ownerId === owners[0]?.id && (item.status === 'redeemed'
      ? byId.get(item.redeemedBy)?.role === 'contributor' && byId.get(item.redeemedBy).draftIds.length === 1
        && byId.get(item.redeemedBy).draftIds[0] === item.draftId
      : item.redeemedBy === null))
    && contributors.every(item => redeemers.includes(item.id));
}

export class AccessStore {
  #file;
  #now;
  #state = null;
  #queue = Promise.resolve();

  constructor({ dataDir, now = Date.now }) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
    this.dataDir = path.resolve(dataDir);
    this.#file = path.join(this.dataDir, 'access.json');
    this.#now = now;
  }

  // Every public operation runs alone and sees the latest committed state.
  #exclusive(task) {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  // An uninitialized state is never cached: the owner is created by a separate
  // CLI process, so a running server must reread the file until it exists.
  // Once initialized, this process is the only writer (one server per dataDir).
  async #load() {
    if (this.#state && this.#owner(this.#state)) return this.#state;
    let text;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return (this.#state = emptyState());
      throw fail(503);
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw fail(503);
    }
    if (!validState(state)) throw fail(503);
    return (this.#state = state);
  }

  // The new state replaces the cached one only after the rename succeeds.
  async #commit(next) {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.#file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw fail(503);
    }
    this.#state = next;
  }

  // Publishes the first state only if no state file exists. link() fails with
  // EEXIST instead of replacing, so a competing initializer can never overwrite
  // an owner, session or recovery written after it. Returns false on EEXIST.
  async #publishInitial(next) {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await link(temporary, this.#file);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw fail(503);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    this.#state = next;
    return true;
  }

  #owner(state) {
    return state.principals.find(principal => principal.role === 'owner') ?? null;
  }

  #requireOwner(state, ownerId) {
    const owner = this.#owner(state);
    if (!owner || typeof ownerId !== 'string' || ownerId !== owner.id) throw fail(403);
    return owner;
  }

  #sessionLive(session, now) {
    return now < session.createdAt + SESSION_LIMITS.absoluteMs && now < session.lastSeenAt + SESSION_LIMITS.idleMs;
  }

  #keyInUse(state, digest) {
    return state.principals.some(principal => sameVerifier(principal.accessVerifier, digest) || sameVerifier(principal.recoveryVerifier, digest)
      || principal.retiredVerifiers.some(old => sameVerifier(old, digest)));
  }

  #invitationStatus(invitation, now) {
    return invitation.status === 'active' && now >= Date.parse(invitation.expiresAt) ? 'expired' : invitation.status;
  }

  #publicInvitation(invitation, now) {
    return { id: invitation.id, draftId: invitation.draftId, expiresAt: invitation.expiresAt, status: this.#invitationStatus(invitation, now) };
  }

  #newPrincipal(role, enrollment, draftIds) {
    return {
      id: randomUUID(), role, displayName: enrollment.displayName, draftIds, requestId: enrollment.requestId,
      accessVerifier: verifier(enrollment.accessKey), recoveryVerifier: verifier(enrollment.recoveryKey), retiredVerifiers: [],
      enrollmentReceipt: enrollmentReceipt(enrollment), createdAt: new Date(this.#now()).toISOString(),
    };
  }

  // Replays compare the immutable enrollment receipt, never the current keys, so
  // replaying an old enrollment returns the principal without restoring old keys.
  #matchesEnrollment(principal, enrollment) {
    return sameVerifier(principal.enrollmentReceipt, enrollmentReceipt(enrollment));
  }

  #enrollment(input) {
    if (!input || typeof input !== 'object') throw fail(400);
    return {
      requestId: requireUuid(input.requestId),
      displayName: requireName(input.displayName),
      accessKey: requireToken(input.accessKey, 'access', 400),
      recoveryKey: requireToken(input.recoveryKey, 'recovery', 400),
    };
  }

  state() {
    return this.#exclusive(async () => ({ initialized: Boolean(this.#owner(await this.#load())) }));
  }

  bootstrap(input) {
    return this.#exclusive(async () => {
      const enrollment = this.#enrollment(input);
      const state = await this.#load();
      const owner = this.#owner(state);
      if (owner) {
        if (this.#matchesEnrollment(owner, enrollment)) return publicPrincipal(owner);
        throw fail(409);
      }
      const principal = this.#newPrincipal('owner', enrollment, []);
      if (await this.#publishInitial({ ...emptyState(), principals: [principal] })) return publicPrincipal(principal);
      const current = this.#owner(await this.#load());
      if (current && this.#matchesEnrollment(current, enrollment)) return publicPrincipal(current);
      throw fail(409);
    });
  }

  login(accessKey) {
    return this.#exclusive(async () => {
      requireToken(accessKey, 'access', 401);
      const state = await this.#load();
      const principal = findByVerifier(state.principals, 'accessVerifier', verifier(accessKey));
      if (!principal) throw fail(401);
      const now = this.#now();
      const sessionToken = generateSecret('session');
      const own = state.sessions.filter(session => session.principalId === principal.id && this.#sessionLive(session, now))
        .sort((a, b) => a.createdAt - b.createdAt);
      const dropped = new Set(own.slice(0, Math.max(0, own.length - SESSION_LIMITS.perPrincipal + 1)));
      const sessions = state.sessions.filter(session => this.#sessionLive(session, now) && !dropped.has(session));
      sessions.push({ verifier: verifier(sessionToken), principalId: principal.id, createdAt: now, lastSeenAt: now });
      await this.#commit({ ...state, sessions });
      return { sessionToken, principal: publicPrincipal(principal), expiresAt: new Date(now + SESSION_LIMITS.absoluteMs).toISOString() };
    });
  }

  session(sessionToken) {
    return this.#exclusive(async () => {
      if (!isToken(sessionToken, 'session')) return null;
      const state = await this.#load();
      const session = findByVerifier(state.sessions, 'verifier', verifier(sessionToken));
      const now = this.#now();
      if (!session || !this.#sessionLive(session, now)) return null;
      const principal = state.principals.find(item => item.id === session.principalId);
      if (!principal) return null;
      if (now > session.lastSeenAt) {
        const sessions = state.sessions.map(item => (item === session ? { ...item, lastSeenAt: now } : item));
        await this.#commit({ ...state, sessions });
      }
      return publicPrincipal(principal);
    });
  }

  logout(sessionToken) {
    return this.#exclusive(async () => {
      if (!isToken(sessionToken, 'session')) return;
      const state = await this.#load();
      const session = findByVerifier(state.sessions, 'verifier', verifier(sessionToken));
      if (session) await this.#commit({ ...state, sessions: state.sessions.filter(item => item !== session) });
    });
  }

  recover(input) {
    return this.#exclusive(async () => {
      if (!input || typeof input !== 'object') throw fail(400);
      requireToken(input.recoveryKey, 'recovery', 401);
      const newAccessKey = requireToken(input.newAccessKey, 'access', 400);
      const newRecoveryKey = requireToken(input.newRecoveryKey, 'recovery', 400);
      const state = await this.#load();
      const principal = findByVerifier(state.principals, 'recoveryVerifier', verifier(input.recoveryKey));
      if (!principal) throw fail(401);
      const accessDigest = verifier(newAccessKey), recoveryDigest = verifier(newRecoveryKey);
      if (this.#keyInUse(state, accessDigest) || this.#keyInUse(state, recoveryDigest)) throw fail(409);
      const retiredVerifiers = [...principal.retiredVerifiers, principal.accessVerifier, principal.recoveryVerifier];
      const updated = { ...principal, accessVerifier: accessDigest, recoveryVerifier: recoveryDigest, retiredVerifiers };
      await this.#commit({
        ...state,
        principals: state.principals.map(item => (item === principal ? updated : item)),
        sessions: state.sessions.filter(session => session.principalId !== principal.id),
      });
      return publicPrincipal(updated);
    });
  }

  createInvitation(ownerId, input) {
    return this.#exclusive(async () => {
      if (!input || typeof input !== 'object') throw fail(400);
      const requestId = requireUuid(input.requestId);
      const draftId = requireUuid(input.draftId);
      const token = requireToken(input.token, 'invitation', 400);
      const hours = input.expiresInHours;
      if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw fail(400);
      const state = await this.#load();
      const owner = this.#requireOwner(state, ownerId);
      const now = this.#now();
      const digest = verifier(token);
      const existing = state.invitations.find(item => item.requestId === requestId);
      if (existing) {
        if (existing.draftId === draftId && existing.expiresInHours === hours && sameVerifier(existing.tokenVerifier, digest)) {
          return this.#publicInvitation(existing, now);
        }
        throw fail(409);
      }
      if (findByVerifier(state.invitations, 'tokenVerifier', digest)) throw fail(409);
      const invitation = {
        id: randomUUID(), requestId, ownerId: owner.id, draftId, expiresInHours: hours, tokenVerifier: digest,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * HOUR).toISOString(),
        status: 'active', redeemedBy: null,
      };
      await this.#commit({ ...state, invitations: [...state.invitations, invitation] });
      return this.#publicInvitation(invitation, now);
    });
  }

  revokeInvitation(ownerId, invitationId) {
    return this.#exclusive(async () => {
      const state = await this.#load();
      this.#requireOwner(state, ownerId);
      if (typeof invitationId !== 'string' || !UUID.test(invitationId)) throw fail(403);
      const invitation = state.invitations.find(item => item.id === invitationId);
      if (!invitation) throw fail(403);
      const now = this.#now();
      // Revoking closes an unused invitation only; it never removes an enrolled contributor.
      if (this.#invitationStatus(invitation, now) !== 'active') return this.#publicInvitation(invitation, now);
      const revoked = { ...invitation, status: 'revoked' };
      await this.#commit({ ...state, invitations: state.invitations.map(item => (item === invitation ? revoked : item)) });
      return this.#publicInvitation(revoked, now);
    });
  }

  invitations(ownerId) {
    return this.#exclusive(async () => {
      const state = await this.#load();
      this.#requireOwner(state, ownerId);
      const now = this.#now();
      return state.invitations.map(item => this.#publicInvitation(item, now));
    });
  }

  redeemInvitation(input) {
    return this.#exclusive(async () => {
      if (!input || typeof input !== 'object') throw fail(400);
      const token = requireToken(input.token, 'invitation', 403);
      const enrollment = this.#enrollment(input);
      const state = await this.#load();
      const invitation = findByVerifier(state.invitations, 'tokenVerifier', verifier(token));
      if (!invitation) throw fail(403);
      const now = this.#now();
      if (invitation.status === 'redeemed') {
        const principal = state.principals.find(item => item.id === invitation.redeemedBy);
        if (principal && this.#matchesEnrollment(principal, enrollment)) return publicPrincipal(principal);
        throw fail(409);
      }
      if (this.#invitationStatus(invitation, now) !== 'active') throw fail(403);
      if (state.principals.some(item => item.requestId === enrollment.requestId)
        || this.#keyInUse(state, verifier(enrollment.accessKey)) || this.#keyInUse(state, verifier(enrollment.recoveryKey))) throw fail(409);
      const principal = this.#newPrincipal('contributor', enrollment, [invitation.draftId]);
      const redeemed = { ...invitation, status: 'redeemed', redeemedBy: principal.id };
      await this.#commit({
        ...state,
        principals: [...state.principals, principal],
        invitations: state.invitations.map(item => (item === invitation ? redeemed : item)),
      });
      return publicPrincipal(principal);
    });
  }
}
