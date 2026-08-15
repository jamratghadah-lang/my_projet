// netlify/functions/backup-restore.js
//
// Firestore backup export and restore.
// Requires admin authentication (Firebase ID Token with admin/super_admin role).
//
// Usage via ?action=:
//   create  — exports specified collections as JSON, saves metadata in `backups`.
//   restore — restores data from a backup (batch writes).
//   list    — lists previous backups.

const admin = require("firebase-admin");
const { requireAdmin } = require("./_auth");

const DEFAULT_COLLECTIONS = ["responses", "events", "couples", "guests", "settings", "send_logs", "operation_logs", "scheduled_messages"];

// Whitelisted collections allowed during restore — prevents writing to arbitrary collections
const RESTORE_ALLOWED_COLLECTIONS = new Set([
  "responses", "events", "couples", "guests", "settings",
  "send_logs", "operation_logs", "scheduled_messages",
  "templates", "guest_wall", "checkins", "ai_knowledge",
]);

// PII fields to strip from backup response data
const PII_FIELDS = new Set(["phone", "email"]);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function corsHeaders(event) {
  const origin = event.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  } else {
    // No CORS header if origin doesn't match — Same-origin or server-to-server only
    headers["Access-Control-Allow-Origin"] = "null";
  }
  return headers;
}

// Simple in-memory rate limiter: 3 requests per uid per 5 minutes
const _rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 3;

function checkRateLimit(uid) {
  const now = Date.now();
  const entry = _rateLimitMap.get(uid);
  if (!entry || now - entry.ts > RATE_LIMIT_WINDOW) {
    _rateLimitMap.set(uid, { ts: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

/**
 * Strips PII fields from a single document object.
 */
function stripPII(doc) {
  const clean = { id: doc.id };
  for (const [key, val] of Object.entries(doc)) {
    if (key === "id") continue;
    clean[key] = PII_FIELDS.has(key) ? "[REDACTED]" : val;
  }
  return clean;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // Verify admin privileges
  const adminUser = await requireAdmin(event);
  if (!adminUser) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "غير مصرح — صلاحية إدارية مطلوبة" }) };
  }

  const { uid } = adminUser;

  // Rate limiting
  if (!checkRateLimit(uid)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "طلبات كثيرة جدًا — حاولي بعد 5 دقائق" }) };
  }

  const db = admin.firestore();
  const action = (event.queryStringParameters && event.queryStringParameters.action) || "";

  try {
    // ===================== action=create =====================
    if (action === "create") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
      }

      const collections = Array.isArray(body.collections) && body.collections.length > 0
        ? body.collections
        : DEFAULT_COLLECTIONS;

      const data = {};
      const collectionsInfo = [];

      for (const colName of collections) {
        try {
          const snapshot = await db.collection(colName).get();
          const docs = [];
          snapshot.forEach((doc) => {
            docs.push(stripPII({ id: doc.id, ...doc.data() }));
          });
          data[colName] = docs;
          collectionsInfo.push({ name: colName, count: docs.length });
        } catch (e) {
          data[colName] = [];
          collectionsInfo.push({ name: colName, count: 0, error: String(e) });
        }
      }

      const backupObj = { data, createdAt: new Date().toISOString() };
      const jsonStr = JSON.stringify(backupObj);
      const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

      // Save metadata to backups collection
      try {
        await db.collection("backups").add({
          fileName,
          size: jsonStr.length,
          collections: collectionsInfo,
          createdBy: uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        // Non-fatal: don't stop the operation if metadata save fails
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          fileName,
          size: jsonStr.length,
          collections: collectionsInfo,
          data,
          createdAt: backupObj.createdAt,
        }),
      };
    }

    // ===================== action=restore =====================
    if (action === "restore") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
      }

      const backupData = body.data;
      const restoreCollections = Array.isArray(body.collections) && body.collections.length > 0
        ? body.collections
        : Object.keys(backupData || {});

      if (!backupData || typeof backupData !== "object") {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "بيانات النسخة الاحتياطية مطلوبة (data)" }) };
      }

      // Validate collection names against whitelist
      const disallowed = restoreCollections.filter((c) => !RESTORE_ALLOWED_COLLECTIONS.has(c));
      if (disallowed.length > 0) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "مجموعات غير مسموح باستعادتها: " + disallowed.join(", ") }) };
      }

      let totalRestored = 0;

      for (const colName of restoreCollections) {
        const docs = backupData[colName];
        if (!Array.isArray(docs)) continue;

        // Batch writes — max 500 per batch
        let batch = db.batch();
        let batchCount = 0;

        for (const doc of docs) {
          const docRef = db.collection(colName).doc(doc.id);
          const { id, ...docData } = doc;
          batch.set(docRef, docData, { merge: true });
          batchCount++;
          totalRestored++;

          if (batchCount >= 500) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }

        if (batchCount > 0) {
          await batch.commit();
        }
      }

      // Log the operation in operation_logs
      try {
        await db.collection("operation_logs").add({
          type: "backup_restore",
          collections: restoreCollections,
          restored: totalRestored,
          performedBy: uid,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        // Non-fatal
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ restored: totalRestored }),
      };
    }

    // ===================== action=list =====================
    if (action === "list") {
      const snapshot = await db.collection("backups").orderBy("createdAt", "desc").limit(50).get();
      const backups = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        backups.push({
          id: doc.id,
          fileName: d.fileName,
          size: d.size,
          collections: d.collections,
          createdBy: d.createdBy,
          createdAt: d.createdAt ? (d.createdAt.toDate ? d.createdAt.toDate().toISOString() : d.createdAt) : null,
        });
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(backups),
      };
    }

    // Unknown action
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'action غير معروف — استخدمي ?action=create أو ?action=restore أو ?action=list' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
