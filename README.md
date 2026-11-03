# Polar H9 RR Viewer

A local web viewer for the Polar H9. It connects over Bluetooth LE and displays heart rate and received RR intervals. No dependencies or backend are required.

## Features

- Heart rate reported by the sensor.
- A chart of the latest 100 RR intervals, in milliseconds and ordered by beat.
- Recent readings and CSV session export.

Capture data stays in the browser tab's memory. Download the CSV before closing the tab. The page does not send readings to a server.

## Requirements and Usage

Use Chrome or Edge over HTTPS or `localhost`; Web Bluetooth requires a secure context and browser permission. Wear the strap and moisten the electrodes.

Start a local server from the project directory:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>, click **Connect Polar H9**, select the strap, and wait for RR notifications. Click **Download CSV** to save the recording.

## CSV and Tests

The CSV contains `sequence`, `packet`, `rr_ms`, `bpm_from_rr`, `sensor_bpm`, and `notification_received_at`. Multiple intervals in one notification share a `packet` number and receive timestamp; that timestamp is not the exact time of each beat.

Run the parser self-check:

```sh
node --test tests/rr-parser.test.cjs
```

This check verifies RR packet decoding, not a physical connection to the strap.

## Medical Scope

The H9 transmits BPM and RR intervals, but not the ECG waveform. This viewer helps observe and save readings; it cannot confirm or rule out an arrhythmia. If you are concerned about your heart rhythm, consult a healthcare professional. Evaluation may require an ECG or clinical monitor. [American Heart Association: common tests for arrhythmia](https://www.heart.org/en/health-topics/arrhythmia/symptoms-diagnosis--monitoring-of-arrhythmia/common-tests-for-arrhythmia).

## Attribution

The interface and reading flow were adapted from [Pure Blue Heart](https://github.com/benwrk/pure-blue-heart) by benwrk. The Apache-2.0 license is preserved in `LICENSE`; this version removes PMD/ECG capture and remote analytics.
