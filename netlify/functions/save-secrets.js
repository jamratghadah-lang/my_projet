// netlify/functions/save-secrets.js
//
// Bridges dashboard/integrations.html to the site's REAL Netlify environment
// variables (Site settings → Environment variables), which is what
// ai-webhook.js, send-whatsapp.js, send-bulk.js, event-reminder.js,
// message-scheduler.js, post-event-survey.js, video-scheduler.js and
// _ai-lib.js actually read from at runtime.
//
// Firestore (integration_configs) still stores the same values so the
// dashboard can display what was saved — but this function is what makes
// the sending functions actually work, in one save instead of two places.
//
// Body: { key: "whatsapp" | "msegat" | "unifonic" | "twilio" | "ai", fields: { ...formFieldId: value } }

const { requireAdmin } = require("./_auth");
const { setSiteEnvVars, triggerDeploy } = require("./_netlify-env");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function corsHeaders(event) {
  const origin = event.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  headers["Access-Control-Allow-Origin"] =
    ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null";
  return headers;
}

// Maps each dashboard card's form-field ids to the *actual* env var names
// read by the Netlify functions (confirmed by grepping process.env usage).
const ENV_FIELD_MAP = {
  whatsapp: {
    "wa-phoneId": "WHATSAPP_PHONE_ID",
    "wa-token": "WHATSAPP_TOKEN",
    "wa-verifyToken": "WHATSAPP_VERIFY_TOKEN",
    "wa-appSecret": "WHATSAPP_APP_SECRET",
  },
  msegat: {
    "msegat-username": "MSEGAT_USERNAME",
    "msegat-key": "MSEGAT_API_KEY",
    "msegat-sender": "MSEGAT_SENDER_NAME",
  },
  twilio: {
    "twilio-sid": "TWILIO_ACCOUNT_SID",
    "twilio-token": "TWILIO_AUTH_TOKEN",
    "twilio-from": "TWILIO_FROM_NUMBER",
  },
  unifonic: {
    "unifonic-appId": "UNIFONIC_APP_SID",
    "unifonic-senderId": "UNIFONIC_SENDER_ID",
  },
  // Dashboard card is still called "gemini" internally (Firestore doc id /
  // card id), even though it now actually configures Groq + Z.ai.
  gemini: {
    "ai-groqKey": "GROQ_API_KEY",
    "ai-zaiKey": "ZAI_API_KEY",
  },
};

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
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: "غير مصرّح — صلاحية إدارية مطلوبة" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON غير صالح" }) };
  }

  const { key, fields } = payload;
  const map = ENV_FIELD_MAP[key];
  if (!map) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `المفتاح "${key}" غير مدعوم للمزامنة مع متغيرات Netlify بعد`,
      }),
    };
  }

  // Translate dashboard field ids -> real env var names
  const envMap = {};
  for (const [fieldId, envName] of Object.entries(map)) {
    if (fields && Object.prototype.hasOwnProperty.call(fields, fieldId)) {
      envMap[envName] = fields[fieldId];
    }
  }

  if (Object.keys(envMap).length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "لا توجد قيم لحفظها" }),
    };
  }

  const { ok, results } = await setSiteEnvVars(envMap);
  if (!ok) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "تعذّر حفظ بعض المفاتيح في Netlify — تأكدي من NETLIFY_AUTH_TOKEN و NETLIFY_SITE_ID",
        results,
      }),
    };
  }

  // Functions only pick up new env vars on their next deploy, so trigger one.
  const deploy = await triggerDeploy();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      saved: Object.keys(envMap),
      deployTriggered: deploy.ok,
      deployError: deploy.ok ? undefined : deploy.error,
    }),
  };
};
