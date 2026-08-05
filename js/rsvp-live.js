// js/rsvp-live.js
// يُحمَّل من كل صفحة تأكيد حضور (rsvp/*.html). يقرأ بيانات الطلب الحقيقية
// من content/rsvp/{slug}.json (اللي تتعدّل من لوحة تحكم /admin/) ويطبّقها
// فوق التصميم الثابت للستايل، بدل الأسماء/التاريخ/الموقع التجريبية المكتوبة بالكود.
//
// كل صفحة لازم تحدد: <body data-rsvp-slug="wedding-silver"> قبل إغلاق </body>.
// يُحمَّل كـ type="module" عشان نقدر نستورد Firestore ونربط تأكيدات الحضور
// بقاعدة البيانات اللي تقرأ منها أداة "تذكير الضيوف" بلوحة التحكم.

import { db, collection, addDoc, serverTimestamp } from "./firebase-init.js";

(function () {
  const FONT_MAP = {
    "Aref Ruqaa": "'Aref Ruqaa', serif",
    "Amiri": "'Amiri', serif",
    "Cairo": "'Cairo', sans-serif",
    "Tajawal": "'Tajawal', sans-serif",
    "Reem Kufi": "'Reem Kufi', sans-serif",
    "Lalezar": "'Lalezar', cursive",
    "Rakkas": "'Rakkas', cursive",
    "Markazi Text": "'Markazi Text', serif",
  };
  const SCALE_MAP = { small: 0.82, medium: 1, large: 1.15, xlarge: 1.32 };

  // ===== ترجمات الواجهة (عربي/إنجليزي/فرنسي) =====
  const I18N = {
    ar: {
      rsvpTitle: "تأكيد الحضور",
      rsvpPrompt: "لتجهيز استقبال يليق بكم، يرجى تأكيد حضوركم.",
      guestName: "اسمك",
      phone: "رقم الهاتف",
      phoneHint: "(للتذكير قبل يومين من المناسبة)",
      attending: "هل ستتمكن من الحضور؟",
      accept: "يقبل بحضوركم",
      decline: "يعتذر عن الحضور",
      guestsCount: "عدد الضيوف",
      children: "حضور الأطفال",
      childrenHint: "يرجى ذكر الأسماء والأعمار.",
      childrenNames: "الأسماء والأعمار",
      songRequest: "أغنية تحب أن تُعزف",
      submit: "إرسال",
      sending: "جارٍ الإرسال...",
      successMsg: "نتطلع إلى رؤيتكم!",
      thankYou: "شكراً لكم",
      rsvpBefore: "الرجاء تأكيد الحضور قبل ",
      clickToOpen: "اضغط للفتح",
      confirmAttendance: "تأكيد الحضور",
      location: "الموقع",
      schedule: "جدول الفعاليات",
      countdown: "يبدأ الاحتفال بعد",
      seeYou: "نراكم هناك!",
      tapOpen: "اضغط للفتح",
      editRsvp: "تعديل التأكيد",
      cancelRsvp: "إلغاء الحضور",
      downloadCard: "استلم بطاقة دخولك",
      qrHint: "امسح الرمز للوصول للدعوة",
      close: "إغلاق",
    },
    en: {
      rsvpTitle: "Confirm Your Attendance",
      rsvpPrompt: "To help us prepare for a joyful celebration, kindly confirm your attendance.",
      guestName: "Your name",
      phone: "Phone Number",
      phoneHint: "(for a reminder two days before the event)",
      attending: "Will you be attending?",
      accept: "Accepts with pleasure",
      decline: "Declines with regret",
      guestsCount: "Number of Guests",
      children: "Children Attending",
      childrenHint: "Please include names and ages.",
      childrenNames: "Names and ages",
      songRequest: "A Song That Gets You Dancing",
      submit: "Submit",
      sending: "Sending...",
      successMsg: "We look forward to seeing you!",
      thankYou: "Thank you",
      rsvpBefore: "Please RSVP before ",
      clickToOpen: "Click to open",
      confirmAttendance: "Confirm Your Attendance",
      location: "Location",
      schedule: "Schedule of Events",
      countdown: "The Celebration Begins In",
      seeYou: "See you there!",
      tapOpen: "Tap to open",
      editRsvp: "Edit RSVP",
      cancelRsvp: "Cancel Attendance",
      downloadCard: "Download Entry Card",
      qrHint: "Scan the code to open the invite",
      close: "Close",
    },
    fr: {
      rsvpTitle: "Confirmez votre présence",
      rsvpPrompt: "Pour nous aider à préparer une joyeuse célébration, veuillez confirmer votre présence.",
      guestName: "Votre nom",
      phone: "Numéro de téléphone",
      phoneHint: "(pour un rappel deux jours avant l'événement)",
      attending: "Serez-vous présent ?",
      accept: "Accepte avec plaisir",
      decline: "Décline avec regret",
      guestsCount: "Nombre d'invités",
      children: "Enfants présents",
      childrenHint: "Veuillez inclure les noms et âges.",
      childrenNames: "Noms et âges",
      songRequest: "Une chanson qui vous fait danser",
      submit: "Envoyer",
      sending: "Envoi...",
      successMsg: "Nous avons hâte de vous voir !",
      thankYou: "Merci",
      rsvpBefore: "Veuillez confirmer avant le ",
      clickToOpen: "Cliquez pour ouvrir",
      confirmAttendance: "Confirmez votre présence",
      location: "Lieu",
      schedule: "Programme",
      countdown: "La célébration commence dans",
      seeYou: "À bientôt !",
      tapOpen: "Touchez pour ouvrir",
      editRsvp: "Modifier la confirmation",
      cancelRsvp: "Annuler la présence",
      downloadCard: "Télécharger la carte d'entrée",
      qrHint: "Scannez le code pour ouvrir l'invitation",
      close: "Fermer",
    },
  };

  function t(key) {
    const lang = (window.__jgLang || "ar");
    return (I18N[lang] && I18N[lang][key]) || I18N.ar[key] || key;
  }

  function applyLanguage(lang) {
    if (!I18N[lang]) lang = "ar";
    window.__jgLang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.body.classList.remove("lang-ar", "lang-en", "lang-fr");
    document.body.classList.add("lang-" + lang);
    localStorage.setItem("jg-lang", lang);

    // ترجمة العناصر ذات data-i18n
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      const val = t(key);
      if (val) el.textContent = val;
    });
    // ترجمة placeholder
    document.querySelectorAll("[data-i18n-ph]").forEach(el => {
      const key = el.getAttribute("data-i18n-ph");
      const val = t(key);
      if (val) el.setAttribute("placeholder", val);
    });

    // عناصر محددة بالـ id
    setText("#rsvp-form-container h2", t("confirmAttendance"));
    setText(".rsvp-title", t("rsvpTitle"));
    setText("#rsvp-form-container > p", null); // يُعالج بالتاريخ أدناه
    setText(".countdown-title", t("countdown"));
    setText("#cd-expired", t("seeYou"));
    setText(".tap-text", t("tapOpen"));
    setText(".rsvp-title + p", t("rsvpPrompt"));
    setText("section .cormorant.italic.text-gold:last-of-type", t("clickToOpen"));

    // تسميات الفورم
    setText('label[data-field="guest_name"]', t("guestName"));
    setText('label[data-field="phone"]', t("phone"));
    setText('label[data-field="attending"]', t("attending"));
    setText('label[data-field="guests_count"]', t("guestsCount"));
    setText('label[data-field="children"]', t("children"));
    setText('label[data-field="song_request"]', t("songRequest"));

    // أزرار الراديو
    document.querySelectorAll('input[name="Attendance"][value="Accepts with pleasure"]').forEach(el => {
      const sib = el.nextSibling;
      if (sib && sib.nodeType === 3) sib.textContent = " " + t("accept");
      if (sib && sib.nodeType === 1) sib.textContent = t("accept");
    });
    document.querySelectorAll('input[name="Attendance"][value="Declines with regret"]').forEach(el => {
      const sib = el.nextSibling;
      if (sib && sib.nodeType === 3) sib.textContent = " " + t("decline");
      if (sib && sib.nodeType === 1) sib.textContent = t("decline");
    });

    // زر الإرسال
    const submitBtn = document.querySelector(".submit-btn");
    if (submitBtn && !submitBtn.dataset.sending) submitBtn.textContent = t("submit");

    // تلميح الهاتف
    document.querySelectorAll(".phone-hint").forEach(el => { el.textContent = t("phoneHint"); });
    document.querySelectorAll(".children-hint").forEach(el => { el.textContent = t("childrenHint"); });

    // رسالة النجاح
    const successMsg = document.getElementById("success-msg");
    if (successMsg && successMsg.style.display !== "none") {
      const firstLine = successMsg.querySelector("br") ? successMsg.childNodes[0] : null;
      if (firstLine) firstLine.textContent = t("successMsg");
      const overlay = successMsg.querySelector(".success-overlay-text");
      if (overlay) overlay.textContent = t("thankYou");
    }

    // زر اللغة
    const langBtn = document.getElementById("lang-toggle-rsvp");
    if (langBtn) {
      const next = { ar: "EN", en: "FR", fr: "AR" };
      langBtn.textContent = next[lang] || "EN";
    }

    // ترجمة أزرار بطاقة الدخول (تظهر بعد تأكيد الحضور)
    document.querySelectorAll("#jg-ec-actions button").forEach(btn => {
      const txt = btn.textContent.trim();
      if (txt === "استلم بطاقة دخولك" || txt === "Download Entry Card" || txt === "Télécharger la carte d'entrée") btn.textContent = t("downloadCard");
      else if (txt === "تعديل التأكيد" || txt === "Edit RSVP" || txt === "Modifier la confirmation") btn.textContent = t("editRsvp");
      else if (txt === "إلغاء الحضور" || txt === "Cancel Attendance" || txt === "Annuler la présence") btn.textContent = t("cancelRsvp");
      else if (txt === "إغلاق" || txt === "Close" || txt === "Fermer") btn.textContent = t("close");
      else if (txt === "أترك كلمة للعروسين") btn.textContent = t("guestWall") || txt;
    });
    document.querySelectorAll(".jg-ec-qr-hint").forEach(el => { el.textContent = t("qrHint"); });
  }

  function setText(sel, val) {
    const el = document.querySelector(sel);
    if (el && val !== null) el.textContent = val;
  }

  function showAccessDenied() {
    document.documentElement.style.overflow = "hidden";
    document.body.innerHTML =
      '<div style="position:fixed;inset:0;z-index:999999;background:#171310;color:#f6ecda;' +
      'display:flex;align-items:center;justify-content:center;text-align:center;padding:30px;' +
      'font-family:\'Tajawal\',sans-serif;" dir="rtl">' +
      '<div>' +
      '<div style="font-size:3rem;margin-bottom:18px;">🔒</div>' +
      '<h1 style="font-size:1.5rem;color:#D9B565;margin:0 0 12px;">هذه الدعوة خاصة</h1>' +
      '<p style="max-width:360px;margin:0 auto;color:#cbbfa8;line-height:1.8;">' +
      'الرابط اللي معك غير صحيح أو منتهي. تأكد إنك استخدمت رابط الدعوة أو رمز QR اللي وصلك من صاحب المناسبة.' +
      '</p></div></div>';
  }

  function parseArabicDate(str) {
    if (!str) return null;
    const m = String(str).match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
    if (!m) return null;
    const [, d, mo, y] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), 18, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function setNames(container, names) {
    if (!container || !names) return;
    const parts = String(names).split(/&|و(?=\s)/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      container.innerHTML = parts[0] + "<span>&amp;</span>" + parts.slice(1).join(" ");
    } else {
      container.textContent = names;
    }
  }

  function rebuildTimeline(root, items) {
    if (!root || !Array.isArray(items) || !items.length) return;
    const hasRealTime = items.some(it => it.time && it.time.trim());
    if (!hasRealTime) return;
    root.querySelectorAll(".event-row").forEach(el => el.remove());
    items.forEach(it => {
      if (!it.event && !it.time) return;
      const row = document.createElement("div");
      row.className = "event-row";
      row.innerHTML =
        '<div class="event-time">' + (it.time || "") + '</div>' +
        '<div class="event-dot"></div>' +
        '<div class="event-name">' + (it.event || "") + '</div>';
      root.appendChild(row);
    });
  }

  function applyDesign(design) {
    if (!design) return;
    const styleEl = document.createElement("style");
    let css = "";
    if (design.font_family && FONT_MAP[design.font_family]) {
      const fam = FONT_MAP[design.font_family];
      css += `.hero-names,.rsvp-title,.countdown-title,.verses-title{font-family:${fam} !important;}`;
    }
    if (design.font_scale && SCALE_MAP[design.font_scale] !== undefined && design.font_scale !== "medium") {
      const s = SCALE_MAP[design.font_scale];
      css += `.hero-names{font-size:calc(var(--rsvp-hero-size,76px) * ${s}) !important;}`;
      css += `.event-time,.event-name{font-size:calc(1em * ${s});}`;
    }
    if (css) { styleEl.textContent = css; document.head.appendChild(styleEl); }
  }

  const BLUR_MAP = { none: 0, light: 6, medium: 14, heavy: 24 };

  function applyEnvelopeAnimation(animType, imgEl) {
    const overlay = document.getElementById("envelope-overlay");
    if (!overlay || !imgEl) return;
    const type = animType || "fade";

    const style = document.createElement("style");
    style.textContent =
      "#envelope-overlay .env-anim-flap{position:absolute;top:0;left:0;width:100%;height:55%;overflow:hidden;transform-origin:bottom center;transition:transform .9s cubic-bezier(.6,0,.3,1);z-index:2;}" +
      "#envelope-overlay .env-anim-flap img{position:absolute;top:0;left:0;width:100%;height:182%;object-fit:cover;}" +
      "#envelope-overlay.env-open .env-anim-flap{transform:rotateX(-120deg);}" +
      "#envelope-overlay .env-anim-half{position:absolute;top:0;width:50%;height:100%;overflow:hidden;transition:transform 1s cubic-bezier(.6,0,.3,1);z-index:2;}" +
      "#envelope-overlay .env-anim-half.env-left{left:0;}" +
      "#envelope-overlay .env-anim-half.env-right{right:0;}" +
      "#envelope-overlay .env-anim-half img{position:absolute;top:0;height:100%;object-fit:cover;width:200%;}" +
      "#envelope-overlay .env-anim-half.env-left img{left:0;}" +
      "#envelope-overlay .env-anim-half.env-right img{right:0;}" +
      "#envelope-overlay.env-open .env-anim-half.env-left{transform:translateX(-100%);}" +
      "#envelope-overlay.env-open .env-anim-half.env-right{transform:translateX(100%);}" +
      "#envelope-overlay .env-seal-glow{position:absolute;top:50%;left:50%;width:40px;height:40px;border-radius:50%;background:radial-gradient(circle, rgba(255,241,199,.95) 0%, rgba(212,175,55,.6) 40%, rgba(212,175,55,0) 75%);transform:translate(-50%,-50%) scale(.3);opacity:0;pointer-events:none;z-index:5;}" +
      "#envelope-overlay.env-open .env-seal-glow{animation:envSealGlow 1.2s ease-out forwards;}" +
      "@keyframes envSealGlow{0%{transform:translate(-50%,-50%) scale(.3);opacity:0;}18%{opacity:1;}100%{transform:translate(-50%,-50%) scale(10);opacity:0;}}";
    document.head.appendChild(style);

    const src = imgEl.getAttribute("src") || imgEl.src;

    if (type === "flap") {
      const flap = document.createElement("div");
      flap.className = "env-anim-flap";
      const flapImg = document.createElement("img");
      flapImg.src = src;
      flap.appendChild(flapImg);
      overlay.insertBefore(flap, overlay.firstChild);
    } else if (type === "split") {
      const left = document.createElement("div");
      left.className = "env-anim-half env-left";
      const leftImg = document.createElement("img");
      leftImg.src = src;
      left.appendChild(leftImg);
      const right = document.createElement("div");
      right.className = "env-anim-half env-right";
      const rightImg = document.createElement("img");
      rightImg.src = src;
      right.appendChild(rightImg);
      overlay.insertBefore(right, overlay.firstChild);
      overlay.insertBefore(left, overlay.firstChild);
    }

    const glow = document.createElement("div");
    glow.className = "env-seal-glow";
    overlay.appendChild(glow);

    const openNow = () => overlay.classList.add("env-open");
    overlay.addEventListener("click", openNow, { capture: true });
    overlay.addEventListener("touchstart", openNow, { capture: true });
  }

  function applyEffects(effects) {
    if (!effects) return;
    const styleEl = document.createElement("style");
    let css = "";

    if (effects.mouse_glow === "off") {
      css += ".interactive-shimmer{display:none !important;}";
    }

    if (effects.blur && BLUR_MAP[effects.blur] !== undefined && effects.blur !== "medium") {
      const px = BLUR_MAP[effects.blur];
      const overlayPx = Math.max(px - 6, 0);
      css += `section{backdrop-filter:blur(${px}px) !important;-webkit-backdrop-filter:blur(${px}px) !important;}`;
      css += `.bg-overlay{backdrop-filter:blur(${overlayPx}px) !important;-webkit-backdrop-filter:blur(${overlayPx}px) !important;}`;
    }
    if (css) { styleEl.textContent = css; document.head.appendChild(styleEl); }

    if (effects.music_url) {
      const bgAudio = document.getElementById("bgAudio");
      const src = bgAudio && bgAudio.querySelector("source");
      if (src) { src.src = effects.music_url; bgAudio.load(); }
    }

    if (effects.autoplay_music === "off") {
      window.__rsvpNoAutoplayMusic = true;
    }
  }

  // ===== إظهار/إخفاء حقول الاستمارة حسب إعدادات لوحة التحكم =====
  function applyFormFields(ff) {
    if (!ff) return;
    const show = (sel, on) => {
      document.querySelectorAll(sel).forEach(el => {
        el.style.display = on ? "" : "none";
      });
    };
    show(".ff-phone", ff.phone !== "off");
    show(".ff-guests-count", ff.guests_count !== "off");
    show(".ff-children", ff.children === "on");
    show(".ff-song-request", ff.song_request === "on");

    // إزالة required من الحقول المخفية حتى ما تمنع الإرسال
    document.querySelectorAll(".ff-phone input, .ff-guests-count select").forEach(el => {
      el.required = (ff.phone !== "off" && ff.guests_count !== "off");
      if (el.tagName === "INPUT" && ff.phone === "off") el.required = false;
      if (el.tagName === "SELECT" && ff.guests_count === "off") el.required = false;
    });
  }

  function restartCountdown(finalDate) {
    const daysEl = document.getElementById("cd-days");
    const hoursEl = document.getElementById("cd-hours");
    const minsEl = document.getElementById("cd-mins");
    const secsEl = document.getElementById("cd-secs");
    const timerWrap = document.getElementById("cd-timer");
    const expiredEl = document.getElementById("cd-expired");
    if (!daysEl || !hoursEl || !minsEl || !secsEl) return;

    if (window.__cdTimer) clearInterval(window.__cdTimer);

    const tick = () => {
      const dist = finalDate - new Date().getTime();
      if (dist < 0) {
        clearInterval(window.__cdTimer);
        if (timerWrap) timerWrap.style.display = "none";
        if (expiredEl) expiredEl.style.display = "block";
        return;
      }
      daysEl.innerText = Math.floor(dist / (1000 * 60 * 60 * 24));
      hoursEl.innerText = Math.floor((dist % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)).toString().padStart(2, "0");
      minsEl.innerText = Math.floor((dist % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, "0");
      secsEl.innerText = Math.floor((dist % (1000 * 60)) / 1000).toString().padStart(2, "0");
    };
    tick();
    window.__cdTimer = setInterval(tick, 1000);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const slug = document.body.dataset.rsvpSlug;
    if (!slug) return;

    let data = {}, settings = {};
    try {
      [data, settings] = await Promise.all([
        fetch("../content/rsvp/" + slug + ".json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
        fetch("../content/settings.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
      ]);
    } catch (e) { return; }

    // بوابة الحماية
    if (data.access_code && String(data.access_code).trim()) {
      const urlCode = new URLSearchParams(window.location.search).get("code");
      if (urlCode !== String(data.access_code).trim()) {
        showAccessDenied();
        return;
      }
    }

    // الأسماء
    if (data.names) {
      setNames(document.querySelector(".hero-names"), data.names);
      const footerLine = document.querySelector("footer .cormorant.italic, footer .text-brown-soft");
      if (footerLine) footerLine.textContent = data.names;
    }

    // التاريخ
    if (data.date) {
      const dateEl = document.querySelector(".hero-date, .date-container");
      if (dateEl) dateEl.textContent = data.date;
      const target = parseArabicDate(data.date);
      if (target) restartCountdown(target.getTime());
    }

    // الموقع
    if (data.location) {
      const locEl = document.querySelector(".venue-location-text");
      if (locEl) locEl.textContent = data.location;
      const iframe = document.querySelector(".map-wrap iframe");
      if (iframe) iframe.src = "https://www.google.com/maps?q=" + encodeURIComponent(data.location) + "&output=embed";
    }

    // كلمة الترحيب
    if (data.welcome_message) {
      const msgEl = document.querySelector(".message-overlay p");
      if (msgEl) msgEl.textContent = data.welcome_message;
    }

    // التايم لاين
    rebuildTimeline(document.querySelector(".timeline"), data.timeline);

    // صورة الظرف/الباب + فيديو الافتتاح
    if (data.envelope_image) {
      const envImg = document.querySelector("#envelope-overlay img");
      if (envImg) envImg.src = data.envelope_image;
    }
    applyEnvelopeAnimation(data.envelope_animation, document.querySelector("#envelope-overlay img"));
    if (data.intro_video) {
      const introSrc = document.querySelector("#introVideo source");
      if (introSrc) { introSrc.src = data.intro_video; document.getElementById("introVideo").load(); }
    }
    if (data.seal_image) {
      const seal = document.querySelector(".wax-seal");
      if (seal) seal.src = data.seal_image;
    }

    // نموذج تأكيد الحضور
    const form = document.getElementById("rsvpForm");
    const endpoint = data.formspree_override || settings.formspree_id;
    if (form && endpoint) form.action = endpoint;

    if (form) {
      form.addEventListener("submit", () => {
        const fd = new FormData(form);
        const attendance = fd.get("Attendance") || fd.get("attendance") || "";
        const guestName = (fd.get("Guest_Name") || fd.get("guest_name") || "").toString();
        const phone = (fd.get("Phone_Number") || fd.get("phone_number") || "").toString();
        const status = /accept/i.test(attendance) ? "yes" : "no";
        const guestsCount = (fd.get("Number_of_Guests") || fd.get("number_of_guests") || "").toString();

        addDoc(collection(db, "responses"), {
          name: guestName,
          phone: phone,
          status: status,
          guests: guestsCount,
          style: slug,
          createdAt: serverTimestamp(),
        }).catch(() => {});

        // إرسال إشعار بريدي فوري للوحة التحكم
        fetch("/.netlify/functions/notify-rsvp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guestName, phone, status, guests: guestsCount, style: slug }),
        }).catch(() => {});
      });
    }

    // تصميم النصوص
    applyDesign(data.design);

    // التأثيرات البصرية والصوتية
    applyEffects(data.effects);

    // إظهار/إخفاء حقول الاستمارة
    applyFormFields(data.form_fields);

    // تطبيق اللغة المحفوظة + ربط زر تبديل اللغة
    const savedLang = localStorage.getItem("jg-lang") || "ar";
    applyLanguage(savedLang);

    const langBtn = document.getElementById("lang-toggle-rsvp");
    if (langBtn) {
      langBtn.addEventListener("click", () => {
        const current = window.__jgLang || "ar";
        const cycle = { ar: "en", en: "fr", fr: "ar" };
        applyLanguage(cycle[current] || "en");
      });
    }
  });
})();
