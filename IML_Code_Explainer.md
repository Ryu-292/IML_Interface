# IML Interface — Complete Code Explainer

> How the whole system works, from sensor to screen, explained in plain language.

---

## Big Picture: What Is This System?

You have a physical board (ESP32-S3 microcontroller) with three types of sensors plugged in:
- **Analog sensors** — connected to an ADS1115 chip (measures voltage levels, 0–4V)
- **Digital sensors** — connected directly to GPIO pins (on/off, button presses)
- **Capacitive touch pads** — connected to an MPR121 chip (detects finger touch)

The ESP32 reads all three sensor types, packages the data into a small JSON message, and **sends it wirelessly over Bluetooth** to a web dashboard running in Chrome. The dashboard then displays the data as live graphs, pads, and readouts — and lets you filter/process the signal without touching any code.

```
[Physical Sensors]
       │
       ▼
[ESP32-S3 Firmware] ─── Bluetooth BLE ──→ [Chrome Browser]
       │                                        │
   reads data,                         receives data,
   packs JSON,                         decodes it,
   sends 30×/sec                       shows on dashboard
```

---

## Part 1 — The ESP32 Firmware (the "brain" on the physical device)

The firmware is written in C++ and runs directly on the microcontroller. It loops endlessly, reading sensors and sending data.

---

### `IML.ino` — The Main Program

This is the entry point — the first file that runs.

```
setup()  ← runs ONCE at boot
loop()   ← runs FOREVER, as fast as possible
```

**`setup()`** — boots everything in order:
1. Starts the serial monitor (for debugging via USB)
2. Starts I2C communication (the internal bus used by ADS1115 and MPR121)
3. Initializes the ADS1115 analog chip
4. Forces all 4 analog channels active
5. Initializes the MPR121 capacitive chip
6. Initializes the digital GPIO pins
7. Calls `randomSeed()` so random messages are different every boot
8. Starts the OLED screen
9. Starts Bluetooth (BLE advertising)

**`loop()`** — runs thousands of times per second:
1. Calls `ads1115Tick()` — checks if the ADC has a new reading ready (non-blocking)
2. Every 33ms (30 times/sec): calls `sendSensorFrame()` to transmit data over BLE

The key design principle here: **the ADC is sampled as fast as possible, but BLE sends at a steady 30 Hz**. This avoids overwhelming Bluetooth while keeping the ADC pipeline fast.

---

### `ads1115.cpp` — Analog Sensor Reading

The ADS1115 is a dedicated 16-bit analog-to-digital converter chip. It's much more precise than the ESP32's built-in ADC.

**Key facts:**
- Has 4 analog input channels (A0, A1, A2, A3)
- At GAIN_ONE setting: measures ±4.096V
- A reading of 32,767 = +4.096V; a reading of 0 = 0V; negative = negative voltage
- Can only measure ONE channel at a time — it switches between them automatically

**Functions:**

`ads1115Init()` — Sends "wake up" commands to the chip over I2C. Sets it to 860 samples/second (fastest mode). Returns `true` if the chip was found.

`ads1115DetectChannels()` — Forces all 4 channels active. Starts the first measurement on channel A0 and sets a "conversion pending" flag.

`ads1115Tick()` — Called every loop. Does two things:
1. Checks if the chip has finished its current measurement (`conversionComplete()`). If yes, stores the raw count in `adcRaw[]` and advances to the next channel.
2. Immediately starts the next measurement on the next channel.

This is **non-blocking** — it never waits. It just checks and moves on. This is why the main loop can run fast without stalling.

`ads1115ReadRaw(ch)` — Returns the most recent raw count (int16_t) for a given channel. This is what gets sent to the dashboard.

---

### `mpr121.cpp` — Capacitive Touch Reading

The MPR121 is a dedicated capacitive sensing chip. It connects to up to 12 "electrodes" — which can be metal pads, wires, foil, or anything conductive.

**How capacitive sensing works (simply):** The chip measures how much electrical charge it can store on each electrode. When your finger gets near it, it changes the charge — the chip detects this difference as a "touch."

**Two key numbers per electrode:**
- **filteredData** (~720 at rest, drops toward 0–200 when touched) — the live capacitive reading after the chip's internal smoothing
- **baselineData** — the chip's own "what counts as normal" reference, updated slowly over time

**Functions:**

`mpr121Init()` — Wakes up the chip at I2C address 0x5A. Enables auto-configuration (the chip calibrates itself for whatever pads are physically wired). Sets default touch/release thresholds (12 / 6).

`mpr121TouchBits()` — Returns a 16-bit number where bit 0 = electrode 0 touched, bit 1 = electrode 1 touched, etc. This is the hardware's own decision about touch — you don't compute it, the chip does.

`mpr121IsTouched(elec)` — Extracts one bit from the above for a specific electrode.

`mpr121RawSignal(elec)` — Returns the raw `filteredData` value for one electrode as a float. At rest this is typically around 720. When touched, it drops. The dashboard receives this number directly.

`mpr121BaselineData(elec)` — Returns the chip's internal baseline (8-bit, 0–255, shifted down from the actual value). Useful for detecting calibration drift.

`mpr121SetThresholds(touch, release)` — Updates the touch and release thresholds on the chip. A lower touch threshold = more sensitive. Called when you adjust the sliders in the dashboard's Filters panel.

`mpr121DebugPrint()` — Prints detailed info to the serial monitor about every electrode's reading and whether it's touched. Useful for debugging pad wiring.

---

### `digital_input.cpp` — Digital GPIO Reading

The simplest module. It reads 4 GPIO pins configured as `INPUT_PULLUP`.

**What INPUT_PULLUP means:** The pin is internally connected to 3.3V through a resistor. When nothing is connected, it reads HIGH (1). When a button or sensor pulls the pin to GND, it reads LOW (0).

So: **1 = idle/not triggered, 0 = active/triggered.**

The GPIO pins used are: 1, 2, 42, 41.

`digitalInputInit()` — Configures all 4 pins as INPUT_PULLUP inputs.

`digitalInputRead(ch)` — Returns the current state (0 or 1) of one pin.

---

### `sensors.cpp` — The Data Packager

This is the file that collects all sensor readings and assembles them into a single JSON message to send over Bluetooth.

**Functions:**

`sendStatusFrame()` — Sends a one-time "hello" message when BLE connects, telling the dashboard how many channels exist:
```json
{"t":"s","a":4,"d":4,"c":12}
```

`sendSensorFrame()` — The main data sender, called 30 times/second. Builds this JSON frame:
```json
{"m":"data","ts":12345,"a":[1024,512,0,-300],"d":[1,0,1,1],"c":[720,715,450,...12 values],"cb":[180,179,115,...12 values],"ct":4}
```

Breaking it down:
| Field | Meaning | Example |
|-------|---------|---------|
| `"m":"data"` | Identifies the frame type | always "data" |
| `"ts"` | Timestamp in milliseconds since boot | `12345` |
| `"a"` | 4 raw ADC counts from ADS1115 | `[1024, 512, 0, -300]` |
| `"d"` | 4 digital pin states (0 or 1) | `[1, 0, 1, 1]` |
| `"c"` | 12 raw filtered values from MPR121 | `[720, 715, 450, ...]` |
| `"cb"` | 12 baseline values from MPR121 | `[180, 179, 115, ...]` |
| `"ct"` | Touch bitmask (bit N = electrode N touched) | `4` = electrode 2 touched |

After sending, it also prints this JSON to the serial monitor at 2 Hz (for debugging).

`updateCapCount()` — Placeholder; always 12 (MPR121 always has 12 channels active).

---

### `ble_link.cpp` — Bluetooth Communication

This file handles all Bluetooth Low Energy (BLE) logic using the NimBLE library.

**BLE concepts (simply):**
- BLE works like a walkie-talkie with one specific channel
- The ESP32 "advertises" its presence (like broadcasting its name)
- The Chrome browser "connects" to it
- Data flows one-way: ESP32 → Chrome, via **NOTIFY** (the ESP32 pushes data whenever it has it)
- Commands flow the other way: Chrome → ESP32, via **WRITE** (e.g., changing thresholds)
- **MTU** = Maximum Transmission Unit — the max size of one BLE packet. Set to 512 bytes here.

**Functions:**

`bleInit()` — Sets up the entire BLE stack:
1. Initializes NimBLE with the device name `"IML-Sensor"`
2. Sets MTU to 512 bytes (big enough for the full JSON frame)
3. Creates a "service" (a BLE endpoint) with two "characteristics":
   - **TX characteristic** (NOTIFY) — ESP32 pushes sensor data through this
   - **RX characteristic** (WRITE) — Dashboard sends commands through this
4. Starts advertising so Chrome can find the device

`bleNotify(buf, len)` — Sends one sensor frame over Bluetooth. If BLE is busy (congested), it silently drops the frame rather than queuing it. Fresh data is always more useful than stale data.

`handleCommand(json)` — Parses incoming commands from the dashboard. Currently handles one command type:
```json
{"cmd":"cap_thresh","touch":12,"release":6}
```
This updates the MPR121 touch/release thresholds in real time.

**ServerCallbacks** (BLE events):
- `onConnect()` — Called when Chrome connects. Sets `clientReady = true`, requests a fast connection interval (7.5ms), sends the status frame, updates the OLED.
- `onDisconnect()` — Called when Chrome disconnects. Sets `clientReady = false`, restarts advertising.

---

### `oled_display.cpp` — The Physical Screen

Drives a 128×64 SSD1306 OLED screen connected via SPI.

**Three screen states:**

1. **BOOT** — Shows on startup: "IML SENSOR / BOOT / INITIALIZING" with a progress bar.

2. **WAIT (Pairing)** — Shows while waiting for BLE connection: Bluetooth icon, "PAIRING", channel count in footer (`A4 D4 C12`).

3. **ONLINE (Live)** — Shows when a dashboard is connected: three channel chips (A, D, C with their counts), "LIVE" badge, channel count in footer.

`oledInit()` — Initializes the SPI display and shows the boot screen.

`oledUpdateStatus()` — Called from the main loop. Checks if the screen needs redrawing (state changed, caps count changed, or 1 second has elapsed). Redraws only when necessary to avoid blocking the main loop.

---

## Part 2 — The Web Dashboard (runs in Chrome)

The dashboard is a standard web app (HTML + CSS + JavaScript) with no build step — just open in Chrome. It receives BLE data, processes it through per-widget filter pipelines, and renders it live.

---

### `app.js` — The Orchestrator

This is the main JavaScript file that wires everything together.

**On page load, it:**
1. Creates the dashboard grid (the draggable widget area)
2. Loads previously saved widgets from `localStorage`
3. Sets up the Bluetooth/Serial connection buttons
4. Starts listening for incoming sensor events

**Key functions:**

`initDashboard()` — Creates the `GridEngine` (the drag-and-drop grid), loads saved widgets from storage, and renders them.

`mountWidget(def)` — Takes a widget definition (type, channel, mode, label) and creates a live `Widget` instance on the screen. Registers it with the grid.

`handleWidgetRemoved(id)` — Removes a widget from the screen, grid, and storage.

`switchTransport(name)` — Switches between Bluetooth and USB Serial. Disconnects the old transport, creates the new one, and starts connecting.

`routeValue(type, channel, value, timestamp, ...)` — **The router.** Every time a sensor value arrives, this function finds every widget watching that `(type, channel)` pair and sends the value to it. Multiple widgets can watch the same channel independently.

`listenProtocol()` — Subscribes to protocol events (`'analog'`, `'digital'`, `'capacitive'`) and calls `routeValue()` for each.

---

### `protocol.js` — The Data Decoder

Receives raw data (either Bluetooth packets or USB Serial text) and converts it into clean events.

**The Protocol class** extends `EventTarget`, meaning it fires events that other parts of the code can listen to.

`receive(rawData)` — Entry point. If the data is an `ArrayBuffer` (binary BLE format), handles it as binary. If it's a string (JSON), parses it as JSON.

`_receiveSensorFrame(msg)` — The main path for live BLE data. Parses the combined JSON frame:
- Loops through `msg.a` (analog values) → fires one `'analog'` event per channel
- Loops through `msg.d` (digital values) → fires one `'digital'` event per channel
- Loops through `msg.c` (capacitive values) → fires one `'capacitive'` event per channel, attaching `touched` (from `msg.ct` bitmask) and `baseline` (from `msg.cb` array) as extra info

It also logs the BLE latency to the browser console once per second (useful for diagnosing lag).

`_receiveMultiChannel(mode, channels)` — Handles a legacy format where multiple channels are sent in one message.

`_receiveBinary(buffer)` — Handles the old 8-byte binary BLE format (legacy support).

---

### `widget.js` — One Dashboard Card

Every box on the dashboard is a `Widget`. Each widget is completely independent — it has its own filter settings, its own visualization, its own display mode.

**What a widget contains:**
- A **header**: color dot, editable label, live value readout, filter button, settings gear, remove button
- A **visualization body**: one of four types (see graph.js)
- Two **popovers**: Filters panel and Settings panel (open on demand)

**Key functions:**

`constructor(def, store, callbacks)` — Creates the widget from a definition object. Sets up calibration state (for capacitive pads), sensor state (for analog), and filter state.

`handleValue(raw, timestamp, ...)` — **Called 30 times/second** with the latest sensor reading. Does:
1. Runs the value through the filter pipeline (`processValue()`)
2. Applies sensor conversion if analog (counts → volts → physical units)
3. If calibrating (CAL button was clicked), accumulates raw values to build a rest baseline
4. Updates the visualization
5. Updates the live value text in the header

`_pushToViz(type, value, ...)` — Sends the processed value to the visualization:
- Line graph → `viz.push(value, timestamp)`
- State graph → `viz.push(value > 0.5, timestamp)`
- Pad gauge → determines touch state (using calibration baseline if available, otherwise hardware bit), then `viz.push(padVal, rawValue)`
- Numeric readout → `viz.push(value)` or `viz.pushText('HIGH'/'LOW')`

`_startCalibration()` — Called when the CAL button is clicked on a capacitive pad widget. Sets `_calActive = true` and changes the button to "···". The next 60 incoming frames are averaged to build `_calBaseline` (the "rest" value for that specific pad). After calibration, touch is detected as: `(baseline - currentRaw) / baseline > 4%`.

`_buildHeader()` — Creates the header DOM elements. For capacitive pad widgets, also adds the CAL button.

`toggleFilters()` / `toggleSettings()` — Opens/closes the filter or settings popover. Only one popover can be open at a time across all widgets.

---

### `processing.js` — The Signal Processing Pipeline

**The most complex part of the dashboard.** Every incoming value for every widget passes through this pipeline before being displayed.

The pipeline has two independent stages — each can be toggled on or off per widget:

#### Stage 1: Preprocessing

Runs before filtering. Cleans and shapes the raw signal.

**For analog:**
- **Moving average** — averages the last N samples to smooth out sample-to-sample noise
- **DC offset (zero offset)** — subtracts the very first reading so the signal starts at 0 (useful for drift correction)
- **Input clamp** — hard limits the value to a min/max range
- **Scale × and Offset +** — multiply then add a constant (unit conversion, gain adjustment)
- **Min/max scaling** — maps the full input range to 0.0–1.0

**For digital:**
- **Logic threshold** — anything above 0.5 (adjustable) = 1, below = 0
- **Invert** — flips HIGH and LOW
- **Debounce** — ignores state changes shorter than N milliseconds (prevents false triggers from bouncy contacts)

**For capacitive:**
- **Noise gate** — zeroes out values below a minimum count (ignores tiny baseline fluctuations)
- **Clamp** — hard limits to a raw count range
- **Max Δ/sample** — limits how fast the value can change per frame (spike rejection)
- **Debounce** — same as digital

#### Stage 2: Filtering

Runs after preprocessing. Smooths and shapes the signal mathematically.

**For analog:**
- **EMA (Exponential Moving Average)** — a weighted average that gives more weight to recent values. Alpha=1.0 = no smoothing, Alpha=0.1 = heavy smoothing
- **Low-pass filter** — removes high-frequency noise (fast wiggles). Set a cutoff frequency in Hz
- **High-pass filter** — removes slow drift (DC). Only keeps fast changes
- **Notch filter** — cuts one specific frequency (e.g., 50Hz or 60Hz power line noise)

**For digital:**
- **Glitch rejection** — discards pulses shorter than N ms
- **Edge trigger** — only outputs 1 on a rising edge, falling edge, or both
- **Duty cycle** — outputs the fraction of time the signal has been HIGH over the last N ms

**For capacitive:**
- **Dynamic baseline** — slowly tracks the background and subtracts it (good for slow drift correction)
- **EMA smoothing** — same weighted average as analog
- **Hysteresis** — latch-style detection: turns ON at threshold-high, turns OFF at threshold-low (prevents on/off flickering near the threshold)

**`createChannelState()`** — Creates a fresh state object for one widget. This object holds all the filter memory (buffers, previous values, etc.) and the current config. It's completely independent per widget.

**`resetFilterState(state)`** — Clears all filter memory. Called when you change a filter setting, so the filter starts fresh without artifacts from the old config.

**`processValue(raw, state, type)`** — The main function. Takes the raw incoming value, the widget's state object, and the sensor type. Returns three values:
- `preprocessed` — after Stage 1
- `filtered` — after Stage 2
- `amplitude` — rolling peak-to-peak range of the last 120 preprocessed samples (used in the Settings panel readout mode)

---

### `graph.js` — The Visualizations

Four visualization types, all rendered on HTML Canvas.

**`LineGraph`** — Scrolling time-series waveform. New data points are added on the right; old data falls off the left edge. Supports auto-scaling (Y-axis adjusts to fit the signal) or manual Y-axis range. Used for any signal type in "line" mode.

**`StateGraph`** — Like a line graph but binary: the signal is either HIGH (filled block) or LOW (flat line). Used for digital signals in "state" mode.

**`PadGauge`** — The touch pad visualization. A large rectangle that lights up when touched. Shows the raw capacitive count as a subtext. When touched, shows a randomly picked funny message ("HEY STOP THAT", "NOT THERE", etc.) instead of "TOUCHED". The message changes on each new touch event (rising edge detection).

Each PadGauge picks a new message by:
1. Detecting when `value` goes from 0 → 1 (a rising edge, meaning a new touch)
2. Picking a random message from the `PAD_TOUCH_MESSAGES` array
3. Holding that message until the next touch

**`NumericReadout`** — Just a large live number. No history, no graph — just the current value as big text. Works for any sensor type.

All visualizations use a `requestAnimationFrame` loop with a **dirty flag** (`_dirty`). The canvas only redraws when new data arrives, never wasting CPU on static frames.

---

### `sensors.js` — Sensor Type Conversions (Analog)

Handles the math for converting raw ADC counts into physical measurements.

**`SENSOR_TYPES`** — The list of sensor types shown in the analog widget's dropdown:
- Raw ADC Count (no conversion, shows raw number)
- Voltage (ADS1115) — converts 16-bit count to volts using ADS1115's range
- LM35 temperature (10mV/°C formula)
- TMP36 temperature (10mV/°C with 0.5V offset)
- Humidity, Distance, Light, Pressure, Force, Position, Current, Resistance
- Custom (user-defined multiplier and offset)

**`applySensorConversion(adcValue, state)`** — The main conversion function. If the type is "raw", passes the value through unchanged. Otherwise, converts the 16-bit signed count to volts using ADS1115's formula: `voltage = (count / 32767) × 4.096V`, then applies the sensor formula.

**`convertVoltage(voltage, state)`** — Stage 2 of conversion. Takes volts and applies the physical formula for the selected sensor type (e.g., `volts × 100 = °C` for LM35).

**`createSensorState()`** — Creates a fresh sensor state for one analog widget (which type is selected, custom unit/multiplier/offset).

---

### `filters-ui.js` — The Filters Panel UI

Builds the "Filters" popover that opens when you click the filter icon on a widget. Two collapsible sections:

**Preprocessing section** — sliders and inputs for noise gate, clamp, scale, etc. (type-specific)

**Filtering section** — inputs for EMA alpha, low-pass cutoff, high-pass cutoff, etc. (also type-specific)

Each input fires an `onChange` callback which updates the widget's `filterConfig` in storage and resets the filter state (to prevent artifacts from the config change).

---

## Part 3 — How It All Connects: The Full Journey of One Data Point

Here's what happens from the moment you touch a capacitive pad to the moment the dashboard shows "TOUCHED":

```
1. Your finger approaches the pad
   └─ The MPR121 chip detects the change in capacitance
   └─ filteredData(electrode) drops from ~720 to ~450

2. Every loop() on ESP32 — ads1115Tick() runs (ADC cycle, non-blocking)

3. Every 33ms — sendSensorFrame() runs:
   └─ Reads mpr121RawSignal(11) → 450.0
   └─ Reads mpr121BaselineData(11) → 180
   └─ Reads mpr121TouchBits() → bit 11 is set → ct includes electrode 11
   └─ Packs JSON: {"m":"data","ts":...,"c":[720,720,...,450],"cb":[...],"ct":2048}
   └─ bleNotify() sends the JSON over Bluetooth

4. Chrome receives the BLE packet
   └─ BluetoothTransport fires a 'data' event

5. app.js receives the event
   └─ Calls protocol.receive(rawData)

6. protocol.js parses the JSON
   └─ _receiveSensorFrame() runs
   └─ For channel 11: value=450, touched=true (bit 11 of ct), baseline=180
   └─ Fires: new CustomEvent('capacitive', {channel:11, value:450, touched:true, baseline:180})

7. app.js catches the 'capacitive' event
   └─ routeValue('capacitive', 11, 450, ..., {touched:true, baseline:180})
   └─ Finds all widgets watching capacitive channel 11
   └─ Calls widget.handleValue(450, ..., {touched:true, baseline:180})

8. widget.js processes the value
   └─ processValue(450, filterState, 'capacitive') → filtered=450
   └─ If CAL baseline exists (e.g., 720): drop = (720-450)/720 = 37.5% > 4% → padVal=1
   └─ If no CAL baseline: uses touched=true → padVal=1
   └─ viz.push(1, 450)  →  PadGauge receives: value=1 (touched), rawValue=450

9. PadGauge renders (next animation frame)
   └─ Detects rising edge (was 0, now 1) → picks random message: "NOT THERE"
   └─ Draws lit-up rectangle on canvas
   └─ Shows "NOT THERE" as main text
   └─ Shows "450" as sub text (the raw filtered count)
   └─ Widget header updates: "TOUCHED  450"
```

---

## Quick Reference: Where Is Each Setting?

| What you want to change | Where to find it |
|------------------------|------------------|
| Touch sensitivity (MPR121) | Widget → Filters → MPR121 Hardware (touch/release sliders) |
| Software calibrate a pad | Widget header → **CAL** button |
| Smooth out a noisy analog signal | Widget → Filters → Filtering → EMA Alpha |
| Remove 50Hz/60Hz power noise | Widget → Filters → Filtering → Notch Filter |
| Change analog sensor type (°C, V, etc.) | Widget → Filters → Sensor Type dropdown |
| Set Y-axis range on a line graph | Widget → Settings gear → Y-axis min/max |
| See raw vs filtered vs processed signal | Widget → Settings gear → Signal Readout |
| Change what a widget shows (graph/pad/number) | Remove widget, Add Widget again with new Viz mode |
| Reset all widgets | Reset button (top right of dashboard) |

---

*Document generated: 2026-06-29 — IML Interface project*
