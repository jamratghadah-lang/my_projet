// netlify/functions/post-event-survey.js
//
// دالة مُجدولة (كل ساعة) تفحص المناسبات المنتهية وترسل استبيان رضا
// تلقائي عبر واتساب لكل ضيف أكّد حضوره (status = "yes")، بعد X أيام
// من تاريخ المناسبة (افتراضيًا يوم واحد، قابل للتعديل عبر
// content/settings.json → survey.days_after).
//
// آلية منع التكرار: كل مناسبة تُرسل لها الاستبيانات مرة واحدة فقط،
// عبر علامة survey_sent=true على مستند couples/<slug>.
//
// الردود تُخزَّن في مجموعة Firestore جديدة: post_event_feedback
//   { slug, guestName, guestPhone, rating (\"happy\"|\"issue\"), note, time }
//
// الجدولة في netlify.toml:
//   [functions."post-event-survey"]
//     schedule = "0 * * * *"   ← كل ساعة

const { getAdminDb } = require("./_report-lib");
const { safeEqual } = require("./_auth");

function verifyCronSecret(event) {
  if (event.httpMethod === "SCHEDULED") return true;
  const provided = (event.headers && event.headers["x-cron-secret"]) || "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !safeEqual(provided, expected)) return false;
  return true;
}

function normalizePhone(p) {
  let clean = String(p || "").replace(/[^\d+]/g, "");
  if (clean.startsWith("0")) clean = "966" + clean.slice(1);
  if (!clean.startsWith("+") && !clean.startsWith("966")) clean = "966" + clean;
  return clean.replace(/^\+/, "");
}

async function sendWhatsAppSurvey(phone, guestName, eventUrl) {
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";
  if (!phoneId || !token) return { ok: false, error: "PROVIDER_NOT_CONFIGURED" };

  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return { ok: false, error: "رقم غير صالح" };

  const text =
    `عسى الله يسعدكم دايم 🌹\n\n` +
    `نتمنى إنكم استمتعتوا معانا بتجربة مناسبتكم. ` +
    `هل كل شي كان زي ما تحبون؟\n\n` +
    `ردّي بكلمة "رائع" لو عجبتكم التجربة، أو اكتبي لنا ملاحظتكم ونسعد نسمعها. ` +
    `شرفتونا 💛\n— جمرة غضى`;

  const API_BASE = "https://graph.facebook.com/v21.0";
  const res = await fetch(`${API_BASE}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { ok: false, error: `WhatsApp send failed (${res.status}): ${errText}` };
  }
  return { ok: true };
}

exports.handler = async (event) => {
  if (!verifyCronSecret(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  try {
    const db = getAdminDb();
    const daysAfter = parseInt(process.env.SURVEY_DAYS_AFTER || "1", 10);
    const eventHost = process.env.URL || process.env.DEPLOY_URL || "https://jamratghadah.com";

    const couplesSnap = await db.collection("couples").get();
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // ±1 ساعة
    const TARGET_MS = daysAfter * 24 * 60 * 60 * 1000;

    let totalSurveysSent = 0;
    const processedEvents = [];

    for (const doc of couplesSnap.docs) {
      const slug = doc.id;
      const coupleData = doc.data() || {};
      if (coupleData.survey_sent) continue; // لا تكرري لنفس المناسبة

      const template = coupleData.template;
      if (!template) continue;

      let jsonDate = null;
      try {
        const jsonRes = await fetch(`${eventHost}/content/rsvp/${encodeURIComponent(template)}.json`);
        if (jsonRes.ok) {
          const json = await jsonRes.json();
          jsonDate = json.date || null;
        }
      } catch {
        continue;
      }
      if (!jsonDate) continue;

      const m = String(jsonDate).match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
      if (!m) continue;
      const eventDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 18, 0, 0);
      if (isNaN(eventDate.getTime())) continue;

      const targetTime = eventDate.getTime() + TARGET_MS;
      const diff = targetTime - now;
      if (Math.abs(diff) > WINDOW_MS) continue; // لسا ما وصل وقت الإرسال

      // اجمعي الضيوف المؤكدين لهذي المناسبة
      const responsesSnap = await db
        .collection("responses")
        .where("style", "==", template)
        .where("status", "==", "yes")
        .get();

      let sentForThisEvent = 0;
      for (const rDoc of responsesSnap.docs) {
        const r = rDoc.data();
        if (!r.phone) continue;
        try {
          const result = await sendWhatsAppSurvey(r.phone, r.name || "ضيف", slug);
          if (result.ok) {
            totalSurveysSent++;
            sentForThisEvent++;
            // سجّلي جلسة معلقة عشان لو الضيف رد، البوت يعرف يربط
            // الرد بهذي المناسبة تحديدًا (مو رسالة عامة تُصنَّف غلط)
            const normalizedPhone = normalizePhone(r.phone);
            const pendingDocId = normalizedPhone.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 120);
            await db.collection("ai_pending_sessions").doc(pendingDocId).set({
              kind: "awaiting_survey",
              slug,
              guestName: r.name || "ضيف",
              guestPhone: normalizedPhone,
              timestamp: Date.now(),
              expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
            });
          }
        } catch {
          /* تجاهل الأخطاء الفردية، كملي بالباقي */
        }
      }

      // علّمي المناسبة كمُرسَلة عشان ما نكرر
      await doc.ref.set({ survey_sent: true, survey_sent_at: new Date().toISOString() }, { merge: true });
      processedEvents.push({ slug, sentForThisEvent });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ sent: true, totalSurveysSent, processedEvents: processedEvents.length }),
    };
  } catch (err) {
    console.error("[post-event-survey] error:", err.message);
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: "error" }) };
  }
};
