# DD-056 — Composer Escape contract (cancel voice / blur) vs unhandled
- **Area:** composer editor (A6)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The prompt editor defines an explicit, documented keyboard contract for Escape. The editor's keydown handler (verified at the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:735-741`) skips the key entirely while an IME composition is in progress; otherwise, on Escape it prevents the browser default, invokes the escape callback, and marks the event consumed. The composer supplies that callback (the reference tree's `workspace/composer.tsx:186-189`, with the contract recorded in a comment block at :27-30): if a voice session is busy, Escape cancels the voice session and refocuses the prompt; if no voice session is active, Escape blurs the editor so the keystroke leaves the input. Suggestion listboxes in the reference likewise consume Escape to dismiss themselves.

## What the current build does
The build's composer is a plain `<textarea>` whose `onKeyDown` (`src/client/conversation.tsx:210-222`) handles only Enter-family gestures (plain Enter submits, Shift+Enter and IME-composition Enter fall through). There is no Escape branch: pressing Escape in the composer hits the browser default, which for a textarea is nothing observable. Verified — no other Escape handler exists at this node.

## The deviation
The reference treats Escape as a first-class composer gesture with two branches (cancel voice, otherwise blur); the build leaves it unhandled. The voice-cancel branch has no counterpart to port — the build excludes voice per ADR-0018 (see DD-065, the record of the missing dictation feature) — so only the no-voice branch (blur the prompt) is meaningfully missing. The reference's IME-composition guard is a detail worth carrying over if Escape ever gains a handler here.

## Verdict: ADAPT
The voice half of the contract is moot in this build because voice is explicitly out of scope under ADR-0018 (cross-ref DD-065, the record of the missing dictation feature), so importing the reference behavior wholesale is impossible and unnecessary. The surviving half — Escape blurs the composer when nothing is active — is a small, standalone, low-risk interaction improvement that fits the PRD's composer surface (A6) without new architecture. Incorporate it as a stripped, independently derived handler that skips IME composition, mirroring the build's existing Enter guard rather than the reference's code (cross-ref DD-017 for the shell-level Escape controller, which must stay consistent with any composer-level behavior). The IME guard is the one detail worth adapting along with it.

## Incorporation notes
- **Where it would live:** an added Escape branch in the existing `onKeyDown` of the composer textarea in `src/client/conversation.tsx` (blur the textarea ref), kept next to the Enter handling so the composer's key contract stays in one place; coordinate with the DD-017 shell Escape controller so the two never fight over the key.
- **Constraints:** no-op during IME composition (match the existing `isComposing` guard on Enter); must not swallow Escape if a shell-level handler (DD-017) owns it; no voice branch — voice is excluded by ADR-0018.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a few lines plus a ref; risk is only interaction overlap with any shell-level Escape handling.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:735-741` — the editor keydown handler: IME guard, Escape → preventDefault + the escape callback, consumed.
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:186-189` — the escape-callback wiring: cancel voice and refocus when voice is busy, otherwise blur the editor.
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:27-30` — contract comment recording the Escape behavior and its evidence pointers.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (lines 735-741); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (lines 27-30, 186-189)
- Build: `src/client/conversation.tsx` (lines 210-222)
