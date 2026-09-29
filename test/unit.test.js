// The bot is now clock-only. These tests cover what remains, plus the
// guarantees that matter: no DM is ever forwarded, and no message is ever sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

import { safeEqual, makeSecret, validSecret, esc } from "../src/telegram.js";
import {
  tehranParts, tehranISO, styleDigits, clockPreview, stripClock, buildClockName,
  FONT_NAMES, CLOCK_MAX_NAME,
} from "../src/clock.js";

test("secret-token compare rejects the wrong value", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("generated secrets match Telegram's alphabet", () => {
  for (let i = 0; i < 30; i++) assert.ok(validSecret(makeSecret(32)));
  assert.equal(validSecret("has space"), false);
});

test("Tehran time is UTC+3:30 from UTC, never from the local clock", () => {
  assert.equal(tehranISO(Date.UTC(2026, 0, 15, 12, 0, 0)), "2026-01-15 15:30");
  const p = tehranParts(Date.UTC(2026, 0, 15, 20, 37, 0));
  assert.equal(p.H, 0, "00:37 next day in Tehran");
  assert.equal(p.M, 7);
});

test("clock is 24-hour with no AM/PM in any font", () => {
  for (const f of FONT_NAMES) {
    const pv = clockPreview(f);
    assert.ok(!/[AaPp][Mm]/.test(pv), `${f} -> ${pv}`);
  }
  // 20:37 UTC + 3:30 = 00:07 the NEXT day in Tehran
  assert.equal(clockPreview("hex", Date.UTC(2026, 0, 1, 20, 37, 0)), "００:０７");
  assert.equal(clockPreview("hex", Date.UTC(2026, 0, 1, 17, 7, 0)), "２０:３７");
});

test("all fonts render every hour and scrub back off the name", () => {
  for (const f of FONT_NAMES) {
    const hours = new Set();
    for (let h = 0; h < 24; h++) hours.add(styleDigits(String(h).padStart(2, "0"), f));
    assert.equal(hours.size, 24, `${f} produced duplicate hours`);
    const name = buildClockName("Amin", f);
    assert.equal(stripClock(name), "Amin", `${f}: ${name} did not scrub`);
  }
});

test("the clock appends to the name and never replaces it", () => {
  const n = buildClockName("Amin", "mono");
  assert.ok(n.startsWith("Amin · "), n);
  assert.ok(n.length <= CLOCK_MAX_NAME);
  // re-applying must not stack clocks
  assert.equal(stripClock(buildClockName(n, "mono")), "Amin");
  // a real name containing a colon is preserved
  assert.equal(stripClock("Amin: The Boss"), "Amin: The Boss");
});

test("esc neutralises untrusted text", () => {
  assert.ok(!esc("<b>").includes("<b>"));
  assert.equal(esc("a & b"), "a &amp; b");
});

test("THE GUARANTEE: no DM forwarding, no AI auto-reply anywhere", () => {
  const all = ["handle.js", "worker.js", "telegram.js", "db.js", "clock.js"]
    .map((f) => readFileSync(join(src, f), "utf8")).join("\n");
  // nothing may call sendMessage ON BEHALF of a customer
  assert.ok(!/business_connection_id[^\n]*[^/]sendMessage|sendMessage\([^)]*business_connection_id/s
    .test(all.replace(/\s+/g, " ")) || !/forwardToOwner/.test(all),
    "DM forwarding code is still present");
  assert.ok(!/forwardToOwner|handleBusinessMessage.*aiReply/.test(all),
    "forwarding helper still exists");
  assert.ok(!/aiReply|aiReady/.test(all), "AI auto-reply still wired in");
  assert.ok(!/from "\.\/ai\.js"/.test(all), "ai.js is still imported");
  // and the removed modules must be gone
  for (const gone of ["multiuser.js", "users.js", "plans.js", "dash.js", "ai.js", "ui.js"]) {
    let exists = true;
    try { readFileSync(join(src, gone)); } catch { exists = false; }
    assert.equal(exists, false, `src/${gone} should have been deleted`);
  }
});

test("inbound DMs are dropped, not forwarded", () => {
  const h = readFileSync(join(src, "handle.js"), "utf8");
  const fn = h.slice(h.indexOf("async function handleBusinessMessage("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("readBusinessMessage"), "should still mark read");
  assert.ok(!/sendMessage|reply_safe/.test(body),
    "the DM handler must not send anything to the owner or a customer");
});

test("the command menu is clock-only", () => {
  const h = readFileSync(join(src, "handle.js"), "utf8");
  const i = h.indexOf("const COMMANDS = [");
  const list = h.slice(i, h.indexOf("];", i));
  assert.ok(list.includes('"clock"') && list.includes('"start"'));
  for (const gone of ["mode", "rules", "quick", "block", "admin", "panel", "redeem", "listen"]) {
    assert.ok(!list.includes(`"${gone}"`), `${gone} must not be a command any more`);
  }
});
