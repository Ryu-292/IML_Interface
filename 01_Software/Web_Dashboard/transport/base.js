// BaseTransport — abstract interface every transport must implement.
// Subclasses call this._emit(rawString) when data arrives,
// and this._setConnected(bool) on connection state changes.

export class BaseTransport extends EventTarget {
  constructor() {
    super();
    this._connected = false;
  }

  get name() { return 'base'; }
  get connected() { return this._connected; }

  async connect() {
    throw new Error(`${this.name}: connect() not implemented`);
  }

  async disconnect() {
    throw new Error(`${this.name}: disconnect() not implemented`);
  }

  // Send raw data to the device (write-back). Only transports that support
  // bidirectional comms override this — others silently drop the call.
  async send(data) {}  // eslint-disable-line no-unused-vars

  _emit(rawData) {
    this.dispatchEvent(new CustomEvent('data', { detail: rawData }));
  }

  _setConnected(value) {
    this._connected = value;
    this.dispatchEvent(new CustomEvent(value ? 'connected' : 'disconnected'));
  }
}
