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
