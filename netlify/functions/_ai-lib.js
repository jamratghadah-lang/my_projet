// netlify/functions/_ai-lib.js
//
// المكتبة المشتركة لنظام الذكاء الاصطناعي في جمرة غضى.
// الدماغ الموحّد الذي تستخدمه ai-webhook.js و ai-chat.js.
//
// التصنيف: هجين (كلمات مفتاحية سريعة + LLM للغامض)
// البيانات: Firestore (ai_knowledge, responses, events)
// النموذج: مزوّدين مجانيين بالتوالي (Groq أولاً، Z.ai احتياطي) —
//           لو فشل الاثنين، يرجع خطأ يُمسك بمكانه ويعرض رسالة ودّية.
//   متغيرات البيئة المطلوبة:
//     GROQ_API_KEY  — من console.groq.com
//     ZAI_API_KEY   — من z.ai (لوحة API Keys)
// الرسائل: WhatsApp Business API v21

const { safeEqual, getAdminApp } = require("./_auth");
const admin = require("firebase-admin");
const crypto = require("crypto");
const https = require("https");
const { getInvitationAccessCode } = require("./_invitation-access");

// ============================================================
//  A. INTENT CLASSIFICATION
// ============================================================

const INTENTS = {
  // Public intents (no auth needed)
  PUBLIC_INFO: "PUBLIC_INFO",
  PACKAGE_LIST: "PACKAGE_LIST",
  PACKAGE_DETAILS: "PACKAGE_DETAILS",
  PACKAGE_COMPARE: "PACKAGE_COMPARE",
  PACKAGE_RECOMMEND: "PACKAGE_RECOMMEND",
  CONTACT_INFO: "CONTACT_INFO",
  SOCIAL_LINK: "SOCIAL_LINK",
  FAQ: "FAQ",
  HOW_TO_ORDER: "HOW_TO_ORDER",
  LEAD_CAPTURE: "LEAD_CAPTURE",
  HUMAN_HANDOFF: "HUMAN_HANDOFF",

  // Guest intents (require guest verification)
  EVENT_INFO: "EVENT_INFO",
  GUEST_INFO: "GUEST_INFO",
  RESEND_INVITATION: "RESEND_INVITATION",
  SEND_LOCATION: "SEND_LOCATION",
  GET_RSVP_STATUS: "GET_RSVP_STATUS",
  UPDATE_RSVP: "UPDATE_RSVP",
  UPDATE_GUEST_COUNT: "UPDATE_GUEST_COUNT",

  // Client intents (require client/owner verification — phone matches event.phone)
  CLIENT_STATS: "CLIENT_STATS",
  CLIENT_CANCEL_GUEST: "CLIENT_CANCEL_GUEST",
  CLIENT_RESTORE_GUEST: "CLIENT_RESTORE_GUEST",
  CLIENT_RESEND_TO_GUEST: "CLIENT_RESEND_TO_GUEST",
  CLIENT_BULK_ADD_GUESTS: "CLIENT_BULK_ADD_GUESTS",
};

// Keyword → intent mappings with weighted patterns
const KEYWORD_MAP = [
  {
    intent: "SEND_LOCATION",
    patterns: [
      /وين الزواج/i,
      /وين المناسبة/i,
      /أرسل اللوكيشن/i,
      /عطني موقع/i,
      /وين المكان/i,
      /موقع المناسبة/i,
      /لوكيشن الزواج/i,
      /أبغى الموقع/i,
      /خريطة/i,
      /خريطه/i,
      /كيف أوصل/i,
      /عنوان المناسبة/i,
      /عنوان الزواج/i,
      /أين مكان/i,
    ],
    weight: 0.95,
  },
  {
    intent: "RESEND_INVITATION",
    patterns: [
      /أرسل دعوتي/i,
      /نسيت دعوتي/i,
      /ضاع الرابط/i,
      /ما لقيت الدعوة/i,
      /أبغى رابط الدعوة/i,
      /أريد الدعوة/i,
      /إعادة إرسال الدعوة/i,
      /دعوتي وين/i,
      /رابط الدعوة/i,
      /أبي الرابط/i,
    ],
    weight: 0.92,
  },
  {
    intent: "GET_RSVP_STATUS",
    patterns: [
      /أنا مؤكد/i,
      /هل سجلت/i,
      /وش وضعي/i,
      /وش حال تسجيلي/i,
      /هل تم تأكيد/i,
      /أنا مسجل/i,
      /طلبي مؤكد/i,
      /تم قبولي/i,
      /هل أنا مدعو/i,
      /وضعي بالدعوة/i,
    ],
    weight: 0.90,
  },
  {
    intent: "UPDATE_RSVP",
    patterns: [
      /ما أقدر أحضر/i,
      /ما راح أجي/i,
      /اعتذر/i,
      /ما بقدر أجي/i,
      /للأسف ما أقدر/i,
      /معليش ما أقدر/i,
      /سأعتذر/i,
      /أعتذر عن الحضور/i,
      /ما بجي/i,
      /ما أبي أجي/i,
    ],
    weight: 0.88,
  },
  {
    intent: "UPDATE_GUEST_COUNT",
    patterns: [
      /بجيب معي شخص/i,
      /أضيف مرافق/i,
      /بجيب معي (.+)/i,
      /أبي أضيف شخص/i,
      /عدد الأشخاص/i,
      /كثيرين/i,
      /فريق/i,
      /عائلتي/i,
      /طفل/i,
      /أطفال/i,
    ],
    weight: 0.82,
  },
  {
    intent: "PACKAGE_COMPARE",
    patterns: [
      /وش الفرق/i,
      /قارن/i,
      /مقارنة بين/i,
      /أي أفضل/i,
      /وش يميز/i,
      /الفرق بين/i,
      /ما الفرق/i,
    ],
    weight: 0.90,
  },
  {
    intent: "PACKAGE_RECOMMEND",
    patterns: [
      /أنسب باقة/i,
      /وش الباقة المناسبة/i,
      /أي باقة تناسب/i,
      /تنصحوني/i,
      /وش الباقة الأنسب/i,
      /وش تصير أحسن/i,
      /حسب ميزانيتي/i,
      /بما يناسب/i,
    ],
    weight: 0.88,
  },
  {
    intent: "PACKAGE_DETAILS",
    patterns: [
      /كم سعر/i,
      /وش يشتمل/i,
      /وش محتويات/i,
      /تفاصيل الباقة/i,
      /مميزات/i,
      /باقة\s*(برستيج|ليكس|مجستري|امبيريال|سوفران)/i,
      /الباقة\s*(الفضية|الذهبية|البرونزية)/i,
      /باقة\s*(Prestige|Lex|Majesty|Imperial|Sovereign|Royal|Silver|Gold|Bronze|VIP|Premium)/i,
    ],
    weight: 0.85,
  },
  {
    intent: "PACKAGE_LIST",
    patterns: [
      /وش الباقات/i,
      /كم الباقات/i,
      /أسعار الباقات/i,
      /قائمة الباقات/i,
      /كل الباقات/i,
      /الباقات المتوفرة/i,
      /عروضكم/i,
      /أسعار الدعوات/i,
    ],
    weight: 0.90,
  },
  {
    intent: "SOCIAL_LINK",
    patterns: [
      /انستقرام/i,
      /انستغرام/i,
      /تيك توك/i,
      /تيكتوك/i,
      /سناب/i,
      /سناب شات/i,
      /تويتر/i,
      /إكس/i,
      /اكس/i,
      /حسابكم على/i,
      /حساباتكم/i,
      /تابعوني/i,
    ],
    weight: 0.88,
  },
  {
    intent: "CONTACT_INFO",
    patterns: [
      /أتواصل/i,
      /أكلمكم/i,
      /واتسابكم/i,
      /رقمكم/i,
      /كيف أتواصل/i,
      /كيف أ reach/i,
      /أبي أتحدث معكم/i,
      /وسيلة تواصل/i,
      /أرقام التواصل/i,
    ],
    weight: 0.85,
  },
  {
    intent: "HOW_TO_ORDER",
    patterns: [
      /كيف أطلب/i,
      /طريقة الطلب/i,
      /خطوات الحجز/i,
      /كيف أحجز/i,
      /كيف أبدأ/i,
      /وش الخطوات/i,
      /إجراءات الطلب/i,
      /كيفية الطلب/i,
    ],
    weight: 0.88,
  },
  {
    intent: "LEAD_CAPTURE",
    patterns: [
      /أبي أحجز/i,
      /أبي أطلب دعوة/i,
      /أبغى أطلب/i,
      /أريد حجز/i,
      /أبي دعوة/i,
      /أبغى دعوة/i,
      /أبي أعمل دعوة/i,
      /أبغى أعمل دعوة/i,
      /حجز دعوة/i,
    ],
    weight: 0.85,
  },
  {
    intent: "HUMAN_HANDOFF",
    patterns: [
      /أبي موظف/i,
      /أبي شخص/i,
      /أبغى أتكلم مع/i,
      /أبي محادثة بشرية/i,
      /وصلني شخص/i,
      /أبي أحد يرد/i,
      /موظف خدمة/i,
      /خدمة العملاء/i,
      /أبي أتحدث لإنسان/i,
    ],
    weight: 0.88,
  },
  {
    intent: "EVENT_INFO",
    patterns: [
      /متى المناسبة/i,
      /متى الزواج/i,
      /موعد المناسبة/i,
      /موعد الزواج/i,
      /وقت المناسبة/i,
      /متى الحفل/i,
      /تاريخ الزواج/i,
      /تاريخ المناسبة/i,
      /موعد الدعوة/i,
    ],
    weight: 0.92,
  },
  {
    intent: "GUEST_INFO",
    patterns: [
      /وش وضعي/i,
      /مدعو أنا/i,
      /هل أنا بالقائمة/i,
      /بياناتي/i,
      /هل لي دعوة/i,
    ],
    weight: 0.80,
  },
  {
    intent: "CLIENT_STATS",
    patterns: [
      /كم (أكد|اكد|حضر|اعتذر|رد)/i,
      /كم (شخص|واحد|ضيف) (حضر|أكد|اكد)/i,
      /نسبة الحضور/i,
      /إحصائ(ية|يات)/i,
      /احصائ(ية|يات)/i,
      /تقرير (الحضور|المناسبة|الحفل)/i,
      /كم (باقي|متبقي)/i,
      /عدد (المؤكدين|المعتذرين|الحضور)/i,
      /وش الوضع (الحين|بالحفل|بالمناسبة)/i,
    ],
    weight: 0.85,
  },
  {
    intent: "CLIENT_CANCEL_GUEST",
    patterns: [
      /الغ[ىي] حضور/i,
      /ألغ[ىي] حضور/i,
      /احذف[ي]? .* من (القائمة|الضيوف)/i,
      /شيل[ي]? .* من (القائمة|الضيوف)/i,
      /اعتذار .* بدل/i,
    ],
    weight: 0.85,
  },
  {
    intent: "CLIENT_RESTORE_GUEST",
    patterns: [
      /رجّع[ي]? حضور/i,
      /رجعي حضور/i,
      /استرجع[ي]? حضور/i,
      /ألغ[ىي] الاعتذار/i,
      /الغ[ىي] الاعتذار/i,
    ],
    weight: 0.85,
  },
  {
    intent: "CLIENT_RESEND_TO_GUEST",
    patterns: [
      /ابعث[ي]? (فيديو|دعوة|تذكير) ل/i,
      /ارسل[ي]? (فيديو|دعوة|تذكير) ل/i,
      /بعثي (فيديو|دعوة|تذكير)/i,
      /رسلي (فيديو|دعوة|تذكير)/i,
    ],
    weight: 0.85,
  },
];

// Arabic text normalization
function normalizeArabic(text) {
  if (!text) return "";
  let s = String(text);
  // Remove tatweel (kashida)
  s = s.replace(/[\u0640]/g, "");
  // Normalize alef variants
  s = s.replace(/[\u0622\u0623\u0625]/g, "\u0627");
  // Normalize ya
  s = s.replace(/\u0649/g, "\u064A");
  // Normalize taa marbuta
  s = s.replace(/\u0629/g, "\u0647");
  return s.trim();
}

// Extract entities from message
function extractEntities(text) {
  const entities = {};
  // Extract numbers
  const numbers = text.match(/\d+/g);
  if (numbers) entities.numbers = numbers.map(Number);

  // Extract package name mentions
  const pkgPatterns = [
    /باقة\s+(\S+)/i,
    /الباقة\s+(\S+)/i,
    /الباقة ال(برونزية|فضية|ذهبية)/i,
  ];
  for (const p of pkgPatterns) {
    const m = text.match(p);
    if (m) {
      entities.packageName = m[1];
      break;
    }
  }

  // Check for comparison mentions (package A and B)
  const compMatch = text.match(/بين\s+(.+?)\s+و\s+(.+)/i);
  if (compMatch) {
    entities.packageA = compMatch[1].trim();
    entities.packageB = compMatch[2].trim();
  }

  // Extract guest count mentions
  const countMatch = text.match(/(\d+)\s*(شخص|أشخاص|ولد|بنت)/i);
  if (countMatch) entities.guestCount = parseInt(countMatch[1], 10);

  return entities;
}

async function classifyIntent(text) {
  const normalized = normalizeArabic(text);
  const entities = extractEntities(normalized);

  let bestIntent = "PUBLIC_INFO";
  let bestConfidence = 0;

  // Phase 1: Keyword/rule-based classification
  for (const entry of KEYWORD_MAP) {
    for (const pattern of entry.patterns) {
      if (pattern.test(normalized)) {
        const confidence = entry.weight;
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestIntent = entry.intent;
        }
        break; // One match per intent entry is enough
      }
    }
  }

  // Phase 2: If low confidence, use Gemini
  if (bestConfidence < 0.6) {
    try {
      const geminiResult = await classifyWithGemini(normalized);
      if (geminiResult && geminiResult.intent && geminiResult.confidence > bestConfidence) {
        bestIntent = geminiResult.intent;
        bestConfidence = geminiResult.confidence;
      }
    } catch (err) {
      console.error("[AI] Gemini fallback classification failed:", err.message);
    }
  }

  return { intent: bestIntent, confidence: bestConfidence, entities };
}

async function classifyWithGemini(text) {
  const intentList = Object.values(INTENTS).join(", ");
  const prompt =
    `صنّف الرسالة التالية إلى واحد من هذه النوايا: ${intentList}\n` +
    `أجب فقط بـ JSON: {"intent": "NAME", "confidence": 0.0-1.0}\n` +
    `الرسالة: ${text}`;

  const result = await callGemini(prompt, 100);
  if (!result.text) return null;

  try {
    // Extract JSON from response
    const jsonMatch = result.text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (INTENTS[parsed.intent]) {
      return { intent: parsed.intent, confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)) };
    }
  } catch {
    // Could not parse Gemini response
  }
  return null;
}

function isPublicIntent(intent) {
  return [
    "PUBLIC_INFO",
    "PACKAGE_LIST",
    "PACKAGE_DETAILS",
    "PACKAGE_COMPARE",
    "PACKAGE_RECOMMEND",
    "CONTACT_INFO",
    "SOCIAL_LINK",
    "FAQ",
    "HOW_TO_ORDER",
    "LEAD_CAPTURE",
    "HUMAN_HANDOFF",
  ].includes(intent);
}

function isGuestIntent(intent) {
  return [
    "EVENT_INFO",
    "GUEST_INFO",
    "RESEND_INVITATION",
    "SEND_LOCATION",
    "GET_RSVP_STATUS",
    "UPDATE_RSVP",
    "UPDATE_GUEST_COUNT",
  ].includes(intent);
}

function isClientIntent(intent) {
  return [
    "CLIENT_STATS",
    "CLIENT_CANCEL_GUEST",
    "CLIENT_RESTORE_GUEST",
    "CLIENT_RESEND_TO_GUEST",
  ].includes(intent);
}

/**
 * Extract a guest name from a client's free-text command, e.g.
 * "الغي حضور سارة" → "سارة". Best-effort regex, not full NLU —
 * if extraction fails, the caller should ask the client to clarify.
 */
/**
 * Detect a pasted guest list: 2+ lines, each containing a Saudi phone
 * number and/or an email — plus a name. Checked by *shape*, not
 * keywords. A line needs a name AND at least one contact method
 * (phone or email) to count.
 */
function parseGuestListText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const phoneRe = /(?:\+?966|0)?5\d{8}/;
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const entries = [];

  for (const line of lines) {
    const phoneMatch = line.match(phoneRe);
    const emailMatch = line.match(emailRe);
    if (!phoneMatch && !emailMatch) continue;

    let name = line;
    if (phoneMatch) name = name.replace(phoneMatch[0], "");
    if (emailMatch) name = name.replace(emailMatch[0], "");
    name = name.trim().replace(/^[-–,:]+|[-–,:]+$/g, "").trim();
    if (!name) continue;

    entries.push({
      name,
      phone: phoneMatch ? normalizePhone(phoneMatch[0]) : null,
      email: emailMatch ? emailMatch[0].toLowerCase() : null,
    });
  }

  // لازم سطرين على الأقل يطابقون الشكل، وإلا هذا نص عادي مو قائمة
  return entries.length >= 2 ? entries : null;
}

function extractGuestNameFromCommand(text) {
  const t = String(text || "").trim();
  const patterns = [
    /(?:الغ[ىي]|ألغ[ىي])\s*(?:حضور|اعتذار)?\s*(.+)/i,
    /(?:رجّع[ي]?|رجعي|استرجع[ي]?)\s*(?:حضور)?\s*(.+)/i,
    /(?:احذف[ي]?|شيل[ي]?)\s*(.+?)\s*من/i,
    /(?:ابعث[ي]?|ارسل[ي]?|بعثي|رسلي)\s*(?:فيديو|دعوة|تذكير)\s*ل\s*(.+)/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) return m[1].trim().replace(/[.!؟?]+$/, "");
  }
  return null;
}

/**
 * Find a single guest within the client's own event by (partial) name match.
 * Returns { matched: doc } | { ambiguous: [docs] } | { notFound: true }.
 * Never searches outside the given eventId — this is the security boundary.
 */
async function findGuestInEvent(db, eventId, nameQuery) {
  const snap = await db.collection("responses").where("eventCode", "==", eventId).get();
  const needle = normalizeArabic(nameQuery).toLowerCase();
  const matches = [];
  snap.forEach((doc) => {
    const name = normalizeArabic(doc.data().name || "").toLowerCase();
    if (name.includes(needle) || needle.includes(name)) matches.push(doc);
  });
  if (matches.length === 0) return { notFound: true };
  if (matches.length > 1) return { ambiguous: matches };
  return { matched: matches[0] };
}

// ============================================================
//  B. CONTEXT BUILDING
// ============================================================

// In-memory cache for public knowledge (5 min TTL)
let _publicContextCache = null;
let _publicContextCacheExpiry = 0;
const PUBLIC_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function buildPublicContext() {
  // Return cached if still valid
  if (_publicContextCache && Date.now() < _publicContextCacheExpiry) {
    return _publicContextCache;
  }

  const db = getDb();
  if (!db) return { packages: [], company: {}, contact: {}, faq: [], policies: {} };

  try {
    const docs = ["packages", "company", "contact", "faq", "policies"];
    const snaps = await Promise.all(docs.map((d) => db.collection("ai_knowledge").doc(d).get()));

    let packages = snaps[0].exists ? (snaps[0].data().packages || snaps[0].data().items || []) : [];

    // Compatibility fallback for a fresh deployment: if AI knowledge has not
    // been seeded yet, use the canonical public pricing file instead of stale
    // hard-coded package defaults. Once Firestore has packages, it is the
    // runtime source used by AI.
    if (!packages.length) {
      try {
        const fs = require("fs");
        const path = require("path");
        const pricingPath = path.join(process.cwd(), "content", "pricing.json");
        const pricing = JSON.parse(fs.readFileSync(pricingPath, "utf8"));
        packages = Array.isArray(pricing.packages) ? pricing.packages : [];
      } catch (pricingErr) {
        console.warn("[AI] pricing fallback unavailable:", pricingErr.message);
      }
    }

    const context = {
      packages,
      company: snaps[1].exists ? snaps[1].data() : {},
      contact: snaps[2].exists ? snaps[2].data() : {},
      faq: snaps[3].exists ? (snaps[3].data().items || []) : [],
      policies: snaps[4].exists ? snaps[4].data() : {},
    };

    _publicContextCache = context;
    _publicContextCacheExpiry = Date.now() + PUBLIC_CACHE_TTL;
    return context;
  } catch (err) {
    console.error("[AI] buildPublicContext error:", err.message);
    return { packages: [], company: {}, contact: {}, faq: [], policies: {} };
  }
}

// Event fields whitelist — NEVER send anything else
const EVENT_FIELDS_WHITELIST = [
  "name", "date", "time", "location", "venueAddress",
  "mapUrl", "dressCode", "parkingInfo", "notes", "faq",
  "packageId", "packageName", "qrOverride",
];

// Guest fields whitelist — NEVER send anything else
const GUEST_FIELDS_WHITELIST = [
  "name", "rsvpStatus", "guestCount", "plusOneAllowed", "invitationUrl",
];

function whitelistObject(obj, allowedFields) {
  const result = {};
  for (const key of allowedFields) {
    if (obj[key] !== undefined && obj[key] !== null) {
      result[key] = obj[key];
    }
  }
  return result;
}

async function buildGuestContext(phone, selectionIndex) {
  const db = getDb();
  if (!db) return null;

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 10) return null;

  try {
    // If a specific selection index is provided, resolve directly
    if (selectionIndex !== undefined && selectionIndex !== null) {
      return await resolveGuestByIndex(phone, selectionIndex, db);
    }

    // Find ALL guests with this phone (up to 10)
    const snapshot = await db
      .collection("responses")
      .where("phone", "==", normalizedPhone)
      .limit(10)
      .get();

    let allDocs = snapshot.docs.map((d) => d);

    // Also try with leading + if no results
    if (allDocs.length === 0) {
      const snapshot2 = await db
        .collection("responses")
        .where("phone", "==", "+" + normalizedPhone)
        .limit(10)
        .get();
      allDocs = snapshot2.docs.map((d) => d);
    }

    if (allDocs.length === 0) return null;

    // Multiple guests with same phone — disambiguation needed
    if (allDocs.length > 1) {
      return { _disambiguate: true, options: buildDisambiguationOptions(allDocs) };
    }

    // Single result — return enriched context
    return await enrichGuestContext(allDocs[0], db);
  } catch (err) {
    console.error("[AI] buildGuestContext error:", err.message);
    return null;
  }
}

/**
 * Build safe disambiguation options (no sensitive data leak).
 * Only exposes guest name and event name.
 */
function buildDisambiguationOptions(docs) {
  const options = [];
  for (let i = 0; i < docs.length; i++) {
    const data = docs[i].data();
    const eventName = data.eventName || data.eventCode || data.eventSlug || "مناسبة";
    const guestName = data.name || "ضيف";
    options.push({
      index: i + 1,
      guestName,
      eventName,
      _docId: docs[i].id,
      _eventCode: data.eventCode || data.eventSlug || null,
    });
  }
  return options;
}

/**
 * Resolve a specific guest by selection index after disambiguation.
 */
async function resolveGuestByIndex(phone, index, db) {
  const normalizedPhone = normalizePhone(phone);
  const phoneVariants = [normalizedPhone];
  if (!normalizedPhone.startsWith("+")) phoneVariants.push("+" + normalizedPhone);

  // Collect all matching docs
  let allDocs = [];
  const seen = new Set();
  for (const p of phoneVariants) {
    const snap = await db.collection("responses").where("phone", "==", p).limit(10).get();
    for (const doc of snap.docs) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        allDocs.push(doc);
      }
    }
  }

  if (index < 1 || index > allDocs.length) return null;
  return await enrichGuestContext(allDocs[index - 1], db);
}

/**
 * Format disambiguation message for WhatsApp.
 */
function formatDisambiguationMessage(options) {
  let msg = "عندك أكثر من دعوة مسجلة بهذا الرقم 🌹 أي مناسبة تقصد؟\n\n";
  for (const opt of options) {
    msg += `${opt.index}. ${opt.eventName} — ${opt.guestName}\n`;
  }
  msg += "\nأرسل رقم المناسبة (مثال: 1 أو 2)";
  return msg;
}

/**
 * Check if text is a valid selection number for disambiguation.
 * @returns {number|null} The selected index or null.
 */
function parseSelectionNumber(text, maxOptions) {
  const trimmed = text.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= maxOptions) return num;
  // Also check Arabic numerals
  const arabicNum = parseArabicNumber(trimmed);
  if (arabicNum !== null && arabicNum >= 1 && arabicNum <= maxOptions) return arabicNum;
  return null;
}

/**
 * Parse Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) to Western.
 */
function parseArabicNumber(str) {
  const map = { "٠": 0, "١": 1, "٢": 2, "٣": 3, "٤": 4, "٥": 5, "٦": 6, "٧": 7, "٨": 8, "٩": 9 };
  const digits = str.replace(/[٠-٩]/g, (c) => map[c] || c);
  const num = parseInt(digits, 10);
  return isNaN(num) ? null : num;
}

/**
 * Build client (event owner) stats context.
 * A "client" is verified ONLY by matching phone against events.phone —
 * never by guest self-declaration. Returns aggregate counts scoped
 * strictly to that single event; never crosses into other events'
 * guest lists or personal guest data beyond counts.
 */
async function buildClientStatsContext(phone) {
  const db = getDb();
  if (!db) return null;

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 10) return null;

  try {
    const phoneVariants = [normalizedPhone, "+" + normalizedPhone];
    let eventDoc = null;

    for (const p of phoneVariants) {
      const snap = await db.collection("events").where("phone", "==", p).limit(1).get();
      if (!snap.empty) {
        eventDoc = snap.docs[0];
        break;
      }
    }

    if (!eventDoc) return null; // not a recognized event owner — fall back to guest flow

    const eventData = eventDoc.data();
    const eventId = eventDoc.id;

    const responsesSnap = await db.collection("responses").where("eventCode", "==", eventId).get();

    let confirmed = 0, declined = 0, pending = 0, totalGuests = 0;
    responsesSnap.forEach((doc) => {
      const d = doc.data();
      const count = parseInt(String(d.guests || 1), 10) || 1;
      if (d.status === "confirmed" || d.status === "yes") { confirmed++; totalGuests += count; }
      else if (d.status === "declined" || d.status === "no") { declined++; }
      else { pending++; }
    });

    let attendedCount = 0;
    try {
      const checkinsSnap = await db.collection("checkins").where("eventId", "==", eventId).get();
      attendedCount = checkinsSnap.size;
    } catch {
      // checkins may not be readable/available; stats still return without it
    }

    return {
      isClient: true,
      eventId,
      eventName: eventData.name || eventData.client || "مناسبتك",
      eventDate: eventData.date || null,
      stats: {
        totalInvited: responsesSnap.size,
        confirmed,
        declined,
        pending,
        totalGuestsConfirmed: totalGuests,
        attendedSoFar: attendedCount,
      },
    };
  } catch (err) {
    console.error("[AI] buildClientStatsContext error:", err.message);
    return null;
  }
}

async function enrichGuestContext(guestDoc, db) {
  const guestData = guestDoc.data();
  const guest = whitelistObject(guestData, GUEST_FIELDS_WHITELIST);
  guest._id = guestDoc.id;
  guest._ref = guestDoc.ref.path;

  // Also map 'status' to 'rsvpStatus' for consistency
  if (!guest.rsvpStatus && guestData.status) {
    guest.rsvpStatus = guestData.status;
  }
  if (!guest.guestCount && guestData.guests) {
    guest.guestCount = parseInt(String(guestData.guests), 10) || 1;
  }
  if (!guest.plusOneAllowed && guestData.plusOneAllowed !== undefined) {
    guest.plusOneAllowed = guestData.plusOneAllowed;
  }

  // Build invitation URL server-side from the private access-code map.
  // Never expose access_code through the public RSVP JSON or AI context.
  if (!guest.invitationUrl && guestData.style) {
    const accessCode = getInvitationAccessCode(guestData.style);
    const baseUrl = "https://jamratghadah.com/rsvp/";
    if (accessCode) {
      guest.invitationUrl = `${baseUrl}${encodeURIComponent(guestData.style)}?code=${encodeURIComponent(accessCode)}`;
    } else if (guestData.eventSlug) {
      // Unprotected legacy template: keep a clean URL without inventing a code.
      guest.invitationUrl = `${baseUrl}${encodeURIComponent(guestData.style)}`;
    }
  }

  let event = null;
  // Try to find associated event
  const eventCode = guestData.eventCode || guestData.eventSlug;
  if (eventCode) {
    try {
      const eventSnap = await db.collection("events").doc(eventCode).get();
      if (eventSnap.exists) {
        const rawEvent = eventSnap.data();
        event = whitelistObject(rawEvent, EVENT_FIELDS_WHITELIST);
        const invitationDelivery = rawEvent && rawEvent.invitationDelivery;
        if (invitationDelivery && typeof invitationDelivery.videoUrl === "string" && invitationDelivery.videoUrl.startsWith("https://")) {
          event.invitationVideoUrl = invitationDelivery.videoUrl.slice(0, 1000);
        }
        event._id = eventSnap.id;
      }
    } catch {
      // Event not found, continue without it
    }
  }

  const privateData = {
    // Never place this inside the whitelisted guest object sent to Gemini.
    entryCode: guestData.entryCode || guestData.personalCode || "",
    phone: guestData.phone || "",
  };

  return { guest, event, private: privateData };
}

// ============================================================
//  C. TOOL EXECUTION
// ============================================================

async function getEffectiveQrEnabled(event) {
  if (!event) return false;
  const override = event.qrOverride || "auto";
  if (override === "on") return true;
  if (override === "off") return false;

  const db = getDb();
  if (!db) return false;
  try {
    const snap = await db.collection("ai_knowledge").doc("packages").get();
    const data = snap.exists ? snap.data() : {};
    const packages = Array.isArray(data.packages) ? data.packages : (Array.isArray(data.items) ? data.items : []);
    const pkg = packages.find((p) => {
      const id = String(p.id || p.key || p.slug || "").toLowerCase();
      const name = String(p.name || "").toLowerCase();
      return (event.packageId && id === String(event.packageId).toLowerCase()) ||
             (event.packageName && name === String(event.packageName).toLowerCase());
    });
    return !!(pkg && pkg.qrEnabled);
  } catch (err) {
    console.error("[AI] getEffectiveQrEnabled error:", err.message);
    return false;
  }
}

function buildQrImageUrl(eventId, entryCode) {
  const payload = JSON.stringify({ eventId: String(eventId || ""), entryCode: String(entryCode || "") });
  // Public image endpoint used only as a transportable QR renderer for WhatsApp.
  // The QR payload itself contains only the event identifier + the guest's personal entry code.
  return `https://quickchart.io/qr?size=600&margin=2&text=${encodeURIComponent(payload)}`;
}

const TOOLS = {
  get_event_info: async (params, context) => {
    if (!context.event) return { error: "ما لقيت بيانات المناسبة" };
    return context.event;
  },

  get_guest_info: async (params, context) => {
    if (!context.guest) return { error: "ما لقيت بيانات الضيف" };
    return {
      name: context.guest.name,
      rsvpStatus: context.guest.rsvpStatus,
      guestCount: context.guest.guestCount,
      plusOneAllowed: context.guest.plusOneAllowed,
    };
  },

  resend_invitation: async (params, context) => {
    const phone = params.phone;
    if (!phone) return { error: "رقم الجوال مطلوب" };
    if (!context.guest) return { error: "ما لقيت بيانات الضيف" };

    // WhatsApp invitation delivery must be the actual video media, not a text URL.
    const videoUrl = context.event && context.event.invitationVideoUrl;
    if (!videoUrl) {
      return { error: "ما لقيت فيديو الدعوة المخصص لهذي المناسبة" };
    }

    const caption = `سلام ${context.guest.name || "ضيفنا"} 🌹\n\nهذه دعوتك الخاصة 💛`;
    const result = await sendWhatsAppMessage(phone, caption, "video", { link: videoUrl });

    return {
      sent: result.ok,
      mediaType: "video",
      messageId: result.messageId,
      error: result.ok ? null : result.error,
    };
  },

  send_location: async (params, context) => {
    if (!context.event) return { error: "ما لقيت بيانات المناسبة" };
    const phone = params.phone;
    if (!phone) return { error: "رقم الجوال مطلوب" };

    const event = context.event;
    let msg = `📍 موقع المناسبة:\n\n`;
    if (event.location) msg += `مكان: ${event.location}\n`;
    if (event.venueAddress) msg += `العنوان: ${event.venueAddress}\n`;
    if (event.mapUrl) msg += `\n🗺️ خريطة: ${event.mapUrl}\n`;
    if (event.parkingInfo) msg += `\n🅿️ ${event.parkingInfo}\n`;

    const result = await sendWhatsAppMessage(phone, msg);
    return { sent: result.ok, location: event.location || event.venueAddress, messageId: result.messageId };
  },

  get_rsvp_status: async (params, context) => {
    if (!context.guest) return { error: "ما لقيت بيانات الضيف" };
    return {
      status: context.guest.rsvpStatus || "pending",
      count: context.guest.guestCount || 1,
      name: context.guest.name,
    };
  },

  update_rsvp: async (params, context) => {
    // WhatsApp guest identity is already verified by matching the incoming
    // WhatsApp number to the guest record. Do not add a second confirmation
    // loop for RSVP changes: one explicit RSVP intent from the verified number
    // is enough. This keeps the flow one-step while preserving server-side
    // guest authorization.
    const isVerifiedWhatsAppGuest =
      String(context.platform || "").toLowerCase() === "whatsapp" &&
      !!context.phone &&
      !!context.guest &&
      !!context.private &&
      normalizePhone(context.phone) === normalizePhone(context.private.phone || context.phone);

    if (!params.confirmed && !isVerifiedWhatsAppGuest) {
      return { needsConfirmation: true, pendingStatus: params.newStatus };
    }

    if (!context.guest) return { error: "ما لقيت بيانات الضيف" };
    if (!context.guest._ref) return { error: "مرجع الضيف غير متوفر" };

    const validStatuses = ["yes", "no", "pending"];
    if (!validStatuses.includes(params.newStatus)) {
      return { error: "حالة غير صالحة" };
    }

    const db = getDb();
    if (!db) return { error: "خطأ في قاعدة البيانات" };

    try {
      await db.doc(context.guest._ref).update({
        status: params.newStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Log the operation
      await logOperation({
        type: "update_rsvp",
        guestRef: context.guest._ref,
        oldStatus: context.guest.rsvpStatus,
        newStatus: params.newStatus,
      });

      if (params.newStatus === "yes") {
        const qrEnabled = await getEffectiveQrEnabled(context.event);
        if (qrEnabled) {
          const entryCode = context.private && context.private.entryCode;
          const phone = context.phone || (context.private && context.private.phone);
          const eventId = context.event && (context.event._id || context.event.eventCode || context.event.packageId);
          if (entryCode && phone && eventId) {
            const qrUrl = buildQrImageUrl(eventId, entryCode);
            const qrResult = await sendWhatsAppMessage(
              phone,
              `🎟️ تم تأكيد حضورك يا ${context.guest.name || "ضيفنا"} 🌹\n\nهذه بطاقة دخولك الشخصية. احتفظ بها وبرز الـQR عند الدخول.`,
              "image",
              { link: qrUrl }
            );
            return {
              updated: true,
              newStatus: params.newStatus,
              name: context.guest.name || "",
              qrEnabled: true,
              qrSent: !!qrResult.ok,
              qrError: qrResult.ok ? null : qrResult.error,
            };
          }
        }
        return {
          updated: true,
          newStatus: params.newStatus,
          name: context.guest.name || "",
          qrEnabled: false,
          qrSent: false,
        };
      }

      return { updated: true, newStatus: params.newStatus, name: context.guest.name || "" };
    } catch (err) {
      console.error("[AI] update_rsvp error:", err.message);
      return { error: "ما قدرت نحدّث الحالة، حاول بعد شوي" };
    }
  },

  update_guest_count: async (params, context) => {
    if (!params.confirmed) {
      return { needsConfirmation: true, pendingCount: params.newCount };
    }
    if (!context.guest) return { error: "ما لقيت بيانات الضيف" };
    if (!context.guest._ref) return { error: "مرجع الضيف غير متوفر" };

    const newCount = parseInt(String(params.newCount), 10);
    if (!newCount || newCount < 1 || newCount > 20) {
      return { error: "عدد غير صالح (يجب يكون بين 1 و 20)" };
    }

    // Check plusOneAllowed
    if (context.guest.plusOneAllowed === false && newCount > 1) {
      return { error: "عذراً، الدعوة مخصصة لشخص واحد فقط" };
    }
    if (context.guest.plusOneAllowed === true && newCount > 2) {
      return { error: "الدعوة تسمح بمرافق واحد فقط (حد أقصى 2 أشخاص)" };
    }

    const db = getDb();
    if (!db) return { error: "خطأ في قاعدة البيانات" };

    try {
      await db.doc(context.guest._ref).update({
        guests: String(newCount),
        companions: newCount - 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await logOperation({
        type: "update_guest_count",
        guestRef: context.guest._ref,
        oldCount: context.guest.guestCount,
        newCount: newCount,
      });

      return { updated: true, newCount: newCount };
    } catch (err) {
      console.error("[AI] update_guest_count error:", err.message);
      return { error: "ما قدرت نحدّث العدد، حاول بعد شوي" };
    }
  },

  get_packages: async (params, context) => {
    return { packages: context.public.packages || [] };
  },

  get_package_details: async (params, context) => {
    const packages = context.public.packages || [];
    const name = (params.packageName || "").toLowerCase();
    let found = null;

    for (const pkg of packages) {
      const pkgName = (pkg.name || "").toLowerCase();
      if (pkgName.includes(name) || name.includes(pkgName)) {
        found = pkg;
        break;
      }
    }

    if (!found) {
      return { package: null, notFound: true, requestedName: params.packageName || "" };
    }

    return { package: found, notFound: false };
  },

  compare_packages: async (params, context) => {
    const packages = context.public.packages || [];
    const findPkg = (name) => {
      if (!name) return null;
      const n = name.toLowerCase();
      return packages.find((p) => (p.name || "").toLowerCase().includes(n) || n.includes((p.name || "").toLowerCase()));
    };

    const pkgA = findPkg(params.packageA);
    const pkgB = findPkg(params.packageB);

    return {
      comparison: {
        a: pkgA || null,
        b: pkgB || null,
        allPackages: packages,
      },
    };
  },

  recommend_package: async (params, context) => {
    const packages = context.public.packages || [];
    if (!packages.length) return { recommendations: [] };

    const reqs = params.requirements || {};
    const guestCount = reqs.guestCount || 0;
    const wantedFeatures = reqs.features || [];

    // Score each package
    const scored = packages.map((pkg) => {
      let score = 0;
      const pkgFeatures = pkg.features || [];
      const pkgPrice = parseInt(String(pkg.price || pkg.amount || 0), 10) || 0;

      // Feature matching
      for (const feat of wantedFeatures) {
        if (pkgFeatures.some((f) => (f.name || f || "").toLowerCase().includes(feat.toLowerCase()))) {
          score += 2;
        }
      }

      // Guest count fit
      const pkgGuests = parseInt(String(pkg.maxGuests || pkg.guests || 0), 10) || 0;
      if (guestCount > 0 && pkgGuests > 0) {
        if (guestCount <= pkgGuests) score += 3;
        else score -= 1;
      }

      // Value score (lower price = better value, normalized)
      if (pkgPrice > 0) score += 1;

      return { ...pkg, _score: score };
    });

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);

    return { recommendations: scored.slice(0, 3) };
  },

  get_contact_info: async (params, context) => {
    return context.public.contact || {};
  },

  get_social_links: async (params, context) => {
    const contact = context.public.contact || {};
    const socials = {};
    if (contact.instagram) socials.instagram = contact.instagram;
    if (contact.tiktok) socials.tiktok = contact.tiktok;
    if (contact.x || contact.twitter) socials.x = contact.x || contact.twitter;
    if (contact.snapchat) socials.snapchat = contact.snapchat;
    return socials;
  },

  get_faq: async (params, context) => {
    return { items: context.public.faq || [] };
  },

  capture_lead: async (params, context) => {
    const db = getDb();
    if (!db) return { captured: false, error: "خطأ في قاعدة البيانات" };

    try {
      await db.collection("ai_leads").add({
        phone: params.phone || null,
        name: params.name || null,
        message: params.message || null,
        source: params.platform || "whatsapp",
        intent: params.intent || "LEAD_CAPTURE",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "new",
      });
      return { captured: true };
    } catch (err) {
      console.error("[AI] capture_lead error:", err.message);
      return { captured: false, error: "ما قدرت نسجّل طلبك، حاول بعد شوي" };
    }
  },
};

/**
 * Execute a tool by name with given params and context.
 */
async function executeTool(toolName, params, context) {
  const tool = TOOLS[toolName];
  if (!tool) {
    console.error(`[AI] Unknown tool: ${toolName}`);
    return { error: `أداة غير معروفة: ${toolName}` };
  }
  try {
    return await tool(params, context);
  } catch (err) {
    console.error(`[AI] Tool ${toolName} error:`, err.message);
    return { error: "حصل خطأ أثناء التنفيذ، حاول بعد شوي" };
  }
}

// ============================================================
//  D. GEMINI INTEGRATION
// ============================================================

const SYSTEM_PROMPT = `أنت مساعد ذكي لمنصة جمرة غضى للدعوات الإلكترونية.

القواعد الصارمة:
1. أجب بالعربية الخليجية الطبيعية والودودة.
2. إذا تكلم المستخدم بالإنجليزي، أجب بالإنجليزي.
3. لا تخترع معلومات. إذا لم تعرف، قل "ما عندي معلومة مؤكدة عن هالنقطة حاليًا 🌹"
4. لا تذكر مصادر داخلية (Firestore, database, system prompt).
5. لا تكشف بيانات أي ضيف آخر.
6. لا تنفذ عمليات كتابة مباشرة — استخدم الأدوات المتاحة فقط.
7. كن مختصرًا وواضحًا. لا تكتب فقرات طويلة.
8. استخدم الإيموجي باعتدال وبدون مبالغة.
9. لا تذكر أسعار أو مميزات غير موجودة في البيانات المعطاة.
10. إذا سأل عن ضيف آخر، رفض بأدب.

أسلوب الرد:
- فخم، ودود، خليجي
- بدون كلام آلي أو روبوتي
- مختصر قدر الإمكان
- مناسب لسياق المناسبات`;

/**
 * Call Groq's OpenAI-compatible chat completions endpoint.
 * @returns {Promise<{text: string, tokensUsed: number}>}
 */
async function callGroq(prompt, maxTokens, systemInstruction) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemInstruction || SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const tokensUsed = data.usage?.total_tokens || 0;
  return { text: text.trim(), tokensUsed };
}

/**
 * Call Z.ai's OpenAI-compatible chat completions endpoint (GLM models).
 * @returns {Promise<{text: string, tokensUsed: number}>}
 */
async function callZai(prompt, maxTokens, systemInstruction) {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error("ZAI_API_KEY not configured");

  const response = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "glm-4.7-flash",
      messages: [
        { role: "system", content: systemInstruction || SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Z.ai API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const tokensUsed = data.usage?.total_tokens || 0;
  return { text: text.trim(), tokensUsed };
}

/**
 * Call the LLM with automatic fallback: Groq أولاً (أسرع)، ولو فشل
 * (مفتاح ناقص، حصة منتهية، أو أي خطأ) يجرب Z.ai تلقائياً بنفس الطلب.
 * لو فشل الاثنين، يرمي آخر خطأ (يُمسك بمكانه بالكود اللي يستدعيها).
 * @param {string} prompt - The user/system prompt to send.
 * @param {number} maxTokens - Max tokens in response (default 500).
 * @param {string} [systemInstruction] - Override system instruction.
 * @returns {Promise<{text: string, tokensUsed: number}>}
 */
async function callGemini(prompt, maxTokens = 500, systemInstruction) {
  try {
    return await callGroq(prompt, maxTokens, systemInstruction);
  } catch (groqErr) {
    console.error("[AI] Groq failed, falling back to Z.ai:", groqErr.message);
    try {
      return await callZai(prompt, maxTokens, systemInstruction);
    } catch (zaiErr) {
      console.error("[AI] Z.ai also failed:", zaiErr.message);
      throw new Error(`كل المزوّدين فشلوا — Groq: ${groqErr.message} | Z.ai: ${zaiErr.message}`);
    }
  }
}

// ============================================================
//  E. RESPONSE GENERATION
// ============================================================

/**
 * Map intent → tool name (for structured data responses without Gemini).
 */
const INTENT_TOOL_MAP = {
  EVENT_INFO: "get_event_info",
  GUEST_INFO: "get_guest_info",
  RESEND_INVITATION: "resend_invitation",
  SEND_LOCATION: "send_location",
  GET_RSVP_STATUS: "get_rsvp_status",
  UPDATE_RSVP: "update_rsvp",
  UPDATE_GUEST_COUNT: "update_guest_count",
  PACKAGE_LIST: "get_packages",
  PACKAGE_DETAILS: "get_package_details",
  PACKAGE_COMPARE: "compare_packages",
  PACKAGE_RECOMMEND: "recommend_package",
  CONTACT_INFO: "get_contact_info",
  SOCIAL_LINK: "get_social_links",
  FAQ: "get_faq",
};

/**
 * Intents that require Gemini for response generation
 * (even if the tool provides structured data, we use Gemini to analyze it).
 */
const GEMINI_REQUIRED_INTENTS = new Set([
  "PACKAGE_RECOMMEND",
  "PACKAGE_COMPARE",
  "LEAD_CAPTURE",
  "PUBLIC_INFO",
  "HOW_TO_ORDER",
  "FAQ",
]);

// Intents that are purely structured (no Gemini needed)
const STRUCTURED_ONLY_INTENTS = new Set([
  "EVENT_INFO",
  "SEND_LOCATION",
  "RESEND_INVITATION",
  "GET_RSVP_STATUS",
  "PACKAGE_LIST",
  "CONTACT_INFO",
  "SOCIAL_LINK",
]);

/**
 * Format a structured data result into an Arabic response string.
 */
function formatStructuredResponse(intent, data) {
  if (data.error) {
    return `عذراً، ${data.error} 🌹`;
  }

  switch (intent) {
    case "EVENT_INFO": {
      if (!data.name) return "ما لقيت بيانات المناسبة حالياً";
      let r = `🎉 ${data.name}\n`;
      if (data.date) r += `📅 التاريخ: ${data.date}\n`;
      if (data.time) r += `🕐 الوقت: ${data.time}\n`;
      if (data.location) r += `📍 المكان: ${data.location}\n`;
      if (data.venueAddress) r += `🏠 العنوان: ${data.venueAddress}\n`;
      if (data.dressCode) r += `👔 الدريس كود: ${data.dressCode}\n`;
      if (data.parkingInfo) r += `🅿️ ${data.parkingInfo}\n`;
      if (data.notes) r += `\n📝 ${data.notes}\n`;
      return r.trim();
    }

    case "GUEST_INFO": {
      let r = `مرحباً ${data.name || ""} 🌹\n\n`;
      const statusLabels = {
        yes: "✅ مؤكد الحضور",
        no: "❌ معتذر",
        pending: "⏳ في الانتظار",
      };
      r += `حالتك: ${statusLabels[data.status] || data.status || "غير محدد"}\n`;
      r += `عدد المقاعد: ${data.count || 1}\n`;
      if (data.plusOneAllowed) r += `مرافق: ✅ مسموح\n`;
      return r.trim();
    }

    case "UPDATE_RSVP": {
      if (data.error) return `عذراً، ${data.error} 🌹`;
      if (data.newStatus === "yes") {
        if (data.qrEnabled && data.qrSent) {
          return `✅ تم تأكيد حضورك يا ${data.name || "ضيفنا"} 🌹\\n\\n🎟️ أرسلت لك بطاقة الدخول الشخصية والـQR هنا على الواتساب. احتفظ بها عند الدخول.`;
        }
        if (data.qrEnabled && data.qrSent === false) {
          return `✅ تم تأكيد حضورك يا ${data.name || "ضيفنا"} 🌹\\n\\nلكن ما قدرت أرسل الـQR الآن، حاول تطلبه مرة ثانية لاحقاً.`;
        }
        return `✅ تم تأكيد حضورك يا ${data.name || "ضيفنا"} 🌹`;
      }
      if (data.newStatus === "no") {
        return `❌ تم تسجيل اعتذارك، وشكرًا لإبلاغنا 🌹`;
      }
      return `⏳ تم تحديث حالتك إلى الانتظار 🌹`;
    }

    case "SEND_LOCATION": {
      if (data.sent === false) return "ما قدرت أرسل الموقع، حاول بعد شوي 🌹";
      return `📍 تم إرسال موقع المناسبة لك على الواتساب 🌹`;
    }

    case "RESEND_INVITATION": {
      if (data.sent === false) return "ما قدرت أرسل الدعوة، حاول بعد شوي 🌹";
      return `📨 تم إرسال فيديو الدعوة لك مجدداً على الواتساب 🌹`;
    }

    case "GET_RSVP_STATUS": {
      const statusLabels = {
        yes: "✅ مؤكد",
        no: "❌ معتذر",
        pending: "⏳ في الانتظار",
      };
      let r = `مرحباً ${data.name || ""} 🌹\n\n`;
      r += `حالتك: ${statusLabels[data.status] || data.status}\n`;
      r += `عدد المقاعد: ${data.count || 1}\n`;
      return r.trim();
    }

    case "PACKAGE_LIST": {
      const packages = data.packages || [];
      if (!packages.length) return "الباقات متوفرة قريباً 🌹 تابعونا!";
      let r = "📦 باقات جمرة غضى:\n\n";
      for (const pkg of packages) {
        const price = pkg.price || pkg.amount || "";
        r += `✨ ${pkg.name || "باقة"} — ${price} ريال\n`;
        if (pkg.shortDescription) r += `   ${pkg.shortDescription}\n`;
        r += "\n";
      }
      r += "للتفاصيل أكثر عن أي باقة، اسألني! 🌹";
      return r.trim();
    }

    case "PACKAGE_DETAILS": {
      const pkg = data.package;
      if (!pkg) return "ما لقيت هالباقة، جرب تسأل عن الباقات المتوفرة 🌹";
      let r = `✨ ${pkg.name || "باقة"}\n`;
      const price = pkg.price || pkg.amount || "";
      if (price) r += `💰 السعر: ${price} ريال\n`;
      if (pkg.description) r += `\n${pkg.description}\n`;
      const features = pkg.features || [];
      if (features.length) {
        r += "\nالمميزات:\n";
        for (const f of features) {
          const fname = f.name || f || "";
          r += `  ✅ ${fname}\n`;
        }
      }
      r += "\nللحجز: تواصلوا معنا على الواتساب 🌹";
      return r.trim();
    }

    case "CONTACT_INFO": {
      let r = "📞 طرق التواصل مع جمرة غضى:\n\n";
      if (data.whatsapp) r += `💬 واتساب: ${data.whatsapp}\n`;
      if (data.phone) r += `📱 جوال: ${data.phone}\n`;
      if (data.email) r += `📧 إيميل: ${data.email}\n`;
      r += "\nنحب نسمع منك! 🌹";
      return r.trim();
    }

    case "SOCIAL_LINK": {
      let r = "📱 تابعونا على منصاتنا:\n\n";
      if (data.instagram) r += `📸 انستقرام: ${data.instagram}\n`;
      if (data.tiktok) r += `🎵 تيك توك: ${data.tiktok}\n`;
      if (data.x) r += `🐦 إكس (تويتر): ${data.x}\n`;
      if (data.snapchat) r += `👻 سناب شات: ${data.snapchat}\n`;
      if (!r.includes(":")) r = "تابعونا على انستقرام وتيك توك: جمرة غضى 🌹";
      return r.trim();
    }

    default:
      return "تمام 🌹";
  }
}

/**
 * Main response generation function.
 * Decides between structured and Gemini-based responses.
 */
async function generateResponse(intent, context, userMessage) {
  // CLIENT_STATS is fully deterministic — the numbers were already computed
  // server-side in buildClientStatsContext(). No LLM call needed, and none
  // of these figures should be phrased/altered by a model.
  if (intent === "CLIENT_STATS" && context.client) {
    const s = context.client.stats;
    const lines = [
      `📊 إحصائيات "${context.client.eventName}"`,
      "",
      `✅ أكدوا الحضور: ${s.confirmed}`,
      `❌ اعتذروا: ${s.declined}`,
      `⏳ لسا ما ردوا: ${s.pending}`,
      `👥 إجمالي المدعوين: ${s.totalInvited}`,
      `🎉 إجمالي الحضور المتوقع (مع المرافقين): ${s.totalGuestsConfirmed}`,
    ];
    if (s.attendedSoFar > 0) {
      lines.push(`🚪 حضروا فعليًا لحد الآن: ${s.attendedSoFar}`);
    }
    return { text: lines.join("\n"), tokensUsed: 0, action: intent, actionResult: s };
  }

  // ─── Client actions: cancel / restore / resend for a named guest ───
  // These mutate data, so they're intentionally NOT routed through the
  // generic Gemini/tool pipeline — the guest-name match + status change
  // is deterministic and must stay inside the client's own event only.
  if (
    (intent === "CLIENT_CANCEL_GUEST" || intent === "CLIENT_RESTORE_GUEST" || intent === "CLIENT_RESEND_TO_GUEST") &&
    context.client
  ) {
    const db = getDb();
    const guestName = extractGuestNameFromCommand(userMessage);
    if (!db || !guestName) {
      return {
        text: "ما قدرت أفهم اسم الضيف من رسالتك 🌹 جربي تكتبين مثلاً: \"الغي حضور سارة\"",
        tokensUsed: 0, action: intent, actionResult: null,
      };
    }

    const result = await findGuestInEvent(db, context.client.eventId, guestName);

    if (result.notFound) {
      return {
        text: `ما لقيت ضيف بهذا الاسم "${guestName}" بقائمة "${context.client.eventName}" 🌹`,
        tokensUsed: 0, action: intent, actionResult: null,
      };
    }
    if (result.ambiguous) {
      const names = result.ambiguous.map((d, i) => `${i + 1}. ${d.data().name}`).join("\n");
      return {
        text: `فيه أكثر من ضيف بنفس الاسم تقريبًا:\n${names}\n\nاكتبي الاسم كامل أدق عشان أحدد الصح.`,
        tokensUsed: 0, action: intent, actionResult: null,
      };
    }

    const guestDoc = result.matched;
    const guestData = guestDoc.data();

    if (intent === "CLIENT_CANCEL_GUEST") {
      await guestDoc.ref.update({ status: "no" });
      return {
        text: `تم ✅ إلغيت حضور "${guestData.name}" من قائمة "${context.client.eventName}".`,
        tokensUsed: 0, action: intent, actionResult: { guestId: guestDoc.id },
      };
    }
    if (intent === "CLIENT_RESTORE_GUEST") {
      await guestDoc.ref.update({ status: "yes" });
      return {
        text: `تم ✅ رجّعت حضور "${guestData.name}" لقائمة "${context.client.eventName}".`,
        tokensUsed: 0, action: intent, actionResult: { guestId: guestDoc.id },
      };
    }
    if (intent === "CLIENT_RESEND_TO_GUEST") {
      if (!guestData.phone) {
        return {
          text: `ما فيه رقم جوال مسجّل لـ"${guestData.name}"، ما قدرت أرسل له.`,
          tokensUsed: 0, action: intent, actionResult: null,
        };
      }
      // يعيد استخدام نفس منطق الإرسال المستخدم أصلًا لطلب الضيف نفسه
      const eventCode = guestData.eventCode || context.client.eventId;
      const link = `${process.env.URL || "https://jamratghadah.com"}/${eventCode}?code=${encodeURIComponent(guestData.entryCode || "")}`;
      const sendResult = await sendWhatsAppMessage(guestData.phone, `تذكير من "${context.client.eventName}" 🌸\nرابط دعوتكم: ${link}`);
      return {
        text: sendResult.ok
          ? `تم ✅ أرسلت تذكير لـ"${guestData.name}".`
          : `حاولت أرسل لـ"${guestData.name}" بس صار خطأ بالإرسال، تأكدي من الرقم.`,
        tokensUsed: 0, action: intent, actionResult: { guestId: guestDoc.id },
      };
    }
  }

  const toolName = INTENT_TOOL_MAP[intent];
  let toolResult = null;

  // Execute tool if mapped
  if (toolName) {
    const params = {
      ...context.entities,
      phone: context.phone || null,
      platform: context.platform || "whatsapp",
      message: userMessage,
    };
    toolResult = await executeTool(toolName, params, context);
  }

  // Handle confirmation-required actions
  if (toolResult && toolResult.needsConfirmation) {
    let confirmMsg = "";
    if (intent === "UPDATE_RSVP") {
      const labels = { yes: "تأكيد الحضور", no: "الاعتذار", pending: "في الانتظار" };
      confirmMsg =
        `تأكد إنك تبي تغير حالتك إلى "${labels[toolResult.pendingStatus] || toolResult.pendingStatus}"؟\n` +
        `أرسل "نعم" للتأكيد أو "لا" للإلغاء 🌹`;
    } else if (intent === "UPDATE_GUEST_COUNT") {
      confirmMsg =
        `تأكد إنك تبي تغير عدد المقاعد إلى ${toolResult.pendingCount}؟\n` +
        `أرسل "نعم" للتأكيد أو "لا" للإلغاء 🌹`;
    }
    return { text: confirmMsg, tokensUsed: 0, action: intent, actionResult: null };
  }

  // RSVP changes are already authorized and executed server-side. Return the
  // deterministic result directly so Gemini cannot introduce a second
  // confirmation request or alter the action wording.
  if (intent === "UPDATE_RSVP" && toolResult) {
    return {
      text: formatStructuredResponse(intent, toolResult),
      tokensUsed: 0,
      action: intent,
      actionResult: toolResult,
    };
  }

  // Structured-only intents: format from data directly
  if (STRUCTURED_ONLY_INTENTS.has(intent) && toolResult) {
    return {
      text: formatStructuredResponse(intent, toolResult),
      tokensUsed: 0,
      action: intent,
      actionResult: toolResult,
    };
  }

  // Guest data-only intents
  if (intent === "GUEST_INFO" && toolResult) {
    return {
      text: formatStructuredResponse(intent, toolResult),
      tokensUsed: 0,
      action: intent,
      actionResult: toolResult,
    };
  }

  // For intents needing Gemini or fallback
  const needsGemini =
    GEMINI_REQUIRED_INTENTS.has(intent) ||
    !toolResult ||
    toolResult.error ||
    intent === "HUMAN_HANDOFF" ||
    intent === "HOW_TO_ORDER" ||
    intent === "UPDATE_GUEST_COUNT";

  if (needsGemini) {
    try {
      // Build Gemini prompt with safe context
      // Strip internal fields before sending to Gemini
      const INTERNAL_FIELDS = ["_id", "_ref", "_docId", "_eventCode"];
      function stripInternal(obj) {
        if (!obj || typeof obj !== "object") return obj;
        const clean = Array.isArray(obj) ? [] : {};
        for (const [k, v] of Object.entries(obj)) {
          if (INTERNAL_FIELDS.includes(k)) continue;
          clean[k] = typeof v === "object" && v !== null ? stripInternal(v) : v;
        }
        return clean;
      }

      let contextStr = "";
      if (context.guest) {
        contextStr += `\nبيانات الضيف: ${JSON.stringify(stripInternal(context.guest))}`;
      }
      if (context.event) {
        contextStr += `\nبيانات المناسبة: ${JSON.stringify(stripInternal(context.event))}`;
      }
      if (context.public && context.public.packages) {
        contextStr += `\nالباقات: ${JSON.stringify(context.public.packages)}`;
      }
      if (context.public && context.public.contact) {
        contextStr += `\nمعلومات التواصل: ${JSON.stringify(context.public.contact)}`;
      }
      if (context.public && context.public.faq && context.public.faq.length) {
        contextStr += `\nالأسئلة الشائعة: ${JSON.stringify(context.public.faq)}`;
      }
      if (context.public && context.public.company) {
        contextStr += `\nعن الشركة: ${JSON.stringify(context.public.company)}`;
      }

      const geminiPrompt =
        `النية: ${intent}\n` +
        `رسالة المستخدم: ${sanitizeForAI(userMessage)}\n` +
        (contextStr ? `\nالبيانات المتاحة:${contextStr}\n` : "") +
        (toolResult ? `\nنتيجة الأداة: ${JSON.stringify(toolResult)}\n` : "") +
        `\nأجب بمختصر وبلهجة خليجية ودودة.`;

      const geminiResult = await callGemini(geminiPrompt, 500);
      return {
        text: geminiResult.text,
        tokensUsed: geminiResult.tokensUsed,
        action: intent,
        actionResult: toolResult,
      };
    } catch (err) {
      console.error("[AI] Gemini response generation failed:", err.message);
      // Fallback to structured if available
      if (toolResult) {
        return {
          text: formatStructuredResponse(intent, toolResult),
          tokensUsed: 0,
          action: intent,
          actionResult: toolResult,
        };
      }
      return {
        text: "عذراً، حصل خطأ مؤقت. حاول بعد شوي 🌹",
        tokensUsed: 0,
        action: intent,
        actionResult: null,
      };
    }
  }

  // Default: return formatted tool result
  return {
    text: toolResult ? formatStructuredResponse(intent, toolResult) : "تمام 🌹",
    tokensUsed: 0,
    action: intent,
    actionResult: toolResult,
  };
}

// ============================================================
//  F. WHATSAPP MESSAGE SENDING
// ============================================================

/**
 * Send a WhatsApp message via Meta Business API.
 * @param {string} phone - Recipient phone (international format, no +).
 * @param {string} message - Text message body.
 * @param {string} type - Message type: 'text', 'image', 'location'.
 * @param {object} [extra] - Extra data (link for image, lat/lng for location).
 * @returns {Promise<{ok: boolean, messageId: string|null, error: string|null}>}
 */
async function sendWhatsAppMessage(phone, message, type = "text", extra = {}) {
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";

  if (!phoneId || !token) {
    return { ok: false, messageId: null, error: "WhatsApp not configured" };
  }

  // Clean phone number
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (!cleanPhone || cleanPhone.length < 10) {
    return { ok: false, messageId: null, error: "Invalid phone number" };
  }

  const API_BASE = "https://graph.facebook.com/v21.0";
  let messageData;

  try {
    if (type === "image" && extra.link) {
      messageData = {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "image",
        image: { link: extra.link, caption: message || undefined },
      };
    } else if (type === "video" && extra.link) {
      messageData = {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "video",
        video: { link: extra.link, caption: message || undefined },
      };
    } else if (type === "location" && extra.lat && extra.lng) {
      messageData = {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "location",
        location: {
          latitude: extra.lat,
          longitude: extra.lng,
          name: extra.name || "",
          address: extra.address || "",
        },
      };
    } else {
      messageData = {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "text",
        text: { body: message },
      };
    }

    const res = await fetch(`${API_BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messageData),
    });

    const resData = await res.json().catch(() => ({}));

    if (!res.ok) {
      // This used to fail silently — no throw, no log — so a send
      // failure (expired token, unregistered recipient, etc.) never
      // showed up anywhere. Log it loudly so it's visible in the
      // Netlify function log.
      console.error(
        "[AI] sendWhatsAppMessage FAILED:",
        res.status,
        JSON.stringify(resData.error || resData)
      );
    }

    return {
      ok: res.ok,
      messageId: resData.messages?.[0]?.id || null,
      error: resData.error?.message || null,
    };
  } catch (err) {
    console.error("[AI] sendWhatsAppMessage error:", err.message);
    return { ok: false, messageId: null, error: String(err) };
  }
}

// ============================================================
//  G. RATE LIMITING
// ============================================================

/**
 * Check rate limit for AI conversations.
 * Uses ai_rate_limits collection in Firestore.
 * @param {string} key - Rate limit key (e.g., "wa:966512345678" or "web:1.2.3.4")
 * @param {number} maxRequests - Max requests in window.
 * @param {number} windowMinutes - Window duration in minutes.
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
 */
async function checkAIRateLimit(key, maxRequests = 20, windowMinutes = 60) {
  const db = getDb();
  if (!db) {
    // Fail-closed: deny if no DB
    return { allowed: false, count: 0 };
  }

  const safeKey = String(key).replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 200);
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const windowStart = now - windowMs;
  const docId = safeKey;

  try {
    const ref = db.collection("ai_rate_limits").doc(docId);
    const snap = await ref.get();

    if (!snap.exists) {
      // First request
      await ref.set({
        count: 1,
        windowStart: admin.firestore.Timestamp.fromMillis(now),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + windowMs),
      });
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
    }

    const data = snap.data();
    const storedStart = data.windowStart?.toMillis?.() || data.windowStart || 0;

    // Check if window expired
    if (now > storedStart + windowMs) {
      // New window
      await ref.set({
        count: 1,
        windowStart: admin.firestore.Timestamp.fromMillis(now),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + windowMs),
      });
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
    }

    const count = data.count || 0;
    if (count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: storedStart + windowMs };
    }

    // Increment
    await ref.update({ count: admin.firestore.FieldValue.increment(1) });
    return { allowed: true, remaining: maxRequests - count - 1, resetAt: storedStart + windowMs };
  } catch (err) {
    console.error("[AI] checkAIRateLimit error:", err.message);
    return { allowed: false, count: 0 };
  }
}

// ============================================================
//  H. CONVERSATION LOGGING
// ============================================================

/**
 * Log a conversation exchange to ai_conversations collection.
 */
async function logConversation(data) {
  const db = getDb();
  if (!db) return;

  try {
    const logEntry = {
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      platform: data.platform || "unknown",
      userMessage: sanitizeForAI(data.userMessage || ""),
      assistantResponse: sanitizeForAI(data.assistantResponse || ""),
      intent: data.intent || null,
      action: data.action || null,
      actionResult: null, // Never log full action results
      tokensUsed: data.tokensUsed || 0,
    };

    // Add optional fields safely
    if (data.guestPhone) logEntry.guestPhone = data.guestPhone;
    if (data.eventId) logEntry.eventId = data.eventId;
    if (data.guestId) logEntry.guestId = data.guestId;

    // NEVER log: entryCode, personalCode, access codes, or other guests' data

    await db.collection("ai_conversations").add(logEntry);
  } catch (err) {
    console.error("[AI] logConversation error:", err.message);
  }
}

/**
 * Log an operation to operation_logs collection.
 */
async function logOperation(data) {
  const db = getDb();
  if (!db) return;

  try {
    await db.collection("operation_logs").add({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      type: data.type || "unknown",
      ...data,
    });
  } catch (err) {
    console.error("[AI] logOperation error:", err.message);
  }
}

// ============================================================
//  I. ANALYTICS TRACKING
// ============================================================

/**
 * Track analytics data for AI usage.
 * Updates ai_analytics_daily document for today.
 */
async function trackAnalytics(data) {
  const db = getDb();
  if (!db) return;

  try {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const ref = db.collection("ai_analytics_daily").doc(today);

    const updates = {
      totalConversations: admin.firestore.FieldValue.increment(1),
    };

    if (data.intent) {
      updates[`intentCounts.${data.intent}`] = admin.firestore.FieldValue.increment(1);
    }
    if (data.intent === "LEAD_CAPTURE" || data.leadCaptured) {
      updates.leadCount = admin.firestore.FieldValue.increment(1);
    }
    if (data.platform) {
      updates[`platformCounts.${data.platform}`] = admin.firestore.FieldValue.increment(1);
    }
    if (data.tokensUsed) {
      updates.totalTokensUsed = admin.firestore.FieldValue.increment(data.tokensUsed);
    }
    if (data.guestMatched) {
      updates.guestMatchedCount = admin.firestore.FieldValue.increment(1);
    }

    await ref.set(updates, { merge: true });
  } catch (err) {
    console.error("[AI] trackAnalytics error:", err.message);
  }
}

// ============================================================
//  J. SECURITY FUNCTIONS
// ============================================================

/**
 * Sanitize text before sending to AI to prevent prompt injection.
 */
function sanitizeForAI(text) {
  if (!text) return "";
  let s = String(text);
  // Truncate to max length
  s = s.slice(0, 1000);
  // Remove common prompt injection patterns
  s = s.replace(/ignore\s+(all\s+)?previous\s+instructions?/gi, "[filtered]");
  s = s.replace(/you\s+are\s+now\s+a/gi, "[filtered]");
  s = s.replace(/system\s*:/gi, "[filtered]");
  s = s.replace(/forget\s+(everything|all|your)/gi, "[filtered]");
  s = s.replace(/new\s+instructions?/gi, "[filtered]");
  s = s.replace(/override\s+/gi, "[filtered]");
  s = s.replace(/(admin|root|system|developer).*?(password|secret|key|token)/gi, "[filtered]");
  // Remove potential code execution patterns
  s = s.replace(/`[^`]*`/g, (match) => {
    if (match.includes("${") || match.includes("eval") || match.includes("require")) return "[code]";
    return match;
  });
  return s.trim();
}

/**
 * Normalize phone number to international format without +.
 */
function normalizePhone(phone) {
  let p = String(phone || "").replace(/[^0-9]/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "966" + p.slice(1);
  if (p.startsWith("+")) p = p.slice(1);
  return p;
}

/**
 * Verify WhatsApp webhook HMAC signature.
 */
function verifyWhatsAppSignature(payload, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;

  const expected = "sha256=" +
    crypto
      .createHmac("sha256", appSecret)
      .update(payload, "utf8")
      .digest("hex");

  return safeEqual(signatureHeader, expected);
}

/**
 * Parse incoming WhatsApp webhook payload.
 */
function parseWhatsAppPayload(body) {
  try {
    const entry = body.entry?.[0];
    if (!entry) return null;

    const changes = entry.changes?.[0];
    if (!changes) return null;

    const value = changes.value;
    if (!value) return null;

    // Only process messages
    if (value.messages && value.messages.length > 0) {
      const msg = value.messages[0];
      return {
        phone: msg.from,
        messageId: msg.id,
        messageText: msg.text?.body || "",
        messageType: msg.type || "text",
        timestamp: msg.timestamp,
        displayName: value.contacts?.[0]?.profile?.name || null,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
//  HELPERS
// ============================================================

/**
 * Get Firestore database instance.
 */
function getDb() {
  const adminApp = getAdminApp();
  if (!adminApp) return null;
  return adminApp.firestore();
}

/**
 * Check if AI is enabled globally or per-platform.
 * @param {string} platform - 'whatsapp' or 'web'
 */
async function isAIEnabled(platform = "whatsapp") {
  const db = getDb();
  if (!db) return false;

  try {
    const snap = await db.collection("ai_settings").doc("global").get();
    if (!snap.exists) return true; // Enabled by default
    const data = snap.data();
    if (data.enabled === false) return false;
    if (platform === "whatsapp" && data.whatsappEnabled === false) return false;
    if (platform === "web" && data.webEnabled === false) return false;
    return true;
  } catch (err) {
    console.error("[AI] isAIEnabled error:", err.message);
    return false; // Fail closed when the feature flag store is unavailable.
  }
}

/**
 * Process a confirmation message (yes/no) for pending actions.
 * @returns {object|null} Confirmed action or null if not a confirmation.
 */
function processConfirmation(text, pendingAction) {
  if (!pendingAction) return null;
  const normalized = normalizeArabic(text);

  const isYes = /^(نعم|ايوا|أيوا|تمام|اكيد|أكيد|بلى|نع|يو|yes|ok|ي)$/.test(normalized);
  const isNo = /^(لا|لالا|لأ|أبغى لا|لا أبي|لا أبغى|no|nope|ن)+$/.test(normalized);

  if (isYes) {
    return { confirmed: true, action: pendingAction.type, params: pendingAction.params };
  }
  if (isNo) {
    return { confirmed: false, action: pendingAction.type };
  }

  return null;
}

// ============================================================
//  EXPORTS
// ============================================================

module.exports = {
  // Intent classification
  classifyIntent,
  isPublicIntent,
  isGuestIntent,
  isClientIntent,
  INTENTS,

  // Context building
  buildPublicContext,
  buildGuestContext,
  buildClientStatsContext,
  parseGuestListText,

  // Disambiguation
  formatDisambiguationMessage,
  parseSelectionNumber,

  // Tool execution
  executeTool,
  TOOLS,

  // Gemini integration
  callGemini,
  SYSTEM_PROMPT,

  // Response generation
  generateResponse,

  // WhatsApp
  sendWhatsAppMessage,
  verifyWhatsAppSignature,
  parseWhatsAppPayload,

  // Rate limiting
  checkAIRateLimit,

  // Logging
  logConversation,
  logOperation,

  // Analytics
  trackAnalytics,

  // Security
  sanitizeForAI,
  normalizePhone,
  normalizeArabic,

  // Helpers
  getDb,
  isAIEnabled,
  processConfirmation,
};
