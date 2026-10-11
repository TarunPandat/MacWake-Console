// Viewer-side remote control: turns mouse, touches and keys into the messages the Mac injects. Wire format:
// docs/superpowers/specs/2026-10-11-remote-control-design.md. Pure (no DOM), so `npm test` runs it under Node.
// Mirrored in mobile/src/control.ts: keep behavior and text identical.

export const CONTROL_MESSAGES = {
  off: "Remote control is turned off on the Mac.",
  permission: "To control the Mac, allow MacWake under System Settings → Privacy & Security → Accessibility on the Mac.",
};

export const SLOP = 10;          // px a finger may wander and still count as a tap
export const LONG_PRESS = 500;   // ms
export const TWO_TAP = 300;      // ms, two-finger tap (trackpad right click)
const DOUBLE_TAP = 500;          // ms: a tap this soon after the last, within SLOP, reuses its spot (a zoomed-out
                                 // phone picture turns a 2 px wobble into more than the Mac's 4 pt double-click radius)
const GAIN = 1.5, FAST = 0.8;    // trackpad: pointer moves 1.5x the finger, twice that above 0.8 px/ms

const clamp = v => Math.min(1, Math.max(0, v));
const r4 = v => Math.round(v * 1e4) / 1e4;
const r1 = v => Math.round(v * 10) / 10;

/** Element px -> screen fractions for a picture drawn with object-fit: contain. `inside` is false in the bars. */
export function fraction(x, y, box, size) {
  const k = Math.min(box.w / size[0], box.h / size[1]);
  const fx = (x - (box.w - size[0] * k) / 2) / (size[0] * k);
  const fy = (y - (box.h - size[1] * k) / 2) / (size[1] * k);
  return { at: [r4(clamp(fx)), r4(clamp(fy))], inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
}

/**
 * Touch gestures -> messages. `mode` is "direct" (tap where you want to click) or "trackpad" (the finger moves the
 * pointer). `view()` returns { box: {w, h} element px, size: [w, h] Mac points }. down/move/up/cancel return the
 * messages to send; tick(t), called LONG_PRESS ms after a touch starts, returns true when it became a long press.
 */
export function createGestures(mode, view) {
  const direct = mode === "direct";
  const touches = new Map();   // id -> { x0, y0, x, y }
  let state = "idle", since = 0, twoAt = 0, prev = { x: 0, y: 0 }, prevT = 0, lastTap = null;
  const scale = () => { const { box, size } = view(); return Math.min(box.w / size[0], box.h / size[1]); };
  const point = (x, y) => { const { box, size } = view(); return { m: fraction(x, y, box, size).at }; };
  const scroll = (dx, dy) => { const k = scale(); return { s: [r1(-dx / k), r1(-dy / k)] }; };   // content follows the finger
  const nudge = (dx, dy, dt) => {
    const k = scale(), { size } = view();
    const g = GAIN * (Math.hypot(dx, dy) / Math.max(dt, 1) > FAST ? 2 : 1);
    return { r: [r4((dx * g) / (size[0] * k)), r4((dy * g) / (size[1] * k))] };
  };
  const far = p => Math.hypot(p.x - p.x0, p.y - p.y0) > SLOP;
  const centroid = () => {
    let x = 0, y = 0;
    for (const p of touches.values()) { x += p.x; y += p.y; }
    return { x: x / touches.size, y: y / touches.size };
  };
  const click = (b, p) => [...(direct ? [point(p.x0, p.y0)] : []), { b, d: 1 }, { b, d: 0 }];
  const letGo = () => (state === "drag" ? [{ b: 0, d: 0 }] : []);
  const tap = (p, t) => {
    if (direct && lastTap && since - lastTap.t <= DOUBLE_TAP && Math.hypot(p.x0 - lastTap.x, p.y0 - lastTap.y) <= SLOP) {
      p.x0 = lastTap.x; p.y0 = lastTap.y;
    }
    lastTap = { x: p.x0, y: p.y0, t };
    return click(0, p);
  };
  const outside = (x, y) => { const { box, size } = view(); return !fraction(x, y, box, size).inside; };

  return {
    get state() { return state; },
    down(id, x, y, t) {
      if (touches.has(id)) return [];
      touches.set(id, { x0: x, y0: y, x, y });
      if (touches.size === 1) {
        state = direct && outside(x, y) ? "ignore" : "pending";   // a direct touch in the black bars does nothing
        since = prevT = t; prev = { x, y };
        return [];
      }
      if (!direct && touches.size === 2 && (state === "pending" || state === "move")) {
        for (const p of touches.values()) { p.x0 = p.x; p.y0 = p.y; }
        state = "two"; twoAt = t; prev = centroid();
        return [];
      }
      const out = letGo();   // more fingers than the gesture uses (direct: the iOS zoom pinch): wait until all lift
      state = "ignore";
      return out;
    },
    move(id, x, y, t) {
      const p = touches.get(id);
      if (!p) return [];
      p.x = x; p.y = y;
      const dt = t - prevT;
      let out;
      switch (state) {
        case "pending":
          if (!far(p)) return [];
          if (direct) { state = "scroll"; out = [point(p.x0, p.y0), scroll(x - p.x0, y - p.y0)]; }
          else { state = "move"; out = [nudge(x - p.x0, y - p.y0, dt)]; }
          break;
        case "scroll": out = [scroll(x - prev.x, y - prev.y)]; break;
        case "move": out = [nudge(x - prev.x, y - prev.y, dt)]; break;
        case "held":
          if (!far(p)) return [];
          state = "drag";
          out = direct ? [point(p.x0, p.y0), { b: 0, d: 1 }, point(x, y)] : [{ b: 0, d: 1 }, nudge(x - p.x0, y - p.y0, dt)];
          break;
        case "drag": out = [direct ? point(x, y) : nudge(x - prev.x, y - prev.y, dt)]; break;
        case "two":
          if (![...touches.values()].some(far)) return [];
          state = "twoScroll";
        // falls through
        case "twoScroll": {
          const c = centroid();
          out = [scroll(c.x - prev.x, c.y - prev.y)];
          prev = c; prevT = t;
          return out;
        }
        default: return [];
      }
      prev = { x, y }; prevT = t;
      return out;
    },
    up(id, t) {
      const p = touches.get(id);
      if (!p) return [];
      touches.delete(id);
      const out = state === "pending" ? tap(p, t)
        : state === "held" ? click(1, p)
        : state === "two" && t - twoAt < TWO_TAP ? click(1, p)
        : letGo();
      state = touches.size ? "ignore" : "idle";
      return out;
    },
    tick(t) {
      if (state !== "pending" || t - since < LONG_PRESS) return false;
      state = "held";
      return true;
    },
    cancel() {
      const out = letGo();
      touches.clear(); state = "idle";
      return out;
    },
  };
}

/** WheelEvent deltas -> scroll message in points (line mode: 16 a line, page mode: one screen). */
export function wheel(dx, dy, deltaMode, page) {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? page : 1;
  return { s: [r1(dx * k), r1(dy * k)] };
}

/** Browser mouse button -> wire button (0 left, 1 right); others are ignored. */
export const mouseButton = b => (b === 0 ? 0 : b === 2 ? 1 : null);

const PLAIN = { "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon",
  "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote", " ": "Space", "\n": "Enter", "\t": "Tab" };
const SHIFTED = { "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5", "^": "Digit6", "&": "Digit7",
  "*": "Digit8", "(": "Digit9", ")": "Digit0", "_": "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight",
  "|": "Backslash", ":": "Semicolon", "\"": "Quote", "<": "Comma", ">": "Period", "?": "Slash", "~": "Backquote" };

/** A typed character -> the US-layout key that makes it, or null. Used only while a modifier is latched. */
export function charToCode(ch) {
  if (/^[a-z]$/.test(ch)) return { code: "Key" + ch.toUpperCase(), shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: "Key" + ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { code: "Digit" + ch, shift: false };
  if (ch in PLAIN) return { code: PLAIN[ch], shift: false };
  if (ch in SHIFTED) return { code: SHIFTED[ch], shift: true };
  return null;
}

const MODIFIERS = { meta: "MetaLeft", alt: "AltLeft", ctrl: "ControlLeft", shift: "ShiftLeft" };

/** The Mac keys row, in order. `mod` keys latch (sticky); the others are pressed once. */
export const KEYS_ROW = [
  { label: "esc", say: "Escape", key: "Escape" },
  { label: "tab", say: "Tab", key: "Tab" },
  { label: "⌘", say: "Command", mod: "meta" },
  { label: "⌥", say: "Option", mod: "alt" },
  { label: "⌃", say: "Control", mod: "ctrl" },
  { label: "⇧", say: "Shift", mod: "shift" },
  { label: "←", say: "Left arrow", key: "ArrowLeft" },
  { label: "↑", say: "Up arrow", key: "ArrowUp" },
  { label: "↓", say: "Down arrow", key: "ArrowDown" },
  { label: "→", say: "Right arrow", key: "ArrowRight" },
];

/**
 * Sticky ⌘ ⌥ ⌃ ⇧ from the keys row. A tap latches a modifier; it is held around the next key or typed character,
 * then released. A second tap unlatches it.
 */
export function createKeys() {
  const latched = new Set();
  const press = (code, shift = false) => {
    const mods = [...latched].map(n => MODIFIERS[n]);
    if (shift && !latched.has("shift")) mods.push(MODIFIERS.shift);
    latched.clear();
    return [...mods.map(k => ({ k, d: 1 })), { k: code, d: 1 }, { k: code, d: 0 }, ...[...mods].reverse().map(k => ({ k, d: 0 }))];
  };
  const type = text => {
    if (!text) return [];
    const [ch] = text;
    const c = latched.size ? charToCode(ch) : null;
    if (!c) { latched.clear(); return [{ t: text }]; }
    const rest = text.slice(ch.length);
    return [...press(c.code, c.shift), ...(rest ? [{ t: rest }] : [])];
  };
  return {
    latched: () => [...latched],
    toggle: mod => { if (latched.has(mod)) latched.delete(mod); else latched.add(mod); },
    press,
    type,
  };
}

/** The phone keyboard's hidden input always holds this, so Backspace shows up as a deleted space. */
export const SENTINEL = " ";

/** What the phone keyboard did to the hidden input's value. */
export const edit = next => (next === "" ? { backspace: true } : { text: next.replace(SENTINEL, "") });

const MODIFIER_CODES = new Set(["MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "ControlLeft", "ControlRight", "CapsLock"]);

/**
 * Physical keys from a real keyboard. Tracks what is held so nothing stays stuck on the Mac: macOS browsers send no
 * keyup for keys released while ⌘ is down, so letting go of ⌘ releases them too.
 */
export function createHeld() {
  const held = new Set();
  return {
    key(code, down) {
      if (!code) return [];
      if (down) { held.add(code); return [{ k: code, d: 1 }]; }
      held.delete(code);
      const out = [{ k: code, d: 0 }];
      if (code === "MetaLeft" || code === "MetaRight")
        for (const k of [...held]) if (!MODIFIER_CODES.has(k)) { held.delete(k); out.push({ k, d: 0 }); }
      return out;
    },
    releaseAll() {
      const out = [...held].map(k => ({ k, d: 0 }));
      held.clear();
      return out;
    },
  };
}

/**
 * Sends at most one pointer message per frame: the last `m`, summed `r` and `s`. Anything else goes out at once,
 * after whatever movement is pending, so order is kept. `schedule(fn)` runs fn on the next frame.
 */
export function createSender(send, schedule) {
  let pending = null, queued = false;
  const flush = () => { if (pending) send(pending); pending = null; };
  return msgs => {
    for (const msg of msgs) {
      const kind = ["m", "r", "s"].find(k => k in msg);
      if (kind && pending && kind in pending)
        pending = kind === "m" ? msg : { [kind]: [pending[kind][0] + msg[kind][0], pending[kind][1] + msg[kind][1]] };
      else { flush(); if (kind) pending = msg; else send(msg); }
    }
    if (pending && !queued) { queued = true; schedule(() => { queued = false; flush(); }); }
  };
}
