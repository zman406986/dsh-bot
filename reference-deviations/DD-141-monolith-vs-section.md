# DD-141 — Monolithic persona prompt vs additive policy section
- **Area:** system prompts / persona (A17)
- **Type:** deliberate-divergence (architecture)
- **Date:** 2026-09-23

## What the reference does

The reference main prompt is one monolithic, self-contained persona document. Its base-prompt builder (the reference tree's `source/host/runner/system-prompt.ts:77-266`) joins a single ~2,000-line array into one string — the file is ~68 KB — carrying the entire operating ruleset as roughly twenty ordered `##` sections (turn rhythm, voice channel, reply-first, tone, reply shape, showing work, fabrication ban, decision widgets, threading, surfaces, long commands, background work, plugin management, unreachable services, box debugging, app UI, style matching, origin/provenance, code changes, autonomy, initiative, approvals, security). This constant is the default base prompt (lines 267-269, wired at `host-runner-composition.ts:1340-1342`).

Assembly (the reference tree's `system-prompt-assembly.ts`, its system-prompt entry point, lines 249-266) starts from that base and appends ~15 conditional sections (spotlight, agent profile, user identity, multitask, cloud-agents-disabled, MCP multi-account, timezone, memory, automations, workflows, channels, agent directory, MCP custom instructions/discovery, remote box, computer). Note the reference already reserves a slot for injecting a multitask section behind a multitask-enabled flag (line 259) — yet all core persona and even its own background-delegation doctrine lives in the monolith itself; the slot only carries extras.

## What the current build does

The build contributes only a compact three-heading policy section — `# Multitask dispatcher` / `## How you work` / `## What you never do` (`buildDispatcherPolicySection`, `src/core/policy/prompts.ts:77-108`) — injected once per session via `assembleSessionPolicy` (`src/core/policy/assembler.ts`), wired at `src/adapter/parent-agent.ts:322` as `tryInject(agent, assembleSessionPolicy(true))` with the enabled argument hardcoded `true` (matching ADR-0018's always-on ruling, which superseded the ADR-0005 flag that the doc comment at `prompts.ts:74-76` still mentions — an out-of-date comment, not a live flag). Short event bodies (peer wake section, standing-rules block) ride alongside as separate channels. Base identity, tone, reply shape, and all other operating rules are left entirely to the dsh host's stock prompt.

## The deviation

The reference defines the whole agent persona — who the assistant is, how it talks, how it replies — inside one giant document that the dispatcher product owns end to end, with conditional sections appended around it. The build inverts the ownership model: it owns nothing about persona and injects only a small additive dispatcher-policy section into a host-owned prompt. Same injection direction (base + appended sections), opposite division of content.

## Verdict: DO-NOT-INCORPORATE

The additive-section approach is the delivery shape the PRD records — PRD §10 says the prompts are delivered as separate files (e.g. `prompts/dispatcher.md`), not a replacement base persona — and it is structurally required: this project is a Cordis plugin that must not own or overwrite the host's base prompt, per the PRD's non-goals (no dsh runtime rebuild) and §12's adapted-copy scope. ADR-0018 voided the flag/kill-switch framing (the hardcoded `true` wiring is correct), and its B9 copy policy bars verbatim copying of the reference's persona prose in any case. The monolith is the reference product's own persona asset, not dispatcher behavior; the dispatcher-relevant content it contains has already been condensed into the policy section.

## Incorporation notes
- **Where it would live:** nowhere in the plugin — a plugin can only contribute prompt sections, never replace the host base prompt. If deeper persona blending were ever wanted, it would have to be negotiated with the dsh host's own system-prompt builder (a host-side change, outside this project's scope).
- **Constraints:** injection stays once-per-session and always-on (ADR-0018, no flag/kill switch); the section stays small and additive; identity/tone content stays out of the dispatcher section (host owns it); per-turn reminders and event bodies remain separate, shorter channels; fix the out-of-date ADR-0005 comment at `src/core/policy/prompts.ts:74-76` opportunistically.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying of reference prompt text under any circumstances.
- **Effort/risk:** S — no action required; the only risk is a future "enrich the policy section" move that drifts into persona/tone territory and collides with host-owned identity and B9.
- **Key reference anchors:** the reference tree's `source/host/runner/system-prompt.ts:77-266` (the base-prompt builder, the monolith), `:267-271` (the default base-prompt constant), the reference tree's `source/host/runner/system-prompt-assembly.ts:249-266` (the system-prompt entry point; multitask slot at 259), the reference tree's `source/host/host-runner-composition.ts:1340-1342` (base-prompt wiring).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/system-prompt.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/system-prompt-assembly.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/host-runner-composition.ts`
- Build: `src/core/policy/prompts.ts` (77-108 policy section; 64-68, 110+ event bodies); `src/core/policy/assembler.ts` (`assembleSessionPolicy`); `src/adapter/parent-agent.ts:322`
- Intent docs: `PRD-dsh-multitask-dispatcher.md` §10 (line 347: deliver as separate files), §11.5 (lines 112/357/409: flag voided, always-on per ADR-0018); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (B9 copy policy, line 27)
