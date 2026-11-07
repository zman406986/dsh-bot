# Opt-in model choice for summoned team leaders and workers

**Status:** draft (non-human-approved) — agent-drafted 2026-11-08 from the implementation plan; the plan's open questions are still for the owner, so this records the recommended shape rather than a human ruling.

**Numbering:** 0035, the first free number at filing (2026-11-08; highest in use was accepted 0034). Implementation is ticket 285; the detailed contract, algorithm, file list, and test plan live in `.scratch/model-arg/PLAN.md`.

## Context

Both spawn tools take no model argument. A summoned team leader is a real top-level session (ADR-0032) and inherits the summoning dispatcher's live route; each worker it spawns inherits the leader's route. The only ways to change that today are a model directive inside the handoff prompt — model-authored text that would need parsing, validation, and stripping — or switching a live session's model before spawning, which changes the caller's own route and cannot differ per worker.

The host already supports per-child routes: a leader can be created with `agentOptions` on `ctx.agents.create`, and the in-process subagent provider advertises `agentOptions` support for worker activation. The missing piece is a validated choice at spawn time.

## Decision

1. **Optional tool parameters, not prompt directives.** `spawn_worker` gains `model`; `spawn_dispatcher` gains `model` and `worker_model`. Omitted means today's behaviour. `worker_model` is only on `spawn_dispatcher`: a team leader cannot summon another dispatcher, so it chooses each worker with `spawn_worker.model` or lets its inherited default apply.

2. **Value syntax.** `provider/model-id` is preferred; a bare model id is accepted only when it resolves to exactly one catalog model. Provider and model are matched against the live catalog, exact first and case-insensitively second; the catalog's canonical spelling is stored. Whitespace is trimmed and empty means omitted. The model part may contain slashes: the longest registered provider prefix is tried first, then the whole string as a bare id. A bare id found under several providers prefers the spawning session's provider. No display-name aliases, no `default`/`inherit` sentinel, and no quoting layer in v1.

3. **Precedence.** Worker: `spawn_worker.model` → the leader's `worker_model` → the leader's current route. Team leader: `spawn_dispatcher.model` → the summoner's current route. There is no third level today.

4. **Fallback, one warning, and a tool-result note.** A bad or unknown value never refuses the spawn. It is ignored, the normal fallback route is used, one `[multitask-dispatcher]` warning is written per rejected non-empty value (raw value truncated to 120 characters, control characters replaced), and the tool result carries a short `model_fallbacks` note so the calling model knows its choice was not used. Empty values are omitted silently. No new refusal class is added. The catalog is advisory: a model the catalog does not list is treated as unknown and falls back.

5. **Durable worker default.** The host keeps the leader's `worker_model` under the actual leader session id and writes it to the leader's durable dispatcher mark, so a refresh or restart restores it. An explicit `spawn_worker.model` still wins for that worker. If the mark cannot be written or read, the default is lost and workers inherit the leader's route; the existing mark-failure logging covers it. Legacy mark rows without the field remain valid, and no durable domain version bump is needed.

6. **The host applies the route; prompt text does not change.** The core carries a resolved route through the existing spawn requests. The host sets it as `agentOptions` on the leader's `ctx.agents.create` or on the worker's subagent activation request. A route change clears the inherited reasoning effort; it does not change the parent's `maxTokens` (see Consequences).

## Consequences

- Every spawn without one of the new values keeps its exact pre-feature request shape, so existing tests and behaviour are unchanged.
- The model catalog may be slow or incomplete. Only calls with a non-empty option pay catalog latency, and an incomplete catalog turns a valid-but-unlisted model into a fallback. A short-lived per-provider cache can be added later; v1 measures first.
- A catalog hit does not prove the account is entitled to the model. The first request can fail; there is no mid-run fallback because that would require respawning or switching the live session.
- A new model may have a smaller context window, and the subagent merge keeps the parent's `maxTokens` when the route changes. The leader's handoff or a worker's prompt may not fit, or the first worker turn may fail if the new model rejects the inherited cap. This ADR does not invent a new cap; the spawning dispatcher chooses a model appropriate to the job.
- The worker override relies on the subagent provider's `agentOptions` capability. The live in-process provider advertises it; a different provider would reject the start with a clear error. If the provider is swapped later, gate the feature on the capability and warn once at activation.
- Adding optional properties changes exact-key schema tests and any pinned tool descriptions. Those updates are deliberate; the schema-shape guard and `additionalProperties: false` are not weakened.
- ADR-0006's durability split is unaffected: the new field rides the existing dispatcher mark, not the worker transcript.
- Prompt text, policy copy, and the worker contract are untouched. No directive parsing means no prompt-stripping bugs.

## Alternatives considered

1. **Inline prompt directive** (for example "Use model X for this worker"). Rejected as the shape. The prompt is model-authored; the host would have to parse and strip a value out of it, validate it with no structured feedback path, and keep that parser stable against every prompt wording. A tool parameter gets schema validation, a typed result note, and no prompt risk. This is the main reason for the decision.
2. **Refuse the spawn when the value is invalid.** Rejected: the requirement is to fall back to today's behaviour, and a refusal would make an optional convenience a new failure mode.
3. **Display-name aliases or `default`/`inherit` sentinels.** Rejected for v1: the host has no stable alias table, and omitting the argument is clearer than a sentinel.
4. **A separate runtime tool that switches the caller's own model.** Out of scope for v1. It would change a live session, raise transcript and model-switch-notice questions, and is not needed to choose a spawned leader's or worker's model (plan open question Q1).
5. **Only per-worker choice, with no `worker_model`.** Rejected: a team leader would have to repeat its default on every spawn, and the summoning dispatcher could not set a worker default at summons time.

## Open questions

The plan's §10 items remain for the owner — literal self-model switch, aliases, `worker_model` scope, invalid-value policy, warning visibility, restart durability, reasoning effort, and naming. This ADR records the recommended answers; the ticket carries the questions. None blocks the shape above, and the alternatives stay open until the owner rules.

## Traceability

- Ticket 285 (implementation), plan `.scratch/model-arg/PLAN.md` (2026-11-07) §0 and §3.
- ADRs: 0032 (summoned dispatcher is a top-level session), 0025 (mitosis and the team-leader edge), 0034 (two dispatcher classes), 0006 (durability split), 0018 (copy policy — unaffected).
- No existing ADR is superseded; the change is additive.
