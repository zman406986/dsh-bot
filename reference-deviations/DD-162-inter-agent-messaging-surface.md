# DD-162 — Inter-agent messaging surface: deliver/peer tools vs the reference's send surface
- **Area:** A19 tool surface
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
The reference's user-facing send tool is framed as the agent's only voice, and it carries a wide set of payload types: text, inline images with text, standalone file/media attachments by URL, widget-style cards, secret-request cards, and cloud-agent cards, plus a reply-to reference and channel addressing. Peer messaging is split out into a separate agent-to-agent tool that adds a priority marker and agent-group targeting, and it carries a safeguard against fan-out: an image sent to a group target is dropped with an explanatory note (group messages stay text-only) and a priority post to a group cannot interrupt members (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/agent-to-agent-messaging.ts:59`, `:79`, `:83`). The reference also clamps peer-bound text to a fixed ceiling (8,000 characters) before routing (`docs/research/reference-behavior-notes.md:156`), and it defines named communication kinds — an interim update and a final summary — as distinct message forms.

## What the current build does
The build splits the same territory across two plain-text tools, both of which name their own message kinds rather than reusing the reference's vocabulary (`src/core/policy/prompts.ts:13`).

- **deliver_result** — text plus optional local attachment path strings; the paths are passed to the delivery layer, not uploaded bytes (`src/core/tools.ts:548-620`, `attachment_paths` at `:567`).
- **send_peer** — text-only point-to-point send addressed by peer session id, with an optional priority flag that interrupts only the peer's background work, never a user-driven turn (`src/core/tools.ts:632-690`). One peer message is capped at `SEND_PEER_TEXT_MAX_CHARS = 8000` (`src/core/tools.ts:237-244`); text over the ceiling is **refused inline** with a message naming the limit and nothing is queued (`:671-678`). The sender's identity is the registered session, so a dispatcher cannot spoof a sibling; `messageId` is minted internally and the conversation slot is a fixed constant (`:680-690`, `:244`).
- **Peer inbox delivery** adds a dedupe index keyed on the envelope and a per-session cap on undelivered messages (`DEFAULT_PEER_INBOX_CAP = 64`) that the reference has no equivalent of (`src/core/peer-inbox.ts:19`, `:145-146`).
- **Worker result-visibility framing is inverted** relative to the reference: the worker contract tells the worker it has no way to message the user or other agents, that its only channel back is its final answer (plus the one sanctioned access ask), and that it keeps no todo ledger — the parent alone owns the user-facing surface (`src/worker/prompt.ts:58-69`, `:75-77`).

## The deviation
Both trees draw the same boundary — a user-facing delivery surface and a separate agent-to-agent surface — but they differ on payload richness and on over-limit behavior:

1. **Payload types.** The reference's send surface carries cards, images, URL attachments, reply-to, and channels; the build's delivery surface is text plus local attachment paths, and its peer surface is text only.
2. **Over-limit behavior.** For peer-bound text the reference clamps and sends; the build refuses inline and sends nothing (`src/core/tools.ts:671-678`). This is a genuine behavioral difference on a shared input class, not a cosmetic one.
3. **Delivery guarantees around the send.** The build adds a dedupe index and an inbox cap; the reference has no matching limit in the peer path.
4. **Communication kinds.** The reference ships named update and final-summary message forms; the build names its own kinds and folds the framing into tool descriptions and the worker contract.

## Verdict: ASK-HUMAN
The rich half of the reference's surface — cards, images, reply-to/replies, channel addressing, attachment viewers — is squarely the class ADR-0018 exception U-B excludes ("No rich chat ergonomics: no find-in-chat, threads/replies, reactions, per-agent drafts, rich attachment viewers, or URL cards", `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:35`), so no adoption is warranted for it. Named communication kinds only partly reach the build's deliver/result vocabulary and are not a fresh feature, and `src/core/policy/prompts.ts:13` already records the build's stance of naming its own kinds. The one item with no recorded ruling covering it is the over-limit behavior itself: the build's inline-refuse stance cites U-F in code (`src/core/tools.ts:232-236`), but no ADR in the authority stack was found that rules on clamp-versus-refuse for peer text, so the difference stays flagged here rather than settled.

## Incorporation notes
- **Where it would live:** no incorporation — this entry is a negative finding. The behavior that anchors it is already in place at `src/core/tools.ts` (deliver/peer tool defs), `src/core/peer-inbox.ts` (dedupe + cap), and `src/worker/prompt.ts` (worker framing).
- **Constraints:** if clamp-versus-refuse is ever revisited, it must go through the authority stack first — U-F is cited in code (`src/core/tools.ts:232-236`) but no ADR rules on the choice, so it is a human decision, not an agent one. Any rich-surface adoption would first require relaxing U-B, which the exception list currently forbids.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — negative finding; the only follow-up is a human ruling on the clamp/refuse question if anyone wants to change it.
- **Key reference anchors:** `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/agent-to-agent-messaging.ts:59,79,83` (peer clamp, group text-only safeguard, priority-to-group restriction); `docs/research/reference-behavior-notes.md:156` (8,000-character peer clamp and the send tool's payload list).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/agent-to-agent-messaging.ts` (lines 59, 79, 83); `docs/research/reference-behavior-notes.md` (line 156).
- Build: `src/core/tools.ts` (237-244, 548-620, 632-690); `src/core/policy/prompts.ts` (12-14); `src/core/peer-inbox.ts` (19, 145-146); `src/worker/prompt.ts` (58-69, 75-77); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (line 35).
