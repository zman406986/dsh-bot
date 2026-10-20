# DD-054 — Mic/send glyph swap vs static text Send button
- **Area:** composer editor (A6)
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
The reference composer's trailing button group changes with draft state. With an empty draft (draft-empty = trimmed prompt plus zero attachments, the reference tree's `workspace/model.ts:43-45` via a draft-empty predicate) the group shows a single round mic icon button. Once the draft has content, an extra mic button appears next to a send button, and the send button's glyph pair toggles visibility classes: the mic glyph hides and the arrow-up glyph shows (the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:201-215`; glyph visibility classes and the glyph-rendering helper at :13-25). The whole thing lives inside a `<form>` whose submit handler is guarded by a send guard (payload present, not disabled, no voice activity), so the send button is `type="submit"` and the editor's Enter path routes through the same guard (`composer.tsx:155-158, 161`).

## What the current build does
The build's composer (`describeComposer`, `src/client/conversation.tsx:112-127`) exposes only a send-enabled flag and a label: a plain text button that reads "Send" when idle and switches to the sending label while a send is in flight (`src/client/conversation.tsx:228-235`). There are no icons, no mic affordance, and no empty-draft state change — the button is always present. There is no `<form>` element either: submission happens through the textarea's Enter handler and the button's click handler, both funneling into one `submit()` that re-checks `canSend` (`src/client/conversation.tsx:191-222`).

## The deviation
Two differences. (1) Button appearance: the reference expresses "empty vs has-content" by swapping which circular icon button occupies the send slot (mic when empty; arrow-up once there is something to send), while the build keeps one static text button whose only state change is disabled + label. (2) Structure: the reference blocks sending at a form-submit boundary shared by button and editor; the build blocks inside a shared `submit()` called from Enter and click, with no form element. The build's blocking rules are equivalent (send blocked when blank or in flight); the visible difference is icon-vs-text presentation and the empty-state mic.

## Verdict: ADAPT
Under ADR-0018 (U-B), voice dictation is excluded from this build, so the reference's mic part — both the empty-state mic button and the mic glyph hidden inside the send button — does not apply here (cross-ref "(DD number pending, voice)"); it should not be incorporated on its own. The arrow-up send button and the form-submit gating, however, are standalone UI choices that survive without voice: the gating rules already exist in the build's `canSend` check, so adaptation reduces to a cosmetic decision about whether the send control becomes an icon button that signals readiness by changing glyph, and whether submission is formalized into a form element. Given U-B's deliberately plain client, treat this as optional presentation polish rather than a behavior fix; ask the human only if reference visual parity becomes an explicit goal.

## Incorporation notes
- **Where it would live:** `src/client/conversation.tsx` — the `Composer` component and `describeComposer` (label/icon state would extend `ComposerView`); any form wrapper stays within the pane's composer block.
- **Constraints:** No voice session exists in this build (ADR-0018 excludes dictation), so the mic glyph and empty-state mic button have no counterpart to wire to; the send control can only swap between arrow-up and disabled states. Keep the single shared `submit()` guard (blank text or in-flight send blocks submission) whether or not a `<form>` element is introduced; preserve the Enter / Shift+Enter / IME rules already encoded in the textarea handler.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a button presentation swap (text → icon with a disabled/ready state) plus optionally wrapping the composer in a form; risk is low, but it weakens the U-B plain-client stance, so it should depend on an explicit decision to match the reference visually.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:13-25` (glyph visibility classes + the glyph-rendering helper), `:155-158, 161` (form submit guarded by a send guard), `:201-215` (trailing button group: mic when the draft is empty vs mic plus send when it has content, with the send button swapping between two glyphs); the same tree's `frontend/src/recovered/features/conversation/workspace/model.ts:43-45` (draft-empty rule).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (lines 13-25, 155-158, 161, 201-215), same tree `frontend/src/recovered/features/conversation/workspace/model.ts` (lines 43-45, cited from enumeration, not re-verified)
- Build: `src/client/conversation.tsx` (lines 107-127, 179-238; send button and label at 228-235)
