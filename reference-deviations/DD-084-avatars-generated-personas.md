# DD-084 — Agent avatars & generated persona marks vs presence dot
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference frontend gives every agent a visual identity. `agent-avatar.tsx` picks a rendering by kind — a user-uploaded photo (image data URL), a shared-room glyph, a group composite, or a generated identity mark — and the generated path derives color and shape deterministically from the agent id. Group composites lay up to four member marks into slots and show an overflow count when more than four members exist; the avatar component also takes per-mark activity-state props, so a member's mark can reflect live activity. Uploads are handled by a full editor (`avatar-editor/model.ts`): image decode and normalization, a clamped crop/zoom/pan model, and a fixed-size PNG export (the avatar output-size constant, 256px), with a fixed 11-entry color list and 8 named shapes to build identity marks from.

## What the current build does
Nothing of the sort exists. A search for avatar/persona code across `src/client/` returns no matches. Roster rows in `src/client/shell.tsx` (`ShellRow`) show an 8px presence dot colored by a design token — its role mapped through the `state-*` token family (`--dsw-alias-state-*` aliases: working / needs-you / finished) — plus a text preview line. No images, no per-agent marks, no editor. The dot design is deliberate: ticket 79 re-hosted presence semantics onto the sidebar as an aggregate per-session dot state (see the file's header comments).

## The deviation
The reference invests in per-agent visual identity (photos, generated marks, composites, animations) as the primary way to tell agents apart at a glance; the build instead disambiguates purely with text plus a shared, state-colored presence dot. Entire feature families are absent: photo upload/crop/export, deterministic identity marks, group composites with overflow badges, and the shared-room glyph. This is a real capability gap, but one of appearance and identity, not dispatcher behavior — no orchestration or presence logic depends on it.

## Verdict: ASK-HUMAN
Nothing in the ADR index or the current client design records a decision either way on agent avatars, and adding a photo pipeline plus editor is product-scope expansion beyond anything ruled — under the authority stack that is a stop-and-ask, not a silent pick. The lightweight half (deterministic color/shape marks derived from agent id, no uploads, no motion) could make roster entries easier to tell apart at a glance in the floating-window roster and would fit ADR-0021's surface, so it is worth a human ruling as a scoped option. Note the constraint: the build styles exclusively through the `--dsw-alias-*` / `state-*` token roles, with no private palette and no animation, so any avatar work must resolve its colors and shapes into tokens and must not import the reference's animation-driven states wholesale.

## Incorporation notes
- **Where it would live:** a `src/client/` roster-visual module beside `shell.tsx` (e.g., a row-mark helper used by `ShellRow`), with any editor UI in its own card/pane consistent with `settings-card.tsx` patterns; identity marks must be derived build-side, re-derived, not ported.
- **Constraints:** colors/shapes must map to existing dsw token roles (no private palette); no animation states unless a rule adds them; group composites and shared-room glyphs only if the build's roster actually models those member structures; photo upload would need the editor's whole crop/export pipeline — the expensive part.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M for generated marks only (token-safe, deterministic); L if the photo pipeline + editor is included; risk is scope creep into a cosmetic subsystem the PRD does not demand.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx` — kind dispatch across the mark kinds (individual agent, group, shared room, uploaded photo), identity marks from agent id, 4-slot group composite with overflow count, per-mark activity-state props.
  - `the reference tree's frontend/src/recovered/features/agent-info/avatar-editor/model.ts` — decode/normalize, clamped crop-zoom-pan, the avatar output-size constant's 256px PNG export, 11 colors / 8 shapes.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/agent-info/avatar-editor/model.ts`
- Build: `src/client/shell.tsx` (ShellRow dot + preview; `state-*`/`--dsw-alias-*` token CSS); `src/client/` grep for avatar/persona: no matches
