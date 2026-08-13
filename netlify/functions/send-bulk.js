// netlify/functions/send-bulk.js
//
// إرسال جماعي حقيقي لمجموعة ضيوف مختارين من لوحة التحكم (dashboard/guests.html)،
// مع اختيار القناة: واتساب فقط / إيميل فقط / الاثنين معًا.
// + دعم إرفاق فيديو و/أو صورة (بطاقة) مع النص، أو أي مزيج بينهم — وليس نص فقط.
//
// ⚠️ يتطلب تسجيل دخول: يقرأ Authorization: Bearer <Firebase ID Token> ويتحقق
// منه بصلاحية إدارية، عشان محد يقدر يستخدم هذا الرابط للإرسال العشوائي.
//
// متغيرات البيئة المطلوبة (نفسها المستخدمة بدوال ثانية بهذا المشروع):
//   WHATSAPP_PHONE_ID, WHATSAPP_TOKEN   — لقناة واتساب (نفس send-whatsapp.js)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM  — لقناة الإيميل
//
// ملاحظة مهمة: نموذج RSVP الحالي بالموقع ما يجمع بريد إلكتروني من الضيف —
// بس رقم جوال. يعني قناة "إيميل" حاليًا تشتغل فقط للضيوف اللي عندهم بريد
// مسجّل يدويًا (عبر "إضافة ضيف" أو "استيراد قائمة" بحقل البريد الاختياري).
//
// ===== كيف تشتغل الوسائط (فيديو/صورة) =====
// الفيديو والصورة يُرسلوا عن طريق رابط مباشر (مثلاً رابط Cloudinary) —
// مو رفع ملف مباشر من المتصفح. لازم ترفعي الفيديو/البطاقة على Cloudinary
// أولاً (زي ما تسوين بباقي المشروع) وتلصقين الرابط بلوحة التحكم.
//
// payload.contentTypes: مصفوفة من ["text","image","video"] — تقدرين تختارين
// وحدة أو أكثر بنفس الحملة (مثلاً فيديو + نص كابشن، أو صورة بس، أو الثلاثة).
// - لو فيديو مختار وفيه videoUrl: يترسل كرسالة فيديو (واتساب) / رابط بالإيميل.
// - لو صورة مختارة وفيه imageUrl: تترسل كرسالة صورة (واتساب) / صورة مرفقة بالإيميل.
// - النص (caption) ينحط على الصورة لو موجودة، وإلا على الفيديو، وإلا رسالة نص مستقلة.
// - لو ما اخترتي شي غير "نص"، أو ما وفرتي روابط، يرجع يشتغل بالطريقة القديمة (نص فقط).

const { getAdminDb } = require("./_report-lib");

function buildMessage(template, name) {
  return String(template || "").replaceAll("{name}", name || "");
}

async function verifyAuth(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!raw) return null;
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

async function waRequest(phoneId, token, body) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// يرسل رسالة واحدة أو أكثر (نص/صورة/فيديو) حسب المحتوى المطلوب، ويرجّع
// نتيجة إجمالية بالإضافة لتفاصيل كل جزء تم إرساله.
async function sendOneWhatsApp(phone, { message, contentTypes, imageUrl, videoUrl }) {
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";
  if (!phoneId || !token) return { ok: false, error: "واتساب غير مضبوط (WHATSAPP_PHONE_ID/WHATSAPP_TOKEN)" };
  const to = String(phone || "").replace(/[^0-9]/g, "");
  if (!to) return { ok: false, error: "رقم جوال غير صالح" };

  const wantImage = contentTypes.includes("image") && !!imageUrl;
  const wantVideo = contentTypes.includes("video") && !!videoUrl;
  const wantText = contentTypes.includes("text") && !!message;

  // ولا وسائط مختارة/متوفرة → نفس السلوك القديم بالضبط (نص فقط)
  if (!wantImage && !wantVideo) {
    return waRequest(phoneId, token, { messaging_product: "whatsapp", to, type: "text", text: { body: message } });
  }

  const steps = [];
  // الكابشن (النص) ينحط على أول وسائط متوفرة بس، عشان ما يتكرر النص مرتين
  let captionUsed = false;

  if (wantVideo) {
    const caption = wantText && !captionUsed ? message : undefined;
    if (caption) captionUsed = true;
    steps.push(waRequest(phoneId, token, {
      messaging_product: "whatsapp", to, type: "video",
      video: { link: videoUrl, ...(caption ? { caption } : {}) },
    }));
  }
  if (wantImage) {
    const caption = wantText && !captionUsed ? message : undefined;
    if (caption) captionUsed = true;
    steps.push(waRequest(phoneId, token, {
      messaging_product: "whatsapp", to, type: "image",
      image: { link: imageUrl, ...(caption ? { caption } : {}) },
    }));
  }
  // لو فيه نص ما انحط كابشن على ولا وسائط (نادر: يعني الاتنين محتاجين كابشن)
  if (wantText && !captionUsed) {
    steps.push(waRequest(phoneId, token, { messaging_product: "whatsapp", to, type: "text", text: { body: message } }));
  }

  const results = await Promise.all(steps);
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return { ok: true };
  return { ok: false, error: failed.map((r) => r.error).join(" | ") };
}

async function sendOneEmail(email, subject, { message, contentTypes, imageUrl, videoUrl }) {
  if (!email) return { ok: false, error: "لا يوجد بريد إلكتروني لهذا الضيف" };
  const { sendReportEmail } = require("./_report-lib");

  const wantImage = contentTypes.includes("image") && !!imageUrl;
  const wantVideo = contentTypes.includes("video") && !!videoUrl;

  let html = String(message || "").replaceAll("\n", "<br/>");
  const attachments = [];

  if (wantImage) {
    html += `<br/><br/><img src="${imageUrl}" alt="بطاقة الدعوة" style="max-width:100%;border-radius:8px" />`;
    // مرفق حقيقي بالإضافة للمعاينة بالمتن — nodemailer يجيب الملف من الرابط تلقائيًا
    attachments.push({ filename: "بطاقة-الدعوة.jpg", path: imageUrl });
  }
  if (wantVideo) {
    // الفيديوهات ما تُرفق بالإيميل (حجمها كبير) — يترسل رابط مباشر بدل كذا
    html += `<br/><br/><a href="${videoUrl}" style="display:inline-block;padding:10px 18px;background:#C5A059;color:#2c2009;border-radius:8px;text-decoration:none;font-weight:bold">🎬 شاهدوا الفيديو من هنا</a>`;
  }

  try {
    const result = await sendReportEmail({
      to: [email],
      subject,
      text: message,
      html,
      attachments,
    });
    if (!result.sent) return { ok: false, error: result.reason || "الإيميل غير مضبوط (SMTP)" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const uid = await verifyAuth(event);
  if (!uid) {
    return { statusCode: 401, body: JSON.stringify({ error: "غير مصرح — سجّلي دخول بلوحة التحكم أولاً" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { guestIds, channel, message, subject, imageUrl, videoUrl } = payload;
  // توافق مع الإصدار القديم: لو contentTypes ما انبعتت، اعتبريها "نص" بس
  const contentTypes = Array.isArray(payload.contentTypes) && payload.contentTypes.length
    ? payload.contentTypes
    : ["text"];

  if (!Array.isArray(guestIds) || !guestIds.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "لازم تختارين ضيف واحد على الأقل" }) };
  }
  const hasMedia = (contentTypes.includes("image") && imageUrl) || (contentTypes.includes("video") && videoUrl);
  if (!hasMedia && (!message || !message.trim())) {
    return { statusCode: 400, body: JSON.stringify({ error: "لازم نص رسالة، أو رابط صورة/فيديو على الأقل" }) };
  }
  const useWhatsApp = channel === "whatsapp" || channel === "both";
  const useEmail = channel === "email" || channel === "both";
  if (!useWhatsApp && !useEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: "اختاري قناة الإرسال" }) };
  }

  const db = getAdminDb();
  const results = [];

  for (const id of guestIds) {
    let guestData;
    try {
      const doc = await db.collection("responses").doc(id).get();
      if (!doc.exists) {
        results.push({ id, ok: false, error: "الضيف غير موجود" });
        continue;
      }
      guestData = doc.data();
    } catch (err) {
      results.push({ id, ok: false, error: "تعذّرت قراءة بيانات الضيف" });
      continue;
    }

    const name = guestData.name || "ضيف";
    const personalized = buildMessage(message, name);
    const mediaOpts = { message: personalized, contentTypes, imageUrl, videoUrl };
    const perGuest = { id, name, whatsapp: null, email: null };

    if (useWhatsApp) {
      perGuest.whatsapp = await sendOneWhatsApp(guestData.phone, mediaOpts);
    }
    if (useEmail) {
      perGuest.email = await sendOneEmail(guestData.email, subject || "دار جمرة غضى", mediaOpts);
    }

    const attempted = [perGuest.whatsapp, perGuest.email].filter(Boolean);
    const success = attempted.length > 0 && attempted.every((r) => r.ok);
    results.push({ id, name, ok: success, whatsapp: perGuest.whatsapp, email: perGuest.email });
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;

  return {
    statusCode: 200,
    body: JSON.stringify({ sent, failed, total: results.length, results }),
  };
};
