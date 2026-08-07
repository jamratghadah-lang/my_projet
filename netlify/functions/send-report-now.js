// netlify/functions/send-report-now.js
//
// يُستدعى من زر "إرسال التقرير الآن" بلوحة التحكم (dashboard/notifications.html).
// يولّد تقرير Excel وPDF فوري بأحدث بيانات الردود، ويرسله للمستلمين
// المحددين بإعدادات لوحة التحكم (content/settings.json → reports)،
// بصرف النظر عن جدولة الإرسال التلقائي.

const { resolveRecipients, fetchResponses, buildExcelBuffer, buildPdfBuffer, sendReportEmail } = require("./_report-lib");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { recipients } = await resolveRecipients();
    if (!recipients.length) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "NO_RECIPIENT_CONFIGURED" }) };
    }

    const { rows, total, yes, no, pending } = await fetchResponses();
    const dateStr = new Date().toLocaleDateString("ar-SA");
    const subject = `تقرير فوري — ${dateStr} (${total} مدعو)`;

    const [excelBuf, pdfBuf] = await Promise.all([
      buildExcelBuffer(rows),
      buildPdfBuffer(rows, { total, yes, no, pending }, `تقرير فوري — ${dateStr}`),
    ]);

    const result = await sendReportEmail({
      to: recipients,
      subject,
      text: `تقرير فوري بطلب من لوحة التحكم — ${dateStr}\nإجمالي: ${total} | مؤكد: ${yes} | معتذر: ${no} | لم يرد: ${pending}`,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif">تقرير فوري بطلب من لوحة التحكم — ${dateStr}<br>الملفات مرفقة بصيغتي Excel وPDF.</div>`,
      attachments: [
        { filename: `تقرير-فوري-${dateStr}.xlsx`, content: excelBuf },
        { filename: `تقرير-فوري-${dateStr}.pdf`, content: pdfBuf },
      ],
    });

    return { statusCode: 200, body: JSON.stringify({ ...result, total, yes, no, pending, recipients }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: String(err) }) };
  }
};
