import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { callText, decisionText, mountEvidenceReview, uncheckedText, verdictText } from '../public/evidence-review.js';

const DRAFT = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVIEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTE = 'The dining room had large windows looking out over the canyon.';
const PHOTOS = [{ sourceId: A, index: 0, url: '/a.jpg' }, { sourceId: B, index: 1, url: '/b.jpg' }, { sourceId: C, index: 2, url: '/c.jpg' }];
const doc = { createElement: (tag) => new FakeElement(tag) };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const CALL = { model: 'muse-spark-1.3', responseId: 'resp_fixture', usage: { inputTokens: 2000, outputTokens: 120, estimatedUsd: 0.00301 }, mode: 'live', latencyMs: 4100 };
const answered = (extra = {}) => ({
  id: REVIEW, requestId: 'r', status: 'answered', createdAt: 'now', updatedAt: 'now', noteSourceId: 'n', sourceIds: [A, B], call: CALL, available: true,
  result: {
    findings: [
      { part: 'large windows', verdict: 'supports', sourceId: A, crop: [0.1, 0.2, 0.6, 0.7], observation: 'Tall windows line the far wall.' },
      { part: 'looking out over the canyon', verdict: 'not_visible', sourceId: null, crop: null, observation: 'Only bright glass is visible; no view outside.' },
    ],
    uncertainty: 'The photos cannot show what the windows faced.',
  },
  error: null, decision: null, ...extra,
});
const listing = (reviews = [], extra = {}) => ({
  enabled: true, note: { available: true, modelAllowed: true, tooLong: false },
  photos: [{ sourceId: A, index: 0, modelAllowed: true }, { sourceId: B, index: 1, modelAllowed: true }, { sourceId: C, index: 2, modelAllowed: false }],
  reviews, ...extra,
});
const buttons = (root, text) => root.findAll((node) => node.tag === 'button' && node.textContent === text);

function harness(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected ${url}`);
    return next;
  };
  const container = new FakeElement('div');
  const view = mountEvidenceReview(container, { draftId: DRAFT, note: NOTE, photos: PHOTOS, fetch, doc, randomId: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
  return { calls, container, view };
}

describe('owner evidence review panel', () => {
  it('stays empty when the check is not set up and nothing was checked', async () => {
    const { container } = harness([json(200, listing([], { enabled: false }))]);
    await settle();
    assert.equal(container.children.length, 0);
  });

  it('sends only the chosen model-allowed photos once, with consent, and never offers a photo without model use', async () => {
    const { calls, container } = harness([json(200, listing()), json(201, { replayed: false, review: answered() }), json(200, listing([answered()]))]);
    await settle();
    assert.match(container.textContent, /not proof of what happened/);
    buttons(container, 'Check the note against photos…')[0].dispatch('click');
    assert.match(container.textContent, /Photo 3: model use is off, so it is never sent/);
    const boxes = container.findAll((node) => node.tag === 'input');
    assert.equal(boxes.length, 2);
    assert.equal(buttons(container, 'Send once for a check')[0].disabled, true);
    boxes[0].checked = true;
    boxes[0].dispatch('change');
    buttons(container, 'Send once for a check')[0].dispatch('click');
    await settle();
    const sent = calls.find((call) => call.init.method === 'POST');
    assert.deepEqual(JSON.parse(sent.init.body), { requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sourceIds: [A], consent: true });
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    // The result: each part, its verdict, the outlined region and what is unchecked.
    const text = container.textContent;
    assert.match(text, /Visible support in photo 1/);
    assert.match(text, /Not visible in these photos/);
    assert.match(text, /Not checked: The dining room had/);
    assert.match(text, /What these photos cannot settle: The photos cannot show what the windows faced\./);
    assert.match(text, /Model: muse-spark-1\.3 · response ID: resp_fixture · 4100 ms/);
    const [crop] = container.findAll((node) => node.className === 'evidence-crop evidence-supports');
    assert.deepEqual(crop.style, { left: '10%', top: '20%', width: '50%', height: '50%' });
    assert.equal(buttons(container, 'Keep this result').length, 1);
  });

  it('records the owner decision and then shows it instead of the buttons', async () => {
    const decided = answered({ decision: { choice: 'accepted', by: { displayName: 'Synthetic owner' }, at: 'today' } });
    const { calls, container } = harness([json(200, listing([answered()])), json(200, { review: decided }), json(200, listing([decided]))]);
    await settle();
    buttons(container, 'Keep this result')[0].dispatch('click');
    await settle();
    assert.equal(calls[1].url, `/api/drafts/${DRAFT}/evidence-reviews/${REVIEW}/decision`);
    assert.deepEqual(JSON.parse(calls[1].init.body), { choice: 'accepted' });
    assert.match(container.textContent, /Kept by Synthetic owner on today\./);
    assert.equal(buttons(container, 'Keep this result').length, 0);
  });

  it('shows a failed or withheld check without any result to keep', async () => {
    const failed = { ...answered(), status: 'failed', result: null, error: 'The model answer did not name parts of this note, the sent photos and regions inside them, so no result is offered.' };
    const hidden = { ...answered(), available: false, result: null };
    const { container } = harness([json(200, listing([failed, hidden], { enabled: false }))]);
    await settle();
    assert.match(container.textContent, /did not name parts of this note/);
    assert.match(container.textContent, /stopped or no longer usable here/);
    assert.equal(buttons(container, 'Keep this result').length, 0);
    assert.equal(buttons(container, 'Check the note against photos…').length, 0);
  });

  it('describes verdicts, unchecked text, calls and decisions plainly', () => {
    assert.equal(verdictText({ verdict: 'conflicts', sourceId: B }, PHOTOS), 'Visible conflict in photo 2');
    assert.equal(verdictText({ verdict: 'not_visible', sourceId: A }, PHOTOS), 'Not visible in these photos (closest region: photo 1)');
    assert.equal(uncheckedText(NOTE, [{ part: NOTE }]), '');
    assert.equal(uncheckedText(NOTE, [{ part: 'large windows' }]), 'The dining room had … looking out over the canyon.');
    assert.equal(callText({ model: null, responseId: null, usage: null, latencyMs: null }), 'Model: not returned · response ID: not returned · usage not returned');
    assert.equal(decisionText({ choice: 'dismissed', by: { displayName: null }, at: 'x' }), 'Dismissed by the owner on x.');
  });
});
