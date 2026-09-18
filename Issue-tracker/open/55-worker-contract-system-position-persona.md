# 55 — Deliver the worker contract in a system position (deviations D-1 and D-2)

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none for implementation. Reads as a *fidelity restoration*, so ADR-0017 does not require new human approval — removing a deviation is compliance.
**Related:** register items **D-1** and **D-2** (`docs/research/dsh-core-loop-deviations.md` Part A); evidence in `docs/research/dsh-child-system-prompt-seam.md`; ADR-0017; ticket 56 (the safety section belongs in this same channel)

## The deviation

The reference composes a subagent's contract as a **system prompt** — a dedicated constructor, always in the system position. We concatenate our contract into `request.prompt`, which the host delivers as the child's **first user turn** (`dsh-subagent/lib/index.js:1710-1713`). So our worker contract lives in conversation history, where it can be compacted away, rather than in a stable system position.

**D-2 rides along:** the reference re-composes the subagent prompt *every turn*, so the contract is restated after each steer. We restate only the correction frame.

## The fix — one field, and it fixes both

Pass the contract through the spawn request's **`persona`** field. Verified against the installed host (v0.1.5-rc.2):

- `SubagentStartRequest.persona?: string` (`dsh-subagent/lib/types/types.d.ts:185-191`).
- It renders into the **`deployment:persona-prefix`** system-prompt section — `childCtx.systemPrompt.section({ name: "deployment:persona-prefix", order: DEPLOYMENT_PERSONA_PREFIX, text: composition.persona })` at **`dsh-subagent/lib/index.js:549-553`**.
- That section is **model-facing and recomputed every turn** (`dsh-system-prompt/lib/index.js:238-241,308-358`) — so it survives compaction *by construction*, because it is not a message.
- It is **scope-shadowed**, so it applies to that child alone (`dsh-system-prompt/lib/index.js:49-54,218-222`).
- It is **enforced, not cosmetic**: the in-process `spawn` provider advertises `persona: true` (`dsh-subagent-spawn-in-process/lib/index.js:23-29`) and the service *throws* `UNSUPPORTED_CAPABILITY` rather than accepting-then-ignoring (`dsh-subagent/lib/index.js:3203-3227`).

**Because a system section is recomputed every turn, D-2 needs no separate work.** Do **not** start appending the contract to steer messages — that would be a second, worse mechanism for the same guarantee.

## What to change

1. **`src/adapter/cordis-dsh-host.ts:534-544`** — add `persona` to the spawn request built by `spawnWorker`. Today it passes `{ prompt, parent, signal, maxDepth, toolFilter? }` and neither `persona` nor `agentOptions`. **Do not use `agentOptions`**: it is wired but carries only provider/model/reasoningEffort/maxTokens (`dsh-subagent/lib/index.js:468-484`) — it is not a prompt channel.
2. **`src/worker/prompt.ts`** — `assembleWorkerPrompt` currently returns one assembled blob that is concatenated into `request.prompt` (`src/adapter/cordis-dsh-host.ts:524-527`). Split it: the **contract** (role, autonomy, limits, work style, final-answer shape — and after ticket 56, safety) becomes the `persona` text; the **task brief** stays in `request.prompt`. Keeping the brief in the first user turn is correct and matches the reference's "blank *conversation*".
3. Add `agentOptions` only if a model/provider override is separately wanted — out of scope here.

## Cautions

- **`{{…}}` interpolation.** `persona` uses strict deployment-persona template semantics against registered variables. Our worker copy must **not** contain a literal `{{`/`}}` or it will fail to interpolate. Check the assembled contract text for braces and add a test that pins this.
- **The residual is real and accepted.** `persona` is a prefix/**shadow of one section**, not a blank-slate swap. The child still inherits the dispatcher's composed preset via `composeFrom` (`dsh-subagent/lib/index.js:543`). A truly minimal worker system prompt needs a parent-light **agent preset** — a host change outside this plugin. That residual is register item **R-1** and is pending the human's acknowledgment; it is *not* something this ticket can fix, and it must not be faked.
- **"Blank context" is unchanged.** `inheritsParentContext: false` blanks the *conversation*, not the system prompt. Do not treat this ticket as changing worker blankness.
- **Do not lose the current contract's content.** Our contract is a strict superset of the reference's and the audit found it *more* differentiated. This ticket moves it; it does not trim it.

## Requirements

- **R1** The contract reaches the child in a system position, verified by asserting `persona` is passed at the spawn call site.
- **R2** The task brief still arrives as the child's first user turn.
- **R3** No literal `{{…}}` in the persona text; a test pins it.
- **R4** The contract is present on every turn by construction — assert it is a system section, not a message. Do not add per-steer restatement.
- **R5** Offline tests only (S8). No network, no LLM, no running dsh.
- **R6** Clean-room: author from `reference-core-loop-spec.md`'s concepts. Never open the reference tree. The shipped tree must not gain any reconstruction identifier (AGENTS.md ban list) — run the identifier grep as a gate.

## Acceptance criteria

- [ ] `spawnWorker` passes a `persona` composed from the contract half of `assembleWorkerPrompt`; brief and contract are demonstrably separate in the assembled request.
- [ ] A unit test asserts the spawn request carries `persona` and that the brief remains in `request.prompt`.
- [ ] A test asserts the persona text contains no unescaped `{{`/`}}`.
- [ ] No per-steer contract restatement was added (assert the steer path is unchanged).
- [ ] `npm test` 0 fail, `npm run typecheck` clean (both configs).
- [ ] Clean-room identifier grep over the shipped tree: zero product-tree hits.

## Notes

- **Do not verify this by reading the reference tree.** The evidence for the seam is in `dsh-child-system-prompt-seam.md` with `file:line` cites into the installed host bundle.
- The live browser/deep verification belongs to ticket 33's lane, not here.
