"use client";
// Full-screen live view of the Mac over WebRTC, with mouse and keyboard control once the Mac allows it.
// Decisions live in lib/screen.js and lib/control.js (mirrored in mobile/src/core.ts and control.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { afterPoll, ANSWER_WAIT, needsWake, newId, SCREEN_MESSAGES } from "../lib/screen.js";
import { CONTROL_MESSAGES, createSender } from "../lib/control.js";
import { KeysRow, Typing, useKeyboard, useKeyboardInset, useKeys, usePicture } from "./Controls";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Non-trickle signaling: wait until every ICE candidate is in the SDP, at most 3 s. */
function gathered(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 3000);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
  });
}

export default function Viewer({ token, onClose }) {
  const video = useRef(null);
  const dc = useRef(null);
  const input = useRef(null);
  const close = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [live, setLive] = useState(false);
  const [control, setControl] = useState(null);   // "ok" | "off" | "permission" from the Mac; null: a view-only Mac app
  const [size, setSize] = useState([16, 10]);     // the Mac's screen in points, for the picture's shape
  const [mode, setMode] = useState("direct");
  const [typing, setTyping] = useState(false);
  const [attempt, setAttempt] = useState(0);   // Try again re-runs the effect
  const touch = useMemo(() => matchMedia("(pointer: coarse)").matches, []);

  useEffect(() => {
    let closed = false, wasLive = false, pc = null, lost;
    const api = async (action, body) => {
      const r = await fetch(`/api/${action}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `The console returned an error (${r.status}). Try again.`);
      return j;
    };
    const fail = key => { if (!closed) { setError(SCREEN_MESSAGES[key] || key); setLive(false); } };
    (async () => {
      try {
        setError(""); setLive(false); setLocked(false); setControl(null); setStatus("Connecting…");
        let ph = (await api("state")).phase;
        if (needsWake(ph)) { await api("wake", {}); ph = "requested"; }
        const { ice } = await api("screen");
        while (!closed) {
          pc?.close();
          const conn = pc = new RTCPeerConnection({ iceServers: ice });
          conn.addTransceiver("video", { direction: "recvonly" });
          const ch = dc.current = conn.createDataChannel("control");
          ch.onmessage = e => {
            try {
              const d = JSON.parse(e.data);
              if ("locked" in d) setLocked(!!d.locked);
              if ("control" in d) { setControl(d.control); if (Array.isArray(d.size)) setSize(d.size); }
            } catch { /* not ours */ }
          };
          conn.ontrack = e => { if (video.current) video.current.srcObject = e.streams[0] || new MediaStream([e.track]); };
          conn.onconnectionstatechange = () => {
            const s = conn.connectionState;
            if (s === "connected") { clearTimeout(lost); wasLive = true; setLive(true); setStatus(""); }
            else if (s === "failed") fail(wasLive ? "lost" : "ice");
            else if (s === "disconnected") lost = setTimeout(() => fail("lost"), 10e3);
          };
          await conn.setLocalDescription(await conn.createOffer());
          await gathered(conn);
          const id = newId();
          setStatus(ph === "requested" ? "Waking your Mac…" : "Connecting…");
          await api("screen", { id, offer: conn.localDescription.sdp });
          const t0 = Date.now();
          let next = { kind: "wait" };
          while (!closed && next.kind === "wait") {
            await sleep(700);
            const { answer } = await api("screen");
            if (Date.now() - t0 >= ANSWER_WAIT) ph = (await api("state")).phase;
            next = afterPoll(answer, id, Date.now() - t0, ph);
          }
          if (closed) return;
          if (next.kind === "answer") { setStatus("Connecting…"); await conn.setRemoteDescription({ type: "answer", sdp: next.sdp }); return; }
          if (next.kind === "error") return fail(next.error);
          // "reoffer": the Mac is still waking, so post a fresh offer
        }
      } catch (e) { fail(e.message); }
    })();
    return () => { closed = true; clearTimeout(lost); pc?.close(); };
  }, [token, attempt]);

  // Control: only once the Mac says so (a Mac app without control never does, and stays view-only).
  const send = useMemo(() => createSender(m => { if (dc.current?.readyState === "open") dc.current.send(JSON.stringify(m)); }, f => requestAnimationFrame(f)), []);
  const ok = live && !error && control === "ok";
  const pic = usePicture(mode, size, send, ok);
  const keys = useKeys(send);
  useKeyboard(ok, send, input, () => close.current?.focus());
  const kb = useKeyboardInset();
  useEffect(() => { if (!ok) setTyping(false); }, [ok]);
  const toggleTyping = () => {
    if (typing) { setTyping(false); input.current?.blur(); }
    else { setTyping(true); input.current?.focus(); }
  };

  const note = live && control && control !== "ok" ? CONTROL_MESSAGES[control] || "" : "";
  const msg = error || (locked && live ? "Mac is locked" : status) || note;
  // Once the picture is up, the Close bar fades after 3 s. A mouse brings it back by moving (while controlling: near
  // the bottom edge, so the Dock stays reachable); touch screens use the ••• button.
  const [bar, setBar] = useState(true);
  const hide = useRef();
  const showBar = () => { setBar(true); clearTimeout(hide.current); hide.current = setTimeout(() => setBar(false), 3000); };
  useEffect(() => {
    if (live && !msg) showBar(); else { clearTimeout(hide.current); setBar(true); }
    return () => clearTimeout(hide.current);
  }, [live, msg]); // eslint-disable-line react-hooks/exhaustive-deps
  const keep = e => e.preventDefault();   // the Keys button must not take focus from the phone keyboard
  return (
    <div className="viewer" role="dialog" aria-label="Mac screen"
      onPointerMove={e => { if (e.pointerType === "mouse" && live && !msg && (!ok || e.clientY > innerHeight - 90)) showBar(); }}>
      <video ref={el => { video.current = el; pic.ref.current = el; }} className={ok ? "control" : undefined} autoPlay playsInline muted
        aria-describedby={ok ? "viewer-hint" : undefined} {...pic.handlers} />
      {ok && <p id="viewer-hint" className="sr-only">Mouse and keys go to the Mac. Shift+Escape moves to the Close button.</p>}
      {pic.ring && <span className="viewer-ring" style={{ left: pic.ring.x, top: pic.ring.y }} />}
      {msg && <p className="viewer-msg" role="status">{msg}</p>}
      {ok && touch && <Typing ref={input} keys={keys} onBlur={() => setTyping(false)} />}
      {ok && typing && <KeysRow keys={keys} bottom={kb} />}
      <div className={`viewer-bar${bar ? "" : " hidden"}`}>
        {error && <button className="primary quiet onvideo" onClick={() => setAttempt(n => n + 1)}>Try again</button>}
        {ok && touch && (
          <button className="primary quiet onvideo" aria-label={`Touch mode: ${mode === "direct" ? "Direct" : "Trackpad"}`}
            onClick={() => setMode(m => (m === "direct" ? "trackpad" : "direct"))}>
            {mode === "direct" ? "Direct" : "Trackpad"}
          </button>
        )}
        {ok && touch && (
          <button className="primary quiet onvideo" aria-pressed={typing} onPointerDown={keep} onMouseDown={keep} onClick={toggleTyping}>Keys</button>
        )}
        <button ref={close} className="primary quiet onvideo" onClick={onClose}>Close</button>
      </div>
      {touch && !bar && <button className="viewer-more" aria-label="Show controls" onClick={showBar}>•••</button>}
    </div>
  );
}
