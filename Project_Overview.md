# Project Overview

## Purpose

A research-grade sensor acquisition interface built around the ESP32-S3. Captures analog, digital, and capacitive sensor data and streams it in real time to a browser-based dashboard for visualization, filtering, and analysis.

## Hardware Architecture

```
[Sensors] ──→ [ESP32-S3]
                  ├── ADS1115  (16-bit ADC, I2C)
                  ├── MPR121   (12-ch capacitive touch, I2C)
                  └── TMUX1112 (analog multiplexer)
                       └── [TPS22919 power switches]

[ESP32-S3] ──→ [Web Dashboard]
               via BLE / WebSocket / USB Serial
```

**Microcontroller:** ESP32-S3  
**PCB:** Custom KiCad design — TODO  
**Power:** TODO  

## Software Architecture

```
[Browser]
    └── Web Dashboard (01_Software/Web_Dashboard/)
            ├── Transport layer   (WebSocket / BLE / USB Serial)
            ├── Protocol parser   (JSON + binary frames)
            ├── Processing pipeline (preprocessing → filtering)
            └── Visualization     (Canvas — analog, digital, capacitive)

[ESP32-S3]
    └── Production firmware (01_Software/ESP32_Firmware/) — TODO
```

**Dashboard stack:** Vanilla JavaScript, HTML5 Canvas, no build step  
**Served via:** VS Code Live Server (port 5502) during development  
**Firmware toolchain:** PlatformIO, Arduino framework  

## Communication Architecture

| Transport | Protocol | Direction | Notes |
|---|---|---|---|
| WebSocket | Newline-delimited JSON | ESP32 → Browser | Primary channel |
| USB Serial | JSON at 115200 baud | ESP32 → Browser | Web Serial API |
| Bluetooth LE | Binary (8-byte frames) + Nordic UART | ESP32 → Browser | NimBLE, Web Bluetooth API |

### Wire Formats

**JSON (WebSocket / Serial):**
```json
{"t":"a","ch":0,"v":512,"ts":12345}          // single analog
{"m":"a","c":[{"id":0,"v":24.5,"u":"°C"}]}   // multi-channel analog
{"m":"c","c":[0.43,0.12,...]}                 // capacitive array
{"t":"s","a":2,"d":4,"c":8}                  // status frame
```

**Binary (BLE, 8 bytes little-endian):**
```
Byte 0   : type  (0=analog, 1=digital, 2=capacitive, 3=status)
Byte 1   : channel
Bytes 2-3: uint16 value
Bytes 4-7: uint32 timestamp
```

**BLE service:** Nordic UART Service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
