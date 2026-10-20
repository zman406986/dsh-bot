# DD-029 — Message/code-block copy affordances vs none
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
Copying from the transcript requires the entry to pass a set of checks; it is not a free action. A helper (an ordinary-message-actionability predicate) lets the copy path proceed only when the entry has non-empty text, its delivery state is settled (not pending, queued, or failed), and — in read-only mode — a copy handler has been injected from outside. The action menu's Copy command checks one more case (an outgoing message still streaming with no content yet) before calling the injected handler, and the menu item itself is shown through that handler. Independently, every assistant code block renders its own small copy button that writes just that block to the clipboard and flips to a short-lived "copied" confirmation.

## What the current build does
The build's conversation surface has no clipboard interaction at all: a search over `src/client` finds clipboard code only in `src/client/shell.tsx`, which wires a copy function supplied by the host (with a best-effort `navigator.clipboard` fallback) used solely for copying session IDs in the session roster. There is no message-level copy command and no per-code-block copy button in `src/client/conversation.tsx` / `conversation-feed.ts` / `conversation-store.ts`. Plain text is still selectable, since transcript text renders in pre-wrap spans, so a user can copy content manually today.

## The deviation
Two reference affordances are absent from the build: the whole-message Copy action (shown only when the entry passes the checks below) and the per-code-block copy button. Those checks (non-empty text; settled delivery state; injected handler required in read-only; skip while streaming with empty content) are absent with them, though the checks only matter once an affordance exists.

## Verdict: ADAPT
ADR-0018's baseline is to imitate the reference in entirety, and B9 explicitly permits adapted copying of reference behavior provided it is re-derived independently rather than transcribed; U-B excludes rich chat ergonomics (find-in-chat, threads, reactions, rich viewers), and a plain copy affordance is not on that exclusion list, so the feature is in scope. Note the difference is modest: plain text selection already works in the build's pre-wrap spans, so what is missing is the affordance, the checks it runs before copying, and per-code-block copy — convenience, not content access. Adapt by building the affordance against the build's own clipboard function supplied by the host, not by porting reference code.

## Incorporation notes
- **Where it would live:** transcript message rendering in `src/client/conversation.tsx` (action menu / message footer), plus a small per-code-block button in the code-block renderer; clipboard writes go through the existing host-supplied function in `src/client/shell.tsx` (`copyToClipboard` prop with its `navigator.clipboard` fallback).
- **Constraints:** re-derive the checks that decide when copy is offered: non-empty text; no copy while delivery is pending/queued/failed; read-only mode requires an injected handler; skip the copy path for a message still streaming with empty content; per-code-block button shows a transient copied confirmation. Independent implementation — B9 forbids verbatim porting.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one check function plus two small UI affordances reusing the existing clipboard function; low risk, main care is not offering copy on unsettled deliveries.
- **Key reference anchors:** `transcript.tsx:63-67` (helper deciding when copy is allowed), `:188-194` (copy guard for streaming-empty), `:219` (Copy menu item via injected handler), `:437-451` (per-code-block copy button with copied feedback).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 63-67, 188-194, 219, 437-451)
- Build: `src/client/conversation.tsx`, `src/client/conversation-feed.ts`, `src/client/conversation-store.ts` (no clipboard/copy code — grep clean); `src/client/shell.tsx` (sole clipboard usage: session-ID copy function, `copyToClipboard`/`defaultCopyToClipboard`, `onCopyId`); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (B9, U-B)
