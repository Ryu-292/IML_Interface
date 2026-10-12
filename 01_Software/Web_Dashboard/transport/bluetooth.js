import { BaseTransport } from './base.js';

// Nordic UART Service — standard BLE serial profile.
// ESP32 NimBLE firmware must advertise this service and notify on TX_CHAR.
const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → browser
const RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // browser → device

export class BluetoothTransport extends BaseTransport {
  constructor() {
    super();
    this._device     = null;
    this._txChar     = null;
    this._rxChar     = null;
  }

  get name() { return 'bluetooth'; }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser. Use Chrome or Edge.');
    }

    this._device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });

    this._device.addEventListener('gattserverdisconnected', () => {
      this._txChar = null;
      this._rxChar = null;
      this._setConnected(false);
    });

    const server  = await this._device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this._txChar  = await service.getCharacteristic(TX_CHAR_UUID);

    // RX characteristic is optional — older firmware without it still works.
    this._rxChar  = await service.getCharacteristic(RX_CHAR_UUID).catch(() => null);

    // Auto-detect JSON (first byte = '{') vs legacy binary frames.
    this._txChar.addEventListener('characteristicvaluechanged', (e) => {
      const buf       = e.target.value.buffer;
      const firstByte = new Uint8Array(buf)[0];
      if (firstByte === 0x7B) {
        this._emit(new TextDecoder('utf-8').decode(buf));
      } else {
        this._emit(buf);
      }
    });
    await this._txChar.startNotifications();

    this._setConnected(true);
  }

  // Write a JSON command string to the device. No-op if the device doesn't
  // expose the RX characteristic (older firmware) or isn't connected.
  async send(data) {
    if (!this._rxChar) return;
    const bytes = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
    await this._rxChar.writeValue(bytes);
  }

  async disconnect() {
    if (this._txChar) {
      await this._txChar.stopNotifications().catch(() => {});
      this._txChar = null;
    }
    this._rxChar = null;
    if (this._device?.gatt?.connected) {
      this._device.gatt.disconnect();
    }
    this._device = null;
    this._setConnected(false);
  }
}
