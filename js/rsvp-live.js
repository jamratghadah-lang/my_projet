// js/rsvp-live.js
// يُحمَّل من كل صفحة تأكيد حضور (rsvp/*.html). يقرأ بيانات الطلب الحقيقية
// من content/rsvp/{slug}.json (اللي تتعدّل من لوحة تحكم /admin/) ويطبّقها
// فوق التصميم الثابت للستايل، بدل الأسماء/التاريخ/الموقع التجريبية المكتوبة بالكود.
//
// كل صفحة لازم تحدد: <body data-rsvp-slug="wedding-silver"> قبل إغلاق </body>.
// يُحمَّل كـ type="module" عشان نقدر نستورد Firestore ونربط تأكيدات الحضور
// بقاعدة البيانات اللي تقرأ منها أداة "تذكير الضيوف" بلوحة التحكم.

(function () {
  // هروب بسيط لمنع حقن HTML من بيانات JSON / إدخال المستخدم
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML
      .replace(/'/g, "&#39;")
      .replace(/\\/g, "&#92;");
  }


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
      childrenWelcome: "الأطفال مرحّب بهم 🎈",
      childrenAdultsOnly: "نعتذر، الدعوة مخصصة للبالغين فقط",
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
      childrenWelcome: "Children are welcome 🎈",
      childrenAdultsOnly: "Sorry, this invitation is for adults only",
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
      childrenWelcome: "Les enfants sont les bienvenus 🎈",
      childrenAdultsOnly: "Désolé, cette invitation est réservée aux adultes",
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

    // إعادة تطبيق رسالة سياسة الأطفال باللغة الجديدة (لو مفعّلة)
    const childrenMsg = document.getElementById("jg-children-msg");
    if (childrenMsg && window.__jgAllowChildren !== undefined) {
      childrenMsg.textContent = window.__jgAllowChildren === "yes" ? t("childrenWelcome") : t("childrenAdultsOnly");
    }

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

  function lockRsvpForm() {
    const form = document.getElementById("rsvpForm");
    if (!form) return;
    const wrap = form.parentElement || form;
    const notice = document.createElement("div");
    notice.style.cssText =
      "background:rgba(212,175,55,.1);border:1px solid rgba(212,175,55,.3);border-radius:10px;" +
      "padding:20px;text-align:center;color:#d4af37;font-family:'Tajawal',sans-serif;margin:16px 0";
    const icon = document.createElement("div");
    icon.textContent = "📅";
    icon.style.cssText = "font-size:2rem;margin-bottom:10px";
    const msg = document.createElement("p");
    msg.textContent = "انتهت مدة استقبال الردود لهذه المناسبة. شكرًا لكل من أكّد حضوره!";
    msg.style.cssText = "margin:0;font-size:1rem;line-height:1.7;color:#cbbfa8";
    notice.append(icon, msg);
    form.style.display = "none";
    form.parentNode.insertBefore(notice, form);
    form.querySelectorAll("input, button, select, textarea").forEach(el => el.disabled = true);
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
      container.innerHTML = esc(parts[0]) + "<span>&amp;</span>" + parts.slice(1).map(p => esc(p)).join(" ");
    } else {
      container.textContent = names;
    }
  }

  function rebuildTimeline(root, items) {
    if (!root || !Array.isArray(items) || !items.length) return;
    const hasRealTime = items.some(it => it.time && it.time.trim());
    if (!hasRealTime) return;
    root.querySelectorAll(".event-row").forEach(el => el.remove());
    // esc() is already defined at the IIFE scope above
    items.forEach(it => {
      if (!it.event && !it.time) return;
      const row = document.createElement("div");
      row.className = "event-row";
      row.innerHTML =
        '<div class="event-time">' + esc(it.time || "") + '</div>' +
        '<div class="event-dot"></div>' +
        '<div class="event-name">' + esc(it.event || "") + '</div>';
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
    show(".ff-song-request", ff.song_request === "on");

    // رقم الهاتف: إظهار/إخفاء + إلزامي أو اختياري من لوحة التحكم
    document.querySelectorAll(".ff-phone input").forEach(el => {
      el.required = (ff.phone !== "off" && ff.phone_required === "on");
    });

    applyGuestsCount(ff);
    applyChildrenPolicy(ff);
  }

  // ===== عدد الضيوف: عدد ثابت أو نطاق (حد أدنى/أقصى) من لوحة التحكم =====
  function applyGuestsCount(ff) {
    const wrap = document.querySelector(".ff-guests-count");
    const select = document.querySelector('select[name="Number_of_Guests"]');
    if (!wrap) return;

    if (ff.guests_count === "off") {
      wrap.style.display = "none";
      if (select) select.required = false;
      return;
    }

    if (!select) { wrap.style.display = ""; return; }

    const mode = ff.guests_mode || "range";
    let hideBecauseSingle = false;

    if (mode === "fixed") {
      const fixed = parseInt(ff.guests_fixed_count, 10) || 1;
      select.replaceChildren(new Option(String(fixed), String(fixed), true, true));
      hideBecauseSingle = fixed <= 1;
    } else {
      const min = Math.max(1, parseInt(ff.guests_min, 10) || 1);
      const max = Math.max(min, parseInt(ff.guests_max, 10) || 4);
      const fragment = document.createDocumentFragment();
      for (let i = min; i <= Math.min(max, 20); i++) {
        fragment.appendChild(new Option(String(i), String(i)));
      }
      select.replaceChildren(fragment);
      hideBecauseSingle = (min === 1 && max === 1);
    }

    // "إخفاء عدد الضيوف إذا كان الحد المسموح به شخصًا واحدًا"
    wrap.style.display = hideBecauseSingle ? "none" : "";
    select.required = !hideBecauseSingle;
  }

  // ===== سياسة حضور الأطفال (نعم/لا) من لوحة التحكم =====
  function applyChildrenPolicy(ff) {
    const wrap = document.querySelector(".ff-children");
    if (!wrap) return;

    let msgEl = document.getElementById("jg-children-msg");
    const allow = ff.allow_children;
    window.__jgAllowChildren = allow;

    if (allow === undefined) {
      // لم تُحدَّد السياسة بعد: نحافظ على السلوك القديم بدون رسالة
      wrap.style.display = ff.children === "on" ? "" : "none";
      if (msgEl) msgEl.style.display = "none";
      return;
    }

    if (!msgEl) {
      msgEl = document.createElement("div");
      msgEl.id = "jg-children-msg";
      msgEl.className = "cormorant text-brown-soft";
      msgEl.style.cssText = "text-align:center;font-size:14px;margin:2px 0 14px;";
      wrap.parentNode.insertBefore(msgEl, wrap);
    }
    msgEl.style.display = "";
    msgEl.textContent = allow === "yes" ? t("childrenWelcome") : t("childrenAdultsOnly");
    wrap.style.display = allow === "yes" ? "" : "none";
    wrap.querySelectorAll("input").forEach(el => { el.required = false; });
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
    // لو الصفحة وصلت عن طريق الرابط المخصص (jamratghadah.com/sara-ahmed)، هذا
    // يميّز هذي العميلة عن أي عميلة ثانية تستخدم نفس القالب — بدونه، ردود
    // الحضور لعميلتين مختلفتين على نفس القالب تنخلط مع بعض.
    const eventSlug = document.body.dataset.coupleSlug || slug;

    let data = {}, settings = {};
    try {
      const qs = new URLSearchParams(window.location.search);
      const inviteCode = qs.get("code") || "";
      const inviteEid = qs.get("eid") || document.body.dataset.eventCode || "";
      const inviteG = qs.get("g") || document.body.dataset.guestCode || "";
      const inviteUrl = `/.netlify/functions/invitation-data?slug=${encodeURIComponent(slug)}${inviteCode ? `&code=${encodeURIComponent(inviteCode)}` : ""}${inviteEid ? `&eid=${encodeURIComponent(inviteEid)}` : ""}${inviteG ? `&g=${encodeURIComponent(inviteG)}` : ""}`;
      [data, settings] = await Promise.all([
        fetch(inviteUrl, { cache: "no-store" }).then(async r => {
          if (!r.ok) throw new Error(r.status === 403 ? "INVITATION_PROTECTED" : "INVITATION_LOAD_FAILED");
          return r.json();
        }),
        fetch("../content/settings.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
      ]);
      window.__jgRsvpToken = data.rsvp_token || "";
      try { delete data.rsvp_token; } catch {}
    } catch (e) {
      if (e && e.message === "INVITATION_PROTECTED") showAccessDenied();
      return;
    }

    // بوابة الحماية تُنفّذ الآن server-side داخل invitation-data function.
    // إذا رفض الخادم الطلب، لا نعرض أي بيانات الدعوة.


    // قفل تلقائي بعد انتهاء تاريخ المناسبة — منع استقبال ردود جديدة (قابل للتحكم من لوحة التحكم)
    const security = data.security || {};
    if (security.auto_lock !== "off") {
      const lockHours = parseInt(security.auto_lock_hours || "24", 10);
      const eventDate = parseArabicDate(data.date);
      const now = new Date();
      const eventExpired = eventDate && now > new Date(eventDate.getTime() + lockHours * 60 * 60 * 1000);
      if (eventExpired) {
        lockRsvpForm();
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

    // نموذج تأكيد الحضور — الإرسال يتم حصريًا عبر Netlify Function.
    // لا نرسل أسماء/هواتف الضيوف إلى Formspree.
    const form = document.getElementById("rsvpForm");
    if (form) {
      form.removeAttribute("action");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const fd = new FormData(form);
        const attendance = fd.get("Attendance") || fd.get("attendance") || "";
        const guestName = (fd.get("Guest_Name") || fd.get("guest_name") || "").toString().slice(0, 180);
        const phone = (fd.get("Phone_Number") || fd.get("phone_number") || "").toString().slice(0, 30);
        const status = /accept/i.test(attendance) ? "yes" : "no";
        const guestsCount = (fd.get("Number_of_Guests") || fd.get("number_of_guests") || "").toString().slice(0, 10);
        const qs = new URLSearchParams(window.location.search);
        const inviteEventCode = document.body.dataset.eventCode || qs.get("eid") || "";
        const inviteGuestCode = document.body.dataset.guestCode || qs.get("g") || "";
        window.__jgLastEventCode = inviteEventCode;
        const responseDocId = inviteEventCode && inviteGuestCode ? `${inviteEventCode}_${inviteGuestCode}` : "";
        const submitBtn = form.querySelector(".submit-btn");
        const original = submitBtn ? submitBtn.textContent : "";
        if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.sending = "1"; submitBtn.textContent = t("sending"); }
        try {
          const response = await fetch("/.netlify/functions/submit-rsvp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: window.__jgRsvpToken,
              name: guestName, phone, status, guests: guestsCount,
              companions: Number(guestsCount || 0), style: slug,
              eventSlug, eventCode: inviteEventCode,
              guestId: inviteGuestCode
            })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.entryCode) throw new Error("RSVP_SUBMIT_FAILED");
          const serverEntryCode = result.entryCode;
          window.__jgLastEntryCode = serverEntryCode;
          document.getElementById("rsvp-form-container").style.display = "none";
          document.getElementById("success-msg").style.display = "block";
          document.dispatchEvent(new CustomEvent("jg:rsvp-success", {
            detail: { guestName, entryCode: serverEntryCode, eventCode: inviteEventCode, responseId: responseDocId }
          }));
          form.reset();
          // Notification is best-effort and separately rate-limited server-side.
          fetch("/.netlify/functions/notify-rsvp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              guestName, phone, status, guests: guestsCount,
              companions: Number(guestsCount || 0), style: slug,
              eventSlug, eventCode: inviteEventCode,
              guestId: inviteGuestCode, entryCode: serverEntryCode,
              responseId: responseDocId, token: window.__jgRsvpToken
            })
          }).catch(() => {});
        } catch (error) {
          alert("تعذر إرسال تأكيد الحضور. حاول مرة أخرى.");
          if (submitBtn) { submitBtn.disabled = false; delete submitBtn.dataset.sending; submitBtn.textContent = original || t("submit"); }
        }
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
