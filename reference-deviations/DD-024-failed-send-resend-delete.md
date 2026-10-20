# DD-024 — Failed-send Resend/Delete actions vs keep-draft error line
- **Area:** transcript delivery states (A4)
- **Type:** deliberate-divergence (ruled + the rule against claiming anything not observed)
- **Date:** 2026-09-23

## What the reference does
When a sent message's delivery state is failed, the transcript renders a dedicated per-message action row (a failed-send actions component, mounted for that delivery state at `frontend/src/recovered/features/conversation/workspace/transcript.tsx:78-84`, mount `:790`): a status span announcing the message did not go through, a button to attempt the send again, and a button to remove the entry from the transcript. The row's callbacks arrive as transcript actions (delete-failed-send and resend-failed-send callbacks at `:44` and `:47`), wired through a client-side submission journal (`workspace/submission.ts`). The journal keeps pending records keyed by nonce with a phase machine (pending/queued/failed). Its discard entry (`:121-126`) removes a record only when its phase is failed, resolving it as cancelled. This whole apparatus presupposes that the client owns a send journal — records that survive past submit so they can later be retried or discarded.

## What the current build does
A failed send surfaces one plain status line under the composer and keeps the draft text in the textarea (`src/client/conversation.tsx`). The outcome mapper (`sendOutcomeCopyKey`, `:136-147`) returns silence for a resolved send (the durable turn arrives through the window; no optimistic echo, no success copy) and a plain failure/no-channel line otherwise. The composer's submit handler (`:191-200`) clears the text only when the outcome is sent; on failure the draft stays, and the status line carries the error tone token (`:92`). The module comment (`:24-28`) states this rule outright: no optimistic echo, no success copy, no retry model. There is no per-message failed marker in the transcript and no resend/delete affordance.

## The deviation
The reference treats a failed send as a persistent per-message transcript state with two actions (retry the send, remove the entry), backed by a client-side journal of send records. The build treats a failed send as a transient composer-side outcome: an error line that states what actually happened, plus the retained draft. Functionally, the reference's "retry" is already available in the build for free — the kept draft is the retry (the user re-presses send); what is absent is only the per-message marker and the discard verb, and both require a client-side send journal the build deliberately does not have.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 A4 rules out send-journal semantics built by us — no optimistic send, no offline queue, no flush-on-reconnect; sends are direct and the host owns the journal. The reference's failed-send action row is the visible part of exactly such a client-side journal (nonce-keyed records with a failed phase, a discard verb, a resend path), so adopting it would rebuild the ruled-out machinery, not just a button row. The build's error line that reports only the real outcome plus the kept draft is the recorded A4-conformant approach, and it already covers the resend use case implicitly (the draft is the retry). Any per-message failure marker would additionally duplicate delivery state client-side against A4's rule that the host owns the journal. Re-open only if the human rules otherwise.

## Incorporation notes
- **Where it would live:** n/a (not incorporated). If the human ever overrides A4, the natural place to put it would be a delivery-tone marker next to transcript items in `src/client/conversation.tsx` plus an outcome record in the host's send path — not a client journal.
- **Constraints:** ADR-0018 A4 (no client-side send-journal semantics); the pane only displays state (acts only through injected actions); the build must never show delivery state the window does not report; no client copy of journal/delivery state to discard or resend against.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** n/a (ruled out); were it ever overridden, M — the host-side send-outcome bookkeeping, not the buttons, is the work.
- **Key reference anchors:** `frontend/src/recovered/features/conversation/workspace/transcript.tsx:44,47,78-84` (action row + handlers), mount `:790`; `workspace/submission.ts:121-126` (failed-phase discard verb).
## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 44, 47, 78-84; mount at 790 per enumeration), `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/submission.ts:121-126`
- Build: `src/client/conversation.tsx:24-28` (module comment), `:92` (error-tone status), `:95-99,136-147` (outcome keys), `:191-200` (keep-draft submit); `docs/adr/0018` A4 line 24
