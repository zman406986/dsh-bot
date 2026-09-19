# Read before working in or around the reference tree

Scope: anything that opens, reads, cites, or copies from `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` — architecture observation, prompt study, feature inventory, adapted copying.

> **Source note:** this guide was **moved from `AGENTS.md` §Reference-tree copying policy, 2026-09-20** (ticket 97). The ruling's authoritative record is **ADR-0018 (accepted, human-ruled 2026-09-18), exception B9** — `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` — with the PRD's amended copy sections (`PRD-dsh-multitask-dispatcher.md` §3 and §17). This guide **points, it does not restate** — one home per fact.

## The one rule that lives here

Moved from AGENTS.md, 2026-09-20, unmodified:

- The nested folder has its own `.git`. Never commit into it or treat it as the product repo.

## The ruling (read it there, not here)

- **Status of the tree and the copy rule:** ADR-0018 exception B9 — the reconstruction is public with unknown upstream provenance; **no verbatim copying** of source, prompts, tool strings, identifiers, or protocol artifacts; **adapted copying — restructured, independently named, not textually identical — is permitted**. Recorded as a human accepted-risk decision, not a legal clearance.
- **PRD side of the same amendment:** `PRD-dsh-multitask-dispatcher.md` §3 (copy constraints, amended 2026-09-18) and §17 (copy policy appendix) — including that implementers may read the tree and adapt (§3 Process 2); architecture observation and implementation may happen in the same session.
- **Residual risk, full wording:** preserved verbatim in `docs/research/no-verbatim-copy-review-2026-09-19.md` ("a public reconstruction with unknown provenance does not verify that its publisher held rights to the underlying product, and non-verbatim derivative use can still infringe" — human-accepted).
- **S7 grep voided:** the clean-room identifier grep is **voided** as a ship gate (ADR-0018 Consequences; PRD §4 S7 carries the strikethrough). Naming independence is a quality matter, not a compliance gate.
- **Shared-language record:** `CONTEXT.md` §Imitation boundary records the two-trees fact (host tree MIT, safe; reference tree, the behavior spec) under the same B9 amendment.
