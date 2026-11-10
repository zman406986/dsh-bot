# 296 — The dispatcher policy is lost after host compaction and never returns

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Severity:** P1 / high — once a dispatcher session is compacted, every later turn runs without its session policy.
**Ship blocker:** yes — the policy is the dispatcher's whole contract; losing it mid-session makes a long-running bot behave like a stock chat.
**Blocked by:** nothing.
**Origin:** 2026-11-10 verification pass against the installed host's compaction implementation and our own activation path.
**Related:** 119 (policy/PRD/context barrier), 124 (compaction boundary marker), ADR-0005 (policy fixed for a session's lifetime), ADR-0029 (compaction boundary).

## Problem

The dispatcher policy is injected as **one user-role message** when a session is activated. Nothing puts it back afterwards.

- The inject is `bindActivation` in `src/adapter/parent-agent.ts` (lines 977–1005), built by `pluginContextMessage` (lines 36–48) and sent through `tryInject` (lines 51–64). The comment at line 977 records ADR-0005: the policy is fixed for this session's lifetime.
- The existing dedupe, `transcriptCarriesPolicy` (`src/adapter/parent-agent.ts` lines 288–319), guards re-activation only. It is never consulted by the turn loop.
- dsh reassembles the system prompt every step, but host compaction's range starts at the **first non-system node** (`dsh-compaction-basic/lib/index.js` line 415; doc at lines 403–404). The system head survives; our user-role policy message is inside the compacted range and is replaced by the summary checkpoint.
- Microcompaction is not the culprit: it only prunes tool results (`src/core/microcompact.ts` line 238), so the policy node survives a prune.

Result: a long dispatcher session that crosses the host's compaction threshold comes back with a summary of itself and **no policy**, for the rest of the session. Every turn after that is a stock chat with our tools still registered — the worst of both shapes.

## Why the existing dedupe cannot simply be reused

`policyNodeSurvives` (`src/adapter/parent-agent.ts` lines 146–160) answers "could anything after this node have removed it?" It returns false **permanently** once a `compaction/*` event has a seq above the first matching policy node. Reusing it as a per-turn probe would therefore inject the policy on every succeeding turn, forever: a duplicate block per turn instead of zero. The probe must ask "is the policy on the LIVE surface now?", not "did a compaction ever happen?".

## Decision: probe the live surface, re-inject when absent

1. **Surface probe.** Walk `agent.session.surface.nodes` (the host's `SessionSurface`, `dsh-session/lib/types/surface.d.ts`) and read each node with `session.eventAt(seq)`. A node proves the policy is present only when it is a committed `user/message` from this producer (`WAKE_SOURCE_KIND`) whose text equals the exact policy bytes. No seq arithmetic, no compaction history, no permanent false.
2. **Per-turn check, before the reminder.** In the bound-dispatcher branch of the `agent/status` listener (`src/adapter/parent-agent.ts` lines 819–857), on `status === "running"`, inject the policy first when the probe says absent and no matching copy is already queued (lines 823–846), then the turn reminder, so the reminder stays the newest tail.
3. **Compaction boundary listener.** `ctx` does expose `session/event` (see `src/adapter/cordis-dsh-host.ts` lines 2716–2766, which already listens there), and the host emits `compaction/end` (`dsh-compaction/lib/types/types.d.ts` lines 71–75). So we listen for `compaction/end` and inject immediately for a **bound dispatcher session only**; the per-turn probe remains the fallback. No invented event.
4. **Byte-identical text.** Re-inject the same call activation makes: `assembleSessionPolicy(true, origins.get(id) ?? "user", spawnGenerations.get(id) ?? 1, policyLanguage)`.
5. **Never workers.** The probe and the compaction listener only reach sessions in the lifecycle's `sessions` map. The worker path in the same listener (lines 885–895) and `src/worker/preset.ts` are untouched.

The no-duplicate property is structural: a successful inject is committed by the loop as a producer `user/message` on the surface, so the next probe sees it and skips. A copy that was only QUEUED (activation or a boundary) is not visible to the probe until the step's inbox drain, which happens after the running edge; the `policyInjectInFlight` mark stops that window from queuing a second identical block. The unreadable-surface case stays fail-open at activation (as today) but does not add a per-turn duplicate: with no surface seam the per-turn probe is skipped and the pre-296 activation behavior stands.

## Implementation (2026-11-10)

- The probe is `policyOnLiveSurface` in `src/adapter/parent-agent.ts` lines 321–385: walk `agent.session.surface.nodes`, `eventAt` each node, accept only a committed producer `user/message` whose joined text equals the policy bytes. `"absent"` on a readable surface, `"unknown"` when the seam is missing or throwing.
- The exact bytes come from `policyBytes` (`src/adapter/parent-agent.ts` lines 714–729), the same call activation makes; activation now prefers the surface probe and keeps `transcriptCarriesPolicy` as the fallback when the surface is unreadable (lines 990–1004).
- The boundary listener is `ctx.on("session/event")` (`src/adapter/parent-agent.ts` lines 899–931), gated on `compaction/end`, `policyEnabled`, and membership in the bound `sessions` map, with the same in-flight marker so a second boundary in one turn cannot queue a duplicate.
- **No-duplicate property:** the host loop commits an inject as a producer `user/message` surface node, so the next probe returns `"present"`; the tests commit injected messages in the fake session and prove the count.

## Acceptance criteria

- [x] A dispatcher surface after compaction (system head + checkpoint user message, policy gone) gets **exactly one** policy inject, byte-equal to `assembleSessionPolicy(true, "user", 1, "en")`.
- [x] While the policy is present on the surface, two consecutive turns produce **zero** policy injects (no duplicate).
- [x] Two consecutive turns after compaction produce **exactly one** policy inject in total — the regression this ticket exists for.
- [x] A spawned-origin dispatcher re-injects the spawned wording with its stored generation, byte-equal to `assembleSessionPolicy(true, "spawned", N, "en")`.
- [x] A worker session receives no policy inject on `agent/status` running.
- [x] A microcompact prune of tool results leaves the policy node on the surface: zero policy injects.
- [x] A `compaction/end` `session/event` triggers the prompt re-inject for a bound dispatcher session only.
- [x] A policy copy queued at activation but not yet committed is not duplicated by the first turn's probe.
- [x] Existing activation tests stay green; the worker persona in `src/worker/preset.ts` is unchanged.

## Constraints

- No host edit, patch, or vendored change.
- Do not weaken `transcriptCarriesPolicy`; activation keeps using it as the fallback when the surface is unreadable.
- Do not inject into a session that is not an activated dispatcher. The worker branch of the listener stays byte-identical.
- The probe reads state; it must never mutate the session log.

## Comments

2026-11-10: Filed from the verification lane. Evidence read against the installed host and this tree, not carried over from a research note. Implementation and tests follow in the same ticket.

2026-11-10: Implemented and proven. `test/adapter-policy-inject.test.ts` — 20 tests, 20 pass, 0 fail (9 new in the ticket-296 suite; the 11 pre-existing activation/roster/label tests stayed green). `test/adapter-cordis-dsh-host.test.ts` — 92 tests, 92 pass, 0 fail, because the change touches the `agent/status` turn branch. `tsc --noEmit -p tsconfig.json` is clean, and the test file was also typechecked narrowly under the same strict flags. No full suite, e2e, or build was run: the team leader serialises the final build.

2026-11-10: The empirical question behind this ticket is now written up as a durable research note: [docs/research/dsh-policy-after-compaction.md](../../docs/research/dsh-policy-after-compaction.md). It records the re-checked host lines (system prompt assembled every step; compaction range starting at the first non-system node, replaced by a user-role checkpoint), the role asymmetry that caused the loss in the first place (the policy is one user-role message, the worker contract is a system-prompt section), why microcompact was never in this path, and the residual uncertainty that keeps this ticket open: no live session has been compacted end-to-end.

### 2026-11-10 — resolved

A dispatcher that gets compacted now gets its policy back — same bytes, before the next turn runs, once.

**What changed**

- Surface probe `policyOnLiveSurface` (`src/adapter/parent-agent.ts:366-393`): reads `agent.session.surface.nodes`, `eventAt` each one, and answers `"present"` only for a committed producer `user/message` whose joined text equals the policy bytes; `"absent"` on a readable surface without it; `"unknown"` when the seam is missing or throws. No seq arithmetic and no compaction history, so it cannot go permanently false the way `policyNodeSurvives` does.
- Exact bytes from `policyBytes(sessionId)` (`src/adapter/parent-agent.ts:768`) — the same call activation makes.
- Per-turn re-inject in the bound-dispatcher `agent/status` running branch, before the turn reminder (`src/adapter/parent-agent.ts:874-891`), so the reminder stays the newest tail.
- In-flight guard `policyInjectInFlight` (`src/adapter/parent-agent.ts:758`): set when activation queues a copy (`:1049`) or a boundary does (`:974`), cleared when the probe sees the copy committed (`:880`, `:968`) and at turn end (`:925`). That is what stops a queued-but-not-yet-drained copy from being queued a second time.
- Compaction boundary listener `ctx.on("session/event")`, gated on `compaction/end` + `policyEnabled` + membership in the bound `sessions` map (`src/adapter/parent-agent.ts:952-977`). The worker branch of the same listener and `src/worker/preset.ts` are unchanged.
- Activation dedupe now prefers the surface probe and keeps `transcriptCarriesPolicy` as the fallback only when the surface is unreadable (`src/adapter/parent-agent.ts:1029-1051`).

**Commands and exact results (run in this close-out pass)**

- `test/adapter-policy-inject.test.ts` → 20 tests, 20 pass, 0 fail; the 9 ticket-296 cases start at `:617` (one inject after compaction, byte-identical; zero while the policy is present; exactly one across two post-compaction turns; spawned wording with the stored generation; a worker session gets none on `agent/status` or `compaction/end`; a microcompact prune keeps the node; an activation-queued copy is not duplicated; `compaction/end` re-injects once; `compaction/end` with the policy present injects nothing).
- `test/adapter-cordis-dsh-host.test.ts` 97/97, `test/activation-lifecycle.test.ts` 10/10, `test/composition-polish.test.ts` 8/8 — both dormant listener pins were moved 6 → 7 for the new `session/event` listener and now pass.
- `npm run build` exit 0; `npm run build:client` exit 0; `npm test` 1325 tests, 1325 pass, 0 fail, 370 suites; `npm run lint:docs` clean, exit 0.
- `npm run e2e` (reported by the team lead, not re-run here): s1/s2/s4 pass; s3 fails on a pre-existing stale harness regex, now ticket 297 — unrelated to these diffs.

**Verified vs inferred**

- Verified: the probe's answer for a present, absent, or unreadable surface; one inject after compaction; no duplicate while present; the in-flight guard; worker exclusion. All of it against a fake event-sourced session that commits injected messages the way the host loop does.
- Inferred: that a real dsh session behaves the same — that the host emits `compaction/end` after the surface replacement and that the loop commits an inject as a producer `user/message` surface node. Both rest on installed host types and docs (`dsh-compaction/lib/types/types.d.ts:71-75`, the `dsh-session` surface planner) and are written up in `docs/research/dsh-policy-after-compaction.md`.

**Residual risks**

- No live session has been compacted end-to-end in this repo; this closes the defect on unit evidence plus host-type reading, not on an observed compaction.
- The no-duplicate property depends on the host committing the inject as a producer `user/message`. A host that committed it under another `source.kind` would make the probe answer `"absent"` each turn and re-inject once per turn — bounded to one block per turn by the in-flight marker, but not zero.
- The boundary keys on `compaction/end` alone; a renamed event silently falls back to the per-turn probe, which is still correct, only one turn later.
- One surface walk per turn start on an activated dispatcher (small, bounded by surface size).