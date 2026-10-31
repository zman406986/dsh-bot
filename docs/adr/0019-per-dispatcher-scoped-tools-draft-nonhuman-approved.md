# Per-dispatcher tool scoping: each dispatcher's tools register in its own agent scope; the process-global singleton retires

**Status:** draft (non-human-approved) — agent-drafted 2026-09-19 (ticket 72), pending human sign-off. **2026-10-28 note (0032):** strengthened, not in conflict — a summoned dispatcher is a real top-level session (ADR-0032), so the per-dispatcher scoping recorded here now applies to a genuine top-level session with its own scope, rather than to a subagent child compensating for a missing one. Its `setup` seam is what composes those scoped tools.

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0019, the first free number (0010–0012 remain reserved to design-17 §9's ADR plan; 0013–0015 capsule; 0016 retracted; 0017–0018 filed). Resolves ADR-0018's verification item ("Per-dispatcher sessions need one seam verification before design work") with the survey recorded in `docs/research/dsh-tool-scoping-seam.md` (update 2026-09-19).

## Decision

Multiple dispatchers are real (ADR-0018). Each dispatcher session gets **its own tool surface and its own keyed state**, in two layers:

1. **Tool visibility — host-scoped registration.** At activation, the five dispatcher tools register through the **activated Agent's own scoped context** (`agent.ctx.tools.register(…)`), not the plugin-level `ctx.tools`. The host resolves model-facing tool visibility per agent scope (survey evidence: `dsh-agent-loop/lib/index.js:761-763` mints a scope per agent loop; `dsh-agent/lib/index.js:258-264` passes `scope: agent` to prompt assembly; `dsh-tools/lib/index.js:2609,2773-2781` resolve and register through the calling ctx's scope tag). Each dispatcher therefore sees only its own surface; a second dispatcher's tools never leak into the first; and worker children never see dispatcher tools at all — their scope chains run to preset standing compositions (`dsh-agent-presets/lib/index.js:1504,1538,1702`), never to a delegating chat's loop scope, so the ADR-0018 conformances (workers are leaves; workers never see dispatcher tools) become **host-structural** instead of gate-enforced. `request_access` alone stays a global registration: its callers are workers.
2. **State keying — session-keyed superset (single dispatcher = map of one).** Every place that assumes one dispatcher session today becomes keyed by dispatcher session id. Nothing is deleted that the single-dispatcher case needs: one live dispatcher behaves exactly as shipped.

The plugin-level **singleton is retired**: the one-slot `activationTools` registration (`src/plugin.ts`), the single `dispatcherSessionId()` slot in the lifecycle binder (`src/adapter/parent-agent.ts`), the single-session compare in `gatedExecute` (`src/adapter/dispatcher-tools.ts`), and the host's single bound parent (`src/adapter/cordis-dsh-host.ts`) all generalize to per-session registries. The execute-time gate's refusal copy (`DISPATCHER_TOOL_GATE_REFUSAL`) is retired with them — under scoped visibility an out-of-scope caller gets the host's `UNKNOWN_TOOL`, which is the strictly stronger behavior; no new refusal surface is invented.

## Context

- ADR-0018 ruled multiple dispatchers real and named this exact verification item; the survey (research note, update 2026-09-19, installed `@deepseek-ai/*` 0.1.5-rc.2) verified the host-side seam end to end. No new host seam is requested or added — `tools.register` is the same API addressed through the host's own per-agent scope, a usage the host's error copy itself prescribes ("requires a scoped context (agent.ctx)", `dsh-tools/lib/index.js:2792`).
- Today's single-session construction (evidence in the research note's §Evidence): one process-wide registration on the plugin ctx, one activation slot, one-session execute gate, one host parent.
- The core is already `parentSessionId`-keyed: workers, todos, wake bus (`Map<string, SessionWakeState>`), relay pending, durability markers, and the roster projection all take the session id. Multi-dispatcher is mostly an **adapter and policy-table** generalization, not a core rewrite.
- Model-authored `stream_key` (`dispatch_worker` arg, `src/core/tools.ts:230`) collides across dispatchers in the one global `liveByStreamKey` map — two dispatchers whose models both pick `"build"` would refuse each other's spawns.

## The keying design (what changes, surface by surface)

| Surface | Today (one session) | Generalized (map of sessions) |
|---|---|---|
| Tool registration | Plugin-level `ctx.tools.register`, one `activationTools` slot, registered on first activation only | Per activation: register through the activated agent's scoped ctx; disposers held **per session**; session end (host fiber) or our deactivation unregisters that session's set. `request_access` stays global |
| Execute gate | `gatedExecute` compares caller to the one `dispatcherSessionId()` | **Retired.** Handlers close over their own session id; out-of-scope callers cannot see the tool (host `UNKNOWN_TOOL`) |
| Activation lifecycle | One `dispatcherSessionId` slot; `already-active-elsewhere` refusal | Per-session registry (`Map<sessionId, {agent, disposers}>`); `agent/disposed` deactivates only that session; the `already-active-elsewhere` refusal copy retires (two chats may both be dispatchers); `already-active-here` and `not-top-level` stay |
| Host parent | One `parent` slot; spawn/interrupt/send all use it | Per-session parent map. Spawn already records `parentSessionId` per worker — interrupt/sendMessage resolve the authority agent from the worker's recorded parent, `requestDispatcherWakeup` is already id-parameterized |
| Worker registry / stream keys | One global `liveByStreamKey` | Keyed by `(parentSessionId, streamKey)` — stream_key is model-authored per dispatcher, so the uniqueness domain is the dispatcher session |
| Access policy rows | `scope: "session"` rows, `clearSession()` wipes all | Session rows gain the owning session; deactivate/unload clears **only that session's** rows (the global wipe would erase a sibling dispatcher's "always allow") |
| Roster snapshot | One publish slot, gated `lifecycle.dispatcherSessionId() === sessionId`; single `roster` settings key | Publish per changed session (no single-active gate); snapshots keyed per session under the plugin namespace. The client read-side (panel showing multiple dispatchers) belongs to the wrapper-UI epic (tickets 27/28/65/66) — this ADR only fixes the data path |
| Access prompt pump | `isActive`/`listPending` against the one session | Per-session pending lists; prompts sync per session; a session's deactivation abandons only its own outstanding prompts (relay timeouts still deny, ADR-0008) |
| recentActivity / lastActivityAtMs / recentResult | Keyed by workerId (globally unique child session ids) | No change — already correct under many dispatchers |
| Wake bus / todos / durability / steer / liveness | Keyed by `parentSessionId` / workerId | No change — already session-keyed |
| Restart rebuild | One `rebuildFromDurability(sessionId)` gated on the single active id | Per activated session, each gated on its own session still being live (the existing `dispatcherSessionId !== sessionId` check becomes per-session liveness) |

Per-session **Multitask instances were considered and rejected**: the core's state is already keyed by `parentSessionId`, so a second instance would fork the wake bus and host subscriptions for no behavioral gain. One Multitask, keyed throughout.

## Fidelity check (ADR-0018 bar)

- Workers stay leaves and never see dispatcher tools: now host-structural (scope-chain inheritance reaches only preset standing compositions), matching the reference's exclusion of management tools from worker runs. The existing spawn-time `toolFilter` deny list is unchanged and still enforced.
- No new exception-list item is created: no new wake kind (C15), no persisted identities (C13), no runtime agent management (U-G) — the five tools keep their names, schemas, copy, and semantics; only where they are visible and which state they route to changes.
- Single-dispatcher behavior is a strict subset (map of one): same registration moment, same activation command, same policy inject, same wake and delivery paths.

## Consequences

- The adapter's structural interfaces grow honestly: `AgentLike` gains an optional scoped-tools accessor (structural, no cordis type import); `ToolsLike.register` is reused as-is through it. `inject` does not change.
- Registration lifetime rides the agent scope fiber: session end or HMR auto-unregisters that session's tools; our deactivation path calls the disposers and must tolerate already-inert ones (the host's undo is idempotent).
- Verified against installed `@deepseek-ai/*` **0.1.5-rc.2**; dsh is a developer preview with explicit breaking-change risk — re-verify the scope seam at integration (implementation ticket).
- Offline tests (S8, FakeHost) pin the multi-session properties: a second dispatcher's tools do not appear in the first's surface; gating is structural (per-session routing, unknown sessions refused); stream keys collide only within a session; deactivating one session clears only its policy rows and prompts; roster publishes are per session. Live two-dispatcher verification belongs to the live lane (tickets 45/33 chain).
- Implementation is its own ticket (repo rule): **ticket 76**.
