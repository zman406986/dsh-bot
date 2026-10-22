# 130 — A spawned dispatcher has no durable identity: a restart turns it back into a plain subagent

**Status:** resolved
**Labels:** needs-triage (kept as filed; the closure is recorded in the Resolution section, not a label move)
**Blocked by:** nothing
**Related:** ticket 118 (verification pass, 2026-10-22 — the source of these facts), ADR-0027 (§Starting identity and dispatch item 4 — dispatcher identity is `agentPreset === 'multitask-dispatcher'`, conditional), ADR-0025 (a summoned dispatcher is a peer and keeps its own state), ticket 123 (session-kind indicators), ticket 104 (resolved 2026-10-22 as obsolete — that was a *false-positive* row from the removed settings mirror; this ticket is the opposite direction, a *missing* durable mark, and was the live gap until the 2026-10-22 resolution), ticket 138 (the two residual halves — message resume and the sidebar glyph — split out at this ticket's 2026-10-22 resolution)

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

## Resolution — 2026-10-22 — identity half implemented

The identity half is built. At spawn, after the host accepts the child, we write one row into a new `dispatcher_sessions` table in the existing marker store, keyed by the child's session id (`src/adapter/cordis-dsh-host.ts:1384`; table name and no version bump at `src/adapter/durable-marker.ts:50`, `:67`, write/read at `:444-453`). On `agent/created` we read that row first and route a marked child through the SAME activation the spawn hook uses: role, the eight scoped dispatcher tools, one policy inject (`src/adapter/cordis-dsh-host.ts:949-974`, `:1011-1014`; `src/adapter/parent-agent.ts:408-423`). A second resume does nothing twice, and a child with no row stays a plain subagent. Rows are never deleted, because deactivation also runs on plugin unload; a failing write is logged and swallowed, so a marker problem never reads as a host refusal. `delegationDepth` is not recomputed and ADR-0027 is untouched — the mark is ours, not `agentPreset`.

This is option 2's shape with one difference: the read rides `agent/created`, not a boot-time walk, so no new boot hook exists. The listener does not filter on `source`; the mark itself is the gate. The store is the existing marker domain — ADR-0006 / A5 ("our own progress in dsh's own store") plus ticket 124's no-version-bump precedent — so no ADR had to move first.

Evidence: `test/adapter-durable-marker.test.ts:332`, `:343`, `:362` (3 tests — table declared without a bump, write/read in the same domain, malformed row rejected); `test/spawn-dispatcher-activation.test.ts:912`, `:932`, `:992`, `:1027` (4 tests — mark written at spawn, cold resume re-activates role/8 tools/one policy, repeat resume does not double-register, no-mark child stays plain); `test/spawn-dispatcher-host.test.ts:376`, `:391`, `:409` (3 tests — mark written after the spawn resolves, a refused spawn writes nothing, a failing write never turns an accepted spawn into a refusal). 135 tests green in the grouped runs, including the restart-honesty canary. The ticket's original identity probe also stands unchanged: the HOST's own facts still say nothing (`test/spawn-dispatcher-activation.test.ts:849`).

**Acceptance, mapped to this ticket's own "What a restart actually loses" list.** This ticket carries no acceptance checkboxes — it is an options ticket that "picks none" — so its loss list is the thing its closure is judged on.

- [x] **dispatcher status** — `isDispatcherSession(child)` is true again after a marked resume; pinned by the cold-resume test (`await_agent` answers `not-awaitable`, `test/spawn-dispatcher-activation.test.ts:932`).
- [x] **its tool surface** — the eight dispatcher tools are re-registered in the child's own scope (`test/spawn-dispatcher-activation.test.ts:932`).
- [ ] **peer acceptance** — moved to deferred, ticket 138. The fence accepts once the child is live again, but nothing resumes it on a send: for a child the host has not re-announced, `sendPeer` still refuses `unknown-target` at `src/core/multitask.ts:1484-1489`.
- [x] **`not-awaitable` classification** — restored by the same re-activation (`src/core/settle-records.ts:473-480`, pinned at `test/spawn-dispatcher-activation.test.ts:932`).
- [x] **dispatcher wake and ledger keying** — restored by the same activation (`bindActivation` calls `host.bindParent` and `onActivated`, `src/adapter/parent-agent.ts:367-381`), not separately asserted by the new tests.
- [ ] **sidebar kind / glyph for the child** — moved to deferred, ticket 138. From the Problem section, not the loss list: the client still resolves the child as `worker` because `origin === "subagent"` wins first (`src/client/session-kind.tsx:149`), and this ticket's "What is NOT proposed here" forbids changing that order.

Two recorded limits, split out at this resolution (ticket 138):

1. **Message resume.** After a restart the creator still cannot message the spawned dispatcher: `sendPeer`'s liveness fence refuses `unknown-target` at `src/core/multitask.ts:1484-1489` because nothing brings the child back on demand. Completing it needs send-triggered cold resume plus a fence change, which reopens ticket 70's phantom-target rule — a recorded ruling (ticket 70 §2, `resolved/70-peer-tier-dispatcher-to-dispatcher-messaging.md:242-248`) and therefore a dated human decision.
2. **Sidebar glyph.** The client derives kind from the roster/preset side, and only a preset row reaches it — ADR-0027 §Starting identity and dispatch item 4 condition (a) records that no dispatcher preset row exists. An independent preset does not inherit the parent composition, so the row would have to declare the child's whole tool set and prompt; that is a real design task, not yet ruled in detail.

Both live in `Issue-tracker/deferred/138-spawned-dispatcher-resume-and-glyph.md`. This ticket closes on the identity half only; it does not claim the peer send path or the glyph.
