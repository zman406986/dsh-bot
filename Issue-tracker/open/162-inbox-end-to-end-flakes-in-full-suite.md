# 162 — `inbox-end-to-end` fails intermittently when the full suite runs, and passes alone

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing. Pre-existing; not caused by ticket 157.
**Origin:** observed three times by the release-prep session on 2026-10-29 while verifying ticket 158.
**Related:** ticket 158 (the verification lane that hit it), ticket 113 (the reply-writer behaviour this suite covers).

## Problem

Three full-suite runs on the same tree, same machine, minutes apart:

| Run | Result | Failure |
|---|---|---|
| 1 | exit 1 | `ENOENT: no such file or directory, open '...\Temp\dsh-inbox-live-7hf6K0\inbox\queue.jsonl'` at `test/inbox-end-to-end.test.ts:395` |
| 2 | 1694 tests, 1693 pass, 1 fail | same suite |
| 3 | exit 0, 1694 pass | none |

The file passes reliably in isolation: `npx tsx --tsconfig tsconfig.client.json --test test/inbox-end-to-end.test.ts` → 9 tests, 9 pass, 0 fail.

`test/inbox-end-to-end.test.ts` is **not modified** by ticket 157 (`git status` shows it clean), so this is independent of that change.

## Diagnosis (not confirmed)

The failing write targets a per-run temp directory (`dsh-inbox-live-<random>`). The suite is invoked as `test/**/*.test.ts`, which Node runs as concurrent processes. Something removes that directory mid-test — either the test's own teardown racing its body, or another process sweeping `%TEMP%\dsh-inbox-live-*`. Not investigated further; the suite is currently unreliable as a single-run gate, which is why ticket 158's acceptance needs more than one run.

## Acceptance

- [ ] The suite passes the full offline run repeatedly — at least five consecutive runs with no failure — or the race is proven and the flake is removed by construction.
- [ ] The failing assertion no longer depends on a directory that outlives its creator: either the test owns the cleanup, or the temp root is unique per test file, not per run.
- [ ] No timeout increase used as the fix.
- [ ] The reason is stated in the test file in one sentence so a future reader does not re-diagnose it.

## Constraints

- Offline only. No live dsh, no LLM, no server.
- Do not weaken the assertions; the reply-writer behaviour under test (ticket 113 N4) must still be covered.
- Do not mark ticket 158 green on the strength of a single passing run.