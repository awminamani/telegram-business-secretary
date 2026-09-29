# 🤖 Telegram Business Secretary — Cloudflare Workers

A manual + AI secretary for your personal Telegram account, built on the **official
Bot API Business/Secretary Mode**. Runs on Cloudflare Workers with **webhooks** and
**D1** storage. No userbot, no MTProto, no server to babysit.

Same features as the Python version: DM forwarding with one-tap Reply / AI buttons,
AI auto-replies, keyword rules, quick replies, blocklist, profile editing, a button
control panel, and a live Tehran clock in your account name.

---

## Deploy

```bash
npm install

# 1. create the database and paste the id into wrangler.jsonc
wrangler d1 create secretary
wrangler d1 migrations apply secretary --remote

# 2. secrets (NEVER put these in wrangler.jsonc)
wrangler secret put BOT_TOKEN            # from @BotFather
wrangler secret put WEBHOOK_SECRET       # generate: openssl rand -base64 32 | tr -d '=+/' | head -c 48
wrangler secret put SETUP_TOKEN          # protects /setup, /secret, /audit
wrangler secret put OPENROUTER_API_KEY   # OPTIONAL — only for AI mode

# 3. deploy, then register the webhook once
wrangler deploy
curl -X POST "https://<your-worker>.workers.dev/setup?t=<SETUP_TOKEN>"
```

Then, in Telegram:

1. **@BotFather** → your bot → *Bot Settings* → **Secretary Mode** → on
2. **Settings → Business → Chatbots** → your bot → **Connect** → grant the rights
3. Send `/start` to the bot

`/start` also reports your chat id, which must match `OWNER_ID` in `wrangler.jsonc`.

---

## How it compensates for not using long polling

A long-polling bot gets four things for free. This replaces each one:

| Long-polling gives you | How the Worker replaces it |
|---|---|
| A persistent process | **Stateless + D1.** Connections, drafts, rules, blocklist, history and rate limits all live in D1, so a deploy never loses state. |
| Telegram retries until you answer | **Exactly-once via `processed_updates`.** Every `update_id` is claimed with an `INSERT` before any work; a re-delivery hits a constraint violation and exits. This is what stops a slow LLM call from double-answering a customer. |
| A background loop for the clock | **A cron trigger every minute** rewrites the account name. Same effect, no resident process. |
| Guaranteed ordered delivery | **`ctx.waitUntil()`.** The webhook returns 200 instantly and the slow work (LLM, sends) continues after the response, so Telegram's 60s timeout is never in play. |

Two more that only matter in a serverless world:

- **Connection self-heal.** Telegram only *pushes* a `business_connection` update
  when the link is created or edited. If the bot starts afterwards, that update is
  already gone. So an unknown connection id triggers `getBusinessConnection` and
  registers it on the spot, and startup re-validates every id it has ever seen.
- **Housekeeping on the same cron** — prunes old updates, drafts, rate-limit rows
  and AI history, which keeps D1 (and every write) cheap.

---

## Security

Defence in depth — any one layer alone is not enough:

1. **`X-Telegram-Bot-Api-Secret-Token`** is required and compared in constant time.
   Without it, anyone who learns your Worker URL could inject fake updates. The
   check happens *before* the body is read.
2. **POST only** for `/webhook`; `GET` returns 405.
3. **1 MiB body cap** before parsing, and a D1-backed rate limit per IP (holds
   across isolates) plus a per-chat limit so one spammer can't flood you.
4. **Generic error bodies** — an attacker can't tell a bad token from a bad URL.
5. **One-shot `/setup`** guarded by `SETUP_TOKEN`; it registers the webhook and
   never returns secrets. `GET /status` and `GET /audit` are token-gated too.
6. **`/secret?t=…`** rotates the webhook secret.
7. **Secrets live in `wrangler secret put`**, never in `wrangler.jsonc`. The repo
   has no secrets in it, and `.dev.vars` is gitignored.
8. **Audit log** — privileged actions (mode changes, webhook registration) are
   written to the `audit` table.

The landing page shows status only: no tokens, no ids, no secrets.

---

## Commands

`/panel` opens the button control panel — mode, rules, quick replies, blocklist,
profile, clock, rights and stats, all by tapping.

<details>
<summary>Text commands</summary>

```
/mode manual|ai|off        /panel            button control panel
/clock on <font>|off       /rules add k = r  zero-cost keyword auto-replies
/clock fonts               /quick  name = t  one-tap reply buttons
/name First|Last           /block <id>       ignore a spammer
/bio text                  /unblock <id>
/username name             /pin ai|manual|off  per-thread override
/photo  (with caption)     /cancel           close the open draft
/rmphoto                   /forget           clear AI memory
/rights  /stats  /test  /start  /help
```

</details>

**Modes:** `manual` (DMs come to you with buttons) · `ai` (answers by itself) ·
`off`. Without an API key, `ai` degrades to `manual` instead of dropping DMs, and
`/rules` + `/quick` work with zero AI cost.

---

## Tehran clock

`/clock on mono` appends a 24-hour clock to your name — `Amin · 𝟐𝟏:𝟐𝟗` — updated
every minute by the cron. Your real name is kept and restored by `/clock off`.

11 fonts with live previews: `mono` `hex` `dots` `persian` `sans` `serif` `double`
`circled` `bold` `boxed` `fancy`. Or tap **🕐 Clock** in `/panel`.

Time is always computed from **UTC** (+03:30 fixed — Iran has no DST), so it is
correct regardless of where the Worker runs.

---

## Multi-user

Any account that connects the bot becomes a user, with a plan tier gating the
premium features. **Everything is buttons** — send `/home` (or tap the panel
button) to open your dashboard.

| Tier | Features |
|---|---|
| 🆓 Free | DM forwarding, reply buttons, keyword rules, quick replies, blocklist |
| ⚡ Pro | + profile editing, the Tehran clock in your name |
| 💎 Premium | + AI auto-replies, per-thread mode pin, activity log |

**Users:** pick a font for **your own** account, toggle DM forwarding, switch
modes, manage rules and quick replies. Per-user clock: every user has their own
font and base name, and the tick serves each independently.

**Admins** (you, plus anyone you promote) get a second dashboard: list users,
tap one to grant/revoke/extend their plan, issue a code for a specific person,
generate time-limited codes, read the audit log, see stats.

### Redeem codes
Admins generate codes: choose a tier, a validity window (1h / 1d / 7d / 30d /
never) and optionally bind one to a specific user id. Codes are shown once and
stored **hashed** (HMAC), so a leaked database can't be turned back into working
codes; a fully-used code is erased. Users redeem by tapping **🎟 Redeem a code**
and sending the code — it is case- and dash-insensitive, single-use by default,
and unlocks the features until it expires.

A lapsed plan falls back to **Free** (DM forwarding keeps working), never to
nothing. The owner always has full access.

## Layout

```
src/worker.js    fetch handler: routing + the security gate
src/users.js     multi-user: users, plans, per-user settings, codes
src/plans.js     tier/feature matrix, code generation + HMAC
src/dash.js      the button dashboards (user + admin)
src/multiuser.js dashboard callbacks, guided input, per-user clock
src/handle.js    update handling, modes, commands, callbacks, cron
src/db.js        D1 data layer (every query lives here)
src/telegram.js  Bot API client + secret-token compare
src/clock.js     Tehran time + the 11 digit fonts
src/ai.js        OpenRouter (optional, degrades safely)
src/ui.js        keyboards, panel, /help
schema.sql       D1 schema
migrations/      same schema, applied by wrangler
test/            57 tests: security, idempotency, clock, escaping, real SQL,
                 multi-user plans, code redemption, per-user settings
tools/check_refs.mjs  catches "called but never defined" (e.g. log.info in a
                 module with only console) — passes --check and unit tests, then
                 throws on the first real request
```

```bash
npm test        # 24 tests, incl. every D1 query against real SQLite
```

---

## Notes

- AI mode is a **chat persona with no tools** — it can't check prices or your
  calendar, and it says so rather than inventing answers.
- Free OpenRouter slugs churn. If AI mode goes quiet, change `AI_MODEL` in
  `wrangler.jsonc` or pick another model in the OpenRouter dashboard.
- Only private chats with a message in the last **24h** can be answered — that's
  Telegram's rule, not a limitation here.
