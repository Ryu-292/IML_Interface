#include "ads1115.h"
#include <Adafruit_ADS1X15.h>

static Adafruit_ADS1115 ads;
static bool    ready         = false;
static bool    chConnected[4]= {};
static int     numConn       = 0;
static int     adcCh         = 0;   // index into connectedList
static bool    convPending   = false;
static int16_t adcRaw[4]     = {};
static int     connectedList[4] = {};  // physical channel numbers that are active

// EMA low-pass filter on each channel: smooths ADC noise without adding
// noticeable lag (time constant ~ a few sample periods at 860SPS).
// Higher = more responsive/less smooth, lower = smoother/more lag.
// Temporarily 1.0 (no filtering) to verify the BLE/dashboard pipeline is
// lag-free on its own — the dashboard's own per-widget filters can take
// over smoothing once that's confirmed. TODO: expose this from the dashboard.
// #define ADC_FILTER_ALPHA 1.0f

static const uint16_t MUX[4] = {
  ADS1X15_REG_CONFIG_MUX_SINGLE_0,
  ADS1X15_REG_CONFIG_MUX_SINGLE_1,
  ADS1X15_REG_CONFIG_MUX_SINGLE_2,
  ADS1X15_REG_CONFIG_MUX_SINGLE_3,
};

bool ads1115Init() {
  ready = ads.begin(0x48, &Wire);
  if (ready) {
    ads.setGain(GAIN_ONE);                // ±4.096 V, 0.125 mV/bit
    ads.setDataRate(RATE_ADS1115_860SPS); // 1.16ms per conversion
    Serial.println("[ADS1115] OK");
  } else {
    Serial.println("[ADS1115] NOT FOUND");
  }
  return ready;
}

// All 4 channels are always wired on this board — no need to probe for
// floating pins. Force them all active and kick off the conversion cycle.
void ads1115DetectChannels() {
  if (!ready) return;

  numConn = 4;
  for (int ch = 0; ch < 4; ch++) {
    chConnected[ch]   = true;
    connectedList[ch] = ch;
  }

  Serial.println("[ADS1115] A0-A3 forced active");

  adcCh = 0;
  ads.startADCReading(MUX[connectedList[0]], false);
  convPending = true;
}

int  ads1115NumConnected()       { return numConn; }
bool ads1115IsConnected(int ch)  { return (ch >= 0 && ch < 4) ? chConnected[ch] : false; }

// Non-blocking — cycles continuously through A0..A3.
void ads1115Tick() {
  if (!ready || numConn == 0) return;

  if (convPending && ads.conversionComplete()) {
    int phyCh = connectedList[adcCh];
    int16_t raw = ads.getLastConversionResults();
    // float v = ads.computeVolts(raw);
    // adcVolts[phyCh] += ADC_FILTER_ALPHA * (v - adcVolts[phyCh]);
    adcRaw[phyCh] = raw;
    adcCh = (adcCh + 1) % numConn;
    convPending = false;
  }

  if (!convPending) {
    ads.startADCReading(MUX[connectedList[adcCh]], false);
    convPending = true;
  }
}

int16_t ads1115ReadRaw(int ch) {
  if (!ready || ch < 0 || ch > 3) return 0;
  return adcRaw[ch];
}
