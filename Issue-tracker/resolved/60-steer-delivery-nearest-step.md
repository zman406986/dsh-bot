# 60 — Deliver a steer at the nearest step, not at turn idle (deviation D-7)

**Status:** resolved
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

- [x] Step 1's answer is recorded with `file:line` evidence into the installed host bundle, stating the step-level signal (or its absence). — **Answered: no.** Recorded in the register's D-7 resolution record and `dsh-loop-capability-map.md` stage 5 (ticket-60 note).
- [x] If a finer signal exists: the delivery point is tightened, last-wins is still asserted by a passing test, and no timer was introduced. — **N/A, condition established false with evidence:** a finer host *consumption path* exists (`Agent.steer` → `send(input,"next-step",true)`, dsh-agent-loop/lib/index.js:792-794), but (a) no step-completion **event** exists on the bindable Agent surface (`dsh-agent/lib/types/runtime-types.d.ts:247-287`; `agent/inbox/claimed` is step-start for host-inbox messages, dsh-agent-loop/lib/index.js:100-112), (b) prompt delivery without a drain event breaks last-wins (R1/step 2), and (c) riding the consumption path requires dropping the reference's interrupt mechanism — a new unapproved deviation under ADR-0017/0018. Last-wins assertions untouched and passing (no code changed).
- [x] If it does not: D-7's disposition is corrected in the register with the reason, and no code changed. — D-7 → **`not-a-deviation (verified, ticket 60)`** via the ticket's own step-1 fallback clause: the reference also waits for the turn to end (`reference-core-loop-spec.md:77` stage 5 — interrupt-then-resume-next-turn, the exact mechanism we implement). Zero source changes in this commit.
- [x] `npm test` 0 fail (baseline: 767 tests / 194 suites), `npm run typecheck` clean (both configs). — 2026-09-19: **807 tests / 206 suites, 0 fail** (baseline grew with tickets 59/61/75); `tsc` clean on `tsconfig.json` + `tsconfig.client.json`.
- [x] Clean-room identifier grep over the shipped tree: zero product-tree hits. — **Voided as a ship gate** by the AGENTS.md amendment 2026-09-18 ("the S7 clean-room identifier grep is voided as a ship gate"); reference tree not opened, per the standing instruction. No new identifiers were introduced (docs-only).

## Notes

- **Do not open the reference tree.** Stage 5 of `reference-core-loop-spec.md` is the citable authority for the reference side; if it does not settle whether the reference waits for turn end, say that rather than reading the tree.
- Ticket 55 also edits `src/adapter/cordis-dsh-host.ts`. Land them sequentially, not in parallel, to avoid a gratuitous conflict.

## Step 1 — answer (ticket 60, 2026-09-19)

**The gating question resolves to Branch A (register change, no code), via the step-1 fallback's second arm: the reference also waits for the turn to end.**

1. **Host consumption is finer (confirmed, but unusable as our delivery point).** `Agent.steer` is `send(input, "next-step", true)` (`dsh-agent-loop/lib/index.js:792-794`); the shipped contract states "a running driver consumes it at its next step boundary" (`dsh-agent/lib/types/runtime-types.d.ts:191-200`); `subagents.sendMessage` routes steer delivery "at its nearest step" (`dsh-subagent/lib/index.js:3028-3029`). So `approved-by-necessity` does **not** apply — the host genuinely can accept a mid-turn steer.
2. **No observable per-step drain event exists.** The bindable Agent event surface is `agent/status`, `agent/inbox/inserted`, `agent/inbox/claimed`, `agent/inbox/discarded`, `agent/session-start` (`dsh-agent/lib/types/runtime-types.d.ts:247-287`), plus raw `agent/error` / `agent/assistant-stream` (`dsh-agent-loop/lib/index.js:863,1032`). `agent/inbox/claimed` fires when a message **already in the host inbox** is claimed into a step (`dsh-agent-loop/lib/index.js:100-112`) — a step-*start* observation about host-inbox messages, not a step-completion boundary, and no trigger for draining a slot we have not sent. There is no `agent/step` or step-end event.
3. **Using the consumption path would be a mechanism change, not a timing fix.** It requires *not* interrupting the worker so the host can consume the steer at the next step of a continuing turn. But the reference's steering **is** interrupt-then-resume: park → **interrupt the current turn** → on settlement start a **new turn on the same session** with the steer text (`reference-core-loop-spec.md:77` stage 5; `reference-agent-lifecycle.md:139`). Our path — park + interrupt (`src/core/multitask.ts:607,611`), idle → `emitStepBoundary` (`src/adapter/parent-agent.ts:233-236`), pop + `sendMessage` (`src/core/multitask.ts:455-463`) — is that mechanism, step for step. Under ADR-0018 (imitate the reference; exception list exhaustive) removing the interrupt would be a **new** deviation, and U-4 explicitly ruled "NOT approved as a deviation".
4. **Prompt delivery cannot preserve last-wins.** Sending on park lets two quick steers both reach the worker (step 2's forbidden behaviour); without a drain event there is no compliant middle ground, and timers are barred (R4).

**Disposition:** D-7 → `not-a-deviation (verified, ticket 60)` in the register (Part A row + resolution record; U-4 bullet annotated with the outcome). `dsh-loop-capability-map.md` stage 5 updated (R6). No source file changed.

## Comments

- **2026-09-19 — closed.** Closed as **not-a-deviation (verified)** per step 1's fallback clause; register updated (Part A row D-7, resolution record, U-4 outcome note) and capability-map stage 5 annotated. Docs-only commit; `npm test` 807/807 pass, `npm run typecheck` clean (both configs); clean-room grep AC voided by the 2026-09-18 amendment. If the human later wants true host-nearest-step consumption (no interrupt; worker keeps its current step), that is a new ADR-0018 exception-list proposal — recorded as a future upgrade note in the register, not a reopening of D-7.
