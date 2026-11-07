# 187 — Preflight-rejected edit falsely invalidates read coverage

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P2
**Severity:** medium
**Ship blocker:** no — RACOONS is optional and off by default; this is a confirmed evidence/invalidation defect when enabled, not a default-path blocker ([ticket 186:19](186-racoons-ask-iterator-cleanup.md#L19)).

## Problem and impact

A standard edit request whose `old_string` and `new_string` are identical is rejected by the installed filesystem tool's argument preflight before it resolves or edits any file. The failed tool result still carries its edit name, input path, target facts and failure marker into the RACOONS snapshot. The adapter classifies it as a `write` with an unknown path outcome, while the core's write contract treats every write-kind path as proof that the path changed.

Consequently, a known no-mutation refusal is treated as a real write: an earlier successful read of that path can be marked invalid, its path-coverage row can be dropped, and a later partial-removal check can report `edit-outside-coverage`. The file did not change; only RACOONS' evidence about the unchanged file was lost. This ticket does not claim all failed writes are no-ops. A failure that could have partially mutated a file must retain conservative invalidation unless the producer proves otherwise.

## Confirmed evidence and reachable path

- **The contract says a write proves change, not hit or miss:** [`core/units/writes.ts:7–16](../../vendor/racoons/core/units/writes.ts#L7-L16) says a write result is a fact that "this path changed here" and its outcome is always unknown; [path spellings and path writes:36–64](../../vendor/racoons/core/units/writes.ts#L36-L64) records every write-kind path spelling without an outcome check.
- **The producer retains the failed edit facts:** [`adapter/plugin.ts:845–856](../../vendor/racoons/adapter/plugin.ts#L845-L856) derives `isError`, keeps the tool name, input and target, and attaches `failed: true` with `complete: false`. The snapshot loop includes tool-result items [at 978–985](../../vendor/racoons/adapter/plugin.ts#L978-L985), regardless of entry-queue admission.
- **Write evidence bypasses the failed-result filter:** [`adapter/evidence.ts:85–104](../../vendor/racoons/adapter/evidence.ts#L85-L104) classifies the edit and stores its `file_path`; [110–133](../../vendor/racoons/adapter/evidence.ts#L110-L133) excludes writes from the `failed !== true` gate, leaves the outcome unknown, and returns evidence without the failed flag. The shipped adapter copy agrees: [`lib/evidence.js:43–94](../../vendor/racoons/adapter/lib/evidence.js#L43-L94).
- **The core consumes that path as a write:** [`core/units/invalidation.ts:100–125](../../vendor/racoons/core/units/invalidation.ts#L100-L125) matches a later write against earlier hit-read spellings and marks the read node invalidated. [Coverage view removal:137–145](../../vendor/racoons/core/units/invalidation.ts#L137-L145) applies the stale set, and [stale coverage derivation:160–172](../../vendor/racoons/core/units/invalidation.ts#L160-L172) selects rows for written paths. The guard's write policy and re-derivation are [checks-invalidation.ts:11–17, 37–44](../../vendor/racoons/core/guard/checks-invalidation.ts#L11-L44); a partial removal can then be refused as `edit-outside-coverage` [at 45–60](../../vendor/racoons/core/guard/checks-invalidation.ts#L45-L60).
- **The installed edit tool proves this particular refusal is pre-mutation:** [`parseEditArgs:1427–1437](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js#L1427-L1437>) throws when `old_string === new_string`. The execute path calls that parser at [1516–1517](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js#L1516-L1517>), before policy resolution, path resolution or `editText` [1518–1527](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js#L1518-L1527>).

## Prior deterministic reproduction — not rerun during filing

The supplied prior audit reports a file-free probe against shipped JavaScript, exit code 0. It establishes a successful same-path read, then submits the identical-string edit rejected by the preflight above. Reported results: `failedEditKind=write`, the prior read appears in `invalidatedNodeIds`, coverage rows go from `1` to `0`, and the guard reports `edit-outside-coverage`. The baseline without the failed edit has zero invalidations. This is prior output, not a probe rerun or a new execution during filing.

The probe used `barBytes=1` to isolate unit invalidation. Whole-result unit creation requires a result at least as large as `barBytes` ([segmenter.ts:9–17](../../vendor/racoons/core/units/segmenter.ts#L9-L17)); the default `protocol.barBytes` is 8192 ([core/config.ts:117–120](../../vendor/racoons/core/config.ts#L117-L120)). Stale path-coverage rows are derived separately, so their loss does not require any large unit. A separate guard/units policy review found no documented blanket carve-out for every failed write attempt; this ticket asks only to distinguish a refusal proven not to mutate from a possibly partial or unknown mutation.

## Acceptance criteria

- [ ] A tool outcome proven to have been rejected before filesystem mutation is distinguishable from a successful write and from a failed write whose mutation result is partial or unknown. Do not treat every failed write as a no-op.
- [ ] A proven no-mutation edit refusal does not create an invalidating path-write fact: an earlier successful same-path read remains covered, its node is absent from `invalidatedNodeIds`, and its path-coverage row is retained. The refusal alone does not cause `edit-outside-coverage`.
- [ ] Successful writes continue to invalidate matching earlier read coverage. Failed writes that may have partially mutated the path continue to use conservative invalidation unless their producer provides reliable no-mutation evidence.
- [ ] Add a deterministic offline regression for the known preflight refusal after a same-path read, including path-coverage preservation with no large processing unit. Keep successful-write and mutation-unknown failure controls so the distinction cannot become an all-failures exemption.

## Scope, duplicate check and filing validation

Repeated searches across `open`, `deferred`, `resolved` and `cancelled` for preflight rejection, failed edit/write classification, write outcomes and stale path coverage found no equivalent. Prefix 187 was absent from all four folders before creation. [Tickets 145](../resolved/145-racoons-redo-latest-full-coverage.md) and [148](../resolved/148-racoons-resync-latest.md) cover integration/resync; [150](../resolved/150-racoons-record-only-semantics.md) covers record-only entry behavior. [182](182-workflow-bypasses-worker-leaf-tool-barrier.md) and [200](200-worker-composition-failure-keeps-unrestricted-worker-live.md) concern worker barriers; 195–199 concern separate runtime faults; [186](186-racoons-ask-iterator-cleanup.md) concerns stream iterator cleanup. None matches this no-mutation edit-evidence defect.

Read the tracker rules, agent conventions and one existing new-ticket format; verified the cited source ranges and installed preflight path by static reads. The supplied reproduction was not rerun. No agents, probes, tests, builds or live provider calls were performed. This filing creates only this issue; no source, test, config, product documentation, artifact or generated index was changed.

## Comments

- 2026-11-07 — Filed as P2 / medium, ready-for-agent, and not a ship blocker. The confirmed scope is a known preflight no-mutation refusal falsely invalidating RACOONS read evidence; real or uncertain mutations remain conservative.

## Resolution - 2026-11-08

Only a no-mutation edit (`old_string` present and equal to `new_string`) withholds write evidence, while committed, unknown, and older snapshots stay conservative; commit `2e2cb36`; `test/racoons-edit-coverage.test.ts` 7/7.
