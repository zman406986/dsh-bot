# 132 — The access policy tells the model to call `resolve_access`, a tool that does not exist

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing
**Related:** ticket 119 (its 2026-10-22 comment recorded this as a contradiction found but out of scope — "needs its own ticket"), ADR-0008 (the structured access relay: worker ask → wake/gated policy → answer by `sendMessage`; it names no model-facing resolve tool), ADR-0009/ADR-0019 (per-session dispatcher tools), ticket 30 (Allow / Always allow / Deny option set and the wildcard fence), ticket 71 AC-4 (prompt location line)

## Problem

`buildAccessPolicyBlock()` (`src/core/policy/prompts.ts:209-223`) is appended to every access section of a wake turn. Its answer line, `src/core/policy/prompts.ts:216`, reads:

> `- Answer with resolve_access (allow or deny). Never leave an ask unanswered — timeout denies by default.`

No tool named `resolve_access` is registered on any surface in this repo.

## Verification (2026-10-22, checked against code)

The registration lists, the tool factory, and the worker-local list were each read; a `src/`-scoped grep for `resolve_access` returns exactly one hit — the policy line itself. (A whole-repo grep also hits this ticket's own text, ticket 119's discussion of it, the generated index, and the research note cited in item 5; none of those is a registration.)

1. **The dispatcher surface is eight tools.** `DISPATCHER_TOOL_NAMES` (`src/core/policy/prompts.ts:53-62`) lists `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker`, `deliver_result`, `message_agent`, `await_agent`, `spawn_dispatcher`. `createDispatcherTools()` returns exactly those eight defs (`src/core/tools.ts:1426-1435`); `registerDispatcherTools` registers them 1:1 (`src/adapter/dispatcher-tools.ts:216-243`). No `resolve_access`.
2. **The worker surface is one tool.** `WORKER_LOCAL_TOOL_NAMES` is `[reply_to_dispatcher]` (`src/worker/agent-def.ts:19`).
3. **The global worker ask is a different verb.** `request_access` (`src/adapter/worker-access-tool.ts:27`) is a worker-only registration (refcounted at the plugin level, `src/plugin.ts:806`); its handler refuses non-workers with "request_access is only available to workers." (`src/adapter/worker-access-tool.ts:156`). It creates asks; it does not answer them.
4. **Nothing else registers a decision-taking tool.** The only tool-name constants in the tree are the eight dispatcher tools plus `request_access` and `reply_to_dispatcher`; no tool takes an `AccessDecision` argument.
5. `docs/research/reference-architecture-patterns.md:83` already flags the same leftover ("the policy text says 'answer with resolve_access' but the product never registers that tool") — evidence only, never a ruling.

## How an access ask is actually answered today

1. A worker calls `request_access`. The handler emits the ask through the host; the core relay picks it up (`src/core/multitask.ts:830-836`).
2. The relay looks the ask up in the session + profile policy table before anything wakes (`src/core/access-relay.ts:291-322`). A matching allow/deny row **auto-answers** through `host.sendMessage` — no wake, no prompt, no ticket.
3. Otherwise the ask is **parked as a ticket** with a deny-by-default timeout (120 s, `DEFAULT_ACCESS_TIMEOUT_MS`, `src/core/access-relay.ts:19`; config `accessRequestTimeoutMs` overrides), and an access-request wake is enqueued (`src/core/multitask.ts:581-589`).
4. **Human path, live:** while the dispatcher session is activated and the host prompt seam exists, the ticket is presented by `ctx.userQuestions.ask` with Allow / Always allow (this session) / Deny (`src/adapter/access-prompt.ts:299-323`; pump at `:479-604`). An explicit answer routes into `Multitask.resolveAccess` (`src/adapter/access-prompt.ts:541-547`; wired in `src/plugin.ts:695-702`). While the prompt owns the ask, the ask is **suppressed from the wake text** (`suppressPromptedAccessAsk`, `src/plugin.ts:372-373`; predicate `src/adapter/access-prompt.ts:598-602`), so the model often never sees it at all.
5. **Human path, command:** `/dispatcher-resolve <workerId> <allow|always-allow|deny>` (`DISPATCHER_RESOLVE_COMMAND`, `src/adapter/resolve-command.ts:35`; handler `:157-204`) routes into the same `Multitask.resolveAccess` (wired at `src/plugin.ts:1296-1318`). It gates on the invoking chat being an activated dispatcher. Client approval-card buttons build and execute that same command line (`src/client/actions.ts:315-320`, `:330-350`), but the approval pane is retained, unmounted machinery in the default posture.
6. **Model path: none.** `Multitask.resolveAccess` has exactly two call sites, both human-driven: the prompt pump (`src/plugin.ts:702`) and the resolve command (`src/plugin.ts:1305`). There is no tool, no command-execution tool, and no chat-text parser that takes a plain-language "allow" from the user and routes it. So when the seam is absent and the ask renders in the wake, the model is told to answer and can only sit until the timeout denies.

The block is appended unconditionally to any access section, including a **denial-only** wake where there is nothing left to answer (`assembleAccessSection`, `src/core/policy/assembler.ts:423-472`; the append at `:471`). So the dead instruction reaches the model even on turns with no pending ask.

## Why this is a bug, not prose preference

The model-facing doctrine names a verb that can only fail. If a model follows it, the provider rejects the call as an unknown tool; the ask stays parked and is denied by timeout. If a model does not follow it, the plain-language clause above it ("Ask the user in plain language…", `:214`) is also a dead end: the user's reply has no parser and the model has no way to route it. The only working answers are the human prompt or the human command, neither of which the doctrine mentions.

ADR-0008 does not require a model-facing tool: its decision table routes answers through `host.sendMessage` and leaves the deciding actor open. So the contradiction is between the policy text and the shipped surfaces, not between two ADRs.

## Options (this ticket picks none)

1. **Register a dispatcher tool `resolve_access`** (allow/deny only — no `always-allow`; a model asking for a remembered consent row is a consent trap). Handler routes to `Multitask.resolveAccess` with session scoping. This matches what the doctrine already tells the model, and what ticket 119 predicted. Needs a decision on whether the model may deny on its own or only relay the user's choice.
2. **Rewrite the policy line to name the real path** — the user answers through the approval prompt, or types `/dispatcher-resolve`. Cheapest; no code moves. The block's "Ask the user in plain language" line then needs to say what the user must do next.
3. **Both**: name the human path and add the tool as an optional fast path.

Whichever is chosen, the unconditional append to denial-only wakes should be reconsidered.

## Evidence

`src/core/policy/prompts.ts:209-223` (block; dead line at `:216`), `:53-62` (eight names); `src/core/tools.ts:1426-1435` (eight defs), `:339` (`reply_to_dispatcher`); `src/worker/agent-def.ts:19`; `src/adapter/worker-access-tool.ts:27`, `:156`; `src/core/access-relay.ts:19`, `:291-340`; `src/core/policy/assembler.ts:423-472`; `src/adapter/access-prompt.ts:299-323`, `:479-604`; `src/adapter/resolve-command.ts:35`, `:157-204`; `src/client/actions.ts:315-320`; `src/plugin.ts:372-373`, `:695-702`, `:806`, `:1296-1318`; `src/core/multitask.ts:581-589`, `:830-836`, `:1398-1407`.

No live run was needed: every claim above is a registration list, a call-site count, or a read of the shipped copy.

## Constraints

- This ticket files the contradiction; it does not edit `src/`. Ticket 119 remains the owner of the policy-text pass and was not modified.
- Option 1 must not offer "always allow" to the model. ADR-0008 and ticket 30 make the remembered row a human consent act.
- Do not invent a second answer seam: both options route through the existing `Multitask.resolveAccess`.

## Comments

### 2026-10-22 — filing

Filed from ticket 119's 2026-10-22 comment ("Contradiction found, not fixed", item 1), which flagged the line and said it needed its own ticket. Re-verified independently before filing: the eight-tool surface, the single worker-local tool, the worker-only `request_access`, and the two human-driven call sites of `Multitask.resolveAccess`. The line number in the flag was `:210`; the function starts at `:209` and the dead instruction is `:216`. Nothing was copied out of ticket 119, which stays as it is.
