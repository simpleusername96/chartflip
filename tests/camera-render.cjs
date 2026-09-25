/* Actual engine flight and hill framing through the production renderer, offscreen. */
'use strict';
const assert = require('node:assert/strict');
const { loadPlaywright, serve, shot, ORIGIN } = require('./browser-smoke.cjs');
async function main() {
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [];
  try {
    for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844], ['landscape', 844, 390]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await serve(context);
      await context.addInitScript(() => { window.requestAnimationFrame = () => 0; });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(ORIGIN);
      const trace = await page.evaluate(() => {
        const CF = Chartflip, E = CF.engine;
        document.querySelectorAll('.screen, #hud, #prompt, #keys, #wallet').forEach(el => { el.hidden = true; });
        const course = CF.terrain.buildCourse({ id: 'camera-flight', kind: 'authored', points: [[0, 0], [40000, 0]], medals: [20, 30, 40], name: { ko: 'Camera', en: 'Camera' }, coinLayout: [] });
        const run = E.createRun(course); E.start(run);
        const renderer = new CF.render.Renderer(document.getElementById('game'), { text: key => CF.i18n.TEXT.en[key] || '' });
        renderer.reset(run);
        const initial = renderer.camera.zoom;
        // A high launch; all subsequent ascent, fall and landing are real physics.
        run.grounded = false; run.vx = 1200; run.vy = 1900; run.y += 1;
        const frames = [];
        for (let frame = 0; frame < 540; frame++) {
          E.step(run, {}); E.step(run, {}); run.events.length = 0;
          renderer.update(1 / 60, run); renderer.draw(run, { guide: true });
          frames.push({ zoom: renderer.camera.zoom, y: renderer.sy(run.y), ground: renderer.sy(E.heightAt(run, run.x)), airborne: !run.grounded, altitude: run.y - E.heightAt(run, run.x) });
          if (frame === 80) window.apexImage = document.getElementById('game').toDataURL();
        }
        return { initial, frames };
      });
      const airborne = trace.frames.filter(frame => frame.airborne);
      const apex = airborne.reduce((a, b) => a.altitude > b.altitude ? a : b);
      assert.ok(Math.min(...airborne.map(frame => frame.zoom)) < trace.initial * 0.75, label + ': high jumps visibly zoom out');
      assert.ok(airborne.every(frame => frame.y > 20 && frame.y < height - 20), label + ': rider stays in the frame');
      assert.ok(apex.ground < height - 15, label + ': ground is visible at the apex');
      assert.ok(trace.frames.at(-1).zoom > trace.initial * 0.95, label + ': landing eases back to normal zoom');
      const landed = trace.frames.findIndex((frame, i) => i && !frame.airborne && trace.frames[i - 1].airborne);
      assert.ok(landed > 0);
      assert.ok(trace.frames.slice(landed, landed + 30).every(frame => frame.zoom <= trace.frames[landed].zoom + 0.001), label + ': landing holds the wider view before zooming in');
      for (let i = 1; i < trace.frames.length; i++) assert.ok(Math.abs(trace.frames[i].zoom / trace.frames[i - 1].zoom - 1) < 0.08, label + ': no abrupt zoom steps');
      await page.evaluate(() => { const image = new Image(); image.src = window.apexImage; image.style.cssText = 'position:fixed;inset:0;width:100%;height:100%'; document.body.append(image); });
      await shot(page, label + '-jump');
      // A rider on a high crest should also frame the adjacent lower ground.
      const hill = await page.evaluate(() => {
        const CF = Chartflip, E = CF.engine;
        const course = CF.terrain.buildCourse({ id: 'camera-hill', kind: 'authored', points: [[0, 0], [1000, 1800], [2500, 0], [6000, 0]], medals: [20, 30, 40], name: { ko: 'Hill', en: 'Hill' }, coinLayout: [] });
        const run = E.createRun(course); run.x = 1000; run.y = E.heightAt(run, run.x) + E.RULES.radius; run.prevX = run.x; run.prevY = run.y;
        const renderer = new CF.render.Renderer(document.getElementById('game'), { text: key => CF.i18n.TEXT.en[key] || '' });
        renderer.reset(run); renderer.draw(run, { guide: true });
        return { zoom: renderer.camera.zoom, rider: renderer.sy(run.y), lower: renderer.sy(E.heightAt(run, run.x + (innerHeight > innerWidth ? 860 : Math.max(1100, Math.min(1650, innerWidth * 1.05))) * 0.47)) };
      });
      assert.ok(hill.rider > 20 && hill.lower < height - 15, label + ': a high climb keeps nearby lower terrain visible');
      const drift = await page.evaluate(() => {
        const CF = Chartflip, E = CF.engine;
        const course = CF.terrain.buildCourse({ id: 'camera-bumps', kind: 'authored', points: [[0, 0], [40000, 0]], medals: [20, 30, 40], name: { en: 'Bumps' }, coinLayout: [] });
        const run = E.createRun(course); run.x = run.prevX = 10000;
        const groundY = E.heightAt(run, run.x) + E.RULES.radius; run.y = run.prevY = groundY;
        const renderer = new CF.render.Renderer(document.getElementById('game'));
        renderer.reset(run);
        const initial = { y: renderer.camera.y, zoom: renderer.camera.zoom };
        let drift = 0;
        for (let i = 0; i < 180; i++) {
          run.y = run.prevY = groundY + Math.sin(i / 10) * innerHeight * 0.02 / initial.zoom;
          renderer.update(1 / 60, run);
          drift = Math.max(drift, Math.abs(renderer.camera.y - initial.y) * initial.zoom, Math.abs(renderer.camera.zoom - initial.zoom) * 100);
        }
        return drift;
      });
      assert.ok(drift < 0.1, label + ': small vertical changes do not move or pump the camera');
      await context.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, []);
  console.log('camera render: ok (high flight, hills, smooth recovery, three layouts)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
