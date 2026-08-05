// netlify/functions/event-reminder.js
//
// دالة مجدولة تعمل كل ساعة. تفحص جميع روابط الدعوات (مجموعة couples في Firestore)
// وتقرأ تاريخ كل قالب من ملفات content/rsvp/<slug>.json. لو المناسبة بعد 24 ساعة
// (±1 ساعة)، تُرسل تذكيرًا تلقائيًا لكل الضيوف المؤكدين عبر مزوّد SMS المُعدّ.
//
// لو ما فيه مزوّد SMS مُعدّ، أو ما فيه تاريخ قريب، الدالة تنتهي بصمت.
//
// الجدولة في netlify.toml:
//   [functions."event-reminder"]
//     schedule = "0 * * * *"   ← كل ساعة

const FIREBASE_API_KEY = "AIzaSyAAYOne0CTht9906nStecbqCHkb_CY6glw";
const PROJECT_ID = "jamrat-ghadah";

exports.handler = async () => {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "SMS_NOT_CONFIGURED" }) };
  }

  try {
    // 1) اقرأ جميع روابط الدعوات
    const couplesUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/couples?key=${FIREBASE_API_KEY}&pageSize=500`;
    const couplesRes = await fetch(couplesUrl);
    if (!couplesRes.ok) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, error: "COUPLES_READ_FAILED" }) };
    }
    const couplesData = await couplesRes.json();
    const couples = couplesData.documents || [];

    // 2) اقرأ جميع الردود
    const responsesUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/responses?key=${FIREBASE_API_KEY}&pageSize=500`;
    const responsesRes = await fetch(responsesUrl);
    if (!responsesRes.ok) {
      return { statusCode: 200, body: JSON.stringify({ sent: false, error: "RESPONSES_READ_FAILED" }) };
    }
    const responsesData = await responsesRes.json();
    const responseDocs = responsesData.documents || [];

    // 3) لكل رابط، اقرأ تاريخ القالب من content/rsvp/<template>.json
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // ±1 ساعة
    const TARGET_MS = 24 * 60 * 60 * 1000; // 24 ساعة

    let totalSent = 0;
    const eventHost = process.env.URL || process.env.DEPLOY_URL || "https://jamratghadah.com";

    for (const couple of couples) {
      const slug = couple.name;
      const template = couple.fields?.template?.stringValue;
      if (!template) continue;

      // اقرأ ملف JSON للقالب للحصول على التاريخ
      let jsonDate = null;
      try {
        const jsonRes = await fetch(`${eventHost}/content/rsvp/${encodeURIComponent(template)}.json`);
        if (jsonRes.ok) {
          const json = await jsonRes.json();
          jsonDate = json.date || null;
        }
      } catch { continue; }
      if (!jsonDate) continue;

      // حلّل التاريخ (يدعم dd/mm/yyyy)
      const m = String(jsonDate).match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
      if (!m) continue;
      const eventDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 18, 0, 0);
      if (isNaN(eventDate.getTime())) continue;

      const diff = eventDate.getTime() - now;
      // لو المناسبة بعد 24 ساعة (±1 ساعة)
      if (Math.abs(diff - TARGET_MS) > WINDOW_MS) continue;

      // 4) جمّع الضيوف المؤكدين لهذا القالب
      const guests = [];
      for (const doc of responseDocs) {
        const f = doc.fields || {};
        const status = f.status?.stringValue || "";
        const docStyle = f.style?.stringValue || "";
        if (docStyle !== template && docStyle !== slug) continue;
        if (status !== "yes") continue;
        const phone = f.phone?.stringValue || "";
        if (!phone) continue;
        const name = f.name?.stringValue || "ضيف";
        guests.push({ name, phone: normalizePhone(phone) });
      }

      if (!guests.length) continue;

      // 5) أرسل التذكير لكل ضيف
      const reminderText = `تذكير: مناسبتنا غدًا ${jsonDate} 🌸 نتشرف بحضوركم. — جمرة غضى`;

      for (const guest of guests) {
        try {
          await sendSMS(provider, guest.phone, reminderText.replace(/\{name\}/g, guest.name));
          totalSent++;
        } catch { /* تجاهل الأخطاء الفردية */ }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true, totalSent }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: String(err) }) };
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
