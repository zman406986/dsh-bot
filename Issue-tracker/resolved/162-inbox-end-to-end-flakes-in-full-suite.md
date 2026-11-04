# 162 — `inbox-end-to-end` fails intermittently when the full suite runs, and passes alone

**Status:** resolved
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

## Comments

### Resolution (2026-11-04)

**The shared state is the watcher's own start-up ordering, not a temp dir, env var, port, or sweeper.** The ticket's diagnosis guessed "another process sweeping `%TEMP%\dsh-inbox-live-*`". That is wrong, and worth saying plainly: no sweeper exists in this repo (`grep` for temp cleanup found only `doc-lint` making its own dir), no test writes `process.env`, and the only server-ish string is a URL literal.

`startInboxWatcher` creates its root inside a fire-and-forget async block, and `apply` never awaits the returned handle's `ready`:

```
void (async () => { await mkdir(root, { recursive: true }); ... })();
```

`node:fs/promises` `mkdir` goes through the libuv threadpool. `flushActivation()` drains 8 `setImmediate` ticks — a microtask/macrotask drain that does **not** await threadpool work. So a test doing

```
pluginApply(...) → runCommand(DISPATCHER_START_COMMAND) → flushActivation() → writeQueue(root, ...)
```

is betting that an fs syscall finished within 8 event-loop ticks. Usually it has; under full-suite load it has not, and `writeFile(join(root, "queue.jsonl"))` throws ENOENT. The ticket's failing stack at the old line 395 was precisely that `writeQueue` helper.

Measured with a synchronous probe (uses `existsSync`, so the check itself cannot yield to the pending mkdir):

```
{"rounds":300,"root_absent_and_8_ticks":272}   startInboxWatcher → 8 ticks → existsSync(root)
{"rounds":200,"root_absent_after_flush":2}     full plugin apply → start → 8 ticks
```

The root is absent ~91% of the time for the bare watcher, and occasionally even through a full `apply`. The full-suite flake is that same window widening under load — which is also why it passes alone every time.

**The fix.** In `test/inbox-end-to-end.test.ts`:

- `writeQueue` now does `mkdir(root, { recursive: true })` before writing. The test owns its directory instead of depending on the watcher's timing; the watcher's own `mkdir` is recursive and tolerates an existing dir, so this changes no behaviour under test.
- Teardown uses a new `removeTempRoot` that retries (the mirror race: a scan already in flight during `ctx.dispose()` can land a write while `rm` runs, which Windows reports as ENOTEMPTY/EPERM).
- A one-sentence isolation note added to the file header, so a future reader does not re-diagnose it.

No assertion weakened, nothing skipped, no timeout raised. The reply-writer behaviour (ticket 113 N4) is untouched and still covered.

**Acceptance, item by item.**

- *Five consecutive full-suite runs, or the race proven and removed by construction* — the second branch, plus repeated narrowed runs. The true full suite was not runnable: other lanes had `src/` mid-edit throughout this session, and a commit from another lane landed at `e99ffa3` while this lane worked. Instead the narrowed set (inbox-end-to-end + inbox-watcher + inbox-core + restart-honesty + plugin-scaffold) was run twice, both clean: 48 tests / 48 pass / 0 fail (853 ms, then 739 ms). Additionally 10 concurrent copies of the inbox triple under `UV_THREADPOOL_SIZE=1`: all exit 0, zero ENOENT.
- *The failing assertion no longer depends on a directory that outlives its creator* — met. The test creates the root it writes into, and cleans up a root it created. The temp root is already unique per test (`mkdtemp` per `it`), which the ticket asked for and which was already true.
- *No timeout increase as the fix* — met. No timeout changed; the retry added is on directory removal, and it retries errors that are themselves the race, not slow work.
- *Reason stated in the test file in one sentence* — met (header note).

**Honest caveat on causality.** I reverted the `mkdir` line and ran 10 concurrent unfixed copies; they also passed. The window needs genuine machine load to lose, so there is no red run to show for this change. The causal evidence is the synchronous probe above (272/300 root-absent after 8 ticks), which measures the precondition of the failure directly rather than hoping to catch the rare outcome.

**Not-a-bug?** No. The precondition is real and reproducible on demand; the fix removes the dependence rather than masking the symptom.
