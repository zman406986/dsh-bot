# 88 — The elected frame's conversation seat crashes (Minified React error #300) the moment a session row is opened: the host's per-entry boundary abdicates our `root` entry and the stock frame takes the whole client back until a reload

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 78 (the cutover whose live fallback this proved), 80 (the conversation surface that crashes), 81 (the cards that ride that surface), 85 (the priority fix that made the frame boot at all)

## Symptom (live, cited)

Live pass 4, 2026-09-19 (`C:\Users\TZhen\Desktop\dsh-live-pass4-2026-09-19\`, outside the
repo), throwaway `multitask` profile, host 0.1.5-rc.1, HEAD `8d0d572`, the 85-fixed boot
(shell as root, zero pageerrors at boot):

- Clicking a session row in the shell sidebar (the feed's guarded `open` →
  `ctx.sessions.open(id)`) — the shell's conversation-seat render throws:
  `console-error: Error: Minified React error #300 … (index-BKQ_L1z6.js)` followed by the
  host's containment line `console-error: slot entry crashed in 'root': Minified React
  error #300` (`driver-status-final.json` — the ONLY two errors of the session).
- Consequence: the host's per-entry boundary **abdicates our `root` entry** and the stock
  AppFrame retook the cell — `[data-slot="root"]` now renders the shipped
  `pI_x6G_frame`, zero `multitask-dispatcher-*` elements remain, no fail-loud screen
  (`abdicated-stock-frame-dom.json`, `shots/02-abdicated-stock-frame.png`).
- The shell does not come back until a full page reload (which re-applies cleanly — the
  crash is reproducible on selection, not a wedge).

Two readings of the severity, both true: the crash is a **render defect in the
conversation seat** (this ticket); and the abdication that follows is the cutover's
designed failsafe working exactly as documented (78's live-lane clause — proven by this
very crash; recorded there, not double-claimed here).

## Root cause (direction; verify offline before coding)

React minified #300 in the shipped React 19 build — decode against the exact react version
in the host bundle (`reactjs.org/docs/error-decoder.html?invariant=300`) before touching
code. The throw happens when the seat composes the selected session's conversation window
(the 80 surface: feed-selected session + conversation binding + worker rows). Candidate
directions, to be pinned offline over fakes that model the REAL host semantics:

1. An invalid element the seat renders only for a session with NON-EMPTY history (the
   crash reproduced with an existing session; no fresh/empty session was available in the
   throwaway profile to isolate empty-vs-history) — e.g. a row/toolview/conversation
   element mapped from a message shape the offline fixtures never produce.
2. The conversation binding's render using an undefined component when the mirror or
   window state is mid-load (the click happened immediately after boot; loading-state
   rendering has the thinnest offline coverage).
3. A host component used across the inject boundary without its required provider
   (the declared-inject list covers `sessions`/`remote`/`conversation` — verify the RENDER
   side doesn't read another service property through a context that throws inside JSX,
   which React surfaces as an element-type/act-class error rather than the raw
   `without inject` message).

## Requirements

1. Decode #300 against the shipped React and cite the exact failure; reproduce offline by
   extending the mount fixtures with a selected session carrying history (the 44/45/84/85
   lesson: the fakes must model the host's real render semantics, or this class keeps
   passing offline and dying live).
2. Fix the seat (not the boundary, not the election, not 84's inject declarations).
3. No changes to the abdication/fallback behavior — it is correct and is the only reason
   the crash degraded to "stock UI" instead of a dead page.

## Acceptance criteria

- [ ] (offline) a mount test renders the shell with a SELECTED session carrying non-empty
      history over host-faithful fakes and passes; the reproduced crash fails before the
      fix.
- [ ] (live, ZERO LLM calls) clicking a session row in the elected frame opens the
      conversation seat inside OUR frame (`[data-shell="dispatcher"]` stays mounted, no
      `slot entry crashed in 'root'` error), on a real profile boot.

## Notes

- Found by live pass 4; no product files changed during the pass. The flow evidence for
  45/44 AC 3 was captured post-abdication in the stock frame and is labeled as such there.
- Until this lands, the wrapper lane's "shell IS the client" state is boot-only: any
  selection immediately hands the client back to the stock frame. That is the remaining
  blocker for 78's closeout and 33's.
