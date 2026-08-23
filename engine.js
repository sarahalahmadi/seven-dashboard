/* ============================================================
   SEVEN — Dashboard Engine (shared)
   Column typing, aggregation, chart drawing, the chart editor,
   and layout persistence. Used by BOTH the Visualizer (file
   upload) and the Live page (SeaTable). Pages supply the data;
   this file turns it into an editable dashboard.
   ============================================================ */

const PALETTE = ["#0CAFBF", "#F19A27", "#E01A4F", "#1560A8", "#17B978", "#9B5DE5", "#F15BB5", "#00BBF9", "#FEE440", "#FB5607"];
const colorFor = (i) => PALETTE[i % PALETTE.length];

const CHART_TYPES = [
  { id: "kpi",      name: "KPI number" },
  { id: "bar",      name: "Bar (vertical)" },
  { id: "hbar",     name: "Bar (horizontal)" },
  { id: "stacked",  name: "Stacked bar" },
  { id: "line",     name: "Line" },
  { id: "area",     name: "Area" },
  { id: "donut",    name: "Donut" },
  { id: "pie",      name: "Pie" },
  { id: "progress", name: "Progress bars" },
  { id: "table",    name: "Table" },
];

const AGGS = [
  { id: "count", name: "Count of rows" },
  { id: "sum",   name: "Sum" },
  { id: "avg",   name: "Average" },
  { id: "min",   name: "Minimum" },
  { id: "max",   name: "Maximum" },
];

const state = {
  fileName: "",
  boardTitle: "",
  wb: null,
  sheetNames: [],
  activeSheet: "",
  columns: [],
  rows: [],
  charts: [],
  editingId: null,
};

/* ---------- helpers ---------- */
const fmt = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return (Math.round(n * 100) / 100).toLocaleString();
};
const fmtFull = (n) => (n === null || n === undefined || Number.isNaN(n)) ? "—" : (Math.round(n * 100) / 100).toLocaleString();
const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => "c" + Math.random().toString(36).slice(2, 9);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function excelSerialToDate(n) { return new Date(Date.UTC(1899, 11, 30) + n * 86400000); }

function toNumber(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

/* ---------- column typing ---------- */
function detectType(values, header) {
  let nums = 0, dates = 0, nonEmpty = 0;
  const looksDatey = header && /date|day|start|end|deadline|due|opening|month|year/i.test(header);
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    nonEmpty++;
    if (typeof v === "number" && isFinite(v)) {
      if (looksDatey && v > 30000 && v < 60000) { dates++; continue; }
      nums++; continue;
    }
    const s = String(v).trim();
    if (s !== "" && !isNaN(Number(s.replace(/,/g, "")))) { nums++; continue; }
    const d = Date.parse(s);
    if (!isNaN(d) && /[-/0-9]/.test(s) && s.length >= 6) dates++;
  }
  if (nonEmpty === 0) return "empty";
  if (dates / nonEmpty >= 0.6) return "date";
  if (nums / nonEmpty >= 0.8) return "number";
  return "text";
}

/* ---------- auto-generated starting dashboard ---------- */
function autoCharts() {
  const textCols = state.columns.filter((c) => c.type === "text");
  const numCols = state.columns.filter((c) => c.type === "number");
  const dateCols = state.columns.filter((c) => c.type === "date");
  const rowCount = state.rows.length || 1;

  // Identifier-like and free-text columns make useless categories or measures.
  const isIdLike = (c) => /serial|model|\bid\b|code|ref|number|uuid|phone|zip|postal/i.test(c.name);
  const isFreeText = (c) => /detail|description|note|comment|remark|label|title|name of|summary|provider|frequency|address/i.test(c.name);
  const isCategorical = (c) => c.distinct >= 2 && c.distinct <= 40
    && (c.distinct / rowCount) < 0.7
    && (c.filled / rowCount) > 0.5
    && !isIdLike(c) && !isFreeText(c);

  const groupCandidates = textCols.filter(isCategorical)
    .sort((a, b) => Math.abs(a.distinct - 6) - Math.abs(b.distinct - 6));
  // The label column (a name/title-like first column) makes the best per-row bar even if every value is unique.
  const labelCol = textCols[0] ? textCols[0].name : null;
  const mainGroup = groupCandidates[0] ? groupCandidates[0].name : labelCol;
  const secondGroup = groupCandidates.find((c) => c.name !== mainGroup);
  // A column with 2–4 distinct values (Yes/No, status flags) is the clearest possible donut.
  const flagCol = textCols.find((c) => c.distinct >= 2 && c.distinct <= 4 && (c.filled / rowCount) > 0.6 && !isIdLike(c));
  const smallCat = flagCol ? flagCol.name : (groupCandidates.find((c) => c.distinct <= 8) || {}).name || null;

  // Rank numeric columns instead of picking just one: real quantities first
  // (counts, totals, amounts), computed/id-like numbers last.
  const isMeaningfulNum = (c) => !isIdLike(c);
  const nameScore = (c) => /missing|overdue|open|pending|risk|delay|issue|fault|defect/i.test(c.name) ? 3
    : /item|count|total|qty|quantity|amount|value|revenue|sales|budget|hours|tier|score/i.test(c.name) ? 2 : 1;
  const rankedNums = numCols.filter(isMeaningfulNum)
    .sort((a, b) => nameScore(b) - nameScore(a));
  const measures = rankedNums.slice(0, 2).map((c) => c.name);
  const primaryMeasure = measures[0] || null;

  const charts = [];

  // KPIs: row count plus up to 3 real totals.
  charts.push({ id: uid(), type: "kpi", title: "Total rows", agg: "count", measure: null, groupBy: null, width: "quarter" });
  rankedNums.slice(0, 3).forEach((c) => {
    charts.push({ id: uid(), type: "kpi", title: "Total " + c.name, agg: "sum", measure: c.name, groupBy: null, width: "quarter" });
  });

  // A small, easily-scanned table (10 or fewer rows) reads better as a
  // per-row bar than as a chart with a dozen tiny wedges or dense stacks.
  const smallTable = rowCount <= 15;

  measures.forEach((measure, i) => {
    const byCol = (i === 0 && labelCol && labelCol !== mainGroup) ? labelCol : mainGroup;
    if (!byCol) return;
    charts.push({
      id: uid(), type: smallTable ? "hbar" : "bar",
      title: measure + " by " + byCol,
      agg: "sum", measure: measure, groupBy: byCol, width: "full", limit: 14, sort: "desc",
    });
  });

  if (smallCat) {
    charts.push({ id: uid(), type: "donut", title: "Breakdown by " + smallCat, agg: "count", measure: null, groupBy: smallCat, width: "half", limit: 8, sort: "desc" });
  }
  if (secondGroup) {
    charts.push({
      id: uid(), type: smallTable ? "progress" : "hbar",
      title: primaryMeasure ? primaryMeasure + " by " + secondGroup.name : "Rows by " + secondGroup.name,
      agg: primaryMeasure ? "sum" : "count", measure: primaryMeasure, groupBy: secondGroup.name, width: "half", limit: 10, sort: "desc",
    });
  }
  if (dateCols.length && primaryMeasure) {
    charts.push({ id: uid(), type: "area", title: primaryMeasure + " over time", agg: "sum", measure: primaryMeasure, groupBy: dateCols[0].name, width: "full", limit: 24, sort: "date" });
  }
  if (mainGroup) {
    charts.push({ id: uid(), type: "table", title: "Summary table", agg: primaryMeasure ? "sum" : "count", measure: primaryMeasure, groupBy: mainGroup, width: "full", limit: 12, sort: "desc" });
  }
  return charts;
}

/* ---------- aggregation ---------- */
function computeValue(agg, vals, count) {
  if (agg === "count") return count;
  if (!vals.length) return 0;
  const sum = vals.reduce((a, b) => a + b, 0);
  if (agg === "sum") return sum;
  if (agg === "avg") return sum / vals.length;
  if (agg === "min") return Math.min.apply(null, vals);
  if (agg === "max") return Math.max.apply(null, vals);
  return sum;
}

function colType(name) {
  const c = state.columns.find((x) => x.name === name);
  return c ? c.type : "text";
}

function groupKey(row, col) {
  const v = row[col];
  if (v === "" || v === null || v === undefined) return "(blank)";
  if (colType(col) === "date") {
    let d = null;
    if (typeof v === "number") d = excelSerialToDate(v);
    else { const t = Date.parse(String(v)); if (!isNaN(t)) d = new Date(t); }
    if (d && !isNaN(d.getTime())) return d.toISOString().slice(0, 7);
  }
  return String(v);
}

function aggregate(chart) {
  const map = new Map();
  for (const r of state.rows) {
    const key = chart.groupBy ? groupKey(r, chart.groupBy) : "All";
    if (!map.has(key)) map.set(key, { key: key, vals: [], count: 0 });
    const b = map.get(key);
    b.count++;
    if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) b.vals.push(n); }
  }
  let arr = Array.from(map.values()).map((b) => ({ key: b.key, value: computeValue(chart.agg, b.vals, b.count) }));
  const isDate = chart.groupBy && colType(chart.groupBy) === "date";
  if (chart.sort === "date" || isDate) arr.sort((a, b) => a.key.localeCompare(b.key));
  else if (chart.sort === "asc") arr.sort((a, b) => a.value - b.value);
  else if (chart.sort === "label") arr.sort((a, b) => a.key.localeCompare(b.key));
  else arr.sort((a, b) => b.value - a.value);
  if (chart.limit && arr.length > chart.limit) arr = arr.slice(0, chart.limit);
  return arr;
}

function aggregateStacked(chart) {
  const cats = new Map(), serSet = new Set();
  for (const r of state.rows) {
    const k = groupKey(r, chart.groupBy);
    const s = chart.series ? groupKey(r, chart.series) : "All";
    serSet.add(s);
    if (!cats.has(k)) cats.set(k, new Map());
    const m = cats.get(k);
    if (!m.has(s)) m.set(s, { vals: [], count: 0 });
    const b = m.get(s);
    b.count++;
    if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) b.vals.push(n); }
  }
  const seriesNames = Array.from(serSet).slice(0, 10);
  let rows = Array.from(cats.entries()).map(function (e) {
    const k = e[0], m = e[1];
    const parts = seriesNames.map((s) => { const b = m.get(s); return b ? computeValue(chart.agg, b.vals, b.count) : 0; });
    return { key: k, parts: parts, total: parts.reduce((a, b) => a + b, 0) };
  });
  if (colType(chart.groupBy) === "date") rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.total - a.total);
  if (chart.limit) rows = rows.slice(0, chart.limit);
  return { seriesNames: seriesNames, rows: rows };
}

function measureLabel(chart) {
  if (chart.agg === "count") return "Count";
  const a = AGGS.find((x) => x.id === chart.agg);
  return (a ? a.name : "Sum") + " of " + (chart.measure || "—");
}

/* ---------- drawing ---------- */
function axisTicks(max) {
  const out = [];
  for (let i = 0; i <= 4; i++) out.push((max / 4) * i);
  return out;
}

function svgWrap(W, H, inner) {
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="chart-svg">' + inner + '</svg>';
}

function drawBar(chart, W, H) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const P = { l: 56, r: 14, t: 20, b: 54 };
  const max = niceMax(Math.max.apply(null, data.map((d) => d.value).concat([0])));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = iw / data.length;
  const bw = Math.min(step * 0.62, 56);

  const grid = axisTicks(max).map(function (t) {
    const y = P.t + ih - (t / max) * ih;
    return '<line x1="' + P.l + '" y1="' + y + '" x2="' + (W - P.r) + '" y2="' + y + '" class="grid"/>' +
           '<text x="' + (P.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="axis-lbl">' + fmt(t) + '</text>';
  }).join("");

  const bars = data.map(function (d, i) {
    const h = max ? (d.value / max) * ih : 0;
    const x = P.l + step * i + (step - bw) / 2;
    const y = P.t + ih - h;
    return '<g><title>' + esc(d.key) + ': ' + fmtFull(d.value) + '</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(h, 1) + '" rx="4" fill="' + colorFor(i) + '"/>' +
      '<text x="' + (x + bw / 2) + '" y="' + (y - 6) + '" text-anchor="middle" class="val-lbl">' + fmt(d.value) + '</text>' +
      '<text x="' + (x + bw / 2) + '" y="' + (H - P.b + 18) + '" text-anchor="middle" class="cat-lbl">' + esc(clip(d.key, 12)) + '</text></g>';
  }).join("");

  return svgWrap(W, H, grid + bars);
}

function drawHBar(chart, W, H) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const P = { l: 124, r: 54, t: 12, b: 16 };
  const max = Math.max.apply(null, data.map((d) => d.value).concat([1]));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = ih / data.length;
  const bh = Math.min(step * 0.66, 26);

  const bars = data.map(function (d, i) {
    const w = (d.value / max) * iw;
    const y = P.t + step * i + (step - bh) / 2;
    return '<g><title>' + esc(d.key) + ': ' + fmtFull(d.value) + '</title>' +
      '<text x="' + (P.l - 10) + '" y="' + (y + bh / 2 + 4) + '" text-anchor="end" class="cat-lbl">' + esc(clip(d.key, 18)) + '</text>' +
      '<rect x="' + P.l + '" y="' + y + '" width="' + Math.max(w, 1) + '" height="' + bh + '" rx="4" fill="' + colorFor(i) + '"/>' +
      '<text x="' + (P.l + w + 8) + '" y="' + (y + bh / 2 + 4) + '" class="val-lbl">' + fmt(d.value) + '</text></g>';
  }).join("");
  return svgWrap(W, H, bars);
}

function drawLineArea(chart, W, H, filled) {
  const data = aggregate(chart);
  if (data.length < 2) return '<div class="chart-empty">Needs at least 2 points — try a different Group by</div>';
  const P = { l: 56, r: 16, t: 20, b: 46 };
  const max = niceMax(Math.max.apply(null, data.map((d) => d.value).concat([0])));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const xAt = (i) => P.l + (iw / (data.length - 1)) * i;
  const yAt = (v) => P.t + ih - (max ? (v / max) * ih : 0);

  const grid = axisTicks(max).map(function (t) {
    const y = yAt(t);
    return '<line x1="' + P.l + '" y1="' + y + '" x2="' + (W - P.r) + '" y2="' + y + '" class="grid"/>' +
           '<text x="' + (P.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="axis-lbl">' + fmt(t) + '</text>';
  }).join("");

  const pts = data.map((d, i) => xAt(i) + "," + yAt(d.value)).join(" ");
  const area = filled ? '<polygon points="' + P.l + ',' + (P.t + ih) + ' ' + pts + ' ' + xAt(data.length - 1) + ',' + (P.t + ih) + '" fill="' + PALETTE[0] + '" opacity="0.18"/>' : "";
  const line = '<polyline points="' + pts + '" fill="none" stroke="' + PALETTE[0] + '" stroke-width="2.5" stroke-linejoin="round"/>';
  const dots = data.map((d, i) => '<circle cx="' + xAt(i) + '" cy="' + yAt(d.value) + '" r="3.5" fill="' + PALETTE[0] + '"><title>' + esc(d.key) + ': ' + fmtFull(d.value) + '</title></circle>').join("");

  const every = Math.ceil(data.length / 8);
  const xl = data.map((d, i) => i % every === 0
    ? '<text x="' + xAt(i) + '" y="' + (H - P.b + 20) + '" text-anchor="middle" class="cat-lbl">' + esc(clip(d.key, 10)) + '</text>' : "").join("");

  return svgWrap(W, H, grid + area + line + dots + xl);
}

function polar(cx, cy, r, a) { const rad = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]; }
function arcPath(cx, cy, rO, rI, a0, a1) {
  const large = (a1 - a0) > 180 ? 1 : 0;
  const p0 = polar(cx, cy, rO, a0), p1 = polar(cx, cy, rO, a1);
  if (rI <= 0) return 'M ' + cx + ' ' + cy + ' L ' + p0[0] + ' ' + p0[1] + ' A ' + rO + ' ' + rO + ' 0 ' + large + ' 1 ' + p1[0] + ' ' + p1[1] + ' Z';
  const p2 = polar(cx, cy, rI, a1), p3 = polar(cx, cy, rI, a0);
  return 'M ' + p0[0] + ' ' + p0[1] + ' A ' + rO + ' ' + rO + ' 0 ' + large + ' 1 ' + p1[0] + ' ' + p1[1] +
         ' L ' + p2[0] + ' ' + p2[1] + ' A ' + rI + ' ' + rI + ' 0 ' + large + ' 0 ' + p3[0] + ' ' + p3[1] + ' Z';
}

function drawPieDonut(chart, W, H, isDonut) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const rO = Math.min(H / 2 - 14, 92), rI = isDonut ? rO * 0.6 : 0;
  const cx = rO + 24, cy = H / 2;
  let acc = 0;
  const slices = data.map(function (d, i) {
    const a0 = (acc / total) * 360; acc += d.value;
    const a1 = (acc / total) * 360;
    return '<path d="' + arcPath(cx, cy, rO, rI, a0, Math.max(a1, a0 + 0.01)) + '" fill="' + colorFor(i) +
      '" stroke="var(--bg-panel)" stroke-width="1.5"><title>' + esc(d.key) + ': ' + fmtFull(d.value) + ' (' + Math.round(d.value / total * 100) + '%)</title></path>';
  }).join("");
  const center = isDonut
    ? '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" class="donut-num">' + fmt(total) + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" class="donut-cap">TOTAL</text>' : "";
  const lx = cx + rO + 24;
  const legend = data.slice(0, 9).map(function (d, i) {
    const y = 26 + i * 21;
    return '<g><rect x="' + lx + '" y="' + (y - 9) + '" width="11" height="11" rx="3" fill="' + colorFor(i) + '"/>' +
      '<text x="' + (lx + 18) + '" y="' + y + '" class="cat-lbl">' + esc(clip(d.key, 16)) + '</text>' +
      '<text x="' + (W - 12) + '" y="' + y + '" text-anchor="end" class="val-lbl">' + fmt(d.value) + '</text></g>';
  }).join("");
  return svgWrap(W, H, slices + center + legend);
}

function drawStacked(chart, W, H) {
  if (!chart.series) return '<div class="chart-empty">Choose a “Split by” column in Edit</div>';
  const res = aggregateStacked(chart);
  if (!res.rows.length) return '<div class="chart-empty">No data</div>';
  const P = { l: 56, r: 14, t: 20, b: 72 };
  const max = niceMax(Math.max.apply(null, res.rows.map((r) => r.total).concat([0])));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = iw / res.rows.length, bw = Math.min(step * 0.62, 54);

  const grid = axisTicks(max).map(function (t) {
    const y = P.t + ih - (t / max) * ih;
    return '<line x1="' + P.l + '" y1="' + y + '" x2="' + (W - P.r) + '" y2="' + y + '" class="grid"/>' +
           '<text x="' + (P.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="axis-lbl">' + fmt(t) + '</text>';
  }).join("");

  const bars = res.rows.map(function (r, i) {
    const x = P.l + step * i + (step - bw) / 2;
    let yCur = P.t + ih;
    const segs = r.parts.map(function (v, si) {
      const h = max ? (v / max) * ih : 0;
      yCur -= h;
      return h > 0.5 ? '<rect x="' + x + '" y="' + yCur + '" width="' + bw + '" height="' + h + '" fill="' + colorFor(si) +
        '"><title>' + esc(r.key) + ' · ' + esc(res.seriesNames[si]) + ': ' + fmtFull(v) + '</title></rect>' : "";
    }).join("");
    return segs + '<text x="' + (x + bw / 2) + '" y="' + (H - P.b + 18) + '" text-anchor="middle" class="cat-lbl">' + esc(clip(r.key, 11)) + '</text>';
  }).join("");

  const legend = res.seriesNames.slice(0, 6).map(function (s, i) {
    const lx = P.l + (i % 3) * ((W - P.l) / 3), ly = H - 28 + Math.floor(i / 3) * 16;
    return '<g><rect x="' + lx + '" y="' + (ly - 8) + '" width="10" height="10" rx="2.5" fill="' + colorFor(i) + '"/>' +
      '<text x="' + (lx + 15) + '" y="' + ly + '" class="cat-lbl">' + esc(clip(s, 14)) + '</text></g>';
  }).join("");

  return svgWrap(W, H, grid + bars + legend);
}

function drawProgress(chart) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const max = Math.max.apply(null, data.map((d) => d.value).concat([1]));
  return '<div class="prog-list">' + data.map(function (d, i) {
    const p = (d.value / max) * 100;
    return '<div class="prog-row"><div class="prog-top"><span class="prog-name">' + esc(d.key) + '</span>' +
      '<span class="prog-val mono">' + fmtFull(d.value) + '</span></div>' +
      '<div class="prog-track"><div class="prog-fill" style="width:' + p + '%; background:' + colorFor(i) + '"></div></div></div>';
  }).join("") + '</div>';
}

function drawTable(chart) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  return '<div class="tbl-scroll"><table class="v-table"><thead><tr><th>' + esc(chart.groupBy || "Group") +
    '</th><th>' + esc(measureLabel(chart)) + '</th><th>Share</th></tr></thead><tbody>' +
    data.map((d) => '<tr><td>' + esc(d.key) + '</td><td class="mono">' + fmtFull(d.value) +
      '</td><td class="mono dimmed">' + Math.round(d.value / total * 100) + '%</td></tr>').join("") +
    '</tbody></table></div>';
}

function drawKpi(chart) {
  const vals = [];
  let count = 0;
  for (const r of state.rows) {
    count++;
    if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) vals.push(n); }
  }
  const v = computeValue(chart.agg, vals, count);
  return '<div class="kpi-body"><div class="kpi-num mono">' + fmt(v) + '</div><div class="kpi-cap">' + esc(measureLabel(chart)) + '</div></div>';
}

function drawChart(chart) {
  const W = chart.width === "full" ? 900 : 440;
  const H = 300;
  switch (chart.type) {
    case "kpi": return drawKpi(chart);
    case "bar": return drawBar(chart, W, H);
    case "hbar": return drawHBar(chart, W, H);
    case "line": return drawLineArea(chart, W, H, false);
    case "area": return drawLineArea(chart, W, H, true);
    case "donut": return drawPieDonut(chart, W, H, true);
    case "pie": return drawPieDonut(chart, W, H, false);
    case "stacked": return drawStacked(chart, W, H);
    case "progress": return drawProgress(chart);
    case "table": return drawTable(chart);
    default: return '<div class="chart-empty">Unknown chart type</div>';
  }
}

/* ---------- board rendering ---------- */
function renderAll() {
  const empty = document.getElementById("empty-state");
  if (empty) empty.style.display = "none";
  const board = document.getElementById("board");
  if (board) board.style.display = "";

  const src = document.getElementById("file-name");
  if (src) src.textContent = state.fileName || "—";

  const ti = document.getElementById("board-title");
  if (ti) ti.value = state.boardTitle || "";
  document.title = state.boardTitle ? state.boardTitle + " — SEVEN" : "SEVEN";

  // Sheet picker only exists on the file-upload page.
  const sheetSel = document.getElementById("sheet-select");
  const wrap = document.getElementById("sheet-wrap");
  if (sheetSel && wrap) {
    if (state.sheetNames.length > 1) {
      wrap.style.display = "";
      sheetSel.innerHTML = state.sheetNames.map(function (x) {
        return '<option ' + (x === state.activeSheet ? "selected" : "") + '>' + esc(x) + '</option>';
      }).join("");
    } else wrap.style.display = "none";
  }

  renderCharts();
}

function renderCharts() {
  const grid = document.getElementById("chart-grid");
  if (!state.charts.length) {
    grid.innerHTML = '<div class="no-charts">No charts yet — click <b>+ Add chart</b> to start building.</div>';
    saveLayout();
    return;
  }
  grid.innerHTML = state.charts.map(function (c, i) {
    return '<section class="chart-card w-' + (c.width || "half") + '" data-id="' + c.id + '">' +
      '<header class="chart-head"><h3 class="chart-title display">' + esc(c.title || "Untitled") + '</h3>' +
      '<div class="chart-tools">' +
        '<button class="tool" data-act="left" data-id="' + c.id + '" title="Move left"' + (i === 0 ? " disabled" : "") + '>◀</button>' +
        '<button class="tool" data-act="right" data-id="' + c.id + '" title="Move right"' + (i === state.charts.length - 1 ? " disabled" : "") + '>▶</button>' +
        '<button class="tool" data-act="dup" data-id="' + c.id + '" title="Duplicate">⧉</button>' +
        '<button class="tool" data-act="edit" data-id="' + c.id + '" title="Edit">✎</button>' +
        '<button class="tool danger" data-act="del" data-id="' + c.id + '" title="Remove">✕</button>' +
      '</div></header>' +
      '<div class="chart-body">' + drawChart(c) + '</div></section>';
  }).join("");

  Array.prototype.forEach.call(grid.querySelectorAll("button.tool"), function (b) {
    b.addEventListener("click", function () { chartAction(b.getAttribute("data-act"), b.getAttribute("data-id")); });
  });
  saveLayout();
}

function chartAction(act, id) {
  const i = state.charts.findIndex((c) => c.id === id);
  if (i < 0) return;
  if (act === "del") {
    if (!confirm("Remove this chart?")) return;
    state.charts.splice(i, 1);
  } else if (act === "dup") {
    const copy = JSON.parse(JSON.stringify(state.charts[i]));
    copy.id = uid(); copy.title = copy.title + " (copy)";
    state.charts.splice(i + 1, 0, copy);
  } else if (act === "left" && i > 0) {
    const t = state.charts[i - 1]; state.charts[i - 1] = state.charts[i]; state.charts[i] = t;
  } else if (act === "right" && i < state.charts.length - 1) {
    const t = state.charts[i + 1]; state.charts[i + 1] = state.charts[i]; state.charts[i] = t;
  } else if (act === "edit") {
    return openEditor(id);
  }
  renderCharts();
}

/* ---------- editor ---------- */
function openEditor(id) {
  state.editingId = id;
  const firstText = state.columns.find((x) => x.type === "text");
  const c = id ? state.charts.find((x) => x.id === id) : {
    type: "bar", title: "", agg: "count", measure: null,
    groupBy: firstText ? firstText.name : null, series: null, width: "half", limit: 12, sort: "desc",
  };
  const catCols = state.columns.filter((x) => x.type === "text" || x.type === "date");
  const numCols = state.columns.filter((x) => x.type === "number");
  const sel = (a, b) => (a === b ? " selected" : "");

  document.getElementById("editor-heading").textContent = id ? "Edit chart" : "Add chart";
  document.getElementById("editor-form").innerHTML =
    '<label class="fld"><span>Chart type</span><select id="f-type">' +
      CHART_TYPES.map((t) => '<option value="' + t.id + '"' + sel(t.id, c.type) + '>' + t.name + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Title</span><input id="f-title" value="' + esc(c.title || "") + '" placeholder="Leave blank to auto-name" /></label>' +
    '<label class="fld"><span>Group by (category)</span><select id="f-group"><option value="">— none —</option>' +
      catCols.map((x) => '<option' + sel(x.name, c.groupBy) + '>' + esc(x.name) + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Split by <em>(stacked bar only)</em></span><select id="f-series"><option value="">— none —</option>' +
      catCols.map((x) => '<option' + sel(x.name, c.series) + '>' + esc(x.name) + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Measure</span><select id="f-agg">' +
      AGGS.map((a) => '<option value="' + a.id + '"' + sel(a.id, c.agg) + '>' + a.name + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Of column</span><select id="f-measure"><option value="">— none —</option>' +
      numCols.map((x) => '<option' + sel(x.name, c.measure) + '>' + esc(x.name) + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Size</span><select id="f-width">' +
      '<option value="quarter"' + sel("quarter", c.width) + '>Small — quarter width</option>' +
      '<option value="half"' + sel("half", c.width) + '>Medium — half width</option>' +
      '<option value="full"' + sel("full", c.width) + '>Large — full width</option></select></label>' +
    '<label class="fld"><span>Show top</span><input id="f-limit" type="number" min="1" max="50" value="' + (c.limit || 12) + '" /></label>' +
    '<label class="fld"><span>Sort</span><select id="f-sort">' +
      '<option value="desc"' + sel("desc", c.sort) + '>Highest first</option>' +
      '<option value="asc"' + sel("asc", c.sort) + '>Lowest first</option>' +
      '<option value="label"' + sel("label", c.sort) + '>By name (A–Z)</option>' +
      '<option value="date"' + sel("date", c.sort) + '>By date / time</option></select></label>';

  document.getElementById("editor-modal").classList.add("open");
}

function saveEditor() {
  const g = (id) => document.getElementById(id).value;
  const chart = {
    id: state.editingId || uid(),
    type: g("f-type"),
    title: g("f-title").trim(),
    groupBy: g("f-group") || null,
    series: g("f-series") || null,
    agg: g("f-agg"),
    measure: g("f-measure") || null,
    width: g("f-width"),
    limit: Math.max(1, parseInt(g("f-limit"), 10) || 12),
    sort: g("f-sort"),
  };
  if (chart.agg !== "count" && !chart.measure) {
    alert('Choose a column under "Of column", or set Measure to "Count of rows".');
    return;
  }
  if (chart.type !== "kpi" && !chart.groupBy) {
    alert('Choose a column under "Group by" for this chart type.');
    return;
  }
  if (!chart.title) {
    chart.title = chart.type === "kpi" ? measureLabel(chart)
      : (chart.agg === "count" ? "Count" : (chart.measure || "Value")) + " by " + chart.groupBy;
  }
  const i = state.charts.findIndex((c) => c.id === state.editingId);
  if (i >= 0) state.charts[i] = chart; else state.charts.push(chart);
  closeEditor();
  renderCharts();
}

function closeEditor() {
  state.editingId = null;
  document.getElementById("editor-modal").classList.remove("open");
}

/* ---------- persistence ---------- */
const STORE = "seven-visualizer-layouts";
const layoutKey = () => state.fileName + "::" + state.activeSheet;
function allLayouts() { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (e) { return {}; } }
function saveLayout() {
  try {
    const all = allLayouts();
    all[layoutKey()] = { title: state.boardTitle, charts: state.charts };
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch (e) { /* storage unavailable */ }
}
function loadLayout() { return allLayouts()[layoutKey()] || null; }

function prettifyFileName(name) {
  return name.replace(/\.(xlsx|xls|csv)$/i, "").replace(/\s*\(\d+\)\s*$/, "")
    .replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}


/* ---------- shared data ingestion ----------
   Pages hand the engine an array of plain row objects. The engine
   works out column types, then either restores a saved layout for
   this source or generates a fresh starting dashboard.            */
/* Some tools (SeaTable's Excel export among them) store attachment or
   linked-record cells as a stringified object, e.g. "{'name': 'file.pdf',
   'url': '...'}" or a JSON array of those. Shown raw, that's unreadable
   noise on a chart. Detect it and reduce it to something a chart can use:
   a short, human label plus a count when there's more than one. */
function cleanCellValue(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return v;

  const names = [];
  const re = /'name'\s*:\s*'([^']*)'|"name"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) names.push(m[1] || m[2]);

  if (names.length === 1) return names[0];
  if (names.length > 1) return names.length + " files";
  // Not a recognisable name-bearing structure — at least don't dump raw braces.
  if (s[0] === "{" || s[0] === "[") return s.length > 1 ? "Attached" : v;
  return v;
}

function cleanRow(row) {
  const out = {};
  Object.keys(row).forEach(function (k) { out[k] = cleanCellValue(row[k]); });
  return out;
}

function ingestRows(rows, opts) {
  opts = opts || {};
  state.rows = (rows || []).map(cleanRow);

  const headers = [];
  state.rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (headers.indexOf(k) < 0) headers.push(k); });
  });

  state.columns = headers.map(function (nm) {
    const values = state.rows.map(function (r) { return r[nm]; });
    const type = detectType(values, nm);
    const distinct = type === "text" ? new Set(values.map(function (v) { return String(v); })).size : null;
    return { name: nm, type: type, distinct: distinct, filled: values.filter(function (v) { return v !== "" && v !== null && v !== undefined; }).length };
  }).filter(function (c) { return c.filled > 0; });

  const saved = opts.restoreLayout === false ? null : loadLayout();
  if (saved && saved.charts && saved.charts.length) {
    state.charts = saved.charts;
    if (saved.title) state.boardTitle = saved.title;
  } else {
    state.charts = autoCharts();
  }
  renderAll();
}

/* ---------- shared UI wiring ----------
   Everything both pages share: the editor modal, add/reset/print
   buttons, and the editable dashboard title.                      */
function initEditorUI() {
  const add = document.getElementById("add-chart-btn");
  if (add) add.addEventListener("click", function () { openEditor(null); });

  const reset = document.getElementById("reset-btn");
  if (reset) reset.addEventListener("click", function () {
    if (!confirm("Rebuild the automatic dashboard? Your custom charts will be replaced.")) return;
    state.charts = autoCharts();
    renderCharts();
  });

  const print = document.getElementById("print-btn");
  if (print) print.addEventListener("click", function () { window.print(); });

  document.getElementById("editor-save").addEventListener("click", saveEditor);
  document.getElementById("editor-cancel").addEventListener("click", closeEditor);
  document.getElementById("editor-modal").addEventListener("click", function (e) {
    if (e.target.id === "editor-modal") closeEditor();
  });

  const titleInput = document.getElementById("board-title");
  if (titleInput) {
    titleInput.addEventListener("input", function (e) {
      state.boardTitle = e.target.value;
      document.title = state.boardTitle ? state.boardTitle + " — SEVEN" : "SEVEN";
    });
    titleInput.addEventListener("blur", saveLayout);
    titleInput.addEventListener("keydown", function (e) { if (e.key === "Enter") titleInput.blur(); });
  }
}
