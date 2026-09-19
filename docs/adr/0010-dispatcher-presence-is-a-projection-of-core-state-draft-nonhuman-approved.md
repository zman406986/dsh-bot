# Dispatcher presence is a projection of core state, published on transitions and read from pull-only surfaces

**Status:** draft (non-human-approved) — agent-drafted 2026-09-19 (ticket 33 close-out, part 1), pending human sign-off; records decisions actually shipped by tickets 27/28

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0010, consuming the slot design-17 §9 reserved ("presence-as-projection" → tickets 27/28). The older design-16 §9.2 *conditional* ADR-0010 sketch (client data path) was deemed unnecessary by tickets 21/25 and never written; ticket 25's comment is its decision record. This filing resolves the double-claim in favor of design-17's plan, as tickets 37/13–15 headers already anticipated.

## Decision

Any surface that shows dispatcher presence — the capsule-era Workers panel and the wrapper sidebar alike — renders a **projection of existing core truth**. There is no presence store, no second source of truth, and no new core state. Concretely, four rules were shipped:

1. **One wire contract, fail-closed.** The roster snapshot (`src/core/roster-snapshot.ts`) is the single contract between core and every presence surface. Ticket 27 shipped v2 (`kind`, `startedAtMs`, `toolCallCount`, `delivered`, structured `blocked {class, target}`); ticket 41 extended it to v3 (bounded `recentResult` envelope). Parse is fail-closed: wrong version, unknown kind, malformed fields, non-finite clocks → the whole snapshot parses `null` and the surface degrades to "unavailable" copy — never a half-roster. Both faces (host projection and browser parse) import the same dependency-light module.
2. **No new core state; observer timeliness instead.** Blocked/delivered markers are *joined* at projection time (`listPendingAccess` by workerId — names only, never secret values; the reconciler's delivered flag; `WorkerSummary` clocks/counts). Prompt re-projection rides the existing roster observer, which tickets 27/28 extended to fire on the semantic transitions that change those markers (access park/resolve/timeout/policy-deny, `markDelivered`) — the design-17 §5 conflict-8 alternative to inventing a presence store.
3. **Publish on semantic transitions only; no coalescing.** Every publish is one per roster-affecting transition (spawn, turn start, steer, settle, abort, access park+resolve, markDelivered, reconcile, drain); there is no tick or poll path. Ticket 28 considered per-tick coalescing and **deliberately skipped it** (no churn to amortize; a timer would add a scheduling seam) — decision recorded in the `src/adapter/roster-channel.ts` header. Staleness is handled read-side (age window → unavailable), since the channel has no heartbeat.
4. **Pull-only honesty.** dsh exposes no push channel to UI, so the snapshot mirrors through the settings namespace — "a config channel doing telemetry duty" is the recorded honest gap, and every read validates defensively. Sections (**Active / Needs you / Finished**) are a pure view-model partition of the same snapshot (`rosterSectionFor`), with blocked > landed precedence; the wrapper sidebar consumes the identical partition function, so sidebar chips and panel sections can never diverge (`src/client/shell-store.ts`).

## Context

- Shipped by tickets 27 and 28 (worktree commits `f09f19d`, `6874cf2`), merged to main at `400450f`; independently verified at `6874cf2` (599/0/158) per ticket 28's verifier comment.
- The capsule vehicle (shell.overlay panel, its CSS/locale face) was later superseded by ADR-0018/0020 (wrapper re-base, ticket 64). This ADR's rules are the vehicle-independent part that survived the re-base: tickets 27/28's own re-scope comments void only the delivery surface, not the projection contract. Wrapper presence (ticket 79) reads the same snapshot.
- Two capsule-era rationales are explicitly **re-opened**, not re-decided here: (a) "Needs-you as the pull-only stand-in for push attention" — the wrapper owns the whole UI, so the reference's attention markers can be imitated natively (ticket 28 re-scope); (b) the `delivered`/landed-marker semantics were derived under completion = delivered-to-user, and ADR-0018's re-base (completion = first-visible-ack; ticket 58's bounded redrive) requires re-derivation before the wrapper presence surface is held to the imitation bar (ticket 27 re-scope).

## Consequences

- A field a surface seems to need but core does not expose is a stop-and-raise (PRD amendment), never an invented core state (design-17 §5 conflict 8, kept as a standing rule).
- Every new presence surface pays only a parse + partition: v1/v2 payloads and malformed input fail closed to unavailable, so adding surfaces cannot create a half-truth renderer.
- The settings-mirror channel remains a documented residual risk (write amplification, merge-vs-replace semantics — ticket 21's recorded note); mitigation is the transition-only publish rule, already shipped.
- The re-opened rationales (a)/(b) above stay open on tickets 27/28; this ADR records neither as decided.
