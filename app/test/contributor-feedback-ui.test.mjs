import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { mountCollaboration, mountContributor } from '../public/collaboration.js';
import { quaternionFromEuler } from '../public/composition-scene.js';

const DRAFT = '11111111-1111-4111-8111-111111111111', JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const URL = `/api/drafts/${DRAFT}/reconstructions/${JOB}`, REVIEW = `${URL}/contributions/${CID}/review`;
const PLACE = { draftId: DRAFT, jobId: JOB, label: 'A saved place', version: 1 };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const clone = (value) => structuredClone(value);
const contribution = (extra = {}) => ({ id: CID, principalId: 'provider', provider: { displayName: 'Mina' }, kind: 'human_recollection', text: 'The counter faced the window.', permissions: { place: true, model: false, share: false }, periodClaim: '', revision: 1, status: 'submitted', review: null, withdrawnAt: null, ...extra });
const packet = (entries) => ({ contributions: entries, variants: [], blocked: false, currentVersion: 1 });
let routes, requests, mounted;
before(() => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
  globalThis.fetch = (url, options = {}) => { const body = options.body ? JSON.parse(options.body) : null; requests.push({ url, method: options.method ?? 'GET', body }); return routes[`${options.method ?? 'GET'} ${url}`]?.(body) ?? Promise.resolve(json(404, { error: 'Not found.' })); };
});
beforeEach(() => { routes = {}; requests = []; mounted = []; });
afterEach(() => mounted.forEach((view) => view.dispose()));
const posts = () => requests.filter((entry) => entry.method === 'POST' && entry.url === REVIEW);
function finder(root) {
  const find = (fn) => root.findAll(fn);
  return { root, find, button: (name) => find((node) => node.tag === 'button' && node.textContent === name)[0], named: (name) => find((node) => node.attributes['aria-label'] === name)[0] };
}
async function owner(kind = 'legacy', entries = [contribution()]) {
  let selected = null;
  const labels = { 'object-1': 'Counter <b>old</b>', 'object-2': 'Sacks' };
  const objects = Object.fromEntries(Object.keys(labels).map((id, index) => [id, kind === 'composition'
    ? { frame: 'owner-composition', version: 1, position: [index, 0.123456789, -3], quaternion: quaternionFromEuler([0.123456789, 0.234567891, -0.345678912]), scale: 0.5123456789 }
    : { version: 1, offset: [index * 0.5, 0.123456789, -0.234567891], yaw: 0.234567891 }]));
  let state = kind === 'legacy' ? { version: 1, offset: [0, 0, 0], yaw: 0.123456789 } : objects['object-1'];
  const calls = [];
  const bridge = {
    jobUrl: URL, editor: (id) => ({ ...clone(kind === 'legacy' ? state : objects[id ?? selected ?? 'object-1']), clean: true }),
    showTransform: (value) => { calls.push(['show', value]); return Boolean(value); }, setLocked() {},
    saved: (value) => { calls.push(['saved', value]); state = value; }, unconfirmed: () => calls.push(['unconfirmed']), conflict: () => calls.push(['conflict']), blocked() {},
    ...(kind !== 'legacy' && { targets: { selected: () => selected, nameOf: (id) => `${id === 'object-1' ? 'A' : 'B'}: ${labels[id]}`, labelOf: (id) => labels[id] ?? null, describe: () => '', ruleText: () => '' } }),
  };
  routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(200, packet(entries)));
  routes[`POST ${REVIEW}`] = (body) => {
    const current = { ...entries[0], status: { adopt: 'adopted', alternative: 'alternative', hold: 'held', reject: 'rejected', reviewing: 'reviewing' }[body.decision], revision: 2,
      review: { ...(body.feedback && { feedback: { partLabel: body.feedback.showTarget ? kind === 'legacy' ? 'Selected foreground object' : labels[body.transform.targetId] : null, note: body.feedback.note } }) } };
    entries = entries.map((item) => item.id === current.id ? current : item);
    return Promise.resolve(json(200, { contribution: current }));
  };
  const root = new FakeElement('section'), view = mountCollaboration(root, bridge); mounted.push(view); await settle();
  const ui = finder(root); ui.button('Review')?.dispatch('click');
  const controls = () => ({ decision: ui.find((node) => node.tag === 'select')[0], reason: ui.find((node) => node.tag === 'textarea')[0], conflict: ui.find((node) => node.tag === 'select')[1], note: ui.named('Note for contributor'), share: ui.named('Share reviewed part with contributor') });
  const decision = (value) => { const node = controls().decision; node.value = value; node.dispatch('change'); };
  const typeNote = (value) => { const node = controls().note; node.value = value; node.dispatch('input'); };
  const share = () => { const node = controls().share; node.checked = true; node.dispatch('change'); };
  const choose = (id) => { selected = id; view.sync(); };
  const preview = () => { ui.button('Preview candidate on the scene').dispatch('click'); };
  const save = async () => { ui.button('Save decision').dispatch('click'); await settle(); return posts().at(-1)?.body; };
  return { ...ui, view, bridge, calls, objects, labels, controls, decision, typeNote, share, choose, preview, save, previewText: () => ui.find((node) => node.className === 'review-feedback-preview')[0].textContent };
}
async function provider(entries, { places = [PLACE], principal = 'provider', read = () => Promise.resolve(json(200, packet(entries))) } = {}) {
  routes['GET /api/contributor/places'] = () => Promise.resolve(json(200, places));
  routes[`GET ${URL}/collaboration`] = read;
  const root = new FakeElement('section'), view = mountContributor(root, { principal: { id: principal, role: 'contributor' } }); mounted.push(view); await settle();
  return { ...finder(root), view };
}

describe('optional contributor review feedback', () => {
  it('keeps private notes separate and the unchanged legacy body exact', async () => {
    const ui = await owner(); ui.controls().reason.value = 'Private comparison with someone else';
    assert.equal(ui.controls().share.checked, false); assert.equal(ui.controls().share.disabled, true);
    assert.equal(ui.controls().note.value, ''); assert.match(ui.previewText(), /No extra feedback will be shared/);
    assert.doesNotMatch(ui.previewText(), /Private comparison/);
    ui.decision('hold'); const body = await ui.save();
    assert.deepEqual(body, { requestId: body.requestId, decision: 'hold', reason: 'Private comparison with someone else', conflict: 'unknown', transform: null, baseVersion: 1, baseRevision: 1 });
  });

  for (const kind of ['legacy', 'two-object', 'composition']) it(`${kind}: previews the exact raw label and trimmed note without sending a label or ID`, async () => {
    const ui = await owner(kind); ui.decision('alternative'); if (kind !== 'legacy') ui.choose('object-1');
    assert.ok(!ui.controls().share.checked); ui.share(); ui.typeNote('  Thank you <b>Mina</b>.\nThis helped.  ');
    const expected = kind === 'legacy' ? 'Selected foreground object' : ui.labels['object-1'];
    assert.match(ui.previewText(), new RegExp(`Reviewed part: ${expected}`));
    assert.match(ui.previewText(), /Thank you <b>Mina<\/b>\.\nThis helped\./);
    assert.equal(ui.find((node) => node.tag === 'b').length, 0);
    assert.equal(ui.button('Save decision').disabled, true, 'feedback does not replace actual geometry preview');
    ui.preview(); const body = await ui.save();
    assert.deepEqual(body.feedback, { showTarget: true, note: 'Thank you <b>Mina</b>.\nThis helped.' });
    assert.equal(Object.hasOwn(body.feedback, 'partLabel'), false); assert.equal(Object.hasOwn(body.feedback, 'targetId'), false);
    if (kind === 'composition') assert.deepEqual(body.transform.pose.quaternion, ui.objects['object-1'].quaternion);
  });

  for (const decision of ['reviewing', 'hold', 'reject']) it(`${decision}: permits only independently typed note feedback`, async () => {
    const ui = await owner('two-object'); ui.choose('object-1'); ui.decision('alternative'); ui.share(); ui.typeNote(' A note to Mina ');
    ui.decision(decision); assert.equal(ui.controls().share.checked, false); assert.equal(ui.controls().share.disabled, true);
    assert.doesNotMatch(ui.previewText(), /Reviewed part:/); assert.match(ui.previewText(), /A note to Mina/);
    const body = await ui.save(); assert.equal(body.transform, null); assert.deepEqual(body.feedback, { showTarget: false, note: 'A note to Mina' });
  });

  it('requires fresh target disclosure after changing objects, keeps the independent note, and ends the old geometry preview', async () => {
    const ui = await owner('two-object'); ui.decision('adopt'); ui.choose('object-1'); ui.share(); ui.typeNote('My independent message'); ui.preview();
    ui.choose('object-2'); assert.equal(ui.controls().share.checked, false); assert.equal(ui.controls().note.value, 'My independent message');
    assert.equal(ui.calls.filter(([name]) => name === 'show').at(-1)[1], null);
    assert.doesNotMatch(ui.previewText(), /Counter/); assert.equal(ui.button('Save decision').disabled, true);
    ui.share(); assert.match(ui.previewText(), /Reviewed part: Sacks/); ui.preview();
    const body = await ui.save(); assert.equal(body.transform.targetId, 'object-2');
  });

  it('omits unchecked whitespace-only feedback and bounds the trimmed UTF-16 note', async () => {
    const ui = await owner(); ui.typeNote(' \n '); ui.decision('hold');
    assert.equal(Object.hasOwn(await ui.save(), 'feedback'), false);
    const next = await owner(); next.decision('hold'); next.typeNote('😀'.repeat(251)); assert.equal(next.button('Save decision').disabled, true);
    next.typeNote(`  ${'😀'.repeat(250)}  `); assert.equal(next.button('Save decision').disabled, false);
    assert.equal((await next.save()).feedback.note.length, 500);
  });

  it('freezes exact feedback and whole review after an unclear save despite target/view changes and failed refresh', async () => {
    const ui = await owner('two-object', [contribution(), contribution({ id: OTHER })]);
    ui.decision('alternative'); ui.choose('object-1'); ui.share(); ui.typeNote('  Only this message  '); ui.controls().reason.value = 'Private reason'; ui.preview();
    routes[`POST ${REVIEW}`] = () => Promise.resolve(json(503, null));
    routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(503, null));
    const first = await ui.save(); const outgoing = ui.previewText();
    assert.equal(ui.button('Save decision').disabled, false);
    for (const node of Object.values(ui.controls())) assert.equal(node.disabled, true);
    assert.equal(ui.find((node) => node.tag === 'input' && node.type === 'number').every((node) => node.disabled), true);
    ui.choose('object-2'); ui.view.noteViewIntent();
    assert.equal(ui.previewText(), outgoing); assert.match(ui.previewText(), /Counter/); assert.doesNotMatch(ui.previewText(), /Sacks/);
    assert.equal(ui.button('Review').disabled, true);
    routes[`POST ${REVIEW}`] = () => Promise.resolve(json(409, { error: 'Access changed.' }));
    const second = await ui.save(); assert.deepEqual(second, first);
    assert.equal(ui.controls().note.disabled, false, 'confirmed rejection releases the draft');
    assert.equal(ui.controls().reason.value, 'Private reason');
  });

  for (const status of ['withdrawn', 'held']) it(`consumes a ${status} receipt with hidden feedback before a failed list refresh`, async () => {
    const ui = await owner('two-object'); ui.decision(status === 'withdrawn' ? 'alternative' : 'hold'); ui.choose('object-1');
    if (status === 'withdrawn') { ui.share(); ui.preview(); }
    ui.typeNote('Withheld contributor note');
    routes[`POST ${REVIEW}`] = () => Promise.resolve(json(503, null));
    routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(503, null));
    const first = await ui.save();
    const current = contribution({ status, revision: 2, ...(status === 'withdrawn' ? { text: null, withdrawnAt: '2026-11-02T00:00:00Z' } : {}), review: { decision: first.decision, feedback: null } });
    routes[`POST ${REVIEW}`] = () => Promise.resolve(json(200, { contribution: current, edit: null, variant: { id: OTHER, blocked: true, edit: null } }));
    const second = await ui.save(); assert.deepEqual(second, first);
    assert.equal(ui.find((node) => node.className === 'review-feedback-preview').length, 0);
    assert.equal(ui.named('Note for contributor'), undefined);
    assert.doesNotMatch(ui.root.textContent, /Withheld contributor note|Contributor will see|Kept as a separate alternative\./);
    assert.match(ui.root.textContent, /saved/i); assert.match(ui.root.textContent, /unavailable|not available/i);
    if (status === 'withdrawn') assert.match(ui.root.textContent, /Withdrawn|withdrawn/);
    assert.equal(ui.calls.some(([name]) => name === 'saved'), false);
    assert.equal(posts().length, 2);
  });

  it('keeps a confirmed decision saved when its following list refresh fails', async () => {
    const ui = await owner(); ui.decision('hold'); ui.typeNote('Thank you.');
    routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(503, null));
    await ui.save(); assert.match(ui.root.textContent, /Decision saved/); assert.equal(ui.button('Save decision').disabled, true);
    ui.button('Save decision').dispatch('click'); await settle(); assert.equal(posts().length, 1);
  });

  it('ignores a late adoption success after the review was withdrawn', async () => {
    const ui = await owner(); ui.decision('adopt'); ui.typeNote('Do not revive this.'); ui.preview();
    let resolve; routes[`POST ${REVIEW}`] = () => new Promise((done) => { resolve = done; });
    ui.button('Save decision').dispatch('click'); await settle();
    routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(200, packet([contribution({ status: 'withdrawn', text: null, review: { feedback: null } })])));
    await ui.view.refresh(); assert.equal(ui.named('Note for contributor'), undefined);
    resolve(json(200, { contribution: contribution({ status: 'adopted', review: { feedback: { partLabel: null, note: 'Do not revive this.' } } }), edit: { version: 2, offset: [0, 0, 0], yaw: 0 } })); await settle();
    assert.doesNotMatch(ui.root.textContent, /Do not revive this/); assert.equal(ui.calls.some(([name]) => name === 'saved'), false);
  });

  it('renders captured feedback for owner and provider as literal text without private notes or live label substitution', async () => {
    const entry = contribution({ status: 'alternative', review: { reason: 'Secret private reason', conflict: 'memory', feedback: { partLabel: 'Earlier counter <b>label</b>', note: 'Thanks <script>alert(1)</script>' } } });
    const ui = await owner('two-object', [entry]); assert.match(ui.root.textContent, /Earlier counter <b>label<\/b>/);
    const own = await provider([entry]); assert.match(own.root.textContent, /Earlier counter <b>label<\/b>/); assert.match(own.root.textContent, /Thanks <script>alert\(1\)<\/script>/);
    assert.doesNotMatch(own.root.textContent, /Secret private reason|Memories differ/); assert.equal(own.find((node) => ['b', 'script'].includes(node.tag)).length, 0);
    assert.match(own.root.textContent, /does not confirm the current scene or historical truth/);
    assert.deepEqual(requests.filter((request) => request.method === 'GET').map(({ url }) => url).filter((url) => url !== `${URL}/collaboration`), ['/api/contributor/places']);
  });

  for (const [name, feedback] of [['legacy', undefined], ['redacted', null], ['empty', { partLabel: null, note: '' }], ['null note', { partLabel: 'Counter', note: null }], ['too long', { partLabel: 'Counter', note: 'x'.repeat(501) }], ['blank note', { partLabel: 'Counter', note: ' ' }], ['label control', { partLabel: 'Counter\n', note: 'Thanks' }], ['note control', { partLabel: null, note: 'Bad\u0000note' }]]) it(`hides ${name} feedback`, async () => {
    const ui = await provider([contribution({ status: 'held', review: { ...(feedback === undefined ? {} : { feedback }) } })]);
    assert.equal(ui.find((node) => node.className === 'review-feedback').length, 0);
  });

  it('sends label-only feedback only when deliberately checked', async () => {
    const ui = await owner(); ui.decision('alternative'); ui.share(); ui.preview();
    assert.match(ui.previewText(), /Reviewed part: Selected foreground object/); assert.match(ui.previewText(), /No message will be shared/);
    assert.deepEqual((await ui.save()).feedback, { showTarget: true, note: '' });
  });

  it('releases an unavailable photo while preserving only the frozen review retry', async () => {
    const photoUrl = `${URL}/contributions/${CID}/photo`;
    const photo = { available: true, url: photoUrl, permissions: { place: true, model: false, share: false }, dates: {}, origin: { kind: 'own' } };
    routes[`GET ${photoUrl}`] = () => Promise.resolve({ ok: true, blob: async () => new Blob(['synthetic-photo']) });
    const ui = await owner('legacy', [contribution({ photo })]); await settle();
    ui.find((node) => node.tag === 'img')[0].dispatch('load');
    const ack = ui.find((node) => node.tag === 'label' && /I compared this photo/.test(node.textContent))[0].children[0];
    ack.checked = true; ack.dispatch('change'); ui.decision('alternative'); ui.share(); ui.typeNote('Photo review'); ui.preview();
    routes[`POST ${REVIEW}`] = () => Promise.resolve(json(503, null)); const first = await ui.save(); assert.equal(ack.disabled, true);
    routes[`GET ${URL}/collaboration`] = () => Promise.resolve(json(200, packet([contribution({ photo: { ...photo, available: false, url: null } })])));
    await ui.view.refresh();
    assert.equal(ui.find((node) => node.tag === 'figure')[0].hidden, true);
    assert.equal(ui.button('Save decision').disabled, false); assert.match(ui.previewText(), /Photo review/);
    routes[`POST ${REVIEW}`] = () => Promise.resolve(json(409, { error: 'Photo unavailable.' })); assert.deepEqual(await ui.save(), first);
  });

  it('ignores review and contributor responses after their principal view is disposed', async () => {
    const ui = await owner(); ui.decision('hold'); ui.typeNote('Old private feedback');
    let reviewDone; routes[`POST ${REVIEW}`] = () => new Promise((resolve) => { reviewDone = resolve; });
    ui.button('Save decision').dispatch('click'); await settle(); ui.view.dispose();
    reviewDone(json(200, { contribution: contribution({ status: 'held', review: { feedback: { partLabel: null, note: 'Old private feedback' } } }) })); await settle(); assert.equal(ui.root.textContent, '');
    let oldRead;
    const old = await provider([], { principal: 'old', read: () => new Promise((resolve) => { oldRead = resolve; }) }); old.view.dispose();
    const next = await provider([contribution({ status: 'held', review: { feedback: null } })], { principal: 'new' });
    oldRead(json(200, packet([contribution({ status: 'held', review: { feedback: { partLabel: 'Old part', note: 'Old private feedback' } } })]))); await settle();
    assert.equal(old.root.textContent, ''); assert.doesNotMatch(next.root.textContent, /Old private feedback|Old part/);
  });

  it('does not bring a previous place’s feedback into a newly selected place', async () => {
    const other = { ...PLACE, draftId: '22222222-2222-4222-8222-222222222222', label: 'Another place' };
    const otherUrl = `/api/drafts/${other.draftId}/reconstructions/${JOB}`;
    let oldRead; routes[`GET ${otherUrl}/collaboration`] = () => Promise.resolve(json(200, packet([])));
    const ui = await provider([], { places: [PLACE, other], read: () => new Promise((resolve) => { oldRead = resolve; }) });
    const choice = ui.find((node) => node.tag === 'select')[0]; choice.value = `${DRAFT}/${JOB}`; choice.dispatch('change'); await settle();
    choice.value = `${other.draftId}/${JOB}`; choice.dispatch('change'); await settle();
    oldRead(json(200, packet([contribution({ status: 'held', review: { feedback: { partLabel: 'Old part', note: 'From the previous place' } } })]))); await settle();
    assert.doesNotMatch(ui.root.textContent, /Old part|From the previous place/);
  });

  it('cannot revive feedback from a late older list after withdrawal or a principal change', async () => {
    const reads = [];
    const ui = await provider([], { places: [] });
    routes['GET /api/contributor/places'] = () => Promise.resolve(json(200, [PLACE]));
    ui.view.dispose();
    const old = await provider([], { principal: 'old-provider', read: () => new Promise((resolve) => reads.push(resolve)) });
    old.find((node) => node.tag === 'textarea')[0].value = 'New writing';
    routes[`POST ${URL}/contributions`] = () => Promise.resolve(json(201, contribution()));
    old.button('Send recollection').dispatch('click'); await settle();
    reads[1](json(200, packet([contribution({ status: 'withdrawn', text: null, review: { feedback: null } })]))); await settle();
    reads[0](json(200, packet([contribution({ status: 'held', review: { feedback: { partLabel: 'Private old label', note: 'Private old feedback' } } })]))); await settle();
    assert.doesNotMatch(old.root.textContent, /Private old/);
    old.view.dispose();
    const fresh = await provider([contribution({ status: 'held', review: { feedback: null } })], { principal: 'new-provider' });
    assert.doesNotMatch(fresh.root.textContent, /Private old/); assert.equal(old.root.textContent, '');
  });
});
