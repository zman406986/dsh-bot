# 38 — Capsule skeleton: collapsed chip + expand/collapse in the existing shell.overlay entry (epic 35)

**Status:** resolved
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 36 (chip interactivity is bounded by the verified `shell.overlay`
entry anatomy — pointer-events opt-in, anchoring).

## Context

Epic 35's fixed direction: one floating capsule in the shipped additive
`shell.overlay` list slot. Collapsed = a small chip, the glanceable presence
projection (activation-state dot; worker count when active; wake badge =
settled workers with undelivered results). Expanded = the panel. Today the
single overlay entry always renders the full panel
(`src/client/panel.tsx`; enriched sectioned store on the worktree branch).

**Tree rule (epic req 6):** if ticket 33's merge has not landed, implement on
the ticket-17 worktree (`C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch
`clone/always-on-dispatcher`) — the chip's worker count and wake badge need the
snapshot v2 fields (`status`, `delivered`) that only exist there; otherwise on
`main`. Tracker edits land on `main` either way.

## Requirements

- Keep exactly ONE `shell.overlay` entry: same id `multitask-dispatcher-roster`,
  same order −10 (`src/client/overlay.ts`). No second entry, no new slot, no
  shadowing registration.
- Add pure expand/collapse state to the store layer (`roster-store.ts` or a
  sibling `capsule-store.ts`): default **collapsed**; expand/collapse/toggle
  actions; state survives re-renders, resets are fine on fiber reload.
- New chip view model (pure function over the existing panel state + freshness,
  same style as `describeRosterPanel`):
  - **Activation dot** — exactly three states from existing store truth only:
    `dormant` (no snapshot observed — `waiting`), `active` (fresh snapshot),
    `error` (stale/`invalid`/`channel-missing` once an activation was seen).
    Dot color/class is ours, `multitask-dispatcher-` prefixed CSS.
  - **Worker count** — snapshot worker total, rendered only in `active`.
  - **Wake badge** — count of settled (terminal-status) workers with
    `delivered === false`; rendered only when > 0.
- Expanded state renders the existing panel content unchanged this ticket
  (sections from ticket 28); no activation row, deliverables, or footer yet.
- Locale keys for the chip (accessible labels, badge text) added to BOTH faces
  of `localeDictionary`; `validateLocaleDictionary` green. No literals.
- Degrade honestly: unavailable channel → chip shows the `error` dot (or
  `dormant` pre-activation per the mapping above), never a fake count.

## Acceptance criteria

- [x] Chip view model unit-tested in a new `test/client-capsule-chip.test.ts`:
      dot-state mapping over all store kinds + staleness; worker-count gating;
      wake-badge threshold (0 hides, N>0 shows the exact count); toggle
      behavior; identity of the registration options (one entry, unchanged id).
- [x] `test/client-roster-panel.test.ts` fixtures still pass — the dormant
      composition of the underlying panel is unchanged at this stage.
- [x] Locale validator green with the enlarged dictionary (identical en/zh key
      sets, all strings).
- [x] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      produces `client/index.js` (esbuild contract test green).

## Verification

Named method: `npm test` (new `test/client-capsule-chip.test.ts` + existing
`client-roster-panel`/`client-face-scaffold` suites), `npm run typecheck`,
`npm run build:client`. Browser assertion is deferred to ticket 33's pass.

## Comments

2026-09-18 — **Implemented** (worktree `C:\Users\TZhen\Desktop\dsh-bot-always-on`,
branch `clone/always-on-dispatcher`, commit `8d907fe`, full
`8d907fef648bc8b1e5fcd2a0cc04d9b621800a04`). All acceptance criteria ticked.
Scope held to the skeleton: chip + expand/collapse only — activation row,
action wiring, deliverables line, and footer are tickets 39–42 and are
deliberately absent.

**Chip view model** (`src/client/capsule-store.ts`, new):
`describeCapsuleChip(state, nowMs, windowMs = ROSTER_STALE_WINDOW_MS)` — pure,
same style as `describeRosterPanel`, over the existing panel state + freshness
only (no new truth, design-17 §5 conflict 8). Dot mapping: `waiting` →
`dormant`; fresh `snapshot` → `active`; stale `snapshot` / `invalid` /
`channel-missing` → `error`. The requirement's "once an activation was seen"
qualifier resolves as documented in the module header: pre-activation the
store state is `waiting` (its initial value — the feed starts alive), while
stale/invalid/channel-missing are the post-activation-or-broken-channel
degradations; the degrade-honestly clause's "`dormant` pre-activation" face is
exactly that `waiting` state, never a fabricated one. Counts come from a fresh
snapshot only, so a degraded chip carries `workerCount: null` /
`wakeCount: null` — never a possibly-stale count. `wakeCount` counts settled
(`isTerminalStatus`, core FSM) workers with `delivered === false`; `0` renders
nothing but stays distinct from `null` ("fresh snapshot, nobody waiting" vs
"no fresh truth"). Worker count renders only in `active`; wake badge only
when > 0.

**Expansion store** (same file): `createCapsuleStore()` — default collapsed;
`expand`/`collapse`/`toggle`; no-ops are identity-stable (box identity changes
only on a real transition, so `useSyncExternalStore` never re-renders on a
no-op). This is ADR-0013's "expansion is the entry's own component state": it
survives re-renders and resets on fiber reload (a fresh fiber creates a fresh,
collapsed store).

**Capsule component** (`src/client/capsule.tsx`, new):
`createDispatcherCapsule(t, store, capsule)` renders the chip — a real
`<button>` (keyboard-reachable expand; dot keyed by `data-dot` with a
per-state accessible label; localized count and wake badge) — or, expanded,
the card: a collapse control plus the existing `createRosterPanel` component
rendered **unchanged** (ticket-28 sections; no activation row, actions,
deliverables, or footer). Self-positioned top-right of the frame per seam 1
(no geometry/anchor API; pointer events inherited through the
`display:contents` anchor; no backdrop, so everything outside the chip/card
stays click-through). CSS is `multitask-dispatcher-capsule`-prefixed and
static — the client face's only animation remains the panel's running ring.
The staleness recheck interval is armed at capsule level too, so a fresh
snapshot ages into the `error` dot without a push.

**Wiring** (`src/client/index.ts`): still exactly ONE `shell.overlay` entry,
unchanged id `multitask-dispatcher-roster`, order −10 — only the registered
component changes; `applyClientModule(ctx, store, capsule = createCapsuleStore())`
keeps the old two-argument call signature working.

**Locale** (`src/client/overlay.ts`): seven keys added to BOTH faces —
`capsule.chip.open`, `capsule.chip.workers` and `capsule.chip.wake` ({count}
templates), `capsule.collapse`, `capsule.dot.dormant`/`.active`/`.error`.
`validateLocaleDictionary` returns `[]`; the exact-key-list assertion in
`client-face-scaffold.test.ts` was updated to the new 32-key set (identical
en/zh).

**Offline tests** (new `test/client-capsule-chip.test.ts`, 18 tests): dot-state
mapping over all store kinds + the staleness boundary (exactly-at-window stays
fresh); fresh empty snapshot stays active at zero; wake-badge counting
(settled-only, delivered excluded, unsettled running never counts, blocked-
unsettled does not inflate) and the 0-hides / N-shows-exact threshold;
expansion-store transition table including no-op identity and the subscribe
disposer; registration identity (options deep-equal the unchanged builder,
exactly one entry, HMR teardown/re-apply); locale + CSS contracts (namespaced
classes, animation-free). `client-roster-panel.test.ts` passes untouched.
`composition-polish.test.ts` extended mechanically: capsule keys joined the
"every locale key the client code can request resolves" list, and
`capsule.tsx` joined the no-hard-coded-copy sweep (its CSS-strip regex
generalized from `ROSTER_PANEL_CSS` to any `*_CSS` const).

**Gates** (worktree, all green): `npm test` **630 pass / 0 fail** (167
suites) — the delta over the ticket-32 baseline is exactly the 18 new tests;
the pre-existing suites pass with only the mechanical extensions noted above.
`npm run typecheck` clean (both configs). `npm run build:client` writes
`client/index.js` (42557 bytes); the in-suite esbuild contract test is green.
Offline verification only — the browser assertion stays with ticket 33.
S7 identifier scan over the touched files: no `sand` / `executor` /
`MessageSubagent` / `SAND_MULTITASK_` hits.

**Deliberately not done here** (recorded for the epic owner): ADR-0013's
"bounded follow-up for ticket 38" — wiring `ctx.slots.onEntryError` to
log/flag a crashing (abdicated) capsule entry — is not among this ticket's
Requirements or Acceptance criteria, so it was not implemented; it needs a
small `ClientContext` seam addition and a supervision effect, and should ride
a follow-up ticket or be folded into 39–42 wiring explicitly.

### 2026-09-18 — resolved

Resolved by overnight sweep: offline ACs verified (independent verifier PASS); implementation on clone/always-on-dispatcher @ 8d907fe. Live browser assertion reserved to ticket 33 / epic 35.
