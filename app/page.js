"use client";
import { useEffect, useRef, useState } from "react";

const TOKEN_KEY = "tok";
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
  set: v => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
};

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60e3);
  if (Math.abs(ms) < 60e3) return `${Math.max(1, Math.round(Math.abs(ms) / 1e3))} s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
}
const clock = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function Page() {
  const [token, setToken] = useState(null);           // null until localStorage is read
  const [s, setS] = useState(null);
  const [skew, setSkew] = useState(0);                // server clock minus ours
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const [, tick] = useState(0);
  const tokenRef = useRef("");

  useEffect(() => {
    // The Mac app's "Open console" and QR code pass the token in the URL fragment (never sent to the server).
    const m = location.hash.match(/token=([^&]+)/);
    if (m) { store.set(decodeURIComponent(m[1])); history.replaceState(null, "", location.pathname); }
    setToken(store.get());
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    const t = setInterval(() => tick(n => n + 1), 5e3);
    return () => clearInterval(t);
  }, []);
  tokenRef.current = token || "";

  async function call(action, body) {
    let r;
    try {
      r = await fetch(`/api/${action}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${tokenRef.current}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    } catch { setErr("Can't reach the console. Check your connection."); return; }
    if (r.status === 401) { store.set(""); setToken(""); setS(null); setErr("That token isn't valid for this console."); return; }
    if (!r.ok) { setErr(`The console returned an error (${r.status}). Try again.`); return; }
    const next = await r.json();
    setSkew(next.now - Date.now()); setS(next); setErr("");
    setForm(f => f || { interval: String(next.settings.interval), hold: String(next.settings.hold) });
  }
  async function act(action, body) { setBusy(true); await call(action, body); setBusy(false); }

  useEffect(() => {
    if (!token) return;
    call("state");
    const t = setInterval(() => document.visibilityState === "visible" && call("state"), 8e3);
    const onShow = () => document.visibilityState === "visible" && call("state");
    document.addEventListener("visibilitychange", onShow);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onShow); };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (token === null) return null;
  if (!token) return <SignIn err={err} onSubmit={v => { store.set(v); setErr(""); setToken(v); }} />;

  const now = Date.now() + skew;
  const d = s?.device || {}, st = s?.settings || { interval: 5, hold: 30 };
  const seen = d.lastSeen ? now - d.lastSeen : Infinity;
  const every = (d.ac === false ? Math.max(st.interval, 10) : st.interval) * 60e3;   // the Mac backs off to 10 min on battery
  const nextIn = d.lastSeen ? d.lastSeen + every - now : null;
  const asleep = seen > Math.max(every * 1.5, 5.5 * 60e3);   // an awake Mac only refreshes lastSeen every 5 min
  const ph = !s ? "loading" : !d.lastSeen ? "never" : s.phase === "idle" ? (asleep ? "asleep" : "idle") : s.phase;
  const holdEnds = (d.ackAt || 0) + st.hold * 60e3;
  const name = (d.host || "Your Mac").replace(/\.local$/, "");

  const view = {
    loading: { led: "off", title: "Checking…", line: "" },
    never: { led: "off", title: "Not paired.", line: "Open MacWake on your Mac to connect it to this console." },
    asleep: { led: "sleep", title: "Asleep.", line: `${name} is resting and checks in every ${span(every)}.` },
    idle: { led: "awake", title: "Awake.", line: `${name} is on and checking in.` },
    requested: { led: "pending", title: "Waking up…", line: !asleep ? "Your Mac is already on and will pick this up within a minute." : nextIn > 0 ? `Your Mac will see the request at its next check-in, in about ${span(nextIn)}.` : "Your Mac should check in any moment now." },
    awake: { led: "awake", title: "Awake.", line: d.lid
      ? `Staying awake until ${clock(holdEnds)} with the lid closed, so the screen stays off. Screen Sharing and SSH work.`
      : `Staying awake until ${clock(holdEnds)}. Screen Sharing and SSH should work now.` },
    done: { led: "sleep", title: "Back asleep.", line: "The awake time ended. Wake it again if you need more time." },
  }[ph];

  const primary = ph === "awake" ? { label: "Let it sleep", action: "cancel", quiet: true }
    : ph === "requested" ? { label: "Waiting for your Mac…", disabled: true }
    : { label: ph === "done" ? "Wake it again" : "Wake up Mac", action: "wake", disabled: ph === "never" || ph === "loading" };

  return (
    <main className="shell">
      <header className="top">
        <span className="brand">MacWake</span>
        <button className="link" onClick={() => { store.set(""); setToken(""); setS(null); }}>Sign out</button>
      </header>

      <section className="hero" aria-live="polite">
        <div className={`led led-${view.led}`} aria-hidden="true"><span /></div>
        <h1>{view.title}</h1>
        <p className="line">{view.line}</p>
      </section>

      {d.lastSeen ? (
        <dl className="facts">
          <div><dt>Last check-in</dt><dd>{span(seen)} ago</dd></div>
          {asleep && ph !== "awake" && nextIn != null && <div><dt>Next check-in</dt><dd>{nextIn > 0 ? `in ${span(nextIn)}` : "any moment"}</dd></div>}
          <div><dt>Lid</dt><dd>{d.lid ? "Closed" : "Open"}</dd></div>
          <div><dt>Power</dt><dd>{d.ac ? "On charger" : "On battery"}{d.battery != null && <span className="soft">, {d.battery}%</span>}</dd></div>
          {d.host && <div><dt>Mac</dt><dd className="host">{name}</dd></div>}
        </dl>
      ) : null}

      {d.lastSeen && d.ac === false && (
        <p className="note">Your Mac is on battery, so it checks in every 10 minutes at most. Plug it in for faster wakes.</p>
      )}

      <details className="timing">
        <summary>Timing</summary>
        {form && (
          <form onSubmit={e => { e.preventDefault(); act("settings", { interval: +form.interval, hold: +form.hold }); }}>
            <label>
              <span>Check in every</span>
              <span className="field"><input inputMode="numeric" type="number" min={1} max={240} value={form.interval} onChange={e => setForm({ ...form, interval: e.target.value })} />min</span>
            </label>
            <p className="help">This is the longest you wait after tapping wake. Shorter uses a little more battery.</p>
            <label>
              <span>Stay awake for</span>
              <span className="field"><input inputMode="numeric" type="number" min={1} max={1440} value={form.hold} onChange={e => setForm({ ...form, hold: e.target.value })} />min</span>
            </label>
            <button className="save" disabled={busy}>Save timing</button>
          </form>
        )}
      </details>

      {err && <p className="err" role="alert">{err}</p>}

      <footer className="dock">
        {ph === "requested" && <button className="link center" disabled={busy} onClick={() => act("cancel")}>Cancel request</button>}
        <button className={`primary${primary.quiet ? " quiet" : ""}`} disabled={busy || primary.disabled} onClick={() => primary.action && act(primary.action)}>
          {primary.label}
        </button>
      </footer>
    </main>
  );
}

function SignIn({ err, onSubmit }) {
  return (
    <main className="shell signin">
      <section className="hero">
        <div className="led led-sleep" aria-hidden="true"><span /></div>
        <h1>MacWake</h1>
        <p className="line">Paste the token from the MacWake menu on your Mac, or scan its pairing code with your phone camera.</p>
      </section>
      <form onSubmit={e => { e.preventDefault(); const v = e.currentTarget.tok.value.trim(); if (v) onSubmit(v); }}>
        <label className="stack">
          <span>Token</span>
          <input name="tok" type="password" autoComplete="current-password" autoCapitalize="off" spellCheck={false} placeholder="48 letters and numbers" />
        </label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="primary">Sign in</button>
      </form>
    </main>
  );
}
