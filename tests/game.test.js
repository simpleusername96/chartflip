/* Chartflip rules and fun gates. Run: node --test tests/ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CF, PROFILES, policies, boostPolicies, booster, human, play, distribution } = require('./bots.js');

const { buildCourse, Terrain, zigzag } = CF.terrain;
const E = CF.engine;
const courses = CF.courses.map(def => buildCourse(def));
const byId = id => courses.find(course => course.id === id);

function runUntil(course, predicate, limit = 120 * 60) {
  const run = E.createRun(course);
  E.start(run);
  while (!predicate(run) && run.tick < limit) {
    E.step(run, {});
    run.events.length = 0;
  }
  return run;
}

test('course data: fictional chart shapes and ordered medals', () => {
  assert.equal(CF.courses[0].id, 'practice', 'the tutorial comes first');
  for (const def of CF.courses) {
    const [gold, silver, bronze] = def.medals;
    assert.ok(gold > 0 && gold < silver && silver < bronze, `${def.id} medals must be ascending`);
    assert.ok(def.name.ko && def.name.en, `${def.id} is named in both languages`);
    assert.equal(def.source, undefined, `${def.id} does not include a third-party data source`);
    assert.equal(def.ticker, undefined, `${def.id} does not include a real market ticker`);
    if (def.kind !== 'chart') continue;
    assert.ok(def.values.length >= 70, `${def.id} has a playable chart shape`);
    assert.ok(def.values.every(value => Number.isInteger(value) && value >= 0 && value <= 1000), `${def.id} uses synthetic 0..1000 values`);
  }
});

test('terrain: monotone cubic never overshoots its samples and stays rideable', () => {
  for (const course of courses) {
    const terrain = course.terrain;
    let steepest = 0;
    for (let index = 0; index < terrain.xs.length - 1; index++) {
      const low = Math.min(terrain.ys[index], terrain.ys[index + 1]) - 1e-6;
      const high = Math.max(terrain.ys[index], terrain.ys[index + 1]) + 1e-6;
      for (let part = 0; part <= 8; part++) {
        const point = terrain.at(terrain.xs[index] + (terrain.xs[index + 1] - terrain.xs[index]) * part / 8);
        assert.ok(point.h >= low && point.h <= high, `${course.id} overshoots near segment ${index}`);
        assert.ok(Number.isFinite(point.slope + point.curve));
        steepest = Math.max(steepest, Math.abs(point.slope));
      }
    }
    assert.ok(steepest < 1.3, `${course.id} steepest slope ${steepest.toFixed(2)} must stay rideable`);
    assert.ok(course.extremes.every(point => point.half > 0), `${course.id} turning points are flat plateaus`);
  }
});

test('zigzag keeps only reversals at or above the threshold', () => {
  const pivots = zigzag([0, 10, 8, 20, 5, 6, 30], 6);
  assert.deepEqual(pivots, [0, 3, 4, 6]);
  assert.throws(() => new Terrain([{ x: 0, y: 0 }, { x: 0, y: 1 }]));
});

test('flip mirrors the chart around the rider: height under the rider is unchanged', () => {
  const course = byId('double-bottom');
  const run = runUntil(course, candidate => candidate.x > 2500);
  const before = E.surface(run, run.x);
  const probe = run.x + 900;
  const ahead = E.surface(run, probe).h;
  E.step(run, { flip: true });
  const x = run.flipTicks.length && run.events.find(event => event.type === 'flip').x;
  const after = E.surface(run, x);
  assert.ok(Math.abs(after.h - E.surface({ ...run, sign: -run.sign, offset: 2 * after.h - run.offset }, x).h) < 1e-9);
  assert.ok(Math.abs(E.surface(run, x).h - (before.h + before.slope * (x - (run.x - (run.x - x))))) < 5, 'pivot height stays put');
  const mirrored = E.surface(run, probe).h;
  assert.ok(Math.abs((ahead - E.surface(run, x).h) + (mirrored - E.surface(run, x).h)) < 60, 'terrain ahead is mirrored');
  E.step(run, { flip: true });
  assert.equal(run.sign, 1, 'two flips restore the original orientation');
});

test('flip timing: lossless on a low, costly on a descent, a hop while climbing', () => {
  const course = byId('practice');
  const low = course.extremes.find(point => point.kind === -1 && point.x > 0);

  const onLow = runUntil(course, run => run.x >= low.x - 5);
  const speed = onLow.speed;
  E.step(onLow, { flip: true });
  const flipEvent = onLow.events.find(event => event.type === 'flip');
  assert.equal(flipEvent.quality, 'perfect');
  assert.ok(onLow.speed >= speed * 0.99, 'a flip at the bottom keeps speed');

  const onDescent = runUntil(course, run => run.grounded && run.x > 0 && E.surface(run, run.x).slope < -0.4);
  const descending = onDescent.speed;
  E.step(onDescent, { flip: true });
  assert.ok(onDescent.speed < descending * 0.8, 'flipping mid-descent turns it into a climb and costs speed');
  assert.equal(onDescent.events.find(event => event.type === 'flip').quality, 'miss');

  const climbing = runUntil(course, run => run.x >= low.x + low.half + 180);
  assert.ok(E.surface(climbing, climbing.x).slope > 0.05);
  E.step(climbing, { flip: true });
  assert.equal(climbing.grounded, false, 'a late flip lifts off the new descent');
});

test('one judgment per low: repeated flips cannot farm PERFECT bonuses', () => {
  const course = byId('practice');
  const low = course.extremes.find(point => point.kind === -1 && point.x > 0);
  const run = runUntil(course, candidate => candidate.x >= low.x - 3);
  for (let index = 0; index < 3; index++) E.step(run, { flip: true });
  assert.equal(run.stats.perfect, 1);
  assert.equal(run.stats.flips, 3);
});

test('deterministic: a run replays exactly from its recorded flip and boost ticks', () => {
  for (const course of courses) {
    const result = play(course, policies.onTime);
    assert.ok(result.finished, `${course.id} finishes`);
    const replayed = E.replay(course, result.run.flipTicks, result.run.boostTicks);
    assert.equal(replayed.finishTime, result.run.finishTime, `${course.id} replay matches`);
    assert.deepEqual(replayed.stats, result.run.stats);
  }
});

test('finish: time is interpolated inside the tick, later flips are ignored', () => {
  const course = byId('cup-handle');
  const result = play(course, policies.onTime);
  const run = result.run;
  assert.equal(run.status, 'finished');
  assert.ok(run.finishTime > (run.tick - 2) * E.RULES.dt && run.finishTime <= run.tick * E.RULES.dt);
  const flips = run.stats.flips;
  E.step(run, { flip: true });
  assert.equal(run.stats.flips, flips);
  assert.equal(E.elapsed(run), run.finishTime);
});

test('the rider never stops or reverses before the finish', () => {
  const run = play(byId('whipsaw'), policies.never, { limitSeconds: 400 }).run;
  assert.equal(run.status, 'finished', 'even without flipping the run completes by crawling');
  assert.ok(run.stats.maxSpeed > 0);
});

test('fun gate: skill decides the medal on every course', () => {
  for (const course of courses) {
    const [gold, silver, bronze] = course.def.medals;
    for (const name of ['never', 'mash', 'random']) {
      const time = play(course, policies[name], { limitSeconds: 400 }).time;
      assert.ok(time > bronze, `${course.id}: '${name}' must not earn a medal (${time.toFixed(1)}s vs bronze ${bronze}s)`);
    }
    const onTime = play(course, policies.onTime).time;
    assert.ok(onTime <= silver, `${course.id}: flipping on every low and boosting on the ground earns at least silver`);
    const reactive = play(course, policies.reactive).time;
    assert.ok(reactive > onTime, `${course.id}: reading the chart beats reacting to the climb`);
    const skilled = distribution(course, PROFILES.skilled);
    const golds = skilled.filter(time => time <= gold).length / skilled.length;
    assert.ok(golds >= 0.2 && golds <= 0.6, `${course.id}: gold should take a good skilled run (${Math.round(golds * 100)}% reach it)`);
    assert.ok(skilled[skilled.length >> 1] <= silver, `${course.id}: typical skilled play earns at least silver`);
    const sloppy = distribution(course, PROFILES.sloppy);
    assert.ok(sloppy[sloppy.length >> 1] <= bronze, `${course.id}: sloppy but engaged play still earns bronze`);
  }
});

test('fun gate: where you spend the cash matters, and boosting matters', () => {
  const median = times => times.slice().sort((a, b) => a - b)[times.length >> 1];
  let gained = 0;
  for (const course of courses) {
    const runs = make => {
      const times = [];
      for (let seed = 1; seed <= 40; seed++) times.push(play(course, human(PROFILES.skilled, seed * 7919), { boost: make(seed * 7919) }).time);
      return median(times);
    };
    const smart = runs(seed => booster({ sigma: 0.3 }, seed));
    const always = runs(() => boostPolicies.always);
    const none = runs(() => boostPolicies.none);
    assert.ok(smart <= always + 0.15, `${course.id}: boosting on the ground is never worse than holding boost all the time (${smart.toFixed(2)} vs ${always.toFixed(2)})`);
    assert.ok(none >= smart + 1, `${course.id}: never boosting costs time (${none.toFixed(2)} vs ${smart.toFixed(2)})`);
    gained += always - smart;
  }
  assert.ok(gained >= 5, `spending cash on the ground saves ${gained.toFixed(2)} s over holding boost everywhere`);
});

test('courses: fifteen, and they get longer and harder in order', () => {
  assert.equal(courses.length, 15);
  const charts = courses.slice(1);
  for (let index = 1; index < charts.length; index++) {
    assert.ok(charts[index].def.medals[0] > charts[index - 1].def.medals[0], `${charts[index].id}: gold time rises along the list`);
    assert.ok(charts[index].finishX > charts[index - 1].finishX, `${charts[index].id}: the course is longer than the one before`);
  }
  assert.ok(charts[charts.length - 1].legs >= charts[0].legs * 3, 'the last course has several times the bends of the first');
  for (const course of courses) {
    const turns = course.extremes.filter(point => point.x > 0);
    for (let index = 1; index < turns.length; index++) {
      assert.ok(turns[index].x - turns[index - 1].x >= 1000, `${course.id}: bends at least 1000 apart (${Math.round(turns[index - 1].x)})`);
    }
  }
});

// ---------- coins and the cash boost ----------

/** A straight test slope with hand-placed coins (placement is replaced after building). */
function lab(items, points = [[0, 0], [5000, -900], [5600, -900]]) {
  const course = buildCourse({ id: 'lab', kind: 'authored', points, dates: [], medals: [1, 2, 3], name: { ko: 'lab', en: 'lab' }, caption: { ko: '', en: '' } });
  course.items = items.map((item, index) => ({ lift: CF.items.TYPES[item.type].lift, ...item, id: index }));
  return course;
}

/** Ride with flips at given ticks and BOOST held whenever a predicate says so. */
function ride(course, { flipAt = [], boostWhen = () => false, until = run => run.status !== 'running', limit = 120 * 90, cash } = {}) {
  const run = E.createRun(course);
  E.start(run);
  if (cash !== undefined) run.cash = cash;
  const events = [];
  while (!until(run) && run.tick < limit) {
    E.step(run, { flip: flipAt.includes(run.tick), boost: boostWhen(run) });
    events.push(...run.events.splice(0));
  }
  return { run, events };
}

test('coins: deterministic placement along every leg; the score is the riding time', () => {
  for (const def of CF.courses) {
    const a = buildCourse(def).items;
    assert.deepEqual(a, buildCourse(def).items, `${def.id} placement is deterministic`);
    assert.ok(a.length > 0 && a.every(item => item.type === 'coin'), `${def.id}: coins only`);
    assert.ok(a.every((item, index) => index === 0 || item.x >= a[index - 1].x), `${def.id} coins sorted by x`);
  }
  for (const course of courses) {
    const { run } = play(course, policies.onTime);
    assert.equal(E.score(run), run.finishTime, `${course.id}: score is the riding time`);
    assert.ok(run.stats.coins > 0 && run.stats.boostTime > 0, `${course.id}: a normal run collects coins and boosts`);
  }
});

test('coins fill the cash gauge up to its cap; the rest is lost', () => {
  const coins = Array.from({ length: 40 }, (_, index) => ({ type: 'coin', x: 900 + index * 60, lift: 20 }));
  const { run, events } = ride(lab(coins), { until: candidate => candidate.x > 3500 });
  assert.equal(run.stats.coins, 40);
  assert.equal(run.cash, E.RULES.cashMax, 'the gauge stops at its cap');
  assert.equal(run.stats.overflow, 40 - E.RULES.cashMax / E.RULES.coinCash);
  assert.ok(events.some(event => event.kind === 'coin' && event.full), 'a coin into a full gauge is marked');
});

test('boost: held BOOST burns cash for thrust; releasing stops it; no cash, no boost', () => {
  const course = lab([]);
  const plain = ride(course, { until: run => run.tick === 240 }).run;
  const boosted = ride(course, { cash: 10, boostWhen: () => true, until: run => run.tick === 240 }).run;
  assert.ok(boosted.x > plain.x + 150, `boosting carries the rider further (${Math.round(boosted.x - plain.x)})`);
  assert.equal(boosted.cash, 0, 'ten cash lasts one second at the burn rate');
  assert.ok(Math.abs(boosted.stats.boostTime - 10 / E.RULES.burnRate) < 0.02);

  const half = ride(course, { cash: 10, boostWhen: run => run.tick < 60, until: run => run.tick === 240 }).run;
  assert.ok(Math.abs(half.cash - (10 - E.RULES.burnRate * 0.5)) < 0.1, 'releasing keeps the rest of the cash');
  assert.ok(half.x > plain.x && half.x < boosted.x, 'half the spend, part of the gain');

  const broke = ride(course, { boostWhen: () => true, until: run => run.tick === 240 }).run;
  assert.equal(broke.x, plain.x, 'with no cash, holding BOOST does nothing');
  assert.equal(broke.stats.boostTime, 0);
});

test('boost: it drives the wheels, so it pushes only on the ground but burns in the air too', () => {
  const course = lab([]);
  const air = ride(course, { cash: 30, until: run => run.tick === 60 }).run;
  air.grounded = false;
  air.vy = 600;
  const vx = air.vx;
  E.step(air, { boost: true });
  assert.ok(air.boosting && air.cash < 30, 'holding in the air burns cash');
  assert.ok(air.vx <= vx + 1e-9, 'but gives no thrust in the air');
});

test('deterministic: boost presses and releases replay exactly', () => {
  const course = courses[3];
  const result = play(course, policies.onTime);
  assert.ok(result.run.boostTicks.length > 1, 'the run pressed and released BOOST');
  const replayed = E.replay(course, result.run.flipTicks, result.run.boostTicks);
  assert.equal(replayed.finishTime, result.run.finishTime);
  assert.deepEqual(replayed.stats, result.run.stats);
});

test('text: both languages carry the same keys', () => {
  require('../src/i18n.js');
  const { TEXT } = CF.i18n;
  assert.deepEqual(Object.keys(TEXT.en).sort(), Object.keys(TEXT.ko).sort(), 'Korean and English have the same keys');
});

test('time text rounds before splitting minutes (59.996 s reads 1:00.00, not 60.00)', () => {
  require('../src/i18n.js');
  const { formatTime } = CF.i18n;
  assert.equal(formatTime(0), '00.00');
  assert.equal(formatTime(9.996), '10.00');
  assert.equal(formatTime(59.994), '59.99');
  assert.equal(formatTime(59.996), '1:00.00');
  assert.equal(formatTime(61.5), '1:01.50');
  assert.equal(formatTime(Number.NaN), '--.--');
});
