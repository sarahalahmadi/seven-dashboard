/* ============================================================
   SEVEN — Live (SeaTable page)
   Two ways in:
     1. Scheduled snapshot — reads a JSON file in this repo that a
        GitHub Action refreshes. The token stays in GitHub Secrets
        and never reaches a browser. This is the safe default.
     2. Direct connect — the user supplies the server, token and
        table in their own browser. Nothing is written into the
        site's code. Only works if SeaTable allows browser access.
   Either way the rows go to the shared engine (engine.js).
   ============================================================ */

const LIVE_CFG = "seven-live-config";
let liveSource = null;   // { mode, ... } — how to refresh
let autoTimer = null;

/* ---------- small UI helpers ---------- */
function setStatus(el, msg, kind) {
  const n = document.getElementById(el);
  n.textContent = msg || "";
  n.className = "status" + (kind ? " " + kind : "");
}

function showBoard(sourceLabel) {
  document.getElementById("empty-state").style.display = "none";
  document.getElementById("board").style.display = "";
  document.getElementById("live-dot").style.display = "";
  document.getElementById("refresh-btn").style.display = "";
  document.getElementById("connect-top-btn").style.display = "";
  document.getElementById("file-name").textContent = sourceLabel;
}

function showConnect() {
  document.getElementById("empty-state").style.display = "";
  document.getElementById("board").style.display = "none";
  document.getElementById("live-dot").style.display = "none";
  document.getElementById("refresh-btn").style.display = "none";
  document.getElementById("connect-top-btn").style.display = "none";
}

function stamp(when) {
  const d = when ? new Date(when) : new Date();
  document.getElementById("updated-stamp").textContent =
    "Updated " + d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- mode 1: scheduled snapshot ---------- */
async function loadSnapshot(path, silent) {
  if (!silent) setStatus("snap-status", "Loading…");
  try {
    // Cache-bust so a refreshed snapshot is picked up immediately.
    const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("Couldn't find " + path + " (HTTP " + res.status + ")");
    const payload = await res.json();

    // Accept either a bare array of rows, or { rows, generated_at, source }.
    const rows = Array.isArray(payload) ? payload : payload.rows;
    if (!Array.isArray(rows) || !rows.length) throw new Error("That file has no rows in it.");

    liveSource = { mode: "snapshot", path: path };
    state.fileName = (payload && payload.source) ? payload.source : path;
    if (!state.boardTitle) state.boardTitle = prettifyFileName(state.fileName.split("/").pop());
    state.activeSheet = "live";

    showBoard(state.fileName);
    ingestRows(rows);
    stamp(payload && payload.generated_at);
    saveConfig();
  } catch (err) {
    if (!silent) setStatus("snap-status", err.message, "err");
    else console.warn("Snapshot refresh failed:", err.message);
  }
}

/* ---------- mode 2: direct connect ---------- */
async function seatableFetch(server, token, tableName, silent) {
  server = server.replace(/\/+$/, "");

  // Step 1 — an API token only gets you a short-lived base token.
  const authRes = await fetch(server + "/api/v2.1/dtable/app-access-token/", {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  if (!authRes.ok) {
    if (authRes.status === 401 || authRes.status === 403) throw new Error("That token was rejected. Check it's the base's API token and still valid.");
    throw new Error("Couldn't authenticate (HTTP " + authRes.status + ")");
  }
  const auth = await authRes.json();

  // Step 2 — use the base token to read the rows.
  const base = (auth.dtable_server || server).replace(/\/+$/, "");
  const url = base + "/api/v1/dtables/" + auth.dtable_uuid + "/rows/?table_name=" + encodeURIComponent(tableName) + "&limit=10000";
  const rowsRes = await fetch(url, {
    headers: { Authorization: "Bearer " + auth.access_token, Accept: "application/json" },
  });
  if (!rowsRes.ok) {
    if (rowsRes.status === 404) {
      // Don't just say "not found" — show what this token can actually
      // see, so a wrong-base mistake is obvious rather than a mystery.
      let hint = "";
      try {
        const metaRes = await fetch(base + "/api/v1/dtables/" + auth.dtable_uuid + "/metadata/", {
          headers: { Authorization: "Bearer " + auth.access_token, Accept: "application/json" },
        });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          const names = (meta.metadata && meta.metadata.tables || []).map((t) => t.name);
          hint = names.length
            ? " This token can see: " + names.map((n) => '"' + n + '"').join(", ") + ". If \"" + tableName + "\" isn't in that list, this token was created inside a different base."
            : " This token's base has no tables at all.";
        }
      } catch (e) { /* metadata lookup is best-effort — fall through to the plain message */ }
      throw new Error('No table called "' + tableName + '" in that base.' + hint);
    }
    throw new Error("Couldn't read the table (HTTP " + rowsRes.status + ")");
  }
  const data = await rowsRes.json();
  return data.rows || [];
}

async function connectDirect(silent) {
  const server = document.getElementById("st-server").value.trim();
  const token = document.getElementById("st-token").value.trim();
  const table = document.getElementById("st-table").value.trim();
  const remember = document.getElementById("st-remember").checked;

  if (!server || !token || !table) {
    setStatus("st-status", "Fill in the server, token and table name.", "err");
    return;
  }
  setStatus("st-status", "Connecting…");
  try {
    const raw = await seatableFetch(server, token, table, silent);
    if (!raw.length) throw new Error("That table came back empty.");

    // Drop SeaTable's internal bookkeeping columns.
    const rows = raw.map(function (r) {
      const o = {};
      Object.keys(r).forEach(function (k) { if (k.charAt(0) !== "_") o[k] = r[k]; });
      return o;
    });

    liveSource = { mode: "direct", server: server, table: table, token: remember ? token : null };
    state.fileName = table + " · SeaTable";
    if (!state.boardTitle) state.boardTitle = table;
    state.activeSheet = "seatable:" + table;

    showBoard(state.fileName);
    ingestRows(rows);
    stamp();
    setStatus("st-status", "", "ok");
    saveConfig();
  } catch (err) {
    const cors = /Failed to fetch|NetworkError|Load failed/i.test(err.message);
    setStatus("st-status", cors
      ? "Your browser couldn't reach SeaTable directly — it's likely blocking cross-site requests. Use the scheduled snapshot instead."
      : err.message, "err");
  }
}

/* ---------- refresh ---------- */
async function refreshNow(silent) {
  if (!liveSource) return;
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  const savedTitle = state.boardTitle;
  try {
    if (liveSource.mode === "snapshot") {
      await loadSnapshot(liveSource.path, silent);
    } else {
      await connectDirect(silent);
    }
    state.boardTitle = savedTitle;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- remembering the connection ---------- */
function saveConfig() {
  try {
    if (!liveSource) return;
    localStorage.setItem(LIVE_CFG, JSON.stringify(liveSource));
  } catch (e) { /* storage unavailable */ }
}
function readConfig() {
  try { return JSON.parse(localStorage.getItem(LIVE_CFG) || "null"); } catch (e) { return null; }
}
function forgetConfig() {
  try { localStorage.removeItem(LIVE_CFG); } catch (e) { /* ignore */ }
}

/* ---------- wiring ---------- */
document.addEventListener("DOMContentLoaded", function () {
  initEditorUI();

  // mode tabs
  Array.prototype.forEach.call(document.querySelectorAll(".mode-tab"), function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".mode-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".mode-body").forEach(function (b) { b.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("mode-" + tab.getAttribute("data-mode")).classList.add("active");
    });
  });

  document.getElementById("snap-load").addEventListener("click", function () {
    loadSnapshot(document.getElementById("snap-path").value.trim() || "data/live.json");
  });
  document.getElementById("st-connect").addEventListener("click", function () { connectDirect(false); });
  document.getElementById("refresh-btn").addEventListener("click", function () { refreshNow(false); });
  document.getElementById("connect-top-btn").addEventListener("click", showConnect);
  document.getElementById("disconnect-btn").addEventListener("click", function () {
    if (!confirm("Disconnect from this data source? Your saved chart layout is kept.")) return;
    forgetConfig();
    liveSource = null;
    if (autoTimer) clearInterval(autoTimer);
    showConnect();
  });

  // Reconnect automatically if we've been here before.
  const cfg = readConfig();
  if (cfg && cfg.mode === "snapshot") {
    document.getElementById("snap-path").value = cfg.path;
    loadSnapshot(cfg.path, true);
  } else if (cfg && cfg.mode === "direct") {
    document.getElementById("st-server").value = cfg.server || "";
    document.getElementById("st-table").value = cfg.table || "";
    if (cfg.token) {
      document.getElementById("st-token").value = cfg.token;
      document.getElementById("st-remember").checked = true;
      connectDirect(true);
    } else {
      document.querySelector('.mode-tab[data-mode="direct"]').click();
      setStatus("st-status", "Enter your token to reconnect.");
    }
  }

  // Quietly re-check for new data every 5 minutes.
  autoTimer = setInterval(function () { if (liveSource) refreshNow(true); }, 5 * 60 * 1000);
});
