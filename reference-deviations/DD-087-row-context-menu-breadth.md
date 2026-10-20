# DD-087 — Ten-item row context menu vs one-item Close dispatcher menu
- **Area:** sidebar / roster / agent management (A11)
- **Type:** behavior-delta (mostly downstream of missing features)
- **Date:** 2026-09-23

## What the reference does
Right-clicking a roster row opens a wide per-agent context menu assembled by
the row-actions component from a model of conditional actions: an entry to edit the
agent's profile, one to view the full conversation, one to show the agent's
async tasks, a move-to-section submenu listing the agent's sections plus a
new-section creator, pin/unpin, mark as read/unread, duplicate agent, copy
conversation ID, hide from sidebar, and delete. The menu's content is
projected from state — pin state, read/unread state, hidden state, and which
section the agent currently sits in all shape the labels (`agent-row-actions-model.ts`
builds the action list from flags for unread, pinned, and hidden state, and
the component projects the available sections and the current section id into the submenu).

## What the current build does
The dispatcher shell has a right-click context menu on roster rows only
(ticket 106), and it contains exactly one item: "Close dispatcher", armed
with the same two-press confirmation discipline (`shellDeletePress`) and
using the same `/dispatcher-stop` path as delete — one transport, no
optimistic flip. Menu placement is clamped to the viewport
(`clampRowMenuPosition`). Everything else a row exposes appears on hover and is
limited to copy-session-id (ticket 70's affordance for addressing a peer) and the
delete/close control. The shell stays presentation-only: it gates and routes
clicks to host functions; it invents no new capability.

## The deviation
The reference menu is a ten-item feature surface; the build menu is a
one-item lifecycle control. The gap is real but almost entirely downstream of
features the build does not have: profiles, full-conversation view, an async
tasks view, sections (and any move-to-section model), pinning, hidden chats,
and duplicate-agent all lack host support in the dispatcher — there is nothing
for those items to invoke. Two items are near-standalone: copy-conversation-id
already exists in the build as the hover copy-session-id affordance (same
intent, different surface and name); mark-unread has no counterpart because
the host has no unread concept the shell could toggle (unread stays read-only,
never written, per ticket 27's honesty rule).

## Verdict: ADAPT
ADR-0018's master rule is to imitate the reference in its entirety except an
enumerated exception list, so the breadth gap is nominally owed — but nearly
every missing item requires a feature (sections, profiles, hidden chats, an
async-tasks surface, duplicate) that has no host support today, and building the
menu alone would violate the shell's presentation-only contract by shipping
entries that cannot work. The one genuinely incorporable item, copy-conversation-id, is
already satisfied by the hover copy-session-id affordance (ticket 70), so
menu duplication is optional polish, not a gap; mark-unread is blocked by the
absent host unread concept. Treat this DD as the standing record that the
menu grows as its underlying features land, each new item using an existing
host function — do not open a ticket just for matching the reference menu in the abstract.

## Incorporation notes
- **Where it would live:** the row context menu in `src/client/shell.tsx`
  (item list + `clampRowMenuPosition` handling), with any menu-item model
  alongside the row-view logic in `src/client/shell-store.ts`; each future
  item must route to an existing host function or verified transport, never a new
  shell-side behavior.
- **Constraints:** presentation-only shell (no spawning/steering/sending from
  the menu beyond existing host functions); ADR-0021's one-transport discipline for
  session lifecycle (close items go through `/dispatcher-stop` only); ADR-0018's
  exception list governs what stays omitted; mark-unread needs host unread
  support first (read-only attention rule, ticket 27); sections/profiles/
  hidden-chat/duplicate items wait on those features existing at all.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S for relocating copy-session-id into the menu (surface
  change only); M+ for anything else, and only after the underlying feature
  exists — the menu itself is trivial, the missing host support is not.
- **Key reference anchors:**
  - `the reference tree's frontend/src/production/AgentRowActions.tsx` — component: conditional
    items (profile edit, full conversation, async tasks), a move-to-section
    submenu with a new-section creator, handlers wired per action (~lines 45–95).
  - `the reference tree's frontend/src/production/agent-row-actions-model.ts` — action-list model
    projected from unread/pinned/hidden plus copy/delete flags.
- Menu item labels above are given by role, not transcribed from the reference UI.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/AgentRowActions.tsx` (verified: the edit-profile item at line 74; a move-to-section submenu with a new-section creator at lines 80–82; duplicate/copy-conversation-id/mark-unread/pin/hide flags in props at line 45); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/agent-row-actions-model.ts`
- Build: `src/client/shell.tsx` (verified: ticket-106 header comment — one item "Close dispatcher", two-press armed, `/dispatcher-stop` route, lines 53–57; `clampRowMenuPosition` at lines 158 and 748); `src/client/shell-store.ts` (`shellDeletePress`, delete arm state); ticket 106
