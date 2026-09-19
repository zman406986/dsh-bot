# Approval answers: Allow / Always allow (this session) / Deny, with session-scoped memory, a wildcard fence, and honest degraded paths

**Status:** draft (non-human-approved) — agent-drafted 2026-09-19 (ticket 33 close-out, part 1), pending human sign-off; records the decision actually shipped by ticket 30 (+ re-hosted by tickets 71/81)

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0011, consuming the slot design-17 §9 reserved ("session-scope always-allow" → ticket 30).

## Decision

Worker access asks are answered through a three-option consent surface whose memory is **session-scoped and never persisted**, with fences that keep consent from expanding on its own. As shipped by ticket 30 (commits `0e2e9fa`, wildcard-fence rework `7c90a25`):

1. **Option set:** Allow / **Always allow (this session)** / Deny. "Always" inserts a session-scope allow row (class + exact target) through the relay's existing policy table; a later ask matching that row auto-answers without prompting (the shipped policy no-op path — no new decision layer). **Profile/preset writes are deliberately out of scope** (consent trap; boundary in the module comment). This matches ADR-0018 exception **U-D** exactly: session-scoped, never persisted, no settings-managed rule store.
2. **Wildcard fence:** `matchTargetPattern` honors `*`/trailing-`*`, so an always-allow on a wildcard target would remember a whole class — privilege escalation. Shipped fence, three layers: wildcard targets degrade the offer to Allow/Deny; an always-shaped answer arriving for a wildcard target is not forwarded to the row insert (plain one-shot allow); and the row sink itself refuses any wildcard-target session row (defense in depth).
3. **Session clearance:** session rows are cleared on that session's deactivation and on unload/HMR (`AccessPolicyTable.clearSession()` + `Multitask.clearSessionAccessPolicy()`) — no "always" outlives its session, and under ADR-0019's per-session lifecycle, clearing one session never wipes a sibling dispatcher's rows.
4. **Honest degraded paths:** an explicit answer against a ticket that already timed out/denied surfaces `approval.expired` copy and resolves nothing (ADR-0008 semantics untouched); clamped detail (report-clamp pattern, hard cut + omission marker with counts; target names never truncated); a credential allow carries the "stored securely, never shown" reassurance (names-never-values invariant untouched).
5. **Location line:** shipped as one constant honest line ("Runs on your computer."), then superseded by ticket 71 AC-4's per-producer-kind location map — the constant line remains the map's local entry, so the shipped output stayed byte-identical through the change.
6. **Relay frozen:** timeout, deny-by-default, dedupe (`suppressesConversational`), released-ask re-queue are untouched — ticket 30 changed presentation and option plumbing only.
7. **Classifier-gated auto-review NOT adopted** (design-17 §5 conflict 5; standing constraint) — no auto-decision layer beyond the shipped policy lookup. Seeded as its own scope ticket (69).

## Context

- Rendering history: the prompt pathway was `ctx.userQuestions.ask` under the plugin-UI constraint (design-16 §4.4 forbidden list); under the wrapper (ADR-0020 slice 5), ticket 81's inline approval cards (`src/client/approval-cards.ts` + `approval-pane.tsx`) re-host **this same option set, wildcard fence, clamped detail, expired copy, and secret-stored copy**. Ticket 30 remains the live answer surface until ticket 69's L1 wires the card resolve transport; its relay/policy work never retires.
- Independent read-only verification within ticket 30 found and fixed the wildcard escalation (red-first tests; end-to-end prefix-neighbour probe) — the fence is tested at predicate, pump, and plugin levels.

## Consequences

- Consent can never silently widen: the remembered artifact is (session, class, exact target), bounded by the session's lifetime and the wildcard fence at three layers.
- Two surfaces (host prompt, wrapper cards) render one option semantics; until 69's transport lands, card resolves must not bypass the pump's liveness fencing.
- Location labels are now per-producer-kind (ticket 71): adding a remote producer kind means adding a map entry, not re-litigating honesty.
- Classifier-gated auto-review remains available as a future, separately-ticketed scope (69); adopting it would amend this ADR's rule 7.
