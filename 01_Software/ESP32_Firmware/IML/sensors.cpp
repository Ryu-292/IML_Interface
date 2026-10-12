#include "sensors.h"
#include "ble_link.h"
#include "ads1115.h"
#include "mpr121.h"
#include "digital_input.h"

int numCaps    = 12;
int numAnalog  = 4;  // ADS1115 A0-A3, always active
int numDigital = 4;  // GPIO 1,2,3,4

void resetCapTimer() {}

// Sent once on connect (and again if a count ever changes) — channel counts
// are fixed on this board, so this almost never needs to repeat.
void sendStatusFrame() {
  if (!clientReady) return;

  char buf[48];
  int len = snprintf(
    buf,
    sizeof(buf),
    "{\"t\":\"s\",\"a\":%d,\"d\":%d,\"c\":%d}",
    numAnalog, numDigital, numCaps
  );

  bleNotify(buf, len);
  Serial.printf("[SENSORS] Status  a=%d  d=%d  c=%d\n", numAnalog, numDigital, numCaps);
}

// One combined frame per BLE transmit tick.
// "a"  — raw int16_t ADC counts from ADS1115 (GAIN_ONE, ~0–32767 for 0–4.096V)
// "d"  — digitalRead() per GPIO, 0 or 1
// "c"  — raw filteredData() per electrode (~720 untouched, drops toward 0–200 on touch)
// "cb" — raw baselineData() per electrode (8-bit, 0–255)
// "ct" — MPR121 hardware touch bitmask (bit N set = electrode N touched)
// "ts" — millis() at send time, for measuring dashboard-side latency
void sendSensorFrame() {
  if (!clientReady) return;

  char buf[256];
  int pos = 0;

  pos += snprintf(buf + pos, sizeof(buf) - pos, "{\"m\":\"data\",\"ts\":%lu,\"a\":[", (unsigned long)millis());

  for (int ch = 0; ch < 4; ch++) {
    int16_t v = ads1115ReadRaw(ch);
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%d", v);
    if (ch < 3) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "],\"d\":[");

  for (int i = 0; i < 4; i++) {
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%d", digitalInputRead(i));
    if (i < 3) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "],\"c\":[");
  for (int i = 0; i < 12; i++) {
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%.3f", mpr121RawSignal(i));
    if (i < 11) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "],\"cb\":[");
  for (int i = 0; i < 12; i++) {
    pos += snprintf(buf + pos, sizeof(buf) - pos, "%u", mpr121BaselineData(i));
    if (i < 11) buf[pos++] = ',';
  }

  pos += snprintf(buf + pos, sizeof(buf) - pos, "],\"ct\":%u}", mpr121TouchBits());

  bleNotify(buf, pos);

  static uint32_t lastPrint = 0;
  uint32_t now = millis();
  if (now - lastPrint >= 500) {
    lastPrint = now;
    Serial.println(buf);
  }
}

void updateCapCount(uint32_t now) {
  (void)now; // MPR121 always has 12 electrodes, nothing to update
}
