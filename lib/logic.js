// Pure console/API logic. Same contract as console/worker.js so the Mac daemon works with either.
// Every Mac is its own account: the random token its app generates. Its keys live under mac:<sha256(token)>:,
// each with a single writer so an eventually-consistent store never loses an update:
//   reg      id of the Mac that registered the token ("1" if unknown) written by the Mac app
//   cmd      {seq, action:'wake'|'idle', at}                     written by console
//   device   {lastSeen, ac, battery, host, lid, holding, ackSeq, ackAt} written by the Mac
//   settings {interval, hold, instant}                           written by console
//   screenOffer  {id, sdp, at}                                 written by a viewer (live screen)
//   screenAnswer {id, sdp?, error?, at}                        written by the Mac's menu-bar app
// Consoles from before multi-Mac kept one Mac under bare keys plus owner = sha256(token); that Mac, and
// ADMIN_TOKEN if set, keep using those until the Mac app is set up again and pairs with a token of its own.
import { createHash, timingSafeEqual } from "node:crypto";

export const DEFAULTS = { interval: 5, hold: 30, instant: true }; // minutes; instant = stay listening on charger

/** Push channel name for a token hash. Unguessable without the token; a push only makes the Mac check in now. */
export const topicFor = hash => `macwake-${hash.slice(0, 40)}`;

/** Nudge the Mac over the push relay (ntfy). The daemon listens on the bare topic, the menu-bar app on "-screen". */
async function poke({ push, hashes = [] }, suffix = "") {
  if (!push) return;
  await Promise.all(hashes.map(h =>
    fetch(`${push}/${topicFor(h)}${suffix}`, { method: "POST", body: "wake", signal: AbortSignal.timeout(3000) }).catch(() => {})));
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

// Live screen: WebRTC signaling through the console. The viewer writes screenOffer, the Mac writes screenAnswer
// (one writer each); the video itself flows straight from the Mac to the viewer.
export const OFFER_TTL = 60e3;
const SCREEN_ERRORS = ["disabled", "permission", "no-display", "failed"];
const isId = v => typeof v === "string" && /^[0-9a-f]{16,64}$/.test(v);
const isSdp = v => typeof v === "string" && v.length > 0 && v.length <= 20000;
const bad = error => ({ status: 400, body: { error } });

/** Free STUN always; one TURN entry when TURN_URLS is set (e.g. Metered's free Open Relay). */
export function iceServers(env) {
  const ice = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const turn = (env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (turn.length) ice.push({ urls: turn, username: env.TURN_USERNAME || "", credential: env.TURN_CREDENTIAL || "" });
  return ice;
}

async function screen(body, kv, now, opts) {
  const ice = opts.ice || [];
  const given = ["offer", "answer", "error"].filter(k => body[k] !== undefined);
  if (!given.length) {
    const [offer, answer] = await Promise.all([get(kv, "screenOffer", null), get(kv, "screenAnswer", null)]);
    return { status: 200, body: { ice, push: opts.push || null, offer: offer && now - offer.at <= OFFER_TTL ? offer : null, answer } };
  }
  if (given.length > 1) return bad("send one of offer, answer or error");
  if (!isId(body.id)) return bad("id must be 16 to 64 hex characters");
  if (body.offer !== undefined) {
    if (!isSdp(body.offer)) return bad("offer must be 1 to 20000 characters");
    await put(kv, "screenOffer", { id: body.id, sdp: body.offer, at: now });
    await poke(opts, "-screen");   // wakes the menu-bar app's listener, not the daemon
    return { status: 200, body: { ok: true, ice } };
  }
  if (body.answer !== undefined && !isSdp(body.answer)) return bad("answer must be 1 to 20000 characters");
  if (body.error !== undefined && !SCREEN_ERRORS.includes(body.error)) return bad("unknown error");
  await put(kv, "screenAnswer", body.answer !== undefined ? { id: body.id, sdp: body.answer, at: now } : { id: body.id, error: body.error, at: now });
  return { status: 200, body: { ok: true } };
}

/** @returns {Promise<{status:number, body:object}>} */
/** opts: {push, hashes, ice}: push is the ntfy server URL (null skips pushes), hashes the topics to nudge (from account), ice the WebRTC servers. */
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

    case "screen":
      return screen(body, kv, now, opts);

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
