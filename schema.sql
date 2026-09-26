-- Telegram Business Secretary on Cloudflare Workers — D1 schema
-- Everything is durable because Workers are stateless: a deploy wipes memory,
-- and a business bot that "forgets" it is connected is the classic failure.

-- ── singleton key/value settings (mode, clock font, base name, etc.) ──
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- ── business connection registry ──────────────────────────────────────
-- Persisted so a redeploy never loses the link. business_connection_id is
-- base64url (it CONTAINS "_"), so it is never parsed by splitting.
CREATE TABLE IF NOT EXISTS connections (
  conn_id      TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  user_chat_id INTEGER,
  name         TEXT,
  rights       TEXT,               -- JSON of granted BusinessBotRights
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conn_user ON connections(user_id);

-- every connection id ever seen, so a restart can re-validate via
-- getBusinessConnection (Telegram only PUSHES business_connection on change)
CREATE TABLE IF NOT EXISTS known_connections (
  conn_id  TEXT PRIMARY KEY,
  seen_at  INTEGER NOT NULL
);

-- ── idempotency: THE critical webhook compensation ───────────────────
-- Telegram re-delivers an update when the response is slow or non-2xx. Without
-- this table the bot answers the same DM twice.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id  INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_updates(at);

-- ── drafts + the single open reply ────────────────────────────────────
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,     -- short opaque id for callback_data
  customer_id  INTEGER NOT NULL,
  conn_id      TEXT NOT NULL,
  name         TEXT,
  username     TEXT,
  msg_id       INTEGER,
  text         TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_at ON drafts(at);

CREATE TABLE IF NOT EXISTS reply_state (
  owner_id    INTEGER PRIMARY KEY,
  draft_id    TEXT,
  conn_id     TEXT,
  customer_id INTEGER,
  name        TEXT,
  mode        TEXT,                  -- null = manual, 'ai' = let the AI write
  at          INTEGER NOT NULL
);

-- ── zero-cost automation (work with no API key) ───────────────────────
CREATE TABLE IF NOT EXISTS rules (
  kw     TEXT PRIMARY KEY,
  reply  TEXT NOT NULL,
  at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quick (
  name  TEXT PRIMARY KEY,
  text  TEXT NOT NULL,
  at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked (
  customer_id TEXT PRIMARY KEY,
  at          INTEGER NOT NULL
);

-- per-thread mode override, keyed "<conn_id>:<chat_id>"
CREATE TABLE IF NOT EXISTS pins (
  k     TEXT PRIMARY KEY,
  mode  TEXT NOT NULL,
  at    INTEGER NOT NULL
);

-- ── AI conversation memory (bounded) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS history (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  k        TEXT NOT NULL,
  role     TEXT NOT NULL,
  content  TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_k ON history(k, at);

-- ── counters ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stats (
  k   TEXT PRIMARY KEY,
  v   INTEGER NOT NULL DEFAULT 0
);

-- ── rate limiting (D1-backed, so it holds across isolates) ────────────
CREATE TABLE IF NOT EXISTS ratelimit (
  k         TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
);

-- ── audit trail for anything privileged ──────────────────────────────
CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   INTEGER,
  action  TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
