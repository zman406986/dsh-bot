# DD-019 — Command palette ("Jump to") vs none
- **Area:** command palette (A3)
- **Type:** missing-feature (deliberate — the ruling keeps all commands on host slash commands)
- **Date:** 2026-09-23

## What the reference does
The reference has a full global "Jump to" command palette: a modal dialog opened by a
mod+k shortcut that works anywhere in the app (`frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:48` —
an entry labelled as jump-to with hotkey mod+k that runs a toggle handler; also declared under the
palette shortcut id at `:6`). The surface is a palette component backed by a
family of production modules (`frontend/src/production/CommandPalette.tsx`,
`command-palette-model.ts`, `command-palette-provider.ts`, `command-palette-root-commands.ts`,
`command-palette-search-provider.ts`, `command-palette-link-provider.ts`,
`command-palette-message-provider.ts`, `command-palette-update-command.ts`).

Behaviorally it is an accessible combobox: a backdrop scrim over a dialog with an input carrying
combobox semantics, a result list exposed as a listbox whose active row is tracked via
activedescendant, a focus trap while open, and focus restoration to the previously focused element
on close. Opening resets the transient state — query text, active filter tab, highlighted row, and
any nested-command trail. Keyboard contract: Escape closes the palette, or pops one level of a
nested command before closing; Tab and ArrowLeft/ArrowRight on an empty input cycle the filter
tabs; Ctrl/Cmd plus 1..9 activates the correspondingly indexed row; Backspace on an empty input
ascends one nested-command level. The result list is virtualized: pure geometry helpers compute
the visible window and scroll position for a fixed row pitch with overscan
(`frontend/src/production/command-palette-model.ts:174-236`, with indexed-shortcut helpers
immediately after at `:238-247`). Root command rows are contributed by
`command-palette-root-commands.ts` (members, channels, chat settings, and an update action —
per `docs/research/reference-floating-window-summon-kill.md:101`, notably no delete command).
The research doc records this palette as the only session-management action reachable from a
global surface.

## What the current build does
Nothing — the build has no command palette at all. A case-insensitive grep for "palette" across
`src/` returns only two hits, both comments about CSS color tokens explicitly disclaiming a
private color palette (`src/client/shell.tsx:65`, `src/client/floating-window.tsx:44`), not a
command palette. There is no palette component, no modal combobox surface, no command-contribution
registry, and no mod+k binding anywhere in `src/` — consistent with the build's missing global
shortcut registry as a whole (see DD-016, and DD-018 for how reference shortcut mechanics were
otherwise handled).

## The deviation
The reference exposes a global keyboard-driven launcher (mod+k modal combobox with virtualized,
accessible result list, filter tabs, nested command trail, and indexed-row activation). The build
omits the entire surface. This is a deliberate design decision, not an oversight: in the build,
the only place a command can be seen is the host's own slash-command mechanism.

## Verdict: DO-NOT-INCORPORATE
ADR-0009 (`docs/adr/0009-activation-explicit-command-no-capture-on-load.md:5`) rules that with the
flag on, the plugin starts inactive and leaves the stock dsh UI unchanged, and the only visible
affordance is the host slash command — an always-available global palette would directly contradict
that accepted ADR, which sits above the PRD in the repo's ruling order
(`docs/agents-rulebook.md`). ADR-0018's imitation rule is the human-ruled top-level rule, but its
exception list plus ADR-0009's specific activation decision show the omission was already settled,
and a recorded ruling settles the question rather than reopening it. The research note
(`docs/research/reference-floating-window-summon-kill.md:101`) is evidence of the reference
surface, not a ruling to reproduce it. Only a human reversal could reopen this; if the human ever
wants a launcher, it should be a new explicit ruling rather than a quiet port.

## Incorporation notes
- **Where it would live:** n/a under the current ruling — if ever ruled in, the palette component
  would belong on the client surface beside the existing set of overlays (`src/client/`), with its
  model split out as pure helpers, mirroring the reference's split between model and component, and
  command contributions registered from the dispatcher/core rather than hard-coded in the client.
- **Constraints:** would need an ADR amendment or new human ruling overriding ADR-0009's
  "only visible affordance" rule; would also have to resolve how a global shortcut registry
  coexists with DD-016's absence and the host's own key handling; accessible-combobox semantics
  (listbox + activedescendant, focus trap/restore) and the virtualized list contract would be the
  core implementation work.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — a modal accessible combobox with focus trap, virtualization, tab cycling,
  nested-command trail, and indexed shortcuts is a large surface, and the risk is dominated by the
  conflict with ADR-0009, not the engineering.
- **Key reference anchors:** `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:48`
  (mod+k toggle); `frontend/src/production/command-palette-model.ts:174-247` (virtualized window,
  scroll geometry, indexed-shortcut helpers); `frontend/src/production/CommandPalette.tsx` +
  `command-palette-provider.ts` / `-root-commands.ts` / `-search-provider.ts` /
  `-link-provider.ts` / `-message-provider.ts` / `-update-command.ts` (component and command
  contributions); `docs/research/reference-floating-window-summon-kill.md:101` (palette as the
  only global management surface, and the root-command row set).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:6,48`;
  `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/CommandPalette.tsx`;
  `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/command-palette-model.ts:174-247`;
  `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/command-palette-{provider,root-commands,search-provider,link-provider,message-provider,update-command}.ts`;
  `docs/research/reference-floating-window-summon-kill.md:101`
- Build: absence — grep for "palette" over `src/` yields only color-token comments at
  `src/client/shell.tsx:65` and `src/client/floating-window.tsx:44`; no palette component or
  mod+k binding exists. Ruling: `docs/adr/0009-activation-explicit-command-no-capture-on-load.md:5`
