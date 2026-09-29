// ─────────────────────────────────────────────────────────────────────────
// Multi-user data layer: users, plans, codes, and PER-USER settings.
//
// The big structural change from v1: settings that used to be global
// (setting(db, "clock_font")) are now namespaced per account
// (setting(db, "clock_font", uid)) and stored under the key
// "clock_font:<user_id>". One global key is still honoured as a fallback so an
// existing single-owner install keeps working after the upgrade.
// ─────────────────────────────────────────────────────────────────────────

import { hashCode, normalizeCode, effectiveTier, makeCode } from "./plans.js";
import { nowSec } from "./db.js";

// ── users ──────────────────────────────────────────────────────────────

export async function upsertUser(db, u) {
  await db.prepare(
    `INSERT INTO users (user_id, username, name, role, is_owner, created_at, last_seen)
     VALUES (?1, ?2, ?3, COALESCE(?4,'user'), COALESCE(?5,0), ?6, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       username  = COALESCE(excluded.username, users.username),
       name      = COALESCE(excluded.name, users.name),
       last_seen = excluded.last_seen`
  ).bind(u.user_id, u.username ?? null, u.name ?? null,
         u.role ?? null, u.is_owner ? 1 : 0, nowSec()).run();
  return getUser(db, u.user_id);
}

export async function getUser(db, userId) {
  return db.prepare("SELECT * FROM users WHERE user_id = ?1").bind(userId).first();
}

export async function allUsers(db) {
  const { results } = await db.prepare(
    `SELECT u.*, p.tier, p.expires_at
       FROM users u LEFT JOIN plans p ON p.user_id = u.user_id
      ORDER BY COALESCE(u.is_owner,0) DESC, COALESCE(p.expires_at, 0) = 0 DESC,
               p.expires_at DESC, u.created_at DESC
      LIMIT 500`).all();
  return results;
}

export async function setUserRole(db, userId, role) {
  await db.prepare("UPDATE users SET role = ?1 WHERE user_id = ?2")
    .bind(role === "admin" ? "admin" : "user", userId).run();
}

export async function setOwner(db, userId, isOwner) {
  await db.prepare("UPDATE users SET is_owner = ?1, role = ?2 WHERE user_id = ?3")
    .bind(isOwner ? 1 : 0, isOwner ? "admin" : "user", userId).run();
}

export async function deleteUser(db, userId) {
  await db.prepare("DELETE FROM users WHERE user_id = ?1").bind(userId).run();
  await db.prepare("DELETE FROM plans WHERE user_id = ?1").bind(userId).run();
  await db.prepare("DELETE FROM connections WHERE user_id = ?1").bind(userId).run();
  // per-user settings + drafts belonging to that user's connections
  await db.prepare("DELETE FROM settings WHERE key LIKE ?1").bind(`%:${userId}`).run();
}

// ── plans ──────────────────────────────────────────────────────────────

export async function getPlan(db, userId) {
  const row = await db.prepare("SELECT * FROM plans WHERE user_id = ?1").bind(userId).first();
  if (!row) return { user_id: userId, tier: "free", expires_at: 0, started_at: 0 };
  return row;
}

export async function grantPlan(db, { user_id, tier, expires_at = 0, granted_by = null, note = "" }) {
  const t = nowSec();
  await db.prepare(
    `INSERT INTO plans (user_id, tier, started_at, expires_at, granted_by, note, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       tier = excluded.tier, expires_at = excluded.expires_at,
       granted_by = excluded.granted_by, note = excluded.note, updated_at = excluded.updated_at`
  ).bind(user_id, tier, t, expires_at, granted_by, note).run();
  return getPlan(db, user_id);
}

export async function extendPlan(db, userId, seconds) {
  const p = await getPlan(db, userId);
  const base = p.expires_at && p.expires_at > nowSec() ? p.expires_at : nowSec();
  return grantPlan(db, {
    user_id: userId, tier: p.tier, expires_at: base + seconds,
    granted_by: p.granted_by, note: p.note,
  });
}

export async function revokePlan(db, userId) {
  await db.prepare("DELETE FROM plans WHERE user_id = ?1").bind(userId).run();
}

export async function allPlans(db) {
  const { results } = await db.prepare(
    "SELECT * FROM plans ORDER BY expires_at = 0 DESC, expires_at DESC").all();
  return results;
}

/** The resolved answer to "may this user use X right now". */
export async function entitlements(db, userId) {
  const u = await getUser(db, userId);
  const p = await getPlan(db, userId);
  const admin = !!u?.is_owner || u?.role === "admin" || userId === ADMIN_FALLBACK;
  return {
    user: u,
    plan: p,
    isAdmin: admin,
    tier: admin ? "premium" : effectiveTier(p.tier, p.expires_at),
    expiresAt: admin ? 0 : (p.expires_at || 0),
  };
}

// set lazily by init() from env so this module stays env-free
let ADMIN_FALLBACK = 0;
export function setAdminFallback(id) { ADMIN_FALLBACK = Number(id || 0); }

// ── codes ──────────────────────────────────────────────────────────────

export async function createCode(db, secret, {
  tier = "pro", max_uses = 1, bound_user = null, expires_at = 0,
  created_by, note = "",
}) {
  const plain = makeCode(12);
  const hash = await hashCode(plain, secret);
  await db.prepare(
    `INSERT INTO codes (code_hash, code_plain, tier, max_uses, uses, bound_user,
                        expires_at, created_by, note, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9)`
  ).bind(hash, plain, tier, max_uses, bound_user, expires_at, created_by, note, nowSec()).run();
  return { code: plain, hash };
}

export async function getCode(db, hash) {
  return db.prepare("SELECT * FROM codes WHERE code_hash = ?1").bind(hash).first();
}

export async function listCodes(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT c.*, u.username AS bound_username, u.name AS bound_name
       FROM codes c LEFT JOIN users u ON u.user_id = c.bound_user
      ORDER BY c.created_at DESC LIMIT ?1`).bind(limit).all();
  return results;
}

/** Validate without consuming. Returns {ok, reason, code?}. */
export async function checkCode(db, secret, input, userId) {
  const hash = await hashCode(input, secret);
  const c = await getCode(db, hash);
  if (!c) return { ok: false, reason: "unknown" };
  if (c.uses >= c.max_uses) return { ok: false, reason: "used_up", code: c };
  if (c.expires_at && c.expires_at < nowSec()) return { ok: false, reason: "expired", code: c };
  if (c.bound_user && Number(c.bound_user) !== Number(userId)) {
    return { ok: false, reason: "bound", code: c };
  }
  return { ok: true, code: c };
}

/** Redeem: re-checks under a single statement so a race cannot double-spend. */
export async function redeemCode(db, secret, input, userId) {
  const pre = await checkCode(db, secret, input, userId);
  if (!pre.ok) return pre;
  const hash = await hashCode(input, secret);
  const res = await db.prepare(
    `UPDATE codes SET uses = uses + 1, code_plain = CASE WHEN uses + 1 >= max_uses
                     THEN NULL ELSE code_plain END
      WHERE code_hash = ?1 AND uses < max_uses
        AND (expires_at = 0 OR expires_at > ?2)
        AND (bound_user IS NULL OR bound_user = ?3)`
  ).bind(hash, nowSec(), userId).run();
  if (!res.changes) return { ok: false, reason: "race" };
  await db.prepare(
    "INSERT INTO code_uses (code_hash, user_id, at) VALUES (?1, ?2, ?3)"
  ).bind(hash, userId, nowSec()).run();
  return { ok: true, code: pre.code };
}

export async function deleteCode(db, hash) {
  await db.prepare("DELETE FROM codes WHERE code_hash = ?1").bind(hash).run();
  await db.prepare("DELETE FROM code_uses WHERE code_hash = ?1").bind(hash).run();
}

export async function codeStats(db) {
  const row = await db.prepare(
    `SELECT COUNT(*) total, COALESCE(SUM(uses),0) used FROM codes`).first();
  const users = await db.prepare("SELECT COUNT(*) c FROM users").first();
  const paid = await db.prepare(
    `SELECT COUNT(*) c FROM plans WHERE tier != 'free'`).first();
  return { codes: row?.total || 0, redemptions: row?.used || 0,
           users: users?.c || 0, paid: paid?.c || 0 };
}

// ── per-user settings ──────────────────────────────────────────────────
// Stored as "<key>:<user_id>". A global "<key>" is read as a fallback so the
// original single-owner deployment keeps its clock/mode after the upgrade.

export async function setting(db, key, fallback = null, uid = null) {
  if (uid != null) {
    const scoped = await db.prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(`${key}:${uid}`).first();
    if (scoped) return scoped.value;
  }
  const g = await db.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(key).first();
  return g ? g.value : fallback;
}

export async function setSetting(db, key, value, uid = null) {
  const k = uid != null ? `${key}:${uid}` : key;
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(k, String(value ?? ""), nowSec()).run();
}

/** True when a value is stored specifically for this user (not inherited). */
export async function hasOwnSetting(db, key, uid) {
  const r = await db.prepare("SELECT 1 AS x FROM settings WHERE key = ?1")
    .bind(`${key}:${uid}`).first();
  return !!r;
}

