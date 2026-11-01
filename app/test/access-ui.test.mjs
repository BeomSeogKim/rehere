import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { accessCard, freshKeys, mountAccess, nameProblem, newKey, parseAccessCard, setupCommand, setupPort } from '../public/access-ui.js';

const KEY = /^(rha|rhr)_[A-Za-z0-9_-]{43}$/;
const ORIGIN = 'http://127.0.0.1:4317';
const INVITE = 'rhi_' + 'b'.repeat(43);
const readCard = (url) => resolveObjectURL(url).text();
const owner = { id: 'p-owner', role: 'owner', displayName: 'Owner', draftIds: [] };
const contributor = { id: 'p-contrib', role: 'contributor', displayName: 'Mina', draftIds: ['11111111-1111-4111-8111-111111111111'] };

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const lost = () => Promise.reject(new TypeError('network'));
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

let requests;
let routes;
let storageTouched;

before(() => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.window = { addEventListener() {} };
  globalThis.location = { origin: ORIGIN };
  // Keys must never reach browser storage.
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        storageTouched = true;
        return { setItem() {}, getItem() {} };
      },
    });
  }
  globalThis.fetch = (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method ?? 'GET', body, credentials: options.credentials, cache: options.cache });
    const handler = routes[`${options.method ?? 'GET'} ${url}`];
    return handler ? handler(body) : Promise.resolve(json(404, { error: 'Not found.' }));
  };
});

after(() => {
  for (const name of ['document', 'window', 'location', 'fetch', 'localStorage', 'sessionStorage']) delete globalThis[name];
});

beforeEach(() => {
  requests = [];
  storageTouched = false;
  routes = { 'GET /api/session': () => Promise.resolve(json(200, { initialized: true, principal: null })) };
});

async function mount() {
  const container = new FakeElement('div');
  const events = [];
  const access = mountAccess(container, { onOwner: (principal) => events.push(['owner', principal]), onSignedOut: () => events.push(['signedOut']) });
  access.start();
  await settle();
  const find = (predicate) => container.findAll(predicate);
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text)[0];
  const inputs = (type) => find((node) => node.tag === 'input' && node.type === type);
  const submit = () => find((node) => node.tag === 'form')[0].dispatch('submit');
  const status = () => find((node) => node.className?.startsWith('form-message'))[0]?.textContent ?? '';
  const ack = () => {
    const box = inputs('checkbox').at(-1);
    box.checked = true;
    box.dispatch('change');
  };
  return { container, access, events, find, button, inputs, submit, status, ack };
}

describe('key helpers', () => {
  it('generates independent prefixed 32-byte keys', () => {
    const a = freshKeys();
    const b = freshKeys();
    for (const key of [a.accessKey, a.recoveryKey, b.accessKey, b.recoveryKey]) assert.match(key, KEY);
    assert.ok(a.accessKey.startsWith('rha_') && a.recoveryKey.startsWith('rhr_'));
    assert.equal(new Set([a.accessKey, a.recoveryKey, b.accessKey, b.recoveryKey]).size, 4);
    assert.match(newKey('access'), KEY);
  });

  it('checks display names the way the server limits them', () => {
    assert.equal(nameProblem(' Mina '), null);
    assert.match(nameProblem('   '), /Enter a name/);
    assert.match(nameProblem('a'.repeat(81)), /80 characters/);
    assert.equal(nameProblem('\uac00'.repeat(80)), null);
    assert.match(nameProblem('Mi\u0007na'), /control characters/);
  });

  it('writes a card that reads back exactly, and refuses damaged or incomplete cards', () => {
    const keys = freshKeys();
    const join = { workspace: ORIGIN, operation: 'enrollment', createdAt: '2026-10-31T12:00:00.000Z', name: 'Mina', ...keys, token: INVITE, requestId: '22222222-2222-4222-8222-222222222222' };
    const text = accessCard(join);
    assert.match(text, /cannot show them again/);
    assert.deepEqual(parseAccessCard(text).card, join);
    const recovery = { workspace: ORIGIN, operation: 'recovery', createdAt: '2026-10-31T12:00:00.000Z', ...freshKeys() };
    assert.match(accessCard(recovery), /Keep your previous card until you have signed in/);
    assert.deepEqual(parseAccessCard(accessCard(recovery)).card, recovery);
    assert.match(parseAccessCard('hello').error, /not a Rehere access card/);
    assert.match(parseAccessCard(text.replace(keys.accessKey, 'rha_short')).error, /incomplete or damaged/);
    assert.match(parseAccessCard(text.replace(/Request ID: .*\n/, '')).error, /missing its original request/);
    assert.match(parseAccessCard(`${text}Access key: ${keys.accessKey}\n`).error, /repeated field/);
  });
});

describe('session gate', () => {
  it('shows only the command-line setup step for an uninitialized workspace', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: false, principal: null }));
    const view = await mount();
    assert.match(view.container.textContent, /not set up yet/);
    assert.match(view.container.textContent, /From the repository root, run:/);
    assert.equal(
      view.find((node) => node.tag === 'pre')[0].textContent,
      'mkdir -m 700 -p app/data\nPORT=4317 node app/access-cli.mjs init \\\n  --credentials-file app/data/owner-card.json --name "Workspace owner"',
      'the ACCESS.md command for the port this page came from',
    );
    assert.match(view.container.textContent, /same host and port the card names; localhost and 127\.0\.0\.1 are kept apart/);
    assert.match(view.container.textContent, /follow app\/ACCESS\.md/);
    assert.doesNotMatch(view.container.textContent, /outside the app/);
    assert.equal(view.inputs('password').length, 0, 'no browser sign-up or sign-in');
    assert.deepEqual(view.events, []);
    assert.deepEqual(requests.map((r) => r.url), ['/api/session']);
  });

  it('derives only a validated port for the setup command, from this page’s own address', async () => {
    assert.equal(setupPort('http://127.0.0.1:4400'), 4400);
    assert.equal(setupPort('http://localhost'), 80, 'an http address without a port is port 80');
    for (const unusable of ['https://127.0.0.1', 'https://127.0.0.1:4400', 'ftp://127.0.0.1:4400', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'not an address', undefined, null]) {
      assert.equal(setupPort(unusable), 4317, String(unusable));
    }
    assert.match(setupCommand(4400), /^mkdir -m 700 -p app\/data\nPORT=4400 node app\/access-cli\.mjs init /);
    globalThis.location = { origin: 'http://localhost:4400' };
    try {
      routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: false, principal: null }));
      const view = await mount();
      const command = view.find((node) => node.tag === 'pre')[0].textContent;
      assert.match(command, /^mkdir -m 700 -p app\/data\nPORT=4400 /, 'a test server on another port gets a matching card');
      assert.doesNotMatch(command, /localhost/, 'no host text goes into the command');
    } finally {
      globalThis.location = { origin: ORIGIN };
    }
  });

  it('starts the owner app only for a signed-in owner, with no role choice', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: owner }));
    const view = await mount();
    assert.deepEqual(view.events, [['owner', owner]]);
    assert.match(view.container.textContent, /Signed in as Owner \(owner\)/);
    assert.equal(view.find((node) => node.tag === 'select').length, 0);
  });

  it('signs in with the access key only and keeps it out of storage', async () => {
    routes['POST /api/session/login'] = () => Promise.resolve(json(200, { principal: owner }));
    const view = await mount();
    const key = view.inputs('password')[0];
    key.value = 'rha_' + 'a'.repeat(43);
    view.submit();
    await settle();
    const login = requests.find((r) => r.url === '/api/session/login');
    assert.deepEqual(login.body, { accessKey: 'rha_' + 'a'.repeat(43) });
    assert.equal(login.credentials, 'same-origin');
    assert.equal(login.cache, 'no-store');
    assert.deepEqual(view.events, [['owner', owner]]);
    assert.equal(storageTouched, false);
  });

  it('shows a generic refusal and does not start the app', async () => {
    routes['POST /api/session/login'] = () => Promise.resolve(json(401, { error: 'Sign-in failed.' }));
    const view = await mount();
    view.inputs('password')[0].value = 'rha_wrong';
    view.submit();
    await settle();
    assert.equal(view.status(), 'Sign-in failed.');
    assert.deepEqual(view.events, []);
  });

  it('gives a contributor only their status, key replacement and sign-out', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: contributor }));
    const view = await mount();
    assert.deepEqual(view.events, []);
    assert.match(view.container.textContent, /access to 1 place/);
    assert.ok(view.button('Replace my keys'));
    assert.ok(view.button('Sign out'));
    assert.equal(requests.length, 1);
  });

  it('gives a contributor the recollection screen and disposes it on sign-out', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: contributor }));
    routes['POST /api/session/logout'] = () => Promise.resolve(json(200, { ok: true }));
    const container = new FakeElement('div');
    const log = [];
    const access = mountAccess(container, {
      onOwner: () => log.push('owner'),
      onSignedOut: () => log.push('signedOut'),
      renderContributor: (node, principal) => {
        node.append('recollection screen');
        log.push(['render', principal.id]);
        return { dispose: () => log.push('dispose') };
      },
    });
    access.start();
    await settle();
    assert.match(container.textContent, /recollection screen/);
    assert.deepEqual(log, [['render', 'p-contrib']]);
    container.findAll((node) => node.tag === 'button' && node.textContent === 'Sign out')[0].dispatch('click');
    await settle();
    assert.deepEqual(log, [['render', 'p-contrib'], 'dispose']);
    assert.doesNotMatch(container.textContent, /recollection screen/);
  });

  it('tears down the owner app before the sign-out request, and drops a late login screen', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: owner }));
    let respond;
    routes['POST /api/session/logout'] = () => new Promise((resolve) => (respond = resolve));
    const view = await mount();
    view.button('Sign out').dispatch('click');
    assert.deepEqual(view.events.at(-1), ['signedOut'], 'private views close before the response');
    respond(json(200, { ok: true }));
    await settle();
    assert.match(view.status(), /You are signed out/);
  });

  it('says so when a sign-out is not confirmed, and lets it be repeated', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: owner }));
    routes['POST /api/session/logout'] = lost;
    const view = await mount();
    view.button('Sign out').dispatch('click');
    await settle();
    assert.match(view.container.textContent, /could not confirm the sign-out/);
    routes['POST /api/session/logout'] = () => Promise.resolve(json(200, { ok: true }));
    view.button('Try signing out again').dispatch('click');
    await settle();
    assert.match(view.status(), /You are signed out/);
  });

  it('returns to sign-in when a private request reports the session ended', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: owner }));
    const view = await mount();
    view.access.sessionEnded();
    assert.deepEqual(view.events.at(-1), ['signedOut']);
    assert.match(view.status(), /session ended/);
  });
});

describe('credential-creating flows', () => {
  async function openJoin() {
    const view = await mount();
    view.button('Join with an invitation').dispatch('click');
    const [token] = view.inputs('password');
    const [name] = view.inputs('text');
    token.value = INVITE;
    name.value = ' Mina ';
    view.submit();
    return view;
  }

  it('prepares keys and the card before joining, and sends nothing until the card is saved', async () => {
    const view = await openJoin();
    await settle();
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
    const codes = view.find((node) => node.tag === 'code').map((node) => node.textContent);
    assert.equal(codes.length, 2);
    assert.ok(codes[0].startsWith('rha_') && codes[1].startsWith('rhr_'));
    const link = view.find((node) => node.tag === 'a' && node.download === 'rehere-access-card.txt')[0];
    const { card } = parseAccessCard(await readCard(link.href));
    assert.equal(card.workspace, ORIGIN);
    assert.equal(card.operation, 'enrollment');
    assert.equal(card.name, 'Mina');
    assert.equal(card.token, INVITE);
    assert.deepEqual([card.accessKey, card.recoveryKey], codes);
    assert.match(view.container.textContent, /does not confirm the file was kept/);
    assert.equal(view.button('Join').disabled, true);
    view.button('Join').dispatch('click');
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
    view.ack();
    assert.equal(view.button('Join').disabled, false);
  });

  it('repeats the exact join request after an unconfirmed response, then asks for a separate sign-in', async () => {
    routes['POST /api/invitations/redeem'] = lost;
    const view = await openJoin();
    const codes = view.find((node) => node.tag === 'code').map((node) => node.textContent);
    view.ack();
    view.button('Join').dispatch('click');
    await settle();
    assert.match(view.status(), /could not confirm whether you joined/);
    routes['POST /api/invitations/redeem'] = () => Promise.resolve(json(200, { principal: contributor }));
    view.button('Try again').dispatch('click');
    await settle();
    const [first, second] = requests.filter((r) => r.url === '/api/invitations/redeem');
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(Object.keys(first.body).sort(), ['accessKey', 'displayName', 'recoveryKey', 'requestId', 'token']);
    assert.equal(first.body.displayName, 'Mina');
    assert.deepEqual([first.body.accessKey, first.body.recoveryKey], codes);
    assert.match(view.status(), /You have joined\. Sign in/);
    assert.deepEqual(view.events, [], 'joining never signs in');
    assert.equal(storageTouched, false);
  });

  it('allows starting over only before anything was sent', async () => {
    routes['POST /api/invitations/redeem'] = lost;
    const view = await openJoin();
    view.ack();
    view.button('Join').dispatch('click');
    await settle();
    assert.equal(view.button('Start over').hidden, true);
  });

  async function openRecover() {
    const view = await mount();
    view.button('Lost your access key?').dispatch('click');
    view.inputs('password')[0].value = 'rhr_' + 'c'.repeat(43);
    view.submit();
    view.ack();
    return view;
  }

  it('replaces keys with exactly the prepared new pair and never signs in', async () => {
    routes['POST /api/session/recover'] = () => Promise.resolve(json(200, { principal: owner }));
    const view = await openRecover();
    const codes = view.find((node) => node.tag === 'code').map((node) => node.textContent);
    view.button('Replace my keys').dispatch('click');
    await settle();
    const [sent] = requests.filter((r) => r.url === '/api/session/recover');
    assert.deepEqual(sent.body, { recoveryKey: 'rhr_' + 'c'.repeat(43), newAccessKey: codes[0], newRecoveryKey: codes[1] });
    assert.match(view.status(), /keys were replaced and every session was signed out/);
    assert.deepEqual(view.events, []);
  });

  it('reconciles an unconfirmed recovery only by an explicit sign-in with the retained new key', async () => {
    routes['POST /api/session/recover'] = lost;
    const view = await openRecover();
    const codes = view.find((node) => node.tag === 'code').map((node) => node.textContent);
    view.button('Replace my keys').dispatch('click');
    await settle();
    assert.match(view.status(), /could not confirm whether your keys were replaced/);
    assert.match(view.status(), /Keep both your previous card and the new one/);
    assert.doesNotMatch(view.container.textContent, /previous keys still work|did not happen/);
    assert.equal(view.button('Replace my keys').hidden, true, 'no resend and no new key set');
    assert.equal(view.button('Try again'), undefined);

    view.button('Sign in with the new access key').dispatch('click');
    assert.equal(view.inputs('password')[0].value, codes[0]);
    assert.equal(requests.filter((r) => r.url === '/api/session/login').length, 0, 'nothing is sent until the person signs in');
    assert.equal(requests.filter((r) => r.url === '/api/session/recover').length, 1);
    assert.deepEqual(view.events, []);
  });

  it('sends a recovery once, even if the saved-card box is toggled while it is in flight', async () => {
    let respond;
    routes['POST /api/session/recover'] = () => new Promise((resolve) => (respond = resolve));
    const view = await openRecover();
    view.button('Replace my keys').dispatch('click');
    const box = view.inputs('checkbox').at(-1);
    box.checked = false;
    box.dispatch('change');
    box.checked = true;
    box.dispatch('change');
    assert.equal(view.button('Replace my keys').disabled, true);
    view.button('Replace my keys').dispatch('click');
    respond(json(503, null));
    await settle();
    box.checked = false;
    box.dispatch('change');
    box.checked = true;
    box.dispatch('change');
    view.button('Replace my keys').dispatch('click');
    assert.equal(requests.filter((r) => r.url === '/api/session/recover').length, 1);
  });

  it('drops a contributor’s local sign-in as soon as a recovery is sent, whatever the outcome', async () => {
    routes['GET /api/session'] = () => Promise.resolve(json(200, { initialized: true, principal: contributor }));
    routes['POST /api/session/recover'] = () => Promise.resolve(json(401, { error: 'That recovery key was not accepted.' }));
    const view = await mount();
    view.button('Replace my keys').dispatch('click');
    view.inputs('password')[0].value = 'rhr_' + 'd'.repeat(43);
    view.submit();
    view.ack();
    view.button('Replace my keys').dispatch('click');
    await settle();
    view.button('Back').dispatch('click');
    assert.doesNotMatch(view.container.textContent, /Signed in as|You are a contributor/);
    assert.ok(view.find((node) => node.tag === 'h1' && node.textContent === 'Sign in')[0]);
  });

  it('says a refused recovery replaced nothing without promising which keys work', async () => {
    routes['POST /api/session/recover'] = () => Promise.resolve(json(401, { error: '' }));
    const view = await openRecover();
    view.button('Replace my keys').dispatch('click');
    await settle();
    assert.match(view.status(), /did not replace your keys/);
    assert.doesNotMatch(view.status(), /still work/);
  });

});

describe('saved card import', () => {
  const joinCard = () => ({
    workspace: ORIGIN,
    operation: 'enrollment',
    createdAt: '2026-10-31T12:00:00.000Z',
    name: 'Mina',
    ...freshKeys(),
    token: INVITE,
    requestId: '33333333-3333-4333-8333-333333333333',
  });

  async function importText(text, name = 'rehere-access-card.txt') {
    const view = await mount();
    view.button('Use a saved access card').dispatch('click');
    const file = view.inputs('file')[0];
    file.files = [{ name, text: async () => text }];
    file.dispatch('change');
    await settle();
    return view;
  }

  it('reads a card without sending anything, then repeats the original join exactly on request', async () => {
    const card = joinCard();
    routes['POST /api/invitations/redeem'] = () => Promise.resolve(json(200, { principal: contributor }));
    const view = await importText(accessCard(card));
    assert.deepEqual(requests.map((r) => r.url), ['/api/session'], 'choosing the file sends nothing');
    assert.match(view.container.textContent, /Join card for Mina/);
    view.button('Repeat the original join').dispatch('click');
    assert.equal(view.button('Join').disabled, false, 'the saved card is the retained copy');
    view.button('Join').dispatch('click');
    await settle();
    const [sent] = requests.filter((r) => r.url === '/api/invitations/redeem');
    assert.deepEqual(sent.body, { token: INVITE, requestId: card.requestId, displayName: 'Mina', accessKey: card.accessKey, recoveryKey: card.recoveryKey });
    assert.match(view.status(), /You have joined/);
  });

  it('offers only a sign-in for a recovery card, prefilled but not sent', async () => {
    const card = { workspace: ORIGIN, operation: 'recovery', createdAt: '2026-10-31T12:00:00.000Z', ...freshKeys() };
    const view = await importText(accessCard(card));
    assert.equal(view.button('Repeat the original join'), undefined);
    view.button('Sign in with this card').dispatch('click');
    assert.equal(view.inputs('password')[0].value, card.accessKey);
    assert.deepEqual(requests.map((r) => r.url), ['/api/session']);
  });

  const ownerCard = (extra = {}) => {
    const keys = freshKeys();
    const card = {
      format: 'rehere-owner-recovery-card',
      note: 'Owner access and recovery keys for one local Rehere workspace.',
      workspace: '/srv/example-workspace/data',
      requestId: '44444444-4444-4444-8444-444444444444',
      displayName: 'Owner',
      ...keys,
      origin: ORIGIN,
      createdAt: '2026-10-31T12:00:00.000Z',
      ...extra,
    };
    return { keys, text: `${JSON.stringify(card, null, 2)}\n` };
  };

  it('reads the command-line owner card locally and signs in only when asked, with exactly its access key', async () => {
    const { keys, text } = ownerCard();
    routes['POST /api/session/login'] = () => Promise.resolve(json(200, { principal: owner }));
    const view = await importText(text, 'rehere-owner-card.json');
    assert.deepEqual(requests.map((r) => r.url), ['/api/session']);
    assert.match(view.container.textContent, /Owner card for Owner/);
    assert.doesNotMatch(view.container.textContent, /example-workspace|\/data/, 'the data-folder path is not shown');
    assert.doesNotMatch(view.container.textContent, /not record|not this workspace/);
    assert.equal(view.button('Repeat the original join'), undefined);
    view.button('Sign in with this card').dispatch('click');
    assert.equal(requests.length, 1, 'pre-filling sends nothing');
    view.submit();
    await settle();
    const [login] = requests.filter((r) => r.url === '/api/session/login');
    assert.deepEqual(login.body, { accessKey: keys.accessKey });
    assert.deepEqual(view.events, [['owner', owner]]);
  });

  it('lets the file picker choose the command-line JSON card as well as text cards', async () => {
    const view = await mount();
    view.button('Use a saved access card').dispatch('click');
    const accepted = view.inputs('file')[0].accept.split(',');
    for (const type of ['.json', 'application/json', '.txt', 'text/plain']) assert.ok(accepted.includes(type), type);
  });

  it('blocks an owner card for another address and asks to confirm one with no recorded address', async () => {
    let view = await importText(ownerCard({ origin: 'http://127.0.0.1:5000' }).text, 'owner.json');
    assert.match(view.container.textContent, /made for the Rehere workspace at http:\/\/127\.0\.0\.1:5000, not this one/);
    assert.equal(view.button('Sign in with this card'), undefined, 'nothing from the card can be sent here');
    const noOrigin = ownerCard();
    const parsed = JSON.parse(noOrigin.text);
    delete parsed.origin;
    delete parsed.createdAt;
    view = await importText(JSON.stringify(parsed), 'owner.json');
    assert.match(view.container.textContent, /does not record which address it belongs to/);
    assert.equal(view.button('Sign in with this card').disabled, true);
    view.button('Sign in with this card').dispatch('click');
    assert.equal(view.inputs('password').length, 0, 'not pre-filled before confirming');
    view.ack();
    view.button('Sign in with this card').dispatch('click');
    assert.equal(view.inputs('password')[0].value, noOrigin.keys.accessKey);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
    view = await importText(JSON.stringify({ ...parsed, format: 'something-else' }));
    assert.match(view.status(), /not a Rehere access card/);
    view = await importText('{ not json');
    assert.match(view.status(), /not a Rehere access card/);
  });

  it('blocks a join card from another workspace and rejects damaged files', async () => {
    let view = await importText(accessCard({ ...joinCard(), workspace: 'http://localhost:9999' }));
    assert.match(view.container.textContent, /Open Rehere at that address/);
    assert.equal(view.button('Repeat the original join'), undefined);
    assert.equal(view.button('Sign in with this card'), undefined);
    view = await importText('not a card');
    assert.match(view.status(), /not a Rehere access card/);
  });
});
