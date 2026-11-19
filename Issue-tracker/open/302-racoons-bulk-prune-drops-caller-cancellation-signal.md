# 302 — RACOONS bulk prune drops the caller cancellation signal

**Status:** open
**Labels:** ready-for-agent
**Priority:** P2
**Severity:** medium
**Ship blocker:** no — RACOONS is optional and off by default; the confirmed path requires an enabled, eligible bulk-prune ask.
**Related:** [resolved 189 — entry cancellation](<../resolved/189-racoons-entry-ask-drops-cancellation-signal.md>), [resolved 265 — microcompact teardown](<../resolved/265-pending-microcompact-survives-unload.md>)

## Problem and impact

The mounted RACOONS pre-step path receives the running phase's real AbortSignal, but its bulk-prune branch does not pass it into the prune ask. A caller abort before the answer is consumed leaves the prune stream's independent deadline signal live. The answer can still be consumed and applied as a context cut after that abort.

This is a remaining **bulk-prune** cancellation gap, not a regression claim against the fixed entry-ask path. It permits unwanted optional model work and a late context cut. The original raw output remains in the append-only session log; only the effective surface changes. It is **not** evidence that cancel() itself blocks, of raw-output loss, an indefinite hang, or measured live-provider/disposal latency.

## Reachability and requirement

- [The feature defaults off](<../../src/plugin.ts#L130-L149>). With it off, no RACOONS hook/ledger/context rewrite exists. [Enabled mounting](<../../src/plugin.ts#L2297-L2319>) covers dispatcher, worker and plain-chat sessions.
- A bulk pass requires a queued /prune request or crossed threshold, eligible table/unit data, a usable captured request/route/LLM service, and successful answer parsing. [The branch](<../../vendor/racoons/adapter/plugin.ts#L2293-L2304>) does not ask on every pre-step. The reproduced late cut additionally uses a configured context window and apply enforcement; a record-only bulk pass does not establish a late applied cut.
- [189's expected cancellation contract](<../resolved/189-racoons-entry-ask-drops-cancellation-signal.md#L33-L42>) prevents cancelled optional asks from continuing effects. [Its resolution](<../resolved/189-racoons-entry-ask-drops-cancellation-signal.md#L58-L60>) explicitly fixed the **entry** forwarding path. The bulk helper independently exposes a [caller signal option](<../../vendor/racoons/adapter/prune.ts#L54-L78>) and [forwards it](<../../vendor/racoons/adapter/prune.ts#L210-L214>); its independent deadline does not replace the host phase's cancellation.

## Confirmed source chain

1. Installed [host preStep](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L666-L698>) supplies phase.abort.signal, awaits the pre-step waterfall, and checks abort **after** it returns. [Host cancel](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L579-L585>) aborts the phase and returns synchronously. [Disposal](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1486-L1493>) separately cancels and awaits idle. Delayed hook/idle completion is plausible from the static chain, not measured by this reproduction.
2. The root [mount wrapper](<../../src/adapter/racoons-mount.ts#L242-L272>) forwards listeners/payloads unchanged. The vendor [registered hook](<../../vendor/racoons/adapter/plugin.ts#L2696-L2707>) passes payload.signal into [runStep](<../../vendor/racoons/adapter/plugin.ts#L2173-L2177>), which normalizes the real signal and passes it to [entry asks](<../../vendor/racoons/adapter/plugin.ts#L2206-L2212>). This wrapper/entry half is already correct.
3. The [bulk branch](<../../vendor/racoons/adapter/plugin.ts#L2293-L2298>) instead calls runPrune(session). [runPrune](<../../vendor/racoons/adapter/plugin.ts#L2030-L2068>) accepts no signal and omits it from runRecordOnlyPrune options. After that await it [applies the merged result](<../../vendor/racoons/adapter/plugin.ts#L2073-L2083>) without checking caller abort.
4. The omitted value would flow through [prune forwarding](<../../vendor/racoons/adapter/prune.ts#L210-L214>) and [table ask forwarding](<../../vendor/racoons/adapter/judge-tables.ts#L205-L213>) to [askWire](<../../vendor/racoons/adapter/llm-ask.ts#L234-L273>), which composes its independent deadline with the caller signal only when supplied. The existing [apply leg](<../../vendor/racoons/adapter/prune-apply.ts#L90-L111>) invokes the engine for nonempty eligible removals.

### Compiled correspondence

Evidence imports the actual root [compiled mount](<../../lib/adapter/racoons-mount.js>), whose RACOONS package uses [the plugin export](<../../node_modules/racoons-dsh/package.json#L13-L16>). Read-only filesystem inspection confirmed that node_modules/racoons-dsh is a junction to the product's vendor adapter.

The [compiled hook](<../../vendor/racoons/adapter/lib/plugin.js#L2179-L2184>) forwards the signal and [compiled runStep](<../../vendor/racoons/adapter/lib/plugin.js#L1652-L1655>) receives it, but [compiled bulk branch](<../../vendor/racoons/adapter/lib/plugin.js#L1774-L1779>) calls runPrune(session) and [compiled prune options](<../../vendor/racoons/adapter/lib/plugin.js#L1511-L1548>) omit it. These match the reviewed source above; no differing stale cancellation algorithm was found. No build or host modification was needed.

## Deterministic offline evidence

The existing audit [proof fixture:116–159](<../../.scratch/behavior-audit-2026-11-18/microcompact/proof.test.ts#L116-L159>) drives **registerRacoonsMount → registered pre-step hook → real vendor bulk planner/ask/apply**, not only the low-level helper. It supplies a structural Session/event bus, real scratch SQLite/blob storage, an offline stream stub, and a real AbortController.

The first entry answer deliberately fails open. The second ask is the bulk answer; [the stub aborts the caller at that stream invocation, before returning the answer iterator](<../../.scratch/behavior-audit-2026-11-18/microcompact/proof.test.ts#L116-L125>). A valid bulk answer then arrives after abort. The paired no-abort control follows the same route and applies normally. This is not an already-committed synchronous edit being interrupted, and it is not a pending-stream latency test.

The independent reviewer ran this existing fixture once, filtered to cancellation cases and controls, with a 45-second timer armed immediately after child launch. Exact executed command (PowerShell):

~~~powershell
node --input-type=module -e "import {spawn} from 'node:child_process';const p=spawn(process.execPath,['--import','tsx','--test','--test-name-pattern=microcompact control|pre-step caller aborts|mounted RACOONS','.scratch/behavior-audit-2026-11-18/microcompact/proof.test.ts'],{stdio:'inherit'});const timer=setTimeout(()=>{p.kill();process.exitCode=124;},45000);p.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});"
~~~

Observed output, recorded from that review run (not rerun during filing):

~~~text
MICRO_ABORT {"aborted":true,"appendedEvents":2,"boundaries":1,"outcome":"ratio-met"}
RACOONS_ABORT {"abortAtPrune":false,"asks":2,"callerAborted":false,"pruneSignalAborted":false,"originalRetainedOnSurface":false,"replacementEvents":1,"journalApplied":true}
RACOONS_ABORT {"abortAtPrune":true,"asks":2,"callerAborted":true,"pruneSignalAborted":false,"originalRetainedOnSurface":false,"replacementEvents":1,"journalApplied":true}
✔ microcompact control writes its boundary after a normal successful pass (1.951ms)
✖ microcompact must not rewrite context after the pre-step caller aborts (2.6864ms)
✔ mounted RACOONS control applies normally (82.3244ms)
✖ mounted RACOONS prune must honor caller cancellation (55.7877ms)
ℹ tests 4
ℹ pass 2
ℹ fail 2
ℹ duration_ms 535.7582
~~~

Exit code was **1**. The RACOONS assertion at [fixture:157](<../../.scratch/behavior-audit-2026-11-18/microcompact/proof.test.ts#L151-L158>) fails because its ask signal remains un-aborted (false !== true). The following no-cut assertion at line 158 is **not reached** after that failure. Nevertheless, the observations printed before it establish one replacement and journalApplied:true after caller abort, and the original result no longer on the effective surface. The [Session double's append log](<../../.scratch/behavior-audit-2026-11-18/microcompact/proof.test.ts#L13-L33>) retains the original bytes; replacement changes surface-node references, not the old append record.

The author's earlier [saved output](<../../.scratch/behavior-audit-2026-11-18/microcompact/proof-output.txt>) independently records the same bulk observations. It also contains other tests; it is not the reviewer's 535.7582-ms run log.

### Evidence limits and exclusions

- Structural Session/event-bus integration, **not native Session/API-cancel integration**. Actual installed host signal/cancel/disposal behavior was read statically. No real model completion, network, live hold/agent operation, or restart occurred.
- A normal mounted bulk control applies. The aborted case establishes missing signal propagation plus a late valid-answer cut. It does not measure cancellation latency, pending provider resource use, or disposal completion. It does not establish an indefinite hang.
- The filter also includes a red microcompact caller-abort assertion. That is **not a second defect filed here**: [ADR-0029](<../../docs/adr/0029-deterministic-microcompact-boundary-marker.md#L17-L23>) and [265](<../resolved/265-pending-microcompact-survives-unload.md#L65-L70>) do not settle ordinary phase-abort versus finishing a consistent maintenance pass. Teardown/deactivation cancellation is a different established contract.
- Boundary-put failure is excluded. [124:126](<../resolved/124-microcompact-boundary-marker.md#L126>) and [265:13](<../resolved/265-pending-microcompact-survives-unload.md#L13>) accept append-first/marker-last crash posture. The executed filter excluded that test.

## Smallest remedy and acceptance criteria

- [ ] Pass the real caller signal from runStep into runPrune and runRecordOnlyPrune, preserving the helper's existing independent deadline composition. Retain callers that legitimately have no signal.
- [ ] Check caller abort before starting optional bulk work and after awaited work, especially **before bulk apply**. A late valid bulk answer from a cancelled phase must not apply a cut. Do not require rollback of an already committed synchronous replacement.
- [ ] Add a focused offline regression at the **actual mounted pre-step hook**, with eligible bulk data and a no-abort control. Assert that caller abort reaches the bulk stream and that a late valid answer produces no bulk replacement/applied result. Include already-aborted input and an abort during a controlled pending bulk stream; preserve normal apply and deadline behavior.
- [ ] If asserting prompt hook release, use the mounted hook and a gated stream rather than an isolated ask helper. Do not infer native API/disposal/provider timing from a structural fixture.

## Duplicate check and filing scope

Read [tracker conventions](<../issue-tracker.md>) and [resolved 189](<../resolved/189-racoons-entry-ask-drops-cancellation-signal.md>) before filing. Searched the whole tracker, including open/deferred/resolved/cancelled, for the 302 prefix, bulk cancellation/abort/signal phrases, runPrune, runRecordOnlyPrune, and broader prune/cancellation matches. No equivalent bulk-prune signal issue or existing 302 prefix was found. 189's resolution is explicitly entry-only; 265 concerns microcompact unload coordination, not this bulk lane.

Only this local issue is created in this filing. No test rerun, fix, configuration/source change, index generation, commit, report edit, live call, or process restart. Existing dirty work and audit artifacts are preserved.

## Comments

- 2026-11-18 — Filed after independent review as P2/medium, optional/nonblocking. Caller-signal omission and late bulk cut reproduced; ordinary microcompact abort policy and accepted marker-put posture excluded.
- 2026-11-18 — Final review arbitration: count **one confirmed compaction finding**, the bulk-prune gap in this issue. The author's five-check run (three controls pass, two assertions red) and the reviewer's filtered four-check run (two controls pass, two assertions red) use different selections and are both recorded evidence; a red assertion does not itself establish a mandatory phase-abort rule. No accepted requirement was found that ordinary microcompact must stop rather than finish a consistent maintenance pass on caller phase abort. That behavior remains a policy risk only, not a second confirmed defect. No additional test was run for this arbitration note.
