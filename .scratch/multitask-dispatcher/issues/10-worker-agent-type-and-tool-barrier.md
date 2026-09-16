# 10 — Worker agent type + tool barrier

**What to build:** What a worker actually is. It gets the full set of work tools and nothing else: no way to talk to the user, no way to reach another agent, no way to spawn, and no todo list. Its prompt is self-contained and its final answer is the stream's report.

**Blocked by:** 09 — dsh adapter wiring.

**Status:** ready-for-human

- [x] A worker starts with a blank context — no dispatcher memory, no sibling transcripts, no user chat.
- [x] A worker is offered the work tools (shell, filesystem, search, web, and the other task tools as available).
- [x] A worker is not offered, and cannot execute, any user-messaging tool, any peer/agent-messaging tool, any spawn tool, any worker-management tool, or any todo tool. The restriction removes them from the worker's prompt and refuses execution.
- [x] The worker's prompt states: it is a delegated worker, it must complete the task autonomously, it has no way to talk to the user, it must not ask follow-ups, and it must end with a concise plain-text final answer that goes back to the parent.
- [x] A worker's final text arrives as that stream's report; an empty result is replaced with a placeholder noting no text output, and an error outcome carries the error message.
- [x] A worker never spawns another worker — attempting it is impossible via the tool barrier, not merely discouraged.

## Implementation notes (ready-for-human review)

### What landed (design: `.scratch/multitask-dispatcher/design-10-worker-agent-type.md`)

- `src/worker/` — worker agent type modules (new copy only; core untouched).
  - `tool-barrier.ts` — `WORKER_DENIED_TOOL_CANDIDATES` + `buildWorkerToolFilter(knownGlobals)`: deny-list **intersected** with live global tool names (host `tools.restrict()` throws on unknown names; never pass a hard-coded list blindly). Deny-list, not allow-list, so work tools stay when the profile changes.
  - `prompt.ts` — `buildWorkerSystemPrompt()` with stable sections Role → Autonomy → Limits → Todo ledger → Work style → Final answer; `assembleWorkerPrompt(system, task)`.
  - `report.ts` — `EMPTY_WORKER_REPORT_PLACEHOLDER`, `normalizeWorkerReport` (empty → placeholder), `normalizeWorkerErrorReport` (error message passthrough; empty → wrapper).
  - `agent-def.ts` — `createWorkerAgentDef()` → `{ systemPrompt, resolveToolFilter, maxDepth: 0 }`. Constructor-injected into the adapter (design Option A); FakeDshHost / `DshHost` / `SpawnOptions` unchanged.
- `src/adapter/cordis-dsh-host.ts` — T10 follow-up on T09's optional def:
  - Spawn path uses real `WorkerAgentDef`: assembles system + task; resolves toolFilter against `listGlobalToolNames(ctx)` **per spawn** (no cache across HMR); omits `toolFilter` when deny is empty (host rejects empty filters); `maxDepth` from def (0).
  - Settle path: `normalizeSettleReport(status, blocks)` — completed empty → placeholder; error passes message; aborted invents nothing.
  - `AdapterContext.tools?` structural `schemas()` for global names.
- `src/plugin.ts` — injects `createWorkerAgentDef()` into the host; adds `tools` to `inject`.
- `src/index.ts` — exports worker public surface.
- `src/core/**` — **zero edits**. `FakeDshHost` untouched.

### AC coverage

| AC | How |
|---|---|
| Blank context | In-process spawn provider (T09); no parent memory passed. |
| Work tools only | Deny-list keeps bash/read/write/web/…; only forbidden categories are removed. |
| No user/peer/spawn/job/todo tools | Host `toolFilter.deny` (prompt removal + execution refuse) + prompt Limits section. |
| Self-contained prompt | `buildWorkerSystemPrompt()` + task assembly. |
| Final text = stream report | Settle uses last-assistant text as `SettledEvent.report`. |
| Empty → placeholder | `EMPTY_WORKER_REPORT_PLACEHOLDER`. |
| Never spawns | `subagent` denied when present + `maxDepth: 0` + prompt leaf statement + not composed on workers. |

### Tests

- Suite: **149 pass / 0 fail** (was 129).
- New: `test/worker-agent-type.test.ts` (filter intersection, prompt sections/order/vocab, report normalization, createWorkerAgentDef).
- Updated: `test/adapter-cordis-dsh-host.test.ts` (def injection, empty-filter omit, settle placeholder/error/abort), `test/plugin-scaffold.test.ts` (inject list).
- Typecheck + build clean. No network.

### Human smoke still needed (design §7.5)

1. Spawn a worker against live dsh; confirm child tool list has no `present` / `todo_write` / `subagent` / `send_message`.
2. Ask the worker to call a denied tool if it "can" — model should not have it; hallucinated call → host `UNKNOWN_TOOL`.
3. Worker that finishes with no assistant text → settle report equals the placeholder.
4. Nested spawn impossible: `subagent` absent + `maxDepth: 0`.

### Residual risks / T11 handoff

- Approval pin `'never'` on children is untouched (T13 owns relay).
- Empty deny omits toolFilter — safe when profile has none of the forbidden tools loaded; live multitask profile must still not compose `dsh-tool-subagent` onto workers.
- `run_code` / PTC transport cannot be named in restrict (documented gap in design §8).
- Worker resume (cold-resume of continuable children) is **not** blank-spawn reuse — separate decision.
- dsh developer-preview drift: pin `0.1.5-rc.1`; re-verify tool names at integration.
