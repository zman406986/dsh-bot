# 56 — Add the shared safety section to the worker contract (deviation D-3)

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** 55 — **landed**, so this section ships in the `persona` channel as intended rather than on a second path.
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

- [x] The safety section ships in every worker contract. — `## Safety`, appended as the final section by `buildWorkerSystemPrompt()`.
- [x] A test asserts presence in the assembled contract (structural pin, not a snapshot of prose). — `worker-agent-type.test.ts`: the section-heading list now includes `## Safety`, and a dedicated case pins that it is **last** and that the section cannot be silently dropped.
- [x] A test or review note records that the copy is original and does not restate the host's delegation section. — **Both.** The structural test asserts the copy contains neither `permission scope` nor `approval`; the code comment names the host guarantees we lean on and why we do not repeat them.
- [x] `npm test` 0 fail, `npm run typecheck` clean (both configs). — **769 tests / 194 suites / 0 fail**; both tsconfigs clean.
- [x] Clean-room identifier grep over the shipped tree: zero product-tree hits. — Zero hits in `src/` and in the rebuilt `lib/`.

## Comments

### 2026-09-18 — implemented

**What was written** — four lines of new copy, appended after `## Final answer`:

- stay inside the given task; a step the task does not call for is out of scope even when it looks helpful (scope discipline + irreversibility in one line);
- prefer reversible steps, and say so *before* taking an irreversible one rather than after;
- credentials are unavailable as text: refer to them by name only, never echo/log/transmit the value (this mirrors ADR-0008's name-only rule, which the access-relay types already enforce structurally);
- never present work as finished unless observed or otherwise verified — and if an outcome is unconfirmed, say what could not be confirmed.

**Why it is short.** A system section is paid for on every turn of every worker. The reference appends one section for the same reason. The strongest of the four is the last: honest reporting is precisely the failure mode ticket 58's unbounded-delivery gap makes likelier, and the reference's own restart notice carries the same idea.

**How it complements rather than repeats the host.** The host already injects a fixed delegation-scope statement into every child as a system-context section: scope is fixed at start, cannot be widened from inside the session, and approval-requiring operations are rejected automatically. That is the host's guarantee, already stated once. Our section deliberately covers the ground the host does **not**: task discipline, reversibility, secret handling by name, and verification honesty. The structural test pins the non-restatement so the two texts cannot drift into duplication.

**One incidental constraint worth recording:** the copy must avoid the substring `sand`, because the suite's forbidden-vocabulary sweep checks prompts against the reconstruction's codenames with a plain `includes`. That rules out the word *sandbox* in this text — a trivial constraint, but the kind that wastes an hour if discovered by failing a test instead.

## Notes

- Keep it short. A long safety section in a *system* position is paid for on every single turn of every worker; the reference's is one section for a reason.
