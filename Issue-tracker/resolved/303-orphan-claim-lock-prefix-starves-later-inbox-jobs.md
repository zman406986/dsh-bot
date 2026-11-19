# 303 — Orphan claim-lock prefix starves later inbox jobs

**Status:** resolved
**Labels:** ready-for-agent
**Type:** bug
**Severity:** P2 / medium
**Ship blocker:** no

## Problem and impact

With the optional file inbox enabled, a prefix of jobs carrying `claim.lock` but missing or still-queued status can consume every queue-resolution slot on every scan. Their exclusive claims fail, but the following healthy jobs never reach the claim loop. Repeated scans make no progress while that prefix remains unchanged.

The minimized proof uses `limit: 1`, one orphan-lock job and one healthy following job. The production plugin uses the default limit **50**, so this complete-prefix starvation requires **at least 50** such readable-but-unclaimable prefix entries before a healthy later job. The initial accepted independent proof used `limit: 1`; the original author later added a default-50 fixture and normal-claimed-status control, and the independent reviewer reran those existing cases as recorded below. One orphan lock alone does not starve an otherwise healthy production queue.

This does **not** describe ordinary `status.json: claimed` rows: those are skipped before they consume the resolved-entry cap. It also does not prove permanent loss under every recovery path. An external actor changing the queue or removing the blocking entries can restore progress.

## Requirement

Accepted file intake presents queued external work through the dispatcher wake path ([ADR-0023:19–23](../../docs/adr/0023-file-driven-external-intake.md#L19-L23), approved by [resolved 111:13](../resolved/111-file-inbox-scope.md#L13)). Batches are deliberately bounded, but the watcher explicitly promises that a larger backlog is picked up by a following rescan ([watcher:72–74](../../src/adapter/inbox-watcher.ts#L72-L74)). An unchanged unclaimable prefix defeating every later scan violates that progress promise, rather than merely delaying work by one bounded batch.

Exclusive claim protection must remain intact. Fixing progress must not delete another consumer's lock or permit a duplicate claim.

## Confirmed source path (pre-fix audit)

The source-path observations below record the behavior confirmed before the fix. The resolved implementation now filters existing claim locks before entries reach the bounded batch.

1. The default resolved/claimed batch limit is 50 ([watcher:102–103](../../src/adapter/inbox-watcher.ts#L102-L103)); the live plugin starts the watcher without overriding it ([plugin:2277–2287](../../src/plugin.ts#L2277-L2287)).
2. `readInboxQueue` restarts at the beginning of the queue and stops once `entries.length >= limit` ([watcher:504–510](../../src/adapter/inbox-watcher.ts#L504-L510)). It skips non-queued status rows ([569–572](../../src/adapter/inbox-watcher.ts#L569-L572)), but it does not inspect `claim.lock` when deciding which entries fill that batch.
3. `scanOnce` receives only that resolved prefix ([1106–1109](../../src/adapter/inbox-watcher.ts#L1106-L1109)), attempts each exclusive claim and counts a losing claim as skipped ([1120–1131](../../src/adapter/inbox-watcher.ts#L1120-L1131)). It does not refill the batch or advance a scan position past those failed candidates.
4. `claimInboxJob` creates `claim.lock` exclusively, then reads status/reply, then writes status `claimed` ([729–755](../../src/adapter/inbox-watcher.ts#L729-L755)). An existing lock immediately returns false at [737](../../src/adapter/inbox-watcher.ts#L737).
5. The orphan state is reachable if the process dies after the exclusive lock write and before the claimed-status write. The lock precedes the status write; cleanup cannot run after a hard process death. The source explicitly anticipates a retained claim marker when the status write dies ([726–728](../../src/adapter/inbox-watcher.ts#L726-L728)). This review did not physically crash a process.

The accepted per-job crash/claim limitations do not require independent later jobs to be blocked behind the orphan. No automatic progress past a fully saturated orphan prefix was found in this path.

## Offline reproduction and observed output

Existing isolated proof: [watcher-proof.test.ts:13–25](../../.scratch/behavior-audit-2026-11-18/file-intake/watcher-proof.test.ts#L13-L25). It creates a private fixture below the audit scratch directory, writes an orphan lock without a claimed status, queues a healthy job second, and runs the startup scan followed by two explicit scans with `limit: 1`. The scheduler is manual; real filesystem claims are exercised.

Independent review command, executed once on 2026-11-18:

```powershell
node --import tsx --test --test-timeout=15000 .scratch/behavior-audit-2026-11-18/file-intake/core-proof.test.ts .scratch/behavior-audit-2026-11-18/file-intake/watcher-proof.test.ts test/inbox-core.test.ts test/inbox-watcher.test.ts
```

Observed starvation output:

```text
LOCK_STARVATION {"seen":[],"next":{"claimed":[],"skipped":1,"malformed":0},"again":{"claimed":[],"skipped":1,"malformed":0}}
AssertionError: a stuck claim must not block independent jobs on every rescan
actual: []
expected: ['healthy']
```

The starvation test failed at proof line 24 in 19.7721 ms. The combined run exited 1: 22 tests, 19 pass, 3 fail, 0 cancelled; duration 210.7211 ms. All 19 baseline controls passed. The other two failures belong to separate audit hypotheses and are **not evidence for this issue**. No dedicated run-log file was written by the reviewer; the command output was returned in the review session.

### Later existing-fixture verification

The original author added the default-limit case and normal-status control in [watcher-proof.test.ts:43–59](../../.scratch/behavior-audit-2026-11-18/file-intake/watcher-proof.test.ts#L43-L59). The independent reviewer then ran this existing artifact once:

```powershell
node --import tsx --test --test-timeout=15000 .scratch/behavior-audit-2026-11-18/file-intake/watcher-proof.test.ts
```

Exit 1; 4 tests, 1 pass, 3 fail, 0 cancelled/skipped; duration 301.4918 ms. Both the minimized and default-50 starvation assertions failed; the normal `status.json: claimed` prefix control passed. Default output: `DEFAULT_LIMIT_STARVATION {"blocked":50,"seen":[]}` (139.0371 ms). The additional stop assertion also failed but remains an accepted in-flight teardown limitation, not part of this issue. This rerun was already authorized and underway before the later request to avoid any further rerun; no additional experiment followed.

## Duplicate check

Before filing, `303-*` was absent across all tracker states. Content searches across `open`, `deferred`, `resolved` and `cancelled` for `claim.lock`, orphan-lock/prefix and queue-starvation terms found no equivalent issue.

- [Resolved 113:34](../resolved/113-implement-file-inbox-per-adr-0023.md#L34) added bounded scans and already-claimed skipping; this issue is the lock-only candidate prefix that survives that filter.
- [Resolved 162:69–75](../resolved/162-inbox-end-to-end-flakes-in-full-suite.md#L69-L75) fixes test startup/cleanup timing and acknowledges in-flight teardown writes. It does not address prefix progress. No new stop/quiescence issue is included here.
- [Resolved 199:81–83](../resolved/199-priority-peer-drops-inbox-intake-from-dormant-mixed-wake.md#L81-L83) preserves intake payload during priority mixed-wake reclaim; it does not change queue resolution or exclusive claiming.

## Acceptance criteria

- [x] A bounded scan progresses past a persistent unclaimable lock-only prefix and eventually claims a healthy later job across repeated scans, without external queue rewriting.
- [x] A regression covers the minimized `limit: 1` case and the production-default threshold: 50 orphan-lock entries with absent/queued status followed by a healthy job. The healthy job is presented once; repeated scans do not duplicate it.
- [x] A control confirms that normal `status.json: claimed` prefix entries are skipped and do not consume the claimable batch.
- [x] Exclusive-claim race and terminal-file protections remain intact; no lock owned by another or unknown consumer is deleted or taken over.
- [x] Queue reads and scan work remain bounded. A bounded scan-position/pagination or safe unclaimable-candidate skip is sufficient; do not replace the cap with an unbounded scan.

## Scope and validation limits

P2 / medium, optional feature, unusual saturation threshold; not a ship blocker. The initial independent proof used the minimized limit; the later independent rerun also exercised the supplied default-50 fixture and normal-status control. Neither exercised a production inbox, actual process crash, network, LLM, restart recovery or full suite. The original audit above is retained as historical evidence; the fix and its validation are recorded below. The separate external-job-to-stock-worker provenance question remains unfiled pending an integration-level proof.

## Comments

- 2026-11-18 — Filed after source diagnosis and independent review. Only this issue file was created in the filing step. No product edits, new tests, extra test runs, index generation, commit or restart.

### 2026-11-18 — Resolution

- The fix is limited to [inbox-watcher.ts](../../src/adapter/inbox-watcher.ts#L575-L584): after the existing non-queued-status filter, `lstat` checks `claim.lock` before the job consumes an eligible-entry slot. Any extant object is skipped without following, reading, deleting, or replacing the lock. Only `ENOENT` means absent; other errors conservatively skip.
- Existing queue byte/line ceilings and the per-pass entry limit remain unchanged. No cursor, unbounded refill, or claim takeover was added. [Exclusive `wx` creation and under-lock status/reply rechecks](../../src/adapter/inbox-watcher.ts#L737-L765) remain authoritative if a lock appears after queue resolution.
- Added public-watcher regressions in [inbox-orphan-lock-fairness.test.ts](../../test/inbox-orphan-lock-fairness.test.ts). The minimized `limit: 1` test went red first: 1 test failed, actual `[]` versus expected `healthy`; [exact red output](../../.scratch/behavior-fixes-2026-11-18/303/red-limit1.txt). The same command passed after the reader change: 1 pass / 0 fail; [exact first-green output](../../.scratch/behavior-fixes-2026-11-18/303/green-limit1.txt).
- The production-default test omits `limit`, places 50 orphan locks (mixed absent/queued status) before 51 healthy jobs, and verifies startup 50 → next scan 1 → final scan 0, exactly-once callbacks in queue order, and unchanged lock bytes. Existing claimed-status controls were retained, not duplicated.
- Focused validation ran directly, bypassing npm pretest and vendor builds:

```text
node --import tsx --test --test-timeout=15000 test/inbox-watcher.test.ts test/inbox-watcher-audit.test.ts test/inbox-safety.test.ts test/inbox-orphan-lock-fairness.test.ts
```

  Exit 0: **42 tests / 42 pass / 0 fail / 0 skipped**, duration 738.9085 ms. This includes exclusive-claim race, terminal-file protection, bounded-read, and containment controls; [exact grouped output](../../.scratch/behavior-fixes-2026-11-18/303/green-focused.txt).
- Independent static review (reviewer `2e39`) approved the final source/test change with no blocking finding; the parent accepted the author’s 42/42 run. Static review was not a separate test rerun.
- Close-out changed only this ticket’s status/content and folder. No generated index, commit, vendor build, reference-tree work, production inbox access, live model/API call, or restart was performed.