/* Chartflip items: coins, placed deterministically along a course.
 * Coins hang at a fixed height ("lift") above the current surface, so they flip with the world.
 * Placement reads only the course shape, so any chart (including future data) gets coins. */
(function (CF) {
  'use strict';

  /** radius: pickup reach; lift: default height of the coin's centre above the surface. */
  const TYPES = {
    coin: { radius: 16, lift: 40 }
  };

  /**
   * The line a rider takes when flipping on every bottom without boosting: per tick, x and height
   * above the surface. Coins follow it, so riding the rhythm well collects them.
   */
  function reference(course) {
    const E = CF.engine;
    const run = E.createRun({ ...course, items: [] });
    E.start(run);
    const xs = [];
    const heights = [];
    const input = { flip: false, boost: false };
    let target = null;
    let sign = 0;
    while (run.status === 'running' && run.tick < 300 / run.rules.dt) {
      if (!target || sign !== run.sign) {
        target = E.nextLow(run, run.x - 1);
        sign = run.sign;
      }
      input.flip = Boolean(target && run.x >= target.x);
      if (input.flip) target = null;
      E.step(run, input);
      run.events.length = 0;
      xs.push(run.x);
      heights.push(run.y - run.rules.radius - E.heightAt(run, run.x));
    }
    const tickAt = x => {
      let low = 0;
      let high = xs.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (xs[middle] < x) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    return { xs, heights, tickAt, heightAt: x => heights[tickAt(x)] };
  }

  /** Stretches of the course between turning-point plateaus. */
  function legsOf(course) {
    const legs = [];
    let start = 0;
    for (const point of course.extremes) {
      if (point.x <= 0 || point.x >= course.finishX) continue;
      legs.push([start, point.x - point.half]);
      start = point.x + point.half;
    }
    legs.push([start, course.finishX]);
    return legs.filter(([x0, x1]) => x1 - x0 > 240).map(([x0, x1], index) => ({ index, x0, x1, len: x1 - x0 }));
  }

  /** A line of coins on the middle of every leg, riding the reference line (one every ~260 units). */
  function generate(course) {
    const items = [];
    if (!CF.engine) return items;
    const line = reference(course);
    for (const leg of legsOf(course)) {
      const count = Math.max(3, Math.min(8, Math.round(leg.len / 260)));
      for (let index = 0; index < count; index++) {
        const x = leg.x0 + leg.len * (0.2 + 0.6 * index / (count - 1));
        items.push({ type: 'coin', x, lift: Math.max(40, line.heightAt(x) + 40) });
      }
    }
    items.sort((a, b) => a.x - b.x);
    items.forEach((item, index) => { item.id = index; });
    return items;
  }

  CF.items = { TYPES, generate, legsOf };
})(globalThis.Chartflip = globalThis.Chartflip || {});
