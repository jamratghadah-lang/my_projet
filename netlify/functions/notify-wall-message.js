// netlify/functions/notify-wall-message.js
//
// يُستدعى فور ما ضيف يرسل كلمة بحائط التعليقات (خاصة أو عامة). يرسل إيميل
// فوري لصاحبة المناسبة/المدير حسب إعدادات content/settings.json → reports.
//
// - الكلمة الخاصة: توصل بالإيميل فقط، وما تُحفظ بحائط guest_wall العام أبدًا.
// - الكلمة العامة: تُحفظ بالحائط (من entry-card.js مباشرة) وتوصل بالإيميل كمان.

const { resolveRecipients, sendReportEmail, escapeHtml, getAdminDb } = require("./_report-lib");
const { checkRateLimit } = require("./_rate-limit");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const rl = await checkRateLimit(() => getAdminDb(), event, "notify-wall-message", { max: 8, windowSeconds: 60 });
  if (!rl.allowed) {
    return { statusCode: 429, body: JSON.stringify({ sent: false, reason: "RATE_LIMITED" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { slug, name, message, isPrivate } = payload;

  // تحقق أساسي من الحجم لمنع إساءة الاستخدام. الدالة علنية (لا تتطلب تسجيل دخول)
  // لأنها تُستدعى من صفحة RSVP بعد تأكيد الضيف، لكن نمنع الرسائل الضخمة/الفارغة.
  const cleanStr = (v, max) => {
    if (v == null) return "";
    return String(v).slice(0, max || 500);
  };
  const cleanSlug = cleanStr(slug, 80);
  const cleanName = cleanStr(name, 120);
  const cleanMessage = cleanStr(message, 1500);
  const cleanIsPrivate = !!isPrivate;

  try {
    const { recipients } = await resolveRecipients();
    if (!recipients.length) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "NO_RECIPIENT_CONFIGURED" }) };
    }

    const kindLabel = cleanIsPrivate ? "كلمة خاصة 🔒 (ما راح تظهر بحائط التعليقات)" : "كلمة عامة 🌐 (منشورة بحائط التعليقات)";
    const subject = `${cleanIsPrivate ? "🔒" : "💬"} كلمة جديدة من: ${cleanName || "ضيف"}`;

    const textBody = [
      kindLabel,
      "",
      `من: ${cleanName || "—"}`,
      `الدعوة: ${cleanSlug || "—"}`,
      "",
      cleanMessage || "",
      "",
      `الوقت: ${new Date().toLocaleString("ar-SA")}`,
    ].join("\n");

    const htmlBody = `
      <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:480px;margin:0 auto;background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:24px;color:#eee">
        <div style="display:inline-block;background:${cleanIsPrivate ? "#3a2410" : "#0f2a2a"};color:${cleanIsPrivate ? "#e9c877" : "#7fd1c9"};font-size:12px;padding:4px 10px;border-radius:20px;margin-bottom:14px">${escapeHtml(kindLabel)}</div>
        <p style="color:#999;margin:0 0 4px;font-size:13px">من</p>
        <p style="color:#fff;margin:0 0 16px;font-weight:bold">${escapeHtml(cleanName || "ضيف")}</p>
        <p style="color:#999;margin:0 0 4px;font-size:13px">الكلمة</p>
        <p style="color:#fff;line-height:1.8;background:#222;border-radius:8px;padding:14px;margin:0">${escapeHtml(cleanMessage || "")}</p>
        <p style="color:#777;font-size:12px;margin-top:20px">${new Date().toLocaleString("ar-SA")}</p>
      </div>`;

    const result = await sendReportEmail({ to: recipients, subject, text: textBody, html: htmlBody });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: String(err) }) };
  }
};
