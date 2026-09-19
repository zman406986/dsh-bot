# 92 — Wrapper composer send is dead live: a service property read on the session-scope ctx throws (`cannot get property "conversation" without inject`), so `sendPrompt` never reaches the host sink

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 80 (the conversation surface this breaks), 40 (the transport it
rides), 36 (the seam note that fixed the shape), 86/91 (the fake-vs-host
contract-gap class this is the 5th instance of), 84/85 (the guard-proxy /
registration halves of the same class), 78 (the cutover that put the shell
live), 33 (the live-pass lane)

## Problem

Live browser pass 5 (2026-09-19, evidence
`C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\evidence\B\`): clicking the
wrapper shell's composer send (`.multitask-dispatcher-conv__send`, driver
`B3-03-send.json`) produces the honest failure line
`发送失败——消息未送达。` (`shell.conv.send-failed`, `{kind:"failed"}`,
`B3-04-poll1.json.out.json`). **No model turn is spent.** The same text
resent through `POST /api/session/prompt` returns
`{"accepted":true}` (`B3-05-promptdiag.json.out.json`,
`B3-06-instr.json.out.json`), so the wire and the session are fine — the
client-side scope addressing is not.

Shipped shape (`src/client/actions.ts:155-165`, bundle
`dsh-bot/client/index.js:316-326`):

```ts
const actx = sessions.scope(sessionId);
const sink = actx?.conversation;          // ← throws live
if (actx == null || typeof sink?.send !== "function") return { kind: "no-channel" };
await sink.send(text);
```

`src/client/index.ts:657-666` catches the throw and returns
`{kind:"failed"}` — the exact live copy.

### The host contract (established first-hand, installed 0.1.5-rc.2 tree, read-only)

- `ctx.sessions.scope(id)` resolves the **Agent-scoped context**
  (`dsh-api-session-controller/lib/client.js:3254-3256`; the tag is minted by
  `createScope`, `lib/types/client/scope.js:27-36`). That part is fine — the
  ctx returned IS tagged.
- **Reading a service as a PROPERTY off that scoped ctx throws.** The cordis
  context proxy resolves a service property read by walking the FIBER chain
  from the accessing ctx (`cordis/lib/index.js:672-694`); the scope fiber is
  the no-op `agentScope` plugin (`scope.js:21`), so the walk leaves the
  sessions plugin's fiber and reaches the root fiber, where
  `fiber.runtime === null` → `throw error` with
  `cannot get property "conversation" without inject` (`lib/index.js:690`).
  The conversation service is provided by a CHILD plugin of the conversation
  module's fiber (`dsh-client-ui-conversation/lib/client.js:16837`
  `ctx.plugin(ConversationController, …)`), which is not on the scope fiber's
  ancestor chain — so the walk can never find it.
- **The host's own scoped call shape is the service-METHOD form**
  (`ctx.get(name)`), which resolves through the isolate-keyed store without
  the fiber walk and still rebinds `this.ctx` to the accessing (scoped) ctx,
  so `scopeOf(this.ctx)` finds the tag:
  - `dsh-client-ui-conversation/lib/client.js:16500-16506`
    (`scopedConversation`: `const scoped = sessions.scope(id); const
    conversation = scoped.get("conversation");`)
  - `dsh-client-ui-conversation/lib/client.js:14375-14377` (queue dock:
    `const actx = ctx.sessions.scope(sessionId); const conversation =
    actx.get("conversation");`)
  - the sink's own tag check: `:3170-3181` (`scopeId` → `scopeOf(this.ctx)`;
    undefined → `conversation.send requires a session scope — address one via
    ctx.sessions.scope(id).conversation`).

Empirically re-confirmed offline against the REAL installed cordis + the REAL
`createScope` helper, in a composition that mirrors the live host (sessions
module fiber + conversation module fiber with the service provided by a child
plugin + a loader-entry module injecting both):

```
scopeOf(actx)                       = s1
root  ctx.conversation.send         -> THREW: conversation.send requires a session scope — address one via ctx.sessions.scope(id).conversation
scope ctx.conversation.send         -> THREW: cannot get property "conversation" without inject   ← the shipped shape
scope ctx.get("conversation").send  -> ok: delivered:s1:hi                                        ← the host's shape
```

So the shipped property read can never reach the sink live: it throws before
`send` is called. (The ticket's live-pass note quoted the host's scope error;
that text is what a ROOT-scope read produces — either way the same line of
code is the defect and the same fix removes both failure modes.)

**Same defect, second site:** `src/client/conversation-feed.ts:120-121`
(`requestOlder`) reads `actx?.conversation?.loadOlder` — the older-pages
affordance is dead live for the same reason.

### Why the offline gate missed it (the 86/91 class)

`bindCommandTransport` had **no test at all** (the only `sendPrompt` mentions
in `test/` are hand-rolled `CommandTransport` stubs in
`test/resolve-command.test.ts:271-312`), and the two fakes that DO model
`scope(id) → { conversation }` accept the property read the host rejects:

- `test/client-conversation-surface.test.ts:745-770` (`scopeFake` for
  `requestOlder`),
- `test/client-shell-seat-composition.test.ts:191-196` (`scope: (id) => ({
  conversation: { loadOlder }, id })`),

and every composition-level fake hands `scope: () => undefined`
(`test/client-shell-mount.test.ts:287,931`,
`test/client-face-scaffold.test.ts:741`), so the scope-addressed branch of the
real send path is never exercised. A fake that accepts a call the host
rejects is exactly the divergence 86/91 describe.

## Acceptance criteria

1. (offline) `sendPrompt` reaches the host sink through the host's own scoped
   service-method shape: `sessions.scope(id)` then `.get("conversation")`
   (falling back to the property read only for a structural runtime whose ctx
   has no `get`); the module header cites
   `dsh-client-ui-conversation/lib/client.js:16500-16506` and `:14375-14377`
   as the idiom and `cordis/lib/index.js:672-694` as the reason the property
   read cannot work on a scope ctx.
   **DONE 2026-09-19.** `src/client/actions.ts` — new exported
   `scopedConversation(actx)` helper (the one resolution point, with the
   citations in its doc block); `sendPrompt` is now
   `scopedConversation(sessions.scope(sessionId))` and calls the sink as a
   METHOD of the returned face (the host's tag rides the call receiver).
2. (offline) `requestOlder` uses the same shape (the older-pages affordance is
   not dead live), same citations.
   **DONE 2026-09-19.** `src/client/conversation-feed.ts:120-136` resolves
   through the same helper and calls `face.loadOlder()` as a method (the old
   code captured the verb detached — `const load = …; load()` — which also
   loses the tracker rebinding); the whole resolution + call sits inside the
   helper's containment `try`.
3. (offline) The fakes model the host contract: a scope ctx's `conversation`
   PROPERTY read throws `cannot get property "conversation" without inject`
   (host: `cordis/lib/index.js:672-694`), while `get("conversation")` returns
   the tag-bound sink (host: `:16500-16506`); a root-scope conversation read
   throws `conversation.send requires a session scope …`
   (`dsh-client-ui-conversation/lib/client.js:3177-3181`). Each touched
   fake's header carries those citations.
   **DONE 2026-09-19.** Three fakes aligned, each with the host citations in
   its header/doc block: `test/client-shell-seat-composition.test.ts`
   (`fakeSessions.scope`), `test/client-conversation-surface.test.ts`
   (`scopeFake`), `test/client-composer-send.test.ts` (`fakeSessions`) — all
   three now throw the live property-read error and serve the sink through
   `get("conversation")`. The remaining scope fakes in the tree return
   `scope: () => undefined` (no conversation face) and are unchanged.
4. (offline) A pin drives the REAL send path (the composed transport, and the
   `onSend` wiring where practical) against a host-faithful fake and asserts
   the sink receives the text with the right session; RED-verified by
   reverting the fix (the pin must fail with the host's throw).
   **DONE 2026-09-19.** Two layers:
   `test/client-composer-send.test.ts` (new suite) renders the REAL
   `mountShellPage` composition with react-dom over jsdom, types into the
   composer, clicks send, and asserts the scoped sink got
   `{sessionId: "s-plain", text: "ship it"}` (plus the older-pages click →
   scoped `loadOlder`, and Enter/Shift+Enter); the transport pin lives in
   `test/client-conversation-surface.test.ts` (`sendPrompt` →
   `{kind:"sent"}` + the sink record; no-scope / no-service / no-face →
   `no-channel`). RED evidence (property read restored in the helper, same
   run): 6 failures — composer click `actual: [] expected: [{…}]`, Enter
   `actual: [] expected: [{…}]`, older-pages `actual: [] expected: ['s-plain']`,
   the two `requestOlder` verb tests `actual: [] expected: ['s-1']`, and the
   transport `actual: {kind:'no-channel'} expected: {kind:'sent'}`. Restored →
   all green.
5. (offline) The composer submits on plain Enter (Shift+Enter keeps the line
   break; Ctrl/Meta+Enter still submits), matching the shipped composer's
   `enter` gesture (`dsh-client-ui-conversation/lib/client.js:15995,16023`
   `resolveSubmitMode(…, "enter", …)`), and the behavior is pinned.
   **DONE 2026-09-19.** `src/client/conversation.tsx:210-222`: Enter submits
   unless Shift is held (line break — the shipped editor's own Shift+Enter
   binding, `dsh-client-ui-conversation lib/client.js:4962-4968`) or an IME
   composition is in flight; the Ctrl/Meta+Enter chord still submits (the
   host's accelerated gesture). Pinned in `test/client-composer-send.test.ts`
   ("plain Enter submits, keeps Shift+Enter for the line break").
6. `npm test` (0 fail), `npm run typecheck` (both configs),
   `npm run build:client` green with exact numbers recorded here.
   **DONE 2026-09-19** (this worktree, branch `wt/send`): `npm test`
   **1084 tests / 267 suites / 0 fail** (baseline at `a3e54bf` measured the
   same way: 1079/265/0 — the delta is this ticket's 5 tests / 2 suites);
   `npm run typecheck` clean on both configs; `npm run build:client`
   **161,689 bytes** (baseline 161,214 B, +475 B).

## Comments

**2026-09-19 (wt/send agent) — filed, root-caused, fixed, pinned; resolved.**

Filing commit: `ff52be5` (the ticket file alone). The fix + pins land in the
commit that carries this file's move to `resolved/`.

- **What the live pass saw** (`evidence/B/B3-03-send.json`,
  `B3-04-poll1.json.out.json`): the composer click produced
  `发送失败——消息未送达。` and no turn; `POST /api/session/prompt` with the
  same text answered `{"accepted":true}` (`B3-05`, `B3-06`) — so the wire and
  the session were healthy and only the client-side scope addressing failed.
- **What the host contract actually is** (installed 0.1.5-rc.2, read-only):
  `sessions.scope(id)` returns the tagged Agent context
  (`dsh-api-session-controller/lib/client.js:3254-3256`), but a service
  PROPERTY read on it throws — the cordis context proxy resolves service
  properties by walking the fiber chain (`cordis/lib/index.js:672-694`) and
  the scope fiber is the no-op `agentScope` plugin
  (`lib/types/client/scope.js:21-36`), so the walk dies at the root fiber
  (`:690`); the conversation service is provided by a CHILD plugin of the
  conversation module's fiber (`dsh-client-ui-conversation/lib/client.js
  :16837`), never on that chain. The host's own scoped call sites use the
  service-METHOD boundary instead (`:16500-16506`, `:14375-14377`), which
  resolves through the isolate-keyed store and still rebinds `this.ctx` to
  the scoped context (so `scopeOf(this.ctx)` at `:3177-3181` finds the tag).
- **Re-confirmed empirically, offline, against the real packages** (throwaway
  probe, not committed): a composition mirroring the live host (sessions
  module fiber + conversation module fiber with the service provided by a
  child plugin + a loader-entry module injecting both) built on the installed
  `cordis` + the installed `createScope` helper printed:
  `scopeOf(actx) = s1`;
  `root ctx.conversation.send` → the host's `conversation.send requires a
  session scope — address one via ctx.sessions.scope(id).conversation`;
  `scope ctx.conversation.send` → `cannot get property "conversation" without
  inject`; `scope ctx.get("conversation").send` → `delivered:s1:hi`.
  The ticket's live-pass note quoted the scope error; that text is what a
  ROOT-scope read produces — the shipped line was the property read on the
  scope ctx, and the fix removes both failure modes.
- **Why the gate missed it:** `bindCommandTransport` had no test at all, and
  the two fakes that modelled the seam accepted the property read the host
  rejects (the 86/91 class). Both are now host-faithful, and the new
  `test/client-composer-send.test.ts` drives the real composition end to end.
- **Secondary finding, fixed in scope** (same live pass, wrapper-only):
  the composer submitted only on Ctrl/Meta+Enter. The shipped composer's
  plain-Enter gesture is `resolveSubmitMode(…, "enter", …)`
  (`dsh-client-ui-conversation/lib/client.js:15995,16023`) with Shift+Enter
  as the line break — the wrapper now matches, pinned.
- **Still owed to the live lane (not claimed here):** click send in the
  elected frame against a real dsh boot and watch the turn land; the
  offline ACs above are complete.
