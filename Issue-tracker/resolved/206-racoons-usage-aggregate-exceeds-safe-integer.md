# 206 — Racoons usage reader can emit an unsafe aggregate from individually safe counts

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** low / P3
**Ship blocker:** no

## Requirement

The public `readAssistantUsage(event)` conversion must return `kind: 'usage'` only when the converted prompt and cached-input counts are non-negative safe integers that the meter can reconcile. The reader describes that result as “a row the meter can reconcile” ([usage.ts:52–61](../../vendor/racoons/adapter/usage.ts#L52-L61)). Independently safe disjoint buckets do not guarantee that their sums are safe.

This is a narrow reader conversion contract defect at astronomical synthetic counts near nine quadrillion tokens. It is non-blocking and does not establish an ordinary provider-count failure.

## Problem and source evidence

- The reader accepts each required bucket only when `Number.isSafeInteger(value)` and `value >= 0`; present optional cache buckets use the same check ([usage.ts:68–76](../../vendor/racoons/adapter/usage.ts#L68-L76), [usage.ts:90–101](../../vendor/racoons/adapter/usage.ts#L90-L101)).
- It then adds the cache buckets without checking the sum at [usage.ts:103](../../vendor/racoons/adapter/usage.ts#L103), and adds uncached input to that sum without checking the result at [usage.ts:107](../../vendor/racoons/adapter/usage.ts#L107). It immediately labels the converted row `usage` ([usage.ts:102–111](../../vendor/racoons/adapter/usage.ts#L102-L111)). The emitted [usage.js:29–49](../../vendor/racoons/adapter/lib/usage.js#L29-L49) has the same validation and unchecked additions.
- The actual signature is `readAssistantUsage(event: DshUsageSource)` ([usage.ts:84](../../vendor/racoons/adapter/usage.ts#L84)). The structural source accepts `{ type, seq, data }` ([usage.ts:41–50](../../vendor/racoons/adapter/usage.ts#L41-L50)). No host session argument is required.
- The reader is a shipped public export: [index.ts:8–12](../../vendor/racoons/adapter/index.ts#L8-L12), emitted [index.js:4–7](../../vendor/racoons/adapter/lib/index.js#L4-L7), and the package root export points to the emitted entry ([package.json:6–12](../../vendor/racoons/adapter/package.json#L6-L12)).

The installed host contract supports the structural input used below. Its [TokenUsage declaration:160–181](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts#L160-L181>) defines disjoint numeric `inputTokens`, `cacheReadTokens` and `cacheWriteTokens`, with billed input equal to their sum. It declares no aggregate safe-integer bound. The installed [assistant/message declaration:328–345](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts#L328-L345>) carries optional `usage: TokenUsage`. The reader intentionally needs only its structural slice, so the example is a reader input, not a fabricated complete host-log event.

Host capacity metadata does not supply a usage-aggregate validation guarantee: [RequestContext:235–245](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts#L235-L245>) describes route metadata and an optional context window, while [request/context:407–413](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts#L407-L413>) says prompt admission uses the bound prepared call's capability rather than that earlier snapshot. The supplied historical line 418 is an inherited-history comment in the currently installed declaration; the current metadata locations are cited here. These declarations establish the reader input contract, not that a real provider can produce this count.

## Static input/output reasoning — not executed

The primary source review and separate product validator `cf860440` confirmed the defect and limiting guards by static inspection; the dispatcher handed off that completed validation. The ticket-writing pass reread the cited source, emitted JavaScript and installed host declarations. No example, test, probe or live call was executed for this ticket.

The exact public reader call is:

```ts
const row = {
  inputTokens: 9007199254740991,
  outputTokens: 0,
  cacheReadTokens: 2,
};
const event = { type: "assistant/message", seq: 1, data: { usage: row } };
readAssistantUsage(event);
```

Each supplied bucket passes its individual check. The absent cache-write bucket contributes zero, so `cacheTotal` is `2`. The mathematical prompt sum is `9007199254740993`; JavaScript number addition rounds it to `9007199254740992`, which is not a safe integer. Static evaluation of the return expression gives:

```json
{
  "kind": "usage",
  "usage": {
    "inputTokens": 9007199254740992,
    "outputTokens": 0,
    "cachedInputTokens": 2
  }
}
```

Expected classification: `kind: 'invalid'` because the converted prompt count is unsafe. The exact future reason string is not prescribed.

Controls from the same branches, also reasoned statically and unexecuted:

| Input row inside the same event | Current reader result |
| --- | --- |
| `{ inputTokens: 1, outputTokens: 0, cacheReadTokens: 2 }` | `kind: 'usage'`, with input `3`, output `0`, cached input `2` |
| `{ inputTokens: 9007199254740992, outputTokens: 0, cacheReadTokens: 2 }` | `kind: 'invalid'` at the individual input check |

Thus the gap is validation after conversion; the reader already rejects an individually unsafe bucket. The cache-bucket sum has the same missing check: individually safe cache-read and cache-write values can themselves produce an unsafe `cacheTotal`.

## Impact, guards and limits

The concrete impact is a public reader returning a rounded, unsafe value under `kind: 'usage'`, contradicting its usable-reading contract. The shown input is synthetic and astronomical; there is no real-provider production reproduction or evidence of an ordinary-count failure.

The downstream safeguards materially limit the finding:

- The meter's `assertCount` helper rejects non-safe or negative counts ([meter.ts:9–15](../../vendor/racoons/core/meter/meter.ts#L9-L15)). `Meter.reconcile` checks the aggregate input at [meter.ts:32–40](../../vendor/racoons/core/meter/meter.ts#L32-L40), so the example fails with `MeterError('invalid-count')`. It is not accepted as authoritative usage by that path.
- For an opened entry with a request estimate, the mount catches the failure, journals `usage-missing` with reason `inconsistent-usage`, and returns before the later `billedPromptTokens` assignment ([plugin.ts:1451–1465](../../vendor/racoons/adapter/plugin.ts#L1451-L1465)). The journal's reason label does not change the meter's `invalid-count` rejection.
- The distinct no-request-estimate branch assigns the reader aggregate to `entry.billedPromptTokens`, journals `usage-missing` / `no-request-estimate`, and returns without reconciliation ([plugin.ts:1440–1449](../../vendor/racoons/adapter/plugin.ts#L1440-L1449)). Thus the meter guard does not make the reader's result safe for every consumer.
- The ask chunk projection likewise forwards `read.usage` whenever the reader says `usage` ([llm-ask.ts:130–133](../../vendor/racoons/adapter/llm-ask.ts#L130-L133)). This establishes propagation of the converted value, not a demonstrated billing or budget effect.

The vendor integration is an optional feature that defaults off ([src/plugin.ts:115–123](../../src/plugin.ts#L115-L123), [src/plugin.ts:2068–2077](../../src/plugin.ts#L2068-L2077)); its public reader API remains shipped. This ticket establishes neither a budget bypass nor a billing defect, and makes no blocker claim. Severity: low / P3; ship blocker: no.

## Duplicate and number checks

On 2026-11-07, searched all four status directories (`open`, `resolved`, `deferred`, `cancelled`) for usage/cache/overflow terms, then repeated a focused check for `readAssistantUsage`, safe integers, the exact boundary numbers, `cacheTotal`, and usage/cache aggregate or overflow wording immediately before creation. No same-root duplicate was found. The focused repeat returned zero matches in every status.

The related existing tickets cover different roots: [148](../resolved/148-racoons-resync-latest.md#L92-L103) records integration and its usage-accounting boundary; [150](../resolved/150-racoons-record-only-semantics.md#L9-L34) concerns record-only context-edit semantics; [235](../resolved/235-racoons-meter-zero-cache-share-reported-unknown.md#L8-L26) concerns the meter converting a known zero cache share to unknown, while retaining correct raw counts. None addresses unsafe aggregates created by the usage reader.

Immediately before the write, reconfirmed repository root `C:/Users/TZ/Desktop/dsh-bot` and searched `Issue-tracker/**/206*` across all status folders: no existing numeric-prefix file. Used 206 without overwriting or renumbering. Reserved 205 and other tickets were left untouched.

## Acceptance criteria

- [ ] After validating individual buckets, check both the combined cache count and the total prompt count with `Number.isSafeInteger` before returning `kind: 'usage'`; preserve non-negative count semantics. Return `kind: 'invalid'` for an unsafe aggregate.
- [ ] The exact public-reader event above returns `invalid`. Also reject unsafe cache aggregation, for example `{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 9007199254740991, cacheWriteTokens: 2 }`.
- [ ] Preserve normal valid conversion: input `1` plus cache-read `2` yields input `3` and cached input `2`; preserve the existing rejection of an individual bucket `9007199254740992`.
- [ ] Preserve the distinction between a missing usage row (`missing`), a non-usage event (`null`), unknown cache when both optional counters are absent/null (`cachedInputTokens: null`), and a known zero cache (`cachedInputTokens: 0`).
- [ ] A future fix includes focused regression coverage for both aggregate additions, valid boundary values, the controls, and missing/unknown/zero distinctions. Keep the TypeScript and generated JavaScript peer consistent with the repository's normal generated-file workflow.

## Checks performed

Static reads of the exact cited ranges; shipped public export and one-argument signature confirmation; all-status duplicate searches; repeated root and numeric-prefix availability checks; full created-ticket readback and Git scope inspection. This filing contains no implementation. No tests, builds, probes, live calls, reference-tree access, global index regeneration or global validation run was performed.

The pre-existing tracked difference was a 12-line comment addition in [158](../open/158-157-verification-sweep.md), alongside other untracked tickets. Those changes were left untouched; this task writes only this new ticket.

## Comments

- 2026-11-07 — Created from primary static review and separate product validation (`cf860440`) handed off by the dispatcher. Reconfirmed the exact public reader API, arithmetic, emitted peer, host structural contract and downstream guards without execution. Low / P3; non-blocking. Corrected the stale host metadata line citation to its current location. No implementation or other tracker/index edit made.

## Resolution - 2026-11-08

The prompt and cache totals are now checked and an unsafe aggregate is rejected; commit `9b2a612`; `test/racoons-usage.test.ts` 9/9.
