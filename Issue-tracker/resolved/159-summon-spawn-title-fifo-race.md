# 159 — `spawnTitlesInFlight` pairs a summon's title by queue position, so two simultaneous summons can swap labels

**Status:** resolved
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

- [x] Two concurrent `spawn_dispatcher` calls from two different dispatcher sessions bind each child with **its own** title: a test that starts both spawns before either create's `setup` runs asserts title↔dispatcher-id pairing in both directions, not just that both labels are non-empty.
- [x] The pairing is structural, not positional: the claim is keyed by the session id the hook already receives, or the title is passed through the host seam into the hook, so no entry can be consumed by a different spawn.
- [x] A summon that fails before its `setup` fires leaves no entry behind for a later summon to inherit (assert the queue is empty after a refused spawn that raced a successful one).
- [x] The single-spawn path is unchanged: one summon still yields exactly its own title, and `lifecycle.activate` still receives `{ generation, title }` unchanged.
- [x] No new cap, budget, or spawn limit is introduced (ADR-0025 decision 5 / ADR-0032: no cap of ours), and nothing here writes into another session's log or resumes without an explicit `followup`.

## Constraints

- Offline only. A unit test over the structural host stub is the evidence path; no live dsh, no LLM, no server, no client rebuild.
- Do not touch ADR bodies. A dated note on a Status line is the only permitted ADR edit.
- Do not re-open ADR-0032's settled decisions (top-level creation, no parent/origin/depth, no cap, cold resume in v1, one policy for every dispatcher, no `"spawned"` policy variant).
- Keep the change inside `src/plugin.ts` and, if the title is threaded through, the host seam in `src/adapter/cordis-dsh-host.ts`; the roster read in `src/adapter/parent-agent.ts:369` stays as-is.
- The fix must not make the label depend on the spawn resolving first — the hook fires before the spawn returns.

## Comments

2026-10-29: Filed from the owner's 2026-10-29 ruling on the review of ticket 157. Read in this working tree: `src/plugin.ts:683-701,752-771,1090-1109`, `src/adapter/cordis-dsh-host.ts:1585-1622,2433-2599`, `src/adapter/parent-agent.ts:331,362-377,478-508`, `src/adapter/peer-label.ts:52-69`, `src/core/tools.ts:1522-1541`, `src/core/durability.ts:128-153`. No source, test or client file was modified by this filing; the reviewer's other findings from that review live on ticket 157's review, not here.

Scope note: this ticket is only the label-pairing race. The unrelated, pre-existing gaps found alongside it — a summoner with no `header.cwd` producing a peer that `resolveAgent` can never cold-resume, the never-cleared `resumedUserDispatchers` guard that skips re-activation of a re-announced dispatcher, and `readSessionController`'s unguarded final property read — are reported as review findings and are not part of this ticket.

## Comments

2026-11-04: **The host half of the fix landed; the plugin half did not, and the defect is still live.** Recording this honestly rather than closing it.

### What was done

The structural change was made where it removes the queue from the problem: the title now travels THROUGH the host seam.

- `CordisDshHostOptions.onDispatcherSpawned` gained an optional fourth argument, `title?: string` (`src/adapter/cordis-dsh-host.ts:405-410`).
- `activateSpawnedDispatcher` takes that title and passes it straight to the hook (`:1685-1719`).
- The spawn site passes `opts.title` on the call that names the child (`:2785-2798`). The child's id is already fixed at that point (it is the reservation handed to `agents.create` as `sessionId`), so the label and the session id it belongs to travel on the same call.

This is the same answer this repo already uses for the identical class of problem: the reserved child id (`spawnDispatcher`'s `randomUUID()` passed as `spec.childId`/`sessionId`) makes `agent/created` recognise a child by IDENTITY rather than by the per-parent `pendingSpawns` counter. The title now rides that same identity, so no entry can be claimed by a different spawn.

Four tests pin it in `test/spawn-dispatcher-host.test.ts`, including the exact interleaving from this ticket — summon A parks before `setup`, summon B completes first, A releases after — asserting title↔dispatcher-id pairing in both directions. Each was verified to fail with the title dropped from the hook call.

### Why the ticket is NOT resolved

The defect's own code is in **`src/plugin.ts`**, not in the adapter:

- `src/plugin.ts:635` — `const spawnTitlesInFlight: Array<{ readonly title: string }> = [];`
- `src/plugin.ts:719` — `const pending = spawnTitlesInFlight.shift();`
- `src/plugin.ts:906-915` — the wrapper's push and identity-based `finally` removal.

This lane's file-ownership list does not include `src/plugin.ts` (another lane owns it), so those three sites were left untouched. Until they change, the plugin still pushes into the array and still claims by `shift()`, and the new hook argument is simply ignored — **so two simultaneous summons can still swap labels.** The host seam is ready; the plugin must consume it.

### What the remaining change is (for whoever owns `src/plugin.ts`)

1. Delete the `spawnTitlesInFlight` array (line 635) and its doc block.
2. In `onDispatcherSpawned` (line 718), take the new fourth argument and pass it through: `lifecycle.activate(agent, { generation, origin: "spawned", ...(title === undefined ? {} : { title }) })`. Drop the `shift()`.
3. Delete the `pendingTitle` push and `finally` splice in the wrapper (lines 906-915); the wrapper becomes a plain `return host.spawnDispatcher(opts)`.

That also removes the ticket's second-order symptom for free: with no queue, a summon that fails before its `setup` runs cannot leave an entry for a later summon to inherit. Acceptance criteria 2, 3 and 5 are met by the host half alone; criteria 1 and 4 need the plugin half to be observable end to end.

No cap, budget or spawn limit was introduced, and nothing here writes into another session's log.

2026-11-04: **Resolved — the plugin half landed and the queue is gone.** The host half was already in the tree (previous entry); this pass did the three `src/plugin.ts` edits and proved the fix end to end.

### The change (three edits, all in `src/plugin.ts`)

1. **Deleted `spawnTitlesInFlight`** and its doc block. The array and every word of the "claim is FIFO … accepted" record are gone (`src/plugin.ts:615-616` is now the start of the ticket-176 class map).
2. **`onDispatcherSpawned` takes the new fourth argument and passes it through** (`src/plugin.ts:702-717`). The `shift()` is gone; the hook is now `(agent, sessionId, generation, title)` and calls `lifecycle.activate(agent, { generation, origin: "spawned", ...(title === undefined ? {} : { title }) })`. `lifecycle.activate` still receives `{ generation, title }` unchanged on the single-spawn path, so acceptance criterion 4 holds byte-for-byte.
3. **The `spawnDispatcher` wrapper is a plain pass-through** (`src/plugin.ts:888-889`): `(opts) => host.spawnDispatcher(opts)`. The `pendingTitle` push and the identity-based `finally` splice are deleted with it.

Nothing else in the file changed. The ticket-179 spawn-verb withhold (`withholdHostSpawnTools`, `DispatcherScopedToolSurface`) is still present and untouched (`src/plugin.ts:59`, `:920-927`).

### Where the roster label comes from now

The one consumer of the old queue was the `title` field on `lifecycle.activate`'s options: `bindActivation` writes it into `spawnTitles` keyed by session id (`src/adapter/parent-agent.ts:519,528-530`), and `peerRosterFor` reads it as the per-peer `label` (`:397`). That path is unchanged — only its source moved, from a positional `shift()` to the `title` argument the host passes on the same call that names the child.

### Test that proves the swap cannot happen

`test/multi-dispatcher.test.ts:565-641` — "a summon released out of order binds each child with ITS OWN title". The stub host's `agents.create` parks every create BEFORE `setup` runs, then the test releases the **second** summon's create first, so its `setup` reaches the activation hook before the first summon's does. Both rosters are then read and asserted in BOTH directions: A's row for B carries "Beta job" and does NOT carry "Alpha job", and B's row for A carries "Alpha job" and does NOT carry "Beta job". A non-empty-label check would not pass this; only correct identity pairing does.

**Verified to fail on the old queue.** Re-adding `spawnTitlesInFlight` + `shift()` + the wrapper push, with everything else identical, fails that test with A's roster rendering `- Alpha job (<beta-id>)` — the second summon wearing the first summon's title, exactly the ticket's interleaving. Restoring the fix makes it pass. That temporary revert was not committed.

A second test (`:643-681`) covers the second-order symptom: a summon refused before any `setup` (summoner with no `cwd`) records no title, and a later successful summon from another session keeps its own title with the refused one's never appearing in any roster. Acceptance criterion 3.

### Acceptance, box by box

- Two concurrent summons bind each child with its own title, asserted in both directions — `test/multi-dispatcher.test.ts:565-641`.
- Pairing is structural: the title rides the hook call beside the reserved child id; no queue entry exists to be consumed by a different spawn (`src/plugin.ts:702-717`, `src/adapter/cordis-dsh-host.ts:2788-2798`).
- A failed summon leaves nothing to inherit — there is no queue; pinned at `test/multi-dispatcher.test.ts:643-681`.
- Single-spawn path unchanged — `lifecycle.activate` still gets `{ generation, title }`.
- No new cap, budget or spawn limit; nothing writes into another session's log.

### Verification run

`npx tsx --tsconfig tsconfig.client.json --test test/multi-dispatcher.test.ts test/plugin-scaffold.test.ts test/spawn-dispatcher-activation.test.ts` → **40 tests, 40 pass, 0 fail**. `npx tsc -p tsconfig.json --noEmit` → clean; `npx tsc -p tsconfig.client.json --noEmit` → clean. Full `npm test` was deliberately not run (repo rule: smallest set that can fail).

Recorded limit, unchanged and deliberately NOT folded in: the title is still not persisted (`DurableDispatcherMark` carries `sessionId`, `parentSessionId?`, `generation?`), so a cold-resumed summoned dispatcher falls back to its raw session id. The hook passes `undefined` on that path and `bindActivation` keeps the label the session was bound with. Same as the previous entry recorded.
