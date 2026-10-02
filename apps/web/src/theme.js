(function () {
  // Night felt is the default look (that's the table most people play on
  // after dark) — only an explicit "light" choice opts into the day-felt
  // variant. Set before paint to avoid a flash of the wrong theme.
  const saved = localStorage.getItem("no-chip-theme");
  if (saved !== "light") document.documentElement.setAttribute("data-theme", "dark");

  window.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;

    function applyTheme(theme) {
      if (theme === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        btn.textContent = "☀️";
        btn.title = "Switch to day felt";
      } else {
        document.documentElement.removeAttribute("data-theme");
        btn.textContent = "🌙";
        btn.title = "Switch to night felt";
      }
    }

    applyTheme(saved || "dark");
    btn.addEventListener("click", function () {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      const next = isDark ? "light" : "dark";
      localStorage.setItem("no-chip-theme", next);
      applyTheme(next);
    });
  });
})();
