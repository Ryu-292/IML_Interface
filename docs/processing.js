// processing.js — Per-widget signal processing pipeline.
//
// Pure functions, no module-level state: each widget owns its own state
// object (via createChannelState()) so the same physical channel can feed
// multiple widgets with independent filter configs and stateful buffers.

// ── Per-widget state (config + stateful filter values) ────────────────────────
export function createChannelState() {
  return {
    config: {}, lastRaw: null, baseline: null, lastT: null,
    // analog / capacitive filter state
    emaValue: null, lpValue: null, hpValue: null, hpLastRaw: null,
    movingAvgBuf: [], ampBuf: [],
    notch: null,
    // digital filter state
    glitch: null, edgeState: null, dutyBuf: null,
    // capacitive filter state
    lastCappedValue: undefined, baseline2: undefined, hystState: undefined,
    // shared debounce
    debounceCandidate: undefined, debounceTime: 0, debounceStable: undefined,
  };
}

// Reset all stateful filter buffers — call on config change to prevent artifacts.
export function resetFilterState(state) {
  state.emaValue = null; state.lpValue = null;
  state.hpValue  = null; state.hpLastRaw = null;
  state.movingAvgBuf = [];
  state.notch = null; state.glitch = null; state.edgeState = null; state.dutyBuf = null;
  state.baseline2 = undefined; state.hystState = undefined; state.lastCappedValue = undefined;
}

// ── Processing pipeline ───────────────────────────────────────────────────────
// Two-stage filter architecture: preprocessing (calibration/scaling/thresholding)
// feeds filtering (smoothing/edge/baseline). Each stage has an independent
// ON/OFF toggle stored in state.config.
export function processValue(raw, state, type) {
  const cfg    = state.config;
  const now    = Date.now();
  const dt     = state.lastT ? Math.min((now - state.lastT) / 1000, 0.5) : 0.02;
  state.lastT  = now;
  state.lastRaw = raw;

  const preprocOn = cfg['preprocessingEnabled'] === true;
  const filterOn  = cfg['filteringEnabled']     === true;

  let v = raw;

  // ── PREPROCESSING ────────────────────────────────────────────────────────────
  if (preprocOn) {
    if (type === 'analog') {
      // Moving average
      const win = Math.max(1, Math.round(cfg['moving-avg'] ?? 1));
      if (win > 1) {
        state.movingAvgBuf.push(v);
        if (state.movingAvgBuf.length > win) state.movingAvgBuf.shift();
        v = state.movingAvgBuf.reduce((a, b) => a + b, 0) / state.movingAvgBuf.length;
      } else { state.movingAvgBuf = []; }

      // DC offset calibration
      if (cfg['zero-offset']) {
        if (state.baseline === null) state.baseline = v;
        v -= state.baseline;
      } else { state.baseline = null; }

      // Input clamp
      const cMin = Number(cfg['clamp-min'] ?? '');
      const cMax = Number(cfg['clamp-max'] ?? '');
      if (cfg['clamp-min'] !== '' && isFinite(cMin)) v = Math.max(cMin, v);
      if (cfg['clamp-max'] !== '' && isFinite(cMax)) v = Math.min(cMax, v);

      // Scale × and Offset +
      const scale  = Number(cfg['scale']  ?? '');
      const offset = Number(cfg['offset'] ?? '');
      if (cfg['scale']  !== '' && isFinite(scale)  && scale  !== 0) v = v * scale;
      if (cfg['offset'] !== '' && isFinite(offset) && offset !== 0) v = v + offset;

      // Min/max scaling
      const calMin = Number(cfg['cal-min'] ?? '');
      const calMax = Number(cfg['cal-max'] ?? '');
      if (cfg['cal-min'] !== '' && cfg['cal-max'] !== '' && isFinite(calMin) && isFinite(calMax) && calMax !== calMin) {
        v = (v - calMin) / (calMax - calMin);
      }
    }

    if (type === 'digital') {
      // Logic threshold
      v = v > (cfg['threshold'] ?? 0.5) ? 1 : 0;
      // Invert
      if (cfg['invert-digital']) v = 1 - v;
      // Debounce
      const debMs = Number(cfg['debounce-ms'] || 0);
      if (debMs > 0) {
        if (v !== state.debounceCandidate) { state.debounceCandidate = v; state.debounceTime = now; }
        if (now - state.debounceTime >= debMs) state.debounceStable = state.debounceCandidate;
        v = state.debounceStable ?? v;
      } else { state.debounceCandidate = undefined; state.debounceStable = undefined; }
    }

    if (type === 'capacitive') {
      // Noise gate — zero out if below threshold (raw counts, 0 = off)
      const gate = Number(cfg['noise-gate'] || 0);
      if (gate > 0 && v < gate) v = 0;
      // Clamp — '' means not set (off); values in raw electrode counts
      const cMin = cfg['cap-clamp-min'];
      const cMax = cfg['cap-clamp-max'];
      if (cMin !== '' && cMin !== undefined && isFinite(Number(cMin))) v = Math.max(Number(cMin), v);
      if (cMax !== '' && cMax !== undefined && isFinite(Number(cMax))) v = Math.min(Number(cMax), v);
      // Max delta clamp — limits change per sample (raw counts, 0 = off)
      const maxDelta = cfg['max-delta'] !== '' && cfg['max-delta'] !== undefined ? Number(cfg['max-delta']) : 0;
      if (maxDelta > 0 && state.lastCappedValue !== undefined) {
        const d = v - state.lastCappedValue;
        if (Math.abs(d) > maxDelta) v = state.lastCappedValue + Math.sign(d) * maxDelta;
      }
      state.lastCappedValue = v;
      // Debounce
      const capDeb = Number(cfg['cap-debounce'] || 0);
      if (capDeb > 0) {
        if (v !== state.debounceCandidate) { state.debounceCandidate = v; state.debounceTime = now; }
        if (now - state.debounceTime >= capDeb) state.debounceStable = state.debounceCandidate;
        v = state.debounceStable ?? v;
      } else { state.debounceCandidate = undefined; state.debounceStable = undefined; }
    }
  } else {
    state.baseline = null; state.movingAvgBuf = [];
    state.debounceCandidate = undefined; state.debounceStable = undefined;
    state.lastCappedValue   = undefined;
  }

  const preprocessed = v;

  // ── FILTERING ────────────────────────────────────────────────────────────────
  if (filterOn) {
    if (type === 'analog') {
      // EMA smoothing
      const alpha = cfg['ema-alpha'] ?? 1;
      if (alpha < 1) {
        state.emaValue = state.emaValue === null ? v : alpha * v + (1 - alpha) * state.emaValue;
        v = state.emaValue;
      } else { state.emaValue = null; }

      // Low-pass IIR
      const lpHz = Number(cfg['lowpass-cutoff'] || 0);
      if (lpHz > 0) {
        const a = dt / (1 / (2 * Math.PI * lpHz) + dt);
        state.lpValue = state.lpValue === null ? v : state.lpValue + a * (v - state.lpValue);
        v = state.lpValue;
      } else { state.lpValue = null; }

      // High-pass IIR
      const hpHz = Number(cfg['highpass-cutoff'] || 0);
      if (hpHz > 0) {
        const a = (1 / (2 * Math.PI * hpHz)) / (1 / (2 * Math.PI * hpHz) + dt);
        state.hpValue = a * ((state.hpValue ?? 0) + v - (state.hpLastRaw ?? v));
        state.hpLastRaw = v;
        v = state.hpValue;
      } else { state.hpValue = null; state.hpLastRaw = null; }

      // Notch filter (2nd-order IIR)
      const notchHz = Number(cfg['notch-hz'] || 0);
      if (notchHz > 0) {
        const w0 = 2 * Math.PI * notchHz * dt;
        const r  = 0.95;
        const c  = Math.cos(w0);
        if (!state.notch) state.notch = { x1: v, x2: v, y1: v, y2: v };
        const x = v;
        const y = x - 2*c*state.notch.x1 + state.notch.x2
                + 2*r*c*state.notch.y1 - r*r*state.notch.y2;
        state.notch.x2 = state.notch.x1; state.notch.x1 = x;
        state.notch.y2 = state.notch.y1; state.notch.y1 = y;
        v = y;
      } else { state.notch = null; }
    }

    if (type === 'digital') {
      // Glitch rejection — discard pulses shorter than N ms
      const glitchMs = Number(cfg['glitch-ms'] || 0);
      if (glitchMs > 0) {
        if (!state.glitch) state.glitch = { lastChange: now, stableValue: v, lastValue: v };
        if (v !== state.glitch.lastValue) { state.glitch.lastChange = now; state.glitch.lastValue = v; }
        if (now - state.glitch.lastChange >= glitchMs) state.glitch.stableValue = v;
        v = state.glitch.stableValue;
      } else { state.glitch = null; }

      // Edge trigger — output 1 only on the selected transition, 0 otherwise
      const edge = cfg['edge-trigger'] ?? 'both';
      if (edge !== 'both') {
        if (!state.edgeState) state.edgeState = { prev: v };
        const rising  = v === 1 && state.edgeState.prev === 0;
        const falling = v === 0 && state.edgeState.prev === 1;
        state.edgeState.prev = v;
        v = (edge === 'rising' && rising) || (edge === 'falling' && falling) ? 1 : 0;
      } else { state.edgeState = null; }

      // Duty cycle — rolling mean of 0/1 values over a time window
      const dutyMs = Number(cfg['duty-window-ms'] || 0);
      if (dutyMs > 0) {
        if (!state.dutyBuf) state.dutyBuf = [];
        state.dutyBuf.push({ t: now, v });
        const cut = now - dutyMs;
        while (state.dutyBuf.length > 0 && state.dutyBuf[0].t < cut) state.dutyBuf.shift();
        v = state.dutyBuf.reduce((s, p) => s + p.v, 0) / state.dutyBuf.length;
      } else { state.dutyBuf = null; }
    }

    if (type === 'capacitive') {
      // Dynamic baseline tracking — slow EMA subtracted from signal
      const baseAlpha = cfg['baseline-alpha'] ?? 0;
      if (baseAlpha > 0) {
        state.baseline2 = state.baseline2 === undefined ? v : baseAlpha * v + (1 - baseAlpha) * state.baseline2;
        v = Math.max(0, v - state.baseline2);
      } else { state.baseline2 = undefined; }

      // EMA smoothing
      const capAlpha = cfg['cap-smoothing'] ?? 1;
      if (capAlpha < 1) {
        state.emaValue = state.emaValue === null ? v : capAlpha * v + (1 - capAlpha) * state.emaValue;
        v = state.emaValue;
      } else { state.emaValue = null; }

      // Hysteresis trigger (enabled when hyst-high > 0)
      const hystHigh = cfg['hyst-high'] ?? 0;
      const hystLow  = cfg['hyst-low']  ?? 0.3;
      if (hystHigh > 0) {
        if (state.hystState === undefined) state.hystState = false;
        if (v >= hystHigh) state.hystState = true;
        if (v <= hystLow)  state.hystState = false;
        v = state.hystState ? 1 : 0;
      } else {
        state.hystState = undefined;
      }
    }
  } else {
    state.emaValue = null; state.lpValue = null;
    state.hpValue  = null; state.hpLastRaw = null;
    state.notch    = null; state.glitch   = null;
    state.edgeState = null; state.dutyBuf = null;
    state.baseline2 = undefined; state.hystState = undefined;
  }

  const filtered = v;

  // Amplitude — rolling peak-to-peak on preprocessed (not filtered)
  state.ampBuf.push(preprocessed);
  if (state.ampBuf.length > 120) state.ampBuf.shift();
  const amplitude = state.ampBuf.length > 1
    ? Math.max(...state.ampBuf) - Math.min(...state.ampBuf) : 0;

  return { preprocessed, filtered, amplitude };
}
