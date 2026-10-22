# 138 — A resumed spawned dispatcher cannot be messaged, and has no sidebar glyph

**Status:** deferred
**Labels:** needs-info
**Deferred:** 2026-10-22 — blocked on two human decisions (ticket 70's phantom-target fence rule; ADR-0027 condition (a) plus a preset-row design); the comment below records the split, the blockers, and the reopen gates.
**Blocked by:** (1) a dated human ruling amending ticket 70's fence rule for message-triggered resume; (2) a ruled preset-row design for the child's glyph (ADR-0027 §Starting identity and dispatch item 4, condition (a)). Both are human decisions; neither can be made from the code or the recorded rules.
**Related:** ticket 130 (resolved 2026-10-22 — the identity half; this ticket is its residual), ticket 70 (resolved — §2 produced the `unknown-target` liveness fence this ticket would change), ADR-0027 (§Starting identity and dispatch item 4 condition (a) — no dispatcher preset row exists; §Settled 5 — `origin` wins for workers), ADR-0025 (a summoned dispatcher is a peer and keeps its own state), ticket 123 (session-kind indicators — the glyph machinery), ADR-0024 rider + addendum (the one licensed glyph registration)

## Problem

Ticket 130 gave a spawned dispatcher a durable identity. A marked child is now re-activated on `agent/created` with `source: "resume"`. Two halves of the original loss list are still open, and both need a decision before code moves.

## Residual half 1 — message resume

After a restart the creator still cannot MESSAGE the spawned dispatcher.

`sendPeer` checks the target against `isLiveDispatcherSession` before it touches the inbox and refuses with `unknown-target` when the target is not currently an activated dispatcher (`src/core/multitask.ts:1484-1489`; wired to `lifecycle.isDispatcherSession` at `src/plugin.ts:658-659`). Ticket 130 re-activates a marked child only when the host announces it on `agent/created` — a cold resume driven by the host. Nothing resumes the child on a SEND, so a child that has not been re-announced answers `unknown-target`.

Completing this needs two things together:

- **Send-triggered cold resume.** The host's `ctx.subagents.sendMessage` cold-resumes an absent child (`docs/research/dsh-adapter-api-notes.md:83`, `:104`). Reading a mark and resuming the child before the fence is consulted is the shape.
- **A fence change.** The fence must stop refusing a marked-but-not-yet-live target, or check the mark first. That is exactly ticket 70's phantom-target rule: the fence exists so a sloppy send is refused instead of acking into an inbox nothing will ever drain (`resolved/70-peer-tier-dispatcher-to-dispatcher-messaging.md:242-248`; the design rationale is quoted at `src/core/multitask.ts:217-224`). Widening the fence to accept a target that is only durably known re-opens that rule.

**Blocker: a dated human decision.** Ticket 70's ruling is recorded, so an agent cannot amend it. The ruling must say which targets count as live enough to accept — a mark-only target, a resumed target, or some narrower set — and it must say what an accepted send does while the resume is still in flight.

**Also note.** Ticket 57 R4 records that our non-use of cold-resume is a core design decision, not an oversight, and that reversing it is a separate decision (`src/core/multitask.ts:1337-1339`). A send-triggered resume for dispatcher children would be a narrow reversal of that posture, and the ruling above should say so explicitly rather than leave it implied.

## Residual half 2 — sidebar glyph

The spawned child renders with no dispatcher glyph. The client draws a dispatcher from `projectionValues.sessionKind === "dispatcher"` (`src/client/session-kind.tsx:151-156`), and that projection folds the `/dsh-bot` `command/run` + `command/done` pair the host writes into the invoking session's own log (`src/adapter/session-kind-projection.ts:201-272`). A spawned child never runs a command, so it folds to `null`.

The client resolves kind from the roster/preset side: `origin === "subagent"` is tested FIRST and returns `worker` (`src/client/session-kind.tsx:149`). A preset row is the only other durable route to the glyph — ADR-0027 §Starting identity and dispatch item 4, condition (a): a preset id must exist and be selected at activation before a dispatcher session carries `agentPreset` (`docs/adr/0027-peer-awareness-pushed-at-prompt-tail.md:34`). Today no dispatcher preset row exists, and ticket 130 deliberately left `agentPreset` alone.

An independent preset row is a real design task, not a small edit: a child preset does not inherit the parent composition, so the row would have to declare the child's whole tool set (the eight dispatcher tools) and its prompt (the dispatcher policy), well over 80 lines, and keep it in step with the activation path ticket 130 built.

**Blocker: a ruled preset-row design.** The design must say what the row declares, how it stays in step with the `agent/created` composition, and whether `origin` keeps winning (it must for workers — ADR-0027 §Settled 5; ticket 130's "What is NOT proposed here" forbids changing that order). The ADR-0024 rider licenses exactly one sidebar glyph registration (`src/client/index.ts:293-306`); a second registration needs the ruling to say so.

## Origin

Split from ticket 130 at its 2026-10-22 resolution. Ticket 130 shipped the identity half — durable `dispatcher_sessions` mark, re-activation on cold resume, idempotent, no-mark stays plain — and closed. These two halves were in its loss list (peer acceptance) and problem statement (client kind); neither could be honestly ticked, so both moved here instead of being claimed as done.

## Reopen gates

Move back to `open/` when EITHER gate lands — the two halves are independent, and the half whose gate is ruled is the half that reopens:

1. A dated human ruling amending ticket 70's fence rule, stating which non-live targets `sendPeer` may accept and how the send-triggered resume behaves in flight.
2. A ruled preset-row design for the child's glyph, per ADR-0027 condition (a), including how it keeps in step with the activation composition and whether the ADR-0024 rider's single-registration limit is extended.

If only one is ruled, file the remaining half separately rather than holding the ruled half behind the other.

## Constraints

- No gate, cap, or refusal class is added by either half.
- No change to the worker path, and no change to `resolveSessionKind`'s `origin`-first order.
- No invented marker: the identity mark stays ours (`dispatcher_sessions`); `agentPreset` is not fabricated.
- Offline tests only until a ruling lands; neither half is testable against the recorded rules.

## Comments

### 2026-10-22 — filing (split from ticket 130)

Filed at ticket 130's resolution. Ticket 130 satisfied its identity acceptance: the mark is durable, a cold-resumed child is re-activated, a repeat resume does not double-register, and an unmarked child stays a plain subagent (`test/spawn-dispatcher-activation.test.ts:912`, `:932`, `:992`, `:1027`; `test/spawn-dispatcher-host.test.ts:376`, `:391`, `:409`; `test/adapter-durable-marker.test.ts:332`, `:343`, `:362`). Message resume and the glyph were both explicitly out of that implementation, and both reopen recorded rulings or need a design that does not exist yet, so they are parked here rather than left as unticked boxes on a closed ticket.
