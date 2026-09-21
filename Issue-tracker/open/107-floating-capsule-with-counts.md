# 107 — Replace the plain launcher chip with a floating capsule showing [dispatcher count | running workers]

**Status:** open
**Labels:** ready-for-agent
**Related:** 102 (resolved — in-window affordances), 103 (resolved — the per-event-delta drag pattern to reuse), ADR-0021 (accepted — partially superseded by ADR-0022), ADR-0022 (human-ruled 2026-09-22 — the ruling this ticket implements), ADR-0010 (mirror honesty — where the counts come from)

## Problem

The human requests (2026-09-22, in-session, verbatim): *"current window collapses at top left [dispatcher] button, change to a floating capsule instead [No. of dispatcher | number of running workers]"*.

Today the collapsed state is a plain chip — `createLauncherChip` (`src/client/floating-window.tsx:331-354`), label key `launcher.chip.label` (en "Dispatchers", `src/client/overlay.ts:330`; zh "调度台", `overlay.ts:485`), deliberately "launch affordance ONLY — no presence counters" (module comment `floating-window.tsx:4-12`, chip comment `:324-329`, locale comments `overlay.ts:324-329` en / `overlay.ts:480-484` zh).

**The ADR situation, stated explicitly:** accepted, human-ruled ADR-0021 (`docs/adr/0021-addon-coexistence-floating-dispatcher-window.md`) records in its Consequences: "The capsule itself stays retired — the floating window is not a capsule revival: it hosts the whole dispatcher shell, not a collapsed chip". The human's 2026-09-22 explicit request is authority-stack level 1 (human override, dated, spoken/recorded) and sits ABOVE accepted ADRs; per the ADR-0021 precedent (a dated human ruling recorded as a human-ruled ADR), the ruling is recorded as **ADR-0022** (`docs/adr/0022-floating-capsule-revived-by-human-ruling.md`), which supersedes ADR-0021's capsule-retirement clause in part. The anti-revival clause ("a new ticket with its own evidence, not a revival" — recorded on cancelled ticket 73 and echoed in ADR-0021's Consequences) is satisfied: this ticket is the new ticket, and its evidence is the human's dated verbatim ruling quoted above. Cancelled ticket 66 was the capsule-era home of the same collapsed-chip-shows-counts request.

## What to do

- [ ] Replace the chip with a floating, draggable capsule showing the dispatcher count and the running-workers count (e.g. "2 | 3") with an accessible label. The capsule keeps the LAUNCHER role — toggle the floating window open/close, `aria-pressed` — per ADR-0021 decision 2: this changes the chip's SHAPE and CONTENT, not the launch seam (`LAUNCHER_ENTRY_ID`, `src/client/overlay.ts:52`; `LAUNCHER_OVERLAY_ORDER` −10, `:61` — both stay).
- [ ] Counts derive from the client mirror store: dispatcher count = mirrors with kind `"snapshot"` (`src/client/shell-store.ts:114-131`), running workers = the sum of `describePresence(snapshot).working` over those snapshots (`shell-store.ts:145-160`), respecting the staleness rule (`ROSTER_STALE_WINDOW_MS`, used by `view()` at `shell-store.ts:234-250`) so stale snapshots do not count as live. Derive it as a PURE function so it can be pinned offline.
- [ ] Close the wiring gap: `createLauncherChip` currently receives only (t, store, content) — the composition at `src/client/index.ts:516-533` must pass the shell store (`mount.store`) or a derived counter in.
- [ ] Drag reuses the per-event-delta pattern (`beginDrag`, `floating-window.tsx:265-287`; contract pinned at `test/client-floating-window.test.ts:674-748`) against the capsule's own position state — in-memory like the window's x/y (no persistence unless trivially free).
- [ ] The chip-text pin at `test/client-floating-window.test.ts:539` (chip text == `launcher.chip.label`) is deliberately broken and replaced with counts pins; en+zh lockstep for any aria/title copy (e.g. aria-label "N dispatchers, M workers running" / the zh equivalent; `validateLocaleDictionary`, `overlay.ts:507-540`, enforces identical key sets).
- [ ] Offline pins for the counter derivation (pure function: snapshots count, stale excluded, working sums) and the capsule drag.
- [ ] `client/index.js` is a build artifact — run `npm run build:client` and include the regenerated file if tracked-git shows it changes.

## Constraints

- Token-only CSS; `multitask-dispatcher-` class discipline; no animation.
- No new host seams, no invented push channels — counts come from the existing mirror feed; no optimistic flips (ADR-0010 honesty: the mirrors are the truth, honest mirror lag allowed).
- Do not reintroduce the glossary avoid-word "bot" outside verbatim human quotes.
- The floating window remains the whole dispatcher shell (ADR-0022 decision 3) — the capsule is not a second shell.
- en+zh locale lockstep for every new user-visible string.

## Comments

### 2026-09-22 — scribe session

Filed from the human's in-session request of 2026-09-22 (quoted verbatim in Problem). **ADR-0022 records the ruling**: the human's level-1 dated override supersedes ADR-0021's capsule-retirement clause in part, so this ticket implements recorded authority rather than conflicting with it — the ticket cites ADR-0022 in Related for that reason. The scribe pass verified the cited facts by code reading only (no implementation): the chip renders only the static label, the composition passes it no shell store, and the mirror store already carries everything the counts need (snapshot kind, presence summary, stale window). The launch seam, the floating window's crash isolation, and the add/delete affordances are all untouched by this ticket. Labelled ready-for-agent: the behavior is fully specified by the ruling plus the existing patterns.
