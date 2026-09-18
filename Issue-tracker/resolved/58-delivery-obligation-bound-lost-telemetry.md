# 58 — The delivery-obligation layer: bound, `lost`, and disposition telemetry (deviations D-5 and D-6)

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none to design; **57 should land first** because the redrive's trigger is the waking primitive that ticket 57 fixes (redriving through `inject` would repeat D-4's defect). — **both landed 2026-09-18.**
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

- [x] A settled-but-undelivered result is redriven on idle and on activation, bounded by a **persisted** attempt counter. — Idle: `parent-agent.ts` turn end (deliberately *before* `noteTurnEnded`, so the redrive coalesces into one turn and a turn that delivered costs nothing). Activation: `plugin.ts` `rebuildAndNotice`. Counter lives on `TodoItem.redriveAttempts` and is mirrored onto `WorkerRecord` → `DurableWorkerMarker.redriveAttempts`.
- [x] Exhausting the bound produces a terminal `lost` with a reason, distinguishable from `completed`. — `TodoStatus` gains `"lost"`; `delivered` stays false; `dispositionReason: "max-redrives"`.
- [x] The infinite-persistence path in `todo-reconciler.ts` is gone: every `in_progress && !delivered` item is redriven or escalated. — Reconciler pass 2b; the old test that asserted "no mutations" for exactly this case was rewritten (it was D-5 written down as a requirement).
- [x] Every settled result records a disposition with a reason (`delivered`/`superseded`/`dropped`). — Item summary **plus** a `DeliveryEvent` log, because one item can carry several obligations (a re-dispatch supersedes one result, then a later one is delivered).
- [x] A redrive **opens a turn** (asserted on the host call), not merely queues context. — Asserted at two levels: `FakeDshHost.wakeCalls` in `delivery-obligation.test.ts`, and the lifecycle stub's `wakeups` in `adapter-policy-inject.test.ts`.
- [x] Offline tests cover: attempt increment persistence across a simulated restart, bound exhaustion → `lost`, each disposition, and the escalation path. — `test/delivery-obligation.test.ts` (13 cases).
- [x] The chosen bound semantics are recorded, and any divergence from the reference is logged as a new register item. — See Comments: the bound **mirrors** the reference, so there is no divergence to log.
- [x] `npm test` 0 fail, `npm run typecheck` clean (both configs); clean-room identifier grep zero product-tree hits. — **783 tests / 195 suites / 0 fail**; both tsconfigs clean; grep zero hits in `src/` and `lib/`.

## Comments

### 2026-09-18 — implemented

**The bound mirrors the reference; no divergence is logged.** `MAX_DELIVERY_REDRIVES = 2` counts *redrives*, and the settle wake is already one opportunity — so we stop after three delivery attempts, exactly as the reference does, and the counter is persisted on the durable marker so it is a **lifetime** budget rather than a per-boot one. ADR-0017 mandates the reference behaviour inside the loop, so an unapproved relaxation would have been the wrong kind of cleverness. The design note's hazard is real and accepted: a crash loop can burn the budget on restarts. The mitigation is not a different bound but **loudness** — a `lost` item renders with its reason in the per-turn reminder, so the failure mode is "the user is told", not "the result vanishes".

**One place implements the bound; the core only acts on it.** All redrive/escalation logic is the pure reconciler (pass 2b). `Multitask.redriveUndelivered` re-runs that reconciler with an **empty wake** — with no settles in the wake, every landed-undelivered item is by definition past its first chance, so the reconciler's own output *is* the redrive set. That avoids a second, drifting implementation of the same rule.

**Ordering in the idle trigger is load-bearing.** `redriveUndelivered` runs before `wakeBus.noteTurnEnded`. Two consequences, both intended: the attempt is only spent when the result is still undelivered (a turn that delivered costs nothing), and the bus is still marked busy, so the bus's wake goes into `queue` mode and opens the turn as a pending flag rather than a second turn, so a settled wake coalesces with the redrive instead of opening a turn behind it. (The bus therefore needed `enqueueDeliveryRedrive` — a genuine new wake source — because `enqueueUserWake` deliberately does *not* wake; it expects the host to open the user's turn itself.)

**`superseded` needed its own slot.** The obvious design — one disposition per item — silently drops telemetry when a todo is re-dispatched and then delivered: the item can only summarise one of the two obligations. So the ledger keeps a `DeliveryEvent` log alongside the item's summary field, and the reconcile pass treats a settle from a worker the item no longer points at as superseded rather than as the current worker's result (previously it would have been attributed to the *new* worker's item — a real mis-attribution this closes).

**A pure escalation deliberately opens no turn.** When the bound is hit, nothing new is enqueued; the loss rides the next turn's ledger line. By that point the dispatcher has had three delivery opportunities, and a fourth turn whose content is "I gave up" is noise. Recorded here so it reads as a decision rather than an omission.

**One behaviour fixed as a side effect:** the pass originally notified the roster unconditionally, which published a duplicate identical snapshot on every activation and turn end. It now notifies only when something actually changed.

**Not done, on purpose:** the report clamp is untouched (A-7, ticket 63); `U-2`'s "worker never settled" case is **not** covered, because a wedge produces no settle and therefore no obligation — that belongs to ticket 61 and would be an approved addition, not a quiet one.

Clean-room grep (`\b(sand|executor)\b|MessageSubagent|SAND_MULTITASK`) over `src/` and `lib/`: **zero hits**.

## Notes

- **Ordering within the ticket:** the disposition telemetry (R5) is worth doing *first* even though D-6 is listed second — it is what makes the rest debuggable, and the reference's own design pairs them for that reason.
- The audit's report-clamp item (**U-3**, the 2000-char truncation, `src/core/report-clamp.ts`) is **not** in scope here — it is a separate ruling and a separate ticket if it lands.
