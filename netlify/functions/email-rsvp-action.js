const crypto = require("crypto");
const admin = require("firebase-admin");
const { getAdminDb } = require("./_report-lib");
const { sendReportEmail } = require("./_report-lib");

function sign(payload) {
  const secret = process.env.EMAIL_RSVP_SECRET || process.env.CRON_SECRET || "";
  if (!secret) throw new Error("EMAIL_RSVP_SECRET not configured");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(token) {
  const secret = process.env.EMAIL_RSVP_SECRET || process.env.CRON_SECRET || "";
  if (!secret || !token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p.exp || Date.now() > p.exp) return null;
  return p;
}
function qrUrl(eventId, entryCode) {
  return `https://quickchart.io/qr?size=600&margin=2&text=${encodeURIComponent(JSON.stringify({eventId:String(eventId||""),entryCode:String(entryCode||"")}))}`;
}
function htmlPage(title, text) {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Tahoma,Arial;background:#111;color:#fff;padding:40px;text-align:center"><div style="max-width:520px;margin:auto;background:#1c1c1c;border:1px solid #333;border-radius:18px;padding:30px"><h2 style="color:#d4af37">${title}</h2><p style="line-height:2">${text}</p></div></body></html>`;
}
exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode:405, body:"Method Not Allowed" };
  const q = event.queryStringParameters || {};
  const p = verify(q.token);
  if (!p || !p.guestId || !["yes","no"].includes(p.status)) return { statusCode:400, body:htmlPage("الرابط غير صالح","انتهت صلاحية رابط التأكيد أو أنه غير صحيح.") };
  const db = getAdminDb();
  const ref = db.collection("responses").doc(String(p.guestId));
  const snap = await ref.get();
  if (!snap.exists) return { statusCode:404, body:htmlPage("لم نجد الدعوة","تعذر العثور على بيانات المدعو.") };
  const guest = snap.data();
  if (String(guest.email || "").toLowerCase() !== String(p.email || "").toLowerCase()) return { statusCode:403, body:htmlPage("غير مصرح","هذا الرابط ليس لهذا البريد.") };
  await ref.update({ status:p.status, updatedAt:admin.firestore.FieldValue.serverTimestamp() });
  if (p.status === "yes" && guest.entryCode) {
    const qr = qrUrl(p.eventId || guest.eventCode, guest.entryCode);
    await sendReportEmail({
      to:[guest.email],
      subject:"بطاقة دخولك الشخصية 🤍",
      text:"تم تأكيد حضورك. هذه بطاقة الدخول الشخصية الخاصة بك.",
      html:`<div dir="rtl" style="font-family:Tahoma,Arial;text-align:center;padding:24px"><h2>تم تأكيد حضورك 🤍</h2><p>هذه بطاقة الدخول الشخصية الخاصة بك.</p><img src="${qr}" alt="QR" style="width:320px;max-width:90%;display:block;margin:20px auto"><p>احتفظ بها لإبرازها عند الدخول.</p></div>`
    });
  }
  return { statusCode:200, headers:{"Content-Type":"text/html; charset=utf-8"}, body:htmlPage(p.status==="yes"?"تم تأكيد حضورك 🤍":"تم تسجيل اعتذارك 🤍", p.status==="yes"?"تم إرسال بطاقة QR الشخصية إلى بريدك الإلكتروني.":"شكرًا لإبلاغنا.") };
};
