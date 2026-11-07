# 237 — Racoons entry answers double-count one captured refetch

**Status:** resolved
**Labels:** needs-triage
**Severity:** P2 / medium
**Ship blocker:** no

## Requirement and API telemetry semantics

A captured tool result that repeats a previously archived source represents one refetch occurrence. Observing that landed result and later processing its entry-checkpoint answer must not report the same occurrence twice. A separate later fetch of identical bytes must still be counted as a new occurrence; deduplicating all future results by content would lose that distinction.

The public [refetch event contract:91–96](../../vendor/racoons/core/types/telemetry.ts#L91-L96) reports `sourceSha256`, `recallId` and `fetchedBytes`. Those fields describe the fetched source and byte count; an entry answer classifies an already-landed result and supplies no additional fetched bytes.

[PRD-racoons.md:62, S4](../../PRD-racoons.md#L62) names “Dropped bytes re-fetched later,” and [§6.9:138–140](../../PRD-racoons.md#L138-L140) derives telemetry, including re-fetch rate, from the harness transcript and ledger. The [PRD header:6](../../PRD-racoons.md#L6) is explicitly **Draft — awaiting human acceptance**. These passages provide the measurement baseline, not a newly binding aggregation formula. This finding establishes duplicate event/`fetchedBytes` reporting only. The [existing telemetry summary:55–60](../../vendor/racoons/core/engine/telemetry.ts#L55-L60) returns other measurements; an existing S4 refetch-rate aggregate implementation or a quantified downstream impact is not established.

## Problem and evidence

When one landed tool result has the same bytes as a source in a previously prepared and applied archival operation, the engine emits a `refetch` event during the entry observation. If the entry checkpoint later receives an answer for that same landed result, the adapter sends the same result bytes to the engine again under a distinct answer event ID. The engine emits another `refetch` with the same source, recall ID and `fetchedBytes`. These two reports describe one captured result.

- **Refetch runs before deciding whether there is any plan.** [engine.ts:144–158](../../vendor/racoons/core/engine/engine.ts#L144-L158) checks previously handled event IDs and then calls `refetch`. The observation/no-plan branch is later, at [194–199](../../vendor/racoons/core/engine/engine.ts#L194-L199). An observation can return unchanged, and a later keep-all answer can plan nothing, while both have already passed through refetch accounting.
- **Deduplication is keyed by the callback event ID.** [engine.ts:353–367](../../vendor/racoons/core/engine/engine.ts#L353-L367) checks and records only `input.eventId` in `seenRefetches`. It hashes the result bytes, selects prepared metadata whose intent has an applied receipt, and matches each source by SHA-256 and byte length. Its `emitted` recall-ID set is local to that invocation, so it does not suppress a second invocation for the same captured result with another event ID. Each match emits `fetchedBytes: input.result.bytes.length`.
- **Both adapter callbacks become entry inputs.** [adapter.ts:209–230](../../vendor/racoons/adapter/adapter.ts#L209-L230) forwards `onToolResult` and `onEntryAnswer` as `kind: 'entry'`. The answer path forwards the landed node again, including the keep-all branch at 219–222.
- **The mounted path uses different event IDs for the same landed result.** The observation calls `onToolResult(capture.eventId, capture.item)` at [plugin.ts:1571–1578](../../vendor/racoons/adapter/plugin.ts#L1571-L1578). The answer loop retrieves the landed node at [1859–1865](../../vendor/racoons/adapter/plugin.ts#L1859-L1865); [landedNodeOf:1608–1617](../../vendor/racoons/adapter/plugin.ts#L1608-L1617) reads the transcript item under the capture ID, with the capture as fallback. The loop deliberately creates a distinct answer-message event ID at [1926–1929](../../vendor/racoons/adapter/plugin.ts#L1926-L1929), then passes that ID and the same node to `applyEntryAnswer` at [1930–1937](../../vendor/racoons/adapter/plugin.ts#L1930-L1937). The helper invokes `onEntryAnswer(answerEventId, node, ...)` at [1755–1762](../../vendor/racoons/adapter/plugin.ts#L1755-L1762).
- **The two callbacks occur in the ordinary entry flow.** [runStep:2145–2173](../../vendor/racoons/adapter/plugin.ts#L2145-L2173) delivers captured results, gathers the landed captures, then runs the entry-ask loop on those captures. An eligible result with a usable ledger/unit/fork and configured route can therefore reach both callbacks.
- **The telemetry/journal path does not deduplicate the reports.** [TranscriptTelemetry.emit:87–92](../../vendor/racoons/core/engine/telemetry.ts#L87-L92) forwards each event to its sink. The plugin sink at [1301–1303](../../vendor/racoons/adapter/plugin.ts#L1301-L1303) journals each event, and the [journal wrapper:1085–1089](../../vendor/racoons/adapter/plugin.ts#L1085-L1089) forwards each record without refetch deduplication. Both reports reach the journal callback.
- **Shipped JavaScript matches.** [core/lib/engine/engine.js:322–339](../../vendor/racoons/core/lib/engine/engine.js#L322-L339) preserves the event-ID check, local recall-ID set, source match and `refetch` emission. [adapter/lib/adapter.js:54–66](../../vendor/racoons/adapter/lib/adapter.js#L54-L66) preserves the observation and keep-all answer inputs, with the other answer branch at [73–75](../../vendor/racoons/adapter/lib/adapter.js#L73-L75).

**Evidence provenance:** separate source reviewer `9e52f253` and independent validator `63634282` confirmed the defect as P2 / medium and nonblocking. Validation is static source/control-flow proof. The ticket-writing pass reread the cited TypeScript, shipped JavaScript and contracts. No runtime probe was executed, and no runtime output is claimed.

## Impact and limits

P2 / medium: one captured refetch can produce two `refetch` events, each reporting the same fetched byte count, solely because its observation and answer have different IDs. The journal exposes duplicate reports to telemetry consumers. The trigger requires a matching previously prepared/applied archived source, a captured result repeating those source bytes, and a later answered entry checkpoint. An unmatched result or a checkpoint that never supplies an answer does not establish this two-callback duplication.

The two events do not demonstrate two actual fetches. No additional host fetch, content corruption, implemented S4 aggregate error, live frequency, or quantified product impact is established. Ship blocker: no.

## Reproduction recipe — unexecuted; static validation

Use the existing entry observation and answer callbacks; the following is a recipe derived from source, not a run or recorded output:

1. In one enabled, askable Racoons session, prepare and apply an archival operation for one source. Retain its prepared source metadata and matching applied receipt. Choose a single matching recall ID to isolate the duplicate occurrence.
2. Let one tool result land whose bytes exactly match that archived source in SHA-256 and byte length. Deliver that capture through `onToolResult(capture.eventId, capture.item)`, retaining its landed node.
3. Complete the entry checkpoint with a valid answer, using the answer message's distinct event ID and the same landed node through `onEntryAnswer`. A valid keep-all answer is sufficient: refetch runs before the no-plan result. No second tool fetch is part of this recipe.
4. Inspect the telemetry sink or journal for this source and recall ID. **Expected from the current source trace:** one `refetch` report during observation and another during answer processing, each with `fetchedBytes` equal to that same result's byte length. **Required behavior:** one report for this captured fetch across both callbacks. These are source-derived expectations, not observed runtime output.

Static validation checked the source match and applied-intent gate, event-ID-only deduplication, invocation-local recall-ID set, distinct observation/answer IDs, repeated landed bytes, ordering before no-plan, journal forwarding and matching shipped JavaScript. No runtime probe, callback recipe, test, build or live-provider call was executed.

## Duplicate check

Rechecked `open`, `deferred`, `resolved` and `cancelled` on 2026-11-07 before creation. The all-status `Issue-tracker/**/237*` filename check returned no files, including the final pre-write recheck; ID 237 was available.

- `(?i)refetch|re-fetch|re[ _]fetch` and Chinese variants `重取|回取|重拉|回捞|回读|重复取回|重复抓取|重新抓取|重新获取|重复获取|重复拉取|重新读取` returned zero matches in all four statuses. This agrees with the supplied prior all-status refetch/re-fetch check.
- Source-symbol queries `seenRefetches|sourceSha256|fetchedBytes|onToolResult|onEntryAnswer|landedNodeOf|deliverEntry|applyEntryAnswer` found no existing refetch-accounting ticket. The callback matches were [open 185:19](../open/185-racoons-tool-finish-accepted-as-entry-answer.md#L19), [open 189:24](../resolved/189-racoons-entry-ask-drops-cancellation-signal.md#L24) and [resolved 150:78](../resolved/150-racoons-record-only-semantics.md#L78). Read their problem/evidence passages: they concern tool-call finish acceptance, cancellation-signal loss and record-only context-edit semantics, respectively.
- Searches for `double.?count`, duplicate telemetry/refetch/fetched-byte reports in either word order, and Chinese variants for repeated telemetry/counting/events/bytes (`重复…遥测/计量/计数/统计/事件/字节`, the reverse order, `双重计|二次计|重复记账|重复上报`) found only [resolved 120:67](../resolved/120-mock-llm-e2e-messaging-await-mitosis.md#L67) and [120:106](../resolved/120-mock-llm-e2e-messaging-await-mitosis.md#L106). Read those passages: they require one worker turn-start record per running edge, a different root.
- [Open 206:8–17](../resolved/206-racoons-usage-aggregate-exceeds-safe-integer.md#L8-L17) appeared during filing and was read before creation. It concerns unsafe sums of token-usage counts, independent of refetch-event duplication. It was left unchanged.

No same-root semantic duplicate was found. Reviewed likely matches: 120, 150, 185, 189 and 206.

## Acceptance criteria

- [ ] One captured fetch matching an archived source emits one `refetch`/`fetchedBytes` report for that source/recall ID across entry observation and its later answer; processing the answer does not count those landed bytes again. Cover a valid keep-all/no-plan answer as well as an answer that applies an entry shape.
- [ ] A separate later fetch of identical source bytes remains a distinct occurrence and produces its own report. The fix must distinguish fetch occurrences rather than suppressing every future match by source hash or recall ID.
- [ ] Re-delivery/replay of the already-accounted observation or answer remains duplicate-safe and preserves entry application idempotence.
- [ ] The telemetry sink and plugin journal expose the corrected occurrence semantics, with TypeScript and shipped JavaScript behavior aligned. Future regression validation should exercise the existing observation/answer callbacks, an independent later fetch and callback replays; no test is added or executed by this filing.

## Comments

- 2026-11-07 — Filed from separate source reviewer `9e52f253` and independent validator `63634282` confirmation: P2 / medium, nonblocker. Rechecked ID 237 and all four statuses for semantic duplicates; reread source, shipped JavaScript and draft PRD baseline. Static proof only; the reproduction recipe is unexecuted and no runtime output is invented. Ticket-only scope: no implementation, tests, configuration, product documentation, reference-tree copying, probe, build or tracker-index refresh.

## Resolution - 2026-11-08

Fixed in `3451dd6`: refetch dedupe keys on `ToolResultNode.id`, so observation and answer count once while a genuinely later fetch still reports; `test/racoons-entry-refetch.test.ts` passes 1/1.
