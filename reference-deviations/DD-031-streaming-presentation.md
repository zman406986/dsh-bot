# DD-031 — Streaming presentation: animated dots vs text busy marker
- **Area:** transcript delivery states (A4)
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does

While an assistant message is streaming and its text content is still empty, the
reference renders a dedicated streaming placeholder: a paragraph carrying the
message-content and message-typing classes, filled with three empty dot spans
(`transcript.tsx:226-232`, selected for rendering at `:785`). Independently of
any single message, the workspace also shows a page-level three-dot typing
indicator whenever the agent is running (`:796`, shown only while the agent-running
flag is set), so the user always sees global activity even when no row content has
landed yet. Rows additionally set `aria-busy` while in flight (`:761`), giving
assistive tech an in-progress signal per message.

## What the current build does

The build streams the accumulated text directly into the row as it arrives and
marks the in-flight state with a small text busy marker whose colour is the
`state-business-primary` token — the module comment names this token as "the
streaming busy marker, the status-dot role" (`src/client/conversation.tsx:64-65`).
There is no dots glyph of any kind: the pane's style rules explicitly
require no animation, alongside namespaced classes, alias-token colours, and
opacity-based hierarchy (`conversation.tsx:33-36`). There is also no global
bottom-of-pane indicator — not for lack of state: the store derives a
transcript-level `running` flag (an open `turn/start` or any live transient
row; interface at `src/client/conversation-store.ts:154-164`, derivation at
`:455-459`), but the pane never consumes it (`conversation.tsx:367-371`);
only the composer uses it, for its own busy indicator that shows only the real state.

## The deviation

Both surfaces signal "the assistant is producing output", but they diverge on
three axes. Glyph: animated three-dot placeholders (per-message and global)
versus a static text marker riding next to the accumulated text. Scope: the
reference signals activity at both row and page level, the build only at row
level, leaving the pane silent about global activity beyond what the composer
shows. Assistive signaling: the reference marks streaming rows `aria-busy`;
the build's in-flight cue is purely visual/textual. The gap is purely
presentational — the state the reference's global indicator needs
(`running`) already exists in the build's store, unused by the pane.

## Verdict: ADAPT

The build's no-animation rule is a recorded style rule (ticket 49
discipline per the module comment, `conversation.tsx:33-36`), so the
reference's animated dots must not be ported as-is — but animation is not the
substance of the pattern. A static, non-animated dots glyph (three fixed
circles, no keyframes) or the existing `state-business-primary` status-dot
rendered as fixed dots would keep the reference's recognizable streaming
affordance while obeying the CSS rules, and adding `aria-busy` to the
streaming row is a near-free accessibility gain consistent with the build's
rule of showing only observed states and never inventing them. A pane-level activity marker is worth
taking only if it reuses the already-derived `running` flag — zero store work;
if the human rules the no-animation constraint to exclude even static dots
imagery, fall back to the current text marker and take only `aria-busy`.

## Incorporation notes
- **Where it would live:** `src/client/conversation.tsx` — the streaming-row
  rendering plus `CONVERSATION_CSS` (static dots styles, `aria-busy`);
  optionally a pane-level marker consuming `ConversationTranscript.running`
  from `src/client/conversation-store.ts`.
- **Constraints:** no animation of any kind (`conversation.tsx:33-36`) — dots
  must be static glyphs, no keyframes; every colour via host `--dsw-alias-*`
  tokens, busy marker stays `state-business-primary` (`conversation.tsx:64-65`);
  never make up transcript content to fill the gap
  (`conversation.tsx:28-31`); changes to store or item-building logic (if `running`
  consumption moves) stay covered by the offline test suite.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — markup/CSS-only in one pane; static glyph and `aria-busy`
  carry no state risk, and reusing the existing `running` flag needs no store
  change.
- **Key reference anchors:** `transcript.tsx:226-232` (StreamingMessage
  three-dot placeholder), `:785` (placeholder selected during streaming),
  `:761` (`aria-busy` on in-flight rows), `:796` (page-level typing indicator
  shown only while the agent is running).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 226-232, 761, 785, 796)
- Build: `src/client/conversation.tsx` (lines 28-31, 33-36, 64-65, 367-371), `src/client/conversation-store.ts` (lines 154-164, 455-459)
