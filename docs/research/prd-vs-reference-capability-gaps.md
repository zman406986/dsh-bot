# Research: what the PRD lacks compared with the reference

- Question: If we implement only `PRD-dsh-multitask-dispatcher.md`, what capability areas of the reference reconstruction would we be missing — specifically anything that would hinder the dispatcher's purpose (memory, bot-to-bot conversation, and similar)?
- Scope: local dsh deployment; frontend client excluded (dsh covers it); remote box / computer-use infrastructure excluded; inference routing excluded (dsh owns inference).
- Method: abstract capability inventory of the reference tree (directory/module level only). No source, prompts, tool strings, or identifiers were copied. Every item below is described as a generic product concept; implementation names must be chosen independently per PRD §3/§8/§17.
- Date: 2026-09-15

## Verdict

The PRD fully covers the **dispatch loop** (spawn / steer / stop / wake / todos / delivery). The gaps are in **everything around that loop**: memory, approval paths, non-text delivery, durability, extra wake sources, and the depth of agent-to-agent messaging. None of these break the MVP's success criteria S1–S8, but several will show up within weeks of real use.

## Gap 1 — Memory system (PRD: absent)

The reference has a full per-agent memory subsystem; the PRD's only way to remember anything is the "dsh session/job store" (transcripts), which means recall by re-reading, not durable knowledge.

Reference capabilities, described abstractly:

- Per-agent durable memory directory with two kinds of facts: enduring profile facts about the user, and a dated log of time-stamped facts; one fact per line with dates, truncated to a size limit when injected into prompts.
- Two origins for facts: explicit writes by the agent during turns, and background **synthesis** — a periodic LLM job that reviews recent conversation evidence and emits create/update/remove operations on facts, with dedupe, debounce, retry, and daily refresh.
- Memories scoped by project membership (an agent working in two projects keeps separate facts).

Impact if missing: the "always-on dispatcher" forgets the user and its own bookkeeping between sessions; every restart means starting from nothing. This is the single biggest gap in how the product feels to use.

Recommendation: add a small section to the PRD. MVP: durable per-agent memory store (dispatcher-scoped) plus an explicit memory-write tool; memory text injected into dispatcher prompts under a size cap. Later: a synthesis job implemented as a special internal worker (fits the existing wake/bus model — no new machinery). Check first whether dsh already ships a memory facility; if it does, adapt rather than build.

## Gap 2 — Permission and secret escalation for workers (PRD: silent)

PRD says workers get full work tools and cannot message the user. The reference has dedicated request flows for tool permissions and secrets, plus a local tool-permission controller.

Impact if missing: a worker that hits an approval-gated action (or needs a credential) has no path forward — it fails, or worse, the dispatcher silently stalls a stream. This breaks S4 (never fire-and-forget) in practice.

Recommendation: define a permission relay: worker emits a structured request event → dispatcher wakes → dispatcher asks the user (or applies a stored policy) → answer is steered back into the worker. Define a default denial and a timeout so streams cannot hang forever. Workers, which start with a blank context, should receive secrets only through a scoped injection, never in a way a prompt could reveal them.

## Gap 3 — Non-text delivery and artifact passing (PRD: text-only)

`WorkerSettled` carries `result_summary` text. The reference has attachment handling and inter-agent file transfer as first-class concerns.

Impact if missing: any stream whose product is a file, patch, image, or report document has no defined delivery path; "completed = delivered to user" (§6.5) is then undefined for non-text results.

Recommendation: extend the data model with artifact references (path/hash) on the settle event and on todo completion; dispatcher delivers artifacts alongside the summary. Likely a small amount of code on top of dsh's existing attachment handling.

## Gap 4 — Wake sources: no time-based or external triggers (PRD: user/worker/peer only)

The reference has an automations subsystem: stored automations with triggers, status reminders, external listener integrations, and routine notices. The PRD mentions an "idle reconcile job" only in the risks table.

Impact if missing: "always-on" is a stretch — the dispatcher only thinks when spoken to or when a worker lands. No periodic sweeps (stale todos, undelivered results), no scheduled or routine work, no external event sources (file watchers, webhooks).

Recommendation: make the wake bus independent of where the wake comes from now (it nearly is): add `timer` and `external-event` wake sources. MVP can ship with just the idle reconciler on a timer; routines and automations can be a later phase, but the wake contract should not need to change when they arrive.

## Gap 5 — Dispatcher context hygiene for long streams (PRD: partial)

The reference handles large tool outputs by moving them to storage and keeping the prompt-visible portion small, plus conversation outlining and state management. The PRD's mitigations are `result_summary` on settle and "short dispatcher turns" as policy.

Impact if missing: the dispatcher reads worker reports inline; over a day of parallel streams its own context fills with quoted output, degrading S1.

Recommendation: add prompt-assembly rules: worker reports are capped in size with a pointer to the full transcript; the dispatcher is instructed to quote sparingly and reference by path; check/steer tool results are summarized, not dumped.

## Gap 6 — Crash/restart durability of core state (PRD: explicitly deferred)

PRD §7.5 allows in-memory maps for v1 with "document restart loss." The reference invests heavily in state recovery: persisted agent databases with schema and recovery, a fallback state store, conversation recovery, and handoff services.

Impact if missing: a crash mid-stream loses the worker registry, pending steers, and todo↔worker linkage; on restart the dispatcher cannot reconcile or deliver.

Recommendation: raise the minimum a little: persist `WorkerRecord`s, `SteerTicket`s, and the todo↔worker linkage to the dsh session store (not a second DB). On restart, mark orphans as `interrupted`, tell the user the truth, and offer resume where dsh supports re-entry. No new storage engine needed.

## Gap 7 — Depth of agent-to-agent conversation (PRD Phase 2: thinner than needed)

PRD Phase 2 is a minimal async envelope plus a directory. The reference's messaging layer is much richer: direct and **group** addressing (groups as first-class addresses with members), broadcast announcements, a directory with per-agent name and description, a different wake-up prompt for each kind of source, message size limits, and — notably — **agents creating and managing other agents at runtime**, plus agent profiles, cloning, and per-agent chat threads and channels.

Impact if missing: not an MVP problem (PRD explicitly scopes the messaging hub out), but if Phase 2 is ever implemented as specced, envelopes without conversation or thread identity and group targets will need a breaking schema change.

Recommendation: keep Phase 2 thin, but future-proof the `PeerEnvelope` now: add a `conversation_id` and allow the `to_agent_id` target to be an agent or a group. Decide and record whether agents may create or manage other agents (recommend: dispatcher-only in MVP; workers are leaves). Agent persona and profile fields in the directory are cheap to include from day one.

## Gap 8 — Nested subagents (PRD: unspecified)

The reference has a subagent runtime with management tools (workers spawning their own helpers) and review gates around it. The PRD never says whether a worker may spawn.

Recommendation: one sentence in §6.2: MVP forbids workers from spawning sub-workers (workers are leaves); revisit with an explicit budget if real workloads demand it. Leaving this unstated will produce ad-hoc decisions later.

## Deliberately out of scope (no action)

Confirmed present in the reference but correctly excluded from our PRD: frontend/chat UI, remote sandbox and computer-use (box, VNC, recording/teaching), inference routing across providers, multi-user room sharing, browser/computer tooling, and shipped-UI polish. Also noted but optional for MVP: per-stream usage and token accounting, an action audit trail, an automated review step on agent output, a local content-search index, and an experiments/feature-flag framework (a single flag suffices per §11).

## Cheap mechanisms worth taking as ideas

- **Reminder middleware**: the reference re-injects short behavioral reminders at turn start (acknowledge, use messaging correctly) rather than relying on a one-time system prompt. For us: re-inject the todo list and dispatcher policy highlights on each dispatcher turn — the PRD's "reconcile on wake" covers bookkeeping, but prompt-level reminder injection is a distinct, useful mechanism.
- **Size limits everywhere** (agent-to-agent text caps, directory size caps): consistent with Gap 5.

## Suggested PRD amendments (smallest set)

1. §6/§7: permission relay + default-deny/timeout (Gap 2).
2. §7.5: artifact refs on settle/delivery (Gap 3); the minimum durable core state (Gap 6).
3. §7.4: wake sources become an enum incl. `timer`/`external` (Gap 4).
4. New §: memory (Gap 1) — even if the section is "deferred to post-MVP, design slot reserved."
5. §6.2: workers are leaves — no nested spawns (Gap 8).
6. §7.6: `conversation_id` + group targets in the envelope (Gap 7).
