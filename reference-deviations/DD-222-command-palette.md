# DD-222 — Command palette: fuzzy-ranked, tabbed quick-action surface
- **Area:** A29 cross-cutting surfaces
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference ships a complete command-palette subsystem: eight files, 1,544 lines total, all under
its frontend production directory (the reference tree's `frontend/src/production/`). The surface component is the
largest file (382 lines); the model (299 lines) carries the pure logic; four provider modules
(162–196 lines each) feed result sources; a root-command projection (76 lines) and a
computer-update action (60 lines) supply the top-level rows.

The surface itself: an eight-category tab set — all results, messages, agents, groups, files,
links, routines, and actions (`command-palette-model.ts:11`) — with a cycling helper that steps
through the same ordered set (`:249-253`) and a per-entry tab filter (`:107-115`). Ranking is a
normalization/tokenization/fuzzy-scoring pipeline (the scoring detail is filed separately as
DD-021). Highlight movement is a pure helper that shifts a row index by a given amount and wraps it
around the ends of the list (`:174`), with the
component clamping it to the result count and resetting it on query, tab, and open changes
(`CommandPalette.tsx:129,143,159,305`). Long result lists are projected through a pure
virtual-window helper that computes the visible window and scroll geometry for a fixed row pitch
(`command-palette-model.ts:184-203`). Indexed number-key shortcuts are two pure helpers — one
mapping a row index to a shortcut number, one resolving a pressed key to a row index — both
disabled while a nested page is open or the modifier is not held, and capped at nine rows
(`:238-247`). Nested command pages are handled by a small helper that walks the list of command ids
leading to the current page and reports how deep it is, plus enter and pop transitions (`:276-299`), so a command
can open a child page and a key press moves back up one level (the key contract itself is DD-016/DD-018
territory, not this file's).

Root rows are projected by a module that explicitly owns no navigation, agent, or computer state:
it takes injected actions and fail-closes to an empty list when no agent is active, contributing
member info only for group rooms, channel info, chat settings, and a computer-update action
(`command-palette-root-commands.ts:29-76`, the update row at `:67`). A separate provider
contributes link entries, fetching their metadata lazily behind a six-state lifecycle — loading,
ready, empty, failed, unavailable, cancelled — with its own snapshot, an initial unavailable
state, request-id guards against stale responses, and cancellation on dispose
(`command-palette-link-provider.ts:22-25,101,144-166`; the routines provider has the same shape at
`command-palette-provider.ts:19-22,127-137`). The effect is that one failing or unavailable source
contributes no results rather than blanking the whole list.

## What the current build does
Absent. No palette, provider, scorer, or tab model exists under `src/client/`, whose modules are
panel, shell, conversation, approval-pane, settings-card, onboarding-pane, toolview-panel, and
floating-window, plus their store/feed/action siblings (`src/client/panel.tsx`, `shell.tsx`,
`conversation.tsx`, `approval-pane.tsx`, `settings-card.tsx`, `onboarding-pane.tsx`,
`toolview-panel.tsx`, `floating-window.tsx`, and the `*-store.ts` / `*-feed.ts` / `actions.ts`
modules beside them). A case-insensitive search for the word across the client tree returns only
two hits, both comments about CSS color tokens disclaiming a private color palette
(`src/client/shell.tsx:65`, `src/client/floating-window.tsx:44`) — no command-palette code. There
is no quick-action surface of any kind: the build's only command visibility is the host
slash-command mechanism (DD-020). The palette's existence is already filed (DD-019) and its
multi-provider search pipeline separately so (DD-021); the key-registration layer it would need is
DD-016/DD-018.

## The deviation
The reference treats a fuzzy-ranked, tabbed, keyboard-driven quick-action surface as the
cross-cutting navigation layer over all the content it holds — messages, agents, groups, files,
links, routines, and actions. The build has no such surface, and no set of content of that
shape: its client surface is a floating window over dispatcher functions (`src/client/floating-window.tsx`,
`src/client/shell.tsx`), so the reference's tab set has no in-window counterpart. Two ideas inside
the reference subsystem can be separated from the palette UI: (a) the helper that tracks nested
pages — a small pure navigation model in which a command opens a sub-page and the list of open
pages is tracked (`command-palette-model.ts:276-299`), portable to any hierarchical in-window
navigation; and (b)
the per-provider state machine — each result source reporting its own
loading/ready/empty/failed/unavailable/cancelled state so one failing source contributes no results
rather than blanking the list (`command-palette-link-provider.ts:22-25,144-166`,
`command-palette-provider.ts:19-22,127-137`). (b) is similar in spirit to the build's habit of
degrading honestly — the roster already degrades to presence-unavailable copy rather than
publishing a wrong
roster (ADR-0020's multi-dispatcher placement section) — but that is a family resemblance between
habits, not evidence the build needs a palette, and the build does not implement this pattern.

## Verdict: DO-NOT-INCORPORATE
A recorded ruling does cover the global palette: ADR-0009's activation rule (the app starts without
taking input, and the host slash command is the only visible entry point) is the ground DD-019 already ruled the palette
out on, and DD-021's search-pipeline ADAPT path is explicitly gated on that decision. A palette
of this shape is also shell-scale — its tab set spans an entire application's content — while the
build is a plugin whose client surface is a floating window over dispatcher functions (ADR-0021
decisions 1–2, accepted human-ruled 2026-09-20; ADR-0022, accepted human-ruled 2026-09-22), and
the PRD's non-goal on UI parity plus ADR-0020's rejected native-shell row frame it as an addon that
does not own the host shell (note ADR-0020 is draft/non-human-approved and its vehicle was
superseded by ADR-0021, so its weight sits below the PRD and it is cited here as record, not as the
operative ruling). ADR-0022 does establish the build's own window, so an in-window quick-action
surface is not categorically excluded — but no recorded ruling names one, and the deviation as
specified is not that narrower thing. If the human ever wants an in-window affordance, that is a
new explicit ruling rather than a quiet port.

## Incorporation notes
- **Where it would live:** n/a under this verdict. If a human ruling ever revives it, the surface
  belongs in the floating window's own module set under `src/client/` (beside `floating-window.tsx`
  and `shell.tsx`), with the pure helpers (tab model, scorer, virtual window, helper that tracks nested pages)
  split out as offline-testable units per the repo's offline-test rule, and command contributions
  injected from the core/adapter side rather than hard-coded in the client — the reference's own
  root-command module models that approach by owning no navigation state and returning an empty
  list when no agent is active.
- **Constraints:** (1) the ADR-0009 conflict must be resolved by a human ruling before any
  palette lands — DD-019 is the standing record; (2) an in-window variant could only cover
  dispatcher content (roster, conversation, approvals), since the reference's message, file, link,
  and routine tabs depend on providers and features the build does not have (DD-021); (3) of the
  two ideas that can be separated out, the state machine is the portable one and should be re-derived against the
  build's existing degradation habits rather than transplanted; (4) accessible-combobox semantics
  (listbox with active-row tracking, focus trap and restore) are the real engineering cost if ever
  revived.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — roughly 1,500 lines of surface in the reference, and the risk is dominated by
  the ADR-0009 conflict rather than engineering; under the standing ruling the effort is zero.
- **Key reference anchors:** the reference tree's `frontend/src/production/command-palette-model.ts:11` (eight-category
  tab set), `:107-115` (tab filter), `:174` (highlight movement), `:184-203` (virtual window),
  `:238-247` (indexed shortcuts), `:249-253` (tab cycling), `:276-299` (helper that tracks nested pages);
  `CommandPalette.tsx:129,143,159,305` (highlight clamp/reset); `command-palette-root-commands.ts:29-76`
  (root rows, fail-closed); `command-palette-link-provider.ts:22-25,101,144-166` and
  `command-palette-provider.ts:19-22,127-137` (per-provider state machine); `command-palette-message-provider.ts`,
  `command-palette-search-provider.ts`, `command-palette-update-command.ts` (remaining subsystem files).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/command-palette-model.ts`,
  `CommandPalette.tsx`, `command-palette-provider.ts`, `command-palette-link-provider.ts`,
  `command-palette-message-provider.ts`, `command-palette-search-provider.ts`,
  `command-palette-root-commands.ts`, `command-palette-update-command.ts` (all under the reference
  tree's `frontend/src/production/`)
- Build: `src/client/` (module list above; two "palette" hits at `src/client/shell.tsx:65` and
  `src/client/floating-window.tsx:44`, both CSS color-token disclaimers); `docs/adr/0009-activation-explicit-command-no-capture-on-load.md`;
  `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md` (status:
  draft, non-human-approved; vehicle superseded by ADR-0021); `docs/adr/0021-addon-coexistence-floating-dispatcher-window.md`
  (status: accepted, human-ruled); `docs/adr/0022-floating-capsule-revived-by-human-ruling.md` (status:
  accepted, human-ruled); `PRD-dsh-multitask-dispatcher.md` §2 Non-goals (UI-parity clause);
  `reference-deviations/DD-016-no-global-shortcut-registry.md`, `DD-018-shortcut-mechanics.md`,
  `DD-019-command-palette-absent.md`, `DD-020-slash-command-affordance.md`,
  `DD-021-palette-multi-provider-search.md`
