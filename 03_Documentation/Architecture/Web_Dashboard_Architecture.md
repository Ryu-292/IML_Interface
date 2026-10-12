# Web Dashboard Architecture

Source: `01_Software/Web_Dashboard/`  
Stack: Vanilla JavaScript, HTML5 Canvas, no build step, no npm dependencies.

---

## Module Overview

```
index.html          DOM skeleton
app.js              Orchestrator — owns all state and wires everything together
protocol.js         Wire format parser
sensors.js          Sensor type registry and unit conversion
graph.js            Canvas renderers
filters-ui.js       Filter control panel (dynamic, per channel type)
style.css           Layout and design tokens
transport/
  base.js           Abstract transport interface
  websocket.js      WebSocket transport
  serial.js         Web Serial API (USB)
  bluetooth.js      Web Bluetooth (BLE, Nordic UART)
```

---

## Transport Layer

All transports extend `BaseTransport` and emit three events:

| Event | Payload | Meaning |
|---|---|---|
| `data` | raw string or ArrayBuffer | New frame from device |
| `connected` | — | Link established |
| `disconnected` | — | Link lost |

### WebSocket (`transport/websocket.js`)
- Prompts user for URL on connect
- Buffers partial lines; emits on `\n` delimiter
- Reconnect is manual (user clicks connect again)

### USB Serial (`transport/serial.js`)
- Uses Web Serial API — Chrome/Edge only, requires localhost or HTTPS
- Baud rate: 115200
- Streams UTF-8 text, newline-delimited

### Bluetooth LE (`transport/bluetooth.js`)
- Service: Nordic UART Service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- TX characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e` (device → browser, notify)
- Frames: 8-byte binary little-endian or JSON over UART

---

## Protocol Parser (`protocol.js`)

Auto-detects frame format from the first byte:

| Condition | Format | Parser |
|---|---|---|
| First char is `{` | JSON | `JSON.parse()` → normalized object |
| Raw ArrayBuffer, 8 bytes | Binary | DataView little-endian decode |

### JSON Formats

```json
// Single channel
{"t":"a","ch":0,"v":512,"ts":12345}       // analog
{"t":"d","ch":0,"v":1,"ts":12346}         // digital
{"t":"c","ch":5,"v":0.73,"ts":12347}      // capacitive
{"t":"s","a":2,"d":4,"c":8}              // status (channel counts)

// Multi-channel compact
{"m":"a","c":[{"id":0,"v":24.5,"u":"°C"},{"id":1,"v":55.0,"u":"%"}]}
{"m":"d","c":[{"id":0,"v":1},{"id":1,"v":0}]}
{"m":"c","c":[0.43,0.12,0.67,...]}
```

### Binary Format (BLE)

```
Offset  Size    Field
0       1 byte  type: 0=analog, 1=digital, 2=capacitive, 3=status
1       1 byte  channel index
2       2 bytes uint16 value (little-endian)
4       4 bytes uint32 timestamp ms (little-endian)
```

---

## Processing Pipeline (`app.js → processValue`)

Every incoming data point passes through two optional stages:

### Stage 1 — Preprocessing

| Signal type | Operations |
|---|---|
| Analog | Moving average (1–20 samples), DC offset, input clamp, scale (×), offset (+), min/max calibration mapping |
| Digital | Threshold, logic invert, debounce |
| Capacitive | Noise gate, clamp, max-delta clamp, debounce |

### Stage 2 — Filtering

| Signal type | Operations |
|---|---|
| Analog | EMA smoothing, low-pass IIR, high-pass IIR, notch filter |
| Digital | Glitch rejection, edge trigger (rising/falling/both), duty cycle measurement |
| Capacitive | Baseline tracking (dynamic EMA), EMA smoothing, hysteresis trigger, touch threshold |

### Output

```js
{ preprocessed: Number, filtered: Number, amplitude: Number }
// amplitude = rolling peak-to-peak over the last 120 preprocessed samples
```

---

## Visualization (`graph.js`)

All renderers use `requestAnimationFrame` with dirty flags and support high-DPI displays.

### AnalogGraph
- Scrolling waveform, configurable time window (1s / 5s / 10s / 30s / 60s)
- Auto-scaling Y-axis with labeled grid lines
- Renders both preprocessed and filtered traces

### DigitalGraph
- Step waveform (horizontal lines, vertical transitions)
- HIGH/LOW fill regions

### CapCanvas
- Free-draggable pad grid (12 pads max)
- Pad positions persisted to `localStorage`
- Color intensity maps to normalized touch value (0.0–1.0)

---

## Filter UI (`filters-ui.js`)

Generates filter control panels dynamically based on channel type. Controls include sliders, toggles, and number inputs. Filter state is stored in per-channel config objects in `app.js` and applied on the next data frame.

---

## State Management

All state lives in `app.js`:
- `analogChannels[4]`, `digitalChannels[4]`, `capChannels[12]` — per-channel config and filter state
- Transport instance — current active transport object
- Channel counts — updated by status frames or inferred from highest seen channel index

No external state library. No build step. Reload the page to reset all state.

---

## Sensor Type System (`sensors.js`)

11 built-in sensor types: LM35, TMP36, humidity, distance, light, and others. Each defines:
- `name` — display label
- `unit` — physical unit string
- `convert(adcValue, vRef)` — ADC raw → physical unit function

Custom sensor type is also supported (user-defined formula).
