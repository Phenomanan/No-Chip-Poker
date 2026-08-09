(function () {
  const saved = localStorage.getItem("no-chip-theme");
  if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");

  window.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;

    function applyTheme(theme) {
      if (theme === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        btn.textContent = "☀️";
        btn.title = "Switch to light mode";
      } else {
        document.documentElement.removeAttribute("data-theme");
        btn.textContent = "🌙";
        btn.title = "Switch to dark mode";
      }
    }

    applyTheme(saved || "light");
    btn.addEventListener("click", function () {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      const next = isDark ? "light" : "dark";
      localStorage.setItem("no-chip-theme", next);
      applyTheme(next);
    });
  });
})();
