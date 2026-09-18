# Research: wrapper-vehicle seams — how a whole-UI shell obtains the dispatcher's data (ticket 67)

- Question: ADR-0018 rules "we build the whole UI" — a GUI wrapper around dsh. What are the
  evidenced options for that wrapper's vehicle, and how does the wrapper obtain each datum it
  needs: session list/identity, conversation streams, worker spawn/steer/stop, todo state,
  approval prompts, and the session/event firehose? (Ticket 29's verification is the starting
  map; this pass re-verifies against the installed host, read-only, file:line.)
- Scope: the installed dsh product only (MIT). The forbidden reference tree was not opened.
  Research notes (`always-on-dispatcher-behavior.md`, `reference-behavior-notes.md`) are cited
  for reference behavior; the installed `@deepseek-ai/*` bundle is cited for host facts.
- Method: read `lib/types/**/*.d.ts` and `lib/index.js` of the seam-owning packages in the
  installed flat profile tree, plus this repo's own adapter (`src/adapter/cordis-dsh-host.ts`)
  for what already works. Version note: the installed tree at
  `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai` reads **0.1.5-rc.1** (240 packages,
  `dsh/package.json` version checked 2026-09-19) — ticket 72's comment recorded "0.1.5-rc.2"
  for the same tree; every citation below is from the rc.1 files actually on disk today.
- Date: 2026-09-19
- Builds on: `dsh-plugin-ui-patterns.md` (seam inventory, slot catalog, token layer),
  `dsh-capsule-seams.md` (verified capsule seams: overlay anatomy, `commands.execute`,
  composer prefill, `layout.selectPanel`), ticket 29 (`session/event` firehose, live-verified).

## Verdict

The wrapper does not need a new data plane. Every datum the whole-UI shell needs is already
reachable from **inside the dsh web client runtime** — as a client module, our bundle gets the
sessions feed, the conversation send/history orchestration, the forwarded Remote Event stream,
the theme token layer, and the locale service as injected services. The two real vehicle
questions are (a) how much of the shipped frame we displace, and (b) whether a *standalone*
page outside the shipped runtime is worth its wire-protocol rebuild. The evidence below feeds
ADR-0020's decision.

## Finding 1 — session list/identity: `ctx.sessions` (verified face)

`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:19-61` — the outward
`ISessions` face injected as `ctx.sessions`:

- `readonly list: ObservableSnapshot<SessionListState>` — "The useSessions standard feed
  (list rows + current selection; read face — writes stay inside the domain)" (:19-21).
- `create(opts?) => Promise<SessionId>` — create or adopt a Session on the Host (:27-35);
  `open(id)` — select a session as current, "unknown ids fail loud" (:38-42).
- Subagent faces (`openSubagent` :47, `subagentAddress` :53, `setSubagentCatalogOpen` :59) —
  the catalog children are the host's subagent tree, i.e. our workers as the host sees them.

Consequence: the wrapper's sidebar roster is a client of the standard feed; dispatcher
identity = session identity (ADR-0018: "each dispatcher gets its own dsh session"). Re-verifies
`dsh-capsule-seams.md` Seam 2's `ctx.sessions.list` reading on the current install.

## Finding 2 — conversation streams: `ctx.conversation` + the forwarded Remote Event stream

- `dsh-client-ui-conversation/lib/types/client/service.d.ts:25-60` — `IConversation`, "Scope-
  addressed conversation send, cancel, and history orchestration": `send(text)` (:38), the
  session-addressed `sendSession(session, text, attachments, mode, signal)` (:111), and the
  scoped cancel verb (:165). This is the composer's sink — the same one
  `dsh-capsule-seams.md` Seam 2/3 verified (`commands.execute` for commands; this sink for
  plain prompts).
- The live half rides the Gateway's forwarded Remote Event stream: the client-side owner is
  `ClientRemoteEvents` (`dsh-api-gateway/lib/types/client/remote-events.d.ts:8-28`) —
  "Register one typed Remote Event listener in its calling fiber" (`subscribe`, :28) over
  the WebSocket logical stream opened per connection generation. The shipped chat surface is
  itself composed from these services (`dsh-plugin-ui-patterns.md` Finding 5: the
  `conversation.chat.node` keyed domain and the `main.conversation` composition) — nothing
  about conversation rendering is host-private.
- Honest gap for the decomposition: the *history replay* face a custom surface would read to
  paint past turns was not isolated this pass (the shipped view reads it through
  `dsh-client-ui-conversation` internals). Ticketed as an open verification for the
  conversation-surface ticket (78-series), not assumed.

## Finding 3 — the firehose transport: one authenticated WebSocket, same-origin pages included

- Endpoint: `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"` (`dsh-api-gateway/lib/index.js:11`),
  registered as a webserver **upgrade route** whose handler first asks the connection for a
  rejection and otherwise hands the socket to `RemoteStreamMuxServer` (:455-476; mux contract
  `lib/types/stream-server.d.ts:6-30`).
- The gate: `requestRejection(request)` (`dsh-client-connection/lib/index.js:553-558`) —
  "Apply the configured Host/Origin fence, then browser authentication": untrusted host/origin
  → 403; unauthenticated → 401. Authentication is the **process-token exchange or cookie**
  (`authorizeIndex` / `authenticatedUrl`, :559-566) — i.e. a cookie-holding browser origin.
- Consequence: **any same-origin page the webserver serves carries the auth context** the
  shipped client uses. A standalone page served from a plugin route could open the same mux —
  but it would then have to speak the Typert remote protocol (`TypertGatewayService`,
  `dsh-api-gateway/lib/types/index.d.ts:41-118`) and rebuild the client service layer the
  shipped runtime provides for free. That cost is the standalone option's price, recorded for
  ADR-0020's option table.

## Finding 4 — a plugin can serve its own page (host side)

`dsh-host-webserver/lib/types/index.d.ts:1-110`:

- `WebRoute.handler` — "Owns the full response lifecycle (may hold the response open, e.g.
  SSE)" (:37); `kind: "prefix"` matches `p` and `p/<anything>` (:28-29); `register`
  returns a disposer, duplicate `(kind, path)` throws loud (:84-90).
- `registerUpgrade` for exact-path socket owners (:41, :97) and `registerFallback` (one seat,
  second registration throws) also exist (:101-106).
- The `webserver/index-inject` event (:27) and `tapIndex` transforms (:108-114) apply only to
  the **shipped** index page — they can inject into the host's page, not replace it.

## Finding 5 — displacing the shipped frame: the `root` slot is a single slot with graceful fallback

From the verified slot semantics (`dsh-plugin-ui-patterns.md` Finding 5, which cites
`dsh-client-ui-renderer/lib/types/client/registry.d.ts:16-38, 24-27, 156-164` and
`lib/client.js:1177-1182`):

- `root` is the shell's only ctx-level render (occupied by the shipped AppFrame); its contract
  note says "DO NOT register here … a second entry … shadows [the frame]" — a **coexistence
  etiquette** for plugins that want to coexist, and a documented shadowing mechanism: winners
  per cell are "the first live (non-abdicated) entry … in priority order", and **dynamically
  registered entries get lower priority than the shipped one**, so a dynamic entry wins the
  cell exactly while it stays live.
- Consequence: our whole-UI frame, registered dynamically into `root`, displaces the shipped
  app **and falls back to it on our own crash** (per-entry error boundary → abdication → the
  shipped frame takes the cell back). The failure mode of "we are the whole UI" is the stock
  product, not a blank window.
- The gentler intermediate also remains verified: a `main` keyed page (ours by default — the
  only shipped key is `"conversation"`) opened via `ctx.layout.selectPanel(panelId)`
  (ui-layout `lib/client.js:399-412`, verified in `dsh-capsule-seams.md` Status corrections).

## Finding 6 — the dispatcher-specific data is already ours (no new seams)

- Worker spawn/steer/stop: the five dispatcher tools + worker access tool register on the host
  ctx (`src/plugin.ts:373-436`; `src/adapter/dispatcher-tools.ts`), gated per ADR-0019's
  design; UI intents ride the verified capsule seams (`commands.execute` verbatim activation,
  composer-draft prefill for steer, conversational stop phrasing — `src/client/actions.ts`).
- Todo state: core todo reconciler (`src/core/todo-reconciler.ts`), projected to the client
  through the roster snapshot mirror (existing settings-channel feed, `src/client/index.ts:147-188`).
- Approval prompts: the access relay + host `ctx.approval`/`ctx.userQuestions` waterfall
  (tickets 13/23/30 — `dsh-plugin-ui-patterns.md` Finding 3); the wrapper renders our relay's
  pending asks as its own cards; it never needs a new prompt pathway.
- `session/event` firehose: the host half already subscribes (`ctx.on("session/event", ...)`,
  `src/adapter/cordis-dsh-host.ts:445`; live-verified by ticket 29) for presence/activity;
  the client half of any streamed surface rides Finding 2's forwarded events.

## Consequences (input to ADR-0020)

1. **No second client is required.** The whole-UI wrapper can be a client module in the
   shipped runtime — every service it needs is injectable, theme/locale included
   (`--dsw-*` token layer, ticket 49).
2. **The standalone-page option costs a Typert client + service-layer rebuild** (Finding 3/4):
   the page serving is trivial; the data plane behind it is not. That rebuild would duplicate
   exactly the layer ADR-0018's A5/A4 exceptions say to keep in dsh.
3. **The whole-frame displacement is technically clean and fails safe** (Finding 5): dynamic
   lower-priority entry, abdication falls back to the shipped frame. The `root` DO-NOT is
   coexistence etiquette we would be deliberately retiring for our own product shell — a
   decision for the ADR, not a technical blocker.
4. **Open verification** (flagged, not assumed): the conversation *history replay* face for a
   custom chat surface (Finding 2); per-dispatcher keying of the roster mirror rides ticket
   76/ADR-0019's keying table.

## Finding 7 — history replay IS exposed: the binding's event window (Finding 2's gap, closed)

Date: 2026-09-19 (ticket 80's open verification; same installed 0.1.5-rc.1 tree, read-only).
Verdict: the replay face a custom chat surface reads **exists as an outward face** — it is the
`SessionBinding`'s contiguous event window, not a `dsh-client-ui-conversation` internal:

- `dsh-api-session-controller/lib/types/client/sessions/service.d.ts:103-110` —
  `SessionBinding` carries `eventSource: SessionEventSource`, documented "Contiguous event
  window reserved for Conversation assembly". `ClientSessions.binding(id)` (same file
  :307-312, outward `ISessions.binding` at `client/contract/sessions.d.ts:118-123`) resolves
  it for any listed session id — "the scope-addressed assembly feed".
- `dsh-api-session-controller/lib/types/client/contract/events.d.ts:56-63` —
  `SessionEventWindow { entries, hasMore, revision, change }`;
  `SessionEventSource = ObservableSnapshot<SessionEventWindow>` (:63). Entries are
  `SessionEventLikeEntry` — durable `SessionEvent`s plus client-only
  `assistant/live-chunk` transient rows (:6-27) whose `seq` orders them between durable seqs;
  the window's deltas are `replace`/`prepend` (older history pages) / `append` (live tail) /
  `settle-assistant` (a durable `assistant/message` atomically supersedes one attempt's
  transient rows) (:40-54). `MutableSessionEventSource` (:65-101) publishes every mutation
  synchronously.
- Snapshot/pagination semantics: the window opens when the session is STAGED —
  `ClientSessions.followCurrent` "pull(s) the new occupant's history window. Staging IS the
  open signal — the window opens ⟺ the session is on stage" (`sessions/service.d.ts:314-320`);
  a reopen lazily rebuilds and backfills (`dropScope` note, :341-345). Older pages paginate
  through `ISession.loadOlder()` ("Extend the history window backwards"; failures land in
  `snapshot.openState/loadingOlder`, `client/contract/session.d.ts:120-124`; also
  `loadThrough(seq)` :126-133), aliased scope-addressed as `ctx.conversation.loadOlder()`
  (`dsh-client-ui-conversation/lib/types/client/service.d.ts:52-55,166-167`). `hasMore` on
  each window snapshot is the pagination continuation flag.
- Event vocabulary for the reduction: `dsh-session/lib/types/types.d.ts:242-404` —
  `user/message` (:275-281, `UserMessage`; `source` distinguishes direct prompt from
  synthetic injected context), `assistant/message` (:301-317, assembled message + embedded
  `stream` + `interrupted` marker), `tool/call` (:326-339, `callId`/`name`/raw `arguments`),
  `tool/result` (:340-361, `ToolResultMessage` + optional `error`/`meta`), plus
  `turn/*`, `step/*`, `request/*`, `system/message`, `assistant/attempt` (log/derived-only).
  Message/block shapes: `dsh-llm/lib/types/message.d.ts:119-153` (`content: ContentBlock[]`,
  `source`), `dsh-llm/lib/types/types.d.ts:39-102` (text/reasoning/image/file/tool-call/
  tool-result blocks) and :359-389 (`StreamChunk` — the live chunk payload).
- Consequence for ticket 80: a custom conversation pane reads
  `sessions.binding(id).eventSource` (observable window → replay + live tail in one face),
  paginates with the scoped `loadOlder()`, and sends/cancels through Finding 2's
  `ctx.conversation` verbs. The staged-window caveat: the window fills for the STAGED
  session, so a pane rendering the selected session must ride `sessions.open(id)` — which
  the shell's sidebar selection already does (ticket 79's `onOpen` hook). Nothing here is
  host-private; the shipped chat assembles over the same window
  (`dsh-client-ui-conversation/lib/types/client/conversation/assembly.d.ts:13-49`).
