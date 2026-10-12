/*
 * IML Sensor + SPI OLED status screen
 */

#include <Arduino.h>
#include <Wire.h>
#include "ble_link.h"
#include "oled_display.h"
#include "sensors.h"
#include "ads1115.h"
#include "mpr121.h"
#include "digital_input.h"

#define I2C_SDA 48
#define I2C_SCL 47

static uint32_t lastSend = 0;

void setup() {
  Serial.begin(115200); // Increased baud rate to reduce serial lag
  delay(500);

  Serial.println();
  Serial.println("=== IML-Sensor OLED BLE ===");

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000); // Fast Mode — default 100kHz was the real source of ADC lag
  ads1115Init();
  ads1115DetectChannels();         // forces A0-A3 active, starts the conversion cycle
  numAnalog = ads1115NumConnected();
  mpr121Init();
  digitalInputInit();

  randomSeed(analogRead(0));

  oledInit();
  delay(800);

  bleInit();

  oledUpdateStatus();
}

void loop() {
  // Run the ADC cycle as fast as possible every loop, independent of how
  // often we actually transmit — the BLE link, not the ADS1115, was the
  // source of dashboard lag, so keep sampling fast and throttle only the send.
  ads1115Tick();

  uint32_t now = millis();

  if (clientReady) {
    updateCapCount(now);
  }

  if (now - lastSend >= BLE_SEND_MS) {
    lastSend = now;

    if (clientReady) {
      sendSensorFrame();
    }
  }

  oledUpdateStatus();
}
