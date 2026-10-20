# Tool scoping: is `ctx.tools.register` process-global or per dispatcher session?

**Question (ADR-0018, verification item):** multiple dispatchers are real — each gets its own dsh
session. Can each session's dispatcher get its own tool scope, given the recorded process-global
`ctx.tools.register` constraint? This decides whether any multi-dispatcher design work can start.

**Verdict (2026-09-19, ticket 64):** registration is **process-global** in our code, and the
per-session behavior is **a check our own code performs at execution time**, not a host scope. Confirmed from `src/` only; the
host-side question (does the installed host offer a session-scoped registration surface?) remains
open and is commissioned as ticket 72's first item.

## Evidence (src/, this repo)

1. **Registration uses the plugin-level ctx — one surface for the whole process.**
   `src/plugin.ts` (`activateToolSurface`) calls `registerDispatcherTools({ ctx, … })` and
   `registerWorkerAccessTool({ ctx, … })` with the plugin's own `ctx`; both land on
   `ctx.tools.register(...)` (`src/adapter/dispatcher-tools.ts:201`,
   `src/adapter/worker-access-tool.ts:215`). There is no session argument anywhere in the
   registration path — the host's `tools` service is addressed at plugin scope.

2. **Our code also allows only one set of registrations at a time.**
   `let activationTools: Array<() => void> = []` with the `if (activationTools.length > 0) return;`
   guard (`src/plugin.ts`, activation lifecycle block): a second activation reuses the first
   registration; deactivation (`deactivateToolSurface`) disposes the lot. Even two activations
   cannot each own a registration today — by construction, the design allows only one dispatcher
   per process (the activation model that ADR-0018 cancelled).

3. **Per-session behavior is a check at execution time, not a separate registration scope.**
   `gatedExecute` (`src/adapter/dispatcher-tools.ts:140-155`) resolves the caller's session from
   the tool `exec` context and refuses any session other than the activated one
   (`resolveCallerSessionId`); the check compares against a **single** id —
   `getSessionId: () => lifecycle.dispatcherSessionId()` (`src/plugin.ts`). The worker-access tool
   checks the same way (`resolveWorkerId` + `host.owns(sessionId)`).

## What multi-dispatcher needs (the two fixes ADR-0018 names)

- **(a) Host-side per-session tool scopes** — register tools into a session/agent-scoped context
  so each dispatcher session's tool set is its own. **Unverified**: whether the installed host
  exposes any such registration surface is unknown; ticket 72 commissions one read-only reading
  pass against the installed `@deepseek-ai/*` packages (same method ticket 29 used to verify the
  event stream) before any design work.
- **(b) Session-keyed checks, made general (implementable now, no host change)** — keep the single
  global registration, but replace the single-session check with a
  `callerSessionId → dispatcher state` map: each dispatcher session routes to its own Multitask
  instance / session record, unknown callers still refuse. Design questions: per-session
  `Multitask` instances vs keyed sub-registries, roster/wake-bus keying, and the access-relay's
  per-session policy tables (ticket 30's `clearSession()` already assumes session-scoped rows).

**Status:** multi-dispatcher design work is blocked until ticket 72 resolves (a) vs (b);
(b) is the conservative default if the host offers nothing.

**Provenance:** findings read from this repo's `src/` at the commit implementing tickets 57–59;
host-package claims are deliberately absent (the installed host was not read in this pass).

## Update 2026-09-19 (ticket 72): a host-side registration surface EXISTS — option (a) is available

Read-only reading pass against the **installed** `@deepseek-ai/*` packages, all
`0.1.5-rc.2`, located from scratch this pass (following the lesson in `dsh-local-install.md`): the flat profile
tree `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` is the cited tree; the WinGet
copy (`...\node-v24.19.0-win-x64\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`)
was cross-checked and its `dsh-tools` is the same version. Never the reference tree.

**Verdict: the host offers a real per-agent-scoped tool registration surface.** `register` writes
into the registry layer chosen by **the scope tag of the calling context** — and every Agent's
context IS a scoped context created per agent by the agent loop. Concretely:

1. **Every agent loop creates its own scope.** `dsh-agent-loop/lib/index.js:761-763`:
   `this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx;` — the scope key is the
   loop instance itself. `Agent.ctx` is that scoped context
   (`dsh-agent/lib/types/runtime-types.d.ts:149`).
2. **`tools.register` chooses its layer from the calling ctx.**
   `dsh-tools/lib/types/index.d.ts:595-601`: "Register globally or in the calling agent scope.
   Scoped tools shadow globals." Implementation `dsh-tools/lib/index.js:2773,2781`:
   `this.layers.effect(this.ctx, …)`; `ScopedLayers.effect` reads the layer from
   `scopeOf(ctx)` (`dsh-scope/lib/index.js:189-190`). The `restrict` error message names the
   requirement outright (`dsh-tools/lib/index.js:2792`): "requires a scoped context **(agent.ctx)**".
   So `agent.ctx.tools.register(def)` = per-agent registration; plain `ctx.tools.register(def)`
   = the global layer we use today.
3. **What the model sees is resolved per agent scope.** Prompt assembly carries the agent as
   the scope: `assembleContextFor` returns `{ agent, scope: agent }`
   (`dsh-agent/lib/index.js:258-264`), and the registry wires
   `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`
   (`dsh-tools/lib/index.js:2609`) over `view(scope)` (`lib/types/index.d.ts:641-645`).
4. **Inheritance flows DOWN the chain only — so the reference's visibility rule holds structurally.** Registration
   views inherit down the scope-parent chain, nearest layer wins (`dsh-scope/lib/index.js:234,
   162-181`). Parent links are created exclusively by `dsh-agent-presets`, from an agent key to
   its preset's **standing composition** key (`dsh-agent-presets/lib/index.js:1504,1538,1702`)
   — "this is how a child agent inherits its parent's capabilities" (same standing preset), not
   to the delegating chat's loop scope. A dispatcher's tools registered through that
   dispatcher's `agent.ctx` are therefore visible to that agent's scope alone: worker children
   never see them (workers stay leaves; ADR-0018 conformances), and a second dispatcher never
   sees the first's. Execute-time identity is the same key (`exec.agent` routes
   `tools/*` waterfalls via `scopeTarget`, `dsh-tools/lib/types/index.d.ts:34-38`).
5. **Lifetime matches activation.** The registration is an effect on the calling ctx's fiber
   (`ctx.effect`, `dsh-scope/lib/index.js:192-217`) with an idempotent undo — it unregisters
   when the agent scope is disposed (session end / HMR), and the returned disposer still allows
   explicit unregister on our deactivation path.

Consequence: option **(a)** is available, and (b)'s session-keyed *checks* are subsumed: per-scope
visibility (the model never sees another dispatcher's tools) is strictly stronger than a refusal
copy at execution time. What remains to generalize is not the check but the **state keying**
behind the surface (lifecycle single slot, host single parent, stream-key collision domain,
session-scope access rows, roster publish) — designed in
`docs/adr/0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md` (draft, pending human
sign-off); implementation is ticketed separately per repo rule.
