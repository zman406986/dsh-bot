# DD-012 — Zoom-factor plumbing vs absent
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The recovered reference frontend handles the zoom factor end to end. The reference tree's `frontend/src/recovered/features/window-chrome/model.ts` exports a root-shell zoom-factor setter (lines 48–50), which writes a zoom-factor CSS custom property onto `document.documentElement.style`, and a pixel helper (line 16) that divides px values by that property (defaulting to 1) so chrome metrics can counter-scale. The reference tree's `frontend/src/production/ProductionRenderer.tsx` (lines 2784–2786) seeds the factor from the desktop bridge's zoom-factor getter at startup and re-applies it live on zoom events; a zoom-factor-change bridge event is a named contract in `frontend/src/recovered/contracts/main-rpc.ts:43`. The variable is consumed by window-chrome CSS (`view.css:20,30` — including an inverse `zoom:` compensation — and `status-badge.css:4`) and by the computer shell view (`features/computer/shell/view.tsx:138` reads it back off the root element). Net effect: when the native shell host zooms the webview, selected chrome elements hold a constant physical size instead of scaling with content.

## What the current build does
Absent. A tree-wide search for "zoom" across `src/` and `client/` returns zero matches. `src/client/floating-window.tsx`, `src/client/floating-window-store.ts`, and `src/client/shell-mount.ts` contain no zoom handling, no root CSS variable, and no host-zoom listener; nothing in `docs/surfaces.md` or `docs/adr/README.md` mentions zoom either.

## The deviation
The reference solves a webview-bridge problem: its host is a native desktop shell that applies zoom at the webview level and pushes a zoom-factor-change event over a bridge, so the frontend must counter-scale chrome to keep it a constant physical size. The build runs as a DOM surface inside the stock dsh web client (the additive floating window adopted by ADR-0021), where the host browser zoom already applies natively and uniformly — there is no bridge injecting a separate zoom factor, so the infrastructure that motivates the feature does not exist here. The build has none of this machinery: no root zoom-factor property equivalent, no zoom listener, no compensating CSS.

## Verdict: DO-NOT-INCORPORATE
The reference's zoom code exists to compensate for a native-shell webview bridge (the desktop bridge's zoom-factor getter plus a zoom-factor-change event in `main-rpc.ts`), infrastructure the build deliberately does not rebuild (PRD §2 non-goals: no chasing Grok Bot binary/UI parity). I checked the host question the verdict hinges on: the build runs in the stock dsh web client in a browser, where host browser zoom (Ctrl+/−) already scales the whole DOM natively, and no stock-dsh or build-side zoom API was found anywhere in `src/`/`client/` — so the problem the reference feature solves does not arise in this setup. No recorded ruling covers zoom (nothing in `docs/adr/README.md` or `docs/surfaces.md`), so this verdict is a recommendation from the deviation analysis, not an authority-stack ruling: if the human ever wants chrome that keeps a fixed physical size under zoom (UI chrome fixed while content zooms), that is a new product decision to raise explicitly, and DD-012's incorporation notes below are the starting sketch.

## Incorporation notes
- **Where it would live:** a root CSS custom property set in `src/client/shell-mount.ts` or the floating-window registration site (the one live re-hosting site per ADR-0021), with counter-scaling consumed inside `src/client/floating-window.tsx` chrome metrics only if physically-pinned chrome were ever ruled in.
- **Constraints:** additive-only under ADR-0021 (never displace or re-style stock dsh's own surface); a live zoom source must come from the actual host — in a plain browser there is none beyond native browser zoom, so any listener would need a defined event contract first.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S for the variable + setter alone (~an afternoon); M if a real host zoom-event source had to be defined and pinned. Risk is low but the payoff is nil in the current design.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/window-chrome/model.ts:16,48-50` — variable + the root-shell zoom-factor setter
  - `frontend/src/production/ProductionRenderer.tsx:2784-2786` — initial + live application (note: this file lives under `frontend/src/production/`, not under `recovered/features/window-chrome/` as the enumeration hinted)
  - `frontend/src/recovered/contracts/main-rpc.ts:43` — the zoom-factor-change bridge event
  - `frontend/src/recovered/features/window-chrome/view.css:30` — inverse-zoom chrome compensation

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/model.ts` (lines 16, 48–50); `.../frontend/src/production/ProductionRenderer.tsx` (lines 2784–2786); `.../frontend/src/recovered/contracts/main-rpc.ts:43`; consumers `.../window-chrome/view.css:20,30`, `.../window-chrome/status-badge.css:4`, `.../features/computer/shell/view.tsx:138`
- Build: `src/client/floating-window.tsx`, `src/client/floating-window-store.ts`, `src/client/shell-mount.ts`, `src/client/index.ts`, `client/index.js` — tree-wide grep for "zoom" over `src/` and `client/`: zero matches; `docs/surfaces.md` and `docs/adr/README.md`: no zoom mention
