# 285 — Opt-in model choice for summoned team leaders and workers

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing. Optional tool parameters plus one adapter resolver; no transcript or WorkerRecord schema change (the dispatcher mark gains one optional field).
**Related:** ADR-0035 (the decision), ADR-0032 (a summoned dispatcher is a top-level session), ADR-0025 (mitosis), ADR-0034 (two dispatcher classes), `.scratch/model-arg/PLAN.md` (implementation detail).

## Problem

The two spawn tools take no model argument. A summoned team leader inherits the summoning dispatcher's live route, and every worker inherits its team leader's route. A dispatcher that needs one job on a different model has only two poor choices today:

- put a model directive in the handoff prompt — model-authored text, no validation, no feedback, and a directive parser is a stripping bug waiting to happen;
- switch the live session model before spawning — changes the caller's own route and cannot differ per worker.

The goal is an explicit, validated choice at spawn time. Omitting the argument must leave every spawn byte-identical to today's behaviour.

## Contract

### New optional parameters

| Tool | Parameter | Meaning |
|---|---|---|
| `spawn_worker` | `model` | The model this one worker runs on. |
| `spawn_dispatcher` | `model` | The model the summoned team leader runs on. |
| `spawn_dispatcher` | `worker_model` | The default model for every worker that team leader later spawns. |

`worker_model` exists only on `spawn_dispatcher`: a team leader cannot summon another dispatcher, and a worker cannot spawn at all. Both tools keep `additionalProperties: false`; the new fields are optional, so the generated required lists stay unchanged (`spawn_dispatcher`: `title`, `prompt`; `spawn_worker`: its existing required fields).

### Value syntax

    provider/model-id          preferred, unambiguous
    model-id                   accepted only when it resolves to exactly one model

- Provider ids come from the live model catalog (`ctx.llm.listProviders()`); model ids come from that provider's catalog. The canonical catalog spelling is what is stored and passed on.
- Leading and trailing whitespace is trimmed. Empty or whitespace-only means **not provided**.
- A model id may itself contain slashes. The resolver tries the longest registered provider prefix first, then treats the whole string as a bare model id.
- A bare model id that exists under several providers uses the spawning session's current provider. If it still does not resolve to exactly one model, the value falls back.
- No display-name aliases, no `default`/`inherit` sentinel, and no quoting layer in v1. Omit the argument to inherit. Spaces inside the value are literal.
- Examples are placeholders; the ids to document are the ones the live catalog actually shows.

### Precedence

For a worker:

1. `spawn_worker.model` — explicit, always wins.
2. The `worker_model` the team leader received when it was summoned.
3. The team leader's current route — today's inheritance behaviour.

For a team leader:

1. `spawn_dispatcher.model` — explicit.
2. The summoning dispatcher's current live route — today's behaviour.

### Invalid or unknown values

- The spawn is **not** refused. The option is ignored and the normal fallback route is used.
- The host writes one warning per rejected non-empty value to the dsh process log, prefixed `[multitask-dispatcher]`. The raw value is truncated to 120 characters and control characters are replaced before logging.
- The tool result carries a short fallback note (`model_fallbacks`) so the calling model knows its choice was not used. This is a note, not a new refusal class.
- Empty or whitespace-only values are treated as omitted: no warning and no note.
- Fallback destinations: team leader → the summoner's current route; worker → the team leader's stored `worker_model` if one exists, otherwise the leader's current route; invalid `worker_model` → nothing is stored, and the leader's workers inherit the leader's own route.

### Durable worker default

The leader's `worker_model` is a default for **every** worker it later spawns, not a one-shot value for the first worker. The host keeps it under the actual leader session id (including a host-assigned id) and writes it to the leader's durable dispatcher mark, so a refresh or restart restores it. An explicit `spawn_worker.model` still wins for that worker. If the mark write fails or the store is absent, the default is lost and workers inherit the leader's route; that failure is logged like other mark failures. A legacy mark row without the field stays valid, and no durable domain version bump is planned.

### What it does not do

- The leader cannot change its own live model after it starts; that would be a separate self-switch tool (open question Q1 in the plan).
- No aliases/display names (Q2), no reasoning-effort choice (Q7), and no mid-run fallback. A catalog hit does not prove entitlement; the first request can still fail.
- No prompt-text parsing or directive stripping; the prompt is unchanged.

## Acceptance tests

From plan §7. All new tests use a fake catalog and a fake host; no network or model call.

- **Resolver** (`test/model-option.test.ts`): absent and empty; explicit route with case variants and outer whitespace; unique bare id, ambiguous bare id, preferred provider; unknown provider prefix and unknown model; model id containing slashes; internal spaces; catalog missing, catalog throws, one provider throws while another resolves; warning called once for a rejected value and never for a valid/empty value; warning truncation and control-character stripping.
- **Tools** (`test/spawn-dispatcher-tool.test.ts`, `test/dispatcher-tools.test.ts`): exact property keys and required lists; both resolved values reach the spawn seam; one fallback → no route passed, `model_fallbacks` present, note line present; both fallbacks → two notes; empty string → no resolver call and no note; no resolver plus a non-empty value → the wiring error; `spawn_worker` exposes `model` but not `worker_model`; no-option regression → no model key and no `model_fallbacks`.
- **Host** (`test/adapter-cordis-dsh-host.test.ts`, `test/spawn-dispatcher-host.test.ts`): worker request has `agentOptions` only when an explicit or stored default exists; absent option leaves the request's exact pre-feature shape; explicit beats stored default; the default map uses the actual leader id, including a host-assigned id; `worker_model` stored in the map and the mark row; refresh restores the map; invalid `worker_model` stores nothing and warns; phantom cleanup removes the map entry when create fails; the existing nested-leader refusal still passes.
- **Durability** (`test/adapter-durable-marker.test.ts`): round-trip `workerModel`; legacy row without it; malformed provider/model rejected; no domain version bump (still 2).
- **Regression:** existing route inheritance and worker-request-shape tests, `test/dispatcher-tools.test.ts` spawn mapping/ack, `test/multi-dispatcher*.test.ts`, `test/worker-composition.test.ts`, and `test/feature-flag.test.ts` stay green.

Focused commands:

    npx tsx --tsconfig tsconfig.client.json --test test/model-option.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-tool.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/dispatcher-tools.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/adapter-cordis-dsh-host.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-host.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/adapter-durable-marker.test.ts

Final verification owns the full offline gate (`npm test`, `npm run typecheck`, `npm run lint:docs`); no live model is needed for these tests.

## Acceptance criteria

- [ ] Both tools accept the new optional parameters; schemas keep `additionalProperties: false` and their required lists.
- [ ] Omitted and empty values reproduce today's request shape exactly.
- [ ] An invalid value falls back, logs exactly one `[multitask-dispatcher]` warning, and adds the tool-result note; no spawn is refused.
- [ ] The precedence table above holds for leaders and workers.
- [ ] A valid `worker_model` survives a restart and applies to later workers; an explicit `spawn_worker.model` still wins.
- [ ] ADR-0035 records the decision; focused tests and the full offline gate are green.

## Open questions for owner review

The plan's §10 questions remain for owner review: literal self-model switch (Q1), aliases (Q2), `worker_model` scope (Q3), invalid-value policy (Q4), warning visibility (Q5), restart durability (Q6), reasoning effort (Q7), and naming (Q8). V1 follows the recommended answers above; they are cheap to change before implementation and expensive after.

## Comments

- 2026-11-08 — Filed as plan Task 1. Docs only: ticket, ADR-0035, ADR index row, and the generated open-ticket index row. No source code, tests, or builds.
