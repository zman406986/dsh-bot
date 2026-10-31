# 159 — `spawnTitlesInFlight` pairs a summon's title by queue position, so two simultaneous summons can swap labels

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing — a known defect the owner accepted on 2026-10-29 and ruled must be **filed, not fixed now**. A maintainer decides whether and when it is actioned.
**Origin:** owner ruling 2026-10-29 (in-session): the FIFO claim in `spawnTitlesInFlight` is an accepted defect; record it as its own ticket rather than fix it inside ticket 157.
**Related:** ticket 157 (the change that introduced the queue — ADR-0032 summoned dispatcher as a parallel top-level session), ticket 155 (the roster label this queue feeds), ADR-0027 decisions 2–3 (label source), ADR-0032 (the same call fires the hook from the child's create `setup`), ticket 158 (verification lane; this ticket is not part of it).

## Problem

ADR-0032 changed how a summoned dispatcher is created, and the spawn's human label took a side channel to follow it.

`host.spawnDispatcher` now creates the child with `ctx.agents.create({ sessionId, meta: { cwd }, setup })` (`src/adapter/cordis-dsh-host.ts:2516-2540`), and the plugin's activation hook `onDispatcherSpawned(agent, sessionId, generation)` fires from inside that `setup` callback (`src/adapter/cordis-dsh-host.ts:2520-2538` → `:1585-1622` → `:1605`). The hook signature carries no title, so the plugin keeps the label in a plugin-wide side channel:

- a plain `Array<{ readonly title: string }>` declared once per `apply`, shared by every dispatcher session's tool surface — `src/plugin.ts:701`;
- pushed by the `spawnDispatcher` tool wrapper before the host call, and removed by object identity in its `finally` — `src/plugin.ts:1100-1109`;
- claimed by position, `spawnTitlesInFlight.shift()`, in the hook — `src/plugin.ts:765-771`.

`shift()` takes the **oldest** entry, not the entry that belongs to the session being activated. Nothing correlates an entry with a session id, a call, or a spawn.

That is only exact while one summon is in flight at a time. Under ADR-0032 a summoned dispatcher is a top-level session parallel to its summoner, so two dispatcher sessions summoning at the same instant is a normal shape, not an edge case: each session has its own tool closure, but both closures push into the same array, and the order in which the two `create` calls reach `setup` is the host's business, not the push order.

Interleaving that loses the pairing:

1. summon A pushes its title → `[A]`; A's `create` suspends before `setup`.
2. summon B pushes its title → `[A, B]`.
3. B's `setup` reaches the hook first → `shift()` returns **A's** title → B's session is bound with A's label.
4. A's `setup` then returns **B's** title → A's session is bound with B's label.

Both spawns succeed, both dispatcher ids are correct, and the two peer-roster rows now show each other's name.

Observable symptom: the peer roster in the prompt tail (`src/adapter/parent-agent.ts:362-377`, label read at `:369`, stored at `:490-492`) attributes the wrong human label to a summoned dispatcher — visible to the model as its notion of who its peer is, and to the human where that roster is surfaced. The `spawn_dispatcher` ack is NOT affected: it echoes the caller's own `title` argument (`src/core/tools.ts:1536-1541`), so the summoner is told the right name while every later roster read is wrong.

Second-order symptom, same root cause: a summon that fails before its `setup` runs can leave a *surviving* entry queued — its `finally` looks up its own object by identity and finds it already shifted (`src/plugin.ts:1106-1107`), so the array keeps the other spawn's entry, and a later summon can inherit that stale title.

This is accepted, not fixed. The code says so in place: "Claim is FIFO, so the single-spawn case (the normal one) is exact; two dispatchers summoning at the same instant could swap labels — accepted" (`src/plugin.ts:694-699`). The owner's 2026-10-29 ruling keeps that decision and requires the defect to be filed here.

## Evidence

- `src/plugin.ts:701` — `const spawnTitlesInFlight: Array<{ readonly title: string }> = [];` — plugin-scoped array, one per `apply`, not per session and not keyed by id.
- `src/plugin.ts:1100-1109` — the wrapper pushes `{ title: opts.title }` before `await host.spawnDispatcher(opts)`; the `finally` removes *its own* object via `indexOf` + `splice`. Correct for the object it pushed; blind to which entry the hook consumed.
- `src/plugin.ts:765-771` — `onDispatcherSpawned` does `const pending = spawnTitlesInFlight.shift();` and passes `title: pending.title` into `lifecycle.activate`. The hook *does* receive `sessionId`; the queue is simply not keyed by it.
- `src/adapter/cordis-dsh-host.ts:2520-2538` — the hook is invoked from the create `setup`, i.e. inside `host.spawnDispatcher`, before the spawn resolves.
- `src/adapter/cordis-dsh-host.ts:1585-1622` — `activateSpawnedDispatcher` calls `onDispatcherSpawned(childAgent, sessionId, generation)` (`:1605`) and has no title to pass; the hook's documented signature is `(agent, sessionId, generation)` (`src/adapter/cordis-dsh-host.ts:401-405`).
- `src/adapter/parent-agent.ts:331` and `:490-492` — the title becomes the peer's roster label in the lifecycle (`spawnTitles` map, keyed by session id, set in `bindActivation`).
- `src/adapter/parent-agent.ts:369` — `label: readPeerLabel(peerAgent.session) ?? spawnTitles.get(sessionId) ?? null` — a summoned session has no `subagent.label` (`src/adapter/peer-label.ts:52-69`), so the title is the only label source for it; a swapped title is the label.
- `src/plugin.ts:694-699` — the accepted-defect record, in place.
- Related, same neighbourhood but NOT this ticket: the title is never persisted (`DurableDispatcherMark` carries `sessionId`, `parentSessionId?`, `generation?` only — `src/core/durability.ts:128-153`), so a cold-resumed summoned dispatcher already falls back to its raw session id. Do not fold that into this ticket's fix.

## Acceptance

- [ ] Two concurrent `spawn_dispatcher` calls from two different dispatcher sessions bind each child with **its own** title: a test that starts both spawns before either create's `setup` runs asserts title↔dispatcher-id pairing in both directions, not just that both labels are non-empty.
- [ ] The pairing is structural, not positional: the claim is keyed by the session id the hook already receives, or the title is passed through the host seam into the hook, so no entry can be consumed by a different spawn.
- [ ] A summon that fails before its `setup` fires leaves no entry behind for a later summon to inherit (assert the queue is empty after a refused spawn that raced a successful one).
- [ ] The single-spawn path is unchanged: one summon still yields exactly its own title, and `lifecycle.activate` still receives `{ generation, title }` unchanged.
- [ ] No new cap, budget, or spawn limit is introduced (ADR-0025 decision 5 / ADR-0032: no cap of ours), and nothing here writes into another session's log or resumes without an explicit `followup`.

## Constraints

- Offline only. A unit test over the structural host stub is the evidence path; no live dsh, no LLM, no server, no client rebuild.
- Do not touch ADR bodies. A dated note on a Status line is the only permitted ADR edit.
- Do not re-open ADR-0032's settled decisions (top-level creation, no parent/origin/depth, no cap, cold resume in v1, one policy for every dispatcher, no `"spawned"` policy variant).
- Keep the change inside `src/plugin.ts` and, if the title is threaded through, the host seam in `src/adapter/cordis-dsh-host.ts`; the roster read in `src/adapter/parent-agent.ts:369` stays as-is.
- The fix must not make the label depend on the spawn resolving first — the hook fires before the spawn returns.

## Comments

2026-10-29: Filed from the owner's 2026-10-29 ruling on the review of ticket 157. Read in this working tree: `src/plugin.ts:683-701,752-771,1090-1109`, `src/adapter/cordis-dsh-host.ts:1585-1622,2433-2599`, `src/adapter/parent-agent.ts:331,362-377,478-508`, `src/adapter/peer-label.ts:52-69`, `src/core/tools.ts:1522-1541`, `src/core/durability.ts:128-153`. No source, test or client file was modified by this filing; the reviewer's other findings from that review live on ticket 157's review, not here.

Scope note: this ticket is only the label-pairing race. The unrelated, pre-existing gaps found alongside it — a summoner with no `header.cwd` producing a peer that `resolveAgent` can never cold-resume, the never-cleared `resumedUserDispatchers` guard that skips re-activation of a re-announced dispatcher, and `readSessionController`'s unguarded final property read — are reported as review findings and are not part of this ticket.