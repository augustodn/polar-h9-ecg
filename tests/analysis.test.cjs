const assert = require("node:assert/strict");
const { test } = require("node:test");
const { analyzeIntervals, calculatePoincare, selectWindow } = require("../src/analysis.mjs");

function record(sequence, rr_ms, options = {}) {
  return {
    session_id: "synthetic-session",
    sequence,
    segment_id: 1,
    rr_ms,
    phase: "measurement",
    segment_elapsed_ms: sequence * (rr_ms || 0),
    quality_flags: [],
    ...options
  };
}

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, actual + " differs from " + expected);
}

test("known synthetic vector gives reproducible HRV and Poincare values", () => {
  const values = [1000, 1100, 900, 1000].map((rr, index) => record(index + 1, rr));
  const stats = analyzeIntervals(values);
  close(stats.mean_rr_ms, 1000);
  close(stats.mean_bpm, (60 + 60000 / 1100 + 60000 / 900 + 60) / 4);
  close(stats.min_bpm, 60000 / 1100);
  close(stats.max_bpm, 60000 / 900);
  close(stats.sdnn_ms, 81.64965809277261);
  close(stats.rmssd_ms, 141.4213562373095);
  close(stats.sdsd_ms, 173.20508075688772);
  close(stats.pnn50_percent, 100);
  const poincare = calculatePoincare(values);
  close(poincare.sd1_ms, 122.4744871391589);
  close(poincare.sd2_ms, 70.71067811865476);
});

test("pNN50 uses strictly greater than 50 ms and valid adjacent pairs", () => {
  const exactly50 = [record(1, 1000), record(2, 1050), record(3, 1000)];
  assert.equal(analyzeIntervals(exactly50).pnn50_percent, 0);
  const missingSequence = [record(1, 1000), record(3, 1100)];
  assert.equal(analyzeIntervals(missingSequence).pair_count, 0);
  assert.equal(analyzeIntervals(missingSequence).rmssd_ms, null);
  const separateSegments = [record(1, 1000), record(2, 1100, { segment_id: 2 })];
  assert.equal(analyzeIntervals(separateSegments).pair_count, 0);
});

test("original metrics retain suspicious values; processed metrics list exclusions and do not bridge them", () => {
  const values = [
    record(1, 1000),
    record(2, 0, { quality_flags: ["invalid_rr"] }),
    record(3, 4000, { quality_flags: ["rr_outside_configured_range"] }),
    record(4, 1300, { quality_flags: ["abrupt_change_from_previous"] }),
    record(5, 1050)
  ];
  const original = analyzeIntervals(values);
  const processed = analyzeIntervals(values, { exclude_suspicious: true });
  assert.equal(original.valid_intervals, 4);
  assert.equal(original.suspect_count, 3);
  assert.equal(processed.valid_intervals, 2);
  assert.equal(processed.excluded_count, 3);
  assert.equal(processed.pair_count, 0);
  assert.equal(processed.rmssd_ms, null);
  assert.equal(processed.sdnn_ms, 35.35533905932738);
});

test("gradual deep-breathing-like variation is retained without an aggressive filter", () => {
  const rr = [800, 900, 1000, 1100, 1200, 1100, 1000, 900];
  const values = rr.map((value, index) => record(index + 1, value));
  const processed = analyzeIntervals(values, { exclude_suspicious: true });
  assert.equal(processed.valid_intervals, rr.length);
  assert.equal(processed.excluded_count, 0);
  assert.ok(processed.rmssd_ms > 0);
  assert.ok(processed.sdnn_ms > 0);
});

test("five-minute selection stays within one segment and reports incomplete windows", () => {
  const values = [];
  for (let index = 1; index <= 400; index++) {
    values.push(record(index, 1000, { segment_elapsed_ms: index * 1000 }));
  }
  for (let index = 1; index <= 10; index++) {
    values.push(record(400 + index, 1000, { segment_id: 2, segment_elapsed_ms: index * 1000 }));
  }
  const full = selectWindow(values, 1);
  const fiveMinutes = selectWindow(values, 1, 300);
  const short = selectWindow(values, 2, 300);
  assert.equal(full.length, 400);
  assert.equal(fiveMinutes.length, 300);
  assert.ok(fiveMinutes.every(item => item.segment_id === 1));
  assert.equal(short.length, 10);
});
