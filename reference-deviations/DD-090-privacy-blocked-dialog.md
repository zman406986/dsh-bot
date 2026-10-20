# DD-090 — Privacy-blocked roster dialog vs none
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature (host/account-dependent)
- **Date:** 2026-09-23

## What the reference does
When a roster operation fails because cloud agent storage is unavailable, the reference treats it as a distinct privacy-mode block: a failure classifier (the roster privacy-block check) matches errors carrying the storage-disabled code or the no-storage transport marker, and a match raises a modal alert dialog rather than a generic error. The dialog explains that the account's legacy privacy mode is incompatible with the product, reassures the user that data is still not used for training, and offers exactly two exits: sign out of the account, or open an external dashboard URL that deep-links straight to the privacy-settings page (opened through the desktop bridge's external-open feature). It is a full accessibility-grade modal — focus is trapped inside, Escape and outside-pointer dismissal are suppressed, focus is restored on close, and the external-settings action is the visually primary button.

## What the current build does
Absent. No dispatcher surface detects a privacy/storage-disabled account state and no equivalent dialog exists anywhere under `src/client/` or `src/adapter/`. The closest structural neighbor, `src/adapter/access-prompt.ts`, is the unrelated worker access-request prompt (ticket 13/23 relay presentation) — it surfaces pending permission asks, not account-level storage/privacy failures. The only "privacy" occurrence in the build's `src/` tree is a documentation comment in `src/client/onboarding.ts` recording that there are deliberately no privacy/account gates (ADR-0018 exception 12, "recorded, never invented"). A storage-disabled-style failure, if the dsh host ever produced one, would fall through whatever generic error rendering already exists (exact behavior DD number pending).

## The deviation
The reference couples roster availability to an account-level privacy-mode state and builds a dedicated blocking modal with sign-out and an external settings escape hatch. The build has no concept of account privacy mode at all — no detection, no dialog, no external-settings linkage — so there is no path that reproduces or replaces this UX.

## Verdict: DO-NOT-INCORPORATE
Privacy mode here is an account/product-level concept owned by the reference's hosted backend; the dsh host does not expose an equivalent check, and ADR-0018's U-A rule (no account gates) plus the build's own recorded "no privacy/account gates" exception mean inventing a storage-disabled classifier would create an account dependency the PRD does not have. The dialog's *presentation* qualities (trapped-focus modal, suppressed dismissal) are already covered generically by the modal/alert deviations and need no second instance. If the dsh host ever grows a storage-disabled failure mode, this should be re-raised as an ASK-HUMAN design question rather than silently modeled on the reference.

## Incorporation notes
- **Where it would live:** n/a for now; if ever needed, a classifier helper beside `src/client/roster-store.ts` (failure-shape matching) and presentation via the existing modal/alert surface in `src/client/` — never a new prompt pathway in `src/adapter/`.
- **Constraints:** any equivalent must not invent an account gate where the host exposes none (ADR-0018 U-A); external URL opening would have to go through a dsh-native feature, not a copied dashboard link; no verbatim label copy from the reference.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S if the host ever exposes the failure mode (one classifier + one modal); the risk is conceptual — adding it without a host-side concept would fabricate an account dependency.
- **Key reference anchors:** the roster privacy-block failure classifier (code/transport-kind match); the privacy-settings URL constant for the external deep link; sign-out action via the bridge's account logout; focus-trap + Escape/outside-dismiss suppression in the dialog effects.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/roster/privacy-blocked.tsx` (the privacy-block classifier, the external URL constant, modal lifecycle; sibling roster files `access-readiness.ts`, `status.tsx` consume roster failures)
- Build: `src/client/` (roster surface: `roster-store.ts`, `onboarding.ts` — ADR-0018 no-gates comment at line 17); `src/adapter/access-prompt.ts` (nearest prompt surface, unrelated access-request flow)
