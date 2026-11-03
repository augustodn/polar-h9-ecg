import {
  ANALYSIS_VERSION,
  DEFAULT_QUALITY_PARAMETERS,
  SCHEMA_VERSION,
  copyPayload,
  createTimelineState,
  gapSinceLastRR,
  intervalsForPacket,
  parseHeartRate,
  payloadToHex,
  startNewSegment
} from "./rr-core.mjs";
import { analyzeIntervals, calculatePoincare, selectWindow, summarizeSession } from "./analysis.mjs";
import { drawDerivedBpm, drawPoincare, drawSensorBpm, drawTachogram } from "./charts.mjs";
import {
  serializeIntervalsCsv,
  serializePacketsCsv,
  serializeSessionJson,
  serializeSummaryJson
} from "./export.mjs";
import { createSessionStore } from "./storage.mjs";

const HR_SERVICE = "heart_rate";
const HR_MEASUREMENT = "heart_rate_measurement";
const PAGE_INSTANCE_ID = crypto.randomUUID();
const $ = id => document.getElementById(id);

const ui = {
  connect: $("connectBtn"),
  start: $("startBtn"),
  pause: $("pauseBtn"),
  finish: $("finishBtn"),
  disconnect: $("disconnectBtn"),
  deviceState: $("deviceState"),
  storageState: $("storageState"),
  sessionState: $("sessionState"),
  liveReadings: $("liveReadings"),
  message: $("message"),
  protocol: $("protocol"),
  posture: $("posture"),
  respiration: $("respiration"),
  plannedDuration: $("plannedDuration"),
  stabilization: $("stabilization"),
  respiratoryRate: $("respiratoryRate"),
  priorActivity: $("priorActivity"),
  observations: $("observations"),
  minRR: $("minRR"),
  maxRR: $("maxRR"),
  abruptDelta: $("abruptDelta"),
  gapThreshold: $("gapThreshold"),
  segmentSelect: $("segmentSelect"),
  windowSelect: $("windowSelect"),
  sampleCount: $("sampleCount"),
  rrList: $("rrList"),
  packetList: $("packetList"),
  eventList: $("eventList"),
  analysisCards: $("analysisCards"),
  analysisNote: $("analysisNote"),
  poincareStats: $("poincareStats"),
  sessionSelect: $("sessionSelect"),
  loadSession: $("loadSessionBtn"),
  deleteSession: $("deleteSessionBtn"),
  refreshSessions: $("refreshSessionsBtn"),
  exportRR: $("exportRRBtn"),
  exportPackets: $("exportPacketsBtn"),
  exportSession: $("exportSessionBtn"),
  exportSummary: $("exportSummaryBtn"),
  rrChart: $("rrChart"),
  derivedBpmChart: $("derivedBpmChart"),
  sensorBpmChart: $("sensorBpmChart"),
  poincareChart: $("poincareChart")
};

let sessionStore = null;
let device = null;
let characteristic = null;
let connected = false;
let connecting = false;
let activeSession = null;
let activeData = null;
let viewData = null;
let followLive = true;
let timeline = createTimelineState();
let currentPhase = "measurement";
let capturing = false;
let userPaused = false;
let resumeAfterReconnect = false;
let pendingSegmentReason = null;
let gapReported = false;
let captureStartedMono = null;
let stabilizationDeadlineMono = null;
let stabilizationTimer = null;
let gapWatchTimer = null;
let storageFailure = null;
let writeQueue = Promise.resolve();
let lastFullActiveRender = 0;

const protocolInfo = {
  rest_seated_spontaneous: { label: "Seated rest, spontaneous breathing", posture: "seated", respiration: "spontaneous", duration: 300 },
  rest_supine_spontaneous: { label: "Supine rest, spontaneous breathing", posture: "supine", respiration: "spontaneous", duration: 300 },
  deep_or_guided_breathing: { label: "Deep or guided breathing", posture: "unspecified", respiration: "guided", duration: 300 },
  free: { label: "Free measurement", posture: "unspecified", respiration: "unspecified", duration: 0 }
};
const eventLabels = {
  session_started: "Session started",
  stabilization_started: "Stabilization started",
  stabilization_ended: "Stabilization ended",
  measurement_started: "Measurement started",
  acquisition_paused: "Acquisition paused",
  acquisition_resumed: "Acquisition resumed",
  sensor_disconnected: "Sensor disconnected",
  sensor_reconnected: "Sensor reconnected",
  possible_rr_gap: "Prolonged RR silence",
  segment_started: "New segment",
  malformed_packet: "Malformed notification",
  packet_warning: "Packet warning",
  session_finished: "Session finished",
  storage_error: "Storage error"
};
const qualityLabels = {
  invalid_rr: "invalid RR",
  rr_outside_configured_range: "outside configured thresholds",
  abrupt_change_from_previous: "abrupt change from previous RR",
  sensor_contact_not_detected: "sensor contact not detected",
  reserved_flag_bits: "reserved flag bits are set",
  rr_flag_without_values: "RR flag set without values",
  odd_rr_payload_length: "odd-length RR field",
  unexpected_trailing_bytes_without_rr: "extra bytes without RR flag",
  missing_flags: "missing flags byte",
  missing_heart_rate: "missing heart-rate value",
  truncated_heart_rate: "truncated heart-rate value",
  truncated_energy_expended: "truncated energy field",
  unreadable_payload: "unreadable payload"
};
const reasonLabels = {
  possible_rr_gap: "prolonged RR silence",
  sensor_disconnected: "sensor disconnected",
  acquisition_paused: "acquisition paused",
  user_resume: "resume requested",
  planned_duration_reached: "planned duration reached",
  notification_start_failed: "notifications could not be started"
};
const parseStatusLabels = { valid: "valid", warning: "warning", malformed: "malformed" };

function protocolLabel(session) {
  return protocolInfo[session.protocol]?.label || session.protocol_label || session.protocol;
}

function setMessage(text, error = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", Boolean(error));
}

function setDeviceState(text, isConnected = false) {
  ui.deviceState.textContent = text;
  ui.deviceState.classList.toggle("connected", isConnected);
}

function updateControls() {
  ui.connect.disabled = connecting || connected;
  ui.start.disabled = !connected || !sessionStore || Boolean(activeSession) || Boolean(storageFailure);
  ui.pause.disabled = !activeSession || (!capturing && !userPaused);
  ui.pause.textContent = userPaused ? "Resume" : "Pause";
  ui.finish.disabled = !activeSession;
  ui.disconnect.disabled = !connected;
  const hasView = Boolean(viewData && viewData.session);
  ui.exportRR.disabled = !hasView;
  ui.exportPackets.disabled = !hasView;
  ui.exportSession.disabled = !hasView;
  ui.exportSummary.disabled = !hasView;
  const selectedId = ui.sessionSelect.value;
  ui.loadSession.disabled = !selectedId;
  ui.deleteSession.disabled = !selectedId || selectedId === activeSession?.session_id;
  for (const control of [ui.protocol, ui.posture, ui.respiration, ui.plannedDuration, ui.stabilization,
    ui.respiratoryRate, ui.priorActivity, ui.observations, ui.minRR, ui.maxRR, ui.abruptDelta, ui.gapThreshold]) {
    control.disabled = Boolean(activeSession);
  }
  ui.sessionState.textContent = activeSession
    ? (capturing ? "Recording session" : userPaused ? "Session paused" : "Session open; acquisition stopped")
    : viewData?.session
      ? viewData.session.ended_at ? "Viewing completed session" : "Viewing incomplete session"
      : "No active session";
}

function setStorageStatus(text, error = false) {
  ui.storageState.textContent = text;
  ui.storageState.classList.toggle("ready", !error);
  ui.storageState.classList.toggle("error", error);
}

function getQualityParameters() {
  const values = {
    min_rr_ms: Number(ui.minRR.value),
    max_rr_ms: Number(ui.maxRR.value),
    abrupt_delta_ms: Number(ui.abruptDelta.value),
    abrupt_relative_ratio: DEFAULT_QUALITY_PARAMETERS.abrupt_relative_ratio,
    prolonged_gap_ms: Number(ui.gapThreshold.value)
  };
  if (!Number.isFinite(values.min_rr_ms) || !Number.isFinite(values.max_rr_ms) ||
      !Number.isFinite(values.abrupt_delta_ms) || !Number.isFinite(values.prolonged_gap_ms) ||
      values.min_rr_ms <= 0 || values.max_rr_ms <= values.min_rr_ms ||
      values.abrupt_delta_ms <= 0 || values.prolonged_gap_ms <= 0) {
    throw new RangeError("Check the RR thresholds: the maximum must exceed the minimum and all values must be positive.");
  }
  return values;
}

function applyProtocolDefaults() {
  const info = protocolInfo[ui.protocol.value];
  if (!info) return;
  ui.posture.value = info.posture;
  ui.respiration.value = info.respiration;
  ui.plannedDuration.value = String(info.duration);
}

function makeEvent(type, details = {}, receivedAt = null, monotonicMs = null, segmentId = null) {
  return {
    event_id: (activeSession?.events.length || 0) + 1,
    type,
    timestamp_utc: receivedAt || new Date().toISOString(),
    monotonic_ms: monotonicMs ?? performance.now(),
    page_instance_id: PAGE_INSTANCE_ID,
    segment_id: segmentId ?? timeline.segment_id,
    details
  };
}

function indexSessionData(data) {
  const bySegment = new Map();
  const packetsBySegment = new Map();
  for (const record of data.intervals || []) appendToGroup(bySegment, record.segment_id, record);
  for (const packet of data.packets || []) appendToGroup(packetsBySegment, packet.segment_id ?? 1, packet);
  return { ...data, bySegment, packetsBySegment };
}

function appendToGroup(map, key, record, maxLength = Infinity) {
  if (!map.has(key)) map.set(key, []);
  const group = map.get(key);
  group.push(record);
  if (group.length > maxLength) group.splice(0, group.length - maxLength);
}

function enqueueWrite(operation) {
  writeQueue = writeQueue.then(async () => {
    if (storageFailure) return;
    await operation();
  }).catch(error => {
    return handleStorageFailure(error);
  });
  return writeQueue;
}

async function handleStorageFailure(error) {
  if (storageFailure) return;
  storageFailure = error;
  const event = makeEvent("storage_error", { message: String(error?.message || error) });
  activeSession?.events.push(event);
  setStorageStatus("Storage error", true);
  setMessage("IndexedDB failed. Acquisition stopped to prevent more unsaved data; export the in-memory copy before closing.", true);
  if (characteristic && capturing) {
    capturing = false;
    clearInterval(gapWatchTimer);
    try { await characteristic.stopNotifications(); } catch {}
    characteristic.removeEventListener("characteristicvaluechanged", onHeartRate);
  }
  updateControls();
  render(false);
}

function recordEvent(type, details = {}, receivedAt = null, monotonicMs = null, segmentId = null) {
  if (!activeSession) return null;
  const event = makeEvent(type, details, receivedAt, monotonicMs, segmentId);
  activeSession.events.push(event);
  if (!storageFailure) {
    enqueueWrite(() => sessionStore.appendEvent(activeSession.session_id, event));
  }
  render();
  return event;
}

function startGapWatch() {
  clearInterval(gapWatchTimer);
  gapWatchTimer = setInterval(() => {
    if (!activeSession || !capturing || gapReported) return;
    const quality = activeSession.quality_parameters;
    const basis = timeline.last_rr_notification_monotonic_ms ?? captureStartedMono;
    const elapsed = performance.now() - basis;
    if (elapsed <= quality.prolonged_gap_ms) return;
    gapReported = true;
    if (timeline.last_rr_notification_monotonic_ms !== null) pendingSegmentReason = "possible_rr_gap";
    recordEvent("possible_rr_gap", {
      elapsed_since_last_rr_ms: elapsed,
      threshold_ms: quality.prolonged_gap_ms,
      interpretation: "Possible interruption in RR reception; this does not confirm a lost beat or packet."
    });
    setMessage("No RR received for more than " + quality.prolonged_gap_ms +
      " ms. A possible discontinuity will be marked; this does not confirm missed beats.");
  }, 500);
}

async function startNotifications() {
  if (!characteristic) throw new Error("The heart-rate characteristic is unavailable.");
  if (!characteristic.properties.notify) throw new Error("The sensor does not support heart-rate notifications.");
  characteristic.removeEventListener("characteristicvaluechanged", onHeartRate);
  characteristic.addEventListener("characteristicvaluechanged", onHeartRate);
  capturing = true;
  captureStartedMono = performance.now();
  gapReported = false;
  startGapWatch();
  try {
    await characteristic.startNotifications();
  } catch (error) {
    capturing = false;
    clearInterval(gapWatchTimer);
    characteristic.removeEventListener("characteristicvaluechanged", onHeartRate);
    throw error;
  }
}

async function connectSensor() {
  if (!window.isSecureContext || !navigator.bluetooth) {
    setMessage("Web Bluetooth requires Chrome or Edge over HTTPS or localhost.", true);
    return;
  }
  connecting = true;
  updateControls();
  setDeviceState("Connecting…");
  try {
    if (!device) {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "Polar H9" }],
        optionalServices: [HR_SERVICE]
      });
      device.addEventListener("gattserverdisconnected", onDisconnected);
    }
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const service = await server.getPrimaryService(HR_SERVICE);
    characteristic = await service.getCharacteristic(HR_MEASUREMENT);
    connected = true;
    setDeviceState((device.name || "Polar H9") + " connected", true);
    setMessage("Sensor connected. Start a session to save RR notifications.");

    if (activeSession && resumeAfterReconnect && !userPaused) {
      if (timeline.next_sequence > 1) timeline = startNewSegment(timeline);
      pendingSegmentReason = null;
      recordEvent("sensor_reconnected", { reason: "GATT connection restored." });
      resumeAfterReconnect = false;
      await startNotifications();
    }
  } catch (error) {
    connected = Boolean(device?.gatt?.connected);
    if (!connected) characteristic = null;
    setDeviceState(connected ? (device.name || "Polar H9") + " connected" : "Sensor disconnected", connected);
    if (error.name !== "NotFoundError") setMessage("Could not connect: " + error.message, true);
  } finally {
    connecting = false;
    updateControls();
  }
}

function onDisconnected() {
  connected = false;
  if (characteristic) {
    characteristic.removeEventListener("characteristicvaluechanged", onHeartRate);
    characteristic = null;
  }
  if (activeSession && capturing) {
    capturing = false;
    clearInterval(gapWatchTimer);
    pendingSegmentReason = "sensor_disconnected";
    resumeAfterReconnect = !userPaused;
    recordEvent("sensor_disconnected", {
      interpretation: "Connection interruption recorded; its duration and any missing beats are unknown."
    });
  }
  setDeviceState("Sensor disconnected");
  setMessage(activeSession
    ? "Connection interrupted. Session data and events are preserved; reconnect to continue in a new segment."
    : "Sensor disconnected.");
  updateControls();
  render();
}

function protocolMetadata() {
  const planned = Number(ui.plannedDuration.value);
  const stabilization = Number(ui.stabilization.value);
  const target = ui.respiratoryRate.value === "" ? null : Number(ui.respiratoryRate.value);
  if (!Number.isInteger(planned) || planned < 0 || planned > 86400) {
    throw new RangeError("Useful duration must be an integer from 0 to 86,400 seconds.");
  }
  if (!Number.isInteger(stabilization) || stabilization < 0 || stabilization > 3600) {
    throw new RangeError("Stabilization must be an integer from 0 to 3,600 seconds.");
  }
  if (target !== null && (!Number.isFinite(target) || target < 1 || target > 60)) {
    throw new RangeError("Target breathing rate must be from 1 to 60 breaths/min.");
  }
  return {
    protocol: ui.protocol.value,
    protocol_label: protocolInfo[ui.protocol.value]?.label || "Free measurement",
    posture: ui.posture.value,
    respiration: ui.respiration.value,
    target_respiratory_rate_per_min: target,
    prior_activity: ui.priorActivity.value.trim() || null,
    observations: ui.observations.value.trim() || null,
    planned_duration_seconds: planned,
    stabilization_seconds: stabilization,
    device_name: device?.name || "Polar H9"
  };
}

async function startSession() {
  if (!sessionStore || !connected || !device?.gatt?.connected || activeSession) return;
  let metadata, quality;
  try {
    metadata = protocolMetadata();
    quality = getQualityParameters();
  } catch (error) {
    setMessage(error.message, true);
    return;
  }

  timeline = createTimelineState();
  storageFailure = null;
  userPaused = false;
  resumeAfterReconnect = false;
  pendingSegmentReason = null;
  gapReported = false;
  const startedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const session = {
    schema_version: SCHEMA_VERSION,
    analysis_version: ANALYSIS_VERSION,
    session_id: id,
    started_at: startedAt,
    ended_at: null,
    duration_ms: null,
    captured_rr_duration_ms: 0,
    measurement_rr_duration_ms: 0,
    packet_count: 0,
    interval_count: 0,
    last_notification_received_at: null,
    status: "recording",
    protocol: metadata.protocol,
    protocol_label: metadata.protocol_label,
    posture: metadata.posture,
    respiration: metadata.respiration,
    target_respiratory_rate_per_min: metadata.target_respiratory_rate_per_min,
    prior_activity: metadata.prior_activity,
    observations: metadata.observations,
    planned_duration_seconds: metadata.planned_duration_seconds,
    stabilization_seconds: metadata.stabilization_seconds,
    device_name: metadata.device_name,
    page_instance_id: PAGE_INSTANCE_ID,
    performance_time_origin_ms: performance.timeOrigin,
    quality_parameters: quality,
    events: []
  };
  session.events.push(makeEvent("session_started", {
    protocol: session.protocol,
    planned_duration_seconds: session.planned_duration_seconds,
    stabilization_seconds: session.stabilization_seconds
  }, startedAt, performance.now(), timeline.segment_id));
  currentPhase = metadata.stabilization_seconds > 0 ? "stabilization" : "measurement";

  try {
    await sessionStore.createSession(session);
    activeSession = session;
    activeData = {
      session, packets: [], intervals: [],
      bySegment: new Map(), packetsBySegment: new Map(),
      recentBySegment: new Map(), recentPacketsBySegment: new Map()
    };
    viewData = activeData;
    followLive = true;
    const phaseStartAt = new Date().toISOString();
    const phaseStartMono = performance.now();
    recordEvent(
      currentPhase === "stabilization" ? "stabilization_started" : "measurement_started",
      { phase: currentPhase },
      phaseStartAt,
      phaseStartMono,
      timeline.segment_id
    );
    if (metadata.stabilization_seconds > 0) {
      stabilizationDeadlineMono = phaseStartMono + metadata.stabilization_seconds * 1000;
      const activeId = session.session_id;
      stabilizationTimer = setTimeout(() => {
        if (activeSession?.session_id === activeId && currentPhase === "stabilization") {
          endStabilization(new Date().toISOString(), performance.now(), "timer");
        }
      }, metadata.stabilization_seconds * 1000);
    } else {
      stabilizationDeadlineMono = null;
    }
    await startNotifications();
  } catch (error) {
    if (activeSession) {
      await finishSession("notification_start_failed");
    } else {
      setMessage("Could not save or start the session: " + error.message, true);
    }
    return;
  }

  setMessage("Session started. Each notification is confirmed locally after its IndexedDB transaction.");
  updateControls();
  await refreshSessions();
  render();
}

function endStabilization(receivedAt, monotonicMs, source) {
  if (currentPhase !== "stabilization") return;
  currentPhase = "measurement";
  clearTimeout(stabilizationTimer);
  stabilizationDeadlineMono = null;
  const event = makeEvent("stabilization_ended", {
    observed_by: source,
    note: "The event time is observed by the browser; BLE receipt is not the exact beat time."
  }, receivedAt, monotonicMs);
  activeSession.events.push(event);
  enqueueWrite(() => sessionStore.appendEvent(activeSession.session_id, event));
  recordEvent("measurement_started", { observed_by: source }, receivedAt, monotonicMs);
}

async function togglePause() {
  if (!activeSession) return;
  if (capturing) {
    capturing = false;
    userPaused = true;
    resumeAfterReconnect = false;
    clearInterval(gapWatchTimer);
    if (characteristic) {
      try { await characteristic.stopNotifications(); } catch (error) {
        setMessage("Could not stop notifications cleanly: " + error.message, true);
      }
      characteristic.removeEventListener("characteristicvaluechanged", onHeartRate);
    }
    pendingSegmentReason = "acquisition_paused";
    recordEvent("acquisition_paused", { reason: "Paused by the user." });
    setMessage("Acquisition paused. Resuming will start a new segment.");
  } else if (connected && characteristic) {
    if (timeline.next_sequence > 1) timeline = startNewSegment(timeline);
    pendingSegmentReason = null;
    userPaused = false;
    recordEvent("acquisition_resumed", { segment_reason: "user_resume" });
    await startNotifications();
    setMessage("Acquisition resumed in a new segment.");
  } else {
    setMessage("Reconnect the sensor to resume the session.", true);
  }
  updateControls();
  render();
}

async function disconnectSensor() {
  if (device?.gatt?.connected) device.gatt.disconnect();
  else onDisconnected();
}

async function finishSession(reason = "user") {
  if (!activeSession) return;
  const session = activeSession;
  clearInterval(gapWatchTimer);
  clearTimeout(stabilizationTimer);
  if (characteristic && capturing) {
    capturing = false;
    try { await characteristic.stopNotifications(); } catch {}
    characteristic.removeEventListener("characteristicvaluechanged", onHeartRate);
  }
  capturing = false;
  userPaused = false;
  resumeAfterReconnect = false;
  const endedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(session.started_at));
  const status = reason === "planned_duration_reached" ? "complete" : "finished";
  const event = makeEvent("session_finished", { reason, status }, endedAt, performance.now());
  session.events.push(event);
  Object.assign(session, {
    ended_at: endedAt,
    duration_ms: durationMs,
    duration_seconds: durationMs / 1000,
    status
  });
  if (!storageFailure) {
    enqueueWrite(() => sessionStore.appendEvent(session.session_id, event, {
      ended_at: endedAt,
      duration_ms: durationMs,
      duration_seconds: durationMs / 1000,
      status
    }));
  }
  await writeQueue;
  activeSession = null;
  if (followLive && activeData) viewData = activeData;
  setMessage(storageFailure
    ? "Session ended in memory, but the finish could not be saved. Download the exports before closing."
    : "Session ended and saved in this browser.");
  updateControls();
  await refreshSessions();
  render();
}

let packetEventOffset = 0;
function eventForPacket(type, details, receivedAt, monotonicMs, segmentId) {
  const event = makeEvent(type, details, receivedAt, monotonicMs, segmentId);
  event.event_id = (activeSession.events.length || 0) + (++packetEventOffset);
  return event;
}

function onHeartRate(event) {
  if (!activeSession || !capturing) return;
  const receivedAt = new Date().toISOString();
  const monotonicMs = performance.now();
  let bytes;
  let parsed = null;
  let parseFailure = null;
  try {
    bytes = copyPayload(event.target.value);
    parsed = parseHeartRate(bytes);
  } catch (error) {
    parseFailure = error;
    try { bytes = copyPayload(event.target.value); } catch { bytes = new Uint8Array(); }
  }

  if (currentPhase === "stabilization" && stabilizationDeadlineMono !== null && monotonicMs >= stabilizationDeadlineMono) {
    endStabilization(receivedAt, monotonicMs, "notification");
  }

  const packetId = activeSession.packet_count + 1;
  packetEventOffset = 0;
  const quality = activeSession.quality_parameters;
  const packetEvents = [];
  const rrSource = parsed?.rr_intervals || [];
  const hasRR = rrSource.length > 0;
  const gap = gapSinceLastRR(timeline, monotonicMs, quality.prolonged_gap_ms);

  if (gap !== null && !gapReported) {
    pendingSegmentReason = pendingSegmentReason || "possible_rr_gap";
    gapReported = true;
    packetEvents.push(eventForPacket("possible_rr_gap", {
      elapsed_since_last_rr_ms: gap,
      threshold_ms: quality.prolonged_gap_ms,
      interpretation: "Possible interruption in RR reception; this does not confirm a lost beat or packet."
    }, receivedAt, monotonicMs, timeline.segment_id));
  }
  if (hasRR && pendingSegmentReason) {
    const reason = pendingSegmentReason;
    timeline = startNewSegment(timeline);
    packetEvents.push(eventForPacket("segment_started", {
      reason,
      note: "Relative RR time starts over; interruption duration and missing beats are unknown."
    }, receivedAt, monotonicMs, timeline.segment_id));
    pendingSegmentReason = null;
    gapReported = false;
  }

  const packet = {
    session_id: activeSession.session_id,
    packet_id: packetId,
    notification_received_at: receivedAt,
    notification_monotonic_ms: monotonicMs,
    page_instance_id: PAGE_INSTANCE_ID,
    sensor_bpm: parsed?.sensor_bpm ?? null,
    flags: parsed?.flags ?? (bytes.length ? bytes[0] : null),
    sensor_contact: parsed?.sensor_contact || "unknown",
    sensor_contact_supported: parsed?.sensor_contact_supported ?? null,
    energy_expended_raw: parsed?.energy_expended_raw ?? null,
    rr_count: parsed?.rr_count || 0,
    raw_payload: parsed?.raw_payload ?? payloadToHex(bytes),
    parse_status: parseFailure || parsed?.parse_errors.length ? "malformed"
      : parsed?.packet_quality_flags.length ? "warning" : "valid",
    parse_errors: parsed?.parse_errors || [parseFailure?.code || "unreadable_payload"].filter(Boolean),
    quality_flags: parsed?.packet_quality_flags || [parseFailure?.code || "unreadable_payload"].filter(Boolean),
    segment_id: timeline.segment_id,
    phase: currentPhase
  };

  if (parseFailure) {
    packetEvents.push(eventForPacket("malformed_packet", {
      packet_id: packetId,
      reason: parseFailure.code || parseFailure.message,
      raw_payload: packet.raw_payload
    }, receivedAt, monotonicMs, timeline.segment_id));
  }
  if (parsed?.parse_errors.length) {
    packetEvents.push(eventForPacket("malformed_packet", {
      packet_id: packetId,
      reasons: parsed.parse_errors,
      raw_payload: packet.raw_payload
    }, receivedAt, monotonicMs, timeline.segment_id));
  }
  if (parsed?.packet_quality_flags.some(flag => !parsed.parse_errors.includes(flag))) {
    packetEvents.push(eventForPacket("packet_warning", {
      packet_id: packetId,
      flags: parsed.packet_quality_flags.filter(flag => !parsed.parse_errors.includes(flag))
    }, receivedAt, monotonicMs, timeline.segment_id));
  }

  const result = intervalsForPacket({
    ...packet,
    rr_intervals: rrSource
  }, timeline, quality);
  timeline = result.state;
  const intervals = result.intervals;
  activeSession.packet_count = packetId;
  activeSession.interval_count += intervals.length;
  activeSession.captured_rr_duration_ms += intervals.reduce(
    (sum, interval) => sum + (Number.isFinite(interval.rr_ms) && interval.rr_ms > 0 ? interval.rr_ms : 0), 0
  );
  activeSession.measurement_rr_duration_ms += intervals.reduce(
    (sum, interval) => sum + (interval.phase === "measurement" && Number.isFinite(interval.rr_ms) && interval.rr_ms > 0 ? interval.rr_ms : 0), 0
  );
  activeSession.last_notification_received_at = receivedAt;
  packetEvents.forEach(item => activeSession.events.push(item));
  activeData.packets.push(packet);
  appendToGroup(activeData.packetsBySegment, packet.segment_id, packet);
  appendToGroup(activeData.recentPacketsBySegment, packet.segment_id, packet, 5000);
  for (const interval of intervals) {
    activeData.intervals.push(interval);
    appendToGroup(activeData.bySegment, interval.segment_id, interval);
    appendToGroup(activeData.recentBySegment, interval.segment_id, interval, 5000);
  }
  if (followLive) viewData = activeData;
  if (parsed && parsed.sensor_bpm !== null) {
    ui.liveReadings.textContent = "Sensor: " + parsed.sensor_bpm + " bpm · Latest RR: " +
      (intervals.length ? intervals[intervals.length - 1].rr_ms.toFixed(2) : "—") + " ms";
  }

  const plannedMs = activeSession.planned_duration_seconds * 1000;
  const shouldFinish = activeSession.planned_duration_seconds > 0 &&
    activeSession.measurement_rr_duration_ms >= plannedMs;
  enqueueWrite(() => sessionStore.appendNotification(activeSession.session_id, packet, intervals, packetEvents));
  if (shouldFinish) writeQueue.then(() => finishSession("planned_duration_reached"));
  if (followLive) render(false);
  else updateControls();
}

async function refreshSessions() {
  if (!sessionStore) return;
  try {
    const sessions = await sessionStore.listSessions();
    const selected = viewData?.session?.session_id || activeSession?.session_id || ui.sessionSelect.value;
    ui.sessionSelect.replaceChildren();
    if (sessions.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No saved sessions";
      ui.sessionSelect.append(option);
    } else {
      for (const session of sessions) {
        const option = document.createElement("option");
        option.value = session.session_id;
        const status = session.ended_at ? "completed" : "incomplete";
        option.textContent = new Date(session.started_at).toLocaleString("en-US") + " · " +
          protocolLabel(session) + " · " + session.interval_count + " RR · " + status;
        ui.sessionSelect.append(option);
      }
      if (sessions.some(session => session.session_id === selected)) ui.sessionSelect.value = selected;
    }
    updateControls();
  } catch (error) {
    setMessage("Could not refresh the session list: " + error.message, true);
  }
}

async function loadSelectedSession() {
  const id = ui.sessionSelect.value;
  if (!id || !sessionStore) return;
  if (activeSession && id === activeSession.session_id) {
    viewData = activeData;
    followLive = true;
    render(true);
    setMessage("Returned to the active session.");
    return;
  }
  try {
    const data = await sessionStore.loadSession(id);
    if (!data.session) throw new Error("The session no longer exists in local storage.");
    viewData = indexSessionData(data);
    followLive = false;
    updateControls();
    render(true);
    setMessage(data.session.ended_at
      ? "Session loaded from IndexedDB."
      : "Incomplete session recovered. No finish time was invented.");
  } catch (error) {
    setMessage("Could not load the session: " + error.message, true);
  }
}

async function deleteSelectedSession() {
  const id = ui.sessionSelect.value;
  if (!id || id === activeSession?.session_id) return;
  if (!window.confirm("Delete this session and all of its saved packets and intervals?")) return;
  try {
    await sessionStore.deleteSession(id);
    if (viewData?.session?.session_id === id) {
      viewData = null;
      followLive = false;
    }
    await refreshSessions();
    render();
    setMessage("Session deleted from local storage.");
  } catch (error) {
    setMessage("Could not delete the session: " + error.message, true);
  }
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type: type + ";charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCurrent(kind) {
  if (!viewData?.session) return;
  const session = viewData.session;
  try {
    if (kind === "rr") downloadFile("rr.csv", serializeIntervalsCsv(viewData.intervals, session), "text/csv");
    if (kind === "packets") downloadFile("packets.csv", serializePacketsCsv(viewData.packets, session), "text/csv");
    if (kind === "session") downloadFile("session.json", serializeSessionJson(session), "application/json");
    if (kind === "summary") {
      const summary = summarizeSession(session, viewData.intervals, session.quality_parameters || DEFAULT_QUALITY_PARAMETERS);
      downloadFile("summary.json", serializeSummaryJson(summary), "application/json");
    }
    setMessage("Export generated locally; no data was sent.");
  } catch (error) {
    setMessage("Could not prepare the export: " + error.message, true);
  }
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function qualityDescription(record) {
  return (record.quality_flags || []).map(flag => qualityLabels[flag] || flag).join("; ");
}

function renderRecent() {
  ui.rrList.replaceChildren();
  const recent = viewData?.intervals?.slice(-20).reverse() || [];
  if (recent.length === 0) {
    const item = document.createElement("li");
    item.textContent = viewData ? "This session does not contain RR intervals yet." : "Waiting for a session.";
    ui.rrList.append(item);
  } else {
    for (const record of recent) {
      const item = document.createElement("li");
      const reason = qualityDescription(record);
      if (reason) item.classList.add("suspect");
      item.textContent = "#" + record.sequence + " · " + formatNumber(record.rr_ms, 6) +
        " ms · " + record.rr_raw_1024 + " ticks · packet " + record.packet_id +
        (reason ? " · review: " + reason : " · unflagged");
      ui.rrList.append(item);
    }
  }

  ui.packetList.replaceChildren();
  const packets = viewData?.packets?.slice(-12).reverse() || [];
  if (packets.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No notifications.";
    ui.packetList.append(item);
  } else {
    for (const packet of packets) {
      const item = document.createElement("li");
      if (packet.parse_status !== "valid") item.classList.add("suspect");
      item.textContent = "Packet " + packet.packet_id + " · " + packet.notification_received_at +
        " · BPM " + (packet.sensor_bpm ?? "—") + " · flags " + (packet.flags ?? "—") +
        " · RR " + packet.rr_count + " · " + (parseStatusLabels[packet.parse_status] || packet.parse_status) +
        " · hex " + packet.raw_payload +
        (packet.parse_errors?.length ? " · " + packet.parse_errors.map(code => qualityLabels[code] || code).join(", ") : "");
      ui.packetList.append(item);
    }
  }

  ui.eventList.replaceChildren();
  const events = viewData?.session?.events?.slice(-16).reverse() || [];
  if (events.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No events.";
    ui.eventList.append(item);
  } else {
    for (const event of events) {
      const item = document.createElement("li");
      const reason = event.details?.reason;
      const reasons = event.details?.reasons;
      item.textContent = event.timestamp_utc + " · " + (eventLabels[event.type] || event.type) +
        (reason ? " · " + (reasonLabels[reason] || qualityLabels[reason] || reason) : "") +
        (reasons ? " · " + reasons.map(code => qualityLabels[code] || code).join(", ") : "");
      ui.eventList.append(item);
    }
  }
}

function addMetric(grid, label, value, unit = "") {
  const card = document.createElement("div");
  card.className = "metric";
  const title = document.createElement("div");
  title.className = "metric-label";
  title.textContent = label;
  const content = document.createElement("div");
  content.className = "metric-value";
  content.textContent = value;
  const suffix = document.createElement("small");
  suffix.textContent = unit ? " " + unit : "";
  content.append(suffix);
  card.append(title, content);
  grid.append(card);
}

function makeMetricSection(title, stats, description) {
  const section = document.createElement("section");
  section.className = "metric-segment";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const note = document.createElement("p");
  note.className = "metric-meta";
  note.textContent = description;
  const grid = document.createElement("div");
  grid.className = "metric-grid";
  addMetric(grid, "Valid RR", String(stats.valid_intervals), "intervals");
  addMetric(grid, "Flagged intervals", String(stats.suspect_count) + " · " + formatNumber(stats.suspect_percent, 1), "%");
  addMetric(grid, "Mean heart rate", formatNumber(stats.mean_bpm), "bpm");
  addMetric(grid, "Minimum / maximum heart rate", formatNumber(stats.min_bpm) + " / " + formatNumber(stats.max_bpm), "bpm");
  addMetric(grid, "Mean RR", formatNumber(stats.mean_rr_ms), "ms");
  addMetric(grid, "Minimum / maximum RR", formatNumber(stats.min_rr_ms) + " / " + formatNumber(stats.max_rr_ms), "ms");
  addMetric(grid, "Sample SDNN", formatNumber(stats.sdnn_ms), "ms");
  addMetric(grid, "RMSSD", formatNumber(stats.rmssd_ms), "ms");
  addMetric(grid, "Sample SDSD", formatNumber(stats.sdsd_ms), "ms");
  addMetric(grid, "pNN50", formatNumber(stats.pnn50_percent, 1), "% of pairs");
  section.append(heading, note, grid);
  if (stats.excluded_count > 0) {
    const excluded = document.createElement("p");
    excluded.className = "metric-meta";
    const reasons = [...new Set(stats.excluded.flatMap(item => item.quality_flags))];
    excluded.textContent = "Excluded: " + stats.excluded_count + " intervals; rules: " +
      reasons.map(flag => qualityLabels[flag] || flag).join(", ");
    section.append(excluded);
  }
  return section;
}

function selectedSegmentIds(records, knownIds = null) {
  const all = [...(knownIds || new Set(records.map(record => record.segment_id)))].sort((a, b) => a - b);
  const value = ui.segmentSelect.value;
  return value === "all" ? all : all.filter(id => id === Number(value));
}

function updateSegmentOptions(records, knownIds = null) {
  const previous = ui.segmentSelect.value || "all";
  const ids = [...(knownIds || new Set(records.map(record => record.segment_id)))].sort((a, b) => a - b);
  const values = ["all", ...ids.map(String)];
  const existing = Array.from(ui.segmentSelect.options, option => option.value);
  if (values.join(",") === existing.join(",")) return;
  ui.segmentSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All segments";
  ui.segmentSelect.append(allOption);
  for (const id of ids) {
    const option = document.createElement("option");
    option.value = String(id);
    option.textContent = "Segment " + id;
    ui.segmentSelect.append(option);
  }
  ui.segmentSelect.value = values.includes(previous) ? previous : "all";
}

function windowSeconds() {
  return ui.windowSelect.value === "full" ? null : Number(ui.windowSelect.value);
}

function recordsForChart(records) {
  const segmentFilter = ui.segmentSelect.value;
  const duration = windowSeconds();
  const selected = segmentFilter === "all"
    ? records
    : records.filter(record => record.segment_id === Number(segmentFilter));
  if (duration === null || selected.length === 0) return selected;
  const ends = new Map();
  for (const record of selected) ends.set(record.segment_id, Math.max(ends.get(record.segment_id) || 0, record.segment_elapsed_ms));
  return selected.filter(record => record.segment_elapsed_ms > Math.max(0, ends.get(record.segment_id) - duration * 1000));
}

function windowDescription(seconds, durationSeconds) {
  if (seconds === null) return "Full segment · " + formatNumber(durationSeconds, 1) + " s estimated.";
  return "" + seconds + " s window · " + formatNumber(durationSeconds, 1) + " s covered by RR intervals.";
}

function renderAnalysis(records, knownIds) {
  ui.analysisCards.replaceChildren();
  const ids = selectedSegmentIds(records, knownIds);
  const bySegment = new Map();
  for (const record of records) appendToGroup(bySegment, record.segment_id, record);
  const seconds = windowSeconds();
  const metricRecords = [];

  for (const segmentId of ids) {
    const selected = selectWindow(bySegment.get(segmentId) || [], segmentId, seconds);
    metricRecords.push(...selected);
    const durationSeconds = selected.reduce(
      (sum, record) => sum + (Number.isFinite(record.rr_ms) && record.rr_ms > 0 ? record.rr_ms : 0), 0
    ) / 1000;
    const original = analyzeIntervals(selected);
    const processed = analyzeIntervals(selected, { exclude_suspicious: true });
    const protocol = viewData?.session?.protocol;
    const isRestProtocol = ["rest_seated_spontaneous", "rest_supine_spontaneous"].includes(protocol) &&
      viewData.session.respiration === "spontaneous";
    const completeFiveMinutes = seconds === 300 && durationSeconds >= 300;
    let method = windowDescription(seconds, durationSeconds);
    if (completeFiveMinutes && isRestProtocol) {
      method += " A 5-minute spontaneous-breathing rest protocol was recorded; this is not clinical validation.";
    } else if (seconds === 300) {
      method += " Incomplete or non-baseline window: exploratory analysis.";
    } else if (protocol === "deep_or_guided_breathing" || viewData?.session?.respiration === "deep" ||
        viewData?.session?.respiration === "guided") {
      method += " Deep/guided breathing; do not compare as a spontaneous-breathing baseline.";
    } else {
      method += " Exploratory metric; windows of different durations are not automatically comparable.";
    }
    const label = viewData?.session ? protocolLabel(viewData.session) : "Session";
    ui.analysisCards.append(makeMetricSection(
      "Segment " + segmentId + " · " + label + " · original metrics",
      original,
      method + " All positive received RR values, with flags retained."
    ));
    ui.analysisCards.append(makeMetricSection(
      "Segment " + segmentId + " · processed metrics",
      processed,
      "Rules applied: RR > 0, within configured thresholds, and without quality flags. Values are not interpolated."
    ));
  }

  if (ids.length === 0) {
    const note = document.createElement("p");
    note.className = "metric-meta";
    note.textContent = "Useful-phase RR intervals are required to calculate these metrics.";
    ui.analysisCards.append(note);
  }
  const poincare = calculatePoincare(metricRecords, { exclude_suspicious: true });
  ui.poincareStats.textContent = "SD1: " + formatNumber(poincare.sd1_ms) + " ms · SD2: " +
    formatNumber(poincare.sd2_ms) + " ms · " + poincare.pair_count +
    " clean pairs from the same segment.";
  drawPoincare(ui.poincareChart, metricRecords, calculatePoincare(metricRecords).pairs);
  ui.analysisNote.textContent = "Exploratory results by segment. Mean heart rate is the mean of 60,000 / RR; pNN50 uses valid adjacent RR pairs in the same segment. These metrics do not diagnose disease.";
}

function render(force = true) {
  updateControls();
  if (!viewData) {
    updateSegmentOptions([], new Set());
    ui.sampleCount.textContent = "0 intervals";
    drawTachogram(ui.rrChart, [], "all", null);
    drawDerivedBpm(ui.derivedBpmChart, [], "all", null);
    drawSensorBpm(ui.sensorBpmChart, [], "all");
    renderAnalysis([], new Set());
    renderRecent();
    return;
  }
  const isLiveView = Boolean(activeSession && activeData === viewData);
  const seconds = windowSeconds();
  const now = performance.now();
  if (isLiveView && seconds === null && !force && now - lastFullActiveRender < 5000) {
    ui.sampleCount.textContent = activeSession.interval_count + " intervals · " + activeSession.packet_count + " notifications";
    renderRecent();
    return;
  }

  const intervalGroups = isLiveView && seconds !== null ? activeData.recentBySegment : viewData.bySegment;
  const packetGroups = isLiveView && seconds !== null ? activeData.recentPacketsBySegment : viewData.packetsBySegment;
  const knownIds = new Set([...viewData.bySegment.keys(), ...viewData.packetsBySegment.keys()]);
  updateSegmentOptions([], knownIds);
  const ids = selectedSegmentIds([], knownIds);
  const records = ids.flatMap(id => intervalGroups.get(id) || []);
  const packets = ids.flatMap(id => packetGroups.get(id) || []);
  if (isLiveView && seconds === null) lastFullActiveRender = now;
  ui.sampleCount.textContent = (isLiveView ? activeSession.interval_count : viewData.intervals.length) +
    " intervals · " + (isLiveView ? activeSession.packet_count : viewData.packets.length) + " notifications";

  const visibleRecords = recordsForChart(records);
  const visiblePackets = packets;
  drawTachogram(ui.rrChart, visibleRecords, "all", null);
  drawDerivedBpm(ui.derivedBpmChart, visibleRecords, "all", null);
  drawSensorBpm(ui.sensorBpmChart, visiblePackets, "all");
  renderAnalysis(records, new Set(ids));
  renderRecent();
}

function exportClick(kind) {
  return () => exportCurrent(kind);
}

ui.protocol.addEventListener("change", applyProtocolDefaults);
ui.connect.addEventListener("click", connectSensor);
ui.start.addEventListener("click", startSession);
ui.pause.addEventListener("click", togglePause);
ui.finish.addEventListener("click", () => finishSession("user"));
ui.disconnect.addEventListener("click", disconnectSensor);
ui.refreshSessions.addEventListener("click", refreshSessions);
ui.loadSession.addEventListener("click", loadSelectedSession);
ui.deleteSession.addEventListener("click", deleteSelectedSession);
ui.sessionSelect.addEventListener("change", updateControls);
ui.segmentSelect.addEventListener("change", () => render(true));
ui.windowSelect.addEventListener("change", () => render(true));
ui.exportRR.addEventListener("click", exportClick("rr"));
ui.exportPackets.addEventListener("click", exportClick("packets"));
ui.exportSession.addEventListener("click", exportClick("session"));
ui.exportSummary.addEventListener("click", exportClick("summary"));
window.addEventListener("resize", () => render(true));

async function initialize() {
  try {
    sessionStore = await createSessionStore();
    setStorageStatus("Local IndexedDB available");
    await refreshSessions();
  } catch (error) {
    setStorageStatus("IndexedDB unavailable", true);
    setMessage("A session cannot start without persistent storage: " + error.message, true);
  }
  updateControls();
  render();
}

void initialize();
