# 88 — The elected frame's conversation seat crashes (Minified React error #300) the moment a session row is opened: the host's per-entry boundary abdicates our `root` entry and the stock frame takes the whole client back until a reload

**Status:** resolved
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

- [x] (offline) a mount test renders the shell with a SELECTED session carrying non-empty
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

## Resolution

**2026-09-19 — offline fix landed (`d242d18`); live AC awaits the next live pass.**

### Requirement 1 — #300 decoded against the vendored React (evidence, not assumption)

The host bundle's React is the react-vendored 19.3 family; decoded against
facebook/react `scripts/error-codes/codes.json` at tag `v19.3.0` (the error-decoder page
itself 404s): **#300 = "Rendered fewer hooks than expected. This may be caused by an
accidental early return statement."** — the OPPOSITE of the folklore "more hooks" (#310
is that one). Direction 3 of this ticket's candidates (provider/context throw) is ruled
out; the real cause is a fourth nobody listed:

### Root cause (file:line)

The shell RENDERED ITS SEATS BY CALLING THEM AS FUNCTIONS, so each seat's hooks were
inlined into the SHELL's own hook list, making the shell's hook count branch-dependent:

- `shell.tsx:365` — `hosts.onboarding()` inlined the onboarding seat's TWO
  `useSyncExternalStore` hooks (`onboarding-pane.tsx:84-87`) into the shell fiber;
- `shell.tsx:381` → `index.ts:625` — `hosts.conversation(id)` → `conversationPane({id})`
  inlined the conversation store subscribe (1 hook);
- `shell.tsx:391` → `index.ts:613-616` — `hosts.rosterPanel(id)` → `seatPanel()` inlined
  the roster panel's `useSyncExternalStore` + `useEffect` (`panel.tsx:291,297`) behind a
  branch-dependent mirror gate.

Boot (no selection, onboarding wired): shell fiber = 1 + 2 = 3 hooks. Clicking a row →
selection render drops the onboarding branch: live pass 4's fresh profile had NO mirror
for the clicked session, so the roster seat contributed 0 → 2 hooks < 3 → **#300
("fewer")**, the exact live error; with a mirrored session it is 4 hooks > 3 → #310
("more") — same defect, sibling error, both now reproduced offline.

### Fix (commit `d242d18`)

All three seats are now COMPONENTS the shell renders as elements — `<hosts.onboarding />`,
`<hosts.conversation sessionId=… />`, `<hosts.rosterPanel sessionId=… />` (the JSX
member-expression form) — each owning its hook fiber; branch flips mount/unmount seats,
never change the shell's hook count. The composition passes the component outputs
directly (`conversation: conversationPane`) and gates the roster panel in a ZERO-HOOK
wrapper (`RosterSeat`) that renders `createElement(seatPanel)` — the mirror gate's null
flip is an ordinary unmount. No changes to the abdication boundary, the election, or 84's
inject declarations (requirement 3 held).

### Same-class hazards found and fixed in the same sweep

- `index.ts:613-616` roster seat's `seatPanel()` inline call (2 hooks + an effect behind
  a branch-dependent gate — the #310 variant, and a live #300 on any mirror→no-mirror
  selection switch).
- `index.ts:625` conversation seat's `conversationPane({sessionId})` inline call
  (1 hook inlined into the shell fiber).
- Scanned and CLEAN: `conversation.tsx`'s `<ApprovalCards />` (element; its early returns
  are after its hook — legal), `Composer`/`AccessAskCardView`/`RosterRow` (hooks first,
  unconditional), the retired `capsule.tsx`, `settings-card.tsx`, `toolview-panel.tsx`
  (registered INTO host slots — the host renders those entries as components).

### Regression test (the 44/45/84/85 lesson applied)

`test/client-shell-seat-composition.test.ts` renders the REAL composition —
`mountShellPage`'s stores + seats + `createDispatcherShell` — with react-dom 19.3 on
jsdom, over host-faithful fakes (`sessions.list` live feed, `sessions.binding(id).eventSource`
windows, `scope(id).conversation.loadOlder`), and drives REAL DOM clicks on sidebar rows:
boot-onboarding → select-dispatcher-with-history(+mirror) → plain session → flip ×2 →
removal-reset (onboarding remount), plus a mid-load-window click (honest unavailable, then
fills live). RED before the fix: it reproduced **#300** on the no-mirror click and **#310**
(with mirror) — the two error texts above, verbatim from React's dev build. Why earlier
suites missed it: every client test asserted stores/view-models only; NO test ever
rendered React, so conditional-hook violations were invisible (S8's "build + typecheck"
coverage had this exact hole). `npm test` now runs the suite through
`tsx --tsconfig tsconfig.client.json` so the JSX transform matches the shipped bundle
(`jsx: automatic`); devDeps `react-dom`/`jsdom` are test-only — the shipped client keeps
React external to the host (unchanged).

Gates: `npm test` 1058/1058 (was 1056 + 2 new), `npm run typecheck` green,
`npm run build:client` green (159,920 bytes).

### Residual uncertainty (for the live lane)

The offline reproduction is dev-build React 19.3 vs the host's minified production build —
same reconciler, same invariant numbers, but the live AC (click a row, zero LLM calls,
frame stays ours, no `slot entry crashed in 'root'`) is deliberately UNTICKED until a
real pass confirms it. The fix touches only how seats are instantiated, not any host
seam, so the pass-4 boot state (85 live green) is not expected to move.
