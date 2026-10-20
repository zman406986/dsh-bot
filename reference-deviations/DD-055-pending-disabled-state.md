# DD-055 — Composer freeze during send vs stay-editable editor
- **Area:** composer editor (A6)
- **Type:** behavior-delta (build-only restriction)
- **Date:** 2026-09-23

## What the reference does
The reference composer never locks its editor while a send is in flight. The only thing gated during flight is submission: a send guard is computed from three facts — the payload is present, the host has not disabled sending, and voice is not busy — and it feeds the submit gesture and the send button. The rich-text editor is created with an editability flag tied to a host-set disabled prop — nothing in the send path sets it, so during an in-flight send the user can keep typing, editing, and staging attachments. There is no in-flight button copy: the reference has no in-flight sending-label state to switch into.

## What the current build does
The build's conversation composer holds `sending` as local state set around the `onSend` promise, and the textarea itself carries `disabled={sending}` (`src/client/conversation.tsx:204-209`). While one send is in flight the user cannot type, edit, or move text; the freeze lifts only when the promise settles. The send button is separately gated by the view model (`disabled={!view.canSend}`, `src/client/conversation.tsx:231`) and its label switches to a sending locale key via `t(view.labelKey)` (`src/client/conversation.tsx:234`) — the label swap matches nothing in the reference.

## The deviation
A deviation in the opposite direction: the build is MORE restrictive than the reference. The reference treats in-flight sending as a submission-level gate only; the build promotes it to an editor-level lockout, removing a user capability the reference keeps. No build doc justifies it — the PRD, `docs/adr/`, and `docs/agents-rulebook.md` contain no composer disable/freeze/in-flight mention (grep, 2026-09-23), and ADR-0010's honesty rule covers how presence is shown, not whether input is locked. The freeze looks like an incidental simplification of the build's local-`useState` text model, not a recorded decision.

## Verdict: ADAPT
Restore the reference's stay-editable behavior — the freeze is undocumented, unnecessary for correctness (the `canSend` view-model gate already blocks double-submission), and more restrictive than the reference-imitation rule requires — but adapt the mechanism rather than copying it. The naive change has a real edge case the reference's draft store handles and the build's `setText("")` does not: keystrokes typed during flight would be wiped on success, since the build unconditionally clears the whole text field. So pair the unfreeze with a clear that removes only the text that was actually sent (or adopt a generation counter, like the reference's accepted-send generation counter). Not a silent INCORPORATE because the current freeze is visible shipped behavior; if the human prefers the simpler lockout, that is a one-line ruling — but it should be recorded, because ADR-0018's master rule defaults every reference behavior not on its exception list to the imitate-the-reference standard — so a build-only restriction like this freeze needs its own recorded justification, and today the ruling order (the repo's ordered list of ruling documents, defined in `docs/agents-rulebook.md`) supplies none.

## Incorporation notes
- **Where it would live:** `src/client/conversation.tsx` composer component — drop `disabled={sending}` from the textarea; keep `view.canSend` as the sole submission/button gate; adjust the post-success text clear; touch the composer locale keys only if the sending label is also brought in line with the reference (see the label-swap finding in this file).
- **Constraints:** double-submit stays impossible (`canSend` already excludes in-flight); Enter/IME gesture map (ticket 92) unaffected; the success-path clear must not destroy text typed mid-flight; any remaining deviation from reference stays logged here.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one component, but the clear-on-success interaction must be reasoned through and covered by an offline test; risk is data-loss if done naively.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:82` (the send guard gates submission only); the reference tree's `rich-text-editor.tsx:726` (an editability flag set by the host, not by the send path); no in-flight button copy anywhere in the reference composer.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (line 82), `.../rich-text-editor.tsx` (lines 726, 797-800 area)
- Build: `src/client/conversation.tsx` (lines 187-199 sending state, 208 textarea freeze, 231-234 button gate + label)
