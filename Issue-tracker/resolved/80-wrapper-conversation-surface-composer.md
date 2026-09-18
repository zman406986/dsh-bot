# 80 — Wrapper conversation surface: text-only chat + composer (ADR-0020 slice 4)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 77 (skeleton — resolved), 78 staging mount (resolved)
**Related:** ADR-0020 (inventory rows: streaming, delivery, composer), `wrapper-vehicle-seams.md` Finding 2 (`ctx.conversation`), exceptions U-B/U-C/U-E/A4, 75 (session/event tool-call path)

## What to do

- [x] **Open verification first:** the conversation *history replay* face a custom surface reads
      to paint past turns (`dsh-client-ui-conversation` internals were not isolated in the
      vehicle pass — `wrapper-vehicle-seams.md` Finding 2 honest gap). Read-only pass on the
      installed host; record with file:line; no fantasy seams. — **VERIFIED (positive),
      2026-09-19:** see the dated comment below and `wrapper-vehicle-seams.md` Finding 7.
- [x] Text-only conversation view for the selected dispatcher session: user + assistant turns,
      streaming-in-place assistant text, tool activity as collapsible per-tool rows (re-host
      ticket 24's toolview content). U-B excludes rich ergonomics; U-C excludes timeline cards;
      U-E keeps delivery text-only. — DONE offline (reduction + pane; see dated comment).
- [x] Composer: sends through the host sink (`ctx.conversation.send` — direct sends, no send
      journal, A4); steer is the same composer (no special steer UI); no stop affordance
      anywhere (area 7 conformity). — DONE (send-only composer over the verified sink; see
      dated comment).
- [x] Worker results render as ordinary assistant messages (delivery = the dispatcher speaking).
      — DONE: no special path exists; the reduction renders this session's `assistant/message`
      events as ordinary turns (the core's delivery obligation puts worker results there).

## Constraints

- Offline: view models, turn-model reduction from session/event-shaped payloads, composer
  disable/enable states. Live streaming behavior waits for the live lane.

## Comments

### 2026-09-19 — agent (Phase 1: seam verification — POSITIVE)

The history-replay seam EXISTS as an outward face; Finding 2's honest gap is closed.
Decisive citations (installed 0.1.5-rc.1 tree, read-only; full write-up in
`docs/research/wrapper-vehicle-seams.md` Finding 7):

- `dsh-api-session-controller/lib/types/client/sessions/service.d.ts:103-110` —
  `SessionBinding.eventSource: SessionEventSource`, "Contiguous event window reserved for
  Conversation assembly"; `ClientSessions.binding(id)` (:307-312; outward face
  `client/contract/sessions.d.ts:118-123`) resolves it per session id.
- `client/contract/events.d.ts:56-63` — `SessionEventWindow {entries, hasMore, revision,
  change}`; `SessionEventSource = ObservableSnapshot<SessionEventWindow>`. Entries are
  durable `SessionEvent`s + client-only `assistant/live-chunk` transients (:6-27); deltas
  are replace/prepend (history pages) / append (live) / settle-assistant (:40-54).
- Replay + pagination semantics: the window opens when the session is STAGED
  (`sessions/service.d.ts:314-320`, `followCurrent` — staging pulls the history window;
  the shell's selection already rides `sessions.open(id)` via ticket 79's `onOpen` hook);
  older pages via `ISession.loadOlder()` (`client/contract/session.d.ts:120-124`) aliased
  scope-addressed as `ctx.conversation.loadOlder()` (dsh-client-ui-conversation
  `client/service.d.ts:52-55,166-167`); `hasMore` is the continuation flag.
- Event vocabulary for the turn-model reduction: `dsh-session/lib/types/types.d.ts:242-404`
  (`user/message` :275-281 with `source`, `assistant/message` :301-317 with `interrupted`,
  `tool/call` :326-339, `tool/result` :340-361); block/stream shapes
  `dsh-llm/lib/types/types.d.ts:39-102,359-389`.

Verdict: Phase 2 proceeds on the real seam — window observable for replay+live, scoped
`loadOlder()` for pagination, `ctx.conversation` send for the composer (Finding 2). No
fantasy seams needed and none invented.

Implementation note (composer scope): AC 3 says "no stop affordance anywhere (area 7
conformity)", so the composer ships SEND-only; the verified scoped cancel verb
(`IConversation.cancel`, service.d.ts:50,165) is recorded here as deliberately unused, and
steer stays the same composer (plain text; the `/dispatcher-steer` prefill affordance of
tickets 22/40 already exists in the roster rows).

### 2026-09-19 — agent (implemented; Phase 2)

Landed on top of 78/79, using the verified seam (Finding 7). Shape:

- **Store/projection:** `src/client/conversation-store.ts` (new) — the pure turn-model
  reduction `reduceConversationWindow` (window entries → text-only transcript): user turns
  (`source.kind === "user"` only; the host's synthetic injected context is never rendered as
  the user's words), assistant turns (text blocks joined, `interrupted` marker, text-less
  tool-call-only steps omitted), per-attempt streaming items from `assistant/live-chunk`
  text deltas (streaming-in-place; the host's settle REPLACES the transient rows and the
  full-window recompute needs no client-side attempt ledger), collapsible tool rows paired
  by the result message's `source.callId` (first block's `toolCallId` fallback) re-hosting
  ticket 24's `describeToolview` over `{args, result}` (meta → parsed text-block JSON →
  safe degraded), derived `running` (open turn/start or live transients), `hasMore`
  passthrough. Structural `SessionEventWindow` shapes only, no `@deepseek-ai/*` import.
  `createConversationStore` holds per-session states: `waiting` (no window yet) /
  `unavailable` (no binding face, no binding, or an unreadable window — empty and
  unreadable are different facts) / `ready`.
- **Selection binding:** `src/client/conversation-feed.ts` (new) — `bindConversationFeed`
  follows the shell selection (ticket 79's store), resolves
  `sessions.binding(id).eventSource`, applies now + subscribes live, unsubscribes on
  selection move, degrades to `unavailable` without the face. The window opens because the
  selection rides `sessions.open(id)` (staging pulls the history window,
  `sessions/service.d.ts:314-320`). `requestOlder` fires the scoped `loadOlder()` verb
  (`sessions.scope(id).conversation.loadOlder()`); the window is the only truth — no
  outcome copy, no retry control.
- **Pane:** `src/client/conversation.tsx` (new) — the main-seat text-only pane: honest
  waiting/unavailable/empty states, user/assistant/streaming rows, per-tool rows as native
  `<details>` (collapsed by default) with ticket 24's fields + status rows, load-older
  affordance when `hasMore`, composer as plain textarea + send (Ctrl/Cmd+Enter). Pure
  composer states (`describeComposer`: enabled exactly with non-blank text and no in-flight
  send) and outcome→copy mapping (`sendOutcomeCopyKey`: silence on sent — the window shows
  the turn; honest lines on no-channel/failed with the draft KEPT). U-B recorded gaps: NO
  draft persistence (component state only — switching sessions remounts and clears it,
  never simulated), no attachments UI, no reasoning-block rendering, no markdown, no
  usage/model lines. No animation; native collapse.
- **Wiring:** `src/client/index.ts` `mountShellPage` — one conversation store, the window
  binding on the module fiber (teardown-safe), the pane as `hosts.conversation` (the
  shell's main seat calls it per render, like the hosted roster panel). Send rides ticket
  40's `bindCommandTransport` plain-prompt sink (`sessions.scope(id).conversation.send`)
  — the SAME verified sink, no parallel channel, no send journal (A4). `src/client/shell.tsx`
  gained the `conversation` host seat (without a seat the pane keeps the honest pending
  copy); `describeShellPanes` main kind is now `conversation`;
  `src/client/context.ts` widened structurally (`binding`, scoped `loadOlder`).
- **Composer scope decision (recorded):** the composer ships SEND-only — AC 3's "no stop
  affordance anywhere (area 7 conformity)" rules out a cancel/interrupt control; the
  verified scoped `IConversation.cancel` verb (service.d.ts:50,165) is deliberately unused.
  Steer is the same composer (plain text); the roster rows' `/dispatcher-steer` prefill
  (tickets 22/40) remains the power path.
- **Tokens/locale:** pane CSS uses only already-evidenced `--dsw-alias-*` tokens (pinned
  by an allowlist test; no new aliases, no hex, no animation); 15 new `shell.conv.*` copy
  keys in en+zh (key-set pin updated); the shell.* copy scans (retry-less, pull-only) stay
  green.

**Gates:** `npm test` 941 pass / 0 fail (235 suites, +74 over 79's 867; new suite
`test/client-conversation-surface.test.ts` covers reduction/store/binding/requestOlder/
composer states/CSS/copy contracts, plus mount tests in `client-shell-mount.test.ts`);
`npm run typecheck` clean (both configs); `npm run build:client` green (client\index.js,
141609 bytes — unminified build; +26.7 KB over 78's 114868 for the four new modules).
Live streaming-in-place rendering, theme-in-browser, and real-window behavior ride the
45/33 live lane and are deliberately not claimed from offline work.

### 2026-09-19 — resolved

All four ACs are offline-settleable and done (the ticket's own constraint names the
offline scope: view models, turn-model reduction from session/event-shaped payloads,
composer disable/enable states — live streaming behavior explicitly waits for the live
lane). Moved to `resolved/`. Recorded gaps travel in code comments and the Phase 2
comment above (no draft persistence U-B, no reasoning rendering, no cancel affordance
per area 7).
