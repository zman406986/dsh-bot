# 105 — Floating window has a fixed 760×520 size — no resize, no maximize/restore affordance

**Status:** resolved
**Labels:** ready-for-agent
**Related:** 103 (resolved — the per-event-delta drag pattern to reuse), ADR-0021 (accepted — the floating-window vehicle this window rides)

## Problem

The human requests (2026-09-22, in-session, verbatim): *"floating-window should be allowed to be resized, with a maximize button like windows"*.

Today the window's size is written once at store creation and never mutated:

- `src/client/floating-window-store.ts:49` — the state field's own comment: "The window's size — fixed for now (no resize affordance is ticketed)".
- `src/client/floating-window-store.ts:83-84` — the constants `FLOATING_WINDOW_WIDTH = 760` / `FLOATING_WINDOW_HEIGHT = 520`, seeded into the initial state at `:153-154` and never written again: `open`, `close`, and `moveBy` all spread the existing width/height through, and no other writer exists under `src/client`.
- No resize or maximize code exists anywhere under `src/client` — the only `resize` in the client face is the unrelated composer textarea (`resize:vertical`, `src/client/conversation.tsx:88`).

The store face has position mutation (`moveBy`, `src/client/floating-window-store.ts:203-214`) but no size mutation, and the window component offers only drag + close (the titlebar's single button, `src/client/floating-window.tsx:196-205`). There is no way to make the window larger, smaller, or viewport-filling.

## What to do

- [ ] Add store mutation paths for width/height, mirroring the `moveBy` pattern (`src/client/floating-window-store.ts:203-214`): pure, clamped, immutable emit, and the same early-return-when-absorbed contract `moveBy` follows (pinned at `test/client-floating-window.test.ts:175-189` — a resize that changes nothing must not emit). Decide and document whether a size change re-clamps the position so the window stays reachable under `clampWindowPosition` (`:129-145`).
- [ ] Add edge/corner resize handles in `describeFloatingWindow` (`src/client/floating-window.tsx:172-214`), reusing the per-event-delta drag pattern (`beginDrag`, `:265-287`; the per-event-delta contract is pinned at `test/client-floating-window.test.ts:674-748` — each move feeds its OWN delta, no start-relative compounding).
- [ ] Add a Windows-style maximize/restore toggle button in the titlebar next to close (`floating-window.tsx:196-205`): maximize fills the viewport (respecting the clamp and `FLOATING_WINDOW_MARGIN`, `floating-window-store.ts:89`), restore returns the prior geometry (position AND size). Pure store transition, pinned offline.
- [ ] Keep the pinned child order in `describeFloatingWindow` (children[0]=style, [1]=titlebar, [2]=body/boundary; pinned at `test/client-floating-window.test.ts:844-894`) — append any handle elements AFTER the body, or update that structural pin deliberately with the change recorded in the test's own words.
- [ ] CSS goes in the inline `FLOATING_WINDOW_CSS` (`floating-window.tsx:85-96`): token-only (`var(--dsw-*)`, no raw colour literals), `multitask-dispatcher-fwin__*` class discipline, no animation.
- [ ] en+zh locale lockstep for any new accessible copy (e.g. maximize/restore aria-labels): one key in BOTH faces — `validateLocaleDictionary` (`src/client/overlay.ts:507-540`) enforces identical key sets.
- [ ] Update the deliberately-broken records (the "fixed for now" comment at `floating-window-store.ts:49`) and add offline pins for the resize math (store-level: grow, shrink, clamp, absorbed-no-op) and the maximize/restore toggle.
- [ ] `client/index.js` is a build artifact — run `npm run build:client` and include the regenerated file if tracked-git shows it changes.

## Constraints

- No new host seams — everything lives in our own client module (`floating-window-store.ts` + `floating-window.tsx`); the portal/DOM technique of ticket 100 is untouched.
- Token-only CSS; `multitask-dispatcher-fwin__*` class discipline; no animation.
- In-memory only: the store records no persistence (same posture as the window's position — a reload starts at the default size again); do not add storage while implementing.
- The store stays pure (geometry decided in the store; the component feeds pointer values and a viewport — the existing `describe*`/`moveBy` discipline).

## Comments

### 2026-09-22 — implementation session

Implemented offline (no live lane touched). All geometry stays in the store; the component only feeds pointer deltas, a viewport, and a face.

**Store (`src/client/floating-window-store.ts`)** — the "fixed for now" comment is replaced; the size is now mutable, still in-memory only:
- `resizeBy(edge, dx, dy, viewport)` — edge-aware resize mirroring `moveBy`'s contract: immutable emit, early return when the clamp absorbs the whole delta (box reference stable), no-op while closed or maximized. East/south faces keep the top-left put (the face cannot cross a viewport edge); west/north faces keep the OPPOSITE edge put (x/y follow the pointer, the size compensates), then the position runs through `clampWindowPosition` — position validity wins if it ever disagrees with edge preservation (the ticket's "…then clamp" wording; identity for any in-bounds window, pinned).
- `toggleMaximize(viewport)` — fills the viewport minus `FLOATING_WINDOW_MARGIN` on every side and remembers the prior rect (closure field, not published state); second toggle restores the remembered rect exactly (size exact, position re-clamped). Rejected while closed (mirrors `moveBy`'s closed pin). `maximizedWindowPlacement` is the exported pure fill math (also clamps to the minimum on absurdly small viewports — deterministic, no NaN).
- **Viewport shrinks while maximized (recorded per the session brief):** nothing re-clamps until the next interaction, because the store only ever sees a viewport as a call argument (no listener). Every path that carries a viewport re-clamps: a drag (`moveBy`) restores first against the live viewport, an explicit restore re-clamps the remembered POSITION (size stays exact — the peek rule keeps the titlebar reachable), and a maximized close/reopen re-FILLS against the current viewport (maximized survives close; the remembered rect survives until restore).
- **Maximized-drag decision: Windows-like restore-on-drag, decided entirely in the store.** `moveBy` while maximized restores on the first move and then applies the delta to the restored rect; a bare click (down+up) never restores. The component's `beginDrag` stays maximized-blind — the ticket-103 pattern untouched. `resizeBy` while maximized is a plain no-op (restore via drag or the button); wiring restore-on-resize would yank the rect out from under the grabbed edge.
- **Minimum size: 320×240** (`FLOATING_WINDOW_MIN_WIDTH/HEIGHT`) — small enough to stay usable on a crowded viewport, large enough that the titlebar and the shell's panes keep working.

**Component (`src/client/floating-window.tsx`)**:
- `beginResize(edge, event, store)` is exactly the `beginDrag` pattern with a face (left-button only, own-delta-per-move, three window listeners removed on up/cancel).
- Resize handles render AFTER the body as JSX-spread children so the pinned structural order stays flat and untouched (children[0]=style, [1]=titlebar, [2]=body — the pin's runtime assertions needed no change, only its type cast and a new tail assertion). Five faces wired: `e/w/s/se/sw` with `multitask-dispatcher-fwin__resize-<edge>` classes + `data-resize-edge` hooks. **The north faces (n/ne/nw) are deliberately NOT wired** — the titlebar owns the top strip (drag) and the buttons own the top-right corner; a north handle would steal drags or button clicks (the window has no non-client area to park them in, unlike a real window manager). The store math supports all eight edges if ever needed.
- Windows-style maximize/restore button in the titlebar next to close (`data-window-maximize="true"`, `aria-pressed`, glyph □/❐); aria-label/title swap with state. The root carries `data-window-maximized` while maximized; CSS turns the handles inert there (`pointer-events:none`) since the store rejects resizes.
- CSS: handle hit zones (6px edges, 12px corners) with face cursors (`ew-resize`, `ns-resize`, `nwse-resize`, `nesw-resize`), `touch-action:none`, NO colour properties at all (token rule trivially met), no animation.
- **Drag-while-maximized pinned** (the store rule above) in both store and rendered pins.

**Locales (`src/client/overlay.ts`)**: `launcher.window.maximize` / `launcher.window.restore` added to BOTH faces in lockstep (en "Maximize/Restore the dispatcher window", zh 最大化/还原调度窗口); `validateLocaleDictionary` stays green.

**`client/index.js`**: `npm run build:client` ran; the bundle is git-ignored build output (untracked per `.gitignore` `/client/`), so tracked-git shows no bundle change to include.

**Pins**: 18 added (13 store: east/west/north-south faces, min-size clamp + absorbed no-emit ×3 axes, viewport-edge clamp + fill math, closed/maximized no-op, maximize fill, exact restore, closed reject, restore re-clamp on shrunken viewport, drag-restore via `moveBy`, maximized-persists-reopen re-fill, post-resize position validity; 5 rendered: handles present/north absent, east per-event-delta sum, west opposite-edge-put, maximize aria+geometry toggle, titlebar-drag-while-maximized). 3 updated deliberately: the structural-pin literals (state `maximized`, chrome `maximize`/`restore`, actions `onToggleMaximize`/`onResizePointerDown`) + its tail handles assertion; the scaffold suite's exact locale key list (+2 keys). The 539 chip-text pin is untouched (ticket 107's). All pre-existing pins green.

**Gates**: before 1176/288/0, typecheck green, lint:docs green → after **1194/290/0** (pass/suites/fail), typecheck green, lint:docs green. Evidence: `.scratch/testing/2026-09-22-live-105-106-107/offline-105/` (before/after gate outputs + README artifact map).

Ticket stays in `open/` — resolution waits for the live lane.

### 2026-09-22 — scribe session

Filed from the human's in-session request of 2026-09-22 (quoted verbatim in Problem). The scribe pass verified the cited facts by code reading only (no implementation): the size is seeded once at store creation and has no writer, the store face has no size mutation, and the only `resize` anywhere in the client face is the composer textarea's. The implementer should reuse the two recorded contracts rather than inventing new ones: `moveBy`'s clamp-and-early-return discipline at store level, and the per-event-delta drag rule at component level (ticket 103's fix, pinned at `test/client-floating-window.test.ts:674-748`). Labelled ready-for-agent: the behavior is fully specified by the request plus the existing patterns; no design decision is left open beyond the handle/affordance details the implementing ticket records as it goes.

### 2026-09-22 — live lane

Live-verified against the real host + served bundle in the lane
`.scratch/testing/2026-09-22-live-105-106-107/live/` (served plugin bundle rev
`84138c72a6b3` carries this ticket's markers with counts identical to the local build —
isolation per the 2026-09-21 lane's method; see `obs-00-load.json`). Verdict: **PASS on
every clause.**

- **Resize, per-event deltas (the ticket-103 rule with a face):** real CDP mouse drags on
  the `data-resize-edge` handles; geometry recorded after every move. SE height ratio
  **1.000** (+120 dispatched → +120); W face: x −80 / width +80 with the right edge fixed,
  then +30/−30 exact; S face +50/50 exact; unclamped SE growth after repositioning:
  +120/+80 dispatched → +120/+80 rendered, ratio **1.000** (`obs-105-resize.json`,
  `obs-105-resize-supplement2.json`). One instructive non-bug: growing SE from the default
  placement only added +24 px because the window sits 24 px from the viewport's right edge
  and the store's east clamp (`viewport.width − x`) capped it EXACTLY.
- **Min clamp:** SE drag sum (−3000,−2700) → 322×242 rendered = **320×240 state exact**.
- **Viewport clamp:** SE drag sum (+4000,+3000) → 836×723 = (vw−x, vh−y) state exact.
- **Maximize/restore:** click → rect (24, 24, 1330, 699) = viewport minus the 24 px margin
  exactly, `data-window-maximized="true"`, aria-pressed true, label swaps 最大化/还原;
  resize handles compute `pointer-events: none` and a drag attempt moves nothing; restore
  click → the EXACT prior rect; maximize again + titlebar drag → restore-then-drag with the
  net delta applied to the remembered rect (`obs-105-maximize.json`).
- All five handles (`e/w/s/se/sw`) render with `data-resize-edge`; every press verified
  `elementFromPoint`-on-handle before dragging.

Probe misses recorded honestly in the lane README (off-viewport SE press in supplement v1;
corrected in v2). Ticket stays in `open/` for the closer.

### 2026-09-22 — resolution (team-leader close-out)

Resolved by the independent closer, which re-ran every gate itself before closing:
`npm run typecheck` green; `npm test` **1216 pass / 298 suites / 0 fail** (measured, not
claimed); `npm run lint:docs` green; constraint spot-checks clean — the ONE command
transport holds (the only client call site of `remote.commands.execute` remains
`bindCommandTransport`, `src/client/actions.ts:253`; none in shell.tsx / floating-window.tsx
/ index.ts), `launcher.window.maximize` / `launcher.window.restore` exist in BOTH en and zh
faces under `validateLocaleDictionary`, and no commit touches a `.scratch/` path.

**Shipped** (`b8d883c`): the floating window is resizable via e/w/s/se/sw edge handles over
clamped, pure store paths (`resizeBy`), with a Windows-style maximize/restore toggle in the
titlebar (`toggleMaximize`); north faces deliberately unwired (the titlebar owns the top
strip). Live lane: **PASS on every clause** — resize ratios 1.000, min 320×240 and viewport
clamps exact, maximize/restore rect-exact — evidence
`.scratch/testing/2026-09-22-live-105-106-107/live/` (`obs-105-resize*.json`,
`obs-105-maximize.json`, README per-claim verdict map). Final gates: **1216/298/0**; lint
green.
