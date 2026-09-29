// ─────────────────────────────────────────────────────────────────────────
// Dashboards. Everything is buttons — no commands needed.
//
//   userPanel()    the normal user's home screen (plan-aware)
//   adminPanel()   the admin's home screen (users, codes, plans)
//
// Callback data is 1-2 lowercase letters + ":" + a token, always under the
// 64-byte cap, and never carries a raw base64url id.
// ─────────────────────────────────────────────────────────────────────────

import { esc } from "./telegram.js";
import { FONT_NAMES, clockPreview } from "./clock.js";
import { FEATURES, TIERS, TIER_INFO, planLabel, fmtExpiry, fmtDuration } from "./plans.js";

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

// ── normal user ────────────────────────────────────────────────────────

export function userPanel({
  ent, mode = "manual", listenOn = true, clockFont = "", conns = 0, stats = {},
}) {
  const isAdmin = !!ent.isAdmin;
  const tier = ent.tier || "free";
  const st = stats || {};
  const lines = [];
  lines.push(`👤 <b>Your dashboard</b>`);
  lines.push(`Plan: ${planLabel(ent.plan?.tier, ent.plan?.expires_at)}`);
  lines.push(`Accounts: ${conns} · Mode: <code>${esc(mode)}</code> · 👂 DMs: <b>${listenOn ? "ON" : "OFF"}</b>`);
  lines.push(`Handled: ${st.dms || 0} DMs (${st.ai || 0} AI / ${st.manual || 0} you / ${st.rules || 0} rules)`);
  if (clockFont) lines.push(`🕐 Clock: <code>${esc(clockFont)}</code> — ${clockPreview(clockFont)}`);

  const rows = [
    [btn(listenOn ? "🔇 DM forwarding OFF" : "👂 DM forwarding ON", "t:listen")],
    [btn("🤖 AI replies", "m:ai"), btn("✍️ Manual", "m:manual"), btn("🔇 Ignore DMs", "m:off")],
  ];

  // ── plan-gated features are shown, but disabled-with-a-reason ──
  // A locked button must say WHICH feature is locked, otherwise the router
  // cannot show the right upgrade screen. "x:<feature>".
  const gated = (feature, label, data) => {
    const ok = ent.isAdmin || tierIndexOf(tier) >= FEATURES[feature].min;
    // callback_data must never contain "_" (it is the id separator everywhere
    // else), so the feature key is hyphenated on the wire.
    return btn(ok ? label : `🔒 ${label}`, ok ? data : `x:${feature.replace(/_/g, "-")}`);
  };
  rows.push([
    gated("clock", "🕐 Clock", "p:clock"),
    gated("profile_edit", "👤 Profile", "p:profile"),
  ]);
  rows.push([
    btn("⚡ Rules", "p:rules"),
    btn("🔖 Quick replies", "p:quick"),
    btn("🚫 Blocked", "p:block"),
  ]);
  if (isAdmin) {
    rows.push([btn("🛠 Admin dashboard", "a:home"), btn("🎟 My codes", "a:mine")]);
  } else {
    rows.push([btn("🎟 Redeem a code", "a:redeem"), btn("ℹ️ My plan", "a:plan")]);
  }
  return { text: lines.join("\n"), reply_markup: kb(rows) };
}

function tierIndexOf(t) { const i = TIERS.indexOf(t); return i < 0 ? 0 : i; }

export function planText(ent) {
  const f = Object.entries(FEATURES)
    .map(([k, v]) => {
      const ok = ent.isAdmin || tierIndexOf(ent.tier) >= v.min;
      return `${ok ? "✅" : "🔒"} ${v.icon} ${esc(v.label)}`;
    }).join("\n");
  return (
    `🎟 <b>Your plan</b>\n${planLabel(ent.plan?.tier, ent.plan?.expires_at)}\n\n` +
    `<b>What you can use</b>\n${f}\n\n` +
    `💡 Ask an admin for a redeem code, then tap <b>🎟 Redeem a code</b>.`
  );
}

export function clockPage({ font, ent, owned, baseName }) {
  const rows = FONT_NAMES.map((f) => [
    btn((f === font ? "✅ " : "") + `${f}  ${clockPreview(f)}`, `cf:${f}`),
  ]);
  rows.push([
    btn("🔴 Turn clock OFF", "cf:off"),
    btn(owned ? "🧹 Forget saved name" : "◀️ Back", owned ? "cf:clear" : "p:home"),
  ]);
  return {
    text:
      `🕐 <b>Tehran clock in your name</b>\n` +
      `Status: ${font ? `<b>ON</b> (${esc(font)}) — ${clockPreview(font)}` : "<b>OFF</b>"}\n` +
      (baseName ? `Your name is kept as <b>${esc(baseName)}</b> and restored when you turn this off.\n` : "") +
      `\nTap a font to apply it to <b>your</b> account only. Updates every minute.`,
    reply_markup: kb(rows),
  };
}

export function profilePage({ ent, rights }) {
  const ok = ent.isAdmin || tierIndexOf(ent.tier) >= FEATURES.profile_edit.min;
  if (!ok) {
    return {
      text: `🔒 <b>Profile editing</b> is a <b>Pro</b> feature.\n\nYou are on ${planLabel(ent.plan?.tier, ent.plan?.expires_at)}\n\nRedeem a code to unlock it.`,
      reply_markup: kb([[btn("🎟 Redeem a code", "a:redeem"), btn("◀️ Back", "p:home")]]),
    };
  }
  return {
    text: "👤 <b>Profile</b>\nChanges apply to your connected business account.\n" +
          (rights ? `\nGranted: <code>${esc(rights)}</code>` : ""),
    reply_markup: kb([
      [btn("📝 First name", "pr:first"), btn("📝 Full name", "pr:full")],
      [btn("✏️ Bio", "pr:bio"), btn("🔤 Username", "pr:user")],
      [btn("🖼️ Photo", "pr:photo"), btn("🗑 Remove photo", "pr:rm")],
      [btn("◀️ Back", "p:home")],
    ]),
  };
}

export function simpleListPage({ title, icon, items, empty, back = "p:home", add = null }) {
  const rows = items.map((it) => [btn(`🗑 ${esc(it.label)}`, it.data)]);
  if (add) rows.push([btn(add.label, add.data)]);
  rows.push([btn("◀️ Back", back)]);
  return {
    text: items.length
      ? `${icon} <b>${esc(title)}</b>\n\n${items.map((i) => "• " + esc(i.label)).join("\n")}`
      : `${icon} <b>${esc(title)}</b>\n\n<i>${esc(empty)}</i>`,
    reply_markup: kb(rows),
  };
}

// ── admin ──────────────────────────────────────────────────────────────

export function adminPanel({ ent, stats, codes, users }) {
  const paidCount = users.filter((u) => u.tier && u.tier !== "free").length;
  return {
    text:
      `🛠 <b>Admin dashboard</b>\n` +
      `👥 Users: <b>${stats.users}</b> (${paidCount} paid) · ` +
      `🎟 Codes: <b>${stats.codes}</b> (${stats.redemptions} redeemed)\n\n` +
      `<b>Manage</b>`,
    reply_markup: kb([
      [btn("👥 Users", "a:users"), btn("🎟 Codes", "a:codes")],
      [btn("➕ Generate code", "a:newcode"), btn("📊 Stats", "a:stats")],
      [btn("📜 Audit log", "a:audit"), btn("⚙️ Settings", "a:settings")],
      [btn("👤 My dashboard", "p:home")],
    ]),
  };
}

export function adminUsersPage({ users, ent }) {
  const rows = users.slice(0, 20).map((u) => {
    const who = u.username ? `@${u.username}` : (u.name || u.user_id);
    const badge = u.is_owner ? "👑 " : (u.role === "admin" ? "🛠 " : "");
    return [btn(`${badge}${esc(String(who))} — ${TIER_INFO[u.tier || "free"].icon}${u.tier || "free"}`,
                 `au:${u.user_id}`)];
  });
  rows.push([btn("◀️ Back", "a:home")]);
  const active = users.filter((u) => u.last_seen && nowSecSafe() - u.last_seen < 604800).length;
  return {
    text:
      `👥 <b>Users</b> (${users.length} total, ${active} active this week)\n\n` +
      `Tap a user to manage their plan.\n` +
      `<i>👑 = bot owner · 🛠 = admin</i>`,
    reply_markup: kb(rows),
  };
}

function nowSecSafe() { return Math.floor(Date.now() / 1000); }

export function adminUserPage({ u, ent, history }) {
  const isSelf = u.user_id === ent.user?.user_id;
  const plan = planLabel(u.tier || "free", u.expires_at);
  return {
    text:
      `👤 <b>${esc(u.username ? "@" + u.username : (u.name || u.user_id))}</b>\n` +
      `ID: <code>${u.user_id}</code>\n` +
      `Role: ${u.is_owner ? "👑 owner" : (u.role === "admin" ? "🛠 admin" : "user")}\n` +
      `Plan: ${plan}\n` +
      `Joined: ${fmtExpiry(u.created_at)}\n` +
      `Last seen: ${u.last_seen ? fmtExpiry(u.last_seen) : "never"}\n` +
      (history?.length ? `\n<b>Recent redemptions</b>\n${history.map((h) => "• " + esc(h)).join("\n")}` : ""),
    reply_markup: kb([
      [btn("⚡ Pro", "ap:pro"), btn("💎 Premium", "ap:premium")],
      [btn("🆓 Free", "ap:free"), btn("⏳ +30 days", "ap:ext")],
      [btn("🎟 Issue a code", "ac:for")],
      [btn("🚫 Revoke plan", "ap:revoke")],
      [btn("🛠 Toggle admin", isSelf ? "au:self" : "ap:role")],
      [btn("🗑 Remove user", "ap:del")],
      [btn("◀️ Back to users", "a:users")],
    ]),
  };
}

export function adminCodesPage({ codes }) {
  const rows = codes.slice(0, 15).map((c) => {
    const left = c.max_uses - c.uses;
    const when = c.expires_at ? ` · ${fmtDuration(c.expires_at - nowSecSafe())} left` : "";
    const bound = c.bound_user ? " 🔒" : "";
    return [btn(`${TIER_INFO[c.tier]?.icon || "🎟"} ${left} left${when}${bound}`,
                 `ac:${c.code_hash.slice(0, 10)}`)];
  });
  rows.push([btn("➕ Generate", "a:newcode"), btn("◀️ Back", "a:home")]);
  return {
    text: codes.length
      ? `🎟 <b>Codes</b> (${codes.length})\n\nTap one for detail. 🔒 = bound to one user.`
      : `🎟 <b>Codes</b>\n\n<i>None yet — tap ➕ Generate.</i>`,
    reply_markup: kb(rows),
  };
}

export function adminCodePage({ c, plain }) {
  const live = c.uses < c.max_uses && (!c.expires_at || c.expires_at > nowSecSafe());
  return {
    text:
      `🎟 <b>Code</b>\n` +
      `<code>${esc(plain || "(hidden — fully used)")}</code>\n\n` +
      `Tier: ${TIER_INFO[c.tier]?.icon || ""} ${esc(c.tier)}\n` +
      `Uses: ${c.uses}/${c.max_uses}\n` +
      `Expires: ${c.expires_at ? fmtExpiry(c.expires_at) : "never"}\n` +
      `Bound to: ${c.bound_user ? `<code>${c.bound_user}</code>` : "anyone"}\n` +
      `Status: ${live ? "🟢 active" : "🔴 spent/expired"}`,
    reply_markup: kb([
      [btn("🗑 Delete", "ad:del"), btn("◀️ Back", "a:codes")],
    ]),
  };
}

/** The one-shot "here is your code" card. */
export function newCodeCard({ plain, tier, expires_at, max_uses, bound }) {
  return {
    text:
      `🎟 <b>New code created</b>\n\n` +
      `<code>${esc(plain)}</code>\n\n` +
      `Tier: ${TIER_INFO[tier]?.icon || ""} ${esc(tier)}\n` +
      `Valid for: ${expires_at ? fmtDuration(expires_at - nowSecSafe()) : "forever"}\n` +
      `Max uses: ${max_uses}\n` +
      `Bound to: ${bound ? `<code>${bound}</code>` : "anyone with the code"}\n\n` +
      `⚠️ <b>Save it now.</b> It is stored hashed; the admin panel can show it ` +
      `again until it is used up, then it is erased.`,
    reply_markup: kb([
      [btn("🎟 More codes", "a:newcode"), btn("◀️ Admin", "a:home")],
    ]),
  };
}

export function adminStatsPage({ stats, users, codes }) {
  const byTier = {};
  for (const u of users) {
    const t = (!u.expires_at || u.expires_at > nowSecSafe()) ? (u.tier || "free") : "free";
    byTier[t] = (byTier[t] || 0) + 1;
  }
  const lines = Object.entries(TIER_INFO).map(([k, v]) =>
    `  ${v.icon} ${v.label}: ${byTier[k] || 0}`);
  const totals = users.reduce((a, u) => ({
    dms: a.dms + (u.dms || 0), ai: a.ai + (u.ai || 0), manual: a.manual + (u.manual || 0),
  }), { dms: 0, ai: 0, manual: 0 });
  return {
    text:
      `📊 <b>Overview</b>\n` +
      `Users: ${stats.users} · Paid: ${stats.paid}\n` +
      `Codes: ${stats.codes} generated · ${stats.redemptions} redeemed\n` +
      `Active codes: ${codes.filter((c) => c.uses < c.max_uses).length}\n\n` +
      `<b>Tiers</b>\n${lines.join("\n")}\n\n` +
      `<b>DM totals</b>\n` +
      `  received: ${totals.dms}\n  AI answered: ${totals.ai}\n  owner answered: ${totals.manual}`,
    reply_markup: kb([[btn("◀️ Back", "a:home")]]),
  };
}

export function adminAuditPage({ entries }) {
  return {
    text: entries.length
      ? `📜 <b>Audit log</b>\n\n${entries.map((e) =>
          `${fmtExpiry(e.at)} — <b>${esc(e.action)}</b> ${esc((e.detail || "").slice(0, 40))}`).join("\n")}`
      : `📜 <b>Audit log</b>\n\n<i>Nothing yet.</i>`,
    reply_markup: kb([[btn("◀️ Back", "a:home")]]),
  };
}

export function adminSettingsPage({ ent, conns, cronOk, skew }) {
  return {
    text:
      `⚙️ <b>Bot settings</b>\n` +
      `Owner: <code>${ent.user?.user_id ?? "—"}</code>\n` +
      `Connected accounts: ${conns}\n` +
      `Clock cron: ${cronOk ? "🟢 live" : "🟡 driven by traffic"} (skew ${skew ?? "?"}s)\n` +
      `AI: ${ent.aiOk ? "🟢 configured" : "🔴 no API key"}\n\n` +
      `Non-admin features are gated by plan tier. The owner always has access.`,
    reply_markup: kb([
      [btn("♻️ Re-check connections", "a:resync")],
      [btn("◀️ Back", "a:home")],
    ]),
  };
}

export function redeemPage() {
  return {
    text:
      `🎟 <b>Redeem a code</b>\n\n` +
      `Tap <b>➕ Enter code</b> and send me the code an admin gave you.\n` +
      `It unlocks the features on your plan until it expires.`,
    reply_markup: kb([
      [btn("➕ Enter code", "a:enter")],
      [btn("ℹ️ My plan", "a:plan"), btn("◀️ Back", "p:home")],
    ]),
  };
}

export function lockedText(feature, ent) {
  const f = FEATURES[feature];
  const need = TIERS[f.min];
  return (
    `🔒 <b>${f.icon} ${esc(f.label)}</b>\n\n` +
    `This is a <b>${TIER_INFO[need].label}</b> feature.\n` +
    `You are on: ${planLabel(ent.plan?.tier, ent.plan?.expires_at)}\n\n` +
    `Ask an admin for a code, then tap <b>🎟 Redeem a code</b>.`
  );
}
