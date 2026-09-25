/* Optional offscreen browser playthrough. Needs Playwright plus installed Edge or Chrome.
 * Files are served through request interception, so no local server or port is used.
 *   node tests/browser-smoke.cjs            # checks only
 *   CHARTFLIP_SHOTS=out node tests/browser-smoke.cjs   # also saves screenshots
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_MODULE,
    path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')];
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate); } catch (error) { /* try the next one */ }
  }
  return null;
}

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://chartflip.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const SHOTS = process.env.CHARTFLIP_SHOTS;

async function serve(context) {
  await context.route(`${ORIGIN}/**`, route => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await context.route(/^(?!http:\/\/chartflip\.test)/, route => route.abort());
}

/**
 * In-page pilot: presses Space when the rider crosses the next bottom of the current orientation,
 * and holds X (boost) while there is cash, including in flight.
 */
function installPilot() {
  const CF = window.Chartflip;
  const courses = {};
  let target = null;
  let held = false;
  function tick() {
    const s = CF.app.snapshot();
    if (s && s.screen === 'running') {
      const course = courses[s.course] || (courses[s.course] = CF.terrain.buildCourse(CF.courses.find(c => c.id === s.course) || CF.maps.library(localStorage).maps.find(c => c.id === s.course)));
      if (!target || target.sign !== s.sign || target.course !== s.course || target.x < s.x - 20000) {
        const low = course.extremes.find(point => point.x >= s.x - 1 && point.kind === -s.sign);
        target = low ? { x: low.x, sign: s.sign, course: s.course } : null;
      }
      if (target && s.x >= target.x) {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
        target = null;
      }
      // Hold through jumps so the real UI exercises airborne propulsion.
      const want = s.cash > 0;
      if (want !== held) {
        held = want;
        document.dispatchEvent(new KeyboardEvent(want ? 'keydown' : 'keyup', { code: 'KeyX', bubbles: true }));
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noOverflow(page, label) {
  const box = await page.evaluate(() => {
    const width = innerWidth;
    const bad = [...document.querySelectorAll('#hud button, #hud .tag, #hud .clock, #minimap')]
      .filter(element => element.offsetParent)
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.left < -1 || rect.right > width + 1).length;
    return { bad, scroll: document.documentElement.scrollWidth, width };
  });
  assert.equal(box.bad, 0, `${label}: HUD element outside the viewport`);
  assert.ok(box.scroll <= box.width + 1, `${label}: horizontal overflow`);
}

async function touchControls(context) {
  const page = await context.newPage();
  try {
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => window.Chartflip?.app);
    await page.tap('.course[data-index="0"]');
    await page.tap('#flipButton');
    assert.equal(await page.evaluate(() => Chartflip.app.snapshot().screen), 'running', 'Flip starts a ready run');
    await page.touchscreen.tap(420, 150);
    await page.waitForTimeout(60);
    assert.equal(await page.evaluate(() => Chartflip.app.snapshot().flips), 0, 'touching the chart does not flip');

    const boost = await page.locator('#boostButton').boundingBox();
    const flip = await page.locator('#flipButton').boundingBox();
    const b = { x: boost.x + boost.width / 2, y: boost.y + 35, id: 1 };
    const f = { x: flip.x + flip.width / 2, y: flip.y + 35, id: 2 };
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [b] });
    assert.equal(await page.locator('#boostButton').evaluate(el => el.classList.contains('down')), true, 'Boost holds');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [b, f] });
    await page.waitForFunction(() => Chartflip.app.snapshot().flips > 0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [f] });
    assert.equal(await page.locator('#boostButton').evaluate(el => el.classList.contains('down')), true, 'Flip release preserves Boost');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [b] });
    assert.equal(await page.locator('#boostButton').evaluate(el => el.classList.contains('down')), false, 'Boost releases');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#rotateScreen:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => Chartflip.app.snapshot().screen), 'paused', 'rotating portrait pauses the run');
    const tick = await page.evaluate(() => Chartflip.app.snapshot().tick);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => Chartflip.app.snapshot().tick), tick, 'portrait pause freezes the timer');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.getElementById('rotateScreen').hidden);
    assert.equal(await page.evaluate(() => Chartflip.app.snapshot().screen), 'paused', 'returning landscape stays paused');
    await page.tap('#resumeButton');
    assert.equal(await page.evaluate(() => Chartflip.app.snapshot().screen), 'running', 'resume works in landscape');
  } finally {
    await page.close();
  }
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log('SKIP: Playwright not found (set PLAYWRIGHT_MODULE to its path).');
    return;
  }
  let browser;
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      browser = await playwright.chromium.launch({ headless: true, channel });
      break;
    } catch (error) { /* try the next browser */ }
  }
  if (!browser) {
    console.log('SKIP: no Chromium-based browser could be launched.');
    return;
  }
  const errors = [];
  try {
    for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844], ['landscape', 844, 390], ['narrow', 568, 320]]) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: label !== 'desktop', isMobile: label !== 'desktop', locale: 'ko-KR' });
      await serve(context);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
      page.on('console', message => { if (message.type() === 'error') errors.push(`${label}: ${message.text()}`); });
      await page.goto(`${ORIGIN}/index.html`);
      await page.waitForFunction(() => window.Chartflip && window.Chartflip.app, null, { timeout: 15000 });
      assert.equal(await page.locator('.course').count(), 15, `${label}: fifteen course cards`);
      await shot(page, `${label}-menu`);
      if (label === 'landscape') await touchControls(context);

      await page.evaluate(installPilot);
      await page.click('.course[data-index="0"]');
      await page.reload();
      await page.waitForFunction(() => window.Chartflip?.app);
      assert.equal(await page.evaluate(() => Chartflip.app.snapshot().screen), 'ready', 'refresh keeps the selected stage');
      assert.equal(await page.evaluate(() => Chartflip.app.snapshot().course), 'practice');
      if (label === 'phone') {
        await page.locator('#rotateScreen:not([hidden])').waitFor();
        await shot(page, `${label}-rotate`);
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => Chartflip.app.snapshot().screen), 'ready', 'portrait does not start a run');
        await page.click('#rotateBack');
        assert.equal(await page.locator('#menu').isVisible(), true, 'rotation prompt can return to courses');
        await page.click('.course[data-index="0"]');
        await page.setViewportSize({ width: 844, height: 390 });
        await page.waitForFunction(() => document.getElementById('rotateScreen').hidden);
      }
      await page.evaluate(installPilot);
      // Ready screen: one compact card (course, start) above the key guide, and the cash wallet.
      const ready = await page.evaluate(() => {
        const box = id => document.getElementById(id).getBoundingClientRect();
        const apart = (a, b) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
        const inside = r => r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        const prompt = box('prompt'), keys = box('boostButton'), wallet = box('wallet');
        const flip = document.getElementById('flipButton');
        const flipBox = flip.offsetParent ? flip.getBoundingClientRect() : keys;
        return {
          shown: !document.getElementById('prompt').hidden && !document.getElementById('keys').hidden && !document.getElementById('wallet').hidden,
          inside: inside(prompt) && inside(keys) && inside(wallet) && inside(flipBox),
          apart: apart(prompt, keys) && apart(prompt, flipBox) && apart(prompt, wallet) && apart(wallet, keys) && apart(wallet, flipBox) && apart(wallet, box('minimap')),
          words: document.getElementById('prompt').innerText.trim().split(/\s+/).length
        };
      });
      assert.ok(ready.shown && ready.inside, `${label}: the start card, keys and wallet are on screen`);
      assert.ok(ready.apart, `${label}: the start card, keys, wallet and minimap do not overlap`);
      assert.ok(ready.words <= 12, `${label}: the start card stays short (${ready.words} words)`);
      await shot(page, `${label}-ready`);
      await page.keyboard.press('Space');
      await page.waitForTimeout(2500);
      assert.equal(await page.locator('#prompt').isVisible(), false, `${label}: the start card leaves when the run starts`);
      await noOverflow(page, label);
      await shot(page, `${label}-run`);
      await page.waitForFunction(() => window.Chartflip.app.snapshot().finishTime !== null, null, { timeout: 60000 });
      await page.locator('#resultScreen:not([hidden])').waitFor({ timeout: 5000 });
      const result = await page.evaluate(() => ({
        snap: window.Chartflip.app.snapshot(),
        shown: document.getElementById('resultTime').textContent,
        saved: JSON.parse(localStorage.getItem('chartflip.v1')).records.practice,
        recap: document.querySelectorAll('#resultRecap li').length,
        panel: document.querySelector('.panel.result').getBoundingClientRect().top
      }));
      assert.ok(result.snap.flips >= 5, `${label}: the pilot flipped at the bottoms`);
      assert.ok(result.snap.coins > 0, `${label}: coins were collected`);
      assert.ok(result.saved && Math.abs(result.saved.time - result.snap.score) < 1e-9, `${label}: record saved`);
      assert.ok(Math.abs(parseFloat(result.shown) - result.snap.score) < 0.006, `${label}: result shows the net time`);
      assert.ok(result.snap.boostTime > 0.5, `${label}: the pilot boosted (${result.snap.boostTime.toFixed(2)} s)`);
      assert.ok(result.snap.airBoostTime > 0, 'the pilot used boost during a jump');
      assert.equal(result.recap, 3, `${label}: the result shows three numbers`);
      assert.ok(result.panel >= 0, `${label}: the result panel starts on screen`);
      await shot(page, `${label}-result`);

      if (label === 'desktop') {
        await page.keyboard.press('KeyR');
        await page.waitForTimeout(4000);
        const split = await page.locator('#delta').textContent();
        assert.match(split, /^[+−]\d+\.\d\d$/, `ghost split appears on a retry as a signed time (${split})`);
        // Key caps mirror the held keys and never stay down after release or lost focus.
        const caps = () => page.evaluate(() => ['flipButton', 'boostButton'].map(id => document.getElementById(id).classList.contains('down')));
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true })));
        assert.deepEqual(await caps(), [false, true], 'holding a boost key presses the X cap');
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', bubbles: true })));
        assert.deepEqual(await caps(), [false, false], 'releasing the boost key lifts the X cap');
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true })));
        assert.deepEqual((await caps())[0], true, 'a flip key presses the SPACE cap');
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        assert.deepEqual(await caps(), [false, false], 'losing focus releases every cap');
        await page.click('#resumeButton');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#pauseScreen').isVisible(), true, 'Escape pauses');
        await page.click('#menuButton');
        await page.click('#langToggle');
        assert.equal(await page.locator('#tagline').textContent(), 'Flip at the bottom.', 'language toggle');
        await page.click('#helpButton');
        assert.equal(await page.locator('#helpSteps li').count(), 3, 'help shows three steps');
        await shot(page, `${label}-help`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('browser smoke: ok (desktop, phone, landscape, narrow landscape)');
}

module.exports = { loadPlaywright, serve, installPilot, shot, noOverflow, ORIGIN };

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
