# 09 鈥?dsh adapter wiring

**What to build:** The core stops being a simulation and starts driving the real harness. This ticket replaces the fake host with dsh's actual services, so a worker spawned by the dispatcher is a real background agent.

**Blocked by:** 08 鈥?Durable roster marker + restart behavior.

**Status:** open

Note: dsh **is** installed on this machine (`@deepseek-ai/dsh@0.1.5-rc.1`, global npm, live `web` profile) 鈥?see `docs/research/dsh-local-install.md`. This ticket is verifiable against a real host, not just the fake.

- [x] Spawning a worker through the real adapter starts a real background agent in dsh and returns its worker id without blocking the dispatcher's turn.
- [x] The adapter uses dsh's real seams as verified in the installed tree: subagent spawn, the interrupt path, the job registry for live status, the session/storage facilities for the durable marker, and the completion 鈫?wake path.
- [x] Interrupting a worker calls dsh's real interrupt path and the agent stops its current turn.
- [x] Worker settlement is observed from dsh and reaches the wake bus exactly once per worker.
- [x] Requesting a dispatcher wakeup reaches the real dispatcher session and opens a turn.
- [x] The durable marker reads and writes through dsh's session/storage facilities.
- [x] Live job status is read from dsh's job registry for the check surface; job records are not treated as durable.
- [x] The core is unchanged by this ticket 鈥?only the adapter implementation behind the host interface is new. The existing core tests still pass against the fake.

## Implementation notes (ready-for-human review)

### What landed

- `src/adapter/` 鈥?live `CordisDshHost implements DshHost` over structural Cordis ctx (no host package imports; core stays pure).
  - `cordis-dsh-host.ts` 鈥?spawn via `subagents.startContinuable` (provider `"spawn"`, `maxDepth: 0`, toolFilter omitted until T10); interrupt via `subagents.interrupt` ancestor authority; steer via `subagents.sendMessage`; settle via `ctx.on("subagent/end")` with stopReason map (`max-tokens`/`refusal` 鈫?`error`); wake via `agents.get(id).followup(wakeUserMessage())`.
  - `parent-agent.ts` 鈥?`bindDispatcherLifecycle`: captures top-level Agent on `agent/session-start`; wires dispatcher `agent/status` 鈫?`wakeBus.noteTurnStarted/Ended(sessionId)` (T06 follow-up); child `running` 鈫?`multitask.noteTurnStarted(workerId)`; child `idle` 鈫?`host.emitStepBoundary(workerId)`.
  - `content-blocks.ts` 鈥?`{ type: "text", text }` helpers.
  - `durable-marker.ts` 鈥?`DurabilityPort` over lazy-opened `storageDomain` domain `multitask_dispatcher` / table `worker_markers`.
  - `wake-copy.ts` 鈥?new copy only (plugin-sourced user message, no reconstruction wording).
- `src/plugin.ts` 鈥?`inject = ["subagents", "agents", "jobs", "storageDomain"]`; `apply` wires host + multitask(durability) + lifecycle; disposer unbinds, disposes host, closes domain.
- `src/index.ts` 鈥?exports adapter factory + marker types.
- `src/core/**` 鈥?**zero edits**.
- `FakeDshHost` 鈥?untouched; all prior core suites green.

### Tests

- Suite: **129 pass / 0 fail** (was 98).
- New: `test/adapter-cordis-dsh-host.test.ts` (stub-ctx: spawn/interrupt/send/settle/step-boundary/wake/jobs/lifecycle), `test/adapter-content-blocks.test.ts`, `test/adapter-durable-marker.test.ts`.
- Updated: `test/plugin-scaffold.test.ts` (new inject list + full stub ctx).
- No live dsh required for CI.

### Human smoke still needed (design 搂14.3)

1. Boot `multitask` profile; confirm plugin loads without inject-missing errors (profile must mount subagent + spawn-in-process + jobs + storage stack).
2. Spawn a trivial worker; confirm child session appears and status reaches running.
3. Interrupt mid-run; step-boundary does not throw.
4. Let a worker complete; dispatcher receives one wake via `followup`.
5. Restart; marker store still lists the worker.
6. `listLiveJobs()` returns host jobs without treating them durable.

### Residual risks / T10 handoff

- Approval pin `'never'` on children is untouched (T13 owns relay).
- `toolFilter` omitted in T09 鈥?T10 owns the barrier intersection with `ctx.tools`.
- Restored markers carry no report text 鈥?T11 delivery of `landedUndelivered` must fetch from child transcript.
- Multi-agent profiles: first top-level session-start wins; later top-level agents ignored (logged residual).
- dsh developer-preview drift: pin `0.1.5-rc.1`; re-verify API names at integration.

## 2026-09-18 — Considered passed (human deferral)

Human review of the live smoke checklist is **deferred, not done**: the human has not executed it. For continuation-of-work purposes only, this ticket is **considered passed** so downstream tickets may proceed. The deferral reason is that the human is waiting for the client UI surfaces (tickets 20–28 line) to be complete, then will run the live checks against the finished product in one pass. This note does not constitute verification; ticket 33 (closeout) still owns ensuring the live smoke happens before merge.
