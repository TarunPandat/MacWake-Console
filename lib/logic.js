// Pure console/API logic. Same contract as console/worker.js so the Mac daemon works with either.
// Every Mac is its own account: the random token its app generates. Its keys live under mac:<sha256(token)>:,
// each with a single writer so an eventually-consistent store never loses an update:
//   reg      id of the Mac that registered the token ("1" if unknown) written by the Mac app
//   cmd      {seq, action:'wake'|'idle', at}                     written by console
//   device   {lastSeen, ac, battery, host, lid, holding, ackSeq, ackAt} written by the Mac
//   settings {interval, hold, instant}                           written by console
// Consoles from before multi-Mac kept one Mac under bare keys plus owner = sha256(token); that Mac, and
// ADMIN_TOKEN if set, keep using those until the Mac app is set up again and pairs with a token of its own.
import { createHash, timingSafeEqual } from "node:crypto";

export const DEFAULTS = { interval: 5, hold: 30, instant: true }; // minutes; instant = stay listening on charger

/** Push channel name for a token hash. Unguessable without the token; a push only makes the Mac check in now. */
export const topicFor = hash => `macwake-${hash.slice(0, 40)}`;

/** Nudge the Mac over the push relay (ntfy) so it checks in within seconds instead of at its next timer. */
async function poke({ push, hashes = [] }) {
  if (!push) return;
  await Promise.all(hashes.map(h =>
    fetch(`${push}/${topicFor(h)}`, { method: "POST", body: "wake", signal: AbortSignal.timeout(3000) }).catch(() => {})));
}

// Pairing: the Mac app generates a random token and registers it; any number of Macs can.
// ponytail: registration is open and unthrottled; add a rate limit if spam registrations show up in the store.
const sha = s => createHash("sha256").update(s).digest("hex");
const same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const bearer = h => (h || "").startsWith("Bearer ") ? h.slice(7).trim() : "";

const scoped = (kv, prefix) => ({ get: k => kv.get(prefix + k), put: (k, v) => kv.put(prefix + k, v) });
/** The single Mac of a pre-multi-Mac console (bare keys), opened by its token or ADMIN_TOKEN: its push topics, else null. */
async function legacy(given, adminToken, kv) {
  const owner = await kv.get("owner");
  const ok = (!!adminToken && same(given, adminToken)) || (!!owner && same(sha(given), owner));
  return ok ? [owner, adminToken && sha(adminToken)].filter(Boolean) : null;
}

/** The Mac a bearer token opens: {kv} scoped to its keys, plus {hashes} of the push topics to nudge. null if unknown. */
export async function account(authHeader, adminToken, kv) {
  const given = bearer(authHeader);
  if (!given) return null;
  const h = sha(given);
  if (await kv.get(`mac:${h}:reg`)) return { kv: scoped(kv, `mac:${h}:`), hashes: [h] };
  const hashes = await legacy(given, adminToken, kv);
  return hashes && { kv, hashes };
}

const PAIRED = { status: 200, body: { paired: true } };
const TAKEN = { status: 409, body: { error: "this token belongs to another Mac" } };

/** A token belongs to the first Mac that registers it with its id; another Mac using it is sent off to make its own. */
async function claim(kv, key, machine, current) {
  if (!machine || current === machine) return PAIRED;
  if (current && current !== "1") return TAKEN;   // "1": registered by an app that didn't send its id yet
  await kv.put(key, machine);
  return PAIRED;
}

/** body.mac: sha256 of the Mac's hardware id, sent by the Mac app. */
export async function register(authHeader, adminToken, kv, body = {}) {
  const given = bearer(authHeader);
  const machine = /^[0-9a-f]{64}$/.test(body.mac || "") ? body.mac : "";
  // The shared token of a pre-multi-Mac console (or ADMIN_TOKEN) may be pasted on several Macs, and the console
  // can't tell which is the original: every Mac setting up with it is sent off to make its own.
  if (given && await legacy(given, adminToken, kv)) return TAKEN;
  // Hex only: the Mac app generates hex, and phones read tokens out of QR links as hex.
  if (!/^[0-9a-f]{32,128}$/i.test(given)) return { status: 400, body: { error: "token must be 32 to 128 hex characters" } };
  const key = `mac:${sha(given)}:reg`, current = await kv.get(key);
  if (current) return claim(kv, key, machine, current);
  await kv.put(key, machine || "1");
  return { status: 201, body: { paired: true } };
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
/** opts: {push, hashes}: push is the ntfy server URL (null skips pushes), hashes the topics to nudge (from account). */
export async function handle(action, body, kv, now = Date.now(), opts = {}) {
  switch (action) {
    case "state":
      return { status: 200, body: await state(kv) };

    case "wake":
    case "cancel": {
      const cmd = await get(kv, "cmd", { seq: 0 });
      await put(kv, "cmd", { seq: cmd.seq + 1, action: action === "wake" ? "wake" : "idle", at: now });
      await poke(opts);   // both wake and cancel take effect right away on a listening Mac
      return { status: 200, body: await state(kv) };
    }

    case "settings": {
      const cur = await get(kv, "settings", DEFAULTS);
      const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;
      const instant = typeof body.instant === "boolean" ? body.instant : cur.instant !== false;
      await put(kv, "settings", { interval: clamp(body.interval, 1, 240, cur.interval), hold: clamp(body.hold, 1, 1440, cur.hold), instant });
      await poke(opts);   // apply the new mode now
      return { status: 200, body: await state(kv) };
    }

    case "heartbeat": {
      // Mac calls this on every wake and every ~60s while awake.
      const [cmd, device, settings] = await Promise.all([get(kv, "cmd", { seq: 0, action: "idle" }), get(kv, "device", {}), get(kv, "settings", DEFAULTS)]);
      // Deliver once per request; re-deliver if the Mac dropped the hold (e.g. rebooted) while the hold window is still open.
      const acked = (device.ackSeq || 0) >= cmd.seq;
      const wake = cmd.action === "wake" && (!acked || (!body.holding && now - (device.ackAt || 0) < settings.hold * 60e3));
      const next = { lastSeen: now, ac: !!body.ac, battery: body.battery ?? null, host: body.host || "", lid: !!body.lid, listening: !!body.listening, holding: wake || !!body.holding, ackSeq: wake ? cmd.seq : device.ackSeq || 0, ackAt: wake ? now : device.ackAt || 0 };
      // ponytail: only persist when something changed or 5 min passed, keeps free-tier write quotas happy.
      const changed = ["ac", "lid", "listening", "holding", "ackSeq", "host"].some(k => next[k] !== device[k]) || now - (device.lastSeen || 0) > 5 * 60e3;
      if (changed) await put(kv, "device", next);
      return { status: 200, body: { wake, hold: cmd.action === "wake", interval: settings.interval, holdMinutes: settings.hold, instant: settings.instant !== false, push: opts.push || null } };
    }
  }
  return { status: 404, body: { error: "not found" } };
}
