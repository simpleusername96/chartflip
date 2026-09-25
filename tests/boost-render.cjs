/* Offscreen checks of real engine/renderer integration on a controlled downhill. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadPlaywright, serve, ORIGIN } = require('./browser-smoke.cjs');
async function main() {
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: 'msedge' });
  const out = process.env.CHARTFLIP_SHOTS;
  if (out) fs.mkdirSync(out, { recursive: true });
  let encoder, encoded;
  if (out) {
    encoder = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', '20', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(out, 'boost-motion.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
    encoded = new Promise((resolve, reject) => encoder.on('close', code => code ? reject(Error('Video encoding failed')) : resolve()));
  }
  const errors = [];
  try {
    for (const reduced of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
      await serve(context);
      await context.addInitScript(() => { window.requestAnimationFrame = () => 0; });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(ORIGIN);
      await page.evaluate(reduced => {
        document.querySelectorAll('.screen, #hud, #prompt, #keys, #wallet').forEach(el => { el.hidden = true; });
        const CF = Chartflip, E = CF.engine;
        const course = CF.terrain.buildCourse({ id: 'boost-lab', kind: 'authored', points: [[0, 0], [30000, -3000], [32000, -3000]], medals: [20, 30, 40], name: { ko: 'Boost', en: 'Boost' }, coinLayout: [] });
        const run = E.createRun(course); E.start(run); run.cash = 60;
        const canvas = document.getElementById('game');
        const renderer = new CF.render.Renderer(canvas, { reducedMotion: reduced, text: key => CF.i18n.TEXT.en[key] || '' });
        renderer.reset(run);
        const ctx = canvas.getContext('2d'), setTransform = ctx.setTransform.bind(ctx);
        let translated = [];
        ctx.setTransform = (...args) => { if (args.length === 6 && (args[4] || args[5])) translated.push([args[4], args[5]]); return setTransform(...args); };
        window.renderStep = frame => {
          for (let i = 0; i < 2; i++) E.step(run, { boost: frame < 330 });
          run.events.length = 0;
          translated = [];
          renderer.update(1 / 60, run); renderer.draw(run, { guide: true });
          return { charge: run.boostCharge, x: run.x, speed: run.speed, shifts: translated };
        };
        window.restartRender = () => {
          const fresh = E.createRun(course); renderer.reset(fresh); translated = []; renderer.draw(fresh);
          return translated;
        };
      }, reduced);
      const trace = [];
      for (let frame = 0; frame < 420; frame++) {
        trace.push(await page.evaluate(frame => window.renderStep(frame), frame));
        if (out && frame % 3 === 0) {
          const shot = await page.screenshot({ type: 'jpeg', quality: 90 });
          if (!encoder.stdin.write(shot)) await new Promise(resolve => encoder.stdin.once('drain', resolve));
        }
        if (out && [8, 150, 270, 419].includes(frame)) await page.screenshot({ path: path.join(out, (reduced ? 'reduced' : 'normal') + '-' + frame + '.png') });
      }
      const amplitude = values => Math.max(0, ...values.flatMap(frame => frame.shifts.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)])));
      assert.equal(trace[270].charge, 1);
      assert.equal(trace[419].charge, 0);
      if (reduced) assert.equal(amplitude(trace), 0, 'reduced motion has no viewport shake');
      else {
        assert.ok(amplitude(trace.slice(0, 15)) > 0.1, 'boost onset gives a small tactile pulse');
        assert.ok(amplitude(trace.slice(235, 260)) > 0.1, 'reaching peak power gives a brief pulse');
        assert.ok(amplitude(trace.slice(290, 330)) < 0.001, 'holding peak power does not keep shaking the view');
        assert.ok(amplitude(trace) <= 1.5, 'comfort pulse remains below 1.5 pixels');
        assert.ok(amplitude(trace.slice(-10)) < 0.001, 'release settles promptly');
      }
      assert.deepEqual(await page.evaluate(() => window.restartRender()), [], 'restart clears camera vibration');
      if (!reduced) {
        const lines = await page.evaluate(() => {
          const CF = Chartflip;
          const course = CF.terrain.buildCourse({ id: 'lines', kind: 'authored', points: [[0, 0], [30000, 0]], name: { en: 'Lines' }, medals: [10, 20, 30], coinLayout: [] });
          const run = CF.engine.createRun(course); CF.engine.start(run); run.vx = run.speed = 1800;
          const renderer = new CF.render.Renderer(document.getElementById('game'));
          renderer.reset(run); renderer.update(600, run);
          const ctx = renderer.ctx, move = ctx.moveTo.bind(ctx), line = ctx.lineTo.bind(ctx);
          let points = [];
          ctx.moveTo = (x, y) => { points.push([x, y]); move(x, y); };
          ctx.lineTo = (x, y) => { points.at(-1).push(x); line(x, y); };
          const capture = () => { points = []; renderer.drawSpeedLines(run); return points; };
          const before = capture();
          run.vx = run.speed = 3000; renderer.update(0, run);
          const changed = capture();
          renderer.update(1 / 60, run); const after = capture();
          ctx.moveTo = move; ctx.lineTo = line;
          return { before, changed, after };
        });
        assert.ok(lines.before.length > 0);
        assert.deepEqual(lines.changed, lines.before, 'changing speed without advancing time cannot teleport speed lines');
        for (let i = 0; i < lines.before.length; i++) {
          const distance = lines.changed[i][0] - lines.after[i][0];
          const offscreenWrap = lines.changed[i][2] < 17 && lines.after[i][0] > 960;
          assert.ok((distance >= 0 && distance < 17) || offscreenWrap, 'visible speed lines advance continuously; a line may wrap only as its trailing end exits: ' + JSON.stringify({ before: lines.changed[i], after: lines.after[i] }));
        }
      }
      const flight = await page.evaluate(reduced => {
        const CF = Chartflip, E = CF.engine;
        const course = CF.terrain.buildCourse({ id: 'air-render', kind: 'authored', points: [[0, 0], [40000, 0]], medals: [20, 30, 40], name: { en: 'Air' }, coinLayout: [] });
        const run = E.createRun(course); E.start(run); run.cash = 60;
        for (let tick = 0; tick < 240; tick++) E.step(run, { boost: true });
        const renderer = new CF.render.Renderer(document.getElementById('game'), { reducedMotion: reduced });
        renderer.reset(run); renderer.update(1 / 60, run);
        const charge = run.boostCharge;
        run.grounded = false; run.y += 800; run.prevY = run.y; run.vy = 900;
        const ctx = renderer.ctx, setTransform = ctx.setTransform.bind(ctx);
        let shakes = 0;
        ctx.setTransform = (...args) => { if (args[4] || args[5]) shakes++; return setTransform(...args); };
        for (let tick = 0; tick < 48; tick++) { E.step(run, { boost: true }); run.events.length = 0; renderer.update(E.RULES.dt, run); renderer.draw(run); }
        const withFlame = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
        renderer.draw({ ...run, boosting: false });
        const withoutFlame = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
        let flamePixels = 0;
        for (let i = 0; i < withFlame.length; i += 4) if (withFlame[i] > 240 && withFlame[i + 1] > 70 && withFlame[i + 1] < 230 && withFlame[i + 2] < 100 && (withFlame[i] !== withoutFlame[i] || withFlame[i + 1] !== withoutFlame[i + 1])) flamePixels++;
        renderer.draw(run);
        ctx.setTransform = setTransform;
        return { airborne: !run.grounded, charge: run.boostCharge, initial: charge, flamePixels, shakes, airBoostTime: run.stats.airBoostTime };
      }, reduced);
      assert.ok(flight.airborne && flight.charge > flight.initial && flight.airBoostTime > 0);
      assert.ok(flight.flamePixels > 20, 'air thrust renders a visible flame, including with reduced motion');
      assert.equal(flight.shakes, 0, 'air boost never shakes the camera');
      if (out) await page.screenshot({ path: path.join(out, reduced ? 'air-reduced.png' : 'air-boost.png') });
      await context.close();
    }
  } finally { await browser.close(); if (encoder) encoder.stdin.end(); }
  if (encoded) await encoded;
  assert.deepEqual(errors, []);
  console.log('boost render: ok (ramp, peak, release, reset and reduced motion)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
