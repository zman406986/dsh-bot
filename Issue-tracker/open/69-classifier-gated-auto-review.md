# 69 — Classifier-gated auto-review (ADR-0018 in-scope area)

**Status:** open
**Labels:** ready-for-agent
**Q1:** ruled 2026-09-19 (overnight dispatched ruling, agent — subject to human reversal): the
shipped default posture stays **EMPTY**; no Config/settings-seeded posture. Ruled by an autonomous
agent, not a human signature. Evidence + reversal path in the "Q1 ruled" comment at the end of
this file.
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

- [x] B1. Projection module exported with the §3 shapes frozen as the 81 contract.
      (2026-09-19: landed — `src/client/approval-cards.ts`:
      `projectAccessAskCards` (access-ask / secret-ask cards from relay truth
      only — `listPending` + `AccessNotice`; ticket 30's option set minus the
      wildcard-fenced always, clamped detail + omission marker,
      pending/resolved/expired), `projectDispatchCard` (worker-dispatch,
      presentation-time only from the spawn tool-call record, replay-safe,
      no relay/wake kind — C15 holds), `createApprovalCardsStore` (unfed =
      unknown). Evidence: `test/approval-cards.test.ts` — 22 tests pinning
      the exact shapes, secret-ask derivation, posture-denied-as-
      policy-denied with the self-naming detail (no new reason kind), option
      degradation, clamp math, notice joins, replay-safety. Commit 9bcdd4d.)
- [x] B2. `locationFor` hook documented as 71's re-base point. (2026-09-19:
      landed — the card carries `locationLine` resolved through the
      injectable `locationFor(card)` hook; default =
      `defaultLocationFor` → 71 AC-4's `approvalLocationLineFor` map
      (local entry). 81 never hard-codes the constant; tests pin default,
      injection, and hook-input identity. Commit 9bcdd4d.)
- [x] B3. No `access-types.ts` / relay-semantics diff (grep-level review assertion).
      (2026-09-19: verified — `git diff d0860a2..HEAD -- src/core/
      access-types.ts src/core/access-relay.ts` is EMPTY across the chunk-B
      + 81 + 71-AC-4 commits. The only core deltas are in 69's own chunk-A
      files: `tools.ts` (spawn success carries `gated: true` when the
      posture gate allowed via the seam — so the durable tool-call record
      carries approval-allowed provenance for presentation-time replay) and
      `tool-results.ts` (the optional marker's type).)

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

### 2026-09-19 — agent (chunk B implemented: projections + 81's cards + the 71 AC-4 slice; only live ACs remain)

Landed in three commits: **e9f18ab** (71 AC-4 location map via this ticket's card
contract), **9bcdd4d** (chunk B projections), **1acb918** (81's card rendering).
Gates at 1acb918: `npm run typecheck` clean (both configs); `npm test` **1056 pass /
0 fail**, fully offline; `npm run build:client` ok. B3 verified at the git level
(empty diff over `access-types.ts` / `access-relay.ts` for the whole range).

**What landed**

- `src/client/approval-cards.ts` (pure, no React): the §3 frozen shapes.
  Access-ask cards project from `listPending` + `AccessNotice` only; status
  `pending | resolved | expired` (a timeout deny = expired, ADR-0008; pending
  truth outranks a skewed notice for the same worker — the relay parks at most
  one ask per worker, so workerId joins; a notice with no remembered ticket
  carries honest unknowns `""/0` and renders no actions). Worker-dispatch card:
  `projectDispatchCard({callId, args, result})` → `null` for unsettled/malformed
  records (never a fabricated spawn); `gating` derives from the record's own
  `gated: true` marker (chunk A's spawn result) and `auto-review-refused`
  reason — replay-safe by purity.
- `src/adapter/access-prompt.ts`: 71 AC-4's per-producer-kind label map
  (`approvalLocationLineFor`; worker + unknown → the local line, computer/browser
  worker → the remote line, capability-independent) — the prompt pathway resolves
  its detail line through the map now (shipped output byte-identical).
- `src/client/approval-pane.tsx` + conversation/integration (1acb918): 81's cards
  (see ticket 81's comment for the rendering reconciliation).

**Interpretations vs the frozen §3 shapes (documented, none blocking)**

1. `gating: "approval-allowed"` required the durable record to say so: the spawn
   success result now carries `gated: true` (set only when the seam answered
   allowed-once). `tool-results.ts`/`tools.ts` are this ticket's own chunk-A
   files — B3's protected surfaces untouched.
2. §3's outcome pair "spawned-worker-id | refused-reason" is preserved exactly:
   an unsettled spawn projects NO card (the generic tool row remains the pending
   presentation) rather than inventing a third outcome.
3. Access-ask `workerTitle` comes from an injectable resolver, defaulting to the
   workerId (the relay's tickets carry no title); notice cards use the notice's
   title when no remembered ticket exists.

**Reconciliation notes for the closeout**

- The card rendering landed under 81 (placement, copy, honest states, U-A
  retry-less failure lines). The relay-truth FEED and the resolve transport into
  `Multitask.resolveAccess` are NOT wired client-side yet — the approvals store
  ships `unfed` and renders nothing (honest unknown). That wiring is L1's, and
  the approval-service inject note at `dsh-adapter-api-notes.md:390` applies to
  the dispatch seam too.
- The 85 agent's a2c09ed swept the index.ts approvals-wiring hunks (plus an
  exactOptionalPropertyTypes call-site fix in `approval-cards.ts` that 9bcdd4d
  shipped red) — attribution recorded there; no semantic overlap with 85.

Ticket stays **open**: L1–L4 (live lane) pending; Q1 stays ready-for-human.

### Handover 2026-09-19 (session end)

The L1 wiring agent was cancelled mid-flight. Its uncommitted work was **kept, not reverted** — gates re-run on the recovered tree are green (`npm run typecheck` clean, both configs; `npm test` **1044 pass / 0 fail** over 256 suites; `npm run build:client` 161,087 B) — so the partial work is frozen as **`d25d6ef`** ("Ticket 69/89: WIP checkpoint from cancelled agent … tests green"). Worktree clean at session end. It did **not** finish the ticket: everything below compiles and passes offline tests but has had no live or independent verification.

**Left by the cancelled agent (L1 offline half, apparently landed):**
- `src/client/approval-feed.ts` — the shared relay feed/hub (`createApprovalRelayFeed`, `attach`): publishes pending-ask truth, replays the last good set, detaches with the fiber; `test/approval-feed.test.ts`.
- `src/client/index.ts` — `mountShellPage` takes optional `ShellApprovalFeedWiring`; the composition creates the feed at `:273` and hands it to both mounts (`:414`, `:460`); the approvals store attaches at `:552`; with no feed it stays honestly `unfed` and renders no cards area.
- `src/adapter/resolve-command.ts` + `registerDispatcherResolveCommand` (exported at `src/adapter/index.ts:153/165`), registered at `plugin.ts:622` — routes the explicit answer through the UNCHANGED core relay (`Multitask.resolveAccess`).
- `src/adapter/dispatch-approval.ts` (`createDispatchApprovalSeam`, `src/adapter/index.ts:40`), wired at `plugin.ts:470` (`requestDispatchApproval`); `src/adapter/cordis-dsh-host.ts` carries the seam surface.
- `src/core/roster-snapshot.ts` — v4 `pendingAsks` envelope (full pending truth, `parsePendingAsks` fail-closed on malformed/unbounded) — L1's feed source.
- `src/client/approval-pane.tsx` pickups; tests `test/dispatch-approval.test.ts`, `test/resolve-command.test.ts`.

**Remaining for L1–L4 (do not assume any of it works end-to-end):**
1. **L1**: prove the publish chain — snapshot v4 publish → feed → `ApprovalCardsStore` → "Needs you" pane — and that `registerDispatcherResolveCommand` resolves into the core relay on a real host. The offline tests pin units, not the composition.
2. **Q2-half offline pin** (dispatch-approval seam refusals/expiry under the fake host) if not already covered by `test/dispatch-approval.test.ts`.
3. **Live halves on the 45/33 lane**: L3 (real `ctx.approval` face) and L4 (live card resolve round-trip); 81 stays the card-rendering surface, 30 stays the live answer surface.
4. **Q1 stays ready-for-human** (§6): whether any non-empty default/Config-seeded posture should ship is undecided; `d25d6ef` does not touch it.

**Successor opens first:** `src/client/index.ts` (`mountShellPage` + `ShellApprovalFeedWiring` seam), `src/client/approval-feed.ts`, `src/client/approval-cards.ts`, `src/client/approval-pane.tsx`, `src/adapter/resolve-command.ts`, `src/adapter/dispatch-approval.ts`, `src/plugin.ts:460-480` and `:610-630`, then this ticket's Design 2026-09-19 comment (§2 classifier, §3 contract, §5 chunking) as the frozen contract.

### 2026-09-19 — agent (L1 OFFLINE composition pin landed: real watch → hub → mounted store → real resolve; RED-verified)

Closes the L1 gap the handover named — **"the offline tests pin units, not the composition."** One
new test file drives the REAL composition end to end; no link is hand-rebuilt.

**The chain the test drives** (`test/approval-feed-composition.test.ts`): real
`apply({enabled:true})` → real `/dispatcher-start` activation → real `spawn_worker` tool → real
`request_access` tool (park) → core `onRosterChanged` → real `rosterChannel.publish` → the owner
scope's `update` into the ONE shared settings document → the real `applyClientModule` settings
watch (`approvalFeed.applyChannelValue`) → the shared hub → **the composition's OWN
`mount.approvals` store from the returned `mounts`** → real `/dispatcher-resolve` command → core
`Multitask.resolveAccess` → re-publish → card leaves. A second test pins the fiber discipline:
one client-fiber teardown releases the watch, the settings card's own bind, and every mount's feed
attach (`bridge.subscribers.size === 0`), and a later host publish reaches nothing.

**Source seam added (smallest additive change):** `applyClientModule` now returns a
`ClientModuleComposition { approvalsFeed, mounts }` — `src/client/index.ts:235` (interface),
`:302` (the `mounts` array), `:445`/`:492` (each `slots.inject` pushes its `mountShellPage`
result), `:499` (return). `apply` ignores the return; the array is the same live array the injects
push into, so a late slot declaration still lands in it (offline fakes run the inject callback
synchronously, so the list is complete at return there). The mounted stores were previously
reachable only inside the React component closure — this is the observability seam, nothing else
moved.

**RED evidence (three breaks, each reverted after capture):**
1. Drop `approvalFeed.applyChannelValue(snapshot.value)` in the watch → both tests fail
   `'unfed' !== 'ready'` at the mount-store assertion.
2. Drop `feed.attach(approvalsStore)` in `mountShellPage` → same failure (`'unfed' !== 'ready'`).
3. Break the resolve route in `plugin.ts` (`resolve: () => false`) → the resolve assertion fails
   with the honest refusal (`kind:'error'`, `"…ask is no longer waiting…"`) instead of
   `{kind:"success", text:"Answer routed for child-1."}`.

**Gates** (worktree `wt/69l1`, offline, no browser/LLM): `npm run typecheck` clean (both configs);
`npm test` **1046 pass / 0 fail** (257 suites; baseline 1044/256 — +2 tests, +1 suite);
`npm run build:client` ok, **161,214 B** (was 161,087 B — +127 B for the seam).

**Also fixed in this pass:** `test/resolve-command.test.ts`'s integration test claimed
"Answering again after settle is honestly refused (ticket gone)" while asserting nothing about it.
The assertion it describes was added (a second command invocation after the settle returns
`dispatcherResolveNoPendingAsk`) rather than weakening the comment.

**Still not claimed:** L1's LIVE half (inline render in the wrapper conversation, live resolve
round-trip), L2, L3, L4 — untouched, still the 45/33 lane's. The offline pin proves the
composition's data path, not that the live slot declaration / React mount behaves; the React
render path with a fed store is still unpinned (`test/client-approval-pane.test.ts:262-274`'s
hooks-need-React note stands).

### 2026-09-19 — agent (Q1 RULED: shipped posture stays EMPTY; no Config-seeded posture)

**This is an overnight dispatched ruling by an autonomous agent, not a human signature.** The
human delegated judgement calls for the unattended session ("don't ask me anything, trust your
judgement") and is away; the ruling below is recorded so it can be reversed with a signature
rather than re-derived. Q1 is hereby ticked as ruled (header field added).

**The question** (§6 Q1, verbatim): "Should any non-empty default/Config-seeded posture ever
ship?" — i.e. should the review posture the mechanism reads be pre-armed at construction or from
plugin Config, so some access classes auto-answer without the user having acted?

**Ruling — NO, on both halves:**
1. **Shipped default stays EMPTY.** No rows exist at construction; posture content enters only
   through an explicit, in-session user act (session-scope rows, wildcard-fenced, cleared with
   the session).
2. **No Config/settings-seeded posture, ever, without amending ADR-0018.** A Config field
   declaring posture rows is a persisted, settings-managed rule store — exactly what exception
   **U-D** excludes. This is not a new deviation needing a new exception-list entry: U-D already
   covers it, so the answer is "the exception list already forbids it", not "let's add a rule".

**Evidence consulted (file:line)**

- `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:16` — "classifier-gated
  auto-review" is **in scope, formerly excluded**: the mechanism is owed, and it shipped
  (`src/core/review-posture.ts`, `src/core/tools.ts:288-331`). The imitation duty is discharged
  by the mechanism being present and consent-gated, not by shipping pre-armed content.
- `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:21` — "This list is exhaustive;
  anything not on it is imitated" (the master rule).
- `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:37` — **U-D**: "'Always allow'
  approval rules are session-scoped, not persisted; no settings-managed rule store, no dedicated
  local tool-permission controller." A Config-seeded posture is the excluded thing by name.
- `docs/research/always-on-dispatcher-behavior.md:51` — the reference's card anatomy carries the
  always-allow choice as a **choice on a card** (an explicit user act); no pre-seeded rule set is
  recorded anywhere in the notes. The classifier is described as deciding *what pauses*, not as
  shipping an allow-list.
- `docs/research/always-on-dispatcher-behavior.md:104-105` — recorded **depth limit**: the note
  is "breadth over depth", approval flows "covered shallowly". Ticket 69's Design §1 already
  states the classifier's decision INPUTS "were not recovered and are not invented here". A
  non-empty default would therefore be *invented* reference policy — the one thing the research
  discipline forbids.
- `docs/research/reference-architecture-patterns.md:70` — "Auto-review: blocked actions raise
  user-facing approval cards; worker escalates by retrying the same tool… **the human is the
  decider**." The reference's default is to route to the human.
- `docs/research/reference-agent-lifecycle.md:42` — "retire the session — **expire auto-review
  approvals**…". The reference's approval state is session-lifetime-bound; a pre-armed posture
  that survives sessions is not the reference's model either.
- `src/core/access-relay.ts:22-26` — shipped consent seed is EMPTY: "Every class asks… No
  `allow *` in the shipped seed." A non-empty posture default would be the *only* auto-answering
  surface in the shipped product, with no counterpart in the consent table it composes after.
- `src/core/review-posture.ts` (`createReviewPostureTable`) — no seed parameter by design;
  composed after the consent table at `src/core/multitask.ts:341-360`, so a posture row can only
  ever answer a consent **"ask"** miss.
- `test/review-posture.test.ts` — "consent deny beats posture allow" / "consent allow beats
  posture deny" (A1's never-override-an-explicit-deny order) and "empty posture always asks
  (shipped posture is EMPTY)" are already pinned; this pass adds a composition-level pin in the
  A2 test (`multitask.reviewPosture.list().length === 0` on a freshly composed core).
- `docs/adr/0011-approval-session-scope-always-allow-fenced-option-set-draft-nonhuman-approved.md:13`
  — "**Profile/preset writes are deliberately out of scope** (consent trap)"; and its
  Consequences: "**Consent can never silently widen**: the remembered artifact is (session,
  class, exact target)". A non-empty shipped default widens consent with **no user act at all** —
  a direct contradiction of the shipped consent model and its copy.
- `src/adapter/access-prompt.ts:30-58` — shipped prompt copy/options model the same boundary
  (session-scope only; "always" never outlives the session). Nothing shipped promises or implies
  a pre-approved class.

**Reasoning (why the evidence lands here, and what the steelman was)**

The strongest argument *for* a non-empty default is that the reference's classifier presumably
lets safe actions run without asking, so an empty posture looks like asking the human more than
the reference does. That argument fails on two independent grounds. First, we do not know what
the reference's classifier allows — its inputs were never recovered (`always-on-dispatcher-
behavior.md:104-105`), so any default we shipped would be our invention wearing the reference's
name. Second, our architecture never had a "silent action" to suppress: a worker must raise an
explicit structured ask (ADR-0008), and a posture **allow** answers an ask the worker already
raised — it does not suppress one. So the honest role of the posture is policy *answering*, and
answering with a policy the user never stated is precisely the "silent widen" that ADR-0011
forbids and U-D excludes. Where the reference does pre-allow something (a saved rule), it is the
result of a user clicking "always allow" — an explicit act, which is exactly the path we keep
open. Finally, the imitation rule is satisfied by the mechanism: ADR-0018 names the area in
scope and the table, the consent-miss composition, the deny copy, the dispatch gate, and the
wildcard fence all shipped; a pre-armed policy is content, not mechanism.

**Reversal path (deliberately cheap in this direction)**

- To allow posture *content* later, the smallest step needs no ADR change and no migration: an
  explicit in-session act (e.g. an "always allow this rule" choice on a card) writing a
  session-scope row — the shape the table already supports and tests. Nothing is persisted, so
  seeding later breaks no one.
- To ship a **non-empty default or Config-seeded posture**, a human must amend ADR-0018's
  exception list (U-D) with a signature, then add the Config field and its seeder; the reversal
  is a code change plus a re-rule, not a data migration.
- Either direction is safe to reverse; the reverse direction (shipping a pre-armed policy now and
  walking it back after it auto-answered real prompts) is not, because answers already delivered
  cannot be un-delivered.

**Residual uncertainty (recorded honestly)**

We cannot prove the reference ships no pre-armed allow policy — the notes never walked its rule
store's initial contents (`always-on-dispatcher-behavior.md:105`). If a future observation shows
the reference pre-arms something, the correct response is still not "seed ours": it is to record
the finding and let a human amend U-D, because U-D (session-scoped, never persisted) is itself a
human-accepted deviation.

**Changes made by this ruling (smallest correct):**
`src/core/review-posture.ts` — the `createReviewPostureTable` doc comment now records the ruled
empty default, the reason, and that any seeder is a U-D amendment; `test/review-posture.test.ts`
— the A2 test pins the empty posture at composition level. No behavior change, no new field, no
new ticket (nothing is implied that is not already covered by chunk A/L-lane ACs).

### 2026-09-20 — agent (W7, L3 offline wiring pass: seam wiring verified landed; plugin-built seam pinned offline, RED-checked)

**Finding first (corrects the plan's premise):** the L3 wiring this pass was scoped to do —
`"approval"` in the plugin `inject`, and `createDispatchApprovalSeam` built from the real
`ctx.approval` — **already landed on main in d25d6ef** (the cancelled L1 agent's WIP checkpoint,
see the handover comment): `src/plugin.ts` inject line + `activateToolSurface` toolDeps. L3's
"deliberately not wired" note above predates that checkpoint. What was actually missing offline:
NO test could see that wiring (the shipped posture is EMPTY, so the plugin-level gate never
fires, and no seeder ships — Q1/U-D), so a dropped or mis-scoped seam line was invisible to the
whole suite. This pass pins it.

**What landed (merge `14ee7a9`, branch commit `261fe34`, branch `wt/69-l3-wiring`):**

- `src/plugin.ts` — the wiring line factored into an exported builder
  `dispatchApprovalSeamFor(ctx, host, sessionId)` (behavior identical; call site
  `activateToolSurface` unchanged in effect). The builder is the plugin's OWN construction:
  `getApproval: () => ctx.approval`, `getAgent: () => host.parentAgentOf(sessionId)` — the ask
  scoped to the activated dispatcher's Agent, fail-closed on every degradation.
- `src/adapter/dispatch-approval.ts` + `src/adapter/index.ts` — `DispatchApprovalFn` re-exported
  through the barrel (type-only, no behavior).
- `test/dispatch-approval.test.ts` — new suite "plugin wiring: dispatchApprovalSeamFor":
  (1) round-trip through the plugin builder over an INJECTED `ctx.approval` — allowed-once
  proceeds with `gated: true`, exactly one ask reaches the service carrying the activated agent,
  `spawn_worker` tool name, and the dispatch title/stream key; (2) `rejected` / `cancelled` /
  `unavailable` from the real service each refuse honestly (`auto-review-refused`, outcome named,
  no host spawn); (3) host WITHOUT the approval capability (absent `ctx.approval`) fails closed
  and the turn settles — the Q2 no-wedge pin, now through the plugin's own builder; (4) posture
  miss never reaches the injected service (A6 "miss → spawnWorker untouched" at wiring level);
  (5) source-level wiring pin (composition-polish idiom: source read, comments stripped) asserting
  the `requestDispatchApproval: dispatchApprovalSeamFor(ctx, host, sessionId)` line and the
  `getApproval: () => ctx.approval` read. Pre-existing coverage NOT duplicated: seam unit
  degradations, gate-level fake-seam matrix (`test/review-posture.test.ts` "worker-dispatch
  gate"), and the Q2 no-wedge pin over a hand-built absent-approval seam (this pass rebuilt the
  shared `setup`/`spawnTool` helpers at module scope — no test semantics changed).

**RED-check (honest scope):** dropping the `requestDispatchApproval` wiring line from
`plugin.ts` → the source-level pin FAILS ("activateToolSurface must wire the spawn gate to the
plugin-built dispatch approval seam") while all behavior pins stay green; restored → 12/12 green
in the file. The behavior pins RED on the builder's contract (mis-reading `ctx.approval`), not on
the call site — stated plainly: an apply()-level gated round-trip remains impossible offline
because no shipped path creates a posture row through the plugin (no seeder, per the Q1 ruling).
That end-to-end gated proof is exactly W12's live lane (in-session Multitask API seeding in the
test harness only).

**Gates** (main at merge, offline, FakeDshHost — no network/LLM/browser): `npm run typecheck`
clean (both configs); `npm test` **1108 pass / 0 fail over 270 suites** (baseline at this run's
start: 1103/269 — +5 tests, +1 suite). **B3 holds:** `git diff` over `src/core/access-relay.ts` /
`src/core/access-types.ts` vs e069b8a is EMPTY. No posture seed anywhere (`reviewPosture.set`
appears in tests only); shipped posture stays EMPTY; Q1 not relitigated.

**Still open on this ticket:** L1–L4 live halves (W9–W12: live-lane probe → L1/L2 + 81/30 →
L3/L4 through the real `ctx.approval` waterfall and posture auto-answer) and Q1's human
signature. The live-only question this pass could not answer: whether the shipped client approval
composer still answers under the wrapper's root frame.

### 2026-09-20 — agent (W19, FINDING 1 from live Session B-2: root cause pinned at the worker contract; registration surface ruled OUT; fix landed + RED-checked)

Issue reference: ticket 33's Session B-2 comment 2026-09-20 (commit `39a0dca`), FINDING 1 —
logged there per the tracker rule; no new ticket filed. Merge **`f8067c3`** (branch
`wt/approval-relay-live-fixes`, commits `ec105ae`/`ef30cf8`).

**Root cause — the registration hypothesis is DISPROVEN; the gap is model-facing.** Host-source
read (installed `@deepseek-ai/*` 0.1.5-rc.2, never the reference tree): tool visibility is
`ScopedLayers.merge(scope)` = the GLOBAL layer plus the scope-parent chain
(`dsh-scope/lib/index.js:158-186`); scope tags are minted only by agent loops (`createScope`,
`:287-305`), so the plugin ctx is UNSCOPED and `request_access`'s plugin-level registration
lands in the global layer — which reaches EVERY agent's view, workers included. The surface
selection was already locked offline (`test/activation-lifecycle.test.ts:536` "request_access
stays global", `test/multi-dispatcher.test.ts:373`), and the tool→park relay round-trip is
pinned end to end (`test/approval-feed-composition.test.ts` drives the real tool). Nothing
about registration explains 3/3 skipped asks.

What nothing pinned was the worker MODEL's information: the worker contract
(`src/worker/prompt.ts`) never mentioned `request_access` at all, while its Autonomy section
said "Never wait for a reply" and its Limits said the final answer is the ONLY channel back —
and the host's own injected delegation statement tells every child that approval-requiring
operations "are rejected automatically" and to state limitations in the reply. Three instructed
workers skipping an undocumented ask tool that the whole surrounding prompt stack discourages
in spirit is the observed failure mode; a model-compliance explanation was recorded live, and
the contract was its mechanism.

**Fix (new copy, adapted; `ef30cf8`):** the contract gains an "Asking for access" section —
call `request_access` once (class/target/reason; credential NAME only, never a value), then
end the turn and stop; the parent's answer arrives as the next message; a denial is final,
never retried. Autonomy now names the ask as the ONE exception to no-wait; Limits names both
channels back. The host-guarantee non-restatement discipline holds (no "approval" /
"permission scope" wording; Safety stays the last section; no `{{`/`}}`).

**RED-check:** reverting `src/worker/prompt.ts` to main's pre-fix version → 4 pins fail
(headings + 3 new contract pins; 19 pass / 4 fail) → re-applied → 23/0 green in the file.

**Gates on merged main:** `npm run typecheck` clean (both configs); `npm test` **1118 pass /
0 fail / 271 suites** (baseline 1108/270/0). B3 holds (no `access-relay.ts`/`access-types.ts`
delta); no posture seed; Q1 untouched.

**What a B-4 live session can now verify (L1/L2 lane):** an instructed worker actually CALLS
`request_access` (firehose `tool/call` row on the worker session), a pending ask appears
(`settings/describe` `pendingAsks` non-empty; roster snapshot v4), the card renders inline,
`/dispatcher-resolve` round-trips, and the row's blocked marker shows while waiting. If a
worker STILL skips the call with the documented contract, the remaining suspects are host-side
visibility (needs a worker-toolset diagnostic surface) — record, do not guess.
