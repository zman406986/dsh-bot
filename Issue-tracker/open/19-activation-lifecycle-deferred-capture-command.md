# 19 — Activation lifecycle: deferred capture + /dispatcher-start + flag matrix + ADR-0009

**Blocked by:** None — can start immediately.
**Status:** open

## Problem

The dispatcher captures the first top-level session on load (`src/adapter/parent-agent.ts:99-116`): with the flag ON, the user's primary chat is silently repurposed — policy injected, per-turn reminders, plugin-authored wake turns — and ADR-0005 makes it irreversible for that session. Design 16 (§3, `.scratch/multitask-dispatcher/design-16-dispatcher-ui.md`) ends the hijack: the parent binding is **deferred, not removed**, and activation becomes an explicit user command.

## What to do

- [ ] In `src/adapter/parent-agent.ts`: delete the `agent/session-start` capture branch; export an `activateDispatcher(agent, sessionId)`-style function containing the relocated capture body (`parentAgentRef`/`dispatcherSessionId` set, `host.bindParent(agent, sessionId)`, `tryInject(agent, assembleSessionPolicy(true))`). Keep `agent/disposed` unbind and the passive `agent/status` listener (it early-returns with no capture).
- [ ] In `src/plugin.ts` (flag ON path): register a `dispatcher-start` host command via `ctx.commands.register` (seam contract: `docs/research/dsh-plugin-ui-patterns.md` Finding 2 — handler receives `{commandId, agent, rawInput, attachments, signal}`, returns `{kind: "success"|"error", text}`). Handler: gate on `isTopLevel` (fail-open preserved), refuse double activation (same chat: success copy; other chat: error copy), then call the activation function and return success copy.
- [ ] Defer the five dispatcher tools + `request_access` registration into the activation path (preferred). Fallback if in-handler registration is awkward: apply-time registration + handler gate — record which was shipped in the ticket.
- [ ] Tool execution gate: each dispatcher tool handler resolves the calling session from the exec shape (idiom at `src/plugin.ts:211-227`) and refuses non-activated sessions with structured error copy. Fallback gate (`getSessionId() !== null`) only if exec resolution proves unreliable — document the weaker guarantee.
- [ ] Flag matrix per design §3.7: OFF = fully inert (existing early return unchanged); ON = dormant with command only; ON + activated = full dispatcher. No change to ADR-0005 read-once-freeze semantics.
- [ ] Copy from design §6 (`dispatcher-start` descriptions/success/errors, tool-gate refusal) as new clean-room strings in the command module.
- [ ] Write `docs/adr/0009-activation-explicit-command-no-capture-on-load.md`: no capture on load; deferred parent binding; reconciliation with ADR-0005 (flag ON means *available*, not *captured*; command activation is once-per-session, no off-while-running state, hence not a forbidden live toggle). Update the ADR index (`docs/adr/README.md`).
- [ ] Rewrite the affected tests: `test/adapter-policy-inject.test.ts` and `test/plugin-scaffold.test.ts` currently assert capture-on-session-start — that behavior is deleted. Add FakeDshHost/fake-invocation tests: dormant apply captures nothing on simulated session-start; activation binds + injects exactly once; isTopLevel refusal; double/elsewhere activation; `agent/disposed` unbinds; dispose-all reverses everything (HMR simulation); tool gate accept/refuse; flag matrix.

## Constraints

- Offline tests only (S8): FakeDshHost / fake seams / fake command invocation; no network, no LLM, no running dsh.
- The parent binding stays a single slot; `spawnWorker`/`interruptWorker`/`sendMessage` remain parent-relative (`src/adapter/cordis-dsh-host.ts:224, 258-261, 336-339, 381-398`) — defer the binding, never remove it.
- Clean-room: command names `dispatcher-` prefixed; all copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- Command names are globally unique and fail loud on collision (Finding 2) — if `dispatcher-start` collides, pick the replacement and record it here.
- No changes to `src/core/` semantics; the core is unchanged by activation (sessionId-keyed already).
