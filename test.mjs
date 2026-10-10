// node test.mjs -- exercises lib/logic.js against an in-memory store, no server needed.
import { account, handle, register, topicFor } from "./lib/logic.js";
import { createHash } from "node:crypto";
const mem = new Map();
const kv = { get: async k => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const call = async (action, body) => (await handle(action, body || {}, kv)).body;

const sha = t => createHash("sha256").update(t).digest("hex");
const B = t => "Bearer " + t;
const T1 = "a".repeat(48), T2 = "b".repeat(48), OLD = "c".repeat(48);

// Every Mac registers its own token; none is refused.
eq((await register("Bearer short", "", kv)).status, 400, "short token rejected");
eq((await register(B("z".repeat(48)), "", kv)).status, 400, "non-hex token rejected");
eq(await account(B(T1), "", kv), null, "unregistered token rejected");
eq((await register(B(T1), "", kv)).status, 201, "first Mac pairs");
eq((await register(B(T1), "", kv)).status, 200, "same Mac re-pairs");
eq((await register(B(T2), "", kv, { mac: "2".repeat(64) })).status, 201, "second Mac pairs too");
eq((await register(B(T2), "", kv, { mac: "2".repeat(64) })).status, 200, "same Mac re-pairs with its id");
eq((await register(B(T2), "", kv, { mac: "3".repeat(64) })).status, 409, "a copied token is refused on another Mac");
eq((await register(B(T1), "", kv, { mac: "4".repeat(64) })).status, 200, "a token registered without an id binds to the first Mac that sends one");
eq((await register(B(T1), "", kv, { mac: "5".repeat(64) })).status, 409, "then stays with it");
eq((await register(B(T1), "", kv, { mac: "not hex" })).status, 200, "a malformed id is ignored");
eq(await account("", "", kv), null, "no header");
eq(await account(B("f".repeat(48)), "", kv), null, "unknown token rejected");
const m1 = await account(B(T1), "", kv), m2 = await account(B(T2), "", kv);
eq([m1.hashes, m2.hashes], [[sha(T1)], [sha(T2)]], "each Mac pushes to its own topic");
await handle("wake", {}, m1.kv);
eq([(await handle("state", {}, m1.kv)).body.phase, (await handle("state", {}, m2.kv)).body.phase], ["requested", "idle"], "Macs don't see each other's state");
eq((await handle("heartbeat", {}, m2.kv)).body.wake, false, "other Mac not woken");

// A console from before multi-Mac: one Mac under bare keys, opened by its token or ADMIN_TOKEN.
const old = new Map([["owner", sha(OLD)], ["settings", JSON.stringify({ interval: 7, hold: 30, instant: true })]]);
const okv = { get: async k => old.get(k) ?? null, put: async (k, v) => { old.set(k, v); } };
const M1 = "1".repeat(64), M2 = "2".repeat(64);
eq((await register(B(OLD), "", okv, { mac: M1 })).status, 409, "the old shared token is never a Mac's own: setting up again makes one");
eq((await register(B(OLD), "", okv)).status, 409, "also for apps that send no id");
eq((await register(B("s3cret"), "s3cret", okv, { mac: M2 })).status, 409, "same for ADMIN_TOKEN");
eq((await handle("state", {}, (await account(B(OLD), "", okv)).kv)).body.settings.interval, 7, "old Mac keeps its data");
eq((await account(B("s3cret"), "s3cret", okv)).hashes, [sha(OLD), sha("s3cret")], "admin token opens the old Mac");
eq(await account(B("s3cret"), "", okv), null, "admin token needs ADMIN_TOKEN set");
eq((await register(B(T1), "", okv)).status, 201, "new Macs still pair on an old console");
eq((await handle("nope", {}, kv)).status, 404, "unknown action");

let s = await call("state"); eq(s.phase, "idle", "initial idle");
let hb = await call("heartbeat", { ac: true, battery: 80, host: "mbp" }); eq(hb.wake, false, "no wake pending");
s = await call("wake"); eq(s.phase, "requested", "requested");
hb = await call("heartbeat", { ac: true, battery: 80, host: "mbp" }); eq([hb.wake, hb.hold], [true, true], "mac told to wake once");
hb = await call("heartbeat", { ac: true, holding: true, host: "mbp" }); eq([hb.wake, hb.hold], [false, true], "already acked, still hold");
s = await call("state"); eq(s.phase, "awake", "awake after ack");
hb = await call("heartbeat", { ac: true, holding: false, host: "mbp" }); eq([hb.wake, hb.hold], [true, true], "hold dropped inside window: re-delivered");
hb = await call("heartbeat", { ac: true, holding: true, host: "mbp" }); eq(hb.wake, false, "holding again");
mem.set("device", JSON.stringify({ ...JSON.parse(mem.get("device")), holding: false, ackAt: Date.now() - 31 * 60e3 }));
hb = await call("heartbeat", { ac: true, holding: false, host: "mbp" }); eq(hb.wake, false, "hold window over: no re-delivery");
s = await call("state"); eq(s.phase, "done", "done after hold expired");
s = await call("wake"); eq(s.phase, "requested", "wake again from done");
hb = await call("heartbeat", { ac: true, holding: false, host: "mbp" }); eq(hb.wake, true, "second wake delivered");
s = await call("cancel"); eq(s.phase, "idle", "released");
hb = await call("heartbeat", { ac: false, holding: false, host: "mbp" }); eq(hb.hold, false, "mac told to stop holding");
s = await call("wake"); s = await call("cancel"); eq(s.phase, "idle", "cancel before ack");
hb = await call("heartbeat", { host: "mbp" }); eq(hb.wake, false, "cancelled request not delivered");
s = await call("settings", { interval: 999, hold: "x" }); eq(s.settings, { interval: 240, hold: 30, instant: true }, "settings clamp, instant on by default");
s = await call("settings", { instant: false }); eq(s.settings.instant, false, "instant can be turned off");
hb = await call("heartbeat", { host: "mbp", listening: true }); eq(hb.instant, false, "mode reaches mac");
eq(JSON.parse(mem.get("device")).listening, true, "listening recorded");
hb = await call("heartbeat", { host: "mbp" }); eq([hb.interval, hb.holdMinutes], [240, 30], "settings reach mac");
console.log("ok");

// Push nudge: wake posts to that Mac's topic on the relay.
import http from "node:http";
const got = [];
const srv = http.createServer((req, res) => { got.push(req.url); res.end("ok"); }).listen(0);
await new Promise(r => srv.once("listening", r));
const push = `http://127.0.0.1:${srv.address().port}`;
await handle("wake", {}, m1.kv, Date.now(), { push, hashes: m1.hashes });
srv.close();
eq(got, ["/" + topicFor(sha(T1))], "wake pushed to that Mac's topic only");
console.log("push ok");
