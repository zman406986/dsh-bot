# 75 — Wire noteToolCall into the real tool-call path so tool_call_count is populated

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 61 (worker liveness signal — the consumer of the count), 29 (session/event firehose live-verification — the observation source)

## Finding (from ticket 61's implementation)

`tool_call_count` — used by the ticket-61 liveness derivation — has **no production caller**. The core's `noteToolCall` (`src/core/multitask.ts:640`, declared on the port at `:153`) is exercised **only by tests** (`test/liveness.test.ts`, `test/worker-registry.test.ts`, `test/dispatcher-tools.test.ts`); nothing in `src/` or `src/adapter/` invokes it outside test wiring. In production the count is therefore always 0/absent, and the liveness derivation is defensive about it: `src/core/liveness.ts:92-97` falls back through `toolCallCount > 0 ? null : startedAtMs`, and with the count permanently 0 a worker with no observed activity timestamp is measured from `startedAtMs` instead of going honestly `quiet` on an unknown advancement reference.

## Why it matters

- The liveness verdict's `active`/`stalled` honesty leans on the count **defensively**: the "counted calls > 0 but advancement moment unobserved → quiet, never guess" branch (liveness.ts:78-83, 95-97) can never fire in production, because the count never advances. The branch is dead code in the real wiring, and its intended safety property (don't claim `stalled` from an unknown reference) is unreachable.
- Roster snapshots, the check-row panel (`src/client/panel.tsx:128`), and `check_workers` output (`src/core/tool-results.ts:111`) all surface a count that is structurally stuck at 0 — misleading telemetry presented as real.

## Suggested fix location

The observation point already exists: the host `session/event` firehose subscription in `src/adapter/cordis-dsh-host.ts:433-446` (the ticket-29 subscription) already matches every `tool/call` event (line 437), resolves the owning worker (lines 440-441), and records the activity phrase + `atMs` (line 444) — the exact moment a tool call is observed. Extend that handler (or the host port it feeds, near `recentActivity`/`lastActivityAtMs`, `cordis-dsh-host.ts:487-499`) to propagate the increment to the core's existing `noteToolCall`. No new seam, no polling, no change to the five-tool surface (ticket 61 R5 stands).

## Acceptance criteria

- [ ] A production caller exists: a real (non-test) `tool/call` observation path invokes `noteToolCall` so `WorkerSummary.toolCallCount` advances in live wiring.
- [ ] A test proves the count advances on a fake tool call — e.g. driving the `session/event` handler with a synthetic `tool/call` event for an owned worker increments the count visible in the roster snapshot / `check_workers` output.
- [ ] The liveness derivation either no longer needs its count-based defensive branch, or keeps it with a comment stating it is now reachable (which of the two is fine; do not silently change `stalled` semantics for workers with no observed activity — that behaviour change is the point of the ticket and must be covered by tests).
- [ ] Offline unit tests only (S8); no network, no LLM, no running dsh.
