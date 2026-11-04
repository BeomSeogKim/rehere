import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { claimVerdict, loadDataset, partRuleAgrees, runEvaluation, scoreResults, validateDataset } from '../evaluation/evidence/evaluate.mjs';
import { BudgetLedger, createMetaSender } from '../meta-model.mjs';
import { acceptingTestMediaVerifier, png } from './auth-helper.mjs';

// Synthetic photos and a fake provider; nothing reaches the network.
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const reply = (json, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
const generated = (answer) => ({
  id: `resp_${Math.random().toString(16).slice(2)}`, model: 'muse-spark-1.3', status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
  usage: { input_tokens: 1500, output_tokens: 300 },
});

function miniDataset() {
  const photos = [
    { id: 'P-1', file: 'p1.png', bytes: png(40, 30, 1), caption: 'Synthetic room', credit: 'Synthetic credit.', rights: 'Synthetic test image.' },
    { id: 'P-2', file: 'p2.png', bytes: png(40, 30, 2), caption: 'Synthetic chair', credit: 'Synthetic credit.', rights: 'Synthetic test image.' },
  ];
  const dataset = validateDataset({
    schemaVersion: 1, label: 'Synthetic expected verdicts for tests.',
    photos: photos.map(({ bytes, ...photo }) => ({ ...photo, sha256: sha256(bytes) })),
    claims: [
      { id: 'a', photos: ['P-1'], note: 'I think the room had a window.', expected: 'supports', expectedSource: 'P-1', rationale: 'Synthetic.' },
      { id: 'b', photos: ['P-1', 'P-2'], note: 'I think the chair was red.', expected: 'not_visible', expectedSource: null, rationale: 'Synthetic.' },
    ],
  });
  return { dataset, photoBytes: new Map(photos.map((photo) => [photo.id, photo.bytes])) };
}

describe('evidence review evaluation', () => {
  it('maps findings to one claim verdict by the stated rule', () => {
    const f = (...verdicts) => verdicts.map((verdict) => ({ verdict }));
    assert.equal(claimVerdict(f('supports', 'supports')), 'supports');
    assert.equal(claimVerdict(f('supports', 'conflicts')), 'conflicts');
    assert.equal(claimVerdict(f('not_visible')), 'not_visible');
    assert.equal(claimVerdict(f('supports', 'not_visible')), 'mixed');
    assert.equal(claimVerdict([]), 'failed');
    assert.equal(claimVerdict(null), 'failed');
  });

  it('ships 40 labelled claims over pinned public photos', async () => {
    const dataset = await loadDataset();
    assert.equal(dataset.claims.length, 40);
    assert.match(dataset.label, /development team \(AI-assisted\), not independent annotators/);
    assert.match(dataset.label, /never historical truth/);
    const counts = dataset.claims.reduce((map, claim) => ({ ...map, [claim.expected]: (map[claim.expected] ?? 0) + 1 }), {});
    assert.deepEqual(counts, { supports: 16, conflicts: 10, not_visible: 14 });
    assert.ok(dataset.photos.every((photo) => /HABS survey photograph/.test(photo.rights)));
    assert.throws(() => validateDataset({ ...dataset, claims: [...dataset.claims, dataset.claims[0]] }), /repeated claim/);
    assert.throws(() => validateDataset({ ...dataset, claims: [{ ...dataset.claims[0], expected: 'true' }] }), /expected verdict/);
    assert.throws(() => validateDataset({ ...dataset, claims: [{ ...dataset.claims[0], expectedSource: 'A-99' }] }), /expected source/);
  });

  it('runs every claim through the app route, once per run and effort, and scores it', async () => {
    const { dataset, photoBytes } = miniDataset();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-eval-ledger-'));
    tempDirs.push(dir);
    const ledger = new BudgetLedger({ file: path.join(dir, 'budget.json'), limits: { totalUsd: 1, perRequestUsd: 0.05, maxRequests: 8 } });
    const generations = [];
    const sender = (effort) => createMetaSender({
      apiKey: 'fixture-key', ledger, reasoningEffort: effort,
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('/responses/input_tokens')) return reply({ input_tokens: 1500 });
        generations.push(body);
        const context = JSON.parse(body.input[0].content[0].text);
        const first = context.photos[0].sourceId;
        // Claim a: supports with a crop; claim b: the second run conflicts, so runs disagree.
        if (context.note.includes('window')) return reply(generated({ findings: [{ part: 'the room had a window', verdict: 'supports', sourceId: first, crop: [0.1, 0.1, 0.5, 0.5], observation: 'A window is visible.' }], uncertainty: 'The view is not visible.' }));
        const verdict = generations.filter((item) => JSON.parse(item.input[0].content[0].text).note === context.note).length === 2 ? 'conflicts' : 'not_visible';
        return reply(generated({ findings: [{ part: 'the chair was red', verdict, sourceId: verdict === 'conflicts' ? first : null, crop: verdict === 'conflicts' ? [0, 0, 1, 1] : null, observation: 'No color is visible.' }], uncertainty: 'Color is not visible.' }));
      },
    });
    const prepared = [];
    const prepareModelImage = async ({ box }) => {
      prepared.push(box);
      return JPEG;
    };
    const seen = [];
    const results = await runEvaluation({
      dataset, photoBytes, senders: { low: sender('low'), medium: sender('medium') }, efforts: ['low', 'medium'], runs: 2, concurrency: 2,
      prepareModelImage, mediaVerifierFactory: acceptingTestMediaVerifier, onResult: (result) => seen.push(result.claimId),
    });
    assert.equal(results.length, 8);
    assert.equal(seen.length, 8);
    assert.equal(generations.length, 8);
    assert.deepEqual(generations.map((body) => body.reasoning.effort).sort(), ['low', 'low', 'low', 'low', 'medium', 'medium', 'medium', 'medium']);
    assert.ok(generations.every((body) => body.store === false && body.text.format.name === 'EvidenceReview'));
    assert.ok(prepared.every((box) => box.join() === '0,0,1,1'));
    const a = results.filter((item) => item.claimId === 'a');
    assert.ok(a.every((item) => item.verdict === 'supports' && item.findings[0].photo === 'P-1' && item.call.responseId.startsWith('resp_')));
    const summary = scoreResults(dataset, results);
    assert.deepEqual(Object.keys(summary).sort(), ['low', 'medium']);
    for (const effort of ['low', 'medium']) {
      assert.equal(summary[effort].checks, 4);
      assert.equal(summary[effort].sourceAccuracy, null); // single-photo claims never score source choice
      assert.equal(summary[effort].denominators.sourceAccuracy, 0);
      assert.equal(summary[effort].denominators.agreement, 4);
      assert.equal(summary[effort].unanimousClaims + 0, summary[effort].unanimousClaims);
      assert.equal(summary[effort].usage.reported, 4);
    }
    const all = [...summary.low.failures, ...summary.medium.failures];
    assert.ok(all.every((item) => item.claimId === 'b' && item.verdict === 'conflicts'));
    assert.equal((await ledger.read()).entries.length, 8);
    assert.ok((await ledger.read()).entries.every((entry) => entry.state === 'settled'));
  });

  it('refuses a photo whose bytes do not match the pinned hash', async () => {
    const { loadPhotos } = await import('../evaluation/evidence/evaluate.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-eval-photos-'));
    tempDirs.push(dir);
    const { dataset } = miniDataset();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'p1.png'), png(40, 30, 9));
    await writeFile(path.join(dir, 'p2.png'), png(40, 30, 2));
    await assert.rejects(loadPhotos(dataset, dir), /does not match its pinned SHA-256/);
    await writeFile(path.join(dir, 'p1.png'), png(40, 30, 1));
    assert.equal((await loadPhotos(dataset, dir)).size, 2);
    assert.ok((await readFile(path.join(dir, 'p2.png'))).length > 0);
  });

  it('keeps the app default effort and rejects unknown efforts', async () => {
    const bodies = [];
    const ledger = { reserve: async () => 'r', settle: async () => {} };
    const fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return url.endsWith('/input_tokens') ? reply({ input_tokens: 10 }) : reply(generated({ findings: [], uncertainty: 'x' }));
    };
    const send = createMetaSender({ apiKey: 'k', ledger, fetch });
    await send({ body: { model: 'muse-spark-1.3', input: [], instructions: '', text: {} }, admit: async (start) => ({ value: start() }) });
    assert.equal(bodies[1].reasoning.effort, 'low');
    assert.throws(() => createMetaSender({ apiKey: 'k', ledger, fetch, reasoningEffort: 'high' }), /not supported/);
  });
  it('excludes checks the ledger refused from every share and stops the queue', async () => {
    const { dataset, photoBytes } = miniDataset();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-eval-ledger-'));
    tempDirs.push(dir);
    const ledger = new BudgetLedger({ file: path.join(dir, 'budget.json'), limits: { totalUsd: 1, perRequestUsd: 0.05, maxRequests: 3 } });
    let generations = 0;
    const send = createMetaSender({
      apiKey: 'fixture-key', ledger,
      fetch: async (url, init) => {
        if (url.endsWith('/responses/input_tokens')) return reply({ input_tokens: 1500 });
        generations += 1;
        const context = JSON.parse(JSON.parse(init.body).input[0].content[0].text);
        return reply(generated({ findings: [{ part: 'the room had a window', verdict: 'supports', sourceId: context.photos[0].sourceId, crop: [0.1, 0.1, 0.5, 0.5], observation: 'A window is visible.' }], uncertainty: 'x' }));
      },
    });
    const results = await runEvaluation({
      dataset, photoBytes, senders: { low: send }, efforts: ['low'], runs: 3, concurrency: 1,
      prepareModelImage: async () => JPEG, mediaVerifierFactory: acceptingTestMediaVerifier,
    });
    assert.equal(generations, 3);
    assert.equal(results.length, 4, 'the first refusal stops every later claim and run');
    const refused = results.at(-1);
    assert.equal(refused.failure, 'notSent');
    assert.equal(refused.claimId, 'b');
    const low = scoreResults(dataset, results).low;
    assert.equal(low.checks, 3);
    assert.equal(low.notSent, 1);
    assert.equal(low.denominators.agreement, 3);
    assert.equal(low.agreement, 1);
    assert.ok(low.failures.every((item) => item.failure !== 'notSent'));
  });

  it('classifies failures and refuses an existing or in-app-data ledger', async () => {
    const { EVIDENCE_MESSAGES } = await import('../evidence-reviews.mjs');
    const { checkLedgerPath, failureClass } = await import('../evaluation/evidence/evaluate.mjs');
    const row = (error, httpStatus = 200) => ({ status: 'failed', httpStatus, error });
    assert.equal(failureClass({ status: 'answered', httpStatus: 200 }), null);
    assert.equal(failureClass(row(EVIDENCE_MESSAGES.budget)), 'notSent');
    assert.equal(failureClass(row(EVIDENCE_MESSAGES.provider)), 'provider');
    assert.equal(failureClass(row(EVIDENCE_MESSAGES.invalid)), 'invalidAnswer');
    assert.equal(failureClass(row(EVIDENCE_MESSAGES.budget, 500)), 'other');
    assert.equal(failureClass(row('unknown')), 'other');
    const nulls = { model: null, responseId: null, usage: null, mode: null, latencyMs: null };
    const withCall = (error, call) => ({ ...row(error), call });
    const evidence = { responseId: 'resp_x', model: 'muse-spark-1.3', usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0.001 }, latencyMs: 900 };
    assert.equal(failureClass(withCall(EVIDENCE_MESSAGES.restricted, evidence)), 'other');
    assert.equal(failureClass(withCall(EVIDENCE_MESSAGES.restricted, nulls)), 'notSent');
    assert.equal(failureClass(withCall(EVIDENCE_MESSAGES.budget, nulls)), 'notSent');
    assert.equal(failureClass(withCall(EVIDENCE_MESSAGES.interrupted, { ...nulls, latencyMs: 900 })), 'other');
    assert.equal(failureClass(withCall(EVIDENCE_MESSAGES.invalid, evidence)), 'invalidAnswer');
    assert.equal(failureClass(withCall(EVIDENCE_MESSAGES.provider, { ...nulls, latencyMs: 60000 })), 'provider');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-eval-ledger-'));
    tempDirs.push(dir);
    const fresh = path.join(dir, 'fresh.json');
    assert.equal(await checkLedgerPath(fresh), fresh);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fresh, '{}');
    await assert.rejects(checkLedgerPath(fresh), /already exists/);
    await assert.rejects(checkLedgerPath(new URL('../data/ledger.json', import.meta.url).pathname), /outside app\/data/);
  });
  it('scores a split answer strictly as primary and by presence as secondary', () => {
    const { dataset } = miniDataset();
    const row = (run, verdict, parts) => ({ claimId: 'a', effort: 'low', run, status: 'answered', httpStatus: 200, verdict, findings: parts.map((part) => ({ verdict: part, photo: 'P-1' })), call: null });
    const low = scoreResults(dataset, [row(1, 'supports', ['supports']), row(2, 'mixed', ['supports', 'not_visible']), row(3, 'not_visible', ['not_visible'])]).low;
    assert.equal(low.agreement, 0.3333);
    assert.equal(low.mixedRate, 0.3333);
    assert.equal(low.denominators.mixedRate, 3);
    assert.equal(low.partRuleAgreement, 0.6667);
    const f = (...verdicts) => verdicts.map((verdict) => ({ verdict }));
    assert.equal(partRuleAgrees('supports', f('supports', 'supports', 'not_visible')), true); // s01 medium
    assert.equal(partRuleAgrees('not_visible', f('supports', 'not_visible')), true); // n02
    assert.equal(partRuleAgrees('supports', f('not_visible')), false); // s16 low
    assert.equal(partRuleAgrees('supports', f('supports', 'conflicts')), false);
    assert.equal(partRuleAgrees('conflicts', f('supports', 'conflicts')), true);
    assert.equal(partRuleAgrees('not_visible', f('not_visible', 'conflicts')), false);
  });
});
