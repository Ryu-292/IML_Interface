#include "ble_link.h"
#include "oled_display.h"
#include "sensors.h"
#include "mpr121.h"
#include <string>

NimBLECharacteristic* txChar = nullptr;
bool clientReady = false;

// ── Incoming command handler ──────────────────────────────────────────────────
// Parses {"cmd":"cap_thresh","touch":N,"release":N} from the dashboard.
// Uses simple string scanning — no JSON library needed for these fixed fields.
static void handleCommand(const std::string& json) {
  if (json.find("\"cap_thresh\"") == std::string::npos) return;

  auto extractU8 = [&](const char* key) -> int {
    size_t pos = json.find(key);
    if (pos == std::string::npos) return -1;
    pos += strlen(key);
    while (pos < json.size() && (json[pos] == ':' || json[pos] == ' ')) pos++;
    if (pos >= json.size() || !isdigit(json[pos])) return -1;
    int v = 0;
    while (pos < json.size() && isdigit(json[pos])) { v = v * 10 + (json[pos++] - '0'); }
    return v;
  };

  int touch   = extractU8("\"touch\"");
  int release = extractU8("\"release\"");
  if (touch > 0 && release > 0 && touch > release && touch <= 255 && release <= 255) {
    mpr121SetThresholds((uint8_t)touch, (uint8_t)release);
  }
}

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo&) override {
    handleCommand(chr->getValue());
  }
};

// NimBLE callbacks — corrected for newer NimBLE-Arduino
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& connInfo) override {
    clientReady = true;
    resetCapTimer();

    // Request fastest BLE connection interval the spec allows (7.5ms).
    // Chrome/Web Bluetooth honours this; actual interval will be 7.5-15ms.
    server->updateConnParams(connInfo.getConnHandle(), 6, 12, 0, 100);

    Serial.println("[BLE] Client connected");

    sendStatusFrame();
    oledUpdateStatus();
  }

  void onDisconnect(NimBLEServer* server, NimBLEConnInfo& connInfo, int reason) override {
    clientReady = false;

    Serial.println("[BLE] Client disconnected — restarting advertising");

    NimBLEDevice::startAdvertising();
    oledUpdateStatus();
  }
};

void bleInit() {
  NimBLEDevice::init("IML-Sensor");
  NimBLEDevice::setMTU(512);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(NUS_SERVICE_UUID);

  txChar = svc->createCharacteristic(
    NUS_TX_UUID,
    NIMBLE_PROPERTY::NOTIFY
  );

  NimBLECharacteristic* rxChar = svc->createCharacteristic(
    NUS_RX_UUID,
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  rxChar->setCallbacks(new RxCallbacks());

  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->enableScanResponse(true);

  NimBLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising — connect from Chrome dashboard");
}

void bleNotify(const char* buf, int len) {
  if (!txChar || !clientReady) return;

  // NOTIFY (not INDICATE — see createCharacteristic() above) never blocks
  // waiting for an ack. If the stack can't queue it right now (congested
  // link, no free buffers), notify() just fails and we drop this frame —
  // we never retry or hold onto it. The next BLE_SEND_MS tick carries
  // fresher data anyway, so dropping a stale frame beats backing one up.
  txChar->setValue((const uint8_t*)buf, len);
  if (!txChar->notify()) {
    Serial.println("[BLE] notify skipped (stack busy)");
  }
}
