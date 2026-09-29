// ─────────────────────────────────────────────────────────────────────────
// Plans, feature entitlements, and redeem codes.
//
// SECURITY NOTES
//  • Codes are stored as HMAC-SHA256(secret, code) — a leaked DB cannot be
//    turned back into working codes. The plaintext is kept only so the admin
//    dashboard can show a code again; it is nulled when fully used up.
//  • Every code is time-limited and optionally bound to one user_id, so a code
//    that leaks in a screenshot stops working at its deadline.
//  • Comparison and lookup are constant-time-ish: the hash is the index, so
//    there is no timing oracle on the code value itself.
//  • A user can never grant themselves a plan: tier/expires are written by the
//    admin path or by redeeming a code that was minted for that purpose.
// ─────────────────────────────────────────────────────────────────────────

import { nowSec } from "./db.js";

// ── feature matrix ─────────────────────────────────────────────────────
// The single source of truth for "what does this tier unlock". `min` is the
// lowest tier index that includes the feature.
export const FEATURES = {
  // ── free (anyone who connects the bot) ──
  dm_listen:      { min: 0, label: "DM forwarding",           icon: "📥" },
  manual_reply:   { min: 0, label: "Reply with buttons",       icon: "✍️" },
  rules:          { min: 0, label: "Keyword auto-replies",     icon: "⚡" },
  quick_replies:  { min: 0, label: "Quick replies",            icon: "🔖" },
  blocklist:      { min: 0, label: "Blocklist",                icon: "🚫" },
  // ── pro ──
  profile_edit:   { min: 1, label: "Edit name / bio / photo",  icon: "👤" },
  clock:          { min: 1, label: "Tehran clock in your name", icon: "🕐" },
  // ── premium ──
  ai_mode:        { min: 2, label: "AI auto-replies",          icon: "🤖" },
  pin_per_thread: { min: 2, label: "Per-thread mode override", icon: "📌" },
  audit_log:      { min: 2, label: "Activity log",             icon: "📜" },
};

export const TIERS = ["free", "pro", "premium"];

export const TIER_INFO = {
  free:    { label: "Free",    icon: "🆓", blurb: "DM forwarding, replies, rules" },
  pro:     { label: "Pro",     icon: "⚡", blurb: "+ profile editing, Tehran clock" },
  premium: { label: "Premium", icon: "💎", blurb: "+ AI replies, per-thread pin, activity log" },
};

const tierIndex = (t) => Math.max(0, TIERS.indexOf(t) < 0 ? 0 : TIERS.indexOf(t));

/** Does this user hold a feature right now? */
export function hasFeature(tier, expiresAt, feature, now = nowSec()) {
  const f = FEATURES[feature];
  if (!f) return false;
  // A lapsed plan drops to the FREE tier, not to nothing: free features
  // (DM forwarding, replies, rules) must keep working after expiry.
  const t = effectiveTier(tier, expiresAt, now);
  return tierIndex(t) >= f.min;
}

/** Effective tier: a lapsed plan reads as free. */
export function effectiveTier(tier, expiresAt, now = nowSec()) {
  if (expiresAt && expiresAt < now) return "free";
  return TIERS.includes(tier) ? tier : "free";
}

export function planLabel(tier, expiresAt, now = nowSec()) {
  const t = effectiveTier(tier, expiresAt, now);
  const info = TIER_INFO[t];
  if (!expiresAt) return `${info.icon} ${info.label} · <b>lifetime</b>`;
  const days = Math.ceil((expiresAt - now) / 86400);
  const when = days <= 0 ? "expired"
    : days === 1 ? "expires tomorrow"
    : `expires in ${days} days`;
  return `${info.icon} ${info.label} · ${when}`;
}

// ── codes ──────────────────────────────────────────────────────────────
// Format: unambiguous alphabet (no 0/O/1/I/l), grouped for readability.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeCode(len = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out.replace(/(.{4})(?=.)/g, "$1-");           // ABCD-EFGH-IJKL
}

export function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** HMAC of the code under the server secret. Stored instead of the code. */
export async function hashCode(code, secret) {
  const norm = normalizeCode(code);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(norm));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fmtExpiry(ts) {
  if (!ts) return "never";
  const d = new Date(ts * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function fmtDuration(seconds) {
  if (!seconds) return "never";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  if (seconds < 2592000) return `${Math.round(seconds / 86400)} days`;
  return `${Math.round(seconds / 2592000)} months`;
}

export const parseDuration = (s) => {
  const m = String(s || "").trim().toLowerCase();
  const n = parseFloat(m);
  if (!Number.isFinite(n)) return 0;
  if (m.includes("min")) return n * 60;
  if (m.includes("h")) return n * 3600;
  if (m.includes("d")) return n * 86400;
  if (m.includes("mo") || m.includes("mon")) return n * 2592000;
  if (m.includes("y")) return n * 31536000;
  return n;
};
