# 186 — RACOONS asks leave the stream iterator open after a finish chunk

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P2
**Severity:** medium
**Ship blocker:** no — RACOONS is an optional feature, off by default; the confirmed defect is iterator cleanup in its ask path.

## Problem and impact

The shared RACOONS ask loop manually advances an async iterator and breaks as soon as it receives a `finish` chunk. It neither resumes the iterator to completion nor calls its `return()`, and has no closing `finally`. A yielded finish value is still an iterator result with `done: false`; receiving that value does not complete an async generator.

Consequently, an ask can report `status: 'answered'` while its stream generator remains suspended and its cleanup has not run. The installed host also yields the chunk before reaching its own closing `finally`, so it does not compensate by closing the underlying iterator before exposing finish. The confirmed impact is incomplete iterator lifecycle cleanup. The audit did not establish live socket leaks, resource exhaustion, or that every provider retains resources after finish.

## Confirmed evidence and reachable path

- **Source and shipped JavaScript agree:** [ask loop:263–291](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L263-L291>) obtains the iterator, awaits `nextWithin` and breaks at line 282 on finish. The catch returns typed refusals, but there is no closing `finally`. [Shipped loop:181–212](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/lib/llm-ask.js#L181-L212>) has the same finish break at lines 199–201. [nextWithin:136–148](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L136-L148>) only races one `iterator.next()` against the signal; it does not close the iterator. [The answered result:292–300](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L292-L300>) can follow immediately after the break.
- **The installed host does not pre-close finish:** [installed dsh-llm stream loop:2359–2385](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L2359-L2385>) yields `item.value` at line 2378. That yield suspends the wrapper before its `finally` at lines 2380–2384, which calls the underlying iterator's `return()` when it has not completed. The consumer must resume or close this wrapper for that cleanup to run.
- **This is reachable when explicitly enabled:** [root flag:123](<C:/Users/TZ/Desktop/dsh-bot/src/plugin.ts#L123>) defaults to false and [mount activation:2077–2086](<C:/Users/TZ/Desktop/dsh-bot/src/plugin.ts#L2077-L2086>) is guarded by it; [shipped flag:62](<C:/Users/TZ/Desktop/dsh-bot/lib/plugin.js#L62>) and [shipped activation:1681–1689](<C:/Users/TZ/Desktop/dsh-bot/lib/plugin.js#L1681-L1689>) agree. The root mount reads the real host LLM service at [readLlm:216–225](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/racoons-mount.ts#L216-L225>) and exposes it at [270–272](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/racoons-mount.ts#L270-L272>); [vendor service resolution:2564–2573](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2564-L2573>) passes it into the mount.
- **The entry lane consumes this helper:** [pre-step listener:2657–2666](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2657-L2666>) calls `runStep` → [runEntryAsks:2173](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2173>) → [askEntry:1887](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L1887>) → [entry sendOnce / askWire:432–449](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/entry-ask.ts#L432-L449>). This requires the normal askable result, usable ledger/fork and configured route; it is not a claim that every pre-step sends an ask. The [LLM observer:2649–2655](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2649-L2655>) simply returns `next()` and performs no compensating drain or close.

## Deterministic reproduction — prior audit, not rerun during filing

The original audit reported a file-free, offline probe against the actual shipped JavaScript helper. To reproduce that case:

1. Import the shipped `askWire` helper linked above and supply a fake LLM service whose `stream` is an async generator. Initialize `streamFinallyRan = false`.
2. In the generator's `try`, yield one `text-delta` chunk containing nonempty decision text, then a `finish` chunk with reason `stop`. In its `finally`, set `streamFinallyRan = true`. No network or provider resources are needed.
3. Await `askWire` with nonempty provider/model names and a valid wire request: an empty system string, empty tool list and a user message. Inspect the returned status and the cleanup flag immediately after it resolves.
4. **Observed:** `status: 'answered'`, `streamFinallyRan: false`; process exit code `0`. **Expected:** returning the answer completes or closes the owned iterator, so the generator's cleanup has run exactly once.

This observed result is supplied prior-audit evidence, not a new run by the ticket author. Independent validation confirmed the static defect and reachable entry path before filing; the ticket author re-read the cited source, shipped JavaScript and installed-host ranges. Timeout and cancellation cleanup omissions were not independently probed. Finish-kind acceptance and the entry caller's missing cancellation signal are separate candidates, outside this ticket.

## Acceptance criteria

- [ ] Complete or close the owned, still-open iterator exactly once on finish and other early exits. A yielded finish value must not be mistaken for `done: true`; natural completion must not trigger redundant closure.
- [ ] Handle cleanup on stream errors, deadlines and caller cancellation as appropriate to the iterator state, including an outstanding `next()`. Preserve the helper's typed outcomes and the primary failure; cleanup must not swallow or replace that failure.
- [ ] Add a minimal, meaningful offline regression using a generator with observable `finally` cleanup. Text followed by finish must still return the answer and run cleanup exactly once. Cover a representative exceptional/aborted early exit and avoid double closure after natural completion.

## Scope, duplicate check and filing validation

[Ticket 145](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/145-racoons-redo-latest-full-coverage.md>) and [ticket 148](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/148-racoons-resync-latest.md>) cover integration/resync; [ticket 150](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/150-racoons-record-only-semantics.md>) accepts the entry checkpoint applying under record-only. They do not resolve iterator cleanup. [Ticket 182](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/182-workflow-bypasses-worker-leaf-tool-barrier.md>) and [ticket 200](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/open/200-worker-composition-failure-keeps-unrestricted-worker-live.md>) concern worker capability barriers and different failure mechanisms.

The original audit and independent validator found no equivalent in open, deferred, resolved or cancelled. Filing repeated all-status searches for the ask helper, iterator return/closure, finish cleanup and the probe flag, and separately verified prefix 186 unused in each of the four folders immediately before creation. The owner reserved 185–189; 186 is assigned to this finding.

Read [tracker rules](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/issue-tracker.md>), [agent conventions](<C:/Users/TZ/Desktop/dsh-bot/agent.md>) and an existing new-ticket format. This filing used static reads/searches and read-only Git inspection only. No agents, probes, tests, builds or index generation were run. Only this issue is created; source, tests, configuration, product documents and artifacts are outside this filing.

## Comments

- 2026-11-07 — Filed after supplied independent confirmation and citation recheck as P2 / medium, explicitly not a ship blocker. The prior shipped-JavaScript probe observed skipped generator cleanup after an answered finish; broader provider/resource consequences remain unverified.

## Resolution - 2026-11-08

A finished ask now closes the stream iterator in a `finally` without replacing the typed outcome; commit `bdfd3be`; `test/racoons-llm-ask.test.ts` 4/4.
