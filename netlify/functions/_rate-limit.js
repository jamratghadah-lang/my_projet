// netlify/functions/_rate-limit.js
//
// حماية بسيطة من إساءة استخدام الدوال العلنية (اللي تُستدعى بدون تسجيل
// دخول: notify-rsvp, notify-wall-message, checkin) عن طريق تحديد عدد
// الطلبات المسموحة لكل IP خلال نافذة زمنية معيّنة، باستخدام Firestore
// (نفس قاعدة البيانات المستخدمة بباقي الموقع، عبر صلاحية Admin).
//
// الاستخدام داخل أي دالة:
//   const { checkRateLimit } = require("./_rate-limit");
//   const rl = await checkRateLimit(() => getAdminDb(), event, "notify-rsvp", { max: 8, windowSeconds: 60 });
//   if (!rl.allowed) return { statusCode: 429, body: JSON.stringify({ error: "too many requests" }) };
//
// ملاحظة: هذا تحديد "أفضل جهد" (best-effort) — مو حماية DDoS كاملة، بس
// يمنع إساءة استخدام بسيطة (سكربت يرسل عشرات الطلبات بالثانية).
//
// قبل الإصلاح: كانت الدالة تستقبل `db` مباشرة، فلو فشل `getAdminDb()`
// (مثلاً متغيّر بيئة `FIREBASE_SERVICE_ACCOUNT_JSON` ناقص)، كان الخطأ
// يُلقى قبل ما يدخل `checkRateLimit` وما يصير يلتقطه try/catch. الحل:
// نستقبل `getDb` كـ function ونعالج أخطاءه داخلياً — لو فشل، نرفض الطلب
// (fail-closed) عشان نحمي الدوال الحساسة من إساءة الاستخدام.

function getClientIp(event) {
  const h = event.headers || {};
  const fwd = h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || "";
  return String(fwd).split(",")[0].trim() || "unknown";
}

async function checkRateLimit(getDb, event, bucketName, opts) {
  const max = (opts && opts.max) || 10;
  const windowSeconds = (opts && opts.windowSeconds) || 60;

  let db;
  try {
    db = typeof getDb === "function" ? getDb() : getDb;
    if (!db) throw new Error("db is null");
  } catch (e) {
    // Fail-closed: لو ما قدرنا نوصل لقاعدة البيانات، نرفض الطلب.
    return { allowed: false, count: 0, error: String(e) };
  }

  const ip = getClientIp(event);
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const docId = `${bucketName}_${ip}_${windowId}`.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
  const ref = db.collection("rate_limits").doc(docId);

  try {
    const admin = require("firebase-admin");
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= max) return { allowed: false, count };
      tx.set(ref, {
        count: count + 1,
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + windowSeconds * 1000),
      });
      return { allowed: true, count: count + 1 };
    });
    return result;
  } catch (e) {
    // Fail-closed: لو فشل الاتصال بقاعدة البيانات، نرفض الطلب.
    return { allowed: false, count: 0, error: String(e) };
  }
}

module.exports = { checkRateLimit, getClientIp };
