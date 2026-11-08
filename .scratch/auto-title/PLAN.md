# Summoned team-leader session titles — plan

**Status:** proposal only. No product code was changed, no tests were run, no git commands were run.
**Date:** 2026-11-07
**Goal:** a team-leader session created by `spawn_dispatcher` should show a real title in the sidebar instead of the stock “Untitled” label.

**Short recommendation:** after the child session is created and before its first turn, name it through the host’s own title service with the title the dispatcher already had to supply (`spawn_dispatcher`’s `title` argument). This is the same native API the host uses for schedule-created sessions and the same one the sidebar rename action uses. It costs no model call, it is durable, and it removes “Untitled” immediately.

**Important finding:** the host’s *model* auto-naming cannot produce a valid title for this session today without either pretending the machine-written handoff prompt is a human message or changing dsh’s session format. Section 2 and Appendix A explain why. If “native auto-naming” means “the model must choose the words”, the human has to choose Appendix A and accept a dsh-side change; otherwise the recommendation above is the minimal, native, shippable fix.

---

## 1. What is happening

### 1.1 The spawn path today

1. The dispatcher calls `spawn_dispatcher` with a required `title` and a required `prompt` (`src/core/tools.ts:1626-1646`). The tool description says the title is a short human title for the summoned dispatcher and that “the host shows it on the child session” (`src/core/tools.ts:1636-1638`). The core passes both through `DispatcherSpawnOptions`; its `title` comment also claims the host shows it as the child’s title (`src/core/types.ts:87-93`).
2. The host creates a real top-level session with `ctx.agents.create({ sessionId, meta: { cwd, ... }, agentOptions, setup })` (`src/adapter/cordis-dsh-host.ts:4037-4056`). There is **no title field** in that call. `CreateAgentOptions` has no title field either (installed `dsh-agent/lib/types/index.d.ts:49-72`).
3. The host hands the title to the plugin’s activation hook (`src/adapter/cordis-dsh-host.ts:2511-2548`). The plugin stores it as the peer-roster label for that session (`src/plugin.ts:1172-1192`, `src/adapter/parent-agent.ts:802-806`, roster read at `:673`). That label is **not** the session’s stored title and is **not persisted**; ticket 159 records that limit (`Issue-tracker/resolved/159-summon-spawn-title-fifo-race.md:142-144`, `src/adapter/cordis-dsh-host.ts:466-472`).
4. The child’s first turn is delivered through `agent.followup` with `role: "user"` but a producer-owned source kind: `source: { kind: WAKE_SOURCE_KIND }` (`src/adapter/cordis-dsh-host.ts:4233-4242`). `WAKE_SOURCE_KIND` is `plugin:multitask-dispatcher` (`src/adapter/wake-copy.ts:70-81`), not `user`.
5. The sidebar asks the host for the stored title. If there is none, the stock client prints the localized “Untitled” label (`dsh-client-ui-workspace/lib/client.js:998-1000` and `:2026-2029`; its README says the same at `dsh-client-ui-workspace/README.md:32`).

### 1.2 Why the title is “Untitled”

Nothing writes a title for the summoned session. The only title writer is the host’s session-title service, and its automatic path is gated on a **human** message:

- The service’s one “is this eligible?” helper only accepts `user/message` events whose `source.kind` is exactly `"user"` (`dsh-session-title/lib/index.js:89-98`).
- The event listener returns immediately for any other source kind (`dsh-session-title/lib/index.js:386-387`).
- The `titleInput` projection also counts only eligible human messages (`dsh-session-title/lib/index.js:266-280`, using the same helper).
- The README states the rule plainly: “Only text blocks from human `user/message` events are eligible” (`dsh-session-title/README.md:32`).

A summoned session’s only first turn has source kind `plugin:multitask-dispatcher`. The service therefore sees zero eligible messages: no deterministic fallback, no model provider, no `session/title` event. The client has nothing to display and falls back to “Untitled”.

The session is otherwise eligible: it is top-level (no parent), not seeded, and not `origin: "subagent"`. The first-prompt provider’s extra checks would pass if the message were human (`dsh-session-title/lib/index.js:396-405`). The source kind is the sole blocker.

### 1.3 The three hypotheses in the request

| Hypothesis | Finding |
|---|---|
| Written explicitly as “untitled” at spawn | **No.** No code writes any title at spawn. The word “Untitled” is a client display fallback for a missing stored title. |
| Auto-naming skipped because the session is “non-interactive” | **Not as a flag.** There is no “non-interactive” check. The session simply has no human message, which is the only input the title service accepts. |
| Naming is triggered only by a user turn that never happens | **Yes.** The title service waits for a human `user/message`; the summoned session’s first turn is plugin-sourced and no human turn is guaranteed. |

Ticket 159 already noticed the symptom when it recorded that the spawn title is “not persisted” and a cold-resumed summoned dispatcher’s roster label falls back to its raw session id (`Issue-tracker/resolved/159-summon-spawn-title-fifo-race.md:142-144`). The ticket deliberately did not fold the session-title fix in; this plan is that follow-up.

---

## 2. How native auto-naming works today

### 2.1 Three title routes

The host’s title service has three title sources, newest wins (`dsh-session-title/README.md:30-32`):

1. **Deterministic fallback** — the first few words of the first eligible human message, capped by `fallbackMaxWords` and `fallbackMaxBytes` (`dsh-session-title/lib/index.js:56-65`, fallback append at `:631-659`).
2. **Model provider** — one registered provider generates a title over the eligible human messages (`dsh-session-title/lib/index.js:350-383` registration; first-prompt provider in `dsh-session-title-first-prompt-llm/lib/index.js`).
3. **Explicit rename** — a user-supplied title, stored with source `user`; it pins the title and supersedes automatic work (`dsh-session-title/lib/index.js:291-317`).

The stock Web profile mounts `dsh-session-title` plus the first-prompt provider (`dsh-base/cordis.patch.yml:60-77`). The optional experimental bundle offers an all-prompts provider and ships switched off (`dsh-experimental-session-titles-bundle/cordis.patch.yml:1-12`).

### 2.2 The first-prompt condition

For the default first-prompt provider, a new session gets automatic model work only when all of these are true (`dsh-session-title/lib/index.js:396-405`):

- the message is a `user/message` with `source.kind === "user"` and non-empty text;
- the session has no stored title yet;
- the session is not seeded (`header.isSeeded`) and not `origin: "subagent"`;
- the count of eligible messages is exactly 1;
- the service is active and a provider is registered.

The service then stores a pending revision. The provider is **not** called on the message event itself. It starts only after the main request’s exact route is known:

- `request/header` event → `startPending` with the logged provider/model (`dsh-session-title/lib/index.js:416-427`);
- or a marked loop request whose route matches the request header (`dsh-session-title/lib/index.js:429-442`).

This is why the model title appears shortly after a normal session’s first turn starts, not before it.

### 2.3 The model call, cost, and timing

The default provider is `session-title-first-prompt-llm` (`dsh-base/cordis.patch.yml:67-77`). It makes one auxiliary LLM request:

- It uses the session’s current provider/model route unless the deployment overrides the pair (`dsh-session-title-llm/lib/index.js:114-122`; execution at `:160-199`).
- System instruction: create a concise title from the supplied human messages, one line, natural language, about 5 words in non-CJK languages or 10 CJK characters (`dsh-session-title-first-prompt-llm/lib/index.js:43-51`).
- Input: a JSON array containing the first eligible message (the 4 KB input cap is checked before dispatch) (`dsh-session-title-first-prompt-llm/lib/index.js:53-56`, `:99-107`; cap at `dsh-session-title-llm/lib/index.js:169-180`).
- Output: capped by `maxOutputTokens` (4096 in the stock first-prompt config, 64 in the experimental all-prompts bundle), with a 60-second overall timeout (`dsh-base/cordis.patch.yml:72-77`; `dsh-session-title-llm/lib/index.js:181-198`).
- It logs the exact auxiliary request as `session/title-llm-request`, then appends one `session/title` event with source `provider` (`dsh-session-title-llm/lib/index.js:199-220`; `dsh-session-title/lib/index.js:462-494`).
- It never delays the main agent response and never enters the main model input (`dsh-session-title/README.md:12`, `:121-127`; the title event is log-only by definition at `dsh-session-title/lib/types/index.d.ts:36-43`).

Practical cost: one extra short model call per new session, input under 4 KB, output normally a handful of tokens, on the same route as the conversation. The exact money depends on the provider and model; there is no per-use dollar constant in the repo. Because it is asynchronous and starts after the main request header, it does not add first-turn latency. The deterministic fallback is written before the provider runs (`dsh-session-title/lib/index.js:462-467`), so a failed/timed-out provider leaves the fallback title in place.

### 2.4 What it would take to satisfy the condition for a spawned session

There are three possible routes:

1. **Make the first handoff a human message** (`source.kind: "user"`). The title service would then treat the handoff prompt as the first human message, produce a fallback from its first words, and call the model after the first request header. This is a one-line change in our adapter, but it is a lie about provenance. The stock chat client renders `source.kind === "user"` messages as human input and anything else as context (`dsh-client-ui-chat/lib/client.js:11961-11993`), and the inbox/steering code also keys on `source.kind === "user"` (`dsh-client-ui-chat/lib/client.js:3563`, `:11875`). It would also make the title fallback read “Summoning dispatcher session id: …” because that is the first line of the handoff prompt. **Not recommended.**
2. **Use the native explicit rename** with the dispatcher’s title. This is supported, costs no model call, is durable, and the title service can always accept it because a user title has no source-message references (`dsh-session-title/lib/index.js:301-317`). It is exactly what the host’s schedule feature does for sessions it creates (`dsh-schedule/lib/index.js:1519-1529`), and what the sidebar rename action does through the session controller (`dsh-api-session-controller/lib/index.js:729-748`). **Recommended minimal change.**
3. **Change dsh so a marked non-human first message can be title input.** This would let the model name the session from the handoff prompt, but it is not a one-line change: the session format validator currently rejects a `session/title` event whose `messageSeqs` cite anything other than a human `user/message` with `source.kind === "user"` (`dsh-session-format-v3-to-v4/lib/index.js:836-845`). A provider title generated from a plugin-sourced message would therefore produce a log that dsh cannot replay. This needs a host API/format decision and a dsh release. See Appendix A.

---

## 3. Recommendation

**Ship route 2 now.** It gives the user a real, durable title with zero model cost and no protocol change. The title is the one the dispatcher already chose for the team; that is the most meaningful name available at spawn and it is already required by the tool contract.

This is **native naming** (the host’s own title store and its own public rename API), but it is **not model auto-generation**. If the human’s requirement is specifically “the model must choose the words”, route 3 is the only clean option and it needs a dsh-side change; route 1 is available today but corrupts provenance and is not recommended.

Why route 2 is better than route 1 even for a model-title outcome:

- It does not change what the model sees or how the chat UI classifies the handoff.
- It does not create a bad fallback title (“Summoning dispatcher session id: …”) while the model runs.
- It does not depend on a model call succeeding; the title is there before the first turn.
- It uses the same public API the host uses for its own programmatically created sessions, so it is not a private back door.

Why route 2 is better than leaving “Untitled”:

- The title is already supplied by the dispatcher and is already shown in the tool row/roster; the sidebar is the only place it is missing.
- The title survives restart because `session/title` is durable; the current roster label does not (ticket 159).
- It removes a visible defect with a tiny, reversible change.

---

## 4. The minimal change (route 2)

### 4.1 File-level touch list

| File | Change | Rough size |
|---|---|---|
| `src/adapter/cordis-dsh-host.ts` | Add a narrow `SessionTitleLike` interface, a guarded `readSessionTitle(ctx)` helper, and a `nameSummonedDispatcher(...)` helper. Call it in `spawnDispatcher` after the child is created and before `followup`. Add a comment explaining why this is a rename, not model auto-naming. | ~45 lines, mostly comment |
| `test/spawn-dispatcher-host.test.ts` | Add a fake `sessionTitle` service to the structural `ctx` stub (record calls; optional `get` result; optional throw). Add tests for success, existing title, absent service, throwing rename, empty title, worker path, and two concurrent summons. | ~110 lines |
| `src/core/types.ts` | Update the `DispatcherSpawnOptions.title` comment from “the host shows it as the child’s title” to state that the adapter now writes it through the host title service; no behavioral change. | 2-3 lines |
| `src/core/tools.ts` | Optional wording fix only if the owner wants the tool description to say “session title” explicitly; the current text becomes true after the change. | 0-2 lines |
| `Issue-tracker/open/<next>-summoned-session-titles.md` | File the follow-up ticket, with this plan’s decision and the recorded limitation. 284 is the next free number at the time of writing; confirm before creating. | new file |
| `.scratch/dispatcher-ledger.md` | Add one line when work starts/finishes, if the dispatcher’s ledger convention is kept. | 1 line |

No client code change is needed. The stock sidebar already reads the stored title; the title becomes visible through the existing host projection. No model/provider code changes. No new dependency. No change to the worker path.

### 4.2 Code sketch

The exact names can change, but the shape should stay this small:

```ts
interface SessionTitleLike {
  /** Current stored title, when the host version exposes it. */
  get?(session: unknown): unknown;
  /** Native explicit title write. Synchronous in dsh 0.2.2. */
  rename(session: unknown, title: string): unknown;
}

function readSessionTitle(ctx: AdapterContext): SessionTitleLike | undefined {
  if (typeof ctx.get !== "function") return undefined;
  try {
    const service = ctx.get("sessionTitle");
    if (typeof service !== "object" || service === null) return undefined;
    const candidate = service as Partial<SessionTitleLike>;
    return typeof candidate.rename === "function"
      ? (service as SessionTitleLike)
      : undefined;
  } catch {
    // The service is optional. A deployment without titles keeps working.
    return undefined;
  }
}

function nameSummonedDispatcher(
  titles: SessionTitleLike | undefined,
  session: unknown,
  title: string,
): void {
  const normalizedInput = title.trim();
  if (titles === undefined || normalizedInput.length === 0) return;
  if (titles.get !== undefined) {
    try {
      // Do not overwrite a title another native path already produced.
      if (titles.get(session) !== undefined) return;
    } catch {
      // A read failure must not suppress the write; fall through to rename.
    }
  }
  try {
    titles.rename(session, normalizedInput);
  } catch (error) {
    // Naming is bookkeeping: a failure must never turn a successful spawn
    // into a host refusal or suppress the first turn.
    try {
      console.warn(
        `[multitask-dispatcher] summoned dispatcher could not be named:`,
        error,
      );
    } catch {
      // A broken console must not break the spawn either.
    }
  }
}
```

Call site: in `CordisDshHost.spawnDispatcher`, after the created id is known (`src/adapter/cordis-dsh-host.ts:4131-4145`) and before the handoff `followup` (`:4233-4242`). A good placement is immediately before the handoff prompt is built, after the existing mark/workspace bookkeeping (`:4155-4213`):

```ts
nameSummonedDispatcher(readSessionTitle(ctx), handle.agent.session, opts.title);
```

Use `handle.agent.session`, not the reserved id string: if a host assigns a different id, the title must follow the actual live session (the same reason the code re-reads `handle.agent.session?.id` at `:4131-4135`).

### 4.3 Trigger and timing

- **When:** once per successful `spawnDispatcher`, after `ctx.agents.create` resolves and before `agent.followup` queues the first turn. The session is live at that point; `rename` requires exactly that (`dsh-session-title/lib/index.js:301-303`).
- **How often:** once per spawn. Re-announcements and cold resumes do not call it; they pass `title === undefined` today (`src/adapter/cordis-dsh-host.ts:466-472`), and the stored title survives.
- **What it writes:** one `session/title` event with `source: { kind: "user" }` and empty `messageSeqs` (`dsh-session-title/lib/index.js:308-312`). That is the host’s normal explicit-title shape and passes the format validator (`dsh-session-format-v3-to-v4/lib/index.js:838`).
- **What prompts it:** the dispatcher’s own `spawn_dispatcher` call. No human turn, no model call, no timer.
- **Pin:** because the stored title’s source is `user`, a later human message in the team leader’s session does not replace it; the title service returns before scheduling automatic work (`dsh-session-title/lib/index.js:394`). The human can still rename it explicitly.
- **Latency:** one synchronous in-memory append; no network and no model. It is effectively free compared with the existing mark/workspace bookkeeping around it.
- **Ordering:** before `followup` means the first sidebar paint (the row appears after the first turn lands) already has the title. Placing it after `followup` would also work eventually but could briefly show “Untitled”.

### 4.4 What the user sees

- The sidebar row for the summoned team leader shows the dispatcher’s title (e.g. “Invoice import fix”).
- The title survives a restart/cold resume because it is a log event, not the plugin’s in-memory label.
- The peer roster and the `spawn_dispatcher` tool row keep using the same title as before; nothing regresses.
- The peer roster’s deliberate decision not to read the title projection (`src/adapter/peer-label.ts:26-31`) is unchanged; it still uses `spawnTitles`/`subagent.label`. The sidebar row is the surface this change targets; the roster does not change.
- The human can still rename the session in the sidebar; that native rename overwrites the stored title.

---

## 5. Fallback behavior if naming fails or is disabled

| Situation | Behavior | Why |
|---|---|---|
| The deployment does not mount `sessionTitle` | Skip silently. The session stays “Untitled”; the spawn and first turn proceed normally. | Titles are an optional host service; a headless/minimal profile must still run the plugin. |
| The title service exists but `rename` throws (disposed, session no longer live, text normalizes to empty) | Catch, warn once, continue. The session stays “Untitled”. The spawn still returns the child id; the first turn is still delivered. | A naming failure is bookkeeping, not a spawn failure. This mirrors the existing mark/workspace failure policy (`src/adapter/cordis-dsh-host.ts:4146-4167`, `:4191-4213`). |
| The dispatcher passes an empty/whitespace title | The tool refuses before the host with `invalid-args` (`src/core/tools.ts:1653-1660`). A direct host caller with an empty title is skipped by the helper; no crash. | The tool contract already requires a non-empty title. |
| A title already exists (e.g. a future host names at create) | Skip; do not overwrite. | Native title wins; the plugin is only filling a gap. |
| Title is very long | The host normalizes and truncates to `maxTitleBytes` (80 bytes in the stock web config; `dsh-base/cordis.patch.yml:60-65`). No error. | The host owns the title policy; the plugin should not duplicate it. |
| Title has control characters / Markdown / newlines | The host strips terminal controls, collapses whitespace, and keeps one line (`dsh-session-title/lib/index.js:24-54`). The UI renders plain text. | The title is untrusted model output; native normalization is the right gate. |
| Duplicate titles | Allowed. Two sessions can share a title; no conflict error. | The dispatcher is told to give a short distinct title (`src/core/tools.ts:1636-1638`); deduplication would be a separate product decision. |
| Naming disabled by the human | If the deployment keeps the title service, there is no plugin-level switch in this minimal plan. Unmounting the service is the existing off switch. An optional `nameSummonedSessions` config flag could be added later if the owner wants a settings toggle. | Avoid a new setting for a one-path behavior; the host service presence already expresses the capability. |

Fallback title options, ranked:

1. **The dispatcher’s title** — already required, already meaningful, already visible in the tool row; use it. This is the recommendation.
2. **A snippet of the first prompt** — only if a direct host caller omits the title. Do not use the raw handoff prompt: its first line is “Summoning dispatcher session id: …”, which is not a title. If this fallback is ever needed, strip that line, take the first few words, and clamp to the host’s byte cap. Not part of the minimal change.
3. **Leave “Untitled”** — the safe failure mode when the title service is absent or rejects the title. Never invent a title that the host did not accept.

---

## 6. Should this apply to summoned workers too?

**Recommendation: no, only team leaders (summoned dispatchers) in this change.**

Reasons:

- **Workers are not sidebar rows.** The stock sidebar drops `origin: "subagent"` sessions (`dsh-client-ui-workspace/lib/client.js:964-966`), and the plugin’s own client notes that workers have no licensed sidebar seat (`src/client/session-kind.tsx:23-31`). Naming them would not fix a visible row.
- **Workers already have a durable identity label.** `subagent.label` is required on continuable children and is read by the peer roster (`src/adapter/peer-label.ts:5-15`, `:60-90`; ADR-0027 decisions 2-3). The session title is a different concept.
- **The native first-prompt provider explicitly excludes subagent-origin sessions** (`dsh-session-title/lib/index.js:398`). Treating workers as title-eligible would go against the host’s own policy.
- **Cost scales with worker count.** If the team ever moved to model auto-naming, one title call per worker would be pure overhead for sessions the user does not see. Even the zero-cost rename would add a log event per worker for no visible benefit.
- **If a worker is later promoted or opened by the human**, that is the moment to decide how it should be named; it can use its `subagent.label` then. Not now.

A future “name every spawned child” feature can reuse the same helper; the touch list would add the worker spawn path and a worker-specific fallback. That is a separate ticket.

---

## 7. Can the dispatcher rename the session afterwards?

**No, not through the plugin today.** There is no `rename` tool in the dispatcher surface (`src/core/tools.ts:771-785` describes the eight-tool shape; none is a rename). The only naming choice the dispatcher makes is the `title` argument at spawn, and after this change that becomes the stored session title.

The **human** can rename the session in the sidebar; the stock client has a session rename action that calls the host’s rename route (`dsh-client-ui-workspace/lib/client.js:72-84`, `:154-162`; host route at `dsh-api-session-controller/lib/index.js:729-748`). That native rename overwrites our stored title and pins the new one.

If the owner wants the dispatcher to correct a title later, the clean addition is a small tool that calls the same `sessionTitle.rename` on a target child session. It needs an authorization rule (the dispatcher may only rename sessions it summoned) and a target id; out of scope for this bug. Do not add it just to work around a bad spawn title; the human can rename.

---

## 8. Edge cases

| Case | Expected behavior | Notes |
|---|---|---|
| Very long title (hundreds of characters) | Host truncates to `maxTitleBytes` (80 bytes stock) at a UTF-8 code-point boundary. Title still displays. | `normalizeSessionTitle` / `truncateTitleUtf8` at `dsh-session-title/lib/index.js:24-54`. |
| Non-English title (Chinese, Japanese, etc.) | Stored and displayed as written. 80 bytes may cut a long CJK title; that is the host’s configured policy. | No transliteration, no language detection in our code. The dispatcher should keep the title short. |
| Duplicate titles | Both rows show the same title. | Accepted. The dispatcher’s tool description asks for 3-8 words; distinct names are the dispatcher’s responsibility. |
| Title normalizes to empty (only control/zero-width chars) | `rename` throws `SessionTitleInvalidError`; helper catches and leaves the session untitled. | `dsh-session-title/lib/index.js:304-305`. |
| Session creation fails | No child, no rename. The spawn returns the host’s refusal as today. | Rename is after `create`, so it cannot run on a failed create. |
| Child is created but first turn fails | Rename already applied. The session has a title; the row may stay blank/hidden until a later wake. The spawn still returns the child id, never a false refusal. | The existing post-create failure policy at `src/adapter/cordis-dsh-host.ts:4230-4252`. |
| Session disposed between create and rename | `rename` throws “not live”; caught; spawn continues. | No retry. |
| Host assigns a different session id | Rename uses `handle.agent.session`, so the title follows the real id. | Matches the existing created-id normalization at `:4131-4145`. |
| Two simultaneous summons | Each rename uses its own created session object and its own title. No queue, no FIFO, no swap. | This is the ticket 159 class of bug; our call has no shared array. |
| Cold resume / restart | Title survives in the log; no second rename because resume passes no title. | `session/title` is durable; `spawnTitles` is not. |
| Re-announcement of the same child | No second rename; the stored title stays. | `onDispatcherSpawned` passes `undefined` on re-announcement. |
| Title service absent | Skip; session stays “Untitled”; everything else works. | Optional-service pattern. |
| Title service throws on read | Treat as no title; still attempt the write. If `rename` also throws, skip. | `readSessionTitle` catches a missing service; the `get` check is best-effort. |
| Worker spawn | No rename; worker keeps its `subagent.label`. | Only the dispatcher path calls the helper. |
| User renames after spawn | User title wins; stored title changes; no auto-retitle. | Native rename already works. |
| Dispatcher wants a different title after spawn | Not supported by a tool; human renames. | See section 7. |

---

## 9. Test plan

### 9.1 Offline tests (no network, no LLM)

Tests 1-5, 7, and 8 live in `test/spawn-dispatcher-host.test.ts` and use the existing structural `AdapterContext` stub; no live dsh and no model. Test 6 (worker path) belongs in `test/adapter-cordis-dsh-host.test.ts`, which already exercises `host.spawnWorker`.

1. **Names the child from the spawn title, before the first turn.**
   - Stub `sessionTitle` records `{ sessionId, title, followupSeen }`; the stub’s `followup` flips `followupSeen` to true before recording its call. Do not add a new entry to the shared `ctx.events` array: four existing tests assert its exact contents (`test/spawn-dispatcher-host.test.ts:453`, `:782`, `:1686`, `:1893`), and churning them would obscure the real assertion.
   - Call `host.spawnDispatcher({ parentSessionId, title: "Invoice import fix", prompt: "..." })`.
   - Assert exactly one rename call; its session id equals the returned `dispatcherId`; its title is the exact spawn title; `followupSeen === false`.
   - Assert the first turn was still delivered (`ctx.followupCalls.length === 1`).
2. **Does not overwrite an existing title.**
   - Stub `get` returns `{ title: "Already named" }`.
   - Assert zero rename calls; the spawn still succeeds.
3. **Missing title service is harmless.**
   - Stub `ctx.get("sessionTitle")` returns `undefined`.
   - Assert spawn succeeds, `followup` is called, no throw.
4. **A throwing `get` or `rename` is harmless.**
   - First: stub `get` throws but `rename` works; assert one rename call and a successful spawn (a read failure must not suppress the write).
   - Then: stub `rename` throws `new Error("not live")`; assert spawn succeeds and `followup` is called; the warning path does not throw.
5. **Empty/whitespace title is skipped.**
   - Call the host directly with `title: "   "`.
   - Assert zero rename calls; spawn still succeeds. (The tool path already refuses empty titles; this covers a direct caller.)
6. **Worker spawn is not named.**
   - Add a recording `sessionTitle` fake to the existing worker host stub in `test/adapter-cordis-dsh-host.test.ts` (the stub already calls `host.spawnWorker` at `:311` and later).
   - Assert `spawnWorker(...)` makes zero `rename` calls and still returns the worker id.
7. **Two concurrent summons keep their own titles.**
   - Reuse the existing hold/interleave helper (ticket 159 test) if practical.
   - Assert two rename calls, each paired with the correct child id and title; no cross-pairing.
8. **No title service at all in the stub.**
   - The current tests already omit `sessionTitle`; they must keep passing without a stub, proving the optional path.

Suggested command:

```powershell
npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-host.test.ts test/spawn-dispatcher-tool.test.ts test/multi-dispatcher.test.ts
```

Expected: all tests pass; the new tests fail before the adapter change and pass after it.

### 9.2 Type and build checks

```powershell
npm run typecheck
```

or the narrower:

```powershell
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.client.json --noEmit
npx tsc -p tsconfig.test.json --noEmit
```

No client build is required because no client code changes. If the repo’s build freshness check is part of the lane, run `npm run check:build` as usual.

### 9.3 Manual check (short)

1. Build the plugin (`npm run build`) and restart the dsh profile that hosts the plugin so the new adapter code is loaded. The Web GUI under test is the existing one at `http://127.0.0.1:3080`; do not start a second server.
2. In a dispatcher chat, call `spawn_dispatcher` with a distinctive title (for example `Invoice import fix`) and a self-contained prompt.
3. Open the sidebar. The new team-leader row must show `Invoice import fix`, not “Untitled”. The spawn tool row and the peer roster must still show the same title.
4. Restart dsh and reopen the sidebar. The title must still be there (durable log event, not the in-memory label).
5. Rename the row through the sidebar. The new title must appear and survive a refresh.
6. Spawn a second team leader with a Chinese title and a very long title. Both must display without a crash; the long one must be truncated by the host, not by our code.
7. Spawn a worker. Its `subagent.label` must be unchanged and `check_workers` must still show it; no new session title is expected.

### 9.4 What is deliberately not tested here

- No real LLM title generation is involved in this plan, so no network/LLM test is needed. If Appendix A is chosen, the dsh repo’s own title-service tests plus a fake provider are the right place for the eligibility/format tests.
- No test asserts a specific “Untitled” CSS/DOM string; the client fallback is stock behavior and already covered by the host’s UI tests.

---

## 10. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The title is pinned as a `user` title, so the host’s model auto-naming will never update it later. | High by design | Medium: a team leader that later has a long human conversation keeps its job title. | Accept for now: the job title is the right identity for a summoned team leader. The human can rename. Revisit only with the host change in Appendix A. |
| A dispatcher gives a poor or duplicate title. | Medium | Low/medium: sidebar readability. | The tool description already asks for a short title; the human can rename. Consider a later quality check/ticket, not a hard cap now. |
| The title service is absent in a minimal/headless profile. | Low for Web/Desktop; medium for custom profiles | Low: the old “Untitled” behavior remains, nothing breaks. | Optional-service read; silent skip; document the limitation. |
| `rename` writes a `user`-sourced event, which overstates that a human chose the title. | High by design | Low: provenance is a log detail; the host itself does this for scheduled sessions. | Record the limitation in the ticket. If provenance matters later, add an `agent`/system title source upstream. |
| The title service API changes in a future dsh version. | Medium over time | Low: the helper simply stops naming. | Narrow structural interface; catch; test with a stub; update when the peer dependency moves. |
| Naming before `followup` could theoretically race a future host auto-title. | Low | Low: the helper checks `get` and skips if a title exists. | The check is part of the helper; no extra lock needed because the session is new and single-writer here. |
| Writing into another session’s log violates an old assumption (“nothing writes another session’s log”). | Certain, but intentional | Low: it is the host’s public title API, not a raw transcript write. | Document it as a deliberate behavior change in the ticket and code comment. |
| Test stub drifts from the real title service. | Medium | Low: a fake can pass while the live path fails. | Manual check plus the host’s own service tests; keep the stub tiny (get/rename only). |
| New title event changes session log size/replay. | Low | Very low: one small event per spawn. | No model input, no cache effect; the host already stores titles per session. |
| Legal/reference-copy risk. | None: original code and plan text. | — | No reference-folder code, prompts, identifiers, or text used. |

---

## 11. Ordered implementation steps (rough sizes)

| # | Step | Size |
|---|---|---|
| 1 | Add the failing host test and the fake `sessionTitle` service to `test/spawn-dispatcher-host.test.ts`; run it to confirm it fails for the right reason (no rename call). | 30-40 min |
| 2 | Add `SessionTitleLike`, `readSessionTitle`, and `nameSummonedDispatcher` to `src/adapter/cordis-dsh-host.ts`; call it before `followup`; add the comment. | 30-45 min |
| 3 | Add the edge-case tests: existing title, absent service, throwing rename, empty title, worker path, concurrent summons. | 45-60 min |
| 4 | Update the `DispatcherSpawnOptions.title` comment (and optionally the tool description) so the code’s story matches the behavior. | 5-10 min |
| 5 | Run the targeted tests and typecheck; fix any stub/type drift. | 15-25 min |
| 6 | Manual Web check: spawn, sidebar, restart, rename, CJK/long title, worker regression. | 20-30 min |
| 7 | File the follow-up issue and update the ledger; record the “pinned title / no model auto-naming” limitation. | 10-15 min |
| 8 | Review diff and commit (the dispatcher/reviewer handles git; the executing worker does not commit unless told). | 10 min |

Total: roughly 2.5-3.5 hours of focused work. No migration, no new dependency, no client rebuild.

If the owner instead chooses Appendix A, add a host-side design/release track before step 1; that is measured in days, not hours, and is outside this repo’s normal patch lane.

---

## 12. Open questions for the human

1. **What does “native auto-naming” mean here?** Is the dispatcher’s required team title acceptable as the real title, or must the model choose the words? This is the fork:
   - team title via native rename = ship now, zero model cost;
   - model-generated title = needs the dsh-side change in Appendix A.
2. **If model-generated text is required, may we change dsh itself?** The clean route needs the title service and the session-format validator to accept a marked non-human first message. That is a cross-repo change and a release dependency. If dsh changes are not allowed, the only in-repo model route is faking the handoff as a human message, which I do not recommend.
3. **Should the title be exactly the dispatcher’s title, or should it carry a team-leader marker** (for example “Team · Invoice import fix”)? Recommendation: exact title; the sidebar already has a dispatcher/team-leader glyph (“bot portrait”) from `src/client/session-kind.tsx`, and prefixes make titles longer and less searchable.
4. **Should the title be pinned forever, or should a later human message be allowed to regenerate it?** Recommendation: pinned for now. A pinned title is stable and matches the dispatcher’s intent. Unpinning/regeneration is a separate feature and needs a host `refresh` + a human-triggered action.
5. **Should summoned workers be named too?** Recommendation: no, for the reasons in section 6. Confirm that workers staying label-only is acceptable.
6. **Do you want a settings toggle to disable this?** Recommendation: no toggle in the minimal change; the host title service’s presence is the natural switch. If a toggle is required, add `nameSummonedSessions: boolean` (default true) to `Config` and the settings card.
7. **What is the fallback when the title service is absent?** Recommendation: leave “Untitled” and keep the spawn working. The alternative is a client-side display fallback using the peer roster label, which would require a new client read and is more moving parts.
8. **How should duplicate titles be handled?** Recommendation: accept them. If the owner wants disambiguation, choose a format now (for example a short parent/team suffix) rather than adding it later inconsistently.
9. **Should the dispatcher be able to rename a child after spawn?** Recommendation: no new tool now; the human can rename in the sidebar. If yes, a separate ticket for a rename tool with an authorization rule.
10. **Should the title survive cold resume?** With route 2 it will. Confirm that durable survival is desired (it is the main advantage over the current in-memory roster label).

---

## Appendix A — If the model must choose the words (not the minimal change)

This appendix exists so the human can decide with full information. It is **not** recommended for the first patch.

### A.1 Why it is more than a one-line source change

The host stores a title as a `session/title` event. For provider-generated titles, the event must cite the human messages it used (`messageSeqs`). The session-format validator checks every cited seq and rejects anything that is not a `user/message` with `source.kind === "user"`:

- `dsh-session-format-v3-to-v4/lib/index.js:836-845` — `titleSources`: “messageSeqs must cite distinct earlier human user/message events”.
- `dsh-session-title/lib/index.js:89-98` — eligibility helper accepts only `source.kind === "user"`.
- `dsh-session-title/lib/index.js:386-387` — listener returns for any other kind.
- `dsh-session-title/lib/index.js:462-494` — provider results are validated against those same messages.

So merely changing the adapter’s handoff source to a plugin kind with a flag would make the title service ignore it. Merely teaching the title service to accept it would make the provider generate an event that dsh cannot replay. The deterministic fallback has the same constraint: it cites the first eligible message (`appendFallback` at `dsh-session-title/lib/index.js:631-659`), so the same validator applies. Both layers have to change, or the source has to be a real human source.

### A.2 The clean host change (sketch)

1. Define a small, explicit marker on a `user/message` source, e.g. `titleEligible: true`, documented as “this producer’s message may be used as title input even though it is not human”.
2. Update the title service’s eligibility helper to accept the marker, and update every reader that shares it: the event listener, `titleInput`, and `collectSessionTitleMessages`.
3. Update the session-format validator to accept the marker when it validates `session/title` and `session/title-llm-request` references. This is the risky part: it changes what a valid session log means and may require a format-version decision/migration.
4. Decide the fallback text. The first 5 words of the handoff prompt are “Summoning dispatcher session id: …”, which is a bad title. Either (a) add a `titleHint` field to the source and have the fallback use it (the dispatcher title), or (b) change the handoff prompt order so the task text comes first. Both are additional changes with their own tests.
5. Add host tests with a fake provider that assert: a marked plugin message triggers the first-prompt provider; the fallback uses the hint; an unmarked plugin message does not; a title event replay validates; a provider failure leaves a good fallback.
6. Release a new dsh version, bump the plugin’s peer dependency, and add an adapter test that the handoff source carries the marker only on the first turn.

### A.3 dsh-bot side if the host change lands

- `src/adapter/cordis-dsh-host.ts:4233-4242` — add the marker (and optional title hint) to the handoff message source; keep `WAKE_SOURCE_KIND` for later wakes.
- `src/adapter/wake-copy.ts:95-111` — widen the structural `WakeUserMessage` source type if the marker is added there; the handoff object is built inline today, so only the type used by tests may need it.
- `test/spawn-dispatcher-host.test.ts` — assert the first handoff source is marked, later wakes are not, and the title service is not called with a rename when auto mode is enabled.
- Add a config switch only if both modes must coexist; otherwise replace the rename path.

### A.4 Trade-offs

| Approach | Cost | Risk | Recommendation |
|---|---|---|---|
| Fake the handoff as `source.kind: "user"` | 1 line in the adapter | Misattributes machine text as human; chat UI and inbox/steering treat it as human; fallback title is the summoner id line. | Do not. |
| Native `rename` with the dispatcher title | ~45 lines + tests | Pinned title; no model wording; requires the title service (optional). | **Ship this.** |
| Marked title-eligible source + format change | Cross-repo design, host release, tests, possibly a format bump | Protocol change; fallback quality; broad eligibility risk; release lag. | Only if the human requires model wording. |

---

## Appendix B — Evidence index

All dsh paths below are under
`C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.

### Our repo

- `src/core/tools.ts:771-785` — the eight dispatcher tools; no rename tool.
- `src/core/tools.ts:1626-1646` — `spawn_dispatcher` definition; title required; description at `:1636-1638`.
- `src/core/tools.ts:1653-1669` — title/prompt refusal and trim.
- `src/core/types.ts:87-93` — `DispatcherSpawnOptions`; title comment.
- `src/adapter/cordis-dsh-host.ts:394` — guarded `ctx.get` seam.
- `src/adapter/cordis-dsh-host.ts:466-479` — `onDispatcherSpawned` title parameter; recorded limit.
- `src/adapter/cordis-dsh-host.ts:1446` — host factory.
- `src/adapter/cordis-dsh-host.ts:2511-2548` — title label and hook call.
- `src/adapter/cordis-dsh-host.ts:4037-4056` — `ctx.agents.create` with no title.
- `src/adapter/cordis-dsh-host.ts:4131-4145` — created id normalization.
- `src/adapter/cordis-dsh-host.ts:4155-4213` — mark/workspace bookkeeping before the first turn.
- `src/adapter/cordis-dsh-host.ts:4233-4242` — handoff prompt and plugin source kind.
- `src/adapter/cordis-dsh-host.ts:4243-4252` — post-create first-turn failure is swallowed/logged.
- `src/adapter/wake-copy.ts:70-81` — `WAKE_SOURCE_KIND = plugin:multitask-dispatcher`.
- `src/adapter/wake-copy.ts:95-111` — structural user-message source shape.
- `src/plugin.ts:1172-1192` — title carried into activation as `{ title }`.
- `src/adapter/parent-agent.ts:673` — peer roster label fallback.
- `src/adapter/parent-agent.ts:790-806` — `spawnTitles` map; ticket 155 label.
- `src/client/session-kind.tsx:23-31` — workers are not sidebar rows; only dispatcher rows get a mark.
- `test/spawn-dispatcher-host.test.ts:86-368` — structural `ctx` stub used for the new tests.
- `test/spawn-dispatcher-host.test.ts:370+` — existing spawn shape tests.
- `test/adapter-cordis-dsh-host.test.ts:311+` — existing `host.spawnWorker` tests; the worker no-name assertion belongs here.
- `Issue-tracker/resolved/159-summon-spawn-title-fifo-race.md:142-144` — recorded “title is not persisted” limit.

### Installed dsh

- `dsh-session-title/lib/index.js:24-54` — title normalization and UTF-8 truncation.
- `dsh-session-title/lib/index.js:56-65` — deterministic fallback.
- `dsh-session-title/lib/index.js:89-98` — human-only eligibility helper.
- `dsh-session-title/lib/index.js:243-251` — service listens to `user/message` and `request/header`.
- `dsh-session-title/lib/index.js:266-280` — `titleInput` projection counts eligible human messages.
- `dsh-session-title/lib/index.js:291-317` — explicit rename; user source; pins.
- `dsh-session-title/lib/index.js:325-341` — explicit refresh; fallback if no eligible input.
- `dsh-session-title/lib/index.js:350-383` — provider registration.
- `dsh-session-title/lib/index.js:386-415` — `onUserMessage` gate and fallback scheduling.
- `dsh-session-title/lib/index.js:396-405` — first-prompt conditions (non-seeded, non-subagent, count 1, no title).
- `dsh-session-title/lib/index.js:416-442` — provider starts after the request route is known.
- `dsh-session-title/lib/index.js:443-494` — provider run, fallback, title acceptance.
- `dsh-session-title/lib/index.js:631-659` — fallback append.
- `dsh-session-title/lib/types/index.d.ts:36-43` — title event is log-only.
- `dsh-session-title/lib/types/index.d.ts:126-151` — public get/rename/refresh surface.
- `dsh-session-title/README.md:12`, `:30-32`, `:57`, `:121-127` — human-only input; first-prompt exclusions; no main-response latency/no token effect.
- `dsh-session-title-first-prompt-llm/lib/index.js:43-56` — system instruction and message framing.
- `dsh-session-title-first-prompt-llm/lib/index.js:93-114` — provider registration; takes the first message only.
- `dsh-session-title-llm/lib/index.js:114-122` — route resolution from the explicit pair or logged request header.
- `dsh-session-title-llm/lib/index.js:160-227` — input cap, timeout, logging, stream assembly.
- `dsh-session-format-v3-to-v4/lib/index.js:836-845` — title events must cite human `user/message` sources.
- `dsh-base/cordis.patch.yml:60-77` — stock title service and first-prompt config (5 words/40 bytes, 80-byte max, 4 KB input, 4096 output, 60 s).
- `dsh-experimental-session-titles-bundle/cordis.patch.yml:1-12` — optional all-prompts bundle; off by default; 64 output tokens.
- `dsh-client-ui-workspace/lib/client.js:998-1000` — `session.title`.
- `dsh-client-ui-workspace/lib/client.js:2026-2029` — “Untitled” display fallback.
- `dsh-client-ui-workspace/lib/client.js:964-966` — subagent sessions are not sidebar rows.
- `dsh-client-ui-workspace/README.md:32` — history rows without a stored title use the localized unnamed label.
- `dsh-client-ui-workspace/lib/client.js:72-84`, `:154-162` — sidebar rename action.
- `dsh-client-ui-chat/lib/client.js:11961-11993` — human vs context message presentation.
- `dsh-client-ui-chat/lib/client.js:3563`, `:11875` — inbox/steering treats `source.kind === "user"` as human.
- `dsh-api-session-controller/lib/index.js:729-748` — host rename route.
- `dsh-schedule/lib/index.js:1519-1529` — host precedent: rename a created session with its task title.
- `dsh-agent/lib/types/index.d.ts:49-72` — `CreateAgentOptions` has no title field.

---

## Verification status

- This document is a plan. I did not implement it, did not run the product, did not run tests, and did not run git commands.
- The installed dsh package is a built library; the line numbers above refer to that build and may drift when the package is updated.
- The exact money cost of the model-title alternative depends on the provider/model; no dollar figure is asserted.
- The manual sidebar check is proposed, not performed.
- No reference-folder code, prompts, identifiers, or text was used.
