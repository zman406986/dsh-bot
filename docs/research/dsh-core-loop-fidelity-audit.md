# Reference-vs-dsh core-loop fidelity audit (ticket 52 answer)

- **Question.** With ADR-0017 making the reference's core loop the binding standard, how faithfully does our shipped implementation match it — and how much of the current tree survives the attempt to close the gap?
- **Scope.** Ticket 52's Q1 (fidelity map), Q2 (the channel seam), Q4 (boundary rulings), Q5 (effort shape). Q3's exhaustive per-file salvage classification is **deferred — see §7**.
- **Method.** Three independent research passes on 2026-09-18, then synthesis by the team lead. Reference side: `docs/research/reference-core-loop-spec.md` (observation pass over the reference tree, all four previously-open gaps closed). dsh side: `docs/research/dsh-loop-capability-map.md` and `docs/research/dsh-child-system-prompt-seam.md`, both asserted against the **installed host** at `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` (v**0.1.5-rc.2**; our notes said rc.1 and pointed at a stale user path).
- **Clean-room.** The observation pass read the reference tree; the comparison passes read product code; **no session had both open**. Reference behaviour is cited only through our own concept-level notes. No source text, prompt text, or identifiers were copied. See §8 for the QA gate this creates for implementation.
- **Date.** 2026-09-18.

---

## 1. Headline

**The core loop is structurally sound, and the fidelity gap is far narrower than the "stash main and rebuild" instinct assumes.**

Every mechanism the reference uses has a working counterpart in our tree, and the two assumptions that would have been fatal both came back **confirmed** against host source: spawn resolves on *inbox acceptance* (so the dispatcher never blocks — S1 is structural, not luck), and `agent.followup` genuinely *opens a turn* (so results really can be delivered). Meanwhile the single scariest deviation — D-1, the contract living in conversation rather than a system prompt — turned out to be **an unused seam, not a missing one**.

What is actually missing is four bounded things, and only one of them is real new subsystem work:

1. The worker contract is delivered through the wrong channel (D-1) — *fix by wiring `persona`, not by rewriting the contract*.
2. No shared safety section (D-3).
3. No boot redrive — restart notices are queued and never open a turn (D-4).
4. No obligation enforcement: no bound, no `lost`, no delivery telemetry (D-5, D-6).

Taken together this reads as **adapt, don't demolish** — but see §7, because the exhaustive salvage numbers are missing and the provisional view could move.

---

## 2. Q1 — the fidelity map

Per loop stage: what the reference does, what we do, the delta, and the disposition. Dispositions are the register's vocabulary (`docs/research/dsh-core-loop-deviations.md`).

| # | Stage | The reference does | We do | Delta | Disposition |
|---|---|---|---|---|---|
| 1 | **Intake** | Always-on property of the agent, resolved at startup; no activation step; an acknowledgement obligation is recorded the moment a user message is accepted | Dormant plugin; explicit `/dispatcher-start` (ADR-0009). `agent.inject` at activation + a per-turn reminder — both *queue context, opening no turn* | **Activation model** differs by design (ADR-0009). Obligation-on-accept **absent** | Activation → **undecided**, belongs to ADR-0016's sign-off. Obligation-on-accept folds into D-5 |
| 2 | **Triage** | No coded gate — a prompt-guided model decision (evidence grade (b): inferred) | Same: model decides via the five dispatcher tools; no host seam exists | **None** | — |
| 3 | **Spawn + contract** | Idempotent; one worker ⇔ one parent tool call; contract composed as a **system prompt** by a dedicated constructor (+ shared safety constant, + `canSendMessage:false`); "blank" means blank *conversation*, not blank *system prompt* | Idempotent and one-worker-per-stream (enforced in **core**, `src/core/multitask.ts:407-415`). `maxDepth: 0`, `toolFilter` deny-list intersected against live tool names. But the contract is concatenated into `request.prompt` → delivered as the child's **first user turn** (`dsh-subagent/lib/index.js:1710-1713`) | **D-1** (channel). **D-3** (no shared safety section) | D-1 → **to-be-removed**. D-3 → **to-be-removed** |
| 4 | **Concurrency** | One active run per agent; background queue; three priority lanes (user > agent > background); watchdog armed **only when a user task waits**, remedy is abandon-and-advance; no worker-health probe | Independent child sessions; our wake-bus holds mid-turn wakes and lets a user wake preempt a non-user batch (`src/core/wake-bus.ts:91-109,464-499`). No worker-liveness probe | **None material.** The reference's watchdog guards the *user lane*, which our wake-bus approximates. Its "no worker-health probe" is an admitted reference gap we need not inherit | — |
| 5 | **Steer** | Interrupt-then-resume **on the same preserved session**; last-wins; context preserved because it is the same session, not by stream injection | Single-slot last-wins queue + explicit interrupt + `wrapParentCorrection` delivered on the worker's `agent/status` idle (`src/core/steer-queue.ts`, `src/adapter/parent-agent.ts:196-199`) | **D-2**: the reference **re-composes the subagent system prompt every turn**, so the contract is restated after each steer; we restate only the correction frame | D-2 → **to-be-removed** — and it is fixed *for free* by the D-1 fix (see §3) |
| 6 | **Stop** | Cooperative, ordered abort; an aborted worker disarms its pending wake and never reports back; late results dropped | Same ordering (`src/core/multitask.ts:456-492`), plus a pure FSM where no transition leaves a terminal state, so late settles are structurally dropped (`src/core/worker-fsm.ts:30-44`) | **None.** Host confirmed: `interrupt` → `agent.cancel` + teardown | — |
| 7 | **Settle → wake** | Settlement callback → dedupe by worker id → coalesce N → clear the durable wake → hidden background-lane turn, silence allowed; payload never empty | `subagent/end` event → dedupe (`workers.has`) → wake-bus batch → `agent.followup`. Empty/aborted/error substituted. **Plus a 2000-char report clamp the reference lacks** | **None.** Both risky assumptions verified sound | Report clamp → **undecided** (an addition that changes behaviour; ADR-0017 open-Q5) |
| 8 | **Reconcile + deliver** | The agent speaks in an ordinary turn; `completed` ⇒ delivered; unanswered questions re-supplied; quiet-origin variants prefer silence | Delivery is the dispatcher's own turn; `markDelivered` only after a successful user-facing send (`src/core/multitask.ts:583-597`); workers tool-denied so only the dispatcher can speak (S5) | **Strong match.** Our `completed`-means-*delivered* criterion is stricter than the reference's first-visible-ack — deliberately (ADR-0007) | — |
| 9 | **Obligation** | Durable ledger; run-token gating; redrive on idle **and on boot**; bounded at **3 attempts, a lifetime bound persisted across boots**; then `lost` with a reason; outcomes telemetried (`delivered`/`superseded`/`dropped` + reasons) | Durable markers exist, but **no `lost`, no bound, no redrive, no telemetry.** The only prunes are `completed+delivered` and `stale-pending`, so an `in_progress && !delivered` landed item **persists forever and is never escalated** (`src/core/todo-reconciler.ts:186-211`) | **D-5**, **D-6** | D-5, D-6 → **to-be-removed** (the one genuine new subsystem) |
| 10 | **Restart** | Redrives wakes **and** acks on boot; re-wakes the **parent only**, handing it a synthetic "restart interrupted this task, result unknown" notice; the worker is never reconstructed; durability is best-effort-silent | `rebuildFromDurability` restores terminal rows and honest unknown-state rows, then `injectNotice` → `agent.inject` — **queues context and opens no turn** (`src/plugin.ts:414-432`) | **D-4.** Reference actively drives recovery; we inject a notice and wait for a user turn or a settle | D-4 → **to-be-removed**. Note the reference does **not** reconstruct workers either — so our non-resumption is *not* a deviation |

---

## 3. Q2 — the channel seam (the finding that changes the plan)

**Verdict: D-1 is an unused seam, not a structural impossibility.**

Today a spawned child carries: the harness identity section, the **inherited dispatcher preset** (host base sections + all plugin contributions), a fixed `subagent:delegation` context section — and our contract only as the **first user turn**. The child is *not* system-prompt-blank; a prior note conflated `inheritsParentContext: false` (which blanks *conversation*) with a blank system prompt.

The fix is one field. `SubagentStartRequest.persona` renders into a `deployment:persona-prefix` **system-prompt section** (`dsh-subagent/lib/index.js:549-553`), which is:

- **model-facing and recomputed every turn** (`dsh-system-prompt/lib/index.js:238-241,308-358`) — so it survives compaction *by construction*, because it is not a message at all;
- **scope-shadowed**, so it applies to that child alone;
- **enforced, not cosmetic** — the spawn provider advertises `persona: true` and the service *throws* `UNSUPPORTED_CAPABILITY` rather than accepting-then-ignoring (`dsh-subagent/lib/index.js:3203-3227`).

`agentOptions` is also wired but only carries provider/model/effort/maxTokens — it is **not** a prompt channel. Our adapter passes neither (`src/adapter/cordis-dsh-host.ts:534-544`).

**Two consequences worth stating plainly:**

1. **D-2 dissolves.** Because a system section is recomputed every turn, putting the contract in `persona` restates it on *every* turn — including after a steer. The D-1 fix subsumes D-2. We do not need to append anything to steer messages.
2. **A residual we cannot reach.** `persona` is a *prefix/shadow of one section*, not a blank-slate swap — the child still inherits the dispatcher's preset. A truly minimal worker system prompt needs a parent-light agent preset, i.e. a **host change outside this plugin**. That residual is `approved-by-necessity` and needs your acknowledgment, not an implementation.

Implementation cautions: `persona` uses strict `{{…}}` template interpolation, so worker copy must avoid literal `{{`/`}}`; and the inherited base means the contract *augments* rather than *replaces*.

---

## 4. The four gaps, in build order

| Order | Gap | The work | Why it's the honest reading |
|---|---|---|---|
| 1 | **D-1 channel** | Pass `persona` at `src/adapter/cordis-dsh-host.ts:534-544`; move the contract from `request.prompt` into it. Keep `request.prompt` for the task brief | Small, verified, and it also fixes D-2 |
| 2 | **D-3 safety** | Add the shared safety section the reference appends to every subagent prompt | Small; pure copy + a test |
| 3 | **D-4 boot redrive** | Switch the restart notice from `inject` to `followup` so recovery *opens a turn*; add an obligation redrive pass at activation | Small-to-medium; the mechanism is proven — `inject` is the wrong primitive (`dsh-agent-loop/lib/index.js:795-797` vs `:789-791`) |
| 4 | **D-5 / D-6 obligation** | Add a persisted redrive-attempt counter, a terminal `lost` state with reason, and delivery-disposition telemetry (`delivered`/`superseded`/`dropped` + reason). Then bound the retention prune to escalate rather than persist forever | **The real work.** It is the one place needing a new subsystem — a stateful obligation layer over the existing durable markers |

**Score the reference's own bound carefully:** its 3 attempts are a **lifetime** bound persisted across boots, not 3-per-boot. A crash loop can therefore exhaust the delivery budget on restarts alone. When we reimplement, we should copy the mechanism but decide deliberately whether we want that exact semantics — it is a place where matching the reference faithfully may be *worse* than the reference's authors intended.

---

## 5. Q4 — boundary rulings

| # | ADR-0017 open question | Ruling |
|---|---|---|
| 1 | Loop boundary | Stages 1–10 as written hold. Presentation surfaces stay out; **delivery** is in (the reference's own delivery is conversational). |
| 2 | Approval form | Recommend a **per-deviation written entry in the register**, each naming the reference behaviour and ours side by side. A blanket approval would not have caught the D-2-subsolved-by-D-1 interaction. |
| 3 | Retroactive re-opening | **Yes, and it is cheap here.** The shipped tickets 27–33 landed *presentation* and *composition*, which this audit finds non-deviating; the deviations concentrate in adapter/core wiring that no shipped ticket claims to have settled. Nothing needs un-shipping, but each shipped ticket must state its deviation status. |
| 4 | Is activation core-loop? | **Undecided — and deliberately deferred to ADR-0016's sign-off**, because ADR-0016 already reverses ADR-0009's activation matrix and is itself an unsigned draft. Ruling it here would pre-empt a decision already in flight. |
| 5 | Do *additions* count? | **Yes, if behaviour changes.** Two consequence: the 2000-char report clamp is `undecided` (it changes the payload the dispatcher sees); the access-ask relay is **approved** — ADR-0008 is an accepted, written decision to use a structured relay instead of the reference's approval waterfall. |
| 6 | Fidelity scoring | Anchor per **stage**, evidenced by the register's disposition column. Mechanical and offline-checkable: a stage is conformant when it has no `to-be-removed` row. |

---

## 6. Q5 — effort shape (provisional)

**Not the exhaustive per-file survey** (see §7). This is the deviation-surface view, which is what actually decides the rebuild question:

| Bucket | Assessment |
|---|---|
| **Survives untouched** | The loop's structural spine: `worker-fsm.ts`, `wake-bus.ts`, `steer-queue.ts`, `report-clamp.ts`, `types.ts`, `dsh-host.ts`/`fake-host.ts`, `tool-barrier.ts`, the roster/presence stack, the whole `client/` surface, and tickets 43–49's infrastructure fixes (overlay, settings card, tool JSON Schema, `--dsw-*` tokens, command registration) |
| **Survives with a wiring change** | `src/adapter/cordis-dsh-host.ts` (add `persona`), `src/worker/prompt.ts` (re-channel + safety section), `src/plugin.ts` + `restart-notice.ts` (inject → followup) |
| **Genuine new work** | The obligation layer over `durability.ts` / `todo-reconciler.ts` markers: attempts, `lost`, disposition telemetry, escalation instead of infinite persistence |
| **Scrapped** | Nothing identified so far. That is a real finding, not a rounding-down — the mechanisms all have counterparts |

**A separate bug track (not a fidelity deviation):** `rebuildFromDurability` frees a live-at-crash worker's stream key while that worker may still be alive on the host with no retained interrupt handle (`src/core/multitask.ts:640-654`). Re-dispatching the freed key can yield **two live workers on one logical stream** — the condition one-worker-per-stream exists to prevent. Note the host *does* offer continuable-session cold-resume (`ContinuableActivationRegistry.coldResume`), so we have more options here than the reference did. Needs its own ticket either way.

---

## 7. Gaps — what has since been closed, and what this audit still does NOT establish

**Closed since this audit was written** (both were the reason §6 shipped as provisional):

**The exhaustive salvage classification now exists** — `docs/research/dsh-core-loop-salvage-map.md` (ticket 54, resolved). §6 above has been reconciled with it. That pass closed both earlier gaps:

- the **per-file keep/adapt/rewrite/delete survey** — 53 `src/` + 41 `test/` files, script-computed counts that reconcile to the file enumeration; and
- the **test-suite deviation list**. **Four of the six deviations are pinned by currently-passing tests** — the suite is not silent, it is *complicit*. Corrected pin sites: `adapter-cordis-dsh-host.test.ts:190-192`/`:223-225` (D-1); `restart-honesty.test.ts:305-308` (D-4); `todo-reconciler.test.ts:454-487` (D-5 — **not** `:526`, which is a determinism assertion that survives). D-3 and D-6 have **zero** coverage.
- **A third finding the survey added:** B-1 is not merely unguarded — it is **asserted as intended behaviour** at `durable-roster.test.ts:313-321` ("Stream key is free for a legitimate re-dispatch"), so ticket 59 must make the freed key *safe*, not refuse the re-dispatch.
- Also: `persona` and `agentOptions` appear **nowhere** in `test/`, so ticket 55 wires a verified host seam that nothing currently watches. Write the assertion before the channel swap.

**Still not established:**

1. **The exact text of the inherited child preset is unenumerated.** We know the child joins the dispatcher's preset; we have not listed its sections.
2. **`{{…}}` interpolation failure mode** for a non-deployment persona is unconfirmed (plain text is safe; literal braces are the risk).
3. **The reference's worker FSM cannot be matched** because it does not exist in the reconstruction (tree-shaken to `export {}`). Our 6-state FSM is designed from first principles and is **not** a fidelity claim.
4. **Suite health is asserted, not measured.** The ~700 passing cases are the repo's own claim; the survey read the tests, it did not run them. `npm test` is the precondition for the test-cost figure having teeth.

---

## 8. QA gate for implementation

The reference-side note cites reference file names as provenance (e.g. `sand-ack-obligation-store.ts`, `sand-host.ts`). That is acceptable in a research note and matches existing practice, but AGENTS.md bans those identifiers **in shipped code** (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`). So:

- Every implementation ticket must carry the clean-room identifier grep as a gate over the shipped tree.
- Implementation tickets must be authored from the **concepts** in `reference-core-loop-spec.md`, never by opening the reference tree and never by transliterating a name from a note.

---

## Traceability

| Source | Used for |
|---|---|
| `docs/research/reference-core-loop-spec.md` | Whole reference column, §2 stage table, §4 ordering, the ack-redrive lifetime bound, boot redrive semantics |
| `docs/research/dsh-loop-capability-map.md` | dsh column, §2 rows 1/4/5/6/7/8, §4 D-4/D-5/D-6 wiring, §6 the missing-seam list |
| `docs/research/dsh-child-system-prompt-seam.md` | Entire §3, D-1 disposition, the D-2-subsolved-by-D-1 finding |
| `docs/research/reference-agent-lifecycle.md`, `reference-agent-prompt-inventory.md` | Prior authority for reference behaviour (stage 5/6/7/9/10) |
| ADR-0017; ADR-0007; ADR-0008; ADR-0009; ADR-0016 | Deviation standard, dispositions, boundary rulings |
| Ticket 52 | Q1–Q5 framing |
