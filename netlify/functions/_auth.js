// netlify/functions/_auth.js
//
// Shared auth helpers for Netlify functions requiring admin privileges.
// Verifies Firebase ID Token sent via Authorization: Bearer <token>
// and returns the user's uid, or null if the token is invalid/missing.
//
// Purpose: prevent anyone outside the dashboard from calling bulk send
// functions (send-whatsapp / send-sms / send-report-now / send-bulk) and abusing them.

let _adminApp = null;
function getAdminApp() {
  if (_adminApp) return _adminApp;
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      console.error("[auth] FIREBASE_SERVICE_ACCOUNT_JSON env var is missing — admin SDK cannot initialize");
      return null;
    }
    try {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    } catch (err) {
      console.error("[auth] Failed to initialize Firebase Admin SDK:", err.message);
      return null;
    }
  }
  _adminApp = admin;
  return admin;
}

async function verifyAuth(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const admin = getAdminApp();
    if (!admin) return null;
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid || null;
  } catch {
    return null;
  }
}

/**
 * Verifies the caller is an admin or super_admin.
 *
 * 1. Decodes the Firebase ID token.
 * 2. Checks custom claims (`token.role`) for 'admin' or 'super_admin'.
 * 3. If no custom claims are set, falls back to reading the user's doc
 *    from the `users` collection in Firestore.
 *
 * Returns { uid, role, email } or null if unauthorized.
 */
async function requireAdmin(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;

  try {
    const admin = getAdminApp();
    if (!admin) return null;
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const email = decoded.email || null;

    // Check custom claims first (preferred path)
    const claimRole = decoded.role;
    if (claimRole === 'admin' || claimRole === 'super_admin') {
      return { uid, role: claimRole, email };
    }

    // Fallback: check users collection in Firestore
    try {
      const userDoc = await admin.firestore().collection('users').doc(uid).get();
      if (userDoc.exists) {
        const userRole = userDoc.data().role;
        if (userRole === 'admin' || userRole === 'super_admin') {
          return { uid, role: userRole, email };
        }
      }
    } catch (err) {
      console.error("[auth] Failed to look up user role from Firestore:", err.message);
    }

    return null;
  } catch {
    return null;
  }
}

// Constant-time string comparison to prevent timing attacks
// Used instead of `===` when comparing user-supplied secrets against stored values
function safeEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  const crypto = require("crypto");
  try {
    return crypto.timingSafeEqual(Buffer.from(sa), Buffer.from(sb));
  } catch {
    return false;
  }
}

module.exports = { verifyAuth, requireAdmin, safeEqual, getAdminApp };
