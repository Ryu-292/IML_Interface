#include "mpr121.h"
#include <Wire.h>
#include <Adafruit_MPR121.h>
#include <math.h>

static Adafruit_MPR121 mpr121;
static bool ready = false;

static uint8_t touchThreshold = 12;
static uint8_t releaseThreshold = 6;

bool mpr121Init() {
  ready = mpr121.begin(0x5A, &Wire);

  if (ready) {
    mpr121.setThresholds(touchThreshold, releaseThreshold);
    Serial.println("[MPR121] OK");
    Serial.printf("[MPR121] thresholds touch=%u release=%u\n",
                  touchThreshold, releaseThreshold);
  } else {
    Serial.println("[MPR121] NOT FOUND — check I2C wiring/power, and the "
                   "ADDR pin (default address is 0x5A; tying ADDR to VCC/SDA/SCL "
                   "instead of GND changes it)");
  }
  

  return ready;
}

void mpr121SetThresholds(uint8_t touch, uint8_t release) {
  if (!ready) return;

  if (touch < 1) touch = 1;
  if (touch > 63) touch = 63;

  if (release < 1) release = 1;
  if (release >= touch) release = touch / 2;

  touchThreshold = touch;
  releaseThreshold = release;

  mpr121.setThresholds(touchThreshold, releaseThreshold);

  Serial.printf("[MPR121] thresholds updated touch=%u release=%u\n",
                touchThreshold, releaseThreshold);
}

uint8_t mpr121GetTouchThreshold() {
  return touchThreshold;
}

uint8_t mpr121GetReleaseThreshold() {
  return releaseThreshold;
}

uint16_t mpr121TouchBits() {
  if (!ready) return 0;
  return mpr121.touched();
}

bool mpr121IsTouched(int elec) {
  if (!ready || elec < 0 || elec > 11) return false;
  return (mpr121TouchBits() >> elec) & 1;
}

float mpr121RawSignal(int elec) {
  if (!ready || elec < 0 || elec > 11) return 0.0f;

  uint16_t filtered = mpr121.filteredData(elec);
  uint16_t baseline = (uint16_t)mpr121.baselineData(elec) << 2;

  if (baseline == 0) return 0.0f;

  int delta = (int)baseline - (int)filtered;

  return fmaxf(0.0f, fminf(1.0f, (float)delta / (float)baseline));
}

void mpr121DebugPrint() {
  if (!ready) {
    Serial.println("[MPR121] not ready");
    return;
  }

  uint16_t bits = mpr121.touched();

  Serial.print("[MPR121] touch=0b");
  for (int i = 11; i >= 0; i--) {
    Serial.print((bits >> i) & 1);
  }
  Serial.println();

  Serial.printf("[MPR121] thresholds touch=%u release=%u\n",
                touchThreshold, releaseThreshold);

  for (int i = 0; i < 12; i++) {
    uint16_t filtered = mpr121.filteredData(i);
    uint16_t baseline = (uint16_t)mpr121.baselineData(i) << 2;
    int delta = (int)baseline - (int)filtered;

    Serial.printf("  E%-2d filtered=%4u baseline=%4u delta=%4d %s\n",
                  i,
                  filtered,
                  baseline,
                  delta,
                  ((bits >> i) & 1) ? "<-- TOUCHED" : "");
  }
}