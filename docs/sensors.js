// sensors.js — Sensor type definitions and analog value conversion.
//
// Conversion pipeline (three explicit stages):
//   1. RAW      — ADC counts (legacy ESP32-ADC-style wire formats, 0–4095
//                 for a 12-bit ADC), OR skipped entirely when the source
//                 already reports volts (the ADS1115-based BLE frame does)
//   2. VOLTAGE  — applySensorConversion() computes raw/4095×3.3; the BLE
//                 frame path calls convertVoltage() directly with its own volts
//   3. PHYSICAL — sensor formula applied to voltage (°C, %RH, lux, …)
//
// The ADC→voltage step is built in and always applied (for raw-ADC sources)
// so you never need to configure "Scale ×" in the preprocessing panel just
// to get correct units.

// All available sensor types.
//   id      — internal key stored per channel
//   label   — shown in the sensor type dropdown
//   unit    — physical unit displayed on the graph and readouts
export const SENSOR_TYPES = [
  { id: 'raw',        label: 'Raw ADC Count',      unit: ''    },
  { id: 'voltage',    label: 'Voltage (ADS1115)',  unit: 'V'   },
  { id: 'lm35',       label: 'Temp LM35',         unit: '°C'  },
  { id: 'tmp36',      label: 'Temp TMP36',        unit: '°C'  },
  { id: 'humidity',   label: 'Humidity',          unit: '%RH' },
  { id: 'distance',   label: 'Distance',          unit: 'cm'  },
  { id: 'light',      label: 'Light',             unit: 'lux' },
  { id: 'pressure',   label: 'Pressure',          unit: 'kPa' },
  { id: 'force',      label: 'Force / Load',      unit: 'N'   },
  { id: 'position',   label: 'Potentiometer',     unit: '%'   },
  { id: 'current',    label: 'Current',           unit: 'mA'  },
  { id: 'resistance', label: 'Resistance',        unit: 'Ω'   },
  { id: 'custom',     label: 'Custom',            unit: ''    },
];

// Linear map: scale v from [inMin, inMax] to [outMin, outMax]
function mapRange(v, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
}

// Default sensor state for one analog channel.
// Each of the 4 analog channels has its own independent state.
export function createSensorState() {
  return {
    typeId:       'raw', // which SENSOR_TYPES entry is active
    customUnit:   '',    // unit label for the 'custom' type
    multiplier:   1,     // scale factor for 'custom': output = value × multiplier + offset
    customOffset: 0,     // additive offset for 'custom'
  };
}

// Stage 2+3 — voltage → physical unit via sensor formula. Split out from
// applySensorConversion() below so callers that already have a real voltage
// (e.g. the ADS1115, which reports volts directly over BLE) can skip the
// ADC-counts→volts step entirely instead of having it misapplied.
//
// voltage : volts
// state   : sensorState object from createSensorState()
//
// Returns { value: number, unit: string }
export function convertVoltage(voltage, state) {
  let value;
  switch (state.typeId) {
    case 'voltage':    value = voltage;                                  break; // show voltage as-is
    case 'raw':        value = voltage;                                  break; // passthrough (handled before this in applySensorConversion)
    case 'lm35':       value = voltage * 100;                            break; // LM35: 10 mV/°C
    case 'tmp36':      value = (voltage - 0.5) * 100;                   break; // TMP36: +0.5 V offset
    case 'humidity':   value = mapRange(voltage, 0, 3.3, 0, 100);       break;
    case 'distance':   value = mapRange(voltage, 0, 3.3, 0, 100);       break;
    case 'light':      value = mapRange(voltage, 0, 3.3, 0, 1000);      break;
    case 'pressure':   value = mapRange(voltage, 0, 3.3, 0, 100);       break;
    case 'force':      value = mapRange(voltage, 0, 3.3, 0, 100);       break;
    case 'position':   value = mapRange(voltage, 0, 3.3, 0, 100);       break;
    case 'current':    value = mapRange(voltage, 0, 3.3, 0, 20);        break;
    case 'resistance': value = voltage;                                   break; // needs ext. ref resistor
    case 'custom':
      // Formula: output = voltage × multiplier + offset
      value = voltage * (state.multiplier ?? 1) + (state.customOffset ?? 0);
      break;
    default:           value = voltage;
  }

  const entry = SENSOR_TYPES.find(t => t.id === state.typeId) ?? SENSOR_TYPES[0];
  const unit  = state.typeId === 'custom' ? (state.customUnit || '') : entry.unit;

  return { value, unit };
}

// Apply the full three-stage sensor conversion to a raw ADC value.
//
// adcValue : output of the filter pipeline (raw ADC counts, 0–4095) — for
//            legacy wire formats that still send raw counts rather than volts
// state    : sensorState object from createSensorState()
//
// Returns { voltage: number, value: number, unit: string }
//   voltage — always the intermediate voltage in V (useful for debugging)
//   value   — the final physical measurement
//   unit    — the unit string for display (e.g. '°C', 'V', '%RH')
export function applySensorConversion(adcValue, state) {
  // Raw mode: show the ADC count directly with no conversion
  if (!state || state.typeId === 'raw') {
    return { voltage: null, value: adcValue, unit: '' };
  }
  // ADS1115 at GAIN_ONE (±4.096 V): 16-bit signed, 32767 = +4.096 V
  const voltage = (adcValue / 32767) * 4.096;
  const { value, unit } = convertVoltage(voltage, state);
  return { voltage, value, unit };
}
