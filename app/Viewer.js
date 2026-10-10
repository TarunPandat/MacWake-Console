"use client";
// Full-screen live view of the Mac over WebRTC. Decisions live in lib/screen.js (mirrored in mobile/src/core.ts).
import { useEffect, useRef, useState } from "react";
import { afterPoll, ANSWER_WAIT, needsWake, newId, SCREEN_MESSAGES } from "../lib/screen.js";

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
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [live, setLive] = useState(false);
  const [attempt, setAttempt] = useState(0);   // Try again re-runs the effect

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
        setError(""); setLive(false); setLocked(false); setStatus("Connecting…");
        let ph = (await api("state")).phase;
        if (needsWake(ph)) { await api("wake", {}); ph = "requested"; }
        const { ice } = await api("screen");
        while (!closed) {
          pc?.close();
          const conn = pc = new RTCPeerConnection({ iceServers: ice });
          conn.addTransceiver("video", { direction: "recvonly" });
          conn.createDataChannel("control").onmessage = e => { try { setLocked(!!JSON.parse(e.data).locked); } catch { /* not ours */ } };
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

  const msg = error || (locked && live ? "Mac is locked" : status);
  return (
    <div className="viewer" role="dialog" aria-label="Mac screen">
      <video ref={video} autoPlay playsInline muted />
      {msg && <p className="viewer-msg" role="status">{msg}</p>}
      <div className="viewer-bar">
        {error && <button className="primary quiet onvideo" onClick={() => setAttempt(n => n + 1)}>Try again</button>}
        <button className="primary quiet onvideo" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
