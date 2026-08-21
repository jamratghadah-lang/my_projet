const { getAdminApp } = require('./_auth');
const { checkRateLimit } = require('./_rate-limit');

const ALLOWED_ORIGINS = new Set(['https://jamratghadah.com', 'https://admin.jamratghadah.com']);
function headers(event) {
  const origin = String(event.headers?.origin || '').toLowerCase();
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://jamratghadah.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
}
function json(statusCode, h, body) { return { statusCode, headers: h, body: JSON.stringify(body) }; }
function validSlug(slug) { return /^[A-Za-z0-9_-]{1,128}$/.test(slug); }
// eventCode = معرّف مستند حقيقي بمجموعة "events" (Firestore auto-id) —
// نفس صيغة validSlug تكفي للتحقق منه.
function validEventCode(v) { return /^[A-Za-z0-9_-]{1,128}$/.test(v); }

exports.handler = async (event) => {
  const h = headers(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: h, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, h, { error: 'Method Not Allowed' });

  const app = getAdminApp();
  if (!app) return json(503, h, { error: 'Database unavailable' });
  const db = app.firestore();

  try {
    const requestSlug = event.httpMethod === 'GET'
      ? String(event.queryStringParameters?.slug || '').trim()
      : (() => { try { return String(JSON.parse(event.body || '{}').slug || '').trim(); } catch { return ''; } })();
    if (!validSlug(requestSlug)) return json(400, h, { error: 'Invalid slug' });

    // eventCode (اختياري) = المعرّف الحقيقي للمناسبة (من couples/{slug}.eventCode
    // اللي يبعته الفرونت). لو موجود وصحيح، نستخدمه هو الفلتر الرئيسي بدل
    // slug (اسم القالب المشترك بين عدة مناسبات) — عشان ما تختلط تعليقات
    // مناسبتين تستخدمن نفس القالب.
    const requestEventCode = event.httpMethod === 'GET'
      ? String(event.queryStringParameters?.eventCode || '').trim()
      : (() => { try { return String(JSON.parse(event.body || '{}').eventCode || '').trim(); } catch { return ''; } })();
    const hasEventCode = requestEventCode && validEventCode(requestEventCode);

    // Rate limit is per IP *and* per event (slug), enforced via Firestore so it
    // holds across all function instances — same shared mechanism used by
    // checkin.js / notify-rsvp.js / send-bulk.js, not a per-instance in-memory map.
    const rl = await checkRateLimit(() => db, event, `guest-wall_${requestSlug}`, { max: 5, windowSeconds: 60 });
    if (!rl.allowed) return json(429, h, { error: 'محاولات كثيرة، حاول لاحقًا' });

    if (event.httpMethod === 'GET') {
      const slug = requestSlug;
      const snap = hasEventCode
        ? await db.collection('guest_wall').where('eventCode', '==', requestEventCode).limit(50).get()
        : await db.collection('guest_wall').where('slug', '==', slug).limit(50).get();
      const docs = snap.docs.map(d => {
        const x = d.data() || {};
        return { name: String(x.name || '').slice(0, 120), message: String(x.message || '').slice(0, 2000), createdAt: x.createdAt?.toMillis?.() || 0 };
      }).sort((a,b) => b.createdAt - a.createdAt);
      return json(200, h, { items: docs });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, h, { error: 'Invalid JSON' }); }
    const slug = String(body.slug || '').trim();
    const name = String(body.name || '').trim();
    const message = String(body.message || '').trim();
    if (!validSlug(slug) || !name || name.length > 120 || !message || message.length > 2000) {
      return json(400, h, { error: 'بيانات الرسالة غير صالحة' });
    }
    // eventCode بالـ POST نفس منطق الـ GET: اختياري، ونتحقق من صيغته لو انبعث.
    const postEventCode = String(body.eventCode || '').trim();
    const hasPostEventCode = postEventCode && validEventCode(postEventCode);

    // The wall is intentionally server-mediated. Only accept fields needed by the public UI.
    await db.collection('guest_wall').add({
      slug,
      ...(hasPostEventCode ? { eventCode: postEventCode } : {}),
      name,
      message,
      createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
    });
    return json(201, h, { success: true });
  } catch (err) {
    console.error('[guest-wall]', err.message);
    return json(500, h, { error: 'تعذّر تنفيذ العملية' });
  }
};
