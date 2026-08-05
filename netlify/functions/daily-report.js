// netlify/functions/daily-report.js
//
// دالة مجدولة تعمل مرة كل يوم (تلقائيًا عبر Netlify Scheduled Functions).
// تقرأ جميع ردود المدعوين من Firestore، تحسب الإحصائيات، وترسل تقريرًا
// ملخصًا يوميًا بالبريد إلى صاحبة المناسبة.
//
// متغيرات البيئة المطلوبة:
//   NOTIFY_EMAIL_TO, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//
// الجدولة في netlify.toml:
//   [functions."daily-report"]
//     schedule = "0 8 * * *"   ← 8 صباحًا كل يوم (بتوقيت UTC)

const FIREBASE_API_KEY = "AIzaSyAAYOne0CTht9906nStecbqCHkb_CY6glw";
const PROJECT_ID = "jamrat-ghadah";

exports.handler = async () => {
  const to = process.env.NOTIFY_EMAIL_TO;
  const smtpHost = process.env.SMTP_HOST;

  if (!to || !smtpHost) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "SMTP_NOT_CONFIGURED" }) };
  }

  try {
    // اقرأ جميع الردود من Firestore عبر REST API
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/responses?key=${FIREBASE_API_KEY}&pageSize=500`;
    const res = await fetch(url);
    if (!res.ok) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, error: "FIRESTORE_READ_FAILED" }) };
    }
    const data = await res.json();
    const docs = data.documents || [];

    let total = 0, yes = 0, no = 0, pending = 0;
    const recent = [];

    for (const doc of docs) {
      total++;
      const f = doc.fields || {};
      const name = f.name?.stringValue || "ضيف";
      const phone = f.phone?.stringValue || "—";
      const status = f.status?.stringValue || "";
      const guests = f.guests?.stringValue || "—";
      const style = f.style?.stringValue || "—";

      let s;
      if (status === "yes") { yes++; s = "مؤكد"; }
      else if (status === "no") { no++; s = "معتذر"; }
      else { pending++; s = "لم يرد"; }

      recent.push({ name, phone, s, guests, style });
    }

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
      "أحدث الردود:",
      ...recent.slice(0, 10).map((r, i) => `${i + 1}. ${r.name} — ${r.s} — ${r.phone} — ${r.guests} ضيوف`),
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
        <h3 style="color:#d4af37;font-size:14px">أحدث 10 ردود:</h3>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr style="border-bottom:2px solid #333">
            <th style="text-align:right;padding:6px;color:#999">#</th>
            <th style="text-align:right;padding:6px;color:#999">الاسم</th>
            <th style="text-align:right;padding:6px;color:#999">الحالة</th>
            <th style="text-align:right;padding:6px;color:#999">الهاتف</th>
            <th style="text-align:right;padding:6px;color:#999">الضيوف</th>
          </tr></thead>
          <tbody>
            ${recent.slice(0, 10).map((r, i) => `<tr style="border-bottom:1px solid #2a2a2a">
              <td style="padding:6px">${i + 1}</td>
              <td style="padding:6px">${escapeHtml(r.name)}</td>
              <td style="padding:6px">${r.s}</td>
              <td dir="ltr" style="padding:6px;text-align:right">${escapeHtml(r.phone)}</td>
              <td style="padding:6px">${escapeHtml(r.guests)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: parseInt(process.env.SMTP_PORT || "587", 10) === 465,
      auth: { user: process.env.SMTP_USER || "", pass: process.env.SMTP_PASS || "" },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
      to,
      subject,
      text: textBody,
      html: htmlBody,
    });

    return { statusCode: 200, body: JSON.stringify({ sent: true, total, yes, no, pending }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: String(err) }) };
  }
};

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
