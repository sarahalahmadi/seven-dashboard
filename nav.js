/* ============================================================
   SEVEN Dashboards: header navigation.

   Shared by all three dashboards so they cannot drift apart.
   The brand lockup is the way home; the page name opens a menu
   for jumping straight to another dashboard without going back
   through the portal first.
   ============================================================ */

(function () {
  const btn = document.getElementById("switch-btn");
  const menu = document.getElementById("switch-menu");
  if (!btn || !menu) return;

  const wrap = btn.parentNode;

  function open() {
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    const first = menu.querySelector('[role="menuitem"]:not(.current)');
    if (first) first.focus();
  }

  function close(refocus) {
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }

  const isOpen = () => wrap.classList.contains("open");

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    isOpen() ? close() : open();
  });

  // Anywhere else on the page closes it.
  document.addEventListener("click", function (e) {
    if (isOpen() && !wrap.contains(e.target)) close();
  });

  document.addEventListener("keydown", function (e) {
    if (!isOpen()) return;
    if (e.key === "Escape") { close(true); return; }

    const items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = items[(i + step + items.length) % items.length] || items[0];
      next.focus();
    }
  });
})();
