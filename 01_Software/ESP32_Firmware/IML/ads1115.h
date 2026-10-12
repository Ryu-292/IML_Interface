#pragma once
#include <Arduino.h>

bool  ads1115Init();
void  ads1115DetectChannels();     // forces A0-A3 active and starts the conversion cycle; call once after init
int   ads1115NumConnected();       // always 4 — channels are no longer auto-detected
bool  ads1115IsConnected(int ch);  // ch 0-3, always true
void  ads1115Tick();               // call every loop() — non-blocking conversion cycle
int16_t ads1115ReadRaw(int ch);    // returns last raw ADC count (int16_t), never blocks
