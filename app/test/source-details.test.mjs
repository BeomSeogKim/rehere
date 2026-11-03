import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proposalBlockedReason } from '../public/memory-edit.js';
import { buildBlockedReason } from '../public/photo-scene.js';
import { createRecorder } from '../public/recorder.js';
import {
  buildMetadata,
  createSourceDetails,
  createVoiceSource,
  describeSource,
  detailsProblem,
  isCalendarDate,
  photoUseNeeds,
  renderPhotoUses,
  renderSavedSource,
  renderSourceControls,
  summarize,
  toSourceInput,
} from '../public/source-details.js';

// Just enough of the DOM for the controls: elements, children, text and events.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.value = '';
    this.checked = false;
    this.open = false;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
  get textContent() {
    return this._text ?? this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  set textContent(value) {
    this._text = String(value);
  }
  findAll(predicate) {
    const found = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (predicate(child)) found.push(child);
      found.push(...child.findAll(predicate));
    }
    return found;
  }
}

const fakeDocument = { createElement: (tag) => new FakeElement(tag) };
const byType = (root, type) => root.findAll((node) => node.tag === 'input' && node.type === type);

function sampleRecord(overrides = {}) {
  return {
    id: '7d0f2c9e-0000-4000-8000-000000000000',
    kind: 'photo',
    role: 'original',
    parentSourceId: null,
    name: 'photo-1.jpg',
    sha256: 'a'.repeat(64),
    size: 10,
    type: 'image/jpeg',
    provider: 'Family album',
    origin: { kind: 'own', reference: '' },
    permissions: { place: true, model: false, share: false },
    dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
    ...overrides,
  };
}

describe('source details model', () => {
  it('starts unknown with every permission denied', () => {
    const input = toSourceInput(createSourceDetails());
    assert.deepEqual(input, {
      provider: '',
      origin: { kind: 'unknown', reference: '' },
      permissions: { place: false, model: false, share: false },
      dates: { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' },
    });
  });

  it('maps File.lastModified only to fileModifiedAt', () => {
    const lastModified = Date.UTC(2020, 5, 1, 12, 30);
    const input = toSourceInput(createSourceDetails(), { lastModified });
    assert.equal(input.dates.fileModifiedAt, '2020-06-01T12:30:00.000Z');
    assert.equal(input.dates.capturedOn, null);
    assert.equal(input.dates.fileCreatedAt, null);
  });

  it('keeps one granted permission from implying the others', () => {
    const details = createSourceDetails();
    details.permissions.place = true;
    assert.deepEqual(toSourceInput(details).permissions, { place: true, model: false, share: false });
  });

  it('normalizes blank labels to empty strings', () => {
    const details = { ...createSourceDetails(), provider: '   ', reference: '\n', estimatedPeriod: ' ' };
    const input = toSourceInput(details);
    assert.equal(input.provider, '');
    assert.equal(input.origin.reference, '');
    assert.equal(input.dates.estimatedPeriod, '');
  });

  it('sends per-photo metadata in order and nulls for absent text and voice', () => {
    const first = { file: { lastModified: 0 }, details: { ...createSourceDetails(), provider: 'Me', originKind: 'own' } };
    const second = { file: { lastModified: 0 }, details: { ...createSourceDetails(), provider: 'Archive', originKind: 'public' } };
    const metadata = buildMetadata({
      photos: [first, second],
      text: '   ',
      textDetails: createSourceDetails(),
      voice: null,
      voiceDetails: createSourceDetails(),
    });
    assert.deepEqual(metadata.photos.map((photo) => [photo.provider, photo.origin.kind]), [['Me', 'own'], ['Archive', 'public']]);
    assert.equal(metadata.text, null);
    assert.equal(metadata.voice, null);
    assert.deepEqual(Object.keys(metadata), ['photos', 'text', 'voice']);
  });

  it('includes text and voice metadata when both are sent', () => {
    const textDetails = { ...createSourceDetails(), provider: 'Writer' };
    const metadata = buildMetadata({
      photos: [],
      text: 'A quiet street',
      textDetails,
      voice: new Blob(['x']),
      voiceDetails: createSourceDetails(),
    });
    assert.equal(metadata.text.provider, 'Writer');
    assert.equal(metadata.voice.dates.fileModifiedAt, null);
  });

  it('accepts only real calendar dates', () => {
    assert.equal(isCalendarDate('2024-02-29'), true);
    assert.equal(isCalendarDate('2023-02-29'), false);
    assert.equal(isCalendarDate('2023-13-01'), false);
    assert.equal(isCalendarDate('2023-1-01'), false);
  });

  it('reports overlong labels and impossible dates before sending', () => {
    assert.equal(detailsProblem(createSourceDetails()), null);
    assert.match(detailsProblem({ ...createSourceDetails(), provider: 'x'.repeat(121) }), /120 characters/);
    assert.match(detailsProblem({ ...createSourceDetails(), capturedOn: '2023-02-30' }), /calendar date/);
  });

  it('summarizes provider and granted uses', () => {
    const details = createSourceDetails();
    assert.equal(summarize(details), 'Not specified · no uses allowed');
    details.provider = 'Grandmother';
    details.permissions.share = true;
    assert.equal(summarize(details), 'Grandmother · 1 of 3 uses allowed');
  });
});

describe('source details controls', () => {
  it('writes edits into the owning details and starts unchecked', () => {
    const details = createSourceDetails();
    const state = {};
    const root = renderSourceControls(fakeDocument, { details, state, label: 'photo 1' });
    const boxes = byType(root, 'checkbox');
    assert.equal(boxes.length, 3);
    assert.ok(boxes.every((box) => !box.checked));

    const [provider] = byType(root, 'text');
    provider.value = 'Neighbour';
    provider.fire('input');
    boxes[1].checked = true;
    boxes[1].fire('change');
    root.open = true;
    root.fire('toggle');

    assert.equal(details.provider, 'Neighbour');
    assert.deepEqual(details.permissions, { place: false, model: true, share: false });
    assert.equal(state.open, true);
  });

  it('restores values and the expanded state when re-rendered', () => {
    const details = { ...createSourceDetails(), provider: 'Kept', capturedOn: '1999-07-04' };
    const root = renderSourceControls(fakeDocument, { details, state: { open: true }, label: 'photo 2' });
    assert.equal(root.open, true);
    assert.equal(byType(root, 'text')[0].value, 'Kept');
    assert.equal(byType(root, 'date')[0].value, '1999-07-04');
  });

  it('says an empty date stays unknown, and only shows or hides that line', () => {
    const EMPTY = 'No date entered; it will be saved as unknown.';
    const details = createSourceDetails();
    const root = renderSourceControls(fakeDocument, { details, state: {}, label: 'photo 1' });
    const [date] = byType(root, 'date');
    const [status] = root.findAll((node) => node.textContent === EMPTY);
    assert.equal(status.hidden, false, 'shown while nothing is entered');
    assert.equal(date.attributes['aria-describedby'], `${date.id}-hint ${status.id}`, 'the existing hint stays linked first');
    assert.equal(toSourceInput(details).dates.capturedOn, null);
    date.value = '1999-07-04';
    date.fire('input');
    assert.equal(status.hidden, true, 'hidden once a date is chosen');
    assert.equal(toSourceInput(details).dates.capturedOn, '1999-07-04', 'the chosen date is kept as entered');
    date.value = '';
    date.fire('change');
    assert.equal(status.hidden, false, 'shown again after clearing');
    date.fire('input');
    assert.equal(toSourceInput(details).dates.capturedOn, null, 'a cleared date is saved as unknown');
    const filled = renderSourceControls(fakeDocument, { details: { ...createSourceDetails(), capturedOn: '2001-01-01' }, state: {}, label: 'photo 2' });
    assert.equal(filled.findAll((node) => node.textContent === EMPTY)[0].hidden, true, 'hidden for an existing date');
  });

  it('labels the file timestamp as file metadata only for files', () => {
    const withFile = renderSourceControls(fakeDocument, {
      details: createSourceDetails(),
      state: {},
      label: 'photo 1',
      file: { lastModified: Date.UTC(2021, 0, 1) },
    });
    assert.match(withFile.textContent, /File metadata: last modified/);
    const withoutFile = renderSourceControls(fakeDocument, { details: createSourceDetails(), state: {}, label: 'text' });
    assert.doesNotMatch(withoutFile.textContent, /File metadata/);
  });
});

describe('photo use rows before saving', () => {
  function photo() {
    const details = createSourceDetails();
    const uses = renderPhotoUses(fakeDocument, details, 'photo-uses-1');
    const controls = renderSourceControls(fakeDocument, { details, state: {}, label: 'photo 1', onChange: uses.refresh, describedBy: 'photo-uses-1' });
    const rows = uses.element.findAll((node) => node.tag === 'li');
    const [place, model, share] = byType(controls, 'checkbox');
    const tick = (box, on = true) => {
      box.checked = on;
      box.fire('change');
    };
    const origin = (kind) => {
      const select = controls.findAll((node) => node.tag === 'select')[0];
      select.value = kind;
      select.fire('change');
    };
    return { details, uses, controls, rows, place, model, share, tick, origin, text: () => rows.map((row) => row.textContent) };
  }

  it('lists only what a new photo still needs, beside collapsed controls, and claims nothing', () => {
    const p = photo();
    assert.equal(p.controls.open, false);
    assert.equal(p.uses.element.id, 'photo-uses-1');
    assert.equal(p.controls.findAll((node) => node.tag === 'summary')[0].attributes['aria-describedby'], 'photo-uses-1');
    assert.deepEqual(p.text(), [
      'Build scene: needs reconstruct this place + model processing',
      'Memory edits: needs reconstruct this place + model processing + public source',
      'Visit link: needs reconstruct this place + share with others + public source',
    ]);
    assert.doesNotMatch(p.uses.element.textContent, /ready/i);
  });

  it('follows the real controls live with the same rows', () => {
    const p = photo();
    const before = [...p.rows];
    p.tick(p.place);
    p.tick(p.model);
    p.tick(p.share);
    assert.deepEqual(p.text(), ['Build scene: permitted by these settings', 'Memory edits: needs public source', 'Visit link: needs public source']);
    p.origin('public');
    p.tick(p.model, false);
    assert.deepEqual(p.text(), ['Build scene: needs model processing', 'Memory edits: needs model processing', 'Visit link: permitted by these settings']);
    assert.ok(p.rows.every((row, i) => row === before[i]), 'rows are updated in place');
  });

  it('agrees with the build and planning checks and the share rule for every grant and source type', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      for (const kind of ['public', 'own', 'other', 'unknown']) {
        const details = { ...createSourceDetails(), originKind: kind, permissions: { place: Boolean(mask & 1), model: Boolean(mask & 2), share: Boolean(mask & 4) } };
        const record = { kind: 'photo', ...toSourceInput(details) };
        const [build, plan, share] = photoUseNeeds(details);
        const label = `${kind} ${JSON.stringify(details.permissions)}`;
        assert.equal(build.missing === null, buildBlockedReason(record) === null, `build ${label}`);
        assert.equal(plan.missing === null, proposalBlockedReason(record) === null, `plan ${label}`);
        assert.equal(share.missing === null, kind === 'public' && details.permissions.place && details.permissions.share, `share ${label}`);
        for (const use of [build, plan, share]) assert.ok(use.missing === null || use.missing.length > 0, `a blocked use names what it needs: ${use.name} ${label}`);
      }
    }
  });

  it('keeps photos apart and leaves the saved metadata exactly as set', () => {
    const a = photo();
    const b = photo();
    a.tick(a.share);
    a.origin('public');
    assert.equal(a.text()[2], 'Visit link: needs reconstruct this place');
    assert.equal(b.text()[2], 'Visit link: needs reconstruct this place + share with others + public source');
    const metadata = buildMetadata({ photos: [{ details: a.details }, { details: b.details }], text: '', textDetails: createSourceDetails(), voice: null, voiceDetails: null });
    assert.deepEqual(metadata.photos.map((entry) => [entry.origin.kind, entry.permissions]), [
      ['public', { place: false, model: false, share: true }],
      ['unknown', { place: false, model: false, share: false }],
    ]);
  });
});

describe('saved source view', () => {
  it('shows legacy items as unavailable with nothing granted', () => {
    const { available, rows } = describeSource(null);
    assert.equal(available, false);
    assert.match(rows[0].value, /No uses were granted/);
  });

  it('shows each permission independently, unknown dates and the checksum', () => {
    const { rows } = describeSource(sampleRecord());
    const value = (label) => rows.find((row) => row.label === label)?.value;
    assert.equal(value('Use to reconstruct this place'), 'Allowed');
    assert.equal(value('Use for model processing'), 'Not allowed');
    assert.equal(value('Share with others'), 'Not allowed');
    assert.equal(value('Date taken'), 'Unknown');
    assert.equal(value('File modified (file metadata)'), 'Unknown');
    assert.equal(value('Original checksum (SHA-256)'), 'a'.repeat(64));
    assert.ok(!rows.some((row) => row.value.includes('7d0f2c9e')), 'internal id is not shown');
  });

  it('shows a capture date as the calendar day the user entered', () => {
    const record = sampleRecord({ dates: { capturedOn: '2001-01-01', fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' } });
    assert.equal(describeSource(record).rows.find((row) => row.label === 'Date taken').value, 'Jan 1, 2001');
  });

  it('renders metadata as text, not markup', () => {
    const root = renderSavedSource(fakeDocument, sampleRecord({ provider: '<img src=x onerror=alert(1)>' }));
    const values = root.findAll((node) => node.tag === 'dd').map((node) => node.textContent);
    assert.ok(values.includes('<img src=x onerror=alert(1)>'));
    assert.ok(root.findAll((node) => node.tag === 'img').length === 0);
  });
});

class FakeMediaRecorder extends EventTarget {
  static latest = null;
  constructor() {
    super();
    this.mimeType = 'audio/webm';
    this.state = 'inactive';
    FakeMediaRecorder.latest = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      const data = new Event('dataavailable');
      data.data = new Blob(['audio'], { type: this.mimeType });
      this.dispatchEvent(data);
      this.dispatchEvent(new Event('stop'));
    });
  }
}

function voiceSetup() {
  const recorder = createRecorder({
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    MediaRecorder: FakeMediaRecorder,
  });
  let resets = 0;
  const voice = createVoiceSource(recorder, () => (resets += 1));
  const grant = () => {
    voice.current.details.provider = 'Aunt';
    voice.current.details.permissions.share = true;
  };
  return { recorder, voice, grant, resets: () => resets };
}

describe('voice source details', () => {
  it('drops details and grants when a recording is discarded, so a new recording starts unknown', async () => {
    const { recorder, voice, grant, resets } = voiceSetup();
    await recorder.start();
    await recorder.stop();
    grant();
    recorder.discard();
    assert.equal(resets(), 1);
    await recorder.start();
    await recorder.stop();
    assert.equal(recorder.snapshot().state, 'recorded');
    assert.deepEqual(toSourceInput(voice.current.details), toSourceInput(createSourceDetails()));
  });

  it('drops details entered while a take is cancelled or abandoned', async () => {
    const { recorder, voice, grant } = voiceSetup();
    await recorder.start();
    grant();
    recorder.discard();
    assert.equal(voice.current.details.permissions.share, false);
    assert.equal(voice.current.details.provider, '');
  });

  it('keeps details for the same recording through stop, a failed save and leaving the page', async () => {
    const { recorder, voice, grant, resets } = voiceSetup();
    await recorder.start();
    grant();
    recorder.leave();
    await recorder.stop();
    // A failed save leaves the recording in place; stop() is called again on retry.
    await recorder.stop();
    assert.equal(recorder.snapshot().state, 'recorded');
    assert.equal(resets(), 0);
    assert.equal(voice.current.details.provider, 'Aunt');
    assert.equal(voice.current.details.permissions.share, true);
  });
});
