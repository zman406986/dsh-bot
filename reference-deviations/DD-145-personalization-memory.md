# DD-145 — Rich per-turn injected context vs ledger-only dynamic content
- **Area:** system prompts / persona (A17)
- **Type:** missing-feature (adjacent to a ruled area; filed under more than one record)
- **Date:** 2026-09-23

## What the reference does

Every turn, the reference's prompt assembly adds a large amount of per-turn context on top of the base prompt, in a fixed order: the agent's own profile (name, description, self-edit controls), the user's identity and full name, the user's timezone, three distinct memory stores (the agent's own memory, a user-level store split into a profile part and a recent-history part, and per-project memory blocks, each with its own recall limits) rendered from a snapshot frozen for the whole compaction cycle, so the injected facts stay stable until the next compaction, the agent's existing routines/automations, workflow definitions, chat channels and connector connections, a directory of sibling agents and agent groups, and connector-specific custom instructions plus discovery status. The pattern is that the model never has to be told who it is, who the user is, or what its environment contains — that context is re-stated every turn from live stores.

## What the current build does

The build's prompt code contains no personalization or memory injection of any kind. The primary agent's per-turn dynamic content is exactly one thing: the todo ledger plus a fixed standing-rules block (task state only, with a short note on why each entry closed per ticket 58). Everything else — the dispatcher policy section, wake-turn instructions, access policy, peer-wake instructions, and the worker contract — is fixed text written fresh for this build, assembled once per session or per event. No user facts, no name, no timezone, no long-term memory, and no environment inventory reaches the prompt from build code.

## The deviation

The reference treats the system prompt as a live mirror of the agent's identity, relationships, and remembered history; the build treats it as a contract plus task state. This is a concrete persona-content difference: in the reference the model speaks with knowledge of the user and its own past; in the build the model knows only the rules for delegating work. It is also the largest single gap in the A17 family (the system prompt and persona group of records) — but most of the injected context has no build-side source to draw from, so the gap is not one prompt layer, it is the absence of the stores behind it.

## Verdict: DO-NOT-INCORPORATE

Under ADR-0004 the reference is a feature inventory, not a build list — which features exist is decided by the product goal and the PRD's success criteria S1–S9, and the PRD defines no memory or personalization asset for the dispatcher, so replicating this injected per-turn context is a deliberate no, not an oversight. The substantive capability family (memory across turns and restarts, user identity, routines) is tracked in its own separate record (DD number pending, memory) and depends on that record's own scope decision; this file covers only the point where injected context enters the prompt. Most injected context has no build-side source — no memories, no routines, no channels, no directory — so there is nothing to inject even if the assembly layer existed; adopting any slice means building its store first. If a later ruling adopts part of it, it lands as ADAPT with new copy, never as output made to match the reference's prompt text.

## Incorporation notes
- **Where it would live:** a per-turn context-assembly pass beside `src/core/policy/assembler.ts` (the turn-reminder builder), fed by per-source providers — but each provider needs a build-side store (memory, user identity, timezone, automations, channels, agent directory) that today does not exist.
- **Constraints:** ADR-0004 scoping (adopt only per product goal/S1–S9, the PRD success criteria; log deliberate skips); PRD has no memory asset; the memory-feature family is decided in its own separate records (DD number pending, memory); all section copy must be new copy; an assembly layer must not ship sections whose source stores are absent — an empty section is worse than silence.
- **License note:** ADR-0018 B9 (the no-verbatim-copy rule) — re-derive independently; no verbatim copying of reference prompt text under any circumstances.
- **Effort/risk:** L — not a prompt edit but a family of missing subsystems; the assembly code itself is small, and the stored data behind it is the real cost. Risk of scope creep directly against ADR-0004 if adopted piecemeal without a ruling.
- **Key reference anchors:** the reference tree's `source/host/runner/system-prompt-assembly.ts` — the ordered section assembly and its per-section getters (the memory section with recall from three stores with per-store limits and the frozen-snapshot code that resets when compaction happens, the profile section, the user-identity section, the timezone section, the automations section, the workflows section, the channels section, the agent-directory section); the reference tree's `source/host/runner/sand-memory.ts` (frozen-snapshot mechanism types).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/system-prompt-assembly.ts` (the ordered section assembly and the per-section getters; imports of sand-memory/automation/workflow/channel/agent-directory renderers)
- Build: `src/core/policy/assembler.ts` (assembleTurnReminder — ledger + standing rules only; formatLedgerLine writes the ticket-58 note on why a closed entry closed), `src/core/policy/prompts.ts` (fixed policy/wake/access/peer copy, no personalization), `src/worker/prompt.ts` (fixed worker contract)
