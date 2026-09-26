// Verify the D1 schema + every query against real SQLite (node:sqlite).
// A typo'd column only shows up when the statement actually runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");

function freshDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return db;
}

// Minimal D1 shim: enough surface for src/db.js.
function shim(raw) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              const st = raw.prepare(norm(sql));
              return st.get(...args) ?? null;
            },
            async all() {
              const st = raw.prepare(norm(sql));
              return { results: st.all(...args) };
            },
            async run() {
              const st = raw.prepare(norm(sql));
              return st.run(...args);
            },
          };
        },
        async first() {
          const st = raw.prepare(norm(sql));
          return st.get() ?? null;
        },
        async all() {
          const st = raw.prepare(norm(sql));
          return { results: st.all() };
        },
        async run() {
          return raw.prepare(norm(sql)).run();
        },
      };
    },
  };
}

const D = await import("../src/db.js");
const L = D.db_layer;

test("schema creates every table the app needs", () => {
  const db = freshDB();
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ["settings", "connections", "known_connections", "processed_updates",
                   "drafts", "reply_state", "rules", "quick", "blocked", "pins",
                   "history", "stats", "ratelimit", "audit"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test("connection save/get/list round-trips rights", async () => {
  const db = shim(freshDB());
  await L.saveConnection(db, {
    id: "RDtv0c7IwVG6BwAA", user_id: 7228724103, user_chat_id: 7228724103,
    name: "Amin", rights: { can_reply: true, can_edit_name: true },
  });
  const c = await L.getConnection(db, "RDtv0c7IwVG6BwAA");
  assert.equal(c.user_id, 7228724103);
  assert.equal(c.rights.can_reply, true);
  assert.equal(c.rights.can_edit_bio, undefined);

  const withRight = await L.connWithRight(db, "can_edit_name");
  assert.equal(withRight.id, "RDtv0c7IwVG6BwAA");
  assert.equal(await L.connWithRight(db, "can_view_gifts_and_stars"), null);

  const known = await L.knownConnIds(db);
  assert.ok(known.includes("RDtv0c7IwVG6BwAA"), "id must be remembered for restarts");
});

test("claimUpdate makes an update exactly-once", async () => {
  const db = shim(freshDB());
  assert.equal(await L.claimUpdate(db, 123), true, "first delivery is new");
  assert.equal(await L.claimUpdate(db, 123), false, "Telegram re-delivery must be ignored");
  assert.equal(await L.claimUpdate(db, 124), true, "a different update is new");
  assert.equal(await L.claimUpdate(db, null), true, "no id -> always process");
});

test("drafts, reply state and rules work", async () => {
  const db = shim(freshDB());
  await L.saveDraft(db, { id: "d0000001", customer_id: 555, conn_id: "c1",
                           name: "Sara", username: "sara", text: "hi" });
  const d = await L.getDraft(db, "d0000001");
  assert.equal(d.customer_id, 555);
  assert.equal(d.text, "hi");

  await L.setReply(db, { owner_id: 1, draft_id: "d0000001", conn_id: "c1",
                          customer_id: 555, name: "Sara", mode: null });
  const r = await L.getReply(db, 1);
  assert.equal(r.customer_id, 555);
  await L.clearReply(db, 1);
  assert.equal(await L.getReply(db, 1), null);

  await L.putKv(db, "rules", "قیمت", "به‌زودی");
  assert.equal((await L.listKv(db, "rules"))[0].kw, "قیمت");
  await L.delKv(db, "rules", "قیمت");
  assert.equal((await L.listKv(db, "rules")).length, 0);

  await L.putKv(db, "quick", "سلام", "سلام داداش");
  assert.equal((await L.listKv(db, "quick")).length, 1);
});

test("blocklist and pins", async () => {
  const db = shim(freshDB());
  assert.equal(await L.isBlocked(db, 999), false);
  await L.blockUser(db, 999);
  assert.equal(await L.isBlocked(db, 999), true);
  assert.ok((await L.listBlocked(db)).includes("999"));
  await L.unblockUser(db, 999);
  assert.equal(await L.isBlocked(db, 999), false);

  assert.equal(await L.getPin(db, "c1:5"), null);
  await L.setPin(db, "c1:5", "ai");
  assert.equal(await L.getPin(db, "c1:5"), "ai");
  await L.setPin(db, "c1:5", null);
  assert.equal(await L.getPin(db, "c1:5"), null);
});

test("AI history is bounded per thread and by thread count", async () => {
  const db = shim(freshDB());
  for (let i = 0; i < 100; i++) await L.histAdd(db, "k", "user", `m${i}`);
  const h = await L.histGet(db, "k", 100);
  assert.equal(h.length, 40, "per-thread cap");
  assert.equal(h.at(-1).content, "m99", "newest kept");

  for (let t = 0; t < 60; t++) await L.histAdd(db, `conn:${t}`, "user", "x");
  await L.pruneHistory(db);
  const { results } = await db.prepare("SELECT COUNT(DISTINCT k) AS n FROM history").all();
  assert.ok(results[0].n <= 50, `thread cap exceeded: ${results[0].n}`);
});

test("stats increment and rate limiting counts within a window", async () => {
  const db = shim(freshDB());
  await L.bumpStat(db, "dms");
  await L.bumpStat(db, "dms", 4);
  assert.equal((await L.allStats(db)).dms, 5);

  for (let i = 0; i < 5; i++) {
    const r = await L.rateLimit(db, "ip:1.2.3.4", 3);
    if (i < 3) assert.equal(r.ok, true, `call ${i + 1} should pass`);
    else assert.equal(r.ok, false, `call ${i + 1} should be blocked`);
  }
  // a different key has its own budget
  assert.equal((await L.rateLimit(db, "ip:9.9.9.9", 3)).ok, true);
});

test("draftId is unique per customer and safe for callback_data", async () => {
  const a = D.draftId(1, "c1");
  const b = D.draftId(2, "c1");
  assert.notEqual(a, b);
  assert.ok(!a.includes("_") && !a.includes("-"));
  assert.ok(Buffer.byteLength(a) <= 20);
});

test("audit trail records privileged actions", async () => {
  const db = shim(freshDB());
  await L.audit(db, 42, "mode.set", "ai");
  const { results } = await db.prepare("SELECT * FROM audit").all();
  assert.equal(results.length, 1);
  assert.equal(results[0].actor, 42);
  assert.equal(results[0].action, "mode.set");
});
