# DD-109 — Persona suggestion catalog vs no catalog
- **Area:** onboarding (A13)
- **Type:** missing-feature (content asset + selection mechanism)
- **Date:** 2026-09-23

## What the reference does

The reference tree's `frontend/src/recovered/features/onboarding/signed-in/suggestions.ts` ships a 32-entry catalog of first-task persona suggestions (10 "universal", 22 gated on the daily tools the user selected in the tools step, through per-entry arrays of conditions that decide whether each entry is recommended). Sample entry names span workplace personas — shift work, inbox triage, an executive-assistant role, negotiation, and invoice chasing. Three exports drive it:

- the suggestion selector (line 71) ranks entries by how well their recommendation conditions match the picked tools, substitutes the chosen tool into the description text, and caps output at 10.
- a description-flattening helper (line 92) renders the tool-substituted description.
- an identity-derivation helper (line 118) derives a deterministic color/shape visual identity per suggestion name, seeded via FNV-1a over the name.

Net effect: onboarding ends by handing the user up to 10 concrete starter tasks, personalized to the tools they said they use, each with a stable visual identity.

## What the current build does

ABSENT. A grep of `src/client` for any suggestion- or persona-catalog content returns zero matches — no catalog, no selector, no identity derivation exists anywhere in the client surface. The onboarding flow (`src/client/onboarding.ts`, flow documented at line 141: background-jobs → tools → first agent → hand-off) includes a "tools" beat that is static i18n prose only (`id: "tools"` with `titleKey`/`bodyKey`, lines 155–157): it tells the user about tools but offers no tool selection, so even if a selector existed there would be no input data for it.

## The deviation

The reference turns the tools beat into data — user tool picks drive a ranked, personalized suggestion hand-off — while the build's tools beat informs nothing downstream. Three things are missing: (a) the content asset (32 persona suggestion templates), (b) the selection mechanism (condition-based gating/ranking plus tool substitution into text), and (c) the deterministic per-name identity derivation feeding visuals. This is a missing feature plus a missing content asset, not a broken equivalent.

## Verdict: ADAPT

The mechanism side (tool-gated ranking, limit-10 selection, deterministic identities) is a pattern that is safe to re-implement independently and cheaply. The catalog text itself, however, is the reference's own copy: ADR-0018 (master, human-ruled; see `docs/adr/0018-imitate-reference-in-entirety-exception-list.md`, B9) forbids verbatim adoption, so any adopted catalog must be originally authored persona content grounded in dsh's own dispatcher/worker/approval tool surface — not the reference's daily-life persona set. That re-authoring is the bulk of the cost and changes the estimated effort substantially; the PRD's lightweight-onboarding intent (per the intent docs guiding this deviation series) also argues for a smaller original set rather than a 32-entry clone. The direction is already settled by the recorded rulings; the final size and scope of the authored catalog is worth a human glance at ticket time.

## Incorporation notes
- **Where it would live:** a new module beside `src/client/onboarding.ts` (e.g., `src/client/onboarding-suggestions.ts`) holding an original catalog + selector + identity derivation; the tools beat (`src/client/onboarding.ts:155`) would need a real multi-select tool interaction to feed the selector, and the identities would surface in the first-agent/hand-off beat.
- **Constraints:** onboarding stays lightweight per PRD intent — an original catalog smaller than 32 is acceptable; entries must reference dsh's actual tool surface (dispatcher, workers, approvals), not the reference's personas; identity derivation may reuse the idea of name-seeded deterministic color/shape but must be independently implemented; no reference description text may be echoed even paraphrase-close.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree (persona catalog text especially — any adopted catalog must be originally authored).
- **Effort/risk:** M — mechanism is small (selection + hashing-derived identities, roughly S on its own); authoring original persona content tied to dsh's tool domain is the real cost. Risk: scope creep against lightweight onboarding, and a tool-selection step may conflict with the current build's prose-only tools beat design.
- **Key reference anchors:** `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/onboarding/signed-in/suggestions.ts` — catalog at line 15, the selector at line 71, the description-flattening helper at line 92, the identity-derivation helper at line 118.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/onboarding/signed-in/suggestions.ts` (verified by structural grep: 32 entry objects; 22 entries with populated recommendation-condition arrays, 10 with no gating key = the universal set; selector signature takes a tools argument and a limit defaulting to 10).
- Build: `src/client/onboarding.ts` (tools beat as static i18n prose at lines 155–157; flow order comment at line 141); recursive grep of `src/client` for `suggest|persona` — zero matching files, confirming the catalog is absent.
