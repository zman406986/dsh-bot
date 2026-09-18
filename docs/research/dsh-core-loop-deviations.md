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

---

## Part C — Deviations that are unreachable on dsh (need acknowledgment)

| ID | Deviation | Why it is unreachable | Disposition | Acknowledgment |
|---|---|---|---|---|
| **R-1** | A worker still inherits the dispatcher's composed preset; we cannot give it a truly minimal system prompt | `persona` is a prefix/**shadow of one section**, not a blank-slate swap. Stripping the inherited base needs a parent-light **agent preset** — a host change outside this plugin's reach | `approved-by-necessity` | **pending** |
| **R-2** | Our worker FSM is designed from first principles rather than matched | The reference's worker FSM is **not evidenced in the reconstruction** — tree-shaken to `export {}` stubs. There is nothing to match | `not-a-deviation` | — |

---

## Part D — Awaiting a human ruling

| ID | Question | Our behaviour | The reference | Why it needs you |
|---|---|---|---|---|
| **U-1** | **Is our activation model a core-loop deviation?** | Dormant plugin; explicit `/dispatcher-start`; never captures the user's chat (ADR-0009) | Always-on property of the agent; no activation step, no opt-in | Ruling this here would pre-empt **ADR-0016**, which is already an unsigned draft reversing ADR-0009's matrix. Fold into that sign-off. Note ADR-0009's rejection of silent capture exists for a *consent* reason the reference never had to weigh |
| **U-2** | **Does our worker-liveness posture deviate?** | No worker-health probe; a wedged worker is invisible | Also no worker-health probe (`reference-agent-lifecycle.md` §4 calls it "a design gap we inherit") | We match the reference by *not* having one. But this is a place where fidelity may be the wrong target — a user might reasonably expect the dispatcher to notice a stuck worker. Confirm "match the reference" or approve an addition |
| **U-3** | **Is our 2000-char report clamp an approved addition?** | Truncates the worker's report to the dispatcher | No equivalent | ADR-0017 Q5 says an addition that changes behaviour is a deviation. It changes the payload the dispatcher sees. Keep, drop, or re-tune? |
| **U-4** | **Does the steering *timing* deviate?** | We interrupt, then deliver the steer on the worker's `agent/status` **idle** (whole-turn quiescence) | Interrupt-then-resume on the same session | Host supports steer at the **nearest step** (`dsh-subagent/lib/index.js:3028-3029`), so ours is a conservative superset that waits longer than necessary. Same guarantee, slower. Acceptable as-is, or tighten to step granularity? |

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
