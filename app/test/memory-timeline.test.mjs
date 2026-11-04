import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { alternativeTimelineMemory, renderMemoryTimeline, timelineMemory } from '../public/memory-timeline.js';
import { mountCollaboration } from '../public/collaboration.js';

before(() => { globalThis.document = { createElement: (tag) => new FakeElement(tag) }; });

const entry = { version: 2, kind: 'proposal', proposalId: 'p', blocked: false };
const proposal = { id: 'p', status: 'applied', baseVersion: 1, appliedVersion: 2,
  statement: { text: 'Synthetic owner memory.' }, result: { reason: 'A hypothetical turn.' }, mode: 'simulated' };

describe('saved memory timeline', () => {
  it('uses an exact applied proposal receipt instead of text or transform similarity', () => {
    assert.equal(timelineMemory(entry, [proposal]).text, 'Synthetic owner memory.');
    for (const changed of [{ id: 'other' }, { status: 'ready' }, { appliedVersion: 3 }, { baseVersion: 8 }, { redacted: true }, { statement: { text: null } }]) {
      assert.deepEqual(timelineMemory(entry, [{ ...proposal, ...changed }]), { unavailable: true });
    }
    assert.equal(timelineMemory({ version: 2, kind: 'manual', proposalId: 'p' }, [proposal]), null);
    assert.deepEqual(timelineMemory({ ...entry, blocked: true }, [proposal]), { unavailable: true });
  });

  it('shows three distinct confirmed changes with the latest saved version marked', () => {
    const container = new FakeElement('section');
    const history = [{ version: 1, kind: 'initial' }];
    const proposals = [];
    for (let index = 0; index < 3; index += 1) {
      history.push({ ...entry, version: index + 2, proposalId: `p${index}` });
      proposals.push({ ...proposal, id: `p${index}`, baseVersion: index + 1, appliedVersion: index + 2,
        statement: { text: `Synthetic memory ${index + 1}` }, result: { reason: `Hypothetical change ${index + 1}` } });
    }
    let actions = 0;
    renderMemoryTimeline(container, { history, proposals, currentVersion: 4, available: true,
      label: (value) => value.kind, describe: (value) => `Position ${value.version}`,
      actions: () => { actions += 1; return []; } });
    assert.match(container.textContent, /Saved version 4 · 4 saved versions/);
    assert.equal(container.findAll((node) => node.attributes['aria-current'] === 'step').length, 1);
    assert.equal(container.findAll((node) => node.tag === 'li')[0].textContent.startsWith('Version 4 (current)'), true);
    for (let index = 1; index <= 3; index += 1) {
      assert.match(container.textContent, new RegExp(`Synthetic memory ${index}`));
      assert.match(container.textContent, new RegExp(`Hypothetical change ${index}`));
    }
    assert.equal(container.textContent.split('SIMULATED suggestion, not from Meta').length - 1, 3);
    assert.equal(actions, 4);
    assert.doesNotMatch(container.textContent, /contributor|Muse Spark/);
  });

  it('removes all prior words and actions when current history cannot be read', () => {
    const container = new FakeElement('section');
    const options = { history: [entry], proposals: [proposal], currentVersion: 2,
      label: () => 'Change', describe: () => 'Position', actions: () => [] };
    renderMemoryTimeline(container, { ...options, available: true });
    assert.match(container.textContent, /Synthetic owner memory/);
    renderMemoryTimeline(container, { ...options, available: false, actions: () => { throw new Error('No stale action allowed'); } });
    assert.doesNotMatch(container.textContent, /Synthetic owner memory|A hypothetical turn/);
    assert.match(container.textContent, /could not be confirmed/);
  });

  it('shows a child source only with its exact applied parent and child receipt', () => {
    const variant = { id: 'child', blocked: false, revision: { parentVariantId: 'parent', proposalId: 'p' } };
    const applied = { ...proposal, scope: { kind: 'variant', parentVariantId: 'parent' }, appliedVariantId: 'child',
      statement: { text: 'Synthetic contributor words.', sha256: 'a'.repeat(64), ownerReviewed: true,
        source: { kind: 'contribution-text', contributionId: 'source', sourceSha256: 'a'.repeat(64) } } };
    assert.equal(alternativeTimelineMemory(variant, [applied]), applied);
    for (const changed of [{ id: 'other' }, { status: 'ready' }, { appliedVariantId: 'other-child' }, { redacted: true }, { scope: { kind: 'variant', parentVariantId: 'other-parent' } },
      { statement: { ...applied.statement, ownerReviewed: false } }, { statement: { ...applied.statement, sha256: 'b'.repeat(64) } }]) {
      assert.equal(alternativeTimelineMemory(variant, [{ ...applied, ...changed }]), null);
    }
    assert.equal(alternativeTimelineMemory({ ...variant, blocked: true }, [applied]), null);
    assert.equal(alternativeTimelineMemory({ id: 'main', version: 2 }, [applied]), null);
  });
});

describe('saved alternative lineage from current API receipts', () => {
  it('shows three source-bound children, keeps main separate, and never revives redacted words', async () => {
    const realFetch = globalThis.fetch;
    const container = new FakeElement('section');
    const variants = [{ id: 'root', label: 'Manual starting alternative', parentVersion: 2, edit: { version: null, offset: [0, 0, 0], yaw: 0 }, contributionIds: [], blocked: false, eraRevision: 0 }];
    const receipts = new Map();
    for (let index = 0; index < 3; index += 1) {
      const parent = index ? `child-${index}` : 'root', id = `child-${index + 1}`;
      variants.push({ ...variants[0], id, label: `Saved alternative child ${index + 1}`, createdAt: `2026-11-04T00:00:0${index}Z`,
        edit: { version: null, offset: [index * 0.1, 0, 0], yaw: index * 0.1 }, revision: { parentVariantId: parent, proposalId: `p-${index}` } });
      receipts.set(parent, [{ id: `p-${index}`, scope: { kind: 'variant', parentVariantId: parent }, status: 'applied', appliedVariantId: id, mode: 'simulated',
        statement: { text: `Synthetic source words ${index + 1}`, sha256: 'a'.repeat(64), ownerReviewed: true,
          source: { kind: 'contribution-text', contributionId: `c-${index}`, sourceSha256: 'a'.repeat(64) },
          attribution: { kind: 'contribution-text', providerLabel: `Synthetic contributor ${index + 1}` } } }]);
    }
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(url);
      const parent = /\/variants\/([^/]+)\/proposals$/.exec(url)?.[1];
      return { status: 200, ok: true, json: async () => parent ? receipts.get(parent) : { contributions: [], variants, currentVersion: 2, blocked: false } };
    };
    const panel = mountCollaboration(container, { jobUrl: '/job', editor: () => ({ version: 2, offset: [0, 0, 0], yaw: 0, clean: true }), showTransform() {}, setLocked() {} });
    try {
      await panel.refresh();
      assert.match(container.textContent, /separate from main saved version 2/);
      assert.match(container.textContent, /save order does not establish historical time/);
      for (let index = 1; index <= 3; index += 1) {
        assert.match(container.textContent, new RegExp(`Synthetic source words ${index}`));
        assert.match(container.textContent, new RegExp(`Synthetic contributor ${index}`));
      }
      assert.equal(container.textContent.split('SIMULATED answer, not from Meta').length - 1, 3);
      assert.equal(requests.filter((url) => /\/proposals$/.test(url)).length, 3);
      const original = receipts.get('root')[0];
      receipts.set('root', [{ ...original, redacted: true, statement: { text: null } }]);
      await panel.refresh();
      assert.doesNotMatch(container.textContent, /Synthetic source words 1|Synthetic contributor 1/);
      receipts.set('root', [original]);
      await panel.refresh();
      assert.doesNotMatch(container.textContent, /Synthetic source words 1|Synthetic contributor 1/);
      globalThis.fetch = async () => { throw new Error('Synthetic unavailable read'); };
      await panel.refresh();
      assert.doesNotMatch(container.textContent, /Synthetic source words|Synthetic contributor/);
    } finally { panel.dispose(); globalThis.fetch = realFetch; }
  });
});
