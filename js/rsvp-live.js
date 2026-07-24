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
    // يقبل صيغة "12 / 10 / 2026" (يوم/شهر/سنة)
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
    // نستبدل التايم لاين بس لو فيه وقت حقيقي متعبّى (مو بس أسماء الأحداث الافتراضية من القالب)
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

  // يضيف حركة فتح حقيقية (غطاء يفتح لفوق، أو نصين ينفتحان) فوق نفس صورة الظرف/الباب،
  // بدون ما يغيّر منطق الفيديو/الصوت الأصلي في كل صفحة — الحركة تشتغل بالتوازي مع التلاشي الموجود.
  // كمان يضيف توهّج ذهبي من نص الظرف/الباب لحظة الفتح (يشتغل مع الأنواع الثلاثة كلها).
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

    // توهّج الختم: يضاف دايمًا (حتى مع التلاشي العادي)
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

    // بوابة الحماية: الصفحة ما تفتح إلا برمز صحيح داخل الرابط (اللي يكون مدمج داخل QR)
    if (data.access_code && String(data.access_code).trim()) {
      const urlCode = new URLSearchParams(window.location.search).get("code");
      if (urlCode !== String(data.access_code).trim()) {
        showAccessDenied();
        return;
      }
    }

    // الأسماء / العنوان
    if (data.names) {
      setNames(document.querySelector(".hero-names"), data.names);
      const footerLine = document.querySelector("footer .cormorant.italic, footer .text-brown-soft");
      if (footerLine) footerLine.textContent = data.names;
    }

    // التاريخ (النص المعروض + التاريخ الفعلي للعد التنازلي)
    if (data.date) {
      const dateEl = document.querySelector(".hero-date, .date-container");
      if (dateEl) dateEl.textContent = data.date;
      const target = parseArabicDate(data.date);
      if (target) restartCountdown(target.getTime());
      const deadlineEl = document.querySelector("#rsvp-form-container p");
      if (deadlineEl && /RSVP before|Please RSVP/i.test(deadlineEl.textContent)) {
        deadlineEl.textContent = "الرجاء تأكيد الحضور قبل " + data.date;
      }
    }

    // الموقع (النص + خريطة جوجل بدون مفتاح API)
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
    // حركة فتح الظرف/الباب (من لوحة التحكم): تلاشي (افتراضي) / فتح غطاء لفوق / فتح لنصين
    applyEnvelopeAnimation(data.envelope_animation, document.querySelector("#envelope-overlay img"));
    if (data.intro_video) {
      const introSrc = document.querySelector("#introVideo source");
      if (introSrc) { introSrc.src = data.intro_video; document.getElementById("introVideo").load(); }
    }
    if (data.seal_image) {
      const seal = document.querySelector(".wax-seal");
      if (seal) seal.src = data.seal_image;
    }

    // نموذج تأكيد الحضور: رابط الإرسال (Formspree خاص بالطلب أو العام)
    const form = document.getElementById("rsvpForm");
    const endpoint = data.formspree_override || settings.formspree_id;
    if (form && endpoint) form.action = endpoint;

    // نسخة من كل تأكيد حضور تُكتب أيضًا بقاعدة بيانات Firestore
    // (نفس القاعدة اللي تقرأ منها أداة "تذكير الضيوف" بلوحة التحكم)
    // هذا إضافي على إرسال Formspree، ما يوقفه ولا يتعارض معه
    if (form) {
      form.addEventListener("submit", () => {
        const fd = new FormData(form);
        const attendance = fd.get("Attendance") || fd.get("attendance") || "";
        addDoc(collection(db, "responses"), {
          name: fd.get("Guest_Name") || fd.get("guest_name") || "",
          phone: fd.get("Phone_Number") || fd.get("phone_number") || "",
          status: /accept/i.test(attendance) ? "yes" : "no",
          guests: fd.get("Number_of_Guests") || fd.get("number_of_guests") || "",
          style: slug,
          createdAt: serverTimestamp(),
        }).catch(() => { /* ما نوقف تجربة الضيف لو صار خطأ بالكتابة */ });
      });
    }

    // تصميم النصوص (خط/حجم) من لوحة التحكم
    applyDesign(data.design);

    // التأثيرات البصرية والصوتية من لوحة التحكم
    applyEffects(data.effects);
  });
})();
