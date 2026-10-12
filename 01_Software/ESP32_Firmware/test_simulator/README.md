# BLE Simulator (Test Only)

**This is not production firmware.** It is a development tool used to test the web dashboard without physical hardware.

## What It Does

Simulates 4 analog channels, 4 digital channels, and 12 capacitive pads. Broadcasts one combined sensor frame over Bluetooth LE at 30 Hz using the Nordic UART Service. The dashboard connects to it exactly as it would to the real ESP32-S3.

## Build & Flash

```bash
cd test_simulator/
pio run --target upload
pio device monitor
```

Requires PlatformIO and the `h2zero/NimBLE-Arduino` library (declared in `platformio.ini`).

## Target Board

ESP32-S3 DevKitC-1 (`esp32-s3-devkitc-1`)

## Protocol Reference

See `01_Software/Web_Dashboard/README.md` for the full wire format this firmware implements.
