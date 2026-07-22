// يحمّل الهيدر والفوتر المشتركين في كل صفحة، عشان أي تعديل بالقائمة
// أو التواصل الاجتماعي يصير مكان وحد بس: partials/header.html و partials/footer.html
// ===== الوضع الداكن/الفاتح — يُطبَّق فورًا لتفادي وميض الألوان =====
(function () {
  const saved = localStorage.getItem("jg-mode") || "light";
  document.documentElement.setAttribute("data-mode", saved);
})();

function applyMode(mode) {
  document.documentElement.setAttribute("data-mode", mode);
  localStorage.setItem("jg-mode", mode);
  const btn = document.getElementById("mode-toggle");
  if (btn) btn.textContent = mode === "dark" ? "☀️" : "🌙";
  document.querySelectorAll(".site-bg-video video").forEach(v => {
    v.classList.toggle("is-active", v.dataset.mode === mode);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  applyMode(localStorage.getItem("jg-mode") || "light");
  document.body.addEventListener("click", (e) => {
    if (e.target && e.target.id === "mode-toggle") {
      const current = localStorage.getItem("jg-mode") || "light";
      applyMode(current === "light" ? "dark" : "light");
    }
  });
});

document.addEventListener("DOMContentLoaded", () => {
  const root = document.body.dataset.root || "";

  const inject = (sel, url) => {
    const el = document.querySelector(sel);
    if (!el) return;
    fetch(root + url)
      .then(r => r.text())
      .then(html => {
        el.innerHTML = html.replaceAll("__ROOT__", root);
        if (sel === "#site-header") initNav();
      })
      .catch(() => {});
  };

  inject("#site-header", "partials/header.html");
  inject("#site-footer", "partials/footer.html");

  function initNav() {
    const toggle = document.querySelector(".nav-toggle");
    const list = document.querySelector("nav.main-nav ul");
    const backdrop = document.getElementById("nav-backdrop");

    const openNav = () => {
      list.classList.add("open");
      if (backdrop) backdrop.classList.add("show");
      document.body.classList.add("nav-open");
      toggle.textContent = "✕";
    };
    const closeNav = () => {
      list.classList.remove("open");
      if (backdrop) backdrop.classList.remove("show");
      document.body.classList.remove("nav-open");
      toggle.textContent = "☰";
    };

    if (toggle && list) {
      toggle.addEventListener("click", () => {
        list.classList.contains("open") ? closeNav() : openNav();
      });
    }
    if (backdrop) backdrop.addEventListener("click", closeNav);
    if (list) {
      list.querySelectorAll("a").forEach(a => a.addEventListener("click", closeNav));
    }
    // تفعيل الرابط الحالي
    const current = document.body.dataset.page;
    if (current) {
      document.querySelectorAll("nav.main-nav a").forEach(a => {
        if (a.dataset.page === current) a.classList.add("active");
      });
    }
    applyLang(localStorage.getItem("jg-lang") || "ar");
  }
});

// ===== نظام ثنائية اللغة (عربي/إنجليزي) =====
// أي عنصر فيه data-ar و data-en يتبدّل نصه تلقائياً حسب اللغة المختارة.
// اللغة تُحفظ في localStorage تحت مفتاح jg-lang وتنطبق على كل صفحات الموقع.
function applyLang(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
  document.querySelectorAll("[data-ar]").forEach(el => {
    const txt = lang === "en" ? el.getAttribute("data-en") : el.getAttribute("data-ar");
    if (txt !== null) el.textContent = txt;
  });
  document.querySelectorAll("[data-ar-ph]").forEach(el => {
    const txt = lang === "en" ? el.getAttribute("data-en-ph") : el.getAttribute("data-ar-ph");
    if (txt !== null) el.setAttribute("placeholder", txt);
  });
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.textContent = lang === "en" ? "AR" : "EN";
  localStorage.setItem("jg-lang", lang);
}
document.addEventListener("DOMContentLoaded", () => {
  applyLang(localStorage.getItem("jg-lang") || "ar");
  document.body.addEventListener("click", (e) => {
    if (e.target && e.target.id === "lang-toggle") {
      const current = localStorage.getItem("jg-lang") || "ar";
      applyLang(current === "ar" ? "en" : "ar");
    }
  });
});

// نموذج طلب الفيديو داخل صفحات الأقسام
function initOrderForm(paymentLink) {
  const form = document.getElementById("order-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const num = document.getElementById("video-number").value.trim();
    if (!num) return;
    const link = paymentLink && paymentLink !== "PAYMENT_LINK_PLACEHOLDER"
      ? paymentLink
      : `https://wa.me/966547266733?text=${encodeURIComponent("مرحبا، أبي أطلب الفيديو رقم " + num)}`;
    window.open(link, "_blank");
  });
}
