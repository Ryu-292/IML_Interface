// widget.js — One independent dashboard card: header (drag handle, label,
// live value, filters button, settings, remove) + an always-visible time
// bar (line/state visualizations) + a visualization body + two focused
// popovers: FILTERS (sensor type, preprocessing, filtering) and SETTINGS
// (Y-axis, signal readout).
//
// Each Widget owns its own filter state and sensor state, so the same
// physical channel can feed several widgets with completely independent
// settings (per-widget filtering, not global).

import { LineGraph, StateGraph, PadGauge, NumericReadout, MultiLineGraph } from './graph.js';
import { FiltersPanel } from './filters-ui.js';
import { SENSOR_TYPES, createSensorState, applySensorConversion, convertVoltage } from './sensors.js';
import { createChannelState, processValue, resetFilterState } from './processing.js';
import { CHANNEL_COUNT } from './dashboard-state.js';

const CH_COLORS = ['#c85a28', '#2a6b96', '#3f7a5a', '#7550a0'];
function colorFor(channel) {
  return CH_COLORS[channel % CH_COLORS.length];
}

function getAnalogUnit(sensorState) {
  if (sensorState.typeId === 'custom') return sensorState.customUnit || '';
  return SENSOR_TYPES.find(t => t.id === sensorState.typeId)?.unit ?? '';
}

function formatAnalogValue(value, unit) {
  const abs = Math.abs(value);
  const d = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  const num = value.toFixed(d);
  return unit ? `${num} ${unit}` : num;
}

// Every mounted Widget, keyed by id — lets a linked combine-source-settings
// widget resolve its target combine widget (and that widget's per-source
// runtime state) without app.js having to wire up per-widget callbacks for
// every possible cross-widget lookup.
export const widgetRegistry = new Map();

// ── Single-open-popover singleton (shared across all widgets) ─────────────
let _openPopover = null; // { widget, which: 'filters' | 'settings', el }

export function closeOpenPopover() {
  if (_openPopover) {
    const { widget, which, el } = _openPopover;
    el.classList.remove('open');
    if (which === 'settings') widget._settingsOpen = false;
    if (which === 'filters') { widget._activeFilterSourceId = null; widget._filtersAnchorEl = null; }
    _openPopover = null;
  }
}

document.addEventListener('pointerdown', (e) => {
  if (!_openPopover) return;
  const { widget, el } = _openPopover;
  if (el.contains(e.target)) return;
  if (widget._filterBtn?.contains(e.target) || widget._gearEl?.contains(e.target) || widget._filtersAnchorEl?.contains(e.target)) return;
  closeOpenPopover();
});
window.addEventListener('resize', closeOpenPopover);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpenPopover(); });

export class Widget {
  // def    — the live widget record from DashboardStore (same object reference)
  // store  — DashboardStore instance, used to persist setting changes
  // onRemove(id) — called after this widget tears itself down
  constructor(def, store, { onRemove, onCommand, onOpenSourceSettings } = {}) {
    this.def = def;
    this.id = def.id;
    this.store = store;
    this.onRemove = onRemove;
    this.onCommand = onCommand ?? null;
    this.onOpenSourceSettings = onOpenSourceSettings ?? null;

    widgetRegistry.set(this.id, this);

    const isCombine = def.dataType === 'combine';
    const isSourceSettings = def.dataType === 'combine-source-settings';

    this.sensor = (!isCombine && !isSourceSettings && def.dataType === 'analog') ? (def.sensor ?? createSensorState()) : null;
    if (this.sensor && !def.sensor) this.store.update(this.id, { sensor: this.sensor });

    this.filterState = (isCombine || isSourceSettings) ? null : createChannelState();
    if (this.filterState) this.filterState.config = { ...def.filterConfig };

    this._lastUnit = '';
    this._settingsOpen = false;
    this._lastDetail = {};
    this._filtersPanel = null;
    this._filtersPopover = null;
    this._settingsPopover = null;

    // Calibration state (capacitive pad only)
    this._calBaseline  = null;   // averaged rest value after calibration
    this._calAccum     = 0;
    this._calCount     = 0;
    this._calActive    = false;
    this._calBtn       = null;
    this._CAL_FRAMES   = 60;     // ~2 s at 30 Hz
    this._CAL_THRESH   = 0.04;   // 4% rise above baseline = touched

    // Combine-widget per-source runtime state: id -> { def, filterState, sensor, rowEl, liveValueEl, lastDetail }.
    // Each source has its own filter/sensor state, same as a standalone widget would.
    this._sources = isCombine ? new Map() : null;
    this._activeFilterSourceId = null; // which source's filters the FILTERS popover currently shows
    this._filtersAnchorEl = null;      // the button that opened the currently-open FILTERS popover

    this.el = document.createElement('div');
    this.el.className = 'widget-card';
    this.el.dataset.id = this.id;
    this.el.dataset.type = def.dataType;

    const header = this._buildHeader();
    this._gearEl = header.querySelector('.widget-gear');
    this._filterBtn = header.querySelector('.widget-filter-btn');
    const body = this._buildBody();

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'widget-resize-handle';

    this.el.appendChild(header);
    if (def.vizMode === 'line' || def.vizMode === 'state' || def.vizMode === 'combine') {
      this.el.appendChild(this._buildTimebar());
    }
    this.el.append(body, resizeHandle);

    if (def.dataType === 'analog' && this.viz?.setUnit) {
      const unit = getAnalogUnit(this.sensor);
      this.viz.setUnit(unit);
      this._lastUnit = unit;
    }
  }

  // ── incoming data ───────────────────────────────────────────────────────

  // Shared analog/digital/capacitive conversion logic — used by both the
  // single-channel path (handleValue) and the per-source path on a combine
  // widget (handleSourceValue) so the two never drift apart.
  _computeDisplayValue(type, filtered, sensor, incomingUnit, isVoltage) {
    if (type === 'analog') {
      let converted, unit, voltage;
      if (incomingUnit != null) {
        // Already a final physical value (legacy pre-converted multi-channel format).
        converted = filtered; unit = incomingUnit; voltage = null;
      } else if (isVoltage) {
        // Already volts — apply the physical-unit formula directly.
        voltage = filtered;
        ({ value: converted, unit } = convertVoltage(voltage, sensor));
      } else {
        // Raw ADC counts — convert to voltage then physical units.
        ({ voltage, value: converted, unit } = applySensorConversion(filtered, sensor));
      }
      return { displayValue: converted, unit, voltage };
    } else if (type === 'digital') {
      return { displayValue: filtered > 0.5 ? 1 : 0, unit: '' };
    } else {
      return { displayValue: filtered, unit: '' };
    }
  }

  handleValue(raw, timestamp, incomingUnit, isVoltage, extras = {}) {
    const type = this.def.dataType;
    const { touched = null, baseline = null } = extras;
    const rawForProcessing = type === 'digital' ? (raw ? 1 : 0) : raw;
    const { preprocessed, filtered, amplitude } = processValue(rawForProcessing, this.filterState, type);

    const { displayValue, unit, voltage } = this._computeDisplayValue(type, filtered, this.sensor, incomingUnit, isVoltage);

    this._lastDetail = {
      raw, preprocessed, filtered, voltage,
      converted: type === 'analog' ? displayValue : undefined,
      unit, amplitude, timestamp, touched, baseline,
    };

    if (this._calActive && type === 'capacitive' && typeof raw === 'number') {
      this._calAccum += raw;
      this._calCount++;
      if (this._calCount >= this._CAL_FRAMES) {
        this._calBaseline = this._calAccum / this._calCount;
        this._calActive   = false;
        if (this._calBtn) {
          this._calBtn.classList.remove('widget-cal-btn--active');
          this._calBtn.classList.add('widget-cal-btn--done');
          this._calBtn.textContent = 'CAL';
        }
      }
    }

    this._pushToViz(type, displayValue, timestamp, unit);
    this._updateLiveValue(type, displayValue, unit);
    this._updateDetailEl();
  }

  // Per-source counterpart of handleValue(), for a combine widget's sources.
  handleSourceValue(sourceId, raw, timestamp, incomingUnit, isVoltage, extras = {}) {
    const entry = this._sources.get(sourceId);
    if (!entry) return;
    const { type } = entry.def;
    const { touched = null, baseline = null } = extras;
    const rawForProcessing = type === 'digital' ? (raw ? 1 : 0) : raw;
    const { filtered } = processValue(rawForProcessing, entry.filterState, type);

    const { displayValue, unit } = this._computeDisplayValue(type, filtered, entry.sensor, incomingUnit, isVoltage);

    entry.lastDetail = { raw, filtered, unit, timestamp, touched, baseline };

    if (entry.calActive && type === 'capacitive' && typeof raw === 'number') {
      entry.calAccum += raw;
      entry.calCount++;
      if (entry.calCount >= this._CAL_FRAMES) {
        entry.calBaseline = entry.calAccum / entry.calCount;
        entry.calActive   = false;
        if (entry.calBtn) {
          entry.calBtn.classList.remove('widget-cal-btn--active');
          entry.calBtn.classList.add('widget-cal-btn--done');
          entry.calBtn.textContent = 'CAL';
        }
      }
    }

    this.viz.push(sourceId, displayValue, timestamp);
    this._updateSourceLiveValue(entry, type, displayValue, unit, touched);
  }

  // Combine-source counterpart of _startCalibration() — same rest-baseline
  // averaging, but writes into the source's own entry instead of `this`.
  _startSourceCalibration(entry) {
    if (entry.calActive) return;
    entry.calAccum  = 0;
    entry.calCount  = 0;
    entry.calActive = true;
    if (entry.calBtn) {
      entry.calBtn.classList.add('widget-cal-btn--active');
      entry.calBtn.classList.remove('widget-cal-btn--done');
      entry.calBtn.textContent = '···';
    }
  }

  // Resolves a combine-source-settings widget's link to its target combine
  // widget + that widget's runtime entry for the source it controls. Looked
  // up fresh every call (never cached) so it self-heals if the target wasn't
  // mounted yet at construction time (load-order isn't guaranteed) and so it
  // returns null cleanly if the target/source was since removed.
  _resolveLink() {
    if (this.def.dataType !== 'combine-source-settings') return null;
    const target = widgetRegistry.get(this.def.targetWidgetId);
    const entry = target?._sources?.get(this.def.sourceId);
    return entry ? { target, entry, sourceDef: entry.def } : null;
  }

  _pushToViz(type, value, timestamp, unit) {
    const { vizMode } = this.def;
    if (vizMode === 'line') {
      this.viz.push(value, timestamp);
      if (type === 'analog' && unit !== this._lastUnit) { this.viz.setUnit(unit); this._lastUnit = unit; }
    } else if (vizMode === 'state') {
      this.viz.push(value > 0.5, timestamp);
    } else if (vizMode === 'pad') {
      const { touched, raw } = this._lastDetail;
      let padVal;
      if (this._calBaseline !== null && typeof raw === 'number') {
        const rise = raw - this._calBaseline;
        padVal = rise > this._CAL_THRESH ? 1 : 0;
      } else {
        padVal = touched !== null ? (touched ? 1 : 0) : (value > 0.5 ? 1 : 0);
      }
      this.viz.push(padVal, raw);
    } else if (vizMode === 'numeric') {
      if (type === 'digital') {
        this.viz.pushText(value > 0.5 ? 'HIGH' : 'LOW');
      } else {
        this.viz.push(value);
        if (type === 'analog' && unit !== this._lastUnit) { this.viz.setUnit(unit); this._lastUnit = unit; }
      }
    }
  }

  _updateLiveValue(type, value, unit) {
    let text;
    if (type === 'analog') text = formatAnalogValue(value, unit);
    else if (type === 'digital') text = value > 0.5 ? 'HIGH' : 'LOW';
    else {
      const raw     = this._lastDetail.raw;
      const touched = this._lastDetail.touched;
      const rawStr  = typeof raw === 'number' ? Math.round(raw).toString() : '—';
      let isTouched;
      if (this._calBaseline !== null && typeof raw === 'number') {
        isTouched = (raw - this._calBaseline) > this._CAL_THRESH;
      } else {
        isTouched = touched !== null ? touched : (value > 0.5);
      }
      text = `${isTouched ? 'TOUCHED' : '—'}  ${rawStr}`;
    }

    this._liveValueEl.textContent = text;
  }

  // Combine-widget counterpart of _updateLiveValue() — writes into a source's
  // own sidebar row instead of the widget's single header live-value span.
  _updateSourceLiveValue(entry, type, value, unit, touched) {
    let text;
    if (type === 'analog') text = formatAnalogValue(value, unit);
    else if (type === 'digital') text = value > 0.5 ? 'HIGH' : 'LOW';
    else {
      const raw = entry.lastDetail.raw;
      let isTouched;
      if (entry.calBaseline !== null && typeof raw === 'number') {
        isTouched = (raw - entry.calBaseline) > this._CAL_THRESH;
      } else {
        isTouched = touched !== null ? touched : value > 0.5;
      }
      text = isTouched ? 'TOUCHED' : '—';
    }
    entry.liveValueEl.textContent = text;
  }

  // ── DOM: header ──────────────────────────────────────────────────────────

  _buildHeader() {
    const header = document.createElement('div');
    header.className = 'widget-drag-handle widget-header';

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'widget-label';
    label.value = this.def.label;
    label.spellcheck = false;
    label.addEventListener('change', () => {
      const value = label.value.trim() || this.def.label;
      label.value = value;
      this.store.update(this.id, { label: value });
      this._retitlePopovers(value);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'widget-remove';
    remove.title = 'Remove widget';
    remove.setAttribute('aria-label', 'Remove widget');
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = this.id;
      this.destroy();
      this.onRemove?.(id);
    });

    // Combine widgets have no single channel/color to represent and no
    // widget-wide filters (each source has its own, opened from its own
    // linked settings widget) — just the label and a remove button.
    if (this.def.dataType === 'combine') {
      header.append(label, remove);
      return header;
    }

    // Shared by standalone widgets and combine-source-settings widgets.
    const filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'widget-filter-btn';
    filterBtn.title = 'Filters';
    filterBtn.setAttribute('aria-label', 'Open filters');
    filterBtn.innerHTML = '<span class="icon-filter"><span></span><span></span><span></span></span>';
    filterBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFilters(); });

    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'widget-gear';
    gear.title = 'Display settings';
    gear.setAttribute('aria-label', 'Widget display settings');
    gear.textContent = '⚙';
    gear.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSettings(); });

    // Header-only companion widget for one combine source: color dot (from
    // the linked source) + label + the same filter/gear/remove buttons, but
    // no live value and no graph body — "just the setting" part.
    if (this.def.dataType === 'combine-source-settings') {
      const link = this._resolveLink();
      const dot = document.createElement('span');
      dot.className = 'widget-dot';
      dot.style.background = link ? link.sourceDef.color : 'var(--text-3)';

      if (link && link.sourceDef.type === 'capacitive') {
        const calBtn = document.createElement('button');
        calBtn.type = 'button';
        calBtn.className = 'widget-cal-btn';
        calBtn.title = 'Calibrate — hold pad untouched then click';
        calBtn.setAttribute('aria-label', 'Calibrate rest baseline');
        calBtn.textContent = 'CAL';
        calBtn.addEventListener('click', (e) => { e.stopPropagation(); link.target._startSourceCalibration(link.entry); });
        link.entry.calBtn = calBtn;
        header.append(dot, label, calBtn, filterBtn, gear, remove);
      } else {
        header.append(dot, label, filterBtn, gear, remove);
      }
      return header;
    }

    const dot = document.createElement('span');
    dot.className = 'widget-dot';
    dot.style.background = colorFor(this.def.channel);
    if (this.def.dataType === 'digital') dot.classList.add('widget-dot--square');

    const live = document.createElement('span');
    live.className = 'widget-live-value';
    live.textContent = '—';
    this._liveValueEl = live;

    if (this.def.dataType === 'capacitive' && this.def.vizMode === 'pad') {
      const calBtn = document.createElement('button');
      calBtn.type = 'button';
      calBtn.className = 'widget-cal-btn';
      calBtn.title = 'Calibrate — hold pad untouched then click';
      calBtn.setAttribute('aria-label', 'Calibrate rest baseline');
      calBtn.textContent = 'CAL';
      calBtn.addEventListener('click', (e) => { e.stopPropagation(); this._startCalibration(); });
      this._calBtn = calBtn;
      header.append(dot, label, live, calBtn, filterBtn, gear, remove);
    } else {
      header.append(dot, label, live, filterBtn, gear, remove);
    }
    return header;
  }

  _startCalibration() {
    if (this._calActive) return;
    this._calAccum  = 0;
    this._calCount  = 0;
    this._calActive = true;
    if (this._calBtn) {
      this._calBtn.classList.add('widget-cal-btn--active');
      this._calBtn.textContent = '···';
    }
  }

  _retitlePopovers(label) {
    if (this._filtersTitleEl) this._filtersTitleEl.textContent = `${label.toUpperCase()} · FILTERS`;
    if (this._settingsTitleEl) this._settingsTitleEl.textContent = `${label.toUpperCase()} · SETTINGS`;
  }

  // ── DOM: time bar (always visible — no need to open a menu to rescale time) ─

  _buildTimebar() {
    const bar = document.createElement('div');
    bar.className = 'widget-timebar';
    for (const s of [1, 5, 10, 30, 60]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'time-chip';
      btn.textContent = `${s}s`;
      btn.classList.toggle('active', this.def.timeWindow === s);
      btn.addEventListener('click', () => {
        this.store.update(this.id, { timeWindow: s });
        this.viz.setTimeWindow(s);
        bar.querySelectorAll('.time-chip').forEach(b => b.classList.toggle('active', b === btn));
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  // ── DOM: body (visualization) ───────────────────────────────────────────

  _buildBody() {
    const body = document.createElement('div');
    body.className = 'widget-body';
    const { vizMode, channel } = this.def;

    if (vizMode === 'combine') {
      return this._buildCombineBody(body);
    }

    if (vizMode === 'combine-source-settings') {
      body.classList.add('widget-body--settings-only');
      const hint = document.createElement('div');
      hint.className = 'widget-settings-hint';
      hint.textContent = 'Use the filter and Y-axis buttons above to adjust this source on the combine graph.';
      body.appendChild(hint);
      return body;
    }

    const color = colorFor(channel);

    if (vizMode === 'line') {
      const canvas = document.createElement('canvas');
      canvas.className = 'widget-canvas';
      body.appendChild(canvas);
      this.viz = new LineGraph(canvas, color);
      this.viz.setTimeWindow(this.def.timeWindow);
      this.viz.setAutoscale(this.def.yAxis.autoscale);
      this.viz.setYRange(this.def.yAxis.min, this.def.yAxis.max);
    } else if (vizMode === 'state') {
      const canvas = document.createElement('canvas');
      canvas.className = 'widget-canvas';
      body.appendChild(canvas);
      this.viz = new StateGraph(canvas, color);
      this.viz.setTimeWindow(this.def.timeWindow);
    } else if (vizMode === 'pad') {
      const canvas = document.createElement('canvas');
      canvas.className = 'widget-canvas';
      body.appendChild(canvas);
      this.viz = new PadGauge(canvas);
    } else {
      const readoutEl = document.createElement('div');
      readoutEl.className = 'widget-readout';
      body.appendChild(readoutEl);
      this.viz = new NumericReadout(readoutEl);
    }
    return body;
  }

  // ── DOM: combine body (big graph + source sidebar) ──────────────────────

  _buildCombineBody(body) {
    body.classList.add('widget-combine-body');

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'widget-combine-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'widget-canvas';
    canvasWrap.appendChild(canvas);
    this.viz = new MultiLineGraph(canvas);
    this.viz.setTimeWindow(this.def.timeWindow);

    const sidebar = document.createElement('div');
    sidebar.className = 'widget-combine-sidebar';
    this._sidebarEl = sidebar;

    for (const sourceDef of this.def.sources) this._mountSource(sourceDef);
    this._buildAddSourceRow(sidebar);

    body.append(canvasWrap, sidebar);
    return body;
  }

  // Wire one source into the running widget: its own filter/sensor state,
  // its own line in the shared graph, and its own sidebar row.
  _mountSource(sourceDef) {
    const filterState = createChannelState();
    filterState.config = { ...sourceDef.filterConfig };
    const sensor = sourceDef.type === 'analog' ? (sourceDef.sensor ?? createSensorState()) : null;

    const { row, liveValueEl } = this._buildSourceRow(sourceDef);
    this._sources.set(sourceDef.id, {
      def: sourceDef, filterState, sensor, rowEl: row, liveValueEl, lastDetail: {},
      // Calibration state (capacitive sources only) — same rest-baseline scheme as
      // the standalone pad widget, but tracked per-source since a combine graph
      // can hold several capacitive channels at once.
      calBaseline: null, calAccum: 0, calCount: 0, calActive: false, calBtn: null,
    });

    this.viz.addSeries(sourceDef.id, sourceDef.color);
    this.viz.setVisible(sourceDef.id, sourceDef.visible);

    // Newly added sources land above the pinned "add source" row, not below it.
    if (this._addSourceRowEl) this._sidebarEl.insertBefore(row, this._addSourceRowEl);
    else this._sidebarEl.appendChild(row);
  }

  _removeSource(sourceId) {
    const entry = this._sources.get(sourceId);
    if (!entry) return;
    if (this._activeFilterSourceId === sourceId) closeOpenPopover();
    this.viz.removeSeries(sourceId);
    entry.rowEl.remove();
    this._sources.delete(sourceId);
    this.store.removeSourceFromWidget(this.id, sourceId);
  }

  _buildSourceRow(sourceDef) {
    const row = document.createElement('div');
    row.className = 'combine-source-row';

    // Clicking the dot/label/value opens (or creates) a full-size settings
    // widget for this source — easier to hit and read than a tiny icon.
    const clickable = document.createElement('div');
    clickable.className = 'combine-source-clickable';
    clickable.title = 'Open settings widget for this source';
    clickable.addEventListener('click', () => this.onOpenSourceSettings?.(sourceDef.id));

    const dot = document.createElement('span');
    dot.className = 'widget-dot';
    dot.style.background = sourceDef.color;

    const label = document.createElement('span');
    label.className = 'combine-source-label';
    label.textContent = sourceDef.label;

    const liveValue = document.createElement('span');
    liveValue.className = 'combine-source-value';
    liveValue.textContent = '—';

    clickable.append(dot, label, liveValue);

    const visToggle = document.createElement('button');
    visToggle.type = 'button';
    visToggle.className = 'combine-source-toggle';
    visToggle.title = 'Show/hide this line';
    visToggle.classList.toggle('active', sourceDef.visible);
    visToggle.textContent = sourceDef.visible ? '●' : '○';
    visToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      sourceDef.visible = !sourceDef.visible;
      visToggle.classList.toggle('active', sourceDef.visible);
      visToggle.textContent = sourceDef.visible ? '●' : '○';
      this.viz.setVisible(sourceDef.id, sourceDef.visible);
      this.store.updateSource(this.id, sourceDef.id, { visible: sourceDef.visible });
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'combine-source-remove';
    remove.title = 'Remove source';
    remove.setAttribute('aria-label', `Remove ${sourceDef.label}`);
    remove.textContent = '×';
    remove.addEventListener('click', (e) => { e.stopPropagation(); this._removeSource(sourceDef.id); });

    row.append(clickable, visToggle, remove);
    return { row, liveValueEl: liveValue };
  }

  // Pinned mini builder at the bottom of the sidebar — same type+channel+Add
  // pattern as the Add Widget modal's combine builder, so sources can be
  // grown after the widget already exists.
  _buildAddSourceRow(sidebar) {
    const row = document.createElement('div');
    row.className = 'combine-add-source';

    const builder = { type: 'analog', channel: 0 };
    const prefixOf = { analog: 'A', digital: 'D', capacitive: 'C' };

    const typeRow = document.createElement('div');
    typeRow.className = 'modal-segmented modal-segmented--compact';
    const channelSelect = document.createElement('select');
    channelSelect.className = 'filter-select';

    const syncChannelOptions = () => {
      const count = CHANNEL_COUNT[builder.type];
      channelSelect.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${prefixOf[builder.type]}${i}`;
        channelSelect.appendChild(opt);
      }
      channelSelect.value = builder.channel;
    };

    const typeBtns = [['analog', 'A'], ['digital', 'D'], ['capacitive', 'C']].map(([id, lbl]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-segment';
      btn.textContent = lbl;
      btn.classList.toggle('active', id === builder.type);
      btn.addEventListener('click', () => {
        builder.type = id;
        builder.channel = 0;
        typeBtns.forEach(t => t.btn.classList.toggle('active', t.id === builder.type));
        syncChannelOptions();
      });
      typeRow.appendChild(btn);
      return { id, btn };
    });

    channelSelect.addEventListener('change', () => { builder.channel = Number(channelSelect.value); });
    syncChannelOptions();

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'modal-btn modal-btn--ghost combine-source-add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      const source = this.store.addSourceToWidget(this.id, { type: builder.type, channel: builder.channel });
      if (source) this._mountSource(source);
    });

    row.append(typeRow, channelSelect, addBtn);
    this._addSourceRowEl = row;
    sidebar.appendChild(row);
  }

  // ── popovers ─────────────────────────────────────────────────────────────

  // anchorEl defaults to the widget's own header filter button (standalone
  // widgets); a combine widget passes a specific source row's gear button and
  // that source's id instead, so the same popover mechanics serve both.
  toggleFilters(anchorEl = this._filterBtn, sourceId = null) {
    const wasOpenForThis = _openPopover && _openPopover.widget === this && _openPopover.which === 'filters'
      && this._activeFilterSourceId === sourceId;
    closeOpenPopover();
    if (wasOpenForThis) return;

    this._activeFilterSourceId = sourceId;
    this._filtersAnchorEl = anchorEl;
    const el = this._ensureFiltersPopover();
    this._positionPopover(el, anchorEl);
    this._renderFiltersPanel();
    el.classList.add('open');
    _openPopover = { widget: this, which: 'filters', el };
  }

  toggleSettings() {
    const wasOpenForThis = _openPopover && _openPopover.widget === this && _openPopover.which === 'settings';
    closeOpenPopover();
    if (wasOpenForThis) return;

    const el = this._ensureSettingsPopover();
    this._positionPopover(el, this._gearEl);
    this._settingsOpen = true;
    this._updateDetailEl();
    el.classList.add('open');
    _openPopover = { widget: this, which: 'settings', el };
  }

  _positionPopover(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const popW = 280;
    const left = Math.max(8, Math.min(rect.right - popW, window.innerWidth - popW - 8));
    const top = Math.min(rect.bottom + 6, window.innerHeight - 40);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  _buildPopoverShell(titleSuffix) {
    const pop = document.createElement('div');
    pop.className = 'widget-settings-popover';

    const header = document.createElement('div');
    header.className = 'widget-settings-popover-header';
    const title = document.createElement('div');
    title.className = 'widget-settings-popover-title';
    title.textContent = `${this.def.label.toUpperCase()} · ${titleSuffix}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'settings-close';
    close.textContent = '×';
    close.addEventListener('click', () => closeOpenPopover());
    header.append(title, close);
    pop.appendChild(header);

    const body = document.createElement('div');
    body.className = 'widget-settings-popover-body';
    pop.appendChild(body);

    document.body.appendChild(pop);
    return { pop, body, titleEl: title };
  }

  // Which channel the FILTERS popover currently operates on: the widget's own
  // single channel, a combine widget's whichever source's gear was last
  // clicked, or — for a combine-source-settings widget — its one linked
  // source, resolved fresh each call. Returns null if a linked source's
  // target/source no longer exists. Everything filters-related reads/writes
  // through this so the same popover mechanics serve all three.
  _currentFilterContext() {
    if (this.def.dataType === 'combine' && this._activeFilterSourceId) {
      const entry = this._sources.get(this._activeFilterSourceId);
      const sourceDef = entry.def;
      return {
        type: sourceDef.type,
        label: sourceDef.label,
        filterState: entry.filterState,
        sensor: entry.sensor,
        capHwThresh: sourceDef.capHwThresh,
        filterConfig: sourceDef.filterConfig,
        saveFilterConfig: (config) => this.store.updateSource(this.id, sourceDef.id, { filterConfig: { ...config } }),
        saveCapHwThresh: (thresh) => this.store.updateSource(this.id, sourceDef.id, { capHwThresh: thresh }),
      };
    }
    if (this.def.dataType === 'combine-source-settings') {
      const link = this._resolveLink();
      if (!link) return null;
      const { target, entry, sourceDef } = link;
      return {
        type: sourceDef.type,
        label: sourceDef.label,
        filterState: entry.filterState,
        sensor: entry.sensor,
        capHwThresh: sourceDef.capHwThresh,
        filterConfig: sourceDef.filterConfig,
        saveFilterConfig: (config) => this.store.updateSource(target.id, sourceDef.id, { filterConfig: { ...config } }),
        saveCapHwThresh: (thresh) => this.store.updateSource(target.id, sourceDef.id, { capHwThresh: thresh }),
      };
    }
    return {
      type: this.def.dataType,
      label: this.def.label,
      filterState: this.filterState,
      sensor: this.sensor,
      capHwThresh: this.def.capHwThresh,
      filterConfig: this.def.filterConfig,
      saveFilterConfig: (config) => this.store.update(this.id, { filterConfig: { ...config } }),
      saveCapHwThresh: (thresh) => this.store.update(this.id, { capHwThresh: thresh }),
    };
  }

  // FILTERS popover — sensor type (analog) + preprocessing + filtering.
  // A dedicated, clearly-labeled menu so it's never confused with display settings.
  // Its content (HW section, stage sections, sensor dropdown) is rebuilt on
  // every open via _renderFiltersPanel(), since a combine widget's "current"
  // channel type can change from one open to the next.
  _ensureFiltersPopover() {
    if (this._filtersPopover) return this._filtersPopover;

    const { pop, body, titleEl } = this._buildPopoverShell('FILTERS');
    this._filtersTitleEl = titleEl;

    this._hwSectionHost = document.createElement('div');
    body.appendChild(this._hwSectionHost);

    const hint = document.createElement('div');
    hint.className = 'widget-popover-hint';
    hint.textContent = 'Preprocessing (calibration, scaling) runs first, then Filtering (smoothing). Each stage toggles independently and only affects this widget.';
    body.appendChild(hint);

    const filtersContainer = document.createElement('div');
    filtersContainer.className = 'widget-filters-container';
    body.appendChild(filtersContainer);
    this._filtersPanel = new FiltersPanel(filtersContainer);
    this._wireFiltersPanel();

    this._filtersPopover = pop;
    return pop;
  }

  // Hardware threshold section (capacitive only) — Touch and Release values sent
  // directly to the MPR121 chip via BLE. These apply to all 12 electrodes at once.
  _buildCapHwSection(ctx) {
    const section = document.createElement('div');
    section.className = 'filter-section';

    const header = document.createElement('div');
    header.className = 'filter-section-header';
    const title = document.createElement('div');
    title.className = 'filter-section-title';
    title.textContent = 'MPR121 HARDWARE';
    header.appendChild(title);
    section.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'filter-section-controls';

    const hint = document.createElement('div');
    hint.className = 'filter-hint';
    hint.textContent = 'Sent to the chip over BLE — applies to all 12 electrodes. Touch must be greater than Release. Lower = more sensitive. Default 12 / 6. For resistive pads try 6 / 3.';
    controls.appendChild(hint);

    const hw = ctx.capHwThresh ?? { touch: 12, release: 6 };

    const makeRow = (labelText, initVal) => {
      const row = document.createElement('div');
      row.className = 'filter-row';
      const label = document.createElement('label');
      label.className = 'filter-label';
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'filter-number';
      input.min = 1; input.max = 255; input.value = initVal;
      row.append(label, input);
      return { row, input };
    };

    const { row: touchRow,   input: touchInput   } = makeRow('Touch',   hw.touch);
    const { row: releaseRow, input: releaseInput  } = makeRow('Release', hw.release);

    const send = () => {
      const touch   = Math.max(1, Math.min(255, parseInt(touchInput.value)   || 12));
      const release = Math.max(1, Math.min(255, parseInt(releaseInput.value) || 6));
      if (touch <= release) {
        touchInput.style.outline = '1.5px solid #c04030';
        return;
      }
      touchInput.style.outline = '';
      releaseInput.style.outline = '';
      ctx.saveCapHwThresh({ touch, release });
      this.onCommand?.({ cmd: 'cap_thresh', touch, release });
    };

    touchInput.addEventListener('change', send);
    releaseInput.addEventListener('change', send);

    controls.append(touchRow, releaseRow);
    section.appendChild(controls);
    return section;
  }

  // Which Y-axis the SETTINGS popover's autoscale toggle controls: the
  // widget's own line graph, or — for a combine-source-settings widget —
  // its linked source's line in the target combine widget's graph. Returns
  // null if a linked source's target/source no longer exists.
  _currentYAxisContext() {
    if (this.def.dataType === 'combine-source-settings') {
      const link = this._resolveLink();
      if (!link) return null;
      const { target, sourceDef } = link;
      return {
        getYAxis: () => sourceDef.yAxis,
        getRange: () => target.viz.getDataRange(sourceDef.id),
        setAutoscale: (v) => target.viz.setAutoscale(sourceDef.id, v),
        setRange: (min, max) => target.viz.setYRange(sourceDef.id, min, max),
        save: (yAxis) => this.store.updateSource(target.id, sourceDef.id, { yAxis }),
      };
    }
    return {
      getYAxis: () => this.def.yAxis,
      getRange: () => this.viz.getDataRange?.(),
      setAutoscale: (v) => this.viz.setAutoscale(v),
      setRange: (min, max) => this.viz.setYRange(min, max),
      save: (yAxis) => this.store.update(this.id, { yAxis }),
    };
  }

  // SETTINGS popover — Y-axis scaling + the raw/processed/filtered readout.
  // The readout section is standalone-widget only (a combine-source-settings
  // widget never processes its own frames, so there's nothing to show there).
  _ensureSettingsPopover() {
    if (this._settingsPopover) return this._settingsPopover;

    const { pop, body, titleEl } = this._buildPopoverShell('SETTINGS');
    this._settingsTitleEl = titleEl;

    if (this.def.vizMode === 'line' || this.def.dataType === 'combine-source-settings') {
      const yctx = this._currentYAxisContext();
      if (yctx) body.appendChild(this._buildYAxisSection(yctx));
    }

    if (this.def.dataType !== 'combine-source-settings') {
      const detail = document.createElement('div');
      detail.className = 'filter-section widget-detail-section';
      detail.innerHTML = `
        <div class="filter-section-header"><div class="filter-section-title">SIGNAL</div></div>
        <div class="filter-section-controls widget-detail-values">
          <div class="detail-row"><span class="detail-key">RAW</span><span class="detail-val" data-field="raw">—</span></div>
          <div class="detail-row"><span class="detail-key" data-field-label="processed">PROCESSED</span><span class="detail-val" data-field="processed">—</span></div>
          <div class="detail-row"><span class="detail-key" data-field-label="filtered">FILTERED</span><span class="detail-val" data-field="filtered">—</span></div>
          <div class="detail-row"><span class="detail-key">AMPLITUDE</span><span class="detail-val" data-field="amplitude">—</span></div>
          <div class="detail-row"><span class="detail-key">TIMESTAMP</span><span class="detail-val detail-val--mono" data-field="ts">—</span></div>
        </div>
      `;
      body.appendChild(detail);
      this._detailEl = detail;
    }

    this._settingsPopover = pop;
    return pop;
  }

  _buildYAxisSection(ctx) {
    const section = document.createElement('div');
    section.className = 'filter-section';

    const header = document.createElement('div');
    header.className = 'filter-section-header';
    const title = document.createElement('div');
    title.className = 'filter-section-title';
    title.textContent = 'Y-AXIS';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'stage-toggle';
    header.append(title, toggle);
    section.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'filter-section-controls';

    const hint = document.createElement('div');
    hint.className = 'filter-hint';
    hint.textContent = 'Auto fits the scale to live data. Fix it to compare widgets evenly or zoom into small variations.';
    controls.appendChild(hint);

    const minRow = document.createElement('div'); minRow.className = 'filter-row';
    const minLabel = document.createElement('label'); minLabel.className = 'filter-label'; minLabel.textContent = 'Min';
    const minInput = document.createElement('input'); minInput.type = 'number'; minInput.className = 'filter-number';
    minRow.append(minLabel, minInput);

    const maxRow = document.createElement('div'); maxRow.className = 'filter-row';
    const maxLabel = document.createElement('label'); maxLabel.className = 'filter-label'; maxLabel.textContent = 'Max';
    const maxInput = document.createElement('input'); maxInput.type = 'number'; maxInput.className = 'filter-number';
    maxRow.append(maxLabel, maxInput);

    minInput.step = '0.1';
    maxInput.step = '0.1';

    const syncUI = () => {
      const yAxis = ctx.getYAxis();
      toggle.textContent = yAxis.autoscale ? 'AUTO' : 'FIXED';
      toggle.classList.toggle('active', yAxis.autoscale);
      minInput.value = yAxis.min;
      maxInput.value = yAxis.max;
      minInput.disabled = yAxis.autoscale;
      maxInput.disabled = yAxis.autoscale;
    };
    syncUI();

    toggle.addEventListener('click', () => {
      const yAxis = ctx.getYAxis();
      const next = !yAxis.autoscale;
      let { min, max } = yAxis;
      if (!next && min === max) {
        const range = ctx.getRange();
        if (range) { min = range.min; max = range.max; }
      }
      ctx.save({ autoscale: next, min, max });
      ctx.setAutoscale(next);
      ctx.setRange(min, max);
      syncUI();
    });

    minInput.addEventListener('change', () => {
      const v = Number(minInput.value);
      if (!isFinite(v)) return;
      const yAxis = ctx.getYAxis();
      ctx.save({ ...yAxis, min: v });
      ctx.setRange(v, yAxis.max);
    });
    maxInput.addEventListener('change', () => {
      const v = Number(maxInput.value);
      if (!isFinite(v)) return;
      const yAxis = ctx.getYAxis();
      ctx.save({ ...yAxis, max: v });
      ctx.setRange(yAxis.min, v);
    });

    controls.append(minRow, maxRow);
    section.appendChild(controls);
    return section;
  }

  _wireFiltersPanel() {
    this._filtersPanel.onChange((config) => {
      const ctx = this._currentFilterContext();
      if (!ctx) return;
      const wasZeroOffset = ctx.filterState.config['zero-offset'];
      ctx.filterState.config = { ...config };
      if (config['zero-offset'] && !wasZeroOffset) ctx.filterState.baseline = ctx.filterState.lastRaw ?? null;
      if (!config['zero-offset']) ctx.filterState.baseline = null;
      resetFilterState(ctx.filterState);
      ctx.saveFilterConfig(config);
    });

    // FiltersPanel's sensor section (and this callback) only ever fires when
    // the current context is analog — harmless to register unconditionally.
    this._filtersPanel.onSensorChange((sensorState) => {
      if (this.def.dataType === 'combine' && this._activeFilterSourceId) {
        const entry = this._sources.get(this._activeFilterSourceId);
        entry.sensor = { ...sensorState };
        this.store.updateSource(this.id, entry.def.id, { sensor: entry.sensor });
        this.viz.clearSeries(entry.def.id);
      } else if (this.def.dataType === 'combine-source-settings') {
        const link = this._resolveLink();
        if (!link) return;
        const { target, entry, sourceDef } = link;
        entry.sensor = { ...sensorState };
        this.store.updateSource(target.id, sourceDef.id, { sensor: entry.sensor });
        target.viz.clearSeries(sourceDef.id);
      } else {
        this.sensor = { ...sensorState };
        this.store.update(this.id, { sensor: this.sensor });
        this.viz.clearBuffer?.();
        const unit = getAnalogUnit(this.sensor);
        this.viz.setUnit?.(unit);
        this._lastUnit = unit;
      }
    });
  }

  _renderFiltersPanel() {
    const ctx = this._currentFilterContext();
    this._hwSectionHost.innerHTML = '';

    if (!ctx) {
      // Linked source's target/source no longer exists — nothing to show.
      this._filtersPanel.container.innerHTML = '';
      if (this._filtersTitleEl) this._filtersTitleEl.textContent = 'SOURCE REMOVED';
      return;
    }

    const sensorState = ctx.type === 'analog' ? ctx.sensor : null;
    this._filtersPanel.render({ type: ctx.type }, sensorState);
    if (Object.keys(ctx.filterConfig).length > 0) {
      this._filtersPanel.setConfig(ctx.filterConfig);
    }

    // Rebuilt on every open, not just once — on a combine widget the
    // "current" channel type can differ between opens.
    if (ctx.type === 'capacitive') this._hwSectionHost.appendChild(this._buildCapHwSection(ctx));

    if (this._filtersTitleEl) this._filtersTitleEl.textContent = `${ctx.label.toUpperCase()} · FILTERS`;
  }

  _updateDetailEl() {
    if (!this._settingsOpen || !this._detailEl) return;
    const { raw, preprocessed, filtered, voltage, converted, unit, amplitude, timestamp } = this._lastDetail;
    const fmt = (v) => typeof v === 'number' ? v.toFixed(4) : '—';

    this._setField('raw', fmt(raw));
    if (voltage !== undefined) {
      this._setFieldLabel('processed', 'VOLTAGE');
      this._setFieldLabel('filtered', 'CONVERTED');
      this._setField('processed', voltage !== null ? `${voltage.toFixed(3)} V` : '—');
      this._setField('filtered', formatAnalogValue(converted, unit));
    } else {
      this._setFieldLabel('processed', 'PROCESSED');
      this._setFieldLabel('filtered', 'FILTERED');
      this._setField('processed', fmt(preprocessed));
      this._setField('filtered', fmt(filtered));
    }
    this._setField('amplitude', fmt(amplitude));
    this._setField('ts', timestamp !== undefined ? String(timestamp) : '—');
  }

  _setField(name, text) {
    const el = this._detailEl.querySelector(`[data-field="${name}"]`);
    if (el) el.textContent = text;
  }

  _setFieldLabel(name, text) {
    const el = this._detailEl.querySelector(`[data-field-label="${name}"]`);
    if (el) el.textContent = text;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  destroy() {
    widgetRegistry.delete(this.id);
    if (_openPopover && _openPopover.widget === this) closeOpenPopover();
    this.viz?.destroy?.();
    this._filtersPopover?.remove();
    this._settingsPopover?.remove();
    this.el.remove();
  }
}

