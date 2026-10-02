# Borrow-vs-resume session-handle semantics: applicability to our adapter

**Question:** the upstream dsh-grokbot plugin, before using an agent session, either *borrows* a UI-owned live agent (instead of disposing and recreating it) or *resumes* it through a registry, precisely to avoid clobbering a session the user's UI already owns. Does that pattern apply to our adapter?

**Verdict: ALREADY SATISFIED for the dispatcher binding; foreign-session resume is deliberately absent for workers — record as satisfied, no action.** Our dispatcher never owns the chat it activates in, so there is nothing to clobber; our workers are never adopted or resumed by design, and the host offers no resume seam to accidentally misuse.

**Status:** decision input only — this note takes no side for the authority stack (`docs/agents-rulebook.md`, level 8). It is not a ruling and creates no exception-list item.

---

## The upstream pattern

Described in the 2026-10-02 upstream comparison §3 (and the session-identity item of §10): `.scratch/testing/2026-10-02-grokbot-upstream-compare/upstream-findings.md` — a git-ignored scratch artifact, so the load-bearing facts are restated here. Upstream keys one persistent DSH agent session per (conversation, bot) pair; when the plugin needs that session it borrows the live agent already registered by the native UI rather than disposing it, or resumes it through a registry, with precise conflict-message matching so existing history is never lost. The goal: a persistent shared session must survive being driven by both the UI and the plugin without either side clobbering the other.

## Dispatcher binding: attach-and-inject already meets the goal

Our dispatcher activation attaches to a chat the **user owns** and never takes ownership of it:

- **The gate selects user-owned chats only.** Activation accepts a top-level agent — no parent lineage, delegation depth 0 (`src/adapter/parent-agent.ts:14-20`) — and activation is an explicit command in the chat the user chose (`docs/adr/0009-activation-explicit-command-no-capture-on-load.md`; the binder docs, `src/adapter/parent-agent.ts:177-198`).
- **Activate binds and injects; it does not dispose or replace.** `activate` records the live agent in the session map, binds it as that session's dispatcher parent, and injects the session policy into the SAME agent (`src/adapter/parent-agent.ts:298-326` — map set :314, `host.bindParent` :319, policy inject :321-323). The UI-owned session keeps its identity, history, and turn model; nothing is torn down to make room.
- **The inject is queue-only, never a hostile write.** Policy enters through a best-effort context inject that no-ops when the agent lacks the seam and never breaks on failure (`src/adapter/parent-agent.ts:49-57`) — it queues context into the host's turn pipeline rather than interrupting or rewriting anything (the queue-vs-wake distinction is documented at `src/adapter/parent-agent.ts:59-72`).
- **UI turns and dispatcher tracking coexist.** The passive `agent/status` listener observes running/idle per session and only projects: turn bounds onto the wake bus, a per-turn reminder inject, and worker FSM notes (`src/adapter/parent-agent.ts:247-295`). It opens no turns of its own on the user's chat (waking delivery exists but is reserved for activation recovery and settle wakes, `src/adapter/parent-agent.ts:73-80`).
- **Unbinding never disposes.** Deactivation removes the session from the registry and unbinds the parent linkage only (`src/adapter/parent-agent.ts:226-231`); the host-side `agent/disposed` event deactivates exactly the matching session (`src/adapter/parent-agent.ts:233-245`), and unbind reverses every activation the same way (`src/adapter/parent-agent.ts:361-370`). In all three paths the chat itself is left to the user and the UI.

So the upstream pattern's goal — do not clobber live UI-owned sessions — is met by construction: we attach to the session the user already has and inject policy into it, we never dispose it to get our own, and we detach without destroying it.

## Workers: foreign-session resume is deliberately absent

The resume half of the upstream pattern has no counterpart, on purpose:

- **Ownership is provenance, not adoption.** The adapter owns a worker iff it appears in the map populated exclusively at spawn time (`src/adapter/cordis-dsh-host.ts:554-556` — `owns` reads the map; the single write site is `spawnWorker` at `src/adapter/cordis-dsh-host.ts:682-685`). Workers are the plugin's own children, identified by their host child session id (`src/adapter/cordis-dsh-host.ts:680-681`); the adapter never discovers, claims, or attaches to sessions it did not spawn.
- **After a restart the maps are empty, and the rebuild restores records — not sessions.** A fresh core rebuilds from durable markers only: terminal rows are restored onto the roster, and workers that were live at crash time become unknown-state holds (`src/core/multitask.ts:877-900` — hold construction at `src/core/multitask.ts:889-899`). No session handle is reacquired; nothing is resumed. An unknown-state hold refuses re-spawn on the same stream key until explicitly resolved (`src/core/multitask.ts:568-577`; the refusal's documented intent, `src/core/types.ts:99-110`).
- **Replaying work is already ruled out.** Restart replays durable records and never re-runs a worker or re-dispatches work (`docs/adr/0012-restart-replays-durability-never-work-draft-nonhuman-approved.md:11-16`) — resuming a crashed worker's session would be exactly the re-execution this ADR forbids, and the core's own rebuild docs state the non-resume is a design decision, not an oversight (`src/core/multitask.ts:852-865`).
- **The host offers no resume seam to misuse.** The only spawn path creates a NEW child every time — `startContinuable` takes a fresh request spec (prompt, parent, persona) and returns a new child id (`src/adapter/cordis-dsh-host.ts:61-87` for the spec shape, `src/adapter/cordis-dsh-host.ts:674-679` for the call). There is no adopt-existing-session API on our host surface, so the resume half of the upstream pattern is not merely unused but unreachable.

## Conclusion

The upstream pattern's goal (don't clobber live UI-owned sessions) is met by our attach-and-inject dispatcher binding; its resume half is incompatible with our honest-amnesia durability stance (`docs/adr/0012-restart-replays-durability-never-work-draft-nonhuman-approved.md`) and has no host API to attach to. Record as satisfied, no action.
