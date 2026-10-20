# DD-088 — Hide-from-sidebar with recovery overlay vs permanent row drop
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference lets the user remove an agent from the visible list without destroying it: a hide action keeps the underlying bot but drops it from the roster display. Two surfaces support recovery:

- A dedicated hidden-chats overlay feature (`the reference tree's frontend/src/recovered/features/hidden-chats/overlay/model.ts`) holds the list of hidden agents and exposes open/unhide/close callbacks; picking a hidden entry closes the overlay first and then opens that agent. A helper for the empty case returns a label when nothing is hidden (paraphrased: "nothing is hidden yet"), and a helper mints per-agent name ids under a dedicated hidden-chat name-id scheme.
- The roster status component (`the reference tree's frontend/src/recovered/features/roster/status.tsx`) distinguishes loading / empty / all-hidden / error states. The all-hidden state renders its own empty message (paraphrased: every bot is currently hidden) with a secondary show-hidden-bots button that opens the overlay.

So nothing in the reference is ever unreachable through the UI: hidden entries remain openable and reversible.

## What the current build does
The build has no hide concept at all. The sidebar is a session feed whose rows are host-owned projections: `removeSessions` in `src/client/shell-store.ts` (interface doc line 475–476, implementation lines 626–637) deletes the dropped ids from the row map and the order list outright, and resets the selection to none when the selected session is among them. The binding in `src/client/shell-feed.ts` (`sync`, lines 108–126) removes every row the live feed no longer lists. Once dropped, the row is gone — there is no hidden set, no recovery surface, and no all-hidden presentation. A grep for hide/hidden across `src/client/` and `client/` finds only unrelated senses (floating-window hide, comments about collapsed-row presentation, overlay flow comments).

## The deviation
The reference treats list removal as reversible view-state with a recovery overlay and an all-hidden fallback state; the build treats it as terminal — a session the host feed drops is erased from the UI with no way to see, unhide, or reopen it from the sidebar. Same trigger (an entry leaves the list), opposite semantics (recoverable vs. permanent).

## Verdict: ADAPT
ADR-0018's imitation rule puts anything not on its exhaustive exception list inside imitation scope, and no exception covers hide-with-recovery — but the exception list does bear on the vehicle: C13 rules out saved/hidden/pinned agent-identity rosters, and the reference's feature lives on exactly such a persistent identity roster, so it cannot be transplanted one-to-one. The behavior should be adapted onto the build's session feed instead: hiding a session row is client-side view-state (a hidden-id set in a shell store, with an overlay and an all-hidden empty state), kept strictly separate from `removeSessions`, because removal from the feed is host-driven and must not be overridable — a hidden flag that suppressed feed removal would make client state fight the host. Persistence is the open design question: A5 keeps persistence in dsh's store, so a durable hidden set would have to use the existing per-session settings-document mirror channel (ticket 79) rather than a new store, while an in-session-only set avoids the question but loses cross-restart recovery. Because the C13 boundary (session rows, never agent identities) and the persistence choice shape the feature, flag both in the claiming ticket.

## Incorporation notes
- **Where it would live:** client-side view-state in the shell-store family (`src/client/shell-store.ts` or a sibling store following the `settings-card-store.ts` pattern): a hidden-id set plus overlay-open flag, applied as a render filter over the feed rows in the sidebar component (`src/client/panel.tsx` area) — never inside `removeSessions`. The overlay component and the all-hidden empty state go beside the existing sidebar surfaces; a hidden session the feed has already dropped renders nothing when unhidden (honest absence, matching the store's existing rule that it never invents rows).
- **Constraints:** B9 — re-derive all labels and structure independently. C13 — the unit of hiding is the session row, not a persistent agent identity: no identity roster, avatars, or per-agent persistent chats may accumulate around it. A5 — any durable hidden set must reuse an existing persistence channel (per-session settings-document mirror) or stay in-session; no second database. U-A — this is not a connection/roster-lifecycle state machine; the all-hidden state is pure view-state over live rows.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a store holding view-state plus one overlay and one empty-state variant is contained work, but the C13/A5 boundaries and how hiding interacts with host-feed removal need deliberate design before a ticket claims it.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/hidden-chats/overlay/model.ts` — hidden-agent summary list; open/unhide/close model; close-then-open selection behavior; helper for the nothing-hidden empty state; per-agent hidden-name id helper.
  - `the reference tree's frontend/src/recovered/features/roster/status.tsx` — roster status kinds including an all-hidden state carrying a show-hidden-bots secondary button wired to the overlay.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/hidden-chats/overlay/model.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/roster/status.tsx`
- Build: `src/client/shell-store.ts` (lines 475–476, 626–637 — removal resets selection, rows deleted, no hide state); `src/client/shell-feed.ts` (lines 108–126 — feed-driven removal); grep of `src/client/` + `client/` confirms no session-hide concept exists.
