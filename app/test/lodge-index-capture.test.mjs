import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BudgetLedger } from '../meta-model.mjs';
import { createLiveSegmenter } from '../meta-segmentation.mjs';
import { LODGE_LIMITS, LODGE_NOUNS, nounSlug } from '../lodge-index.mjs';
import { runCapture } from '../lodge-index-capture.mjs';

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehere-lodge-'));
  tempDirs.push(dir);
  return dir;
};

const W = 40;
const H = 30;
const bytes = Buffer.from('not a real photograph, only bytes for the request digest');
const photo = (hbs, file, content = bytes) => ({ hbs, file, bytes: content, sha256: createHash('sha256').update(content).digest('hex'), width: W, height: H });
const record = (id, [x1, y1, x2, y2], c) => `${id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${W};h=${H};c=${c}|><|mask;x=0;y=0;c=${c};data=${y2 - y1 + 1},${x2 - x1 + 1},!abc|>`;

// A Responses event stream with one output line and a completed event.
const stream = (text, { imagesProcessed = 1, id = 'resp_fake' } = {}) => new Response([
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}`,
  `data: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', model: 'sam-3.1', usage: { images_processed: imagesProcessed } } })}`,
  'data: [DONE]', '',
].join('\n'), { status: 200 });

async function setup(fetch) {
  const dir = await tempDir();
  const ledger = new BudgetLedger({ file: path.join(dir, 'ledger.json'), limits: LODGE_LIMITS });
  return { dir, ledger, segmenter: createLiveSegmenter({ apiKey: 'test-key', ledger, fetch }) };
}

describe('lodge index capture', () => {
  it('runs one concept per request, records every attempt first and reports counts including zero matches', async () => {
    const prompts = [];
    const fetch = async (url, init) => {
      const prompt = JSON.parse(init.body).input[0].content[0].text;
      prompts.push(prompt);
      return prompt === 'rug' ? stream('', { id: `resp_${prompts.length}` }) : stream(`<0f>${record(0, [1, 2, 10, 12], '0.91')},${record(1, [20, 5, 30, 25], '0.4')}`, { id: `resp_${prompts.length}` });
    };
    const { dir, segmenter } = await setup(fetch);
    const results = await runCapture({ segmenter, photos: [photo('AZ-135-A-16', 'a16.jpg'), photo('AZ-135-A-19', 'a19.jpg')], dir });
    assert.equal(results.length, 20);
    assert.ok(results.every((item) => item.status === 'returned' && item.digestMatches));
    assert.deepEqual(prompts.slice(0, 10), LODGE_NOUNS, 'one noun per request, in the fixed order');
    const rug = results.find((item) => item.noun === 'rug');
    assert.deepEqual(rug.instances, [], 'a parsed zero-match answer is an observed result, not an error');
    assert.equal(results.find((item) => item.noun === 'chair').instances.length, 2);
    assert.deepEqual(results[0].instances[0], { id: 0, box: [1, 2, 11, 13], confidence: 0.91 });
    for (const item of results) assert.match(item.responseId, /^resp_\d+$/);
    const files = await readdir(dir);
    assert.equal(files.filter((name) => name.startsWith('attempt-')).length, 20);
    assert.ok(files.includes(`attempt-a16-${nounSlug('rocking chair')}.json`));
    assert.equal((await stat(path.join(dir, 'attempt-a16-chair.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'attempt-a16-chair.json'), 'utf8')).status, 'returned');
    const ledger = JSON.parse(await readFile(path.join(dir, 'ledger.json'), 'utf8'));
    assert.equal(ledger.entries.length, 20);
    assert.ok(ledger.entries.every((entry) => entry.state === 'settled'));
  });

  it('stops at the first failed call, never retries and keeps the reservation', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 3 ? new Response('upstream error', { status: 503 }) : stream('');
    };
    const { dir, segmenter } = await setup(fetch);
    const results = await runCapture({ segmenter, photos: [photo('AZ-135-A-16', 'a16.jpg')], dir });
    assert.equal(calls, 3, 'no retry after the failure and nothing after it');
    assert.equal(results.length, 3);
    assert.equal(results[2].status, 'uncertain-or-failed');
    assert.match(results[2].error, /HTTP 503/);
    const ledger = JSON.parse(await readFile(path.join(dir, 'ledger.json'), 'utf8'));
    assert.deepEqual(ledger.entries.map((entry) => entry.state), ['settled', 'settled', 'reserved']);
  });

  it('stops on an invalid response and when a photograph differs from its pinned hash', async () => {
    const bad = await setup(async () => stream('<0f>garbage'));
    const results = await runCapture({ segmenter: bad.segmenter, photos: [photo('AZ-135-A-16', 'a16.jpg')], dir: bad.dir });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'uncertain-or-failed');

    let sent = 0;
    const changed = await setup(async () => { sent += 1; return stream(''); });
    const tampered = { ...photo('AZ-135-A-16', 'a16.jpg'), bytes: Buffer.from('other bytes') };
    const refused = await runCapture({ segmenter: changed.segmenter, photos: [tampered], dir: changed.dir });
    assert.equal(sent, 0);
    assert.match(refused[0].status, /^not sent/);
    assert.deepEqual((await readdir(changed.dir)).filter((name) => name.startsWith('attempt-')), []);
  });

  it('refuses to overwrite an earlier attempt file', async () => {
    const { dir, segmenter } = await setup(async () => stream(''));
    await runCapture({ segmenter, photos: [photo('AZ-135-A-16', 'a16.jpg')], nouns: ['chair'], dir });
    await assert.rejects(() => runCapture({ segmenter, photos: [photo('AZ-135-A-16', 'a16.jpg')], nouns: ['chair'], dir }), /EEXIST/);
  });

  it('keeps the batch inside the grant: 3 photographs x 10 nouns, USD 0.08', () => {
    assert.equal(LODGE_NOUNS.length, 10);
    assert.deepEqual(LODGE_LIMITS, { totalUsd: 0.08, perRequestUsd: 0.0025, maxRequests: 30 });
  });
});
