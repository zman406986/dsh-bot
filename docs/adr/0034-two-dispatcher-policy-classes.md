# The dispatcher has two policy classes: chief of staff (human-started) and team leader (summoned)

**Status:** accepted (owner-ruled, 2026-11-02/03, in-session) — the owner ruled the direction and supplied the two texts; the text below is the agent's record of it. Reverses the "one policy text for every dispatcher" reading of ADR-0032 (recorded 2026-10-28, implemented by ticket 166). ADR-0032's decision otherwise stands in full; recorded as a dated note on its Status line and its body is not edited.

**Numbering:** 0034, the first free number at filing (2026-11-03; highest in use was accepted 0033). The ruling is recorded on ticket 173 (`Issue-tracker/open/173-two-dispatcher-classes.md`), which implemented the first block; the remaining blocks are ticket 175. No source is edited by this records pass.

## Relation to ADR-0032

ADR-0032 settled the **session shape**: a summoned dispatcher is a new top-level session parallel to its summoner, its header carries no `origin`/`parentSession`/`delegationDepth`, there is no cap of ours, and its open question 1 was answered on 2026-10-29 — it addresses its own user directly.

The 2026-10-28 records pass drew one further conclusion from that shape: if the session is the same, one policy text may serve every dispatcher. Ticket 166 shipped it. **Only that conclusion is reversed here.** Everything ADR-0032 decided stands, including question 1: a team leader is not mute and does not route its work through its summoner.

The distinction this ADR records is the **job**, not the session: the human's dispatcher runs a relationship with one person; a dispatcher another dispatcher summoned runs one large job too big for its context window. Same session shape, different work.

## Context

ADR-0032 removed the structural reason a summoned dispatcher looked different: it is a real top-level session with its own chat and its own sidebar row. The 2026-10-28 reading drew one conclusion from that — if the session shape is the same, the instructions may be the same too — and ticket 166 shipped a single policy text for every dispatcher.

In use the two situations are not the same job. The owner's own description, recorded on ticket 173: the human's dispatcher is a **chief of staff** that talks to one person and delegates their requests; a dispatcher another dispatcher summoned is running **one large job** too big for its context window, and its work is dispatching parts of that job to workers. Same session shape, different job.

## Decision

1. **Two classes, selected at activation.** `user` — a dispatcher the human started in their own chat. `spawned` — a dispatcher another dispatcher summoned. The class is fixed for the life of the activation, the same way ADR-0005 fixed the policy.

2. **The class reaches every model-facing block, not just the session section.** Ticket 173 split the session policy section. The same distinction governs the standing rules injected each turn and the wake-turn instructions: a chief of staff owns the user relationship and decides what the user hears; a team leader owns a job plan and re-chunks it after every settle, reporting upward to the dispatcher that handed it the job while still answering its own user. Copy that names only "the user" as the audience cannot express that.

3. **Both classes answer their own user directly.** ADR-0032 question 1 stands for both. The split is about the shape of the work and who a report goes to, not about who may speak. A team leader is not mute and does not route its work through its summoner.

4. **The class survives a restart.** A cold-resumed summoned dispatcher must come back as a team leader, not fall back to chief of staff. The durable `dispatcher_sessions` mark row already says "this plugin spawned this session as a dispatcher" — a user-started dispatcher has no row — so the class is derivable from the record that exists, with no schema change and no new table. Mechanism is ticket 175's.

What the split does **not** change: both classes keep the same eight tools; the worker contract is one text; the ledger, wake bus, peer lane and delivery paths are shared; no tool description changes.

## Consequences

- The per-session lifecycle holds one more piece of state — which class a live activation is — and it is read at every per-turn reminder and every wake composition. It is dropped at deactivation so a later activation of the same session id cannot inherit a stale class.
- A prompt-block signature gains a trailing class argument. Defaulting it to `user` keeps every existing call site byte-identical and makes a forgotten argument reproduce today's behaviour instead of silently seating a team leader as a chief of staff.
- Both language faces double their work for each split block: two classes × two faces. The parity rule (ticket 153) still binds — authored ZH, same lines, same order, same backticked tool names.
- ADR-0018's copy policy binds as before: the owner supplied the class text, so it is the owner's own copy, not reference-derived text.
- **Downstream prose that was stale is corrected in the same pass:** PRD §6.1 gains the two-class amendment and PRD §10 gains the second prompt asset row.
- Ticket 173's "Known limitation" (the class is not restored after a restart) is retired by ticket 175's item on the durable mark; if that route is rejected at implementation, the limitation is re-recorded there rather than left implied.

## Alternatives considered

1. **Keep one text for every dispatcher.** Rejected by the owner on 2026-11-02/03. It is what ADR-0032's reading produced, and it leaves a team leader holding chief-of-staff rules it cannot follow.
2. **Split only the session section (ticket 173 as shipped).** Rejected here as incomplete: the standing rules and wake instructions are re-injected every turn, so they are the copy a long-running leader actually reads. A leader told "tell the user what you are doing" and "deliver through the user-facing send only" has no instruction to report upward, which is its main channel.
3. **Make the class a per-turn decision.** Rejected. The class describes why the session exists; switching it mid-life would rewrite the policy layer while work is running, which ADR-0005 exists to prevent.

## Open questions

1. **Does the class belong on the durable mark row as an explicit field?** Not needed today: a row's presence already means "dispatcher-spawned", because `parseDispatcherMark` rejects generation 1 and only the spawn path writes a row. A future third class would need a field; that is its ticket.
2. **Do tool descriptions need a class?** Not today — the tools are the same set and the descriptions describe tools, not roles. Revisit only if a class needs a tool the other does not have.

## Traceability

- Ruling: ticket 173 `Origin` line (owner-directed, 2026-11-03; the owner supplied the chief-of-staff and team-leader texts and asked for "a class for dispatcher spawned dispatcher (not human spawned)"), reversing the 2026-10-28 ruling recorded on ticket 166.
- Implementation: ticket 173 (session section, shipped), ticket 175 (standing rules, wake instructions, per-session class record, cold resume).
- ADRs: 0032 (session shape — stands; the "one text" consequence dated-noted), 0025 decision 2 (the summoned peer carries the dispatcher policy — now a dispatcher *class* rather than one text; no supersession needed), 0018 exception B9 (copy policy), 0005 (policy fixed for the session's lifetime), 0007 (a settle completes nothing — the discipline both classes keep).
