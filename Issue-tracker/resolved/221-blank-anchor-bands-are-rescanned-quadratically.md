# 221 — Blank anchor bands are rescanned quadratically

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2
**Ship blocker:** no

## Problem and evidence

When the optional feature is enabled, a sufficiently large whitespace-only completion can drive repeated scans of the same blank band before the model request is sent. In [anchors.ts:169-175](../../vendor/racoons/core/rules/anchors.ts#L169-L175), candidate positions are generated with `k = floor(N / 100)`; [anchors.ts:325-326](../../vendor/racoons/core/rules/anchors.ts#L325-L326) passes them to `anchorsAt`. For each candidate, [anchors.ts:244-249](../../vendor/racoons/core/rules/anchors.ts#L244-L249) makes `blankRunAround` walk both directions across the contiguous blank band. [anchors.ts:296-300](../../vendor/racoons/core/rules/anchors.ts#L296-L300) deduplicates only after those walks. With N all-blank lines, each candidate therefore executes N - 1 successful loop bodies, for `floor(N / 100) * (N - 1)` source-level loop iterations to produce one distinct notice. The current emitted [anchors.js:222-229](../../vendor/racoons/core/lib/rules/anchors.js#L222-L229) and [anchors.js:271-276](../../vendor/racoons/core/lib/rules/anchors.js#L271-L276) preserve the same repeated-walk structure.

The shipping path can admit this input when enabled: [adapter/plugin.ts:834](../../vendor/racoons/adapter/plugin.ts#L834) encodes concatenated rendered text without trimming or capping it, while failed results are skipped. [adapter/port.ts:327](../../vendor/racoons/adapter/port.ts#L327) mints a unit at bar 0; the segmenter accepts nonempty whitespace. The gate at [adapter/plugin.ts:1597](../../vendor/racoons/adapter/plugin.ts#L1597) checks only minimum bytes and unsettled state; subsequent LLM service, route, breaker, and addressable-unit guards do not bound blank-band work. Shipped entry floors are 256-1280 bytes (default 512).

[adapter/entry-ask.ts:325-334](../../vendor/racoons/adapter/entry-ask.ts#L325-L334) decodes, splits, and calls `anchorsFor` synchronously. At [adapter/entry-ask.ts:517](../../vendor/racoons/adapter/entry-ask.ts#L517), facts are computed before [adapter/entry-ask.ts:537](../../vendor/racoons/adapter/entry-ask.ts#L537) sends once. The current emitted [entry-ask.js:327+](../../vendor/racoons/adapter/lib/entry-ask.js#L327) and [plugin.js:1373](../../vendor/racoons/adapter/lib/plugin.js#L1373) retain this order and path. This synchronous pre-step can block the shared JavaScript event loop and delay the model request. The 30-second model-stream deadline is created afterward at [adapter/llm-ask.ts:233](../../vendor/racoons/adapter/llm-ask.ts#L233), so it cannot bound this scan.

This is an optional-feature P2, not a default-shipment blocker: [src/plugin.ts:123](../../src/plugin.ts#L123) defaults `racoonsEnabled` to false and [src/plugin.ts:2077](../../src/plugin.ts#L2077) gates the whole mount; current emitted [plugin.js:1681](../../lib/plugin.js#L1681) has the same gate. No deployed flag state, universal upstream host output limit, or wall-clock stall duration is verified.

## Impact

For an enabled installation that accepts a large LF-only rendered completion, the repeated synchronous work grows as `floor(N / 100) * (N - 1)`, delaying the model request and other work on the shared event loop. This qualifies as P2 because it affects an opt-in feature and depends on unusually large accepted output. The calculation below is source-level arithmetic, not a wall-clock measurement or benchmark.

## Static reproduction

1. Consider the feature enabled, with a valid LLM route and breaker, and an accepted LF-only output at or above the entry floor.
2. Trace the synchronous `entry-ask` decode/split/`anchorsFor` path and the candidate loop plus `blankRunAround` scans linked above.
3. For N = 1,000,000 LF-only lines (1,000,000 LF bytes), the source-level count is `floor(1,000,000 / 100) * 999,999 = 9,999,990,000` successful loop iterations to emit one distinct notice. This is an arithmetic estimate, not an executed reproduction or timing result.

## Acceptance criteria

- Work for one contiguous blank band is bounded rather than rescanning the whole band once for each generated candidate on large accepted output.
- Notice/anchor output semantics, including deduplication and ordering, are maintained.
- The synchronous pre-request path does not allow blank-band size to produce the current repeated-scan growth.

## Checks performed

- Before creation, the reserved `221-*` prefix was vacant in `open`, `deferred`, `resolved`, and `cancelled`; the only current `221-*` path is this ticket.
- Before creation, a fresh narrow all-status search for `anchors`, `blankRunAround`, `quadratic`, and `blankband` found only generic historical uses of “anchors” and no duplicate blank-band performance ticket. Concurrent open tickets 185, 189, and 220 were checked separately and had no matches. The independent untruncated all-status comparison against resolved 145/148/150, cancelled 126, and open 167 also found no duplicate.
- Static TypeScript/current emitted-JavaScript validation confirms the repeated-walk structure and synchronous call order. No runtime reproduction, wall-clock measurement, or runtime compiler-parity check was performed.

## Comments

- 2026-11-07: Recorded as a source-level performance issue; no runtime reproduction or benchmark was run.

## Resolution - 2026-11-08

Fixed in `ed4f219`: one pass builds the blank-run boundaries and each candidate indexes them instead of rescanning the band; `test/racoons-anchors.test.ts` passes 2/2.
