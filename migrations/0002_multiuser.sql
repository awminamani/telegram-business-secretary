-- Multi-user: plans, redeem codes, roles, and per-user settings.
-- Everything before this was single-owner: one OWNER_ID and one global
-- "clock_font" setting. Per-user state is now keyed "<name>:<user_id>" in
-- `settings`, so two accounts never share a clock or a mode.

-- ── who is using the bot ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,
  username    TEXT,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  is_owner    INTEGER NOT NULL DEFAULT 0,     -- the deploying admin, always admin
  note        TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);

-- ── plans / feature entitlements ──────────────────────────────────────
-- One row per user. `expires_at` 0 = never expires (admin/self-serve).
-- `tier` gates features via the FEATURES map in src/plans.js.
CREATE TABLE IF NOT EXISTS plans (
  user_id     INTEGER PRIMARY KEY,
  tier        TEXT NOT NULL DEFAULT 'free',
  started_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL DEFAULT 0,     -- 0 = lifetime
  granted_by  INTEGER,                        -- admin id, or NULL if self-served
  note        TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_exp ON plans(expires_at);

-- ── redeem codes ──────────────────────────────────────────────────────
-- `code_hash` is what we store and verify (HMAC of the code + a per-code
-- nonce), so a leaked database cannot be turned back into working codes.
-- `code_plain` is kept ONLY so the admin dashboard can re-display a code
-- they generated; it is nulled once fully redeemed.
CREATE TABLE IF NOT EXISTS codes (
  code_hash    TEXT PRIMARY KEY,              -- HMAC(secret, code)
  code_plain   TEXT,                          -- shown once in the admin UI
  tier         TEXT NOT NULL DEFAULT 'pro',
  max_uses     INTEGER NOT NULL DEFAULT 1,
  uses         INTEGER NOT NULL DEFAULT 0,
  bound_user   INTEGER,                       -- redeemable only by this user
  expires_at   INTEGER NOT NULL DEFAULT 0,    -- 0 = never expires
  created_by   INTEGER NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_created ON codes(created_at);

CREATE TABLE IF NOT EXISTS code_uses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_uses_hash ON code_uses(code_hash);
CREATE INDEX IF NOT EXISTS idx_code_uses_user ON code_uses(user_id);

-- ── per-chat mode overrides become per-user too ───────────────────────
-- pins.k already carries "<conn_id>:<chat_id>" so it is already per-account.
