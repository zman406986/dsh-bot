# Research: dsh host API surface for the adapter (ticket 09) and permission/secret relay (ticket 13)

- Question: What exact host APIs does the dsh adapter need to implement `DshHost` (spawn / interrupt / settle / wake), plus the permission/secret seams for ticket 13, flag/session-start patterns for ticket 12, and peer-messaging prep for ticket 14?
- Scope: local dsh **0.1.5-rc.1** install under `C:\Users\TZ\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*` (MIT; free to imitate). Existing research notes read only. Forbidden reference tree never opened.
- Method: read shipped `.d.ts` / README / package types for `dsh-subagent`, `dsh-jobs`, `dsh-agent`, `dsh-session`, `dsh-tools`, `dsh-user-approval`, `dsh-credentials`, `dsh-permission-presets`, `dsh-tool-todo`, `dsh-tool-subagent-control`, `dsh-storage`; cross-checked the in-repo `DshHost` interface and PRD §9 sketch; official jobs page for the jobs catalog wording.
- Date: 2026-09-16

## Verdict

Every `DshHost` method maps onto a first-party dsh seam with a precise typed call. The natural worker primitive is **continuable subagents** (`ctx.subagents.startContinuable` / `sendMessage` / `interrupt`), not one-shot `start`, because PRD steer (S3) needs a durable child that can be steered mid-run without restart. Completion wake is available two ways: the native **settlement notice** that dsh delivers into the parent agent's turn when a continuable child settles, or an explicit `jobs.onJobDone` + `Agent.followup` pairing. Approval/credentials/presets already ship as services — ticket 13 is glue over them, not new machinery. Gaps remain around (a) capturing the live parent `Agent` object for authority, (b) mapping our workerId ↔ `SessionId`, (c) whether workers inherit approval=`never` (dsh pins that at delegation), and (d) no first-class peer-messaging bus beyond parent/child adjacency.

## 1. Current `DshHost` contract (what the adapter must implement)

From `src/core/dsh-host.ts` (and the installed `lib/core/dsh-host.d.ts`):

```ts
interface DshHost {
  spawnWorker(prompt: string, opts: SpawnOptions): Promise<string>;
  interruptWorker(workerId: string): Promise<void>;
  onWorkerSettled(cb: (event: SettledEvent) => void): void;
  requestDispatcherWakeup(sessionId: string): Promise<void>;
}
```

`SpawnOptions` = `{ parentSessionId, streamKey, title }`. `SettledEvent` = `{ workerId, status: completed|error|aborted, report: string }`.

## 2. Spawn — `ctx.subagents` (`@deepseek-ai/dsh-subagent`)

Service: `ctx.subagents: SubagentRuntime`. Two shapes:

### One-shot (probably wrong for Workers)

```ts
start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
```

- `SubagentStartRequest`: `{ label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`
- `SubagentRun`: `{ id: SessionId, localAgent?: Agent, result: Promise<SubagentResult>, dispose(): Promise<void> }`
- `SubagentResult`: `{ output: ContentBlock[], structured?, diagnostic?, stopReason: completed|aborted|error|max-tokens|refusal }`

One-shot settles once with a final result. There is no later steer channel. **Not the PRD Worker shape.**

### Continuable (the Worker fit)

```ts
startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
```

- `ContinuableStartSpec`:
  - `provider: string` — registered provider name (in-process spawn default: `"spawn"`)
  - `label: string` — durable creation label (maps to our `title`)
  - `childId?: SessionId` — optional caller-reserved identity (useful if we want to pre-provision WorkerRecord)
  - `request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>` — so `{ prompt, parent, signal, agentOptions?, maxDepth?, toolFilter?, persona? }`
  - `signal: AbortSignal` — owns only until inbox acceptance
- `ContinuableStart`: `{ childId: SessionId, messageId: MessageId }` — resolves when the child's inbox accepts the initial prompt, **not** when the turn finishes.

Continuable children are blank by default (`inheritsParentContext` is false on the in-process spawn provider; the `subagent` tool's own description says the child does not see the parent conversation). That matches PRD Worker "blank context".

### Tool scoping (S5 — workers cannot address the user)

`SubagentStartRequest.toolFilter?: ToolRestriction` where `ToolRestriction = { allow?: string[]; deny?: string[] }` (`@deepseek-ai/dsh-tools`). In-process providers apply it as a scoped `tools.restrict()`: named tools vanish from the child's prompt AND refuse to execute. Deny the user-facing tools (`present`, `ask_user_question`, and any `send_message`/`interrupt_agent` if loaded into children) so S5 holds.

### Provider registration (for the multitask profile)

Minimal composition (from `dsh-subagent` README):

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'   # model-facing; dispatcher may omit if it spawns only via adapter
  config:
    provider: spawn
    toolName: subagent
```

If the dispatcher spawns workers only through the adapter (not through a model-facing `subagent` tool), load the service + spawn provider and skip `dsh-tool-subagent`. Load `dsh-tool-subagent-control` only if we want model-facing `send_message` / `interrupt_agent`; the adapter can call the service methods directly.

## 3. Steer / follow-up — parent → child

Exact live parent Agent object is required as the sender/authority.

```ts
// Model-authored adjacent message (steers nearest step if running; wakes if idle; cold-resumes absent child)
sendMessage(
  sender: Agent,
  targetId: SessionId,
  content: ContentBlock[],
  options: { signal: AbortSignal }
): Promise<MessageId>
```

Host-protocol paths exist but are private (`[deliverSubagentPrompt]`). The public path a plugin uses is `sendMessage` with the exact live parent Agent. Browser-facing `prompt(request, signal)` is a Remote surface (`SubagentPromptRequest` with `delivery: 'queue' | 'steer'`) — not the in-process plugin path.

Low-level Agent methods (same process, if we hold the child Agent):

| Method | Effect |
|---|---|
| `Agent.steer(message)` | Steer nearest step; idle driver starts a turn |
| `Agent.followup(message)` | Queue ordinary follow-up turn and wake |
| `Agent.send(message, target, wakeup)` | Route to inbox boundary, optional wake |
| `Agent.inject(message)` | Queue context without waking |
| `Agent.cancel(cause, { keepInbox? })` | Abort current turn; `keepInbox: true` preserves queued work |

For ticket 09's steer queue (last-wins), the adapter should resolve the child Agent via `ctx.agents.get(childId)` when resident and call `steer`, or call `ctx.subagents.sendMessage(parentAgent, childId, …)` which also cold-resumes.

## 4. Interrupt

```ts
interrupt(
  targetSessionId: SessionId,
  authority: SubagentInterruptAuthority
): void
```

`SubagentInterruptAuthority`:

```ts
{ kind: 'user'; parentSessionId: SessionId }
| { kind: 'ancestor'; agent: Agent }
```

Fire-and-return: cancel signal is issued before return; unclaimed inbox work, the Activation, and published descendants are preserved; claimed work is not requeued. Absent/unknown ids are accepted no-ops. Throws `SubagentError` `UNAUTHORIZED` when the authority does not own the live target.

Remote face: `interruptByParent(childSessionId, parentSessionId, mode: 'continuable')` → `SubagentInterruptReceipt { accepted: true }`.

Jobs kill (if we ever wrap a worker as a job):

```ts
ctx.jobs.kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'
```

## 5. Settle / wake

### A. Native settlement notice (preferred for continuable children)

When a resident continuable Activation settles, dsh delivers **one runtime-owned notice into the parent's own turn stream** (README "Settlement notice"): opens with `Background subagent <child-id> finished and will do no further work unless you send it more.` (or stopped / ran out of room / declined / failed), then `Its closing message:` + final assistant content, or `It left no closing message.`

This is push, not poll. Reaching an idle parent starts an independent model request; reaching a busy parent does not inject mid-turn (matches the reference-behavior note: completion is a queued background wake).

Lifecycle events (both shapes):

```
'subagent/start' (info: SubagentRunInfo)   // { runId, provider, id: SessionId, local }
'subagent/end'   (info: SubagentRunEndInfo) // + stopReason, lastAssistantMessage?
```

Scope-filtered by the delegating parent. A plugin can `ctx.on('subagent/end', …)` under the dispatcher's scope.

### B. Jobs completion listener (if we also register a Job)

```ts
ctx.jobs.onJobDone(listener: (snapshot: JobSnapshot, owner: Agent | undefined) => void | PromiseLike<void>): () => void
```

`JobSnapshot`: `{ id, kind, label, ownerSession?, status: running|stopping|completed|killed|failed, detail?, startedAt, finishedAt?, reported }`. First-wins settlement; completion announced last after the record is committed, specifically so a reporter may open a model turn synchronously.

### C. Explicit wake of the dispatcher

To implement `requestDispatcherWakeup(sessionId)`:

```ts
const agent = ctx.agents.get(sessionId);
agent?.followup(userMessage);  // opens a turn
// or agent?.send(msg, 'next-turn', true)
```

`Agent.followup` is "queue an ordinary follow-up turn and wake the driver". For a host-authored wake (not model-authored), this is the right primitive. Build a short `UserMessage` with a wake cue (new copy; do not reuse reference wording).

**Recommendation for the adapter:** rely primarily on (A) + (C). The settlement notice already wakes an idle dispatcher; if the dispatcher is mid-turn, the notice waits. Map `onWorkerSettled` to either the `subagent/end` event or the settlement-notice observation, and map `requestDispatcherWakeup` to `followup` on the dispatcher Agent.

## 6. Jobs registry (optional but useful)

`ctx.jobs: JobRegistry` (abstract; local provider `@deepseek-ai/dsh-jobs-local`).

```ts
start(spec: JobStart): JobId
list(caller?: Agent): JobSnapshot[]
get(id, caller?): JobSnapshot
read(id, caller?): JobRead
kill(id, caller?, reason?): 'requested' | 'already-finished'
wait(id, timeoutMs, caller?, signal?): Promise<JobSnapshot>
onJobDone(listener): () => void
onJobsChanged(listener): () => void
attachController(name: string): () => void   // required: start refuses owners no controller serves
```

`JobStart = { kind, label, outputLimitBytes?, owner?: Agent, run(): JobHooks }`. Kinds are merge-extensible (`bash`, `subagent` shipped). Plugin can declare its own kind via declaration merging.

**Important:** `start` refuses work while no attached job controller serves the owner. The adapter must `ctx.jobs.attachController('multitask-dispatcher')` (effect-scoped) before starting owned jobs.

Jobs are **process-local** (not durable across restart). For durable WorkerRecords use continuable child sessions or `ctx.storageDomain` (ADR-0006).

## 7. Todo

Session event + projection, not a service API:

```ts
// Event (whole-list replacement, last-write-wins)
'todo/write': { todos: TodoItem[] }

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
```

Multiple `in_progress` allowed by design. No `cancelled` status — drop items from the replaced list. UI reads the `todos` session projection. Model-facing tool is `@deepseek-ai/dsh-tool-todo` (`todo_write`).

For the dispatcher's own todo list, append `todo/write` on the dispatcher session via `session.append('todo/write', { todos }, /* surface metadata: log-only */)`. Confirm the exact `append` surface-op requirement in ticket 09 (todo/write is log-only, never model history).

## 8. User delivery / ask

- Dispatcher delivers to the user in its own turns (it is the primary chat agent). No extra send API.
- `ctx.userQuestions` + `ask_user_question` for structured questions.
- `present` tool for file deliverables.
- Workers: no user-messaging tool by default; enforce via `toolFilter`.

## 9. Permission / secret relay (ticket 13)

### Approval — `ctx.approval` (`@deepseek-ai/dsh-user-approval`)

```ts
class ApprovalService extends Service {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>
  setPolicy(agent: Agent, policy: 'ask' | 'never'): void
  overrideOf(session: Session): ApprovalPolicy | undefined
}

interface ApprovalRequest {
  agent: Agent;              // on whose behalf
  toolName: string;
  callId?: ToolCallId;
  reason?: string;
  signal?: AbortSignal;
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type ApprovalPolicy = 'ask' | 'never'   // default 'ask'; missing answerers fail closed to 'unavailable'
```

Answerer waterfall event (plugin can participate):

```
'approval/request'(req: ApprovalRequestEvent, next): Promise<ApprovalOutcome>
```

Session events (audit, log-only): `approval/asked` / `approval/decided`.

**Delegation pin:** `captureDelegatedPolicyOverrides` pins a child's approval policy to **`'never'`** whenever the approval capability is composed — "a delegated child acts only within the sandbox scope fixed at delegation, so its asks are rejected deterministically" (`dsh-subagent/child-agent.d.ts`). So workers spawned as dsh subagents will **not** get interactive approval. Ticket 13's "worker asks → dispatcher asks user → answer steered back" must therefore either:

1. Override the child's `approval/policy` after start (append a later `approval/policy` event on the child session; later switches win over the delegation seed), then relay asks via the waterfall / events; or
2. Not use dsh's approval for workers at all — define our own structured ask tool on the worker and relay it through the dispatcher (closer to the gaps-note recommendation); or
3. Keep workers at `never` and pre-approve everything they need via scoped credential injection + tight `toolFilter`.

This is the biggest design fork ticket 13 will hit. dsh's seams support (1) and (2).

### Credentials — `ctx.credentials` (`@deepseek-ai/dsh-credentials`)

```ts
credentialRef(envName: string): CredentialRef          // env-var name brand
credentialKey(scope, id): CredentialKey                 // `<scope>/<id>` record address

abstract class CredentialProvider extends Service {
  resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>
  describe(ref): Promise<CredentialInfo>                 // configured/source/writable — never the value
  set(ref, value): Promise<void>
  unset(ref): Promise<void>
  readRecord(key): Promise<CredentialRecord | undefined>
  describeRecord(key): Promise<CredentialRecordInfo>
  listRecords(): Promise<readonly CredentialRecordEntry[]>
  modifyRecord(key, mutate): Promise<CredentialRecord | undefined>
  deleteRecord(key): Promise<void>
}

type CredentialRecord = ApiKeyRecord | GrantRecord
// ApiKeyRecord: { kind: 'api-key'; key?: string; env?: Record<string,string> }
// GrantRecord:  { kind: 'grant'; payload: unknown }   // owner-defined JSON, opaque to the seam
```

Resolution is **per operation** — do not cache across operations. Template plugin (`dsh-web-search-exa`) pattern: `ctx.get('credentials')` → `credentials.resolve(credentialRef(apiKeyEnv))`, fall back to launch environment.

**Scoped injection to workers:** dsh does not ship a "inject this secret into that child" API. Options: (a) resolve at spawn time and put the value in the child's initial prompt (weak — lands in transcript; avoid for real secrets); (b) resolve inside the worker via its own scoped `ctx.credentials` (children share the process credentials service); (c) use a `GrantRecord` under our plugin scope and a small worker-side tool that reads it. Prefer (b)/(c). Never put secret values in tool names, labels, or telemetry.

### Permission presets — `ctx.permissionPresets` (`@deepseek-ai/dsh-permission-presets`)

```ts
class PermissionPresetService extends Service {
  get names(): readonly string[]
  get defaultPreset(): string
  current(session: Session): string          // table key or 'custom'
  resolve(name: string): PresetSpec
  set(session: Session, name: string): void  // logs permission/preset + writes knobs
}

interface PresetSpec {
  sandbox: SandboxMode
  approval: ApprovalPolicy
  name?: string
  description?: string
}
```

Defaults: `workspace-write` (workspace-write + ask) and `danger-full-access` (danger-full-access + never). Session events: `permission/preset`, `sandbox/mode`, `approval/policy`. Projection key: `permissions`.

For the multitask profile, configure a preset table (or `defaultPreset`) that matches Worker policy — e.g. workers stay under the parent's sandbox override + approval `never` (already how delegation seeds them).

## 10. Flag / session-start config (ticket 12 prep)

ADR-0005: flag is **session-scoped**, read once at dispatcher-session start.

Patterns available:

1. **Plugin `Config` (schemastery)** — `const Config = z.object({ enabled: z.boolean(), … })`; `apply(ctx, config)`. Read `config.enabled` once when the dispatcher session starts; do not observe mid-session changes. Profile default goes in the multitask profile's `cordis.patch.yml` insert row.
2. **Settings section** — `installSettingsSection(ctx, settingsNamespace('multitask-dispatcher'), Config, config, { setSource, onChange })` from `@deepseek-ai/dsh-settings` (template plugin does this). Gives a live UI control for *future* sessions.
3. **Session-start hook** — event `'agent/session-start'` `(payload: { agent, source: 'startup'|'resume'|'clear'|'compact' })`. First startup-driving extension point; `agent/created` is composition-only. Read the flag here and freeze it on the dispatcher instance.
4. **Approval/sandbox knobs** — `setApprovalPolicy(session, policy)` and the permission-preset `set` path show the durable-log override idiom (last event wins; `source: 'delegation'` marks seeds). A feature flag need not be a session event if plugin Config + settings suffice.

Recommended: Config default `true` in the multitask profile patch row; `false` elsewhere; settings section for the UI toggle; freeze on `agent/session-start` of the dispatcher agent.

## 11. Peer messaging (ticket 14 prep)

There is **no first-class multi-bot peer bus** in the shipped packages. What exists:

- **Parent/child adjacency only** for `sendMessage`: exact live sender → direct continuable child, or resident child → direct parent. Sibling-to-sibling is not a public path.
- Model-facing `send_message` / `interrupt_agent` / `list_agents` (`dsh-tool-subagent-control`) are thin adapters over the same adjacency-restricted service methods.
- Experimental `dsh-experimental-tool-agent-team` was cited in public docs (`spawn_teammate`, team task board, team-scoped messaging) but **is not present in this install** (no `dsh-experimental*` packages under the local `node_modules`). Do not depend on it.
- Webhook packages exist (`dsh-webhook`, `dsh-webhook-github`) — external wake sources, not peer chat.

For Phase-2 peers, expect to build a plugin-owned inbox (KV in `ctx.storageDomain` or session events) plus a wake path via `Agent.followup` on the receiving dispatcher. That is new machinery, not glue.

## 12. Durable WorkerRecord (ADR-0006)

Two candidate homes:

1. **Continuable child session itself** — dsh persists child sessions, enumerates via `ctx.subagents.listChildren(parentSessionId)` / `listDescendants`, cold-resumes. The `subagent/descriptor` event (version 3) records provider, mode, label, agentOptions, persona, toolFilter. Status can be derived from activity (`running`/`inactive`) + stop reason.
2. **`ctx.storage` / `ctx.storageDomain`** — typed KV + zod-schema'd versioned tables. Use for the minimum-to-reconstruct record (workerId, transcript pointer = child SessionId, todo link, status) if we need fields dsh does not persist.

`listChildren` returns `SubagentListEntry` rows: `{ kind: 'child', id, activity: 'running'|'inactive', hasChildren, mode: 'one-shot'|'continuable', label? }` or diagnostic rows. This is the natural roster rebuild after restart.

## 13. How to implement `DshHost` (sketch only)

```ts
// Adapter holds a reference to the live dispatcher Agent and the Cordis ctx.
class CordisDshHost implements DshHost {
  constructor(private ctx: Context, private parent: Agent) {}

  async spawnWorker(prompt, opts) {
    const signal = new AbortController().signal;
    const { childId } = await this.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: opts.title,
      request: {
        prompt: [{ type: 'text', text: prompt }],  // confirm ContentBlock shape
        parent: this.parent,
        signal,
        toolFilter: { deny: ['present', 'ask_user_question', 'send_message', 'interrupt_agent'] },
      },
      signal,
    });
    return childId; // workerId === child SessionId
  }

  async interruptWorker(workerId) {
    this.ctx.subagents.interrupt(workerId, {
      kind: 'ancestor',
      agent: this.parent,
    });
  }

  onWorkerSettled(cb) {
    // Option A: ctx.on('subagent/end') filtered to this.parent's children
    // Option B: parse the native settlement notice (heavier)
    this.ctx.on('subagent/end', (info) => {
      cb({
        workerId: info.id,
        status: info.stopReason === 'completed' ? 'completed'
              : info.stopReason === 'aborted' ? 'aborted' : 'error',
        report: renderBlocks(info.lastAssistantMessage),
      });
    });
  }

  async requestDispatcherWakeup(sessionId) {
    const agent = this.ctx.agents.get(sessionId);
    agent?.followup(wakeUserMessage()); // new copy
  }
}
```

`inject` for the plugin will grow from `[]` to at least `['subagents', 'agents']` (and `jobs` / `approval` / `credentials` when those tickets land). Rebuild (`npm run build`) after every `inject` change — HMR reloads the module, not the TS sources (see `plugin-install-workflow.md`).

## 14. Gaps / unknowns ticket 09 will hit

| Gap | Why it bites | Next step |
|---|---|---|
| Live parent `Agent` capture | `startContinuable` / `sendMessage` / `interrupt` all need the exact live Agent, not just a SessionId string | Capture on `agent/created` or `agent/session-start` of the dispatcher; keep the object, do not re-fetch loosely |
| `ContentBlock[]` prompt shape | `SubagentStartRequest.prompt` is `ContentBlock[]` from `dsh-llm`, not a plain string | Read `dsh-llm` types for the text block discriminant before coding spawn |
| workerId ↔ SessionId | Core uses opaque `workerId: string`; dsh uses branded `SessionId` | Use the child SessionId as workerId (opaque to core) |
| Approval pin on children | Delegation seeds `approval/policy: 'never'` | Decide ticket 13 fork (override policy vs custom ask tool vs pre-approve) |
| `attachController` requirement | `ctx.jobs.start` refuses owners with no controller | If we use jobs at all, attach first |
| Steer while dispatcher mid-turn | Settlement notice does not inject mid-turn (by design) | Core's queued-wake model already assumes this; confirm last-wins steer pops on step boundary |
| `todo/write` surface metadata | `session.append` requires surface-op for message-producing events; todo is log-only | Confirm the exact append signature / surface intent for log-only events |
| Provider name | In-process spawn default is `"spawn"` | Confirm against `dsh-subagent-spawn-in-process` config in the multitask profile |
| No peer bus | Sibling messaging is not a public path | Phase 2 builds its own inbox + wake |
| Breaking-change risk | dsh is developer preview | Pin `0.1.5-rc.1`; re-verify at integration |

## 15. Citation index (primary sources)

| Topic | Path |
|---|---|
| SubagentRuntime | `.../dsh-subagent/lib/types/index.d.ts` |
| Start/continuable types | `.../dsh-subagent/lib/types/types.d.ts` |
| Continuation manager | `.../dsh-subagent/lib/types/continuation.d.ts` |
| Child composition / approval pin | `.../dsh-subagent/lib/types/child-agent.d.ts` |
| Descriptor v3 | `.../dsh-subagent/lib/types/descriptor.d.ts` |
| Agent steer/followup/inject/cancel | `.../dsh-agent/lib/types/runtime-types.d.ts` |
| AgentRegistry create/resume | `.../dsh-agent/lib/types/index.d.ts` |
| JobRegistry | `.../dsh-jobs/lib/types/index.d.ts` + `types.d.ts` |
| ApprovalService | `.../dsh-user-approval/lib/types/index.d.ts` |
| CredentialProvider | `.../dsh-credentials/lib/types/index.d.ts` |
| PermissionPresetService | `.../dsh-permission-presets/lib/types/index.d.ts` |
| TodoItem / todo/write | `.../dsh-tool-todo/lib/types/types.d.ts` |
| ToolRuntime register/restrict | `.../dsh-tools/lib/types/index.d.ts` |
| SessionStore | `.../dsh-session/lib/types/index.d.ts` |
| Storage hub | `.../dsh-storage/lib/types/index.d.ts` |
| Template plugin | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-search-exa/lib/index.js` |
| In-repo DshHost | `src/core/dsh-host.ts` |
| PRD API sketch | `PRD-dsh-multitask-dispatcher.md` §9 |
| Flag ADR | `docs/adr/0005-feature-flag-session-scoped-toggle.md` |
