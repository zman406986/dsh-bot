# DD-026 — Replies and reply-targeting pipeline vs none
- **Area:** transcript delivery states (A4) / composer (A9)
- **Type:** missing-feature (ruled exception)
- **Date:** 2026-09-23

## What the reference does

The reference wires an end-to-end reply pipeline across the transcript and the composer.

**Data model.** Transcript messages carry an optional reply-target id string pointing at another message's id (`workspace/model.ts:239`, relative to `frontend/src/recovered/features/conversation`), and outgoing submissions carry the same field so the link survives the send (`workspace/submission.ts:17`).

**Selection from a message action.** A hover action on a transcript card invokes the reply handler with the entry's id (`cards/transcript-card/message-actions.tsx:272`). The reply-thread controller's reply-selection method accepts the target only when the current scope has both an account slot and an agent id, resolves the target to a preview, and stores the resolution together with a snapshot of that scope (`workspace/reply-thread-controller.ts:127-133`). When the scope changes, its scope-setter re-clones the scope onto any live selection — a scope switch drops the reply selection so it cannot leak across agent contexts (same file, ~lines 108-115). Note this is a *reply* selection (a composer-side drafting affordance), distinct from the thread view machinery tracked separately in DD-027 (a separate deviation may be filed if that split moves).

**Composer surfaces it.** The workspace controller exposes the reply state as composer props (`workspace/conversation-workspace-controller.ts:159-165`). The composer renders a reply pill above the input identifying the target, with a cancel button that clears the selection (`workspace/composer.tsx:165`; pill + clear in `workspace/reply-preview.tsx:133-146`). The input's placeholder swaps to reply-specific strings while a reply is active (`composer.tsx:192`; strings in `reply-preview.tsx:78-91`).

**Send preparation.** On send, the submission builder writes the pending reply-target id into the outgoing submission and clears the reply target before dispatch (`conversation-workspace-controller.ts:186-191`). The fork path writes both the reply-target id and a fork flag set true, so a forked send keeps the linkage and is marked as a fork (`conversation-workspace-controller.ts:181-185`).

**Transcript rendering.** Every message that replies to something renders a referenced-message preview: a quoted excerpt truncated for display (long/short thresholds around 96/48 chars), relative-time formatting for the target, explicit handling when the target no longer resolves (missing state), and in-scope navigation that jumps to the quoted message when it exists in the current scope (`workspace/referenced-message-preview.tsx:10-90`; wired into the transcript rows at `workspace/transcript.tsx:732-736,776-784`).

## What the current build does

Nothing. There are zero `reply` identifiers anywhere under `src/client` (grep across `*.ts`/`*.tsx` returns no matches; the only `reply` hits in the repo are in `src/core/*` and are unrelated protocol text). The code that turns the host window into transcript items handles user turns solely from events whose source kind is `"user"`, keeping only a sequence number and text — no reply linkage field exists in the item model (`src/client/conversation-store.ts:356-365`). The composer is a bare textarea with constant placeholder behavior (`src/client/conversation.tsx:202-223`): no reply state, no pill, no placeholder variants. Messages render as plain text with no quoted preview, no jump-to-target, and no hover action menu.

## The deviation

The reference treats replying as a first-class pipeline that stays inside one agent scope: model field → hover-action selection → composer pill/placeholder → send preparation (including fork marking) → per-message quoted preview with navigation. The build has none of these stages; the concept of a reply target does not exist in its client data model, composer, or transcript rendering. This is one of the reference behaviors explicitly ruled out of scope as an intentional divergence under ADR-0018 exception U-B (the exclusion of rich chat features: find-in-chat, threads/replies, reactions, per-agent drafts, rich attachment viewers, and URL cards), so its absence is a recorded decision, not an oversight — but it is recorded here because it is a user-visible transcript/composer capability gap, and the ruling should be revisited only by the human.

## Verdict: ASK-HUMAN

ADR-0018 exception U-B rules this reference behavior out, and the repo's ruling order (`docs/agents-rulebook.md`) says accepted ADRs bind agent work — the build is compliant today and nothing may be silently re-incorporated against a recorded ruling. At the same time, this is a substantial interactive capability (quoting, jump-to-message, fork linkage) adjacent to in-scope areas A4/A9, so whether the exception should stand is a product call with real UX cost either way. Per the ruling order, only a human explicit override can reverse an accepted ADR, so the right move is to surface this deviation and ask, not to incorporate or adapt unilaterally. Do not begin implementation unless the human lifts or narrows U-B for this feature.

## Incorporation notes
- **Where it would live:** a reply-target id field on transcript items and outgoing submissions in `src/client/conversation-store.ts` (window reduction + dispatch path); reply selection state and placeholder/preview handling in the composer surface under `src/client` (the `conversation.tsx` textarea grows a stateful wrapper); quoted-preview rendering alongside the transcript item renderer.
- **Constraints:** If U-B is ever lifted: keep the selection scoped per agent (account slot + agent id) and drop it on scope change, exactly to prevent one agent's reply from leaking into another; write-and-clear on send so a retry cannot attach the target twice; missing-target previews must degrade to an explicit missing state, never a dead link; keep thread-view machinery out of scope (see DD-027; the related deviations are not yet numbered). Re-derive all copy and formatting independently per the license note.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — spans data model, composer state, and transcript rendering with several edge states (missing target, scope drop, fork marking); straightforward but broad.
- **Key reference anchors:** `frontend/src/recovered/features/conversation/workspace/model.ts:239`; `workspace/submission.ts:17`; `workspace/reply-thread-controller.ts:127-140`; `workspace/conversation-workspace-controller.ts:159-191`; `workspace/composer.tsx:165,192`; `workspace/reply-preview.tsx:78-91,133-146`; `workspace/referenced-message-preview.tsx:10-90`; `workspace/transcript.tsx:732-736,776-784`; `cards/transcript-card/message-actions.tsx:272` (all under the reference tree `frontend/src/recovered/features/conversation/` unless noted).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/{model.ts,submission.ts,reply-thread-controller.ts,conversation-workspace-controller.ts,composer.tsx,reply-preview.tsx,referenced-message-preview.tsx,transcript.tsx}` and `.../cards/transcript-card/message-actions.tsx`
- Build: `src/client/conversation-store.ts:356-365`, `src/client/conversation.tsx:202-223`; absence verified by grep for `reply` across `src/client` (zero matches)
