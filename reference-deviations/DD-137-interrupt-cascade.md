# DD-137 — Parent-interrupt cascade & background drain vs per-worker stop only
- **Area:** agent runner / turn execution (A16)
- **Type:** behavior-delta (unruled)
- **Date:** 2026-09-23

## What the reference does
Deleting (or interrupting) a parent agent tears down its whole subtree: the lifecycle code calls each runner's interrupt-everything entry point with an agent-deleted reason — which interrupts the runner's own run **and every live subagent session** — then waits for the exclusive-run drain and the background-subagent drain on both runners before finishing teardown, so no background subagent work outlives its parent (the reference tree's `source/host/extensions/transcript/agent-lifecycle.ts:482-496`; the reference tree's `source/host/runner/sand-agent-runner.ts:1165-1175`). A subagent is never left orphaned by a parent-level stop.

## What the current build does
Worker abort is strictly per-worker. `abortWorker` exists only as the dispatcher stop tool's implementation and takes a single `workerId` (`src/core/tools.ts:528-536`; `src/core/multitask.ts:621`). Removing a task from the dispatcher neither interrupts its live worker nor drains in-flight subagent work: the worker keeps running, and its settle still reaches the parent afterward via the wake bus / durability path. There is no interrupt-everything-style cascade anywhere in `src/`.

## The deviation
The reference guarantees that stopping a parent stops everything beneath it, with everything drained before teardown finishes. The build has no such guarantee: a "stop" of the parent-side task leaves the worker alive by design, and there is no user-facing "stop everything now" control at all. No row in the deviations register covers a parent-interrupt cascade or background drain (`docs/research/dsh-core-loop-deviations.md` — the only interrupt rows are D-4 restart recovery and D-7 steer timing, neither about cascade), so this is **unruled**.

## Verdict: ASK-HUMAN
Both sides are defensible, and the build's choice is tied to DD-097 (dispatcher deletion = unbind, never dispose — `reference-deviations/DD-097-deletion-semantics.md`, verdict DO-NOT-INCORPORATE): deliberately leaving workers running so their results still arrive is arguably a feature, consistent with that ruling's non-destructive spirit, and draining them on unbind would discard work the parent still wants. But the reference's invariant — no orphaned background work after a parent stop — is a real safety property, and today the only remedy is stopping workers one by one; nothing in the authority stack (PRD, ADRs, register) records a ruling either way, and ADR-0018's exception-list discipline means silently adopting either the reference cascade or the leave-running behavior is not an option. The human should rule: keep leave-running as designed (and document it), or add an explicit stop-all/cascade control. Until ruled, change nothing.

## Incorporation notes
- **Where it would live:** a cascade option on the dispatcher's removal path plus an optional drain before teardown (`src/core/multitask.ts` beside `abortWorker`), or a dedicated stop-all tool in `src/core/tools.ts`; if ruled leave-running, the note belongs in the PRD's dispatcher semantics instead.
- **Constraints:** any drain must not break the durability/wake-bus settle path (late settles after an interrupt must still be rejected or absorbed cleanly); must work together with DD-097's unbind-not-dispose semantics; the last-wins steer slot (D-7) is untouched.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a cascade-interrupt plus drain is small code, but the interactions after an abort settles (durability rebuild, wake bus) make the testing surface medium.
- **Key reference anchors:** `agent-lifecycle.ts:482-496` (interrupt-everything on delete, then the exclusive-run and background-subagent drains); `sand-agent-runner.ts:1165-1171` (the interrupt-everything call covers every live subagent session); `sand-agent-runner.ts:1173-1175` (the background-subagent drain).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/agent-lifecycle.ts` (lines 482-496), `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/sand-agent-runner.ts` (lines 1165-1175)
- Build: `src/core/tools.ts` (lines 528-536), `src/core/multitask.ts` (line 621), cross-ref `reference-deviations/DD-097-deletion-semantics.md`, register `docs/research/dsh-core-loop-deviations.md` (no cascade row)
