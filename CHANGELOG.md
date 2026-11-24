# Changelog

## 0.2.0

- Coolix air conditioners (Midea, Mirage, Electrolux, Comfort Star...) as a
  separate HeaterCooler accessory per hub, with IR codes generated locally,
  no learning: power, Cool/Auto (and Heat with `heat: true`), 17-30 °C and
  four fan speeds, current temperature from the hub's sensor.
- Assumed state persisted in the accessory cache; HomeKit writes that arrive
  together are coalesced into one IR code (400 ms).
- Optional momentary switches for swing, display, sleep and turbo
  (`ac.toggles`) and for fan-only and dry modes (`ac.extraModes`).
- `tuya-ir-learn --ac <mode> <temp> <fan>`, `--ac off` and
  `--ac swing|display|sleep|turbo` send a generated Coolix code.

## 0.1.0

- First release: Tuya Wi-Fi IR hubs with temperature/humidity sensor (S09,
  category `wnykq`) over the local protocol 3.3 (TCP 6668), no cloud.
- Temperature (DP 101, tenths of a degree, with a configurable offset) and
  humidity (DP 102) sensors, served from cache and updated from the hub's own
  pushes plus a 60 s poll.
- Learned IR codes as momentary switches that send the code over DP 201.
- One persistent connection per hub with heartbeats and capped exponential
  reconnect backoff (2 s to 60 s).
- `tuya-ir-learn` CLI to learn codes, fire one code or read the current status.
