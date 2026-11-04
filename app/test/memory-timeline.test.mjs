import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeElement } from './fake-dom.mjs';
import { renderMemoryTimeline, timelineMemory } from '../public/memory-timeline.js';

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
});
