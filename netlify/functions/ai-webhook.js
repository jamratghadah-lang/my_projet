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
  buildPublicContext,
  buildGuestContext,
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

  // 5. Process asynchronously to respond fast to WhatsApp
  processMessage(phone, messageText, msg.displayName).catch((err) => {
    console.error('[AI Webhook] processMessage error:', err.message);
  });

  // Return 200 immediately to WhatsApp
  return { statusCode: 200, body: 'OK' };
}

// ============================================================
//  MESSAGE PROCESSING PIPELINE
// ============================================================

async function processMessage(phone, messageText, displayName) {
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
    if (isGuestIntent(intent)) {
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
      public: publicContext,
      phone,
      platform: 'whatsapp',
      entities: classification.entities,
    };

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
