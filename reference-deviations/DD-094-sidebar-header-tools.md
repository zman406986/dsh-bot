# DD-094 — Sidebar header tool cluster vs static title + add picker
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature (mostly a consequence of other gaps)
- **Date:** 2026-09-23

## What the reference does

The agent sidebar's top edge is a tool row, not a label. A header component
(the agent-sidebar header) renders, when the sidebar is expanded, a megaphone
button that broadcasts a message to all agents, a button that opens the
org-chart/network view (wired through a shared network-trigger constant), and
a plus button that starts a new chat (collapsed-rail variant turns it into a
circle icon). Directly below the header sits a search button that opens the
already-mounted command palette immediately, with no asynchronous waiting. The
button component holds only the button and the keyboard behavior; the shared
top-level state decides where the palette opens (per the file's own
description, the button has no async subscription of its own). During multi-agent selection the entire header is swapped for a bulk
actions row (move-to-section menu, delete, clear selection), so the tools and
the bulk controls share one slot.

## What the current build does

The sidebar's header is a static localized title string rendered in a plain
div. The only creation/management affordance is a separate sticky-bottom
section: an "Add dispatcher" toggle that expands a picker of activatable
sessions (feed-delivered rows the mirrors do not flag as dispatchers), per
ticket 101 / ADR-0021 decision 3. The picker deliberately has no client-side
way to create a chat — when no candidates exist it shows plain empty-state
guidance (create the chat in dsh first). There are no search, new-chat,
broadcast, or network buttons anywhere in the shell.

## The deviation

The reference packs four header tools (broadcast, network, new chat, search)
plus a multi-select swap into the sidebar header; the build has a title and a
bottom-anchored add picker. Each reference tool is either already ruled on or
out of scope: search targets the command palette the build does not have
(DD-019, DO-NOT-INCORPORATE); the network button opens the org-chart surface
ruled out in DD-093 (DO-NOT-INCORPORATE); broadcast-to-all-agents presumes a mass-messaging capability the dispatcher
client does not expose (peer messaging is a PRD non-goal / Phase-2 territory).
The new-chat action is the one real counterpart, and the build already covers
that need in a narrower form that refuses to fake what the host cannot do: the
Add-dispatcher picker activates sessions that exist in dsh rather than
fabricating new chats client-side.

## Verdict: DO-NOT-INCORPORATE

Nothing in this cluster survives the project's precedence order as an action item.
Search and network depend on explicit rulings (DD-019, DD-093, both
DO-NOT-INCORPORATE) and only return if those are reversed; broadcast implies
a send-to-all capability the PRD keeps out of scope, so it would need a human
ruling before any work. The new-chat action is already incorporated by design as the
ADR-0021 Add-dispatcher picker — narrower on purpose (activation of existing
dsh sessions, no client-side creation), and re-widening it to match the
reference would contradict that recorded decision. The multi-select header
swap is likewise covered by the build's own row-menu/state model and is not
an independent gap.

## Incorporation notes
- **Where it would live:** if ever revived, the search trigger would hang off
  the sidebar header only after DD-019 is reversed (palette must exist to be
  opened); "new chat" already lives in the sticky-bottom AddDispatcherSection
  and should stay there per ADR-0021.
- **Constraints:** no verbatim reference UI copy or icon/label strings; any
  broadcast feature requires a PRD amendment first (peer messaging non-goal);
  add-picker rule (never simulate a create-chat path the host does not have) must not be
  weakened.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — no action recommended; re-open cost is only relevant
  if DD-019/DD-093 are reversed, and broadcast is M/L plus a scope ruling.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar.tsx` —
    the agent-sidebar header component (broadcast megaphone, network trigger,
    new-chat plus button), sibling search button, and the selection-actions header swap.
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar-search-trigger.ts` —
    synchronous open of the already-mounted command palette; keyboard
    activation contract.

## Evidence
- Reference:
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/sidebar.tsx`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/sidebar-search-trigger.ts`
- Build:
  - `src/client/shell.tsx` (static `shell.title` header div; `AddDispatcherSection` toggle + activatable-session picker, ticket 101 / ADR-0021 decision 3)
- Cross-refs: `reference-deviations/DD-019-command-palette-absent.md` (search → palette, DO-NOT-INCORPORATE), `reference-deviations/DD-093-org-chart-network.md` (network button, DO-NOT-INCORPORATE)
