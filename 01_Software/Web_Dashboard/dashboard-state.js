// dashboard-state.js — Widget data model + persisted store.
//
// A "widget" is one independent dashboard card: a data source (type + channel)
// rendered with one visualization mode, carrying its own time window, Y-axis
// range, and filter config. The store only persists *settings* — runtime
// filter accumulators and graph buffers live on the Widget instance (widget.js)
// and are rebuilt fresh on load, same as the old per-channel state always was.

const STORAGE_KEY = 'sensing-dashboard-v1';

// Maximum channel index (exclusive) per data type — matches the wire protocol.
export const CHANNEL_COUNT = { analog: 4, digital: 4, capacitive: 12 };

// Visualization modes available per data type, in menu order.
export const VIZ_MODES = {
  analog:     [{ id: 'line',    label: 'Line graph'   }, { id: 'numeric', label: 'Numeric value' }],
  digital:    [{ id: 'state',   label: 'Digital state' }, { id: 'line', label: 'Line graph' }, { id: 'numeric', label: 'Numeric value' }],
  capacitive: [{ id: 'pad',     label: 'Touch pad'     }, { id: 'line', label: 'Line graph' }, { id: 'numeric', label: 'Numeric value' }],
};

// Default grid footprint (in grid units) for a new widget, by viz mode.
const DEFAULT_SIZE = {
  line:    { w: 4, h: 6 },
  state:   { w: 4, h: 4 },
  pad:     { w: 3, h: 3 },
  numeric: { w: 2, h: 2 },
  combine: { w: 8, h: 8 },
  'combine-source-settings': { w: 3, h: 1 },
};

// Minimum grid footprint a widget can be resized down to, by viz mode.
export const MIN_SIZE = {
  line:    { w: 3, h: 4 },
  state:   { w: 3, h: 3 },
  pad:     { w: 2, h: 2 },
  numeric: { w: 1, h: 1 },
  combine: { w: 5, h: 4 },
  'combine-source-settings': { w: 2, h: 1 },
};

const TYPE_LABEL = { analog: 'Analog', digital: 'Digital', capacitive: 'Cap' };
const TYPE_PREFIX = { analog: 'A', digital: 'D', capacitive: 'C' };

// Color rotation for combine-widget sources — cycles independent of channel
// number so each source added to the same widget gets a visually distinct line.
const SOURCE_COLORS = ['#c85a28', '#2a6b96', '#3f7a5a', '#7550a0', '#a04070', '#a08020'];
export function colorForSourceIndex(i) {
  return SOURCE_COLORS[i % SOURCE_COLORS.length];
}

export function defaultLabel(dataType, channel) {
  return `${TYPE_LABEL[dataType]} ${TYPE_PREFIX[dataType]}${channel}`;
}

export function defaultSize(vizMode) {
  return { ...(DEFAULT_SIZE[vizMode] ?? DEFAULT_SIZE.numeric) };
}

let _idCounter = 0;
function makeId() {
  return `w${Date.now().toString(36)}${(_idCounter++).toString(36)}`;
}

let _sourceIdCounter = 0;
function makeSourceId() {
  return `s${Date.now().toString(36)}${(_sourceIdCounter++).toString(36)}`;
}

// Build a fresh combine-widget source record — one entry in a combine widget's
// `sources` list. Each source carries its own filter config / sensor / hardware
// threshold, completely independent of any standalone widget on the same channel.
export function normalizeSource({ type, channel, color, label, sensor }) {
  return {
    id: makeSourceId(),
    type,
    channel,
    color: color ?? colorForSourceIndex(0),
    label: label ?? defaultLabel(type, channel),
    visible: true,
    filterConfig: {},
    sensor: type === 'analog' ? (sensor ?? null) : null,
    capHwThresh: type === 'capacitive' ? { touch: 12, release: 6 } : null,
    // Per-source Y-axis for this source's line in the combine graph's
    // normalized overlay — auto by default, can be pinned to a fixed range
    // from that source's linked settings widget.
    yAxis: { autoscale: true, min: 0, max: 1 },
  };
}

// Build a small header-only companion widget for one source on a combine
// widget — filters/Y-axis controls sized as a real widget instead of the
// tiny sidebar icons, operating on the exact same source (by reference via
// targetWidgetId/sourceId), not a copy. No graph body, no data of its own.
export function createSourceSettingsWidget({ targetWidgetId, sourceId, label, layout }) {
  return {
    id: makeId(),
    dataType: 'combine-source-settings',
    vizMode: 'combine-source-settings',
    targetWidgetId,
    sourceId,
    label: label ?? 'Settings',
    layout: layout ?? { x: 0, y: 0, ...defaultSize('combine-source-settings') },
  };
}

// Build a fresh combine widget record — a single big graph overlaying several
// independently-configured sources (any mix of analog/digital/capacitive)
// instead of one dataType+channel. See createWidget() below for the
// single-channel counterpart.
export function createCombineWidget({ sources, label, layout }) {
  return {
    id: makeId(),
    dataType: 'combine',
    vizMode: 'combine',
    sources: (sources ?? []).map((s, i) => normalizeSource({ ...s, color: s.color ?? colorForSourceIndex(i) })),
    label: label ?? 'Combined',
    layout: layout ?? { x: 0, y: 0, ...defaultSize('combine') },
    timeWindow: 5, // seconds
  };
}

// Build a fresh widget record. `layout` (x,y,w,h in grid units) is assigned
// by the caller (DashboardStore.add) via the grid engine's auto-placement.
export function createWidget({ dataType, channel, vizMode, label, layout, sensor }) {
  return {
    id: makeId(),
    dataType,
    channel,
    vizMode,
    label: label ?? defaultLabel(dataType, channel),
    layout: layout ?? { x: 0, y: 0, ...defaultSize(vizMode) },
    timeWindow: 5,                                   // seconds
    yAxis: { autoscale: true, min: 0, max: 1 },
    filterConfig: {},
    sensor:        sensor ?? null,                   // analog only: { typeId, customUnit, multiplier, customOffset }
    capHwThresh:   dataType === 'capacitive' ? { touch: 12, release: 6 } : null,  // MPR121 hardware thresholds
  };
}

export class DashboardStore {
  constructor() {
    this._widgets = this._load();
    this._listeners = new Set();
  }

  list() {
    return this._widgets;
  }

  get(id) {
    return this._widgets.find(w => w.id === id);
  }

  // Add a widget. `placeFn(size)` is called to obtain a free grid layout
  // ({x,y,w,h}) — the caller wires this to the GridEngine's auto-placement
  // so dashboard-state.js stays decoupled from grid math.
  add(def, placeFn) {
    const vizMode = def.dataType === 'combine' || def.dataType === 'combine-source-settings' ? def.dataType : def.vizMode;
    const size = defaultSize(vizMode);
    const layout = placeFn ? { ...placeFn(size), ...size } : { x: 0, y: 0, ...size };
    let widget;
    if (def.dataType === 'combine') widget = createCombineWidget({ ...def, layout });
    else if (def.dataType === 'combine-source-settings') widget = createSourceSettingsWidget({ ...def, layout });
    else widget = createWidget({ ...def, layout });
    this._widgets.push(widget);
    this._save();
    this._emit();
    return widget;
  }

  // Add a source to a live combine widget. Mutates the widget's `sources`
  // array in place (same convention as update()/updateLayout()) so a mounted
  // Widget instance's `this.def` reflects the change immediately.
  addSourceToWidget(id, sourceDef) {
    const w = this.get(id);
    if (!w) return null;
    const source = normalizeSource({ ...sourceDef, color: sourceDef.color ?? colorForSourceIndex(w.sources.length) });
    w.sources.push(source);
    this._save();
    return source;
  }

  removeSourceFromWidget(id, sourceId) {
    const w = this.get(id);
    if (!w) return;
    const i = w.sources.findIndex(s => s.id === sourceId);
    if (i === -1) return;
    w.sources.splice(i, 1);
    this._save();
  }

  updateSource(id, sourceId, patch) {
    const w = this.get(id);
    const source = w?.sources.find(s => s.id === sourceId);
    if (!source) return;
    Object.assign(source, patch);
    this._save();
  }

  remove(id) {
    this._widgets = this._widgets.filter(w => w.id !== id);
    this._save();
    this._emit();
  }

  // Remove every widget — used by the toolbar's Reset button.
  clear() {
    this._widgets = [];
    this._save();
    this._emit();
  }

  update(id, patch) {
    const w = this.get(id);
    if (!w) return;
    Object.assign(w, patch);
    this._save();
  }

  updateLayout(id, layout) {
    const w = this.get(id);
    if (!w) return;
    w.layout = { ...w.layout, ...layout };
    this._save();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this._widgets);
  }

  _save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._widgets)); } catch {}
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
