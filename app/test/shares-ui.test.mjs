import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { installViewerShim, visitorSurface } from './viewer-shim.mjs';

installViewerShim();

const JOB_URL = '/api/drafts/11111111-1111-4111-8111-111111111111/reconstructions/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHARES = `${JOB_URL}/shares`;
const VID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAMERA = { position: [0.4, 0.1, 0.2], target: [0, 0, -3] };

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) });
const lost = () => Promise.reject(new TypeError('network'));
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let mountShares;
let viewChoices;
let storyMatchesView;
let quotable;
let previewProblem;
let visitLink;
let visitorOrigin;
let requests;
let routes;
let mounted;

function contribution(overrides = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    provider: { displayName: 'Mina' },
    text: 'The counter faced the window.',
    permissions: { place: true, model: false, share: true },
    status: 'adopted',
    ...overrides,
  };
}

// As core returns it before issue: no snapshot id or creation date yet.
function publicView(startViewId) {
  return {
    id: null,
    title: 'Shop',
    createdAt: null,
    synthetic: true,
    startViewId,
    camera: CAMERA,
    views: [{ id: startViewId, label: 'Saved scene', edit: { offset: [0, 0, 0], yaw: 0 }, era: { kind: 'unknown' }, evidence: { photo: null, support: [], recollections: [] } }],
  };
}

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.location = { origin: 'http://127.0.0.1:4317' };
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body });
    const handler = routes[`${options.method ?? 'GET'} ${url}`] ?? (url.includes('/assets/') ? () => Promise.resolve(json(200, visitorSurface())) : null);
    return handler ? handler(body) : Promise.resolve(json(404, { error: 'Not found.' }));
  };
  ({ mountShares, quotable, previewProblem, visitLink, viewChoices, storyMatchesView, visitorOrigin } = await import('../public/shares.js'));
});

after(() => {
  for (const name of ['document', 'location', 'fetch']) delete globalThis[name];
});

beforeEach(() => {
  requests = [];
  mounted = [];
  globalThis.viewerLog = [];
  globalThis.viewerFail = null;
  routes = {
    [`GET ${JOB_URL}/collaboration`]: () =>
      Promise.resolve(
        json(200, {
          revision: 1,
          contributions: [contribution(), contribution({ id: 'c2', permissions: { place: true, model: true, share: false } }), contribution({ id: 'c3', status: 'withdrawn', text: null })],
          variants: [{ id: VID, label: 'Mina’s recollection', blocked: false, edit: { version: null, offset: [1, 0, 0], yaw: 0 } }, { id: 'blocked', label: 'Blocked reconstruction', blocked: true }],
          blocked: false,
          currentVersion: 5,
        }),
      ),
    [`GET ${SHARES}`]: () => Promise.resolve(json(200, [])),
  };
});

afterEach(() => {
  for (const panel of mounted.splice(0)) panel.dispose();
});

async function mount({ camera = CAMERA } = {}) {
  const root = new FakeElement('div');
  const panel = mountShares(root, { sharesUrl: SHARES, jobUrl: JOB_URL, editor: () => ({ version: 5 }), getCamera: () => camera });
  mounted.push(panel);
  await flush();
  const find = (predicate) => root.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const label = (text) => find((node) => node.tag === 'label' && node.textContent.includes(text))[0];
  const tick = (text) => {
    const box = label(text).children.find((child) => typeof child !== 'string');
    box.checked = !box.checked;
    box.dispatch('change');
  };
  const message = () => find((node) => node.className === 'form-message')[0].textContent;
  const title = find((node) => node.tag === 'input' && node.type === 'text')[0];
  return { root, panel, find, button, label, tick, message, title };
}

async function previewed(ui, { webgl = true } = {}) {
  globalThis.viewerFail = webgl ? null : 'webgl';
  ui.title.value = 'Shop';
  ui.title.dispatch('input');
  ui.button('Use the current camera view').dispatch('click');
  routes[`POST ${SHARES}/previews`] = (body) => {
    routes[`GET ${SHARES}/previews/p1`] = () => Promise.resolve(json(200, { id: 'p1', digest: 'd1', expiresAt: new Date(Date.now() + 900_000).toISOString(), publicView: publicView(body.startViewId) }));
    return Promise.resolve(json(200, { id: 'p1', digest: 'd1', expiresAt: new Date(Date.now() + 900_000).toISOString(), publicView: publicView(body.startViewId) }));
  };
  ui.button('Preview what visitors will see').dispatch('click');
  await flush();
}

describe('sharing helpers', () => {
  it('offers only recollections whose writers allowed reconstruction and sharing', () => {
    assert.equal(quotable(contribution()), true);
    assert.equal(quotable(contribution({ permissions: { place: true, model: true, share: false } })), false);
    assert.equal(quotable(contribution({ status: 'withdrawn', text: null })), false);
    assert.equal(quotable(contribution({ status: 'rejected' })), false);
  });

  it('builds the local fragment link and checks the candidate before asking the server', () => {
    assert.equal(visitLink('http://127.0.0.1:4317', 'rhv_x'), 'http://127.0.0.1:4317/#/visit/rhv_x');
    const base = { title: 'Shop', views: [{ id: 'a' }], startViewId: 'a', camera: CAMERA, contributionIds: [] };
    assert.equal(previewProblem(base), null);
    assert.match(previewProblem({ ...base, camera: null }), /Capture the camera/);
    assert.match(previewProblem({ ...base, title: ' ' }), /title/);
    assert.match(previewProblem({ ...base, startViewId: 'b' }), /first/);
  });
});

describe('saved view choices', () => {
  it('offers every retained usable version by number and usable alternatives with their era revision', () => {
    const choices = viewChoices({
      history: [{ version: 1, blocked: false }, { version: 2, blocked: true }, { version: 3, blocked: false }],
      variants: [{ id: VID, label: 'Alt', blocked: false, eraRevision: 2, era: { kind: 'relative', label: 'before' } }, { id: 'b', label: 'Blocked', blocked: true }],
      currentVersion: 3,
    });
    assert.deepEqual(choices.map((c) => [c.kind, c.version, c.variantId, c.eraRevision, c.label]), [
      ['version', 3, null, null, 'Saved version 3 (current)'],
      ['version', 1, null, null, 'Saved version 1'],
      ['variant', null, VID, 2, 'Alt'],
    ]);
  });

  it('matches a story only to the exact view it was saved for', () => {
    const story = { view: { kind: 'version', version: 1, variantId: null } };
    assert.equal(storyMatchesView(story, { kind: 'version', version: 1, variantId: null }), true);
    assert.equal(storyMatchesView(story, { kind: 'version', version: 2, variantId: null }), false, 'never rebinds to a newer version');
    assert.equal(storyMatchesView({ view: { kind: 'variant', variantId: VID } }, { kind: 'variant', version: null, variantId: VID }), true);
  });
});

describe('owner sharing panel', () => {
  it('offers the current version and usable alternatives, and only quotable recollections, all quotes off', async () => {
    const ui = await mount();
    assert.ok(ui.label('Saved version 5 (current)'));
    assert.ok(ui.label('Mina’s recollection'));
    assert.equal(ui.label('Blocked reconstruction'), undefined);
    const quotes = ui.find((node) => node.tag === 'label' && node.textContent.includes('Mina: '));
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].children[0].checked, false);
  });

  it('sends the exact candidate with the captured camera and renders the server’s view in the real visitor screen', async () => {
    const ui = await mount();
    ui.tick('Mina’s recollection');
    ui.tick('Mina: ');
    await previewed(ui);
    const [sent] = requests.filter((r) => r.method === 'POST' && r.url === `${SHARES}/previews`);
    const ids = sent.body.views.map((view) => view.id);
    assert.deepEqual(Object.keys(sent.body).sort(), ['camera', 'contributionIds', 'requestId', 'startViewId', 'storyIds', 'synthetic', 'title', 'views']);
    assert.deepEqual(sent.body.storyIds, [], 'no story unless chosen');
    assert.deepEqual(sent.body.views, [
      { id: ids[0], kind: 'version', version: 5, variantId: null },
      { id: ids[1], kind: 'variant', version: null, variantId: VID },
    ]);
    assert.deepEqual(sent.body.camera, CAMERA);
    assert.deepEqual(sent.body.contributionIds, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    assert.equal(sent.body.synthetic, false);
    assert.ok(requests.some((r) => r.url === `${SHARES}/previews/p1/assets/${sent.body.startViewId}/surface.json`));
    assert.equal(globalThis.viewerLog.filter((entry) => entry === 'renderer').length, 1, 'the actual viewer rendered the preview');
    assert.match(ui.root.textContent, /This preview is not a link/);
    assert.match(ui.root.textContent, /Preview — not yet issued/);
    assert.doesNotMatch(ui.root.textContent, /saved copy|Shared [A-Z][a-z]{2} \d|1970|\bnull\b|Invalid Date/, 'a preview never looks issued or shows a made-up date');
  });

  it('shares an older retained version with its own story, not the current one', async () => {
    routes[`GET ${JOB_URL}/history`] = () => Promise.resolve(json(200, [{ version: 1, offset: [0, 0, 0], yaw: 0, kind: 'initial', blocked: false }, { version: 5, offset: [1, 0, 0], yaw: 0, kind: 'manual', blocked: false }]));
    routes[`GET ${JOB_URL}/stories`] = () =>
      Promise.resolve(
        json(200, {
          stories: [
            { id: 'st1', status: 'ready', available: true, title: 'Morning bell', view: { kind: 'version', version: 1, variantId: null, label: 'Saved version 1' }, voice: { provider: 'Owner' }, captionAuthor: { displayName: 'Owner' } },
            { id: 'st2', status: 'ready', available: false, title: 'Hidden', view: { kind: 'version', version: 1, variantId: null }, voice: {}, captionAuthor: {} },
          ],
        }),
      );
    const ui = await mount();
    assert.match(ui.root.textContent, /No recorded story belongs to the chosen views/);
    ui.tick('Saved version 5 (current)');
    ui.tick('Saved version 1');
    assert.match(ui.root.textContent, /“Morning bell” · Saved version 1 · recording by Owner, captions by Owner/);
    assert.doesNotMatch(ui.root.textContent, /Hidden/);
    ui.tick('“Morning bell”');
    await previewed(ui);
    const [sent] = requests.filter((r) => r.method === 'POST' && r.url === `${SHARES}/previews`);
    assert.deepEqual(sent.body.views.map((view) => [view.kind, view.version]), [['version', 1]]);
    assert.deepEqual(sent.body.storyIds, ['st1']);
  });

  it('keeps the latest story choices when an older combined read answers late, in both directions', async () => {
    const readyV5 = { id: 'st1', status: 'ready', available: true, title: 'Morning bell', view: { kind: 'version', version: 5, variantId: null, label: 'Saved version 5' }, voice: { provider: 'Owner' }, captionAuthor: { displayName: 'Owner' } };
    for (const [olderList, newerList, expected] of [[[], [readyV5], true], [[readyV5], [], false]]) {
      const held = [];
      let reads = 0;
      routes[`GET ${JOB_URL}/stories`] = () => {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => held.push(() => resolve(json(200, { stories: olderList }))));
        return Promise.resolve(json(200, { stories: newerList }));
      };
      const ui = await mount();
      ui.panel.refreshOptions();
      await flush();
      held[0]();
      await flush();
      const offered = Boolean(ui.find((node) => node.tag === 'label' && node.textContent.includes('“Morning bell”'))[0]);
      assert.equal(offered, expected, expected ? 'a late empty read does not remove the new story' : 'a late read does not bring back a withdrawn story');
    }
  });

  it('issues only after a rendered preview and consent, with a locally made token, and shows the link once', async () => {
    const ui = await mount();
    await previewed(ui);
    assert.equal(ui.button('Issue a visitor link').disabled, true);
    ui.tick('Visitors may see the selected reconstruction');
    assert.equal(ui.button('Issue a visitor link').disabled, false);
    routes[`POST ${SHARES}`] = lost;
    ui.button('Issue a visitor link').dispatch('click');
    await flush();
    assert.match(ui.message(), /could not confirm the link/);
    routes[`POST ${SHARES}`] = () => Promise.resolve(json(200, { id: 's1', createdAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-11-07T00:00:00.000Z', status: 'active', previewId: 'p1', digest: 'd1' }));
    ui.button('Issue a visitor link').dispatch('click');
    await flush();
    const [first, second] = requests.filter((r) => r.method === 'POST' && r.url === SHARES);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(Object.keys(first.body).sort(), ['consent', 'previewDigest', 'previewId', 'requestId', 'token']);
    assert.match(first.body.token, /^rhv_[A-Za-z0-9_-]{43}$/);
    assert.equal(first.body.consent, true);
    assert.equal(first.body.previewDigest, 'd1');
    assert.ok(requests.every((r) => !r.url.includes(first.body.token)), 'the token is never in a request URL');
    const code = ui.find((node) => node.tag === 'code')[0].textContent;
    assert.equal(code, `http://127.0.0.1:4317/#/visit/${first.body.token}`);
    assert.match(ui.root.textContent, /shown only now/);
    ui.panel.refreshOptions();
    await flush();
    assert.equal(ui.find((node) => node.tag === 'code')[0]?.textContent, code, 'a story change does not hide an issued link');
  });

  it('never shows an earlier preview’s link under a newer preview', async () => {
    const ui = await mount();
    await previewed(ui);
    ui.tick('Visitors may see the selected reconstruction');
    let respond;
    routes[`POST ${SHARES}`] = () => new Promise((resolve) => (respond = resolve));
    ui.button('Issue a visitor link').dispatch('click');
    await flush();
    ui.title.value = 'Shop B';
    ui.title.dispatch('input');
    routes[`POST ${SHARES}/previews`] = (body) => {
      const view = { id: 'p2', digest: 'd2', expiresAt: new Date(Date.now() + 900_000).toISOString(), publicView: publicView(body.startViewId) };
      routes[`GET ${SHARES}/previews/p2`] = () => Promise.resolve(json(200, view));
      return Promise.resolve(json(200, view));
    };
    ui.button('Preview what visitors will see').dispatch('click');
    await flush();
    const listReads = requests.filter((r) => r.url === SHARES && r.method === 'GET').length;
    respond(json(200, { id: 's1', createdAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-11-07T00:00:00.000Z', status: 'active', previewId: 'p1', digest: 'd1' }));
    await flush();
    assert.equal(ui.find((node) => node.tag === 'code').length, 0, 'no link under preview B');
    assert.match(ui.message(), /issued for an earlier preview that is no longer shown/);
    assert.ok(requests.filter((r) => r.url === SHARES && r.method === 'GET').length > listReads, 'the list was refreshed');
    assert.equal(ui.button('Issue a visitor link').disabled, true, 'preview B still needs its own consent');
  });

  it('does not count the 2D fallback as a rendered scene unless the owner confirms it', async () => {
    const ui = await mount();
    await previewed(ui, { webgl: false });
    ui.tick('Visitors may see the selected reconstruction');
    assert.equal(ui.button('Issue a visitor link').disabled, true);
    ui.tick('I checked the 2D fallback');
    assert.equal(ui.button('Issue a visitor link').disabled, false);
  });

  it('discards the preview as soon as the candidate changes', async () => {
    const ui = await mount();
    await previewed(ui);
    assert.ok(ui.button('Issue a visitor link'));
    ui.title.value = 'Shop, revised';
    ui.title.dispatch('input');
    assert.equal(ui.button('Issue a visitor link'), undefined);
    assert.ok(globalThis.viewerLog.includes('renderer.dispose'), 'the preview scene was released');
  });

  it('needs a captured camera and explains server refusals without changing anything', async () => {
    const ui = await mount({ camera: null });
    ui.title.value = 'Shop';
    ui.button('Use the current camera view').dispatch('click');
    assert.match(ui.root.textContent, /3D view is not open/);
    ui.button('Preview what visitors will see').dispatch('click');
    await flush();
    assert.match(ui.message(), /Capture the camera view first/);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
  });

  it('lists issued links and revokes one only after a second press, repeating the same request when unconfirmed', async () => {
    routes[`GET ${SHARES}`] = () =>
      Promise.resolve(json(200, [{ id: 's1', title: 'Shop', createdAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-11-07T00:00:00.000Z', status: 'suspended', reason: 'A recollection it depends on was withdrawn.', views: [{ label: 'Saved scene' }] }]));
    const ui = await mount();
    assert.match(ui.root.textContent, /Shop · Suspended/);
    assert.match(ui.root.textContent, /recollection it depends on was withdrawn/);
    ui.button('Revoke').dispatch('click');
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
    routes[`POST ${SHARES}/s1/revoke`] = lost;
    ui.button('Revoke this link').dispatch('click');
    await flush();
    routes[`POST ${SHARES}/s1/revoke`] = () => Promise.resolve(json(200, { id: 's1', status: 'revoked' }));
    ui.button('Revoke this link').dispatch('click');
    await flush();
    const sent = requests.filter((r) => r.url === `${SHARES}/s1/revoke`);
    assert.deepEqual(sent[1].body, sent[0].body);
    assert.deepEqual(Object.keys(sent[0].body), ['requestId']);
    assert.match(ui.message(), /cannot be removed/);
  });
});

describe('configured visitor address on an issued link', () => {
  const RECEIPT = { id: 's1', createdAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-11-07T00:00:00.000Z', status: 'active', previewId: 'p1', digest: 'd1' };
  async function issue(answer) {
    const ui = await mount();
    await previewed(ui);
    ui.tick('Visitors may see the selected reconstruction');
    routes[`POST ${SHARES}`] = () => Promise.resolve(json(201, answer));
    ui.button('Issue a visitor link').dispatch('click');
    await flush();
    const [sent] = requests.filter((r) => r.method === 'POST' && r.url === SHARES);
    return { ui, token: sent.body.token, code: ui.find((node) => node.tag === 'code')[0]?.textContent };
  }

  it('accepts only an exact HTTPS origin, or HTTP on localhost or 127.0.0.1 with a port', () => {
    for (const ok of ['https://visit.example.org', 'https://visit.example.org:8443', 'http://127.0.0.1:4318', 'http://localhost:4318']) assert.equal(visitorOrigin(ok), ok, ok);
    for (const bad of [
      'https://visit.example.org/', 'https://visit.example.org/path', 'https://visit.example.org?x=1', 'https://visit.example.org#f',
      'https://user:pw@visit.example.org', 'http://visit.example.org', 'http://127.0.0.1', 'http://192.168.0.2:4318', 'HTTPS://Visit.example.org',
      'https://*.example.org', 'https://*', 'https://visit.*.example.org:8443', 'https://visit.example.org:0', 'http://127.0.0.1:0', 'http://localhost:0', 'http://127.0.0.1:00',
      'javascript:alert(1)', 'data:text/html,x', 'ftp://visit.example.org', '//visit.example.org', '', ' https://visit.example.org', null, 42, {},
    ]) assert.equal(visitorOrigin(bad), null, String(bad));
  });

  it('builds the link on a configured address and says it is configured, not checked', async () => {
    const { ui, token, code } = await issue({ ...RECEIPT, visitOrigin: 'https://visit.example.org' });
    assert.equal(code, `https://visit.example.org/#/visit/${token}`);
    assert.match(ui.root.textContent, /configured visitor address https:\/\/visit\.example\.org, shown only now\. Rehere has not checked that this address can be reached from elsewhere\./);
    const receipt = ui.find((node) => node.className === 'access-keys')[0].textContent;
    assert.doesNotMatch(receipt, /live|deployed|published|this computer’s local address/);
  });

  it('shows the receipt without any link when the configured address is not usable', async () => {
    for (const visitOrigin of ['javascript:alert(1)', 'https://visit.example.org/evil', 'http://visit.example.org', null]) {
      const { ui } = await issue({ ...RECEIPT, visitOrigin });
      assert.equal(ui.find((node) => node.tag === 'code').length, 0, String(visitOrigin));
      assert.equal(ui.button('Copy link'), undefined);
      assert.match(ui.root.textContent, /A visitor link was issued until .*, but the configured visitor address in Rehere’s answer is not a usable address, so no link is shown\. Revoke it under Shared views/);
      assert.doesNotMatch(ui.root.textContent, /evil|javascript/);
    }
  });

  it('keeps the local link and wording when no visitor address is configured', async () => {
    const { ui, token, code } = await issue(RECEIPT);
    assert.equal(code, `http://127.0.0.1:4317/#/visit/${token}`);
    assert.match(ui.root.textContent, /works on this computer’s local address/);
  });
});
