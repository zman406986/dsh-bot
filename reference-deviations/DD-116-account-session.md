# DD-116 — Account session surface (menu/status/sign-out) vs none
- **Area:** auth / account / secrets (A14)
- **Type:** missing-feature (host-owned identity)
- **Date:** 2026-09-23

## What the reference does
The reference ships a complete account-session surface for the desktop client. A session folder under the account feature holds three components: an account menu that surfaces the signed-in display name together with usage/reset countdown and spend figures plus a logout entry; a sign-out flow that pops a confirmation dialog and then calls the bridge's account logout method; and a sign-in status view covering the logged-out and logging-in states, including error handling for a failed sign-in. All of this is typed against an auth-status contract declared in the desktop-bridge contracts file (the status type appears throughout that contract file).

## What the current build does
Nothing. There is no account status enum, no account menu, and no sign-out or logout affordance anywhere under `src/` (a repo-wide search for sign-out/logout/account-menu/auth-status terms returns zero hits in the build tree). The plugin renders no account surface of any kind: identity lives in the host harness (dsh), which owns authentication and session state, so the dispatcher plugin never needs to present one.

## The deviation
This is a deliberate absence, not an oversight. The reference is a standalone desktop client that must manage its own account lifecycle (sign-in states, session menu, logout), so a full session surface is essential there. In the dsh plugin architecture, identity and credentials are the host's job; duplicating a menu/status/sign-out UI inside the plugin would create a second, competing source of truth for account state. ADR-0018's exception list already rules this territory out: U-A excludes privacy/account gates from imitation, in the same family as the connection-lifecycle and identity-roster absences (C13, D22).

## Verdict: DO-NOT-INCORPORATE
ADR-0018 (the human-ruled master, rank 2 in the recorded authority order) explicitly lists account gates as out of scope via U-A, and the identity-roster exclusion C13 shows the same pattern: identity surfaces are not imitated. The PRD scopes the plugin as a dispatcher riding on the host, which owns identity, so the reference's session surface has no plugin-side counterpart to build. The deviation is architectural, not a gap; it is recorded here so the absence is documented rather than silently discovered. Only a dated human override could reopen this.

## Incorporation notes
- **Where it would live:** Nowhere, unless dsh the host ever exposes an account/session API the plugin is asked to surface — in that hypothetical it would be a client-side view under `client/`, fed by a host bridge, not by plugin-managed credentials.
- **Constraints:** Never store, read, or display account credentials or tokens in the plugin; identity state must remain single-sourced in the host. No usage/spend or reset-countdown figures should be rendered plugin-side (adjacent to U-H's no-usage-accounting ruling).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — no work to do; risk is only that a future contributor "helpfully" adds an account affordance, so this record exists to point at.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/account/session/menu.tsx` — account menu (display name, usage/reset countdown, spend, logout entry)
  - the reference tree's `frontend/src/recovered/features/account/session/sign-out.tsx` — confirm dialog calling the bridge's account logout method
  - the reference tree's `frontend/src/recovered/features/account/session/sign-in-status.tsx` — logged-out / logging-in states with error handling
  - the reference tree's `frontend/src/recovered/contracts/desktop-bridge.ts` — the auth-status contract backing the above

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/account/session/{menu.tsx, sign-out.tsx, sign-in-status.tsx}`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/contracts/desktop-bridge.ts` (the auth-status type, 7 occurrences)
- Build: `src/` — zero matches for sign-out/logout/account-menu/auth-status identifiers (grep over all files)
- Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` — U-A (no privacy/account gates), C13 (no identity roster)
