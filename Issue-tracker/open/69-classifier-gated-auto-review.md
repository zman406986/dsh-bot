# 69 — Classifier-gated auto-review (ADR-0018 in-scope area)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none — 67 resolved (ADR-0020); the 72 clause resolved by 76 (relay keying DID change: per-session policy rows + per-session prompt pump landed — the design incorporates it; see the 2026-09-19 triage comment). Rendering home 81 depends on THIS ticket's design, not the reverse.
**Related:** ADR-0018 (in scope: "classifier-gated auto-review"; exception U-D), `docs/research/always-on-dispatcher-behavior.md` area 6, 30 (the shipped session-scoped always-allow + prompt UX), 13/23 (access relay + prompt pump), ADR-0008

## Problem

The reference gates risky actions through an inline approval-card flow decided by a classifier
layer, not the model alone: typed cards (local command, remote-box action, connected-service call,
automation write, cloud-agent action, worker dispatch), clamped detail with omission marker,
location lines, stale/pending projections, and a persistent "always allow this rule" choice.
Ticket 30 shipped a session-scoped slice on the prompt pathway and deliberately did not adopt the
classifier; ADR-0018 brings the area in scope.

## What to do (research/design ticket)

- [ ] Verify the reference's card types, anatomy, and classifier-gating behavior from the research
      notes (cite file:line; never open the reference tree).
- [ ] Map to the shipped relay: what ticket 13/23/30 already cover (structured asks, clamped
      detail, session-scoped always-allow, expired honesty) vs what is new (classifier layer,
      card types, per-surface location labels).
- [ ] **U-D is binding:** "always allow" rules stay session-scoped — no persisted rule store, no
      settings-managed controller. Design within that.
- [ ] Worker-dispatch as a gated card type: how spawns present for approval without breaking the
      always-on model (no activation step).
- [ ] Draft implementation ACs once 67's vehicle is decided.

## Constraints

- Relay semantics that survive (timeout ADR-0008, deny-by-default, dedupe) are not re-litigated
  here; the design extends them.
- New or adapted copy only.

## Comments

### 2026-09-19 — agent (vehicle hand-off from 67)

Vehicle decided (draft): **ADR-0020** — our own frame over the shipped runtime. Your rendering
home is ticket 81 (approval cards inline in the wrapper's conversation surface, re-hosting
ticket 30's anatomy); 80 builds that surface first. Your relay/keying question is unchanged by
the vehicle; the classifier layer is core-side and vehicle-independent. U-D binding unchanged
(session-scoped always-allow; no settings-managed store — note the wrapper will displace the
 shipped settings UI at cutover, so a settings-managed controller is doubly out).

### 2026-09-19 — agent (triage: actionable NOW → ready-for-agent)

Verdict (a). The vehicle is decided, and the conditional 72 clause resolved concretely: 76
landed the relay keying change this ticket's blocked-by anticipated (`src/core/access-relay.ts`
`PolicyEntry.session?` + `clearSession(sessionId?)`; per-session pump `pumpFor(sessionId)` in
`src/plugin.ts`; always-allow rows attributed per asking session). The classifier layer is
core-side and vehicle-independent; 81's rendering waits on this design, so designing now
unblocks 81. Ticket 30's "classifier NOT adopted" constraint binds ticket 30 only — ADR-0018
names this area in scope, and this is its sanctioned design ticket.

**Agent-ready brief (design ticket — implementation decomposes at dispatch time)**

- **Scope-in:** reference card-type/anatomy/classifier verification (cite the research note;
  area 6 is inventory-grade — record the depth limit); honest card-type mapping to dsh;
  classifier layer design (core-side, session-scoped, U-D-conforming); worker-dispatch as a
  gated card type that preserves always-on; implementation ACs for the core chunk + the
  rendering contract 81 builds against.
- **Scope-out:** re-litigating relay semantics (ADR-0008 timeout, deny-by-default, dedupe —
  frozen, per 30); persisted always-allow rules or a settings-managed controller (U-D —
  doubly out post-cutover); remote-box / cloud-agent / automation-write card types beyond
  recorded gaps (no host capability / C14); any new prompt pathway.
- **Builds on:** `src/core/access-relay.ts` (policy table, per-session rows — 76),
  `src/adapter/access-prompt.ts` (:226 wildcard fence; :104 constant location line — 71 owns
  its per-producer-kind re-base), `src/plugin.ts` (alwaysAllow sink, per-session pump),
  ticket 30's shipped UX slice (clamped detail, expired honesty, secret stored copy),
  `docs/research/always-on-dispatcher-behavior.md:51` (area 6: card types, anatomy,
  classifier-gating), ADR-0020's hand-off (81 renders, 80 built the surface).
- **ACs:**
  1. Verification table citing `always-on-dispatcher-behavior.md:51` file:line: card types,
     anatomy (title / clamped detail + omission marker / location line / resolve actions /
     persistent always-allow / stale-pending projections), classifier-decides-what-pauses.
  2. Honest dsh mapping: which card types have real producers (worker dispatch; worker
     access asks covering local command / MCP-style service calls) vs recorded gaps
     (remote-box, cloud-agent, automation-write) — no fantasy producers.
  3. Classifier design within U-D + deny-by-default: the decision lives core-side and
     session-scoped, extending the existing policy table's auto-answer path; it never
     bypasses ADR-0008 timeout/deny. **Fidelity stop:** any design pressure toward
     persisted rules or cross-session scope = U-D violation → halt and escalate, do not
     design around it.
  4. Worker-dispatch-as-card: presentation-time gating only — no activation step, and C15
     holds (spawns remain the single wake kind; no new pipeline).
  5. Implementation ACs drafted in two chunks: (i) core classifier + policy-table
     integration, offline-testable (S8); (ii) the card contract 81 renders against
     (including the location-label hook for 71). Live-only ACs marked for the 45/33 lane.
- **Risks:** on dsh every relay ask already prompts, so the classifier's honest role is
  narrow — session-scoped auto-answer (the existing row mechanism) and honest presentation
  typing; "silently allow unasked classes" is out of bounds by construction.
- **Size:** M (design); implementation L → decompose at dispatch time.
