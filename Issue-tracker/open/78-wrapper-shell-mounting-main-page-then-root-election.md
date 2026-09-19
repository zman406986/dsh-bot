# 78 — Wrapper shell mounting: `main`-page registration, then the root-frame election (ADR-0020 slice 2)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 77 (the shell skeleton)
**Related:** ADR-0020 (staging: `main` page first, `root` election last), `dsh-capsule-seams.md` Seam 4 (`ctx.layout.selectPanel`), 45/33 (live lane)

## What to do

- [x] Staging mount: register the shell as a `main` keyed page (key ours by default; the only
      shipped key is `conversation`) and open it via `ctx.layout.selectPanel` from a sidebar/
      header affordance. Registration contract pinned offline over fakes (inject → register,
      one entry, id stability), matching the existing overlay/toolview test style.
      Evidence: `src/client/shell-mount.ts` + `index.ts` `mountShellPage` + commit 8fcffad
      (2026-09-19 comment below).
- [x] Cutover slice: register the shell into the `root` single slot (dynamic entry — lower
      priority than the shipped frame; abdication falls back to the shipped app, ADR-0020's
      failsafe). Same offline pinning style for the registration contract.
      Evidence: `shellRootRegistration()` in `src/client/shell-mount.ts` (single-slot
      `{name: "root", locale}` — no id/key, matching the runtime catalog's own documented
      example, dsh-cordis-client-runner `lib/client.js:3514-3520`, `registerOptions: []`;
      the shipped AppFrame registers the same way, ui-layout `lib/client.js:524-531`) + the
      `ctx.slots.inject(ROOT_FRAME_SLOT, …)` composition in `index.ts` (commit `94e6127`).
      The election's LIVE half (frame swap visually, HMR fiber behavior, fallback-on-crash
      in a real browser) is NOT claimed from offline work — awaiting live pass 3
      (2026-09-19 comment below).
- [x] Retire the capsule overlay entry at the cutover (the chip/panel vehicle, not the assets).
      Evidence: commit `a44084a` — the capsule's `shell.overlay` inject AND the staging
      launcher chip's inject + `layout` watch are removed from `index.ts`; no
      `shell.overlay` registration remains (pinned by test across the scaffold, shell-mount,
      coexistence, toolviews, roster-panel, and capsule-chip suites). Sources stay
      (`capsule.tsx`, `capsule-store.ts`, `shell.tsx` launcher, `shell-mount.ts` launcher
      contracts — retired-vehicle assets; dead-code disposition is the 65/66/73 lane's).
      *(Executed 2026-09-19, after ticket 80's conversation surface and 84's inject
      declarations landed.)*

## Constraints

- The root election itself (frame swap, HMR fiber behavior, fallback-on-crash) is live-only:
  pin the contract offline, then mark the visual confirmation as awaiting the live lane
  (tickets 45/33) — do NOT tick it from offline work.
- No new toolchain; unload/HMR must reverse every registration.

## Comments

### 2026-09-19 — agent (tracker hygiene: cycle decoupled)

78 and 80 declared MUTUAL blocked-by edges (78←80 "cutover", 80←78 "staging mount") — a
dependency cycle. Decoupled per the ADR-0020 staging/cutover split this ticket itself encodes:

- 80 keeps `Blocked by: 78 staging mount` (a surface needs a page to render into — the
  ordering edge is recorded once, on 80).
- This ticket's `Blocked by` drops the 80 edge (now: 77 only). The ORDERING still holds and
  is recorded here instead: the **cutover slice** (the `root` election AC + retiring the
  capsule overlay entry) executes only AFTER ticket 80's conversation surface has landed in
  the shell — the election replaces the shipped UI, so it must not flip while the main
  surface is still the honest "not wired yet" placeholder. The staging-mount AC
  (`main` page registration) is NOT gated on 80 and may proceed independently.

(Note: the hygiene instruction phrased the retained edge as "78 blocked-by 76 only"; this
ticket's actual skeleton dependency is 77, and 76 (per-dispatcher tooling, resolved) is not
a dependency of mounting — the minimal edit keeps the ticket's own declared 77 edge and
drops only the 80 clause.)

### 2026-09-19 — agent (staging mount implemented; commit 8fcffad)

The staging-mount AC is done; the two cutover ACs stay open on purpose (per the
2026-09-19 hygiene comment: they execute only after ticket 80's conversation
surface has landed). Shape:

- **Page registration** — `src/client/shell-mount.ts` (pure, offline-pinned):
  `MAIN_PAGE_SLOT = "main"` (the dsh-owned keyed page slot; the design-16 v1
  `main` prohibition is superseded for the ADR-0020 vehicle — dated note added
  to `overlay.ts`'s header; the roster entry itself is untouched),
  `shellPageRegistration()` → `{name: "main", key: "multitask-dispatcher-shell",
  locale}` — key ours by default (the only shipped key is `conversation`,
  never claimed), stable across calls and re-applies (id stability).
- **Live mounting path** — `index.ts` `mountShellPage(ctx)` + one keyed `main`
  inject: the shell store binds the sessions feed (ticket 79's
  `bindShellSessionsFeed`) with row selection routed through the binding's
  guarded `open` to `ctx.sessions.open(id)`; the right seat hosts the EXISTING
  `createRosterPanel` (hosted, not rebuilt) with its store projected from the
  SELECTED session's per-session mirror (`shellSeatPanelState` — no mirror or
  a cleared one hosts NO panel; a corrupt one keeps the panel on its honest
  unavailable copy). All effects ride the inject controller's fiber: unload/HMR
  reverses registration + feed subscription + seat projection together.
- **Open affordance** — a SECOND additive `shell.overlay` list entry
  (`multitask-dispatcher-shell-launcher`, order -11, beside the capsule's -10)
  whose click runs `openShellPage(ctx.layout, SHELL_PAGE_KEY)`. Mechanism is
  the verified `ctx.layout.selectPanel` (ui-layout `lib/client.js:399-412`);
  `layout` is an optional structural face read lazily at click time, a missing
  service → honest `no-layout`, the host's documented throw on an unregistered
  `main` key → contained `panel-not-registered` (never a crash into entry
  abdication). Label reuses `shell.title` — no new locale keys. Record choice:
  the AC's "sidebar/header affordance" is satisfied by the floating-layer
  entry because its anatomy is the one VERIFIED in our seams notes
  (`dsh-capsule-seams.md` Seam 1: self-positioning, click-through, per-entry
  error boundary); the sidebar slots' rendering anatomy has no verified
  citation, and the chip self-positions below the capsule chip, retiring
  together with it at cutover.
- **Fail-safe pinned offline (not the election itself)** — `shellCellWinner`
  models registry.d.ts:156-164 ("first live (non-abdicated) entry in priority
  order", dynamic lower priority value than the shipped frame): the dynamic
  entry wins the cell exactly while live; abdication falls back to the shipped
  frame; all-abdicated → no winner. `ROOT_FRAME_SLOT = "root"` is named as the
  cutover target and a test pins that NOTHING registers into `root` while
  staging stands. The live-only half (frame swap, HMR fiber behavior,
  fallback-on-crash in a real browser) stays unticked for the live lane
  (tickets 45/33) per the constraint.
- **Offline pins** — `test/client-shell-mount.test.ts` (registration contracts
  over fakes: inject → register, one `main` entry, id stability, teardown
  reversal + re-apply restore; the no-root pin; open decision; live mount path
  incl. feed sync/upsert/removal, guarded open, seat projection, no-sessions
  degrade, teardown unsubscribe). Existing pins updated: inject count 3 → 5
  (scaffold/toolviews/roster-panel), coexistence overlay list now
  capsule+launcher+foreign (order-sorted, HMR isolation kept), shell CSS
  contract extended to the launcher stylesheet (token-only; `label-primary`
  joins the evidenced set — the capsule chip's own surface token).

**Gates:** `npm test` 899 pass / 0 fail (225 suites, +32 over 79's 867);
`npm run typecheck` clean (both configs); `npm run build:client` green
(client\index.js, 114868 bytes). Capsule registration untouched. Ticket stays
in `open/` until the cutover slice (post-80): flip `root` with the dynamic
entry (priority `SHELL_ROOT_DYNAMIC_PRIORITY`), retire the capsule AND
launcher overlay entries, then take the live-lane confirmation on 45/33.

### 2026-09-19 — live pass 2 (zero-LLM): the launcher chip renders and stacks correctly; the click does NOT open the shell page — blocked by NEW ticket 84 (uninjected service reads throw)

Evidence: `C:\Users\TZhen\Desktop\dsh-live-pass2-2026-09-19\` (throwaway `multitask`
profile, host 0.1.5-rc.1, commit `c56e69d` tree, client bundle 157,823 bytes).

- **Chip renders as specified**: `multitask-dispatcher-shell-launcher__chip` (调度台，
  `data-staging="shell-page"`) is present on a real profile boot, positioned top 44 px /
  right 8 px — one row BELOW the capsule chip (top 10 px), matching the staging CSS comment
  and the order −11-vs-−10 registration (`shots/04-chips-capsule-launcher.png`).
- **Click does not open**: no `[data-shell="dispatcher"]` element ever appears; the stock
  empty state stays (`shots/05-shell-main-page.png`); the page-error log records
  `cannot get property "layout" without inject` (click path) and
  `cannot get property "sessions" without inject` (the mount's feed-binding effects at
  registration). Root cause, fix direction, and the offline-fake lesson: **ticket 84**.
  `openShellPage`'s contained honest outcomes are unreachable because the property READ
  itself throws before the call.
- Consequences for this ticket's checklist: the staging-mount AC stays ticked (registration
  contract + chip are real); the live visual confirmation of the three-pane `main` page and
  the cutover ACs remain open and now additionally await 84. No cutover ACs were touched.
- **2026-09-19**: 84 landed (`154e7c7`) — shell page open unblocked for live pass 3.

### 2026-09-19 — agent (CUTOVER landed: root election + capsule/launcher retirement; commits 94e6127 + a44084a)

Both cutover ACs executed offline (post-80/84 prerequisites). **Ticket stays `open/`:** its
Constraints route the election's live half to the live lane, and they are NOT claimed —
**awaiting live pass 3** (frame swap renders visually; HMR swap reverses cleanly in a real
client; a crashed entry abdicates and the stock app frame takes the cell back; onboarding/
conversation/roster seats work inside the elected frame).

- **Root election (94e6127).** `shellRootRegistration()` = `{name: "root",
  locale: "multitask-dispatcher"}` — a single slot takes no id/key/order; the shape matches
  the runtime slot catalog's own documented example (`ctx.slots.inject('root', () =>
  ctx.slots.register({name: 'root'}, …))`, registerOptions `[]`, dsh-cordis-client-runner
  `lib/client.js:3514-3520`) and the shipped AppFrame's own registration (adds `locale` +
  child-seat declarations we deliberately omit — our frame is self-contained; ui-layout
  `lib/client.js:524-531`). The priority field is host-assigned ("Page-local shadowing rank.
  A later registration receives a lower priority.", runner `lib/client.js:383`) — the model
  constant `SHELL_ROOT_DYNAMIC_PRIORITY = 1` stays as the relative-order contract only. The
  entry mounts the SAME `mountShellPage` composition as the `main` page (feed binding,
  conversation window, seat projection, onboarding seat — one shared onboarding store).
- **Abdication paths (real, not just the pure fn).** Unload/HMR: the inject controller rides
  the caller's fiber, so the fiber cascade sweeps the entry (`registry.d.ts:77-83`) — pinned
  offline: teardown empties `root`, `shellCellWinner` over the surviving cell hands it to the
  shipped frame; re-apply restores the identical contract. Crash: the per-entry boundary
  abdicates shadowing entries and "the outlet re-renders onto the cell's next survivor"
  (dsh-client-ui-renderer `lib/client.js:507-514`) — host-side, live-pass-3 confirmation.
- **Retirement (a44084a).** The capsule `shell.overlay` inject, the launcher `shell.overlay`
  inject, and the launcher's `ctx.inject(["layout"])` watch are gone from the composition; the
  strict-host pin now expects exactly one runtime inject request (`["settingsScope"]`).
  Registration inject count 5 → 4 (toolview, settings card, `main`, `root`). The `main` page
  registration STAYS (its staging AC is ticked history; contract untouched): while the frame
  election stands it is dormant (invisible; if the shadowed frame's child declarations
  collapse, the documented collapse/re-declare mechanics park it safely), and on abdication it
  self-restores — safe under either reading of the catalog's "every seat the frame declares
  gone". Locale keys untouched by the cutover (no copy change).
- **Assets kept.** Capsule/launcher sources, stores, and copy remain exported and fed by the
  one settings watch (re-host inventory per ADR-0020; disposition = 65/66/73). Ticket 81's
  capsule-retirement bullet is overtaken by this slice's retirement AC (its approval-cards
  work is unaffected).
- **Gates:** `npm test` 1016 pass / 0 fail (250 suites, both commits); `npm run typecheck`
  clean (both configs); `npm run build:client` green (client\index.js, 158,103 → 138,259
  bytes across the two commits).

### 2026-09-19 — live pass 3 (`C:\Users\TZhen\Desktop\dsh-live-pass3-2026-09-19\`, outside the repo): the cutover's live half FAILS — the `root` registration throws on the real host and the WHOLE loader entry aborts; NEW ticket 85; no live AC ticked

Setup: HEAD `c437ee8` rebuilt in place (bundle 138,259 bytes — the post-cutover size, not
the stale ~158 KB), throwaway `multitask` profile, insert row composed
(`multitask-config-dump.yml:542`), host 0.1.5-rc.1, port 8876, WMI node-direct boot,
timers armed at launch and verified in tasklist. Zero LLM traffic.

- The page renders the host's FAIL-LOUD screen ("Failed to load plugins /
  dsh-multitask-dispatcher / failed to apply loader entry …: single slot "root" already has
  a registration at priority 0 (registered by Ba) — register at a different priority to
  shadow it (lowest renders)") — `shots/01-boot-blank-or-not.png`, `driver-status-final.json`
  (the session's ONLY page error; zero `without inject` errors — 84's inject declarations
  worked; the throw happens LATER, at the slot registration).
- Scope: no `[data-shell="dispatcher"]`, no shell faces, AND no stock app either (composer
  count 0, nav count 0) — the entry throw kills the client boot before any election exists.
  The boot graph row itself is correct (`served-html.html`).
- Root cause + fix direction: **ticket 85** — `shellRootRegistration()` passes no priority;
  the host single-slot register defaults to priority 0, colliding with the shipped
  AppFrame's; the comment above's "the priority field is host-assigned" reading does not
  hold live for the `root` single slot.
- None of this ticket's live-lane clauses (frame swap visual, HMR reversal, fallback-on-
  crash, onboarding/conversation/roster seats in the elected frame) could be observed —
  the frame never mounts. ACs unchanged; the ticket stays `open/` on 85.
