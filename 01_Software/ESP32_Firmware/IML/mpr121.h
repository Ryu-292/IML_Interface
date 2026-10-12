#pragma once
#include <Arduino.h>

bool     mpr121Init();

uint16_t mpr121TouchBits();           // bitmask, bit N = electrode N touched
bool     mpr121IsTouched(int elec);   // elec 0-11

// Raw capacitive signal for one electrode: returns filteredData() as-is (10-bit count).
// ~720 when untouched; drops toward 0–200 when touched.
float    mpr121RawSignal(int elec);

// Raw 8-bit baseline for one electrode directly from the MPR121 register.
uint8_t  mpr121BaselineData(uint16_t elec);

// Diagnostic output
void     mpr121DebugPrint();

//
// Hardware touch threshold (MPR121)
// Applies to ALL 12 electrodes.
//
void     mpr121SetThresholds(uint8_t touch, uint8_t release);

uint8_t  mpr121GetTouchThreshold();
uint8_t  mpr121GetReleaseThreshold();