# Repository Guidelines

## Project Structure

- <code>index.html</code> is the English-language, dependency-free browser interface.
- <code>src/app.mjs</code> owns Web Bluetooth, session lifecycle, and rendering coordination.
- <code>src/rr-core.mjs</code> contains pure Heart Rate Measurement decoding, RR timeline reconstruction, and quality flags.
- <code>src/analysis.mjs</code> provides pure HRV and Poincaré calculations.
- <code>src/storage.mjs</code> persists sessions, notifications, intervals, and events in IndexedDB.
- <code>src/export.mjs</code> serializes CSV/JSON; <code>src/charts.mjs</code> draws dependency-free canvases.
- <code>tests/</code> contains deterministic Node.js tests; <code>docs/export-format.md</code> defines exported fields.

## Development and Test Commands

- <code>python3 -m http.server 8000</code> serves the app at <code>http://localhost:8000</code>. Web Bluetooth requires Chrome or Edge in a secure context.
- <code>node --test</code> runs all parser, timeline, analysis, persistence-contract, and export checks.

There is no build system, package manager, linter, or production backend. Keep the project dependency-free unless acceptance requires otherwise.

## Coding Style

Use two spaces for HTML, CSS, and JavaScript. JavaScript modules use ES modules, <code>camelCase</code> for functions, and <code>UPPER_SNAKE_CASE</code> for fixed protocol constants. Persisted/exported field names follow the documented <code>snake_case</code> schema. Keep user-facing text, code, and documentation in English.

Keep sensor processing local. Preserve raw notification fields and RR ticks; do not round before analysis. Mark uncertainty rather than inferring missing beats. The H9 does not provide ECG waveform data: do not add ECG/PMD capture, arrhythmia diagnosis, or rhythm classification.

## Testing Guidelines

Use Node's built-in test runner and name files <code>*.test.cjs</code> under <code>tests/</code>. Import pure modules directly; do not extract functions from HTML with regular expressions. Tests use synthetic data, and the IndexedDB test double does not replace browser or H9 hardware verification.

## Commits and Pull Requests

Use short imperative commit subjects, preferably Conventional Commit style, such as <code>feat: persist RR sessions locally</code>. Pull requests should explain behavior and data-schema changes, list <code>node --test</code> results, and say whether Chrome/Edge or a physical Polar H9 was tested. Include screenshots for visible UI changes.

## Privacy and Storage

Do not add telemetry or remote upload. Measurements and optional notes stay in browser IndexedDB; explain export, deletion, and medical limitations in user-facing documentation.
