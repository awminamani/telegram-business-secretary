// Verify the three new features: DM listening toggle, batched tick, accuracy.
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

function shim(raw) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return raw.prepare(norm(sql)).get(...args) ?? null; },
            async all() { return { results: raw.prepare(norm(sql)).all(...args) }; },
            async run() { return raw.prepare(norm(sql)).run(...args); },
          };
        },
        async first() { return raw.prepare(norm(sql)).get() ?? null; },
        async all() { return { results: raw.prepare(norm(sql)).all() }; },
        async run() { return raw.prepare(norm(sql)).run(); },
      };
    },
  };
}

const D = await import("../src/db.js");
const L = D.db_layer;
const tickState = D.tickState;   // top-level export, not on db_layer

test("tickState returns the whole clock state in ONE query", async () => {
  const db = shim(freshDB());
  await L.setSetting(db, "clock_font", "mono");
  await L.setSetting(db, "clock_base_name", "Amin");
  await L.setSetting(db, "clock_applied", "Amin · 12:00");
  await L.saveConnection(db, {
    id: "c1", user_id: 1, name: "Amin",
    rights: { can_reply: true, can_edit_name: true },
  });

  const s = await tickState(db);
  assert.equal(s.clock_font, "mono");
  assert.equal(s.clock_base_name, "Amin");
  assert.equal(s.clock_applied, "Amin · 12:00");
  assert.equal(s.name_conn_id, "c1", "must find the can_edit_name connection");
});

test("tickState works when the clock is off and nothing exists", async () => {
  const db = shim(freshDB());
  const s = await tickState(db);
  assert.equal(s.clock_font, null);
  assert.equal(s.name_conn_id, null);
});

test("tickState only picks connections that were granted can_edit_name", async () => {
  const db = shim(freshDB());
  await L.saveConnection(db, { id: "no_right", user_id: 1, name: "X",
                                rights: { can_reply: true } });
  const s = await tickState(db);
  assert.equal(s.name_conn_id, null, "must not pick a connection lacking the right");
});

test("DM listening toggle persists", async () => {
  const db = shim(freshDB());
  assert.equal(await L.setting(db, "listen_dm", "on"), "on", "default is on");
  await L.setSetting(db, "listen_dm", "off");
  assert.equal(await L.setting(db, "listen_dm", "on"), "off");
  await L.setSetting(db, "listen_dm", "on");
  assert.equal(await L.setting(db, "listen_dm", "on"), "on");
});

test("panelHome shows a listening toggle and the DMs state", async () => {
  const { panelHome } = await import("../src/ui.js");
  const on = panelHome({ mode: "manual", aiOk: false, model: "m", conns: 1,
                         rules: 0, quick: 0, blocked: 0, stats: {},
                         listenOn: true });
  const off = panelHome({ mode: "manual", aiOk: false, model: "m", conns: 1,
                          rules: 0, quick: 0, blocked: 0, stats: {},
                          listenOn: false });
  assert.match(on.text, /DMs: <b>ON<\/b>/);
  assert.match(off.text, /DMs: <b>OFF<\/b>/);
  const cbs = JSON.stringify(on.reply_markup);
  assert.ok(cbs.includes("t:listen"), "toggle button present");
  assert.ok(cbs.includes('Turn DM listening OFF'), "label reflects current state");
  const offCbs = JSON.stringify(off.reply_markup);
  assert.ok(offCbs.includes('Turn DM listening ON'), "label flips when off");
  // the clock button must still exist exactly once
  const n = (offCbs.match(/p:clock/g) || []).length;
  assert.equal(n, 1, `clock button should appear once, saw ${n}`);
});

test("help documents /listen", async () => {
  const { helpText } = await import("../src/ui.js");
  const h = helpText();
  assert.ok(h.includes("/listen off"), "help missing /listen off");
  assert.ok(h.includes("/listen on"), "help missing /listen on");
});

test("commands menu includes listen", async () => {
  const { COMMANDS } = await import("../src/handle.js");
  const names = COMMANDS.map(([c]) => c);
  assert.ok(names.includes("listen"), `listen not in menu: ${names.join(",")}`);
});
