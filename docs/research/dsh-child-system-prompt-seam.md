# Research: the spawned-dsh-child system-prompt seam (ticket 52, Q2)

- **Question (Q2, the load-bearing one):** What base system prompt does a spawned dsh child
  actually carry, and can a plugin set or extend it through a supported seam? This decides
  whether the core-loop fidelity requirement (D-1: deliver the worker contract as a *system
  prompt*, not conversation content) is even achievable on dsh.
- **Scope:** product code (`src/adapter/cordis-dsh-host.ts`, `src/worker/prompt.ts`,
  `src/worker/agent-def.ts`) + the **installed dsh host bundle** at
  `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` (all `@deepseek-ai/dsh-*` packages
  are version **0.1.5-rc.2**; the ticket/ADR cite 0.1.5-rc.1 — same minor, identical seam set).
- **Method:** offline, read-only. Every "available" claim below is tied to the implementing
  line in the compiled bundle, not to a type name or a prior note. The reference tree was not
  opened (clean-room boundary).
- **Related:** `Issue-tracker/open/52-core-loop-fidelity-salvage-audit.md` (Q2), ADR-0017
  (D-1), `docs/research/dsh-loop-capability-map.md` (prior, partly wrong — see §5).

---

## Headline answer

**The seam exists and is wired.** A plugin can deliver the worker contract into a **stable,
system-position** slot on the child via the spawn request's `persona` field. Today we do not use
it — our adapter passes only `request.prompt` (conversation content). So D-1 is **not** a
structural impossibility on dsh; it is an unused seam. But the seam is a *prefix/shadow* of one
section, not a way to blank the child's inherited base system prompt (see §3).

---

## 1. What system prompt does a spawned child carry TODAY?

Trace (product side → host side):

- Product: `src/adapter/cordis-dsh-host.ts:515-559` `spawnWorker` builds
  `request = { prompt, parent, signal, maxDepth, toolFilter? }` and calls
  `ctx.subagents.startContinuable({ provider: "spawn", label, request, signal })`. **No
  `persona`, no `agentOptions` are passed.** The "worker system prompt" we build in
  `src/worker/prompt.ts:8-10` (`assembleWorkerPrompt`) is concatenated *into* `request.prompt`
  — i.e. conversation content, not a system position.
- Host: `dsh-subagent/lib/index.js:1643-1723` `startContinuable` takes `spec.request`, and at
  `dsh-subagent/lib/index.js:1710-1713` delivers `request.prompt` as a **user** message:
  `submitMaterialized(activation, ..., request.prompt, { source: { kind: "user" }, delivery: "queue" }, ...)`.
  So the plugin's assembled text lands as the child's **first user turn**, exactly as the ticket
  describes.
- Host child composition: `dsh-subagent/lib/index.js:542-555` `applyChildComposition` does two
  things that establish the child's *system* prompt:
  1. `childCtx.get("agentPresets")?.composeFrom(childCtx, parent.ctx)` — **the child joins the
     parent (dispatcher) agent's composed preset.** The function's own comment
     (`dsh-subagent/lib/index.js:521-538`) states a child that joins no preset "sees an empty
     tool registry and none of its parent's prompt sections" — so joining the parent brings in
     the parent's full system-prompt section set. The parent here is the dispatcher agent, whose
     preset is the host's base system prompt plus every plugin's prompt contributions.
  2. `childCtx.systemPrompt.context({ name: "subagent:delegation", text: SUBAGENT_DELEGATION_CONTEXT })`
     — a **fixed system-prompt context section** is always added
     (`dsh-subagent/lib/index.js:519,544-548`): *"You are a delegated subagent: your permission
     scope was fixed when you were started and cannot be widened… operations that require
     approval are rejected automatically…"*
- Plus the always-on harness identity section: `dsh-system-prompt/lib/index.js:213-217` registers
  `harness:identity` = *"You are an AI agent powered by DeepSeek Harness."* in every agent's
  system prompt.

**Conclusion (Q1):** A spawned child today carries (a) the **harness identity** section, (b) the
**inherited parent/dispatcher preset** (the host's base system-prompt sections + all plugin
contributions — the child is *not* system-prompt-blank), (c) a fixed **`subagent:delegation`**
system-context section, and (d) the plugin's worker contract only as the **first user turn**
(`request.prompt`). The worker contract is therefore *not* in a system position today.

Note on a prior misreading: the spawn provider sets `inheritsParentContext = false`
(`dsh-subagent-spawn-in-process/lib/index.js:30`). That flag means **conversation** context is
blank ("zero parent context") — it does **not** mean the system prompt is blank. The system
prompt is inherited via `composeFrom`, independently of that flag.

---

## 2. Can a plugin supply / extend it through a supported seam?

**Yes — two wired seams, not display-only.**

### 2a. `persona` → a system-prompt *section* (this is the contract channel)

- Type: `SubagentStartRequest.persona?: string` —
  `dsh-subagent/lib/types/types.d.ts:185-191`: *"Optional per-child persona… becomes a
  `deployment:persona-prefix` section on the child, SHADOWING the deployment's persona for this
  child alone."*
- Forwarding: `dsh-subagent/lib/index.js:1663` captures `request.persona` into the descriptor,
  and `dsh-subagent/lib/index.js:1703-1706` passes `composition: { persona: request.persona, … }`
  into `activations.materialize`.
- Wiring to a system position: `dsh-subagent/lib/index.js:549-553`
  (`applyChildComposition`): `if (composition.persona !== void 0) childCtx.systemPrompt.section({
  name: "deployment:persona-prefix", order: DEPLOYMENT_PERSONA_PREFIX, text: composition.persona })`.
- That section is the **model-facing system prompt**: `dsh-system-prompt/lib/index.js:238-241`
  `section()` registers ordered content assembled before each model step
  (`dsh-system-prompt/lib/index.js:308-358` `assemble`), and a scoped section with the same name
  **shadows** the global one (`dsh-system-prompt/lib/index.js:49-54`, `218-222`). So a child's
  `persona` overrides the deployment's persona-prefix *for that child only*.
- It is **stable across compaction**: system-prompt sections are recomputed from the scope each
  turn, not stored in conversation history. This is precisely the "first-message contract that
  survives compaction" class the ticket asked about — only stronger, since it is not a message at
  all.

### 2b. `agentOptions` → agent config, *not* a system-prompt channel

- Type: `SubagentStartRequest.agentOptions?: AgentOptions` —
  `dsh-subagent/lib/types/types.d.ts:157-162`.
- Wiring: `dsh-subagent/lib/index.js:1652` `resolveChildAgentOptions(parent, request.agentOptions, childDepth)`
  merges it **over the parent route**. The resolved fields are only
  `provider / model / reasoningEffort / maxTokens` (+ the stamped `subagentDepth`) —
  `dsh-subagent/lib/index.js:468-484`. **There is no system-prompt / persona field inside
  `agentOptions`.** So `agentOptions` can change *which* model/provider runs the worker, but it
  does **not** set or extend the worker's system prompt. It is a real, wired seam — just not the
  one D-1 needs.

### 2c. The seams are enforced, not cosmetic

- The in-process `spawn` provider advertises both: `capabilities = { agentOptions: true, persona:
  true, … }` — `dsh-subagent-spawn-in-process/lib/index.js:23-29`.
- The service **rejects** a request that uses a capability the provider lacks:
  `dsh-subagent/lib/index.js:3203-3227` `assertCapabilities` throws `UNSUPPORTED_CAPABILITY`; the
  comment at `dsh-subagent/lib/index.js:2498-2502` states out-of-process backends advertise all
  `false` so the request is *"rejected… never accepted-then-ignored."* This is the opposite of a
  silent/display-only parameter: passing `persona` to a provider that didn't support it would
  throw, confirming it is load-bearing.

**Conclusion (Q2):** Both `persona` and `agentOptions` are real, wired seams. `persona` is the
one that places content in the child's **system prompt** (as the `deployment:persona-prefix`
section). Our adapter currently omits both (`src/adapter/cordis-dsh-host.ts:534-544`), so the
capability is available-but-unused, not absent.

---

## 3. If it cannot be set: equivalent stable-position mechanism (Q3)

It *can* be set (§2a), so Q3's "if not" branch does not apply. Still, two caveats for whoever
implements the fix:

- **`persona` is a prefix/shadow, not a blank-slate swap.** It fills the `deployment:persona-prefix`
  slot and shadows the deployment default, but the child **still inherits the parent/dispatcher
  preset** via `composeFrom` (§1). So a worker using `persona` would carry
  *[harness identity] + [our worker contract as persona-prefix] + [the dispatcher's full
  inherited preset: host base prompt + plugin sections] + [subagent:delegation context]*. The
  contract reaches a stable system position, but the child is not a clean "blank worker with only
  our contract." There is **no seam** in `agentOptions` or `persona` to strip the inherited base;
  achieving a truly minimal worker system prompt would require a separate, parent-light agent
  preset (a host-side change, out of this plugin's reach).
- **`persona` is interpolated like the deployment persona** — strict `{{…}}` template semantics
  against registered variables (`dsh-subagent/lib/types/types.d.ts:187-189`). Our worker copy
  must avoid literal `{{…}}` or it will fail interpolation. Pass plain text (or escape/avoid the
  delimiters).
- `src/worker/agent-def.ts:7-21` (`WorkerAgentDef`) is a **local composition object, not a host
  registry entry** ("Not a host registry object" — `agent-def.ts:9`). There is no
  "register-an-agent-type whose definition carries instructions" host seam being used; the only
  host mechanism that injects instructions into the child is `persona`.

---

## 4. Verdict on the fidelity requirement

D-1 ("contract as conversation content vs system prompt") is **achievable on dsh as installed**,
via the `persona` seam, which delivers the contract into a stable, compaction-surviving system
position. What is *not* achievable without a host change is a fully blank/minimal worker system
prompt — the child always inherits the dispatcher's preset. That residual (inherited base) is a
fidelity *gap* vs the reference's composed-but-parent-independent worker prompt, but it does not
block placing our contract in a system position. So the "rebuild to match the reference" premise
is **not** wrecked by a missing seam; the honest outcome is "adapt the delivery channel (use
`persona`), and accept an inherited base prompt," not "the requirement is impossible."

---

## 5. Correction to prior research notes

- `docs/research/dsh-loop-capability-map.md:50` states: *"The child's base system prompt is
  **unverified**… it sets no `agentOptions`/`persona`, so whatever base prompt the in-process
  spawn provider stamps on the child is **unknown to us**… CLAIMED BY NOTE as
  `inheritsParentContext false` — UNVERIFIED HERE."* — **This is now resolved and partly wrong.**
  - The base prompt is **not unknown**: it is the inherited parent/dispatcher preset plus the
    fixed `subagent:delegation` context + harness identity (§1). The `inheritsParentContext =
    false` flag governs *conversation* blanking, not the system prompt; the prior note conflated
    the two.
  - The `persona`/`agentOptions` seams are **not absent** — they are present, typed, advertised by
    the `spawn` provider, and enforced (§2). The note's "unverified" framing understated a
    verified, usable seam.
- `docs/research/dsh-adapter-api-notes.md:37,53` was actually **correct**: it already listed
  `agentOptions?` and `persona?` on `SubagentStartRequest`. The two notes disagreed; this research
  confirms the API-notes version and corrects the capability-map version.
- ADR-0017 deviation table D-1 (`0017-…md:49`) is logged as *"the base system prompt a spawned
  child carries is unverified."* That cell should be updated: the base is now established
  (inherited parent preset + delegation context + harness identity), and the channel to move the
  contract into a system position (`persona`) is verified-present.

---

## 6. Residual unknowns and what would settle them

These are the only things left unestablished; each has a concrete settling method (no guessing):

1. **Exact text of the inherited parent/dispatcher preset.** Established that the child joins the
   parent's preset (§1), but the precise section list (host base prompt wording, dispatcher-plugin
   sections) was not enumerated. *Settle by:* reading `dsh-agent-presets` /
   `dsh-agent` (`composeFrom` source) and the dispatcher plugin's own `systemPrompt.section`
   registrations; or a trivial live spawn under the AGENTS.md kill-timer rule capturing the
   rendered child system prompt.
2. **Whether `persona` can fully replace vs only prefix the inherited base.** Established it is a
   *shadow of one named section* (§2a/§3), so the inherited base remains; not re-litigated here.
   *Already settled enough* for the verdict; a host preset change would be needed to blank it.
3. **`{{…}}` interpolation behaviour for a non-deployment persona.** Established it uses the
   deployment-persona template semantics (§3). *Settle by:* a trivial live `persona` containing a
   `{{var}}` to confirm throw vs silent-drop, or reading `dsh-system-prompt` `interpolate`
   (`dsh-system-prompt/lib/index.js:151-175`) — already read; plain text is safe, only literal
   `{{…}}` is risky.

---

## Evidence index (all `file:line`)

| Claim | Evidence |
|---|---|
| Product omits persona/agentOptions; contract → `request.prompt` | `src/adapter/cordis-dsh-host.ts:534-544`; `src/worker/prompt.ts:8-10` |
| `request.prompt` delivered as a **user** message | `dsh-subagent/lib/index.js:1710-1713` |
| Child joins parent preset (inherits system prompt) | `dsh-subagent/lib/index.js:543` (`composeFrom`) + comment `521-538` |
| Fixed `subagent:delegation` system-context section | `dsh-subagent/lib/index.js:519,544-548` |
| Harness identity section always present | `dsh-system-prompt/lib/index.js:213-217` |
| `persona` → `deployment:persona-prefix` system section | `dsh-subagent/lib/index.js:549-553`; type `dsh-subagent/lib/types/types.d.ts:185-191` |
| System section is model-facing, recomputed each turn, scoped shadow | `dsh-system-prompt/lib/index.js:238-241,308-358,49-54,218-222` |
| `agentOptions` merged over parent route (provider/model/effort/maxTokens only) | `dsh-subagent/lib/index.js:468-484,1652` |
| Spawn provider advertises persona+agentOptions | `dsh-subagent-spawn-in-process/lib/index.js:23-29` |
| Capability gate rejects unsupported use (not ignored) | `dsh-subagent/lib/index.js:3203-3227`; `2498-2510` |
| `persona` forwarded spec → descriptor → composition → materialize | `dsh-subagent/lib/index.js:1663,1703-1706` |
| `WorkerAgentDef` is local, not a host registry object | `src/worker/agent-def.ts:7-21` |
