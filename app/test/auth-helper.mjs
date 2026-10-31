import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AccessStore, freshCredentials } from '../access.mjs';
import { createAppServer } from '../server.mjs';

// Owner credentials per data folder, so a restarted server on the same folder
// signs in as the same owner instead of trying to bootstrap a second one.
const owners = new Map();
const cookies = new Map();

// Bootstraps the owner directly on the server's store, as the local CLI does,
// then signs in over HTTP. Every check stays real; there is no test bypass.
export async function startOwnerServer(options = {}) {
  const dataDir = path.resolve(options.dataDir);
  const accessStore = options.accessStore ?? new AccessStore({ dataDir });
  let credentials = owners.get(dataDir);
  if (!credentials) {
    credentials = freshCredentials();
    await accessStore.bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...credentials });
    owners.set(dataDir, credentials);
  }
  const server = createAppServer({ ...options, accessStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await globalThis.fetch(`${base}/api/session/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: credentials.accessKey }),
  });
  if (login.status !== 200) throw new Error(`owner login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  cookies.set(base, cookie);
  return { server, base, dataDir, accessStore, credentials, cookie, close: () => new Promise((resolve) => server.close(resolve)) };
}

export const ownerCookie = (url) => cookies.get(new URL(url).origin);

// fetch with the owner session cookie of the server the URL points at.
export function ownerFetch(url, init = {}) {
  const cookie = ownerCookie(url);
  return globalThis.fetch(url, { ...init, headers: { ...(cookie && { cookie }), ...init.headers } });
}
