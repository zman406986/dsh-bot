# 92 — Wrapper composer send is dead live: a service property read on the session-scope ctx throws (`cannot get property "conversation" without inject`), so `sendPrompt` never reaches the host sink

**Status:** open
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
2. (offline) `requestOlder` uses the same shape (the older-pages affordance is
   not dead live), same citations.
3. (offline) The fakes model the host contract: a scope ctx's `conversation`
   PROPERTY read throws `cannot get property "conversation" without inject`
   (host: `cordis/lib/index.js:672-694`), while `get("conversation")` returns
   the tag-bound sink (host: `:16500-16506`); a root-scope conversation read
   throws `conversation.send requires a session scope …`
   (`dsh-client-ui-conversation/lib/client.js:3177-3181`). Each touched
   fake's header carries those citations.
4. (offline) A pin drives the REAL send path (the composed transport, and the
   `onSend` wiring where practical) against a host-faithful fake and asserts
   the sink receives the text with the right session; RED-verified by
   reverting the fix (the pin must fail with the host's throw).
5. (offline) The composer submits on plain Enter (Shift+Enter keeps the line
   break; Ctrl/Meta+Enter still submits), matching the shipped composer's
   `enter` gesture (`dsh-client-ui-conversation/lib/client.js:15995,16023`
   `resolveSubmitMode(…, "enter", …)`), and the behavior is pinned.
6. `npm test` (0 fail), `npm run typecheck` (both configs),
   `npm run build:client` green with exact numbers recorded here.

## Notes

- Filed 2026-09-19 by the wt/send agent from the pass-5 evidence plus a
  first-hand re-derivation against the installed host tree.
- The live re-verification (click send in the elected frame, watch the turn
  land) is the separate live lane's job; this ticket is offline-complete only.
