# DD-085 — Pinned rail with drag reorder vs fixed dispatcher-first order
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference gives users explicit control over roster prominence. A set of pinned agent ids is persisted in an account-scoped preferences slice, seeded from an older storage key so existing users keep their pins across the migration (pinned ids live alongside other remembered sidebar UI state, with a pass that reads the legacy key and cleans it up). The sidebar renders those pinned entries in a dedicated section at the top, ordered exactly as the user arranged them; the model splits agents into pinned and unpinned groups (tolerating duplicates and stale ids) and exposes an explicit move operation that reorders a pinned row relative to a target row, either before or after it. Drag handlers in the sidebar component drive that move, and a pin marker is shown on the row (also surfaced in the agent hover/preview card) so pin state is visible at a glance.

## What the current build does
The build's sidebar has no pin concept at all. `describeShellSidebar` in `src/client/shell-store.ts` derives the roster as ordered rows with dispatcher sessions first, then everything else, each group kept stable in feed-insertion order — deliberately, so a re-render never reshuffles the roster (this stability is asserted by tests). There is no persisted pin state, no pin marker on rows, and no reorder interaction; the store itself is an in-memory map derived from the feed, with no client storage layer.

## The deviation
The build offers no way to keep frequently-used agents visually prominent; ordering is fixed by system rules (dispatcher-first, then arrival order) where the reference offers user-arranged prominence (persisted pins, dedicated rail, drag before/after reorder, visible pin marker). Functionally nothing is lost — every agent remains reachable — but the user affordance is absent.

## Verdict: ADAPT
Adopt the pin concept, not the full reference mechanism. The build's dispatcher-first stable ordering is a deliberate, test-pinned design under ADR-0020's roster rules, so pins should layer on top of it (pinned rows float within their group or as a leading section) rather than replace it, and ADR-0018's dispatcher-centric framing means pinning is a view concern, not a feed/store concern. Matching the reference fully — persisted order with drag reorder — needs a client storage layer the build does not have yet (cross-ref DD-096); the smaller variant is in-session pinning (marker + pinned section + reorder held in memory, lost on reload), which ships the affordance without new storage commitments. Persisted pins can follow once a storage layer exists; if pinning should reorder across the dispatcher/non-dispatcher boundary, that touches settled roster ordering and should go to a human first.

## Incorporation notes
- **Where it would live:** a small view-model layer beside `describeShellSidebar` in `src/client/shell-store.ts` (pin set + partition/move helpers kept pure like the reference model), plus the pin affordance and drag handlers in the shell UI component that renders those rows.
- **Constraints:** keep dispatcher-first grouping intact and preserve the "no reshuffle on re-render" test guarantee; pin state must be keyed by session id (the roster's key, per ADR-0020); tolerate stale ids (pinned session removed from the feed) and duplicates; treat persistence as out of scope until a storage layer lands (DD-096).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S for in-session pinning (pure helpers + marker + one UI interaction); M if drag-and-drop reorder and cross-group moves are wanted; risk is mainly a UX regression in the stable-order tests, plus scope creep toward a storage layer.
- **Key reference anchors:** pinned-id persistence slice and legacy migration in `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar-collapse-state.ts`; pinned/unpinned partition plus before/after move in `the reference tree's frontend/src/production/sidebar-model.ts`; drag handlers in the reference `sidebar.tsx`; pin marker in the reference `sidebar-agent-preview-header.tsx`.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/sidebar-collapse-state.ts` (pinned ids in the persisted slice; the legacy pinned-agents storage key read and cleaned up); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/sidebar-model.ts` (the sidebar-partitioning helper, the pinned-move position type for before/after, and the pinned-move method); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/sidebar.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/sidebar-agent-preview-header.tsx`
- Build: `src/client/shell-store.ts` (`describeShellSidebar`: dispatcher rows first, then the rest, stable feed-insertion order; no pin state anywhere in the store)
