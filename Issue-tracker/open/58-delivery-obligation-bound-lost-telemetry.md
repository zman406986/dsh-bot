# 58 — The delivery-obligation layer: bound, `lost`, and disposition telemetry (deviations D-5 and D-6)

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none to design; **57 should land first** because the redrive's trigger is the waking primitive that ticket 57 fixes (redriving through `inject` would repeat D-4's defect).
**Related:** register items **D-5**, **D-6**, and undecided **U-2**; `docs/research/reference-core-loop-spec.md` G1 + stage 9; `docs/research/dsh-loop-capability-map.md` stage 9; ADR-0007; ticket 55 (the contract must tell workers to report honestly — the failure mode this ticket bounds)

## The deviations

**D-5 — no bound, no `lost`.** The reference keeps a durable acknowledgement ledger, gates fulfilment on a live run token, redrives both on idle **and on boot**, is bounded at three attempts, and then marks the obligation **`lost` with a reason**. We have durable markers but no bound, no redrive, and no terminal state. Concretely, the only prunes in `src/core/todo-reconciler.ts:186-211` are `completed+delivered` (retention) and `stale-pending` — so an **`in_progress && !delivered` item whose worker settled persists forever and is never escalated**. It is visible in every reminder and unbounded.

**D-6 — no telemetry.** The reference records delivery dispositions: `delivered`, `superseded`, `dropped`, each with a reason (`no_runner`, `session_unavailable`, `quiesced`, `error`, `agent_deleted`, `agent_gone`). Our `markDelivered` flips a boolean (`src/core/todo-reconciler.ts:354-364`). This is what makes D-5 debuggable — without it, "why did this result never reach the user?" is unanswerable.

This is **the one genuine new subsystem** the audit identified. Everything else in the fidelity set is a wiring change.

## What exists to build on — do not invent a second store

Durability already works: `ctx.storageDomain` markers via `src/core/durability.ts`, written at spawn (`src/core/multitask.ts:449-451`), updated on settle (`:361-365`), deleted on delivered/aborted (`:587-595`, `:359-360`), and restored on activation (`:626-700`). ADR-0006 already fixed the split (durable `WorkerRecord`, in-memory `SteerTicket`). **Extend this; do not add a parallel ledger.** ADR-0006's rule — never invent a second transcript/record DB — applies.

## Requirements

**R1 — A persisted attempt counter.** `redriveAttempts` on the durable marker, incremented durably on each attempt.

**R2 — A terminal `lost` state with a reason.** Reasons at minimum: `max_redrives`, `worker_gone`, `session_unavailable`. A `lost` item is not silently equal to `completed`: it must be distinguishable in the ledger and reportable to the user.

**R3 — Redrive, bounded.** On idle and on activation, re-attempt delivery for undelivered settled results. Each attempt increments the counter; at the bound, mark `lost`. **Ticket 57's waking primitive is the delivery mechanism** — a redrive must open a turn.

**R4 — Escalation replaces infinite persistence.** Change `todo-reconciler.ts`'s retention so an `in_progress && !delivered` item is either redriven or escalated to `lost` — never left unbounded. This is the actual user-visible defect: a result that never arrives and is never mentioned.

**R5 — Disposition telemetry (D-6).** Record a disposition per settled result with a reason, at least `delivered` / `superseded` / `dropped`. `superseded` matters because our steer path can retire a worker's output; `dropped` covers the no-runner/session-gone classes.

**R6 — Keep our stricter criterion.** ADR-0007 makes `completed` mean **delivered to the user**, which is *stricter* than the reference's first-visible-acknowledgement. That stays (register A-4, approved). The obligation we are bounding is therefore about **delivery**, not about firing a message.

## The bound: do not copy it blindly

The reference's three attempts are a **lifetime** bound **persisted across boots** (`reference-core-loop-spec.md` G1) — not three-per-boot. A crash loop can therefore exhaust the delivery budget on restarts alone and mark work `lost` without the user ever seeing it.

Choose deliberately between: (a) mirror the reference exactly; (b) reset or relax the budget per boot/activation; (c) an escalating bound. **If we differ from the reference, log it as a new deviation in `docs/research/dsh-core-loop-deviations.md` with the rationale** — that is exactly the discipline ADR-0017 exists to impose, and a silent improvement is the failure mode it was written to stop.

## Open question that touches this ticket (do not decide it here)

**U-2** — the reference has **no worker-health probe** and calls that an admitted gap. If a worker wedges forever, our obligation layer may be the only thing that ever notices (a wedge produces no settle, so nothing is ever owed). Consider whether redrive should also cover "worker never settled", and if so flag it as an **addition** for the human rather than building it silently — ADR-0017 Q5 makes an addition that changes behaviour a deviation.

## Constraints

- **Offline tests only (S8)** — fake wake/steer/complete. No network, no LLM, no running dsh. The whole obligation loop is testable without a host: that is the point of the durable marker design.
- **Clean-room** — author from the concepts in `reference-core-loop-spec.md`. Never open the reference tree. Zero reconstruction identifiers in the shipped tree (grep as a gate).
- Never `git add -A`.

## Acceptance criteria

- [ ] A settled-but-undelivered result is redriven on idle and on activation, bounded by a **persisted** attempt counter.
- [ ] Exhausting the bound produces a terminal `lost` with a reason, distinguishable from `completed`.
- [ ] The infinite-persistence path in `todo-reconciler.ts` is gone: every `in_progress && !delivered` item is redriven or escalated.
- [ ] Every settled result records a disposition with a reason (`delivered`/`superseded`/`dropped`).
- [ ] A redrive **opens a turn** (asserted on the host call), not merely queues context.
- [ ] Offline tests cover: attempt increment persistence across a simulated restart, bound exhaustion → `lost`, each disposition, and the escalation path.
- [ ] The chosen bound semantics are recorded, and any divergence from the reference is logged as a new register item.
- [ ] `npm test` 0 fail, `npm run typecheck` clean (both configs); clean-room identifier grep zero product-tree hits.

## Notes

- **Ordering within the ticket:** the disposition telemetry (R5) is worth doing *first* even though D-6 is listed second — it is what makes the rest debuggable, and the reference's own design pairs them for that reason.
- The audit's report-clamp item (**U-3**, the 2000-char truncation, `src/core/report-clamp.ts`) is **not** in scope here — it is a separate ruling and a separate ticket if it lands.
