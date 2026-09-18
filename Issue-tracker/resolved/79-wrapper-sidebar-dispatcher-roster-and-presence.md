# 79 — Wrapper sidebar: dispatcher roster + presence re-host (ADR-0020 slice 3)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 77 (skeleton — resolved), 76 (per-dispatcher session keying of the roster mirror — resolved)
**Related:** ADR-0020 (multi-dispatcher placement), ADR-0019 (keying table), 27/28 (presence stores re-hosted here), `wrapper-vehicle-seams.md` Finding 1 (`ctx.sessions.list`), 82 (ADR-0020's "retry" inventory row vs U-A — tension recorded)

## What to do

- [x] Bind the shell sidebar to the standard sessions feed (`ctx.sessions.list` snapshot;
      selection via `open(id)` semantics) — rows = sessions, dispatcher flag from our
      per-session activation state.
      Evidence: `src/client/shell-feed.ts` — `sessionsFeedInputs` (the feed→store projection:
      `ids`+`byId` → rows titled by the host's `displayTitle` (title → raw-id fallback),
      subagent-origin rows excluded — workers are leaves; a row without a delivered summary is
      skipped, never invented) and `bindShellSessionsFeed` (initial sync + live subscribe +
      removal sync; a malformed snapshot authorizes no upserts AND no removals; `open(id)` is
      guarded by the store's known-row check and only then selects + calls the host verb —
      wired via the `onOpen` hook to `ctx.sessions.open` at composition time, ticket 78's
      registration). `src/client/context.ts`: `ClientSessionsLike` widened structurally to the
      `SessionListState`/`SessionSummary` face (+ optional `open`, `subscribe`). The dispatcher
      flag is NOT projected from the feed — it derives from our per-session activation state,
      the roster mirrors (below). Tests: `test/client-wrapper-shell.test.ts`, "sessions-feed
      projection + binding" (7 tests: projection, fallbacks, subagent exclusion, malformed
      snapshot, live upsert/removal, malformed-no-wipe, open-guard, subscribe-less degrade).
- [x] Re-host the ticket-27/28 presence stores onto the sidebar rows: status dot, blocked
      chip, activity line, finished marker — per session, keyed by session id (ADR-0019's
      mirror keying). Until 76 lands, rows degrade to honest "presence unavailable" copy,
      never a wrong roster.
      Evidence: host side — `src/adapter/roster-channel.ts` writes each publish under BOTH the
      legacy `roster` key (the shipped panel's read-side, unchanged) and
      `roster.<dispatcherSessionId>` (ADR-0019 keying table: "snapshots keyed per session under
      the plugin namespace"); `clearSession`/`clearAllSessions` write `null` (the owner scope
      has no field-delete verb); `src/plugin.ts` clears the session's key on `onDeactivated`
      and all keys on unload. Client side — `src/client/shell-store.ts` keeps a per-session
      mirror state (`snapshot` / `cleared` / `unavailable`) that is the flag's authority: a
      parsed snapshot flags the session and derives its presence; a cleared mirror drops the
      flag; a CORRUPT payload keeps the flag (the key exists — it is ours) but degrades
      presence to honest `null` (fail-closed, never a wrong roster). Row presence re-hosted at
      session granularity with the panel's OWN partition rule (`describePresence` via
      `rosterSectionFor`): status dot (`describePresenceDot`: working / needs-you / finished /
      idle / unavailable, `state-*` token roles), blocked chip (`describeWaiting` + 
      `waitingPhrase` — the SHARED `roster.blocked.*` / `roster.landed` copy, blocked
      outranks landed per design-17 §4.1, names only), and the counter chips (working / needs
      you / finished — the session-granularity re-host of the activity/finished markers).
      Tests: mirror suite (7: derive, isolation, cleared, corrupt, claim-authority, precedence,
      junk ids), channel suite (`roster-snapshot.test.ts`: key round-trip incl. dotted ids,
      dual write, per-session clear, clearAll), `multi-dispatcher.test.ts` ("deactivating
      session A clears only A's per-session mirror key"), component CSS/locale contract.
- [x] Roster failure states with honest copy: empty / unavailable / retry-less (no reconnect
      banner — U-A). Hover preview precedence (waiting reason > draft > last entry) only if the
      underlying data exists per session; otherwise record the gap.
      Evidence: empty → `shell.empty` (sidebar view model `kind:"empty"`); unavailable → the
      `shell.row.presence-unavailable` chip whenever `presenceAvailable` is false — no live
      snapshot, a corrupt mirror, or a snapshot older than the SHARED stale window at view
      time (`describeShellSidebar(state, nowMs)`; exactly-at-window is fresh — the panel's one
      stale rule, no heartbeat, degrade without a push); retry-less → pinned by test: the shell
      CSS contains no retry/refresh/reconnect/banner control and no `shell.*` copy suggests a
      retry (tests "failure states are retry-less…", "attention markers stay pull-only…").
      **The ADR-0020 inventory row itself says "unreachable with retry" — recorded as the
      U-A tension in ticket 82 (ready-for-human); implementation follows the conservative
      U-A reading until the human rules.** Hover preview: `describeRowPreview` — waiting
      reason > last entry (`recentResult` excerpt, wire truth), gated on
      `presenceAvailable` so a stale feed stops previewing; the **draft tier is the recorded
      gap**: per-agent drafts are excluded (ADR-0018 U-B), no draft data exists per session,
      so the tier is skipped, never simulated (documented in the store comment, the component
      comment, and the test "…the draft tier is a recorded gap"). Revealed purely in CSS
      (`:hover`/`:focus-visible`, no animation).
- [x] Unread/attention markers: pull-only (no push seam exists) — keep ticket 27's honesty.
      Evidence: the needs-you counter/chip IS the attention marker — visible when the user
      looks, nothing interrupts; pinned by test that no `shell.*` copy simulates a push
      surface (notif/toast/alert/push) and by the absence of any notification seam in the
      shell modules.

## Constraints

- No user-facing stop affordance anywhere (area 7 conformity). No identities/avatars (C13).
  — Held: the shell gained only selection and presence; restart-honesty's no-stop scan and
  the token/namespacing contracts stay green.
- Offline-testable parts: feed→store projection, keying, degradation paths, view models.
  — All pinned offline (S8); no live seam exercised; rendering covered by build + typecheck.

## Comments

### 2026-09-19 — agent (implemented; commit a027877)

Landed on top of 76/77. Shape:

- **Host (mirror keys):** `src/adapter/roster-channel.ts` — one merged `update` per
  transition carrying `{roster: snapshot, "roster.<id>": snapshot}` (one write per transition
  preserves ticket 28's no-coalescing decision — two fields, one document write);
  `clearSession(id)` / `clearAllSessions()` write `null` (no unset verb on the owner scope).
  `src/plugin.ts` — `onDeactivated` clears that session's key (a deactivated chat must stop
  reading as a dispatcher); plugin teardown clears every key the process wrote.
- **Client (read-side):** `src/client/shell-store.ts` — per-session mirror map in state;
  `applySessionMirror(id, raw)` (parse fail-closed; null = cleared) and the existing
  `applyPresence(snapshot)` route through one mirror transition; mirror signal outranks the
  feed's optional dispatcher claim; mirrors for sessions the feed has not delivered are
  recorded but INERT (mirrors never invent rows — the feed is the row authority); staleness
  is a view outcome via the optional render clock (component passes `Date.now()`; offline
  tests pass explicit clocks). `src/client/shell-feed.ts` (new) — the projection + binding
  above. `src/client/shell.tsx` — row head (dot + title), presence chip line, waiting chip,
  hover preview line; `hosts.onSelectSession` ride-along so the 78 composition can wire
  `sessions.open`; CSS stays token-only (`state-*` roles already in the evidenced allowlist —
  no new `--dsw-*` aliases, no hex, no animation, hover reveal is a display toggle).
  `src/client/context.ts` — structural sessions-feed widening (optional fields; readers of
  `.current` unaffected — capsule actions untouched).
- **Per-session read-side decision (the one this ticket owed):** per-session MIRROR KEYS
  (`roster.<sessionId>` under the existing single plugin namespace) rather than
  session-filtered reads of the one key — the one-key document can only hold the
  last-published session's snapshot, which IS the wrong-roster failure under two dispatchers;
  ADR-0019's keying table names per-session keys, and 76's comment deferred exactly this to
  the wrapper epic. The legacy `roster` key is kept for the shipped capsule-era panel (its
  last-write-wins behavior across multiple dispatchers is pre-existing and out of scope here;
  the wrapper sidebar is the multi-dispatcher surface).
- **Honest limitation recorded:** `rosterSessionKey` keys are extra-schema fields in the
  settings namespace — the same channel risk the legacy `roster` key already carries
  (schema-resolution passthrough is evidenced by the shipped panel path). If a future host
  strips unknown fields, BOTH mirror families fail the same way, to honest "unavailable" —
  fail-closed either way.
- **Dependencies:** nothing here depends on 78's staging mount or 80's conversation surface —
  the shell remains unregistered (78's scope); the binding and component are consumed at
  composition time there. Live visual/theme-in-browser confirmation rides the 45/33 live lane
  and is deliberately not claimed from offline work.

**Gates:** `npm test` 867 pass / 0 fail (219 suites, +26 tests over 76's 841);
`npm run typecheck` clean (both configs); `npm run build:client` green (client\index.js,
90426 bytes). Capsule/overlay path untouched.

### 2026-09-19 — resolved

All four ACs are offline-settleable and done (the ACs name feed→store projection, keying,
degradation paths, and view models as the offline-testable scope, and this ticket's list has
no live-only item). Moved to `resolved/`. The two recorded tensions stay visible: ticket 82
(ADR-0020's "retry" row vs U-A, ready-for-human) and the U-B draft-tier gap (recorded above
and in code).
