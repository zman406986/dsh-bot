# WorkerRecord durable (minimum-to-reconstruct); SteerTicket in-memory

**Status:** accepted

`WorkerRecord` and `SteerTicket` get a **split** treatment. A **durable minimum of `WorkerRecord`** is persisted in the dsh session/job store — just enough to rebuild the live roster across a restart (worker id, transcript pointer, todo link, status). **`SteerTicket` stays in-memory**, matching the reference's single-slot last-wins behavior. Durable worker state is written through the reference's **control-plane obligation-marker idiom** (a small durable marker per outstanding worker, written at spawn) rather than a new store. No second transcript DB. **This is a deliberate divergence from the reference**, not an imitation.

## Context

- PRD §15.7 was the last open item under §15: are `WorkerRecord`/`SteerTicket` durable in the dsh session/job store, in-memory like the reference, or hybrid? Reference recon found the reference keeps the worker registry/records and steer tickets **in memory**, persisting only per-agent transcript/KV state, conversation state including the todo list, and small control-plane obligation files (`docs/research/reference-behavior-notes.md`, §7 result-delivery path; ADR-0005 "Unresolved" note).
- The reference's restart story is **honest amnesia**: a lost worker is reported as unknown-state pointing at its transcript, and the dispatcher may suggest re-dispatch. Nothing is replayed. Recon stated this plainly, so the reference is not being credited with durability it does not have.
- PRD §7.5 and AGENTS.md "Persistence" both forbid inventing a second transcript DB; dsh's `ctx.sessions`/`ctx.storage` are the durable surfaces (`docs/research/dsh-extension-surface.md`, Finding (d)).
- The gaps note already recommended raising the floor: persist worker records and todo linkage to the dsh session store, not a second DB (`docs/research/prd-vs-reference-capability-gaps.md`, Gap 6). Q10's answer adopts that floor, scoped to the minimum-to-reconstruct, and declines it for steer tickets.
- S4 makes the choice product-relevant: "completed" means **delivered to the user**. If a worker's result lands and is never delivered, the todo lies. Across a restart, only a durable roster marker lets the dispatcher notice the undelivered result and finish the job.

## Considered options

| Option | Rejected because |
|---|---|
| **A. Hybrid — durable minimum-to-reconstruct `WorkerRecord`; in-memory `SteerTicket`** | **Chosen.** Keeps S4 honest across restart (the dispatcher can look up an outstanding worker, find its transcript, and finish delivery) while not persisting a value that is overwritten by design. |
| B. Fully durable — persist both | Persists a `SteerTicket` that is single-slot and last-wins by definition: by the time a restart happens, the stored steer is either already delivered or superseded, so the record is dead weight. Over-applies the gaps-note floor. |
| C. Fully in-memory — imitate the reference exactly | Restart turns every in-flight worker into unknown-state. A post-restart user question ("what happened to my task?") has no answerable registry entry, so S4 is only honest for runs that never cross a restart. |

## Consequences

- **Durable (minimum-to-reconstruct):** worker id, transcript pointer, todo link, status — enough to rebuild the live roster and notice an undelivered result after a restart. Nothing else is required to be durable; the transcript itself is dsh's, not ours.
- **In-memory:** `SteerTicket`. A steer is transient by definition (single-slot, last-wins, PRD §7.3 step 4 / ADR-0005 context), so persisting it means persisting a value expected to be overwritten and meaningless after a restart.
- **Obligation-marker idiom:** durable worker state is written as the reference writes its control-plane markers — one small durable marker per outstanding worker, at spawn. This is the mechanism, not a new schema or store.
- **No second transcript DB (unchanged):** the durable marker and roster entries live in the dsh session/job store (`ctx.sessions` / `ctx.storage`); worker transcripts remain dsh's own.
- **Divergence, stated explicitly:** we adopt the reference's amnesia for steer tickets only; for worker records we keep the minimum needed to reconstruct, so a post-restart user question is answerable. This is **our** decision — PRD §15.7's "if the reference is unclear or the human overrides, our decision" case — and no imitation claim is made for the durable half.
- PRD §7.5 amended from "undecided" to this split; PRD §15.7 marked resolved; ADR-0005's "Unresolved" note amended to point here; AGENTS.md "Open decisions" no longer names an open §15 item. `CONTEXT.md` gains no new term: the durable marker is internal, and the glossary's existing "Multitask core" (owns the registry) and "Imitation boundary" (behavior vs scope) already cover it.