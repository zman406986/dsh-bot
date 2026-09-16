# Design 11 — Dispatcher tools + policy prompts

**Ticket:** `.scratch/multitask-dispatcher/issues/11-dispatcher-tools-and-policy-prompts.md`
**Status:** design-draft (not implemented)
**Blocked by / inputs:** issue 10 (worker barrier), PRD §6.1–6.4, ADR-0003/0005/0006/0007, `docs/research/reference-behavior-notes.md`, current `src/core/*` types
**Copy rule:** every string in this document and under `prompts-draft/` is **new project copy**. No reconstruction prompt text, identifiers, or tool strings.

This package is what an implementer follows. It does **not** touch `src/`.

---

## 1. Scope of this ticket

| In | Out |
|---|---|
| Dispatcher-facing tool schemas (spawn / check / steer / stop / deliver) | Worker agent type + tool barrier (ticket 10) |
| Policy system section + per-turn reminder middleware | Durable marker write (ticket 08) |
| Spawn ack, silence/stale wake rules, report clamping | dsh adapter live wiring (ticket 09) |
| Manual S1–S5 demo outline | Peer messaging (Phase 2 / ticket 14) |

---

## 2. Tool schemas

Five dispatcher-only tools. Names are chosen for this project; wording is dsh-plain (describe the action, not the machinery). Each maps 1:1 onto an existing `Multitask` call or the host's user-facing send — no new `DshHost` methods.

### 2.1 `spawn_worker`

| Field | Spec |
|---|---|
| Purpose | Start one blank worker for one logical stream. Non-blocking. |
| Core call | `Multitask.spawnWorker(SpawnRequest)` |
| Host call | `DshHost.spawnWorker(prompt, SpawnOptions)` |
| When to use | Non-trivial multi-step work. Never for pure chat or one-step lookups. |

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `stream_key` | string | yes | Stable id for the logical stream. One live worker per key. Reuse the todo id when a todo exists. |
| `title` | string | yes | Short human title (3–8 words). Shown on wake and in check. |
| `prompt` | string | yes | Self-contained work instruction: goal, constraints, relevant context, success criteria, report format. The worker does not see this chat. |
| `todo_id` | string \| null | no | Links the worker to a ledger entry (ADR-0007). Prefer always setting it. |

**Returns**

```ts
type SpawnWorkerToolResult =
  | {
      ok: true;
      worker_id: string;
      stream_key: string;
      title: string;
      /** Model-facing ack text — see §3.2. Not user-visible. */
      ack: string;
    }
  | {
      ok: false;
      reason: "duplicate-stream-key";
      detail: string;
    };
```

Refusal creates no worker and never talks to the host (`SpawnResult` in `src/core/types.ts`).

---

### 2.2 `check_workers`

| Field | Spec |
|---|---|
| Purpose | Inspect the live roster for this dispatcher session. |
| Core call | `Multitask.listWorkers(parentSessionId)` (+ optional `getWorker`) |
| Host call | none (pure registry read) |
| When to use | User asks what is running; dispatcher needs status before deciding steer/stop. **Not** a poll loop. |

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `worker_id` | string \| null | no | When set, return one worker; when null, return the roster. |

**Returns** — one `WorkerCheckRow` per entry, from `WorkerSummary`:

```ts
interface WorkerCheckRow {
  worker_id: string;
  stream_key: string;
  title: string;
  status: WorkerStatus;          // spawned | running | steering | completed | error | aborted
  elapsed_ms: number;            // computed at list time
  tool_call_count: number;
  transcript_ref: string | null; // path/id the dispatcher may open if it needs the play-by-play
  todo_id: string | null;
  /** Last known activity phrase; null when none recorded yet. */
  recent_activity: string | null;
}
```

**Check-result formatting rule (summarize, do not dump)** — formatters emit a compact table-like text, never raw JSON:

```text
running · "Rewrite auth docs" · 4m12s · 7 tool calls · todo t-3 · transcript: <ref>
  activity: reading src/auth/session.ts
```

Unknown `worker_id` → `{ ok: false, reason: "unknown-worker", detail }` in the same shape as steer/stop refusals.

`recent_activity` is host-optional: if the adapter cannot supply a live activity line, leave `null` and still return elapsed / tool count / transcript. The tool description must not promise more than the row can carry.

---

### 2.3 `steer_worker`

| Field | Spec |
|---|---|
| Purpose | Mid-run correction. Latest-wins. Context preserved; worker does not restart. |
| Core call | `Multitask.steerWorker(workerId, message)` |
| Host call | interrupt + `sendMessage` on step boundary (already in core) |
| When to use | User corrects or redirects a **running** stream. Never spawn a clone for a correction. |

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `worker_id` | string | yes | Target worker. |
| `message` | string | yes | The correction itself, not a meta-sentence. |

**Returns** — maps `SteerResult`:

```ts
type SteerWorkerToolResult =
  | { ok: true; note: string }
  | {
      ok: false;
      reason: "unknown-worker" | "not-running";
      detail: string;
    };
```

`note` on success (model-facing, short — **not** a re-echo of `message`):

```text
Correction parked for "<title>". It will fold in at the next step boundary and continue from where it is — no restart. If you send another correction before delivery, only the latest applies.
```

Refusal (idle/terminal): worker is not recreated; detail says it may already be done and points the dispatcher at check / a new spawn if follow-up work is needed.

---

### 2.4 `stop_worker`

| Field | Spec |
|---|---|
| Purpose | Abort a worker for good. Silent to the user by default. |
| Core call | `Multitask.abortWorker(workerId)` |
| Host call | `DshHost.interruptWorker` after the stop flag is set |
| When to use | User cancels, or dispatcher decides the stream is useless. |

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `worker_id` | string | yes | Target worker. |

**Returns** — maps `StopResult`:

```ts
type StopWorkerToolResult =
  | { ok: true; note: string }
  | { ok: false; reason: "already-settled"; detail: string };
```

`note` on success:

```text
Stopped. Nothing further will arrive from this worker. Any correction parked for it is dropped. Tell the user only if the work was visible and they need to know it was cancelled.
```

Refusal after settle: the already-queued completion stays delivered; the stop path never undoes it (reference §1).

---

### 2.5 `deliver_result`

| Field | Spec |
|---|---|
| Purpose | Explicit user-facing delivery. The **only** path that puts text in front of the user from a wake/background turn. |
| Core call | none (presentation) |
| Host call | dsh primary-agent user send / turn text (adapter maps this; PRD §6.3 "existing user message tool") |
| When to use | After a wake, **only if** the result is new and relevant (or the user asked to be told). Otherwise stay silent — do not call this tool. |

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | What the user sees. Lead with the concrete finished thing (see §3.4). |
| `todo_id` | string \| null | no | Ledger entry to mark `completed` **after** this send succeeds (S4 / ADR-0007). |
| `attachment_paths` | string[] | no | Optional local paths the dispatcher chooses to attach. Never auto-attached from a worker report. |

**Returns**

```ts
type DeliverResultToolResult = {
  ok: boolean;
  delivered: boolean;
  todo_completed: string | null; // todo_id flipped to completed, or null
  detail?: string;
};
```

**Adapter note:** on a primary-chat dispatcher, ordinary user-turn replies already *are* delivery. `deliver_result` exists so wake/hidden turns have an explicit, testable silence-or-speak decision (reference wake rule: silence-allowed). On user turns the adapter may treat the final assistant text as a implicit deliver; on wake turns only this tool (or an equivalent host send the adapter installs) produces a user-visible message.

Workers never receive this tool (ticket 10 barrier — S5).

---

### 2.6 Todo surface (not new)

Todos stay on dsh's existing `todo_write` (`allowParallelInProgress: true`). Ticket 11 does not redefine the todo tool; the **policy copy** tells the dispatcher when to write it (before spawn; `completed` only after `deliver_result`).

---

## 3. Prompt copy drafts (full text)

Canonical copies live under `.scratch/multitask-dispatcher/prompts-draft/`. Summaries and assembly order here; implementer should read the draft files as the shipping source (later moved to `prompts/`).

### 3.1 Dispatcher policy section — `prompts-draft/dispatcher-policy.md`

Injected once per dispatcher session (feature ON). Behavioral bullets from PRD §6.1, rewritten as new copy.

```markdown
# Multitask dispatcher

You are the user's main assistant in this chat. You stay responsive. Heavy work goes to workers you spawn in the background.

## How you work

- You are a dispatcher, not the workhorse. Do the conversational and one-step parts yourself. Hand non-trivial multi-step work to a worker.
- Independent requests run in parallel. Never make stream B wait on stream A unless they share one logical stream.
- A correction to work already in flight is a steer on that worker. Do not spawn a second worker for the same stream.
- One live worker per stream. Check before you spawn if you are unsure.
- Write a todo entry before you spawn. Several entries may be `in_progress` at once. Mark an entry `completed` only after the user actually has the result — not when the worker merely exits.
- On every wake, reconcile the ledger first: what is running, what landed undelivered, what still needs dispatch.
- Worker prompts are self-contained. The worker cannot see this conversation, the user's earlier messages, or sibling work. Put the goal, constraints, relevant context, success criteria, and report format into the spawn prompt.
- Workers cannot talk to the user. Only you deliver.
- The user never hears the machinery. Do not name workers, streams, wakes, or dispatch. Speak as one busy person.

## What you never do

- Poll a worker in a loop during a turn. Spawn, steer, stop, or check once — then move on or end the turn.
- Pretend a spawn finished the work. A spawn only starts it.
- Clone a stream because the user corrected it.
- Dump a worker transcript or a long tool log into the user's chat.
- Say "dispatching", "spawning a worker", "background agent", or similar jargon to the user.
```

### 3.2 Spawn ack — `prompts-draft/spawn-ack.md`

Returned **to the model** as `SpawnWorkerToolResult.ack`. Short. Must say: runs in background, final response arrives on completion, do not wait or poll.

```text
Started "<title>" in the background (worker <worker_id>, stream <stream_key>).

It runs on its own. Its final response will arrive here when it finishes — you do not need to wait, poll, or keep this turn open. Answer the user now if they need a reply, then end the turn or move to other work.

Self-contained prompt sent:
---
<prompt>
---
```

Refusal ack (duplicate stream key):

```text
Stream "<stream_key>" already has a worker in flight (<existing_or_same_title_hint>). Do not start a second one. Steer or stop the running worker instead, or check its status.
```

(The core currently returns `detail` with the existing worker id; the tool layer surfaces that detail. The sentence above is the tool description's guidance, not a second string the core must invent.)

### 3.3 Per-turn reminder — `prompts-draft/per-turn-reminder.md`

Re-injected at the **start of every dispatcher turn** (user or wake) by reminder middleware. Cheap, short, always current.

```markdown
## Ledger
<todo list rendering — id, status, title; multiple in_progress allowed>

## Standing rules
- Short turn: reply or act, then end. Do not wait on workers.
- Non-trivial multi-step work → spawn; independent work → parallel.
- Correction → steer the running worker; do not clone.
- Todo before spawn. `completed` only after the user has the result.
- Reconcile the ledger on every wake before you speak.
- Workers never message the user. You deliver. Never name the machinery.
```

Middleware contract:

- Input: current todo state (reconciler output) + fixed rule block.
- Output: markdown block prepended (or system-injected) at turn start.
- Pure; tests assert structure/order, not prose quality.
- Empty ledger → still inject the rules; ledger line becomes `(empty)`.

### 3.4 Wake-turn instructions — `prompts-draft/wake-turn.md`

Injected when the wake source is `worker-settled` (hidden/background turn). Silence-allowed.

```markdown
# Background work landed

One or more of your workers has finished. Details are below.

## Settled workers
<for each notice>
### <title> — <status>
Worker: <worker_id>
Transcript: <transcript_ref>

<clamped report text — see §4>
</for each>

## What to do now

1. Reconcile the todo ledger first. Match each settled worker to its entry (`todo_id` on the worker record). Do not mark anything `completed` until you have delivered it.
2. Decide, for each result, whether the user should hear about it:
   - Tell them if the result is new, relevant, or they asked to be told.
   - Stay silent if it is stale, a duplicate of what you already said, superseded by a newer correction, or irrelevant now.
3. If you speak, lead with the concrete thing that finished — not a bare pronoun, not "done", not "it worked".
4. Deliver through the user-facing send only. Then mark the matching todo `completed`.
5. If a result is an error, report the honest state and decide: retry as a new spawn, steer if still live (it will not be), or drop and say so.
6. If nothing is worth saying, end the turn without messaging the user. Silence is a valid outcome.

Never name workers, wakes, or the dispatch layer in anything the user will read.
```

### 3.5 Steer wrapper

Already shipped as new copy in `src/core/steer-queue.ts` (`wrapParentCorrection`). Ticket 11 does not change it. Keep:

```text
[Parent correction]
The following message is a correction from your parent.
Fold it into the work you have already done and continue from where you are — do not restart.

<message>
```

### 3.6 Tool descriptions (model-facing, new copy)

These are the `description` fields registered on the five tools.

**`spawn_worker`**

```text
Start a background worker for one stream of work. Give it a complete, standalone prompt: it does not see this conversation. Returns immediately; the worker's final response arrives later — do not wait or poll. One live worker per stream_key. Write a todo entry first when the work is user-visible.
```

**`check_workers`**

```text
List your running and recent workers, or inspect one by id. Returns status, elapsed time, tool-call count, transcript reference, and recent activity. Use this when the user asks what is in flight — not as a wait loop.
```

**`steer_worker`**

```text
Send a correction into a worker that is still running. Context is preserved; the worker continues from where it is. Only the latest undelivered correction applies. Refused if the worker is not running.
```

**`stop_worker`**

```text
Stop a worker for good. Any later result from it is dropped and any parked correction is discarded. Nothing is sent to the user by this tool — tell them yourself only if the work was visible and they need to know.
```

**`deliver_result`**

```text
Send a result to the user. Use this on background/wake turns when the finished work is new and relevant; otherwise stay silent. Lead with the concrete thing that finished. Optionally mark a todo completed after a successful send.
```

---

## 4. Report clamping rules

Deliberate divergence from the reference (Gap 5 / spec "Deliberate divergences"): the reference delivers worker result text essentially unclamped into the wake prompt; we clamp to protect S1.

### 4.1 Constants (implementer-tunable; defaults)

| Constant | Default | Applies to |
|---|---|---|
| `REPORT_CLAMP_CHARS` | 2000 | Worker report body in a wake notice |
| `ERROR_CLAMP_CHARS` | 800 | Error message body |
| `CHECK_ACTIVITY_CHARS` | 120 | `recent_activity` line |
| `TOOL_RESULT_SUMMARY_MAX_ROWS` | 20 | check roster rows before head/tail fold |

### 4.2 Worker report → wake context

On settle, before the notice enters the wake batch / dispatcher context:

1. Trim leading/trailing whitespace.
2. Empty text → placeholder:
   ```text
   (The worker finished but produced no text output. See the transcript for details.)
   ```
3. Error status → use the error message, clamped to `ERROR_CLAMP_CHARS`, prefixed:
   ```text
   Worker failed:
   <clamped error>
   ```
4. Completed text longer than `REPORT_CLAMP_CHARS`:
   - Keep the first `REPORT_CLAMP_CHARS` characters.
   - Append:
     ```text
     …
     [report truncated: <shown> of <total> characters. Full transcript: <transcript_ref>]
     ```
5. Never strip a path/URL that sits inside the kept prefix; clamping is a hard cut at the character budget, not a smart rewriter.
6. Aborted workers produce **no** wake report body (reference §1). If a notice is ever emitted for bookkeeping, body is:
   ```text
   (Stopped before completion. No report.)
   ```

### 4.3 Check / steer results

- Check returns the compact row format (§2.2), never a JSON dump and never transcript contents.
- Steer returns only `{ok, note|detail}`. The parked message is not echoed back to the dispatcher (it already wrote it).
- Stop returns only confirmation/refusal text (§2.4).

### 4.4 User-facing delivery

Clamping is for **dispatcher context**, not for what the user finally sees. The dispatcher may read the transcript (`transcript_ref`) if it needs the full report before choosing what to say. The user-facing text is whatever the dispatcher writes after that decision — not the clamp marker.

---

## 5. Wiring plan

### 5.1 Proposed files (implementation, later)

| File | Role |
|---|---|
| `src/core/report-clamp.ts` | Pure clamp helpers (`clampReport`, `clampError`, `emptyReportPlaceholder`). No host. |
| `src/core/tool-results.ts` | Pure formatters: spawn ack, check rows, steer/stop notes, wake notice blocks. |
| `src/core/policy/prompts.ts` | String constants / template functions importing the shipped prompt assets (moved from `prompts-draft/`). |
| `src/core/policy/assembler.ts` | `assembleSessionPolicy()`, `assembleTurnReminder(todos)`, `assembleWakeTurn(notices)`. Pure. |
| `src/core/tools.ts` | Tool definition objects (name, description, JSON schema, handler stubs mapping to `Multitask`). Handlers stay core-side until the adapter registers them. |
| `prompts/dispatcher-policy.md` etc. | Shipped prompt assets (M3/M4); drafts today under `.scratch/.../prompts-draft/`. |

No changes required to `DshHost`, `FakeDshHost`, `worker-fsm`, or `steer-queue` for this ticket.

### 5.2 How FakeDshHost stays green

- Tool handlers call existing `Multitask` methods only (`spawnWorker`, `listWorkers`, `steerWorker`, `abortWorker`). Fake host already records spawn/interrupt/send/wake.
- Clamp + assembler + formatters are **pure** — unit tests need no host at all.
- Existing core tests keep asserting behavior, never prompt strings (spec Testing Decisions). Policy tests assert **presence and order of sections**, not wording.
- `deliver_result` is adapter-side; core tests can cover a thin `markDelivered(todoId)` hook later with the reconciler (ticket 07) and need not extend FakeDshHost now.
- Optional: a `fireSettled` with a long `report` can assert the clamp output shape without touching the fake.

### 5.3 Feature flag (ADR-0005)

Policy assembler takes `enabled: boolean` read once at dispatcher-session start. Flag OFF → assembler returns empty / tools not registered. No mid-session re-read.

### 5.4 Boundary vs ticket 10

Ticket 11 ships **dispatcher** tools and policy. Ticket 10 removes those tools from the worker surface. Implement 11 first so 10 has something to barrier against.

---

## 6. Manual demo script (S1–S5)

Short, scripted, against FakeDshHost in unit tests plus one live dsh pass when the adapter exists. Fake-host demo can run in CI without network/LLM (S8-friendly); live demo is the M2 exit (PRD §13).

### Setup

- One dispatcher session, policy + reminder middleware ON.
- Fake (or real) long worker: multi-step task that takes "minutes" (in fake: several `fireStepBoundary` + delayed `fireSettled`).
- Clock: note timestamps for latency checks.

### Steps

| Step | Action | Expect | Criterion |
|---|---|---|---|
| D1 | User: "Summarize the three auth RFCs and draft a migration note." | Dispatcher writes todo, calls `spawn_worker` with a self-contained prompt, replies to the user within seconds ("On it — I'll come back with the summary."), ends turn. Spawn ack present in model context: do not wait. | S1, spawn ack |
| D2 | User (while worker runs): "Also, what's the status of the docs rewrite I asked about earlier?" | Dispatcher answers from context/check in the same short turn. Does **not** poll the long worker in a loop. User turn latency still ~seconds. | S1 |
| D3 | User: "Two independent things: (a) list open TODOs in the repo, (b) draft a changelog stub." | Second and third todos; two `spawn_worker` calls with distinct `stream_key`s; both run concurrently (two live roster rows `running`). | S2 |
| D4 | User (mid-run on D1 worker): "Actually focus on the third RFC only and drop the migration note." | `steer_worker` on the D1 worker. No new spawn for that stream. Fake: interrupt called, later step-boundary delivers wrapped correction; worker status `steering → running`. | S3 |
| D5 | Fake: `fireSettled` on D1 worker with a long report (> clamp budget). | Wake turn opens. Report body in context is clamped with transcript pointer. Reminder + wake instructions present. | Report clamping |
| D6 | On wake: dispatcher reconciles todos, calls `deliver_result` with text that leads with the concrete deliverable ("Here's the third-RFC summary…"), marks that todo `completed`. | User sees the result. Todo `completed` only now. | S4 |
| D7 | Inspect worker tool barrier (ticket 10, but checked here in the demo): worker prompt/tool list has no user-messaging tool, no `spawn_worker`, no `steer_worker`/`stop_worker`/`check_workers`, no todo tool. Attempted user address is impossible. | S5 |
| D8 | D3 workers still running while D6 delivers. User is never blocked; parallel streams stay `in_progress`. | S1, S2 |

### Pass conditions

- D1/D2: user replies under a few seconds of wall clock (live) or zero extra fake-host waits (unit).
- D4: exactly one live worker for that `stream_key` before and after steer; correction text delivered wrapped, context preserved (no second spawn call).
- D6: `completed` appears only after a successful user delivery; wake silence path also demoed once (fire a stale settle → dispatcher ends turn with no user message).
- D7: barrier is structural (tool absent), not a prompt-only request.

### Stale/silence sub-demo (part of D6)

1. Deliver D1 result (user told).
2. Fire a second settle for a worker whose result was already summarized inline, or a duplicate notice.
3. Expect: wake runs, dispatcher reconciles, **no** `deliver_result`, todos unchanged to `completed` only if not already, turn ends silently.

---

## 7. AC checklist (ticket 11)

| AC | Where |
|---|---|
| spawn/check/steer/stop/deliver tools, dsh-native wording | §2, §3.6 |
| spawn ack says do not wait | §3.2 |
| check returns elapsed / tool count / activity / transcript | §2.2 |
| policy section + per-turn reminders | §3.1, §3.3 |
| wake-turn silence/stale rules | §3.4, §6 D6 stale sub-demo |
| report clamping | §4 |
| all new copy | this doc + `prompts-draft/` |
| short manual demo S1–S5 | §6 |

---

## 8. Open points for the implementer (not blockers)

1. **`deliver_result` vs plain turn text** on user turns — adapter may map both to the same host send; keep the tool for wake turns regardless.
2. **`recent_activity`** may be `null` until the adapter can read a live job/step line from `ctx.jobs` (ticket 09). Schema allows null.
3. **Prompt locale:** PRD M4 mentions ZH/EN. Ship EN first; keep copies in separate files so ZH can land without code churn.
4. **Clamp budgets** are product knobs; defaults above are conservative for S1, not sacred.
