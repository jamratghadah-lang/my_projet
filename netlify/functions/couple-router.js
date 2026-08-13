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

// مفتاح Firebase API آمن للنشر (هو مفتاح عميل عام من الأساس، ليس سرّاً)، لكن
// نفضّل قراءته من متغيّر البيئة لو ضُبط، لتفادي تكراره بمصادر متعددة.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyAAYOne0CTht9906nStecbqCHkb_CY6glw";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "jamrat-ghadah";

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
    const params = new URLSearchParams(event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString());
    const eventCode = params.get("eid") || "";
    const guestCode = params.get("g") || "";
    // هروب كامل للقيم قبل حقنها بسمات HTML لمنع XSS حتى لو افترضنا تلاعب
    // بمحتوىFirestore. نوفر هنا هروب &, <, >, ", ' كاملة.
    const escAttr = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    const attrs = ` data-couple-slug="${escAttr(slug)}" data-event-code="${escAttr(eventCode)}" data-guest-code="${escAttr(guestCode)}"`;
    const htmlWithCoupleSlug = html.includes("<body")
      ? html.replace(/<body(\s|>)/, `<body${attrs}$1`)
      : html;
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: htmlWithCoupleSlug };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: notFoundPage(),
    };
  }
};
