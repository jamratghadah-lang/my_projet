// netlify/functions/send-sms.js
// إرسال SMS جماعي للضيوف. يقرأ بيانات الاتصال بالمزوّد من متغيرات البيئة في Netlify
// (Site settings → Environment variables) — لا يوجد أي مفتاح مكتوب هنا في الكود.
//
// اختاري مزوّد واحد وحطي متغيراته في Netlify، والباقي سيبيه فاضي:
//
// Msegat:
//   SMS_PROVIDER = msegat
//   MSEGAT_USERNAME
//   MSEGAT_API_KEY
//   MSEGAT_SENDER_NAME
//
// Unifonic:
//   SMS_PROVIDER = unifonic
//   UNIFONIC_APP_SID
//   UNIFONIC_SENDER_ID
//
// Twilio:
//   SMS_PROVIDER = twilio
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER

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

  const { guests, message } = payload;
  // guests: [{ name, phone }]  — phone بصيغة دولية مثل 9665xxxxxxxx
  if (!Array.isArray(guests) || !guests.length || !message) {
    return { statusCode: 400, body: "guests[] و message مطلوبين" };
  }

  const provider = process.env.SMS_PROVIDER; // "msegat" | "unifonic" | "twilio"
  if (!provider) {
    return {
      statusCode: 501,
      body: JSON.stringify({
        error: "لم يتم اختيار مزوّد SMS بعد. أضيفي SMS_PROVIDER ومتغيرات المزوّد في Netlify Environment Variables.",
      }),
    };
  }

  const results = [];

  for (const guest of guests) {
    const personalizedMessage = message.replace(/\{name\}/g, guest.name || "");
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
            numbers: guest.phone,
            msg: personalizedMessage,
          }),
        });
      } else if (provider === "unifonic") {
        res = await fetch("https://basic.unifonic.com/rest/SMS/messages", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            AppSid: process.env.UNIFONIC_APP_SID || "",
            SenderID: process.env.UNIFONIC_SENDER_ID || "",
            Body: personalizedMessage,
            Recipient: guest.phone,
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
            To: guest.phone,
            Body: personalizedMessage,
          }),
        });
      } else {
        results.push({ phone: guest.phone, ok: false, error: "مزوّد غير معروف" });
        continue;
      }
      results.push({ phone: guest.phone, ok: res.ok, status: res.status });
    } catch (err) {
      results.push({ phone: guest.phone, ok: false, error: String(err) });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ sent: results.length, results }),
  };
};
