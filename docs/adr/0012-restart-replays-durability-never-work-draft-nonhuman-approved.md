# Restart replays durability, never work

**Status:** draft (non-human-approved) — agent-drafted 2026-09-19 (ticket 33 close-out, part 1), pending human sign-off; records the decision actually shipped by ticket 31 (+ tickets 57/58). **Wording loosened by human ruling 2026-10-18:** the no-re-run behavior below is the chosen product shape, not a permanent prohibition — it may be breached in future for a good reason, with the reason recorded.

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0012, consuming the slot design-17 §9 reserved ("activation-replays-durability" → ticket 31). Title widened from the design's "Activation replays durability" because the trigger re-based under ADR-0018 (below); the replay rule itself is unchanged.

## Decision

**Current shape (human-directed, revocable).** When a dispatcher session (re)starts, it **replays durable records only** — it does not re-run a worker, re-dispatch work, or invent state the markers do not carry. This is the behavior we ship today because it avoids duplicate side effects, not a standing prohibition: a future change may resume interrupted work if it brings a good reason, and that reason is recorded here or in the ADR that revises this one. As shipped by ticket 31 (commit `818d03c`, merged `400450f`):

1. **Rebuild before first publish.** `multitask.rebuildFromDurability(sessionId)` completes **before** the first `publishRosterSnapshot` and the prompt-pump sync (`src/plugin.ts` `rebuildAndNotice`), so restored terminal rows are in the very first snapshot and landed-undelivered items flush on the first wake (S4 across restart). Core rebuild semantics stay frozen (ADR-0006) — this is adapter ordering only, and the ordering is the acceptance rule (pinned by test).
2. **One-time unknown-state honesty.** A marker whose worker state is unknown is reported once, conversationally — count, ids, transcript refs, "state is unknown, nothing was replayed" — and the unknown-state row **never lands on the roster** (core rule); a restored-with-undelivered-results rebuild emits `restart.restored` instead. Fires at most once per activation; silence on an empty report; a marker-store failure degrades to one honest "nothing was restored and nothing was replayed" notice while activation still succeeds.
3. **Delivery rides a turn-opening wake.** The notice is routed through the WAKING primitive (ticket 57, deviations register D-4) — the reference re-wakes its parent on boot so the notice is acted on without the user speaking first; a context-only inject would not. Ticket 58 (D-5) adds `redriveUndelivered` on the same hook: a restored result that settled pre-restart and was never delivered gets one bounded redrive turn, which also escalates an already-exhausted obligation to `lost` — bounded, so it cannot become the unbounded persistence ticket 58 exists to remove.
4. **Divergence reaffirmed.** The reference's restart model is a pure pending-wake ledger; ours additionally replays durable worker records across process restarts. This is a recorded deviation (deviations register, PRD §15.7 / ADR-0006 lineage), not an accident — durability is the minimum-to-reconstruct (ADR-0006), so replay reconstructs the ledger without giving completed work a second life.

## Context

- **Trigger re-base.** Design-17 wrote this ADR's flag as "landing with ticket 31" under ADR-0009's explicit-command activation model. ADR-0018 retracted ADR-0009's premise (no mode; always-on), so the "activation" wording is moot in its old form: the same hook now means the per-session dispatcher lifecycle bind (ADR-0019) — a session that becomes a dispatcher at session start/boot replays; ticket 31's own re-scope records this. The chain is guarded by the activation generation it captured at activation (`activationGeneration`; ticket 90 F2 — it subsumes ticket 31's `isDispatcherSession` check), so a session that stops being a dispatcher mid-rebuild — or a stale chain resuming after a deactivate → re-activate of the same session id — publishes and injects nothing. Ticket 90 F3 adds the concurrent half: while a rebuild is in flight for a session, roster-affecting transitions for it do not publish, so the FIRST snapshot after activation still carries the restored rows.
- Ticket 31 flagged ADR-0012 forward to ticket 33 rather than claiming it; ticket 32 confirmed the set (0010/0011/0012) existed nowhere and handed resolution to ticket 33. This filing resolves that handover; nothing new is decided beyond what shipped.

## Consequences

- Restart can lose live workers' *presence* but never silently fabricate it: unknown-state is honest-by-notice, absent-by-roster.
- The restart path is bounded by construction: one notice, one redrive pass, no re-execution — replay cost is marker reading only.
- If a future boot hook generalizes the trigger beyond the per-session bind (the ADR-0016-retracted idea), it must call this same method — the replay rule, not the trigger, is the decision.
- **This shape is not a veto.** Resuming interrupted work after a restart is a legitimate future option — DeepSeek-Bot's `resume.js` is one reference shape for it (see `docs/research/third-party-dsh-plugin-comparison-2026-10-18.md`, item 2). Adopting it needs a ticket that states the duplicate-side-effect risk it accepts and how the risk is bounded; until then, the current shape stands.
