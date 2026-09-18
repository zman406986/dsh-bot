# 60 — Deliver a steer at the nearest step, not at turn idle (deviation D-7)

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none for the investigation. **The implementation is gated on step 1's finding** — see below; if the step-level signal does not exist, this ticket's correct outcome is a register change, not a code change.
**Related:** register item **D-7** (`docs/research/dsh-core-loop-deviations.md` Part A — ruled `to-be-removed` on 2026-09-18); `docs/research/dsh-loop-capability-map.md` stage 5; ticket 55 (same file, different concern — coordinate if landing together)

## The deviation

A steer is currently parked in the single-slot queue and delivered only when the worker's `agent/status` goes **idle** — whole-turn quiescence (`src/adapter/parent-agent.ts:196-199` calls `host.emitStepBoundary(workerId)` on idle; `src/core/multitask.ts:380-388` pops and sends on that signal).

The semantics are right — interrupt, then deliver into the same session with context preserved, last-wins. What is wrong is the **timing**: the correction waits for the worker's whole turn to finish when the host can accept it at the next step. The capability map records the host's steer path as nearest-step (verified). Our timing is a conservative superset, which is why the human ruled it `to-be-removed` rather than something to approve.

## Step 1 — the gating question (do this first, and report the answer even if you stop)

**What per-step signal does the installed host actually expose?** Concretely:

- Does the host emit an event per **step** (a tool call + its result unwinding), as distinct from per **turn**? Look for the session/agent event firehose and what granularity it reports.
- Our adapter already binds `agent/status` (`idle`/`running`) in `src/adapter/parent-agent.ts:164-200`. Is there a finer companion event the host publishes on the same emitter?
- `dsh-subagent` exposes a `sendMessage` that the capability map records as steering the nearest step. **If `sendMessage` itself performs the step-level insertion, then the fix is not a new event at all** — it is delivering the message promptly instead of parking until idle.

**If only turn-idle exists:** do not invent a mechanism, and do not add a timer. Stop, write the finding into the register, and change D-7 from `to-be-removed` to either `approved-by-necessity` (if the host genuinely cannot accept a mid-turn steer) or `not-a-deviation` (if it turns out the reference also waits for the turn to end — check `reference-core-loop-spec.md` stage 5 before assuming either way).

## Step 2 — the design constraint that makes this non-trivial

**Last-wins must survive the tightening.** The single slot exists so that a second steer arriving before the first is delivered *replaces* it, and the first is never delivered (`src/core/steer-queue.ts`; pinned by `test/steer-queue.test.ts` — "a second park replaces the first; the earlier message is never delivered").

So "just send immediately on steer" is **not** the fix: two quick steers would then both reach the worker, and the earlier one would be delivered — a behaviour change that silently discards the rule the tests pin and the reference guarantees. Preserve parking; change only **when the parked slot is drained**.

## Requirements

- **R1** Last-wins is preserved: a second steer before delivery replaces the first, and the earlier text never reaches the worker. Existing `steer-queue` assertions must still pass.
- **R2** Context preservation is unchanged — delivered into the same live session, never a new spawn, never a restart.
- **R3** The delivery point moves from turn-idle to the finest granularity the host actually offers. If that is still turn-idle, say so and change the register instead.
- **R4** No timer-based workaround, and no polling. If the only way to tighten this were a timer, the correct outcome is the register change in step 1.
- **R5** Offline tests only (S8) — the fake host's step-boundary seam is the test surface. If the fix changes what the *adapter* treats as a step boundary, add an adapter-level test; if it changes the *core* drain condition, add a core test.
- **R6** Update `docs/research/dsh-loop-capability-map.md` stage 5 and the register's D-7 row with whatever you found. A finding of "still turn-idle" is a **complete and acceptable** result for this ticket.

## Acceptance criteria

- [ ] Step 1's answer is recorded with `file:line` evidence into the installed host bundle, stating the step-level signal (or its absence).
- [ ] If a finer signal exists: the delivery point is tightened, last-wins is still asserted by a passing test, and no timer was introduced.
- [ ] If it does not: D-7's disposition is corrected in the register with the reason, and no code changed.
- [ ] `npm test` 0 fail (baseline: 767 tests / 194 suites), `npm run typecheck` clean (both configs).
- [ ] Clean-room identifier grep over the shipped tree: zero product-tree hits.

## Notes

- **Do not open the reference tree.** Stage 5 of `reference-core-loop-spec.md` is the citable authority for the reference side; if it does not settle whether the reference waits for turn end, say that rather than reading the tree.
- Ticket 55 also edits `src/adapter/cordis-dsh-host.ts`. Land them sequentially, not in parallel, to avoid a gratuitous conflict.
