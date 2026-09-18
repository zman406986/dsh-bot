# Core-loop deviation register

**Authority:** ADR-0017 — the reference's core loop is binding specification; a deviation may exist only with explicit written human approval.

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
| **D-1** | 3 Spawn | The worker contract is concatenated into `request.prompt` and delivered as the child's **first user turn**, not a system position (`src/adapter/cordis-dsh-host.ts:534-544`) | Contract composed as a **system prompt** by a dedicated constructor | Pass `persona` on the spawn request → lands in the `deployment:persona-prefix` system-prompt section (`dsh-subagent/lib/index.js:549-553`). Keep `request.prompt` for the task brief | `to-be-removed` | — |
| **D-2** | 5 Steer | A steer restates only the correction frame; the contract is never restated | The subagent prompt is re-composed **every turn**, so the contract is restated after each steer | **Fixed by D-1** — a system-prompt section is recomputed every turn. No separate work; do not append the contract to steer messages | `to-be-removed` (via D-1) | — |
| **D-3** | 3 Spawn | No shared safety section in the worker contract | One shared safety section constant is appended to every subagent prompt | Add an equivalent safety section to our worker contract copy | `to-be-removed` | — |
| **D-4** | 10 Restart | Restart recovery `inject`s a notice — which **queues context and opens no turn** (`src/plugin.ts:414-432`) | Boot actively drives recovery: re-wakes the parent, handing it a synthetic "restart interrupted this task, result unknown" notice | Use `followup` (which opens a turn) instead of `inject`; add an obligation redrive pass at activation | `to-be-removed` | — |
| **D-5** | 9 Obligation | No bound, no `lost` state, no redrive. An `in_progress && !delivered` landed item **persists forever and is never escalated** (`src/core/todo-reconciler.ts:186-211`) | Durable ledger, run-token gating, redrive on idle *and boot*, bounded at 3 attempts → `lost` with reason | Build the obligation layer over the existing durable markers | `to-be-removed` | — |
| **D-6** | 9 Obligation | No delivery-path telemetry; `markDelivered` flips a boolean | Outcomes telemetried: `delivered` / `superseded` / `dropped` + reason | Add disposition + reason recording | `to-be-removed` | — |

**Design note for D-5 — do not copy the bound blindly.** The reference's three attempts are a **lifetime** bound persisted across boots, not three-per-boot. A crash loop can exhaust the delivery budget on restarts alone, marking work `lost` without the user ever seeing it. Copy the *mechanism* (durable counter, terminal state, reason); consider deliberately choosing per-boot or an escalating bound, and if we differ from the reference, log it here as a new deviation with its rationale rather than doing it silently.

---

## Part B — Deviations already approved (do not re-litigate)

| ID | Deviation | Approved by | Date |
|---|---|---|---|
| **A-3** | Access asks use a custom structured relay instead of the host's child-approval waterfall | **ADR-0008** (accepted) | — |
| **A-4** | `completed` means **delivered to the user**, not merely worker exit — a *stricter* criterion than the reference's first-visible-ack | **ADR-0007** (accepted) | — |
| **A-5** | Todo list stays the dispatcher's private ledger; never passed into a worker's context | **ADR-0007** (accepted) | — |
| **A-6** | Workers are leaves; only the dispatcher spawns (reference has no such flat-topology rule) | **ADR-0003** (accepted) | — |
| **A-7** | The wake report body is **clamped**; the reference has no equivalent bound. Re-tuned on ruling from 2000/800/120/200 to **4000/1200/200/300** (body/error/activity/excerpt, 20 rows unchanged) | **Human ruling 2026-09-18** — the reference has nothing to imitate here, so the protective addition is kept with roomier bounds, because the wake notice is the dispatcher's only source for the user's answer | 2026-09-18 |
| **A-8** | An approved **addition**: a bounded worker-liveness signal, so a wedged worker can be noticed. The reference has none — we matched it by absence | **Human ruling 2026-09-18** — fidelity is the wrong target here; a user may reasonably expect the dispatcher to notice a stuck worker | 2026-09-18 |

---

## Part C — Deviations that are unreachable on dsh (need acknowledgment)

| ID | Deviation | Why it is unreachable | Disposition | Acknowledgment |
|---|---|---|---|---|
| **R-1** | A worker still inherits the dispatcher's composed preset; we cannot give it a truly minimal system prompt | `persona` is a prefix/**shadow of one section**, not a blank-slate swap. Stripping the inherited base needs a parent-light **agent preset** — a host change outside this plugin's reach | `approved-by-necessity` — **but see the reframing below; verification commissioned first** | **pending** |
| **R-2** | Our worker FSM is designed from first principles rather than matched | The reference's worker FSM is **not evidenced in the reconstruction** — tree-shaken to `export {}` stubs. There is nothing to match | `not-a-deviation` | — |

---

## Part D — Awaiting a human ruling

| ID | Question | Our behaviour | The reference | Why it needs you |
|---|---|---|---|---|
| **U-1** | **Is our activation model a core-loop deviation?** | Dormant plugin; explicit `/dispatcher-start`; never captures the user's chat (ADR-0009) | Always-on property of the agent; no activation step, no opt-in | Ruling this here would pre-empt **ADR-0016**, which is already an unsigned draft reversing ADR-0009's matrix. Fold into that sign-off. Note ADR-0009's rejection of silent capture exists for a *consent* reason the reference never had to weigh |

### Rulings received 2026-09-18

U-2, U-3 and U-4 were put to the human with the surrounding evidence and are now closed. Recorded here so the reasoning survives, not just the outcome.

- **U-2 → approved as an addition (`A-8`).** Fidelity was rejected as the target: we match the reference by *not* having a worker-health probe, and the human ruled that an addition is warranted so a wedged worker can be noticed. It is bounded and must not become polling. Ticket **61**.
- **U-3 → approved as an addition, re-tuned (`A-7`).** The ruling was "copy the reference, or take the roomier option if there is nothing to imitate". Our notes establish the reference has **no** equivalent bound, so there is nothing to imitate: the clamp stays, re-tuned from 2000/800/120/200 to **4000/1200/200/300**. Rationale: the wake notice is the dispatcher's only source for the user's answer, so the body bound is the one that can silently destroy a deliverable. Ticket **63**.
- **U-4 → NOT approved as a deviation; it becomes `D-7`, `to-be-removed`.** The human ruled to tighten steer delivery to the host's nearest-step path. Our turn-idle timing is a conservative superset, not a fidelity claim — so the correct disposition is to close the difference rather than to approve it. **The design constraint is that last-wins must survive the tightening**, which needs a host-event check before implementation. Ticket **60**.

### R-1 reframed — pending one verification pass

R-1 assumed our inability to blank a worker's system prompt was a fidelity gap. Reading the notes again, that assumption now looks **wrong**, and R-1 may be `not-a-deviation`:

- The reference's subagent gets **no** parent conversation — "blank context" means a blank *conversation*. That much is settled.
- But its **system prompt is not blank either**. The reference has *one* prompt assembler shared by the main runner and the subagent runner, driven by a single subagent boolean. Composition is: base → a section carrying the no-user-channel flag for subagent runners → agent profile → *(early return only for a shared-room runner)* → user identity → … → memory → automations/workflows/channels/**agent directory (null for subagent runners)** → host tails. And the role text itself comes from a constructor whose only inputs are the type name and a readonly flag, so **every built-in role kind receives byte-identical prompt text apart from its own name**.
- In other words: the reference layers role text onto **shared, inherited sections** too, and enforces the no-user-channel contract through a flag and its capability wiring — which is structurally what `persona` + our tool barrier now do.

**What is not settled** (and will not be inferred past the notes): whether the memory and user-identity sections actually reach a subagent runner, and whether the profile section on a child is the child's own or the parent's. The composition order shows no subagent early-return except the shared-room case, which *implies* they do — but that is a grade-(b) inference, and this repo has been burned twice by exactly that. Ticket **62** commissions one narrow observation pass to settle it. Until then R-1 stays `approved-by-necessity` with the acknowledgment field **pending** — a conservative holding position, not a hidden approval.

---

## Part E — Separate track: a real bug, not a deviation

| ID | Defect | Where | Risk |
|---|---|---|---|
| **B-1** | `rebuildFromDurability` frees a live-at-crash worker's **stream key** while that worker may still be alive on the host with no retained interrupt handle. Re-dispatching the freed key can put **two live workers on one logical stream** | `src/core/multitask.ts:640-654` | Defeats one-worker-per-stream. Note the host offers continuable-session **cold-resume**, so we have remedies the reference lacked. Needs its own ticket regardless of ADR-0017 |

---

## Open register maintenance questions

1. Where do approvals live — here, or in the ADR? **Proposal: here**, with the human's name and date in the `Approval` column. ADRs record *decisions about the standard*; this file records *the state of each item*.
2. Who may set `to-be-removed` → `approved`? **Proposal: the human only.** The implementing team may set `to-be-removed` and propose `approved-by-necessity`, never grant it.
3. Does a `to-be-removed` item need a ticket before work starts? **Yes** — repo rule: log the issue first.
