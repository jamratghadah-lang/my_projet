const { getAdminApp } = require("./_auth");

const ALLOWED_ORIGINS = ["https://jamratghadah.com", "https://admin.jamratghadah.com"];
function corsHeaders(event) {
  const origin = String(event.headers?.origin || "").toLowerCase();
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const eventId = String(event.queryStringParameters?.eventId || "").trim();
  if (!eventId || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid eventId" }) };
  }

  const app = getAdminApp();
  if (!app) return { statusCode: 503, headers, body: JSON.stringify({ error: "Database unavailable" }) };
  try {
    const db = app.firestore();
    const eventSnap = await db.collection("events").doc(eventId).get();
    if (!eventSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: "Event not found", qrEnabled: false }) };
    const ev = eventSnap.data() || {};
    const override = ev.qrOverride || "auto";
    if (override === "on") return { statusCode: 200, headers, body: JSON.stringify({ qrEnabled: true, source: "override" }) };
    if (override === "off") return { statusCode: 200, headers, body: JSON.stringify({ qrEnabled: false, source: "override" }) };

    const pkgSnap = await db.collection("ai_knowledge").doc("packages").get();
    const data = pkgSnap.exists ? pkgSnap.data() : {};
    const packages = Array.isArray(data.packages) ? data.packages : (Array.isArray(data.items) ? data.items : []);
    const pkg = packages.find((p) => {
      const id = String(p.id || p.key || p.slug || "").toLowerCase();
      const name = String(p.name || "").toLowerCase();
      return (ev.packageId && id === String(ev.packageId).toLowerCase()) ||
             (ev.packageName && name === String(ev.packageName).toLowerCase());
    });
    return { statusCode: 200, headers, body: JSON.stringify({ qrEnabled: !!(pkg && pkg.qrEnabled), source: "package" }) };
  } catch (err) {
    console.error("[qr-status]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Unable to resolve QR setting", qrEnabled: false }) };
  }
};
