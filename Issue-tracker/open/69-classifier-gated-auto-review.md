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

- [x] Verify the reference's card types, anatomy, and classifier-gating behavior from the research
      notes (cite file:line; never open the reference tree). — Design 2026-09-19, §1.
- [x] Map to the shipped relay: what ticket 13/23/30 already cover (structured asks, clamped
      detail, session-scoped always-allow, expired honesty) vs what is new (classifier layer,
      card types, per-surface location labels). — Design 2026-09-19, §1–2.
- [x] **U-D is binding:** "always allow" rules stay session-scoped — no persisted rule store, no
      settings-managed controller. Design within that. — Design 2026-09-19, §2 (fidelity stop stated).
- [x] Worker-dispatch as a gated card type: how spawns present for approval without breaking the
      always-on model (no activation step). — Design 2026-09-19, §4.
- [x] Draft implementation ACs once 67's vehicle is decided. — Design 2026-09-19, §5 (ADR-0020 vehicle).

## Implementation ACs (chunked — from Design 2026-09-19 §5)

### Chunk A — core (offline, S8; fake host/seam)

- [x] A1. Review-posture table: match semantics + ADR-0019 keying; posture consulted only
      on consent miss; consent deny is never overridden by posture allow (test all three
      orders).
      Evidence: `src/core/review-posture.ts` (`matchTargetPattern` reuse; row keying and
      session attribution mirror `access-relay.ts`); composed after the consent table at
      the `lookupPolicy` wiring (`src/core/multitask.ts`); `test/review-posture.test.ts` —
      "consent deny beats posture allow", "consent allow beats posture deny" (the
      consent-wins orders), "posture allow/deny answers on a miss", "empty posture always
      asks".
- [x] A2. Empty-posture invariance: with no rows, park/wake/prompt ordering identical to
      shipped. Evidence: "empty posture: park, wake, and armed timeout are byte-identical
      to shipped"; the shipped `test/access-relay.test.ts` suite passes untouched
      (posture miss returns "ask" into the unchanged relay path).
- [x] A3. Posture auto-answer rides the shipped branch: allow → delivered, no wake; deny →
      `onResolved` notice with posture-naming detail; timeout deny still armed on
      escalation. Evidence: "posture allow rides the shipped silent auto-answer branch
      (no wake, no ticket)", "posture deny produces the self-naming policy-denied notice",
      the A2 test's armed-timeout assertions. The relay's auto-answer branch and ADR-0008
      timeout are reused verbatim (`access-relay.ts` and `access-types.ts` untouched).
- [x] A4. Clearance: session and whole-table clears drop posture rows; sibling sessions
      unaffected. Evidence: `Multitask.clearSessionAccessPolicy` also calls
      `reviewPosture.clearSession` (same deactivate/unload call sites); tests
      "clearSessionAccessPolicy(id) drops that session's posture rows; sibling's survive",
      "whole-table clearance (no id) drops every session-scope posture row", "an un-owned
      posture row behaves as shipped".
- [x] A5. Wildcard fence on the posture sink. Evidence: `ReviewPostureTable.set` refuses
      any `*`-bearing targetPattern (bare, prefix, inner) without writing; dispatch-side
      test "wildcard fence covers the dispatch sink too".
- [x] A6. Dispatch hook: miss → `spawnWorker` untouched; hit + fake seam → allowed
      proceeds / refused returns honest error; absent seam + hit → refused (fail-closed).
      Evidence: `src/core/tools.ts` spawn-handler gate with the injected
      `requestDispatchApproval` seam; `test/review-posture.test.ts` "worker-dispatch gate"
      suite (miss, allowed-once, rejected/cancelled/unavailable, absent seam, deny row,
      session-keyed rows, fence). Interpretation (2026-09-19): §4's "posture hit → seam"
      is read through §2's decision model — an allow row marks the dispatch class gated
      (the seam decides); a deny row auto-denies without asking a human to confirm what
      policy already decided. Documented at the gate.
- [ ] A7. Card projections (§3 shapes): pure-function unit tests. — 2026-09-19: handed to
      chunk B; the projection module itself is the 81 contract (B1 freezes the shapes), so
      its tests land with that module, not in this chunk.

### Chunk B — 81-contract (offline; rendering itself is 81)

- [ ] B1. Projection module exported with the §3 shapes frozen as the 81 contract.
      (2026-09-19: pending — chunk B / ticket 81.)
- [ ] B2. `locationFor` hook documented as 71's re-base point. (2026-09-19: pending —
      chunk B.)
- [ ] B3. No `access-types.ts` / relay-semantics diff (grep-level review assertion).
      (2026-09-19: pending — chunk B; chunk A already kept both untouched, so B3 starts
      from a clean base.)

### Live-only ACs (45/33 lane)

- [ ] L1. Pending card renders inline in the wrapper conversation and resolves through
      `Multitask.resolveAccess`. (2026-09-19: pending — live lane.)
- [ ] L2. Blocked-marker-with-reason appears on the session row while a card waits.
      (2026-09-19: pending — live lane.)
- [ ] L3. Dispatch approval pauses and surfaces through the real `ctx.approval` waterfall.
      (2026-09-19: pending — live lane. The seam is deliberately NOT wired in
      `src/plugin.ts` yet: `requestDispatchApproval` is an injected dep that is absent
      live, and an absent seam + posture hit refuses fail-closed. Shipped posture is
      EMPTY, so live behavior is unchanged until wiring + a posture seeder exist. Wiring
      will need the approval service added to `inject` — see
      `dsh-adapter-api-notes.md:390`.)
- [ ] L4. Posture auto-answer verified live (no card; honest deny notice).
      (2026-09-19: pending — live lane.)

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

### 2026-09-19 — agent (chunk A implemented: core posture table + dispatch gate; chunk B pending)

Landed in two commits: **61dd7bf** (review-posture table + `lookupPolicy` composition +
clearance) and **1a337fa** (worker-dispatch gate in the spawn tool). Gates: `npm run
typecheck` green; `npm test` **1009 pass / 0 fail** (1002 at the table commit; +7 dispatch
gate tests), fully offline (FakeDshHost, manual scheduler — no real timers armed).

**What landed**

- `src/core/review-posture.ts` (new): `ReviewPostureEntry` = `{ class: AccessClass |
  "worker-dispatch", targetPattern, decision, scope, session? }`; `lookup` returns
  `AccessDecision | "ask"`; `lookupDispatch(title, ctx)` returns the row decision or
  undefined (ungated); `set` returns boolean and REFUSES any `*`-bearing targetPattern
  (fence lives in the sink — deny-on-ambiguity); `clearSession(sessionId?)` with the
  consent table's attribution rules; no seed parameter (shipped posture is EMPTY; rows
  enter only through Multitask APIs). Deny detail is self-naming:
  `auto-review posture denied <class> "<target>"` with reason `policy-denied` (renders
  through the shipped `wrapAccessDecision` deny path and `onResolved` notice).
- `src/core/multitask.ts`: posture composed AFTER the consent table at the `lookupPolicy`
  wiring — consent (allow **or** deny) wins; only a consent `"ask"` miss falls through;
  a posture miss stays `"ask"` → shipped park/wake/ADR-0008 timeout, byte-identical.
  `clearSessionAccessPolicy` clears posture rows too (deactivate + unload sites).
  `Multitask.reviewPosture` exposed.
- `src/core/tools.ts` + `tool-results.ts`: spawn handler gates on `lookupDispatch(title,
  ctx)`; injected `requestDispatchApproval` seam (outcomes `allowed-once | rejected |
  cancelled | unavailable`, fail-closed); new refusal reason `auto-review-refused`.
- Untouched by design: `src/core/access-relay.ts`, `src/core/access-types.ts`,
  `src/plugin.ts` (zero delta — no overlap with the concurrent client-side ticket).

**Interpretations / reconciliations with the design (documented, none blocking)**

1. Dispatch deny rows refuse outright without calling the seam (see A6 note) — §2's
   decision model applied to §4's "hit → seam" wording.
2. §4's "rows keyed on a literal dispatch class + optional title prefix" is implemented
   as class `"worker-dispatch"` + `targetPattern` matched against the spawn title; the
   fenced write path admits exact titles only (prefix machinery is reused in matching
   but `*` is unwritable through `set`).
3. A7 (projection tests) presupposes the chunk-B projection module; handed to 81 (see the
   ticked-AC section above).

**Hazards for the 81 implementer and the live lane**

- 81/B1: posture denies surface as `policy-denied` with the self-naming detail above —
  freeze that copy in the §3 shape contract; decision provenance renders from the
  shipped `AccessDecision.reason` labels (no new reason kind was added).
- Live/45-33: `requestDispatchApproval` is NOT yet wired to `ctx.approval.request`;
  wiring needs the approval service in `inject` and is L3's work. Absent seam + hit
  refuses fail-closed, so a future non-empty posture cannot silently spawn before the
  answerer exists — but verify Q2 (a gated dispatch with no live answerer must not wedge
  the dispatcher turn) when wiring lands.
- Q1 stays ready-for-human: no posture seeder shipped; posture content is a human
  decision.

Ticket stays **open**: chunk B (B1–B3, the 81 contract) pending.

### 2026-09-19 — agent (Design: classifier-gated auto-review — unblocks 81)

The design below is the implementation contract for this ticket. It is deliberately minimal: on
dsh every relay ask already prompts, so the classifier's honest role is narrow — session-scoped
auto-answer and honest presentation typing. Ticket 30's "do not add any auto-decision layer"
constraint bound ticket 30 only; ADR-0018 names this area in scope, and the sanctioned extension
point is the policy table's existing lookup composition (`src/core/multitask.ts:324`), **not** a
new layer beside the relay. `src/core/access-relay.ts` is untouched by this design.

#### §1. Verified inventory (cited; reference tree never opened)

Reference card types + anatomy — `docs/research/always-on-dispatcher-behavior.md:51` (area 6):

| Reference card type | Anatomy elements (all :51) | dsh producer today | Status |
|---|---|---|---|
| Local command (labeled "runs on the user's computer") | plain-language title; detail clamped to a few hundred chars with explicit omission marker; location line; resolve actions incl. persistent always-allow; stale/pending projections | worker access ask, class `tool`/`filesystem` (relay: `src/core/access-relay.ts`) | **real** |
| Connected-service (MCP) call | same | worker access ask, class `tool`/`network` | **real** (no MCP catalog; target names only) |
| Secret request | separate flow: idle→pending→provided, password input, stored-securely/never-shown collapsed state (:53) | class `credential` ask + ticket 30's stored-copy notice | **real** |
| Worker dispatch | dispatches are themselves a gated surface (:51) | dispatcher spawn tool call (`src/core/tools.ts:210`) — currently ungated | **new** (§4, presentation-time) |
| Remote-box command / computer action | per-surface location labels | none — no host capability | **recorded gap, not simulated** (71's area, later) |
| Automation write | — | none (C14: no routines/automations) | **recorded gap, not simulated** |
| Cloud-agent action | — | none | **recorded gap, not simulated** |

Complementary reference flows already covered or consciously absent: local-tool permission prompt
card, fail-closed (:52) — that is the host's own gating, out of our relay; legacy title-only
card (:54) — nothing to imitate; blocked-with-reason presence while a card waits (:55) — 81's
roster loop. Classifier evidence beyond area 6: per-surface classifier-prompt family — shell,
browser, computer, cloud agent, automation, subagent (`reference-agent-prompt-inventory.md:52`;
whether they share a base prompt is unknown, :98); auto-review semantics = blocked action raises
a user-facing card, the worker escalates by retrying the same tool, explicitly no separate
approve tool (`reference-architecture-patterns.md` §3, evidence `sand-auto-review.ts`);
own-action approval prose: do not pre-emptively request approval, escalation = same action
unchanged, one at a time, authority only from the user (`reference-agent-prompt-inventory.md:135`);
auto-review approvals expire at session retirement (`reference-agent-lifecycle.md:42`).

**Recorded depth limit:** area 6 is inventory-grade — "breadth over depth" (:104), approval flows
"covered shallowly" (:105). The classifier's decision INPUTS (what it conditions on, its deny
criteria) were not recovered and are **not invented here**. Our classifier is therefore a
deterministic posture table, not a model of the reference's classifier internals.

#### §2. Classifier design (core-side, session-scoped, U-D-conforming)

- **Placement:** a new core module (ours, e.g. `src/core/review-posture.ts`) holding a
  **review-posture table** with the consent table's matching semantics (`matchTargetPattern`
  reuse) and ADR-0019 session keying (rows carry `session?`, un-owned legacy rows behave as
  shipped). Composed AFTER the consent table at the `lookupPolicy` wiring (`multitask.ts:324`):
  consent decision (allow **or** deny) wins; only a `"ask"` miss falls through to posture; only
  then to the shipped ask path. The relay's auto-answer branch (`access-relay.ts:297-313`) and
  armed timeout (`:324-332`) are reused verbatim — the classifier IS the table feeding them.
- **Decision model:** per ask, one of **auto-approve** (shipped auto-answer: delivered to the
  worker, no card, no wake — matches the shipped row path and the reference's no-card-for-safe
  actions), **auto-deny** (policy-denied, deny detail names the auto-review posture — new copy,
  honest notice via the shipped `onResolved` deny path), or **escalate-to-human** (parked ticket,
  prompt/wake presentation, ADR-0008 timeout deny as shipped).
- **Shipped posture is EMPTY.** With no posture rows every ask escalates exactly as today —
  un-configured semantics are byte-identical (AC requirement). The mechanism ships; posture
  content does not (see §6 open question). Posture rows enter only through `Multitask` APIs
  (tests now; any real seeder is a human decision).
- **Clearance:** `clearSessionAccessPolicy(sessionId?)` (`multitask.ts:980`, wired
  `src/plugin.ts:545,612`) also drops posture rows under the same attribution rules — a posture
  row never outlives its session.
- **Fences carried over:** the wildcard fence extends to posture writes (a posture `set` with a
  `*`-bearing target refuses, same defense-in-depth as the consent sink `plugin.ts:328`); deny
  stays the default on any ambiguity.
- **U-D fidelity stop — where imitation ends:** (1) NO LLM classifier layer — the reference's
  per-surface classifier prompts (:52) are not imitated; no inference in core, the posture is
  deterministic. (2) NO persistence beyond session scope and NO settings-managed rule store —
  the reference's session-retirement expiry (lifecycle:42) is matched by our deactivation/unload
  clearance, and nothing survives it. (3) NO silent allow outside the ask pathway — posture only
  ANSWERS relay asks; it never suppresses asks or acts un-asked. (4) NO separate approve tool —
  matches the reference's explicit absence (§3 of architecture note); answers route through
  `Multitask.resolveAccess` as shipped. Any design pressure toward persisted rules or
  cross-session posture scope is a U-D violation → halt and escalate, do not design around it.

#### §3. Contract for 81 (rendering)

Two card shapes, both pure projections exported for 81 (adapter-level module), offline-testable:

1. **Access-ask card** (from relay truth only — `listPending` + `AccessNotice`):
   `{ cardKind: "access-ask" | "secret-ask" (derived from class === "credential"), requestId,
   workerId, workerTitle, body {class, target, reason, credentialName?}, parentSessionId,
   createdAtMs, status: "pending" | "resolved" | "expired", decision?: AccessDecision,
   optionSet (Allow / Always allow (this session) / Deny, minus the wildcard-fenced always —
   `access-prompt.ts:252-258` logic), locationLine, detailClamp (ticket 30's
   `clampApprovalDetail` + omission marker) }`. Decision provenance renders from the shipped
   `AccessDecision.reason` labels (`user-denied | policy-denied | timeout | aborted`); posture
   denies surface as policy-denied (true — it is policy) with self-naming detail copy. No
   `access-types.ts` changes. The location line is delivered through an injectable
   `locationFor(card)` hook, default = `APPROVAL_LOCATION_LOCAL` (`access-prompt.ts:104`) —
   **this hook is 71's re-base point**; 81 must not hard-code the constant.
2. **Worker-dispatch card** — **presentation-time only (C15 holds):** rendered from the
   dispatcher conversation's own spawn tool-call record (replay-safe, per the tool-call-card
   rule in `dsh-plugin-ui-examples.md` Finding 2), NOT from the relay or wake bus. Shape:
   `{ cardKind: "worker-dispatch", toolCallId, streamKey, title, outcome: spawned-worker-id |
   refused-reason, gating: "ungated" | "approval-allowed" | "approval-refused" }`. No new wake
   kind, no ledger entry, no activation step — spawns remain the single wake kind.

#### §4. Worker-dispatch gating (always-on preserved)

The spawn tool handler (`src/core/tools.ts:210`) consults the posture table with producer kind
`worker-dispatch` (rows keyed on a literal dispatch class + optional title prefix). Posture miss
→ spawn proceeds exactly as shipped, no approval seam call. Posture hit → the plugin raises the
host approval seam `ctx.approval.request` (contract: `docs/research/dsh-adapter-api-notes.md:220`
— outcomes `allowed-once | rejected | cancelled | unavailable`, fail-closed): `allowed-once` →
spawn proceeds; `rejected`/`cancelled`/`unavailable` → the spawn tool returns an honest refused
result and the dispatcher re-plans (the reference's escalation = same action unchanged,
prompt-inventory:135). Gating happens inside the already-running dispatcher turn — no activation
step. Recorded asymmetry: relay asks have ADR-0008's 120s deny timeout; dispatch approvals ride
the seam's own cancellation (no core timer) — ADR-0008's scope is unchanged. Verify the live
waterfall in the 45/33 lane.

#### §5. Chunked implementation ACs

**Chunk A — core (offline, S8; fake host/seam):**
- A1. Review-posture table: match semantics + ADR-0019 keying; posture consulted only on consent
  miss; consent deny is never overridden by posture allow (test all three orders).
- A2. Empty-posture invariance: with no rows, park/wake/prompt ordering identical to shipped
  (regression test against current behavior).
- A3. Posture auto-answer rides the shipped branch: allow → delivered, no wake; deny →
  `onResolved` notice with posture-naming detail; timeout deny still armed on escalation.
- A4. Clearance: session and whole-table clears drop posture rows; sibling sessions unaffected.
- A5. Wildcard fence on the posture sink.
- A6. Dispatch hook: miss → `spawnWorker` untouched; hit + fake seam → allowed proceeds /
  refused returns honest error; absent seam + hit → refused (fail-closed).
- A7. Card projections (§3 shapes): pure-function unit tests (secret-ask derivation, wildcard
  option degradation, clamp math, location hook default, dispatch projection replay-safety).

**Chunk B — 81-contract (offline; rendering itself is 81):**
- B1. Projection module exported with the §3 shapes frozen as the 81 contract; B2. `locationFor`
  hook documented as 71's re-base point; B3. no `access-types.ts` / relay-semantics diff
  (grep-level review assertion).

**Live-only ACs (45/33 lane):** L1 pending card renders inline in the wrapper conversation and
resolves through `Multitask.resolveAccess`; L2 blocked-marker-with-reason appears on the session
row while a card waits; L3 dispatch approval pauses and surfaces through the real
`ctx.approval` waterfall; L4 posture auto-answer verified live (no card; honest deny notice).

#### §6. Open questions (ready-for-human, not decided here)

- **Q1.** Should any non-empty default/Config-seeded posture ever ship? An empty posture is
  required by this ticket's ACs (un-configured semantics must not change), and a Config-declared
  posture field rendered in settings would drift toward the settings-managed controller U-D
  excludes — flagged per the triage brief instead of decided. The mechanism lands with an empty
  posture either way.
- **Q2 (live-lane risk, noted).** A `worker-dispatch` posture hit with no live answerer fails
  closed (`unavailable` → refused); in the always-on wrapper the answerer is our own approval
  surface (ticket 80/81). Verify in 45/33 that this cannot wedge spawned dispatches.

#### §7. Conflicts with landed work

None found. 76's keying landed as the triage brief describes (`PolicyEntry.session?`,
`clearSession(sessionId?)`, per-session `pumpFor` in `src/plugin.ts:302-376`); ticket 30's
"classifier NOT adopted" binds ticket 30 only. This design extends exactly the shipped lookup
composition and reuses the shipped auto-answer, timeout, notice, and clearance paths unchanged.
