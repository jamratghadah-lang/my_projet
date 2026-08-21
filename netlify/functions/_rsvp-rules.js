// netlify/functions/_rsvp-rules.js
//
// مصدر واحد موثوق لقواعد "المرافقين" (وأي قواعد تصميم أخرى مستقبلًا) —
// نفس الملف اللي تتحكم فيه العميلة من لوحة الإدارة (content/rsvp/{slug}.json).
// submit-rsvp.js (مسار الموقع) و _ai-lib.js (مسار واتساب) يستوردان من هنا
// بدل ما كل واحد يعرّف نسخته الخاصة — عشان مستحيل يصير فرق بين القناتين.

const fs = require("fs");
const path = require("path");

const rulesCache = new Map();

function loadDesignRules(slug) {
  const safeSlug = String(slug || "").replace(/[^a-z0-9-]/gi, "");
  if (!safeSlug) return null;
  if (rulesCache.has(safeSlug)) return rulesCache.get(safeSlug);
  try {
    const filePath = path.join(__dirname, "..", "..", "content", "rsvp", `${safeSlug}.json`);
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    const ff = data.form_fields || {};
    rulesCache.set(safeSlug, ff);
    return ff;
  } catch {
    rulesCache.set(safeSlug, null);
    return null;
  }
}

// يطبّق قواعد المرافقين (مفعّل/مخفي، ثابت، أو نطاق) على الرقم القادم من العميل
function enforceCompanions(rawCompanions, formFields) {
  const requested = Math.max(0, Math.min(20, Number(rawCompanions || 0) || 0));
  if (!formFields) return requested; // ما فيه ملف تصميم معروف: نبقي السلوك القديم

  if (formFields.guests_count === "off") return 0;

  const mode = formFields.guests_mode || "range";
  if (mode === "fixed") {
    const fixed = parseInt(formFields.guests_fixed_count, 10) || 1;
    return fixed;
  }

  const min = Math.max(1, parseInt(formFields.guests_min, 10) || 1);
  const max = Math.max(min, parseInt(formFields.guests_max, 10) || 4);
  return Math.min(Math.max(requested, min), max);
}

module.exports = { loadDesignRules, enforceCompanions };
