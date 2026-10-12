// Protocol — decodes sensor frames from any transport into typed channel events.
//
// Wire formats, detected automatically:
//
//   Combined sensor frame (BLE, ~30 Hz) — one frame per tick instead of
//   separate analog/digital/capacitive packets:
//     {"m":"data","ts":123456,"a":[v0,v1,v2,v3],"d":[0,1,0,1],"c":[0,0,1,...12]}
//     "a" is always 4 values already in volts (straight from the ADS1115 —
//     not raw 0–4095 ADC counts), "d" is always 4, "c" is always 12.
//
//   JSON (USB Serial), legacy per-channel frames:
//     {"t":"a","ch":0,"v":512,"ts":12345}   analog   (v: 0–4095 raw ADC)
//     {"t":"d","ch":0,"v":1,"ts":12346}     digital  (v: 0 or 1)
//     {"t":"c","ch":5,"v":0.73,"ts":12347}  capacitive (v: 0.0–1.0)
//     {"t":"s","a":2,"d":4,"c":8}           status
//
//   Binary (Bluetooth, 8 bytes little-endian, legacy):
//     offset 0  uint8   type  0=analog 1=digital 2=capacitive 3=status
//     offset 1  uint8   channel
//     offset 2  uint16  value (analog 0–4095; cap 0–65535 scaled to 0.0–1.0)
//     offset 4  uint32  timestamp ms
//     Status frame: bytes 1,2,3 = analogCount, digitalCount, capCount
//
// Dispatches CustomEvents: 'analog', 'digital', 'capacitive', 'status'
// Each event.detail: { channel, value, timestamp }
// Analog detail additionally carries either `unit` (already a final physical
// value, e.g. from the legacy multi-channel format) or `isVoltage: true`
// (already volts, from the combined frame) — see widget.js#handleValue.

export class Protocol extends EventTarget {
  constructor() {
    super();
    this._lastLatencyLog = 0;
  }

  receive(rawData) {
    if (rawData instanceof ArrayBuffer) {
      this._receiveBinary(rawData);
    } else {
      this._receiveJSON(rawData);
    }
  }

  _receiveBinary(buffer) {
    if (buffer.byteLength < 8) return;
    const view      = new DataView(buffer);
    const type      = view.getUint8(0);
    const channel   = view.getUint8(1);
    const raw16     = view.getUint16(2, true); // little-endian
    const timestamp = view.getUint32(4, true);

    switch (type) {
      case 0:
        this.dispatchEvent(new CustomEvent('analog',
          { detail: { channel, value: raw16, timestamp } }));
        break;
      case 1:
        this.dispatchEvent(new CustomEvent('digital',
          { detail: { channel, value: raw16 !== 0, timestamp } }));
        break;
      case 2:
        this.dispatchEvent(new CustomEvent('capacitive',
          { detail: { channel, value: raw16 / 65535, timestamp } }));
        break;
      case 3: {
        const analogCount     = view.getUint8(1);
        const digitalCount    = view.getUint8(2);
        const capacitiveCount = view.getUint8(3);
        this.dispatchEvent(new CustomEvent('status',
          { detail: { analogCount, digitalCount, capacitiveCount } }));
        break;
      }
    }
  }

  _receiveJSON(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return;
    }

    if (!msg) return;

    // Combined sensor frame: {"m":"data","ts":…,"a":[…4],"d":[…4],"c":[…12]}
    // Checked before the multi-channel branch below — otherwise "data"
    // would be misread as a mode and msg.c (the capacitive array) would be
    // misinterpreted as that mode's channel list.
    if (msg.m === 'data') {
      this._receiveSensorFrame(msg);
      return;
    }

    // Multi-channel format: {"m":"a","c":[{"id":0,"v":24.5,"u":"°C"},…]}
    const mode     = msg.m ?? msg.mode;
    const channels = msg.c ?? msg.channels;
    if (mode && Array.isArray(channels)) {
      this._receiveMultiChannel(mode, channels);
      return;
    }

    if (typeof msg.t !== 'string') return;

    const timestamp = typeof msg.ts === 'number' ? msg.ts : Date.now();
    const channel   = typeof msg.ch === 'number' ? msg.ch : 0;
    const value     = typeof msg.v  === 'number' ? msg.v  : 0;

    if (msg.type === 'status' || msg.t === 's') {
      this.dispatchEvent(new CustomEvent('status', {
        detail: {
          analogCount:     typeof msg.analogCount     === 'number' ? msg.analogCount     : (msg.a ?? 4),
          digitalCount:    typeof msg.digitalCount    === 'number' ? msg.digitalCount    : (msg.d ?? 4),
          capacitiveCount: typeof msg.capacitiveCount === 'number' ? msg.capacitiveCount : (msg.c ?? 0),
        }
      }));
      return;
    }

    switch (msg.t) {
      case 'a':
        this.dispatchEvent(new CustomEvent('analog',
          { detail: { channel, value, timestamp } }));
        break;
      case 'd':
        this.dispatchEvent(new CustomEvent('digital',
          { detail: { channel, value: value !== 0, timestamp } }));
        break;
      case 'c':
        this.dispatchEvent(new CustomEvent('capacitive',
          { detail: { channel, value, timestamp } }));
        break;
    }
  }

  // One frame, all channels — replaces what used to be three separate
  // analog/digital/capacitive packets per tick. Fixed-length arrays, no
  // per-channel ids/units on the wire (see header comment for the shape).
  _receiveSensorFrame(msg) {
    const timestamp = typeof msg.ts === 'number' ? msg.ts : Date.now();

    // Temporary backlog diagnostic — throttled to ~1/s so it doesn't flood
    // the console at 30 Hz. Flat latency = fine; latency that keeps growing
    // means frames are backing up somewhere between the BLE stack and here.
    if (typeof msg.ts === 'number') {
      const now = Date.now();
      if (now - this._lastLatencyLog > 1000) {
        this._lastLatencyLog = now;
        console.log(`[protocol] latency ~${now - msg.ts}ms  (Date.now()=${now}, msg.ts=${msg.ts})`);
      }
    }

    if (Array.isArray(msg.a)) {
      for (let ch = 0; ch < msg.a.length; ch++) {
        // "a" is raw int16_t ADC counts — not volts (isVoltage omitted)
        this.dispatchEvent(new CustomEvent('analog', {
          detail: { channel: ch, value: msg.a[ch], timestamp }
        }));
      }
    }
    if (Array.isArray(msg.d)) {
      for (let ch = 0; ch < msg.d.length; ch++) {
        this.dispatchEvent(new CustomEvent('digital', {
          detail: { channel: ch, value: msg.d[ch] !== 0, timestamp }
        }));
      }
    }
    if (Array.isArray(msg.c)) {
      // "ct" = hardware touch bitmask (bit N = electrode N), "cb" = baseline array
      const touchBits = typeof msg.ct === 'number' ? msg.ct : null;
      for (let ch = 0; ch < msg.c.length; ch++) {
        const touched  = touchBits !== null ? ((touchBits >> ch) & 1) === 1 : null;
        const baseline = Array.isArray(msg.cb) && msg.cb[ch] !== undefined ? msg.cb[ch] : null;
        this.dispatchEvent(new CustomEvent('capacitive', {
          detail: { channel: ch, value: msg.c[ch], touched, baseline, timestamp }
        }));
      }
    }
  }

  _receiveMultiChannel(mode, channels) {
    const timestamp = Date.now();
    for (let i = 0; i < channels.length; i++) {
      const ch    = channels[i];
      // Support both positional arrays of numbers [v0, v1, …] and object arrays [{id,v}, …]
      const isNum = typeof ch === 'number';
      const id    = isNum ? i : (typeof ch.id === 'number' ? ch.id : i);
      const value = isNum ? ch : (typeof ch.v === 'number' ? ch.v : typeof ch.value === 'number' ? ch.value : 0);
      const unit  = isNum ? null : (ch.u ?? ch.unit ?? null);

      if (mode === 'd' || mode === 'digital') {
        const state = isNum ? value : (typeof ch.state === 'number' ? ch.state : value);
        this.dispatchEvent(new CustomEvent('digital', {
          detail: { channel: id, value: state !== 0, timestamp }
        }));
      } else if (mode === 'c' || mode === 'capacitive') {
        this.dispatchEvent(new CustomEvent('capacitive', {
          detail: { channel: id, value, timestamp }
        }));
      } else {
        this.dispatchEvent(new CustomEvent('analog', {
          detail: { channel: id, value, timestamp, unit }
        }));
      }
    }
  }
}
