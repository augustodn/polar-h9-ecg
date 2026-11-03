const COLORS = {
  grid: "rgba(126, 164, 195, .16)",
  text: "#91a9bd",
  blue: "#58baff",
  pale: "#c4e8ff",
  red: "#ff8d82",
  gray: "#71879a",
  green: "#92dbad"
};

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width < 1 || rect.height < 1) return null;
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  return { context, width: rect.width, height: rect.height };
}

function drawGrid(context, width, height, xLabel, yLabel, minX, maxX, minY, maxY) {
  const box = { left: 52, right: 12, top: 14, bottom: 31 };
  const plotWidth = width - box.left - box.right;
  const plotHeight = height - box.top - box.bottom;
  context.font = "11px system-ui, sans-serif";
  context.lineWidth = 1;
  context.strokeStyle = COLORS.grid;
  context.fillStyle = COLORS.text;

  for (let tick = 0; tick <= 4; tick++) {
    const y = box.top + (plotHeight * tick) / 4;
    const value = maxY - ((maxY - minY) * tick) / 4;
    context.beginPath();
    context.moveTo(box.left, y);
    context.lineTo(width - box.right, y);
    context.stroke();
    context.fillText(String(Math.round(value)), 4, y + 4);
  }
  for (let tick = 0; tick <= 4; tick++) {
    const x = box.left + (plotWidth * tick) / 4;
    const value = minX + ((maxX - minX) * tick) / 4;
    context.beginPath();
    context.moveTo(x, box.top);
    context.lineTo(x, height - box.bottom);
    context.stroke();
    context.fillText(String(Math.round(value)), x - 8, height - 8);
  }
  context.fillText(yLabel, box.left, 11);
  context.fillText(xLabel, Math.max(box.left, width - 82), height - 8);

  return {
    ...box,
    plotWidth,
    plotHeight,
    x: value => box.left + ((value - minX) / (maxX - minX || 1)) * plotWidth,
    y: value => box.top + ((maxY - value) / (maxY - minY || 1)) * plotHeight
  };
}

function paddedRange(values, fallbackMin, fallbackMax) {
  if (values.length === 0) return [fallbackMin, fallbackMax];
  let low = Infinity, high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const pad = Math.max(1, (high - low) * 0.12);
  return [low - pad, high + pad];
}

function drawGroups(canvas, groups, options) {
  const setup = canvasContext(canvas);
  if (!setup) return;
  const { context, width, height } = setup;
  const points = groups.flatMap(group => group.points);
  if (points.length === 0) {
    context.fillStyle = COLORS.text;
    context.font = "13px system-ui, sans-serif";
    context.fillText("No data to plot yet.", 14, 28);
    return;
  }

  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y).filter(Number.isFinite);
  let minX = Infinity, maxX = -Infinity;
  for (const value of xs) {
    minX = Math.min(minX, value);
    maxX = Math.max(maxX, value);
  }
  if (minX === maxX) { minX -= 1; maxX += 1; }
  const [minY, maxY] = paddedRange(ys, options.fallbackMin, options.fallbackMax);
  const plot = drawGrid(context, width, height, options.xLabel, options.yLabel, minX, maxX, minY, maxY);

  for (const group of groups) {
    const visible = group.points.filter(point => Number.isFinite(point.y));
    if (visible.length === 0) continue;
    context.beginPath();
    context.lineWidth = 1.7;
    context.strokeStyle = options.color || COLORS.blue;
    visible.forEach((point, index) => {
      if (index === 0) context.moveTo(plot.x(point.x), plot.y(point.y));
      else context.lineTo(plot.x(point.x), plot.y(point.y));
    });
    context.stroke();
    for (const point of visible) {
      context.beginPath();
      context.fillStyle = point.suspect ? COLORS.red : (point.stabilization ? COLORS.gray : COLORS.pale);
      context.arc(plot.x(point.x), plot.y(point.y), point.suspect ? 3.2 : 2, 0, Math.PI * 2);
      context.fill();
    }
  }

  for (const separator of options.separators || []) {
    const x = plot.x(separator);
    context.save();
    context.setLineDash([4, 4]);
    context.strokeStyle = COLORS.amber || "#f0d49a";
    context.beginPath();
    context.moveTo(x, plot.top);
    context.lineTo(x, height - plot.bottom);
    context.stroke();
    context.restore();
  }
}

function filteredByWindow(records, windowSeconds) {
  if (windowSeconds === null) return records;
  const end = records.reduce((max, record) => Math.max(max, record.segment_elapsed_ms), 0);
  const start = Math.max(0, end - windowSeconds * 1000);
  return records.filter(record => record.segment_elapsed_ms > start);
}

function makeSegmentGroups(records, segmentFilter, windowSeconds, valueFor) {
  const bySegment = new Map();
  for (const record of records) {
    if (!bySegment.has(record.segment_id)) bySegment.set(record.segment_id, []);
    bySegment.get(record.segment_id).push(record);
  }
  const segmentIds = [...bySegment.keys()]
    .filter(id => segmentFilter === "all" || id === Number(segmentFilter))
    .sort((a, b) => a - b);
  const groups = [];
  const separators = [];
  let offset = 0;

  for (const segmentId of segmentIds) {
    let selected = bySegment.get(segmentId).sort((a, b) => a.sequence - b.sequence);
    if (selected.length === 0) continue;
    selected = filteredByWindow(selected, windowSeconds);
    if (selected.length === 0) continue;
    const firstElapsed = selected[0].segment_elapsed_ms / 1000;
    const lastElapsed = selected[selected.length - 1].segment_elapsed_ms / 1000;
    const points = selected.map(record => ({
      x: offset + (record.segment_elapsed_ms / 1000) - firstElapsed,
      y: valueFor(record),
      suspect: Array.isArray(record.quality_flags) && record.quality_flags.length > 0,
      stabilization: record.phase === "stabilization"
    }));
    if (groups.length > 0) separators.push(offset);
    groups.push({ segment_id: segmentId, points });
    offset += Math.max(0.001, lastElapsed - firstElapsed);
  }
  return { groups, separators };
}

export function drawTachogram(canvas, records, segmentFilter = "all", windowSeconds = null) {
  const data = makeSegmentGroups(records, segmentFilter, windowSeconds, record => record.rr_ms);
  drawGroups(canvas, data.groups, {
    separators: data.separators,
    xLabel: "time (s)",
    yLabel: "RR (ms)",
    fallbackMin: 400,
    fallbackMax: 1200,
    color: COLORS.blue
  });
}

export function drawDerivedBpm(canvas, records, segmentFilter = "all", windowSeconds = null) {
  const data = makeSegmentGroups(records, segmentFilter, windowSeconds, record => record.bpm_from_rr);
  drawGroups(canvas, data.groups, {
    separators: data.separators,
    xLabel: "active time (s)",
    yLabel: "BPM", fallbackMin: 40, fallbackMax: 120,
    color: COLORS.green
  });
}

export function drawSensorBpm(canvas, packets, segmentFilter = "all") {
  const bySegment = new Map();
  for (const packet of packets) {
    const segmentId = packet.segment_id ?? 1;
    if (!bySegment.has(segmentId)) bySegment.set(segmentId, []);
    bySegment.get(segmentId).push(packet);
  }
  const segmentIds = [...bySegment.keys()]
    .filter(id => segmentFilter === "all" || id === Number(segmentFilter))
    .sort((a, b) => a - b);
  const groups = segmentIds.map(segmentId => ({
    points: bySegment.get(segmentId).filter(packet => packet.sensor_bpm !== null)
      .map(packet => ({
        x: packet.packet_id,
        y: packet.sensor_bpm,
        suspect: packet.parse_status === "malformed",
        stabilization: packet.phase === "stabilization"
      }))
  }));
  drawGroups(canvas, groups, {
    xLabel: "BLE packet", yLabel: "BPM",
    fallbackMin: 40, fallbackMax: 120,
    color: "#d9ae65"
  });
}

export function drawPoincare(canvas, records, pairs) {
  const setup = canvasContext(canvas);
  if (!setup) return;
  const { context, width, height } = setup;
  const values = pairs.flatMap(pair => [pair.first.rr_ms, pair.second.rr_ms]);
  if (values.length === 0) {
    context.fillStyle = COLORS.text;
    context.font = "13px system-ui, sans-serif";
    context.fillText("Valid RR pairs from the same segment are required.", 14, 28);
    return;
  }
  const [minY, maxY] = paddedRange(values, 400, 1200);
  const plot = drawGrid(context, width, height, "RR(n) (ms)", "RR(n+1) (ms)", minY, maxY, minY, maxY);
  context.save();
  context.setLineDash([5, 4]);
  context.strokeStyle = COLORS.gray;
  context.beginPath();
  context.moveTo(plot.x(minY), plot.y(minY));
  context.lineTo(plot.x(maxY), plot.y(maxY));
  context.stroke();
  context.restore();

  for (const pair of pairs) {
    const suspect = pair.first.quality_flags?.length > 0 || pair.second.quality_flags?.length > 0;
    context.beginPath();
    context.fillStyle = suspect ? COLORS.red : COLORS.blue;
    context.arc(plot.x(pair.first.rr_ms), plot.y(pair.second.rr_ms), suspect ? 3 : 2.4, 0, Math.PI * 2);
    context.fill();
  }
}
