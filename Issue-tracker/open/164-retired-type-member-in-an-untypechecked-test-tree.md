# 164 — A retired type member lives in the test tree, which no tsconfig typechecks

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing.
**Origin:** found by the ticket-157 review, 2026-10-29.
**Related:** ticket 157 (retired the `"spawned"` dispatcher origin), ADR-0032.

## Problem

`test/policy-assembler.test.ts` still passes the retired `"spawned"` literal — 25 occurrences, at `:290-294`, `:307`, `:745`, `:754-761`. It does not typecheck: TS2345 ×9, `Argument of type '"spawned"' is not assignable to parameter of type '"user"'`. It passes at runtime only because `tsx` strips types.

No tsconfig covers `test/` at all, so both `npm run typecheck` scripts miss it. A retired type member can therefore live in the test tree indefinitely and its assertions keep passing against a value the production code can no longer produce.

The wider debt is about 305 type errors across the test tree, so this one file is not the whole story — it is the instance that proves the gap.

## Acceptance

- [ ] The `"spawned"` assertions in `test/policy-assembler.test.ts` are removed with a stated reason, and the generation assertions in the same tests are kept — they still mean something. No number re-pinning to make it pass.
- [ ] Either a tsconfig covers `test/`, or the repo states plainly that the test tree is never typechecked and records that as an accepted tradeoff. A third option — a narrow typecheck script over selected test files — is acceptable if it is cheap and named.
- [ ] If a tsconfig is added, the existing ~305 errors are not required to be fixed at once; a documented baseline or an include-list that starts narrow is fine.
- [ ] `npm run typecheck` cannot report success while a retired type member survives in a file it claims to cover.

## Constraints

- Do not add a dependency for this.
- Do not silently delete tests to reach a count.
- Keep the change out of ticket 157's diff; that ticket records the change as it landed.