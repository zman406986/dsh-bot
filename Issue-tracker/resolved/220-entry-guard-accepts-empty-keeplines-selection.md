# 220 — Entry guard accepts empty keeplines selection

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2
**Ship blocker:** no

## Problem and evidence

The entry answer type permits a keeplines answer with a readonly ranges array but does not encode a non-empty constraint ([entry-wire.ts](../../vendor/racoons/core/verdicts/entry-wire.ts#L67-L79)). The shared verdict contract says at least one line must be kept and explicitly treats keeping none as forgetall in disguise, which the guard must refuse ([types.ts](../../vendor/racoons/core/verdicts/types.ts#L38-L47)). The ordinary wire parser does refuse an empty keeplines payload and normalized empty range list ([entry-wire.ts](../../vendor/racoons/core/verdicts/entry-wire.ts#L255-L278)); the current emitted parser has the same refusal ([entry-wire.js](../../vendor/racoons/core/lib/verdicts/entry-wire.js#L213-L229)).

The engine planner also accepts hand-built entry events, independently of that wire parser, and passes the supplied answer to entry planning ([planning.ts](../../vendor/racoons/core/engine/planning.ts#L276-L281), [planning.ts](../../vendor/racoons/core/engine/planning.ts#L309-L316), [planning.ts](../../vendor/racoons/core/engine/planning.ts#L344-L346)). For keeplines with no ranges, the planner's empty span list passes the range loop, yields keptLineRanges and keptRanges as empty, and reaches the shape renderer. Its explicit whole-result refusal applies only to forgetlines ([planning.ts](../../vendor/racoons/core/engine/planning.ts#L187-L221), [planning.ts](../../vendor/racoons/core/engine/planning.ts#L218-L254)). The emitted planner retains this behavior ([planning.js](../../vendor/racoons/core/lib/engine/planning.js#L100-L137), [planning.js](../../vendor/racoons/core/lib/engine/planning.js#L204-L212)).

The Guard checks that a shape's kept ranges and removal complement are internally coherent, but compares named answer ranges to that plan only for forgetlines; it does not bind keeplines or keepall to the plan's selected lines ([checks-entry-shape.ts](../../vendor/racoons/core/guard/checks-entry-shape.ts#L85-L131)). Its whole-line predicate returns true for an empty list, so a plan that keeps no bytes can pass that check ([checks-entry-shape.ts](../../vendor/racoons/core/guard/checks-entry-shape.ts#L233-L253)). A coherent plan can also archive the original landed result while carrying the whole-result removal ([checks-entry-shape.ts](../../vendor/racoons/core/guard/checks-entry-shape.ts#L194-L218)). The current emitted Guard preserves both decisions ([checks-entry-shape.js](../../vendor/racoons/core/lib/guard/checks-entry-shape.js#L98-L113), [checks-entry-shape.js](../../vendor/racoons/core/lib/guard/checks-entry-shape.js#L211-L229)). The engine sends planned work through Guard validation and applies a successful result ([engine.ts](../../vendor/racoons/core/engine/engine.ts#L194-L203), [engine.ts](../../vendor/racoons/core/engine/engine.ts#L312-L334); [engine.js](../../vendor/racoons/core/lib/engine/engine.js#L177-L186)).

## Impact

A malformed programmatic partial answer can remove the entire landed result from active model context, replacing it with the generated shaped turn. The original result is archived and recoverable; this is not a claim of permanent byte loss. The current adapter/wire route remains protected by its parser; the gap is the hand-built event path and Guard acceptance of a coherent plan whose selection contradicts the answer.

## Static reproduction

Static source proof only; this was not executed as a runtime probe.

1. Start with a valid landed entry result and a valid unit stamp identifying its unit.
2. Hand-build an entry event with answer: { action: "keeplines", ranges: [], summary: "No lines selected" } and pass it directly to the planner.
3. The planner forwards the answer, derives an empty kept selection, and can produce a whole-result shape plan. The Guard's empty-range predicate accepts the empty kept selection, and its answer-binding branch does not check keeplines.
4. The engine routes the plan through Guard and applies it if validation succeeds.

The same missing answer-to-plan binding allows a separately supplied, internally coherent Guard plan to keep lines that contradict a keeplines answer, or to shape a keepall answer.

## Acceptance criteria

- An empty keeplines answer is refused before it can produce an application plan; refusal leaves the original landed result active and unchanged.
- Guard validation binds the plan's kept selection to the entry answer semantics for every answer kind, including coherent plans supplied independently of the normal planner. A contradiction with keepall or a non-empty keeplines answer is refused.
- Valid keepall, non-empty partial keeplines, forgetlines, and explicit whole-result forgetall decisions retain their existing semantics, with the plan selection matching the answer.
- A refused plan is not applied; valid shaped selections continue to archive the original result under the existing recovery behavior.

## Checks performed

- Globbed 220-* independently in open, deferred, resolved, and cancelled; no prefix is occupied.
- Searched all tracker statuses for keeplines, entry-guard, and selection terms. No matching keeplines or entry-guard issue was found; selection-only matches are unrelated.
- Inspected only the cited TypeScript and current emitted JavaScript excerpts. No runtime probe, build, tests, or new tests were run.

## Comments

Initial static report. No implementation or tests were added.

## Resolution - 2026-11-08

Fixed in `9e7cf0b`: an empty keeplines selection now refuses with `keeps-no-line`, and the guard binds keepall/keeplines/forgetall plans to `op.keptRanges`; `test/racoons-entry-keeplines.test.ts` passes 5/5.
