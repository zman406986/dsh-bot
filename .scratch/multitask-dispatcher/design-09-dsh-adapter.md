# Design 09 — dsh adapter wiring

Ticket: `.scratch/multitask-dispatcher/issues/09-dsh-adapter-wiring.md`
Status of this note: design only — no `src/` implementation.
Blocked-by context: ticket 08 (durable roster marker) owns the durable-marker *policy*; this design supplies the real host backend and the live `DshHost` implementation. Core stays unchanged; FakeDshHost tests stay green.

---

## 0. Placement decision

Feature design note, not a research finding. Lives at:

```
.scratch/multitask-dispatcher/design-09-dsh-adapter.md
```

Host-capability facts stay in `docs/research/dsh-adapter-api-notes.md` (§14 gaps referenced below). This note *uses* those facts and the installed 0.1.5-rc.1 `.d.ts` tree; it does not restate research as a new finding.

---

## 1. Scope and non-goals

### In scope (ticket 09 AC)

| AC | What this design delivers |
|---|---|
| Real spawn / interrupt / settle / wake | `CordisDshHost implements DshHost` over `ctx.subagents` + `ctx.agents` |
| Durable marker via session/storage | Adapter-side marker store over `ctx.storageDomain` (backend for T08 policy) |
| Live job status non-durable | `listLiveJobs()` reading `ctx.jobs.list()`; workers are **not** jobs |
| Core unchanged | Zero edits under `src/core/`; `DshHost` interface untouched |
| Fake-host tests green | Existing suite keeps using `FakeDshHost`; adapter has its own stubbed-ctx tests |

### Out of scope

- Worker agent definition / tool barrier copy (ticket 10) — adapter accepts optional `WorkerAgentDef` via constructor; ships a minimal deny default until T10 lands.
- Dispatcher model-facing tools and policy prompts (ticket 11).
- Permission/secret relay (ticket 13). Approval pin documented as residual risk only.
- Peer inbox (ticket 14). No sibling bus in dsh; not built here.
- Feature-flag UI (ticket 12). Adapter only honours `config.enabled` already read in `apply`.
- Second transcript DB, Sand/reconstruction identifiers, reference-tree copy.

---

## 2. Cordis services, `inject`, and `apply()` wiring

### 2.1 Exact inject list

```ts
// src/plugin.ts
export const inject: string[] = [
  "subagents",     // ctx.subagents — spawn / interrupt / sendMessage / listChildren
  "agents",        // ctx.agents    — live Agent registry (wake via followup)
  "jobs",          // ctx.jobs      — live job listing for the check surface
  "storageDomain", // ctx.storageDomain — durable worker markers (ADR-0006)
];
```

Notes:

- Keys are the Cordis service property names (same pattern as `dsh-web-search-exa`'s `inject = ["web"]`).
- `sessions` is **not** required in v1: parent capture uses `agent/session-start` payloads; markers use `storageDomain`; child sessions are addressed by `SessionId` returned from `startContinuable`.
- Multitask profile must already mount: `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-subagent-spawn-in-process` (provider name default `"spawn"`), `@deepseek-ai/dsh-jobs` + a local jobs provider, and `@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-domain` + a backend (json or sqlite). Document these rows in the profile `cordis.patch.yml` when installing (see `docs/research/plugin-install-workflow.md`).
- **Rebuild after every `inject` change** (`npm run build`) — HMR reloads `lib/`, not TS sources.

### 2.2 `apply()` wiring (scaffold → live)

```ts
// src/plugin.ts (shape only — implementer fills types)
export function apply(ctx: PluginContext, config: PluginConfig): void {
  if (!config.enabled) return;

  const host = createCordisDshHost(ctx, {
    // T10 will pass a real WorkerAgentDef; T09 uses the adapter's minimal default.
  });
  const multitask = createMultitask(host); // core — unchanged

  // Capture the live dispatcher Agent + bind session-id turn bounds to wakeBus.
  const unbind = bindDispatcherLifecycle(ctx, host, multitask);

  ctx.effect(() => () => {
    unbind();
    host.dispose();
  });
}
```

`PluginContext` must expose at least: `effect`, `on`, `subagents`, `agents`, `jobs`, `storageDomain`. Prefer a narrow local interface (as the scaffold already does) over importing full Cordis types until peerDeps grow.

### 2.3 Required profile composition (install-time, not code)

From research + installed packages:

```yaml
# ~/.dsh/profiles/multitask/cordis.patch.yml (illustrative)
- insert:
    - id: multitask-dispatcher
      name: dsh-multitask-dispatcher
      config:
        enabled: true
# Subagent service + in-process spawn provider must already be in the bundle
# stack (dsh-base). Confirm with a dump-config before claiming AC "real spawn".
```

If `dsh-base` does not already load `dsh-subagent` + `dsh-subagent-spawn-in-process`, add those insert rows. Provider name is `"spawn"` (`providerName` default in `dsh-subagent-spawn-in-process`).

---

## 3. Method-by-method `DshHost` mapping

Current interface (`src/core/dsh-host.ts`) — **do not change**:

```ts
interface DshHost {
  spawnWorker(prompt: string, opts: SpawnOptions): Promise<string>;
  interruptWorker(workerId: string): Promise<void>;
  sendMessage(workerId: string, message: string): Promise<void>;
  onWorkerSettled(cb: (event: SettledEvent) => void): void;
  onStepBoundary(cb: (workerId: string) => void | Promise<void>): void;
  requestDispatcherWakeup(sessionId: string): Promise<void>;
}
```

### 3.1 `spawnWorker`

```
host.spawnWorker(prompt, { parentSessionId, streamKey, title })
  → ctx.subagents.startContinuable({
      provider: "spawn",
      label: title,                         // durable creation label
      request: {
        prompt: [{ type: "text", text: assembled }],
        parent: this.parentAgent,           // exact live Agent (§4)
        signal: spawnSignal,                // AbortController; owns only until inbox acceptance
        toolFilter: this.resolveToolFilter(), // T10 injects; T09 minimal deny default
        maxDepth: 0,                        // leaf: never spawn descendants
      },
      signal: spawnSignal,
    })
  → String(childId)                         // workerId === child SessionId
```

- Resolves when the child's **inbox accepts** the initial prompt — not when the turn finishes. That is the non-blocking spawn the AC wants.
- `assembled` = optional worker system section (T10) + task prompt. Until T10, pass the core prompt through unchanged (or a one-line adapter header). Prefer constructor-injected `WorkerAgentDef.buildPrompt(prompt)` when present.
- Minimal deny default until T10 (adapter-private constant, not core):
  `["present", "ask_user_question", "send_message", "interrupt_agent", "subagent"]`
  — only names that exist as globals should be sent (intersect with `ctx.tools` if available; otherwise omit filter and let T10 own the barrier). **Prefer omitting `toolFilter` in T09** rather than risking `tools.restrict()` throw on unknown names. T10 owns the intersection rule.
- `transcriptRef` for the roster can be set later from settle (`info.id`); do not invent paths.

### 3.2 `interruptWorker`

```
host.interruptWorker(workerId)
  → ctx.subagents.interrupt(SessionId(workerId), {
      kind: "ancestor",
      agent: this.parentAgent,
    })
```

- Fire-and-return: cancel signal issued before return. Matches core's "mark aborted, then interrupt" order.
- Unknown / already-settled ids are accepted no-ops on the host side; core already refuses `abortWorker` on terminal workers.
- Do **not** use `jobs.kill` for workers — workers are subagents, not jobs.

### 3.3 `sendMessage` (steer delivery)

```
host.sendMessage(workerId, message)
  → ctx.subagents.sendMessage(
      this.parentAgent,
      SessionId(workerId),
      [{ type: "text", text: message }],
      { signal: deliverySignal },
    )
```

- Context-preserving: does not spawn or restart. Cold-resumes an absent child if needed (host behavior).
- Core only calls this from the step-boundary handler after parking a last-wins steer (see `multitask.ts`).
- Alternative when the child is resident: `ctx.agents.get(workerId)?.steer(userMessage)`. Prefer `subagents.sendMessage` — one path, works cold, adjacency-checked.

### 3.4 `onWorkerSettled`

Primary path: **`ctx.on("subagent/end", …)`**, not the native settlement notice and not `jobs.onJobDone`.

```
ctx.on("subagent/end", (info: SubagentRunEndInfo) => {
  if (!this.owns(info.id)) return;          // only our spawned workers
  cb({
    workerId: String(info.id),
    status: mapStopReason(info.stopReason),
    report: normalizeBlocks(info.lastAssistantMessage),
    transcriptRef: String(info.id),
  });
});
```

`stopReason` map (from `SubagentStopReasonMap`):

| Host stopReason | Core `TerminalWorkerStatus` |
|---|---|
| `completed` | `completed` |
| `aborted` | `aborted` |
| `error` | `error` |
| `max-tokens` | `error` |
| `refusal` | `error` |

- Exactly-once is enforced by core's FSM (double settle ignored). Adapter may still filter by `owns(info.id)` so unrelated subagent children of the same process never enter the roster.
- Apply `normalizeWorkerReport` when T10 provides it; until then: join text blocks, trim; empty → short placeholder owned by the adapter (T10 replaces).
- Do **not** parse the human-readable settlement notice string. Do **not** use `jobs.onJobDone` as the settle path.

### 3.5 `onStepBoundary`

There is no first-class dsh "step-boundary" event. Map to **child `agent/status` → `idle`**:

```
ctx.on("agent/status", ({ agent, status }) => {
  const workerId = this.workerIdOf(agent.session.id);
  if (workerId === undefined) return;       // not one of our workers
  if (status === "running") {
    this.emitTurnStarted(workerId);         // optional: core noteTurnStarted via plugin
  }
  if (status === "idle") {
    for (const cb of this.stepBoundaryCallbacks) void cb(workerId);
  }
});
```

Rationale:

- `AgentStatus` is `'idle' | 'running'` (verified `dsh-agent` runtime-types).
- After `interrupt`, the child's current step unwinds and the agent converges to `idle` — that is the steer delivery point the core assumes.
- Core's handler is a no-op unless the worker is in `steering`, so extra idle events are harmless.
- Residual risk: a worker that finishes a step *without* interrupt also goes idle; core ignores those. Confirm under smoke that interrupt → idle → `sendMessage` does not race a settle that already terminal-ized the worker (core already guards this).

### 3.6 `requestDispatcherWakeup`

```
host.requestDispatcherWakeup(sessionId)
  → const agent = ctx.agents.get(SessionId(sessionId));
    agent?.followup(wakeUserMessage(sessionId));
```

- `Agent.followup` queues an ordinary follow-up turn and wakes the driver — the correct host-authored wake primitive.
- `wakeUserMessage` is **new copy** (short cue that background work is ready; no Sand wording). Build with `createUserMessage({ content: [{ type: "text", text: cue }], source: { kind: "plugin", plugin: "multitask-dispatcher" } })`. If plugin `MessageSource` requires ContextFormed fields that are awkward outside a waterfall, fall back to `{ kind: "user" }` and record the deviation in a code comment — do not block on it.
- Unknown session id: no-op (log once). Never throw into the wake bus.

### 3.7 Adapter extras (beyond `DshHost`)

These are **adapter methods**, not core interface changes:

```ts
interface CordisDshHost extends DshHost {
  bindParent(agent: Agent, sessionId: string): void;
  /** Live job snapshots for the check surface. Process-local; not durable. */
  listLiveJobs(): readonly JobSnapshot[];
  /** Durable markers (ADR-0006). See §7. */
  readonly markers: DurableMarkerStore;
  dispose(): void;
}
```

---

## 4. Live parent `Agent` capture (gap §14.1)

`startContinuable`, `subagents.sendMessage`, and `subagents.interrupt` all need the **exact live `Agent` object**, not a session-id string.

### Capture rule

```
ctx.on("agent/session-start", ({ agent, source }) => {
  // Top-level dispatcher only: no parent lineage / depth 0.
  // Multitask profile is expected to have one primary chat agent.
  if (isTopLevel(agent) && !this.parent) {
    this.bindParent(agent, String(agent.session.id));
  }
});
ctx.on("agent/disposed", ({ agent }) => {
  if (this.parent === agent) this.unbindParent();
});
```

- Prefer `agent/session-start` over `agent/created`: research + host docs mark session-start as the first startup-driving extension point; created is composition-only.
- `source` may be `startup | resume | clear | compact` — accept all; the Agent object is what matters.
- `isTopLevel`: `agent.session.header.parentSession == null && (header.delegationDepth ?? 0) === 0`. If header access is awkward, accept the first session-started agent and log a warning when a second top-level agent appears (documented residual for multi-agent profiles).
- Keep the object; never re-fetch loosely from `ctx.agents.get(id)` for authority paths (get is fine for `followup` on a known session id).

### Dispatcher session id

`parentSessionId` for the wake bus / `requestDispatcherWakeup` is `String(parentAgent.session.id)`. Core already routes settles to `record.parentSessionId` taken from `SpawnOptions`; the dispatcher tool layer (T11) must pass that same id when spawning.

---

## 5. `workerId ↔ SessionId` mapping

| Rule | Detail |
|---|---|
| Identity | `workerId = String(childId)` from `ContinuableStart`. Brand is erased at the boundary. |
| Reverse | Adapter keeps `Map<workerId, { parentSessionId, agentSessionId }>` for `owns()` and `workerIdOf()`. |
| Core | Treats `workerId` as opaque. No branded types in `src/core/`. |
| Restart | After restart, child SessionIds persist in dsh; T08 rebuild uses markers + `listChildren(parentSessionId)`. Adapter does not mint new ids on rebuild. |

No separate UUID layer. Do not prefix/rename ids — keeps T08 rebuild and `listChildren` correlation trivial.

---

## 6. `ContentBlock[]` / prompt shape

Verified from installed `dsh-llm` (`TextBlock`):

```ts
interface TextBlock {
  type: "text";
  text: string;
}
type ContentBlock = ContentBlockMap[ContentBlockType]; // includes TextBlock
```

Helpers in `src/adapter/content-blocks.ts`:

```ts
export function textBlock(text: string): ContentBlock;
export function textBlocks(text: string): ContentBlock[];      // single text block
export function blocksToText(blocks: ContentBlock[] | undefined): string;
// Concatenate type==='text' blocks with "\n\n"; ignore reasoning/tool blocks for reports.
```

| Boundary | Shape |
|---|---|
| Spawn prompt | `[{ type: "text", text: assembled }]` |
| Steer `sendMessage` | `[{ type: "text", text: message }]` |
| Settle report | `blocksToText(info.lastAssistantMessage)` then trim / placeholder |
| Wake `followup` | `UserMessage.content = [{ type: "text", text: cue }]` |

Do not send images/files in v1. Do not put secrets in prompt text (T13).

---

## 7. Approval pin on children (gap §14.4)

Verified: delegation seeds child `approval/policy: 'never'` when the approval capability is composed (`dsh-subagent` child-agent docs). Consequences for **this ticket**:

- Ticket 09 does **not** override the pin.
- Worker spawn must not promise interactive approval (T10 prompt constraint already stated in design-10).
- Ticket 13 owns the fork: (1) post-start policy override + waterfall relay, (2) custom structured ask tool, or (3) keep `never` + scoped credentials.

**Residual risk, does not block AC.** Document in code near spawn: `// approval pinned 'never' by dsh delegation; T13 owns relay.`

---

## 8. Durable markers (T08 coupling)

ADR-0006: minimum-to-reconstruct `WorkerRecord` is durable (worker id, transcript pointer, todo link, status); `SteerTicket` is not. Mechanism: obligation-marker written at spawn, one small durable record per outstanding worker.

### 8.1 Host backend

Use **`ctx.storageDomain`**, not session transcript events:

- Typed, schema-validated KV; writes durable before resolve; invisible to the model (host-only) — matches "no second transcript DB" and "not model-visible".
- Session-event markers would pollute the conversation log and require surface-op metadata (research §7/§14).

### 8.2 Domain spec (adapter-owned)

```ts
// src/adapter/durable-marker.ts
export interface DurableWorkerMarker {
  workerId: string;
  parentSessionId: string;
  streamKey: string;
  title: string;
  status: WorkerStatus;          // snapshot at write time
  transcriptRef: string | null;  // child SessionId
  todoId: string | null;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface DurableMarkerStore {
  write(marker: DurableWorkerMarker): Promise<void>;
  readByParent(parentSessionId: string): DurableWorkerMarker[];
  delete(workerId: string): Promise<void>;
}
```

Implementation sketch:

```
const domain = await ctx.storageDomain.open({
  name: "multitask-dispatcher",
  tables: {
    worker_markers: { key: z.string(), value: MarkerSchema }, // zod via schemastery if required
  },
});
```

- Key = `workerId`.
- `write` at spawn and on meaningful status snapshot updates (T08 decides cadence; adapter only provides the store).
- `delete` when a worker is fully delivered / reconciled (T08).
- `readByParent` filters `entries()` — fine at roster scale.

### 8.3 Coupling statement

| If T08 landed first… | Ticket 09 does… |
|---|---|
| T08 defined `DurableMarkerStore` + fake | Replace fake with `storageDomain` backend; keep the interface |
| T08 put durability inside core | **Do not** leave it there — move store behind adapter extras; core must not import `storageDomain` |
| T08 not yet implemented | Ticket 09 ships the store + a spawn-time write; T08 builds rebuild/reconcile on top |

Ticket 09 AC explicitly includes "durable marker reads and writes through dsh's session/storage facilities" — so the store lands here even if T08's reconciler is incomplete.

---

## 9. Live job status (non-durable)

- Workers are **continuable subagents**, not jobs. Do **not** wrap each worker in `jobs.start` in ticket 09 (duplicates lifecycle, needs `attachController`, fights settle ownership).
- Adapter injects `jobs` and exposes `listLiveJobs(): ctx.jobs.list()` for the check surface (T11).
- Job records are process-local — never treat as durable roster (matches AC and research §6).
- If T11 later needs a host-side "running work" projection beyond `WorkerRecord` + `listChildren`, it may start jobs under a `multitask-dispatcher` kind; that is not required to close 09.

Optional secondary live view (no new API): `ctx.subagents.listChildren(parentSessionId)` → `activity: running|inactive`. Useful for smoke checks; not the settle path.

---

## 10. Step-boundary + `wakeBus` session turn bounds (T06 follow-up)

Two different "turn started" notions — do not conflate:

| Call | Id | Purpose |
|---|---|---|
| `multitask.noteTurnStarted(workerId)` | worker id | Worker FSM `spawned → running` |
| `multitask.wakeBus.noteTurnStarted(sessionId)` | **dispatcher session id** | Mid-turn hold so settles queue instead of flushing |
| `multitask.wakeBus.noteTurnEnded(sessionId)` | **dispatcher session id** | Flush queued background batch via `onDeliver` → `requestDispatcherWakeup` |

### Required wiring (missing from current scaffold)

Without this, the wake bus always thinks the dispatcher is idle and never mid-turn-holds — T06 behavior is dead in production.

```ts
// In bindDispatcherLifecycle, once parent agent/session id is known:
ctx.on("agent/status", ({ agent, status }) => {
  if (String(agent.session.id) !== dispatcherSessionId) return;
  if (status === "running") multitask.wakeBus.noteTurnStarted(dispatcherSessionId);
  if (status === "idle")    multitask.wakeBus.noteTurnEnded(dispatcherSessionId);
});
```

Also:

- Worker FSM first turn: on child `agent/status === "running"`, call `multitask.noteTurnStarted(workerId)` so `spawned → running` happens on real activity (core does not auto-promote).
- Steer path stays in core: park → `steer-received` → `interruptWorker` → adapter `onStepBoundary` → core `sendMessage` → `steer-injected`.

---

## 11. File layout

```
src/adapter/
  cordis-dsh-host.ts     # CordisDshHost implements DshHost + extras
  parent-agent.ts        # bindDispatcherLifecycle: capture Agent + status wiring
  content-blocks.ts      # textBlock / blocksToText
  durable-marker.ts      # DurableMarkerStore over ctx.storageDomain
  wake-copy.ts           # wakeUserMessage() — new copy only
  index.ts               # re-exports
src/plugin.ts            # inject + apply wiring (grows from scaffold)
src/core/                # UNTOUCHED
src/worker/              # ticket 10 — not created here
```

Exports from `src/index.ts`: adapter factory + marker types when landed. Do not export Cordis types from core.

Why `src/adapter/` and not stuffing `dsh-host.ts`: core's `dsh-host.ts` is the **interface** seam; the live implementation must be importable without pulling host packages into unit tests. Matches design-10's expected path.

---

## 12. Keeping core unchanged and FakeDshHost green

| Rule | How |
|---|---|
| No `src/core/*` edits | Adapter is a new tree; `DshHost` methods already cover T03 `sendMessage` + `onStepBoundary` |
| Fake untouched | Core tests never import `src/adapter/` |
| Policy not in core | Minimal deny / wake copy / marker schema live in adapter |
| Types | `SessionId` / `Agent` / `ContentBlock` appear only in `src/adapter/` (as `unknown`-safe locals or peer types). Avoid adding `@deepseek-ai/dsh-*` to core imports. |
| package.json | May add peerDependencies on dsh packages the adapter type-imports; keep `dependencies` minimal. If adapter uses only structural types + runtime `ctx`, peerDeps can stay `cordis` + add the specific packages only when typed imports are needed. Prefer structural interfaces in adapter until build forces otherwise. |

Verification gate: `npm test` (existing 66+) stays green with zero core diffs.

---

## 13. Known gaps §14 — block AC vs residual

| Gap | Blocks 09 AC? | Decision |
|---|---|---|
| Live parent `Agent` capture | **Yes** | Solved: `agent/session-start` capture (§4) |
| `ContentBlock[]` shape | **Yes** | Solved: `{ type: "text", text }` (§6) |
| workerId ↔ SessionId | **Yes** | Solved: identity (§5) |
| Provider name `"spawn"` | **Yes** if wrong | Confirmed default in installed package; profile must mount spawn-in-process |
| Settle path choice | **Yes** | `subagent/end` only; not notice parsing; not jobs |
| Step-boundary observation | **Yes** | Child `agent/status → idle` (§3.5) |
| wakeBus session turn bounds | **Yes** (T06 follow-up) | Dispatcher `agent/status` (§10) |
| Durable marker backend | **Yes** | `storageDomain` (§8) |
| Approval pin `never` | No | Residual → T13 |
| `attachController` | Only if `jobs.start` | Not starting per-worker jobs |
| Steer while dispatcher mid-turn | No | Core queued-wake already assumes host does not inject mid-turn |
| `todo/write` surface op | No | T07 |
| No peer bus | No | T14 |
| Multi-agent parent ambiguity | Residual | First top-level session-start wins; warn on second |
| dsh developer preview drift | Residual | Pin `0.1.5-rc.1`; re-verify API names at integration |
| `storageDomain` not mounted in profile | **Yes if missing** | Profile patch must mount storage stack before claiming AC |

---

## 14. Test strategy

### 14.1 Unit — fake host (existing, must stay green)

- `test/host-seam.test.ts`, stop/steer/registry/wake-bus suites: **no changes**.
- Gate: `npm test` after adapter lands.

### 14.2 Unit — adapter with stub ctx (new, no network / no LLM)

`test/adapter-cordis-dsh-host.test.ts` — hand-written stub ctx:

```ts
const stub = {
  subagents: {
    startContinuableCalls: [],
    interruptCalls: [],
    sendMessageCalls: [],
    async startContinuable(spec) { /* record; return { childId: "child-1", messageId: "m1" } */ },
    interrupt(id, authority) { /* record */ },
    async sendMessage(sender, id, content, opts) { /* record */ },
  },
  agents: { get(id) { return fakeAgent; } },
  jobs: { list() { return []; } },
  on(name, cb) { /* record listeners */ },
  storageDomain: { async open(spec) { /* in-memory table stub */ } },
  effect(dispose) { /* record */ },
};
```

Cases:

| Case | Assert |
|---|---|
| spawn | `startContinuable` called with `provider: "spawn"`, label=title, prompt one text block, returns workerId string |
| spawn without parent bound | rejects or queues — implementer picks; prefer reject with clear error |
| interrupt | authority `{ kind: "ancestor", agent }`, id = workerId |
| sendMessage | content one text block, same workerId |
| settle completed | `subagent/end` → SettledEvent status `completed`, report = joined text |
| settle aborted/error/max-tokens/refusal | status mapping table |
| settle unknown child | callback not invoked |
| step boundary | fire `agent/status` idle on worker agent → stepBoundary cb |
| dispatcher turn bounds | fire `agent/status` on dispatcher → `wakeBus.noteTurnStarted/Ended` with **session id** |
| wake | `followup` called on dispatcher agent; unknown id no-op |
| marker write/read/delete | stub storageDomain round-trip |
| inject list | `src/plugin.ts` exports expected keys (cheap snapshot) |

### 14.3 Smoke — local dsh (manual, not CI default)

Against `multitask` profile after install (`docs/research/plugin-install-workflow.md`):

1. Boot profile; confirm plugin loads (no inject-missing errors).
2. Spawn a trivial worker via core (`createMultitask(adapter).spawnWorker`) with a short task prompt.
3. Confirm a child session appears (`listChildren`) and worker status reaches running.
4. Interrupt mid-run; agent stops; step-boundary path does not throw.
5. Let a worker complete; dispatcher receives one wake (`followup`); settle enqueued once.
6. Restart process; marker store still lists the worker (T08 full behavior may be partial).
7. `listLiveJobs()` returns `[]` or host jobs without treating them durable.

Smoke is **safe to run** (local MIT host, no reference tree). Do not automate into CI until the profile bootstrap is scripted.

---

## 15. AC traceability

| AC | Design section |
|---|---|
| Real spawn starts background agent, non-blocking | §3.1 |
| Real seams: spawn, interrupt, job registry live status, session/storage marker, completion→wake | §3, §8, §9 |
| Interrupt stops the current turn | §3.2 |
| Settlement observed once → wake bus | §3.4 + core FSM (unchanged) |
| Dispatcher wakeup opens a real turn | §3.6 |
| Durable marker via session/storage | §8 |
| Live job status non-durable | §9 |
| Core unchanged; fake tests green | §12 |

---

## 16. Implementation checklist

- [ ] Add `src/adapter/{cordis-dsh-host,parent-agent,content-blocks,durable-marker,wake-copy,index}.ts`.
- [ ] Grow `src/plugin.ts`: `inject = ["subagents","agents","jobs","storageDomain"]`, wire `createCordisDshHost` + `createMultitask` + `bindDispatcherLifecycle`.
- [ ] Capture live parent Agent on `agent/session-start`; bind/unbind on dispose.
- [ ] Map spawn/interrupt/send/settle/wake per §3; ContentBlock helpers per §6.
- [ ] Wire child + dispatcher `agent/status` for step-boundary, worker FSM turn, and **wakeBus session** turn bounds (§10).
- [ ] Implement `DurableMarkerStore` over `storageDomain`; write at spawn.
- [ ] Export adapter surface from `src/index.ts`.
- [ ] Add `test/adapter-cordis-dsh-host.test.ts` per §14.2.
- [ ] Run `npm test` — existing suite untouched and green.
- [ ] Manual smoke on `multitask` profile per §14.3; record results in the issue.
- [ ] Do **not** modify `src/core/*` or `FakeDshHost`.
- [ ] No reference-tree strings; M4 clean-room grep remains deferred (S7).

---

## Citations (primary sources)

| Fact | Source |
|---|---|
| Current `DshHost` (incl. sendMessage + onStepBoundary) | `src/core/dsh-host.ts` |
| Wake bus session turn markers | `src/core/wake-bus.ts`, issue 06 notes |
| Core settle → wakeBus; step-boundary steer pop | `src/core/multitask.ts` |
| Continuable spawn / interrupt / sendMessage / listChildren | installed `dsh-subagent` types + `docs/research/dsh-adapter-api-notes.md` §2–5 |
| `subagent/end` payload + stopReason map | installed `dsh-subagent/lib/types/types.d.ts` |
| `TextBlock` `{ type: 'text', text }` | installed `dsh-llm/lib/types/types.d.ts` |
| `Agent.followup` / `steer` / `AgentStatus` | installed `dsh-agent/lib/types/runtime-types.d.ts` |
| `agent/session-start`, `agent/status` events | same |
| Provider name default `"spawn"` | installed `dsh-subagent-spawn-in-process` |
| Jobs process-local; `JobSnapshot` | installed `dsh-jobs` + research §6 |
| `storageDomain` durable non-session KV | installed `dsh-storage-domain` README + types |
| Approval pin `never` on children | research §9 + `dsh-subagent` child-agent notes |
| WorkerAgentDef constructor injection | design-10 §5 |
| Durable WorkerRecord split | ADR-0006 |
| Flag session-scoped | ADR-0005 |
| In-process TS core | ADR-0001 |
| Install workflow / rebuild after inject | `docs/research/plugin-install-workflow.md` |
