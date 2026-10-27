# 147 — Dispatcher status persists across dsh restart (user-started dispatchers re-activate on session resume)

**Status:** claimed
**Labels:** ready-for-agent
**Origin:** owner 2026-10-27: "dispatcher status fails to persist after dsh shutdown. when restarted dispatcher seem to lose dispatcher status and says: 'Tools updated 10 removed Removed: await_agent, check_workers, deliver_result, message_agent, recall, request_access, spawn_dispatcher, spawn_worker, steer_worker, stop_worker'".
**Blocked by:** nothing — owner instruction 2026-10-27 names this work directly. Ticket 149 is an independent defect on the same behaviour, not a blocker for the primary route.
**Related:** ticket 149 (marker store version mismatch — no-degraded-notice half of the same behaviour), resolved ticket 104 (post-boot activation set provably empty, same asymmetry), ADR-0009, ADR-0012, ADR-0006.

## Problem

On dsh restart the owner sees the host message "Tools updated / 10 removed" listing exactly:
`await_agent, check_workers, deliver_result, message_agent, recall, request_access,
spawn_dispatcher, spawn_worker, steer_worker, stop_worker`.

That list is the activated-dispatcher surface, and nothing else:

- 8 dispatcher tools from `createDispatcherTools` (`src/core/tools.ts:691`), registered through
  `src/adapter/dispatcher-tools.ts:224` from `activateToolSurface` (`src/plugin.ts:962-1017`),
  which is called only from `onActivated` (`src/plugin.ts:1128`).
- `recall` — the racoons mount's per-session tool (`src/adapter/racoons-mount.ts:332`).
- `request_access` — `src/plugin.ts:1016`, global and refcounted.

The message is emitted by the dsh HOST, not dsh-bot. dsh-agent-loop's `buildRequest` compares the
previous request/header tool names recorded in the durable session log against the live tool list
and injects tool-removal notices (`dsh-agent-loop lib/index.js:1241-1259`, rendered by
dsh-client-ui-chat's `ContextInjectionRow`). So the session log durably names those 10 tools; the
live surface after restart has none of them. Ten names is the exact fingerprint of "dispatcher
activation did not come back".

Root cause: the activated-dispatcher set is in-memory only — the `sessions` Map at
`src/adapter/parent-agent.ts:266`, written only by `bindActivation` (`:404`), never persisted. The
plugin boots dormant by design (ADR-0009, `src/plugin.ts:873-880`) and there is NO re-activation
path for a user-started (generation-1) dispatcher chat after restart:

- `resumeMarkedDispatcher` is only reachable from the `agent/created` listener, which returns early
  for parentless sessions (`src/adapter/cordis-dsh-host.ts:1502-1503`, `if (parentSessionId === "") return;`).
- The durable `dispatcher_sessions` mark is written ONLY inside `spawnDispatcher`
  (`src/adapter/cordis-dsh-host.ts:2005`), and the parser enforces `generation >= 2`
  (`src/adapter/durable-marker.ts:305-311`) — so a user-started top-level dispatcher structurally
  can never have a mark.

Result: after boot the activation set is provably empty, and the first request in the reopened chat
produces "10 removed". The same post-boot-empty asymmetry was already proven in resolved ticket 104
for the roster mirror.

What DOES survive restart today: the `sessionKind` projection
(`src/adapter/session-kind-projection.ts`, checkpointed under `~/.dsh/storages/session_projcache`).
The sidebar glyph and the session's dispatcher identity persist while the live binding does not.

## What to do

- [x] Implement re-activation of user-started dispatchers on session resume, PRIMARY ROUTE: at the
  `agent/created` listener in `src/adapter/cordis-dsh-host.ts` (:1493-1519), when a session has no
  parent, consult the durable sessionKind projection (`ctx.sessionProjections.stateOf(session,
  "sessionKind")`) and if it resolves to `"dispatcher"`, re-run the activation path
  (`lifecycle.activate` / `bindActivation` via the same seam `onActivated` → `activateToolSurface`
  uses today) so all 10 tools return on the reopened chat. Keep it idempotent (no double-activation
  if already bound) and correct for the `request_access` refcount (`src/plugin.ts:906-950`).
- [x] FALLBACK ROUTE only if the projection is not readable at that seam: write a durable activation
  mark for generation-1 dispatchers at `lifecycle.activate` time (relax or extend the
  `generation >= 2` rule in `src/adapter/durable-marker.ts` without breaking spawn-resume
  semantics) and resume from it. Record in a ticket comment which route landed and why.
  — **NOT TAKEN**: the projection is readable at that seam (comment below).
- [x] New offline test: a user-started (generation-1) dispatcher session, after a simulated restart
  (re-apply/dispose + fresh apply, or the cold-resume harness pattern from
  `test/spawn-dispatcher-activation.test.ts:1083/:1209`), re-activates with the full tool surface
  (8 scoped + `recall` + `request_access`) with no tool-removal regression and no
  `RESTART_DEGRADED_NOTICE`. Also assert a NORMAL (non-dispatcher) session still resumes without
  activation.
- [x] Existing dormant-boot pins must stay green unmodified: `test/activation-lifecycle.test.ts:281/:308`,
  `test/plugin-scaffold.test.ts:281` — dormant `apply()` registers commands and no tools;
  re-activation happens on `agent/created` for a specific resumed session, not at `apply()`. If a
  pin genuinely must change, stop and report instead of editing it.
- [x] Gates in one grouped run: `npm run typecheck && npm test && npm run lint:docs`.

## Constraints

- Offline tests only; no live dsh/LLM/browser run.
- Do not weaken ADR-0009 dormant boot: `apply()` stays dormant; only an explicit durable signal
  (projection or mark) may re-activate a specific session.
- Do not activate blank/archived sessions; dispatcher kind must come from durable state, never a
  guess.
- `src/adapter/parent-agent.ts` needs no structural change (it already exposes
  `isDispatcherSession` / `activate` / `activateSpawnedDispatcher`).
- npm not pnpm; evidence artifacts under `.scratch/testing/2026-10-27-<slug>/`, never committed.

### ADR notes

- Owner instruction 2026-10-27 is the level-1 ruling that activation of a user-started dispatcher
  must survive dsh restart. No accepted ADR decides this today: ADR-0009 rules dormant BOOT
  (unchanged by this ticket), ADR-0012 rules that restart replays durability never work (replaying
  an activation record IS durability replay, consistent). Recording explicitly per the
  surface-don't-silently-assume rule.
- ADR-0006 (no second database): PRIMARY route reuses the existing `sessionKind` projection — no new
  store. Fallback route reuses the existing marker domain.
- Related resolved ticket 104 (post-boot activation set provably empty — the same asymmetry, fixed
  then for the roster mirror).

## DoD

- [x] After restart, reopening a user-started dispatcher chat restores the full 10-tool surface
  (asserted offline); the dsh host therefore emits no tool-removal notice for it
  (regression-covered by the new test asserting the surface is present before the first request).
- [x] Normal sessions, dormant boot, spawn-resume paths: all existing tests green, unmodified pins
  intact.
- [x] Grouped gates green.

## Comments

2026-10-27: Filed from owner instruction; findings gathered read-only; no code changed.

2026-10-27 (implementer, branch `ticket-147-dispatcher-status-persistence`): **primary route landed;
the durable-mark fallback was NOT taken.**

Why the primary route: the projection is readable exactly at the seam the ticket named. On
`agent/created`, `ctx.sessionProjections.stateOf(session, "sessionKind")` is synchronous (the registry
materializes the cell and folds the session's own log:
`dsh-session-projection/lib/index.js:126-131`), so the answer is available before the resumed chat's
first request builds its tool list. That is the whole point — the host's "10 removed" notice compares
the previous request header against the live surface, so the surface must exist by then. A
marker-store read is asynchronous (`resumeMarkedDispatcher` documents its one-microtask window), and
a generation-1 mark would additionally have needed the `generation >= 2` rule relaxed and the
"marks are only for spawned children" invariant reopened. No reason to pay either.

What changed:

- `src/adapter/session-kind-projection.ts`: added `stateOf` to the structural registry view, a
  `HostSessionProjectionsLike` read view, `resolveSessionProjections(ctx)` (guarded `ctx.get` first,
  direct property as the stub fallback — a bare property read throws on a live cordis context that
  never injected the service), and `sessionKindOf(registry, session)` — fail-CLOSED: no registry, no
  `stateOf`, a throw, or any state that is not `active: true` all answer `null`.
- `src/adapter/cordis-dsh-host.ts`: the `agent/created` listener no longer returns early for a
  parentless session. It first checks the session really is a top-level chat (no parent AND depth 0,
  the same reading `isTopLevel` uses), then asks the new `sessionKindOf` provider. On `"dispatcher"`
  it calls the new `onUserDispatcherResumed` hook exactly once per session id
  (`resumedUserDispatchers`), failures logged and swallowed.
- `src/plugin.ts`: wires both hooks. `sessionKindOf` resolves the registry and defers to the shared
  helper; `onUserDispatcherResumed` calls `lifecycle.activate(agent)` — the SAME path `/dsh-bot`
  uses, so `bindActivation` → `onActivated` → `activateToolSurface` restores the 8 scoped tools,
  `recall`, the refcounted global `request_access`, the policy inject and the durability rebuild.
  A refused outcome other than `already-active-here` is logged, not swallowed.
- Idempotency is double: the host dedupes by session id, and the lifecycle refuses
  `already-active-here` — so a re-announcement, or a session this process already activated by
  command, cannot double-register tools or double-inject policy.
- Dormant boot is untouched: `apply()` still registers commands and no tools; the new listener body
  runs only on `agent/created` for a specific session backed by durable state. The three pins
  (`test/activation-lifecycle.test.ts:281`, `:308`, `test/plugin-scaffold.test.ts:281`) are
  unmodified and green.

Tests: `test/dispatcher-resume-reactivation.test.ts` (8 cases). The restart case drives the REAL
registered projection unit over a REAL `command/run` + `command/done` pair for `dsh-bot`, then
re-applies the plugin over the same storage tables and announces the parentless session. Asserts the
9 scoped tools + `request_access` (the exact 10 the owner saw removed), one policy inject, no
`RESTART_DEGRADED_NOTICE`, and that no dormant tool exists before the announcement. Negatives: a
normal session resumes with no tools and no policy; a repeated announcement adds nothing; a
command-activated session that is re-announced is left alone; a throwing projection and an absent
registry both activate nothing; a parentless session at depth 1 is not activated.

Recorded limit (not a defect, stated for honesty): a resumed dispatcher whose chat was opened while
the plugin had no projection registry at all (an older host tree) stays dormant, exactly as before
this ticket.

Gates, one grouped run: `npm run typecheck && npm test && npm run lint:docs` — exit 0, 1571/1571
tests pass, doc-lint 0 findings. Note: doc-lint needs the git-ignored local `AGENTS.md` and
`client/index.js` present; a fresh worktree lacks both, so they were restored locally (never
committed) before the lint run.

2026-10-28 (handoff): the implementer agent was stopped by owner order AFTER completing the work
above; only the merge is missing. Remaining for the next team: (1) merge branch
`ticket-147-dispatcher-status-persistence` (commits 30a16a2, e7a8e0e) into main — main has since
advanced to 39bed3b with tickets 146+148, file overlap is low but no combined gate has been run;
(2) run the grouped gates `npm run typecheck && npm test && npm run lint:docs` on merged main;
(3) move this ticket and 149 to resolved/. The worktree `.scratch/worktrees/t147` holds the branch
and is left in place for the handoff.
