import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, afterEach, before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';

// The browser loads Three.js from the server's /vendor routes; map those to the
// pinned package so the real module runs here.
const VENDOR = {
  '/vendor/three.module.js': 'three',
  '/vendor/OrbitControls.js': 'three/examples/jsm/controls/OrbitControls.js',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(VENDOR[specifier] ?? specifier, context);
  },
});


const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const granted = { kind: 'photo', permissions: { place: true, model: true, share: false } };

function deferred() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const manifest = (status) => ({ id: JOB_ID, draftId: DRAFT_ID, sourceId: SOURCE_A, box: [1, 1, 50, 40], status, createdAt: new Date().toISOString(), error: null });

let mountSpace;
let posts;
let jobs;
// Stored pixels of an EXIF-rotated photo: 1007x801, while the browser reports
// the rotated 801x1007 as naturalWidth/naturalHeight.
let sizeResponse;
let sizeRequests;
let jobResponse;
let reads;
let listResponse;

before(async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = async (url, options = {}) => {
    reads.push({ url, method: options.method ?? 'GET' });
    if (options.method === 'POST') {
      const pending = deferred();
      posts.push({ url, body: JSON.parse(options.body), respond: pending.resolve });
      return pending.promise;
    }
    if (url.endsWith('/image-size')) {
      sizeRequests.push(url);
      return sizeResponse(url);
    }
    if (url === '/api/invitations') return json(200, []);
    if (url.endsWith('/reconstructions')) return listResponse ? listResponse() : json(200, jobs);
    if (url.endsWith(JOB_ID) && jobResponse) return jobResponse();
    return json(200, jobs.find((job) => url.endsWith(job.id)) ?? manifest('ready'));
  };
  ({ mountSpace } = await import('../public/space.js'));
});

after(() => {
  delete globalThis.document;
  delete globalThis.fetch;
});

// Every mounted view is disposed after its test, even when an assertion
// fails, so no poll timer outlives the test.
const mounted = [];
afterEach(() => {
  for (const space of mounted.splice(0)) space.dispose();
});

function mount(sources = { [SOURCE_A]: granted, [SOURCE_B]: granted }) {
  posts = [];
  jobs = [];
  sizeRequests = [];
  reads = [];
  jobResponse = null;
  listResponse = null;
  sizeResponse = () => json(200, { width: 1007, height: 801 });
  const container = new FakeElement('section');
  const draft = { id: DRAFT_ID, photos: [{ name: 'photo-1.jpg', sourceId: SOURCE_A }, { name: 'photo-2.jpg', sourceId: SOURCE_B }] };
  const calls = [];
  const space = mountSpace(container, { draft, sourceFor: (id) => sources[id] ?? null, onScene: (id) => calls.push(id) });
  mounted.push(space);
  const find = (predicate) => container.findAll(predicate);
  // Messages of the build or scene panel, not of the invitation manager.
  const panel = () => find((node) => node.className === 'space-panel')[0];
  const button = (text) => find((node) => node.tag === 'button' && node.textContent === text);
  const heading = () => find((node) => node.tag === 'h3')[0]?.textContent;
  const image = () => find((node) => node.tag === 'img')[0];
  const inputs = () => find((node) => node.tag === 'input' && node.type === 'number');
  const open = (index) => {
    button('Build a partial scene')[index].dispatch('click');
    Object.assign(image(), { naturalWidth: 801, naturalHeight: 1007 });
  };
  const typeBox = (box) => {
    box.forEach((value, i) => (inputs()[i].value = String(value)));
    inputs()[0].dispatch('input');
  };
  const select = async (index, box) => {
    open(index);
    image().dispatch('load');
    await settle();
    typeBox(box);
  };
  const buildButton = () => button('Build partial scene')[0];
  const message = () => panel().findAll((node) => node.className === 'form-message')[0]?.textContent;
  return { space, container, find, button, heading, select, open, typeBox, image, inputs, buildButton, message, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const statusLine = (view) => view.container.children.find((node) => node.role === 'status').textContent;
const background = (view) => view.find((node) => node.className === 'hint space-background')[0].textContent;

describe('partial scene build panel', () => {
  it('offers the exact ready build beside its status without opening it automatically', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    const ready = { ...manifest('ready'), usageBlocked: false };
    jobs = [ready];
    posts[0].respond(json(202, ready));
    await settle();
    const handoff = view.find((node) => node.className === 'actions space-ready')[0];
    assert.match(view.container.textContent, /Photo 1: Your partial scene is ready to review/);
    assert.equal(handoff.children[0].textContent, 'Open scene');
    assert.deepEqual(view.calls, [null], 'completion did not open a scene');
    jobResponse = () => json(404, null);
    handoff.children[0].dispatch('click');
    await settle();
    assert.deepEqual(view.calls, [null, JOB_ID], 'the click opens the exact job');
    assert.ok(reads.some((entry) => entry.url.endsWith(`/${JOB_ID}`)));
    assert.match(view.container.textContent, /This scene could not be found/);
    assert.equal(posts.length, 1, 'opening did not trigger another action');
  });

  it('shows a polled result only while the original selection is current', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    const answer = deferred();
    jobResponse = () => answer.promise;
    view.buildButton().dispatch('click');
    jobs = [manifest('queued')];
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    const handoff = view.find((node) => node.className === 'actions space-ready')[0];
    assert.equal(handoff.children.length, 0);
    const ready = { ...manifest('ready'), usageBlocked: false };
    jobs = [ready];
    answer.resolve(json(200, ready));
    await settle();
    assert.equal(handoff.children[0].textContent, 'Open scene');
    assert.deepEqual(view.calls, [null]);

    await view.select(1, [5, 5, 60, 70]);
    assert.equal(handoff.children.length, 0, 'a new selection clears the old action');
    assert.equal(view.heading(), 'Choose an object in photo 2');
  });

  it('does not let a late build completion replace a newer selection', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    const answer = deferred();
    jobResponse = () => answer.promise;
    view.buildButton().dispatch('click');
    jobs = [manifest('queued')];
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    await view.select(1, [5, 5, 60, 70]);
    const ready = { ...manifest('ready'), usageBlocked: false };
    jobs = [ready];
    answer.resolve(json(200, ready));
    await settle();
    assert.equal(view.heading(), 'Choose an object in photo 2');
    assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
    assert.deepEqual(view.calls, [null, null]);
  });

  it('polls a build at once, keeps it observed when the creator moves on during the list read, and ignores the late stale list', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    const list = deferred();
    listResponse = () => list.promise;
    const answer = deferred();
    jobResponse = () => answer.promise;
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    assert.ok(reads.some((entry) => entry.url.endsWith(`/${JOB_ID}`)), 'polling does not wait for the list read');
    await view.select(1, [5, 5, 60, 70]);
    const ready = { ...manifest('ready'), usageBlocked: false };
    jobs = [ready];
    listResponse = null;
    answer.resolve(json(200, ready));
    await settle();
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.');
    list.resolve(json(200, [manifest('queued')]));
    await settle();
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.', 'a superseded stale list changes nothing');
    assert.equal(view.heading(), 'Choose an object in photo 2');
    assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
    assert.deepEqual(view.calls, [null, null]);
  });

  it('lets a newer followed build take polling over and polls the older one by its exact ID afterwards', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    const older = { ...manifest('queued'), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    jobs = [older];
    posts[0].respond(json(202, older));
    await settle();
    await view.select(1, [5, 5, 60, 70]);
    view.buildButton().dispatch('click');
    const newer = { ...manifest('queued'), sourceId: SOURCE_B };
    const answer = deferred();
    jobResponse = () => answer.promise;
    jobs = [older, newer];
    const olderReads = () => reads.filter((entry) => entry.url.endsWith(`/${older.id}`)).length;
    posts[1].respond(json(202, newer));
    await settle();
    const before = olderReads();
    assert.ok(reads.some((entry) => entry.url.endsWith(`/${JOB_ID}`)), 'the newer build is polled');
    assert.match(statusLine(view), /^Photo 2: Accepted\. Waiting to start\.$/);

    jobs = [{ ...newer, status: 'ready', usageBlocked: false }, { ...older, status: 'ready', usageBlocked: false }];
    assert.equal(olderReads(), before, 'the older build waits while the newer one is polled');
    answer.resolve(json(200, jobs[0]));
    await settle();
    assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children[0]?.textContent, 'Open scene', 'the newer build keeps its handoff');
    assert.match(statusLine(view), /^Photo 2: Your partial scene is ready to review\.$/);
    assert.ok(olderReads() > before, 'the waiting build is polled once polling is free');
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.');
  });

  it('starts the exact accepted build while an unrelated list read is held', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    await view.select(1, [5, 5, 60, 70]);
    const held = deferred();
    listResponse = () => held.promise;
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    try {
      assert.ok(reads.some((entry) => entry.url.endsWith(`/${JOB_ID}`)), 'a held list does not delay observing the accepted build');
    } finally {
      held.resolve(json(503, null));
      await settle();
    }
  });

  it('advances the waiting queue while the finished build\'s list refresh is held', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    await view.select(1, [5, 5, 60, 70]);
    view.buildButton().dispatch('click');
    const newer = { ...manifest('queued'), sourceId: SOURCE_B };
    const answer = deferred();
    jobResponse = () => answer.promise;
    jobs = [newer];
    posts[1].respond(json(202, newer));
    await settle();
    const older = { ...manifest('queued'), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    jobs = [newer, older];
    posts[0].respond(json(202, older));
    await settle();
    assert.ok(!reads.some((entry) => entry.url.endsWith(`/${older.id}`)), 'the older build waits while the newer one is polled');
    const held = deferred();
    listResponse = () => held.promise;
    answer.resolve(json(200, { ...newer, status: 'ready', usageBlocked: false }));
    await settle();
    try {
      assert.ok(reads.some((entry) => entry.url.endsWith(`/${older.id}`)), 'the waiting build is polled without waiting for the list');
    } finally {
      held.resolve(json(503, null));
      await settle();
    }
  });

  it('confirms the listing from the newest list and ignores a late superseded one', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    await view.select(1, [5, 5, 60, 70]);
    const ready = { ...manifest('ready'), usageBlocked: false };
    const first = deferred();
    let calls = 0;
    listResponse = () => (++calls === 1 ? first.promise : json(200, [ready]));
    jobResponse = () => json(200, ready);
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.');
    first.resolve(json(200, []));
    await settle();
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.');
    assert.equal(view.find((node) => node.className === 'space-builds')[0].children.length, 1, 'the late empty list is not shown');
  });

  it('says a finished build is not shown yet until a later list confirms it', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    await view.select(1, [5, 5, 60, 70]);
    const ready = { ...manifest('ready'), usageBlocked: false };
    listResponse = () => json(200, []);
    jobResponse = () => json(200, ready);
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    assert.equal(view.find((node) => node.className === 'space-builds')[0].children.length, 0);
    assert.equal(background(view), 'Photo 1: A partial scene finished building. The saved scene list does not show it yet; reload the page to check.');
    const newer = { ...manifest('queued'), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sourceId: SOURCE_B };
    jobs = [newer];
    listResponse = () => json(200, [ready, newer]);
    view.buildButton().dispatch('click');
    posts[1].respond(json(202, newer));
    await settle();
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.', 'the next list that shows it confirms it');
  });

  for (const [outcome, finished, notice] of [
    ['ready', { ...manifest('ready'), usageBlocked: false }, 'Photo 1: A partial scene finished building. Checking the saved scene list…'],
    ['failed', { ...manifest('failed'), error: 'The build failed.' }, 'Photo 1: Failed. The build failed.'],
  ]) {
    it(`announces a ${outcome} background build at once while its list refresh is held`, async () => {
      const view = mount();
      await view.select(0, [1, 1, 50, 40]);
      view.buildButton().dispatch('click');
      await view.select(1, [5, 5, 60, 70]);
      const answer = deferred();
      jobResponse = () => answer.promise;
      jobs = [manifest('queued')];
      posts[0].respond(json(202, manifest('queued')));
      await settle();
      assert.ok(reads.some((entry) => entry.url.endsWith(`/${JOB_ID}`)));
      const held = deferred();
      listResponse = () => held.promise;
      const focused = [];
      const focus = FakeElement.prototype.focus;
      FakeElement.prototype.focus = function () { focused.push(this); };
      try {
        answer.resolve(json(200, finished));
        await settle();
        assert.equal(background(view), notice);
        assert.equal(statusLine(view), '', 'the creator\'s status is left alone');
        assert.equal(view.heading(), 'Choose an object in photo 2');
        assert.deepEqual(view.calls, [null, null]);
        assert.deepEqual(focused, [], 'completion does not move focus');
      } finally {
        FakeElement.prototype.focus = focus;
        held.resolve(json(503, null));
        await settle();
      }
    });
  }

  it('announces an already finished build accepted after navigation while the list read is held', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    await view.select(1, [5, 5, 60, 70]);
    const held = deferred();
    listResponse = () => held.promise;
    posts[0].respond(json(202, { ...manifest('ready'), usageBlocked: false }));
    await settle();
    try {
      assert.equal(background(view), 'Photo 1: A partial scene finished building. Checking the saved scene list…');
      assert.equal(view.heading(), 'Choose an object in photo 2');
    } finally {
      held.resolve(json(200, [{ ...manifest('ready'), usageBlocked: false }]));
      await settle();
    }
    assert.equal(background(view), 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.', 'the list read refines its own notice');
  });

  it('does not let a late listing confirmation hide a newer background failure', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    await view.select(1, [5, 5, 60, 70]);
    const earlier = { ...manifest('ready'), usageBlocked: false };
    jobResponse = () => json(200, earlier);
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    assert.match(background(view), /does not show it yet/);

    view.buildButton().dispatch('click');
    await view.select(0, [1, 1, 50, 40]);
    const failed = { ...manifest('failed'), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sourceId: SOURCE_B, error: 'The later build failed.' };
    jobs = [failed];
    posts[1].respond(json(202, { ...failed, status: 'queued', error: null }));
    await settle();
    assert.equal(background(view), 'Photo 2: Failed. The later build failed.');

    view.buildButton().dispatch('click');
    const third = { ...manifest('queued'), id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    jobs = [earlier, failed, third];
    posts[2].respond(json(202, third));
    await settle();
    assert.equal(background(view), 'Photo 2: Failed. The later build failed.', 'an older confirmation is retired by the newer notice');
  });

  for (const [listed, expected] of [
    ['a stale', () => json(200, [])],
    ['an already ready', () => json(200, [{ ...manifest('ready'), usageBlocked: false }])],
    ['a failed', () => json(503, null)],
  ]) {
    it(`observes a build accepted after navigation before the response, with ${listed} list`, async () => {
      const view = mount();
      await view.select(0, [1, 1, 50, 40]);
      view.buildButton().dispatch('click');
      await view.select(1, [5, 5, 60, 70]);
      listResponse = expected;
      jobResponse = () => json(200, { ...manifest('ready'), usageBlocked: false });
      posts[0].respond(json(202, manifest('queued')));
      await settle();
      assert.ok(reads.some((entry) => entry.url.endsWith(`/${JOB_ID}`)), 'the exact accepted build is polled');
      assert.equal(background(view), {
        'a stale': 'Photo 1: A partial scene finished building. The saved scene list does not show it yet; reload the page to check.',
        'an already ready': 'Photo 1: A partial scene finished building. It is listed under “Build or choose another scene”.',
        'a failed': 'Photo 1: A partial scene finished building. The saved scene list could not be loaded; reload the page to see it.',
      }[listed]);
      assert.equal(view.heading(), 'Choose an object in photo 2');
      assert.equal(statusLine(view), '', 'the creator\'s status is left alone');
      assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
      assert.deepEqual(view.calls, [null, null]);
    });
  }

  it('does not present a ready action after the saved-scene list fails', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    listResponse = () => json(503, null);
    posts[0].respond(json(202, { ...manifest('ready'), usageBlocked: false }));
    await settle();
    assert.match(view.container.textContent, /Saved partial scenes could not be loaded/);
    assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
  });

  it('does not attribute a different polled job to the requested build', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    jobResponse = () => json(200, { ...manifest('ready'), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', usageBlocked: false });
    view.buildButton().dispatch('click');
    jobs = [manifest('queued')];
    posts[0].respond(json(202, manifest('queued')));
    await settle();
    assert.match(view.container.textContent, /This build could not be confirmed/);
    assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
  });

  for (const [state, extra, expected] of [
    ['failed', { error: 'The build failed.' }, /Failed/],
    ['interrupted', {}, /Interrupted/],
    ['ready', { usageBlocked: true }, /cannot be shown/],
    ['ready', {}, /access could not be confirmed/],
  ]) {
    it(`does not offer a ready action for ${state}${extra.usageBlocked ? ' blocked' : ''}`, async () => {
      const view = mount();
      await view.select(0, [1, 1, 50, 40]);
      view.buildButton().dispatch('click');
      const response = { ...manifest(state), ...extra };
      jobs = [response];
      posts[0].respond(json(202, response));
      await settle();
      assert.match(view.container.textContent, expected);
      assert.equal(view.find((node) => node.className === 'actions space-ready')[0].children.length, 0);
    });
  }
  it('keeps a newer selection when an older build is acknowledged late, and still lists the job', async () => {
    const view = mount();
    await view.select(0, [1, 1, 50, 40]);
    view.button('Build partial scene')[0].dispatch('click');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.sourceId, SOURCE_A);

    await view.select(1, [5, 5, 60, 70]);
    assert.equal(view.heading(), 'Choose an object in photo 2');

    jobs = [manifest('queued')];
    posts[0].respond(json(202, manifest('queued')));
    await settle();

    assert.equal(view.heading(), 'Choose an object in photo 2');
    const message = view.find((node) => node.className === 'space-panel')[0].findAll((node) => node.className === 'form-message');
    assert.ok(message.every((node) => node.textContent === ''));
    assert.ok(view.find((node) => node.className === 'space-builds')[0].children.length === 1, 'accepted job is listed');
    view.space.dispose();
  });

  it('reuses the request ID only after an unconfirmed response, and sends the chosen source and box', async () => {
    const view = mount();
    await view.select(1, [5, 5, 60, 70]);
    view.button('Build partial scene')[0].dispatch('click');
    posts[0].respond({ status: 0, ok: false, json: async () => null });
    await settle();
    view.button('Build partial scene')[0].dispatch('click');
    assert.equal(posts[1].body.requestId, posts[0].body.requestId);
    assert.deepEqual(posts[1].body, { requestId: posts[0].body.requestId, sourceId: SOURCE_B, box: [5, 5, 60, 70] });

    posts[1].respond(json(409, { error: 'Another scene is being built. Try again in a few minutes.' }));
    await settle();
    assert.match(view.container.textContent, /Another scene is being built/);
    view.button('Build partial scene')[0].dispatch('click');
    assert.notEqual(posts[2].body.requestId, posts[0].body.requestId);
    view.space.dispose();
  });

  it('uses the server stored-pixel size, not the browser natural size, for drag and bounds', async () => {
    const view = mount();
    view.open(0);
    assert.match(sizeRequests[0], new RegExp(`/api/drafts/${DRAFT_ID}/sources/${SOURCE_A}/image-size$`));
    view.image().dispatch('load');
    await settle();
    // Drawn without EXIF rotation: the on-screen box keeps the stored 1007:801 shape.
    view.image().rect = { left: 10, top: 20, width: 503.5, height: 400.5 };
    const frame = view.find((node) => node.className === 'box-select')[0];
    frame.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
    frame.dispatch('pointermove', { pointerId: 1, clientX: 10 + 503.5, clientY: 20 + 400.5 });
    frame.dispatch('pointerup', { pointerId: 1 });
    assert.deepEqual(view.inputs().map((input) => input.value), ['0', '0', '1007', '801']);
    assert.deepEqual(view.inputs().map((input) => input.max), ['1007', '801', '1007', '801']);
    assert.equal(view.buildButton().disabled, false);

    // A right edge past the stored width is out of bounds even though the
    // browser's rotated naturalHeight would allow it.
    view.typeBox([0, 0, 1007, 900]);
    assert.equal(view.buildButton().disabled, true);
    view.space.dispose();
  });

  it('keeps Build disabled until both the photo and its size are ready', async () => {
    const view = mount();
    let respond;
    sizeResponse = () => new Promise((resolve) => (respond = resolve));
    view.open(0);
    view.typeBox([1, 1, 50, 40]);
    view.image().dispatch('load');
    assert.equal(view.buildButton().disabled, true);
    view.buildButton().dispatch('click');
    assert.equal(posts.length, 0);
    respond(json(200, { width: 1007, height: 801 }));
    await settle();
    assert.equal(view.buildButton().disabled, false);
    view.space.dispose();
  });

  it('says so and never builds when the size cannot be read', async () => {
    const view = mount();
    sizeResponse = () => json(403, { error: 'This photo is not allowed to be used for model processing.' });
    view.open(0);
    view.image().dispatch('load');
    await settle();
    view.typeBox([1, 1, 50, 40]);
    view.buildButton().dispatch('click');
    assert.equal(view.buildButton().disabled, true);
    assert.equal(posts.length, 0);
    assert.match(view.message(), /not allowed to be used for model processing\. A box cannot be chosen, and nothing was sent to the model\./);
    assert.equal(view.find((node) => node.className === 'box-fields')[0].disabled, true);
    view.space.dispose();
  });

  it('ignores a size response for a selection that was replaced', async () => {
    const view = mount();
    const pending = [];
    sizeResponse = () => new Promise((resolve) => pending.push(resolve));
    view.open(0);
    view.open(1);
    view.image().dispatch('load');
    pending[1](json(200, { width: 300, height: 200 }));
    await settle();
    pending[0](json(200, { width: 1007, height: 801 }));
    await settle();
    assert.equal(view.heading(), 'Choose an object in photo 2');
    assert.deepEqual(view.inputs().map((input) => input.max), ['300', '200', '300', '200']);
    view.space.dispose();
  });

  it('offers no build action for photos without both grants or without source details', () => {
    const view = mount({ [SOURCE_A]: { kind: 'photo', permissions: { place: true, model: false, share: true } } });
    assert.equal(view.button('Build a partial scene').length, 0);
    assert.match(view.container.textContent, /Use for model processing/);
    assert.match(view.container.textContent, /no uses were granted/);
    view.space.dispose();
  });
});

describe('manual editor precision', () => {
  // Saved geometry the fields cannot show exactly: a non-integer negative turn
  // and tiny or high-precision offsets.
  const SAVED = { version: 1, offset: [0.123456789, -0.000001234, 0.987654321], yaw: -1.2345678901 };
  async function openEditor() {
    const ui = mount();
    jobs.push({ ...manifest('ready'), edit: { ...SAVED, offset: [...SAVED.offset] }, usageBlocked: false, blockedReason: null });
    for (let i = 0; i < 5; i += 1) await settle();
    ui.button('Open scene')[0].dispatch('click');
    for (let i = 0; i < 10; i += 1) await settle();
    const axis = (label) => ui.find((node) => node.tag === 'input' && node.attributes['aria-label'] === label)[0];
    const edits = () => posts.filter((post) => post.url.endsWith('/edit'));
    const save = () => ui.button('Apply and save')[0];
    const set = (label, value) => {
      axis(label).value = value;
      axis(label).dispatch('input');
    };
    return { ...ui, axis, edits, save, set };
  }
  const bodyOf = (post) => ({ offset: post.body.offset, yaw: post.body.yaw });

  for (const label of ['Left / right', 'Left / right slider']) {
    it(`an X-only edit by ${label.endsWith('slider') ? 'slider' : 'number field'} keeps every other axis exactly`, async () => {
      const ui = await openEditor();
      assert.equal(ui.axis('Turn (degrees)').value, '-71', 'the field shows a rounded turn');
      ui.set(label, '0.5');
      ui.save().dispatch('click');
      await settle();
      assert.equal(ui.edits().length, 1);
      assert.deepEqual(bodyOf(ui.edits()[0]), { offset: [0.5, -0.000001234, 0.987654321], yaw: -1.2345678901 });
    });
  }

  it('a turn-only edit keeps the offsets exactly, and an explicit whole-degree turn is used as typed', async () => {
    const ui = await openEditor();
    ui.set('Turn (degrees)', '30');
    ui.save().dispatch('click');
    await settle();
    assert.deepEqual(bodyOf(ui.edits()[0]), { offset: [0.123456789, -0.000001234, 0.987654321], yaw: (30 * Math.PI) / 180 });

    const again = await openEditor();
    again.set('Turn (degrees)', '-71');
    again.save().dispatch('click');
    await settle();
    assert.deepEqual(bodyOf(again.edits()[0]), { offset: [0.123456789, -0.000001234, 0.987654321], yaw: (-71 * Math.PI) / 180 }, 'typing the shown -71 sets exactly -71 degrees');
  });

  it('an invalid other field blocks saving until fixed and is never replaced; revert restores the exact saved geometry', async () => {
    const ui = await openEditor();
    ui.set('Down / up', '9');
    ui.set('Left / right', '0.4');
    assert.equal(ui.axis('Down / up').value, '9', 'the invalid text stays as typed');
    assert.equal(ui.save().disabled, true);
    ui.save().dispatch('click');
    await settle();
    assert.equal(ui.edits().length, 0, 'nothing is sent behind an invalid field');
    ui.set('Down / up', '0.1');
    ui.save().dispatch('click');
    await settle();
    assert.deepEqual(bodyOf(ui.edits()[0]), { offset: [0.4, 0.1, 0.987654321], yaw: -1.2345678901 });

    const reverted = await openEditor();
    reverted.set('Left / right', '0.7');
    reverted.button('Revert to saved')[0].dispatch('click');
    assert.equal(reverted.save().disabled, true, 'nothing left to save after revert');
    reverted.set('Away / toward', '0.2');
    reverted.save().dispatch('click');
    await settle();
    assert.deepEqual(bodyOf(reverted.edits()[0]), { offset: [0.123456789, -0.000001234, 0.2], yaw: -1.2345678901 }, 'the reverted X is the exact saved value');
  });
});
