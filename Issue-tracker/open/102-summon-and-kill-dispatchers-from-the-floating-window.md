# 102 — Summon/kill dispatcher affordances reported unusable in the floating window (live) + reference research

**Status:** open
**Labels:** ready-for-agent
**Related:** ADR-0021 (decisions 2–4 — the floating window and the add/delete ruling), ADR-0013 (the one-overlay-entry seam posture), 101 (resolved — the add/delete affordances shipped), 100 (resolved — the floating window + launcher), 89 (resolved — the capsule stays retired)

## Problem

The human reports (2026-09-21, live use, verbatim): *"still no way to summon new dispatcher/kill old ones in our floating window - may need to research the reference more on how they deal with it."*

Vocabulary: the human's "summon new dispatcher" = add/activate a dispatcher session (ticket 101's add affordance, `/dispatcher-start`); "kill old ones" = delete/deactivate one (`/dispatcher-stop`, binding off, chat untouched).

On paper the affordances should already be in the window — the code says so:

- `mountShellPage` builds the `ShellHosts` with BOTH seats unconditionally (`onAddDispatcherSession` → `/dispatcher-start`, `onDeleteDispatcherSession` → `/dispatcher-stop`, one command transport — `src/client/index.ts`, the hosts block; ticket 101).
- The floating-window launcher inject mounts the shell through that same `mountShellPage` and renders `createDispatcherShell(t, mount.store, mount.hosts)` (`src/client/index.ts`, the `SHELL_OVERLAY_SLOT` inject) — the window hosts the WHOLE shell, seats included (ticket 100, ADR-0021 decision 4).
- `AddDispatcherSection` renders whenever the add seat is defined, and the per-row delete affordance rides every roster row (`src/client/shell.tsx`).

So the live report CONTRADICTS the code reading. That contradiction is this ticket's opening puzzle: something makes the affordances absent, invisible, or dead in the real floating window, and it must be found before anything is rebuilt.

## What to do

- [ ] Live repro first (read `read-before-running-live-and-browser-tests.md` before anything live; kill timers mandatory at launch; send only trivial tasks; testing artifacts under `.scratch/testing/<yyyy-mm-dd>-<slug>/`, created before the session starts — never on the Desktop): boot real dsh, open the floating window, and attempt add + delete from inside it. Record exactly what is visible and clickable, and what happens.
- [ ] Diagnose the contradiction. Candidates, in order of cheapness: (a) the live client predates ticket 101 (both shipped 2026-09-20; a stale build explains everything) — check the running bundle first; (b) the affordances render but are undiscoverable or clipped in the fixed 760×520 window (sidebar column overflow, the add section below the fold, pane crowding); (c) they render but fail in-window (portal z-order/pointer-events, the armed two-step delete confirm window); (d) an empty-roster state hides the entry points. Record the finding in a comment here.
- [ ] Reference research (the human's explicit ask): read `read-before-reference-tree-work.md` first — the reference tree is read-only evidence. Establish how the reference deals with summoning/killing dispatchers from ITS floating window, if it does; record findings under `docs/research/` per its conventions and cite them here.
- [ ] Close the gap per the findings: summon/kill must be usable AND discoverable in the floating window. If the finding is a defect (present-but-broken/hidden), repair it. If it needs MORE than a defect repair — e.g. dedicated window-chrome summon/kill controls instead of the shell seats — that is a design decision: propose an ADR first (the authority stack puts accepted ADRs above this ticket) and do not move until signed.
- [ ] Offline tests pin the outcome in the existing rendered suites (`test/client-floating-window.test.ts`, `test/client-session-management.test.ts`); any new copy in BOTH locales (en+zh lockstep), token-only CSS, no new host seams.

## Constraints

- ADR-0021 decision 3 semantics carry unchanged: add = `/dispatcher-start` in the chosen session; delete = `/dispatcher-stop` (deactivates the dispatcher binding; NEVER disposes the dsh chat; reversible). The U-G amendment covers dispatcher sessions ONLY — no worker create/delete/manage affordances appear through this work (resolved 68's boundary stands).
- ONE command transport (`ctx.remote.commands.execute(sessionId, line, [])`); the mirrors are the truth — no optimistic add/delete flips (ADR-0010 honesty; honest mirror lag allowed).
- No new host seams, no invented push channels; the overlay layer keeps exactly one entry of ours (the launcher, ADR-0013 posture).
- Re-host, don't rebuild (ADR-0021 decision 4); the capsule stays retired (resolved 89 — no collapsed-chip revival).

## Comments

### 2026-09-21 — scribe session

Filed from the human's live-use report above. Scribe pass verified only by code reading — no implementation, no live run, no reference access: the three code cites in Problem are the whole of what was checked, and they say the seats exist in the window's shell. The deliberate structure of this ticket is diagnose-then-build: the implementing team must NOT add a second affordance path before explaining why the first one did not show up live — the most likely explanations (stale build, discoverability in the fixed-size window) are cheaper than any redesign and change what the right fix is. Ticket 101's own live-pass residue (confirm the delete affordance deactivates the real binding; the add picker's `/dispatcher-start` lands in the chosen chat) is absorbed by this ticket's live repro step — it is the same evidence, now urgent because the human reports the surfaces missing outright.
