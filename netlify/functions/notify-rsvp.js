// netlify/functions/notify-rsvp.js
//
// يُستدعى فورًا بعد إرسال الضيف لتأكيد حضوره. يقرأ بيانات الرد ويُرسل إيميل
// إشعار فوري إلى صاحبة المناسبة و/أو المدير (حسب content/settings.json →
// reports)، يحتوي على اسم الضيف، حالته، رقم هاتفه، عدد مرافقيه، والقالب.
//
// متغيرات البيئة المطلوبة في Netlify:
//   NOTIFY_EMAIL_TO   — بريد المدير الافتراضي
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
//
// لو لم تُضبط متغيرات SMTP، الدالة ترجع 200 وتتجاهل الإرسال بصمت — حتى لا
// تكسر تجربة الضيف في صفحة الدعوة.

const { resolveRecipients, sendReportEmail, escapeHtml, getAdminDb } = require("./_report-lib");
const { checkRateLimit } = require("./_rate-limit");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // حد أقصى 8 طلبات كل دقيقة لكل زائر — كافي لأي ضيف حقيقي (رد واحد)
  // ويمنع سكربت من إغراق البريد بإشعارات وهمية.
  const rl = await checkRateLimit(() => getAdminDb(), event, "notify-rsvp", { max: 8, windowSeconds: 60 });
  if (!rl.allowed) {
    return { statusCode: 429, body: JSON.stringify({ sent: false, reason: "RATE_LIMITED" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { guestName, phone, status, guests, style, responseId } = payload;

  // تحقق أساسي من الحقول لمنع إساءة الاستخدام (رسائل فارغة/ضخمة/بأحرف
  // تحكم لمسار التحكم). هذي الدالة يستدعيها نموذج RSVP العلني بدون تسجيل دخول،
  // فلازم نتحكم بحجمها ومنع حقن HTML بإيميل العروسين.
  const cleanStr = (v, max) => {
    if (v == null) return "";
    return String(v).slice(0, max || 200);
  };
  const cleanGuestName = cleanStr(guestName, 120);
  const cleanPhone = cleanStr(phone, 30);
  const cleanStatus = ["yes", "no", "pending"].includes(status) ? status : "";
  const cleanGuests = cleanStr(guests, 10);
  const cleanStyle = cleanStr(style, 60);
  const cleanResponseId = cleanStr(responseId, 120);

  try {
    const { recipients, reportsCfg } = await resolveRecipients();

    // احترام إعداد "إرسال تقرير بعد كل رد" — معطّل بالكود إذا حُدِّد صراحةً "off"
    if (reportsCfg.on_each_response === "off") {
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "PER_RESPONSE_DISABLED" }) };
    }
    if (!recipients.length) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "NO_RECIPIENT_CONFIGURED" }) };
    }

    const statusText =
      status === "yes" ? "مؤكد الحضور ✓" :
      status === "no" ? "معتذر ✗" :
      "لم يرد";

    const subject = `رد جديد: ${cleanGuestName || "ضيف"} — ${statusText}`;
    const textBody = [
      "ورد رد جديد على دعوة جمرة غضى:",
      "",
      `الاسم: ${cleanGuestName || "—"}`,
      `الحالة: ${statusText}`,
      `الهاتف: ${cleanPhone || "—"}`,
      `عدد الضيوف: ${cleanGuests || "—"}`,
      `القالب: ${cleanStyle || "—"}`,
      cleanResponseId ? `معرّف الرد: ${cleanResponseId}` : "",
      "",
      `الوقت: ${new Date().toLocaleString("ar-SA")}`,
    ].filter(Boolean).join("\n");

    const htmlBody = `
      <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:480px;margin:0 auto;background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:24px;color:#eee">
        <h2 style="color:#d4af37;margin:0 0 16px">رد جديد على الدعوة</h2>
        <table style="width:100%;font-size:14px;line-height:1.8">
          <tr><td style="color:#999;width:100px">الاسم</td><td style="color:#fff">${escapeHtml(cleanGuestName || "—")}</td></tr>
          <tr><td style="color:#999">الحالة</td><td><span style="font-weight:bold;color:${cleanStatus === "yes" ? "#4caf50" : cleanStatus === "no" ? "#e07a5f" : "#aaa"}">${statusText}</span></td></tr>
          <tr><td style="color:#999">الهاتف</td><td dir="ltr" style="text-align:right">${escapeHtml(cleanPhone || "—")}</td></tr>
          <tr><td style="color:#999">عدد الضيوف</td><td>${escapeHtml(cleanGuests || "—")}</td></tr>
          <tr><td style="color:#999">القالب</td><td>${escapeHtml(cleanStyle || "—")}</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:20px">${new Date().toLocaleString("ar-SA")}</p>
      </div>`;

    const result = await sendReportEmail({ to: recipients, subject, text: textBody, html: htmlBody });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: String(err) }) };
  }
};
