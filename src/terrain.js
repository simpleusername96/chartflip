/* Chartflip terrain: monotone cubic chart surfaces and course building.
 * World units: x grows right, y grows up. Plain script shared by the browser and Node tests. */
(function (CF) {
  'use strict';

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  /** Monotone cubic Hermite curve: no overshoot between samples, flat at every local extreme. */
  class Terrain {
    constructor(points) {
      if (!Array.isArray(points) || points.length < 2) throw new Error('Terrain needs at least two points.');
      this.xs = Float64Array.from(points, point => point.x);
      this.ys = Float64Array.from(points, point => point.y);
      const count = points.length;
      for (let index = 1; index < count; index++) {
        if (!(this.xs[index] > this.xs[index - 1]) || !Number.isFinite(this.ys[index])) {
          throw new Error(`Terrain x must increase and y must be finite (index ${index}).`);
        }
      }
      const secant = new Float64Array(count - 1);
      for (let index = 0; index < count - 1; index++) {
        secant[index] = (this.ys[index + 1] - this.ys[index]) / (this.xs[index + 1] - this.xs[index]);
      }
      this.tangents = new Float64Array(count);
      for (let index = 1; index < count - 1; index++) {
        const left = secant[index - 1];
        const right = secant[index];
        if (left * right <= 0) continue;
        const a = this.xs[index] - this.xs[index - 1];
        const b = this.xs[index + 1] - this.xs[index];
        const w1 = 2 * b + a;
        const w2 = b + 2 * a;
        this.tangents[index] = (w1 + w2) / (w1 / left + w2 / right);
      }
      this.start = this.xs[0];
      this.end = this.xs[count - 1];
      this.cache = 0;
    }

    segment(x) {
      const xs = this.xs;
      const cached = this.cache;
      if (x >= xs[cached] && x < xs[cached + 1]) return cached;
      if (cached + 2 < xs.length && x >= xs[cached + 1] && x < xs[cached + 2]) return (this.cache = cached + 1);
      let low = 0;
      let high = xs.length - 2;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (xs[middle] <= x) low = middle;
        else high = middle - 1;
      }
      return (this.cache = low);
    }

    /** Height, slope and second derivative at x. Beyond the ends the curve stays flat. */
    at(x) {
      if (x <= this.start) return { h: this.ys[0], slope: 0, curve: 0 };
      if (x >= this.end) return { h: this.ys[this.ys.length - 1], slope: 0, curve: 0 };
      const index = this.segment(x);
      const x0 = this.xs[index];
      const dx = this.xs[index + 1] - x0;
      const t = (x - x0) / dx;
      const y0 = this.ys[index];
      const m0 = this.tangents[index] * dx;
      const m1 = this.tangents[index + 1] * dx;
      const rise = this.ys[index + 1] - y0;
      const c2 = 3 * rise - 2 * m0 - m1;
      const c3 = -2 * rise + m0 + m1;
      return {
        h: y0 + t * (m0 + t * (c2 + t * c3)),
        slope: (m0 + t * (2 * c2 + 3 * t * c3)) / dx,
        curve: (2 * c2 + 6 * c3 * t) / (dx * dx)
      };
    }

    /** Height only, without allocating (hot drawing and collision paths). */
    height(x) {
      if (x <= this.start) return this.ys[0];
      if (x >= this.end) return this.ys[this.ys.length - 1];
      const index = this.segment(x);
      const x0 = this.xs[index];
      const dx = this.xs[index + 1] - x0;
      const t = (x - x0) / dx;
      const y0 = this.ys[index];
      const m0 = this.tangents[index] * dx;
      const m1 = this.tangents[index + 1] * dx;
      const rise = this.ys[index + 1] - y0;
      return y0 + t * (m0 + t * (3 * rise - 2 * m0 - m1 + t * (-2 * rise + m0 + m1)));
    }

    /** Local extremes at sample points: kind -1 is a low, +1 is a high. Flat stretches use their middle. */
    extremes() {
      const found = [];
      let lastSign = 0;
      let lastEnd = 0;
      for (let index = 0; index < this.xs.length - 1; index++) {
        const sign = Math.sign(this.ys[index + 1] - this.ys[index]);
        if (!sign) continue;
        if (lastSign && sign !== lastSign) {
          found.push({
            x: (this.xs[lastEnd] + this.xs[index]) / 2,
            y: this.ys[index],
            half: (this.xs[index] - this.xs[lastEnd]) / 2,
            kind: lastSign > 0 ? 1 : -1
          });
        }
        lastSign = sign;
        lastEnd = index + 1;
      }
      return found;
    }
  }

  /** Zigzag pivots: keep only reversals of at least threshold (in value units). */
  function zigzag(values, threshold) {
    const last = values.length - 1;
    const pivots = [0];
    let trend = 0;
    let extreme = 0;
    for (let index = 1; index <= last; index++) {
      const value = values[index];
      if (trend === 0) {
        if (Math.abs(value - values[0]) >= threshold) {
          trend = Math.sign(value - values[0]);
          extreme = index;
        }
      } else if (trend > 0 ? value >= values[extreme] : value <= values[extreme]) {
        extreme = index;
      } else if (Math.abs(value - values[extreme]) >= threshold) {
        pivots.push(extreme);
        trend = -trend;
        extreme = index;
      }
    }
    if (extreme !== pivots[pivots.length - 1]) pivots.push(extreme);
    if (pivots[pivots.length - 1] !== last) {
      const tail = Math.abs(values[last] - values[pivots[pivots.length - 1]]);
      if (tail >= threshold * 0.35 || pivots.length < 2) pivots.push(last);
      else pivots[pivots.length - 1] = last;
    }
    return pivots;
  }

  const median = list => {
    const sorted = [...list].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  const START = { platform: 520, ramp: 900, drop: 520 };
  const PLATEAU = 150;
  const RUNOUT = 2600;

  /**
   * Turn fictional chart samples into a rideable course. Only zigzag pivots shape
   * the surface; all samples keep an x position for decorative chart bars.
   */
  function chartLayout(def) {
    const values = def.values;
    const range = Math.max(...values) - Math.min(...values) || 1;
    const pivots = zigzag(values, range * def.swing);
    const legs = [];
    for (let index = 1; index < pivots.length; index++) legs.push(values[pivots[index]] - values[pivots[index - 1]]);
    const scale = def.leg / median(legs.map(Math.abs).filter(Boolean));
    const points = [{ x: 0, y: 0 }];
    const sampleX = new Float64Array(values.length);
    let x = 0;
    for (let index = 1; index < pivots.length; index++) {
      const from = pivots[index - 1];
      const to = pivots[index];
      const rise = legs[index - 1] * scale;
      const span = Math.max(def.minRun, def.stretch * Math.abs(rise) + def.perDay * (to - from));
      for (let sample = from; sample <= to; sample++) sampleX[sample] = x + span * (sample - from) / (to - from);
      x += span;
      points.push({ x, y: (values[to] - values[0]) * scale });
    }
    return { points, sampleX, legs: legs.length };
  }

  function authoredLayout(def) {
    const points = def.points.map(([x, y]) => ({ x, y }));
    return { points, sampleX: null, legs: points.length - 1 };
  }

  /** Widen every interior turning point into a short plateau: flipping anywhere on it is lossless. */
  function plateaus(points, width) {
    if (!width) return points;
    const out = [points[0]];
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1];
      const point = points[index];
      const next = points[index + 1];
      const turning = (point.y - previous.y) * (next.y - point.y) < 0;
      if (!turning) {
        out.push(point);
        continue;
      }
      const half = Math.min(width / 2, (point.x - previous.x) / 4, (next.x - point.x) / 4);
      out.push({ x: point.x - half, y: point.y }, { x: point.x + half, y: point.y });
    }
    out.push(points[points.length - 1]);
    return out;
  }

  /** Build the runtime course: start platform and ramp, chart body, finish runout. */
  function buildCourse(def) {
    const layout = def.kind === 'authored' ? authoredLayout(def) : chartLayout(def);
    const body = layout.points;
    const first = body[0];
    const last = body[body.length - 1];
    const top = first.y + START.drop;
    const terrain = new Terrain(plateaus([
      { x: first.x - START.ramp - START.platform, y: top },
      { x: first.x - START.ramp, y: top },
      ...body,
      { x: last.x + RUNOUT, y: last.y }
    ], def.plateau ?? PLATEAU));
    const candles = [];
    if (def.kind !== 'authored') {
      const values = def.values;
      const range = Math.max(...values) - Math.min(...values) || 1;
      for (let sample = 1; sample < values.length; sample++) {
        candles.push({ x: layout.sampleX[sample], move: (values[sample] - values[sample - 1]) / range });
      }
    }
    const course = {
      id: def.id,
      def,
      terrain,
      startX: first.x - START.ramp - 110,
      finishX: last.x,
      endX: last.x + RUNOUT,
      extremes: terrain.extremes().filter(point => point.x < last.x + 1),
      candles,
      legs: layout.legs,
      guide: Boolean(def.guide),
      signs: def.signs || [],
      items: []
    };
    if (CF.items) course.items = CF.items.generate(course);
    return course;
  }

  CF.terrain = { Terrain, zigzag, plateaus, buildCourse, clamp, START, RUNOUT, PLATEAU };
})(globalThis.Chartflip = globalThis.Chartflip || {});
