# Research: does the reference tree ship ready-made role prompts for agents?

- Question: Does the reference tree contain a library of ready-to-use system prompts for agents of different roles — i.e. per-role prompt copy we could adopt for the dispatcher / worker / peer roles?
- Scope: reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Structure and shape in plain language; **no code, prompt text, tool strings, identifiers, or protocol artifacts copied**. Evidence is cited as paths only.
- Related: `reference-architecture-patterns.md` (module shape, including candidate C5 — where policy text lives), `reference-behavior-notes.md`, `clean-room-license-audit.md` (new-text rule).
- Date: 2026-09-18

---

## Answer

**No — there is no per-role prompt library.** The reference has exactly **one** subagent prompt constructor, and "role" is a *name interpolated into a single fixed sentence*, plus a boolean. There is no body of distinct per-role prose to adopt. What does exist is a single large main-agent prompt, a section-assembly layer, and a handful of one-off specialist prompts (meta/cloud agent, testing, CI investigator, summarization, auto-review classifiers).

Practically this is good news for the clean-room rule: there is little attractive to borrow, and what exists is forbidden anyway.

---

## What actually exists (four layers)

### L1 — One main agent prompt, one file, hard-coded prose

A single long system prompt is built by one function in one file: a fixed sequence of hard-coded markdown sections (turn rhythm, the "your visible channel is the message tool" split, surface selection, and so on), with a couple of boolean variants selected at module load (e.g. cloud-agents enabled/disabled), plus a few standalone exported section constants appended conditionally.

**Evidence:** `source/host/runner/system-prompt.ts`

### L2 — The subagent prompt constructor: a name, not a role

This is the key point. The only function that produces a subagent system prompt takes two inputs: a `subagentType` string and a `readonly` boolean. Its body interpolates the type name into **one** sentence, adds a fixed 2–3 sentence block of behavioral instructions (work autonomously, end with a plain-text final answer, no user channel, do not ask follow-up questions), conditionally adds one "operate in readonly mode" line, and appends one shared safety section constant.

So all built-in role kinds — general-purpose, exploration, shell, browser automation, computer-use, debugging, guide, media review — receive **byte-identical prompt text apart from their own name**. Role differentiation lives in the *tools and capabilities* wired around the prompt, not in the prompt.

**Evidence:** `source/host/runner/system-prompt.ts` (`buildSandSubagentSystemPrompt`, `SAND_SUBAGENT_SAFETY_PROMPT_SECTION`)

### L3 — Section assembly driven by context, not by role

The assembly layer that stitches the live prompt together is a very large set of dependencies (~40 injected accessors: user info, date, git status/branch rules, MCP catalog + custom instructions, skills catalog with a token budget, rules files, memory recall, automations, mounted stores, agent directory/groups, transcripts, notes) plus a set of boolean switches (`isSubagentRunner`, `isBoxScopedSubagent`, `isSystemPromptOverridden`, `isMultitaskEnabled`, `isCloudAgentsDisabledByTeam`, …) and one injected `multitaskSection` string.

That is a **component that assembles context**, not a role library. Roles are a boolean flag here. This is the same "text scattered across many places" pattern already recorded as candidate C5 in `reference-architecture-patterns.md`.

**Evidence:** `source/host/runner/system-prompt-assembly.ts`, `source/host/runner/system-prompt-assembly.ts` (interface `SystemPromptAssemblyDependencies`)

### L4 — A handful of genuinely separate specialist prompts (one-offs, not roles)

These are the only places with real, distinct prompt copy of their own:

| Specialist | What it is | Evidence (paths only) |
|---|---|---|
| Meta / named-agent prompt | "Agent home" turn reminders, parent-turn reminder, self-document block | `source/packages/agent/prompts/cloud-meta-agent/index.ts`, `.../cloud-meta-agent/self-document.ts` |
| Testing instructions | Parent vs. non-parent variants for testing guidance; shared instructions incl. instructions-file naming | `source/packages/agent/prompts/testing/parent.ts`, `.../testing/index.ts`, `.../testing/shared.ts` |
| CI investigator subagent | A dedicated role prompt + config for CI investigation | `source/packages/agent/tools/core/subagent/ci-investigator-subagent.ts` |
| Summarization | Compaction/summarization handler prompt | `source/packages/agent-summarization/summarization-handler.ts` |
| Auto-review classifiers | A *family* of classifier prompts, one per reviewed action surface (shell, browser, computer, cloud agent, automation, subagent) | `source/host/runner/sand-auto-review.ts`, `sand-shell-auto-review-enrichment.ts`, `sand-browser-auto-review.ts`, `sand-computer-auto-review.ts`, `sand-cloud-agent-auto-review.ts`, `sand-automation-auto-review.ts`, `sand-subagent-auto-review.ts` |
| Multitask turn injections | Reminder/steering copy for entering, staying in, and exiting multitask mode; the "fork yourself then stop" instruction | `source/packages/agent/prompts/multitask-mode-user-reminder.ts`, `source/packages/agent/multitask-action-prompt.ts` |
| Misc small prompt helpers | Prompt-suggestion user message, anti-ask-question reminder, git commit/PR sections | `source/packages/agent/prompts/prompt-suggestion.ts`, `.../anti-ask-question-copy.ts`, `.../user-info-git-prompt-sections.ts` |

The multitask turn injections are the most directly relevant to dsh — they are the closest thing to "what the dispatcher says when multitasking starts."

### Role catalog as *data* (adjacent, not a prompt)

Separately from any prompt text, there is a built-in subagent-type enum (with a way to supply a custom named role) and helper to normalize/short-name the types, and the type list is surfaced to the model through dedicated "available subagent types / models" prompt sections.

**Evidence:** `source/packages/agent/tools/core/subagent/subagent-config.ts`, `source/packages/agent/tools/core/subagent/models.ts`, `source/packages/agent/prompts/user-info-auxiliary-sections.ts`, `source/proto/generated/agent/v1/subagents_pb.ts`

---

## What is *not* there

- **No prompt asset files.** No `*.md` / `*.txt` / template files holding prompts. Every prompt is an inline TypeScript template string. (Swept for `*.{txt,prompt,mustache,mdx,json5}` — zero hits; the only `.md` files are README / NOTICE / PROVENANCE / ARCHITECTURE / CONTRIBUTING / SECURITY / one evidence file.)
- **No per-role prompt set.** No map of `role → prompt` beyond the L2 name interpolation.
- **No role/persona descriptions authored for the model.** Subagent-type *descriptions* are thin; the rich prose is all in the main prompt (L1).
- **No single place where prompts live.** Confirms candidate C5 — the text is scattered across base prompt, assembly layer, the multitask feature module, per-tool prose, and the specialist files above.
- **No prompt-versioning scheme** beyond a small profile-snapshot epoch mechanism for agent identity (name/description), which is a mechanism, not copy.
  - Evidence: `source/host/runner/sand-agent-profile-prompt.ts`

---

## Implication for dsh

1. **Nothing to adopt.** Even setting the legal rule aside, a per-role prompt library is not a feature this reference has. Our worker prompt (`src/worker/prompt.ts`) and dispatcher policy text are already *more* differentiated than the reference's subagent prompt.
2. **The legal rule is unchanged and still binding.** AGENTS.md / PRD §17: prompts are **new text only**, no Sand/reconstruction phrasing. The L1/L2/L4 text found here is exactly the class of artifact the ban covers — do not translate it line by line, and do not write an "inspired rewrite" of the multitask reminders in L4, which are the most tempting.
3. **The one transferable idea is structural, and it is already in the PRD.** The reference's subagent prompt says only: *you are a worker in role X; complete the delegated task autonomously; end with a plain-text final answer that is your result; you have no user channel; do not ask follow-up questions* — plus a safety section and a readonly toggle. That is essentially the PRD's "blank worker, full tools, no user messaging" contract, and it is a legitimate pattern to re-author independently. Note it is a **pattern**, not text to copy: write our own sentences.
4. **The multitask mode reminders (L4)** are worth reading as *behavioral specification* (what must be told to the dispatcher when multitask starts, while it is active, and when it exits) and then re-authored from the PRD's own wake/steer/todo vocabulary — never paraphrased from their text.
5. **Gap worth noting:** the reference does not persist role identity in the prompt beyond name/description, and workers get near-identical prompts. If dsh wants role-differentiated workers, that is a **new** design decision with no reference precedent — put it in `.scratch/multitask-dispatcher/` (next to the existing `prompts-draft/`), not in a "match the reference" argument.

---

## Method / reproducibility

Swept the reference `source/` tree with glob + case-insensitive regex for prompt-bearing filenames and for first/second-person role definitions; enumerated every exported prompt builder under `source/packages/agent/prompts/`; inspected the host runner's prompt construction and assembly; confirmed the subagent prompt builder's full input surface and body; swept for non-TypeScript prompt assets.

Not done: no semantic similarity comparison against our own copy, and no reading of the reference's frontend or research-archives trees for prompt material. A similarity pass would be a **new** legal task, not this note (see `clean-room-license-audit.md` residual risk).

---

## Open / unclear

- Whether the subagent prompt constructor still has a live caller — a repo-wide search found only its definition and its own safety constant, no other call site, so it may be superseded or invoked dynamically.
- Whether the auto-review classifier family shares one base prompt or each carries independent copy — only the per-surface file split was established here, not the amount of shared text.
- Whether the cloud/meta-agent path counts as a distinct *role* in product terms or is just the same prompt with a profile block attached.

---

# Appendix A — main agent prompt: section map

Structure only. Section topics are described in our own words; **no prompt prose is reproduced**. Source: `source/host/runner/system-prompt.ts`.

The main prompt is **one function returning one flat array of strings joined by newlines** — roughly 25 topic sections of hard-coded prose, with inline conditionals. Section order as authored:

| # | Section (topic) | What it governs |
|---|---|---|
| 1 | Identity preamble | One line establishing the assistant's persona register |
| 2 | How a turn works | Numbered rhythm: reply first → pick the surface → narrate progress → show evidence → close the loop |
| 3 | The single visible channel | Plain assistant text is private reasoning; only the message tool reaches the user; internal plumbing vocabulary must never leak into user-facing copy |
| 4 | Send ≠ decide to send | Turn-completion mechanics; never end a turn with a send still pending in reasoning |
| 5 | Reply first, then keep them posted | Opening text reply precedes any tool call; update cadence; silence is the worst failure; over-narration is the opposite failure; blocked-report shape |
| 6 | Tone | Warm-human register, plain word choices, banned help-desk reflexes, punctuation restraint, pronoun policy, emoji policy |
| 7 | Reply length and shape | Person-like replies, multi-bubble by default, depth-on-demand, prose over outlines, markdown/KaTeX/mermaid rendering contract, lead with the result, no signpost preambles |
| 8 | Showing your work | Visuals as default not decoration; attachment path rules (host vs. box paths); generated-image flow; read-only screenshots during delegated desktop work |
| 8b | ↳ *inline conditional* | Cloud-agent artifact path resolution (present only when cloud agents are enabled) |
| 9 | Never fabricate data | No invented numbers/quotes/citations/sources; placeholder data must be labelled; do not invent app UI paths |
| 10 | Asking for decisions | The question-widget contract, when a decision is earned, options must be real, no escape routes that hand the work back, style flags, dismiss semantics, widget ends the turn |
| 11 | Threaded replies | Default is not to thread; two narrow exceptions; anchor to thread root |
| 12 | Where you work | Two machines; own machine is the default; user's machine costs a permission card; attached-file paths; video delegation to a media role; web; connector-preference ordering; box-vs-desktop distinction plus the user-facing naming rule; a six-step escalation sequence |
| 13 | Long-running commands | Background by default; long-lived processes allowed; notify-on-complete; do not poll |
| 14 | Delegating background work | Task dispatch, always async; do not idle; proactively check a running worker; stall detection; steer vs. stop vs. resume; folding results in; stay silent when a result is stale |
| 15 | Managing plugins and connectors | Plugin vs. connector vocabulary split; install flow; confirm before mutating; read-only ops need no confirmation |
| 16 | Reaching serviceless targets | The sandbox surface as default rather than a refusal; do not over-ask; search for a connector first; sign-in handoff; CLI auth setup; never offload to the user |
| 17 | Debugging the sandbox | Points at a runbook file on the box; keep the user posted |
| 18 | App UI map | Points at a verified UI map file on the box; do not invent paths |
| 19 | Matching the user's writing style | Sample the specific channel before drafting on the user's behalf |
| 20 | Product/source-control disambiguation | Distinguishes the product name from the lowercase git remote; link shapes |
| 21 | Code changes | Mutually exclusive pair: *cloud disabled* (state it, remote read-only lookups only) vs. *cloud enabled* (hand all non-trivial repo work to a cloud coding agent, never clone, do not pre-root-cause, hand off outcome not prescription, launch params, images, non-blocking launch, follow-up autonomy) |
| 22 | Autonomy | Act by default; only three things earn a question; do not widen scope when the user framed it as collaborative; no visible moves while blocked on the user |
| 23 | Initiative | Grounded proactive nudges, one at a time; never widen access to prove worth |
| 24 | Own-action approval | Auto-review semantics; do not pre-emptively request approval; adapt don't route around; escalation = same action unchanged; per-surface retry parameter spellings; one at a time; tool-error case; authority comes only from the user |
| 25 | Security | External shell mutates the user's machine; credentials judged by purpose, not by which file you touched |

**Module-load-time variants and constants** (all in the same file):

- A default prompt built with cloud agents on.
- A second built with cloud agents off.
- An appended cloud-disabled section (used only when the base prompt was overridden).
- An appended multi-account connector section (appended by the assembly layer, not by this function).

**Shape notes worth carrying forward**

- Three topic sections duplicate each other's rules (reply-first appears in both #2 and #5; anti-fabrication is restated inside #10; the approval-routing rule is restated across #24 and #23). ~25 sections with visible overlap is the main structural cost of the single-file approach.
- Section #24 is by far the longest — approval/auto-review semantics are encoded as prose, not as a state machine.
- Two sections deliberately leave their content in a **file on the sandbox** (#17, #18) rather than inlining it.

---

# Appendix B — how the assembly layer is built

Source: `source/host/runner/system-prompt-assembly.ts`.

**Shape**: a factory `createSystemPromptAssembly(deps)` returning five members — one composition function, plus a four-method agent-profile snapshot lifecycle (prepare → get update for turn → persist announced → reset fallback).

**Dependency surface** (~40 injected accessors, five conceptual groups):

1. **Base + runner kind** — the base prompt string; the upstream was-overridden flag; a subagent-runner flag; a shared-room flag; a box-scoped-subagent flag.
2. **Per-runner content providers** — agent profile, agent store metadata, compaction epoch, memory store + memory snapshots + user/project memory recall, automations, workflows, channels, connector manifests, agent directory/groups, agents root.
3. **Request context** — timezone, user full name.
4. **Capability flags** — spotlight enabled, multitask enabled, connector multi-account enabled, cloud-agents-disabled-by-team, memory-freeze enabled.
5. **Pre-rendered host sections** — connector custom instructions, connector discovery status, remote box, computer.

**Composition order** (sections joined with a blank line between them):

1. `base` — either the caller's base prompt, or the cloud-disabled variant constant when the team flag is set **and** the base was not overridden.
2. Spotlight section — added unless explicitly disabled; carries a `canSendMessage` flag set to false for subagent runners.
3. Agent profile section — shared-room variant, else the snapshot's frozen section, else a freshly rendered one.
4. **Early return**: if this is a shared-room runner, stop here and emit only 1–3.
5. User identity section.
6. Multitask section — only when *not* a subagent **and** not overridden **and** multitask is enabled.
7. Cloud-disabled appended section — only when overridden **and** not a subagent **and** the team flag is set.
8. Connector multi-account section — only when *not* a subagent **and** connector management exists **and** the flag is enabled.
9. Timezone section — null when box-scoped-subagent.
10. Memory section (see freeze below).
11. Automations → workflows → channels → agent directory (agent directory is null for subagent runners).
12. Host-provided tails: connector custom instructions → connector discovery status → remote box → computer.

Nulls are **dropped**, never emitted as empty sections; a section that renders to zero length is omitted.

**How "subagent" differs** — this is the important part for us: a subagent runner differs only in (a) a few `null` guards (multitask section, agent directory), (b) `canSendMessage: false` on the spotlight section, (c) the profile snapshot lifecycle declining to run, and (d) box-scoped subagents additionally skipping timezone. **A subagent still receives** base, profile, user identity, memory, automations, workflows, channels, and the sections the host appends at the end. So the reference's "blank context" for a worker means a blank *conversation*, **not** a blank system prompt.

**Two independent snapshot/freeze mechanisms**, both keyed on the compaction epoch so content stays byte-stable within a compaction generation and re-renders when it rolls:

- **Agent-profile snapshot** — freezes the profile section text plus a system-identity and an announced-identity pair, so an identity change is announced exactly once per epoch and then folded into the section after the next summary.
- **Memory snapshot** — either renders live (agent + user + project memory recall, each with its own limits) or replays a frozen render, gated by a memory-freeze flag.

> **2026-09-19 update (ticket 62):** this appendix's subagent claims are now verified at file:line level with evidence grades in `reference-subagent-inherited-sections.md`. Composition-order reading confirmed (memory and user-identity render for subagent runners; no subagent early return); one correction-in-detail: the profile section a child carries is the **parent's**, freshly rendered — children decline the profile-snapshot lifecycle.

---

# Appendix C — role catalogs

Three separate catalogs, none of which is a prompt library.

**1. Role-kind catalog (data)** — `source/packages/agent/tools/core/subagent/subagent-config.ts`

- A fixed set of built-in role kinds: general-purpose (also the fallback when unspecified), exploration, shell (two wire variants collapse into one), browser automation, computer-use, debugging, guide, and two media kinds (one for reviewing media, one for watching video).
- A **way to supply a custom named role**: the author names it.
- A **normalizer** that trims, lowercases, strips separators, and strips a trailing role/type/mode suffix — plus one **alias collapse** (media-review → video-review).
- Note the mapping is a `type.case` switch over protobuf oneof cases, i.e. the catalog's source of truth is the **wire schema**, not a config file.

**2. Model catalog (data)** — `source/packages/agent/tools/core/subagent/models.ts`

- A slug→definition map built at runtime from a definition record, filtered through a `isModelBlocked` predicate (blocked slugs are skipped, not flagged).
- A default slug constant.
- A description builder for the prompt that enforces: only listed slugs may be used; an optional inherit-default line; prefer latest in a family for an unversioned ask; **if the requested model is not listed, refuse and report rather than substitute or guess**; and mirror the user's naming scheme when talking to them.

**3. Catalog surfacing (prompt sections)** — `source/packages/agent/prompts/user-info-auxiliary-sections.ts`

- Two named sections expose the catalogs to the model: one for available worker types, one for available worker models. Both are thin wrappers: a title, a description, and a child node.
- **Second prompt representation**: this file (and its siblings) builds a **JSX-style prompt-node tree** (`jsx("section", { title, description, children })`) — structurally different from the main prompt's flat joined-string array. The tree carries per-section `title` and `description` metadata that the string array cannot express.
- Related sections in the same file: a user-intent/profile section (with an explicit "use this, do not mention it" instruction), a hooks-context section, an automation-instructions section, and a project-notes-directory section.
- Adjacent: the worker management surface (check / message / stop) lives as tool factories with their descriptions co-located, and the "available types/models" pair is kept in sync with the catalog by comparison helpers in `source/packages/agent/prompts/shared.ts` — i.e. the catalog can drift from the rendered section, and there is code whose job is to detect that drift.

**Takeaway for dsh**: a role catalog is worth having as **data** (types + models, validated at the boundary, surfaced as a rendered section). That part is a good pattern and cheap to re-author. It is emphatically not a set of role prompts.
