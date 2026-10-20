# DD-111 — Character/scene customization vs text-and-dots pane
- **Area:** onboarding (A13)
- **Type:** deliberate-divergence (recorded CSS rule)
- **Date:** 2026-09-23

## What the reference does
The reference's signed-in onboarding is built around a personalized character. The reference tree's `frontend/src/recovered/features/onboarding/signed-in/model.ts` exports a character color palette (10 entries, verified at `:92`) and a character shape vocabulary (exactly 8 named shapes, spanning organic blobs and geometric solids — verified at `:104`), and normalizes user drafts against them (`:186-187`), so the create step offers radiogroup pickers for the character's color and shape. The staged scene lives in the reference tree's `frontend/src/recovered/features/onboarding/signed-in/scene.ts`: spring-generated CSS easings (two spring helpers, `:41-58`), a character-transition table (`:55`), per-beat character placement with bob entries (amplitude/period/delay fields, `:31`), and an avatar fly-and-land handoff into the create slot via a rect-to-target helper (`:93`). The header records that the character's visual mark accepts the full shipped state catalog (`:5`); the earlier survey puts that catalog at roughly 38 character states (the per-step state tables at `:64-88` show states spanning idle, listening, thinking, working, and celebratory or resting poses). `character.tsx` renders it.

## What the current build does
The build's onboarding pane (`src/client/onboarding-pane.tsx`) has no character, avatar, or scene layer at all — the pane surface is text, dot indicators, and buttons styled with `--dsw-alias-*` tokens (`:67-69` show the button rules; a token-only grep for avatar/character/color/shape finds only those CSS declarations). The disposition is recorded in the build's beat table: `src/client/onboarding.ts:18` lists the reference's animated "meet your agents" intro as replaced by a **static intro beat**, explicitly because the shell's CSS rule is "no animation" (also noted in the onboarding.ts header comment at `:19`, the intent-doc anchor).

## The deviation
Everything that makes the reference onboarding feel alive — the pick-your-color/shape character, its ~38-state catalog, the spring transitions, bobbing, and the avatar fly-and-land into the create slot — is absent. The build delivers the same narrative beats as static text, dots, and buttons. This is not an oversight: the beat table in `src/client/onboarding.ts` records the animated intro as deliberately replaced by a static counterpart because of the shell CSS rule.

## Verdict: DO-NOT-INCORPORATE
The recorded shell CSS rule (no animation, styling only through `--dsw-alias-*` tokens — the same rule cited in the beat table disposition at `src/client/onboarding.ts:18`) makes the reference's animation-driven character system incompatible with the build's recorded constraints; an avatar renderer with spring easings and rect-measured fly-to-target choreography cannot exist under it. The character is also central to the reference's account-bound onboarding framing, which the build honestly narrowed to a lightweight first-run flow. Incorporating any part of it (palette picker, state catalog) would require rebuilding the animated scene layer that rule forbids, so the recorded static-counterpart disposition stands. No recorded ruling beyond the shell CSS rule and ADR-0018's copy terms (B9) covers character presence specifically. If a human ever wants character presence back, that is a decision to reverse the CSS rule, not an implementation detail.

## Incorporation notes
- **Where it would live:** nowhere under current rules; hypothetically a character layer beside `src/client/onboarding-pane.tsx` with palette/shape constants in `src/client/onboarding.ts` data module.
- **Constraints:** no animation and styling only through host tokens (the shell CSS rule, cited in the beat table); copy must be re-derived per ADR-0018 B9; the reference's radiogroup pattern for color/shape pickers is generic and would be the only transplantable fragment, but it has no character to attach to.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — a sprite/state renderer plus scene choreography, and it would violate a recorded rule, so the risk is governance, not just size.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/onboarding/signed-in/model.ts:92` (palette), `:104` (shapes), `:186-187` (draft normalization); `scene.ts:5` (state-catalog note), `:31` (bob), `:55-58` (spring transitions), `:64-88` (per-beat character states), `:93` (the rect-to-target avatar helper); `character.tsx` (renderer).

## Evidence
- Reference: the reference tree's `frontend/src/recovered/features/onboarding/signed-in/model.ts`; the same folder's `scene.ts` and `character.tsx`
- Build: `src/client/onboarding-pane.tsx` (text/dots/buttons only, alias-token CSS); `src/client/onboarding.ts:18-19` (beat table: animated intro → static counterpart, no animation per the shell CSS rule)
