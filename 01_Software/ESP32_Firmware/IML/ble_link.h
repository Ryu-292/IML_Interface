#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>

#define NUS_SERVICE_UUID  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX_UUID       "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // device → browser
#define NUS_RX_UUID       "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // browser → device

extern NimBLECharacteristic* txChar;
extern bool clientReady;

void bleInit();
void bleNotify(const char* buf, int len);
