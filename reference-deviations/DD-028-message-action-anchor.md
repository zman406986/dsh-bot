# DD-028 — Per-message action anchor (hover toolbar + context menu) vs none
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature (ruled exception)
- **Date:** 2026-09-23

## What the reference does
Every ordinary transcript message is wrapped in a per-message action wrapper component. When the message is actionable (not read-only), the wrapper adds two affordances: (1) right-clicking the message opens an actions menu, except over links, images, form inputs, editable/textbox regions, attachment thumbnails, or when the user has an active text selection — those contexts keep native behavior; (2) a hover toolbar on the message hosts reaction actions, a reply button (direction-aware icon; its label names the message author, truncated to a bounded length), and an overflow trigger that opens a menu with reply, start-thread, and copy entries (copy hidden when no copy handler is provided). The menu carries toolbar/menu/menuitem aria semantics, closes on Escape with focus restored to the trigger, dismisses on outside pointer-down, and skips copy while a message is still streaming with no content; a message with no actions renders its children bare.

## What the current build does
Transcript items in the client pane are static, non-interactive divs: a role label, the message text (or an attachment-only marker), and status markers (interrupted, working). Tool entries render as `<details>` disclosure cards. There is no hover affordance, no context menu, and no per-message action of any kind.

## The deviation
The per-message action shell — hover toolbar, right-click context menu, overflow menu, Escape/outside-click/focus handling, per-message copy — is entirely absent. Note the reference wrapper's two richest action families, reactions and reply/thread, are exactly what ADR-0018 U-B excludes; the wrapper and its menus themselves, and copy, are not named anywhere on the exhaustive exception list, so under the main rule they fall back into imitation scope.

## Verdict: ADAPT
ADR-0018 (accepted, human-ruled main rule) imitates everything not on its exhaustive exception list; U-B names find-in-chat, threads/replies, reactions, per-agent drafts, rich attachment viewers, and URL cards — it does not name the action wrapper and its menus, nor per-message copy. The "ruled exception" classification therefore covers the excluded action families, not the whole feature: build the wrapper affordance stripped to non-excluded actions (per-message copy, shown directly as a hover/context action rather than a one-item overflow menu), omitting reactions and reply/thread entries entirely. If the human prefers to treat the entire per-message action apparatus as rich chat ergonomics, that reversal is theirs to record against U-B.

## Incorporation notes
- **Where it would live:** the ordinary-message branch of the transcript `Item` component in `src/client/conversation.tsx` (wrap the plain message div), plus client-pane styles and a clipboard helper on the client surface; any mount must respect the ADR-0021 UI shape rule (stock dsh stays primary; addon/floating-window surface).
- **Constraints:** U-B — no reactions, no reply/thread actions, no per-agent drafts inside the wrapper. B9 — re-derive labels, class names, exclusion selectors, and menu styling independently; do not transplant the reference's aria-label wording or its exclusion selector list. Re-derive the read-only/no-handler degradation and selection-aware right-click suppression in own terms.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — hover/context-menu UI with focus management and exclusion logic is fiddly client work, but it touches no core-loop or dispatcher state, so functional risk is low.
- **Key reference anchors:** `transcript.tsx:96-109` (label helpers), `:145-150` (right-click exclusion check), `:152-224` (wrapper component); ADR-0018 exception items U-B and B9.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 96-109, 145-224)
- Build: `src/client/conversation.tsx` (lines 298-374)
- Ruling: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (U-B, B9); `docs/adr/README.md`
