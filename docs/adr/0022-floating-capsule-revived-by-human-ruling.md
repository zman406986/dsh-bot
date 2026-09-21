# The collapsed launcher becomes an information-bearing floating capsule — revived by the human's 2026-09-22 ruling

**Status:** accepted (human-ruled, 2026-09-22 in-session directive) — supersedes ADR-0021's capsule-retirement clause in part

**Numbering:** 0022, the first free number at filing (2026-09-22; highest in use was 0021). Filed by the scribe session for the 2026-09-22 in-session human ruling; implementation is ticketed separately as ticket 107 per repo rule.

**Supersedes wherever conflicting:** ADR-0021's capsule-retirement consequence clause ONLY — "The capsule itself stays retired — the floating window is not a capsule revival: it hosts the whole dispatcher shell, not a collapsed chip". Everything else in ADR-0021 stands: decision 1 (stock dsh is never displaced), decision 2's launch seam (the one additive `shell.overlay` entry — `LAUNCHER_ENTRY_ID` "multitask-dispatcher-launcher" and `LAUNCHER_OVERLAY_ORDER` −10, `src/client/overlay.ts:52,61` — toggling the floating window), decision 3 (dispatcher sessions addable/deletable = deactivate the binding), and decision 4 (re-hosted surface inventory). Operates under ADR-0018's master rule otherwise.

**Evidence:** the human's live message of 2026-09-22, quoted verbatim (phrasing is from the live message; the bracketed glosses are the human's own inline clarifications of which button and which numbers are meant):

> "current window collapses at top left [dispatcher] button, change to a floating capsule instead [No. of dispatcher | number of running workers]"

The premise is the human's own live message, quoted above — nothing reconstructed (the ADR-0016 fabricated-premise rule; same posture as ADR-0021's evidence note). Codebase facts establishing the state the ruling changes (verified 2026-09-22 at filing): the collapsed affordance is a plain text chip — `createLauncherChip` (`src/client/floating-window.tsx:331-354`), key `launcher.chip.label` ("Dispatchers" / "调度台", `src/client/overlay.ts:330,485`) — whose comments record the retirement posture this ruling reverses: "launch affordance ONLY — no presence counters" (`floating-window.tsx:4-12` module header and `:324-329` chip comment; the locale comments at `src/client/overlay.ts:324-329` en and `:480-484` zh).

## Decision

1. **The collapsed affordance becomes an information-bearing floating capsule** showing the number of activated dispatcher sessions and the number of workers currently running across them, in the ruling's own shape: [dispatcher count | running workers]. Presence counters — which the retired capsule model carried and ADR-0021's retirement clause excluded — now live on the collapsed affordance.
2. **The capsule remains the launcher.** It toggles the floating window open/closed exactly as the chip did — the same additive `shell.overlay` entry, same id, same order — so ADR-0021 decision 2's launch seam is unchanged: the ruling changes the affordance's SHAPE and CONTENT, not the seam.
3. **The floating window remains the whole dispatcher shell.** This ruling revives the collapsed affordance's information model, not a capsule-as-shell: ADR-0021's decision 4 (re-hosted whole shell) and the crash-isolation posture stand untouched.

## Context

ADR-0021 ruled the dispatcher UI into a floating window and, as a recorded consequence, retired the capsule: the window hosts the whole shell, so the collapsed chip was left a bare launch affordance, and the "no presence counters" posture was written into the code comments. The human has now ruled the collapsed state should itself carry information — a floating capsule with counts — re-establishing the collapsed affordance's information role that cancelled ticket 66 (the capsule-era "collapsed capsule shows key info" request) once specified and that ADR-0021's retirement clause had closed.

Authority stack: a dated human explicit override is level 1 and sits above accepted ADRs (level 2); it is recorded here as a human-ruled ADR per the ADR-0021 precedent so the supersession is explicit rather than silent, and so accepted-ADR bodies stay untouched (the recorded 2026-09-19/09-20 convention). Cancelled ticket 73's anti-revival clause ("a new ticket with its own evidence, not a revival of this one") is satisfied by the book: ticket 107 is the new ticket, and the quoted dated ruling is its evidence.

## Considered options

| Option | Rejected/kept because |
|---|---|
| Keep the plain chip (ADR-0021's retirement clause as-is) | **Rejected** — contradicts the ruling verbatim. |
| Floating capsule with counts, still the launcher | **Kept** — the ruling's own shape; the launch seam is untouched. |
| Capsule as a second shell (expandable into the dispatcher UI) | **Rejected** — not asked for; ADR-0021 decision 4's whole-shell window stands. |
| Counts from a new/invented push channel | **Rejected** — the existing mirror feed already carries the snapshots (ADR-0010); a second channel would break the honesty posture. |

## Consequences

- Presence counters live on the collapsed affordance from ticket 107 onward. The "no presence counters" comments (`src/client/floating-window.tsx:4-12` and `:324-329`; `src/client/overlay.ts:324-329` and `:480-484`) are reversed by this ruling and are updated by ticket 107 (edited in place, not silently deleted).
- ADR-0021's **Status:** line and the ADR README's table row carry dated notes per the recorded convention (accepted-ADR bodies stay untouched): the capsule-retirement clause is superseded in part by 0022.
- The counts derive from the client mirror store under ADR-0010's honesty rules (snapshot-kind mirrors; the staleness window respected so stale snapshots do not read as live; no optimistic flips) — ticket 107 records the derivation and pins it offline.
- The chip-text pin (`test/client-floating-window.test.ts:539`) is deliberately broken by ticket 107 and replaced with counts pins.
- No change to stock dsh, the launch seam's registration surface, the floating window's crash isolation, or the add/delete affordances.

## Open questions

None blocking implementation. The capsule's exact visual composition (how the two counts render inside it) and its default placement are ticket-level evidence for ticket 107, not ADR-level.

## Traceability

- ADRs: 0021 (capsule-retirement clause superseded in part; decisions 2/3/4 stand), 0018 (master rule, operated under otherwise), 0013 (seam research — the launcher's `shell.overlay` home), 0010 (mirror honesty — where the counts come from).
- Tickets: 107 (implementation, filed with this ADR), 66 (cancelled — the capsule-era ancestor of the collapsed-chip-shows-counts request), 73 (cancelled — its anti-revival clause is satisfied by this ADR + ticket 107), 100 (resolved — the floating window the capsule launches), 102/103 (resolved — the in-window affordances and the per-event-delta drag pattern reused).
