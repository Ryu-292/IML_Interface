#pragma once

#include <Arduino.h>

#define BLE_SEND_MS 33   // ~30 Hz — BLE transmit rate, decoupled from ADC sample rate

extern int numCaps;
extern int numAnalog;
extern int numDigital;

void resetCapTimer();
void sendStatusFrame();
void sendSensorFrame();
void updateCapCount(uint32_t now);
