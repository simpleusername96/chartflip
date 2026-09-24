/* Scripted players used to measure whether skill matters, and to derive medal times.
 * A player is a flip policy plus a boost policy (when to hold BOOST and burn cash).
 * Node only. `node tests/bots.js` prints a strategy table; `node tests/bots.js medals` suggests medal times. */
'use strict';

require('../src/terrain.js');
require('../src/courses.js');
require('../src/items.js');
require('../src/engine.js');

const CF = globalThis.Chartflip;
const { buildCourse } = CF.terrain;

require('../src/simulation.js');
const { PROFILES, policies, boostPolicies, booster, human, play, summarize, distribution, suggestMedals } = CF.simulation;

/** Replace the calibrated medal table in src/courses.js. */
function writeMedals(medals) {
  const fs = require('fs');
  const file = require('path').join(__dirname, '../src/courses.js');
  let text = fs.readFileSync(file, 'utf8');
  const startMarker = '  const medalTimes = ';
  const endMarker = ';\n\n  CF.courses';
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('medal table not found');
  const table = JSON.stringify(medals, null, 4).replace(/\n/g, '\n  ');
  text = text.slice(0, start) + startMarker + table + text.slice(end);
  fs.writeFileSync(file, text);
  console.log('medals written to src/courses.js');
}

module.exports = { CF, PROFILES, policies, boostPolicies, booster, human, play, summarize, distribution, suggestMedals, buildCourse };

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'medals') {
    const out = {};
    for (const def of CF.courses) out[def.id] = suggestMedals(buildCourse(def));
    console.log(JSON.stringify(out));
    if (process.argv.includes('--write')) writeMedals(out);
  } else {
    for (const def of CF.courses) {
      if (mode && def.id !== mode) continue;
      const course = buildCourse(def);
      console.log(`== ${def.id} legs=${course.legs} medals=${def.medals}`);
      for (const [name, policy] of Object.entries(policies)) console.log(`  ${name.padEnd(9)}${JSON.stringify(summarize(play(course, policy)))}`);
      for (const name of ['none', 'always']) {
        console.log(`  boost:${name.padEnd(7)}${JSON.stringify(summarize(play(course, policies.onTime, { boost: boostPolicies[name] })))}`);
      }
    }
  }
}
