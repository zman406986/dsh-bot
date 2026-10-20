# DD-101 — Update settings group vs none
- **Area:** settings (A12)
- **Type:** missing-feature (updater is host-app scope)
- **Date:** 2026-09-23

## What the reference does
The reference settings overlay has a dedicated Updates panel. It exposes a release-track selector (stable and others) that greys out entirely when updates are managed by policy rather than by the user, an auto-update-while-idle toggle that only appears when a feature flag permits it, and two explicit actions — check for updates now, and restart to apply a downloaded update — each with its own in-progress indicator so the user can tell which operation is running. A status line marked as a live region (announced by screen readers when it changes) reports progress and results for assistive technology. Underneath, two stored keys back the panel in the settings store: a track override (with coercion to the currently enabled track set applied whenever the value is read, so a stale or retired track silently falls back to a valid one) and an idle-auto-update opt-in boolean (`the reference tree's source/shared/node/settings/sand-settings-store.ts:25,63,111-112,125-126`). Panel behavior lives in `the reference tree's frontend/src/recovered/features/settings/overlay/updates.ts` + `updates-controller.ts`, mounted from `panels.tsx`.

## What the current build does
The build has no update settings of any kind. There is no track selector, no idle-auto-update opt-in, no check-for-updates or restart-to-update action, and no updates controller. A search across the plugin source and web client surfaces (`src/`, `client/`) for the reference key names turns up nothing; the only "update" hits are unrelated (roster snapshots, markers, multitask state). The build's settings surface (`src/adapter/settings-section.ts` and the client shell) covers dispatcher concerns only.

## The deviation
The entire update-settings group — track select, idle opt-in, both actions, pending states, live status line, and their two stored keys — is present in the reference and completely absent from the build. It is a missing feature, but a deliberately out-of-scope one: the updater it configures does not exist in this plugin (filed separately as DD-221, and itself part of the host app's scope).

## Verdict: DO-NOT-INCORPORATE
The PRD scopes this project as a Cordis dispatcher plugin, and a plugin has no self-update channel — installing, updating, and restarting the host application is the host app's job, so every control in this group would be dead UI. The reference's own architecture agrees with that split: the keys live in the host's settings store, not in any per-feature surface. The updater mechanism and its settings group are one unit of scope; since DD-221 already carries the updater question at host-app level, this settings UI stays with it and should not be rebuilt here. If the human later rules that the host app (or DD-221) needs a settings surface, this panel is the reference shape to adapt — coercing the track on read and per-action pending state are the two details worth remembering.

## Incorporation notes
- **Where it would live:** nowhere in the plugin today; if a host-app updater lands (DD-221), the natural surface would be the host's settings UI, with the plugin's own settings section (`src/adapter/settings-section.ts`) at most surfacing a read-only pointer.
- **Constraints:** a Cordis plugin cannot restart or update its host; policy-managed track locking and the feature-flag gate both require a host-side policy/flag source the plugin does not have; track-override persistence belongs in the host settings store, not plugin config.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S to stub a settings group, but it would be non-functional UI; the real cost is DD-221 (L, host-app scope). Risk of incorporating now: orphaned settings that mislead users into thinking the plugin self-updates.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/settings/overlay/updates.ts`; `the reference tree's frontend/src/recovered/features/settings/overlay/updates-controller.ts`; the Updates panel in `the reference tree's frontend/src/recovered/features/settings/overlay/panels.tsx`; stored keys and the read-time track coercion at `the reference tree's source/shared/node/settings/sand-settings-store.ts:25,63,111-112,125-126`.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/settings/overlay/updates.ts`, `.../overlay/updates-controller.ts`, `.../overlay/panels.tsx`, `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/shared/node/settings/sand-settings-store.ts` (lines 25, 63, 111-112, 125-126)
- Build: `C:\Users\TZhen\Desktop\dsh-bot\src\adapter\settings-section.ts` (settings surface, no update section); grep for the three reference storage-key names (update-track, auto-update, check-for-updates) across `src/` and `client/` returns no matches
