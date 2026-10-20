# Peer awareness is pushed into the prompt at the tail: an agent does not have to call a tool to learn who exists

**Status:** agent-drafted 2026-10-18 from the owner's decision 3 (see `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions"); **owner-reviewed and corrected 2026-10-19** — this ADR records what we adopt first, not a ban on anything else. No ADR is superseded. The identity and dispatch choices in §Starting identity and dispatch are a first-implementation proposal, not an owner ruling.

**Numbering:** 0027, the third free number at filing (2026-10-18; 0024 was the highest in use before this pass). Filed by the records pass from the owner's 2026-10-18 decision, recorded in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 3. The human ruled the direction; the text below is the agent's draft of it. Implementation is ticketed separately per repo rule; no source was edited in this pass.

## Context

The 2026-10-18 study found three different answers to "how does an agent learn who exists":

| | Grok Bot 0.18 | DeepSeek-Bot | us (before this ruling) |
|---|---|---|---|
| Discovery | **push** — peer directory rendered into the system prompt every turn, `- Name (id: X) — description`, cap 40 | **pull** — nothing in the prompt; the agent must call `list_bots` | **none** — no registry, no peer rows in `RosterSnapshot` |
| Liveness to the model | none; only an error string on send | rich on demand: `statusOf` reports working / waiting / approval / idle plus tool and target | none |
| Cache cost | pays prompt instability | keeps a byte-stable prompt | n/a |

The trade is real: push guarantees awareness but breaks the cached prefix; pull preserves caching but an agent that never calls the tool never learns anyone exists (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Awareness and discovery"). The owner resolved it: push, at the tail.

## Decision

1. **The peer roster is pushed into the prompt every turn (the owner's ruling).** An agent does not need to know a tool exists in order to learn who exists. This is injected text, not a tool call. A tool-call discovery path may still exist alongside it; the ruling adopts push, it does not forbid pull.
2. **It is appended at the prompt TAIL**, after the stable prefix, so the cached prefix survives. The tail is the part that varies with peer state; nothing earlier in the stable prefix is rewritten to carry it. Exact ordering among tail sections is the implementing ticket's.
3. **It includes liveness and current activity.** The target richness is DeepSeek-Bot's `statusOf` shape: **working / waiting / approval / idle**, plus the **current tool** and the **current target**. The ticket may bring less than that shape; what it brings must be honest and must not invent a status it cannot observe.
4. **The roster is a stable, testable projection with a defined refresh point.** It is derived from live state, so the same state renders the same text; the refresh point is per-turn prompt assembly, and the ticket names it. It carries no saved identities (ADR-0018 C13 binds).
5. **Missing peer state degrades the tail, not the turn.** If peer state cannot be read, the tail says less or nothing rather than showing stale rows as live; the prefix and the turn carry on.

## Starting identity and dispatch (first implementation)

Derived from host evidence in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q2 and §Q4. These are the first implementation's choices; a later ticket may change them by stating the tradeoff.

1. **Session id is the identity the first implementation uses.** Uniqueness, durability, and the address a message needs all come from it. `PeerEnvelope.fromAgentId` is already the sender's own session id, `fromName` is also the session id (`src/core/tools.ts:686-687` — there is no `from` argument), and the peer inbox already dedupes on the envelope. The roster row key is the **session id**. A second identity remains open; introducing one would need its own ticket and ADR-0018 C13 weighed.
2. **`subagent.label` is the first implementation's durable human-readable label.** A session header carries no name. The subagent descriptor does: `label?: string` on one-shot, **`label: string` (required)** on continuable (`dsh-subagent/lib/types/descriptor.d.ts:53-61`, `:70-76`). Because every child we spawn is continuable, every worker already has a durable label — the adapter passes `opts.title` into the activation's `label` (`src/adapter/cordis-dsh-host.ts:829`). Display fallback order is `subagent.label` → the session title → the session id.
3. **The roster reads labels from `projectionValues`.** Per session, `state.projectionsBySession[id].values.subagent.label`, equivalently `sessions.list.getSnapshot().byId[id].projectionValues.subagent.label`. This is the shipped stock subagent UI's own read (`dsh-client-ui-subagent/lib/client.js:827`); no new projection and no new store.
4. **Dispatcher identity is `agentPreset === 'multitask-dispatcher'` — conditional on verification.** Treat this as a **requirement to verify, not a recorded fact.** The `agentPreset` projection is client-visible and durable (declared `dsh-agent-preset-registry/lib/types/types.d.ts:57-60`, folded `.../session.d.ts:34-58`, read by stock at `dsh-client-ui-workspace/lib/client.js:1453`), so the mechanism is sound. But two things must be checked before relying on it: (a) the working tree has **no dispatcher preset row** — the `multitask-worker` row was removed in the concurrent port and workers now inherit the parent's preset, so a preset id must actually exist and be selected at activation for a dispatcher session to carry it; (b) confirm a live dispatcher session's `projectionValues.agentPreset` really equals that id after activation. If either check fails, the roster falls back to session id plus label and records the reduced shape honestly — it does not invent a kind.
5. **Workers are identified by `origin === 'subagent'`, not by preset.** Since workers inherit the dispatcher's preset, `agentPreset` cannot distinguish a worker. `origin` is coarse but durable, and it is the signal left after the worker preset row was removed.
6. **Agent traffic is not user traffic.** The roster is injected text; a peer message reaching a dispatcher is an agent message, and its provenance stays visible (the existing "Peer message — not from the user" heading already does this). It does not stand in for a user message or an approval answer.

## Consequences

- Discovery and status are guaranteed by construction: every turn sees who exists and what they are doing, at whatever refresh the ticket defines.
- The prompt tail becomes variable text. Cache analysis must account for it; the stable prefix is expected to remain byte-stable across turns, and a test should pin that the roster rides in the tail.
- The roster needs a source of truth: live dispatcher sessions and, after ADR-0025, summoned dispatchers. The ruling says "peer" — whether that includes workers is the implementing ticket's call, and whatever it chooses must respect that workers are leaves (ADR-0003 binds).
- The status vocabulary (working / waiting / approval / idle) becomes shared text. If it needs product copy, that copy is the ticket's; this ADR records the shape only.
- **PRD sections needing amendment (ticket-owned, not amended here):** §5 (Peer agent role definition), §6.1 (dispatcher policy gains the roster's existence), §6.4 (wake model's peer row), §7.1 (component map — the roster projection), §7.6 (Phase 2 peers), §10 (prompt assets), §16 (glossary).

## Open questions

1. **Where in the prompt exactly** the tail section sits relative to other injected tail content (standing rules, reminders) — the ticket's.
2. **What the roster includes** — dispatchers only, or workers too — and how a summoned dispatcher (ADR-0025) appears. §Starting identity and dispatch settles *how* each kind is identified; it does not settle *whether* workers are listed.
3. **The refresh point's cost**: assembling and diffing the roster every turn is the ticket's to bound.
4. **Status honesty on dsh 0.2.1**: which of working / waiting / approval / idle can actually be observed on the installed host. The ticket must record what is observable and show a reduced shape if needed, not guess.
5. **Whether a dispatcher preset will exist.** The `multitask-dispatcher` id in §Starting identity and dispatch is conditional on registering one and confirming it lands on live sessions.

## Traceability

- Ruling: `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 3 (level-1 dated human ruling; the ADR text is the agent's draft of it); the trade-off table and the `statusOf` shape are in the same file, §"Awareness and discovery".
- Identity/label/dispatch evidence: `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q2 and §Q4. The choices recorded here are the first implementation's, not a ruling.
- ADRs: 0002 (peers in scope), 0018 (C13 binds — a live projection is not an identity roster; U-H's no-content-search rule is unaffected), 0025 (mitosis creates the peers this roster lists), 0026 (rooms are a separate, optional channel), 0010 (presence-as-projection precedent — the same honesty rule applies).
