# 130 — A spawned dispatcher has no durable identity: a restart turns it back into a plain subagent

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing
**Related:** ticket 118 (verification pass, 2026-10-22 — the source of these facts), ADR-0027 (§Starting identity and dispatch item 4 — dispatcher identity is `agentPreset === 'multitask-dispatcher'`, conditional), ADR-0025 (a summoned dispatcher is a peer and keeps its own state), ticket 123 (session-kind indicators), ticket 104 (a stale dispatcher mirror survives a restart — same restart-honesty family, different surface)

## Problem

A spawned dispatcher exists only in memory. Its session carries no durable mark saying "I am a dispatcher". The only signal is the in-process lifecycle registry (`isDispatcherSession`, `src/adapter/parent-agent.ts:163`), and that dies with the process.

Verified facts (ticket 118's 2026-10-22 verification pass, checked against code):

1. **The child header carries two facts.** `origin: 'subagent'` and `delegationDepth`. The host writes both in `childSessionMeta` (extracted 0.2.1 tree, `deepseek-ai-dsh-subagent-0.2.1-rc.2/lib/index.js:346-357`; `origin` at `:354`, depth at `:355`).
2. **`agentPreset` is inherited, not selected.** `:348` reads `selectedPreset ?? parent's composed preset`. Mitosis selects none (`src/adapter/cordis-dsh-host.ts:1050-1051` — the activation spec has no `agentPreset` slot and the spawn deliberately omits it), so the child reports the parent's `standard`.
3. **The session-kind fold never fires for the child.** It folds a `/dsh-bot` `command/run` + `command/done` pair. The verifier called the real `applySessionKindProjection` over a child-shaped log: `active: false`, wire value `null`. The same fold on a `dsh-bot` pair yields `"dispatcher"`.
4. **The client draws the child as a worker.** `resolveSessionKind` (`src/client/session-kind.tsx:153-165`) tests `origin === 'subagent'` first (`:157`) and returns `"worker"`. The creator renders as a dispatcher.
5. **Nothing compensates on restart.** `rebuildFromDurability` has one call site (`src/plugin.ts:933`, inside `rebuildAndNotice`), reached only from `onActivated`. `activateSpawnedDispatcher` is reached only from the spawn hook (`src/adapter/cordis-dsh-host.ts:761`). There is no boot-time walk of persisted sessions and no session-start re-registration.

ADR-0027 already records the intended identity as `agentPreset === 'multitask-dispatcher'`, **conditional** on such a preset existing and landing on live sessions. Condition (b) fails: the spawned child reports `standard`. `src/client/index.ts:304-305` records the same thing from the client side: "`agentPreset` is unusable here (every durable header reads 'standard')". `appendPluginRecord` is not available to third-party plugins, so a log marker cannot simply be invented, and no marker was invented.

## What a restart actually loses

After a process restart the child is an ordinary subagent in the host. It loses:

- **dispatcher status** — `isDispatcherSession(child)` is false;
- **its tool surface** — the eight dispatcher tools registered through its own scope are gone;
- **peer acceptance** — a `message_agent` send to it answers `unknown-target` instead of accepting (the liveness fence is `isLiveDispatcherSession`, `src/plugin.ts:659`);
- **`not-awaitable` classification** — `await_agent` on it no longer resolves as a dispatcher (`src/core/settle-records.ts:437`);
- **its dispatcher wake and ledger keying**.

Nothing can re-derive the identity, because the marker was never written. When the creator later summons a dispatcher it creates a different session; the old child stays a plain subagent.

## Options (this ticket picks none)

1. **A real preset row.** Register a `multitask-dispatcher` preset and select it at spawn, if the installed activation spec has a slot a third-party plugin may use. This is ADR-0027's own condition (a). If it works, `agentPreset` becomes durable and the client kind follows for free.
2. **A durable side table keyed by session id.** Write `(sessionId, 'dispatcher')` into our own persisted store at spawn, read it on boot, re-register the marked sessions. Needs a boot hook that does not exist today and a ruling on which store may hold it.
3. **Parent-side re-registration on boot.** When a creator activates, it walks its own subagent lineage, asks the host which children are still live, and re-registers the ones it spawned as dispatchers. Keeps the knowledge in the parent; needs lineage enumeration and a rule for children whose creator is gone.
4. **Accept the reduced shape and document it.** A spawned dispatcher is session-scoped: it lives while the process lives. Cheapest; turns today's behaviour into the contract and must be written into the PRD, not left implied.

Each option has a cost the owner should weigh. This ticket does not choose one.

## What is NOT proposed here

- **No invented marker.** No `appendPluginRecord`, no fabricated `agentPreset` field on the activation spec.
- **No gate, cap, or refusal class.** Bounds are ticket 131's question.
- **No change to `resolveSessionKind`'s `origin`-first order.** A worker's `origin` must keep winning (ADR-0027 §Settled 5) or workers get labelled dispatchers.

## Evidence

Code: `src/adapter/cordis-dsh-host.ts:1050-1051` (no preset in the spec), `:1088-1089` (depth derivation), `:761-780` (activation hook, a throw is logged and swallowed); `src/adapter/parent-agent.ts:163` (`isDispatcherSession`), `:367-382` (`bindActivation`); `src/plugin.ts:631-633` (hook wiring), `:933` (single rebuild call site); `src/client/session-kind.tsx:153-165`; `src/client/index.ts:304-305`. Pinned by `test/spawn-dispatcher-activation.test.ts` ("identity probe: the spawned child carries no durable dispatcher mark"). Host source cited from the extracted 0.2.1 tree, not this repo.

The fold result was obtained by calling the real function, not by reading it — that is the difference between a claim and a check.

## Constraints

- No live run is needed to file this. Any live confirmation of a restart belongs to whichever option the owner picks.
- ADR-0027 and ADR-0025 are the authority. If an option changes either, the ADR moves first.

## Comments

### 2026-10-22 — filing

Filed from ticket 118's verification pass (its 2026-10-22 comment, "Finding 2"), which confirmed the gap against the installed 0.2.1 host source and by calling `applySessionKindProjection` and `resolveSessionKind`. Ticket 118's chunk-3 agent had already recorded a reduced shape; the verifier confirmed it independently and added the restart analysis. Labelled `needs-triage`: the next step is an owner choice among four options, not an implementation.

Nothing was copied out of ticket 118; that ticket is untouched, and this ticket holds the record.
