# Web Dashboard

Real-time sensor visualization interface. Vanilla JavaScript, no build step required.

A freeform dashboard canvas — add any combination of Analog/Digital/Capacitive channels as independent, draggable, resizable widget cards. Each widget has its own time window, Y-axis scaling, filters, and visualization mode.

## Running

1. Open the `Web_Dashboard/` folder in VS Code.
2. Start Live Server (default port 5502).
3. Open `http://localhost:5502` in Chrome or Edge.
4. Select a transport (USB Serial / Bluetooth) and connect to the ESP32-S3.
5. Click **+ Add Widget**, pick a data type, channel, and visualization, then drag/resize it into place.

## File Map

| File | Purpose |
|---|---|
| `index.html` | DOM structure — header, dashboard toolbar, canvas |
| `app.js` | Orchestrator — transport switching, routes protocol events to widgets |
| `protocol.js` | Wire format parser — auto-detects JSON vs binary frames |
| `dashboard-state.js` | Widget data model + `DashboardStore` (localStorage persistence) |
| `grid-engine.js` | Vanilla drag/resize/snap/reflow grid layout engine |
| `widget.js` | `Widget` card component — header, body, settings popover |
| `widget-modal.js` | "Add Widget" modal — type → channel → visualization → label |
| `processing.js` | Per-widget filter pipeline (`createChannelState`, `processValue`) |
| `sensors.js` | Sensor type definitions and ADC → physical unit conversion |
| `graph.js` | Visualization renderers — `LineGraph`, `StateGraph`, `PadGauge`, `NumericReadout` |
| `filters-ui.js` | Dynamic filter control panel per channel type (rendered inside each widget's popover) |
| `style.css` | Layout and design tokens (warm instrument aesthetic) |
| `transport/serial.js` | Web Serial API (USB, 115200 baud) |
| `transport/bluetooth.js` | Web Bluetooth — Nordic UART Service |
| `transport/base.js` | Abstract transport interface |

## Data Flow

```
[ESP32-S3]
    │
    │  (BLE: one combined frame @ ~30 Hz / USB Serial: legacy per-channel JSON)
    ▼
Transport Layer  (transport/*.js)
    │  emits: 'data', 'connected', 'disconnected'
    ▼
Protocol Parser  (protocol.js)
    │  outputs: { type, channel, value, timestamp, unit?, isVoltage? }
    ▼
app.js#routeValue — forwards to every widget watching that (type, channel)
    │
    ▼
Widget#handleValue  (widget.js)
    │
    ├── processing.js#processValue — Stage 1: Preprocessing, Stage 2: Filtering
    │     (independent per widget, not per physical channel)
    │
    ▼
Visualization  (graph.js)
    ├── LineGraph     — scrolling waveform, auto OR manually-fixed Y-axis
    ├── StateGraph    — step waveform, HIGH/LOW fill
    ├── PadGauge      — single capacitive touch pad
    └── NumericReadout— big live value, no time buffer
```

## Widget Settings (per widget, independent)

- **Time window** — 1s / 5s / 10s / 30s / 60s chips, always visible on the widget's header bar (line & state visualizations) — no menu needed
- **Label** — editable directly in the widget header
- **Filters** (▤ button) — sensor type (analog only), preprocessing, and filtering stages, scoped to this widget
- **Settings** (⚙ button) — Y-axis autoscale toggle or manual min/max (line visualization only), plus the raw/processed/filtered/amplitude/timestamp readout

Layout (position + size) and all of the above settings persist to `localStorage` (`sensing-dashboard-v1`).

## Channel Configuration

| Type | Count | Value Range |
|---|---|---|
| Analog | 4 (ch 0–3) | Volts (ADS1115, ~0–4.1V), or physical unit after sensor-type conversion |
| Digital | 4 (ch 0–3) | 0 or 1 |
| Capacitive | 12 (ch 0–11) | 0 or 1 (MPR121 touch bitmask) |

## BLE — Combined Sensor Frame

One frame per transmit tick (~30 Hz) — not three separate analog/digital/
capacitive packets. Sent by both the real firmware and the test simulator:

```json
{"m":"data","ts":123456,"a":[1.234,2.345,0.120,3.210],"d":[1,0,1,1],"c":[0,0,1,0,0,0,0,0,0,0,0,0]}
```

- `"a"` — always 4 values, already in **volts** (not raw ADC counts)
- `"d"` — always 4 values, 0/1
- `"c"` — always 12 values, 0/1
- `"ts"` — `millis()` on the device, used for latency diagnostics
- No per-channel ids or unit strings on the wire

Status frame, sent once on connect:
```json
{"t":"s","a":4,"d":4,"c":12}
```

## Legacy / USB Serial — JSON Message Formats

Still parsed for backwards compatibility with older firmware or Serial sources:
```json
{"t":"a","ch":0,"v":512,"ts":12345}
{"m":"a","c":[{"id":0,"v":24.5,"u":"°C"},{"id":1,"v":55.0,"u":"%"}]}
{"m":"d","c":[{"id":0,"v":1},{"id":1,"v":0}]}
{"m":"c","c":[0.43,0.12,0.67,...]}
```

## Bluetooth LE

Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e` (Nordic UART)  
TX Characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`  
NOTIFY only (not INDICATE) — the firmware drops a frame rather than queue/block if the link is busy.

## Dependencies

No npm packages. All APIs are native browser:
- HTML5 Canvas + requestAnimationFrame
- Web Serial API (Chrome/Edge, requires HTTPS or localhost)
- Web Bluetooth API (Chrome/Edge, requires HTTPS or localhost)
- ResizeObserver, PointerEvent (grid drag/resize)
