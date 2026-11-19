# Behavior fixes without RACOONS — Implementation Plan

**Goal:** Repair only confirmed tickets 301, 299, 303, 304 and 300, retaining stock worker behavior and all concurrent work.

**Architecture:** Keep the stock worker tools and host authority boundary. Add the smallest integration corrections at the existing audit/ticket regression seams; keep inbox filesystem behavior adapter-owned and keep restart history separate from current hold state.

**Tech stack:** TypeScript, Cordis/dsh host integration, Node test runner with tsx, existing in-memory host fixtures and private filesystem fixtures. No network or inference.

**Execution:** One regression → observed red → smallest green → independent review per slice. The user already approved these seams and this scope. This plan does not authorize commits, staging, new worktrees, helpers or another design-approval round. No test or product mutation has been performed by the plan writer.

## 1. Scope, baseline and authority

- Verified cwd: C:/Users/TZ/Desktop/dsh-bot. Baseline HEAD: c0d79d9. Recheck status and current file contents before taking a mutation baton; do not restore/rewrite an existing patch.
- Preserve eight pre-existing tracked modifications: [activation command](<../../src/adapter/activation-command.ts>), [adapter exports](<../../src/adapter/index.ts>), [package exports](<../../src/index.ts>), [activation tests](<../../test/activation-lifecycle.test.ts>), [host-adapter tests](<../../test/adapter-cordis-dsh-host.test.ts>), [coexistence tests](<../../test/coexistence.test.ts>), [composition tests](<../../test/composition-polish.test.ts>) and [open index](<../../Issue-tracker/open-issue-index.md>). Preserve all existing/untracked scratch and ticket work too.
- Explicitly excluded: 302, RACOONS integration, microcompact, vendor trees, generated build/client outputs, reference tree, configs/profiles, global installs, restart/stop, live model/API calls, legal audit, commits/staging/push. Read-only no-emit checks may consume existing dependency declarations, but must not build vendor outputs.
- Binding order: current human instructions > accepted ADRs > amended PRD; drafts are not owner rulings; research is evidence, not policy. See [rulebook:32–55](<../agents-rulebook.md#L32-L55>) and [audit](<../research/behavior-audit-2026-11-18.md>).
- Root [AGENTS.md:3](<../../AGENTS.md#L3>) empty-repository claim is stale. Its old completion/legal-gate wording also yields to the amended [PRD:118–185](<../../PRD-dsh-multitask-dispatcher.md#L118-L185>) and recorded rulings. No guidance cleanup is part of this work.
- [ADR-0035](<../adr/0035-spawn-model-option.md>) is unsigned: its never-refuse/fallback recommendation does not override stock model-selection authorization. [ADR-0012](<../adr/0012-restart-replays-durability-never-work-draft-nonhuman-approved.md>) is also a draft and contains older wake-trigger prose; ticket 300 pins today's first-real-user-message gate. Preserve that gate rather than broadening recovery behavior.

## 2. Mutation batons

| Shared area | Owner order | Guard |
|---|---|---|
| [host adapter](<../../src/adapter/cordis-dsh-host.ts>), [core](<../../src/core/multitask.ts>) and worker identity contracts | 301 → 299 if needed | 299 re-read the finished 301 diff; no competing host/core edits |
| [plugin composition](<../../src/plugin.ts>) | 301 → 304 → 300 | 299 joins this same baton if its supported bridge needs plugin wiring |
| [inbox watcher](<../../src/adapter/inbox-watcher.ts>) and watcher-only regressions | 303 independent lane | Do not take plugin ownership merely to fix reader eligibility |
| [restart copy](<../../src/adapter/restart-notice.ts>), restart fixtures | 300 | Preserve unrelated activation patches |
| Tests | Each ticket owns its named regression; coordinate before touching a shared fixture | No wholesale fixture rewrite or scratch-proof replacement |
| This plan, ticket closure and index coordination | Parent/coordinating writer | Re-read any concurrent additions before a targeted documentation edit |

Source workers must settle the exact 301 run-identity representation and 299 supported pre-authorization bridge. The paths below are bounded candidates from the current tickets, not a second source diagnosis or permission for a sweep. The plan is usable before those two decisions return; update their provisional notes only, not the acceptance contract.

## 3. Ticket 301 — same-session continuation is a new execution

Contract: [301:55–62](<../../Issue-tracker/open/301-stock-worker-continuation-keeps-prior-terminal-accounting.md#L55-L62>), [PRD:154](<../../PRD-dsh-multitask-dispatcher.md#L154>), [ADR-0006:25–28](<../adr/0006-worker-record-durability-split.md#L25-L28>), [ADR-0007:29–31](<../adr/0007-todo-stays-dispatcher-only-with-structural-worker-link.md#L29-L31>).

Seam: real stock send_message cold resume through Runtime/manager/AgentLoop and product host/core binding. Completed → delivered → disposed → distinct real Agent with the same session id → second settlement. A repeated adoption callback alone is insufficient.

Candidate mutations: [stock adoption tests](<../../test/stock-worker-adoption.test.ts>), host adapter, core, plugin wiring, and only identity/durable contracts identified by the 301 source worker.

1. Add one behavioral regression adapted from the existing audit proof, asserting verified current ownership/projection/recovery identity while the second Agent runs; then its distinct second result is recorded once.
2. Run the focused regression; capture the stale terminal-accounting failure, with two raw settles and successful stock second-result delivery as controls.
3. Apply the smallest verified activation/run-identity propagation. A new agent/created announcement or reusable session id alone is not sufficient evidence of a new run. Keep terminal FSM rules intact.
4. Run green; add one delayed/duplicate-old-run event slice, then the minimal guard needed. Preserve abort/stop guards and within-run deduplication.
5. Independent review must confirm the old delivered todo and old terminal history are unchanged, the new obligation/accounting identity is explicit, and no duplicate parent notice appears.

**Source-worker handoff (via parent):** native start/end events carry runId; use that activation identity rather than inventing an event-announcement heuristic. Exact propagation/accounting shape remains the 301 worker's implementation detail. A fresh in_progress todo is NOT mandated; do not blindly retain that scratch-proof assumption. Do not solve this by clearing all tombstones or reopening the old obligation.

## 4. Ticket 299 — stored default reaches stock selection before authorization

Contract: [299:63–70](<../../Issue-tracker/open/299-stored-worker-model-default-bypassed-by-stock-spawn.md#L63-L70>). Precedence: explicit worker route → this leader's stored worker default → ordinary host inheritance. The leader's own route must remain unchanged.

Seam: real registered stock subagent → Runtime → manager → descriptor/agents.create, stopped before inference. The retained custom spawnWorker unit seam cannot establish this fix.

Candidate mutations: host adapter after 301's baton, optionally plugin wiring under its baton, plus a focused active-stock regression (new test file if fixture separation is smaller). Existing [model-option tests](<../../test/model-option.test.ts>) are controls, not the sole regression.

1. Add the omitted-route A-leader/B-default case at the active stock seam; observe descriptor and child-creation inputs selecting A (red).
2. Supply the resolved stored default at the supported child-option merge BEFORE final-route authorization and preflight; observe B (green).
3. One slice each: explicit C wins; no stored default inherits; multiple later workers use B; restored dispatcher mark still supplies B.
4. Add unauthorized/unavailable B controls: final selected route must go through stock authority/preflight and explicit-route errors remain normal. Do not silently bypass policy or mutate route in agent/created after validation.
5. Independent review checks selection timing, restoration and descriptor truth, not model-response identity or billing.

**Provisional:** supported pre-authorization seam awaits the source worker. Do not promise draft ADR-0035 fallback semantics for the active stock tool. If no supported bridge exists, report the concrete result to the parent; deliberate removal/deprecation of worker_model and its README/tool/policy promise is the ticket's alternative but is a material feature loss, not an automatic implementation fallback.

## 5. Ticket 303 — bounded progress past orphan locks

Contract: [303:72–78](<../../Issue-tracker/open/303-orphan-claim-lock-prefix-starves-later-inbox-jobs.md#L72-L78>), accepted [ADR-0023:19–23](<../adr/0023-file-driven-external-intake.md#L19-L23>).

Seam: real readInboxQueue/startInboxWatcher scans and exclusive filesystem claim in private fixtures. Candidate mutations: inbox watcher and [watcher tests](<../../test/inbox-watcher.test.ts>); use [safety tests](<../../test/inbox-safety.test.ts>) as controls.

1. Add limit=1 orphan-lock prefix + healthy following job; run repeated deterministic scans and observe starvation (red).
2. Make reader eligibility skip demonstrably locked candidates without filling the resolved-entry quota; retain bounded work/pagination if needed. The exclusive wx claim remains the final authority under races. Never delete/take over an unknown/other consumer's lock.
3. Run green, then add the production-default 50-prefix case as the next red→green slice. Assert healthy presentation once across repeated scans.
4. Preserve normal claimed-status skipping, claim races, terminal-file protections and bounded queue reads. Do not turn the cap into an unbounded scan.
5. Independent review checks both thresholds and verifies that progress is not lock theft. In-flight stop/quiescence is an accepted separate limitation, not this ticket.

## 6. Ticket 304 — durable inbox identity survives path casing

Contract: [304:66–71](<../../Issue-tracker/open/304-windows-inbox-rescan-changes-job-identity.md#L66-L71>).

Seam: real queue helpers accept/claim job-1 resolving to canonical Job-1; the actual plugin activation rescan presents a checkpoint seeded in the real claim callback's shape. Candidate mutation: plugin under 301 → 304 → 300 baton; regression in new test/inbox-rescan-identity.test.ts, retaining [inbox end-to-end tests](<../../test/inbox-end-to-end.test.ts>) as controls.

1. Add the Windows-capable real-helper/activation regression; await storage completion, observe two checkpoint identities (red).
2. Prefer the checkpoint's recorded/decoded durable job id for presentation; canonical path serves containment, not identity (green).
3. Assert one checkpoint key and original id in wake/todo. Add encoded-key, matching-case, terminal disk-state and containment controls at their existing seams.
4. Independent review rejects blanket lowercasing or collapsing distinct valid ids. Do not claim duplicate worker execution/full reply failure was reproduced.

## 7. Ticket 300 — historical report, current post-sweep hold guidance

Contract: [300:60–73](<../../Issue-tracker/open/300-restart-notice-claims-swept-stream-is-still-held.md#L60-L73>).

Seam: actual plugin restart fixture → awaited rebuild/sweep → first real user message → one visible notice. Candidate mutations: plugin after 304, restart copy, [restart honesty tests](<../../test/restart-honesty.test.ts>); [hold-sweep tests](<../../test/restart-hold-sweep.test.ts>) remain controls.

1. Add bare-marker case; verify actual marker absent/hold count 0 after sweep, then observe false current held/refused warning (red).
2. Build present-state guidance after the awaited sweep from ACTUAL remaining session holds while preserving the ORIGINAL rebuild report as history (green). Do not merely subtract swept counts or erase historical unknown workers.
3. Add wake-backed retained-hold control and skipped/error-preserved holds as applicable: truthful current warning must remain. Historical count/ids/transcript refs stay intact.
4. Preserve exactly-once and first-user-message gating, activation-generation guards and no automatic turn. Change no hold-release, wake/durability or recovery policy.
5. Independent review checks semantics against real remaining holds; standalone string tests are insufficient. This is a copy defect, not a hold leak or spawn-refusal fix.

## 8. Test execution and final validation

Do not run tests in the planning phase. At implementation time use direct executables, never npm test, npm run typecheck, npm run build, prepare or pretest: [package scripts:50–63](<../../package.json#L50-L63>) invoke vendor builds.

Focused direct command template (replace the path with the owning ticket's actual regression file):

    node --import tsx --test --test-timeout=15000 test/stock-worker-adoption.test.ts

Existing realistic 301/299 audit reproductions remain starting fixtures; port them without replacing actual activation/selection logic. Keep bounded hard timers for real AgentLoop fixture runs. Capture exact red and green commands/results; an exit-code/tool-launch error is not a behavioral red. Parent reported Node/Git available and pwsh ENOENT in its execution lane; use available direct execution rather than changing machine configuration.

After all source batons land and independent reviews finish, perform grouped validation ONCE:

1. Run the agreed non-RACOONS source-test manifest directly with tsx/Node (include all five regressions and relevant identity/durability/inbox/restart controls; exclude vendor/integration/microcompact suites). Final manifest is owned by the coordinating validation lane, not inferred from the package wildcard.
2. Run no-emit checks directly: node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit; repeat for tsconfig.client.json and tsconfig.test.json. Do not compile vendor projects or emit artifacts. Do not resolve a concurrently broken declaration/build by regenerating excluded outputs; report the exact check limitation.
3. Only the existing mock harness may be considered; its package e2e wrapper invokes freshness/client checks and is not automatically safe. Reuse an approved source/no-output mock route, no RACOONS, no live model or replacement server. If unavailable, state mock verification not run rather than build excluded outputs.
4. Compare working tree against the initial eight dirty paths and other concurrent additions. No broad cleanup, reformat, rollback or generated outputs.

## 9. Closure / evidence

Per [tracker conventions:17–22](<../../Issue-tracker/issue-tracker.md#L17-L22>), append dated comments to each ticket with exact red/green and independent-review evidence and bounded limitations. Only after verification, set Status: resolved and move the same filename from open/ to resolved/ (inspect the absolute destination first). Preserve existing discussion; do not combine or renumber tickets. This is ordinary bug work, not the special Wayfinder claimed/map workflow.

[Open index](<../../Issue-tracker/open-issue-index.md>) is generated by tools/issue-index.mjs and already concurrently modified; never hand-edit it. Coordinate index ownership with the parent; under the current generated-output exclusion this worker neither regenerates it nor treats its stale state as permission to expand scope. No commits/staging/push. If a ticket is not verified, leave it open and state the remaining condition.
