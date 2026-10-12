// widget-modal.js — "Add Widget" flow: data type → channel → visualization → label.

import { CHANNEL_COUNT, VIZ_MODES, defaultLabel } from './dashboard-state.js';

const TYPE_OPTIONS = [
  { id: 'analog',     label: 'ANALOG' },
  { id: 'digital',    label: 'DIGITAL' },
  { id: 'capacitive', label: 'CAPACITIVE' },
  { id: 'combine',    label: 'COMBINE' },
];

const CH_PREFIX = { analog: 'A', digital: 'D', capacitive: 'C' };
const SOURCE_TYPE_OPTIONS = [
  { id: 'analog',     label: 'A' },
  { id: 'digital',    label: 'D' },
  { id: 'capacitive', label: 'C' },
];

export class WidgetModal {
  constructor() {
    this._onSubmit = null;
    this._labelDirty = false;
    this._state = { dataType: 'analog', channel: 0, vizMode: VIZ_MODES.analog[0].id, sources: [] };
    this._sourceBuilder = { type: 'analog', channel: 0 };
    this._build();
  }

  onSubmit(fn) { this._onSubmit = fn; }

  open() {
    this._state = { dataType: 'analog', channel: 0, vizMode: VIZ_MODES.analog[0].id, sources: [] };
    this._sourceBuilder = { type: 'analog', channel: 0 };
    this._labelDirty = false;
    this._syncTypeButtons();
    this._syncChannelOptions();
    this._syncVizButtons();
    this._syncFieldsForType();
    this._syncSourceTypeButtons();
    this._syncSourceBuilderChannelOptions();
    this._syncSourceList();
    this._syncLabel();
    this._backdrop.classList.add('open');
    this._channelSelect.focus();
  }

  close() {
    this._backdrop.classList.remove('open');
  }

  _build() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) this.close(); });

    const modal = document.createElement('div');
    modal.className = 'modal add-widget-modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'ADD WIDGET';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.close());
    header.append(title, closeBtn);
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.appendChild(this._buildField('DATA TYPE', this._buildTypeRow()));
    this._channelField = this._buildField('CHANNEL', this._buildChannelRow());
    this._vizField = this._buildField('VISUALIZATION', this._buildVizRow());
    this._sourcesField = this._buildField('SOURCES', this._buildSourcesRow());
    body.append(this._channelField, this._vizField, this._sourcesField);
    body.appendChild(this._buildField('LABEL', this._buildLabelRow()));
    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'modal-btn modal-btn--ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.close());
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'modal-btn modal-btn--primary';
    addBtn.textContent = 'Add Widget';
    addBtn.addEventListener('click', () => this._submit());
    footer.append(cancelBtn, addBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    this._backdrop = backdrop;
  }

  _buildField(labelText, controlEl) {
    const row = document.createElement('div');
    row.className = 'modal-field';
    const label = document.createElement('div');
    label.className = 'modal-field-label';
    label.textContent = labelText;
    row.append(label, controlEl);
    return row;
  }

  _buildTypeRow() {
    const row = document.createElement('div');
    row.className = 'modal-segmented';
    this._typeButtons = TYPE_OPTIONS.map(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-segment';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        this._state.dataType = opt.id;
        if (opt.id !== 'combine') {
          this._state.channel = 0;
          this._state.vizMode = VIZ_MODES[opt.id][0].id;
          this._syncChannelOptions();
          this._syncVizButtons();
        }
        this._syncTypeButtons();
        this._syncFieldsForType();
        this._syncLabel();
      });
      row.appendChild(btn);
      return { id: opt.id, btn };
    });
    return row;
  }

  _buildChannelRow() {
    const select = document.createElement('select');
    select.className = 'filter-select modal-channel-select';
    select.addEventListener('change', () => {
      this._state.channel = Number(select.value);
      this._syncLabel();
    });
    this._channelSelect = select;
    return select;
  }

  _buildVizRow() {
    const row = document.createElement('div');
    row.className = 'modal-segmented';
    this._vizRow = row;
    return row;
  }

  // SOURCES field (combine widget only) — a mini type+channel+Add builder
  // above a running list of removable chips for what's been added so far.
  _buildSourcesRow() {
    const wrap = document.createElement('div');
    wrap.className = 'modal-sources';

    const builder = document.createElement('div');
    builder.className = 'modal-source-builder';

    const typeRow = document.createElement('div');
    typeRow.className = 'modal-segmented modal-segmented--compact';
    this._sourceTypeButtons = SOURCE_TYPE_OPTIONS.map(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-segment';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        this._sourceBuilder.type = opt.id;
        this._sourceBuilder.channel = 0;
        this._syncSourceTypeButtons();
        this._syncSourceBuilderChannelOptions();
      });
      typeRow.appendChild(btn);
      return { id: opt.id, btn };
    });

    const channelSelect = document.createElement('select');
    channelSelect.className = 'filter-select';
    channelSelect.addEventListener('change', () => {
      this._sourceBuilder.channel = Number(channelSelect.value);
    });
    this._sourceChannelSelect = channelSelect;

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'modal-btn modal-btn--ghost modal-source-add';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      this._state.sources.push({ type: this._sourceBuilder.type, channel: this._sourceBuilder.channel });
      this._syncSourceList();
    });

    builder.append(typeRow, channelSelect, addBtn);
    wrap.appendChild(builder);

    const list = document.createElement('div');
    list.className = 'modal-source-list';
    this._sourceList = list;
    wrap.appendChild(list);

    return wrap;
  }

  _buildLabelRow() {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'filter-number modal-label-input';
    input.spellcheck = false;
    input.addEventListener('input', () => { this._labelDirty = input.value.trim().length > 0; });
    this._labelInput = input;
    return input;
  }

  _syncTypeButtons() {
    for (const { id, btn } of this._typeButtons) btn.classList.toggle('active', id === this._state.dataType);
  }

  _syncChannelOptions() {
    const count = CHANNEL_COUNT[this._state.dataType];
    const prefix = CH_PREFIX[this._state.dataType];
    this._channelSelect.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${prefix}${i}`;
      this._channelSelect.appendChild(opt);
    }
    this._channelSelect.value = this._state.channel;
  }

  _syncVizButtons() {
    this._vizRow.innerHTML = '';
    for (const mode of VIZ_MODES[this._state.dataType]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-segment';
      btn.textContent = mode.label;
      btn.classList.toggle('active', mode.id === this._state.vizMode);
      btn.addEventListener('click', () => {
        this._state.vizMode = mode.id;
        this._vizRow.querySelectorAll('.modal-segment').forEach(b => b.classList.toggle('active', b === btn));
      });
      this._vizRow.appendChild(btn);
    }
  }

  _syncLabel() {
    if (this._labelDirty) return;
    this._labelInput.value = this._state.dataType === 'combine'
      ? 'Combined'
      : defaultLabel(this._state.dataType, this._state.channel);
  }

  // Show CHANNEL + VISUALIZATION for single-channel widgets, SOURCES for combine.
  _syncFieldsForType() {
    const isCombine = this._state.dataType === 'combine';
    this._channelField.style.display = isCombine ? 'none' : '';
    this._vizField.style.display = isCombine ? 'none' : '';
    this._sourcesField.style.display = isCombine ? '' : 'none';
  }

  _syncSourceTypeButtons() {
    for (const { id, btn } of this._sourceTypeButtons) btn.classList.toggle('active', id === this._sourceBuilder.type);
  }

  _syncSourceBuilderChannelOptions() {
    const count = CHANNEL_COUNT[this._sourceBuilder.type];
    const prefix = CH_PREFIX[this._sourceBuilder.type];
    this._sourceChannelSelect.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${prefix}${i}`;
      this._sourceChannelSelect.appendChild(opt);
    }
    this._sourceChannelSelect.value = this._sourceBuilder.channel;
  }

  _syncSourceList() {
    this._sourceList.innerHTML = '';
    this._state.sources.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'modal-source-chip';
      chip.textContent = `${CH_PREFIX[s.type]}${s.channel}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this._state.sources.splice(i, 1);
        this._syncSourceList();
      });
      chip.appendChild(remove);
      this._sourceList.appendChild(chip);
    });
  }

  _submit() {
    if (this._state.dataType === 'combine') {
      if (this._state.sources.length === 0) return;
      const label = this._labelInput.value.trim() || 'Combined';
      this._onSubmit?.({ dataType: 'combine', sources: this._state.sources, label });
    } else {
      const label = this._labelInput.value.trim() || defaultLabel(this._state.dataType, this._state.channel);
      this._onSubmit?.({ ...this._state, label });
    }
    this.close();
  }
}
