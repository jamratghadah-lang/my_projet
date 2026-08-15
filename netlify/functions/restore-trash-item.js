// netlify/functions/restore-trash-item.js
//
// يستعيد عنصر واحد من سلة المحذوفات (trash_items) إلى مجموعته الأصلية.
// لازم يمر عبر هذه الدالة (Admin SDK) لأن بيانات العنصر الأصلي قد تحتوي
// حقول مختلفة حسب المجموعة (responses، events...)، فما يصير نحصرها بقاعدة
// Firestore عامة زي حصر حقول الإضافة اليدوية — الحل الآمن هو تفويض العملية
// لدالة خادم موثوقة بدل فتح صلاحية create واسعة على العميل.
//
// طلب: POST { trashItemId }
// رأس: Authorization: Bearer <Firebase ID Token> لأدمن/سوبر أدمن

const admin = require("firebase-admin");
const { requireAdmin } = require("./_auth");

// نفس القائمة البيضاء المستخدمة بدالة النسخ الاحتياطي — تمنع الكتابة
// لمجموعة عشوائية حتى لو تلاعب أحد بمحتوى originalCollection.
const RESTORE_ALLOWED_COLLECTIONS = new Set([
  "responses", "events", "couples", "guests", "settings",
  "send_logs", "operation_logs", "scheduled_messages",
  "templates", "guest_wall", "checkins", "ai_knowledge",
]);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function corsHeaders(event) {
  const origin = (event.headers && event.headers.origin) || "";
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  headers["Access-Control-Allow-Origin"] = (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) ? ALLOWED_ORIGIN : "null";
  return headers;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const adminUser = await requireAdmin(event);
  if (!adminUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "غير مصرّح — يلزم تسجيل دخول أدمن" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const trashItemId = String(body.trashItemId || "").trim();
  if (!trashItemId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "trashItemId مطلوب" }) };
  }

  try {
    const db = admin.firestore();
    const trashRef = db.collection("trash_items").doc(trashItemId);
    const trashSnap = await trashRef.get();
    if (!trashSnap.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "العنصر غير موجود بسلة المحذوفات" }) };
    }
    const item = trashSnap.data();
    const originalCollection = item.originalCollection;
    const originalId = item.originalId;

    if (!RESTORE_ALLOWED_COLLECTIONS.has(originalCollection)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "مجموعة غير مسموحة للاستعادة: " + originalCollection }) };
    }
    if (!originalId || !item.originalData) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "بيانات العنصر ناقصة — يتعذر الاستعادة" }) };
    }

    await db.collection(originalCollection).doc(originalId).set(item.originalData);
    await trashRef.delete();

    await db.collection("operation_logs").add({
      text: `استعادة من سلة المحذوفات: ${item.name || originalId}`,
      entity: item.itemType || "unknown", entityId: originalId,
      action: "restore", userName: adminUser.email || adminUser.uid,
      userId: adminUser.uid, time: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, restoredId: originalId, collection: originalCollection }) };
  } catch (err) {
    console.error("restore-trash-item error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "فشلت الاستعادة — حاولي مرة أخرى" }) };
  }
};
