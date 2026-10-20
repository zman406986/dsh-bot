# DD-086 — User-defined sidebar sections vs fixed dispatcher partition
- **Area:** sidebar / roster / agent management (A11)
- **Type:** deliberate-divergence (grouping model ruled)
- **Date:** 2026-09-23

## What the reference does
The reference sidebar lets the user create named, durable sections of the roster and arrange chats into them. Section records live in an account-scoped, host-durable settings slice (the sidebar-sections storage key, flagged account-sensitive), managed by a dedicated state store with optimistic ordering, fencing against stale generations, write-failure recovery with an explicit client error code, restore/reset/disposal, and reload on reconnect and host-settings events (`sidebar-sections-state.ts` module comment and slice/export block). The store exposes commands to rename, remove, create (with an initial agent set), assign agents, and move a section before/after another; non-synthetic sections report move-up/move-down action state.

Projection turns the stored records into the visible model (`sidebar-section-projection.ts`): agents not pinned are bucketed by membership map, and every unassigned agent falls into a synthetic trailing section (a reserved catch-all id, with a display name for unassigned agents) that is locked, filtered out when empty, and never movable. Section headers carry a live count, folded/collapsed flag, and aria-expanded state; per-section collapse is persisted on the section record. Empty non-synthetic sections render a body hint inviting the user to drop chats in (paraphrased), and the sidebar supports dragging chats into sections.

## What the current build does
The build's sidebar has exactly one grouping: the dispatcher/non-dispatcher partition derived from per-session mirror flags, recorded under ADR-0019/ADR-0020 (`src/client/shell-store.ts` module comments: the roster is the sessions map plus a single dispatcher partition; mirrors are the activation authority and never invent rows). The bottom "Add" section (`AddDispatcherSection`, `src/client/shell.tsx`, ticket 101 / ADR-0021 decision 3) is a session-lifecycle control — a toggle revealing a picker of activatable non-dispatcher sessions, with honest guidance when nothing is available — not a grouping surface. There are no user-created sections, no rename or reorder commands, no drag targets, no per-section collapse persistence, and no durable section slice.

## The deviation
The reference treats sidebar grouping as user-owned durable data (create/rename/move/assign, persisted per account with failure recovery); the build treats grouping as a fixed system model (dispatcher vs non-dispatcher, derived from mirror state with no user-authored grouping at all). Beyond the missing create/rename/move/assign controls, the underlying capability gap is a durable, account-scoped settings slice for section records plus projection and interaction affordances (collapse persistence, counts, drop targets) that the build's store and shell simply do not have.

## Verdict: ASK-HUMAN
ADR-0019/ADR-0020 record the mirror-derived dispatcher/non-dispatcher partition as *the* sidebar grouping model, and ADR-0021 fixed the Add picker as lifecycle-only — so user-defined sections are not a gap by accident; they are outside the recorded model. Adopting them would require a human ruling that supersede or extend those ADRs, plus a decision about where section records persist (a new account-scoped slice in the settings document the mirrors already travel through). Do not build ahead of that ruling; the fixed partition stands until then.

## Incorporation notes
- **Where it would live:** a `sidebar-sections` state module beside `src/client/shell-store.ts` (own slice in the settings document, applied the way `applySessionMirror` is), projection helpers for the roster view, and section headers/drop targets in `src/client/shell.tsx` as separate components under the ticket-88 rule that each component owns its own hooks.
- **Constraints:** sections must stay presentation-only — the sessions feed remains the row authority and mirrors remain the activation authority, so section membership can reorder but never invent or hide roster rows; synthetic catch-all section must remain locked and last; a failed write surfaces as a client-boundary error; account scoping required (per ADR-0019 keying).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — new durable slice + store + projection + drag/rename/collapse UI is a real slice of work, but mechanically well-precedented; the actual risk is at the ruling level, not the engineering level.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar-sections-state.ts` — durable slice constants, write-failure code, command set, action-state helper
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar-section-projection.ts` — synthetic catch-all, projection, header metadata
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar.tsx` — rendered headers, collapse, drag-in, empty-section hint (per enumeration)
- **Blockers:** needs a human ruling amending/extending ADR-0019/ADR-0020 (and touching ADR-0021 decision 3's lifecycle-only reading of the Add picker) before any implementation.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/sidebar-sections-state.ts`; same tree `.../sidebar-section-projection.ts` (both read and verified; sidebar.tsx cited from enumeration, not re-verified)
- Build: `src/client/shell-store.ts` (module comments lines 1–50, dispatcher partition and mirror authority); `src/client/shell.tsx` (`AddDispatcherSection` at line 493 — toggle + activatable-session picker only)
