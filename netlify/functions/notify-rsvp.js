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

const { resolveRecipients, sendReportEmail, escapeHtml } = require("./_report-lib");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { guestName, phone, status, guests, style, responseId } = payload;

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

    const subject = `رد جديد: ${guestName || "ضيف"} — ${statusText}`;
    const textBody = [
      "ورد رد جديد على دعوة جمرة غضى:",
      "",
      `الاسم: ${guestName || "—"}`,
      `الحالة: ${statusText}`,
      `الهاتف: ${phone || "—"}`,
      `عدد الضيوف: ${guests || "—"}`,
      `القالب: ${style || "—"}`,
      responseId ? `معرّف الرد: ${responseId}` : "",
      "",
      `الوقت: ${new Date().toLocaleString("ar-SA")}`,
    ].filter(Boolean).join("\n");

    const htmlBody = `
      <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:480px;margin:0 auto;background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:24px;color:#eee">
        <h2 style="color:#d4af37;margin:0 0 16px">رد جديد على الدعوة</h2>
        <table style="width:100%;font-size:14px;line-height:1.8">
          <tr><td style="color:#999;width:100px">الاسم</td><td style="color:#fff">${escapeHtml(guestName || "—")}</td></tr>
          <tr><td style="color:#999">الحالة</td><td><span style="font-weight:bold;color:${status === "yes" ? "#4caf50" : status === "no" ? "#e07a5f" : "#aaa"}">${statusText}</span></td></tr>
          <tr><td style="color:#999">الهاتف</td><td dir="ltr" style="text-align:right">${escapeHtml(phone || "—")}</td></tr>
          <tr><td style="color:#999">عدد الضيوف</td><td>${escapeHtml(String(guests || "—"))}</td></tr>
          <tr><td style="color:#999">القالب</td><td>${escapeHtml(style || "—")}</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:20px">${new Date().toLocaleString("ar-SA")}</p>
      </div>`;

    const result = await sendReportEmail({ to: recipients, subject, text: textBody, html: htmlBody });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: String(err) }) };
  }
};
