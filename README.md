# 🕐 Tehran Clock — Telegram Business Bot

One job only: it shows the current **Tehran time in your Telegram display
name**, updated every minute.

Runs on Cloudflare Workers with **webhooks** and **D1**. No userbot, no
long polling, no server to maintain.

## What it does NOT do

- ❌ No DM forwarding
- ❌ No AI auto-replies
- ❌ No reading, storing, or answering anyone's private messages

An inbound DM is marked read and then dropped. Nobody receives a message the
bot wrote on its own. These are enforced by tests, not just by intention.

## Setup

```bash
npm install
wrangler d1 migrations apply secretary --remote
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET     # openssl rand -base64 32 | tr -d '=+/' | head -c 40
wrangler deploy
curl -X POST "https://<worker>/setup?t=<WEBHOOK_SECRET>"
```

Then in Telegram: **@BotFather → Secretary Mode ON**, and
**Settings → Business → Chatbots → connect this bot** (grant *change name*).

## Commands

```
/start          status + the clock buttons
/clock          show state, or list the options
/clock fonts    live preview of all 11 fonts
/clock on mono  turn it on with a font
/clock off      remove it — your name returns exactly as it was
```

Your real name is **kept and appended to**, never replaced:
`Amin · 𝟐𝟏:𝟑𝟓`. `/clock off` restores `Amin`.

## Fonts

`mono` `sans` `serif` `double` `circled` `bold` `hex` `boxed` `dots` `persian` `fancy`

24-hour, no AM/PM. Time is always computed from **UTC** (+03:30, Iran has no
DST), so it is correct regardless of where the Worker runs.

## How it works

| Long polling gives you | This uses |
|---|---|
| a resident process | stateless Worker + D1 |
| retries until answered | a `processed_updates` claim table (exactly-once) |
| a background loop | a cron trigger every minute |
| patient delivery | 200 immediately + `ctx.waitUntil()` |

## Security

- `secret_token` on `setWebhook`, compared in constant time **before** the body
  is read — without it, anyone who learns the URL could inject fake updates
- POST only, 1 MiB body cap, per-IP rate limit held in D1
- generic error bodies, so an attacker learns nothing
- secrets only via `wrangler secret put`

## Layout

```
src/worker.js   fetch handler, routes, the security gate
src/handle.js   update dispatch, the clock commands, the per-minute tick
src/db.js       D1 data layer
src/clock.js    Tehran time + the 11 digit fonts
src/telegram.js Bot API client + secret compare
test/           10 tests, incl. "no DM forwarding, no AI reply anywhere"
tools/          check_refs.mjs (catches calls to things that don't exist)
```

```bash
npm test
```
