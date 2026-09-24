/* Versioned, portable user courses; no browser dependency in the data contract. */
(function (CF) {
  'use strict';
  const VERSION = 1;
  const KEY = 'chartflip.maps.v1';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fail = () => { throw new Error('invalid-map'); };
  const number = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  function random(seed) {
    let state = seed >>> 0;
    return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  }
  function defaults(difficulty = 5) {
    const d = clamp(Math.round(Number(difficulty) || 5), 1, 10);
    return { difficulty: d, length: 14000 + d * 2000, height: 500 + d * 100, spacing: 2400 - d * 100, coins: 35 + d * 5, placement: 'even' };
  }
  function parameters(input = {}) {
    const out = { ...defaults(input.difficulty), ...input };
    for (const [key, lo, hi] of [['difficulty', 1, 10], ['length', 12000, 60000], ['height', 300, 1800], ['spacing', 800, 3200], ['coins', 10, 200]]) {
      if (!number(out[key], lo, hi)) fail();
      out[key] = Math.round(out[key]);
    }
    if (!['even', 'early', 'late'].includes(out.placement)) fail();
    return out;
  }
  function generate(seed, input) {
    const p = parameters(input);
    const rng = random(seed);
    const count = clamp(Math.round(p.length / p.spacing), 5, 60);
    const widths = Array.from({ length: count }, () => 0.65 + rng() * 0.7);
    const total = widths.reduce((a, b) => a + b, 0);
    const points = [[0, 0]];
    let x = 0, y = 0;
    for (let i = 0; i < count; i++) {
      x += widths[i] / total * p.length;
      // Alternating reversals, independently varied widths and rises, plus a slow trend.
      const rise = p.height * (0.6 + rng() * 0.8);
      y += (i % 2 ? 1 : -1) * rise;
      points.push([i === count - 1 ? p.length : Math.round(x), Math.round(y)]);
    }
    const def = { id: 'draft', kind: 'authored', custom: true, name: { ko: '내 맵', en: 'My map' }, points, plateau: 150,
      medals: [20, 30, 45], seed: seed >>> 0, parameters: p, coinOptions: { count: p.coins, placement: p.placement } };
    const course = CF.terrain.buildCourse(def);
    def.coinLayout = course.items.map(({ x, lift }) => [x, lift]);
    delete def.coinOptions;
    return def;
  }
  function identity(def) {
    const source = JSON.stringify([def.points, def.plateau, def.coinLayout]);
    let a = 2166136261, b = 5381;
    for (const ch of source) { a = Math.imul(a ^ ch.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ ch.charCodeAt(0); }
    return 'user-' + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function normalize(data) {
    if (!data || typeof data !== 'object' || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 60) fail();
    if (!Array.isArray(data.points) || data.points.length < 4 || data.points.length > 81) fail();
    const points = data.points.map((point, i) => {
      if (!Array.isArray(point) || point.length !== 2 || !number(point[0], 0, 60000) || !number(point[1], -20000, 20000)) fail();
      if (i && (point[0] - data.points[i - 1][0] < 250 || Math.abs(point[1] - data.points[i - 1][1]) > 3000)) fail();
      return point.slice();
    });
    if (points[0][0] !== 0 || points[0][1] !== 0 || points.at(-1)[0] < 12000 || !number(data.plateau, 0, 300)) fail();
    if (!Array.isArray(data.coins) || data.coins.length < 1 || data.coins.length > 250) fail();
    const coinLayout = data.coins.map(coin => {
      if (!Array.isArray(coin) || coin.length !== 2 || !number(coin[0], 0, points.at(-1)[0]) || !number(coin[1], 16, 8000)) fail();
      return coin.slice();
    }).sort((a, b) => a[0] - b[0]);
    if (!Array.isArray(data.medals) || data.medals.length !== 3 || data.medals.some((v, i) => !number(v, 0.1, 600) || i > 0 && v <= data.medals[i - 1])) fail();
    const def = { kind: 'authored', custom: true, name: { ko: data.title.trim(), en: data.title.trim() }, points, plateau: data.plateau, coinLayout, medals: data.medals.slice() };
    if (Number.isInteger(data.seed) && data.seed >= 0 && data.seed <= 4294967295) def.seed = data.seed;
    if (data.parameters) def.parameters = parameters(data.parameters);
    def.id = identity(def);
    return def;
  }
  function documentFor(def) {
    const map = { title: def.name.en, points: def.points, plateau: def.plateau, coins: def.coinLayout, medals: def.medals };
    if (def.seed !== undefined) map.seed = def.seed;
    if (def.parameters) map.parameters = def.parameters;
    return { format: 'chartflip-map', version: VERSION, map };
  }
  function decode(text) {
    if (typeof text !== 'string' || text.length > 128000) fail();
    const data = JSON.parse(text);
    if (data?.format !== 'chartflip-map' || data.version !== VERSION) fail();
    return normalize(data.map);
  }
  function encode(def) { return JSON.stringify(documentFor(normalize(documentFor(def).map)), null, 2); }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  /** Simulations yield between small fixed-step batches, allowing paint and cancellation. */
  async function evaluate(def, { signal, progress = () => {} } = {}) {
    const S = CF.simulation;
    const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
    check();
    const course = CF.terrain.buildCourse(def);
    const play = async (policy, boost) => {
      const steps = S.playSteps(course, policy, { boost, limitSeconds: 180 });
      while (true) {
        check();
        const next = steps.next();
        if (next.done) return next.value.time;
        await tick();
      }
    };
    const times = {};
    // Flight can skip coin lines. Compare holding through jumps with saving fuel for landings.
    const groundedBoost = (run, memory) => run.grounded && S.boostPolicies.smart(run, memory);
    for (const [label, policy, boost] of [
      ['clean', S.policies.onTime, S.boostPolicies.smart],
      ['noFlip', S.policies.never, S.boostPolicies.smart],
      ['cleanGround', S.policies.onTime, groundedBoost],
      ['noFlipGround', S.policies.never, groundedBoost],
      ['noBoost', S.policies.onTime, S.boostPolicies.none]
    ]) { times[label] = await play(policy, boost); progress(Object.keys(times).length / 17); }
    times.clean = Math.min(times.clean, times.cleanGround);
    times.noFlip = Math.min(times.noFlip, times.noFlipGround);
    const profiles = [];
    let complete = 5;
    for (const profile of Object.values(S.PROFILES)) {
      const results = [];
      for (let seed = 1; seed <= 4; seed++) {
        results.push(await play(S.human(profile, seed * 7919), S.booster(profile.boost, seed * 7919)));
        progress(++complete / 17);
      }
      profiles.push(results.sort((a, b) => a - b));
    }
    check();
    if (![times.clean, ...profiles.flat()].every(Number.isFinite)) throw new Error('unfinishable');
    const flipGain = times.noFlip - times.clean;
    const boostGain = times.noBoost - times.clean;
    if (flipGain < 0.1 || boostGain < 0.1) throw new Error('weak-course');
    const ceil = v => Math.ceil(v * 10) / 10;
    const gold = ceil(Math.max(times.clean, profiles[0][1]));
    const silver = ceil(Math.max(gold + 1, profiles[1][2]));
    const bronze = ceil(Math.max(silver + 2, profiles[2][3]));
    return { medals: [gold, silver, bronze], time: times.clean, flipGain, boostGain };
  }
  /** Failed disk writes retain the session copy and report that it needs exporting. */
  function library(storage) {
    let maps = [], error = false;
    try {
      const raw = storage.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || data.length > 100) fail();
        const unique = new Map();
        for (const entry of data) {
          try { const def = decode(JSON.stringify(entry)); unique.set(def.id, def); }
          catch { error = true; }
        }
        maps = [...unique.values()];
      }
    } catch { error = true; }
    const persist = () => {
      try { storage.setItem(KEY, JSON.stringify(maps.map(documentFor))); error = false; return true; }
      catch { error = true; return false; }
    };
    return {
      get maps() { return maps.slice(); }, get error() { return error; },
      save(def) {
        const clean = decode(encode(def));
        const index = maps.findIndex(map => map.id === clean.id);
        if (index < 0) { if (maps.length >= 100) throw new Error('library-full'); maps.push(clean); }
        else maps[index] = clean;
        return { def: clean, persisted: persist() };
      },
      remove(id) { maps = maps.filter(map => map.id !== id); return persist(); }
    };
  }
  CF.maps = { VERSION, KEY, defaults, parameters, generate, identity, normalize, documentFor, decode, encode, evaluate, library };
})(globalThis.Chartflip = globalThis.Chartflip || {});
