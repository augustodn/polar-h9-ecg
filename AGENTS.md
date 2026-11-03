# Repository Guidelines

## Project Structure

- `index.html` contains the complete application: markup, styles, Web Bluetooth connection, RR parsing, chart, and CSV export.
- `tests/rr-parser.test.cjs` checks heart-rate packet decoding with Node’s built-in test runner and `assert`.
- `README.md` documents local use and scope. `LICENSE` preserves the upstream Apache-2.0 terms for the adapted interface and flow.

There is no package manager, build system, or asset directory. Keep the app dependency-free unless a concrete need justifies a change.

## Development and Test Commands

- `python3 -m http.server 8000` serves the page at `http://localhost:8000`. Use Chrome or Edge; Web Bluetooth needs HTTPS or localhost and browser permission.
- `node --test tests/rr-parser.test.cjs` runs the RR parser self-check.

No separate build, lint, or formatting command is configured. For BLE changes, report whether a physical H9 was tested; a passing parser check does not verify a Bluetooth connection.

## Coding Style

Use two spaces for HTML, CSS, and JavaScript indentation. Keep JavaScript in the existing inline script; use `camelCase` for functions and variables, and `UPPER_SNAKE_CASE` for fixed protocol constants. Prefer browser APIs and avoid new dependencies.

Keep the interface in Spanish. Process sensor data in the browser, with no analytics or remote upload. Display only BPM and received RR intervals: the H9 does not provide raw ECG. Do not add synthetic ECG traces or arrhythmia diagnosis/classification.

## Testing Guidelines

Name Node checks `*.test.cjs` under `tests/`. Cover packet flags, RR unit conversion, and malformed input when changing parsing. Keep tests deterministic and independent of a paired sensor; document hardware verification separately.

## Commits and Pull Requests

No Git history is available in this workspace to establish existing commit conventions. Use a short imperative Conventional Commit, for example `feat: export RR intervals as CSV`. PRs should describe behavior and user impact, list test commands and results, state whether H9 hardware was tested, and include a screenshot for visible UI changes.
