// grid-engine.js — Vanilla "iPhone home screen" style grid layout.
//
// No external dependency (the project ships no build step / npm packages),
// but the model mirrors react-grid-layout: integer grid coordinates mapped
// to pixels, pointer-driven drag/resize, and a collision pass that flows
// other widgets around whichever one is currently fixed (being dragged or
// resized) so nothing ever overlaps.
//
// Two distinct passes, used at different times:
//   - pushCollisions(): live-preview pass during drag/resize. Always
//     recomputed from a frozen start-of-gesture snapshot, so it's stable
//     frame to frame — only items actually in the way move, and only as far
//     as needed to clear. Everything else holds still.
//   - compact(): one-shot top-compaction run once on drop, closing any
//     gaps left behind.
// Positioning uses `transform: translate()` (compositor-only) rather than
// left/top, so reflowing several widgets at once doesn't trigger layout.

function collides(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Top-compaction: every non-fixed item gets the minimal y that avoids
// overlapping `fixedId` (kept untouched at its current rect) and every
// other item, processed in (y, x) order. Pass fixedId = null to settle
// the whole grid (e.g. after a remove, or once on initial load).
function compact(items, fixedId) {
  const fixed = fixedId ? items.find(it => it.id === fixedId) : null;
  const rest = items.filter(it => it.id !== fixedId)
                     .sort((a, b) => a.y - b.y || a.x - b.x);
  const placed = fixed ? [fixed] : [];
  for (const item of rest) {
    let y = 0;
    for (const p of placed) {
      if (item.x < p.x + p.w && item.x + item.w > p.x) {
        y = Math.max(y, p.y + p.h);
      }
    }
    item.y = y;
    placed.push(item);
  }
}

// Live-preview reflow: push only items that actually collide with `fixedId`
// straight down (cascading if that push creates a new collision), leaving
// every non-colliding item exactly where it is. Deterministic for a given
// `items` snapshot, so calling it repeatedly from a frozen start-of-drag
// snapshot never drifts or jitters.
function pushCollisions(items, fixedId) {
  const order = [fixedId, ...items.filter(it => it.id !== fixedId).map(it => it.id)];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < items.length + 4) {
    changed = false;
    for (const id of order) {
      const cur = items.find(it => it.id === id);
      for (const other of items) {
        if (other.id === id) continue;
        if (collides(cur, other)) {
          const desiredY = cur.y + cur.h;
          if (other.y < desiredY) { other.y = desiredY; changed = true; }
        }
      }
    }
  }
}

export class GridEngine {
  constructor(container, { cols = 12, rowHeight = 48, margin = 12 } = {}) {
    this.container = container;
    this.cols = cols;
    this.rowHeight = rowHeight;
    this.margin = margin;
    this.items = new Map(); // id -> { id, x, y, w, h, minW, minH, el }
    this._onLayoutChange = null;
    this._colWidth = 0;

    container.style.position = 'relative';
    this._ro = new ResizeObserver(() => this._recalcColWidth());
    this._ro.observe(container);
    this._recalcColWidth();
  }

  onLayoutChange(fn) { this._onLayoutChange = fn; }

  // Register a widget element with its initial grid rect; wires its own
  // drag handle (`.widget-drag-handle`) and resize handle (`.widget-resize-handle`).
  addItem(rect, el) {
    const item = {
      id: rect.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      minW: rect.minW ?? 2, minH: rect.minH ?? 2, el,
    };
    this.items.set(rect.id, item);
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.willChange = 'transform';
    this._wireDrag(item);
    this._wireResize(item);
    this._applyRect(item, false);
    this._growContainer();
  }

  removeItem(id) {
    this.items.delete(id);
    compact([...this.items.values()], null);
    this.layoutAll();
  }

  getLayout() {
    return [...this.items.values()].map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
  }

  // First free top-left slot for a new item of `size`, scanning row by row.
  autoPlace(size) {
    const items = [...this.items.values()];
    for (let y = 0; y < 2000; y++) {
      for (let x = 0; x <= this.cols - size.w; x++) {
        const cand = { x, y, w: size.w, h: size.h };
        if (!items.some(it => collides(cand, it))) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  // Re-settle the whole grid (no fixed item) and re-render. Call once after
  // bulk-loading persisted widgets so a stale/edited layout can't overlap.
  settle() {
    compact([...this.items.values()], null);
    this.layoutAll();
  }

  layoutAll() {
    for (const item of this.items.values()) this._applyRect(item, true);
    this._growContainer();
  }

  destroy() {
    this._ro.disconnect();
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  _recalcColWidth() {
    const w = this.container.clientWidth;
    this._colWidth = this.cols > 0 ? (w - this.margin * (this.cols + 1)) / this.cols : 0;
    this.layoutAll();
  }

  _px(rect) {
    const cw = this._colWidth, m = this.margin, rh = this.rowHeight;
    return {
      x:      m + rect.x * (cw + m),
      y:      m + rect.y * (rh + m),
      width:  rect.w * cw + (rect.w - 1) * m,
      height: rect.h * rh + (rect.h - 1) * m,
    };
  }

  _setElRect(el, px, animate) {
    el.style.transition = animate
      ? 'transform 200ms cubic-bezier(0.22,1,0.36,1), width 200ms cubic-bezier(0.22,1,0.36,1), height 200ms cubic-bezier(0.22,1,0.36,1)'
      : 'none';
    el.style.transform = `translate(${px.x}px, ${px.y}px)`;
    el.style.width  = `${px.width}px`;
    el.style.height = `${px.height}px`;
  }

  _applyRect(item, animate) {
    this._setElRect(item.el, this._px(item), animate);
  }

  _growContainer() {
    let maxY = 0;
    for (const it of this.items.values()) maxY = Math.max(maxY, it.y + it.h);
    this.container.style.height = `${this.margin + maxY * (this.rowHeight + this.margin)}px`;
  }

  _commit() {
    this._onLayoutChange?.(this.getLayout());
  }

  // Render a working (snapshot-derived) layout for every item except
  // `skipId` — used during live drag/resize so other widgets animate to
  // their preview position while the active one follows the pointer raw.
  _previewOthers(working, skipId) {
    for (const w of working) {
      if (w.id === skipId) continue;
      const item = this.items.get(w.id);
      if (item) this._setElRect(item.el, this._px(w), true);
    }
  }

  // Write a finished working layout back into canonical state, settle any
  // remaining gaps, and report the new layout.
  _commitWorking(working) {
    for (const w of working) {
      const item = this.items.get(w.id);
      if (item) { item.x = w.x; item.y = w.y; item.w = w.w; item.h = w.h; }
    }
    compact([...this.items.values()], null);
    this.layoutAll();
    this._commit();
  }

  // ── drag ──────────────────────────────────────────────────────────────────

  _wireDrag(item) {
    const handle = item.el.querySelector('.widget-drag-handle') ?? item.el;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, textarea, a')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);

      const snapshot = [...this.items.values()].map(it => ({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h }));
      const startPx = this._px(item);
      const startClientX = e.clientX, startClientY = e.clientY;
      let working = snapshot;
      let lastGx = item.x, lastGy = item.y;

      item.el.classList.add('widget-card--dragging');
      item.el.style.zIndex = '1000';
      item.el.style.transition = 'none';

      const onMove = (ev) => {
        const dx = ev.clientX - startClientX, dy = ev.clientY - startClientY;
        const rawX = startPx.x + dx, rawY = startPx.y + dy;
        item.el.style.transform = `translate(${rawX}px, ${rawY}px)`;

        const gx = clamp(Math.round((rawX - this.margin) / (this._colWidth + this.margin)), 0, this.cols - item.w);
        const gy = Math.max(0, Math.round((rawY - this.margin) / (this.rowHeight + this.margin)));
        if (gx === lastGx && gy === lastGy) return;
        lastGx = gx; lastGy = gy;

        working = snapshot.map(s => s.id === item.id ? { ...s, x: gx, y: gy } : { ...s });
        pushCollisions(working, item.id);
        this._previewOthers(working, item.id);
      };

      const onUp = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        item.el.classList.remove('widget-card--dragging');
        item.el.style.zIndex = '';
        this._commitWorking(working);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  // ── resize ───────────────────────────────────────────────────────────────

  _wireResize(item) {
    const handle = item.el.querySelector('.widget-resize-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);

      const snapshot = [...this.items.values()].map(it => ({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h }));
      const startPx = this._px(item);
      const startClientX = e.clientX, startClientY = e.clientY;
      let working = snapshot;
      let lastGw = item.w, lastGh = item.h;

      item.el.classList.add('widget-card--resizing');
      item.el.style.zIndex = '1000';
      item.el.style.transition = 'none';

      const onMove = (ev) => {
        const dx = ev.clientX - startClientX, dy = ev.clientY - startClientY;
        const w = Math.max(startPx.width + dx, this._colWidth);
        const h = Math.max(startPx.height + dy, this.rowHeight);
        item.el.style.width  = `${w}px`;
        item.el.style.height = `${h}px`;

        const gw = clamp(Math.round((w + this.margin) / (this._colWidth + this.margin)), item.minW, this.cols - item.x);
        const gh = Math.max(item.minH, Math.round((h + this.margin) / (this.rowHeight + this.margin)));
        if (gw === lastGw && gh === lastGh) return;
        lastGw = gw; lastGh = gh;

        working = snapshot.map(s => s.id === item.id ? { ...s, w: gw, h: gh } : { ...s });
        pushCollisions(working, item.id);
        this._previewOthers(working, item.id);
      };

      const onUp = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        item.el.classList.remove('widget-card--resizing');
        item.el.style.zIndex = '';
        this._commitWorking(working);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }
}
