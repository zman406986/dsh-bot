# DD-093 — Org-chart agent network + inspector vs none
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature (explicitly ruled out)
- **Date:** 2026-09-23

## What the reference does
The reference has a whole org-chart feature: a workspace that derives a graph of agents from roster state, with two edge kinds — membership edges (a group agent linked to each of its members) and message edges (direct communication links) — where each edge carries an activity level computed from the endpoints' recency and mid-turn status, so a link reads as quiet, recently used, or actively in conversation right now (`workspace/model.ts`). Selecting a node opens an inspector side panel: an initial-letter avatar, the agent's description text, a wrap of member chips (capped with a "+N" overflow) for groups, the latest message with a relative timestamp, and actions to jump into the chat or room (`workspace/inspector.tsx`). The workspace is reached from a network button in the sidebar header (`workspace/network-trigger.ts`, wired into the sidebar component).

## What the current build does
The build has none of this. The client surface under `src/client/` contains no graph, no edge model, no inspector, and no network entry point — the shell's third column hosts the existing roster panel, and the sidebar header renders a static styled title rather than a button row (`src/client/shell.tsx`, `src/client/roster-store.ts`). A grep of the shell for network/org-chart/graph/inspector terms returns nothing; agent-to-agent structure is only visible through the roster rows and peer-address plumbing, never as a drawn graph of nodes and links.

## The deviation
The reference presents the agent population as a navigable relationship map with live activity and a per-agent inspector; the build deliberately presents it as a flat roster list. This is not an unimplemented gap but a settled exclusion: ADR-0018's exception list (C14) rules out an org chart for this project, and ADR-0020's area-9 mapping records the same area as "excluded C14" with nothing planned to carry it. The dispatcher's model of agents is intentionally name/address-and-status, not relational.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 (human-ruled, near the top of the precedence order) explicitly names "No org chart" among its exceptions, which settles this without re-opening. Nothing in the PRD or later ADRs reverses it; ADR-0020 reiterates the exclusion for this exact UI area. The roster-panel third column is the approved replacement surface, so the absence of the graph, inspector, and network trigger is conforming behavior, not debt. Re-introducing any part of it (even a read-only network view) would require a new human ruling.

## Incorporation notes
- **Where it would live:** nowhere by default; if a future human ruling ever reverses C14, the natural place would be a shell column mounted alongside the roster panel (`src/client/shell.tsx` mount surface) with graph state in a store next to `roster-store.ts`.
- **Constraints:** C14 bars the org chart (and the group-room membership edges that give it meaning) regardless of how faithfully it is implemented; the roster's privacy rule in `shell.tsx` (names only, no directory) would also conflict with an inspector exposing agent descriptions and last messages. Any revival must go through the human first.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — a graph layout, edge-activity model, inspector panel, and sidebar entry point; irrelevant while C14 stands.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/org-chart/workspace/model.ts` (edge kinds, the three per-edge activity levels), `the reference tree's frontend/src/recovered/features/org-chart/workspace/inspector.tsx` (avatar, description text, member chips, last activity), `the reference tree's frontend/src/recovered/features/org-chart/workspace/network-trigger.ts` (sidebar-header entry, used by `sidebar.tsx`).

## Evidence
- Reference: `frontend/src/recovered/features/org-chart/workspace/model.ts`, `.../workspace/inspector.tsx`, `.../workspace/network-trigger.ts`, `.../workspace/sidebar.tsx`, `.../workspace/graph.tsx` (under the reference tree root `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`)
- Build: `src/client/shell.tsx` (static sidebar title, roster-panel third column), `src/client/roster-store.ts`; absence verified — no org-chart/graph/inspector/network files under `src/client/`
- Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (C14), `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md` (area 9 excluded)
