#include "digital_input.h"

static const uint8_t DIGITAL_PINS[4] = {1, 2, 42, 41};

void digitalInputInit() {
  for (int i = 0; i < 4; i++) {
    pinMode(DIGITAL_PINS[i], INPUT_PULLUP);
  }
  Serial.println("[DIN] GPIO 1,2,42,41 configured as INPUT_PULLUP");
}

int digitalInputRead(int ch) {
  if (ch < 0 || ch >= 4) return 0;
  return digitalRead(DIGITAL_PINS[ch]);
}
