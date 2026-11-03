import { ANALYSIS_VERSION, SCHEMA_VERSION } from "./rr-core.mjs";

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers, records) {
  return [headers, ...records.map(record => headers.map(header => record[header]))]
    .map(row => row.map(csvCell).join(","))
    .join("\r\n");
}

export function serializeIntervalsCsv(intervals, session = {}) {
  const headers = [
    "sequence", "packet", "rr_ms", "bpm_from_rr", "sensor_bpm", "notification_received_at",
    "session_id", "packet_id", "rr_index_in_packet", "rr_raw_1024", "segment_id",
    "segment_elapsed_s", "time_kind", "page_instance_id", "notification_monotonic_ms", "notification_id",
    "sensor_contact", "flags", "phase", "quality_flags", "schema_version", "analysis_version"
  ];
  const rows = intervals.map(interval => ({
    ...interval,
    packet: interval.packet_id,
    segment_elapsed_s: interval.segment_elapsed_ms / 1000,
    schema_version: session.schema_version ?? SCHEMA_VERSION,
    analysis_version: session.analysis_version ?? ANALYSIS_VERSION
  }));
  return toCsv(headers, rows);
}

export function serializePacketsCsv(packets, session = {}) {
  const headers = [
    "session_id", "packet_id", "notification_received_at", "notification_monotonic_ms",
    "page_instance_id", "sensor_bpm", "flags", "sensor_contact", "sensor_contact_supported",
    "energy_expended_raw", "rr_count", "raw_payload", "parse_status",
    "parse_errors", "quality_flags", "schema_version", "analysis_version"
  ];
  const rows = packets.map(packet => ({
    ...packet,
    schema_version: session.schema_version ?? SCHEMA_VERSION,
    analysis_version: session.analysis_version ?? ANALYSIS_VERSION
  }));
  return toCsv(headers, rows);
}

export function serializeSessionJson(session) {
  return JSON.stringify({
    ...session,
    schema_version: session.schema_version ?? SCHEMA_VERSION,
    analysis_version: session.analysis_version ?? ANALYSIS_VERSION
  }, null, 2);
}

export function serializeSummaryJson(summary) {
  return JSON.stringify(summary, null, 2);
}
