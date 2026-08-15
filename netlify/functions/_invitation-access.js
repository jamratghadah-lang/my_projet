// Server-only invitation access codes. Values MUST come from Netlify environment variables.
// Required variables: INVITE_ACCESS_<SLUG_IN_UPPERCASE_WITH_DASHES_AS_UNDERSCORES>

function envName(slug) {
  return `INVITE_ACCESS_${String(slug || "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

function getInvitationAccessCode(slug) {
  const key = String(slug || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!key) return "";
  return String(process.env[envName(key)] || "").trim();
}

module.exports = { getInvitationAccessCode, envName };
