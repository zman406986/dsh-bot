# 94 — Shell store mirror reader is never fed: `applySessionMirror`/`applyPresence` have no live call site

**Status:** resolved
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
   **DONE 2026-09-19.** New module `src/client/shell-mirror-feed.ts`
   (`sessionMirrorsFromChannelValue` + `createShellMirrorFeed` with
   fan-out/attach-replay/detach). Fed from the SAME single read:
   `src/client/index.ts:369-372` (`mirrorsFeed.applyChannelValue(snapshot.value)`,
   right after the roster store and the approval relay feed);
   `src/client/index.ts:317-325` (the hub + its rationale). Each mount
   attaches its OWN store: `src/client/index.ts:641-652` (the
   `mountShellPage` effect) with the wiring plumbed through
   `ShellMirrorFeedWiring` (`:604-620`) and both injects (`:497`, `:543`),
   and returned additively as `ClientModuleComposition.mirrorsFeed`
   (`:254-259`).
2. (offline) A test drives the real composition end to end (real host
   `apply` → real activation → real publish → real `applyClientModule`
   watch → the mount's OWN `DispatcherShellStore`) and asserts, from the
   `mounts` the composition returns: the row flips `dispatcher: true`, the
   presence summary is live (not `null`), `presenceAvailable` is true in the
   sidebar view, `shellSeatHostsPanel` is true for that session (the panel
   IS hosted), and the sidebar order puts the dispatcher row first.
   **DONE 2026-09-19.** `test/approval-feed-composition.test.ts:611` ("ticket
   94: the mount's shell store is fed the per-session mirror (flag, presence,
   hosted panel)") asserts, for BOTH mounts: `dispatcher === true`,
   `presence = {working:0,needsYou:0,finished:0}`, `mirrors.get("s-1").kind
   === "snapshot"`, `describeShellSidebar(...).rows[0]` = the dispatcher row
   with `presenceAvailable: true`, `shellSeatHostsPanel(...) === true`,
   `hosts.rosterPanel({sessionId:"s-1"}) !== null` (and `null` for an
   unknown session); then a real spawn moves the presence to
   `{working:1,...}`, and selecting the row projects the seat store onto the
   same mirror (`seat.getBox().state.kind === "snapshot"`). The sidebar-order
   rule itself is pinned in `test/client-wrapper-shell.test.ts`.
3. (offline) The honest states stay pinned: a `null` mirror (deactivation
   clear) drops the flag; a corrupt mirror value yields
   `unavailable`/`presenceAvailable: false`; a mirror for a session the feed
   has not delivered invents no row; an unrelated document leaves the store
   untouched; the mount detaches from the hub with the client fiber
   (unload/HMR).
   **DONE 2026-09-19.** New suite `test/shell-mirror-feed.test.ts` (10 tests,
   2 suites): extraction keeps dotted ids whole and ignores the legacy key;
   `null` → `cleared` (flag false, presence `null`); corrupt → `unavailable`
   (flag stays true, presence `null`); unknown session → no row invented and
   the mirror applies at upsert; non-object / unrelated documents leave the
   store untouched; attach replay and per-store detach. The
   **resurrection guard** is pinned explicitly: the legacy `roster` key is
   NEVER replayed, because only the per-session key is cleared on
   deactivation (`src/adapter/roster-channel.ts:162-170`) — replaying the
   stale legacy snapshot would re-flag a deactivated session. Fiber detach:
   `test/approval-feed-composition.test.ts:700` ("the mount's mirror feed
   detaches with the client fiber") — after `runFiberTeardown()` a later
   publish reaches no mount.
4. `npm test` (0 fail), `npm run typecheck` (both configs),
   `npm run build:client` green; the built `client\index.js` contains MORE
   than one occurrence of `applySessionMirror(` (definition + live call
   site) — the live-pass detector for this exact bug.
   **DONE 2026-09-19.** `npm test` **1098 tests / 267 suites / 0 fail**;
   `npm run typecheck` exit 0 (both configs); `npm run build:client` green,
   `client\index.js` **163143 bytes** and `grep -c "applySessionMirror("`
   = **3** (was exactly 1 — the definition — in the live-pass bundle).
5. The fakes involved model the host shape where they touch this path (the
   settings document + scope contract, shared with ticket 93) with the host
   file:line citation in each touched fake's header (85/86/91 convention).
   **DONE 2026-09-19.** The 6 settings fakes are aligned and cited (see
   ticket 93 AC3); the composition fake additionally models the sessions
   feed read face (`SessionListState`: ids + byId) so the pin can assert on a
   DELIVERED row rather than an invented one
   (`test/approval-feed-composition.test.ts:357-374`).

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

- **2026-09-19 (wt/pipe)** — All five ACs met; resolved. Commits: `db7d459`
  (filed), `257f267` (the fix + pins), `7a4f01e` (header citations).
  - Product change: `src/client/shell-mirror-feed.ts` (new; the reader),
    `src/client/index.ts` (hub creation + watch feed + wiring into both
    mounts + composition return). No second settings bind: the hub rides the
    ONE `ctx.settingsScope` bind, exactly as the ticket-47 rule requires.
  - Design decision recorded: the feed reads ONLY the dotted
    `roster.<sessionId>` family. The legacy `roster` key is never cleared
    (`clearSession` writes only the session key), so replaying it would
    resurrect a deactivated session's dispatcher flag — pinned as a
    regression test ("never replays the legacy whole-snapshot key (the
    resurrection guard)").
  - RED evidence (fix disabled — `mirrorsFeed.applyChannelValue` guarded
    off): `test/approval-feed-composition.test.ts` fails **2 of 5** —
    `AssertionError: the dispatcher flag is live` (`false !== true`) and the
    fiber-detach test's presence assertion. Restored: 5/5.
  - Gates: `npm test` 1098 / 267 / 0 fail (baseline before the pass:
    1079 / 265 / 0); `npm run typecheck` exit 0 both configs;
    `npm run build:client` green, `client\index.js` 163143 bytes, 3
    occurrences of `applySessionMirror(` (was 1).
  - `applyPresence` (the roster-feed-shaped verb) deliberately remains
    without a production call site: the settings document is the live
    authority and feeds the store through `applySessionMirror` (the
    module's own keying rule, `src/client/shell-store.ts:13-36`); the verb
    stays for callers that already hold a parsed snapshot and is exercised
    by the store's own suite. Recorded here rather than deleting a public
    store verb in a bug-fix pass.
  - Handover: nothing left in this ticket. Live re-verification (rows
    carrying `data-dispatcher="true"`, the presence chip, the hosted panel,
    ticket 81's cards) belongs to the separate live lane; ticket 93's host
    half is fixed in the same pass, so the pipeline is whole offline.
- **2026-09-19 (wind-down agent)** — Offline-complete; live verification NOT
  yet performed — see ticket 33 handover 2026-09-19.
