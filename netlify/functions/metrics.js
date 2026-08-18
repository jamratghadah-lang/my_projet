// netlify/functions/metrics.js
//
// Metrics endpoint — requires admin authentication.
// Returns event, message, AI statistics and live connection status for each service.
// Results are cached for 30 seconds to reduce load on external services.

const { requireAdmin, getAdminApp } = require("./_auth");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function corsHeaders(event) {
  const origin = event.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  } else {
    headers["Access-Control-Allow-Origin"] = "null";
  }
  return headers;
}

// 30-second cache
let _cache = { data: null, ts: 0 };
const CACHE_TTL = 30 * 1000;

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // Verify admin privileges
  const adminUser = await requireAdmin(event);
  if (!adminUser) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: "غير مصرّح — صلاحية إدارية مطلوبة" }),
    };
  }

  // Return cached results if still valid
  const now = Date.now();
  if (_cache.data && now - _cache.ts < CACHE_TTL) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(_cache.data),
    };
  }

  const admin = getAdminApp();
  const result = {
    timestamp: new Date().toISOString(),
    events: { active: 0, closed: 0 },
    messages: { sentToday: 0, sentThisWeek: 0, successRate: null, totalSent: 0, totalFailed: 0 },
    ai: { usageCount: 0, errorCount: 0 },
    connections: { firebase: "unknown", whatsapp: "unknown", gemini: "unknown", resend: "unknown" },
  };

  // ===== 1) Event statistics =====
  try {
    if (admin) {
      const fs = admin.firestore();

      // Active events
      const activeSnap = await fs.collection("events").where("status", "==", "active").get();
      result.events.active = activeSnap.size;

      // Closed events
      const closedSnap = await fs.collection("events").where("status", "==", "closed").get();
      result.events.closed = closedSnap.size;

      // ===== 2) Message statistics =====
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
      weekStart.setHours(0, 0, 0, 0);

      // Messages sent today
      const todaySnap = await fs.collection("send_logs")
        .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(todayStart))
        .get();
      result.messages.sentToday = todaySnap.size;

      // Messages sent this week
      const weekSnap = await fs.collection("send_logs")
        .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(weekStart))
        .get();
      result.messages.sentThisWeek = weekSnap.size;

      // Success rate (all messages)
      const allLogsSnap = await fs.collection("send_logs").get();
      let totalSent = 0;
      let totalFailed = 0;
      allLogsSnap.forEach((doc) => {
        const d = doc.data();
        if (d.status === "sent" || d.status === "delivered") {
          totalSent++;
        } else if (d.status === "failed") {
          totalFailed++;
        }
      });
      result.messages.totalSent = totalSent;
      result.messages.totalFailed = totalFailed;
      const total = totalSent + totalFailed;
      result.messages.successRate = total > 0 ? Math.round((totalSent / total) * 100) : null;

      // ===== 3) AI statistics =====
      try {
        const aiSnap = await fs.collection("ai_analytics").get();
        let usageCount = 0;
        let errorCount = 0;
        aiSnap.forEach((doc) => {
          const d = doc.data();
          if (d.error === true) {
            errorCount++;
          } else {
            usageCount++;
          }
        });
        result.ai.usageCount = usageCount;
        result.ai.errorCount = errorCount;
      } catch (e) {
        console.error("ai_analytics read error:", e.message);
      }

      // ===== 4) Connection status — Firebase =====
      try {
        await fs.collection("_health_check").limit(1).get();
        result.connections.firebase = "connected";
      } catch (e) {
        result.connections.firebase = "error";
      }

      // ===== 5) Connection status — WhatsApp =====
      try {
        let waPhoneId = process.env.WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
        let waToken = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;

        if (!waPhoneId || !waToken) {
          try {
            const waConfig = await fs.collection("integration_configs").doc("whatsapp").get();
            if (waConfig.exists) {
              const waData = waConfig.data();
              if (!waPhoneId) waPhoneId = waData.phoneNumberId;
              if (!waToken) waToken = waData.accessToken;
            }
          } catch (_) {
            // ignore
          }
        }

        if (waPhoneId && waToken) {
          const waRes = await fetch(
            `https://graph.facebook.com/v21.0/${waPhoneId}`,
            {
              headers: { Authorization: `Bearer ${waToken}` },
            }
          );
          result.connections.whatsapp = waRes.ok ? "connected" : "error";
        } else {
          result.connections.whatsapp = "not_configured";
        }
      } catch (e) {
        result.connections.whatsapp = "error";
      }

      // ===== 6) Connection status — Gemini =====
      try {
        let geminiKey = process.env.GEMINI_API_KEY;

        if (!geminiKey) {
          try {
            const gemConfig = await fs.collection("integration_configs").doc("gemini").get();
            if (gemConfig.exists) {
              const gemData = gemConfig.data();
              if (!geminiKey) geminiKey = gemData.apiKey;
            }
          } catch (_) {
            // ignore
          }
        }

        if (geminiKey) {
          const gemRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`
          );
          result.connections.gemini = gemRes.ok ? "connected" : "error";
        } else {
          result.connections.gemini = "not_configured";
        }
      } catch (e) {
        result.connections.gemini = "error";
      }

      // ===== 7) Connection status — Resend (البريد الفعلي في الموقع) =====
      try {
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          const resendRes = await fetch("https://api.resend.com/domains", {
            headers: { Authorization: `Bearer ${resendKey}` },
          });
          result.connections.resend = resendRes.ok ? "connected" : "error";
        } else {
          result.connections.resend = "not_configured";
        }
      } catch (e) {
        result.connections.resend = "error";
      }
    } else {
      result.connections.firebase = "error";
    }
  } catch (err) {
    result.error = String(err);
  }

  // Cache results
  _cache = { data: result, ts: Date.now() };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result),
  };
};
