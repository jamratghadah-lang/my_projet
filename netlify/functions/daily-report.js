// netlify/functions/daily-report.js
//
// دالة مجدولة تعمل مرة كل يوم (تلقائيًا عبر Netlify Scheduled Functions).
// تقرأ جميع ردود المدعوين من Firestore، تحسب الإحصائيات، وترسل تقريرًا
// يوميًا بالبريد (مع مرفقات Excel وPDF حقيقية) لصاحبة المناسبة و/أو المدير
// حسب إعدادات لوحة التحكم (content/settings.json → reports).
//
// متغيرات البيئة المطلوبة:
//   NOTIFY_EMAIL_TO (بريد المدير الافتراضي), SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   CRON_SECRET — سر لتوثيق النداءات غير المجدولة
//
// الجدولة في netlify.toml:
//   [functions."daily-report"]
//     schedule = "0 8 * * *"   ← 8 صباحًا كل يوم (بتوقيت UTC)

const { resolveRecipients, fetchResponses, buildExcelBuffer, buildPdfBuffer, sendReportEmail } = require("./_report-lib");
const { safeEqual } = require("./_auth");

function verifyCronSecret(event) {
  if (event.httpMethod === 'SCHEDULED') return true;
  const provided = event.headers['x-cron-secret'] || '';
  const expected = process.env.CRON_SECRET || '';
  if (!expected || !safeEqual(provided, expected)) return false;
  return true;
}

exports.handler = async (event) => {
  if (!verifyCronSecret(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const { recipients, reportsCfg } = await resolveRecipients();

    // احترام إعداد "إرسال تقرير يومي" من لوحة التحكم (مفعّل افتراضيًا)
    if (reportsCfg.daily === "off") {
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "DAILY_REPORT_DISABLED" }) };
    }
    if (!recipients.length) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "NO_RECIPIENT_CONFIGURED" }) };
    }

    const { rows, total, yes, no, pending } = await fetchResponses();
    const dateStr = new Date().toLocaleDateString("ar-SA");
    const subject = `التقرير اليومي — ${dateStr} (${total} مدعو)`;

    const textBody = [
      `التقرير اليومي لردود المدعوين — ${dateStr}`,
      "",
      `إجمالي الردود: ${total}`,
      `مؤكد الحضور: ${yes}`,
      `معتذر: ${no}`,
      `لم يرد: ${pending}`,
      "",
      "التقرير الكامل مرفق بصيغتي Excel وPDF.",
    ].join("\n");

    const htmlBody = `
      <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:0 auto;background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:24px;color:#eee">
        <h2 style="color:#d4af37;margin:0 0 16px">التقرير اليومي — ${dateStr}</h2>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
          <div style="flex:1;min-width:100px;background:#222;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:28px;font-weight:bold;color:#d4af37">${total}</div>
            <div style="font-size:11px;color:#999">إجمالي</div>
          </div>
          <div style="flex:1;min-width:100px;background:#222;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:28px;font-weight:bold;color:#4caf50">${yes}</div>
            <div style="font-size:11px;color:#999">مؤكد</div>
          </div>
          <div style="flex:1;min-width:100px;background:#222;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:28px;font-weight:bold;color:#e07a5f">${no}</div>
            <div style="font-size:11px;color:#999">معتذر</div>
          </div>
          <div style="flex:1;min-width:100px;background:#222;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:28px;font-weight:bold;color:#aaa">${pending}</div>
            <div style="font-size:11px;color:#999">لم يرد</div>
          </div>
        </div>
        <p style="color:#999;font-size:13px">التقرير الكامل مرفق بصيغتي Excel وPDF مع هذا الإيميل.</p>
      </div>`;

    const [excelBuf, pdfBuf] = await Promise.all([
      buildExcelBuffer(rows),
      buildPdfBuffer(rows, { total, yes, no, pending }, `التقرير اليومي — ${dateStr}`),
    ]);

    const result = await sendReportEmail({
      to: recipients,
      subject,
      text: textBody,
      html: htmlBody,
      attachments: [
        { filename: `تقرير-يومي-${dateStr}.xlsx`, content: excelBuf },
        { filename: `تقرير-يومي-${dateStr}.pdf`, content: pdfBuf },
      ],
    });

    return { statusCode: 200, body: JSON.stringify({ ...result, total, yes, no, pending }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: 'error' }) };
  }
};
