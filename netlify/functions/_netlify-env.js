// netlify/functions/_netlify-env.js
//
// Shared helper to create/update Netlify SITE environment variables through
// the Netlify API, so the dashboard can be the single source of truth
// instead of requiring a manual copy-paste into Site settings.
//
// Requires two env vars to be set ONCE, manually, in Netlify
// (Site settings → Environment variables) — there is no way around this
// bootstrap step, since *something* has to hold the credential that is
// allowed to write other env vars:
//   NETLIFY_AUTH_TOKEN  — a Netlify Personal Access Token
//                          (User settings → Applications → New access token)
//   NETLIFY_SITE_ID     — this site's API ID (Site settings → General → Site details)
//
// After that, every other secret (WhatsApp token, Groq key, etc.) can be
// saved from dashboard/integrations.html and this helper pushes it to
// Netlify for you — one place, one save button.

const API_BASE = "https://api.netlify.com/api/v1";

let _accountIdCache = null;

async function netlifyFetch(path, opts = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    throw new Error("NETLIFY_AUTH_TOKEN غير مضبوط في Netlify — خطوة إعداد أولى لازمة يدويًا");
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

async function getAccountId(siteId) {
  if (_accountIdCache) return _accountIdCache;
  const res = await netlifyFetch(`/sites/${siteId}`);
  if (!res.ok) {
    throw new Error(`تعذّر جلب بيانات الموقع من Netlify (HTTP ${res.status})`);
  }
  const data = await res.json();
  _accountIdCache = data.account_id;
  return _accountIdCache;
}

/**
 * Creates or updates a single site-scoped environment variable's value
 * (context "all") using the Netlify API.
 * Returns { ok, status, error? }.
 */
async function setSiteEnvVar(key, value) {
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!siteId) {
    return { ok: false, status: 0, error: "NETLIFY_SITE_ID غير مضبوط في Netlify" };
  }

  let accountId;
  try {
    accountId = await getAccountId(siteId);
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }

  // 1) Try to set a value on an existing variable.
  const patchRes = await netlifyFetch(
    `/accounts/${accountId}/env/${encodeURIComponent(key)}?site_id=${siteId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ context: "all", value }),
    }
  );
  if (patchRes.ok) return { ok: true, status: patchRes.status };

  // 2) Variable doesn't exist yet — create it.
  if (patchRes.status === 404) {
    const createRes = await netlifyFetch(`/accounts/${accountId}/env?site_id=${siteId}`, {
      method: "POST",
      body: JSON.stringify([
        {
          key,
          scopes: ["builds", "functions", "runtime"],
          values: [{ value, context: "all" }],
        },
      ]),
    });
    if (createRes.ok) return { ok: true, status: createRes.status };
    const errText = await createRes.text().catch(() => "");
    return { ok: false, status: createRes.status, error: errText };
  }

  const errText = await patchRes.text().catch(() => "");
  return { ok: false, status: patchRes.status, error: errText };
}

/**
 * Sets multiple env vars (object of { KEY: value }), skipping empty values.
 * Returns { ok, results: { KEY: {ok, error?} }, deployTriggered }.
 */
async function setSiteEnvVars(envMap) {
  const results = {};
  let allOk = true;
  for (const [key, value] of Object.entries(envMap)) {
    if (value === undefined || value === null || value === "") continue;
    const r = await setSiteEnvVar(key, value);
    results[key] = r;
    if (!r.ok) allOk = false;
  }
  return { ok: allOk, results };
}

/**
 * Triggers a new deploy so Netlify Functions actually pick up the env vars
 * just written (functions get their env baked in at deploy time).
 */
async function triggerDeploy() {
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!siteId) return { ok: false, error: "NETLIFY_SITE_ID غير مضبوط" };
  try {
    const res = await netlifyFetch(`/sites/${siteId}/builds`, {
      method: "POST",
      body: JSON.stringify({ title: "إعادة نشر تلقائية — تحديث مفاتيح من لوحة التكاملات" }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: errText || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { setSiteEnvVar, setSiteEnvVars, triggerDeploy };
