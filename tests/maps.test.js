'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CF, play, policies } = require('./bots.js');
require('../src/maps.js');
const M = CF.maps;
const build = CF.terrain.buildCourse;
const make = (seed = 41, settings) => M.normalize(M.documentFor(M.generate(seed, settings)).map);

test('maps: seed and parameters reproduce geometry, coins and riding result', () => {
  const a = make(), b = make();
  assert.deepEqual(a, b);
  assert.notEqual(a.id, make(42).id);
  assert.deepEqual(play(build(a), policies.onTime).time, play(build(b), policies.onTime).time);
  for (const d of [1, 5, 10]) {
    const def = make(17, M.defaults(d));
    assert.equal(def.points.at(-1)[0], M.defaults(d).length);
    assert.equal(def.coinLayout.length, M.defaults(d).coins);
    assert.ok(def.coinLayout.every(([, lift]) => lift === CF.items.TYPES.coin.lift), 'generated coins stay directly above the terrain');
    assert.ok(play(build(def), policies.onTime).finished);
  }
});

test('maps: extreme supported controls build valid, distinct portable maps', () => {
  for (const settings of [
    { length: 12000, height: 1800, spacing: 800, coins: 10, placement: 'early' },
    { length: 60000, height: 300, spacing: 3200, coins: 200, placement: 'late' }
  ]) {
    const def = make(9, settings);
    assert.equal(def.coinLayout.length, settings.coins);
    assert.deepEqual(M.decode(M.encode(def)), def);
    assert.ok(build(def).items.every(item => Number.isFinite(item.lift)));
  }
  const early = make(5, { placement: 'early' }), late = make(5, { placement: 'late' });
  assert.deepEqual(early.points, late.points);
  assert.notDeepEqual(early.coinLayout, late.coinLayout);
  assert.notEqual(early.id, late.id);
});

test('maps: exported snapshots retain the exact ride, independent of names and medal edits', () => {
  const def = make();
  const data = M.documentFor(def);
  data.map.title = 'R & M <map>';
  data.map.medals = [10, 20, 30];
  const imported = M.decode(JSON.stringify(data));
  assert.equal(imported.id, def.id);
  assert.deepEqual(build(imported).items, build(def).items);
  assert.deepEqual(build(imported).terrain, build(def).terrain);
  const result = play(build(imported), policies.onTime);
  assert.equal(result.time, play(build(def), policies.onTime).time);
});

test('maps: reject malformed, oversized and unsupported files before building terrain', () => {
  const base = M.documentFor(make());
  for (const mutate of [
    d => d.version = 99,
    d => d.map.points[1][0] = 0,
    d => d.map.points[1][1] = 1e100,
    d => d.map.coins[0][0] = -20,
    d => d.map.coins[0][1] = null,
    d => d.map.medals = [20, 10, 30],
    d => d.map.title = ' ',
    d => d.map.points = Array(1000).fill([0, 0])
  ]) {
    const data = structuredClone(base); mutate(data);
    assert.throws(() => M.decode(JSON.stringify(data)));
  }
  assert.throws(() => M.decode(' '.repeat(128001)));
});

test('maps: library round trip, update, removal and blocked storage preserve session data', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const library = M.library(storage), def = make();
  assert.equal(library.save(def).persisted, true);
  def.name = { ko: 'renamed', en: 'renamed' }; def.medals = [20, 30, 40];
  library.save(def);
  const loaded = M.library(storage);
  assert.equal(loaded.maps.length, 1);
  assert.equal(loaded.maps[0].name.en, 'renamed');
  loaded.remove(def.id);
  assert.equal(M.library(storage).maps.length, 0);
  storage.setItem(M.KEY, JSON.stringify([M.documentFor(def), { format: 'broken' }]));
  const partial = M.library(storage);
  assert.equal(partial.error, true);
  assert.deepEqual(partial.maps, [def]);
  const blocked = M.library({ getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } });
  assert.equal(blocked.error, true);
  assert.equal(blocked.save(def).persisted, false);
  assert.deepEqual(M.decode(M.encode(blocked.maps[0])), def);
});

test('maps: evaluation suggests ordered achievable targets and confirms useful controls', async () => {
  for (const difficulty of [1, 5, 10]) {
    const def = make(41, M.defaults(difficulty));
    const progress = [];
    const report = await M.evaluate(def, { progress: n => progress.push(n) });
    assert.ok(report.medals[0] >= report.time);
    assert.ok(report.medals[0] < report.medals[1] && report.medals[1] < report.medals[2]);
    assert.ok(report.flipGain > 0.1 && report.boostGain > 0.1);
    assert.equal(progress.at(-1), 1);
  }
});

test('maps: evaluation can be cancelled after starting without publishing a partial result', async () => {
  const controller = new AbortController();
  const pending = M.evaluate(make(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(pending, { name: 'AbortError' });
});
