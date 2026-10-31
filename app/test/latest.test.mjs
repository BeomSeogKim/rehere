import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latestOnly } from '../public/latest.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}

// Mirrors the saved-memory view: render only what the current request returns.
function view() {
  const requests = latestOnly();
  const screen = { shown: null };
  const open = async (response) => {
    const { current, value } = await requests.run(() => response.promise);
    if (current) screen.shown = value;
  };
  return { requests, screen, open };
}

describe('latest request guard', () => {
  for (const order of ['B then A', 'A then B']) {
    it(`shows the memory opened last when responses arrive ${order}`, async () => {
      const { screen, open } = view();
      const [a, b] = [deferred(), deferred()];
      const openedA = open(a);
      const openedB = open(b);
      const first = order === 'B then A' ? [b, 'B'] : [a, 'A'];
      const second = order === 'B then A' ? [a, 'A'] : [b, 'B'];
      first[0].resolve(first[1]);
      await (first[1] === 'B' ? openedB : openedA);
      second[0].resolve(second[1]);
      await Promise.all([openedA, openedB]);
      assert.equal(screen.shown, 'B');
    });
  }

  it('drops failed and successful results after navigating away', async () => {
    const { requests, screen, open } = view();
    const failed = deferred();
    const pendingFailure = open(failed);
    requests.invalidate();
    failed.resolve(null);
    await pendingFailure;
    assert.equal(screen.shown, null);

    const loaded = deferred();
    const pendingLoad = open(loaded);
    requests.invalidate();
    loaded.resolve('A');
    await pendingLoad;
    assert.equal(screen.shown, null);
  });
});
