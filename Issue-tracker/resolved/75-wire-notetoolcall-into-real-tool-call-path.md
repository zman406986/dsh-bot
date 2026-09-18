# 75 — Wire noteToolCall into the real tool-call path so tool_call_count is populated

**Status:** resolved
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

- [x] A production caller exists: a real (non-test) `tool/call` observation path invokes `noteToolCall` so `WorkerSummary.toolCallCount` advances in live wiring. — `CordisDshHost.onWorkerToolCall` (src/adapter/cordis-dsh-host.ts) fires from the existing ticket-29 `session/event` handler for every owned `tool/call`; `src/plugin.ts` subscribes it to `multitask.noteToolCall` (the `host.onAccessRequest`-style plugin glue).
- [x] A test proves the count advances on a fake tool call — e.g. driving the `session/event` handler with a synthetic `tool/call` event for an owned worker increments the count visible in the roster snapshot / `check_workers` output. — `test/plugin-scaffold.test.ts` "a firehose tool/call advances the count check_workers shows (ticket 75)": end-to-end through `apply()` → activate → spawn_worker → two synthetic firehose events → `check_workers` row shows `tool_call_count: 2` (unowned/non-tool deliveries don't move it) and `liveness: "active"`.
- [x] The liveness derivation either no longer needs its count-based defensive branch, or keeps it with a comment stating it is now reachable (which of the two is fine; do not silently change `stalled` semantics for workers with no observed activity — that behaviour change is the point of the ticket and must be covered by tests). — Branch kept; `src/core/liveness.ts` comments now state it is production-reachable since ticket 75; `test/adapter-cordis-dsh-host.test.ts` "wired to the core, the count advances and the unknown-reference liveness state becomes reachable" pins the flip at the same `nowMs`: count 0 + no timestamp → `stalled`, advanced count + no timestamp → `quiet`.
- [x] Offline unit tests only (S8); no network, no LLM, no running dsh. — Fake/stub hosts only (`createStubCtx`, `FakeDshHost`); full suite 807/807 pass with no network.

## Closing comment (2026-09-19)

Done in one commit ("Ticket 75: wire noteToolCall into the session/event tool-call path"). Shape of the fix: rather than widening the core `DshHost` port, the adapter host gained `onWorkerToolCall(cb)` next to `lastActivityAtMs` — the ticket's suggested location — and the existing `session/event` handler notifies it for every owned `tool/call`, unconditionally (an unreadable payload still counts as a call; only the activity phrase is readability-gated, so the count can advance with no observation timestamp, which is exactly the now-reachable unknown-reference state). `dispose()` clears the subscriber list. Friction: minor — the new adapter-level flip test initially spawned through the core without a bound parent (host refuses pre-activation spawn) and was fixed by binding one; no ownership-resolution gaps were found for any covered event shape, so nothing was left unimplemented.
