/* Chartflip audio: synthesized effects and a generated background groove. Starts only after a user gesture. */
(function (CF) {
  'use strict';

  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];

  // ---------- music: an 8-bar loop at 120 BPM, one step is a sixteenth note ----------
  const STEP_TIME = 60 / 120 / 4;
  const LOOP_STEPS = 128;
  const LOOKAHEAD = 0.15;
  const midi = note => 440 * Math.pow(2, (note - 69) / 12);
  // Fmaj7 · G · Em7 · Am · Fmaj7 · G7 · C · C, with the bass root of each bar.
  const CHORDS = [[53, 57, 60, 64], [55, 59, 62, 67], [52, 55, 59, 62], [57, 60, 64, 67],
    [53, 57, 60, 64], [55, 59, 62, 65], [55, 60, 64, 67], [55, 60, 64, 67]];
  const ROOTS = [41, 43, 40, 45, 41, 43, 36, 36];
  // Bass per bar: [step, semitones above the root].
  const BASS = [[0, 0], [3, 0], [6, 12], [8, 0], [11, 7], [14, 12]];
  // Lead melody, C major pentatonic: [step in loop, note, length in steps].
  const MELODY = [
    [0, 72, 3], [3, 69, 3], [6, 67, 2], [8, 69, 4], [12, 72, 2], [14, 74, 2],
    [16, 76, 4], [20, 74, 2], [22, 72, 2], [24, 74, 6],
    [32, 71, 3], [35, 67, 3], [38, 64, 2], [40, 67, 4], [44, 71, 2], [46, 72, 2],
    [48, 76, 6], [54, 72, 2], [56, 69, 8],
    [64, 72, 3], [67, 69, 3], [70, 67, 2], [72, 69, 2], [74, 72, 2], [76, 77, 4],
    [80, 79, 4], [84, 77, 2], [86, 76, 2], [88, 74, 4], [92, 71, 4],
    [96, 72, 2], [98, 74, 2], [100, 76, 4], [104, 79, 2], [106, 76, 2], [108, 72, 4],
    [112, 72, 8]
  ];
  const MELODY_AT = new Map(MELODY.map(note => [note[0], note]));
  /** Layers per screen: the menu is a soft bed; a run adds drums and the lead. */
  const MODES = {
    off: { gain: 0, cutoff: 800, drums: false, lead: false },
    menu: { gain: 1.9, cutoff: 1800, drums: false, lead: false },
    ready: { gain: 2, cutoff: 2600, drums: false, lead: false },
    run: { gain: 1.05, cutoff: 9000, drums: true, lead: true },
    pause: { gain: 0.8, cutoff: 700, drums: false, lead: false },
    finish: { gain: 0, cutoff: 1200, drums: false, lead: false },
    result: { gain: 1.7, cutoff: 2000, drums: false, lead: false }
  };

  class Sound {
    /** `options.context` lets a recorder render the same sound into an OfflineAudioContext. */
    constructor(options = {}) {
      this.context = null;
      this.given = options.context || null;
      this.master = null;
      this.muted = false;
      this.wind = null;
      this.noise = null;
      this.coinStep = 0;
      this.coinAt = 0;
      this.windLevel = -1;
      this.windTone = -1;
      this.music = null;
      this.mode = 'menu';
      this.drive = 0;
      this.pumpTimer = 0;
    }

    /** Must run inside a user gesture. Safe to call repeatedly. */
    unlock() {
      if (!Context && !this.given) return false;
      try {
        if (!this.context) {
          this.context = this.given || new Context();
          this.master = this.context.createGain();
          this.master.gain.value = this.muted ? 0 : 0.5;
          // A gentle limiter keeps music plus a burst of effects from clipping.
          const limiter = this.context.createDynamicsCompressor();
          limiter.threshold.value = -8;
          limiter.knee.value = 6;
          limiter.ratio.value = 10;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.2;
          this.master.connect(limiter).connect(this.context.destination);
          const length = this.context.sampleRate;
          this.noise = this.context.createBuffer(1, length, this.context.sampleRate);
          const data = this.noise.getChannelData(0);
          for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1;
        }
        if (this.context.state === 'suspended' && !this.given) this.context.resume();
        this.ensureWind();
        this.ensureMusic();
        return true;
      } catch (error) {
        this.context = null;
        return false;
      }
    }

    get ready() {
      return Boolean(this.context && (this.given || this.context.state === 'running'));
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.context.currentTime, 0.02);
    }

    tone(frequency, start, duration, gain, type = 'sine', glide = 1) {
      const osc = this.context.createOscillator();
      const amp = this.context.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(frequency, start);
      if (glide !== 1) osc.frequency.exponentialRampToValueAtTime(frequency * glide, start + duration);
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(gain, start + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(amp).connect(this.master);
      osc.start(start);
      osc.stop(start + duration + 0.03);
    }

    hiss(start, duration, gain, from, to, type = 'bandpass') {
      const source = this.context.createBufferSource();
      source.buffer = this.noise;
      const filter = this.context.createBiquadFilter();
      filter.type = type;
      filter.Q.value = 1.2;
      filter.frequency.setValueAtTime(from, start);
      filter.frequency.exponentialRampToValueAtTime(to, start + duration);
      const amp = this.context.createGain();
      amp.gain.setValueAtTime(gain, start);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.connect(filter).connect(amp).connect(this.master);
      source.start(start, Math.random() * 0.5);
      source.stop(start + duration + 0.02);
    }

    note(step) {
      const semitone = PENTATONIC[Math.min(step, PENTATONIC.length - 1)];
      return 523.25 * Math.pow(2, semitone / 12);
    }

    flip(quality, streak) {
      if (!this.ready) return;
      const now = this.context.currentTime + 0.005;
      this.hiss(now, 0.16, 0.22, 500, 3200);
      if (quality === 'perfect' || quality === 'good') {
        const frequency = this.note(Math.max(0, streak - 1));
        this.tone(frequency, now, 0.22, quality === 'perfect' ? 0.22 : 0.12, 'triangle');
        if (quality === 'perfect') this.tone(frequency * 2, now + 0.02, 0.16, 0.07, 'sine');
      } else if (quality === 'miss') {
        this.tone(220, now, 0.16, 0.12, 'sine', 0.6);
      } else {
        this.tone(392, now, 0.1, 0.06, 'sine');
      }
    }

    land(quality, speed) {
      if (!this.ready) return;
      const now = this.context.currentTime + 0.005;
      const weight = Math.min(1, speed / 1600);
      if (quality === 'hard') {
        this.tone(110, now, 0.22, 0.3, 'sine', 0.45);
        this.hiss(now, 0.12, 0.2, 1200, 300, 'lowpass');
      } else {
        this.tone(160, now, 0.1, 0.08 + weight * 0.08, 'sine', 0.6);
        this.hiss(now, 0.06, 0.08, 2400, 800, 'lowpass');
      }
      if (quality === 'clean') {
        this.tone(1046.5, now + 0.02, 0.16, 0.1, 'triangle');
        this.tone(1568, now + 0.09, 0.2, 0.08, 'triangle');
      }
    }

    start() {
      if (!this.ready) return;
      const now = this.context.currentTime + 0.005;
      this.tone(659.25, now, 0.1, 0.12, 'square');
      this.tone(987.77, now + 0.09, 0.16, 0.12, 'square');
    }

    finish(medal) {
      if (!this.ready) return;
      const now = this.context.currentTime + 0.01;
      const tunes = [
        [523.25, 659.25, 783.99, 1046.5, 1318.5],
        [523.25, 659.25, 783.99, 1046.5],
        [523.25, 659.25, 783.99],
        [392, 349.23, 329.63]
      ];
      const tune = tunes[medal < 0 ? 3 : medal];
      tune.forEach((frequency, index) => this.tone(frequency, now + index * 0.1, 0.3, 0.14, 'triangle'));
    }

    /** Coins climb the scale when taken in quick succession; into a full gauge they just clink. */
    coin(full) {
      if (!this.ready) return;
      const now = this.context.currentTime + 0.004;
      if (full) {
        this.tone(740, now, 0.05, 0.04, 'triangle');
        return;
      }
      this.coinStep = now - this.coinAt < 0.45 ? Math.min(this.coinStep + 1, PENTATONIC.length - 1) : 0;
      this.coinAt = now;
      const frequency = this.note(this.coinStep) * 2;
      this.tone(frequency, now, 0.09, 0.07, 'square');
      this.tone(frequency * 1.5, now + 0.05, 0.12, 0.05, 'square');
    }

    /** Boost kicks in: a short whoosh (the engine hum then rides on the wind bed). */
    boost() {
      if (!this.ready) return;
      const now = this.context.currentTime + 0.004;
      this.hiss(now, 0.35, 0.28, 400, 3600, 'bandpass');
      this.tone(110, now, 0.3, 0.12, 'sawtooth', 1.8);
    }

    click() {
      if (!this.ready) return;
      this.tone(880, this.context.currentTime + 0.002, 0.05, 0.05, 'triangle');
    }

    /** The looping wind bed, created once when audio unlocks (not in the middle of a run). */
    ensureWind() {
      if (this.wind || !this.context) return;
      const source = this.context.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      const amp = this.context.createGain();
      amp.gain.value = 0;
      source.connect(filter).connect(amp).connect(this.master);
      source.start();
      this.wind = { filter, amp };
    }

    /** Wind follows speed (brighter while boosting). Automation is scheduled only when the target changes noticeably. */
    motion(speed, running, boosting = false) {
      this.drive = running ? Math.min(1, speed / 1800) + (boosting ? 0.5 : 0) : 0;
      if (!this.ready || !this.wind) return;
      const now = this.context.currentTime;
      const level = running ? Math.min(0.16, Math.max(0, (speed - 150) / 9000)) + (boosting ? 0.06 : 0) : 0;
      const tone = 250 + speed * 1.6 + (boosting ? 900 : 0);
      if (Math.abs(level - this.windLevel) > 0.004) {
        this.windLevel = level;
        this.wind.amp.gain.setTargetAtTime(level, now, 0.08);
      }
      if (Math.abs(tone - this.windTone) > 40) {
        this.windTone = tone;
        this.wind.filter.frequency.setTargetAtTime(tone, now, 0.08);
      }
    }

    // ---------- background music ----------

    /** The music bus (gain, then a lowpass that opens up during a run) and its scheduler. */
    ensureMusic() {
      if (this.music || !this.context) return;
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.4;
      const bus = this.context.createGain();
      bus.gain.value = 0;
      bus.connect(filter).connect(this.master);
      this.music = { bus, filter, step: 0, at: this.context.currentTime + 0.1 };
      this.setMusic(this.mode);
      // A live context schedules itself; a recorder calls pump() while it renders.
      if (!this.given) this.pumpTimer = setInterval(() => this.pump(), 25);
    }

    /** Switch the arrangement for a screen: 'menu', 'ready', 'run', 'pause', 'finish' or 'result'. */
    setMusic(mode) {
      this.mode = MODES[mode] ? mode : 'menu';
      if (!this.music) return;
      const settings = MODES[this.mode];
      const now = this.context.currentTime;
      const fade = this.mode === 'finish' ? 0.25 : 0.4;
      this.music.bus.gain.setTargetAtTime(settings.gain, now, fade);
      this.music.filter.frequency.setTargetAtTime(settings.cutoff, now, fade);
    }

    /** Schedule every step that starts within the lookahead window. */
    pump() {
      const music = this.music;
      if (!music) return;
      const now = this.context.currentTime;
      // A throttled background tab falls behind: skip ahead instead of bursting old notes.
      if (music.at < now - 0.05) {
        const behind = Math.ceil((now - music.at) / STEP_TIME);
        music.step = (music.step + behind) % (LOOP_STEPS * 2);
        music.at += behind * STEP_TIME;
      }
      while (music.at < now + LOOKAHEAD) {
        if (!this.muted && MODES[this.mode].gain > 0) this.playStep(music.step, music.at);
        music.step = (music.step + 1) % (LOOP_STEPS * 2);
        music.at += STEP_TIME;
      }
    }

    /** One sixteenth of the groove. Every other loop swaps the lead for a light arpeggio. */
    playStep(step, time) {
      const settings = MODES[this.mode];
      const inLoop = step % LOOP_STEPS;
      const bar = inLoop >> 4;
      const beat = inLoop & 15;
      const chord = CHORDS[bar];
      const root = ROOTS[bar];
      const second = step >= LOOP_STEPS;

      for (const [at, interval] of BASS) {
        if (at !== beat || (!settings.drums && at % 8)) continue;
        this.bass(midi(root + interval), time, at === 0 ? 0.3 : 0.18);
      }
      if (settings.drums) {
        if (beat === 0 || beat === 8 || (beat === 10 && bar % 2)) this.kick(time);
        if (beat === 4 || beat === 12) this.snare(time);
        if (beat % 2 === 0 || this.drive > 0.85) this.hat(time, beat === 14, beat % 4 === 2 ? 0.05 : 0.03);
        if (beat === 2 || beat === 6 || beat === 10 || beat === 14) this.keys(chord, time, 0.12, 0.045);
      } else if (beat === 0) {
        this.keys(chord, time, STEP_TIME * 14, 0.05, 0.08);
      } else if (beat === 8) {
        this.keys(chord.slice(1), time, STEP_TIME * 6, 0.03, 0.03);
      }
      if (settings.lead && !second) {
        const note = MELODY_AT.get(inLoop);
        if (note) this.lead(midi(note[1]), time, note[2] * STEP_TIME);
      } else if (beat % 2 === 0 && (settings.lead || beat % 4 === 0)) {
        const note = chord[(beat >> 1) % chord.length] + 12;
        this.pluck(midi(note), time, settings.lead ? 0.035 : 0.025);
      }
    }

    /** A note on the music bus with a short attack and an exponential release. */
    voice(frequency, start, duration, gain, type, attack = 0.005) {
      const osc = this.context.createOscillator();
      const amp = this.context.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(gain, start + attack);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + attack + duration);
      osc.connect(amp).connect(this.music.bus);
      osc.start(start);
      osc.stop(start + attack + duration + 0.02);
    }

    bass(frequency, time, gain) {
      this.voice(frequency, time, 0.22, gain, 'triangle');
      this.voice(frequency * 2, time, 0.08, gain * 0.25, 'square');
    }

    keys(chord, time, duration, gain, attack = 0.006) {
      for (const note of chord) this.voice(midi(note), time, duration, gain, 'triangle', attack);
    }

    lead(frequency, time, duration) {
      this.voice(frequency, time, Math.max(0.12, duration * 0.9), 0.07, 'square');
      this.voice(frequency * 2, time, 0.08, 0.03, 'sine');
    }

    pluck(frequency, time, gain) {
      this.voice(frequency, time, 0.14, gain, 'sine');
    }

    kick(time) {
      const osc = this.context.createOscillator();
      const amp = this.context.createGain();
      osc.frequency.setValueAtTime(150, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
      amp.gain.setValueAtTime(0.32, time);
      amp.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
      osc.connect(amp).connect(this.music.bus);
      osc.start(time);
      osc.stop(time + 0.22);
    }

    /** Filtered noise hit on the music bus. */
    burst(time, duration, gain, type, frequency) {
      const source = this.context.createBufferSource();
      source.buffer = this.noise;
      const filter = this.context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      const amp = this.context.createGain();
      amp.gain.setValueAtTime(gain, time);
      amp.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      source.connect(filter).connect(amp).connect(this.music.bus);
      source.start(time, (time * 7.3) % 0.8);
      source.stop(time + duration + 0.02);
    }

    snare(time) {
      this.burst(time, 0.14, 0.22, 'bandpass', 1900);
      this.voice(196, time, 0.06, 0.08, 'triangle');
    }

    hat(time, open, gain) {
      this.burst(time, open ? 0.12 : 0.035, gain, 'highpass', 7500);
    }
  }

  CF.audio = { Sound };
})(globalThis.Chartflip = globalThis.Chartflip || {});
