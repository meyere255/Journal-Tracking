import { DurableObject } from "cloudflare:workers";
import { sync, handleMcp } from "./core.js";

// One Durable Object holds every key the app saves, as { v, at }.
export class Store extends DurableObject {
  async all() {
    const out = {};
    for (const [k, e] of await this.ctx.storage.list({ prefix: "e:" })) out[k.slice(2)] = e;
    return out;
  }
  async getMany(keys) {
    const out = {};
    for (const [k, e] of await this.ctx.storage.get(keys.map(k => "e:" + k))) out[k.slice(2)] = e;
    return out;
  }
  async putMany(map) {
    const entries = Object.entries(map).map(([k, e]) => ["e:" + k, e]);
    for (let i = 0; i < entries.length; i += 128) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400"
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

// Constant-time compare so the key can't be guessed byte by byte.
function same(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("Execution Log sync is running.", { headers: CORS });
    if (!env.ELOG_KEY || env.ELOG_KEY.length < 16) return json({ error: "Set the ELOG_KEY secret (16+ characters) on this Worker first." }, 500);

    // The key can come as a Bearer header (the app) or as the last path segment (/mcp/<key>, for MCP clients that only take a URL).
    const parts = url.pathname.split("/").filter(Boolean);
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const given = parts[0] === "mcp" && parts[1] ? parts[1] : bearer;
    if (!same(given, env.ELOG_KEY)) return json({ error: "Unauthorized" }, 401);

    const store = env.STORE.get(env.STORE.idFromName("eric"));

    if (parts[0] === "api" && parts[1] === "sync" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return json(await sync(store, body.entries || [], Number(body.since) || 0));
    }
    if (parts[0] === "mcp") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", ...CORS } });
      const msg = await request.json().catch(() => null);
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(m => handleMcp(store, m)))).filter(Boolean);
        return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
      }
      const out = await handleMcp(store, msg);
      return out ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    return json({ error: "Not found" }, 404);
  }
};
