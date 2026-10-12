# Components

Central component database. Add a new entry here whenever a new hardware component is introduced to the project.

---

# ADS1115

Purpose: 16-bit analog-to-digital converter (ADC) with I2C interface. Used to read high-resolution analog sensor signals from the ESP32-S3.  
Manufacturer: Texas Instruments  
Datasheet: 02_Hardware/Datasheets/ADS1115.pdf  
Supplier Link: TODO  
Voltage: 2.0V – 5.5V (VDD); analog inputs up to VDD  
Important Pins:
- VDD — power supply
- GND — ground
- SDA — I2C data
- SCL — I2C clock
- ADDR — I2C address select (GND=0x48, VDD=0x49, SDA=0x4A, SCL=0x4B)
- ALRT/RDY — conversion ready / comparator alert

Notes: 4 single-ended or 2 differential input channels. Programmable gain amplifier (PGA) ±0.256V to ±6.144V. Programmable data rate 8–860 SPS.

---

# MPR121

Purpose: 12-channel capacitive touch sensor controller with I2C interface.  
Manufacturer: NXP Semiconductors  
Datasheet: 02_Hardware/Datasheets/MPR121.pdf  
Supplier Link: TODO  
Voltage: 1.71V – 3.6V (VDD)  
Important Pins:
- VDD — power supply
- GND — ground
- SDA — I2C data
- SCL — I2C clock
- ADDR — I2C address select
- IRQ — interrupt (active low, open drain)
- ELE0–ELE11 — capacitive electrode inputs

Notes: Reports touch/release status and baseline/filtered electrode data. Configurable touch and release thresholds per channel. Supports up to 4 devices on the same I2C bus via ADDR pin.

---

# ESP32-S3

Purpose: Main microcontroller. Handles sensor acquisition, data processing, and wireless communication (BLE + WiFi) to the web dashboard.  
Manufacturer: Espressif Systems  
Datasheet: 02_Hardware/Datasheets/ESP32-S3.pdf  
Supplier Link: TODO  
Voltage: 3.0V – 3.6V (VDD); IO pins 3.3V  
Important Pins:
- GPIO 1–10 — ADC1 channels (can be used with ADS1115 over I2C instead)
- GPIO 8 (SDA) / GPIO 9 (SCL) — default I2C bus (connects ADS1115, MPR121)
- GPIO 19 (USB D-) / GPIO 20 (USB D+) — USB Serial/JTAG
- EN — enable / reset
- GPIO 0 — boot mode select

Notes: Dual-core Xtensa LX7 @ 240 MHz. 512 KB SRAM, up to 16 MB flash. Wi-Fi 802.11 b/g/n + Bluetooth 5 LE. Toolchain: PlatformIO + Arduino framework.

---

# TMUX1112

Purpose: Dual SPDT analog multiplexer/switch. Routes analog signals from multiple sensors to a single ADC input.  
Manufacturer: Texas Instruments  
Datasheet: 02_Hardware/Datasheets/TMUX1112.pdf  
Supplier Link: TODO  
Voltage: 1.8V – 5.5V (VCC); signal range 0V to VCC  
Important Pins:
- VCC — power supply
- GND — ground
- SEL — channel select (logic input)
- S1A / S1B — switch 1 terminals
- D1 — switch 1 common
- S2A / S2B — switch 2 terminals
- D2 — switch 2 common

Notes: Low on-resistance (~10 Ω typical). Rail-to-rail signal capability. No level shifting required when VCC matches logic voltage.

---

# TPS22919

Purpose: Load switch for power sequencing and controlled power gating of peripheral circuits.  
Manufacturer: Texas Instruments  
Datasheet: 02_Hardware/Datasheets/TPS22919.pdf  
Supplier Link: TODO  
Voltage: 0.8V – 5.5V (VIN); output follows input  
Important Pins:
- VIN — input voltage
- VOUT — switched output voltage
- ON — enable (active high)
- GND — ground

Notes: Typical on-resistance 35 mΩ at 3.3V. Configurable rise time via CT pin. Maximum continuous current 2A. Used to switch power to sensors or peripheral modules under firmware control.
