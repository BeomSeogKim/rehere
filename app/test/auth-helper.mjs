import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessStore, freshCredentials, generateSecret } from '../access.mjs';
import { createMediaVerifier } from '../media-verification.mjs';
import { createAppServer } from '../server.mjs';

// Owner credentials per data folder, so a restarted server on the same folder
// signs in as the same owner instead of trying to bootstrap a second one.
const owners = new Map();
const cookies = new Map();

// DISCLOSED TEST SEAM: owner uploads in the domain suites use synthetic,
// signature-only fixtures (png(), jpeg(), WEBM magic) that no real decoder
// accepts. Servers started here therefore get this accepting media verifier
// unless a test passes its own `mediaVerifier`. It keeps the real slot,
// attestation and publication logic but replaces the photo and audio decoders
// with ones that accept everything. It is never production validation:
// test/owner-media-validation.test.mjs covers the production default and the
// real decoders, and signature-only fixtures never count as decoder evidence.
export const acceptingTestMediaVerifier = () => createMediaVerifier({
  photo: async () => ({ width: 1, height: 1 }),
  voice: async () => ({ durationMs: 1000 }),
});

// Bootstraps the owner directly on the server's store, as the local CLI does,
// then signs in over HTTP. Apart from the media seam above, every check stays real.
export async function startOwnerServer(options = {}) {
  const dataDir = path.resolve(options.dataDir);
  const accessStore = options.accessStore ?? new AccessStore({ dataDir });
  let credentials = owners.get(dataDir);
  if (!credentials) {
    credentials = freshCredentials();
    await accessStore.bootstrap({ requestId: randomUUID(), displayName: 'Synthetic owner', ...credentials });
    owners.set(dataDir, credentials);
  }
  const server = createAppServer({ mediaVerifier: acceptingTestMediaVerifier(), ...options, accessStore });
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

// Synthetic images and depth grids only; no personal media.
export function png(width, height, fill = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), header, Buffer.alloc(36, fill)]);
}

export function jpeg(width, height, fill = 0) {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), frame, Buffer.alloc(32, fill), Buffer.from([0xff, 0xd9])]);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const SYNTHETIC_PHOTO = png(40, 30, 7);
const BOX = [4, 3, 20, 24];

// Writes the worker's outputs for a 4 x 3 grid whose two left columns are foreground.
export async function sceneRunner({ imagePath, outputDir, sourceId, box }) {
  const original = await readFile(imagePath);
  const texture = jpeg(40, 30, 1);
  const surface = {
    source: {
      source_id: sourceId, sha256: sha256(original), format: 'PNG', image_size: [40, 30],
      texture: { file: 'texture.jpg', sha256: sha256(texture), derivation: 'RGB re-encode without metadata' },
      selected_object: { id: 'foreground', box_xyxy: box },
    },
    width: 4, height: 3, depth: Array(12).fill(3), foreground: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    assumptions: { horizontal_fov_degrees: 55, near: 2, far: 5, max_triangle_depth_span: 0.35 },
  };
  const files = {
    'texture.jpg': texture, 'depth-preview.png': png(4, 3), 'mask.png': png(40, 30), 'mask-overlay.jpg': jpeg(40, 30, 2),
    'surface.json': JSON.stringify(surface),
    'summary.json': JSON.stringify({ source_id: sourceId, source_sha256: sha256(original), texture_sha256: sha256(texture) }),
  };
  await mkdir(outputDir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(outputDir, name), content);
  return { exitCode: 0, stderr: '' };
}

// A real HTTP client that sends only the session cookie the server set for it.
export function client(base, cookie = null) {
  const request = (route, init = {}) => globalThis.fetch(`${base}${route}`, { ...init, headers: { ...(cookie && { cookie }), ...init.headers } });
  return {
    get cookie() {
      return cookie;
    },
    request,
    json: async (route) => (await request(route)).json(),
    post: (route, body, headers = {}) => request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    async login(accessKey) {
      const response = await this.post('/api/session/login', { accessKey });
      if (response.status === 200) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    },
  };
}

const PUBLIC_GRANTS = { provider: 'Synthetic', origin: { kind: 'public', reference: '' }, permissions: { place: true, model: true, share: false }, dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } };

// Saves a synthetic memory through the owner session and waits for its ready scene.
export async function readyScene(owner, permissions = {}) {
  const form = new FormData();
  form.append('photos', new Blob([SYNTHETIC_PHOTO]), 'photo');
  form.append('metadata', JSON.stringify({ photos: [{ ...PUBLIC_GRANTS, permissions: { ...PUBLIC_GRANTS.permissions, ...permissions } }] }));
  const draft = await (await owner.request('/api/drafts', { method: 'POST', body: form })).json();
  const job = await (await owner.post(`/api/drafts/${draft.id}/reconstructions`, { requestId: randomUUID(), sourceId: draft.photos[0].sourceId, box: BOX })).json();
  const scene = `/api/drafts/${draft.id}/reconstructions/${job.id}`;
  for (let attempt = 0; attempt < 200 && (await owner.json(scene)).status !== 'ready'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { draft, job, scene, asset: `${scene}/assets/texture.jpg`, original: `/api/drafts/${draft.id}/assets/${draft.photos[0].name}` };
}

// Enrolls a contributor for one memory through a real invitation and signs them in.
export async function enrolledContributor(owner, base, draftId, displayName = 'Synthetic contributor') {
  const token = generateSecret('invitation');
  const invite = await (await owner.post('/api/invitations', { requestId: randomUUID(), draftId, expiresInHours: 24, token })).json();
  const keys = freshCredentials();
  const redeemed = await client(base).post('/api/invitations/redeem', { token, requestId: randomUUID(), displayName, ...keys });
  if (redeemed.status !== 200) throw new Error(`redeem failed: ${redeemed.status}`);
  const { principal } = await redeemed.json();
  const session = client(base);
  if ((await session.login(keys.accessKey)).status !== 200) throw new Error('contributor login failed');
  return { session, principal, keys, invite };
}
