# DD-186 — Routines UI: schedule editor, trigger schema, and run history
- **Area:** A22 automation
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference ships a client-side routines panel under its recovered frontend feature tree, in the automations area (`the reference tree's frontend/src/recovered/features/automations/routines/`). Described by role, it carries:

- **A panel view, controller, and stylesheet** — the routines UI itself, with a run-history list including row and empty-state presentation (`view.tsx`, `controller.ts`, `view.css`; run-history presentation noted at `view.tsx:124-125`).
- **A schedule editor** — a fixed quarter-hour time picker: a 15-minute step yielding 96 time choices across the day, recorded in the component's evidence comment (`schedule-editor.tsx:12`), over a schedule normalization/validation module that maps between the editor's fields and cron-style fields (`schedule.ts`).
- **A trigger schema form** — a typed trigger-schema module plus a draft controller managing in-progress trigger rows, with a recorded cap of eight trigger rows and a note pinning the 15-minute picker interval (`trigger-schema.ts`; `trigger-draft-controller.ts:2-4`).
- **A run-history view** — a history provider plus a shared relative-time clock (timezone-snapshot based, with a detected-timezone fallback) rendering run entries with relative elapsed-time phrasing (`run-history.ts:1`, `:68-74`; `run-history-clock.ts`; `run-history-provider.ts`).

## What the current build does
**Absent.** The build's client UI is the floating dispatcher window and its launcher capsule (ADR-0022), built from the client modules under `src/client/` — the window store (`src/client/floating-window-store.ts`), the floating-window view (`src/client/floating-window.tsx`), the additive overlay/launcher code (`src/client/overlay.ts`), and the shell, panel, and conversation views alongside them. None of these host a routines panel: a scan of the client tree finds no routine, automation, schedule, or trigger vocabulary (the only matches are unrelated comments about input triggers, `src/client/actions.ts:138`, `src/client/index.ts:201`). There is no schedule editor, no trigger form, and no run history — because there is no routines subsystem for them to expose (DD-183).

## The deviation
The reference pairs its routines subsystem with a full editing and observation UI: pick a fire time, shape a trigger, watch past runs. The build has neither half. This is the client-side half of a capability ADR-0018 C14 rules out, and its absence follows from the subsystem's absence — with no stored routines, no trigger model, and no run records, there is nothing for a panel to edit, validate, or list. There are no independent client-side questions here: the panel does not survive the subsystem's removal, and a reversal of C14 would have to bring both.

## Verdict: DO-NOT-INCORPORATE
ADR-0018's exception **C14** — position 2 in the authority stack as part of the human-ruled master among accepted ADRs — is explicit and decisive: no routines/automations subsystem (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:29`), and this panel is that subsystem's client-side part, so it falls with the subsystem (DD-183) rather than standing as a separate decision. ADR-0022 fixes the build's client UI as the floating dispatcher window and launcher capsule, which is not a routines view. Nothing in the recorded rulings reverses C14, and no PRD amendment reinstates routines. This file is filed for completeness of the deviation inventory — the study logs each deviation separately — not because a separate decision is owed.

## Incorporation notes
- **Where it would live:** Nowhere under C14. If C14 were ever reversed, the subsystem's natural home is a sibling of the core modules with its own adapter layer (DD-183), and this panel would join the other client modules under `src/client/`, hosted through the existing overlay/launcher code (`src/client/overlay.ts`) the way the floating window is — not by reshaping the floating window itself.
- **Constraints:** C14 forbids the subsystem outright, so any work here needs a dated human reversal of C14 first, not an agent ruling. The panel would also depend on a data source the build does not have: no clock, no firing loop, and no run records exist (DD-183), and the client holds no scheduling vocabulary. ADR-0022's capsule/window arrangement is untouched either way.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — nothing is owed while C14 stands; if C14 were reversed, the panel would come along with the subsystem's own L-sized reversal (DD-183) as one more client view, so the risk here is mis-filing the UI as an independent product decision rather than engineering effort.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/automations/routines/schedule-editor.tsx:12` — quarter-hour picker: fixed 15-minute step, 96 time choices.
  - `the reference tree's frontend/src/recovered/features/automations/routines/schedule.ts` — schedule normalization/validation between editor shape and cron-style fields.
  - `the reference tree's frontend/src/recovered/features/automations/routines/trigger-schema.ts`; `.../trigger-draft-controller.ts:2-4` — trigger schema form and draft-row management (recorded cap of eight trigger rows; 15-minute picker interval pinned).
  - `the reference tree's frontend/src/recovered/features/automations/routines/run-history.ts:1`, `:68-74` — relative elapsed-time phrasing for run entries.
  - `the reference tree's frontend/src/recovered/features/automations/routines/run-history-clock.ts`; `.../run-history-provider.ts` — shared relative-time clock (timezone snapshot with fallback) and history provider.
  - `the reference tree's frontend/src/recovered/features/automations/routines/view.tsx` (`:124-125`); `.../controller.ts`; `.../view.css` — panel view, run-history list/row/empty presentation, controller, styles.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/automations/routines/` (panel view and controller, schedule editor and normalization, trigger schema and draft controller, run-history provider and relative-time clock).
- Build: `src/client/floating-window-store.ts`; `src/client/floating-window.tsx`; `src/client/overlay.ts`; the other client modules under `src/client/` (no routines, schedule, or trigger vocabulary — scan matches only unrelated input-trigger comments at `src/client/actions.ts:138` and `src/client/index.ts:201`). Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:29` (C14); `docs/adr/0022-floating-capsule-revived-by-human-ruling.md`. Related deviation: `reference-deviations/DD-183-routines-subsystem-absent.md` (the subsystem whose UI this is; cross-referenced, not duplicated).
