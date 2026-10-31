# 163 — Four implementation defects found by the ticket-157 review

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing. Each defect is real and measured; none is fixed.
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

- [ ] A cold-resumed summoned dispatcher produces the next generation number its durable row implies, proven by a test that seeds a mark with a known generation, resumes parentless, summons, and asserts the child's recorded generation.
- [ ] A summon from a session with no `cwd` either fails loudly with a stated reason or produces a peer that can cold-resume. It must not silently create an unresumable session.
- [ ] `resumedUserDispatchers` cannot suppress a legitimate re-activation: after a session is disposed and re-announced in the same process, it regains its scoped tools and policy, and a test covers it.
- [ ] `ctx.sessionController` is read through one guarded accessor used by every caller, and a deployment without the service degrades to the parent route instead of throwing. A test asserts the no-service path.

## Constraints

- Offline only; every item is provable with unit tests over the existing stubs.
- Do not re-open ADR-0032's settled decisions.
- Do not fold these into ticket 157; that ticket records the change as it landed.
- Item 1 changes no prompt text today, so it is safe to fix independently of the policy question.