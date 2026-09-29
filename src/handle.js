// ─────────────────────────────────────────────────────────────────────────
// Update handling — the heart of the bot.
//
// WHAT MAKES THIS SAFE WITHOUT LONG POLLING
//   • claimUpdate() makes every update exactly-once, so Telegram's re-delivery
//     on a slow response can never double-answer a customer.
//   • return 200 IMMEDIATELY and do slow work in ctx.waitUntil(). Telegram has a
//     ~60s webhook timeout and retries on non-2xx; we never rely on that.
//   • A cron trigger reconciles the account name (the clock) every minute,
//     standing in for the background loop a long-polling bot runs for free.
//   • ensureConn() re-reads connections from the API whenever the bot meets one
//     it has not seen, so a redeploy never leaves it "not connected".
// ─────────────────────────────────────────────────────────────────────────

import * as D from "./db.js";
import { makeTelegram, esc, sleep } from "./telegram.js";
import {
  clockPreview, buildClockName, stripClock, tehranISO, tehranSeconds, FONT_NAMES,
} from "./clock.js";

const OWNER = (env) => Number(env.OWNER_ID || 0);
const isOwner = (env, id) => !!OWNER(env) && Number(id) === OWNER(env);

const html = (extra = {}) => ({ parse_mode: "HTML", ...extra });

// Callback prefixes handled by the multi-user dashboard layer.
const MULTI_KINDS = new Set([
  "t", "m", "p", "cf", "rd", "qd", "ub", "ra", "qa", "pr", "hx", "x",
  "a", "au", "ap", "ac", "ad", "ng", "nv",
  // announcements: an:<target>  as:go  ah:<id>
  "an", "as", "ah",
]);

// ── connection self-heal ───────────────────────────────────────────────

/** Look up a connection; if unknown, fetch + register it from the API. */
async function ensureConn(db, tg, connId) {
  const known = await D.getConnection(db, connId);
  if (known) return known;
  await D.rememberConn(db, connId);
  try {
    const c = await tg.getBusinessConnection(connId);
    if (!c?.is_enabled) return null;
    const rec = {
      id: c.id,
      user_id: c.user?.id,
      user_chat_id: c.user_chat_id,
      name: c.user?.first_name ? `${c.user.first_name} ${c.user.last_name || ""}`.trim() : "",
      rights: c.rights || {},
    };
    await D.saveConnection(db, rec);
    return rec;
  } catch {
    return null;
  }
}

// ── the two clock buttons ──────────────────────────────────────────────
async function onCallback(ctx, env, db, tg, q) {
  const kind = (q.data || "").split(":")[0];
  const arg = (q.data || "").split(":")[1] || "";
  const uid = q.from?.id;
  const chatId = q.message?.chat?.id;
  // Answer FIRST: a callback query is only valid for a few seconds.
  try { await tg.answerCallback(q.id); } catch { /* expired */ }

  if (kind === "ck" && arg === "toggle") {
    const cur = await D.setting(db, "clock_font", "", uid);
    if (cur) return await turnClockOff(env, db, tg, chatId);
    return await runClock(ctx, env, db, tg, chatId, ["on", "mono"]);
  }
  if (kind === "ck" && arg === "fonts") {
    const rows = FONT_NAMES.map((f) => ([
      { text: `${f}  ${clockPreview(f)}`, callback_data: `cf:${f}` }]));
    rows.push([{ text: "◀️ Back", callback_data: "ck:toggle" }]);
    return tg.sendMessage(chatId, "🎨 <b>Pick a font</b>", html({
      reply_markup: { inline_keyboard: rows } }));
  }
  if (kind === "cf") {
    // apply a font straight from the preview page
    const conns = await D.allConnections(db);
    const c = conns.find((x) => x.rights?.can_edit_name);
    if (!c) return tg.sendMessage(chatId, "❌ can_edit_name not granted.", html());
    if (!(await D.setting(db, "clock_base_name", "", uid))) {
      await D.setSetting(db, "clock_base_name", "Amin", uid);
    }
    const next = buildClockName(await D.setting(db, "clock_base_name", "", uid), arg);
    await D.setSetting(db, "clock_font", arg, uid);
    await D.setSetting(db, "clock_applied", next, uid);
    try { await tg.setBusinessAccountName(c.id, next); }
    catch (e) { return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); }
    return tg.sendMessage(chatId,
      `🕐 Clock <b>ON</b> — your name is now <b>${esc(next)}</b>.\n` +
      `Updates every minute (Tehran).`, html());
  }
}

// ── inbound DMs: nothing is read, stored, forwarded or answered ────────
async function handleBusinessMessage(ctx, env, db, tg, m) {
  // DM forwarding and AI replies were removed. A customer message is marked
  // read (so the badge stays tidy) and then dropped. Nothing is stored.
  const conn = await ensureConn(db, tg, m.business_connection_id);
  if (conn?.rights?.can_read_messages) {
    try {
      await tg.readBusinessMessage(conn.id, m.chat.id, m.message_id);
    } catch { /* non-fatal */ }
  }
}

// ── commands ───────────────────────────────────────────────────────────
// Only the clock is kept. DM forwarding, drafts, AI replies, keyword rules,
// quick replies, the blocklist and the multi-user panel were all removed:
// the bot no longer sees or answers anybody's messages.

const COMMANDS = [
  ["start", "status + clock control"],
  ["clock", "turn the Tehran clock on/off and pick a font"],
  ["help", "what this bot does"],
  ["test", "health check"],
];

async function runCommand(ctx, env, db, tg, chatId, cmd, args) {
  const uid = chatId;
  const font = await D.setting(db, "clock_font", "", uid);

  if (cmd === "start" || cmd === "help") {
    return tg.sendMessage(chatId,
      `🕐 <b>Tehran Clock</b>\n\n` +
      `This bot does one thing: it shows the current Tehran time in your ` +
      `Telegram display name, updated every minute.\n\n` +
      `Status: ${font ? `<b>ON</b> (${esc(font)}) — ${clockPreview(font)}`
                     : "<b>OFF</b>"}\n` +
      `Tehran now: <code>${clockPreview(font || "mono")}</code>\n\n` +
      `<b>Commands</b>\n` +
      `/clock on &lt;font&gt; — turn it on, e.g. <code>/clock on mono</code>\n` +
      `/clock fonts — preview every style\n` +
      `/clock off — remove it, your name returns\n` +
      `/start — this message\n\n` +
      `<i>DM forwarding and AI replies are removed. Nobody's messages are read ` +
      `or answered.</i>`,
      html({ reply_markup: { inline_keyboard: [
        [{ text: font ? "🔴 Clock OFF" : "🕐 Turn clock ON", callback_data: "ck:toggle" }],
        [{ text: "🎨 Fonts", callback_data: "ck:fonts" }],
      ] } }));
  }

  if (cmd === "test") {
    return tg.sendMessage(chatId,
      `✅ Online\nClock: ${font ? `<code>${esc(font)}</code> ${clockPreview(font)}` : "<b>off</b>"}\n` +
      `Tehran: <code>${tehranISO()}</code>\n` +
      `DM forwarding: <b>removed</b>\nAI replies: <b>removed</b>`,
      html());
  }

  if (cmd === "clock") return runClock(ctx, env, db, tg, chatId, args);

  return tg.sendMessage(chatId, "Unknown command. Send /start.", html());
}

// ── the clock (also runs from cron) ────────────────────────────────────

async function runClock(ctx, env, db, tg, chatId, args) {
  const a = (args[0] || "").toLowerCase();
  if (!a) {
    const cur = await D.setting(db, "clock_font", "");
    return tg.sendMessage(chatId,
      cur ? `🕐 <b>ON</b> — font: <code>${esc(cur)}</code>\nPreview: ${clockPreview(cur)}`
          : `🕐 <b>OFF</b>\n\nUse <code>/clock fonts</code> to see every style.`,
      html());
  }
  if (a === "fonts") {
    const cur = await D.setting(db, "clock_font", "");
    const rows = FONT_NAMES.map((f) =>
      `${f === cur ? "✅ " : ""}<code>${f}</code> — ${clockPreview(f)}`);
    return tg.sendMessage(chatId, `🕐 <b>Font previews</b> (live Tehran time)\n\n${rows.join("\n")}`, html());
  }
  if (a === "off") return turnClockOff(env, db, tg, chatId);
  if (a === "" || a === "on") {
    const cur = await D.setting(db, "clock_font", "", uid);
    return tg.sendMessage(chatId,
      cur ? `🕐 Clock <b>ON</b> — font <code>${esc(cur)}</code> ${clockPreview(cur)}\n\n` +
           `<b>Change it</b>\n` +
           `/clock on &lt;font&gt; e.g. <code>/clock on mono</code>\n` +
           `/clock fonts — preview all\n` +
           `/clock off — remove it`
         : `🕐 Clock is <b>OFF</b>.\n\nTurn it on:\n` +
           `<code>/clock on mono</code>  ·  or send <code>/clock fonts</code>`,
      html());
  }

  let font = a === "on" ? (args[1] || "").toLowerCase() : a;
  if (!FONT_NAMES.includes(font)) {
    return tg.sendMessage(chatId, "❌ Use: /clock on &lt;font&gt; · /clock off · /clock fonts", html());
  }
  const c = await D.connWithRight(db, "can_edit_name");
  if (!c) {
    return tg.sendMessage(chatId, "❌ can_edit_name not granted — grant it in Telegram → Business → Chatbots.", html());
  }
  let base = await D.setting(db, "clock_base_name", "");
  if (!base) {
    try {
      const info = await tg.getBusinessConnection(c.id);
      base = stripClock(info.user?.first_name || "").slice(0, 64);
      await D.setSetting(db, "clock_base_name", base);
    } catch { base = ""; }
  }
  const next = buildClockName(base, font);
  await D.setSetting(db, "clock_font", font);
  await D.setSetting(db, "clock_applied", next);
  try {
    await tg.setBusinessAccountName(c.id, next);
  } catch (e) {
    return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html());
  }
  return tg.sendMessage(chatId,
    `🕐 Clock <b>ON</b> — updates every minute (Tehran).\nName: <b>${esc(next)}</b>\n` +
    `<i>Your original name is kept and restored by /clock off</i>`, html());
}

async function turnClockOff(env, db, tg, chatId) {
  let base = stripClock(await D.setting(db, "clock_base_name", "") || "");
  // clear FIRST so the cron pass stops writing, then restore
  await D.setSetting(db, "clock_font", "");
  await D.setSetting(db, "clock_applied", "");
  const c = await D.connWithRight(db, "can_edit_name");
  if (!c) return tg.sendMessage(chatId, `🕐 Clock removed. Name: <b>${esc(base || "—")}</b>`, html());
  if (!base) {
    try {
      const info = await tg.getBusinessConnection(c.id);
      base = stripClock(info.user?.first_name || "");
    } catch { return tg.sendMessage(chatId, "🕐 Clock off.", html()); }
  }
  try {
    await tg.setBusinessAccountName(c.id, (base || " ").slice(0, 64));
  } catch { /* reported below */ }
  await D.setSetting(db, "clock_base_name", base);
  return tg.sendMessage(chatId, `🕐 Clock <b>removed</b> from your name.\nYour name: <b>${esc(base || "—")}</b>`, html());
}

// ── the panel renderer ─────────────────────────────────────────────────



// ── callback router ────────────────────────────────────────────────────



// ── top-level update dispatch ──────────────────────────────────────────

export async function handleUpdate(ctx, env, update) {
  const { DB } = env;
  const tg = makeTelegram(env.BOT_TOKEN);
  tg.__token = env.BOT_TOKEN;

  // exactly-once: Telegram re-delivers on a slow response
  if (!(await D.claimUpdate(DB, update.update_id))) return;

  const m = update.message;
  try {
    // Keep the connection registry fresh — the clock needs a connection that
    // was granted can_edit_name.
    if (update.business_connection) {
      const c = update.business_connection;
      if (c.is_enabled) {
        await D.saveConnection(DB, {
          id: c.id,
          user_id: c.user?.id,
          user_chat_id: c.user_chat_id,
          name: c.user?.first_name
            ? `${c.user.first_name} ${c.user.last_name || ""}`.trim() : "",
          rights: c.rights || {},
        });
        console.log("connected", c.user?.first_name, c.id.slice(0, 12));
      } else {
        await D.dropConnection(DB, c.id);
        console.log("disconnected", c.id.slice(0, 12));
      }
      return;
    }

    if (update.callback_query) {
      return await onCallback(ctx, env, DB, tg, update.callback_query);
    }

    // Inbound DMs: marked read and then dropped. Nothing is stored, forwarded,
    // logged, or answered.
    if (update.business_message) {
      await handleBusinessMessage(ctx, env, DB, tg, update.business_message);
      return;
    }

    if (m && m.text) {
      const text = m.text.trim();
      if (text.startsWith("/clock") || text.startsWith("/start") ||
          text.startsWith("/help") || text.startsWith("/test")) {
        const parts = text.slice(1).split(/\s+/);
        const cmd = parts[0].split("@")[0].toLowerCase();
        return await runCommand(ctx, env, DB, tg, m.chat.id, cmd, parts.slice(1));
      }
    }
  } catch (e) {
    // The HTTP response is already 200 and a retry would double-deliver, so
    // swallow here and leave one audit row as the only trace.
    await D.audit(DB, null, "update.error", `${update.update_id}: ${e.message}`);
    console.error("update failed", update.update_id, e);
  }
}
// ── the tick: clock + housekeeping ────────────────────────────────────
// Runs from the cron trigger AND from /health or /tick, because a scheduled
// trigger can fail to attach (missing scope, or a deploy that drops it). Being
// able to drive it from ordinary traffic is what makes the clock self-healing.

export async function runTick(env) {
  const { DB } = env;
  const nowS = Math.floor(Date.now() / 1000);
  const out = { clock: "off", wrote: false, housekeeping: false, skew_s: 0 };

  // Everything the tick needs in ONE round trip. The previous version issued
  // four separate settings reads plus a connections read on every tick; this
  // batches them, which is where most of the D1 request savings come from.
  const s = await D.tickState(DB);

  // ── skew: how far into the Tehran minute this tick landed ──
  // 0 = perfect (fired at :00). Cron granularity means this is usually 1-50.
  // Deriving it from the timezone-converted seconds field keeps the units
  // straight; mixing a minute value with an epoch remainder does not.
  out.skew_s = tehranSeconds();

  // ── housekeeping, at most once a minute no matter how often /health is hit ──
  if (nowS - Number(s.last_cron || 0) >= 60) {
    await D.pruneUpdates(DB);
    await D.pruneDrafts(DB, Number(env.DRAFT_TTL_HOURS || 72));
    await D.pruneRateLimits(DB);
    await D.pruneHistory(DB);
    await D.setSetting(DB, "last_cron", String(nowS));
    out.housekeeping = true;
  }

  // ── the clock: one job per user who enabled it ──
  // Each user has their own scoped clock_font/clock_base_name, so the tick
  // serves every clock independently instead of a single global one.
  const jobs = await D.clockJobs(DB);
  out.clock_users = jobs.length;
  if (!jobs.length) return out;

  for (const job of jobs) {
    const want = buildClockName(stripClock(job.base), job.font);
    if (want === (await D.setting(DB, "clock_applied", "", job.uid))) continue;
    try {
      const tg = makeTelegram(env.BOT_TOKEN);
      await tg.setBusinessAccountName(job.connId, want);
      await D.setSetting(DB, "clock_applied", want, job.uid);
      out.wrote = (out.wrote || 0) + 1;
    } catch (e) {
      out.clock_error = e.message;
      console.warn("clock tick failed", job.uid, e.message);
    }
  }
  return out;
}

export async function handleScheduled(ctx, env) {
  const out = await runTick(env);

  // ── accuracy: correct a late tick ──
  // Cron granularity means a tick can land anywhere in the minute. If it landed
  // in the second half, the name it just wrote is already behind. Re-tick near
  // the top of the next minute so the visible time is never more than a few
  // seconds stale. Cheap: runTick() is a no-op when the rendered name matches.
  const nowS = Math.floor(Date.now() / 1000);
  const secInMinute = tehranSeconds();   // must match what the clock displays
  // Past 20s the tick is visibly behind, so always re-tick at the top of the
  // next minute. That is what pulls the displayed time back to :00-ish instead
  // of leaving it tens of seconds stale for the whole minute.
  if (secInMinute >= 20 && env.CATCH_UP !== "off") {
    const delayMs = (60 - secInMinute + 2) * 1000;
    if (ctx?.waitUntil) {
      ctx.waitUntil((async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        await runTick(env);
      })());
      out.catch_up_in_s = Math.round(delayMs / 1000);
    }
  }
  return out;
}

export { tehranISO, COMMANDS };
