# 65 — The capsule's expanded window grows into the full dispatcher UI: dispatcher-bot conversations live inside it, dsh's own chat is not used for our surface

**Status:** open
**Labels:** needs-triage
**Blocked by:** none for research/design; implementation blocked by the open questions below
**Related:** 51 (dedicated dispatcher-bots surface — this ticket extends and largely subsumes it), 35 (capsule epic), 63 (draggable), 64 (collapsed chip key info), 50 (front-desk mode), ADR-0016, design-16

## Request (human, verbatim intent)

The expanded window should be **much larger** — it is where the chat/conversation with
dispatcher bots happens, essentially the whole of the reference's UI stuffed into it.
We are **not** supposed to use dsh's existing conversation/UI for our stuff: dsh runs in
the background while we build essentially the reference's window UI, but as a
**collapse-able window** (the capsule).

## What this means concretely

- The capsule's two states become: **collapsed chip** (tickets 63/64: draggable, shows
  ON/OFF + running count) and **expanded = a large floating window** that is the
  dispatcher product's whole UI, not a small overlay card.
- Inside the expanded window: selection of / conversation with **dispatcher bots**
  (roster rail + selected bot's conversation, the shape recorded abstractly in
  `docs/research/always-on-dispatcher-behavior.md` — cite the note, never open the
  reference tree; clean-room rules apply in full to this UI).
- The host dsh keeps running in the background; our surface must not depend on or
  repurpose the host's conversation box for dispatcher interaction.

## Tensions this ticket must resolve before implementation (do not skip)

1. **Delivery path (ADR-0009 / design-16 §3.5).** "Delivery remains conversational —
   the dispatcher speaks in the activated chat" was decided because `deliverToUser` is
   unwired and no verified non-conversational send seam exists. A big UI window that
   hosts dispatcher conversation needs a verified channel for (a) user → dispatcher bot
   input and (b) dispatcher → user delivery rendered *inside the window*. Ticket 51
   already reopened option D; this ticket widens the reopen. Verify the seam first.
2. **PRD S5/S6.** `completed` means delivered to user; dispatcher stays responsive;
   workers never address the user. The window is the dispatcher's face — workers still
   are not chattable identities inside it (ticket 51 R3 stands: user talks to subagents
   via normal dsh sessions only).
3. **Seam hard limits** (`docs/research/dsh-plugin-ui-patterns.md` Finding 5, `docs/surfaces.md`):
   no new chat node types, no `root` registration, no toasts, boot-once seats. A
   "whole-UI window" must be built from verified slots/commands or the finding that none
   suffices must be recorded as a blocker — do not spec against fantasy.
4. **Front-desk mode (ticket 50 / ADR-0016)** changes activation routing; the window's
   activation control must call the same command path, not invent a second one (epic 35
   honesty rules are binding here too).

## Suggested sequencing for the implementing team

1. Research/verify the conversation-in-own-surface seam (user input + delivery render)
   — this is the make-or-break question. Record an ADR (extends/revises ADR-0009).
2. Only then design the window: layout (rail + conversation), size/collapse behavior,
   drag (ticket 63), state wiring to the roster snapshot.
3. Fold tickets 51 and 35's expanded-panel scope into the window design rather than
   building the small card first and rebuilding it.

## Acceptance criteria (draft; refine after the ADR)

- [ ] ADR signed off resolving tension 1 (verified input/delivery channels) or the
      ticket is re-scoped honestly to what the seams allow.
- [ ] Expanded capsule is a large draggable, collapsible window hosting the dispatcher
      bot roster and conversation UI (clean-room; zero reference-tree artifacts, pass S7 grep).
- [ ] Dispatcher bot conversations happen inside the window; the host conversation box
      is not required for dispatcher interaction.
- [ ] Workers remain non-chattable in the window (ticket 51 R3).
- [ ] Collapsed state still meets tickets 63/64.
- [ ] Offline unit tests; live browser pass with trivial tasks only (kill timers per AGENTS.md).
