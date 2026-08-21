// netlify/functions/send-report-now.js
//
// يُستدعى من زر "إرسال التقرير الآن" بلوحة التحكم (dashboard/notifications.html).
// يولّد تقرير Excel وPDF فوري بأحدث بيانات الردود، ويرسله للمستلمين
// المحددين بإعدادات لوحة التحكم (content/settings.json → reports)،
// بصرف النظر عن جدولة الإرسال التلقائي.
//
// ⚠️ يتطلب تسجيل دخول إداري: يقرأ Authorization: Bearer <Firebase ID Token> ويتحقق
// منه بصلاحية إدارية، عشان محد يقدر يستخدم هذا الرابط لاستنزاف حصة الإيميل
// أو استراق بيانات المدعوين.

const { resolveRecipients, fetchResponses, buildExcelBuffer, buildPdfBuffer, sendReportEmail } = require("./_report-lib");
const { requireAdmin, getAdminApp } = require("./_auth");
const { checkRateLimit } = require("./_rate-limit");

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

  // Rate limiting: 3 requests per 300 seconds
  const getDb = () => { const a = getAdminApp(); return a ? a.firestore() : null; };
  const rl = await checkRateLimit(getDb, event, "send-report-now", { max: 3, windowSeconds: 300 });
  if (!rl.allowed) {
    return { statusCode: 429, headers: cors, body: JSON.stringify({ error: "طلبات كثيرة — حاولي بعد دقائق" }) };
  }

  // eventId اختياري يوصل من زر "إرسال التقرير الآن" — إذا مُرسل، التقرير
  // يقتصر على مناسبة واحدة بس (بدل خلط كل المناسبات ببعض بتقرير واحد،
  // وهي كانت المشكلة الأصلية).
  let eventId = null, eventName = "";
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    eventId = body.eventId || null;
    eventName = (body.eventName || "").trim();
  } catch { /* body فاضي أو غير صالح — نكمل بدون تحديد مناسبة */ }

  try {
    const { recipients } = await resolveRecipients();
    if (!recipients.length) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: false, reason: "NO_RECIPIENT_CONFIGURED" }) };
    }

    const { rows, total, yes, no, pending } = await fetchResponses(eventId);
    const dateStr = new Date().toLocaleDateString("ar-SA-u-nu-latn");
    const label = eventName ? `تقرير — ${eventName}` : "تقرير فوري (كل المناسبات)";
    const subject = `${label} — ${dateStr} (${total} مدعو)`;

    const [excelBuf, pdfBuf] = await Promise.all([
      buildExcelBuffer(rows),
      buildPdfBuffer(rows, { total, yes, no, pending }, `${label} — ${dateStr}`),
    ]);

    const result = await sendReportEmail({
      to: recipients,
      subject,
      text: `${label} بطلب من لوحة التحكم — ${dateStr}\nإجمالي: ${total} | مؤكد: ${yes} | معتذر: ${no} | لم يرد: ${pending}`,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif">${label} بطلب من لوحة التحكم — ${dateStr}<br>الملفات مرفقة بصيغتي Excel وPDF.</div>`,
      attachments: [
        { filename: `${eventName ? "تقرير-" + eventName : "تقرير-فوري"}-${dateStr}.xlsx`, content: excelBuf },
        { filename: `${eventName ? "تقرير-" + eventName : "تقرير-فوري"}-${dateStr}.pdf`, content: pdfBuf },
      ],
    });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ...result, total, yes, no, pending, eventId, eventName }) };
  } catch (err) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: false, error: err && err.message ? err.message : "error" }) };
  }
};
