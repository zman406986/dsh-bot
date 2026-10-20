# DD-010 — Auxiliary overlay stack vs one additive seam
- **Area:** UI shell / window chrome (A1)
- **Type:** deliberate-divergence
- **Date:** 2026-09-23

## What the reference does
The reference shell keeps a stack of auxiliary overlays mounted at the top level of its production renderer. A single auxiliary-overlay union state (a small vocabulary of named overlay kinds plus an absent case, ProductionRenderer.tsx:216) selects which dialog is open, and each surface is `lazy()`-loaded with a `Suspense` fallback (ProductionRenderer.tsx:153-214 — settings, plugins, hidden-chats, the computer route, and the org-chart workspace view). The render tail (ProductionRenderer.tsx:3630-3679) conditionally mounts whichever overlay the state names inside a shared overlay-frame style, each with its own close handler that clears the overlay state; an error boundary wraps the settings surface; ad-hoc intents (a deep-link info dialog) open overlays of their own from the same pattern. In short: a full in-app window-chrome layer — stacked modal surfaces, lazy-loaded, closed by one shared state variable.

## What the current build does
The build registers exactly one additive `shell.overlay` entry: the launcher capsule (`LAUNCHER_ENTRY_ID = "multitask-dispatcher-launcher"` in `src/client/overlay.ts`; since ticket 107 / ADR-0022 the collapsed affordance is the information-bearing floating capsule). The header comment states this is "THE one `shell.overlay` entry the composition registers" — the roster entry survives only as retained contract data. There is no auxiliary overlay stack and no lazy surface layer: the `shell-mount.ts` composition machinery is retained but the capsule/launcher overlay registration is retired along with the superseded designs (only `LOCALE_NAMESPACE` is imported from `overlay.ts` there), and plugin settings live as a card inside the stock dsh settings UI (the W11 ruling, restored premise per ADR-0021's consequences), not as a separate overlay surface.

## The deviation
The reference solves "secondary functions" with a plural, self-managed overlay layer: many modal surfaces, one stacking state, lazy chunk loading, per-overlay error boundaries — effectively its own light window manager inside the renderer. The build deliberately does not have this layer. Its only shell overlay is the single additive extension-point entry that launches the floating dispatcher window, and every other secondary function (settings, roster history, approvals) either lives inside that one floating window or uses a host-native surface (the stock settings card). Nothing in the build owns a "which modal is open" stack, and no surface is code-split behind a lazy overlay mount.

## Verdict: DO-NOT-INCORPORATE
The single-extension-point rule is not an omission — it is the shape the ruling chose. ADR-0021 (decided by the human, 2026-09-20, decision 1) makes stock dsh the primary UI that is never displaced, and decision 2 sanctions the additive `shell.overlay` slot as *the* launcher path with crash isolation; an overlay stack of our own auxiliary surfaces would multiply the places our UI occupies the host and invert the coexistence premise. In the authority stack, ADR-0021 outranks this reference observation, so the divergence stands; expanding to an auxiliary overlay stack would contradict an accepted ADR decided by the human and therefore needs a fresh human ruling (a new dated decision with its own evidence), not an implementation choice.

## Incorporation notes
- **Where it would live:** if ever ruled otherwise, additional additive `shell.overlay` entries alongside `launcherOverlayRegistration()` in `src/client/overlay.ts`, with any stack state kept inside our own client module (never a `root`/`main` election — ADR-0021 decision 1).
- **Constraints:** coexistence by unique `multitask-dispatcher-` prefixed ids, never shadowing; crash isolation re-based onto the additive approach (a broken overlay entry must not take stock dsh down); stock settings stays the home of the plugin card (W11 — the 2026-09-20 ruling that the card stays an entry in the shipped settings UI); the anti-revival clause pattern of cancelled ticket 73 requires a new ticket with its own evidence for any new floating/overlay surface need.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — registration and a stack owner inside the floating-window client are straightforward, but each new host-occupied surface re-opens a settled ADR boundary and multiplies the crash-isolation audit surface.
- **Key reference anchors:**
  - the reference tree's `frontend/src/production/ProductionRenderer.tsx:216` — the auxiliary-overlay union (the stack's state vocabulary).
  - `frontend/src/production/ProductionRenderer.tsx:153-214` — lazy surface imports + the settings-overlay error boundary.
  - `frontend/src/production/ProductionRenderer.tsx:3630-3679` — the conditional overlay mount block, shared frame style, per-overlay close handlers, deep-link dialog.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 153-214, 216, 3630-3679)
- Build: `src/client/overlay.ts` (launcher as the one registered entry; roster entry retained data only), `src/client/shell-mount.ts` (overlay registration retired along with the superseded design; imports only `LOCALE_NAMESPACE`), `docs/adr/0021-addon-coexistence-floating-dispatcher-window.md` (decisions 1-2, consequences restoring the settings-card premise), `docs/surfaces.md`
