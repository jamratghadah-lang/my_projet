// Secure RSVP configuration endpoint.
// Public invitation configuration is returned only after the server verifies
// the invitation access code. The access code itself is never stored in the
// public content/rsvp/*.json files.
const fs = require("fs");
const path = require("path");
const { safeEqual } = require("./_auth");
const { getInvitationAccessCode } = require("./_invitation-access");
const { getAdminApp } = require("./_auth");
const { checkRateLimit } = require("./_rate-limit");
const crypto = require("crypto");

function makeRsvpToken(payload) {
  const secret = process.env.RSVP_TOKEN_SECRET || process.env.EMAIL_RSVP_SECRET;
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function cleanSlug(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: { Allow: "GET" }, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const qs = event.queryStringParameters || {};
  const slug = cleanSlug(qs.slug);
  const suppliedCode = String(qs.code || "").trim();
  const eventCode = String(qs.eid || "").trim().slice(0, 120);
  const guestCode = String(qs.g || "").trim().slice(0, 120);

  if (!slug) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing slug" }) };
  }

  const app = getAdminApp();
  if (!app || !process.env.RSVP_TOKEN_SECRET) {
    return { statusCode: 503, headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Service unavailable" }) };
  }
  const db = app.firestore();
  const rl = await checkRateLimit(() => db, event, `invitation-data_${slug}`, { max: 10, windowSeconds: 60 });
  if (!rl.allowed) {
    return { statusCode: 429, headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Too many requests" }) };
  }

  const filePath = path.join(process.cwd(), "content", "rsvp", `${slug}.json`);
  if (!fs.existsSync(filePath)) {
    return { statusCode: 404, body: JSON.stringify({ error: "Invitation not found" }) };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const accessCode = getInvitationAccessCode(slug);
    if (!accessCode) {
      return { statusCode: 503, headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Invitation configuration unavailable" }) };
    }

    if (!eventCode || !guestCode) {
      return { statusCode: 400, headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Invitation identity required" }) };
    }
    const eventSnap = await db.collection("events").doc(eventCode).get();
    const guestSnap = await db.collection("responses").doc(`${eventCode}_${guestCode}`).get();
    if (!eventSnap.exists || !guestSnap.exists) {
      return { statusCode: 404, headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Invitation not found" }) };
    }

    if (accessCode) {
      if (!suppliedCode || !safeEqual(suppliedCode, accessCode)) {
        return {
          statusCode: 403,
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({ protected: true, error: "Invitation access denied" }),
        };
      }
    }

    const rsvpToken = makeRsvpToken({
      slug,
      eventCode,
      guestCode,
    });
    if (rsvpToken) data.rsvp_token = rsvpToken;

    // Defensive removal in case a legacy file still contains access_code.
    delete data.access_code;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("[invitation-data] error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Unable to load invitation" }) };
  }
};
