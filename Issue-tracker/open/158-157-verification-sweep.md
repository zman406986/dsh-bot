# 158 — Ticket 157 verification sweep: unverified test edits, full suite re-run, live restart check

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing — all source work from ticket 157 is in the tree and typechecks; this ticket is the verification lane that ticket 157 could not finish.
**Origin:** owner ruling 2026-10-29 — stop work, do not test further, file any pending verification as a ticket for the next team.
**Related:** ticket 157 (the implementation, still `open`), ADR-0032, ADR-0025 (decisions 1–5 stand), `.scratch/repo-analysis/2026-10-28-summon-parallel-session-plan.md` (§10 transport), `.scratch/repo-analysis/2026-10-28-repo-subagent-assumptions.md`.

## Problem

Ticket 157's implementation landed in the working tree, **uncommitted**, and the project typechecks clean (`npx tsc -p tsconfig.json --noEmit` → exit 0). Verification did not finish. Two test files carry edits that were **written but never run**, so nobody knows whether they pass — and one of them was left half-edited after an agent was stopped mid-task.

Nothing here is merged or committed. That is deliberate: the owner stopped work before the lane was green.

## What is verified

- `npx tsc -p tsconfig.json --noEmit` → exit 0, confirmed repeatedly against the final tree.
- `test/spawn-dispatcher-host.test.ts` → 16 pass, 0 fail — **before** the new ordering test was added (`:377-460`, unrun).
- `test/client-toolviews.test.ts` + restart-honesty + shell-seat-composition → 179 pass, 0 fail.
- `policy-assembler` + `policy-zh-assets` + `policy-peer-roster` → 79 pass, 0 fail.
- `test/dispatcher-resume-reactivation.test.ts` → 8 pass, 0 fail.
- `test/adapter-cordis-dsh-host.test.ts` + `test/adapter-dispatcher-tools.test.ts` → 84 pass; `test/message-agent.test.ts` → 26 pass.
- `node tools/doc-lint.mjs` → 0 findings (run before ticket 158 existed; the ADR-0032 index row is in place).

## What is NOT verified — the work this ticket owns

### 1. `test/spawn-dispatcher-activation.test.ts` is half-reasoned and unrun
Last **observed** run, taken before the most recent edits: **32 tests, 21 pass, 11 fail.** Edits made afterwards were never re-run. They claimed to fix:
- the `resumeTarget` stub (`:315`) — a durably marked session now resumes parentless at depth 0, an unmarked worker still parented at parentDepth+1;
- five ticket-130/138/141 cold-resume and legacy-row tests, re-based to top-level and to the host's real boot order (activate a user chat first, which warms the mark mirror);
- the worker-hop test (`:879`) — 1 `startActivation`, parent depth 0, `maxDepth` 1;
- the recursion test (`:929`) — a dispatcher hop is not a delegation hop;
- the identity probe (`:1167`) — no origin, null parent, depth 0, `resolveSessionKind` → `"normal"`.

No test was deleted. **Do not assume any of this passes.** Note the reported failure mode at that time was `TypeError: Cannot read properties of undefined (reading 'content')` at `textOf` (`:74`) — an assertion reading a message the stub never delivered.

### 2. One new test is written but never run
`test/spawn-dispatcher-host.test.ts:377-460` —
`setup composes, never drives: a wake parked for the child flushes after create, never inside setup`.
It asserts: zero turns driven inside `setup`; exactly 2 followups (spawn prompt first, then the wake turn with `source.kind === "agent-message"`); and the trace `["park","create","setup","published","followup","followup"]`.
Two flagged risks for its first run: it reassigns `ctx.agents.create` (the stub type may be non-optional), and it pushes onto `ctx.events`; neither is compiler-checked yet. A known gap, already stated by its author: the stub never fires `agent/created` with a *parented* header, so the listener-driven flush path is covered only by the explicit post-create flush, not by the event path.

### 3. No full-suite run has happened since the change
Suites were only ever run one file at a time. **~19 suites and ~450 cases** touch this area (the estimate in `.scratch/repo-analysis/2026-10-28-repo-subagent-assumptions.md`: ~120 need re-reasoning, ~330 are fixture/comment/copy). Several were never touched at all and may still pin the subagent shape — e.g. `test/spawned-dispatcher-kind.test.ts`, `test/session-kind-projection.test.ts`, `test/client-session-kind.test.ts` (partially updated), `test/coexistence.test.ts`, `test/activation-lifecycle.test.ts`, `test/worker-composition.test.ts`, `test/plugin-scaffold.test.ts`.

### 4. Client bundle is not rebuilt
The tool-row fix (`adaptToolviewProps`, `src/client/toolviews.ts:613`) is a **client** change. The running GUI still shows "Tool call details are unavailable." until the client bundle is rebuilt and the page refreshed at `http://127.0.0.1:3080`. Nobody has confirmed the fix in the actual UI — unit tests only.

### 5. One live check that static reading could not settle
On a cold restart, does `peekDispatcherMark(id)` answer **before** the first `agent/created`? `resumeUserStartedDispatcher` (`src/adapter/cordis-dsh-host.ts`, now ends with `flushPendingWakeTurn`) reads raw projection state via `stateOf`, which does **not** re-ask the probe. If the store is still opening, the cell answers `"unknown"`, the session reads as "not a dispatcher", and it never re-activates.
Settling it needs one live restart with a summoned dispatcher and a log of the mark answer at that first `agent/created`. **If it answers `"unknown"`, the fix is a probe re-ask in `sessionKindOf`, not a change to the mirror.** Read `read-before-running-live-and-browser-tests.md` first; kill timers are mandatory at launch.

## Acceptance

- [ ] `test/spawn-dispatcher-activation.test.ts` runs green, or every remaining failure is re-reasoned/deleted with a stated reason. No number re-pinning to make it pass.
- [ ] The new ordering test in `test/spawn-dispatcher-host.test.ts` runs green, with any stub-type fixups it needs.
- [ ] Full offline suite run covers every suite in §3 and any other suite pinning the subagent shape; failures are triaged, not deleted silently.
- [ ] `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` both exit 0.
- [ ] Client bundle rebuilt; the running GUI at `http://127.0.0.1:3080` shows tool-call arguments and results instead of "Tool call details are unavailable." after a page refresh. Confirmed by eye on at least one `spawn_dispatcher` call.
- [ ] Live restart check (read the live-test guide first, kill timer at launch): a summoned dispatcher survives restart and re-activates. The mark answer at the first `agent/created` is recorded either way.
- [ ] Ticket 157 is annotated with what this sweep proved, and closed only when all of the above are true.

## Constraints

- **No merge, no commit.** The owner stopped work before that decision; committing is theirs.
- The existing uncommitted diff is the whole change — do not "clean it up" by reverting hunks to make a test pass.
- Offline first (S8). The only live work permitted is the two items that cannot be settled statically (§4 rebuild+refresh, §5 restart), and only under `read-before-running-live-and-browser-tests.md`.
- Do not re-open settled decisions: top-level creation, no parent/origin/depth, no cap of ours, cold resume in v1, uniform policy for every dispatcher, no `"spawned"` policy variant. ADR-0032 records them.
- Unrelated `"spawned"` string literals must stay: approval outcome kinds (`src/client/approval-cards.ts`, `approval-pane.tsx`) and worker FSM status (`src/core/types.ts`, `worker-fsm.ts`). Only the dispatcher-origin member was retired.

## Comments

2026-10-30: Partial progress before the owner stopped work; the rest stays
with the next team. Done and observed green in one grouped run:

- `npm run typecheck` → exit 0; `npm run build` → exit 0 (lib rebuilt
  2026-10-29 19:04); `npm run build:client` → exit 0, and
  `node --import tsx scripts/build-client.ts --check` → exit 0 with
  `client/index.js` fresh (180783 bytes, sha256 `b8079c32…`). §4's rebuild
  half is therefore satisfied; the by-eye UI confirmation is not.
- Grouped run `test/spawn-dispatcher-activation.test.ts`,
  `spawn-dispatcher-host.test.ts`, `spawn-dispatcher-tool.test.ts`,
  `spawned-dispatcher-kind.test.ts`, `plugin-scaffold.test.ts` →
  **100 tests, 15 suites, 100 pass, 0 fail, exit 0.** That covers §1's file
  and §2's ordering test as of this tree. It does **not** establish the full
  suite (§3): no whole-suite run has happened.

Still owed, all of it: the full-suite sweep in §3, the by-eye UI check in
§4, and the §5 live restart probe with its kill timer. Note the observed
root cause of the incident this ticket grew out of: the running process was
loading a `lib/` build older than `src/`, so lib-level "fix is present"
checks were green while the live app kept the old behaviour. Re-check the
`lib` timestamp against `src` before trusting any live result.
