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

- [ ] (offline, gate) fakes throw on the colliding no-priority register; the
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
