# homebridge-tuya-ir-hub

[![npm](https://img.shields.io/npm/v/homebridge-tuya-ir-hub)](https://www.npmjs.com/package/homebridge-tuya-ir-hub)
[![Build and test](https://github.com/oscarolar/homebridge-tuya-ir-hub/actions/workflows/build.yml/badge.svg)](https://github.com/oscarolar/homebridge-tuya-ir-hub/actions/workflows/build.yml)

Homebridge plugin for **Tuya Wi-Fi IR blasters with a temperature/humidity
sensor** (model S09, Tuya category `wnykq`, sold under many brands), controlled
over the **local Tuya protocol 3.3**, with no cloud at runtime and no extra
dependencies.

## Features

- **Temperature and humidity sensors** in HomeKit. Readings come from the hub's
  own status pushes plus a gentle poll (60 s by default), and HomeKit reads are
  answered from cache.
- **Learned IR codes as buttons.** Each configured code is a switch that sends
  the code when turned on and turns itself off a second later, so it works in
  scenes and automations.
- **One persistent connection per hub**, with heartbeats every 10 s and
  reconnects with capped exponential backoff (2 s to 60 s). The hub accepts a
  single local connection, so nothing else should talk to it while Homebridge
  runs.
- A **`tuya-ir-learn` CLI** to learn codes from your remotes.

## Before you start

1. **Reserve the hub's IP** in your router (DHCP reservation).
2. **Get the device id and local key.** The local key is a 16-character secret
   the hub uses to encrypt its LAN traffic. It is only available from Tuya's
   cloud, once:
   - Create a Cloud project at [iot.tuya.com](https://iot.tuya.com) (data
     center matching your app account).
   - In the project, **Devices → Link App Account** and scan the QR code with
     the Tuya Smart / Smart Life app the hub is paired to.
   - Read the id and key with `python -m tinytuya wizard`, or with the API
     Explorer (Device Management → Query Device Details).

   Re-pairing the hub in the app changes the key.
3. **Learn your remote's codes** (stop Homebridge, or the hub's child bridge,
   first: the hub accepts one connection):

   ```bash
   export TUYA_LOCAL_KEY='xxxxxxxxxxxxxxxx'
   npx tuya-ir-learn --ip 192.168.1.50 --id ebxxxxxxxxxxxxxxxxxxxx --timeout 60
   ```

   Point the remote at the hub and press each button. Every learned code is
   printed as one JSON line, `{"code":"<base64>"}`. Study mode ends on timeout
   or Ctrl+C. The key is read from `TUYA_LOCAL_KEY` only, never from the
   command line, so it doesn't end up in your shell history or process list.

   Try a code with `--send <base64>`, or print the hub's current data points
   with `--status`.

## Configuration

```json
{
  "platform": "TuyaIRHub",
  "name": "Tuya IR Hub",
  "hubs": [
    {
      "name": "Sala",
      "id": "ebxxxxxxxxxxxxxxxxxxxx",
      "ip": "192.168.1.50",
      "localKey": "xxxxxxxxxxxxxxxx",
      "temperatureOffset": -0.5,
      "buttons": [
        { "name": "TV Power", "code": "<base64 from tuya-ir-learn>" },
        { "name": "Aire Encender", "code": "<base64>" }
      ]
    }
  ]
}
```

| Option | Default | |
|---|---|---|
| `name`, `id`, `ip`, `localKey` | required | |
| `version` | `"3.3"` | only 3.3 is implemented; other versions are rejected |
| `pollInterval` | `60` | seconds, minimum 15 |
| `temperatureOffset` | `0` | °C added to each reading |
| `buttons` | `[]` | `{ name, code }`, code is the base64 learned code |

The accessory is keyed by the device id. Buttons are keyed by their name, so
renaming a button creates a new switch in HomeKit.

## Protocol notes

Tuya local protocol 3.3 over TCP 6668: frames are `0x000055AA`, sequence,
command, length (payload + 8), payload, CRC-32, `0x0000AA55`. Payloads are
JSON encrypted with AES-128-ECB (PKCS7) using the local key. `CONTROL` (cmd 7)
payloads carry a `3.3` + 12-byte header before the ciphertext; `DP_QUERY`
(cmd 10) and `HEART_BEAT` (cmd 9) don't. Device frames carry a 4-byte return
code, and pushed `STATUS` frames (cmd 8) the same `3.3` header.

Data points on the S09 (`wnykq`):

| DP | Code | |
|---|---|---|
| 101 | `temp_current` | tenths of °C (296 = 29.6 °C) |
| 102 | `humidity_value` | % |
| 201 | `ir_send` | JSON command (send / study / study_exit) |
| 202 | `ir_study_code` | learned code, base64 |

Sending writes DP 201 =
`{"control":"send_ir","head":"","key1":"1<code>","type":0,"delay":300}`.
Learning writes `{"control":"study"}` (after a `study_exit`), the hub reports
each learned code on DP 202, and `{"control":"study_exit"}` ends it.

## Development

```bash
npm install
npm test   # builds, then runs tests against a fake hub
```

## License

MIT
