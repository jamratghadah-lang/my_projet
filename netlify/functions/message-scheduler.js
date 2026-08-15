// netlify/functions/message-scheduler.js
//
// دالة مُجدولة (cron) تعالج الرسائل المُخطَّطة.
// تبحث عن وثائق في `scheduled_messages` بحالة "pending" ووقت جدولة مضى،
// ثم ترسلها عبر WhatsApp أو SMS حسب القناة المحددة.
//
// لتشغيلها كـ cron في Netlify، أضيفي في netlify.toml:
//   [[scheduled_functions]]
//     function = "message-scheduler"
//     cron = "* * * * *"   # كل دقيقة

const admin = require("firebase-admin");
const { getAdminApp, safeEqual } = require("./_auth");

function verifyCronSecret(event) {
  if (event.httpMethod === 'SCHEDULED') return true;
  const provided = (event.headers && event.headers['x-cron-secret']) || '';
  const expected = process.env.CRON_SECRET || '';
  if (!expected || !safeEqual(provided, expected)) return false;
  return true;
}

// ===== إرسال واتساب (نفس نمط send-whatsapp.js) =====
async function sendViaWhatsApp(phone, message, mediaUrl) {
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";

  if (!phoneId || !token) {
    return { ok: false, error: "PROVIDER_NOT_CONFIGURED" };
  }

  const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
  if (!cleanPhone) return { ok: false, error: "رقم غير صالح" };

  const API_BASE = "https://graph.facebook.com/v21.0";
  let messageData;

  if (mediaUrl) {
    const mediaType = guessMediaType(mediaUrl);
    messageData = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: mediaType,
      [mediaType]: { link: mediaUrl, caption: message },
    };
  } else {
    messageData = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "text",
      text: { body: message },
    };
  }

  try {
    const res = await fetch(`${API_BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messageData),
    });
    const resData = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      messageId: resData.messages?.[0]?.id || null,
      error: resData.error?.message || null,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ===== إرسال SMS (نفس نمط send-sms.js) =====
async function sendViaSMS(phone, message) {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) {
    return { ok: false, error: "PROVIDER_NOT_CONFIGURED" };
  }

  const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
  if (!cleanPhone) return { ok: false, error: "رقم غير صالح" };

  try {
    let res;
    if (provider === "msegat") {
      res = await fetch("https://www.msegat.com/gw/sendsms.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userName: process.env.MSEGAT_USERNAME || "",
          apiKey: process.env.MSEGAT_API_KEY || "",
          userSender: process.env.MSEGAT_SENDER_NAME || "",
          numbers: cleanPhone,
          msg: message,
        }),
      });
    } else if (provider === "unifonic") {
      res = await fetch("https://basic.unifonic.com/rest/SMS/messages", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          AppSid: process.env.UNIFONIC_APP_SID || "",
          SenderID: process.env.UNIFONIC_SENDER_ID || "",
          Body: message,
          Recipient: cleanPhone,
        }),
      });
    } else if (provider === "twilio") {
      const sid = process.env.TWILIO_ACCOUNT_SID || "";
      const token = process.env.TWILIO_AUTH_TOKEN || "";
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        },
        body: new URLSearchParams({
          From: process.env.TWILIO_FROM_NUMBER || "",
          To: cleanPhone,
          Body: message,
        }),
      });
    } else {
      return { ok: false, error: "مزوّد غير معروف" };
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ===== تخمين نوع الوسائط =====
function guessMediaType(url) {
  const lower = (url || "").toLowerCase();
  if (/\.(mp4|webm|mov|avi)($|[?#])/i.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp|gif)($|[?#])/i.test(lower)) return "image";
  if (/\.(pdf|doc|docx)($|[?#])/i.test(lower)) return "document";
  return "image";
}

// ===== Handler رئيسي =====
exports.handler = async (event) => {
  if (!verifyCronSecret(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const adminApp = getAdminApp();
    if (!adminApp) {
      return { statusCode: 500, body: JSON.stringify({ error: "Firebase Admin not initialized" }) };
    }

    const db = adminApp.firestore();
    const now = new Date();

    // البحث عن رسائل مُجدولة بحالة pending ووقت الجدولة مضى
    const snapshot = await db
      .collection("scheduled_messages")
      .where("status", "==", "pending")
      .where("scheduleAt", "<=", admin.firestore.Timestamp.fromDate(now))
      .limit(50)
      .get();

    if (snapshot.empty) {
      return {
        statusCode: 200,
        body: JSON.stringify({ processed: 0, sent: 0, failed: 0 }),
      };
    }

    let sent = 0;
    let failed = 0;
    const processed = snapshot.size;

    for (const doc of snapshot.docs) {
      const msgData = doc.data();
      const docRef = doc.ref;
      let result;

      try {
        // تحليل محتوى الرسالة
        let messageText = "";
        let mediaUrl = "";
        let phone = "";
        const channel = msgData.channel || "whatsapp";

        if (typeof msgData.content === "string") {
          try {
            const parsed = JSON.parse(msgData.content);
            messageText = parsed.message || parsed.text || "";
            mediaUrl = parsed.mediaUrl || parsed.media || "";
            phone = parsed.phone || "";
          } catch {
            messageText = msgData.content;
            phone = msgData.phone || "";
          }
        } else if (typeof msgData.content === "object" && msgData.content !== null) {
          messageText = msgData.content.message || msgData.content.text || "";
          mediaUrl = msgData.content.mediaUrl || msgData.content.media || "";
          phone = msgData.content.phone || "";
        }

        if (!phone) phone = msgData.phone || "";

        if (!messageText && !mediaUrl) {
          result = { ok: false, error: "NO_CONTENT" };
        } else if (channel === "whatsapp") {
          result = await sendViaWhatsApp(phone, messageText, mediaUrl);
        } else if (channel === "sms") {
          result = await sendViaSMS(phone, messageText);
        } else {
          result = { ok: false, error: `قناة غير مدعومة: ${channel}` };
        }
      } catch (err) {
        result = { ok: false, error: String(err) };
      }

      // تحديث وثيقة الرسالة المُجدولة
      const updateData = {
        status: result.ok ? "sent" : "failed",
        executedAt: admin.firestore.FieldValue.serverTimestamp(),
        result: result.ok ? "sent" : (result.error || "unknown error"),
      };

      try {
        await docRef.update(updateData);
      } catch (e) {
        // تجاهل خطأ التحديث
      }

      // إنشاء سجل إرسال
      try {
        await db.collection("send_logs").add({
          channel: msgData.channel || "unknown",
          phone: msgData.phone || (msgData.content && typeof msgData.content === "object" ? msgData.content.phone : ""),
          status: result.ok ? "sent" : "failed",
          error: result.error || null,
          messageId: result.messageId || null,
          scheduledMessageId: doc.id,
          triggeredBy: "scheduler",
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        // تجاهل خطأ التسجيل
      }

      if (result.ok) {
        sent++;
      } else {
        failed++;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ processed, sent, failed }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err), processed: 0, sent: 0, failed: 0 }),
    };
  }
};
