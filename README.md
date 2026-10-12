# IML Interface

Real-time sensor interface project — ESP32-S3, custom PCB hardware, and a web dashboard for data acquisition and visualization.

## Structure

```
01_Software/
  Web_Dashboard/        Web interface (vanilla JS, no build step)
  ESP32_Firmware/       Production firmware (placeholder) + test simulator

02_Hardware/
  KiCad/                PCB design files
  Datasheets/           Component datasheets
  Components/           Component reference files

03_Documentation/
  Architecture/         System and software architecture docs
  Notes/                Research notes
```

## Key Documents

- [Project_Overview.md](Project_Overview.md) — purpose, hardware/software/communication architecture
- [Components.md](Components.md) — central component database
