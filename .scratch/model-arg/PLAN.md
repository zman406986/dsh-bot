# Opt-in model choice for summoned team leaders and workers

> Status: planning only. This file does not change product code, and the task that produced it forbids git commands and commits. The implementation steps below are for the next task, not this one.
>
> Written with the writing-plans skill: every task names exact files, the failing test to write first, the command to run, and the expected result.

**Goal:** add an optional argument to the two spawn tools so a dispatcher can choose the model a summoned team leader runs on, and a team leader can choose the model its workers run on. With no argument, every spawn behaves exactly as it does today.

**Architecture:** the option is a normal optional tool parameter, not a token inside prompt text. One small resolver module in the adapter validates the value against the live model catalog and returns either a resolved provider/model route or a fallback result. The core passes the resolved route through the existing spawn requests; the host bridge applies it as agentOptions on ctx.agents.create (team leader) or on the subagent activation request (worker). A team leader's worker default is kept by the host under the leader's session id and written to the leader's durable dispatcher mark so it survives a restart.

**Tech stack:** TypeScript, Cordis/dsh in-process plugin, Node's built-in test runner via tsx, offline fakes (FakeDshHost, stub Cordis context).

---

## 0. Decision summary

### 0.1 Recommended shape

Add optional tool parameters. Do not parse a directive out of prompt text.

| Tool | New optional parameter | Meaning |
|---|---|---|
| spawn_worker | model | The model this one worker runs on. |
| spawn_dispatcher | model | The model the summoned team leader runs on. |
| spawn_dispatcher | worker_model | The default model for every worker that team leader later spawns. |

worker_model exists only on spawn_dispatcher. A team leader cannot summon another dispatcher, so it has no worker_model argument of its own; it chooses each worker's model with spawn_worker.model, or lets the inherited default apply.

### 0.2 Exact value syntax

    provider/model-id          preferred, unambiguous
    model-id                   accepted only when it resolves to exactly one model

Rules:

- The provider part is matched against the provider ids the live model catalog reports (ctx.llm.listProviders()).
- The model part is the provider-owned model id, matched exactly first and case-insensitively second; the catalog's canonical spelling is what gets stored and passed on.
- Leading and trailing whitespace is trimmed. Empty or whitespace-only means "not provided".
- The model id may itself contain slashes. The resolver tries the longest registered provider prefix first (provider/a/b = provider "provider", model "a/b"), then falls back to treating the whole string as a bare model id.
- If a bare model id appears under more than one provider, the spawning session's current provider wins. If it still does not resolve to one model, the value falls back.
- No display-name aliases, no "default"/"inherit" sentinel, and no quoting layer in v1. Omit the argument to inherit.
- Spaces inside the value are literal. They are not split or shell-quoted; a value that does not match a catalog id falls back.

Examples (the ids are placeholders; use ids the live catalog actually shows):

    model: "deepseek/deepseek-reasoner"
    model: "deepseek-chat"                 // only if unique across providers
    worker_model: "openrouter/some-model"

### 0.3 Precedence

For a worker:

1. spawn_worker.model - explicit, always wins.
2. The worker_model that the team leader received when it was summoned.
3. The team leader's current route - today's inheritance behavior.

For a team leader:

1. spawn_dispatcher.model - explicit.
2. The summoning dispatcher's current live route - today's behavior.

There is no third level today: a team leader cannot summon a dispatcher, and a worker cannot spawn at all.

### 0.4 What happens on an invalid or unknown value

- The spawn is not refused. The option is ignored and the normal fallback route is used.
- The host logs one warning per rejected non-empty value to the dsh process log, with the [multitask-dispatcher] prefix. The warning is emitted from the adapter's resolver, where the session id and fallback are known.
- The tool result also carries a short fallback note so the calling model knows its choice was not used. This is a note, not a new refusal class.
- Empty or whitespace-only values are treated as omitted: no warning, no note.

### 0.5 One interpretation to confirm

The task says "a team leader can set its own model and separately what its workers use." This plan implements the leader's own model as a choice made by the dispatcher that summons it (spawn_dispatcher.model), and the workers' model as a choice the leader makes per worker (spawn_worker.model) or inherits from worker_model.

The leader does not change its own live model after it starts. It can only choose worker models. If "set its own model" was meant literally as a runtime self-switch, that is a different feature (a new tool that calls agent.model.select on the caller's own session) and is listed as open question Q1. Nothing in this plan blocks adding it later, but it is not in v1.

---

## 1. What exists today

### 1.1 The two spawn tools

spawn_worker is defined at src/core/tools.ts:829-847:

- parameters: stream_key (required), title (required), prompt (required), todo_id (optional)
- additionalProperties: false
- handler at src/core/tools.ts:848-939; it validates input, creates or checks the todo, builds a SpawnRequest, and calls multitask.spawnWorker(request) at line 907.

spawn_dispatcher is defined at src/core/tools.ts:1626-1646:

- parameters: title (required), prompt (required)
- additionalProperties: false
- handler at src/core/tools.ts:1647-1712; it trims title and prompt, then calls deps.spawnDispatcher({parentSessionId, title, prompt, signal}) at lines 1685-1690.

The dispatcher tool list is built at src/core/tools.ts:1714-1726. spawn_dispatcher is appended only when maySummonDispatchers is true; a spawned team leader never receives it. The host repeats that refusal as a backstop at src/adapter/cordis-dsh-host.ts:3843-3847.

The application boundary forwards the spawn seam and other dependencies in src/adapter/dispatcher-tools.ts:444-478; the plugin supplies them at src/plugin.ts:1488-1491. The live spawn seam is wired in src/plugin.ts in the toolDeps block around src/plugin.ts:1401-1436.

### 1.2 The worker path

Core types:

- SpawnRequest at src/core/types.ts:117-127
- SpawnOptions at src/core/types.ts:55-79

The core's Multitask.spawnWorker is at src/core/multitask.ts:1263; it calls the host at src/core/multitask.ts:1364-1375 with prompt, parentSessionId, streamKey, title, optional credentialNames, and onWorkerId.

The host's spawnWorker is at src/adapter/cordis-dsh-host.ts:3647-3786. It builds the activation request at src/adapter/cordis-dsh-host.ts:3683-3688:

    {
      prompt: textBlocks(prompt),
      parent,
      maxDepth,
    }

and starts the child at src/adapter/cordis-dsh-host.ts:3729-3736. There is no agentOptions field on that request today. The child therefore inherits the parent's route through the host's own child-option merge (dsh-subagent/lib/types/child-agent.js:63-91; applied in dsh-subagent/lib/types/manager.js:327). The in-process provider advertises support for that field (dsh-subagent-spawn-in-process/lib/index.js:21-22), and the activation contract says agentOptions requires that capability (dsh-subagent/lib/types/types.d.ts:153-160).

### 1.3 The team-leader path

Multitask is bypassed for a dispatcher summon. The tool calls the spawnDispatcher seam directly; the live host implementation is src/adapter/cordis-dsh-host.ts:3827-4283.

Today the host:

1. Refuses if the summoning session is itself a spawned team leader (:3843-3847).
2. Resolves the summoner's live route, most-specific source first, via liveSummonerRoute (:1370-1404) and falls back to parent.options (:3891-3897).
3. Builds agentOptions from provider, model, optional reasoning effort, and optional maxTokens (:3898-3909).
4. Resolves the summoner's preset (readAgentPresets) around :3940-3947, passes it as meta.agentPreset, and mounts it inside setup (:4037-4056, :4081-4091). This is how the leader gets the summoner's tool surface and composition; it is independent of the model route.
5. Creates the top-level session with ctx.agents.create (:4037), activates it (:4112-4118), writes its durable dispatcher mark (:4146-4167), and sends the handoff prompt as its first user turn (:4233-4242).

The leader's model and preset are therefore resolved at spawn time from two different sources: model from agentOptions, tools/preset from the summoner's joined preset. The new option changes only the first.

### 1.4 What the host supports for per-session model choice

The host already has a per-session model selection mechanism:

- AgentModel.select({provider, model, reasoningEffort?}) is declared at dsh-agent/lib/types/model-selection.d.ts:32-39. It appends a durable model/selection event (dsh-agent/lib/types/model-selection.js:88-92) and does no validation. AgentModel.current() reads the recorded selection, then the session's last used route, then the options (dsh-agent/lib/types/model-selection.js:81-96).
- The selection shape is {provider, model, reasoningEffort?} at dsh-agent/lib/types/types.d.ts:68-83; the durable event is at :90-109.
- The GUI path does validate. selectModel checks the catalog and returns session/model-unavailable rather than falling back (dsh-api-session-controller/lib/types/commands.js:155-179); the catalog helper is dsh-api-session-controller/lib/types/catalog.js:68-79.
- The identifier form is exactly the provider route plus the provider-owned model id. There is no alias table in the host.
- Catalog membership is advisory, not request validation (dsh-llm/lib/types/types.d.ts:339).
- At request time an unknown provider throws NO_ADAPTER (dsh-llm/lib/types/index.js:804-808); an unknown model is rejected while resolving model info (:611-613); a session with no selection at all throws "no provider/model" (dsh-agent-loop/lib/index.js:671-672).

Consequence: the host can carry an explicit route, but it will hard-fail at the first request if the route disappears or the account cannot use it. Our option must validate and fall back before the spawn; we cannot rely on the host to fall back later.

### 1.5 What "model" and "preset" are not

- A preset is a tool/composition choice, not a model choice. Passing a model does not change which preset the leader mounts.
- AgentOptions can carry reasoningEffort and maxTokens as well as provider/model. The new option carries only provider and model. If the route changes, the host's child merge clears the parent's reasoning effort (dsh-subagent/lib/types/child-agent.js:88-91); for the leader we build a fresh route object without effort or maxTokens unless the chosen route is exactly the inherited route.
- Workers have no agentPreset field on the activation request; their composition comes from workerAgentDef and the agent/created path, not from the model.

### 1.6 How a leader could carry a worker default

The leader's own agentOptions only affect the leader session. They do not automatically become a separate "worker default." A worker spawned later inherits the leader's current live route through the child-option merge.

So worker_model needs a place to live between the leader's summon and the leader's later spawn_worker calls. The natural place is the host, keyed by the leader's session id:

- an in-memory Map from session id to ModelRoute for the live process;
- the leader's existing durable dispatcher mark row for restart.

The dispatcher mark already carries session identity, optional parent, and generation (src/core/durability.ts:128-153; written at src/adapter/cordis-dsh-host.ts:2668-2708; warmed at :3388-3420). Adding one optional workerModel field follows the same pattern as the optional generation field: no domain version bump, missing field reads fine, present field must be validated (src/adapter/durable-marker.ts:390-416; precedent test at test/adapter-durable-marker.test.ts:441-463).

Without this, a leader that is cold-resumed after a restart would quietly lose its worker default and its workers would fall back to the leader's own route. That is safe, but it is not the requested behavior. The plan keeps the durable field.

---

## 2. Option shape: tool parameter vs inline directive

### 2.1 Shape A - new optional tool parameters (recommended)

What changes:

- The JSON schema for spawn_worker gains model.
- The JSON schema for spawn_dispatcher gains model and worker_model.
- The handlers read them, trim them, validate through one resolver, and pass resolved routes through the existing request/option types.
- The tool descriptions and parameter descriptions teach the model the syntax.

Why it fits:

- The schemas are already the model-facing contract (src/core/tools.ts:832-847, :1629-1646). Optional properties are the established way to add a capability; old calls simply omit them.
- additionalProperties: false keeps the surface honest: worker_model on spawn_worker is rejected rather than silently interpreted.
- The tool call is durable in the transcript and visible in logs.
- Validation has one obvious home: the tool handler delegates to the host's resolver before any spawn.
- Tests can call execute({model: ...}) directly; no prompt parsing.
- The model sees the parameter description next to the argument, which is better guidance than a free-text convention.

Cost:

- A schema change (small).
- Tests that pin exact property keys must be updated (known, listed below).
- The model must be told the syntax; a bad value still reaches the resolver and falls back, which is the required behavior.

### 2.2 Shape B - inline directive inside prompt text

What it would look like:

    model: provider/model-id

or a bracketed token such as [[model=provider/model-id]] on its own line at the top of the prompt.

What it would take:

- Parse the directive in the spawn_worker handler before building the SpawnRequest (src/core/tools.ts:848-907) and in the spawn_dispatcher handler before calling the seam (src/core/tools.ts:1647-1690).
- Strip the directive from the prompt before it reaches the child, or the child sees an instruction fragment as part of its task. The worker prompt is the child's first user message (src/adapter/cordis-dsh-host.ts:3663-3665); the leader prompt is wrapped with a handoff line at src/adapter/cordis-dsh-host.ts:4233-4235.
- Define escaping for prompts that legitimately contain the token, quoting for spaces, and precedence if an explicit future argument also exists.
- Repeat the parser in two paths and keep them in sync.
- Add prompt-copy guidance to the policy text, because the model must know the convention even though the schema does not.

Why it is worse:

- Prompt text is free-form. A token can collide with a user's task text, a quoted error message, or a file path.
- Whitespace and quoting are ambiguous: a model id with spaces, a newline, or a leading dash needs rules the schema would otherwise enforce.
- The directive is invisible to the host's tool schema and to the UI.
- A stripping bug leaks protocol text into the child's task, which is a correctness problem, not a cosmetic one.
- Validation still has to happen in the same host resolver, so the parser buys no validation reuse.
- Two prompt paths (worker and leader) plus the handoff wrapper means more tests and more places to drift.

Recommendation: Shape A. It uses the existing tool contract, keeps the prompt clean, and gives the model a discoverable place to put the choice.

---

## 3. Exact contract

### 3.1 Names and schema additions

spawn_worker:

    model: {
      type: "string",
      required: false,
      description:
        "Optional model for this worker. Use provider/model-id (for example " +
        "\"deepseek/deepseek-reasoner\"). A bare model id is accepted when it is " +
        "unique. Omit to inherit your default worker route.",
    }

spawn_dispatcher:

    model: {
      type: "string",
      required: false,
      description:
        "Optional model for the summoned team leader. Use provider/model-id. A " +
        "bare model id is accepted when it is unique. Omit to inherit your " +
        "current route.",
    },
    worker_model: {
      type: "string",
      required: false,
      description:
        "Optional default model for every worker this team leader later spawns. " +
        "Use provider/model-id. Omit to let workers inherit the team leader's " +
        "own route. An explicit model on spawn_worker still wins for that worker.",
    }

Both tools keep additionalProperties: false; the parent-level required array is produced by toToolParametersSchema from per-field required: true (src/core/tools.ts:125-152). These fields omit required, so the generated parent required array stays ["title", "prompt"] as appropriate, and the generic schema-shape test still passes.

### 3.2 Resolution algorithm

One new adapter module, src/adapter/model-option.ts, owns the syntax and catalog lookup. It is pure apart from the catalog calls and an injected warning callback; the host wires the live catalog. The small purpose and result types live in src/core/types.ts so the core tool layer can name them without importing the adapter; the resolver module imports those core types.

    // In src/core/types.ts:
    export type ModelOptionPurpose = "leader" | "worker" | "worker-default";

    export type ModelResolutionFailure =
      | "unknown-model"
      | "ambiguous-model"
      | "catalog-unavailable"
      | "catalog-error";

    export type ModelOptionResolution =
      | { kind: "absent" }
      | { kind: "resolved"; route: ModelRoute }
      | {
          kind: "fallback";
          requested: string;
          reason: ModelResolutionFailure;
          detail?: string;
        };

    export interface ModelCatalogLike {
      listProviders(): readonly { id: string; name?: string }[];
      listModels(provider: string): Promise<readonly { id: string; name?: string }[]>;
    }

    export interface ResolveModelOptionInput {
      readonly raw: string;
      readonly purpose: ModelOptionPurpose;
      readonly sessionId: string;
      readonly preferredProvider?: string;
      readonly catalog?: ModelCatalogLike;
      readonly fallbackDescription: string;
      readonly warn: (message: string) => void;
    }

    export async function resolveModelOption(
      input: ResolveModelOptionInput,
    ): Promise<ModelOptionResolution>;

Algorithm, in order:

1. value = raw.trim(). If empty: {kind: "absent"} (no warning).
2. If catalog is undefined: warning, {kind: "fallback", reason: "catalog-unavailable"}.
3. Read catalog.listProviders(). If it throws: warning, catalog-error.
4. Build a case-insensitive provider map.
5. Explicit route pass: for each registered provider, longest id first, if value starts with providerId + "/" and the remainder is non-empty:
   - call catalog.listModels(providerId);
   - if it throws: this is a catalog-error for a route the caller explicitly named; warning and fallback (do not reinterpret the whole string as a bare id);
   - find the model by exact id, then case-insensitive id; if found, return the canonical route.
6. Bare-id pass: call catalog.listModels for every registered provider, skipping providers whose catalog throws. For each, find exact id first, then case-insensitive id. Collect canonical matches, de-duplicated by provider + "/" + id.
   - exactly one match: return it;
   - more than one: if exactly one is owned by preferredProvider, return it; otherwise ambiguous-model;
   - none: unknown-model.
7. If every provider catalog threw and there were no usable results: catalog-unavailable (or catalog-error if the explicit route pass already failed); warning and fallback.

The resolver assembles the warning message from the raw value (sanitized and truncated to 120 characters), the reason, and the fallback description. The host wrapper only adds the [multitask-dispatcher] prefix. The resolver calls warn once per rejected value; a resolved or absent value never calls it.

### 3.3 Where validation happens

| Stage | What it checks | On failure |
|---|---|---|
| Tool JSON schema | model / worker_model are strings when present | Provider/tool layer rejects the call; this is a type error, not a model-value fallback. |
| Tool handler | Trim; empty means absent; non-string is a programming error (optionalString throws) | Empty is fine; non-string does not reach the resolver. |
| CordisDshHost.resolveModelOption | Reads the live catalog, supplies the spawning session's provider as the bare-id preference, supplies the fallback description | A missing catalog becomes catalog-unavailable; no throw. |
| src/adapter/model-option.ts | Syntax, provider registration, model membership, ambiguity | Returns fallback; never throws for a bad value. |
| CordisDshHost.spawnDispatcher / spawnWorker | Defensive route shape (non-empty strings); applies explicit route, then inherited default, then today's route | Bad route object is treated as absent and warned; spawn proceeds on the default. |
| LLM runtime at first request | Provider exists, model resolves, account can use it | Hard failure, outside this feature. No mid-run fallback. |

### 3.4 Fallback destinations and warning text

Team leader (spawn_dispatcher.model invalid): the leader uses the summoner's current live route, exactly as it does today. Warning:

    [multitask-dispatcher] model option "<raw>" from session <sessionId> was ignored (unknown model); using the summoner's current route.

Worker (spawn_worker.model invalid): the worker uses the team leader's worker_model if one is stored, otherwise the leader's current route. Warning:

    [multitask-dispatcher] model option "<raw>" from session <sessionId> was ignored (unknown model); using the team leader's default worker route or its own route.

Worker default (spawn_dispatcher.worker_model invalid): no default is stored; the leader's workers inherit the leader's own route. Warning:

    [multitask-dispatcher] worker_model option "<raw>" from session <sessionId> was ignored (unknown model); the team leader's workers use its own route.

The raw value is truncated to 120 characters and control characters are replaced with spaces before logging. The warning is written with console.warn inside the adapter's resolveModelOption wrapper, wrapped in try/catch like every other warning in that file (for example src/adapter/cordis-dsh-host.ts:4138-4143). A resolved value and an omitted value produce no warning.

### 3.5 Tool-result notes

The calling model should know its choice was not used. Add an optional structured field to both success results:

    export interface ModelFallbackNotice {
      readonly option: "model" | "worker_model";
      readonly requested: string;
      readonly reason: ModelResolutionFailure;
    }

- SpawnWorkerToolResult success gains model_fallbacks?: readonly ModelFallbackNotice[].
- SpawnDispatcherToolResult success gains the same field.
- formatSpawnAck appends one line per notice, after the opening paragraph and before the "Self-contained prompt sent" block: Model "<requested>" was not used (<reason text>); this worker uses the inherited route.
- formatSpawnDispatcherNote appends, at the end:
  - for model: Leader model "<requested>" was not used (<reason text>); the team leader uses the summoner's route.
  - for worker_model: Worker model "<requested>" was not used (<reason text>); its workers use the team leader's route.

Reason text mapping:

| Reason | Text |
|---|---|
| unknown-model | not in the model catalog |
| ambiguous-model | it matches more than one provider; use provider/model |
| catalog-unavailable | the model catalog is unavailable |
| catalog-error | the model catalog could not be read |

No refusal class is added. A fallback is a successful spawn with a note, not a failed spawn.

### 3.6 What the option does not do

- It does not add a model picker or any client UI. The existing session model indicator reads the live session route after the first turn.
- It does not support display names or aliases.
- It does not expose reasoning effort, temperature, or maxTokens.
- It does not let a team leader change its own live model after it starts.
- It does not let a team leader change its worker default; only the summoning dispatcher sets worker_model.
- It does not retry with a default if the first request fails because the account lacks entitlement.
- It does not apply to the user's own dispatcher session; that model is chosen in the normal dsh UI.

---

## 4. Data flow

### 4.1 Dispatcher to team leader

    User or caller
      -> dispatcher session D (current route pA/mA)
      -> spawn_dispatcher({ title, prompt, model: "pB/mB", worker_model: "pC/mC" })
         -> tool handler trims and resolves both values through the host resolver
         -> DispatcherSpawnOptions {
              parentSessionId: D,
              title, prompt,
              model?: {provider:"pB", model:"mB"},
              workerModel?: {provider:"pC", model:"mC"},
            }
         -> CordisDshHost.spawnDispatcher
            -> leader agentOptions =
                 explicit model pB/mB
                 OR D's current live route pA/mA
            -> workerModelDefaults[leaderSessionId] = pC/mC
            -> ctx.agents.create({ agentOptions, meta: {cwd, agentPreset}, setup })
            -> writeDispatcherMark(leaderSessionId, D, generation, workerModel)
            -> leader's first turn: handoff prompt

The leader's preset/tool composition still comes from D's joined preset, not from the model option.

### 4.2 Team leader to worker

    Leader session L (current route pB/mB; stored worker default pC/mC)
      -> spawn_worker({ stream_key, title, prompt, model?: "pD/mD" })
         -> tool handler trims/resolves model
         -> SpawnRequest { ..., model?: {provider:"pD", model:"mD"} }
         -> Multitask.spawnWorker
         -> CordisDshHost.spawnWorker
            -> agentOptions =
                 explicit pD/mD
                 OR workerModelDefaults[L] = pC/mC
                 OR absent (child inherits L's live route)
            -> ctx.subagents.startActivation({ request: { prompt, parent, maxDepth, agentOptions? } })
            -> worker session W

resolveChildAgentOptions merges the requested route over the leader's route. If the route changes, it clears the leader's reasoning effort so the new model resolves its own default (dsh-subagent/lib/types/child-agent.js:88-91). If the route is unchanged, today's behavior is preserved.

### 4.3 Worked example

Assume all ids are valid and distinct: pA/mA, pB/mB, pC/mC, pD/mD.

| Step | Call | Result |
|---|---|---|
| 1 | Dispatcher D on pA/mA calls spawn_dispatcher({model:"pB/mB", worker_model:"pC/mC"}) | Leader L runs pB/mB; L's worker default is pC/mC. |
| 2 | L calls spawn_worker({model:"pD/mD"}) | Worker W1 runs pD/mD. |
| 3 | L calls spawn_worker({}) | Worker W2 runs pC/mC. |
| 4 | L calls spawn_worker({model:"nope"}) | W3 runs pC/mC; warning + fallback note. |
| 5 | L calls spawn_worker({model:""}) | W4 runs pC/mC; no warning (empty = omitted). |
| 6 | L calls spawn_worker({worker_model:"pD/mD"}) | Schema rejects the unknown argument; worker_model is not a worker-level field. |
| 7 | L calls spawn_dispatcher(...) | Tool is absent from L's surface; host backstop refuses if called directly. |

If step 1's worker_model is invalid instead, L still runs pB/mB, no default is stored, and steps 3-5 use L's own route pB/mB (plus warnings/notes for the invalid default).

### 4.4 Restart path

- The leader's durable dispatcher mark gains workerModel?: {provider, model}.
- On activation, refreshDispatcherMarks restores it into the in-memory map. In-process values win over the store, same rule as parent and generation (src/adapter/cordis-dsh-host.ts:3395-3406).
- A worker spawned after the restart resolves the default from the map exactly as before.
- If the mark store is unavailable or the row is old and has no workerModel, the map has no entry and workers inherit the leader's route. Safe degradation.
- The leader's own model survives through its recorded request header after its first turn. A cold resume before the first turn would use the deployment default, because the resume path passes the default agentOptions (dsh-api-session-controller/lib/index.js:305-317, 440-452). The host sends the first turn immediately after create (:4233-4242), so this is a narrow edge; it is stated rather than solved.

---

## 5. File-level touch list

| File | Change | Size |
|---|---|---|
| src/core/types.ts | Add ModelRoute, ModelOptionPurpose, ModelOptionResolution, ModelResolutionFailure, ModelFallbackNotice; add model? to SpawnRequest and SpawnOptions; add model? and workerModel? to DispatcherSpawnOptions. | S |
| src/index.ts | Export the new public types. | S |
| src/core/tools.ts | Add model to spawn_worker schema; add model and worker_model to spawn_dispatcher schema; add optional resolveModel to DispatcherToolDeps; resolve/trim/pass values in both handlers; append fallback notices. | M |
| src/core/tool-results.ts | Add model_fallbacks? to both success result types; extend formatSpawnAck and formatSpawnDispatcherNote; add reason-text helper. | S |
| src/core/policy/prompts.ts | Add one model sentence to each EN tool description and the matching ZH sentence. No policy-rule change. | S |
| src/adapter/model-option.ts | New. Pure resolver: syntax, provider/model lookup, ambiguity, warnings. | M |
| src/adapter/cordis-dsh-host.ts | Add ActivationSpecLike.request.agentOptions; add resolveModelOption to CordisDshHost; implement the catalog read, resolution wrapper, warning, worker-default map, leader route application, worker route application, mark write/restore, phantom cleanup. | L |
| src/adapter/dispatcher-tools.ts | Forward the optional resolveModel dependency into createDispatcherTools; add it to the registration options type. | S |
| src/adapter/index.ts | Export resolveModelOption/types if tests or callers import them from the package surface. | S |
| src/plugin.ts | Wire resolveModel: (raw, purpose) => host.resolveModelOption(raw, sessionId, purpose) into toolDeps; ensure the closure uses the right session id. | S |
| src/core/durability.ts | Add optional workerModel?: ModelRoute to DurableDispatcherMark. | S |
| src/adapter/durable-marker.ts | Validate the optional field in parseDispatcherMark; round-trip it in writes/reads. | S |
| src/core/multitask.ts | Pass request.model into the host's SpawnOptions. | S |
| src/core/dsh-host.ts | No signature change; the existing options carry the new field. Verify no edit is needed. | - |
| src/core/fake-host.ts | No behavior change; recorded SpawnCall.opts now may carry model. Optionally add a helper comment. | - |
| test/model-option.test.ts | New. Table-driven resolver tests with a fake catalog. | M |
| test/spawn-dispatcher-tool.test.ts | Update exact-key assertions; add resolve/fallback/note tests. | S |
| test/dispatcher-tools.test.ts | Add schema-key, pass-through, fallback-note, and no-option regression tests. | S |
| test/adapter-cordis-dsh-host.test.ts | Add worker agentOptions assertions (explicit, default, absent). | M |
| test/spawn-dispatcher-host.test.ts | Add leader route, worker default, mark restore, warning, and nested-refusal tests. | M |
| test/adapter-durable-marker.test.ts | Add workerModel round-trip, legacy row, and malformed-row tests. | S |
| test/policy-assembler.test.ts / test/policy-zh-assets.test.ts | Update only if description assertions pin exact bytes; add a mention check. | S |
| README.md | Add a short "Choosing models" subsection under "Summoning a second dispatcher". | S |
| docs/adr/0035-...md | New. Record the tool-parameter choice, precedence, fallback, and durability. | S |
| Issue-tracker/open/285-...md | New. Ticket required before implementation per Issue-tracker/issue-tracker.md:24-28. | S |
| .scratch/model-arg/PLAN.md | This file. | - |

No client/browser code is required. The session model indicator already reads the live route after the first turn.

---

## 6. Ordered implementation tasks

Each task is one small action. Run the focused test first; it must fail for the stated reason; then implement; then run it again. No commit steps: this task forbids git commands. When the implementation task is started later, commit after each green task.

### Task 1 - Create the ticket and ADR skeleton (S)

Files:

- Create Issue-tracker/open/285-opt-in-spawn-model-choice.md
- Create docs/adr/0035-spawn-model-option.md
- Modify docs/adr/README.md (one row)

Step 1: Write the ticket with the problem, the contract from section 3, the acceptance tests from section 7, and Status: open.

Step 2: Write the ADR with the decision (tool parameters, precedence, fallback, warning, durable worker default) and the alternatives rejected. Keep it short; the plan is the detail.

Step 3: Add the ADR row to docs/adr/README.md.

Step 4: Run npm run lint:docs. Expected: pass (or only pre-existing failures unrelated to these files).

### Task 2 - Add the contract types (S)

Files:

- Modify src/core/types.ts
- Modify src/index.ts

Step 1: Write a compile-only test/import in test/model-option.test.ts that imports ModelRoute and constructs {provider:"p", model:"m"}. This fails because the type does not exist yet.

Step 2: Run npx tsx --tsconfig tsconfig.client.json --test test/model-option.test.ts. Expected: TypeScript/import failure.

Step 3: Add:

    export interface ModelRoute {
      readonly provider: string;
      readonly model: string;
    }

    export type ModelOptionPurpose = "leader" | "worker" | "worker-default";

    export type ModelResolutionFailure =
      | "unknown-model"
      | "ambiguous-model"
      | "catalog-unavailable"
      | "catalog-error";

    export type ModelOptionResolution =
      | { kind: "absent" }
      | { kind: "resolved"; route: ModelRoute }
      | {
          kind: "fallback";
          requested: string;
          reason: ModelResolutionFailure;
          detail?: string;
        };

    export interface ModelFallbackNotice {
      readonly option: "model" | "worker_model";
      readonly requested: string;
      readonly reason: ModelResolutionFailure;
    }

Add model?: ModelRoute to SpawnRequest and SpawnOptions; add model?: ModelRoute and workerModel?: ModelRoute to DispatcherSpawnOptions. Export the new types from src/index.ts next to the existing spawn types (src/index.ts:148-161).

Step 4: Run the focused test. Expected: pass.

Step 5: Run npm run typecheck. Expected: pass (the new fields are optional; no caller is forced to change).

### Task 3 - Build the pure resolver and its tests (M)

Files:

- Create src/adapter/model-option.ts
- Create test/model-option.test.ts

Step 1: Write the failing tests. Use a fake catalog, no network:

    const catalog = {
      listProviders: () => [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      listModels: async (provider: string) =>
        provider === "alpha"
          ? [
              { id: "shared", name: "Shared" },
              { id: "alpha-only", name: "Alpha Only" },
              { id: "slash/inside", name: "Slash Inside" },
            ]
          : [
              { id: "shared", name: "Shared" },
              { id: "beta-only", name: "Beta Only" },
            ],
    };

Cases to assert:

- "" and "   " -> {kind:"absent"}, warn not called.
- "alpha/alpha-only" -> canonical {provider:"alpha", model:"alpha-only"}.
- "ALPHA/ALPHA-ONLY" -> canonical route.
- "alpha-only" -> canonical route.
- "shared" with preferredProvider:"beta" -> {provider:"beta", model:"shared"}.
- "shared" with no preferred provider -> {kind:"fallback", reason:"ambiguous-model"}.
- "alpha/nope" -> {kind:"fallback", reason:"unknown-model"}.
- "nope/nope" -> fallback; warn called once.
- "alpha/slash/inside" -> {provider:"alpha", model:"slash/inside"}.
- "slash/inside" -> {provider:"alpha", model:"slash/inside"} (bare-id pass after the explicit-route pass fails).
- " alpha/alpha-only " -> canonical route (trim).
- "alpha / alpha-only" -> fallback (internal spaces).
- catalog === undefined -> fallback catalog-unavailable; warn once.
- a listModels that throws for the explicit provider -> fallback catalog-error; warn once.
- a valid value -> warn not called.
- a 200-character value -> warning message is at most 120 characters for the value portion and contains no newline or tab.

Step 2: Run npx tsx --tsconfig tsconfig.client.json --test test/model-option.test.ts. Expected: fail (module not found).

Step 3: Implement resolveModelOption with the algorithm in section 3.2. Keep the warning formatter in a small helper so the host and tests produce the same text. The module must not import the live ctx; it takes ModelCatalogLike.

Step 4: Run the focused test. Expected: all cases pass.

Step 5: Run npm run typecheck. Expected: pass.

### Task 4 - Add the tool parameters and handlers (M)

Files:

- Modify src/core/tools.ts
- Modify src/core/tool-results.ts
- Modify test/dispatcher-tools.test.ts
- Modify test/spawn-dispatcher-tool.test.ts

Step 1: Write the failing tests.

In test/spawn-dispatcher-tool.test.ts, update the exact-key test at lines 107-127:

- Object.keys(parameters.properties).sort() becomes ["model", "prompt", "title", "worker_model"].
- parameters.required (after toToolParametersSchema) is ["title", "prompt"] (authored property order).
- model and worker_model are type "string" and not required.

Add a test that passes model and worker_model and asserts the seam receives the resolved routes:

    const calls: DispatcherSpawnOptions[] = [];
    const rig = createRig({
      resolveModel: async (raw) =>
        raw === "pB/mB"
          ? { kind: "resolved", route: { provider: "pB", model: "mB" } }
          : { kind: "resolved", route: { provider: "pC", model: "mC" } },
      spawnDispatcher: async (opts) => {
        calls.push(opts);
        return { dispatcherId: "disp-1" };
      },
    });

Assert calls[0].model and calls[0].workerModel deep-equal the routes, and the success note has no fallback line.

Add a test where resolveModel returns a fallback for model; assert the seam gets no model, the result has model_fallbacks[0].reason === "unknown-model", and the note contains "was not used".

In test/dispatcher-tools.test.ts, add:

- spawn_worker schema includes model (string, optional), still no worker_model.
- a spawn_worker call with model passes host.spawnCalls[0].opts.model through as the resolved route.
- a fallback result adds model_fallbacks and an ack line.
- the no-option call still has no model key in the host options and no fallback fields (regression).

Step 2: Run:
npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-tool.test.ts
and the same for test/dispatcher-tools.test.ts. Expected: fail on the new assertions.

Step 3: Implement:

- Add the optional model schema constant to spawn_worker.
- Add model and worker_model schema constants to spawn_dispatcher.
- Use the ModelOptionPurpose and ModelOptionResolution types added to src/core/types.ts in Task 2 (the core must not import the adapter). Add resolveModel?: (raw: string, purpose: ModelOptionPurpose) => Promise<ModelOptionResolution> to DispatcherToolDeps.
- Add a local helper:

    async function resolveModelArg(
      value: string | undefined,
      option: "model" | "worker_model",
      purpose: ModelOptionPurpose,
    ): Promise<{
      route?: ModelRoute;
      fallback?: ModelFallbackNotice;
    }> {
      if (value === undefined) return {};
      const trimmed = value.trim();
      if (trimmed === "") return {};
      const resolve = deps.resolveModel;
      if (resolve === undefined) {
        throw new Error(
          "a model option was provided but no model resolver is wired (host wiring bug)",
        );
      }
      const result = await resolve(trimmed, purpose);
      if (result.kind === "resolved") return { route: result.route };
      if (result.kind === "fallback") {
        return {
          fallback: {
            option,
            requested: trimmed,
            reason: result.reason,
          },
        };
      }
      return {};
    }

- In spawn_worker.execute, read const rawModel = optionalString(args, "model") immediately after the required-argument reads and before the todo existence checks or any todo creation (a wiring error must not leave an orphan todo), call const resolvedModel = await resolveModelArg(rawModel, "model", "worker"), and add ...(resolvedModel.route ? { model: resolvedModel.route } : {}) to the request; pass model_fallbacks: [resolvedModel.fallback] to formatSpawnAck when present.
- In spawn_dispatcher.execute, call it for model (purpose "leader") and worker_model (purpose "worker-default"); add conditional fields to the seam options; pass the notices to formatSpawnDispatcherNote.
- In tool-results.ts, add the optional field to both success branches and extend the two formatters with a reason-text helper.

Step 4: Run both focused tests. Expected: pass.

Step 5: Run npm run typecheck. Expected: pass.

### Task 5 - Update the model-facing descriptions (S)

Files:

- Modify src/core/policy/prompts.ts
- Modify test/policy-assembler.test.ts / test/policy-zh-assets.test.ts only if they pin the exact text

Step 1: Add a failing assertion in test/policy-assembler.test.ts:

    assert.ok(TOOL_DESCRIPTIONS[SPAWN_WORKER_TOOL].includes("model"));
    assert.ok(TOOL_DESCRIPTIONS[SPAWN_DISPATCHER_TOOL].includes("worker_model"));

and the ZH equivalents. Run it; expected: fail.

Step 2: Add one sentence to each EN description and the matching ZH sentence:

- spawn_worker: "Optional model chooses this worker's model; omit it to inherit your default worker route."
- spawn_dispatcher: "Optional model chooses the team leader's model; optional worker_model sets the default for its workers."

Keep the existing claims and line structure. Do not add a policy-rule bullet: the tool description is the instruction, and the ZH policy section is pinned bullet-for-bullet.

Step 3: Run the policy tests. Expected: pass.

### Task 6 - Wire the resolver through the adapter and plugin (S)

Files:

- Modify src/adapter/dispatcher-tools.ts
- Modify src/plugin.ts
- Modify src/adapter/index.ts if exports are needed

Step 1: Add a failing test in test/spawn-dispatcher-tool.test.ts that constructs the tool rig with a resolveModel dep and asserts it is called with ("pB/mB", "leader") and ("pC/mC", "worker-default"). This fails until the adapter forwards the dep.

Step 2: Add resolveModel? to RegisterDispatcherToolsOptions and forward it in the createDispatcherTools call at src/adapter/dispatcher-tools.ts:451-468.

Step 3: In src/plugin.ts, in the toolDeps block, add:

    resolveModel: (raw, purpose) =>
      host.resolveModelOption(raw, sessionId, purpose),

The sessionId must be the activated session's id, not a process-global one. If the block is created before sessionId is bound, move the closure to the registration site or capture the same local the other deps use.

Step 4: Run the focused test. Expected: pass.

### Task 7 - Implement the host resolver (M)

Files:

- Modify src/adapter/cordis-dsh-host.ts
- Modify src/adapter/index.ts
- Modify test/spawn-dispatcher-host.test.ts

Step 1: Add a failing test in test/spawn-dispatcher-host.test.ts that calls host.resolveModelOption("pB/mB", "disp-1", "leader") with a stub ctx.get("llm") catalog. Assert:

- a valid route resolves to the canonical route;
- an unknown route returns {kind:"fallback", reason:"unknown-model"};
- console.warn was called once with [multitask-dispatcher] and the raw value (use mock.method(console, "warn", ...) from node:test);
- an empty string returns {kind:"absent"} and does not warn.

Step 2: Run the focused test. Expected: fail (method missing).

Step 3: Implement:

- Add resolveModelOption(raw, sessionId, purpose) to the CordisDshHost interface near spawnDispatcher (src/adapter/cordis-dsh-host.ts:563-598).
- In the host factory, implement it:
  - const parent = parents.get(sessionId);
  - const live = parent === undefined ? {} : liveSummonerRoute(parent);
  - const preferredProvider = live.provider ?? parent?.options?.provider;
  - const catalog = readLlmCatalog(ctx);
  - const fallbackDescription = purpose === "leader" ? "the summoner's current route" : purpose === "worker" ? "the team leader's default worker route or its own route" : "the team leader's own route";
  - call resolveModelOption from the new module with a warn callback that writes the prefixed, try/catch-wrapped console.warn.
- Implement readLlmCatalog with a guarded ctx.get("llm") read, not ctx.llm property access. The host file documents the live-context trap at src/adapter/cordis-dsh-host.ts:1127-1128; an un-injected service read by property can throw. Validate listProviders and listModels are functions.

Step 4: Run the focused test. Expected: pass.

Step 5: Run npm run typecheck. Expected: pass.

### Task 8 - Apply the leader's model (M)

Files:

- Modify src/adapter/cordis-dsh-host.ts
- Modify test/spawn-dispatcher-host.test.ts

Step 1: Add failing tests:

- spawnDispatcher({parentSessionId:"disp-1", title, prompt, model:{provider:"pB",model:"mB"}}) -> createCalls[0].agentOptions deep-equals {provider:"pB", model:"mB"} and carries no reasoningEffort/maxTokens.
- no model -> agentOptions equals the summoner's route (existing behavior; keep the no-route test at :370-420 and the live-route test at :456-487).
- explicit model equal to the inherited route -> agentOptions still includes the inherited effort/maxTokens (same-route preservation).
- model omitted + worker_model present -> agentOptions unchanged and the map/mark gets the worker route.

Step 2: Run the focused test. Expected: fail.

Step 3: In spawnDispatcher, after the existing agentOptions is built:

    const explicitLeader = usableRoute(opts.model);
    const leaderAgentOptions =
      explicitLeader === undefined
        ? agentOptions
        : agentOptions !== undefined &&
            agentOptions.provider === explicitLeader.provider &&
            agentOptions.model === explicitLeader.model
          ? agentOptions
          : { provider: explicitLeader.provider, model: explicitLeader.model };

Pass leaderAgentOptions to create instead of agentOptions. If explicitLeader is present but malformed, usableRoute returns undefined and console.warn once; the fallback is the inherited route.

Step 4: Run the focused test. Expected: pass.

### Task 9 - Apply the worker's model and the leader's default (M)

Files:

- Modify src/adapter/cordis-dsh-host.ts
- Modify src/core/multitask.ts
- Modify test/adapter-cordis-dsh-host.test.ts
- Modify test/dispatcher-tools.test.ts

Step 1: Add failing tests:

- spawnWorker("p", {parentSessionId:"leader-1", ..., model:{provider:"pD",model:"mD"}}) -> startActivationCalls[0].request.agentOptions deep-equals {provider:"pD", model:"mD"}.
- no model, no map entry -> the request has no agentOptions key (exact today's shape).
- no model, map entry {pC,mC} -> agentOptions {pC,mC}.
- model explicit + map entry -> explicit wins.
- the map is keyed by the leader's actual id, including a host-assigned id different from the reservation (extend the existing id-mismatch test).

In test/dispatcher-tools.test.ts, assert SpawnRequest.model reaches host.spawnCalls[0].opts.model.

Step 2: Run both focused tests. Expected: fail.

Step 3: Implement:

- Add agentOptions?: {provider: string; model: string} to ActivationSpecLike["request"] (src/adapter/cordis-dsh-host.ts:223-237).
- In spawnWorker, before building request:

    const explicitWorker = usableRoute(opts.model);
    const storedDefault = usableRoute(workerModelDefaults.get(opts.parentSessionId));
    const workerRoute = explicitWorker ?? storedDefault;
    const request: ActivationSpecLike["request"] = {
      prompt: textBlocks(prompt),
      parent,
      maxDepth,
      ...(workerRoute === undefined
        ? {}
        : { agentOptions: { provider: workerRoute.provider, model: workerRoute.model } }),
    };

- In src/core/multitask.ts, add the conditional model to the host options at :1364-1375.
- Declare const workerModelDefaults = new Map<string, ModelRoute>(); in the host factory near the other mirrors.

Step 4: Run both focused tests. Expected: pass.

### Task 10 - Store and restore the worker default (M)

Files:

- Modify src/core/durability.ts
- Modify src/adapter/durable-marker.ts
- Modify src/adapter/cordis-dsh-host.ts
- Modify test/adapter-durable-marker.test.ts
- Modify test/spawn-dispatcher-host.test.ts

Step 1: Add failing tests:

- writeDispatcherMark({sessionId:"leader-1", workerModel:{provider:"pC",model:"mC"}}) round-trips through readDispatcherMark and listDispatcherMarks.
- a legacy row without workerModel reads fine and has undefined.
- a row with workerModel: {provider:"", model:"mC"} is rejected by the parser.
- host.refreshDispatcherMarks() warms the map; a subsequent spawnWorker with no model uses pC/mC.
- an in-process map value is not downgraded by a store row with a different value (same rule as parent/generation).

Step 2: Run the focused tests. Expected: fail.

Step 3: Implement:

- Add readonly workerModel?: ModelRoute to DurableDispatcherMark (src/core/durability.ts:128-153).
- In parseDispatcherMark (src/adapter/durable-marker.ts:390-416), when present, require a plain object with non-empty string provider and model; reject otherwise.
- In writeDispatcherMark in the host, add an optional fourth parameter and write the field conditionally; mirror it into workerModelDefaults synchronously, exactly like dispatcherMarks and dispatcherGenerations.
- In refreshDispatcherMarks, restore mark.workerModel only when the map has no value for that session.
- In spawnDispatcher, call writeDispatcherMark(dispatcherId, opts.parentSessionId, childGeneration, opts.workerModel).
- Add workerModelDefaults.delete(id) to the phantom-id cleanup in the finally block at src/adapter/cordis-dsh-host.ts:4262-4281, so a failed create cannot leave a default behind under a reservation id.

Step 4: Run the focused tests. Expected: pass.

Step 5: Run npm test. Expected: all tests pass. If a pinned test fails, inspect whether it is an expected schema/description change; update it with a comment naming this feature, never by loosening the assertion.

### Task 11 - README, ADR, and final checks (S)

Files:

- Modify README.md
- Finish docs/adr/0035-spawn-model-option.md
- Finish Issue-tracker/open/285-opt-in-spawn-model-choice.md

Step 1: Add a README subsection under "Summoning a second dispatcher":

- spawn_dispatcher takes optional model (the leader's model) and worker_model (its workers' default).
- spawn_worker takes optional model.
- Omit to inherit today's behavior.
- Invalid values fall back; the process log carries a warning.

Step 2: Record the open questions from section 10 in the ticket, not as silent assumptions. The ADR records the chosen answers and marks the unresolved ones as agent-drafted/open.

Step 3: Run:

    npm test
    npm run typecheck
    npm run lint:docs

Expected: all pass.

---

## 7. Test plan

### 7.1 The offline guarantee

Every new test uses a fake model catalog and a fake host. No test calls ctx.llm, a provider, or a network endpoint. The resolver takes ModelCatalogLike as an argument, so its tests are pure. Host tests use the existing stub context and add get("llm") only for the catalog fixture.

### 7.2 Resolver unit tests (test/model-option.test.ts)

Cover the table in Task 3. Add one test per row:

- absent and empty;
- explicit route, case variants, outer whitespace;
- bare id unique, bare id ambiguous, preferred provider;
- unknown provider prefix, unknown model;
- model id containing slashes;
- internal spaces;
- catalog missing, catalog throws, one provider throws but another resolves;
- warning called once for a rejected value, never for a valid/empty value;
- warning text truncation and control-character stripping.

### 7.3 Tool tests

test/spawn-dispatcher-tool.test.ts:

- exact property keys and required list;
- both values resolved and passed to the seam;
- one fallback -> no route passed, model_fallbacks present, note line present;
- both fallbacks -> two notes;
- empty string -> no resolver call, no note;
- no resolver + non-empty value -> throws the wiring error.

test/dispatcher-tools.test.ts:

- spawn_worker schema has model, not worker_model;
- pass-through to host.spawnCalls[0].opts.model;
- fallback note in the ack;
- no-option regression: no model key, no model_fallbacks.

test/tool-schema-shape.test.ts already walks every registered tool schema and forbids a boolean required; no new case is needed beyond running it.

### 7.4 Host tests

test/adapter-cordis-dsh-host.test.ts:

- worker request has agentOptions only when explicit or stored default exists;
- absent option leaves the request's exact pre-feature shape;
- explicit beats stored default;
- default map uses the actual leader id, including a host-assigned id;
- a provider without agentOptions capability would reject at start; the live in-process provider advertises it (assert the request shape, not the provider).

test/spawn-dispatcher-host.test.ts:

- leader agentOptions explicit, inherited, and same-route-effort cases;
- worker_model stored in the map and in the mark row;
- refresh restores the map;
- invalid worker_model stores nothing and warns;
- phantom cleanup removes the map entry when create fails;
- the existing nested-leader refusal test still passes.

### 7.5 Durability tests

test/adapter-durable-marker.test.ts:

- round-trip workerModel;
- legacy row without it;
- malformed provider/model rejected;
- no domain version bump (still 2, following the ticket-141 precedent at test/adapter-durable-marker.test.ts:441-463).

### 7.6 Regression tests

- test/spawn-dispatcher-host.test.ts:456-537 existing route inheritance.
- test/adapter-cordis-dsh-host.test.ts:313, 373-433 existing worker request shape.
- test/dispatcher-tools.test.ts:67-94 existing spawn mapping and ack.
- test/multi-dispatcher*.test.ts nested-class rules.
- test/worker-composition.test.ts worker composition unchanged.
- test/feature-flag.test.ts activation surface unchanged.

### 7.7 Commands

Run focused tests while implementing:

    npx tsx --tsconfig tsconfig.client.json --test test/model-option.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-tool.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/dispatcher-tools.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/adapter-cordis-dsh-host.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-host.test.ts
    npx tsx --tsconfig tsconfig.client.json --test test/adapter-durable-marker.test.ts

Full offline gate:

    npm test
    npm run typecheck
    npm run lint:docs

npm test runs the whole offline suite; its pretest builds the vendored libraries. No network or model is needed.

### 7.8 Short manual check

Follow read-before-running-live-and-browser-tests.md: use a trivial task, set a kill timer at launch, and put every artifact under .scratch/testing/<yyyy-mm-dd>-model-arg/.

1. Build and install the checkout (npm run build; add the package to a test dsh profile if not already).
2. Open a fresh dsh chat, run /dsh-bot, and ask the dispatcher to summon one team leader with model set to a valid route and worker_model set to a different valid route. Keep the handoff trivial.
3. Open the leader's session. Its model indicator should show the leader route.
4. Ask the leader to spawn one trivial worker with no model; the worker's session should show the worker default.
5. Ask the leader to spawn a second trivial worker with an explicit model; it should show that model.
6. Ask for an invalid value once. The spawn should still succeed, the tool result should carry the fallback note, and the dsh log should contain one [multitask-dispatcher] warning for the rejected value.
7. Restart dsh, resume the leader, and spawn one more worker with no model; the worker default should still apply. If it does not, check whether the mark row was written before restart and whether refreshDispatcherMarks ran.
8. Kill the process and record the result under the testing folder.

This manual check is the only step that uses a live model; it is intentionally short and trivial.

---

## 8. Edge cases

| Case | Behavior |
|---|---|
| No option at all | Exact today's behavior. Workers: no agentOptions on the activation request; inherit the leader's route. Leaders: agentOptions from the summoner's live route/options. No warning, no note. |
| model: "" or whitespace-only | Treated as omitted. No resolver call, no warning, no note. |
| Unknown provider (nope/model) | Fallback. Spawn proceeds on the default route. Warning + note. |
| Known provider, unknown model (deepseek/nope) | Fallback. Warning + note. |
| Unknown bare id | Fallback. Warning + note. |
| Bare id on two providers | The spawning session's provider wins if it is one of them; otherwise fallback ambiguous-model. |
| Provider/model case differs | Resolves; the catalog's canonical spelling is used. |
| Model id itself contains a slash | Longest registered provider prefix is tried first; if that route is not found, the whole string is tried as a bare id. |
| Spaces around the value | Trimmed. |
| Spaces inside the value | Literal; not split. Usually unknown -> fallback. |
| Newline/tab/control characters | Literal; usually unknown -> fallback. The warning sanitizes them. |
| Very long value | Fallback if unknown; warning truncates the value to 120 characters. |
| Catalog unavailable | Fallback catalog-unavailable; warning + note. Spawn proceeds on the default. |
| Catalog read throws for one provider | That provider is skipped in the bare-id pass; another provider can still resolve. If the explicit provider route throws, fallback catalog-error. |
| Catalog says available, account lacks entitlement | Spawn succeeds; the first request fails. No mid-run fallback. |
| Model removed after spawn | Same as above; the session's next request fails. |
| worker_model invalid | No default stored; workers inherit the leader's own route. Warning + note. |
| model invalid but worker_model valid | Leader falls back to the summoner's route; the worker default is still stored and applies. |
| worker_model set, then user changes the leader's model in the UI | Workers keep the stored default. Omit worker_model if workers should follow the leader's live route. |
| Leader's model changed in the UI after spawn | The UI change wins for the leader session; the spawn option is a starting choice, not a lock. The leader's worker default is unaffected. |
| worker_model passed to spawn_worker | additionalProperties: false rejects it; if a non-validating host passes it through, the handler ignores it. It is not a worker-level field. |
| Team leader tries spawn_dispatcher | Tool is absent from its surface (src/core/tools.ts:1714-1726); direct host call refuses at src/adapter/cordis-dsh-host.ts:3843-3847. |
| Worker tries to spawn | Both spawn tools are denied by the worker barrier (src/worker/tool-barrier.ts:16-73). |
| Model option on a worker after restart | If the mark row restored the default, it applies; otherwise the leader's route is the fallback. |
| Model option with a direct host.spawnWorker caller that bypasses the tool | The host applies opts.model as given; it does not re-validate the catalog. Only the tool path validates. |
| Route object with empty provider/model from a JS caller | Treated as absent; one warning; spawn proceeds on the default. |
| Same explicit model as inherited | The leader keeps the inherited effort/maxTokens; the worker merge sees no route change and keeps effort. |
| Explicit different model | Leader gets {provider, model} only; worker route change clears the parent effort. |
| Parent has a large maxTokens and the new model does not support it | Workers may still inherit maxTokens because the subagent merge keeps it; leader explicit routes drop it. This is a known risk, not silently corrected. |

---

## 9. Risks and mitigations

1. Catalog latency. listModels may hit provider endpoints. Only calls with a non-empty option pay it. If it becomes noticeable, add a short-lived per-provider cache in the host; do not cache across a model-set change event. For v1, measure first.
2. Catalog is advisory and may be incomplete. A valid model that the catalog does not list is treated as unknown and falls back. This matches the GUI's modelAvailable behavior; document it. If the human wants "trust the value even when the catalog is incomplete", that is a policy change and an open question.
3. Entitlement is not entitlement. A catalog hit does not prove the account can use the model. The first request can fail. No automatic fallback; a fallback would require respawning or switching the live session, which is out of scope. The warning/notes cannot cover this case.
4. Context-window mismatch. A new model may have a smaller context window; the leader's handoff or a worker's prompt may not fit. No automatic truncation. The dispatcher should choose a model appropriate for the job.
5. maxTokens inheritance for workers. The subagent merge keeps the parent's maxTokens when the route changes; only reasoning effort is cleared. If the new model rejects the inherited cap, the first worker turn fails. The plan does not invent a new cap; note it in the ADR and test the route/effort behavior, not a live provider.
6. Worker default loss on restart. Mitigated by the dispatcher mark field. If the store is absent or the write fails, the default is lost and workers inherit the leader's route. The failure is already logged like other mark failures.
7. Map key vs host-assigned id. A host may create the leader under an id different from the reservation. The map/mark must be keyed by the actual id and the phantom cleanup must delete the reservation's entry. Test this with the existing id-mismatch fixture.
8. Schema/description churn. Adding optional properties changes exact-key tests and possibly pinned descriptions. Update them deliberately; do not weaken the schema-shape test or the additionalProperties: false guard.
9. Log injection. The raw model value is model-authored. Truncate it and strip control characters before console.warn. It is not a secret, but it should not forge log lines.
10. Future host/provider changes. The worker override relies on SubagentCapabilities.agentOptions. The live in-process provider supports it; a different provider would reject the start with a clear error. If the plugin later swaps providers, gate the feature on the capability and warn once at activation.
11. Ambiguous bare ids. A short id such as "chat" may exist on several providers. Preferring the summoner's provider is a heuristic; the unambiguous form is provider/model. The tool description says so.
12. Prompt text is unchanged. No directive parsing means no prompt stripping bugs. This is the main reason for the shape choice.

---

## 10. Open questions for the human

1. Literal self-model switch. Does "a team leader can set its own model" mean the dispatcher chooses the leader's model at summon time (this plan), or the leader should be able to change its own live model later? A later change would need a separate tool/command that calls agent.model.select on the caller's own session; it also raises what happens to the current transcript and the model-switch notice.
2. Aliases and bare ids. Is provider/model-id plus a unique bare model id enough, or do you also want human display names/aliases accepted? The host has no alias table; display names are provider-supplied labels, not stable ids. This plan accepts no display names in v1.
3. worker_model scope. Is it a default for every worker the leader later spawns (this plan), or only a one-shot value for the first worker? Should the leader itself be able to change its own worker default later, or is that the summoning dispatcher's choice only?
4. Invalid values. The requirement says fall back to the default. Confirm that an invalid value should not refuse the spawn. This plan falls back, logs one warning, and adds a tool-result note.
5. Warning visibility. Is the dsh process log enough, or should the warning also appear in the tool result / UI? This plan puts a short note in the tool result and a full line in the process log; it does not add a UI toast.
6. Restart durability. Should the leader's worker_model survive a restart through the dispatcher mark (this plan), or is in-memory enough? The durable field is a small schema addition but expands the mark row's meaning.
7. Reasoning effort. Should the option also choose a reasoning effort (for example provider/model@high or a second field), or is model-only enough? This plan is model-only and lets a route change clear the inherited effort.
8. Naming. Are model and worker_model the names you want, or would you prefer leader_model / workers_model / default_worker_model? The names are cheap to change before implementation and expensive after.

---

## 11. Order and rough sizes

| Order | Step | Size |
|---|---|---|
| 1 | Ticket + ADR skeleton | S |
| 2 | Contract types + exports | S |
| 3 | Pure resolver + unit tests | M |
| 4 | Tool schemas, handlers, result fields + tests | M |
| 5 | EN/ZH tool descriptions | S |
| 6 | Adapter/plugin resolver wiring | S |
| 7 | Host resolver (catalog, warning) | M |
| 8 | Leader model application | M |
| 9 | Worker model + default map | M |
| 10 | Durable worker default + restore | M |
| 11 | README/ADR/ticket, full gate | S |

Rough total: 2-3 focused days for an engineer who knows this repo, plus one short live check. The largest single file is src/adapter/cordis-dsh-host.ts; the edits there are localized to the two spawn methods, the mark helpers, and the new resolver, not a rewrite.

---

## Appendix A - Evidence index

The paths beginning with dsh- are inside the installed dsh package's node_modules/@deepseek-ai directory (host evidence, not files in this repository). All other paths are relative to this repo.

Tool surface and wiring:

- src/core/tools.ts:829-847 - spawn_worker parameters.
- src/core/tools.ts:848-939 - spawn_worker handler; :907 core call.
- src/core/tools.ts:1626-1646 - spawn_dispatcher parameters.
- src/core/tools.ts:1647-1712 - spawn_dispatcher handler; :1685-1690 seam call.
- src/core/tools.ts:1714-1726 - team leader gets no spawn_dispatcher.
- src/core/tools.ts:125-152 - toToolParametersSchema required-array conversion.
- src/adapter/dispatcher-tools.ts:444-478 - registration and dependency forwarding.
- src/plugin.ts:1401-1436 - toolDeps; :1488-1491 registration.
- src/worker/tool-barrier.ts:16-73 - worker deny list.

Types and seams:

- src/core/types.ts:55-79 - SpawnOptions.
- src/core/types.ts:87-100 - DispatcherSpawnOptions.
- src/core/types.ts:117-127 - SpawnRequest.
- src/core/dsh-host.ts:25 - spawnWorker; :37 - spawnDispatcher.
- src/core/multitask.ts:1263 - spawnWorker; :1364-1375 - host call.

Team-leader path:

- src/adapter/cordis-dsh-host.ts:3827-3909 - refusal, parent, cwd, route.
- src/adapter/cordis-dsh-host.ts:3935-4055 - preset read/store.
- src/adapter/cordis-dsh-host.ts:4037-4056 - ctx.agents.create.
- src/adapter/cordis-dsh-host.ts:4106-4118 - activation under the created id.
- src/adapter/cordis-dsh-host.ts:4146-4167 - mark write.
- src/adapter/cordis-dsh-host.ts:4233-4242 - first turn.
- src/adapter/cordis-dsh-host.ts:1370-1404 - liveSummonerRoute.
- src/adapter/cordis-dsh-host.ts:2668-2708 - writeDispatcherMark.
- src/adapter/cordis-dsh-host.ts:3388-3420 - refreshDispatcherMarks.
- src/adapter/cordis-dsh-host.ts:4262-4281 - phantom cleanup.

Worker path:

- src/adapter/cordis-dsh-host.ts:3647-3688 - parent, depth, request.
- src/adapter/cordis-dsh-host.ts:3729-3736 - startActivation.

Host model capability:

- dsh-agent/lib/types/model-selection.d.ts:32-39 - AgentModel API.
- dsh-agent/lib/types/model-selection.js:81-96 - current/select.
- dsh-agent/lib/types/types.d.ts:68-83, :90-109 - selection shape/event.
- dsh-api-session-controller/lib/types/commands.js:155-179 - GUI validation.
- dsh-api-session-controller/lib/types/catalog.js:68-79 - catalog check.
- dsh-llm/lib/types/index.js:611-613, :804-808 - unknown model/provider.
- dsh-llm/lib/types/types.d.ts:339 - catalog membership advisory.
- dsh-agent-loop/lib/index.js:671-672 - no selection throws.
- dsh-agent/lib/types/model-selection.js:88-92 - select does not validate.

Child options and preset:

- dsh-subagent/lib/types/types.d.ts:115-121 - capabilities.
- dsh-subagent/lib/types/types.d.ts:153-160 - agentOptions contract.
- dsh-subagent/lib/types/child-agent.js:63-91 - merge and effort clearing.
- dsh-subagent/lib/types/manager.js:327 - merge applied.
- dsh-subagent-spawn-in-process/lib/index.js:21-22 - capability true.

Durability:

- src/core/durability.ts:128-153 - DurableDispatcherMark.
- src/adapter/durable-marker.ts:390-416 - parser.
- test/adapter-durable-marker.test.ts:441-463 - optional-field precedent.
- dsh-api-session-controller/lib/index.js:305-317, :440-452 - cold resume default options.

Tests:

- test/spawn-dispatcher-tool.test.ts:107-127 - exact-key test.
- test/spawn-dispatcher-host.test.ts:456-537 - route inheritance and fallback.
- test/adapter-cordis-dsh-host.test.ts:313, :373-433 - worker request.
- test/dispatcher-tools.test.ts:67-94 - spawn mapping.
- test/tool-schema-shape.test.ts:45-90 - schema traversal.
- test/adapter-durable-marker.test.ts:422-484 - mark round-trips.

---

## Appendix B - Alternatives considered and rejected

1. Inline prompt directive. Rejected for the reasons in section 2.2: collision, escaping, two parsers, prompt pollution, no schema guidance.
2. A single model field on spawn_dispatcher that also sets workers. Rejected because the task explicitly asks for two separate choices (the leader's own model and its workers' model). One field cannot express "leader on A, workers on B" without a convention.
3. A new spawn_worker worker_model field to set a default. Rejected: spawn_worker spawns one worker; a "default for future workers" field on a one-worker call is surprising and gives the leader a second way to mutate state. The dispatcher sets the default at summon time; the leader overrides per worker.
4. A global config field for worker model. Rejected: the request is per-leader and per-spawn, not a process-wide default. A global default would also silently change every existing dispatch.
5. Use agent.model.select on the leader instead of agentOptions. Rejected for the initial choice: create already accepts agentOptions, and selecting after create would add an event and a second write before the first turn. agentOptions is the host's creation-time route channel. A future self-switch feature could use select.
6. Refuse invalid values. Rejected by the stated requirement: invalid or unknown falls back to the default. A refusal would also force the dispatcher to retry, which is worse for a background agent.
7. Trust the value without catalog validation. Rejected: unknown provider/model hard-fails at the first request with no fallback. The feature would turn a typo into a dead leader/worker, exactly what the requirement says not to do.
