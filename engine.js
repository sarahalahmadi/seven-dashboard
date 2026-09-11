/* ============================================================
   SEVEN Dashboard Engine (shared)
   Column typing, aggregation, chart drawing, the chart editor,
   and layout persistence. Used by BOTH the Visualizer (file
   upload) and the Live page (SeaTable). Pages supply the data;
   this file turns it into an editable dashboard.
   ============================================================ */

/* Categorical order sampled from logo.png and checked for colour-blind
   separation + contrast on white. Assign in order; never shuffle. */
const PALETTE = ["#0092AC", "#D6004E", "#C98A00", "#00874A", "#1E5A99", "#E4572E", "#7A4DA0", "#0E6E7F", "#A03C6B", "#6E7B12"];
const colorFor = (i) => PALETTE[i % PALETTE.length];
/* Single-series magnitude charts (vertical bars, horizontal bars, progress
   rows) use ONE hue. Colour there would encode rank, not identity. The
   categorical palette is reserved for charts where each mark is a category. */
const SERIES_HUE = PALETTE[0];

const CHART_TYPES = [
  { id: "kpi",       name: "KPI number" },
  { id: "gauge",     name: "Gauge (value vs target)" },
  { id: "countdown", name: "Countdown (nearest date)" },
  { id: "deadlines", name: "Deadlines list" },
  { id: "bar",       name: "Bar (vertical)" },
  { id: "hbar",      name: "Bar (horizontal)" },
  { id: "stacked",   name: "Stacked bar" },
  { id: "combo",     name: "Combo (bars + line)" },
  { id: "line",      name: "Line" },
  { id: "area",      name: "Area" },
  { id: "donut",     name: "Donut" },
  { id: "pie",       name: "Pie" },
  { id: "treemap",   name: "Treemap" },
  { id: "funnel",    name: "Funnel" },
  { id: "waterfall", name: "Waterfall" },
  { id: "heatmap",   name: "Heatmap table" },
  { id: "progress",  name: "Progress bars" },
  { id: "table",     name: "Table" },
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
  activeTemplate: null,
  // Cross-filter: click a bar, slice, or row on any chart and every other
  // chart narrows to match. This is the interaction that makes a dashboard feel
  // like Power BI rather than a static report. null = no filter.
  filter: null,   // { col, key }
  profile: {},    // per-column statistics from the analysis engine
  insights: [],   // ranked plain-language findings
};

/* Rows the charts should currently draw from: everything, or just the
   rows matching the active cross-filter. */
function activeRows() {
  if (!state.filter) return state.rows;
  const f = state.filter;
  return state.rows.filter(function (r) { return groupKey(r, f.col) === f.key; });
}

/* ---------- helpers ---------- */
const fmt = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return (Math.round(n * 100) / 100).toLocaleString();
};
const fmtFull = (n) => (n === null || n === undefined || Number.isNaN(n)) ? "" : (Math.round(n * 100) / 100).toLocaleString();
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

/* Accepts an Excel serial number, an ISO string (from a JSON snapshot),
   or any string the browser's date parser understands. Returns null if
   it can't make sense of the value, rather than a garbage date. */
function parseAnyDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) return excelSerialToDate(v);
    return null;
  }
  const t = Date.parse(String(v));
  return isNaN(t) ? null : new Date(t);
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

/* Turns text like "Daily-Weekly-Monthly-Annual" into a day count, using
   the LONGEST cycle mentioned (that's the one worth a countdown; daily
   or weekly upkeep isn't a "deadline" the way an annual recert is).
   Typo-tolerant ("Quartely") since real-world sheets aren't always clean. */
function frequencyToDays(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (/annual|yearly/.test(s)) return 365;
  if (/semi[\s-]?annual|bi[\s-]?annual/.test(s)) return 182;
  if (/quart/.test(s)) return 90;
  if (/month/.test(s)) return 30;
  if (/week/.test(s)) return 7;
  if (/daily|\bday\b/.test(s)) return 1;
  return null;
}

function isTruthyFlag(v) {
  return /^(yes|y|true|1)$/i.test(String(v === null || v === undefined ? "" : v).trim());
}

/* When a file has no real due-date column but does have a maintenance or
   certification FREQUENCY column ("Daily-Weekly-Monthly-Annual"), build
   a rough estimated due date from it, so the countdown has something to
   show. This is a guess, not a confirmed date. The column is named and
   labelled "(Estimated)" everywhere it appears so nobody mistakes it for
   verified compliance data. Skipped entirely if a real deadline column
   already exists. */
function estimateDueDatesFromFrequency(rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const deadlineNameRe = /due|expiry|expire|renew|recert|deadline|next[\s_-]*(date|maintenance|service)|inspection|audit|valid[\s_-]*(until|to)/i;
  const hasRealDeadline = keys.some((k) => deadlineNameRe.test(k) && rows.some((r) => parseAnyDate(r[k]) !== null));
  if (hasRealDeadline) return;

  const freqKey = keys.find((k) => /frequen|interval|cycle|schedule/i.test(k) && rows.some((r) => frequencyToDays(r[k]) !== null));
  if (!freqKey) return;

  const flagKey = keys.find((k) => /recert|renew|due|overdue/i.test(k));
  const today = new Date();
  const colName = "Due Date (Estimated)";
  rows.forEach(function (r) {
    const days = frequencyToDays(r[freqKey]);
    if (days === null) { r[colName] = ""; return; }
    const overdue = flagKey && isTruthyFlag(r[flagKey]);
    const dt = overdue ? new Date(today.getTime() - 86400000) : new Date(today.getTime() + days * 86400000);
    r[colName] = dt.toISOString().slice(0, 10);
  });
}

/* One entry per row that has a usable date in `dateCol`, sorted soonest
   first (overdue items sort first of all, most-overdue at the very top). */
function computeDeadlines(chart) {
  const dateCol = chart.series;
  const labelCol = chart.groupBy;
  if (!dateCol) return [];
  const today = new Date();
  const items = [];
  activeRows().forEach(function (r) {
    const d = parseAnyDate(r[dateCol]);
    if (!d) return;
    const label = labelCol ? String(r[labelCol] || "(blank)") : "Item";
    items.push({ label: label, date: d, days: daysBetween(today, d) });
  });
  items.sort(function (a, b) { return a.days - b.days; });
  return items;
}

function toNumber(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

/* ---------- column typing ---------- */
function looksLikeDateString(s) {
  return (
    /^\d{4}-\d{1,2}-\d{1,2}/.test(s) ||                       // 2026-08-25
    /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(s) ||         // 25/08/2026, 08-25-26
    /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}$/.test(s) ||      // August 25, 2026 / Aug 25 2026
    /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}$/.test(s)           // 25 August 2026
  );
}

function detectType(values, header) {
  let nums = 0, dates = 0, nonEmpty = 0;
  const looksDatey = header && /date|day|start|end|deadline|due|opening|month|year|expiry|expire|renew|recert|valid|inspection|audit|issued|service|serviced|maintenance|calibrat|last |next |completed|scheduled|delivered|delivery|created|updated|modified|since|until/i.test(header);
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    nonEmpty++;
    if (typeof v === "number" && isFinite(v)) {
      if (looksDatey && v > 30000 && v < 60000) { dates++; continue; }
      nums++; continue;
    }
    const s = String(v).trim();
    if (s !== "" && !isNaN(Number(s.replace(/,/g, "")))) { nums++; continue; }
    // Date.parse is dangerously lenient (it happily reads "RK-2201" as a
    // date), so only trust it once the string actually looks date-shaped.
    if (looksLikeDateString(s)) {
      const d = Date.parse(s);
      if (!isNaN(d)) dates++;
    }
  }
  if (nonEmpty === 0) return "empty";
  if (dates / nonEmpty >= 0.6) return "date";
  if (nums / nonEmpty >= 0.8) {
    // A column of Excel date serials whose header we didn't recognise would
    // otherwise be summed into a nonsense total ("Total Last Service: 8.3M").
    // Whole numbers, all inside the 1954-2064 serial window, and not named
    // like money, is a date column no matter what the header says.
    const moneyish = header && /price|cost|amount|sales|revenue|value|salary|budget|spend|fee|total|qty|quantity|units|count|score|weight|size|id\b/i.test(header);
    if (!moneyish) {
      const numeric = values.filter((v) => typeof v === "number" && isFinite(v));
      const inWindow = numeric.filter((v) => Number.isInteger(v) && v > 20000 && v < 60000);
      if (numeric.length >= 5 && inWindow.length === numeric.length &&
          new Set(inWindow).size >= Math.min(8, numeric.length)) return "date";
    }
    return "number";
  }
  return "text";
}

/* ---------- auto-generated starting dashboard ---------- */
/* ============================================================
   Templates: curated chart sets for file shapes we recognize,
   instead of leaving everything to the generic auto-guess.
   Each template has a signature test and a builder. The first
   match wins; if nothing matches, autoCharts() below is the
   fallback for any file. Add new templates here as new file
   types are handed over (consumables, certifications, etc).
   ============================================================ */
const TEMPLATES = [
  {
    id: "maintenance",
    label: "Maintenance & Certification",
    // A maintenance/certification sheet: one row per attraction/asset,
    // with a missing-docs count and a recert flag or frequency column.
    matches: function (cols) {
      const names = cols.map((c) => c.name.toLowerCase());
      const has = (re) => names.some((n) => re.test(n));
      return has(/missing.*doc/) && has(/recert|certif/) && (has(/frequency|interval/) || has(/tier/));
    },
    build: function (cols) {
      const byName = (re) => cols.find((c) => re.test(c.name.toLowerCase()));
      const labelCol = byName(/name/) || cols.find((c) => c.type === "text");
      const missingCol = byName(/missing.*doc/);
      const tiersCol = byName(/tier/);
      const recertCol = byName(/recert/);
      const mfgCol = byName(/manufactur/);
      const certTypeCol = byName(/certificate.*type|cert.*type/);
      const statusCol = byName(/status/);
      const dateCol = cols.find((c) => c.type === "date" && /due|expiry|expire|next|renew|recert/i.test(c.name))
        || cols.find((c) => c.type === "date" && !/estimated/i.test(c.name) && !/last|previous|issued|start/i.test(c.name))
        || byName(/due|expiry|expire/);
      const estCol = byName(/estimated/);
      const deadlineCol = dateCol || estCol;

      const charts = [];
      if (deadlineCol) {
        charts.push({ id: uid(), type: "countdown", title: /^next\b/i.test(deadlineCol.name) ? deadlineCol.name : "Next " + deadlineCol.name, groupBy: labelCol && labelCol.name, series: deadlineCol.name, agg: "count", measure: null, width: "quarter" });
      }
      charts.push({ id: uid(), type: "kpi", title: "Total attractions", agg: "count", measure: null, groupBy: null, width: "quarter" });
      if (missingCol) charts.push({ id: uid(), type: "kpi", title: "Total missing docs", agg: "sum", measure: missingCol.name, groupBy: null, width: "quarter" });
      if (tiersCol) charts.push({ id: uid(), type: "kpi", title: "Total maintenance tiers", agg: "sum", measure: tiersCol.name, groupBy: null, width: "quarter" });

      if (missingCol && labelCol) {
        charts.push({ id: uid(), type: "hbar", title: missingCol.name + " by " + labelCol.name, agg: "sum", measure: missingCol.name, groupBy: labelCol.name, width: "full", limit: 14, sort: "desc" });
      }
      if (recertCol) {
        charts.push({ id: uid(), type: "donut", title: "Breakdown by " + recertCol.name, agg: "count", measure: null, groupBy: recertCol.name, width: "half", limit: 8, sort: "desc" });
      }
      if (mfgCol && tiersCol) {
        charts.push({ id: uid(), type: "hbar", title: tiersCol.name + " by " + mfgCol.name, agg: "sum", measure: tiersCol.name, groupBy: mfgCol.name, width: "half", limit: 10, sort: "desc" });
      }
      // A certification-flavored maintenance sheet, so surface the extra
      // certificate fields rather than leaving them unused.
      if (certTypeCol) {
        charts.push({ id: uid(), type: "donut", title: "Breakdown by " + certTypeCol.name, agg: "count", measure: null, groupBy: certTypeCol.name, width: "half", limit: 8, sort: "desc" });
      }
      if (statusCol) {
        charts.push({ id: uid(), type: "donut", title: "Breakdown by " + statusCol.name, agg: "count", measure: null, groupBy: statusCol.name, width: "half", limit: 6, sort: "desc" });
      }
      if (deadlineCol) {
        charts.push({ id: uid(), type: "deadlines", title: "Upcoming: " + deadlineCol.name, groupBy: labelCol && labelCol.name, series: deadlineCol.name, agg: "count", measure: null, width: "full", limit: 12, sort: "desc" });
      }
      if (labelCol) {
        charts.push({ id: uid(), type: "table", title: "Summary table", agg: missingCol ? "sum" : "count", measure: missingCol && missingCol.name, groupBy: labelCol.name, width: "full", limit: 14, sort: "desc" });
      }
      return charts;
    },
  },
  {
    id: "consumables",
    label: "Consumables & COGS Budget",
    // A consumables/COGS planning sheet: one row per consumable item,
    // with an area/typology, a P&L classification, and a priority.
    matches: function (cols) {
      const names = cols.map((c) => c.name.toLowerCase());
      const has = (re) => names.some((n) => re.test(n));
      return has(/consumable/) && has(/p.?&?l|cogs/) && (has(/typology|area/) || has(/budget.*priority/));
    },
    build: function (cols) {
      const byName = (re) => cols.find((c) => re.test(c.name.toLowerCase()));
      const labelCol = byName(/consumable.*item/) || cols.find((c) => c.type === "text");
      const areaCol = byName(/typology|area/);
      const classCol = byName(/p.?&?l.*class|classification/);
      const priorityCol = byName(/budget.*priority/);
      const monthlyCostCol = byName(/monthly.*cost/);
      const annualCostCol = byName(/annual.*cost/);

      // If nobody's filled in real numbers yet, counting items tells the
      // true story; the moment costs are entered, re-opening the file
      // switches these same charts over to real SAR totals automatically.
      const columnSum = function (col) {
        if (!col) return 0;
        let s = 0;
        state.rows.forEach(function (r) { const n = toNumber(r[col.name]); if (n) s += n; });
        return s;
      };
      const costsPopulated = columnSum(monthlyCostCol) > 0 || columnSum(annualCostCol) > 0;
      const measure = costsPopulated ? (monthlyCostCol ? monthlyCostCol.name : null) : null;
      const agg = measure ? "sum" : "count";

      const charts = [];
      charts.push({ id: uid(), type: "kpi", title: "Total consumable items", agg: "count", measure: null, groupBy: null, width: "quarter" });
      if (monthlyCostCol) charts.push({ id: uid(), type: "kpi", title: "Total monthly cost", agg: "sum", measure: monthlyCostCol.name, groupBy: null, width: "quarter" });
      if (annualCostCol) charts.push({ id: uid(), type: "kpi", title: "Total annual cost", agg: "sum", measure: annualCostCol.name, groupBy: null, width: "quarter" });
      if (priorityCol) {
        charts.push({ id: uid(), type: "kpi", title: "High priority items", agg: "count", measure: null, groupBy: null, width: "quarter", filterCol: priorityCol.name, filterValue: "High" });
      }

      if (areaCol) {
        charts.push({ id: uid(), type: "hbar", title: (measure ? monthlyCostCol.name : "Items") + " by " + areaCol.name, agg: agg, measure: measure, groupBy: areaCol.name, width: "full", limit: 14, sort: "desc" });
      }
      if (classCol) {
        charts.push({ id: uid(), type: "donut", title: "Breakdown by " + classCol.name, agg: "count", measure: null, groupBy: classCol.name, width: "half", limit: 6, sort: "desc" });
      }
      if (priorityCol) {
        charts.push({ id: uid(), type: "donut", title: "Breakdown by " + priorityCol.name, agg: "count", measure: null, groupBy: priorityCol.name, width: "half", limit: 6, sort: "desc" });
      }
      if (areaCol && classCol) {
        charts.push({ id: uid(), type: "stacked", title: "Items by " + areaCol.name + ", split by " + classCol.name, groupBy: areaCol.name, series: classCol.name, agg: "count", measure: null, width: "full", limit: 12 });
      }
      if (areaCol) {
        charts.push({ id: uid(), type: "table", title: "Summary table", agg: agg, measure: measure, groupBy: areaCol.name, width: "full", limit: 14, sort: "desc" });
      }
      return charts;
    },
  },
  {
    id: "certification",
    label: "Certification Tracker",
    // A certification/compliance log: one row per certificate, with a
    // type, an issuer, and a real expiry date.
    matches: function (cols) {
      const names = cols.map((c) => c.name.toLowerCase());
      const has = (re) => names.some((n) => re.test(n));
      return has(/certificate.*type|cert.*type/) && has(/expiry|expire/) && !has(/missing.*doc/);
    },
    build: function (cols) {
      const byName = (re) => cols.find((c) => re.test(c.name.toLowerCase()));
      const labelCol = byName(/name/) || cols.find((c) => c.type === "text");
      const typeCol = byName(/certificate.*type|cert.*type/);
      const issuerCol = byName(/issued.*by|provider|issuer/);
      const expiryCol = byName(/expiry|expire/) || cols.find((c) => c.type === "date");
      const statusCol = byName(/status/);

      const charts = [];
      if (expiryCol) charts.push({ id: uid(), type: "countdown", title: "Next " + expiryCol.name, groupBy: labelCol && labelCol.name, series: expiryCol.name, agg: "count", measure: null, width: "quarter" });
      charts.push({ id: uid(), type: "kpi", title: "Total certificates", agg: "count", measure: null, groupBy: null, width: "quarter" });
      if (statusCol) {
        const expiredNames = ["Expired", "Overdue"];
        for (const val of expiredNames) {
          const n = state.rows.filter(function (r) { return String(r[statusCol.name] || "").trim().toLowerCase() === val.toLowerCase(); }).length;
          if (n > 0) { charts.push({ id: uid(), type: "kpi", title: val + " now", agg: "count", measure: null, groupBy: null, width: "quarter", filterCol: statusCol.name, filterValue: val }); break; }
        }
      }
      if (typeCol) charts.push({ id: uid(), type: "donut", title: "Breakdown by " + typeCol.name, agg: "count", measure: null, groupBy: typeCol.name, width: "half", limit: 8, sort: "desc" });
      if (issuerCol) charts.push({ id: uid(), type: "hbar", title: "Certificates by " + issuerCol.name, agg: "count", measure: null, groupBy: issuerCol.name, width: "half", limit: 10, sort: "desc" });
      if (statusCol) charts.push({ id: uid(), type: "donut", title: "Breakdown by " + statusCol.name, agg: "count", measure: null, groupBy: statusCol.name, width: "half", limit: 6, sort: "desc" });
      if (expiryCol) charts.push({ id: uid(), type: "deadlines", title: "Upcoming: " + expiryCol.name, groupBy: labelCol && labelCol.name, series: expiryCol.name, agg: "count", measure: null, width: "full", limit: 14, sort: "desc" });
      if (labelCol) charts.push({ id: uid(), type: "table", title: "Summary table", agg: "count", measure: null, groupBy: labelCol.name, width: "full", limit: 14, sort: "desc" });
      return charts;
    },
  },
  // More templates go here once a sample file defines their shape.
];

function detectTemplate(cols) {
  for (const t of TEMPLATES) {
    try { if (t.matches(cols)) return t; } catch (e) { /* a bad matcher shouldn't break loading */ }
  }
  return null;
}

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
  // A column with 2 to 4 distinct values (Yes/No, status flags) is the clearest possible donut.
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
  // Pick a grouping we have not already charted with this measure, so the
  // board never shows the same breakdown twice in two different shapes.
  const alreadyCharted = new Set(charts.filter((c) => c.groupBy)
    .map((c) => (c.measure || "count") + "|" + c.groupBy));
  const secondPick = [secondGroup].concat(groupCandidates)
    .filter(Boolean)
    .find((c) => c.name !== mainGroup &&
      !alreadyCharted.has((primaryMeasure || "count") + "|" + c.name));
  if (secondPick) {
    charts.push({
      id: uid(), type: smallTable ? "progress" : "hbar",
      title: primaryMeasure ? primaryMeasure + " by " + secondPick.name : "Rows by " + secondPick.name,
      agg: primaryMeasure ? "sum" : "count", measure: primaryMeasure, groupBy: secondPick.name, width: "half", limit: 10, sort: "desc",
    });
  }
  const realDateCols = dateCols.filter((c) => !/estimated/i.test(c.name));
  if (realDateCols.length && primaryMeasure) {
    charts.push({ id: uid(), type: "area", title: primaryMeasure + " over time", agg: "sum", measure: primaryMeasure, groupBy: realDateCols[0].name, width: "full", limit: 24, sort: "date" });
  }
  if (mainGroup) {
    const charted = new Set(charts.filter((c) => c.groupBy && c.type !== "table")
      .map((c) => (c.measure || "count") + "|" + c.groupBy));
    const tableGroup = ([{ name: mainGroup }].concat(groupCandidates)
      .find((c) => !charted.has((primaryMeasure || "count") + "|" + c.name)) || { name: mainGroup }).name;
    charts.push({ id: uid(), type: "table", title: "Summary table", agg: primaryMeasure ? "sum" : "count", measure: primaryMeasure, groupBy: tableGroup, width: "full", limit: 12, sort: "desc" });
  }

  // A date column that reads as a deadline (due, expiry, recert, next
  // service, inspection...) gets a countdown up top and a full list.
  const deadlineCol = dateCols.find((c) => /due|expiry|expire|renew|recert|deadline|next[\s_-]*(date|maintenance|service)|inspection|audit|valid[\s_-]*(until|to)/i.test(c.name));
  if (deadlineCol) {
    charts.unshift({ id: uid(), type: "countdown", title: /^next\b/i.test(deadlineCol.name) ? deadlineCol.name : "Next " + deadlineCol.name, groupBy: labelCol, series: deadlineCol.name, agg: "count", measure: null, width: "quarter" });
    charts.push({ id: uid(), type: "deadlines", title: "Upcoming: " + deadlineCol.name, groupBy: labelCol, series: deadlineCol.name, agg: "count", measure: null, width: "half", limit: 10, sort: "desc" });
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
  for (const r of activeRows()) {
    const key = chart.groupBy ? groupKey(r, chart.groupBy) : "All";
    if (!map.has(key)) map.set(key, { key: key, vals: [], count: 0 });
    const b = map.get(key);
    b.count++;
    if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) b.vals.push(n); }
  }
  let arr = Array.from(map.values()).map((b) => ({ key: b.key, value: computeValue(chart.agg, b.vals, b.count) }));
  // key stays raw so cross-filtering still matches; label is what people read.
  const dateGroup = chart.groupBy && colType(chart.groupBy) === "date";
  arr.forEach((d) => { d.label = dateGroup ? monthLabel(d.key) : d.key; });
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
  for (const r of activeRows()) {
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
  return (a ? a.name : "Sum") + " of " + (chart.measure || "value");
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

/* Attributes that turn any drawn element into a cross-filter trigger.
   Clicking it filters every chart to rows where `col` == `key`. Also
   marks the currently-selected element so it reads as "active". */
function clickAttrs(chart, key) {
  if (!chart.groupBy) return "";
  const active = state.filter && state.filter.col === chart.groupBy && state.filter.key === key;
  return ' class="clickable' + (active ? " active" : "") + '" data-fcol="' + esc(chart.groupBy) + '" data-fkey="' + esc(key) + '"';
}

/* Category label that tilts when there are too many to fit upright. */
function catLabel(x, y, text, count) {
  if (count > 7) {
    return '<text x="' + x + '" y="' + (y - 6) + '" text-anchor="end" transform="rotate(-35 ' + x + ' ' + (y - 6) + ')" class="cat-lbl">' + esc(clip(text, 14)) + '</text>';
  }
  return '<text x="' + x + '" y="' + y + '" text-anchor="middle" class="cat-lbl">' + esc(clip(text, 12)) + '</text>';
}

/* When a filter is active, everything NOT selected should visually recede. */
function dimIf(chart, key) {
  if (!state.filter || state.filter.col !== chart.groupBy) return "";
  return state.filter.key === key ? "" : ' opacity="0.3"';
}

function drawBar(chart, W, H) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const P = { l: 56, r: 14, t: 20, b: data.length > 7 ? 74 : 54 };
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
    return '<g' + clickAttrs(chart, d.key) + dimIf(chart, d.key) + '><title>' + esc(d.label || d.key) + ': ' + fmtFull(d.value) + '</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(h, 1) + '" rx="4" fill="' + SERIES_HUE + '"/>' +
      '<text x="' + (x + bw / 2) + '" y="' + (y - 6) + '" text-anchor="middle" class="val-lbl">' + fmt(d.value) + '</text>' +
      catLabel(x + bw / 2, H - P.b + 18, d.label || d.key, data.length) + '</g>';
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
    return '<g' + clickAttrs(chart, d.key) + dimIf(chart, d.key) + '><title>' + esc(d.label || d.key) + ': ' + fmtFull(d.value) + '</title>' +
      '<text x="' + (P.l - 10) + '" y="' + (y + bh / 2 + 4) + '" text-anchor="end" class="cat-lbl">' + esc(clip(d.label || d.key, 18)) + '</text>' +
      '<rect x="' + P.l + '" y="' + y + '" width="' + Math.max(w, 1) + '" height="' + bh + '" rx="4" fill="' + SERIES_HUE + '"/>' +
      '<text x="' + (P.l + w + 8) + '" y="' + (y + bh / 2 + 4) + '" class="val-lbl">' + fmt(d.value) + '</text></g>';
  }).join("");
  return svgWrap(W, H, bars);
}

function drawLineArea(chart, W, H, filled) {
  const data = aggregate(chart);
  if (data.length < 2) return '<div class="chart-empty">Needs at least 2 points. Try a different Group by.</div>';
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
    ? '<text x="' + xAt(i) + '" y="' + (H - P.b + 20) + '" text-anchor="middle" class="cat-lbl">' + esc(clip(d.label || d.key, 10)) + '</text>' : "").join("");

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
    return '<path' + clickAttrs(chart, d.key) + dimIf(chart, d.key) + ' d="' + arcPath(cx, cy, rO, rI, a0, Math.max(a1, a0 + 0.01)) + '" fill="' + colorFor(i) +
      '" stroke="var(--bg-panel)" stroke-width="1.5"><title>' + esc(d.key) + ': ' + fmtFull(d.value) + ' (' + Math.round(d.value / total * 100) + '%)</title></path>';
  }).join("");
  const center = isDonut
    ? '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" class="donut-num">' + fmt(total) + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" class="donut-cap">TOTAL</text>' : "";
  const lx = cx + rO + 24;
  const legend = data.slice(0, 9).map(function (d, i) {
    const y = 26 + i * 21;
    return '<g' + clickAttrs(chart, d.key) + dimIf(chart, d.key) + '><rect x="' + lx + '" y="' + (y - 9) + '" width="11" height="11" rx="3" fill="' + colorFor(i) + '"/>' +
      '<text x="' + (lx + 18) + '" y="' + y + '" class="cat-lbl">' + esc(clip(d.label || d.key, 16)) + '</text>' +
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
    return '<div class="prog-row' + (state.filter && state.filter.col === chart.groupBy ? (state.filter.key === d.key ? ' active' : ' dimmed-row') : '') + ' clickable" data-fcol="' + esc(chart.groupBy) + '" data-fkey="' + esc(d.key) + '"><div class="prog-top"><span class="prog-name">' + esc(d.label || d.key) + '</span>' +
      '<span class="prog-val mono">' + fmtFull(d.value) + '</span></div>' +
      '<div class="prog-track"><div class="prog-fill" style="width:' + p + '%; background:' + SERIES_HUE + '"></div></div></div>';
  }).join("") + '</div>';
}

function drawTable(chart) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  return '<div class="tbl-scroll"><table class="v-table"><thead><tr><th>' + esc(chart.groupBy || "Group") +
    '</th><th>' + esc(measureLabel(chart)) + '</th><th>Share</th></tr></thead><tbody>' +
    data.map((d) => '<tr class="clickable' + (state.filter && state.filter.col === chart.groupBy && state.filter.key === d.key ? ' active' : '') + '" data-fcol="' + esc(chart.groupBy) + '" data-fkey="' + esc(d.key) + '"><td>' + esc(d.label || d.key) + '</td><td class="mono">' + fmtFull(d.value) +
      '</td><td class="mono dimmed">' + Math.round(d.value / total * 100) + '%</td></tr>').join("") +
    '</tbody></table></div>';
}

/* ---------- Power BI style visuals ---------- */

/* Gauge: a single value drawn as a dial against a target. If no target
   is set, the target defaults to the UNFILTERED total, so when a filter
   is active the dial naturally reads as "share of the whole". */
function drawGauge(chart, W, H) {
  const vals = [];
  let count = 0;
  for (const r of activeRows()) {
    count++;
    if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) vals.push(n); }
  }
  const value = computeValue(chart.agg, vals, count);

  let target = toNumber(chart.target);
  if (target === null || target <= 0) {
    const allVals = []; let allCount = 0;
    for (const r of state.rows) { allCount++; if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) allVals.push(n); } }
    target = computeValue(chart.agg, allVals, allCount) || 1;
  }
  const pct = Math.max(0, Math.min(1, target ? value / target : 0));
  const cx = W / 2, cy = H * 0.72, R = Math.min(W * 0.36, H * 0.6);
  const color = pct >= 0.9 ? "var(--green)" : pct >= 0.5 ? "var(--teal)" : "var(--orange)";
  // Half-circle from 180° (left) to 360° (right).
  const track = arcPath(cx, cy, R, R * 0.72, 270, 450);
  const fill = arcPath(cx, cy, R, R * 0.72, 270, 270 + pct * 180);
  return svgWrap(W, H,
    '<path d="' + track + '" fill="var(--bg-raised)"/>' +
    (pct > 0 ? '<path d="' + fill + '" fill="' + color + '"><title>' + fmtFull(value) + ' of ' + fmtFull(target) + '</title></path>' : "") +
    '<text x="' + cx + '" y="' + (cy - 8) + '" text-anchor="middle" class="donut-num">' + Math.round(pct * 100) + '%</text>' +
    '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" class="donut-cap">' + esc(fmt(value) + " OF " + fmt(target)) + '</text>' +
    '<text x="' + (cx - R) + '" y="' + (cy + 26) + '" text-anchor="middle" class="axis-lbl">0</text>' +
    '<text x="' + (cx + R) + '" y="' + (cy + 26) + '" text-anchor="middle" class="axis-lbl">' + fmt(target) + '</text>');
}

/* Treemap: proportions as nested rectangles, using a simple squarified
   slice-and-dice layout that is good enough for a dozen categories. */
function drawTreemap(chart, W, H) {
  const data = aggregate(chart).filter((d) => d.value > 0);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const total = data.reduce((a, b) => a + b.value, 0);
  const rects = [];
  // Recursive slice: split the remaining list in two by value, alternating axis.
  function layout(items, x, y, w, h, horiz) {
    if (!items.length) return;
    if (items.length === 1) { rects.push({ d: items[0], x, y, w, h }); return; }
    const sum = items.reduce((a, b) => a + b.value, 0);
    let acc = 0, split = 0;
    for (let i = 0; i < items.length; i++) { acc += items[i].value; split = i + 1; if (acc >= sum / 2) break; }
    const left = items.slice(0, split), right = items.slice(split);
    const frac = left.reduce((a, b) => a + b.value, 0) / sum;
    if (horiz) {
      layout(left, x, y, w * frac, h, !horiz);
      layout(right, x + w * frac, y, w * (1 - frac), h, !horiz);
    } else {
      layout(left, x, y, w, h * frac, !horiz);
      layout(right, x, y + h * frac, w, h * (1 - frac), !horiz);
    }
  }
  layout(data, 2, 2, W - 4, H - 4, W >= H);
  const cells = rects.map(function (rc, i) {
    const pct = Math.round(rc.d.value / total * 100);
    const big = rc.w > 70 && rc.h > 34;
    return '<g' + clickAttrs(chart, rc.d.key) + dimIf(chart, rc.d.key) + '><title>' + esc(rc.d.key) + ': ' + fmtFull(rc.d.value) + ' (' + pct + '%)</title>' +
      '<rect x="' + rc.x + '" y="' + rc.y + '" width="' + Math.max(rc.w - 3, 1) + '" height="' + Math.max(rc.h - 3, 1) + '" rx="5" fill="' + colorFor(i) + '"/>' +
      (big ? '<text x="' + (rc.x + 9) + '" y="' + (rc.y + 18) + '" class="tm-lbl">' + esc(clip(rc.d.key, Math.max(6, Math.floor(rc.w / 7)))) + '</text>' +
             '<text x="' + (rc.x + 9) + '" y="' + (rc.y + 34) + '" class="tm-val">' + fmt(rc.d.value) + ' · ' + pct + '%</text>' : "") +
      '</g>';
  }).join("");
  return svgWrap(W, H, cells);
}

/* Funnel: values shown as progressively narrower bands, largest first. */
function drawFunnel(chart, W, H) {
  const data = aggregate(chart).filter((d) => d.value > 0);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  data.sort((a, b) => b.value - a.value);
  const max = data[0].value || 1;
  const P = { t: 10, b: 10 }, rowH = (H - P.t - P.b) / data.length, cx = W / 2;
  const bands = data.map(function (d, i) {
    const w = Math.max((d.value / max) * (W * 0.8), 40);
    const y = P.t + rowH * i;
    return '<g' + clickAttrs(chart, d.key) + dimIf(chart, d.key) + '><title>' + esc(d.label || d.key) + ': ' + fmtFull(d.value) + '</title>' +
      '<rect x="' + (cx - w / 2) + '" y="' + (y + 3) + '" width="' + w + '" height="' + Math.max(rowH - 6, 4) + '" rx="4" fill="' + colorFor(i) + '"/>' +
      '<text x="' + cx + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="middle" class="fn-lbl">' + esc(clip(d.key, 22)) + ' · ' + fmt(d.value) + '</text></g>';
  }).join("");
  return svgWrap(W, H, bands);
}

/* Waterfall: how the categories add up to the total, step by step. */
function drawWaterfall(chart, W, H) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const total = data.reduce((a, b) => a + b.value, 0);
  const steps = data.map((d) => ({ key: d.key, value: d.value })).concat([{ key: "Total", value: total, isTotal: true }]);
  const P = { l: 56, r: 14, t: 20, b: steps.length > 7 ? 74 : 54 };
  const max = niceMax(Math.max(total, ...data.map((d) => d.value), 0));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = iw / steps.length, bw = Math.min(step * 0.62, 56);
  const grid = axisTicks(max).map(function (t) {
    const y = P.t + ih - (t / max) * ih;
    return '<line x1="' + P.l + '" y1="' + y + '" x2="' + (W - P.r) + '" y2="' + y + '" class="grid"/>' +
           '<text x="' + (P.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="axis-lbl">' + fmt(t) + '</text>';
  }).join("");
  let running = 0;
  const bars = steps.map(function (s, i) {
    const x = P.l + step * i + (step - bw) / 2;
    const base = s.isTotal ? 0 : running;
    const top = s.isTotal ? total : running + s.value;
    if (!s.isTotal) running += s.value;
    const y0 = P.t + ih - (max ? (base / max) * ih : 0);
    const y1 = P.t + ih - (max ? (top / max) * ih : 0);
    const fill = s.isTotal ? "var(--teal)" : (s.value >= 0 ? "var(--green)" : "var(--magenta)");
    const connector = (!s.isTotal && i < steps.length - 1)
      ? '<line x1="' + (x + bw) + '" y1="' + y1 + '" x2="' + (x + step) + '" y2="' + y1 + '" class="grid" stroke-dasharray="3 3"/>' : "";
    const attrs = s.isTotal ? "" : clickAttrs(chart, s.key) + dimIf(chart, s.key);
    return '<g' + attrs + '><title>' + esc(s.key) + ': ' + fmtFull(s.value) + '</title>' +
      '<rect x="' + x + '" y="' + Math.min(y0, y1) + '" width="' + bw + '" height="' + Math.max(Math.abs(y0 - y1), 1) + '" rx="3" fill="' + fill + '"/>' +
      '<text x="' + (x + bw / 2) + '" y="' + (Math.min(y0, y1) - 6) + '" text-anchor="middle" class="val-lbl">' + fmt(s.value) + '</text>' +
      catLabel(x + bw / 2, H - P.b + 18, s.key, steps.length) + '</g>' + connector;
  }).join("");
  return svgWrap(W, H, grid + bars);
}

/* Combo: bars for the measure, plus a line for the row count per
   category, so "how much" and "how many" sit on one chart. */
function drawCombo(chart, W, H) {
  const data = aggregate(chart);
  if (!data.length) return '<div class="chart-empty">No data</div>';
  const counts = aggregate({ groupBy: chart.groupBy, measure: null, agg: "count", sort: chart.sort, limit: chart.limit });
  const countMap = {}; counts.forEach((c) => { countMap[c.key] = c.value; });
  const P = { l: 56, r: 48, t: 20, b: data.length > 7 ? 74 : 54 };
  const max = niceMax(Math.max.apply(null, data.map((d) => d.value).concat([0])));
  const cmax = niceMax(Math.max.apply(null, data.map((d) => countMap[d.key] || 0).concat([1])));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = iw / data.length, bw = Math.min(step * 0.55, 50);
  const grid = axisTicks(max).map(function (t) {
    const y = P.t + ih - (t / max) * ih;
    return '<line x1="' + P.l + '" y1="' + y + '" x2="' + (W - P.r) + '" y2="' + y + '" class="grid"/>' +
           '<text x="' + (P.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="axis-lbl">' + fmt(t) + '</text>';
  }).join("");
  const rightAxis = axisTicks(cmax).map(function (t) {
    const y = P.t + ih - (t / cmax) * ih;
    return '<text x="' + (W - P.r + 8) + '" y="' + (y + 4) + '" class="axis-lbl">' + fmt(t) + '</text>';
  }).join("");
  const bars = data.map(function (d, i) {
    const h = max ? (d.value / max) * ih : 0;
    const x = P.l + step * i + (step - bw) / 2;
    const y = P.t + ih - h;
    return '<g' + clickAttrs(chart, d.key) + dimIf(chart, d.key) + '><title>' + esc(d.key) + ': ' + fmtFull(d.value) + ' · ' + (countMap[d.key] || 0) + ' rows</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(h, 1) + '" rx="4" fill="' + SERIES_HUE + '"/>' +
      catLabel(x + bw / 2, H - P.b + 18, d.label || d.key, data.length) + '</g>';
  }).join("");
  const pts = data.map(function (d, i) {
    const cx = P.l + step * i + step / 2;
    const cy = P.t + ih - (cmax ? ((countMap[d.key] || 0) / cmax) * ih : 0);
    return cx + "," + cy;
  }).join(" ");
  const line = '<polyline points="' + pts + '" fill="none" stroke="var(--orange)" stroke-width="2.5" stroke-linejoin="round"/>' +
    data.map(function (d, i) {
      const cx = P.l + step * i + step / 2;
      const cy = P.t + ih - (cmax ? ((countMap[d.key] || 0) / cmax) * ih : 0);
      return '<circle cx="' + cx + '" cy="' + cy + '" r="3.5" fill="var(--orange)"><title>' + esc(d.key) + ': ' + (countMap[d.key] || 0) + ' rows</title></circle>';
    }).join("");
  return svgWrap(W, H, grid + rightAxis + bars + line);
}

/* Heatmap table: a category × series matrix, each cell shaded by value. */
function drawHeatmap(chart) {
  if (!chart.series) return '<div class="chart-empty">Choose a “Split by” column in Edit</div>';
  const res = aggregateStacked(chart);
  if (!res.rows.length) return '<div class="chart-empty">No data</div>';
  let vmax = 0;
  res.rows.forEach((r) => r.parts.forEach((v) => { if (v > vmax) vmax = v; }));
  vmax = vmax || 1;
  const head = '<tr><th>' + esc(chart.groupBy) + '</th>' + res.seriesNames.map((s) => '<th>' + esc(clip(s, 16)) + '</th>').join("") + '<th>Total</th></tr>';
  const body = res.rows.map(function (r) {
    const cells = r.parts.map(function (v) {
      const a = v > 0 ? 0.15 + 0.7 * (v / vmax) : 0;
      return '<td class="hm-cell mono" style="background:rgba(0,146,172,' + a.toFixed(2) + ');">' + (v ? fmtFull(v) : "") + '</td>';
    }).join("");
    return '<tr class="clickable' + (state.filter && state.filter.col === chart.groupBy && state.filter.key === r.key ? ' active' : '') + '" data-fcol="' + esc(chart.groupBy) + '" data-fkey="' + esc(r.key) + '"><td>' + esc(r.key) + '</td>' + cells + '<td class="mono">' + fmtFull(r.total) + '</td></tr>';
  }).join("");
  return '<div class="tbl-scroll"><table class="v-table hm-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function drawKpi(chart) {
  const vals = [];
  let count = 0;
  for (const r of activeRows()) {
    if (chart.filterCol && String(r[chart.filterCol] || "").trim().toLowerCase() !== String(chart.filterValue || "").trim().toLowerCase()) continue;
    count++;
    if (chart.measure) { const n = toNumber(r[chart.measure]); if (n !== null) vals.push(n); }
  }
  const v = computeValue(chart.agg, vals, count);
  const cap = chart.filterCol ? esc(chart.title) : esc(measureLabel(chart));
  return '<div class="kpi-body"><div class="kpi-num mono">' + fmt(v) + '</div><div class="kpi-cap">' + cap + '</div></div>';
}

function drawCountdown(chart) {
  const items = computeDeadlines(chart);
  if (!items.length) return '<div class="chart-empty">No dates found. Pick a date column under "Date column" in Edit.</div>';
  const next = items[0];
  const overdue = next.days < 0;
  const dueSoon = !overdue && next.days <= 30;
  const color = overdue ? "var(--magenta)" : dueSoon ? "var(--orange)" : "var(--green)";
  const text = overdue ? Math.abs(next.days) + (Math.abs(next.days) === 1 ? " day overdue" : " days overdue")
    : next.days + (next.days === 1 ? " day" : " days");
  return '<div class="kpi-body"><div class="kpi-num mono" style="color:' + color + ';">' + text + '</div>' +
    '<div class="kpi-cap">' + esc(next.label) + '</div></div>';
}

function drawDeadlines(chart) {
  const all = computeDeadlines(chart);
  if (!all.length) return '<div class="chart-empty">No dates found. Pick a date column under "Date column" in Edit.</div>';
  const items = chart.limit ? all.slice(0, chart.limit) : all;
  return '<div class="prog-list">' + items.map(function (it) {
    const overdue = it.days < 0;
    const dueSoon = !overdue && it.days <= 30;
    const color = overdue ? "var(--magenta)" : dueSoon ? "var(--orange)" : "var(--green)";
    const text = overdue ? Math.abs(it.days) + " days overdue" : it.days + " days left";
    const pct = overdue ? 100 : Math.max(6, 100 - Math.min(it.days, 365) / 365 * 100);
    return '<div class="prog-row"><div class="prog-top"><span class="prog-name">' + esc(it.label) +
      '</span><span class="prog-val mono" style="color:' + color + ';">' + text + '</span></div>' +
      '<div class="prog-track"><div class="prog-fill" style="width:' + pct + '%; background:' + color + ';"></div></div></div>';
  }).join("") + '</div>';
}

function drawChart(chart) {
  const W = chart.width === "full" ? 900 : 440;
  const H = 300;
  switch (chart.type) {
    case "kpi": return drawKpi(chart);
    case "countdown": return drawCountdown(chart);
    case "deadlines": return drawDeadlines(chart);
    case "bar": return drawBar(chart, W, H);
    case "hbar": return drawHBar(chart, W, H);
    case "line": return drawLineArea(chart, W, H, false);
    case "area": return drawLineArea(chart, W, H, true);
    case "donut": return drawPieDonut(chart, W, H, true);
    case "pie": return drawPieDonut(chart, W, H, false);
    case "stacked": return drawStacked(chart, W, H);
    case "gauge": return drawGauge(chart, chart.width === "quarter" ? 220 : W, chart.width === "quarter" ? 150 : 220);
    case "treemap": return drawTreemap(chart, W, H);
    case "funnel": return drawFunnel(chart, W, H);
    case "waterfall": return drawWaterfall(chart, W, H);
    case "combo": return drawCombo(chart, W, H);
    case "heatmap": return drawHeatmap(chart);
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
  // The starter card carries its own upload button, so the one in the header
  // only appears once that card is gone. Never two on screen at once.
  const up = document.getElementById("upload-btn");
  if (up) up.style.display = "";

  const src = document.getElementById("file-name");
  if (src) src.textContent = state.fileName || "";

  const ti = document.getElementById("board-title");
  if (ti) ti.value = state.boardTitle || "";
  document.title = state.boardTitle ? state.boardTitle + " | SEVEN" : "SEVEN";

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

  renderInsights();
  renderCharts();
}

/* The analyst's summary. Each finding is a claim you can read in one
   line, with the numbers behind it underneath, so the panel is worth
   reading rather than a row of statistics. */
function renderInsights() {
  let panel = document.getElementById("insights-panel");
  const grid = document.getElementById("chart-grid");
  if (!grid) return;
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "insights-panel";
    grid.parentNode.insertBefore(panel, grid);
  }
  const items = (state.insights || []).slice(0, 5);
  if (!items.length) { panel.style.display = "none"; panel.innerHTML = ""; return; }
  panel.style.display = "";
  panel.innerHTML =
    '<div class="ins-head"><span class="ins-title display">What the numbers say</span>' +
    (state.insights.length > items.length
      ? '<span class="ins-sub">' + items.length + ' of ' + state.insights.length + '</span>' : '') +
    '</div>' +
    '<div class="ins-list">' + items.map(function (it) {
      return '<div class="ins-item sev-' + it.severity + '">' +
        '<span class="ins-dot" aria-hidden="true"></span>' +
        '<span class="ins-text"><b>' + esc(it.headline) + '</b>' +
        (it.detail ? '<span class="ins-detail">' + esc(it.detail) + '</span>' : '') +
        '</span></div>';
    }).join("") + '</div>';
}

function renderCharts() {
  const grid = document.getElementById("chart-grid");
  if (!state.charts.length) {
    grid.innerHTML = '<div class="no-charts">No charts yet. Click <b>+ Add chart</b> to start building.</div>';
    saveLayout();
    return;
  }
  // Toolbar icons: 13px line SVGs, no glyph/emoji fallbacks.
  var TOOL_ICON = {
    left:  '<path d="M14.5 5L8 12l6.5 7"/>',
    right: '<path d="M9.5 5L16 12l-6.5 7"/>',
    dup:   '<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M15 5.5H5.5a1 1 0 0 0-1 1V16"/>',
    edit:  '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/>',
    del:   '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'
  };
  function toolBtn(act, id, title, disabled, danger) {
    return '<button class="tool' + (danger ? " danger" : "") + '" data-act="' + act + '" data-id="' + id +
      '" title="' + title + '" aria-label="' + title + '"' + (disabled ? " disabled" : "") + '>' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + TOOL_ICON[act] + '</svg></button>';
  }
  grid.innerHTML = state.charts.map(function (c, i) {
    return '<section class="chart-card w-' + (c.width || "half") + '" data-id="' + c.id + '">' +
      '<header class="chart-head"><h3 class="chart-title display">' + esc(c.title || "Untitled") + '</h3>' +
      '<div class="chart-tools">' +
        toolBtn("left",  c.id, "Move left",  i === 0) +
        toolBtn("right", c.id, "Move right", i === state.charts.length - 1) +
        toolBtn("dup",   c.id, "Duplicate",  false) +
        toolBtn("edit",  c.id, "Edit",       false) +
        toolBtn("del",   c.id, "Remove",     false, true) +
      '</div></header>' +
      '<div class="chart-body">' + drawChart(c) + '</div></section>';
  }).join("");

  Array.prototype.forEach.call(grid.querySelectorAll("button.tool"), function (b) {
    b.addEventListener("click", function () { chartAction(b.getAttribute("data-act"), b.getAttribute("data-id")); });
  });

  // Cross-filter: clicking any tagged element filters every chart.
  // Clicking the already-active one clears the filter.
  Array.prototype.forEach.call(grid.querySelectorAll("[data-fkey]"), function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      const col = el.getAttribute("data-fcol"), key = el.getAttribute("data-fkey");
      if (state.filter && state.filter.col === col && state.filter.key === key) state.filter = null;
      else state.filter = { col: col, key: key };
      renderCharts();
    });
  });

  renderFilterBar();
  saveLayout();
}

/* A slim banner above the charts showing the active filter, with a
   clear button, so it's never a mystery why numbers changed. */
function renderFilterBar() {
  const grid = document.getElementById("chart-grid");
  if (!grid) return;
  let bar = document.getElementById("filter-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "filter-bar";
    grid.parentNode.insertBefore(bar, grid);
  }
  if (!state.filter) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  const n = activeRows().length;
  bar.style.display = "";
  bar.innerHTML = '<span class="fb-label">Filtered to</span> <b>' + esc(state.filter.col) + '</b> = <b>' + esc(state.filter.key) + '</b>' +
    ' <span class="fb-count mono">' + n + ' of ' + state.rows.length + ' rows</span>' +
    ' <button class="btn ghost fb-clear" id="filter-clear">Clear filter</button>';
  document.getElementById("filter-clear").addEventListener("click", function () { state.filter = null; renderCharts(); });
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
    '<label class="fld"><span>Group by (category)</span><select id="f-group"><option value="">None</option>' +
      catCols.map((x) => '<option' + sel(x.name, c.groupBy) + '>' + esc(x.name) + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Split by <em>(stacked bar)</em> or Date column <em>(countdown, deadlines)</em></span><select id="f-series"><option value="">None</option>' +
      catCols.map((x) => '<option' + sel(x.name, c.series) + '>' + esc(x.name) + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Measure</span><select id="f-agg">' +
      AGGS.map((a) => '<option value="' + a.id + '"' + sel(a.id, c.agg) + '>' + a.name + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Of column</span><select id="f-measure"><option value="">None</option>' +
      numCols.map((x) => '<option' + sel(x.name, c.measure) + '>' + esc(x.name) + '</option>').join("") + '</select></label>' +
    '<label class="fld"><span>Size</span><select id="f-width">' +
      '<option value="quarter"' + sel("quarter", c.width) + '>Small (quarter width)</option>' +
      '<option value="half"' + sel("half", c.width) + '>Medium (half width)</option>' +
      '<option value="full"' + sel("full", c.width) + '>Large (full width)</option></select></label>' +
    '<label class="fld"><span>Show top</span><input id="f-limit" type="number" min="1" max="50" value="' + (c.limit || 12) + '" /></label>' +
    '<label class="fld"><span>Target <em>(gauge only, blank = total)</em></span><input id="f-target" type="number" value="' + (c.target !== undefined && c.target !== null ? esc(c.target) : "") + '" placeholder="e.g. 100" /></label>' +
    '<label class="fld"><span>Sort</span><select id="f-sort">' +
      '<option value="desc"' + sel("desc", c.sort) + '>Highest first</option>' +
      '<option value="asc"' + sel("asc", c.sort) + '>Lowest first</option>' +
      '<option value="label"' + sel("label", c.sort) + '>By name (A to Z)</option>' +
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
    target: g("f-target") === "" ? null : toNumber(g("f-target")),
  };
  const isDeadlineType = chart.type === "countdown" || chart.type === "deadlines";
  if (chart.agg !== "count" && !chart.measure && !isDeadlineType) {
    alert('Choose a column under "Of column", or set Measure to "Count of rows".');
    return;
  }
  if (isDeadlineType && !chart.series) {
    alert('Choose a date column under "Split by / Date column" for this chart type.');
    return;
  }
  if (!isDeadlineType && chart.type !== "kpi" && chart.type !== "gauge" && !chart.groupBy) {
    alert('Choose a column under "Group by" for this chart type.');
    return;
  }
  if (!chart.title) {
    chart.title = (chart.type === "kpi" || chart.type === "gauge") ? measureLabel(chart)
      : chart.type === "countdown" ? "Next " + chart.series
      : chart.type === "deadlines" ? "Upcoming: " + chart.series
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
    all[layoutKey()] = { title: state.boardTitle, charts: state.charts, template: state.activeTemplate };
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
  // Not a recognisable name-bearing structure, so at least don't dump raw braces.
  if (s[0] === "{" || s[0] === "[") return s.length > 1 ? "Attached" : v;
  return v;
}

function cleanRow(row) {
  const out = {};
  Object.keys(row).forEach(function (k) { out[k] = cleanCellValue(row[k]); });
  return out;
}

/* ============================================================
   Analysis engine: the "data analyst" layer.
   Profiles every column with real statistics and surfaces
   findings (outliers, skew, concentration, correlation,
   trends, data-quality gaps) so dashboards are analytical,
   not just decorative. Computed once per file at ingest and
   stored on state.profile / state.insights.
   ============================================================ */

function numericValues(colName) {
  const out = [];
  for (const r of state.rows) { const n = toNumber(r[colName]); if (n !== null) out.push(n); }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

function profileNumeric(colName) {
  const vals = numericValues(colName).slice().sort((a, b) => a - b);
  const n = vals.length;
  if (!n) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const sd = Math.sqrt(variance);
  const min = vals[0], max = vals[n - 1];
  const q1 = quantile(vals, 0.25), median = quantile(vals, 0.5), q3 = quantile(vals, 0.75);
  const iqr = q3 - q1;
  // Outliers by the standard 1.5×IQR rule.
  const loFence = q1 - 1.5 * iqr, hiFence = q3 + 1.5 * iqr;
  const outliers = vals.filter((v) => v < loFence || v > hiFence);
  // Skew (Pearson's second coefficient): direction and strength of the tail.
  const skew = sd ? (3 * (mean - median)) / sd : 0;
  // Concentration: does a small share of rows hold most of the total? (Pareto)
  const desc = vals.slice().sort((a, b) => b - a);
  let acc = 0, rowsForHalf = 0;
  const total = sum || 1;
  for (let i = 0; i < desc.length; i++) { acc += desc[i]; if (acc >= total * 0.8) { rowsForHalf = i + 1; break; } }
  const paretoShare = rowsForHalf / n; // share of rows that make up 80% of the total
  const zeros = vals.filter((v) => v === 0).length;
  return { n, mean, sd, min, max, q1, median, q3, iqr, outliers, skew, sum, paretoShare, zeros, cv: mean ? sd / mean : 0 };
}

/* Pearson correlation between two numeric columns (rows where both present). */
function correlation(colA, colB) {
  const xs = [], ys = [];
  for (const r of state.rows) {
    const a = toNumber(r[colA]), b = toNumber(r[colB]);
    if (a !== null && b !== null) { xs.push(a); ys.push(b); }
  }
  const n = xs.length;
  if (n < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!sxx || !syy) return null;
  return { r: sxy / Math.sqrt(sxx * syy), n };
}

function buildProfile() {
  const profile = {};
  state.columns.forEach(function (c) {
    if (c.type === "number") profile[c.name] = profileNumeric(c.name);
  });
  state.profile = profile;
}

/* ============================================================
   Findings.

   The rule here: a finding has to name something real and give a
   number you can act on. "32% of rows make up 80% of X" is not a
   finding, it's a restatement of a statistic, and repeating it once
   per numeric column fills the panel with noise. So every finding
   below names a category, a period, a ratio or a record, is capped
   to one per kind, and is ranked by how much it would change what
   someone does next.
   ============================================================ */

/* Columns whose values are counts/amounts, so a total means something.
   Unit prices, rates and percentages are excluded: summing them is
   meaningless, and they get described by their spread instead. */
const RE_IDLIKE  = /(^|\b)(id|code|no|num|number|ref|sku|zip|postal|phone|year|serial|barcode)(\b|$)/i;
const RE_PERUNIT = /(price|rate|per\b|percent|%|margin|ratio|score|avg|average|median|index|each|unit cost)/i;
const RE_MONEYISH = /(sales|revenue|amount|total|value|spend|cost|profit|income|budget)/i;

function additiveMeasures() {
  return state.columns.filter(function (c) {
    if (c.type !== "number" || RE_IDLIKE.test(c.name) || RE_PERUNIT.test(c.name)) return false;
    const p = state.profile[c.name];
    return p && p.sum > 0 && p.n > 2;
  });
}

function primaryMeasure() {
  const m = additiveMeasures();
  if (!m.length) return null;
  const money = m.filter((c) => RE_MONEYISH.test(c.name));
  const pool = money.length ? money : m;
  return pool.slice().sort((a, b) => state.profile[b.name].sum - state.profile[a.name].sum)[0];
}

/* Text columns that actually group the data: a handful of repeated
   values, not a near-unique label per row. */
function dimensions() {
  const n = state.rows.length || 1;
  return state.columns
    .filter((c) => c.type === "text" && c.distinct >= 2 && c.distinct <= 25 && c.distinct <= n * 0.6)
    .sort((a, b) => a.distinct - b.distinct);
}

/* A column that identifies a row, for naming the record behind a number. */
function labelColumn() {
  const n = state.rows.length || 1;
  return state.columns.find((c) => c.type === "text" && /name|item|asset|title|product|description|label/i.test(c.name))
      || state.columns.find((c) => c.type === "text" && c.distinct > n * 0.6)
      || null;
}

function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return MON[Number(m[2]) - 1] + " " + m[1];
}

function listNames(keys, max) {
  const shown = keys.slice(0, max);
  if (keys.length <= max) {
    return shown.length > 1 ? shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1] : shown[0];
  }
  return shown.join(", ") + " and " + (keys.length - max) + " more";
}

function buildInsights() {
  const out = [];
  const rowN = state.rows.length || 1;
  const dims = dimensions();
  const dateCols = state.columns.filter((c) => c.type === "date");
  const measure = primaryMeasure();
  const measures = additiveMeasures();

  const add = (kind, severity, headline, detail, col) =>
    out.push({ kind: kind, severity: severity, headline: headline, detail: detail, col: col });

  /* ---- 1. Who leads, by name ---------------------------------- */
  if (measure && dims.length) {
    const dim = dims[dims.length - 1];
    const rows = aggregate({ groupBy: dim.name, measure: measure.name, agg: "sum", sort: "desc" });
    const total = rows.reduce((a, b) => a + b.value, 0);
    if (rows.length >= 2 && total > 0) {
      const top = rows[0], second = rows[1];
      const share = Math.round((top.value / total) * 100);
      add("leader", "high",
        top.key + " leads on " + measure.name,
        fmt(top.value) + " of " + fmt(total) + " total (" + share + "%), ahead of " +
        second.key + " at " + fmt(second.value),
        measure.name);

      /* ---- 2. How concentrated it is, in categories not rows ---- */
      if (rows.length >= 4) {
        let acc = 0, k = 0;
        for (const r of rows) { acc += r.value; k++; if (acc >= total * 0.8) break; }
        if (k < rows.length && k / rows.length <= 0.6) {
          add("concentration", "med",
            k + " of " + rows.length + " " + dim.name.toLowerCase() + " values carry 80% of " + measure.name,
            listNames(rows.slice(0, k).map((r) => r.key), 3) + ", so the rest move the total very little",
            measure.name);
        }
      }

      /* ---- 3. The weak end, which is usually the actionable one -- */
      const last = rows[rows.length - 1];
      if (rows.length >= 3 && last.value > 0 && top.value / last.value >= 3) {
        add("gap", "med",
          last.key + " is the weakest " + dim.name.toLowerCase() + " for " + measure.name,
          fmt(last.value) + " against " + fmt(top.value) + " for " + top.key +
          ", a gap of " + Math.round(top.value / last.value) + " times",
          measure.name);
      }
    }
  }

  /* ---- 4. One amount as a share of another -------------------- */
  const PARTS = [
    [/discount/i, /gross|list|revenue|sales/i],
    [/cogs|cost of goods/i, /sales|revenue/i],
    [/profit/i, /sales|revenue/i],
    [/tax|vat/i, /sales|revenue|total/i],
    [/refund|return/i, /sales|revenue/i],
    [/overtime/i, /hours|labour|labor/i],
  ];
  for (const pair of PARTS) {
    const part = measures.find((c) => pair[0].test(c.name));
    const whole = measures.find((c) => pair[1].test(c.name) && c.name !== (part || {}).name);
    if (!part || !whole) continue;
    const sp = state.profile[part.name].sum, sw = state.profile[whole.name].sum;
    if (!(sw > 0 && sp > 0 && sp < sw)) continue;
    const rate = (sp / sw) * 100;
    let extra = "";
    if (dims.length) {
      const dim = dims[dims.length - 1];
      const a = aggregate({ groupBy: dim.name, measure: part.name, agg: "sum", sort: "label" });
      const b = aggregate({ groupBy: dim.name, measure: whole.name, agg: "sum", sort: "label" });
      const bm = new Map(b.map((r) => [r.key, r.value]));
      const rates = a.map((r) => ({ key: r.key, v: bm.get(r.key) ? (r.value / bm.get(r.key)) * 100 : null }))
                     .filter((r) => r.v !== null).sort((x, y) => y.v - x.v);
      if (rates.length >= 2 && rates[0].v - rates[rates.length - 1].v > 1) {
        extra = ", highest in " + rates[0].key + " at " + rates[0].v.toFixed(1) + "% and lowest in " +
                rates[rates.length - 1].key + " at " + rates[rates.length - 1].v.toFixed(1) + "%";
      }
    }
    // Phrased so it reads correctly whether the column name is singular
    // or plural ("Discounts", "Profit", "Tax").
    const keeps = /profit|margin/i.test(part.name);
    add("ratio", "high",
      rate.toFixed(1) + "% of " + whole.name + (keeps ? " is kept as " : " goes to ") + part.name,
      fmt(sp) + " against " + fmt(sw) + extra, part.name);
    break;
  }

  /* ---- 5. Movement over time ---------------------------------- */
  if (measure && dateCols.length) {
    const dc = dateCols[0];
    const series = aggregate({ groupBy: dc.name, measure: measure.name, agg: "sum", sort: "date" })
                     .filter((r) => r.key !== "(blank)");
    if (series.length >= 3) {
      const peak = series.slice().sort((a, b) => b.value - a.value)[0];
      const low = series.slice().sort((a, b) => a.value - b.value)[0];
      const first = series[0], last = series[series.length - 1];
      const change = first.value ? ((last.value - first.value) / first.value) * 100 : 0;
      add("trend", "high",
        measure.name + " peaks in " + monthLabel(peak.key),
        fmt(peak.value) + " at the peak against " + fmt(low.value) + " in " + monthLabel(low.key) +
        ". From " + monthLabel(first.key) + " to " + monthLabel(last.key) + " it " +
        (change >= 0 ? "rose " : "fell ") + Math.abs(Math.round(change)) + "%",
        measure.name);
    }
  }

  /* ---- 6. The record behind the biggest number ---------------- */
  if (measure) {
    const p = state.profile[measure.name];
    const lab = labelColumn();
    if (p && p.median > 0 && p.max >= p.median * 4) {
      let who = null;
      if (lab) {
        let best = null;
        for (const r of state.rows) {
          const v = toNumber(r[measure.name]);
          if (v !== null && (best === null || v > best.v)) best = { v: v, name: r[lab.name] };
        }
        if (best && best.name) who = String(best.name);
      }
      add("extreme", "med",
        who ? (who + " is the single largest " + measure.name) : ("One row dominates " + measure.name),
        fmt(p.max) + " against a typical " + fmtFull(p.median) + ", about " +
        Math.round(p.max / p.median) + " times the middle of the range", measure.name);
    }
  }

  /* ---- 7. What a per-unit column typically looks like ---------- */
  const perUnit = state.columns.filter((c) => c.type === "number" && RE_PERUNIT.test(c.name) && !RE_IDLIKE.test(c.name));
  if (perUnit.length) {
    const c = perUnit[0], p = state.profile[c.name];
    if (p && p.n > 4 && p.max > p.min) {
      add("typical", "low",
        c.name + " is typically " + fmtFull(p.median),
        "half the values sit between " + fmtFull(p.q1) + " and " + fmtFull(p.q3) +
        ", across a full range of " + fmtFull(p.min) + " to " + fmtFull(p.max), c.name);
    }
  }

  /* ---- 8. Gaps in the file ------------------------------------ */
  const gaps = state.columns
    .map((c) => ({ c: c, missing: rowN - c.filled }))
    .filter((g) => g.missing / rowN >= 0.15)
    .sort((a, b) => b.missing - a.missing)
    .slice(0, 2);
  gaps.forEach(function (g) {
    const pctMissing = Math.round((g.missing / rowN) * 100);
    add("quality", g.missing / rowN > 0.5 ? "high" : "med",
      g.c.name + " is blank in " + pctMissing + "% of rows",
      g.missing + " of " + rowN + " rows carry no value, so anything grouped by it is incomplete", g.c.name);
  });

  /* ---- 9. Deadlines and flagged rows -------------------------- */
  const byName = (re) => state.columns.find((c) => re.test(c.name.toLowerCase()));
  const statusCol = byName(/status/), missingCol = byName(/missing.*doc/);
  const deadlineCol = dateCols.find((c) => /due|expiry|expire|next|renew|recert/i.test(c.name)) ||
    state.columns.find((c) => /estimated/i.test(c.name) && c.type === "date");

  if (deadlineCol) {
    const items = computeDeadlines({ series: deadlineCol.name, groupBy: (byName(/name/) || {}).name });
    const overdue = items.filter((d) => d.days < 0);
    const soon = items.filter((d) => d.days >= 0 && d.days <= 30);
    if (overdue.length) {
      const worst = overdue.slice().sort((a, b) => a.days - b.days)[0];
      add("compliance", "high",
        overdue.length + " item" + (overdue.length > 1 ? "s are" : " is") + " past due on " + deadlineCol.name,
        worst && worst.key ? (worst.key + " is the furthest behind, " + Math.abs(worst.days) + " days over")
                           : "check these before anything else", deadlineCol.name);
    }
    if (soon.length) {
      add("compliance", "med",
        soon.length + " item" + (soon.length > 1 ? "s fall" : " falls") + " due within 30 days",
        "on " + deadlineCol.name + ", so they are the next things to schedule", deadlineCol.name);
    }
  }
  if (statusCol) {
    const bad = state.rows.filter((r) => /expired|overdue|fail|not good/i.test(String(r[statusCol.name] || ""))).length;
    if (bad) add("compliance", "high",
      bad + " row" + (bad > 1 ? "s are" : " is") + " flagged in " + statusCol.name,
      Math.round((bad / rowN) * 100) + "% of the file needs attention", statusCol.name);
  }
  if (missingCol) {
    const p = state.profile[missingCol.name];
    if (p && p.sum > 0) {
      const withMissing = state.rows.filter((r) => (toNumber(r[missingCol.name]) || 0) > 0).length;
      add("compliance", withMissing / rowN > 0.4 ? "high" : "med",
        withMissing + " of " + rowN + " items have missing documents",
        p.sum + " documents outstanding in total", missingCol.name);
    }
  }

  /* ---- 10. Two columns that track each other ------------------ */
  const numCols = state.columns.filter((c) => c.type === "number" && !RE_IDLIKE.test(c.name));
  outer:
  for (let i = 0; i < numCols.length; i++) {
    for (let j = i + 1; j < numCols.length; j++) {
      const corr = correlation(numCols[i].name, numCols[j].name);
      if (corr && Math.abs(corr.r) >= 0.6 && Math.abs(corr.r) < 0.95) {
        add("correlation", "low",
          numCols[i].name + " and " + numCols[j].name +
          (corr.r > 0 ? " rise and fall together" : " move in opposite directions"),
          "correlation of " + corr.r.toFixed(2) + " across " + corr.n + " rows, so one largely explains the other",
          numCols[i].name);
        break outer;
      }
    }
  }

  /* ---- rank, then keep the panel readable --------------------- */
  const ORDER = { compliance: 0, leader: 1, ratio: 2, trend: 3, concentration: 4,
                  gap: 5, extreme: 6, quality: 7, typical: 8, correlation: 9 };
  out.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) ||
                     ({ high: 0, med: 1, low: 2 }[a.severity] - { high: 0, med: 1, low: 2 }[b.severity]));

  // No more than two findings leaning on the same column, so one busy
  // column can't crowd out everything else.
  function capPerColumn(limit) {
    const seen = {}, kept = [];
    for (const it of out) {
      const key = it.col || "_";
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] <= limit) kept.push(it);
    }
    return kept;
  }
  // Two findings per column keeps a busy column from crowding the panel,
  // but a file with only one real measure would be left with almost
  // nothing, so loosen the cap rather than show a near-empty panel.
  let kept = capPerColumn(2);
  if (kept.length < 4) kept = capPerColumn(4);
  state.insights = kept;
}

function runAnalysis() {
  buildProfile();
  buildInsights();
}

function ingestRows(rows, opts) {
  opts = opts || {};
  state.rows = (rows || []).map(cleanRow);
  estimateDueDatesFromFrequency(state.rows);

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

  runAnalysis();

  const saved = opts.restoreLayout === false ? null : loadLayout();
  if (saved && saved.charts && saved.charts.length) {
    state.charts = saved.charts;
    if (saved.title) state.boardTitle = saved.title;
    state.activeTemplate = saved.template || null;
  } else {
    const tmpl = detectTemplate(state.columns);
    state.activeTemplate = tmpl ? tmpl.label : null;
    state.charts = tmpl ? tmpl.build(state.columns) : autoCharts();
  }
  renderAll();
}

/* ---------- shared UI wiring ----------
   Everything both pages share: the editor modal, add/reset/print
   buttons, and the editable dashboard title.                      */
/* Styles for the engine's own components (cross-filter, new visuals).
   Injected once so every page using engine.js gets them automatically. */
function injectEngineStyles() {
  if (document.getElementById("engine-styles")) return;
  const css = `
    .clickable{ cursor:pointer; transition:opacity .15s, filter .15s; }
    .clickable:hover{ opacity:.82; }
    g.clickable.active rect, path.clickable.active{ stroke:var(--ink); stroke-width:2; }
    tr.clickable.active td{ background:var(--cyan-soft); }
    .prog-row.clickable.active .prog-name{ color:var(--teal); font-weight:600; }
    .prog-row.dimmed-row{ opacity:.35; }
    #filter-bar{
      display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      background:var(--surface); border:1px solid var(--cyan); border-radius:var(--radius);
      padding:9px 14px; margin-bottom:16px; font-size:12.5px;
    }
    #filter-bar .fb-label{ color:var(--ink-dim); }
    #filter-bar b{ color:var(--teal); }
    #filter-bar .fb-count{ color:var(--ink-faint); font-size:11.5px; margin-left:4px; }
    #filter-bar .fb-clear{ margin-left:auto; padding:6px 12px; font-size:12px; }
    .tm-lbl{ fill:#fff; font-size:12px; font-weight:600; font-family:var(--sans); }
    .tm-val{ fill:rgba(255,255,255,0.88); font-size:10.5px; font-family:var(--mono); }
    .fn-lbl{ fill:#fff; font-size:11.5px; font-weight:500; font-family:var(--sans); }
    .hm-table td.hm-cell{ text-align:center; color:var(--ink); }
    .hm-table th{ text-align:center; }
    .hm-table th:first-child, .hm-table td:first-child{ text-align:left; }
    #insights-panel{
      background:var(--surface); border:1px solid var(--line); border-radius:var(--radius);
      box-shadow:var(--shadow); padding:18px 20px 16px; margin-bottom:18px;
    }
    #insights-panel .ins-head{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:14px; }
    #insights-panel .ins-title{ font-size:14px; font-weight:600; letter-spacing:-0.01em; }
    #insights-panel .ins-sub{
      font-family:var(--mono); font-size:10px; letter-spacing:.12em;
      text-transform:uppercase; color:var(--ink-3);
    }
    #insights-panel .ins-list{ display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px 28px; }
    #insights-panel .ins-item{ display:flex; align-items:flex-start; gap:10px; }
    #insights-panel .ins-dot{
      flex:0 0 auto; width:7px; height:7px; border-radius:2px; margin-top:6px;
      background:var(--ink-3);
    }
    #insights-panel .sev-high .ins-dot{ background:var(--magenta); }
    #insights-panel .sev-med .ins-dot{ background:var(--amber); }
    #insights-panel .sev-low .ins-dot{ background:var(--cyan); }
    #insights-panel .ins-text{ min-width:0; }
    #insights-panel .ins-text b{ display:block; font-size:13px; font-weight:600; color:var(--ink); line-height:1.4; }
    #insights-panel .ins-detail{
      display:block; font-size:12px; color:var(--ink-2); line-height:1.5; margin-top:3px;
    }`;
  const style = document.createElement("style");
  style.id = "engine-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function initEditorUI() {
  injectEngineStyles();
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
      document.title = state.boardTitle ? state.boardTitle + " | SEVEN" : "SEVEN";
    });
    titleInput.addEventListener("blur", saveLayout);
    titleInput.addEventListener("keydown", function (e) { if (e.key === "Enter") titleInput.blur(); });
  }
}
