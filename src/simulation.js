/* Deterministic scripted riders shared by calibration and the map workshop. */
(function (CF) {
'use strict';
const { createRun, start, step, nextLow, surface, elapsed, score } = CF.engine;
function lcg(seed) {
  let state = seed >>> 0 || 1;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function gauss(random) {
  let u = 0;
  let v = 0;
  while (!u) u = random();
  while (!v) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Flip when crossing the next low of the current orientation, shifted by `seconds`. */
function offsetPolicy(seconds) {
  return (run, memory) => {
    if (!memory.target || memory.sign !== run.sign) {
      memory.target = nextLow(run, run.x - 1);
      memory.sign = run.sign;
    }
    if (!memory.target) return false;
    if (run.x >= memory.target.x + seconds * Math.max(250, Math.abs(run.vx))) {
      memory.target = null;
      return true;
    }
    return false;
  };
}

/**
 * Boost policy: hold BOOST when it pays most. Thrust buys the most time where the rider is slow, so
 * a smart player boosts below `slow` speed on the ground or in flight.
 * `sigma` blurs the speed read per decision;
 * `always` holds whenever there is cash.
 */
function booster({ slow = CF.engine.RULES.boostPeakMax * 0.95, sigma = 0, always = false } = {}, seed = 1) {
  const random = lcg(seed ^ 0x5bd1e995);
  return (run, memory) => {
    if (run.cash <= 0) return false;
    if (always) return true;
    if (!memory.next || run.tick >= memory.next) {
      memory.next = run.tick + 12;
      memory.error = sigma * gauss(random) * 300;
    }
    // Ground and air both provide thrust; avoid spending fuel at the speed ceiling.
    return Math.hypot(run.vx, run.vy) < slow + memory.error;
  };
}

const boostPolicies = {
  none: () => false,
  always: booster({ always: true }),
  smart: booster()
};

/**
 * A human-like player: aims at each low with Gaussian timing error around a late bias,
 * sometimes misses a low and only reacts once already climbing.
 */
function human({ sigma, bias, miss }, seed) {
  const random = lcg(seed);
  return (run, memory) => {
    if (memory.recoverAt && run.x >= memory.recoverAt) {
      memory.recoverAt = 0;
      memory.target = null;
      return true;
    }
    if (!memory.target || memory.sign !== run.sign) {
      const low = nextLow(run, run.x - 1);
      memory.sign = run.sign;
      memory.target = low && { x: low.x, offset: bias + sigma * gauss(random), skip: random() < miss };
    }
    if (!memory.target) return false;
    if (run.x < memory.target.x + memory.target.offset * Math.max(250, Math.abs(run.vx))) return false;
    const skipped = memory.target.skip;
    memory.target = null;
    if (!skipped) return true;
    memory.sign = 0;
    memory.target = { x: Infinity, offset: 0 };
    memory.recoverAt = run.x + 260;
    return false;
  };
}

const PROFILES = {
  skilled: { sigma: 0.06, bias: 0.04, miss: 0, boost: { sigma: 0.3 } },
  casual: { sigma: 0.12, bias: 0.09, miss: 0.03, boost: { sigma: 0.6 } },
  sloppy: { sigma: 0.18, bias: 0.15, miss: 0.1, boost: { always: true } }
};

const policies = {
  never: () => false,
  mash: run => run.tick % 30 === 0,
  random: (run, memory) => {
    memory.random = memory.random || lcg(12345);
    return memory.random() < 1 / 120;
  },
  onTime: offsetPolicy(0),
  reactive: run => run.grounded && surface(run, run.x).slope > 0.08,
  late: offsetPolicy(0.2),
  early: offsetPolicy(-0.12)
};

/**
 * Plays one run. Humans cannot tap every tick, so flips are at least 0.1 s apart.
 * `boost` decides each tick whether BOOST is held (default: smart).
 */
function* playSteps(course, policy, { rules, limitSeconds = 240, boost = boostPolicies.smart } = {}) {
  const run = createRun(course, rules);
  start(run);
  const memory = {};
  const boostMemory = {};
  const limit = limitSeconds / run.rules.dt;
  let lastFlip = -100;
  const input = { flip: false, boost: false };
  while (run.status === 'running' && run.tick < limit) {
    input.flip = policy(run, memory) && run.tick - lastFlip >= 12;
    if (input.flip) lastFlip = run.tick;
    input.boost = Boolean(boost(run, boostMemory));
    step(run, input);
    run.events.length = 0;
    if (run.tick % 480 === 0) yield;
  }
  return { finished: run.status === 'finished', time: run.status === 'finished' ? score(run) : Infinity, run };
}

function summarize(result) {
  const { run } = result;
  const stats = run.stats;
  return {
    time: result.finished ? +result.time.toFixed(2) : 'DNF',
    flips: stats.flips,
    perfect: stats.perfect,
    good: stats.good,
    clean: stats.clean,
    hard: stats.hard,
    kmh: Math.round(stats.maxSpeed * 0.072),
    coins: `${stats.coins}/${run.items.length}`,
    overflow: stats.overflow,
    boost: +stats.boostTime.toFixed(2),
    air: +(stats.airTime / Math.max(1e-6, elapsed(run))).toFixed(2),
    streak: stats.bestStreak
  };
}

function distribution(course, profile, seeds = 40) {
  const times = [];
  for (let seed = 1; seed <= seeds; seed++) {
    times.push(play(course, human(profile, seed * 7919), { boost: booster(profile.boost, seed * 7919) }).time);
  }
  return times.sort((a, b) => a - b);
}

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
const roundUp = (value, step) => Math.ceil(value / step - 1e-9) * step;

/** Medal times from simulated players: gold needs a good skilled run, silver a typical casual run. */
function suggestMedals(course) {
  const skilled = distribution(course, PROFILES.skilled);
  const casual = distribution(course, PROFILES.casual);
  const sloppy = distribution(course, PROFILES.sloppy);
  const gold = +roundUp(percentile(skilled, 0.3), 0.1).toFixed(1);
  const silver = Math.max(roundUp(gold + 0.5, 0.5), roundUp(percentile(casual, 0.5), 0.5));
  const bronze = Math.max(silver + 2, roundUp(percentile(sloppy, 0.9), 1));
  return [gold, silver, bronze];
}


function play(...args) { const steps = playSteps(...args); let result; do { result = steps.next(); } while (!result.done); return result.value; }

CF.simulation = { PROFILES, policies, boostPolicies, booster, human, play, playSteps, summarize, distribution, suggestMedals };
})(globalThis.Chartflip = globalThis.Chartflip || {});
