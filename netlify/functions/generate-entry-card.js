// netlify/functions/generate-entry-card.js
//
// توليد صورة بطاقة الدخول على السيرفر (canvas) وحفظها في Firebase Storage.
// يُستدعى داخليًا من _ai-lib.js عند تأكيد الحضور عبر واتساب أو إعادة إرسال البطاقة.
//
// الاعتماديات: @napi-rs/canvas, qrcode
// متغيرات البيئة: FIREBASE_SERVICE_ACCOUNT_JSON

const { getAdminApp } = require("./_auth");

const ALLOWED_ORIGINS = ["https://jamratghadah.com", "https://admin.jamratghadah.com"];
function corsHeaders(event) {
  const origin = (event.headers.origin || "").toLowerCase();
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const C = {
  bg1: "#3a2a12", bg2: "#6b4a1e", bg3: "#3a2a12",
  txt: "#f6e9c9", sub: "#d8bd85", acc: "#e8c877",
  border: "rgba(246,233,201,0.55)",
  overlay: "rgba(20,14,6,0.28)",
};

const CW = 540, CH = 930, PAD = 44;

async function fetchImg(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawAr(ctx, text, cx, cy, font, color, maxW) {
  if (!text) return 0;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = "rtl";
  if (!maxW) { ctx.fillText(text, cx, cy); return 1; }
  const chars = [...text];
  const lines = [];
  let line = "";
  for (const ch of chars) {
    if (ch === "\n") { lines.push(line); line = ""; continue; }
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = ch; }
    else { line = test; }
  }
  if (line) lines.push(line);
  const fs = parseFloat(font) || 16;
  const lh = fs * 1.7;
  const totalH = lines.length * lh;
  const sy = cy - totalH / 2 + lh / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], cx, sy + i * lh);
  return lines.length;
}

async function drawQR(ctx, text, x, y, size) {
  try {
    const QRCode = require("qrcode");
    const { createCanvas } = require("@napi-rs/canvas");
    const qrC = createCanvas(size, size);
    await QRCode.toCanvas(qrC, text || "", {
      width: size, margin: 1,
      color: { dark: "#3a2a12", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    ctx.drawImage(qrC, x, y, size, size);
    return true;
  } catch (err) {
    console.error("[card] QR error:", err.message);
    return false;
  }
}

async function createCardImage(data) {
  const { createCanvas, Image } = require("@napi-rs/canvas");
  const canvas = createCanvas(CW, CH);
  const ctx = canvas.getContext("2d");
  const cx = CW / 2;

  // 1) خلفية متدرجة
  const bg = ctx.createLinearGradient(0, 0, CW * 0.4, CH);
  bg.addColorStop(0, C.bg1);
  bg.addColorStop(0.45, C.bg2);
  bg.addColorStop(1, C.bg3);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CW, CH);

  // 2) صورة خلفية
  if (data.bgImage) {
    const buf = await fetchImg(data.bgImage);
    if (buf) {
      try {
        const img = new Image();
        img.src = buf;
        const sc = Math.max(CW / img.width, CH / img.height);
        ctx.drawImage(img, (CW - img.width * sc) / 2, (CH - img.height * sc) / 2, img.width * sc, img.height * sc);
      } catch {}
    }
  }

  // 3) طبقة شفافة
  ctx.fillStyle = C.overlay;
  ctx.fillRect(0, 0, CW, CH);

  // 4) إطار داخلي
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1.5;
  rrect(ctx, PAD - 14, PAD - 14, CW - (PAD - 14) * 2, CH - (PAD - 14) * 2, 18);
  ctx.stroke();

  let y = PAD + 10;

  // 5) شعار
  if (data.logoImage) {
    const buf = await fetchImg(data.logoImage);
    if (buf) {
      try {
        const img = new Image();
        img.src = buf;
        const sz = 80;
        const asp = img.width / img.height;
        const lw = asp >= 1 ? sz : sz * asp;
        const lh = asp >= 1 ? sz / asp : sz;
        ctx.drawImage(img, cx - lw / 2, y, lw, lh);
        y += lh + 14;
      } catch { y += 10; }
    }
  }

  // 6) بطاقة دخول
  drawAr(ctx, "\u0628\u0637\u0627\u0642\u0629 \u062f\u062e\u0648\u0644", cx, y, "14px Tahoma, Arial, sans-serif", C.acc, 0);
  y += 30;

  // 7) نص مخصص
  const cardText = data.cardText || "\u064a\u0633\u0639\u062f\u0646\u0627 \u062d\u0636\u0648\u0631\u0643\u0645";
  drawAr(ctx, cardText, cx, y, "bold 26px Tahoma, Arial, sans-serif", C.txt, 0);
  y += 38;

  // 8) فاصل
  ctx.beginPath();
  ctx.moveTo(cx - 26, y); ctx.lineTo(cx + 26, y);
  ctx.strokeStyle = C.acc; ctx.lineWidth = 1; ctx.stroke();
  y += 26;

  // 9) الضيف / الضيفة
  drawAr(ctx, "\u0627\u0644\u0636\u064a\u0641 / \u0627\u0644\u0636\u064a\u0641\u0629", cx, y, "12px Tahoma, Arial, sans-serif", C.sub, 0);
  y += 28;

  // 10) اسم الضيف
  if (data.guestName) {
    drawAr(ctx, data.guestName, cx, y, "bold 36px Tahoma, Arial, sans-serif", C.txt, CW - PAD * 2 - 20);
    y += 50;
  }

  // 11) معلومات
  const meta = [];
  if (data.date) meta.push(data.date);
  if (data.location) meta.push(data.location);
  if (data.companions && parseInt(data.companions, 10) > 0)
    meta.push("\u0639\u062f\u062f \u0627\u0644\u0645\u0631\u0627\u0641\u0642\u064a\u0646: " + data.companions);
  if (data.table) meta.push("\u0631\u0642\u0645 \u0627\u0644\u0637\u0627\u0648\u0644\u0629: " + data.table);
  if (data.seat) meta.push("\u0631\u0642\u0645 \u0627\u0644\u0645\u0642\u0639\u062f: " + data.seat);
  if (data.gate) meta.push("\u0627\u0644\u0628\u0648\u0627\u0628\u0629: " + data.gate);
  if (meta.length) {
    const nLines = drawAr(ctx, meta.join("\n"), cx, y, "18px Tahoma, Arial, sans-serif", C.txt, CW - PAD * 2 - 20);
    y += nLines * 30.6 + 14;
  }

  // 12) QR
  const qrVal = data.entryCode
    ? JSON.stringify({ eventId: data.eventId || "", entryCode: data.entryCode })
    : "https://jamratghadah.com";
  const qrSz = 180;
  const qrX = cx - qrSz / 2;
  ctx.fillStyle = "#fff";
  rrect(ctx, qrX - 8, y, qrSz + 16, qrSz + 16, 10);
  ctx.fill();
  await drawQR(ctx, qrVal, qrX, y + 8, qrSz);
  y += qrSz + 30;

  // 13) كود الدخول
  if (data.entryCode) {
    ctx.font = "bold 16px Courier New, monospace";
    ctx.fillStyle = C.acc;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.direction = "ltr";
    ctx.fillText(data.entryCode, cx, y);
    y += 22;
  }
  drawAr(ctx, data.entryCode
    ? "\u0643\u0648\u062f \u062f\u062e\u0648\u0644\u0643 \u0627\u0644\u0634\u062e\u0635\u064a \u2014 \u064a\u064f\u0645\u0633\u062d \u0639\u0646\u062f \u0627\u0644\u0628\u0627\u0628 \u064a\u0648\u0645 \u0627\u0644\u0645\u0646\u0627\u0633\u0628\u0629"
    : "\u0627\u0645\u0633\u062d \u0627\u0644\u0631\u0645\u0632 \u0644\u0644\u0648\u0635\u0648\u0644 \u0644\u0644\u062f\u0639\u0648\u0629",
    cx, y, "12px Tahoma, Arial, sans-serif", C.sub, CW - PAD * 2 - 20);

  return canvas.toBuffer("image/png");
}

function loadCardSettings(slug) {
  const fs = require("fs");
  const path = require("path");
  const safeSlug = String(slug || "").replace(/[^a-z0-9-]/gi, "");
  if (!safeSlug) return {};
  try {
    const fp = path.join(__dirname, "..", "..", "content", "rsvp", safeSlug + ".json");
    const d = JSON.parse(fs.readFileSync(fp, "utf8"));
    const ec = d.entry_card || {};
    return {
      text: ec.text || "",
      bgImage: ec.background_image || "",
      logoImage: ec.logo_image || "",
      date: d.date || "",
      location: d.location || "",
      names: d.names || "",
    };
  } catch { return {}; }
}

async function handle(event) {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  let p;
  try { p = JSON.parse(event.body || "{}"); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const { guestName, entryCode, eventId, slug, companions, table, seat, gate } = p;
  if (!guestName && !entryCode)
    return { statusCode: 400, body: JSON.stringify({ error: "guestName or entryCode required" }) };
  const s = loadCardSettings(slug);
  const d = {
    guestName: guestName || "", date: p.date || s.date || "",
    location: p.location || s.location || "",
    table: table || "", seat: seat || "", gate: gate || "",
    entryCode: entryCode || "", eventId: eventId || "",
    companions: companions || "", cardText: s.text || "",
    bgImage: p.bgImage || s.bgImage || "",
    logoImage: p.logoImage || s.logoImage || "",
  };
  try {
    const img = await createCardImage(d);
    if (!img) return { statusCode: 500, body: JSON.stringify({ error: "Canvas generation failed" }) };
    const app = getAdminApp();
    if (!app) return { statusCode: 503, body: JSON.stringify({ error: "Firebase not initialized" }) };
    const bucket = app.storage().bucket();
    const sp = "entry-cards/" + (eventId || "default") + "/" + (entryCode || guestName) + ".png";
    const file = bucket.file(sp);
    await file.save(img, {
      metadata: { contentType: "image/png", cacheControl: "public, max-age=3600" },
    });
    await file.makePublic();
    return { statusCode: 200, body: JSON.stringify({ ok: true, url: file.publicUrl() }) };
  } catch (err) {
    console.error("[generate-entry-card]:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event), body: "" };
  const r = await handle(event);
  return { ...r, headers: { ...corsHeaders(event), ...(r.headers || {}) } };
};
exports.createCardImage = createCardImage;
exports.loadCardSettings = loadCardSettings;
