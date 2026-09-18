# Research: does the reference's subagent runner inherit the shared prompt sections? (R-1 close-out, ticket 62)

- Question: When the reference spawns a subagent runner, does its system prompt go through the same section assembler as the main runner — do the memory and user-identity sections reach it, whose agent profile does it carry, and exactly which sections are dropped or swapped for it? (Settles register item R-1, see `dsh-core-loop-deviations.md` Part C reframing and `reference-agent-prompt-inventory.md` Appendix B.)
- Scope: observation pass over the reference tree only (`source/` of the reconstruction at the repo root). Structure and control flow in our own words; **no prompt prose, identifiers, or string literals reproduced** — provenance is file names + line numbers only. This session read no product code (`src/`, `test/`, `lib/`, `client/`, product `package.json` all unopened).
- Related: `reference-agent-prompt-inventory.md` (Appendix B is the claim under test), `dsh-core-loop-deviations.md` (R-1), ticket 55 (the persona channel that made R-1 relevant).
- Date: 2026-09-19

---

## Answer

**Yes — shared sections reach the subagent runner.** The assembler renders the user-identity and memory sections for subagent runners with **no subagent-specific gate**; the child runner is wired with the same memory/user-memory/project-memory stores as the parent; and the profile section a child carries is the **parent agent's** profile, freshly rendered (children never take the frozen profile snapshot). The subagent prompt differs from the main prompt only by a bounded drop/swap list (below) plus role text. R-1's premise — "we cannot give it a truly minimal system prompt" — is true of the reference too, so R-1 is recommended `not-a-deviation`.

---

## Evidence grades used

- **(a) directly evidenced** — the module and line are recovered source; behavior readable directly.
- **(b) inferred** — follows from (a) evidence plus structure, with the final live call not itself recovered (see the bundled-engine caveat).
- **(c) unobservable in this reconstruction** — no recovered artifact could show it.

**One global caveat, stated once:** the per-turn engine that finally produces each runner's prompt stream is a bundled port that the reconstruction explicitly says was **not recovered as standalone source** (`source/host/runner/runner-production-bridge.ts:51-59`). Everything below is (a) at the recovered modules; the single (b) link is that the child's live prompt is produced by *this* assembler fed with the wired deps. Supporting that link: the reconstruction has exactly one prompt assembler and one runner class for both runner kinds (`source/host/runner/system-prompt-assembly.ts:119`; `source/host/runner/sand-agent-runner.ts:354` — the subagent flag is a constructor boolean on the shared class); the dedicated standalone subagent role-text constructor (`source/host/runner/system-prompt.ts:66`) has **zero recovered call sites** (repo-wide grep, definition only); and the tree's own provenance rule says recovered source may express only artifact-anchored behavior, not invented wiring (`PROVENANCE.md:31-37`). What would settle it to (a): capturing a live subagent's rendered system prompt at runtime, or recovering the bundled constructor.

---

## The four questions

### 1. Does the memory section render for a subagent runner, and under what flag?

**Yes — under the same conditions as for the main runner; there is no subagent gate.**

- The composition adds the memory section unconditionally at `system-prompt-assembly.ts:263`; the builder (`:155-194`) nulls only when the injected memory store is absent (`:156-157`) or the render is empty (`:189`).
- The only flag involved is the **memory-freeze** flag (`:188-193`): with freeze enabled and a snapshot store present, the section replays a frozen render keyed to the compaction epoch; otherwise it renders live. This gate is runner-kind-agnostic.
- The child runner receives the same memory stores as the parent: the spawn-site factory builds the child from the parent's own option bag with the subagent flag set and a blank conversation state (`source/host/host-runner-composition.ts:2445-2457`), then binds it through the **same store-binding step** used for the parent (`:2458` vs `:2605`; the step at `:2586-2596` attaches the session's agent store, memory store, user memory, project memory, and memory-snapshot store identically to every runner it binds).
- Grade: **(a)** for assembler behavior and child wiring; **(b)** for the live link (caveat above).

### 2. Does the user-identity section render for a subagent runner?

**Yes.** Added unconditionally in composition (`system-prompt-assembly.ts:258`); the builder (`:202-205`) has no subagent guard and nulls only when the render comes out empty (i.e., when the request context carries no user name). The child's run pipeline is created from the same session/hooks input as the parent's (`host-runner-composition.ts:2576-2584`), so it shares the request-context path. Grade: **(a)** at the assembler, **(b)** live link.

### 3. Whose agent profile does a child carry — its own, or the parent's?

**The parent's.**

- The profile section's source is the injected profile provider (`system-prompt-assembly.ts:123, :254`).
- For runners bound by the composition, that provider is the session's roster hook (`host-runner-composition.ts:2587`; defined at `source/host/extensions/transcript/runner-registry.ts:236`), which resolves the profile **file of the session it closes over** — the parent session (`source/host/extensions/transcript/profile-watch.ts:133-148`: the profile is read from the session's own directory).
- The child factory closes over the parent's session and hooks and binds the child through the same step (`host-runner-composition.ts:2458`, `:2586-2587`). So the child's profile section carries the **parent agent's** name/description/profile paths — not a child-specific identity.
- Nuance: subagent runners are excluded from the **profile-snapshot lifecycle** (`system-prompt-assembly.ts:130` declines to prepare a snapshot for subagent runners), so while the parent's profile section is a per-epoch frozen render, the child's is re-rendered fresh on every composition of the same parent profile.
- Grade: **(a)** for the wiring and assembler fallback; **(b)** live link.

### 4. Complete list: what is dropped or swapped for subagent runners?

Known-before (per Appendix B / the ticket): the agent directory, and the no-user-channel flag. The full list found:

**Dropped for every subagent runner — (a):**

| # | Section | Evidence |
|---|---|---|
| 1 | Agent directory | `system-prompt-assembly.ts:239` (null when subagent runner) |
| 2 | Send-message capability flag on the spotlight section (the no-user-channel encoding) | `system-prompt-assembly.ts:253` (flag false for subagent runners; the section itself is kept) |
| 3 | Multitask section | `system-prompt-assembly.ts:259` |
| 4 | Appended cloud-disabled section | `system-prompt-assembly.ts:260` |
| 5 | Connector multi-account section | `system-prompt-assembly.ts:261` |
| 6 | MCP custom-instructions host tail | `source/host/runner/prompt-collector-glue.ts:163-166` (also `:173-176`: custom instructions resolve to empty for subagents) |
| 7 | MCP discovery-status host tail | `prompt-collector-glue.ts:168-171` |
| 8 | Box-desktop delegation section (the main-agent "delegate GUI work" copy) | `prompt-collector-glue.ts:262` (null for plain subagent runners) |

**Dropped or swapped only for the two box-scoped subagent kinds (computer-use / browser-use; kind test at `sand-agent-runner.ts:588-622`) — (a):**

| # | Section | Evidence |
|---|---|---|
| 9 | Timezone section (dropped) | `system-prompt-assembly.ts:196-197, :262` |
| 10 | Remote-box section (swapped to a per-kind variant) | `prompt-collector-glue.ts:187-189, :203-214` |
| 11 | Computer/desktop section (swapped to per-kind variants) | `prompt-collector-glue.ts:216-261` |

**Content-level option changes inside the user-info layer — (a):** skills display is disabled for subagent runners (and shared-room runners), transcript listing excluded for subagent runners, and the whole user-info display disabled for box-scoped kinds (`source/host/runner/turn-agent-composition.ts:303-309`).

**Lifecycle (not a section, affects freshness):** profile-snapshot preparation declines for subagent runners (`system-prompt-assembly.ts:130`) — the child's profile section is always freshly rendered.

**Explicitly NOT dropped — the positive list — (a):** base prompt, spotlight section (with the send flag off), agent profile section (parent's), **user identity**, **memory**, automations, workflows, channels, generic remote-box section, and the remaining host tails. A subagent runner differs from the main runner by a bounded drop/swap set, not by a separate minimal composer. (For contrast, the shared-room runner is the case with a real early return — `system-prompt-assembly.ts:256` — emitting only base, spotlight, and profile; the subagent has no such early return.)

**Residual (c):** whether the unrecovered bundled engine applies any additional subagent-only mutation at the final prompt-stream step is unobservable. What would settle it: runtime capture of a dispatched subagent's rendered system prompt, or recovery of the bundled constructor.

---

## R-1 verdict (recommended; disposition is the human's/lead's to set)

Both sections the ticket flagged — **user identity** (`system-prompt-assembly.ts:258`, no subagent guard) and **memory** (`:263`, no subagent guard; freeze flag only) — render for subagent runners, and the child additionally carries the **parent's profile** (`:254` via the parent-session provider, `host-runner-composition.ts:2587`). The reference's subagent therefore does **not** get a blank or minimal system prompt: role text is layered on top of the same shared, inherited sections the main runner gets, with the no-user-channel contract enforced by a flag (`:253`) plus a bounded drop list. That is structurally the same shape as our persona-channel-on-an-inherited-preset arrangement, so **R-1 is recommended `not-a-deviation`** — the worker inheriting a composed preset is fidelity to the reference, not a gap needing `approved-by-necessity` acknowledgment. The refutation outcome the ticket warned about did not materialize: nothing suggests the memory/identity sections are skipped for subagents.

---

## Confidence

High on all four answers at the recovered-module level; the only uncertainty is the single (b) live-link caveat (bundled engine), which cuts across all four equally and is bounded by the one-assembler/one-runner-class structure and the absence of any recovered alternative subagent prompt path.

## Implications for the product

1. **R-1 closes as `not-a-deviation`** (pending the human's/lead's register edit — the researcher does not set dispositions). The persona-on-inherited-preset design matches the reference's structure.
2. **Ticket 55's direction is confirmed**: putting the worker contract in a system-prompt position layered over shared sections mirrors the reference; the "shadow of a shared composer" reading in the deviations note was right.
3. **A fidelity nuance worth noting, not acting on:** in the reference, the shared sections a child inherits include the *parent's* profile and the *user's* identity and *memory* — i.e., the reference's "blank context" is even thinner than "blank conversation": the child also inherits persona and memory context from the parent side. If dsh ever wants *stricter* worker isolation than the reference, that would be a deliberate protective deviation (new register item), not a fidelity fix.
4. The drop/swap list (section 4) is a useful checklist if we ever want subagent-vs-dispatcher prompt differentiation beyond role text — the reference's approach is exactly: keep shared sections, drop dispatcher-only capabilities (multitask, directory, connector management, delegation copy), flip the channel flag.

## Open follow-ups

- Optional (a)-grade confirmation: capture a live subagent's rendered system prompt during an authorized self-test (trivial task only) to close the bundled-engine caveat. Not done here — ticket 62 is offline.
- Ticket 64's reclassification pass under ADR-0018 can consume this note: R-1 moves out of Part C with disposition `not-a-deviation` (recommended).
- Appendix B of `reference-agent-prompt-inventory.md` is now verified; a dated pointer has been added there to prevent drift.

## Method

Read the assembler and its composition/glue call chain in the reference `source/` tree (composition factory → child-runner factory → shared store-binding step → runner class → turn glue → profile provider), greps for every use of the subagent-runner flag and for callers of the standalone subagent role-text constructor (zero found), and the tree's provenance statement for evidence rules. No reference file was modified; no code was run; no network, LLM, or dsh.

## Self-audit (reconstruction codenames)

Case-insensitive grep of this note for the reconstruction's codenames — its product name and the two upstream vendor/brand names (terms deliberately not spelled here, so the audit line itself stays out of the count): **0 occurrences of each** in the final text. `sand` (the upstream bundle's internal prefix) occurs **only inside cited reference file names** (`sand-agent-runner.ts`, `sand-agent-profile-prompt.ts`, `sand-memory.ts`, `sand-user-identity.ts`), which the ticket permits as provenance. No string literals, prompt text, or identifiers from the reconstruction are reproduced; all section references are conceptual descriptions with file:line citations. (First-draft audit line spelled the terms out and self-matched; rewritten to keep both the note and the count clean.)
