// ─────────────────────────────────────────────────────────────────────────
// D1 data layer. Every function is a small, focused query — no ORM, no
// assumptions about ordering. State survives deploys because it lives here,
// not in the isolate's memory.
// ─────────────────────────────────────────────────────────────────────────

const now = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);

async function setting(db, key, fallback = null) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first();
  return row ? row.value : fallback;
}

async function setSetting(db, key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value ?? ""), nowSec()).run();
}

async function allSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

// ── connections ────────────────────────────────────────────────────────

async function saveConnection(db, c) {
  await db.prepare(
    `INSERT INTO connections (conn_id, user_id, user_chat_id, name, rights, enabled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
     ON CONFLICT(conn_id) DO UPDATE SET
       user_id = excluded.user_id, user_chat_id = excluded.user_chat_id,
       name = excluded.name, rights = excluded.rights,
       enabled = 1, updated_at = excluded.updated_at`
  ).bind(c.id, c.user_id, c.user_chat_id ?? null, c.name ?? null,
         JSON.stringify(c.rights ?? {}), nowSec()).run();
  await rememberConn(db, c.id);
}

async function rememberConn(db, connId) {
  await db.prepare(
    `INSERT INTO known_connections (conn_id, seen_at) VALUES (?1, ?2)
     ON CONFLICT(conn_id) DO UPDATE SET seen_at = excluded.seen_at`
  ).bind(connId, nowSec()).run();
}

async function dropConnection(db, connId) {
  await db.prepare("DELETE FROM connections WHERE conn_id = ?1").bind(connId).run();
}

async function getConnection(db, connId) {
  const row = await db.prepare(
    "SELECT * FROM connections WHERE conn_id = ?1 AND enabled = 1").bind(connId).first();
  if (!row) return null;
  let rights = {};
  try { rights = JSON.parse(row.rights || "{}"); } catch { rights = {}; }
  return { id: row.conn_id, user_id: row.user_id, user_chat_id: row.user_chat_id,
           name: row.name, rights };
}

async function allConnections(db) {
  const { results } = await db.prepare(
    "SELECT * FROM connections WHERE enabled = 1").all();
  return results.map((r) => {
    let rights = {};
    try { rights = JSON.parse(r.rights || "{}"); } catch { rights = {}; }
    return { id: r.conn_id, user_id: r.user_id, user_chat_id: r.user_chat_id,
             name: r.name, rights };
  });
}

async function knownConnIds(db) {
  const { results } = await db.prepare(
    "SELECT conn_id FROM known_connections ORDER BY seen_at DESC LIMIT 25").all();
  return results.map((r) => r.conn_id);
}

// a connection that has the given granted right
async function connWithRight(db, right) {
  const list = await allConnections(db);
  for (const c of list) if (c.rights?.[right]) return c;
  return null;
}

// ── idempotency (the webhook compensation) ────────────────────────────

// Returns true if this update_id is NEW. A false return means Telegram is
// re-delivering and the handler must exit immediately.
async function claimUpdate(db, updateId) {
  if (updateId == null) return true;
  try {
    await db.prepare(
      "INSERT INTO processed_updates (update_id, at) VALUES (?1, ?2)"
    ).bind(updateId, nowSec()).run();
    return true;
  } catch {
    return false;                      // already processed
  }
}

// keep the table small
async function pruneUpdates(db) {
  await db.prepare("DELETE FROM processed_updates WHERE at < ?1")
    .bind(nowSec() - 86400).run();
}

// ── drafts ─────────────────────────────────────────────────────────────

export function draftId(customerId, connId) {
  // FNV-1a: short, stable, and definitely free of "_" (which breaks naive
  // callback_data parsing). Telegram caps callback_data at 64 bytes.
  const s = `${customerId}:${connId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "d" + h.toString(36).padStart(7, "0");
}

async function saveDraft(db, d) {
  await db.prepare(
    `INSERT INTO drafts (id, customer_id, conn_id, name, username, msg_id, text, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, username = excluded.username,
       msg_id = excluded.msg_id, text = excluded.text, at = excluded.at`
  ).bind(d.id, d.customer_id, d.conn_id, d.name ?? null, d.username ?? null,
         d.msg_id ?? null, (d.text ?? "").slice(0, 4000), nowSec()).run();
}

async function getDraft(db, id) {
  return db.prepare("SELECT * FROM drafts WHERE id = ?1").bind(id).first();
}

async function dropDraft(db, id) {
  await db.prepare("DELETE FROM drafts WHERE id = ?1").bind(id).run();
}

async function pruneDrafts(db, ttlHours) {
  await db.prepare("DELETE FROM drafts WHERE at < ?1")
    .bind(nowSec() - (ttlHours || 72) * 3600).run();
}

// ── the single open reply ──────────────────────────────────────────────

async function setReply(db, r) {
  await db.prepare(
    `INSERT INTO reply_state (owner_id, draft_id, conn_id, customer_id, name, mode, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(owner_id) DO UPDATE SET
       draft_id = excluded.draft_id, conn_id = excluded.conn_id,
       customer_id = excluded.customer_id, name = excluded.name,
       mode = excluded.mode, at = excluded.at`
  ).bind(r.owner_id, r.draft_id ?? null, r.conn_id ?? null, r.customer_id ?? null,
         r.name ?? null, r.mode ?? null, nowSec()).run();
}

async function getReply(db, ownerId) {
  return db.prepare("SELECT * FROM reply_state WHERE owner_id = ?1").bind(ownerId).first();
}

async function clearReply(db, ownerId) {
  await db.prepare("DELETE FROM reply_state WHERE owner_id = ?1").bind(ownerId).run();
}

// ── rules / quick / blocked / pins ─────────────────────────────────────

const KV = {
  rules: { table: "rules", key: "kw", val: "reply" },
  quick: { table: "quick", key: "name", val: "text" },
};

async function listKv(db, kind) {
  const t = KV[kind].table;
  const { results } = await db.prepare(`SELECT * FROM ${t} ORDER BY at DESC LIMIT 50`).all();
  return results;
}

async function putKv(db, kind, key, value) {
  const { table, key: kcol, val } = KV[kind];
  await db.prepare(
    `INSERT INTO ${table} (${kcol}, ${val}, at) VALUES (?1, ?2, ?3)
     ON CONFLICT(${kcol}) DO UPDATE SET ${val} = excluded.${val}, at = excluded.at`
  ).bind(key, String(value).slice(0, 1000), nowSec()).run();
}

async function delKv(db, kind, key) {
  const { table, key: kcol } = KV[kind];
  await db.prepare(`DELETE FROM ${table} WHERE ${kcol} = ?1`).bind(key).run();
}

async function isBlocked(db, customerId) {
  const r = await db.prepare("SELECT 1 AS x FROM blocked WHERE customer_id = ?1")
    .bind(String(customerId)).first();
  return !!r;
}

async function blockUser(db, customerId) {
  await db.prepare(
    "INSERT INTO blocked (customer_id, at) VALUES (?1, ?2) ON CONFLICT(customer_id) DO NOTHING"
  ).bind(String(customerId), nowSec()).run();
}

async function unblockUser(db, customerId) {
  await db.prepare("DELETE FROM blocked WHERE customer_id = ?1").bind(String(customerId)).run();
}

async function listBlocked(db) {
  const { results } = await db.prepare("SELECT customer_id FROM blocked ORDER BY at DESC").all();
  return results.map((r) => r.customer_id);
}

async function getPin(db, key) {
  const r = await db.prepare("SELECT mode FROM pins WHERE k = ?1").bind(key).first();
  return r ? r.mode : null;
}

async function setPin(db, key, mode) {
  if (!mode) {
    await db.prepare("DELETE FROM pins WHERE k = ?1").bind(key).run();
  } else {
    await db.prepare(
      `INSERT INTO pins (k, mode, at) VALUES (?1, ?2, ?3)
       ON CONFLICT(k) DO UPDATE SET mode = excluded.mode, at = excluded.at`
    ).bind(key, mode, nowSec()).run();
  }
}

// ── the tick: everything the clock needs, in ONE round trip ───────────
export async function tickState(db) {
  const row = await db.prepare(
    `SELECT
       (SELECT value FROM settings WHERE key='clock_font')     AS clock_font,
       (SELECT value FROM settings WHERE key='clock_base_name') AS clock_base_name,
       (SELECT value FROM settings WHERE key='clock_applied')   AS clock_applied,
       (SELECT value FROM settings WHERE key='last_cron')       AS last_cron,
       (SELECT conn_id FROM connections
         WHERE enabled=1
           AND json_extract(rights, '$.can_edit_name') = 1
         ORDER BY updated_at DESC LIMIT 1)                      AS name_conn_id`
  ).first();
  return row || {};
}


// ── per-user clock jobs ───────────────────────────────────────────────
// One job per user who enabled a clock. Each user's font/base name is stored
// under "<key>:<user_id>", so the tick serves every clock independently.
export async function clockJobs(db) {
  const { results: conns } = await db.prepare(
    "SELECT conn_id, user_id FROM connections WHERE enabled = 1").all();
  if (!conns.length) return [];

  // settings keys look like "clock_font:123"; pull them all in one query
  const { results: rows } = await db.prepare(
    `SELECT key, value FROM settings
      WHERE key LIKE 'clock\_font:%' ESCAPE '\\'
         OR key LIKE 'clock\_base\_name:%' ESCAPE '\\'
         OR key LIKE 'clock\_applied:%' ESCAPE '\\'`).all();
  const byUser = {};
  for (const r of rows) {
    const m = r.key.match(/^([a-z_]+):(\d+)$/);
    if (!m) continue;
    const [, k, uid] = m;
    (byUser[uid] ||= {})[k] = r.value;
  }
  const jobs = [];
  for (const c of conns) {
    const s = byUser[String(c.user_id)] || {};
    if (!s.clock_font || !s.clock_base_name) continue;
    jobs.push({
      connId: c.conn_id, uid: c.user_id,
      font: s.clock_font, base: s.clock_base_name,
      applied: s.clock_applied || "",
    });
  }
  return jobs;
}


// ── AI history (bounded) ───────────────────────────────────────────────

const HIST_MAX_PER_THREAD = 40;
const HIST_MAX_THREADS = 50;

async function histAdd(db, key, role, content) {
  await db.prepare(
    "INSERT INTO history (k, role, content, at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(key, role, String(content).slice(0, 4000), nowSec()).run();
  // trim this thread
  await db.prepare(
    `DELETE FROM history WHERE k = ?1 AND id NOT IN
       (SELECT id FROM history WHERE k = ?1 ORDER BY at DESC LIMIT ?2)`
  ).bind(key, HIST_MAX_PER_THREAD).run();
}

async function histGet(db, key, n = 8) {
  const { results } = await db.prepare(
    "SELECT role, content FROM history WHERE k = ?1 ORDER BY at DESC LIMIT ?2"
  ).bind(key, n).all();
  return results.reverse();
}

async function histForget(db, key) {
  await db.prepare("DELETE FROM history WHERE k = ?1").bind(key).run();
}

async function pruneHistory(db) {
  // drop the least recently used threads
  const { results } = await db.prepare(
    "SELECT k FROM history GROUP BY k ORDER BY MAX(at) DESC LIMIT -1 OFFSET ?1"
  ).bind(HIST_MAX_THREADS).all();
  for (const r of results) {
    await db.prepare("DELETE FROM history WHERE k = ?1").bind(r.k).run();
  }
}

// ── stats + rate limit + audit ─────────────────────────────────────────

async function bumpStat(db, key, by = 1) {
  await db.prepare(
    `INSERT INTO stats (k, v) VALUES (?1, ?2)
     ON CONFLICT(k) DO UPDATE SET v = v + excluded.v`
  ).bind(key, by).run();
}

async function allStats(db) {
  const { results } = await db.prepare("SELECT k, v FROM stats").all();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}

// Fixed-window counter in D1, so it holds across isolates and deploys.
async function rateLimit(db, key, limitPerMin) {
  const window = Math.floor(Date.now() / 60000);
  const k = `${key}:${window}`;
  await db.prepare(
    `INSERT INTO ratelimit (k, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET count = count + 1`
  ).bind(k, (window + 1) * 60).run();
  const row = await db.prepare("SELECT count FROM ratelimit WHERE k = ?1").bind(k).first();
  const n = row?.count ?? 1;
  return { ok: n <= limitPerMin, count: n };
}

async function pruneRateLimits(db) {
  await db.prepare("DELETE FROM ratelimit WHERE reset_at < ?1").bind(nowSec() - 120).run();
}

async function audit(db, actor, action, detail) {
  await db.prepare(
    "INSERT INTO audit (at, actor, action, detail) VALUES (?1, ?2, ?3, ?4)"
  ).bind(nowSec(), actor ?? null, action, String(detail ?? "").slice(0, 300)).run();
}

export const db_layer = {
  setting, setSetting, allSettings,
  saveConnection, rememberConn, dropConnection, getConnection, allConnections,
  knownConnIds, connWithRight,
  claimUpdate, pruneUpdates,
  saveDraft, getDraft, dropDraft, pruneDrafts,
  setReply, getReply, clearReply,
  listKv, putKv, delKv,
  isBlocked, blockUser, unblockUser, listBlocked,
  getPin, setPin,
  histAdd, histGet, histForget, pruneHistory,
  bumpStat, allStats,
  rateLimit, pruneRateLimits,
  audit,
};
export { now, nowSec };

// Named re-exports as well. `import * as D from "./db.js"` binds the MODULE
// NAMESPACE, so without these D.getConnection(...) would be undefined at
// runtime while tests that destructure { db_layer } still passed.
export {
  setting, setSetting, allSettings,
  saveConnection, rememberConn, dropConnection, getConnection, allConnections,
  knownConnIds, connWithRight,
  claimUpdate, pruneUpdates,
  saveDraft, getDraft, dropDraft, pruneDrafts,
  setReply, getReply, clearReply,
  listKv, putKv, delKv,
  isBlocked, blockUser, unblockUser, listBlocked,
  getPin, setPin,
  histAdd, histGet, histForget, pruneHistory,
  bumpStat, allStats,
  rateLimit, pruneRateLimits,
  audit,
};
