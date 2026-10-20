# DD-037 — Build-only "interrupted" marker (inverted deviation)
- **Area:** transcript delivery states (A4)
- **Type:** build-only-addition
- **Date:** 2026-09-23

## What the reference does

Nothing, at this surface. The reference tree's chat UI renders no interruption, stopped, or aborted indicator on any transcript row — assistant turns carry only their text. A tree-wide search of the reference frontend for "interrupted" returns exactly one hit, in the voice feature (`frontend/src/recovered/features/conversation/workspace/voice.tsx`), which is audio-capture code, not a transcript marker. The reference's host backend does track interrupted runs internally (run-lifecycle/run-scheduler code under `source/host/`), but that state never reaches a chat message in the reference tree.

## What the current build does

The wrapper's conversation store carries an interruption flag on assistant turns: when it processes the host's `assistant/message` events it sets `interrupted: data?.interrupted === true` (`src/client/conversation-store.ts:366-377`). The pane then renders a warn-tone "(interrupted)" marker under the assistant turn's text (`src/client/conversation.tsx:362-366`), with locale key `shell.conv.interrupted` (`:169`) and the warn-tone marker style (`:75`). Per the build's own records, the flag is not invented client-side: the dsh host's transcript event vocabulary itself carries `interrupted` on `assistant/message` (cited in ticket 80), and the copy review in ticket 33 recorded the wording with the framing "a transcript fact, never a claim about a worker's outcome".

## The deviation

Inverted: the build adds a visible transcript surface the reference lacks. An assistant turn that the host marks interrupted shows a warn-tone "(interrupted)" marker in the wrapper's conversation pane; in the reference tree the same turn would show only its text, with no interruption indication at all. Under ADR-0018 the rule is imitation in its entirety with an exhaustive exception list ("anything not on it is imitated"), so an added user-facing surface must be either on that list or not exist.

## Verdict: ASK-HUMAN

No recorded human approval or exception for this marker was found. Checked specifically: ADR-0018's exception list (items 1–20; the nearest entries — B8 steer-as-injection, D22 bounded liveness signal, U-B/U-C chat-ergonomics and timeline-card removals — cover different things), the core-loop deviation list and research notes (no entry for an interruption marker; only run-restart and steer mentions of interruption), and the build tickets. Tickets 80 and 33 record the marker's implementation, where its data comes from, and that its copy passed the no-verbatim-copy check — but neither records a ruling about matching the reference that permits adding a surface the reference lacks. ADR-0017 does not settle it either: it scopes rendering widgets out of the core-loop rule ("not the widget that renders it") while leaving open, in its open question 5, whether an addition the reference lacks counts as a deviation at all. With no recorded decision covering the deviation status, the authority stack says ask, never silently pick.

Recommendation to put to the human: **keep it, by adding it to ADR-0018's exception list.** Grounds: the flag is the dsh host's own transcript fact that the wrapper merely displays (not invented behavior); it is a marker that states the host's real state, explicitly framed as never a claim about a worker's outcome; it was already verified in ticket 33's copy review; and reverting it would hide real transcript state the host reports. But only the human can amend the exhaustive list, so the ruling is theirs, not this document's. If the human declines, revert is a one-marker deletion (`conversation.tsx:362-366`) plus the store field.

## Incorporation notes
- **Where it would live:** nowhere new — if kept, the code stays exactly where it is (`src/client/conversation-store.ts` flag passthrough; `src/client/conversation.tsx` render/key/CSS) and the decision is recorded as a new numbered item on ADR-0018's exception list (next free number) with a cross-reference from this file. If reverted: delete the render block and the store flag, keep the locale key only if another surface uses it.
- **Constraints:** the flag must remain the host transcript's own `interrupted` fact, never derived client-side from worker outcomes (ticket 33's framing); copy stays locale-keyed (`shell.conv.interrupted`); warn tone only; the marker must not imply a stop affordance — ticket 80 AC 3 keeps the composer send-only with the host's cancel verb deliberately unused.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — keeping costs zero code and one ADR line; the risk is not engineering but the process rule: a user-facing addition that no ruling records, under a rule with an exhaustive exception list.
- **Key reference anchors:** `frontend/src/recovered/features/conversation/workspace/voice.tsx` — the only "interrupted" occurrence in the reference frontend (voice feature, not a transcript marker), which shows the absence; host-side interruption logic exists at `source/host/extensions/transcript/run-lifecycle.ts` and `run-scheduler.ts` but produces no message-level marker in the reference chat tree.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/voice.tsx` (tree-wide grep 2026-09-23: only "interrupted" hit in the reference frontend; all other hits are `source/host/**` run-lifecycle code with no chat-message surface)
- Build: `src/client/conversation-store.ts:366-377` (flag), `src/client/conversation.tsx:169` (key), `:362-366` (render), `:75` (warn-tone marker CSS); `Issue-tracker/resolved/80-wrapper-conversation-surface-composer.md:54-57,69-79` (source of the field: host `assistant/message` carries `interrupted`; implementation record); `Issue-tracker/resolved/33-closeout-cleanroom-lqa-provenance-review-merge.md:355-357` (copy review pass; "transcript fact, never a claim about a worker's outcome"); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (exhaustive exception list — no entry for this marker); `docs/adr/0017-core-loop-follows-reference-deviations-need-human-approval-draft-nonhuman-approved.md` (scope ¶ and open question 5)
