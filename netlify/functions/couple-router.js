// netlify/functions/couple-router.js
//
// يخلي رابط الدعوة يطلع باسم العروسين بدل اسم القالب:
//   jamratghadah.com/sara-ahmed   بدل   jamratghadah.com/rsvp/wedding-gold.html
//
// آلية العمل:
// 1) ملف _redirects يوجّه أي رابط من مقطع واحد (مو ملف موجود فعلاً بالموقع) لهذي الدالة.
// 2) الدالة تدور بقاعدة بيانات Firestore (مجموعة couples) عن وثيقة بنفس اسم المقطع (الـ slug).
// 3) لو لقتها، تجيب محتوى صفحة القالب الحقيقية (rsvp/<template>.html) وترجعها كما هي —
//    فيبقى الرابط بالمتصفح jamratghadah.com/sara-ahmed بدون ما يتغيّر لاسم القالب.
// 4) لو ما لقت شي، ترجع صفحة "الرابط غير موجود".
//
// إدارة الروابط (إضافة/حذف) تصير من dashboard/couples.html

const FIREBASE_API_KEY = "AIzaSyAAYOne0CTht9906nStecbqCHkb_CY6glw";
const PROJECT_ID = "jamrat-ghadah";

function notFoundPage() {
  return (
    "<!DOCTYPE html><html lang='ar' dir='rtl'><head><meta charset='UTF-8'>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1.0'>" +
    "<meta name='robots' content='noindex, nofollow'><title>الرابط غير موجود</title>" +
    "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:#171310;color:#f6ecda;font-family:Tahoma,Arial,sans-serif;text-align:center;padding:30px}" +
    "h1{color:#D9B565;font-size:1.4rem}p{color:#cbbfa8;max-width:360px;margin:10px auto 0;line-height:1.8}</style>" +
    "</head><body><div><h1>🔍 هذا الرابط غير موجود</h1>" +
    "<p>تأكدي من نسخ رابط الدعوة كامل زي ما وصلك، أو تواصلي مع صاحبة المناسبة.</p></div></body></html>"
  );
}

exports.handler = async (event) => {
  const slug = decodeURIComponent((event.path || "").replace(/^\/+/, "").split("/")[0] || "");
  if (!slug) {
    return { statusCode: 404, headers: { "Content-Type": "text/html; charset=utf-8" }, body: notFoundPage() };
  }

  try {
    const docUrl =
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/couples/${encodeURIComponent(slug)}` +
      `?key=${FIREBASE_API_KEY}`;
    const docRes = await fetch(docUrl);
    if (!docRes.ok) {
      return { statusCode: 404, headers: { "Content-Type": "text/html; charset=utf-8" }, body: notFoundPage() };
    }
    const docData = await docRes.json();
    const template = docData.fields && docData.fields.template && docData.fields.template.stringValue;
    if (!template) {
      return { statusCode: 404, headers: { "Content-Type": "text/html; charset=utf-8" }, body: notFoundPage() };
    }

    const host = event.headers["x-forwarded-host"] || event.headers.host;
    const proto = event.headers["x-forwarded-proto"] || "https";
    const pageRes = await fetch(`${proto}://${host}/rsvp/${encodeURIComponent(template)}.html`);
    if (!pageRes.ok) {
      return { statusCode: 404, headers: { "Content-Type": "text/html; charset=utf-8" }, body: notFoundPage() };
    }
    const html = await pageRes.text();
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: notFoundPage(),
    };
  }
};
