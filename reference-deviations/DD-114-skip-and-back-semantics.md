# DD-114 — Skip-forward vs Back-navigation onboarding footer (inverted delta)
- **Area:** onboarding (A13)
- **Type:** behavior-delta (inverted: build adds Skip, lacks Back)
- **Date:** 2026-09-23

## What the reference does
The signed-in reference flow offers no user-facing Skip at all: its footer renders only a forward button (a next-step label) and an optional Back button, with skip reached solely through main/dev-driven paths. What it does have is Back navigation between steps, backed by a dedicated step-decrement action in the model, so a user who overshot a beat can return to it without restarting the flow. Each transition also emits per-transition step telemetry from the view layer via a step-report call in the model.

## What the current build does
The build's onboarding pane renders a Skip button alongside Next/Done on every beat. Skip is wired to the same completion path as Get-started: it completes the store flow and fires the seen-flag handler, so skipping and finishing are indistinguishable in persisted state. There is no Back control — once a beat is advanced it cannot be revisited. The module is deliberately telemetry-free by design comment, so no per-step transitions are reported anywhere.

## The deviation
The two footers are inverted on exactly the axis a user notices. The reference lets you go backward but never opt out; the build lets you opt out but never go backward. Secondary consequences: the build's Skip collapses "done reading" and "didn't want this" into one seen-flag write, while the reference's telemetry would have distinguished them — a distinction the build gave up on purpose (onboarding is telemetry-free), so the loss is accepted, not accidental.

## Verdict: ADAPT
Back is a small additive UX improvement and the progress dots already exist in the build, so adding a Back affordance alongside Next is cheap and purely additive. Skip is a build-only addition that serves the PRD's lightweight-onboarding goal and has no reference counterpart to copy, so it should be kept as-is. Under the repo's authority order (see the "Authority stack" note in `reference-deviations/README.md`), the reference is evidence, not a ruling (ADR-0018), and the build's telemetry-free onboarding comment is a deliberate local decision — so the right move is to keep Skip and optionally add Back, not to converge on either reference shape. Do not import the reference's per-transition step telemetry along with Back; that would violate the module's stated design constraint.

## Incorporation notes
- **Where it would live:** `src/client/onboarding-pane.tsx` actions row (Back button next to Skip/Next) plus a `back()`/retreat action on the onboarding store behind it (likely `src/client/onboarding.ts`).
- **Constraints:** Back must not resurrect beats after completion (seen flag stays authoritative); keep the module telemetry-free — no per-step reporting may accompany the new control; copy keys needed for a Back label in en+zh.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one store action, one button, two copy keys; risk limited to edge cases around first-beat Back (disable or hide) and post-completion state.
- **Key reference anchors:** footer shape and Back wiring (`view.tsx:64-66`, Back usage `view.tsx:220`), step telemetry calls (`view.tsx:195,200`), the step-decrement action and step report (`model.ts`).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/onboarding/signed-in/view.tsx` (Footer component lines 64-66; back usage ~220; telemetry ~195,200); `.../signed-in/model.ts` (the step-decrement action and the step report)
- Build: `src/client/onboarding-pane.tsx` (complete handler 94-97; Skip/Next actions 129-144); `src/client/onboarding.ts` (telemetry-free comment 127-128)
