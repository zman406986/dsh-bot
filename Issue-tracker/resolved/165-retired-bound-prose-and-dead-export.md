# 165 — Retired subagent-bound prose and a dead export still describe the old spawn shape

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** nothing. Editorial; no behaviour change.
**Origin:** found by the ticket-157 review, 2026-10-29. Four sites were fixed in that pass; these remain because they sat outside the lanes' file scope.
**Related:** ticket 157, ADR-0032, ADR-0025 (decision 5, no cap of ours).

## Problem

Ticket 157 moved a summoned dispatcher off the subagent path. A summoned dispatcher is now a top-level session created through `ctx.agents.create`, so it has no parent, no origin, no depth, and is not subject to the subagent runtime's `maxDepth` ceiling or its 8-slot live-child pool. Several comments, doc strings and one export still say otherwise.

The review fixed five claims, including the model-facing `spawn_dispatcher` description in EN and ZH — a model was being told a bound that no longer exists. These remain:

| Site | What is stale |
|---|---|
| `src/core/tools.ts:1449-1455` | Lists `host-refused` as arising from "ACTIVATION_LIMIT_REACHED from the live-child pool, the maxDepth depth refusal, or an unbound parent". The first two cannot arise on the `ctx.agents.create` path. |
| `src/core/tool-results.ts:112-117` | "ADR-0025 settles that the host's `maxDepth` ceiling and live child pool are the only bounds." Not true of a top-level session. |
| `test/spawn-dispatcher-tool.test.ts:19` | Header comment lists "the depth ceiling" as a real host throw. |
| `src/adapter/cordis-dsh-host.ts:383-399` | `onDispatcherSpawned` doc says "add it to the lifecycle registry without the top-level gate" and "right after `startActivation` resolves". Both retired. |
| `src/worker/agent-def.ts` | `dispatcherSpawnMaxDepth` is still exported, and re-exported from `src/index.ts` and `src/worker/index.ts`, though **nothing calls it**. `test/spawn-dispatcher-host.test.ts:278-291` pins it. |
| `src/adapter/cordis-dsh-host.ts:1585` (used `:1737`, `:1990`, `:2532`) | The helper is still named `activateSpawnedDispatcher` although it now goes through the ordinary gate. Cosmetic. |

## Acceptance

- [x] Every claim in the table is rewritten to match the `ctx.agents.create` path, or removed.
- [x] `dispatcherSpawnMaxDepth` is deleted along with its re-exports and its test, or a comment states why it is kept despite having no caller.
- [x] `activateSpawnedDispatcher` is renamed to something true, or a comment states the name is historical.
- [x] No behaviour changes. This is prose and dead code only.
- [x] `npx tsc -p tsconfig.json --noEmit` exits 0 and the full offline suite still passes.

## Constraints

- Do not re-open ADR-0032's settled decisions; this ticket only makes the code describe them.
- Do not edit ADR bodies. A dated Status-line note is the only permitted ADR edit.
- Keep it out of ticket 157's diff.

## Comments

### 2026-11-04 — resolved

Prose, a rename, and one deletion. No behaviour change.

**`dispatcherSpawnMaxDepth` deleted** (coordinator ruled deletion over a
keep-with-comment). Removed from `src/worker/agent-def.ts` along with both
re-exports (`src/index.ts:62`, `src/worker/index.ts:3`), its test
(`test/spawn-dispatcher-host.test.ts`, the `ticket 118: dispatcherSpawnMaxDepth`
block), that file's import of it, and the one sentence in the surviving
`hostAccepts` comment that claimed it was "still checked below".

While there I removed `hostAccepts` itself: it was already unused at HEAD (its
only mention was that same comment), so leaving it would have been new dead
code. It takes no dependency and no test with it.

**Table, site by site:**

| Site | Rewritten to |
|---|---|
| `src/core/tools.ts` (`spawn_dispatcher` doc) | Drops `ACTIVATION_LIMIT_REACHED` live-child pool and the `maxDepth` refusal as impossible on this path. Still names what the host genuinely refuses here: no bound parent, plus ticket 176's one-level rule (a dispatched team leader cannot summon). Both were verified in `cordis-dsh-host.ts` before writing. |
| `src/core/tool-results.ts` (`SpawnDispatcherToolResult`) | The `maxDepth`/live-child-pool sentence now says those are subagent-runtime bounds that do not reach a top-level session at all. |
| `test/spawn-dispatcher-tool.test.ts:19` | Header no longer lists "the depth ceiling" as a real host throw; names the one-level rule instead. |
| `src/adapter/cordis-dsh-host.ts` (`onDispatcherSpawned` doc) | "without the top-level gate" removed — the summoned dispatcher goes through the ordinary gate — and the stale "right after `startActivation` resolves" replaced with the real path: the `setup` of the `agents.create` call, with the `agent/created` listener as the fallback for hosts with no create seam. |
| `src/adapter/cordis-dsh-host.ts` (`activateSpawnedDispatcher`) | Renamed `activateSummonedDispatcher` at all 6 sites, with a note that the name follows the summon and that the function now goes through the ordinary gate. |
| `src/worker/agent-def.ts` | See above — deleted. |

Two further mentions of the old helper name were corrected:
`src/adapter/parent-agent.ts:148` (kept as true history — "the pre-2026-10-28
spawn-time activation hook, then called `activateSpawnedDispatcher`" — while
naming the current helper) and a comment reference in
`test/spawn-dispatcher-tool.test.ts`. Two other stale mentions in
`src/core/dsh-host.ts` and a comment in `cordis-dsh-host.ts` named
`dispatcherSpawnMaxDepth`; both were rewritten when the export went.

**Checks.** `tsc -p tsconfig.json --noEmit`, `-p tsconfig.client.json` and
`-p tsconfig.test.json` all exit 0. Suites:
spawn-dispatcher-host, spawn-dispatcher-tool, spawn-dispatcher-activation,
tool-results, spawned-dispatcher-kind, worker-agent-type — 79/79 pass. Broader
smoke (multi-dispatcher-peer, multitask-peer, worker-composition,
plugin-scaffold, liveness, coexistence, restart-honesty, durable-roster) —
80/80 pass.

One pre-existing failure is NOT from this ticket: `test/composition-polish.test.ts`
"dormant boot registers nothing visible" expects 9 listeners and gets 10. It
fails identically at HEAD with these src edits stashed, and the 10th listener
(`agent/disposed`) comes from another lane's uncommitted
`cordis-dsh-host.ts` work.