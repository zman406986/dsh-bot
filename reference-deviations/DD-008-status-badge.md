# DD-008 — Transport status badge vs absent
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature (likely designed)
- **Date:** 2026-09-23

## What the reference does
The reference tree's `frontend/src/recovered/features/window-chrome/status-badge.tsx` defines the window status badge component: a small aria-labelled dot (`role="status"`, a status data attribute over a three-value status vocabulary — busy, informational, offline) rendered in the window chrome that reflects the client↔server transport state, showing one label per transport phase through a static transport-to-label map. It returns `null` when the window is fullscreen or the transport is in browser mode, so the dot only exists on the floating desktop window in native mode, never in fullscreen or browser mode.

## What the current build does
No transport indicator exists anywhere: grep for `status-badge` / `statusBadge` across `src/` and `client/` finds nothing, and neither the floating window frame nor the capsule chip carries a connection dot. The plugin's shell cannot observe transport state at all — per draft ADR-0020 (the wrapper-shell design), dsh keeps "store/transport/send-path"; the plugin projects only its own settings-mirror feed. Where a connection degrades *within the plugin's own observable state*, the build degrades honestly: a sidebar row with no live snapshot, a corrupt one, or one older than the stale window renders the muted `--chip--unavailable` "presence unavailable" chip (`src/client/shell.tsx:404-407`, rule in `src/client/shell-store.ts` `presenceAvailable` / `ROSTER_STALE_WINDOW_MS`), and the capsule's Unavailable state shows a red dot with the honest degraded copy and no affordance (docs/surfaces.md, capsule section).

## The deviation
The reference spends chrome space telling the user whether the *client transport* is up. The build has no equivalent, and its sidebar/capsule degrade states speak only to the dispatcher feed's health, not to the host client's connection. The absence is consistent with the recorded rule that the user pulls information rather than receiving pushes: docs/surfaces.md's governing rule is that "presence is a projection of existing core state, pulled from surfaces that exist," and "a surface that would need new core state, a new host seam, or a second source of truth is out — no matter how closely it would imitate the reference's feel." A transport dot would need exactly that: a host extension point exposing dsh's connection state to the plugin.

## Verdict: DO-NOT-INCORPORATE
No recorded ruling covers a transport indicator specifically — surfaces.md's rule and the capsule/table sections rule on *presence* surfaces, not connection chrome — so this lands by generalization rather than by named decision. The generalization is strong: draft ADR-0020 assigns transport to dsh, surfaces.md forbids surfaces requiring a new host extension point or second source of truth, and the user need the dot serves (know when the feed is silently down) is already covered honestly by the `presence unavailable` chip and the capsule's Unavailable state. Connection-state display is also the host client's own concern; a plugin dot would duplicate or second-guess it. If a host transport-state extension point ever ships, that would be a new decision — ask the human then.

## Incorporation notes
- **Where it would live:** (if ever revisited) the floating window's titlebar chrome in `src/client/shell.tsx`, or the capsule chip's dot states — nowhere else.
- **Constraints:** requires a host extension point exposing client transport state, which does not exist in dsh 0.1.5-rc.1; surfaces.md's rule against new extension points and ADR-0020's transport ownership both exclude inventing one; any degrade copy must stay honest (no simulated "connected" from feed liveness).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — not a styling job: it needs a new host extension point plus a ruling overriding surfaces.md; the risk is faking connectivity from dispatcher-feed health.
- **Key reference anchors:** the window status badge component and its transport-to-label map (`status-badge.tsx:14-24`); the fullscreen/browser null guard (`status-badge.tsx:21`).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/status-badge.tsx`
- Build: `src/client/shell.tsx` (lines 117, 404-407 — `--chip--unavailable` chip); `src/client/shell-store.ts` (lines 23-45, 249-254, 269-270 — stale→unavailable rule); `src/client/overlay.ts:249` (`shell.row.presence-unavailable`); `client/index.js:127,965,1072` (built output); docs/surfaces.md (the pull-only rule, capsule Unavailable state)
