# 238 - Racoons first forced-loss token count is lost without usage

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3 / low
**Ship blocker:** no

## Requirement

For the first distinct forced-loss observation in a transcript, `tokensAtFirstForcedLoss` should use that observation's non-null `inputTokensBefore` even when there is no preceding `MeterReading`. If the observation has no count, retain the existing fallback to the latest preceding usage reading; if neither source has a count, keep the summary field `null`. Counting distinct forced-loss events remains independent of whether usage was observed.

The public `summarize` API is exported by [core/index.ts:351-352](../../vendor/racoons/core/index.ts#L351-L352) and its shipped JavaScript entry [lib/index.js:74](../../vendor/racoons/core/lib/index.js#L74). The public `ForcedLossObservation` shape carries its own nullable before/after counts ([types/telemetry.ts:39-49](../../vendor/racoons/core/types/telemetry.ts#L39-L49)); `Engine.observe` accepts and emits forced-loss observations independently of usage ([engine.ts:70-76](../../vendor/racoons/core/engine/engine.ts#L70-L76)).

The draft PRD's S2 healthy-depth baseline (~296k) and S3 forced-loss count, together with section 6.9's preference for true counts where available, are context only ([PRD-racoons.md:59-61](../../PRD-racoons.md#L59-L61), [PRD-racoons.md:138-140](../../PRD-racoons.md#L138-L140)). The draft baseline does not override subsequently accepted decisions.

## Problem and evidence

A transcript containing a first forced-loss observation with `inputTokensBefore: 300000` and no preceding usage produces `forcedLossCount: 1` but `tokensAtFirstForcedLoss: null`. The summary drops a true count already present on the loss observation.

- [core/engine/telemetry.ts:43-52](../../vendor/racoons/core/engine/telemetry.ts#L43-L52) assigns the token field only when `latestUsage !== null`. The separate set insertion still increments the distinct loss count.
- The shipped implementation has the same guard at [core/lib/engine/telemetry.js:35-47](../../vendor/racoons/core/lib/engine/telemetry.js#L35-L47).
- The observation type permits the before-count on a forced loss without a usage observation ([core/types/telemetry.ts:39-49](../../vendor/racoons/core/types/telemetry.ts#L39-L49)); the engine accepts that observation independently ([core/engine/engine.ts:70-76](../../vendor/racoons/core/engine/engine.ts#L70-L76)).

The public diagnostic summary is the affected surface. The separate review found no current dsh producer or summary consumer. This does not establish a UI defect, aggregate bias, or current host impact.

**Evidence provenance:** separate source reviewer `b53d184b` and validator `bea11296` confirmed the finding. The ticket-writing pass records their evidence; it did not rerun the probe or exercise a producer/consumer path.

## Impact

P3 / low: a known pre-loss token count is missing from the public first-forced-loss diagnostic when no usage reading precedes it. The event count remains correct, and the affected surface is diagnostic only. No current host impact or aggregate bias is claimed. Ship blocker: no.

## Recorded reproduction

Validator `bea11296` recorded this one Node ESM probe against the shipped public summary. It is reproduced here without rerunning it during ticket writing:

```powershell
node --input-type=module -e @'
import { summarize } from './vendor/racoons/core/lib/engine/telemetry.js';
const snapshot = { sessionId: 'probe', revision: 0, currentTurnOrdinal: 1, completedThroughTurnOrdinal: 0, currentStepOrdinal: 0, nodes: [], cache: { kind: 'unknown' }, retentionEvidence: [] };
const loss = { kind: 'forced-loss', nativeEventId: 'loss-1', turnOrdinal: 1, inputTokensBefore: 300000, inputTokensAfter: 100000 };
const actual = summarize(snapshot, [], [loss]);
const pass = actual.forcedLossCount === 1 && actual.tokensAtFirstForcedLoss === 300000;
console.log(JSON.stringify({ forcedLossCount: actual.forcedLossCount, tokensAtFirstForcedLoss: actual.tokensAtFirstForcedLoss, expectedTokensAtFirstForcedLoss: 300000, pass }));
if (!pass) process.exitCode = 1;
'@
```

Exact recorded stdout:

```json
{"forcedLossCount":1,"tokensAtFirstForcedLoss":null,"expectedTokensAtFirstForcedLoss":300000,"pass":false}
```

Exit code: `1`, intentionally set for the mismatch; stderr was empty. This is the sole recorded runtime probe. It was not rerun for ticket writing.

## Duplicate check

Checked all four status directories (open, deferred, resolved, cancelled) before creation. The all-status filename search for `238*` returned no files. Focused all-status searches for forced-loss/count, first-loss, healthy-depth, `tokensAtFirstForcedLoss`, `inputTokensBefore`, first compaction, and corresponding Chinese terms returned zero matches.

The broader hits are unrelated. Nearby RACOONS tickets were reviewed: open [206](206-racoons-usage-aggregate-exceeds-safe-integer.md) covers unsafe usage-reader aggregation; open [235](235-racoons-meter-zero-cache-share-reported-unknown.md) covers measured zero cache share becoming unknown; resolved [150](../resolved/150-racoons-record-only-semantics.md) covers record-only entry-checkpoint semantics. None has this root cause or behavior. No same-root duplicate was found.

## Acceptance criteria

- [ ] A first forced-loss observation with non-null `inputTokensBefore` supplies `tokensAtFirstForcedLoss` even without any preceding usage reading; the recorded case returns count 1 and token count 300000.
- [ ] If the first forced-loss observation has no before-count and there is no preceding usage, the token field remains `null`.
- [ ] If the first loss has no before-count but a preceding usage reading exists, retain the current fallback to that reading's `inputTokens`.
- [ ] Existing usage-backed first-loss cases and unknown-value behavior are preserved; later readings do not retroactively replace an unknown first-loss value.
- [ ] Distinct forced-loss counting and duplicate-native-event handling are unchanged.
- [ ] TypeScript source and shipped JavaScript produce the same summary.

## Comments

- 2026-11-07 - Ticket created from separate source reviewer `b53d184b` and validator `bea11296` confirmations. Rechecked ID 238 availability and all-status semantic duplicates; recorded the sole existing probe and exact mismatch output without rerunning it. P3 / low; ship blocker: no. Ticket-writing only: no probes, tests, builds, full suite, source/config/product-doc changes, reference work, or tracker refresh performed. Existing concurrent tickets and other worktree changes were left untouched.

## Resolution - 2026-11-08

The first distinct forced loss keeps its own `inputTokensBefore` before falling back to the latest usage row; commit `8c44518`; `test/racoons-telemetry.test.ts` 7/7.
