import { ANALYSIS_VERSION, SCHEMA_VERSION } from "./rr-core.mjs";

const isValidRR = record => Number.isFinite(record.rr_ms) && record.rr_ms > 0;
const isSuspicious = record => Array.isArray(record.quality_flags) && record.quality_flags.length > 0;

export function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sumSquares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

function adjacentPairs(records, excludeSuspicious) {
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  const pairs = [];
  for (let index = 0; index + 1 < ordered.length; index++) {
    const first = ordered[index];
    const second = ordered[index + 1];
    if (first.sequence + 1 !== second.sequence || first.segment_id !== second.segment_id) continue;
    if (!isValidRR(first) || !isValidRR(second)) continue;
    if (excludeSuspicious && (isSuspicious(first) || isSuspicious(second))) continue;
    pairs.push({ first, second, delta_ms: second.rr_ms - first.rr_ms });
  }
  return pairs;
}

export function analyzeIntervals(records, { exclude_suspicious = false } = {}) {
  const all = [...records].sort((a, b) => a.sequence - b.sequence);
  const valid = all.filter(record => isValidRR(record) && (!exclude_suspicious || !isSuspicious(record)));
  const rr = valid.map(record => record.rr_ms);
  const bpm = rr.map(value => 60000 / value);
  const pairs = adjacentPairs(all, exclude_suspicious);
  const differences = pairs.map(pair => pair.delta_ms);
  const minBpm = bpm.length ? bpm.reduce((min, value) => Math.min(min, value), Infinity) : null;
  const maxBpm = bpm.length ? bpm.reduce((max, value) => Math.max(max, value), -Infinity) : null;
  const minRr = rr.length ? rr.reduce((min, value) => Math.min(min, value), Infinity) : null;
  const maxRr = rr.length ? rr.reduce((max, value) => Math.max(max, value), -Infinity) : null;
  const excluded = exclude_suspicious
    ? all.filter(record => !isValidRR(record) || isSuspicious(record)).map(record => ({
      sequence: record.sequence,
      quality_flags: !isValidRR(record) && !isSuspicious(record)
        ? ["invalid_rr"]
        : [...(record.quality_flags || [])]
    }))
    : [];

  return {
    total_intervals: all.length,
    valid_intervals: valid.length,
    suspect_count: all.filter(isSuspicious).length,
    suspect_percent: all.length ? (all.filter(isSuspicious).length / all.length) * 100 : null,
    excluded_count: excluded.length,
    excluded,
    mean_bpm: bpm.length ? bpm.reduce((sum, value) => sum + value, 0) / bpm.length : null,
    min_bpm: minBpm,
    max_bpm: maxBpm,
    mean_rr_ms: rr.length ? rr.reduce((sum, value) => sum + value, 0) / rr.length : null,
    min_rr_ms: minRr,
    max_rr_ms: maxRr,
    sdnn_ms: sampleStandardDeviation(rr),
    rmssd_ms: differences.length
      ? Math.sqrt(differences.reduce((sum, value) => sum + value ** 2, 0) / differences.length)
      : null,
    sdsd_ms: sampleStandardDeviation(differences),
    pnn50_percent: differences.length
      ? (differences.filter(value => Math.abs(value) > 50).length / differences.length) * 100
      : null,
    pair_count: pairs.length,
    pnn50_denominator: "valid adjacent RR pairs within the same segment"
  };
}

export function calculatePoincare(records, { exclude_suspicious = false } = {}) {
  const pairs = adjacentPairs(records, exclude_suspicious);
  const projected_sd1 = pairs.map(pair => pair.delta_ms / Math.sqrt(2));
  const projected_sd2 = pairs.map(pair => (pair.first.rr_ms + pair.second.rr_ms) / Math.sqrt(2));
  return {
    sd1_ms: sampleStandardDeviation(projected_sd1),
    sd2_ms: sampleStandardDeviation(projected_sd2),
    pair_count: pairs.length,
    pairs
  };
}

export function selectWindow(records, segmentId, windowSeconds = null) {
  const segment = records
    .filter(record => record.segment_id === segmentId && record.phase === "measurement")
    .sort((a, b) => a.sequence - b.sequence);
  if (windowSeconds === null || segment.length === 0) return segment;

  const endMs = segment.reduce((max, record) => Math.max(max, record.segment_elapsed_ms), 0);
  const startMs = Math.max(0, endMs - windowSeconds * 1000);
  return segment.filter(record => record.segment_elapsed_ms > startMs);
}

export function summarizeSession(session, records, qualityParameters) {
  const bySegment = new Map();
  for (const record of records) {
    if (!bySegment.has(record.segment_id)) bySegment.set(record.segment_id, []);
    bySegment.get(record.segment_id).push(record);
  }
  const segmentIds = [...bySegment.keys()].sort((a, b) => a - b);
  const windows = [];
  for (const segmentId of segmentIds) {
    for (const windowSeconds of [null, 60, 300]) {
      const selected = selectWindow(bySegment.get(segmentId), segmentId, windowSeconds);
      const durationMs = selected.reduce((sum, record) => sum + (isValidRR(record) ? record.rr_ms : 0), 0);
      const protocolWindowComplete = windowSeconds === 300 && durationMs >= 300000 &&
        ["rest_seated_spontaneous", "rest_supine_spontaneous"].includes(session.protocol) &&
        session.respiration === "spontaneous";
      windows.push({
        segment_id: segmentId,
        requested_window_seconds: windowSeconds,
        effective_duration_seconds: durationMs / 1000,
        protocol_window_complete: protocolWindowComplete,
        exploratory: !protocolWindowComplete,
        original: analyzeIntervals(selected),
        processed: analyzeIntervals(selected, { exclude_suspicious: true }),
        poincare: calculatePoincare(selected, { exclude_suspicious: true })
      });
    }
  }

  return {
    schema_version: session.schema_version ?? SCHEMA_VERSION,
    analysis_version: ANALYSIS_VERSION,
    session_id: session.session_id,
    protocol: session.protocol,
    quality_parameters: qualityParameters,
    processing_rules: {
      analyzed_phase: "measurement",
      processed_exclusion_flags: [
        "invalid_rr",
        "rr_outside_configured_range",
        "abrupt_change_from_previous",
        "sensor_contact_not_detected"
      ],
      pair_rule: "Only adjacent session sequence numbers from the same segment; no bridging across exclusions or gaps.",
      raw_records_modified: false
    },
    metric_definitions: {
      mean_bpm: "Arithmetic mean of 60000 / rr_ms for each included positive RR interval.",
      sdnn_ms: "Sample standard deviation (n - 1) of included RR intervals.",
      rmssd_ms: "Square root of the mean squared difference across eligible adjacent RR pairs.",
      sdsd_ms: "Sample standard deviation (n - 1) of eligible adjacent RR differences.",
      pnn50_percent: "Eligible adjacent RR pairs with an absolute difference greater than 50 ms divided by eligible pairs.",
      poincare: "Sample standard deviations of (RR[n+1]-RR[n])/sqrt(2) and (RR[n+1]+RR[n])/sqrt(2)."
    },
    windows
  };
}
