# 65 — The capsule's expanded window grows into the full dispatcher UI: dispatcher-bot conversations live inside it, dsh's own chat is not used for our surface

**Status:** cancelled
**Labels:** needs-triage
**Blocked by:** none for research/design; implementation blocked by the open questions below
**Related:** 51 (dedicated dispatcher-bots surface — this ticket extends and largely subsumes it), 35 (capsule epic), 73 (draggable, renumbered from the duplicate 63), 66 (collapsed chip key info, renumbered from the duplicate 64), 50 (front-desk mode), ADR-0016, design-16

## Request (human, verbatim intent)

The expanded window should be **much larger** — it is where the chat/conversation with
dispatcher bots happens, essentially the whole of the reference's UI stuffed into it.
We are **not** supposed to use dsh's existing conversation/UI for our stuff: dsh runs in
the background while we build essentially the reference's window UI, but as a
**collapse-able window** (the capsule).

## What this means concretely

- The capsule's two states become: **collapsed chip** (tickets 73/66: draggable, shows
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
   drag (ticket 73), state wiring to the roster snapshot.
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
- [ ] Collapsed state still meets tickets 73/66.
- [ ] Offline unit tests; live browser pass with trivial tasks only (kill timers per AGENTS.md).

### 2026-09-19 — re-triaged against ADR-0018 (ticket 64): substance absorbed; retraction noted

- **Retraction noted:** this ticket cites ADR-0016 uncritically (Related line; tension 4's
  front-desk routing) and tension 1 cites ADR-0009's conversational-delivery decision. ADR-0016
  was **retracted** (its sign-off was given under a fabricated premise) and ADR-0009's activation
  premise was retracted the same day; ADR-0018 supersedes both. The Related line's pointers to
  50/51 are likewise to cancelled tickets.
- **The substance is now the master rule.** What this ticket asked for — the dispatcher's whole
  UI in our own window, with dsh's conversation box not used for our surface — is what ADR-0018
  accepted ("we build the whole UI"; the wrapper window *is* the dispatcher). It is absorbed by
  **ticket 67** (wrapper shell research/design, which inherits this ticket's seam tensions:
  user→dispatcher input and dispatcher→user delivery rendered inside our own surface) and
  **ticket 72** (per-dispatcher session scoping, which gates the conversation channel design).
  This ticket's "pass S7 grep" AC is voided with S7 (ADR-0018).
- The "Request (human, verbatim intent)" heading predates the day's retraction lesson; the quote's
  gist is consistent with ADR-0018, but verbatim-intent framing is no longer trusted as a record —
  the ADR is the authority.

**Stays needs-triage:** kept open as the human-request record; not independently actionable
without duplicating 67. Close as subsumed once 67's design confirms coverage of the seam tensions.

### 2026-09-19 — CANCELLED (subsumed): the capsule vehicle was retired; the substance IS the shipped shell

Dispositioned after ticket 78's cutover (commits `94e6127` root-frame election, `a44084a`
capsule/launcher overlay retirement, `c437ee8` evidence; live pass 4 confirmed shell-as-root
renders and the stock app returns on abdication). The expanded-capsule-as-whole-UI premise is
void — there is no capsule to expand — and the substance needs no separate tracking because
it lives in the shell itself:

- "The whole dispatcher UI in our own surface" → the wrapper shell frame IS the client
  (ADR-0020; tickets 77 skeleton + 78 cutover, landed).
- "Conversation with dispatcher bots inside our window, host chat not used for our surface"
  → ticket 80's conversation pane (composer + replay over the session event window) and
  ticket 79's sidebar roster/presence, both resolved; the seam tensions (user→dispatcher
  input, dispatcher→user delivery rendered in our own surface) were absorbed by 67 and
  resolved by 80 over ticket 40's verified transports (command transaction + plain-prompt
  sink, bound in `mountShellPage`).
- "Selection of dispatcher bots" → 79's sidebar rows with `sessions.open(id)` selection.
- First-run → 68 (in-shell onboarding seat); approvals → 81.
- The "pass S7 grep" AC stays voided with S7 per the 2026-09-18 ruling (ADR-0018).

Related-line hygiene (recorded, not edited): 51/35/50 are cancelled, ADR-0016 retracted —
already noted in the re-triage above. Remaining follow-up from this lane is dead-code
disposition of the retained capsule sources, filed as ticket 89.
