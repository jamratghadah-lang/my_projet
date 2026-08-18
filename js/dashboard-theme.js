(function () {
  const KEY = "jg-dashboard-mode";
  const root = document.documentElement;
  const saved = localStorage.getItem(KEY) || "light";
  root.setAttribute("data-mode", saved === "dark" ? "dark" : "light");

  function setMode(mode) {
    mode = mode === "dark" ? "dark" : "light";
    root.setAttribute("data-mode", mode);
    localStorage.setItem(KEY, mode);
    const btn = document.getElementById("dashboardModeToggle");
    if (btn) {
      btn.textContent = mode === "dark" ? "☀️" : "🌙";
      btn.setAttribute("aria-label", mode === "dark" ? "تفعيل الوضع النهاري" : "تفعيل الوضع الليلي");
      btn.title = mode === "dark" ? "الوضع النهاري" : "الوضع الليلي";
    }
  }

  function ensureToggle() {
    let btn = document.getElementById("dashboardModeToggle");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "dashboardModeToggle";
      btn.type = "button";
      btn.className = "dashboard-mode-toggle";
      document.body.appendChild(btn);
    }
    if (!btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        setMode(root.getAttribute("data-mode") === "dark" ? "light" : "dark");
      });
    }
    setMode(root.getAttribute("data-mode") || "light");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureToggle, { once: true });
  } else {
    ensureToggle();
  }
})();
