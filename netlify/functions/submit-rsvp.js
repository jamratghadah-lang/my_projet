const crypto = require("crypto");
const { getAdminApp } = require("./_auth");

const ENTRY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateEntryCode() {
  const bytes = crypto.randomBytes(8);
  let code = "JG-";
  for (let i = 0; i < 8; i++) code += ENTRY_CHARS[bytes[i] % ENTRY_CHARS.length];
  return code;
}

function verifyToken(token) {
  const secret = process.env.RSVP_TOKEN_SECRET || process.env.EMAIL_RSVP_SECRET;
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || !payload.slug) return null;
    return payload;
  } catch {
    return null;
  }
}

function clean(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

exports.verifyRsvpToken = verifyToken;

async function handle(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { Allow: "POST" }, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const tokenData = verifyToken(body.token);
    if (!tokenData) {
      return { statusCode: 403, body: JSON.stringify({ error: "RSVP token invalid" }) };
    }

    const status = body.status === "yes" || body.status === "no" ? body.status : null;
    if (!status) return { statusCode: 400, body: JSON.stringify({ error: "Invalid status" }) };

    const admin = getAdminApp();
    if (!admin) return { statusCode: 503, body: JSON.stringify({ error: "Service unavailable" }) };
    const db = admin.firestore();

    const eventCode = clean(body.eventCode, 120);
    const guestCode = clean(body.guestId, 120);
    if ((tokenData.eventCode || "") !== eventCode || (tokenData.guestCode || "") !== guestCode) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invitation identity mismatch" }) };
    }

    if (!eventCode || !guestCode) return { statusCode: 400, body: JSON.stringify({ error: "Missing invitation identity" }) };
    const responseId = `${eventCode}_${guestCode}`;

    const responseData = {
      name: clean(body.name, 180),
      phone: clean(body.phone, 30),
      status,
      guests: clean(body.guests, 10),
      style: tokenData.slug,
      eventSlug: tokenData.slug,
      personalCode: guestCode,
      guestId: guestCode,
      eventCode,
      companions: Math.max(0, Math.min(20, Number(body.companions || 0) || 0)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = db.collection("responses").doc(responseId);
    let finalEntryCode = "";
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      finalEntryCode = existing.exists && existing.data().entryCode
        ? String(existing.data().entryCode).toUpperCase()
        : generateEntryCode();
      responseData.entryCode = finalEntryCode;
      if (!existing.exists) responseData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      if (existing.exists && existing.data().qrRevoked === true) responseData.qrRevoked = true;
      tx.set(ref, responseData, { merge: true });
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ success: true, status, entryCode: finalEntryCode }),
    };
  } catch (err) {
    console.error("[submit-rsvp] error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Unable to save RSVP" }) };
  }
};


const ALLOWED_ORIGINS = new Set(["https://jamratghadah.com", "https://admin.jamratghadah.com"]);
exports.handler = async (event) => {
  const origin = String(event.headers?.origin || "").toLowerCase();
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://jamratghadah.com",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  const result = await handle(event);
  return { ...result, headers: { ...headers, ...(result.headers || {}) } };
};
