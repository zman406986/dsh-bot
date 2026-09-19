# 94 — Shell store mirror reader is never fed: `applySessionMirror`/`applyPresence` have no live call site

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (pipeline partner of 93 — both halves are needed)
**Related:** 93 (host-side half: nothing is published to the document),
79 (per-session mirror keys `roster.<sessionId>`; this is its client
read-side), 77 (the shell store), 78 (mount path), 80 (conversation pane),
27/28 (presence chips, needs-you marker, panel sections), 69 (L2 blocked
marker), 86/91 (fake-vs-host contract-gap class)

## Problem

Live browser pass (2026-09-19): every session row carried
`data-dispatcher="false"` and a `chip--unavailable` = `状态不可用`; the right
pane's `innerHTML` length was 0 (the roster panel is never hosted);
`data-presence` was never populated.

Root cause: the shell store's per-session mirror reader has **no live call
site**. `applySessionMirror` and `applyPresence`
(`src/client/shell-store.ts:330`, `:485`, `:497`) are defined and unit-pinned
but nothing in the shipped composition ever invokes them:
`mountShellPage` receives only `{store, onSeen, approvalsFeed}`
(`src/client/index.ts:451-455`, `:498-502`), and the one settings watch
(`src/client/index.ts:306-360`) feeds only `RosterStore.applyChannelValue`
and `ApprovalRelayFeed.applyChannelValue` — never the shell stores. The
built `client/index.js` contains exactly one occurrence of
`applySessionMirror(` — its definition.

Consequence: `state.mirrors` is permanently empty, so
`describeShellSidebar` never flags a dispatcher row (`shell-store.ts:213-232`,
`mirrorFlag` `:397-400`), `shellSeatHostsPanel` never hosts the panel
(`src/client/shell-mount.ts:264-266`), and the presence chips / needs-you
marker / `data-presence` render their honest "unavailable" state forever
(tickets 27/28/69 L2 all dead on the live surface).

Note the pipeline interaction: ticket 93 starves the document; this ticket
leaves the reader unwired. The fix must be the pair — one channel, one
document, one more honest reader (the same rule ticket 69 L1 applied when it
added the approval feed).

## Acceptance criteria

1. (offline) The composition's ONE settings watch feeds the per-session
   mirror keys (`roster.<sessionId>`, `src/adapter/roster-channel.ts:64-80`)
   of the accepted document into every mounted shell store, and a mount
   created AFTER a publish still receives the last-known mirrors (replay) —
   the approvals-feed hub shape (`src/client/approval-feed.ts:100-132`), not
   a second settings bind.
2. (offline) A test drives the real composition end to end (real host
   `apply` → real activation → real publish → real `applyClientModule`
   watch → the mount's OWN `DispatcherShellStore`) and asserts, from the
   `mounts` the composition returns: the row flips `dispatcher: true`, the
   presence summary is live (not `null`), `presenceAvailable` is true in the
   sidebar view, `shellSeatHostsPanel` is true for that session (the panel
   IS hosted), and the sidebar order puts the dispatcher row first.
3. (offline) The honest states stay pinned: a `null` mirror (deactivation
   clear) drops the flag; a corrupt mirror value yields
   `unavailable`/`presenceAvailable: false`; a mirror for a session the feed
   has not delivered invents no row; an unrelated document leaves the store
   untouched; the mount detaches from the hub with the client fiber
   (unload/HMR).
4. `npm test` (0 fail), `npm run typecheck` (both configs),
   `npm run build:client` green; the built `client\index.js` contains MORE
   than one occurrence of `applySessionMirror(` (definition + live call
   site) — the live-pass detector for this exact bug.
5. The fakes involved model the host shape where they touch this path (the
   settings document + scope contract, shared with ticket 93) with the host
   file:line citation in each touched fake's header (85/86/91 convention).

## Notes

- Filed 2026-09-19 by the wt/pipe agent from the live pass evidence.
- The live finding is verbatim: "the shell store's per-session mirror reader
  has no live call site — `applySessionMirror`/`applyPresence` are defined
  but never invoked (`mountShellPage` receives only `{store, onSeen,
  approvalsFeed}`; the built `client/index.js` contains exactly one
  occurrence of `applySessionMirror(`, its definition)."
- `applyPresence` (the roster-feed-shaped verb) stays for callers that
  already hold a parsed snapshot; the settings document is the live
  authority (module comment `src/client/shell-store.ts:13-36`).

## Comments
