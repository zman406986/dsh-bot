# Tool-scoping seam: is `ctx.tools.register` process-global or per dispatcher session?

**Question (ADR-0018, verification item):** multiple dispatchers are real — each gets its own dsh
session. Can each session's dispatcher get its own tool scope, given the recorded process-global
`ctx.tools.register` constraint? This gates any multi-dispatcher design work.

**Verdict (2026-09-19, ticket 64):** registration is **process-global** in our code and the
per-session behavior is **our runtime gate**, not a host scope. Confirmed from `src/` only; the
host-side question (does the installed host offer a session-scoped registration surface?) remains
open and is commissioned as ticket 72's first item.

## Evidence (src/, this repo)

1. **Registration rides the plugin-level ctx — one process-wide surface.**
   `src/plugin.ts` (`activateToolSurface`) calls `registerDispatcherTools({ ctx, … })` and
   `registerWorkerAccessTool({ ctx, … })` with the plugin's own `ctx`; both land on
   `ctx.tools.register(...)` (`src/adapter/dispatcher-tools.ts:201`,
   `src/adapter/worker-access-tool.ts:215`). There is no session argument anywhere in the
   registration path — the host's `tools` service is addressed at plugin scope.

2. **Our code additionally pins the surface to a singleton slot.**
   `let activationTools: Array<() => void> = []` with the `if (activationTools.length > 0) return;`
   guard (`src/plugin.ts`, activation lifecycle block): a second activation reuses the first
   registration; deactivation (`deactivateToolSurface`) disposes the lot. Even two activations
   cannot each own a registration today — the design is one dispatcher per process by construction
   (the activation model ADR-0018 voided).

3. **Per-session behavior is an execute-time gate, not a registration scope.**
   `gatedExecute` (`src/adapter/dispatcher-tools.ts:140-155`) resolves the caller's session from
   the tool `exec` context and refuses any session other than the activated one
   (`resolveCallerSessionId`); the gate compares against a **single** id —
   `getSessionId: () => lifecycle.dispatcherSessionId()` (`src/plugin.ts`). The worker-access tool
   gates the same way (`resolveWorkerId` + `host.owns(sessionId)`).

## What multi-dispatcher needs (the two remedies ADR-0018 names)

- **(a) Host-side per-session tool scopes** — register tools into a session/agent-scoped context
  so each dispatcher session's tool set is its own. **Unverified**: whether the installed host
  exposes any such registration seam is unknown; ticket 72 commissions one read-only observation
  pass against the installed `@deepseek-ai/*` packages (same method as ticket 29's firehose
  verification) before any design work.
- **(b) Generalized session-keyed gating (implementable now, no host change)** — keep the single
  global registration, but replace the single-session gate with a
  `callerSessionId → dispatcher state` map: each dispatcher session routes to its own Multitask
  instance / session record, unknown callers still refuse. Design questions: per-session
  `Multitask` instances vs keyed sub-registries, roster/wake-bus keying, and the access-relay's
  per-session policy tables (ticket 30's `clearSession()` already assumes session-scoped rows).

**Gate status:** multi-dispatcher design work is blocked until ticket 72 resolves (a) vs (b);
(b) is the conservative default if the host offers nothing.

**Provenance:** findings read from this repo's `src/` at the commit implementing tickets 57–59;
host-package claims are deliberately absent (the installed host was not read in this pass).
