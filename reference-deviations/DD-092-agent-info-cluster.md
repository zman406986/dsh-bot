# DD-092 — Per-agent info surfaces (profile/channels/members/tasks) vs none
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature (sits close to an existing ruling)
- **Date:** 2026-09-23

## What the reference does

The reference ships a whole feature cluster under `the reference tree's frontend/src/recovered/features/agent-info/` with six sub-features: `settings` (an agent profile/settings model with a notify-on-updates toggle saved through a dedicated setter call, and a controller that discards late mutation replies using a generation counter after the selection changes or the object is disposed), plus `avatar-editor`, `channels`, `group-members`, `shared-room`, and `async-tasks`. These surfaces are reachable from the sidebar row menu and open per-agent routes — selecting a row leads to that agent's own info space rather than a single shared transcript pane.

## What the current build does

The build has nothing of this shape. A search of `src/` finds no agent-info concept at all. The right pane in `src/client/shell.tsx` hosts exactly one per-session surface, the roster panel, injected by the factory as `hosts.rosterPanel` (see the `ShellHosts` shape and the `hosted-roster` pane branch); when the host omits it the pane deliberately stays empty. There are no per-agent profile pages, no channels view, no group-members view, no shared-room controller, no async-tasks view, and no avatar editor. Workers in this build have records and sessions, not browsable identities.

## The deviation

The reference treats an agent as a first-class browsable object with its own settings page (including user-facing notification preferences) and per-agent collection views (channels it belongs to, its group members, shared rooms, its async tasks). The build treats agents as internal dispatcher workers: visible only through session rosters, with no identity surface whatsoever. The deviation is a whole missing cluster, and it sits close to a ruling that already covers agent management rather than being a plain UI gap.

## Verdict: ASK-HUMAN

ADR-0018's exception U-G (human-ruled, accepted) says no runtime agent management and names "no agent create/update tools or profiles" — a per-agent profile/settings view for the build's own worker roster sits close enough to that ruling that building one without asking would work around a question the human already decided, and ADR-0017 keeps deviations from the reference needing human approval until signed. The channels, group-members, and shared-room views are more clearly dead ends: those concepts do not exist host-side in this build at all, so they would need both a host model and a UI ruling. Incorporating only an adapted read-only profile view for workers would still be a brand-new client surface (the right pane currently takes only `hosts.rosterPanel`), so the shape, placement, and whether it is wanted at all should go to the human first.

## Incorporation notes
- **Where it would live:** if ruled in, most naturally as another hosted pane in `src/client/shell.tsx` (a sibling slot to `hosts.rosterPanel`, e.g. a per-worker info view keyed by session/worker id), with the worker data drawn from the dispatcher's existing worker records rather than any new host model.
- **Constraints:** ADR-0018 U-G forbids agent create/update tools or profiles at runtime — any profile surface must be read-only or else explicitly ruled again; channels/members/shared-rooms have no host-side counterpart and cannot be ported without inventing host concepts the PRD does not scope; ADR-0017 requires human approval for deviations from the reference until signed.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a read-only worker profile pane is a moderate client surface over existing records, but the risk is mostly about rulings (sitting next to U-G, new surface shape), not implementation; porting the full cluster would be L and is currently unsupported on the host side. (DD number pending for the cross-file sizing follow-ups, if any.)
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/agent-info/settings/model.ts` — profile snapshot state, the notify-on-updates toggle and its setter, a controller that uses a generation counter to discard late replies after selection changes or disposal.
  - `the reference tree's frontend/src/recovered/features/agent-info/settings/view.tsx` and `view.css` — the profile settings surface itself.
  - `the reference tree's frontend/src/recovered/features/agent-info/avatar-editor/`, `channels/`, `group-members/`, `shared-room/`, `async-tasks/` — the remaining per-agent views in the cluster.

## Evidence
- Reference: `the reference tree's frontend/src/recovered/features/agent-info/` (verified subdirectories `settings`, `avatar-editor`, `channels`, `group-members`, `shared-room`, `async-tasks`; verified `settings/model.ts` for the toggle and the generation-counter discard of late replies)
- Build: `src/client/shell.tsx` (ShellHosts `rosterPanel` slot, `hosted-roster` pane branch; repo-wide search of `src/` shows no agent-info/profile/channels surface)
