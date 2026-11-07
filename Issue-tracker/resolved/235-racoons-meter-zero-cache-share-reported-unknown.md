# 235 — Racoons meter reports a measured zero cache share as unknown

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3 / low
**Ship blocker:** no

## Requirement

For positive input and a known cached-input count, `cachedInputShare` must report the ratio `cachedInputTokens / inputTokens`. A measured cached count of zero therefore means share `0`; an unknown cached count remains `null`, and an empty input leaves the ratio undefined (`null`).

The adapter contract defines input as the whole prompt, cached input as its cached part, and the share as that division ([vendor/racoons/adapter/usage.ts:19–22](../../vendor/racoons/adapter/usage.ts#L19-L22)). The telemetry contract explicitly distinguishes a measured zero (`0`) from an empty measurement (`null`), naming `MeterReading.cachedInputShare` as the same convention ([vendor/racoons/core/engine/telemetry.ts:13–15](../../vendor/racoons/core/engine/telemetry.ts#L13-L15)).

## Problem and evidence

With `inputTokens: 100` and `cachedInputTokens: 0`, the meter returns `cachedInputShare: null` instead of `0`. This loses the distinction between a known zero share and an unknown share.

- [vendor/racoons/core/meter/meter.ts:57–60](../../vendor/racoons/core/meter/meter.ts#L57-L60) includes `cachedInputTokens === 0` in the branch that returns `null`, alongside an unknown cached count and empty input. The zero numerator is the root cause for positive input.
- The shipped JavaScript has the same condition at [vendor/racoons/core/lib/meter/meter.js:39–41](../../vendor/racoons/core/lib/meter/meter.js#L39-L41), so the recorded result is present in the shipped artifact as well as the TypeScript source.
- The raw counts remain correct: the reading retains `inputTokens`, `outputTokens` and `cachedInputTokens` at [vendor/racoons/core/meter/meter.ts:53–55](../../vendor/racoons/core/meter/meter.ts#L53-L55), mirrored by [vendor/racoons/core/lib/meter/meter.js:35–37](../../vendor/racoons/core/lib/meter/meter.js#L35-L37).

The affected reading is reachable from an ordinary measured host usage row:

1. Given `{ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }`, the count readers accept both cache zeros ([vendor/racoons/adapter/usage.ts:67–76](../../vendor/racoons/adapter/usage.ts#L67-L76)). Summation preserves `{ inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 }`; only two absent cache counters become unknown ([vendor/racoons/adapter/usage.ts:96–111](../../vendor/racoons/adapter/usage.ts#L96-L111)).
2. For an opened session with a request estimate and a first eligible append-origin message, `observeUsage` reads that usage and forwards it to the core ([vendor/racoons/adapter/plugin.ts:1421–1453](../../vendor/racoons/adapter/plugin.ts#L1421-L1453)).
3. The core reconciles the observation and emits the accepted reading as `usage-reconciled` ([vendor/racoons/core/engine/engine.ts:70–73](../../vendor/racoons/core/engine/engine.ts#L70-L73)). Telemetry accepts the first reading for a request and stores a clone without changing its values ([vendor/racoons/core/engine/telemetry.ts:73–77](../../vendor/racoons/core/engine/telemetry.ts#L73-L77)).

**Evidence provenance:** separate source reviewer `5f5cb68c` confirmed the root cause, contracts and reachable path. Separate validator `6dacc42d` ran the single direct-meter command recorded below. The ticket-writing pass checked the cited passages and records that existing validation; it did not rerun the command or exercise the full adapter path.

## Impact

P3 / low: a measured zero cached-input share is reported as unknown. The diagnostic reading loses the distinction between a known cold-cache result and missing cache information. The underlying token counts remain correct. This finding does not establish a UI defect or aggregate bias. Ship blocker: no.

## Recorded reproduction

Validator `6dacc42d` used one Node ESM command against the shipped meter, with the repository root as the working directory. The recorded recipe is reproduced here without rerunning it during ticket writing:

```powershell
node --input-type=module -e @'
import { Meter } from "./vendor/racoons/core/lib/meter/meter.js";
const meter = new Meter({ estimate: () => 0 });
for (const [label, inputTokens, cachedInputTokens, expected] of [
  ["measured-zero", 100, 0, 0],
  ["unknown-cache", 100, null, null],
  ["measured-positive", 100, 25, 0.25],
  ["empty-input", 0, 0, null],
]) {
  const reading = meter.reconcile({
    requestId: label,
    revision: 0,
    estimatedInputTokens: inputTokens,
    usage: { inputTokens, outputTokens: 0, cachedInputTokens },
  });
  const actual = reading.cachedInputShare;
  const pass = Object.is(actual, expected);
  console.log(JSON.stringify({ case: label, inputTokens, cachedInputTokens, actual, expected, pass }));
  if (!pass) process.exitCode = 1;
}
'@
```

Exact recorded stdout (four JSON lines):

```json
{"case":"measured-zero","inputTokens":100,"cachedInputTokens":0,"actual":null,"expected":0,"pass":false}
{"case":"unknown-cache","inputTokens":100,"cachedInputTokens":null,"actual":null,"expected":null,"pass":true}
{"case":"measured-positive","inputTokens":100,"cachedInputTokens":25,"actual":0.25,"expected":0.25,"pass":true}
{"case":"empty-input","inputTokens":0,"cachedInputTokens":0,"actual":null,"expected":null,"pass":true}
```

Exit code: `1`, intentionally set by `if (!pass) process.exitCode = 1` for the measured-zero mismatch. Stderr was empty. The other three cases passed. This is the previously recorded direct-meter validation, not an integration or UI reproduction.

## Duplicate check

Rechecked all four tracker status directories on 2026-11-07 before creation. Counts were `open: 17`, `deferred: 1`, `resolved: 167` and `cancelled: 7`. The pre-write `Issue-tracker/**/235*.md` filename check returned no files; ID 235 was unused in every status.

The supplied prior independent all-status queries for `cachedInputShare`, `cachedInputTokens`, `cached-input`, `zero-cache`, cache/unknown/ratio/share, `meter.ts` and Chinese variants reported zero matches. The ticket-writing pass repeated the root check separately in each of `open`, `deferred`, `resolved` and `cancelled` with these expressions:

- `(?i)cachedInputShare|cachedInputTokens|cached[-_ ]input|zero[-_ ]cache|meter\.ts` — zero matches in all four statuses.
- `(?i)\bcache\b.{0,100}\b(?:unknown|ratio|share|zero)\b|\b(?:unknown|ratio|share|zero)\b.{0,100}\bcache\b` — one incidental match, resolved ID 44; zero matches in the other statuses.
- `(?:缓存|快取).{0,40}(?:占比|比例|份额|零|未知)|(?:占比|比例|份额|零|未知).{0,40}(?:缓存|快取)` — zero matches in all four statuses.

[Resolved 44:222](../resolved/44-host-half-commands-unregistered-by-inverted-ctx-effect-usage.md#L222) only reports “86% cache hit, zero retries” in a traffic summary. Its root is command-registration cleanup ([title and context](../resolved/44-host-half-commands-unregistered-by-inverted-ctx-effect-usage.md#L1)), unrelated to the meter's zero-share/null branch. No same-root duplicate was found.

During final readback, [open 186:9–13](../resolved/186-racoons-ask-iterator-cleanup.md#L9-L13) appeared as a concurrent addition after the initial tracker snapshot. It concerns an ask stream iterator left open after a finish chunk, a different root from the meter's zero-share/null branch. It was inspected and left unchanged. Reviewed IDs: 44 and 186.

## Acceptance criteria

- [ ] Positive input with a known zero cached count reports `cachedInputShare: 0`; specifically, input `100` and cached input `0` produce `0`.
- [ ] Positive input with an unknown cached count keeps `cachedInputShare: null`; specifically, input `100` and cached input `null` remain `null`.
- [ ] A positive cached count keeps the expected fraction; specifically, input `100` and cached input `25` produce `0.25`.
- [ ] Empty input keeps the ratio undefined; input `0` and cached input `0` produce `null`.
- [ ] The TypeScript meter and shipped JavaScript agree on those results, preserving the raw token counts.

## Comments

- 2026-11-07 — Audit ticket created from separate source reviewer `5f5cb68c` and validator `6dacc42d` evidence. Rechecked all-status ID availability and duplicates; recorded the one-command validator recipe, exact four-line stdout, intentional exit 1 and empty stderr. P3 / low; ship blocker: no. Ticket-writing stage only: the recorded validation was not rerun; no new tests, runtime probes, builds, full suite or reference-tree work was performed. No implementation, tests, configuration, other documentation or tracker index was changed.

## Resolution - 2026-11-08

A measured zero cache share is reported as 0, and only an unknown cached count or empty input is null; commit `c8261ff`; `test/racoons-meter.test.ts` 5/5.
