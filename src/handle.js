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
import { aiReply, aiReady } from "./ai.js";
import * as UI from "./ui.js";
import {
  clockPreview, buildClockName, stripClock, tehranISO, tehranSeconds, FONT_NAMES,
} from "./clock.js";

const OWNER = (env) => Number(env.OWNER_ID || 0);
const isOwner = (env, id) => !!OWNER(env) && Number(id) === OWNER(env);

const html = (extra = {}) => ({ parse_mode: "HTML", ...extra });

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

// ── the forwarded DM ───────────────────────────────────────────────────

async function forwardToOwner(ctx, env, db, tg, conn, m) {
  const customerId = m.chat.id;
  const name = m.chat.full_name || m.chat.title || m.from_user?.first_name || "Unknown";
  const username = m.from_user?.username || m.chat?.username || "";
  const body = m.text || m.caption || "";
  const dId = D.draftId(customerId, conn.id);

  await D.saveDraft(db, {
    id: dId, customer_id: customerId, conn_id: conn.id, name, username,
    msg_id: m.message_id, text: body,
  });

  const head = UI.dmHeader({ name, username, customerId, text: "" });
  const quickRows = await D.listKv(db, "quick");
  const markup = UI.dmKeyboard(dId, quickRows);

  const text = `${head}${body}`;
  const common = { ...html({ reply_markup: markup }) };
  common.reply_markup.inline_keyboard.push([UI.profileButton(username, customerId)]);

  const send = async () => {
    if (m.text) return tg.sendMessage(OWNER(env), text, common);
    if (m.photo) return tg.sendPhoto(OWNER(env), m.photo.at(-1).file_id, { ...common, caption: `${head}🖼️ Photo${m.caption ? "\n" + m.caption : ""}` });
    if (m.voice) return tg.sendVoice(OWNER(env), m.voice.file_id, { ...common, caption: `${head}🎙️ Voice` });
    if (m.video) return tg.sendVideo(OWNER(env), m.video.file_id, { ...common, caption: `${head}🎬 Video` });
    if (m.document) return tg.sendDocument(OWNER(env), m.document.file_id, { ...common, caption: `${head}📄 ${m.document.file_name || "document"}` });
    if (m.audio) return tg.sendAudio(OWNER(env), m.audio.file_id, { ...common, caption: `${head}🎵 Audio` });
    if (m.sticker) return tg.sendSticker(OWNER(env), m.sticker.file_id, { ...common });
    return tg.sendMessage(OWNER(env), `${head}📦 media`, common);
  };
  return send();
}

async function handleBusinessMessage(ctx, env, db, tg, m) {
  const conn = await ensureConn(db, tg, m.business_connection_id);
  if (!conn) return;
  if (!conn.rights?.can_reply) return;
  if (OWNER(env) && m.from_user?.id === OWNER(env)) return;   // never echo the owner

  // ── DM listening off ──
  // Swallow silently: the message is still marked read (so the owner's badge is
  // tidy) but they are never pinged and the customer is never auto-answered.
  // The bot itself stays fully alive for commands, the panel and the clock.
  if ((await D.setting(db, "listen_dm", "on")) === "off") {
    log.info(`[dm listening off] ignored a DM from ${m.chat?.id}`);
    if (conn.rights?.can_read_messages) {
      try {
        await tg.readBusinessMessage(conn.id, m.chat.id, m.message_id);
      } catch { /* non-fatal */ }
    }
    return;
  }

  if (await D.isBlocked(db, m.chat.id)) {
    await D.bumpStat(db, "blocked");
    return;
  }
  await D.bumpStat(db, "dms");

  if (conn.rights?.can_read_messages) {
    try {
      await tg.readBusinessMessage(conn.id, m.chat.id, m.message_id);
    } catch { /* non-fatal */ }
  }

  const pinKey = `${conn.id}:${m.chat.id}`;
  const mode = (await D.getPin(db, pinKey)) || (await D.setting(db, "mode", "manual"));
  if (mode === "off") return;

  const text = m.text || m.caption || "";

  // rule hit: instant, free, and needs no AI
  if (text) {
    const rules = await D.listKv(db, "rules");
    const lower = text.toLowerCase();
    const hit = rules.find((r) => lower.includes(String(r.kw).toLowerCase()));
    if (hit) {
      await D.bumpStat(db, "rules");
      try {
        await tg.sendMessage(m.chat.id, hit.reply, { business_connection_id: conn.id });
        if ((await D.setting(db, "notify_ai", "1")) === "1") {
          await tg.sendMessage(OWNER(env), `⚡ Rule answered for <b>${esc(m.chat.full_name || "user")}</b>:\n${esc(hit.reply)}`, html());
        }
      } catch { /* reported upstream */ }
      return;
    }
  }

  // AI mode — but degrade to manual when there is no key rather than dropping DMs
  let effective = mode;
  if (effective === "ai" && !aiReady(env)) {
    effective = "manual";
    await D.setSetting(db, "mode", "manual");
  }
  if (effective === "ai") {
    if (!text) return forwardToOwner(ctx, env, db, tg, conn, { ...m, text: `${text}📦 media`, caption: null });
    const key = `${conn.id}:${m.chat.id}`;
    const cdKey = String(m.chat.id);
    const last = Number(await D.setting(db, `cd:${cdKey}`, "0"));
    if (Date.now() / 1000 - last < Number(env.COOLDOWN_SECONDS || 2)) return;
    await D.setSetting(db, `cd:${cdKey}`, String(Math.floor(Date.now() / 1000)));
    await D.histAdd(db, key, "user", text);

    let stop = false;
    const typing = (async () => {
      while (!stop) {
        try { await tg.sendChatAction(m.chat.id, "typing", conn.id); } catch { break; }
        await sleep(4000);
      }
    })();

    const reply = await aiReply(env, { history: await D.histGet(db, key), text });
    stop = true;
    await typing;

    if (!reply) {
      return forwardToOwner(ctx, env, db, tg, conn,
        { ...m, text: `⚠️ ${aiReady(env) ? "AI returned nothing" : "AI is off (no API key)"}\n${text}`, caption: null });
    }
    await D.histAdd(db, key, "assistant", reply);
    await sleepJitter(env);
    try {
      // no parse_mode: an LLM stray "_" must never cost us the reply
      await tg.sendMessage(m.chat.id, reply, { business_connection_id: conn.id });
      await D.bumpStat(db, "ai");
      if ((await D.setting(db, "notify_ai", "1")) === "1") {
        await tg.sendMessage(OWNER(env), `🤖 AI → <b>${esc(m.chat.full_name || "user")}</b>\n${esc(reply)}`, html());
      }
    } catch (e) {
      return forwardToOwner(ctx, env, db, tg, conn, { ...m, text: `⚠️ send failed: ${e.message}`, caption: null });
    }
    return;
  }

  // manual
  return forwardToOwner(ctx, env, db, tg, conn, m);
}

async function sleepJitter(env) {
  const lo = Number(env.HUMAN_DELAY_MIN || 0.8) * 1000;
  const hi = Number(env.HUMAN_DELAY_MAX || 2.4) * 1000;
  await sleep(lo + Math.random() * (hi - lo));
}

// ── owner messages / commands ──────────────────────────────────────────

async function deliverReply(ctx, env, db, tg, st, text) {
  try {
    await tg.sendMessage(st.customer_id, text, { business_connection_id: st.conn_id });
    await D.bumpStat(db, "manual");
    await D.clearReply(db, OWNER(env));
    await tg.sendMessage(OWNER(env), "✅ Delivered.");
    return true;
  } catch (e) {
    // keep the draft open so the owner can retry
    await tg.sendMessage(OWNER(env), `❌ Delivery failed: ${esc(e.message)}`);
    return false;
  }
}

async function handleOwnerText(ctx, env, db, tg, m) {
  const owner = OWNER(env);

  // guided input from the panel (Add rule / Add quick / profile fields)
  const awaitKey = await D.setting(db, "_await", "");
  if (awaitKey && m.text) {
    await D.setSetting(db, "_await", "");
    const raw = m.text.trim();
    const [what, ...restRaw] = awaitKey.split("|");
    const val = restRaw.join("|");
    if (what === "rule" || what === "quick") {
      const idx = raw.indexOf("=");
      if (idx < 0) {
        return tg.sendMessage(owner, "❌ Format:  <code>keyword = reply</code>", html());
      }
      const k = raw.slice(0, idx).trim();
      const v = raw.slice(idx + 1).trim();
      await D.putKv(db, what, what === "rule" ? k.toLowerCase() : k.slice(0, 20), v);
      await tg.sendMessage(owner, `✅ Saved <b>${esc(k)}</b>`, html());
      return;
    }
    const conn = await D.connWithRight(db, what === "/username" ? "can_edit_username" : "can_edit_bio");
    if (what === "/name") {
      const c = await D.connWithRight(db, "can_edit_name");
      if (!c) return tg.sendMessage(owner, "❌ can_edit_name not granted.");
      const [first, last] = val.split("|").map((s) => s.trim());
      try {
        await tg.setBusinessAccountName(c.id, first.slice(0, 64), last?.slice(0, 64) || undefined);
        return tg.sendMessage(owner, "✅ Name changed.");
      } catch (e) { return tg.sendMessage(owner, `❌ ${esc(e.message)}`); }
    }
    if (what === "/bio") {
      const c = await D.connWithRight(db, "can_edit_bio");
      if (!c) return tg.sendMessage(owner, "❌ can_edit_bio not granted.");
      try {
        await tg.setBusinessAccountBio(c.id, val.slice(0, 140));
        return tg.sendMessage(owner, "✅ Bio changed.");
      } catch (e) { return tg.sendMessage(owner, `❌ ${esc(e.message)}`); }
    }
    if (what === "/username") {
      const c = await D.connWithRight(db, "can_edit_username");
      if (!c) return tg.sendMessage(owner, "❌ can_edit_username not granted.");
      try {
        await tg.setBusinessAccountUsername(c.id, val.replace(/^@/, "").slice(0, 32) || null);
        return tg.sendMessage(owner, "✅ Username changed.");
      } catch (e) { return tg.sendMessage(owner, `❌ ${esc(e.message)}`); }
    }
    if (what === "/photo") return handlePhoto(ctx, env, db, tg, m);
  }

  const st = await D.getReply(db, owner);
  if (st && m.text) {
    if (st.mode === "ai") {
      const key = `${st.conn_id}:${st.customer_id}`;
      await D.histAdd(db, key, "user", m.text);
      const reply = await aiReply(env, { history: await D.histGet(db, key), text: m.text });
      if (!reply) {
        return tg.sendMessage(owner, aiReady(env) ? "⚠️ AI returned nothing." : "⚠️ AI is off — no API key.");
      }
      await D.histAdd(db, key, "assistant", reply);
      return deliverReply(ctx, env, db, tg, st, reply);
    }
    return deliverReply(ctx, env, db, tg, st, m.text);
  }

  return tg.sendMessage(owner, "No open draft — press ✍️ Reply on a forwarded DM.\nTip: tap 🎛️ in /panel.");
}

// ── commands ───────────────────────────────────────────────────────────

const COMMANDS = [
  ["start", "status + menu"], ["help", "commands"], ["panel", "button control panel"],
  ["clock", "Tehran clock in your name"], ["mode", "manual | ai | off"],
  ["pin", "pin this thread"], ["rules", "auto-replies"], ["quick", "quick replies"],
  ["block", "block a spammer"], ["unblock", "unblock"], ["stats", "numbers"],
  ["name", "account name"], ["bio", "account bio"], ["username", "account username"],
  ["photo", "profile photo"], ["rmphoto", "remove photo"], ["rights", "granted rights"],
  ["test", "health check"], ["cancel", "close draft"], ["forget", "clear AI memory"],
  ["listen", "turn DM forwarding on/off"],
];

async function runCommand(ctx, env, db, tg, chatId, cmd, args) {
  const owner = OWNER(env);
  const guarded = [
    "panel", "clock", "mode", "pin", "rules", "quick", "block", "unblock",
    "name", "bio", "username", "rmphoto", "forget", "cancel", "listen",
  ];
  if (guarded.includes(cmd) && !isOwner(env, chatId)) {
    return tg.sendMessage(chatId, "⛔ Owner only.");
  }
  const S = (k, d = null) => D.setting(db, k, d);

  switch (cmd) {
    case "start": {
      const conns = (await D.allConnections(db)).length;
      const mode = await S("mode", "manual");
      await tg.sendMessage(chatId, UI.startText({
        chatId, ownerId: owner, mode, conns,
        aiOk: aiReady(env), model: env.AI_MODEL,
        listenOn: (await S("listen_dm", "on")) !== "off",
      }), html({ reply_markup: UI.helpKeyboard() }));
      return;
    }
    case "help":
      return tg.sendMessage(chatId, UI.helpText(), html());
    case "test": {
      const st = await D.allStats(db);
      return tg.sendMessage(chatId,
        `✅ Online\nMode: <code>${esc(await S("mode", "manual"))}</code>\n` +
        `AI: ${aiReady(env) ? `<code>${esc(env.AI_MODEL)}</code>` : "<i>off (no api key)</i>"}\n` +
        `Accounts: ${(await D.allConnections(db)).length}\n` +
        `Clock: <code>${await S("clock_font", "off")}</code> — ${clockPreview(await S("clock_font", "mono"))}\n` +
        `👂 DM listening: <b>${(await S("listen_dm", "on")) === "off" ? "OFF" : "ON"}</b>\n` +
        `Handled: ${st.dms || 0} DMs (${st.ai || 0} AI / ${st.manual || 0} you / ${st.rules || 0} rules)`,
        html());
    }
    case "stats": {
      const st = await D.allStats(db);
      return tg.sendMessage(chatId,
        `📊 Stats\nDM received: ${st.dms || 0}\nAI answered: ${st.ai || 0}\n` +
        `You answered: ${st.manual || 0}\nRule hits: ${st.rules || 0}\nBlocked: ${st.blocked || 0}`,
        html());
    }
    case "mode": {
      if (!args.length) return tg.sendMessage(chatId, `Mode: <code>${esc(await S("mode", "manual"))}</code>`);
      const m = args[0].toLowerCase();
      if (!["manual", "ai", "off"].includes(m)) return tg.sendMessage(chatId, "❌ Use: manual | ai | off");
      if (m === "ai" && !aiReady(env)) {
        return tg.sendMessage(chatId, "⚠️ AI mode is off because no API key is set.\nEverything else still works: manual mode, /rules, /quick, /block, profile editing.", html());
      }
      await S("mode", m);
      return tg.sendMessage(chatId, `✅ Mode: <code>${m}</code>`, html());
    }
    case "panel": return showPanel(ctx, env, db, tg, chatId, 0, chatId);
    case "rights": {
      const list = await D.allConnections(db);
      if (!list.length) return tg.sendMessage(chatId, "⚠️ No account connected.\nSettings → Business → Chatbots");
      const out = list.map((c) => {
        const rs = Object.entries(c.rights || {}).map(([k, v]) => `  ${v ? "✅" : "❌"} ${k}`).join("\n");
        return `👤 ${esc(c.name || "?")} (<code>${c.user_id}</code>)\nconn <code>${c.id.slice(0, 16)}…</code>\n${rs}`;
      }).join("\n\n");
      return tg.sendMessage(chatId, out, html());
    }
    case "listen": {
      const cur = await D.setting(db, "listen_dm", "on");
      if (!args.length) {
        return tg.sendMessage(chatId,
          `👂 DM listening: <b>${cur === "off" ? "OFF" : "ON"}</b>\n\n` +
          (cur === "off"
            ? "Incoming DMs are ignored — you will not be notified and nobody is auto-answered."
            : "Incoming DMs are forwarded to you with buttons."),
          html());
      }
      const v = args[0].toLowerCase();
      if (!["on", "off"].includes(v)) return tg.sendMessage(chatId, "❌ Use: /listen on | off");
      await D.setSetting(db, "listen_dm", v);
      await D.audit(db, chatId, "listen.set", v);
      return tg.sendMessage(chatId,
        v === "off"
          ? "🔇 DM listening <b>OFF</b> — you will not be pinged.\n<i>The bot stays alive for /panel, commands and the clock.</i>"
          : "👂 DM listening <b>ON</b>.",
        html());
    }
    case "cancel":
      if (await D.getReply(db, owner)) {
        await D.clearReply(db, owner);
        return tg.sendMessage(chatId, "📥 Draft closed.");
      }
      return tg.sendMessage(chatId, "No open draft.");
    case "forget": {
      const st = await D.getReply(db, owner);
      if (st) await D.histForget(db, `${st.conn_id}:${st.customer_id}`);
      return tg.sendMessage(chatId, "🧹 AI memory cleared.");
    }
    case "rules": {
      if (!args.length) {
        const list = await D.listKv(db, "rules");
        const body = list.length ? list.map((r) => `• <code>${esc(r.kw)}</code> → ${esc(r.reply)}`).join("\n") : "(none)";
        return tg.sendMessage(chatId, `📌 Auto-reply rules\n${body}\n\nAdd: <code>/rules add سلام = درود</code>`, html());
      }
      if (args[0].toLowerCase() === "add" && args.length >= 2) {
        const joined = args.slice(1).join(" ");
        const i = joined.indexOf("=");
        if (i < 0) return tg.sendMessage(chatId, "❌ Format: <code>/rules add k = r</code>", html());
        await D.putKv(db, "rules", joined.slice(0, i).trim().toLowerCase(), joined.slice(i + 1).trim());
        return tg.sendMessage(chatId, "✅ Rule added.", html());
      }
      if (args[0].toLowerCase() === "del" && args.length >= 2) {
        await D.delKv(db, "rules", args.slice(1).join(" ").trim().toLowerCase());
        return tg.sendMessage(chatId, "🗑 Removed.", html());
      }
      return tg.sendMessage(chatId, "Usage: /rules add k = r | /rules del k");
    }
    case "quick": {
      if (!args.length) {
        const list = await D.listKv(db, "quick");
        const body = list.length ? list.map((r) => `<code>${esc(r.name)}</code> → ${esc(r.text)}`).join("\n") : "(none)";
        return tg.sendMessage(chatId, `⚡ Quick replies\n${body}\n\nAdd: <code>/quick سلام = سلام داداش</code>`, html());
      }
      const joined = args.join(" ");
      if (/^del\s+/i.test(joined)) {
        await D.delKv(db, "quick", joined.replace(/^del\s+/i, "").trim());
        return tg.sendMessage(chatId, "🗑 Removed.", html());
      }
      const i = joined.indexOf("=");
      if (i < 0) return tg.sendMessage(chatId, "❌ Format: <code>/quick name = text</code>", html());
      await D.putKv(db, "quick", joined.slice(0, i).trim().slice(0, 20), joined.slice(i + 1).trim());
      return tg.sendMessage(chatId, "⚡ Added.", html());
    }
    case "block":
      if (!args.length) {
        const ids = await D.listBlocked(db);
        return tg.sendMessage(chatId, `Blocked: ${ids.join(", ") || "(none)"}\nUsage: <code>/block &lt;id&gt;</code>`, html());
      }
      await D.blockUser(db, args[0]);
      return tg.sendMessage(chatId, `🚫 Blocked <code>${esc(args[0])}</code>`, html());
    case "unblock":
      if (args[0]) {
        await D.unblockUser(db, args[0]);
        return tg.sendMessage(chatId, `✅ Unblocked <code>${esc(args[0])}</code>`, html());
      }
      return tg.sendMessage(chatId, "Not blocked.");
    case "pin": {
      const st = await D.getReply(db, owner);
      if (!st) return tg.sendMessage(chatId, "⚠️ Press ✍️ Reply on a DM first.");
      if (!args.length) return tg.sendMessage(chatId, "Usage: /pin ai | manual | off");
      const w = args[0].toLowerCase();
      if (!["ai", "manual", "off"].includes(w)) return tg.sendMessage(chatId, "❌ Use: ai | manual | off");
      if (w === "ai" && !aiReady(env)) {
        return tg.sendMessage(chatId, "⚠️ AI is off — no API key.", html());
      }
      await D.setPin(db, `${st.conn_id}:${st.customer_id}`, w === "off" ? null : w);
      return tg.sendMessage(chatId, `✅ This thread: <code>${w}</code>`, html());
    }
    case "name": {
      if (!args.length) return tg.sendMessage(chatId, "Usage: <code>/name First | Last</code>", html());
      const c = await D.connWithRight(db, "can_edit_name");
      if (!c) return tg.sendMessage(chatId, "❌ can_edit_name not granted.");
      const joined = args.join(" ");
      const [first, last] = joined.split("|").map((s) => s.trim());
      try {
        await tg.setBusinessAccountName(c.id, first.slice(0, 64), last?.slice(0, 64) || undefined);
        return tg.sendMessage(chatId, "✅ Name changed.", html());
      } catch (e) { return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); }
    }
    case "bio": {
      if (!args.length) return tg.sendMessage(chatId, "Usage: <code>/bio your bio</code>", html());
      const c = await D.connWithRight(db, "can_edit_bio");
      if (!c) return tg.sendMessage(chatId, "❌ can_edit_bio not granted.");
      try {
        await tg.setBusinessAccountBio(c.id, args.join(" ").slice(0, 140));
        return tg.sendMessage(chatId, "✅ Bio changed.", html());
      } catch (e) { return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); }
    }
    case "username": {
      if (!args.length) return tg.sendMessage(chatId, "Usage: <code>/username limoo</code>", html());
      const c = await D.connWithRight(db, "can_edit_username");
      if (!c) return tg.sendMessage(chatId, "❌ can_edit_username not granted.");
      try {
        await tg.setBusinessAccountUsername(c.id, args.join(" ").replace(/^@/, "").slice(0, 32) || null);
        return tg.sendMessage(chatId, "✅ Username changed.", html());
      } catch (e) { return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); }
    }
    case "photo": return handlePhoto(ctx, env, db, tg, { ...arguments[4] });
    case "rmphoto": {
      const c = await D.connWithRight(db, "can_edit_profile_photo");
      if (!c) return tg.sendMessage(chatId, "❌ not granted.");
      try {
        await tg.removeBusinessAccountProfilePhoto(c.id);
        return tg.sendMessage(chatId, "✅ Photo removed.", html());
      } catch (e) { return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); }
    }
    case "clock": return runClock(ctx, env, db, tg, chatId, args);
    default:
      return tg.sendMessage(chatId, "Unknown command. Try /help");
  }
}

async function handlePhoto(ctx, env, db, tg, m) {
  const c = await D.connWithRight(db, "can_edit_profile_photo");
  if (!c) return tg.sendMessage(OWNER(env), "❌ can_edit_profile_photo not granted.", html());
  const photos = (m?.photo || []).filter((p) => !p.file_size || p.file_size < 20_000_000);
  if (!photos.length) {
    return tg.sendMessage(OWNER(env), "Send the photo with <code>/photo</code> in the caption.", html());
  }
  try {
    const f = await fetch(`https://api.telegram.org/file/bot${tg.__token}/file/${photos.at(-1).file_id}`);
    const blob = await f.arrayBuffer();
    // upload as multipart/FormData
    const form = new FormData();
    form.append("business_connection_id", c.id);
    form.append("photo", new Blob([blob]), "photo.jpg");
    const res = await fetch(`https://api.telegram.org/bot${tg.__token}/setBusinessAccountProfilePhoto`, {
      method: "POST", body: form,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "upload failed");
    return tg.sendMessage(OWNER(env), "✅ Profile photo changed.", html());
  } catch (e) {
    return tg.sendMessage(OWNER(env), `❌ ${esc(e.message)}`, html());
  }
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

async function showPanel(ctx, env, db, tg, chatId, level, editMsgId) {
  const stats = await D.allStats(db);
  const conns = (await D.allConnections(db)).length;
  const rules = (await D.listKv(db, "rules")).length;
  const quick = (await D.listKv(db, "quick")).length;
  const blocked = (await D.listBlocked(db)).length;
  const mode = await D.setting(db, "mode", "manual");
  const home = UI.panelHome({
    mode, aiOk: aiReady(env), model: env.AI_MODEL,
    conns, rules, quick, blocked, stats,
    listenOn: (await D.setting(db, "listen_dm", "on")) !== "off",
  });
  const names = ["home", "rules", "quick", "blocked", "profile", "clock"];
  const text = level === 0 ? home.text : `${home.text}\n\n📂 <u>${names[level]}</u>`;

  let markup;
  if (level === 0) markup = home.reply_markup;
  else if (level === 1) markup = { inline_keyboard: UI.panelRules(await D.listKv(db, "rules")) };
  else if (level === 2) markup = { inline_keyboard: UI.panelQuick(await D.listKv(db, "quick")) };
  else if (level === 3) markup = { inline_keyboard: UI.panelBlocked(await D.listBlocked(db)) };
  else if (level === 4) markup = { inline_keyboard: UI.panelProfile() };
  else markup = { inline_keyboard: UI.panelClock(await D.setting(db, "clock_font", "")) };

  // Edit the PANEL message only — never a forwarded DM.
  if (editMsgId) {
    try {
      return await tg.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...html({ reply_markup: markup }) });
    } catch { /* fall through to a fresh message */ }
  }
  return tg.sendMessage(chatId, text, html({ reply_markup: markup }));
}

// ── callback router ────────────────────────────────────────────────────

async function onCallback(ctx, env, db, tg, q) {
  const owner = OWNER(env);
  const parts = String(q.data || "").split(":");
  const kind = parts[0];
  const arg = parts[1] || "";
  const chatId = q.message?.chat?.id ?? owner;
  const msgId = q.message?.message_id;
  const ack = (text, alert = false) => tg.answerCallback(q.id, text, alert);

  if (kind === "hx") {
    await ack();
    return tg.sendMessage(chatId, UI.helpText(), html());
  }

  // ── panel (owner only) ──
  if (["m", "p", "rd", "qd", "ub", "ra", "qa", "pr", "cf", "t"].includes(kind)) {
    if (!isOwner(env, q.from?.id)) return ack("⛔ Owner only.", true);

    if (kind === "m") {
      if (arg === "ai" && !aiReady(env)) return ack("⚠️ No API key — AI is off.", true);
      if (!["ai", "manual", "off"].includes(arg)) return ack("Bad mode", true);
      await D.setSetting(db, "mode", arg);
      await D.audit(db, q.from.id, "mode.set", arg);
      await ack(`✅ Mode: ${arg}`, true);
      return showPanel(ctx, env, db, tg, chatId, 0, msgId);
    }
    if (kind === "t" && arg === "listen") {
      const now = (await D.setting(db, "listen_dm", "on")) === "off" ? "on" : "off";
      await D.setSetting(db, "listen_dm", now);
      await D.audit(db, q.from.id, "listen.set", now);
      await ack(now === "off" ? "🔇 DM listening OFF — you won't be pinged." : "👂 DM listening ON.", true);
      return showPanel(ctx, env, db, tg, chatId, 0, msgId);
    }
    if (kind === "p") {
      await ack();
      if (arg === "rights" || arg === "stats") {
        return runCommand(ctx, env, db, tg, chatId, arg, []);
      }
      const lvl = { home: 0, rules: 1, quick: 2, block: 3, profile: 4, clock: 5 }[arg] ?? 0;
      return showPanel(ctx, env, db, tg, chatId, lvl, msgId);
    }
    if (kind === "rd") {
      const list = await D.listKv(db, "rules");
      const i = Number(arg);
      if (list[i]) { await D.delKv(db, "rules", list[i].kw); await ack(`🗑 ${list[i].kw}`, true); }
      return showPanel(ctx, env, db, tg, chatId, 1, msgId);
    }
    if (kind === "qd") {
      const list = await D.listKv(db, "quick");
      const i = Number(arg);
      if (list[i]) { await D.delKv(db, "quick", list[i].name); await ack(`🗑 ${list[i].name}`, true); }
      return showPanel(ctx, env, db, tg, chatId, 2, msgId);
    }
    if (kind === "ub") {
      const ids = await D.listBlocked(db);
      if (ids[Number(arg)]) { await D.unblockUser(db, ids[Number(arg)]); await ack("✅ Unblocked", true); }
      return showPanel(ctx, env, db, tg, chatId, 3, msgId);
    }
    if (kind === "ra" || kind === "qa") {
      await D.setSetting(db, "_await", kind === "ra" ? "rule" : "quick");
      await ack("Send it now", true);
      return tg.sendMessage(chatId, kind === "ra" ? UI.guidedPrompts.rule : UI.guidedPrompts.quick, html());
    }
    if (kind === "pr") {
      if (arg === "rmphoto") { await ack(); return runCommand(ctx, env, db, tg, chatId, "rmphoto", []); }
      await D.setSetting(db, "_await", arg);
      await ack("Waiting for your input…", true);
      return tg.sendMessage(chatId, UI.guidedPrompts[arg] || "Send it now.", html());
    }
    if (kind === "cf") {
      if (arg === "off") {
        await ack("🔴 Removing clock…", true);
        return turnClockOff(env, db, tg, chatId);
      }
      if (!FONT_NAMES.includes(arg)) return ack("Unknown font", true);
      const c = await D.connWithRight(db, "can_edit_name");
      if (!c) return ack("❌ can_edit_name not granted.", true);
      let base = await D.setting(db, "clock_base_name", "");
      if (!base) {
        try {
          const info = await tg.getBusinessConnection(c.id);
          base = stripClock(info.user?.first_name || "").slice(0, 64);
          await D.setSetting(db, "clock_base_name", base);
        } catch { base = ""; }
      }
      const next = buildClockName(base, arg);
      await D.setSetting(db, "clock_font", arg);
      await D.setSetting(db, "clock_applied", next);
      try { await tg.setBusinessAccountName(c.id, next); }
      catch (e) { return ack(`❌ ${e.message}`, true); }
      await ack(`🕐 ${next}`, true);
      return showPanel(ctx, env, db, tg, chatId, 5, msgId);
    }
  }

  // ── DM actions ──
  if (["r", "a", "f", "q", "b", "del"].includes(kind)) {
    if (!isOwner(env, q.from?.id)) return ack("⛔ Owner only.", true);

    if (kind === "del") {
      await ack("↩️ Removed.", true);
      return;
    }
    const d = await D.getDraft(db, arg);
    if (!d) return ack("⚠️ This draft expired — wait for a new DM.", true);

    if (kind === "r") {
      await D.setReply(db, {
        owner_id: owner, draft_id: d.id, conn_id: d.conn_id,
        customer_id: d.customer_id, name: d.name, mode: null,
      });
      return ack(`📝 Draft open for ${d.name} — type your reply.`, true);
    }
    if (kind === "a") {
      if (!aiReady(env)) {
        return ack("⚠️ AI is off — no API key set. Use ✍️ Reply instead.", true);
      }
      await D.setReply(db, {
        owner_id: owner, draft_id: d.id, conn_id: d.conn_id,
        customer_id: d.customer_id, name: d.name, mode: "ai",
      });
      return ack("🤖 AI armed — type your question here.", true);
    }
    if (kind === "f") {
      // re-send in a NEW message; never edit the forward
      const link = d.username ? `@${d.username}` : `tg://user?id=${d.customer_id}`;
      await ack();
      return tg.sendMessage(chatId,
        `📄 <b>${esc(d.name)}</b> (${link})\n\n${esc(d.text || "(no text)")}`,
        html({ disable_web_page_preview: true }));
    }
    if (kind === "q") {
      const list = await D.listKv(db, "quick");
      const item = list[Number(parts[2])];
      if (!item) return ack("Quick reply not found", true);
      try {
        await tg.sendMessage(d.customer_id, item.text, { business_connection_id: d.conn_id });
        await D.bumpStat(db, "manual");
        return ack("⚡ Sent.", true);
      } catch (e) { return ack(`❌ ${e.message}`, true); }
    }
    if (kind === "b") {
      await D.blockUser(db, d.customer_id);
      await D.dropDraft(db, d.id);
      await ack(`🚫 ${d.name} blocked.`, true);
    }
  }

  return ack();
}

// ── top-level update dispatch ──────────────────────────────────────────

export async function handleUpdate(ctx, env, update) {
  const { DB } = env;
  const tg = makeTelegram(env.BOT_TOKEN);
  tg.__token = env.BOT_TOKEN;

  // ── exactly-once ──
  if (!(await D.claimUpdate(DB, update.update_id))) return;

  const m = update.message;
  const bm = update.business_message;

  try {
    if (update.business_connection) {
      const c = update.business_connection;
      if (c.is_enabled) {
        const rec = {
          id: c.id, user_id: c.user?.id, user_chat_id: c.user_chat_id,
          name: c.user?.first_name ? `${c.user.first_name} ${c.user.last_name || ""}`.trim() : "",
          rights: c.rights || {},
        };
        await D.saveConnection(DB, rec);
        await ctx.waitUntil(
          tg.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })))
        );
        if (m) {
          await tg.sendMessage(m.chat.id,
            `✅ Connected: <b>${esc(rec.name)}</b>\nRights: <code>${esc(Object.keys(rec.rights || {}).join(", ") || "none")}</code>`,
            html({ reply_markup: UI.helpKeyboard() }));
        }
      } else {
        await D.dropConnection(DB, c.id);
        await D.audit(DB, null, "connection.removed", c.id);
      }
      return;
    }

    if (update.callback_query) return await onCallback(ctx, env, DB, tg, update.callback_query);

    if (bm) return await handleBusinessMessage(ctx, env, DB, tg, bm);

    if (m) {
      const text = m.text || "";
      const isCmd = text.startsWith("/");
      const cmd = isCmd ? text.slice(1).split("@")[0].toLowerCase() : "";
      const args = isCmd ? text.slice(1).split("@")[0].split(/\s+/).slice(1) : [];

      // /photo arrives as a caption on a photo
      if (m.photo && m.caption && /^\/photo/.test(m.caption)) {
        return await handlePhoto(ctx, env, DB, tg, m);
      }
      if (isCmd) return await runCommand(ctx, env, DB, tg, m.chat.id, cmd, args);
      if (OWNER(env) && m.chat.id === OWNER(env)) return await handleOwnerText(ctx, env, DB, tg, m);
    }
  } catch (e) {
    // Log and swallow: the HTTP response is already 200 and a retry would
    // double-deliver. The audit row is the only trace.
    await D.audit(DB, null, "update.error", `${update.update_id}: ${e.message}`);
    console.error("update failed", update.update_id, e);
  }
}

// ── the tick: clock + housekeeping ──────────────────────────────────────
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

  // ── the clock ──
  const font = s.clock_font || "";
  if (!font) return out;
  out.clock = font;

  const want = buildClockName(stripClock(s.clock_base_name || ""), font);

  // THE request saving: only call Telegram when the rendered name differs from
  // what we last wrote. Before, a tick that changed nothing still burned a
  // setBusinessAccountName call (or a compare against a separately-read value).
  if (want === (s.clock_applied || "")) return out;

  const c = s.name_conn_id
    ? { id: s.name_conn_id }
    : await D.connWithRight(DB, "can_edit_name");
  if (!c) {
    out.clock_error = "can_edit_name not granted";
    return out;
  }
  try {
    const tg = makeTelegram(env.BOT_TOKEN);
    await tg.setBusinessAccountName(c.id, want);
    await D.setSetting(DB, "clock_applied", want);
    out.wrote = true;
  } catch (e) {
    out.clock_error = e.message;
    console.warn("clock tick failed", e.message);
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
