# DD-113 — Onboarding re-run/force intents vs none
- **Area:** onboarding (A13)
- **Type:** missing-feature (dev/tooling surface)
- **Date:** 2026-09-23

## What the reference does
The reference's dev wiring exposes two intents that drive the first-run flow from the outside, both confined to unpackaged builds. A re-run intent clears the has-seen flag in the settings store and then pushes a force-onboarding event over the existing preload bridge; the renderer subscribes to that channel and reopens the flow on demand (the reference tree's `source/electron-main/dev/dev-wiring.ts:90`; services wiring at the reference tree's `source/electron-main/main-production-services.ts:850-851`; renderer handler at the reference tree's `frontend/src/production/ProductionRenderer.tsx:2772`). A skip intent rides the dev control edge as an externally issued POST that force-closes the flow — the server relays it to the renderer over a dedicated skip channel, which the preload also exposes as a subscription (the reference tree's `source/electron-main/dev/dev-controls-edge.ts:52`; its IPC twin at `dev-wiring.ts:63`; subscriptions at the reference tree's `source/electron-preload/preload.ts:159` for force and `:223` for skip).

## What the current build does
No counterpart exists. Suppression is one-way and self-contained: a well-formed `{seen: true}` record under the plugin's settings namespace, or at least one non-cleared dispatcher mirror, holds the flow closed (`src/client/onboarding.ts`, `isOnboardingSuppressed`). The only ways the flow reappears are the deliberate rule that unreadable state shows the flow — a corrupt or unreadable suppression record must never hide the flow (module header, the unreadable-state paragraph at `src/client/onboarding.ts:36-42`) — or a seen write that never landed, which leaves the honest save-failed notice and re-shows on next launch (write hand-off at `src/client/onboarding.ts:421-434`; pane notice path `src/client/onboarding-pane.tsx:152-156`). There is no re-run/force intent, no external skip channel, and no second binding: the seen record is stored in the same `ctx.settingsScope` namespace that the roster watch and settings card use.

## The deviation
The reference gives developers a re-run affordance (clear flag + force event) and an externally driven skip/close channel; the build has neither. Re-entry happens only through failure directions (corrupt record, failed write) that exist for first-run-safety reasons, not as a controllable reset. This is a dev-wiring/testing-convenience gap, not a product-behavior gap — the flow's own states (beats, done, save-failed) are at parity.

## Verdict: ADAPT
Both reference affordances are developer conveniences riding the reference's dev-control surface, and the build's recorded position (ADR-0018 A5: one namespace, one channel — never a second binding; and the rule against adding extra integration points) argues against importing the external skip channel or adding a new force-onboarding event — that position is the same one DD-015 (the window-chrome sibling, plumbing OS intents to the shell) weighs one level up. The underlying need — re-triggering onboarding during development and testing — is already met in the way the build works: offline tests reset suppression by feeding documents/snapshots to the store, and a live-session reset can clear the `ONBOARDING_SETTINGS_KEY` record through the existing bound scope, re-showing the flow through the normal decision path. Adopt the capability in tests only; decline the reference's channel machinery. No authority conflict is created, so no human ruling is needed.

## Incorporation notes
- **Where it would live:** test-side only. Offline tests already drive suppression via the store's document/snapshot inputs; if live/E2E testing ever needs a reset, a helper that removes the onboarding record through the composition's existing `ctx.settingsScope` binding (`src/index.ts`) suffices. No new IPC, preload channel, dev-control route, or renderer event.
- **Constraints:** A5 no-second-store/no-second-binding (one namespace, one channel); the show-on-unreadable rule untouched; nothing added to the packaged surface; any helper is a testing artifact under the `.scratch/testing/` evidence layout, never shipped UI.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — test-side reset only; near-zero risk provided no runtime integration point is added (the risk lives entirely in the temptation to add one).
- **Key reference anchors:**
  - the reference tree's `source/electron-main/dev/dev-wiring.ts:90` — re-run intent (clear flag, emit force event)
  - the reference tree's `source/electron-main/dev/dev-controls-edge.ts:52` — externally issued skip POST
  - the reference tree's `source/electron-main/dev/dev-wiring.ts:63` — IPC twin of the skip intent
  - the reference tree's `source/electron-preload/preload.ts:159,223` — force/skip channel subscriptions
  - the reference tree's `source/electron-main/main-production-services.ts:850-851`; the reference tree's `frontend/src/production/ProductionRenderer.tsx:2772-2773` (DD numbers pending from the earlier survey — not re-verified here)

## Evidence
- Reference: the reference tree's `source/electron-main/dev/dev-wiring.ts` (lines 39, 63, 89-90 verified); the reference tree's `source/electron-main/dev/dev-controls-edge.ts:52` (verified); the reference tree's `source/electron-preload/preload.ts:159,223` (verified; note the earlier survey's bare `preload.ts` resolves under `electron-preload/`); the reference tree's `source/electron-main/main-production-services.ts:850-851`; the reference tree's `frontend/src/production/ProductionRenderer.tsx:2772-2773`
- Build: `src/client/onboarding.ts` (show-on-bad-read rule `:36-42`, suppression decision `isOnboardingSuppressed`, write hand-off `:421-434` — verified; no re-run/skip intent anywhere in the module); `src/client/onboarding-pane.tsx:152-156` (save-failed notice, cited from the earlier survey). Cross-reference sibling: `reference-deviations/DD-015-os-intent-seams.md`
