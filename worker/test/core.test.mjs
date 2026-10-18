import { test } from "node:test";
import assert from "node:assert/strict";
import { sync, handleMcp, getStats, findBlock } from "../src/core.js";

const memStore = () => {
  const m = new Map();
  return {
    m,
    async all() { return Object.fromEntries(m); },
    async getMany(keys) { return Object.fromEntries(keys.filter(k => m.has(k)).map(k => [k, m.get(k)])); },
    async putMany(map) { for (const [k, e] of Object.entries(map)) m.set(k, e); }
  };
};

const SCHED = { days: {
  0: { label: "Sunday", tag: "Prep", items: [["09:00", "Up", "RTN", "sun-wake"], ["09:05", "Journal — entry 1", "RTN", "sun-journal1"], ["12:45", "CFA study — 1h50", "CFA", "sun-cfa"]] },
  1: { label: "Monday", tag: "Lectures", items: [["07:40", "Up", "RTN", "mon-wake"], ["07:45", "Journal — entry 1", "RTN", "mon-journal1"], ["15:15", "CFA study — 1h20", "CFA", "mon-cfa1"]] },
  2: { label: "Tuesday", tag: "", items: [] }, 3: { label: "Wednesday", tag: "", items: [] }, 4: { label: "Thursday", tag: "", items: [] },
  5: { label: "Friday", tag: "", items: [] }, 6: { label: "Saturday", tag: "", items: [] }
} };

test("newer write wins and an unsynced local value only fills gaps", async () => {
  const s = memStore();
  await sync(s, [{ k: "a", v: "server", at: 100 }], 0, 1000);
  await sync(s, [{ k: "a", v: "old local", at: 0 }], 0, 1000);
  assert.equal(s.m.get("a").v, "server");
  await sync(s, [{ k: "a", v: "newer", at: 200 }], 0, 1000);
  assert.equal(s.m.get("a").v, "newer");
  await sync(s, [{ k: "a", v: "stale", at: 150 }], 0, 1000);
  assert.equal(s.m.get("a").v, "newer");
  const fresh = await sync(s, [{ k: "b", v: "first", at: 0 }], 0, 1000);
  assert.equal(s.m.get("b").at, 1000);
  assert.ok(fresh.entries.some(e => e.k === "b"));
});

test("sync returns only what changed since the client's last sync", async () => {
  const s = memStore();
  await sync(s, [{ k: "x", v: "1", at: 10 }, { k: "y", v: "2", at: 50 }], 0, 1000);
  const r = await sync(s, [], 20, 1000);
  assert.deepEqual(r.entries.map(e => e.k), ["y"]);
});

test("future timestamps are clamped to server time", async () => {
  const s = memStore();
  await sync(s, [{ k: "a", v: "x", at: 9e15 }], 0, 1000);
  assert.equal(s.m.get("a").at, 1000);
});

const seeded = async () => {
  const s = memStore();
  await s.putMany({
    "__schedule": { v: JSON.stringify(SCHED), at: 1 },
    "day:2026-10-18": { v: JSON.stringify({ checks: { "sun-journal1": true }, am: "", pm: "", v2: true }), at: 1 },
    "day:2026-10-19": { v: JSON.stringify({ checks: { "mon-journal1": true, "mon-wake": true }, am: "", pm: "", v2: true }), at: 1 }
  });
  return s;
};

test("stats count every scheduled day from the first check-off", async () => {
  const s = await seeded();
  const st = getStats(await s.all(), 30, "2026-10-19");
  assert.equal(st.days, 2);
  const j = st.boxes.find(b => b.box === "Journal 1");
  assert.deepEqual([j.done, j.scheduled], [2, 2]);
  const c = st.boxes.find(b => b.box === "CFA study");
  assert.deepEqual([c.done, c.scheduled], [0, 2]);
});

test("findBlock matches id, label, box name and substring", () => {
  const day = SCHED.days[0];
  assert.equal(findBlock(day, "sun-cfa")[3], "sun-cfa");
  assert.equal(findBlock(day, "cfa study")[3], "sun-cfa");
  assert.equal(findBlock(day, "Journal 1")[3], "sun-journal1");
  assert.equal(findBlock(day, "journal")[3], "sun-journal1");
});

test("MCP: initialize, list tools, check off a block, read the day back", async () => {
  const s = await seeded();
  const init = await handleMcp(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "execution-log");
  assert.equal(await handleMcp(s, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handleMcp(s, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.result.tools.some(t => t.name === "set_block_done"));
  const set = await handleMcp(s, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set_block_done", arguments: { date: "2026-10-18", block: "CFA study" } } });
  assert.equal(set.result.isError, false);
  const day = await handleMcp(s, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_day", arguments: { date: "2026-10-18" } } });
  const d = day.result.structuredContent;
  assert.equal(d.done, 2);
  assert.equal(d.blocks.find(b => b.id === "sun-cfa").done, true);
  assert.ok(s.m.get("day:2026-10-18").at > 1, "write is stamped so the app picks it up");
});

test("MCP: journal notes append, unknown methods error", async () => {
  const s = await seeded();
  for (const text of ["first", "second"])
    await handleMcp(s, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "add_journal_note", arguments: { date: "2026-10-18", entry: "evening", text } } });
  assert.equal(JSON.parse(s.m.get("day:2026-10-18").v).pm, "first\n\nsecond");
  const bad = await handleMcp(s, { jsonrpc: "2.0", id: 6, method: "nope" });
  assert.equal(bad.error.code, -32601);
});

test("a day edited on a device keeps a check-off made elsewhere meanwhile", async () => {
  const s = memStore();
  const base = JSON.stringify({ checks: { a: true }, am: "", pm: "", v2: true });
  await sync(s, [{ k: "day:2026-10-18", v: base, at: 100 }], 0, 1000);
  // Muse checks off b on the server
  await s.putMany({ "day:2026-10-18": { v: JSON.stringify({ checks: { a: true, b: true }, am: "", pm: "", v2: true }), at: 1100 } });
  // the phone, still on the old base, checks c and unchecks a
  const mine = JSON.stringify({ checks: { a: false, c: true }, am: "note", pm: "", v2: true });
  await sync(s, [{ k: "day:2026-10-18", v: mine, at: 1050, base }], 0, 2000);
  const out = JSON.parse(s.m.get("day:2026-10-18").v);
  assert.deepEqual(out.checks, { a: false, b: true, c: true });
  assert.equal(out.am, "note");
  assert.equal(s.m.get("day:2026-10-18").at, 2000);
});
