/* Chartflip renderer: Canvas 2D scene. Reads engine state; never changes it.
 * Motion is interpolated between fixed simulation ticks, so any display rate looks smooth. */
(function (CF) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const hash = value => {
    const s = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const alpha = (hex, value) => {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${value})`;
  };

  /** Afternoon to after-hours: the sky darkens as the rider approaches the closing bell. */
  const SKY = [
    { at: 0, top: '#78bdfb', bottom: '#e8f5ff', far: '#9cc3e6', near: '#7aa3cc', sun: '#fff3c4' },
    { at: 0.55, top: '#ff8a6b', bottom: '#ffe0a3', far: '#d98c86', near: '#b86f78', sun: '#ffd07a' },
    { at: 1, top: '#1f2356', bottom: '#f39a73', far: '#4a3f73', near: '#352f5e', sun: '#ff7659' }
  ].map(frame => ({ at: frame.at, ...Object.fromEntries(['top', 'bottom', 'far', 'near', 'sun'].map(key => [key, rgb(frame[key])])) }));
  const skyCache = new Map();

  function skyAt(progress) {
    const bucket = Math.round(clamp(progress, 0, 1) * 200);
    if (skyCache.has(bucket)) return skyCache.get(bucket);
    const p = bucket / 200;
    let index = 0;
    while (index < SKY.length - 2 && p > SKY[index + 1].at) index++;
    const a = SKY[index];
    const b = SKY[index + 1];
    const t = clamp((p - a.at) / (b.at - a.at), 0, 1);
    const out = { night: clamp((p - 0.45) / 0.55, 0, 1) };
    for (const key of ['top', 'bottom', 'far', 'near', 'sun']) out[key] = `rgb(${a[key].map((channel, i) => Math.round(mix(channel, b[key][i], t))).join(',')})`;
    skyCache.set(bucket, out);
    return out;
  }

  const LINE = { 1: '#ff4d5e', '-1': '#3d7bff' };
  const INK = '#10132b';
  /** Sticker outline shared by the rider, coins, landmarks and popups (matches the interface). */
  const OUTLINE = '#1b1f46';
  const RIDER = {
    ant: '#4a2c1d', shirt: '#ffffff', seat: '#3d4680', back: '#4b56a0', metal: '#b3bbcd', wheel: '#23263a',
    hub: '#c9cfdd', cup: '#ffffff', lid: '#9b6440', sleeve: '#ffd23f', eye: '#ffffff', pupil: '#10132b', cheek: '#ff8f8f',
    badge: '#ffd23f', outline: OUTLINE
  };
  const ANTENNAE = [[7, -0.2], [12, 0.25]];
  const CASTERS = [-14, 14];
  const GHOST_RIDER = Object.fromEntries(Object.keys(RIDER).map(key => [key, '#ffffff']));
  /** [parallax, slot, scale, sky band, seed] */
  const CLOUD_LAYERS = [[0.012, 420, 0.8, 0.06, 3], [0.03, 560, 1.1, 0.13, 7]];
  const LAYERS = [
    { parallax: 0.06, slot: 74, base: 0.64, min: 0.1, max: 0.3, color: 'far', seed: 11 },
    { parallax: 0.14, slot: 104, base: 0.72, min: 0.12, max: 0.36, color: 'near', seed: 29 }
  ];

  /** Canvas backing store budget: very large or very dense screens render slightly below native ratio. */
  const MAX_PIXELS = 3.2e6;
  /** Screen pixels between terrain line samples. */
  const LINE_STEP = 8;
  const shade = (hex, over, amount) => {
    const a = rgb(hex);
    const b = rgb(over);
    return `rgb(${a.map((channel, index) => Math.round(mix(b[index], channel, amount))).join(',')})`;
  };
  /** Terrain colours per orientation, precomputed so a frame builds no colour strings. */
  const TERRAIN = {
    1: { line: LINE[1], glow: alpha(LINE[1], 0.22), top: shade(LINE[1], '#1d2146', 0.32), body: shade('#1d2146', INK, 0.6) },
    '-1': { line: LINE[-1], glow: alpha(LINE[-1], 0.22), top: shade(LINE[-1], '#162246', 0.32), body: shade('#162246', INK, 0.6) }
  };

  /** First index whose x is at least x (items and candles are sorted by x). */
  function lowerBound(list, x) {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle].x < x) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Which two sky keyframes a progress value sits between, and how far. */
  const blend = { index: 0, t: 0 };
  function skyBlend(progress) {
    const p = clamp(progress, 0, 1);
    blend.index = p > SKY[1].at ? 1 : 0;
    blend.t = clamp((p - SKY[blend.index].at) / (SKY[blend.index + 1].at - SKY[blend.index].at), 0, 1);
    return blend;
  }

  /** Buildings per baked strip; the skyline repeats after this many. */
  const STRIP_SLOTS = 24;

  /** Bake each skyline layer once per screen height: one repeating strip per sky keyframe, with
   * pale day windows, fading at dusk, and warm lit windows at night. */
  function bakeSkyline(screenHeight, scale) {
    return LAYERS.map(layer => {
      const period = STRIP_SLOTS * layer.slot;
      const height = Math.ceil(screenHeight * layer.max + 34);
      const keys = SKY.map((frame, key) => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(period * scale);
        canvas.height = Math.ceil(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.beginPath();
        for (let index = 0; index < STRIP_SLOTS; index++) {
          const width = layer.slot * (0.62 + hash(index + layer.seed) * 0.34);
          const tall = screenHeight * mix(layer.min, layer.max, hash(index * 1.7 + layer.seed));
          const x = index * layer.slot;
          const top = height - tall;
          ctx.rect(x, top, width, tall + 1);
          // Rooftops: flat, a setback, an antenna, a peaked roof or a water tank.
          const roof = hash(index * 5.3 + layer.seed);
          if (roof > 0.9) {
            ctx.rect(x + width * 0.3, top - 16, width * 0.26, 10);
            ctx.rect(x + width * 0.32, top - 6, 2, 6);
            ctx.rect(x + width * 0.52, top - 6, 2, 6);
          } else if (roof > 0.78) {
            ctx.moveTo(x, top);
            ctx.lineTo(x + width / 2, top - width * 0.28);
            ctx.lineTo(x + width, top);
            ctx.closePath();
          } else if (roof > 0.62) {
            ctx.rect(x + width * 0.45, top - 18, 2.5, 18);
          } else if (roof > 0.42) {
            ctx.rect(x + width * 0.18, top - tall * 0.08, width * 0.64, tall * 0.08 + 1);
          }
        }
        ctx.fillStyle = `rgb(${frame[layer.color].join(',')})`;
        ctx.fill();
        const day = [1, 0.8, 0][key] * (layer.color === 'near' ? 0.3 : 0.18);
        const lit = [0, 0.2, 1][key];
        for (const [amount, color] of [[day, 'rgba(255,255,255,0.55)'], [lit, 'rgba(255,214,140,0.85)']]) {
          if (!amount) continue;
          ctx.globalAlpha = amount;
          ctx.fillStyle = windowPattern(ctx, color);
          ctx.fill();
        }
        return canvas;
      });
      return { period, height, keys };
    });
  }

  // ---------- item sprites (drawn once, stamped every frame) ----------
  /** World size of the coin sprite. */
  const ITEM_SIZE = { coin: 36 };
  const BOOST = '#ff8a1c';
  const GOLD = '#ffd23f';
  /** Text size plates are baked at; they are drawn scaled. */
  const PLATE_FONT = 22;

  function makeSprite(draw, size = 128) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.translate(size / 2, size / 2);
    ctx.scale(size / 64, size / 64);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    draw(ctx);
    return canvas;
  }

  const SPRITE_DRAW = {
    coin(ctx) {
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.arc(0, 0, 29, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#e59a00';
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.arc(0, -1.5, 23, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#f0a800';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, -1.5, 17, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#9a5c00';
      ctx.font = '900 24px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('₩', 0, 0);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, -1.5, 19, 3.6, 4.4);
      ctx.stroke();
    }
  };

  let sprites = null;
  function getSprites() {
    if (!sprites) sprites = Object.fromEntries(Object.entries(SPRITE_DRAW).map(([name, draw]) => [name, makeSprite(draw)]));
    return sprites;
  }

  const WINDOW_WIDTH = 132;

  /** Flat puffy clouds with a flat base, drawn once: a white body over a soft shade. */
  const CLOUDS = [
    [[-50, 6, 26], [-18, -10, 34], [22, -4, 30], [52, 8, 22]],
    [[-36, 4, 24], [0, -12, 30], [34, 4, 22]],
    [[-64, 8, 20], [-34, -6, 28], [4, -14, 32], [42, -2, 26], [70, 10, 18]]
  ];
  /** Soft white halo behind the sun, drawn once and stamped (no radial gradient per frame). */
  let glow = null;
  function getGlow() {
    if (glow) return glow;
    glow = document.createElement('canvas');
    glow.width = 128;
    glow.height = 128;
    const ctx = glow.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 64 * 0.4 / 3, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,0.35)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    return glow;
  }

  let clouds = null;
  function getClouds() {
    if (clouds) return clouds;
    clouds = CLOUDS.map(puffs => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 90;
      const ctx = canvas.getContext('2d');
      ctx.translate(100, 50);
      const body = (color, lift) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const [x, y, r] of puffs) {
          ctx.moveTo(x + r, y + lift);
          ctx.arc(x, y + lift, r, 0, TAU);
        }
        ctx.fill();
      };
      body('#d6e0f0', 5);
      body('#ffffff', 0);
      ctx.clearRect(-100, 22, 200, 40);
      return canvas;
    });
    return clouds;
  }

  /** Lit windows as one repeating pattern (filled into building shapes): warm at night, pale by day. */
  function windowPattern(ctx, color = 'rgba(255,214,140,0.85)') {
    const cell = { w: 11, h: 14 };
    const columns = WINDOW_WIDTH / cell.w;
    const rows = 10;
    const canvas = document.createElement('canvas');
    canvas.width = cell.w * columns;
    canvas.height = cell.h * rows;
    const tile = canvas.getContext('2d');
    tile.fillStyle = color;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        if (hash(row * 17.3 + column * 5.1) < 0.46) tile.fillRect(column * cell.w + 4, row * cell.h + 5, 4, 6);
      }
    }
    return ctx.createPattern(canvas, 'repeat');
  }

  class Renderer {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.reducedMotion = Boolean(options.reducedMotion);
      this.text = options.text || (() => '');
      this.camera = { x: 0, y: 0, zoom: 1, anchor: 0.3 };
      this.effects = [];
      this.fold = null;
      this.flash = null;
      this.shake = 0;
      this.boostShake = 0;
      this.boostLevel = 0;
      this.boostPulse = 0;
      this.speedLineTravel = 0;
      this.speedLineSpeed = 0;
      this.pose = { angle: 0, squash: 1, wobble: 0, roll: 0 };
      this.rider = { x: 0, y: 0 };
      this.time = 0;
      this.width = 1;
      this.height = 1;
      this.lineYs = new Float32Array(0);
      this.strips = null;
      this.plates = new Map();
      this.resize();
    }

    resize() {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const dpr = Math.min(ratio, Math.max(1, Math.sqrt(MAX_PIXELS / (this.width * this.height))));
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.dpr = dpr;
      const samples = Math.ceil((this.width + 24) / LINE_STEP) + 2;
      if (this.lineYs.length !== samples) this.lineYs = new Float32Array(samples);
      // Baked art depends on the screen height and ratio; it is rebuilt on the next frame.
      this.strips = null;
      this.plates.clear();
    }

    /** Snap the camera to a run (course load, restart). */
    reset(run) {
      this.plateSprite(this.text('office'), '#ffffff');
      this.plateSprite(this.text('finishGate'), GOLD);
      for (const sign of run.course.signs) for (const label of Object.values(sign.text)) this.plateSprite(label, GOLD);
      for (let streak = 1; streak <= 12; streak++) {
        const tail = streak > 1 ? ` ×${streak}` : '';
        this.popupSprite(this.text('perfect') + tail, GOLD, true);
        this.popupSprite(this.text('good') + tail, '#ffffff', false);
      }
      this.popupSprite(this.text('clean'), '#7cf0c8', false);
      this.popupSprite(this.text('ouch'), '#ff9b9b', false);
      this.effects.length = 0;
      this.fold = null;
      this.flash = null;
      this.shake = 0;
      this.boostShake = 0;
      this.boostLevel = 0;
      this.boostPulse = 0;
      this.speedLineTravel = 0;
      this.speedLineSpeed = 0;
      this.pose = { angle: 0, squash: 1, wobble: 0, roll: 0 };
      this.rider.x = run.x;
      this.rider.y = run.y;
      const view = this.view(run);
      this.camera.zoom = view.zoom;
      this.zoomTarget = view.zoom;
      this.zoomHold = 0;
      this.camera.anchor = view.anchor;
      this.camera.x = run.x;
      this.camera.y = view.focus + view.lift;
    }

    view(run) {
      const portrait = this.height > this.width;
      const span = portrait ? 860 : clamp(this.width * 1.05, 1100, 1650);
      const speed = Math.hypot(run.vx, run.vy);
      const baseZoom = (this.width / span) * mix(1, 0.84, clamp((speed - 700) / 1300, 0, 1));
      // Frame the rider and nearby ground, anticipating ascent before the apex leaves view.
      let low = this.drawnHeight(run, run.x), high = run.y;
      for (let i = 0; i <= 6; i++) {
        const x = run.x + span * (-0.25 + i * 0.12);
        const ground = this.drawnHeight(run, x);
        low = Math.min(low, ground); high = Math.max(high, ground);
      }
      const rise = run.grounded ? 0 : Math.max(0, run.vy);
      high = Math.max(high, run.y + Math.min(rise * 0.4, rise * rise / (2 * run.rules.gravity)));
      const zoom = Math.min(baseZoom, this.height * 0.62 / (high - low + 180));
      const spread = high - low;
      const framing = clamp((spread * baseZoom - this.height * 0.3) / (this.height * 0.35), 0, 1);
      const focus = mix(run.y, (low + high) * 0.5, framing);
      return { zoom, focus, anchor: portrait ? 0.24 : 0.3, lift: 21 / zoom };
    }

    /** Surface as drawn: follows the engine, but folds through a flat line for a moment after a flip. */
    drawnHeight(run, x) {
      const h = run.course.terrain.height(x);
      const current = run.offset + run.sign * h;
      if (!this.fold) return current;
      return mix(this.fold.offset + this.fold.sign * h, current, ease(this.fold.t));
    }

    sx(x) {
      return (x - this.camera.x) * this.camera.zoom + this.width * this.camera.anchor;
    }

    sy(y) {
      return this.height * 0.5 - (y - this.camera.y) * this.camera.zoom;
    }

    toWorldX(screenX) {
      return this.camera.x + (screenX - this.width * this.camera.anchor) / this.camera.zoom;
    }

    riderScale() {
      return clamp(1.05 / this.camera.zoom, 1.3, 1.9) * this.camera.zoom;
    }

    /** Only the newest popup stays: a fresh judgment replaces the last one. */
    popup(effect) {
      this.effects = this.effects.filter(item => item.kind !== 'popup');
      this.effects.push({ kind: 'popup', age: 0, ...effect });
    }

    /** Engine events become effects. */
    consume(run, events) {
      for (const event of events) {
        if (event.type === 'flip') {
          this.fold = { sign: event.sign, offset: event.offset, t: 0, duration: this.reducedMotion ? 0.06 : 0.2 };
          this.flash = { color: LINE[run.sign], age: 0, life: 0.2, strength: 0.045 };
          this.effects.push({ kind: 'wave', x: event.x, y: event.pivot, age: 0, life: 0.45, color: LINE[run.sign] });
          if (event.quality === 'perfect' || event.quality === 'good') {
            const label = event.quality === 'perfect' ? this.text('perfect') : this.text('good');
            const streak = event.streak > 1 ? ` ×${event.streak}` : '';
            this.popup({ text: label + streak, life: 0.75, color: event.quality === 'perfect' ? GOLD : '#ffffff', big: event.quality === 'perfect' });
            this.burst(event.x, event.pivot, event.quality === 'perfect' ? 16 : 8, '#ffd23f', 260);
          }
        } else if (event.type === 'land') {
          this.pose.squash = event.quality === 'hard' ? 0.72 : 0.84;
          this.burst(event.x, event.y, event.quality === 'hard' ? 16 : 9, event.quality === 'hard' ? '#ffffff' : '#c9d2ff', 180);
          if (event.quality === 'clean') this.popup({ text: this.text('clean'), life: 0.7, color: '#7cf0c8' });
          if (event.quality === 'hard') this.popup({ text: this.text('ouch'), life: 0.6, color: '#ff9b9b' });
        } else if (event.type === 'item') {
          // A coin into a full gauge bursts grey: that cash is lost.
          this.burst(event.x, event.y, event.full ? 4 : 6, event.full ? '#9aa3b8' : '#ffd23f', 150);
        } else if (event.type === 'boost') {
          this.effects.push({ kind: 'ring', x: event.x, y: event.y, age: 0, life: 0.35, color: BOOST });
        } else if (event.type === 'finish') {
          this.burst(run.x, run.y, 40, '#ffd23f', 520, true);
          this.burst(run.x, run.y, 30, LINE[run.sign], 480, true);
        }
      }
    }

    burst(x, y, count, color, power, confetti = false) {
      const limit = this.reducedMotion ? Math.ceil(count / 3) : count;
      for (let index = 0; index < limit; index++) {
        const angle = confetti ? -Math.PI / 2 + (Math.random() - 0.5) * 2.4 : Math.random() * TAU;
        const speed = power * (0.35 + Math.random() * 0.65);
        this.effects.push({
          kind: 'spark', x, y, vx: Math.cos(angle) * speed, vy: -Math.sin(angle) * speed + (confetti ? 380 : 0),
          age: 0, life: confetti ? 1.4 : 0.45 + Math.random() * 0.35, color, size: confetti ? 5 : 3, spin: Math.random() * TAU
        });
      }
    }

    /** Advance animation state. alpha interpolates between the previous and current tick. */
    update(dt, run, alpha = 1) {
      this.time += dt;
      if (this.fold) {
        this.fold.t += dt / this.fold.duration;
        if (this.fold.t >= 1) this.fold = null;
      }
      if (this.flash && (this.flash.age += dt) > this.flash.life) this.flash = null;
      this.shake = Math.max(0, this.shake - dt);
      const pushing = run.status === 'running' && run.boosting && run.grounded;
      const level = pushing && !this.reducedMotion ? 1 + Math.floor(run.boostCharge * 2) : 0;
      if (level > this.boostLevel) this.boostPulse = 0.18;
      this.boostLevel = level;
      this.boostPulse = level ? Math.max(0, this.boostPulse - dt) : 0;
      const boostShake = (0.75 + 0.75 * run.boostCharge) * this.boostPulse / 0.18;
      this.boostShake = mix(this.boostShake, boostShake, 1 - Math.exp(-dt * 18));
      const speed = Math.hypot(run.vx, run.vy);
      this.speedLineSpeed = mix(this.speedLineSpeed, speed, 1 - Math.exp(-dt * 4));
      this.speedLineTravel += Math.min(this.speedLineSpeed * 0.45, 950) * dt;
      for (let index = this.effects.length - 1; index >= 0; index--) {
        const effect = this.effects[index];
        effect.age += dt;
        if (effect.kind === 'spark') {
          effect.vy -= 900 * dt;
          effect.x += effect.vx * dt;
          effect.y += effect.vy * dt;
          effect.spin += dt * 8;
        }
        if (effect.age >= effect.life) this.effects.splice(index, 1);
      }

      const rider = this.rider;
      rider.x = mix(run.prevX, run.x, alpha);
      rider.y = mix(run.prevY, run.y, alpha);
      const view = this.view(run);
      const cam = this.camera;
      const follow = 1 - Math.exp(-dt * 3.2);
      // Ignore small framing changes and hold the wider view through a jump or flip.
      if (view.zoom < this.zoomTarget * 0.94) {
        this.zoomTarget = view.zoom;
        this.zoomHold = 0.8;
      } else if (!run.grounded || this.fold) this.zoomHold = 0.8;
      else this.zoomHold = Math.max(0, this.zoomHold - dt);
      if (!this.zoomHold && view.zoom > this.zoomTarget * 1.1) this.zoomTarget = view.zoom;
      const zoomDelta = Math.log(this.zoomTarget / cam.zoom) * (1 - Math.exp(-dt * (this.zoomTarget < cam.zoom ? 4.2 : 1.1)));
      cam.zoom *= Math.exp(clamp(zoomDelta, -dt * 3.2, dt));
      cam.anchor = mix(cam.anchor, view.anchor, follow);
      cam.x = rider.x;
      const errorY = view.focus + view.lift - cam.y;
      const deadZone = this.height * 0.055 / cam.zoom;
      if (Math.abs(errorY) > deadZone) cam.y += (errorY - Math.sign(errorY) * deadZone) * (1 - Math.exp(-dt * 4));

      const pose = this.pose;
      const target = run.grounded
        ? Math.atan(CF.engine.surface(run, run.x).slope)
        : clamp(Math.atan2(run.vy, Math.max(1, run.vx)) * 0.65, -0.9, 0.9);
      pose.angle = mix(pose.angle, target, 1 - Math.exp(-dt * (run.grounded ? 22 : 7)));
      pose.squash = mix(pose.squash, 1, 1 - Math.exp(-dt * 10));
      pose.wobble += dt * (4 + Math.hypot(run.vx, run.vy) / 120);
      // Casters roll on the ground and spin freely during flight.
      pose.roll = (pose.roll + dt * (run.grounded ? run.speed : run.boosting ? 1800 : 0) / 5.5) % TAU;
    }

    draw(run, options = {}) {
      const ctx = this.ctx;
      const vibration = this.reducedMotion || !run.grounded || run.status !== 'running' ? 0 : this.boostShake;
      const shakeX = (this.reducedMotion ? 0 : this.shake > 0 ? (Math.random() - 0.5) * 16 * this.shake / 0.3 : 0) + Math.sin(this.time * 89) * vibration;
      const shakeY = (this.reducedMotion ? 0 : this.shake > 0 ? (Math.random() - 0.5) * 12 * this.shake / 0.3 : 0) + Math.sin(this.time * 113) * vibration * 0.65;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.shiftX = shakeX;
      this.shiftY = shakeY;
      const course = run.course;
      const progress = clamp((this.rider.x - course.startX) / (course.finishX - course.startX), 0, 1);
      const sky = skyAt(progress);
      this.drawSky(sky, progress);
      this.drawSkyline(sky, progress);
      if (shakeX || shakeY) ctx.setTransform(this.dpr, 0, 0, this.dpr, shakeX * this.dpr, shakeY * this.dpr);
      this.drawSpeedLines(run);
      this.drawTerrain(run);
      this.drawLandmarks(run, options);
      this.drawItems(run);
      if (options.guide) this.drawGuide(run);
      if (options.ghost) this.drawGhost(run, options.ghost);
      this.drawRider(run);
      this.drawEffects();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.flash && !this.reducedMotion) {
        ctx.globalAlpha = this.flash.strength * (1 - this.flash.age / this.flash.life);
        ctx.fillStyle = this.flash.color;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.globalAlpha = 1;
      }
    }

    drawSky(sky, progress) {
      const ctx = this.ctx;
      // One gradient per sky step and screen height, reused across frames.
      if (sky.gradientHeight !== this.height) {
        sky.gradient = ctx.createLinearGradient(0, 0, 0, this.height);
        sky.gradient.addColorStop(0, sky.top);
        sky.gradient.addColorStop(1, sky.bottom);
        sky.gradientHeight = this.height;
      }
      ctx.fillStyle = sky.gradient;
      ctx.fillRect(0, 0, this.width, this.height);
      if (sky.night > 0.2) {
        ctx.globalAlpha = (sky.night - 0.2) * 0.7;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        for (let index = 0; index < 40; index++) ctx.rect(hash(index * 3.1) * this.width, hash(index * 7.7) * this.height * 0.45, 1.6, 1.6);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      const radius = Math.min(this.width, this.height) * 0.07;
      const sunX = this.width * 0.8 - this.camera.x * this.camera.zoom * 0.004;
      const sunY = this.height * mix(0.16, 0.58, progress);
      ctx.drawImage(getGlow(), sunX - radius * 3, sunY - radius * 3, radius * 6, radius * 6);
      ctx.fillStyle = sky.sun;
      ctx.beginPath();
      ctx.arc(sunX, sunY, radius, 0, TAU);
      ctx.fill();
      this.drawClouds(sky);
    }

    /** Two slow cloud layers: parallax plus a gentle drift, fading as night falls. */
    drawClouds(sky) {
      const ctx = this.ctx;
      const art = getClouds();
      ctx.save();
      ctx.globalAlpha = mix(0.95, 0.2, sky.night);
      for (const [parallax, slot, scale, band, seed] of CLOUD_LAYERS) {
        const offset = this.camera.x * this.camera.zoom * parallax + this.time * 6 * scale;
        const first = Math.floor(offset / slot) - 1;
        const count = Math.ceil(this.width / slot) + 3;
        for (let index = first; index < first + count; index++) {
          if (hash(index * 2.3 + seed) < 0.35) continue;
          const sprite = art[Math.floor(hash(index * 4.7 + seed) * art.length)];
          const size = scale * (0.75 + hash(index * 1.9 + seed) * 0.5);
          const x = index * slot - offset + hash(index * 3.3 + seed) * slot * 0.4;
          const y = this.height * (band + hash(index * 6.1 + seed) * 0.16);
          ctx.drawImage(sprite, x, y, sprite.width * size, sprite.height * size);
        }
      }
      ctx.restore();
    }

    /** Two parallax skylines, each a pre-baked repeating strip per sky keyframe (day, dusk, night).
     * A frame blends two neighbouring strips, so no building paths or window patterns are filled at run time. */
    drawSkyline(sky, progress) {
      const ctx = this.ctx;
      if (!this.strips) this.strips = bakeSkyline(this.height, this.bakeScale());
      const { index, t } = skyBlend(progress);
      for (let layer = 0; layer < LAYERS.length; layer++) {
        const spec = LAYERS[layer];
        const strip = this.strips[layer];
        const baseY = this.height * spec.base;
        const below = layer + 1 < LAYERS.length ? this.height * LAYERS[layer + 1].base + 2 : this.height;
        ctx.fillStyle = sky[spec.color];
        ctx.fillRect(0, baseY - 1, this.width, below - baseY + 1);
        const offset = this.camera.x * this.camera.zoom * spec.parallax;
        const start = -(((offset % strip.period) + strip.period) % strip.period);
        const top = baseY - strip.height;
        for (let x = start; x < this.width; x += strip.period) {
          ctx.drawImage(strip.keys[index], x, top, strip.period, strip.height);
          if (t > 0.004) {
            ctx.globalAlpha = t;
            ctx.drawImage(strip.keys[index + 1], x, top, strip.period, strip.height);
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    /** Offscreen art resolution: the canvas ratio, capped so baked strips stay small in memory. */
    bakeScale() {
      return Math.min(this.dpr, 1.5);
    }

    drawSpeedLines(run) {
      if (this.reducedMotion) return;
      const speed = this.speedLineSpeed;
      const strength = clamp((speed - 1400) / 1400, 0, 1) + (run.boosting && run.grounded ? 0.2 : 0);
      if (!strength) return;
      const ctx = this.ctx;
      ctx.strokeStyle = `rgba(255,255,255,${(0.16 * Math.min(1, strength)).toFixed(2)})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let index = 0; index < 8; index++) {
        const lane = hash(index * 9.1);
        const length = 60 + 100 * hash(index * 4.4);
        const travel = (this.speedLineTravel + hash(index) * 4000) % (this.width + length * 2);
        const x = this.width + length - travel;
        const y = this.height * (0.12 + lane * 0.7);
        ctx.moveTo(x, y);
        ctx.lineTo(x + length, y);
      }
      ctx.stroke();
    }

    /** Screen y of the drawn line at a screen x (from this frame's samples). */
    lineAt(screenX) {
      const ys = this.lineYs;
      const at = clamp((screenX + 12) / LINE_STEP, 0, ys.length - 1.001);
      const index = Math.floor(at);
      return mix(ys[index], ys[index + 1], at - index);
    }

    /** The chart: one gradient fill under the price line, grid and bars kept below the line by
     * arithmetic (no clip mask), then the outlined glowing line. */
    drawTerrain(run) {
      const ctx = this.ctx;
      const course = run.course;
      const cam = this.camera;
      const ys = this.lineYs;
      const step = LINE_STEP;
      let top = this.height;
      const line = this.linePath = new Path2D();
      for (let index = 0; index < ys.length; index++) {
        const screenX = -12 + index * step;
        const y = this.sy(this.drawnHeight(run, this.toWorldX(screenX)));
        ys[index] = y;
        if (y < top) top = y;
        if (index) line.lineTo(screenX, y);
        else line.moveTo(screenX, y);
      }
      const right = -12 + (ys.length - 1) * step;
      const area = new Path2D(line);
      area.lineTo(right, this.height + 4);
      area.lineTo(-12, this.height + 4);
      area.closePath();
      const tone = TERRAIN[run.sign];

      // Stock-app area fill in one gradient: the line colour fades into the navy chart body.
      const from = Math.max(0, top);
      const fill = ctx.createLinearGradient(0, from, 0, this.height);
      fill.addColorStop(0, tone.top);
      fill.addColorStop(clamp(this.height * 0.45 / Math.max(1, this.height - from), 0.05, 1), tone.body);
      fill.addColorStop(1, INK);
      ctx.fillStyle = fill;
      ctx.fill(area);

      // chart grid: horizontal price lines, drawn only where they lie under the line
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const gridStep = 140;
      const topWorld = cam.y + (this.height * 0.5) / cam.zoom;
      const bottomWorld = cam.y - (this.height * 0.5) / cam.zoom;
      for (let y = Math.floor(bottomWorld / gridStep) * gridStep; y <= topWorld; y += gridStep) {
        const screenY = this.sy(y);
        if (screenY < top) continue;
        let open = false;
        for (let index = 0; index < ys.length; index++) {
          const below = ys[index] < screenY - 2;
          const x = -12 + index * step;
          if (below && !open) ctx.moveTo(x, screenY);
          else if (!below && open) ctx.lineTo(x, screenY);
          open = below;
        }
        if (open) ctx.lineTo(right, screenY);
      }
      ctx.stroke();

      const left = this.toWorldX(-40);
      const rightX = this.toWorldX(this.width + 40);

      // Decorative bars for each synthetic chart sample, kept under the line.
      const barWidth = clamp(10 * cam.zoom, 3, 9);
      const candles = course.candles;
      let index = lowerBound(candles, left);
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass ? 'rgba(61,123,255,0.3)' : 'rgba(255,77,94,0.28)';
        ctx.beginPath();
        for (let at = index; at < candles.length && candles[at].x <= rightX; at++) {
          const candle = candles[at];
          if ((candle.move < 0) !== Boolean(pass)) continue;
          const x = this.sx(candle.x);
          const barTop = Math.max(this.height - 6 - Math.min(1, Math.abs(candle.move) * 2.2) * this.height * 0.14, this.lineAt(x) + 6);
          if (barTop < this.height) ctx.rect(x - barWidth / 2, barTop, barWidth, this.height - barTop);
        }
        ctx.fill();
      }

      // the price line: a soft wide stroke for glow, a navy outline, the line, and a thin highlight.
      // The line bends gently between samples, so bevel joins look the same as round ones and cost less.
      ctx.lineJoin = 'bevel';
      ctx.lineCap = 'butt';
      const width = clamp(6 * cam.zoom, 3.5, 6);
      ctx.strokeStyle = tone.glow;
      ctx.lineWidth = width * 3.4;
      ctx.stroke(line);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = width + 4;
      ctx.stroke(line);
      ctx.strokeStyle = tone.line;
      ctx.lineWidth = width;
      ctx.stroke(line);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke(line);
    }

    /** A sticker plate (outlined rounded box, hard shadow, centred text) baked once per label, so no
     * glyphs are shaped mid-run even though the plate scales with the camera. */
    plateSprite(label, fill) {
      const key = `${fill}|${label}`;
      let sprite = this.plates.get(key);
      if (sprite) return sprite;
      const size = PLATE_FONT;
      const scale = this.bakeScale() * 1.2;
      const probe = this.ctx;
      probe.font = `900 ${size}px system-ui, sans-serif`;
      const width = Math.ceil(probe.measureText(label).width + size * 1.1);
      const height = Math.ceil(size * 1.7);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil((width + 6) * scale);
      canvas.height = Math.ceil((height + 7) * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.translate(3, 2);
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.roundRect(0, 3, width, height, height * 0.32);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(0, 0, width, height, height * 0.32);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = OUTLINE;
      ctx.font = `900 ${size}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, width / 2, height / 2 + 1);
      sprite = { canvas, width: width + 6, height: height + 7 };
      this.plates.set(key, sprite);
      return sprite;
    }

    /** Judgement popups as baked sticker text (outline, hard shadow, fill): stroking text every
     * frame would turn its glyphs into paths each time. */
    popupSprite(text, color, big) {
      const key = `${big ? 1 : 0}${color}|${text}`;
      let sprite = this.plates.get(key);
      if (sprite) return sprite;
      const size = big ? 30 : 22;
      const scale = this.bakeScale();
      const font = `900 ${size}px system-ui, sans-serif`;
      this.ctx.font = font;
      const width = Math.ceil(this.ctx.measureText(text).width + 16);
      const height = Math.ceil(size * 1.25 + 14);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = OUTLINE;
      ctx.fillStyle = OUTLINE;
      const x = width / 2;
      const y = height / 2 - 1.5;
      ctx.strokeText(text, x, y + 3);
      ctx.fillText(text, x, y + 3);
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      sprite = { canvas, width, height };
      this.plates.set(key, sprite);
      return sprite;
    }

    /** Stamp a plate centred at cx with its bottom edge at bottom, text size size. */
    plate(cx, bottom, label, size, fill = GOLD) {
      const sprite = this.plateSprite(label, fill);
      const k = size / PLATE_FONT;
      const width = sprite.width * k;
      const height = sprite.height * k;
      this.ctx.drawImage(sprite.canvas, cx - width / 2, bottom - height + 5 * k, width, height);
    }

    /** Start office, finish gate and practice signs, all planted on the current surface. */
    drawLandmarks(run, options) {
      const ctx = this.ctx;
      const course = run.course;
      const scale = clamp(this.camera.zoom, 0.45, 1.1);
      ctx.lineJoin = 'round';

      const officeX = course.startX - 170;
      const ox = this.sx(officeX);
      if (ox > -300 && ox < this.width + 300) {
        const oy = this.sy(this.drawnHeight(run, officeX));
        const w = 160 * scale;
        const h = 250 * scale;
        const left = ox - w / 2;
        ctx.beginPath();
        ctx.rect(left, oy - h, w, h);
        ctx.fillStyle = '#3d4680';
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = '#4b56a0';
        ctx.fillRect(left + 1.5, oy - h + 1.5, w * 0.22, h - 3);
        ctx.fillStyle = 'rgba(255,225,150,0.9)';
        for (let row = 0; row < 5; row++) {
          for (let column = 0; column < 3; column++) {
            ctx.fillRect(left + 20 * scale + column * 44 * scale, oy - h + 20 * scale + row * 34 * scale, 24 * scale, 18 * scale);
          }
        }
        // glass door
        ctx.beginPath();
        ctx.rect(ox - 22 * scale, oy - 44 * scale, 44 * scale, 44 * scale);
        ctx.fillStyle = '#9fd3ff';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ox, oy - 44 * scale);
        ctx.lineTo(ox, oy);
        ctx.stroke();
        this.plate(ox, oy - h - 6 * scale, this.text('office'), 18 * scale, '#ffffff');
      }

      const fx = this.sx(course.finishX);
      if (fx > -300 && fx < this.width + 300) {
        const fy = this.sy(this.drawnHeight(run, course.finishX));
        const h = 190 * scale;
        const w = 132 * scale;
        const post = 8 * scale;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 2.5;
        for (const x of [fx - w / 2, fx + w / 2 - post]) {
          ctx.beginPath();
          ctx.rect(x, fy - h, post, h);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();
          // pennant on top of each post
          ctx.beginPath();
          ctx.moveTo(x + post / 2, fy - h);
          ctx.lineTo(x + post / 2, fy - h - 26 * scale);
          ctx.lineTo(x + post / 2 + 20 * scale, fy - h - 20 * scale);
          ctx.lineTo(x + post / 2, fy - h - 14 * scale);
          ctx.fillStyle = x < fx ? LINE[1] : LINE[-1];
          ctx.fill();
          ctx.stroke();
        }
        const cell = 12 * scale;
        const columns = Math.floor(w / cell);
        const bannerLeft = fx - (columns * cell) / 2;
        for (let row = 0; row < 3; row++) {
          for (let column = 0; column < columns; column++) {
            ctx.fillStyle = (row + column) % 2 ? INK : '#ffffff';
            ctx.fillRect(bannerLeft + column * cell, fy - h + row * cell, cell, cell);
          }
        }
        ctx.strokeRect(bannerLeft, fy - h, columns * cell, 3 * cell);
        this.plate(fx, fy - h - 8 * scale, this.text('finishGate'), 22 * scale);
      }

      for (const sign of course.signs) {
        const signX = this.sx(sign.x);
        if (signX < -260 || signX > this.width + 260) continue;
        const signY = this.sy(this.drawnHeight(run, sign.x));
        const label = sign.text[options.lang] || sign.text.en;
        const size = clamp(20 * scale, 13, 20);
        const bottom = signY - 118 * scale;
        ctx.beginPath();
        ctx.rect(signX - 2.5, bottom, 5, signY - bottom);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 2;
        ctx.stroke();
        this.plate(signX, bottom + 2, label, size);
      }
    }

    /** Coins ride on the current surface, so they move with every flip. */
    drawItems(run) {
      const items = run.items;
      if (!items.length) return;
      const ctx = this.ctx;
      const art = getSprites();
      const left = this.toWorldX(-60);
      const right = this.toWorldX(this.width + 60);
      let index = 0;
      let high = items.length;
      while (index < high) {
        const middle = (index + high) >> 1;
        if (items[middle].x < left) index = middle + 1;
        else high = middle;
      }
      const size = Math.max(ITEM_SIZE.coin * this.camera.zoom, ITEM_SIZE.coin * 0.66);
      for (; index < items.length && items[index].x <= right; index++) {
        if (run.taken[index]) continue;
        const item = items[index];
        const x = this.sx(item.x);
        const y = this.sy(this.drawnHeight(run, item.x) + item.lift);
        const spin = 0.28 + 0.72 * Math.abs(Math.cos(this.time * 4.2 + item.x * 0.01));
        ctx.drawImage(art.coin, x - size * spin / 2, y - size / 2, size * spin, size);
      }
    }

    /** Guide: marks the next low of the current orientation, where a flip is lossless. */
    drawGuide(run) {
      if (run.status !== 'running') return;
      const ctx = this.ctx;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 8);
      if (run.grounded && CF.engine.surface(run, run.x).slope > 0.12) {
        ctx.save();
        ctx.fillStyle = '#ffd23f';
        ctx.font = '900 26px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.translate(this.sx(this.rider.x), this.sy(this.rider.y) - 112 * this.riderScale());
        ctx.scale(1 + pulse * 0.23, 1 + pulse * 0.23);
        ctx.fillText('⇅', 0, 0);
        ctx.restore();
      }
      const low = CF.engine.nextLow(run, run.x - 4);
      if (!low) return;
      const y = this.sy(this.drawnHeight(run, low.x));
      const x = this.sx(low.x);
      if (x > this.width + 60) return;
      ctx.save();
      ctx.strokeStyle = `rgba(255,210,63,${0.65 + pulse * 0.35})`;
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(this.sx(low.x - low.half), y);
      ctx.lineTo(this.sx(low.x + low.half), y);
      ctx.stroke();
      ctx.fillStyle = '#ffd23f';
      ctx.font = '900 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⇅', x, y - 18 - pulse * 6);
      ctx.restore();
    }

    drawGhost(run, ghost) {
      const x = this.sx(ghost.x);
      if (x < -80 || x > this.width + 80) return;
      const y = this.sy(this.drawnHeight(run, ghost.x) + ghost.height);
      const ctx = this.ctx;
      const size = this.riderScale();
      ctx.save();
      ctx.globalAlpha = 0.36;
      ctx.translate(x, y);
      ctx.rotate(-(ghost.grounded ? Math.atan(CF.engine.surface(run, ghost.x).slope) : ghost.angle));
      ctx.scale(size, size);
      paintRider(ctx, { ghost: true, speed: 0, wobble: this.pose.wobble, air: !ghost.grounded });
      ctx.restore();
      if (Math.abs(ghost.x - this.rider.x) < 90) return;
      ctx.save();
      ctx.font = '800 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = this.text('ghost');
      const width = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(27,31,70,0.55)';
      ctx.beginPath();
      ctx.roundRect(x - width / 2, y - 108 * size - 10, width, 20, 10);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x, y - 108 * size + 1);
      ctx.restore();
    }

    drawRider(run) {
      const ctx = this.ctx;
      const x = this.sx(this.rider.x);
      const y = this.sy(this.rider.y - run.rules.radius);
      const size = this.riderScale();
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-this.pose.angle);
      ctx.scale(size, size * this.pose.squash);
      if (run.boosting) {
        ctx.save();
        if (!run.grounded) {
          const direction = CF.engine.airBoostDirection(run);
          ctx.translate(-18, -22);
          ctx.rotate(this.pose.angle - Math.atan2(direction.y, direction.x));
          ctx.translate(18, 22);
        }
        paintFlame(ctx, this.reducedMotion ? 0 : this.time, Math.sqrt(run.boostCharge), run.grounded ? 1 : 0.65);
        ctx.restore();
      }
      paintRider(ctx, { speed: Math.hypot(run.vx, run.vy), air: !run.grounded, wobble: this.pose.wobble, roll: this.pose.roll, color: LINE[run.sign] });
      ctx.restore();
    }

    drawEffects() {
      const ctx = this.ctx;
      const riderX = this.sx(this.rider.x);
      const riderY = this.sy(this.rider.y);
      const art = getSprites();
      for (const effect of this.effects) {
        const life = 1 - effect.age / effect.life;
        if (effect.kind === 'spark') {
          const x = this.sx(effect.x);
          const y = this.sy(effect.y);
          const cos = Math.cos(effect.spin);
          const sin = Math.sin(effect.spin);
          const dpr = this.dpr;
          ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * (x + this.shiftX), dpr * (y + this.shiftY));
          ctx.globalAlpha = clamp(life * 1.4, 0, 1);
          ctx.fillStyle = effect.color;
          ctx.fillRect(-effect.size / 2, -effect.size / 4, effect.size, effect.size / 2);
          ctx.setTransform(dpr, 0, 0, dpr, dpr * this.shiftX, dpr * this.shiftY);
        } else if (effect.kind === 'wave') {
          const x = this.sx(effect.x);
          const y = this.sy(effect.y);
          const reach = (1 - life) * this.width * 0.6;
          ctx.globalAlpha = clamp(life * 0.8, 0, 1);
          ctx.strokeStyle = effect.color;
          ctx.lineWidth = 3 * life + 1;
          ctx.beginPath();
          ctx.moveTo(x - reach, y);
          ctx.lineTo(x + reach, y);
          ctx.stroke();
        } else if (effect.kind === 'ring') {
          const x = this.sx(effect.x);
          const y = this.sy(effect.y);
          ctx.globalAlpha = clamp(life * 0.9, 0, 1);
          ctx.strokeStyle = effect.color;
          ctx.lineWidth = 4 * life + 1;
          ctx.beginPath();
          ctx.arc(x, y, (1 - life) * 90 * this.camera.zoom + 10, 0, TAU);
          ctx.stroke();
        } else if (effect.kind === 'popup') {
          const rise = (1 - life) * 46;
          const pop = effect.age < 0.12 ? 0.7 + effect.age / 0.12 * 0.45 : 1.15 - Math.min(0.15, effect.age - 0.12);
          const sprite = this.popupSprite(effect.text, effect.color, effect.big);
          // Keep the whole word on screen: the rider sits near the left edge on narrow screens.
          const half = sprite.width * 0.58;
          ctx.save();
          ctx.translate(clamp(riderX, half, Math.max(half, this.width - half)), riderY - 120 * this.riderScale() - rise);
          ctx.scale(pop, pop);
          ctx.rotate(-0.05);
          ctx.globalAlpha = clamp(life * 2, 0, 1);
          ctx.drawImage(sprite.canvas, -sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    }

    /** Rasterise every in-game string once (menu time), so no new glyphs are shaped mid-run. */
    warm(texts) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      ctx.lineWidth = 5;
      ctx.textBaseline = 'middle';
      for (const font of ['900 30px', '900 22px', '900 20px', '900 18px', '800 20px', '800 18px', '800 12px', '600 12px', '600 13px', '900 13px', '900 26px']) {
        ctx.font = `${font} system-ui, sans-serif`;
        for (const text of texts) {
          ctx.strokeText(text, 4, 24);
          ctx.fillText(text, 4, 24);
        }
      }
      // First use of a sprite or pattern on the game canvas uploads it; do that now, not mid-run.
      const art = getSprites();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const sprite of Object.values(art).concat(getClouds(), getGlow())) this.ctx.drawImage(sprite, 0, 0, 2, 2);
      if (!this.strips) this.strips = bakeSkyline(this.height, this.bakeScale());
      for (const strip of this.strips) for (const key of strip.keys) this.ctx.drawImage(key, 0, 0, 2, 2);
    }

  }

  /** Boost flame behind the chair: an outlined teardrop with a hot core. */
  function paintFlame(ctx, time, charge = 0, strength = 1) {
    const flicker = 0.8 + 0.2 * Math.sin(time * 60) + 0.08 * Math.sin(time * 23);
    const length = 46 * flicker * (1 + charge * 2.2) * strength;
    const tongue = (reach, half, color) => {
      half *= 1 + charge * 0.25;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-18, -22 - half);
      ctx.bezierCurveTo(-18 - reach * 0.5, -22 - half, -18 - reach * 0.8, -22 - half * 0.3, -18 - reach, -22);
      ctx.bezierCurveTo(-18 - reach * 0.8, -22 + half * 0.3, -18 - reach * 0.5, -22 + half, -18, -22 + half);
      ctx.closePath();
      ctx.fill();
    };
    ctx.save();
    ctx.lineJoin = 'round';
    tongue(length + 3, 11.5, OUTLINE);
    tongue(length, 9, '#ff6a2b');
    tongue(length * 0.66, 6, '#ffb52e');
    tongue(length * 0.34, 3.4, '#fff4c2');
    ctx.restore();
  }

  /** Fill a path, then outline it (the outline is skipped for the ghost). */
  function ink(ctx, fill, outline, width = 2.2) {
    ctx.fillStyle = fill;
    ctx.fill();
    if (!outline) return;
    ctx.strokeStyle = outline;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /** A limb drawn as an outlined stroke. */
  function limb(ctx, points, color, outline, width) {
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let index = 2; index < points.length; index += 2) ctx.lineTo(points[index], points[index + 1]);
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = width + 3;
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /** The rider: an ant office worker on a rolling office chair, outlined like a sticker.
   * Origin is the wheel contact point; the rider faces +x. */
  function paintRider(ctx, pose) {
    const ghost = Boolean(pose.ghost);
    const c = ghost ? GHOST_RIDER : RIDER;
    const line = ghost ? null : c.outline;
    const speed = pose.speed || 0;
    const flutter = Math.sin(pose.wobble || 0) * Math.min(1, speed / 900);
    const sweep = Math.min(1, speed / 1600);
    const air = Boolean(pose.air);
    const lift = air ? 5 : 0;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (!ghost && !air) {
      ctx.fillStyle = 'rgba(16,19,43,0.28)';
      ctx.beginPath();
      ctx.ellipse(0, 0, 22, 3.5, 0, 0, TAU);
      ctx.fill();
    }

    // chair: casters, base, gas lift, seat and a reclining back
    const roll = pose.roll || 0;
    for (const x of CASTERS) {
      ctx.beginPath();
      ctx.arc(x, -5.5, 5.5, 0, TAU);
      ink(ctx, c.wheel, line, 2);
      ctx.strokeStyle = c.hub;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(roll) * 3.4, -5.5 - Math.sin(roll) * 3.4);
      ctx.lineTo(x + Math.cos(roll) * 3.4, -5.5 + Math.sin(roll) * 3.4);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.roundRect(-20, -15, 40, 5, 2.5);
    ink(ctx, c.metal, line, 2);
    ctx.beginPath();
    ctx.roundRect(-2.5, -29, 5, 15, 1.5);
    ink(ctx, c.metal, line, 2);
    ctx.save();
    ctx.translate(-15, -32);
    ctx.rotate(-0.22 - sweep * 0.14);
    ctx.beginPath();
    ctx.roundRect(-7, -38, 12, 40, 6);
    ink(ctx, c.back, line);
    if (!ghost) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.roundRect(-4, -34, 3, 22, 1.5);
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(-18, -36, 36, 9, 4.5);
    ink(ctx, c.seat, line);

    // ant: abdomen on the seat, legs over the edge
    ctx.beginPath();
    ctx.ellipse(-6, -43, 11.5, 8.5, -0.2, 0, TAU);
    ink(ctx, c.ant, line);
    if (!ghost) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.ellipse(-9, -47, 4.5, 2.2, -0.3, 0, TAU);
      ctx.fill();
    }
    limb(ctx, [4, -43, 12, -37, 18 + flutter, -29 + lift], c.ant, line, 2.4);
    limb(ctx, [1, -42, 8, -33, 12 - flutter, -27 + lift], c.ant, line, 2.4);

    // shirt, badge and a tie in the orientation colour
    ctx.beginPath();
    ctx.ellipse(3, -52, 9, 10, 0.1, 0, TAU);
    ink(ctx, c.shirt, line);
    if (!ghost) {
      ctx.beginPath();
      ctx.roundRect(-3.5, -52, 5, 6, 1);
      ink(ctx, c.badge, line, 1.2);
    }
    ctx.beginPath();
    ctx.moveTo(4, -60);
    ctx.lineTo(7.5, -60);
    ctx.lineTo(6.5 - sweep * 7 + flutter * 2, -45);
    ctx.lineTo(3.5 - sweep * 8 + flutter * 2, -47);
    ctx.closePath();
    ink(ctx, ghost ? c.shirt : pose.color, line, 1.6);

    // arm with the morning coffee
    limb(ctx, [6, -53, 14, -49, 19, -55 - lift], c.ant, line, 2.8);
    ctx.beginPath();
    ctx.roundRect(17, -66 - lift, 9, 12, 2);
    ink(ctx, c.cup, line, 1.8);
    if (!ghost) {
      ctx.fillStyle = c.sleeve;
      ctx.fillRect(17.9, -61.5 - lift, 7.2, 4);
    }
    ctx.beginPath();
    ctx.roundRect(16, -68.5 - lift, 11, 3.5, 1.5);
    ink(ctx, c.lid, line, 1.6);

    // head: big round eye, cheek, antennae with round tips
    ctx.beginPath();
    for (const [base, lean] of ANTENNAE) {
      ctx.moveTo(base, -77);
      ctx.quadraticCurveTo(base - 2 - sweep * 10, -89 + flutter * 2, base - 6 - sweep * 18 + lean * 10, -93 + sweep * 8);
    }
    if (line) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 4.2;
      ctx.stroke();
    }
    ctx.strokeStyle = c.ant;
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const [base, lean] of ANTENNAE) {
      ctx.beginPath();
      ctx.arc(base - 6 - sweep * 18 + lean * 10, -93 + sweep * 8, 2.6, 0, TAU);
      ink(ctx, c.ant, line, 1.6);
    }
    ctx.beginPath();
    ctx.arc(11, -69, 11.5, 0, TAU);
    ink(ctx, c.ant, line, 2.4);
    ctx.beginPath();
    ctx.ellipse(15.5, -71, air ? 5.6 : 5, air ? 6.2 : 5.4, 0, 0, TAU);
    ink(ctx, c.eye, line, 1.6);
    if (!ghost) {
      ctx.fillStyle = c.pupil;
      ctx.beginPath();
      ctx.arc(17, -71 - (air ? 1 : 0), air ? 2 : 2.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(17.9, -72.2, 0.9, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,143,143,0.55)';
      ctx.beginPath();
      ctx.ellipse(12.5, -63.5, 3, 1.8, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#f6d7c3';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (air) ctx.arc(18, -62.5, 1.9, 0, TAU);
      else ctx.arc(17.5, -64.5, 3, 0.15 * Math.PI, (0.55 + sweep * 0.25) * Math.PI);
      ctx.stroke();
    }
  }

  CF.render = { Renderer, paintRider, getSprites, LINE, skyAt, ITEM_SIZE, BOOST };
})(globalThis.Chartflip = globalThis.Chartflip || {});
