# Changelog

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
