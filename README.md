# Polar H9 RR / HRV Recorder

A local browser application for recording and exploring Polar H9 heart-rate notifications and RR intervals. It uses Web Bluetooth and IndexedDB; no server, account, analytics, or third-party JavaScript dependencies are used. The interface is in English.

The H9 sends heart rate and RR intervals, not an ECG waveform. This is a data recorder and exploratory HRV tool, not a medical device. RR results cannot diagnose or rule out arrhythmias or conduction disorders.

## Run locally

Use Chrome or Edge over HTTPS or <code>localhost</code>. Web Bluetooth requires a secure context and a user gesture to select the sensor.

    python3 -m http.server 8000

Open <http://localhost:8000>, choose a protocol and quality thresholds, connect the H9, and start a session. Rest protocols default to 300 seconds of useful acquisition; a positive planned duration ends the session once that much RR time has been recorded. Set duration to <code>0</code> for manual stopping. An optional stabilization period is recorded separately and excluded from HRV windows.

Sessions, packet notifications, RR intervals, and events remain in this browser's IndexedDB. The application does not upload them. Export and save files before clearing browser data. A session without a finish event is recovered as incomplete; its end time is left unknown.

## Acquisition and timing

The collector stores every Heart Rate Measurement notification received during an active session, including notifications without RR and malformed packets. It preserves the original flags and full payload, sensor BPM, contact status, UTC receipt time, and <code>performance.now()</code> time. RR ticks remain integer values in the saved record; milliseconds are derived as <code>ticks × 1000 / 1024</code> without rounding before analysis.

Notification receipt is not the time of a beat. RR relative time is estimated by accumulating RR values inside each continuous segment. Disconnects, pauses, and prolonged RR silences are recorded as possible discontinuities; segments are not joined and no RR is inferred from BLE notification timing. The Heart Rate Service has no device timestamp and permits RR batching; missing beats cannot be established from this stream alone. See the [Bluetooth SIG Heart Rate Service specification](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html).

## Quality and analysis

Default review thresholds are 300–2000 ms for RR, a 250 ms change with a relative change greater than 20% for a sharp transition, and 5000 ms without RR for a possible reception gap. They can be changed before a session. Marks describe data for review; the original values are not altered, interpolated, or discarded.

The analysis reports original metrics from all positive received RR values and processed metrics after excluding values with quality flags. It calculates mean/minimum/maximum BPM as <code>60000 / RR</code>, sample SDNN and SDSD, RMSSD, and pNN50 as the percentage of eligible adjacent same-segment pairs whose absolute difference is greater than 50 ms. Poincaré SD1/SD2 use sample standard deviations of <code>(RR[n+1] − RR[n]) / sqrt(2)</code> and <code>(RR[n+1] + RR[n]) / sqrt(2)</code>. Pair metrics never bridge a missing, excluded, or cross-segment interval.

Five-minute windows are shown as exploratory unless the selected segment contains a complete useful window under a spontaneous-breathing rest protocol. Deep or guided breathing is not presented as a comparable spontaneous-breathing baseline. Windows of different durations should not be compared automatically. The formulas are documented for reproducibility and are not diagnostic thresholds.

## Exports

Each selected session can be downloaded as <code>rr.csv</code>, <code>packets.csv</code>, <code>session.json</code>, and <code>summary.json</code>. The first six <code>rr.csv</code> columns preserve the previous CSV layout. Exact fields, units, time semantics, and schema versions are in [docs/export-format.md](docs/export-format.md).

## Tests and limits

Run the dependency-free Node.js checks:

    node --test

Tests use clearly identified synthetic BLE/RR data and a small IndexedDB test double. They verify decoding, time reconstruction, analysis, persistence behavior, and exports; they do not test browser Bluetooth or a physical sensor. This implementation has **not** been tested with a physical Polar H9.

## Attribution and licenses

The interface and reading flow were adapted from [Pure Blue Heart](https://github.com/benwrk/pure-blue-heart) by benwrk. Adapted material remains under Apache-2.0 in <code>LICENSE</code>; original contributions for this project are additionally available under MIT in <code>LICENSE-MIT</code>. PMD/ECG capture and remote analytics were removed.
