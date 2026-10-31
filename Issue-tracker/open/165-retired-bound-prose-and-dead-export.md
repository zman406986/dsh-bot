# 165 — Retired subagent-bound prose and a dead export still describe the old spawn shape

**Status:** open
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

- [ ] Every claim in the table is rewritten to match the `ctx.agents.create` path, or removed.
- [ ] `dispatcherSpawnMaxDepth` is deleted along with its re-exports and its test, or a comment states why it is kept despite having no caller.
- [ ] `activateSpawnedDispatcher` is renamed to something true, or a comment states the name is historical.
- [ ] No behaviour changes. This is prose and dead code only.
- [ ] `npx tsc -p tsconfig.json --noEmit` exits 0 and the full offline suite still passes.

## Constraints

- Do not re-open ADR-0032's settled decisions; this ticket only makes the code describe them.
- Do not edit ADR bodies. A dated Status-line note is the only permitted ADR edit.
- Keep it out of ticket 157's diff.