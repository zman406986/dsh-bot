# DD-122 — Per-turn provider routing vs host-owned inference
- **Area:** inference routing & streaming (A15)
- **Type:** deliberate-divergence (architecture)
- **Date:** 2026-09-23

## What the reference does
The reference routes every dispatched turn to one of four inference backends — a provider enumeration naming four inference backends, chosen per turn from the settings store. The reference tree's `source/node-agent-coordinator/inference-router.ts` reads the configured provider at dispatch time and splits two ways: when the provider is the native backend the router answers a not-handled result and lets the native session run the turn; for the three direct backends the router executes the turn itself — appending the user prompt to the agent transcript, streaming a completion, and appending the assistant entry. The executors live in the reference tree's `source/host/extensions/inference/` (`inference-service.ts`, `provider-session.ts`): the first direct backend talks straight to the ChatGPT backend over SSE with its own OAuth token refresh (`codex-direct-responses.ts`), the second runs through an agent-SDK query with a routed MCP tool bridge, and the third streams via the ai-sdk. Each executor carries its own forced system prompt, its own tool wiring, and its own step limit, so the four backends behave as four parallel turn-runners behind one router.

## What the current build does
The build has no such layer, on purpose: the plugin never runs inference of any kind. The only path a turn can take is the host's own agent loop, reached by spawning blank background workers through the `DshHost` interface (`spawnWorker` / `sendMessage` / `followup` in `src/core/dsh-host.ts`). The concrete spawn hand-off (`src/adapter/cordis-dsh-host.ts:617-688`) builds a request containing only the task prompt, the worker contract in `persona`, a `toolFilter`, and a delegation-depth ceiling, then starts the child via the host's subagent service. A grep across `src/core` and `src/adapter` finds no provider setting, no model identifier, and no per-provider executor — the only "provider" strings are the spawn-source label, JSON-Schema serialization comments, and the unrelated Cordis settings service. Workers inherit whatever model the host child session is configured to run; the dispatcher can choose a worker's prompt, tools, and depth, but never its model.

## The deviation
The reference treats backend choice as a per-turn runtime decision owned by the agent framework, with four self-contained executor stacks (each with its own prompt forcing, tools, and step budget). The build collapses that whole axis: one backend, owned by the host, with the plugin reduced to shaping workers (persona/toolFilter/maxDepth). There is no integration point in the build onto which the reference's provider choice could even map — a spawn request has no model or provider field — so this is a structural absence, not a missing setting.

## Verdict: DO-NOT-INCORPORATE
The PRD's non-goals explicitly exclude rebuilding or hosting inference runtime; the plugin's contract is to delegate to host workers, and ADR-0008 deliberately routes credentials through `SpawnOptions.credentialNames` rather than giving the plugin any inference-facing surface. Model choice belongs to the host child session configuration, so absorbing the reference's four-backend router would reverse a settled scope decision, not fill a gap. If multi-backend choice is ever wanted, it is a host-side product change requiring a human ruling, which is why this stands as deliberate divergence.

## Incorporation notes
- **Where it would live:** nowhere in the plugin today. Hypothetically a per-worker model knob would extend `SpawnOptions` in `src/core/dsh-host.ts` and the request built at `src/adapter/cordis-dsh-host.ts:660-679`, with the host child session resolving the actual model — the executor stacks of the reference have no counterpart to extend.
- **Constraints:** the host owns the agent loop end to end; credentials flow only via `SpawnOptions.credentialNames` (ADR-0008); no plugin-side inference (PRD non-goals); the controllable worker surface stays `persona` / `toolFilter` / `maxDepth` unless a new ADR widens it.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — multi-backend routing means host-side model-routing support plus per-provider executors the PRD excludes; high scope risk, not a coding risk.
- **Key reference anchors:**
  - the reference tree's `source/node-agent-coordinator/inference-router.ts` — provider read per dispatch; unhandled return for the native session; execute path for the three direct backends.
  - the reference tree's `source/host/extensions/inference/provider-session.ts` — the routed-executor entry shared by the router.
  - the reference tree's `source/host/extensions/inference/inference-service.ts` — service wiring for the executors.
  - the reference tree's `source/host/extensions/inference/codex-direct-responses.ts` — backend SSE with OAuth refresh; example of per-executor prompt/tool/step ownership.

## Evidence
- Reference: the reference tree's `source/node-agent-coordinator/inference-router.ts`; the reference tree's `source/host/extensions/inference/inference-service.ts`; the reference tree's `source/host/extensions/inference/provider-session.ts`; the reference tree's `source/host/extensions/inference/codex-direct-responses.ts`
- Build: `src/core/dsh-host.ts`; `src/adapter/cordis-dsh-host.ts:617-688` (spawn path, no provider/model field); `src/adapter/index.ts` (exports, no inference symbols)
