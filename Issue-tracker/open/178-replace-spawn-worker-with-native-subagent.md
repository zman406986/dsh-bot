# 178 — Can `spawn_worker` be replaced by the host's `subagent` tool?

**Status:** open
**Type:** research / decision
**Labels:** needs-owner-decision
**Blocked by:** nothing.
**Origin:** owner question, 2026-11-04 (verbatim below).
**Related:** ADR-0003 (dispatcher-only spawning, workers are leaves), ADR-0007 (todo stays dispatcher-only, structural worker link), ADR-0019 (per-dispatcher scoped tools), ADR-0028 / ticket 122 (`reply_to_dispatcher`), ADR-0033 / ticket 174 (access-ask removed — do not re-add), ticket 120 (id reservation), ticket 142 (durable `worker_sessions` + dormant wake), ticket 145 (worker recall tool), ticket 176 (spawned dispatcher cannot summon).

## The owner's question, verbatim (2026-11-04)

> can we just use subagent and inject our worker prompt where needed? if so delete our reinvented spawn worker wheel

## Answer: **NO.** Keep `spawn_worker`.

`spawn_worker` is **not** a reinvention of the host's `subagent` tool. It already *calls the same host API* the host tool calls. What it adds is the accountability layer that makes a worker visible to this plugin at all — roster, stream key, ledger link, tool barrier, settle record, wake, and the reply tool. Every one of those is plugin-owned state that a natively-spawned child cannot enter, and there is no host seam that would let it.

The one thing the host tool genuinely provides that we cannot use is the same thing we do not want: a raw, unaccounted child.

## What `spawn_worker` actually adds

`src/core/tools.ts:730-841` is the model-facing verb. Its body is small; the weight is underneath.

| Mechanism | Where | Why it cannot move to the host tool |
|---|---|---|
| **Worker registry entry** | `src/core/multitask.ts:914-937` (`register`), populated at `src/adapter/cordis-dsh-host.ts:2477-2480` *before* `startActivation` | The core `workers` map is the only thing `check_workers` reads (`src/core/multitask.ts:1238-1254`) and the only thing `steer_worker` / `stop_worker` / `await_agent` key on. Nothing in the host's `subagent` path writes it. |
| **Reserved child id** | `src/adapter/cordis-dsh-host.ts:2473-2496`; `childId` passed as `spec.childId` | Ticket 120. The host mints an id when the spec carries none (`dsh-subagent/lib/index.js:1397`), and by then the child has already emitted `agent/created` and its first status edge. Reserving binds "this exact child" to "this exact roster row" before either can be observed. The host's tool never passes `childId`. |
| **`worker_sessions` durable row** | `src/core/multitask.ts:1044-1048`, table constant `src/adapter/durable-marker.ts:67` | Ticket 142: the wake identity. A send to a settled-then-dormant worker cold-resumes it *because this row exists*. Written only from `multitask.spawnWorker`. |
| **Stream-key uniqueness** | `src/core/multitask.ts:854-879` | PRD line 414 ("Duplicate workers for same stream — `stream_key` uniqueness while running") and PRD line 258. The host tool's schema has no stream key at all (`dsh-tool-subagent/lib/index.js:385-419`: `cwd`, `description`, `prompt`, optional `agent_preset` / model route). |
| **Todo link** | `src/core/multitask.ts:791-797` (create when omitted) + `:1000` (`todoLedger.linkWorker`) + `:1167-1174` (`noteTurnStarted` → `in_progress`) | ADR-0007's structural todo↔worker link, and PRD line 118 ("todo entry before spawn"). The host tool's schema has no `todo_id`. |
| **Worker contract (persona)** | `src/worker/preset.ts:91-100`, text from `src/worker/prompt.ts:94-147` | Registered as a scoped `deployment:persona-prefix` section *recomputed every turn*, so compaction cannot drop it. This is the "inject our worker prompt" half of the owner's question — see the crux below. |
| **Tool barrier** | `src/worker/preset.ts:101-118` + `src/worker/tool-barrier.ts:14-52` | Denies `subagent`, `send_message`, `interrupt_agent`, `todo_write`, `present`, `ask_user_question`, the whole dispatcher surface, and the peer verbs. A child inherits the parent's composition (`dsh-subagent/lib/index.js:373-383`), so without this a worker keeps the dispatcher's tools. |
| **`reply_to_dispatcher` + recall** | `src/core/tools.ts:452-...`, `:665-670`; wired `src/plugin.ts:681-704`; gate `src/plugin.ts:688-692` → `src/adapter/cordis-dsh-host.ts:1399-1401` | Registered on the child's own scope only (ticket 122 / ADR-0028). The gate is `host.owns(sessionId)`, i.e. the roster — so a child outside the roster can never send a mid-task reply. |
| **Settle record + wake** | `src/adapter/cordis-dsh-host.ts:1532-1566` (`subagent/end`), gated at `:1538` by `workers.has(workerId)`; consumer `src/core/multitask.ts:764-837` | The settle record, the FSM terminal transition, the durable marker, and the wake all hang off `workers.has`. A child not in the roster has its settle event dropped on line `:1538`. |
| **Dormant-worker wake** | `src/adapter/cordis-dsh-host.ts:1426-1491`, `:2314` | Ticket 142's children half: park the correction, cold-resume, deliver on activation. Keyed entirely on the `worker_sessions` mirror. |
| **Leaf budget** | `src/worker/agent-def.ts:66`, `:81-86` → `src/adapter/cordis-dsh-host.ts:2443-2452` | The worker lands one hop down with zero budget below (`parentDepth + 1 + 0`). The host service's default is `maxDepth: 1` (`dsh-subagent/lib/index.js:2978-2980`), so a worker spawned without our derivation could open another level. The barrier removes the tool, but the ceiling is stated twice on purpose. |

`request_access` is **not** in this list. It was deleted in commit `643a801` (ticket 174 / ADR-0033). Do not re-add it.

## What the host's `subagent` tool gives a child natively

Read from the installed host (`C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`):

| Question | Answer | Evidence |
|---|---|---|
| Accepts a `persona`? | **No.** Removed. Passing it throws at mount. | `dsh-tool-subagent/lib/index.js:355` — `for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field)) throw new Error(... 'is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset')` |
| Accepts a tool filter? | **No.** Same throw, same line. | `dsh-tool-subagent/lib/index.js:355` |
| Instead: agent preset? | **Yes**, but only if the tool instance is configured with `agentPreset` / `allowedAgentPresets`, and only on the `spawn` provider. | `dsh-tool-subagent/lib/index.js:201-256`, `:400-404`; runtime check `dsh-subagent/lib/index.js:3312` |
| Exposes a completion notice? | **Yes** — and this part is good. The parent gets a queued/steered message with the stopping reason and the child's closing message. | `dsh-subagent/lib/index.js:2048-2058`, `:508-533` |
| Can a plugin observe the child's creation and compose it? | **It can observe. It cannot identify reliably.** | See crux below. |
| Is `maxDepth` defaulted? | **Yes, 1.** | `dsh-subagent/lib/index.js:2978-2980` |
| Does it send `childId`? | **No.** The host mints it. | `dsh-tool-subagent/lib/index.js:475-481`; `dsh-subagent/lib/index.js:1397` |

Note on ticket 174: our access tool is gone, so "the host child gets no access relay" is no longer a difference. Correct — and it is deliberately not counted above.

## The crux: can a plugin inject the worker contract into a HOST-spawned child?

**Observation is possible. Identification is not reliable, and composing is not desirable.**

1. **The hook fires.** `agent/created` is a global serial event (`dsh-agent/lib/index.js:574-593`), and `dsh-tool-subagent` itself listens on it (`dsh-tool-subagent/lib/index.js:605-607`). So `src/adapter/cordis-dsh-host.ts:2078` would receive a host-spawned child too. The seam is not the blocker.

2. **The gate is ours, not the host's.** `src/adapter/cordis-dsh-host.ts:2146` — `if ((pendingSpawns.get(parentSessionId) ?? 0) === 0) return;`. Only `spawnWorker` increments it (`:2483-2486`). This is a deliberate fence; the comment at `:1094-1099` says so explicitly: *"a dispatcher can also delegate through the host's own `subagent` tool, whose child must not receive the worker composition."*

3. **Could the fence be widened?** Not without inventing a discriminator. Every candidate fails:
   - `session.header.origin` — `"subagent"` for **both** paths (`dsh-subagent/lib/index.js:354`).
   - `subagent/descriptor.provider` — `"spawn"` for **both** (our `SPAWN_PROVIDER`, `src/adapter/cordis-dsh-host.ts:677`).
   - `subagent/descriptor.label` — our title vs the model's free-text `description` (`dsh-tool-subagent/lib/index.js:390-394`). Both are arbitrary strings.
   - Absence of `childId` — we reserve one, the host mints one. Structurally this *is* a discriminator, but only readable from inside `startActivation`, which a plugin does not own; by `agent/created` the difference has already been erased from the session header.

   The only remaining discriminator would be sniffing the parent's `tool/call` name (`dsh-agent-loop/lib/index.js:580`, `:681-686` carries `name`). That is a new, unsound coupling: it depends on tool-call/creation ordering under concurrency, on a failed call un-arming the counter, and on no other plugin registering a tool with the same name.

4. **And composing would be wrong even if it were identifiable.** The host tool's documented job is *a separate agent that works in its own context* — "returns its result, not its intermediate steps" (`dsh-tool-subagent/lib/index.js:343-344`). Silently turning every such child into a barred, contract-bound leaf would break the host's own advertised semantics for a verb the dispatcher is entitled to use. The dispatcher may legitimately want a raw subagent.

5. **The composition API the host *does* bless does not help us.** It points at Agent Presets (`dsh-tool-subagent/lib/index.js:355`). A preset could carry the contract text and the tool list. It cannot carry the roster entry, the stream key, the todo link, the `worker_sessions` row, or the settle/wake — those are plugin state keyed on a spawn the preset never sees.

## What would actually break if we deleted `spawn_worker`

Concretely, if the dispatcher were told to use `subagent` instead:

| Capability | Result | Why (file:line) |
|---|---|---|
| `check_workers` sees the child | **No.** Returns nothing — the child is not in `listWorkers`. | `src/core/multitask.ts:1238-1254`; map written only at `:917` inside `spawnWorker` |
| `steer_worker` reaches it | **No.** Refuses `unknown-worker`. | `src/core/multitask.ts:1115-1139`: `workers.get` miss → `findDurableWorker` miss → refusal |
| `message_agent` reaches it | **No.** Same steer branch; `durableWorkerParent` also misses. | `src/core/multitask.ts:1208-1272` |
| `stop_worker` stops it | **No.** `abortWorker` throws, mapped to an `already-settled` refusal. | `src/core/multitask.ts:1076-1078`; `src/core/tools.ts:1022-1029` |
| `await_agent` waits on it | **No.** `unknown-target`. | `src/core/settle-records.ts:460-488` |
| Settle record / wake / ledger advance | **No.** The `subagent/end` listener returns before doing anything. | `src/adapter/cordis-dsh-host.ts:1538` — `if (!workers.has(workerId)) return;` |
| Todo created and linked before spawn | **No.** No `todo_id` in the host tool's schema. | PRD line 118; `src/core/tools.ts:791-797`, `:1000` |
| Stream-key uniqueness | **No.** No stream key in the schema. | PRD line 414; `src/core/multitask.ts:854-879` |
| `reply_to_dispatcher` exists for it | **No.** Never registered; and the gate would refuse. | `src/worker/preset.ts:101-118`; `src/plugin.ts:688-692` → `src/adapter/cordis-dsh-host.ts:1399-1401` |
| Dormant wake after restart | **No.** No `worker_sessions` row. | `src/core/multitask.ts:1044-1048` |
| Worker contract survives compaction | **No.** Never registered on the child. | `src/worker/preset.ts:91-100` |
| Tool barrier (no `subagent`, no `todo_write`, no dispatcher tools) | **No.** The child inherits the dispatcher's surface. | `src/worker/tool-barrier.ts:14-52`; inheritance `dsh-subagent/lib/index.js:373-383` |

The child would still run, still get the host's completion notice, and still be stoppable through the host's own `interrupt_agent` — but it would be invisible to every dispatcher tool this plugin ships, and its work would never enter the ledger.

## Why the wheel is not a reinvention

The spawn transport was never rewritten. `CordisDshHost.spawnWorker` (`src/adapter/cordis-dsh-host.ts:2412-2526`) builds a `request` and calls **`ctx.subagents.startActivation`** (`:2493-2500`) — the identical API and the identical `provider: "spawn"` that the host's own tool uses (`dsh-tool-subagent/lib/index.js:475-481`). There is no second subagent runtime, no second child factory, no parallel session machinery.

What we wrote on top is not a spawner. It is the bookkeeping that lets a dispatcher *supervise* what it spawned, plus the child-side contract that keeps a worker a leaf. Neither exists anywhere in the host's delegation path, and neither can be reached from it.

## A real finding, next to the question: two spawn verbs on one surface

The dispatcher's surface can carry **both** `spawn_worker` and the host's `subagent`:

- the deployed `ptc` preset mounts the host tool (`dsh-web-app/presets/ptc.patch.yml:93-98`, `provider: spawn`, `toolName: subagent`);
- the `tool-subagent` rows are disabled at the host plane and re-mounted by presets (`dsh-web-app/cordis.patch.yml:555-566`), so a session under `ptc` gets it;
- our plugin never restricts the dispatcher's surface — `tools.restrict` is called only on a child (`src/worker/preset.ts:107`);
- the worker barrier denies `subagent` (`src/worker/tool-barrier.ts:22`), which is only meaningful because the name is visible on the inherited surface.

So the honest form of the owner's instinct is: *the dispatcher has two ways to spawn, and only one of them is tracked.* That is a real clutter problem. The fix is to withhold `subagent` / `subagent_fork` from the dispatcher's surface, not to delete the tracked verb. Recorded as a follow-up below; not done here.

## Decision

**Keep `spawn_worker`. Do not delete it, and do not route worker spawning through the host's `subagent` tool.**

`spawn_worker` is the same host call the native tool makes, plus the roster entry, the reserved id, the durable wake row, the stream key, the todo link, the contract, the barrier, the reply tool, and the settle/wake path. Deleting it deletes every one of those, and the host offers no seam to put them back on a natively-spawned child.

The worker *contract* could in principle move into an Agent Preset — but that only relocates the persona text. It retrieves none of the accountability, so it does not make the deletion possible and is not worth a migration on its own.

## Follow-up (separate ticket, not this one)

Withhold `subagent` and `subagent_fork` from the dispatcher's tool surface so there is exactly one spawn verb, and one that the ledger can see. Barrier denial alone is not enough: it protects children, not the dispatcher's own choices.

## Comments
