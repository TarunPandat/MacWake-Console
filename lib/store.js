// Key-value store: Upstash Redis over REST (Vercel KV / Upstash integration env vars) or a local JSON file for dev.
import { promises as fs } from "node:fs";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = {
  async get(k) {
    const r = await fetch(`${url}/get/${k}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!r.ok) throw new Error(`kv get ${r.status}`);
    return (await r.json()).result ?? null;
  },
  async put(k, v) {
    const r = await fetch(`${url}/set/${k}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: v });
    if (!r.ok) throw new Error(`kv set ${r.status}`);
  },
};

// ponytail: single-process file store for `next dev`; not for serverless (ephemeral disk).
const FILE = process.env.MACWAKE_STATE_FILE || ".data/state.json";
const file = {
  async read() { try { return JSON.parse(await fs.readFile(FILE, "utf8")); } catch { return {}; } },
  async get(k) { return (await this.read())[k] ?? null; },
  async put(k, v) { const d = await this.read(); d[k] = v; await fs.mkdir(FILE.replace(/\/[^/]*$/, ""), { recursive: true }); await fs.writeFile(FILE, JSON.stringify(d)); },
};

export const kv = url && token ? redis : file;
export const backend = url && token ? "upstash" : "file";
