// netlify/functions/checkin.js
//
// يُستدعى من تطبيق الاستقبال (jamrat-app) يوم المناسبة لمسح كود الدخول
// وتسجيل حضور الضيف.
//
// آلية العمل:
// 1) التطبيق يرسل: entryCode (مثال: JG-4F7B2K9A) + checkinPassword
// 2) الدالة تتأكد من كلمة السر مقابل CHECKIN_PASSWORD من متغيرات البيئة
// 3) تدور في مجموعة responses بـ Firestore عن وثيقة فيها نفس entryCode
// 4) تسجل check-in جديد في مجموعة checkins
// 5) ترجع بيانات الضيف (الاسم، عدد المرافقين، الحالة)
//
// متغيرات البيئة المطلوبة في Netlify:
//   CHECKIN_PASSWORD       — كلمة سر تسجيل الدخول (يملأها المدير من لوحة التحكم)
//   FIREBASE_SERVICE_ACCOUNT_JSON — مفتاح خدمة Firebase (موجود مسبقاً)

const { getAdminDb, escapeHtml } = require("./_report-lib");
const { safeEqual } = require("./_auth");
const { checkRateLimit } = require("./_rate-limit");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // حماية إضافية من محاولات تخمين كلمة سر Check-in (brute force)
  const rl = await checkRateLimit(() => getAdminDb(), event, "checkin", { max: 20, windowSeconds: 60 });
  if (!rl.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: "too many requests" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { entryCode, checkinPassword } = payload;

  // ===== 1) التحقق من كلمة السر =====
  // ملاحظة: كلمة السر هنا تحمي تسجيل الدخول يوم المناسبة فقط (تطبيق الاستقبال)،
  // مو بديل عن مصادقة Firebase. نستخدم مقارنة بزمن ثابت لمنع هجمات التوقيت.
  const configuredPassword = process.env.CHECKIN_PASSWORD || "";
  if (!configuredPassword) {
    return { statusCode: 503, body: JSON.stringify({ error: "كلمة سر Check-in غير مضبوطة بعد — أضيفي CHECKIN_PASSWORD في إعدادات Netlify" }) };
  }
  if (!checkinPassword || !safeEqual(checkinPassword, configuredPassword)) {
    return { statusCode: 401, body: JSON.stringify({ error: "كلمة سر غير صحيحة" }) };
  }

  // ===== 2) التحقق من كود الدخول =====
  if (!entryCode || typeof entryCode !== "string" || !/^JG-[A-Z2-9]{8}$/i.test(entryCode)) {
    return { statusCode: 400, body: JSON.stringify({ error: "كود دخول غير صالح — الصيغة: JG-XXXXXXXX" }) };
  }

  try {
    const db = getAdminDb();

    // ===== 3) البحث عن الضيف بكود الدخول =====
    const responsesSnap = await db
      .collection("responses")
      .where("entryCode", "==", entryCode.toUpperCase())
      .limit(1)
      .get();

    if (responsesSnap.empty) {
      return { statusCode: 404, body: JSON.stringify({ error: "كود الدخول غير موجود" }) };
    }

    const guestDoc = responsesSnap.docs[0];
    const guestData = guestDoc.data();
    const responseId = guestDoc.id;
    if (guestData.qrRevoked === true) {
      return { statusCode: 403, body: JSON.stringify({ error: "رمز الدخول ملغى" }) };
    }

    // ===== 4) التحقق من عدم تسجيل الدخول مسبقاً =====
    const existingCheckin = await db
      .collection("checkins")
      .where("responseId", "==", responseId)
      .limit(1)
      .get();

    if (!existingCheckin.empty) {
      const prevData = existingCheckin.docs[0].data();
      return {
        statusCode: 200,
        body: JSON.stringify({
          alreadyCheckedIn: true,
          name: guestData.name || "—",
          guests: guestData.guests || 0,
          companions: guestData.companions || 0,
          table: guestData.table || "",
          seat: guestData.seat || "",
          gate: guestData.gate || "",
          checkedInAt: prevData.checkedInAt,
          message: "هذا الضيف سجّل دخوله مسبقاً",
        }),
      };
    }

    // ===== 5) تسجيل الدخول =====
    const checkinData = {
      responseId,
      entryCode: entryCode.toUpperCase(),
      name: guestData.name || "—",
      phone: guestData.phone || "—",
      guests: guestData.guests || 0,
      companions: guestData.companions || 0,
      table: guestData.table || "",
      seat: guestData.seat || "",
      gate: guestData.gate || "",
      style: guestData.style || "—",
      slug: guestData.slug || "—",
      checkedInAt: new Date().toISOString(),
      // Firestore Timestamp للترتيب
      _ts: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("checkins").add(checkinData);

    // ===== 6) تحديث حالة الحضور بالرد الأصلي =====
    await db.collection("responses").doc(responseId).update({
      checkedIn: true,
      checkedInAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        name: checkinData.name,
        guests: checkinData.guests,
        companions: checkinData.companions,
        table: checkinData.table,
        seat: checkinData.seat,
        gate: checkinData.gate,
        style: checkinData.style,
        checkedInAt: checkinData.checkedInAt,
        message: `مرحباً ${checkinData.name}! تم تسجيل الدخول بنجاح`,
      }),
    };
  } catch (err) {
    console.error("Check-in error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "خطأ داخلي — حاول مرة أخرى" }),
    };
  }
};
