// netlify/functions/event-reminder.js
//
// دالة مجدولة تعمل كل ساعة. تفحص جميع روابط الدعوات (مجموعة couples في Firestore)
// وتقرأ تاريخ كل قالب من ملفات content/rsvp/<slug>.json. لو المناسبة بعد 24 ساعة
// (±1 ساعة):
//   1) تُرسل تذكيرًا SMS تلقائيًا لكل الضيوف المؤكدين (لو مزوّد SMS مُعدّ).
//   2) تُرسل تقرير إيميل (Excel+PDF) لصاحبة المناسبة/المدير حسب إعدادات
//      لوحة التحكم (content/settings.json → reports.before_event).
//
// الجدولة في netlify.toml:
//   [functions."event-reminder"]
//     schedule = "0 * * * *"   ← كل ساعة

const { resolveRecipients, fetchResponses, buildExcelBuffer, buildPdfBuffer, sendReportEmail, getAdminDb } = require("./_report-lib");
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

  const provider = process.env.SMS_PROVIDER;

  try {
    // 1) اقرأ جميع روابط الدعوات (مجموعة "couples") عبر Admin SDK — القاعدة
    // الآن read: if isAdmin() (تشددت بعد أن كانت عامة)، فلازم تُقرأ بصلاحية
    // إدارية عبر خدمة السيرفر، مثل "responses" بالضبط تحتها.
    const couplesSnap = await getAdminDb().collection("couples").get();
    const couples = couplesSnap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));

    // مجموعة "events" (المناسبات الحقيقية) — نحتاجها هنا فقط عشان نقرأ
    // reportEmail (بريد العميلة الخاص بهذي المناسبة تحديدًا، لو معبّى من
    // dashboard/events.html) ونستخدمه بدل الإعداد العام لمن يستلم تقرير
    // الـ٢٤-ساعة.
    const eventsSnap = await getAdminDb().collection("events").get();
    const eventsById = new Map();
    eventsSnap.forEach((d) => eventsById.set(d.id, d.data() || {}));

    // 2) اقرأ جميع الردود — تحتاج صلاحية إدارية لأن قواعد الأمان تشترط
    // تسجيل دخول لقراءة "responses"
    const responsesSnap = await getAdminDb().collection("responses").get();
    const responseDocs = [];
    responsesSnap.forEach((doc) => responseDocs.push(doc.data()));

    // 3) لكل رابط، اقرأ تاريخ القالب من content/rsvp/<template>.json
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // ±1 ساعة
    const TARGET_MS = 24 * 60 * 60 * 1000; // 24 ساعة

    let totalSmsSent = 0;
    let emailReportSent = false;
    const eventsInWindow = [];
    const eventHost = process.env.URL || process.env.DEPLOY_URL || "https://jamratghadah.com";

    for (const couple of couples) {
      const slug = couple.id;
      const template = couple.data.template;
      if (!template) continue;

      let jsonDate = null;
      try {
        const jsonRes = await fetch(`${eventHost}/content/rsvp/${encodeURIComponent(template)}.json`);
        if (jsonRes.ok) {
          const json = await jsonRes.json();
          jsonDate = json.date || null;
        }
      } catch { continue; }
      if (!jsonDate) continue;

      const m = String(jsonDate).match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
      if (!m) continue;
      const eventDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 18, 0, 0);
      if (isNaN(eventDate.getTime())) continue;

      const diff = eventDate.getTime() - now;
      if (Math.abs(diff - TARGET_MS) > WINDOW_MS) continue;

      // نفس منطق video-scheduler.js: لو الرابط مربوط بمعرّف مناسبة حقيقي
      // (couples/{slug}.eventCode) نفلتر بيه حصرًا، وإلا نرجع للطريقة
      // القديمة بمطابقة الثيم (style) للروابط القديمة غير المربوطة بعد.
      const coupleEventCode = couple.data.eventCode || "";
      const eventReportEmail = coupleEventCode ? (eventsById.get(coupleEventCode)?.reportEmail || "") : "";
      eventsInWindow.push({ slug, template, jsonDate, eventCode: coupleEventCode, reportEmail: eventReportEmail });

      if (provider) {
        const guests = [];
        for (const f of responseDocs) {
          const status = f.status || "";
          if (coupleEventCode) {
            if ((f.eventCode || "") !== coupleEventCode) continue;
          } else {
            const docStyle = f.style || "";
            if (docStyle !== template && docStyle !== slug) continue;
          }
          if (status !== "yes") continue;
          const phone = f.phone || "";
          if (!phone) continue;
          const name = f.name || "ضيف";
          guests.push({ name, phone: normalizePhone(phone) });
        }

        if (guests.length) {
          const reminderText = `تذكير: مناسبتنا غدًا ${jsonDate} 🌸 نتشرف بحضوركم. — جمرة غضى`;
          for (const guest of guests) {
            try {
              await sendSMS(provider, guest.phone, reminderText.replace(/\{name\}/g, guest.name));
              totalSmsSent++;
            } catch { /* تجاهل الأخطاء الفردية */ }
          }
        }
      }
    }

    // 5) تقرير إيميل لصاحبة المناسبة/المدير قبل المناسبة بـ24 ساعة
    //
    // مهم: تقرير منفصل لكل مناسبة بحدودها الحقيقية (eventCode) — قبل كان
    // fetchResponses() تُستدعى بدون معرّف، فترجع ردود كل المناسبات على
    // الموقع مجتمعة بتقرير واحد، حتى لو مناسبة وحدة بس داخلة بنافذة الـ24
    // ساعة. الروابط القديمة غير المربوطة بعد بمعرّف مناسبة حقيقي (eventCode)
    // تكمل بنفس السلوك القديم (كل الردود) كتوافق رجعي مؤقت.
    //
    // المستلم: لو المناسبة عندها reportEmail خاص (events/{eventCode}.reportEmail
    // من dashboard/events.html)، يُرسل التقرير لبريدها هي حصرًا. وإلا يُرسل
    // للمستلمين العامين المعرَّفين بإعدادات الموقع (نفس السلوك القديم).
    let emailReportsSent = 0;
    if (eventsInWindow.length) {
      const { recipients: globalRecipients, reportsCfg } = await resolveRecipients();
      if (reportsCfg.before_event !== "off") {
        const dateStr = new Date().toLocaleDateString("ar-SA-u-nu-latn");

        for (const e of eventsInWindow) {
          const toRecipients = e.reportEmail ? [e.reportEmail] : globalRecipients;
          if (!toRecipients.length) continue; // ما فيه مين نرسل له هذي المناسبة، تخطّيها

          const { rows, total, yes, no, pending } = await fetchResponses(e.eventCode || undefined);
          const titleSuffix = e.eventCode ? `— ${e.slug}` : `— ${e.slug} (رابط غير مربوط بعد، الأرقام قد تشمل مناسبات أخرى بنفس القالب)`;

          const [excelBuf, pdfBuf] = await Promise.all([
            buildExcelBuffer(rows),
            buildPdfBuffer(rows, { total, yes, no, pending }, `تقرير ما قبل المناسبة بـ24 ساعة ${titleSuffix} — ${dateStr}`),
          ]);

          const result = await sendReportEmail({
            to: toRecipients,
            subject: `تذكير: مناسبتكم غدًا (${e.slug}) — تقرير آخر الردود`,
            text: `مناسبتكم بعد 24 ساعة تقريبًا (${e.jsonDate}):\n\nإجمالي: ${total} | مؤكد: ${yes} | معتذر: ${no} | لم يرد: ${pending}`,
            html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif">مناسبتكم بعد 24 ساعة تقريبًا 🌸<br><br>إجمالي: ${total} | مؤكد: ${yes} | معتذر: ${no} | لم يرد: ${pending}<br><br>الملفات مرفقة بصيغتي Excel وPDF.</div>`,
            attachments: [
              { filename: `تقرير-قبل-المناسبة-${e.slug}-${dateStr}.xlsx`, content: excelBuf },
              { filename: `تقرير-قبل-المناسبة-${e.slug}-${dateStr}.pdf`, content: pdfBuf },
            ],
          });
          if (result.sent) emailReportsSent++;
        }
        emailReportSent = emailReportsSent > 0;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true, totalSmsSent, emailReportSent, emailReportsSent, eventsInWindow: eventsInWindow.length }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: 'error' }) };
  }
};

function normalizePhone(p) {
  let clean = String(p).replace(/[^\d+]/g, "");
  if (clean.startsWith("0")) clean = "966" + clean.slice(1);
  if (clean.startsWith("+")) clean = clean.slice(1);
  return clean;
}

async function sendSMS(provider, phone, message) {
  if (provider === "msegat") {
    const res = await fetch("https://www.msegat.com/gw/sendsms.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userName: process.env.MSEGAT_USERNAME || "",
        apiKey: process.env.MSEGAT_API_KEY || "",
        userSender: process.env.MSEGAT_SENDER_NAME || "",
        numbers: phone,
        msg: message,
      }),
    });
    return res.ok;
  } else if (provider === "unifonic") {
    const res = await fetch("https://basic.unifonic.com/rest/SMS/messages", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        AppSid: process.env.UNIFONIC_APP_SID || "",
        SenderID: process.env.UNIFONIC_SENDER_ID || "",
        Body: message,
        Recipient: phone,
      }),
    });
    return res.ok;
  } else if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID || "";
    const token = process.env.TWILIO_AUTH_TOKEN || "";
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      },
      body: new URLSearchParams({
        From: process.env.TWILIO_FROM_NUMBER || "",
        To: phone,
        Body: message,
      }),
    });
    return res.ok;
  }
  return false;
}
