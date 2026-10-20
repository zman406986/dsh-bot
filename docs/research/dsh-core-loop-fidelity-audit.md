# How closely our core loop matches the reference (ticket 52 answer)

- **Question.** With ADR-0017 making the reference's core loop the binding standard, how closely does our shipped implementation match it — and how much of the current code survives the work of closing the gap?
- **Scope.** Ticket 52's Q1 (a stage-by-stage map of how closely we match), Q2 (the channel that carries the worker contract), Q4 (which side of the loop boundary each item falls on), Q5 (how much work this is). Q3's full file-by-file keep/change/delete classification is **deferred — see §7**.
- **Method.** Three independent research passes on 2026-09-18, then synthesis by the team lead. Reference side: `docs/research/reference-core-loop-spec.md` (observation pass over the reference tree, all four previously-open gaps closed). dsh side: `docs/research/dsh-loop-capability-map.md` and `docs/research/dsh-child-system-prompt-seam.md`, both asserted against the **installed host** at `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` (v**0.1.5-rc.2**; our notes said rc.1 and pointed at a stale user path).
- **Clean-room.** The observation pass read the reference tree; the comparison passes read product code; **no session had both open**. Reference behaviour is cited only through our own concept-level notes. No source text, prompt text, or identifiers were copied. See §8 for the QA gate this creates for implementation.
- **Date.** 2026-09-18.

---

## 1. Summary

**The core loop is sound, and the gap between us and the reference is far smaller than the "stash main and rebuild" instinct assumes.**

Every mechanism the reference uses has a working counterpart in our code. The two assumptions that would have been fatal both came back **confirmed** against host source. First, spawn resolves on *inbox acceptance*, so the dispatcher never blocks — S1 (the user still gets a reply while a worker runs) holds by design, not by luck. Second, `agent.followup` genuinely *opens a turn*, so results really can be delivered. The single most alarming deviation, D-1, where the worker contract is sent as a chat message instead of a system prompt, turned out to be **an unused extension point, not a missing one**.

What is actually missing is four bounded things, and only one of them is real new subsystem work:

1. The worker contract is delivered through the wrong channel (D-1) — *fix by wiring `persona`, not by rewriting the contract*.
2. No shared safety section (D-3).
3. No retry after a restart — restart notices are queued and never open a turn (D-4).
4. No rule that forces an undelivered result to be retried: no attempt limit, no `lost` status, and no record of what happened to a delivery (D-5, D-6).

Taken together, the answer is to change the code we have, not throw it away — but see §7, because the full file counts are missing and the provisional view could move.

---

## 2. Q1 — how closely we match the reference, stage by stage

Per loop stage: what the reference does, what we do, the difference, and the verdict we recorded for it. The verdicts come from the deviation register (`docs/research/dsh-core-loop-deviations.md`). In that register, `to-be-removed` means we do not match the reference and should.

| # | Stage | The reference does | We do | Delta | Disposition |
|---|---|---|---|---|---|
|---|---|---|---|---|---|
| 1 | **Intake** | Always-on property of the agent, resolved at startup; no activation step; a note is recorded that the agent still owes the user a reply, the moment a user message is accepted | Dormant plugin; explicit `/dispatcher-start` (ADR-0009). `agent.inject` at activation + a per-turn reminder — both *queue context, opening no turn* | **Activation model** differs by design (ADR-0009). The record that a reply is owed is **absent** | Activation is **undecided**; it belongs to the ADR-0016 sign-off. The owed-reply record folds into D-5 |
| 2 | **Triage** | No coded check — the model decides, guided by a prompt (evidence grade (b): inferred from reading, not observed) | Same: the model decides using the five dispatcher tools; the host offers no hook here | **None** | — |
| 3 | **Spawn + contract** | Idempotent; one worker ⇔ one parent tool call; the contract is composed as a **system prompt** by a dedicated constructor (+ a shared safety constant, + `canSendMessage:false`); "blank" means a blank *conversation*, not a blank *system prompt* | Idempotent and one-worker-per-stream (enforced in **core**, `src/core/multitask.ts:407-415`). `maxDepth: 0`, plus a `toolFilter` deny-list checked against the live tool names. But the contract is pasted into `request.prompt`, so it arrives as the child's **first user turn** (`dsh-subagent/lib/index.js:1710-1713`) | **D-1** (wrong channel). **D-3** (no shared safety section) | D-1 → **to-be-removed**. D-3 → **to-be-removed** |
| 4 | **Concurrency** | One active run per agent; background queue; three priority lanes (user > agent > background); a watchdog is armed **only when a user task is waiting**, and its remedy is to abandon the stuck run and move on; no check on whether a worker is still alive | Independent child sessions; our wake bus holds wakes that arrive mid-turn and lets a user wake preempt a non-user batch (`src/core/wake-bus.ts:91-109,464-499`). No check on whether a worker is still alive | **No material difference.** The reference's watchdog guards the *user lane*, which our wake bus approximates. The reference itself has no worker-health check, and we are not required to copy that gap | — |
| 5 | **Steer** | Interrupt, then resume **on the same preserved session**; the last message wins; context survives because it is the same session, not because anything is injected into the stream | Single-slot last-wins queue + explicit interrupt + `wrapParentCorrection`, sent when the worker's `agent/status` reports idle (`src/core/steer-queue.ts`, `src/adapter/parent-agent.ts:196-199`) | **D-2**: the reference **rebuilds the subagent system prompt every turn**, so the contract is restated after each steer; we restate only the correction wrapper | D-2 → **to-be-removed** — and the D-1 fix fixes it *for free* (see §3) |
| 6 | **Stop** | Cooperative, ordered abort; an aborted worker disarms its pending wake and never reports back; late results dropped | Same ordering (`src/core/multitask.ts:456-492`), plus a pure state machine in which no transition leaves a terminal state, so late results are dropped by design (`src/core/worker-fsm.ts:30-44`) | **None.** Host confirmed: `interrupt` → `agent.cancel` + teardown | — |
| 7 | **Settle → wake** | Settlement callback → dedupe by worker id → merge N into one → clear the durable wake → hidden background-lane turn, silence allowed; payload never empty | `subagent/end` event → dedupe (`workers.has`) → wake-bus batch → `agent.followup`. Empty, aborted and error results are replaced with fixed text. **Plus a 2000-character report limit the reference lacks** | **None.** Both risky assumptions verified sound | Report limit is **undecided** (an addition that changes behaviour; ADR-0017 open-Q5) |
| 8 | **Reconcile + deliver** | The agent speaks in an ordinary turn; `completed` ⇒ delivered; unanswered questions are re-supplied; runs started by a routine get a variant that prefers silence | Delivery is the dispatcher's own turn; `markDelivered` only after a successful user-facing send (`src/core/multitask.ts:583-597`); workers are denied the user tool, so only the dispatcher can speak (S5: workers cannot address the user) | **Strong match.** Our `completed`-means-*delivered* rule is stricter than the reference's first-visible-acknowledgement — deliberately (ADR-0007) | — |
| 9 | **Obligation** | Durable record of what is still owed; a run token gates who may mark it done; retried when idle **and on restart**; bounded at **3 attempts, a lifetime limit persisted across restarts**; then marked `lost` with a reason; outcomes recorded (`delivered`/`superseded`/`dropped` + reasons) | Durable markers exist, but **no `lost`, no limit, no retry, no outcome records.** The only cleanup rules are `completed+delivered` and `stale-pending`, so an item that is `in_progress && !delivered` **stays forever and is never escalated** (`src/core/todo-reconciler.ts:186-211`) | **D-5**, **D-6** | D-5, D-6 → **to-be-removed** (the one genuinely new subsystem) |
| 10 | **Restart** | Retries wakes **and** owed replies on boot; re-wakes the **parent only**, handing it a synthetic "restart interrupted this task, result unknown" notice; the worker is never rebuilt; durability is best-effort and silent when it fails | `rebuildFromDurability` restores finished rows and rows marked status unknown, then `injectNotice` → `agent.inject` — which **queues context and opens no turn** (`src/plugin.ts:414-432`) | **D-4.** The reference actively drives recovery; we inject a notice and wait for a user turn or a settle | D-4 → **to-be-removed**. Note the reference does **not** rebuild workers either — so our non-resumption is *not* a deviation |

---

## 3. Q2 — the channel that carries the worker contract (the finding that changes the plan)

**Verdict: D-1 is an unused extension point, not a structural impossibility.**

Today a spawned child carries: the harness identity section, the **dispatcher's preset, inherited by the child** (host base sections + all plugin contributions), a fixed `subagent:delegation` context section — and our contract only as the **first user turn**. The child does *not* start with a blank system prompt. A prior note confused `inheritsParentContext: false` (which blanks the *conversation*) with a blank system prompt.

The fix is one field. `SubagentStartRequest.persona` is rendered into a system-prompt section called `deployment:persona-prefix` (`dsh-subagent/lib/index.js:549-553`). That section is:

- **seen by the model and rebuilt every turn** (`dsh-system-prompt/lib/index.js:238-241,308-358`) — so it survives context compaction by construction, because it is not a message at all;
- **limited to the scope that registered it**, so it applies to that child alone;
- **enforced, not cosmetic** — the spawn provider advertises `persona: true`, and the service *throws* `UNSUPPORTED_CAPABILITY` instead of accepting the field and ignoring it (`dsh-subagent/lib/index.js:3203-3227`).

`agentOptions` is also wired, but it only carries provider/model/effort/maxTokens — it is **not** a way to send a prompt. Our adapter passes neither (`src/adapter/cordis-dsh-host.ts:534-544`).

**Two consequences worth stating plainly:**

1. **D-2 disappears.** Because a system section is rebuilt every turn, putting the contract in `persona` restates it on *every* turn — including after a steer. The D-1 fix also fixes D-2. We do not need to append anything to steer messages.
2. **One gap we cannot close.** `persona` is a *prefix that shadows one section*, not a blank-slate swap — the child still inherits the dispatcher's preset. A truly minimal worker system prompt needs a lighter agent preset for the parent, which is a **host change outside this plugin**. That gap is recorded as `approved-by-necessity` and needs your acknowledgment, not an implementation.

Implementation cautions: `persona` uses strict `{{…}}` template substitution, so worker copy must avoid a literal `{{` or `}}`; and because the inherited base stays, the contract *adds to* that base rather than *replacing* it.

---

## 4. The four gaps, in the order they should be built

| Order | Gap | The work | Why this reading is accurate |
|---|---|---|---|
| 1 | **D-1 channel** | Pass `persona` at `src/adapter/cordis-dsh-host.ts:534-544`; move the contract out of `request.prompt` and into it. Keep `request.prompt` for the task brief | Small, verified, and it also fixes D-2 |
| 2 | **D-3 safety** | Add the shared safety section the reference appends to every subagent prompt | Small; new text plus a test |
| 3 | **D-4 retry after restart** | Switch the restart notice from `inject` to `followup` so recovery *opens a turn*; add a pass at activation that retries owed deliveries | Small-to-medium; the mechanism is proven — `inject` is the wrong call (`dsh-agent-loop/lib/index.js:795-797` vs `:789-791`) |
| 4 | **D-5 / D-6 obligation** | Add a saved retry counter, a terminal `lost` state with a reason, and a record of each delivery outcome (`delivered`/`superseded`/`dropped` + reason). Then change the cleanup rule so an old item escalates instead of staying forever | **The real work.** It is the one place that needs a new subsystem — a stateful layer over the existing durable markers that tracks what is still owed |

**Look closely at the reference's own limit:** its 3 attempts are a **lifetime** limit saved across restarts, not 3 per restart. A crash loop can therefore use up the delivery budget on restarts alone. When we reimplement, we should copy the mechanism but decide deliberately whether we want that exact meaning — this is a place where copying the reference faithfully may be *worse* than the reference's authors intended.

---

## 5. Q4 — which items belong inside the loop boundary

| # | ADR-0017 open question | Ruling |
|---|---|---|
| 1 | Loop boundary | Stages 1–10 as written hold. Presentation surfaces stay out; **delivery** is in (the reference's own delivery is conversational). |
| 2 | Form of approval | Recommend a **written entry per deviation in the register**, each naming the reference behaviour and ours side by side. A blanket approval would not have caught the way D-2 disappears when D-1 is fixed. |
| 3 | Re-opening shipped tickets | **Yes, and it is cheap here.** The shipped tickets 27–33 added *presentation* and *composition*, which this audit finds non-deviating; the deviations concentrate in adapter/core wiring that no shipped ticket claims to have settled. Nothing needs un-shipping, but each shipped ticket must state whether it deviates. |
| 4 | Is activation part of the core loop? | **Undecided — and deliberately left to ADR-0016's sign-off**, because ADR-0016 already reverses ADR-0009's activation matrix and is itself an unsigned draft. Ruling it here would pre-empt a decision already in flight. |
| 5 | Do *additions* count? | **Yes, if they change behaviour.** Two consequences: the 2000-character report limit is `undecided` (it changes the payload the dispatcher sees); the access-ask relay is **approved** — ADR-0008 is an accepted, written decision to use a structured relay instead of the reference's approval waterfall. |
| 6 | How to score closeness | Anchor per **stage**, using the register's disposition column as evidence. Mechanical and checkable offline: a stage conforms when it has no `to-be-removed` row. |

---

## 6. Q5 — how much work this is (provisional)

**Not the full file-by-file survey** (see §7). This is the view from the deviations alone, which is what actually decides the rebuild question:

| Group | Assessment |
|---|---|
| **Survives untouched** | The loop's main structure: `worker-fsm.ts`, `wake-bus.ts`, `steer-queue.ts`, `report-clamp.ts`, `dsh-host.ts`/`fake-host.ts`, `tool-barrier.ts`, the roster/presence stack, the whole `client/` surface, and tickets 43–49's infrastructure fixes (overlay, settings card, tool JSON Schema, `--dsw-*` tokens, command registration). **Two corrections from the survey (§7):** `types.ts` does **not** survive untouched — the D-5/D-6 obligation vocabulary is added there; and `report-clamp.ts` was `unresolved` pending the U-3/A-7 ruling, which ticket 63 has now settled as **Keep** |
| **Survives with a wiring change** | `src/adapter/cordis-dsh-host.ts` (add `persona`), `src/worker/prompt.ts` (change the channel + add the safety section), `src/plugin.ts` + `restart-notice.ts` (inject → followup) |
| **Genuine new work** | The layer over `durability.ts` / `todo-reconciler.ts` markers that tracks what is still owed: attempt counts, `lost`, delivery outcomes, escalation instead of staying forever |
| **Scrapped** | Nothing identified so far. That is a real finding, not a rounding-down — the mechanisms all have counterparts |

**A separate bug track (not a deviation from the reference):** `rebuildFromDurability` frees a stream key for a worker that was alive at crash time, while that worker may still be alive on the host with no saved handle to interrupt it (`src/core/multitask.ts:640-654`). Re-dispatching the freed key can produce **two live workers on one logical stream** — the exact situation the one-worker-per-stream rule exists to prevent. Note the host *does* offer cold resume of a continuable session (`ContinuableActivationRegistry.coldResume`), so we have more options here than the reference did. Needs its own ticket either way.

---

## 7. Gaps — what has since been closed, and what this audit still does NOT establish

**Closed since this audit was written** (both were the reason §6 shipped as provisional):

**The full file-by-file classification now exists** — `docs/research/dsh-core-loop-salvage-map.md` (ticket 54, resolved). §6 above has been reconciled with it. That pass closed both earlier gaps:

- the **file-by-file keep/adapt/rewrite/delete survey** — 53 `src/` + 41 `test/` files, with counts computed by script that reconcile against the file listing; and
- the **list of tests that assert our deviations**. **Four of the six deviations are asserted by tests that currently pass** — the test suite is not silent about them, it *records them as expected behaviour*. Corrected places to look: `adapter-cordis-dsh-host.test.ts:190-192`/`:223-225` (D-1); `restart-honesty.test.ts:305-308` (D-4); `todo-reconciler.test.ts:454-487` (D-5 — **not** `:526`, which asserts determinism and survives). D-3 and D-6 have **zero** coverage.
- **A third finding the survey added:** B-1 is not merely untested — it is **asserted as intended behaviour** at `durable-roster.test.ts:313-321` ("Stream key is free for a legitimate re-dispatch"), so ticket 59 must make the freed key *safe*, not refuse the re-dispatch.
- Also: `persona` and `agentOptions` appear **nowhere** in `test/`, so ticket 55 wires a verified host extension point that nothing currently watches. Write the assertion before the channel swap.

**Still not established:**

1. **The exact text of the child's inherited preset is not listed.** We know the child joins the dispatcher's preset; we have not listed its sections.
2. **What happens when `{{…}}` substitution fails** for a persona that is not a deployment is unconfirmed (plain text is safe; literal braces are the risk).
3. **The reference's worker state machine cannot be matched** because it does not exist in the reconstruction (removed by tree-shaking, leaving `export {}`). Our 6-state machine is designed from first principles and is **not** a claim about the reference.
4. **Suite baseline is now measured:** `npm test` at `3287c4d` → **767 tests / 194 suites / 0 fail / 121s**. The earlier "~700 passing" was the repo's own claim; it understated the count rather than overstating it.

---

## 8. QA gate for implementation

The reference-side note cites reference file names as provenance (e.g. `sand-ack-obligation-store.ts`, `sand-host.ts`). That is acceptable in a research note and matches existing practice, but AGENTS.md bans those identifiers **in shipped code** (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`). So:

- Every implementation ticket must carry the clean-room identifier search as a gate over the shipped code.
- Implementation tickets must be written from the **concepts** in `reference-core-loop-spec.md`, never by opening the reference tree and never by copying a name from a note.

---

## Traceability

| Source | Used for |
|---|---|
| `docs/research/reference-core-loop-spec.md` | Whole reference column, §2 stage table, §4 ordering, the lifetime limit on retrying an owed reply, retry-on-restart behaviour |
| `docs/research/dsh-loop-capability-map.md` | dsh column, §2 rows 1/4/5/6/7/8, §4 D-4/D-5/D-6 wiring, §6 the list of things the host does not offer |
| `docs/research/dsh-child-system-prompt-seam.md` | Entire §3, D-1 disposition, the finding that D-1 fixes D-2 |
| `docs/research/reference-agent-lifecycle.md`, `reference-agent-prompt-inventory.md` | Prior authority for reference behaviour (stage 5/6/7/9/10) |
| ADR-0017; ADR-0007; ADR-0008; ADR-0009; ADR-0016 | The deviation standard, dispositions, boundary rulings |
| Ticket 52 | Q1–Q5 framing |
