// ─────────────────────────────────────────────────────────────────────────
// Multi-user dashboards: rendering + callback routing.
//
// The v1 handlers were all gated on a single OWNER_ID and read GLOBAL settings.
// Here every user gets their own scoped settings, their own plan, and their own
// clock — and admin-only surfaces are reachable only from a real admin.
// ─────────────────────────────────────────────────────────────────────────

import * as D from "./db.js";
import * as U from "./users.js";
import * as Dash from "./dash.js";
import { makeTelegram, esc, sleep } from "./telegram.js";
import { FEATURES, TIERS, TIER_INFO, hasFeature, planLabel, makeCode,
         hashCode, parseDuration, fmtDuration, fmtExpiry } from "./plans.js";
import { clockPreview, buildClockName, stripClock, FONT_NAMES } from "./clock.js";

const html = (extra = {}) => ({ parse_mode: "HTML", ...extra });

// ── per-user settings helpers ──────────────────────────────────────────

export const uset = (db, key, fb, uid) => U.setting(db, key, fb, uid);

/** Which business account does this user own? (first connection they registered) */
export async function connForUser(db, userId) {
  const list = await D.allConnections(db);
  return list.find((c) => Number(c.user_id) === Number(userId)) || list[0] || null;
}

/** All connections, so the tick can serve every user who has a clock on. */
export async function clockJobs(db) {
  const list = await D.allConnections(db);
  const jobs = [];
  for (const c of list) {
    const uid = c.user_id;
    const font = await U.setting(db, "clock_font", "", uid);
    if (!font) continue;
    const base = stripClock(await U.setting(db, "clock_base_name", "", uid) || "");
    if (!base) continue;
    jobs.push({ connId: c.id, uid, font, base });
  }
  return jobs;
}

async function ensurePlanShape(db, userId, isOwner, env) {
  const u = await U.getUser(db, userId);
  if (u) return u;
  return U.upsertUser(db, {
    user_id: userId, role: isOwner ? "admin" : "user", is_owner: isOwner ? 1 : 0,
  });
}

/** Context for a dashboard: entitlements + the user's own settings. */
export async function userContext(env, db, userId) {
  const isOwner = !!env.OWNER_ID && Number(env.OWNER_ID) === Number(userId);
  await ensurePlanShape(db, userId, isOwner, env);
  const ent = await U.entitlements(db, userId);
  ent.user = ent.user || { user_id: userId };
  ent.aiOk = !!(env.OPENROUTER_API_KEY && env.AI_MODEL);
  ent.mode = await uset(db, "mode", "manual", userId);
  ent.listenOn = (await uset(db, "listen_dm", "on", userId)) !== "off";
  ent.clockFont = await uset(db, "clock_font", "", userId);
  ent.conns = (await D.allConnections(db)).filter(
    (c) => Number(c.user_id) === Number(userId)).length;
  ent.stats = await D.allStats(db);
  return ent;
}

export function canUse(ent, feature) {
  return ent.isAdmin || hasFeature(ent.tier, ent.expiresAt, feature);
}

// ── renderers ──────────────────────────────────────────────────────────

export async function renderUserHome(env, db, chatId, userId) {
  const ent = await userContext(env, db, userId);
  const p = Dash.userPanel(ent);
  await tg().sendMessage(chatId, p.text, html({ reply_markup: p.reply_markup }));
}

async function renderAdminHome(env, db, chatId, userId) {
  const ent = await userContext(env, db, userId);
  const stats = await U.codeStats(db);
  const users = await U.allUsers(db);
  const p = Dash.adminPanel({ ent, stats, users, codes: await U.listCodes(db) });
  await tg().sendMessage(chatId, p.text, html({ reply_markup: p.reply_markup }));
}

export async function showPanel(env, db, tg, chatId, userId, level = 0) {
  const ent = await userContext(env, db, userId);
  const users = await U.allUsers(db);
  const codes = await U.listCodes(db);

  const mk = async (page) => {
    try {
      return await page;
    } catch {
      return { text: "Something went wrong rendering that page.", reply_markup: { inline_keyboard: [[{ text: "◀️ Back", callback_data: "p:home" }]] } };
    }
  };

  let p;
  switch (level) {
    case "clock": {
      const owned = await U.hasOwnSetting(db, "clock_base_name", userId);
      p = Dash.clockPage({
        font: ent.clockFont, ent,
        owned,
        baseName: await uset(db, "clock_base_name", "", userId),
      });
      break;
    }
    case "profile": {
      const c = await connForUser(db, userId);
      p = Dash.profilePage({ ent, rights: c ? Object.keys(c.rights || {}).join(" ") : "" });
      break;
    }
    case "rules": {
      const list = await D.listKv(db, "rules");
      p = Dash.simpleListPage({
        title: "Auto-replies", icon: "⚡",
        items: list.map((r, i) => ({ label: `${r.kw} → ${r.reply}`, data: `rd:${i}` })),
        empty: "No rules yet.",
        add: { label: "➕ Add rule", data: "ra:0" },
      });
      break;
    }
    case "quick": {
      const list = await D.listKv(db, "quick");
      p = Dash.simpleListPage({
        title: "Quick replies", icon: "🔖",
        items: list.map((r, i) => ({ label: `${r.name} → ${r.text}`, data: `qd:${i}` })),
        empty: "No quick replies yet.",
        add: { label: "➕ Add", data: "qa:0" },
      });
      break;
    }
    case "block": {
      const ids = await D.listBlocked(db);
      p = Dash.simpleListPage({
        title: "Blocked", icon: "🚫",
        items: ids.map((id, i) => ({ label: id, data: `ub:${i}` })),
        empty: "Nobody blocked.",
      });
      break;
    }
    case "plan":
      p = { text: Dash.planText(ent), reply_markup: { inline_keyboard: [
        [{ text: "🎟 Redeem a code", callback_data: "a:redeem" }],
        [{ text: "◀️ Back", callback_data: "p:home" }],
      ] } };
      break;
    case "redeem":
      p = Dash.redeemPage();
      break;
    case "admin":
      p = Dash.adminPanel({ ent, stats: await U.codeStats(db), users, codes });
      break;
    case "admin:users":
      p = Dash.adminUsersPage({ users, ent });
      break;
    case "admin:codes":
      p = Dash.adminCodesPage({ codes });
      break;
    case "admin:newcode":
      p = { text: "🎟 <b>Generate a code</b>\n\nTap a tier, then a validity. It is created instantly.",
            reply_markup: { inline_keyboard: [
              [{ text: "⚡ Pro", callback_data: "ng:pro" }, { text: "💎 Premium", callback_data: "ng:premium" }],
              [{ text: "◀️ Back", callback_data: "a:codes" }],
            ] } };
      break;
    case "admin:stats":
      p = Dash.adminStatsPage({ stats: await U.codeStats(db), users, codes });
      break;
    case "admin:audit": {
      const { results } = await db.prepare(
        "SELECT at, action, detail FROM audit ORDER BY id DESC LIMIT 25").all();
      p = Dash.adminAuditPage({ entries: results });
      break;
    }
    case "admin:settings": {
      const c = await connForUser(db, userId);
      p = Dash.adminSettingsPage({
        ent, conns: (await D.allConnections(db)).length,
        cronOk: true, skew: null,
      });
      break;
    }
    default:
      p = Dash.userPanel(ent);
  }
  await tg().sendMessage(chatId, p.text, html({ reply_markup: p.reply_markup }));
}

// ── callback router ────────────────────────────────────────────────────

const tg = () => globalThis.__TG;

export function setTelegram(t) { globalThis.__TG = t; }

export async function onDashCallback(env, db, q, userId) {
  const ack = (text, alert = false) => tg().answerCallback(q.id, text, alert);
  const parts = String(q.data || "").split(":");
  const kind = parts[0];
  const arg = parts[1] || "";
  const chatId = q.message?.chat?.id;
  const ent = await userContext(env, db, userId);

  // ── locked feature: arg IS the feature key ("x:clock", "x:profile_edit") ──
  if (kind === "x") {
    await ack();
    const feature = (parts[1] || "clock").replace(/-/g, "_");
    return tg().sendMessage(chatId, Dash.lockedText(feature, ent), html());
  }

  // ── user actions ──
  if (kind === "t" && arg === "listen") {
    const now = (await uset(db, "listen_dm", "on", userId)) === "off" ? "on" : "off";
    await uset(db, "listen_dm", now, userId);
    await D.audit(db, userId, "listen.set", now);
    await ack(now === "off" ? "🔇 DM forwarding OFF" : "👂 DM forwarding ON", true);
    return showPanel(env, db, tg(), chatId, userId, 0);
  }
  if (kind === "m") {
    if (arg === "ai" && !canUse(ent, "ai_mode")) {
      await ack("🔒 Premium feature", true);
      await tg().sendMessage(chatId, Dash.lockedText("ai_mode", ent), html());
      return;
    }
    if (arg === "ai" && !ent.aiOk) {
      await ack("⚠️ No API key configured.", true);
      return;
    }
    await uset(db, "mode", arg, userId);
    await ack(`✅ Mode: ${arg}`, true);
    return showPanel(env, db, tg(), chatId, userId, 0);
  }
  if (kind === "p") {
    await ack();
    const map = { home: 0, clock: "clock", profile: "profile", rules: "rules",
                  quick: "quick", block: "block" };
    // gate the two pro surfaces
    if (arg === "clock" && !canUse(ent, "clock")) {
      return tg().sendMessage(chatId, Dash.lockedText("clock", ent), html());
    }
    if (arg === "profile" && !canUse(ent, "profile_edit")) {
      return tg().sendMessage(chatId, Dash.lockedText("profile_edit", ent), html());
    }
    return showPanel(env, db, tg(), chatId, userId, map[arg] ?? 0);
  }
  if (kind === "cf") {
    if (!canUse(ent, "clock")) {
      await ack("🔒 Pro feature", true);
      return tg().sendMessage(chatId, Dash.lockedText("clock", ent), html());
    }
    const conn = await connForUser(db, userId);
    if (!conn) return ack("No business account connected.", true);
    const c = await D.connWithRight(db, "can_edit_name");
    if (!c) return ack("❌ can_edit_name not granted.", true);
    if (arg === "off") {
      let base = stripClock(await uset(db, "clock_base_name", "", userId) || "");
      await uset(db, "clock_font", "", userId);
      await uset(db, "clock_applied", "", userId);
      if (!base) {
        try {
          const info = await tg().getBusinessConnection(c.id);
          base = stripClock(info.user?.first_name || "");
        } catch { /* leave as-is */ }
      }
      try { await tg().setBusinessAccountName(c.id, (base || " ").slice(0, 64)); }
      catch { /* reported below */ }
      await uset(db, "clock_base_name", base, userId);
      await ack("🔴 Clock removed", true);
      return showPanel(env, db, tg(), chatId, userId, "clock");
    }
    if (arg === "clear") {
      await uset(db, "clock_base_name", "", userId);
      await uset(db, "clock_applied", "", userId);
      await ack("🧹 Saved name cleared", true);
      return showPanel(env, db, tg(), chatId, userId, "clock");
    }
    if (!FONT_NAMES.includes(arg)) return ack("Unknown font", true);
    // remember the real name ONCE, scoped to this user
    if (!(await U.hasOwnSetting(db, "clock_base_name", userId))) {
      let base = "";
      try {
        const info = await tg().getBusinessConnection(c.id);
        base = stripClock(info.user?.first_name || "").slice(0, 64);
      } catch { base = ""; }
      await uset(db, "clock_base_name", base, userId);
    }
    const next = buildClockName(await uset(db, "clock_base_name", "", userId), arg);
    await uset(db, "clock_font", arg, userId);
    await uset(db, "clock_applied", next, userId);
    try { await tg().setBusinessAccountName(c.id, next); }
    catch (e) { return ack(`❌ ${e.message}`, true); }
    await ack(`🕐 ${next}`, true);
    return showPanel(env, db, tg(), chatId, userId, "clock");
  }
  if (kind === "rd" || kind === "qd" || kind === "ub") {
    await ack();
    if (kind === "rd") {
      const list = await D.listKv(db, "rules");
      if (list[Number(arg)]) await D.delKv(db, "rules", list[Number(arg)].kw);
    } else if (kind === "qd") {
      const list = await D.listKv(db, "quick");
      if (list[Number(arg)]) await D.delKv(db, "quick", list[Number(arg)].name);
    } else {
      const ids = await D.listBlocked(db);
      if (ids[Number(arg)]) await D.unblockUser(db, ids[Number(arg)]);
    }
    const map = { rd: "rules", qd: "quick", ub: "block" };
    return showPanel(env, db, tg(), chatId, userId, map[kind]);
  }
  if (kind === "ra" || kind === "qa") {
    await uset(db, "_await", kind === "ra" ? "rule" : "quick", userId);
    await ack("Send it now", true);
    const msg = kind === "ra"
      ? "📝 Send: <code>keyword = reply</code>"
      : "⚡ Send: <code>name = text</code>";
    return tg().sendMessage(chatId, msg, html());
  }
  if (kind === "pr") {
    await uset(db, "_await", `pr:${arg}`, userId);
    await ack("Send it now", true);
    return tg().sendMessage(chatId, "Send it now.", html());
  }

  // ── admin actions ──
  if (["a", "au", "ap", "ac", "ad", "ng"].includes(kind)) {
    if (!ent.isAdmin) return ack("⛔ Admin only.", true);
    return adminCallback(env, db, q, userId, ent, kind, arg, chatId, ack);
  }
  return ack();
}

async function adminCallback(env, db, q, userId, ent, kind, arg, chatId, ack) {
  if (kind === "a") {
    await ack();
    const map = { home: "admin", users: "admin:users", codes: "admin:codes",
                  newcode: "admin:newcode", stats: "admin:stats", audit: "admin:audit",
                  settings: "admin:settings", plan: "plan", redeem: "redeem",
                  mine: "plan" };
    if (arg === "enter") {
      await uset(db, "_await", "redeem", userId);
      return tg().sendMessage(chatId, "🎟 Send me your code.", html());
    }
    return showPanel(env, db, tg(), chatId, userId, map[arg] ?? "admin");
  }
  if (kind === "ng") {
    // tier chosen → ask for validity
    await ack();
    await uset(db, "_await", `newcode:${arg}`, userId);
    return tg().sendMessage(chatId,
      `🎟 <b>${TIER_INFO[arg]?.label || arg}</b> code.\n\n` +
      `How long should it be valid?\n\n` +
      `<b>Buttons below</b> — or send a duration like <code>7 days</code>.`,
      html({ reply_markup: { inline_keyboard: [
        [{ text: "1 hour", callback_data: "nv:3600" }, { text: "1 day", callback_data: "nv:86400" }],
        [{ text: "7 days", callback_data: "nv:604800" }, { text: "30 days", callback_data: "nv:2592000" }],
        [{ text: "Never", callback_data: "nv:0" }, { text: "◀️ Cancel", callback_data: "a:codes" }],
      ] } }));
  }
  if (kind === "ac" && arg) {
    // code detail: arg is a hash prefix
    const codes = await U.listCodes(db);
    const c = codes.find((x) => x.code_hash.startsWith(arg));
    await ack();
    if (!c) return tg().sendMessage(chatId, "That code no longer exists.", html());
    const p = Dash.adminCodePage({ c, plain: c.code_plain });
    return tg().sendMessage(chatId, p.text, html({ reply_markup: p.reply_markup }));
  }
  if (kind === "ad") {
    const codes = await U.listCodes(db);
    const c = codes.find((x) => x.code_hash.startsWith(arg));
    if (c) await U.deleteCode(db, c.code_hash);
    await ack("🗑 Deleted", true);
    return showPanel(env, db, tg(), chatId, userId, "admin:codes");
  }
  if (kind === "au" && arg) {
    await ack();
    const uid = Number(arg);
    if (uid === userId) return tg().sendMessage(chatId, "That is you — use the settings below.", html());
    const u = await U.getUser(db, uid);
    if (!u) return tg().sendMessage(chatId, "User not found.", html());
    const { results } = await db.prepare(
      "SELECT note AS label, at FROM code_uses WHERE user_id = ?1 ORDER BY id DESC LIMIT 5")
      .bind(uid).all();
    const p = Dash.adminUserPage({ u, ent, history: results.map((r) => r.label || "") });
    return tg().sendMessage(chatId, p.text, html({ reply_markup: p.reply_markup }));
  }
  if (kind === "ap") {
    await ack();
    const uid = Number(arg);
    if (arg === "role") {
      const u = await U.getUser(db, uid);
      await U.setUserRole(db, uid, u?.role === "admin" ? "user" : "admin");
      await ack("🛠 Role toggled", true);
      return showPanel(env, db, tg(), chatId, userId, "admin:users");
    }
    if (arg === "del") {
      await U.deleteUser(db, uid);
      await ack("🗑 Removed", true);
      return showPanel(env, db, tg(), chatId, userId, "admin:users");
    }
    if (arg === "ext") {
      await U.extendPlan(db, uid, 2592000);
      await D.audit(db, userId, "plan.extended", String(uid));
      await ack("⏳ +30 days", true);
    } else if (arg === "revoke") {
      await U.revokePlan(db, uid);
      await D.audit(db, userId, "plan.revoked", String(uid));
      await ack("🚫 Plan revoked", true);
    } else if (TIERS.includes(arg)) {
      const days = arg === "premium" ? 30 : 30;
      await U.grantPlan(db, {
        user_id: uid, tier: arg, expires_at: nowS() + days * 86400,
        granted_by: userId, note: "admin grant",
      });
      await D.audit(db, userId, "plan.granted", `${uid}:${arg}`);
      await ack(`✅ ${arg} granted`, true);
    }
    return showPanel(env, db, tg(), chatId, userId, "admin:users");
  }
  return ack();
}

const nowS = () => Math.floor(Date.now() / 1000);

// ── guided input (add rule / quick / redeem / newcode) ─────────────────

export async function onGuided(env, db, tg, chatId, userId, text) {
  const what = await uset(db, "_await", "", userId);
  if (!what) return false;
  await uset(db, "_await", "", userId);
  const isAdmin = !!env.OWNER_ID && Number(env.OWNER_ID) === Number(userId);

  if (what === "rule" || what === "quick") {
    const i = text.indexOf("=");
    if (i < 0) { await tg.sendMessage(chatId, "❌ Format: <code>key = value</code>", html()); return true; }
    const k = text.slice(0, i).trim();
    const v = text.slice(i + 1).trim();
    await D.putKv(db, what, what === "rule" ? k.toLowerCase() : k.slice(0, 20), v);
    await tg.sendMessage(chatId, `✅ Saved <b>${esc(k)}</b>`, html());
    return true;
  }
  if (what === "redeem") {
    const res = await U.redeemCode(db, env.CODE_SECRET, text, userId);
    if (!res.ok) {
      const why = { unknown: "❓ That code doesn't exist.",
                    used_up: "🚫 That code has already been used.",
                    expired: "⌛ That code has expired.",
                    bound: "🔒 That code belongs to a different account.",
                    race: "⚠️ That code was just used. Try again." }[res.reason] || "❌ Invalid code.";
      return tg.sendMessage(chatId, why, html()), true;
    }
    const tier = res.code.tier;
    const exp = res.code.expires_at;
    await U.grantPlan(db, {
      user_id: userId, tier,
      expires_at: exp || (nowS() + 30 * 86400),
      granted_by: null, note: "redeemed",
    });
    await D.audit(db, userId, "plan.redeemed", tier);
    await tg.sendMessage(chatId,
      `🎉 <b>Redeemed!</b>\n\nYou now have: ${planLabel(tier, exp || nowS() + 2592000)}`,
      html({ reply_markup: { inline_keyboard: [[{ text: "🎛 Open dashboard", callback_data: "p:home" }]] } }));
    return true;
  }
  if (what.startsWith("newcode:")) {
    const tier = what.split(":")[1];
    const dur = parseDuration(text);
    return createCodeFor(env, db, tg, chatId, userId, tier, dur || 0, null), true;
  }
  if (what === "nv") {
    return false;
  }
  if (what.startsWith("pr:")) {
    const what2 = what.split(":")[1];
    const conn = await connForUser(db, userId);
    const c = conn ? await D.connWithRight(db, "can_edit_name") : null;
    if (what2 === "user") {
      const cc = await D.connWithRight(db, "can_edit_username");
      if (!cc) { await tg.sendMessage(chatId, "❌ can_edit_username not granted.", html()); return true; }
      try { await tg.setBusinessAccountUsername(cc.id, text.replace(/^@/, "").slice(0, 32) || null); }
      catch (e) { await tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); return true; }
      await tg.sendMessage(chatId, "✅ Username changed.", html());
      return true;
    }
    if (what2 === "bio") {
      const cc = await D.connWithRight(db, "can_edit_bio");
      if (!cc) { await tg.sendMessage(chatId, "❌ can_edit_bio not granted.", html()); return true; }
      try { await tg.setBusinessAccountBio(cc.id, text.slice(0, 140)); }
      catch (e) { await tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); return true; }
      await tg.sendMessage(chatId, "✅ Bio changed.", html());
      return true;
    }
    if (what2 === "first" || what2 === "full") {
      const cc = await D.connWithRight(db, "can_edit_name");
      if (!cc) { await tg.sendMessage(chatId, "❌ can_edit_name not granted.", html()); return true; }
      const [first, last] = what2 === "full" ? text.split("|").map((s) => s.trim()) : [text.trim(), ""];
      try { await tg.setBusinessAccountName(cc.id, first.slice(0, 64), last?.slice(0, 64) || undefined); }
      catch (e) { await tg.sendMessage(chatId, `❌ ${esc(e.message)}`, html()); return true; }
      await tg.sendMessage(chatId, "✅ Name changed.", html());
      return true;
    }
  }
  return false;
}

export async function createCodeFor(env, db, tg, chatId, adminId, tier, validFor, boundUser) {
  const { code } = await U.createCode(db, env.CODE_SECRET, {
    tier, max_uses: 1, expires_at: validFor ? nowS() + validFor : 0,
    created_by: adminId, bound_user: boundUser,
  });
  const p = Dash.newCodeCard({
    plain: code, tier, expires_at: validFor ? nowS() + validFor : 0,
    max_uses: 1, bound: boundUser,
  });
  await tg.sendMessage(chatId, p.text, html({ reply_markup: p.reply_markup }));
}
