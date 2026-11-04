# 163 — Four implementation defects found by the ticket-157 review

**Status:** resolved
**Labels:** needs-triage
**Blocked by:** nothing. All four defects were real and are fixed — see Comments (2026-11-04).
**Origin:** independent review of ticket 157 by the release-prep session, 2026-10-29. Reported, not repaired: the owner had ruled that the change lands as-is and remaining work becomes tickets.
**Related:** ticket 157 (the change that introduced them), ADR-0032, `src/adapter/cordis-dsh-host.ts`, `src/adapter/parent-agent.ts`.

## Problem

Four defects in the ticket-157 code. A fifth finding — the policy text contradicting itself — is a design question, not a bug, and is recorded as an open ADR question instead (ADR-0032 §Open questions item 1).

### 1. A cold-resumed summoned dispatcher loses its generation

Measured by probe, not inferred. A generation-3 grandchild carries 3 on its mark row. After a parentless cold resume, a summon from it is recorded as generation **2** — it should be 4. A legacy pre-141 row likewise produces 2 where it should be 3.

Seam: `onUserDispatcherResumed` calls `lifecycle.activate(agent)` with no `generation`; `parent-agent.ts` defaults to 1; the host's `spawnerGeneration = dispatcherGenerationOf?.(…) ?? 1` reads only the lifecycle, never the `dispatcherGenerations` mirror that `refreshDispatcherMarks` had already filled from the durable row. So `mark.generation ?? 2` is honoured on the parented resume path but not on the parentless one that ADR-0032 now routes summoned dispatchers through.

Impact today is bookkeeping only — the number no longer reaches any prompt — but the wrong number lands on the *next* spawn's row.

### 2. `meta.cwd` is omitted when the summoner has none

`cordis-dsh-host.ts:2518` builds `meta: summonerCwd === undefined ? {} : { cwd: String(summonerCwd) }`. Ticket 157's acceptance says `cwd` is required because `resolveAgent` refuses a session with no `cwd`. When the summoner has none, the peer is created as a session that can never be cold-resumed.

### 3. `resumedUserDispatchers` is never cleared

`cordis-dsh-host.ts:1130` documents "never cleared for the process lifetime". It is also burned at create time for a freshly summoned session: after `setup` activates it, `agent/created` takes the parentless branch and calls `resumeUserStartedDispatcher` again. That call is refused as `already-active-here`, and the wake is flushed twice (benign, id-keyed). A later same-process re-announcement after disposal will skip re-activation entirely and leave the session without its scoped tools or policy.

### 4. `ctx.sessionController` is read outside any `try`

`cordis-dsh-host.ts:988` does `return ctx.sessionController;` after a guarded `ctx.get`. This repo documents that exact read as throwing on a live cordis context, and wraps it for that reason at `session-kind-projection.ts:583-588`. `sendMessage` calls it unguarded (`:2620`), so a deployment without the service throws instead of degrading to the parent route.

## Acceptance

- [x] A cold-resumed summoned dispatcher produces the next generation number its durable row implies, proven by a test that seeds a mark with a known generation, resumes parentless, summons, and asserts the child's recorded generation.
- [x] A summon from a session with no `cwd` either fails loudly with a stated reason or produces a peer that can cold-resume. It must not silently create an unresumable session.
- [x] `resumedUserDispatchers` cannot suppress a legitimate re-activation: after a session is disposed and re-announced in the same process, it regains its scoped tools and policy, and a test covers it.
- [x] `ctx.sessionController` is read through one guarded accessor used by every caller, and a deployment without the service degrades to the parent route instead of throwing. A test asserts the no-service path.

## Constraints

- Offline only; every item is provable with unit tests over the existing stubs.
- Do not re-open ADR-0032's settled decisions.
- Do not fold these into ticket 157; that ticket records the change as it landed.
- Item 1 changes no prompt text today, so it is safe to fix independently of the policy question.

## Comments

2026-11-04: All four defects fixed in `src/adapter/cordis-dsh-host.ts`. Every fix has a test that was verified to FAIL against the pre-fix code and pass after (each fix was reverted in place, the suite re-run, then restored). Offline only; no live dsh run. Suites: `test/spawn-dispatcher-host.test.ts`, `test/spawn-dispatcher-activation.test.ts`, `test/dispatcher-resume-reactivation.test.ts` — 50 tests, 50 pass, 0 fail. `npx tsc -p tsconfig.json --noEmit` exits 0.

### 1. Cold-resumed summoned dispatcher loses its generation — REAL, fixed

Confirmed in the reviewed code: `spawnDispatcher` read `dispatcherGenerationOf?.(…) ?? 1` only, and `dispatcherGenerationOf` goes to `lifecycle.dispatcherGeneration`, which returns the number stored at activation. `resumeUserStartedDispatcher` calls `onUserDispatcherResumed(agent, sessionId, origin)` with no generation, and the plugin's hook calls `lifecycle.activate(agent, { origin })`, so `parent-agent.ts` defaults it to 1. The durable row that `refreshDispatcherMarks` had already mirrored was never consulted.

Fix: the spawn path now reads `dispatcherGenerations.get(opts.parentSessionId) ?? dispatcherGenerationOf?.(…) ?? 1` — the durable mirror first, the lifecycle seam as fallback. Both are filled from the same row; the mirror is additionally seeded by every in-process spawn before its child exists, so it cannot be stale for a live child.

**Reachability finding (recorded, not a defect):** the ticket's exact measured shape — a generation-3 *grandchild* summoning — is no longer reachable. Ticket 176 (owner ruling 2026-11-03) refuses a summon from any session whose class resolves `"spawned"`, and `dispatcherClassForSummon` returns `"spawned"` for every generation ≥ 2. The root cause is identical one level up, so the fix stands on its own; the pinning test drives the spawner-generation expression through a user-class session whose mirror entry says 3, which asserts the child is recorded as 4 rather than 2.

### 2. `meta.cwd` omitted when the summoner has none — REAL, fixed by refusing

Confirmed at the reviewed line: `meta: summonerCwd === undefined ? {} : { cwd: String(summonerCwd) }`. A create with `{}` produces a session with no `cwd`, which `resolveAgent` refuses, so the peer exists and is unreachable after a restart.

Fix: **fails loudly**, which the acceptance criteria permit. `spawnDispatcher` refuses before any session is created, with a `CordisDshHost:`-prefixed error naming the cause ("has no cwd … could never be cold-resumed"), the fact that nothing was created, and the remedy ("start the summoning chat in a directory and summon again"). Empty string is refused too. Chosen over inventing a directory: a guessed path creates the session in the *wrong* place, which is worse than refusing. `meta` at the create site is now unconditionally `{ cwd: summonerCwd }`, since the refusal proved it is a non-empty string.

### 3. `resumedUserDispatchers` is never cleared — REAL, fixed

Confirmed at the reviewed line: the set was documented "Never cleared for the process lifetime" and had no delete anywhere.

Fix: a new `agent/disposed` listener deletes the session's entry, and `dispose()` now clears the set with the rest of the host state. `agent/disposed` is the event that ends an activation, so it is the event that ends the deduplication record. `pendingWakeTurns` is deliberately NOT cleared there — a parked wake is a delivery obligation the next announcement discharges.

Test: activate → dispose → re-announce in the same process restores the 9 scoped tools and exactly one policy inject. A companion test proves the guard's real job survives: a repeat announcement with no disposure still activates once.

### 4. `ctx.sessionController` read outside any `try` — REAL, fixed

Confirmed at the reviewed line: `return ctx.sessionController;` sat after the guarded `ctx.get`, outside any `try`. `session-kind-projection.ts:674-679` already guards the identical read for the identical reason.

Fix: the declared-seam read is wrapped in `try`/`catch`, returning `undefined` — the same "no facade" answer as an absent service. All three callers (`resumeDormantDispatcher`, `requestDormantWorkerWake`, `sendMessage`) already resolve through this one accessor, so guarding here covers every one.

Tests: a host whose `sessionController` property read throws reaches the parent route and refuses with its own stated error instead of propagating the cordis throw; a second test proves a facade reachable through `ctx.get` is still preferred.

### Test rewritten because it pinned the bug

`test/spawn-dispatcher-activation.test.ts` asserted `assert.deepEqual(Object.keys(call.meta), [])` — it pinned the *empty* `meta` of defect 2. Rewritten to assert the key set is exactly `["cwd"]` with the summoner's own directory. The suite's agent factory now gives every stub a default `cwd`, because a summoner without one is now (correctly) refused; the refusal case lives in the host suite, whose stub can omit it.

### Files

`src/adapter/cordis-dsh-host.ts`, `test/spawn-dispatcher-host.test.ts`, `test/spawn-dispatcher-activation.test.ts`, `test/dispatcher-resume-reactivation.test.ts`. No other file touched.
