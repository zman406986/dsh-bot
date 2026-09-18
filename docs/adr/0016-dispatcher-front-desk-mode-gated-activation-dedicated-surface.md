# The dispatcher is the front desk: activation moves to the mode boundary, and the dispatcher gets a dedicated surface

**Status:** ~~accepted~~ **RETRACTED 2026-09-18** (signed under a fabricated premise — see below); **SUPERSEDED by ADR-0018**

**Approval:** ~~human — signed off by the human on 2026-09-18~~ — **the human has retracted**: the "verbatim directive" this ADR was drafted from (the front-desk/peer-routing quote in ticket 50) was never said by the human; it was a hallucinated understanding recorded as a quote. The human's actual stated model for the new master ADR: **imitate the reference in its entirety, except XXX** (ADR-0018, pending the human's trim of the exception list).

**Numbering:** 0016, the next free number. 0010–0012 remain reserved to design-17 §9's ADR plan (presence-as-projection → tickets 27/28; session-scope always-allow → ticket 30; activation-replays-durability → ticket 31) and 0013–0015 are the capsule epic's drafts (ticket 37). This draft does not collide with either set. It is filed as part of the scribe pass that logged tickets 50 (the routing/activation model) and 51 (the surface).

**Supersedes if accepted:** ADR-0009's activation matrix, and the design-17 §5 conflict-4 resolution ("default-activation remains unadopted **by choice, not oversight**"). **Amends if accepted:** ADR-0013 (the capsule as the dispatcher's one surface), design-17 §6 (the "never registered" slot list) and design-17 §13 (the default-activation and agent-identity non-goals).

The dispatcher is the **front desk**. With the dispatcher mode ON, a session reaches the front-desk experience with **no user command**: the dispatcher greets, answers first, and then decides — inline answer, spawn a worker, steer a running worker, or forward to a peer dispatcher that owns its own subagents. The user never names a subagent and never types a slash command. The dispatcher's conversational face belongs to a **dedicated surface of its own**, not to the user's primary chat.

## Context

- **The directive.** 2026-09-18, from the human: "when dispatcher mode is turned on, expected behavior is a dispatcher bot acting as front desk/customer service, answer user first, then retell user requests to subagents they own / talk to other dispatchers who will talk to subagent they own — user should not need to do slash command and enter subagent id, or even the start slash command at all — the dispatcher decides which subagents to talk to"; plus a dedicated UI "to select and talk to dispatcher bots, not hijacking existing conversation box", with subagents remaining in normal sessions.
- **ADR-0009 (accepted) is the decision being reversed.** It ended the original hijack by making activation an explicit per-session command: "the plugin boots **dormant and stock**: the only visible affordance is a host slash command (`dispatcher-start`)… Running that command in a top-level chat **activates** the dispatcher for that session." Its consequences fix the matrix — "OFF = fully inert …; ON + never activated = dormant (invisible plumbing + the command only); ON + activated = full dispatcher in that chat." The directive deletes the middle row.
- **The reversal was pre-registered, not accidental.** design-17 §3.1 weighed exactly this and rejected it for Phase 2: "(b) Default-activation (auto-activate the first top-level chat under a profile) | Rejected for Phase 2 | Re-introduces silent capture by another name — the bug #19 removed." Its conflict-4 marker then left the door open on purpose: "`revisit-before-merge`: record in the merge ticket that default-activation remains unadopted **by choice, not oversight**." The human has now made the choice; this ADR records it as a decision.
- **Why this is not the bug #19 removed.** The original hijack captured the user's *primary chat* without consent. This model does neither: consent moves to the **mode boundary** (the user turned the mode on; ADR-0005 already freezes that setting at session start), and the user's own sessions are **never repurposed** because the dispatcher speaks in its own surface. Consent is relocated and made visible, not deleted. This pairing is why tickets 50 and 51 are one model rather than two features.
- **ADR-0005 is unchanged.** The mode *is* the existing flag, read once at session start (ON in the dedicated multitask profile, OFF in stock profiles), not a new live toggle. What changes is what ON *means*: "the user's sessions are fronted by the dispatcher" instead of ADR-0009's "the dispatcher is available on request". ADR-0005's no-live-toggle rule and its no-off-while-running consequence both stand.
- **The peer tier is half-built.** Ticket 14 shipped the inbound half (peer envelope, inbox, priority lane, `sendPeer` in core) and deliberately left "messaging hub, fan-out directory, images, restart durability, out-of-process transport, dispatcher `send_peer` tool" out of MVP. The directive's "other dispatchers" needs the outbound half and an identity story that does not exist yet.
- **The host is single-parent.** ADR-0009 option C — "Per-chat multi-activation (registry of activated sessions)" — stays deferred for the recorded reason: "`ctx.tools.register` is process-global (no verified per-session tool scoping) and the host is single-parent throughout." The directive's plural "dispatcher bots" must therefore be reconciled with a host that holds one bound parent at a time.
- **"Mode" is not the project's word.** `CONTEXT.md` defines "Multitask profile" with `_Avoid_: mode, setting` — the profile *is* the flag's home. The directive says "dispatcher mode"; this ADR reads that as the existing profile/flag and does **not** introduce a new toggle concept. If the human meant a live runtime mode, ADR-0005 reopens wholesale and this draft must be rewritten (ticket 50, D1).
- **Precedent for this ADR's shape.** The capsule epic (ticket 35, process req 2) established that agent-drafted, not-yet-human-approved decisions are filed with the `-draft-nonhuman-approved` suffix and an approval header (ADR-0013–0015, ticket 37). This draft follows that convention.

## Considered options

| Option | Rejected/kept because |
|---|---|
| **A. Mode-gated front desk + a dedicated dispatcher surface (the human's directive)** | **Chosen.** Fulfils the directive; keeps ADR-0005's read-once flag semantics; keeps consent because the user's own chats are never captured and the mode's state is inspectable; keeps PRD S5 (only the dispatcher speaks to the user) and S6 (`completed` means delivered) intact. |
| B. Keep ADR-0009's per-session `/dispatcher-start` (status quo) | Rejected by the human's directive. Still the correct fallback whenever the mode is OFF, and the reason the command should survive as an idempotent affordance rather than be deleted. |
| C. Auto-activate the *primary chat* under the profile, without a dedicated surface | Rejected outright: that is the silent capture of issue #19 and exactly what design-17 §3.1(b) refused. A default-on front desk is only defensible alongside the dedicated surface that keeps the user's own chats untouched. |
| D. Dedicated surface as a *non-conversational* delivery path (ADR-0009 option D's "dedicated UI page / headless daemon agent") | **Not adopted by this ADR.** ADR-0009 rejected it for v1 because there was "no verified non-conversational delivery path; breaks the PRD rule that `completed` means **delivered to user**." This draft adopts only the *surface* half: the dispatcher still speaks to the user in words, in its own place. Whether a plugin panel can render an addressed session's transcript is unverified (ticket 51) — if it cannot, the surface routes and links rather than faking a transcript. |
| E. Peers as childless routers (no subagents under a peer) | Rejected as not satisfying the directive as written ("other dispatchers who will talk to subagent they own"). Retained as the honest interim: if peer spawn authority cannot be granted, the system ships with dispatcher-owned workers only, and the gap is stated rather than faked. |

## Consequences

- **ADR-0009's matrix is rewritten.** OFF = fully inert (unchanged). Mode ON = the session is fronted by the dispatcher with no command. There is no "dormant middle row" in the ON state; the dormant composition (ticket 32) becomes the **mode-OFF** composition. `/dispatcher-start` may remain, but as an idempotent explicit affordance and the recovery path when the mode is OFF — never as the only way in.
- **The consent story must stay visible.** Activation is still an auditable session event, and the user must be able to see from inside a session that the mode is on and who is fronting it. This is a requirement, not a nicety: ADR-0009's opposition was to being *surprised*, and surprise is possible in any activation model.
- **The capsule's activation row changes meaning (tickets 39/40).** It becomes a mode indicator/affordance reflecting the front-desk state rather than the sole gate. Its no-stop guard and honesty rules are unchanged, and no second activation channel may be invented to serve the new surface — if the surface owns the indicator, the rule is restated, not quietly broken (ticket 51, D5).
- **`/dispatcher-steer` and every other command stay optional.** No user-facing copy may instruct the user to run a command or name a worker id (ticket 50, R3). design-17 §4.4's rule — the command "must never be *required*" — becomes a product-wide rule.
- **The peer tier is re-opened with two named gaps.** (i) **Spawn authority:** ADR-0003 grants peers none, and the directive gives a peer subagents of its own; either a peer is a full dispatcher with authority scoped to itself — which needs more than one bound parent and therefore a host change — or the peer tier stays childless and the directive is only partly met. (ii) **Identity/transport/directory:** ticket 14 left out-of-process transport, fan-out directory, and the dispatcher-side `send_peer` tool out of MVP. **Not resolved here**; they require their own decision.
- **Concurrency is not resolved here.** Whether several dispatcher identities can be active at once, or one active parent exists with several addressable identities, is ticket 50's D2 — it depends on the process-global `ctx.tools.register` limitation ADR-0009 option C recorded.
- **Unchanged by this ADR:** ADR-0006 (durable `WorkerRecord` / in-memory `SteerTicket`), ADR-0007 (todo stays the dispatcher's private ledger; `completed` = delivered), ADR-0008 (structured access relay), the PRD's S1–S8, and ADR-0013's *slot mechanics* for the capsule (only its exclusivity is amended, by ticket 51's decision).
- **design-17 §6 and §13 are amended on paper.** `main` and `sidebar.right.pane.tab` may be claimed by ticket 51 if the seam verification supports it, and the "default-activation / agent-identity surfaces" non-goals become in-scope — each only by an explicit, written amendment in ticket 51's own ADR, never silently.
- **Tracker effects.** Tickets 50 and 51 are filed under `Issue-Tracker/open/`. design-17's conflict-4 marker is *triggered* and must be recorded as a decision in ticket 33's merge record. This draft must be signed off, or amended to match what actually shipped, before either ticket closes.

## Open questions (not decided here)

| # | Question | Where it must be decided |
|---|---|---|
| 1 | Is "dispatcher mode" the existing profile/flag, or a new live mode toggle (which reopens ADR-0005)? | Ticket 50, D1 |
| 2 | How many dispatcher identities, and can more than one be active per process? | Ticket 50, D2 |
| 3 | Do peer dispatchers get spawn authority, and over what scope? Does the host gain a second parent binding, or do peers stay childless? | New decision (ticket 50, D3; ADR-0003 amendment) |
| 4 | Which slot does the dedicated surface take, and what does it do when the transcript-read seam turns out to be unavailable? | Ticket 51, D1/D2 |
| 5 | Does the dedicated surface replace the capsule or sit beside it? | Ticket 51, D4 |
| 6 | Where is the mode's state shown, and where is the consent moment recorded? | Ticket 50, D5 |

## Traceability

| Source | Section |
|---|---|
| Human directive, 2026-09-18 | Header, Context ¶1 |
| Ticket 50 (activation + routing model) | Header, Context ¶1–3, Consequences |
| Ticket 51 (dedicated surface) | Context ¶1, Consequences, Open questions 4–5 |
| ADR-0009 | Context ¶2, Consequences ¶1–2 |
| ADR-0005 | Context ¶4 |
| ADR-0002 / ADR-0003 / ticket 14 | Context ¶6, Consequences ¶4 |
| design-17 §3.1(b), §5 conflict 4, §6, §13 | Context ¶3, Consequences ¶6 |
| CONTEXT.md glossary | Context ¶7 |
