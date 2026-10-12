// filters-ui.js — Per-channel filter controls with independent
// preprocessing and filtering stage toggles.

import { SENSOR_TYPES, createSensorState } from './sensors.js';

const STAGE_DEFS = {
  analog: {
    preprocessing: [
      { label: 'Moving Average',  key: 'moving-avg',      type: 'range',  min: 1,     max: 20,  step: 1,     default: 1   },
      { label: 'DC Offset',       key: 'zero-offset',     type: 'check'                                                    },
      { label: 'Clamp Min',       key: 'clamp-min',       type: 'number', placeholder: '0 = off'                           },
      { label: 'Clamp Max',       key: 'clamp-max',       type: 'number', placeholder: '4095 = off'                        },
      { label: 'Scale ×',         key: 'scale',           type: 'number', placeholder: '1 = off'                        },
      { label: 'Offset +',        key: 'offset',          type: 'number', placeholder: '0 = off'                          },
      { label: 'Scale In Min',    key: 'cal-min',         type: 'number', placeholder: '0'                                 },
      { label: 'Scale In Max',    key: 'cal-max',         type: 'number', placeholder: '4095'                              },
    ],
    filtering: [
      { label: 'EMA α',           key: 'ema-alpha',       type: 'range',  min: 0.01,  max: 1,   step: 0.01,  default: 1   },
      { label: 'Low-pass Hz',     key: 'lowpass-cutoff',  type: 'number', placeholder: '0 = off'                           },
      { label: 'High-pass Hz',    key: 'highpass-cutoff', type: 'number', placeholder: '0 = off'                           },
      { label: 'Notch Hz',        key: 'notch-hz',        type: 'number', placeholder: '0 = off'                           },
    ],
  },
  digital: {
    preprocessing: [
      { label: 'Threshold',       key: 'threshold',       type: 'range',  min: 0,     max: 1,   step: 0.01,  default: 0.5 },
      { label: 'Debounce ms',     key: 'debounce-ms',     type: 'number', placeholder: '0 = off'                           },
      { label: 'Invert Logic',    key: 'invert-digital',  type: 'check'                                                    },
    ],
    filtering: [
      { label: 'Glitch ms',       key: 'glitch-ms',       type: 'number', placeholder: '0 = off'                           },
      { label: 'Edge Trigger',    key: 'edge-trigger',    type: 'select', options: ['both', 'rising', 'falling']            },
      { label: 'Duty Win. ms',    key: 'duty-window-ms',  type: 'number', placeholder: '0 = off'                           },
    ],
  },
  capacitive: {
    preprocessing: [
      { label: 'Noise Gate',   key: 'noise-gate',   type: 'number', placeholder: '0 = off (raw counts)' },
      { label: 'Clamp Min',    key: 'cap-clamp-min', type: 'number', placeholder: 'off (raw counts)'     },
      { label: 'Clamp Max',    key: 'cap-clamp-max', type: 'number', placeholder: 'off (raw counts)'     },
      { label: 'Max Δ/sample', key: 'max-delta',     type: 'number', placeholder: '0 = off (raw counts)' },
      { label: 'Debounce ms',  key: 'cap-debounce',  type: 'number', placeholder: '0 = off'               },
    ],
    filtering: [
      { label: 'Baseline α',      key: 'baseline-alpha',  type: 'range',  min: 0,     max: 0.5, step: 0.001, default: 0   },
      { label: 'EMA α',           key: 'cap-smoothing',   type: 'range',  min: 0.01,  max: 1,   step: 0.01,  default: 1   },
      { label: 'Hyst. Low',       key: 'hyst-low',        type: 'range',  min: 0,     max: 1,   step: 0.01,  default: 0.3 },
      { label: 'Hyst. High',      key: 'hyst-high',       type: 'range',  min: 0,     max: 1,   step: 0.01,  default: 0   },
    ],
  },
};

export class FiltersPanel {
  constructor(container) {
    this.container      = container;
    this._config        = {};
    this._onChange      = null;
    this._onSensorChange = null;
    // Sensor state is kept here so it survives re-renders for the same channel.
    // app.js passes the per-channel state in via render() or setSensorState().
    this._sensorState   = createSensorState();
    // DOM refs to the sensor section controls (set by _renderSensorSection)
    this._typeSelect    = null;
    this._customDiv     = null;
  }

  onChange(fn) { this._onChange = fn; }

  // Register a callback that fires whenever the sensor type or custom settings change.
  // fn receives the updated sensorState object.
  onSensorChange(fn) { this._onSensorChange = fn; }

  // Load a saved sensor state into the panel UI (call after render()).
  setSensorState(state) {
    this._sensorState = { ...state };
    if (this._typeSelect) {
      this._typeSelect.value = this._sensorState.typeId;
      this._updateCustomFields();
    }
  }

  // sensorState is optional; pass the channel's saved state so the dropdown
  // is already correct when the panel opens.
  render(ch, sensorState = null) {
    this.container.innerHTML = '';
    this._config     = {};
    this._typeSelect = null;
    this._customDiv  = null;
    // Use provided state, or keep existing, or fall back to default
    this._sensorState = sensorState ? { ...sensorState } : this._sensorState ?? createSensorState();

    // Sensor type section — analog channels only
    if (ch.type === 'analog') {
      this._renderSensorSection();
    }

    const defs = STAGE_DEFS[ch.type];
    if (defs) {
      this._renderSection('PREPROCESSING', 'preprocessingEnabled', defs.preprocessing);
      this._renderSection('FILTERING',     'filteringEnabled',     defs.filtering);
    }
  }

  setConfig(config) {
    if (!config) return;
    for (const [key, value] of Object.entries(config)) {
      const el = this.container.querySelector(`[data-key="${key}"]`);
      if (!el) continue;

      if (el.classList.contains('stage-toggle')) {
        const on = value !== false;
        el.textContent = on ? 'ON' : 'OFF';
        el.classList.toggle('active', on);
        this._config[key] = on;
      } else if (el.type === 'checkbox') {
        el.checked = !!value;
        this._config[key] = !!value;
      } else if (el.tagName === 'SELECT') {
        el.value = value;
        this._config[key] = value;
      } else {
        el.value = value;
        this._config[key] = value === '' ? '' : Number(value);
        const display = el.closest('.filter-slider-wrap')?.querySelector('.filter-slider-val');
        if (display) {
          const decimals = Number(el.step) < 0.01 ? 3 : 2;
          display.textContent = Number(value).toFixed(decimals);
        }
      }
    }
  }

  _emit(key, value) {
    this._config[key] = value;
    this._onChange?.(this._config);
  }

  _renderSection(title, stageKey, defs) {
    const section = document.createElement('div');
    section.className = 'filter-section';

    // Section header with integrated toggle
    const header = document.createElement('div');
    header.className = 'filter-section-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'filter-section-title';
    titleEl.textContent = title;

    const toggle = document.createElement('button');
    toggle.className = 'stage-toggle active';
    toggle.dataset.key = stageKey;
    toggle.textContent = 'ON';
    this._config[stageKey] = true;

    toggle.addEventListener('click', () => {
      const on = !this._config[stageKey];
      this._config[stageKey] = on;
      toggle.textContent = on ? 'ON' : 'OFF';
      toggle.classList.toggle('active', on);
      this._onChange?.(this._config);
    });

    header.append(titleEl, toggle);
    section.appendChild(header);

    // Section controls
    const controls = document.createElement('div');
    controls.className = 'filter-section-controls';
    for (const def of defs) controls.appendChild(this._makeRow(def));
    section.appendChild(controls);

    this.container.appendChild(section);
  }

  // ── Sensor type section ─────────────────────────────────────────────────────

  _renderSensorSection() {
    const section = document.createElement('div');
    section.className = 'filter-section';

    // Header: title + small reset button
    const header = document.createElement('div');
    header.className = 'filter-section-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'filter-section-title';
    titleEl.textContent = 'SENSOR TYPE';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'stage-reset';
    resetBtn.textContent = 'RESET';
    resetBtn.title = 'Reset to Voltage / Raw ADC';
    resetBtn.addEventListener('click', () => {
      this._sensorState = createSensorState(); // back to 'raw'
      if (this._typeSelect) this._typeSelect.value = 'raw';
      this._updateCustomFields();
      this._onSensorChange?.(this._sensorState);
    });

    header.append(titleEl, resetBtn);
    section.appendChild(header);

    // Controls area
    const controls = document.createElement('div');
    controls.className = 'filter-section-controls';

    // Sensor type dropdown row
    const typeRow = document.createElement('div');
    typeRow.className = 'filter-row';

    const typeLabel = document.createElement('label');
    typeLabel.className = 'filter-label';
    typeLabel.textContent = 'Type';

    const typeSelect = document.createElement('select');
    typeSelect.className = 'filter-select';
    // Populate options from the shared SENSOR_TYPES list
    for (const t of SENSOR_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      typeSelect.appendChild(opt);
    }
    typeSelect.value = this._sensorState.typeId;
    typeSelect.addEventListener('change', () => {
      this._sensorState.typeId = typeSelect.value;
      this._updateCustomFields();
      this._onSensorChange?.(this._sensorState);
    });

    typeRow.append(typeLabel, typeSelect);
    controls.appendChild(typeRow);

    // Container for custom sensor fields (unit / scale / offset).
    // Hidden until the user selects 'custom'.
    const customDiv = document.createElement('div');
    controls.appendChild(customDiv);

    section.appendChild(controls);
    this.container.appendChild(section);

    // Store refs so setSensorState() can update the UI without re-rendering
    this._typeSelect = typeSelect;
    this._customDiv  = customDiv;

    // Render custom fields if 'custom' is already the active type
    this._updateCustomFields();
  }

  // Rebuild the three custom-sensor input rows (Unit / Scale × / Offset +).
  // Called every time the sensor type changes.
  _updateCustomFields() {
    if (!this._customDiv) return;
    this._customDiv.innerHTML = '';
    if (this._sensorState?.typeId !== 'custom') return;

    // Unit text (e.g. 'mV', 'psi')
    this._customDiv.appendChild(this._makeSensorInputRow(
      'Unit', 'text', this._sensorState.customUnit ?? '', 'e.g. mV',
      v => { this._sensorState.customUnit = v; this._onSensorChange?.(this._sensorState); }
    ));

    // Scale multiplier — output = value × multiplier + offset
    this._customDiv.appendChild(this._makeSensorInputRow(
      'Scale ×', 'number', this._sensorState.multiplier ?? 1, '1',
      v => { this._sensorState.multiplier = parseFloat(v) || 1; this._onSensorChange?.(this._sensorState); }
    ));

    // Additive offset
    this._customDiv.appendChild(this._makeSensorInputRow(
      'Offset +', 'number', this._sensorState.customOffset ?? 0, '0',
      v => { this._sensorState.customOffset = parseFloat(v) || 0; this._onSensorChange?.(this._sensorState); }
    ));
  }

  // Helper: build a labeled input row for the custom sensor fields.
  _makeSensorInputRow(labelText, inputType, value, placeholder, onChange) {
    const row = document.createElement('div');
    row.className = 'filter-row';

    const label = document.createElement('label');
    label.className = 'filter-label';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type        = inputType;
    input.className   = 'filter-number';
    input.value       = value;
    input.placeholder = placeholder;
    input.addEventListener('change', () => onChange(input.value));

    row.append(label, input);
    return row;
  }

  // ── Filter rows ─────────────────────────────────────────────────────────────

  _makeRow(def) {
    const row = document.createElement('div');
    row.className = 'filter-row';

    const label = document.createElement('label');
    label.className = 'filter-label';
    label.textContent = def.label;
    row.appendChild(label);

    if (def.type === 'check') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'filter-toggle';
      input.dataset.key = def.key;
      this._config[def.key] = false;
      input.addEventListener('change', () => this._emit(def.key, input.checked));
      row.appendChild(input);

    } else if (def.type === 'range') {
      const wrap = document.createElement('div');
      wrap.className = 'filter-slider-wrap';

      const input = document.createElement('input');
      input.type  = 'range';
      input.className = 'filter-slider';
      input.min   = def.min;
      input.max   = def.max;
      input.step  = def.step;
      input.value = def.default ?? def.min;
      input.dataset.key = def.key;

      const decimals = def.step < 0.01 ? 3 : 2;
      const display  = document.createElement('span');
      display.className = 'filter-slider-val';
      display.textContent = Number(input.value).toFixed(decimals);
      this._config[def.key] = Number(input.value);

      input.addEventListener('input', () => {
        const v = Number(input.value);
        display.textContent = v.toFixed(decimals);
        this._emit(def.key, v);
      });

      wrap.append(input, display);
      row.appendChild(wrap);

    } else if (def.type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'filter-number';
      input.placeholder = def.placeholder ?? '';
      input.dataset.key = def.key;
      this._config[def.key] = '';
      input.addEventListener('change', () => {
        const v = input.value === '' ? '' : Number(input.value);
        this._emit(def.key, v);
      });
      row.appendChild(input);

    } else if (def.type === 'select') {
      const input = document.createElement('select');
      input.className = 'filter-select';
      input.dataset.key = def.key;
      for (const opt of def.options) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        input.appendChild(o);
      }
      this._config[def.key] = def.options[0];
      input.addEventListener('change', () => this._emit(def.key, input.value));
      row.appendChild(input);
    }

    return row;
  }
}
