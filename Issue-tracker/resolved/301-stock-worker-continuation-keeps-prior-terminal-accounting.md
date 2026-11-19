# 301 — Stock worker continuation keeps the prior run's terminal accounting

**Status:** resolved
**Type:** bug
**Labels:** ready-for-agent
**Severity:** P2 — a supported resumed worker executes and returns a new result while the plugin still represents its prior completed run and ignores the new settlement. Stock parent delivery still works.
**Confidence:** high for the same-process continuation accounting integration; no claim about a live incident's cause.
**Blocked by:** nothing for the focused regression and identity design.
**Origin:** 2026-11-18 behavior audit; producer ran the focused proof twice and independent reviewer 742203d4 repeated the red result once. This filing pass read the artifacts/source without rerunning tests.
**Related:** [190 — resolved cold-resume running-edge race](<../resolved/190-cold-resume-drops-worker-running-edge.md>); [197 — resolved redrive budget double charge](<../resolved/197-delivery-redrive-wake-spends-budget-twice.md>); [stock adoption tests](<../../test/stock-worker-adoption.test.ts>); [current cold-resume contract](<../../PRD-dsh-multitask-dispatcher.md#L154>).

## Requirement and defect

The current [PRD:154](<../../PRD-dsh-multitask-dispatcher.md#L154>) explicitly supports stock `send_message` cold-resuming a settled continuable worker. A verified new execution of that same child session must be represented as current work in the plugin's ownership/accounting and must record its own settlement/result. It must not rewrite or reopen a previously delivered obligation, and duplicate/stale events from the old run must remain harmless.

Observed sequence: first worker run completes, the product marks its old todo delivered, and the first Agent is disposed. Stock `send_message` then cold-resumes a **distinct real Agent with the same session id**; restored context and the new task reach its normally running second turn. The plugin still reports the old `WorkerRecord` as `completed`, does not own the active child, has no current marker/wake identity, and accepts only the first of two raw settlements. Its settle record retains `FIRST_RESULT_4f81` after stock delivers `SECOND_RESULT_19c2` to the parent.

This is a plugin continuation-accounting defect, **not lost upstream delivery**. The old delivered todo staying byte-for-byte unchanged is correct and must be preserved. A specific fresh `in_progress` todo is not a requirement of this ticket: the representation and delivery-obligation identity of the new run are remedy-specific.

## Confirmed offline evidence

- [Result summary:1–13](<../../.scratch/behavior-audit-2026-11-18/stock-resume/result.json#L1-L13>): second Agent really running; raw settles **2**, product settles **1**; old todo unchanged; plugin status `completed`; ownership false; second result absent from product; upstream parent received second result.
- [While-running snapshot:63–100](<../../.scratch/behavior-audit-2026-11-18/stock-resume/result.json#L63-L100>): no ownership, marker or wake row, and stale first-run settlement. [After second settle:144–157](<../../.scratch/behavior-audit-2026-11-18/stock-resume/result.json#L144-L157>) still holds the first result.
- [Proof:105–136](<../../.scratch/behavior-audit-2026-11-18/stock-resume/characterize.mjs#L105-L136>) asserts first completion/delivery, actual disposal, accepted stock control call, distinct resumed Agent/same id/running, both raw settles and second result, old todo deep equality, and successful upstream second-result delivery.
- [Failure record:2](<../../.scratch/behavior-audit-2026-11-18/stock-resume/failure.json#L2>) identifies the red assertion at proof line 135. That assertion additionally expects a new active todo, which is a **candidate repair shape, not the independent contract**; the recorded false ownership, terminal active-run representation and stale settlement establish the narrower defect without choosing that shape. The second-result assertion is at proof line 136; its false observed value is independently recorded before line 135 fails.

Exact reproduction from repository root (the script sets a 20-second hard timer):

```text
node --import tsx .scratch/behavior-audit-2026-11-18/stock-resume/characterize.mjs
```

### Boundary and limits

The proof runs real stock native executor/control, Runtime/manager, AgentLoop and sessions with actual product host/core/lifecycle binding. Product callbacks match the integration's [reattachment/adoption wiring:1311–1333](<../../src/plugin.ts#L1311-L1333>); the proof supplies them at [94–100](<../../.scratch/behavior-audit-2026-11-18/stock-resume/characterize.mjs#L94-L100>). Initial creation enters `Runtime.startActivation`, not the model-facing spawn tool. The second run is initiated by a scripted parent tool call through real stock `send_message`, not by manually firing resume/settle events. Persistence and inference are deterministic in-memory fixtures, with no network or external model/API completion.

`policyEnabled: false` excludes injected standing policy, full plugin `apply`, UI and automatic delivery-redrive behavior. This proves the continuation accounting mismatch, not rendered UI behavior, live-model behavior, or the cause of an observed live `lost(max-redrives)` discrepancy. Both raw terminal events and successful parent receipt are positive controls.

## Source diagnosis (historical pre-fix snapshot)

1. On the first accepted terminal event the host records the session id in `settledWorkerIds` ([host:2792](<../../src/adapter/cordis-dsh-host.ts#L2792>)) and prunes its live ownership ([cleanup:2813–2827](<../../src/adapter/cordis-dsh-host.ts#L2813-L2827>)).
2. Later reattachment refuses that id ([reattach:3290–3308](<../../src/adapter/cordis-dsh-host.ts#L3290-L3308>)); the stock adoption predicate also refuses it ([stock predicate:3624–3637](<../../src/adapter/cordis-dsh-host.ts#L3624-L3637>)). These lifetime session-id guards cannot distinguish a stale announcement from a legitimate new stock activation of that session.
3. The second `subagent/end` is rejected at the same lifetime id gate ([settle:2765–2772](<../../src/adapter/cordis-dsh-host.ts#L2765-L2772>)), before current result publication.
4. Core adoption independently treats any existing record keyed by session id as already adopted ([core:2052–2057](<../../src/core/multitask.ts#L2052-L2057>)). A naive host-only tombstone reset therefore does not establish a new run's core accounting.
5. [FSM:28–31](<../../src/core/worker-fsm.ts#L28-L31>) correctly rejects transitions out of the **old run's** terminal state. Do not weaken that safety rule to pretend a second execution is the first run becoming live again. The missing integration is verified run/activation identity versus reusable child session identity.

Existing [stock adoption coverage:300–330](<../../test/stock-worker-adoption.test.ts#L300-L330>) verifies repeated announcement idempotency and an initial run's running/settled lifecycle. It does not execute completed → delivered → disposed → actual same-id stock cold resume → second settlement in one product host/core lifetime.

## Implemented repair contract

Introduce or propagate a **verified activation/run identity** at the active stock continuation seam, separate from the child's session id. Use it consistently for ownership/adoption, current-run projection, settlement/result storage and once-per-run deduplication. The identity must come from actual host activation evidence, not merely another `agent/created` event or an id reappearing.

Preserve the old delivered todo and old run's terminal history. Decide explicitly how the new run's obligation is represented; this ticket does not mandate a new todo or reopening one. Do not arbitrarily clear all tombstones, loosen terminal-state guards, or let stale events from the old activation resurrect it. Preserve stock completion notices, with no additional duplicate parent delivery.

### Acceptance criteria

- [x] Real completed/delivered/disposed worker → stock `send_message` → distinct same-id Agent is tracked as a verified current execution while it is running. Its current ownership/durable recovery identity and plugin projection agree with host activity.
- [x] Old delivered todo and terminal history remain unchanged; define the new run's separate accounting/obligation identity without claiming the old result became undelivered.
- [x] Second execution's terminal event records its own result exactly once, rather than leaving only the first execution's settlement.
- [x] Duplicate and delayed first-run events do not change or settle the new run. Duplicate events within each run remain no-ops; aborted/stop guards stay valid.
- [x] The upstream parent still receives the second result, with no duplicate notice introduced by the integration.
- [x] Regression drives actual stock cold resume, driver activity and two distinct run results—not shallow repeated adoption/settle calls alone. Adapt the scratch invariant to the chosen accounting model rather than mandating its fresh-todo assumption.

## Duplicate check

Searched `open`, `deferred`, `resolved`, and `cancelled` for continuation, cold-resume, reattachment, repeated settlement, terminal resurrection, same-session resume and tombstone terms; no matching current ticket was found.

- [190:14–25](<../resolved/190-cold-resume-drops-worker-running-edge.md#L14-L25>) is the resolved fresh-core adopt-before-marker-rebuild running-edge race. Here the first terminal record already exists in the same process after delivery; the new activation is rejected by lifetime guards. No delayed marker-read race is needed.
- [197:10–24](<../resolved/197-delivery-redrive-wake-spends-budget-twice.md#L10-L24>) concerns spending one result's retry budget twice. This proof does not run redrive and preserves the old delivered obligation.
- [142:40](<../resolved/142-workers-wakeable-on-send.md#L40>) and same-run terminal guards prevent unintended resurrection; the newer stock continuation contract explicitly permits a new settled-worker activation. The repair must distinguish those cases, not erase the earlier safety rule.

## Comments

- 2026-11-18 — Filed one P2 integration bug after reading the producer's evidence and parent-supplied independent repeat. Documentation only: no proof/test rerun, product/config edit, implementation, live inference, restart or commit. Index regeneration is held for parent coordination.

- 2026-11-18 — Resolved after focused implementation, vertical red → green regressions and coordinating-parent acceptance of independent host/native and core/durability reviews. Native `subagent/start` and `subagent/end` carry a paired `runId`; the adapter verifies the local current Agent, and the reusable child session id remains an address rather than terminal-accounting identity. Each new verified run has a separate current record and todo; old terminal records/results are retained by run id. The terminal FSM remains terminal and session tombstones are not globally cleared.
- 2026-11-18 — [Native continuation regression](<../../test/stock-worker-continuation.test.ts>) first failed on ownership false during the actual cold-resumed second execution; it passed after run-id handoff. It drives registered stock `send_message`, distinct same-id Agents, restored context, two results, exact once-per-run settlement and one stock second-result notice. Captured old start/end, old Agent status/disposal and duplicate second end are harmless; the old delivered todo/history remain unchanged. The focused host/adoption/lifecycle slice passed **128/128** before final activity additions.
- 2026-11-18 — Two activity red → green slices: (1) a B Session-appended tool event was recorded in the ring but hidden by A's lifetime tombstone; the two live getters now use the existing current-run terminal predicate; (2) the final fixture upgraded the positive control to actual registered deterministic work through the native executor in both A and B, then replayed captured A `tool/call` with the OLD Session object during B. It failed with B count **2 rather than 1**; the bounded worker-event guard now accepts only `currentRun.agent.session === emittingSession` when native identity is present, preserving the legacy/no-native path. Final native fixture **1/1 passed** in 1.139 s; old A count/activity cannot mutate B, B activity/timestamp are present, and prior activity clears at new verified start.
- 2026-11-18 — [Core run-record controls](<../../test/stock-worker-run-records.test.ts>) cover per-run terminal history, stale/untagged settlement rejection, current-B await without returning A's old result, keeping undelivered A separate, and repeated old delivered-todo cleanup not deleting B's marker/wake identity. [Durability controls](<../../test/worker-native-run-durability.test.ts>) cover optional run identity in current markers/wake rows, terminal reconstruction and validation with readable legacy rows. Coordinating parent reports independent consumer **50/50** and durable/legacy **44/44** passing and final reviews approved. These are supplied review results, not extra runs by the ticket closer.
- 2026-11-18 — The extra passive native start subscription changes the dormant inventory from seven to eight. Targeted expectation/comment updates preserve pre-existing test work. Final [composition fixture](<../../test/composition-polish.test.ts>) run passed **7/7** with `node --import ./test/support/stock-scope-loader.mjs --import tsx --test test/composition-polish.test.ts` and the known nonsecret APPDATA host path. All actual commands bypassed npm pretest/vendor prebuild scripts.

## Verification boundary at close

The original audit and historical source diagnosis above are preserved, not rewritten as passing evidence. The native regression uses deterministic in-memory sessions/inference with actual stock runtime/executor/control and product host/core/lifecycle binding. Its final activity control executes a registered offline tool, superseding the earlier Session.append-only positive-control limitation. It still uses `policyEnabled: false`: no full-plugin-apply/UI/live-model or automatic-redrive claim follows from that fixture. Core/durability behavior is checked separately at accepted regression seams. Global grouped validation is coordinated independently and was pending this documentation close; per-ticket checks are not substituted for an all-suite result. No deployment, host restart, install/config/profile change, reference-tree work, generated/vendor change, staging/commit/push or legal audit is claimed. Generated index updates remain with the coordinator.

