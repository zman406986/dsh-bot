# Core-loop deviation register

> **2026-09-18 (late):** ADR-0018 now holds the master rule — *imitate the reference in its entirety, except an enumerated exception list* — ruled directly by the human. This register remains the item-level tracker **and has been reclassified under ADR-0018 (ticket 64, same day)**: A-4 is **superseded** (completion = first-visible-ack; the "delivered" criterion is dropped), A-5/A-6 are **conformances** (verified shared with the reference, `reference-behavior-notes.md:60`), A-7/A-8 survive as ADR-0018's D21/D22, R-1 is carried as ADR-0018's A2, and U-1 is closed by the ADR (no mode, always-on). Part A rows stay closed. B-1 stays a bug and its ticket-59 fix is unaffected by the re-base (stream-key durability is untouched by the completion-semantics and UI changes).

**Authority:** ADR-0018 — the master rule: imitate the reference in its entirety except its enumerated exception list (the list is exhaustive and the fidelity bar). ADR-0017 supplies the discipline: a deviation may exist only with explicit written human approval; anything not on ADR-0018's list is held to the imitation standard.

**Maintained by:** the implementing team, per ADR-0017's consequence 1. Update this file whenever a deviation is added, removed, or approved — never edit ADR-0017's table instead.

**Status legend**
- `to-be-removed` — we do not match the reference and should. Mandated by ADR-0017's directive; **needs no new approval**.
- `approved` — a written, dated human or ADR decision exists that we may differ. Cite it.
- `approved-by-necessity` — the reference behaviour is unreachable on dsh. Needs the human's **acknowledgment** (not permission to leave it unaddressed).
- `undecided` — awaiting a human ruling. Listed with the question below.
- `not-a-deviation` — investigated and found conformant, or nothing to match.

**Approvals must never be guessed.** Blank approval fields are correct until the human fills them.

**Provenance:** the deviations were identified by the 2026-09-18 comparison passes and consolidated in `docs/research/dsh-core-loop-fidelity-audit.md`. Every line reference there was re-verified against the installed host (v0.1.5-rc.2) in that pass — but re-verify again before changing code, since a path in a note is a claim, not a fact (the lesson of `dsh-local-install.md`).

---

## Part A — Deviations we should close

These need **no approval**: ADR-0017 mandates the reference behaviour, so removing the deviation *is* compliance. They are listed here so the register is complete and so each can be closed with evidence.

| ID | Stage | Deviation | Reference behaviour | Target | Disposition | Approval |
|---|---|---|---|---|---|---|
| **D-1** | 3 Spawn | The worker contract is concatenated into `request.prompt` and delivered as the child's **first user turn**, not a system position (`src/adapter/cordis-dsh-host.ts:534-544`) | Contract composed as a **system prompt** by a dedicated constructor | Pass `persona` on the spawn request → lands in the `deployment:persona-prefix` system-prompt section (`dsh-subagent/lib/index.js:549-553`). Keep `request.prompt` for the task brief | **removed** — 2026-09-18, ticket 55 | — |
| **D-2** | 5 Steer | A steer restates only the correction frame; the contract is never restated | The subagent prompt is re-composed **every turn**, so the contract is restated after each steer | **Fixed by D-1** — a system-prompt section is recomputed every turn. No separate work; do not append the contract to steer messages | **removed (via D-1)** — 2026-09-18, ticket 55 | — |
| **D-3** | 3 Spawn | No shared safety section in the worker contract | One shared safety section constant is appended to every subagent prompt | Add an equivalent safety section to our worker contract copy | **removed** — 2026-09-18, ticket 56 | — |
| **D-4** | 10 Restart | Restart recovery `inject`s a notice — which **queues context and opens no turn** (`src/plugin.ts:414-432`) | Boot actively drives recovery: re-wakes the parent, handing it a synthetic "restart interrupted this task, result unknown" notice | Use `followup` (which opens a turn) instead of `inject`; add an obligation redrive pass at activation | **removed** — 2026-09-18, ticket 57. The *primitive* is fixed (`wakeNotice` → `Agent.followup`); the obligation redrive pass is ticket 58 | — |
| **D-5** | 9 Obligation | No bound, no `lost` state, no redrive. An `in_progress && !delivered` landed item **persists forever and is never escalated** (`src/core/todo-reconciler.ts:186-211`) | Durable ledger, run-token gating, redrive on idle *and boot*, bounded at 3 attempts → `lost` with reason | Build the obligation layer over the existing durable markers | **removed** — 2026-09-18, ticket 58 | — |
| **D-6** | 9 Obligation | No delivery-path telemetry; `markDelivered` flips a boolean | Outcomes telemetried: `delivered` / `superseded` / `dropped` + reason | Add disposition + reason recording | **removed** — 2026-09-18, ticket 58 (item summary + a `DeliveryEvent` log, because one item can carry several obligations) | — |

**D-5 resolution record (what was actually chosen).** The bound **mirrors the reference**: a **lifetime** budget persisted on the durable marker, not a per-boot one, stopping after three delivery attempts (`MAX_DELIVERY_REDRIVES = 2` counts *redrives*; the settle wake is the first opportunity). Because this is the reference's behaviour rather than a divergence, **no new register item is logged** — the ticket's "log a divergence" requirement is satisfied by there being none.

Two properties the mirroring does *not* remove, and which the implementation adds deliberately:

1. **A `lost` item is reported, not silent.** The per-turn reminder renders it with its reason (`· lost · … (max-redrives)`), so "we gave up" cannot read like "it finished".
2. **Escalation is bounded too.** A `lost` item is pruned after the same retention as a delivered one, so escalation does not merely replace one unbounded row with another.

**Hazard accepted, recorded honestly:** a crash loop can still burn the budget on restarts alone, exactly as it can in the reference, because the counter is persisted and never reset. The mitigations are (1) above — the loss is loud — and the fact that an activation redrive is only spent when the result is genuinely still undelivered.

**Design note for D-5 — do not copy the bound blindly.** The reference's three attempts are a **lifetime** bound persisted across boots, not three-per-boot. A crash loop can exhaust the delivery budget on restarts alone, marking work `lost` without the user ever seeing it. Copy the *mechanism* (durable counter, terminal state, reason); consider deliberately choosing per-boot or an escalating bound, and if we differ from the reference, log it here as a new deviation with its rationale rather than doing it silently.

---

## Part B — Deviations already approved (do not re-litigate)

| ID | Deviation | Approved by | Date |
|---|---|---|---|
| **A-3** | Access asks use a custom structured relay instead of the host's child-approval waterfall | **ADR-0008** (accepted) | — |
| **A-4** | ~~`completed` means **delivered to the user**, not merely worker exit — a *stricter* criterion than the reference's first-visible-ack~~ **Superseded 2026-09-18 by ADR-0018:** completion = **first-visible-ack** (the "delivered" criterion is dropped with the trimmed exception list). Approved-by ADR-0007 no longer applies | **ADR-0018** (accepted) — supersedes | 2026-09-18 |
| **A-5** | ~~Todo list stays the dispatcher's private ledger; never passed into a worker's context~~ **Reclassified 2026-09-18 as `not-a-deviation`:** verified conformant — the reference's todo list is likewise the dispatcher's private ledger (`reference-behavior-notes.md:60`) | **ADR-0018** (accepted) — listed under confirmed conformances | 2026-09-18 |
| **A-6** | ~~Workers are leaves; only the dispatcher spawns~~ **Reclassified 2026-09-18 as `not-a-deviation`:** verified conformant — the reference's worker runs exclude the spawn, management, user-message, and peer-message tools (`reference-behavior-notes.md:60`; refutes the older Gap-8 nested-subagent claim) | **ADR-0018** (accepted) — listed under confirmed conformances | 2026-09-18 |
| **A-7** | The wake report body is **clamped**; the reference has no equivalent bound. Re-tuned on ruling from 2000/800/120/200 to **4000/1200/200/300** (body/error/activity/excerpt, 20 rows unchanged) | **ADR-0018 exception D21** (accepted; originally human ruling 2026-09-18) — the clamp is a deliberate, enumerated addition because the wake notice is the dispatcher's only source for the user's answer | 2026-09-18 |
| **A-8** | An approved **addition**: a bounded worker-liveness signal, so a wedged worker can be noticed. The reference has none — we matched it by absence. **Resolved by implementation 2026-09-19:** ticket 61 (commit `4465561`) shipped the bounded signal — `deriveWorkerLiveness` (`src/core/liveness.ts`) as a pure verdict over the existing check fields, surfaced on the `check_workers` row; visibility only, no watchdog, no polling | **ADR-0018 exception D22** (accepted; originally human ruling 2026-09-18) — fidelity is the wrong target; a user may reasonably expect the dispatcher to notice a stuck worker | 2026-09-18 |

---

## Part C — Deviations that are unreachable on dsh (need acknowledgment)

| ID | Deviation | Why it is unreachable | Disposition | Acknowledgment |
|---|---|---|---|---|
| **R-1** | A worker still inherits the dispatcher's composed preset; we cannot give it a truly minimal system prompt | `persona` is a prefix/**shadow of one section**, not a blank-slate swap. Stripping the inherited base needs a parent-light **agent preset** — a host change outside this plugin's reach | **Carried as ADR-0018 exception A2** (accepted 2026-09-18): workers inheriting the host's base system preset, with `persona` a prefix section, is now an enumerated, human-approved exception — no longer dependent on the necessity argument or ticket 62's observation pass (which may still upgrade it to `not-a-deviation` if the reference proves to inherit sections too). **Update 2026-09-19 (ticket 62):** `docs/research/reference-subagent-inherited-sections.md` settled that pass — the reference's subagent runner inherits the shared sections too — so R-1 is **not-a-deviation (verified, ticket 62)** | **Human — ADR-0018, 2026-09-18** |
| **R-2** | Our worker FSM is designed from first principles rather than matched | The reference's worker FSM is **not evidenced in the reconstruction** — tree-shaken to `export {}` stubs. There is nothing to match | `not-a-deviation` | — |

---

## Part D — Awaiting a human ruling

| ID | Question | Our behaviour | The reference | Why it needs you |
|---|---|---|---|---|
| **U-1** | ~~**Is our activation model a core-loop deviation?**~~ **Closed 2026-09-18 by ADR-0018** (see rulings below) | ~~Dormant plugin; explicit `/dispatcher-start`~~ The dormant/activation model is voided: no mode, no toggle, always-on | Always-on property of the agent; no activation step, no opt-in | **Closed by ADR-0018 (accepted 2026-09-18):** the deviation becomes `to-be-removed` with the ADR as its mandate — the removal is carried by the UI-epic re-base and wrapper build (ticket 64 and the wrapper-UI re-scope of tickets 27–35/46/49) |

### Rulings received 2026-09-18

U-2, U-3 and U-4 were put to the human with the surrounding evidence and are now closed. Recorded here so the reasoning survives, not just the outcome.

- **U-1 → closed by ADR-0018 (accepted 2026-09-18).** The human ruled the master model *imitate the reference in its entirety*: no dispatcher mode, no toggle — the wrapper window / expanded surface *is* the dispatcher, always-on. The dormant-plugin activation model (ADR-0009) is voided and its premise retracted the same day; ADR-0016 was already retracted. U-1's deviation is `to-be-removed` with ADR-0018 as the mandate.

- **U-2 → approved as an addition (`A-8`).** Fidelity was rejected as the target: we match the reference by *not* having a worker-health probe, and the human ruled that an addition is warranted so a wedged worker can be noticed. It is bounded and must not become polling. Ticket **61**.
- **U-3 → approved as an addition, re-tuned (`A-7`).** The ruling was "copy the reference, or take the roomier option if there is nothing to imitate". Our notes establish the reference has **no** equivalent bound, so there is nothing to imitate: the clamp stays, re-tuned from 2000/800/120/200 to **4000/1200/200/300**. Rationale: the wake notice is the dispatcher's only source for the user's answer, so the body bound is the one that can silently destroy a deliverable. Ticket **63**.
- **U-4 → NOT approved as a deviation; it becomes `D-7`, `to-be-removed`.** The human ruled to tighten steer delivery to the host's nearest-step path. Our turn-idle timing is a conservative superset, not a fidelity claim — so the correct disposition is to close the difference rather than to approve it. **The design constraint is that last-wins must survive the tightening**, which needs a host-event check before implementation. Ticket **60**.

### R-1 reframed — pending one verification pass

R-1 assumed our inability to blank a worker's system prompt was a fidelity gap. Reading the notes again, that assumption now looks **wrong**, and R-1 may be `not-a-deviation`:

- The reference's subagent gets **no** parent conversation — "blank context" means a blank *conversation*. That much is settled.
- But its **system prompt is not blank either**. The reference has *one* prompt assembler shared by the main runner and the subagent runner, driven by a single subagent boolean. Composition is: base → a section carrying the no-user-channel flag for subagent runners → agent profile → *(early return only for a shared-room runner)* → user identity → … → memory → automations/workflows/channels/**agent directory (null for subagent runners)** → host tails. And the role text itself comes from a constructor whose only inputs are the type name and a readonly flag, so **every built-in role kind receives byte-identical prompt text apart from its own name**.
- In other words: the reference layers role text onto **shared, inherited sections** too, and enforces the no-user-channel contract through a flag and its capability wiring — which is structurally what `persona` + our tool barrier now do.

**What is not settled** (and will not be inferred past the notes): whether the memory and user-identity sections actually reach a subagent runner, and whether the profile section on a child is the child's own or the parent's. The composition order shows no subagent early-return except the shared-room case, which *implies* they do — but that is a grade-(b) inference, and this repo has been burned twice by exactly that. Ticket **62** commissions one narrow observation pass to settle it. **Update 2026-09-18 (ticket 64):** ADR-0018 settled the governance question regardless of what the pass finds — the inherited-preset state is now enumerated exception **A2**, so R-1 is `approved` with the human's signature; ticket 62's pass remains useful only as a potential upgrade to `not-a-deviation`. **Update 2026-09-19 (ticket 62):** the pass landed — `docs/research/reference-subagent-inherited-sections.md` finds the shared sections do reach the subagent runner — and R-1 is now **not-a-deviation (verified, ticket 62)**; see the Part C row.

---

## Part E — Separate track: a real bug, not a deviation

| ID | Defect | Where | Risk |
|---|---|---|---|
| **B-1** | `rebuildFromDurability` frees a live-at-crash worker's **stream key** while that worker may still be alive on the host with no retained interrupt handle. Re-dispatching the freed key can put **two live workers on one logical stream** | `src/core/multitask.ts:640-654` | Defeats one-worker-per-stream. Note the host offers continuable-session **cold-resume**, so we have remedies the reference lacked. Needs its own ticket regardless of ADR-0017 |

**2026-09-18 (ticket 64):** B-1 stays a bug, closed by **ticket 59** (commit `b097b92` — unknown-state workers hold their stream keys across restart; refusal reason `stream-key-held-by-unknown-state`, `stop_worker` as the release hatch). Its fix is **unaffected by the ADR-0018 re-base**: the fix lives in `src/core/multitask.ts` (unknown-state holds) and `src/adapter/restart-notice.ts`, while the re-base changes completion semantics (A-4), the activation/UI model, and the copy policy — none of those paths touch stream-key durability.

---

## Open register maintenance questions

1. Where do approvals live — here, or in the ADR? **Proposal: here**, with the human's name and date in the `Approval` column. ADRs record *decisions about the standard*; this file records *the state of each item*.
2. Who may set `to-be-removed` → `approved`? **Proposal: the human only.** The implementing team may set `to-be-removed` and propose `approved-by-necessity`, never grant it.
3. Does a `to-be-removed` item need a ticket before work starts? **Yes** — repo rule: log the issue first.
