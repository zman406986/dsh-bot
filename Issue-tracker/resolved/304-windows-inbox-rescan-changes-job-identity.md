# 304 — Windows inbox rescan changes job identity

**Status:** resolved
**Labels:** ready-for-agent
**Type:** bug
**Severity:** P2 / medium
**Ship blocker:** no

## Problem and impact

On the tested case-insensitive Windows filesystem, an accepted queue job id `job-1` can resolve to a real directory named `Job-1`. Intake accepts and claims that directory while retaining the supplied job id. A later activation rescan derives the job id from the canonical directory basename instead of the recorded durable identity. It creates a second checkpoint under `Job-1` and presents that renamed identity, leaving the original `job-1` checkpoint claimed.

The isolated proof confirms **one activation producing two checkpoint identities**, not duplicate worker execution, repeated-restart behavior, a full reply failure, or permanent loss. The inbox is optional and disabled by default; this is P2 / medium, Windows/case-insensitive-path-specific, and not a ship blocker.

## Requirement

Accepted file intake records job dedupe/checkpoint state and re-presents recorded commitments on activation ([ADR-0023:19–23](../../docs/adr/0023-file-driven-external-intake.md#L19-L23), approved by [resolved 111:13](../resolved/111-file-inbox-scope.md#L13)). Rescanning one accepted job must preserve its identity rather than inventing another job merely because canonical filesystem spelling differs.

The shipped key contract preserves accepted job ids exactly: [inboxCheckpointKey:156–175](../../src/adapter/inbox-watcher.ts#L156-L175) returns accepted ids unchanged and provides a decoder for encoded historical/out-of-grammar keys. Path containment deliberately accepts equivalent casing on Windows; this must not become an implicit change to job-id spelling.

## Confirmed source path

1. Directory inspection returns `realpath` spelling ([watcher:230–244](../../src/adapter/inbox-watcher.ts#L230-L244)); the containment comparison accepts the equivalent job name ([247–252](../../src/adapter/inbox-watcher.ts#L247-L252)), and resolution returns the canonical directory ([255–262](../../src/adapter/inbox-watcher.ts#L255-L262)).
2. The real claim callback records `inboxCheckpointKey(entry.jobId)` and `entry.dir`, preserving the queue id with the canonical path ([plugin:2096–2124](../../src/plugin.ts#L2096-L2124)). Thus `{jobId: "job-1", jobDir: ".../Job-1"}` is a reachable accepted checkpoint shape.
3. Dispatcher activation invokes the actual checkpoint rescan even when intake is currently off, because recorded rows remain commitments ([plugin:1819–1828](../../src/plugin.ts#L1819-L1828)).
4. Rescan explicitly chooses a valid `basename(checkpoint.jobDir)` ahead of the stored/decoded job id ([plugin:2173–2179](../../src/plugin.ts#L2173-L2179)). In the proof, this changes `job-1` to `Job-1`.
5. It resolves task text and calls `presentInboxJob` with that changed id ([plugin:2231–2246](../../src/plugin.ts#L2231-L2246)). Presentation looks up the changed checkpoint key ([2017–2019](../../src/plugin.ts#L2017-L2019)), then records a presented row under that key ([2068–2078](../../src/plugin.ts#L2068-L2078)). The original row is not removed or advanced.

## Offline reproduction and output

Existing artifact: [path-case-proof.test.ts](../../.scratch/behavior-audit-2026-11-18/file-intake/path-case-proof.test.ts). Independent review ran it once on Windows:

```powershell
node --import tsx --test --test-timeout=15000 .scratch/behavior-audit-2026-11-18/file-intake/path-case-proof.test.ts
```

Result: exit 1; 1 test, 0 pass, 1 fail, 0 skipped/cancelled; runner duration 482.6007 ms, test duration 26.9624 ms. Final assertion at [proof:47](../../.scratch/behavior-audit-2026-11-18/file-intake/path-case-proof.test.ts#L47) expected one checkpoint key and observed two:

```text
entryJobId: job-1
canonical directory basename: Job-1
checkpoint keys: [job-1, Job-1]
original job-1 row: claimed, sessionId:null
new Job-1 row: presented, sessionId:s-1, todoId:todo-1
wakes: 1
expected keys: [job-1]
```

### Caller realism and limits

The proof creates only a private scratch directory and exercises real `readInboxQueue` and `claimInboxJob`; successful resolution/claim verifies the path equivalence on the tested filesystem. It then **seeds the claimed checkpoint in the same shape the real claim callback writes**; it does not invoke that callback or a live watcher.

It invokes the actual `plugin.apply`, registered dispatcher activation command and actual asynchronous boot-rescan/presentation code. The event bus, agent and storage domain are synthetic in-memory services. The rescan algorithm is not duplicated in the proof. A storage-write completion signal bounds observation of the presented row.

This is strong integration-seam evidence for the checkpoint identity split. It does not test live watcher dispatch, real persisted-storage restart, repeated activations, stock worker spawning, duplicate execution, or full reply delivery. No network, LLM, user inbox or credential/config files are involved. No dedicated reviewer log file was written; the tool transcript contains the output.

## Duplicate check

Before filing, `304-*` was absent across all tracker states. Searches of all issue-state folders for checkpoint casing, canonical casing, basename/job identity and rescan identity found no equivalent.

- [Resolved 113:18–20](../resolved/113-implement-file-inbox-per-adr-0023.md#L18-L20) establishes checkpoint/re-presentation and terminal mapping, not path-case identity replacement.
- [Resolved 162](../resolved/162-inbox-end-to-end-flakes-in-full-suite.md) addresses test startup and cleanup timing, not durable identity.
- [Resolved 199](../resolved/199-priority-peer-drops-inbox-intake-from-dormant-mixed-wake.md) preserves payload during mixed-wake reclaim, not canonical directory spelling.
- [Resolved 303](303-orphan-claim-lock-prefix-starves-later-inbox-jobs.md) concerns orphan-lock prefix scan progress; the cause and proof differ.

## Acceptance criteria

- [x] An accepted job keeps its recorded/decoded durable id across activation rescan when canonical directory casing differs. Canonical paths remain for containment, not as a new job identity.
- [x] A Windows-capable regression accepts/claims a differently cased canonical directory through real queue helpers, runs real activation rescan, and asserts one checkpoint key plus the original job identity in the re-presented wake/todo.
- [x] Existing encoded-key compatibility and path-containment safety remain intact. Do not generically lowercase every job id: that would invent an identity-normalization contract and could collapse distinct valid ids.
- [x] Ordinary matching-case checkpoints and terminal disk-state adoption remain valid.

## Resolution — 2026-11-18

[Activation rescan](../../src/plugin.ts) now prefers the recorded literal job id when the existing `resolveRecordedJobDir` validator accepts it. Only when that resolution rejects does it try a distinct, grammar-valid decoded candidate through the same validator. Canonical directory spelling is not a job identity, and the unused `basename` import was removed. This also preserves valid literal ids that happen to match the encoder's checksum-tagged syntax. No general lowercasing, basename/title heuristic, path-validator change, or RACOONS/config/mount change was made.

The existing resolver's safety and fallback semantics are unchanged: configured-root containment, Windows-equivalent path-name comparison, absolute/traversal/symlink checks and the pre-existing missing-directory protocol-path fallback still apply. This fix does not promise a new alias-migration or historical encoded-valid-id deduplication contract. The current key writer stores every accepted grammar-valid id unchanged; encoded out-of-grammar ids remain subject to the existing presentation grammar.

[The dedicated regression](../../test/inbox-rescan-identity.test.ts) uses the actual `plugin.apply`, awaited registered activation command and asynchronous boot rescan. The Windows case first accepts and claims `job-1` against canonical `Job-1` through real queue helpers, then seeds the exact claimed-checkpoint shape. It asserts one durable key, unchanged canonical directory, original-id wake and todo ledger reminder, claim timestamp and presentation count. It skips only when the actual test filesystem is case-sensitive. Portable controls cover an accepted literal `enc_am9iLTE_026ab639` (which must not be mistaken for encoded `job-1`) and an invalid decoded id paired with a valid-looking basename (which must not invent a new job). A last-row storage-write signal bounds rescan observation; no private rescan algorithm is duplicated.

### Red → green evidence

All runs used the direct runner below, bypassing npm pretest/vendor prebuild scripts:

```powershell
node --import tsx --test --test-timeout=15000 test/inbox-rescan-identity.test.ts
```

- Original Windows regression: exit 1, 1 test / 0 pass / 1 fail / 0 skipped, 722.0123 ms. Expected `['job-1']`; observed `['job-1', 'Job-1']`.
- Initial Windows correction: exit 0, 1/1 passed, 608.6636 ms.
- Independent reviewer 185 identified the valid encoded-looking literal collision. Its added real queue/claim regression went red: exit 1, 3 tests / 2 pass / 1 fail, 640.309 ms; the literal's row stayed `claimed` instead of `presented`.
- After raw-literal-first/path-validated correction: exit 0, 3/3 passed, 0 skipped, 480.0029 ms.

Focused compatibility command:

```powershell
node --import tsx --test --test-timeout=15000 test/inbox-rescan-identity.test.ts test/inbox-watcher-audit.test.ts test/inbox-safety.test.ts test/adapter-durable-marker.test.ts
```

Result: exit 0, 56/56 passed, 0 skipped/cancelled, 580.6087 ms. Existing containment controls, encoded-key helper roundtrips, malformed checkpoint schemas, matching-case disabled/empty-config rescan and terminal disk-state adoption passed. This is not a live watcher/persisted-host restart/full reply-delivery claim; the original audit's bounds above remain intact.

Independent reviewer 185 approved the corrected implementation; the parent confirmed that approval and authorized ticket closure. Concurrent shared-plugin work was preserved. No reference-tree work, live model/API call, restart, vendor prebuild, generated index, commit or staging was part of this fix.

## Comments

- 2026-11-18 — Filed after independent source/caller review and one bounded run of the existing proof. No product/test edits, additional experiments, fix, index generation, commit or restart in this filing step.
- 2026-11-18 — Resolved after the Windows red→green regression, reviewer-discovered encoded-looking literal collision red→green correction, 3/3 dedicated and 56/56 focused compatibility passes, and reviewer 185 approval confirmed by the parent. Original audit retained; closure changes documentation only.
