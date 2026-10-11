// node test.mjs -- exercises lib/logic.js against an in-memory store, no server needed.
import { account, handle, iceServers, OFFER_TTL, register, topicFor } from "./lib/logic.js";
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

// Live screen signaling: the viewer writes the offer, the Mac writes the answer; nothing leaks across Macs.
const ID = "ab".repeat(16), ID2 = "cd".repeat(16), ICE = [{ urls: ["stun:example"] }];
const scr = (body, now = Date.now()) => handle("screen", body, m1.kv, now, { ice: ICE });
const noAt = o => o && Object.fromEntries(Object.entries(o).filter(([k]) => k !== "at"));
eq((await scr({})).body, { ice: ICE, push: null, offer: null, answer: null }, "nothing pending");
eq((await scr({ id: ID, offer: "v=0 offer" })).body, { ok: true, ice: ICE }, "viewer posts an offer and gets the ICE servers");
eq(noAt((await scr({})).body.offer), { id: ID, sdp: "v=0 offer" }, "Mac reads the offer");
eq((await scr({ id: ID, answer: "v=0 answer" })).body, { ok: true }, "Mac answers");
eq(noAt((await scr({})).body.answer), { id: ID, sdp: "v=0 answer" }, "viewer reads the answer");
eq((await scr({ id: ID2, error: "permission" })).status, 200, "Mac can refuse with a known code");
eq(noAt((await scr({})).body.answer), { id: ID2, error: "permission" }, "a refusal replaces the answer");
eq((await scr({}, Date.now() + OFFER_TTL + 1e3)).body.offer, null, "offers expire after 60 s");
eq((await handle("screen", {}, m2.kv, Date.now(), {})).body.offer, null, "another Mac never sees the offer");
for (const [body, why] of [
  [{ id: "xyz", offer: "v=0" }, "id must be hex"],
  [{ id: "ab", offer: "v=0" }, "id too short"],
  [{ offer: "v=0" }, "id missing"],
  [{ id: ID, offer: "" }, "empty offer"],
  [{ id: ID, offer: "x".repeat(20001) }, "offer over 20000 chars"],
  [{ id: ID, answer: 5 }, "answer must be text"],
  [{ id: ID, error: "boom" }, "unknown error code"],
  [{ id: ID, offer: "v=0", answer: "v=0" }, "offer and answer together"],
]) eq((await scr(body)).status, 400, why);
eq(iceServers({}), [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }], "free STUN only by default");
eq(iceServers({ TURN_URLS: "turn:relay:80, turns:relay:443", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" })[1],
  { urls: ["turn:relay:80", "turns:relay:443"], username: "u", credential: "p" }, "TURN from env");
console.log("ok");

// Push nudge: wake posts to that Mac's topic on the relay.
import http from "node:http";
const got = [];
const srv = http.createServer((req, res) => { got.push(req.url); res.end("ok"); }).listen(0);
await new Promise(r => srv.once("listening", r));
const push = `http://127.0.0.1:${srv.address().port}`;
await handle("wake", {}, m1.kv, Date.now(), { push, hashes: m1.hashes });
await handle("screen", { id: "ab".repeat(16), offer: "v=0" }, m1.kv, Date.now(), { push, hashes: m1.hashes });
srv.close();
eq(got, ["/" + topicFor(sha(T1)), "/" + topicFor(sha(T1)) + "-screen"], "wake pushes the daemon's topic, an offer the menu-bar app's");
console.log("push ok");

// Viewer decisions (mirrored in mobile/src/core.ts).
const { afterPoll, needsWake, newId, SCREEN_MESSAGES } = await import("./lib/screen.js");
eq(afterPoll(null, "a", 1000, "awake"), { kind: "wait" }, "no answer yet");
eq(afterPoll({ id: "b", sdp: "x", at: 0 }, "a", 1000, "awake"), { kind: "wait" }, "an answer to another offer is ignored");
eq(afterPoll({ id: "a", sdp: "x", at: 0 }, "a", 1000, "awake"), { kind: "answer", sdp: "x" }, "answer");
eq(afterPoll({ id: "a", error: "permission", at: 0 }, "a", 1000, "awake"), { kind: "error", error: "permission" }, "Mac refused");
eq(afterPoll({ id: "a", error: "weird", at: 0 }, "a", 1000, "awake"), { kind: "error", error: "failed" }, "unknown code reads as failed");
eq(afterPoll(null, "a", 20000, "requested"), { kind: "reoffer" }, "Mac still waking: offer again");
eq(afterPoll(null, "a", 20000, "awake"), { kind: "error", error: "timeout" }, "awake but silent");
eq(["idle", "done", "awake", "requested", undefined].map(needsWake), [true, true, false, false, true], "when watching also wakes");
eq(/^[0-9a-f]{32}$/.test(newId()) && newId() !== newId(), true, "offer ids are 32 hex and differ");
eq(Object.keys(SCREEN_MESSAGES).sort(), ["disabled", "failed", "ice", "lost", "no-display", "permission", "timeout"], "every error has text");
console.log("viewer ok");

// Remote control (mirrored in mobile/src/control.ts).
const C = await import("./lib/control.js");
eq(C.fraction(200, 50, { w: 400, h: 100 }, [200, 100]), { at: [0.5, 0.5], inside: true }, "letterboxed center");
eq(C.fraction(10, 50, { w: 400, h: 100 }, [200, 100]), { at: [0, 0.5], inside: false }, "a click in the side bar is outside, clamped to the edge");

const view = () => ({ box: { w: 200, h: 100 }, size: [200, 100] });
let g = C.createGestures("direct", view);
eq(g.down(1, 50, 50, 0), [], "a touch waits to see what it becomes");
eq(g.down(1, 50, 50, 5), [], "duplicate down is ignored");
eq(g.up(1, 100), [{ m: [0.25, 0.5] }, { b: 0, d: 1 }, { b: 0, d: 0 }], "direct tap clicks there");
eq(g.up(1, 110), [], "unknown up is ignored");
g.down(1, 50, 50, 0);
eq(g.move(1, 55, 50, 10), [], "within slop");
eq(g.move(1, 50, 30, 20), [{ m: [0.25, 0.5] }, { s: [0, 20] }], "dragging up scrolls down, from where the finger started");
eq(g.move(1, 50, 20, 30), [{ s: [0, 10] }], "and keeps scrolling");
eq(g.up(1, 40), [], "no click after a scroll");
g.down(1, 50, 50, 0);
eq(g.tick(400), false, "not yet a long press");
eq(g.tick(500), true, "long press");
eq(g.state, "held", "held");
eq(g.up(1, 600), [{ m: [0.25, 0.5] }, { b: 1, d: 1 }, { b: 1, d: 0 }], "long press, release: right click there");
g.down(1, 50, 50, 0); g.tick(500);
eq(g.move(1, 80, 50, 600), [{ m: [0.25, 0.5] }, { b: 0, d: 1 }, { m: [0.4, 0.5] }], "long press, then drag: holds the button");
eq(g.move(1, 90, 60, 610), [{ m: [0.45, 0.6] }], "drag follows the finger");
eq(g.up(1, 700), [{ b: 0, d: 0 }], "drop");
g.down(1, 50, 50, 0);
eq(g.down(2, 80, 50, 10), [], "second finger in direct mode belongs to zoom");
eq(g.up(1, 50), [], "so no click");
eq(g.up(2, 60), [], "nothing at all");
eq(g.state, "idle", "back to idle");
g.down(1, 50, 50, 0); g.tick(500); g.move(1, 80, 50, 600);
eq(g.down(2, 120, 50, 650), [{ b: 0, d: 0 }], "second finger during a drag lets go of the button");
g.up(1, 700); g.up(2, 710);
g.down(1, 50, 50, 0); g.tick(500); g.move(1, 80, 50, 600);
eq(g.cancel(), [{ b: 0, d: 0 }], "cancel lets go of a held button");
eq(g.state, "idle", "and resets");
g = C.createGestures("direct", () => ({ box: { w: 400, h: 200 }, size: [200, 100] }));
g.down(1, 100, 100, 0);
eq(g.move(1, 100, 80, 10), [{ m: [0.25, 0.5] }, { s: [0, 10] }], "scroll is in Mac points, not screen pixels");

g = C.createGestures("trackpad", view);
g.down(1, 50, 50, 0);
eq(g.up(1, 100), [{ b: 0, d: 1 }, { b: 0, d: 0 }], "trackpad tap clicks at the pointer");
g.down(1, 50, 50, 0);
eq(g.move(1, 70, 50, 100), [{ r: [0.15, 0] }], "slow drag moves the pointer 1.5x");
eq(g.move(1, 110, 50, 110), [{ r: [0.6, 0] }], "fast drag moves it 3x");
eq(g.up(1, 120), [], "no click after moving");
g.down(1, 50, 50, 0); g.tick(500);
eq(g.up(1, 600), [{ b: 1, d: 1 }, { b: 1, d: 0 }], "trackpad long press right clicks at the pointer");
g.down(1, 50, 50, 0); g.tick(500);
eq(g.move(1, 70, 50, 1600), [{ b: 0, d: 1 }, { r: [0.15, 0] }], "long press then drag holds the button");
eq(g.up(1, 1700), [{ b: 0, d: 0 }], "drop");
g.down(1, 50, 50, 0);
eq(g.down(2, 90, 50, 50), [], "two fingers");
eq(g.up(1, 200), [{ b: 1, d: 1 }, { b: 1, d: 0 }], "two-finger tap right clicks");
eq(g.up(2, 210), [], "the other finger lifts quietly");
g.down(1, 50, 50, 0); g.down(2, 90, 50, 10);
eq(g.move(1, 50, 30, 50), [{ s: [0, 10] }], "two-finger drag scrolls by the midpoint");
eq(g.move(2, 90, 30, 60), [{ s: [0, 10] }], "both fingers");
eq(g.up(1, 400), [], "no right click after scrolling");
g.up(2, 410);
eq(g.state, "idle", "all fingers up");

eq(C.wheel(0, 3, 1, 800), { s: [0, 48] }, "line scrolling");
eq(C.wheel(0, 1, 2, 800), { s: [0, 800] }, "page scrolling");
eq(C.wheel(2.5, -7, 0, 800), { s: [2.5, -7] }, "pixels pass through");
eq([0, 1, 2, 3].map(C.mouseButton), [0, null, 1, null], "left and right buttons only");
eq(["c", "C", "7", "&", " ", "\n", "/", "é"].map(C.charToCode), [
  { code: "KeyC", shift: false }, { code: "KeyC", shift: true }, { code: "Digit7", shift: false }, { code: "Digit7", shift: true },
  { code: "Space", shift: false }, { code: "Enter", shift: false }, { code: "Slash", shift: false }, null,
], "US layout keys");

const keys = C.createKeys();
eq(keys.type("hi"), [{ t: "hi" }], "plain typing is text");
keys.toggle("meta");
eq(keys.latched(), ["meta"], "latched");
eq(keys.type("c"), [{ k: "MetaLeft", d: 1 }, { k: "KeyC", d: 1 }, { k: "KeyC", d: 0 }, { k: "MetaLeft", d: 0 }], "⌘ then c is ⌘C");
eq(keys.latched(), [], "a latch is used once");
keys.toggle("meta"); keys.toggle("shift");
eq(keys.press("ArrowLeft"), [
  { k: "MetaLeft", d: 1 }, { k: "ShiftLeft", d: 1 }, { k: "ArrowLeft", d: 1 }, { k: "ArrowLeft", d: 0 }, { k: "ShiftLeft", d: 0 }, { k: "MetaLeft", d: 0 },
], "⌘⇧← from the keys row");
keys.toggle("ctrl"); keys.toggle("ctrl");
eq(keys.latched(), [], "a second tap unlatches");
keys.toggle("meta");
eq(keys.type("ab"), [{ k: "MetaLeft", d: 1 }, { k: "KeyA", d: 1 }, { k: "KeyA", d: 0 }, { k: "MetaLeft", d: 0 }, { t: "b" }], "only the first character gets the latch");
keys.toggle("alt");
eq(keys.type("éx"), [{ t: "éx" }], "a character with no key types as text and drops the latch");
eq(keys.latched(), [], "dropped");
eq(C.KEYS_ROW.map(k => k.label).join(" "), "esc tab ⌘ ⌥ ⌃ ⇧ ← ↑ ↓ →", "keys row");

eq(C.edit(""), { backspace: true }, "the space was deleted: Backspace");
eq(C.edit(" a"), { text: "a" }, "typed after the space");
eq(C.edit("a "), { text: "a" }, "typed before it");
eq(C.edit("  "), { text: " " }, "typed a space");
eq(C.edit(" "), { text: "" }, "nothing changed");

const held = C.createHeld();
eq(held.key("MetaLeft", true), [{ k: "MetaLeft", d: 1 }], "⌘ down");
held.key("KeyC", true);
eq(held.key("MetaLeft", false), [{ k: "MetaLeft", d: 0 }, { k: "KeyC", d: 0 }], "letting go of ⌘ releases keys whose keyup the browser swallowed");
held.key("KeyA", true);
eq(held.releaseAll(), [{ k: "KeyA", d: 0 }], "blur releases everything still held");
eq(held.key("", true), [], "keys without a code are ignored");

const sent = [], later = [];
const send = C.createSender(m => sent.push(m), f => later.push(f));
send([{ m: [0.1, 0.1] }, { m: [0.2, 0.2] }, { r: [0.1, 0] }, { r: [0.1, 0.1] }]);
eq(sent, [{ m: [0.2, 0.2] }], "moves collapse to the last one; another kind flushes it");
send([{ b: 0, d: 1 }]);
eq(sent, [{ m: [0.2, 0.2] }, { r: [0.2, 0.1] }, { b: 0, d: 1 }], "a click flushes pending movement first, in order");
later.forEach(f => f());
eq(sent.length, 3, "the frame flush finds nothing left");
eq(later.length, 1, "one frame was asked for");

eq(Object.keys(C.CONTROL_MESSAGES).sort(), ["off", "permission"], "every control status has text");
console.log("control ok");
