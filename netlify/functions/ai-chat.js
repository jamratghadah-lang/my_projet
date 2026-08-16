// netlify/functions/ai-chat.js
//
// واجهة المحادثة الذكية للموقع (Chat Widget API).
// يعمل في الوضع العام فقط (بدون بيانات ضيف).
//
// GET  → حالة التفعيل (للويجت)
// POST → معالجة رسالة المستخدم
//
// متغيرات البيئة المطلوبة:
//   GEMINI_API_KEY               — مفتاح Google Gemini
//   FIREBASE_SERVICE_ACCOUNT_JSON — مفتاح خدمة Firebase

const {
  classifyIntent,
  buildPublicContext,
  generateResponse,
  checkAIRateLimit,
  logConversation,
  trackAnalytics,
  sanitizeForAI,
  isAIEnabled,
} = require('./_ai-lib');

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://jamratghadah.com',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * Get client IP from Netlify event headers.
 */
function getClientIp(event) {
  const h = event.headers || {};
  const fwd = h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

/**
 * Handler — entry point for Netlify Function.
 */
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // ─── GET: Status Check ───
  if (event.httpMethod === 'GET') {
    return handleGet();
  }

  // ─── POST: Chat Message ───
  if (event.httpMethod === 'POST') {
    return handlePost(event);
  }

  return {
    statusCode: 405,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Method Not Allowed' }),
  };
};

// ============================================================
//  GET HANDLER — Status Check
// ============================================================

async function handleGet() {
  let enabled = true;
  enabled = await isAIEnabled('web');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ok', enabled }),
  };
}

// ============================================================
//  POST HANDLER — Chat Message
// ============================================================

async function handlePost(event) {
  const ip = getClientIp(event);

  // 1. Parse request body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const { message } = payload;
  if (!message || !String(message).trim()) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Message is required' }),
    };
  }

  const userMessage = String(message).slice(0, 2000).trim();

  // 2. Check rate limit (30 msgs/hour per IP)
  const rlKey = `web:${ip}`;
  const rl = await checkAIRateLimit(rlKey, 30, 60);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'طلبات كثيرة. حاول بعد شوي 🌹',
        retryAfter: Math.ceil((rl.resetAt - Date.now()) / 60000),
      }),
    };
  }

  // 3. Check if AI is enabled for web
  const enabled = await isAIEnabled('web');
  if (!enabled) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reply: 'شكراً لتواصلكم مع جمرة غضى 🌹\nحالياً المحادثة الذكية مو متوفرة. تواصلوا معنا عبر الواتساب أو نموذج التواصل.',
        intent: 'DISABLED',
      }),
    };
  }

  // 4. Classify intent
  const classification = await classifyIntent(userMessage);
  const intent = classification.intent;

  // 5. Build public context only (no guest data in web mode)
  const publicContext = await buildPublicContext();

  const fullContext = {
    public: publicContext,
    platform: 'web',
    entities: classification.entities,
    phone: null,
  };

  // 6. If guest intent in web mode, redirect to helpful response
  let effectiveIntent = intent;
  const guestIntents = [
    'EVENT_INFO', 'GUEST_INFO', 'RESEND_INVITATION',
    'SEND_LOCATION', 'GET_RSVP_STATUS', 'UPDATE_RSVP', 'UPDATE_GUEST_COUNT',
    'CLIENT_STATS',
  ];
  if (guestIntents.includes(intent)) {
    effectiveIntent = 'PUBLIC_INFO';
  }

  // 7. Generate response
  let responseText = '';
  let action = effectiveIntent;
  let actionResult = null;
  let tokensUsed = 0;

  try {
    const result = await generateResponse(effectiveIntent, fullContext, userMessage);
    responseText = result.text;
    action = result.action;
    actionResult = result.actionResult;
    tokensUsed = result.tokensUsed;

    // If the effective intent was changed from guest to public,
    // prepend a helpful message about using WhatsApp for guest services
    if (effectiveIntent !== intent) {
      responseText =
        'خدمة الاستعلام عن الدعوات متوفرة على الواتساب فقط 📱\n\n' +
        'أرسل رسالة على واتسابنا وبياناتك تطلع تلقائياً 💛\n\n' +
        'لكن أقدر أساعدك في:';
    }
  } catch (err) {
    console.error('[AI Chat] Response generation error:', err.message);
    responseText = 'عذراً، حصل خطأ مؤقت. حاول بعد شوي 🌹';
  }

  // 8. Log conversation
  await logConversation({
    platform: 'web',
    userMessage,
    assistantResponse: responseText,
    intent: effectiveIntent,
    action,
    tokensUsed,
  });

  // 9. Track analytics
  await trackAnalytics({
    intent: effectiveIntent,
    platform: 'web',
    tokensUsed,
    guestMatched: false,
  });

  // 10. Return response
  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reply: responseText,
      intent: effectiveIntent,
      tokensUsed,
    }),
  };
}
