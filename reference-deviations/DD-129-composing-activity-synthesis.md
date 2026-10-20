# DD-129 — Fabricated composing activity vs observed-truth activity
- **Area:** inference routing & streaming (A15)
- **Type:** deliberate-divergence (philosophy)
- **Date:** 2026-09-23

## What the reference does
When a locally routed inference turn starts, the reference coordinator calls an activity-begin action, which rewrites the whole remote agent roster it just fetched so the target agent is flagged as running/composing with a generic thinking activity, and publishes that fabricated roster as a roster event. Because a concurrent transcript refresh can re-fetch the real (idle) roster and wipe the rendered activity surface, it re-publishes the fabricated state on a 250 ms `setInterval` until the turn ends. On top of that, before the first provider call it deliberately sleeps a fixed 1,200 ms — its comment explains the shipped virtualized transcript needs roughly 350 ms to render the trailing activity row, so the composing state is held authoritative long enough for a clearly perceptible rendered composing interval before tokens stream in. In short: perceived responsiveness is manufactured — states are asserted that the system does not actually observe.

## What the current build does
The build never synthesizes activity and runs no activity timers. Every activity phrase is observed: events of type `tool/call` from the `session/event` stream are the sole source, `describeToolActivity` derives a human-readable phrase from the event body (tool name plus a primary-argument hint) or returns null for anything unreadable — the doc comment says never invented — and the observation is stamped with the host clock (`Date.now()`) when it arrives. Settled workers deliberately show terminal status rather than any lingering activity (comment referencing the ticket 29 rule that settled workers show their final status, never invented activity). These observations flow into liveness via `recentActivity`/`lastActivityAtMs` (src/core/liveness.ts). ADR-0010 records the underlying stance: dispatcher presence/activity is a projection of core state, not an independently animated surface; the research notes phrase it as never poll, never guess.

## The deviation
Same UI problem (a composing state that is over before the renderer shows it), opposite solutions. The reference fabricates running/composing roster state and pulses it on a timer, plus inserts a 1,200 ms artificial delay before inference, to make the UI look responsive. The build treats activity as a pure observation stream: if no `tool/call` was seen, nothing is shown; if a worker settled, terminal status replaces activity. The reference's 1,200 ms hold also adds real latency to every turn — a cost the build refuses to pay for cosmetics.

## Verdict: DO-NOT-INCORPORATE
The never-poll/never-guess rule is recorded — synthesized activity would break a core rule: never show state the system did not observe. ADR-0010 (draft, in the accepted stack per ADR-0018) makes presence a projection of observed core state, and the ticket-29 rule comments in the build make "terminal status instead of invented activity" an explicit, tested commitment. Fabricating roster states on a 250 ms pulse is precisely the kind of guess the build forbids, and the 1,200 ms composing hold trades genuine latency for a cosmetic effect. The one transferable insight — that a virtualized transcript can erase an activity row between reconciliation windows — belongs in a client-rendering ticket as a rendering consideration, not as fabricated state.

## Incorporation notes
- **Where it would live:** If any fragment were ever wanted, the client transcript renderer (client/) would note the reconcile-window erasure risk; no host-side change is admissible (no code to add under the verdict).
- **Constraints:** Activity must come only from observed stream events (`tool/call`); no `setInterval` activity re-publishers; no artificial pre-inference delays; settled workers show terminal status (ticket 29).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S if ever revisited (a rendering-side note only); risk is high to incorporate — it contradicts a recorded rule against inventing state and adds per-turn latency.
- **Key reference anchors:** the activity-begin roster rewrite + 250 ms pulse and its anti-erase comment; the 1,200 ms composing-hold comment (lines 144-151) explaining the ~350 ms virtualized-transcript render window.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/node-agent-coordinator/inference-router.ts` (lines 80-99: the activity-begin roster rewrite + 250 ms `setInterval` pulse; lines 143-151: 1,200 ms hold + render-window comment)
- Build: `src/adapter/cordis-dsh-host.ts` (lines 321-358: `describeToolActivity`, "never invented"; lines 463-473: settled worker clears activity, ticket 29 rule that final status replaces activity; lines 496-515: `tool/call` stream → observed phrase with `Date.now()`), `src/core/liveness.ts` (`recentActivity`/`lastActivityAtMs` liveness), `docs/adr/0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md`, `docs/research/reference-agent-lifecycle.md` (never poll, never guess — evidence, not ruling)
