# DD-131 — Generation-guarded turn shell & pause/quiesce states vs none
- **Area:** agent runner / turn execution (A16)
- **Type:** missing-feature (unruled)
- **Date:** 2026-09-23

## What the reference does
The reference wraps every host turn in a dedicated shell. The reference tree's `source/host/runner/turn-run-shell.ts` (the turn-shell factory) stamps each turn with the run's current generation number at start and re-checks it at settle/observe points, so work produced by a stale turn cannot be mistaken for current output. Supersede/interrupt requests are refused before dispatch unless they carry recovery payloads (the data needed to resume) and the run itself was started in a recovery-capable form (guard around line 488). When the turn's outcome is a UI widget or user selection rather than a finished answer, the shell ends the turn deliberately as a non-aborted pause (its end-turn-awaiting-user call, line 509) so the run can resume later without looking crashed. It also supports a cancellation that suspends the run for an upgrade: a cancellation caused by a stale generation or by the upgrade path flips the run into a quiesced-for-upgrade state (lines 466, 732, 798–799) that marks it as waiting to be resumed, keeping the final state distinct from an abort. The older loop in the reference tree's `source/host/runner/sand-agent-runner.ts` (its legacy run method) carries the same ideas inline.

## What the current build does
The build has no turn shell. `src/core/multitask.ts` lets turns run as native dsh host agent turns inside workers. `abortWorker` (multitask.ts:621) is the only stop mechanism: it refuses when the worker is already in a terminal status and otherwise transitions to aborted, drops parked steer and access-ask state, cancels linked todos, and interrupts the host worker. There is no per-turn generation stamp, no refusal of interrupts before dispatch based on whether the run can recover, no state meaning "turn ended waiting for a user widget/selection," and no suspend/resume concept anywhere in the dispatcher.

## The deviation
The reference treats a turn as a guarded, stateful unit: generation-checked, able to recover at the interrupt boundary, able to pause for user input, and able to park itself for an upgrade and resume. The build has only a binary running/terminal worker with a simple abort — stale-generation work, user-selection pauses, and upgrade-time suspension have no representation. No register row exists for this deviation yet (not in `docs/research/dsh-core-loop-deviations.md`); the restart/upgrade-adjacent parts overlap the scope of A20 (session and durability).

## Verdict: ASK-HUMAN
This is unruled — no register row and no covering ruling in the ADRs checked — and it overlaps A20 (restart and durability) territory, so the authority stack says stop and ask rather than pick silently. Structurally, in the build the turns are native dsh host agent turns, so a turn shell cannot wrap worker loops the way the reference's does; any generation guard, awaiting-user pause, or suspend state would have to live at the boundary between dispatcher policy and waking in `src/core/multitask.ts` (around spawn/abort/settle), which is a different placement with different semantics. Whether that placement is wanted at all — versus relying on dsh host durability (worker markers, ADR-0006) for the upgrade case — is a product/architecture call for the human, ideally coordinated with the A20 ruling.

## Incorporation notes
- **Where it would live:** `src/core/multitask.ts` — a generation counter bumped on supersede/upgrade at the boundary between dispatcher policy and waking; an awaiting-user terminal-ish status in the worker state machine; a suspend flavor of stop that writes a resume-pending marker through the existing durability mechanism instead of `deleteWorkerMarker`.
- **Constraints:** turns are native host agent turns, so guards must key on dispatcher-visible events (spawn/abort/settle), not wrap the loop; the mapping from an aborted worker to a cancelled todo (and dsh's lack of a paused state) constrains how an awaiting-user pause can be modeled; anything touching restart/resume must not preempt A20's scope.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — state-machine additions and a new stop flavor are contained, but the semantics (resume, how it interacts with the todo list, the A20 overlap) need a ruling first.
- **Key reference anchors:** the reference tree's `source/host/runner/turn-run-shell.ts` — generation field (369), supersede guard (the recovery-payload and recovery-capable-run checks, ~488), the end-turn-awaiting-user call (509), the host generation-stamp call (568), stale-generation check (723), the quiesced-for-upgrade state set (732) and resume-pending result shape (798–799); the reference tree's `source/host/runner/sand-agent-runner.ts` legacy run loop.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/turn-run-shell.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/sand-agent-runner.ts`
- Build: `src/core/multitask.ts` (abortWorker at 621–657; no generation/pause/quiesce state)
