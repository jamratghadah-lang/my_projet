// يعرض بيانات صفحة تأكيد الحضور (الأسماء / التاريخ / الموقع / الظرف أو الباب أو الفيديو /
// صور الدعوة / الزخارف / التايم لاين) من content/rsvp/<slug>.json
// وربط نموذج التأكيد بـ Formspree.
// كل تعديل يصير من لوحة التحكم (/admin) بدون لمس هذا الملف أو ملفات HTML.
(function () {
  const scriptTag = document.currentScript;
  const slug = scriptTag.dataset.slug;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function renderEnvelope(container, d) {
    if (!container) return;
    container.innerHTML = "";
    if (d.envelope_type === "video_direct" && d.intro_video) {
      const v = document.createElement("video");
      v.src = d.intro_video;
      v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
      v.style.maxWidth = "420px"; v.style.width = "100%"; v.style.borderRadius = "6px";
      container.appendChild(v);
    } else if (d.envelope_image) {
      const img = document.createElement("img");
      img.src = d.envelope_image;
      img.alt = d.envelope_type === "door" ? "باب الدعوة" : "ظرف الدعوة";
      img.style.maxWidth = "360px"; img.style.width = "100%";
      container.appendChild(img);
    }
  }

  function renderGallery(container, images) {
    if (!container) return;
    container.innerHTML = "";
    if (!images || !images.length) return;
    images.forEach(src => {
      if (!src) return;
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      img.style.width = "100%";
      img.style.borderRadius = "4px";
      container.appendChild(img);
    });
  }

  function renderDecorations(container, images) {
    if (!container) return;
    container.innerHTML = "";
    if (!images || !images.length) return;
    images.forEach(src => {
      if (!src) return;
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      img.className = "decor-img";
      container.appendChild(img);
    });
  }

  function renderTimeline(container, items) {
    if (!container) return;
    container.innerHTML = "";
    const list = (items || []).filter(it => it && (it.time || it.event));
    if (!list.length) return;
    list.forEach(it => {
      const row = el("div", "tl-row");
      row.appendChild(el("span", "tl-time", it.time || ""));
      row.appendChild(el("span", "tl-event", it.event || ""));
      container.appendChild(row);
    });
  }

  const FONT_STACKS = {
    "Aref Ruqaa": "'Aref Ruqaa', serif",
    "Amiri": "'Amiri', serif",
    "Cairo": "'Cairo', sans-serif",
    "Tajawal": "'Tajawal', sans-serif",
    "Reem Kufi": "'Reem Kufi', sans-serif",
    "Lalezar": "'Lalezar', cursive",
    "Rakkas": "'Rakkas', cursive",
    "Markazi Text": "'Markazi Text', serif"
  };
  const SCALE_MAP = { small: 0.85, medium: 1, large: 1.18, xlarge: 1.35 };

  function loadGoogleFont(family) {
    if (!family) return;
    const id = "jg-google-font-" + family.replace(/\s+/g, "-");
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family) + ":wght@400;500;700&display=swap";
    document.head.appendChild(link);
  }

  function applyScale(el, factor) {
    if (!el || !factor || factor === 1) return;
    const current = parseFloat(getComputedStyle(el).fontSize) || 16;
    el.style.fontSize = (current * factor) + "px";
  }

  function applyDesign(design) {
    if (!design) return;
    const targets = [
      document.getElementById("rsvp-names"),
      document.getElementById("rsvp-date"),
      document.getElementById("rsvp-location"),
      document.getElementById("rsvp-welcome"),
      ...document.querySelectorAll("#rsvp-timeline .tl-time, #rsvp-timeline .tl-event")
    ].filter(Boolean);

    if (design.font_family && FONT_STACKS[design.font_family]) {
      loadGoogleFont(design.font_family);
      targets.forEach(el => { el.style.fontFamily = FONT_STACKS[design.font_family]; });
    }
    if (design.font_scale && SCALE_MAP[design.font_scale]) {
      targets.forEach(el => applyScale(el, SCALE_MAP[design.font_scale]));
    }
  }

  function wireForm(form, d, settings) {
    if (!form) return;
    const endpoint = d.formspree_override || (settings && settings.formspree_id) || "";
    if (!endpoint) return;
    form.action = endpoint;
    form.method = "POST";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const status = document.getElementById("rsvp-form-status");
      fetch(endpoint, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" }
      }).then(r => {
        if (r.ok) {
          form.style.display = "none";
          if (status) { status.style.display = "block"; status.textContent = "تم استلام تأكيدكم، شكرًا لكم."; }
        } else if (status) {
          status.style.display = "block";
          status.textContent = "حدث خطأ، حاولي مرة أخرى.";
        }
      }).catch(() => {
        if (status) { status.style.display = "block"; status.textContent = "حدث خطأ، حاولي مرة أخرى."; }
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    Promise.all([
      fetch("../content/rsvp/" + slug + ".json").then(r => r.json()).catch(() => ({})),
      fetch("../content/settings.json").then(r => r.json()).catch(() => ({}))
    ]).then(([d, settings]) => {
      if (d.names) document.getElementById("rsvp-names").textContent = d.names;
      if (d.welcome_message) {
        const wEl = document.getElementById("rsvp-welcome");
        if (wEl) { wEl.textContent = d.welcome_message; wEl.style.display = "block"; }
      }
      if (d.date) { const e = document.getElementById("rsvp-date"); if (e) e.textContent = "📅 " + d.date; }
      if (d.location) { const e = document.getElementById("rsvp-location"); if (e) e.textContent = "📍 " + d.location; }

      renderEnvelope(document.getElementById("rsvp-envelope"), d);
      renderGallery(document.getElementById("rsvp-gallery"), d.gallery);
      renderDecorations(document.getElementById("rsvp-decorations"), d.decorations);
      renderTimeline(document.getElementById("rsvp-timeline"), d.timeline);
      wireForm(document.getElementById("rsvp-form"), d, settings);
      applyDesign(d.design);
    });
  });
})();
