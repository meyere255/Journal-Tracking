// Storage-agnostic logic for the Execution Log sync server.
// `store` is anything with: all() -> {key: {v, at}}, getMany(keys) -> {key: {v, at}}, putMany({key: {v, at}}).
// Values are the same strings the app keeps in window.storage; `v: null` is a deletion.

export const TZ = "America/New_York";

export function today(tz = TZ, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const addDays = (date, n) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = date => new Date(date + "T12:00:00Z").getUTCDay();
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

// Newer write wins per key. Returns everything that changed after `since` so the client can catch up in one round trip.
export async function sync(store, entries = [], since = 0, now = Date.now()) {
  const incoming = {};
  for (const e of entries) {
    if (!e || typeof e.k !== "string" || e.k.length > 200) continue;
    if (e.v != null && typeof e.v !== "string") continue;
    incoming[e.k] = { v: e.v ?? null, at: Math.min(Number(e.at) || 0, now), base: typeof e.base === "string" ? e.base : null };
  }
  const keys = Object.keys(incoming);
  const current = keys.length ? await store.getMany(keys) : {};
  const writes = {};
  for (const k of keys) {
    const cur = current[k];
    // A never-synced local value (at 0) only fills a gap; it never overwrites the server.
    const inc = incoming[k];
    if (!cur) writes[k] = { v: inc.v, at: inc.at || now };
    // A day the client edited from a known base: keep whatever else changed it meanwhile (Muse, Claude, another device).
    else if (inc.base != null && k.startsWith("day:") && inc.v != null && cur.v != null) {
      if (cur.v === inc.base) writes[k] = { v: inc.v, at: now };
      else if (inc.v !== inc.base) writes[k] = { v: mergeDay(inc.base, inc.v, cur.v), at: now };
    }
    else if (inc.at > cur.at) writes[k] = { v: inc.v, at: inc.at };
  }
  if (Object.keys(writes).length) await store.putMany(writes);
  const all = await store.all();
  const changed = Object.entries(all)
    .filter(([, e]) => e.at > since)
    .map(([k, e]) => ({ k, v: e.v, at: e.at }));
  return { now, entries: changed };
}

// Three-way merge of a day record: apply only the fields the client changed since `base` onto the server's copy.
export function mergeDay(baseStr, mineStr, theirsStr) {
  const base = parse(baseStr) || {}, mine = parse(mineStr) || {}, theirs = parse(theirsStr) || {};
  const out = { ...theirs, checks: { ...(theirs.checks || {}) }, v2: true };
  for (const f of ["am", "pm"]) if ((mine[f] || "") !== (base[f] || "")) out[f] = mine[f] || "";
  const bc = base.checks || {}, mc = mine.checks || {};
  for (const id of new Set([...Object.keys(bc), ...Object.keys(mc)])) if (!!mc[id] !== !!bc[id]) out.checks[id] = !!mc[id];
  return JSON.stringify(out);
}

// ---- Schedule helpers (mirror the app) ----

function scheduleFor(all, date) {
  const sched = parse(all["__schedule"]?.v);
  if (!sched || !sched.days) return null;
  return sched.days[weekday(date)] || null;
}

function dayRecord(all, date) {
  return parse(all["day:" + date]?.v) || { checks: {}, am: "", pm: "" };
}

function doneMap(rec, items) {
  const out = {};
  Object.entries(rec.checks || {}).forEach(([k, v]) => {
    if (!v) return;
    if (/^\d+$/.test(k)) { const it = items[+k]; if (it) out[it[3]] = true; }
    else out[k] = true;
  });
  return out;
}

export function groupName(label) {
  const l = String(label).replace(/\s*\([^)]*\)\s*$/, "").trim();
  const rules = [
    [/^Journal — entry 1/, "Journal 1"], [/^Journal — entry 2/, "Journal 2"], [/^Up$/, "Up on time"],
    [/^CFA — Ethics/, "CFA ethics reps"], [/^CFA — review/, "CFA review + flashcards"], [/^CFA study/, "CFA study"],
    [/^Breakfast/, "Breakfast"], [/^Dinner/, "Dinner"], [/^MEAL PREP/, "Meal prep"], [/^GYM/, "Gym"],
    [/^Markets/, "Markets"], [/^Coursework/, "Coursework"]
  ];
  for (const [re, name] of rules) if (re.test(l)) return name;
  return l;
}

export function getDay(all, date) {
  const day = scheduleFor(all, date);
  if (!day) return { error: "No schedule has been synced yet. Open the Execution Log once with sync turned on." };
  const rec = dayRecord(all, date);
  const done = doneMap(rec, day.items);
  const wake = parse(all["wake:" + date]?.v);
  const blocks = day.items.map(([time, label, cat, id]) => ({ id, time, label, category: cat, done: !!done[id] }));
  return {
    date, weekday: day.label, theme: day.tag,
    done: blocks.filter(b => b.done).length, total: blocks.length,
    wake_adjustment: wake || null,
    blocks,
    journal: { morning: rec.am || "", evening: rec.pm || "" }
  };
}

export function getStats(all, days = 30, end = today()) {
  const sched = parse(all["__schedule"]?.v);
  if (!sched || !sched.days) return { error: "No schedule has been synced yet." };
  const logged = Object.keys(all)
    .filter(k => k.startsWith("day:") && all[k].v)
    .map(k => k.slice(4))
    .filter(d => d <= end && Object.values(parse(all["day:" + d].v)?.checks || {}).some(Boolean))
    .sort();
  if (!logged.length) return { from: null, to: end, days: 0, boxes: [], message: "Nothing checked off yet." };
  let from = logged[0];
  const floor = addDays(end, -(Math.max(1, days) - 1));
  if (floor > from) from = floor;
  const groups = {};
  let total = 0, done = 0, n = 0;
  for (let d = from; d <= end; d = addDays(d, 1)) {
    n++;
    const day = sched.days[weekday(d)];
    if (!day) continue;
    const ok = doneMap(dayRecord(all, d), day.items);
    for (const [, label, cat, id] of day.items) {
      if (/^Free\b/.test(label)) continue;
      const g = groupName(label);
      const row = groups[g] || (groups[g] = { box: g, category: cat, done: 0, scheduled: 0 });
      row.scheduled++; total++;
      if (ok[id]) { row.done++; done++; }
    }
  }
  const boxes = Object.values(groups)
    .map(r => ({ ...r, percent: r.scheduled ? Math.round(r.done / r.scheduled * 100) : 0 }))
    .sort((a, b) => b.scheduled - a.scheduled || a.box.localeCompare(b.box));
  return { from, to: end, days: n, done, scheduled: total, percent: total ? Math.round(done / total * 100) : 0, boxes };
}

export function findBlock(day, query) {
  const q = String(query).trim().toLowerCase();
  return day.items.find(it => it[3].toLowerCase() === q)
    || day.items.find(it => it[1].toLowerCase() === q)
    || day.items.find(it => groupName(it[1]).toLowerCase() === q)
    || day.items.find(it => it[1].toLowerCase().includes(q));
}

// ---- MCP (Streamable HTTP, JSON responses) ----

const TABS = { expenses: "spend", owed: "owed", reading: "books", pipeline: "apps", car: "car", portfolio: "lego", recipes: "recipes", notes: "tabs" };
const dateProp = { type: "string", description: "Date as YYYY-MM-DD. Defaults to today (US Eastern)." };

export const TOOLS = [
  { name: "get_day", description: "Eric's schedule for one day from his Execution Log: each block's time, label, category and whether it is checked off, plus any wake-up adjustment and that day's journal entries.",
    inputSchema: { type: "object", properties: { date: dateProp } } },
  { name: "get_stats", description: "Completion stats per box (for example Journal 1: 20/35) over the last N days, counted from the first check-off.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365, description: "How many days back, including today. Default 30." } } } },
  { name: "get_week_schedule", description: "The planned blocks for every weekday (Sunday=0 … Saturday=6), as saved in the app's Edit week tab.",
    inputSchema: { type: "object", properties: {} } },
  { name: "set_block_done", description: "Check off (or un-check) one block on a day. `block` can be the block's label (for example 'CFA study'), its box name, or its id.",
    inputSchema: { type: "object", required: ["block"], properties: { date: dateProp, block: { type: "string" }, done: { type: "boolean", description: "Default true." } } } },
  { name: "add_journal_note", description: "Append text to the morning or evening journal entry for a day.",
    inputSchema: { type: "object", required: ["entry", "text"], properties: { date: dateProp, entry: { type: "string", enum: ["morning", "evening"] }, text: { type: "string", maxLength: 4000 } } } },
  { name: "read_tab", description: "Raw saved data from another Execution Log tab: " + Object.keys(TABS).join(", ") + ".",
    inputSchema: { type: "object", required: ["tab"], properties: { tab: { type: "string", enum: Object.keys(TABS) } } } }
];

async function callTool(store, name, args = {}, now = Date.now()) {
  const all = await store.all();
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : today();
  switch (name) {
    case "get_day": return getDay(all, date);
    case "get_stats": return getStats(all, Number(args.days) || 30);
    case "get_week_schedule": {
      const s = parse(all["__schedule"]?.v);
      return s || { error: "No schedule has been synced yet." };
    }
    case "set_block_done": {
      const day = scheduleFor(all, date);
      if (!day) return { error: "No schedule has been synced yet." };
      const it = findBlock(day, args.block || "");
      if (!it) return { error: `No block matching "${args.block}" on ${date}.`, blocks: day.items.map(i => i[1]) };
      const rec = dayRecord(all, date);
      rec.checks = doneMap(rec, day.items);
      rec.v2 = true;
      rec.checks[it[3]] = args.done !== false;
      await store.putMany({ ["day:" + date]: { v: JSON.stringify(rec), at: now } });
      return { ok: true, date, block: it[1], done: args.done !== false };
    }
    case "add_journal_note": {
      const key = args.entry === "evening" ? "pm" : "am";
      const text = String(args.text || "").slice(0, 4000).trim();
      if (!text) return { error: "Nothing to add." };
      const rec = dayRecord(all, date);
      rec[key] = rec[key] ? rec[key] + "\n\n" + text : text;
      await store.putMany({ ["day:" + date]: { v: JSON.stringify(rec), at: now } });
      return { ok: true, date, entry: args.entry === "evening" ? "evening" : "morning" };
    }
    case "read_tab": {
      const key = TABS[args.tab];
      if (!key) return { error: "Unknown tab." };
      return parse(all[key]?.v) ?? { empty: true };
    }
  }
  throw Object.assign(new Error("Unknown tool: " + name), { code: -32602 });
}

export async function handleMcp(store, msg) {
  const reply = result => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  if (msg.id === undefined) return null; // notification
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "execution-log", version: "1.0.0" },
        instructions: "Eric's Execution Log: daily schedule, check-offs, stats and journal. Dates are US Eastern."
      });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      try {
        const out = await callTool(store, msg.params?.name, msg.params?.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: !!out?.error });
      } catch (e) {
        return fail(e.code || -32603, e.message);
      }
    }
    default: return fail(-32601, "Method not found");
  }
}
