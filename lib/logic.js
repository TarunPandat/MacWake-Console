// Pure console/API logic. Same contract as console/worker.js so the Mac daemon works with either.
// KV keys, each with a single writer so an eventually-consistent store never loses an update:
//   cmd      {seq, action:'wake'|'idle', at}                     written by console
//   device   {lastSeen, ac, battery, host, lid, holding, ackSeq, ackAt} written by the Mac
//   settings {interval, hold}                                    written by console
import { createHash, timingSafeEqual } from "node:crypto";

export const DEFAULTS = { interval: 5, hold: 30 }; // minutes

// Pairing (trust on first use): the Mac app generates a random token and registers it once.
// Its SHA-256 is stored under "owner"; afterwards only that token (or ADMIN_TOKEN, if set) is accepted.
// ponytail: first caller wins, so pair right after deploying; to re-pair, delete the "owner" key.
const sha = s => createHash("sha256").update(s).digest("hex");
const same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const bearer = h => (h || "").startsWith("Bearer ") ? h.slice(7).trim() : "";

export async function authed(authHeader, adminToken, kv) {
  const given = bearer(authHeader);
  if (!given) return false;
  if (adminToken && same(given, adminToken)) return true;
  const owner = kv && await kv.get("owner");
  return !!owner && same(sha(given), owner);
}

export async function register(authHeader, kv) {
  const given = bearer(authHeader);
  if (given.length < 32) return { status: 400, body: { error: "token must be at least 32 characters" } };
  const owner = await kv.get("owner");
  if (!owner) { await kv.put("owner", sha(given)); return { status: 201, body: { paired: true } }; }
  return same(sha(given), owner) ? { status: 200, body: { paired: true } } : { status: 409, body: { error: "console already paired with another Mac" } };
}

const get = async (kv, k, d) => { const v = await kv.get(k); return v ? JSON.parse(v) : d; };
const put = (kv, k, v) => kv.put(k, JSON.stringify(v));

export async function state(kv) {
  const [cmd, device, settings] = await Promise.all([get(kv, "cmd", { seq: 0, action: "idle" }), get(kv, "device", {}), get(kv, "settings", DEFAULTS)]);
  // idle -> requested (button) -> awake (Mac acked, holding) -> done (hold expired, Mac asleep again)
  const phase = cmd.action !== "wake" ? "idle" : (device.ackSeq || 0) < cmd.seq ? "requested" : device.holding ? "awake" : "done";
  return { phase, cmd, device, settings, now: Date.now() };
}

/** @returns {Promise<{status:number, body:object}>} */
export async function handle(action, body, kv, now = Date.now()) {
  switch (action) {
    case "state":
      return { status: 200, body: await state(kv) };

    case "wake":
    case "cancel": {
      const cmd = await get(kv, "cmd", { seq: 0 });
      await put(kv, "cmd", { seq: cmd.seq + 1, action: action === "wake" ? "wake" : "idle", at: now });
      return { status: 200, body: await state(kv) };
    }

    case "settings": {
      const cur = await get(kv, "settings", DEFAULTS);
      const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;
      await put(kv, "settings", { interval: clamp(body.interval, 1, 240, cur.interval), hold: clamp(body.hold, 1, 1440, cur.hold) });
      return { status: 200, body: await state(kv) };
    }

    case "heartbeat": {
      // Mac calls this on every wake and every ~60s while awake.
      const [cmd, device, settings] = await Promise.all([get(kv, "cmd", { seq: 0, action: "idle" }), get(kv, "device", {}), get(kv, "settings", DEFAULTS)]);
      // Deliver once per request; re-deliver if the Mac dropped the hold (e.g. rebooted) while the hold window is still open.
      const acked = (device.ackSeq || 0) >= cmd.seq;
      const wake = cmd.action === "wake" && (!acked || (!body.holding && now - (device.ackAt || 0) < settings.hold * 60e3));
      const next = { lastSeen: now, ac: !!body.ac, battery: body.battery ?? null, host: body.host || "", lid: !!body.lid, holding: wake || !!body.holding, ackSeq: wake ? cmd.seq : device.ackSeq || 0, ackAt: wake ? now : device.ackAt || 0 };
      // ponytail: only persist when something changed or 5 min passed, keeps free-tier write quotas happy.
      const changed = ["ac", "lid", "holding", "ackSeq", "host"].some(k => next[k] !== device[k]) || now - (device.lastSeen || 0) > 5 * 60e3;
      if (changed) await put(kv, "device", next);
      return { status: 200, body: { wake, hold: cmd.action === "wake", interval: settings.interval, holdMinutes: settings.hold } };
    }
  }
  return { status: 404, body: { error: "not found" } };
}
