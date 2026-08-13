// netlify/functions/_auth.js
//
// مساعد مصادقة مشترك بين دوال Netlify التي تتطلب صلاحية إدارية.
// يتحقق من Firebase ID Token المُرسل بترويسة Authorization: Bearer <token>
// ويرجع uid المستخدم، أو null لو كان التوكن غير صالح/غائب.
//
// الهدف: منع أي شخص خارج لوحة التحكم من استدعاء دوال الإرسال الجماعي
// (send-whatsapp / send-sms / send-report-now / send-bulk) وإساءة استخدامها.

let _adminApp = null;
function getAdminApp() {
  if (_adminApp) return _adminApp;
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    try {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    } catch {
      return null;
    }
  }
  _adminApp = admin;
  return admin;
}

async function verifyAuth(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const admin = getAdminApp();
    if (!admin) return null;
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid || null;
  } catch {
    return null;
  }
}

// مقارنة كلمات سر بزمن ثابت لمنع هجمات التوقيت (timing attacks)
// تُستخدم بدل `===` عند مقارنة كلمة السر المُدخَلة بالقيمة المخزّنة
function safeEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  const crypto = require("crypto");
  try {
    return crypto.timingSafeEqual(Buffer.from(sa), Buffer.from(sb));
  } catch {
    return false;
  }
}

module.exports = { verifyAuth, safeEqual, getAdminApp };
