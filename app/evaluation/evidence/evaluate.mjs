// Evaluation of the owner evidence review against expected verdicts written by
// the development team. Every check goes through the real app path: an
// in-process app server with its own data folder, one saved memory per claim
// (note and photos), and POST /api/drafts/<id>/evidence-reviews with consent.
// Live use needs REHERE_EVAL_LIVE=1 and MODEL_API_KEY; tests pass a fake model.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessStore, freshCredentials } from '../../access.mjs';
import { EVIDENCE_MESSAGES, VERDICTS } from '../../evidence-reviews.mjs';
import { BudgetLedger, REASONING_EFFORTS, createMetaSender } from '../../meta-model.mjs';
import { createAppServer } from '../../server.mjs';

export const DATASET = fileURLToPath(new URL('./claims.json', import.meta.url));
const OUTCOMES = [...VERDICTS, 'mixed', 'failed'];
const APP_DATA = fileURLToPath(new URL('../../data', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The claim-level verdict of one answer, by the dataset's stated rule.
export function claimVerdict(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return 'failed';
  const verdicts = findings.map((item) => item.verdict);
  if (verdicts.includes('conflicts')) return 'conflicts';
  if (verdicts.every((item) => item === 'supports')) return 'supports';
  if (verdicts.every((item) => item === 'not_visible')) return 'not_visible';
  return 'mixed';
}

// Why a check did not answer. notSent: refused before any model request (not a
// model result, so it stays out of every agreement figure); provider and
// invalidAnswer: the model side failed after a send, so they count as misses.
const FAILURE_CLASSES = {
  notSent: ['budget', 'tooLarge', 'image', 'restricted', 'interrupted', 'busy', 'changed'],
  provider: ['provider', 'timeout'],
  invalidAnswer: ['invalid', 'incomplete', 'refused'],
};
export function failureClass({ status, httpStatus, error, call }) {
  if (status === 'answered') return null;
  // An error string alone never proves nothing was sent: provider call evidence means a paid attempt.
  const sent = Boolean(call?.responseId || call?.model || call?.usage || call?.latencyMs != null);
  if (httpStatus >= 200 && httpStatus < 300) {
    for (const [name, keys] of Object.entries(FAILURE_CLASSES)) {
      if (name === 'notSent' && sent) continue;
      if (keys.some((key) => EVIDENCE_MESSAGES[key] === error)) return name;
    }
  }
  return 'other';
}

// A reused ledger would count old entries against this run; app data is never a ledger home.
export async function checkLedgerPath(file) {
  const resolved = path.resolve(file);
  const inside = path.relative(APP_DATA, resolved);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) throw new Error('The ledger must be outside app/data.');
  const exists = await access(resolved).then(() => true, () => false);
  if (exists) throw new Error('The ledger file already exists; use a fresh path so earlier entries are not counted.');
  return resolved;
}

// Part rule, reported beside the strict whole-claim rule (added after an 8-check
// pilot, before the full run): supports needs a supports part and no conflicts
// part; conflicts needs a conflicts part; not_visible needs a not_visible part
// and no conflicts part.
export function partRuleAgrees(expected, findings) {
  const has = (verdict) => Array.isArray(findings) && findings.some((item) => item.verdict === verdict);
  if (expected === 'supports') return has('supports') && !has('conflicts');
  if (expected === 'conflicts') return has('conflicts');
  return has('not_visible') && !has('conflicts');
}

export function validateDataset(data) {
  const fail = (message) => { throw new Error(`Evaluation dataset: ${message}`); };
  if (data?.schemaVersion !== 1 || !Array.isArray(data.photos) || !Array.isArray(data.claims) || typeof data.label !== 'string') fail('unexpected shape');
  const photos = new Map(data.photos.map((photo) => [photo.id, photo]));
  if (photos.size !== data.photos.length || !data.photos.every((photo) => /^[0-9a-f]{64}$/.test(photo.sha256) && typeof photo.file === 'string' && typeof photo.credit === 'string' && photo.credit)) fail('photo entries');
  const ids = new Set();
  for (const claim of data.claims) {
    if (ids.has(claim.id)) fail(`repeated claim ${claim.id}`);
    ids.add(claim.id);
    if (!Array.isArray(claim.photos) || claim.photos.length < 1 || claim.photos.length > 4 || !claim.photos.every((id) => photos.has(id))) fail(`photos of ${claim.id}`);
    if (!VERDICTS.includes(claim.expected)) fail(`expected verdict of ${claim.id}`);
    if (claim.expectedSource !== null && !claim.photos.includes(claim.expectedSource)) fail(`expected source of ${claim.id}`);
    if (typeof claim.note !== 'string' || !claim.note.trim() || typeof claim.rationale !== 'string' || !claim.rationale.trim()) fail(`text of ${claim.id}`);
  }
  return data;
}

export async function loadDataset(file = DATASET) {
  return validateDataset(JSON.parse(await readFile(file, 'utf8')));
}

// Reads each photo once and checks it against the dataset's pinned hash.
export async function loadPhotos(dataset, photosDir) {
  const bytes = new Map();
  for (const photo of dataset.photos) {
    const data = await readFile(path.join(photosDir, photo.file));
    if (sha256(data) !== photo.sha256) throw new Error(`Photo ${photo.id} does not match its pinned SHA-256.`);
    bytes.set(photo.id, data);
  }
  return bytes;
}

const noDates = { capturedOn: null, fileCreatedAt: null, fileModifiedAt: null, estimatedPeriod: '' };
function memoryForm(dataset, claim, photoBytes) {
  const form = new FormData();
  form.append('text', claim.note);
  const metadata = { photos: [], text: {
    provider: 'Evaluation dataset', attributedCreator: 'Development team',
    origin: { kind: 'own', reference: 'Expected-verdict evaluation claim written by the development team; a hypothesis, not a memory or witness account.' },
    permissions: { place: true, model: true, share: false }, dates: noDates,
  } };
  for (const id of claim.photos) {
    const photo = dataset.photos.find((item) => item.id === id);
    form.append('photos', new Blob([photoBytes.get(id)], { type: 'image/jpeg' }), photo.file);
    metadata.photos.push({
      provider: photo.credit,
      origin: { kind: 'public', reference: `${photo.caption}. ${photo.rights}` },
      permissions: { place: true, model: true, share: false }, dates: { ...noDates, estimatedPeriod: 'July 1982 (archival caption)' },
    });
  }
  form.append('metadata', JSON.stringify(metadata));
  return form;
}

// One in-process app with its own data folder and owner session.
async function startWorker({ model, prepareModelImage, mediaVerifier }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rehere-evidence-eval-'));
  const accessStore = new AccessStore({ dataDir });
  const credentials = freshCredentials();
  await accessStore.bootstrap({ requestId: randomUUID(), displayName: 'Evaluation owner', ...credentials });
  const options = { dataDir, accessStore, evidenceModel: model, ...(prepareModelImage && { prepareModelImage }), ...(mediaVerifier && { mediaVerifier }) };
  const server = createAppServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ accessKey: credentials.accessKey }) });
  if (login.status !== 200) throw new Error(`Evaluation owner sign-in failed: HTTP ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (route, init = {}) => fetch(`${base}${route}`, { ...init, headers: { origin: base, cookie, ...init.headers } });
  return {
    request,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

// Runs every claim `runs` times for each reasoning effort. `senders` maps an
// effort to a model function. Claims are spread over `concurrency` workers;
// one claim's runs stay on one worker, one at a time. Nothing is retried.
export async function runEvaluation({ dataset, photoBytes, senders, efforts = ['low'], runs = 3, concurrency = 2, only = null, prepareModelImage, mediaVerifierFactory, onResult = () => {} }) {
  // Set on the first budget refusal: no further claim or run is started.
  let stopped = false;
  const claims = dataset.claims.filter((claim) => !only || only.includes(claim.id));
  const queue = [...claims];
  const results = [];
  const worker = async () => {
    let effort = efforts[0];
    const app = await startWorker({ model: (args) => senders[effort](args), prepareModelImage, mediaVerifier: mediaVerifierFactory?.() });
    try {
      for (let claim = stopped ? null : queue.shift(); claim; claim = stopped ? null : queue.shift()) {
        const saved = await app.request('/api/drafts', { method: 'POST', body: memoryForm(dataset, claim, photoBytes) });
        const draft = await saved.json();
        if (saved.status !== 201) throw new Error(`Saving the memory for ${claim.id} failed: HTTP ${saved.status} ${draft?.error ?? ''}`);
        const sourceIds = draft.photos.map((photo) => photo.sourceId);
        const photoOf = new Map(sourceIds.map((id, index) => [id, claim.photos[index]]));
        for (effort of efforts) {
          for (let run = 1; run <= runs && !stopped; run += 1) {
            const started = Date.now();
            const response = await app.request(`/api/drafts/${draft.id}/evidence-reviews`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), consent: true, sourceIds }),
            });
            const answer = await response.json().catch(() => null);
            const review = answer?.review ?? null;
            const findings = review?.result?.findings ?? null;
            const result = {
              claimId: claim.id, effort, run, httpStatus: response.status, roundTripMs: Date.now() - started,
              status: review?.status ?? 'failed', error: review?.error ?? answer?.error ?? null,
              verdict: review?.status === 'answered' ? claimVerdict(findings) : 'failed',
              findings: findings && findings.map((item) => ({ ...item, photo: item.sourceId ? photoOf.get(item.sourceId) ?? null : null })),
              uncertainty: review?.result?.uncertainty ?? null, call: review?.call ?? null,
            };
            result.failure = failureClass(result);
            if (result.failure === 'notSent' && result.error === EVIDENCE_MESSAGES.budget) stopped = true;
            results.push(result);
            await onResult(result);
          }
        }
      }
    } finally {
      await app.close();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, worker));
  return results;
}

const share = (count, total) => (total ? Number((count / total).toFixed(4)) : null);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

// Agreement with the team-written expected verdicts, run-to-run consistency,
// source choice, cost and failures per effort. Checks refused before any
// model request (notSent) are counted apart and never enter a share; provider
// and invalid-answer failures stay in as misses. Every share carries its
// denominator under `denominators`.
export function scoreResults(dataset, results) {
  const efforts = [...new Set(results.map((item) => item.effort))];
  const byId = new Map(dataset.claims.map((claim) => [claim.id, claim]));
  const summary = {};
  for (const effort of efforts) {
    const all = results.filter((item) => item.effort === effort);
    const rows = all.filter((item) => item.failure !== 'notSent');
    const confusion = Object.fromEntries(VERDICTS.map((expected) => [expected, Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]))]));
    let correct = 0;
    let partRule = 0;
    let located = 0;
    let rightSource = 0;
    const failures = [];
    for (const row of rows) {
      const claim = byId.get(row.claimId);
      confusion[claim.expected][row.verdict] += 1;
      if (row.verdict === claim.expected) correct += 1;
      if (partRuleAgrees(claim.expected, row.findings)) partRule += 1;
      if (row.verdict !== claim.expected) failures.push({ claimId: row.claimId, effort, run: row.run, expected: claim.expected, verdict: row.verdict, failure: row.failure, error: row.error, findings: row.findings, uncertainty: row.uncertainty, responseId: row.call?.responseId ?? null });
      // Source choice is only informative where a second photo could be cited.
      if (claim.photos.length > 1 && claim.expectedSource && row.verdict === claim.expected && ['supports', 'conflicts'].includes(row.verdict)) {
        located += 1;
        const cited = row.findings.filter((item) => item.verdict !== 'not_visible').map((item) => item.photo);
        if (cited.length && cited.every((photo) => photo === claim.expectedSource)) rightSource += 1;
      }
    }
    const claimIds = [...new Set(rows.map((item) => item.claimId))];
    let unanimous = 0;
    let majorityCorrect = 0;
    let pairs = 0;
    let agreeingPairs = 0;
    for (const id of claimIds) {
      const verdicts = rows.filter((item) => item.claimId === id).map((item) => item.verdict);
      if (new Set(verdicts).size === 1) unanimous += 1;
      const counts = verdicts.reduce((map, verdict) => map.set(verdict, (map.get(verdict) ?? 0) + 1), new Map());
      const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topCount * 2 > verdicts.length && top === byId.get(id).expected) majorityCorrect += 1;
      for (let i = 0; i < verdicts.length; i += 1) for (let j = i + 1; j < verdicts.length; j += 1) {
        pairs += 1;
        if (verdicts[i] === verdicts[j]) agreeingPairs += 1;
      }
    }
    const rowsByExpected = Object.fromEntries(VERDICTS.map((expected) => [expected, Object.values(confusion[expected]).reduce((sum, n) => sum + n, 0)]));
    const usage = rows.map((item) => item.call?.usage).filter(Boolean);
    const latency = rows.map((item) => item.call?.latencyMs).filter(Number.isInteger);
    const failureCounts = { notSent: 0, provider: 0, invalidAnswer: 0, other: 0 };
    for (const row of all) if (row.failure) failureCounts[row.failure] += 1;
    summary[effort] = {
      checks: rows.length, notSent: failureCounts.notSent, failureCounts,
      answered: rows.filter((item) => item.status === 'answered').length, failed: rows.filter((item) => item.verdict === 'failed').length,
      // Primary: strict whole-claim match (any disagreeing part is a miss). Secondary: the expected verdict appears among the parts. Mixed rate: answers whose parts disagree.
      agreement: share(correct, rows.length), partRuleAgreement: share(partRule, rows.length), mixedRate: share(rows.filter((item) => item.verdict === 'mixed').length, rows.length),
      agreementByExpected: Object.fromEntries(VERDICTS.map((expected) => [expected, share(confusion[expected][expected], rowsByExpected[expected])])),
      majorityAgreement: share(majorityCorrect, claimIds.length), unanimousClaims: share(unanimous, claimIds.length), pairwiseConsistency: share(agreeingPairs, pairs),
      sourceAccuracy: share(rightSource, located), splitAnswers: share(rows.filter((item) => (item.findings?.length ?? 0) > 1).length, rows.length),
      denominators: {
        agreement: rows.length, partRuleAgreement: rows.length, mixedRate: rows.length, agreementByExpected: rowsByExpected, majorityAgreement: claimIds.length, unanimousClaims: claimIds.length,
        pairwiseConsistency: pairs, sourceAccuracy: located, splitAnswers: rows.length,
        sourceAccuracyScope: 'Correct supports/conflicts answers on claims with more than one photo and an expected photo.',
      },
      confusion,
      usage: {
        reported: usage.length, inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
        estimatedUsd: Number(usage.reduce((sum, item) => sum + item.estimatedUsd, 0).toFixed(6)),
      },
      latencyMs: { median: median(latency), max: latency.length ? Math.max(...latency) : null },
      failures,
    };
  }
  return summary;
}

function parseArgs(argv) {
  const options = { runs: 3, efforts: ['low'], concurrency: 3, maxUsd: 8, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--photos') options.photos = value;
    else if (key === '--out') options.out = value;
    else if (key === '--ledger') options.ledger = value;
    else if (key === '--runs') options.runs = Number(value);
    else if (key === '--efforts') options.efforts = value.split(',');
    else if (key === '--concurrency') options.concurrency = Number(value);
    else if (key === '--max-usd') options.maxUsd = Number(value);
    else if (key === '--only') options.only = value.split(',');
    else throw new Error(`Unknown option ${key}`);
    i += 1;
  }
  if (!options.photos || !options.out || !options.ledger) throw new Error('Usage: evaluate.mjs --photos <dir> --out <results.json> --ledger <budget.json> [--runs 3] [--efforts low,medium] [--concurrency 3] [--max-usd 8] [--only id,id]');
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5 || !options.efforts.every((effort) => REASONING_EFFORTS.includes(effort))
    || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4 || !(options.maxUsd > 0 && options.maxUsd <= 10)) throw new Error('An option is out of range.');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.env.REHERE_EVAL_LIVE !== '1' || !process.env.MODEL_API_KEY) throw new Error('Live evaluation needs REHERE_EVAL_LIVE=1 and MODEL_API_KEY in this process. Nothing was sent.');
  const ledgerFile = await checkLedgerPath(options.ledger);
  const dataset = await loadDataset();
  const photoBytes = await loadPhotos(dataset, options.photos);
  const claims = dataset.claims.filter((claim) => !options.only || options.only.includes(claim.id));
  const maxRequests = claims.length * options.runs * options.efforts.length;
  // One ledger for every worker; a sent request keeps its reservation unless usage settles it.
  const ledger = new BudgetLedger({ file: ledgerFile, limits: { totalUsd: options.maxUsd, perRequestUsd: 0.05, maxRequests } });
  const senders = Object.fromEntries(options.efforts.map((effort) => [effort, createMetaSender({ apiKey: process.env.MODEL_API_KEY, ledger, reasoningEffort: effort })]));
  const progress = `${options.out}.progress.jsonl`;
  const started = new Date().toISOString();
  const results = await runEvaluation({
    dataset, photoBytes, senders, efforts: options.efforts, runs: options.runs, concurrency: options.concurrency, only: options.only,
    onResult: async (result) => {
      await appendFile(progress, `${JSON.stringify(result)}\n`);
      console.log(`${result.claimId} ${result.effort} #${result.run}: ${result.verdict}${result.call?.responseId ? ` ${result.call.responseId}` : ''}`);
    },
  });
  const order = new Map(dataset.claims.map((claim, index) => [claim.id, index]));
  results.sort((a, b) => order.get(a.claimId) - order.get(b.claimId) || a.effort.localeCompare(b.effort) || a.run - b.run);
  const totals = await ledger.totals();
  await writeFile(options.out, `${JSON.stringify({
    schemaVersion: 1, label: dataset.label, startedAt: started, finishedAt: new Date().toISOString(),
    model: results.find((item) => item.call?.model)?.call.model ?? null, runs: options.runs, efforts: options.efforts,
    ledger: { requests: totals.requests, chargedUsd: Number(totals.chargedUsd.toFixed(6)) },
    summary: scoreResults(dataset, results), results,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ requests: totals.requests, chargedUsd: totals.chargedUsd }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
