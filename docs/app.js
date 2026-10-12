// app.js — Orchestrator. Wires transport → protocol → dashboard widgets.
//
// The dashboard is a free grid of independent widget cards (widget.js) laid
// out by GridEngine and persisted by DashboardStore. This module's only job
// is: manage the transport connection, and forward each incoming
// {type, channel, value, timestamp} frame to every widget currently
// watching that type+channel — any number of widgets (including zero) may
// watch the same physical channel, each with its own filters and display.

import { Protocol }           from './protocol.js';
import { BluetoothTransport } from './transport/bluetooth.js';
import { SerialTransport }    from './transport/serial.js';
import { DashboardStore, CHANNEL_COUNT, MIN_SIZE } from './dashboard-state.js';
import { GridEngine }         from './grid-engine.js';
import { Widget, closeOpenPopover } from './widget.js';
import { WidgetModal }        from './widget-modal.js';

const protocol = new Protocol();
const store    = new DashboardStore();

let currentTransport = null;
let gridEngine        = null;
const widgets = new Map(); // id -> Widget instance

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
  bindTransportButtons();
  bindAddWidgetButton();
  bindResetButton();
  listenProtocol();
});

// ── Dashboard init ────────────────────────────────────────────────────────
function initDashboard() {
  const canvas = document.getElementById('dashboard-canvas');
  gridEngine = new GridEngine(canvas, { cols: 12, rowHeight: 48, margin: 12 });
  gridEngine.onLayoutChange((layout) => {
    for (const item of layout) store.updateLayout(item.id, item);
  });
  canvas.addEventListener('scroll', closeOpenPopover);

  for (const def of store.list()) mountWidget(def);
  gridEngine.settle(); // guard against a stale/edited layout overlapping on load
  updateEmptyState();
}

function mountWidget(def) {
  const widget = new Widget(def, store, {
    onRemove:  handleWidgetRemoved,
    onCommand: (cmd) => currentTransport?.send?.(JSON.stringify(cmd)),
    onOpenSourceSettings: (sourceId) => openSourceSettingsWidget(def.id, sourceId),
  });
  widgets.set(def.id, widget);
  document.getElementById('dashboard-canvas').appendChild(widget.el);

  const min = MIN_SIZE[def.vizMode] ?? { w: 2, h: 2 };
  gridEngine.addItem(
    { id: def.id, x: def.layout.x, y: def.layout.y, w: def.layout.w, h: def.layout.h, minW: min.w, minH: min.h },
    widget.el
  );
}

// Creates (or, if one already exists for this exact source, leaves alone) a
// small header-only companion widget that controls one combine source's
// filters/Y-axis without the sidebar's tiny icons.
function openSourceSettingsWidget(targetWidgetId, sourceId) {
  const existing = store.list().find(w =>
    w.dataType === 'combine-source-settings' && w.targetWidgetId === targetWidgetId && w.sourceId === sourceId
  );
  if (existing) return;

  const targetDef = store.get(targetWidgetId);
  const sourceDef = targetDef?.sources.find(s => s.id === sourceId);
  const label = sourceDef ? `${sourceDef.label} SETTINGS` : 'Settings';

  const def = store.add(
    { dataType: 'combine-source-settings', targetWidgetId, sourceId, label },
    (size) => gridEngine.autoPlace(size)
  );
  mountWidget(def);
  updateEmptyState();
}

function handleWidgetRemoved(id) {
  widgets.delete(id);
  gridEngine.removeItem(id);
  store.remove(id);
  updateEmptyState();
}

function updateEmptyState() {
  const empty = document.getElementById('dashboard-empty');
  if (empty) empty.hidden = widgets.size > 0;
}

// ── Add Widget ────────────────────────────────────────────────────────────
function bindAddWidgetButton() {
  const modal = new WidgetModal();
  modal.onSubmit((payload) => {
    const def = store.add(payload, (size) => gridEngine.autoPlace(size));
    mountWidget(def);
    updateEmptyState();
  });
  document.getElementById('add-widget-btn').addEventListener('click', () => modal.open());
}

// ── Reset ─────────────────────────────────────────────────────────────────
function bindResetButton() {
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    if (widgets.size === 0) return;
    const n = widgets.size;
    const ok = window.confirm(`Remove all ${n} widget${n === 1 ? '' : 's'} from the dashboard? This can't be undone.`);
    if (!ok) return;

    for (const id of [...widgets.keys()]) {
      widgets.get(id).destroy();
      gridEngine.removeItem(id);
    }
    widgets.clear();
    store.clear();
    updateEmptyState();
  });
}

// ── Transport switching ───────────────────────────────────────────────────
function bindTransportButtons() {
  document.querySelectorAll('[data-transport]').forEach(btn => {
    btn.addEventListener('click', () => switchTransport(btn.dataset.transport));
  });
}

async function switchTransport(name) {
  if (currentTransport) {
    currentTransport.removeEventListener('data',         onRawData);
    currentTransport.removeEventListener('connected',    onConnected);
    currentTransport.removeEventListener('disconnected', onDisconnected);
    if (currentTransport.connected) await currentTransport.disconnect().catch(() => {});
  }

  const map = {
    bluetooth: () => new BluetoothTransport(),
    serial:    () => new SerialTransport(),
  };
  if (!map[name]) return;
  currentTransport = map[name]();

  currentTransport.addEventListener('data',         onRawData);
  currentTransport.addEventListener('connected',    onConnected);
  currentTransport.addEventListener('disconnected', onDisconnected);

  document.querySelectorAll('[data-transport]').forEach(b =>
    b.classList.toggle('active', b.dataset.transport === name)
  );

  setStatus('CONNECTING…', 'pending');
  try {
    await currentTransport.connect();
  } catch (err) {
    setStatus(`ERROR: ${err.message}`, 'error');
    console.warn('[transport]', err.message);
  }
}

function onRawData(e)     { protocol.receive(e.detail); }
function onConnected()    { setStatus('CONNECTED', 'ok'); }
function onDisconnected() { setStatus('DISCONNECTED', 'off'); }

function setStatus(text, state) {
  setText('status-label', text);
  const dot = document.getElementById('status-dot');
  if (dot) dot.dataset.state = state;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Protocol → widgets ────────────────────────────────────────────────────
function listenProtocol() {
  protocol.addEventListener('analog', (e) => {
    const { channel, value, timestamp, unit, isVoltage } = e.detail;
    if (channel < 0 || channel >= CHANNEL_COUNT.analog) return;
    routeValue('analog', channel, value, timestamp, unit, isVoltage);
  });

  protocol.addEventListener('digital', (e) => {
    const { channel, value, timestamp } = e.detail;
    if (channel < 0 || channel >= CHANNEL_COUNT.digital) return;
    routeValue('digital', channel, value, timestamp);
  });

  protocol.addEventListener('capacitive', (e) => {
    const { channel, value, timestamp, touched, baseline } = e.detail;
    if (channel < 0 || channel >= CHANNEL_COUNT.capacitive) return;
    routeValue('capacitive', channel, value, timestamp, undefined, undefined, { touched, baseline });
  });
}

function routeValue(type, channel, value, timestamp, unit, isVoltage, extras) {
  for (const widget of widgets.values()) {
    if (widget.def.dataType === type && widget.def.channel === channel) {
      widget.handleValue(value, timestamp, unit, isVoltage, extras);
    } else if (widget.def.dataType === 'combine') {
      const src = widget.def.sources.find(s => s.type === type && s.channel === channel);
      if (src) widget.handleSourceValue(src.id, value, timestamp, unit, isVoltage, extras);
    }
  }
}
