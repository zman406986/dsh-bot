# 56 — Add the shared safety section to the worker contract (deviation D-3)

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** 55 — this section belongs in the same channel (`persona`), so land it there rather than inventing a second path.
**Related:** register item **D-3**; `docs/research/reference-agent-prompt-inventory.md` (the reference appends one shared safety section constant to every subagent prompt); ADR-0017

## The deviation

The reference appends **one shared safety section** to every subagent prompt. Our worker contract says nothing about safety beyond "don't expand scope", even though workers run with the full work toolset.

## What to write

Author a safety section, clean-room, as part of the contract text that ticket 55 routes through `persona`. Cover at minimum:

- **Scope discipline** — do the task you were given; do not widen it, and do not take destructive or irreversible actions that the task did not call for.
- **Irreversibility** — prefer reversible steps; state plainly when an action cannot be undone.
- **Secrets and credentials** — never echo, log, or transmit secret material; refer to credentials by name only (this mirrors ADR-0008's name-only rule).
- **No user channel** — the worker does not address the user; delivery is the dispatcher's job (S5, ADR-0003). This is already in the contract — the safety section must reinforce, not contradict it.
- **Honest reporting** — never claim completion of work you cannot see or verify. This is worth stating because the reference's own restart notice carries the same idea, and it is the failure mode our unbounded-delivery gap (ticket 58) makes likelier.

## Do not duplicate what the host already injects

The host already adds a fixed `subagent:delegation` **system-context section** to every child: permission scope is fixed at start and cannot be widened, and operations requiring approval are rejected automatically (`dsh-subagent/lib/index.js:519,544-548`). Our section must **complement** that, not restate it — near-duplicate instructions in one system prompt waste tokens and can conflict. Read that existing section's intent first (it is in the installed bundle, and reading dsh's own MIT source is allowed) and write ours to sit alongside it.

## Requirements

- **R1** The safety section is appended to every worker contract, unconditionally — never optional, matching the reference.
- **R2** It complements the host's `subagent:delegation` section rather than restating it. State in a code comment which host guarantees we are leaning on.
- **R3** Copy is **new original writing**. Do not paraphrase or transliterate any reference text, and do not copy the host's section text either.
- **R4** No literal `{{…}}` (it travels through `persona`, which is template-interpolated — see ticket 55).
- **R5** Offline tests only (S8); a structural test pins that the section is present in every assembled contract, so it cannot be silently dropped later.

## Acceptance criteria

- [ ] The safety section ships in every worker contract.
- [ ] A test asserts presence in the assembled contract (structural pin, not a snapshot of prose).
- [ ] A test or review note records that the copy is original and does not restate the host's delegation section.
- [ ] `npm test` 0 fail, `npm run typecheck` clean (both configs).
- [ ] Clean-room identifier grep over the shipped tree: zero product-tree hits.

## Notes

- Keep it short. A long safety section in a *system* position is paid for on every single turn of every worker; the reference's is one section for a reason.
