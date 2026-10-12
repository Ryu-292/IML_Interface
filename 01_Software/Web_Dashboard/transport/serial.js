import { BaseTransport } from './base.js';

export class SerialTransport extends BaseTransport {
  constructor() {
    super();
    this._port = null;
    this._reader = null;
    this._readLoopActive = false;
  }

  get name() { return 'serial'; }

  async connect() {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial API not supported — use Chrome or Edge');
    }

    // TODO: optionally filter by USB vendorId/productId for your ESP32
    this._port = await navigator.serial.requestPort();
    await this._port.open({ baudRate: 115200 });

    this._setConnected(true);
    this._readLoopActive = true;
    this._readLoop();
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let buffer = '';

    while (this._readLoopActive && this._port?.readable) {
      this._reader = this._port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this._reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) this._emit(trimmed);
          }
        }
      } catch {
        // Port closed or read cancelled — exit loop
      } finally {
        this._reader.releaseLock();
        this._reader = null;
      }
    }

    this._setConnected(false);
  }

  async disconnect() {
    this._readLoopActive = false;
    if (this._reader) {
      await this._reader.cancel().catch(() => {});
      this._reader = null;
    }
    if (this._port) {
      await this._port.close().catch(() => {});
      this._port = null;
    }
    this._setConnected(false);
  }
}
