const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  serializeIntervalsCsv,
  serializePacketsCsv,
  serializeSessionJson,
  serializeSummaryJson
} = require("../src/export.mjs");
const { summarizeSession } = require("../src/analysis.mjs");

test("RR CSV keeps the original leading columns and exports ticks without early rounding", () => {
  const csv = serializeIntervalsCsv([{
    sequence: 1,
    session_id: "synthetic",
    packet_id: 2,
    rr_index_in_packet: 0,
    rr_raw_1024: 1025,
    rr_ms: 1000 * 1025 / 1024,
    bpm_from_rr: 60000 / (1000 * 1025 / 1024),
    sensor_bpm: 60,
    notification_received_at: "2026-01-01T00:00:00.000Z",
    notification_monotonic_ms: 123.5,
    notification_id: "synthetic:2",
    segment_id: 1,
    segment_elapsed_ms: 1000.9765625,
    time_kind: "estimated_from_rr",
    sensor_contact: "unknown",
    flags: 16,
    phase: "measurement",
    quality_flags: []
  }], { schema_version: 1, analysis_version: "1.0.0" });
  const headers = csv.split("\r\n")[0].split(",");
  assert.deepEqual(headers.slice(0, 6), [
    "sequence", "packet", "rr_ms", "bpm_from_rr", "sensor_bpm", "notification_received_at"
  ]);
  assert.ok(csv.includes("1000.9765625"));
  assert.ok(csv.includes("1025"));
  assert.ok(csv.endsWith(",1,1.0.0"));
});

test("packet CSV and JSON exports preserve malformed data and schema versions", () => {
  const packetCsv = serializePacketsCsv([{
    session_id: "synthetic",
    packet_id: 1,
    notification_received_at: "2026-01-01T00:00:00.000Z",
    notification_monotonic_ms: 1,
    sensor_bpm: 60,
    flags: 0,
    sensor_contact: "unknown",
    rr_count: 0,
    raw_payload: "003caa",
    parse_status: "malformed",
    parse_errors: ["unexpected_trailing_bytes_without_rr"],
    quality_flags: ["unexpected_trailing_bytes_without_rr"]
  }], { schema_version: 1, analysis_version: "1.0.0" });
  assert.ok(packetCsv.includes("003caa"));
  assert.ok(packetCsv.includes("unexpected_trailing_bytes_without_rr"));
  assert.ok(packetCsv.endsWith(",1,1.0.0"));

  const session = { schema_version: 1, session_id: "synthetic", events: [] };
  assert.equal(JSON.parse(serializeSessionJson(session)).schema_version, 1);
  assert.equal(JSON.parse(serializeSessionJson(session)).analysis_version, "1.0.0");
  assert.equal(JSON.parse(serializeSummaryJson({ schema_version: 1 })).schema_version, 1);
});

test("session summary emits separate per-segment windows and protocol completeness", () => {
  const session = {
    schema_version: 1,
    session_id: "synthetic-session",
    protocol: "rest_seated_spontaneous",
    respiration: "spontaneous"
  };
  const intervals = Array.from({ length: 310 }, (_, index) => ({
    session_id: session.session_id,
    sequence: index + 1,
    segment_id: 1,
    rr_ms: 1000,
    segment_elapsed_ms: (index + 1) * 1000,
    phase: index < 10 ? "stabilization" : "measurement",
    quality_flags: []
  }));
  const summary = summarizeSession(session, intervals, { min_rr_ms: 300, max_rr_ms: 2000 });
  assert.equal(summary.schema_version, 1);
  assert.equal(summary.analysis_version, "1.0.0");
  assert.equal(summary.windows.length, 3);
  assert.equal(summary.windows[0].original.valid_intervals, 300);
  assert.equal(summary.windows[2].protocol_window_complete, true);
  assert.equal(summary.windows[2].exploratory, false);
});
