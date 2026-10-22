# Activation is an explicit user command; the plugin no longer captures the primary chat on load

**Status:** accepted — **2026-10-21 note (0030):** the explicit-activation command's NAME is now `dsh-bot` (was `dispatcher-start`), human-ruled, recorded in 0030; the substance — explicit command activation, no capture on load — stands; the 2026-09-18 retraction note below is a historical record and is untouched

The dispatcher is **not** bound to any chat when the plugin loads. With the feature flag ON the plugin boots **dormant and stock**: the only visible affordance is a host slash command (`dispatcher-start`, `dispatcher-` prefixed namespace). Running that command in a top-level chat **activates** the dispatcher for that session — the live Agent is bound into the host's single parent slot and the session policy is injected once. There is **no deactivate command**: activation is once per session, "off" means the session ended, and workers already spawned run to completion.

## Context

- Until this ADR, the first top-level session to fire `agent/session-start` after plugin load was **captured silently** (`src/adapter/parent-agent.ts`, former session-start branch): policy injected, per-turn reminders, plugin-authored wake turns, and a process-global dispatcher tool surface. The user's primary chat was repurposed without consent.
- Design 16 (`.scratch/multitask-dispatcher/design-16-dispatcher-ui.md` §3) committed the replacement model: default-OFF experience with explicit per-session opt-in via `ctx.commands.register` (verified seam: `docs/research/dsh-plugin-ui-patterns.md` Finding 2 — fiber-scoped registration, auditable `command/run`/`command/done` events, fail-loud name collisions).
- Hard constraint preserved: spawn/interrupt/send authority requires a **live parent Agent bound in a single slot** (`src/adapter/cordis-dsh-host.ts` `bindParent`/`unbindParent`). The binding is **deferred, not removed** — the command moves *when* it happens, nothing replaces it.
- Delivery remains conversational (the dispatcher speaks in the activated chat); `deliverToUser` stays unwired.
- The reference tree must not be opened or imitated (AGENTS.md legal boundary); all command copy here is original.

## Considered options

| Option | Rejected/kept because |
|---|---|
| **A. Explicit slash-command activation, deferred capture (design-16 §3.1a)** | **Chosen.** The only consent-bearing seam verified end to end. Keeps conversational delivery. Smallest diff: the capture body moves from the session-start listener into an activation function called by the command handler. |
| B. Session-scoped flag marker read at session-start | Rejected: needs an unverified session-scoped config source, and has no consent moment — a mis-set marker hijacks silently, the exact bug being fixed. |
| C. Per-chat multi-activation (registry of activated sessions) | Deferred: `ctx.tools.register` is process-global (no verified per-session tool scoping) and the host is single-parent throughout. Core is already sessionId-keyed, so this remains open for later. |
| D. Dedicated UI page / headless daemon agent | Rejected for v1: no verified non-conversational delivery path; breaks the PRD rule that `completed` means **delivered to user**. |

## Consequences

- **No capture on load.** The `agent/session-start` capture branch is deleted. Nothing is bound and no policy is injected until a user runs `/dispatcher-start` in a top-level chat. The `isTopLevel` gate (with its documented fail-open when the session header is inaccessible) moves into the activation path.
- **The parent binding is deferred, not removed.** `activate(agent)` performs exactly the former capture body — `parentAgentRef`/`dispatcherSessionId` set, `host.bindParent(agent, sessionId)`, one `tryInject(agent, assembleSessionPolicy(true))` — into the same single slot. Activation is refused (structured outcome) for non-top-level chats, for a second activation in the active chat (success copy, no re-bind), and while another chat holds the slot (error copy). A torn-down lifecycle (unload) refuses activation outright.
- **Dispatcher tools are deferred.** The five dispatcher tools and `request_access` register when a session activates and unregister when the activation ends (session disposed or plugin unload). Because tool registration is process-global, every dispatcher-tool handler resolves the calling session from the exec shape and refuses non-activated chats with structured copy; when the exec shape cannot be resolved at all, the weaker "an activation exists" gate applies (documented limitation, design-16 §3.8).
- **Reconciliation with ADR-0005 (flag semantics unchanged).** The flag is still read once at `apply`, frozen for the session, and a settings flip affects only the next session. What changes is what ON **means**: "dispatcher **available**", not "primary chat **captured**". The matrix: OFF = fully inert (no core, no command, no tools, no listeners); ON + never activated = dormant (invisible plumbing + the command only); ON + activated = full dispatcher in that chat.
- **Command activation is not the forbidden live toggle.** ADR-0005 forbids flipping the dispatcher OFF while it runs. Activation creates a session-scoped state that lives exactly as long as the session and is never flipped off while running: there is no deactivate command, session end unbinds (workers keep running to completion per ADR-0005's superseded-but-spiritually-retained rule), and re-activation after a session ends is a fresh, explicit `/dispatcher-start`.
- **HMR/unload reverses everything.** The plugin registers the command through `ctx.commands` and tears down via its effect dispose: listeners detached, lifecycle unbound (refusing later activation), tool surface unregistered, host disposed, marker domain released. ADR-0006 durable markers survive so the next activation re-attaches the roster and queued wake material flushes normally.
- Plugin `inject` now also declares `commands` (the host command registry), matching how `tools` was declared for the tool surface.

---

## RETRACTION NOTE (2026-09-18, later the same day)

The human has corrected the record: the premise attributed to them in the Context section — that activation must be an **explicit user command** — is a **hallucinated understanding, not what the human said**. The human's actual instruction was: **"human can toggle activation."**

This ADR's *mechanics* (deferred parent binding, process-global tool gating) may survive into whatever replaces it, but its **consent story and activation matrix are void**. SUPERSEDED (2026-09-18): **ADR-0018** — "imitate the reference in its entirety, except an enumerated exception list" — replaces the activation model wholesale: no command, no mode, no dormant state; the wrapper surface is the dispatcher.
