// Viewer-side live screen decisions, shared by app/Viewer.js. Mirrored in mobile/src/core.ts: keep the text identical.

export const SCREEN_MESSAGES = {
  disabled: "Screen viewing is turned off on the Mac.",
  permission: "MacWake needs Screen Recording permission on the Mac (System Settings → Privacy & Security → Screen Recording).",
  "no-display": "The Mac's screen is off (lid closed, no external display).",
  failed: "The Mac couldn't start sharing its screen. Try again.",
  timeout: "The Mac didn't answer. Check that MacWake is running and someone is logged in.",
  ice: "Couldn't connect directly to the Mac. Add a free TURN relay to the console (see README).",
  lost: "Connection lost.",
};

/** How long the viewer waits for the Mac's answer before checking whether it is still waking. */
export const ANSWER_WAIT = 20e3;

/** What the viewer does after polling for the answer to offer `id`. `phase` is the console's phase (idle/requested/awake/done). */
export function afterPoll(answer, id, waited, phase) {
  if (answer && answer.id === id) {
    if (answer.sdp) return { kind: "answer", sdp: answer.sdp };
    return { kind: "error", error: answer.error in SCREEN_MESSAGES ? answer.error : "failed" };
  }
  if (waited < ANSWER_WAIT) return { kind: "wait" };
  return phase === "requested" ? { kind: "reoffer" } : { kind: "error", error: "timeout" };
}

/** Watching also asks for a wake (it holds the Mac awake), unless one is already holding or on its way. */
export const needsWake = phase => phase !== "awake" && phase !== "requested";

/** Matches an answer to its offer. Not a secret, so Math.random is enough. */
export const newId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
