/* ============================================================
   SEVEN — Critical Path Dashboard
   Reads the "Critical Path" tab of the project's Excel tracker
   entirely in the browser (no server, no upload to any backend).
   ============================================================ */

const DEPT_ORDER = ["Discovery", "Hot Wheels", "FEC", "Bowling", "Play-Doh Attraction", "Cinema", "Complex"];
const DEPT_COLORS = ["#0CAFBF", "#F19A27", "#E01A4F", "#1560A8", "#17B978", "#B15CE0", "#E0C51A"];

const state = {
  rows: [],
  openingDate: null,
};

// ---------- Column header aliases (tolerant matching) ----------
const HEADER_MAP = {
  department: ["department"],
  label: ["label"],
  details: ["details"],
  startDate: ["start date"],
  endDate: ["end date"],
  status: ["status"],
  keyMilestone: ["key milestone (y/n)", "key milestone"],
  startOverdueText: ["start-time overdue", "start time overdue"],
  completionOverdueText: ["completion time overdue"],
  owner: ["owner"],
  items: ["items"],
  complete: ["complete"],
  inProgress: ["in-progress", "in progress"],
  startDelayed: ["starting date delayed"],
  completionOverdue: ["completion date overdue"],
  notStarted: ["not started yet"],
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findSheet(workbook) {
  // Prefer a sheet literally called "Critical Path"; otherwise the first
  // sheet that contains a "Department" + "Status" header pair.
  if (workbook.SheetNames.includes("Critical Path")) return "Critical Path";
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0, defval: "" });
    const header = (rows[0] || []).map(normalizeHeader);
    if (header.includes("department") && header.includes("status")) return name;
  }
  return workbook.SheetNames[0];
}

function buildColumnIndex(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const index = {};
  for (const [key, aliases] of Object.entries(HEADER_MAP)) {
    let found = -1;
    for (const alias of aliases) {
      const i = normalized.indexOf(alias);
      if (i !== -1) { found = i; break; }
    }
    index[key] = found;
  }
  return index;
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return new Date(d.y, d.m - 1, d.d);
  }
  const parsed = new Date(v);
  return isNaN(parsed) ? null : parsed;
}

function parseWorkbook(workbook) {
  const sheetName = findSheet(workbook);
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const idx = buildColumnIndex(raw[0] || []);

  const rows = [];
  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    if (!row || row.every((c) => c === "" || c === null || c === undefined)) continue;
    const dept = idx.department !== -1 ? String(row[idx.department] || "").trim() : "";
    if (!dept) continue;

    rows.push({
      department: dept,
      label: idx.label !== -1 ? row[idx.label] : "",
      startDate: idx.startDate !== -1 ? toDate(row[idx.startDate]) : null,
      endDate: idx.endDate !== -1 ? toDate(row[idx.endDate]) : null,
      status: idx.status !== -1 ? String(row[idx.status] || "").trim() : "",
      keyMilestone: idx.keyMilestone !== -1 ? String(row[idx.keyMilestone] || "").trim().toLowerCase() === "y" : false,
      owner: idx.owner !== -1 ? row[idx.owner] : "",
      items: idx.items !== -1 ? Number(row[idx.items]) || 0 : 1,
      complete: idx.complete !== -1 ? Number(row[idx.complete]) || 0 : (String(row[idx.status]).toLowerCase() === "completed" ? 1 : 0),
      inProgress: idx.inProgress !== -1 ? Number(row[idx.inProgress]) || 0 : (String(row[idx.status]).toLowerCase() === "in-progress" ? 1 : 0),
      startDelayed: idx.startDelayed !== -1 ? Number(row[idx.startDelayed]) || 0 : 0,
      completionOverdue: idx.completionOverdue !== -1 ? Number(row[idx.completionOverdue]) || 0 : 0,
      notStarted: idx.notStarted !== -1 ? Number(row[idx.notStarted]) || 0 : 0,
    });
  }
  return rows;
}

function findOpeningDate(workbook) {
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        if (normalizeHeader(row[c]) === "opening date") {
          const val = row[c + 1];
          const d = toDate(val);
          if (d) return d;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------
function aggregate(rows) {
  const totals = { items: 0, complete: 0, inProgress: 0, notStarted: 0, startDelayed: 0, completionOverdue: 0, milestones: 0 };
  const byDept = {};

  for (const r of rows) {
    totals.items += r.items;
    totals.complete += r.complete;
    totals.inProgress += r.inProgress;
    totals.startDelayed += r.startDelayed;
    totals.completionOverdue += r.completionOverdue;
    if (r.keyMilestone) totals.milestones++;

    if (!byDept[r.department]) {
      byDept[r.department] = {
        name: r.department, items: 0, complete: 0, inProgress: 0,
        startDelayed: 0, completionOverdue: 0, minStart: null, maxEnd: null,
        milestones: [],
      };
    }
    const d = byDept[r.department];
    d.items += r.items;
    d.complete += r.complete;
    d.inProgress += r.inProgress;
    d.startDelayed += r.startDelayed;
    d.completionOverdue += r.completionOverdue;
    if (r.startDate && (!d.minStart || r.startDate < d.minStart)) d.minStart = r.startDate;
    if (r.endDate && (!d.maxEnd || r.endDate > d.maxEnd)) d.maxEnd = r.endDate;
    if (r.keyMilestone) d.milestones.push({ label: r.label, date: r.endDate || r.startDate, dept: r.department });
  }

  totals.notStarted = totals.items - totals.complete - totals.inProgress;
  if (totals.notStarted < 0) totals.notStarted = 0;
  totals.tasks = rows.length;

  const depts = DEPT_ORDER.filter((d) => byDept[d]).concat(Object.keys(byDept).filter((d) => !DEPT_ORDER.includes(d)));
  const deptList = depts.map((name, i) => ({ ...byDept[name], color: DEPT_COLORS[i % DEPT_COLORS.length] }));

  return { totals, deptList };
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function fmt(n) { return Number(n || 0).toLocaleString(); }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }

function renderCountdown(openingDate) {
  const label = document.getElementById("opening-date-label");
  const num = document.getElementById("countdown-num");
  if (!openingDate) { label.textContent = "—"; num.textContent = "—"; return; }
  const today = new Date();
  const diffDays = Math.ceil((openingDate - today) / 86400000);
  num.textContent = diffDays >= 0 ? diffDays : 0;
  label.textContent = openingDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderTrack(deptList, totals) {
  const nodesEl = document.getElementById("track-nodes");
  const fillEl = document.getElementById("track-fill");
  const overallEl = document.getElementById("overall-pct");
  const overall = pct(totals.complete, totals.items);
  overallEl.textContent = overall + "%";
  fillEl.style.width = overall + "%";

  nodesEl.innerHTML = deptList.map((d) => {
    const p = pct(d.complete, d.items);
    const risk = d.startDelayed > 0 || d.completionOverdue > 0;
    const cls = p >= 100 ? "complete" : risk ? "risk" : "";
    return `<div class="track-node ${cls}">
      <div class="dot">${p}%</div>
      <div class="name">${d.name}</div>
      <div class="pct mono">${fmt(d.complete)}/${fmt(d.items)}</div>
    </div>`;
  }).join("") + `<div class="track-node" style="width:60px;"><div class="track-flag">🏁</div><div class="name">Opening</div></div>`;
}

function renderKPIs(totals) {
  const cards = [
    { label: "Total Tasks", value: totals.tasks, accent: "var(--teal)", icon: "📋" },
    { label: "Total Items", value: totals.items, accent: "var(--orange)", icon: "🗂" },
    { label: "Completed", value: totals.complete, accent: "var(--green)", icon: "✅" },
    { label: "In Progress", value: totals.inProgress, accent: "#50c5d1", icon: "⏱" },
    { label: "Not Started", value: totals.notStarted, accent: "var(--ink-faint)", icon: "⏳" },
    { label: "Start Delayed", value: totals.startDelayed, accent: "var(--magenta)", icon: "⚠️" },
    { label: "Completion Overdue", value: totals.completionOverdue, accent: "var(--orange)", icon: "⛔" },
  ];
  document.getElementById("kpi-grid").innerHTML = cards.map((c) => `
    <div class="kpi-card" style="--accent:${c.accent}">
      <div class="icon">${c.icon}</div>
      <div class="label">${c.label}</div>
      <div class="value mono">${fmt(c.value)}</div>
    </div>`).join("");
}

function renderBarChart(deptList) {
  const max = Math.max(...deptList.map((d) => d.items), 1);
  document.getElementById("bar-chart").innerHTML = deptList.map((d) => {
    const h = Math.max((d.items / max) * 180, 4);
    const completeH = d.items ? (d.complete / d.items) * h : 0;
    const progressH = d.items ? (d.inProgress / d.items) * h : 0;
    const remain = h - completeH - progressH;
    return `<div class="bar-col">
      <div class="bar-total mono">${fmt(d.items)}</div>
      <div class="bar-stack" style="height:${h}px;">
        <div class="bar-seg" style="height:${remain}px; background:var(--bg-raised);"></div>
        <div class="bar-seg" style="height:${progressH}px; background:var(--orange);"></div>
        <div class="bar-seg" style="height:${completeH}px; background:var(--green);"></div>
      </div>
      <div class="bar-label">${d.name}</div>
    </div>`;
  }).join("");
}

function renderMilestones(deptList, totals) {
  document.getElementById("milestone-count").textContent = totals.milestones;
  const all = deptList.flatMap((d) => d.milestones).filter((m) => m.date).sort((a, b) => a.date - b.date).slice(0, 8);
  document.getElementById("milestone-list").innerHTML = all.length ? all.map((m) => `
    <div class="milestone-item">
      <div><div>${m.label || "Milestone"}</div><div class="m-dept">${m.dept}</div></div>
      <div class="mono">${m.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
    </div>`).join("") : `<div style="font-size:12px; color:var(--ink-dim); padding:12px 0;">No key milestones flagged yet.</div>`;
}

function renderTimeline(deptList) {
  const dated = deptList.filter((d) => d.minStart && d.maxEnd);
  if (!dated.length) { document.getElementById("timeline").innerHTML = `<div style="font-size:12px;color:var(--ink-dim);">No dated tasks found.</div>`; return; }
  const min = new Date(Math.min(...dated.map((d) => d.minStart)));
  const max = new Date(Math.max(...dated.map((d) => d.maxEnd)));
  const span = Math.max(max - min, 86400000);

  const rowsHtml = deptList.map((d) => {
    if (!d.minStart || !d.maxEnd) {
      return `<div class="tl-row"><div class="tl-name">${d.name}</div><div class="tl-track"></div></div>`;
    }
    const left = ((d.minStart - min) / span) * 100;
    const width = Math.max(((d.maxEnd - d.minStart) / span) * 100, 1.5);
    return `<div class="tl-row">
      <div class="tl-name">${d.name}</div>
      <div class="tl-track"><div class="tl-bar" style="left:${left}%; width:${width}%; background:${d.color};"></div></div>
    </div>`;
  }).join("");

  const scaleLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const d = new Date(min.getTime() + span * f);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });

  document.getElementById("timeline").innerHTML = rowsHtml + `
    <div class="tl-scale"><div></div><div class="tl-scale-labels">${scaleLabels.map((l) => `<span>${l}</span>`).join("")}</div></div>`;
}

function drawDonut(svgId, segments, total) {
  const svg = document.getElementById(svgId);
  const r = 50, cx = 60, cy = 60, circumference = 2 * Math.PI * r;
  let offset = 0;
  let paths = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-raised)" stroke-width="14"/>`;
  segments.forEach((s) => {
    const frac = total > 0 ? s.value / total : 0;
    const len = frac * circumference;
    paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="14"
      stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" stroke-linecap="butt"/>`;
    offset += len;
  });
  svg.innerHTML = paths;
}

function renderDonuts(totals) {
  const statusSegs = [
    { label: "Completed", value: totals.complete, color: "var(--green)" },
    { label: "In Progress", value: totals.inProgress, color: "var(--orange)" },
    { label: "Not Started", value: totals.notStarted, color: "var(--ink-faint)" },
  ];
  drawDonut("donut-status", statusSegs.map(s=>({...s,color:s.color.replace('var(--green)','#17B978').replace('var(--orange)','#F19A27').replace('var(--ink-faint)','#545E72')})), totals.items);
  document.getElementById("donut-status-n").textContent = fmt(totals.items);
  document.getElementById("donut-status-legend").innerHTML = statusSegs.map((s) => `<div class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</div>`).join("");

  const onTimeStart = totals.tasks - totals.startDelayed;
  const startSegs = [
    { label: "On-Time", value: onTimeStart, color: "#0CAFBF" },
    { label: "Delayed", value: totals.startDelayed, color: "#E01A4F" },
  ];
  drawDonut("donut-start", startSegs, totals.tasks);
  document.getElementById("donut-start-n").textContent = fmt(totals.tasks);
  document.getElementById("donut-start-legend").innerHTML = startSegs.map((s) => `<div class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</div>`).join("");

  const onTimeComp = totals.tasks - totals.completionOverdue;
  const compSegs = [
    { label: "On-Time", value: onTimeComp, color: "#0CAFBF" },
    { label: "Overdue", value: totals.completionOverdue, color: "#F19A27" },
  ];
  drawDonut("donut-completion", compSegs, totals.tasks);
  document.getElementById("donut-completion-n").textContent = fmt(totals.tasks);
  document.getElementById("donut-completion-legend").innerHTML = compSegs.map((s) => `<div class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</div>`).join("");
}

function renderProgress(deptList) {
  document.getElementById("progress-list").innerHTML = deptList.map((d) => {
    const p = pct(d.complete, d.items);
    return `<div class="progress-row">
      <div class="p-top"><span class="p-name">${d.name}</span><span class="p-frac">${fmt(d.complete)}/${fmt(d.items)} (${p}%)</span></div>
      <div class="p-track"><div class="p-fill" style="width:${p}%; background:${d.color};"></div></div>
    </div>`;
  }).join("");
}

function renderAll() {
  const { totals, deptList } = aggregate(state.rows);
  document.getElementById("empty-state").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("reset-btn").style.display = "inline-block";
  renderCountdown(state.openingDate);
  renderTrack(deptList, totals);
  renderKPIs(totals);
  renderBarChart(deptList);
  renderMilestones(deptList, totals);
  renderTimeline(deptList);
  renderDonuts(totals);
  renderProgress(deptList);
}

// ---------------------------------------------------------------
// File handling
// ---------------------------------------------------------------
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array", cellDates: false });
      state.rows = parseWorkbook(workbook);
      state.openingDate = findOpeningDate(workbook);
      if (!state.rows.length) {
        alert("Couldn't find any task rows. Make sure the file has a 'Critical Path' tab with a Department column.");
        return;
      }
      renderAll();
    } catch (err) {
      console.error(err);
      alert("Something went wrong reading that file. Please check it's the correct Excel export.");
    }
  };
  reader.readAsArrayBuffer(file);
}

const fileInput = document.getElementById("file-input");
document.getElementById("upload-btn").addEventListener("click", () => fileInput.click());
document.getElementById("empty-upload-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

document.getElementById("reset-btn").addEventListener("click", () => {
  state.rows = []; state.openingDate = null;
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("empty-state").style.display = "block";
  document.getElementById("reset-btn").style.display = "none";
});

// Drag & drop on the empty state
const emptyState = document.getElementById("empty-state");
["dragover", "dragenter"].forEach((evt) => emptyState.addEventListener(evt, (e) => { e.preventDefault(); emptyState.classList.add("drag"); }));
["dragleave", "drop"].forEach((evt) => emptyState.addEventListener(evt, (e) => { e.preventDefault(); emptyState.classList.remove("drag"); }));
emptyState.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
