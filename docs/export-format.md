# Export Format

Exports are generated in the browser as UTF-8. CSV uses comma separators, CRLF line endings, and standard quote doubling for commas, quotes, or line breaks. Numeric data uses a period decimal separator and is not rounded before export. Array-valued CSV fields are JSON text.

All files describe one session. The schema version is currently <code>1</code>; the analysis version is <code>1.0.0</code>. CSV headers and JSON property names are stable API fields; readers should ignore unknown fields. Both CSV exports include trailing <code>schema_version</code> and <code>analysis_version</code> columns; the RR CSV's first six columns remain compatible with earlier consumers.

## rr.csv

One row per RR field decoded from a notification. Sequence numbers start at 1 per session. <code>rr_index_in_packet</code> is zero-based and preserves sensor order. The first six columns preserve the previous CSV layout.

| Field | Meaning |
| --- | --- |
| <code>sequence</code> | Consecutive RR row number within the session. |
| <code>packet</code> | Legacy alias for <code>packet_id</code>, retained for earlier CSV consumers. |
| <code>rr_ms</code> | RR duration in milliseconds, calculated as <code>rr_raw_1024 × 1000 / 1024</code>. Zero ticks are retained and flagged. |
| <code>bpm_from_rr</code> | <code>60000 / rr_ms</code>; blank for zero or invalid RR. |
| <code>sensor_bpm</code> | BPM value carried by the source notification; it is not synchronized to each RR in a multi-RR packet. |
| <code>notification_received_at</code> | UTC ISO 8601 time when the browser received the notification, not beat time. |
| <code>session_id</code> | UUID linking the row to the session. |
| <code>packet_id</code> | Consecutive notification number, including notifications with no RR or malformed contents. |
| <code>rr_index_in_packet</code> | Zero-based position among complete RR words in the packet. |
| <code>rr_raw_1024</code> | Original unsigned 16-bit RR value in units of 1/1024 second. |
| <code>segment_id</code> | Continuous RR segment. Pair metrics never cross segment boundaries. |
| <code>segment_elapsed_s</code> | Estimated cumulative RR time at this interval, relative to its segment. |
| <code>time_kind</code> | Currently <code>estimated_from_rr</code>; the timestamp is reconstructed from RR values. |
| <code>page_instance_id</code> | UUID identifying the page lifetime that produced the monotonic clock value. |
| <code>notification_monotonic_ms</code> | <code>performance.now()</code> captured at callback entry. Interpret with the session time origin and page ID; it is not a device clock. |
| <code>notification_id</code> | <code>session_id:packet_id</code> reference to the source notification. |
| <code>sensor_contact</code> | <code>detected</code>, <code>not_detected</code>, or <code>unknown</code>. |
| <code>flags</code> | Original Heart Rate Measurement flags byte. |
| <code>phase</code> | <code>stabilization</code> or <code>measurement</code>. |
| <code>quality_flags</code> | JSON array of descriptive review codes; empty when no RR rule marked the row. |

## packets.csv

One row per received notification. <code>raw_payload</code> is the full payload as lowercase hexadecimal without separators. <code>rr_count</code> counts complete RR words decoded from the packet. A malformed packet can still preserve a valid BPM and complete RR words; parse errors and the raw bytes remain available for review.

| Field | Meaning |
| --- | --- |
| <code>session_id</code>, <code>packet_id</code> | Session UUID and consecutive notification number. |
| <code>notification_received_at</code> | UTC ISO 8601 callback-receipt time. |
| <code>notification_monotonic_ms</code>, <code>page_instance_id</code> | Monotonic receipt clock and the page lifetime that defines its origin. |
| <code>sensor_bpm</code> | Heart rate as transmitted by the sensor, or blank if the field could not be decoded. |
| <code>flags</code> | Original protocol flags byte. Bit 0 selects UINT8/UINT16 BPM; bit 1 is contact status; bit 2 indicates contact support; bit 3 indicates energy expended; bit 4 indicates RR values. |
| <code>sensor_contact</code>, <code>sensor_contact_supported</code> | Parsed contact status and support bit; <code>unknown</code>/blank when unavailable. |
| <code>energy_expended_raw</code> | Optional unsigned 16-bit value in kJ, or blank if absent. |
| <code>rr_count</code> | Number of complete RR words decoded. |
| <code>raw_payload</code> | Full original notification bytes in hex. |
| <code>parse_status</code> | <code>valid</code>, <code>warning</code>, or <code>malformed</code>. Warnings include reserved flag bits; malformed packets are still retained. |
| <code>parse_errors</code>, <code>quality_flags</code> | JSON arrays of stable parser/review codes. |

The flag interpretation follows the [Bluetooth SIG Heart Rate Service specification](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html). RR words are unsigned 16-bit little-endian values. Reserved flags and extra bytes are retained and reported rather than silently converted into RR values.

## session.json

Contains session metadata, protocol and optional measurement notes, planned and actual duration, schema/analysis versions, quality parameters, page clock origin, and timestamped events. <code>ended_at</code> and <code>duration_ms</code> are null if the browser closed before a finish event; the application does not invent a recovery time.

<code>duration_ms</code> is elapsed wall time from session start to finish and includes pauses and connection interruptions. <code>captured_rr_duration_ms</code> sums positive received RR values, including stabilization. <code>measurement_rr_duration_ms</code> sums positive RR values assigned to the useful measurement phase; neither includes estimated gaps.

## summary.json

Contains analysis version, quality parameters, processing rules, formulas, and full-segment, one-minute, and five-minute windows separately for each segment. Windows use only rows with <code>phase = measurement</code>. Only a complete five-minute window under a seated or supine, spontaneous-breathing rest protocol sets <code>protocol_window_complete</code>; this does not validate a clinical protocol. Other windows are exploratory. Metrics are null when there are too few values or pairs to calculate them.

Mean BPM is the arithmetic mean of <code>60000 / RR</code> for each included interval. SDNN and SDSD are sample standard deviations (<code>n - 1</code>). RMSSD is the square root of mean squared eligible adjacent RR differences. pNN50 is the percentage of eligible adjacent same-segment pairs with an absolute difference greater than 50 ms; exactly 50 ms does not count. Poincaré SD1/SD2 are sample standard deviations of <code>(RR[n+1] − RR[n]) / sqrt(2)</code> and <code>(RR[n+1] + RR[n]) / sqrt(2)</code>. A missing sequence, excluded interval, or segment boundary prevents a pair; the analysis never bridges it.

These descriptive calculations do not classify normal beats and are not diagnostic.

### Reference vector

The deterministic synthetic vector <code>[1000, 1100, 900, 1000] ms</code> yields sample SDNN <code>81.649658 ms</code>, RMSSD <code>141.421356 ms</code>, sample SDSD <code>173.205081 ms</code>, pNN50 <code>100%</code>, SD1 <code>122.474487 ms</code>, and SD2 <code>70.710678 ms</code>. The test suite asserts these values. SDNN, RMSSD, and SDSD definitions are cross-checkable against [NeuroKit's time-domain HRV implementation](https://github.com/neuropsychology/NeuroKit/blob/master/neurokit2/hrv/hrv_time.py); this project explicitly uses eligible adjacent same-segment pairs as the pNN50 denominator.
