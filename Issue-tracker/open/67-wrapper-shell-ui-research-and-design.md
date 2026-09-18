# 67 — Wrapper shell UI: research and design the whole-UI wrapper around dsh (ADR-0018's vehicle)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none for research/design (the master ruling is in hand)
**Related:** ADR-0018 (master rule — "we build the whole UI"), 65 (human request this largely realizes), 72 (per-dispatcher tool scoping — gates any multi-dispatcher design), 27/28/29/31/49/66 (surviving view models, seam research, and presence logic to re-host), 33 (owns the close-out gates)

## Problem

ADR-0018 voids the plugin-UI vehicle (capsule chip / shell.overlay / toolviews, ADR-0013) and
rules: *we build the whole UI* — a GUI wrapper around dsh the way the reference is its own product
shell. Presence, the composer, panels, and every surface are ours. Nothing in the repo yet
researches or designs that wrapper; every surviving capsule-era asset needs a re-hosting decision.

## What to do (research/design ticket — no implementation)

- [ ] Vehicle decision first, as a draft ADR: standalone wrapper app (native shell embedding or
      speaking to dsh) vs hosting the dsh web client inside our own shell vs other evidenced
      options. Record the seam evidence for how the wrapper obtains: session list/identity,
      conversation streams, worker spawn/steer/stop, todo state, approval prompts, and the
      session/event firehose (ticket 29's verification is the starting map — re-verify against
      the installed host, read-only, file:line citations).
- [ ] Surface inventory: enumerate the reference's shell surfaces (from
      `docs/research/always-on-dispatcher-behavior.md` areas 1–3, 7–8 and
      `docs/research/reference-behavior-notes.md` — cite notes, never open the reference tree)
      and map each to: re-host from surviving view models / new build / excluded by ADR-0018's
      exception list (U-A, U-B, U-C, U-E, U-F, U-G, U-H, C13, C14 stay OUT — do not design them).
- [ ] Onboarding/first-run, auto-review, peer tier, and remote-computer hand-off: this ticket
      fixes only the vehicle; the four areas get their own tickets (68–71) — record their
      dependencies on the vehicle decision here instead of designing them.
- [ ] Multi-dispatcher placement: where multiple dispatcher sessions live in the shell UI;
      blocked by ticket 72's scoping verdict — design around both outcomes.
- [ ] Honest-decomposition plan: chunk the wrapper into small implementable tickets (epic-style,
      per repo rule), each offline-verifiable where possible.
- [ ] Copy policy: all wrapper copy is new or adapted (no verbatim text from the reference —
      AGENTS.md); names independent.

## Constraints

- The ADR-0018 exception list is exhaustive and the fidelity bar: anything not listed is held to
  the imitation standard.
- Read-only on installed host packages; never the reference tree; research notes cite file:line.
- Ticket 65's seam tensions (input channel, delivery render inside our own surface) are absorbed
  here — resolve them with evidence, not assumption.
