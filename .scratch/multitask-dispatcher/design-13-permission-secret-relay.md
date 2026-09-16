# Design 13 — Permission and secret relay

**Ticket:** [issues/13-permission-and-secret-relay.md](issues/13-permission-and-secret-relay.md)
**Status:** ready-for-agent (design only; no `src/` changes in this note)
**Blocked by:** 11 only (can parallel 12)
**Sources:** ticket 13 AC; Gap 2 in `docs/research/prd-vs-reference-capability-gaps.md`; §9 of `docs/research/dsh-adapter-api-notes.md`; current `src/core/dsh-host.ts` / `wake-bus.ts` / `multitask.ts` / `fake-host.ts`; ADR-0003 (workers are leaves), ADR-0006 (durability split), ADR-0004 (imitation scope).

---

## 1. Problem and non-negotiables

A worker can hit a wall only the user can clear: a gated tool action, or a credential it does not have. Without a defined path the stream fails silently or hangs forever, which breaks S4 in practice (Gap 2).

Ticket 13 must deliver:

| AC | Design answer |
|---|---|
| Structured request → wake dispatcher → ask user / stored policy → steer answer back | Own `AccessRequest` + relay (§3–§5); answer rides existing `sendMessage` (same worker, no restart) |
| Default deny + timeout | Unanswered request is denied after `accessRequestTimeoutMs` (§7) |
| Deny reported honestly | Deny is a first-class decision, never a silent stall; user-facing notice names the denied action (§8) |
| Credentials scoped-injection only | Resolve at the edge; never in the worker prompt; never discoverable by asking (§9) |
| Testable unanswered timeout | Injectable clock/timer on the relay; FakeDshHost can leave a request unanswered (§10) |

---

## 2. Design fork: do **not** use dsh approval waterfall on workers

`docs/research/dsh-adapter-api-notes.md` §9 records that delegation pins child `approval/policy` to **`'never'`** whenever the approval capability is composed. Three options were listed. **This design chooses option 2**, with option 3 used for credentials:

| Option | Verdict |
|---|---|
| 1. Override child `approval/policy` after start, relay via waterfall | **Rejected.** Fights an intentional dsh pin ("delegated child acts only within the sandbox scope fixed at delegation"). Still leaves us without first-class timeout default-deny. |
| 2. **Custom structured ask tool on the worker; relay through dispatcher** | **Chosen.** Matches Gap 2 and ticket 13 AC exactly. Timeout/deny is ours. The dispatcher *is* the primary chat agent, so "ask the user" is just a dispatcher turn. |
| 3. Pre-approve everything via tight `toolFilter` + scoped credentials | **Partial.** Chosen for **credentials** (§9) and for the boring default class of tools. Not sufficient alone — unknown gated actions still need a path. |

We still *glue onto* the three dsh seams (ticket note: "build the relay on those rather than inventing a request flow"):

- `dsh-permission-presets` — stored policy classes (§6).
- `dsh-credentials` — scoped secret resolution (§9).
- `dsh-user-approval` — optional dispatcher-side human-ask helper (`ApprovalService.request` / `ask_user_question`); **not** the worker-side path. If it is awkward to use from a wake turn, the dispatcher simply asks in its own user-facing reply — that is product-legal (only the dispatcher talks to the user).

**Implementer follow-up (not this note):** record this fork as ADR-0008 when the code lands. State plainly that it diverges from dsh's native child-approval path and why (delegation pin + default-deny timeout).

---

## 3. Message shapes

Add to `src/core/types.ts` (or a sibling `access-types.ts` if the file grows). All names are ours; none come from the reconstruction.

```ts
/** Why a worker is blocked. Stable class string; unknown strings are fine. */
export type AccessClass =
  | "tool"           // a named work tool needs a one-shot yes/no
  | "credential"     // needs a secret (see §9 — values never ride this shape)
  | "network"        // e.g. a host the sandbox would not allow
  | "filesystem"     // e.g. a path outside the workspace
  | "other";

/** What the worker is asking for. Never contains a secret value. */
export interface AccessRequestBody {
  class: AccessClass;
  /** Tool or resource name, when known. Free-text reason, short. */
  target: string;
  reason: string;
  /**
   * For class "credential": the env/credential *name* only
   * (e.g. "GITHUB_TOKEN"). Never the value.
   */
  credentialName?: string;
}

/** Worker → core request event (host delivers after the worker tool runs). */
export interface AccessRequestEvent {
  workerId: string;
  /** Host-unique id for this ask. */
  requestId: string;
  body: AccessRequestBody;
  /** ms since epoch when the ask was created (host clock). */
  createdAtMs: number;
}

/** Decision steered back into the worker. */
export type AccessDecision =
  | { readonly kind: "allow"; readonly note?: string }
  | {
      readonly kind: "deny";
      readonly reason: "user-denied" | "policy-denied" | "timeout" | "aborted";
      readonly detail: string;
    };

/** Live ticket held by the core (in-memory — see §11). */
export interface AccessTicket {
  workerId: string;
  requestId: string;
  body: AccessRequestBody;
  createdAtMs: number;
  parentSessionId: string;
  status: "pending" | "resolved";
}
```

**One outstanding ask per worker.** A second `request_access` while one is pending is refused by the worker tool (tool returns a short "already waiting on an answer" result). Same single-slot discipline as the steer queue — no pile-up of unanswered asks.

---

## 4. Host APIs to add (`DshHost`)

Extend `src/core/dsh-host.ts`:

```ts
export interface DshHost {
  // ...existing methods unchanged...

  /**
   * Subscribe to structured access requests from workers.
   * Host invokes callbacks when a worker's request_access tool is used.
   */
  onAccessRequest(cb: (event: AccessRequestEvent) => void): void;

  /**
   * Optional: resolve a credential *name* to a value for scoped injection.
   * Adapter-only; core never sees the string. Tests never call this.
   */
  resolveCredential?(
    credentialName: string,
  ): Promise<{ value: string; source: string } | undefined>;
}
```

**What we deliberately do *not* add:**

- No `answerAccess` host method — the answer is a normal `sendMessage` into the same worker (existing seam, preserves context, no restart). The core wraps the decision (§5).
- No host method that returns secret values into core state.

`FakeDshHost` gains:

```ts
readonly accessRequestCallbacks: Array<(e: AccessRequestEvent) => void>;

onAccessRequest(cb: (e: AccessRequestEvent) => void): void;

/** Test helper: deliver an access request to every subscriber. */
fireAccessRequest(event: AccessRequestEvent): void;
```

Adapter glue (ticket 09 extension, not core): register a **worker-only** tool, new copy, e.g. name `request_access`:

| Input | Type | Notes |
|---|---|---|
| `class` | enum | one of the AccessClass strings |
| `target` | string | tool/resource name |
| `reason` | string | short why |
| `credential_name` | string optional | env name only |

On invoke: create `requestId`, emit `AccessRequestEvent` into the core, **park the worker** (it may end its turn; the answer arrives as a later message). Tool description (new copy, `prompts/worker-access-request.md`) must say: this is the only way to ask the parent; never invent a user channel; after calling, stop and wait for a parent message; denied means do not retry the same ask.

Dispatcher tool from ticket 11 stays as-is (spawn/check/steer/stop/deliver). The access path does **not** add a sixth dispatcher tool — resolution is a wake-time policy action, not a user-called tool. If a human-facing override is needed later, it can be a follow-up.

---

## 5. Core relay (`src/core/access-relay.ts`)

New pure-ish module, host-free except through `DshHost` callbacks already registered by `createMultitask`. Suggested surface:

```ts
export interface AccessRelayOptions {
  /** Default 120_000. Tests pass a tiny value or a fake clock. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Schedule a one-shot timeout. Returns a cancel function.
   * Default uses setTimeout. Tests inject a manual scheduler.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Stored policy lookup (permission presets / session table). See §6. */
  lookupPolicy: (req: AccessRequestBody, ctx: PolicyLookupCtx) => AccessDecision | "ask";
}

export interface AccessRelay {
  /** Called from host.onAccessRequest inside createMultitask. */
  noteRequest(event: AccessRequestEvent, parentSessionId: string): void;
  /**
   * Resolve a pending ticket. Idempotent: second resolve is a no-op.
   * Returns false when unknown/already resolved/worker terminal.
   */
  resolve(
    workerId: string,
    decision: AccessDecision,
  ): boolean;
  /** Drop tickets for a worker (stop/settle). */
  clear(workerId: string): void;
  listPending(parentSessionId?: string): readonly AccessTicket[];
}
```

### Flow

```text
Worker tool request_access
        │
        ▼
Host adapter ──emit AccessRequestEvent──► Multitask / AccessRelay
        │                                      │
        │                         1. one-slot check (refuse if pending)
        │                         2. lookupPolicy ──► allow/deny  ──► steer back, done
        │                         3. else "ask":
        │                            park AccessTicket (pending)
        │                            arm timeout (schedule)
        │                            wake bus  ──►  requestDispatcherWakeup
        ▼                                      │
   worker waits (context kept)                 ▼
                                      Dispatcher turn (policy §11):
                                      ask user, or apply remembered policy
                                      (user says "always allow X" → write table)
        │
        ▼
core.resolve(workerId, decision)
        │
        ├─► host.sendMessage(workerId, wrapAccessDecision(decision))
        ├─► cancel timeout; ticket → resolved
        └─► if deny: surface honest notice (§8) into the same or next wake
```

### Wrappers (new copy only)

```ts
/** Like wrapParentCorrection in steer-queue.ts, but access-specific. */
export function wrapAccessDecision(decision: AccessDecision): string {
  // allow: short "Parent: allowed. Continue from here; do not restart."
  // deny:  "Parent: denied (reason). Do not retry this ask. Adjust the plan
  //         or end with a final report explaining what was blocked."
}
```

Delivery uses the **existing** `host.sendMessage` — not a new steer slot. If a steer is also parked for the same worker, the answer message is independent text; last-wins still applies only to steers. Do not overload `SteerTicket` for access answers (different lifetime and semantics; ADR-0006 keeps steers in-memory single-slot — tickets follow the same in-memory rule but are a separate map).

### FSM interaction

- Access pending does **not** change `WorkerStatus`. The worker is still `running` (or `spawned`/`steering`); it is waiting on a message, not terminal.
- `abortWorker` / terminal settle → `accessRelay.clear(workerId)`. A late `resolve` is a no-op.
- Stop wins: if the worker was aborted after the ask, the timeout must not resurrect it.

---

## 6. Stored policy (`dsh-permission-presets` glue)

**Where policy lives:** a session-scoped table owned by the plugin, seeded from / aligned with `PermissionPresetService` where the class maps cleanly.

```ts
export interface PolicyEntry {
  /** Match on class + optional tool/target fingerprint. */
  class: AccessClass;
  /** Exact or prefix match on target; `*` = any target in class. */
  targetPattern: string;
  decision: "allow" | "deny";
  /** "session" = this dispatcher session only; "profile" = durable profile default. */
  scope: "session" | "profile";
}

export type PolicyLookupCtx = {
  parentSessionId: string;
  /** Current sandbox / approval knobs if the adapter exposes them. */
};
```

Resolution order inside `lookupPolicy`:

1. Session table hit → that decision (no user ask).
2. Profile table hit → that decision.
3. Otherwise → `"ask"` (wake + user).

Alignment with dsh presets:

- Multitask profile still uses the delegation seed (`approval: 'never'`, sandbox fixed at spawn) for the **host tool layer**. That layer stays deny-by-default for anything not in the worker tool barrier.
- Our table is the **product** layer above it: it decides whether the *worker's structured ask* is auto-answered or escalated.
- Do not invent a second sandbox. Ticket 10's tool barrier already removes forbidden tools; this relay covers *allowed-but-gated* and *credential* cases only.

Default profile seed (implementer ships as new copy defaults):

| class | target | decision | notes |
|---|---|---|---|
| `tool` | `*` | ask | safe default |
| `credential` | `*` | ask | then §9 injection if allowed |
| `network` | `*` | ask | |
| `filesystem` | `*` | ask | |

No `allow *` in the shipped seed.

---

## 7. Timeout and default deny

| Parameter | Default | Notes |
|---|---|---|
| `accessRequestTimeoutMs` | `120_000` | Plugin Config field (`z.number().default(120_000)`); tests pass `1`–`50` or a fake scheduler |

On fire:

1. Ticket still `pending` and worker still live → `resolve(workerId, { kind: "deny", reason: "timeout", detail: "…stopped waiting for an answer…" })`.
2. Steer deny text into the worker (§5).
3. Honest user notice (§8): stream stopped waiting, named action, not a generic failure.
4. Ticket → resolved; no retry storm (worker tool already refuses a second concurrent ask; the deny wrapper tells it not to re-ask the same thing).

If the worker terminal-settles first, cancel the timer via `clear(workerId)`.

**Default deny is the timeout path.** There is no silent infinite wait. An explicit user deny uses `reason: "user-denied"`; a table deny uses `policy-denied` and never opens a user ask.

---

## 8. Honest deny reporting

Rules (map to ticket AC "denied request is reported to the user as a denied action, not as a task failure with no reason"):

1. **To the worker:** `wrapAccessDecision` deny text includes `reason` + `target` + a short instruction to either re-plan without the action or end with a final report that names the block. Never a bare "no".
2. **To the user:** the dispatcher wake (or the next reconcile) carries a structured notice the policy assembler can surface:

```ts
export interface AccessNotice {
  kind: "access-resolved";
  workerId: string;
  title: string;           // from WorkerRecord
  decision: AccessDecision;
  body: AccessRequestBody; // class, target, reason — never secrets
}
```

3. **Dispatcher policy copy** (ticket 11 assembler, new section): when a wake includes access notices, mention the denied action in plain language ("I couldn't run X on that stream — it was denied / the wait timed out") and do not claim the task failed for an unrelated reason. Allowed auto-policies need not be narrated unless the user asked.
4. **Todo:** a deny does not auto-complete the todo. The worker may still finish with a partial report (then normal settle/delivery); if the worker ends solely because of the deny, the settle path reports honestly and the todo is completed only after that report is delivered (existing S4 rule).

---

## 9. Credentials: scoped injection only

**Hard rule (ticket AC):** a worker that needs a credential receives it **only** by scoped injection — never as text in its prompt, never discoverable by asking, never in tool names, labels, telemetry, or wake text.

### Mechanism (prefer research options b/c)

| Option | Use? |
|---|---|
| (a) Resolve at spawn, put value in initial prompt | **Forbidden.** Lands in transcript. |
| (b) Resolve inside the worker via process `ctx.credentials` with a scope filter | **Preferred default.** Children share the process credentials service. |
| (c) `GrantRecord` under our plugin scope + small worker-side tool that reads it | **Preferred when (b) is too wide** (worker should only see named grants). |

Concrete shape:

1. `SpawnOptions` gains an optional allow-list of credential *names* the stream may later use:

```ts
export interface SpawnOptions {
  parentSessionId: string;
  streamKey: string;
  title: string;
  /** Env/credential names this worker may resolve. Values never appear here. */
  credentialNames?: readonly string[];
}
```

2. Adapter, when the worker (or its tools) resolve a name:
   - Name must be in `credentialNames` for that worker (else deny / undefined).
   - Call `credentials.resolve(credentialRef(name))` **inside the adapter/tool**, not in core.
   - Inject into the tool invocation environment (process env for that call, or the tool's private option bag). Do not append to any message the model reads as chat.
3. Worker `request_access` with `class: "credential"` carries **only** `credentialName`. The relay may auto-allow if policy says so and the name is in the spawn allow-list; otherwise it asks the user. On allow, the adapter marks the name granted for that worker and the next tool use resolves it — **the value is never steered back as text**. The allow decision note may say "credential X is now available to your tools" (name only).
4. `describe(ref)` / info records never leak values into dispatcher context.

Fake host records `credentialNames` on spawn; tests assert the value never appears in `spawnCalls[].prompt` or `sendMessageCalls[].message`.

---

## 10. Wake bus extension

Current `WakeSource` is `user | worker-settled | peer | timer | external-event`. Access asks are not settles and are not timers. **Additive change** (the enum was accepted so later tickets can enqueue without redesign — this is that later ticket):

```ts
export type WakeSource =
  | "user"
  | "worker-settled"
  | "worker-access-request"  // NEW
  | "peer"
  | "timer"
  | "external-event";
```

`WakeEvent` gains a parallel field (do not rename `settledWorkers` in this ticket — keep the diff small):

```ts
export interface WakeEvent {
  readonly sessionId: string;
  readonly source: WakeSource;
  readonly settledWorkers: readonly SettledWorkerNotice[];
  /** NEW: pending access asks for this dispatcher turn. */
  readonly accessRequests: readonly AccessRequestNotice[];
}

export interface AccessRequestNotice {
  readonly workerId: string;
  readonly requestId: string;
  readonly title: string;
  readonly body: AccessRequestBody;
}
```

Bus rules (mirror settle semantics):

- `enqueueAccessRequest({ parentSessionId, workerId, requestId, title, body })`.
- Mid-turn: queue only; flush on turn end.
- User wake still preempts (reclaim access notices onto pending).
- Several access asks batch into one wake.
- `onDeliver` still fires only for background flushes.
- Timeout deny that produces a user notice reuses the same bus: either fold an `AccessNotice` into the next ready wake or enqueue a follow-up background wake — implementer pick one and test it; do not open a mid-turn inject.

---

## 11. Durability

| Piece | Durable? | Rationale |
|---|---|---|
| `AccessTicket` | **No** (in-memory) | Same argument as `SteerTicket` (ADR-0006): transient, last-answer-wins, meaningless after restart. |
| Stored policy table `scope: "session"` | No | Session lifetime. |
| Stored policy table `scope: "profile"` | Yes | Profile settings / preset store — dsh facilities, not a second DB. |
| Credential values | Never in our store | dsh-credentials owns them. |

Restart while an ask is pending: honest amnesia — worker is unknown-state / re-spawn policy per ticket 08; no fake "still waiting" UI. Document in the implementer comment.

---

## 12. Config and file layout

```text
src/core/
  access-types.ts          # AccessClass, AccessRequestEvent, AccessDecision, AccessTicket, notices
  access-relay.ts          # createAccessRelay, wrapAccessDecision, timeout
  dsh-host.ts              # + onAccessRequest, optional resolveCredential
  fake-host.ts             # + fireAccessRequest / recorded callbacks
  wake-bus.ts              # + worker-access-request source, accessRequests on WakeEvent
  multitask.ts             # wire relay: onAccessRequest, clear on abort/settle, resolve → sendMessage
  types.ts                 # SpawnOptions.credentialNames
src/plugin.ts              # Config: accessRequestTimeoutMs; inject += credentials (and approval if used)
prompts/
  worker-access-request.md # tool description, new copy
  dispatcher-access-policy.md  # wake-turn rules for asks / deny wording, new copy
```

Plugin `inject` growth: `credentials` when §9 lands; `approval` / `permissionPresets` only if the adapter actually touches them for stored policy (§6). Rebuild after every `inject` change (`docs/research/plugin-install-workflow.md`).

---

## 13. Test plan (FakeDshHost, no network, no LLM)

Extend the existing suite pattern (drive via `Multitask`, observe fake lists; never assert private helpers or prompt wording beyond presence of the wrapper).

| # | Behavior | Drive | Expect |
|---|---|---|---|
| T1 | Ask wakes dispatcher | `fireAccessRequest` on live worker | `wakeCalls` includes parent session; `listPending` has one ticket |
| T2 | Allow steers answer back | `resolve(allow)` | one `sendMessageCalls` entry for that worker; wrapper mentions continue/do-not-restart; ticket resolved |
| T3 | User deny is honest | `resolve(user-denied)` | deny wrapper names target + reason; no silent empty message |
| T4 | **Unanswered timeout** | inject `schedule` that records fn + ms; fire ask; **never** resolve; run the scheduled fn | auto deny with `reason: "timeout"`; `sendMessage` deny; ticket resolved; user notice available for wake |
| T5 | Timeout cancelled on early answer | fire ask; `resolve(allow)` before timer fn runs | scheduled cancel invoked; running timer fn is a no-op |
| T6 | Abort clears pending | fire ask; `abortWorker` | ticket gone; later timer/resolve no-ops; no `sendMessage` |
| T7 | One-slot | fire second ask while pending | second refused (or ignored by core); still one ticket |
| T8 | Stored policy allow | `lookupPolicy` returns allow | no user-ask wake required; allow steer sent |
| T9 | Stored policy deny | `lookupPolicy` returns deny | deny steer; no hang; honest notice |
| T10 | Unknown class → ask | `lookupPolicy` returns `"ask"` | wake + pending ticket (default deny only after T4) |
| T11 | Credential name never in prompt | spawn with `credentialNames: ["API_TOKEN"]`; later credential allow | `spawnCalls[0].prompt` has no `API_TOKEN` value; allow note may contain the *name* only |
| T12 | Credential value never steered | resolve credential-allow | `sendMessageCalls` contains no secret string (fake has no secret; assert decision shape has no `value` field) |
| T13 | Settle drops late resolve | fire ask; `fireSettled`; then `resolve` | resolve false; no sendMessage |
| T14 | Wake batching | two asks, same parent, idle | one flush / one `WakeEvent` with two `accessRequests` |

**Not unit-tested:** live ApprovalService UI, real CredentialProvider storage, real tool-filter enforcement (ticket 09/10 adapter tests).

**Manual E2E sketch (M2/M3):** worker asks for a write outside workspace → dispatcher asks user → allow → worker continues; second scenario: leave ask unanswered past timeout → user sees "stopped waiting"; third: credential-named allow → tool succeeds without the secret appearing in chat.

---

## 14. Sequencing and ticket 11 relationship

| Piece | Lands with |
|---|---|
| Core types + relay + wake-bus field + FakeDshHost helpers + unit tests T1–T14 | **13** |
| Worker tool `request_access` registration + barrier allow-list addition | **13** (adapter half; needs 09/10 already in tree) |
| Dispatcher wake-turn policy copy for asks / deny wording | **13** prompt asset; assembler hooks from **11** |
| `lookupPolicy` session/profile table | **13**; preset service wiring can stub to `"ask"` until adapter 09 is real |
| Config `accessRequestTimeoutMs` | **13** (plugin Config; flag still from 12) |

Ticket 11 owns dispatcher tools and policy prompts but **not** this relay. 13 can proceed once 11's assembler has a slot for an access section (a one-line extension point is enough — do not block on full copy polish). 12 is parallel: only shares plugin Config shape.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Fighting dsh's approval pin later | Decision is explicit (§2); never set child approval to `ask` for the waterfall path |
| Secret leak into transcript/prompt | §9 forbids (a); tests T11–T12; never log resolved values |
| Timeout too short for a real human | Default 120s; Config; deny is recoverable (user can steer a retry) |
| Many workers asking at once floods the user | One pending ask per worker; batch wake; policy auto-allow for boring classes later |
| Deny looks like a crash | §8 notice + deny wrapper; policy copy requirement on ticket 11 assembler |
| Wake enum churn | Additive only (`worker-access-request`); do not rename existing fields in the same PR if avoidable |
| dsh 0.1.5-rc.1 API drift | Pin version; re-verify Approval/Credential types at 09 integration (`docs/research/dsh-adapter-api-notes.md` §14) |
| Core accidentally holds secret values | `AccessDecision` has no value field; `resolveCredential` optional and adapter-side only |

---

## 16. Acceptance checklist (for the implementer)

- [ ] Worker emits structured `AccessRequest` (tool), never a user channel.
- [ ] Request wakes the dispatcher (`worker-access-request`); ticket visible to policy.
- [ ] Stored policy or user answer is steered back into the **same** worker via `sendMessage` (no restart).
- [ ] Unanswered → deny after `accessRequestTimeoutMs`; test T4 green with a never-answered fake.
- [ ] Deny reported as a denied action to user and worker (not a mute failure).
- [ ] Credentials only via scoped injection; values never in prompt, steer text, or logs.
- [ ] Abort/settle clears tickets; late resolve is a no-op.
- [ ] No reference identifiers, prompt strings, or protocol artifacts; all copy in `prompts/` is new.
- [ ] Core tests remain host-free (FakeDshHost only).

---

## 17. Open points for the implementer (non-blocking)

1. Exact worker tool name (`request_access` vs `ask_parent`) — pick one, keep it in the glossary spirit (no reconstruction names).
2. Whether access notices ride the same flush as settles when both are pending in one idle window (recommended: yes, one wake, two fields).
3. Whether profile-scope policy writes use `PermissionPresetService.set` + a plugin-owned overlay or only our table — prefer our table first, presets as seed, so we do not depend on preset extensibility.
4. ADR-0008 draft from §2 when code lands.
