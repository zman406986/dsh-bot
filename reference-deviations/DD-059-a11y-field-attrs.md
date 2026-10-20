# DD-059 — Composer field a11y attributes vs mislabeled textarea
- **Area:** composer editor (A6)
- **Type:** behavior-delta (accessibility)
- **Date:** 2026-09-23

## What the reference does
The reference's rich-text editor attaches an explicit accessibility attribute set to its prompt field: the editor props carry a prompt-field class, `spellcheck="false"`, an aria-label naming the field as a prompt, `aria-multiline="true"`, and `role="textbox"` (the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:727-734`). Separately, the composer shell toggles an expansion-state data attribute on its payload as state grows (the reference tree's `composer.tsx:162`), so expansion state is machine-readable on the container.

## What the current build does
The build's composer is a plain `<textarea>` whose accessible name is the send button's locale key — `aria-label={t(CONVERSATION_KEYS.send)}` (`src/client/conversation.tsx:206`; the same key drives the send button's text at `:124-125`), so a screen reader announces the prompt input as "Send". No `spellcheck` attribute is set, so the browser default (spellchecking on) applies. The field is user-resizable (`resize:vertical`, `min-height:60px` — `src/client/conversation.tsx:88`) and carries no expansion-state attribute equivalent to the reference's expansion-state toggle.

## The deviation
Three deltas: (1) accessible-name mismatch — the reference labels the field as a prompt; the build reuses the send-button label, announcing the input as "Send"; (2) spellcheck behavior — reference explicitly disables it on a code/prompt field, build leaves the browser default on; (3) state attributes — reference exposes multiline/expansion semantics (`role="textbox"`, `aria-multiline`, an expansion-state data attribute), build relies on native textarea semantics alone (which do cover textbox/multiline, but with the wrong name) and has no expanded-state signal.

## Verdict: INCORPORATE
The mislabeled accessible name is a real accessibility bug — a prompt input announced as "Send" misleads assistive-tech users on the primary interaction surface — and the fix is a one-line aria-label change. It changes no behavior, and it is consistent with the PRD's client surface without touching dispatcher behavior (ruling source: the PRD as amended; ADR-0018 governs independent re-derivation). A proper `aria-label` (or visually-hidden label) with prompt wording should be added; `spellcheck="false"` is worth adopting alongside since the field primarily holds prompts/commands, but that half is a product preference and could be left on if the team values browser spellchecking for chat prose — flag if so. The reference's `role="textbox"`/`aria-multiline` are redundant on a native `<textarea>`, and the data-expanded toggle has no counterpart expansion behavior in the build's minimal composer, so neither needs porting beyond the label fix.

## Incorporation notes
- **Where it would live:** `src/client/conversation.tsx` — the `<textarea>` at :206 (aria-label; optionally `spellCheck={false}`), with any new copy key added to the composer's locale-key set near `CONVERSATION_KEYS` (:124-125 area); the resize/min-height CSS at :88 is unrelated and can stay.
- **Constraints:** label copy must come from the locale-key table, not a hard-coded string, matching the build's existing `t(...)` pattern; a `spellCheck` change alters typing UX for sighted users too, so it deserves an explicit callout; no dispatcher/worker surface is touched.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one attribute (plus optional spellcheck flag and a copy key); behavior-neutral except for the announced name and the spellcheck experience.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:727-734` (field attributes); the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:162` (the expansion-state data-attribute toggle).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (:727-734), `.../workspace/composer.tsx` (:162, not re-verified)
- Build: `src/client/conversation.tsx` (:88, :124-125, :206)
