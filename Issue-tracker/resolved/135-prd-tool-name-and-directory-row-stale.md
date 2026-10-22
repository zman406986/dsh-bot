# 135 — PRD §6.3 names a tool that does not exist, and §7.6 keeps a Directory row the ADRs forbid

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** nothing
**Related:** ADR-0018 (decision C13 — no agent-identity roster), ADR-0027 (decision 1 — session id is the identity), ADR-0002 (peer agents in scope, so §7.6 itself stays), ticket 11 (dispatcher tools and policy prompts — the shipped tool names), ticket 125 (chatroom broadcasting — the other §7.6 open row)

## Problem

Two stale lines in the PRD contradict records that outrank it. Both are one-spot wording fixes; neither changes a decision.

### (i) §6.3 line 146 names `check_worker`; the shipped tool is `check_workers`

§6.3 (`PRD-dsh-multitask-dispatcher.md:146`) reads:

> `| Check | `check_worker` or job status UI + tool | List running workers; ...`

The tool that is actually registered is `check_workers`. `CHECK_WORKERS_TOOL = "check_workers"` at `src/core/policy/prompts.ts:9`, and that constant is the second entry of `DISPATCHER_TOOL_NAMES` (`src/core/policy/prompts.ts:53-62`). The singular spelling appears nowhere in `src/`.

The PRD already contradicts itself on this point: §10 line 355 says "`check_workers` is a snapshot tool, not a wait loop", and line 168 (§6.4) says "repeated `check_workers` calls". Exact line numbers above are the pre-edit readings; once line 146 is fixed the file has one spelling.

Cause is a stale draft name, not a decision. No ADR names `check_worker`; no ticket ruled for it.

### (ii) §7.6 line 290 keeps a Directory row the accepted ADRs forbid

§7.6 (`PRD-dsh-multitask-dispatcher.md:290`) reads:

> `| Directory | File or DB of agents: id, name, description |`

This is a saved agent-identity roster. Two accepted ADRs rule it out:

- **ADR-0018 decision C13** (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:28`): "**C13** — No agent-identity roster: no saved/hidden/pinned agent identities, avatars, per-agent persistent chats, or agent info panes as *identity* surfaces. (Dispatchers exist — via sessions — but are not a persistent identity roster.)"
- **ADR-0027 decision 1** (`docs/adr/0027-peer-awareness-pushed-at-prompt-tail.md:31`): "**Session id is the identity the first implementation uses.** Uniqueness, durability, and the address a message needs all come from it. ... The roster row key is the **session id**. A second identity remains open; introducing one would need its own ticket and ADR-0018 C13 weighed."

Authority: the PRD sits below accepted ADRs in the stack (`docs/agents-rulebook.md` §Authority stack, items 2 and 3). Aligning PRD wording to an accepted ADR is not a new decision, which is why this ticket is `ready-for-agent`.

The rest of §7.6 (`Transport`, `Wake`, `Priority`, `Join`, `Bounds`, `Storage`, `Images`) is unaffected. ADR-0002 keeps peer agents in scope, so the section stays; only the Directory row's claim is void.

## What to change

1. `PRD-dsh-multitask-dispatcher.md:146` — replace `check_worker` with `check_workers`. Nothing else on the line.
2. `PRD-dsh-multitask-dispatcher.md:290` — keep the row, append a dated superseded note naming C13 and ADR-0027 decision 1. Do not delete the row: the PRD records history, and a deleted row loses the fact that a directory was ever proposed and why it was ruled out.

Nothing else in the PRD changes.

## Acceptance criteria

- [x] §6.3 uses `check_workers`; `check_worker` (singular, not a prefix of the plural) no longer appears anywhere in the PRD.
- [x] §7.6 Directory row is annotated as superseded with a dated note naming ADR-0018 C13 and ADR-0027 decision 1. The row and its original text stay in place.
- [x] No other PRD line changes from this ticket (`git diff -U0 -- PRD-dsh-multitask-dispatcher.md` shows this ticket's hunks at `:146` and `:290` only; the §13 milestones hunk in the same file is a concurrent edit by another agent, outside this ticket's grant).

## Constraints

- No code change. `src/core/policy/prompts.ts` already ships the correct name.
- No new ADR. The ADRs are already accepted; this ticket only moves the PRD.
- Do not restate §7.6's `Transport`/`Join` amendments; tickets 116/117 already recorded those and they are correct.

## Comments

### 2026-10-22 — filing

Found by the documentation sweep. Verified against the tree rather than against prose: `check_workers` is the exported constant in `src/core/policy/prompts.ts`, and the two ADRs were read at the cited lines before this ticket was filed. Labelled `ready-for-agent` because both edits copy an already-accepted ruling into prose; no human choice is outstanding.

## Resolution — 2026-10-22

Two lines changed in `PRD-dsh-multitask-dispatcher.md`, nothing else.

**§6.3, line 146.** Old:

> `| Check | `check_worker` or job status UI + tool | List running workers; detail: elapsed, tool count, recent activity, transcript path |`

New:

> `| Check | `check_workers` or job status UI + tool | List running workers; detail: elapsed, tool count, recent activity, transcript path |`

The name now matches the registered constant `CHECK_WORKERS_TOOL = "check_workers"` (`src/core/policy/prompts.ts:9`), the second entry of `DISPATCHER_TOOL_NAMES` (`:53-62`), and the PRD's own §10 line 355.

**§7.6, line 290.** Old:

> `| Directory | File or DB of agents: id, name, description |`

New:

> `| Directory | File or DB of agents: id, name, description. **Superseded 2026-10-22** — no directory is built: ADR-0018 C13 forbids an agent-identity roster, and ADR-0027 decision 1 makes the session id the identity. The row is kept as history. |`

The row and its original text are kept; only a dated note follows it. The two authorities:

- ADR-0018 C13 (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:28`): "No agent-identity roster: no saved/hidden/pinned agent identities, avatars, per-agent persistent chats, or agent info panes as *identity* surfaces. (Dispatchers exist — via sessions — but are not a persistent identity roster.)"
- ADR-0027 decision 1 (`docs/adr/0027-peer-awareness-pushed-at-prompt-tail.md:31`): "Session id is the identity the first implementation uses. ... The roster row key is the **session id**. A second identity remains open; introducing one would need its own ticket and ADR-0018 C13 weighed."

Both are accepted, so the PRD is the lower record here and moving it is not a new decision (`docs/agents-rulebook.md` §Authority stack).

Checks run: `grep -n "check_worker\b"` over the PRD now returns nothing outside `check_workers`; `git diff -U0 -- PRD-dsh-multitask-dispatcher.md` shows this ticket's hunks at `:146` and `:290` only. The third hunk it reports, in §13 Milestones, is a concurrent edit by another agent and was not touched by this ticket.

No test, typecheck, or build was run — the change is prose only, and this repo's rule is the smallest test set that can fail. No code was edited.
