/*
 * IML Sensor — 4 analog + 4 digital + 12 capacitive channels over BLE (JSON)
 *
 * ── Simulated channels ──────────────────────────────────────────────────────
 *   Analog 0-3  Simulated voltage (0–3.3 V), distinct waveforms — see sim_analog()
 *   Digital 0   Toggle          0.5 Hz  (1 s on / 1 s off)
 *   Digital 1   Toggle          1 Hz    (0.5 s on / 0.5 s off)
 *   Digital 2   Toggle          0.25 Hz (2 s on / 2 s off)
 *   Digital 3   Toggle          ~0.17 Hz (3 s on / 3 s off)
 *   Cap 0–11    Touch pads      0.0–1.0 raw signal, idle + random touches
 *
 * ── BLE packets ──────────────────────────────────────────────────────────────
 *   Data:    {"m":"data","ts":123456,"a":[v0,v1,v2,v3],"d":[0/1 x4],"c":[0.0–1.0 x12]}
 *   Status:  {"t":"s","a":4,"d":4,"c":12}   sent once, on connect
 *
 * "a" is always volts, matching the real ADS1115 firmware — no per-channel
 * units or ids on the wire, and no variable channel counts: this mirrors the
 * real board, which always has exactly 4 analog + 4 digital + 12 cap wired.
 * One combined frame per send tick, not three.
 *
 * Service UUID : 6e400001-b5a3-f393-e0a9-e50e24dcca9e
 * TX char UUID : 6e400003-b5a3-f393-e0a9-e50e24dcca9e
 * Send rate    : 30 Hz  (SEND_MS = 33)
 */

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <math.h>

// ── Configuration ─────────────────────────────────────────────────────────────
#define NUS_SERVICE_UUID  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX_UUID       "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define SEND_MS           33      // ~30 Hz BLE transmit rate

// ── BLE globals ───────────────────────────────────────────────────────────────
static NimBLECharacteristic* txChar      = nullptr;
static bool                  clientReady = false;
static uint32_t              lastSend    = 0;

// ── Capacitive state ──────────────────────────────────────────────────────────
static float capTouch[12] = {};

// ── Simulated sensor functions ────────────────────────────────────────────────

// Analog — 4 channels of simulated voltage (0–3.3 V-ish), matching what the
// ADS1115 actually outputs on real hardware (no per-channel "unit" on the
// wire). Distinct waveforms purely so channels are visually distinguishable.
float sim_analog(int ch, float t) {
  switch (ch) {
    case 0: return 1.65f + 1.00f * sinf(2.0f * PI * 0.10f * t);     // slow sine
    case 1: return 1.65f + 0.80f * sinf(2.0f * PI * 0.03f * t);     // slower drift
    case 2: return 1.65f + (float)random(-1000, 1000) / 1000.0f;    // noisy
    case 3: return 1.65f + 1.50f * sinf(2.0f * PI * 0.25f * t);     // faster sine
    default: return 0.0f;
  }
}

// Digital — four independent toggles at different frequencies
int sim_digital(int ch, float t) {
  switch (ch) {
    case 0: return ((int) t        % 2 == 0) ? 1 : 0;  // 0.5 Hz
    case 1: return ((int)(t * 2)   % 2 == 0) ? 1 : 0;  // 1 Hz
    case 2: return ((int)(t / 2)   % 2 == 0) ? 1 : 0;  // 0.25 Hz
    case 3: return ((int)(t / 3)   % 2 == 0) ? 1 : 0;  // ~0.17 Hz
    default: return 0;
  }
}

// Capacitive — normalized raw signal per electrode (0.0–1.0), mirroring the
// real firmware's mpr121RawSignal() output. Simulates resistive-style pads
// that peak around 0.08 (well below a direct copper touch at 0.15+), with a
// brief ramp on contact. Set a software touch threshold of ~0.04 on the
// dashboard to detect these simulated touches.
float sim_cap(int idx) {
  if (capTouch[idx] > 0.0f) {
    capTouch[idx] -= SEND_MS / 1000.0f;
    if (capTouch[idx] < 0.0f) capTouch[idx] = 0.0f;
    return capTouch[idx] > 0.0f ? 0.08f : 0.0f;
  }
  if (random(1000) < 3) {
    capTouch[idx] = 0.3f + (float)random(0, 700) / 1000.0f;
    return 0.08f;
  }
  return 0.0f;
}

// ── Packet helpers ────────────────────────────────────────────────────────────

static void notify(char* buf, int len) {
  txChar->setValue((uint8_t*)buf, len);
  txChar->notify();
}

static void sendStatusFrame() {
  if (!txChar) return;
  char buf[48];
  int  len = snprintf(buf, sizeof(buf), "{\"t\":\"s\",\"a\":4,\"d\":4,\"c\":12}");
  notify(buf, len);
  Serial.println("[SIM] Status  a=4  d=4  c=12");
}

// One combined frame per send tick — mirrors the real firmware's
// sendSensorFrame() exactly, so the dashboard can be developed/tested
// against this simulator with no protocol differences.
static void sendSensorFrame(float t) {
  if (!txChar) return;
  char buf[224];
  int pos = 0;

  pos += snprintf(buf + pos, sizeof(buf) - pos, "{\"m\":\"data\",\"ts\":%lu,\"a\":[", (unsigned long)millis());

  for (int ch = 0; ch < 4; ch++) {
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%.3f", sim_analog(ch, t));
    if (ch < 3) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "],\"d\":[");

  for (int i = 0; i < 4; i++) {
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%d", sim_digital(i, t));
    if (i < 3) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "],\"c\":[");

  for (int i = 0; i < 12; i++) {
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%.4f", sim_cap(i));
    if (i < 11) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "]}");

  notify(buf, pos);
}

// ── BLE server callbacks ──────────────────────────────────────────────────────

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server) override {
    clientReady = true;
    sendStatusFrame();
    Serial.println("[BLE] Client connected");
  }
  void onDisconnect(NimBLEServer* server) override {
    clientReady = false;
    Serial.println("[BLE] Client disconnected — restarting advertising");
    NimBLEDevice::startAdvertising();
  }
};

// ── Setup ─────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== IML-Sensor SIM (4 analog + 4 digital + 12 cap, 30 Hz combined frame) ===");

  randomSeed(analogRead(0));

  NimBLEDevice::init("IML-Sensor");
  NimBLEDevice::setMTU(185);

  NimBLEServer*  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(NUS_SERVICE_UUID);
  txChar = svc->createCharacteristic(NUS_TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->setScanResponse(true);
  NimBLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising — connect from Chrome dashboard (BLE button)");
}

// ── Loop ──────────────────────────────────────────────────────────────────────

void loop() {
  const uint32_t now = millis();

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    if (clientReady) {
      sendSensorFrame(now / 1000.0f);
    }
  }
}
