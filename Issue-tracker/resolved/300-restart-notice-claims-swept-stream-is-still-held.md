# 300 — Restart notice claims a swept stream is still held

**Status:** resolved
**Type:** bug
**Labels:** ready-for-agent
**Priority:** P3 — low; misleading recovery warning only
**Blocked by:** none
**Related:** [31 — restart honesty](<../resolved/31-conversational-stop-restart-honesty-rebuild-on-activation.md>), [59 — unknown-state stream holds](<../resolved/59-freed-stream-key-double-worker-risk.md>), [90 — activation generation and rebuild ordering](<../resolved/90-restart-honesty-carried-verifier-findings.md>)

## Problem and bounded impact

After activation rebuilds a bare running-status worker marker, the restart sweep successfully deletes the stale marker and releases its in-memory unknown-state hold. The queued notice nevertheless says, in the present tense, “Stream(s) todo-live are held by them, so re-dispatching onto those streams is refused.” That clause was composed before the sweep and is delivered unchanged on the first real user message.

The historical clause “Before the last restart, 1 worker(s) were still running” is correct and is **not** the defect. A control carrying a durable worker wake row retains one actual hold and has truthful held-stream guidance.

This can misdirect a dispatcher/user toward unnecessary avoidance, a new stream key, or an interrupt of a worker the sweep already released. **Only misinformation is demonstrated: this is NOT a hold leak, NOT an observed actual spawn/refusal or data-loss defect, and NOT the established root cause of any old/live incident.** P3/low is appropriate; no ship-blocker claim.

## Confirmed pre-fix source chain (audit baseline)

1. [Activation hook](<../../src/plugin.ts#L1877-L1886>) starts the real rebuild-and-notice chain.
2. [Rebuild and notice composition](<../../src/plugin.ts#L1742-L1758>) awaits the rebuild, then immediately assembles notice text from its historical report at line 1754.
3. [Restart sweep](<../../src/plugin.ts#L1776-L1787>) runs and is awaited **after** that text is assembled.
4. [Resumability discriminator](<../../src/core/multitask.ts#L1520-L1563>) distinguishes a bare stale marker from an actual durable worker wake identity. The [sweep](<../../src/core/multitask.ts#L2562-L2604>) preserves wake-backed, adopted, and otherwise unsafe-to-release holds; it releases only the stale case.
5. [Release ordering](<../../src/core/multitask.ts#L1474-L1517>) deletes the durable marker before deleting the actual in-memory hold.
6. [Queue unchanged notice](<../../src/plugin.ts#L1803-L1810>) stores the pre-sweep text. [Notice gate](<../../src/adapter/parent-agent.ts#L1547-L1562>) and [surface append](<../../src/adapter/parent-agent.ts#L606-L655>) deliver it once after the real user-message gate opens.
7. The historical part and the unconditional present-tense claim coexist in [restartUnknownStateLine](<../../src/adapter/restart-notice.ts#L54-L69>); only lines 64–65 are contradicted by the demonstrated post-sweep state.

## Deterministic offline proof and independent review

Evidence is scratch-local and not a production test/edit:

- [Fixture](<../../.scratch/behavior-audit-2026-11-18/restart-notice/proof-a.fixture.test.ts#L513-L562>) reuses the repository restart host fixture and applies the actual plugin; it checks the exact real core returned to the plugin, durable marker/wake tables, then the first-user visible notice.
- [Original runner](<../../.scratch/behavior-audit-2026-11-18/restart-notice/run-proof-a.mjs#L18-L28>) bundles product sources with one observation wrapper: call the real createMultitask, capture its returned object for read-only assertions, and return that same object. It does not replace rebuild, sweep, lifecycle, notice assembly, or storage adapter behavior. The [existing bundle wrapper](<../../.scratch/behavior-audit-2026-11-18/restart-notice/proof-plugin.mjs#L2783-L2787>) was also read independently.
- [Original run 1](<../../.scratch/behavior-audit-2026-11-18/restart-notice/proof-a-run1.log#L1-L29>): 1 test, 0 pass, 1 fail; total 543.729 ms.
- [Original run 2](<../../.scratch/behavior-audit-2026-11-18/restart-notice/proof-a-run2.log#L1-L29>): same mismatch; total 470.0819 ms.

Independent reviewer invocation, run once against the **existing** bundle without rebuilding or overwriting original runner/bundle/logs:

```text
node .scratch/behavior-audit-2026-11-18/restart-notice/review-a.mjs
```

The new [review-only wrapper](<../../.scratch/behavior-audit-2026-11-18/restart-notice/review-a.mjs>) arms a 45-second timer before launching the inner fixture command:

```text
node --import tsx --test .scratch/behavior-audit-2026-11-18/restart-notice/proof-a.fixture.test.ts
```

Independent result: **1 test / 0 pass / 1 fail, 412.8301 ms, exit 1**, assertion at [fixture:561](<../../.scratch/behavior-audit-2026-11-18/restart-notice/proof-a.fixture.test.ts#L559-L561>): bare marker and actual hold were swept, but the first-user notice still claims the stream IS held/refused. Its observations match both original runs:

| Case | Durable marker after sweep | Actual core hold count | Worker wake row | Present held/refused clause | Verdict |
|---|---|---:|---|---|---|
| Bare running-status marker | absent | 0 | absent | present | false current-state guidance |
| Same marker + valid wake identity | present | 1 | present | present | truthful control |

An initial inline reviewer launch failed at PowerShell/Node argument quoting with a SyntaxError before executing the fixture; the authorized reviewer wrapper then executed the fixture exactly once. No live host, credential/config access, model/API call, real restart, or source edit occurred.

**Proof scope:** confirmed for the real plugin chain over the synchronous persistent-table host stub after activation/sweep completion. This does not establish installed-runtime prevalence, process-crash filesystem ordering, or an actual stock-tool refusal. The control and actual core hold read prevent confusing the historical report with present state.

## Existing coverage and smallest regression seam

[Existing restart notice assertions](<../../test/restart-honesty.test.ts#L623-L659>) pin notice provenance/form, unknown wording, historical count, transcript pointer and restored count; they do not compare the present held-stream claim with actual post-sweep holds.

Use that same real-plugin restart fixture seam, not a standalone string-only test. Add two cases: bare marker versus the same marker with a valid worker wake row. Await completed activation/sweep, assert actual marker and core hold state, then drive the first real user message and assert notice semantics. Preserve the existing historical unknown count/id/transcript, no-auto-wake, exactly-once and truthful wake-backed control expectations. No broader suite or live reproduction is necessary to establish this narrow defect.

## Minimal remedy and acceptance criteria

Build the **present-state** held-stream guidance after the awaited sweep from the actual remaining session holds, or recompute that guidance at delivery. Preserve the original report as historical evidence: do not delete the historical unknown-worker notice merely because a stale hold was released. Skipped/error-preserved/wake-backed holds must retain truthful current guidance. Do not alter hold-release, wake identity, durability, or restart-wake policy as a copy fix.

- [x] Bare-marker case has marker absent and actual holds 0; the first-user notice does not unconditionally claim its old stream is currently held or refused.
- [x] Wake-backed control retains marker/wake row and actual hold 1; the notice accurately reports the surviving hold.
- [x] Historical pre-restart unknown status/count/ids/transcript pointers remain reported.
- [x] Notice remains one-time and user-message-gated; no automatic model turn or new UI control is introduced.

## Duplicate search

All tracker states were searched (open, deferred, resolved, cancelled); no existing issue with this completed-sweep-versus-present-notice contradiction was found. The closest resolved records were read:

- [31](<../resolved/31-conversational-stop-restart-honesty-rebuild-on-activation.md#L8-L19>) introduced rebuild/one-time historical unknown-state honesty, not this later sweep/copy interaction.
- [59](<../resolved/59-freed-stream-key-double-worker-risk.md#L43-L50>) establishes real unknown-state occupancy and its warning; this issue does not challenge retained wake-backed holds.
- [90](<../resolved/90-restart-honesty-carried-verifier-findings.md#L20-L26>) covers stale activation generations and rebuild/publication ordering, not a completed valid chain with stale present-tense text.
- [197](<../resolved/197-delivery-redrive-wake-spends-budget-twice.md>) concerns redrive budget/lost delivery, not this warning.
- [298](<../resolved/298-activation-notice-corrupts-session-log.md>) concerns session surface-head integrity, not current hold wording.

## Comments

### 2026-11-18 — audit proof independently reproduced; no implementation

Filed from the bounded audit and independent existing-bundle fixture review. Severity intentionally limited to P3/low misleading warning. Only this issue and the reviewer-only scratch wrapper were created by this reviewer; generated index is owned by the coordinating writer and was not edited here.

### 2026-11-18 — fixed, regression green, independent review accepted

**Resolution:** [rebuildAndNotice](<../../src/plugin.ts#L1743-L1800>) retains the original historical rebuild report, awaits the existing restart sweep, rechecks the captured activation generation after that await, then assembles the notice with `listUnknownStateHolds(sessionId)`. The [notice assembler](<../../src/adapter/restart-notice.ts#L54-L110>) now receives current remaining holds explicitly. With no remaining holds it omits only the present held/refused/remedy clause; historical unknown count, ids, transcript pointers and restored count remain. Wake-backed or error-preserved holds retain current held-stream guidance. Neither the historical report nor the sweep return array is substituted for actual remaining holds.

**Regression seam:** the existing [real-plugin bare-marker first-user test](<../../test/restart-honesty.test.ts#L511-L713>) now proves marker/wake absence after the awaited sweep, preserves history and user-message gating, and rejects the stale held/refused wording. The [wake-backed control](<../../test/restart-honesty.test.ts#L715-L777>) verifies surviving marker/wake identity, current held guidance, history, no auto-wake, and exactly-once first-user delivery. Existing [core sweep controls](<../../test/restart-hold-sweep.test.ts#L161-L435>) retain the actual hold-release, wake-backed/mirror skip, refused-delete and unreadable-wake-row coverage; no production observation hook or replacement core was added. Existing activation-generation regressions remain in the focused run.

**Red → green evidence:** both runs used the same direct command, bypassing npm pretest and vendor build scripts, with a 20-second child kill timer armed before launch:

```text
node --import tsx --test test/restart-honesty.test.ts test/restart-hold-sweep.test.ts
```

- [Red output](<../../.scratch/behavior-fixes-2026-11-18/300/red.log#L50-L77>): 16 tests, 15 passed, 1 failed, exit 1, 584.6067 ms. The sole failure is the exact bare-marker symptom: the marker/wake row is absent but the first-user notice still claims the stream is held/refused. The wake-backed control and existing core skip/error/generation tests pass.
- [Green output](<../../.scratch/behavior-fixes-2026-11-18/300/green.log#L35-L59>): 16 tests, 16 passed, 0 failed, exit 0, 512.6411 ms. The same command and bounded timer were used. Narrow `git diff --check` also passed.
- **Independent review:** reviewer 185 accepted the fix and independently reran 16/16 passing in approximately 513 ms with no blocker; the coordinating parent relayed that acceptance before authorizing this closeout. No additional test run was performed during the documentation-only closeout.

**Scope:** production changes are only the restart rebuild/notice block in [plugin.ts](<../../src/plugin.ts#L1743-L1800>) plus the [notice adapter](<../../src/adapter/restart-notice.ts>), with regression additions in [restart-honesty.test.ts](<../../test/restart-honesty.test.ts>). No core, sweep, hold-release, wake identity, durability or parent-agent behavior changed. No live restart, model/API call, config/profile/global install, reference/vendor/generated-output change, commit, staging, or legal audit was performed. Deployment is not claimed here; the parent coordinates that separately. Shared source ownership was released after green. The generated issue index is reserved for the coordinating writer after the authorized ticket batch finishes.
