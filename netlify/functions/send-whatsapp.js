// netlify/functions/send-whatsapp.js
//
// يُستدعى من لوحة التحكم أو من التطبيق لإرسال رسائل واتساب عبر
// WhatsApp Business API (الرسمي من Meta).
//
// ⚠️ يتطلب تسجيل دخول إداري: يقرأ Authorization: Bearer <Firebase ID Token> ويتحقق
// منه بصلاحية إدارية (admin/super_admin)، عشان محد يقدر يستخدم هذا الرابط للإرسال العشوائي
// أو استنزاف رصيد واتساب التجاري.
//
// متغيرات البيئة المطلوبة في Netlify:
//   WHATSAPP_PHONE_ID    — رقم هاتف الحساب التجاري (مثال: 966500000000)
//   WHATSAPP_TOKEN       — رمز الوصول الدائم (Permanent Access Token)
//   FIREBASE_SERVICE_ACCOUNT_JSON — مفتاح خدمة Firebase (للتحقق من التوكن)
//
// ملاحظة: الرمز يتجدد كل 90 يوم — لازم تحدثه من Meta Business Suite.

const { requireAdmin } = require("./_auth");
const { checkRateLimit } = require("./_rate-limit");
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

const MEDIA_TYPE_WHITELIST = ["text", "image", "video", "document"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event), body: "Method Not Allowed" };
  }

  const cors = corsHeaders(event);

  // التحقق من صلاحية المستخدم قبل أي معالجة
  const admin = await requireAdmin(event);
  if (!admin) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "غير مصرح — سجّلي دخول بلوحة التحكم أولاً" }) };
  }

  // Rate limiting: 10 requests per 300 seconds
  const getDb = () => { const a = getAdminApp(); return a ? a.firestore() : null; };
  const rl = await checkRateLimit(getDb, event, "send-whatsapp", { max: 10, windowSeconds: 300 });
  if (!rl.allowed) {
    return { statusCode: 429, headers: cors, body: JSON.stringify({ error: "طلبات كثيرة — حاولي بعد دقائق" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { recipients, message, mediaUrl } = payload;
  // recipients: [{ phone: "9665xxxxxxxx" }]  — بصيغة دولية بدون +
  // message: نص الرسالة
  // mediaUrl: (اختياري) رابط صورة أو فيديو أو مستند

  if (!Array.isArray(recipients) || !recipients.length || !message) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "recipients[] و message مطلوبين" }) };
  }

  // حد أقصى لعدد المستلمين
  if (recipients.length > 500) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "حد أقصى 500 مستلم لكل طلب" }) };
  }

  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";

  if (!phoneId || !token) {
    return {
      statusCode: 503,
      headers: cors,
      body: JSON.stringify({
        error: "WhatsApp Business غير مضبوط بعد — أضيفي WHATSAPP_PHONE_ID و WHATSAPP_TOKEN في إعدادات Netlify",
      }),
    };
  }

  const API_BASE = "https://graph.facebook.com/v21.0";
  const results = [];

  for (const r of recipients) {
    const phone = String(r.phone || "").replace(/[^0-9]/g, "");
    if (!phone) {
      results.push({ phone: "invalid", ok: false, error: "رقم غير صالح" });
      continue;
    }

    try {
 // إنشاء الرسالة (نص فقط أو نص + وسائط)
      let messageData;

      if (mediaUrl) {
        // رسالة مع وسائط (صورة/فيديو/مستند)
        let mediaType = r.mediaType || guessMediaType(mediaUrl);
        // Validate mediaType against whitelist
        if (!MEDIA_TYPE_WHITELIST.includes(mediaType)) {
          mediaType = "document";
        }
        messageData = {
          messaging_product: "whatsapp",
          to: phone,
          type: mediaType,
          [mediaType]: {
            link: mediaUrl,
            caption: mediaType !== "document" ? message : undefined,
          },
        };
      } else {
        // رسالة نصية فقط
        messageData = {
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: message },
        };
      }

      const res = await fetch(`${API_BASE}/${phoneId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messageData),
      });

      const resData = await res.json().catch(() => ({}));

      results.push({
        phone,
        ok: res.ok,
        status: res.status,
        messageId: resData.messages?.[0]?.id || null,
        error: resData.error?.message || null,
      });
    } catch (err) {
      results.push({ phone, ok: false, error: "error" });
    }
  }

  const sent = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ sent, failed, total: results.length, results }),
  };
};

// ===== مساعد: تخمين نوع الوسائط من امتداد الرابط =====
function guessMediaType(url) {
  const lower = (url || "").toLowerCase();
  if (/\.(mp4|webm|mov|avi)($|[?#])/i.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp|gif)($|[?#])/i.test(lower)) return "image";
  if (/\.(pdf|doc|docx)($|[?#])/i.test(lower)) return "document";
  return "image"; // افتراضي
}
