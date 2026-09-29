// ─────────────────────────────────────────────────────────────────────────
// Telegram Business Secretary — Cloudflare Worker (webhooks + D1).
//
// SETUP
//   1. npm install
//   2. wrangler d1 create secretary            → copy the id into wrangler.jsonc
//   3. wrangler d1 migrations apply secretary --remote
//   4. wrangler secret put BOT_TOKEN
//   5. wrangler secret put WEBHOOK_SECRET
//   6. wrangler secret put OPENROUTER_API_KEY   (optional — AI mode only)
//   7. wrangler deploy
//   8. visit /setup once to register the webhook, then destroy /setup access
//
// SECURITY — defence in depth on the update endpoint:
//   • X-Telegram-Bot-Api-Secret-Token must match WEBHOOK_SECRET (constant-time).
//     Without this, anyone who guesses your URL could inject fake updates.
//   • POST only for updates; everything else is GET.
//   • Hard body-size cap before parsing.
//   • Per-IP rate limit held in D1 (survives isolates and deploys).
//   • /setup is a one-shot bootstrap: it refuses once the webhook is live and
//     compares a token, so a leaked URL cannot re-register anything.
//   • Secrets come from `wrangler secret put`, never from wrangler.jsonc.
// ─────────────────────────────────────────────────────────────────────────

import { makeTelegram, safeEqual, makeSecret, validSecret, esc } from "./telegram.js";
import { handleUpdate, handleScheduled, runTick, COMMANDS } from "./handle.js";
import { tehranISO, clockPreview } from "./clock.js";
import * as D from "./db.js";

const MAX_BODY = 1_048_576;      // 1 MiB — Telegram updates are tiny
const ALLOWED_UPDATES = [
  "message", "edited_message", "callback_query", "business_connection",
  "business_message", "edited_business_message", "deleted_business_messages",
];

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

const html = (s, status = 200) =>
  new Response(s, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });

const LANDING = (tehran, ready, conns, mode) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Business Secretary</title>
<style>
 body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;
      margin:0 auto;padding:32px 20px;background:#0b1220;color:#e6edf7}
 h1{font-size:1.4rem;margin:0 0 4px}
 .sub{color:#8aa0bd;font-size:.9rem;margin-bottom:24px}
 .card{background:#131c2e;border:1px solid #1f2d45;border-radius:12px;padding:16px 18px;margin:12px 0}
 .k{color:#8aa0bd;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}
 .v{font-size:1.3rem;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
 .ok{color:#4ade80}.bad{color:#f87171}
 code{background:#1b2537;padding:2px 6px;border-radius:5px;font-size:.85em}
 ol{padding-left:20px} li{margin:7px 0}
</style></head><body>
<h1>🤖 Business Secretary</h1>
<div class="sub">Telegram Business API · Cloudflare Worker · webhooks + D1</div>
<div class="card"><div class="k">Tehran time</div><div class="v">${tehran}</div></div>
<div class="card"><div class="k">Webhook</div>
  <div class="v ${ready ? "ok" : "bad"}">${ready ? "registered" : "not registered"}</div></div>
<div class="card"><div class="k">Mode</div><div class="v">${esc(mode)}</div>
  <div class="k" style="margin-top:10px">Connected accounts</div><div class="v">${conns}</div></div>
<div class="card"><b>Finish setup</b>
<ol>
 <li>BotFather → your bot → <b>Bot Settings → Secretary Mode</b> → on</li>
 <li>Telegram → <b>Settings → Business → Chatbots</b> → this bot → Connect</li>
 <li>Send <code>/start</code> to the bot</li>
</ol>
<div class="sub">No tokens or secrets are shown on this page.</div></div>
</body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS: this API is server-to-server, no browser callers ──
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
      // ── 1. the update endpoint ──
      if (url.pathname === "/webhook") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "method not allowed" }, 405,
                       { allow: "POST" });
        }

        // 2. authenticate BEFORE reading the body
        const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
        if (!env.WEBHOOK_SECRET) {
          return json({ ok: false, error: "server not configured" }, 503);
        }
        if (!safeEqual(provided, env.WEBHOOK_SECRET)) {
          // generic body: do not reveal whether the token or the URL was wrong
          return json({ ok: false, error: "unauthorized" }, 401);
        }

        // 3. cheap DDoS guard before spending any parse/DB work
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const rl = await D.rateLimit(env.DB, `ip:${ip}`, 240);
        if (!rl.ok) return json({ ok: false, error: "rate limited" }, 429);

        // 4. size cap, then parse defensively
        const len = Number(request.headers.get("content-length") || "0");
        if (len > MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);

        let raw = await request.text();
        if (raw.length > MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);

        let update;
        try { update = JSON.parse(raw); }
        catch { return json({ ok: false, error: "bad json" }, 400); }
        if (!update || typeof update !== "object" || update.update_id == null) {
          return json({ ok: false, error: "not an update" }, 400);
        }

        // 5. per-chat guard so one spammer cannot flood the owner
        if (update.business_message) {
          const c = String(update.business_message.chat?.id ?? "");
          const crl = await D.rateLimit(env.DB, `chat:${c}`, Number(env.RATE_LIMIT_PER_MIN || 20));
          if (!crl.ok) return json({ ok: true, ignored: "rate limited" });
        }

        // 6. answer IMMEDIATELY; the LLM/send work continues in waitUntil so a
        //    slow response can never make Telegram re-deliver this update.
        ctx.waitUntil(
          handleUpdate(ctx, env, update).catch(async (e) => {
            console.error("handler crashed", e);
            await D.audit(env.DB, null, "update.crash", String(e?.message || e));
          })
        );
        return json({ ok: true });
      }

      // ── 5. one-shot webhook bootstrap ──
      if (url.pathname === "/setup") {
        if (request.method !== "POST") {
          return json({
            ok: true,
            howto: "curl -X POST <this-url>/setup   (run once after deploy)",
            webhook_status: await webhookStatus(env),
          });
        }
        if (!env.SETUP_TOKEN || !safeEqual(url.searchParams.get("t") || "", env.SETUP_TOKEN)) {
          return json({ ok: false, error: "bad or missing ?t= token" }, 403);
        }
        const tg = makeTelegram(env.BOT_TOKEN);
        const me = await tg.getMe();
        const hook = `${url.origin}/webhook`;
        const res = await tg.setWebhook(hook, env.WEBHOOK_SECRET, {
          allowedUpdates: ALLOWED_UPDATES,
          dropPending: false,               // never drop business_connection
          maxConnections: Number(env.WEBHOOK_MAX_CONNECTIONS || 10),
        });
        await D.setSetting(env.DB, "webhook_set_at", String(Math.floor(Date.now() / 1000)));
        await D.audit(env.DB, null, "webhook.registered", hook);
        // first-run niceties that do not block the response
        ctx.waitUntil(tg.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description }))));
        return json({
          ok: true, bot: `@${me.username}`, webhook: hook,
          can_connect_to_business: me.can_connect_to_business,
          secret_length: (env.WEBHOOK_SECRET || "").length,
          next: "BotFather → Secretary Mode ON, then Settings → Business → Chatbots",
        });
      }

      if (url.pathname === "/secret") {
        // rotate the webhook secret; requires SETUP_TOKEN
        if (request.method !== "POST") return json({ ok: true, howto: "POST /secret?t=<SETUP_TOKEN>" });
        if (!env.SETUP_TOKEN || !safeEqual(url.searchParams.get("t") || "", env.SETUP_TOKEN)) {
          return json({ ok: false, error: "forbidden" }, 403);
        }
        const fresh = makeSecret(32);
        const tg = makeTelegram(env.BOT_TOKEN);
        await tg.setWebhook(`${url.origin}/webhook`, fresh, {
          allowedUpdates: ALLOWED_UPDATES, dropPending: false,
        });
        // NOTE: also run `wrangler secret put WEBHOOK_SECRET` with the same value
        return json({
          ok: true,
          new_secret: fresh,
          warning: "save this, then run: wrangler secret put WEBHOOK_SECRET",
        });
      }

      if (url.pathname === "/status") {
        const tg = makeTelegram(env.BOT_TOKEN);
        let me = null;
        try { me = await tg.getMe(); } catch (e) { me = { error: e.message }; }
        return json({
          bot: me && me.username ? `@${me.username}` : me,
          can_connect_to_business: me?.can_connect_to_business,
          tehran: tehranISO(),
          clock: clockPreview(await D.setting(env.DB, "clock_font", "") || "mono"),
          clock_font: await D.setting(env.DB, "clock_font", "") || "off",
          connections: (await D.allConnections(env.DB)).length,
          dm_forwarding: "removed",
          ai_replies: "removed",
        });
      }

      if (url.pathname === "/health") {
        // Uptime monitors hit this constantly, so let it drive the clock too:
        // if the cron trigger failed to attach, traffic alone keeps time fresh.
        const tick = await runTick(env);
        return json({ ok: true, tehran: tehranISO(), ...tick });
      }

      // ── cron fallback ──────────────────────────────────────────────────
      // A scheduled trigger is the intended clock driver, but it can fail to
      // attach (a token without the right scope, or a deploy that drops the
      // trigger). This endpoint makes the clock self-healing: ANY request can
      // drive the tick, and /health is polled by uptime checks anyway.
      if (url.pathname === "/tick") {
        const res = await runTick(env);
        return json({ ok: true, ...res });
      }

      // landing page
      if (request.method !== "GET") return json({ ok: false, error: "not found" }, 404);
      const conns = (await D.allConnections(env.DB)).length;
      return html(LANDING(
        tehranISO(),
        !!(await webhookStatus(env)),
        conns,
        await D.setting(env.DB, "mode", "manual"),
      ));
    } catch (e) {
      console.error("worker error", e);
      return json({ ok: false, error: "internal" }, 500);
    }
  },

  // the cron that stands in for a long-polling bot's background loop
  async scheduled(event, env, ctx) {
    try {
      await handleScheduled(ctx, env);
    } catch (e) {
      console.error("scheduled failed", e);
    }
  },
};

async function webhookStatus(env) {
  try {
    const tg = makeTelegram(env.BOT_TOKEN);
    const info = await tg.getWebhookInfo();
    return !!info?.url;
  } catch {
    return false;
  }
}
