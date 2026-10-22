# 136 — ADR-0024 decision 3 says ticket 101's client wiring is preserved in full; the tree no longer has it

**Status:** resolved
**Labels:** needs-info (answered by owner ruling 2026-10-22)
**Blocked by:** a dated human ruling, either way (see §The two options). No agent can settle this.
**Related:** ADR-0024 decision 3 (the claim that conflicts), ADR-0030 (the `/dsh-bot` rename and `/dispatcher-stop` withdrawal), ADR-0021 decision 3 (the add/delete permission the wiring served), ticket 101 (the add/delete work), ticket 114 (the 0.2.1 port that removed the wiring, while its own checklist claimed to keep it), ADR-0018 C13 (no identity roster — the reason a session-management UI was ever the only place this lived)

## Problem

Two human-ruled records disagree, and the tree sides with one of them. Only the owner can say which record is right.

### What ADR-0024 decision 3 says

`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:15` (decision 3, human-ruled 2026-10-19):

> **Functional work is preserved in full.** The override reaches UI chrome only. Kept: ticket 101's adapter add/delete/stop commands and their client wiring (the start/stop command lines, add picker, delete arming, and add/delete seats) as retained, unmounted machinery; ... Deleting any of these is out of scope for this override.

The same ADR repeats the preservation in three other places: decision 4 says the shell machinery "stays in the tree as retained, not-composed machinery" (`:16`), a consequence says "The functional wiring is retained either way" (`:41`), and `:48` says "the code is retained either way".

### What the tree actually has

None of the named client artifacts exist any more. Checked 2026-10-22:

| Named in decision 3 | In `src/` today |
|---|---|
| `describeAddPicker` | absent (the only hit in the repo is the deletion note in `docs/surfaces.md:160`) |
| `shellDeletePress` | absent (same, `docs/surfaces.md:161`) |
| delete arming (`SHELL_DELETE_CONFIRM_MS`) | absent — zero files |
| `DISPATCHER_STOP_LINE` | absent — zero files |
| add/delete seats in `shell.tsx` / `shell-store.ts` | removed |

The removal happened during the 0.2.1 port:

- `1cc2dfd` — `src/client/actions.ts` −20 lines (including `-export const DISPATCHER_STOP_LINE = "/dispatcher-stop";`), `shell-store.ts` −161, `shell.tsx` −390, 550 deletions in those three files alone.
- `90a4b26` — the follow-through checkpoint.

`docs/surfaces.md:160-164` now records the outcome plainly:

> Ticket 101's client-side add/delete affordances (`describeAddPicker`, `shellDeletePress`, the per-row delete arming, and the `/dispatcher-stop` line) were deleted in the 0.2.1 port; the daemon-side activation and the host `agent/disposed` teardown path remain, and deactivation is now implicit only (ADR-0030).

### The third contradiction

Resolved ticket 114 claimed the wiring was kept. `Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md:53-54`:

> - [x] **Keep, do not revert, the functional changes from tickets 101, 108, and 113:**
>   - 101: `DISPATCHER_START_LINE` / `DISPATCHER_STOP_LINE` (`src/client/actions.ts`), the add picker + delete arming in `shell-store.ts`, the add/delete seats in `shell.tsx` and `src/client/index.ts`. They stay in the tree as unmounted wiring ...

That box is ticked, and it is wrong. The 0.2.1 port deleted exactly what it says was kept. So a checklist tick, an ADR decision, and the tree are three records of one fact that disagree.

### What does survive

The adapter side is intact, and this is not in dispute:

- `deactivate(sessionId)` on the lifecycle (`src/adapter/parent-agent.ts:190`, implemented at `:454`), the single sequence the host `agent/disposed` handler also runs (`:293`).
- `lifecycle.deactivate` is reachable and tested; ADR-0024's own "Functional work is preserved" claim holds for the **adapter**, not the **client**.

The dispute is narrow: the client wiring, and only the client wiring.

## Why this is a human decision

Both sides are human-ruled records. ADR-0024 decision 3 is a 2026-10-19 human ruling. The 0.2.1 port was directed work (`1cc2dfd`'s message names "ADR-0024 human ruling"; ticket 114 was the implementation, and ADR-0030 followed). An agent cannot decide that one human ruling silently outranks another, and the repo rule is explicit: where a conflict has no recorded decision covering it, stop and ask (`docs/agents-rulebook.md` §Authority stack).

Note the shape of the disagreement: this is not "the ADR was wrong". It is that ADR-0024 anticipated the port would keep the wiring and the port did not. Nothing in ADR-0024 has a clause saying the wiring may be dropped if it is inconvenient; and nothing in ADR-0030 amends decision 3.

## The two options

Laying these out neutrally. Neither is recommended here.

**Option 1 — accept the deletion, and correct ADR-0024.**
Append a dated corrective note to ADR-0024 decision 3 recording that the client wiring was removed in the 0.2.1 port (`1cc2dfd`, `90a4b26`), that `docs/surfaces.md` already says so, and that deactivation is now implicit via the host `agent/disposed` path (ADR-0030). Ticket 114's checklist line gets the same dated correction rather than being rewritten. Cost: the ADR stops promising code that is not there; the owner gives up a reachable session-management surface, which the native posture had already withdrawn from the default UI. An agent can draft the note on request — the draft would still need the owner's date and approval, because it amends a human-ruled ADR.

**Option 2 — restore the ticket-101 client wiring to match decision 3.**
Reinstate `describeAddPicker`, `shellDeletePress` and the arming constant, the add/delete seats, and the `/dispatcher-stop` line as retained, unmounted machinery at the one composition point (`src/client/index.ts`'s `apply`), with its pins. Cost: code returns that nothing mounts, so it is dead weight unless a future surface composes it; and `/dispatcher-stop` is withdrawn as a command by ADR-0030, so the line constant's meaning has changed since decision 3 was written. Restoring the constant is not the same as restoring a working stop path.

A third possibility — that ADR-0024 decision 3 was always meant to describe the adapter alone — is not written anywhere. If that is what the owner meant, it belongs in option 1's corrective note, not in a new option.

## Acceptance criteria

None. There is no checkbox an agent can tick here. The exit is a dated human ruling that names one of the two options, recorded as a comment on this ticket and, for option 1, as an ADR-0024 amendment.

## Constraints

- **No implementation until the ruling lands.** No file under `src/` is edited by this ticket.
- **Do not delete anything to resolve the conflict.** The mismatch is fixed by a record, not by removing code or rows.
- **Do not rewrite ticket 114's checklist.** It is a historical record of what an agent believed; correct it with a dated note if the owner chooses option 1.
- This is a records conflict, not a runtime bug. No live run is needed to see it.

## Comments

### 2026-10-22 — filing

Found by the documentation sweep. Every claim above was checked against the tree on 2026-10-22: the four symbols were grepped (three have zero hits in `src/`; the other two survive only inside `docs/surfaces.md`'s deletion note), the two commits were read with `git show --stat`, and ADR-0024 line 15 plus ticket 114 lines 53-54 were read before quoting. Labelled `needs-info`: the missing information is the owner's ruling, not a technical fact.

### 2026-10-22 — resolved by owner ruling

The owner ruled on 2026-10-22: "we reverted the separate UI entirely, all rulings on separate UI no longer valid." That settles this ticket as option 1 (accept the deletion): ADR-0024 decision 3's preservation clause is superseded by a dated note appended to the ADR; the deleted ticket-101 client wiring stays deleted; no corrective restore is wanted. The rider's single sidebar-glyph license stands (stock-dsh addition, not separate UI). Nothing to implement.
