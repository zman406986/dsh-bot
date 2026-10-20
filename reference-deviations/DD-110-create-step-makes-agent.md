# DD-110 — Onboarding create step that spawns an agent vs instructional copy
- **Area:** onboarding (A13)
- **Type:** behavior-delta (rooted in the no-agent-create ruling)
- **Date:** 2026-09-23

## What the reference does

The reference onboarding's final beat is a working creation form, not prose. The create step (signed-in flow) collects an agent draft: a name field, a color and a shape picked from character swatch groups, and a template picked from a suggestion rail (name/description/color/shape prefill on pick). Submission is gated in `model.ts` (a submit-guard predicate rejects a blank trimmed name; a create-request builder assembles the request, folding the selected tools into the agent description). On submit (`view.tsx`), the flow moves to a hand-off screen and performs a real coordinator call: an agent-creation call is invoked with the draft plus avatar fields. That call waits for the computer to be ready, short-circuits when the account is already onboarded, checks that the account slot is still current, keeps a reference that prevents creating the agent twice, and waits a fixed delay before completing. The hand-off screen shows live setup status, maps transport failure to an error message with a retry button, and only then hands the created agent id to the rest of the app.

## What the current build does

The build's corresponding onboarding beat ("first", `overlay.ts` locale strings) is instructional copy only: it tells the user that a dispatcher starts as an ordinary chat, and to create a new chat and ask it to start dispatching, after which the session appears in the sidebar with its own worker status. There is no creation call, no draft state, and no error/retry surface for creation — the beat's only write in the whole flow is the seen flag (`onboarding.ts` `writeOnboardingSeenRecord`, which sets `{ seen: true }` through the settings scope and hands `onFailed` to the honest save-failed notice). Activation of an actual dispatcher is left to the user through the normal chat path (`/dispatcher-start` in a dsh session), not to the overlay.

## The deviation

The reference makes its create step *do* the thing it describes — the onboarding itself spawns the first agent and owns the failure/retry UX for that spawn. The build deliberately splits these concerns: the overlay only explains, and the agent comes into existence through the user's own chat action. So the delta is not cosmetic (missing form fields) but architectural — who is authorized to bring a dispatcher into existence and when.

## Verdict: DO-NOT-INCORPORATE

A creation step in the overlay would put agent creation in an agent/client surface at runtime, directly against ADR-0018 rule U-G (no runtime agent management: agents never create, clone, or kickstart dispatchers, and there are no agent-create tools or profiles). It would also contradict the build's own driving model — the user activates an existing dsh session as dispatcher via `/dispatcher-start`, so the overlay's instructional copy is the correct and intended shape. At most, copy polish (clarity of the activate-a-chat instruction) is in scope; the spawn mechanism is not.

## Incorporation notes
- **Where it would live:** nowhere — the spawn path stays out of the overlay; any tweak would be limited to the `shell.onboard.first.*` copy in `src/client/overlay.ts`.
- **Constraints:** ADR-0018 U-G (human-ruled); the dispatcher lifecycle begins with the user's `/dispatcher-start` in a real session, never with an onboarding-side create call. Do not add draft state, agent-creation calls, or creation retry surfaces to the overlay.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** N/A (declined); incorporating it would take medium effort and would violate a ruling.
- **Key reference anchors:** reference onboarding signed-in view — create step render with draft swatches/name/suggestion rail and gated submit; the create coroutine with readiness wait, already-onboarded short-circuit, idempotence ref, dwell, and completion hand-off; hand-off screen with live status and retry button; `model.ts` (the submit-guard predicate and the create-request builder).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/onboarding/signed-in/view.tsx` (create step render ~174–179; the create coroutine 202–219; hand-off screen 180); `...\onboarding\signed-in\model.ts` (the submit-guard predicate and the create-request builder)
- Build: `src/client/overlay.ts` (shell.onboard.first beat, ~290–292); `src/client/onboarding.ts` (`writeOnboardingSeenRecord`, ~421–434 — the flow's only write); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (U-G, line 40)
- Cross-refs: DD-083, DD-092 (identity surfaces)
