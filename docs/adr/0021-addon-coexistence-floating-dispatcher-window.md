# Addon coexistence: stock dsh stays the primary UI; dispatcher functions live in a separate floating window

**Status:** accepted (human-ruled, 2026-09-20 in-session directive) — amends ADR-0018's vehicle clause; supersedes ADR-0020 as vehicle; **capsule-retirement clause partially superseded 2026-09-22 by 0022** (human-ruled) — the collapsed launcher becomes an information-bearing floating capsule; the launch seam, the whole-shell floating window, and decisions 2/3/4 otherwise stand; **decisions 2 and 4 superseded 2026-10-18 by 0024** (human-ruled) — the floating window and its re-host are withdrawn and the dispatcher UI returns to the native-dsh posture; decision 1 stands and is strengthened, and decision 3's add/delete permission stands as a retained functional capability

**Numbering:** 0021, the first free number at filing (2026-09-20; highest in use was 0020 — 0010–0012 reserved to design-17 §9's plan and consumed 2026-09-19; 0013–0015 capsule drafts; 0016 retracted; 0017–0018 filed; 0019–0020 the newest precedents). Filed by the records pass for the 2026-09-20 in-session human ruling; implementation is ticketed separately as tickets 99–101 per repo rule.

**Supersedes wherever conflicting:** ADR-0020 **as vehicle** — the root-frame election (its `root`-slot registration and the full-cell keyed `main`-page registration leave the default posture) and the whole-UI displacement posture it staged. **Amends** ADR-0018's vehicle clause ("we build the whole UI") and ADR-0018 exception U-G **for dispatcher sessions only**. Operates under ADR-0018's master rule otherwise; ADR-0013's seam research remains valid, as ADR-0018 already provides.

**Evidence:** the human's live message of 2026-09-20, quoted verbatim (typos are from the live message; "ba" = "be"):

> "our built UI is not meant to replace dsh entirely, the whole point for building the UI is to allow it to ba an addon co-existing with dsh, user gets to use dsh normally, while our functions can be called out and used in a separate floating window. also currently our ui has no way to add new or delete existing dispatcher bots"

The human's term "dispatcher bot(s)" maps to the glossary term **activated dispatcher session**; the glossary avoid-word "bot" is not reintroduced in repo prose outside verbatim quotes. Unlike ADR-0016's fabricated-premise episode, the premise here is the human's own live message, quoted above — nothing had to be reconstructed. Codebase facts establishing the two gaps the ruling closes (verified 2026-09-20 at filing): the displacement vehicle is live (`src/client/shell-mount.ts` — the `root` election at explicit priority −1, ticket 85; live-verified cutover in resolved ticket 78, live pass 5, with the abdication failsafe), and there is **no add/delete path for dispatcher sessions**: the only create path is the host slash command `/dispatcher-start` (`src/adapter/activation-command.ts` → lifecycle `activate`); deactivation fires only on host `agent/disposed` or plugin unbind (`src/adapter/parent-agent.ts`); the client has no start affordance (deleted with the capsule, resolved ticket 89) and no stop affordance anywhere. `SettingsRosterChannel.clearSession` (`src/adapter/roster-channel.ts`) already models the cleared state a deactivation writes.

## Decision

1. **Stock dsh is the user's primary UI and is never displaced.** Our client module must not register over the `root` slot; the ADR-0020 root-frame election and the full-cell keyed `main`-page registration leave the default posture. The registration machinery stays in the tree and reversible at one registration site — the vehicle is retired, the capability is not deleted.
2. **Dispatcher functions are called out into a separate floating window** over/alongside dsh, launched from an additive affordance in the stock UI. The `shell.overlay` additive slot is the sanctioned seam (ADR-0013's seam research explicitly survives ADR-0018 and is the standing evidence for additive entries). The floating window renders from our own client module and **must fail in isolation**: a crashed floating window never takes dsh down. The ADR-0020 abdication machinery was root-specific (a shadowing entry yields the cell); the isolation guarantee is re-based onto the additive posture.
3. **Dispatcher sessions can be added and deleted from our UI.** This amends ADR-0018 exception U-G ("no runtime agent management") **for dispatcher sessions only** — worker runtime management stays excluded, and resolved ticket 68's no-runtime-management scoping is re-based accordingly. Conservative default for "delete" (reversible ruling): delete = deactivate the dispatcher binding in that session (dispatcher tools unbound, access-policy rows cleared, roster mirror cleared) — disposing the dsh chat itself remains a dsh-native action, never a button of ours.
4. **Everything already built re-hosts.** The sidebar roster, conversation pane, approval cards, and roster panel are surface inventory moving into the floating window — not rebuilds (the ADR-0020 re-host inventory rule carries; the destination changes).
5. **Vocabulary.** The human's words "dispatcher bot(s)" map to the glossary term "activated dispatcher session"; the glossary avoid-word "bot" is not reintroduced in repo prose. Prose says "dispatcher session".

## Context

The ADR-0020 vehicle — our whole-UI frame elected over the shipped runtime — was implemented (tickets 77–81), live-verified (resolved ticket 78, live pass 5: frame swap, re-apply, seats in the elected frame), and works as engineered, abdication failsafe included. The human has now ruled the product intent: **coexistence, not replacement**. The user keeps dsh's normal flow — stock chat, stock settings UI, stock approval composer — and calls dispatcher functions out on demand into a floating window. The second gap is management: the ruling's closing sentence names the missing add/delete affordance for dispatcher sessions, which ADR-0018 exception U-G and resolved ticket 68's scoping had excluded. Both exclusions are amended for dispatcher sessions by this ADR.

## Considered options

| Option | Rejected/kept because |
|---|---|
| Keep the ADR-0020 root-frame replacement | **Rejected** — contradicts the ruling verbatim ("not meant to replace dsh entirely"). |
| Keyed full-cell `main` page only (no root election) | **Rejected** — not floating, and it occupies the main cell; still a displacement of the primary surface. |
| Floating window over stock dsh, launched additively | **Kept** — the ruling's own shape; rides the surviving `shell.overlay` seam research. |
| Standalone SPA / iframe / native shell | **Rejected** — already rejected in ADR-0020 on their recorded evidence; not revived by this ADR. |

## Consequences

- Resolved ticket 78's displacement posture and its live-pass interpretation are **historical record** — the live passes proved what they proved about the root election; they are not relitigated. That vehicle is superseded, not judged broken.
- The `root`/abdication pins in `test/client-shell-mount.test.ts` are re-based: the root election, priority, and abdication tests become records of the retired path or are removed with the code, per what the implementation finds (ticket 99).
- Ticket 81's settings-card ruling premise — "the elected frame DISPLACES the shipped settings UI" — **flips back**: the stock settings UI is visible again, ticket 47's card is reachable in it, and the card stays where it is with its premise restored. The W11 ruling (card stays a shipped-settings entry) stands, now on a restored rather than displaced premise.
- Deferred ticket 98's gap (1) — the host approval composer ships but does not answer under the ADR-0020 root frame — is **expected-moot** under the new vehicle, because the stock frame is no longer displaced and the composer should render and answer natively. That needs live confirmation, so 98 stays deferred with a dated comment until then. Gap (2) (persisted open-turn reconcile) is unaffected.
- Cancelled ticket 73's anti-revival clause is satisfied by the book: it requires "a new ticket with its own evidence" for any future floating/repositioning need. This ADR (the quoted ruling) plus the implementing ticket 100 are exactly that new evidence. The capsule itself **stays retired** — the floating window is not a capsule revival: it hosts the whole dispatcher shell, not a collapsed chip — and resolved ticket 89's asset deletion stands.
- The additive `shell.overlay` seam is the sanctioned launcher home. `src/client/overlay.ts` still exports `SHELL_OVERLAY_SLOT` and `rosterOverlayRegistration()` though nothing registers them today; those exports survive as ticket 100's entry point.
- The keyed `main`-page registration (`MAIN_PAGE_SLOT`, `SHELL_PAGE_KEY` "multitask-dispatcher-shell") and the root election both leave the default posture; the keyed-page/registration machinery stays available and reversible at one registration site.
- Multi-dispatcher identity becomes live through the add/delete affordances: the undecided identity halves of cancelled tickets 50/51 are resolved by the ruling's own terms (each activated dispatcher session is addable and deletable), and ADR-0019's per-session keying carries as the data path.
- Crash isolation improves: a crashed floating window must never take dsh down. The abdication machinery was root-specific (a shadowing entry yields the cell to the next survivor) and gets re-based onto the additive posture, where the stock UI was never shadowed in the first place.
- ADR-0018's **Status:** line and this README carry dated notes (accepted-ADR bodies stay untouched per the recorded 2026-09-19/09-20 convention); ADR-0020's **Status:** line likewise. The PRD's vehicle wording (§6.1, §11.5, §15) carries minimal dated amendments in the ticket-64 style, recorded under ticket 99.

## Open questions

None blocking implementation. The exact DOM technique for the floating window (portal vs slot composition) is ticket-level evidence for ticket 100, not ADR-level; so is the precise client reachability of "create a brand-new dsh chat" for ticket 101's add affordance (honest guidance + activation of an existing session is the recorded fallback if it is not reachable).

## Traceability

- ADRs: 0018 (master rule; vehicle clause and U-G amended by this ADR), 0020 (vehicle superseded; machinery re-hosted), 0013 (seam research survives — the launcher's seam), 0019 (per-session keying carries).
- Tickets: 78 (resolved — the cutover this ADR supersedes), 89 (resolved — capsule deletion stands), 98 (deferred — gap 1 expected-moot, dated comment), 81 (resolved — settings-card premise restored), 68 (resolved — scoping re-based), 73 (cancelled — anti-revival clause satisfied by this ADR + ticket 100), 50/51 (cancelled — identity halves resolved by this ADR).
- New tickets filed with this ADR: 99 (rebase the vehicle), 100 (floating window + stock-UI launcher), 101 (add/delete dispatcher sessions).
