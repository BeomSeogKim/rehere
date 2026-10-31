// Tracks overlapping requests so only the most recently started one may update
// the screen. invalidate() also drops a pending one, for example on navigation.
export function latestOnly() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async run(task) {
      const mine = ++generation;
      const value = await task();
      return { current: mine === generation, value };
    },
  };
}
