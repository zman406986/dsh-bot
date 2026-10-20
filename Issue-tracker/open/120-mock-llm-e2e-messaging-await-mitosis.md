# 120 — Mock-LLM end-to-end coverage for messaging, await, and mitosis

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 116, 117, 118
**Related:** ticket 115, ticket 119, `dev/mock-llm.mjs` (parallel lane), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §11.2 (untracked input, not authority)

## Problem

The unit tests prove each piece in isolation. Nothing proves that a dispatcher can message a worker, wait on it, spawn a dispatcher child, and receive that child's report — the behaviour a user actually exercises. Those four flows cross the core, the adapter, and the wake bus, which is exactly where the seams are.

## What to do

Add these four scenarios to the mock-LLM harness (`dev/mock-llm.mjs` style), where the scripted model can be told to call the new tools:

- [ ] A dispatcher messages a running worker; the worker's next step reflects the correction (the steer path end to end, including the step-boundary send).
- [ ] A dispatcher `await_agent`s a slow worker and receives its result **in the same turn**.
- [ ] A dispatcher spawns a child dispatcher; the child spawns a worker; the child's result arrives at the creator as a peer message on a later turn.
- [ ] A user message during an `await_agent` releases the wait promptly (the PRD S1 check). If ticket 117 shipped without early release because the user-source event shape could not be verified, **replace this scenario with the honest alternative**: the wait runs to its 120 s cap and the dispatcher still replies, and record why the release scenario is absent.

## Constraints

- Mock LLM only. No live dsh, no provider key, no network.
- Each scenario asserts observable behaviour, not internal calls: what the next turn sees, what the tool returned, which turn the message arrived on.
- No new harness when `dev/mock-llm.mjs` can carry the scenario; extend it.
- Keep runs short — these are regression scenarios, not a soak test.

## Comments

### 2026-10-18 — filing

Filed from design note §12 ticket 120. The fourth scenario carries a conditional honest fallback because ticket 117 may ship without user-message early release; writing the fallback here means the harness cannot quietly pretend the release exists.
