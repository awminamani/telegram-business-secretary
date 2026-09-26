// Unit tests for the logic that actually broke in the Python version.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeEqual, makeSecret, validSecret, esc } from "../src/telegram.js";
import {
  tehranParts, tehranISO, styleDigits, clockPreview, stripClock, buildClockName,
  FONT_NAMES, CLOCK_MAX_NAME,
} from "../src/clock.js";
import { draftId } from "../src/db.js";
import { clean, aiReady } from "../src/ai.js";
import { dmKeyboard, dmHeader, helpText, panelHome } from "../src/ui.js";

test("safeEqual rejects wrong secrets and handles length differences", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false, "prefix must not match");
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(null, "x"), false);
  assert.equal(safeEqual("x", undefined), false);
});

test("generated secrets match Telegram's allowed alphabet", () => {
  for (let i = 0; i < 50; i++) {
    const s = makeSecret(32);
    assert.equal(s.length, 32);
    assert.ok(validSecret(s), `invalid secret: ${s}`);
  }
  // Telegram allows only A-Z a-z 0-9 _ -
  assert.equal(validSecret("has space"), false);
  assert.equal(validSecret("has/slash"), false);
  assert.equal(validSecret("x".repeat(257)), false, "max is 256");
});

test("Tehran time is UTC+3:30 and never double-counts", () => {
  const ms = Date.UTC(2026, 0, 15, 12, 0, 0);          // 12:00 UTC
  const p = tehranParts(ms);
  assert.equal(p.H, 15, "12:00 UTC must be 15:30 in Tehran");
  assert.equal(p.M, 30);
  assert.equal(tehranISO(ms), "2026-01-15 15:30");
  // 20:37 local-ish: UTC 17:07 -> Tehran 20:37
  assert.equal(tehranISO(Date.UTC(2026, 0, 15, 17, 7, 0)), "2026-01-15 20:37");
});

test("clock is 24-hour with no AM/PM", () => {
  for (const f of FONT_NAMES) {
    const pv = clockPreview(f);
    assert.ok(!/[AaPp][Mm]/.test(pv), `${f} produced AM/PM: ${pv}`);
    assert.ok(pv.includes(":"), `${f} has no colon`);
  }
  // 00:05 UTC -> 03:35 Tehran (+3:30)
  assert.equal(clockPreview("hex", Date.UTC(2026, 0, 1, 0, 5, 0)), "０３:３５");
  // 20:37 UTC -> 00:07 next day Tehran
  assert.equal(clockPreview("hex", Date.UTC(2026, 0, 1, 20, 37, 0)), "００:０７");
});

test("all 11 fonts render every hour 00-23", () => {
  for (const f of FONT_NAMES) {
    const seen = new Set();
    for (let h = 0; h < 24; h++) {
      seen.add(styleDigits(String(h).padStart(2, "0"), f));
    }
    assert.equal(seen.size, 24, `${f} produced duplicate hours`);
  }
});

test("stripClock removes the clock for EVERY font, including no-ASCII ones", () => {
  // The sans/serif fonts have zero ASCII digits — a \d-based strip silently
  // failed and left the clock stuck on the account name.
  for (const f of FONT_NAMES) {
    const name = buildClockName("Amin", f);
    assert.equal(stripClock(name), "Amin", `${f}: ${name} -> ${stripClock(name)}`);
  }
});

test("stripClock handles stacked clocks and preserves real names", () => {
  let n = "Amin";
  for (let i = 0; i < 3; i++) n = buildClockName(n, "sans");
  assert.equal(stripClock(n), "Amin", "stacked clocks must all be removed");
  assert.equal(stripClock("Amin: The Boss"), "Amin: The Boss", "real colon kept");
  assert.equal(stripClock("Dr. Smith"), "Dr. Smith");
  assert.equal(stripClock(""), "");
});

test("buildClockName appends without deleting the user's name", () => {
  const n = buildClockName("Amin", "mono");
  assert.ok(n.startsWith("Amin · "), n);
  assert.ok(n.length <= CLOCK_MAX_NAME, `too long: ${n.length}`);
  // empty base -> just the clock
  assert.ok(!buildClockName("", "mono").includes("·"));
});

test("draftId is short, stable and free of underscores", () => {
  // business_connection_id is base64url and CONTAINS "_"; putting it in
  // callback_data and splitting on "_" is what silently killed the Reply button.
  for (const conn of ["abc-_def", "RDtv0c7IwVG6BwAA", "x".repeat(40)]) {
    const id = draftId(555123456, conn);
    assert.ok(!id.includes("_"), `draftId has an underscore: ${id}`);
    assert.ok(id.length <= 20, `too long for callback_data: ${id}`);
    assert.equal(id, draftId(555123456, conn), "must be stable");
    assert.notEqual(id, draftId(555123457, conn), "different customer -> different id");
  }
});

test("callback_data on every keyboard stays under 64 bytes", () => {
  const mk = dmKeyboard("d0000001", [{ name: "سلام" }, { name: "قیمت" }]);
  const all = mk.inline_keyboard.flat().filter((b) => b.callback_data);
  for (const b of all) {
    assert.ok(Buffer.byteLength(b.callback_data) <= 64,
      `${b.callback_data} is ${Buffer.byteLength(b.callback_data)} bytes`);
  }
  assert.ok(all.some((b) => b.callback_data.startsWith("r:")), "Reply button present");
  assert.ok(all.some((b) => b.callback_data.startsWith("a:")), "AI button present");
  assert.ok(all.some((b) => b.callback_data.startsWith("f:")), "Full-text button present");
});

test("DM header escapes hostile customer input", () => {
  const h = dmHeader({ name: "<script>", username: "a&b", customerId: 5, text: "" });
  assert.ok(!h.includes("<script>"), "tag must be escaped");
  assert.ok(h.includes("&lt;script&gt;"));
  assert.ok(h.includes("a&amp;b"));
  // esc itself
  assert.equal(esc('<a href="x">&</a>'), "&lt;a href=\"x\"&gt;&amp;&lt;/a&gt;");
});

test("panel and help expose the full feature set", () => {
  const p = panelHome({
    mode: "manual", aiOk: false, model: "x", conns: 1,
    rules: 2, quick: 3, blocked: 4, stats: { dms: 5, ai: 1, manual: 2, rules: 1, blocked: 1 },
  });
  for (const k of ["m:ai", "m:manual", "m:off", "p:rules", "p:quick", "p:block",
                   "p:profile", "p:clock", "p:rights", "p:stats"]) {
    assert.ok(JSON.stringify(p.reply_markup).includes(k), `panel missing ${k}`);
  }
  const h = helpText();
  for (const c of ["/panel", "/mode", "/pin", "/rules", "/quick", "/block", "/unblock",
                   "/name", "/bio", "/username", "/photo", "/rmphoto", "/rights",
                   "/clock", "/cancel", "/forget", "/start", "/help", "/test", "/stats"]) {
    assert.ok(h.includes(c), `/help missing ${c}`);
  }
});

test("ai layer degrades safely with no key", async () => {
  assert.equal(aiReady({}), false);
  assert.equal(aiReady({ OPENROUTER_API_KEY: "" }), false);
  assert.equal(aiReady({ OPENROUTER_API_KEY: "k" }), false, "needs a model too");
  assert.equal(aiReady({ OPENROUTER_API_KEY: "k", AI_MODEL: "m" }), true);
});

test("clean strips reasoning wrappers but keeps code fences", () => {
  assert.equal(clean("<think>hmm</think>hi"), "hi");
  assert.ok(clean("```python\nprint(1)\n```").includes("```python"));
  assert.equal(clean("User Safety: safe\nhello"), "hello");
  assert.equal(clean(""), "");
});

test("tg:// profile link is only used in a button, never in text", () => {
  // Per the official docs tg://user?id= only works in an inline link or button.
  const h = dmHeader({ name: "Sara", username: "", customerId: 555, text: "hi" });
  assert.ok(!h.includes("tg://"), "tg:// must not appear in message text");
});
