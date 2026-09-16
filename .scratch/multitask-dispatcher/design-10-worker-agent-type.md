# Design 10 — Worker agent type + tool barrier

Ticket: `.scratch/multitask-dispatcher/issues/10-worker-agent-type-and-tool-barrier.md`
Status of this note: design only — no `src/` implementation.
Blocked-by context: ticket 09 (dsh adapter wiring) owns the live `DshHost` adapter; this design plugs into that seam and must not break FakeDshHost tests.

---

## 0. Placement decision

This is a **feature design note**, not a cited research finding. Per `research/research.md` ("research = decision inputs, one file per question") and `Issue-tracker/issue-tracker.md` (`.scratch/<feature-slug>/` holds the disposable chain), this file lives at:

```
.scratch/multitask-dispatcher/design-10-worker-agent-type.md
```

Research docs (`docs/research/`) stay for host-capability facts. This note *uses* those facts; it does not restate them as research.

---

## 1. Where the agent type / tool barrier lives

### Layering rule (unchanged)

| Layer | Owns | Must not own |
|---|---|---|
| Multitask core (`src/core/`) | FSM, registry, steer queue, wake, settle report handling | Tool names, tool filters, prompt text, Cordis `ctx` |
| dsh adapter (ticket 09, expected `src/adapter/`) | Live `DshHost` implementation; spawn via `ctx.subagents.startContinuable` | Policy copy |
| Worker agent definition (**this ticket**) | Worker prompt copy, denied-tool list, empty-result placeholder | Lifecycle state machines |

### Proposed files (implementer creates these)

```
src/worker/agent-def.ts          # WorkerAgentDef: denied tools + prompt builder + placeholder
src/worker/tool-barrier.ts       # buildWorkerToolFilter(): deny-list → ToolRestriction shape
src/worker/prompt.ts             # buildWorkerSystemPrompt(): new copy only
src/worker/report.ts             # normalizeWorkerReport(): trim / empty placeholder / error passthrough
src/adapter/cordis-dsh-host.ts   # (ticket 09) calls agent-def at spawn
```

Core stays host-free. Nothing in `src/core/` imports `src/worker/` or `src/adapter/`.

### Why not a Cordis "agent type" registry

dsh does not ship a named "agent type" catalog the way the PRD's wording suggests. The real primitive is:

- a **continuable child session** started by `ctx.subagents.startContinuable({ provider: "spawn", … })`
- with `request.toolFilter` (a `ToolRestriction`)
- and `request.prompt` (the self-contained worker instruction)

So "worker agent type" = **a composition of (prompt section + toolFilter + blank-context spawn path)**, shipped as our own module and applied on every spawn. There is no separate host-side agent-type object to register.

Blank context is free with the in-process spawn provider (`inheritsParentContext` is false; the child does not see the parent conversation). We do not pass dispatcher memory, sibling transcripts, or user chat.

---

## 2. Tool allowlist strategy (execution refuse + prompt)

### Host mechanism (verified in installed dsh 0.1.5-rc.1)

`SubagentStartRequest.toolFilter?: ToolRestriction` where

```ts
interface ToolRestriction {
  readonly allow?: readonly string[]; // keep only these
  readonly deny?: readonly string[];  // remove these
}
```

In-process providers apply it as `childCtx.tools.restrict(filter)`. That restriction:

1. **Removes the tool from the child's prompt** (model never sees it).
2. **Refuses execution** if the model somehow emits the name (`UNKNOWN_TOOL`).

That is the "prompt + execution refuse" pair the AC asks for — one host primitive, both halves. We do **not** implement a second software firewall in our plugin; we must not invent parallel deny logic that can drift.

### Deny-list, not allow-list — chosen deliberately

| Option | Verdict |
|---|---|
| **Deny-list** (`deny: [...]`) | **Chosen.** Work tools (bash, read/write/edit, web_search, web_fetch, read_image, fs-search, …) vary with the profile composition. A deny-list keeps every present and future work tool without editing our list every time a work plugin is added. Matches the reference's arrangement: work tools stay; management/user tools go. |
| Allow-list (`allow: [...]`) | Rejected: brittle. Every new work tool requires a code change; a missing name silently strips a tool the worker needs. Only use if a deployment must freeze the worker surface. |

### Deny set (concrete names from the installed host tree)

Built by `buildWorkerToolFilter(knownGlobalTools: readonly string[]): ToolRestriction`.

Categories and **stable host tool names** (all verified in installed packages under `.../@deepseek-ai/dsh/node_modules/`):

| Category | Names to deny | Source package |
|---|---|---|
| User messaging / delivery | `present`, `ask_user_question` | `dsh-tool-present`, `dsh-tool-ask-user` |
| Peer / agent messaging & mgmt | `send_message`, `interrupt_agent` | `dsh-tool-subagent-control` |
| Spawn / nested agents | `subagent`, `list_subagent_models` | `dsh-tool-subagent` |
| Worker-management / jobs | `job_list`, `job_output`, `job_kill` | `dsh-tool-jobs` |
| Todo ledger | `todo_write` | `dsh-tool-todo` |

**Critical host constraint:** `tools.restrict()` **throws** if a deny name is not a currently-known *global* tool:

```
tools.restrict() names unknown global tool(s) "…"
```

Therefore `buildWorkerToolFilter` **must intersect the candidate deny set with the host's live global tool names** before calling restrict / before putting names on `toolFilter`. Never pass a hard-coded full deny list blindly.

```ts
// shape only — implementer owns the exact signature
export function buildWorkerToolFilter(
  knownGlobalToolNames: ReadonlySet<string>,
): { deny: readonly string[] } {
  const candidates = [
    "present", "ask_user_question",
    "send_message", "interrupt_agent",
    "subagent", "list_subagent_models",
    "job_list", "job_output", "job_kill",
    "todo_write",
  ];
  const deny = candidates.filter((n) => knownGlobalToolNames.has(n));
  if (deny.length === 0) {
    // Fail loud: a composition with none of these loaded is not a worker-safe surface
    // only if *any* of the forbidden categories is actually present. Prefer logging
    // a warning and returning a deny list that still includes every known name.
  }
  return { deny };
}
```

How the adapter obtains `knownGlobalToolNames`: at spawn time, query `ctx.tools` for the registered global names visible to the child scope (ticket 09 wires the exact call). If the live API only exposes names after scope construction, build the filter inside the spawn path where the child scope exists — **do not** cache across profile reloads (HMR / profile switch).

### Nested spawn is impossible, not discouraged (AC last item)

Three independent layers, in order of strength:

1. **`subagent` is not registered on the dispatcher's composition for workers.** The multitask profile loads `dsh-subagent` + the in-process spawn provider for the *adapter's* service use. It loads `dsh-tool-subagent` (model-facing `subagent` tool) **only for the dispatcher**, if at all. Workers never get it via composition.
2. **`toolFilter.deny` includes `subagent` / `list_subagent_models`** when those names are global — execution refuse + prompt removal.
3. **Worker prompt copy** states it is a leaf and has no spawn capability (see §3). Prompt alone is never the barrier.

`maxDepth` on `SubagentStartRequest` is a further host backstop; set `maxDepth: 0` (or the host's "no children" value — confirm exact semantics at ticket 09 integration) so even a mis-composed child cannot delegate.

### What is NOT denied (work tools)

Keep, unless a deployment deliberately tightens:

- `bash`, `read`, `write`, `edit`, `read_image`
- `web_search`, `web_fetch`
- fs-search / str-replace-editor equivalents if present
- bash-persistent / pwsh tools if the profile ships them

Read-only worker variants (optional later): swap the deny list for an allow-list of read/search tools. Not required by this AC.

### Prompt half of the barrier

The worker system prompt (§3) *states* the absence of user/peer/spawn/todo tools. That is guidance for the model so it does not waste turns trying. Enforcement is the toolFilter. Spec testing rule still applies: unit tests assert assembly order/presence of prompt **sections**, not full wording (see §7).

---

## 3. Worker prompt copy outline (new copy only)

Module: `src/worker/prompt.ts` — `buildWorkerSystemPrompt(): string` (no arguments needed for v1; later may accept a locale).

**All copy is new.** No reference-tree strings, no dsh prompt text, no reconstruction identifiers.

### Required sections (order matters)

1. **Role**
   - You are a delegated worker on a single task.
   - You were spawned by a parent agent to complete one job; you are not the user's chat assistant.

2. **Autonomy / no follow-ups**
   - Complete the task without asking the user or the parent questions.
   - If information is missing, make a reasonable assumption, state it in the final answer, and continue. Never wait for a reply.

3. **No user / peer contact (structural)**
   - You have no way to message the user.
   - You have no way to message other agents.
   - Do not attempt to spawn helpers or other agents; you are a leaf.
   - Your only channel back is your final answer.

4. **Todo ledger (ADR-0007)**
   - You do not maintain a todo list for this work.
   - Progress is communicated only through your final answer (and tool side effects on disk).

5. **Work style**
   - Use the available work tools (shell, files, search, web) as needed.
   - Prefer finishing over polishing. Stay on the given task; do not expand scope.

6. **Final answer contract (AC: final text = stream report)**
   - End with a concise plain-text final answer.
   - That text is the stream's report and is delivered to the parent (and often the user) essentially verbatim.
   - Lead with the concrete outcome, not a preamble.
   - If the task failed, say what failed and why in the same final text — do not hide errors.
   - Do not wrap the answer in markdown fences or tool-call-shaped JSON unless the task asked for a format.

### Explicit non-content

- No dispatcher policy (spawn/steer/todo reconcile) — that is ticket 11.
- No wake/steer internals.
- No host jargon (Cordis, ContinuableStart, toolFilter, …).

### Steer wrapper (already in core)

`wrapParentCorrection` in `src/core/steer-queue.ts` already wraps a mid-run steer as a parent-correction note ("fold it in, continue, do not restart"). Worker prompt does **not** need a steer section; the wrapper arrives as a user-role/host message. Leave it as-is.

---

## 4. Empty-result placeholder

Module: `src/worker/report.ts`.

```ts
export const EMPTY_WORKER_REPORT_PLACEHOLDER =
  "(no text output — the worker finished without a final answer)";

/** Trim; empty/whitespace-only → placeholder; non-empty → trimmed text. */
export function normalizeWorkerReport(raw: string | undefined | null): string;

/** Error outcomes: pass the error message; never replace with the empty placeholder. */
export function normalizeWorkerErrorReport(message: string | undefined | null): string;
```

Rules (match reference behavior notes §7, new copy):

| Input | Output |
|---|---|
| Non-empty text | `raw.trim()` |
| Empty / whitespace / undefined | `EMPTY_WORKER_REPORT_PLACEHOLDER` |
| Error outcome with message | `message.trim()` (or a short "worker error: …" wrapper if empty message) |
| Aborted | **No report delivered** — core already drops late settles after abort; adapter must not invent a report |

Placeholder wording is new copy. Do not copy the reference's placeholder string.

### Where normalization runs

**Adapter settle path (ticket 09), not core.**

Core's `SettledEvent.report` is already the delivered string. Normalization belongs next to the host's `subagent/end` → `SettledEvent` mapping so every consumer of the host event sees a consistent report. Core remains policy-free about wording.

Optional belt-and-suspenders: core could also treat `report === ""` as placeholder, but that duplicates policy. Prefer one place (adapter). Document the choice in the ticket 09 PR.

---

## 5. Plugging into DshHost / adapter without breaking FakeDshHost

### Current seam (do not break)

```ts
// src/core/dsh-host.ts
interface DshHost {
  spawnWorker(prompt: string, opts: SpawnOptions): Promise<string>;
  interruptWorker(workerId: string): Promise<void>;
  sendMessage(workerId: string, message: string): Promise<void>;
  onWorkerSettled(cb: (event: SettledEvent) => void): void;
  onStepBoundary(cb: (workerId: string) => void | Promise<void>): void;
  requestDispatcherWakeup(sessionId: string): Promise<void>;
}
```

`FakeDshHost` records calls and fires events. Existing tests (`test/host-seam.test.ts`, stop/steer/registry) assert against it.

### Integration rule

**The worker agent definition is an input to the adapter, not a change to `DshHost`.**

Options (pick one at ticket 09; both keep FakeDshHost untouched):

| Option | Shape | FakeDshHost impact |
|---|---|---|
| **A. Constructor injection (preferred)** | `createCordisDshHost(ctx, parentAgent, workerAgentDef)` where `WorkerAgentDef` supplies `{ systemPrompt, toolFilter, maxDepth }`. Adapter concatenates `systemPrompt + "\n\n" + request.prompt` and sets `toolFilter` on every `startContinuable`. | None. Fake does not implement the Cordis adapter. |
| B. Adapter-internal default | Adapter imports `defaultWorkerAgentDef` directly. | None, but harder to test the adapter with a stub def. |
| C. Extend `SpawnOptions` with `agentDef` | Would force core to know about tool filters. | Breaks "core is policy-free" and forces Fake + all tests to carry the field. **Reject.** |

Choose **A**.

### Spawn path (adapter sketch — ticket 09 owns the real code)

```ts
async spawnWorker(prompt, opts) {
  const system = this.workerAgentDef.systemPrompt;          // §3 copy
  const toolFilter = this.workerAgentDef.resolveToolFilter(knownGlobals); // §2
  const { childId } = await this.ctx.subagents.startContinuable({
    provider: "spawn",
    label: opts.title,
    request: {
      prompt: [{ type: "text", text: `${system}\n\n---\n\nTask:\n${prompt}` }],
      parent: this.parentAgent,           // exact live Agent (ticket 09 gap)
      signal,
      toolFilter,
      maxDepth: 0,                        // leaf: never spawn
      // persona: optional later
    },
    signal,
  });
  return childId; // workerId === child SessionId (opaque to core)
}
```

Settle mapping (ticket 09) applies `normalizeWorkerReport` / error passthrough before calling the core's settle path / `onWorkerSettled` subscribers.

### What FakeDshHost needs

**Nothing new for this ticket.** Optional later (not required by AC):

- A test-only `spawnCalls[i].toolFilter` field if adapter unit tests share the SpawnCall shape. Prefer keeping Fake core-facing and testing the adapter with a separate thin stub.

Core tests continue to pass: they never assert on tool filters or system prompts.

---

## 6. Interfaces / types to add

All in `src/worker/agent-def.ts` (and small helpers). Export from `src/index.ts` when the ticket lands.

```ts
/** Names denied on every worker spawn. Candidate list; see intersect rule. */
export const WORKER_DENIED_TOOL_CANDIDATES: readonly string[];

/** Placeholder substituted when a completed worker produced no text. */
export const EMPTY_WORKER_REPORT_PLACEHOLDER: string;

/** Host-agnostic restriction shape (mirrors dsh ToolRestriction). */
export interface WorkerToolFilter {
  readonly deny: readonly string[];
}

export interface WorkerAgentDef {
  /** Self-contained worker system prompt (new copy). */
  readonly systemPrompt: string;
  /**
   * Resolve the deny list against tools that actually exist as globals.
   * Throws or warns if a forbidden category tool is present but cannot be denied.
   */
  resolveToolFilter(knownGlobalToolNames: ReadonlySet<string>): WorkerToolFilter;
  /** Host maxDepth for leaf workers (0 / "no children"). */
  readonly maxDepth: number;
}

export function createWorkerAgentDef(): WorkerAgentDef;
export function buildWorkerToolFilter(
  knownGlobalToolNames: ReadonlySet<string>,
): WorkerToolFilter;
export function buildWorkerSystemPrompt(): string;
export function normalizeWorkerReport(raw: string | undefined | null): string;
export function normalizeWorkerErrorReport(message: string | undefined | null): string;
```

### Types deliberately NOT added

- No change to `SpawnOptions`, `SpawnRequest`, `SettledEvent`, `WorkerRecord`.
- No `DshHost` method changes.
- No core import of `WorkerAgentDef`.

`WorkerToolFilter` is a local mirror of dsh's `ToolRestriction` so core/worker modules stay free of a hard dependency on `@deepseek-ai/dsh-tools` types (package currently only peers `@deepseek-ai/cordis`). The adapter converts `WorkerToolFilter` → host `ToolRestriction` at the boundary (structurally identical: `{ deny: string[] }`).

---

## 7. Test plan (unit tests, fake host / no network / no LLM)

New file: `test/worker-agent-type.test.ts` (pattern: `node:test` + `node:assert/strict`, like existing tests).

These tests exercise **pure functions**, not Cordis. No live dsh. Existing FakeDshHost tests remain green untouched.

### 7.1 Tool barrier builder

| Case | Assert |
|---|---|
| Known set includes `todo_write`, `present`, `subagent`, `send_message` | deny contains exactly those intersected names |
| Known set includes only work tools (`bash`, `read`, `web_search`) | deny is empty (intersection); function does not invent names |
| Unknown candidate names in host | are not emitted (no throw at *our* layer) |
| `resolveToolFilter` result is JSON-serializable | `{ deny: string[] }` only |

### 7.2 Prompt assembly

| Case | Assert |
|---|---|
| `buildWorkerSystemPrompt()` | returns a non-empty string |
| Section presence | contains distinct markers for: delegated worker, no user contact, no spawn, no todo, final-answer contract (assert on **stable section headings** we introduce, e.g. `## Role`, `## Limits`, `## Final answer` — not full prose) |
| Section order | Role before Limits before Final answer (indexOf monotonic) |
| Forbidden vocabulary | does not contain reconstruction codenames (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_`) |

Do **not** assert full prompt wording equality (spec: "policy assembler tested only for presence and assembly order").

### 7.3 Report normalization

| Input | Expected |
|---|---|
| `"hello"` | `"hello"` |
| `"  padded \n"` | `"padded"` |
| `""`, `"   "`, `undefined`, `null` | `EMPTY_WORKER_REPORT_PLACEHOLDER` |
| error message `"boom"` via `normalizeWorkerErrorReport` | `"boom"` (not placeholder) |
| error empty message | non-empty wrapper (e.g. `"worker failed with no message"`) |

### 7.4 Core seam still clean

Re-run existing suite (`npm test`). No changes expected. Explicitly **do not** add tool-filter assertions to `host-seam.test.ts`.

### 7.5 Adapter integration (ticket 09, not this ticket's unit suite)

Manual/scripted against live dsh:

1. Spawn a worker; confirm child session tool list (host inspect / transcript) has no `present` / `todo_write` / `subagent` / `send_message`.
2. Ask the worker (via task prompt) to call a denied tool if it "can" — model should not have it; if it hallucinates a call, host returns `UNKNOWN_TOOL`.
3. Worker that finishes with no assistant text → parent settle report equals the placeholder.
4. Nested spawn attempt impossible: `subagent` absent + `maxDepth: 0`.

---

## 8. Risks / gaps vs live dsh

| Risk | Why it bites | Mitigation |
|---|---|---|
| **`tools.restrict()` rejects unknown names** | Hard-coded deny list throws at spawn when a plugin is not in the profile | Always intersect with live global names; see §2 |
| **Tool names are profile-dependent** | Stock `web` vs future multitask profile may load different plugins | Deny-list intersection; re-resolve per spawn (do not cache across HMR) |
| **`subagent` tool may not be global** | Model-facing tool is only registered if `dsh-tool-subagent` is composed; workers might still see it if someone adds it to the child scope | Deny when present; also never register it on worker scopes; `maxDepth: 0` |
| **Scoped registrations are exempt from restrict** | Host docs: restrictions filter inherited/global tools, not the scope's own registrations | Do not register forbidden tools on the child scope; adapter must not copy dispatcher tools into the child |
| **PTC / `run_code` transport** | `run_code` cannot be named in restrict; mode collapse could expose alternate tool surfaces | Out of scope for v1 native mode; if a profile enables PTC, re-audit (documented gap) |
| **`ask_user_question` already rejects delegated children** | Host refuses with `DELEGATED_CALLER` even if the tool is visible | Deny anyway (prompt removal + defense in depth); workers must report unresolved questions in final text (prompt §3) |
| **Approval pin `never` on children** | dsh seeds delegated children with approval `never` | Out of scope here; ticket 13 owns the relay fork. Worker prompt must not promise interactive approval |
| **Blank context vs resume** | Continuable children can be cold-resumed later; resume is *not* a blank spawn | This ticket covers initial spawn only. Resume/follow-up (PRD §6.2 optional) is a separate decision — do not silently reuse the blank-prompt path for resume |
| **Settle report shape** | `subagent/end` carries `lastAssistantMessage`; empty may be missing blocks, not `""` | Adapter normalizes ContentBlock[] → string *then* applies placeholder; confirm block rendering at ticket 09 |
| **dsh is developer preview** | Tool names and `ToolRestriction` semantics may shift | Pin `0.1.5-rc.1`; keep deny list in one module; re-verify at integration |
| **Persona / agentOptions unused** | Could later pin model/effort per worker type | Reserved; not required by AC |
| **Locale (ZH/EN prompts)** | Spec M4 mentions ZH/EN | v1 ships EN copy in `prompt.ts`; structure sections so a locale map can be added without reordering logic |

---

## 9. AC traceability

| AC | Design section |
|---|---|
| Blank context | §1 (spawn provider, no parent context) |
| Work tools only | §2 (deny-list; work tools remain) |
| No user/peer/spawn/worker-mgmt/todo (prompt + refuse) | §2 (toolFilter restrict) + §3 (prompt states absence) |
| Self-contained worker prompt | §3 |
| Final text = stream report | §3 §6 + adapter settle (§4, §5) |
| Empty → placeholder | §4 |
| Never spawns another worker | §2 (subagent denied + not composed + maxDepth 0) + §3 |

---

## 10. Implementation checklist (for the implementer)

- [ ] Add `src/worker/{agent-def,tool-barrier,prompt,report}.ts` with the types in §6.
- [ ] Export the public surface from `src/index.ts`.
- [ ] Add `test/worker-agent-type.test.ts` per §7.
- [ ] Do **not** modify `src/core/*` or `FakeDshHost` for this ticket.
- [ ] Ticket 09 wires `WorkerAgentDef` into `createCordisDshHost` via constructor injection (Option A).
- [ ] Ticket 09 applies `normalizeWorkerReport` on settle.
- [ ] Run `npm test` — existing + new green; no network.
- [ ] No reference-tree strings; grep shipped tree for reconstruction codenames remains an M4 gate (S7).

---

## Citations (primary sources)

| Fact | Source |
|---|---|
| Worker contract, blank context, leaves, no user messaging | `PRD-dsh-multitask-dispatcher.md` §6.2, §5 roles |
| Flat topology / no nested spawn | `docs/adr/0003-dispatcher-only-spawning.md` |
| Todo dispatcher-only, worker list empty | `docs/adr/0007-todo-stays-dispatcher-only-with-structural-worker-link.md` |
| Reference as inventory | `docs/adr/0004-reference-as-feature-inventory.md` |
| Reference worker toolset gating, worker prompt role, empty placeholder, verbatim result | `docs/research/reference-behavior-notes.md` §3, §4, §7 (behavior only; no copy) |
| `toolFilter` / `ToolRestriction` / `tools.restrict` unknown-name throw | installed `@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-subagent` (0.1.5-rc.1); `docs/research/dsh-adapter-api-notes.md` §2 |
| `ask_user_question` delegated-child refusal | installed `@deepseek-ai/dsh-tool-ask-user` README |
| Continuable blank child | `docs/research/dsh-adapter-api-notes.md` §2; `docs/research/dsh-extension-surface.md` Finding 3 |
| Fake host / core seam | `src/core/dsh-host.ts`, `src/core/fake-host.ts`, `test/host-seam.test.ts` |
