# Salvage classification of the tree, and the tests that encode a deviation (ticket 54; ticket 52 Q3)

- **Question.** With ADR-0017 making the reference's core loop the binding standard — and the human weighing "stash main and rebuild" — how much of the current tree actually survives? And which existing tests assert our behaviour *where the reference differs*?
- **Method.** Full read-survey of every `src/` and `test/` module on 2026-09-18: file enumeration with per-file LOC, per-module export/lead-comment inventory, per-test import graph + case titles, then targeted assertion reads for each deviation in `docs/research/dsh-core-loop-deviations.md`. Every verdict below is argued from a named deviation (D-1…D-6, B-1, R-1, U-1…U-4) or a named matching behaviour. Counts are computed by script, not by hand — the method is in §4.
- **Why this replaces a guess.** `docs/research/dsh-core-loop-fidelity-audit.md` §6 shipped a **provisional** effort shape because the first attempt at this survey died on an HTTP 429 (27 minutes, nothing written). This note is the survey. **It confirms §6's headline and refutes two of its sub-claims.**
- **Clean-room.** Product-code side only. The reference tree was never opened in this pass; the reference side is cited solely through the abstracted notes in `docs/research/`. No source text, prompt text, or identifier reproduced.
- **Scope boundary.** The per-file verdict set is enumerated against the headings required by ticket 54: the intake/admission → triage → spawn+contract → concurrency → steer → stop → settle→wake → reconcile+deliver → obligation → restart spine, or `not core-loop`. The **access-relay stack is `not core-loop`** in this classification: the reference's approval waterfall is replaced here by an already-approved written decision (A-3, ADR-0008), and the relay sits beside the loop rather than inside it.
- **Date.** 2026-09-18. **Ticket 54** — closes it; §5 explicitly disposes of §6.

---

## 1. Per-module classification — `src/` (53 files, 12,754 lines)

`Keep` = matches the reference as-is or is outside the loop. `Keep+adapt` = the mechanism is right, the wiring or vocabulary changes (the change is named). `Rewrite`/`Delete` = would need a named deviation or a named wrong behaviour. `unresolved` is counted separately and never rounded into a verdict — ticket 54 forbids `TBD` rows, so the one genuinely blocked file says what it is blocked on.

### Adapter (14 files, 3,193 lines)

| File | Verdict | Stage | Reason |
|---|---|---|---|
| `adapter/access-prompt.ts` | Keep | not core-loop (A-3) | The user-facing half of the structured relay; ADR-0008 approved the relay in place of the reference's approval waterfall. Nothing in D-1…D-6 touches it. |
| `adapter/activation-command.ts` | **Keep+adapt** | 1 Intake | Copy + command definition survive; the *trigger* is contested — U-1 is undecided and tickets 50/51 move activation to the mode boundary (ADR-0016 draft). Adapt, don't rewrite: the registration helpers are reused either way. |
| `adapter/content-blocks.ts` | Keep | 3 Spawn | Produces the text-block shape the host accepts on **both** channels. Channel-agnostic, which is exactly why the D-1 fix does not touch it. |
| `adapter/cordis-dsh-host.ts` | **Keep+adapt** | 3/5/6/7 | The two-channel defect site. Add `persona` to the spawn request (D-1) and keep `request.prompt` for the task brief; restart/recovery uses `followup` rather than `inject` (D-4). Spawn/interrupt/send/settle wiring itself matches the reference. |
| `adapter/dispatcher-tools.ts` | Keep | 2 Triage | Registers the five tools. Triage is a prompt-guided model decision in both products (audit §2 stage 2) — no delta to close. |
| `adapter/durable-marker.ts` | Keep | 9 Obligation | The storage-domain port. The obligation layer (D-5/D-6) *builds on* it; the port itself is the right shape and matches the reference's durable-ledger-over-a-small-port discipline. |
| `adapter/index.ts` | Keep | not core-loop | Barrel re-exports. |
| `adapter/parent-agent.ts` | **Keep+adapt** | 1/5/10 | Owns activation and the `agent/status` binding. Two edits: the step-boundary point is *turn-idle* today, not the host's nearest-step steer path (U-4), and the boot-recovery notice must open a turn (D-4). Note the audit missed this file in its "wiring change" bucket. |
| `adapter/restart-notice.ts` | **Keep+adapt** | 10 Restart | The notice *copy* matches the reference's synthetic "interrupted — result unknown" hand-off and is asserted by tests; only the delivery primitive changes (`inject` → `followup`). |
| `adapter/roster-channel.ts` | Keep | not core-loop | Presence telemetry over the settings namespace. The reference has no client surface at all, so there is nothing to be unfaithful to. |
| `adapter/settings-section.ts` | Keep | not core-loop | Feature-flag section install (ADR-0005). |
| `adapter/steer-command.ts` | Keep | 5 Steer | Routes into the same core last-wins queue the tool uses — an input path, not new steer semantics. Matches the reference's last-wins property exactly. |
| `adapter/wake-copy.ts` | Keep | 7 Settle-wake | The minimal wake cue, used only when the assembler has no notices. The reference permits a silent wake turn; this constant does not conflict with that. |
| `adapter/worker-access-tool.ts` | Keep | not core-loop (A-3) | Worker half of the approved relay. |

### Core (19 files, 4,982 lines)

| File | Verdict | Stage | Reason |
|---|---|---|---|
| `core/access-relay.ts` | Keep | not core-loop (A-3) | Policy table + ticket lifecycle. ADR-0008 approved. |
| `core/access-types.ts` | Keep | not core-loop (A-3) | Message shapes; no secret values by construction. |
| `core/dsh-host.ts` | Keep | 3/5/6/7 | The one host boundary. Its method set (spawn/interrupt/send/settle/step-boundary/wake/access) is the same primitive set the reference uses; D-1 and D-4 change *what we pass*, not *which port we call*. |
| `core/durability.ts` | **Keep+adapt** | 9 Obligation | Marker schema is minimal-to-reconstruct and correct in shape. D-5/D-6 require it to carry a persisted **redrive-attempt counter** and a terminal `lost` reason — a field addition to the existing marker, not a new store. |
| `core/fake-host.ts` | Keep | not core-loop (test infra) | Records spawn/interrupt/send/wake and fires settle/step events. It is what makes ~700 offline tests possible; the reference has no equivalent because it is not a host boundary. |
| `core/multitask.ts` | **Keep+adapt** | 3–9 | The loop spine: idempotent spawn, one-worker-per-stream, dedupe-on-terminal, ordered abort, `markDelivered`-only-on-send. All match. Two edits: the B-1 fix at `rebuildFromDurability` (freed stream key) and obligation hooks at settle/reconcile (D-5/D-6). |
| `core/peer-inbox.ts` | Keep | not core-loop (Phase 2) | Peer lane; PRD §15 leaves Phase-2 peers open, and the reference behaviour here is not in the loop spine. |
| `core/peer-types.ts` | Keep | not core-loop (Phase 2) | Envelope schema, new types only. |
| `core/policy/assembler.ts` | **Keep+adapt** | 1/7/9 | Pure assemblers, correct discipline. Adapt: the wake turn must learn to carry **escalation and redrive notices** once D-5 exists, or the dispatcher cannot become aware of them. The audit missed this file too. |
| `core/policy/prompts.ts` | **Keep+adapt** | 1/7 | Copy + stable headings. Adapt: new copy for the obligation notices in the wake turn. Headings are pinned as test markers, so this is additive. |
| `core/report-clamp.ts` | **unresolved — needs U-3** | 7 Settle-wake | The clamp is an **addition that changes the payload the dispatcher sees**, which ADR-0017 Q5 says counts as a deviation. It cannot be classified until the human rules keep/drop/re-tune. It is otherwise pure, well-tested, and harmless to the loop. |
| `core/roster-snapshot.ts` | Keep | not core-loop | Wire contract for the presence surface; deliberately dependency-light. |
| `core/steer-queue.ts` | Keep | 5 Steer | Single-slot, last-wins, explicit non-durability (ADR-0006). Direct match for the reference's last-wins steer. |
| `core/todo-reconciler.ts` | **Keep+adapt** | 8/9 | The ledger semantics are right (`completed` means *delivered* — stricter than the reference, approved by A-4). Adapt: D-5's bound and `lost` state, D-6's disposition telemetry, and the prune must **escalate instead of persisting forever** (`:186-211`). |
| `core/tool-results.ts` | Keep | 2/3/8 | Formatters; summarize-never-dump matches the reference's no-raw-JSON posture. |
| `core/tools.ts` | Keep | 2/3/8 | The five tools map 1:1 onto existing core methods, and the delivery tool is the only user-facing send — same posture as the reference (the agent speaks; workers do not). |
| `core/types.ts` | **Keep+adapt** | 3–9 | Worker status vocabulary. Adapt: the todo status set must grow to express a terminal `lost`/disposition outcome (D-5/D-6). **The audit listed this file as surviving untouched — that is wrong.** |
| `core/wake-bus.ts` | Keep | 4/7 | Batch-join N settles into one wake, queue-while-busy, user-lane preemption. This *is* the reference's dedupe → coalesce → hidden-turn behaviour, plus priority lanes. |
| `core/worker-fsm.ts` | Keep | 3–6 | Pure 6-state machine, no transition leaves a terminal state. **Not a fidelity claim** — the reference's worker FSM is not evidenced in its reconstruction (R-2, `not-a-deviation`). It is kept because it is correct on its own terms. |

### Worker (5 files, 191 lines) and root (2 files, 771 lines)

| File | Verdict | Stage | Reason |
|---|---|---|---|
| `worker/agent-def.ts` | **Keep+adapt** | 3 Spawn | The (prompt + barrier + leaf depth) composition is the right model. Adapt: the prompt half must be split so the contract goes to a system position and the task stays a message (D-1). |
| `worker/index.ts` | Keep | not core-loop | Barrel. |
| `worker/prompt.ts` | **Keep+adapt** | 3/5 | The contract content is a strict superset of the reference's worker contract, and it already omits reconstruction codenames. Adapt in two ways: split system-vs-task (D-1), and add the shared safety section (D-3). This is the single most-edited core-loop file. |
| `worker/report.ts` | Keep | 7 Settle-wake | Normalizes settle text and substitutes empty/error bodies — the reference also guarantees a non-empty payload. Match. |
| `worker/tool-barrier.ts` | Keep | 3 Spawn | Deny-list intersected against live tool names. Same philosophy as the reference's capability wiring, with a harder runtime guarantee (the host throws on unknown names). |
| `index.ts` | Keep | not core-loop | Barrel. |
| `plugin.ts` | **Keep+adapt** | 1/10 | Composition root. Adapt: activation currently rebuilds then `inject`s a notice (`:414-432`) — D-4 requires the recovery turn to actually open; and the obligation pass must be wired at activation. |

### Client (13 files, 3,617 lines)

| File | Verdict | Stage | Reason |
|---|---|---|---|
| `client/actions.ts` | Keep | not core-loop | The one client→host egress; it submits the *same* command path, never a second activation channel. |
| `client/capsule-store.ts` | Keep | not core-loop | Pure view models, no React/DOM/Cordis. |
| `client/capsule.tsx` | Keep | not core-loop | The single additive overlay entry. |
| `client/context.ts` | Keep | not core-loop | Structural client seams; peer surfaces not imported. |
| `client/index.ts` | Keep | not core-loop | Client module entry + apply graph. |
| `client/overlay.ts` | Keep | not core-loop | Registration data + locale validation. |
| `client/panel.tsx` | Keep | not core-loop | Presentation only; holds no authority to spawn/steer/stop. |
| `client/roster-store.ts` | Keep | not core-loop | Presence view model over the snapshot contract. |
| `client/settings-card-store.ts` | Keep | not core-loop | Settings card form model (ticket 47). |
| `client/settings-card.tsx` | Keep | not core-loop | Settings card component (ticket 47). |
| `client/toolview-panel.tsx` | Keep | not core-loop | Per-tool call view components. |
| `client/toolviews.ts` | Keep | not core-loop | Keyed toolview registrations. |
| `client/wrapper.ts` | Keep | not core-loop | Module-loader shell for the built bundle. |

**Whole-directory verdict:** all of `client/` is `Keep`, and that is a substantive finding rather than a shrug — the reference has **no client surface at all**, so no client behaviour can be a deviation. The only fidelity-relevant thing in `client/` is what it *displays*: the presence projection consumes core FSM vocabulary verbatim, so if the FSM's status set grows (D-5's `lost`), the panel and toolviews must learn the new label. That is a rendering follow-on, not a fidelity deviation.

---

## 2. Per-test classification — `test/` (41 files, 19,100 lines, ~700 cases)

`Keep+adapt` here means **a currently-passing test whose assertion must change** when a deviation is closed. That set is the real cost of the fidelity work, and it is smaller than feared but not zero.

| Test file | Verdict | Stage | Reason |
|---|---|---|---|
| `access-prompt.test.ts` | Keep | A-3 | Pins the approved relay's copy and clamping. |
| `access-relay.test.ts` | Keep | A-3 | Pins timeout/deny/abort for the approved relay. |
| `activation-lifecycle.test.ts` | **Keep+adapt** | 1 (U-1) | Pins the flag matrix and the dormant→activated transition — the exact surface U-1 is undecided about and tickets 50/51 rewrite. Adapt with ADR-0016, not before. |
| `adapter-content-blocks.test.ts` | Keep | 3 | Block helpers; channel-agnostic. |
| `adapter-cordis-dsh-host.test.ts` | **Keep+adapt** | 3 (D-1) | **Pins D-1**: `:190-192` and `:223-225` assert the contract arrives as `spec.request.prompt[0].text`. Must move to `persona` — and gain the `persona` assertion that does not exist today. |
| `adapter-dispatcher-tools.test.ts` | Keep | 2 | Registration + activation gate. |
| `adapter-durable-marker.test.ts` | Keep | 9 | Storage-domain round-trip; the marker gains fields but the port assertions hold. |
| `adapter-policy-inject.test.ts` | Keep | 1 | Per-turn reminder on dispatcher turn start — a genuine turn, so `inject` is correct here and D-4 does not apply. |
| `client-*` (9 files) | Keep | not core-loop | Capsule chip/activation/composition, roster panel, settings card, theme tokens, toolviews, actions, face scaffold. No fidelity content; the only follow-on is new status labels. |
| `coexistence.test.ts` | Keep | not core-loop | Namespacing and keyed-cell safety against a foreign plugin. |
| `composition-polish.test.ts` | **Keep+adapt** | 1 (U-1) | Asserts the dormant registration matrix and that "activation is what raises the surface" — a U-1 surface. |
| `dispatcher-tools.test.ts` | Keep | 2/3/8 | The five tools + deliver-then-complete. Matches the reference's completion-means-delivered. |
| `durable-roster.test.ts` | **Keep+adapt** | 9/10 (B-1, D-5) | **Pins B-1 as intended behaviour**: `:313-321` asserts the freed stream key *can* be re-dispatched ("Stream key is free for a legitimate re-dispatch" → `assert.ok(redispatch.ok)`). Also `:272-273` and `:481-482` assert the landed-undelivered item survives a rebuild. See §3.4. |
| `feature-flag.test.ts` | Keep | not core-loop | Flag schema + freeze semantics (ADR-0005); the disabled path stays stock. |
| `host-seam.test.ts` | Keep | 3/6/7 | Non-blocking spawn, exactly-one wake, late-settle drop. Core match. |
| `multitask-peer.test.ts` | Keep | not core-loop (Phase 2) | Peer lanes and priority. |
| `peer-inbox.test.ts` | Keep | not core-loop (Phase 2) | Accept/dedupe/cap. |
| `plugin-scaffold.test.ts` | Keep | not core-loop (43/44) | Cordis effect contract + command registration — the ticket-44 fix's pin. |
| `policy-assembler.test.ts` | **Keep+adapt** | 7/9 | Pins wake-turn section order and the clamp-at-wake behaviour. Gains the obligation/redrive sections (D-5) — additive assertions, but the "sections appear in order" assertion must change. |
| `report-clamp.test.ts` | Keep | 7 | Pins the clamp's exact behaviour, **deriving every boundary from the constants** rather than hardcoding a length — so re-tuning the bound cannot silently un-test it. U-3 was ruled on 2026-09-18 (ticket 63); the file needed no edit. |
| `restart-honesty.test.ts` | **Keep+adapt** | 10 (D-4) | **Pins D-4**: `:305-308` reads the notice out of `agent.injected` and asserts exactly one. Ticket 57 breaks this **correctly** — the assertion moves to the waking path. The surrounding assertions (content, exactly-once, rebuild-before-publish, unknown rows off-roster, no-stop-affordance) are all sound and must be kept. |
| `roster-snapshot.test.ts` | Keep | not core-loop | Snapshot projection + observer. |
| `steer-command.test.ts` | Keep | 5 | Command routing into the same queue. |
| `steer-queue.test.ts` | Keep | 5 | Single-slot last-wins + delivery at the step boundary. The *core* primitive is unaffected by U-4 (U-4 is about what the adapter calls a step boundary). |
| `stop-semantics.test.ts` | Keep | 6 | Ordered abort, wake disarmed, late result dropped. Direct match. |
| `todo-reconciler.test.ts` | **Keep+adapt** | 9 (D-5) | **Pins D-5**: `:454-487` — titled "does not prune in-progress or undelivered items" — asserts an ancient undelivered item yields **no mutations** and stays in `landedUndelivered` forever. A bounded/escalating implementation must change this. See §3.5. |
| `tool-results.test.ts` | Keep | 2/3/8 | Formatter output. |
| `tool-schema-shape.test.ts` | Keep | not core-loop (45) | Provider-valid JSON Schema; orthogonal infrastructure. |
| `wake-bus-peer.test.ts` | Keep | 4/7 | Peer lanes, ordering, priority interrupt. |
| `wake-bus.test.ts` | Keep | 4/7 | Dedupe, mid-turn hold, batching. Direct match for coalescing. |
| `worker-agent-type.test.ts` | **Keep+adapt** | 3 (D-1, D-3) | Pins the worker contract's section order and "omits reconstruction codenames". Adapt: assert the contract now lands in `persona` (D-1) and contains the safety section (D-3). |
| `worker-lifecycle-fsm.test.ts` | Keep | 3-6 | FSM transitions observed through multitask + fake host. Kept on its own merits (R-2). |
| `worker-registry.test.ts` | Keep | 3 | Roster fields + stream-key uniqueness. Note `:313-321` in `durable-roster` is the *restart* half of this contract. |

---

## 3. The tests that encode a deviation — the most important output

**Headline: the suite is not silent on our deviations. It is complicit. Four of the six are pinned by tests that currently pass, and one bug is explicitly asserted as intended behaviour.** Closing a deviation therefore means failing a green test — by design. The head start recorded on this ticket is **confirmed on four counts and corrected on two**.

### 3.1 Confirmed pins

| Deviation | Test | What it pins | Verified |
|---|---|---|---|
| **D-1** contract channel | `adapter-cordis-dsh-host.test.ts:190-192`, `:223-225` | `spec.request.prompt[0].text` carries the contract. The conversation channel, asserted as correct | Yes — read directly |
| **D-4** restart notice queued | `restart-honesty.test.ts:305-308` | The notice is read from `agent.injected`, exactly one. Pins the queueing primitive itself | Yes — read directly |
| **D-5** unbounded undelivered | `todo-reconciler.test.ts:454-487` (`:484` `mutations` empty, `:486` `landedUndelivered.length === 1`) | An ancient `in_progress && !delivered` item produces **no mutation** and stays in the undelivered bucket indefinitely | Yes — read directly |
| **D-3** safety section | *none* | — | `safety` → **0 hits** across `test/` |
| **D-6** delivery telemetry | *none* | — | `disposition`, `superseded`, `redrive`, `lost` → **0 hits** across `test/` (the single `lost` hit is the comment "Background was not lost" in `wake-bus.test.ts:269`) |

### 3.2 Correction 1 — the D-5 pin is `:454-487`, not `:526`

The head start named `todo-reconciler.test.ts:526` (`assert.deepEqual(first.landedUndelivered, second.landedUndelivered)`) as "the sharp one — D-5 stated as a requirement". **That overstates it.** `:526` lives in a test titled *"same inputs produce the same mutations and do not mutate the inputs"*: it asserts **determinism and input immutability** with `nowMs` held constant. A bounded, escalating implementation is still a pure function of its inputs, so `:526` would **still pass**. It is a good test and should be kept.

The real pin is the separate case at `:454`, whose *title* is the requirement — "does not prune in-progress or undelivered items" — and whose fixture is maximally old (`updatedAtMs: 1_000`, `nowMs: 100_000`, `stalePendingMs: 1`, `completedRetentionMs: 1`). That case asserts an item that has been undelivered for 99 seconds yields `mutations: []`. Under D-5 it must escalate. **Ticket 58 updates `:454-487` and keeps `:490+`.**

The distinction matters operationally: the head-start version would have had an implementer "fix" a purity test for no reason.

### 3.3 Correction 2 — `durable-roster.test.ts:272-273`/`:481-482` are weaker than claimed

These assert the landed-undelivered item still *reports* after a rebuild. A bounded implementation still reports it until the bound is exhausted, so they do not pin D-5's absence. They are **Keep**, and they are evidence *for* the reference-conformant behaviour (recovery keeps the obligation visible). Only `:313-321` in that file needs changing, and for a different reason.

### 3.4 B-1 is not merely unguarded — it is asserted

The head start left B-1 unsearched. The search finds the opposite of a gap: `durable-roster.test.ts:313-321` asserts, with the comment *"Stream key is free for a legitimate re-dispatch"*, that after a rebuild from markers a worker whose status was **live at crash time** can be re-spawned on the same stream key — `assert.ok(redispatch.ok)`. The test's own fixture is a live-at-crash worker (`mode: "live"`, marker status `spawned`).

So the repository has **written the risky transition down as a requirement**. The risk B-1 names (the crashed worker may still be alive on the host, held by no interrupt handle) is not modelled — the test uses a fresh fake host, so it *cannot* detect the orphan. Consequences for ticket 59:

- The fix must not be "refuse the re-dispatch" — that fails a green test asserting a legitimate recovery path.
- The fix must be "make the freed key safe": e.g. hold the recovery in a distinct state that requires an explicit claim, or use the host's continuable-session **cold-resume** to reattach rather than re-spawn. Either way `:313-321` needs revisiting, and this test is the place where the fix's necessity is visible.

### 3.5 The seam we are about to adopt is completely unguarded

`persona` → **0 hits** in `test/`. `agentOptions` → **0 hits**. So ticket 55 wires a host seam that nothing currently watches. Order the work accordingly: **write the `persona` assertion (or the negative: assert `persona` is absent today) before the channel swap**, or a regression in the swap is invisible to the suite.

### 3.6 Method, reproducible

`Grep` over `test/` for each deviation's vocabulary; every positive claim above was then confirmed by reading the cited lines:

| Search | Hits |
|---|---|
| `request\.prompt` / `spec.request.prompt` | 2 sites, both in `adapter-cordis-dsh-host.test.ts` |
| `persona`, `agentOptions` | **0** |
| `safety` | **0** |
| `disposition`, `superseded`, `redrive`, `\blost\b` | **1** (an unrelated comment) |
| `landedUndelivered` | `todo-reconciler.test.ts` (5 sites), `durable-roster.test.ts` (2 sites) |
| `streamKey` in the restart suite | `durable-roster.test.ts` (9+ sites, incl. the re-dispatch assertion) |

**Absence of hits is reported as a finding**, per ticket 54 — and it cuts both ways here: `safety` and `disposition` are absent because the behaviour does not exist, while `persona` is absent because we have never used the seam we now intend to use.

---

## 4. Counts, and the survives / adapts / scrapped split

### Method (reproducible)

Enumerate every `.ts`/`.tsx` under `src/` and `test/`; count lines per file; assign each file exactly one verdict from §1/§2; sum per verdict. No file is counted twice, and every file appears exactly once — the totals below reconcile against the enumeration (53 `src/` + 41 `test/`). Script-driven, so the arithmetic is not hand-rolled.

| Bucket | src files | src lines | test files | test lines |
|---|---|---|---|---|
| **Survives untouched** (`Keep`) | 39 (73.6%) | 9,118 (71.5%) | 32 (78.0%) | 14,549 (76.2%) |
| **Survives, adapts** (`Keep+adapt`) | 13 (24.5%) | 3,513 (27.5%) | 8 (19.5%) | 4,435 (23.2%) |
| **unresolved** (needs U-3) | 1 (1.9%) | 123 (1.0%) | 1 (2.4%) | 116 (0.6%) |
| **Rewrite** | **0** | **0** | **0** | **0** |
| **Delete** | **0** | **0** | **0** | **0** |
| **Total** | **53** | **12,754** | **41** | **19,100** |

**The split, in one line:** 72% of `src` survives untouched, 25% survives with a named wiring/vocabulary change, **nothing is rewritten or deleted**, and exactly one file (1%) cannot be classified until one open question is ruled.

### What "adapts" actually consists of

The 13 `src` modules do **not** adapt because they are wrong. They adapt because something *around* them changes:

- **Channel (D-1/D-2):** `cordis-dsh-host.ts`, `worker/prompt.ts`, `worker/agent-def.ts` — the contract moves house; content is unchanged.
- **Recovery primitive (D-4):** `plugin.ts`, `restart-notice.ts`, `parent-agent.ts` — `inject` → `followup`.
- **Obligation vocabulary (D-5/D-6):** `durability.ts`, `todo-reconciler.ts`, `types.ts`, `policy/assembler.ts`, `policy/prompts.ts` — new fields, a new terminal state, new copy.
- **The loop spine itself:** `multitask.ts` — two edits, both additive (B-1, obligation hooks).
- **U-1/U-4 surfaces:** `activation-command.ts` (activation trigger), `parent-agent.ts` (step-boundary definition).

### The test suite is the part that actually moves

23% of the test suite (8 files, 4,435 lines) must change, and **none of it because the code was wrong** — all of it because the tests assert the deviating behaviour. That is the concrete, previously-invisible cost of the fidelity work, and it is also the suite's value: those files are exactly the ones that will *prove* each fix landed.

---

## 5. Orthogonality check — tickets 43–49

| Ticket | What it fixes | Orthogonal to fidelity? | Evidence in tree |
|---|---|---|---|
| **43** host-half apply never ran live | The plugin row was absent from the running boot tree; a config dump had been misread as running state | **Yes** — a boot/composition defect with no behavioural content in the loop | `plugin.ts` apply shape; pinned by `plugin-scaffold.test.ts` |
| **44** commands unregistered by inverted `ctx.effect` | Registration disposers were passed to `ctx.effect` as if it took callbacks | **Yes** — Cordis lifecycle contract, not loop semantics | `plugin-scaffold.test.ts` "command registration survives apply (cordis effect contract, ticket 44)" |
| **45** dispatcher tool schemas invalid JSON Schema | `false is not of type "array"` — the provider rejected **every** dispatched turn, so no worker could spawn live | **Yes** — structural validity of the schema we hand the provider. It touches loop-stage modules (`core/tools.ts`, `adapter/dispatcher-tools.ts`) but changes no loop behaviour; it makes the existing behaviour reachable | `tool-schema-shape.test.ts` (4 cases, provider-valid walk) |
| **46** client settings watch never fired | Capsule never flipped client-side; footer flag stayed `unknown` | **Yes** — client data path | `client-settings-card.test.ts`, `roster-snapshot.test.ts` |
| **47** plugin settings card (resolved) | Registered the `settings.plugin.item` card | **Yes** — presentation | `client-settings-card.test.ts` (34 cases) |
| **48** desktop launcher drift | Menu served a 39-commit-stale worktree; overlay unreviewable; no kill timer armed | **Yes** — dev tooling; no `src/` surface at all | dev launcher; no unit test by nature |
| **49** capsule/panel hardcoded dark palette | UI used a private palette instead of the host's shared `--dsw-*` tokens, so it could not follow light/dark | **Yes** — tokens only | `client-theme-tokens.test.ts` (14 cases) |

**No ticket in 43–49 is non-orthogonal.** One nuance worth recording rather than smoothing over: tickets **45** and **49** touch files that the fidelity work will also touch (`core/tools.ts`, `adapter/dispatcher-tools.ts`, and the client CSS respectively). In both cases the change is orthogonal in *behaviour* — schema validity and colour tokens — so they should survive intact and should be merged/applied before the fidelity work touches those files, to avoid gratuitous conflict. **43, 44, 45, 46, 48, 49 remain open in the tracker; their code and offline pins are present, but their acceptance criteria were live verification.** "Survives intact" therefore means *the work is still valid*, not *the work is verified*.

---

## 6. Confirm or refute the audit's §6 hypothesis

The audit's provisional effort shape, checked against the survey. **Confirmed in its headline, refuted on two sub-claims.**

| Audit §6 bucket | Verdict | Detail |
|---|---|---|
| "Survives untouched: `worker-fsm`, `wake-bus`, `steer-queue`, `report-clamp`, `types`, `dsh-host`/`fake-host`, `tool-barrier`, roster/presence, all of `client/`, tickets 43–49" | **Mostly confirmed — two errors** | `worker-fsm` ✓, `wake-bus` ✓, `steer-queue` ✓, `dsh-host`/`fake-host` ✓, `tool-barrier` ✓, roster/presence ✓, all of `client/` ✓, tickets 43–49 ✓. **Errors: (1) `types.ts` is NOT untouched** — it must carry the obligation/lost vocabulary (D-5). **(2) `report-clamp.ts` is not "untouched" but "unresolved"** — it is the U-3 addition under review, so it belongs in neither surviving bucket |
| "Survives with a wiring change: `cordis-dsh-host.ts`, `worker/prompt.ts`, `plugin.ts` + `restart-notice.ts`" | **Confirmed but incomplete — 9 modules missing** | All four are correct. The bucket is actually **13 modules**: add `parent-agent.ts`, `durability.ts`, `todo-reconciler.ts`, `multitask.ts`, `policy/assembler.ts`, `policy/prompts.ts`, `types.ts`, `worker/agent-def.ts`, and `activation-command.ts`. The audit was reading the *deviation surface*; the survey reads the *module graph*, and the obligation layer's vocabulary reaches further than the deviation table did |
| "Genuine new work: the obligation layer over `durability.ts`/`todo-reconciler.ts` markers" | **Confirmed** | Exactly one new subsystem, and it is genuinely new — no counterpart exists in the tree for a persisted attempt counter, a terminal `lost` state, or disposition telemetry. It is also the smallest-scope "new" claim possible: it lands *on* two modules that are themselves kept |
| "Scrapped: nothing identified" | **Confirmed for `src/` — provably false for `test/`** | **0 Rewrite / 0 Delete across all 53 `src/` files.** Every mechanism has a counterpart. But in `test/`, 8 files (4,435 lines) must be edited because they assert the deviating behaviour — so "nothing gets scrapped" is true of product code and untrue of the suite. The human's rebuild instinct is not supported for `src/`; it is partly supported for `test/` |

### The bottom line for the rebuild question

**Nothing in `src/` needs to be thrown away.** 72% of it survives untouched, 25% survives with a named change, and the largest single module (`multitask.ts`, 766 lines — the loop spine) needs two additive edits. A rebuild would discard ~9,100 lines of correct, tested loop machinery to fix four bounded defects that already have tickets. That is the answer to ticket 52's Q3, and it lands where the human hoped: **adapt, don't demolish.**

The honest counterweight, so this is not read as optimism: (1) the one file in the "adapts" bucket that carries the most risk is `multitask.ts`, because it is the spine and every other module's behaviour is observed through it; (2) 8 test files will go red during the work, and each one is a decision about whether the assertion or the behaviour is wrong; (3) one question (U-3) genuinely blocks 239 lines of classification. None of that is a rebuild argument, but none of it is free either.

---

## 7. What this survey does NOT establish

1. **Suite baseline: MEASURED, not asserted.** `npm test` on 2026-09-18 at `3287c4d`: **767 tests / 194 suites / 0 fail / 121s**. The repo's "~700" claim understated it. This matters because the §4 test-cost figure only has teeth against a known-green baseline — it now does.
2. **No deviation was closed, no code was changed.** Read-only pass, per ticket 54.
3. **`unresolved` closed to zero.** `report-clamp.ts` + `report-clamp.test.ts` were the only unresolved rows; U-3 was ruled on 2026-09-18 ("copy the reference, or the roomier option if there is nothing to imitate" — and there is nothing, so the clamp stays, re-tuned), and ticket 63 landed the change. Both files are now `Keep`. No row in §1 or §2 is left unclassified.
4. **The reference's worker FSM remains unavailable** (R-2). Our kept `worker-fsm.ts` is *correct*, not *faithful*, and must not be scored as a fidelity match.
5. **Live behaviour is unverified.** Every verdict is a reading of source and tests. Tickets 43–46/48–49 are still open precisely because reading the tree was not enough to confirm live behaviour — the same caution applies to every "Keep" above that depends on host behaviour rather than pure logic.
