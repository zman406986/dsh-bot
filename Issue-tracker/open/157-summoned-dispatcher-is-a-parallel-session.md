# 157 — A summoned dispatcher is a new parallel session, not a subagent child

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing — the host capability question is answered (§Evidence) and the three open product choices were ruled by the owner on 2026-10-28 (§Owner decisions).
**Origin:** owner ruling 2026-10-28 — a dispatcher that summons another dispatcher must create a **new top-level session parallel to the summoner**, not a subagent child of it.
**Related:** ADR-0025 (decision 2, "a peer of its creator, not a rank below it", `docs/adr/0025-chief-of-staff-dispatcher-mitosis.md:45` — the intent this ticket makes structural; decision 6, `:49`, is the clause the ruling reverses), ADR-0019 (per-dispatcher scoped tools and keyed state — the design that makes a parallel dispatcher cheap), ADR-0027 (§Starting identity and dispatch — the peer-label basis changes), ADR-0024 rider (the seat count returns to one), ADR-0031 (draft; the mark/header-chip compensation whose premise this ruling removes), ADR-0003 (worker-leaf, single-parent and no-worker-to-worker rules bind unchanged), tickets 118 (built the current mechanism), 130, 131, 138, 140, 141, 155 (the subagent-shape work this re-bases).

## Problem

Today the summon rides the host subagent service: `spawnDispatcher()` (`src/adapter/cordis-dsh-host.ts:2189`) calls `ctx.subagents.startActivation({ provider, label, childId, request: { prompt, parent, maxDepth }, signal, delivery: "parent" })` (`:2237-2251`). The host therefore stamps the child `parentSession`, `origin: 'subagent'` and `delegationDepth` (`dsh-subagent/lib/types/child-agent.js:113,117,119`), the stock sidebar drops every `origin: 'subagent'` row (`dsh-client-ui-workspace/lib/client.js:965`), and the repo has built four compensations on top of that shape:

1. **a header chip** — the licensed sidebar cell never mounts for a hidden child, so the mark was hung on the conversation header instead (`src/client/index.ts:329-338` at HEAD);
2. **a `sessionKind` mark mirror** — a child's own log never runs `/dsh-bot`, so the projection's `init` was taught to consult an adapter-side mark (`src/adapter/session-kind-projection.ts:305-348`);
3. **a gate-free activation entry point** — the top-level gate would refuse every child, so `activateSpawnedDispatcher` with its own outcome type (`SpawnedActivationOutcome`, `src/adapter/parent-agent.ts:109-146`, `:514`; wired at `src/plugin.ts:741`) exists purely to bypass it;
4. **a `spawned` policy variant** — the child is told it has no user and no user-visible turn (`src/core/policy/prompts.ts:285-309` EN, `:346-369` ZH), and the `spawn_dispatcher` description says it "cannot talk to the user" (`:99-100`).

ADR-0025 decision 2 already says a summoned dispatcher is "a peer of its creator, not a rank below it" and that the structural parent/child relation "does not make it a subordinate" (`docs/adr/0025-chief-of-staff-dispatcher-mitosis.md:45`). The shipped mechanism contradicts that intent; the owner has ruled the mechanism must match it.

The host supports the target shape: `ctx.agents.create()` with `parentAgent` omitted and a `meta` of `{ cwd }` only builds a root agent on a top-level session (`dsh-agent/lib/types/index.d.ts:278`, `:51-52`; the same call the web UI's "new chat" makes, `dsh-api-session-controller/lib/index.js:517-525`), and `agent.followup(...)` gives it its first turn (`dsh-agent/lib/types/runtime-types.d.ts:192`). There is **no promotion path** — `origin`, `parentSession` and `delegationDepth` are constructor-time header fields with no update API (`dsh-session/lib/types/types.d.ts:59-96`), so the session must be created correctly the first time.

## Owner decisions — 2026-10-28

Recorded as chosen (source: `.scratch/repo-analysis/2026-10-28-summon-parallel-session-plan.md` §9):

| Question | Decision |
|---|---|
| Messaging between two top-level sessions | **Build our own delivery.** No hidden subagent edge kept as a pipe. |
| Cold resume for a summoned dispatcher | **In v1.** Not deferred. |
| A spawn cap of our own | **None.** Observe first, matching ADR-0025 §Starting bounds and the 2026-10-22 ruling on ticket 131. |

## Evidence

All paths below were read read-only on 2026-10-28; the investigations are `.scratch/repo-analysis/2026-10-28-host-parallel-session-feasibility.md` (host capability), `.scratch/repo-analysis/2026-10-28-cross-session-delivery-feasibility.md` (delivery) and `.scratch/repo-analysis/2026-10-28-repo-subagent-assumptions.md` (change surface).

- **Creation.** `ctx.agents.create()` with `parentAgent` omitted and no `meta.origin` / `meta.parentSession` / `meta.delegationDepth` yields a visible top-level session; a blank (zero-turn) session is hidden until its first turn lands (`dsh-client-ui-workspace/lib/client.js:966`).
- **The OR trap.** The subagent-ownership guard is an OR — `origin === 'subagent'` **or** (`parentSession` set **and** the live parent owns the agent) (`dsh-api-session-controller/lib/index.js:128-134`). Passing a parent "for convenience" silently flips the session back to subagent-routed and the ordinary routes then refuse it with `session/agent-busy`. Parent, origin and depth must all be omitted together.
- **Delivery.** `ctx.sessionController.resolveAgent(sessionId)` returns the live agent or cold-resumes it, deduped (`dsh-api-session-controller/lib/index.js:221-246`); `agent.followup(message)` wakes it (`dsh-agent-loop/lib/index.js:806-808`). A shipped package does exactly this against sessions it does not own (`dsh-schedule/lib/index.js:1576-1596`).
- **Two hard rules.** Appending a `user/message` into another session's log renders a transcript row but never enters that session's inbox and never wakes it (`dsh-agent-loop/lib/index.js:1072` is the only step-time append site) — it is the approach that silently does nothing. And a restored inbox is parked: resume alone runs nothing (`dsh-agent-loop/lib/index.js:841`, `:898`), so every resume must be paired with an explicit `followup`.
- **What depends on the parent→child edge today** (all in `src/adapter/cordis-dsh-host.ts`): `resumeDormantDispatcher:1100-1137` (mark as address, spawner as sender, `ctx.subagents.sendMessage` as the resume) and `flushPendingWakeTurn:1396-1405`, which is reached only from `activateSpawnedDispatcher` (`:1354`, `:1362`, `:1383`) and would therefore never run for a session with no parent. The no-parent branch is `:1709-1728`; `resumeUserStartedDispatcher:1645-1670` already lives there and is the natural re-composition hook.
- **Bounds.** `maxDepth` and the 8-slot pool live entirely inside `SubagentRuntime` (`dsh-subagent/lib/index.js:279-283`, `:1396-1399`) and do **not** bound a top-level session. Nothing of the host's stops a tree of summoned dispatchers.

## Acceptance

- [ ] A summon creates a top-level session: the create spec omits `parentAgent`, `meta.origin`, `meta.parentSession` and `meta.delegationDepth`, includes `cwd` in `meta` (required — `resolveAgent` refuses a session with no `cwd`, `dsh-api-session-controller/lib/index.js:393`), and a test asserts the resulting session header carries none of the three classification fields and that `isTopLevel` (`src/adapter/parent-agent.ts:16-22`) returns true for it.
- [ ] Activation goes through the ordinary `activate()` path: `SpawnedActivationOutcome` (`src/adapter/parent-agent.ts:109-146`) and `activateSpawnedDispatcher` (`:142`, `:514`, wired at `src/plugin.ts:741`) are retired, and the `not-top-level` gate applies to a summoned session exactly as it does to a user chat.
- [ ] The `maxDepth` derivation is retired: `dispatcherSpawnMaxDepth` (`src/worker/agent-def.ts:105-107`, applied at `src/adapter/cordis-dsh-host.ts:2203-2207`) no longer feeds the summon, and no replacement depth ceiling is invented.
- [ ] Peer messaging is our own delivery: `sessionController` is added to the plugin inject list (`src/plugin.ts:178-185`), a send resolves the target with `ctx.sessionController.resolveAgent(sessionId)` and delivers with `agent.followup(...)`, and nothing appends a `user/message` into another session's log.
- [ ] Cold resume is in v1 and works: a message to a summoned dispatcher whose process is gone resumes it through the same `resolveAgent` route and its text arrives; the resumed session is re-composed as a dispatcher (scoped tools and policy) exactly once — `setup` and the `resumeUserStartedDispatcher` route (`src/adapter/cordis-dsh-host.ts:1645-1670`) must not both fire.
- [ ] Every resume is paired with an explicit `followup`: no code path treats a resume as a delivery, and a test pins that a resumed session with a parked inbox stays quiet until a `followup` arrives.
- [ ] `flushPendingWakeTurn` is reachable from the no-parent branch (`src/adapter/cordis-dsh-host.ts:1709-1728`), so a wake parked during a cold resume is discharged instead of dropped; a test drives that path.
- [ ] No spawn cap of ours is added: no live-dispatcher count, per-tree quota, generation gate or spawn budget in core or adapter (matching `src/core/multitask.ts`, which has none today), and any future bound is a new ticket stating its tradeoff.
- [ ] A summoned dispatcher keeps a human label in every peer roster: its roster row renders a label rather than its raw session id (`src/adapter/peer-label.ts:52-68`, `src/adapter/parent-agent.ts:234-252` — a top-level session has no `subagent.label`), and where the only honest source is the summon title, the ticket comment records that ticket 155's deliberate title-fallback refusal (`Issue-tracker/resolved/155-peer-roster-label-and-activity.md:98`) is reversed for this case and why.
- [ ] The header chip is removed and the sidebar cell is the only dispatcher mark: the registration at `src/client/index.ts:329-338` (HEAD) is gone, the inject-count pins read 3 (they read 4 at HEAD — `test/client-face-scaffold.test.ts:645`, `test/client-settings-card.test.ts:401`, `test/client-onboarding.test.ts:704`, `test/client-roster-panel.test.ts:985`), and a test asserts there is exactly one dispatcher mark seat (ADR-0024 rider, one registration).
- [ ] Policy wording states what is now true, in both languages: the `spawned` variant (`src/core/policy/prompts.ts:285-309` EN, `:346-369` ZH), the `spawn_dispatcher` tool description (`:99-100`) and the spawn result note (`src/core/tool-results.ts:133-145`) no longer claim the summoned session has no chat, no user and no user-visible turn — unless that is still true for a specific delivery path and is stated as the reason.
- [ ] A deployment without `sessionController` degrades honestly: the service is read through a guarded lookup (the same pattern as the other optional host reads, `src/plugin.ts:1255-1256`), and when it is absent the summon refuses or the send degrades with a stated reason instead of throwing on a property read. `sessionController` is mounted by the web-app profile only (`dsh-web-app/cordis.patch.yml:122`).
- [ ] A summon never leaves an invisible orphan: a session that is created but never prompted is hidden by the blank-session rule (`dsh-client-ui-workspace/lib/client.js:966`), so the first turn is delivered as part of the summon and a failed first turn is reported as a failure (with the created session id), not silently swallowed.

## Constraints

- **No edits under `src/`, `test/` or `client/` until this ticket is claimed.** Other work is in flight in those trees: as of filing the header-chip registration is still committed at `src/client/index.ts:329-338` (HEAD, inject-count pins at 4), while uncommitted working-tree edits already remove it (`src/client/index.ts:319-322`) and drop the pins to 3. Whoever lands the spawn change keeps that removal and those pins; this ticket does not touch either tree.
- Workers are untouched: `spawn_dispatcher` stays denied to workers (`src/worker/tool-barrier.ts:48-51`), and the worker-leaf, single-parent and no-worker-to-worker rules (ADR-0003) bind.
- No new store, no identity roster (ADR-0018 C13): a summoned dispatcher is a session, not a saved identity.
- Offline only (S8). No live dsh, LLM or browser run in the implementation lane; the affected suites are re-based in one grouped run, per the standing rule.
- The mark/projection machinery (`src/adapter/session-kind-projection.ts:305-348`, `src/adapter/cordis-dsh-host.ts:1808-1858`) shrinks only where it provably loses its premise — the durable `dispatcher_sessions` mark still answers the restart case, so retiring it is a separate judgement, recorded, not assumed.
- Records (ADR superseding ADR-0025 decision 6, dated Status-line notes, the PRD and `docs/surfaces.md` amendments) are a separate lane, filed alongside; this ticket does not edit them.

## Comments

2026-10-28: Filed from the owner's 2026-10-28 ruling, ahead of any implementation (repo rule: log an issue before implementing). Every `src/` claim was read in this working tree; host claims come from the two feasibility investigations in `.scratch/repo-analysis/` and were not re-derived here. No source, test or client file was modified in this pass.

Scope note: tickets 131 (depth bounds), 130 (durable identity), 138 (resume and glyph), 140/ADR-0031 (header chip and mark mirror), 141 (`spawned` policy variant) and 155 (peer labels) are not reopened by this ticket — each repaired or documented the subagent shape. This ticket changes the shape and re-bases their outcomes.
