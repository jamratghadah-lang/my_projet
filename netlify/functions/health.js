// netlify/functions/health.js
//
// نقطة فحص صحّة عامة (لا تتطلب تسجيل دخول).
// تُرجع حالة الخدمة واتصال Firebase واستهلاك الذاكرة.
// تُستخدم لمراقبة النظام أو من load balancer / uptime checker.

const { getAdminApp } = require("./_auth");

function corsHeaders(event) {
  const origin = String(event.headers?.origin || event.headers?.Origin || "");
  const allowed = process.env.ALLOWED_ORIGIN || "https://jamratghadah.com";
  return {
    "Access-Control-Allow-Origin": origin && origin === allowed ? origin : allowed,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

exports.handler = async (event) => {
  // معالجة طلبات CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders(event), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    // فحص اتصال Firebase Firestore
    let firebaseStatus = "error";
    try {
      const admin = getAdminApp();
      if (admin) {
        await admin.firestore().collection("_health_check").limit(1).get();
        firebaseStatus = "connected";
      } else {
        firebaseStatus = "error";
      }
    } catch (e) {
      firebaseStatus = "error";
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        firebase: firebaseStatus,
      }),
    };
  } catch (err) {
    return {
      statusCode: 503,
      headers: corsHeaders(event),
      body: JSON.stringify({
        status: "error",
        error: 'error',
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
