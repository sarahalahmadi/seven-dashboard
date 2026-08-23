/* ============================================================
   SEVEN — Visualizer (file upload page)
   Reads an uploaded Excel/CSV, hands the rows to the shared
   dashboard engine (engine.js), which does the rest.
   ============================================================ */

function loadWorkbook(wb) {
  state.wb = wb;
  state.sheetNames = wb.SheetNames.slice();
  let best = wb.SheetNames[0], bestRows = -1;
  for (const name of wb.SheetNames) {
    const n = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }).length;
    if (n > bestRows) { bestRows = n; best = name; }
  }
  selectSheet(best);
}

function selectSheet(name) {
  state.activeSheet = name;
  const aoa = XLSX.utils.sheet_to_json(state.wb.Sheets[name], { header: 1, defval: "" });

  // Find the header row: the row with the most filled, text-like cells.
  let headerIdx = 0, bestScore = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i] || [];
    const filled = row.filter((c) => c !== "" && c !== null).length;
    const textish = row.filter((c) => typeof c === "string" && c.trim() !== "").length;
    if (filled + textish > bestScore) { bestScore = filled + textish; headerIdx = i; }
  }

  const seen = {};
  const headers = (aoa[headerIdx] || []).map(function (h, i) {
    let base = (h === "" || h === null) ? "Column " + (i + 1) : String(h).trim();
    if (seen[base]) { seen[base]++; base = base + " (" + seen[base] + ")"; } else seen[base] = 1;
    return base;
  });

  const rows = aoa.slice(headerIdx + 1)
    .filter((r) => r.some((c) => c !== "" && c !== null))
    .map(function (r) {
      const o = {};
      headers.forEach(function (h, i) { o[h] = r[i] === undefined ? "" : r[i]; });
      return o;
    });

  ingestRows(rows);
}

function handleFile(file) {
  state.fileName = file.name;
  state.boardTitle = prettifyFileName(file.name);
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      loadWorkbook(XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: false }));
    } catch (err) {
      alert("Sorry — I couldn't read that file. Make sure it's a valid .xlsx, .xls, or .csv.\n\n" + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

document.addEventListener("DOMContentLoaded", function () {
  const fileInput = document.getElementById("file-input");
  const drop = document.getElementById("drop-zone");

  document.getElementById("upload-btn").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); });

  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", function (e) { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  document.getElementById("sheet-select").addEventListener("change", function (e) { selectSheet(e.target.value); });

  initEditorUI();
});
