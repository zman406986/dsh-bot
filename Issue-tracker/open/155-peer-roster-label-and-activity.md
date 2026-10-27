# 155 — Peer roster rows show session ids only; ADR-0027 asks for a label plus the current tool/target

**Status:** open
**Labels:** ready-for-agent
**Origin:** PRD gap scan 2026-10-28 — verified against the tree; nothing implemented.
**Related:** PRD §7.6 (Phase 2 peer agents), ADR-0027 decision 3 (roster target richness: working/waiting/approval/idle plus current tool and current target) and decision 2 (`subagent.label` is the durable human-readable label, fallback order label → title → session id), ticket 121 (the roster as shipped), ADR-0018 C13 (no identity roster — this is a live projection, not a store).

## Problem

`peerRosterFor` builds each candidate from three booleans and nothing else:

```
src/adapter/parent-agent.ts:306-316
  .map((sessionId) => ({
    sessionId,
    busy: multitask.wakeBus.isBusy(sessionId),
    pendingApproval: multitask.listPendingAccess(sessionId).length > 0,
    queuedWake: multitask.wakeBus.peek(sessionId) !== undefined,
  }))
```

`label`, `title`, `activity`, `currentTool` and `currentTarget` are never passed. The core builder accepts all five (`PeerRosterCandidate`, `src/core/policy/assembler.ts:239-249`; copied into the snapshot at `:267-279`), and the renderer already displays them:

- display name = `label` ?? `title` (`peerDisplayName`, `src/core/policy/assembler.ts:205-207`), rendered as `- <name> (<id>) — <status>`;
- activity suffix = the ring phrase, else `using <tool>` / `using <tool> on <target>` (`peerActivityPhrase`, `src/core/policy/assembler.ts:223-232`).

With all five null, every row collapses to `- <session-id> — <status>` — the bare id the ADR calls the fallback of last resort. The user (and the model) cannot tell two siblings apart or see what either is doing.

## Why the fields are missing — two separate gaps

**Label.** ADR-0027 decision 2 names `subagent.label` as the durable label, and our spawner already passes one (`label: opts.title` at `src/adapter/cordis-dsh-host.ts:1972` workers, `:2089` dispatchers). ADR-0027 decision 3 reads it from the session list snapshot's `projectionValues.subagent.label`. The plugin does not inject that seam: `inject` is `subagents, agents, jobs, storageDomain, tools, commands, userQuestions, approval` (`src/plugin.ts:173-182`). `AdapterContext` offers only `agents.get(id)` (`src/adapter/cordis-dsh-host.ts:221-223`) — an `AgentLike` whose `session` view carries `id` and a header with `parentSession`/`delegationDepth` (`:36-60`), no label.

**Tool/target.** The activity ring is worker-keyed and gated on it: the `session/event` handler returns early unless the session is a known worker (`if (!workers.has(workerId)) return;`, `src/adapter/cordis-dsh-host.ts:1214-1218`). Even a correct read would find nothing for a dispatcher peer. That gate is deliberate — the roster comment records why a dispatcher cannot borrow a worker's ring (`src/adapter/parent-agent.ts:299-305`).

So neither field is a wiring slip that a one-line fix closes; each needs a source that does not exist yet for dispatcher sessions.

## What to do — candidate sources, pick per field and record the pick

Label:
1. Inject the host session/projection store and read `projectionValues.subagent.label` (ADR-0027 decision 3's stated source). This is the only option the ADR names; check it is reachable from the server-side plugin context before committing (the ADR cites the client-side `sessions.list` snapshot).
2. Keep our own `sessionId → title` map, populated at `spawnDispatcher` (`DispatcherSpawnOptions.title`, `src/core/types.ts:87-92`) and at activation. Cheap, durable-per-process only, and duplicates a host fact — record it as a deviation if chosen.

Tool/target: record the current `tool/call` per dispatcher session from the same `session/event` firehose, with the worker gate widened (a dispatcher-keyed ring or a shared map), reusing `describeToolActivity` (`src/adapter/cordis-dsh-host.ts:592-602`) so the phrase vocabulary stays identical to `check_workers`.

Either way the roster must stay honest: absence renders nothing (no invented tool, no placeholder label), and the row stays byte-stable for an unchanged roster (tail-placement rule, `src/core/policy/assembler.ts:70-80`).

## Acceptance

- [ ] A roster row for a live dispatcher peer shows its label (fallback order per ADR-0027 decision 2) and, when one was observed, its current tool and target in the existing `using <tool> on <target>` form.
- [ ] No field is invented: an unobserved tool/target renders exactly as today, and a peer with no label renders its id.
- [ ] The snapshot builder and renderer are unchanged in shape; only the candidate feed grows (or the builder gains one documented input).
- [ ] Offline test: two peers with distinct labels and distinct current tools render two distinct rows; a peer with neither renders its id, byte-identically to today's output for that peer.
- [ ] The tail stays byte-stable when nothing changes between turns (a test pins it, as ticket 121's does).

## Constraints

- Live projection only — no new store, no identity roster (ADR-0018 C13).
- Do not widen the activity ring's worker gate without checking every existing reader (`recentActivity` `:1809`, `lastActivityAtMs` `:1822`, `recent` `:1838`); a dispatcher key must not make `check_workers` claim activity for a worker id it does not own.
- Worker rows are unaffected (the roster lists other activated dispatchers only, ticket 121's recorded eligibility).
- Offline tests only; no live dsh or LLM run.

## Low priority

PRD §7.6 marks Phase 2 as optional. This is a read-only prompt-quality gain; it does not unblock anything.

## Comments

2026-10-28: Filed from a read-only gap scan. The ADR's decision 3 read path was cited from the installed tree, not re-verified against a live session; the ticket's first task is confirming that seam is reachable server-side before choosing between the two label sources.

### 2026-10-28 — implementation (status stays open; see findings)

**Label source: option 1 confirmed reachable server-side.** ADR-0027 decision 3's seam is real and synchronous. `ctx.sessionProjections.stateOf(session, "subagent")` returns the host fold state `{ identity?: { mode, label?, seq } }` (`dsh-session-projection/lib/types/index.d.ts:126-131`, `dsh-subagent/lib/types/projection.d.ts:73-76`, registered at `dsh-subagent/lib/index.js:2732-2745`). It is the same guarded `ctx.get("sessionProjections")` route ticket 147 already uses for `sessionKind`, so no new injection is needed. New module `src/adapter/peer-label.ts` (`subagentLabelOf`) reads it; `plugin.ts` passes it down as `BindDispatcherLifecycleOptions.peerLabelOf`; `peerRosterFor` puts the answer on `PeerRosterCandidate.label`. A no-descriptor session (every user-started dispatcher) answers null and still renders its id.

**Tool/target source: a dispatcher-keyed map beside the worker ring, not inside it.** `CordisDshHost.peerToolActivity(sessionId)` returns `{ tool, target }` for a session whose parent is bound here. The same `session/event` firehose feeds it; the dispatcher branch runs BEFORE the `workers.has` gate and returns, so `recentActivity` / `lastActivityAtMs` / `recentActivities` / `onWorkerToolCall` / `check_workers` never see a dispatcher key (pinned by a test). The pair is split from one payload by the new `describeToolCall` — `describeToolActivity` is now that plus the join, so the worker phrase vocabulary is byte-identical. An entry is DELETED on that session's `turn/end` and on unbind: a closed turn has no current tool, so the row cannot show a stale one.

**Renderer.** Unchanged. `peerActivityPhrase` already renders `using <tool> on <target>` from `currentTool`/`currentTarget`, and the labels ride the same row (`- <label> (<id>) — <liveness> · using <tool> on <target>`). No core or renderer file was touched.

**Tests.** `test/adapter-policy-inject.test.ts` gains a `peer roster feed` block (two labelled peers with distinct tools → two distinct rows; no-label/no-tool row byte-identical to today; label-only row; throwing label seam; tail byte-stability across turns) and a `subagentLabelOf` block. `test/adapter-cordis-dsh-host.test.ts` gains a `peer tool/target feed` block (record, worker-ring isolation, turn/end clear, unreadable payload clear, unbind/dispose clear, `describeToolCall` null-safety).

#### Findings — what ADR-0027 asked for that this feed still cannot carry

1. **The `title` fallback step is not wired (deliberate).** ADR-0027 decision 2 says label → title → id. The title projection (`dsh-session-title`) is readable the same way, but it is a mutable auto-generated conversation title, it exists for every session, and taking it would rename every USER-STARTED dispatcher's roster row — which this ticket's own acceptance forbids ("a peer with no label renders its id, byte-identically"). It would also add unclamped text to the prompt tail. A spawned dispatcher always has a descriptor label (`spawnDispatcher` passes `opts.title`), so the label step covers every peer this roster can list. Recorded as a deviation, not a silent omission.
2. **`waiting` is still not a model-level wait.** Unchanged from ticket 121: `queuedWake` means "a wake is ready and no turn runs". Whether the host exposes anything finer is still open (ADR-0027 open question 4), and no new channel was invented for it.
3. **Current tool is per-session, last-write-wins, and only as fresh as the last observed `tool/call`.** A peer blocked inside one long tool call shows that call; a peer between calls after `turn/end` shows nothing. That is the honest shape available from the firehose — no polling was added.
4. **The client half has no peer roster row to extend.** `client/` carries no runtime consumer of `PeerRosterSnapshot`: `renderPeerRoster` feeds injected prompt text only. The sidebar's rows are per-session presence (`shell-store.ts`), the panel's rows are per-WORKER (`roster-store.ts`), and the peer roster never crosses to the browser. Adding a peer row renderer would be a new client surface, not an edit to an existing one — out of this ticket's scope and refused here rather than invented. What the client already shows for a peer is its stock `displayTitle` (which the host composes as title → `subagent.label` → id, `dsh-api-session-controller/lib/client.js:4175`), so a spawned dispatcher's label is already visible in the sidebar; nothing was re-keyed.
