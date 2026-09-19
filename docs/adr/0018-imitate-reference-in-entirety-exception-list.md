# Imitate the reference in its entirety, except an enumerated exception list

**Status:** accepted (human-ruled, 2026-09-18 trim session)

**Supersedes wherever conflicting:** ADR-0005 (flag/toggle semantics), ADR-0009 (activation matrix; its deferred-binding *mechanics* may survive), ADR-0013 (capsule-as-one-overlay-slot; its seam research remains valid), ADR-0016 (already retracted), and the deviation register's U-1 row. **Amends the PRD** in the places listed under Consequences.

**Working record of the trim session:** `.scratch/adr-0018-trim-state.md` (includes the retraction of ADR-0009's premise and ticket 50/51's fabricated "verbatim directive" — both were hallucinated understandings recorded as human quotes, corrected by the human the same day).

## Decision

We imitate the reference product in its entirety — behavior, product experience, and face. Concretely this means:

- **We build the whole UI**: a GUI wrapper around dsh, the way the reference is its own product shell. Presence, the composer, panels, and every surface are ours. This voids the capsule-as-one-additive-overlay-entry approach (ADR-0013) and re-scopes the UI epic (tickets 27–35, 46, 49).
- **Multiple dispatchers are real**: each dispatcher gets its own dsh session (human-identified capability). This voids ADR-0003's single-bound-parent consequence and ADR-0009 option C's deferral. Verification item: the earlier research blocked multi-activation on process-global tool registration — the wrapper/sessions need per-session tool scopes or generalized session-keyed gating.
- **No dispatcher mode or toggle**: the wrapper window / expanded surface *is* the dispatcher; everything typed there goes to the dispatcher(s) living there. Always-on, like the reference.
- **In scope, formerly excluded**: onboarding first-run flow; classifier-gated auto-review; the peer tier (dispatcher-to-dispatcher messaging); the remote computer / bots' desktop area (dedicated computer/browser worker types, remote-box approval surfaces with location labels, recording/teaching, remote/cloud jobs) — **re-scoped 2026-09-19: capability-blocked at the host, exception U-I below; only the location-label slice stays live.**
- **Conformances confirmed** (shared with the reference, not deviations): workers are leaves — the reference's worker runs exclude the spawn, management, user-message, and peer-message tools (`docs/research/reference-behavior-notes.md:60`; refutes the older Gap-8 nested-subagent claim); workers never address the user; the todo list is the dispatcher's private ledger; stops are conversational.

## The exception list (the complete set of deviations)

Everything below is where we deliberately do **not** imitate the reference. This list is exhaustive; anything not on it is imitated.

1. **A2** — Workers inherit the host's base system preset; `persona` is a prefix section, not a blank slate.
2. **A4** — No send-journal semantics (no optimistic send / offline queue / flush-on-reconnect built by us); sends are direct. *(Restated for the wrapper era; previously "the composer is the host's.")*
3. **A5** — Persistence stays in dsh's session/job store; no second database.
4. **B8** — Steer is mid-run injection: context preserved, last-wins, no restart.
5. **B9** — Copy policy (amended 2026-09-18, same session): the reference reconstruction is public with unknown upstream provenance; **no verbatim copying**; adapted copying is permitted (see AGENTS.md). Recorded as a human accepted-risk decision, not a legal clearance.
6. **C13** — No agent-identity roster: no saved/hidden/pinned agent identities, avatars, per-agent persistent chats, or agent info panes as *identity* surfaces. (Dispatchers exist — via sessions — but are not a persistent identity roster.)
7. **C14** — No org chart, no routines/automations subsystem, no per-agent memory, no group rooms.
8. **C15** — Single wake kind: only dispatched workers flow through the wake bus, ledger, and running-tasks surface. No background one-shot commands, no remote/cloud jobs as wake kinds.
9. **C19** — We persist *more* than the reference: durable minimum-to-reconstruct worker records (ADR-0006) versus its start-marker-only ledger.
10. **D21** — The wake report body is clamped (4000/1200/200/300) where the reference has no bound.
11. **D22** — A bounded worker-liveness signal exists so a wedged worker can be noticed; the reference matches by absence.
12. **U-A** — No connection-lifecycle model: no transport state phases, reconnect banner, restored-snapshot-while-reconnecting, roster failure states, or privacy/account gates.
13. **U-B** — No rich chat ergonomics: no find-in-chat, threads/replies, reactions, per-agent drafts, rich attachment viewers, or URL cards.
14. **U-C** — No timeline/housekeeping cards in chat.
15. **U-D** — "Always allow" approval rules are session-scoped, not persisted; no settings-managed rule store, no dedicated local tool-permission controller.
16. **U-E** — Text-only delivery: no artifact references or file-transfer path on settle/delivery.
17. **U-F** — Context hygiene by clamping inline, not by spilling large outputs to storage with prompt-side references.
18. **U-G** — No runtime agent management: dispatchers are not created/cloned/kickstarted by agents at runtime; no agent create/update tools or profiles.
19. **U-H** — No per-stream usage/token accounting, no action audit trail, no local content-search index.
20. **U-I** — The remote computer / bots' desktop area is **capability-blocked at the host** (no remote-execution, computer-use, or browser-automation face exists; ticket 71's AC-1 read-only gate, 2026-09-19). Not a design choice — nothing to imitate yet. The capability-independent slice survives: per-producer-kind location labels, local by default. Re-opens if dsh ships a remote-exec capability family. *(Agent-recorded 2026-09-19 as a dispatched overnight ruling, subject to human reversal; ticket 71.)*

## Consequences

- **The exception list is the definition of "done" for imitation scope.** Tickets claim fidelity only against it; anything not listed is held to the imitation standard.
- **Register re-base.** `docs/research/dsh-core-loop-deviations.md` continues as the item-level tracker but now sits under this ADR's master rule; its Part B/C/D items are reclassified in a follow-up pass (ticketed as 64): A-4 is superseded (completion = first-visible-ack per B7's trim), A-5/A-6 are conformances, A-7/A-8 survive as D21/D22, R-1 remains (A2), B-1 stays a bug.
- **PRD amendments required** (batched in ticket 64, not silent): feature-flag/kill-switch sections (§11.5, §15.6) are voided — no flag, always-on; completion semantics (§6.5/"delivered to user") change to first-visible-ack; §8/§12/§17 clean-room sections change to the no-verbatim copy policy; S7's clean-room grep gate is voided.
- **UI epic re-scope.** Tickets 27–35, 46, 49 were designed as plugin-UI surfaces (capsule chip, right-panel sections, toolviews). ADR-0018 replaces the vehicle with a dedicated wrapper; those tickets are re-based, not silently closed (ticket 64).
- **Per-dispatcher sessions** need one seam verification before design work: tool registration scoping under multiple sessions (recorded above).
- The clean-room LQA merge gate (ticket 33) is re-scoped: its provenance review becomes a no-verbatim-copy review.
