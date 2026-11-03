export const SCHEMA_VERSION = 1;
export const ANALYSIS_VERSION = "1.0.0";

export const DEFAULT_QUALITY_PARAMETERS = Object.freeze({
  min_rr_ms: 300,
  max_rr_ms: 2000,
  abrupt_delta_ms: 250,
  abrupt_relative_ratio: 0.2,
  prolonged_gap_ms: 5000
});

export class PacketParseError extends Error {
  constructor(code, message, flags, raw_payload) {
    super(message);
    this.name = "PacketParseError";
    this.code = code;
    this.flags = flags;
    this.raw_payload = raw_payload;
  }
}

export function copyPayload(value) {
  let view;
  if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) {
    view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError("Expected an ArrayBuffer or typed array");
  }
  return Uint8Array.from(view);
}

export function payloadToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function parseHeartRate(value) {
  const bytes = copyPayload(value);
  const raw_payload = payloadToHex(bytes);
  if (bytes.length < 1) {
    throw new PacketParseError("missing_flags", "Notification has no flags byte", null, raw_payload);
  }

  const flags = bytes[0];
  if (bytes.length < 2) {
    throw new PacketParseError("missing_heart_rate", "Notification has no heart-rate value", flags, raw_payload);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uses_uint16_hr = (flags & 0x01) !== 0;
  const has_energy = (flags & 0x08) !== 0;
  const has_rr = (flags & 0x10) !== 0;
  const sensor_contact_supported = (flags & 0x04) !== 0;
  const sensor_contact_status = (flags & 0x02) !== 0;
  const hr_bytes = uses_uint16_hr ? 2 : 1;
  let offset = 1;

  if (offset + hr_bytes > bytes.length) {
    throw new PacketParseError("truncated_heart_rate", "Heart-rate value is truncated", flags, raw_payload);
  }
  const sensor_bpm = uses_uint16_hr ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += hr_bytes;

  let energy_expended_raw = null;
  if (has_energy) {
    if (offset + 2 > bytes.length) {
      throw new PacketParseError("truncated_energy_expended", "Energy-expended field is truncated", flags, raw_payload);
    }
    energy_expended_raw = view.getUint16(offset, true);
    offset += 2;
  }

  const parse_errors = [];
  const packet_quality_flags = [];
  const rr_intervals = [];
  const trailing_bytes = bytes.length - offset;

  if (has_rr) {
    if (trailing_bytes === 0) parse_errors.push("rr_flag_without_values");
    if (trailing_bytes % 2 !== 0) parse_errors.push("odd_rr_payload_length");
    while (offset + 1 < bytes.length) {
      const rr_raw_1024 = view.getUint16(offset, true);
      rr_intervals.push({
        rr_raw_1024,
        rr_ms: (rr_raw_1024 * 1000) / 1024
      });
      offset += 2;
    }
  } else if (trailing_bytes > 0) {
    parse_errors.push("unexpected_trailing_bytes_without_rr");
  }

  if ((flags & 0xe0) !== 0) packet_quality_flags.push("reserved_flag_bits");
  packet_quality_flags.push(...parse_errors);

  return {
    flags,
    sensor_bpm,
    sensor_contact: sensor_contact_supported
      ? (sensor_contact_status ? "detected" : "not_detected")
      : "unknown",
    sensor_contact_supported,
    energy_expended_raw,
    rr_intervals,
    rr_count: rr_intervals.length,
    raw_payload,
    parse_errors,
    packet_quality_flags
  };
}

export function createTimelineState() {
  return {
    next_sequence: 1,
    segment_id: 1,
    segment_elapsed_ms: 0,
    previous_rr_ms: null,
    last_rr_notification_monotonic_ms: null
  };
}

export function startNewSegment(state) {
  return {
    ...state,
    segment_id: state.segment_id + 1,
    segment_elapsed_ms: 0,
    previous_rr_ms: null,
    last_rr_notification_monotonic_ms: null
  };
}

export function gapSinceLastRR(state, notification_monotonic_ms, threshold_ms) {
  if (state.last_rr_notification_monotonic_ms === null) return null;
  const gap_ms = notification_monotonic_ms - state.last_rr_notification_monotonic_ms;
  return gap_ms > threshold_ms ? gap_ms : null;
}

export function intervalsForPacket(packet, state, quality = DEFAULT_QUALITY_PARAMETERS) {
  let next = { ...state };
  const intervals = [];

  for (let rr_index_in_packet = 0; rr_index_in_packet < packet.rr_intervals.length; rr_index_in_packet++) {
    const source = packet.rr_intervals[rr_index_in_packet];
    const quality_flags = [];
    const rr_ms = source.rr_ms;

    if (!Number.isFinite(rr_ms) || rr_ms <= 0) quality_flags.push("invalid_rr");
    else if (rr_ms < quality.min_rr_ms || rr_ms > quality.max_rr_ms) quality_flags.push("rr_outside_configured_range");

    if (Number.isFinite(rr_ms) && rr_ms > 0 && Number.isFinite(next.previous_rr_ms)) {
      const delta = Math.abs(rr_ms - next.previous_rr_ms);
      const relative = delta / Math.max(rr_ms, next.previous_rr_ms);
      if (delta > quality.abrupt_delta_ms && relative > quality.abrupt_relative_ratio) {
        quality_flags.push("abrupt_change_from_previous");
      }
    }
    if (packet.sensor_contact === "not_detected") quality_flags.push("sensor_contact_not_detected");

    next.segment_elapsed_ms += Number.isFinite(rr_ms) && rr_ms > 0 ? rr_ms : 0;
    intervals.push({
      session_id: packet.session_id,
      sequence: next.next_sequence,
      packet_id: packet.packet_id,
      rr_index_in_packet,
      rr_raw_1024: source.rr_raw_1024,
      rr_ms,
      bpm_from_rr: Number.isFinite(rr_ms) && rr_ms > 0 ? 60000 / rr_ms : null,
      segment_id: next.segment_id,
      segment_elapsed_ms: next.segment_elapsed_ms,
      relative_time_s: next.segment_elapsed_ms / 1000,
      time_kind: "estimated_from_rr",
      notification_id: `${packet.session_id}:${packet.packet_id}`,
      page_instance_id: packet.page_instance_id,
      notification_received_at: packet.notification_received_at,
      notification_monotonic_ms: packet.notification_monotonic_ms,
      sensor_bpm: packet.sensor_bpm,
      sensor_contact: packet.sensor_contact,
      flags: packet.flags,
      phase: packet.phase,
      quality_flags
    });

    next.next_sequence++;
    next.previous_rr_ms = Number.isFinite(rr_ms) && rr_ms > 0 ? rr_ms : null;
  }

  if (intervals.length > 0) next.last_rr_notification_monotonic_ms = packet.notification_monotonic_ms;
  return { intervals, state: next };
}
