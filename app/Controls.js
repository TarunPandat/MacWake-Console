"use client";
// Remote control glue for the viewer: the real mouse and keyboard, touches on the picture, the phone keyboard and
// the Mac keys row. Decisions live in lib/control.js; mirrored in mobile/src/Controls.tsx.
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { createGestures, createHeld, createKeys, edit, fraction, KEYS_ROW, LONG_PRESS, mouseButton, SENTINEL, wheel } from "../lib/control.js";

/** Pointer handlers for the picture. The mouse goes straight through; touches and pens go through the gestures. */
export function usePicture(mode, size, send, enabled) {
  const ref = useRef(null);
  const [ring, setRing] = useState(null);
  const latest = useRef({ size, send, enabled });
  latest.current = { size, send, enabled };
  const box = useRef({ w: 1, h: 1 });
  const timer = useRef();
  const g = useMemo(() => createGestures(mode, () => ({ box: box.current, size: latest.current.size })), [mode]);

  useEffect(() => {   // non-passive, so scrolling the Mac doesn't scroll the page
    const el = ref.current;
    if (!el) return;
    const onWheel = e => {
      if (!latest.current.enabled) return;
      e.preventDefault();
      latest.current.send([wheel(e.deltaX, e.deltaY, e.deltaMode, latest.current.size[1])]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const at = e => {
    const r = e.currentTarget.getBoundingClientRect();
    box.current = { w: r.width, h: r.height };
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const handlers = {
    onPointerDown: e => {
      const { enabled, send, size } = latest.current;
      if (!enabled) return;
      const [x, y] = at(e);
      if (e.pointerType === "mouse") {
        const b = mouseButton(e.button), f = fraction(x, y, box.current, size);
        if (b === null || !f.inside) return;   // a click in the black bars does nothing
        e.currentTarget.setPointerCapture(e.pointerId);
        send([{ m: f.at }, { b, d: 1 }]);
        return;
      }
      send(g.down(e.pointerId, x, y, performance.now()));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (g.tick(performance.now())) { setRing({ x, y }); navigator.vibrate?.(10); }
      }, LONG_PRESS + 20);
    },
    onPointerMove: e => {
      const { enabled, send, size } = latest.current;
      if (!enabled) return;
      const [x, y] = at(e);
      send(e.pointerType === "mouse" ? [{ m: fraction(x, y, box.current, size).at }] : g.move(e.pointerId, x, y, performance.now()));
    },
    onPointerUp: e => {
      const { enabled, send, size } = latest.current;
      if (!enabled) return;
      const [x, y] = at(e);
      if (e.pointerType === "mouse") {
        const b = mouseButton(e.button);
        if (b !== null) send([{ m: fraction(x, y, box.current, size).at }, { b, d: 0 }]);
        return;
      }
      send(g.up(e.pointerId, performance.now()));
      if (g.state === "idle") { clearTimeout(timer.current); setRing(null); }
    },
    onPointerCancel: e => {
      if (e.pointerType === "mouse") return;
      clearTimeout(timer.current);
      setRing(null);
      latest.current.send(g.cancel());
    },
    onContextMenu: e => { if (latest.current.enabled) e.preventDefault(); },
  };
  return { ref, handlers, ring };
}

/** Sticky ⌘ ⌥ ⌃ ⇧ from the keys row plus typed text; `latched` drives the row's highlight. */
export function useKeys(send) {
  const keys = useMemo(createKeys, []);
  const [latched, setLatched] = useState([]);
  const after = out => { send(out); setLatched(keys.latched()); };
  return {
    latched,
    press: code => after(keys.press(code)),
    type: text => after(keys.type(text)),
    toggle: mod => { keys.toggle(mod); setLatched(keys.latched()); },
  };
}

/**
 * The computer's own keyboard -> Mac keys while `enabled`. Skips the phone-keyboard input and key presses on the
 * viewer's buttons (so they work by keyboard); Shift+Escape calls `onEscape` instead of reaching the Mac, so keyboard
 * users can always get back to Close.
 */
export function useKeyboard(enabled, send, skip, onEscape) {
  const latest = useRef({ send, onEscape });
  latest.current = { send, onEscape };
  useEffect(() => {
    if (!enabled) return;
    const held = createHeld();
    const key = e => {
      const down = e.type === "keydown";
      if (e.target === skip.current) return;
      if (down && e.target.closest?.(".viewer-bar")) return;
      if (down && e.key === "Escape" && e.shiftKey) { e.preventDefault(); latest.current.onEscape(); return; }
      e.preventDefault();
      latest.current.send(held.key(e.code, down));
    };
    const blur = () => latest.current.send(held.releaseAll());
    addEventListener("keydown", key);
    addEventListener("keyup", key);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("keyup", key);
      removeEventListener("blur", blur);
      blur();
    };
  }, [enabled, skip]);
}

/** How far the on-screen keyboard covers the page bottom (0 when closed), so the keys row sits above it. */
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);
  return inset;
}

/** Hidden input for the phone keyboard. It always holds one space, so Backspace shows up as a deleted space. */
export const Typing = forwardRef(function Typing({ keys, onBlur }, ref) {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const el = ref.current;
    const take = () => {
      const r = edit(el.value);
      el.value = SENTINEL;
      el.setSelectionRange(1, 1);
      if (r.backspace) latest.current.press("Backspace");
      else if (r.text) latest.current.type(r.text);
    };
    const onInput = e => { if (!e.isComposing) take(); };
    const onKey = e => { if (e.key === "Enter") { e.preventDefault(); latest.current.press("Enter"); } };
    el.addEventListener("input", onInput);
    el.addEventListener("compositionend", take);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionend", take);
      el.removeEventListener("keydown", onKey);
    };
  }, [ref]);
  return (
    <input ref={ref} className="viewer-input" defaultValue={SENTINEL} autoCapitalize="off" autoCorrect="off" autoComplete="off"
      spellCheck={false} enterKeyHint="enter" aria-label="Type on the Mac" onBlur={onBlur} />
  );
});

/** esc, tab, sticky ⌘ ⌥ ⌃ ⇧ and arrows, for what the phone keyboard lacks. */
export function KeysRow({ keys, bottom }) {
  const keep = e => e.preventDefault();   // don't take focus from the phone keyboard
  return (
    <div className="viewer-keys" style={bottom ? { bottom } : undefined} role="toolbar" aria-label="Mac keys">
      {KEYS_ROW.map(k => {
        const on = !!k.mod && keys.latched.includes(k.mod);
        return (
          <button key={k.label} className={on ? "on" : undefined} aria-label={k.say} aria-pressed={k.mod ? on : undefined}
            onPointerDown={keep} onMouseDown={keep} onClick={() => (k.mod ? keys.toggle(k.mod) : keys.press(k.key))}>
            {k.label}
          </button>
        );
      })}
    </div>
  );
}
