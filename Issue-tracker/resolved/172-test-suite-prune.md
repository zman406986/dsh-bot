# 172 — Prune the test suite aggressively

**Status:** resolved
**Labels:** ready-for-agent
**Type:** task
**Origin (owner, 2026-11-03, verbatim):** "Prune tests aggressively - we have too many. Delete whole if just mirroring working code, make the remaining more concise, and as optional unit tests where possible, keep only what we absolutely must have in a very lean e2e."

## Before numbers

| Measure | Before |
|---|---|
| Test files under `test/` | 88 |
| Lines of test code | 50,807 |
| Tests (`it`/`test`) | 1,696 |
| Suites | 393 |
| Suite runtime | ~122 s |

Commands (both green at filing):

- full suite: `npx tsx --tsconfig tsconfig.client.json --test test/*.test.ts`
- typecheck: `npx tsc -p tsconfig.json --noEmit`

The `--tsconfig tsconfig.client.json` flag is required: without it 16 client tests fail on
`React is not defined`. That is pre-existing, not caused by this ticket.

## After numbers

| Measure | Before | After | Change |
|---|---|---|---|
| Test files under `test/` | 88 | 76 | −12 (−13 deleted, +1 new lean e2e) |
| Lines of test code | 50,807 | 33,479 | −17,328 (−34%) |
| Tests (runtime count) | 1,696 | 846 | −850 (−50%) |
| Suites (runtime count) | 393 | 298 | −95 |
| Suite runtime | ~122 s | ~122 s | flat (fixed sleeps + the racoons mount dominate) |

Verification: five consecutive full-suite runs green, then a final run green (846/846), plus
`test/e2e-critical-path.test.ts` alone (3/3). `npx tsc -p tsconfig.json --noEmit` and
`npx tsc -p tsconfig.client.json --noEmit` both clean. No file under `src/` was touched by
this ticket (`git diff src/` shows only pre-existing ticket-170 prompt work from 2026-11-02).

`test/inbox-end-to-end.test.ts` is the one flake source, and it is pre-existing ticket 162 —
it failed intermittently during this ticket, always in a different test of that file, and
always passed alone. The trim removed 4 of its 9 tests, which cuts the flake surface but does
not claim to fix ticket 162.

## Acceptance criteria

1. Every one of the 88 pre-existing files carries a KEEP / TRIM / DELETE classification in
   this ticket, written **before** any deletion.
2. DELETE is allowed only for a file whose tests are, in whole: line-by-line mirroring of a
   pure function; prompt/copy string content beyond a handful of load-bearing markers; the
   retired "one policy for every dispatcher" shape or another superseded ruling; or
   snapshot-style duplication of a table one data-driven test covers better.
3. TRIM keeps the file and cuts tests; one `describe` per module, table-driven `it` blocks
   instead of near-duplicate cases, and no comment that explains what the code does.
4. Every DELETE names, in the coverage-loss register below, the behaviour that stops being
   covered and why that is acceptable.
5. Exactly ONE end-to-end file survives (plus the new lean one), and it exercises activate
   dispatcher → spawn worker → worker settles → wake reaches dispatcher → result delivered
   → todo completed. Everything else is a unit test of a pure module.
6. No assertion guarding data loss, security, or a fail-closed path is weakened or removed.
   The keep-list below is binding.
7. No file under `src/` changes. This is a test-only change.
8. Full suite green; the lean e2e green on its own.

## Keep-list (binding — from PRD §4 S1–S9 and the ADRs)

- durability / restart / unknown-state (ADR-0006);
- the todo ledger's delivery obligation and its bound (ADR-0007, ticket 58);
- wake-bus ordering, preemption, coalescing;
- worker tool barrier / deny list (security-adjacent);
- approval and access-ask fail-closed behaviour;
- the inbox protocol (ADR-0023);
- peer inbox caps and dedupe;
- the stage-table derivation (ticket 171).

## Classification of all 88 files

Legend: **K** = keep untouched, **T** = trim, **D** = delete whole. "→n" is the planned
post-trim test count.

| # | File | Lines | Tests | Decision | Reason |
|---|---|---|---|---|---|
| 1 | access-prompt.test.ts | 1372 | 56 | T→20 | Fail-closed ask/answer core stays (wildcard fence, deny-wins, no session row for wildcard, expired answer, seam-failure fallback). Duplicate template prose, per-class phrasing, and both duplicated duplicate-registration pins go. |
| 2 | access-relay.test.ts | 1061 | 40 | T→24 | Timeout deny, deny honesty, credential-never-in-prompt, one-ask-per-worker, dispose are binding. Policy-table rows duplicate review-posture; assembler prose is copy. |
| 3 | activation-lifecycle.test.ts | 673 | 18 | T→9 | Activation/deactivation rebind and child-chat refusal stay. Flag matrix duplicates feature-flag; duplicate-registration block is duplicated in 7 other files. |
| 4 | adapter-content-blocks.test.ts | 64 | 7 | T→2 | `textBlock`/`textBlocks`/`blocksToText` mirror the function bodies. Keep the format-v4 source-kind pin (a host contract a refactor could silently break). |
| 5 | adapter-cordis-dsh-host.test.ts | 1447 | 55 | T→22 | Depth ceiling (ticket 83), spawn/interrupt/send contract, settle mapping, first-edge ordering (ticket 120), recentResult excerpt stay. Activity/peer-tool/tool-call phrase feeds are observability copy already bounded by worker-activity-ring. |
| 6 | adapter-dispatcher-tools.test.ts | 893 | 29 | T→14 | Registration + presentation projection, per-session routing (ADR-0019), exec passthrough, and user-message release (source-never-text) stay. |
| 7 | adapter-durable-marker.test.ts | 562 | 18 | T→12 | Durability is binding. The four "schema parse rejects malformed X" cases collapse into one table. |
| 8 | adapter-microcompact.test.ts | 753 | 22 | T→11 | Compaction is a context-rewrite path. Decline matrix collapses into one table; the pass/boundary/listener honesty pins stay. |
| 9 | adapter-policy-inject.test.ts | 649 | 23 | T→9 | Policy-inject-once, top-level refusal, turn-end redrive, and peer-label best-effort stay. The activation matrix duplicates activation-lifecycle. |
| 10 | adapter-racoons-mount.test.ts | 1583 | 10 | T→4 | Keep durable per-session round-trip and full teardown (leak guard). Config-mapping and no-session-filter detail are third-party wiring. |
| 11 | approval-cards.test.ts | 366 | 22 | T→6 | Keep credential secret-kind (names, never values), wildcard-drop, replay-safety, and the unfed-is-unknown pin. |
| 12 | approval-feed-composition.test.ts | 757 | 5 | D | Multi-module composition for retained-and-unmounted client machinery. Host chain is folded into the lean e2e; the client half has no live channel (ADR-0024). |
| 13 | approval-feed.test.ts | 352 | 14 | D | Feed for the unmounted approval pane. Its one real invariant (an invalid document never fabricates "nothing waiting") moves to the lean e2e's absence checks. |
| 14 | await-agent.test.ts | 650 | 23 | D | Third copy of the bounded-await behaviour already pinned in settle-records (ring + engine + public method). Barrier coverage stays structural in worker-agent-type. |
| 15 | client-approval-pane.test.ts | 290 | 10 | D | Unmounted pane (ADR-0024). Card copy, CSS, and locale parity only. |
| 16 | client-bundle-check.test.ts | 91 | 7 | T→3 | Keep equal-is-fresh and the byte-vs-UTF-16 staleness trap. |
| 17 | client-command-transport.test.ts | 169 | 5 | K | Pins the human ruling that no stop/cancel transport exists (ADR-0030). |
| 18 | client-composer-send.test.ts | 321 | 3 | D | Drives the unmounted shell composition's send path. |
| 19 | client-conversation-surface.test.ts | 1161 | 45 | D | Unmounted conversation pane: reduction, CSS, copy, locale parity. |
| 20 | client-face-scaffold.test.ts | 826 | 21 | T→8 | Keep the package record (externals, inject, exports), locale parity via the validator, and apply-registers-no-overlay. |
| 21 | client-onboarding.test.ts | 708 | 41 | D | Unmounted pane. Beat copy, suppression bookkeeping, CSS, and wiring only. |
| 22 | client-roster-panel.test.ts | 1017 | 36 | D | Unmounted panel. Section partitioning is a pure projection restated per status; the FSM vocabulary itself is pinned in roster-snapshot. |
| 23 | client-session-kind.test.ts | 636 | 21 | K | Live seat (ADR-0024 rider, ADR-0032). Glyph and fail-closed resolution are shipped surface. |
| 24 | client-settings-card.test.ts | 822 | 35 | T→20 | Live surface with fail-closed writes (invalid draft, read-back mismatch, missing write verb). Staging/save duplication collapses into tables. |
| 25 | client-shell-mount.test.ts | 1035 | 34 | D | Retained, unmounted mount machinery (ADR-0024) plus retired-path records. |
| 26 | client-shell-seat-composition.test.ts | 598 | 4 | D | Unmounted shell seat composition. |
| 27 | client-theme-tokens.test.ts | 248 | 11 | K | Token-only CSS contract over live surfaces (settings card, session-kind glyph). |
| 28 | client-toolviews.test.ts | 1213 | 50 | T→18 | Live surface. One table-driven case per payload shape replaces the per-tool near-duplicates; degradation and slot-props parsing stay. |
| 29 | client-wrapper-shell.test.ts | 744 | 41 | D | Unmounted wrapper shell: store, presence, CSS, locale, feed projection. |
| 30 | coexistence.test.ts | 1229 | 14 | T→6 | Keep fail-loud duplicate claims and additive-only registration against a foreign plugin. Dormant-matrix detail duplicates composition-polish. |
| 31 | composition-polish.test.ts | 684 | 14 | T→5 | Keep the dormant registration matrix and "every client key resolves in both faces". Activation-copy strings and the ADR-0018-voided identifier grep go. |
| 32 | delivery-obligation.test.ts | 421 | 13 | K | ADR-0007 delivery obligation and its bound. Binding keep-list item. |
| 33 | dispatch-approval.test.ts | 490 | 17 | T→10 | Fail-closed dispatch gate stays (absent/reject/unavailable → refuse, deadline cannot wedge). |
| 34 | dispatcher-resume-reactivation.test.ts | 624 | 8 | T→4 | Keep resumed-generation reactivation and the fail-closed projection throw. |
| 35 | dispatcher-tools.test.ts | 633 | 21 | T→13 | Keep spawn→ledger link, unknown/foreign/already-linked refusals, deliver→todo completed, and the exact surface. |
| 36 | durable-roster.test.ts | 555 | 15 | K | ADR-0006 durability and unknown-state. Binding keep-list item. |
| 37 | feature-flag.test.ts | 402 | 17 | T→7 | Keep default-true, off-is-inert, freeze-after-apply, volatile-form, and one duplicate pin. |
| 38 | host-seam.test.ts | 260 | 9 | T→6 | Keep non-blocking spawn, settle-once, abort-drops-late-settle, unknown-state per-session hold. |
| 39 | inbox-core.test.ts | 420 | 11 | K | ADR-0023 inbox protocol. Binding keep-list item. |
| 40 | inbox-end-to-end.test.ts | 1137 | 9 | T→4 | Keep the invariants that need real fs: claim idempotence across restart, no-dispatcher hold, boot-rescan adopt. The rest is pipeline rehearsal duplicated by core+watcher units. |
| 41 | inbox-watcher.test.ts | 536 | 16 | T→11 | Keep queue resolution order, claim/reply/terminal writes, atomic write, scan loop survival. |
| 42 | liveness.test.ts | 355 | 20 | T→9 | Keep the three verdict classes, boundary equality, the never-stalled pins, and the tool-path end-to-end. |
| 43 | locale-preference.test.ts | 264 | 4 | T→2 | Keep EN fail-closed on every unreadable shape and the zh selection. |
| 44 | message-agent.test.ts | 729 | 26 | T→16 | Keep refusal fences (self, sibling, unknown, not-running), rate budget, provenance, and never-the-user-path. |
| 45 | microcompact.test.ts | 324 | 21 | T→10 | Keep trigger boundary, kept-N, eligibility, min-saving decline, cleared shape, determinism. |
| 46 | multi-dispatcher-peer.test.ts | 276 | 10 | K | Per-session peer isolation and priority lanes. |
| 47 | multi-dispatcher.test.ts | 768 | 12 | T→8 | Keep scoped-surface isolation (ADR-0019) and per-session teardown. Duplicate-registration block goes. |
| 48 | multitask-peer.test.ts | 351 | 15 | T→9 | Keep ack, idempotent re-send, envelope, and the worker barrier. Priority ordering duplicates wake-bus-peer. |
| 49 | peer-inbox.test.ts | 239 | 17 | K | Peer inbox caps and dedupe. Binding keep-list item. |
| 50 | plugin-microcompact.test.ts | 394 | 5 | T→3 | Keep field-off adds no listener, field-on adds exactly one and unload removes it. |
| 51 | plugin-scaffold.test.ts | 852 | 17 | K | The plugin boundary (contract, apply/dispose, teardown cancels timers). Hosts the single consolidated duplicate-registration pin. |
| 52 | policy-assembler.test.ts | 785 | 44 | T→14 | Keep the ticket-141 sha pin, tool names, flag-off-empty, section order, ZH structural parity, and the no-send_peer/loop-ban markers. Prose-shape and "covers the owner" tests go. |
| 53 | policy-peer-roster.test.ts | 418 | 25 | T→12 | Keep cap, prefix byte-stability, precedence, and malformed degradation. |
| 54 | policy-zh-assets.test.ts | 471 | 10 | T→5 | Keep structural parity (same steps, same bounds, same identifiers) and the no-CJK-in-EN pin. Prose comparison goes. |
| 55 | report-clamp.test.ts | 115 | 12 | T→5 | Keep both hard-cut bounds, the distinct error body, and the path-not-stripped trap. |
| 56 | resolve-command.test.ts | 429 | 16 | T→10 | Fail-closed resolve stays (refusals, wildcard fence, honest false resolve, no client-side resolution). |
| 57 | restart-honesty.test.ts | 1179 | 18 | T→12 | Keep rebuild-before-publish, once-per-activation, failure degradation, the three ticket-90 races, and aborted-no-report. Duplicate-registration and no-stop duplicates go. |
| 58 | review-posture.test.ts | 677 | 23 | T→14 | Keep the table, consent-beats-posture, fail-closed dispatch gate, wildcard fence, and session keying. |
| 59 | roster-snapshot.test.ts | 1116 | 33 | T→14 | Keep v2/v3 projection, parse fail-closed matrix (v1 reject), staleness boundary, key grammar, excerpt bounds, observer-on-transition. |
| 60 | session-kind-projection.test.ts | 451 | 16 | T→9 | Keep fold rules, legacy-name durability, per-session isolation, persisted-state round-trip and rejection. |
| 61 | settle-records.test.ts | 703 | 33 | T→16 | Keep ring bound/per-parent, settle-before-wait, timeout-still-running, gone, released, fifth-waiter refusal, and target validation. The public-method block duplicates the engine block. |
| 62 | shell-mirror-feed.test.ts | 193 | 10 | D | Mirror feed for a channel dsh 0.2.1 removed; no live publisher exists. |
| 63 | spawn-dispatcher-activation.test.ts | 2023 | 32 | T→16 | Keep mitosis activation, team-leader class, cold resume from the mark, generation, and the resume-coalesce lane. Repeated re-activation assertions collapse. |
| 64 | spawn-dispatcher-host.test.ts | 915 | 17 | T→9 | Keep the parallel top-level create (ADR-0032), announce shape, refusal propagation, and mark-write honesty. |
| 65 | spawn-dispatcher-tool.test.ts | 422 | 22 | T→11 | Keep the no-worker-path pins, refusal vocabulary, worker denial, and required args. |
| 66 | spawn-inflight-guard.test.ts | 148 | 5 | K | Duplicate-spawn guard keyed by (parent, stream key). |
| 67 | spawned-dispatcher-kind.test.ts | 592 | 12 | T→6 | Keep the pre-create seed, failed-spawn no-phantom, late binding, and the cold/unresolved honesty branches. |
| 68 | steer-command.test.ts | 599 | 18 | T→9 | Keep activation gate, parse, core last-wins delivery, and core refusal vocabulary. |
| 69 | steer-queue.test.ts | 207 | 10 | T→4 | The pure queue body mirrors `steer-queue.ts`. Keep the S3 delivery facts: context preserved, step-boundary resume, last-wins, refusal when not running. |
| 70 | stop-semantics.test.ts | 218 | 9 | T→6 | Keep wake disarm, late settle dropped, double-stop refusal, abort-before-start. |
| 71 | storage-json-v1-compat.test.ts | 417 | 4 | K | Version-1 store compatibility (restart reads old data). |
| 72 | todo-reconciler.test.ts | 670 | 18 | K | ADR-0007 ledger. Binding keep-list item. |
| 73 | tool-results.test.ts | 125 | 9 | T→4 | Keep the snake_case check-row wire shape, empty roster, and folded count. Elapsed/notes copy goes. |
| 74 | tool-schema-shape.test.ts | 227 | 5 | K | Provider-valid JSON Schema walk (an invalid schema makes the tool unusable). |
| 75 | wake-activity-digest.test.ts | 321 | 6 | D | Copy assembly over the ring; ordering and clamping are pinned by worker-activity-ring. |
| 76 | wake-bus-coalesce.test.ts | 317 | 8 | K | Coalescing. Binding keep-list item. |
| 77 | wake-bus-disposal.test.ts | 122 | 3 | K | Teardown cancels armed timers; no post-dispose delivery. |
| 78 | wake-bus-peer.test.ts | 499 | 20 | K | Ordering and preemption. Binding keep-list item. |
| 79 | wake-bus.test.ts | 427 | 17 | K | Ordering, hold, batching. Binding keep-list item. |
| 80 | worker-activity-ring.test.ts | 313 | 11 | T→5 | Keep the five-entry bound, per-worker independence, and clear. |
| 81 | worker-agent-type.test.ts | 368 | 24 | T→12 | Keep the barrier (deny intersection, no invented names, structural dispatcher coverage) and the contract's structural markers (heading order, request_access named once, no `{{`). |
| 82 | worker-ask-park.test.ts | 245 | 7 | K | Parked-tool fail-closed: timeout bound, stop wins, no wedge. |
| 83 | worker-composition.test.ts | 207 | 9 | T→6 | Keep the literal persona section, deny intersection with the CHILD scope, unknown-name omission. |
| 84 | worker-lifecycle-fsm.test.ts | 294 | 11 | T→6 | Keep the transition chain, terminal-is-stuck, second-settle ignored, early-turn handling. |
| 85 | worker-registry.test.ts | 382 | 13 | T→7 | Keep record fields, listing counts, terminal records queryable. Stream-key uniqueness duplicates spawn-inflight-guard. |
| 86 | worker-reply.test.ts | 535 | 19 | T→12 | Keep owning-dispatcher-only, not-the-report, bounds, rate, provenance, worker-only surface. |
| 87 | worker-stage.test.ts | 272 | 2 | K | The ticket-171 derivation table. Explicit keep-list item. |
| 88 | worker-wake-on-send.test.ts | 402 | 12 | K | Durable worker mark lifecycle and the dormant-steer fence. |
| — | **e2e-critical-path.test.ts (new)** | ~180 | 3 | NEW | The one end-to-end file: activate → spawn → settle → wake → deliver → todo completed. |

## Step 3 — the lean e2e

`test/e2e-critical-path.test.ts` (new). No existing file does the whole chain over the real
plugin `apply`: `plugin-scaffold` stops at registration, `composition-polish` stops at the
dormant matrix, `approval-feed-composition` was the closest but its subject was the client
mount. A new small file is cleaner than growing any of them.

It runs: real `apply()` → real `/dsh-bot` command → `spawn_worker` → host settle →
`requestDispatcherWakeup` → the dispatcher's `followup` → `deliver_result` → the todo is
`completed` and `delivered`.

## Coverage-loss register (filled as files are deleted)

| Deleted file | Behaviour that stops being covered | Why acceptable |
|---|---|---|
| approval-feed-composition.test.ts | The client mount wiring fed the real approval hub, and the client fiber detach path. | The mount and the hub are retained but unmounted machinery (ADR-0024): nothing composes them, so no shipped path can reach them. The host half of the chain (apply → activate → spawn → ask → resolve) is covered by the lean e2e and by access-relay/access-prompt. |
| approval-feed.test.ts | Wire→ticket mapping for the approval card feed, and the hub's replay-to-late-attacher. | The feed's only consumer (the approval pane) is unmounted. The wire shape it parsed is also pinned by roster-snapshot's parse matrix, which rejects a malformed snapshot instead of half-feeding. |
| await-agent.test.ts | The `await_agent` tool's own timeout/refusal wire copy, and its "registered in DISPATCHER_TOOL_NAMES order" assertion. | settle-records covers the same engine behaviour (settled/timeout/gone/released/fifth waiter) and tool-schema-shape covers the schema; the tool list is pinned in dispatcher-tools and spawn-dispatcher-tool. The worker barrier for the same tool is covered structurally in worker-agent-type. |
| client-approval-pane.test.ts | Approval card title/detail copy helpers and the pane seat CSS. | Unmounted pane (ADR-0024). |
| client-composer-send.test.ts | The composer's click/Enter send over the shell composition. | The shell composition is not mounted by `applyClientModule`. |
| client-conversation-surface.test.ts | Conversation reduction (turn ordering, tool-row pairing, streaming accumulation) and the pane's CSS/copy contract. | Unmounted pane. The reducer is a pure projection whose inputs come from a channel dsh 0.2.1 no longer serves. If the pane returns, its reducer tests return with it. |
| client-onboarding.test.ts | The onboarding beat walk, the seen-record fail-open decision, and the pane CSS. | Unmounted pane, and both suppression inputs (the seen record and the per-session mirrors) lost their live channel with the 0.2.1 settings change. |
| client-roster-panel.test.ts | The roster panel's section partitioning, presence dot precedence, and row detail copy. | Unmounted panel. The underlying FSM status vocabulary, the delivered/undelivered join, and the parse fail-closed matrix stay pinned in roster-snapshot. |
| client-shell-mount.test.ts | `mountShellPage`'s registration/collision records and its live-mount data path. | Retained, unmounted machinery; ADR-0024 keeps the code reversible but nothing calls it. |
| client-shell-seat-composition.test.ts | Shell seat composition across selection changes. | Unmounted shell. |
| client-wrapper-shell.test.ts | Wrapper shell store, presence aggregation, CSS and locale parity. | Unmounted wrapper shell (ADR-0024 withdrew the vehicle). |
| shell-mirror-feed.test.ts | Per-session mirror extraction and the "never replay the legacy whole-snapshot key" resurrection guard. | The settings channel that published these keys was removed in dsh 0.2.1; no publisher exists, so the guard has nothing to guard. |
| wake-activity-digest.test.ts | The wake followup's activity-digest assembly (per-worker lines, newest-first, omission when unobserved). | Ordering, the five-entry bound, and clamping are pinned in worker-activity-ring; the digest is a loop over `recentActivities`. |

### Behaviours that lost coverage in a TRIM (kept file, fewer tests)

| File | Behaviour that stops being covered | Why acceptable |
|---|---|---|
| policy-assembler | The literal phrasing of individual prompt bullets ("covers the owner's six rules" style needles) and the per-bullet ZH parity table. | Prompt text is no longer pinned word-by-word: the ticket keeps the load-bearing markers only — tool names, the sha pin, section order, EN/ZH shape and meaning parity, and the no-forbidden-identifier sweep. Prose churn is a model problem, not a test problem. |
| access-prompt | The exact design-template sentence, the per-access-class phrasing table, and the "no stored-secret notice for a tool ask" variant. | The wildcard fence, credential-names-never-values, deny-wins precedence, expired-answer honesty, and the seam-failure fallback all stay. Copy wording is checked by the ZH/EN parity sweep in the policy suites. |
| adapter-cordis-dsh-host | The activity-phrase derivation details (whitespace collapse, bare-name fallback, null-safety) and the peer tool/target feed's per-branch copy. | The ring itself (bound, eviction, clear) stays in worker-activity-ring, and the tool-call count still reaches `check_workers` in plugin-scaffold. The removed cases restated one small formatter. |
| approval-cards | The `locationFor` hook re-base detail and the "unsettled record projects no card" matrix. | The frozen card shape, the wildcard option drop, replay-safety, secret-kind naming, and unfed-is-unknown stay. The "no card" rule is the default branch of the projection and is exercised by the settled-card case. |
| client-toolviews | The 12 hostile-props fixtures no longer run as 12×9 separate tests. | They run as one per-tool case each (9 total), asserting the same "never throws, always a valid model" invariant over every fixture. No assertion was dropped; only the test-count multiplication was. |
| settle-records | The public `Multitask.awaitWorker` block that duplicated the engine block case-for-case. | The engine block covers settled/timeout/gone/released/fifth-waiter; the public method keeps the default-timeout case, the two target refusals, the dispatcher refusal, and the fifth-waiter refusal. The `gone` outcome is now a single dedicated test. |
| spawn-dispatcher-activation | The per-generation matrix (generations 2/3/9 asserting the same text) and the double-resume re-assertions. | Generation-independence is pinned once in policy-assembler for both classes and both languages; the mark-row generation round-trip stays here. |
| restart-honesty | The three "no stop affordance" view-model swipes (roster panel field, toolview render data, shell-era field). | The plugin registers no stop/cancel command, which is the assertion that can actually fail; the view-model swipes were checking unmounted surfaces for an absent field. |
| inbox-end-to-end | The malformed-line `console.warn`, the two-dispatcher routing case, the same-process re-presentation case, and the delivery-after-disable case. | The disk invariants stay (claim idempotence across restart, claimed-no-dispatcher hold, boot-rescan adopt, off switch). Malformed-line handling is pinned in inbox-watcher; routing and re-presentation are core behaviours pinned in inbox-core. This also removes the ticket-162 flake's most timing-sensitive members. |

## Comments

- 2026-11-03 (agent): filed, classification written for all 88 files before any deletion.
- 2026-11-03 (agent): deletions done, trims done, lean e2e added. 88 → 76 files,
  50,807 → 33,479 lines, 1,696 → 846 tests. Five consecutive full-suite runs green.
  Typecheck clean. No `src/` change.
- 2026-11-03 (agent): two things worth flagging for the owner.
  1. **Kept deliberately, would not delete:** `test/inbox-end-to-end.test.ts` still holds the
     only coverage of the ADR-0023 disk invariants (claim idempotence across a restart, a
     claimed-no-dispatcher hold, boot-rescan adopt). Its flakiness is ticket 162's problem,
     not coverage's.
  2. **Trimmed below the ticket's own plan in two places**: `adapter-racoons-mount` went
     10 → 4 rather than 4 with the config-mapping test replaced by a comment, because that
     test asserted a vendored-library behaviour change rather than ours; and
     `client-toolviews`' 12×9 degradation matrix collapsed into 9 per-tool cases (one `it`
     each) instead of being deleted, since "never throws on hostile props" is the guard that
     keeps a malformed tool result from breaking a chat row.

### 2026-11-04 — PM closure

Already satisfied before this pass ran. The aggressive prune the owner asked for shipped in
`643a801`, which executed this ticket's whole plan (88 -> 76 files, 1,696 -> 846 tests) while
landing other work. Later commits took the suite to its current **70 files / 31,937 lines /
802 tests**. The "Before numbers" table here describes a repository that no longer exists and
its classification table lists files other tickets deleted.

Re-audited against the live suite: no remaining file clearly meets deletion class (a) mirror,
(b) duplicate, or (c) dead behaviour. Nothing was deleted in this pass.

Full suite green: 802 tests, 0 fail. All three typecheck configs clean.
