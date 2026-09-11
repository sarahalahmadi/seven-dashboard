/* ============================================================
   SEVEN Dashboards: hover tooltips.

   The browser's own tooltip (the <title> element) takes about a
   second to appear, cannot be styled, and never shows on a touch
   screen. This replaces it with a card that follows the pointer.

   Any element carrying data-tip gets one. Use "|" to split the
   headline from the lines underneath:

     data-tip="Bowling|48% complete|95 items"
   ============================================================ */

(function () {
  let tip = null, raf = 0, lastX = 0, lastY = 0;

  function build() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "tipcard";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tip);
    return tip;
  }

  function show(el) {
    const raw = el.getAttribute("data-tip");
    if (!raw) return;
    const parts = raw.split("|");
    const t = build();
    t.innerHTML =
      '<span class="tip-head"></span>' +
      parts.slice(1).map(function () { return '<span class="tip-line"></span>'; }).join("");
    // set as text, never as markup: the values come from the user's own file
    t.querySelector(".tip-head").textContent = parts[0];
    const lines = t.querySelectorAll(".tip-line");
    for (let i = 0; i < lines.length; i++) lines[i].textContent = parts[i + 1];
    t.classList.add("on");
    t.setAttribute("aria-hidden", "false");
    place();
  }

  function hide() {
    if (!tip) return;
    tip.classList.remove("on");
    tip.setAttribute("aria-hidden", "true");
  }

  function place() {
    if (!tip) return;
    const pad = 14, r = tip.getBoundingClientRect();
    let x = lastX + pad, y = lastY + pad;
    if (x + r.width > window.innerWidth - 8) x = lastX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = lastY - r.height - pad;
    tip.style.transform = "translate(" + Math.max(8, x) + "px," + Math.max(8, y) + "px)";
  }

  document.addEventListener("pointerover", function (e) {
    const el = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (el) { lastX = e.clientX; lastY = e.clientY; show(el); }
  });

  document.addEventListener("pointerout", function (e) {
    const el = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (el && !el.contains(e.relatedTarget)) hide();
  });

  document.addEventListener("pointermove", function (e) {
    lastX = e.clientX; lastY = e.clientY;
    if (!tip || !tip.classList.contains("on")) return;
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; place(); });
  });

  // Anything that moves the page out from under the pointer dismisses it.
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  window.addEventListener("beforeprint", hide);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
})();
