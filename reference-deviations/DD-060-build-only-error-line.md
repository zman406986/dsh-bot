# DD-060 — Build-only honest send-failure status line (inverted deviation)
- **Area:** composer editor (A6)
- **Type:** build-only-addition
- **Date:** 2026-09-23

## What the reference does

The reference conversation composer has no send-error copy of any kind. Its only
generic status slot is a notice prop (an optional string, the reference tree's
`frontend/src/recovered/features/conversation/workspace/composer.tsx:35`), rendered as a
single `aria-live="polite"` / `role="status"` paragraph with an
attachment-notice class (`composer.tsx:164`) — the class name and its call
sites mark it as attachment-stage business (staging/limit notices), not a send-outcome
channel. The only other error-ish line in the component is the voice-session error
line (`composer.tsx:217`), which covers dictation/transcription failures, not
message-send failures. What the reference
does after a send attempt fails is simply absent from the composer surface: there is no
`no-channel` distinction, no failed-send copy, and no recorded draft-restore behavior tied
to a send rejection. (Paraphrased; no text copied.)

## What the current build does

The build's conversation pane (`src/client/conversation.tsx`, ticket 80 / ADR-0020 slice 4)
adds an explicit send-outcome model and a matching status line:

- `ConversationSendOutcome` distinguishes `sent` / `no-channel` / `failed`
  (`src/client/conversation.tsx:95-99`).
- `sendOutcomeCopyKey` maps outcomes to honest copy keys: `sent` → `null` (silence — the
  transcript window is the confirmation; no optimistic echo, no success copy, A4 — the exception that builds no send journal, so the host
  owns the journal), `no-channel` → `shell.conv.no-channel`, `failed` →
  `shell.conv.send-failed` (`conversation.tsx:129-147`, keys at `:161-177`).
- The composer's `submit()` clears the text **only** on `outcome.kind === "sent"`
  (`conversation.tsx:191-200`); on rejection or a missing sink the draft is deliberately
  kept — the module comment calls this out as the same rule as the capsule's
  restore-on-failure (`conversation.tsx:24-28`, the deliberate "send outcomes are honest"
  rule).
- The failure line renders in the composer bar as
  `<span className="…__status">{t(errorKey)}</span>` (`conversation.tsx:224-227`), styled
  with the `state-error-primary` token (`conversation.tsx:92`, `:64` names the token's role
  as the "honest error line").

## The deviation

This is an **inverted** deviation: the build adds a behavior the reference lacks. The
reference composer surfaces attachment-stage notices (and voice errors) but is silent on
send failure; the build introduces a three-way send-outcome vocabulary, a state-error
status line for the two failure shapes (`no-channel`, `failed`), and the deliberate
keep-the-draft-on-failure rule. The build comment (`conversation.tsx:24-28`) records this
as a deliberate honesty rule, not drift. Note the build's status span is *not*
`aria-live`/`role="status"`, unlike the reference's notice and voice-error paragraphs — an
accessibility gap worth folding back in (see incorporation notes).

## Verdict: INCORPORATE

For an inverted deviation the question is "should the build keep this addition?" — yes.
Grounding:

- **Honesty rule.** ADR-0010 (draft, non-human-approved) establishes the
  fail-closed/pull-only honesty rules — every state renders its own true copy, never a
  fabricated one, and surfaces degrade to explicit unavailable copy rather than silence or
  a half-truth. A send that silently vanishes is exactly the half-truth the repo
  rejects; the ticket-79 fail-closed state discipline (waiting/unavailable/empty, each
  with its own copy, `conversation.tsx:29-31`) is the same honesty rule applied to the
  transcript. Keeping the draft on failure is honest too: the user's text is not
  pretending to have been delivered.
- **Recorded deliberation.** The rule is recorded in the module comment and on ticket 80
  (recorded ticket ruling, level 7 of the ruling order in `docs/agents-rulebook.md`). No **ADR** names this addition specifically —
  verified by grep over `docs/adr/`, the PRD, and the deviations register for
  send-failed / no-channel / error-line wording (no hits), and by reading ADR-0010 and the
  ADR index. Under ADR-0018's imitate-in-entirety master rule, a build-only addition is an
  exception and needs recording; keeping it is right, but it should be *named* in the deviations/
  exception register at the next human pass rather than living only in a code comment.
  Nothing here invents core state or fabricated UI, so it does not need escalating to the human.

## Incorporation notes

- **Where it would live:** already lives in the build — `src/client/conversation.tsx`
  (outcome type `:95-99`, copy mapping `:136-147`, composer state/submit `:186-200`,
  status span `:224-227`, CSS `:92`). Keep as-is; no relocation needed.
- **Constraints:** `sent` must stay silent (no success copy, no optimistic echo — A4, the
  exception under which the host owns the journal; the transcript window is the only confirmation). Failure shapes
  must keep the draft. Copy keys reuse the pane's locale table
  (`shell.conv.no-channel`, `shell.conv.send-failed`); color only via the
  `--dsw-alias-state-error-primary` token. Two cheap hardenings when next touched: give
  the status span `aria-live="polite"` + `role="status"` (matching the reference's own
  notice/voice-error pattern), and make sure the pending-DD row in the deviations register
  cites this file once numbered (cross-file DD number pending).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — behavior already shipped and offline-tested per the module header;
  residual risk is only the missing aria-live semantics and the exception entry that is
  not yet recorded in the deviations register.
- **Key reference anchors:** the absence itself —
  the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:35` (a notice prop,
  attachment-stage typing), `:164` (attachment notice paragraph, aria-live), `:217`
  (voice-session error line — nearest analog, but dictation-scoped, not send-scoped).

## Evidence

- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (`:35`, `:164`, `:217`).
- Build: `src/client/conversation.tsx` (`:24-28` deliberate honest-outcomes comment; `:64`, `:92` error token/status CSS; `:95-99` outcome union; `:129-147` `sendOutcomeCopyKey`; `:186-200` submit keeps draft unless sent; `:224-227` status line); `docs/adr/README.md` (ADR index — no entry naming this addition); `docs/adr/0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md` (grounding for the honesty rule).
