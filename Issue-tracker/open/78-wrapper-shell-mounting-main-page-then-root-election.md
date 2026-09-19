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
- [ ] Cutover slice: register the shell into the `root` single slot (dynamic entry — lower
      priority than the shipped frame; abdication falls back to the shipped app, ADR-0020's
      failsafe). Same offline pinning style for the registration contract.
      *(Awaiting cutover — executes only AFTER ticket 80's conversation surface lands; see the
      2026-09-19 comment. The fail-safe election rule itself is already pinned offline as pure
      functions in `shell-mount.ts` (`shellCellWinner`), and a test pins that NOTHING registers
      into `root` while staging stands.)*
- [ ] Retire the capsule overlay entry at the cutover (the chip/panel vehicle, not the assets).
      *(Awaiting cutover — same gate as above; the staging launcher chip retires alongside it.)*

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
