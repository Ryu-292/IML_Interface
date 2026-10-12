# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A real-time sensor data visualization dashboard built with vanilla JavaScript. Receives sensor data from embedded devices (ESP32/microcontrollers) via Bluetooth or USB Serial, processes it through configurable per-widget filter pipelines, and visualizes analog waveforms, digital signals, and capacitive touch data on a freeform widget grid.

## Running the Application

This is a static web application with no build step. To run:

```bash
# Open index.html in a browser, or use a local server
# VS Code Live Server is configured on port 5502 (.vscode/settings.json)
# Alternatively, use Python:
python -m http.server 5502
```

Then navigate to `http://localhost:5502`

## Architecture Overview

### Data Flow Pipeline

```
Transport Layer → Protocol Parser → app.js routing → Widget(s) → per-widget pipeline → Visualization
```

1. **Transport Layer** (`transport/`): Abstracts connection methods
   - `base.js`: BaseTransport interface that all transports extend
   - `serial.js`: Web Serial API for USB connections
   - `bluetooth.js`: Web Bluetooth API (requires UUID configuration)
   - All transports emit `'data'`, `'connected'`, and `'disconnected'` events

2. **Protocol Parser** (`protocol.js`): Converts newline-delimited JSON frames into typed events
   - Primary wire format — one combined frame per BLE tick (~30 Hz), not three separate packets: `{"m":"data","ts":123456,"a":[v0..v3],"d":[0/1 x4],"c":[0.0–1.0 x12]}`. `"a"` is already volts (straight from the ADS1115), fixed-length arrays, no per-channel ids/units. `"c"` is a normalized raw capacitive signal per electrode (0.0 at rest, positive when touched — computed from MPR121 `filteredData`/`baselineData`), not the binary `touched()` bitmask; the software touch threshold is applied on the dashboard side.
   - Legacy per-channel JSON (USB Serial / older firmware) still supported: `{"t":"a","ch":0,"v":512,"ts":12345}` (raw ADC counts)
   - Emits CustomEvents: `'analog'`, `'digital'`, `'capacitive'`, `'status'`. Analog events from the combined frame carry `isVoltage: true` so `widget.js` applies the sensor-type formula directly to volts instead of re-deriving voltage from a raw ADC count.
   - Also logs a throttled (~1/s) `Date.now()` vs `msg.ts` latency line to the console — temporary diagnostic for tracking down BLE/render backlog.
   - The `status` event is parsed but no longer consumed — channel visibility is explicit (the user adds a widget per channel) rather than auto-detected.

3. **Routing** (`app.js`): `routeValue(type, channel, value, timestamp, unit, isVoltage)` forwards each incoming frame to *every* widget currently watching that `(type, channel)` pair. Zero, one, or many widgets may watch the same physical channel, each with independent filters/display.

4. **Processing Pipeline** (`processing.js → processValue()`): Two-stage filter architecture, one independent instance **per widget** (not per channel)
   - **Preprocessing stage**: Calibration, scaling, thresholding, clamping
   - **Filtering stage**: EMA, low-pass, high-pass, notch filters, glitch rejection
   - Each stage has an independent ON/OFF toggle per widget
   - Returns `{ preprocessed, filtered, amplitude }` — preprocessing feeds filtering

5. **Visualization** (`graph.js`):
   - `LineGraph`: Scrolling time-series waveform — auto-scaling OR manually fixed Y-axis (`setAutoscale()` / `setYRange()`). Used for any data type's 'line' viz mode.
   - `StateGraph`: Step waveform with HIGH/LOW fill regions. Used for digital's 'state' viz mode.
   - `PadGauge`: Single capacitive touch pad, sized to fill its widget. Used for capacitive's 'pad' viz mode.
   - `NumericReadout`: DOM-based big live value (no time buffer). Used for any data type's 'numeric' viz mode.

6. **Widget** (`widget.js`): One dashboard card = header (drag handle, editable label, live value, filters button, settings gear, remove) + an always-visible time-window bar (line/state viz modes only) + body (one of the above visualizations) + two focused popovers opened on demand:
   - **Filters** — sensor type (analog), preprocessing, filtering (`FiltersPanel`)
   - **Settings** — Y-axis scaling (line only), raw/processed/filtered/amplitude/timestamp readout

### State Management

**Dashboard state** (`dashboard-state.js`):
- `DashboardStore`: holds the array of widget records, persists to `localStorage` (`sensing-dashboard-v1`), exposes `add`/`remove`/`update`/`updateLayout`/`onChange`.
- Widget record: `{ id, dataType, channel, vizMode, label, layout:{x,y,w,h}, timeWindow, yAxis:{autoscale,min,max}, filterConfig, sensor }`.
- `CHANNEL_COUNT` — max channel index per type (analog 4, digital 4, capacitive 12), used by the Add Widget modal.
- `VIZ_MODES` — which visualization modes are offered per data type.

**Grid layout** (`grid-engine.js`):
- `GridEngine`: vanilla "iPhone home screen" style layout. Integer grid coordinates (`x,y,w,h`) mapped to pixels (`cols`, `rowHeight`, `margin`). Pointer-driven drag/resize with a vertical-compaction pass (`compact()`) that flows other widgets around whichever one is fixed (being dragged/resized) — nothing ever overlaps. `autoPlace(size)` finds the first free slot for a new widget. No external dependency (the project ships no build step / npm packages); the model mirrors react-grid-layout but is hand-rolled.
- Layout changes are reported via `onLayoutChange(cb)`, which `app.js` uses to persist `{x,y,w,h}` back into `DashboardStore`.

**Per-widget runtime state** (owned by the `Widget` instance, not persisted):
- `filterState`: created via `processing.js#createChannelState()`, seeded from the widget's persisted `filterConfig` on load.
- `sensor`: analog-only sensor conversion state (`sensors.js#createSensorState()`), seeded from the widget's persisted `sensor`.
- `viz`: the live visualization instance (`LineGraph`/`StateGraph`/`PadGauge`/`NumericReadout`).

## Key Implementation Details

### Filter Pipeline Execution

`processValue()` in `processing.js` is the heart of the signal processing — pure function, no module-level state, so each widget can call it with its own `state` object:

1. Applies preprocessing (if `preprocessingEnabled: true` in that widget's `filterConfig`)
2. Stores result in `preprocessed`
3. Applies filtering to `preprocessed` (if `filteringEnabled: true`)
4. Stores result in `filtered`
5. Computes amplitude from preprocessed signal (not filtered)
6. Returns all three values for display

Each filter maintains internal state in the widget's `filterState` object. On config change (`FiltersPanel.onChange`), all stateful buffers are reset via `resetFilterState()` to prevent artifacts — see `Widget._wireFiltersPanel()` in `widget.js`.

Note: a widget's `filterConfig` starts as `{}` and stays that way (preprocessing/filtering effectively off, even though the UI toggle shows "ON" by default) until the user actually touches a control in that widget's Filters popover at least once. This mirrors the original per-channel behavior exactly.

### Transport Switching

Unchanged from before — transports are fully decoupled from rendering:
1. Remove event listeners from current transport
2. Disconnect if connected
3. Create new transport instance
4. Attach event listeners for `'data'`, `'connected'`, `'disconnected'`
5. Call `transport.connect()` (may throw if user cancels browser dialog)

Only Bluetooth and USB Serial are supported — both are device-initiated connections (no server URL to configure).

### Canvas Rendering

`LineGraph`, `StateGraph`, and `PadGauge` all use requestAnimationFrame loops with dirty flags:
- Set `_dirty = true` on data push
- Render only when dirty
- High-DPI support via `devicePixelRatio`
- Time-based X-axis trimming (removes old data outside time window) for the two graph types

### Grid / Widget Lifecycle

- Adding a widget: `WidgetModal` collects `{dataType, channel, vizMode, label}` → `DashboardStore.add(def, placeFn)` calls `GridEngine.autoPlace(size)` for a free slot → `app.js#mountWidget()` builds the `Widget` and registers it with `GridEngine.addItem()`.
- Removing a widget: the card's × button calls `Widget.destroy()` then `app.js#handleWidgetRemoved()`, which removes it from `GridEngine` and `DashboardStore`.
- Dragging/resizing: live preview reflows other widgets around the fixed (dragged/resized) one; on drop, a full top-compaction pass settles gaps and the new layout is persisted.
- A single popover (Filters or Settings, on any widget) is open at a time (`widget.js` module-level singleton `_openPopover`); it closes on outside click, Escape, window resize, or dashboard canvas scroll.

## Wire Protocol

The real firmware and the BLE simulator both send one combined frame per
transmit tick (~30 Hz) instead of separate analog/digital/capacitive packets:

```json
{"m":"data","ts":123456,"a":[1.234,2.345,0.120,3.210],"d":[1,0,1,1],"c":[0,0,1,0,0,0,0,0,0,0,0,0]}
```

- `"a"` — always 4 values, already in **volts** (straight off the ADS1115, not raw 0–4095 ADC counts)
- `"d"` — always 4 values, 0/1
- `"c"` — always 12 values, 0.0–1.0 normalized raw signal per electrode (`(baseline − filtered) / baseline` from MPR121 registers, 0.0 at rest, ~0.02–0.10 for resistive pads, ~0.15+ for direct metal). Software touch threshold applied on dashboard, not in firmware.
- `"ts"` — `millis()` on the device, for measuring dashboard-side latency
- No per-channel ids or unit strings on the wire — fixed-length positional arrays only

Newline-delimited JSON frames are still accepted from legacy/USB-Serial sources:

```json
{"t":"a","ch":0,"v":512,"ts":12345}   // Analog: ch 0–3, v 0–4095 raw ADC counts
{"t":"d","ch":1,"v":1,"ts":12346}     // Digital: ch 0–3, v 0/1
{"t":"c","ch":5,"v":0.73,"ts":12347}  // Capacitive: ch 0–11, v 0.0–1.0
{"t":"s","a":2,"d":4,"c":8}           // Status: channel counts (parsed, currently unused)
```

- `ts` (timestamp) is optional; defaults to `Date.now()` if missing
- Status frames can also use long-form keys: `{"type":"status","analogCount":2,...}`

## Common Tasks

### Adding a New Filter

1. Define it in `STAGE_DEFS` in `filters-ui.js` (under appropriate stage)
2. Implement logic in `processValue()` in `processing.js` (in preprocessing or filtering block)
3. Add state variables to `createChannelState()` if filter is stateful
4. Reset state in `resetFilterState()` to avoid artifacts

### Adding a New Visualization Mode

1. Add a renderer class to `graph.js` exposing at minimum `push(value, timestamp)` and `destroy()`
2. Register it in `VIZ_MODES` in `dashboard-state.js` for the relevant data type(s), and a default/min size in `DEFAULT_SIZE`/`MIN_SIZE`
3. Wire it into `Widget._buildBody()` and `Widget._pushToViz()` in `widget.js`

### Adding a New Sensor Type (analog)

Add an entry to `SENSOR_TYPES` and a conversion case in `applySensorConversion()` in `sensors.js`. No other file needs to change — each analog widget already carries its own `sensor` state and renders the dropdown via `FiltersPanel`'s sensor section.

### Configuring Bluetooth Transport

Edit `transport/bluetooth.js`:
1. Set `SERVICE_UUID` and `CHARACTERISTIC_UUID` for your device
2. Uncomment the connection logic in `connect()`
3. Ensure device sends newline-delimited JSON via BLE notifications

### Changing Channel Colors

Update `CH_COLORS` in `widget.js` (must match CSS `--ch-*` variables in `style.css`).

## Design Thinking Approach

When making UI and UX decisions, think like a hybrid of:
- interaction designer
- industrial designer
- embedded instrument designer
- media art technologist

Do not approach the interface as a typical web dashboard.

The interface should feel designed with the same care as a physical object.

Prioritize:
- clarity of signal reading
- intuitive interaction
- visual rhythm
- calmness
- tactile feeling
- precision
- usability during real-time experimentation

The dashboard should feel credible as a research instrument while still feeling refined and intentional.

The interface must balance:
- scientific accuracy
- engineering practicality
- elegant interaction design
- restrained visual identity

Avoid making design decisions that reduce:
- readability
- responsiveness
- measurement clarity
- performance
- technical credibility

Aesthetic improvements should support understanding of the signals, not distract from them.

## Avoid Generic Dashboard Aesthetics

Do not use:
- SaaS dashboard aesthetics
- Tailwind admin panel styling
- Bootstrap-like layouts
- crypto/trading dashboard visuals
- excessive cards
- oversized rounded containers
- generic UI kits
- heavy glassmorphism
- neon cyberpunk aesthetics

The UI should feel closer to:
- scientific instruments
- oscilloscopes
- embedded hardware interfaces
- modular synthesizers
- experimental media tools

## Signal Visualization Priority

Waveforms and signal visualization are the emotional center of the interface.

The graph area should feel:
- immersive
- responsive
- alive
- precise
- elegant

Prefer subtle refinements such as:
- refined line rendering
- soft contrast
- restrained motion
- waveform persistence feeling
Avoid:
- generic chart library aesthetics
- thick strokes
- excessive labels
- visual clutter

## Refinement Philosophy

Prefer refinement over redesign.

Small high-quality improvements are preferred over dramatic visual changes.

Focus first on:
- spacing
- hierarchy
- typography
- contrast
- motion
- interaction feel
- graph rendering quality

Preserve:
- simplicity
- readability
- responsiveness
- performance
- existing architecture

Do not overdesign the interface.
