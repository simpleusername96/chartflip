/* Chartflip app: screens, input, records, ghost and the fixed-step loop. */
(function (CF) {
  'use strict';

  const { buildCourse } = CF.terrain;
  const E = CF.engine;
  const { TEXT, formatTime, pickLanguage } = CF.i18n;
  const STEP = E.RULES.dt;
  const STORAGE_KEY = 'chartflip.v1';
  const FLIP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW', 'KeyF']);
  const BOOST_KEYS = new Set(['KeyX', 'ShiftLeft', 'ShiftRight', 'ArrowDown', 'KeyS']);
  const MEDAL_CLASS = ['gold', 'silver', 'bronze', 'none'];
  const MEDAL_EMOJI = [' 🥇', ' 🥈', ' 🥉', ''];
  const FULL_TIME = 1.2;
  const touchFirst = matchMedia('(hover: none)').matches;

  const $ = id => document.getElementById(id);
  const ui = {
    canvas: $('game'), hud: $('hud'), timer: $('timer'), delta: $('delta'), minimap: $('minimap'), backButton: $('backButton'),
    pauseButton: $('pauseButton'), boostButton: $('boostButton'), cashCount: $('cashCount'), boostName: $('boostName'),
    prompt: $('prompt'), promptCourse: $('promptCourse'), promptTitle: $('promptTitle'), flipKey: $('flipKey'), itemKey: $('itemKey'),
    flipLabel: $('flipLabel'), itemLabel: $('itemLabel'), hint: $('hint'), menu: $('menu'), tagline: $('tagline'), tally: $('tally'),
    courseList: $('courseList'), helpButton: $('helpButton'), guideToggle: $('guideToggle'), soundToggle: $('soundToggle'),
    langToggle: $('langToggle'), pauseScreen: $('pauseScreen'), pauseTitle: $('pauseTitle'), resumeButton: $('resumeButton'),
    restartButton: $('restartButton'), menuButton: $('menuButton'), pauseSound: $('pauseSound'), resultScreen: $('resultScreen'),
    resultMedal: $('resultMedal'), resultVerdict: $('resultVerdict'), resultTime: $('resultTime'), resultCompare: $('resultCompare'),
    resultTarget: $('resultTarget'), resultRecap: $('resultRecap'), retryButton: $('retryButton'), nextButton: $('nextButton'),
    coursesButton: $('coursesButton'), copyButton: $('copyButton'), helpScreen: $('helpScreen'), helpTitle: $('helpTitle'),
    helpSteps: $('helpSteps'), helpKeys: $('helpKeys'), helpClose: $('helpClose'), dataNote: $('dataNote'),
    toast: $('toast')
  };

  // ---------- storage (falls back to memory when blocked) ----------
  function loadSaved() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (data && typeof data === 'object') return { settings: data.settings || {}, records: data.records || {} };
    } catch (error) { /* private mode or corrupt data: play without saving */ }
    return { settings: {}, records: {} };
  }
  const saved = loadSaved();
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (error) { /* ignore */ }
  }

  const settings = {
    lang: pickLanguage(saved.settings.lang),
    sound: saved.settings.sound !== false,
    guide: Boolean(saved.settings.guide)
  };
  function saveSettings() {
    saved.settings = { ...settings };
    persist();
  }
  let text = TEXT[settings.lang];
  const t = (key, ...args) => {
    const value = text[key];
    return typeof value === 'function' ? value(...args) : value;
  };

  // ---------- courses and records ----------
  const built = new Map();
  const defs = CF.courses;
  function courseAt(index) {
    const def = defs[index];
    if (!built.has(def.id)) built.set(def.id, buildCourse(def));
    return built.get(def.id);
  }
  function hashText(source) {
    let value = 5381;
    for (let index = 0; index < source.length; index++) value = ((value * 33) ^ source.charCodeAt(index)) >>> 0;
    return value.toString(36);
  }
  /** Records only compare within the same rules, course shape and item layout. */
  function signature(course) {
    const def = course.def;
    return hashText(JSON.stringify([
      E.RULES.version, def.values || def.points, def.swing, def.leg, def.stretch, def.perDay, def.minRun, def.plateau,
      course.items.map(item => [item.type, Math.round(item.x), Math.round(item.lift)])
    ]));
  }
  function recordFor(course) {
    const record = saved.records[course.id];
    return record && record.sig === signature(course) && Number.isFinite(record.time) ? record : null;
  }
  /** Times are shown to 1/100 s, so medals and gaps are judged on the shown time: 11.30 s earns an 11.3 s gold. */
  const shownTime = time => Math.round(time * 100) / 100;
  function medalFor(def, time) {
    const index = def.medals.findIndex(limit => shownTime(time) <= limit + 1e-9);
    return index < 0 ? 3 : index;
  }
  const name = def => def.name[settings.lang] || def.name.en;

  // ---------- app state ----------
  const app = {
    screen: 'menu',
    index: 0,
    run: null,
    pending: 0,
    boostHeld: false,
    accumulator: 0,
    alpha: 1,
    ghost: null,
    ghosts: new Map(),
    finishTimer: 0,
    previousBest: null,
    result: null,
    demo: null,
    demoIndex: 0,
    pausedFrame: false,
    fullNote: 0
  };

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new CF.render.Renderer(ui.canvas, { reducedMotion, text: t });
  const sound = new CF.audio.Sound();
  sound.setMuted(!settings.sound);

  function show(element, visible) {
    if (element.hidden === !visible) return;
    element.hidden = !visible;
  }

  let toastTimer = 0;
  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1400);
  }

  /** Paint a sprite into a small canvas (result recap). */
  function paintIcon(canvas, sprite, size = canvas.clientWidth || 22) {
    const pixels = Math.round(size * Math.min(window.devicePixelRatio || 1, 2));
    if (canvas.width !== pixels || canvas.height !== pixels) {
      canvas.width = pixels;
      canvas.height = pixels;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, pixels, pixels);
    ctx.drawImage(CF.render.getSprites()[sprite], 0, 0, pixels, pixels);
  }

  function icon(sprite, size) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    paintIcon(canvas, sprite, size);
    return canvas;
  }

  // ---------- ghost: the personal best, re-simulated once from its recorded input ----------
  function buildGhost(course, record) {
    if (!record || !Array.isArray(record.flips)) return null;
    const cached = app.ghosts.get(course.id);
    if (cached && cached.record === record) return cached.ghost;
    const run = E.createRun(course);
    E.start(run);
    const xs = [];
    const heights = [];
    const angles = [];
    const grounded = [];
    const next = E.inputs(record.flips, record.boosts || []);
    let settle = 0;
    while (run.tick < 600 / STEP && settle < 240) {
      E.step(run, next(run.tick));
      run.events.length = 0;
      xs.push(run.x);
      heights.push(run.y - run.rules.radius - E.heightAt(run, run.x));
      angles.push(Math.max(-0.9, Math.min(0.9, Math.atan2(run.vy, Math.max(1, run.vx)) * 0.65)));
      grounded.push(run.grounded);
      if (run.status === 'finished') settle += 1;
    }
    const ghost = run.finishTime !== null && Math.abs(E.score(run) - record.time) < 0.02
      ? { xs: Float64Array.from(xs), heights: Float64Array.from(heights), angles: Float64Array.from(angles), grounded }
      : null;
    app.ghosts.set(course.id, { record, ghost });
    return ghost;
  }

  function ghostPose() {
    const ghost = app.ghost;
    const run = app.run;
    if (!ghost || !run || app.screen === 'ready') return null;
    const last = ghost.xs.length - 1;
    const index = Math.min(last, Math.max(0, run.tick - 1));
    const before = Math.max(0, index - 1);
    const a = app.alpha;
    return {
      x: ghost.xs[before] + (ghost.xs[index] - ghost.xs[before]) * a,
      height: ghost.heights[before] + (ghost.heights[index] - ghost.heights[before]) * a,
      angle: ghost.angles[index],
      grounded: ghost.grounded[index]
    };
  }

  /** The ghost's riding time when it reached x (xs[i] is its position after tick i + 1). */
  function ghostScoreAt(x) {
    const xs = app.ghost.xs;
    if (x <= xs[0]) return STEP;
    let low = 0;
    let high = xs.length - 1;
    if (x >= xs[high]) return xs.length * STEP;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (xs[middle] < x) low = middle + 1;
      else high = middle;
    }
    const before = low ? xs[low - 1] : xs[0];
    const fraction = xs[low] > before ? (x - before) / (xs[low] - before) : 1;
    return (low + fraction) * STEP;
  }

  // ---------- attract mode: a pilot rides behind the menu ----------
  function pilot(run, memory) {
    if (!memory.target || memory.sign !== run.sign) {
      memory.target = E.nextLow(run, run.x - 1);
      memory.sign = run.sign;
      memory.jitter = (Math.random() - 0.35) * 0.05;
    }
    if (memory.target && run.x >= memory.target.x + memory.jitter * Math.max(250, run.vx)) {
      memory.target = null;
      return true;
    }
    return false;
  }

  /** The pilot boosts on the ground whenever it has cash. */
  const pilotBoost = run => run.grounded && run.cash > 0;

  function startDemo() {
    const course = courseAt(app.demoIndex % defs.length);
    const run = E.createRun(course);
    E.start(run);
    app.demo = { run, memory: {}, accumulator: 0, input: { flip: false, boost: false } };
    renderer.reset(run);
  }

  function stepDemo(dt) {
    const demo = app.demo;
    demo.accumulator += dt;
    while (demo.accumulator >= STEP) {
      const running = demo.run.status === 'running';
      demo.input.flip = running && pilot(demo.run, demo.memory);
      demo.input.boost = running && pilotBoost(demo.run);
      E.step(demo.run, demo.input);
      demo.accumulator -= STEP;
    }
    app.alpha = demo.accumulator / STEP;
    renderer.consume(demo.run, demo.run.events);
    demo.run.events.length = 0;
    if (demo.run.status === 'finished' && demo.run.x > demo.run.course.finishX + 1500) {
      app.demoIndex += 1;
      startDemo();
    }
  }

  // ---------- screens ----------
  function hideOverlays() {
    for (const element of [ui.menu, ui.pauseScreen, ui.resultScreen, ui.helpScreen, ui.prompt, ui.hint]) show(element, false);
  }

  function showMenu() {
    app.screen = 'menu';
    sound.setMusic('menu');
    app.run = null;
    app.ghost = null;
    hideOverlays();
    show(ui.hud, false);
    show(ui.boostButton, false);
    renderCourses();
    show(ui.menu, true);
    startDemo();
    const card = ui.courseList.querySelector(`[data-index="${app.index}"]`);
    if (card) card.focus({ preventScroll: true });
  }

  function openCourse(index) {
    app.index = index;
    const course = courseAt(index);
    app.run = E.createRun(course);
    app.pending = 0;
    app.boostHeld = false;
    app.accumulator = 0;
    app.alpha = 1;
    app.finishTimer = 0;
    app.fullNote = 0;
    app.previousBest = recordFor(course);
    app.ghost = buildGhost(course, app.previousBest);
    renderer.reset(app.run);
    hideOverlays();
    show(ui.hud, true);
    show(ui.boostButton, true);
    measureMinimap();
    ui.promptCourse.textContent = `${name(course.def)} · ${t('goldTarget', course.def.medals[0])}`;
    show(ui.prompt, true);
    app.screen = 'ready';
    sound.setMusic('ready');
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }

  function startRun() {
    if (app.screen !== 'ready') return;
    sound.unlock();
    sound.start();
    E.start(app.run);
    app.screen = 'running';
    sound.setMusic('run');
    app.accumulator = 0;
    show(ui.prompt, false);
  }

  function restart() {
    if (!app.run) return;
    sound.unlock();
    openCourse(app.index);
    startRun();
  }

  function action() {
    if (app.screen === 'ready') startRun();
    else if (app.screen === 'running' && app.run.status === 'running') app.pending = Math.min(app.pending + 1, 2);
  }

  /** BOOST is held while a key or the button is down; the engine burns cash each tick it is held. */
  function setBoost(held) {
    if (held && app.screen === 'ready') startRun();
    app.boostHeld = held && (app.screen === 'running' || app.screen === 'ready');
    ui.boostButton.classList.toggle('held', app.boostHeld);
  }

  function pause() {
    if (app.screen !== 'running') return;
    app.screen = 'paused';
    sound.setMusic('pause');
    app.pausedFrame = false;
    show(ui.hint, false);
    show(ui.pauseScreen, true);
    ui.resumeButton.focus();
  }

  function resume() {
    if (app.screen !== 'paused') return;
    show(ui.pauseScreen, false);
    app.screen = 'running';
    sound.setMusic('run');
    app.accumulator = 0;
    app.pending = 0;
    setBoost(false);
    if (document.activeElement) document.activeElement.blur();
  }

  function onFinish() {
    const run = app.run;
    const course = run.course;
    const def = course.def;
    const time = E.score(run);
    const medal = medalFor(def, time);
    const previous = app.previousBest;
    const best = !previous || time < previous.time - 1e-9;
    if (best) {
      saved.records[def.id] = {
        time, raw: run.finishTime, flips: run.flipTicks.slice(), boosts: run.boostTicks.slice(), sig: signature(course), medal, at: Date.now()
      };
    }
    sound.finish(medal < 3 ? medal : -1);
    app.screen = 'finished';
    sound.setMusic('finish');
    app.finishTimer = 0.9;
    app.result = { time, medal, best, previous, stats: { ...run.stats }, coins: run.items.length };
  }

  function showResult() {
    // Saved here rather than at the finish line: a synchronous storage write must not hitch the finish.
    persist();
    sound.setMusic('result');
    const result = app.result;
    const def = app.run.course.def;
    ui.resultMedal.className = `medal ${MEDAL_CLASS[result.medal]}`;
    ui.resultMedal.textContent = result.medal < 3 ? String(result.medal + 1) : '–';
    ui.resultMedal.setAttribute('aria-label', t('medal')[result.medal]);
    ui.resultVerdict.textContent = t('verdict')[result.medal];
    ui.resultTime.textContent = `${formatTime(result.time)}${t('seconds')}`;
    // Gaps are between shown times, so they always match the numbers on screen.
    const gain = result.previous ? shownTime(result.previous.time) - shownTime(result.time) : 0;
    if (result.best && gain >= 0.005) ui.resultCompare.textContent = `${t('newBest')} −${gain.toFixed(2)}`;
    else if (result.best) ui.resultCompare.textContent = t('newBest');
    else ui.resultCompare.textContent = t('vsBest', `+${(-gain).toFixed(2)}`);
    ui.resultCompare.classList.toggle('good', result.best);
    const goal = result.medal > 0 ? result.medal - 1 : -1;
    ui.resultTarget.textContent = goal >= 0 ? t('toMedal', goal, (shownTime(result.time) - def.medals[goal]).toFixed(2)) : '';
    // Three numbers, icons instead of labels: perfect flips, coins taken, seconds of boost.
    const stats = result.stats;
    ui.resultRecap.innerHTML = '';
    for (const [mark, value, label] of [
      ['⇅', `${stats.perfect}/${stats.flips}`, t('perfect')],
      ['coin', `${stats.coins}/${result.coins}`, t('coins')],
      ['🔥', `${stats.boostTime.toFixed(1)}${t('seconds')}`, t('boost')]
    ]) {
      const item = document.createElement('li');
      if (mark === 'coin') item.append(icon(mark, 26));
      else {
        const glyph = document.createElement('span');
        glyph.className = 'flipmark';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = mark;
        item.append(glyph);
      }
      const hidden = document.createElement('span');
      hidden.className = 'sr';
      hidden.textContent = `${label} `;
      item.append(hidden, value);
      ui.resultRecap.append(item);
    }
    show(ui.nextButton, app.index < defs.length - 1);
    show(ui.hint, false);
    show(ui.boostButton, false);
    setBoost(false);
    show(ui.resultScreen, true);
    ui.retryButton.focus();
  }

  function next() {
    if (app.index < defs.length - 1) openCourse(app.index + 1);
    else showMenu();
  }

  async function copyResult() {
    const result = app.result;
    const def = app.run.course.def;
    const line = t('shareLine', name(def), formatTime(result.time), MEDAL_EMOJI[result.medal]);
    try {
      await navigator.clipboard.writeText(line);
      toast(t('copied'));
    } catch (error) {
      const area = document.createElement('textarea');
      area.value = line;
      document.body.append(area);
      area.select();
      const ok = document.execCommand && document.execCommand('copy');
      area.remove();
      toast(ok ? t('copied') : t('copyFailed'));
    }
  }

  function toggleSound() {
    settings.sound = !settings.sound;
    sound.unlock();
    sound.setMuted(!settings.sound);
    saveSettings();
    applyText();
    toast(t(settings.sound ? 'soundOn' : 'soundOff'));
  }

  function toggleGuide() {
    settings.guide = !settings.guide;
    saveSettings();
    applyText();
    toast(t(settings.guide ? 'guideOn' : 'guideOff'));
  }

  function toggleLanguage() {
    settings.lang = settings.lang === 'ko' ? 'en' : 'ko';
    text = TEXT[settings.lang];
    saveSettings();
    applyText();
    renderer.warm(gameTexts());
    renderCourses();
  }

  function openHelp() {
    show(ui.helpScreen, true);
    ui.helpClose.focus();
  }

  function closeHelp() {
    show(ui.helpScreen, false);
    ui.helpButton.focus();
  }

  // ---------- text and course list ----------
  function applyText() {
    document.documentElement.lang = settings.lang;
    ui.canvas.setAttribute('aria-label', t('canvas'));
    ui.tagline.textContent = t('tagline');
    ui.helpButton.setAttribute('aria-label', t('help'));
    ui.helpButton.title = t('help');
    ui.guideToggle.setAttribute('aria-label', t('guide'));
    ui.guideToggle.title = t('guide');
    ui.guideToggle.setAttribute('aria-pressed', String(settings.guide));
    for (const button of [ui.soundToggle, ui.pauseSound]) {
      button.setAttribute('aria-label', t('sound'));
      button.title = t(settings.sound ? 'soundOn' : 'soundOff');
      button.classList.toggle('muted', !settings.sound);
    }
    ui.langToggle.textContent = t('language');
    ui.langToggle.setAttribute('aria-label', t('languageName'));
    ui.langToggle.title = t('languageName');
    ui.promptTitle.textContent = t(touchFirst ? 'tapToStart' : 'keyToStart');
    ui.flipKey.textContent = touchFirst ? '👆' : 'Space';
    ui.itemKey.textContent = touchFirst ? '◉' : 'X';
    ui.itemLabel.textContent = `${t('hold')} ${t('boost')}`;
    ui.flipLabel.textContent = t('flip');
    ui.pauseTitle.textContent = t('paused');
    ui.resumeButton.textContent = t('resume');
    ui.restartButton.textContent = t('restart');
    ui.menuButton.textContent = t('courses');
    ui.retryButton.textContent = touchFirst ? `↻ ${t('retry')}` : `↻ ${t('retry')} (R)`;
    ui.nextButton.textContent = `${t('next')} →`;
    ui.coursesButton.textContent = t('courses');
    ui.copyButton.setAttribute('aria-label', t('copy'));
    ui.copyButton.title = t('copy');
    ui.helpTitle.textContent = t('help');
    ui.helpSteps.innerHTML = '';
    const stepIcons = ['⇅', '₩', '🔥'];
    t('helpSteps').forEach(([title, line], index) => {
      const item = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'num';
      mark.textContent = stepIcons[index];
      const strong = document.createElement('b');
      strong.textContent = title;
      const span = document.createElement('span');
      span.textContent = line;
      item.append(mark, strong, span);
      ui.helpSteps.append(item);
    });
    ui.helpKeys.textContent = touchFirst ? '' : t('keys');
    ui.helpClose.textContent = t('close');
    ui.dataNote.textContent = t('dataNote');
    ui.backButton.setAttribute('aria-label', t('back'));
    ui.pauseButton.setAttribute('aria-label', t('pause'));
    ui.boostButton.setAttribute('aria-label', t('boostButton'));
    ui.boostName.textContent = t('full');
    if (app.run) ui.promptCourse.textContent = `${name(app.run.course.def)} · ${t('goldTarget', app.run.course.def.medals[0])}`;
    shown.boost = undefined;
  }

  /** Course card sparkline: the chart body as an SVG polyline (crisp at any size, no redraws). */
  function sparkline(def) {
    const ns = 'http://www.w3.org/2000/svg';
    const course = courseAt(defs.indexOf(def));
    const samples = 120;
    const values = [];
    for (let index = 0; index <= samples; index++) values.push(course.terrain.height(course.finishX * index / samples));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 200 44');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const points = values.map((value, index) => `${(4 + 192 * index / samples).toFixed(1)},${(38 - 30 * (value - min) / (max - min || 1)).toFixed(1)}`).join(' ');
    // Stock-app look: a soft area under the line.
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('points', `4,44 ${points} 196,44`);
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', points);
    svg.append(area, line);
    return svg;
  }

  function renderTally() {
    const counts = [0, 0, 0];
    defs.forEach((def, index) => {
      const record = recordFor(courseAt(index));
      if (record) {
        const medal = medalFor(def, record.time);
        if (medal < 3) counts[medal] += 1;
      }
    });
    ui.tally.innerHTML = '';
    counts.forEach((count, index) => {
      const item = document.createElement('span');
      item.innerHTML = `<i class="dot ${MEDAL_CLASS[index]}"></i>`;
      item.append(`${count}/${defs.length}`);
      item.setAttribute('aria-label', `${t('medal')[index]} ${count}/${defs.length}`);
      ui.tally.append(item);
    });
    show(ui.tally, counts.some(Boolean));
  }

  function renderCourses() {
    renderTally();
    ui.courseList.innerHTML = '';
    defs.forEach((def, index) => {
      const record = recordFor(courseAt(index));
      const medal = record ? medalFor(def, record.time) : 3;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'course';
      card.dataset.index = String(index);
      const title = document.createElement('span');
      title.className = 'course-title';
      const number = document.createElement('i');
      number.className = 'num';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = def.kind === 'authored' ? '★' : String(index);
      const label = document.createElement('b');
      label.textContent = name(def);
      title.append(number, label);
      const foot = document.createElement('div');
      foot.className = 'course-foot';
      const best = document.createElement('span');
      best.className = record ? 'best' : 'best empty';
      best.innerHTML = `<i class="dot ${MEDAL_CLASS[medal]}"></i><span></span>`;
      // No record yet: an empty medal dot and a dash, no words.
      best.querySelector('span').textContent = record ? `${formatTime(record.time)}${t('seconds')}` : '–';
      if (!record) best.setAttribute('aria-label', t('noRecord'));
      const goal = document.createElement('span');
      goal.className = 'goal';
      goal.innerHTML = '<i class="dot gold"></i><span></span>';
      goal.lastChild.textContent = `${def.medals[0]}${t('seconds')}`;
      goal.setAttribute('aria-label', t('goldTarget', def.medals[0]));
      foot.append(best, goal);
      card.append(sparkline(def), title, foot);
      if (def.kind === 'authored') {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = t('tutorial');
        card.append(tag);
      }
      card.addEventListener('click', () => {
        sound.unlock();
        sound.click();
        openCourse(index);
      });
      ui.courseList.append(card);
    });
  }

  // ---------- HUD ----------
  /** The published chart, drawn once per course and size; each frame only stamps it and the dots. */
  function minimapLayers(course, width, height, ratio) {
    const key = `${course.id}:${width}:${height}:${ratio}`;
    if (drawMinimap.cache && drawMinimap.cache.key === key) return drawMinimap.cache;
    const left = course.startX;
    const right = course.finishX;
    const values = [];
    for (let index = 0; index <= 140; index++) values.push(course.terrain.height(left + (right - left) * index / 140));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const py = h => 4 + (height - 8) * (1 - (h - min) / (max - min || 1));
    const layer = color => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      values.forEach((value, index) => {
        const x = 3 + (width - 6) * index / 140;
        if (index) ctx.lineTo(x, py(value));
        else ctx.moveTo(x, py(value));
      });
      ctx.stroke();
      return canvas;
    };
    drawMinimap.cache = { key, left, right, py, dim: layer('rgba(255,255,255,0.35)'), 1: layer(CF.render.LINE[1]), '-1': layer(CF.render.LINE[-1]) };
    return drawMinimap.cache;
  }

  /** The minimap's CSS size, measured only when the layout may have changed (never mid-frame,
   * where reading it right after the timer text changes would force a layout every frame). */
  const minimapBox = { width: 0, height: 0, ratio: 1 };
  function measureMinimap() {
    minimapBox.width = ui.minimap.clientWidth;
    minimapBox.height = ui.minimap.clientHeight;
    minimapBox.ratio = Math.min(window.devicePixelRatio || 1, 2);
    minimapDrawn.key = -1;
  }
  /** What the minimap last showed, in half pixels; it is redrawn only when that changes. */
  const minimapDrawn = { key: -1 };

  function drawMinimap(run) {
    const canvas = ui.minimap;
    const { width, height, ratio } = minimapBox;
    if (!width || !height) return;
    const layers = minimapLayers(run.course, width, height, ratio);
    const px = x => 3 + (width - 6) * Math.min(1, Math.max(0, (x - layers.left) / (layers.right - layers.left)));
    const split = px(run.x);
    const ghost = ghostPose();
    const key = Math.round(split * 2) * 4096 + (ghost ? Math.round(px(ghost.x) * 2) + 1 : 0) + (run.sign > 0 ? 0.5 : 0);
    if (key === minimapDrawn.key && minimapDrawn.course === run.course) return;
    minimapDrawn.key = key;
    minimapDrawn.course = run.course;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(layers.dim, 0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, split, height);
    ctx.clip();
    ctx.drawImage(layers[run.sign], 0, 0, width, height);
    ctx.restore();
    const terrain = run.course.terrain;
    if (ghost) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(ghost.x), layers.py(terrain.height(Math.min(layers.right, ghost.x))), 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(split, layers.py(terrain.height(Math.min(layers.right, Math.max(layers.left, run.x)))), 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const shown = {};
  function setText(element, key, value) {
    if (shown[key] === value) return;
    shown[key] = value;
    element.textContent = value;
  }

  /** The boost button is the cash gauge: gold ring up to the cash level, flame colours while held. */
  function updateBoost(run) {
    const rules = run.rules;
    // Half-coin steps: the ring moves smoothly enough, and the button restyles 20 times a second at most.
    const state = Math.round(run.cash * 2) * 4 + (run.boosting ? (run.grounded ? 1 : 2) : 0);
    if (shown.boost !== state) {
      shown.boost = state;
      ui.boostButton.style.setProperty('--fill', (run.cash / rules.cashMax).toFixed(3));
      ui.boostButton.classList.toggle('on', run.boosting && run.grounded);
      ui.boostButton.classList.toggle('spin', run.boosting && !run.grounded);
      ui.boostButton.classList.toggle('full', run.cash >= rules.cashMax - 1e-9);
      ui.boostButton.classList.toggle('empty', run.cash <= 0);
      ui.cashCount.textContent = String(Math.ceil(run.cash - 1e-9));
    }
    ui.boostName.classList.toggle('show', app.fullNote > 0);
  }

  function updateHud() {
    const run = app.run;
    if (!run || ui.hud.hidden) return;
    const elapsed = run.status === 'ready' ? 0 : E.score(run);
    setText(ui.timer, 'timer', formatTime(Math.max(0, elapsed)));
    const course = run.course;
    let delta = '';
    if (app.ghost && run.status !== 'ready' && run.x > course.startX + 600) {
      const value = elapsed - ghostScoreAt(Math.min(run.x, course.finishX));
      delta = `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
      ui.delta.classList.toggle('ahead', value < 0);
    }
    setText(ui.delta, 'delta', delta);
    updateBoost(run);
    drawMinimap(run);
    const crawling = app.screen === 'running' && run.crawlTime > 0.6;
    if (crawling !== !ui.hint.hidden) {
      ui.hint.textContent = t('crawlHint');
      show(ui.hint, crawling);
    }
  }

  // ---------- loop ----------
  const input = { flip: false, boost: false };
  function stepRun(dt) {
    const run = app.run;
    app.accumulator = Math.min(app.accumulator + dt, 0.25);
    while (app.accumulator >= STEP) {
      const running = run.status === 'running';
      input.flip = app.pending > 0 && running;
      if (input.flip) app.pending -= 1;
      input.boost = app.boostHeld && running;
      E.step(run, input);
      app.accumulator -= STEP;
    }
    app.alpha = app.accumulator / STEP;
    const events = run.events;
    if (events.length) {
      renderer.consume(run, events);
      for (const event of events) {
        if (event.type === 'flip') sound.flip(event.quality, event.streak);
        else if (event.type === 'land') sound.land(event.quality, event.speed);
        else if (event.type === 'item') {
          sound.coin(event.full);
          if (event.full) app.fullNote = FULL_TIME;
        } else if (event.type === 'boost') sound.boost();
        else if (event.type === 'finish') onFinish();
      }
      events.length = 0;
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (app.screen === 'menu') stepDemo(dt);
    else if (app.screen === 'running' || app.screen === 'finished') stepRun(dt);
    if (app.screen === 'finished' && app.finishTimer > 0) {
      app.finishTimer -= dt;
      if (app.finishTimer <= 0) showResult();
    }
    if (app.fullNote > 0 && app.screen !== 'paused') app.fullNote = Math.max(0, app.fullNote - dt);
    const run = app.screen === 'menu' ? app.demo && app.demo.run : app.run;
    // A paused game shows its last frame; redrawing it every frame only costs battery.
    const frozen = app.screen === 'paused' && app.pausedFrame;
    if (run && !frozen) {
      if (app.screen !== 'paused') renderer.update(dt, run, app.alpha);
      else app.pausedFrame = true;
      renderer.draw(run, {
        lang: settings.lang,
        guide: app.screen !== 'menu' && (settings.guide || run.course.guide),
        ghost: app.screen === 'menu' ? null : ghostPose()
      });
    }
    if (!frozen) updateHud();
    sound.motion(run ? Math.hypot(run.vx, run.vy) : 0, app.screen === 'running', Boolean(run && run.boosting && run.grounded));
    requestAnimationFrame(frame);
  }

  // ---------- input ----------
  // Anywhere on the game flips; holding the boost button (bottom right) burns cash for speed.
  ui.canvas.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    event.preventDefault();
    action();
  });
  for (const element of [ui.prompt, ui.hint]) {
    element.addEventListener('pointerdown', event => {
      event.preventDefault();
      action();
    });
  }
  ui.boostButton.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    ui.boostButton.setPointerCapture(event.pointerId);
    setBoost(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.boostButton.addEventListener(type, () => setBoost(false));
  ui.boostButton.addEventListener('contextmenu', event => event.preventDefault());

  document.addEventListener('keydown', event => {
    const inRun = app.screen === 'ready' || app.screen === 'running';
    if (FLIP_KEYS.has(event.code) && inRun) {
      event.preventDefault();
      if (!event.repeat) action();
      return;
    }
    if (BOOST_KEYS.has(event.code) && inRun) {
      event.preventDefault();
      if (!event.repeat) setBoost(true);
      return;
    }
    if (event.repeat) return;
    if (event.code === 'Enter' && app.screen === 'ready') {
      event.preventDefault();
      startRun();
    } else if (event.code === 'KeyR' && app.run && app.screen !== 'menu') {
      event.preventDefault();
      restart();
    } else if (event.code === 'Escape' || event.code === 'KeyP') {
      if (!ui.helpScreen.hidden) closeHelp();
      else if (app.screen === 'running') pause();
      else if (app.screen === 'paused') resume();
      else if (event.code === 'Escape' && (app.screen === 'ready' || (app.screen === 'finished' && !ui.resultScreen.hidden))) showMenu();
    } else if (event.code === 'KeyM') {
      toggleSound();
    }
  });

  ui.backButton.addEventListener('click', () => showMenu());
  ui.pauseButton.addEventListener('click', () => (app.screen === 'paused' ? resume() : pause()));
  ui.resumeButton.addEventListener('click', resume);
  ui.restartButton.addEventListener('click', restart);
  ui.menuButton.addEventListener('click', showMenu);
  ui.pauseSound.addEventListener('click', toggleSound);
  ui.retryButton.addEventListener('click', restart);
  ui.nextButton.addEventListener('click', next);
  ui.coursesButton.addEventListener('click', showMenu);
  ui.copyButton.addEventListener('click', copyResult);
  ui.helpButton.addEventListener('click', openHelp);
  ui.helpClose.addEventListener('click', closeHelp);
  ui.guideToggle.addEventListener('click', toggleGuide);
  ui.soundToggle.addEventListener('click', toggleSound);
  ui.langToggle.addEventListener('click', toggleLanguage);

  // iOS unlocks audio only inside certain gestures; unlocking is idempotent.
  for (const type of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(type, () => sound.unlock(), { passive: true });

  document.addEventListener('keyup', event => {
    if (BOOST_KEYS.has(event.code)) setBoost(false);
  });

  window.addEventListener('blur', () => {
    setBoost(false);
    pause();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  window.addEventListener('resize', () => {
    renderer.resize();
    if (!ui.hud.hidden) measureMinimap();
    app.pausedFrame = false;
  });

  /** Every string the canvas may draw during a run, for the renderer's glyph warm-up. */
  function gameTexts() {
    const keys = ['perfect', 'good', 'clean', 'ouch', 'office', 'finishGate', 'ghost'];
    const texts = keys.map(key => t(key)).concat(['×0123456789 −+.⇅']);
    for (const def of defs) for (const sign of def.signs || []) texts.push(sign.text[settings.lang] || sign.text.en);
    return texts.filter(Boolean);
  }

  applyText();
  renderer.warm(gameTexts());
  showMenu();
  requestAnimationFrame(frame);

  /** Read-only observation hook for automated checks. */
  CF.app = {
    snapshot: () => {
      const run = app.run || (app.demo && app.demo.run);
      return run && {
        screen: app.screen, course: run.course.id, status: run.status, x: run.x, y: run.y, sign: run.sign, grounded: run.grounded,
        speed: Math.hypot(run.vx, run.vy), tick: run.tick, time: E.elapsed(run), score: E.score(run),
        flips: run.stats.flips, coins: run.stats.coins, cash: run.cash, boosting: run.boosting, boostTime: run.stats.boostTime,
        finishTime: run.finishTime
      };
    }
  };
})(globalThis.Chartflip = globalThis.Chartflip || {});
