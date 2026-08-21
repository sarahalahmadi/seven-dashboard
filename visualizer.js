/* ============================================================
   SEVEN — Visualizer
   A generic dashboard reader. Drop in any Excel/CSV, and it
   detects the columns on its own and renders KPI cards, bar
   charts, and donuts named after whatever is actually in the
   file. No "critical path" concepts are assumed anywhere.
   ============================================================ */

const PALETTE = ["#0CAFBF", "#F19A27", "#E01A4F", "#1560A8", "#17B978", "#9B5DE5", "#F15BB5", "#00BBF9"];

const state = {
  fileName: "",
  boardTitle: "",
  sheetNames: [],
  activeSheet: "",
  columns: [],       // [{name, type, values, numericValues, filled}]
  rows: [],          // array of objects
  groupBy: null,     // column name currently grouped by
  measure: null,     // numeric column name currently measured (or "__count__")
};

/* Turn "Sales_Report_Q3 (2).xlsx" into "Sales Report Q3" for a sensible default name. */
function prettifyFileName(name) {
  return name
    .replace(/\.(xlsx|xls|csv)$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TITLE_STORE = "seven-visualizer-titles";
function savedTitleFor(fileName) {
  try { return (JSON.parse(localStorage.getItem(TITLE_STORE) || "{}"))[fileName] || null; }
  catch { return null; }
}
function saveTitleFor(fileName, title) {
  try {
    const all = JSON.parse(localStorage.getItem(TITLE_STORE) || "{}");
    if (title && title.trim()) all[fileName] = title.trim(); else delete all[fileName];
    localStorage.setItem(TITLE_STORE, JSON.stringify(all));
  } catch { /* storage unavailable — title just won't persist */ }
}

/* ---------- helpers ---------- */
const fmt = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return (Math.round(n * 100) / 100).toLocaleString();
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const colorFor = (i) => PALETTE[i % PALETTE.length];

function detectType(values, header) {
  let nums = 0, dates = 0, nonEmpty = 0;
  const looksDatey = header && /date|day|start|end|deadline|due|opening/i.test(header);
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    nonEmpty++;
    if (typeof v === "number" && isFinite(v)) {
      // Excel stores dates as serial numbers, typically ~40000–50000 for 2010–2036.
      // If the column name hints at a date and the values sit in that band, treat as date.
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

function toNumber(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

/* ---------- read a workbook / csv ---------- */
function loadWorkbook(wb) {
  state.sheetNames = wb.SheetNames.slice();
  // Prefer the sheet with the most rows of data.
  let best = wb.SheetNames[0], bestRows = -1;
  for (const name of wb.SheetNames) {
    const json = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
    if (json.length > bestRows) { bestRows = json.length; best = name; }
  }
  state.wb = wb;
  selectSheet(best);
}

function selectSheet(name) {
  state.activeSheet = name;
  const ws = state.wb.Sheets[name];
  // Find the header row: the first row where most cells are non-empty text.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  let headerIdx = 0, bestScore = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i];
    const filled = row.filter((c) => c !== "" && c !== null).length;
    const textish = row.filter((c) => typeof c === "string" && c.trim() !== "").length;
    const score = filled + textish;
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  const headers = aoa[headerIdx].map((h, i) => (h === "" || h === null) ? `Column ${i + 1}` : String(h).trim());
  const dataRows = aoa.slice(headerIdx + 1).filter((r) => r.some((c) => c !== "" && c !== null));

  const rows = dataRows.map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] === undefined ? "" : r[i]; });
    return o;
  });

  const columns = headers.map((name) => {
    const values = rows.map((r) => r[name]);
    const type = detectType(values, name);
    return {
      name,
      type,
      values,
      numericValues: type === "number" ? values.map(toNumber) : null,
      filled: values.filter((v) => v !== "" && v !== null && v !== undefined).length,
    };
  }).filter((c) => c.filled > 0);

  state.columns = columns;
  state.rows = rows;

  // Auto-pick a sensible default group-by (a text column with a moderate number of
  // distinct values) and a default measure (first numeric column, else row count).
  const textCols = columns.filter((c) => c.type === "text");
  let group = null, bestGroupScore = Infinity;
  for (const c of textCols) {
    const distinct = new Set(c.values.map((v) => String(v))).size;
    if (distinct < 2 || distinct > 40) continue;
    const score = Math.abs(distinct - 7); // prefer ~7 categories
    if (score < bestGroupScore) { bestGroupScore = score; group = c.name; }
  }
  state.groupBy = group || (textCols[0] && textCols[0].name) || null;

  const numCols = columns.filter((c) => c.type === "number");
  const preferred = numCols.find((c) => /item|count|total|qty|quantity|amount|value|revenue|sales/i.test(c.name));
  state.measure = preferred ? preferred.name : (numCols.length ? "__count__" : "__count__");

  render();
}

/* ---------- aggregation ---------- */
function aggregate(groupCol, measureCol) {
  const map = new Map();
  for (const r of state.rows) {
    const key = (r[groupCol] === "" || r[groupCol] === null || r[groupCol] === undefined) ? "(blank)" : String(r[groupCol]);
    if (!map.has(key)) map.set(key, { key, count: 0, sum: 0 });
    const bucket = map.get(key);
    bucket.count++;
    if (measureCol && measureCol !== "__count__") {
      const n = toNumber(r[measureCol]);
      if (n !== null) bucket.sum += n;
    }
  }
  const arr = [...map.values()];
  const useCount = !measureCol || measureCol === "__count__";
  arr.forEach((b) => { b.value = useCount ? b.count : b.sum; });
  arr.sort((a, b) => b.value - a.value);
  return arr;
}

/* ---------- render ---------- */
function render() {
  renderMeta();
  renderControls();
  renderKpis();
  renderMainChart();
  renderCategoryDonuts();
  renderNumericSummary();
  renderTablePreview();
}

function renderMeta() {
  document.getElementById("file-name").textContent = state.fileName || "—";
  const titleInput = document.getElementById("board-title");
  titleInput.value = state.boardTitle || "";
  document.title = state.boardTitle ? `${state.boardTitle} — SEVEN Visualizer` : "SEVEN — Visualizer";
  const sheetSel = document.getElementById("sheet-select");
  if (state.sheetNames.length > 1) {
    sheetSel.style.display = "";
    sheetSel.innerHTML = state.sheetNames.map((s) => `<option ${s === state.activeSheet ? "selected" : ""}>${esc(s)}</option>`).join("");
  } else {
    sheetSel.style.display = "none";
  }
  document.getElementById("empty-state").style.display = "none";
  document.getElementById("board").style.display = "";
}

function renderControls() {
  const textCols = state.columns.filter((c) => c.type === "text" || c.type === "date");
  const numCols = state.columns.filter((c) => c.type === "number");
  const gSel = document.getElementById("group-select");
  gSel.innerHTML = textCols.map((c) => `<option ${c.name === state.groupBy ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const mSel = document.getElementById("measure-select");
  mSel.innerHTML = `<option value="__count__" ${state.measure === "__count__" ? "selected" : ""}>Count of rows</option>` +
    numCols.map((c) => `<option value="${esc(c.name)}" ${c.name === state.measure ? "selected" : ""}>Sum of ${esc(c.name)}</option>`).join("");
}

function renderKpis() {
  const numCols = state.columns.filter((c) => c.type === "number");
  const cards = [{ label: "Total rows", value: state.rows.length, accent: "var(--teal)" }];
  numCols.slice(0, 5).forEach((c, i) => {
    const sum = c.numericValues.reduce((a, b) => a + (b || 0), 0);
    cards.push({ label: `Total ${c.name}`, value: sum, accent: colorFor(i + 1) });
  });
  document.getElementById("kpi-grid").innerHTML = cards.map((c) => `
    <div class="kpi-card" style="--accent:${c.accent}">
      <div class="label">${esc(c.label)}</div>
      <div class="value mono">${fmt(c.value)}</div>
    </div>`).join("");
}

function renderMainChart() {
  const data = aggregate(state.groupBy, state.measure);
  const title = state.measure === "__count__"
    ? `Rows per ${state.groupBy}`
    : `${state.measure} per ${state.groupBy}`;
  document.getElementById("main-chart-title").textContent = title;

  const top = data.slice(0, 14);
  const max = Math.max(...top.map((d) => d.value), 1);
  document.getElementById("main-chart").innerHTML = top.map((d, i) => {
    const h = Math.max((d.value / max) * 200, 3);
    return `<div class="v-bar-col" title="${esc(d.key)}: ${fmt(d.value)}">
      <div class="v-bar-val mono">${fmt(d.value)}</div>
      <div class="v-bar" style="height:${h}px; background:${colorFor(i)};"></div>
      <div class="v-bar-label">${esc(d.key)}</div>
    </div>`;
  }).join("");
}

function renderCategoryDonuts() {
  // For up to 3 text columns with a small number of categories, draw a donut.
  const cats = state.columns
    .filter((c) => c.type === "text")
    .map((c) => ({ c, distinct: new Set(c.values.map((v) => String(v))).size }))
    .filter((x) => x.distinct >= 2 && x.distinct <= 8)
    .sort((a, b) => a.distinct - b.distinct)
    .slice(0, 3);

  const wrap = document.getElementById("donut-row");
  if (!cats.length) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
  wrap.style.display = "";

  wrap.innerHTML = cats.map(({ c }) => {
    const data = aggregate(c.name, "__count__");
    const total = data.reduce((a, b) => a + b.value, 0);
    let acc = 0;
    const R = 52, C = 2 * Math.PI * R;
    const segs = data.map((d, i) => {
      const frac = d.value / total;
      const dash = `${frac * C} ${C}`;
      const off = -acc * C;
      acc += frac;
      return `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${colorFor(i)}" stroke-width="16" stroke-dasharray="${dash}" stroke-dashoffset="${off}" transform="rotate(-90 70 70)"></circle>`;
    }).join("");
    const legend = data.slice(0, 8).map((d, i) =>
      `<div class="v-leg"><span class="v-sw" style="background:${colorFor(i)}"></span>${esc(d.key)} <span class="mono v-leg-n">${fmt(d.value)}</span></div>`
    ).join("");
    return `<div class="panel v-donut-panel">
      <h3 class="display v-sub">${esc(c.name)}</h3>
      <div class="v-donut-body">
        <svg viewBox="0 0 140 140" width="140" height="140">${segs}
          <text x="70" y="66" text-anchor="middle" class="v-donut-num mono">${fmt(total)}</text>
          <text x="70" y="84" text-anchor="middle" class="v-donut-cap">total</text>
        </svg>
        <div class="v-legend">${legend}</div>
      </div>
    </div>`;
  }).join("");
}

function renderNumericSummary() {
  const numCols = state.columns.filter((c) => c.type === "number");
  const panel = document.getElementById("numeric-summary");
  if (!numCols.length) { panel.closest(".panel").style.display = "none"; return; }
  panel.closest(".panel").style.display = "";
  panel.innerHTML = `<table class="v-table">
    <thead><tr><th>Column</th><th>Sum</th><th>Average</th><th>Min</th><th>Max</th></tr></thead>
    <tbody>${numCols.map((c) => {
      const vals = c.numericValues.filter((v) => v !== null);
      const sum = vals.reduce((a, b) => a + b, 0);
      const avg = vals.length ? sum / vals.length : 0;
      return `<tr><td class="v-td-name">${esc(c.name)}</td><td class="mono">${fmt(sum)}</td><td class="mono">${fmt(avg)}</td><td class="mono">${fmt(Math.min(...vals))}</td><td class="mono">${fmt(Math.max(...vals))}</td></tr>`;
    }).join("")}</tbody></table>`;
}

function renderTablePreview() {
  const cols = state.columns.slice(0, 8);
  const rows = state.rows.slice(0, 12);
  document.getElementById("table-preview").innerHTML = `<table class="v-table">
    <thead><tr>${cols.map((c) => `<th>${esc(c.name)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.name] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  document.getElementById("table-caption").textContent = `Showing ${rows.length} of ${state.rows.length} rows · ${state.columns.length} columns`;
}

/* ---------- file intake ---------- */
function handleFile(file) {
  state.fileName = file.name;
  state.boardTitle = savedTitleFor(file.name) || prettifyFileName(file.name);
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array", cellDates: false });
      loadWorkbook(wb);
    } catch (err) {
      alert("Sorry — I couldn't read that file. Make sure it's a valid .xlsx, .xls, or .csv.\n\n" + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ---------- wiring ---------- */
function initVisualizer() {
  const fileInput = document.getElementById("file-input");
  const drop = document.getElementById("drop-zone");
  document.getElementById("upload-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  document.getElementById("group-select").addEventListener("change", (e) => { state.groupBy = e.target.value; renderMainChart(); });
  document.getElementById("measure-select").addEventListener("change", (e) => { state.measure = e.target.value; renderMainChart(); renderKpis(); });
  document.getElementById("sheet-select").addEventListener("change", (e) => selectSheet(e.target.value));

  const titleInput = document.getElementById("board-title");
  titleInput.addEventListener("input", (e) => {
    state.boardTitle = e.target.value;
    document.title = state.boardTitle ? `${state.boardTitle} — SEVEN Visualizer` : "SEVEN — Visualizer";
  });
  titleInput.addEventListener("blur", () => saveTitleFor(state.fileName, state.boardTitle));
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") titleInput.blur(); });
}

document.addEventListener("DOMContentLoaded", initVisualizer);
