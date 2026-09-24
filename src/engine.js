/* Chartflip engine: deterministic fixed-step sliding with two inputs, FLIP and BOOST.
 * FLIP mirrors the whole chart around the rider's current ground height. Position and
 * world velocity never change, so a flip at a low turns the climb ahead into a descent.
 * Coins fill a cash gauge; holding BOOST burns cash for thrust, so the player decides how
 * much to spend and where. Flips and boost presses/releases are recorded as ticks, so
 * replays and ghosts match exactly. */
(function (CF) {
  'use strict';

  const { clamp } = CF.terrain;

  const RULES = Object.freeze({
    version: 'fictional-1',
    dt: 1 / 120,
    gravity: 1200,
    radius: 14,
    rolling: 0.05,
    drag: 0.0004,
    airDrag: 0.00006,
    crawl: 95,
    launchSpeed: 320,
    maxSpeed: 2000,
    grip: 1.6,
    takeoffSpeed: 200,
    hopSpeed: 12,
    perfectWindow: 0.03,
    goodWindow: 0.12,
    flipBonus: 0.13,
    cleanAngle: 0.28,
    hardAngle: 0.8,
    landingLoss: 0.3,
    cleanBonus: 0.05,
    cleanAir: 0.22,
    finishBrake: 900,
    // coins and the cash boost
    hitRadius: 30,
    hitLift: 22,
    coinCash: 1,
    cashMax: 30,
    burnRate: 10,
    // Boost drives the wheels: thrust only on the ground; held in the air it still burns cash.
    boostThrust: 900,
    boostMax: 2400
  });

  function surface(run, x) {
    const point = run.course.terrain.at(x);
    return { h: run.offset + run.sign * point.h, slope: run.sign * point.slope, curve: run.sign * point.curve };
  }

  /** Surface height only (no allocation). */
  function heightAt(run, x) {
    return run.offset + run.sign * run.course.terrain.height(x);
  }

  function createRun(course, rules = RULES) {
    const items = course.items || [];
    const run = {
      course,
      rules,
      sign: 1,
      offset: 0,
      x: course.startX,
      y: 0,
      prevX: course.startX,
      prevY: 0,
      vx: 0,
      vy: 0,
      speed: 0,
      grounded: true,
      status: 'ready',
      tick: 0,
      finishTime: null,
      airTime: 0,
      crawlTime: 0,
      streak: 0,
      flipTicks: [],
      boostTicks: [],
      held: false,
      judged: new Set(),
      events: [],
      items,
      taken: new Uint8Array(items.length),
      cursor: 0,
      cash: 0,
      boosting: false,
      stats: {
        flips: 0, perfect: 0, good: 0, clean: 0, hard: 0, maxSpeed: 0, airTime: 0, bestStreak: 0,
        coins: 0, overflow: 0, boostTime: 0, boosts: 0
      }
    };
    run.y = heightAt(run, run.x) + rules.radius;
    run.prevY = run.y;
    return run;
  }

  function start(run) {
    if (run.status !== 'ready') return false;
    run.status = 'running';
    run.speed = run.rules.launchSpeed;
    run.vx = run.speed;
    return true;
  }

  const emit = (run, event) => run.events.push(event);
  const cap = run => (run.boosting ? run.rules.boostMax : run.rules.maxSpeed);
  const minimum = run => (run.status === 'finished' ? 0 : run.rules.crawl);

  function takeoff(run, vx, vy) {
    run.grounded = false;
    run.vx = vx;
    run.vy = vy;
    run.y += 0.5;
    run.airTime = 0;
    emit(run, { type: 'takeoff', x: run.x, y: run.y });
  }

  function ground(run, point, speed) {
    const norm = Math.hypot(1, point.slope);
    run.speed = speed;
    run.vx = speed / norm;
    run.vy = speed * point.slope / norm;
    run.y = point.h + run.rules.radius;
    run.grounded = true;
  }

  /** Scale the rider's speed, on the ground or in the air. */
  function scaleSpeed(run, factor) {
    if (run.grounded) {
      ground(run, surface(run, run.x), clamp(run.speed * factor, minimum(run), cap(run)));
    } else {
      run.vx *= factor;
      run.vy *= factor;
    }
  }

  /** The nearest low (in the current orientation) and its index, within an x distance. */
  function nearestLow(run, x, reach) {
    const extremes = run.course.extremes;
    let best = -1;
    let distance = reach;
    for (let index = 0; index < extremes.length; index++) {
      const point = extremes[index];
      if (point.x < x - reach) continue;
      if (point.x > x + reach) break;
      if (point.kind !== -run.sign) continue;
      const gap = Math.abs(point.x - x);
      if (gap < distance) {
        distance = gap;
        best = index;
      }
    }
    return best;
  }

  /** Next low ahead of x in the current orientation (for guides and bots). */
  function nextLow(run, x = run.x) {
    for (const point of run.course.extremes) {
      if (point.x >= x && point.kind === -run.sign) return point;
    }
    return null;
  }

  function judge(run) {
    const rules = run.rules;
    const pace = Math.max(250, Math.abs(run.vx));
    const index = nearestLow(run, run.x, rules.goodWindow * pace + 400);
    if (index < 0 || run.judged.has(index)) return run.grounded ? 'miss' : null;
    const low = run.course.extremes[index];
    const distance = Math.abs(run.x - low.x);
    if (distance > low.half + rules.goodWindow * pace) return run.grounded ? 'miss' : null;
    run.judged.add(index);
    return distance <= low.half * 0.5 + rules.perfectWindow * pace ? 'perfect' : 'good';
  }

  function flip(run) {
    const rules = run.rules;
    const pivot = heightAt(run, run.x);
    const quality = judge(run);
    const event = {
      type: 'flip',
      x: run.x,
      pivot,
      sign: run.sign,
      offset: run.offset,
      grounded: run.grounded,
      quality
    };
    run.offset = 2 * pivot - run.offset;
    run.sign = -run.sign;
    run.flipTicks.push(run.tick);
    run.stats.flips += 1;

    if (run.grounded) {
      const after = surface(run, run.x);
      const norm = Math.hypot(1, after.slope);
      const tx = 1 / norm;
      const ty = after.slope / norm;
      const away = -run.vx * ty + run.vy * tx;
      if (away > rules.hopSpeed) takeoff(run, run.vx, run.vy);
      else ground(run, after, clamp(run.vx * tx + run.vy * ty, minimum(run), cap(run)));
    }

    if (quality === 'perfect' || quality === 'good') {
      run.stats[quality] += 1;
      run.streak += 1;
      run.stats.bestStreak = Math.max(run.stats.bestStreak, run.streak);
      if (quality === 'perfect') scaleSpeed(run, 1 + rules.flipBonus);
    } else if (quality === 'miss') {
      run.streak = 0;
    }
    event.streak = run.streak;
    emit(run, event);
  }

  function land(run, x, vx, vy) {
    const rules = run.rules;
    const point = surface(run, x);
    const norm = Math.hypot(1, point.slope);
    const tx = 1 / norm;
    const ty = point.slope / norm;
    const along = vx * tx + vy * ty;
    const into = vx * ty - vy * tx;
    const error = Math.atan2(Math.max(0, into), along);
    const magnitude = Math.hypot(vx, vy);
    // Arcade landings: touching down on a descent keeps most of the speed; a climb or a steep
    // mismatch keeps only the part of the velocity that runs along the surface.
    let speed = along;
    let quality = 'normal';
    if (run.airTime >= rules.cleanAir && error < rules.cleanAngle) {
      quality = 'clean';
      speed = magnitude * (1 + rules.cleanBonus);
      run.stats.clean += 1;
    } else if (point.slope <= 0.02 && error < rules.hardAngle) {
      speed = magnitude * (1 - rules.landingLoss * error * error);
    } else if (along < magnitude * 0.9) {
      quality = 'hard';
      run.stats.hard += 1;
      run.streak = 0;
    }
    run.x = x;
    ground(run, point, clamp(speed, minimum(run), cap(run)));
    run.stats.airTime += run.airTime;
    emit(run, { type: 'land', quality, x, y: point.h, speed: run.speed, air: run.airTime, error });
    run.airTime = 0;
  }

  function groundStep(run) {
    const rules = run.rules;
    const dt = rules.dt;
    const here = surface(run, run.x);
    const norm = Math.hypot(1, here.slope);
    const tx = 1 / norm;
    const ty = here.slope / norm;
    const curvature = here.curve / (norm * norm * norm);
    if (run.speed > rules.takeoffSpeed && run.speed * run.speed * curvature + rules.gravity * tx * rules.grip < 0) {
      takeoff(run, run.speed * tx, run.speed * ty);
      airStep(run);
      return;
    }
    let accel = -rules.gravity * ty - rules.rolling * run.speed - rules.drag * run.speed * run.speed;
    if (run.boosting) accel += rules.boostThrust;
    if (run.status === 'finished') accel -= rules.finishBrake;
    const speed = clamp(run.speed + accel * dt, minimum(run), cap(run));
    run.x += speed * tx * dt;
    ground(run, surface(run, run.x), speed);
    run.crawlTime = speed <= rules.crawl + 0.5 && here.slope > 0 ? run.crawlTime + dt : 0;
    if (run.crawlTime > 0.25) run.streak = 0;
  }

  function airStep(run) {
    const rules = run.rules;
    const dt = rules.dt;
    const g = rules.gravity;
    const x0 = run.x;
    const y0 = run.y;
    const speed = Math.hypot(run.vx, run.vy);
    let factor = 1 - rules.airDrag * speed * dt;
    // Terminal speed in the air matches the ground cap, so jumps and long drops stay readable.
    factor = Math.min(factor, cap(run) / Math.max(1, speed));
    const vx = run.vx * factor;
    const vy = run.vy * factor;
    const below = time => y0 + vy * time - 0.5 * g * time * time - rules.radius <= heightAt(run, x0 + vx * time);
    run.airTime += dt;
    if (!below(dt)) {
      run.x = x0 + vx * dt;
      run.y = y0 + vy * dt - 0.5 * g * dt * dt;
      run.vx = vx;
      run.vy = vy - g * dt;
      return;
    }
    let low = 0;
    let high = dt;
    for (let index = 0; index < 14; index++) {
      const middle = (low + high) / 2;
      if (below(middle)) high = middle;
      else low = middle;
    }
    land(run, x0 + vx * high, vx, vy - g * high);
  }

  /** Coins are the only pickups: each adds cash to the gauge, up to its cap (the rest is lost). */
  function pickup(run) {
    const items = run.items;
    if (!items.length) return;
    const rules = run.rules;
    const types = CF.items.TYPES;
    while (run.cursor < items.length && items[run.cursor].x < run.x - 420) run.cursor += 1;
    const hx = run.x;
    const hy = run.y + rules.hitLift;
    for (let index = run.cursor; index < items.length; index++) {
      const item = items[index];
      if (item.x > run.x + 420) break;
      if (run.taken[index]) continue;
      const y = heightAt(run, item.x) + item.lift;
      if (Math.hypot(item.x - hx, y - hy) > types[item.type].radius + rules.hitRadius) continue;
      run.taken[index] = 1;
      run.stats.coins += 1;
      const full = run.cash + rules.coinCash > rules.cashMax + 1e-9;
      if (full) run.stats.overflow += 1;
      run.cash = Math.min(rules.cashMax, run.cash + rules.coinCash);
      emit(run, { type: 'item', kind: 'coin', index, x: item.x, y, full });
    }
  }

  /** BOOST is held: burn cash while there is any. Presses and releases are recorded. */
  function boost(run, held) {
    if (held !== run.held) {
      run.held = held;
      run.boostTicks.push(run.tick);
    }
    const rules = run.rules;
    const was = run.boosting;
    run.boosting = held && run.cash > 0;
    if (run.boosting) {
      run.cash = Math.max(0, run.cash - rules.burnRate * rules.dt);
      run.stats.boostTime += rules.dt;
      if (!was) run.stats.boosts += 1;
    }
    if (run.boosting !== was) emit(run, { type: run.boosting ? 'boost' : 'coast', x: run.x, y: run.y, empty: held && !run.boosting });
  }

  /** One fixed simulation tick. input.flip is an edge (one flip per tick at most); input.boost is held. */
  function step(run, input) {
    if (run.status !== 'running' && run.status !== 'finished') return run;
    run.prevX = run.x;
    run.prevY = run.y;
    if (input && input.flip && run.status === 'running') flip(run);
    if (run.status === 'running') boost(run, Boolean(input && input.boost));
    else run.boosting = false;
    const previousX = run.x;
    if (run.grounded) groundStep(run);
    else airStep(run);
    if (run.status === 'running') {
      pickup(run);
      run.stats.maxSpeed = Math.max(run.stats.maxSpeed, Math.hypot(run.vx, run.vy));
      if (run.x >= run.course.finishX) {
        const fraction = clamp((run.course.finishX - previousX) / Math.max(1e-9, run.x - previousX), 0, 1);
        run.finishTime = (run.tick + fraction) * run.rules.dt;
        run.status = 'finished';
        emit(run, { type: 'finish', time: run.finishTime, score: run.finishTime });
      }
    }
    run.tick += 1;
    if (!Number.isFinite(run.x + run.y + run.vx + run.vy)) throw new Error('Non-finite simulation state.');
    return run;
  }

  /** Raw riding time. */
  function elapsed(run) {
    return run.finishTime ?? run.tick * run.rules.dt;
  }

  /** The score is the riding time: how fast the chart was crossed. */
  function score(run) {
    return elapsed(run);
  }

  /** Recorded input as a per-tick feed: call it with each tick, in order. Boost ticks toggle the hold. */
  function inputs(flipTicks = [], boostTicks = []) {
    let flipAt = 0;
    let boostAt = 0;
    const input = { flip: false, boost: false };
    return tick => {
      input.flip = flipAt < flipTicks.length && flipTicks[flipAt] === tick;
      if (input.flip) flipAt += 1;
      while (boostAt < boostTicks.length && boostTicks[boostAt] === tick) {
        input.boost = !input.boost;
        boostAt += 1;
      }
      return input;
    };
  }

  /** Re-simulate a run from its recorded flip and boost ticks (used by ghosts and tests). */
  function replay(course, flipTicks, boostTicks = [], limitSeconds = 600) {
    const run = createRun(course);
    start(run);
    const limit = limitSeconds / run.rules.dt;
    const next = inputs(flipTicks, boostTicks);
    while (run.status === 'running' && run.tick < limit) {
      step(run, next(run.tick));
      run.events.length = 0;
    }
    return run;
  }

  CF.engine = { RULES, createRun, start, step, surface, heightAt, nextLow, elapsed, score, replay, inputs };
})(globalThis.Chartflip = globalThis.Chartflip || {});
