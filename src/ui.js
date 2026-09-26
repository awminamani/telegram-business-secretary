// ─────────────────────────────────────────────────────────────────────────
// All user-facing text: keyboards, the button control panel, and /help.
//
// callback_data rule: Telegram caps it at 64 bytes, and business_connection_id is
// base64url (it CONTAINS "_"). So callback_data only ever carries a short
// opaque id we minted, and real ids are looked up server-side in D1.
// ─────────────────────────────────────────────────────────────────────────

import { esc, sleep } from "./telegram.js";
import { FONT_NAMES, clockPreview, stripClock, buildClockName } from "./clock.js";

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const link = (text, url) => ({ text, url });

// ── the panel ──────────────────────────────────────────────────────────

export function panelHome({ mode, aiOk, model, conns, rules, quick, blocked, stats }) {
  const head =
    `🎛️ <b>Control panel</b>\n` +
    `Mode: <code>${esc(mode)}</code>\n` +
    (aiOk ? `🧠 AI: <code>${esc(model)}</code>\n`
          : `🧠 AI: <b>off</b> <i>(no API key — manual/rules/quick still work)</i>\n`) +
    `Accounts: ${conns} · Rules: ${rules} · Quick: ${quick} · Blocked: ${blocked}\n` +
    `Handled: ${stats.dms || 0} DMs (${stats.ai || 0} AI / ${stats.manual || 0} you / ` +
    `${stats.rules || 0} rules / ${stats.blocked || 0} blocked)`;

  return {
    text: head,
    reply_markup: kb([
      [btn("🤖 AI mode", "m:ai"), btn("✍️ Manual", "m:manual"), btn("🔇 Off", "m:off")],
      [btn("⚡ Rules", "p:rules"), btn("⚡ Quick", "p:quick"), btn("🚫 Blocked", "p:block")],
      [btn("👤 Profile", "p:profile"), btn("🕐 Clock", "p:clock")],
      [btn("🔑 Rights", "p:rights"), btn("📊 Stats", "p:stats")],
    ]),
  };
}

export function panelRules(rules) {
  const rows = rules.map((r, i) => [btn(`🗑 ${String(r.kw).slice(0, 18)}`, `rd:${i}`)]);
  rows.push([btn("➕ Add rule", "ra:0"), btn("◀️ Back", "p:home")]);
  return rows;
}

export function panelQuick(items) {
  const rows = items.map((r, i) => [btn(`🗑 ${String(r.name).slice(0, 18)}`, `qd:${i}`)]);
  rows.push([btn("➕ Add quick", "qa:0"), btn("◀️ Back", "p:home")]);
  return rows;
}

export function panelBlocked(ids) {
  const rows = ids.map((cid, i) => [btn(`✅ unblock ${cid}`, `ub:${i}`)]);
  rows.push([btn("◀️ Back", "p:home")]);
  return rows;
}

export function panelProfile() {
  return [
    [btn("📝 Name", "pr:name"), btn("📝 Bio", "pr:bio"), btn("🔤 Username", "pr:user")],
    [btn("🖼️ Photo", "pr:photo"), btn("🗑 Remove photo", "pr:rmphoto")],
    [btn("◀️ Back", "p:home")],
  ];
}

export function panelClock(current) {
  const rows = FONT_NAMES.map((f) => [
    btn((f === current ? "✅ " : "") + `${f}  ${clockPreview(f)}`, `cf:${f}`),
  ]);
  rows.push([btn("🔴 Turn clock OFF", "cf:off"), btn("◀️ Back", "p:home")]);
  return rows;
}

// ── forwarded DM keyboard ──────────────────────────────────────────────
//
// Every button answers with a TOAST (answerCallbackQuery). None of them edits
// the forwarded message: that message is the only copy of the customer's text
// in the bot chat, and editing it destroys the content permanently.

export function dmKeyboard(draftId, quickNames) {
  const rows = [
    [btn("✍️ Reply", `r:${draftId}`), btn("🤖 AI now", `a:${draftId}`), btn("📄 Full", `f:${draftId}`)],
  ];
  quickNames.slice(0, 4).forEach((q, i) => rows.push([btn(String(q.name).slice(0, 30), `q:${draftId}:${i}`)]));
  rows.push([btn("🚫 Block", `b:${draftId}`)]);
  return kb(rows);
}

/** Header for a forwarded DM. `tg://` only works in a link/button, never text. */
export function dmHeader({ name, username, customerId, text }) {
  let who = `<b>${esc(name)}</b>`;
  if (username) who += ` (<code>@${esc(username)}</code>)`;
  return `📥 ${who}\n🆔 <code>${customerId}</code>\n${text ?? ""}`;
}

export function profileButton(username, customerId) {
  return username
    ? link(`👤 @${String(username).slice(0, 20)}`, `https://t.me/${username}`)
    : link("👤 Open profile", `tg://user?id=${customerId}`);
}

// ── /help — every command, grouped ─────────────────────────────────────

const HELP_SECTIONS = [
  ["🎛️ Modes", [
    ["/panel", "open the button control panel — manage everything by tapping"],
    ["/mode", "show the current mode"],
    ["/mode manual", "DMs come to you with Reply / AI-now buttons"],
    ["/mode ai", "the assistant answers DMs by itself"],
    ["/mode off", "ignore all incoming DMs"],
    ["/pin ai", "force AI for just this conversation"],
    ["/pin manual", "force yourself for just this conversation"],
    ["/pin off", "follow the global mode again"],
  ]],
  ["⚡ Zero-cost automation (works with NO api key)", [
    ["/rules", "list your keyword auto-replies"],
    ["/rules add قیمت = به‌زودی اعلام می‌کنیم", "auto-answer anything containing a keyword"],
    ["/rules del قیمت", "remove a rule"],
    ["/quick", "list quick replies"],
    ["/quick سلام = سلام داداش 👋", "add a one-tap reply button under every DM"],
    ["/quick del سلام", "remove a quick reply"],
  ]],
  ["🚫 Blocklist", [
    ["/block <id>", "ignore a spammer — the id is shown on each forwarded DM"],
    ["/unblock <id>", "un-block them"],
  ]],
  ["👤 Profile (official Business API)", [
    ["/name Amin | Rahimi", "change the account's first and last name"],
    ["/bio your bio text", "change the account bio (max 140 chars)"],
    ["/username limoo", "change the account username"],
    ["/photo", "change the profile photo — send it with /photo in the caption"],
    ["/rmphoto", "remove the profile photo"],
    ["/rights", "show exactly which permissions the bot was granted"],
  ]],
  ["🕐 Tehran clock in your name", [
    ["/clock", "show whether the clock is on"],
    ["/clock fonts", "live preview of every digit font"],
    ["/clock on mono", "turn it on and pick a font (updates every minute)"],
    ["/clock off", "remove the clock and restore your original name"],
  ]],
  ["💬 Draft control", [
    ["/cancel", "close the open draft without replying"],
    ["/forget", "clear the AI's memory of a conversation"],
  ]],
  ["📊 Info", [
    ["/start", "status: your id, mode, connected accounts, AI state"],
    ["/help", "this manual"],
    ["/test", "quick health check with live counters"],
    ["/stats", "DM / AI / manual / rule / blocked totals"],
  ]],
];

export function helpText() {
  const intro =
    `📖 <b>Full manual</b> — every command and what it does.\n` +
    `Commands marked ⚡ work with <b>no AI api key</b>.\n` +
    `💡 Tap 🎛️ in <code>/panel</code> for the same thing as buttons.`;
  const body = HELP_SECTIONS.map(([title, rows]) => {
    const lines = rows.map(([cmd, desc]) =>
      cmd ? `<code>${esc(cmd)}</code>\n   ${esc(desc)}` : `   ${esc(desc)}`);
    return `\n${title}\n${lines.join("\n")}`;
  }).join("");
  const outro =
    `\n───────────────\n<b>Typical flow</b>\n` +
    `1. Connect: Settings → Business → Chatbots → this bot\n` +
    `2. Someone DMs you → the message lands here with buttons\n` +
    `3. Tap ✍️ Reply → type your answer → it delivers, draft closes\n` +
    `4. Turn on /mode ai to stop doing step 3 entirely`;
  return intro + body + outro;
}

export function startText({ chatId, ownerId, mode, conns, aiOk, model }) {
  const ai = aiOk
    ? `✅ ready (<code>${esc(model)}</code>)`
    : "⚠️ off — no API key. Manual mode, /rules and /quick all still work.";
  return (
    `👋 Gateway active\n\n` +
    `Your chat id: <code>${chatId}</code>\n` +
    `OWNER_ID: <code>${ownerId || "not set"}</code> ${chatId === ownerId ? "✅" : "❌"}\n\n` +
    `Mode: <code>${esc(mode)}</code>\n` +
    `Connected accounts: ${conns}\n` +
    `AI: ${ai}\n\n` +
    `🕐 Tehran now: <code>${clockPreview("mono")}</code>` +
    (mode === "ai" && !aiOk ? "\n<i>AI mode fell back to manual (no key)</i>" : "")
  );
}

export function helpKeyboard() {
  return kb([[btn("🎛️ Control panel", "p:home"), btn("📖 Full manual", "hx:0")]]);
}

export const guidedPrompts = {
  rule: "📝 Send the rule as: <code>keyword = reply</code>\n\n" +
        "Any DM containing the keyword is answered instantly — no AI, no cost.",
  quick: "⚡ Send the quick reply as: <code>name = text</code>\n\n" +
         "It becomes a one-tap button under every incoming DM.",
  "/name": "📝 Send:  <code>First | Last</code>",
  "/bio": "📝 Send the new bio text (max 140 chars)",
  "/username": "🔤 Send the new username (without @)",
  "/photo": "🖼️ Send the photo with <code>/photo</code> in the caption",
};

export { sleep };
