# DD-015 — OS-to-shell intent plumbing vs none (grouped)
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature (grouped micro-deviations; the host owns these connections)
- **Date:** 2026-09-23

## What the reference does
The desktop host pushes intents into the renderer over its bridge; the reference tree's `ProductionRenderer.tsx` subscribes to each in one effect (lines 2763-2778):

- **focus-agent intent** — a bridge focus-agent subscription parsed as a focus intent and routed through the agent-open path: the OS-level shell can ask the window to bring a specific agent forward.
- **deep links** — a bridge deep-link subscription parsed as a deep-link intent: a plugin-add intent pre-fills the plugin query and opens the plugins overlay; a deep-link-info intent opens an info dialog; a bridge deep-links-ready signal (line 2778) marks the channel open.
- **force-onboarding intent** — a bridge force-onboarding subscription opening the onboarding surface (host-relaunch flag), paired with a bridge onboarding-skip subscription to close it.
- **open-about / open-feedback hooks** — host menu items open the about / feedback overlays.
- **update surfaces** — an update pill component (imported from the recovered update-feature views, line 116) is passed as the account menu's update-pill prop (line 3472), and an update-required component renders a full-window gate (line 3678), both fed by the host app's updater.
- **refresh-roster-on-window-focus** — a plain `window.addEventListener("focus")` re-fetches the roster when transport and visibility warrant it (a focus-refresh predicate, lines 2799-2808).

## What the current build does
Absent across the board. Spot-check found no focus-agent, deep-link, force-onboarding, about/feedback, deep-links-ready, or intent-parser helper anywhere under `src/`; there is no intent/bridge module in `src/client/` at all. The build is a single floating DOM window inside stock dsh — ADR-0021's one additive `shell.overlay` entry (`src/client/overlay.ts`, `src/client/floating-window.tsx`) — so there is no OS process to receive OS intents and no updater: update checks and app lifecycle are the host app's job. `docs/surfaces.md` already records "no deep-link" verdicts (lines 139, 188). No window-focus roster refresh exists either.

## The deviation
The reference connects its window to its desktop host through an intent channel; the build has no such channel and has none of the surfaces at either end. The sub-items split into two kinds: the OS-side half (OS focus-agent requests, protocol-handler deep links, host-relaunch force-onboarding, updater-driven update surfaces, host-menu about/feedback) has nothing to carry it in this design, while the in-window half (focus-refresh of the roster, about/feedback as ordinary overlays, an internal "open dispatcher X" intent channel that activation or notification clicks could target) is plain web code the build could adopt.

## Verdict: ASK-HUMAN
ADR-0018's exception list is exhaustive and rules none of these connections as owned by the host; the closest recorded rule is U-I's "capability-blocked at the host" pattern, but that was recorded explicitly for the remote area, so extending it by analogy would be silently picking. What *is* ruled: the accepted design (ADR-0021, as amended by ADR-0022) makes the OS-side delivery structurally impossible — no OS process, and ADR-0020's Electron/native-shell row is excluded as a PRD non-goal — while ADR-0018's default rule holds everything not on the exception list to the imitation standard, a real tension the authority stack does not settle. The in-window items (focus-refresh, about/feedback overlays, internal open-dispatcher intents) are unruled and cheap; the update surfaces are the strongest candidates for host ownership (the reference itself gets them from its host app) but that ownership is unrecorded. A human ruling is needed on which items to imitate inside the floating window.

## Incorporation notes
- **Where it would live:** an in-window intent channel beside the existing shell stores (a small `src/client/` intents module feeding `shell.tsx` / `floating-window.tsx`); about/feedback as auxiliary overlays in the `src/client/overlay.ts` stack; focus-refresh hooking `window.addEventListener("focus")` around `src/client/roster-store.ts`.
- **Constraints:** no OS-facing API may be invented (no protocol handlers, tray, or updater — the host owns those); any imitated surface must work inside the floating window and respect U-A's absence of connection-lifecycle states; focus-refresh must not present stale mirrors as live (ADR-0010 honesty rules).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — each in-window item is individually S, but every item needs a scoping ruling first; the OS-side items cannot be built in this design at any effort.
- **Key reference anchors:** the reference tree's `ProductionRenderer.tsx:2763-2778` (intent subscriptions), `:2799-2808` (focus-refresh), `:116` + `:3472` (the update pill in the account menu), `:3678` (the update-required gate).
- **Cross-references:** the audit's deep-links and updates deviation files (DD numbers pending); onboarding deviation — no rerun/onboarding deviation file exists in `reference-deviations/` as of this writing (cross-referenced deviations are being produced alongside this one), so the anticipated onboarding number could not be confirmed; cite the actual number when the onboarding deviation covering force-onboarding/rerun intents is filed.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 2763-2778, 2799-2808, 3472, 3678; update imports 115-116)
- Build: `src/client/` (no intent/deep-link/update module; `overlay.ts`, `floating-window.tsx`, `shell.tsx`, `roster-store.ts` only); `docs/surfaces.md:139,188` (no deep-link verdicts); `docs/adr/0021-addon-coexistence-floating-dispatcher-window.md` and `docs/adr/0022-floating-capsule-revived-by-human-ruling.md` (the floating-window design); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (exhaustive exception list, U-I pattern)
