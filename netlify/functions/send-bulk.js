// netlify/functions/send-bulk.js
//
// Bulk send to selected guests from the dashboard (dashboard/guests.html),
// with channel selection: WhatsApp only / email only / both.
// + support for attaching video and/or image (card) with text.
//
// ⚠️ Requires admin authentication (Firebase ID Token with admin/super_admin role).
//
// Environment variables required (same as other functions in this project):
//   WHATSAPP_PHONE_ID, WHATSAPP_TOKEN   — for WhatsApp channel
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM  — for email channel
//
// Media (video/image) is sent via direct URL (e.g. Cloudinary link) —
// not uploaded directly from the browser.

const crypto = require("crypto");
const { getAdminDb } = require("./_report-lib");
const { requireAdmin } = require("./_auth");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const MAX_RECIPIENTS = 500;

function corsHeaders(event) {
  const origin = event.headers.origin || "";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  } else {
    headers["Access-Control-Allow-Origin"] = "null";
  }
  return headers;
}

// Rate limiting: persistent (Firestore-backed) — survives cold starts,
// unlike an in-memory Map which resets whenever the function container recycles.
const { checkRateLimit } = require("./_rate-limit");
const RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const RATE_LIMIT_MAX = 10;

function buildMessage(template, name) {
  return String(template || "").replaceAll("{name}", name || "");
}



function makeEmailActionToken(guestId, email, eventId, status) {
  const secret = process.env.EMAIL_RSVP_SECRET || process.env.CRON_SECRET || "";
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify({ guestId, email, eventId, status, exp: Date.now() + 7*24*60*60*1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + sig;
}

function sanitizeInviteSettings(raw) {
  const x = raw && typeof raw === "object" ? raw : {};
  const safeUrl = (v) => (typeof v === "string" && v.startsWith("https://") ? v.slice(0, 1000) : "");
  const fonts = ["Tahoma", "Arial", "Georgia", "Trebuchet MS"];
  return {
    videoUrl: safeUrl(x.videoUrl),
    emailBgUrl: safeUrl(x.emailBgUrl),
    emailFont: fonts.includes(x.emailFont) ? x.emailFont : "Tahoma",
    emailHeadline: String(x.emailHeadline || "دعوة خاصة إليك 🤍").slice(0, 120),
    emailButtonText: String(x.emailButtonText || "مشاهدة الدعوة 🎥").slice(0, 60),
    emailBody: String(x.emailBody || "يسعدنا دعوتك لمشاركتنا مناسبتنا 🤍").slice(0, 1000),
  };
}

async function getGuestEventSettings(db, guestData) {
  const eventId = guestData.eventId || guestData.eventCode || guestData.eventSlug;
  if (!eventId) return {};
  try {
    const snap = await db.collection("events").doc(String(eventId)).get();
    if (!snap.exists) return {};
    return sanitizeInviteSettings(snap.data().invitationDelivery);
  } catch {
    return {};
  }
}

/** Validate that a URL starts with https:// */
function isValidHttpsUrl(url) {
  if (!url || typeof url !== "string") return false;
  return url.startsWith("https://");
}

async function waRequest(phoneId, token, body) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function sendOneWhatsApp(phone, { message, contentTypes, imageUrl, videoUrl }) {
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";
  if (!phoneId || !token) return { ok: false, error: "واتساب غير مضبوط (WHATSAPP_PHONE_ID/WHATSAPP_TOKEN)" };
  const to = String(phone || "").replace(/[^0-9]/g, "");
  if (!to) return { ok: false, error: "رقم جوال غير صالح" };

  const wantImage = contentTypes.includes("image") && !!imageUrl;
  const wantVideo = contentTypes.includes("video") && !!videoUrl;
  const wantText = contentTypes.includes("text") && !!message;

  if (!wantImage && !wantVideo) {
    return waRequest(phoneId, token, { messaging_product: "whatsapp", to, type: "text", text: { body: message } });
  }

  const steps = [];
  let captionUsed = false;

  if (wantVideo) {
    const caption = wantText && !captionUsed ? message : undefined;
    if (caption) captionUsed = true;
    steps.push(waRequest(phoneId, token, {
      messaging_product: "whatsapp", to, type: "video",
      video: { link: videoUrl, ...(caption ? { caption } : {}) },
    }));
  }
  if (wantImage) {
    const caption = wantText && !captionUsed ? message : undefined;
    if (caption) captionUsed = true;
    steps.push(waRequest(phoneId, token, {
      messaging_product: "whatsapp", to, type: "image",
      image: { link: imageUrl, ...(caption ? { caption } : {}) },
    }));
  }
  if (wantText && !captionUsed) {
    steps.push(waRequest(phoneId, token, { messaging_product: "whatsapp", to, type: "text", text: { body: message } }));
  }

  const results = await Promise.all(steps);
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return { ok: true };
  return { ok: false, error: failed.map((r) => r.error).join(" | ") };
}

async function sendOneEmail(email, subject, { message, contentTypes, imageUrl, videoUrl, emailBgUrl, emailFont, emailHeadline, emailButtonText, emailBody, confirmUrl, declineUrl }) {
  if (!email) return { ok: false, error: "لا يوجد بريد إلكتروني لهذا الضيف" };
  const { sendReportEmail } = require("./_report-lib");
  const esc = (v) => String(v || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

  const wantImage = contentTypes.includes("image") && !!imageUrl;
  const wantVideo = contentTypes.includes("video") && !!videoUrl;
  const headline = esc(emailHeadline || subject || "دعوة خاصة إليك 🤍");
  const bodyText = esc(emailBody || message || "يسعدنا دعوتك لمشاركتنا مناسبتنا 🤍");
  const buttonText = esc(emailButtonText || "مشاهدة الدعوة 🎥");
  const font = ["Tahoma","Arial","Georgia","Trebuchet MS"].includes(emailFont) ? emailFont : "Tahoma";

  let media = "";
  if (wantImage) media += `<img src="${esc(imageUrl)}" alt="بطاقة الدعوة" style="max-width:100%;border-radius:14px;display:block;margin:18px auto" />`;
  if (wantVideo) media += `<a href="${esc(videoUrl)}" style="display:inline-block;padding:13px 24px;background:#C5A059;color:#2c2009;border-radius:999px;text-decoration:none;font-weight:bold">${buttonText}</a>`;
  const actionButtons = (confirmUrl || declineUrl) ? `<div style="margin-top:28px">
    ${confirmUrl ? `<a href="${esc(confirmUrl)}" style="display:inline-block;margin:5px;padding:12px 22px;background:#2e7d32;color:#fff;border-radius:999px;text-decoration:none;font-weight:bold">✓ تأكيد الحضور</a>` : ""}
    ${declineUrl ? `<a href="${esc(declineUrl)}" style="display:inline-block;margin:5px;padding:12px 22px;background:#8b4b3f;color:#fff;border-radius:999px;text-decoration:none;font-weight:bold">✕ أعتذر</a>` : ""}
  </div>` : "";

  const bg = emailBgUrl ? `background-image:url('${esc(emailBgUrl)}');background-size:cover;background-position:center;` : "";
  const html = `<!doctype html><html dir="rtl"><body style="margin:0;background:#f4f1ea;padding:24px;font-family:${font},Arial,sans-serif">
  <div style="max-width:620px;margin:0 auto;${bg}background-color:#fff;border-radius:22px;overflow:hidden">
    <div style="background:rgba(20,20,20,.78);padding:42px 28px;text-align:center;color:#fff">
      <div style="font-size:28px;font-weight:bold;margin-bottom:16px">${headline}</div>
      <div style="font-size:16px;line-height:2">${bodyText}</div>
      <div style="margin-top:24px">${media}${actionButtons}</div>
      <div style="font-size:12px;opacity:.7;margin-top:22px">هذه الدعوة مخصصة لك</div>
    </div>
  </div></body></html>`;

  try {
    const result = await sendReportEmail({ to: [email], subject: subject || headline, text: message || emailBody || "", html });
    if (!result.sent) return { ok: false, error: result.reason || "الإيميل غير مضبوط (SMTP)" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // Verify admin privileges
  const adminUser = await requireAdmin(event);
  if (!adminUser) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "غير مصرح — صلاحية إدارية مطلوبة" }) };
  }

  const { uid } = adminUser;

  // Rate limiting — persistent per-admin bucket, survives cold starts
  const rl = await checkRateLimit(() => getAdminDb(), event, `send-bulk_${uid}`, {
    max: RATE_LIMIT_MAX,
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (!rl.allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "طلبات كثيرة جدًا — حاولي بعد 5 دقائق" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { guestIds, channel, message, subject, imageUrl, videoUrl } = payload;
  const contentTypes = Array.isArray(payload.contentTypes) && payload.contentTypes.length
    ? payload.contentTypes
    : ["text"];

  // Validate URL inputs — must be HTTPS
  if (imageUrl && !isValidHttpsUrl(imageUrl)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "رابط الصورة يجب أن يبدأ بـ https://" }) };
  }
  if (videoUrl && !isValidHttpsUrl(videoUrl)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "رابط الفيديو يجب أن يبدأ بـ https://" }) };
  }

  if (!Array.isArray(guestIds) || !guestIds.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "لازم تختارين ضيف واحد على الأقل" }) };
  }

  // Max recipients limit
  if (guestIds.length > MAX_RECIPIENTS) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `الحد الأقصى ${MAX_RECIPIENTS} ضيف لكل حملة` }) };
  }

  const hasMedia = (contentTypes.includes("image") && imageUrl) || (contentTypes.includes("video") && videoUrl);
  if (!hasMedia && (!message || !message.trim())) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "لازم نص رسالة، أو رابط صورة/فيديو على الأقل" }) };
  }
  const useWhatsApp = channel === "whatsapp" || channel === "both";
  const useEmail = channel === "email" || channel === "both";
  if (!useWhatsApp && !useEmail) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "اختاري قناة الإرسال" }) };
  }

  const db = getAdminDb();
  const results = [];

  for (const id of guestIds) {
    let guestData;
    try {
      const doc = await db.collection("responses").doc(id).get();
      if (!doc.exists) {
        results.push({ id, ok: false, error: "الضيف غير موجود" });
        continue;
      }
      guestData = doc.data();
    } catch (err) {
      results.push({ id, ok: false, error: "تعذّرت قراءة بيانات الضيف" });
      continue;
    }

    const name = guestData.name || "ضيف";
    const eventSettings = await getGuestEventSettings(db, guestData);
    const effectiveVideoUrl = videoUrl || eventSettings.videoUrl || "";
    const effectiveImageUrl = imageUrl || "";
    const effectiveMessage = message || eventSettings.emailBody || "";
    const personalized = buildMessage(effectiveMessage, name);
    const effectiveSubject = subject || eventSettings.emailHeadline || "دعوة خاصة إليك 🤍";
    const effectiveContentTypes = Array.isArray(payload.contentTypes) && payload.contentTypes.length
      ? contentTypes
      : (effectiveVideoUrl ? ["video", "text"] : ["text"]);
    const siteBase = process.env.URL || process.env.DEPLOY_URL || "https://jamratghadah.com";
    const eventKey = guestData.eventId || guestData.eventCode || guestData.eventSlug || "";
    const confirmToken = makeEmailActionToken(id, guestData.email || "", eventKey, "yes");
    const declineToken = makeEmailActionToken(id, guestData.email || "", eventKey, "no");
    const mediaOpts = {
      message: personalized,
      contentTypes: effectiveContentTypes,
      imageUrl: effectiveImageUrl,
      videoUrl: effectiveVideoUrl,
      emailBgUrl: eventSettings.emailBgUrl,
      emailFont: eventSettings.emailFont,
      emailHeadline: eventSettings.emailHeadline,
      emailButtonText: eventSettings.emailButtonText,
      emailBody: eventSettings.emailBody,
      confirmUrl: confirmToken ? `${siteBase}/.netlify/functions/email-rsvp-action?token=${encodeURIComponent(confirmToken)}` : "",
      declineUrl: declineToken ? `${siteBase}/.netlify/functions/email-rsvp-action?token=${encodeURIComponent(declineToken)}` : "",
    };
    const perGuest = { id, name, whatsapp: null, email: null };

    if (useWhatsApp) {
      perGuest.whatsapp = await sendOneWhatsApp(guestData.phone, mediaOpts);
    }
    if (useEmail) {
      perGuest.email = await sendOneEmail(guestData.email, effectiveSubject, mediaOpts);
    }

    const attempted = [perGuest.whatsapp, perGuest.email].filter(Boolean);
    const success = attempted.length > 0 && attempted.every((r) => r.ok);
    results.push({ id, name, ok: success, whatsapp: perGuest.whatsapp, email: perGuest.email });
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ sent, failed, total: results.length, results }),
  };
};
