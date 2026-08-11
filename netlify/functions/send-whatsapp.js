// netlify/functions/send-whatsapp.js
//
// يُستدعى من لوحة التحكم أو من التطبيق لإرسال رسائل واتساب عبر
// WhatsApp Business API (الرسمي من Meta).
//
// متغيرات البيئة المطلوبة في Netlify:
//   WHATSAPP_PHONE_ID    — رقم هاتف الحساب التجاري (مثال: 966500000000)
//   WHATSAPP_TOKEN       — رمز الوصول الدائم (Permanent Access Token)
//
// ملاحظة: الرمز يتجدد كل 90 يوم — لازم تحدثه من Meta Business Suite.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { recipients, message, mediaUrl } = payload;
  // recipients: [{ phone: "9665xxxxxxxx" }]  — بصيغة دولية بدون +
  // message: نص الرسالة
  // mediaUrl: (اختياري) رابط صورة أو فيديو أو مستند

  if (!Array.isArray(recipients) || !recipients.length || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: "recipients[] و message مطلوبين" }) };
  }

  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";

  if (!phoneId || !token) {
    return {
      statusCode: 503,
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
        const mediaType = r.mediaType || guessMediaType(mediaUrl);
        messageData = {
          messaging_product: "whatsapp",
          to: phone,
          type: mediaType,
          [mediaType]: {
            link: mediaUrl,
            caption: message,
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
      results.push({ phone, ok: false, error: String(err) });
    }
  }

  const sent = results.filter(r => r.ok).length;
 const failed = results.filter(r => !r.ok).length;

  return {
    statusCode: 200,
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
