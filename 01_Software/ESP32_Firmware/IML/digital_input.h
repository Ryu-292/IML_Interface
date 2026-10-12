#pragma once
#include <Arduino.h>

void digitalInputInit();
int  digitalInputRead(int ch);  // ch 0-3, returns 1 (idle) / 0 (active, pulled low)
