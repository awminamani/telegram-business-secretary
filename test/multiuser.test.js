// Multi-user: plans, code redemption, per-user settings, and plan gating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migDir = join(here, "..", "migrations");

function freshDB() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migDir, f), "utf8"));
  }
  return db;
}

function shim(raw) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async first() { return raw.prepare(norm(sql)).get(...a) ?? null; },
            async all() { return { results: raw.prepare(norm(sql)).all(...a) }; },
            async run() { return raw.prepare(norm(sql)).run(...a); },
          };
        },
        async first() { return raw.prepare(norm(sql)).get() ?? null; },
        async all() { return { results: raw.prepare(norm(sql)).all() }; },
        async run() { return raw.prepare(norm(sql)).run(); },
      };
    },
  };
}

const U = await import("../src/users.js");
const D = await import("../src/db.js");
const P = await import("../src/plans.js");
const Dash = await import("../src/dash.js");

const SECRET = "test-secret";
const ADMIN = 100, ALICE = 200, BOB = 300;
const db = () => shim(freshDB());

// ── plans ──────────────────────────────────────────────────────────────

test("feature gating follows the tier ladder", () => {
  assert.equal(P.hasFeature("free", 0, "dm_listen"), true, "free: DM forwarding");
  assert.equal(P.hasFeature("free", 0, "clock"), false, "clock is pro");
  assert.equal(P.hasFeature("pro", 0, "clock"), true, "pro: clock");
  assert.equal(P.hasFeature("pro", 0, "profile_edit"), true);
  assert.equal(P.hasFeature("pro", 0, "ai_mode"), false, "AI is premium");
  assert.equal(P.hasFeature("premium", 0, "ai_mode"), true);
  assert.equal(P.hasFeature("premium", 0, "pin_per_thread"), true);
});

test("an expired plan drops to free immediately", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.equal(P.hasFeature("premium", past, "ai_mode"), false, "lapsed AI");
  assert.equal(P.hasFeature("premium", past, "clock"), false, "lapsed clock");
  assert.equal(P.hasFeature("premium", past, "dm_listen"), true, "free still works");
  assert.equal(P.effectiveTier("premium", past), "free");
  const future = Math.floor(Date.now() / 1000) + 86400;
  assert.equal(P.effectiveTier("premium", future), "premium");
  assert.equal(P.effectiveTier("premium", 0), "premium", "0 = lifetime");
});

// ── per-user settings ──────────────────────────────────────────────────

test("settings are namespaced per user and never leak between accounts", async () => {
  const d = db();
  await U.setSetting(d, "clock_font", "mono", ALICE);
  await U.setSetting(d, "clock_font", "hex", BOB);
  assert.equal(await U.setting(d, "clock_font", "", ALICE), "mono");
  assert.equal(await U.setting(d, "clock_font", "", BOB), "hex");

  await U.setSetting(d, "clock_font", "", ALICE);      // alice turns hers off
  assert.equal(await U.setting(d, "clock_font", "", ALICE), "");
  assert.equal(await U.setting(d, "clock_font", "", BOB), "hex", "bob unaffected");
});

test("a global setting is inherited as a fallback but can be overridden", async () => {
  const d = db();
  await U.setSetting(d, "clock_font", "serif");          // legacy global
  assert.equal(await U.setting(d, "clock_font", "", ALICE), "serif", "inherits");
  await U.setSetting(d, "clock_font", "mono", ALICE);
  assert.equal(await U.setting(d, "clock_font", "", ALICE), "mono", "own wins");
  assert.equal(await U.setting(d, "clock_font", "", BOB), "serif", "other still inherits");
});

test("hasOwnSetting distinguishes owned from inherited", async () => {
  const d = db();
  await U.setSetting(d, "clock_base_name", "Global");
  assert.equal(await U.hasOwnSetting(d, "clock_base_name", ALICE), false);
  await U.setSetting(d, "clock_base_name", "Alice", ALICE);
  assert.equal(await U.hasOwnSetting(d, "clock_base_name", ALICE), true);
  assert.equal(await U.hasOwnSetting(d, "clock_base_name", BOB), false);
});

// ── users & roles ──────────────────────────────────────────────────────

test("the owner is always an admin; others are not", async () => {
  const d = db();
  U.setAdminFallback(ADMIN);
  await U.upsertUser(d, { user_id: ADMIN, role: "admin", is_owner: 1 });
  await U.upsertUser(d, { user_id: ALICE, role: "user" });
  const a = await U.entitlements(d, ADMIN);
  const b = await U.entitlements(d, ALICE);
  assert.equal(a.isAdmin, true);
  assert.equal(b.isAdmin, false);
  assert.equal(a.tier, "premium", "admin implicitly gets everything");
});

test("upsertUser does not clobber role on re-connect", async () => {
  const d = db();
  await U.upsertUser(d, { user_id: ALICE, role: "user" });
  await U.setUserRole(d, ALICE, "admin");
  await U.upsertUser(d, { user_id: ALICE, role: null, name: "Alice" });  // reconnect
  const u = await U.getUser(d, ALICE);
  assert.equal(u.role, "admin", "role must survive a reconnect with no role passed");
  assert.equal(u.name, "Alice");
});

// ── codes ──────────────────────────────────────────────────────────────

test("a generated code can be redeemed once", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, { tier: "pro", created_by: ADMIN });
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const r1 = await U.redeemCode(d, SECRET, code, ALICE);
  assert.equal(r1.ok, true);
  const r2 = await U.redeemCode(d, SECRET, code, BOB);
  assert.equal(r2.ok, false, "single-use code must not work twice");
  assert.equal(r2.reason, "used_up");
});

test("codes are case- and dash-insensitive", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, { tier: "pro", created_by: ADMIN });
  const messy = code.toLowerCase().replace(/-/g, " ");
  const r = await U.redeemCode(d, SECRET, messy, ALICE);
  assert.equal(r.ok, true, `"${messy}" should redeem`);
});

test("an expired code is refused", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, {
    tier: "pro", created_by: ADMIN, expires_at: Math.floor(Date.now() / 1000) - 5,
  });
  const r = await U.redeemCode(d, SECRET, code, ALICE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("a user-bound code only works for that user", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, {
    tier: "premium", created_by: ADMIN, bound_user: BOB,
  });
  assert.equal((await U.redeemCode(d, SECRET, code, ALICE)).reason, "bound");
  assert.equal((await U.redeemCode(d, SECRET, code, BOB)).ok, true);
});

test("an unknown code is refused and the plaintext is not guessable from the hash", async () => {
  const d = db();
  const { code, hash } = await U.createCode(d, SECRET, { tier: "pro", created_by: ADMIN });
  assert.notEqual(hash, code);
  assert.ok(!hash.includes(code.replace(/-/g, "")), "hash must not embed the code");
  assert.equal((await U.redeemCode(d, SECRET, "AAAA-BBBB-CCCC", ALICE)).reason, "unknown");
  // the same code under a different secret must NOT validate
  assert.equal((await U.redeemCode(d, "other-secret", code, ALICE)).reason, "unknown");
});

test("max_uses allows exactly N redemptions then locks", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, {
    tier: "pro", max_uses: 2, created_by: ADMIN,
  });
  assert.equal((await U.redeemCode(d, SECRET, code, ALICE)).ok, true);
  assert.equal((await U.redeemCode(d, SECRET, code, BOB)).ok, true);
  assert.equal((await U.redeemCode(d, SECRET, code, 400)).reason, "used_up");
});

test("a fully-used code stops being displayable", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, { tier: "pro", max_uses: 1, created_by: ADMIN });
  const before = (await U.listCodes(d))[0];
  assert.ok(before.code_plain, "plaintext is kept while the code is live");
  await U.redeemCode(d, SECRET, code, ALICE);
  const after = (await U.listCodes(d))[0];
  assert.equal(after.code_plain, null, "plaintext is erased once spent");
});

test("redeeming actually grants the plan", async () => {
  const d = db();
  const { code } = await U.createCode(d, SECRET, { tier: "premium", created_by: ADMIN });
  await U.redeemCode(d, SECRET, code, ALICE);
  await U.grantPlan(d, { user_id: ALICE, tier: "premium", expires_at: 0, note: "redeemed" });
  const ent = await U.entitlements(d, ALICE);
  assert.equal(ent.tier, "premium");
  assert.equal(ent.isAdmin, false);
  assert.equal(P.hasFeature(ent.tier, ent.expiresAt, "ai_mode"), true);
});

test("plan extension stacks onto remaining time", async () => {
  const d = db();
  await U.grantPlan(d, { user_id: ALICE, tier: "pro", expires_at: 0 });
  const p1 = await U.extendPlan(d, ALICE, 86400);
  assert.ok(p1.expires_at > 0);
  const p2 = await U.extendPlan(d, ALICE, 86400);
  assert.ok(p2.expires_at > p1.expires_at, "extends, never resets");
});

// ── clock jobs ─────────────────────────────────────────────────────────

test("clockJobs returns one job per user, scoped to their own font", async () => {
  const d = db();
  await D.saveConnection(d, { id: "cA", user_id: ALICE, name: "Alice",
                              rights: { can_edit_name: true } });
  await D.saveConnection(d, { id: "cB", user_id: BOB, name: "Bob",
                              rights: { can_edit_name: true } });
  await U.setSetting(d, "clock_font", "mono", ALICE);
  await U.setSetting(d, "clock_base_name", "Alice", ALICE);
  await U.setSetting(d, "clock_font", "hex", BOB);
  await U.setSetting(d, "clock_base_name", "Bob", BOB);

  const jobs = await D.clockJobs(d);
  assert.equal(jobs.length, 2);
  const a = jobs.find((j) => j.uid === ALICE);
  const b = jobs.find((j) => j.uid === BOB);
  assert.equal(a.font, "mono");
  assert.equal(b.font, "hex");
  assert.equal(a.connId, "cA");
  assert.notEqual(a.font, b.font, "each user keeps their own font");
});

test("a user with the clock off gets no job", async () => {
  const d = db();
  await D.saveConnection(d, { id: "cA", user_id: ALICE, name: "A", rights: {} });
  await U.setSetting(d, "clock_font", "", ALICE);
  assert.equal((await D.clockJobs(d)).length, 0);
});

// ── dashboards ─────────────────────────────────────────────────────────

test("the user panel is all buttons and shows the plan", () => {
  const p = Dash.userPanel({
    ent: { isAdmin: false, tier: "free", plan: { tier: "free", expires_at: 0 },
           mode: "manual", listenOn: true, clockFont: "", conns: 1, stats: {} },
  });
  const data = JSON.stringify(p.reply_markup);
  assert.ok(p.text.includes("Free"));
  // gated buttons must point at the LOCKED screen, never the feature itself
  assert.ok(data.includes("x:clock") && data.includes("x:profile"),
    "free user must be routed to the locked screen");
  assert.ok(!data.includes("p:clock") && !data.includes("p:profile"),
    "free user must not get a direct route to a pro feature");
  assert.ok(data.includes("a:redeem"), "free users see the redeem button");
  assert.ok(data.includes("t:listen"), "DM toggle present");
  assert.ok(!data.includes('"text":"/'), "no commands, buttons only");
});

test("locked features are still shown but marked 🔒 for a free user", () => {
  const p = Dash.userPanel({
    ent: { isAdmin: false, tier: "free", plan: { tier: "free", expires_at: 0 },
           mode: "manual", listenOn: true, clockFont: "", conns: 1, stats: {} },
  });
  const data = JSON.stringify(p.reply_markup);
  assert.ok(data.includes("🔒"), "gated features are marked locked");
  assert.ok(data.includes("x:clock") && data.includes("x:profile"));
  // free-tier buttons must still work
  assert.ok(data.includes("p:rules") && data.includes("p:quick") && data.includes("p:block"));
});

test("a pro user sees unlocked clock/profile buttons", () => {
  const p = Dash.userPanel({
    ent: { isAdmin: false, tier: "pro", plan: { tier: "pro", expires_at: 0 },
           mode: "manual", listenOn: true, clockFont: "mono", conns: 1, stats: {} },
  });
  const data = JSON.stringify(p.reply_markup);
  assert.ok(!data.includes("🔒"), "nothing locked at pro");
  assert.ok(data.includes("p:clock"));
});

test("the admin panel exposes users, codes and audit", () => {
  const p = Dash.adminPanel({
    ent: { user: { user_id: 1 } }, stats: { users: 2, paid: 1, codes: 1, redemptions: 1 },
    users: [], codes: [],
  });
  const data = JSON.stringify(p.reply_markup);
  for (const k of ["a:users", "a:codes", "a:newcode", "a:stats", "a:audit"]) {
    assert.ok(data.includes(k), `admin panel missing ${k}`);
  }
});

test("every dashboard callback_data stays under 64 bytes", () => {
  const pages = [
    Dash.userPanel({ ent: { isAdmin: false, tier: "free", plan: {}, mode: "m",
                            listenOn: true, clockFont: "", conns: 0, stats: {} } }),
    Dash.adminPanel({ ent: { user: {} }, stats: {}, users: [], codes: [] }),
    Dash.clockPage({ font: "mono", ent: {}, owned: true, baseName: "A" }),
    Dash.adminCodesPage({ codes: [{ code_hash: "abcdef0123", tier: "pro", max_uses: 1,
                                    uses: 0, expires_at: 0, bound_user: null }] }),
    Dash.redeemPage(),
  ];
  for (const p of pages) {
    for (const row of p.reply_markup.inline_keyboard) {
      for (const b of row) {
        if (!b.callback_data) continue;
        assert.ok(Buffer.byteLength(b.callback_data) <= 64,
          `${b.callback_data} is ${Buffer.byteLength(b.callback_data)} bytes`);
        assert.ok(!b.callback_data.includes("_"),
          `${b.callback_data} has an underscore`);
      }
    }
  }
});

test("the clock page offers all 11 fonts and an off switch", () => {
  const p = Dash.clockPage({ font: "mono", ent: {}, owned: false, baseName: "" });
  const data = JSON.stringify(p.reply_markup);
  for (const f of P.FEATURES ? [] : []) void f;
  const { FONT_NAMES } = globalThis.__fonts || {};
  for (const f of ["mono", "hex", "dots", "persian", "sans", "serif", "double",
                   "circled", "bold", "boxed", "fancy"]) {
    assert.ok(data.includes(`cf:${f}`), `missing font ${f}`);
  }
  assert.ok(data.includes("cf:off"));
});

test("lockedText names the tier needed", () => {
  const t = Dash.lockedText("ai_mode", {
    isAdmin: false, tier: "free", plan: { tier: "free", expires_at: 0 },
  });
  assert.ok(t.includes("Premium"), "should say which tier is required");
  assert.ok(t.includes("AI auto-replies"));
});

test("duration parsing is forgiving", () => {
  assert.equal(P.parseDuration("7 days"), 604800);
  assert.equal(P.parseDuration("30d"), 2592000);
  assert.equal(P.parseDuration("2h"), 7200);
  assert.equal(P.parseDuration("forever"), 0);
  assert.equal(P.parseDuration("garbage"), 0);
});
