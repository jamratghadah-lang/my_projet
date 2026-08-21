// netlify/functions/ai-webhook.js
//
// webhook واتساب — يستقبل الرسائل الواردة من Meta WhatsApp Business API
// ويعالجها بالذكاء الاصطناعي ويرد على الضيف.
//
// GET  → تحقق الاشتراك (Hub verification challenge)
// POST → معالجة الرسائل الواردة
//
// متغيرات البيئة المطلوبة:
//   WHATSAPP_VERIFY_TOKEN — رمز التحقق من Meta webhook
//   WHATSAPP_APP_SECRET   — App Secret لتوقيع HMAC (إلزامي)
//   GEMINI_API_KEY         — مفتاح Google Gemini
//   WHATSAPP_PHONE_ID      — رقم هاتف الحساب التجاري
//   WHATSAPP_TOKEN         — رمز الوصول للواتساب
//   FIREBASE_SERVICE_ACCOUNT_JSON — مفتاح خدمة Firebase

const { safeEqual, getAdminApp } = require('./_auth');
const {
  classifyIntent,
  isPublicIntent,
  isGuestIntent,
  isClientIntent,
  buildPublicContext,
  buildGuestContext,
  buildClientStatsContext,
  parseGuestListText,
  formatDisambiguationMessage,
  parseSelectionNumber,
  generateResponse,
  sendWhatsAppMessage,
  verifyWhatsAppSignature,
  parseWhatsAppPayload,
  checkAIRateLimit,
  logConversation,
  trackAnalytics,
  sanitizeForAI,
  normalizePhone,
  isAIEnabled,
  processConfirmation,
} = require('./_ai-lib');

// No CORS headers — this endpoint is server-to-server only (Meta → Netlify)

// Persistent pending state: Netlify Functions are stateless and can cold-start
// between messages, so confirmations/selections must live in Firestore.
const PENDING_TTL = 5 * 60 * 1000;
const EVENT_SEL_TTL = 3 * 60 * 1000;

function getPendingDb() {
  const app = getAdminApp();
  return app ? app.firestore() : null;
}

function pendingDocId(phone) {
  return String(phone || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 120);
}

async function getPendingConfirmation(phone) {
  const db = getPendingDb();
  if (!db) return null;
  try {
    const snap = await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.kind !== "confirmation" || Date.now() - Number(data.timestamp || 0) > PENDING_TTL) {
      await snap.ref.delete().catch(() => {});
      return null;
    }
    return data;
  } catch (err) {
    console.error("[AI Webhook] getPendingConfirmation error:", err.message);
    return null;
  }
}

async function setPendingConfirmation(phone, type, params) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).set({
    kind: "confirmation", type, params, timestamp: Date.now(), expiresAt: Date.now() + PENDING_TTL
  });
}

async function clearPendingConfirmation(phone) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).delete().catch(() => {});
}

async function getPendingEventSelection(phone) {
  const db = getPendingDb();
  if (!db) return null;
  try {
    const snap = await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.kind !== "event_selection" || Date.now() - Number(data.timestamp || 0) > EVENT_SEL_TTL) {
      await snap.ref.delete().catch(() => {});
      return null;
    }
    return data;
  } catch (err) {
    console.error("[AI Webhook] getPendingEventSelection error:", err.message);
    return null;
  }
}

async function setPendingEventSelection(phone, options, originalIntent, originalMessage) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).set({
    kind: "event_selection", options, originalIntent, originalMessage, timestamp: Date.now(), expiresAt: Date.now() + EVENT_SEL_TTL
  });
}

async function clearPendingEventSelection(phone) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).delete().catch(() => {});
}

// ─── Post-event survey pending state ───
const SURVEY_TTL = 3 * 24 * 60 * 60 * 1000; // 3 أيام — نافذة معقولة للرد

async function getPendingSurvey(phone) {
  const db = getPendingDb();
  if (!db) return null;
  try {
    const snap = await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    const kind = data.kind || "";
    // "awaiting_survey" = استنى ضغطة الزر (أو رد حر)، و
    // "awaiting_survey_note" = ضغط "فيه ملاحظة" وسألناه، ننتظر نص الملاحظة.
    if (!kind.startsWith("awaiting_survey") || Date.now() - Number(data.timestamp || 0) > SURVEY_TTL) {
      await snap.ref.delete().catch(() => {});
      return null;
    }
    return data;
  } catch (err) {
    console.error("[AI Webhook] getPendingSurvey error:", err.message);
    return null;
  }
}

// ─── Reminder action pending state (QR request / confirm) ───
async function getPendingReminderAction(phone) {
  const db = getPendingDb();
  if (!db) return null;
  try {
    const snap = await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.kind !== "awaiting_reminder_action" || Date.now() - Number(data.timestamp || 0) > SURVEY_TTL) {
      await snap.ref.delete().catch(() => {});
      return null;
    }
    return data;
  } catch (err) {
    console.error("[AI Webhook] getPendingReminderAction error:", err.message);
    return null;
  }
}

async function clearPendingReminderAction(phone) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).delete().catch(() => {});
}

async function clearPendingSurvey(phone) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).delete().catch(() => {});
}

// لما الضيف يضغط "📝 فيه ملاحظة" — نسأله عن نص الملاحظة قبل ما نسجّل
// أي تقييم، ونحوّل الجلسة المعلّقة لانتظار هذا النص تحديدًا.
async function setPendingSurveyNote(phone, slug, guestName) {
  const db = getPendingDb();
  if (!db) return;
  await db.collection("ai_pending_sessions").doc(pendingDocId(phone)).set({
    kind: "awaiting_survey_note",
    slug,
    guestName,
    timestamp: Date.now(),
    expiresAt: Date.now() + SURVEY_TTL,
  });
}

/**
 * Handler — entry point for Netlify Function.
 */
exports.handler = async (event) => {
  // No CORS preflight — this is a server-to-server webhook
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ─── GET: Hub Verification Challenge ───
  if (event.httpMethod === 'GET') {
    return handleGet(event);
  }

  // ─── POST: Incoming WhatsApp Message ───
  if (event.httpMethod === 'POST') {
    return handlePost(event);
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ error: 'Method Not Allowed' }),
  };
};

// ============================================================
//  GET HANDLER — Hub Verification
// ============================================================

function handleGet(event) {
  const qs = event.queryStringParameters || {};
  const mode = qs['hub.mode'] || '';
  const token = qs['hub.verify_token'] || '';
  const challenge = qs['hub.challenge'] || '';
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';

  if (mode === 'subscribe' && token && safeEqual(token, verifyToken)) {
    return {
      statusCode: 200,
      body: challenge,
    };
  }

  return {
    statusCode: 403,
    body: 'Forbidden',
  };
}

// ============================================================
//  POST HANDLER — Incoming Message Processing
// ============================================================

async function handlePost(event) {
  // 1. Verify HMAC signature — MANDATORY
  const appSecret = process.env.WHATSAPP_APP_SECRET || '';
  if (!appSecret) {
    console.error('[AI Webhook] WHATSAPP_APP_SECRET not configured — rejecting all POST requests');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  const signature = event.headers['x-hub-signature-256'] || '';
  if (!verifyWhatsAppSignature(event.body || '', signature, appSecret)) {
    console.error('[AI Webhook] Invalid HMAC signature');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  // 2. Parse webhook payload
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const msg = parseWhatsAppPayload(body);
  if (!msg) {
    // Not a message event (could be status, etc.) — acknowledge 200
    return { statusCode: 200, body: 'OK' };
  }

  // 3. Extract phone and message
  const phone = msg.phone;
  const messageText = msg.messageText;

  if (!phone || !messageText || !messageText.trim()) {
    return { statusCode: 200, body: 'OK' };
  }

  // 4. Check rate limit
  const rlKey = `wa:${phone}`;
  const rl = await checkAIRateLimit(rlKey, 20, 60);
  if (!rl.allowed) {
    console.warn(`[AI Webhook] Rate limited: ${phone}`);
    return { statusCode: 200, body: 'OK' };
  }

  // 5. Process the message and WAIT for it to finish before returning.
  // Netlify/Lambda freezes the execution environment right after the
  // handler's response is sent — a "fire and forget" call here gets
  // killed mid-flight most of the time (the AI call + WhatsApp send
  // never complete), which is why replies were going missing with no
  // error in the logs. Meta tolerates a few seconds before retrying,
  // so awaiting this is safe.
  try {
    await processMessage(phone, messageText, msg.displayName, msg.buttonId);
  } catch (err) {
    console.error('[AI Webhook] processMessage error:', err.message);
  }

  return { statusCode: 200, body: 'OK' };
}

// ============================================================
//  MESSAGE PROCESSING PIPELINE
// ============================================================

async function processMessage(phone, messageText, displayName, buttonId) {
  let guestContext = null;
  let intent = 'PUBLIC_INFO';
  let responseText = '';
  let action = null;
  let actionResult = null;
  let tokensUsed = 0;
  let guestMatched = false;

  try {
    // 6. Check if AI is enabled
    const enabled = await isAIEnabled('whatsapp');
    if (!enabled) {
      await sendWhatsAppMessage(
        phone,
        'شكراً لتواصلكم مع جمرة غضى 🌹\nحالياً الخدمة الذكية مو متوفرة، تواصلوا معنا مباشرة على الواتساب للدعم.'
      );
      return;
    }

    // 6.4 Check for pending reminder action (QR request / confirm)
    const pendingReminder = await getPendingReminderAction(phone);
    if (pendingReminder) {
      await clearPendingReminderAction(phone);
      const name = pendingReminder.guestName || "ضيفنا";
      const slug = pendingReminder.slug || "";
      const eventCode = pendingReminder.eventCode || "";

      if (buttonId === "reminder_qr_request") {
        // الضيف يبي بطاقة الدخول — نجيب بياناته ونبعتها
        try {
          const { getAdminDb } = require("./_report-lib");
          const { sendFullEntryCard } = require("./_ai-lib");
          const db = getAdminDb();
          if (db) {
            let guestDoc = null;
            const byPhone = await db.collection("responses").where("phone", "==", phone).limit(1).get();
            if (!byPhone.empty) guestDoc = byPhone.docs[0];
            if (guestDoc) {
              const gd = guestDoc.data();
              const cardUrl = await sendFullEntryCard({
                guestName: gd.name || name,
                entryCode: gd.entryCode || "",
                eventId: gd.eventId || gd.eventCode || eventCode,
                slug: gd.style || slug,
                companions: gd.companions || 0,
                phone,
                db,
              });
              if (cardUrl) {
                const msg = `🎫 بطاقة دخولك الشخصية يا ${gd.name || name} — احتفظي بها واعرضيها عند الباب`;
                await sendWhatsAppMessage(phone, msg, "image", { link: cardUrl });
              } else {
                await sendWhatsAppMessage(phone, `عذراً ${name}، ما قدرنا نولّد بطاقتك الآن. حاولي تراسلنا "بطاقتي" بعد شوي 🌹`);
              }
            } else {
              await sendWhatsAppMessage(phone, `ما لقينا بياناتك عندنا ${name} — تأكدي إن الرابط اللي وصلك هو نفس الرابط اللي سجلتِ منه 🌹`);
            }
          }
        } catch (err) {
          console.error("[AI Webhook] reminder QR error:", err.message);
          await sendWhatsAppMessage(phone, `حدث خطأ تقني — حاولي بعد شوي ${name} 🌹`);
        }
        return;
      }

      if (buttonId === "reminder_confirm") {
        // الضيف يبي يتأكد — نفحص حالته ونخبره
        try {
          const { getAdminDb } = require("./_report-lib");
          const db = getAdminDb();
          if (db) {
            const byPhone = await db.collection("responses").where("phone", "==", phone).limit(1).get();
            if (!byPhone.empty) {
              const gd = byPhone.docs[0].data();
              const st = gd.status || "";
              if (st === "yes" || st === "confirmed") {
                await sendWhatsAppMessage(phone, `حضورك مؤكد يا ${gd.name || name} 🌹 ننتظركم يوم المناسبة`);
              } else if (st === "no") {
                await sendWhatsAppMessage(phone, `ملاحظ إنك مسجّلة كمعتذرة يا ${gd.name || name}. لو تغيرت رأيك وتبين تحضرين، ردي بـ "أبي أحضر" 🌹`);
              } else {
                await sendWhatsAppMessage(phone, `ما تلقينا تأكيد حضورك بعد يا ${gd.name || name}. ردي بـ "أبي أحضر" عشان نؤكد حضورك 🌹`);
              }
            }
          }
        } catch (err) {
          console.error("[AI Webhook] reminder confirm error:", err.message);
        }
        return;
      }
    }

    // 6.5 Check for pending post-event survey — either a button press
    // ("🤍 رائعة" / "📝 فيه ملاحظة") or a free-text reply is feedback,
    // not a normal intent.
    const pendingSurvey = await getPendingSurvey(phone);
    if (pendingSurvey) {
      const trimmed = (messageText || "").trim();

      if (pendingSurvey.kind === "awaiting_survey_note") {
        // وصل نص الملاحظة الفعلي بعد ما سألناها — نسجّل التقييم الآن.
        await getPendingDb().collection("post_event_feedback").add({
          slug: pendingSurvey.slug,
          guestName: pendingSurvey.guestName,
          guestPhone: phone,
          rating: "issue",
          note: trimmed,
          time: new Date().toISOString(),
        });
        await clearPendingSurvey(phone);

        const thankYouMsg = "تسلمين على صراحتك 🌹 ملاحظتك وصلتنا وراح نستفيد منها. شرفتونا 💛";
        await sendWhatsAppMessage(phone, thankYouMsg);
        await logConversation({
          platform: "whatsapp",
          guestPhone: phone,
          userMessage: messageText,
          assistantResponse: thankYouMsg,
          intent: "SURVEY_RESPONSE",
          tokensUsed: 0,
        });
        await trackAnalytics({ intent: "SURVEY_RESPONSE", platform: "whatsapp", tokensUsed: 0, guestMatched: true });
        return;
      }

      // pendingSurvey.kind === "awaiting_survey"
      if (buttonId === "survey_issue") {
        // ضغط "فيه ملاحظة" — نسجّل التقييم لاحقًا، بعد ما ياخذ ردّه.
        await setPendingSurveyNote(phone, pendingSurvey.slug, pendingSurvey.guestName);
        const askMsg = "تسلمين 🌹 وش الملاحظة اللي حابين نعرفها؟";
        await sendWhatsAppMessage(phone, askMsg);
        await logConversation({
          platform: "whatsapp",
          guestPhone: phone,
          userMessage: messageText,
          assistantResponse: askMsg,
          intent: "SURVEY_ASK_NOTE",
          tokensUsed: 0,
        });
        await trackAnalytics({ intent: "SURVEY_ASK_NOTE", platform: "whatsapp", tokensUsed: 0, guestMatched: true });
        return;
      }

      // ضغط "رائعة" فيسجَّل فورًا، أو رد حر (بدون زر) فنخمّن النية من
      // النص كما كان سابقًا — احتياط لو الرسالة وصلت بدون معرّف زر.
      const isPositive = buttonId === "survey_positive"
        || /^(رائع|ممتاز|تمام|زين|حلو|كويس|👍|❤️|💛)/i.test(trimmed);
      const rating = isPositive ? "happy" : "issue";
      const note = isPositive ? null : trimmed;

      await getPendingDb().collection("post_event_feedback").add({
        slug: pendingSurvey.slug,
        guestName: pendingSurvey.guestName,
        guestPhone: phone,
        rating,
        note,
        time: new Date().toISOString(),
      });
      await clearPendingSurvey(phone);

      const thankYouMsg = isPositive
        ? "تسلمون على وقتكم 🌹 يسعدنا إنكم استمتعتوا معانا. شرفتونا 💛"
        : "تسلمين على صراحتك 🌹 ملاحظتك وصلتنا وراح نستفيد منها. شرفتونا 💛";
      await sendWhatsAppMessage(phone, thankYouMsg);
      await logConversation({
        platform: "whatsapp",
        guestPhone: phone,
        userMessage: messageText,
        assistantResponse: thankYouMsg,
        intent: "SURVEY_RESPONSE",
        tokensUsed: 0,
      });
      await trackAnalytics({ intent: "SURVEY_RESPONSE", platform: "whatsapp", tokensUsed: 0, guestMatched: true });
      return;
    }

    // 6.7 Detect a pasted guest list by shape (2+ "name + phone" lines).
    // Only meaningful if the sender is a verified event owner — a random
    // guest pasting text should never trigger a bulk add.
    const possibleList = parseGuestListText(messageText);
    if (possibleList) {
      const clientCtx = await buildClientStatsContext(phone);
      if (!clientCtx) {
        // مو عميلة معروفة — تجاهلي، خليها تكمل كنص عادي بالتصنيف الطبيعي
      } else {
        const db = getPendingDb();
        let added = 0, skipped = 0;
        for (const entry of possibleList) {
          try {
            // فحص التكرار حسب أي وسيلة تواصل متوفرة (جوال أو إيميل)
            let dupFound = false;
            if (entry.phone) {
              const dupCheck = await db
                .collection("responses")
                .where("eventCode", "==", clientCtx.eventId)
                .where("phone", "==", entry.phone)
                .limit(1)
                .get();
              if (!dupCheck.empty) dupFound = true;
            }
            if (!dupFound && !entry.phone && entry.email) {
              const dupCheck = await db
                .collection("responses")
                .where("eventCode", "==", clientCtx.eventId)
                .where("email", "==", entry.email)
                .limit(1)
                .get();
              if (!dupCheck.empty) dupFound = true;
            }
            if (dupFound) { skipped++; continue; }

            const newDoc = {
              name: entry.name,
              guests: 1,
              status: "pending",
              eventCode: clientCtx.eventId,
              style: clientCtx.eventId,
              source: "client_bulk_import",
              archived: false,
              createdAt: new Date().toISOString(),
            };
            if (entry.phone) newDoc.phone = entry.phone;
            if (entry.email) newDoc.email = entry.email;

            await db.collection("responses").add(newDoc);
            added++;
          } catch {
            skipped++;
          }
        }

        const summary =
          `تم ✅ أضفت ${added} ضيف لقائمة "${clientCtx.eventName}"` +
          (skipped ? `، وتخطيت ${skipped} (مكررين أو فيهم خطأ).` : ".") +
          `\n\nحالتهم "بالانتظار" لين يردون، أو تقدرين تعدّلين حالتهم من لوحة التحكم.`;

        await sendWhatsAppMessage(phone, summary);
        await logConversation({
          platform: "whatsapp",
          guestPhone: phone,
          userMessage: messageText,
          assistantResponse: summary,
          intent: "CLIENT_BULK_ADD_GUESTS",
          tokensUsed: 0,
        });
        await trackAnalytics({ intent: "CLIENT_BULK_ADD_GUESTS", platform: "whatsapp", tokensUsed: 0, guestMatched: true });
        return;
      }
    }

    // 7. Check for pending event selection (disambiguation)
    const eventSelection = await getPendingEventSelection(phone);
    if (eventSelection) {
      const selectedIndex = parseSelectionNumber(messageText, eventSelection.options.length);
      if (selectedIndex !== null) {
        await clearPendingEventSelection(phone);
        guestContext = await buildGuestContext(phone, selectedIndex);
        if (guestContext) {
          guestMatched = true;
          const publicContext = await buildPublicContext();
          const fullContext = {
            ...guestContext,
            public: publicContext,
            phone,
            platform: 'whatsapp',
            entities: {},
          };
          const result = await generateResponse(eventSelection.originalIntent, fullContext, eventSelection.originalMessage);
          responseText = result.text;
          action = result.action;
          actionResult = result.actionResult;
          tokensUsed = result.tokensUsed;

          const alreadySent =
            (eventSelection.originalIntent === 'RESEND_INVITATION' && actionResult && actionResult.sent) ||
            (eventSelection.originalIntent === 'SEND_LOCATION' && actionResult && actionResult.sent);
          if (!alreadySent && responseText) {
            await sendWhatsAppMessage(phone, responseText);
          }
          await logConversation({
            platform: 'whatsapp',
            guestPhone: phone,
            userMessage: messageText,
            assistantResponse: responseText,
            intent: eventSelection.originalIntent,
            action,
            tokensUsed,
          });
          await trackAnalytics({
            intent: eventSelection.originalIntent,
            platform: 'whatsapp',
            tokensUsed,
            guestMatched: true,
          });
          return;
        }
      }
      const reminderMsg = formatDisambiguationMessage(eventSelection.options);
      await sendWhatsAppMessage(phone, reminderMsg);
      return;
    }

    // 8. Check for pending confirmation
    const pending = await getPendingConfirmation(phone);
    // RSVP confirmation prompts are obsolete for WhatsApp: the incoming
    // WhatsApp number already identifies the guest. Clear any stale RSVP
    // confirmation left by an older deployment and execute the requested RSVP
    // directly on the current verified guest context.
    if (pending && pending.action === "UPDATE_RSVP") {
      await clearPendingConfirmation(phone);
      const guestContext = await buildGuestContext(phone);
      if (guestContext && !guestContext._disambiguate) {
        const publicContext = await buildPublicContext();
        const fullContext = {
          ...guestContext,
          public: publicContext,
          phone,
          platform: "whatsapp",
          entities: { ...pending.params, confirmed: true },
        };
        const result = await generateResponse(
          "UPDATE_RSVP",
          fullContext,
          messageText
        );
        responseText = result.text;
        action = result.action;
        actionResult = result.actionResult;
        tokensUsed = result.tokensUsed;
        await sendWhatsAppMessage(phone, responseText);
        await logConversation({
          platform: "whatsapp",
          guestPhone: phone,
          userMessage: messageText,
          assistantResponse: responseText,
          intent: "UPDATE_RSVP",
          action,
          tokensUsed,
        });
        return;
      }
    }

    if (pending) {
      const confirmation = processConfirmation(messageText, pending);
      if (confirmation) {
        await clearPendingConfirmation(phone);
        if (confirmation.confirmed) {
          const guestContext = await buildGuestContext(phone);
          const publicContext = await buildPublicContext();
          const fullContext = {
            ...guestContext,
            public: publicContext,
            phone,
            platform: 'whatsapp',
            entities: pending.params,
          };

          const result = await generateResponse(
            pending.action,
            fullContext,
            messageText
          );
          responseText = result.text;
          action = result.action;
          actionResult = result.actionResult;
          tokensUsed = result.tokensUsed;

          if (actionResult && actionResult.needsConfirmation) {
            const confirmedParams = { ...pending.params, confirmed: true };
            const confirmedResult = await generateResponse(
              pending.action,
              { ...fullContext, entities: confirmedParams },
              messageText
            );
            responseText = confirmedResult.text;
            action = confirmedResult.action;
            actionResult = confirmedResult.actionResult;
            tokensUsed = confirmedResult.tokensUsed;
          }
        } else {
          responseText = 'تمام، ما تم التنفيذ 🌹';
          action = 'CANCELLED';
        }

        await sendWhatsAppMessage(phone, responseText);
        await logConversation({
          platform: 'whatsapp',
          guestPhone: phone,
          userMessage: messageText,
          assistantResponse: responseText,
          intent: pending.action,
          action,
          tokensUsed,
        });
        await trackAnalytics({
          intent: pending.action,
          platform: 'whatsapp',
          tokensUsed,
          guestMatched: !!guestMatched,
        });
        return;
      }
    }

    // 9. Classify intent
    const classification = await classifyIntent(messageText);
    intent = classification.intent;

    // 10. Build context
    const publicContext = await buildPublicContext();
    let clientContext = null;
    if (isClientIntent(intent)) {
      clientContext = await buildClientStatsContext(phone);
    } else if (isGuestIntent(intent)) {
      guestContext = await buildGuestContext(phone);
      if (guestContext) {
        if (guestContext._disambiguate) {
          const disambigMsg = formatDisambiguationMessage(guestContext.options);
          await setPendingEventSelection(phone, guestContext.options, intent, messageText);
          await sendWhatsAppMessage(phone, disambigMsg);
          await logConversation({
            platform: 'whatsapp',
            guestPhone: phone,
            userMessage: messageText,
            assistantResponse: disambigMsg,
            intent: 'DISAMBIGUATE',
            tokensUsed: 0,
          });
          await trackAnalytics({ intent: 'DISAMBIGUATE', platform: 'whatsapp', tokensUsed: 0, guestMatched: false });
          return;
        }
        guestMatched = true;
      }
    }

    const fullContext = {
      ...guestContext,
      client: clientContext,
      public: publicContext,
      phone,
      platform: 'whatsapp',
      entities: classification.entities,
    };

    // 11a. Client asked for stats but phone isn't a recognized event owner —
    // never leak whose numbers those are; just say we couldn't identify them.
    if (isClientIntent(intent) && !clientContext) {
      responseText =
        'ما قدرت أتعرف على مناسبتك بهذا الرقم 🌹\n\n' +
        'تأكد إنك تستخدم نفس رقم الجوال المسجل كصاحب/ة المناسبة.\n' +
        'لو تحتاج مساعدة، تواصل معنا مباشرة. 💛';

      await sendWhatsAppMessage(phone, responseText);
      await logConversation({
        platform: 'whatsapp',
        guestPhone: phone,
        userMessage: messageText,
        assistantResponse: responseText,
        intent,
        tokensUsed: 0,
      });
      await trackAnalytics({ intent, platform: 'whatsapp', tokensUsed: 0, guestMatched: false });
      return;
    }

    // 11. Handle guest intent without guest data
    if (isGuestIntent(intent) && !guestContext) {
      responseText =
        'ما قدرت أتعرف على دعوتك حالياً 🌹\n\n' +
        'تأكد إنك تستخدم نفس الرقم اللي سجلت فيه.\n' +
        'لو تحب تسأل عن الباقات أو التواصل معنا، تفضل! 💛';

      await sendWhatsAppMessage(phone, responseText);
      await logConversation({
        platform: 'whatsapp',
        guestPhone: phone,
        userMessage: messageText,
        assistantResponse: responseText,
        intent,
        tokensUsed: 0,
      });
      await trackAnalytics({ intent, platform: 'whatsapp', tokensUsed: 0, guestMatched: false });
      return;
    }

    // 11. Generate response
    const result = await generateResponse(intent, fullContext, messageText);
    responseText = result.text;
    action = result.action;
    actionResult = result.actionResult;
    tokensUsed = result.tokensUsed;

    // 12. Store pending confirmation if needed
    if (actionResult && actionResult.needsConfirmation) {
      const pendingParams = { ...classification.entities };
      if (intent === 'UPDATE_RSVP') {
        pendingParams.newStatus = actionResult.pendingStatus;
      } else if (intent === 'UPDATE_GUEST_COUNT') {
        pendingParams.newCount = actionResult.pendingCount;
      }
      await setPendingConfirmation(phone, intent, pendingParams);
    }

    // 13. Send response via WhatsApp
    const alreadySent =
      (intent === 'RESEND_INVITATION' && actionResult && actionResult.sent) ||
      (intent === 'SEND_LOCATION' && actionResult && actionResult.sent);

    if (!alreadySent && responseText) {
      await sendWhatsAppMessage(phone, responseText);
    }

    // 14. Log conversation
    await logConversation({
      platform: 'whatsapp',
      guestPhone: phone,
      userMessage: messageText,
      assistantResponse: responseText,
      intent,
      action,
      tokensUsed,
    });

    // 15. Track analytics
    await trackAnalytics({
      intent,
      platform: 'whatsapp',
      tokensUsed,
      guestMatched,
      leadCaptured: intent === 'LEAD_CAPTURE' && actionResult && actionResult.captured,
    });
  } catch (err) {
    console.error('[AI Webhook] Unhandled error:', err);
    try {
      await sendWhatsAppMessage(phone, 'عذراً، حصل خطأ مؤقت. حاول بعد شوي 🌹');
    } catch {
      // Silent fail
    }
  }
}
