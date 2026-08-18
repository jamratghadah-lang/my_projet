// netlify/functions/video-scheduler.js
//
// دالة مجدولة (cron كل ساعة) — تُرسل تلقائيًا:
//   1) فيديو التذكير قبل المناسبة (افتراضي 48 ساعة، قابل للتعديل).
//   2) فيديو الشكر بعد المناسبة (افتراضي 12 ساعة، قابل للتعديل).
//
// نفس مصدر البيانات اللي يستخدمه event-reminder.js بالضبط — بدون ازدواجية:
//   - مجموعة "couples" (كل مستند = رابط دعوة بأسماء العروسين + القالب).
//   - تاريخ المناسبة يُقرأ من content/rsvp/<template>.json (date).
//   - الضيوف المؤكدون من مجموعة "responses" (style === template أو slug).
//
// كل رابط دعوة (couples/{slug}) يخزّن:
//   reminderVideoUrl, thankYouVideoUrl        — روابط الفيديوهات (Cloudinary
//                                                أو أي رابط https مباشر)
//   reminderHoursBefore, thankYouHoursAfter   — تخصيص الساعات لهذه المناسبة
//                                                فقط (اختياري — لو فاضي
//                                                يُستخدم الافتراضي العام)
//   reminderVideoSent, thankYouVideoSent      — تُكتب تلقائيًا بعد الإرسال
//                                                عشان ما تتكرر (إرسال مرة
//                                                واحدة فقط لكل مناسبة)
//
// الإعدادات العامة الافتراضية: settings/scheduling (Firestore) —
//   { reminderHoursBefore: 48, thankYouHoursAfter: 12 }
//   تُعدَّل من dashboard/reminders.html.
//
// كل إرسال (نجح أو فشل) يُسجَّل في send_logs — نفس سجل الإرسال الدائم
// المستخدم بكل قنوات المشروع (type: "reminder" أو "thank_you").
//
// الجدولة في netlify.toml:
//   [functions."video-scheduler"]
//     schedule = "0 * * * *"   ← كل ساعة

const admin = require("firebase-admin");
const { getAdminDb, sendReportEmail } = require("./_report-lib");
const { safeEqual } = require("./_auth");

function verifyCronSecret(event) {
  if (event.httpMethod === "SCHEDULED") return true;
  const provided = (event.headers && event.headers["x-cron-secret"]) || "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !safeEqual(provided, expected)) return false;
  return true;
}

const WINDOW_MS = 60 * 60 * 1000; // ±1 ساعة (نفس نافذة event-reminder.js لأن الدالة تعمل كل ساعة)
const DEFAULT_REMINDER_HOURS = 48;
const DEFAULT_THANKYOU_HOURS = 24; // يوم واحد بعد المناسبة — نفس توقيت الاستبيان (post-event-survey.js)

function normalizePhone(p) {
  let clean = String(p || "").replace(/[^\d+]/g, "");
  if (clean.startsWith("0")) clean = "966" + clean.slice(1);
  if (clean.startsWith("+")) clean = clean.slice(1);
  return clean;
}

function isHttpsUrl(u) {
  return typeof u === "string" && u.startsWith("https://");
}

function parseEventDate(jsonDate) {
  const m = String(jsonDate || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 18, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

async function sendVideoWhatsApp(phone, videoUrl, caption) {
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";
  if (!phoneId || !token) return { ok: false, error: "WHATSAPP_NOT_CONFIGURED" };
  const to = normalizePhone(phone);
  if (!to) return { ok: false, error: "رقم غير صالح" };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "video",
        video: { link: videoUrl, caption },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function sendVideoEmail(email, videoUrl, subject, headline, bodyText, buttonText) {
  if (!email) return { ok: false, error: "لا يوجد بريد" };
  const esc = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const html = `<!doctype html><html dir="rtl"><body style="margin:0;background:#f4f1ea;padding:24px;font-family:Tahoma,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden">
      <div style="background:rgba(20,20,20,.85);padding:38px 26px;text-align:center;color:#fff">
        <div style="font-size:24px;font-weight:bold;margin-bottom:14px">${esc(headline)}</div>
        <div style="font-size:15px;line-height:2">${esc(bodyText)}</div>
        <a href="${esc(videoUrl)}" style="display:inline-block;margin-top:22px;padding:13px 26px;background:#d4af37;color:#111;border-radius:999px;text-decoration:none;font-weight:bold">${esc(buttonText)}</a>
      </div>
    </div></body></html>`;
  try {
    const result = await sendReportEmail({ to: [email], subject, text: bodyText, html });
    if (!result.sent) return { ok: false, error: result.reason || "EMAIL_NOT_CONFIGURED" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function logSend(db, { eventId, channel, recipient, guestName, type, status, failReason }) {
  try {
    await db.collection("send_logs").add({
      eventId,
      channel,
      recipient: recipient || "",
      guestName: guestName || "",
      type,
      status,
      failReason: failReason || null,
      triggeredBy: "video-scheduler",
      time: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch {
    /* تجاهل خطأ التسجيل — ما نوقف الإرسال بسببه */
  }
}

exports.handler = async (event) => {
  if (!verifyCronSecret(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  try {
    const db = getAdminDb();
    const eventHost = process.env.URL || process.env.DEPLOY_URL || "https://jamratghadah.com";

    // 1) الإعدادات العامة الافتراضية (settings/scheduling)
    let reminderDefault = DEFAULT_REMINDER_HOURS;
    let thankYouDefault = DEFAULT_THANKYOU_HOURS;
    try {
      const settingsSnap = await db.collection("settings").doc("scheduling").get();
      if (settingsSnap.exists) {
        const s = settingsSnap.data() || {};
        if (Number(s.reminderHoursBefore) > 0) reminderDefault = Number(s.reminderHoursBefore);
        if (Number(s.thankYouHoursAfter) > 0) thankYouDefault = Number(s.thankYouHoursAfter);
      }
    } catch {
      /* استخدمي الافتراضي لو تعذرت القراءة */
    }

    const couplesSnap = await db.collection("couples").get();
    const responsesSnap = await db.collection("responses").get();
    const responseDocs = [];
    responsesSnap.forEach((d) => responseDocs.push(d.data()));

    const now = Date.now();
    let reminderSent = 0, reminderFailed = 0, thankYouSent = 0, thankYouFailed = 0;
    let reminderEventsTriggered = 0, thankYouEventsTriggered = 0;

    for (const coupleDoc of couplesSnap.docs) {
      const slug = coupleDoc.id;
      const c = coupleDoc.data() || {};
      const template = c.template;
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
      const eventDate = parseEventDate(jsonDate);
      if (!eventDate) continue;

      const diff = eventDate.getTime() - now; // موجب = المناسبة لسا ما جت، سالب = خلصت

      const guests = responseDocs.filter((f) => {
        const status = f.status || "";
        const docStyle = f.style || "";
        if (docStyle !== template && docStyle !== slug) return false;
        return status === "yes" || status === "confirmed" || status === "نعم";
      });

      // ===== 1) فيديو التذكير قبل المناسبة =====
      const reminderVideoUrl = c.reminderVideoUrl;
      const reminderHours = Number(c.reminderHoursBefore) > 0 ? Number(c.reminderHoursBefore) : reminderDefault;
      if (isHttpsUrl(reminderVideoUrl) && !c.reminderVideoSent) {
        const targetMs = reminderHours * 60 * 60 * 1000;
        if (Math.abs(diff - targetMs) <= WINDOW_MS && guests.length) {
          reminderEventsTriggered++;
          const caption = `تذكير بمناسبتنا 🌸 (${jsonDate}) — بانتظار حضوركم`;
          for (const g of guests) {
            const name = g.name || "ضيف";
            if (g.phone) {
              const r = await sendVideoWhatsApp(g.phone, reminderVideoUrl, caption);
              r.ok ? reminderSent++ : reminderFailed++;
              await logSend(db, { eventId: slug, channel: "whatsapp", recipient: g.phone, guestName: name, type: "reminder", status: r.ok ? "sent" : "failed", failReason: r.error });
            }
            if (g.email) {
              const r = await sendVideoEmail(g.email, reminderVideoUrl, "تذكير بمناسبتنا 🌸", "تذكير بمناسبتنا 🌸", caption, "مشاهدة فيديو التذكير");
              r.ok ? reminderSent++ : reminderFailed++;
              await logSend(db, { eventId: slug, channel: "email", recipient: g.email, guestName: name, type: "reminder", status: r.ok ? "sent" : "failed", failReason: r.error });
            }
          }
          await coupleDoc.ref.update({ reminderVideoSent: true, reminderVideoSentAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      }

      // ===== 2) فيديو الشكر بعد المناسبة =====
      const thankYouVideoUrl = c.thankYouVideoUrl;
      const thankYouHours = Number(c.thankYouHoursAfter) > 0 ? Number(c.thankYouHoursAfter) : thankYouDefault;
      if (isHttpsUrl(thankYouVideoUrl) && !c.thankYouVideoSent) {
        const sinceEventMs = -diff; // موجب = المناسبة خلصت من كذا ساعة
        const targetMs = thankYouHours * 60 * 60 * 1000;
        if (sinceEventMs > 0 && Math.abs(sinceEventMs - targetMs) <= WINDOW_MS && guests.length) {
          thankYouEventsTriggered++;
          const caption = `شكرًا لحضوركم مناسبتنا 🤍 — امتناننا الكبير لكم`;
          for (const g of guests) {
            const name = g.name || "ضيف";
            if (g.phone) {
              const r = await sendVideoWhatsApp(g.phone, thankYouVideoUrl, caption);
              r.ok ? thankYouSent++ : thankYouFailed++;
              await logSend(db, { eventId: slug, channel: "whatsapp", recipient: g.phone, guestName: name, type: "thank_you", status: r.ok ? "sent" : "failed", failReason: r.error });
            }
            if (g.email) {
              const r = await sendVideoEmail(g.email, thankYouVideoUrl, "شكرًا لحضوركم 🤍", "شكرًا لحضوركم 🤍", caption, "مشاهدة فيديو الشكر");
              r.ok ? thankYouSent++ : thankYouFailed++;
              await logSend(db, { eventId: slug, channel: "email", recipient: g.email, guestName: name, type: "thank_you", status: r.ok ? "sent" : "failed", failReason: r.error });
            }
          }
          await coupleDoc.ref.update({ thankYouVideoSent: true, thankYouVideoSentAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        reminderEventsTriggered, reminderSent, reminderFailed,
        thankYouEventsTriggered, thankYouSent, thankYouFailed,
      }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
