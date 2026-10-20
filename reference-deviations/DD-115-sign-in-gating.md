# DD-115 — Whole-shell sign-in/access gate vs none
- **Area:** auth / account / secrets (A14)
- **Type:** deliberate-divergence (recorded)
- **Date:** 2026-09-23

## What the reference does
The reference shell is gated on account state before the workspace is reachable, in two layers:

1. **Sign-in layer.** A dedicated sign-in status component (the reference tree's `frontend/src/recovered/features/account/session/sign-in-status.tsx`) renders when the account is logged out or mid-login. It takes a bridge narrowed to the account surface and drives three actions through it — sign in, re-open the in-progress login, and cancel the login — surfacing errors inline. Login is an external browser/OS flow the component polls via the bridge's returned auth status.

2. **Access layer.** The reference tree's `frontend/src/recovered/features/access/cover/model.ts` models a five-valued access state (granted, unavailable, payment-required, unknown, and still-checking) with a block-reason enum covering team privacy mode, team setup required, team access withheld, feature not offered, free-trial available, and three paywall variants (individual, team member, team admin). Two helpers turn that into a full-screen cover: one computes whether the cover should show at all (a specific roster failure code, not yet past first reach, no restored roster, no rebuild lock), and one derives the cover copy (title/body/action) per reason, defaulting to a generic not-available-for-this-account message with a check-access action and an external onboarding URL. The net effect: an unauthenticated or unauthorized account sees a full-screen cover instead of the workspace.

## What the current build does
No gate exists. The plugin's onboarding is a lightweight first-run flow with no account check, and its beat table explicitly records the sign-in beat as a gap: `src/client/onboarding.ts:17` — Sign-in is a **U-A gap**, "no privacy/account gates (ADR-0018 exception 12); recorded, never invented". The build's header comment concedes the reference onboarding is account/product-bound while ours is not. There is no account bridge surface and no access-cover component anywhere in the client; any account/identity notion belongs to the dsh host, outside this plugin.

## The deviation
The reference refuses to show the workspace until the account both authenticates and holds entitlement (plan/access checks with per-reason cover copy). The build has neither layer: the shell is usable without any sign-in, and access control is deliberately out of scope. This is not an oversight — it is a recorded U-A gap under ADR-0018 exception 12, kept as a gap rather than papered over with a fake gate.

## Verdict: DO-NOT-INCORPORATE
The decision to have no gates is already ruled: ADR-0018 exception 12 (U-A — no privacy/account gates) is recorded in the build itself (`src/client/onboarding.ts:17`), and under the recorded authority order a ruling stands until a human reverses it. Identity and entitlement are host-owned — the dsh host owns any account, so an in-plugin gate would invent an account surface the architecture assigns elsewhere, violating the recorded boundary. Re-opening this requires an explicit human ruling that the plugin must gate on host-owned identity, not a port of the reference's own account flow.

## Incorporation notes
- **Where it would live:** Nowhere, as recorded — the durable home of this deviation is the gap record at `src/client/onboarding.ts:17`. If a human ever reverses exception 12, a gate would belong at shell boot in `src/client/` (ahead of workspace render), backed by a host-provided account surface, not a reference-style account bridge.
- **Constraints:** ADR-0018 exception 12 (U-A); identity is host-owned — never invent an account bridge of the reference's shape or an entitlement check inside the plugin; any change needs a dated human ruling per the recorded authority order. Copy, if ever needed, must be re-derived per B9.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S (if ever reversed) — a boolean gate ahead of shell render is small; the real cost is defining and wiring the host-owned account surface, which is a design decision, not a port.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/account/session/sign-in-status.tsx` — sign-in/reopen/cancel driven through a narrowed account bridge; inline error surfacing; logged-out vs logging-in render split.
  - the reference tree's `frontend/src/recovered/features/access/cover/model.ts` — access state + block-reason enum; the check that decides whether the cover shows; the per-reason full-screen cover copy helper; external onboarding URL constant.
  - Consumer that mounts the cover in the reference shell: not traced here (DD number pending).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/account/session/sign-in-status.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/access/cover/model.ts`
- Build: `src/client/onboarding.ts` (line 17 gap record; header honesty note ~line 9)
