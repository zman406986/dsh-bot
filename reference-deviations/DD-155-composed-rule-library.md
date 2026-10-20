# DD-155 — Composed per-model rule library (conditional rule sections)
- **Area:** A18 prompt sections
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference ships a **rule library** rather than a single standing-rules text: a set of separately-authored rule blocks that are selected when the prompt is built. The reference tree's `user-info-composer2-rules.ts` holds the blocks and a selector, and the blocks are grouped into distinguishable families:

- *Instruction-following completeness* — obey every applicable instruction across user, tool, skill and system sources, applying each fully rather than dropping the parts that are inconvenient.
- *Real-environment enforcement* — this is a live machine, not a simulation: investigate by executing rather than by telling the user what to run, retry instead of giving up after one failure, and treat the date field in the environment section as the authoritative current date.
- *Communication style* — a cluster spanning code-citation formatting and fencing, prose quality and density, proportionality to task size, restraint in emphasis markup, avoidance of closing engagement-bait questions, and hygiene of the visible todo list.
- *Conversation-intent reasoning* — infer the user's underlying goal from the conversation arc, and by default read a mid-task message as steering the work in progress rather than as a cancellation.
- *Five named code principles* — read the surrounding code before editing; match existing conventions so additions read as the same author; keep the diff minimal and scoped; add comments only for non-obvious logic; add tests only where they carry real coverage.
- *Tool-specific rules* — per-host-tool guidance for shell usage (backgrounding, process termination), search/grep usage (one broad-glob prohibition), and awaiting a background result (choosing a wait bound defensively).
- *Two opt-in design rules* — a frontend-design intervention and a final-response terseness intervention, each behind its own flag.

Selection is **per model and per feature flag**. The model/flag selector (the reference tree's `user-info-composer2-rules.ts:182`) takes a model-info record and a feature-flag bag; a raw-training-slug model variant returns an empty list, and each block family is included or swapped according to its flag and the model class (e.g. a training-tuned variant substitutes a different communication block and adds a skills/MCP reminder). The same selector also takes the host's tool names as input, so a rule can name the actual shell, grep, or await tool in play. The section-builder entry point (the same file, `:237`) returns both a section node and a rule count.

Assembly is layered by source in the reference tree's `user-info-rule-sections.ts`, whose rule-section composer (`:97`) composes three subsections: always-applied workspace rules; **agent-requestable** rules that are advertised by path and fetched on demand with the host's read tool when relevant; and user-authored rules. The agent-requestable path is the fetch-on-demand part of the machinery — the rule body is not spent up front, only its description and location.

## What the current build does
Absent. The build's prompt composition is two fixed strings. `src/core/policy/prompts.ts` holds the dispatcher policy section (`buildDispatcherPolicySection`, `:77`) and the standing-rules block (`buildStandingRulesBlock`, `:111`) — one static bulleted list, plus the wake/access/peer instruction blocks — all emitted verbatim as a single text with no selection, no model input and no flags. `src/worker/prompt.ts` holds the worker contract (`buildWorkerSystemPrompt`, `:46`), likewise one fixed string. `src/core/policy/assembler.ts` orders these fixed sections into the turn; it selects *sections*, not *rules*, and takes no model or feature-flag input for rule content. There is no rule library, no per-model rule selection, no feature-flagged rule block, and no on-demand rule fetching.

## The deviation
The reference treats the rule layer as a **composed library assembled under conditions**: many small rule blocks, each independently selected by model class, feature flag and host tool names, plus a fetch-on-demand class for rules too large or too situational to inject up front. The build treats the rule layer as **two static texts**. The deviation is the composition machinery — model-specific and flag-controlled selection, and requestable rules — not any individual rule's content.

## Verdict: DO-NOT-INCORPORATE
No recorded ruling covers this specific machinery. ADR-0001 fixes TypeScript as the core language and the build targets a specific host, so the reference's driving reason — swapping rule variants across models with different training profiles and different tool names — has no consumer here; the build composes against one host and one tool vocabulary. The PRD's intent for rule content is the standing-rules block, which already carries the dispatch discipline the build needs, and the overlapping content (communication style per DD-143; the code principles' git-safety core per DD-149/DD-150) is already being handled as *content*, one rule family at a time, without the library machinery. A conditionally-assembled rule library would be prompt weight and selection complexity the PRD never asked for, so the deviation is recorded and not incorporated.

## Incorporation notes
- **Where it would live:** a rule-library module beside `src/core/policy/prompts.ts`, with per-rule selection consumed by `src/core/policy/assembler.ts`.
- **Constraints:** ADR-0001 (TypeScript core) and the single-host target remove the per-model selection reason; incorporation would need a consumer the build does not have. Any single rule family worth adding belongs in an existing block, not a new library.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — a selector, a selection schema, and a fetch-on-demand path are all new machinery with no current caller; high complexity for an unrequested capability.
- **Key reference anchors:** the reference tree's `source/packages/agent/prompts/user-info-composer2-rules.ts` (block definitions and the model/flag selector at `:182`, the section-builder entry at `:237`); the reference tree's `source/packages/agent/prompts/user-info-rule-sections.ts` (the rule-section composer at `:97`; always-applied, agent-requestable and user rule subsections). Families named above, not transcribed.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/prompts/user-info-composer2-rules.ts` (individually-flagged rule blocks; model-info and feature-flag interfaces at `:163`/`:168`; selector `:182`), `.../prompts/user-info-rule-sections.ts` (three-provenance rule assembly, agent-requestable fetch-on-demand at `:59`).
- Build: `src/core/policy/prompts.ts` (`buildDispatcherPolicySection` `:77`, `buildStandingRulesBlock` `:111`), `src/core/policy/assembler.ts` (fixed section ordering), `src/worker/prompt.ts` (`buildWorkerSystemPrompt` `:46`).
- Cross-references: DD-143 (communication style), DD-149/DD-150 (git safety) — content overlap only, not the composition machinery; deviation is the machinery.
