// graph.js — Visualization renderers used inside widget cards.
//
// Each renderer is self-contained (owns its canvas/DOM, its own rAF loop,
// its own buffer) and exposes the same minimal push(value, timestamp)
// interface so widget.js can swap viz modes without special-casing.

const GRID_COLOR = '#e8e6e1';
const GRID_MIDLINE = '#d4d1ca';
const AXIS_COLOR = '#a8a49e';

// Hard safety cap on buffered points, on top of the time-window trim below —
// guards against runaway memory/render cost if the data rate ends up much
// higher than expected. Scaled to the widget's own time window (with
// generous headroom over the ~30 Hz BLE rate) rather than a fixed number,
// so a long time window never gets truncated short by this cap — that
// previously cut a 60s window off at ~33s (1000 points / 30 Hz).
const MAX_POINTS_PER_SECOND = 120; // ~4x the real ~30 Hz send rate
const MIN_POINTS_CAP = 500;

function maxPointsFor(timeWindowMs) {
  return Math.max(MIN_POINTS_CAP, Math.ceil((timeWindowMs / 1000) * MAX_POINTS_PER_SECOND));
}

// ─────────────────────────────────────────────
// LineGraph — scrolling time-series waveform.
// Used for 'line' viz mode on any data type (analog, digital, capacitive).
// Y-axis can auto-scale to the visible data, or be manually fixed —
// the whole reason a per-widget setting exists is so a tiny variation
// doesn't get blown up by autoscale when you want a fixed reference frame.
// ─────────────────────────────────────────────

export class LineGraph {
  constructor(canvas, color = '#2a6b96') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.timeWindow = 5000;
    this.buffer = [];
    this.unit = '';
    this.autoscale = true;
    this.yMin = 0;
    this.yMax = 1;
    this._dirty = false;
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  push(value, timestamp) {
    this.buffer.push({ t: timestamp, v: value });
    this._trimBuffer(timestamp);
    this._dirty = true;
  }

  setTimeWindow(seconds) {
    this.timeWindow = seconds * 1000;
    this._dirty = true;
  }

  setUnit(unit) {
    this.unit = unit ?? '';
    this._dirty = true;
  }

  setAutoscale(on) {
    this.autoscale = on;
    this._dirty = true;
  }

  setYRange(min, max) {
    this.yMin = min;
    this.yMax = max;
    this._dirty = true;
  }

  clearBuffer() {
    this.buffer = [];
    this._dirty = true;
  }

  // Last-rendered data range — used to seed sensible min/max when a widget
  // first switches from autoscale to a fixed manual range.
  getDataRange() {
    if (this.buffer.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const p of this.buffer) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    return isFinite(min) ? { min, max } : null;
  }

  destroy() { cancelAnimationFrame(this._raf); }

  _trimBuffer(now) {
    const cutoff = now - this.timeWindow;
    let i = 0;
    while (i < this.buffer.length && this.buffer[i].t < cutoff) i++;
    if (i > 0) this.buffer.splice(0, i);
    const cap = maxPointsFor(this.timeWindow);
    if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap);
  }

  _loop() {
    if (this._dirty) {
      this._render();
      this._dirty = false;
    }
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  _render() {
    const { canvas, ctx, buffer, timeWindow, color } = this;
    const dpr = devicePixelRatio || 1;
    const W = canvas.width  = canvas.offsetWidth  * dpr;
    const H = canvas.height = canvas.offsetHeight * dpr;
    ctx.clearRect(0, 0, W, H);

    if (buffer.length < 2) return;

    const now    = buffer[buffer.length - 1].t;
    const tStart = now - timeWindow;

    let min, max;
    if (this.autoscale) {
      min = Infinity; max = -Infinity;
      for (const p of buffer) {
        if (p.t < tStart) continue;
        if (p.v < min) min = p.v;
        if (p.v > max) max = p.v;
      }
      if (!isFinite(min)) return;
      if (min === max) { min -= 1; max += 1; }
    } else {
      min = Math.min(this.yMin, this.yMax);
      max = Math.max(this.yMin, this.yMax);
      if (min === max) { min -= 1; max += 1; }
    }

    // Nice tick algorithm — pick a round step, snap min/max to multiples of it
    const rawStep = (max - min) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const autoStep =
      (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;

    const step = this.autoscale ? autoStep : 0.5;
    const niceMin = this.autoscale
      ? Math.floor(min / step) * step
      : min;
    const niceMax = this.autoscale
      ? Math.ceil(max / step) * step
      : max;

    // Layout — extra top padding when a unit label is shown above the y-axis
    const padLeft   = 46 * dpr;
    const padRight  =  6 * dpr;
    const padTop    = (this.unit ? 18 : 8) * dpr;
    const padBottom = 18 * dpr;
    const drawW = W - padLeft - padRight;
    const drawH = H - padTop  - padBottom;

    const toY = v => padTop  + drawH * (1 - (v - niceMin) / (niceMax - niceMin));
    const toX = t => padLeft + ((t - tStart) / timeWindow) * drawW;

    // Grid line + label at each graduation
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    const fmt = v => {
      const s = v.toFixed(decimals);
      // Fix floating-point display noise (e.g. 24.999999 → 25.0)
      return parseFloat(s).toFixed(decimals);
    };

    ctx.font = `${Math.round(9 * dpr)}px ui-monospace, "Courier New", monospace`;
    ctx.textAlign = 'right';
    let lastLabelY = Infinity;
    const minSpacing = 11 * dpr;

    for (let v = niceMin; v <= niceMax + step * 0.001; v += step) {
      const y = toY(v);
      if (y < padTop - 1 || y > padTop + drawH + 1) continue;

      ctx.strokeStyle = v === 0 ? GRID_MIDLINE : GRID_COLOR;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();

      if (lastLabelY - y >= minSpacing) {
        ctx.fillStyle = AXIS_COLOR;
        ctx.textBaseline = y < padTop + 8 * dpr ? 'top' : y > padTop + drawH - 8 * dpr ? 'bottom' : 'middle';
        ctx.fillText(fmt(v), padLeft - 5 * dpr, y);
        lastLabelY = y;
      }
    }

    // Unit label — top of the y-axis margin, right-aligned
    if (this.unit) {
      ctx.font         = `${Math.round(8 * dpr)}px ui-monospace, "Courier New", monospace`;
      ctx.fillStyle    = AXIS_COLOR;
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(this.unit, padLeft - 4 * dpr, 3 * dpr);
    }

    // Manual-scale indicator — small pin icon hints the axis is locked
    if (!this.autoscale) {
      ctx.fillStyle    = AXIS_COLOR;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.font         = `${Math.round(8 * dpr)}px ui-monospace, "Courier New", monospace`;
      ctx.fillText('FIXED', padLeft, 3 * dpr);
    }

    // Waveform — clipped to the plot area since manual bounds may not
    // contain every sample.
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, drawW, drawH);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let first = true;
    for (const p of buffer) {
      if (p.t < tStart) continue;
      const x = toX(p.t);
      const y = toY(p.v);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // X labels — time in seconds, right edge = 0 (now)
    const twSec = timeWindow / 1000;
    const xStep = twSec <= 5 ? 1 : twSec <= 15 ? 2 : twSec <= 30 ? 5 : 10;
    ctx.fillStyle    = AXIS_COLOR;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s >= -twSec; s -= xStep) {
      const x = padLeft + ((twSec + s) / twSec) * drawW;
      if (x < padLeft || x > W - padRight + 2 * dpr) continue;
      ctx.fillText(s === 0 ? '0' : `${s}s`, x, padTop + drawH + 3 * dpr);
    }
  }
}

// ─────────────────────────────────────────────
// MultiLineGraph — several overlaid scrolling waveforms, one per source, used
// by the "combine" widget. Analog volts, digital 0/1, and capacitive 0.0–1.0
// aren't comparable on one literal axis, so each series is independently
// autoscaled (same logic as LineGraph) and drawn in the same normalized
// 0–100% band — a shared reference frame, not a shared unit. No numeric
// Y-axis or per-line labels on the canvas itself; that's the widget's own
// side panel's job, keeping the graph area clean.
// ─────────────────────────────────────────────

export class MultiLineGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.timeWindow = 5000;
    this.series = new Map(); // id -> { color, buffer: [], visible }
    this._dirty = false;
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  addSeries(id, color) {
    this.series.set(id, { color, buffer: [], visible: true, autoscale: true, yMin: 0, yMax: 1 });
    this._dirty = true;
  }

  removeSeries(id) {
    this.series.delete(id);
    this._dirty = true;
  }

  setVisible(id, visible) {
    const s = this.series.get(id);
    if (!s) return;
    s.visible = visible;
    this._dirty = true;
  }

  setColor(id, color) {
    const s = this.series.get(id);
    if (s) { s.color = color; this._dirty = true; }
  }

  // Per-series Y autoscale — off pins that one line to a fixed range while
  // every other series keeps auto-fitting to its own live data.
  setAutoscale(id, on) {
    const s = this.series.get(id);
    if (s) { s.autoscale = on; this._dirty = true; }
  }

  setYRange(id, min, max) {
    const s = this.series.get(id);
    if (s) { s.yMin = min; s.yMax = max; this._dirty = true; }
  }

  // Last-rendered data range for one series — used to seed sensible min/max
  // when that source's linked settings widget first switches off autoscale.
  getDataRange(id) {
    const s = this.series.get(id);
    if (!s || s.buffer.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const p of s.buffer) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    return isFinite(min) ? { min, max } : null;
  }

  push(id, value, timestamp) {
    const s = this.series.get(id);
    if (!s) return;
    s.buffer.push({ t: timestamp, v: value });
    this._trimBuffer(s, timestamp);
    this._dirty = true;
  }

  clearSeries(id) {
    const s = this.series.get(id);
    if (s) { s.buffer = []; this._dirty = true; }
  }

  setTimeWindow(seconds) {
    this.timeWindow = seconds * 1000;
    this._dirty = true;
  }

  destroy() { cancelAnimationFrame(this._raf); }

  _trimBuffer(s, now) {
    const cutoff = now - this.timeWindow;
    let i = 0;
    while (i < s.buffer.length && s.buffer[i].t < cutoff) i++;
    if (i > 0) s.buffer.splice(0, i);
    const cap = maxPointsFor(this.timeWindow);
    if (s.buffer.length > cap) s.buffer.splice(0, s.buffer.length - cap);
  }

  _loop() {
    if (this._dirty) { this._render(); this._dirty = false; }
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  _render() {
    const { canvas, ctx, timeWindow } = this;
    const dpr = devicePixelRatio || 1;
    const W = canvas.width  = canvas.offsetWidth  * dpr;
    const H = canvas.height = canvas.offsetHeight * dpr;
    ctx.clearRect(0, 0, W, H);

    const visible = [...this.series.values()].filter(s => s.visible && s.buffer.length >= 2);

    let now = -Infinity;
    for (const s of visible) now = Math.max(now, s.buffer[s.buffer.length - 1].t);
    if (!isFinite(now)) return;
    const tStart = now - timeWindow;

    const padLeft = 6 * dpr, padRight = 6 * dpr, padTop = 8 * dpr, padBottom = 18 * dpr;
    const drawW = W - padLeft - padRight;
    const drawH = H - padTop - padBottom;
    if (drawW <= 0 || drawH <= 0) return;

    const toX = t => padLeft + ((t - tStart) / timeWindow) * drawW;

    // Faint unlabeled reference lines — no numeric axis since units differ per series.
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1 * dpr;
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const y = padTop + drawH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, drawW, drawH);
    ctx.clip();

    for (const s of visible) {
      let min, max;
      if (s.autoscale) {
        min = Infinity; max = -Infinity;
        for (const p of s.buffer) {
          if (p.t < tStart) continue;
          if (p.v < min) min = p.v;
          if (p.v > max) max = p.v;
        }
        if (!isFinite(min)) continue;
        if (min === max) { min -= 1; max += 1; }
      } else {
        min = Math.min(s.yMin, s.yMax);
        max = Math.max(s.yMin, s.yMax);
        if (min === max) { min -= 1; max += 1; }
      }

      const toY = v => padTop + drawH * (1 - (v - min) / (max - min));

      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let first = true;
      for (const p of s.buffer) {
        if (p.t < tStart) continue;
        const x = toX(p.t), y = toY(p.v);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // X labels — time in seconds, right edge = 0 (now)
    const twSec = timeWindow / 1000;
    const xStep = twSec <= 5 ? 1 : twSec <= 15 ? 2 : twSec <= 30 ? 5 : 10;
    ctx.fillStyle    = AXIS_COLOR;
    ctx.font         = `${Math.round(9 * dpr)}px ui-monospace, "Courier New", monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s >= -twSec; s -= xStep) {
      const x = padLeft + ((twSec + s) / twSec) * drawW;
      if (x < padLeft || x > W - padRight + 2 * dpr) continue;
      ctx.fillText(s === 0 ? '0' : `${s}s`, x, padTop + drawH + 3 * dpr);
    }
  }
}

// ─────────────────────────────────────────────
// StateGraph — step waveform with HIGH/LOW fill regions.
// Used for digital's 'state' viz mode. Range is inherently 0/1, so there's
// no autoscale/manual-range concept here.
// ─────────────────────────────────────────────

export class StateGraph {
  constructor(canvas, color = '#4a4844') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.timeWindow = 5000;
    this.buffer = [];
    this._dirty = false;
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  push(value, timestamp) {
    this.buffer.push({ t: timestamp, v: value });
    this._trimBuffer(timestamp);
    this._dirty = true;
  }

  setTimeWindow(seconds) {
    this.timeWindow = seconds * 1000;
    this._dirty = true;
  }

  destroy() { cancelAnimationFrame(this._raf); }

  _trimBuffer(now) {
    const cutoff = now - this.timeWindow;
    let i = 0;
    while (i < this.buffer.length && this.buffer[i].t < cutoff) i++;
    if (i > 0) this.buffer.splice(0, i);
    const cap = maxPointsFor(this.timeWindow);
    if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap);
  }

  _loop() {
    if (this._dirty) { this._render(); this._dirty = false; }
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  _render() {
    const { canvas, ctx, buffer, timeWindow, color } = this;
    const dpr = devicePixelRatio || 1;
    const W = canvas.width  = canvas.offsetWidth  * dpr;
    const H = canvas.height = canvas.offsetHeight * dpr;
    ctx.clearRect(0, 0, W, H);

    if (buffer.length < 1) return;

    const now    = buffer[buffer.length - 1].t;
    const tStart = now - timeWindow;

    const padLeft   = 28 * dpr;
    const padRight  =  6 * dpr;
    const padTop    =  8 * dpr;
    const padBottom = 18 * dpr;
    const drawW = W - padLeft - padRight;
    const drawH = H - padTop  - padBottom;
    const yHigh = padTop;
    const yLow  = padTop + drawH;

    const toX = t => padLeft + ((t - tStart) / timeWindow) * drawW;

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(padLeft, yHigh);
    ctx.lineTo(W - padRight, yHigh);
    ctx.moveTo(padLeft, yLow);
    ctx.lineTo(W - padRight, yLow);
    ctx.stroke();

    ctx.fillStyle = hexToRgba(color, 0.09);
    let inHigh = false;
    let highStart = 0;
    for (const p of buffer) {
      if (p.t < tStart) continue;
      const x = toX(p.t);
      if (p.v && !inHigh) { highStart = x; inHigh = true; }
      if (!p.v && inHigh) {
        ctx.fillRect(highStart, yHigh, x - highStart, drawH);
        inHigh = false;
      }
    }
    if (inHigh) ctx.fillRect(highStart, yHigh, W - highStart, drawH);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8 * dpr;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    let first = true;
    let prevY = 0;
    for (const p of buffer) {
      if (p.t < tStart) continue;
      const x = toX(p.t);
      const y = p.v ? yHigh : yLow;
      if (first) { ctx.moveTo(x, y); first = false; }
      else { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
      prevY = y;
    }
    if (!first) ctx.lineTo(W - padRight, prevY);
    ctx.stroke();

    ctx.fillStyle = AXIS_COLOR;
    ctx.font = `${Math.round(9 * dpr)}px ui-monospace, "Courier New", monospace`;

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('1', padLeft - 4 * dpr, yHigh);
    ctx.textBaseline = 'bottom';
    ctx.fillText('0', padLeft - 4 * dpr, yLow);

    const twSec = timeWindow / 1000;
    const step  = twSec <= 5 ? 1 : twSec <= 15 ? 2 : twSec <= 30 ? 5 : 10;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s >= -twSec; s -= step) {
      const x = padLeft + ((twSec + s) / twSec) * drawW;
      if (x < padLeft || x > W - padRight + 2 * dpr) continue;
      ctx.fillText(s === 0 ? '0' : `${s}s`, x, padTop + drawH + 3 * dpr);
    }
  }
}

// ─────────────────────────────────────────────
// PadGauge — single capacitive touch pad, sized to fill its widget.
// ─────────────────────────────────────────────

const PAD_TOUCH_MESSAGES = [
  'Hello',
  'Welcome',
  'Nice to meet you',
  'Good to see you',
  "Let's interact",
];

export class PadGauge {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.value = 0;
    this.rawValue = null;
    this._wasActive = false;
    this._currentMsg = PAD_TOUCH_MESSAGES[0];
    this._dirty = true;
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  push(value, rawValue) {
    const active = (value ?? 0) > 0.5;
    if (active && !this._wasActive) {
      this._currentMsg = PAD_TOUCH_MESSAGES[Math.floor(Math.random() * PAD_TOUCH_MESSAGES.length)];
    }
    this._wasActive = active;
    this.value = Math.max(0, Math.min(1, value ?? 0));
    this.rawValue = typeof rawValue === 'number' ? rawValue : null;
    this._dirty = true;
  }

  destroy() { cancelAnimationFrame(this._raf); }

  _loop() {
    if (this._dirty) { this._render(); this._dirty = false; }
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  _render() {
    const { canvas, ctx } = this;
    const dpr = devicePixelRatio || 1;
    const W = canvas.width  = canvas.offsetWidth  * dpr;
    const H = canvas.height = canvas.offsetHeight * dpr;
    ctx.clearRect(0, 0, W, H);

    const pad = 10 * dpr;
    const w = Math.max(0, W - pad * 2);
    const h = Math.max(0, H - pad * 2);
    if (w <= 0 || h <= 0) return;
    const r = Math.min(22 * dpr, Math.min(w, h) * 0.18);
    const a = this.value;
    const active = a > 0.5;

    ctx.beginPath();
    ctx.roundRect(pad, pad, w, h, r);
    if (active) {
      const gradient = ctx.createLinearGradient(pad, pad, pad + w, pad + h);
      gradient.addColorStop(0, `rgba(26, 25, 22, ${0.75 + a * 0.15})`);
      gradient.addColorStop(1, `rgba(26, 25, 22, ${0.82 + a * 0.13})`);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = `rgba(26, 25, 22, ${0.03 + a * 0.08})`;
    }
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(pad, pad, w, h, r);
    ctx.strokeStyle = active ? '#1a1916' : '#ccc9c3';
    ctx.lineWidth   = (active ? 2 : 1) * dpr;
    ctx.stroke();

    if (active) {
      ctx.shadowColor = `rgba(26, 25, 22, ${0.15 * a})`;
      ctx.shadowBlur = 8 * dpr;
      ctx.strokeStyle = `rgba(26, 25, 22, ${0.2 * a})`;
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    const mainText = active ? this._currentMsg : '—';
    const rv = this.rawValue !== null ? this.rawValue : a;
    const subText = rv >= 2 ? Math.round(rv).toString() : rv.toFixed(4);

    const mainSize = Math.round(Math.min(w, h) * 0.18);
    const subSize  = Math.round(Math.min(w, h) * 0.10);
    const cx = pad + w / 2;
    const cy = pad + h / 2;

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    ctx.font      = `${mainSize}px 'SF Mono', 'Consolas', monospace`;
    ctx.fillStyle = active ? 'rgba(250,249,247,0.95)' : 'rgba(90,88,80,0.65)';
    ctx.fillText(mainText, cx, cy - mainSize * 0.38);

    ctx.font      = `${subSize}px 'SF Mono', 'Consolas', monospace`;
    ctx.fillStyle = active ? 'rgba(250,249,247,0.55)' : 'rgba(90,88,80,0.35)';
    ctx.fillText(subText, cx, cy + mainSize * 0.62);
  }
}

// ─────────────────────────────────────────────
// NumericReadout — big live value, no time buffer. DOM-based, not canvas.
// ─────────────────────────────────────────────

export class NumericReadout {
  constructor(container) {
    this.container = container;
    this.unit = '';
    container.classList.add('numeric-readout');

    this._valueEl = document.createElement('div');
    this._valueEl.className = 'numeric-readout-value';
    this._valueEl.textContent = '—';

    this._unitEl = document.createElement('div');
    this._unitEl.className = 'numeric-readout-unit';

    container.append(this._valueEl, this._unitEl);
  }

  push(value) {
    if (typeof value !== 'number' || !isFinite(value)) {
      this._valueEl.textContent = '—';
      return;
    }
    const abs = Math.abs(value);
    const decimals = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
    this._valueEl.textContent = value.toFixed(decimals);
  }

  // Bypass numeric formatting for non-quantity readouts (e.g. digital HIGH/LOW).
  pushText(text) {
    this._valueEl.textContent = text;
  }

  setUnit(unit) {
    this.unit = unit ?? '';
    this._unitEl.textContent = this.unit;
  }

  destroy() {}
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
