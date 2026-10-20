# DD-132 — Per-turn step ceiling vs none
- **Area:** agent runner / turn execution (A16)
- **Type:** missing-feature (unruled)
- **Date:** 2026-09-23

## What the reference does
The reference caps every sand-agent turn at a fixed number of model steps. A named constant (5,000) is exported from the turn-composition module and passed into the agent's runner options; the runner's turn loop is a bounded for-loop over that count, and if the loop exhausts without the turn completing, the runner throws a hard step-exceeded error, ending the turn as a failure rather than letting it run on. The bound is a runaway guard: no matter how confused the model or how tool-happy the loop, a turn terminates after a known worst case.

## What the current build does
The build has no per-turn ceiling of any kind. `src/core/multitask.ts` already counts tool calls per worker (`noteToolCall`, declared on the host interface and implemented in the core), but nothing checks that count against a limit — the count is bookkeeping, not a limit. A worker stuck in a productive-but-endless loop stays live indefinitely; the dispatcher's stance is that liveness is visibility only (the host surfaces worker state, it never auto-stops). Nothing in the core-loop deviation register covers a steps/ceiling row, so this gap was never ruled on.

## The deviation
The reference enforces a worst-case turn length via a step ceiling; the build enforces nothing, so a runaway worker turn is unbounded in both duration and cost. This is a gap against the reference (the reference has a protection the build lacks) and an unruled one — absent from the deviation register.

## Verdict: ADAPT
The intent (a hard worst-case per-turn bound) is worth incorporating — unbounded cost exposure is the failure mode the reference's ceiling exists to prevent, and ADR-0018's imitate-the-reference rule treats missing reference protections as gaps rather than optional extras. But the mechanism cannot transfer as-is: worker turns are host loops, so the core cannot count model steps, only the tool calls it already observes via `noteToolCall` — a build-side bound would be a core-side automatic stop that trips `stopWorker` past a tool-call threshold, which changes the rule that liveness is visibility only and touches the semantics of an abrupt stop (partial transcript, in-flight steers). The threshold number must also be re-derived (the reference's 5,000 steps are not comparable to tool-call counts). Because this is unruled and changes the visibility-only rule, it should go through the normal ticket/ADR path rather than be wired in silently.

## Incorporation notes
- **Where it would live:** `src/core/multitask.ts` — a threshold check inside or beside the existing `noteToolCall` counting path, escalating to the core's `stopWorker`; configuration (threshold value, on/off) alongside the other dispatcher options.
- **Constraints:** the core can only observe tool-call counts, not model steps, so the limit is necessarily a substitute measure (a tool-call automatic stop), not a step ceiling; tripping it means an abrupt `stopWorker`, so the ruling must cover what the worker's partial state looks like afterward and how the parent is told the turn died vs. ended; the constant must be independently derived (ADR-0018 B9 — do not copy 5,000 or its rationale verbatim); until ruled, the build's rule that liveness is visibility only stands.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the observation hook (`noteToolCall`) already exists, so the counter is cheap; the cost is policy: deciding the threshold, the stop semantics, and a change to the stance (auto-stop) that needs a human ruling first.
- **Key reference anchors:** `turn-agent-composition.ts:142` (exports the 5,000-step constant), `:272` (wired into runner options); `sand-agent-runner.ts:1266` (option default), `:1269` (bounded turn loop), `:1287` (hard throw past the bound).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/turn-agent-composition.ts` (lines 142, 272); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/sand-agent-runner.ts` (lines 1266, 1269, 1287)
- Build: `src/core/multitask.ts` (`noteToolCall` at lines 167 and 712; no step/ceiling bound anywhere in the file); `docs/research/dsh-core-loop-deviations.md` (grep for "step": no steps-ceiling entry — only the unrelated D-7 steer-timing row)
