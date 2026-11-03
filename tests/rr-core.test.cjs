const assert = require("node:assert/strict");
const { before, test } = require("node:test");

let core;
before(async () => { core = await import("../src/rr-core.mjs"); });

function bytes(values) {
  const data = Uint8Array.from(values);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function packet(sessionId, packetId, rrValues, monotonicMs, extras = {}) {
  return {
    session_id: sessionId,
    packet_id: packetId,
    notification_received_at: "2026-01-01T00:00:00.000Z",
    notification_monotonic_ms: monotonicMs,
    sensor_bpm: 60,
    sensor_contact: "unknown",
    flags: 0x10,
    phase: "measurement",
    rr_intervals: rrValues.map(raw => ({ rr_raw_1024: raw, rr_ms: (raw * 1000) / 1024 })),
    ...extras
  };
}

test("decodes UINT8 heart rate and keeps multiple RR values in packet order", () => {
  const value = core.parseHeartRate(bytes([0x10, 60, 0x00, 0x04, 0x01, 0x04]));
  assert.equal(value.sensor_bpm, 60);
  assert.deepEqual(value.rr_intervals.map(item => item.rr_raw_1024), [1024, 1025]);
  assert.equal(value.rr_intervals[1].rr_ms, 1000 * 1025 / 1024);
  assert.equal(value.raw_payload, "103c00040104");
  assert.equal(value.sensor_contact, "unknown");
});

test("decodes UINT16 heart rate, energy and contact bits per the HRS", () => {
  const value = core.parseHeartRate(bytes([0x1f, 0x2c, 0x01, 0x34, 0x12, 0x00, 0x04]));
  assert.equal(value.sensor_bpm, 300);
  assert.equal(value.energy_expended_raw, 0x1234);
  assert.equal(value.sensor_contact, "detected");
  const notDetected = core.parseHeartRate(bytes([0x14, 60, 0x00, 0x04]));
  assert.equal(notDetected.sensor_contact, "not_detected");
  assert.equal(core.parseHeartRate(bytes([0x10, 60])).sensor_contact, "unknown");
});

test("records a notification with no RR and preserves BPM", () => {
  const value = core.parseHeartRate(bytes([0x00, 72]));
  assert.equal(value.sensor_bpm, 72);
  assert.equal(value.rr_count, 0);
  assert.deepEqual(value.parse_errors, []);
});

test("preserves reserved flags and bytes after a packet without RR as warnings", () => {
  const reserved = core.parseHeartRate(bytes([0xe0, 70]));
  assert.equal(reserved.sensor_bpm, 70);
  assert.deepEqual(reserved.packet_quality_flags, ["reserved_flag_bits"]);
  const extra = core.parseHeartRate(bytes([0x00, 70, 0xaa]));
  assert.equal(extra.sensor_bpm, 70);
  assert.equal(extra.rr_count, 0);
  assert.deepEqual(extra.parse_errors, ["unexpected_trailing_bytes_without_rr"]);
  assert.equal(extra.raw_payload, "0046aa");
});

test("reports truncated fields, missing RR values and odd RR payloads without hiding complete values", () => {
  assert.throws(
    () => core.parseHeartRate(bytes([0x01, 60])),
    error => error instanceof core.PacketParseError && error.code === "truncated_heart_rate"
  );
  assert.throws(
    () => core.parseHeartRate(bytes([0x08, 60, 0x34])),
    error => error instanceof core.PacketParseError && error.code === "truncated_energy_expended"
  );
  const missing = core.parseHeartRate(bytes([0x10, 60]));
  assert.deepEqual(missing.parse_errors, ["rr_flag_without_values"]);
  const odd = core.parseHeartRate(bytes([0x10, 60, 0x00, 0x04, 0xff]));
  assert.deepEqual(odd.rr_intervals.map(item => item.rr_raw_1024), [1024]);
  assert.deepEqual(odd.parse_errors, ["odd_rr_payload_length"]);
  assert.equal(odd.raw_payload, "103c0004ff");
});

test("keeps zero RR ticks and exact native tick conversion", () => {
  const value = core.parseHeartRate(bytes([0x10, 60, 0x00, 0x00, 0x01, 0x04]));
  assert.deepEqual(value.rr_intervals.map(item => item.rr_raw_1024), [0, 1025]);
  assert.equal(value.rr_intervals[1].rr_ms, 1000 * 1025 / 1024);
  const result = core.intervalsForPacket(packet("s", 1, [0, 1025], 100), core.createTimelineState());
  assert.equal(result.intervals[0].rr_ms, 0);
  assert.equal(result.intervals[0].bpm_from_rr, null);
  assert.deepEqual(result.intervals[0].quality_flags, ["invalid_rr"]);
});

test("assigns consecutive sequences and zero-based RR indices in the original order", () => {
  const result = core.intervalsForPacket(packet("s", 9, [900, 1000, 1100], 100), core.createTimelineState());
  assert.deepEqual(result.intervals.map(item => item.sequence), [1, 2, 3]);
  assert.deepEqual(result.intervals.map(item => item.rr_index_in_packet), [0, 1, 2]);
  assert.ok(result.intervals.every(item => item.notification_id === "s:9"));
});

test("RR timeline uses RR sums, not Bluetooth notification delay", () => {
  let state = core.createTimelineState();
  let first = core.intervalsForPacket(packet("s", 1, [1024], 100), state);
  state = first.state;
  const gap = core.gapSinceLastRR(state, 4100, 5000);
  assert.equal(gap, null);
  const second = core.intervalsForPacket(packet("s", 2, [1024], 4100), state);
  assert.equal(second.intervals[0].relative_time_s, 2);
  assert.equal(second.intervals[0].notification_monotonic_ms, 4100);
  assert.equal(second.state.segment_elapsed_ms, 2000);
});

test("marks a prolonged receive gap without converting it into an RR, then starts a new segment", () => {
  const first = core.intervalsForPacket(packet("s", 1, [1024], 100), core.createTimelineState());
  assert.equal(core.gapSinceLastRR(first.state, 5201, 5000), 5101);
  const nextState = core.startNewSegment(first.state);
  const next = core.intervalsForPacket(packet("s", 2, [1024], 5201), nextState);
  assert.equal(next.intervals[0].segment_id, 2);
  assert.equal(next.intervals[0].relative_time_s, 1);
});

test("does not flag gradual RR variation as abrupt, but marks a sharp change descriptively", () => {
  const gradual = core.intervalsForPacket(packet("s", 1, [1024, 1126, 1229, 1331], 100), core.createTimelineState());
  assert.ok(gradual.intervals.every(item => !item.quality_flags.includes("abrupt_change_from_previous")));
  const abrupt = core.intervalsForPacket(packet("s", 2, [1024, 1638], 100), core.createTimelineState());
  assert.ok(abrupt.intervals[1].quality_flags.includes("abrupt_change_from_previous"));
});
