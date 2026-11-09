# 290 — Answer a worker's approval request from its parent dispatcher

**Status:** cancelled
**Type:** task
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no — without this the un-pinned child's ask ends in `unavailable`; nothing hangs today.
**Blocked by:** nothing for the unit tests; the live effect needs 289 (see 292).
**Origin:** `docs/research/child-ask-seams.md` finding 3 (the waterfall is answerable in-process) and the 2026-11-09 lane decision that a dispatcher answers its own workers' asks.
**Related:** 289 (creates the request), 291 (contract wording), 292 (live proof), 293 (what stays unreachable); ADR-0033.

## Problem

Once 289 replaces the pin, a worker's would-prompt action produces a real `approval/request` waterfall. Nobody answers it: the browser answerer is registered for root sessions and a worker is not a root. `decide()` races the waterfall against the request signal and normalizes a missing answerer to `unavailable` (`dsh-user-approval/lib/index.js:197-214`), so the worker gets a non-answer rather than a decision — and a listener that simply never returns would hang that worker's tool call.

This ticket registers a listener on `approval/request`, scoped to the child agent scope of our worker sessions, that asks the owning parent (the dispatcher that spawned the worker) and returns exactly one outcome: `allowed-once` on an explicit yes, `rejected` on an explicit no, on a timeout, or on any read error. The bounded wait is **120 seconds**; when it expires the answer is `rejected`. Nothing in this path may wait forever.

The listener may never widen. If the parent's own policy is `never`, or the parent is sandbox-confined in a way that forbids the requested action, the answer is `rejected` — the child must not receive an allow the parent could not have made for itself. A parent that cannot be read is a reject, not an allow.

## Acceptance criteria

- [ ] Allow path: parent says yes → the child sees `allowed-once` and the action runs; the outcome reaches the child's log.
- [ ] Reject path: parent says no → the child sees `rejected`, the action does not run, and the child is told so.
- [ ] Timeout path: no answer within 120 s → `rejected`; the worker's turn continues rather than hanging.
- [ ] The ticket records which outcome the child actually saw on the timeout path (`rejected`) and states that an unanswered ask never hangs.
- [ ] Parent that may not widen: a parent whose own policy is `never`, and a sandbox-confined parent, both produce `rejected`; a unit test pins each.
- [ ] Scoping test: the listener does not fire for a root session or for a child we did not spawn.
- [ ] Any read error while consulting the parent yields one outcome (`rejected`), never a rethrow and never a second answer.
- [ ] Exactly one outcome is returned per request; the test asserts the built-in chain is not also consulted.

## Constraints

- Never register this on a root scope: first-claimer-wins would swallow the human's own approvals (`child-ask-seams.md` finding 8; ADR-0011).
- No UI, no new config switch, no new tool for the worker. The worker keeps its existing tool surface.
- The 120 s bound is a named constant; a change to it is a ticket, not a tweak.
- Do not log secrets or file contents from the request; log tool identity, decision, and reason class only.
- Failure is closed in every branch: unreadable parent, throwing parent, aborted request, timeout.

## Comments

2026-11-09: Filed from the design lane; the consultation mechanism itself is left to the implementer — the fixed parts are scope, the single outcome, the bound, and no widening.
2026-11-09: Cancelled at the owner's channel — making the child 'ask' instead would let a child run wider than its parent: an allow is the grant, and the escalation path returns the REQUESTED mode without consulting the parent (`dsh-sandbox/lib/index.js:151-152`). A deny-only tool gate was rejected too: it can only deny what 'never' already denies, so it is dead code. See `docs/adr/0036-delegated-child-ask-needs-host-change.md` (proposed, pending owner confirmation).
