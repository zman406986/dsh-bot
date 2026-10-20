# DD-080 — Distinct notice card vs plain text lines
- **Area:** message cards (A10)
- **Type:** missing-feature (minor)
- **Date:** 2026-09-23

## What the reference does
The reference ships a dedicated transcript card for system-ish notices: a notice-card component in `the reference tree's frontend/src/recovered/features/conversation/cards/notice/view.tsx` (its comment records that the shipped notice transcript card is mounted at the existing notice union branch). It renders a transcript row (a reference-side transcript-row class plus an entry-id data attribute) whose content is a muted text block (a fixed utility class list) wrapped in a `role="note"` container, followed by the shared transcript-card timestamp component imported from the sibling timeline-event module. So a notice is a first-class transcript entry kind with its own accessibility role and row styling, distinct from an ordinary chat turn.

## What the current build does
The build has no transcript notice card. System-like lines surface in three text forms:
- Pane-level placeholders only: the `__notice` class in `src/client/conversation.tsx` (lines ~405–419) is used exclusively for the waiting / unavailable / empty transcript states — it never renders a per-notice transcript entry.
- Honest error/status copy as a bare styled span inside the composer area: `<span className={...__status}>{t(errorKey)}</span>` (conversation.tsx line ~226, error-colored CSS at line ~92). No `role="note"`, no row, no timestamp.
- Housekeeping notices (restart honesty, access denials, expired approvals) are injected as ordinary conversational text inside wake turns by `src/adapter/restart-notice.ts` — plain chat messages, structurally indistinguishable from agent text.

## The deviation
The reference distinguishes notices structurally (dedicated entry kind, `role="note"` semantics, muted styling, row timestamp); the build flattens every notice into plain text — a status span or a text line inside a turn. No `role="note"` affordance and no shared timestamp styling exist on any notice-like line. Functionally equivalent information, different presentation semantics.

## Verdict: DO-NOT-INCORPORATE
`docs/surfaces.md` §"No timeline cards" records this as a deliberate shipped pattern: housekeeping notices "ride inside wake turns as text," and the transcript node domain (`conversation.chat.node`) is a closed keyed domain — adding a new card node type is a recorded hard limit, so a distinct notice entry could only exist as a client-side reclassification of text, which the honesty rule (never invent structure from prose) rules out. The delta is pure presentation semantics (note role + timestamp styling vs inline text) with no behavioral gain, and contradicting a recorded design stance just for styling is not warranted. If the human ever wants notice styling, the one idea worth borrowing is `role="note"` for assistive tech — re-derived, not copied.

## Incorporation notes
- **Where it would live:** only if ever revisited: a presentation-only wrapper in `src/client/conversation.tsx` (alongside the existing `__notice`/`__status` CSS) driven by an explicit entry kind in `src/client/conversation-store.ts` — never by pattern-matching notice text.
- **Constraints:** `conversation.chat.node` is a closed keyed domain (no new node types — surfaces.md hard limit); ADR-0010-style honesty rules forbid inventing structure; any change would need a ticket + ruling since it reverses the recorded text-notice pattern.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — CSS + a wrapper span at most; risk is low technically but the main cost is overturning a documented design choice, which is a human call, not an implementation one.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/conversation/cards/notice/view.tsx` — the notice-card export; `role="note"` on the transcript row; the shared transcript-card timestamp import from the sibling timeline-event module; the shipped-notice-card comment (line 8); the muted notice-class utility list.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/notice/view.tsx` (read in full)
- Build: `src/client/conversation.tsx` (lines ~65, 92, 130, 226, 405–419), `src/client/conversation-store.ts` (no notice entry kind), `src/adapter/restart-notice.ts`, `docs/surfaces.md` §"No timeline cards" (lines 96–105)
