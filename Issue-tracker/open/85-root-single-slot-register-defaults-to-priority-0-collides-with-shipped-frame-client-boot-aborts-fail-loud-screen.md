# 85 — Cutover's `root` registration passes no priority: the host single-slot register defaults to priority 0, collides with the shipped AppFrame, and the WHOLE loader entry aborts (fail-loud screen; no client at all)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 78 (the cutover slice this breaks — its live ACs), 84 (the inject declarations — those part worked), 33 (live close-out), 34 (the fail-loud `assertEntriesActive` behavior)

## Symptom (live, cited)

Live pass 3, 2026-09-19 (`C:\Users\TZhen\Desktop\dsh-live-pass3-2026-09-19\`, outside
the repo), throwaway `multitask` profile boot, host 0.1.5-rc.1, HEAD `c437ee8` rebuilt
in place (client bundle 138,259 bytes — the post-cutover size, not stale), port 8876:

- The page renders the host's FAIL-LOUD screen, not the app and not a blank window
  (`shots/01-boot-blank-or-not.png`, persisted 17,977 bytes, re-verified on disk):

```
HARNESS
Failed to load plugins
dsh-multitask-dispatcher
failed to apply loader entry 17cf1d83 (dsh-multitask-dispatcher): single slot
"root" already has a registration at priority 0 (registered by Ba)
— register at a different priority to shadow it (lowest renders)
```

- The same text is the session's ONLY console error (`driver-status-final.json`).
  Zero `without inject` pageerrors — ticket 84's declared/wrapped injects did their
  job; the module factory ran and threw LATER, at the slot registration.
- Scope of the abort: the ENTIRE loader entry fails → no shell, no dispatcher
  faces, AND no stock app (no composer, no sidebar — `textarea` count 0, nav
  count 0, every `multitask-dispatcher` class count 0). The stock app does NOT
  take over: the failsafe never gets a chance because the registration throw
  kills the entry before the election exists.
- The boot graph itself is correct: the served page's `__DSH_BOOT__` carries
  `{"id":"dsh-multitask-dispatcher","url":"/plugins/??dsh-multitask-dispatcher/client.js&rev=…-48",
  "inject":[renderer, locale],"external":["react","react/jsx-runtime"]}`
  (`served-html.html`) — the graph row and bundle-arrival list are as designed.

## Root cause (cited)

`shellRootRegistration()` (`src/client/shell-mount.ts:241-245`) returns
`{name: "root", locale}` — **no `priority`**. The live composition
(`src/client/index.ts:409-419`) calls `ctx.slots.register(shellRootRegistration(), …)`
with that shape. The host's single-slot `root` register treats a registration
without an explicit priority as priority 0 — the same value the shipped AppFrame
already holds — and THROWS instead of shadowing. The throw aborts the loader
entry apply, and the client's fail-loud path (the `assertEntriesActive` behavior
ticket 34 documented) replaces the whole UI with "Failed to load plugins".

The model constant `SHELL_ROOT_DYNAMIC_PRIORITY = 1` exists
(`src/client/shell-mount.ts:208`) and `shellCellWinner` pins the intended
election — but the constant is never passed through to the live `register` call.
Ticket 78's cutover comment reasoned "The priority field is host-assigned
('A later registration receives a lower priority.' …) — the model constant stays
as the relative-order contract only". That host citation does not hold for the
`root` single slot live: the host's own error message says the caller must pick
a different priority ("register at a different priority to shadow it (lowest
renders)"). Offline fakes accepted the no-priority shape, so this passed the
1,016-test gate and only bites on the real host — the same fake-taught-us-a-
wrong-contract class as tickets 44/45/84.

## Requirements (fix direction; final call belongs to the implementer)

1. Pass the shadowing priority on the live `root` register (thread
   `SHELL_ROOT_DYNAMIC_PRIORITY` — or whatever value the host source dictates —
   into `shellRootRegistration()`'s returned options so `ctx.slots.register`
   receives it). Read the host's single-slot register + cell-election source for
   the exact direction ("lowest renders" per the error text) before picking the
   value; cite it in the ticket comment.
2. Model the collision offline: the fake single-slot register must THROW on a
   second registration at an already-held priority unless a different explicit
   priority is passed — so a no-priority regression fails without a live host
   (the 84 lesson, again).
3. No changes to the election model, retirement slice, or 84's inject
   declarations.

## Acceptance criteria

- [x] (offline, gate) fakes throw on the colliding no-priority register; the
      registration carries the explicit shadowing priority; `npm test`,
      `npm run typecheck`, `npm run build:client` green.
- [ ] (live, ZERO LLM calls) on a real profile boot the client loads past the
      plugin stage: `[data-shell="dispatcher"]` present, the shipped app is NOT
      rendered in its place (the election took the cell), zero pageerrors.

## Notes

- Found by live pass 3 (the 78 cutover's dedicated confirmation pass); no product
  files changed during the pass. Evidence directory contents listed in its README.
- Pass-3 profile-boot trap worth keeping in the recipe: `dsh plugin --profile X
  add` alone creates a profile WITHOUT the `@deepseek-ai/dsh-web-app` bundle; the
  boot then sits silent forever and never binds the port. Seed the profile from
  the web default (pass-2 recipe) or add the bundle before boot.

## Comments

- **2026-09-19 (live pass 3, filing agent)** — 45/44's AC3 flow was NOT attempted
  past the failure: the composer does not exist on the fail-loud screen, and 44
  AC3's first clause (composer interception) is untestable without it. Zero LLM
  traffic was used, per the one-flow budget rule. 78/84/68's live ACs are blocked
  by this ticket, each recorded in its own file.
- **2026-09-19 (agent, fix landed `a2c09ed`)** — offline AC ticked; the live AC
  stays open for live pass 4 (zero LLM calls). Host semantics VERIFIED by
  reading the installed 0.1.5-rc.1 client read-only — the exact rule:
  - **The registry** (shipped web frontend, `dsh-web-frontend
    dist/assets/index-BKQ_L1z6.js`, SlotCore.register — minified, cited by
    code): `a = t.priority ?? 0` — an ABSENT priority defaults to 0. Single
    slot: `entries.find(g => (g.options.priority ?? 0) === a)` — found →
    THROW `single slot "root" already has a registration at priority 0 … —
    register at a different priority to shadow it (lowest renders)` (the live
    error, verbatim). Keyed/list analogues throw on same (key|id, priority).
    Insert keeps entries sorted ASCENDING by `(priority ?? 0)` (stable for
    ties); `entriesOfSlot` walks that order skipping abdicated entries and
    takes the first live one — the LOWEST value renders (also
    `dsh-client-ui-renderer/lib/types/client/registry.d.ts:156-164`). The
    per-entry dispose removes the entry (unload/abdication restores the next
    survivor).
  - **No auto-allocation in the browser**: the frontend bundle contains no
    `allocatePriority`/`nextPriority` anywhere — caller options reach the
    registry UNCHANGED. The runner-side allocator (`nextPriority = 0`,
    `allocatePriority: () => --this.nextPriority`,
    dsh-cordis-client-runner `lib/client.js:384, 606`, first dynamic slot
    allocation = **-1**) does NOT apply to loader-entry client modules — the
    live registration arrived at priority 0, proving the pass-through.
  - **The shipped frame holds 0**: ui-layout registers
    `{name: "root", locale: "common", children, store}` with NO priority
    (`lib/client.js:524-531`) → `?? 0`. `registry.d.ts:24-27`'s "a
    dynamically registered entry is assigned a lower priority" describes the
    OUTCOME; 0.1.5-rc.1 leaves the assignment to the caller.
  - **Chosen value: `SHELL_ROOT_DYNAMIC_PRIORITY = -1`** (was the
    never-sent model constant `1` — wrong direction): below the frame's 0 →
    wins the ascending election; cannot collide with 0; equals the host
    runner's own first dynamic allocation, so it matches the idiom the host
    would have assigned. `shellRootRegistration()` now returns
    `{name, locale, priority: -1}`; `SingleSlotRegistrationOptions`
    (context.ts) makes `priority` REQUIRED.
- **2026-09-19 (agent, fix landed `a2c09ed`)** — what changed:
  - `src/client/shell-mount.ts`: constant flipped to -1 with the verified
    citations; priority threaded onto the registration options; stale
    "host-assigned" docs corrected.
  - `src/client/index.ts`: the cutover comment's wrong "priority field is
    host-assigned" reasoning replaced with the verified rule.
  - Fakes (`test/client-shell-mount.test.ts` createMountCtx,
    `test/coexistence.test.ts` createClientCtx): the slots fake now models
    SlotCore — one global cell per slot name, `?? 0` default, same-priority
    throw per identity axis (single/keyed/list) with the host's wording,
    insert-time ascending stable sort, per-entry dispose run by the inject
    controller on fiber teardown (cell freed on unload/HMR). New tests: the
    no-priority root register THROWS (the live crash, offline), an explicit
    same-priority throws, a different priority shadows, our -1 seeds the cell
    ahead of the frame's 0 and `shellCellWinner` agrees with the host scan,
    teardown frees the cell and re-apply registers cleanly; the pure-model
    fixtures now use the VERIFIED shipped-frame priority 0 (was a guessed
    10). No changes to the election model, retirement slice, or 84's inject
    declarations (Requirement 3).
  - Gates: `npm test` 1056 pass / 0 fail, `npm run typecheck` green,
    `npm run build:client` green (client/index.js 159,060 bytes).
  - Gate repair, disclosed: HEAD `9bcdd4d` (ticket 69 chunk B, another
    agent's concurrent commit) shipped an `exactOptionalPropertyTypes` error
    in `approval-cards.ts:378` that red-ed `npm run typecheck` tree-wide;
    `a2c09ed` carries the minimal call-site fix (conditional spreads,
    runtime-identical).
  - Tracker add-on: filed **86** (needs-triage) — "Fake-vs-host client
    contract gaps (44/45/84/85 class)" proposing the fake-alignment hygiene
    pass; NOT executed here.
- **2026-09-19 (agent, conservative live-AC note for pass 4)** — residual
  uncertainty: the collision/election rule is cited from the MINIFIED
  frontend bundle (no separate `dsh-client-ui-slots` package is installed),
  matched verbatim against the live error text, so confidence is high; the
  unverified remainder is live-only by nature — that the -1 entry actually
  takes the cell at boot (no ordering surprise from the host's own
  boot-time registrants), that HMR re-apply re-registers -1 without a stale
  collision on the real fiber cascade, and that a render crash abdicates to
  the stock frame. Pass 4 should confirm the AC as written: dispatcher shell
  present, stock app NOT rendered, zero pageerrors.
