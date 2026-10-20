# Optional chatroom broadcasting: a dispatcher may address a named room instead of a single agent

**Status:** agent-drafted 2026-10-18 from the owner's decision 2 (see `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions"); **owner-reviewed and corrected 2026-10-19** — this ADR records what we adopt first, not a ban on anything else. It supersedes ADR-0018 exception C14's room exclusion for this product only; the 1:1 peer path is preserved as-is. The bound set in §Starting bound set is a first-implementation choice, not an owner ruling.

**Numbering:** 0026, the second free number at filing (2026-10-18; 0024 was the highest in use before this pass). Filed by the records pass from the owner's 2026-10-18 decision, recorded in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 2. The human ruled the direction; the text below is the agent's draft of it. Implementation is ticketed separately per repo rule; no source was edited in this pass.

## Supersession of ADR-0018 exception C14 (room exclusion only)

C14 currently reads, exactly:

> **C14** — No org chart, no routines/automations subsystem, no per-agent memory, no group rooms.

C14's **room exclusion** ("no group rooms") is superseded **for this product only**: an optional named room a dispatcher may address is now in scope. Everything else in C14 stays as accepted — no org chart, no routines/automations subsystem, **no per-agent memory**. C13 (no agent-identity roster: no saved/hidden/pinned agent identities, avatars, per-agent persistent chats, or agent info panes as *identity* surfaces) also remains as accepted; the ruling names rooms, not identities, so a room's membership encodes no roster of persistent agent identities. C15 (single wake kind) is not amended by this ruling; how room traffic reaches a wake is the implementing ticket's question, and if it needs a new wake kind that ticket must record the amendment rather than assume it.

The amendment is recorded as a dated note on ADR-0018's Status line and the ADR index row, the same pattern ADR-0024 used for ADR-0021/0022; ADR-0018's accepted body is not rewritten.

## Context

Both studied sources ship group chat; we ship none. Grok Bot allows at most 6 members, created only through its UI, with one shared ordered log; responders are @-mentioned members else everyone, round-robin; each member sees only messages since it last spoke (24 cap); a member passes by posting `(pass)`; rounds are bounded by 3 rounds, 10 messages total, 2 per member, stop on an empty round, plus epoch cancel on any new message. DeepSeek-Bot allows 2–12 members; the creator is admin; one shared log of the latest 60 lines that each member reads through its own hidden session via a per-member `seen` cursor (messages are not forwarded); speaker order comes from `@Name` else admin-first; round limit is `members + 4` (`+4` with an admin), with per-member caps, `[PASS]` replies, and a late-round cap of 10; a 15 s grace marks a slot `working` and moves the round on, with the late reply posted afterwards and only the asker notified (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"What each source offers" → Chatrooms).

The owner ruled the optional room in, out of the 2026-10-18 study. The ruling names the source material for bounds but sets no number.

## Decision

1. **1:1 peer messaging is preserved as-is.** The existing `send_peer` path — inbox with dedupe and caps, priority lane, peer wake — is unchanged. A room is an **optional additional** channel.
2. **A dispatcher may address a named room instead of a single agent.** One named group is a valid target; the dispatcher sends into it rather than to one recipient. Addressing syntax, tool surface, and name format are the implementing ticket's.
3. **The first implementation ships the bound set in §Starting bound set below.** Those numbers are chosen from the two references and recorded with their justification, so the ticket builds to something concrete. Other bound shapes remain open; adopting one needs a ticket that states the tradeoff.
4. **First implementation: room messages ride the existing `peer` wake and identity path, with membership by session id.** Session id is the identity the code already has. A user-assigned name field would be a second identity; it is not part of this decision and would need its own ticket and ADR-0018's C13 weighed.
5. **Persistence is dsh's session store; the counters are in-memory.** ADR-0006 and ADR-0018 A5 bind: membership and the ordered log live in dsh's store, never a second database, and never a local content-search index (ADR-0018 U-H). Round, per-member, total-message, and epoch counters are the room turn's in-memory state.
6. **Room membership is a list of session ids, not a saved agent-identity roster (ADR-0018 C13 binds).** A future design that wants saved identities must first clear C13.

## Starting bound set (first implementation)

These are the first implementation's values, chosen from the two references the study compared. The owner delegated the choice ("take the best of Grok Bot vs DeepSeek-Bot, you decide"). Each number's justification — and which four numbers are defaults with no reference-derived truth — is in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q3. A later ticket may change any of them; it states the tradeoff.

| Bound | Starting value | Why |
|---|---|---|
| **Membership** | **2–8 members** | 2 is structural: 1 member is the existing 1:1 path. 8 matches the host's `maxActiveSubagents` default, so a full room can be woken inside one root pool's capacity. |
| **Membership identity** | **session id** in the first implementation | The identity the code already has: unique, durable, already what `send_peer` addresses and what `fromAgentId` carries. A room is `{roomId, memberSessionIds[]}`. A user-assigned label remains open (C13 binds). |
| **Display label** | `subagent.label`, else the session title, else the session id | All three are already client-readable from `useSessions`; no new projection, no new store. `subagent.label` is required on continuable children, so every spawned worker has one. |
| **Speaker order** | explicit `@name` mention first, else **admin-first** (the creator, DeepSeek-Bot style) | An explicit mention is the strongest signal and both references honor it. Admin-first guarantees the room cannot be stalled by members who never take a turn, and nobody is skipped forever. |
| **Round limit** | **`members + 4`, hard cap 8 rounds** | DeepSeek-Bot's formula (one full pass plus slack), plus Grok's hard-cap discipline so a pathological `@`-mention chain cannot walk forever. |
| **Per-member per-round cap** | **2 messages** | The one number both references independently land on; the strongest-corroborated value in the set. |
| **Pass** | post `[PASS]` (or `(pass)`) as a no-op log line | Both references have a pass verb. Accept both spellings; store the message as a no-op line so it still advances the `seen` cursor. |
| **Stop conditions** | empty round; round limit; total message cap **40**; epoch cancel on any new user message | An empty round is the cleanest structural stop. 40 is roughly three full rounds at max membership and exists because room traffic amplifies load — each message can wake N members. **Epoch cancel** (Grok) keeps a room from starving the user: a new user message aborts the in-flight round rather than queueing behind it. |
| **Slow-member grace** | **15 s**, then mark the slot `working` and advance the round | DeepSeek-Bot's mechanism: one slow model must not stall the room. A late reply is still **posted** to the room, but only the **asker** is notified. |
| **Shared log** | latest **60 lines**, each member reads through its own per-member `seen` cursor | DeepSeek-Bot's shape. Messages are **not forwarded** into each member's session; the cursor is what decides what a member has already seen. |

**Which numbers are defaults, not reference-derived truths (recorded honestly).** Four constants have no stated reason in either reference: the **8** member cap, the **15 s** grace, the **60**-line log window, and the **40**-message total. They are adopted here as starting defaults, on the mechanism each serves — not because a reference justified the number. The remaining values are either structural (2 members, session-id identity) or corroborated by both references (2 messages per member per round).

**Other reference values remain available.** Grok's 6-member cap and 24-line log window, DeepSeek-Bot's 12-member cap and `+4` admin bonus, Grok's 3-round / 10-message hard numbers, and DeepSeek-Bot's late-round cap of 10 are not used in the first implementation. A later ticket may adopt any of them by stating the tradeoff.

## Consequences

- A new product surface exists with membership, ordering, and termination policy the project owns. The first implementation builds to §Starting bound set; the implementing ticket records any deviation and its reason.
- The 1:1 peer path and its wake behavior are not redesigned; room traffic rides alongside them.
- Room traffic can amplify load (N members woken by one message). The 40-message total cap and the 8-member cap are the first implementation's budget for that, together with the existing peer wake coalescing.
- ADR-0018 C14's other exclusions (org chart, routines/automations, per-agent memory) still bind.
- **PRD sections needing amendment (ticket-owned, not amended here):** §4 (S9), §6.1 (dispatcher policy), §6.3 (tool table), §6.4 (wake model, peer row), §7.6 (Phase 2 peers), §16 (glossary).

## Open questions

Questions 1 and 2 have first-implementation answers in §Starting bound set; they stay listed so the change is visible. Items 3 and 4 were raised by this ADR's own scope, not named in the ruling, and remain the ticket's:

1. **Membership is by what identity** — first implementation: session id. Display label is `subagent.label`, else the title, else the id. A user-assigned label remains open.
2. **Room termination policy** — first implementation: the merged set in §Starting bound set. Other shapes remain open.
3. **How room traffic reaches a wake**, given C15 is unamended and the ruling does not name a wake kind.
4. **Who may create a room** — the ruling says a dispatcher may address one; it does not say who creates it, and both references create rooms from outside the dispatcher's tool surface.

## Traceability

- Ruling: `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 2 (level-1 dated human ruling; the ADR text is the agent's draft of it); source study in the same file, §"What each source offers" → Chatrooms. The research note's line "decision 2 overrides C14's room exclusion" is the human's instruction.
- ADRs: 0018 (C14's room exclusion superseded for this product only; C13 and the rest of C14 bind; C15 unamended; A5/U-H bind), 0002 (peers in scope), 0006 (persistence stays in dsh's store), 0025 (mitosis gives rooms more members), 0027 (discovery/status at the prompt tail), 0028 (worker reply channel, distinct).
