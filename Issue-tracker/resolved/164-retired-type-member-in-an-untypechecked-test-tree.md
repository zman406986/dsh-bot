# 164 — A retired type member lives in the test tree, which no tsconfig typechecks

**Status:** resolved
**Labels:** needs-triage
**Blocked by:** nothing.
**Origin:** found by the ticket-157 review, 2026-10-29.
**Related:** ticket 157 (retired the `"spawned"` dispatcher origin), ADR-0032.

## Problem

`test/policy-assembler.test.ts` still passes the retired `"spawned"` literal — 25 occurrences, at `:290-294`, `:307`, `:745`, `:754-761`. It does not typecheck: TS2345 ×9, `Argument of type '"spawned"' is not assignable to parameter of type '"user"'`. It passes at runtime only because `tsx` strips types.

No tsconfig covers `test/` at all, so both `npm run typecheck` scripts miss it. A retired type member can therefore live in the test tree indefinitely and its assertions keep passing against a value the production code can no longer produce.

The wider debt is about 305 type errors across the test tree, so this one file is not the whole story — it is the instance that proves the gap.

## Acceptance

- [x] The `"spawned"` assertions in `test/policy-assembler.test.ts` are removed with a stated reason, and the generation assertions in the same tests are kept — they still mean something. No number re-pinning to make it pass.
- [x] Either a tsconfig covers `test/`, or the repo states plainly that the test tree is never typechecked and records that as an accepted tradeoff. A third option — a narrow typecheck script over selected test files — is acceptable if it is cheap and named.
- [x] If a tsconfig is added, the existing ~305 errors are not required to be fixed at once; a documented baseline or an include-list that starts narrow is fine.
- [x] `npm run typecheck` cannot report success while a retired type member survives in a file it claims to cover.

## Constraints

- Do not add a dependency for this.
- Do not silently delete tests to reach a count.
- Keep the change out of ticket 157's diff; that ticket records the change as it landed.

## Comments

### 2026-11-04 — resolved

**The premise had moved.** The ticket names `"spawned"` in
`test/policy-assembler.test.ts` as the retired member. Ticket 176's class split
(643a801) re-added that member, so today `DispatcherOrigin = "user" | "spawned"`
(`src/core/policy/prompts.ts:68`) and those 36 occurrences are valid, live code.
They are not the retired member any more, and deleting them would have destroyed
working coverage of the two policy classes. Nothing was removed from that file.

**What was actually retired, found by typechecking the tree instead of trusting
the ticket's line numbers:**

| Site | Retired member | Fix |
|---|---|---|
| `test/message-agent.test.ts:65` | `access` on `MultitaskOptions` (removed by ticket 174) | option deleted |
| `test/worker-wake-on-send.test.ts:55` | the same `access` option | option deleted |
| `test/delivery-obligation.test.ts:33` | `accessRequests` / `accessNotices` on `WakeEvent` | fields deleted |
| `test/host-seam.test.ts:171` | `lastKnownStatus` on `DurableWorkerMarker` | field deleted; `status: "running"` already carries the snapshot |
| `test/multi-dispatcher.test.ts:37,38,44` | `AccessPromptAnswerLike`, `AccessPromptRequestLike`, `UserQuestionsLike` (gone from the adapter barrel) | imports plus the whole dead `createFakeUserQuestions` seam and its unused `seam` parameter removed |

Three further type failures were not retired members but did block the gate:
`CreateAgentOptionsLike` was reachable only from the declaring module (test now
imports it from `cordis-dsh-host.js`), `WakeBus` was used without being imported,
and `ctx.tool` existed at runtime but not in a context's declared type.

**The blind spot is now closed.** `tsconfig.test.json` covers `src/**` plus
`test/**` at the project's own strictness, and `npm run typecheck` runs it as
the new `typecheck:test` step, so `npm run typecheck` can no longer pass while a
retired member survives in a covered test file.

**Size of the blind spot, measured not guessed:** covering the whole test tree
surfaced **194** errors across 35 files (180 after the fixes above; 34 files
still dirty). The ticket estimated ~305, which was high. The gate starts narrow
per the acceptance row: `tsconfig.test.json` `exclude`s those 34 files, and
because it is an EXCLUDE list rather than an include list, **every test file not
named in it is typechecked by default** — a new test file is covered the moment
it is created, and a file leaves the baseline only by being fixed. The 34 dirty
files are listed verbatim in that exclude block as the documented baseline.

**Proven, not asserted.** I reintroduced `access: {...}` into
`test/message-agent.test.ts` and confirmed the gate fails with
`TS2353 ... 'access' does not exist in type 'MultitaskOptions'`, then restored
the file and confirmed it passes again.

**Note on a rejected design:** relaxing `strict` / `exactOptionalPropertyTypes`
in the test config to isolate this bug class was tried and abandoned — it
produced 24 new errors in `src/` by breaking discriminated-union narrowing, so
the gate runs at full project strictness instead.

Checks: `npx tsc -p tsconfig.json --noEmit`, `-p tsconfig.client.json` and
`-p tsconfig.test.json` all exit 0. Suites touched here:
message-agent, worker-wake-on-send, delivery-obligation, host-seam,
multi-dispatcher, inbox-core, e2e-critical-path, policy-assembler — 90/90 pass.