// js/entry-card.js
// بطاقة الدخول الفاخرة — تظهر تلقائيًا بعد تأكيد الضيف حضوره في أي صفحة rsvp/*.html
// (مستقلة تمامًا عن jamrat-app). تُقرأ إعداداتها من نفس content/rsvp/<slug>.json
// تحت مفتاح "entry_card" — خط، خلفية، شعار، والكلمة المكتوبة — كلها من لوحة التحكم.
//
// يُفعَّل بحدث "jg:rsvp-success" يُطلقه فورم كل صفحة بعد نجاح الإرسال، مع تمرير
// اسم الضيف الذي كتبه بنفسه في الفورم ليظهر مطبوعًا على بطاقته.
(function () {
  let lastWallSubmitTime = 0;
  const WALL_SUBMIT_COOLDOWN = 10000; // 10 seconds

  const FONT_MAP = {
    "Aref Ruqaa": { css: "'Aref Ruqaa', serif", google: "Aref+Ruqaa:wght@400;700" },
    "Amiri": { css: "'Amiri', serif", google: "Amiri:wght@400;700" },
    "Cairo": { css: "'Cairo', sans-serif", google: "Cairo:wght@400;700" },
    "Tajawal": { css: "'Tajawal', sans-serif", google: "Tajawal:wght@400;700" },
    "Reem Kufi": { css: "'Reem Kufi', sans-serif", google: "Reem+Kufi:wght@400;700" },
    "Lalezar": { css: "'Lalezar', cursive", google: "Lalezar" },
    "Rakkas": { css: "'Rakkas', cursive", google: "Rakkas" },
    "Markazi Text": { css: "'Markazi Text', serif", google: "Markazi+Text:wght@400;700" },
  };

  function optimizeImg(url) {
    if (!url || !url.includes("sirv.com")) return url;
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "format=webp&q=85";
  }

  function loadFont(name) {
    const info = FONT_MAP[name] || FONT_MAP["Aref Ruqaa"];
    const id = "jg-ec-font-" + info.google.split(":")[0];
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=" + info.google + "&display=swap";
      document.head.appendChild(link);
    }
    return info.css;
  }

  function injectStyles() {
    if (document.getElementById("jg-ec-styles")) return;
    const s = document.createElement("style");
    s.id = "jg-ec-styles";
    s.textContent = `
#jg-ec-overlay{position:fixed;inset:0;z-index:999999;background:rgba(20,14,6,.72);
  display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;
  pointer-events:none;transition:opacity .4s ease;backdrop-filter:blur(4px);}
#jg-ec-overlay.active{opacity:1;pointer-events:all;}
#jg-ec-card{position:relative;width:100%;max-width:380px;aspect-ratio:9/15.5;border-radius:18px;
  overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);background:linear-gradient(155deg,#3a2a12,#6b4a1e 45%,#3a2a12);
  color:#f6e9c9;text-align:center;display:flex;flex-direction:column;align-items:center;
  justify-content:center;padding:34px 24px;background-size:cover;background-position:center;}
#jg-ec-card::before{content:"";position:absolute;inset:10px;border:1px solid rgba(246,233,201,.55);
  border-radius:12px;pointer-events:none;}
#jg-ec-card::after{content:"";position:absolute;inset:0;background:rgba(20,14,6,.28);pointer-events:none;}
#jg-ec-card > *{position:relative;z-index:1;}
.jg-ec-logo{max-width:76px;max-height:76px;object-fit:contain;margin-bottom:14px;}
.jg-ec-label{font-size:.78rem;letter-spacing:.25em;text-transform:uppercase;color:#e8c877;margin-bottom:18px;}
.jg-ec-text{font-size:1.3rem;line-height:1.5;margin-bottom:22px;}
.jg-ec-divider{width:52px;height:1px;background:#e8c877;margin:0 0 18px;}
.jg-ec-guest-label{font-size:.72rem;letter-spacing:.15em;color:#d8bd85;margin-bottom:4px;}
.jg-ec-guest{font-size:1.9rem;margin-bottom:16px;word-break:break-word;}
.jg-ec-meta{font-size:.92rem;line-height:1.9;color:#f1e2ba;}
.jg-ec-qr-wrap{margin:14px 0 6px;display:flex;flex-direction:column;align-items:center;gap:6px;}
.jg-ec-qr{width:110px;height:110px;border-radius:10px;background:#fff;padding:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);}
.jg-ec-qr-hint{font-size:.68rem;color:#d8bd85;letter-spacing:.05em;}
#jg-ec-actions{margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center;position:relative;z-index:2;}
#jg-ec-actions button{border:1px solid #e8c877;background:transparent;color:#f6e9c9;padding:10px 20px;
  border-radius:999px;cursor:pointer;font-family:inherit;font-size:.85rem;transition:.2s;}
#jg-ec-actions button.jg-ec-primary{background:#e8c877;color:#241a0c;font-weight:700;}
#jg-ec-actions button:hover{opacity:.85;}
#jg-ec-close{position:absolute;top:-14px;left:50%;transform:translateX(-50%);width:34px;height:34px;
  border-radius:50%;background:#f6e9c9;color:#3a2a12;border:none;font-size:1.1rem;cursor:pointer;z-index:3;}
@media (max-width:420px){#jg-ec-card{max-width:92vw;}}

#jg-ec-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);
  background:#f6e9c9;color:#3a2a12;padding:12px 22px;border-radius:999px;font-family:inherit;
  font-size:.9rem;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.35);z-index:1000001;
  opacity:0;transition:.35s ease;pointer-events:none;}
#jg-ec-toast.active{opacity:1;transform:translateX(-50%) translateY(0);}

#jg-wall-overlay{position:fixed;inset:0;z-index:1000000;background:rgba(20,14,6,.8);
  display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;pointer-events:none;
  transition:opacity .35s ease;}
#jg-wall-overlay.active{opacity:1;pointer-events:all;}
#jg-wall-modal{position:relative;width:100%;max-width:420px;max-height:86vh;background:#fbf3e2;
  border-radius:16px;padding:22px;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5);
  font-family:inherit;color:#3a2a12;}
#jg-wall-close{position:absolute;top:-14px;left:50%;transform:translateX(-50%);width:34px;height:34px;
  border-radius:50%;background:#f6e9c9;color:#3a2a12;border:none;font-size:1.1rem;cursor:pointer;}
.jg-wall-title{font-size:1.25rem;text-align:center;margin:6px 0 12px;color:#6b4a1e;}
.jg-wall-notice{background:#efe0bd;border:1px solid #d8bd85;border-radius:10px;padding:9px 12px;
  font-size:.8rem;line-height:1.6;text-align:center;margin-bottom:14px;color:#5a3f16;}
.jg-wall-list{overflow-y:auto;flex:1;margin-bottom:12px;display:flex;flex-direction:column;gap:10px;
  min-height:40px;}
.jg-wall-empty{font-size:.85rem;color:#9c8a63;text-align:center;padding:10px 0;}
.jg-wall-item{background:#fff;border:1px solid #ecdfc0;border-radius:10px;padding:10px 12px;}
.jg-wall-item-name{font-size:.85rem;font-weight:700;color:#6b4a1e;margin-bottom:3px;}
.jg-wall-item-msg{font-size:.88rem;line-height:1.6;color:#3a2a12;word-break:break-word;}
.jg-wall-form{border-top:1px solid #ecdfc0;padding-top:12px;display:flex;flex-direction:column;gap:8px;}
.jg-wall-form input,.jg-wall-form textarea{width:100%;box-sizing:border-box;border:1px solid #d8bd85;
  border-radius:8px;padding:8px 10px;font-family:inherit;font-size:.88rem;background:#fff;color:#3a2a12;}
.jg-wall-form textarea{resize:vertical;min-height:60px;}
.jg-wall-form button{align-self:flex-end;background:#6b4a1e;color:#f6e9c9;border:none;padding:9px 22px;
  border-radius:999px;cursor:pointer;font-family:inherit;font-size:.85rem;font-weight:700;}
.jg-wall-form button:disabled{opacity:.6;cursor:default;}
`;
    document.head.appendChild(s);
  }

  function buildCard(cfg, data, guestName, entryCode, guestCount) {
    const wrap = el("div");
    wrap.id = "jg-ec-wrap";
    wrap.style.position = "relative";

    const closeBtn = el("button");
    closeBtn.id = "jg-ec-close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "إغلاق");

    const card = el("div");
    card.id = "jg-ec-card";
    const fam = loadFont(cfg.font_family);
    card.style.fontFamily = fam;
    if (cfg.background_image) {
      card.style.backgroundImage = `url('${optimizeImg(cfg.background_image)}')`;
    }

    if (cfg.logo_image) {
      const logo = el("img", "jg-ec-logo");
      logo.src = optimizeImg(cfg.logo_image);
      logo.alt = "";
      card.appendChild(logo);
    }

    card.appendChild(el("div", "jg-ec-label", "بطاقة دخول"));
    card.appendChild(el("div", "jg-ec-text", cfg.text || "يسعدنا حضوركم"));
    card.appendChild(el("div", "jg-ec-divider"));

    if (guestName) {
      card.appendChild(el("div", "jg-ec-guest-label", "الضيف / الضيفة"));
      card.appendChild(el("div", "jg-ec-guest", guestName));
    }

    const metaLines = [data.names, data.date, data.location, guestCount ? `عدد المرافقين: ${guestCount}` : ""].filter(Boolean);
    if (metaLines.length) {
      const meta = el("div", "jg-ec-meta");
      meta.innerHTML = metaLines.map(t => escapeHtml(t)).join("<br>");
      card.appendChild(meta);
    }

    const actions = el("div");
    actions.id = "jg-ec-actions";
    // QR code شخصي واحد — هو نفسه المستخدم لدخول الصالة يوم المناسبة
    // (يُمسح بجهاز الاستقبال). لو ما فيه entryCode (بيانات قديمة قبل هذي
    // الميزة)، نرجع لرابط الدعوة كخيار احتياطي بس.
    const qrWrap = el("div", "jg-ec-qr-wrap");
    const qrImg = el("img", "jg-ec-qr");
    qrImg.alt = "QR";
    qrWrap.appendChild(qrImg);
    const qrHintEl = el("div", "jg-ec-qr-hint", entryCode ? "كود دخولك الشخصي — يُمسح عند الباب يوم المناسبة" : "امسح الرمز للوصول للدعوة");
    qrWrap.appendChild(qrHintEl);
    if (entryCode) {
      const codeText = el("div", "", entryCode);
      codeText.style.cssText = "font-family:monospace;font-size:1.15rem;letter-spacing:.1em;color:#e8c877;font-weight:bold;margin-top:8px";
      qrWrap.appendChild(codeText);
    }
    card.appendChild(qrWrap);

    // توليد QR عبر مكتبة qrcode.js — يرمّز كود الدخول الشخصي لو متوفر،
    // وإلا رابط الدعوة (توافق رجعي لبيانات قديمة)
    ensureQRCode(() => {
      const inviteUrl = window.location.href;
      const eventCode = document.body.dataset.eventCode || new URLSearchParams(window.location.search).get("eid") || "";
      const qrValue = entryCode ? JSON.stringify({eventId:eventCode,entryCode}) : inviteUrl;
      try {
        qrImg.src = window.QRCode.toDataURL(qrValue, { width: 220, margin: 1, color: { dark: "#3a2a12", light: "#ffffff" } });
      } catch (e) {
        qrWrap.style.display = "none";
      }
    });

    const dlBtn = el("button", "jg-ec-primary", "استلم بطاقة دخولك");
    const editBtn = el("button", "", "تعديل التأكيد");
    const cancelBtn = el("button", "", "إلغاء الحضور");
    const wallBtn = el("button", "", "أترك كلمة للعروسين");
    const closeBtn2 = el("button", "", "إغلاق");
    actions.appendChild(dlBtn);
    actions.appendChild(editBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(wallBtn);
    actions.appendChild(closeBtn2);

    wrap.appendChild(closeBtn);
    wrap.appendChild(card);
    wrap.appendChild(actions);

    return { wrap, card, closeBtn, closeBtn2, dlBtn, editBtn, cancelBtn, wallBtn, qrWrap };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML.replace(/'/g, "&#39;");
  }

  function ensureHtml2Canvas(cb) {
    if (window.html2canvas) return cb();
    const existing = document.getElementById("jg-ec-h2c");
    if (existing) { existing.addEventListener("load", cb); return; }
    const s = document.createElement("script");
    s.id = "jg-ec-h2c";
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    s.integrity = "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==";
    s.crossOrigin = "anonymous";
    s.onload = cb;
    document.body.appendChild(s);
  }

  function ensureQRCode(cb) {
    if (window.QRCode) return cb();
    const existing = document.getElementById("jg-ec-qr-lib");
    if (existing) { existing.addEventListener("load", cb); return; }
    const s = document.createElement("script");
    s.id = "jg-ec-qr-lib";
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.5.3/qrcode.min.js";
    s.onload = cb;
    document.body.appendChild(s);
  }

  function showToast(msg) {
    let t = document.getElementById("jg-ec-toast");
    if (!t) {
      t = el("div");
      t.id = "jg-ec-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add("active"));
    clearTimeout(t.__hideTimer);
    t.__hideTimer = setTimeout(() => t.classList.remove("active"), 2600);
  }

  let _fbModule = null;
  function loadFirebase() {
    if (_fbModule) return _fbModule;
    _fbModule = import("./firebase-init.js");
    return _fbModule;
  }

  function renderWallList(listEl, docs) {
    listEl.innerHTML = "";
    if (!docs.length) {
      listEl.appendChild(el("div", "jg-wall-empty", "كوني أول من يترك كلمة هنا 🌹"));
      return;
    }
    docs.forEach(d => {
      const item = el("div", "jg-wall-item");
      item.appendChild(el("div", "jg-wall-item-name", d.name || "ضيف"));
      item.appendChild(el("div", "jg-wall-item-msg", d.message || ""));
      listEl.appendChild(item);
    });
  }

  function openWall(slug, guestName) {
    injectStyles();
    let overlay = document.getElementById("jg-wall-overlay");
    if (overlay) overlay.remove();
    overlay = el("div");
    overlay.id = "jg-wall-overlay";

    const modal = el("div");
    modal.id = "jg-wall-modal";
    const closeBtn = el("button");
    closeBtn.id = "jg-wall-close";
    closeBtn.textContent = "×";
    modal.appendChild(closeBtn);
    modal.appendChild(el("div", "jg-wall-title", "تعاليق المدعوين"));
    modal.appendChild(el("div", "jg-wall-notice", "👁 اختاري: كلمة عامة تظهر بالحائط للجميع، أو كلمة خاصة توصل للعروسين بس."));

    const listEl = el("div", "jg-wall-list");
    listEl.appendChild(el("div", "jg-wall-empty", "يتم التحميل..."));
    modal.appendChild(listEl);

    const form = el("div", "jg-wall-form");
    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.placeholder = "اسمك";
    nameInput.value = guestName || "";
    const msgInput = el("textarea");
    msgInput.placeholder = "اكتبي/اكتب كلمتك للعروسين هنا...";

    // اختيار عام / خاص
    const visWrap = el("div", "jg-wall-visibility");
    visWrap.style.cssText = "display:flex;gap:14px;margin:8px 0;font-size:.85rem;color:#d8bd85";
    const publicId = "jg-wall-vis-public-" + Math.random().toString(36).slice(2, 8);
    const privateId = "jg-wall-vis-private-" + Math.random().toString(36).slice(2, 8);
    visWrap.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="radio" name="jg-wall-vis" id="${publicId}" value="public" checked> عامة (بالحائط)
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="radio" name="jg-wall-vis" id="${privateId}" value="private"> خاصة (للعروسين فقط)
      </label>`;

    const submitBtn = el("button", "", "نشر");
    form.appendChild(nameInput);
    form.appendChild(msgInput);
    form.appendChild(visWrap);
    form.appendChild(submitBtn);
    modal.appendChild(form);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("active"));

    function close() {
      overlay.classList.remove("active");
      setTimeout(() => overlay.remove(), 350);
    }
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    fetch(`/.netlify/functions/guest-wall?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error("wall")))
      .then(data => renderWallList(listEl, Array.isArray(data.items) ? data.items : []))
      .catch(() => renderWallList(listEl, []));

    submitBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const message = msgInput.value.trim();
      if (!name || !message) {
        showToast("اكتبي اسمك وكلمتك أولاً");
        return;
      }
      // Client-side rate limiting: 1 comment per 10 seconds
      const now = Date.now();
      if (now - lastWallSubmitTime < WALL_SUBMIT_COOLDOWN) {
        const remaining = Math.ceil((WALL_SUBMIT_COOLDOWN - (now - lastWallSubmitTime)) / 1000);
        showToast("انتظري " + remaining + " ثوان قبل نشر كلمة أخرى");
        return;
      }
      lastWallSubmitTime = now;

      const isPrivate = visWrap.querySelector('input[name="jg-wall-vis"]:checked').value === "private";

      submitBtn.disabled = true;
      submitBtn.textContent = "جارِ الإرسال...";

      // إرسال إشعار بريدي للعروسين/المدير — يصير دائمًا (خاصة أو عامة)
      fetch("/.netlify/functions/notify-wall-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, message, isPrivate }),
      }).catch(() => {});

      if (isPrivate) {
        // خاصة: ما تُحفظ بحائط guest_wall العام، توصل بالإيميل فقط
        msgInput.value = "";
        submitBtn.disabled = false;
        submitBtn.textContent = "نشر";
        showToast("وصلت كلمتك الخاصة للعروسين، شكرًا لك 🌹");
        return;
      }

      fetch("/.netlify/functions/guest-wall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, message }),
      }).then(r => r.ok ? r.json() : Promise.reject(new Error("wall"))).then(() => {
        msgInput.value = "";
        submitBtn.disabled = false;
        submitBtn.textContent = "نشر";
        const item = el("div", "jg-wall-item");
        item.appendChild(el("div", "jg-wall-item-name", name));
        item.appendChild(el("div", "jg-wall-item-msg", message));
        const empty = listEl.querySelector(".jg-wall-empty");
        if (empty) empty.remove();
        listEl.prepend(item);
        showToast("تم نشر كلمتك، شكرًا لك 🌹");
      }).catch(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = "نشر";
        showToast("تعذّر النشر، حاولي مرة أخرى");
      });
    });
  }

  function getDeviceFingerprint() {
    const key = "jg-device-id";
    let id = localStorage.getItem(key);
    if (id) return id;
    const parts = [
      navigator.userAgent,
      navigator.language,
      screen.width + "x" + screen.height,
      new Date().getTimezoneOffset().toString(),
      Math.random().toString(36).slice(2),
    ];
    id = btoa(parts.join("|")).slice(0, 32);
    localStorage.setItem(key, id);
    return id;
  }

  async function claimSingleDevice(slug, guestName) {
    try {
      const deviceId = getDeviceFingerprint();
      const res = await fetch("/.netlify/functions/claim-entry-lock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, guestName: guestName || "", deviceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: "server_error" };
      return data.ok ? { ok: true } : { ok: false, reason: data.reason || "another_device" };
    } catch {
      return { ok: false, reason: "server_error" };
    }
  }

  function showCard(data, guestName, slug, entryCode) {
    // إعدادات الأمان تُقرأ من مفتاح "security" (لوحة التحكم)، مع دعم المفتاح
    // القديم "entry_card" لأي بيانات محفوظة سابقًا للتوافق الرجعي.
    const cfg = Object.assign({}, data.entry_card || {}, data.security || {});
    if (cfg.enabled === "off") return;

    // احترام إعداد "حائط التعليقات" من لوحة التحكم
    const ff = data.form_fields || {};
    const wallEnabled = ff.guest_wall !== "off";

    // تقييد بطاقة الدخول على جهاز واحد
    if (cfg.single_device === "on") {
      claimSingleDevice(slug, guestName).then((res) => {
        if (!res.ok && res.reason === "another_device") {
          showDeviceLockedMessage();
        } else {
          doShowCard(data, guestName, slug, cfg, ff, wallEnabled, entryCode);
        }
      });
      return;
    }

    doShowCard(data, guestName, slug, cfg, ff, wallEnabled, entryCode);
  }

  function showDeviceLockedMessage() {
    injectStyles();
    const overlay = el("div");
    overlay.id = "jg-ec-overlay";
    overlay.classList.add("active");
    const msg = el("div");
    msg.style.cssText = "max-width:360px;text-align:center;color:#f6e9c9;font-family:inherit;padding:30px";
    msg.innerHTML =
      '<div style="font-size:3rem;margin-bottom:16px">🔒</div>' +
      '<h2 style="color:#e8c877;font-size:1.3rem;margin:0 0 12px">البطاقة مفتوحة على جهاز آخر</h2>' +
      '<p style="line-height:1.8;color:#d8bd85;font-size:.95rem">لأسباب أمنية، يمكن فتح بطاقة الدخول من جهاز واحد فقط. ' +
      'إذا تعذّر عليك الوصول للبطاقة، تواصلي مع صاحب المناسبة.</p>';
    overlay.appendChild(msg);
    document.body.appendChild(overlay);
  }

  function doShowCard(data, guestName, slug, cfg, ff, wallEnabled, entryCode) {

    let overlay = document.getElementById("jg-ec-overlay");
    if (overlay) overlay.remove();
    overlay = el("div");
    overlay.id = "jg-ec-overlay";
    document.body.appendChild(overlay);

    const guestCount = window.__jgLastGuestsCount || "";
    const { wrap, card, closeBtn, closeBtn2, dlBtn, editBtn, cancelBtn, wallBtn, qrWrap } = buildCard(cfg, data, guestName, entryCode, guestCount);
    overlay.appendChild(wrap);

    // إخفاء زر حائط التعليقات لو معطّل من لوحة التحكم
    if (!wallEnabled) wallBtn.style.display = "none";

    requestAnimationFrame(() => overlay.classList.add("active"));

    function close() {
      overlay.classList.remove("active");
      setTimeout(() => overlay.remove(), 400);
    }
    closeBtn.addEventListener("click", close);
    closeBtn2.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    if (wallEnabled) wallBtn.addEventListener("click", () => openWall(slug, guestName));

    // جلب رقم الطاولة/المقعد/البوابة من بيانات الضيف (لو معبّأة ومفعّلة من
    // لوحة التحكم) وإضافتها لبطاقة الدخول. غير حرج: أي فشل هنا ما يؤثر
    // على باقي البطاقة (QR، الأزرار...) لأنه معزول بـ try/catch مستقل.
    if (entryCode) {
      loadFirebase().then(async (fb) => {
        let fieldSettings = { table: true, seat: true, gate: true };
        try {
          const settingsSnap = await fb.getDoc(fb.doc(fb.db, "settings", "guestFields"));
          if (settingsSnap.exists()) {
            const d = settingsSnap.data();
            fieldSettings = { table: d.table !== false, seat: d.seat !== false, gate: d.gate !== false };
          }
        } catch { /* نبقى على الافتراضي */ }

        const q = fb.query(fb.collection(fb.db, "responses"), fb.where("entryCode", "==", entryCode));
        const snap = await fb.getDocs(q);
        if (snap.empty) return;
        const g = snap.docs[0].data();
        const extra = [];
        if (fieldSettings.table && g.table) extra.push(`رقم الطاولة: ${g.table}`);
        if (fieldSettings.seat && g.seat) extra.push(`رقم المقعد: ${g.seat}`);
        if (fieldSettings.gate && g.gate) extra.push(`البوابة: ${g.gate}`);
        if (!extra.length) return;

        let metaEl = card.querySelector(".jg-ec-meta");
        if (metaEl) {
          extra.forEach((t, index) => {
          if (metaEl.textContent && index === 0) metaEl.appendChild(document.createElement("br"));
          else if (index > 0) metaEl.appendChild(document.createElement("br"));
          metaEl.appendChild(document.createTextNode(String(t)));
        });
        } else {
          metaEl = el("div", "jg-ec-meta");
          metaEl.innerHTML = extra.map(t => escapeHtml(t)).join("<br>");
          card.insertBefore(metaEl, qrWrap);
        }
      }).catch(() => { /* تجاهل بصمت — البطاقة تبقى شغالة بدون هالتفاصيل */ });
    }

    // زر تعديل التأكيد — يغلق البطاقة ويعيد فتح نموذج الحضور
    editBtn.addEventListener("click", () => {
      close();
      const formContainer = document.getElementById("rsvp-form-container");
      const successMsg = document.getElementById("success-msg");
      const modal = document.getElementById("rsvp-modal");
      if (successMsg) successMsg.style.display = "none";
      if (formContainer) formContainer.style.display = "block";
      if (modal) modal.classList.add("active");
    });

    // زر إلغاء الحضور — يغلق البطاقة ويعرض النموذج مع تحديد "يعتذر"
    cancelBtn.addEventListener("click", () => {
      close();
      const formContainer = document.getElementById("rsvp-form-container");
      const successMsg = document.getElementById("success-msg");
      const modal = document.getElementById("rsvp-modal");
      if (successMsg) successMsg.style.display = "none";
      if (formContainer) formContainer.style.display = "block";
      if (modal) modal.classList.add("active");
      const declineRadio = document.querySelector('input[name="Attendance"][value="Declines with regret"]');
      if (declineRadio) declineRadio.checked = true;
      const form = document.getElementById("rsvpForm");
      if (form) form.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // ترجمة أزرار البطاقة حسب اللغة الحالية
    const _lang = window.__jgLang || "ar";
    const _T = {
      ar: { dl: "استلم بطاقة دخولك", edit: "تعديل التأكيد", cancel: "إلغاء الحضور", close: "إغلاق", wall: "أترك كلمة للعروسين", qr: "امسح الرمز للوصول للدعوة", qrEntry: "كود دخولك الشخصي — يُمسح عند الباب يوم المناسبة" },
      en: { dl: "Download Entry Card", edit: "Edit RSVP", cancel: "Cancel Attendance", close: "Close", wall: "Leave a message", qr: "Scan the code to open the invite", qrEntry: "Your personal entry code — scanned at the door on the event day" },
      fr: { dl: "Télécharger la carte d'entrée", edit: "Modifier la confirmation", cancel: "Annuler la présence", close: "Fermer", wall: "Laisser un message", qr: "Scannez le code pour ouvrir l'invitation", qrEntry: "Votre code d'entrée personnel — scanné à la porte le jour J" },
    };
    const _t = _T[_lang] || _T.ar;
    dlBtn.textContent = _t.dl;
    editBtn.textContent = _t.edit;
    cancelBtn.textContent = _t.cancel;
    closeBtn2.textContent = _t.close;
    wallBtn.textContent = _t.wall;
    qrWrap.querySelector(".jg-ec-qr-hint").textContent = entryCode ? _t.qrEntry : _t.qr;

    dlBtn.addEventListener("click", () => {
      dlBtn.textContent = _lang === "ar" ? "جارِ التجهيز..." : _lang === "fr" ? "Préparation..." : "Preparing...";
      ensureHtml2Canvas(() => {
        window.html2canvas(card, { useCORS: true, backgroundColor: null, scale: 2 }).then(canvas => {
          const link = document.createElement("a");
          const safeName = (guestName || "بطاقة-دخول").replace(/[^\u0600-\u06FFa-zA-Z0-9 _-]/g, "").trim() || "بطاقة-دخول";
          link.download = safeName + ".png";
          link.href = canvas.toDataURL("image/png");
          link.click();
          dlBtn.textContent = _t.dl;
        }).catch(() => {
          dlBtn.textContent = _lang === "ar" ? "تعذّر الحفظ، حاولي مرة أخرى" : _lang === "fr" ? "Échec, réessayez" : "Failed, try again";
          setTimeout(() => { dlBtn.textContent = _t.dl; }, 2200);
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const slug = document.body.getAttribute("data-rsvp-slug");
    if (!slug) return;

    document.addEventListener("jg:rsvp-success", (ev) => {
      const entryCode = (ev.detail && ev.detail.entryCode) || window.__jgLastEntryCode || "";
      const inviteCode = new URLSearchParams(window.location.search).get("code") || "";
      const inviteUrl = `/.netlify/functions/invitation-data?slug=${encodeURIComponent(slug)}${inviteCode ? `&code=${encodeURIComponent(inviteCode)}` : ""}`;
      const eventCode = (ev.detail && ev.detail.eventCode) || window.__jgLastEventCode || new URLSearchParams(window.location.search).get("eid") || "";
      const qrStatusUrl = `/.netlify/functions/qr-status?eventId=${encodeURIComponent(eventCode)}`;
      Promise.all([
        fetch(inviteUrl, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(new Error("Invitation data unavailable"))),
        fetch(qrStatusUrl, { cache: "no-store" }).then(r => r.ok ? r.json() : { qrEnabled: false })
      ])
        .then(([data, qr]) => {
          // QR/entry card is feature-gated by the event's effective package setting.
          if (!qr.qrEnabled) return;
          showCard(data, (ev.detail && ev.detail.guestName) || "", slug, entryCode);
        })
        .catch(() => {});
    });
  });
})();
